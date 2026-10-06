/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { InvalidStoredSecretError, SecretDecryptionError } from '../../../../../platform/secrets/common/secrets.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { McpRegistryInputStorage } from '../../common/mcpRegistryInputStorage.js';

suite('Workbench - MCP - RegistryInputStorage', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let testStorageService: TestStorageService;
	let testSecretStorageService: TestSecretStorageService;
	let testLogService: ILogService;
	let mcpInputStorage: McpRegistryInputStorage;

	setup(() => {
		testStorageService = store.add(new TestStorageService());
		testSecretStorageService = new TestSecretStorageService();
		testLogService = store.add(new NullLogService());

		// Create the input storage with APPLICATION scope
		mcpInputStorage = store.add(new McpRegistryInputStorage(
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
			testStorageService,
			testSecretStorageService,
			testLogService
		));
	});

	test('setPlainText stores values that can be retrieved with getMap', async () => {
		const values = {
			'key1': { value: 'value1' },
			'key2': { value: 'value2' }
		};

		await mcpInputStorage.setPlainText(values);
		const result = await mcpInputStorage.getMap();

		assert.strictEqual(result.key1.value, 'value1');
		assert.strictEqual(result.key2.value, 'value2');
	});

	test('setSecrets stores encrypted values that can be retrieved with getMap', async () => {
		const secrets = {
			'secretKey1': { value: 'secretValue1' },
			'secretKey2': { value: 'secretValue2' }
		};

		await mcpInputStorage.setSecrets(secrets);
		const result = await mcpInputStorage.getMap();

		assert.strictEqual(result.secretKey1.value, 'secretValue1');
		assert.strictEqual(result.secretKey2.value, 'secretValue2');
	});

	test('getMap returns combined plain text and secret values', async () => {
		await mcpInputStorage.setPlainText({
			'plainKey': { value: 'plainValue' }
		});

		await mcpInputStorage.setSecrets({
			'secretKey': { value: 'secretValue' }
		});

		const result = await mcpInputStorage.getMap();

		assert.strictEqual(result.plainKey.value, 'plainValue');
		assert.strictEqual(result.secretKey.value, 'secretValue');
	});

	test('clear removes specific values', async () => {
		await mcpInputStorage.setPlainText({
			'key1': { value: 'value1' },
			'key2': { value: 'value2' }
		});

		await mcpInputStorage.setSecrets({
			'secretKey1': { value: 'secretValue1' },
			'secretKey2': { value: 'secretValue2' }
		});

		// Clear one plain and one secret value
		await mcpInputStorage.clear('key1');
		await mcpInputStorage.clear('secretKey1');

		const result = await mcpInputStorage.getMap();

		assert.strictEqual(result.key1, undefined);
		assert.strictEqual(result.key2.value, 'value2');
		assert.strictEqual(result.secretKey1, undefined);
		assert.strictEqual(result.secretKey2.value, 'secretValue2');
	});

	test('clearAll removes all values', async () => {
		await mcpInputStorage.setPlainText({
			'key1': { value: 'value1' }
		});

		await mcpInputStorage.setSecrets({
			'secretKey1': { value: 'secretValue1' }
		});

		mcpInputStorage.clearAll();

		const result = await mcpInputStorage.getMap();

		assert.deepStrictEqual(result, {});
	});

	test('updates to plain text values overwrite existing values', async () => {
		await mcpInputStorage.setPlainText({
			'key1': { value: 'value1' },
			'key2': { value: 'value2' }
		});

		await mcpInputStorage.setPlainText({
			'key1': { value: 'updatedValue1' }
		});

		const result = await mcpInputStorage.getMap();

		assert.strictEqual(result.key1.value, 'updatedValue1');
		assert.strictEqual(result.key2.value, 'value2');
	});

	test('updates to secret values overwrite existing values', async () => {
		await mcpInputStorage.setSecrets({
			'secretKey1': { value: 'secretValue1' },
			'secretKey2': { value: 'secretValue2' }
		});

		await mcpInputStorage.setSecrets({
			'secretKey1': { value: 'updatedSecretValue1' }
		});

		const result = await mcpInputStorage.getMap();

		assert.strictEqual(result.secretKey1.value, 'updatedSecretValue1');
		assert.strictEqual(result.secretKey2.value, 'secretValue2');
	});

	test('storage persists values across instances', async () => {
		// Set values on first instance
		await mcpInputStorage.setPlainText({
			'key1': { value: 'value1' }
		});

		await mcpInputStorage.setSecrets({
			'secretKey1': { value: 'secretValue1' }
		});

		await testStorageService.flush();

		// Create a second instance that should have access to the same storage
		const secondInstance = store.add(new McpRegistryInputStorage(
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
			testStorageService,
			testSecretStorageService,
			testLogService
		));

		const result = await secondInstance.getMap();

		assert.strictEqual(result.key1.value, 'value1');
		assert.strictEqual(result.secretKey1.value, 'secretValue1');

		assert.ok(!testStorageService.get('mcpInputs', StorageScope.APPLICATION)?.includes('secretValue1'));
	});

	// F-SECRETS-1: a stored key or sealed secrets that cannot be read are kept, and the read rejects.
	suite('stored secrets that cannot be read', () => {
		const keyName = 'mcpEncryptionKey';

		function createInstance(secrets: TestSecretStorageService): McpRegistryInputStorage {
			return store.add(new McpRegistryInputStorage(StorageScope.APPLICATION, StorageTarget.MACHINE, testStorageService, secrets, testLogService));
		}

		async function sealOne(): Promise<string> {
			await mcpInputStorage.setSecrets({ 'secretKey1': { value: 'secretValue1' } });
			await testStorageService.flush();
			const sealed = testStorageService.get('mcpInputs', StorageScope.APPLICATION);
			assert.ok(sealed && sealed.includes('"secrets"'));
			return sealed;
		}

		test('a stored key that is not a key rejects; neither the key nor the sealed secrets are replaced', async () => {
			const sealed = await sealOne();
			await testSecretStorageService.set(keyName, 'not a key {');

			await assert.rejects(createInstance(testSecretStorageService).getMap(), (e: unknown) => e instanceof InvalidStoredSecretError && e.key === keyName);
			assert.strictEqual(await testSecretStorageService.get(keyName), 'not a key {');
			await testStorageService.flush();
			assert.strictEqual(testStorageService.get('mcpInputs', StorageScope.APPLICATION), sealed);
		});

		test('sealed secrets that do not unseal with the stored key reject and are kept', async () => {
			const sealed = await sealOne();
			const otherKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
			await testSecretStorageService.set(keyName, JSON.stringify(await crypto.subtle.exportKey('jwk', otherKey)));

			const second = createInstance(testSecretStorageService);
			await assert.rejects(second.getMap(), (e: unknown) => e instanceof InvalidStoredSecretError && e.key === 'mcpInputs');
			await second.setPlainText({ 'key1': { value: 'value1' } });
			await testStorageService.flush();
			assert.ok(testStorageService.get('mcpInputs', StorageScope.APPLICATION)?.includes(JSON.parse(sealed).secrets.value));
		});

		test('a failed key read is not remembered: the next read succeeds', async () => {
			await sealOne();
			class FailsOnceSecretStorageService extends TestSecretStorageService {
				private _failNext = true;
				override async get(key: string): Promise<string | undefined> {
					if (this._failNext) {
						this._failNext = false;
						throw new SecretDecryptionError(key);
					}
					return super.get(key);
				}
			}
			const failsOnce = new FailsOnceSecretStorageService();
			await failsOnce.set(keyName, (await testSecretStorageService.get(keyName))!);

			const second = createInstance(failsOnce);
			await assert.rejects(second.getMap(), (e: unknown) => e instanceof SecretDecryptionError);
			assert.strictEqual((await second.getMap()).secretKey1.value, 'secretValue1');
		});
	});

	// F-SECRETS-1 review c1 (MUST-1, MUST-2): a present empty or malformed value is not absence, and nothing is replaced.
	suite('present empty and malformed stored values', () => {
		const keyName = 'mcpEncryptionKey';
		const marker = 'SECRET-MARKER';

		class CountingSecretStorageService extends TestSecretStorageService {
			setCalls = 0;
			deleteCalls = 0;
			override async set(key: string, value: string): Promise<void> {
				this.setCalls++;
				return super.set(key, value);
			}
			override async delete(key: string): Promise<void> {
				this.deleteCalls++;
				return super.delete(key);
			}
			/** Seeds without counting. */
			async seed(key: string, value: string): Promise<void> {
				await super.set(key, value);
			}
		}

		function createInstance(secrets: TestSecretStorageService): McpRegistryInputStorage {
			return store.add(new McpRegistryInputStorage(StorageScope.APPLICATION, StorageTarget.MACHINE, testStorageService, secrets, testLogService));
		}

		function named(key: string, notQuoting: string) {
			return (e: unknown) => e instanceof InvalidStoredSecretError
				&& e.key === key
				&& !e.message.includes(notQuoting)
				&& !(e.cause instanceof Error && e.cause.message.includes(notQuoting));
		}

		function storedInputs(): string | undefined {
			return testStorageService.get('mcpInputs', StorageScope.APPLICATION);
		}

		async function sealOne(): Promise<string> {
			await mcpInputStorage.setSecrets({ 'secretKey1': { value: 'secretValue1' } });
			await testStorageService.flush();
			const sealed = storedInputs();
			assert.ok(sealed && sealed.includes('"secrets"'));
			return sealed;
		}

		/** Seals the given plaintext with the stored key, as a record the instance under test reads. */
		async function storeSealedPlaintext(plaintext: string): Promise<string> {
			const jwk = JSON.parse((await testSecretStorageService.get(keyName))!);
			const key = await crypto.subtle.importKey('jwk', jwk, 'AES-GCM', false, ['encrypt', 'decrypt']);
			const iv = crypto.getRandomValues(new Uint8Array(12));
			const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.buffer }, key, new TextEncoder().encode(plaintext).buffer as ArrayBuffer);
			const record = JSON.stringify({
				version: 1,
				values: {},
				secrets: { iv: encodeBase64(VSBuffer.wrap(iv)), value: encodeBase64(VSBuffer.wrap(new Uint8Array(encrypted))) },
			});
			testStorageService.store('mcpInputs', record, StorageScope.APPLICATION, StorageTarget.MACHINE);
			return record;
		}

		test('an empty stored key rejects naming the key; no key is generated, nothing is written', async () => {
			const sealed = await sealOne();
			const secrets = new CountingSecretStorageService();
			await secrets.seed(keyName, '');

			const instance = createInstance(secrets);
			await assert.rejects(instance.getMap(), named(keyName, marker));
			await assert.rejects(instance.setSecrets({ 'k': { value: marker } }), named(keyName, marker));
			assert.strictEqual(await secrets.get(keyName), '');
			assert.strictEqual(secrets.setCalls, 0);
			assert.strictEqual(secrets.deleteCalls, 0);
			await testStorageService.flush();
			assert.strictEqual(storedInputs(), sealed);
		});

		test('an empty stored key rejects a first secret as well: no sealed record exists yet and no key is generated', async () => {
			const secrets = new CountingSecretStorageService();
			await secrets.seed(keyName, '');

			await assert.rejects(createInstance(secrets).setSecrets({ 'k': { value: marker } }), named(keyName, marker));
			assert.strictEqual(await secrets.get(keyName), '');
			assert.strictEqual(secrets.setCalls, 0);
			assert.strictEqual(secrets.deleteCalls, 0);
		});

		test('an absent stored key still makes one, and sealing works', async () => {
			const secrets = new CountingSecretStorageService();
			const instance = createInstance(secrets);
			await instance.setSecrets({ 'k': { value: 'v' } });
			assert.strictEqual(secrets.setCalls, 1);
			assert.ok(await secrets.get(keyName));
			assert.strictEqual((await instance.getMap()).k.value, 'v');
		});

		for (const [label, plaintext] of [
			['null', 'null'],
			['an array', '[]'],
			['a string', JSON.stringify(marker)],
			['a number', '5'],
			['a map whose entry is a string', JSON.stringify({ a: marker })],
			['a map whose entry is null', '{"a":null}'],
			['a map whose entry has a number value', JSON.stringify({ a: { value: 5 } })],
			['a map whose entry has a non-object input', JSON.stringify({ a: { value: marker, input: marker } })],
			['text that is not JSON', `${marker} {`],
		]) {
			test(`sealed secrets that unseal to ${label} reject and are kept; nothing is cached`, async () => {
				await sealOne();
				const record = await storeSealedPlaintext(plaintext);
				const secrets = new CountingSecretStorageService();
				await secrets.seed(keyName, (await testSecretStorageService.get(keyName))!);

				const instance = createInstance(secrets);
				await assert.rejects(instance.getMap(), named('mcpInputs', marker));
				await assert.rejects(instance.getMap(), named('mcpInputs', marker));
				await assert.rejects(instance.setSecrets({ 'k': { value: 'v' } }), named('mcpInputs', marker));
				await assert.rejects(instance.clear('a'), named('mcpInputs', marker));
				assert.strictEqual(secrets.setCalls, 0);
				assert.strictEqual(secrets.deleteCalls, 0);
				await testStorageService.flush();
				assert.strictEqual(storedInputs(), record);
			});
		}

		for (const [label, raw] of [
			['empty', ''],
			['not JSON', `${marker} {`],
			['null', 'null'],
			['an array', '[]'],
			['a string', JSON.stringify(marker)],
			['a record without a version', '{"values":{}}'],
			['a record with a non-numeric version', JSON.stringify({ version: marker, values: {} })],
			['a record whose values are an array', '{"version":1,"values":[]}'],
			['a record whose value entry is not an object', JSON.stringify({ version: 1, values: { a: marker } })],
			['a record whose sealed secrets lack an iv', JSON.stringify({ version: 1, values: {}, secrets: { value: marker } })],
			['a record whose sealed secrets are a string', JSON.stringify({ version: 1, values: {}, secrets: marker })],
		]) {
			test(`a stored record that is ${label} rejects naming the key and is kept byte for byte`, async () => {
				testStorageService.store('mcpInputs', raw, StorageScope.APPLICATION, StorageTarget.MACHINE);
				const secrets = new CountingSecretStorageService();
				const instance = createInstance(secrets);

				await assert.rejects(instance.getMap(), named('mcpInputs', marker));
				await assert.rejects(instance.setPlainText({ 'k': { value: 'v' } }), named('mcpInputs', marker));
				await assert.rejects(instance.setSecrets({ 'k': { value: 'v' } }), named('mcpInputs', marker));
				await assert.rejects(instance.clear('k'), named('mcpInputs', marker));
				await testStorageService.flush();
				assert.strictEqual(storedInputs(), raw);
				assert.strictEqual(secrets.setCalls, 0);
				assert.strictEqual(secrets.deleteCalls, 0);
			});
		}

		test('a stored record of an unsupported version is not replaced: reads, updates and flushes keep its sealed secrets', async () => {
			const sealed = await sealOne();
			const future = JSON.stringify({ ...JSON.parse(sealed), version: 2 });
			testStorageService.store('mcpInputs', future, StorageScope.APPLICATION, StorageTarget.MACHINE);

			const instance = createInstance(testSecretStorageService);
			await assert.rejects(instance.getMap(), named('mcpInputs', 'secretValue1'));
			await assert.rejects(instance.setPlainText({ 'key1': { value: 'value1' } }), named('mcpInputs', 'secretValue1'));
			await assert.rejects(instance.setSecrets({ 'key2': { value: 'value2' } }), named('mcpInputs', 'secretValue1'));
			await testStorageService.flush();
			await testStorageService.flush();
			assert.strictEqual(storedInputs(), future);
			assert.ok(storedInputs()!.includes(JSON.parse(sealed).secrets.value));

			// The rejection is not remembered: once the record is readable again the same instance reads it.
			testStorageService.store('mcpInputs', sealed, StorageScope.APPLICATION, StorageTarget.MACHINE);
			assert.strictEqual((await instance.getMap()).secretKey1.value, 'secretValue1');
		});

		test('clearAll, the user\'s explicit act, starts an empty record over an unreadable one', async () => {
			const sealed = await sealOne();
			testStorageService.store('mcpInputs', JSON.stringify({ ...JSON.parse(sealed), version: 2 }), StorageScope.APPLICATION, StorageTarget.MACHINE);

			const instance = createInstance(testSecretStorageService);
			await assert.rejects(instance.getMap(), named('mcpInputs', 'secretValue1'));
			instance.clearAll();
			assert.deepStrictEqual(await instance.getMap(), {});
			await testStorageService.flush();
			const replaced = JSON.parse(storedInputs()!);
			assert.strictEqual(replaced.version, 1);
			assert.strictEqual(replaced.secrets, undefined);
		});

		test('an absent stored record reads as empty', async () => {
			const secrets = new CountingSecretStorageService();
			assert.deepStrictEqual(await createInstance(secrets).getMap(), {});
			assert.strictEqual(secrets.setCalls, 0);
			assert.strictEqual(storedInputs(), undefined);
		});
	});
});

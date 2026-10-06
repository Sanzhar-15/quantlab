/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { encodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { InvalidStoredSecretError, SecretDecryptionError } from '../../../../../platform/secrets/common/secrets.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { McpInputsOvertakenError, McpRegistryInputStorage } from '../../common/mcpRegistryInputStorage.js';

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

	// F-SECRETS-1 review c1 (SHOULD-8): a cached imported key follows its stored value, and a malformed shared key has an
	// explicit recovery route that never runs because inputs were cleared.
	suite('encryption key lifecycle', () => {
		const keyName = 'mcpEncryptionKey';

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
		}

		/** A secret store that never announces a change, as a store whose change event is not delivered. */
		class SilentSecretStorageService extends TestSecretStorageService {
			override readonly onDidChangeSecret = Event.None;
		}

		function createInstance(secrets: TestSecretStorageService, scope: StorageScope = StorageScope.APPLICATION): McpRegistryInputStorage {
			return store.add(new McpRegistryInputStorage(scope, StorageTarget.MACHINE, testStorageService, secrets, testLogService));
		}

		function storedInputs(scope: StorageScope = StorageScope.APPLICATION): string | undefined {
			return testStorageService.get('mcpInputs', scope);
		}

		async function newKeyText(): Promise<string> {
			const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
			return JSON.stringify(await crypto.subtle.exportKey('jwk', key));
		}

		const notAKey = 'not a key {';

		test('restoring the correct key after an unseal failure is read by the same instance (a store that announces changes)', async () => {
			const secrets = new CountingSecretStorageService();
			const first = createInstance(secrets);
			await first.setSecrets({ 'secretKey1': { value: 'secretValue1' } });
			await testStorageService.flush();
			const correctKey = (await secrets.get(keyName))!;

			await secrets.set(keyName, await newKeyText());
			const second = createInstance(secrets);
			await assert.rejects(second.getMap(), (e: unknown) => e instanceof InvalidStoredSecretError && e.key === 'mcpInputs');

			await secrets.set(keyName, correctKey);
			assert.strictEqual((await second.getMap()).secretKey1.value, 'secretValue1');
		});

		test('restoring the correct key after an unseal failure is read by the same instance (a store that does not announce changes)', async () => {
			const secrets = new SilentSecretStorageService();
			const first = createInstance(secrets);
			await first.setSecrets({ 'secretKey1': { value: 'secretValue1' } });
			await testStorageService.flush();
			const correctKey = (await secrets.get(keyName))!;

			await secrets.set(keyName, await newKeyText());
			const second = createInstance(secrets);
			await assert.rejects(second.getMap(), (e: unknown) => e instanceof InvalidStoredSecretError && e.key === 'mcpInputs');

			await secrets.set(keyName, correctKey);
			assert.strictEqual((await second.getMap()).secretKey1.value, 'secretValue1');
		});

		test('a key whose stored value changed is imported again before the next sealing', async () => {
			const secrets = new CountingSecretStorageService();
			const first = createInstance(secrets);
			await first.setSecrets({ 'a': { value: 'valueA' } });
			const replacement = await newKeyText();
			await secrets.set(keyName, replacement);

			await first.setSecrets({ 'b': { value: 'valueB' } });
			await testStorageService.flush();

			// Sealed with the key that is stored now, not with the one imported before it changed.
			assert.strictEqual(await secrets.get(keyName), replacement);
			const second = createInstance(secrets);
			const map = await second.getMap();
			assert.strictEqual(map.a.value, 'valueA');
			assert.strictEqual(map.b.value, 'valueB');
		});

		suite('a malformed shared key, in both scopes', () => {
			let secrets: CountingSecretStorageService;
			let workspaceSealed: string;

			setup(async () => {
				secrets = new CountingSecretStorageService();
				const profile = createInstance(secrets, StorageScope.PROFILE);
				const workspace = createInstance(secrets, StorageScope.WORKSPACE);
				await profile.setPlainText({ 'pPlain': { value: 'profile-plain' } });
				await profile.setSecrets({ 'pSecret': { value: 'profile-secret' } });
				await workspace.setPlainText({ 'wPlain': { value: 'workspace-plain' } });
				await workspace.setSecrets({ 'wSecret': { value: 'workspace-secret' } });
				await testStorageService.flush();
				workspaceSealed = storedInputs(StorageScope.WORKSPACE)!;
				assert.ok(storedInputs(StorageScope.PROFILE)!.includes('"secrets"') && workspaceSealed.includes('"secrets"'));

				await secrets.set(keyName, notAKey);
				secrets.setCalls = 0;
				secrets.deleteCalls = 0;
			});

			function namedKey(e: unknown): boolean {
				return e instanceof InvalidStoredSecretError && e.key === keyName && !e.message.includes(notAKey);
			}

			test('clearing the inputs of one scope does not delete the shared key, and the other scope is untouched', async () => {
				const profile = createInstance(secrets, StorageScope.PROFILE);
				const workspace = createInstance(secrets, StorageScope.WORKSPACE);
				await assert.rejects(profile.getMap(), namedKey);
				await assert.rejects(workspace.getMap(), namedKey);

				profile.clearAll();
				await assert.rejects(profile.setSecrets({ 'k': { value: 'v' } }), namedKey);
				await testStorageService.flush();

				assert.strictEqual(await secrets.get(keyName), notAKey);
				assert.strictEqual(secrets.deleteCalls, 0);
				assert.strictEqual(secrets.setCalls, 0);
				assert.strictEqual(storedInputs(StorageScope.WORKSPACE), workspaceSealed);
				await assert.rejects(workspace.getMap(), namedKey);
			});
		});
	});

	// F-SECRETS-1 review c3 (MUST-1 class): an operation that is overtaken by another one never loses the other's values
	// and never writes into a record that clearAll() replaced. WebCrypto is paused with a deferred to hold the operation.
	suite('operations overtaken in flight', () => {

		/** Holds every call of one WebCrypto method until released. */
		function pauseWebCrypto(method: 'decrypt' | 'encrypt') {
			const subtle = crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
			const wasOwn = Object.prototype.hasOwnProperty.call(subtle, method);
			const original = subtle[method];
			const gate = new DeferredPromise<void>();
			let calls = 0;
			subtle[method] = (...args: unknown[]) => {
				calls++;
				return gate.p.then(() => original.apply(crypto.subtle, args));
			};
			return {
				get calls() { return calls; },
				/** The first call is held, and every operation that would start one has had time to. */
				async reached(): Promise<void> {
					while (calls === 0) {
						await new Promise<void>(resolve => setTimeout(resolve, 1));
					}
					await new Promise<void>(resolve => setTimeout(resolve, 20));
				},
				release(): void { gate.complete(); },
				restore(): void {
					gate.complete();
					if (wasOwn) {
						subtle[method] = original;
					} else {
						delete subtle[method];
					}
				},
			};
		}

		function createInstance(): McpRegistryInputStorage {
			return store.add(new McpRegistryInputStorage(StorageScope.APPLICATION, StorageTarget.MACHINE, testStorageService, testSecretStorageService, testLogService));
		}

		/** Seals one secret, saves it, and returns a new instance whose record is sealed and not yet unsealed. */
		async function reopenWithSealed(): Promise<McpRegistryInputStorage> {
			await createInstance().setSecrets({ 's0': { value: 'sealed0' } });
			await testStorageService.flush();
			return createInstance();
		}

		function overtaken(e: unknown): boolean {
			return e instanceof McpInputsOvertakenError && e.name === 'McpInputsOvertakenError' && !e.message.includes('sealed0');
		}

		test('(a) concurrent first unseals share one decrypt, and a concurrent setSecrets values survive in memory and after a flush and reopen', async () => {
			const second = await reopenWithSealed();
			const pause = pauseWebCrypto('decrypt');
			try {
				const pending = [second.setSecrets({ 'a': { value: 'valueA' } }), second.setSecrets({ 'b': { value: 'valueB' } }), second.getMap()];
				await pause.reached();
				assert.strictEqual(pause.calls, 1, 'one decrypt is shared by every concurrent caller');
				pause.release();
				await Promise.all(pending);
			} finally {
				pause.restore();
			}

			const expected = { 's0': { value: 'sealed0' }, 'a': { value: 'valueA' }, 'b': { value: 'valueB' } };
			assert.deepStrictEqual(await second.getMap(), expected);
			await testStorageService.flush();
			assert.deepStrictEqual(await createInstance().getMap(), expected);
		});

		test('(a) a failed shared unseal rejects every caller, is not remembered, and a later read succeeds', async () => {
			const second = await reopenWithSealed();
			const wrongKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
			const goodKey = (await testSecretStorageService.get('mcpEncryptionKey'))!;
			await testSecretStorageService.set('mcpEncryptionKey', JSON.stringify(await crypto.subtle.exportKey('jwk', wrongKey)));

			await Promise.all([second.getMap(), second.setSecrets({ 'a': { value: 'valueA' } })].map(p => assert.rejects(p, (e: unknown) => e instanceof InvalidStoredSecretError && e.key === 'mcpInputs')));
			await testSecretStorageService.set('mcpEncryptionKey', goodKey);
			assert.strictEqual((await second.getMap()).s0.value, 'sealed0');
		});

		test('(b) clearAll during an in-flight unseal: getMap rejects named, and the cleared secrets are never returned', async () => {
			const second = await reopenWithSealed();
			const pause = pauseWebCrypto('decrypt');
			try {
				// The rejection is asserted below; it is held so that it is not reported unhandled meanwhile.
				const outcome = second.getMap().then(() => undefined, e => e);
				await pause.reached();
				second.clearAll();
				pause.release();
				assert.ok(overtaken(await outcome), 'the overtaken getMap rejects with the named error');
			} finally {
				pause.restore();
			}

			assert.deepStrictEqual(await second.getMap(), {});
			await testStorageService.flush();
			assert.deepStrictEqual(await createInstance().getMap(), {});
			assert.ok(!testStorageService.get('mcpInputs', StorageScope.APPLICATION)!.includes('"secrets"'));
		});

		test('(c) clearAll during an in-flight setSecrets: it rejects named, the new record stays empty after a flush and reopen, and a later setSecrets succeeds', async () => {
			const second = await reopenWithSealed();
			await second.getMap(); // unsealed; only the encryption of the next setSecrets is held
			const pause = pauseWebCrypto('encrypt');
			try {
				const outcome = second.setSecrets({ 'k': { value: 'valueK' } }).then(() => undefined, e => e);
				await pause.reached();
				second.clearAll();
				pause.release();
				assert.ok(overtaken(await outcome), 'the overtaken setSecrets rejects with the named error');
			} finally {
				pause.restore();
			}

			assert.deepStrictEqual(await second.getMap(), {});
			await testStorageService.flush();
			assert.deepStrictEqual(await createInstance().getMap(), {});
			assert.ok(!testStorageService.get('mcpInputs', StorageScope.APPLICATION)!.includes('"secrets"'));

			await second.setSecrets({ 'n': { value: 'valueN' } });
			assert.deepStrictEqual(await second.getMap(), { 'n': { value: 'valueN' } });
			await testStorageService.flush();
			assert.deepStrictEqual(await createInstance().getMap(), { 'n': { value: 'valueN' } });
		});

		test('clearAll during an in-flight clear rejects named and writes nothing into the new record', async () => {
			const second = await reopenWithSealed();
			await second.setPlainText({ 'p': { value: 'plain' } });
			await second.getMap();
			const pause = pauseWebCrypto('encrypt');
			try {
				const outcome = second.clear('s0').then(() => undefined, e => e);
				await pause.reached();
				second.clearAll();
				pause.release();
				assert.ok(overtaken(await outcome));
			} finally {
				pause.restore();
			}
			await testStorageService.flush();
			assert.deepStrictEqual(await createInstance().getMap(), {});
		});
	});
});

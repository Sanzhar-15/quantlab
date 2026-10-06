/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
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
});


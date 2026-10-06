/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IEncryptionService, KnownStorageProvider } from '../../../encryption/common/encryptionService.js';
import { NullLogService } from '../../../log/common/log.js';
import { BaseSecretStorageService, SecretDecryptionError } from '../../common/secrets.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../storage/common/storage.js';

class TestEncryptionService implements IEncryptionService {
	_serviceBrand: undefined;
	private encryptedPrefix = 'encrypted+'; // prefix to simulate encryption
	setUsePlainTextEncryption(): Promise<void> {
		return Promise.resolve();
	}
	getKeyStorageProvider(): Promise<KnownStorageProvider> {
		return Promise.resolve(KnownStorageProvider.basicText);
	}
	encrypt(value: string): Promise<string> {
		return Promise.resolve(this.encryptedPrefix + value);
	}
	decrypt(value: string): Promise<string> {
		return Promise.resolve(value.substring(this.encryptedPrefix.length));
	}
	isEncryptionAvailable(): Promise<boolean> {
		return Promise.resolve(true);
	}
}

class TestNoEncryptionService implements IEncryptionService {
	_serviceBrand: undefined;
	setUsePlainTextEncryption(): Promise<void> {
		throw new Error('Method not implemented.');
	}
	getKeyStorageProvider(): Promise<KnownStorageProvider> {
		throw new Error('Method not implemented.');
	}
	encrypt(value: string): Promise<string> {
		throw new Error('Method not implemented.');
	}
	decrypt(value: string): Promise<string> {
		throw new Error('Method not implemented.');
	}
	isEncryptionAvailable(): Promise<boolean> {
		return Promise.resolve(false);
	}
}

suite('secrets', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('BaseSecretStorageService useInMemoryStorage=true', () => {
		let service: BaseSecretStorageService;
		let spyEncryptionService: sinon.SinonSpiedInstance<TestEncryptionService>;
		let sandbox: sinon.SinonSandbox;

		setup(() => {
			sandbox = sinon.createSandbox();
			spyEncryptionService = sandbox.spy(new TestEncryptionService());
			service = store.add(new BaseSecretStorageService(
				true,
				store.add(new InMemoryStorageService()),
				spyEncryptionService,
				store.add(new NullLogService())
			));
		});

		teardown(() => {
			sandbox.restore();
		});

		test('type', async () => {
			assert.strictEqual(service.type, 'unknown');
			// trigger lazy initialization
			await service.set('my-secret', 'my-secret-value');

			assert.strictEqual(service.type, 'in-memory');
		});

		test('set and get', async () => {
			const key = 'my-secret';
			const value = 'my-secret-value';
			await service.set(key, value);
			const result = await service.get(key);
			assert.strictEqual(result, value);

			// Additionally ensure the encryptionservice was not used
			assert.strictEqual(spyEncryptionService.encrypt.callCount, 0);
			assert.strictEqual(spyEncryptionService.decrypt.callCount, 0);
		});

		test('delete', async () => {
			const key = 'my-secret';
			const value = 'my-secret-value';
			await service.set(key, value);
			await service.delete(key);
			const result = await service.get(key);
			assert.strictEqual(result, undefined);
		});

		test('onDidChangeSecret', async () => {
			const key = 'my-secret';
			const value = 'my-secret-value';
			let eventFired = false;
			store.add(service.onDidChangeSecret((changedKey) => {
				assert.strictEqual(changedKey, key);
				eventFired = true;
			}));
			await service.set(key, value);
			assert.strictEqual(eventFired, true);
		});
	});

	suite('BaseSecretStorageService useInMemoryStorage=false', () => {
		let service: BaseSecretStorageService;
		let spyEncryptionService: sinon.SinonSpiedInstance<TestEncryptionService>;
		let sandbox: sinon.SinonSandbox;

		setup(() => {
			sandbox = sinon.createSandbox();
			spyEncryptionService = sandbox.spy(new TestEncryptionService());
			service = store.add(new BaseSecretStorageService(
				false,
				store.add(new InMemoryStorageService()),
				spyEncryptionService,
				store.add(new NullLogService()))
			);
		});

		teardown(() => {
			sandbox.restore();
		});

		test('type', async () => {
			assert.strictEqual(service.type, 'unknown');
			// trigger lazy initialization
			await service.set('my-secret', 'my-secret-value');

			assert.strictEqual(service.type, 'persisted');
		});

		test('set and get', async () => {
			const key = 'my-secret';
			const value = 'my-secret-value';
			await service.set(key, value);
			const result = await service.get(key);
			assert.strictEqual(result, value);

			// Additionally ensure the encryptionservice was not used
			assert.strictEqual(spyEncryptionService.encrypt.callCount, 1);
			assert.strictEqual(spyEncryptionService.decrypt.callCount, 1);
		});

		test('delete', async () => {
			const key = 'my-secret';
			const value = 'my-secret-value';
			await service.set(key, value);
			await service.delete(key);
			const result = await service.get(key);
			assert.strictEqual(result, undefined);
		});

		test('onDidChangeSecret', async () => {
			const key = 'my-secret';
			const value = 'my-secret-value';
			let eventFired = false;
			store.add(service.onDidChangeSecret((changedKey) => {
				assert.strictEqual(changedKey, key);
				eventFired = true;
			}));
			await service.set(key, value);
			assert.strictEqual(eventFired, true);
		});
	});

	suite('BaseSecretStorageService useInMemoryStorage=false, decrypt fails', () => {
		// F-SECRETS-1: a denied or unavailable keychain must not cost the user a stored secret.
		test('a failed decrypt keeps the stored secret and rejects, naming the key; a later read succeeds', async () => {
			const encryptionService = new TestEncryptionService();
			const storageService = store.add(new InMemoryStorageService());
			const service = store.add(new BaseSecretStorageService(false, storageService, encryptionService, store.add(new NullLogService())));
			await service.set('my-secret', 'my-secret-value');
			const stored = storageService.get('secret://my-secret', StorageScope.APPLICATION);
			assert.ok(stored);

			const decrypt = sinon.stub(encryptionService, 'decrypt').rejects(new Error('keychain access denied'));
			await assert.rejects(service.get('my-secret'), (e: unknown) => e instanceof SecretDecryptionError && e.key === 'my-secret' && !e.message.includes('my-secret-value'));
			assert.deepStrictEqual(await service.keys(), ['my-secret']);
			assert.strictEqual(storageService.get('secret://my-secret', StorageScope.APPLICATION), stored);

			decrypt.restore();
			assert.strictEqual(await service.get('my-secret'), 'my-secret-value');
		});
	});

	suite('BaseSecretStorageService useInMemoryStorage=false, encryption not available', () => {
		let service: BaseSecretStorageService;
		let spyNoEncryptionService: sinon.SinonSpiedInstance<TestEncryptionService>;
		let sandbox: sinon.SinonSandbox;

		setup(() => {
			sandbox = sinon.createSandbox();
			spyNoEncryptionService = sandbox.spy(new TestNoEncryptionService());
			service = store.add(new BaseSecretStorageService(
				false,
				store.add(new InMemoryStorageService()),
				spyNoEncryptionService,
				store.add(new NullLogService()))
			);
		});

		teardown(() => {
			sandbox.restore();
		});

		test('type', async () => {
			assert.strictEqual(service.type, 'unknown');
			// trigger lazy initialization
			await service.set('my-secret', 'my-secret-value');

			assert.strictEqual(service.type, 'in-memory');
		});

		test('set and get', async () => {
			const key = 'my-secret';
			const value = 'my-secret-value';
			await service.set(key, value);
			const result = await service.get(key);
			assert.strictEqual(result, value);

			// Additionally ensure the encryptionservice was not used
			assert.strictEqual(spyNoEncryptionService.encrypt.callCount, 0);
			assert.strictEqual(spyNoEncryptionService.decrypt.callCount, 0);
		});
	});

	// F-SECRETS-1 review c1 (MUST-1): only undefined is absence; a present empty value is read like any other.
	suite('BaseSecretStorageService present empty stored value', () => {
		const fullKey = 'secret://my-secret';

		// Decrypts like the real service: a value that is not an encrypted envelope does not decrypt.
		class StrictEncryptionService extends TestEncryptionService {
			override decrypt(value: string): Promise<string> {
				return value.startsWith('encrypted+') ? super.decrypt(value) : Promise.reject(new Error('not an encrypted value'));
			}
		}

		test('an empty stored value in persisted mode rejects naming the key, and storage is untouched', async () => {
			const storageService = store.add(new InMemoryStorageService());
			const service = store.add(new BaseSecretStorageService(false, storageService, new StrictEncryptionService(), store.add(new NullLogService())));
			await service.keys(); // initialise: persisted mode
			storageService.store(fullKey, '', StorageScope.APPLICATION, StorageTarget.MACHINE);
			const stored = sinon.spy(storageService, 'store');
			const removed = sinon.spy(storageService, 'remove');

			await assert.rejects(service.get('my-secret'), (e: unknown) => e instanceof SecretDecryptionError && e.key === 'my-secret' && !e.message.includes('not an encrypted value'));
			assert.strictEqual(service.type, 'persisted');
			assert.strictEqual(stored.callCount, 0);
			assert.strictEqual(removed.callCount, 0);
			assert.strictEqual(storageService.get(fullKey, StorageScope.APPLICATION), '');
			assert.deepStrictEqual(await service.keys(), ['my-secret']);
		});

		test('an empty stored value that decrypts is returned, not read as absent', async () => {
			const storageService = store.add(new InMemoryStorageService());
			const encryptionService = new TestEncryptionService();
			const service = store.add(new BaseSecretStorageService(false, storageService, encryptionService, store.add(new NullLogService())));
			await service.set('my-secret', '');
			assert.strictEqual(await service.get('my-secret'), '');
		});

		test('an empty value in in-memory mode is returned, not read as absent', async () => {
			const service = store.add(new BaseSecretStorageService(true, store.add(new InMemoryStorageService()), new TestEncryptionService(), store.add(new NullLogService())));
			await service.set('my-secret', '');
			assert.strictEqual(await service.get('my-secret'), '');
		});

		test('an absent key reads as undefined without decrypting or writing', async () => {
			const storageService = store.add(new InMemoryStorageService());
			const encryptionService = sinon.spy(new StrictEncryptionService());
			const service = store.add(new BaseSecretStorageService(false, storageService, encryptionService, store.add(new NullLogService())));
			await service.keys();
			const stored = sinon.spy(storageService, 'store');
			const removed = sinon.spy(storageService, 'remove');

			assert.strictEqual(await service.get('my-secret'), undefined);
			assert.strictEqual(encryptionService.decrypt.callCount, 0);
			assert.strictEqual(stored.callCount, 0);
			assert.strictEqual(removed.callCount, 0);
		});
	});
});

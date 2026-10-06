/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IEncryptionService, KnownStorageProvider } from '../../../encryption/common/encryptionService.js';
import { NullLogService } from '../../../log/common/log.js';
import { BaseSecretStorageService, SecretDecryptionError, SecretStorageUnavailableError } from '../../common/secrets.js';
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
		// F-SECRETS-3: no fallback to an in-memory store. Every call rejects, named; the persisted secrets are kept; the failure
		// is not remembered, so the persisted secret is read once encryption is available.
		class RecordingLogService extends NullLogService {
			readonly errors: string[] = [];
			override error(message: string | Error, ...args: unknown[]): void {
				this.errors.push([String(message), ...args.map(arg => String(arg))].join(' '));
			}
		}

		function snapshot(storageService: InMemoryStorageService): [string, string | undefined][] {
			return storageService.keys(StorageScope.APPLICATION, StorageTarget.MACHINE).sort().map(key => [key, storageService.get(key, StorageScope.APPLICATION)]);
		}

		function isUnavailable(e: unknown): boolean {
			assert.ok(e instanceof SecretStorageUnavailableError, `expected SecretStorageUnavailableError, got ${e}`);
			assert.strictEqual(e.name, 'SecretStorageUnavailableError');
			assert.ok(!e.message.includes('my-secret-value') && !e.message.includes('encrypted+'), 'the error carries no secret');
			return true;
		}

		test('every call rejects named, the persisted secret stays byte-identical, and it is read once encryption is available', async () => {
			const encryptionService = new TestEncryptionService();
			const storageService = store.add(new InMemoryStorageService());
			storageService.store('secret://my-secret', 'encrypted+my-secret-value', StorageScope.APPLICATION, StorageTarget.MACHINE);
			const before = snapshot(storageService);
			const logService = store.add(new RecordingLogService());
			const available = sinon.stub(encryptionService, 'isEncryptionAvailable').resolves(false);
			const encrypt = sinon.spy(encryptionService, 'encrypt');
			const decrypt = sinon.spy(encryptionService, 'decrypt');
			const service = store.add(new BaseSecretStorageService(false, storageService, encryptionService, logService));

			await assert.rejects(service.get('my-secret'), isUnavailable);
			await assert.rejects(service.set('my-secret', 'replacement-value'), isUnavailable);
			await assert.rejects(service.set('other-secret', 'other-value'), isUnavailable);
			await assert.rejects(service.delete('my-secret'), isUnavailable);
			await assert.rejects(service.keys(), isUnavailable);

			assert.deepStrictEqual(snapshot(storageService), before, 'the persisted storage is byte-identical');
			assert.notStrictEqual(service.type, 'in-memory');
			assert.strictEqual(encrypt.callCount, 0);
			assert.strictEqual(decrypt.callCount, 0);
			assert.strictEqual(available.callCount, 5, 'a failed initialization is not remembered: every call checks again');
			assert.strictEqual(logService.errors.length, 5, 'one error line per failed call');
			for (const line of logService.errors) {
				assert.ok(line.includes('Secret storage is unavailable') && !line.includes('my-secret-value'), line);
			}

			available.resolves(true);
			assert.strictEqual(await service.get('my-secret'), 'my-secret-value');
			assert.strictEqual(service.type, 'persisted');
			assert.strictEqual(await service.get('other-secret'), undefined, 'nothing written while unavailable is held anywhere');
			assert.deepStrictEqual(snapshot(storageService), before);
			encrypt.restore();
			decrypt.restore();
			available.restore();
		});

		test('in-memory mode is unchanged: it never consults encryption and keeps secrets in memory only', async () => {
			const encryptionService = new TestNoEncryptionService();
			const available = sinon.spy(encryptionService, 'isEncryptionAvailable');
			const storageService = store.add(new InMemoryStorageService());
			const service = store.add(new BaseSecretStorageService(true, storageService, encryptionService, store.add(new NullLogService())));

			await service.set('my-secret', 'my-secret-value');
			assert.strictEqual(await service.get('my-secret'), 'my-secret-value');
			assert.strictEqual(service.type, 'in-memory');
			assert.strictEqual(available.callCount, 0);
			assert.deepStrictEqual(snapshot(storageService), [], 'the persisted storage is not written');
			available.restore();
		});
	});
});

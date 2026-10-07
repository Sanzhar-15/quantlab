/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IEncryptionService, KnownStorageProvider } from '../../../encryption/common/encryptionService.js';
import { transformErrorForSerialization } from '../../../../base/common/errors.js';
import { NullLogService } from '../../../log/common/log.js';
import { BaseSecretStorageService, SecretDecryptionCause, SecretDecryptionError, SecretEncryptionCause, SecretEncryptionError } from '../../common/secrets.js';
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

/** Reads a property the way an observer would; a getter that throws yields the thrown value, so it is inspected too. */
function observe(target: object, name: string): unknown {
	try {
		return (target as Record<string, unknown>)[name];
	} catch (thrown) {
		return thrown;
	}
}

/** Every string an observer can read out of a value, at any depth: own properties, message, stack, cause chain. */
function deepText(value: unknown, seen: Set<unknown> = new Set()): string {
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value !== 'object' || value === null) {
		return String(value);
	}
	if (seen.has(value)) {
		return '';
	}
	seen.add(value);
	const parts: string[] = [];
	if (value instanceof Error) {
		parts.push(deepText(observe(value, 'name'), seen), deepText(observe(value, 'message'), seen), deepText(observe(value, 'stack'), seen));
	}
	for (const name of Object.getOwnPropertyNames(value)) {
		parts.push(name, deepText(observe(value, name), seen));
	}
	return parts.join('\n');
}

/** Records every argument of every log call, of all six levels. */
class CapturingLogService extends NullLogService {
	readonly calls: unknown[][] = [];
	override trace(message: string, ...args: unknown[]): void { this.calls.push([message, ...args]); }
	override debug(message: string, ...args: unknown[]): void { this.calls.push([message, ...args]); }
	override info(message: string, ...args: unknown[]): void { this.calls.push([message, ...args]); }
	override warn(message: string, ...args: unknown[]): void { this.calls.push([message, ...args]); }
	override error(message: string | Error, ...args: unknown[]): void { this.calls.push([message, ...args]); }
	override critical(message: string | Error, ...args: unknown[]): void { this.calls.push([message, ...args]); }
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

	// F-SECRETS-7: a failed get() or set() is logged and rejected as a named error with a fixed cause. Nothing of the
	// failure is read: not its message, stack or cause, and not its name (an identifier-shaped name can be a secret).
	suite('BaseSecretStorageService useInMemoryStorage=false, the encryption layer fails', () => {
		const marker = 'PLANTEDSECRETVALUE7f3a';

		const failures: { readonly label: string; readonly make: () => unknown }[] = [
			{
				label: 'an error whose message, stack and nested cause carry the marker',
				make: () => {
					const failure = new Error(`denied ${marker}`, { cause: new Error(`nested ${marker}`, { cause: marker }) });
					failure.stack = `Error: denied ${marker}\n    at ${marker}`;
					return failure;
				}
			},
			{
				label: 'an error whose name is an identifier-shaped secret and whose message, stack and cause carry it too',
				make: () => {
					const failure = new Error(`denied ${marker}`, { cause: new Error(`nested ${marker}`) });
					failure.name = marker;
					failure.stack = `${marker}: denied ${marker}\n    at ${marker}`;
					return failure;
				}
			},
			{
				label: 'an error whose name getter throws an error that carries the marker',
				make: () => {
					const failure = new Error(`denied ${marker}`);
					Object.defineProperty(failure, 'name', { get() { throw new Error(`name read ${marker}`, { cause: marker }); } });
					return failure;
				}
			},
			{ label: 'a string that is the marker', make: () => marker },
			{ label: 'an object whose message is the marker', make: () => ({ message: marker, name: marker }) },
			{ label: 'null', make: () => null },
		];

		async function failingOperation(operation: 'get' | 'set', failure: unknown) {
			const encryptionService = new TestEncryptionService();
			const storageService = store.add(new InMemoryStorageService());
			const logService = store.add(new CapturingLogService());
			const service = store.add(new BaseSecretStorageService(false, storageService, encryptionService, logService));
			if (operation === 'get') {
				await service.set('my-secret', 'my-secret-value');
				sinon.stub(encryptionService, 'decrypt').callsFake(() => Promise.reject(failure));
			} else {
				sinon.stub(encryptionService, 'encrypt').callsFake(() => Promise.reject(failure));
			}
			logService.calls.length = 0;
			let rejection: unknown;
			try {
				if (operation === 'get') {
					await service.get('my-secret');
				} else {
					await service.set('my-secret', 'my-secret-value');
				}
			} catch (e) {
				rejection = e;
			}
			return { service, storageService, logService, rejection };
		}

		for (const operation of ['get', 'set'] as const) {
			const wrapper = operation === 'get' ? SecretDecryptionError : SecretEncryptionError;
			const causeType = operation === 'get' ? SecretDecryptionCause : SecretEncryptionCause;

			for (const { label, make } of failures) {
				test(`${operation}() rejects ${wrapper.name} naming the key and leaks nothing of ${label}`, async () => {
					const failure = make();
					const { service, storageService, logService, rejection } = await failingOperation(operation, failure);

					assert.ok(rejection instanceof wrapper, `rejected with ${deepText(rejection)}`);
					assert.notStrictEqual(rejection, failure, 'the rejection is not the raw error');
					assert.strictEqual(rejection.key, 'my-secret');
					assert.ok(rejection.message.includes(`'my-secret'`));
					assert.ok(rejection.cause instanceof causeType);
					assert.strictEqual(rejection.cause.message, 'The encryption service failed.');
					assert.strictEqual(rejection.cause.kind, 'encryption-service');
					assert.strictEqual(rejection.cause.cause, undefined);

					assert.ok(!deepText(rejection).includes(marker), 'message, stack, cause chain');
					assert.ok(!JSON.stringify(transformErrorForSerialization(rejection)).includes(marker), 'serialized for RPC');
					assert.ok(!JSON.stringify(rejection, Object.getOwnPropertyNames(rejection)).includes(marker), 'as JSON');
					assert.ok(!JSON.stringify(rejection.cause, Object.getOwnPropertyNames(rejection.cause)).includes(marker), 'cause as JSON');

					assert.ok(logService.calls.some(args => args.some(arg => arg instanceof wrapper)), 'the failure is logged as the named error');
					for (const args of logService.calls) {
						assert.ok(!args.includes(failure), 'the raw error is not a log argument');
						assert.ok(!deepText(args).includes(marker), deepText(args));
					}

					if (operation === 'get') {
						assert.ok(storageService.get('secret://my-secret', StorageScope.APPLICATION), 'the stored value is kept');
						assert.deepStrictEqual(await service.keys(), ['my-secret']);
					} else {
						assert.strictEqual(storageService.get('secret://my-secret', StorageScope.APPLICATION), undefined);
						assert.deepStrictEqual(await service.keys(), []);
					}
				});
			}
		}

		test('an error built without a failure has no cause', () => {
			assert.strictEqual(new SecretEncryptionError('my-secret').cause, undefined);
			assert.strictEqual(new SecretEncryptionError('my-secret').name, 'SecretEncryptionError');
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

	// F-SECRETS-1 review c1 (SHOULD-9): the cause of a SecretDecryptionError is safe by construction.
	suite('SecretDecryptionError cause', () => {
		const marker = 'PLANTED-ENCRYPTED-VALUE-MARKER';

		/** Everything an observer can see of an error and its causes: serialized for RPC, as JSON, and as text. */
		function everythingObservable(error: Error): string {
			const parts: string[] = [JSON.stringify(transformErrorForSerialization(error)), String(error.stack), error.message];
			for (let cause: unknown = error.cause; cause !== undefined; cause = cause instanceof Error ? cause.cause : undefined) {
				parts.push(cause instanceof Error ? `${cause.name} ${cause.message} ${cause.stack} ${JSON.stringify(cause, Object.getOwnPropertyNames(cause))}` : String(cause));
			}
			return parts.join('\n');
		}

		async function failingGet(failure: unknown, logService: NullLogService = store.add(new NullLogService())): Promise<unknown> {
			const encryptionService = new TestEncryptionService();
			const storageService = store.add(new InMemoryStorageService());
			const service = store.add(new BaseSecretStorageService(false, storageService, encryptionService, logService));
			await service.set('my-secret', 'my-secret-value');
			sinon.stub(encryptionService, 'decrypt').callsFake(() => Promise.reject(failure));
			try {
				await service.get('my-secret');
			} catch (e) {
				return e;
			}
			throw new Error('get() did not reject');
		}

		test('an encryption error that carries the encrypted value is not carried as the cause', async () => {
			const failure = new SyntaxError(`Unexpected token ${marker} in JSON at position 3`, { cause: new Error(marker) });
			const error = await failingGet(failure);
			assert.ok(error instanceof SecretDecryptionError);
			assert.strictEqual(error.key, 'my-secret');
			assert.ok(error.cause instanceof SecretDecryptionCause);
			assert.notStrictEqual(error.cause, failure);
			assert.strictEqual((error.cause as SecretDecryptionCause).kind, 'encryption-service');
			assert.strictEqual((error.cause as SecretDecryptionCause).cause, undefined);
			assert.ok(!everythingObservable(error).includes(marker));
		});

		test('the cause is a fixed text and a fixed kind whatever the failure is', async () => {
			const named = new Error(`denied ${marker}`);
			named.name = 'KeychainDeniedError';
			const spaced = new Error('x');
			spaced.name = `${marker} with spaces`;
			for (const failure of [named, spaced, marker, { message: marker }, null]) {
				const error = await failingGet(failure) as SecretDecryptionError;
				assert.ok(error instanceof SecretDecryptionError);
				assert.strictEqual((error.cause as Error).message, 'The encryption service failed.');
				assert.strictEqual((error.cause as SecretDecryptionCause).kind, 'encryption-service');
				assert.ok(!everythingObservable(error).includes(marker));
				assert.ok(!everythingObservable(error).includes('KeychainDeniedError'));
			}
		});

		test('the logged error carries no marker either, at any level or in any argument', async () => {
			const logService = store.add(new CapturingLogService());
			const failure = new Error(`denied ${marker}`, { cause: new Error(marker) });
			await failingGet(failure, logService);
			assert.ok(logService.calls.some(args => args.some(arg => arg instanceof SecretDecryptionError)));
			for (const args of logService.calls) {
				assert.ok(!args.includes(failure), 'the raw error is not a log argument');
				assert.ok(!deepText(args).includes(marker), deepText(args));
			}
		});

		test('an error built without a failure has no cause', () => {
			const error = new SecretDecryptionError('my-secret');
			assert.strictEqual(error.cause, undefined);
			assert.strictEqual(error.name, 'SecretDecryptionError');
		});
	});
});

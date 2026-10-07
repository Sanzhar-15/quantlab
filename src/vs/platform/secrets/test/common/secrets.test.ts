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
import { BaseSecretStorageService, REDACTED_SECRET_KEY, SecretDecryptionCause, SecretDecryptionError, SecretStorageUnavailableError } from '../../common/secrets.js';
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

		class RecordingLogService extends NullLogService {
			readonly errors: Error[] = [];
			override error(message: string | Error): void {
				if (message instanceof Error) {
					this.errors.push(message);
				}
			}
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
			assert.strictEqual((error.cause as SecretDecryptionCause).kind, 'SyntaxError');
			assert.strictEqual((error.cause as SecretDecryptionCause).cause, undefined);
			assert.ok(!everythingObservable(error).includes(marker));
		});

		test('the cause names the class of the failure and nothing else', async () => {
			const failure = new Error(`denied ${marker}`);
			failure.name = 'KeychainDeniedError';
			const error = await failingGet(failure) as SecretDecryptionError;
			assert.strictEqual((error.cause as Error).message, 'The encryption service failed (KeychainDeniedError).');
			assert.ok(!everythingObservable(error).includes(marker));
		});

		test('a failure whose name is not a plain identifier, or that is not an error, names no kind', async () => {
			const named = new Error('x');
			named.name = marker + ' with spaces';
			for (const failure of [named, marker, { message: marker }, null]) {
				const error = await failingGet(failure) as SecretDecryptionError;
				assert.ok(error instanceof SecretDecryptionError);
				assert.strictEqual((error.cause as SecretDecryptionCause).kind, 'unknown');
				assert.ok(!everythingObservable(error).includes(marker));
			}
		});

		test('the logged error carries no marker either', async () => {
			const logService = store.add(new RecordingLogService());
			await failingGet(new Error(`denied ${marker}`, { cause: new Error(marker) }), logService);
			assert.strictEqual(logService.errors.length, 1);
			assert.ok(logService.errors[0] instanceof SecretDecryptionError);
			assert.ok(!everythingObservable(logService.errors[0]).includes(marker));
		});

		test('an error built without a failure has no cause', () => {
			const error = new SecretDecryptionError('my-secret');
			assert.strictEqual(error.cause, undefined);
			assert.strictEqual(error.name, 'SecretDecryptionError');
		});
	});

	// QL-G-LOGIN-SECRETS review c1 M3 (W-ORCH item): a key built from a server-provided string (a dynamic authentication
	// provider's issuer URL) can hold a credential in its user info, path or query. No log line at any level and no error
	// property carries such a key; storage keeps the key itself.
	suite('a credential-bearing key reaches no log argument or error property', () => {
		const USERINFO = 'MARK-KEY-USERINFO-71d3';
		const PATH = 'MARK-KEY-PATH-28fa';
		const QUERY = 'MARK-KEY-QUERY-c94e';
		const MARKERS = [USERINFO, PATH, QUERY];
		const KEY = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: `https://user:${USERINFO}@issuer.example/${PATH}?key=${QUERY}`, clientId: 'client-1' });

		class RecordingLogService extends NullLogService {
			readonly args: unknown[][] = [];
			override trace(...args: unknown[]): void { this.args.push(args); }
			override debug(...args: unknown[]): void { this.args.push(args); }
			override info(...args: unknown[]): void { this.args.push(args); }
			override warn(...args: unknown[]): void { this.args.push(args); }
			override error(...args: unknown[]): void { this.args.push(args); }
		}

		/** Every string reachable from a value: an Error contributes its name, message, stack, own properties and causes. */
		function collectStrings(value: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
			if (typeof value === 'string') {
				out.push(value);
			} else if (typeof value !== 'object' && typeof value !== 'function' || value === null) {
				out.push(String(value));
			} else if (!seen.has(value)) {
				seen.add(value);
				if (value instanceof Error) {
					out.push(value.name, value.message, value.stack ?? '', JSON.stringify(transformErrorForSerialization(value)));
					collectStrings(value.cause, out, seen);
				}
				for (const key of Object.getOwnPropertyNames(value)) {
					collectStrings((value as Record<string, unknown>)[key], out, seen);
				}
			}
			return out;
		}

		function assertNoMarker(what: string, value: unknown): void {
			for (const text of collectStrings(value)) {
				for (const marker of MARKERS) {
					assert.ok(!text.includes(marker), `${what}: a marker (${marker}) reached it: ${text}`);
				}
			}
		}

		test('set, get, a failed decryption, delete and the change notification, at trace level', async () => {
			const logService = store.add(new RecordingLogService());
			const encryptionService = new TestEncryptionService();
			const storageService = store.add(new InMemoryStorageService());
			const service = store.add(new BaseSecretStorageService(false, storageService, encryptionService, logService));
			const changed: string[] = [];
			store.add(service.onDidChangeSecret(key => changed.push(key)));

			await service.set(KEY, 'value');
			assert.strictEqual(await service.get(KEY), 'value');
			const decrypt = sinon.stub(encryptionService, 'decrypt').callsFake(() => Promise.reject(new Error('keychain refused')));
			let failure: unknown;
			try {
				await service.get(KEY);
			} catch (e) {
				failure = e;
			}
			decrypt.restore();
			await service.delete(KEY);

			assertNoMarker('the log arguments', logService.args);
			assert.ok(failure instanceof SecretDecryptionError, `expected SecretDecryptionError, got ${failure}`);
			assertNoMarker('the rejected error', failure);
			assert.strictEqual(failure.key, REDACTED_SECRET_KEY);
			assert.ok(logService.args.some(args => args[0] === '[secrets] getting secret for key:' && args[1] === `secret://${REDACTED_SECRET_KEY}`), JSON.stringify(logService.args));
			// Storage and the change event keep the key itself: only its diagnostic form is redacted.
			assert.deepStrictEqual(changed, [KEY, KEY], 'the change event names the key itself');
			assert.deepStrictEqual(await service.keys(), []);
		});
	});
});

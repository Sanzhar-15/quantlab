/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { DynamicAuthenticationProviderStorageService, InvalidStoredProviderListError } from '../../browser/dynamicAuthenticationProviderStorageService.js';

const PROVIDERS_STORAGE_KEY = 'dynamicAuthProviders';
const CLEANUP_INDEX_STORAGE_KEY = 'dynamicAuthProviderCleanupIndex';

/** Independent credential markers: none may reach a log argument or a propagated error, whole or alone. */
const LIST_MARKER = 'mkr-list-7c3e';
const CREDENTIAL_MARKER = 'mkr-cred-2b9d';
const SESSION_MARKER = 'mkr-sess-5f1a';
const MARKERS = [LIST_MARKER, CREDENTIAL_MARKER, SESSION_MARKER];

const CREDENTIALS_KEY = 'dynamicAuthProvider:clientRegistration:p1';
const CREDENTIALS_VALUE = JSON.stringify({ clientId: 'client-1', clientSecret: CREDENTIAL_MARKER });
const SESSIONS_KEY = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: 'p1', clientId: 'client-1' });
const SESSIONS_VALUE = JSON.stringify([{ access_token: SESSION_MARKER, token_type: 'Bearer', created_at: 1 }]);

/** A removal's unregistration where no provider is registered in the window: these tests are about storage only. */
function unregisterNothing(): void { }

/** Every text an error carries: message, stack, cause chain and own properties. */
function errorTexts(error: unknown): string[] {
	if (!(error instanceof Error)) {
		return [String(error), String(JSON.stringify(error))];
	}
	const texts = [error.message, String(error.stack), JSON.stringify(error)];
	if (error.cause !== undefined) {
		texts.push(...errorTexts(error.cause));
	}
	return texts;
}

function argumentTexts(arg: unknown): string[] {
	if (typeof arg === 'string') {
		return [arg];
	}
	return arg instanceof Error ? errorTexts(arg) : [String(arg), String(JSON.stringify(arg))];
}

class RecordingLogService extends NullLogService {
	readonly lines: string[] = [];
	readonly errors: string[] = [];
	/** Each logged argument (message included) on its own, at every level. */
	readonly argumentTexts: string[] = [];
	private record(level: string, message: string | Error, args: unknown[]): string {
		for (const arg of [message, ...args]) {
			this.argumentTexts.push(...argumentTexts(arg));
		}
		const line = [level, String(message), ...args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg))].join(' ');
		this.lines.push(line);
		return line;
	}
	override trace(message: string, ...args: unknown[]): void { this.record('trace', message, args); }
	override debug(message: string, ...args: unknown[]): void { this.record('debug', message, args); }
	override info(message: string, ...args: unknown[]): void { this.record('info', message, args); }
	override warn(message: string, ...args: unknown[]): void { this.record('warn', message, args); }
	override error(message: string | Error, ...args: unknown[]): void { this.errors.push(this.record('error', message, args)); }
	override critical(message: string | Error, ...args: unknown[]): void { this.record('critical', message, args); }
}

/** Records every store and remove, whatever the key or bytes. */
class RecordingStorageService extends TestStorageService {
	readonly mutations: string[] = [];
	override store(...args: Parameters<TestStorageService['store']>): void {
		this.mutations.push(`store ${args[0]}`);
		super.store(...args);
	}
	override remove(...args: Parameters<TestStorageService['remove']>): void {
		this.mutations.push(`remove ${args[0]}`);
		super.remove(...args);
	}
}

/** Records every secret set and delete, whatever the key or bytes. */
class RecordingSecretStorageService extends TestSecretStorageService {
	readonly mutations: string[] = [];
	override async set(key: string, value: string): Promise<void> {
		this.mutations.push(`set ${key}`);
		return super.set(key, value);
	}
	override async delete(key: string): Promise<void> {
		this.mutations.push(`delete ${key}`);
		return super.delete(key);
	}
}

suite('DynamicAuthenticationProviderStorageService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let storageService: RecordingStorageService;
	let secretStorageService: RecordingSecretStorageService;
	let logService: RecordingLogService;
	let service: DynamicAuthenticationProviderStorageService;

	setup(() => {
		storageService = disposables.add(new RecordingStorageService());
		secretStorageService = disposables.add(new RecordingSecretStorageService());
		logService = disposables.add(new RecordingLogService());
		service = disposables.add(new DynamicAuthenticationProviderStorageService(storageService, secretStorageService, logService));
	});

	function storeRaw(raw: string): void {
		storageService.store(PROVIDERS_STORAGE_KEY, raw, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	function readRaw(): string | undefined {
		return storageService.get(PROVIDERS_STORAGE_KEY, StorageScope.APPLICATION);
	}

	const invalidStoredValues: { name: string; raw: string; reason: string }[] = [
		{ name: 'not JSON', raw: 'not json', reason: 'not valid JSON (SyntaxError)' },
		{ name: 'not JSON, holding a marker', raw: `${LIST_MARKER} is not json`, reason: 'not valid JSON (SyntaxError)' },
		{ name: 'truncated JSON holding a marker', raw: `[{"providerId":"p1","clientSecret":"${LIST_MARKER}"`, reason: 'not valid JSON (SyntaxError)' },
		{ name: 'an object, not an array', raw: '{}', reason: 'not an array (object)' },
		{ name: 'an array with a null entry', raw: '[null]', reason: 'entry 0 is not an object (null)' },
		{ name: 'an entry without a string providerId', raw: `[{"providerId":7,"clientSecret":"${LIST_MARKER}"}]`, reason: 'entry 0 field providerId is not a string (number)' },
		{ name: 'an entry with a non-string clientId', raw: `[{"providerId":"p1","clientId":7,"label":false,"authorizationServer":{},"clientSecret":"${LIST_MARKER}"}]`, reason: 'entry 0 field clientId is not a string (number)' },
		{ name: 'an entry with a non-string label', raw: `[{"providerId":"p1","clientId":"${LIST_MARKER}","label":false,"authorizationServer":"https://as.example"}]`, reason: 'entry 0 field label is not a string (boolean)' },
		{ name: 'an entry with a non-string authorizationServer', raw: `[{"providerId":"p1","clientId":"${LIST_MARKER}","label":"Label","authorizationServer":{}}]`, reason: 'entry 0 field authorizationServer is not a string (object)' },
		{ name: 'a legacy entry with a non-string issuer', raw: `[{"providerId":"p1","clientId":"${LIST_MARKER}","label":"Label","issuer":5}]`, reason: 'entry 0 field issuer is not a string (number)' },
		{ name: 'a legacy entry with neither authorizationServer nor issuer', raw: `[{"providerId":"p1","clientId":"${LIST_MARKER}","label":"Label"}]`, reason: 'entry 0 has no authorizationServer and no legacy issuer' },
		{ name: 'a valid entry followed by an invalid entry', raw: `[{"providerId":"p1","clientId":"${LIST_MARKER}","label":"Label","authorizationServer":"https://as.example"},{"providerId":"p2","clientId":7,"label":"Other","authorizationServer":"https://as.example"}]`, reason: 'entry 1 field clientId is not a string (number)' },
	];

	/** Puts an invalid stored list, credentials and sessions in place, then clears every recorder so only the call under test is seen. */
	async function seedInvalidStoredList(raw: string): Promise<void> {
		storeRaw(raw);
		await secretStorageService.set(CREDENTIALS_KEY, CREDENTIALS_VALUE);
		await secretStorageService.set(SESSIONS_KEY, SESSIONS_VALUE);
		// Let the service's secret-change listener finish reading the seeded sessions before recording starts.
		await timeout(0);
		storageService.mutations.length = 0;
		secretStorageService.mutations.length = 0;
		logService.lines.length = 0;
		logService.errors.length = 0;
		logService.argumentTexts.length = 0;
	}

	/**
	 * The three halves of "a read of an invalid stored list fails safely", each its own assertion so that none can hide behind
	 * another: the named error, the storage left untouched, the log clean.
	 */
	function checksFor(raw: string, reason: string) {
		/** The named error, carrying the key and reason through its placeholders, and no marker anywhere. */
		function isSafeNamedError(error: unknown): true {
			assert.ok(error instanceof InvalidStoredProviderListError, `expected InvalidStoredProviderListError, got ${error}`);
			assert.strictEqual(error.name, 'InvalidStoredProviderListError');
			assert.strictEqual(error.storageKey, PROVIDERS_STORAGE_KEY);
			assert.strictEqual(error.reason, reason);
			// The localized message (the English default here) carries the key and the reason through its placeholders.
			assert.strictEqual(error.message, `Stored dynamic authentication provider list '${PROVIDERS_STORAGE_KEY}' is invalid: ${reason}. It was left unchanged.`);
			assert.strictEqual(error.cause, undefined, 'the error carries no cause');
			for (const text of errorTexts(error)) {
				for (const marker of MARKERS) {
					assert.ok(!text.includes(marker), `the propagated error holds marker ${marker}`);
				}
			}
			return true;
		}

		/** The stored list, credentials and sessions are byte-identical, and nothing was stored, removed, set or deleted. */
		async function assertStoragePreserved(): Promise<void> {
			assert.strictEqual(readRaw(), raw, 'the stored list must stay byte-identical');
			assert.deepStrictEqual(storageService.mutations, [], 'no list store or remove after a failed read');
			assert.deepStrictEqual(secretStorageService.mutations, [], 'no secret set or delete after a failed read');
			assert.strictEqual(await secretStorageService.get(CREDENTIALS_KEY), CREDENTIALS_VALUE, 'the stored credentials must stay byte-identical');
			assert.strictEqual(await secretStorageService.get(SESSIONS_KEY), SESSIONS_VALUE, 'the stored sessions must stay byte-identical');
		}

		/** One error line naming the key and the reason, no other line, and neither the stored text nor a marker in any log argument. */
		function assertLogClean(): void {
			assert.strictEqual(logService.errors.length, 1, 'one error line per failed read');
			assert.strictEqual(logService.lines.length, 1, 'no other log line');
			const [line] = logService.lines;
			assert.ok(!line.includes(raw), `log line holds the stored text: ${line}`);
			assert.ok(line.includes(PROVIDERS_STORAGE_KEY), `log line names the key: ${line}`);
			assert.ok(line.includes(reason), `log line names the reason: ${line}`);
			for (const text of logService.argumentTexts) {
				for (const marker of MARKERS) {
					assert.ok(!text.includes(marker), `a log argument holds marker ${marker}: ${text}`);
				}
			}
		}

		/**
		 * Runs `call`, then ALL THREE checks whatever any of them found, and throws one AggregateError naming every check that
		 * failed: a wrong error never stops the storage and log checks from being reached.
		 */
		async function assertNamedErrorAndPreservation(call: () => unknown): Promise<void> {
			let threw = false;
			let thrown: unknown;
			try {
				await call();
			} catch (error) {
				threw = true;
				thrown = error;
			}
			const failures: { check: string; error: Error }[] = [];
			const run = async (check: string, assertion: () => unknown): Promise<void> => {
				try {
					await assertion();
				} catch (error) {
					failures.push({ check, error: error as Error });
				}
			};
			await run('named error', () => {
				assert.ok(threw, 'the call resolved instead of throwing the named error');
				isSafeNamedError(thrown);
			});
			await run('storage preserved', assertStoragePreserved);
			await run('log clean', assertLogClean);
			if (failures.length > 0) {
				throw new AggregateError(failures.map(f => f.error), failures.map(f => `${f.check}: ${f.error.message}`).join(' | '));
			}
		}

		return { isSafeNamedError, assertStoragePreserved, assertLogClean, assertNamedErrorAndPreservation };
	}

	for (const { name, raw, reason } of invalidStoredValues) {
		suite(`stored list is ${name}`, () => {
			const checks = checksFor(raw, reason);

			setup(() => seedInvalidStoredList(raw));

			test('getClientId throws the named error', async () => {
				await checks.assertNamedErrorAndPreservation(() => service.getClientId('p1'));
			});

			test('getInteractedProviders throws the named error', async () => {
				await checks.assertNamedErrorAndPreservation(() => service.getInteractedProviders());
			});

			test('getClientRegistration for a provider with no stored credentials rejects with the named error', async () => {
				await checks.assertNamedErrorAndPreservation(() => service.getClientRegistration('p0'));
			});

			test('storeClientRegistration rejects with the named error and writes nothing', async () => {
				await checks.assertNamedErrorAndPreservation(() => service.storeClientRegistration('p1', 'https://as.example', 'client-1', 'secret-new', 'Label', 0));
			});

			test('removeDynamicProvider rejects with the named error and deletes nothing', async () => {
				await checks.assertNamedErrorAndPreservation(() => service.removeDynamicProvider('p1', unregisterNothing));
			});
		});
	}

	// review-c1 item 10 (second paragraph): the storage-preservation and no-log assertions must be able to fail on their own. Each
	// plant below is a subclass or a log wrapper in THIS file (the product is untouched) that lets the call still raise the
	// named error, so the named-error assertion passes, and adds one forbidden effect, so exactly one preservation assertion fails.
	suite('the preservation assertions fail on their own', () => {
		const { raw, reason } = invalidStoredValues[1];
		const checks = checksFor(raw, reason);

		class PlantedService extends DynamicAuthenticationProviderStorageService {
			syncPlant: () => void = () => { };
			asyncPlant: () => Promise<void> = async () => { };
			// The plant runs AFTER the product call has raised the named error (and is not allowed to replace it).
			override getInteractedProviders(): ReturnType<DynamicAuthenticationProviderStorageService['getInteractedProviders']> {
				try {
					return super.getInteractedProviders();
				} finally {
					this.syncPlant();
				}
			}
			override async removeDynamicProvider(providerId: string, unregister: () => void): Promise<void> {
				try {
					return await super.removeDynamicProvider(providerId, unregister);
				} finally {
					await this.asyncPlant();
				}
			}
		}

		/** The log wrapper of a "marker log" plant: the product's own one error line also carries a marker. */
		class MarkerInErrorLineLogService extends RecordingLogService {
			override error(message: string | Error, ...args: unknown[]): void { super.error(message, ...args, CREDENTIAL_MARKER); }
		}

		function plantedService(log: RecordingLogService = logService): PlantedService {
			return disposables.add(new PlantedService(storageService, secretStorageService, log));
		}

		const storeList = (value: string) => storageService.store(PROVIDERS_STORAGE_KEY, value, StorageScope.APPLICATION, StorageTarget.MACHINE);

		setup(() => seedInvalidStoredList(raw));

		test('control: the unplanted service passes all three checks', async () => {
			await checks.assertNamedErrorAndPreservation(() => service.getInteractedProviders());
		});

		test('planted list rewrite to []: the named error passes, only the storage assertion fails', async () => {
			const planted = plantedService();
			planted.syncPlant = () => storeList('[]');

			assert.throws(() => planted.getInteractedProviders(), checks.isSafeNamedError);
			await assert.rejects(checks.assertStoragePreserved(), /the stored list must stay byte-identical/);
			checks.assertLogClean();
		});

		test('planted list store of the identical bytes: the named error passes, only the mutation assertion fails', async () => {
			const planted = plantedService();
			planted.syncPlant = () => storeList(raw);

			assert.throws(() => planted.getInteractedProviders(), checks.isSafeNamedError);
			await assert.rejects(checks.assertStoragePreserved(), /no list store or remove after a failed read/);
			checks.assertLogClean();
		});

		test('planted credential delete: the named error passes, only the secret-mutation assertion fails', async () => {
			const planted = plantedService();
			planted.asyncPlant = () => secretStorageService.delete(CREDENTIALS_KEY);

			await assert.rejects(planted.removeDynamicProvider('p1', unregisterNothing), checks.isSafeNamedError);
			await assert.rejects(checks.assertStoragePreserved(), /no secret set or delete after a failed read/);
			checks.assertLogClean();
		});

		test('planted marker in the one error line: the named error and the storage pass, only the log assertion fails', async () => {
			const leaky = disposables.add(new MarkerInErrorLineLogService());
			const planted = plantedService(leaky);
			logService = leaky;

			assert.throws(() => planted.getInteractedProviders(), checks.isSafeNamedError);
			await checks.assertStoragePreserved();
			assert.throws(() => checks.assertLogClean(), new RegExp(`a log argument holds marker ${CREDENTIAL_MARKER}`));
		});

		test('planted extra log line carrying a marker: the named error and the storage pass, only the log assertion fails', async () => {
			const planted = plantedService();
			planted.syncPlant = () => logService.info(`session ${SESSION_MARKER}`);

			assert.throws(() => planted.getInteractedProviders(), checks.isSafeNamedError);
			await checks.assertStoragePreserved();
			assert.throws(() => checks.assertLogClean(), /no other log line/);
		});

		test('a call that swallows the error is reported by the named-error check while the storage and log checks are still reached', async () => {
			const swallowing = plantedService();
			swallowing.getInteractedProviders = () => [];

			await assert.rejects(checks.assertNamedErrorAndPreservation(() => swallowing.getInteractedProviders()), (error: unknown) => {
				assert.ok(error instanceof AggregateError);
				// the swallowing call logged nothing, so the log check fails with it: the named-error check is not the only one reached
				assert.deepStrictEqual(error.message.split(' | ').map(part => part.split(':')[0]), ['named error', 'log clean']);
				return true;
			});
		});

		test('a call that swallows the error and rewrites the list fails the named-error, the storage and the log checks together', async () => {
			const rewriting = plantedService();
			rewriting.getInteractedProviders = () => { storeList('[]'); return []; };

			await assert.rejects(checks.assertNamedErrorAndPreservation(() => rewriting.getInteractedProviders()), (error: unknown) => {
				assert.ok(error instanceof AggregateError);
				assert.deepStrictEqual(error.message.split(' | ').map(part => part.split(':')[0]), ['named error', 'storage preserved', 'log clean']);
				return true;
			});
		});
	});

	suite('stored list is absent', () => {
		test('getInteractedProviders returns an empty list', () => {
			assert.strictEqual(readRaw(), undefined);
			assert.deepStrictEqual(service.getInteractedProviders(), []);
			assert.strictEqual(service.getClientId('p1'), undefined);
			assert.deepStrictEqual(logService.errors, []);
		});

		test('storeClientRegistration stores one entry', async () => {
			await service.storeClientRegistration('p1', 'https://as.example', 'client-1', 'secret-1', 'Label', 0);
			assert.deepStrictEqual(JSON.parse(readRaw()!), [{ providerId: 'p1', label: 'Label', authorizationServer: 'https://as.example', clientId: 'client-1' }]);
			assert.deepStrictEqual(service.getInteractedProviders().map(p => p.providerId), ['p1']);
			assert.deepStrictEqual(await service.getClientRegistration('p1'), { clientId: 'client-1', clientSecret: 'secret-1' });
			assert.deepStrictEqual(logService.errors, []);
		});
	});

	// review-c1 M1: a registration or removal that fails part-way keeps the previous committed identity and the cleanup
	// identity, so a retry completes it. review-c1 M2 (storage side): once a removal has completed, a session write for
	// the provider is rejected, named, and recreates nothing.
	suite('partial storage failures and writes after removal', () => {
		const AS = 'https://as.example';
		const NEW_CREDENTIALS_VALUE = JSON.stringify({ clientId: 'client-2', clientSecret: 'secret-2' });
		const PREVIOUS_CREDENTIALS = JSON.stringify({ clientId: 'client-1', clientSecret: 'secret-1' });
		const sessionsKey = (clientId: string) => JSON.stringify({ isDynamicAuthProvider: true, authProviderId: 'p1', clientId });

		/** Refuses the named secret writes or deletions; `refuseSet` sees the value too, so a restore can be refused alone. */
		class FailingSecretStorageService extends TestSecretStorageService {
			refuseSet: (key: string, value: string) => boolean = () => false;
			readonly refuseDelete = new Set<string>();
			override async set(key: string, value: string): Promise<void> {
				if (this.refuseSet(key, value)) {
					throw new Error('set refused');
				}
				return super.set(key, value);
			}
			override async delete(key: string): Promise<void> {
				if (this.refuseDelete.has(key)) {
					throw new Error('delete refused');
				}
				return super.delete(key);
			}
		}

		class FailingStorageService extends TestStorageService {
			refuseListStore = false;
			refuseIndexStore = false;
			override store(...args: Parameters<TestStorageService['store']>): void {
				if ((this.refuseListStore && args[0] === PROVIDERS_STORAGE_KEY) || (this.refuseIndexStore && args[0] === CLEANUP_INDEX_STORAGE_KEY)) {
					throw new Error('store refused');
				}
				super.store(...args);
			}
		}

		async function createSeeded() {
			const storage = disposables.add(new FailingStorageService());
			const secrets = disposables.add(new FailingSecretStorageService());
			const log = disposables.add(new RecordingLogService());
			const dynamicStorage = disposables.add(new DynamicAuthenticationProviderStorageService(storage, secrets, log));
			await dynamicStorage.storeClientRegistration('p1', AS, 'client-1', 'secret-1', 'Label', 0);
			await dynamicStorage.setSessionsForDynamicAuthProvider('p1', 'client-1', JSON.parse(SESSIONS_VALUE));
			const list = () => storage.get(PROVIDERS_STORAGE_KEY, StorageScope.APPLICATION);
			const listedClientIds = () => dynamicStorage.getInteractedProviders().map(p => [p.providerId, p.clientId]);
			const allSecrets = async () => JSON.stringify(await Promise.all((await secrets.keys()).sort().map(async key => [key, await secrets.get(key)])));
			return { storage, secrets, log, dynamicStorage, list, listedClientIds, allSecrets };
		}

		test('registration: the credential write fails; the previous identity is kept whole; a retry commits the new one', async () => {
			const w = await createSeeded();
			const listBefore = w.list();
			const secretsBefore = await w.allSecrets();
			w.secrets.refuseSet = key => key === CREDENTIALS_KEY;

			await assert.rejects(w.dynamicStorage.storeClientRegistration('p1', AS, 'client-2', 'secret-2', 'Label', 0), /set refused/);

			assert.strictEqual(w.list(), listBefore, 'the list still names the previous client');
			assert.strictEqual(await w.allSecrets(), secretsBefore, 'the client registration and sessions are byte-identical');
			assert.deepStrictEqual(await w.dynamicStorage.getClientRegistration('p1'), { clientId: 'client-1', clientSecret: 'secret-1' });

			w.secrets.refuseSet = () => false;
			await w.dynamicStorage.storeClientRegistration('p1', AS, 'client-2', 'secret-2', 'Label', 0);
			assert.deepStrictEqual(w.listedClientIds(), [['p1', 'client-2']]);
			assert.strictEqual(await w.secrets.get(CREDENTIALS_KEY), NEW_CREDENTIALS_VALUE);
		});

		test('registration: the list commit fails; the previous client registration is restored; a retry commits the new one', async () => {
			const w = await createSeeded();
			const listBefore = w.list();
			const secretsBefore = await w.allSecrets();
			w.storage.refuseListStore = true;

			await assert.rejects(w.dynamicStorage.storeClientRegistration('p1', AS, 'client-2', 'secret-2', 'Label', 0), /store refused/);

			assert.strictEqual(w.list(), listBefore);
			assert.strictEqual(await w.secrets.get(CREDENTIALS_KEY), PREVIOUS_CREDENTIALS, 'the previous client registration is back');
			assert.strictEqual(await w.allSecrets(), secretsBefore);

			w.storage.refuseListStore = false;
			await w.dynamicStorage.storeClientRegistration('p1', AS, 'client-2', 'secret-2', 'Label', 0);
			assert.deepStrictEqual(w.listedClientIds(), [['p1', 'client-2']]);
			assert.strictEqual(await w.secrets.get(CREDENTIALS_KEY), NEW_CREDENTIALS_VALUE);
		});

		test('registration of a new provider: the list commit fails; its client registration is not left behind', async () => {
			const w = await createSeeded();
			const secretsBefore = await w.allSecrets();
			w.storage.refuseListStore = true;

			await assert.rejects(w.dynamicStorage.storeClientRegistration('p2', AS, 'client-9', 'secret-9', 'Other', 0), /store refused/);

			assert.deepStrictEqual(w.listedClientIds(), [['p1', 'client-1']]);
			assert.strictEqual(await w.allSecrets(), secretsBefore, 'no client registration of p2 is stored');
		});

		test('registration: the commit and the restore both fail; a named error with fixed text; a removal still finds every identity', async () => {
			const w = await createSeeded();
			w.storage.refuseListStore = true;
			w.secrets.refuseSet = (key, value) => key === CREDENTIALS_KEY && value === PREVIOUS_CREDENTIALS;
			w.log.lines.length = 0;
			w.log.errors.length = 0;

			await assert.rejects(w.dynamicStorage.storeClientRegistration('p1', AS, 'client-2', 'secret-2', 'Label', 0), (e: unknown) => {
				assert.ok(e instanceof Error);
				assert.strictEqual(e.name, 'DynamicAuthRegistrationRecoveryError');
				assert.strictEqual(e.cause, undefined);
				assert.ok(!/secret-[12]|refused/.test(e.message), e.message);
				assert.ok(e.message.includes('Remove Dynamic Authentication Providers'), e.message);
				return true;
			});
			assert.strictEqual(w.log.errors.length, 1, w.log.lines.join('\n'));
			assert.ok(w.log.argumentTexts.every(text => !/secret-[12]|refused/.test(text)), w.log.lines.join('\n'));

			// The list names client-1 and the client registration client-2: the removal deletes the sessions of both.
			w.storage.refuseListStore = false;
			w.secrets.refuseSet = () => false;
			await w.secrets.set(sessionsKey('client-2'), SESSIONS_VALUE);
			await w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing);
			assert.deepStrictEqual(await w.secrets.keys(), []);
			assert.deepStrictEqual(w.listedClientIds(), []);
		});

		function isRecoveryError(e: unknown): boolean {
			assert.ok(e instanceof Error, `expected an error, got ${e}`);
			assert.strictEqual(e.name, 'DynamicAuthRegistrationRecoveryError');
			return true;
		}

		// review-c2 M1: a replacement whose commit and restore both fail, then a successful replacement. The client ID of the
		// first registration stays recorded, so the removal deletes the sessions stored under it.
		test('replacement: commit and restore fail, a later replacement succeeds; the removal deletes the sessions of every client ID', async () => {
			const w = await createSeeded();
			w.storage.refuseListStore = true;
			w.secrets.refuseSet = (key, value) => key === CREDENTIALS_KEY && value === PREVIOUS_CREDENTIALS;
			await assert.rejects(w.dynamicStorage.storeClientRegistration('p1', AS, 'client-2', 'secret-2', 'Label', 0), isRecoveryError);
			assert.deepStrictEqual(w.listedClientIds(), [['p1', 'client-1']]);
			assert.strictEqual(await w.secrets.get(CREDENTIALS_KEY), NEW_CREDENTIALS_VALUE, 'the list names client-1 and the client registration client-2');

			w.storage.refuseListStore = false;
			w.secrets.refuseSet = () => false;
			await w.dynamicStorage.storeClientRegistration('p1', AS, 'client-3', 'secret-3', 'Label', 0);
			await w.dynamicStorage.setSessionsForDynamicAuthProvider('p1', 'client-3', JSON.parse(SESSIONS_VALUE));
			assert.deepStrictEqual(w.listedClientIds(), [['p1', 'client-3']], 'the later replacement is committed');

			await w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing);

			assert.deepStrictEqual(await w.secrets.keys(), [], 'no client registration and no session under client-1 or client-3 is left');
			assert.deepStrictEqual(w.listedClientIds(), []);
		});

		test('a first registration whose commit and rollback fail stays removable; its removal leaves nothing stored and nothing to remove', async () => {
			const w = await createSeeded();
			w.storage.refuseListStore = true;
			const p2Credentials = 'dynamicAuthProvider:clientRegistration:p2';
			w.secrets.refuseDelete.add(p2Credentials);

			await assert.rejects(w.dynamicStorage.storeClientRegistration('p2', AS, 'client-9', 'secret-9', 'Other', 0), isRecoveryError);

			assert.ok((await w.secrets.keys()).includes(p2Credentials), 'the client registration of p2 is stored');
			assert.deepStrictEqual(w.listedClientIds(), [['p1', 'client-1']], 'the list has no entry for p2');
			assert.deepStrictEqual(w.dynamicStorage.getRemovableProviders(), [
				{ providerId: 'p1', label: 'Label', clientIds: ['client-1'] },
				{ providerId: 'p2', label: 'Other', clientIds: ['client-9'] },
			], 'the cleanup index names p2 and its client ID, and no secret');
			assert.ok(!w.storage.get(CLEANUP_INDEX_STORAGE_KEY, StorageScope.APPLICATION)!.includes('secret-'), 'the cleanup index holds no client secret');

			w.storage.refuseListStore = false;
			w.secrets.refuseDelete.clear();
			await w.dynamicStorage.removeDynamicProvider('p2', unregisterNothing);
			assert.ok(!(await w.secrets.keys()).includes(p2Credentials));
			assert.deepStrictEqual(w.dynamicStorage.getRemovableProviders().map(p => p.providerId), ['p1']);
		});

		test('the cleanup index is written before the client registration: a refused index write writes nothing', async () => {
			const w = await createSeeded();
			const listBefore = w.list();
			const secretsBefore = await w.allSecrets();
			w.storage.refuseIndexStore = true;

			await assert.rejects(w.dynamicStorage.storeClientRegistration('p1', AS, 'client-2', 'secret-2', 'Label', 0), /store refused/);

			assert.strictEqual(w.list(), listBefore);
			assert.strictEqual(await w.allSecrets(), secretsBefore, 'no secret is written');
		});

		test('removal: the cleanup index entry is removed last; when its write fails, the provider stays removable and a retry completes', async () => {
			const w = await createSeeded();
			w.storage.refuseIndexStore = true;

			await assert.rejects(w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing), /store refused/);
			assert.deepStrictEqual(await w.secrets.keys(), [], 'every secret is deleted');
			assert.deepStrictEqual(w.dynamicStorage.getRemovableProviders().map(p => p.providerId), ['p1'], 'the provider is still found');
			assert.strictEqual(w.dynamicStorage.getRemovalCount('p1'), 0, 'a failed removal is not a completed one');

			w.storage.refuseIndexStore = false;
			await w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing);
			assert.deepStrictEqual(w.dynamicStorage.getRemovableProviders(), []);
			assert.strictEqual(w.dynamicStorage.getRemovalCount('p1'), 1);
		});

		test('an unreadable cleanup index: registration and removal reject, named, and write nothing', async () => {
			const w = await createSeeded();
			w.storage.store(CLEANUP_INDEX_STORAGE_KEY, `[{"providerId":"p1","label":"Label","clientIds":"${CREDENTIAL_MARKER}"}]`, StorageScope.APPLICATION, StorageTarget.MACHINE);
			const listBefore = w.list();
			const secretsBefore = await w.allSecrets();
			const isNamed = (e: unknown) => {
				assert.ok(e instanceof InvalidStoredProviderListError, `expected InvalidStoredProviderListError, got ${e}`);
				assert.strictEqual(e.storageKey, CLEANUP_INDEX_STORAGE_KEY);
				assert.strictEqual(e.reason, 'entry 0 field clientIds is not a list of strings (string)');
				assert.ok(errorTexts(e).every(text => !text.includes(CREDENTIAL_MARKER)));
				return true;
			};

			await assert.rejects(w.dynamicStorage.storeClientRegistration('p1', AS, 'client-2', 'secret-2', 'Label', 0), isNamed);
			await assert.rejects(w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing), isNamed);
			assert.throws(() => w.dynamicStorage.getRemovableProviders(), isNamed);

			assert.strictEqual(w.list(), listBefore);
			assert.strictEqual(await w.allSecrets(), secretsBefore);
			assert.ok(w.log.argumentTexts.every(text => !text.includes(CREDENTIAL_MARKER)));
		});

		// review-c2 M2 (storage side): a registration begun before a removal of the provider completed is refused, named, and
		// writes nothing; one begun after it is saved.
		test('a registration begun before a completed removal is refused and writes nothing; one begun after it is saved', async () => {
			const w = await createSeeded();
			const begun = w.dynamicStorage.getRemovalCount('p1');
			await w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing);
			assert.strictEqual(w.dynamicStorage.getRemovalCount('p1'), begun + 1);
			assert.strictEqual(w.dynamicStorage.getRemovalCount('p2'), 0, 'counted per provider');

			await assert.rejects(w.dynamicStorage.storeClientRegistration('p1', AS, 'client-1', 'secret-1', 'Label', begun), (e: unknown) => {
				assert.ok(e instanceof Error);
				assert.strictEqual(e.name, 'DynamicAuthProviderRemovedError');
				assert.ok(!/p1|client-1|secret-1/.test(e.message), e.message);
				return true;
			});
			assert.deepStrictEqual(await w.secrets.keys(), []);
			assert.strictEqual(w.list(), '[]');
			assert.deepStrictEqual(w.dynamicStorage.getRemovableProviders(), []);

			await w.dynamicStorage.storeClientRegistration('p1', AS, 'client-2', 'secret-2', 'Label', w.dynamicStorage.getRemovalCount('p1'));
			assert.deepStrictEqual(w.listedClientIds(), [['p1', 'client-2']]);
		});

		// review-c3 M2 (storage side): the count advance and the unregistration are one boundary, so no registration can read
		// the new count before the unregistration is dispatched. A removal that rejects does not unregister.
		test('the unregistration runs once, in the step that advances the removal count, after its stored identities are removed; a rejected removal does not run it', async () => {
			const w = await createSeeded();
			const atUnregistration: { count: number; removable: string[] }[] = [];
			const unregister = () => {
				// Synchronous: what a registration beginning in this step would read.
				atUnregistration.push({ count: w.dynamicStorage.getRemovalCount('p1'), removable: w.dynamicStorage.getRemovableProviders().map(p => p.providerId) });
			};
			w.storage.refuseIndexStore = true;
			await assert.rejects(w.dynamicStorage.removeDynamicProvider('p1', unregister), /store refused/);
			assert.deepStrictEqual(atUnregistration, [], 'a rejected removal does not unregister');

			w.storage.refuseIndexStore = false;
			await w.dynamicStorage.removeDynamicProvider('p1', unregister);
			assert.deepStrictEqual(atUnregistration, [{ count: 1, removable: [] }]);
			assert.deepStrictEqual(await w.secrets.keys(), []);
		});

		for (const [name, refused] of [['the session deletion', SESSIONS_KEY], ['the credential deletion', CREDENTIALS_KEY]] as const) {
			test(`removal: ${name} fails; the list entry (the cleanup identity) is kept; a retry removes every stored credential`, async () => {
				const w = await createSeeded();
				w.secrets.refuseDelete.add(refused);

				await assert.rejects(w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing), /delete refused/);

				assert.deepStrictEqual(w.listedClientIds(), [['p1', 'client-1']], 'the provider can still be found for a retry');
				assert.strictEqual(await w.secrets.get(CREDENTIALS_KEY), PREVIOUS_CREDENTIALS, 'the client registration is still stored');

				w.secrets.refuseDelete.clear();
				await w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing);
				assert.deepStrictEqual(await w.secrets.keys(), [], 'no session and no client registration is left');
				assert.deepStrictEqual(w.listedClientIds(), []);
			});
		}

		test('removal deletes the sessions stored under the list entry\'s and the client registration\'s client IDs', async () => {
			const w = await createSeeded();
			// A registration written before a failed commit (an earlier version, or a crash): the identities differ.
			await w.secrets.set(CREDENTIALS_KEY, NEW_CREDENTIALS_VALUE);
			await w.secrets.set(sessionsKey('client-2'), SESSIONS_VALUE);

			await w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing);

			assert.deepStrictEqual(await w.secrets.keys(), []);
			assert.deepStrictEqual(w.listedClientIds(), []);
		});

		test('removal of an unreadable client registration: it is deleted, named in a fixed log line without its text', async () => {
			const w = await createSeeded();
			await w.secrets.set(CREDENTIALS_KEY, `{"clientSecret":"${CREDENTIAL_MARKER}"`);
			w.log.lines.length = 0;

			await w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing);

			assert.deepStrictEqual(await w.secrets.keys(), []);
			assert.deepStrictEqual(w.listedClientIds(), []);
			assert.ok(w.log.lines.some(line => line.includes('not readable')), w.log.lines.join('\n'));
			assert.ok(w.log.argumentTexts.every(text => !text.includes(CREDENTIAL_MARKER)));
		});

		function isNotRegistered(e: unknown): boolean {
			assert.ok(e instanceof Error, `expected an error, got ${e}`);
			assert.strictEqual(e.name, 'DynamicAuthProviderNotRegisteredError');
			assert.ok(!e.message.includes('p1') && !e.message.includes('client-1') && !e.message.includes(SESSION_MARKER), e.message);
			return true;
		}

		test('a session write after the removal completed is rejected, named, and recreates no stored session', async () => {
			const w = await createSeeded();
			await w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing);

			await assert.rejects(w.dynamicStorage.setSessionsForDynamicAuthProvider('p1', 'client-1', JSON.parse(SESSIONS_VALUE)), isNotRegistered);

			assert.deepStrictEqual(await w.secrets.keys(), []);
		});

		test('a session write that arrives during the removal waits for it and is rejected', async () => {
			const w = await createSeeded();
			const removal = w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing);
			const write = w.dynamicStorage.setSessionsForDynamicAuthProvider('p1', 'client-1', JSON.parse(SESSIONS_VALUE));

			await removal;
			await assert.rejects(write, isNotRegistered);
			assert.deepStrictEqual(await w.secrets.keys(), []);
		});

		test('a session write for a client ID the provider is not registered under is rejected', async () => {
			const w = await createSeeded();
			const secretsBefore = await w.allSecrets();

			await assert.rejects(w.dynamicStorage.setSessionsForDynamicAuthProvider('p1', 'client-9', JSON.parse(SESSIONS_VALUE)), isNotRegistered);

			assert.strictEqual(await w.allSecrets(), secretsBefore);
		});

		test('when the removal fails, the registration stays usable: a session write is saved', async () => {
			const w = await createSeeded();
			w.secrets.refuseDelete.add(SESSIONS_KEY);
			await assert.rejects(w.dynamicStorage.removeDynamicProvider('p1', unregisterNothing), /delete refused/);

			await w.dynamicStorage.setSessionsForDynamicAuthProvider('p1', 'client-1', [{ access_token: 'at-new', token_type: 'Bearer', created_at: 2 }]);

			assert.deepStrictEqual((await w.dynamicStorage.getSessionsForDynamicAuthProvider('p1', 'client-1'))?.map(t => t.access_token), ['at-new']);
		});
	});

	suite('stored list is valid', () => {
		test('a legacy entry with issuer and no authorizationServer migrates', async () => {
			storeRaw(JSON.stringify([{ providerId: 'legacy', label: 'Legacy', issuer: 'https://issuer.example', clientId: 'client-legacy' }]));
			const providers = service.getInteractedProviders();
			assert.strictEqual(providers.length, 1);
			assert.strictEqual(providers[0].authorizationServer, 'https://issuer.example');
			assert.strictEqual(service.getClientId('legacy'), 'client-legacy');
			assert.deepStrictEqual(await service.getClientRegistration('legacy'), { clientId: 'client-legacy' });
			assert.deepStrictEqual(logService.errors, []);
		});
	});
});

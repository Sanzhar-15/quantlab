/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { InvalidStoredSecretError } from '../../../../../platform/secrets/common/secrets.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TestProductService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { getCurrentAuthenticationSessionInfo } from '../../browser/authenticationService.js';
import { DynamicAuthenticationProviderStorageService } from '../../browser/dynamicAuthenticationProviderStorageService.js';

const marker = 'secret-marker-text';

function describeLogArgument(argument: unknown): string {
	if (argument instanceof Error) {
		return `${argument.name}: ${argument.message} cause=${describeLogArgument(argument.cause)}`;
	}
	return typeof argument === 'string' ? argument : String(JSON.stringify(argument));
}

/** Records every log call at every level, trace to critical, with errors described by message and cause. */
class RecordingLogService extends NullLogService {
	readonly logged: string[] = [];
	private _record(message: string | Error, args: unknown[]): void {
		this.logged.push(describeLogArgument(message), ...args.map(describeLogArgument));
	}
	override trace(message: string, ...args: unknown[]): void { this._record(message, args); }
	override debug(message: string, ...args: unknown[]): void { this._record(message, args); }
	override info(message: string, ...args: unknown[]): void { this._record(message, args); }
	override warn(message: string, ...args: unknown[]): void { this._record(message, args); }
	override error(message: string | Error, ...args: unknown[]): void { this._record(message, args); }
	override critical(message: string | Error, ...args: unknown[]): void { this._record(message, args); }
}

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

// A stored secret that cannot be read is kept and the read rejects, naming the key and never quoting the value (F-SECRETS-1).
suite('Authentication - stored secrets that cannot be read', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// The error names the key, never quotes the value in its message, and carries no cause (a parse error would quote the value).
	function invalid(key: string, notQuoting: string) {
		return (e: unknown) => e instanceof InvalidStoredSecretError && e.key === key && !e.message.includes(notQuoting) && e.cause === undefined;
	}

	suite('DynamicAuthenticationProviderStorageService', () => {
		let secrets: CountingSecretStorageService;
		let storageService: TestStorageService;
		const sessionsKey = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: 'p1', clientId: 'c1' });
		const registrationKey = 'dynamicAuthProvider:clientRegistration:p1';

		setup(() => {
			secrets = new CountingSecretStorageService();
			storageService = store.add(new TestStorageService());
		});

		// Seeded before construction so the secret-change listener does not read the bad values.
		function createService(logService: ILogService = new NullLogService()): DynamicAuthenticationProviderStorageService {
			return store.add(new DynamicAuthenticationProviderStorageService(storageService, secrets, logService));
		}

		async function assertRegistrationRejectedAndKept(stored: string, notQuoting: string = marker) {
			await secrets.seed(registrationKey, stored);
			const service = createService();
			await assert.rejects(service.getClientRegistration('p1'), invalid(registrationKey, notQuoting));
			assert.strictEqual(await secrets.get(registrationKey), stored);
			assert.strictEqual(secrets.setCalls, 0);
			assert.strictEqual(secrets.deleteCalls, 0);
		}

		async function assertSessionsRejectedAndKept(stored: string, notQuoting: string = marker) {
			await secrets.seed(sessionsKey, stored);
			const service = createService();
			await assert.rejects(service.getSessionsForDynamicAuthProvider('p1', 'c1'), invalid(sessionsKey, notQuoting));
			assert.strictEqual(await secrets.get(sessionsKey), stored);
			assert.strictEqual(secrets.setCalls, 0);
			assert.strictEqual(secrets.deleteCalls, 0);
		}

		test('a client registration that is not JSON rejects and is kept', async () => {
			await assertRegistrationRejectedAndKept('secret-text {', 'secret-text');
		});

		test('a client registration with neither id nor secret rejects and is kept', async () => {
			await assertRegistrationRejectedAndKept('{"other":"secret-text"}', 'secret-text');
		});

		test('an empty client registration is present, not absent: it rejects and is kept', async () => {
			await assertRegistrationRejectedAndKept('');
		});

		for (const [label, stored] of [
			['a numeric client id', { clientId: 123, clientSecret: { value: marker } }],
			['a client secret that is an object', { clientId: 'c1', clientSecret: { value: marker } }],
			['a client secret that is a number', { clientId: 'c1', clientSecret: 5 }],
			['a client secret that is null', { clientId: 'c1', clientSecret: null }],
			['an empty client id', { clientId: '', clientSecret: marker }],
			['a client secret and no client id', { clientSecret: marker }],
			['null', null],
			['an array', [marker]],
			['a string', marker],
		] as [string, unknown][]) {
			test(`a client registration of the wrong type (${label}) rejects and is kept`, async () => {
				await assertRegistrationRejectedAndKept(JSON.stringify(stored));
			});
		}

		test('a valid client registration is returned; with and without a client secret', async () => {
			await secrets.seed(registrationKey, JSON.stringify({ clientId: 'c1', clientSecret: 'cs1' }));
			assert.deepStrictEqual(await createService().getClientRegistration('p1'), { clientId: 'c1', clientSecret: 'cs1' });
			await secrets.seed(registrationKey, JSON.stringify({ clientId: 'c1' }));
			assert.deepStrictEqual(await createService().getClientRegistration('p1'), { clientId: 'c1' });
		});

		test('an absent client registration reads from the provider list, or as undefined', async () => {
			const service = createService();
			assert.strictEqual(await service.getClientRegistration('p1'), undefined);
			storageService.store('dynamicAuthProviders', JSON.stringify([{ providerId: 'p1', label: 'P1', authorizationServer: 'https://a', clientId: 'c9' }]), StorageScope.APPLICATION, StorageTarget.MACHINE);
			assert.deepStrictEqual(await service.getClientRegistration('p1'), { clientId: 'c9' });
			assert.strictEqual(secrets.setCalls, 0);
			assert.strictEqual(secrets.deleteCalls, 0);
		});

		test('a stored session list that is not JSON rejects and is kept', async () => {
			await assertSessionsRejectedAndKept('tok-secret-text [', 'tok-secret-text');
		});

		test('a stored session list of the wrong shape rejects and is kept', async () => {
			await assertSessionsRejectedAndKept(JSON.stringify([{ access_token: 'tok-secret-text', created_at: 'not a number' }]), 'tok-secret-text');
		});

		test('an empty stored session list value is present, not absent: it rejects and is kept', async () => {
			await assertSessionsRejectedAndKept('');
		});

		const validSession = { access_token: 'tok', token_type: 'Bearer', created_at: 1 };
		for (const [label, stored] of [
			['a list with a null element', [null]],
			['a list with a valid and a null element', [validSession, null]],
			['a list with a string element', [marker]],
			['a list with an array element', [[marker]]],
			['an access token that is a number', [{ ...validSession, access_token: 5 }]],
			['a token type that is an object', [{ ...validSession, token_type: { value: marker } }]],
			['a refresh token that is an object', [{ ...validSession, refresh_token: { value: marker } }]],
			['an expiry that is a string', [{ ...validSession, expires_in: marker }]],
			['a scope that is a number', [{ ...validSession, scope: 5 }]],
			['an id token that is a number', [{ ...validSession, id_token: 5 }]],
			['an object instead of a list', { access_token: marker, token_type: 'Bearer', created_at: 1 }],
			['null', null],
		] as [string, unknown][]) {
			test(`a stored session list of the wrong type (${label}) rejects with the named error and is kept`, async () => {
				await assertSessionsRejectedAndKept(JSON.stringify(stored));
			});
		}

		test('valid stored sessions are returned; an absent list reads as undefined', async () => {
			const service = createService();
			assert.strictEqual(await service.getSessionsForDynamicAuthProvider('p1', 'c1'), undefined);
			const sessions = [{ ...validSession, refresh_token: 'r', expires_in: 60, scope: 's', id_token: 'i' }, validSession];
			await secrets.seed(sessionsKey, JSON.stringify(sessions));
			assert.deepStrictEqual(await service.getSessionsForDynamicAuthProvider('p1', 'c1'), sessions);
			assert.strictEqual(secrets.setCalls, 0);
			assert.strictEqual(secrets.deleteCalls, 0);
		});
	});

	suite('Authentication logs', () => {
		test('the recording logger records every level', () => {
			const logService = new RecordingLogService();
			logService.trace('t');
			logService.debug('d');
			logService.info('i');
			logService.warn('w');
			logService.error(new Error('e', { cause: new Error('c') }));
			logService.critical('x');
			assert.deepStrictEqual(logService.logged, ['t', 'd', 'i', 'w', 'Error: e cause=Error: c cause=undefined', 'x']);
		});

		test('storing sessions logs no token text at any level', async () => {
			const logService = new RecordingLogService();
			const service = store.add(new DynamicAuthenticationProviderStorageService(store.add(new TestStorageService()), new TestSecretStorageService(), logService));
			// As in production: sessions are saved only for a registered provider (an extension-host provider is installed
			// only after its registration is stored, under the same id and client ID).
			await service.storeClientRegistration('p1', 'https://as.example', 'c1', undefined, 'Label');
			await service.setSessionsForDynamicAuthProvider('p1', 'c1', [{ access_token: 'tok-secret-text', refresh_token: 'refresh-secret-text', token_type: 'Bearer', created_at: 1 }]);
			assert.deepStrictEqual((await service.getSessionsForDynamicAuthProvider('p1', 'c1'))?.map(t => t.access_token), ['tok-secret-text'], 'the sessions are saved');
			assert.ok(logService.logged.length > 0);
			assert.ok(logService.logged.every(line => !line.includes('tok-secret-text') && !line.includes('refresh-secret-text')), logService.logged.join(' | '));
		});

		test('reading stored values that cannot be read logs no stored text at any level', async () => {
			const logService = new RecordingLogService();
			const secrets = new TestSecretStorageService();
			const sessionsKey = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: 'p1', clientId: 'c1' });
			await secrets.set(sessionsKey, JSON.stringify([null, { access_token: marker }]));
			await secrets.set('dynamicAuthProvider:clientRegistration:p1', JSON.stringify({ clientId: 123, clientSecret: marker }));
			await secrets.set('deltaplus.loginAccount', JSON.stringify({ id: 'a', accessToken: marker, providerId: 5 }));
			const service = store.add(new DynamicAuthenticationProviderStorageService(store.add(new TestStorageService()), secrets, logService));

			await assert.rejects(service.getSessionsForDynamicAuthProvider('p1', 'c1'), InvalidStoredSecretError);
			await assert.rejects(service.getClientRegistration('p1'), InvalidStoredSecretError);
			await assert.rejects(getCurrentAuthenticationSessionInfo(secrets, { ...TestProductService, urlProtocol: 'deltaplus' }), InvalidStoredSecretError);
			assert.ok(logService.logged.every(line => !line.includes(marker)), logService.logged.join(' | '));
		});
	});

	suite('getCurrentAuthenticationSessionInfo', () => {
		const productService = { ...TestProductService, urlProtocol: 'deltaplus' };
		const key = 'deltaplus.loginAccount';

		async function assertRejectedAndKept(stored: string, notQuoting: string = marker) {
			const secrets = new CountingSecretStorageService();
			await secrets.seed(key, stored);
			await assert.rejects(getCurrentAuthenticationSessionInfo(secrets, productService), invalid(key, notQuoting));
			assert.strictEqual(await secrets.get(key), stored);
			assert.strictEqual(secrets.setCalls, 0);
			assert.strictEqual(secrets.deleteCalls, 0);
		}

		test('no stored session reads as undefined', async () => {
			assert.strictEqual(await getCurrentAuthenticationSessionInfo(new TestSecretStorageService(), productService), undefined);
		});

		test('a stored session that is not JSON rejects and is kept, without quoting it', async () => {
			await assertRejectedAndKept('access-token-text {', 'access-token-text');
		});

		test('a stored value that is not a session rejects and is kept', async () => {
			await assertRejectedAndKept('{"accessToken":"access-token-text"}', 'access-token-text');
		});

		test('an empty stored value is present, not absent: it rejects and is kept', async () => {
			await assertRejectedAndKept('');
		});

		for (const [label, stored] of [
			['null', null],
			['an array', [marker]],
			['a string', marker],
			['a session whose provider id is a number', { id: 'a', accessToken: marker, providerId: 5 }],
			['a session whose canSignOut is a string', { id: 'a', accessToken: marker, providerId: 'p', canSignOut: marker }],
		] as [string, unknown][]) {
			test(`a stored value of the wrong type (${label}) rejects and is kept`, async () => {
				await assertRejectedAndKept(JSON.stringify(stored));
			});
		}

		test('a valid stored session is returned, with and without canSignOut', async () => {
			const secrets = new TestSecretStorageService();
			await secrets.set(key, JSON.stringify({ id: 'a', accessToken: 't', providerId: 'p' }));
			assert.deepStrictEqual(await getCurrentAuthenticationSessionInfo(secrets, productService), { id: 'a', accessToken: 't', providerId: 'p' });
			await secrets.set(key, JSON.stringify({ id: 'a', accessToken: 't', providerId: 'p', canSignOut: false }));
			assert.deepStrictEqual(await getCurrentAuthenticationSessionInfo(secrets, productService), { id: 'a', accessToken: 't', providerId: 'p', canSignOut: false });
		});
	});
});

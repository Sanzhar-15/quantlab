/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { IAuthorizationServerMetadata, IAuthorizationTokenResponse } from '../../../../base/common/oauth.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogger, ILoggerService, NullLogger, NullLogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { TestSecretStorageService } from '../../../../platform/secrets/test/common/testSecretStorageService.js';
import { StorageScope } from '../../../../platform/storage/common/storage.js';
import { RemoveDynamicAuthenticationProvidersAction } from '../../../contrib/authentication/browser/actions/manageDynamicAuthenticationProvidersAction.js';
import { DynamicAuthenticationProviderStorageService } from '../../../services/authentication/browser/dynamicAuthenticationProviderStorageService.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IDynamicAuthenticationProviderStorageService } from '../../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { TestStorageService } from '../../../test/common/workbenchTestServices.js';
import { MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { DynamicAuthClientRejectedError, DynamicAuthProvider, DynamicAuthSessionExpiredError, DynamicAuthSessionPersistError, DynamicAuthSessionRefreshError, ExtHostAuthentication } from '../../common/extHostAuthentication.js';
import { IExtHostRpcService } from '../../common/extHostRpcService.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';

const AUTH_SERVER = 'https://auth.example.com';
const TOKEN_ENDPOINT = `${AUTH_SERVER}/token`;
const REGISTRATION_ENDPOINT = `${AUTH_SERVER}/register`;
const PLANTED = 'sk-live-PLANTED-7f3a9c';

/** A storage failure whose text holds a secret-looking value: only its class may reach a log line or an error. */
function plantedStorageError(): Error {
	const error = new Error(`keychain refused item ${PLANTED}`);
	error.name = 'KeychainError';
	return error;
}

type StoredToken = IAuthorizationTokenResponse & { created_at: number };

class TestDynamicAuthProvider extends DynamicAuthProvider {
	exchangeCode(): Promise<IAuthorizationTokenResponse> {
		return this.exchangeCodeForToken('auth-code', 'code-verifier', 'https://vscode.dev/redirect');
	}
	/** One sign-in flow that returns `token`. */
	useTokenFlow(token: IAuthorizationTokenResponse): void {
		this._createFlows.splice(0, this._createFlows.length, { label: 'Token', handler: async () => ({ ...token }) });
	}
	/** One sign-in flow that waits for `token`. */
	useDeferredFlow(token: () => Promise<IAuthorizationTokenResponse>): void {
		this._createFlows.splice(0, this._createFlows.length, { label: 'Deferred', handler: () => token() });
	}
	/** Two sign-in flows that both exchange a code, so a stop is told apart from "try a different way". */
	useCodeExchangeFlows(): void {
		this._createFlows.splice(0, this._createFlows.length,
			{ label: 'First', handler: () => this.exchangeCode() },
			{ label: 'Second', handler: () => this.exchangeCode() });
	}
}

class RecordingLogger extends NullLogger {
	readonly lines: string[] = [];
	readonly errors: string[] = [];
	override trace(message: string): void { this.lines.push(message); }
	override debug(message: string): void { this.lines.push(message); }
	override info(message: string): void { this.lines.push(message); }
	override warn(message: string): void { this.lines.push(message); }
	override error(message: string | Error): void { this.lines.push(String(message)); this.errors.push(String(message)); }
}

// F-SECRETS-3: a failed refresh or an invalid-client answer keeps the stored sessions and the client registration; the
// operation rejects, named. Only the explicit reset removes stored data, and only the selected provider's.
suite('ExtHostAuthentication - dynamic auth recovery keeps stored credentials', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let fetchStub: sinon.SinonStub;
	setup(() => {
		fetchStub = sinon.stub(globalThis, 'fetch');
	});
	teardown(() => {
		fetchStub.restore();
	});

	function respondWith(tokenEndpoint: () => Promise<Response>): void {
		fetchStub.callsFake(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === TOKEN_ENDPOINT) {
				return tokenEndpoint();
			}
			if (url === REGISTRATION_ENDPOINT) {
				return new Response(JSON.stringify({ client_id: 'client-2', client_secret: 'client-secret-2' }), { status: 201 });
			}
			return new Response('', { status: 404 });
		});
	}

	async function createProvider(initialTokens: StoredToken[], secrets: TestSecretStorageService = store.add(new TestSecretStorageService())) {
		const storageService = store.add(new TestStorageService());
		const dynamicStorage = store.add(new DynamicAuthenticationProviderStorageService(storageService, secrets, new NullLogService()));
		const calls = { continuePrompts: 0, registrationPrompts: 0, failPersistence: false, writes: 0 };
		const proxy: Partial<MainThreadAuthenticationShape> = {
			$setSessionsForDynamicAuthProvider: (providerId, clientId, sessions) => {
				calls.writes++;
				return calls.failPersistence
					? Promise.reject(plantedStorageError())
					: dynamicStorage.setSessionsForDynamicAuthProvider(providerId, clientId, sessions);
			},
			$showContinueNotification: async () => { calls.continuePrompts++; return false; },
			$promptForClientRegistration: async () => { calls.registrationPrompts++; return { clientId: 'client-typed' }; },
		};
		const serverMetadata: IAuthorizationServerMetadata = {
			issuer: AUTH_SERVER,
			response_types_supported: ['code'],
			token_endpoint: TOKEN_ENDPOINT,
			registration_endpoint: REGISTRATION_ENDPOINT,
		};
		const logger = new RecordingLogger();
		const emitter = store.add(new Emitter<{ authProviderId: string; clientId: string; tokens: StoredToken[] | undefined }>());
		const provider = new TestDynamicAuthProvider(
			{} as IExtHostWindow,
			{} as IExtHostUrlsService,
			{ environment: { appName: 'Test', appUriScheme: 'test' } } as unknown as IExtHostInitDataService,
			{ withProgressFromSource: (_source: unknown, _options: unknown, task: (progress: { report(): void }, token: CancellationToken) => Promise<unknown>) => task({ report() { } }, CancellationToken.None) } as unknown as IExtHostProgress,
			{ createLogger: (): ILogger => logger } as unknown as ILoggerService,
			proxy as MainThreadAuthenticationShape,
			URI.parse(AUTH_SERVER),
			serverMetadata,
			undefined,
			'client-1',
			'client-secret-1',
			emitter,
			initialTokens,
		);
		store.add({ dispose: () => provider.dispose() });
		await dynamicStorage.storeClientRegistration(provider.id, AUTH_SERVER, 'client-1', 'client-secret-1', 'Example');
		await dynamicStorage.setSessionsForDynamicAuthProvider(provider.id, 'client-1', initialTokens);
		const events: { added: string[]; removed: string[] }[] = [];
		store.add(provider.onDidChangeSessions(e => events.push({ added: (e.added ?? []).map(s => s.accessToken), removed: (e.removed ?? []).map(s => s.accessToken) })));
		const stored = async () => (await dynamicStorage.getSessionsForDynamicAuthProvider(provider.id, 'client-1'))!;
		const snapshot = async () => {
			await new Promise(resolve => setTimeout(resolve, 0)); // let any write that was started settle
			return JSON.stringify({
				providers: storageService.get('dynamicAuthProviders', StorageScope.APPLICATION),
				secrets: await Promise.all((await secrets.keys()).sort().map(async key => [key, await secrets.get(key)])),
			});
		};
		return { provider, snapshot, calls, logger, events, stored, dynamicStorage };
	}

	const expiredRefreshable: StoredToken = { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', scope: 'read', expires_in: 3600, created_at: 1 };

	function isNamed<T extends Error>(ctor: new (...args: never[]) => T, name: string) {
		return (e: unknown) => {
			assert.ok(e instanceof ctor, `expected ${name}, got ${e}`);
			assert.strictEqual(e.name, name);
			assert.ok(!/at-1|rt-1|client-secret/.test(e.message), 'the error carries no token and no secret');
			assert.ok(e.message.includes('Remove Dynamic Authentication Providers'), 'the error names the explicit reset');
			return true;
		};
	}

	for (const [name, tokenEndpoint] of [
		['the server refuses the refresh token', async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })],
		['the network fails', async () => { throw new TypeError('fetch failed'); }],
	] as const) {
		test(`a failed refresh (${name}) keeps the stored session and rejects, named`, async () => {
			respondWith(tokenEndpoint);
			const { provider, snapshot } = await createProvider([expiredRefreshable]);
			const before = await snapshot();

			await assert.rejects(provider.getSessions(['read'], {}), isNamed(DynamicAuthSessionRefreshError, 'DynamicAuthSessionRefreshError'));

			assert.strictEqual(await snapshot(), before, 'stored sessions and registration are byte-identical');
			assert.deepStrictEqual((await provider.getSessions(undefined, {})).map(s => s.accessToken), ['at-1'], 'the session is still offered for an explicit sign-out');
		});
	}

	test('invalid_client on refresh keeps the client registration and the session, and rejects as a client rejection; nothing is registered anew', async () => {
		respondWith(async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 }));
		const { provider, snapshot, calls, logger } = await createProvider([expiredRefreshable]);
		const before = await snapshot();

		// review-c1 S6: the rejection names the client-registration rejection, not a (possibly transient) refresh failure.
		await assert.rejects(provider.getSessions(['read'], {}), isNamed(DynamicAuthClientRejectedError, 'DynamicAuthClientRejectedError'));

		assert.strictEqual(await snapshot(), before);
		assert.strictEqual(provider.clientId, 'client-1');
		assert.strictEqual(provider.clientSecret, 'client-secret-1');
		assert.ok(fetchStub.getCalls().every(c => String(c.args[0]) !== REGISTRATION_ENDPOINT), 'no dynamic registration request');
		assert.strictEqual(calls.registrationPrompts, 0);
		// The diagnosis is fixed text that names the rejected client registration, logged once, without the response body.
		assert.deepStrictEqual(logger.errors, ['Failed to refresh token: the authorization server rejected the stored client registration (invalid_client).']);
		assert.ok(logger.lines.every(l => !l.includes('invalid_client"')), 'no response body in any log line');
	});

	test('invalid_client after a successful refresh: the rotation is saved first, then the client rejection is reported; no later refresh is tried', async () => {
		const responses = [
			() => new Response(JSON.stringify(rotated), { status: 200 }),
			() => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }),
		];
		respondWith(async () => responses.shift()!());
		const second: StoredToken = { access_token: 'at-b', refresh_token: 'rt-b', token_type: 'Bearer', scope: 'read', expires_in: 3600, created_at: 1 };
		const third: StoredToken = { access_token: 'at-c', refresh_token: 'rt-c', token_type: 'Bearer', scope: 'read', expires_in: 3600, created_at: 1 };
		const { provider, stored, logger } = await createProvider([expiredRefreshable, second, third]);

		await assert.rejects(provider.getSessions(['read'], {}), isNamed(DynamicAuthClientRejectedError, 'DynamicAuthClientRejectedError'));

		assert.strictEqual(fetchStub.callCount, 2, 'no refresh is tried after the client registration is rejected');
		assert.deepStrictEqual((await stored()).map(t => [t.access_token, t.refresh_token]).sort(), [['at-2', 'rt-2'], ['at-b', 'rt-b'], ['at-c', 'rt-c']], 'the rotation is saved; the others are kept');
		assert.deepStrictEqual(logger.errors, ['Failed to refresh token: the authorization server rejected the stored client registration (invalid_client).']);
	});

	test('a transient refresh failure stays distinguishable from a client rejection', async () => {
		respondWith(async () => new Response(JSON.stringify({ error: 'temporarily_unavailable' }), { status: 503 }));
		const { provider, logger } = await createProvider([expiredRefreshable]);

		await assert.rejects(provider.getSessions(['read'], {}), isNamed(DynamicAuthSessionRefreshError, 'DynamicAuthSessionRefreshError'));

		assert.ok(logger.errors.length > 0 && logger.errors.every(l => !l.includes('rejected the stored client registration')), logger.errors.join('\n'));
	});

	test('invalid_client on code exchange keeps the client registration and stops sign-in, named', async () => {
		respondWith(async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 200 }));
		const { provider, snapshot, calls } = await createProvider([]);
		const before = await snapshot();
		provider.useCodeExchangeFlows();

		await assert.rejects(provider.createSession(['read'], {}), isNamed(DynamicAuthClientRejectedError, 'DynamicAuthClientRejectedError'));

		assert.strictEqual(await snapshot(), before);
		assert.strictEqual(provider.clientId, 'client-1');
		assert.strictEqual(calls.continuePrompts, 0, 'no "try a different way": every flow uses the same registration');
		assert.strictEqual(calls.registrationPrompts, 0);
		assert.ok(fetchStub.getCalls().every(c => String(c.args[0]) !== REGISTRATION_ENDPOINT), 'no dynamic registration request');
	});

	test('a refreshed session that cannot be saved rejects, named, after one error line without token text', async () => {
		respondWith(async () => new Response(JSON.stringify({ access_token: 'at-2', refresh_token: 'rt-2', token_type: 'Bearer', scope: 'read', expires_in: 3600 }), { status: 200 }));
		const { provider, snapshot, calls, logger } = await createProvider([expiredRefreshable]);
		const before = await snapshot();
		calls.failPersistence = true;

		await assert.rejects(provider.getSessions(['read'], {}), (e: unknown) => {
			assert.ok(e instanceof DynamicAuthSessionPersistError, `expected DynamicAuthSessionPersistError, got ${e}`);
			assert.ok(!/at-[12]|rt-[12]/.test(e.message) && !e.message.includes(PLANTED), 'the error carries no token and no storage error text');
			assert.strictEqual(e.cause, undefined, 'no cause carries the storage error');
			return true;
		});

		assert.strictEqual(logger.errors.length, 1, logger.errors.join('\n'));
		// review QL-G-LOGIN-SECRETS c1 M5: the storage error's name is foreign text too; a fixed category is logged instead.
		assert.strictEqual(logger.errors[0], 'Failed to save 1 token(s) to secret storage: the secret storage did not accept the write');
		for (const line of logger.lines) {
			assert.ok(!/at-[12]|rt-[12]/.test(line), `a log line holds token text: ${line}`);
			assert.ok(!line.includes(PLANTED), `a log line holds the storage error text: ${line}`);
		}
		assert.strictEqual(await snapshot(), before, 'the stored sessions are untouched by the failed save');
	});

	// MUST-3: a change that failed to save stays pending; no completed-change event; the next operation saves it first.
	const rotated = { access_token: 'at-2', refresh_token: 'rt-2', token_type: 'Bearer', scope: 'read', expires_in: 3600 };

	function isPersistError(e: unknown): boolean {
		assert.ok(e instanceof DynamicAuthSessionPersistError, `expected DynamicAuthSessionPersistError, got ${e}`);
		return true;
	}

	test('refresh with a rotated refresh token, save fails once: no event; the next read saves it before succeeding; it survives a restart', async () => {
		respondWith(async () => new Response(JSON.stringify(rotated), { status: 200 }));
		const { provider, calls, events, stored } = await createProvider([expiredRefreshable]);

		calls.failPersistence = true;
		await assert.rejects(provider.getSessions(['read'], {}), isPersistError);
		assert.deepStrictEqual(events, [], 'a failed save publishes no completed change');
		assert.deepStrictEqual((await stored()).map(t => [t.access_token, t.refresh_token]), [['at-1', 'rt-1']]);

		calls.failPersistence = false;
		const writes = calls.writes;
		assert.deepStrictEqual((await provider.getSessions(['read'], {})).map(s => s.accessToken), ['at-2']);
		assert.strictEqual(calls.writes, writes + 1, 'the pending change is written again');
		assert.strictEqual(fetchStub.callCount, 1, 'the rotated refresh token is kept: no second refresh with the spent one');
		assert.deepStrictEqual((await stored()).map(t => [t.access_token, t.refresh_token]), [['at-2', 'rt-2']], 'durable state matches the reported result');
		assert.deepStrictEqual(events, [{ added: ['at-2'], removed: ['at-1'] }]);

		const restarted = await createProvider(await stored());
		assert.deepStrictEqual((await restarted.provider.getSessions(['read'], {})).map(s => s.accessToken), ['at-2'], 'after a restart');
		assert.strictEqual(fetchStub.callCount, 1);
	});

	test('sign-in whose save fails once: rejects, no event; the next read saves it before succeeding; it survives a restart', async () => {
		respondWith(async () => { throw new Error('no token request is expected'); });
		const { provider, calls, events, stored } = await createProvider([]);
		provider.useTokenFlow(rotated);

		calls.failPersistence = true;
		await assert.rejects(provider.createSession(['read'], {}), isPersistError);
		assert.deepStrictEqual(events, []);
		assert.deepStrictEqual(await stored(), []);

		calls.failPersistence = false;
		const writes = calls.writes;
		assert.deepStrictEqual((await provider.getSessions(['read'], {})).map(s => s.accessToken), ['at-2']);
		assert.strictEqual(calls.writes, writes + 1);
		assert.deepStrictEqual((await stored()).map(t => t.access_token), ['at-2']);
		assert.deepStrictEqual(events, [{ added: ['at-2'], removed: [] }]);

		const restarted = await createProvider(await stored());
		assert.deepStrictEqual((await restarted.provider.getSessions(['read'], {})).map(s => s.accessToken), ['at-2']);
	});

	test('sign-out whose save fails once: rejects, no event; a retried sign-out stores the removal before succeeding; it survives a restart', async () => {
		respondWith(async () => { throw new Error('no token request is expected'); });
		const { provider, calls, events, stored } = await createProvider([{ ...rotated, created_at: Date.now() }]);
		const [session] = await provider.getSessions(undefined, {});

		calls.failPersistence = true;
		await assert.rejects(provider.removeSession(session.id), isPersistError);
		assert.deepStrictEqual(events, []);
		assert.deepStrictEqual((await stored()).map(t => t.access_token), ['at-2']);

		calls.failPersistence = false;
		const writes = calls.writes;
		await provider.removeSession(session.id);
		assert.strictEqual(calls.writes, writes + 1, 'the retried sign-out writes the removal');
		// F-SECRETS-6: an empty list is stored as one record of its bookkeeping (session_list_record), not as a session.
		assert.deepStrictEqual((await stored()).filter(t => !(t as { session_list_record?: boolean }).session_list_record), [], 'durable state matches the reported result');
		assert.deepStrictEqual(events, [{ added: [], removed: ['at-2'] }]);

		const restarted = await createProvider(await stored());
		assert.deepStrictEqual(await restarted.provider.getSessions(undefined, {}), [], 'the session does not return after a restart');
	});

	test('a non-refreshable token: still valid, it stays usable; expired, it stays stored and the read rejects, named', async () => {
		respondWith(async () => { throw new Error('no refresh is expected'); });
		const now = Date.now();
		const { provider, snapshot } = await createProvider([
			{ access_token: 'at-valid', token_type: 'Bearer', scope: 'a', expires_in: 120, created_at: now },
			{ access_token: 'at-expired', token_type: 'Bearer', scope: 'b', expires_in: 60, created_at: now - 3600 * 1000 },
		]);
		const before = await snapshot();

		assert.deepStrictEqual((await provider.getSessions(['a'], {})).map(s => s.accessToken), ['at-valid'], 'a still-valid token stays usable');
		await assert.rejects(provider.getSessions(['b'], {}), (e: unknown) => {
			assert.ok(e instanceof DynamicAuthSessionExpiredError, `expected DynamicAuthSessionExpiredError, got ${e}`);
			assert.ok(e.message.includes('Remove Dynamic Authentication Providers') && !e.message.includes('at-expired'), e.message);
			return true;
		});

		assert.strictEqual(await snapshot(), before, 'both stored copies are byte-identical');
		assert.strictEqual(fetchStub.callCount, 0);
	});

	test('a refresh response without a refresh token keeps the stored one; a returned replacement is used', async () => {
		const responses = [
			{ access_token: 'at-2', token_type: 'Bearer', scope: 'read', expires_in: 60 },
			{ access_token: 'at-3', refresh_token: 'rt-3', token_type: 'Bearer', scope: 'read', expires_in: 3600 },
		];
		respondWith(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
		const { provider, stored } = await createProvider([expiredRefreshable]);

		assert.deepStrictEqual((await provider.getSessions(['read'], {})).map(s => s.accessToken), ['at-2']);
		assert.deepStrictEqual((await stored()).map(t => [t.access_token, t.refresh_token]), [['at-2', 'rt-1']], 'the stored refresh token is kept');

		// at-2 expires within five minutes, so the next read refreshes again with the kept refresh token.
		assert.deepStrictEqual((await provider.getSessions(['read'], {})).map(s => s.accessToken), ['at-3']);
		const refreshBodies = fetchStub.getCalls().map(c => new URLSearchParams(String(c.args[1]?.body)).get('refresh_token'));
		assert.deepStrictEqual(refreshBodies, ['rt-1', 'rt-1']);
		assert.deepStrictEqual((await stored()).map(t => [t.access_token, t.refresh_token]), [['at-3', 'rt-3']], 'a returned replacement is used');
	});

	for (const status of [400, 401]) {
		test(`invalid_client with HTTP ${status} on code exchange stops sign-in, named; no next flow; the registration is kept`, async () => {
			respondWith(async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'client-secret-in-body' }), { status }));
			const { provider, snapshot, calls } = await createProvider([]);
			const before = await snapshot();
			provider.useCodeExchangeFlows();

			await assert.rejects(provider.createSession(['read'], {}), isNamed(DynamicAuthClientRejectedError, 'DynamicAuthClientRejectedError'));

			assert.strictEqual(fetchStub.getCalls().filter(c => String(c.args[0]) === TOKEN_ENDPOINT).length, 1, 'the second flow is not tried');
			assert.strictEqual(calls.continuePrompts, 0);
			assert.strictEqual(calls.registrationPrompts, 0);
			assert.strictEqual(provider.clientId, 'client-1');
			assert.strictEqual(await snapshot(), before);
		});
	}

	// F-SECRETS-3 item-7 class: a failed dynamic registration is logged by class, never with the response body.
	test('a failed dynamic client registration logs no response body', async () => {
		const M = 'MARKER-REGISTRATION-2f9';
		fetchStub.callsFake(async () => new Response(JSON.stringify({ error: 'invalid_client_metadata', error_description: M }), { status: 400 }));
		const lines: string[] = [];
		class RecordingLogService extends NullLogService {
			override trace(message: string): void { lines.push(message); }
			override debug(message: string): void { lines.push(message); }
			override info(message: string): void { lines.push(message); }
			override warn(message: string): void { lines.push(message); }
			override error(message: string | Error): void { lines.push(String(message)); }
		}
		const proxy: Partial<MainThreadAuthenticationShape> = { $promptForClientRegistration: async () => undefined };
		const auth = new ExtHostAuthentication(
			{ getProxy: () => proxy } as unknown as IExtHostRpcService,
			{ environment: { appName: 'Test', appUriScheme: 'test' } } as unknown as IExtHostInitDataService,
			{} as IExtHostWindow,
			{} as IExtHostUrlsService,
			{} as IExtHostProgress,
			{ createLogger: (): ILogger => new NullLogger() } as unknown as ILoggerService,
			store.add(new RecordingLogService()),
		);
		const serverMetadata: IAuthorizationServerMetadata = { issuer: AUTH_SERVER, response_types_supported: ['code'], registration_endpoint: REGISTRATION_ENDPOINT };

		await assert.rejects(auth.$registerDynamicAuthProvider(URI.parse(AUTH_SERVER).toJSON(), serverMetadata, undefined, undefined, undefined, undefined), /User did not provide client details/);

		assert.ok(lines.some(l => l.includes('Dynamic registration failed')), lines.join('\n'));
		for (const line of lines) {
			assert.ok(!line.includes(M), `a marker reached a log line: ${line}`);
		}
	});

	test('the explicit reset removes exactly the selected provider: its list entry, client registration and sessions', async () => {
		const storageService = store.add(new TestStorageService());
		const secrets = store.add(new TestSecretStorageService());
		const dynamicStorage = store.add(new DynamicAuthenticationProviderStorageService(storageService, secrets, new NullLogService()));
		for (const [id, clientId] of [['provider-a', 'client-a'], ['provider-b', 'client-b']]) {
			await dynamicStorage.storeClientRegistration(id, `https://${id}.example.com`, clientId, `${clientId}-secret`, id);
			await dynamicStorage.setSessionsForDynamicAuthProvider(id, clientId, [{ access_token: `${id}-token`, token_type: 'Bearer', created_at: 1 }]);
		}
		const keptKeys = [`dynamicAuthProvider:clientRegistration:provider-b`, JSON.stringify({ isDynamicAuthProvider: true, authProviderId: 'provider-b', clientId: 'client-b' })];
		const keptBefore = await Promise.all(keptKeys.map(key => secrets.get(key)));
		const unregistered: string[] = [];
		const services = new Map<unknown, unknown>([
			[IQuickInputService, { pick: async (items: { provider: { providerId: string } }[]) => items.filter(i => i.provider.providerId === 'provider-a') }],
			[IDynamicAuthenticationProviderStorageService, dynamicStorage],
			[IAuthenticationService, { isAuthenticationProviderRegistered: () => true, unregisterAuthenticationProvider: (id: string) => { unregistered.push(id); } }],
			[IDialogService, { confirm: async () => ({ confirmed: true }) }],
		]);
		const accessor = { get: (id: unknown) => services.get(id) } as unknown as ServicesAccessor;

		await new RemoveDynamicAuthenticationProvidersAction().run(accessor);

		assert.deepStrictEqual(unregistered, ['provider-a']);
		assert.deepStrictEqual(dynamicStorage.getInteractedProviders().map(p => p.providerId), ['provider-b']);
		assert.deepStrictEqual((await secrets.keys()).sort(), keptKeys.slice().sort(), 'only provider-b secrets remain');
		assert.deepStrictEqual(await Promise.all(keptKeys.map(key => secrets.get(key))), keptBefore, 'provider-b is byte-identical');
	});

	// review-c1 M2: a removal that completes while a refresh or a sign-in of the same window is pending. The pending
	// operation's session write is rejected, so it returns no usable credential and recreates no stored session. A removal
	// that fails leaves the registration usable.
	suite('removal while an operation of the provider is pending', () => {
		/** A secret storage that can refuse a deletion. */
		class RefusingSecretStorageService extends TestSecretStorageService {
			readonly refuseDelete = new Set<string>();
			override async delete(key: string): Promise<void> {
				if (this.refuseDelete.has(key)) {
					throw new Error('delete refused');
				}
				return super.delete(key);
			}
		}

		function deferred<T>() {
			let resolve!: (value: T) => void;
			const promise = new Promise<T>(r => { resolve = r; });
			return { promise, resolve };
		}

		async function until(condition: () => boolean): Promise<void> {
			for (let i = 0; i < 100 && !condition(); i++) {
				await new Promise(resolve => setTimeout(resolve, 0));
			}
			assert.ok(condition(), 'the operation did not reach the deferred step');
		}

		const rotatedResponse = () => new Response(JSON.stringify(rotated), { status: 200 });

		async function createRemovable(initialTokens: StoredToken[]) {
			const secrets = store.add(new RefusingSecretStorageService());
			const world = await createProvider(initialTokens, secrets);
			const unregistered: string[] = [];
			const services = new Map<unknown, unknown>([
				[IQuickInputService, { pick: async (items: { provider: { providerId: string } }[]) => items }],
				[IDynamicAuthenticationProviderStorageService, world.dynamicStorage],
				[IAuthenticationService, { isAuthenticationProviderRegistered: () => true, unregisterAuthenticationProvider: (id: string) => { unregistered.push(id); } }],
				[IDialogService, { confirm: async () => ({ confirmed: true }) }],
			]);
			const accessor = { get: (id: unknown) => services.get(id) } as unknown as ServicesAccessor;
			const remove = () => new RemoveDynamicAuthenticationProvidersAction().run(accessor);
			const sessionsKey = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: world.provider.id, clientId: 'client-1' });
			return { ...world, secrets, unregistered, remove, sessionsKey };
		}

		function noUsableCredential(e: unknown): boolean {
			assert.ok(e instanceof DynamicAuthSessionPersistError, `expected DynamicAuthSessionPersistError, got ${e}`);
			assert.ok(!/at-2|rt-2/.test(e.message), e.message);
			return true;
		}

		test('a refresh released after the removal completed returns no usable credential and recreates no stored session', async () => {
			const gate = deferred<Response>();
			respondWith(() => gate.promise);
			const w = await createRemovable([expiredRefreshable]);
			const pending = w.provider.getSessions(['read'], {});
			await until(() => fetchStub.callCount === 1);

			await w.remove();
			assert.deepStrictEqual(await w.secrets.keys(), [], 'the removal deleted every stored credential');
			assert.deepStrictEqual(w.unregistered, [w.provider.id]);

			gate.resolve(rotatedResponse());
			await assert.rejects(pending, noUsableCredential);
			await assert.rejects(w.provider.getSessions(undefined, {}), noUsableCredential, 'a later read returns no credential either');
			assert.deepStrictEqual(await w.secrets.keys(), [], 'no stored session is recreated');
			assert.deepStrictEqual(w.dynamicStorage.getInteractedProviders(), []);
			assert.deepStrictEqual(w.events, [], 'no session is published');
		});

		test('a sign-in released after the removal completed returns no usable credential and recreates no stored session', async () => {
			respondWith(async () => { throw new Error('no token request is expected'); });
			const gate = deferred<IAuthorizationTokenResponse>();
			const w = await createRemovable([]);
			let flowStarted = false;
			w.provider.useDeferredFlow(() => { flowStarted = true; return gate.promise; });
			const pending = w.provider.createSession(['read'], {});
			await until(() => flowStarted);

			await w.remove();
			assert.deepStrictEqual(await w.secrets.keys(), []);

			gate.resolve({ ...rotated });
			await assert.rejects(pending, noUsableCredential);
			assert.deepStrictEqual(await w.secrets.keys(), [], 'no stored session is recreated');
			assert.deepStrictEqual(w.events, []);
		});

		test('a removal that fails while a refresh is pending keeps the registration usable; the refresh is saved; a retried removal removes it', async () => {
			const gate = deferred<Response>();
			respondWith(() => gate.promise);
			const w = await createRemovable([expiredRefreshable]);
			const pending = w.provider.getSessions(['read'], {});
			await until(() => fetchStub.callCount === 1);
			w.secrets.refuseDelete.add(w.sessionsKey);

			await assert.rejects(w.remove(), /delete refused/);
			assert.deepStrictEqual(w.unregistered, [], 'the provider stays registered');
			assert.deepStrictEqual(w.dynamicStorage.getInteractedProviders().map(p => p.clientId), ['client-1']);

			gate.resolve(rotatedResponse());
			assert.deepStrictEqual((await pending).map(s => s.accessToken), ['at-2'], 'the registration is still usable');
			assert.deepStrictEqual((await w.stored()).map(t => [t.access_token, t.refresh_token]), [['at-2', 'rt-2']]);

			w.secrets.refuseDelete.clear();
			await w.remove();
			assert.deepStrictEqual(await w.secrets.keys(), []);
			assert.deepStrictEqual(w.unregistered, [w.provider.id]);
		});
	});
});

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
import { DynamicAuthClientRejectedError, DynamicAuthProvider, DynamicAuthSessionRefreshError } from '../../common/extHostAuthentication.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';

const AUTH_SERVER = 'https://auth.example.com';
const TOKEN_ENDPOINT = `${AUTH_SERVER}/token`;
const REGISTRATION_ENDPOINT = `${AUTH_SERVER}/register`;

type StoredToken = IAuthorizationTokenResponse & { created_at: number };

class TestDynamicAuthProvider extends DynamicAuthProvider {
	exchangeCode(): Promise<IAuthorizationTokenResponse> {
		return this.exchangeCodeForToken('auth-code', 'code-verifier', 'https://vscode.dev/redirect');
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
	override info(message: string): void { this.lines.push(message); }
	override warn(message: string): void { this.lines.push(message); }
	override error(message: string | Error): void { this.lines.push(String(message)); }
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

	async function createProvider(initialTokens: StoredToken[]) {
		const storageService = store.add(new TestStorageService());
		const secrets = store.add(new TestSecretStorageService());
		const dynamicStorage = store.add(new DynamicAuthenticationProviderStorageService(storageService, secrets, new NullLogService()));
		const calls = { continuePrompts: 0, registrationPrompts: 0 };
		const proxy: Partial<MainThreadAuthenticationShape> = {
			$setSessionsForDynamicAuthProvider: (providerId, clientId, sessions) => dynamicStorage.setSessionsForDynamicAuthProvider(providerId, clientId, sessions),
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
		const emitter = store.add(new Emitter<{ authProviderId: string; clientId: string; tokens: StoredToken[] }>());
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
		// As in production (ExtHostAuthentication → $sendDidChangeDynamicProviderInfo → storeClientRegistration).
		store.add(provider.onDidChangeClientId(() => dynamicStorage.storeClientRegistration(provider.id, AUTH_SERVER, provider.clientId, provider.clientSecret)));
		await dynamicStorage.storeClientRegistration(provider.id, AUTH_SERVER, 'client-1', 'client-secret-1', 'Example');
		await dynamicStorage.setSessionsForDynamicAuthProvider(provider.id, 'client-1', initialTokens);
		const snapshot = async () => {
			await new Promise(resolve => setTimeout(resolve, 0)); // let any write that was started settle
			return JSON.stringify({
				providers: storageService.get('dynamicAuthProviders', StorageScope.APPLICATION),
				secrets: await Promise.all((await secrets.keys()).sort().map(async key => [key, await secrets.get(key)])),
			});
		};
		return { provider, snapshot, calls, logger };
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

	test('invalid_client on refresh keeps the client registration and the session; nothing is registered anew', async () => {
		respondWith(async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 }));
		const { provider, snapshot, calls, logger } = await createProvider([expiredRefreshable]);
		const before = await snapshot();

		await assert.rejects(provider.getSessions(['read'], {}), isNamed(DynamicAuthSessionRefreshError, 'DynamicAuthSessionRefreshError'));

		assert.strictEqual(await snapshot(), before);
		assert.strictEqual(provider.clientId, 'client-1');
		assert.strictEqual(provider.clientSecret, 'client-secret-1');
		assert.ok(fetchStub.getCalls().every(c => String(c.args[0]) !== REGISTRATION_ENDPOINT), 'no dynamic registration request');
		assert.strictEqual(calls.registrationPrompts, 0);
		assert.ok(logger.lines.some(l => l.includes('DynamicAuthClientRejectedError')), 'the refresh failure log names the rejected client');
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
});

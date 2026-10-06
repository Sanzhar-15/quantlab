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
import { ILoggerService, NullLogger } from '../../../../platform/log/common/log.js';
import { MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { DynamicAuthClientRejectedError } from '../../common/extHostAuthentication.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';
import { NodeDynamicAuthProvider } from '../../node/extHostAuthentication.js';

const AUTH_SERVER = 'https://auth.example.com';
const DEVICE_ENDPOINT = `${AUTH_SERVER}/device`;
const TOKEN_ENDPOINT = `${AUTH_SERVER}/token`;
const REGISTRATION_ENDPOINT = `${AUTH_SERVER}/register`;

// F-SECRETS-3: invalid_client in the device-code flow keeps the client registration; sign-in stops, named.
suite('NodeDynamicAuthProvider - device code invalid_client keeps the registration', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let fetchStub: sinon.SinonStub;
	setup(() => {
		fetchStub = sinon.stub(globalThis, 'fetch');
	});
	teardown(() => {
		fetchStub.restore();
	});

	function createNodeProvider(deviceEndpoint: () => Promise<Response>, tokenEndpoint: () => Promise<Response>) {
		fetchStub.callsFake(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === DEVICE_ENDPOINT) {
				return deviceEndpoint();
			}
			if (url === TOKEN_ENDPOINT) {
				return tokenEndpoint();
			}
			if (url === REGISTRATION_ENDPOINT) {
				return new Response(JSON.stringify({ client_id: 'client-2', client_secret: 'client-secret-2' }), { status: 201 });
			}
			return new Response('', { status: 404 });
		});
		const calls = { registrationPrompts: 0, continuePrompts: 0, clientIdChanges: 0 };
		const proxy: Partial<MainThreadAuthenticationShape> = {
			$showDeviceCodeModal: async () => true,
			$showContinueNotification: async () => { calls.continuePrompts++; return false; },
			$promptForClientRegistration: async () => { calls.registrationPrompts++; return { clientId: 'client-typed' }; },
			$setSessionsForDynamicAuthProvider: async () => { },
		};
		// No authorization_endpoint: the device code flow is the only sign-in flow.
		const serverMetadata: IAuthorizationServerMetadata = {
			issuer: AUTH_SERVER,
			response_types_supported: ['code'],
			token_endpoint: TOKEN_ENDPOINT,
			device_authorization_endpoint: DEVICE_ENDPOINT,
			registration_endpoint: REGISTRATION_ENDPOINT,
		};
		const emitter = store.add(new Emitter<{ authProviderId: string; clientId: string; tokens: (IAuthorizationTokenResponse & { created_at: number })[] }>());
		const provider = new NodeDynamicAuthProvider(
			{} as IExtHostWindow,
			{} as IExtHostUrlsService,
			{ environment: { appName: 'Test', appUriScheme: 'test' }, remote: { isRemote: false } } as unknown as IExtHostInitDataService,
			{ withProgressFromSource: (_source: unknown, _options: unknown, task: (progress: { report(): void }, token: CancellationToken) => Promise<unknown>) => task({ report() { } }, CancellationToken.None) } as unknown as IExtHostProgress,
			{ createLogger: () => new NullLogger() } as unknown as ILoggerService,
			proxy as MainThreadAuthenticationShape,
			URI.parse(AUTH_SERVER),
			serverMetadata,
			undefined,
			'client-1',
			'client-secret-1',
			emitter,
			[],
		);
		store.add({ dispose: () => provider.dispose() });
		// The client registration is stored only through this event (ExtHostAuthentication → storeClientRegistration).
		store.add(provider.onDidChangeClientId(() => { calls.clientIdChanges++; }));
		return { provider, calls };
	}

	function assertRejectedAndKept(e: unknown): boolean {
		assert.ok(e instanceof DynamicAuthClientRejectedError, `expected DynamicAuthClientRejectedError, got ${e}`);
		assert.ok(e.message.includes('Remove Dynamic Authentication Providers') && !e.message.includes('client-secret'), e.message);
		return true;
	}

	function assertRegistrationKept(provider: NodeDynamicAuthProvider, calls: { registrationPrompts: number; clientIdChanges: number }): void {
		assert.strictEqual(provider.clientId, 'client-1');
		assert.strictEqual(provider.clientSecret, 'client-secret-1');
		assert.strictEqual(calls.clientIdChanges, 0, 'the stored client registration is not replaced');
		assert.strictEqual(calls.registrationPrompts, 0);
		assert.ok(fetchStub.getCalls().every(c => String(c.args[0]) !== REGISTRATION_ENDPOINT), 'no dynamic registration request');
	}

	test('invalid_client while polling stops sign-in with DynamicAuthClientRejectedError and registers nothing anew', async () => {
		const { provider, calls } = createNodeProvider(
			async () => new Response(JSON.stringify({ device_code: 'dc', user_code: 'UC', verification_uri: `${AUTH_SERVER}/verify`, expires_in: 60, interval: 0.001 }), { status: 200 }),
			async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 }),
		);

		await assert.rejects(provider.createSession(['read'], {}), assertRejectedAndKept);

		assertRegistrationKept(provider, calls);
	});

	// review-c1 MUST-5: the initial device authorization request.
	for (const status of [400, 401]) {
		test(`invalid_client with HTTP ${status} on device authorization stops sign-in, named; the registration is kept`, async () => {
			const { provider, calls } = createNodeProvider(
				async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: 'client-secret-in-body' }), { status }),
				async () => { throw new Error('no token request is expected'); },
			);

			await assert.rejects(provider.createSession(['read'], {}), assertRejectedAndKept);

			assert.strictEqual(calls.continuePrompts, 0);
			assertRegistrationKept(provider, calls);
		});
	}
});

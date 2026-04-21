/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { QuantlabAuth } from '../../../browser/auth/quantlabAuth.js';
import { QicAuthUriHandler } from '../../../browser/auth/uriHandler.js';
import { MockCloudServer } from '../../integration/mockCloudServer.js';

const TEST_PORT = 3098;
const BASE_URL = `http://localhost:${TEST_PORT}`;

function makeAuthConfig() {
	return {
		authorizeUrl: `${BASE_URL}/v1/auth/authorize`,
		tokenUrl: `${BASE_URL}/v1/auth/token`,
		clientId: 'qic-vscode',
		redirectUri: 'vscode://quantlab.qic/auth/callback',
		scopes: ['qic:inference', 'qic:usage'],
	};
}

suite('QuantlabAuth', () => {
	let server: MockCloudServer;

	suiteSetup(async () => {
		server = new MockCloudServer();
		await server.start(TEST_PORT);
	});

	suiteTeardown(async () => {
		await server.stop();
	});

	// --- startAuthFlow ---

	test('startAuthFlow generates auth URL with PKCE params', async () => {
		const auth = new QuantlabAuth(makeAuthConfig());
		const { authUrl, state } = await auth.startAuthFlow();

		assert.ok(authUrl.startsWith(BASE_URL));
		assert.ok(authUrl.includes('code_challenge='));
		assert.ok(authUrl.includes('code_challenge_method=S256'));
		assert.ok(authUrl.includes('response_type=code'));
		assert.ok(authUrl.includes('client_id=qic-vscode'));
		assert.ok(authUrl.includes(`state=${state}`));
		assert.ok(authUrl.includes('scope=qic%3Ainference+qic%3Ausage'));
		assert.ok(state.length > 0);
	});

	test('startAuthFlow generates unique state each time', async () => {
		const auth = new QuantlabAuth(makeAuthConfig());
		const { state: state1 } = await auth.startAuthFlow();
		const { state: state2 } = await auth.startAuthFlow();
		assert.notStrictEqual(state1, state2);
	});

	// --- exchangeCode ---

	test('exchangeCode returns tokens on success', async () => {
		const auth = new QuantlabAuth(makeAuthConfig());
		const { state } = await auth.startAuthFlow();

		const tokens = await auth.exchangeCode('test-auth-code', state);

		assert.ok(tokens.accessToken.startsWith('test-access-token-'));
		assert.ok(tokens.refreshToken.startsWith('test-refresh-token-'));
		assert.strictEqual(tokens.expiresIn, 3600);
		assert.strictEqual(tokens.scope, 'qic:inference qic:usage');
	});

	test('exchangeCode rejects mismatched state (CSRF protection)', async () => {
		const auth = new QuantlabAuth(makeAuthConfig());
		await auth.startAuthFlow();

		await assert.rejects(
			() => auth.exchangeCode('test-auth-code', 'wrong-state'),
			(err: any) => {
				assert.strictEqual(err.code, 'QIC-A002');
				assert.ok(err.message.includes('state mismatch'));
				return true;
			},
		);
	});

	test('exchangeCode rejects when no pending flow', async () => {
		const auth = new QuantlabAuth(makeAuthConfig());
		// No startAuthFlow called

		await assert.rejects(
			() => auth.exchangeCode('test-auth-code', 'some-state'),
			(err: any) => {
				assert.strictEqual(err.code, 'QIC-A001');
				return true;
			},
		);
	});

	test('exchangeCode clears pending state after success', async () => {
		const auth = new QuantlabAuth(makeAuthConfig());
		const { state } = await auth.startAuthFlow();

		await auth.exchangeCode('test-auth-code', state);

		// Second call should fail — pending state was cleared
		await assert.rejects(
			() => auth.exchangeCode('test-auth-code', state),
			(err: any) => {
				assert.strictEqual(err.code, 'QIC-A001');
				return true;
			},
		);
	});

	test('exchangeCode clears pending state after CSRF rejection', async () => {
		const auth = new QuantlabAuth(makeAuthConfig());
		await auth.startAuthFlow();

		// Trigger CSRF rejection
		try { await auth.exchangeCode('test-auth-code', 'wrong'); } catch { /* expected */ }

		// Subsequent call should also fail — state was cleared
		await assert.rejects(
			() => auth.exchangeCode('test-auth-code', 'any'),
			(err: any) => {
				assert.strictEqual(err.code, 'QIC-A001');
				return true;
			},
		);
	});
});

suite('QicAuthUriHandler', () => {

	test('handles valid callback URI', () => {
		const handler = new QicAuthUriHandler();
		let receivedCode: string | null = null;
		let receivedState: string | null = null;

		handler.onAuthCode((code, state) => {
			receivedCode = code;
			receivedState = state;
		});

		handler.handleUri({
			scheme: 'vscode',
			authority: 'quantlab.qic',
			path: '/auth/callback',
			query: 'code=test-code&state=test-state',
		} as any);

		assert.strictEqual(receivedCode, 'test-code');
		assert.strictEqual(receivedState, 'test-state');
	});

	test('handles error in callback URI', () => {
		const handler = new QicAuthUriHandler();
		let receivedError: string | null = null;

		handler.onError((error) => { receivedError = error; });

		handler.handleUri({
			scheme: 'vscode',
			authority: 'quantlab.qic',
			path: '/auth/callback',
			query: 'error=access_denied&error_description=User+cancelled',
		} as any);

		assert.strictEqual(receivedError, 'User cancelled');
	});

	test('handles error without description', () => {
		const handler = new QicAuthUriHandler();
		let receivedError: string | null = null;

		handler.onError((error) => { receivedError = error; });

		handler.handleUri({
			scheme: 'vscode',
			authority: 'quantlab.qic',
			path: '/auth/callback',
			query: 'error=server_error',
		} as any);

		assert.strictEqual(receivedError, 'server_error');
	});

	test('handles missing code or state', () => {
		const handler = new QicAuthUriHandler();
		let receivedError: string | null = null;

		handler.onError((error) => { receivedError = error; });

		handler.handleUri({
			scheme: 'vscode',
			authority: 'quantlab.qic',
			path: '/auth/callback',
			query: 'code=test-code',  // Missing state
		} as any);

		assert.ok((receivedError as string | null)?.includes('Missing'));
	});

	test('ignores non-callback paths', () => {
		const handler = new QicAuthUriHandler();
		let called = false;

		handler.onAuthCode(() => { called = true; });
		handler.onError(() => { called = true; });

		handler.handleUri({
			scheme: 'vscode',
			authority: 'quantlab.qic',
			path: '/some/other/path',
			query: 'code=test-code&state=test-state',
		} as any);

		assert.strictEqual(called, false);
	});

	test('dispose clears callbacks', () => {
		const handler = new QicAuthUriHandler();
		let called = false;

		handler.onAuthCode(() => { called = true; });
		handler.dispose();

		handler.handleUri({
			scheme: 'vscode',
			authority: 'quantlab.qic',
			path: '/auth/callback',
			query: 'code=test-code&state=test-state',
		} as any);

		assert.strictEqual(called, false);
	});
});

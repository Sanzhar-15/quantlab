/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { fetchDynamicRegistration, IAuthorizationServerMetadata } from '../../../../base/common/oauth.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogger, ILoggerService, LogLevel } from '../../../../platform/log/common/log.js';
import { MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';
import { NodeDynamicAuthProvider } from '../../node/extHostAuthentication.js';

// Distinct markers, one per credential. Every one of them is planted in a mocked request or response, so a marker found in
// a log argument or in an error means that a credential value reached it.
const CLIENT_SECRET = 'MARK-CLIENT-SECRET-7c1a';
const AUTH_CODE = 'MARK-AUTH-CODE-4e2b';
const PKCE_VERIFIER = 'MARK-PKCE-VERIFIER-9d3f';
const DEVICE_CODE = 'MARK-DEVICE-CODE-5a6c';
const ACCESS_TOKEN = 'MARK-ACCESS-TOKEN-1b8e';
const REFRESH_TOKEN = 'MARK-REFRESH-TOKEN-2f7d';
const ID_TOKEN = 'MARK-ID-TOKEN-3a9c';
const STORED_ACCESS_TOKEN = 'MARK-STORED-ACCESS-6e4a';
const STORED_REFRESH_TOKEN = 'MARK-STORED-REFRESH-8b5d';
const NEW_CLIENT_SECRET = 'MARK-NEW-CLIENT-SECRET-0c2e';
const REGISTRATION_TOKEN = 'MARK-REGISTRATION-TOKEN-a1d7';

const ALL_MARKERS = [
	CLIENT_SECRET, AUTH_CODE, PKCE_VERIFIER, DEVICE_CODE, ACCESS_TOKEN, REFRESH_TOKEN, ID_TOKEN,
	STORED_ACCESS_TOKEN, STORED_REFRESH_TOKEN, NEW_CLIENT_SECRET, REGISTRATION_TOKEN
];

const CLIENT_ID = 'client-id-is-not-a-secret';
const REDIRECT_URI = 'https://vscode.dev/redirect';
const AUTH_SERVER = 'https://auth.example.com';
const TOKEN_ENDPOINT = `${AUTH_SERVER}/token`;
const DEVICE_ENDPOINT = `${AUTH_SERVER}/device`;
const REGISTRATION_ENDPOINT = `${AUTH_SERVER}/register`;

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 400: 'Bad Request', 500: 'Internal Server Error' };

/**
 * Every string reachable from a value: strings, primitives, and for objects every own property (so an Error contributes
 * its name, message, stack and the whole cause chain).
 */
function collectStrings(value: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
	if (typeof value === 'string') {
		out.push(value);
	} else if (typeof value !== 'object' && typeof value !== 'function' || value === null) {
		out.push(String(value));
	} else if (!seen.has(value)) {
		seen.add(value);
		if (value instanceof Error) {
			out.push(value.name, value.message, value.stack ?? '');
		}
		for (const key of Object.getOwnPropertyNames(value)) {
			collectStrings((value as Record<string, unknown>)[key], out, seen);
		}
	}
	return out;
}

function findMarkers(value: unknown): string[] {
	const texts = collectStrings(value);
	return ALL_MARKERS.filter(marker => texts.some(text => text.includes(marker)));
}

class RecordingLogger extends Disposable implements ILogger {
	readonly records: { level: string; args: unknown[] }[] = [];
	readonly onDidChangeLogLevel = Event.None;
	getLevel(): LogLevel { return LogLevel.Trace; }
	setLevel(): void { }
	trace(message: string, ...args: unknown[]): void { this.records.push({ level: 'trace', args: [message, ...args] }); }
	debug(message: string, ...args: unknown[]): void { this.records.push({ level: 'debug', args: [message, ...args] }); }
	info(message: string, ...args: unknown[]): void { this.records.push({ level: 'info', args: [message, ...args] }); }
	warn(message: string, ...args: unknown[]): void { this.records.push({ level: 'warn', args: [message, ...args] }); }
	error(message: string | Error, ...args: unknown[]): void { this.records.push({ level: 'error', args: [message, ...args] }); }
	flush(): void { this.records.push({ level: 'flush', args: [] }); }

	messages(level: string): string[] {
		return this.records.filter(record => record.level === level).map(record => record.args.map(arg => collectStrings(arg).join(' ')).join(' '));
	}
}

class TestProxy {
	readonly persisted: unknown[] = [];
	continueNotifications = 0;
	registrationPrompts = 0;
	continueAnswer = true;

	async $setSessionsForDynamicAuthProvider(_providerId: string, _clientId: string, sessions: unknown[]): Promise<void> {
		this.persisted.push(sessions);
	}
	async $waitForUriHandler(): Promise<unknown> {
		return { scheme: 'vscode', authority: 'dynamicauthprovider', path: '/redirect', query: `nonce=n&code=${AUTH_CODE}`, fragment: '' };
	}
	async $showContinueNotification(): Promise<boolean> {
		this.continueNotifications++;
		return this.continueAnswer;
	}
	async $showDeviceCodeModal(): Promise<boolean> {
		return true;
	}
	async $promptForClientRegistration(): Promise<undefined> {
		this.registrationPrompts++;
		return undefined;
	}
}

class TestProvider extends NodeDynamicAuthProvider {
	exchangeCode(code: string, verifier: string, redirectUri: string) {
		return this.exchangeCodeForToken(code, verifier, redirectUri);
	}

	refresh(refreshToken: string) {
		return this.exchangeRefreshTokenForToken(refreshToken);
	}

	/**
	 * Runs one of the create flows. The provider is remote so the flows are [URL handler, device code].
	 */
	runFlow(index: number) {
		const flow = this._createFlows[index];
		assert.ok(flow, `no create flow at index ${index}`);
		return flow.handler(['read'], { report: () => undefined }, CancellationToken.None);
	}

	protected override generateRandomString(length: number): string {
		// The PKCE verifier is the only 64 character string: make it a recognisable marker
		return length === 64 ? PKCE_VERIFIER.padEnd(64, 'x') : super.generateRandomString(length);
	}
}

type FetchResponder = (url: string, body: string | undefined) => Response;

suite('Dynamic OAuth credentials never reach a log or an error', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const realFetch = globalThis.fetch;
	let fetchQueue: FetchResponder[];
	let fetchCalls: { url: string; body: string | undefined }[];

	setup(() => {
		fetchQueue = [];
		fetchCalls = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const body = init?.body === undefined ? undefined : String(init.body);
			fetchCalls.push({ url, body });
			const responder = fetchQueue.shift();
			if (!responder) {
				throw new Error(`unexpected fetch of ${url}`);
			}
			return responder(url, body);
		}) as typeof fetch;
	});

	teardown(() => {
		globalThis.fetch = realFetch;
	});

	function respond(status: number, body: string): FetchResponder {
		return () => new Response(body, { status, statusText: STATUS_TEXT[status] });
	}

	// A response whose body cannot be read; the read error itself holds a credential
	function respondUnreadable(status: number): FetchResponder {
		return () => ({ ok: false, status, statusText: STATUS_TEXT[status], text: async () => { throw new Error(`read failed ${ACCESS_TOKEN}`); } }) as unknown as Response;
	}

	function respondJson(status: number, body: unknown): FetchResponder {
		return respond(status, JSON.stringify(body));
	}

	function createProvider(options: { initialTokens?: any[] } = {}) {
		const logger = store.add(new RecordingLogger());
		const proxy = new TestProxy();
		const loggerService = { createLogger: () => logger } as unknown as ILoggerService;
		const extHostWindow = { openUri: async () => true } as unknown as IExtHostWindow;
		const urls = {
			createAppUri: async () => URI.parse('vscode://dynamicauthprovider/auth.example.com/authorize?nonce=n')
		} as unknown as IExtHostUrlsService;
		const initData = {
			environment: { appUriScheme: 'vscode', appName: 'Test' },
			remote: { isRemote: true }
		} as unknown as IExtHostInitDataService;
		const progress = {
			withProgressFromSource: async (_source: unknown, _options: unknown, task: (progress: { report(): void }, token: CancellationToken) => Thenable<unknown>) =>
				task({ report: () => undefined }, CancellationToken.None)
		} as unknown as IExtHostProgress;
		const tokenEvents = store.add(new Emitter<{ authProviderId: string; clientId: string; tokens: any[] }>());
		const metadata: IAuthorizationServerMetadata = {
			issuer: AUTH_SERVER,
			authorization_endpoint: `${AUTH_SERVER}/authorize`,
			token_endpoint: TOKEN_ENDPOINT,
			device_authorization_endpoint: DEVICE_ENDPOINT,
			registration_endpoint: REGISTRATION_ENDPOINT,
			response_types_supported: ['code']
		};
		const provider = store.add(new TestProvider(
			extHostWindow, urls, initData, progress, loggerService,
			proxy as unknown as MainThreadAuthenticationShape,
			URI.parse(AUTH_SERVER), metadata, undefined,
			CLIENT_ID, CLIENT_SECRET,
			tokenEvents, options.initialTokens ?? []
		));
		return { provider, logger, proxy };
	}

	async function rejection(promise: Promise<unknown>): Promise<Error> {
		let error: unknown;
		try {
			await promise;
		} catch (e) {
			error = e;
		}
		assert.ok(error instanceof Error, 'the call must reject with an Error');
		return error;
	}

	/**
	 * Fails when a marker is in any log argument at any level, or in the error (message, stack, cause chain).
	 */
	function assertClean(logger: RecordingLogger, error?: Error): void {
		assert.ok(logger.records.length > 0, 'the provider logged nothing: the recorder is not attached');
		assert.deepStrictEqual(findMarkers(logger.records), [], 'a credential reached a log argument');
		if (error) {
			assert.deepStrictEqual(findMarkers(error), [], 'a credential reached the rejected error');
		}
	}

	const tokenBody = { access_token: ACCESS_TOKEN, token_type: 'Bearer', refresh_token: REFRESH_TOKEN, id_token: ID_TOKEN, expires_in: 3600, scope: 'read' };
	const deviceBody = { device_code: DEVICE_CODE, user_code: 'USER-CODE-SHOWN-TO-THE-USER', verification_uri: `${AUTH_SERVER}/activate`, expires_in: 60, interval: 0.001 };
	// Wrong shape on purpose: no access_token or token_type, yet every credential is in it
	const wrongShapeBody = { note: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, id_token: ID_TOKEN, client_secret: CLIENT_SECRET, device_code: DEVICE_CODE };
	// Not valid JSON, and the text the parser fails on holds credentials
	const malformedBody = `{"access_token":"${ACCESS_TOKEN}","refresh_token":"${REFRESH_TOKEN}" "id_token":"${ID_TOKEN}"`;

	suite('the checks themselves', () => {
		test('a marker in a log argument, in an error message, in a cause and in a stack is found', () => {
			assert.deepStrictEqual(findMarkers(['text', { nested: [`x ${ACCESS_TOKEN}`] }]), [ACCESS_TOKEN]);
			assert.deepStrictEqual(findMarkers(new Error(`failed ${CLIENT_SECRET}`)), [CLIENT_SECRET]);
			assert.deepStrictEqual(findMarkers(new Error('outer', { cause: new Error(`inner ${REFRESH_TOKEN}`) })), [REFRESH_TOKEN]);
			const withStack = new Error('clean');
			withStack.stack = `Error: clean\n    at ${ID_TOKEN}`;
			assert.deepStrictEqual(findMarkers(withStack), [ID_TOKEN]);
			assert.deepStrictEqual(findMarkers(new Error('no credential here', { cause: 'status 400' })), []);
		});

		test('the recorder sees every level', () => {
			const logger = store.add(new RecordingLogger());
			logger.trace('t');
			logger.debug('d');
			logger.info('i');
			logger.warn('w');
			logger.error('e');
			logger.flush();
			assert.deepStrictEqual(logger.records.map(record => record.level), ['trace', 'debug', 'info', 'warn', 'error', 'flush']);
		});
	});

	suite('authorization code exchange', () => {
		test('ok: resolves, and the request secrets are not logged', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, tokenBody));

			const token = await provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI);

			assert.strictEqual(token.access_token, ACCESS_TOKEN);
			// The secrets really were in the request, so the log check below is meaningful
			assert.strictEqual(fetchCalls.length, 1);
			for (const marker of [AUTH_CODE, PKCE_VERIFIER, CLIENT_SECRET]) {
				assert.ok(fetchCalls[0].body?.includes(marker), `the request body does not hold ${marker}`);
			}
			assertClean(logger);
		});

		test('non-ok with a body that echoes credentials: rejects with status and error code only', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(400, { error: 'invalid_grant', error_description: `code ${AUTH_CODE} verifier ${PKCE_VERIFIER} secret ${CLIENT_SECRET}`, ...tokenBody }));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));

			assert.strictEqual(error.message, 'Token exchange failed: 400 Bad Request (invalid_grant)');
			assertClean(logger, error);
		});

		test('non-ok with a non-JSON body that holds credentials', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(500, `<html>${ACCESS_TOKEN} ${REFRESH_TOKEN} ${CLIENT_SECRET}</html>`));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));

			assert.strictEqual(error.message, 'Token exchange failed: 500 Internal Server Error (body not JSON)');
			assertClean(logger, error);
		});

		test('non-ok with a body that cannot be read: names the outcome, drops the read error', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondUnreadable(500));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));

			assert.strictEqual(error.message, 'Token exchange failed: 500 Internal Server Error (body unreadable)');
			assert.strictEqual(error.cause, undefined);
			assertClean(logger, error);
		});

		test('non-ok with an error value that is not a safe code: the value is dropped', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(400, { error: `bad request, code ${AUTH_CODE}` }));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));

			assert.strictEqual(error.message, 'Token exchange failed: 400 Bad Request (no safe error code in body)');
			assertClean(logger, error);
		});

		test('ok with malformed JSON: a new error, without the parser message or a cause', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(200, malformedBody));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));

			assert.strictEqual(error.message, 'Token exchange failed: the response body is not valid JSON (200 OK)');
			assert.strictEqual(error.cause, undefined);
			assertClean(logger, error);
		});

		test('non-ok with malformed JSON', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(400, malformedBody));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));

			assert.strictEqual(error.message, 'Token exchange failed: 400 Bad Request (body not JSON)');
			assertClean(logger, error);
		});

		test('ok with the wrong shape and credentials in it', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, wrongShapeBody));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));

			assert.strictEqual(error.message, 'Invalid authorization token response');
			assertClean(logger, error);
		});

		test('ok with the wrong shape names a safe error code', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, { error: 'invalid_request', error_description: `code ${AUTH_CODE}` }));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));

			assert.strictEqual(error.message, 'Invalid authorization token response (invalid_request)');
			assertClean(logger, error);
		});

		test('a failing fetch rejects and logs the failure without the request', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(() => { throw new TypeError('fetch failed'); });

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));

			assert.strictEqual(error.message, 'Failed to exchange authorization code for token: TypeError: fetch failed');
			assert.ok(logger.messages('error').some(message => message.includes('Failed to exchange authorization code for token')));
			assertClean(logger, error);
		});
	});

	suite('refresh', () => {
		test('ok: resolves, and the request secrets are not logged', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, tokenBody));

			const token = await provider.refresh(STORED_REFRESH_TOKEN);

			assert.strictEqual(token.access_token, ACCESS_TOKEN);
			assert.ok(typeof token.created_at === 'number');
			assert.ok(fetchCalls[0].body?.includes(STORED_REFRESH_TOKEN));
			assert.ok(fetchCalls[0].body?.includes(CLIENT_SECRET));
			assert.deepStrictEqual(findMarkers(logger.records), []);
		});

		test('non-ok with a body that echoes credentials: checks the status, rejects with status and error code only', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(500, { error: 'server_error', error_description: STORED_REFRESH_TOKEN, ...tokenBody }));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));

			assert.strictEqual(error.message, 'Token refresh failed: 500 Internal Server Error (server_error)');
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);
		});

		test('non-ok with a non-JSON body that holds credentials', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(500, `${ACCESS_TOKEN} ${REFRESH_TOKEN} ${STORED_REFRESH_TOKEN}`));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));

			assert.strictEqual(error.message, 'Token refresh failed: 500 Internal Server Error (body not JSON)');
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);
		});

		test('non-ok with a body that cannot be read: names the outcome, drops the read error', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondUnreadable(500));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));

			assert.strictEqual(error.message, 'Token refresh failed: 500 Internal Server Error (body unreadable)');
			assert.strictEqual(error.cause, undefined);
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);
		});

		test('non-ok with malformed JSON', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(400, malformedBody));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));

			assert.strictEqual(error.message, 'Token refresh failed: 400 Bad Request (body not JSON)');
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);
		});

		test('ok with malformed JSON: a new error, without the parser message or a cause', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(200, malformedBody));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));

			assert.strictEqual(error.message, 'Token refresh failed: the response body is not valid JSON (200 OK)');
			assert.strictEqual(error.cause, undefined);
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);
		});

		test('ok with the wrong shape and credentials in it', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, wrongShapeBody));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));

			assert.strictEqual(error.message, 'Invalid authorization token response');
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);
		});

		test('non-ok invalid_client still regenerates the client; a failed registration does not leak its response', async () => {
			const { provider, logger, proxy } = createProvider();
			fetchQueue.push(respondJson(400, { error: 'invalid_client', error_description: CLIENT_SECRET }));
			// The registration response is the wrong shape (no client_id) and holds a secret and a registration token
			fetchQueue.push(respondJson(200, { client_secret: NEW_CLIENT_SECRET, registration_access_token: REGISTRATION_TOKEN }));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));

			assert.deepStrictEqual(fetchCalls.map(call => call.url), [TOKEN_ENDPOINT, REGISTRATION_ENDPOINT]);
			assert.strictEqual(proxy.registrationPrompts, 1);
			assert.strictEqual(error.message, 'Failed to fetch new client ID and user did not provide one: Error: Invalid authorization dynamic client registration response');
			assert.ok(logger.messages('warn').some(message => message.includes(`Client ID (${CLIENT_ID}) was invalid`)));
			assert.ok(logger.messages('info').some(message => message.includes('Dynamic registration failed')));
			assertClean(logger, error);
		});

		test('getSessions: a failed refresh is logged without the response or the stored tokens', async () => {
			const { provider, logger } = createProvider({
				initialTokens: [{ access_token: STORED_ACCESS_TOKEN, token_type: 'Bearer', refresh_token: STORED_REFRESH_TOKEN, expires_in: 60, scope: 'read', created_at: 0 }]
			});
			fetchQueue.push(respondJson(500, { error: 'server_error', ...tokenBody }));

			const sessions = await provider.getSessions(['read'], {});

			assert.deepStrictEqual(sessions, []);
			assert.deepStrictEqual(logger.messages('error').filter(message => message.includes('Failed to refresh token')), ['Failed to refresh token: Error: Token refresh failed: 500 Internal Server Error (server_error)']);
			assertClean(logger);
		});

		test('getSessions: a refresh with malformed JSON is logged without the response', async () => {
			const { provider, logger } = createProvider({
				initialTokens: [{ access_token: STORED_ACCESS_TOKEN, token_type: 'Bearer', refresh_token: STORED_REFRESH_TOKEN, expires_in: 60, scope: 'read', created_at: 0 }]
			});
			fetchQueue.push(respond(200, malformedBody));

			await provider.getSessions(['read'], {});

			assert.ok(logger.messages('error').some(message => message.includes('Failed to refresh token')));
			assertClean(logger);
		});

		test('getSessions: a successful refresh replaces the session and logs no token', async () => {
			const { provider, logger } = createProvider({
				initialTokens: [{ access_token: STORED_ACCESS_TOKEN, token_type: 'Bearer', refresh_token: STORED_REFRESH_TOKEN, expires_in: 60, scope: 'read', created_at: 0 }]
			});
			fetchQueue.push(respondJson(200, tokenBody));

			const sessions = await provider.getSessions(['read'], {});

			assert.strictEqual(sessions.length, 1);
			assert.strictEqual(sessions[0].accessToken, ACCESS_TOKEN);
			assertClean(logger);
		});
	});

	suite('device code flow', () => {
		const DEVICE_FLOW = 1;

		test('ok: resolves', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respondJson(200, tokenBody));

			const token = await provider.runFlow(DEVICE_FLOW);

			assert.strictEqual(token.access_token, ACCESS_TOKEN);
			assert.ok(fetchCalls[1].body?.includes(DEVICE_CODE));
			assertClean(logger);
		});

		test('device code request non-ok with a body that holds the device code', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(400, { error: 'invalid_request', ...deviceBody }));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));

			assert.strictEqual(error.message, 'Device code request failed: 400 Bad Request (invalid_request)');
			assertClean(logger, error);
		});

		test('device code response with malformed JSON', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(200, `{"device_code":"${DEVICE_CODE}" "user_code":`));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));

			assert.strictEqual(error.message, 'Device code request failed: the response body is not valid JSON (200 OK)');
			assert.strictEqual(error.cause, undefined);
			assertClean(logger, error);
		});

		test('token response ok with malformed JSON', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respond(200, malformedBody));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));

			assert.strictEqual(error.message, 'Error polling for token: Error: Device code token request failed: the response body is not valid JSON (200 OK)');
			assertClean(logger, error);
		});

		test('token response ok with the wrong shape and credentials in it', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respondJson(200, wrongShapeBody));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));

			assert.strictEqual(error.message, 'Error polling for token: Error: Invalid token response received from server');
			assertClean(logger, error);
		});

		test('token response non-ok with malformed JSON', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respond(400, malformedBody));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));

			assert.strictEqual(error.message, 'Error polling for token: Error: Device code token request failed: the response body is not valid JSON (400 Bad Request)');
			assertClean(logger, error);
		});

		test('token response non-ok with an unknown error and a description that holds credentials', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respondJson(400, { error: 'unsupported_thing', error_description: `${DEVICE_CODE} ${ACCESS_TOKEN}`, ...tokenBody }));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));

			assert.strictEqual(error.message, 'Error polling for token: Error: Token request failed: 400 Bad Request (unsupported_thing)');
			assertClean(logger, error);
		});

		test('token response non-ok: authorization_pending keeps polling', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respondJson(400, { error: 'authorization_pending' }), respondJson(200, tokenBody));

			const token = await provider.runFlow(DEVICE_FLOW);

			assert.strictEqual(token.access_token, ACCESS_TOKEN);
			assert.strictEqual(fetchCalls.length, 3);
			assertClean(logger);
		});
	});

	suite('createSession across flows', () => {
		test('a failed URL handler flow, then a malformed device code token: every failure rejects and is logged without credentials', async () => {
			const { provider, logger, proxy } = createProvider();
			fetchQueue.push(
				// URL handler flow: the exchange of the code fails and echoes credentials
				respondJson(400, { error: 'invalid_grant', error_description: `${AUTH_CODE} ${PKCE_VERIFIER} ${CLIENT_SECRET}`, ...tokenBody }),
				// device code flow: a device code, then a malformed token response
				respondJson(200, deviceBody),
				respond(200, malformedBody)
			);

			const error = await rejection(provider.createSession(['read'], {}));

			assert.strictEqual(error.message, 'Failed to create authentication token');
			assert.strictEqual(proxy.continueNotifications, 1);
			for (const marker of [AUTH_CODE, PKCE_VERIFIER, CLIENT_SECRET]) {
				assert.ok(fetchCalls[0].body?.includes(marker), `the exchange request does not hold ${marker}`);
			}
			assert.deepStrictEqual(
				logger.messages('error').filter(message => message.includes('Failed to create token via flow')).map(message => message.replace(/'[^']*'/, 'FLOW')),
				['Failed to create token via flow FLOW: Error: Token exchange failed: 400 Bad Request (invalid_grant)']
			);
			assertClean(logger, error);
		});
	});

	suite('dynamic client registration', () => {
		const metadata: IAuthorizationServerMetadata = {
			issuer: AUTH_SERVER,
			registration_endpoint: REGISTRATION_ENDPOINT,
			response_types_supported: ['code']
		};

		test('ok with the wrong shape and a client secret in it', async () => {
			fetchQueue.push(respondJson(200, { client_secret: NEW_CLIENT_SECRET, registration_access_token: REGISTRATION_TOKEN }));

			const error = await rejection(fetchDynamicRegistration(metadata, 'Test Client'));

			assert.strictEqual(error.message, 'Invalid authorization dynamic client registration response');
			assert.deepStrictEqual(findMarkers(error), []);
		});

		test('ok with malformed JSON: a new error, without the parser message or a cause', async () => {
			fetchQueue.push(respond(200, `{"client_secret":"${NEW_CLIENT_SECRET}" "registration_access_token":"${REGISTRATION_TOKEN}"`));

			const error = await rejection(fetchDynamicRegistration(metadata, 'Test Client'));

			assert.strictEqual(error.message, `Registration to ${REGISTRATION_ENDPOINT} failed: the response body is not valid JSON`);
			assert.strictEqual(error.cause, undefined);
			assert.deepStrictEqual(findMarkers(error), []);
		});

		test('non-ok with a body that holds credentials', async () => {
			fetchQueue.push(respondJson(400, { error: 'invalid_client_metadata', error_description: `${NEW_CLIENT_SECRET} ${REGISTRATION_TOKEN}` }));

			const error = await rejection(fetchDynamicRegistration(metadata, 'Test Client'));

			assert.strictEqual(error.message, `Registration to ${REGISTRATION_ENDPOINT} failed: 400 Bad Request (invalid_client_metadata)`);
			assert.deepStrictEqual(findMarkers(error), []);
		});
	});
});

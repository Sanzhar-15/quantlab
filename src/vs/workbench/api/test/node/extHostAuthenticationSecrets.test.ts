/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import { VSBuffer, encodeBase64 } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { fetchAuthorizationServerMetadata, fetchDynamicRegistration, fetchResourceMetadata, getClaimsFromJWT, IAuthorizationServerMetadata } from '../../../../base/common/oauth.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogger, ILoggerService, LogLevel } from '../../../../platform/log/common/log.js';
import { MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';
import { createAuthMetadata } from '../../common/extHostMcp.js';
import { NodeDynamicAuthProvider } from '../../node/extHostAuthentication.js';
import { LoopbackAuthServer } from '../../node/loopbackServer.js';

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

// The user code is shown to the user, but it is a live authentication code, so it is a marker too
const USER_CODE = 'MARK-USER-CODE-b7e1';
// The first text of a malformed body: a JSON parser error quotes it, so a partial disclosure has this prefix
const PARSER_LEAK = 'MARK-PARSER-LEAK-e5f2';
const URL_USERINFO = 'MARK-URL-USERINFO-c3d9';
const URL_QUERY = 'MARK-URL-QUERY-f4a8';

const ALL_MARKERS = [
	CLIENT_SECRET, AUTH_CODE, PKCE_VERIFIER, DEVICE_CODE, ACCESS_TOKEN, REFRESH_TOKEN, ID_TOKEN,
	STORED_ACCESS_TOKEN, STORED_REFRESH_TOKEN, NEW_CLIENT_SECRET, REGISTRATION_TOKEN, USER_CODE, PARSER_LEAK,
	URL_USERINFO, URL_QUERY
];

// Credentials that can arrive in an `error` field, a reason phrase or a transport message
const SERVER_SIDE_MARKERS = [CLIENT_SECRET, AUTH_CODE, PKCE_VERIFIER, DEVICE_CODE, ACCESS_TOKEN, REFRESH_TOKEN, ID_TOKEN, USER_CODE];

// A PARTIAL disclosure is a disclosure: a parser error quotes only the first characters of the body it failed on
const MARKER_PREFIX_LENGTH = 10;

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
	return ALL_MARKERS.filter(marker => texts.some(text => text.includes(marker.slice(0, MARKER_PREFIX_LENGTH))));
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
	waitForUriHandlerError: unknown;
	readonly deviceModals: { userCode: string; verificationUri: string }[] = [];

	async $setSessionsForDynamicAuthProvider(_providerId: string, _clientId: string, sessions: unknown[]): Promise<void> {
		this.persisted.push(sessions);
	}
	async $waitForUriHandler(): Promise<unknown> {
		if (this.waitForUriHandlerError) {
			throw this.waitForUriHandlerError;
		}
		return { scheme: 'vscode', authority: 'dynamicauthprovider', path: '/redirect', query: `nonce=n&code=${AUTH_CODE}`, fragment: '' };
	}
	async $showContinueNotification(): Promise<boolean> {
		this.continueNotifications++;
		return this.continueAnswer;
	}
	async $showDeviceCodeModal(userCode: string, verificationUri: string): Promise<boolean> {
		this.deviceModals.push({ userCode, verificationUri });
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
	runFlow(index: number, reports: unknown[] = []) {
		const flow = this._createFlows[index];
		assert.ok(flow, `no create flow at index ${index}`);
		return flow.handler(['read'], { report: value => { reports.push(value); } }, CancellationToken.None);
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

	function respond(status: number, body: string, reasonPhrase: string = STATUS_TEXT[status]): FetchResponder {
		return () => new Response(body, { status, statusText: reasonPhrase });
	}

	// A response whose body cannot be read; the read error itself holds a credential
	function respondUnreadable(status: number): FetchResponder {
		return () => ({ ok: status >= 200 && status < 300, status, statusText: STATUS_TEXT[status], text: async () => { throw new Error(`read failed ${ACCESS_TOKEN}`); } }) as unknown as Response;
	}

	// A fetch that rejects the way a transport does: the message and a nested cause quote a credential
	function rejectTransport(marker: string): FetchResponder {
		return () => { throw new TypeError(`transport ${marker}`, { cause: new Error(`cause ${marker}`, { cause: new Error(`root cause ${marker}`) }) }); };
	}

	function respondJson(status: number, body: unknown): FetchResponder {
		return respond(status, JSON.stringify(body));
	}

	function createProvider(options: { initialTokens?: any[]; metadata?: Partial<IAuthorizationServerMetadata>; createAppUriError?: unknown } = {}) {
		const logger = store.add(new RecordingLogger());
		const proxy = new TestProxy();
		const loggerService = { createLogger: () => logger } as unknown as ILoggerService;
		const extHostWindow = { openUri: async () => true } as unknown as IExtHostWindow;
		const urls = {
			createAppUri: async () => {
				if (options.createAppUriError) {
					throw options.createAppUriError;
				}
				return URI.parse('vscode://dynamicauthprovider/auth.example.com/authorize?nonce=n');
			}
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
			response_types_supported: ['code'],
			...options.metadata
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
	const deviceBody = { device_code: DEVICE_CODE, user_code: USER_CODE, verification_uri: `${AUTH_SERVER}/activate`, expires_in: 60, interval: 0.001 };
	// Wrong shape on purpose: no access_token or token_type, yet every credential is in it
	const wrongShapeBody = { note: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, id_token: ID_TOKEN, client_secret: CLIENT_SECRET, device_code: DEVICE_CODE };
	// Not valid JSON, and the text the parser fails on holds credentials
	// The parser quotes the start of the text, so the body starts with the prefix marker
	const malformedBody = `${PARSER_LEAK} {"access_token":"${ACCESS_TOKEN}","refresh_token":"${REFRESH_TOKEN}" "id_token":"${ID_TOKEN}"`;

	const registrationMetadata: IAuthorizationServerMetadata = {
		issuer: AUTH_SERVER,
		registration_endpoint: REGISTRATION_ENDPOINT,
		response_types_supported: ['code']
	};

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

		test('a partial disclosure is found: a raw JSON parser error that quotes only a prefix of the body', () => {
			let raw: unknown;
			try {
				JSON.parse(malformedBody);
			} catch (e) {
				raw = e;
			}
			assert.ok(raw instanceof SyntaxError);
			// No complete marker is in the parser message, only the start of the first one
			assert.ok(!ALL_MARKERS.some(marker => (raw as Error).message.includes(marker)), (raw as Error).message);
			assert.deepStrictEqual(findMarkers(raw), [PARSER_LEAK]);
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
			assertClean(logger);

			assert.strictEqual(token.access_token, ACCESS_TOKEN);
			// The secrets really were in the request, so the log check below is meaningful
			assert.strictEqual(fetchCalls.length, 1);
			for (const marker of [AUTH_CODE, PKCE_VERIFIER, CLIENT_SECRET]) {
				assert.ok(fetchCalls[0].body?.includes(marker), `the request body does not hold ${marker}`);
			}
		});

		test('non-ok with a body that echoes credentials: rejects with status and error code only', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(400, { error: 'invalid_grant', error_description: `code ${AUTH_CODE} verifier ${PKCE_VERIFIER} secret ${CLIENT_SECRET}`, ...tokenBody }));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Token exchange failed: 400 (invalid_grant)');
		});

		test('non-ok with a non-JSON body that holds credentials', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(500, `${PARSER_LEAK} <html>${ACCESS_TOKEN} ${REFRESH_TOKEN} ${CLIENT_SECRET}</html>`));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Token exchange failed: 500 (body not JSON)');
		});

		test('non-ok with a body that cannot be read: names the outcome, drops the read error', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondUnreadable(500));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Token exchange failed: 500 (body unreadable)');
			assert.strictEqual(error.cause, undefined);
		});

		test('non-ok with an error value that is not a safe code: the value is dropped', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(400, { error: `bad request, code ${AUTH_CODE}` }));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Token exchange failed: 400 (unrecognised error code)');
		});

		test('ok with malformed JSON: a new error, without the parser message or a cause', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(200, malformedBody));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Token exchange failed: the response body is not valid JSON (200)');
			assert.strictEqual(error.cause, undefined);
		});

		test('non-ok with malformed JSON', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(400, malformedBody));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Token exchange failed: 400 (body not JSON)');
		});

		test('ok with the wrong shape and credentials in it', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, wrongShapeBody));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Invalid authorization token response: 200 (no error code in body)');
		});

		test('ok with the wrong shape names a safe error code', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, { error: 'invalid_request', error_description: `code ${AUTH_CODE}` }));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Invalid authorization token response: 200 (invalid_request)');
		});

		test('a failing fetch rejects and logs the failure without the request', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(() => { throw new TypeError('fetch failed'); });

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Failed to exchange authorization code for token: TypeError: fetch failed');
			assert.ok(logger.messages('error').some(message => message.includes('Failed to exchange authorization code for token')));
		});
	});

	suite('refresh', () => {
		test('ok: resolves, and the request secrets are not logged', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, tokenBody));

			const token = await provider.refresh(STORED_REFRESH_TOKEN);
			assert.deepStrictEqual(findMarkers(logger.records), []);

			assert.strictEqual(token.access_token, ACCESS_TOKEN);
			assert.ok(typeof token.created_at === 'number');
			assert.ok(fetchCalls[0].body?.includes(STORED_REFRESH_TOKEN));
			assert.ok(fetchCalls[0].body?.includes(CLIENT_SECRET));
		});

		test('non-ok with a body that echoes credentials: checks the status, rejects with status and error code only', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(500, { error: 'server_error', error_description: STORED_REFRESH_TOKEN, ...tokenBody }));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);

			assert.strictEqual(error.message, 'Token refresh failed: 500 (server_error)');
		});

		test('non-ok with a non-JSON body that holds credentials', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(500, `${PARSER_LEAK} ${ACCESS_TOKEN} ${REFRESH_TOKEN} ${STORED_REFRESH_TOKEN}`));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);

			assert.strictEqual(error.message, 'Token refresh failed: 500 (body not JSON)');
		});

		test('non-ok with a body that cannot be read: names the outcome, drops the read error', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondUnreadable(500));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);

			assert.strictEqual(error.message, 'Token refresh failed: 500 (body unreadable)');
			assert.strictEqual(error.cause, undefined);
		});

		test('non-ok with malformed JSON', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(400, malformedBody));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);

			assert.strictEqual(error.message, 'Token refresh failed: 400 (body not JSON)');
		});

		test('ok with malformed JSON: a new error, without the parser message or a cause', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(200, malformedBody));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);

			assert.strictEqual(error.message, 'Token refresh failed: the response body is not valid JSON (200)');
			assert.strictEqual(error.cause, undefined);
		});

		test('ok with the wrong shape and credentials in it', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, wrongShapeBody));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));
			assert.deepStrictEqual(findMarkers(logger.records), []);
			assert.deepStrictEqual(findMarkers(error), []);

			assert.strictEqual(error.message, 'Invalid authorization token response: 200 (no error code in body)');
		});

		test('non-ok invalid_client still regenerates the client; a failed registration does not leak its response', async () => {
			const { provider, logger, proxy } = createProvider();
			fetchQueue.push(respondJson(400, { error: 'invalid_client', error_description: CLIENT_SECRET }));
			// The registration response is the wrong shape (no client_id) and holds a secret and a registration token
			fetchQueue.push(respondJson(200, { client_secret: NEW_CLIENT_SECRET, registration_access_token: REGISTRATION_TOKEN }));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));
			assertClean(logger, error);

			assert.deepStrictEqual(fetchCalls.map(call => call.url), [TOKEN_ENDPOINT, REGISTRATION_ENDPOINT]);
			assert.strictEqual(proxy.registrationPrompts, 1);
			assert.strictEqual(error.message, 'Failed to fetch new client ID and user did not provide one: Error: Invalid dynamic client registration response: 200 (no error code in body)');
			assert.ok(logger.messages('warn').some(message => message.includes(`Client ID (${CLIENT_ID}) was invalid`)));
			assert.ok(logger.messages('info').some(message => message.includes('Dynamic registration failed')));
		});

		test('getSessions: a failed refresh is logged without the response or the stored tokens', async () => {
			const { provider, logger } = createProvider({
				initialTokens: [{ access_token: STORED_ACCESS_TOKEN, token_type: 'Bearer', refresh_token: STORED_REFRESH_TOKEN, expires_in: 60, scope: 'read', created_at: 0 }]
			});
			fetchQueue.push(respondJson(500, { error: 'server_error', ...tokenBody }));

			const sessions = await provider.getSessions(['read'], {});
			assertClean(logger);

			assert.deepStrictEqual(sessions, []);
			assert.deepStrictEqual(logger.messages('error').filter(message => message.includes('Failed to refresh token')), ['Failed to refresh token: Error: Token refresh failed: 500 (server_error)']);
		});

		test('getSessions: a refresh with malformed JSON is logged without the response', async () => {
			const { provider, logger } = createProvider({
				initialTokens: [{ access_token: STORED_ACCESS_TOKEN, token_type: 'Bearer', refresh_token: STORED_REFRESH_TOKEN, expires_in: 60, scope: 'read', created_at: 0 }]
			});
			fetchQueue.push(respond(200, malformedBody));

			await provider.getSessions(['read'], {});
			assertClean(logger);

			assert.ok(logger.messages('error').some(message => message.includes('Failed to refresh token')));
		});

		test('getSessions: a successful refresh replaces the session and logs no token', async () => {
			const { provider, logger } = createProvider({
				initialTokens: [{ access_token: STORED_ACCESS_TOKEN, token_type: 'Bearer', refresh_token: STORED_REFRESH_TOKEN, expires_in: 60, scope: 'read', created_at: 0 }]
			});
			fetchQueue.push(respondJson(200, tokenBody));

			const sessions = await provider.getSessions(['read'], {});
			assertClean(logger);

			assert.strictEqual(sessions.length, 1);
			assert.strictEqual(sessions[0].accessToken, ACCESS_TOKEN);
		});
	});

	suite('device code flow', () => {
		const DEVICE_FLOW = 1;

		test('ok: resolves', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respondJson(200, tokenBody));

			const token = await provider.runFlow(DEVICE_FLOW);
			assertClean(logger);

			assert.strictEqual(token.access_token, ACCESS_TOKEN);
			assert.ok(fetchCalls[1].body?.includes(DEVICE_CODE));
		});

		test('device code request non-ok with a body that holds the device code', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(400, { error: 'invalid_request', ...deviceBody }));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Device code request failed: 400 (invalid_request)');
		});

		test('device code response with malformed JSON', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respond(200, `${PARSER_LEAK} {"device_code":"${DEVICE_CODE}" "user_code":`));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Device code request failed: the response body is not valid JSON (200)');
			assert.strictEqual(error.cause, undefined);
		});

		test('token response ok with malformed JSON', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respond(200, malformedBody));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Error polling for token: Error: Device code token request failed: the response body is not valid JSON (200)');
		});

		test('token response ok with the wrong shape and credentials in it', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respondJson(200, wrongShapeBody));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Error polling for token: Error: Invalid device code token response: 200 (no error code in body)');
		});

		test('token response non-ok with malformed JSON', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respond(400, malformedBody));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Error polling for token: Error: Device code token request failed: the response body is not valid JSON (400)');
		});

		test('token response non-ok with an unknown error and a description that holds credentials', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respondJson(400, { error: 'invalid_scope', error_description: `${DEVICE_CODE} ${ACCESS_TOKEN}`, ...tokenBody }));

			const error = await rejection(provider.runFlow(DEVICE_FLOW));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Error polling for token: Error: Token request failed: 400 (invalid_scope)');
		});

		test('token response non-ok: authorization_pending keeps polling', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respondJson(400, { error: 'authorization_pending' }), respondJson(200, tokenBody));

			const token = await provider.runFlow(DEVICE_FLOW);
			assertClean(logger);

			assert.strictEqual(token.access_token, ACCESS_TOKEN);
			assert.strictEqual(fetchCalls.length, 3);
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
			assertClean(logger, error);

			// The final flow's diagnostics survive
			assert.strictEqual(error.message, 'Failed to create authentication token: Error polling for token: Error: Device code token request failed: the response body is not valid JSON (200)');
			assert.strictEqual(proxy.continueNotifications, 1);
			for (const marker of [AUTH_CODE, PKCE_VERIFIER, CLIENT_SECRET]) {
				assert.ok(fetchCalls[0].body?.includes(marker), `the exchange request does not hold ${marker}`);
			}
			assert.deepStrictEqual(
				logger.messages('error').filter(message => message.includes('Failed to create token via flow')).map(message => message.replace(/'[^']*'/, 'FLOW')),
				['Failed to create token via flow FLOW: Error: Token exchange failed: 400 (invalid_grant)']
			);
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
			assert.deepStrictEqual(findMarkers(error), []);

			assert.strictEqual(error.message, 'Invalid dynamic client registration response: 200 (no error code in body)');
		});

		test('ok with malformed JSON: a new error, without the parser message or a cause', async () => {
			fetchQueue.push(respond(200, `${PARSER_LEAK} {"client_secret":"${NEW_CLIENT_SECRET}" "registration_access_token":"${REGISTRATION_TOKEN}"`));

			const error = await rejection(fetchDynamicRegistration(metadata, 'Test Client'));
			assert.deepStrictEqual(findMarkers(error), []);

			assert.strictEqual(error.message, 'Dynamic client registration failed: the response body is not valid JSON (200)');
			assert.strictEqual(error.cause, undefined);
		});

		test('non-ok with a body that holds credentials', async () => {
			fetchQueue.push(respondJson(400, { error: 'invalid_client_metadata', error_description: `${NEW_CLIENT_SECRET} ${REGISTRATION_TOKEN}` }));

			const error = await rejection(fetchDynamicRegistration(metadata, 'Test Client'));
			assert.deepStrictEqual(findMarkers(error), []);

			assert.strictEqual(error.message, 'Dynamic client registration failed: 400 (invalid_client_metadata)');
		});
	});

	suite('an unrecognised error value is never reported (an error string can be a credential)', () => {
		// Every path that reports an `error` code. `body` is what the server sends as the error value.
		const paths: { name: string; expected: string; run: (marker: string) => Promise<{ error: Error; logger?: RecordingLogger }> }[] = [
			{
				name: 'exchange non-ok', expected: 'Token exchange failed: 400 (unrecognised error code)',
				run: async marker => {
					const { provider, logger } = createProvider();
					fetchQueue.push(respondJson(400, { error: marker }));
					return { error: await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI)), logger };
				}
			},
			{
				name: 'exchange ok with the wrong shape', expected: 'Invalid authorization token response: 200 (unrecognised error code)',
				run: async marker => {
					const { provider, logger } = createProvider();
					fetchQueue.push(respondJson(200, { error: marker }));
					return { error: await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI)), logger };
				}
			},
			{
				name: 'refresh non-ok', expected: 'Token refresh failed: 400 (unrecognised error code)',
				run: async marker => {
					const { provider } = createProvider();
					fetchQueue.push(respondJson(400, { error: marker }));
					// refresh logs nothing before it fails, so only the error is checked here
					return { error: await rejection(provider.refresh(STORED_REFRESH_TOKEN)) };
				}
			},
			{
				name: 'device code request non-ok', expected: 'Device code request failed: 400 (unrecognised error code)',
				run: async marker => {
					const { provider, logger } = createProvider();
					fetchQueue.push(respondJson(400, { error: marker }));
					return { error: await rejection(provider.runFlow(1)), logger };
				}
			},
			{
				name: 'device polling non-ok', expected: 'Error polling for token: Error: Token request failed: 400 (unrecognised error code)',
				run: async marker => {
					const { provider, logger } = createProvider();
					fetchQueue.push(respondJson(200, deviceBody), respondJson(400, { error: marker }));
					return { error: await rejection(provider.runFlow(1)), logger };
				}
			},
			{
				name: 'registration non-ok', expected: 'Dynamic client registration failed: 400 (unrecognised error code)',
				run: async marker => {
					fetchQueue.push(respondJson(400, { error: marker }));
					return { error: await rejection(fetchDynamicRegistration(registrationMetadata, 'Test Client')) };
				}
			},
			{
				name: 'registration ok with the wrong shape', expected: 'Invalid dynamic client registration response: 200 (unrecognised error code)',
				run: async marker => {
					fetchQueue.push(respondJson(200, { error: marker }));
					return { error: await rejection(fetchDynamicRegistration(registrationMetadata, 'Test Client')) };
				}
			}
		];
		for (const path of paths) {
			for (const marker of SERVER_SIDE_MARKERS) {
				test(`${path.name}: the value ${marker} is replaced by a fixed outcome`, async () => {
					const { error, logger } = await path.run(marker);
					if (logger) {
						assertClean(logger, error);
					} else {
						assert.deepStrictEqual(findMarkers(error), []);
					}
					assert.strictEqual(error.message, path.expected);
				});
			}
		}

		test('every recognised code is still reported by name', async () => {
			for (const code of ['invalid_request', 'invalid_client', 'invalid_grant', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope',
				'authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_redirect_uri', 'invalid_client_metadata',
				'invalid_software_statement', 'unapproved_software_statement', 'unsupported_response_type', 'server_error', 'temporarily_unavailable',
				'invalid_token', 'insufficient_scope']) {
				fetchQueue.push(respondJson(400, { error: code }));
				const error = await rejection(fetchDynamicRegistration(registrationMetadata, 'Test Client'));
				assert.strictEqual(error.message, `Dynamic client registration failed: 400 (${code})`);
			}
		});

		test('device polling control flow is unchanged: slow_down continues, expired_token and access_denied end the flow', async () => {
			let { provider } = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respondJson(400, { error: 'slow_down' }), respondJson(200, tokenBody));
			assert.strictEqual((await provider.runFlow(1)).access_token, ACCESS_TOKEN);

			({ provider } = createProvider());
			fetchQueue.push(respondJson(200, deviceBody), respondJson(400, { error: 'expired_token' }));
			assert.strictEqual((await rejection(provider.runFlow(1))).message, 'Error polling for token: Error: Device code expired. Please try again.');

			({ provider } = createProvider());
			fetchQueue.push(respondJson(200, deviceBody), respondJson(400, { error: 'access_denied' }));
			const denied = await rejection(provider.runFlow(1));
			assert.ok(isCancellationError(denied), 'access_denied is a cancellation');
		});
	});

	suite('HTTP reason phrases and URLs are never reported', () => {
		test('a credential in the reason phrase never enters a message or a log, on every path', async () => {
			const reason = ACCESS_TOKEN;
			const results: { error: Error; logger?: RecordingLogger; expected: string }[] = [];

			let ctx = createProvider();
			fetchQueue.push(respond(400, JSON.stringify({ error: 'invalid_grant' }), reason));
			results.push({ error: await rejection(ctx.provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI)), logger: ctx.logger, expected: 'Token exchange failed: 400 (invalid_grant)' });

			ctx = createProvider();
			fetchQueue.push(respond(400, 'not json', reason));
			results.push({ error: await rejection(ctx.provider.refresh(STORED_REFRESH_TOKEN)), logger: ctx.logger, expected: 'Token refresh failed: 400 (body not JSON)' });

			ctx = createProvider();
			fetchQueue.push(respond(200, malformedBody, reason));
			results.push({ error: await rejection(ctx.provider.refresh(STORED_REFRESH_TOKEN)), logger: ctx.logger, expected: 'Token refresh failed: the response body is not valid JSON (200)' });

			ctx = createProvider();
			fetchQueue.push(respond(400, JSON.stringify({ error: 'invalid_request' }), reason));
			results.push({ error: await rejection(ctx.provider.runFlow(1)), logger: ctx.logger, expected: 'Device code request failed: 400 (invalid_request)' });

			ctx = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), respond(400, JSON.stringify({ error: 'invalid_scope' }), reason));
			results.push({ error: await rejection(ctx.provider.runFlow(1)), logger: ctx.logger, expected: 'Error polling for token: Error: Token request failed: 400 (invalid_scope)' });

			ctx = createProvider();
			fetchQueue.push(respond(200, JSON.stringify(wrongShapeBody), reason));
			results.push({ error: await rejection(ctx.provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI)), logger: ctx.logger, expected: 'Invalid authorization token response: 200 (no error code in body)' });

			fetchQueue.push(respond(400, JSON.stringify({ error: 'invalid_client_metadata' }), reason));
			results.push({ error: await rejection(fetchDynamicRegistration(registrationMetadata, 'Test Client')), expected: 'Dynamic client registration failed: 400 (invalid_client_metadata)' });

			fetchQueue.push(respond(200, JSON.stringify({ client_secret: NEW_CLIENT_SECRET }), reason));
			results.push({ error: await rejection(fetchDynamicRegistration(registrationMetadata, 'Test Client')), expected: 'Invalid dynamic client registration response: 200 (no error code in body)' });

			for (const { error, logger, expected } of results) {
				assert.strictEqual(error.message, expected);
				if (logger) {
					assertClean(logger, error);
				} else {
					assert.deepStrictEqual(findMarkers(error), []);
				}
			}
		});

		const urlWithCredentials = (path: string) => `https://user:${URL_USERINFO}@auth.example.com/${path}?key=${URL_QUERY}`;

		test('an endpoint URL with user info and a query is never logged or put in a message: exchange and refresh', async () => {
			const { provider, logger } = createProvider({ metadata: { token_endpoint: urlWithCredentials('token') } });
			fetchQueue.push(respondJson(200, tokenBody), respondJson(400, { error: 'invalid_grant' }), respondJson(400, { error: 'invalid_grant' }), respondJson(200, wrongShapeBody));

			await provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI);
			const failedExchange = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));
			const failedRefresh = await rejection(provider.refresh(STORED_REFRESH_TOKEN));
			const wrongShape = await rejection(provider.refresh(STORED_REFRESH_TOKEN));

			assert.ok(fetchCalls.every(call => call.url === urlWithCredentials('token')), 'the credential-bearing URL was really requested');
			assertClean(logger);
			for (const error of [failedExchange, failedRefresh, wrongShape]) {
				assert.deepStrictEqual(findMarkers(error), []);
			}
		});

		test('an endpoint URL with user info and a query is never put in a message: device flow', async () => {
			const { provider, logger } = createProvider({ metadata: { device_authorization_endpoint: urlWithCredentials('device'), token_endpoint: urlWithCredentials('token') } });
			fetchQueue.push(respondJson(400, { error: 'invalid_request' }), respondJson(200, deviceBody), respondJson(400, { error: 'invalid_scope' }));

			const failedRequest = await rejection(provider.runFlow(1));
			const failedPoll = await rejection(provider.runFlow(1));

			assert.deepStrictEqual(fetchCalls.map(call => call.url), [urlWithCredentials('device'), urlWithCredentials('device'), urlWithCredentials('token')]);
			assertClean(logger, failedRequest);
			assertClean(logger, failedPoll);
		});

		test('an endpoint URL with user info and a query is never put in a message: registration', async () => {
			const endpoint = urlWithCredentials('register');
			const metadata: IAuthorizationServerMetadata = { ...registrationMetadata, registration_endpoint: endpoint };
			fetchQueue.push(respondJson(400, { error: 'invalid_client_metadata' }), respond(200, malformedBody), respondJson(200, { client_secret: NEW_CLIENT_SECRET }), rejectTransport(ACCESS_TOKEN));

			const errors = [
				await rejection(fetchDynamicRegistration(metadata, 'Test Client')),
				await rejection(fetchDynamicRegistration(metadata, 'Test Client')),
				await rejection(fetchDynamicRegistration(metadata, 'Test Client')),
				await rejection(fetchDynamicRegistration(metadata, 'Test Client'))
			];

			assert.ok(fetchCalls.every(call => call.url === endpoint));
			for (const error of errors) {
				assert.deepStrictEqual(findMarkers(error), []);
			}
		});

		test('the token endpoint is not traced', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(respondJson(200, tokenBody));

			await provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI);

			assert.ok(!logger.records.some(record => collectStrings(record.args).some(text => text.includes(TOKEN_ENDPOINT))));
		});
	});

	suite('a transport error or an authorization error is replaced by a fresh error', () => {
		test('exchange: the rejected fetch is logged and thrown without its message or cause', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(rejectTransport(ACCESS_TOKEN));

			const error = await rejection(provider.exchangeCode(AUTH_CODE, PKCE_VERIFIER, REDIRECT_URI));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Token exchange failed: the request could not be completed');
			assert.strictEqual(error.cause, undefined);
			assert.deepStrictEqual(logger.messages('error'), ['Token exchange failed: the request could not be completed']);
		});

		test('refresh: the rejected fetch is thrown without its message or cause', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(rejectTransport(STORED_REFRESH_TOKEN));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));

			assert.strictEqual(error.message, 'Token refresh failed: the request could not be completed');
			assert.strictEqual(error.cause, undefined);
			assert.deepStrictEqual(findMarkers(error), []);
			assert.deepStrictEqual(findMarkers(logger.records), []);
		});

		test('getSessions: a refresh whose fetch rejects is logged without the transport text', async () => {
			const { provider, logger } = createProvider({
				initialTokens: [{ access_token: STORED_ACCESS_TOKEN, token_type: 'Bearer', refresh_token: STORED_REFRESH_TOKEN, expires_in: 60, scope: 'read', created_at: 0 }]
			});
			fetchQueue.push(rejectTransport(ACCESS_TOKEN));

			await provider.getSessions(['read'], {});
			assertClean(logger);

			assert.deepStrictEqual(logger.messages('error').filter(message => message.includes('Failed to refresh token')), ['Failed to refresh token: Error: Token refresh failed: the request could not be completed']);
		});

		test('registration: a rejected fetch is thrown without its message or cause', async () => {
			fetchQueue.push(rejectTransport(CLIENT_SECRET));

			const error = await rejection(fetchDynamicRegistration(registrationMetadata, 'Test Client'));

			assert.strictEqual(error.message, 'Dynamic client registration failed: the request could not be completed');
			assert.strictEqual(error.cause, undefined);
			assert.deepStrictEqual(findMarkers(error), []);
		});

		test('registration recovery after invalid_client: a rejected registration fetch reaches neither the log nor the error', async () => {
			const { provider, logger, proxy } = createProvider();
			fetchQueue.push(respondJson(400, { error: 'invalid_client' }), rejectTransport(NEW_CLIENT_SECRET));

			const error = await rejection(provider.refresh(STORED_REFRESH_TOKEN));
			assertClean(logger, error);

			assert.strictEqual(proxy.registrationPrompts, 1);
			assert.strictEqual(error.message, 'Failed to fetch new client ID and user did not provide one: Error: Dynamic client registration failed: the request could not be completed');
		});

		test('device flow: the code request and the polling fetch both reject without the transport text', async () => {
			let ctx = createProvider();
			fetchQueue.push(rejectTransport(DEVICE_CODE));
			const request = await rejection(ctx.provider.runFlow(1));
			assertClean(ctx.logger, request);
			assert.strictEqual(request.message, 'Device code request failed: the request could not be completed');
			assert.strictEqual(request.cause, undefined);

			ctx = createProvider();
			fetchQueue.push(respondJson(200, deviceBody), rejectTransport(DEVICE_CODE));
			const poll = await rejection(ctx.provider.runFlow(1));
			assertClean(ctx.logger, poll);
			assert.strictEqual(poll.message, 'Error polling for token: Error: Device code token request failed: the request could not be completed');
			assert.strictEqual(poll.cause, undefined);
		});

		test('createSession: every flow fails on transport; the last failure is kept and is clean', async () => {
			const { provider, logger } = createProvider();
			fetchQueue.push(rejectTransport(AUTH_CODE), rejectTransport(DEVICE_CODE));

			const error = await rejection(provider.createSession(['read'], {}));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Failed to create authentication token: Device code request failed: the request could not be completed');
		});

		test('URL handler flow: a createAppUri error and a redirect-wait error are replaced', async () => {
			let ctx = createProvider({ createAppUriError: new Error(`rpc ${AUTH_CODE}`, { cause: new Error(`cause ${AUTH_CODE}`) }) });
			const createUri = await rejection(ctx.provider.runFlow(0));
			assert.strictEqual(createUri.message, 'Failed to create external URI');
			assert.deepStrictEqual(findMarkers(createUri), []);
			assert.deepStrictEqual(findMarkers(ctx.logger.records), []);

			ctx = createProvider();
			ctx.proxy.waitForUriHandlerError = new Error(`rpc ${AUTH_CODE}`, { cause: new Error(`cause ${AUTH_CODE}`) });
			const wait = await rejection(ctx.provider.runFlow(0));
			assertClean(ctx.logger, wait);
			assert.strictEqual(wait.message, 'Failed to receive authorization code: Error: Failed to wait for the authorization redirect');
		});

		test('URL handler flow: a cancellation passes through as a cancellation', async () => {
			const { provider, proxy } = createProvider();
			proxy.waitForUriHandlerError = new CancellationError();

			const error = await rejection(provider.runFlow(0));

			assert.ok(isCancellationError(error), `expected a cancellation, got ${error.message}`);
		});

		suite('loopback authorization response', () => {
			async function loopbackRejection(query: string): Promise<{ error: Error; logger: RecordingLogger }> {
				const logger = store.add(new RecordingLogger());
				const server = new LoopbackAuthServer(logger, URI.parse('vscode://dynamicauthprovider/auth.example.com/redirect?nonce=n'), 'Test');
				await server.start();
				try {
					const outcome = rejection(server.waitForOAuthResponse());
					// A plain request on its own connection, so that stopping the server does not wait for a kept-alive socket
					await new Promise<void>((resolve, reject) => {
						http.get(`${server.redirectUri}?${query}`, { agent: false }, res => { res.resume(); res.on('end', resolve); }).on('error', reject);
					});
					return { error: await outcome, logger };
				} finally {
					await server.stop();
				}
			}

			test('an error value that is a credential is replaced by a fixed outcome', async () => {
				const { error } = await loopbackRejection(`error=${encodeURIComponent(ACCESS_TOKEN)}&error_description=${encodeURIComponent(REFRESH_TOKEN)}&state=x`);

				assert.strictEqual(error.message, 'Authorization failed (unrecognised error code)');
				assert.deepStrictEqual(findMarkers(error), []);
			});

			test('a recognised error code is reported by name', async () => {
				const { error } = await loopbackRejection('error=access_denied&state=x');

				assert.strictEqual(error.message, 'Authorization failed (access_denied)');
			});
		});
	});

	suite('metadata errors never carry a response body, a reason phrase or URL credentials', () => {
		const target = 'https://example.com/api';
		const prmUrl = `https://user:${URL_USERINFO}@example.com/.well-known/oauth-protected-resource?k=${URL_QUERY}`;

		function metadataResponse(status: number, json: () => Promise<unknown>) {
			return { status, statusText: ACCESS_TOKEN, json, text: async () => `${PARSER_LEAK} ${ACCESS_TOKEN} ${CLIENT_SECRET}` };
		}

		function flattenErrors(error: unknown): unknown[] {
			return error instanceof AggregateError ? error.errors : [error];
		}

		test('resource metadata: a non-success response names the numeric status only', async () => {
			const fetchImpl = async () => metadataResponse(404, async () => { throw new Error('unused'); });

			const error = await rejection(fetchResourceMetadata(target, prmUrl, { fetch: fetchImpl }));

			assert.deepStrictEqual(findMarkers(error), []);
			const messages = flattenErrors(error).map(e => (e as Error).message);
			assert.ok(messages.length >= 2);
			assert.ok(messages.every(message => /^Failed to fetch resource metadata from https:\/\/example\.com\/\.well-known\/oauth-protected-resource[^?@]*: 404$/.test(message)), messages.join('\n'));
		});

		test('resource metadata: an invalid shape does not repeat the payload', async () => {
			const fetchImpl = async () => metadataResponse(200, async () => ({ client_secret: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN }));

			const error = await rejection(fetchResourceMetadata(target, prmUrl, { fetch: fetchImpl }));

			assert.deepStrictEqual(findMarkers(error), []);
			assert.ok(flattenErrors(error).every(e => /^Invalid resource metadata from /.test((e as Error).message)));
		});

		test('resource metadata: a malformed body does not reach the error through the parser message', async () => {
			const fetchImpl = async () => metadataResponse(200, async () => JSON.parse(malformedBody));

			const error = await rejection(fetchResourceMetadata(target, prmUrl, { fetch: fetchImpl }));

			assert.deepStrictEqual(findMarkers(error), []);
			assert.ok(flattenErrors(error).every(e => /: the response body is not valid JSON$/.test((e as Error).message)));
		});

		test('resource metadata: a mismatching or non-URL resource value is not repeated', async () => {
			for (const resource of [`https://other.example/${ACCESS_TOKEN}`, ACCESS_TOKEN]) {
				const fetchImpl = async () => metadataResponse(200, async () => ({ resource }));

				const error = await rejection(fetchResourceMetadata(target, prmUrl, { fetch: fetchImpl }));

				assert.deepStrictEqual(findMarkers(error), []);
			}
		});

		test('resource metadata: the errors that are kept when a later discovery succeeds are clean', async () => {
			const valid = { resource: target };
			let calls = 0;
			const fetchImpl = async () => {
				calls++;
				return calls === 1
					? metadataResponse(200, async () => ({ client_secret: ACCESS_TOKEN }))
					: metadataResponse(200, async () => valid);
			};

			const { metadata, errors } = await fetchResourceMetadata(target, prmUrl, { fetch: fetchImpl });

			assert.deepStrictEqual(metadata, valid);
			assert.strictEqual(errors.length, 1);
			assert.deepStrictEqual(findMarkers(errors), []);
		});

		test('authorization server metadata: a non-success response names the numeric status only', async () => {
			const fetchImpl = async () => metadataResponse(500, async () => JSON.parse(malformedBody));

			const error = await rejection(fetchAuthorizationServerMetadata(`https://user:${URL_USERINFO}@auth.example.com?k=${URL_QUERY}`, { fetch: fetchImpl }));

			assert.deepStrictEqual(findMarkers(error), []);
			const messages = flattenErrors(error).map(e => (e as Error).message);
			assert.strictEqual(messages.length, 3);
			assert.ok(messages.every(message => /^Failed to fetch authorization server metadata from https:\/\/auth\.example\.com\/[^?@]*: 500$/.test(message)), messages.join('\n'));
		});

		test('MCP: the warnings logged for failed resource metadata are clean, and later discovery still succeeds', async () => {
			const logged: string[] = [];
			let call = 0;
			const mockFetch = async () => {
				call++;
				const response = call === 1
					? metadataResponse(404, async () => { throw new Error('unused'); })
					: call === 2
						? metadataResponse(200, async () => ({ resource: 'https://example.com/', authorization_servers: [AUTH_SERVER] }))
						: metadataResponse(200, async () => ({ issuer: AUTH_SERVER, authorization_endpoint: `${AUTH_SERVER}/authorize`, token_endpoint: TOKEN_ENDPOINT, response_types_supported: ['code'] }));
				return { ...response, url: 'https://example.com/mcp', headers: new Headers(), body: null };
			};
			const original = { status: 401, statusText: 'Unauthorized', url: 'https://example.com/mcp', headers: new Headers({ 'WWW-Authenticate': 'Bearer realm="example"' }), body: null, json: async () => ({}), text: async () => '' };

			await createAuthMetadata('https://example.com/mcp', original, {
				launchHeaders: new Map(),
				fetch: mockFetch as never,
				log: (_level, message) => { logged.push(message); }
			});

			assert.ok(logged.some(message => message.includes('Error fetching resource metadata')), 'the metadata errors were logged');
			assert.deepStrictEqual(findMarkers(logged), []);
		});
	});

	suite('device user code', () => {
		test('the user code reaches the modal and the progress message, and is not logged', async () => {
			const { provider, logger, proxy } = createProvider();
			const reports: unknown[] = [];
			fetchQueue.push(respondJson(200, deviceBody), respondJson(200, tokenBody));

			await provider.runFlow(1, reports);

			assert.deepStrictEqual(proxy.deviceModals, [{ userCode: USER_CODE, verificationUri: `${AUTH_SERVER}/activate` }]);
			assert.ok(JSON.stringify(reports).includes(USER_CODE), 'the progress message shows the user code');
			assertClean(logger);
			assert.ok(logger.messages('info').includes('Device code received.'));
		});
	});

	suite('createSession keeps the failure of the last flow', () => {
		test('a known HTTP failure of the last flow survives, and the transition names the flow that failed', async () => {
			const { provider, logger, proxy } = createProvider();
			fetchQueue.push(
				respondJson(400, { error: 'invalid_grant' }),
				respondJson(400, { error: 'invalid_request' })
			);

			const error = await rejection(provider.createSession(['read'], {}));
			assertClean(logger, error);

			assert.strictEqual(error.message, 'Failed to create authentication token: Device code request failed: 400 (invalid_request)');
			assert.strictEqual(proxy.continueNotifications, 1);
			assert.ok(logger.messages('error').includes(`Failed to create token via flow 'URL Handler': Error: Token exchange failed: 400 (invalid_grant)`), logger.messages('error').join('\n'));
		});
	});

	suite('registration reads the body with the shared reader', () => {
		test('an unreadable success body and a malformed success body are different named outcomes with the status', async () => {
			fetchQueue.push(respondUnreadable(200), respond(200, malformedBody));

			const unreadable = await rejection(fetchDynamicRegistration(registrationMetadata, 'Test Client'));
			const malformed = await rejection(fetchDynamicRegistration(registrationMetadata, 'Test Client'));

			assert.strictEqual(unreadable.message, 'Dynamic client registration failed: the response body could not be read (200)');
			assert.strictEqual(malformed.message, 'Dynamic client registration failed: the response body is not valid JSON (200)');
			assert.strictEqual(unreadable.cause, undefined);
			assert.strictEqual(malformed.cause, undefined);
			assert.deepStrictEqual(findMarkers([unreadable, malformed]), []);
		});
	});

	suite('JWT parsing', () => {
		const b64 = (value: unknown) => encodeBase64(VSBuffer.fromString(typeof value === 'string' ? value : JSON.stringify(value)));

		test('a malformed header or payload gives a fixed error with no part of the token', () => {
			for (const token of [
				`${b64(`${PARSER_LEAK} not json`)}.${b64({ sub: 'x' })}.sig`,
				`${b64({ alg: 'none' })}.${b64(`${PARSER_LEAK} not json`)}.sig`
			]) {
				let thrown: unknown;
				try {
					getClaimsFromJWT(token);
				} catch (e) {
					thrown = e;
				}
				assert.ok(thrown instanceof Error);
				assert.ok(/^Failed to parse JWT token/.test(thrown.message));
				assert.strictEqual(thrown.cause, undefined);
				assert.deepStrictEqual(findMarkers(thrown), []);
			}
		});

		test('a valid id token still builds the session account, and a malformed one is not logged', async () => {
			const idToken = `${b64({ alg: 'none' })}.${b64({ sub: 'user-1', preferred_username: 'alice' })}.sig`;
			const { provider, logger } = createProvider({
				initialTokens: [
					{ access_token: STORED_ACCESS_TOKEN, token_type: 'Bearer', id_token: idToken, scope: 'read', created_at: Date.now() },
					{ access_token: STORED_REFRESH_TOKEN, token_type: 'Bearer', id_token: `${PARSER_LEAK}.${ID_TOKEN}.x`, scope: 'read', created_at: Date.now() }
				]
			});

			const sessions = await provider.getSessions(['read'], {});

			assert.strictEqual(sessions.length, 2);
			assert.strictEqual(sessions[0].account.label, 'alice');
			assert.strictEqual(sessions[0].account.id, 'user-1');
			assert.deepStrictEqual(findMarkers(logger.records), []);
		});
	});
});

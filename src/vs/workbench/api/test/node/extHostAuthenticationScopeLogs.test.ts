/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as http from 'http';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IAuthorizationServerMetadata, IAuthorizationTokenResponse } from '../../../../base/common/oauth.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogger, ILoggerService, LogLevel } from '../../../../platform/log/common/log.js';
import { MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';
import { NodeDynamicAuthProvider } from '../../node/extHostAuthentication.js';
import { createMcpHttpHarnessFrom, HARNESS_MCP_URL, harnessResponse, IMcpHttpHarness } from '../common/mcpHttpHandleHarness.js';

// F-SECRETS-5 / R-101 (F-SECRETS-4 review-c1 MUST-4): a challenge URL and every scope that can come from a server (a
// WWW-Authenticate challenge, initial or updated, or the resource metadata's scopes_supported) reach no log argument, in the
// MCP handle or in the dynamic authentication provider (common and node). Logs carry fixed diagnostics and scope COUNTS; the
// values used for authentication keep the markers.
const MARKERS = {
	challengePath: 'MARKER-CHALLENGE-PATH-1a7',
	challengeQuery: 'MARKER-CHALLENGE-QUERY-2b8',
	scopeInitial: 'MARKER-SCOPE-INITIAL-3c9',
	scopeUpdated: 'MARKER-SCOPE-UPDATED-4da',
	metadataScope: 'MARKER-META-SCOPE-5eb',
};
const ALL_MARKERS = Object.values(MARKERS);

const AUTH_SERVER = 'https://auth.example.com';
const TOKEN_ENDPOINT = `${AUTH_SERVER}/token`;
const DEVICE_ENDPOINT = `${AUTH_SERVER}/device`;
const CHALLENGE_URL = `https://mcp.example.com/prm/${MARKERS.challengePath}?k=${MARKERS.challengeQuery}`;
// Scopes as the MCP handle hands them to authentication: every one of them server-derived.
const SERVER_SCOPES = [MARKERS.scopeInitial, MARKERS.scopeUpdated, MARKERS.metadataScope];

function markersIn(texts: readonly string[]): string[] {
	return ALL_MARKERS.filter(marker => texts.some(text => text.includes(marker)));
}

/** Every string reachable from a log argument (strings, primitives, own properties, an error's name, message and stack). */
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
	flush(): void { }

	/** Every string of every log argument, at every level. */
	texts(): string[] {
		return this.records.flatMap(record => collectStrings(record.args));
	}
}

class TestProxy {
	readonly deviceModals: string[] = [];
	async $setSessionsForDynamicAuthProvider(): Promise<void> { }
	async $waitForUriHandler(): Promise<unknown> {
		return { scheme: 'vscode', authority: 'dynamicauthprovider', path: '/redirect', query: 'nonce=n&code=the-code', fragment: '' };
	}
	async $showContinueNotification(): Promise<boolean> { return false; }
	async $showDeviceCodeModal(userCode: string): Promise<boolean> {
		this.deviceModals.push(userCode);
		return true;
	}
	async $promptForClientRegistration(): Promise<undefined> { return undefined; }
	async $registerDynamicAuthenticationProvider(): Promise<void> { }
}

class TestProvider extends NodeDynamicAuthProvider {
	/** Runs the create flow with the given label with the given scopes. */
	runFlow(label: string, scopes: string[]) {
		const flow = this._createFlows.find(f => f.label === label);
		assert.ok(flow, `no create flow '${label}': ${this._createFlows.map(f => f.label).join(', ')}`);
		return flow.handler(scopes, { report: () => undefined }, CancellationToken.None);
	}
}

suite('F-SECRETS-5 R-101: no challenge URL or server-derived scope reaches a log argument', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('MCP: discovery and a scope update', () => {
		function metadataTransport(challenge: (nth: number) => string, onRequest: (url: string, method: string | undefined) => void) {
			let posts = 0;
			return async (url: string, init: { method: string } | undefined) => {
				onRequest(url, init?.method);
				if (url === HARNESS_MCP_URL && init?.method === 'POST') {
					const header = challenge(++posts);
					return header ? harnessResponse(401, url, { 'WWW-Authenticate': header }) : harnessResponse(202, url);
				}
				if (url === CHALLENGE_URL && init?.method === 'GET') {
					return harnessResponse(200, url, { 'content-type': 'application/json' }, JSON.stringify({
						resource: HARNESS_MCP_URL,
						authorization_servers: [AUTH_SERVER],
						scopes_supported: [MARKERS.metadataScope],
					}));
				}
				return harnessResponse(404, url);
			};
		}

		/** The distinct scope lists, in first-seen order (the async-notification backchannel asks for the token too). */
		function distinct(scopeLists: (string[] | undefined)[]): (string[] | undefined)[] {
			const seen = new Map<string, string[] | undefined>();
			for (const scopes of scopeLists) {
				seen.set(JSON.stringify(scopes), scopes);
			}
			return [...seen.values()];
		}

		function assertNoMarkerLogged(harness: IMcpHttpHarness): void {
			assert.ok(harness.logs.length > 0, 'the handle logged nothing: the recorder is not attached');
			assert.deepStrictEqual(markersIn([...harness.logs, ...harness.states.map(state => JSON.stringify(state))]), [], `a marker reached a log line:\n${harness.logs.join('\n')}`);
		}

		test('challenge URL, initial and updated challenge scopes: logged as fixed text and counts; authentication gets the scopes', async () => {
			const tokenScopes: (string[] | undefined)[] = [];
			const requested: string[] = [];
			const harness = createMcpHttpHarnessFrom({
				getToken: async authDetails => {
					tokenScopes.push(authDetails.scopes);
					return 'the-token';
				},
				getTokenForProvider: () => Promise.reject(new Error('not used')),
				authentication: undefined,
				launchHeaders: [],
				transport: metadataTransport(nth => {
					switch (nth) {
						case 1: return `Bearer resource_metadata="${CHALLENGE_URL}", scope="${MARKERS.scopeInitial} read"`;
						case 3: return `Bearer scope="${MARKERS.scopeUpdated}"`;
						default: return '';
					}
				}, (url, method) => requested.push(`${method} ${url}`)),
			});
			store.add(harness.handle);

			await harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}'); // discovery
			await harness.handle.send('{"jsonrpc":"2.0","id":2,"method":"ping"}'); // scope update

			assert.ok(requested.includes(`GET ${CHALLENGE_URL}`), `the challenge URL was used: ${requested.join(', ')}`);
			// Values preserved: the scopes handed to authentication carry the markers (the initial ones until the update).
			assert.deepStrictEqual(distinct(tokenScopes), [[MARKERS.scopeInitial, 'read'], [MARKERS.scopeUpdated]]);
			assertNoMarkerLogged(harness);
			for (const line of [
				'Found resource_metadata challenge in WWW-Authenticate header',
				'Found scope challenge in WWW-Authenticate header: 2 scope(s)',
				'Found scope challenge in WWW-Authenticate header: 1 scope(s)',
				'Scopes changed from 2 scope(s) to 1 scope(s), updating',
			]) {
				assert.ok(harness.logs.includes(line), `missing '${line}':\n${harness.logs.join('\n')}`);
			}
		});

		test('metadata scopes_supported: not logged; authentication gets them', async () => {
			const tokenScopes: (string[] | undefined)[] = [];
			const harness = createMcpHttpHarnessFrom({
				getToken: async authDetails => {
					tokenScopes.push(authDetails.scopes);
					return 'the-token';
				},
				getTokenForProvider: () => Promise.reject(new Error('not used')),
				authentication: undefined,
				launchHeaders: [],
				transport: metadataTransport(nth => nth === 1 ? `Bearer resource_metadata="${CHALLENGE_URL}"` : '', () => { }),
			});
			store.add(harness.handle);

			await harness.handle.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');

			assert.deepStrictEqual(distinct(tokenScopes), [[MARKERS.metadataScope]]);
			assertNoMarkerLogged(harness);
		});
	});

	suite('dynamic authentication provider: session retrieval and creation', () => {
		const realFetch = globalThis.fetch;
		let fetchCalls: { url: string; body: string | undefined }[];
		let fetchQueue: ((url: string) => Response)[];

		setup(() => {
			fetchCalls = [];
			fetchQueue = [];
			globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				fetchCalls.push({ url, body: init?.body === undefined ? undefined : String(init.body) });
				const responder = fetchQueue.shift();
				assert.ok(responder, `unexpected fetch of ${url}`);
				return responder(url);
			}) as typeof fetch;
		});

		teardown(() => {
			globalThis.fetch = realFetch;
		});

		const tokenBody = { access_token: 'the-access-token', token_type: 'Bearer', refresh_token: 'the-refresh-token', expires_in: 3600, scope: SERVER_SCOPES.join(' ') };

		function respondJson(body: unknown): (url: string) => Response {
			return () => new Response(JSON.stringify(body), { status: 200, statusText: 'OK' });
		}

		function createProvider(options: { isRemote: boolean; initialTokens?: unknown[]; onOpenUri?: (url: string) => Promise<void> }) {
			const logger = store.add(new RecordingLogger());
			const proxy = new TestProxy();
			const openedUris: string[] = [];
			const extHostWindow = {
				openUri: async (url: string) => {
					openedUris.push(url);
					await options.onOpenUri?.(url);
					return true;
				}
			} as unknown as IExtHostWindow;
			const urls = { createAppUri: async () => URI.parse('vscode://dynamicauthprovider/auth.example.com/authorize?nonce=n') } as unknown as IExtHostUrlsService;
			const initData = { environment: { appUriScheme: 'vscode', appName: 'Test' }, remote: { isRemote: options.isRemote } } as unknown as IExtHostInitDataService;
			const progress = {
				withProgressFromSource: async (_source: unknown, _options: unknown, task: (progress: { report(): void }, token: CancellationToken) => Thenable<unknown>) => task({ report: () => undefined }, CancellationToken.None)
			} as unknown as IExtHostProgress;
			const metadata: IAuthorizationServerMetadata = {
				issuer: AUTH_SERVER,
				authorization_endpoint: `${AUTH_SERVER}/authorize`,
				token_endpoint: TOKEN_ENDPOINT,
				device_authorization_endpoint: DEVICE_ENDPOINT,
				response_types_supported: ['code'],
			};
			const provider = store.add(new TestProvider(
				extHostWindow, urls, initData, progress, { createLogger: () => logger } as unknown as ILoggerService,
				proxy as unknown as MainThreadAuthenticationShape,
				URI.parse(AUTH_SERVER), metadata, undefined,
				'client-id', undefined,
				store.add(new Emitter<{ authProviderId: string; clientId: string; tokens: (IAuthorizationTokenResponse & { created_at: number })[] | undefined }>()), options.initialTokens ?? []
			));
			return { provider, logger, openedUris };
		}

		function assertNoMarkerLogged(logger: RecordingLogger): void {
			assert.ok(logger.records.length > 0, 'the provider logged nothing: the recorder is not attached');
			assert.deepStrictEqual(markersIn(logger.texts()), [], `a marker reached a log argument:\n${logger.texts().join('\n')}`);
		}

		test('getSessions with a refresh: counts only; the refreshed session keeps the scopes', async () => {
			const { provider, logger } = createProvider({
				isRemote: true,
				initialTokens: [{ access_token: 'stored-access', token_type: 'Bearer', refresh_token: 'stored-refresh', expires_in: 60, scope: SERVER_SCOPES.join(' '), created_at: 0 }],
			});
			fetchQueue.push(respondJson(tokenBody));

			const sessions = await provider.getSessions(SERVER_SCOPES, {});

			assert.strictEqual(sessions.length, 1);
			assert.deepStrictEqual(sessions[0].scopes, SERVER_SCOPES, 'the session keeps the scope values');
			assertNoMarkerLogged(logger);
			const infos = logger.records.filter(r => r.level === 'info').map(r => String(r.args[0]));
			for (const line of ['Getting sessions for 3 scope(s)', 'Found 1 sessions for 3 scope(s)', 'Successfully created a new token for 3 scope(s).']) {
				assert.ok(infos.includes(line), `missing '${line}':\n${infos.join('\n')}`);
			}
		});

		test('createSession (URL handler flow) and removeSession: counts only; the authorization URL carries the scopes', async () => {
			const { provider, logger, openedUris } = createProvider({ isRemote: true });
			fetchQueue.push(respondJson(tokenBody));

			const session = await provider.createSession(SERVER_SCOPES, {});
			await provider.removeSession(session.id);

			assert.deepStrictEqual(session.scopes, SERVER_SCOPES, 'the session keeps the scope values');
			assert.strictEqual(new URL(openedUris[0]).searchParams.get('scope'), SERVER_SCOPES.join(' '), 'the authorization request carries the scopes');
			assertNoMarkerLogged(logger);
			const infos = logger.records.filter(r => r.level === 'info').map(r => String(r.args[0]));
			for (const line of ['Creating session for 3 scope(s)', 'Opening authorization URL for 3 scope(s)', 'Authorization code received for 3 scope(s)']) {
				assert.ok(infos.includes(line), `missing '${line}':\n${infos.join('\n')}`);
			}
			assert.ok(infos.some(l => l.startsWith('Created refreshable session for 3 scope(s)')), infos.join('\n'));
			assert.ok(infos.some(l => l.startsWith('Removed token for session: ') && l.endsWith(' with 3 scope(s)')), infos.join('\n'));
		});

		test('loopback flow (node): counts only; the authorization URL carries the scopes', async () => {
			const { provider, logger, openedUris } = createProvider({
				isRemote: false,
				onOpenUri: async url => {
					// The browser: follow the authorization URL's redirect to the loopback server with a code.
					const authorizationUrl = new URL(url);
					const redirect = new URL(authorizationUrl.searchParams.get('redirect_uri')!);
					redirect.searchParams.set('code', 'the-code');
					redirect.searchParams.set('state', authorizationUrl.searchParams.get('state')!);
					await new Promise<void>((resolve, reject) => http.get(redirect.toString(), res => { res.resume(); res.on('end', () => resolve()); }).on('error', reject));
				},
			});
			fetchQueue.push(respondJson(tokenBody));

			const token = await provider.runFlow('Loopback Server', SERVER_SCOPES);

			assert.strictEqual(token.access_token, 'the-access-token');
			assert.strictEqual(new URL(openedUris[0]).searchParams.get('scope'), SERVER_SCOPES.join(' '), 'the authorization request carries the scopes');
			assertNoMarkerLogged(logger);
			const infos = logger.records.filter(r => r.level === 'info').map(r => String(r.args[0]));
			for (const line of ['Opening authorization URL for 3 scope(s)', 'Authorization code received for 3 scope(s)']) {
				assert.ok(infos.includes(line), `missing '${line}':\n${infos.join('\n')}`);
			}
		});

		test('device code flow (node): counts only; the device request carries the scopes', async () => {
			const { provider, logger } = createProvider({ isRemote: true });
			fetchQueue.push(
				respondJson({ device_code: 'the-device-code', user_code: 'the-user-code', verification_uri: `${AUTH_SERVER}/activate`, expires_in: 60, interval: 0.001 }),
				respondJson(tokenBody),
			);

			const token = await provider.runFlow('Device Code', SERVER_SCOPES);

			assert.strictEqual(token.access_token, 'the-access-token');
			assert.strictEqual(new URLSearchParams(fetchCalls[0].body).get('scope'), SERVER_SCOPES.join(' '), 'the device request carries the scopes');
			assertNoMarkerLogged(logger);
			const infos = logger.records.filter(r => r.level === 'info').map(r => String(r.args[0]));
			for (const line of ['Starting device code flow for 3 scope(s)', 'Device code flow completed successfully for 3 scope(s)']) {
				assert.ok(infos.includes(line), `missing '${line}':\n${infos.join('\n')}`);
			}
		});
	});
});

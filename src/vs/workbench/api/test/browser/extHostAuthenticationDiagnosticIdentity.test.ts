/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as sinon from 'sinon';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IAuthorizationProtectedResourceMetadata, IAuthorizationServerMetadata, IAuthorizationTokenResponse } from '../../../../base/common/oauth.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AbstractLoggerService, ILogger, ILoggerOptions, LogLevel, NullLogger, NullLogService } from '../../../../platform/log/common/log.js';
import { MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { authProviderIdForDiagnostics, DynamicAuthClientRejectedError, DynamicAuthSessionExpiredError, DynamicAuthSessionPersistError, DynamicAuthSessionRefreshError, ExtHostAuthentication } from '../../common/extHostAuthentication.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostRpcService } from '../../common/extHostRpcService.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';

// review QL-G-LOGIN-SECRETS c1 M3: a dynamic provider's id is its issuer string (and resource), and its resource name is
// server text. Independent markers in the issuer's user info, path and query and in the resource's name, path and query
// must reach no log argument, no logger metadata (id, name, file resource) and no rejected error, on every path: a
// successful registration (with and without dynamic client registration), a refresh that fails, an expired session, a
// rejected client, a storage failure, and a call for a provider that is not registered. The protocol id is unchanged.
// review QL-G-LOGIN-SECRETS c1 M5: the storage failure's error carries markers in its name, message, stack and cause.

const ISSUER_USERINFO = 'MARK-ISSUER-USERINFO-1a2b';
const ISSUER_PATH = 'MARK-ISSUER-PATH-3c4d';
const ISSUER_QUERY = 'MARK-ISSUER-QUERY-5e6f';
const RESOURCE_NAME = 'MARK-RESOURCE-NAME-7a8b';
const RESOURCE_PATH = 'MARK-RESOURCE-PATH-9c0d';
const RESOURCE_QUERY = 'MARK-RESOURCE-QUERY-e1f2';
const STORAGE_NAME = 'MARK-STORAGE-NAME-a3b4';
const STORAGE_MESSAGE = 'MARK-STORAGE-MESSAGE-c5d6';
const STORAGE_STACK = 'MARK-STORAGE-STACK-e7f8';
const STORAGE_CAUSE = 'MARK-STORAGE-CAUSE-0a1b';
const MARKERS = [ISSUER_USERINFO, ISSUER_PATH, ISSUER_QUERY, RESOURCE_NAME, RESOURCE_PATH, RESOURCE_QUERY, STORAGE_NAME, STORAGE_MESSAGE, STORAGE_STACK, STORAGE_CAUSE];

const ISSUER = `https://user:${ISSUER_USERINFO}@issuer.example/tenant/${ISSUER_PATH}?key=${ISSUER_QUERY}`;
const TOKEN_ENDPOINT = 'https://issuer.example/token';
const REGISTRATION_ENDPOINT = 'https://issuer.example/register';
const RESOURCE: IAuthorizationProtectedResourceMetadata = {
	resource: `https://mcp.example.com/${RESOURCE_PATH}?k=${RESOURCE_QUERY}`,
	resource_name: `user:${RESOURCE_NAME}@issuer.example`,
};
const SERVER_METADATA: IAuthorizationServerMetadata = {
	issuer: ISSUER,
	response_types_supported: ['code'],
	token_endpoint: TOKEN_ENDPOINT,
	registration_endpoint: REGISTRATION_ENDPOINT,
};

type StoredToken = IAuthorizationTokenResponse & { created_at: number };
const EXPIRED_REFRESHABLE: StoredToken = { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', scope: 'read', expires_in: 3600, created_at: 1 };
const EXPIRED_NOT_REFRESHABLE: StoredToken = { access_token: 'at-2', token_type: 'Bearer', scope: 'read', expires_in: 3600, created_at: 1 };

/** A storage error from another process with a marker in each of its name, message, stack and cause. */
function markedStorageError(): Error {
	const error = new Error(`keychain refused ${STORAGE_MESSAGE}`, { cause: new Error(STORAGE_CAUSE) });
	error.name = STORAGE_NAME;
	error.stack = `${STORAGE_NAME}: ${STORAGE_MESSAGE}\n    at ${STORAGE_STACK}`;
	return error;
}

/** Every string reachable from a value; an Error contributes its name, message, stack and its whole cause chain. */
function collectStrings(value: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
	if (typeof value === 'string') {
		out.push(value);
	} else if (typeof value !== 'object' && typeof value !== 'function' || value === null) {
		out.push(String(value));
	} else if (!seen.has(value)) {
		seen.add(value);
		if (value instanceof Error) {
			out.push(value.name, value.message, value.stack ?? '');
			collectStrings(value.cause, out, seen);
		}
		if (value instanceof URI) {
			out.push(value.toString(), value.toString(true), value.path);
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

class RecordingLogger extends NullLogger {
	readonly args: unknown[][] = [];
	override trace(...args: unknown[]): void { this.args.push(args); }
	override debug(...args: unknown[]): void { this.args.push(args); }
	override info(...args: unknown[]): void { this.args.push(args); }
	override warn(...args: unknown[]): void { this.args.push(args); }
	override error(...args: unknown[]): void { this.args.push(args); }
}

class RecordingLogService extends NullLogService {
	readonly args: unknown[][] = [];
	override trace(...args: unknown[]): void { this.args.push(args); }
	override debug(...args: unknown[]): void { this.args.push(args); }
	override info(...args: unknown[]): void { this.args.push(args); }
	override warn(...args: unknown[]): void { this.args.push(args); }
	override error(...args: unknown[]): void { this.args.push(args); }
}

/** The production logger service's id-to-file-resource mapping, with loggers that record their arguments. */
class RecordingLoggerService extends AbstractLoggerService {
	readonly loggers: RecordingLogger[] = [];
	constructor() {
		super(LogLevel.Trace, URI.file('/logs'));
	}
	protected override doCreateLogger(_resource: URI, _logLevel: LogLevel, _options?: ILoggerOptions): ILogger {
		const logger = new RecordingLogger();
		this.loggers.push(logger);
		return logger;
	}
}

suite('QL-G-LOGIN-SECRETS c1 M3: a dynamic provider\'s identity reaches no diagnostic', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let fetchStub: sinon.SinonStub;
	let tokenResponse: () => Promise<Response>;
	setup(() => {
		tokenResponse = async () => new Response('', { status: 500 });
		fetchStub = sinon.stub(globalThis, 'fetch');
		fetchStub.callsFake(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === TOKEN_ENDPOINT) {
				return tokenResponse();
			}
			if (url === REGISTRATION_ENDPOINT) {
				return new Response(JSON.stringify({ client_id: 'client-registered' }), { status: 201 });
			}
			return new Response('', { status: 404 });
		});
	});
	teardown(() => {
		fetchStub.restore();
	});

	function createHost() {
		const logService = new RecordingLogService();
		const loggerService = store.add(new RecordingLoggerService());
		const calls = { failPersistence: false, registrations: [] as { id: string; label: string }[] };
		const proxy: Partial<MainThreadAuthenticationShape> = {
			$registerDynamicAuthenticationProvider: async details => { calls.registrations.push({ id: details.id, label: details.label }); },
			$setSessionsForDynamicAuthProvider: async () => {
				if (calls.failPersistence) {
					throw markedStorageError();
				}
			},
			$sendDidChangeSessions: async () => { },
			$unregisterAuthenticationProvider: async () => { },
			$promptForClientRegistration: async () => ({ clientId: 'client-typed' }),
		};
		const host = new ExtHostAuthentication(
			{ getProxy: () => proxy } as unknown as IExtHostRpcService,
			{ environment: { appName: 'Test', appUriScheme: 'test' } } as unknown as IExtHostInitDataService,
			{} as IExtHostWindow,
			{} as IExtHostUrlsService,
			{ withProgressFromSource: (_source: unknown, _options: unknown, task: (progress: { report(): void }, token: CancellationToken) => Promise<unknown>) => task({ report() { } }, CancellationToken.None) } as unknown as IExtHostProgress,
			loggerService,
			logService,
		);
		const registered: string[] = [];
		const register = async (resource: IAuthorizationProtectedResourceMetadata | undefined, clientId: string | undefined, tokens: StoredToken[]) => {
			const id = await host.$registerDynamicAuthProvider(URI.parse(ISSUER).toJSON(), SERVER_METADATA, resource, clientId, undefined, tokens);
			registered.push(id);
			return id;
		};
		/** Unregisters (and so disposes) every provider registered here; awaited, as unregistering runs in the provider's order. */
		const unregisterAll = () => Promise.all(registered.map(id => host.$onDidUnregisterAuthenticationProvider(id)));
		/** Every diagnostic: log arguments of the host and of each provider logger, and every registered logger's metadata. */
		const diagnostics = () => ({
			log: logService.args,
			loggers: loggerService.loggers.map(l => l.args),
			metadata: [...loggerService.getRegisteredLoggers()],
		});
		return { host, register, unregisterAll, calls, diagnostics, loggerService };
	}

	async function rejection(promise: Promise<unknown>): Promise<unknown> {
		try {
			await promise;
		} catch (error) {
			return error;
		}
		assert.fail('expected a rejection');
	}

	// Each test checks for markers first, then the fixed text that replaced them.
	for (const [mode, resource, clientId] of [['dynamic client registration, with a resource', RESOURCE, undefined], ['a stored client id, without a resource', undefined, 'client-1']] as const) {
		test(`registration (${mode}): logger id, name and file resource, and every log line, carry no marker; the protocol id is unchanged`, async () => {
			const { register, unregisterAll, calls, diagnostics, loggerService } = createHost();
			const id = await register(resource, clientId, []);
			await unregisterAll();

			assertNoMarker('registration diagnostics', diagnostics());
			assert.ok(id.includes(ISSUER_USERINFO) && id.includes(ISSUER_QUERY), 'the protocol id is the issuer string itself');
			const metadata = [...loggerService.getRegisteredLoggers()];
			assert.strictEqual(metadata.length, 1);
			const diagnosticId = authProviderIdForDiagnostics(id);
			assert.match(diagnosticId, /^dynamic-auth-provider-\d+$/);
			assert.strictEqual(metadata[0].id, diagnosticId);
			assert.strictEqual(metadata[0].name, `Auth: issuer.example (${diagnosticId})`);
			assert.strictEqual(metadata[0].resource.path, `/logs/${diagnosticId}.log`);
			// The label is for display: the resource name when given, otherwise the issuer's host without its user info.
			assert.deepStrictEqual(calls.registrations.map(r => r.label), [resource ? resource.resource_name : 'issuer.example']);
		});
	}

	const failures: [string, StoredToken, () => Promise<Response>, boolean, new (...args: never[]) => Error][] = [
		['refresh failure', EXPIRED_REFRESHABLE, async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }), false, DynamicAuthSessionRefreshError],
		['expiry', EXPIRED_NOT_REFRESHABLE, async () => new Response('', { status: 500 }), false, DynamicAuthSessionExpiredError],
		['client rejection', EXPIRED_REFRESHABLE, async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }), false, DynamicAuthClientRejectedError],
		['storage failure', EXPIRED_REFRESHABLE, async () => new Response(JSON.stringify({ access_token: 'at-3', refresh_token: 'rt-3', token_type: 'Bearer', scope: 'read', expires_in: 3600 }), { status: 200 }), true, DynamicAuthSessionPersistError],
	];
	for (const [name, token, respond, failPersistence, expected] of failures) {
		for (const [mode, resource] of [['with a resource name', RESOURCE], ['without a resource', undefined]] as const) {
			test(`${name} (${mode}): the rejected error and every log line carry no marker`, async () => {
				tokenResponse = respond;
				const { host, register, unregisterAll, calls, diagnostics } = createHost();
				const id = await register(resource, 'client-1', [token]);
				calls.failPersistence = failPersistence;

				const error = await rejection(host.$getSessions(id, ['read'], {}));
				await unregisterAll();

				assertNoMarker('the rejected error', error);
				assertNoMarker('the diagnostics', diagnostics());
				assert.ok(error instanceof expected, `expected ${expected.name}, got ${error}`);
				if (failPersistence) {
					// M5: a fixed category, never the storage error's name, in the log line and in the error.
					assert.ok(error.message.includes('the secret storage did not accept the write'), error.message);
					assert.strictEqual(error.cause, undefined);
				} else {
					assert.ok(error.message.includes('\'issuer.example\''), `the error names the issuer's host: ${error.message}`);
				}
			});
		}
	}

	test('a call for a provider that is not registered rejects without the provider id', async () => {
		const { host, diagnostics } = createHost();
		const unknownId = `${ISSUER} ${RESOURCE.resource}`;
		for (const call of [
			() => host.$getSessions(unknownId, ['read'], {}),
			() => host.$createSession(unknownId, ['read'], {}),
			() => host.$removeSession(unknownId, 'session'),
			() => host.$getSessionsFromChallenges(unknownId, { challenges: [] }, {}),
			() => host.$createSessionFromChallenges(unknownId, { challenges: [] }, {}),
		]) {
			const error = await rejection(call());
			assertNoMarker('the rejected error', error);
			assert.ok(error instanceof Error && error.message.includes(authProviderIdForDiagnostics(unknownId)), `${error}`);
		}
		assertNoMarker('the diagnostics', diagnostics());
	});
});

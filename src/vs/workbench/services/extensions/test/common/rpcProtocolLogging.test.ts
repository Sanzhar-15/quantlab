/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI, UriComponents } from '../../../../../base/common/uri.js';
import { IMessagePassingProtocol } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ExtensionHostKind } from '../../common/extensionHostKind.js';
import { RPCLogger } from '../../common/extensionHostManager.js';
import { createProxyIdentifier } from '../../common/proxyIdentifier.js';
import { IRPCProtocolLogger, RPCProtocol, RPCPayloadShape, RequestInitiator } from '../../common/rpcProtocol.js';

/**
 * Collects every piece of text reachable from a value: strings, object keys (own, including
 * non-enumerable such as Error message and stack), numbers, and the bytes of buffers.
 */
function deepText(value: unknown, out: string[] = [], seen: Set<unknown> = new Set()): string[] {
	switch (typeof value) {
		case 'string':
			out.push(value);
			return out;
		case 'number':
		case 'bigint':
		case 'boolean':
			out.push(String(value));
			return out;
		case 'symbol':
			out.push(String(value.description));
			return out;
		case 'function':
		case 'undefined':
			return out;
	}
	if (typeof value !== 'object' || value === null || seen.has(value)) {
		return out;
	}
	seen.add(value);
	if (ArrayBuffer.isView(value)) {
		out.push(new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)));
		return out;
	}
	if (value instanceof ArrayBuffer) {
		out.push(new TextDecoder().decode(new Uint8Array(value)));
		return out;
	}
	for (const key of Object.getOwnPropertyNames(value)) {
		out.push(key);
		deepText(Reflect.get(value, key), out, seen);
	}
	return out;
}

interface ILoggerCall {
	readonly direction: 'in' | 'out';
	readonly msgLength: number;
	readonly req: number;
	readonly initiator: RequestInitiator;
	readonly str: string;
	readonly shape: RPCPayloadShape | undefined;
	/** every argument exactly as the logger received it */
	readonly rawArguments: unknown[];
}

class RecordingLogger implements IRPCProtocolLogger {
	public readonly calls: ILoggerCall[] = [];

	logIncoming(msgLength: number, req: number, initiator: RequestInitiator, str: string, shape?: RPCPayloadShape): void {
		this.calls.push({ direction: 'in', msgLength, req, initiator, str, shape, rawArguments: [msgLength, req, initiator, str, shape] });
	}

	logOutgoing(msgLength: number, req: number, initiator: RequestInitiator, str: string, shape?: RPCPayloadShape): void {
		this.calls.push({ direction: 'out', msgLength, req, initiator, str, shape, rawArguments: [msgLength, req, initiator, str, shape] });
	}
}

/** The real RPCLogger plus a recording logger, as one logger */
class TeeLogger implements IRPCProtocolLogger {
	constructor(private readonly _a: IRPCProtocolLogger, private readonly _b: IRPCProtocolLogger) { }

	logIncoming(msgLength: number, req: number, initiator: RequestInitiator, str: string, shape?: RPCPayloadShape): void {
		this._a.logIncoming(msgLength, req, initiator, str, shape);
		this._b.logIncoming(msgLength, req, initiator, str, shape);
	}

	logOutgoing(msgLength: number, req: number, initiator: RequestInitiator, str: string, shape?: RPCPayloadShape): void {
		this._a.logOutgoing(msgLength, req, initiator, str, shape);
		this._b.logOutgoing(msgLength, req, initiator, str, shape);
	}
}

// Window (main thread) side, requests sent window -> extension host and the replies to them
const M_GET_SESSIONS_OPTIONS_SECRET = 'MARK-W2E-GETSESSIONS-CLIENT-SECRET-5d01';
const M_CREATE_SESSION_OPTIONS_CODE = 'MARK-W2E-CREATESESSION-AUTH-CODE-b7c2';
const M_EXT_REPLY_ACCESS = 'MARK-E2W-REPLY-SESSION-ACCESS-TOKEN-91ae';
const M_EXT_REPLY_REFRESH = 'MARK-E2W-REPLY-SESSION-REFRESH-TOKEN-37fd';
const M_EXT_REPLY_ID = 'MARK-E2W-REPLY-SESSION-ID-TOKEN-c648';
const M_EXT_ERROR_MESSAGE = 'MARK-E2W-ERROR-MESSAGE-0e5b';
const M_EXT_ERROR_STACK = 'MARK-E2W-ERROR-STACK-d913';

// Extension host side, requests sent extension host -> window and the replies to them
const M_REG_CLIENT_SECRET = 'MARK-EXT-REG-CLIENT-SECRET-48ca';
const M_REG_ACCESS = 'MARK-EXT-REG-INITIAL-ACCESS-TOKEN-a2f6';
const M_REG_REFRESH = 'MARK-EXT-REG-INITIAL-REFRESH-TOKEN-6c19';
const M_REG_ID = 'MARK-EXT-REG-INITIAL-ID-TOKEN-f580';
const M_SET_ACCESS = 'MARK-EXT-SETSESSIONS-ACCESS-TOKEN-2b7d';
const M_SET_REFRESH = 'MARK-EXT-SETSESSIONS-REFRESH-TOKEN-8e43';
const M_SET_ID = 'MARK-EXT-SETSESSIONS-ID-TOKEN-1d9a';
const M_WAIT_REQUEST_QUERY = 'MARK-EXT-WAITURI-EXPECTED-QUERY-c07e';
const M_WAIT_REPLY_CODE = 'MARK-WIN-REPLY-CALLBACK-AUTH-CODE-73b8';
const M_PROMPT_REPLY_SECRET = 'MARK-WIN-REPLY-CLIENT-SECRET-e1a4';
const M_WIN_ERROR_MESSAGE = 'MARK-WIN-ERROR-MESSAGE-5f62';
const M_WIN_ERROR_STACK = 'MARK-WIN-ERROR-STACK-9a0c';

const ALL_MARKERS = [
	M_GET_SESSIONS_OPTIONS_SECRET, M_CREATE_SESSION_OPTIONS_CODE,
	M_EXT_REPLY_ACCESS, M_EXT_REPLY_REFRESH, M_EXT_REPLY_ID, M_EXT_ERROR_MESSAGE, M_EXT_ERROR_STACK,
	M_REG_CLIENT_SECRET, M_REG_ACCESS, M_REG_REFRESH, M_REG_ID,
	M_SET_ACCESS, M_SET_REFRESH, M_SET_ID,
	M_WAIT_REQUEST_QUERY, M_WAIT_REPLY_CODE, M_PROMPT_REPLY_SECRET, M_WIN_ERROR_MESSAGE, M_WIN_ERROR_STACK
];

suite('RPCProtocol logging carries no payload value', () => {

	let disposables: DisposableStore;

	class MessagePassingProtocol implements IMessagePassingProtocol {
		private _pair?: MessagePassingProtocol;

		private readonly _onMessage = new Emitter<VSBuffer>();
		public readonly onMessage: Event<VSBuffer> = this._onMessage.event;

		public setPair(other: MessagePassingProtocol) {
			this._pair = other;
		}

		public send(buffer: VSBuffer): void {
			Promise.resolve().then(() => {
				this._pair!._onMessage.fire(buffer);
			});
		}
	}

	/** what the window side (the recipient of the extension host's calls) was handed */
	const receivedByWindow: unknown[][] = [];
	/** what the extension host side (the recipient of the window's calls) was handed */
	const receivedByExtHost: unknown[][] = [];

	class MainThreadAuthActor {
		$registerDynamicAuthProvider(...args: unknown[]): Promise<string> {
			receivedByWindow.push(args);
			return Promise.resolve('provider-id');
		}
		$setSessionsForDynamicAuthProvider(...args: unknown[]): Promise<void> {
			receivedByWindow.push(args);
			return Promise.resolve();
		}
		$waitForUriHandler(...args: unknown[]): Promise<UriComponents> {
			receivedByWindow.push(args);
			return Promise.resolve(URI.parse(`http://localhost:33418/callback?code=${M_WAIT_REPLY_CODE}&state=s`));
		}
		$promptForClientRegistration(...args: unknown[]): Promise<{ clientId: string; clientSecret: string }> {
			receivedByWindow.push(args);
			return Promise.resolve({ clientId: 'client-id', clientSecret: M_PROMPT_REPLY_SECRET });
		}
		$failInWindow(...args: unknown[]): Promise<void> {
			receivedByWindow.push(args);
			const err = new Error(`rejected: ${M_WIN_ERROR_MESSAGE}`);
			err.stack = `Error: rejected\n    at somewhere (${M_WIN_ERROR_STACK})`;
			return Promise.reject(err);
		}
	}

	class ExtHostAuthActor {
		$getSessions(...args: unknown[]): Promise<unknown[]> {
			receivedByExtHost.push(args);
			return Promise.resolve([{ id: 's1', accessToken: M_EXT_REPLY_ACCESS, refreshToken: M_EXT_REPLY_REFRESH, idToken: M_EXT_REPLY_ID }]);
		}
		$createSession(...args: unknown[]): Promise<unknown> {
			receivedByExtHost.push(args);
			return Promise.resolve({ id: 's2', accessToken: M_EXT_REPLY_ACCESS, refreshToken: M_EXT_REPLY_REFRESH, idToken: M_EXT_REPLY_ID });
		}
		$failInExtHost(...args: unknown[]): Promise<void> {
			receivedByExtHost.push(args);
			const err = new Error(`rejected: ${M_EXT_ERROR_MESSAGE}`);
			err.stack = `Error: rejected\n    at somewhere (${M_EXT_ERROR_STACK})`;
			return Promise.reject(err);
		}
	}

	const mainIdentifier = createProxyIdentifier<MainThreadAuthActor>('rpcLoggingTestMainThreadAuth');
	const extIdentifier = createProxyIdentifier<ExtHostAuthActor>('rpcLoggingTestExtHostAuth');

	let consoleLogCalls: unknown[][];
	let originalConsoleLog: typeof console.log;
	let windowLogger: RecordingLogger;
	let extHostLogger: RecordingLogger;
	let mainProxy: MainThreadAuthActor; // called by the extension host side
	let extProxy: ExtHostAuthActor; // called by the window side

	setup(() => {
		disposables = new DisposableStore();
		receivedByWindow.length = 0;
		receivedByExtHost.length = 0;

		consoleLogCalls = [];
		originalConsoleLog = console.log;
		console.log = (...args: unknown[]) => { consoleLogCalls.push(args); };

		const extProtocol = new MessagePassingProtocol();
		const windowProtocol = new MessagePassingProtocol();
		extProtocol.setPair(windowProtocol);
		windowProtocol.setPair(extProtocol);

		extHostLogger = new RecordingLogger();
		windowLogger = new RecordingLogger();
		const extRpc = disposables.add(new RPCProtocol(extProtocol, new TeeLogger(new RPCLogger(ExtensionHostKind.LocalProcess), extHostLogger)));
		const windowRpc = disposables.add(new RPCProtocol(windowProtocol, new TeeLogger(new RPCLogger(ExtensionHostKind.LocalProcess), windowLogger)));

		windowRpc.set(mainIdentifier, new MainThreadAuthActor());
		extRpc.set(extIdentifier, new ExtHostAuthActor());
		mainProxy = extRpc.getProxy(mainIdentifier);
		extProxy = windowRpc.getProxy(extIdentifier);
	});

	teardown(() => {
		console.log = originalConsoleLog;
		disposables.dispose();
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	/** drive every credential-carrying call, in both directions; returns what the callers received */
	async function driveCalls() {
		// extension host -> window: requests (client secret, tokens) and replies
		const registered = await mainProxy.$registerDynamicAuthProvider(
			URI.parse('https://auth.example.test'),
			{ issuer: 'https://auth.example.test' },
			{ resource: 'https://resource.example.test' },
			'client-id',
			M_REG_CLIENT_SECRET,
			[{ access_token: M_REG_ACCESS, refresh_token: M_REG_REFRESH, id_token: M_REG_ID, created_at: 1 }]
		);
		await mainProxy.$setSessionsForDynamicAuthProvider(
			'provider-id',
			'client-id',
			[{ access_token: M_SET_ACCESS, refresh_token: M_SET_REFRESH, id_token: M_SET_ID, created_at: 2 }]
		);
		const waited = await mainProxy.$waitForUriHandler(URI.parse(`http://localhost:33418/callback?expected=${M_WAIT_REQUEST_QUERY}`));
		const prompted = await mainProxy.$promptForClientRegistration('https://auth.example.test');
		let windowError: Error | undefined;
		try {
			await mainProxy.$failInWindow('x');
		} catch (err) {
			windowError = err as Error;
		}

		// window -> extension host: requests and replies
		const sessions = await extProxy.$getSessions('provider-id', ['scope'], { clientSecret: M_GET_SESSIONS_OPTIONS_SECRET });
		const created = await extProxy.$createSession('provider-id', ['scope'], { authorizationCode: M_CREATE_SESSION_OPTIONS_CODE });
		let extHostError: Error | undefined;
		try {
			await extProxy.$failInExtHost('x');
		} catch (err) {
			extHostError = err as Error;
		}

		return { registered, waited, prompted, windowError, sessions, created, extHostError };
	}

	/** every argument any logger or console.log received, as text */
	function allLoggedText(): string {
		const texts: string[] = [];
		for (const call of [...windowLogger.calls, ...extHostLogger.calls]) {
			deepText(call.rawArguments, texts);
		}
		for (const args of consoleLogCalls) {
			deepText(args, texts);
		}
		return texts.join('\n');
	}

	test('the text collector finds a marker in every raw form a logger could be handed (negative control)', () => {
		const error = new Error('plain message');
		error.stack = `stack ${M_EXT_ERROR_STACK}`;
		const raw: unknown[] = [
			{ nested: [{ deep: M_REG_CLIENT_SECRET }] },
			{ [M_REG_ACCESS]: 1 },
			error,
			new Error(M_EXT_ERROR_MESSAGE),
			URI.parse(`http://localhost/cb?code=${M_WAIT_REPLY_CODE}`),
			VSBuffer.fromString(M_SET_REFRESH),
			[{ accessToken: M_EXT_REPLY_ACCESS, refreshToken: M_EXT_REPLY_REFRESH, idToken: M_EXT_REPLY_ID }],
		];
		const found = deepText(raw).join('\n');
		for (const marker of [M_REG_CLIENT_SECRET, M_REG_ACCESS, M_EXT_ERROR_STACK, M_EXT_ERROR_MESSAGE, M_WAIT_REPLY_CODE, M_SET_REFRESH, M_EXT_REPLY_ACCESS, M_EXT_REPLY_REFRESH, M_EXT_REPLY_ID]) {
			assert.ok(found.includes(marker), `collector must see ${marker} in raw values`);
		}
	});

	test('no marker reaches any logger argument or console.log, in either direction', async () => {
		await driveCalls();

		// the loggers were really called, on both sides, for requests, replies and errors
		for (const logger of [windowLogger, extHostLogger]) {
			assert.ok(logger.calls.some(c => c.direction === 'out' && c.str.startsWith('request: ')), 'a request was logged');
			assert.ok(logger.calls.some(c => c.direction === 'in' && c.str.startsWith('receiveRequest ')), 'a received request was logged');
			assert.ok(logger.calls.some(c => c.direction === 'out' && c.str === 'reply:'), 'a reply was logged');
			assert.ok(logger.calls.some(c => c.direction === 'out' && c.str === 'replyErr:'), 'an error reply was logged');
			assert.ok(logger.calls.some(c => c.direction === 'in' && c.str === 'receiveReply:'), 'a received reply was logged');
			assert.ok(logger.calls.some(c => c.direction === 'in' && c.str === 'receiveReplyErr:'), 'a received error reply was logged');
		}
		assert.ok(consoleLogCalls.length > 0, 'RPCLogger wrote to console.log');

		const text = allLoggedText();
		for (const marker of ALL_MARKERS) {
			assert.ok(!text.includes(marker), `${marker} reached a logger or console.log`);
		}
	});

	test('loggers receive only the method string and a constant-and-number shape', async () => {
		await driveCalls();

		const registerCall = windowLogger.calls.find(c => c.direction === 'in' && c.str.endsWith('.$registerDynamicAuthProvider('));
		assert.ok(registerCall);
		assert.deepStrictEqual(registerCall.shape, ['object', 'object', 'object', 'string', 'string', 'array(1)']);
		const sentRegisterCall = extHostLogger.calls.find(c => c.direction === 'out' && c.str.endsWith('.$registerDynamicAuthProvider('));
		assert.ok(sentRegisterCall);
		assert.deepStrictEqual(sentRegisterCall.shape, ['uri', 'object', 'object', 'string', 'string', 'array(1)']);

		const allowedTag = /^(string|number|boolean|null|undefined|bigint|symbol|function|object|uri|error|array\(\d+\)|buffer\(\d+ bytes\))$/;
		for (const call of [...windowLogger.calls, ...extHostLogger.calls]) {
			assert.strictEqual(call.rawArguments.length, 5);
			assert.strictEqual(typeof call.msgLength, 'number');
			assert.strictEqual(typeof call.str, 'string');
			if (call.shape) {
				for (const tag of call.shape) {
					assert.ok(allowedTag.test(tag), `unexpected shape tag ${tag}`);
				}
			}
		}

		const errorReply = extHostLogger.calls.find(c => c.direction === 'in' && c.str === 'receiveReplyErr:');
		assert.deepStrictEqual(errorReply?.shape, ['error']);
		const sentError = windowLogger.calls.find(c => c.direction === 'out' && c.str === 'replyErr:');
		assert.deepStrictEqual(sentError?.shape, ['error']);
	});

	test('transmission is unchanged: the recipient receives every marker intact', async () => {
		const { registered, waited, prompted, windowError, sessions, created, extHostError } = await driveCalls();

		// requests as received
		const windowReceived = JSON.stringify(receivedByWindow);
		for (const marker of [M_REG_CLIENT_SECRET, M_REG_ACCESS, M_REG_REFRESH, M_REG_ID, M_SET_ACCESS, M_SET_REFRESH, M_SET_ID, M_WAIT_REQUEST_QUERY]) {
			assert.ok(windowReceived.includes(marker), `window did not receive ${marker}`);
		}
		const extHostReceived = JSON.stringify(receivedByExtHost);
		for (const marker of [M_GET_SESSIONS_OPTIONS_SECRET, M_CREATE_SESSION_OPTIONS_CODE]) {
			assert.ok(extHostReceived.includes(marker), `extension host did not receive ${marker}`);
		}

		// replies as received by the caller
		assert.strictEqual(registered, 'provider-id');
		assert.ok((waited as UriComponents).query?.includes(`code=${M_WAIT_REPLY_CODE}`));
		assert.strictEqual(prompted?.clientSecret, M_PROMPT_REPLY_SECRET);
		const sessionsText = JSON.stringify([sessions, created]);
		for (const marker of [M_EXT_REPLY_ACCESS, M_EXT_REPLY_REFRESH, M_EXT_REPLY_ID]) {
			assert.ok(sessionsText.includes(marker), `caller did not receive ${marker}`);
		}

		// errors as received by the caller
		assert.ok(windowError);
		assert.strictEqual(windowError.message, `rejected: ${M_WIN_ERROR_MESSAGE}`);
		assert.ok(windowError.stack?.includes(M_WIN_ERROR_STACK));
		assert.ok(extHostError);
		assert.strictEqual(extHostError.message, `rejected: ${M_EXT_ERROR_MESSAGE}`);
		assert.ok(extHostError.stack?.includes(M_EXT_ERROR_STACK));
	});
});

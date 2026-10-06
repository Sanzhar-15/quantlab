/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// F-SECRETS-6: the sessions of a dynamic auth provider are shared by every window through one secret storage. A window's
// change never loses, resurrects or replaces a credential another window saved; a sign-out stays a sign-out.
// This file imports only what the provider module exported before F-SECRETS-3, so that swapping in an earlier
// extHostAuthentication.ts is a valid negative control.

import assert from 'assert';
import * as sinon from 'sinon';
import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { stringHash } from '../../../../base/common/hash.js';
import { IAuthorizationServerMetadata, IAuthorizationTokenResponse } from '../../../../base/common/oauth.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ILogger, ILoggerService, NullLogger } from '../../../../platform/log/common/log.js';
import { MainThreadAuthenticationShape } from '../../common/extHost.protocol.js';
import { DynamicAuthProvider } from '../../common/extHostAuthentication.js';
import { IExtHostInitDataService } from '../../common/extHostInitDataService.js';
import { IExtHostProgress } from '../../common/extHostProgress.js';
import { IExtHostUrlsService } from '../../common/extHostUrls.js';
import { IExtHostWindow } from '../../common/extHostWindow.js';

const AUTH_SERVER = 'https://auth.example.com';
const TOKEN_ENDPOINT = `${AUTH_SERVER}/token`;
const CLIENT_ID = 'client-1';

type StoredToken = IAuthorizationTokenResponse & { created_at: number };
type TokensChange = { authProviderId: string; clientId: string; tokens: StoredToken[] };

class TestDynamicAuthProvider extends DynamicAuthProvider {
	/** One sign-in flow that returns `token`. */
	useTokenFlow(token: IAuthorizationTokenResponse): void {
		this._createFlows.splice(0, this._createFlows.length, { label: 'Token', handler: async () => ({ ...token }) });
	}
}

class RecordingLogger extends NullLogger {
	readonly lines: string[] = [];
	override trace(message: string): void { this.lines.push(message); }
	override debug(message: string): void { this.lines.push(message); }
	override info(message: string): void { this.lines.push(message); }
	override warn(message: string): void { this.lines.push(message); }
	override error(message: string | Error): void { this.lines.push(String(message)); }
}

/**
 * One secret storage shared by windows, as the main threads see it: a save stores the list (JSON, as secret storage does)
 * and announces a change; each change is followed by a read of the list stored at that time, delivered to every window in
 * order. A read that comes after a later save sees that save's list, as a real read does.
 */
class SharedSessionStorage {
	private _value: string;
	private readonly _windows: { emitter: Emitter<TokensChange>; providerId: () => string }[] = [];
	private _pendingReads = 0;
	private _pendingSaves = 0;

	constructor(initial: StoredToken[]) {
		this._value = JSON.stringify(initial);
	}

	get stored(): StoredToken[] {
		return JSON.parse(this._value);
	}

	connect(emitter: Emitter<TokensChange>, providerId: () => string): void {
		this._windows.push({ emitter, providerId });
	}

	async save(tokens: unknown[]): Promise<void> {
		this._value = JSON.stringify(tokens);
		this._pendingReads++;
		setTimeout(() => {
			this._pendingReads--;
			for (const win of this._windows) {
				win.emitter.fire({ authProviderId: win.providerId(), clientId: CLIENT_ID, tokens: JSON.parse(this._value) });
			}
		}, 0);
	}

	/** Counts a save that a window started, until it settles. */
	track<T>(save: Promise<T>): Promise<T> {
		this._pendingSaves++;
		const done = () => { this._pendingSaves--; };
		save.then(done, done);
		return save;
	}

	/** Every announced change has been read and delivered. */
	async readsDelivered(): Promise<void> {
		for (let i = 0; i < 100 && this._pendingReads; i++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		assert.strictEqual(this._pendingReads, 0, 'the announced changes are delivered');
	}

	/** No read and no save is pending, for several turns (a window may save again after a read). */
	async settled(): Promise<void> {
		let quiet = 0;
		for (let i = 0; i < 500 && quiet < 5; i++) {
			await new Promise(resolve => setTimeout(resolve, 0));
			quiet = this._pendingReads || this._pendingSaves ? 0 : quiet + 1;
		}
		assert.strictEqual(quiet, 5, 'the windows settle');
	}
}

suite('ExtHostAuthentication - dynamic auth sessions across windows', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let fetchStub: sinon.SinonStub;
	/** The token responses of the next refreshes, in order. */
	let refreshResponses: IAuthorizationTokenResponse[];
	setup(() => {
		refreshResponses = [];
		fetchStub = sinon.stub(globalThis, 'fetch');
		fetchStub.callsFake(async (input: string | URL | Request) => {
			if (String(input) !== TOKEN_ENDPOINT) {
				return new Response('', { status: 404 });
			}
			const response = refreshResponses.shift();
			assert.ok(response, 'a refresh is expected');
			return new Response(JSON.stringify(response), { status: 200 });
		});
	});
	teardown(() => {
		fetchStub.restore();
	});

	interface IWindow {
		readonly provider: TestDynamicAuthProvider;
		readonly logger: RecordingLogger;
		/** The next saves of this window fail. */
		failSaves: boolean;
		/** When set, the next save of this window waits for it before it reaches storage. */
		hold: DeferredPromise<void> | undefined;
		/** A save of this window is held. */
		holding: boolean;
	}

	function openWindow(storage: SharedSessionStorage): IWindow {
		const logger = new RecordingLogger();
		const emitter = store.add(new Emitter<TokensChange>());
		const win: { -readonly [K in keyof IWindow]: IWindow[K] } = { provider: undefined!, logger, failSaves: false, hold: undefined, holding: false };
		const proxy: Partial<MainThreadAuthenticationShape> = {
			$setSessionsForDynamicAuthProvider: (_providerId, _clientId, sessions) => storage.track((async () => {
				if (win.failSaves) {
					throw new Error('keychain unavailable');
				}
				const hold = win.hold;
				if (hold) {
					win.hold = undefined;
					win.holding = true;
					await hold.p;
					win.holding = false;
				}
				await storage.save(sessions);
			})()),
		};
		const serverMetadata: IAuthorizationServerMetadata = { issuer: AUTH_SERVER, response_types_supported: ['code'], token_endpoint: TOKEN_ENDPOINT };
		win.provider = new TestDynamicAuthProvider(
			{} as IExtHostWindow,
			{} as IExtHostUrlsService,
			{ environment: { appName: 'Test', appUriScheme: 'test' } } as unknown as IExtHostInitDataService,
			{ withProgressFromSource: (_source: unknown, _options: unknown, task: (progress: { report(): void }, token: CancellationToken) => Promise<unknown>) => task({ report() { } }, CancellationToken.None) } as unknown as IExtHostProgress,
			{ createLogger: (): ILogger => logger } as unknown as ILoggerService,
			proxy as MainThreadAuthenticationShape,
			URI.parse(AUTH_SERVER),
			serverMetadata,
			undefined,
			CLIENT_ID,
			undefined,
			emitter,
			storage.stored,
		);
		const provider = win.provider;
		store.add({ dispose: () => provider.dispose() });
		storage.connect(emitter, () => provider.id);
		return win;
	}

	async function waitUntilHolding(win: IWindow): Promise<void> {
		for (let i = 0; i < 200 && !win.holding; i++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		assert.ok(win.holding, 'the save of the window under test is held');
	}

	/** [access token, refresh token] of each stored credential, sorted. */
	function credentials(tokens: StoredToken[]): string[][] {
		return tokens.map(t => [t.access_token, t.refresh_token ?? '']).sort();
	}

	async function accessTokens(win: IWindow): Promise<string[]> {
		return (await win.provider.getSessions(undefined, {})).map(s => s.accessToken).sort();
	}

	/** Every window, and a window opened from storage (a restart), holds the stored sessions. */
	async function assertAgree(storage: SharedSessionStorage, expected: string[], ...windows: IWindow[]): Promise<void> {
		assert.deepStrictEqual(storage.stored.map(t => t.access_token).sort(), expected, 'stored');
		for (const [i, win] of windows.entries()) {
			assert.deepStrictEqual(await accessTokens(win), expected, `window ${i}`);
		}
		await storage.settled();
		assert.deepStrictEqual(storage.stored.map(t => t.access_token).sort(), expected, 'stored, after the reads');
		assert.deepStrictEqual(await accessTokens(openWindow(storage)), expected, 'after a restart');
	}

	function assertNoTokenInLogs(windows: IWindow[], tokens: string[]): void {
		for (const win of windows) {
			for (const line of win.logger.lines) {
				for (const token of tokens) {
					assert.ok(!line.includes(token), `a log line holds token text: ${line}`);
				}
			}
		}
	}

	// Stored by an earlier version: no session bookkeeping.
	const expiring: StoredToken = { access_token: 'at-1', refresh_token: 'rt-1', token_type: 'Bearer', scope: 'read', expires_in: 3600, created_at: 1 };
	const refreshedHere = { access_token: 'at-here', refresh_token: 'rt-here', token_type: 'Bearer', scope: 'read', expires_in: 3600 };
	const refreshedThere = { access_token: 'at-there', refresh_token: 'rt-there', token_type: 'Bearer', scope: 'read', expires_in: 3600 };
	const ALL_TOKENS = ['at-1', 'rt-1', 'at-here', 'rt-here', 'at-there', 'rt-there', 'at-other'];

	suite('logical session identity', () => {

		test('a rotated credential not saved here yet and a refresh saved in another window: both credentials are kept', async () => {
			const storage = new SharedSessionStorage([expiring]);
			const here = openWindow(storage), there = openWindow(storage);
			refreshResponses.push(refreshedHere, refreshedThere);

			here.failSaves = true;
			await assert.rejects(here.provider.getSessions(['read'], {}));
			here.failSaves = false;
			assert.deepStrictEqual(credentials(storage.stored), [['at-1', 'rt-1']]);

			assert.deepStrictEqual((await there.provider.getSessions(['read'], {})).map(s => s.accessToken), ['at-there']);
			await storage.readsDelivered();
			await storage.settled();

			assert.deepStrictEqual(credentials(storage.stored), [['at-here', 'rt-here'], ['at-there', 'rt-there']], 'neither rotated credential is lost or replaced');
			await assertAgree(storage, ['at-here', 'at-there'], here, there);
			assert.strictEqual(fetchStub.callCount, 2, 'no further refresh with a spent refresh token');
			assertNoTokenInLogs([here, there], ALL_TOKENS);
		});

		test('a sign-out not saved here yet and a refresh saved in another window: the session stays signed out', async () => {
			const storage = new SharedSessionStorage([expiring]);
			const here = openWindow(storage), there = openWindow(storage);
			refreshResponses.push(refreshedThere);
			const [session] = await here.provider.getSessions(undefined, {});

			here.failSaves = true;
			await assert.rejects(here.provider.removeSession(session.id));
			here.failSaves = false;

			assert.deepStrictEqual((await there.provider.getSessions(['read'], {})).map(s => s.accessToken), ['at-there'], 'the other window refreshed the session');
			await storage.readsDelivered();

			// The user signs out again in this window (this window may have saved the sign-out already, on reading the
			// other window's list): it succeeds once the session, refreshed or not, is removed.
			await here.provider.removeSession(session.id);
			await storage.settled();

			assert.deepStrictEqual(storage.stored, [], 'the remotely refreshed credential is removed');
			await assertAgree(storage, [], here, there);
			assertNoTokenInLogs([here, there], ALL_TOKENS);
		});

		test('two sessions whose access tokens have the same 32-bit hash are independent', async () => {
			assert.strictEqual(stringHash('access-Aa', 0), stringHash('access-BB', 0), 'precondition: the access tokens collide');
			const now = Date.now();
			const storage = new SharedSessionStorage([
				{ access_token: 'access-Aa', refresh_token: 'refresh-A', token_type: 'Bearer', scope: 'a', expires_in: 3600, created_at: now },
				{ access_token: 'access-BB', refresh_token: 'refresh-B', token_type: 'Bearer', scope: 'b', expires_in: 3600, created_at: 1 },
			]);
			const here = openWindow(storage), there = openWindow(storage);
			const sessions = await here.provider.getSessions(undefined, {});
			assert.strictEqual(new Set(sessions.map(s => s.id)).size, 2, 'two sessions, two ids');

			refreshResponses.push({ access_token: 'new-B', refresh_token: 'rotated-B', token_type: 'Bearer', scope: 'b', expires_in: 3600 });
			assert.deepStrictEqual((await here.provider.getSessions(['b'], {})).map(s => s.accessToken), ['new-B']);
			await storage.settled();
			assert.deepStrictEqual(credentials(storage.stored), [['access-Aa', 'refresh-A'], ['new-B', 'rotated-B']], 'refreshing one leaves the other');

			const [a] = await there.provider.getSessions(['a'], {});
			await there.provider.removeSession(a.id);
			await storage.settled();
			assert.deepStrictEqual(credentials(storage.stored), [['new-B', 'rotated-B']], 'signing out of one leaves the other');
			await assertAgree(storage, ['new-B'], here, there);
		});
	});

	// A save that is awaited while another window's save lands: the later read decides nothing by itself.
	suite('a save of another window lands while a save here is in flight', () => {

		test('another window signs in while a refresh here is saved: both are kept', async () => {
			const storage = new SharedSessionStorage([expiring]);
			const here = openWindow(storage), there = openWindow(storage);
			refreshResponses.push(refreshedHere);

			here.hold = new DeferredPromise<void>();
			const hold = here.hold;
			const refreshing = here.provider.getSessions(['read'], {});
			await waitUntilHolding(here);
			there.provider.useTokenFlow({ access_token: 'at-other', token_type: 'Bearer', scope: 'other' });
			await there.provider.createSession(['other'], {});
			await storage.readsDelivered();
			hold.complete();
			await refreshing;
			await storage.settled();

			assert.deepStrictEqual(credentials(storage.stored), [['at-here', 'rt-here'], ['at-other', '']], 'the other window\'s session is not overwritten');
			await assertAgree(storage, ['at-here', 'at-other'], here, there);
		});

		test('another window signs out while a refresh here is saved: the session stays signed out', async () => {
			const storage = new SharedSessionStorage([expiring]);
			const here = openWindow(storage), there = openWindow(storage);
			refreshResponses.push(refreshedHere);

			here.hold = new DeferredPromise<void>();
			const hold = here.hold;
			// The refresh's own outcome is not under test: it is held so that a rejection is not reported unhandled.
			const refreshing = here.provider.getSessions(['read'], {}).then(() => undefined, e => e);
			await waitUntilHolding(here);
			const [session] = await there.provider.getSessions(undefined, {});
			await there.provider.removeSession(session.id);
			await storage.readsDelivered();
			hold.complete();
			await refreshing;
			await storage.settled();

			assert.deepStrictEqual(storage.stored, [], 'the refreshed credential of the signed-out session is not resurrected');
			await assertAgree(storage, [], here, there);
		});

		test('another window refreshes while a sign-out here is saved: the session stays signed out', async () => {
			const storage = new SharedSessionStorage([expiring]);
			const here = openWindow(storage), there = openWindow(storage);
			refreshResponses.push(refreshedThere);
			const [session] = await here.provider.getSessions(undefined, {});

			here.hold = new DeferredPromise<void>();
			const hold = here.hold;
			const signingOut = here.provider.removeSession(session.id);
			await waitUntilHolding(here);
			await there.provider.getSessions(['read'], {});
			await storage.readsDelivered();
			hold.complete();
			await signingOut;
			await storage.settled();

			assert.deepStrictEqual(storage.stored, [], 'the refresh of the other window does not bring the session back');
			await assertAgree(storage, [], here, there);
		});

		test('another window signs in while a sign-out here is saved: the other window\'s session is kept', async () => {
			const now = Date.now();
			const storage = new SharedSessionStorage([{ ...expiring, created_at: now }]);
			const here = openWindow(storage), there = openWindow(storage);
			const [session] = await here.provider.getSessions(undefined, {});

			here.hold = new DeferredPromise<void>();
			const hold = here.hold;
			const signingOut = here.provider.removeSession(session.id);
			await waitUntilHolding(here);
			there.provider.useTokenFlow({ access_token: 'at-other', token_type: 'Bearer', scope: 'other' });
			await there.provider.createSession(['other'], {});
			await storage.readsDelivered();
			hold.complete();
			await signingOut;
			await storage.settled();

			assert.deepStrictEqual(credentials(storage.stored), [['at-other', '']], 'the sign-out lands, and the new session is not overwritten');
			await assertAgree(storage, ['at-other'], here, there);
		});
	});
});

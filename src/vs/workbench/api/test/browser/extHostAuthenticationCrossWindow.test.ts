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
/** A stored token as this version saves it, without the bookkeeping of its list. */
type SessionRecord = StoredToken & { session_id: string; revision: string };
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
	private readonly _windows: { emitter: Emitter<TokensChange>; providerId: () => string; delayed: boolean; missed: boolean }[] = [];
	private _pendingReads = 0;
	private _pendingSaves = 0;
	/** Every value saved, in order (JSON). */
	readonly saved: string[] = [];

	constructor(initial: StoredToken[]) {
		this._value = JSON.stringify(initial);
	}

	/** The stored sessions: the record that stands for an empty list (F-SECRETS-6) is not a session. */
	get stored(): StoredToken[] {
		return (JSON.parse(this._value) as (StoredToken & { session_list_record?: boolean })[]).filter(t => !t.session_list_record);
	}

	/** The raw stored value, for a window that reads it (as initial tokens). */
	get raw(): StoredToken[] {
		return JSON.parse(this._value);
	}

	connect(emitter: Emitter<TokensChange>, providerId: () => string): number {
		return this._windows.push({ emitter, providerId, delayed: false, missed: false }) - 1;
	}

	/** The reads of a window are held: it sees no change until {@link deliverDelayed}, then only the list stored then. */
	delayReads(index: number): void {
		this._windows[index].delayed = true;
	}

	deliverDelayed(index: number): void {
		const target = this._windows[index];
		target.delayed = false;
		if (target.missed) {
			target.missed = false;
			target.emitter.fire({ authProviderId: target.providerId(), clientId: CLIENT_ID, tokens: JSON.parse(this._value) });
		}
	}

	async save(tokens: unknown[]): Promise<void> {
		this._value = JSON.stringify(tokens);
		this.saved.push(this._value);
		this._pendingReads++;
		setTimeout(() => {
			this._pendingReads--;
			for (const win of this._windows) {
				if (win.delayed) {
					win.missed = true;
				} else {
					win.emitter.fire({ authProviderId: win.providerId(), clientId: CLIENT_ID, tokens: JSON.parse(this._value) });
				}
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
	/** The refresh token each refresh request sent, in order. */
	let refreshRequests: string[];
	/** When set, the next refresh response waits for it (its response is taken when the request is made). */
	let refreshHold: DeferredPromise<void> | undefined;
	setup(() => {
		refreshResponses = [];
		refreshRequests = [];
		refreshHold = undefined;
		fetchStub = sinon.stub(globalThis, 'fetch');
		fetchStub.callsFake(async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input) !== TOKEN_ENDPOINT) {
				return new Response('', { status: 404 });
			}
			refreshRequests.push(String(new URLSearchParams(String(init?.body)).get('refresh_token')));
			const response = refreshResponses.shift();
			assert.ok(response, 'a refresh is expected');
			const hold = refreshHold;
			refreshHold = undefined;
			if (hold) {
				await hold.p;
			}
			return new Response(JSON.stringify(response), { status: 200 });
		});
	});
	teardown(() => {
		fetchStub.restore();
	});

	interface IWindow {
		readonly provider: TestDynamicAuthProvider;
		readonly logger: RecordingLogger;
		/** Its index in the shared storage. */
		readonly index: number;
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
		const win: { -readonly [K in keyof IWindow]: IWindow[K] } = { provider: undefined!, logger, index: -1, failSaves: false, hold: undefined, holding: false };
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
			storage.raw,
		);
		const provider = win.provider;
		store.add({ dispose: () => provider.dispose() });
		win.index = storage.connect(emitter, () => provider.id);
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

	// An empty list carries the bookkeeping of any other list: it is merged like one.
	suite('an empty list saved by a window that did not see a session', () => {

		test('a session saved here survives an empty list another window saved without it in view; that window\'s sign-out stands', async () => {
			const storage = new SharedSessionStorage([{ ...expiring, created_at: Date.now() }]);
			const here = openWindow(storage), there = openWindow(storage);
			const [session] = await there.provider.getSessions(undefined, {});
			storage.delayReads(there.index);

			here.provider.useTokenFlow({ access_token: 'at-other', token_type: 'Bearer', scope: 'other' });
			await here.provider.createSession(['other'], {});
			await storage.readsDelivered(); // this window reads its own list back: the sign-in is stored
			assert.deepStrictEqual(credentials(storage.stored), [['at-1', 'rt-1'], ['at-other', '']]);

			// The other window has not read the sign-in: signing out of its only session, it saves an empty list.
			await there.provider.removeSession(session.id);
			assert.deepStrictEqual(storage.stored, [], 'the empty list landed over the sign-in');
			storage.deliverDelayed(there.index);
			await storage.settled();

			assert.deepStrictEqual(credentials(storage.stored), [['at-other', '']], 'the session saved here is not lost, and the sign-out stands');
			await assertAgree(storage, ['at-other'], here, there);
		});
	});

	/** Polls until `condition` holds; a condition that never holds fails the test. */
	async function waitUntil(condition: () => boolean, what: string): Promise<void> {
		for (let i = 0; i < 200 && !condition(); i++) {
			await new Promise(resolve => setTimeout(resolve, 0));
		}
		assert.ok(condition(), what);
	}

	/** A stored list as this version saves it: each token with its session id, revision and the list's bookkeeping. */
	function sessionList(tokens: SessionRecord[]): StoredToken[] {
		return tokens.map(t => ({ ...t, stored_revisions: ['list-0'], signed_out_sessions: [] }));
	}

	function signedOutRecord(storage: SharedSessionStorage): string[] {
		return (storage.raw[0] as unknown as { signed_out_sessions: string[] }).signed_out_sessions;
	}

	// F-SECRETS-6 review c1 (M1): a stored list carries only its newest revisions and sign-outs. A window that read none of
	// them cannot tell a session missing from the list signed out from never saved: it restores none, and says so; a
	// window that saw the sign-outs keeps them while it is open, however many there were.
	suite('sign-outs beyond what a stored list carries', () => {
		const COUNT = 33;
		function manySessions(): StoredToken[] {
			const now = Date.now();
			return Array.from({ length: COUNT }, (_, i) => ({ access_token: `access-${i}`, refresh_token: `refresh-${i}`, token_type: 'Bearer', scope: `s${i}`, expires_in: 3600, created_at: now }));
		}

		async function signOutAll(win: IWindow): Promise<void> {
			for (const session of await win.provider.getSessions(undefined, {})) {
				await win.provider.removeSession(session.id);
			}
		}

		test('33 sign-outs while another window reads nothing: once it reads, none of them comes back', async () => {
			const storage = new SharedSessionStorage(manySessions());
			const here = openWindow(storage), there = openWindow(storage);
			storage.delayReads(there.index);
			await signOutAll(here);
			await storage.readsDelivered();
			assert.deepStrictEqual(storage.stored, []);

			storage.deliverDelayed(there.index);
			await storage.settled();
			await assertAgree(storage, [], here, there);
			// The list carries the newest 32 sign-outs: the one before them cannot be told from a lost save, and is reported.
			assert.ok(there.logger.lines.some(line => line.includes(': 1 session(s) held here are not restored')), 'the window that cannot reconcile says so');
			assertNoTokenInLogs([here, there], manySessions().flatMap(t => [t.access_token, t.refresh_token!]));
		});

		test('33 sign-outs, then a save of a window that read none of them: the window that signed out removes them again', async () => {
			const storage = new SharedSessionStorage(manySessions());
			const here = openWindow(storage), there = openWindow(storage);
			storage.delayReads(there.index);
			await signOutAll(here);
			await storage.readsDelivered();

			// The other window read none of the sign-outs: its sign-in saves every session it holds.
			there.provider.useTokenFlow({ access_token: 'at-new', token_type: 'Bearer', scope: 'new' });
			await there.provider.createSession(['new'], {});
			await storage.readsDelivered();
			storage.deliverDelayed(there.index);
			await storage.settled();
			await assertAgree(storage, ['at-new'], here, there);
		});
	});

	// F-SECRETS-6 review c1 (M2): a fork's id is the revision it was forked with, so its sign-out also signs out that
	// credential where a window still holds it under the session it was forked from.
	suite('a signed-out fork', () => {

		test('two refreshes kept as two sessions, the fork signed out, then 32 other saves: the window still holding the fork\'s credential drops it', async () => {
			let found: { storage: SharedSessionStorage; here: IWindow; there: IWindow; fork: SessionRecord } | undefined;
			// Which credential becomes the fork is decided by revision (random): the case under test is the one where the
			// window that reads nothing more holds it.
			for (let attempt = 0; attempt < 20 && !found; attempt++) {
				const storage = new SharedSessionStorage([expiring]);
				const here = openWindow(storage), there = openWindow(storage);
				refreshResponses.push(refreshedHere, refreshedThere);
				here.failSaves = true;
				await assert.rejects(here.provider.getSessions(['read'], {}));
				here.failSaves = false;
				storage.delayReads(there.index);
				await there.provider.getSessions(['read'], {});
				await storage.readsDelivered();
				await storage.settled();
				const raw = storage.raw as SessionRecord[];
				const forks = raw.filter(t => t.session_id === t.revision);
				assert.deepStrictEqual([raw.length, forks.length], [2, 1], 'the two refreshes are kept as two sessions, one of them a fork');
				if (forks[0].access_token === 'at-there') {
					found = { storage, here, there, fork: forks[0] };
				}
			}
			assert.ok(found, 'within 20 attempts the window that reads nothing more holds the fork');
			const { storage, here, there, fork } = found;

			await here.provider.removeSession(fork.revision);
			for (let i = 0; i < 32; i++) {
				here.provider.useTokenFlow({ access_token: `at-u${i}`, token_type: 'Bearer', scope: `u${i}` });
				await here.provider.createSession([`u${i}`], {});
			}
			await storage.readsDelivered();
			assert.ok(signedOutRecord(storage).includes(fork.revision), 'the sign-out of the fork is recorded');

			const savesBefore = storage.saved.length;
			storage.deliverDelayed(there.index);
			await storage.settled();
			assert.ok(signedOutRecord(storage).includes(fork.revision), 'the sign-out of the fork is still recorded');
			assert.ok(storage.saved.slice(savesBefore).every(value => !value.includes('rt-there')), 'no save writes the fork\'s credential again, not even until a repair');
			const expected = ['at-here', ...Array.from({ length: 32 }, (_, i) => `at-u${i}`)].sort();
			await assertAgree(storage, expected, here, there);
			assert.ok(!JSON.stringify(storage.raw).includes('rt-there'), 'the fork\'s refresh token is not stored');
		});
	});

	// F-SECRETS-6 review c1 (M4): a caller names a credential by its session id, never by its access token: two sessions
	// may hold the same access token with different refresh tokens.
	suite('sessions that share an access token', () => {

		function twoSessions(createdAt: number): StoredToken[] {
			return sessionList([
				{ access_token: 'same-access', refresh_token: 'refresh-A', token_type: 'Bearer', scope: 'read', expires_in: 3600, created_at: createdAt, session_id: 'session-A', revision: 'rev-A' },
				{ access_token: 'same-access', refresh_token: 'refresh-B', token_type: 'Bearer', scope: 'read', expires_in: 3600, created_at: createdAt, session_id: 'session-B', revision: 'rev-B' },
			]);
		}

		for (const [removedId, kept] of [['rev-A', 'refresh-B'], ['rev-B', 'refresh-A']]) {
			test(`signing out of one removes that one only (${removedId})`, async () => {
				const storage = new SharedSessionStorage(twoSessions(Date.now()));
				const win = openWindow(storage);
				assert.deepStrictEqual((await win.provider.getSessions(undefined, {})).map(s => s.id).sort(), ['rev-A', 'rev-B']);
				await win.provider.removeSession(removedId);
				await storage.settled();
				assert.deepStrictEqual(credentials(storage.stored), [['same-access', kept]]);
				assert.deepStrictEqual((await openWindow(storage).provider.getSessions(undefined, {})).map(s => s.id), [removedId === 'rev-A' ? 'rev-B' : 'rev-A'], 'after a restart');
			});
		}

		test('refreshing both sends each one\'s refresh token and keeps both rotations', async () => {
			const storage = new SharedSessionStorage(twoSessions(1));
			const win = openWindow(storage);
			refreshResponses.push(
				{ access_token: 'new-access-1', refresh_token: 'rotated-1', token_type: 'Bearer', scope: 'read', expires_in: 3600 },
				{ access_token: 'new-access-2', refresh_token: 'rotated-2', token_type: 'Bearer', scope: 'read', expires_in: 3600 },
			);
			await win.provider.getSessions(['read'], {});
			await storage.settled();
			assert.deepStrictEqual([...refreshRequests].sort(), ['refresh-A', 'refresh-B'], 'each session is refreshed with its own refresh token');
			assert.deepStrictEqual(credentials(storage.stored), [['new-access-1', 'rotated-1'], ['new-access-2', 'rotated-2']], 'both rotations are kept');
		});

		test('a new session with the same access token is returned as itself', async () => {
			const storage = new SharedSessionStorage(twoSessions(Date.now()));
			const win = openWindow(storage);
			win.provider.useTokenFlow({ access_token: 'same-access', refresh_token: 'refresh-C', token_type: 'Bearer', scope: 'read' });
			const created = await win.provider.createSession(['read'], {});
			await storage.settled();
			assert.ok(!['rev-A', 'rev-B'].includes(created.id), 'not another session');
			assert.strictEqual((storage.raw as SessionRecord[]).find(t => t.revision === created.id)?.refresh_token, 'refresh-C');
			assert.deepStrictEqual(credentials(storage.stored), [['same-access', 'refresh-A'], ['same-access', 'refresh-B'], ['same-access', 'refresh-C']]);
		});

		test('a refresh that keeps the access token and replaces the refresh token is reported as the new session it is', async () => {
			const storage = new SharedSessionStorage(sessionList([
				{ access_token: 'same-access', refresh_token: 'refresh-A', token_type: 'Bearer', scope: 'read', expires_in: 3600, created_at: 1, session_id: 'session-A', revision: 'rev-A' },
			]));
			const win = openWindow(storage);
			const events: { added: string[] | undefined; removed: string[] | undefined; changed: string[] | undefined }[] = [];
			store.add(win.provider.onDidChangeSessions(e => events.push({ added: e.added?.map(s => s.id), removed: e.removed?.map(s => s.id), changed: e.changed?.map(s => s.id) })));
			refreshResponses.push({ access_token: 'same-access', refresh_token: 'rotated-A', token_type: 'Bearer', scope: 'read', expires_in: 3600 });
			const [session] = await win.provider.getSessions(['read'], {});
			await storage.settled();
			assert.notStrictEqual(session.id, 'rev-A', 'the new credential is a new revision');
			assert.deepStrictEqual(events, [{ added: [session.id], removed: ['rev-A'], changed: [] }]);
			assert.deepStrictEqual(credentials(storage.stored), [['same-access', 'rotated-A']]);
		});
	});

	// F-SECRETS-6 review c1 (O6): two credentials of one session, each made without the other in view, are split by one
	// rule on every path: the smaller revision keeps the session id, the other becomes a session whose id is its revision.
	suite('one rule for two concurrent refreshes', () => {

		test('a refresh here that completes after another window\'s refresh was read: the smaller revision keeps the session id', async () => {
			// Revisions are random: eight rounds, so that both orders are met.
			for (let round = 0; round < 8; round++) {
				const storage = new SharedSessionStorage([expiring]);
				const here = openWindow(storage), there = openWindow(storage);
				refreshResponses.push(refreshedHere, refreshedThere);
				refreshRequests.length = 0;
				refreshHold = new DeferredPromise<void>();
				const hold = refreshHold;
				const refreshing = here.provider.getSessions(['read'], {});
				await waitUntil(() => refreshRequests.length === 1, 'the refresh here is requested');
				await there.provider.getSessions(['read'], {});
				await storage.readsDelivered(); // this window reads the other window's refresh before its own response arrives
				hold.complete();
				await refreshing;
				await storage.settled();

				const raw = storage.raw as SessionRecord[];
				assert.deepStrictEqual(credentials(raw), [['at-here', 'rt-here'], ['at-there', 'rt-there']], 'both credentials are kept');
				const forks = raw.filter(t => t.session_id === t.revision);
				const keepers = raw.filter(t => t.session_id !== t.revision);
				assert.deepStrictEqual([forks.length, keepers.length], [1, 1]);
				assert.ok(keepers[0].session_id.startsWith('legacy-'), 'the session keeps its id');
				assert.ok(keepers[0].revision < forks[0].revision, `round ${round}: the smaller revision keeps the session id`);
				await assertAgree(storage, ['at-here', 'at-there'], here, there);
			}
		});
	});
});

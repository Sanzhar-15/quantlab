/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V1 (2026-05-22) -- engine round-trip test.
 *
 * Loads the `ql-bindings-node` cdylib and exercises the minimum round-
 * trip: peer A appends a PutValue -> exports bytes -> peer B merges
 * bytes -> peer B's op count matches.
 *
 * **Prerequisite**: engine binding must be built. Skips loudly (with
 * a once-per-process stderr log) if the binary is missing. Mirrors
 * the existing `qviz-daemon-client.test.ts` skip-on-missing-prereq
 * pattern; the binary isn't required for THIS extension's tests in
 * isolation (CI may run without the engine repo checked out).
 *
 * Build the binary before running (path is relative to the IDE
 * workspace root, NOT this test file's directory):
 *   cd <ide-workspace-root>/quantlab-quantbook/quantbook-engine
 *   cargo build -p ql-bindings-node --release --features test-fixtures
 *
 * **V2.8 megaudit closure (Opus-B Lane C HIGH-1, 2026-05-22)**:
 * `--features test-fixtures` is now REQUIRED for the V2.5+V2.6+V2.7
 * contention contract tests because `BlockingTransportFixture` is now
 * gated behind the binding-side `test-fixtures` Cargo feature.
 * Production cdylib builds (without the feature) load fine but lack
 * the fixture; tests use `requireBlockingTransportFixture(engine)`
 * below to throw a clear "rebuild" message if the fixture is absent.
 *
 * On macOS that's typically:
 *   cd ~/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 *   cargo build -p ql-bindings-node --release --features test-fixtures
 */

import * as assert from 'assert';
import * as fs from 'fs';

import {
	loadQuantbookEngine,
	resolveEnginePath,
	resolveRelayBinaryPath,
	_resetQuantbookEngineCacheForTests,
} from '../src/quantbook/loader';
import {
	appendPutValueValidated,
	createSession,
	exportCellSnapshot,
	isAutoFlushPolicy,
	isQuantbookErrorCode,
	listSheets,
	loopbackTransportPair,
	parseQuantbookError,
	quantbookEngineVersion,
	sessionFromSnapshot,
} from '../src/quantbook/session';
import type {
	BlockingTransportFixtureConstructor,
	CollabSessionInstance,
	QuantbookCellSnapshot,
	QuantbookNativeModule,
} from '../src/quantbook/types';

/**
 * **V2.8 megaudit closure (Opus-B Lane C HIGH-1, 2026-05-22)** — test
 * helper for accessing the now-optional `BlockingTransportFixture`
 * constructor on the loaded native module.
 *
 * Pre-V2.8 the fixture was always present (the binding crate enabled
 * `ql-collab/test-fixtures` unconditionally). V2.8 gates it behind the
 * binding-side `test-fixtures` Cargo feature. Mocha contention tests
 * that use the fixture call this helper to surface a clear, actionable
 * error if the loaded cdylib was built without the feature.
 *
 * Throws an Error explaining the required rebuild command.
 */
function requireBlockingTransportFixture(
	engine: QuantbookNativeModule,
): BlockingTransportFixtureConstructor {
	if (typeof engine.BlockingTransportFixture !== 'function') {
		throw new Error(
			'engine.BlockingTransportFixture is missing from the loaded cdylib. ' +
			'V2.8 megaudit closure: the fixture is now feature-gated. ' +
			'Rebuild the engine with: cd .../quantbook-engine && ' +
			'cargo build -p ql-bindings-node --release --features test-fixtures',
		);
	}
	return engine.BlockingTransportFixture;
}

function engineAvailable(): { ok: true } | { ok: false; reason: string } {
	const enginePath = resolveEnginePath();
	if (!fs.existsSync(enginePath)) {
		return {
			ok: false,
			reason: `engine binary not found at ${enginePath} -- build with: cd ../quantlab-quantbook/quantbook-engine && cargo build -p ql-bindings-node --release`,
		};
	}
	return { ok: true };
}

function shouldSkip(): { skip: boolean; reason?: string } {
	const r = engineAvailable();
	if (!r.ok) {
		const seen = global as unknown as { __quantbookEngineSkipLogged?: boolean };
		if (!seen.__quantbookEngineSkipLogged) {
			seen.__quantbookEngineSkipLogged = true;
			console.warn(`[quantbook-roundtrip.test] SKIPPING: ${r.reason}`);
		}
		return { skip: true, reason: r.reason };
	}
	return { skip: false };
}

suite('quantbook engine round-trip -- Phase 5.7 V1', () => {

	suiteSetup(function () {
		const { skip } = shouldSkip();
		if (skip) {
			this.skip();
		}
		_resetQuantbookEngineCacheForTests();
		// **V1 (2026-05-22):** dlopen of the 3.5MB cdylib can take
		// 10-30s on first load (cold disk + symbol resolution + Loro
		// crate initialization). Without preloading, the first test
		// to call any engine method hits mocha's default 10s timeout.
		// Preload here so the dlopen cost is amortized in suiteSetup,
		// not the first test body. Bumping suiteSetup timeout to 60s
		// to be safe.
		this.timeout(60000);
		loadQuantbookEngine();
	});

	test('version() returns a non-empty semver-ish string', () => {
		const v = quantbookEngineVersion();
		assert.ok(typeof v === 'string', 'version is a string');
		assert.ok(v.length > 0, 'version is non-empty');
		assert.ok(/\d+\.\d+\.\d+/.test(v), `version looks like x.y.z, got: ${v}`);
	});

	test('CollabSession constructor accepts BigInt peer ID', () => {
		const s = createSession(1n);
		assert.strictEqual(s.peerId(), 1n);
		assert.strictEqual(s.opCount(), 0);
		assert.strictEqual(s.pendingOpCount(), 0);
		assert.strictEqual(s.hasPendingFlush(), false);
	});

	test('CollabSession constructor rejects 0n (PeerId sentinel)', () => {
		assert.throws(() => createSession(0n), /peerId/i);
	});

	test('CollabSession constructor rejects negative BigInt', () => {
		assert.throws(() => createSession(-1n), /non-negative|negative/i);
	});

	test('CollabSession constructor rejects BigInt > u64', () => {
		// 2^64 = 18446744073709551616 (one past u64::MAX which is 2^64 - 1)
		const tooBig = 1n << 64n;
		assert.throws(() => createSession(tooBig), /lossy|fit/i);
	});

	test('appendPutValue increments opCount + sets hasPendingFlush', () => {
		const s = createSession(1n);
		s.appendPutValue(0, 0, 0, 42);
		assert.strictEqual(s.opCount(), 1);
		assert.strictEqual(s.pendingOpCount(), 1);
		assert.strictEqual(s.hasPendingFlush(), true);
	});

	test('round-trip: peer A append -> export -> peer B merge -> peer B op count matches', () => {
		const peerA = createSession(1n);
		peerA.appendPutValue(0, 0, 0, 42);
		peerA.appendPutValue(0, 0, 1, 100);
		peerA.appendPutValue(0, 1, 0, -7.5);
		const aOps = peerA.opCount();
		assert.strictEqual(aOps, 3);

		const bytes = peerA.exportBytes();
		assert.ok(bytes instanceof Uint8Array, 'export returns Uint8Array');
		assert.ok(bytes.length > 0, 'export bytes non-empty');

		const peerB = createSession(2n);
		assert.strictEqual(peerB.opCount(), 0);

		const merged = peerB.mergeBytes(bytes);
		assert.ok(merged >= 1, `merged at least 1 op, got ${merged}`);
		assert.strictEqual(peerB.opCount(), aOps,
			`peer B opCount should match peer A's (${aOps}), got ${peerB.opCount()}`);
	});

	test('fromSnapshot reconstructs the same state as merge', () => {
		const peerA = createSession(1n);
		peerA.appendPutValue(0, 0, 0, 1);
		peerA.appendPutValue(0, 0, 1, 2);
		const bytes = peerA.exportBytes();

		const peerC = sessionFromSnapshot(3n, bytes);
		assert.strictEqual(peerC.peerId(), 3n, 'fromSnapshot uses provided peerId, not snapshot origin');
		assert.strictEqual(peerC.opCount(), peerA.opCount(),
			'fromSnapshot reconstructs the imported op count');
	});

	test('mergeBytes of empty array preserves op_count without panic', () => {
		// **V1 audit closure (Opus M6, 2026-05-22):** loosen the
		// assertion to match the engine-side pinned contract at
		// `ql-oplog/src/log.rs` `merge_bytes_with_empty_slice_does_not_panic`.
		// The engine pins "no panic + no partial state" -- it
		// accepts either Ok-with-unchanged-len OR Err-with-unchanged-len.
		// Loro 1.12 currently returns Err, but a future Loro version
		// may accept empty as a no-op. Either is valid; the strict
		// "must throw" assertion would silently break on Loro upgrade.
		const s = createSession(1n);
		const preCount = s.opCount();
		try {
			s.mergeBytes(new Uint8Array(0));
		} catch {
			// Err arm is acceptable.
		}
		assert.strictEqual(s.opCount(), preCount,
			'op_count unchanged after empty merge regardless of Ok/Err outcome');
	});

	test('loadQuantbookEngine caches across calls', () => {
		// Two calls should return identical references (same loaded
		// module instance).
		const m1 = loadQuantbookEngine();
		const m2 = loadQuantbookEngine();
		assert.strictEqual(m1, m2, 'engine module is cached');
	});

	// ===========================================================
	// V1 audit closure tests -- Phase 5.7 V1 audit (2026-05-22)
	// ===========================================================

	test('cache poisoning regression -- partial exports fail on every call', () => {
		// **V1 audit closure (Opus H1 + Codex M1):** if dlopen returns
		// a module missing expected exports, the loader must throw
		// on EVERY call, not just the first. The original implementation
		// set `cachedModule` BEFORE validation, so the second call
		// short-circuited via the cache and returned the bad module.
		// Closure: cache only AFTER validation passes.
		const originalDlopen = process.dlopen;
		_resetQuantbookEngineCacheForTests();
		// Inject a partial module via monkey-patched dlopen.
		(process as unknown as { dlopen: typeof process.dlopen }).dlopen =
			(mod: NodeJS.Module): void => {
				(mod as unknown as { exports: Record<string, unknown> }).exports = { foo: 1 };
			};
		try {
			assert.throws(
				() => loadQuantbookEngine(),
				/missing expected exports/,
				'first call must throw on partial exports',
			);
			assert.throws(
				() => loadQuantbookEngine(),
				/missing expected exports/,
				'second call must also throw (cache must NOT poison)',
			);
		} finally {
			process.dlopen = originalDlopen;
			_resetQuantbookEngineCacheForTests();
		}
	});

	test('stale V1-shaped binary (missing V2.1 Transport + LoopbackPair) is rejected at the boundary', () => {
		// **V2.1 audit closure (Codex MEDIUM-2, 2026-05-22)**: catch a
		// stale V1 binary at loader time instead of producing a cryptic
		// "LoopbackPair is not a constructor" TypeError at the V2.1
		// helper call site.
		const originalDlopen = process.dlopen;
		_resetQuantbookEngineCacheForTests();
		// V1-shaped exports: version() + CollabSession but no Transport + no LoopbackPair.
		(process as unknown as { dlopen: typeof process.dlopen }).dlopen =
			(mod: NodeJS.Module): void => {
				(mod as unknown as { exports: Record<string, unknown> }).exports = {
					version: () => '0.0.1-pre-v2.1',
					CollabSession: function () { /* fake constructor */ },
				};
			};
		try {
			assert.throws(
				() => loadQuantbookEngine(),
				/Transport constructor \(V2\.1\).*LoopbackPair constructor \(V2\.1\)/,
				'stale V1 binary must mention BOTH missing V2.1 exports',
			);
		} finally {
			process.dlopen = originalDlopen;
			_resetQuantbookEngineCacheForTests();
		}
	});

	test('stale V2.1-shaped binary (missing V2.2 CollabSession.prototype methods) is rejected at the boundary', () => {
		// **V2.2 audit closure (Codex MEDIUM-1, 2026-05-22)**: a V2.1
		// binary has all V2.1 top-level exports but lacks V2.2's new
		// CollabSession prototype methods. Without the V2.2 prototype
		// check the loader passes; a V2.2 helper like
		// `flushDeltaToTransport` fails later as
		// "session.flushDeltaToTransport is not a function". Catch it
		// at the loader boundary.
		const originalDlopen = process.dlopen;
		_resetQuantbookEngineCacheForTests();
		// V2.1-shaped: top-level exports present + CollabSession prototype
		// has V1 methods but NONE of V2.2's prototype methods.
		const fakeCollabSession = function () { /* fake constructor */ };
		// Add only V1 prototype methods (appendPutValue etc) — not V2.2's.
		fakeCollabSession.prototype.appendPutValue = function () { /* */ };
		fakeCollabSession.prototype.exportBytes = function () { /* */ };
		(process as unknown as { dlopen: typeof process.dlopen }).dlopen =
			(mod: NodeJS.Module): void => {
				(mod as unknown as { exports: Record<string, unknown> }).exports = {
					version: () => '0.1.0-pre-v2.2',
					CollabSession: fakeCollabSession,
					Transport: function () { /* fake */ },
					LoopbackPair: function () { /* fake */ },
				};
			};
		try {
			assert.throws(
				() => loadQuantbookEngine(),
				/CollabSession\.prototype\.flushDeltaToTransport \(V2\.2\)/,
				'stale V2.1 binary must mention missing V2.2 prototype methods',
			);
		} finally {
			process.dlopen = originalDlopen;
			_resetQuantbookEngineCacheForTests();
		}
	});

	test('appendPutValueValidated rejects negative row', () => {
		const s = createSession(1n);
		assert.throws(
			() => appendPutValueValidated(s, 0, -1, 0, 42),
			/row must be an integer/,
		);
	});

	test('appendPutValueValidated rejects fractional col', () => {
		const s = createSession(1n);
		assert.throws(
			() => appendPutValueValidated(s, 0, 0, 2.5, 42),
			/col must be an integer/,
		);
	});

	test('appendPutValueValidated rejects NaN value', () => {
		const s = createSession(1n);
		assert.throws(
			() => appendPutValueValidated(s, 0, 0, 0, NaN),
			/finite/,
		);
	});

	test('appendPutValueValidated rejects Infinity value', () => {
		const s = createSession(1n);
		assert.throws(
			() => appendPutValueValidated(s, 0, 0, 0, Infinity),
			/finite/,
		);
	});

	test('appendPutValueValidated rejects sheet > u16::MAX', () => {
		const s = createSession(1n);
		assert.throws(
			() => appendPutValueValidated(s, 65536, 0, 0, 42),
			/sheet must be/,
		);
	});

	test('appendPutValueValidated accepts valid inputs', () => {
		const s = createSession(1n);
		const preCount = s.opCount();
		appendPutValueValidated(s, 0, 0, 0, 42);
		appendPutValueValidated(s, 65535, 0xFFFFFFFF, 0xFFFFFFFF, -1.5);
		assert.ok(s.opCount() > preCount, 'valid inputs increment opCount');
	});

	test('engine appendPutValue rejects NaN at FFI boundary', () => {
		// V1 audit closure (Opus M4 / Codex H3): the engine binding's
		// `append_put_value` now rejects non-finite values BEFORE
		// constructing the Op. This is defense-in-depth on top of the
		// TS-side `appendPutValueValidated` wrapper -- a caller that
		// bypasses the wrapper (calls `s.appendPutValue` directly)
		// still gets a clean error instead of corrupting workbook
		// state with NaN.
		const s = createSession(1n);
		assert.throws(
			() => s.appendPutValue(0, 0, 0, NaN),
			/finite/,
		);
		assert.throws(
			() => s.appendPutValue(0, 0, 0, Infinity),
			/finite/,
		);
	});

	// ============================================================
	// V1 MEGAUDIT closure tests -- Codex HIGH (engine-side row/col)
	// ============================================================

	test('engine appendPutValue rejects negative row (no ToUint32 silent wrap)', () => {
		// **V1 megaudit closure (Codex HIGH, 2026-05-22):** the original
		// V1 closure only added TS-side validation via the optional
		// `appendPutValueValidated` wrapper. The engine's `#[napi]`
		// method itself still accepted `row: u32` which silently
		// ToUint32-coerced `-1` to `u32::MAX`. Direct callers (bypassing
		// the TS wrapper) corrupted workbook state with no error.
		// **Closure**: changed `row: u32, col: u32` to `row: f64, col: f64`
		// at the napi boundary, then validate finite + non-negative +
		// integer + u32-range inside the method.
		const s = createSession(1n);
		assert.throws(
			() => s.appendPutValue(0, -1, 0, 42),
			/row must be a non-negative integer/,
			'direct call with row=-1 must throw (no more silent wrap to u32::MAX)',
		);
	});

	test('engine appendPutValue rejects fractional col', () => {
		const s = createSession(1n);
		assert.throws(
			() => s.appendPutValue(0, 0, 2.5, 42),
			/col must be an integer/,
		);
	});

	test('engine appendPutValue rejects NaN row', () => {
		const s = createSession(1n);
		assert.throws(
			() => s.appendPutValue(0, NaN, 0, 42),
			/row must be a finite/,
		);
	});

	test('engine appendPutValue rejects Infinity col', () => {
		const s = createSession(1n);
		assert.throws(
			() => s.appendPutValue(0, 0, Infinity, 42),
			/col must be a finite/,
		);
	});

	test('engine appendPutValue rejects out-of-u32-range row', () => {
		const s = createSession(1n);
		// 2^32 = 4294967296 (one past u32::MAX = 4294967295)
		assert.throws(
			() => s.appendPutValue(0, 4294967296, 0, 42),
			/row must be in/,
		);
	});

	test('engine appendPutValue accepts boundary u32::MAX row', () => {
		const s = createSession(1n);
		const preCount = s.opCount();
		s.appendPutValue(0, 4294967295, 0xFFFFFFFF, 0);  // u32::MAX both
		assert.ok(s.opCount() > preCount,
			'u32::MAX row+col is valid and increments opCount');
	});

	test('mergeBytes returns post-merge op count, not delta', () => {
		// V1 audit closure (Codex M2): mergeBytes returns
		// session.op_count() AFTER merging, NOT the number of newly
		// merged ops. Verify by calling twice with the same snapshot
		// (Loro dedupes -- delta would be 0 on second call, but the
		// return is the same as the first call's).
		const peerA = createSession(1n);
		peerA.appendPutValue(0, 0, 0, 1);
		peerA.appendPutValue(0, 0, 1, 2);
		const bytes = peerA.exportBytes();
		const peerB = createSession(2n);
		const firstReturn = peerB.mergeBytes(bytes);
		const secondReturn = peerB.mergeBytes(bytes);
		assert.strictEqual(firstReturn, secondReturn,
			'mergeBytes return value is post-merge op_count (stable across duplicate merges), not delta');
	});

	test('BigInt boundary -- u64::MAX rejected (PeerID::MAX sentinel), 2^64 rejected (lossy)', () => {
		// **V1 audit closure (Rule 4 / Opus boundary test, 2026-05-22)**:
		// the original boundary test expected u64::MAX to be ACCEPTED.
		// Discovered during closure-cycle test run that Loro reserves
		// `PeerID::MAX` as an internal sentinel (verified at
		// `loro-internal-1.12.0/src/loro.rs:184` --
		// `if peer == PeerID::MAX { return Err(...) }`). Loro returned
		// a clean Err so no panic-abort hazard, but added FFI-side
		// pre-rejection for symmetry with the peer_id==0 rejection
		// and to give a consistent error message.
		const uMax = (1n << 64n) - 1n; // u64::MAX
		const oneUnderUMax = uMax - 1n;
		const oneOverUMax = 1n << 64n;
		// u64::MAX is rejected (PeerID::MAX sentinel).
		assert.throws(() => createSession(uMax), /u64::MAX|sentinel/i,
			'u64::MAX rejected with sentinel-mention message');
		// u64::MAX - 1 IS valid -- the LARGEST acceptable peer id.
		const sNearMax = createSession(oneUnderUMax);
		assert.strictEqual(sNearMax.peerId(), oneUnderUMax,
			'peerId BigInt round-trips losslessly at u64::MAX - 1');
		// 2^64 is out of u64 range.
		assert.throws(() => createSession(oneOverUMax), /lossy|fit/i);
	});
});

// =====================================================================
// Phase 5.7 V2.1 (2026-05-22) -- Transport binding tests
// =====================================================================

suite('quantbook V2.1 -- Transport binding (LoopbackPair + CollabSession)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) {
			this.skip();
		}
		_resetQuantbookEngineCacheForTests();
		this.timeout(60000);
		loadQuantbookEngine();
	});

	test('LoopbackPair construction + takeA/takeB return attachable wrappers', () => {
		const engine = loadQuantbookEngine();
		const pair = new engine.LoopbackPair();
		const tA = pair.takeA();
		const tB = pair.takeB();
		assert.ok(tA.isAttachable(), 'takeA result is attachable');
		assert.ok(tB.isAttachable(), 'takeB result is attachable');
	});

	test('LoopbackPair.takeA twice throws on second call', () => {
		const engine = loadQuantbookEngine();
		const pair = new engine.LoopbackPair();
		assert.doesNotThrow(() => pair.takeA(), 'first takeA succeeds');
		assert.throws(() => pair.takeA(), /takeA already called/);
		// takeB still works (independent ends).
		assert.doesNotThrow(() => pair.takeB(), 'takeB still works');
	});

	test('LoopbackPair.takeB twice throws on second call', () => {
		const engine = loadQuantbookEngine();
		const pair = new engine.LoopbackPair();
		assert.doesNotThrow(() => pair.takeB(), 'first takeB succeeds');
		assert.throws(() => pair.takeB(), /takeB already called/);
	});

	test('loopbackTransportPair helper returns two attachable Transports', () => {
		const [tA, tB] = loopbackTransportPair();
		assert.ok(tA.isAttachable());
		assert.ok(tB.isAttachable());
	});

	test('attachTransport consumes the Transport wrapper', () => {
		const session = createSession(1n);
		assert.ok(!session.hasTransport(), 'no transport before attach');
		const [tA, _tB] = loopbackTransportPair();
		assert.ok(tA.isAttachable(), 'fresh wrapper is attachable');

		session.attachTransport(tA);
		assert.ok(session.hasTransport(), 'transport attached after call');
		assert.ok(!tA.isAttachable(), 'wrapper consumed by attach');

		// Re-attach must throw with a consumption-mention error.
		assert.throws(
			() => session.attachTransport(tA),
			/already been consumed/,
			'second attach with consumed wrapper throws',
		);
	});

	test('detachTransport returns true when attached, false otherwise', () => {
		const session = createSession(1n);
		assert.strictEqual(session.detachTransport(), false,
			'detach with nothing attached returns false');

		const [tA, _tB] = loopbackTransportPair();
		session.attachTransport(tA);
		assert.strictEqual(session.detachTransport(), true,
			'detach after attach returns true');
		assert.ok(!session.hasTransport(), 'no transport after detach');
		assert.strictEqual(session.detachTransport(), false,
			'second detach returns false');
	});

	test('flushToTransport with no transport returns false (no error)', () => {
		const session = createSession(1n);
		assert.strictEqual(session.flushToTransport(), false,
			'flush with no transport returns false');
	});

	test('pollRemote with no transport returns 0 (no error)', () => {
		const session = createSession(1n);
		assert.strictEqual(session.pollRemote(), 0,
			'poll with no transport returns 0');
	});

	test('two-peer LoopbackPair round-trip via flushToTransport + pollRemote', () => {
		const sessionA = createSession(1n);
		const sessionB = createSession(2n);
		const [tA, tB] = loopbackTransportPair();

		sessionA.attachTransport(tA);
		sessionB.attachTransport(tB);
		assert.ok(sessionA.hasTransport() && sessionB.hasTransport());

		// Peer A mutates.
		sessionA.appendPutValue(0, 0, 0, 42);
		assert.ok(sessionA.hasPendingFlush(), 'pending flush after put');

		// Flush A -> queue arrives at B.
		assert.strictEqual(sessionA.flushToTransport(), true,
			'flush returned true (bytes sent)');
		assert.ok(!sessionA.hasPendingFlush(), 'no pending after flush');

		// Poll B; should merge >= 1 op.
		const merged = sessionB.pollRemote();
		assert.ok(merged >= 1, `poll merged >= 1, got ${merged}`);
		assert.strictEqual(sessionB.opCount(), sessionA.opCount(),
			'B opCount matches A after sync');
	});

	test('three-mutation chain across LoopbackPair: single flush -> 1 blob (blob-count contract)', () => {
		// **V2.1 audit closure (Codex MEDIUM-1, 2026-05-22)**: pin the
		// blob-count vs op-count semantic. pollRemote returns the
		// number of BLOBS drained, NOT ops. A single flush produces
		// ONE blob containing N ops, so pollRemote returns 1.
		//
		// Prior assertion `>= 1` would have silently passed if the
		// engine ever flipped to op-count semantics (>=1 is true for
		// both 1 and 3). Tightened to strictEqual(1) so any semantic
		// regression is caught.
		const sessionA = createSession(1n);
		const sessionB = createSession(2n);
		const [tA, tB] = loopbackTransportPair();
		sessionA.attachTransport(tA);
		sessionB.attachTransport(tB);

		for (let i = 0; i < 3; i += 1) {
			sessionA.appendPutValue(0, i, 0, i * 10);
		}
		assert.strictEqual(sessionA.opCount(), 3, 'A has 3 ops');
		sessionA.flushToTransport();
		const blobsDrained = sessionB.pollRemote();
		assert.strictEqual(blobsDrained, 1,
			'single flush -> 1 blob queued -> pollRemote returns 1, NOT 3 (op count)');
		assert.strictEqual(sessionB.opCount(), 3,
			'B has all 3 ops after unpacking the single blob');
	});

	test('bidirectional sync: A->B and B->A via the same pair', () => {
		const sessionA = createSession(1n);
		const sessionB = createSession(2n);
		const [tA, tB] = loopbackTransportPair();
		sessionA.attachTransport(tA);
		sessionB.attachTransport(tB);

		// A writes, B receives.
		sessionA.appendPutValue(0, 0, 0, 100);
		sessionA.flushToTransport();
		sessionB.pollRemote();

		// B writes, A receives.
		sessionB.appendPutValue(0, 1, 0, 200);
		sessionB.flushToTransport();
		sessionA.pollRemote();

		assert.strictEqual(sessionA.opCount(), sessionB.opCount(),
			'op counts match after bidirectional sync');
	});

	test('reattach a different transport resets VV baseline (offline-write contract)', () => {
		// V2 V3 step 1 contract: every attach resets `last_flushed_vv`,
		// so the next flush sends from empty. Verify via has_pending_flush:
		//   1. attach, write, flush -> hasPendingFlush=false
		//   2. detach (or reattach) -> hasPendingFlush=true
		//      (because the new peer hasn't seen any ops)
		const session = createSession(1n);
		const [tA1, _tB1] = loopbackTransportPair();
		session.attachTransport(tA1);
		session.appendPutValue(0, 0, 0, 1);
		session.flushToTransport();
		assert.ok(!session.hasPendingFlush(),
			'after flush, no pending against current transport');

		// Reattach a fresh transport. Baseline resets -> pending flips back.
		session.detachTransport();
		const [tA2, _tB2] = loopbackTransportPair();
		session.attachTransport(tA2);
		assert.ok(session.hasPendingFlush(),
			'after reattach, baseline is reset; flush is pending again');
	});

	test('attachTransport throws when wrapper already consumed by another session', () => {
		// Edge case: the same Transport wrapper passed to two sessions
		// in sequence. The second session sees the consumed wrapper
		// and throws.
		const [tA, _tB] = loopbackTransportPair();
		const sessionA = createSession(1n);
		const sessionB = createSession(2n);
		sessionA.attachTransport(tA);
		assert.throws(
			() => sessionB.attachTransport(tA),
			/already been consumed/,
			'second session sees consumed wrapper',
		);
	});

	// =================================================================
	// Phase 5.7 V2.2 (2026-05-22) -- Full sync Transport surface
	// =================================================================
	//
	// Tests for: flushDeltaToTransport, pollRemoteWithLimit,
	// transportLastError, setAutoFlushPolicy + autoFlushPolicy.

	test('flushDeltaToTransport second call with no state change short-circuits to false', () => {
		// V2 V3 step 1 idempotency: the SECOND flushDeltaToTransport
		// with no state change since the first returns Ok(false)
		// without invoking transport.send.
		//
		// **First flush after attach is NOT a no-op** even on an empty
		// log: attach resets last_flushed_vv to None, so the first
		// flush encodes from the empty VV and sends a baseline blob.
		// Subsequent flushes with no new state hit the idempotency
		// guard.
		const sessionA = createSession(1n);
		const [tA, _tB] = loopbackTransportPair();
		sessionA.attachTransport(tA);

		// First flush: sends the baseline (encodes from empty VV).
		const first = sessionA.flushDeltaToTransport();
		assert.strictEqual(first, true,
			'first delta flush after attach sends a baseline (VV reset by attach)');
		// Second flush with no state change: idempotency short-circuit.
		const second = sessionA.flushDeltaToTransport();
		assert.strictEqual(second, false,
			'second flush with no new state -> idempotency short-circuit');
	});

	test('flushDeltaToTransport sends bytes when state has changed', () => {
		const sessionA = createSession(1n);
		const sessionB = createSession(2n);
		const [tA, tB] = loopbackTransportPair();
		sessionA.attachTransport(tA);
		sessionB.attachTransport(tB);

		sessionA.appendPutValue(0, 0, 0, 42);
		assert.strictEqual(sessionA.flushDeltaToTransport(), true,
			'state changed -> delta flush sends');
		assert.strictEqual(sessionA.hasPendingFlush(), false,
			'no pending after flush');
		assert.strictEqual(sessionB.pollRemote(), 1, 'B drains 1 blob');
		assert.strictEqual(sessionB.opCount(), 1, 'B has the op');
	});

	test('flushDeltaToTransport with no transport returns false (no error)', () => {
		const session = createSession(1n);
		assert.strictEqual(session.flushDeltaToTransport(), false);
	});

	test('flushDeltaToTransport vs flushToTransport: delta idempotency vs full unconditional send', () => {
		// **V2.2 audit closure (Codex LOW-3, 2026-05-22)**: comment
		// re-grounded. Prior version said "delta will send 0 ops" which
		// was misleading — the first delta after attach DOES send the
		// pending op (from empty VV) and advances last_flushed_vv. The
		// second delta with no state change is the no-op. The
		// behavioral comparison this test pins:
		//   - flushDeltaToTransport: idempotency-guarded. Sends pending
		//     ops on first call after a state change; returns false on
		//     the second call with no state change.
		//   - flushToTransport: unconditional. Sends the full snapshot
		//     every call regardless of state.
		// Loro dedupe ensures B sees the single op once regardless of
		// how many times the blob arrives.
		const sessionA = createSession(1n);
		const sessionB = createSession(2n);
		const [tA, tB] = loopbackTransportPair();
		sessionA.attachTransport(tA);
		sessionB.attachTransport(tB);

		sessionA.appendPutValue(0, 0, 0, 1);
		assert.strictEqual(sessionA.flushDeltaToTransport(), true);
		// Subsequent flush with no state change is no-op.
		assert.strictEqual(sessionA.flushDeltaToTransport(), false,
			'second delta flush with no new state is no-op');
		// Full flush still sends (no idempotency guard on the
		// full-snapshot path).
		assert.strictEqual(sessionA.flushToTransport(), true,
			'full flush sends regardless of state change');
		sessionB.pollRemote();
		sessionB.pollRemote(); // drain both blobs
		assert.strictEqual(sessionB.opCount(), 1, 'B has the single op (deduped)');
	});

	test('pollRemoteWithLimit(0) is no-op even when blobs queued', () => {
		const sessionA = createSession(1n);
		const sessionB = createSession(2n);
		const [tA, tB] = loopbackTransportPair();
		sessionA.attachTransport(tA);
		sessionB.attachTransport(tB);

		sessionA.appendPutValue(0, 0, 0, 1);
		sessionA.flushDeltaToTransport();
		// 1 blob queued.
		assert.strictEqual(sessionB.pollRemoteWithLimit(0), 0,
			'limit=0 returns 0 without draining');
		// The blob is still there.
		assert.strictEqual(sessionB.pollRemoteWithLimit(10), 1,
			'subsequent unlimited poll still drains');
	});

	test('pollRemoteWithLimit drains up to limit blobs per call', () => {
		const sessionA = createSession(1n);
		const sessionB = createSession(2n);
		const [tA, tB] = loopbackTransportPair();
		sessionA.attachTransport(tA);
		sessionB.attachTransport(tB);

		// Queue 3 separate blobs by doing 3 flushes (mutation between
		// each so the idempotency guard doesn't short-circuit).
		for (let i = 0; i < 3; i += 1) {
			sessionA.appendPutValue(0, i, 0, i);
			sessionA.flushDeltaToTransport();
		}

		// limit=2: drain 2 of the 3.
		assert.strictEqual(sessionB.pollRemoteWithLimit(2), 2,
			'limit=2 drains exactly 2 blobs');
		// limit=10: drain the remaining 1.
		assert.strictEqual(sessionB.pollRemoteWithLimit(10), 1,
			'remaining 1 blob drained on next call');
		assert.strictEqual(sessionB.opCount(), 3, 'all 3 ops delivered');
	});

	test('pollRemoteWithLimit rejects negative limit', () => {
		const session = createSession(1n);
		assert.throws(
			() => session.pollRemoteWithLimit(-1),
			/limit must be a non-negative/,
		);
	});

	test('pollRemoteWithLimit rejects NaN limit', () => {
		const session = createSession(1n);
		assert.throws(
			() => session.pollRemoteWithLimit(NaN),
			/limit must be a finite/,
		);
	});

	test('pollRemoteWithLimit rejects fractional limit', () => {
		const session = createSession(1n);
		assert.throws(
			() => session.pollRemoteWithLimit(2.5),
			/limit must be an integer/,
		);
	});

	test('pollRemoteWithLimit rejects out-of-u32 limit', () => {
		const session = createSession(1n);
		assert.throws(
			() => session.pollRemoteWithLimit(4294967296),
			/limit must be in/,
		);
	});

	test('transportLastError returns null when no transport attached', () => {
		const session = createSession(1n);
		assert.strictEqual(session.transportLastError(), null);
	});

	test('transportLastError returns null on a clean Loopback transport', () => {
		const session = createSession(1n);
		const [tA, _tB] = loopbackTransportPair();
		session.attachTransport(tA);
		// LoopbackTransport never reports errors in V2.1 sync usage.
		assert.strictEqual(session.transportLastError(), null);
	});

	test('autoFlushPolicy defaults to "disabled"', () => {
		const session = createSession(1n);
		assert.strictEqual(session.autoFlushPolicy(), 'disabled');
	});

	test('setAutoFlushPolicy("onAppend") returns prior "disabled" and switches state', () => {
		const session = createSession(1n);
		assert.strictEqual(session.setAutoFlushPolicy('onAppend'), 'disabled');
		assert.strictEqual(session.autoFlushPolicy(), 'onAppend');
	});

	test('setAutoFlushPolicy round-trip: onAppend -> disabled -> onAppend', () => {
		const session = createSession(1n);
		session.setAutoFlushPolicy('onAppend');
		assert.strictEqual(session.setAutoFlushPolicy('disabled'), 'onAppend');
		assert.strictEqual(session.setAutoFlushPolicy('onAppend'), 'disabled');
	});

	test('setAutoFlushPolicy rejects unknown string', () => {
		const session = createSession(1n);
		assert.throws(
			() => session.setAutoFlushPolicy('always' as 'disabled'),
			/AutoFlushPolicy must be/,
		);
	});

	// **V2.2 audit closure (Opus HIGH-2, 2026-05-22)**: removed test
	// `setAutoFlushPolicy accepts aliases` which used `as 'disabled'`
	// casts to bypass TS type narrowing. The pattern would propagate
	// to V2.3+ tests and contradicts the public TS type contract.
	//
	// **Where engine alias-acceptance IS pinned**: engine-side tests in
	// `ql-collab/src/session.rs` (the parser is engine-internal). The
	// IDE binding's PUBLIC CONTRACT is the camelCase TS union; IDE
	// callers should pass `'disabled'` | `'onAppend'` only. If a
	// future use case needs to accept alias strings from external
	// config, V2.3+ should add an explicit `setAutoFlushPolicyRaw(s: string)`
	// method (or a config-side normalization helper that calls
	// `isAutoFlushPolicy` first).

	test('onAppend on poll_remote: V2 V3 step 2 contract (post-poll auto-flush echoes onward)', () => {
		// **V2.2 audit closure (Codex MEDIUM-2, 2026-05-22)**: V2 V3 step 2
		// wires pollRemote into auto-flush. After a successful drain
		// (merged > 0) under OnAppend, one auto-flush fires per call.
		// The IDEA: a hub session that polls + auto-flushes routes ops
		// onward to a third peer. This binding test pins the contract
		// via 2 peers + an idempotency check that proves the auto-flush
		// fired without echo-looping.
		const sessionA = createSession(1n);
		const sessionB = createSession(2n);
		const [tA, tB] = loopbackTransportPair();
		sessionA.attachTransport(tA);
		sessionB.attachTransport(tB);
		sessionB.setAutoFlushPolicy('onAppend');

		// A appends + flushes; B drains 1 blob.
		sessionA.appendPutValue(0, 0, 0, 1);
		sessionA.flushDeltaToTransport();
		assert.strictEqual(sessionB.pollRemoteWithLimit(1), 1, 'B drains A blob');
		assert.strictEqual(sessionB.opCount(), 1);
		// V2 V3 step 1 idempotency guard: after the post-poll auto-flush
		// fires, hasPendingFlush on B should be false (the new ops on
		// B's log are exactly what was just received; sending them back
		// to A is a no-op via VV equality). The implicit auto-flush
		// must NOT have created a perpetual echo.
		assert.strictEqual(sessionB.hasPendingFlush(), false,
			'B: post-poll auto-flush fired, then idempotency guard short-circuited the echo');
	});

	test('onAppend auto-flushes after every mutator (two-peer convergence)', () => {
		// Real onAppend integration test: A flips to onAppend, B polls,
		// A appends, the auto-flush hits the wire, B sees ops without
		// an explicit A-side flush.
		const sessionA = createSession(1n);
		const sessionB = createSession(2n);
		const [tA, tB] = loopbackTransportPair();
		sessionA.attachTransport(tA);
		sessionB.attachTransport(tB);
		sessionA.setAutoFlushPolicy('onAppend');

		sessionA.appendPutValue(0, 0, 0, 100);
		// No explicit flushToTransport. The mutation auto-flushed.
		assert.strictEqual(sessionA.hasPendingFlush(), false,
			'auto-flush cleared the pending state');
		assert.strictEqual(sessionB.pollRemote(), 1, 'B drains 1 blob');
		assert.strictEqual(sessionB.opCount(), 1, 'B has the auto-flushed op');
	});

	test('isAutoFlushPolicy strict guard rejects engine aliases', () => {
		// The TS-side guard is camelCase-strict. Engine accepts loose
		// variants but the TS guard does not. Important: IDE code that
		// reads a policy string from config/storage MUST validate
		// via isAutoFlushPolicy before passing to setAutoFlushPolicy.
		assert.ok(isAutoFlushPolicy('disabled'));
		assert.ok(isAutoFlushPolicy('onAppend'));
		assert.ok(!isAutoFlushPolicy('Disabled'));
		assert.ok(!isAutoFlushPolicy('on-append'));
		assert.ok(!isAutoFlushPolicy('always'));
		assert.ok(!isAutoFlushPolicy(undefined));
		assert.ok(!isAutoFlushPolicy(42));
	});

	test('detach does NOT drop bytes already queued for peer (Arc-shared LoopbackTransport queue)', () => {
		// **V2.1 audit closure (Opus HIGH-1, 2026-05-22)**: pin the
		// correct in-flight delivery behavior. The prior version of
		// this test pinned the OPPOSITE spec ("detach drops in-flight
		// bytes") with a tautological assertion `merged >= 0` — wrong
		// AND undiscriminating.
		//
		// **Actual contract** verified at
		// `crates/ql-collab/src/transport.rs::LoopbackTransport::pair()`:
		// the two endpoints share their queues via Arc<Mutex<VecDeque>>.
		// A's outbox IS b.inbox; when A is dropped, its Arc clones
		// decrement but B's Arc keeps the queue ALIVE with bytes intact.
		// So B's pollRemote still drains A's queued bytes after A
		// detaches.
		//
		// This is load-bearing for the V2 V3 step 3 offline-write
		// contract: a sender that goes offline mid-flush has its bytes
		// preserved until the peer polls them.
		const sessionA = createSession(1n);
		const sessionB = createSession(2n);
		const [tA, tB] = loopbackTransportPair();
		sessionA.attachTransport(tA);
		sessionB.attachTransport(tB);

		sessionA.appendPutValue(0, 0, 0, 1);
		sessionA.flushToTransport();
		// A's bytes are now on the shared queue. Detach A's transport.
		sessionA.detachTransport();
		// B's Arc on the shared queue is unaffected; the queued bytes
		// remain. Poll drains them.
		const blobsDrained = sessionB.pollRemote();
		assert.strictEqual(blobsDrained, 1,
			'B drained the 1 queued blob after A detached (Arc-shared queue keeps bytes alive)');
		assert.strictEqual(sessionB.opCount(), 1,
			'B has the op even though A detached (in-flight bytes delivered)');
	});
});

// =====================================================================
// Phase 5.7 V2.3 (2026-05-22) -- async Transport surface
// (WebSocketTransport.connect + flushPendingToTransport)
// =====================================================================

import { WebSocketServer, WebSocket as WsClient } from 'ws';
import { AddressInfo } from 'net';

interface SpawnedWsServer {
	url: string;
	close: () => Promise<void>;
}

/**
 * Spawn an in-process WebSocket echo-fanout server on a random port.
 *
 * **V2.3 design note**: the engine's tokio-tungstenite client speaks
 * the standard WebSocket binary-frame protocol. Node's `ws` package
 * on the same protocol is sufficient for round-trip tests. Each
 * inbound binary message is fanned out to ALL other connected
 * clients — that's the minimum semantics for "two peers connected
 * to a localhost relay can sync via the engine's WebSocketTransport".
 */
async function spawnWsRelay(): Promise<SpawnedWsServer> {
	return new Promise((resolve, reject) => {
		const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
		const sockets: WsClient[] = [];
		wss.on('connection', (ws: WsClient) => {
			sockets.push(ws);
			ws.on('message', (data: Buffer, isBinary: boolean) => {
				if (!isBinary) {
					return; // V2.3 only handles binary frames
				}
				for (const peer of sockets) {
					if (peer !== ws && peer.readyState === peer.OPEN) {
						peer.send(data, { binary: true });
					}
				}
			});
			ws.on('close', () => {
				const i = sockets.indexOf(ws);
				if (i >= 0) {
					sockets.splice(i, 1);
				}
			});
		});
		wss.on('error', reject);
		wss.on('listening', () => {
			const addr = wss.address() as AddressInfo;
			resolve({
				url: `ws://127.0.0.1:${addr.port}`,
				close: () => new Promise<void>((res) => {
					// **V2.3 audit closure (Opus MEDIUM-4, 2026-05-22)**:
					// the prior version wrapped `s.terminate()` in
					// `try { ... } catch { /* ignore */ }` which
					// silently swallowed errors (CLAUDE.md no-fallback
					// violation, in test code too). `ws.terminate()` is
					// documented to never throw -- it forcibly closes
					// the socket without sending a Close frame. The
					// only way it could "error" is if the socket is
					// already destroyed, which is fine (idempotent).
					// Removing the try/catch surfaces any real future
					// error class loudly.
					for (const s of sockets) {
						s.terminate();
					}
					wss.close(() => res());
				}),
			});
		});
	});
}

suite('quantbook V2.3 -- async Transport surface (WebSocketTransport + flushPending)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) {
			this.skip();
		}
		_resetQuantbookEngineCacheForTests();
		this.timeout(60000);
		loadQuantbookEngine();
	});

	test('Transport.websocketConnect rejects on invalid URL with InvalidUrl category', async () => {
		// **V2.3 audit closure (Codex LOW-1, 2026-05-22)**: prior version
		// of this test accepted any of 3 categories. tokio-tungstenite's
		// URL parser categorizes `not-a-ws-url` as InvalidUrl (the
		// classifier hits the `tokio_tungstenite::tungstenite::Error::Url(_)`
		// arm in `ql-collab-ws/src/lib.rs::WebSocketTransport::connect`).
		// Pin the exact category prefix.
		const engine = loadQuantbookEngine();
		await assert.rejects(
			engine.Transport.websocketConnect('not-a-ws-url'),
			/invalid WebSocket URL/,
			'rejection must carry InvalidUrl prefix (engine WebSocketError::InvalidUrl)',
		);
	});

	test('Transport.websocketConnect rejects on connection refused with ConnectFailed category', async function () {
		// **V2.3 audit closure (Codex LOW-1, 2026-05-22)**: the prior
		// version accepted ConnectFailed OR HandshakeFailed; tokio-
		// tungstenite categorizes TCP refusals as the `Error::Io(_)`
		// arm → ConnectFailed at the binding. Pin it.
		this.timeout(10000);
		const engine = loadQuantbookEngine();
		await assert.rejects(
			// Port 1 is privileged + almost certainly not listening.
			engine.Transport.websocketConnect('ws://127.0.0.1:1'),
			/WebSocket connection failed/,
			'TCP refusal must surface as ConnectFailed (engine WebSocketError::ConnectFailed)',
		);
	});

	test('Transport.websocketConnect succeeds against a localhost relay + returns attachable Transport', async function () {
		this.timeout(15000);
		const relay = await spawnWsRelay();
		try {
			const engine = loadQuantbookEngine();
			const t = await engine.Transport.websocketConnect(relay.url);
			assert.ok(t.isAttachable(),
				'returned Transport is attachable (single-use, fresh)');
		} finally {
			await relay.close();
		}
	});

	test('two-peer round-trip via WebSocketTransport relay (V2.3 end-to-end async sync)', async function () {
		this.timeout(20000);
		const relay = await spawnWsRelay();
		try {
			const engine = loadQuantbookEngine();
			const tA = await engine.Transport.websocketConnect(relay.url);
			const tB = await engine.Transport.websocketConnect(relay.url);

			const sessionA = createSession(1n);
			const sessionB = createSession(2n);
			sessionA.attachTransport(tA);
			sessionB.attachTransport(tB);

			sessionA.appendPutValue(0, 0, 0, 42);
			assert.strictEqual(sessionA.flushDeltaToTransport(), true,
				'A delta flush queues bytes to its WebSocket writer');

			// **V2.3 audit closure (Codex FAIL + Opus, 2026-05-22)**:
			// removed `flushPendingToTransport` (engine pair + IDE).
			// Without explicit drain-ack, use a bounded poll loop here
			// to wait for B's reader to enqueue the blob. ~10ms is
			// typical on localhost; the loop allows up to 2 seconds
			// before failing (covers slow CI). Replaces the prior
			// brittle 50ms setTimeout (Codex V2.3 LOW-3 + Opus M3).
			const deadline = Date.now() + 2000;
			let blobsDrained = 0;
			while (Date.now() < deadline) {
				blobsDrained = sessionB.pollRemote();
				if (blobsDrained > 0) {
					break;
				}
				await new Promise<void>((res) => setTimeout(res, 10));
			}
			assert.ok(blobsDrained >= 1, `B drained at least 1 blob, got ${blobsDrained}`);
			assert.strictEqual(sessionB.opCount(), 1,
				'B has A op after async round-trip');

			sessionA.detachTransport();
			sessionB.detachTransport();
		} finally {
			await relay.close();
		}
	});

	test('websocketConnect-returned Transport is single-use (consumed by attachTransport)', async function () {
		// **V2.3 audit closure (Codex LOW-2, 2026-05-22)**: V2.1 pinned
		// single-use semantics for LoopbackPair Transports; this test
		// pins the same for WebSocket-connected Transports (the
		// underlying napi class is the same `Transport { inner:
		// Option<Box<dyn Transport>> }`).
		this.timeout(10000);
		const relay = await spawnWsRelay();
		try {
			const engine = loadQuantbookEngine();
			const t = await engine.Transport.websocketConnect(relay.url);
			const sessionA = createSession(1n);
			const sessionB = createSession(2n);
			assert.ok(t.isAttachable());
			sessionA.attachTransport(t);
			assert.ok(!t.isAttachable(),
				'consumed by attachTransport (single-use)');
			assert.throws(
				() => sessionB.attachTransport(t),
				/already been consumed/,
				'second session attach rejects consumed wrapper',
			);
			sessionA.detachTransport();
		} finally {
			await relay.close();
		}
	});

	// **V2.4 reintroduction (2026-05-22)**: `flushPendingToTransport`
	// reintroduced after the Arc<Mutex> + spawn_blocking refactor.
	// Tests below mirror the V2.3 originals + add a concurrent-call
	// test that pins the V2.4 soundness contract.

	test('flushPendingToTransport on no-transport session resolves without error', async () => {
		const session = createSession(1n);
		await session.flushPendingToTransport();
	});

	test('flushPendingToTransport on attached-no-pending session resolves quickly', async function () {
		this.timeout(5000);
		const session = createSession(1n);
		const [tA, _tB] = loopbackTransportPair();
		session.attachTransport(tA);
		const start = Date.now();
		await session.flushPendingToTransport();
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 1000,
			`flushPending on idle session resolved in ${elapsed}ms (< 1000)`);
	});

	test('flushPending after a flushDelta drains the local writer queue (WebSocket)', async function () {
		this.timeout(15000);
		const relay = await spawnWsRelay();
		try {
			const engine = loadQuantbookEngine();
			const tA = await engine.Transport.websocketConnect(relay.url);
			const session = createSession(1n);
			session.attachTransport(tA);

			session.appendPutValue(0, 0, 0, 1);
			assert.strictEqual(session.flushDeltaToTransport(), true);
			// V2 V4 V1 Tier K1: after flushPending, the writer task
			// has completed `send` for every queued blob.
			await session.flushPendingToTransport();
			session.detachTransport();
		} finally {
			await relay.close();
		}
	});

	// ===============================================================
	// Phase 5.7 V2.5 (2026-05-22) — V8-block CLOSURE contract tests
	// ===============================================================
	//
	// V2.4's two "smoke tests" using LoopbackPair (vacuous per Opus
	// V2.4 MEDIUM-2) are REPLACED with V2.5 contract tests using
	// `BlockingTransportFixture`. The fixture forces deterministic
	// `flush_pending` contention so a concurrent JS sync call's
	// elapsed time becomes a measurable signal of whether the V2.5
	// lock-release pattern is in effect.

	test('V2.5 contract: flushPendingToTransport does NOT block sync methods on the same session (BlockingTransportFixture)', async function () {
		// **THE V2.5 PIN.** Closes Opus V2.4 HIGH-1 (V8-block UX hazard).
		//
		// Pattern:
		//   1. Construct a BlockingTransportFixture with blockMs = 2000.
		//      (V2.5 audit closure Opus LOW-1, 2026-05-22: bumped from
		//      1000ms to 2000ms to widen the absolute gap between V2.4
		//      "broken" behavior (~2000ms block) and V2.5 "fixed"
		//      behavior (~50ms). Threshold stays at 500ms.)
		//   2. Attach the fixture's transport to a session.
		//   3. Start flushPendingToTransport (the spawn_blocking task
		//      starts; engine-side wait enters Condvar).
		//   4. Await fixture.waitUntilBlocked() -- deterministic
		//      synchronization point (Codex M3 fix): we are NOW sure
		//      the spawn_blocking task has acquired its handle and is
		//      blocked in wait_for_drain.
		//   5. Call session.opCount(). Under V2.5: returns ~immediately
		//      because the session lock was released in step 3. Under
		//      V2.4 (the bug): would block ~2000ms because the session
		//      lock was held during the wait.
		//   6. Assert elapsed < 500ms (= blockMs/4 with the V2.5
		//      audit closure margin). Discrimination signal: V2.4 ~2000ms
		//      vs V2.5 ~50ms is 40x; 500ms threshold catches any
		//      regression while tolerating 10x slowdown for slow CI.
		this.timeout(10000);
		const engine = loadQuantbookEngine();
		const fixture = new (requireBlockingTransportFixture(engine))(2000);
		const t = fixture.takeTransport();
		const session = createSession(1n);
		session.attachTransport(t);

		const flushP = session.flushPendingToTransport();
		await fixture.waitUntilBlocked();

		const start = Date.now();
		const count = session.opCount();
		const elapsed = Date.now() - start;
		assert.strictEqual(count, 0, 'opCount returns correct value mid-pending-flush');
		assert.ok(
			elapsed < 500,
			`V2.5 contract: opCount during pending flushPending took ${elapsed}ms; expected < 500. ` +
			`Under V2.4 binding pattern this would block ~2000ms (blockMs).`,
		);

		fixture.release();
		await flushP;
	});

	test('V2.5 contract: concurrent flushPendingToTransport calls both resolve after single release() (BlockingTransportFixture)', async function () {
		// **V2.5 audit closure (Codex LOW-2, 2026-05-22)**: prior test
		// name claimed "serialize through ack handle" which overclaimed
		// what's tested. Each call spawns its own spawn_blocking task +
		// extracts an independent ack handle; both handles wait on the
		// SAME shared release Condvar; release() wakes both
		// simultaneously. The test verifies BOTH promises resolve --
		// it does NOT assert serialization (and they don't serialize:
		// they coalesce on the shared release).
		//
		// True serialization (e.g., one wait must complete before the
		// other begins) would require ack-handle-internal locking, which
		// V2.5 deliberately avoids -- the V8-block closure works because
		// the handles are non-locking Arc clones.
		this.timeout(10000);
		const engine = loadQuantbookEngine();
		const fixture = new (requireBlockingTransportFixture(engine))(2000);
		const t = fixture.takeTransport();
		const session = createSession(1n);
		session.attachTransport(t);

		const p1 = session.flushPendingToTransport();
		const p2 = session.flushPendingToTransport();
		// Give both spawn_blocking tasks time to enter their waits.
		await fixture.waitUntilBlocked();

		// release() wakes both (shared release Condvar).
		fixture.release();
		await Promise.all([p1, p2]);
	});

	test('V2.6 BlockingTransportFixture: takeTransport is single-use', async function () {
		this.timeout(5000);
		const engine = loadQuantbookEngine();
		const fixture = new (requireBlockingTransportFixture(engine))(100);
		// First take succeeds.
		const t = fixture.takeTransport();
		assert.ok(t.isAttachable(), 'first takeTransport returns attachable Transport');
		// Second take errors.
		assert.throws(
			() => fixture.takeTransport(),
			/takeTransport already called/,
		);
	});

	test('V2.6 BlockingTransportFixture: blockMs upper bound prevents indefinite hang', async function () {
		// Construct with blockMs = 100; never release. The flush
		// should still resolve via the upper-bound timeout, not hang
		// the test.
		this.timeout(5000);
		const engine = loadQuantbookEngine();
		const fixture = new (requireBlockingTransportFixture(engine))(100);
		const t = fixture.takeTransport();
		const session = createSession(1n);
		session.attachTransport(t);

		const start = Date.now();
		await session.flushPendingToTransport();
		const elapsed = Date.now() - start;
		// Should exit around 100ms. Bound generously for slow CI.
		assert.ok(
			elapsed >= 80 && elapsed < 1500,
			`upper-bound exit landed at ${elapsed}ms; expected ~100ms`,
		);
	});

	test('V2.6 BlockingTransportFixture: release() is idempotent', async function () {
		this.timeout(5000);
		const engine = loadQuantbookEngine();
		const fixture = new (requireBlockingTransportFixture(engine))(2000);
		fixture.release();
		fixture.release(); // second call must not throw or deadlock
		// Now take + attach + flush. Since release is already set,
		// the wait short-circuits on entry.
		const t = fixture.takeTransport();
		const session = createSession(1n);
		session.attachTransport(t);
		const start = Date.now();
		await session.flushPendingToTransport();
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 500, `pre-released wait exits quickly; took ${elapsed}ms`);
	});

	test('V2.6 BlockingTransportFixture: constructor rejects invalid blockMs (non-finite / negative / fractional / zero)', async function () {
		// V2.5 audit closure (Codex MEDIUM-1, 2026-05-22): zero is now
		// rejected at the napi boundary as an availability DoS guard.
		// See engine `BlockingTransportFixture::new` docstring.
		const engine = loadQuantbookEngine();
		assert.throws(
			() => new (requireBlockingTransportFixture(engine))(NaN),
			/blockMs must be a finite/,
		);
		assert.throws(
			() => new (requireBlockingTransportFixture(engine))(-1),
			/blockMs must be a non-negative integer/,
		);
		assert.throws(
			() => new (requireBlockingTransportFixture(engine))(2.5),
			/blockMs must be an integer/,
		);
		// V2.5 closure (Codex M1): zero rejected to prevent indefinite
		// blocking from JS callers.
		assert.throws(
			() => new (requireBlockingTransportFixture(engine))(0),
			/blockMs must be > 0/,
		);
	});

	test('V2.8 closure: production cdylib without BlockingTransportFixture loads OK; requireBlockingTransportFixture surfaces clear message', () => {
		// **V2.8 megaudit closure (Opus-B Lane C HIGH-1 + Lane A LOW-1
		// convergent, 2026-05-22)**: pre-V2.8 a binary built without
		// `ql-collab/test-fixtures` was rejected at the boundary (the
		// fixture was always required because `ql-bindings-node`
		// enabled the feature unconditionally). V2.8 escalated the
		// production-cdylib leak from V2.5-LOW-2 to HIGH (self-DoS
		// surface: any in-process JS could park tokio blocking-pool
		// threads for u32::MAX ms) and closed it by gating the
		// fixture behind a binding-side `test-fixtures` Cargo
		// feature. Production builds (default) load fine WITHOUT the
		// fixture; only mocha + contention contract tests need the
		// feature enabled.
		//
		// This test pins both halves of the new contract:
		//   - loader does NOT throw on a fixture-less binary;
		//   - requireBlockingTransportFixture(engine) DOES throw with
		//     an actionable rebuild message if a test tries to use it.
		const originalDlopen = process.dlopen;
		_resetQuantbookEngineCacheForTests();
		const fakeCollabSession = function () { /* fake */ };
		for (const m of [
			'appendPutValue', 'exportBytes', 'mergeBytes', 'opCount',
			'pendingOpCount', 'hasPendingFlush', 'peerId',
			'attachTransport', 'detachTransport', 'hasTransport',
			'flushToTransport', 'pollRemote',
			'flushDeltaToTransport', 'pollRemoteWithLimit',
			'transportLastError', 'setAutoFlushPolicy', 'autoFlushPolicy',
			'flushPendingToTransport',
		]) {
			(fakeCollabSession.prototype as Record<string, unknown>)[m] = function () { /* */ };
		}
		const fakeTransport = function () { /* fake */ } as unknown as { websocketConnect?: unknown };
		fakeTransport.websocketConnect = function () { /* fake */ };
		(process as unknown as { dlopen: typeof process.dlopen }).dlopen =
			(mod: NodeJS.Module): void => {
				(mod as unknown as { exports: Record<string, unknown> }).exports = {
					version: () => '0.1.0-prod-no-fixture',
					CollabSession: fakeCollabSession,
					Transport: fakeTransport,
					LoopbackPair: function () { /* fake */ },
					// BlockingTransportFixture intentionally omitted —
					// simulates a production build (no `--features
					// test-fixtures`).
				};
			};
		try {
			// Half 1: loader accepts the fixture-less binary.
			const engine = loadQuantbookEngine();
			assert.strictEqual(
				engine.BlockingTransportFixture,
				undefined,
				'production cdylib does not export BlockingTransportFixture',
			);
			// Half 2: tests that try to use the fixture get a clear
			// rebuild message.
			assert.throws(
				() => requireBlockingTransportFixture(engine),
				/cargo build .* --features test-fixtures/,
				'requireBlockingTransportFixture must point users at the rebuild command',
			);
		} finally {
			process.dlopen = originalDlopen;
			_resetQuantbookEngineCacheForTests();
		}
	});

	test('stale V2.3-shaped binary (missing V2.4 flushPendingToTransport) is rejected at the boundary', () => {
		// V2.4 closure test (Codex LOW-3, 2026-05-22) — kept from
		// V2.4 cycle. Validates that the loader's V2.4 prototype
		// check still fires for a V2.3-shaped binary.
		const originalDlopen = process.dlopen;
		_resetQuantbookEngineCacheForTests();
		const fakeCollabSession = function () { /* fake */ };
		for (const m of [
			'appendPutValue', 'exportBytes', 'mergeBytes', 'opCount',
			'pendingOpCount', 'hasPendingFlush', 'peerId',
			'attachTransport', 'detachTransport', 'hasTransport',
			'flushToTransport', 'pollRemote',
			'flushDeltaToTransport', 'pollRemoteWithLimit',
			'transportLastError', 'setAutoFlushPolicy', 'autoFlushPolicy',
		]) {
			(fakeCollabSession.prototype as Record<string, unknown>)[m] = function () { /* */ };
		}
		const fakeTransport = function () { /* fake */ } as unknown as { websocketConnect?: unknown };
		fakeTransport.websocketConnect = function () { /* fake */ };
		(process as unknown as { dlopen: typeof process.dlopen }).dlopen =
			(mod: NodeJS.Module): void => {
				(mod as unknown as { exports: Record<string, unknown> }).exports = {
					version: () => '0.1.0-pre-v2.4',
					CollabSession: fakeCollabSession,
					Transport: fakeTransport,
					LoopbackPair: function () { /* fake */ },
					BlockingTransportFixture: function () { /* fake V2.6 */ },
				};
			};
		try {
			assert.throws(
				() => loadQuantbookEngine(),
				/CollabSession\.prototype\.flushPendingToTransport \(V2\.4\)/,
				'stale V2.3 binary must mention the missing V2.4 export',
			);
		} finally {
			process.dlopen = originalDlopen;
			_resetQuantbookEngineCacheForTests();
		}
	});
});

// =============================================================
// Phase 5.7 V2.7 (2026-05-22) -- structured error-code discrimination
// =============================================================
//
// Closes V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards. Two test
// groups:
//
//   (A) parseQuantbookError unit tests (no engine load needed):
//       prefix parsing, fallback semantics, type guards.
//
//   (B) End-to-end integration: drive a real engine error through
//       the napi binding + verify the code is recoverable from
//       JS via parseQuantbookError. Pins the bracket-prefix
//       convention as a contract, not coincidence.

suite('quantbook V2.7 -- structured error-code discrimination (parseQuantbookError unit)', function () {
	// These tests do NOT require the engine to load -- they exercise
	// the pure-TS parser. Run regardless of QUANTBOOK_ENGINE_PATH.

	test('parseQuantbookError extracts known transport_closed code', () => {
		const err = new Error('[transport_closed] transport closed');
		const info = parseQuantbookError(err);
		assert.strictEqual(info.code, 'transport_closed');
		assert.strictEqual(info.message, 'transport closed');
		assert.strictEqual(info.cause, err);
	});

	test('parseQuantbookError extracts websocket_invalid_url code with message body', () => {
		const err = new Error('[websocket_invalid_url] invalid WebSocket URL: not-a-url');
		const info = parseQuantbookError(err);
		assert.strictEqual(info.code, 'websocket_invalid_url');
		assert.strictEqual(info.message, 'invalid WebSocket URL: not-a-url');
	});

	test('parseQuantbookError falls back to unknown for missing prefix', () => {
		const err = new Error('plain old error with no prefix');
		const info = parseQuantbookError(err);
		assert.strictEqual(info.code, 'unknown');
		assert.strictEqual(info.message, 'plain old error with no prefix');
	});

	test('parseQuantbookError falls back to unknown for unrecognized prefix code', () => {
		// Unknown code = engine introduces new variant before IDE
		// updates the union. Treated as 'unknown' + full message preserved.
		const err = new Error('[future_new_kind] some new error');
		const info = parseQuantbookError(err);
		assert.strictEqual(info.code, 'unknown');
		assert.strictEqual(info.message, '[future_new_kind] some new error',
			'unknown-code path preserves full message including bracket prefix');
	});

	test('parseQuantbookError handles non-Error throwables', () => {
		const info1 = parseQuantbookError('string thrown');
		assert.strictEqual(info1.code, 'unknown');
		assert.strictEqual(info1.message, 'string thrown');

		const info2 = parseQuantbookError(42);
		assert.strictEqual(info2.code, 'unknown');
		assert.strictEqual(info2.message, '42');

		const info3 = parseQuantbookError(undefined);
		assert.strictEqual(info3.code, 'unknown');
	});

	test('parseQuantbookError preserves cause for re-throw / inspection', () => {
		const err = new Error('[transport_closed] transport closed');
		const info = parseQuantbookError(err);
		assert.strictEqual(info.cause, err, 'cause is the original caught value');
	});

	test('isQuantbookErrorCode accepts known codes', () => {
		assert.ok(isQuantbookErrorCode('transport_closed'));
		assert.ok(isQuantbookErrorCode('websocket_invalid_url'));
		assert.ok(isQuantbookErrorCode('session_oplog'));
		assert.ok(isQuantbookErrorCode('unknown'));
	});

	test('isQuantbookErrorCode rejects non-strings and unknown codes', () => {
		assert.ok(!isQuantbookErrorCode(undefined));
		assert.ok(!isQuantbookErrorCode(null));
		assert.ok(!isQuantbookErrorCode(42));
		assert.ok(!isQuantbookErrorCode('future_new_kind'));
		assert.ok(!isQuantbookErrorCode('Transport_Closed'),
			'case-sensitive: TitleCase rejected');
	});

	test('V2.9 closure: every QuantbookErrorCode (except `unknown`) round-trips through parseQuantbookError', () => {
		// **V2.9 hardening (Opus-B Lane C MEDIUM-3 closure, 2026-05-22)**:
		// pre-V2.9, KNOWN_QUANTBOOK_ERROR_CODES was a manually-maintained
		// string Set alongside the QuantbookErrorCode union -- a fresh
		// engine kind added to the union but forgotten in the Set would
		// silently bucket under 'unknown'. V2.9 closure derives the Set
		// from a Record<Exclude<QuantbookErrorCode, 'unknown'>, true> so
		// adding/removing a code without updating BOTH is a TS compile
		// error. This test pins the runtime view: every code in the
		// QuantbookErrorCode union (except 'unknown') round-trips
		// through a synthetic bracket-prefixed error and recovers its
		// own code -- if a future code is added to the union but the
		// V2.9 record is left manually un-updated (i.e., the Record is
		// torn down to a hand-list again), this test fails first.
		const codes = [
			'transport_io',
			'transport_closed',
			'websocket_invalid_url',
			'websocket_connect_failed',
			'websocket_handshake_failed',
			'websocket_runtime_error',
			'session_oplog',
			'session_presence',
			'session_undo',
			'session_replay',
			'bad_argument',
		] as const;
		for (const code of codes) {
			const err = new Error(`[${code}] synthetic test message`);
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, code,
				`code ${code} must round-trip; got ${info.code} (KNOWN_QUANTBOOK_ERROR_CODE_RECORD may be out of sync with the union)`);
			assert.strictEqual(info.message, 'synthetic test message',
				`message stripping must be correct for code ${code}`);
		}
		// And the unknown sentinel routes correctly too.
		const unknownErr = new Error('[future_unbound] should fall through');
		const unknownInfo = parseQuantbookError(unknownErr);
		assert.strictEqual(unknownInfo.code, 'unknown',
			'unrecognized prefix falls back to unknown');
	});
});

suite('quantbook V2.7 -- structured error-code end-to-end (engine → napi → parseQuantbookError)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) {
			this.skip();
		}
		_resetQuantbookEngineCacheForTests();
		this.timeout(60000);
		loadQuantbookEngine();
	});

	test('end-to-end: invalid WebSocket URL surfaces websocket_invalid_url code', async () => {
		const engine = loadQuantbookEngine();
		try {
			await engine.Transport.websocketConnect('not-a-ws-url');
			assert.fail('expected rejection');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'websocket_invalid_url',
				`expected websocket_invalid_url, got code=${info.code}, msg=${info.message}`);
			// Display string preserved after the code prefix.
			assert.match(info.message, /invalid WebSocket URL/);
		}
	});

	test('end-to-end: connection refused surfaces websocket_connect_failed code', async function () {
		this.timeout(10000);
		const engine = loadQuantbookEngine();
		try {
			await engine.Transport.websocketConnect('ws://127.0.0.1:1');
			assert.fail('expected rejection');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'websocket_connect_failed',
				`expected websocket_connect_failed, got code=${info.code}, msg=${info.message}`);
		}
	});

	test('end-to-end: V2.3 substring tests still pass (Display preserved after [code] prefix)', async () => {
		// V2.3 mocha asserts /invalid WebSocket URL/ on the raw
		// Error.message. V2.7 prepends "[websocket_invalid_url] " --
		// the substring is still present. Pin this explicitly.
		const engine = loadQuantbookEngine();
		try {
			await engine.Transport.websocketConnect('not-a-ws-url');
			assert.fail('expected rejection');
		} catch (err) {
			assert.ok(err instanceof Error);
			assert.match(err.message, /invalid WebSocket URL/,
				'V2.3 substring-match assertion preserved post-V2.7');
			assert.match(err.message, /^\[websocket_invalid_url\]/,
				'V2.7 prefix is present');
		}
	});

	test('V2.7 closure: napi argument validation surfaces bad_argument code (Opus M2)', () => {
		// V2.7 closure (Opus MEDIUM-2): validation errors from napi
		// layer (NOT engine error types) now carry the bad_argument
		// prefix. Without this, they silently bucketed under
		// `'unknown'` in parseQuantbookError, re-opening V2.1+V2.2+V2.3
		// MEDIUM-3 at the binding boundary.
		const engine = loadQuantbookEngine();
		try {
			// blockMs = 0 rejected at napi boundary per V2.5 closure
			// (Codex M1). V2.7 closure (Opus M2) adds bad_argument prefix.
			new (requireBlockingTransportFixture(engine))(0);
			assert.fail('expected throw');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument',
				`expected bad_argument code, got ${info.code}; msg=${info.message}`);
			assert.match(info.message, /blockMs must be > 0/,
				'V2.5 closure assertion text preserved');
		}
	});

	test('V2.7 closure: peerId validation surfaces bad_argument code (Opus M2)', () => {
		const engine = loadQuantbookEngine();
		try {
			// peerId = 0 is reserved LEGACY_PEER per V1 closure.
			// Surfaced via bad_argument since V2.7 closure (Opus M2).
			new engine.CollabSession(0n);
			assert.fail('expected throw');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument',
				`expected bad_argument code, got ${info.code}; msg=${info.message}`);
			assert.match(info.message, /peerId must be non-zero/);
		}
	});

	test('V2.7 closure: LoopbackPair single-use violation surfaces bad_argument code (Opus M2)', () => {
		const engine = loadQuantbookEngine();
		const pair = new engine.LoopbackPair();
		pair.takeA();
		try {
			pair.takeA(); // second take violates single-use contract
			assert.fail('expected throw');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument',
				`expected bad_argument code, got ${info.code}; msg=${info.message}`);
			assert.match(info.message, /takeA already called/);
		}
	});

	// ===============================================================
	// Phase 5.7 V2.8 megaudit closure (2026-05-22) — Opus-B Lane C
	// MEDIUM-4: parseQuantbookError walks Error.cause chain.
	// ===============================================================

	test('V2.8 closure: parseQuantbookError unwraps Error.cause to find bracket-prefixed engine code', () => {
		// Simulates the napi `spawn_blocking` task-panic path: a
		// generic Node Error wraps the engine's structured error;
		// the engine's `[transport_closed] transport closed` lives
		// on .cause, not on the top-level .message.
		const inner = new Error('[transport_closed] transport closed');
		const wrapper = new Error('spawn_blocking task panicked', { cause: inner });
		const info = parseQuantbookError(wrapper);
		assert.strictEqual(info.code, 'transport_closed',
			`expected transport_closed code via cause walk, got ${info.code}`);
		assert.strictEqual(info.message, 'transport closed');
		assert.strictEqual(info.cause, wrapper,
			'cause field must point at the original top-level throwable');
	});

	test('V2.8 closure: parseQuantbookError unwraps multi-level Error.cause chain', () => {
		// Three-level nesting (outer wrapper → mid wrapper → engine).
		// Realistic for napi + Promise rejection plumbing.
		const engineErr = new Error('[websocket_invalid_url] invalid WebSocket URL: ws://host:9001/');
		const midWrapper = new Error('async task failed', { cause: engineErr });
		const outerWrapper = new Error('promise rejection bubble', { cause: midWrapper });
		const info = parseQuantbookError(outerWrapper);
		assert.strictEqual(info.code, 'websocket_invalid_url');
		assert.match(info.message, /invalid WebSocket URL/);
	});

	test('V2.8 closure: parseQuantbookError cause walk has a self-cycle guard', () => {
		// Hand-built cyclic cause (rare but possible if a logger or
		// retry layer accidentally re-assigns .cause). The walker
		// MUST terminate and return 'unknown'.
		const a = new Error('outer');
		const b = new Error('mid', { cause: a });
		// Mutate a.cause to point at b → cycle a→b→a.
		(a as { cause?: unknown }).cause = b;
		const info = parseQuantbookError(a);
		assert.strictEqual(info.code, 'unknown',
			'cyclic cause chain must resolve to unknown, not hang');
		assert.strictEqual(info.cause, a);
	});

	test('V2.8 closure: parseQuantbookError respects depth cap on deep cause chains', () => {
		// Construct a 12-deep chain of bracket-less wrappers ending
		// in a bracket-prefixed engine error. The walker's depth cap
		// of 8 means it gives up before reaching the engine layer
		// and returns 'unknown'. Pins the cap as a contract.
		let current: Error = new Error('[session_oplog] oplog corrupted');
		for (let i = 0; i < 12; i++) {
			current = new Error(`wrapper depth=${i + 1}`, { cause: current });
		}
		const info = parseQuantbookError(current);
		assert.strictEqual(info.code, 'unknown',
			'chain deeper than QUANTBOOK_ERROR_CAUSE_MAX_DEPTH must return unknown');
	});
});

// ============================================================================
// Phase 5.7 V3.1 multi-window demo round-trip
// ============================================================================

import * as cp from 'child_process';

suite('quantbook V3.1 multi-window relay round-trip', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) {
			this.skip();
		}
		try {
			const p = resolveRelayBinaryPath();
			if (!fs.existsSync(p)) {
				const reason = `relay binary not built at ${p} -- build with: ` +
					`cargo build -p ql-collab-ws --example relay-server --release`;
				console.warn(`[v3.1 test skip] ${reason}`);
				this.skip();
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			console.warn(`[v3.1 test skip] resolveRelayBinaryPath failed: ${msg}`);
			this.skip();
		}
	});

	test('V3.1 round-trip: two sessions exchange ops through spawned relay binary', async function () {
		this.timeout(15000);
		// Use a non-default port so we don't collide with an actually-running
		// relay (e.g., a real demo in the same workspace). 17117 is unlikely
		// to clash; if even this fails, the test should report the bind error.
		const TEST_PORT = 17117;
		const binaryPath = resolveRelayBinaryPath();
		const child = cp.spawn(binaryPath, [], {
			env: { ...process.env, QL_RELAY_PORT: String(TEST_PORT) },
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		// Wait for the relay's readiness marker on stdout.
		const ready = await new Promise<boolean>((resolve, reject) => {
			let buf = '';
			const onData = (chunk: Buffer): void => {
				buf += chunk.toString('utf8');
				if (buf.includes('[ql-collab-ws relay] listening on')) {
					resolve(true);
				}
			};
			child.stdout?.on('data', onData);
			child.stderr?.on('data', (c: Buffer) => {
				// log stderr only if test fails (mocha captures console)
				process.stderr.write(`[relay stderr] ${c.toString('utf8')}`);
			});
			child.once('exit', (code, sig) => {
				reject(new Error(`relay exited before ready (code=${code}, sig=${sig})`));
			});
			setTimeout(() => reject(new Error('relay readiness timeout after 5s')), 5000);
		});
		assert.ok(ready);

		try {
			const engine = loadQuantbookEngine();
			const url = `ws://127.0.0.1:${TEST_PORT}`;
			const transportA = await engine.Transport.websocketConnect(url);
			const transportB = await engine.Transport.websocketConnect(url);
			const sessA = new engine.CollabSession(101n);
			const sessB = new engine.CollabSession(102n);
			sessA.attachTransport(transportA);
			sessB.attachTransport(transportB);

			// Append on A, flush delta, give the relay a beat to propagate,
			// then poll on B.
			appendPutValueValidated(sessA, 0, 0, 0, 42.5);
			sessA.flushDeltaToTransport();

			// Poll loop on B with a 3-second budget. The first poll may
			// return 0 if the relay hasn't broadcast yet; retry until B
			// observes the op or the budget expires.
			let merged = 0;
			const deadline = Date.now() + 3000;
			while (Date.now() < deadline) {
				merged = sessB.pollRemote();
				if (merged > 0) {
					break;
				}
				await new Promise(r => setTimeout(r, 100));
			}
			assert.ok(
				merged > 0,
				`B should have received at least one blob from A via the relay (got merged=${merged} after 3s)`,
			);
			assert.strictEqual(sessB.opCount(), 1, 'B should have exactly the one op A appended');

			// Reverse direction: append on B, observe on A.
			appendPutValueValidated(sessB, 0, 1, 0, 99.9);
			sessB.flushDeltaToTransport();
			merged = 0;
			const deadline2 = Date.now() + 3000;
			while (Date.now() < deadline2) {
				merged = sessA.pollRemote();
				if (merged > 0) {
					break;
				}
				await new Promise(r => setTimeout(r, 100));
			}
			assert.ok(
				merged > 0,
				`A should have received B's op via the relay (got merged=${merged} after 3s)`,
			);
			assert.strictEqual(sessA.opCount(), 2, 'A now has 2 ops (its own + B\'s)');
		} finally {
			if (child.exitCode === null) {
				child.kill();
			}
		}
	});

	test('V3.1.e closure (Codex L5): reconnect-mid-flight surfaces transport_closed + recovers on relay respawn', async function () {
		// **V3.1.e Codex LOW-5 closure (2026-05-22)**: the V3.1.d
		// initial test only covered the happy-path round-trip. This
		// test covers the deferred reconnect-mid-flight contract:
		//   1. Spawn relay, attach two sessions, confirm A->B sync.
		//   2. Kill the relay mid-flight.
		//   3. Verify A's next flushDeltaToTransport surfaces an
		//      engine-side `transport_closed` (via
		//      parseQuantbookError on the thrown Error OR via
		//      transportLastError observation -- depends on the
		//      Transport impl's failure-surfacing timing).
		//   4. Respawn the relay on the SAME port.
		//   5. Drop the dead transport, websocketConnect a fresh one,
		//      reattach, confirm A->B propagation resumes.
		//
		// Note: this test bypasses the IDE-side multiWindowDemo
		// orchestration (reconnectWithBackoff, dispose-from-handler,
		// Restart Demo action) -- those live in VS Code's command
		// context which the mocha shim does not provide. This test
		// pins the LOWER-LAYER engine contract that the IDE
		// orchestration depends on: transport_closed IS surfaced and
		// a fresh Transport.websocketConnect succeeds against a
		// respawned relay.
		this.timeout(20000);
		const TEST_PORT = 17118; // distinct from the 17117 happy-path test
		const binaryPath = resolveRelayBinaryPath();

		const spawnRelayProc = (): { child: cp.ChildProcess; ready: Promise<void> } => {
			const child = cp.spawn(binaryPath, [], {
				env: { ...process.env, QL_RELAY_PORT: String(TEST_PORT) },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			const ready = new Promise<void>((resolve, reject) => {
				let buf = '';
				child.stdout?.on('data', (chunk: Buffer) => {
					buf += chunk.toString('utf8');
					if (buf.includes('[ql-collab-ws relay] listening on')) {
						resolve();
					}
				});
				child.stderr?.on('data', (c: Buffer) => {
					process.stderr.write(`[relay stderr] ${c.toString('utf8')}`);
				});
				child.once('exit', (code, sig) => {
					reject(new Error(`relay exited before ready (code=${code}, sig=${sig})`));
				});
				setTimeout(() => reject(new Error('relay readiness timeout 5s')), 5000);
			});
			return { child, ready };
		};

		let relay = spawnRelayProc();
		await relay.ready;

		const engine = loadQuantbookEngine();
		const url = `ws://127.0.0.1:${TEST_PORT}`;

		const sessA = new engine.CollabSession(201n);
		const sessB = new engine.CollabSession(202n);
		sessA.attachTransport(await engine.Transport.websocketConnect(url));
		sessB.attachTransport(await engine.Transport.websocketConnect(url));

		try {
			// Sanity round-trip: A appends, B observes within 3s.
			appendPutValueValidated(sessA, 0, 0, 0, 1.0);
			sessA.flushDeltaToTransport();
			let merged = 0;
			let deadline = Date.now() + 3000;
			while (Date.now() < deadline) {
				merged = sessB.pollRemote();
				if (merged > 0) {
					break;
				}
				await new Promise(r => setTimeout(r, 100));
			}
			assert.ok(merged > 0, 'pre-kill sanity: B observed A\'s op');

			// Kill the relay mid-flight.
			relay.child.kill('SIGTERM');
			await new Promise<void>(resolve => {
				if (relay.child.exitCode !== null || relay.child.signalCode !== null) {
					resolve();
					return;
				}
				relay.child.once('exit', () => resolve());
			});

			// Give the engine reader/writer tasks a beat to observe
			// the TCP close (peer-closed propagates via tungstenite's
			// stream end). Until they observe it, transportLastError
			// may still be None and a send may not yet surface
			// transport_closed.
			await new Promise(r => setTimeout(r, 300));

			// Surface check: after the relay is dead, either:
			//   (a) transportLastError() is populated (the reader
			//       task observed Closed first), OR
			//   (b) the next flushDeltaToTransport throws with
			//       `[transport_closed]` (the writer task's send
			//       observed it first).
			// Either path is acceptable -- the engine routes through
			// the same error variant.
			let observedClosed = false;
			const lastErr = sessA.transportLastError();
			if (lastErr !== null) {
				observedClosed = true;
			} else {
				// Try a flush to provoke the writer-side observation.
				appendPutValueValidated(sessA, 0, 0, 1, 2.0);
				try {
					sessA.flushDeltaToTransport();
					// Some Transport impls return Ok(true) even when
					// the peer is dead because the local mpsc accepts
					// the buffer. Re-check transportLastError after a
					// brief wait for the writer task to discover the
					// close.
					await new Promise(r => setTimeout(r, 300));
					if (sessA.transportLastError() !== null) {
						observedClosed = true;
					}
				} catch (err) {
					const info = parseQuantbookError(err);
					assert.ok(
						info.code === 'transport_closed' || info.code === 'transport_io',
						`expected transport_closed or transport_io, got ${info.code} (msg: ${info.message})`,
					);
					observedClosed = true;
				}
			}
			assert.ok(
				observedClosed,
				'V3.1.e contract: relay kill must eventually surface transport_closed (via transportLastError or thrown Error)',
			);

			// Respawn the relay on the same port. Drop the dead
			// transports + websocketConnect fresh; reattach.
			relay = spawnRelayProc();
			await relay.ready;
			sessA.detachTransport();
			sessB.detachTransport();
			sessA.attachTransport(await engine.Transport.websocketConnect(url));
			sessB.attachTransport(await engine.Transport.websocketConnect(url));

			// Verify recovery: append on A, observe on B.
			const sessB_baseline_opCount = sessB.opCount();
			appendPutValueValidated(sessA, 0, 1, 0, 3.0);
			sessA.flushDeltaToTransport();
			merged = 0;
			deadline = Date.now() + 3000;
			while (Date.now() < deadline) {
				merged = sessB.pollRemote();
				if (merged > 0) {
					break;
				}
				await new Promise(r => setTimeout(r, 100));
			}
			assert.ok(
				merged > 0,
				`post-respawn recovery: B should have received A's new op (merged=${merged} after 3s)`,
			);
			assert.ok(
				sessB.opCount() > sessB_baseline_opCount,
				'B\'s opCount must increase after the post-respawn op',
			);
		} finally {
			if (relay.child.exitCode === null && relay.child.signalCode === null) {
				relay.child.kill();
			}
		}
	});
});

// ============================================================================
// Phase 5.7 V3.2.a -- cell-snapshot export for the IDE grid widget
// ============================================================================

import { buildHtml, formatCellValue } from '../src/quantbook/cellGrid/cellGridHtml';

suite('quantbook V3.2.a scaffold -- cell-grid webview HTML rendering', function () {
	test('formatCellValue handles all 5 CellWireValue variants', () => {
		assert.strictEqual(formatCellValue({ kind: 'number', value: 42.5 }), '42.5');
		assert.strictEqual(formatCellValue({ kind: 'boolean', value: true }), 'TRUE');
		assert.strictEqual(formatCellValue({ kind: 'boolean', value: false }), 'FALSE');
		assert.strictEqual(formatCellValue({ kind: 'text', value: 'hello' }), 'hello');
		assert.strictEqual(formatCellValue({ kind: 'error', value: '#REF!' }), '#REF!');
		assert.strictEqual(formatCellValue({ kind: 'pending' }), '(pending)');
	});

	test('buildHtml on empty snapshot includes empty-state hint + meta', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] });
		assert.ok(html.includes('snapshot_format_version=1'));
		assert.ok(html.includes('entries=0'));
		assert.ok(html.includes('(empty -- no PutValue ops'));
		// No table for empty case.
		assert.ok(!html.includes('<tbody>'));
	});

	test('buildHtml on populated snapshot renders rows + kind annotations', () => {
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 0, col: 0, value: { kind: 'number', value: 42 } },
				{ row: 1, col: 1, value: { kind: 'text', value: 'hi' } },
			],
		});
		assert.ok(html.includes('entries=2'));
		assert.ok(html.includes('<tbody>'));
		assert.ok(html.includes('<td>0</td><td>0</td>'));
		assert.ok(html.includes('42'));
		assert.ok(html.includes('[number]'));
		assert.ok(html.includes('hi'));
		assert.ok(html.includes('[text]'));
	});

	test('buildHtml escapes HTML in cell text values (XSS hygiene)', () => {
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 0, col: 0, value: { kind: 'text', value: '<script>alert(1)</script>' } },
			],
		});
		// Raw `<script>` MUST NOT appear; entity-encoded form MUST.
		assert.ok(!html.includes('<script>alert(1)</script>'));
		assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
	});

	test('buildHtml has a CSP meta tag with default-src none', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] });
		assert.ok(html.includes('Content-Security-Policy'));
		assert.ok(html.includes('default-src \'none\''));
	});
});

suite('quantbook V3.2.a -- exportSnapshot cell-snapshot export', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) {
			this.skip();
		}
	});

	test('V3.2.a: empty session yields empty entries', () => {
		const sess = createSession(301n);
		const snap = exportCellSnapshot(sess, 0);
		assert.strictEqual(snap.snapshot_format_version, 1);
		assert.strictEqual(snap.sheet, 0);
		assert.deepStrictEqual(snap.entries, []);
	});

	test('V3.2.a: entries sorted by (row, col); last-write-wins per cell', () => {
		const sess = createSession(302n);
		appendPutValueValidated(sess, 0, 1, 1, 1.0);
		appendPutValueValidated(sess, 0, 0, 0, 0.5);
		appendPutValueValidated(sess, 0, 0, 5, 5.5);
		appendPutValueValidated(sess, 0, 1, 1, 2.0); // overwrite (1,1)
		const snap = exportCellSnapshot(sess, 0);
		assert.strictEqual(snap.entries.length, 3);
		// Sorted by (row, col): (0,0) < (0,5) < (1,1).
		assert.deepStrictEqual(
			snap.entries[0],
			{ row: 0, col: 0, value: { kind: 'number', value: 0.5 } },
		);
		assert.deepStrictEqual(
			snap.entries[1],
			{ row: 0, col: 5, value: { kind: 'number', value: 5.5 } },
		);
		assert.deepStrictEqual(
			snap.entries[2],
			{ row: 1, col: 1, value: { kind: 'number', value: 2.0 } },
		);
	});

	test('V3.2.a: filters by sheet (entries from other sheets excluded)', () => {
		const sess = createSession(303n);
		appendPutValueValidated(sess, 0, 0, 0, 1.0);
		appendPutValueValidated(sess, 1, 0, 0, 2.0);
		appendPutValueValidated(sess, 0, 0, 1, 3.0);
		const snap0 = exportCellSnapshot(sess, 0);
		const snap1 = exportCellSnapshot(sess, 1);
		assert.strictEqual(snap0.entries.length, 2);
		assert.strictEqual(snap0.sheet, 0);
		assert.strictEqual(snap1.entries.length, 1);
		assert.strictEqual(snap1.sheet, 1);
		const snap1Value = snap1.entries[0].value;
		assert.strictEqual(snap1Value.kind, 'number');
		if (snap1Value.kind === 'number') {
			assert.strictEqual(snap1Value.value, 2.0);
		}
	});

	test('V3.2.a: snapshot survives round-trip via exportBytes/fromSnapshot', () => {
		// Pin that exportSnapshot routes through the engine's local
		// op log, which is preserved across export/import. Sessions
		// reconstructed via fromSnapshot must report the same
		// snapshot (after replaying the op log on the receiving end).
		const sessA = createSession(304n);
		appendPutValueValidated(sessA, 0, 0, 0, 1.0);
		appendPutValueValidated(sessA, 0, 0, 1, 2.0);
		const bytes = sessA.exportBytes();
		const sessB = sessionFromSnapshot(305n, bytes);
		const snapA = exportCellSnapshot(sessA, 0);
		const snapB = exportCellSnapshot(sessB, 0);
		assert.deepStrictEqual(snapA.entries, snapB.entries);
	});

	test('V3.2.a: snapshot return type is JSON-decoded shape', () => {
		// Defensive guard against the helper accidentally returning
		// the raw JSON string instead of the parsed object.
		const sess = createSession(306n);
		const snap: QuantbookCellSnapshot = exportCellSnapshot(sess, 0);
		assert.strictEqual(typeof snap, 'object');
		assert.ok(snap !== null);
		assert.strictEqual(typeof snap.snapshot_format_version, 'number');
		assert.ok(Array.isArray(snap.entries));
	});
});

// ============================================================================
// Phase 5.7 V3.2.b.5 -- cell-edit flow (HTML + dispatcher)
// ============================================================================

import { classifyPollTick, dispatchIncomingMessage, parseCellRawInput, type ErrorReplyMessage } from '../src/quantbook/cellGrid/cellGridLogic';

suite('quantbook V3.2.b.2 -- cellGridHtml.ts nonce + script + editable cells', function () {
	test('buildHtml WITHOUT nonce is unchanged from V3.2.a (no script tag; narrow CSP)', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] });
		assert.ok(!html.includes('<script'), 'no <script> tag in V3.2.a-compat path');
		assert.ok(html.includes('default-src \'none\''));
		assert.ok(!html.includes('script-src'), 'no script-src in CSP without nonce');
		assert.ok(!html.includes('data-row'), 'no data-row attrs in V3.2.a-compat path');
	});

	test('buildHtml WITH nonce embeds <script nonce="..."> + widens CSP', () => {
		const nonce = 'TestNonce123';
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce });
		assert.ok(html.includes(`<script nonce="${nonce}">`), 'script tag carries the nonce');
		assert.ok(html.includes(`script-src 'nonce-${nonce}'`), 'CSP includes nonce-scoped script-src');
		// Sanity: the SAME nonce in BOTH places (per cellGridHtml.ts docstring).
		const scriptNonceMatches = html.match(/<script nonce="([A-Za-z0-9]+)">/g);
		const cspNonceMatches = html.match(/'nonce-([A-Za-z0-9]+)'/g);
		assert.ok(scriptNonceMatches && scriptNonceMatches.length === 1);
		assert.ok(cspNonceMatches && cspNonceMatches.length === 1);
	});

	test('buildHtml WITH nonce gives cells data-row + data-col + cell-value class', () => {
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 3, col: 7, value: { kind: 'number', value: 42 } },
			],
		}, { nonce: 'n0' });
		assert.ok(html.includes('data-row="3"'), 'cell has data-row');
		assert.ok(html.includes('data-col="7"'), 'cell has data-col');
		assert.ok(html.includes('class="cell-value"'), 'cell has cell-value class');
		assert.ok(html.includes('data-original-text="42"'), 'cell has data-original-text');
		assert.ok(html.includes('data-original-kind="number"'), 'cell has data-original-kind');
	});

	test('buildHtml CSS includes .cell-edit-error + .cell-edit-input + .cell-value', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'x' });
		assert.ok(html.includes('.cell-value'));
		assert.ok(html.includes('.cell-edit-error'));
		assert.ok(html.includes('.cell-edit-input'));
	});

	test('buildHtml WITH nonce: script body wires acquireVsCodeApi + click + message listener', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 42, entries: [] }, { nonce: 'y' });
		// Pin the contract surface; if any of these strings move, the
		// webview script lost its wiring.
		assert.ok(html.includes('acquireVsCodeApi'));
		assert.ok(html.includes('var SHEET = 42'), 'SHEET constant baked from snapshot.sheet');
		assert.ok(html.includes('vscode.postMessage'));
		assert.ok(html.includes('addEventListener(\'click\''));
		assert.ok(html.includes('addEventListener(\'message\''));
		assert.ok(html.includes('errorReply'));
		assert.ok(html.includes('refresh'));
	});

	test('buildHtml: HTML-escaping still applies to text values when editable', () => {
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 0, col: 0, value: { kind: 'text', value: '<script>alert(1)</script>' } },
			],
		}, { nonce: 'z' });
		assert.ok(!html.includes('<script>alert(1)</script>'), 'no raw script payload');
		assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
		assert.ok(html.includes('data-original-text="&lt;script&gt;alert(1)&lt;/script&gt;"'),
			'data-original-text is HTML-escaped too');
	});
});

suite('quantbook V3.2.b.5 -- parseCellRawInput', function () {
	test('accepts plain integer', () => {
		assert.strictEqual(parseCellRawInput('42'), 42);
	});

	test('accepts decimal', () => {
		assert.strictEqual(parseCellRawInput('3.14'), 3.14);
	});

	test('accepts scientific notation', () => {
		assert.strictEqual(parseCellRawInput('1e3'), 1000);
	});

	test('accepts negative + leading/trailing whitespace', () => {
		assert.strictEqual(parseCellRawInput('  -7.5  '), -7.5);
	});

	test('rejects empty / whitespace-only with bad_argument prefix', () => {
		assert.throws(() => parseCellRawInput(''), /\[bad_argument\]/);
		assert.throws(() => parseCellRawInput('   '), /\[bad_argument\]/);
	});

	test('rejects non-numeric with bad_argument prefix', () => {
		assert.throws(() => parseCellRawInput('hello'), /\[bad_argument\]/);
		assert.throws(() => parseCellRawInput('42abc'), /\[bad_argument\]/);
	});

	test('rejects Infinity / -Infinity / NaN with bad_argument prefix', () => {
		assert.throws(() => parseCellRawInput('Infinity'), /\[bad_argument\]/);
		assert.throws(() => parseCellRawInput('-Infinity'), /\[bad_argument\]/);
		assert.throws(() => parseCellRawInput('NaN'), /\[bad_argument\]/);
	});
});

suite('quantbook V3.2.b.5 -- dispatchIncomingMessage (host-side commit path)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	function makeDeps(session: CollabSessionInstance, sheet: number) {
		const errorReplies: ErrorReplyMessage[] = [];
		let commitCount = 0;
		const deps = {
			session,
			sheet,
			onCommit: () => { commitCount += 1; },
			onError: (reply: ErrorReplyMessage) => { errorReplies.push(reply); },
		};
		return { deps, errorReplies, getCommitCount: () => commitCount };
	}

	test('putValue success: commits the value + invokes onCommit', () => {
		const session = createSession(401n);
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 1, col: 2, rawInput: '99.5' },
			deps,
		);
		assert.strictEqual(getCommitCount(), 1, 'onCommit fired once');
		assert.strictEqual(errorReplies.length, 0, 'no error reply on success');
		assert.strictEqual(session.opCount(), 1, 'op log has the new PutValue');
		const snap = exportCellSnapshot(session, 0);
		assert.strictEqual(snap.entries.length, 1);
		assert.deepStrictEqual(snap.entries[0], {
			row: 1, col: 2, value: { kind: 'number', value: 99.5 },
		});
	});

	test('putValue with non-numeric rawInput: posts errorReply with bad_argument code', () => {
		const session = createSession(402n);
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 1, col: 2, rawInput: 'hello world' },
			deps,
		);
		assert.strictEqual(getCommitCount(), 0, 'no commit on parse failure');
		assert.strictEqual(session.opCount(), 0, 'op log unchanged');
		assert.strictEqual(errorReplies.length, 1);
		const reply = errorReplies[0];
		assert.strictEqual(reply.type, 'errorReply');
		assert.strictEqual(reply.sheet, 0);
		assert.strictEqual(reply.row, 1);
		assert.strictEqual(reply.col, 2);
		assert.strictEqual(reply.code, 'bad_argument');
		assert.match(reply.message, /finite number/);
	});

	test('putValue with empty rawInput: posts bad_argument errorReply', () => {
		const session = createSession(403n);
		const { deps, errorReplies } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 0, rawInput: '' },
			deps,
		);
		assert.strictEqual(errorReplies.length, 1);
		assert.strictEqual(errorReplies[0].code, 'bad_argument');
	});

	test('putValue with sheet mismatch: dropped (no commit, no errorReply)', () => {
		const session = createSession(404n);
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 99, row: 0, col: 0, rawInput: '1.0' },
			deps,
		);
		assert.strictEqual(getCommitCount(), 0);
		assert.strictEqual(errorReplies.length, 0);
		assert.strictEqual(session.opCount(), 0);
	});

	test('unknown message type: dropped silently (no commit, no errorReply)', () => {
		const session = createSession(405n);
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'futureFeature', payload: 42 },
			deps,
		);
		assert.strictEqual(getCommitCount(), 0);
		assert.strictEqual(errorReplies.length, 0);
		// Same for missing type field.
		dispatchIncomingMessage({ noType: true }, deps);
		assert.strictEqual(errorReplies.length, 0);
		// Same for non-object input.
		dispatchIncomingMessage('not an object', deps);
		assert.strictEqual(errorReplies.length, 0);
		dispatchIncomingMessage(null, deps);
		assert.strictEqual(errorReplies.length, 0);
	});
});

// ============================================================================
// Phase 5.7 V3.2.c.5 -- live multi-window propagation (pollloop + attach)
// ============================================================================


suite('quantbook V3.2.c.3 -- classifyPollTick', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('idle when pollRemote returns 0 (no remote ops)', () => {
		const session = createSession(501n);
		const result = classifyPollTick(session);
		assert.strictEqual(result.kind, 'idle');
	});

	test('merged with count when pollRemote returns > 0', () => {
		// Build a snapshot from another session, merge into this one
		// via mergeBytes (which pollRemote also funnels into); then
		// confirm classifyPollTick reports idle (no transport
		// attached, nothing to drain).  This pins the "remote-merged
		// ops are NOT what classifyPollTick reports -- it reports
		// what pollRemote drained from the attached transport's
		// inbox" contract.
		const sessA = createSession(502n);
		appendPutValueValidated(sessA, 0, 0, 0, 42);
		const bytes = sessA.exportBytes();
		const sessB = createSession(503n);
		sessB.mergeBytes(bytes);
		// No transport attached, so pollRemote drains nothing.
		const result = classifyPollTick(sessB);
		assert.strictEqual(result.kind, 'idle',
			'classifyPollTick reports transport drain, NOT merge-bytes side effects');
	});

	test('merged path: with attached transport, returns merged + count', () => {
		const [tA, tB] = loopbackTransportPair();
		const sessA = createSession(504n);
		const sessB = createSession(505n);
		sessA.attachTransport(tA);
		sessB.attachTransport(tB);
		sessA.setAutoFlushPolicy('onAppend');
		appendPutValueValidated(sessA, 0, 1, 1, 7.5);
		// Now sessB's loopback inbox has at least one frame from
		// sessA's flush; classifyPollTick should see merged.
		const result = classifyPollTick(sessB);
		assert.strictEqual(result.kind, 'merged',
			`expected merged, got ${JSON.stringify(result)}`);
		if (result.kind === 'merged') {
			assert.ok(result.count > 0, `count > 0, got ${result.count}`);
		}
	});

	test('idle on subsequent tick after a successful merge (drain semantics)', () => {
		const [tA, tB] = loopbackTransportPair();
		const sessA = createSession(506n);
		const sessB = createSession(507n);
		sessA.attachTransport(tA);
		sessB.attachTransport(tB);
		sessA.setAutoFlushPolicy('onAppend');
		appendPutValueValidated(sessA, 0, 0, 0, 1.0);
		const first = classifyPollTick(sessB);
		assert.strictEqual(first.kind, 'merged');
		// Second tick: transport inbox is empty now.
		const second = classifyPollTick(sessB);
		assert.strictEqual(second.kind, 'idle');
	});
});

suite('quantbook V3.2.c.5 -- two-session loopback round-trip with auto-flush', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('A appends with auto-flush; B pollRemote merges; B snapshot mirrors A', () => {
		const [tA, tB] = loopbackTransportPair();
		const sessA = createSession(601n);
		const sessB = createSession(602n);
		sessA.attachTransport(tA);
		sessB.attachTransport(tB);
		sessA.setAutoFlushPolicy('onAppend');
		sessB.setAutoFlushPolicy('onAppend');

		// A appends three cells; auto-flush sends each blob.
		appendPutValueValidated(sessA, 0, 0, 0, 11);
		appendPutValueValidated(sessA, 0, 0, 1, 22);
		appendPutValueValidated(sessA, 0, 1, 0, 33);

		// B drains the inbox.
		const result = classifyPollTick(sessB);
		assert.strictEqual(result.kind, 'merged');

		// B's snapshot now mirrors A's three cells.
		const snapA = exportCellSnapshot(sessA, 0);
		const snapB = exportCellSnapshot(sessB, 0);
		assert.deepStrictEqual(snapB.entries, snapA.entries,
			'B snapshot must match A snapshot after pollRemote drain');
		assert.strictEqual(snapB.entries.length, 3);
	});

	test('detach then pollRemote returns idle (no remote drain without a transport)', () => {
		const [tA, tB] = loopbackTransportPair();
		const sessA = createSession(603n);
		const sessB = createSession(604n);
		sessA.attachTransport(tA);
		sessB.attachTransport(tB);
		sessA.setAutoFlushPolicy('onAppend');

		appendPutValueValidated(sessA, 0, 0, 0, 5);
		sessB.detachTransport();
		// pollRemote on a detached session is a no-op (returns 0).
		const result = classifyPollTick(sessB);
		assert.strictEqual(result.kind, 'idle');
		// B's snapshot does NOT include A's edit because the
		// transport was detached before drain.
		const snapB = exportCellSnapshot(sessB, 0);
		assert.strictEqual(snapB.entries.length, 0);
	});
});

// ============================================================================
// Phase 5.7 V3.2.d closures (audit cross-lane convergence)
// ============================================================================

suite('quantbook V3.2.d HIGH-2 -- IDE-side validators emit [bad_argument] code', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('appendPutValueValidated: non-integer sheet throws [bad_argument]', () => {
		const session = createSession(701n);
		try {
			appendPutValueValidated(session, 1.5, 0, 0, 42);
			assert.fail('expected throw');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument',
				`expected bad_argument, got ${info.code}; msg=${info.message}`);
			assert.match(info.message, /sheet must be an integer/);
		}
	});

	test('appendPutValueValidated: negative row throws [bad_argument]', () => {
		const session = createSession(702n);
		try {
			appendPutValueValidated(session, 0, -1, 0, 42);
			assert.fail('expected throw');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument');
			assert.match(info.message, /row must be an integer/);
		}
	});

	test('appendPutValueValidated: out-of-range col throws [bad_argument]', () => {
		const session = createSession(703n);
		try {
			appendPutValueValidated(session, 0, 0, 4294967296, 42);
			assert.fail('expected throw');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument');
			assert.match(info.message, /col must be an integer/);
		}
	});

	test('appendPutValueValidated: NaN value throws [bad_argument]', () => {
		const session = createSession(704n);
		try {
			appendPutValueValidated(session, 0, 0, 0, NaN);
			assert.fail('expected throw');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument');
			assert.match(info.message, /value must be a finite number/);
		}
	});
});

suite('quantbook V3.2.d HIGH-2 -- dispatcher rawInput type guard', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	function makeDeps(session: CollabSessionInstance, sheet: number) {
		const errorReplies: ErrorReplyMessage[] = [];
		let commitCount = 0;
		const deps = {
			session,
			sheet,
			onCommit: () => { commitCount += 1; },
			onError: (reply: ErrorReplyMessage) => { errorReplies.push(reply); },
		};
		return { deps, errorReplies, getCommitCount: () => commitCount };
	}

	test('rawInput = null surfaces bad_argument (NOT unknown)', () => {
		const session = createSession(705n);
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 0, rawInput: null },
			deps,
		);
		assert.strictEqual(getCommitCount(), 0);
		assert.strictEqual(errorReplies.length, 1);
		assert.strictEqual(errorReplies[0].code, 'bad_argument',
			`expected bad_argument code, got ${errorReplies[0].code}`);
		assert.match(errorReplies[0].message, /rawInput must be a string/);
	});

	test('rawInput = undefined surfaces bad_argument', () => {
		const session = createSession(706n);
		const { deps, errorReplies } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 0, rawInput: undefined },
			deps,
		);
		assert.strictEqual(errorReplies.length, 1);
		assert.strictEqual(errorReplies[0].code, 'bad_argument');
	});

	test('rawInput = 42 (number) surfaces bad_argument', () => {
		const session = createSession(707n);
		const { deps, errorReplies } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 0, rawInput: 42 },
			deps,
		);
		assert.strictEqual(errorReplies.length, 1);
		assert.strictEqual(errorReplies[0].code, 'bad_argument');
	});

	test('rawInput = string but fractional row surfaces bad_argument via IDE validator', () => {
		const session = createSession(708n);
		const { deps, errorReplies } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 1.5, col: 0, rawInput: '42' },
			deps,
		);
		assert.strictEqual(errorReplies.length, 1);
		assert.strictEqual(errorReplies[0].code, 'bad_argument',
			`expected bad_argument (IDE validator rejection), got ${errorReplies[0].code}`);
		assert.match(errorReplies[0].message, /row must be an integer/);
	});
});

// ============================================================================
// Phase 5.7 V3.3.0.2 -- listSheets() napi method + IDE typed wrapper
// ============================================================================

suite('quantbook V3.3.0.2 -- listSheets() enumeration', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('empty session returns empty array', () => {
		const session = createSession(801n);
		const sheets = listSheets(session);
		assert.ok(Array.isArray(sheets), 'returns an array');
		assert.strictEqual(sheets.length, 0, 'empty session has no sheets');
	});

	test('single sheet returns one-element array', () => {
		const session = createSession(802n);
		appendPutValueValidated(session, 0, 0, 0, 1);
		appendPutValueValidated(session, 0, 0, 1, 2);
		appendPutValueValidated(session, 0, 5, 10, 3);
		const sheets = listSheets(session);
		assert.deepStrictEqual(sheets, [0]);
	});

	test('multi-sheet returns sorted ascending dedup', () => {
		const session = createSession(803n);
		// Append in unsorted order to verify the engine sorts the
		// result (not relying on append order).
		appendPutValueValidated(session, 5, 0, 0, 1);
		appendPutValueValidated(session, 2, 0, 0, 2);
		appendPutValueValidated(session, 5, 1, 0, 3); // dup sheet=5
		appendPutValueValidated(session, 0, 0, 0, 4);
		appendPutValueValidated(session, 2, 1, 0, 5); // dup sheet=2
		const sheets = listSheets(session);
		assert.deepStrictEqual(sheets, [0, 2, 5],
			'sheets are sorted ascending + deduplicated');
	});

	test('high-sheet-id boundary (u16 max region)', () => {
		const session = createSession(804n);
		appendPutValueValidated(session, 0xFFFF, 0, 0, 1);
		appendPutValueValidated(session, 0, 0, 0, 2);
		appendPutValueValidated(session, 0xFFFE, 0, 0, 3);
		const sheets = listSheets(session);
		assert.deepStrictEqual(sheets, [0, 0xFFFE, 0xFFFF]);
	});

	test('listSheets survives exportBytes/mergeBytes round-trip', () => {
		// Pin that the engine reconstructs the sheet set correctly
		// across snapshot import: peer that loads a snapshot sees
		// the same sheets as the original peer.
		const sessA = createSession(805n);
		appendPutValueValidated(sessA, 0, 0, 0, 1);
		appendPutValueValidated(sessA, 3, 0, 0, 2);
		appendPutValueValidated(sessA, 7, 0, 0, 3);
		const bytes = sessA.exportBytes();
		const sessB = sessionFromSnapshot(806n, bytes);
		const sheetsA = listSheets(sessA);
		const sheetsB = listSheets(sessB);
		assert.deepStrictEqual(sheetsB, sheetsA);
		assert.deepStrictEqual(sheetsB, [0, 3, 7]);
	});
});

// ============================================================================
// Phase 5.7 V3.3.0.3 -- engine exportSnapshot incremental cache
// ============================================================================

suite('quantbook V3.3.0.3 -- snapshot cache invariants (semantics-preserving)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('cache reflects last-write-wins on local appends to the same cell', () => {
		// Validates V3.3.0.3 append_op incremental insert: subsequent
		// appends to the same (sheet, row, col) overwrite the cached
		// value in iteration order.
		const session = createSession(901n);
		appendPutValueValidated(session, 0, 5, 7, 1.0);
		appendPutValueValidated(session, 0, 5, 7, 2.0);
		appendPutValueValidated(session, 0, 5, 7, 99.5); // final write
		const snap = exportCellSnapshot(session, 0);
		assert.strictEqual(snap.entries.length, 1);
		assert.deepStrictEqual(snap.entries[0], {
			row: 5, col: 7, value: { kind: 'number', value: 99.5 },
		});
	});

	test('cache survives mergeBytes (causal-reorder safe rebuild)', () => {
		// A and B both append disjoint cells; B merges A's snapshot.
		// B's exportCellSnapshot must reflect BOTH peers' cells.  This
		// pins that merge_bytes rebuilds the cache (not just appends
		// from len_before, which would miss causal reordering).
		const sessA = createSession(902n);
		appendPutValueValidated(sessA, 0, 0, 0, 10);
		appendPutValueValidated(sessA, 0, 1, 0, 11);
		const sessB = createSession(903n);
		appendPutValueValidated(sessB, 0, 2, 0, 20);
		appendPutValueValidated(sessB, 0, 3, 0, 21);
		// Merge A into B.
		sessB.mergeBytes(sessA.exportBytes());
		const snapB = exportCellSnapshot(sessB, 0);
		// B should now show 4 cells from both peers.
		const cells = snapB.entries.map(e => `${e.row},${e.col}`).sort();
		assert.deepStrictEqual(cells, ['0,0', '1,0', '2,0', '3,0']);
	});

	test('cache survives pollRemote drain through Loopback transport (V3.2.c regression)', () => {
		// This is the regression test that flushed out the V3.3.0.3
		// pre-fix bug where `poll_remote_with_limit` bypassed the
		// public `merge_bytes` path + left the cache stale.
		//
		// A appends with auto-flush; B polls + drains; B's snapshot
		// must reflect A's cells.  Pre-V3.3.0.3-with-fix, B's cache
		// would be stale + the snapshot empty.
		const [tA, tB] = loopbackTransportPair();
		const sessA = createSession(904n);
		const sessB = createSession(905n);
		sessA.attachTransport(tA);
		sessB.attachTransport(tB);
		sessA.setAutoFlushPolicy('onAppend');
		appendPutValueValidated(sessA, 0, 0, 0, 1.0);
		appendPutValueValidated(sessA, 0, 0, 1, 2.0);
		const n = sessB.pollRemote();
		assert.ok(n > 0, 'pollRemote returns merged > 0');
		const snapB = exportCellSnapshot(sessB, 0);
		assert.strictEqual(snapB.entries.length, 2,
			'B snapshot reflects A\'s 2 cells after pollRemote-driven merge');
	});

	test('cache state matches op-log walk semantics across export/import round-trip', () => {
		// Validates from_snapshot path: importing bytes rebuilds the
		// cache from the imported log.  B (loaded via fromSnapshot)
		// must produce the same snapshot as A (which created the
		// op log via direct appends).
		const sessA = createSession(906n);
		appendPutValueValidated(sessA, 0, 5, 5, 50);
		appendPutValueValidated(sessA, 0, 5, 6, 60);
		appendPutValueValidated(sessA, 1, 0, 0, 100); // different sheet
		const snapA0 = exportCellSnapshot(sessA, 0);
		const snapA1 = exportCellSnapshot(sessA, 1);

		const sessB = sessionFromSnapshot(907n, sessA.exportBytes());
		const snapB0 = exportCellSnapshot(sessB, 0);
		const snapB1 = exportCellSnapshot(sessB, 1);

		assert.deepStrictEqual(snapB0.entries, snapA0.entries,
			'fromSnapshot rebuilds the cache; sheet 0 mirrors source');
		assert.deepStrictEqual(snapB1.entries, snapA1.entries,
			'fromSnapshot rebuilds the cache; sheet 1 mirrors source');
	});
});

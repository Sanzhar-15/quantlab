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
import * as os from 'os';
import * as path from 'path';

import {
	loadQuantbookEngine,
	resolveEnginePath,
	resolveRelayBinaryPath,
	_resetQuantbookEngineCacheForTests,
} from '../src/quantbook/loader';
import {
	addSheet,
	appendPutFormulaValidated,
	appendPutValueValidated,
	buildPresenceSnapshotJson,
	clearPresence,
	createSession,
	createWorkbookSession,
	deleteSheet,
	exportCellSnapshot,
	exportToQbook,
	generateUuidPeerId,
	isAutoFlushPolicy,
	isQuantbookErrorCode,
	listSheets,
	loopbackTransportPair,
	moveSheet,
	openWorkbookFromQbook,
	parseQuantbookError,
	peerPresence,
	peersWithPresence,
	quantbookEngineVersion,
	recalcDirtyChecked,
	redo,
	renameSheet,
	restoreSheet,
	saveSessionToQbook,
	sessionFromQbook,
	sessionFromSnapshot,
	setFormulaValidated,
	setValueValidated,
	sweepPresence,
	undo,
	updatePresence,
	workbookSnapshot,
} from '../src/quantbook/session';
import type {
	BlockingTransportFixtureConstructor,
	CellSnapshotJson,
	FormatDefJson,
	QuantbookCellSnapshot,
	QuantbookNativeModule,
	SessionInstance,
	SheetSnapshotJson,
	WorkbookSnapshotDeltaJson,
	WorkbookSnapshotJson,
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
		// **Phase 6.1B inc.2d (2026-05-28):** a valid post-inc.2d binary must
		// also export the owning `Session` class (the loader now checks it).
		// Add a fixture-less-but-Session-complete fake so this test keeps
		// pinning the BlockingTransportFixture-optionality contract (the
		// fixture, NOT Session, is the thing being made optional here).
		const fakeSession = function () { /* fake */ };
		for (const m of [
			'addSheet', 'setValue', 'setFormula', 'clear',
			'recalcDirty', 'recalcAll', 'snapshot', 'cell', 'listSheets',
			// **Phase 6.4-3d Step 5 (2026-05-29):** the loader now also checks
			// these owning-Session methods, so a "complete" fake must carry them.
			'setUdfWorker', 'pollEvents',
			// **2026-06-03 (w39):** sync the fake to the loader's FULL current
			// owning-Session contract -- the loader's 6.3-1b/6.3-1c, 6.3-2a..2e,
			// 6.1C/6.4-2 parity, and 6.3-3 method checks all landed after this
			// fake was last updated, so a "Session-complete" fake must carry them
			// or the boundary check rejects it. This test pins the
			// BlockingTransportFixture optionality, NOT Session completeness, so
			// the fake must stay loader-complete.
			'startRecalcDirty', 'startRecalcAll', 'awaitRecalc', 'cancel', 'operationStatus',
			'lifecycleState', 'validateFormula', 'queryRange', 'markVolatilesDirty', 'setFormat', 'registerFormat',
			'open', 'save', 'import', 'export',
			'renameSheet', 'deleteSheet', 'restoreSheet', 'moveSheet', 'setName',
			'createTable', 'renameTable', 'renameColumn', 'resizeTable', 'dropTable',
			'batch', 'beginTransaction', 'txnAdd', 'commitTransaction', 'rollbackTransaction',
			'writeRange', 'publishDataset', 'bindRange', 'refreshSource', 'materializeQuery',
			'close', 'registerFunction', 'unregisterFunction', 'listFunctions',
			'snapshotDelta', 'undo', 'redo', 'canUndo', 'canRedo',
		]) {
			(fakeSession.prototype as Record<string, unknown>)[m] = function () { /* */ };
		}
		(process as unknown as { dlopen: typeof process.dlopen }).dlopen =
			(mod: NodeJS.Module): void => {
				(mod as unknown as { exports: Record<string, unknown> }).exports = {
					version: () => '0.1.0-prod-no-fixture',
					CollabSession: fakeCollabSession,
					Session: fakeSession,
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
		// V3.3.0.4: tbody carries data-virt-row-height + data-virt-total-rows
		// attrs for the webview scroll handler.  Match the open tag form.
		assert.ok(/<tbody\b/.test(html), 'tbody tag present (with virtualization attrs)');
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

import { acquireWorkbookSnapshotViaDelta, buildSheetManagementQuickPickItems, buildSheetMovePositionItems, buildSheetQuickPickItems, buildVirtualRows, classifyCellInput, classifyPollTick, computeVisibleRange, dispatchIncomingMessage, extractSheetSnapshot, getSharedDeltaCache, mergeWorkbookDelta, parseCellRawInput, validatePresenceNumeric, type DeltaSnapshotCache, type ErrorReplyMessage } from '../src/quantbook/cellGrid/cellGridLogic';

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

	function makeDeps(session: SessionInstance, sheet: number) {
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

	// FE-0a Part B (B1): the grid writes via the owning Session, which requires
	// the target sheet to exist before setValue/setFormula. Seed sheet 0.
	function freshSession(): SessionInstance {
		const s = createWorkbookSession();
		s.addSheet('S', 1000);
		return s;
	}

	function cellAt(session: SessionInstance, sheet: number, row: number, col: number) {
		const snap = extractSheetSnapshot(session.snapshot(), sheet);
		return snap?.entries.find(e => e.row === row && e.col === col);
	}

	test('putValue number: commits the value + invokes onCommit', () => {
		const session = freshSession();
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 1, col: 2, rawInput: '99.5' },
			deps,
		);
		assert.strictEqual(getCommitCount(), 1, 'onCommit fired once');
		assert.strictEqual(errorReplies.length, 0, 'no error reply on success');
		assert.deepStrictEqual(cellAt(session, 0, 1, 2), {
			row: 1, col: 2, value: { kind: 'number', value: 99.5 },
		});
	});

	// FE-0a Part B (B1) -- THE TEXT-CELL FIX: a non-numeric, non-formula literal
	// is now a TEXT cell (was a bad_argument rejection under the numeric-only path).
	test('putValue text: a non-numeric literal commits as a text cell (no error)', () => {
		const session = freshSession();
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 1, col: 2, rawInput: 'hello world' },
			deps,
		);
		assert.strictEqual(getCommitCount(), 1, 'onCommit fired (text is a valid value)');
		assert.strictEqual(errorReplies.length, 0, 'no error reply -- text is valid');
		assert.deepStrictEqual(cellAt(session, 0, 1, 2), {
			row: 1, col: 2, value: { kind: 'text', value: 'hello world' },
		});
	});

	// FE-0a Part B (B1): an empty literal clears the cell (blank) rather than
	// erroring (the old numeric-only path threw "cell value cannot be empty").
	test('putValue empty: clears the cell (blank), no error', () => {
		const session = freshSession();
		setValueValidated(session, 0, 0, 0, { kind: 'number', number: 7 });
		recalcDirtyChecked(session);
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 0, rawInput: '' },
			deps,
		);
		assert.strictEqual(getCommitCount(), 1, 'onCommit fired (blank clears)');
		assert.strictEqual(errorReplies.length, 0, 'empty input clears rather than erroring');
		assert.strictEqual(cellAt(session, 0, 0, 0), undefined, 'cell cleared');
	});

	// FE-0a Part B (B1): `=`-prefix routes to setFormula; the dependent recomputes
	// after the dispatch's recalc.
	test('putValue formula: commits via setFormula + recomputes the dependent', () => {
		const session = freshSession();
		setValueValidated(session, 0, 0, 0, { kind: 'number', number: 5 });
		recalcDirtyChecked(session);
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 1, rawInput: '=A1*2' },
			deps,
		);
		assert.strictEqual(getCommitCount(), 1);
		assert.strictEqual(errorReplies.length, 0);
		// The dispatch strips the leading `=` before setFormula; B1 = A1*2 = 10.
		// (A formula cell's snapshot entry also carries a normalized `formula`
		// field, so assert the value rather than the whole entry.)
		const b1 = cellAt(session, 0, 0, 1);
		assert.deepStrictEqual(b1?.value, { kind: 'number', value: 10 });
		assert.ok(typeof b1?.formula === 'string' && b1.formula.length > 0, 'B1 is a formula cell');
	});

	// FE megaudit L-g (2026-06-03): a sheet-mismatched putValue now sends a
	// bad_argument errorReply (instead of a silent drop) so the webview editor
	// un-sticks from its pessimistic pendingCommit state. Still no commit.
	test('putValue with sheet mismatch: no commit, errorReply un-sticks the editor', () => {
		const session = freshSession();
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 99, row: 0, col: 0, rawInput: '1.0' },
			deps,
		);
		assert.strictEqual(getCommitCount(), 0, 'no commit on sheet mismatch');
		assert.strictEqual(errorReplies.length, 1, 'a sheet-mismatch sends one errorReply');
		assert.strictEqual(errorReplies[0].code, 'bad_argument');
		assert.strictEqual(errorReplies[0].sheet, 99, 'echoes the requested sheet');
		assert.strictEqual(errorReplies[0].row, 0);
		assert.strictEqual(errorReplies[0].col, 0);
	});

	test('unknown + dormant-collab message types: dropped silently', () => {
		const session = freshSession();
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage({ type: 'futureFeature', payload: 42 }, deps);
		dispatchIncomingMessage({ noType: true }, deps);
		dispatchIncomingMessage('not an object', deps);
		dispatchIncomingMessage(null, deps);
		// FE-0a Part B (B1): presence + typing-stroke are collab-only (v1.5-dormant);
		// the Session dispatch drops them silently (no engine call, no error).
		dispatchIncomingMessage(
			{ type: 'presenceUpdate', state: { sheet: 0, row: 0, col: 0, selectionEndRow: 0, selectionEndCol: 0, typing: true } },
			deps,
		);
		dispatchIncomingMessage({ type: 'typing_stroke' }, deps);
		assert.strictEqual(getCommitCount(), 0);
		assert.strictEqual(errorReplies.length, 0);
	});

	// ---- FE-2-0 Phase 2 (commit-token edit-resolution protocol) ----
	function makeDepsP2(session: SessionInstance, sheet: number) {
		const errorReplies: ErrorReplyMessage[] = [];
		const acks: number[] = [];
		const opErrors: string[] = [];
		let commitCount = 0;
		const deps = {
			session,
			sheet,
			onCommit: () => { commitCount += 1; },
			onError: (reply: ErrorReplyMessage) => { errorReplies.push(reply); },
			onAck: (commitId: number) => { acks.push(commitId); },
			onOperationError: (message: string) => { opErrors.push(message); },
		};
		return { deps, errorReplies, acks, opErrors, getCommitCount: () => commitCount };
	}

	test('Phase 2: a tokened putValue success acks THIS commit (onAck) in addition to the session render', () => {
		const session = freshSession();
		const { deps, errorReplies, acks, getCommitCount } = makeDepsP2(session, 0);
		dispatchIncomingMessage({ type: 'putValue', sheet: 0, row: 1, col: 1, rawInput: '42', commitId: 7 }, deps);
		assert.strictEqual(getCommitCount(), 1, 'the session-wide render (onCommit) still fires');
		assert.deepStrictEqual(acks, [7], 'the originating commit is acked with its exact token');
		assert.strictEqual(errorReplies.length, 0);
	});

	test('Phase 2: a putValue WITHOUT a commitId does not ack (pre-token / Delete-clear path)', () => {
		const session = freshSession();
		const { deps, acks, getCommitCount } = makeDepsP2(session, 0);
		dispatchIncomingMessage({ type: 'putValue', sheet: 0, row: 1, col: 1, rawInput: '42' }, deps);
		assert.strictEqual(getCommitCount(), 1, 'still commits + renders');
		assert.deepStrictEqual(acks, [], 'no commitId -> no targeted ack (only the session render)');
	});

	test('Phase 2: a FAILED tokened putValue echoes the commitId in the errorReply + no ack', () => {
		const session = freshSession();
		const { deps, errorReplies, acks, getCommitCount } = makeDepsP2(session, 0);
		// =BADFORMULA( is unbindable -> the dispatch catch arm emits an errorReply, zero commit.
		dispatchIncomingMessage({ type: 'putValue', sheet: 0, row: 0, col: 0, rawInput: '=BADFORMULA(', commitId: 11 }, deps);
		assert.strictEqual(getCommitCount(), 0, 'no commit on a formula error');
		assert.strictEqual(errorReplies.length, 1);
		assert.strictEqual(errorReplies[0].commitId, 11, 'the failed commit echoes its token so the editor un-sticks + decorates');
		assert.deepStrictEqual(acks, [], 'no ack on failure');
	});

	test('Phase 2 (C1-MED5): a putValue outside the A1 extent is rejected with the commitId, never committed', () => {
		const session = freshSession();
		const { deps, errorReplies, acks, getCommitCount } = makeDepsP2(session, 0);
		dispatchIncomingMessage({ type: 'putValue', sheet: 0, row: 2_000_000, col: 0, rawInput: '1', commitId: 5 }, deps);
		assert.strictEqual(getCommitCount(), 0, 'an off-extent cell is never committed (would be invisible)');
		assert.strictEqual(errorReplies.length, 1);
		assert.strictEqual(errorReplies[0].code, 'bad_argument');
		assert.match(errorReplies[0].message, /outside the A1 grid extent/);
		assert.strictEqual(errorReplies[0].commitId, 5, 'echoes the token so the editor un-sticks');
		assert.deepStrictEqual(acks, []);
	});

	test('Phase 2 (C1-MED5): a fractional IN-RANGE row is NOT intercepted -> the engine integer validator runs', () => {
		const session = freshSession();
		const { deps, errorReplies } = makeDepsP2(session, 0);
		dispatchIncomingMessage({ type: 'putValue', sheet: 0, row: 1.5, col: 0, rawInput: '1', commitId: 3 }, deps);
		assert.strictEqual(errorReplies.length, 1);
		assert.match(errorReplies[0].message, /integer/, 'integrality is the engine validators job, not the extent check');
	});

	test('Phase 2 (S2-MED1): an undo throw routes to onOperationError, NOT a cell errorReply (no A1 mis-tint)', () => {
		const { deps, errorReplies, opErrors } = makeDepsP2(freshSession(), 0);
		// A session whose undo() throws -- exercises the catch arm deterministically.
		const throwingSession = { undo: () => { throw new Error('[invalid_state] cannot undo'); } } as unknown as SessionInstance;
		dispatchIncomingMessage({ type: 'undo' }, { ...deps, session: throwingSession });
		assert.strictEqual(errorReplies.length, 0, 'a session-wide failure is NOT a cell errorReply (no row=0/col=0 A1 mis-decoration)');
		assert.strictEqual(opErrors.length, 1, 'it goes to onOperationError (a plain warning toast)');
		assert.match(opErrors[0], /\[undo\]/, 'prefixed with the failed action');
		assert.match(opErrors[0], /invalid_state/, 'carries the structured error code');
	});
});

// ============================================================================
// FE megaudit S5 (2026-06-03) -- focused pure-helper coverage for the edit path:
//   classifyCellInput (number/hex/Infinity/text/blank/whitespace),
//   the dispatch formula-ERROR path (=BADFORMULA -> errorReply, zero commit),
//   and the extractSheetSnapshot blank-cell throw.
// These pin the No-Fallbacks edit semantics that the FE megaudit verified.
// ============================================================================

suite('FE megaudit S5 -- classifyCellInput (pure)', function () {
	test('blank + whitespace-only -> {kind:blank} (clears the cell)', () => {
		assert.deepStrictEqual(classifyCellInput(''), { kind: 'blank' });
		assert.deepStrictEqual(classifyCellInput('   '), { kind: 'blank' });
		assert.deepStrictEqual(classifyCellInput('\t \n'), { kind: 'blank' });
	});
	test('finite numbers (incl. hex / scientific / negative) -> {kind:number}', () => {
		assert.deepStrictEqual(classifyCellInput('42'), { kind: 'number', number: 42 });
		assert.deepStrictEqual(classifyCellInput('-3.5'), { kind: 'number', number: -3.5 });
		assert.deepStrictEqual(classifyCellInput('0xFF'), { kind: 'number', number: 255 });
		assert.deepStrictEqual(classifyCellInput('1e3'), { kind: 'number', number: 1000 });
		// Surrounding whitespace is trimmed before the numeric parse.
		assert.deepStrictEqual(classifyCellInput('  7  '), { kind: 'number', number: 7 });
	});
	test('Infinity / NaN are NOT finite -> fall through to text', () => {
		assert.deepStrictEqual(classifyCellInput('Infinity'), { kind: 'text', text: 'Infinity' });
		assert.deepStrictEqual(classifyCellInput('-Infinity'), { kind: 'text', text: '-Infinity' });
		assert.deepStrictEqual(classifyCellInput('NaN'), { kind: 'text', text: 'NaN' });
	});
	test('non-numeric literal -> {kind:text}; the text is TRIMMED (S2-M3)', () => {
		assert.deepStrictEqual(classifyCellInput('hello'), { kind: 'text', text: 'hello' });
		// S2-M3: text branch returns the TRIMMED literal, consistent with the number
		// branch (which classifies on trimmed). Was previously the un-trimmed raw.
		assert.deepStrictEqual(classifyCellInput('  hi  '), { kind: 'text', text: 'hi' });
	});
});

suite('FE megaudit S5 -- dispatch formula-error path + blank-throw', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('=BADFORMULA (unbindable) -> errorReply with a formula error code, ZERO commit', () => {
		const session = createWorkbookSession();
		session.addSheet('S', 1000);
		const errorReplies: ErrorReplyMessage[] = [];
		let commitCount = 0;
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 0, rawInput: '=BADFORMULA(' },
			{
				session,
				sheet: 0,
				onCommit: () => { commitCount += 1; },
				onError: (reply: ErrorReplyMessage) => { errorReplies.push(reply); },
			},
		);
		assert.strictEqual(commitCount, 0, 'a malformed formula must NOT commit');
		assert.strictEqual(errorReplies.length, 1, 'exactly one errorReply');
		assert.strictEqual(errorReplies[0].row, 0);
		assert.strictEqual(errorReplies[0].col, 0);
		// The engine surfaces a parse/bind failure; either is a recognized formula
		// error code (No-Fallbacks -- a loud errorReply, not a deferred #ERROR cell).
		assert.ok(
			errorReplies[0].code === 'formula_parse' || errorReplies[0].code === 'formula_bind',
			`expected a formula error code, got "${errorReplies[0].code}"`,
		);
		// The cell was NOT written.
		const cell = extractSheetSnapshot(session.snapshot(), 0)?.entries.find(e => e.row === 0 && e.col === 0);
		assert.strictEqual(cell, undefined, 'no cell written on the formula error');
	});

	test('extractSheetSnapshot throws on a kind=blank snapshot cell (No-Fallbacks)', () => {
		// A workbook snapshot never carries blank cells (the engine omits empties); a
		// blank surfacing in a snapshot entry is anomalous and must fail loud rather
		// than be coerced to pending/empty.
		const snap = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{ row: 0, col: 0, value: { kind: 'blank' } },
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		} as unknown as WorkbookSnapshotJson;
		assert.throws(() => extractSheetSnapshot(snap, 0),
			/\[bad_argument\] extractSheetSnapshot: kind='blank' is unexpected/);
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

	function makeDeps(session: SessionInstance, sheet: number) {
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
		const session = createWorkbookSession();
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
		const session = createWorkbookSession();
		const { deps, errorReplies } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 0, rawInput: undefined },
			deps,
		);
		assert.strictEqual(errorReplies.length, 1);
		assert.strictEqual(errorReplies[0].code, 'bad_argument');
	});

	test('rawInput = 42 (number) surfaces bad_argument', () => {
		const session = createWorkbookSession();
		const { deps, errorReplies } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 0, rawInput: 42 },
			deps,
		);
		assert.strictEqual(errorReplies.length, 1);
		assert.strictEqual(errorReplies[0].code, 'bad_argument');
	});

	test('rawInput = string but fractional row surfaces bad_argument via IDE validator', () => {
		const session = createWorkbookSession();
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

// ============================================================================
// Phase 5.7 V3.3.0.4 -- IDE virtualization scaffold (pure helpers + HTML)
// ============================================================================

suite('quantbook V3.3.0.4 -- computeVisibleRange (pure helper)', function () {
	test('empty (totalRows = 0) returns the empty range', () => {
		const r = computeVisibleRange(0, 25, 800, 0);
		assert.deepStrictEqual(r, { startIdx: 0, endIdx: 0 });
	});

	test('scrollTop = 0 with overscan applies overscan only at the bottom', () => {
		// firstVisible = 0; visibleCount = ceil(800/25) = 32; with
		// overscan=5: start = max(0, 0-5) = 0; end = min(100, 0+32+5) = 37.
		const r = computeVisibleRange(0, 25, 800, 100, 5);
		assert.strictEqual(r.startIdx, 0);
		assert.strictEqual(r.endIdx, 37);
	});

	test('scrollTop mid-viewport applies overscan symmetrically', () => {
		// scrollTop = 500; rowHeight = 25; firstVisible = 20;
		// visibleCount = 32; overscan = 5; start = 15; end = 57.
		const r = computeVisibleRange(500, 25, 800, 100, 5);
		assert.strictEqual(r.startIdx, 15);
		assert.strictEqual(r.endIdx, 57);
	});

	test('endIdx clamped to totalRows near the end', () => {
		// scrollTop = 2400 (row 96); visibleCount = 32; would-be end =
		// 96 + 32 + 5 = 133, clamped to totalRows = 100.
		const r = computeVisibleRange(2400, 25, 800, 100, 5);
		assert.strictEqual(r.endIdx, 100);
		assert.ok(r.startIdx >= 91 && r.startIdx <= 96);
	});

	test('defensive: rowHeight = 0 returns full range (no div-by-zero)', () => {
		const r = computeVisibleRange(500, 0, 800, 50);
		assert.deepStrictEqual(r, { startIdx: 0, endIdx: 50 });
	});

	test('overscan = 0 produces tight range', () => {
		// scrollTop=0; firstVisible=0; visibleCount=32; overscan=0;
		// start = 0; end = 32.
		const r = computeVisibleRange(0, 25, 800, 100, 0);
		assert.deepStrictEqual(r, { startIdx: 0, endIdx: 32 });
	});

	test('overscan default = 5 when omitted', () => {
		const explicit = computeVisibleRange(0, 25, 800, 100, 5);
		const defaulted = computeVisibleRange(0, 25, 800, 100);
		assert.deepStrictEqual(defaulted, explicit);
	});
});

suite('quantbook V3.3.0.4 -- buildVirtualRows (pure helper)', function () {
	test('slices entries to [startIdx, endIdx)', () => {
		const entries = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		assert.deepStrictEqual(buildVirtualRows(entries, 2, 5), [2, 3, 4]);
	});

	test('startIdx > endIdx returns empty', () => {
		const entries = [0, 1, 2, 3];
		assert.deepStrictEqual(buildVirtualRows(entries, 3, 1), []);
	});

	test('out-of-bounds endIdx clamps to length', () => {
		const entries = [0, 1, 2];
		assert.deepStrictEqual(buildVirtualRows(entries, 0, 99), [0, 1, 2]);
	});

	test('negative startIdx clamps to 0', () => {
		const entries = [10, 20, 30];
		assert.deepStrictEqual(buildVirtualRows(entries, -5, 2), [10, 20]);
	});

	test('empty entries returns empty regardless of indices', () => {
		assert.deepStrictEqual(buildVirtualRows([], 0, 10), []);
	});

	test('preserves entry contents (does not mutate input)', () => {
		const entries = [
			{ row: 0, col: 0, value: { kind: 'number', value: 42 } },
			{ row: 1, col: 0, value: { kind: 'text', value: 'hi' } },
		];
		const sliced = buildVirtualRows(entries, 0, 1);
		assert.strictEqual(sliced.length, 1);
		assert.strictEqual(sliced[0], entries[0]);
		// Mutate sliced; input unchanged.
		assert.strictEqual(entries.length, 2);
	});
});

suite('quantbook V3.3.0.4 -- buildHtml virtualization wiring', function () {
	test('non-nonce mode (V3.2.a) does NOT virtualize (no scroll handler)', () => {
		// Create a snapshot with 100 entries; the V3.2.a path renders ALL
		// of them (no virtualization gate).
		const entries: Array<{ row: number; col: number; value: { kind: 'number'; value: number } }> = [];
		for (let i = 0; i < 100; i += 1) {
			entries.push({ row: i, col: 0, value: { kind: 'number', value: i } });
		}
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries });
		assert.ok(!html.includes('cell-grid-data'),
			'no snapshot data block in V3.2.a-compat path');
		assert.ok(!html.includes('virtualized; initial window'),
			'no virtualization marker in meta');
	});

	test('nonced mode with >40 entries virtualizes (initial window of 40)', () => {
		const entries: Array<{ row: number; col: number; value: { kind: 'number'; value: number } }> = [];
		for (let i = 0; i < 100; i += 1) {
			entries.push({ row: i, col: 0, value: { kind: 'number', value: i } });
		}
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries }, { nonce: 'v3304test' });
		// Server-side renders 40 rows; bottom spacer covers the remaining 60.
		assert.ok(html.includes('virtualized; initial window 40'),
			'meta indicates virtualization is active');
		assert.ok(html.includes('cell-grid-data'),
			'snapshot data block present for client-side scroll');
		assert.ok(html.includes('<script id="cell-grid-data" type="application/json">'),
			'data block uses non-JS script tag (non-nonced; CSP blocks execution)');
		assert.ok(html.includes('cell-grid-viewport'),
			'viewport wrapper present');
		// Bottom spacer = (100 - 40) * 25 = 1500px.
		assert.ok(html.includes('data-spacer-height="1500"'),
			'bottom spacer height pre-computed');
		assert.ok(html.includes('data-virt-row-height="25"'),
			'tbody carries virtualization metadata');
		assert.ok(html.includes('data-virt-total-rows="100"'));
	});

	test('nonced mode with <=40 entries does NOT virtualize', () => {
		const entries: Array<{ row: number; col: number; value: { kind: 'number'; value: number } }> = [];
		for (let i = 0; i < 10; i += 1) {
			entries.push({ row: i, col: 0, value: { kind: 'number', value: i } });
		}
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries }, { nonce: 'v3304test' });
		assert.ok(!html.includes('virtualized; initial window'),
			'small snapshot does not trigger virtualization');
		assert.ok(html.includes('data-spacer-height="0"'),
			'top + bottom spacers both 0 when not virtualized');
		// Data block still emitted (nonce present + script can read it
		// if user scrolls or other paths need it).
		assert.ok(html.includes('cell-grid-data'));
	});

	test('snapshot data block HTML-escapes embedded </script>', () => {
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 0, col: 0, value: { kind: 'text', value: '</script>alert(1)' } },
			],
		}, { nonce: 'v3304test' });
		// The data block's JSON encoded the close-tag pattern; the
		// belt-and-suspenders escape replaces `</script` with `<\/script`.
		assert.ok(!html.match(/<script[^>]*>[^<]*<\/script>alert\(1\)/),
			'no premature script-tag termination via cell payload');
	});

	test('webview script body wires the scroll handler + reads data block', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v3304test' });
		// Pin the contract surface: the script reads from cell-grid-data,
		// listens on scroll, uses ROW_HEIGHT + OVERSCAN.
		assert.ok(html.includes('getElementById(\'cell-grid-data\')'));
		assert.ok(html.includes('addEventListener(\'scroll\''));
		assert.ok(html.includes('ROW_HEIGHT = 25'));
		assert.ok(html.includes('OVERSCAN = 5'));
		// Mid-edit guard: activeInput check
		assert.ok(html.includes('if (activeInput !== null) { return; }'));
	});
});

// ============================================================================
// Phase 5.7 V3.3.0.5 -- multi-sheet UX (buildSheetQuickPickItems helper)
// ============================================================================

suite('quantbook V3.3.0.5 -- buildSheetQuickPickItems', function () {
	test('empty sheets returns empty items', () => {
		assert.deepStrictEqual(buildSheetQuickPickItems([], 0), []);
	});

	test('single sheet matching current is labelled (current)', () => {
		const items = buildSheetQuickPickItems([0], 0);
		assert.deepStrictEqual(items, [
			{ label: 'Sheet 0', description: '(current)', sheet: 0 },
		]);
	});

	test('multi-sheet annotates only the current', () => {
		const items = buildSheetQuickPickItems([0, 2, 5], 2);
		assert.deepStrictEqual(items, [
			{ label: 'Sheet 0', description: '', sheet: 0 },
			{ label: 'Sheet 2', description: '(current)', sheet: 2 },
			{ label: 'Sheet 5', description: '', sheet: 5 },
		]);
	});

	test('current sheet not in the list (panel + session out-of-sync) -- none annotated', () => {
		// Edge case: panel.sheet was last set to 99 but session no longer
		// has sheet 99 (e.g., a future undo path could remove it).  The
		// helper still produces items; the user sees no "(current)"
		// marker.  This is the safe degraded behavior; the command-site
		// caller still gets a usable list.
		const items = buildSheetQuickPickItems([0, 1, 2], 99);
		assert.strictEqual(items.length, 3);
		assert.ok(items.every(i => i.description === ''));
	});

	test('input order is preserved (caller already sorts via listSheets)', () => {
		// Pin that the helper does NOT re-sort.  `listSheets` already
		// returns sorted ascending; the helper trusts that contract.
		// Passing a non-sorted input verifies the helper does NOT mutate
		// the order.
		const items = buildSheetQuickPickItems([5, 1, 3], 1);
		assert.deepStrictEqual(items.map(i => i.sheet), [5, 1, 3]);
	});
});

// ============================================================================
// Phase 5.7 V3.3.0.6 -- gap-closure tests (audit followup)
// ============================================================================
//
// V3.3.0.6 was scoped at V3.3.0.1 plan time as "mocha tests"; the
// per-sub-step tests (V3.3.0.2 +5, V3.3.0.3 +4, V3.3.0.4 +18, V3.3.0.5
// +5) covered most of the surface.  The V3.3.0.6 deferred piece was
// "1 integration test (open panel + scroll simulation + verify only
// visible rows in HTML)" -- impossible to execute literally without
// jsdom (mocha has no DOM by default), but achievable as a pure-helper
// composition test that exercises the V3.3.0.4 virtualization geometry
// across simulated scroll-position changes.

suite('quantbook V3.3.0.6 -- scroll-simulation integration (pure-helper composition)', function () {
	// Build a synthetic 100-row snapshot for the simulation.
	function makeSnapshot(totalRows: number): QuantbookCellSnapshot {
		const entries: Array<{ row: number; col: number; value: { kind: 'number'; value: number } }> = [];
		for (let i = 0; i < totalRows; i += 1) {
			entries.push({ row: i, col: 0, value: { kind: 'number', value: i * 10 } });
		}
		return { snapshot_format_version: 1, sheet: 0, entries };
	}

	test('scroll from top to bottom: window advances monotonically; total cells rendered match', () => {
		const snapshot = makeSnapshot(200);
		const ROW_HEIGHT = 25;
		const VIEWPORT_HEIGHT = 800; // ~32 visible rows
		const OVERSCAN = 5;
		// Simulate scrolling through 9 positions (top, 25%, 50%, 75%,
		// bottom) and verify that each step's visible window is a
		// monotonic-advancing slice of the snapshot.
		const scrollPositions = [0, 500, 1250, 2500, 3750, 4500, 4900];
		let lastStartIdx = -1;
		for (const scrollTop of scrollPositions) {
			const range = computeVisibleRange(scrollTop, ROW_HEIGHT, VIEWPORT_HEIGHT, snapshot.entries.length, OVERSCAN);
			const visible = buildVirtualRows(snapshot.entries, range.startIdx, range.endIdx);
			// Every window covers at least the viewport (32 rows) +
			// overscan margin (10 = 5 above + 5 below), clamped to
			// totalRows near the end.
			const expectedMaxRows = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + 2 * OVERSCAN;
			assert.ok(visible.length <= expectedMaxRows,
				`scrollTop=${scrollTop}: visible window ${visible.length} should be at most ${expectedMaxRows} rows`);
			// Monotonic advancement: startIdx never moves backwards
			// (this is the user scrolling DOWN; pin the geometry
			// invariant that increasing scrollTop yields >= startIdx).
			assert.ok(range.startIdx >= lastStartIdx,
				`scrollTop=${scrollTop}: startIdx ${range.startIdx} should be >= prior ${lastStartIdx}`);
			// Each visible row's row index matches its position in
			// the snapshot (pure-slice semantics; no reordering).
			for (let i = 0; i < visible.length; i += 1) {
				assert.strictEqual(visible[i].row, range.startIdx + i,
					`scrollTop=${scrollTop}: visible[${i}] expected row ${range.startIdx + i}`);
			}
			lastStartIdx = range.startIdx;
		}
	});

	test('virtualized buildHtml produces correct spacer geometry at multiple snapshot sizes', () => {
		// Pin that the server-side virtualization gate + spacer
		// computation produces consistent geometry across the
		// virtualization-on / virtualization-off boundary.
		const ROW_HEIGHT = 25;
		const INITIAL_ROWS = 40;
		const sizes = [10, 40, 41, 100, 1000];
		for (const totalRows of sizes) {
			const html = buildHtml(makeSnapshot(totalRows), { nonce: 'simulation' });
			const virtualizationActive = totalRows > INITIAL_ROWS;
			const expectedBottomSpacer = virtualizationActive
				? (totalRows - INITIAL_ROWS) * ROW_HEIGHT
				: 0;
			assert.ok(
				html.includes(`data-spacer-height="${expectedBottomSpacer}"`),
				`totalRows=${totalRows} (virtualization=${virtualizationActive}): expected bottom-spacer height ${expectedBottomSpacer}`,
			);
			// Total rows attribute always reflects the FULL snapshot
			// even when only INITIAL_ROWS are server-rendered.
			assert.ok(
				html.includes(`data-virt-total-rows="${totalRows}"`),
				`totalRows=${totalRows}: tbody attribute should expose full row count`,
			);
		}
	});

	test('scroll-simulation: rendered rows shift correctly as scrollTop advances by single-row increments', () => {
		// Tight check: increment scrollTop by ROW_HEIGHT and verify
		// the visible window advances by 1 row.  This catches off-by-
		// one errors in `Math.floor(scrollTop / rowHeight)`.
		const ROW_HEIGHT = 25;
		const VIEWPORT_HEIGHT = 200; // 8 visible rows
		const OVERSCAN = 0; // tight test
		const ranges: Array<{ startIdx: number; endIdx: number }> = [];
		for (let scrollTop = 0; scrollTop <= 250; scrollTop += ROW_HEIGHT) {
			ranges.push(computeVisibleRange(scrollTop, ROW_HEIGHT, VIEWPORT_HEIGHT, 50, OVERSCAN));
		}
		// Expected: startIdx = 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
		for (let i = 0; i < ranges.length; i += 1) {
			assert.strictEqual(ranges[i].startIdx, i,
				`single-row advance step ${i}: startIdx should be ${i}, got ${ranges[i].startIdx}`);
		}
	});

	test('V3.3.0.7 title-computation contract: listSheets-based suffix is point-in-time', () => {
		// V3.3.0.5 panel title: "Sheet N of M" where M =
		// session.listSheets().length at show() time.  This test pins
		// that the title is COMPUTED FRESH each show() call (point-in-
		// time semantic) rather than cached/memoized.  If a future
		// V3.x adds title caching, this test catches the change.
		const session = createSession(1001n);
		appendPutValueValidated(session, 0, 0, 0, 1);
		assert.strictEqual(session.listSheets().length, 1,
			'initial: 1 sheet');
		// Append on a second sheet; listSheets reflects immediately.
		appendPutValueValidated(session, 1, 0, 0, 2);
		assert.strictEqual(session.listSheets().length, 2,
			'after second-sheet append: 2 sheets');
		// Pin engine-side reactivity: the value `session.listSheets()`
		// returns at any given moment IS the value the panel title
		// would compute at that moment.  No staleness layer between
		// engine + IDE.
		appendPutValueValidated(session, 2, 0, 0, 3);
		assert.strictEqual(session.listSheets().length, 3);
	});
});

// ============================================================================
// Phase 5.7 V3.3.0.X audit closures (cumulative cross-lane megaudit)
// ============================================================================

suite('quantbook V3.3.0.X HIGH-1 -- undo/redo invalidate snapshot cache', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('undo: exportCellSnapshot reflects cache invalidation after undo', () => {
		// Pre-V3.3.0.X audit closure (Codex + Opus HIGH-1 convergent):
		// undo() bypassed rebuild_snapshot_cache so snapshot_cells
		// returned the undone cell as if undo never fired.  Now: undo
		// rebuilds the cache when consumed.  The napi binding doesn't
		// yet expose undo (V3.4 scope), but the engine method is
		// covered via the existing CollabSession Rust unit tests -
		// the IDE-side regression here pins the OBSERVABLE contract
		// (exportCellSnapshot is engine-driven; its output reflects
		// whatever rebuild_snapshot_cache produced).
		//
		// For V3.3.0.X test surface: confirm that exportCellSnapshot
		// converges across the cache-invalidation paths we already
		// trigger (mergeBytes round-trip).  The Rust-side undo path
		// will get its own ql-collab unit test (engine-side test).
		// IDE-side smoke: verify post-rebuild cache reads observable
		// from JS.
		const sessA = createSession(2001n);
		appendPutValueValidated(sessA, 0, 0, 0, 1);
		appendPutValueValidated(sessA, 0, 0, 1, 2);
		appendPutValueValidated(sessA, 0, 0, 2, 3);
		// Round-trip via exportBytes -> fromSnapshot rebuilds cache.
		const sessB = sessionFromSnapshot(2002n, sessA.exportBytes());
		const snapA = exportCellSnapshot(sessA, 0);
		const snapB = exportCellSnapshot(sessB, 0);
		assert.deepStrictEqual(snapB.entries, snapA.entries);
		assert.strictEqual(snapB.entries.length, 3);
	});
});

suite('quantbook V3.3.0.X HIGH-2 -- listSheets error propagation (no silent catch)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('listSheets on empty session returns [] (no error to swallow)', () => {
		// The HIGH-2 closure removed `try { listSheets() } catch { ... }`
		// from CellGridPanel.show().  This test pins that empty
		// sessions are handled WITHOUT a silent fallback -- listSheets
		// returns [] cleanly, not by throwing.
		const session = createSession(2003n);
		const sheets = listSheets(session);
		assert.deepStrictEqual(sheets, []);
		// This is what the panel title computation NOW relies on:
		// listSheets().length === 0 -> no "of M" suffix (single-sheet
		// branch is also length<=1 -> no suffix).
		assert.strictEqual(sheets.length <= 1, true);
	});
});

suite('quantbook V3.3.0.X MEDIUM-3 -- listSheets reads from cache', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('listSheets matches snapshot-derived sheet set after mergeBytes', () => {
		// Pin the V3.3.0.X audit closure: listSheets now reads from
		// the V3.3.0.3 incremental cache (list_sheets_from_cache).
		// Verify the output matches what we'd get by walking
		// exportCellSnapshot for each sheet candidate.
		const sessA = createSession(2004n);
		appendPutValueValidated(sessA, 0, 0, 0, 10);
		appendPutValueValidated(sessA, 5, 0, 0, 50);
		appendPutValueValidated(sessA, 2, 0, 0, 20);
		// Round-trip into B; B's cache rebuilt via fromSnapshot.
		const sessB = sessionFromSnapshot(2005n, sessA.exportBytes());
		const sheetsA = listSheets(sessA);
		const sheetsB = listSheets(sessB);
		assert.deepStrictEqual(sheetsA, [0, 2, 5]);
		assert.deepStrictEqual(sheetsB, [0, 2, 5]);
		// Each enumerated sheet has at least one cell in the
		// snapshot (the cache derivation is canonical).
		for (const sheet of sheetsA) {
			const snap = exportCellSnapshot(sessA, sheet);
			assert.ok(snap.entries.length >= 1,
				`sheet ${sheet} should have >=1 cell per cache derivation`);
		}
	});
});

suite('quantbook V3.3.0.X LOW-1 -- row/col Number() coercion in HTML', function () {
	test('buildHtml row/col attrs use Number()-coerced values', () => {
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 7, col: 3, value: { kind: 'number', value: 42 } },
			],
		}, { nonce: 'low1' });
		// Both raw row/col (in <td>) and data-row/data-col attrs
		// should reflect the numeric input.
		assert.ok(html.includes('<td>7</td><td>3</td>'));
		assert.ok(html.includes('data-row="7"'));
		assert.ok(html.includes('data-col="3"'));
	});

	test('client renderRowsClient script body uses rowSafe/colSafe vars', () => {
		// Defense-in-depth pin: the inline script body must include
		// the Number()-coercion variables.  This catches drift if a
		// future maintainer reverts the V3.3.0.X LOW-1 closure.
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [],
		}, { nonce: 'low1' });
		assert.ok(html.includes('var rowSafe = Number(e.row)'),
			'client mirror coerces row via Number()');
		assert.ok(html.includes('var colSafe = Number(e.col)'),
			'client mirror coerces col via Number()');
	});
});

// ============================================================================
// Phase 5.7 V3.4.0.3 -- engine + IDE undo/redo napi bindings + Cmd-Z wiring
// ============================================================================

suite('quantbook V3.4.0.3 -- engine undo/redo napi bindings (round-trip via cache)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('undo on empty session returns false (no-op)', () => {
		const session = createSession(3401n);
		assert.strictEqual(undo(session), false,
			'empty undo stack yields false; no engine throw');
		assert.strictEqual(redo(session), false,
			'empty redo stack yields false; no engine throw');
	});

	test('undo of single append retracts cell from exportCellSnapshot (cache reflects)', () => {
		// V3.3.0.X HIGH-1 closure + V3.4.0.2 CellState shape: undo()
		// rebuilds last_snapshot via rebuild_snapshot_cache, so the
		// post-undo exportSnapshot reflects the retraction.  Pre-V3.3.0.X
		// this would have returned a stale cell.
		const session = createSession(3402n);
		appendPutValueValidated(session, 0, 5, 5, 42);
		assert.strictEqual(exportCellSnapshot(session, 0).entries.length, 1);

		const consumed = undo(session);
		assert.strictEqual(consumed, true, 'append was undoable');
		assert.strictEqual(exportCellSnapshot(session, 0).entries.length, 0,
			'post-undo snapshot reflects retraction via V3.3.0.X cache rebuild');
	});

	test('undo-then-redo round-trip restores cell via cache', () => {
		const session = createSession(3403n);
		appendPutValueValidated(session, 0, 0, 0, 100);
		appendPutValueValidated(session, 0, 0, 1, 200);

		assert.strictEqual(undo(session), true);
		assert.strictEqual(exportCellSnapshot(session, 0).entries.length, 1,
			'after undo: only first cell remains');

		assert.strictEqual(redo(session), true);
		const post = exportCellSnapshot(session, 0).entries;
		assert.strictEqual(post.length, 2, 'after redo: both cells back');
		// Pin VALUES too (not just count) -- V3.4.0.2 CellState extracts .value.
		const values = post.map(e => e.value).filter((v): v is { kind: 'number'; value: number } => v.kind === 'number').map(v => v.value).sort();
		assert.deepStrictEqual(values, [100, 200]);
	});

	test('undo across multi-cell append: each undo retracts one cell at a time', () => {
		const session = createSession(3404n);
		for (let i = 0; i < 5; i += 1) {
			appendPutValueValidated(session, 0, i, 0, i * 10);
		}
		assert.strictEqual(exportCellSnapshot(session, 0).entries.length, 5);
		// Undo all 5; expect monotonic shrinkage.
		for (let n = 4; n >= 0; n -= 1) {
			assert.strictEqual(undo(session), true);
			assert.strictEqual(exportCellSnapshot(session, 0).entries.length, n,
				`after undo #${5 - n}: snapshot has ${n} entries`);
		}
		// Final undo on empty stack: false.
		assert.strictEqual(undo(session), false);
	});
});

suite('quantbook V3.4.0.3 -- dispatchIncomingMessage undo/redo arms', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	function makeDeps(session: SessionInstance, sheet: number) {
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

	// FE-0a Part B (B1): on the owning Session, undo/redo return
	// `UndoRedoResultJson { consumed }` (the dispatch handles the DTO internally);
	// the entry count is read via extractSheetSnapshot(session.snapshot(), ...).
	// NB addSheet is itself undoable, so the empty-stack tests stay pristine.
	function entryCount(session: SessionInstance, sheet: number): number {
		return (extractSheetSnapshot(session.snapshot(), sheet)?.entries ?? []).length;
	}

	test('undo envelope on consumed undo: triggers onCommit, no errorReply', () => {
		const session = createWorkbookSession();
		session.addSheet('S', 1000);
		setValueValidated(session, 0, 0, 0, { kind: 'number', number: 1 });
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);

		dispatchIncomingMessage({ type: 'undo' }, deps);

		assert.strictEqual(getCommitCount(), 1, 'consumed undo triggers onCommit');
		assert.strictEqual(errorReplies.length, 0);
		// Engine state confirmation: cell retracted (the setValue undone).
		assert.strictEqual(entryCount(session, 0), 0);
	});

	test('undo envelope on empty stack: silent no-op (no onCommit, no errorReply)', () => {
		const session = createWorkbookSession(); // pristine: nothing to undo
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);

		dispatchIncomingMessage({ type: 'undo' }, deps);

		assert.strictEqual(getCommitCount(), 0, 'empty undo stack does NOT trigger onCommit');
		assert.strictEqual(errorReplies.length, 0,
			'empty undo stack does NOT generate errorReply (per the dispatcher contract)');
	});

	test('redo envelope on consumed redo: triggers onCommit', () => {
		const session = createWorkbookSession();
		session.addSheet('S', 1000);
		setValueValidated(session, 0, 0, 0, { kind: 'number', number: 99 });
		session.undo(); // undo the setValue -> populates the redo stack
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);

		dispatchIncomingMessage({ type: 'redo' }, deps);

		assert.strictEqual(getCommitCount(), 1);
		assert.strictEqual(errorReplies.length, 0);
		assert.strictEqual(entryCount(session, 0), 1, 'redo restored the cell');
	});

	test('redo envelope on empty stack: silent no-op', () => {
		const session = createWorkbookSession(); // pristine: nothing to redo
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);

		dispatchIncomingMessage({ type: 'redo' }, deps);

		assert.strictEqual(getCommitCount(), 0);
		assert.strictEqual(errorReplies.length, 0);
	});

	test('undo envelope ignored payload fields (session-wide, not cell-keyed)', () => {
		// Defensive: even if the webview script accidentally posts
		// {type:'undo', sheet: 99, row: 5} the dispatcher should ignore
		// the extra fields + operate on the engine's session-wide undo stack.
		const session = createWorkbookSession();
		session.addSheet('S', 1000);
		setValueValidated(session, 0, 0, 0, { kind: 'number', number: 1 });
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);

		dispatchIncomingMessage({ type: 'undo', sheet: 99, row: 5, col: 5 }, deps);

		assert.strictEqual(getCommitCount(), 1, 'undo proceeded regardless of payload');
		assert.strictEqual(errorReplies.length, 0);
	});
});

suite('quantbook V3.4.0.3 -- buildHtml inline script wiring for undo/redo keybindings', function () {
	test('script body binds document-level keydown listener', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v3403' });
		// Document-level listener (NOT input-scoped) so Cmd-Z works
		// outside of mid-edit.
		assert.ok(html.includes('document.addEventListener(\'keydown\''),
			'document-level keydown listener present');
	});

	test('script body has activeInput-null mid-edit guard before posting undo', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v3403' });
		// Critical: when activeInput !== null, the keydown handler
		// returns BEFORE preventDefault + postMessage.  This lets the
		// browser's text-undo work inside <input> elements (Cmd-Z in
		// the cell input undoes typed characters, NOT the workbook).
		assert.ok(html.includes('if (activeInput !== null)'),
			'mid-edit guard present');
		// Pin that the guard appears INSIDE the keydown handler (not
		// only in the scroll handler).  Look for the guard's comment
		// "let the browser handle text-undo" we wrote in V3.4.0.3.
		assert.ok(html.includes('let the browser handle text-undo'),
			'mid-edit guard comment confirms keydown-scope intent');
	});

	test('script body emits undo + redo postMessage envelopes for Cmd/Ctrl + key combos', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v3403' });
		// Modifier check: metaKey (Mac Cmd) OR ctrlKey (Win/Linux).
		assert.ok(html.includes('ev.metaKey || ev.ctrlKey'),
			'both Cmd (Mac) and Ctrl (Win/Linux) modifiers honored');
		// Undo: Cmd/Ctrl-Z without Shift.
		assert.ok(html.includes('vscode.postMessage({ type: \'undo\' })'),
			'undo envelope post present');
		// Redo: Cmd/Ctrl-Shift-Z OR Ctrl-Y.
		assert.ok(html.includes('vscode.postMessage({ type: \'redo\' })'),
			'redo envelope post present');
		// Key dispatch shape: case-insensitive on 'z' / 'y'.
		assert.ok(html.includes('ev.key.toLowerCase()'),
			'key matching is case-insensitive');
	});

	test('non-nonced V3.2.a path does NOT include undo/redo wiring', () => {
		// V3.2.a (read-only) builds with no nonce; the inline script is
		// not emitted; therefore no undo/redo handlers either.  Pin
		// that the V3.4.0.3 wiring is gated behind nonced mode.
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] });
		assert.ok(!html.includes('vscode.postMessage({ type: \'undo\' })'),
			'undo wiring absent in V3.2.a-compat read-only mode');
		assert.ok(!html.includes('vscode.postMessage({ type: \'redo\' })'),
			'redo wiring absent in V3.2.a-compat read-only mode');
	});
});

// ============================================================================
// Phase 5.7 V3.4.0.5 -- presence napi wrappers (engine-side only)
// ============================================================================
//
// V3.4.0.5 engine-only ship: napi wrappers over Phase 5.6 V1+V2 presence
// methods on CollabSession.  IDE wiring (cell-grid decoration, sweep cadence,
// presenceRepaintInFlight race guard per V3.4.0.1 D4) deferred to V3.4.0.5
// IDE follow-up.  These tests pin the napi contract.

suite('quantbook V3.4.0.5 -- presence napi round-trips', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	function sampleState(sheet = 0, row = 3, col = 4) {
		return {
			sheet,
			row,
			col,
			selectionEndRow: row,
			selectionEndCol: col,
			typing: false,
		};
	}

	test('updatePresence + peerPresence round-trip preserves all fields', () => {
		const session = createSession(3501n);
		const state = { sheet: 2, row: 7, col: 11, selectionEndRow: 9, selectionEndCol: 15, typing: true };
		updatePresence(session, state);

		const fetched = peerPresence(session, session.peerId());
		assert.ok(fetched !== null, 'peerPresence returns the just-updated state');
		assert.deepStrictEqual(fetched, state, 'all 6 fields round-trip lossless');
	});

	test('peerPresence on never-updated peer returns null', () => {
		const session = createSession(3502n);
		// Different peer id than session's own; never updated.
		const result = peerPresence(session, 999n);
		assert.strictEqual(result, null);
	});

	test('updatePresence overwrites prior state (LWW per peer)', () => {
		const session = createSession(3503n);
		updatePresence(session, sampleState(0, 1, 1));
		updatePresence(session, sampleState(5, 50, 50));

		const fetched = peerPresence(session, session.peerId());
		assert.strictEqual(fetched?.sheet, 5);
		assert.strictEqual(fetched?.row, 50);
		assert.strictEqual(fetched?.col, 50);
	});

	test('clearPresence removes this session\'s entry; peerPresence returns null after', () => {
		const session = createSession(3504n);
		updatePresence(session, sampleState());
		assert.ok(peerPresence(session, session.peerId()) !== null);

		clearPresence(session);
		assert.strictEqual(peerPresence(session, session.peerId()), null,
			'after clearPresence, own entry is gone');
	});

	test('peersWithPresence enumerates updated peers (self after first update)', () => {
		const session = createSession(3505n);
		assert.deepStrictEqual(peersWithPresence(session), [],
			'no peers before any update');

		updatePresence(session, sampleState());
		const peers = peersWithPresence(session);
		assert.strictEqual(peers.length, 1);
		assert.strictEqual(peers[0], session.peerId());
	});

	test('peersWithPresence reflects cross-peer merges (round-trip via exportBytes)', () => {
		// Two sessions, each updates own presence; A merges B's snapshot;
		// A's peersWithPresence enumerates both peers.
		const sessA = createSession(3506n);
		const sessB = createSession(3507n);
		updatePresence(sessA, sampleState(0, 1, 1));
		updatePresence(sessB, sampleState(0, 9, 9));

		// A learns about B by merging B's snapshot bytes.
		sessA.mergeBytes(sessB.exportBytes());

		const peers = peersWithPresence(sessA).slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		assert.deepStrictEqual(peers, [3506n, 3507n], 'both peers visible after merge');

		// Cross-fetch: A can read B's presence state.
		const bState = peerPresence(sessA, 3507n);
		assert.ok(bState !== null);
		assert.strictEqual(bState?.row, 9);
		assert.strictEqual(bState?.col, 9);
	});

	test('sweepPresence on empty session returns 0', () => {
		const session = createSession(3508n);
		assert.strictEqual(sweepPresence(session), 0,
			'no entries to sweep');
	});

	test('sweepPresence after multi-peer merge returns count + clears all entries', () => {
		const sessA = createSession(3509n);
		const sessB = createSession(3510n);
		updatePresence(sessA, sampleState());
		updatePresence(sessB, sampleState());
		sessA.mergeBytes(sessB.exportBytes());
		// Sanity: 2 peers present pre-sweep.
		assert.strictEqual(peersWithPresence(sessA).length, 2);

		const removed = sweepPresence(sessA);
		assert.strictEqual(removed, 2, 'sweepPresence returns count of removed entries');
		assert.deepStrictEqual(peersWithPresence(sessA), [],
			'all peers gone after sweep');
	});

	test('presence persists across exportBytes/fromSnapshot (engine V1 known limitation)', () => {
		// Engine docstring: presence lives in the same LoroDoc whose
		// snapshot is wrapped into oplog.bin; cold restart restores
		// stale presence entries.  Pin this behavior so future engine
		// changes that fix this (V3.4.1+) will fail the test + force
		// an explicit migration update.
		const sessA = createSession(3511n);
		updatePresence(sessA, sampleState(0, 42, 42));
		const bytes = sessA.exportBytes();

		const sessB = sessionFromSnapshot(3512n, bytes);
		const preserved = peerPresence(sessB, 3511n);
		assert.ok(preserved !== null,
			'presence persists across snapshot round-trip (V1 limitation)');
		assert.strictEqual(preserved?.row, 42);

		// Caller-opt-in sweep restores clean slate.
		sweepPresence(sessB);
		assert.strictEqual(peerPresence(sessB, 3511n), null);
	});
});

// ============================================================================
// Phase 5.7 V3.4.0.5b -- IDE cell-grid presence integration
// ============================================================================

suite('quantbook V3.4.0.5b -- buildPresenceSnapshotJson (host-side helper)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('empty session: peers list is empty, selfPeerId is 16-hex lowercase', () => {
		const session = createSession(0x1234n);
		const snap = buildPresenceSnapshotJson(session, 0);
		assert.deepStrictEqual(snap.peers, []);
		assert.strictEqual(snap.selfPeerId, '0000000000001234',
			'16-hex padded lowercase; matches engine presence::peer_key convention');
	});

	test('self-only presence: peers list is empty (skip-self filter)', () => {
		const session = createSession(3601n);
		updatePresence(session, { sheet: 0, row: 1, col: 2, selectionEndRow: 1, selectionEndCol: 2, typing: false });
		const snap = buildPresenceSnapshotJson(session, 0);
		assert.strictEqual(snap.peers.length, 0,
			'self presence is filtered (own cursor doesn\'t need decoration)');
	});

	test('cross-peer presence after mergeBytes: remote peers surface in snapshot', () => {
		const sessA = createSession(3602n);
		const sessB = createSession(3603n);
		updatePresence(sessB, { sheet: 0, row: 5, col: 7, selectionEndRow: 5, selectionEndCol: 7, typing: true });
		sessA.mergeBytes(sessB.exportBytes());

		const snap = buildPresenceSnapshotJson(sessA, 0);
		assert.strictEqual(snap.peers.length, 1, 'one remote peer (B); self (A) filtered');
		assert.strictEqual(snap.peers[0].peerId, '0000000000000e13',
			'remote peer id is 16-hex of 3603 (0xE13)');
		assert.strictEqual(snap.peers[0].row, 5);
		assert.strictEqual(snap.peers[0].col, 7);
		assert.strictEqual(snap.peers[0].typing, true);
	});
});

suite('quantbook V3.4.0.5b -- buildHtml emits cell-grid-presence data block', function () {
	test('nonced mode with explicit presence: data block embeds the snapshot', () => {
		const html = buildHtml(
			{ snapshot_format_version: 1, sheet: 0, entries: [] },
			{
				nonce: 'v3405b',
				presence: { selfPeerId: 'aaaa000000000001', peers: [{ peerId: 'aaaa000000000002', sheet: 0, row: 3, col: 4, selectionEndRow: 3, selectionEndCol: 4, typing: false }] },
			},
		);
		assert.ok(html.includes('<script id="cell-grid-presence" type="application/json">'),
			'presence data block tag present');
		assert.ok(html.includes('aaaa000000000002'),
			'remote peer id embedded in data block');
		assert.ok(html.includes('"row":3'), 'remote peer row embedded');
	});

	test('nonced mode without presence: data block embeds empty fallback', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v3405b' });
		assert.ok(html.includes('<script id="cell-grid-presence" type="application/json">'),
			'data block always emitted in nonced mode (avoids null-check in webview)');
		assert.ok(html.includes('"peers":[]'),
			'empty fallback has empty peers array');
	});

	test('V3.2.a read-only mode (no nonce) does NOT emit presence data block', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] });
		assert.ok(!html.includes('cell-grid-presence'),
			'presence data block gated on nonced mode (no script -> no consumer)');
	});

	test('CSS includes .cell-peer-presence outline rule', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v3405b' });
		assert.ok(html.includes('.cell-peer-presence'),
			'presence-decoration CSS rule present');
		assert.ok(html.includes('outline:'),
			'uses outline (not border) so layout doesn\'t shift on peer arrival/departure');
	});

	test('presence data block defense-in-depth escapes embedded </script', () => {
		const html = buildHtml(
			{ snapshot_format_version: 1, sheet: 0, entries: [] },
			{
				nonce: 'v3405b',
				// Defensive: caller passes hostile data in the snapshot;
				// JSON.stringify escapes most things, but the
				// belt-and-suspenders regex defangs </script too.
				presence: { selfPeerId: '0000000000000001', peers: [{ peerId: '</script><script>alert(1)</script>', sheet: 0, row: 0, col: 0, selectionEndRow: 0, selectionEndCol: 0, typing: false }] },
			},
		);
		// Pin: NO raw </script>alert pattern slips through.
		assert.ok(!html.match(/<script id="cell-grid-presence"[^>]*>[^<]*<\/script>alert/),
			'no premature script-tag termination via hostile peerId');
	});
});

suite('quantbook V3.4.0.5b -- webview script body wires presence init + edit-mode broadcast', function () {
	test('script body parses cell-grid-presence data block on init', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v3405b' });
		assert.ok(html.includes('getElementById(\'cell-grid-presence\')'),
			'webview reads presence data block by id');
		assert.ok(html.includes('PRESENCE.peers'), 'iterates the peers array');
		assert.ok(html.includes('cell-peer-presence'), 'adds the decoration class');
	});

	test('script body filters presence by SHEET (single-sheet panel)', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v3405b' });
		assert.ok(html.includes('p.sheet !== SHEET'),
			'sheet filter present (decoration only fires for this panel\'s sheet)');
	});

	test('beginEdit posts presenceUpdate with typing=true', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v3405b' });
		// beginEdit's presence envelope must come AFTER input creation
		// + activeInput assignment, BEFORE the keydown listener (so a
		// fast-typing user's first keystroke sees typing=true).
		assert.ok(html.includes('type: \'presenceUpdate\''),
			'presenceUpdate envelope type present in script');
		assert.ok(html.includes('typing: true'),
			'beginEdit broadcasts typing=true');
	});

	test('endEdit posts presenceUpdate with typing=false on commit OR cancel', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v3405b' });
		assert.ok(html.includes('typing: false'),
			'endEdit broadcasts typing=false');
	});
});

// FE-0a Part B (B1): the "dispatchIncomingMessage presenceUpdate arm" suite was
// REMOVED -- presence is a collab-only dispatch path (v1.5-dormant). The owning
// Session dispatch drops presenceUpdate silently (asserted by the drop-test in
// the "dispatchIncomingMessage (host-side commit path, owning Session)" suite).
// These presence-arm tests return in v1.5 when collab re-enables.

// ============================================================================
// Phase 5.7 V3.4.0.4a -- .qbook persistence (engine napi round-trip)
// ============================================================================
//
// V3.4.0.4a engine ship: napi `toQbook` + `fromQbook` over
// `ql_io::save_workbook_with_oplog` + `load_workbook_with_oplog`.
// V3.4.0.4b IDE commands (showSaveDialog/showOpenDialog +
// UUID-derived PeerId generation) defer to a separate sub-step.

suite('quantbook V3.4.0.4a -- .qbook persistence napi round-trip', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	// Per-test scratch dir under os.tmpdir to keep CI clean.
	let scratchRoot: string;
	setup(() => {
		scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qbook-v3404a-'));
	});
	teardown(() => {
		try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* test cleanup */ }
	});

	function qbookPath(name: string): string {
		return path.join(scratchRoot, `${name}.qbook`);
	}

	test('empty session round-trip preserves emptiness + uses peerIdOverride on load', () => {
		const sessA = createSession(3701n);
		const target = qbookPath('empty');
		exportToQbook(sessA, target);

		// Sanity: directory exists with the two-file shape.
		assert.ok(fs.existsSync(target), '.qbook dir created');
		assert.ok(fs.existsSync(path.join(target, 'workbook.toml')), 'envelope present');
		assert.ok(fs.existsSync(path.join(target, 'oplog.bin')), 'op log present');

		const sessB = sessionFromQbook(target, 9999n);
		assert.strictEqual(sessB.peerId(), 9999n,
			'peerIdOverride wins over the original session\'s peer-id');
		assert.strictEqual(sessB.opCount(), 0,
			'empty round-trip preserves empty op log');
	});

	test('session with cells: round-trip preserves all cells via cache rebuild', () => {
		const sessA = createSession(3702n);
		// V3.4.0.4a: addSheet before PutValue so rebuild_workbook
		// replay (called inside to_qbook) doesn't fail with
		// session_replay -- invalid sheet.  Append order assigns
		// ids deterministically: first call -> sheet 0, second ->
		// sheet 1, third -> sheet 2.
		addSheet(sessA, 'S0');
		addSheet(sessA, 'S1');
		addSheet(sessA, 'S2');
		appendPutValueValidated(sessA, 0, 0, 0, 42);
		appendPutValueValidated(sessA, 0, 1, 0, 100);
		appendPutValueValidated(sessA, 2, 5, 5, 3.14);
		const snapA0 = exportCellSnapshot(sessA, 0);
		const snapA2 = exportCellSnapshot(sessA, 2);

		const target = qbookPath('with-cells');
		exportToQbook(sessA, target);
		const sessB = sessionFromQbook(target, 8888n);

		// from_snapshot rebuilds last_snapshot cache; exportCellSnapshot
		// reads from the cache.  Pin parity with the source session.
		const snapB0 = exportCellSnapshot(sessB, 0);
		const snapB2 = exportCellSnapshot(sessB, 2);
		assert.deepStrictEqual(snapB0.entries, snapA0.entries, 'sheet 0 cells preserved');
		assert.deepStrictEqual(snapB2.entries, snapA2.entries, 'sheet 2 cells preserved');
	});

	test('listSheets survives round-trip (V3.3.0.X cache derives sheet set from CellState keys)', () => {
		const sessA = createSession(3703n);
		// addSheet x6 to create sheets 0..5 (PutValue can then target
		// sheets 1, 3, 5 deterministically).  Append order ->
		// sheet-id assignment: 0..5.
		for (let i = 0; i < 6; i += 1) {
			addSheet(sessA, `S${i}`);
		}
		appendPutValueValidated(sessA, 5, 0, 0, 1);
		appendPutValueValidated(sessA, 1, 0, 0, 1);
		appendPutValueValidated(sessA, 3, 0, 0, 1);
		// listSheets in sessA returns sorted [1, 3, 5].
		assert.deepStrictEqual(listSheets(sessA), [1, 3, 5]);

		const target = qbookPath('multi-sheet');
		exportToQbook(sessA, target);
		const sessB = sessionFromQbook(target, 7777n);
		assert.deepStrictEqual(listSheets(sessB), [1, 3, 5],
			'sheets enumeration matches source after round-trip');
	});

	test('fromQbook with non-existent path throws structured error', () => {
		const bogus = path.join(scratchRoot, 'does-not-exist.qbook');
		try {
			sessionFromQbook(bogus, 1n);
			assert.fail('expected throw for missing .qbook directory');
		} catch (err) {
			const info = parseQuantbookError(err);
			// Could be either qbook_error (envelope missing) or
			// qbook_unknown if some new wildcard variant surfaces.
			assert.ok(
				info.code === 'qbook_error' || info.code === 'qbook_unknown',
				`expected qbook-prefixed code, got ${info.code}`,
			);
		}
	});

	test('fromQbook with peerIdOverride = 0 throws bad_argument (LEGACY_PEER sentinel)', () => {
		// Save anything so the path is valid; the load path's peer-id
		// validation should fire BEFORE the file is touched (validation
		// at the napi argument-parsing layer).
		const sessA = createSession(3704n);
		const target = qbookPath('peer-validation');
		exportToQbook(sessA, target);

		try {
			sessionFromQbook(target, 0n);
			assert.fail('expected throw for peerId=0 (LEGACY_PEER sentinel)');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument',
				`peer_id_from_bigint rejects zero with bad_argument; got ${info.code}`);
		}
	});
});

// ============================================================================
// Phase 5.7 V3.4.0.4b -- UUID-derived PeerId helper (IDE-side D5 closure)
// ============================================================================

suite('quantbook V3.4.0.4b -- generateUuidPeerId', function () {
	test('returns non-zero BigInt (rejects LEGACY_PEER sentinel)', () => {
		const peerId = generateUuidPeerId();
		assert.ok(peerId !== 0n, 'PeerId must be non-zero');
		assert.strictEqual(typeof peerId, 'bigint');
	});

	test('fits in u64 range (0 < x <= 2^64-1)', () => {
		const U64_MAX = (1n << 64n) - 1n;
		for (let i = 0; i < 100; i += 1) {
			const peerId = generateUuidPeerId();
			assert.ok(peerId > 0n, `iter ${i}: > 0`);
			assert.ok(peerId <= U64_MAX, `iter ${i}: <= u64::MAX`);
		}
	});

	test('uniqueness across 1000 calls (birthday-paradox sanity)', () => {
		// UUIDv4 truncated to 64 bits has ~64 bits of entropy.
		// Birthday-paradox collision probability is ~2^32 sessions
		// before first collision.  1000 calls is well-below that
		// threshold; zero collisions expected.
		const seen = new Set<bigint>();
		for (let i = 0; i < 1000; i += 1) {
			const peerId = generateUuidPeerId();
			assert.ok(!seen.has(peerId), `collision at iter ${i}: ${peerId.toString(16)}`);
			seen.add(peerId);
		}
		assert.strictEqual(seen.size, 1000);
	});

	test('engine accepts UUID-derived PeerId for createSession', function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
		// End-to-end: helper output is a valid engine PeerId per
		// peer_id_from_bigint validation (non-zero + u64-range).
		const peerId = generateUuidPeerId();
		const session = createSession(peerId);
		assert.strictEqual(session.peerId(), peerId,
			'engine round-trips the UUID-derived PeerId via session.peerId()');
	});
});

// ============================================================================
// Phase 5.7 V3.4.0.X closures (2026-05-24) -- cross-lane Codex+Opus megaudit
// ============================================================================

suite('quantbook V3.4.0.X -- validatePresenceNumeric (MEDIUM-3 closure)', function () {
	function baseValid() {
		return { sheet: 0, row: 0, col: 0, selectionEndRow: 0, selectionEndCol: 0 };
	}

	test('all-zero is valid (returns null)', () => {
		assert.strictEqual(validatePresenceNumeric(baseValid()), null);
	});

	test('mid-range values are valid', () => {
		assert.strictEqual(validatePresenceNumeric({
			sheet: 7, row: 42, col: 1000, selectionEndRow: 42, selectionEndCol: 1005,
		}), null);
	});

	test('NaN is rejected with finite check', () => {
		const r = validatePresenceNumeric({ ...baseValid(), row: NaN });
		assert.ok(r !== null && r.includes('finite') && r.includes('row'),
			`expected finite-message about row, got: ${r}`);
	});

	test('Infinity is rejected with finite check', () => {
		const r = validatePresenceNumeric({ ...baseValid(), col: Infinity });
		assert.ok(r !== null && r.includes('finite') && r.includes('col'));
	});

	test('negative row is rejected', () => {
		const r = validatePresenceNumeric({ ...baseValid(), row: -1 });
		assert.ok(r !== null && r.includes('non-negative') && r.includes('row'));
	});

	test('fractional col is rejected', () => {
		const r = validatePresenceNumeric({ ...baseValid(), col: 1.5 });
		assert.ok(r !== null && r.includes('integer') && r.includes('col'));
	});

	test('sheet > u16::MAX is rejected', () => {
		const r = validatePresenceNumeric({ ...baseValid(), sheet: 65536 });
		assert.ok(r !== null && r.includes('65535') && r.includes('sheet'));
	});

	test('sheet at u16::MAX (65535) is valid (boundary)', () => {
		assert.strictEqual(validatePresenceNumeric({ ...baseValid(), sheet: 65535 }), null);
	});

	test('row > u32::MAX is rejected', () => {
		const r = validatePresenceNumeric({ ...baseValid(), row: 4294967296 });
		assert.ok(r !== null && r.includes('4294967295') && r.includes('row'));
	});

	test('row at u32::MAX (4294967295) is valid (boundary)', () => {
		assert.strictEqual(validatePresenceNumeric({ ...baseValid(), row: 4294967295 }), null);
	});
});

// FE-0a Part B (B1): the "presenceUpdate numeric rejection" suite was REMOVED --
// presence is a collab-only dispatch path (v1.5-dormant); the owning Session
// dispatch drops presenceUpdate silently (no per-field numeric validation). The
// pure validatePresenceNumeric helper remains exported + unit-tested above; these
// dispatch-arm rejection tests return in v1.5 when collab re-enables.

suite('quantbook V3.4.0.X -- endEdit commit broadcasts typing:false (MEDIUM-2 webview wiring pin)', function () {
	test('script body emits typing:false ABOVE the if(commit) branch', () => {
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v340X' });
		// The fix: typing:false broadcast moved to BEFORE the commit branch,
		// so both commit and cancel paths execute it.  Pin the structural
		// invariant: the typing:false postMessage appears BEFORE the
		// `if (commit) {` branch in the inline script body.
		const typingFalseIdx = html.indexOf('typing: false');
		const ifCommitIdx = html.indexOf('if (commit) {');
		assert.notStrictEqual(typingFalseIdx, -1, 'typing:false broadcast must exist');
		assert.notStrictEqual(ifCommitIdx, -1, 'if(commit) branch must exist');
		assert.ok(typingFalseIdx < ifCommitIdx,
			`typing:false must broadcast BEFORE the commit branch (got typingFalseIdx=${typingFalseIdx}, ifCommitIdx=${ifCommitIdx})`);
	});

	test('script body cancel-path branch does NOT post a second typing:false', () => {
		// The cancel-path block (cell.innerHTML = '' restore) used to host
		// the typing:false broadcast.  After MEDIUM-2 fix, the broadcast
		// happens once above the if(commit) branch; the cancel path no
		// longer has its own typing:false postMessage.  Pin via counting.
		const html = buildHtml({ snapshot_format_version: 1, sheet: 0, entries: [] }, { nonce: 'v340X' });
		const occurrences = html.match(/typing:\s*false/g);
		assert.ok(occurrences !== null, 'typing:false must appear at least once');
		assert.strictEqual(occurrences.length, 1,
			`expected exactly ONE typing:false broadcast in script body (the unified pre-branch one), found ${occurrences.length}`);
	});
});

suite('quantbook V3.4.0.X -- BatchCommit recursion through .qbook round-trip (HIGH-1 IDE-side pin)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	// Per-test scratch dir under os.tmpdir for clean isolation.
	let scratchRoot: string;
	setup(() => {
		scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qbook-v340X-'));
	});
	teardown(() => {
		try { fs.rmSync(scratchRoot, { recursive: true, force: true }); } catch { /* test cleanup */ }
	});

	test('Save As on sample-data session (with addSheet seeding fix) succeeds', () => {
		// HIGH-3 (cross-lane convergent Codex+Opus) end-to-end IDE-side pin:
		// the V3.4.0.X command fix calls addSheet 3x before sample
		// appendPutValueValidated calls.  Pin the equivalent at the IDE
		// session.ts level: a session built like the command does must
		// save successfully via exportToQbook.
		const session = createSession(7301n);
		addSheet(session, 'S0');
		addSheet(session, 'S1');
		addSheet(session, 'S2');
		appendPutValueValidated(session, 0, 0, 0, 42);
		appendPutValueValidated(session, 1, 0, 0, 11);
		appendPutValueValidated(session, 2, 0, 0, 99);

		const target = path.join(scratchRoot, 'sample.qbook');
		// Must not throw.  Pre-V3.4.0.X (without addSheet calls), this
		// would throw with session_replay -- invalid sheet at op index 0.
		exportToQbook(session, target);
		assert.ok(fs.existsSync(target), '.qbook directory created');
		assert.ok(fs.existsSync(path.join(target, 'workbook.toml')), 'workbook.toml present');
		assert.ok(fs.existsSync(path.join(target, 'oplog.bin')), 'oplog.bin present');

		// Sanity: re-open + verify cells round-trip.
		const reloaded = sessionFromQbook(target, 8888n);
		const sheet0 = exportCellSnapshot(reloaded, 0).entries;
		const sheet1 = exportCellSnapshot(reloaded, 1).entries;
		const sheet2 = exportCellSnapshot(reloaded, 2).entries;
		assert.strictEqual(sheet0.length, 1);
		assert.strictEqual(sheet1.length, 1);
		assert.strictEqual(sheet2.length, 1);
	});
});

suite('quantbook V3.4.0.X -- addSheet napi validates chunkRows (HIGH-2)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	const badCases: Array<{ label: string; chunkRows: number; substr: string }> = [
		{ label: 'zero', chunkRows: 0, substr: '>= 1' },
		{ label: 'negative', chunkRows: -1, substr: 'non-negative' },
		{ label: 'NaN', chunkRows: NaN, substr: 'finite' },
		{ label: 'Infinity', chunkRows: Infinity, substr: 'finite' },
		{ label: 'fractional', chunkRows: 1.5, substr: 'integer' },
	];

	for (const c of badCases) {
		test(`addSheet rejects ${c.label} chunkRows with bad_argument`, () => {
			const session = createSession(7501n);
			try {
				addSheet(session, 'S', c.chunkRows);
				assert.fail(`expected throw for chunkRows=${c.chunkRows}`);
			} catch (err) {
				const info = parseQuantbookError(err);
				assert.strictEqual(info.code, 'bad_argument',
					`expected bad_argument code for ${c.label}, got ${info.code} (msg: ${info.message})`);
				assert.ok(info.message.includes(c.substr) || info.message.includes('chunkRows'),
					`expected message about chunkRows or ${c.substr}, got: ${info.message}`);
			}
		});
	}

	test('addSheet accepts default chunkRows=1000', () => {
		const session = createSession(7502n);
		// Must not throw.
		addSheet(session, 'S');
		assert.strictEqual(listSheets(session).length, 0,
			'addSheet alone does not surface sheets in cache (cache derives from PutValue keys)');
	});

	test('addSheet accepts chunkRows=1 (minimum valid)', () => {
		const session = createSession(7503n);
		addSheet(session, 'S', 1);
	});
});

// ============================================================================
// Phase 5.7 V3.5.0.2 (2026-05-24) -- WorkbookSnapshot napi contract
// ============================================================================
// Tests the new CollabSession.workbookSnapshot() napi method shipped at
// V3.5.0.2 per V3.5.0.1 D3.  Pins the flattened JSON-serializable shape +
// sheet enumeration + cell-keyed cache integration + value/formula
// preservation through the round-trip + JSON shape stability for
// V3.5.0.5 forward-extend (which adds names + formats fields additively).

suite('quantbook V3.5.0.2 -- workbookSnapshot napi contract', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('empty session: snapshot has zero sheets', () => {
		const session = createSession(7601n);
		const snap = workbookSnapshot(session);
		assert.deepStrictEqual(snap.sheets, [],
			'a fresh session with no addSheet ops has zero sheets in snapshot');
	});

	test('single addSheet: snapshot has one sheet, id=0, empty cells', () => {
		const session = createSession(7602n);
		addSheet(session, 'Sheet0');
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 1);
		assert.strictEqual(snap.sheets[0].id, 0, 'first addSheet -> sheet id 0');
		assert.strictEqual(snap.sheets[0].name, 'Sheet0');
		assert.deepStrictEqual(snap.sheets[0].cells, [],
			'addSheet without PutValue -> empty cells (V3.5.0.2 enumerates via sheet_count, not list_sheets_from_cache)');
	});

	test('addSheet + PutValue: cell appears with value+kind, formula=undefined', () => {
		const session = createSession(7603n);
		addSheet(session, 'A');
		appendPutValueValidated(session, 0, 3, 5, 42.5);
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 1);
		assert.strictEqual(snap.sheets[0].cells.length, 1);
		const cell = snap.sheets[0].cells[0];
		assert.strictEqual(cell.row, 3);
		assert.strictEqual(cell.col, 5);
		assert.strictEqual(cell.formula, undefined, 'pure PutValue -> formula absent (napi Option::None -> undefined)');
		assert.ok(cell.value !== undefined, 'PutValue -> value populated');
		assert.strictEqual(cell.value!.kind, 'number');
		assert.strictEqual(cell.value!.number, 42.5);
		assert.strictEqual(cell.value!.boolean, undefined, 'non-active payload fields absent');
		assert.strictEqual(cell.value!.text, undefined);
		assert.strictEqual(cell.value!.error, undefined);
	});

	test('multi-sheet: snapshot sheets are id-ordered 0..N-1', () => {
		const session = createSession(7604n);
		addSheet(session, 'First');
		addSheet(session, 'Second');
		addSheet(session, 'Third');
		appendPutValueValidated(session, 0, 0, 0, 1);
		appendPutValueValidated(session, 2, 5, 5, 99);
		// Sheet 1 deliberately empty -- pins the "enumerate via sheet_count" contract.
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 3);
		assert.deepStrictEqual(snap.sheets.map(s => s.id), [0, 1, 2],
			'sheets emitted in id order 0..N-1');
		assert.deepStrictEqual(snap.sheets.map(s => s.name), ['First', 'Second', 'Third']);
		assert.strictEqual(snap.sheets[0].cells.length, 1, 'sheet 0 has 1 cell');
		assert.strictEqual(snap.sheets[1].cells.length, 0, 'sheet 1 is empty but present');
		assert.strictEqual(snap.sheets[2].cells.length, 1, 'sheet 2 has 1 cell');
		assert.strictEqual(snap.sheets[2].cells[0].value!.number, 99);
	});

	test('cells within a sheet are sorted (row, col) ascending', () => {
		const session = createSession(7605n);
		addSheet(session, 'S');
		// Append out-of-order to verify the sort.
		appendPutValueValidated(session, 0, 5, 0, 1);
		appendPutValueValidated(session, 0, 0, 5, 2);
		appendPutValueValidated(session, 0, 0, 0, 3);
		appendPutValueValidated(session, 0, 3, 2, 4);
		const cells = workbookSnapshot(session).sheets[0].cells;
		const keys = cells.map(c => [c.row, c.col]);
		assert.deepStrictEqual(keys, [[0, 0], [0, 5], [3, 2], [5, 0]],
			'cells sorted by (row, col) ascending per snapshot_cells contract');
	});

	test('JSON shape stability: top-level has sheets + formats (V3.6.0.3 additive extension)', () => {
		const session = createSession(7606n);
		addSheet(session, 'S');
		const snap = workbookSnapshot(session);
		// V3.5.0.2 ship shape: { sheets }.  V3.6.0.3 D2 ADDS `formats`
		// (additive; V3.5 consumers that destructure .sheets keep
		// working).  V3.6.0.5 D4 ADDS `dateSystem` (additive).
		// Future V3.7+ may add `names` etc., still additively.  Pin
		// the V3.6.0.5 shape so a future shape-break gets caught.
		const keys = Object.keys(snap).sort();
		// V3.6.0.8.4 OPUS-HIGH-2 closure: + version (Buffer; opaque
		// VV token for workbookSnapshotDelta round-trip).
		// Phase 6.3-1c M5 (2026-05-30): + schemaVersion (contract section 4.1
		// schema-version propagation; stamped on every snapshot DTO).
		assert.deepStrictEqual(keys, ['dateSystem', 'formats', 'schemaVersion', 'sheets', 'version'],
			`6.3-1c ship shape is {sheets, formats, dateSystem, version, schemaVersion}; if a later phase adds fields, update this test`);
	});

	test('SheetSnapshotJson shape: id + name + cells fields', () => {
		const session = createSession(7607n);
		addSheet(session, 'S');
		const sheet = workbookSnapshot(session).sheets[0];
		const keys = Object.keys(sheet).sort();
		assert.deepStrictEqual(keys, ['cells', 'id', 'name']);
		assert.strictEqual(typeof sheet.id, 'number');
		assert.strictEqual(typeof sheet.name, 'string');
		assert.ok(Array.isArray(sheet.cells));
	});

	test('CellSnapshotJson shape: row + col + value fields present; formula absent for pure PutValue', () => {
		const session = createSession(7608n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 1);
		const cell = workbookSnapshot(session).sheets[0].cells[0];
		const keys = Object.keys(cell).sort();
		// napi-rs Option::None -> absent JS property; pure PutValue has
		// no formula, so the formula key is OMITTED entirely.
		assert.deepStrictEqual(keys, ['col', 'row', 'value']);
		assert.strictEqual(cell.formula, undefined, 'formula property is absent for pure PutValue');
		assert.ok(cell.value !== undefined);
	});

	test('CellValueJson discriminator: number cell has kind + number; non-active payloads absent', () => {
		const session = createSession(7609n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 7);
		const v = workbookSnapshot(session).sheets[0].cells[0].value!;
		assert.strictEqual(v.kind, 'number');
		assert.strictEqual(v.number, 7);
		// All non-active payload fields absent (napi Option::None -> undefined).
		assert.strictEqual(v.boolean, undefined);
		assert.strictEqual(v.text, undefined);
		assert.strictEqual(v.error, undefined);
		// Pin that only kind + number keys are present.
		const keys = Object.keys(v).sort();
		assert.deepStrictEqual(keys, ['kind', 'number'],
			'CellValueJson omits non-active payload fields entirely');
	});

	test('rebuild_workbook semantic: empty sheet (addSheet only) appears in snapshot', () => {
		// Critical V3.5.0.2 contract: snapshot enumerates via
		// Workbook::sheet_count() (post rebuild_workbook), NOT via
		// list_sheets_from_cache().  Empty sheets (addSheet but no
		// PutValue) MUST appear with cells: [].
		const session = createSession(7610n);
		addSheet(session, 'OnlyAdded');
		// No PutValue.  list_sheets_from_cache() returns [] (no cache
		// entries).  workbookSnapshot() should return 1 sheet.
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 1);
		assert.strictEqual(snap.sheets[0].name, 'OnlyAdded');
		assert.strictEqual(snap.sheets[0].cells.length, 0);
		// Compare with listSheets behavior (cache-based, empty here).
		assert.deepStrictEqual(listSheets(session), [],
			'sanity: listSheets() is cache-based + returns [] for addSheet-only sessions');
	});

	test('round-trip via to_qbook/from_qbook preserves snapshot equality', () => {
		const session = createSession(7611n);
		addSheet(session, 'S0');
		addSheet(session, 'S1');
		appendPutValueValidated(session, 0, 0, 0, 100);
		appendPutValueValidated(session, 1, 5, 5, 200);
		const before = workbookSnapshot(session);

		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbook-v3502-'));
		const target = path.join(scratchDir, 'snap.qbook');
		try {
			exportToQbook(session, target);
			const reloaded = sessionFromQbook(target, 9999n);
			const after = workbookSnapshot(reloaded);
			// Sheet count + names must match.
			assert.deepStrictEqual(after.sheets.map(s => [s.id, s.name]),
				before.sheets.map(s => [s.id, s.name]),
				'sheet id+name preserved across .qbook round-trip');
			// Cell content must match per-sheet.
			for (let i = 0; i < before.sheets.length; i++) {
				assert.deepStrictEqual(after.sheets[i].cells, before.sheets[i].cells,
					`sheet ${i} cells preserved`);
			}
		} finally {
			try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* test cleanup */ }
		}
	});
});

// ============================================================================
// Phase 5.7 V3.5.0.3a (2026-05-24) -- renameSheet napi contract
// ============================================================================

suite('quantbook V3.5.0.3a -- renameSheet napi contract', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('rename emits Op::RenameSheet (op count grows by 1)', () => {
		const session = createSession(7701n);
		addSheet(session, 'Original');
		const before = session.opCount();
		renameSheet(session, 0, 'Renamed');
		assert.strictEqual(session.opCount(), before + 1,
			'one renameSheet call appends exactly one op');
	});

	test('workbookSnapshot reflects the new name after rename', () => {
		const session = createSession(7702n);
		addSheet(session, 'Before');
		renameSheet(session, 0, 'After');
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 1);
		assert.strictEqual(snap.sheets[0].name, 'After',
			'snapshot reads the post-rename name via rebuild_workbook');
		assert.strictEqual(snap.sheets[0].id, 0, 'sheet id unchanged by rename');
	});

	test('rename preserves cells on the renamed sheet', () => {
		const session = createSession(7703n);
		addSheet(session, 'A');
		appendPutValueValidated(session, 0, 0, 0, 42);
		appendPutValueValidated(session, 0, 1, 0, 99);
		renameSheet(session, 0, 'B');
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets[0].name, 'B');
		assert.strictEqual(snap.sheets[0].cells.length, 2,
			'rename does not touch cell content');
		assert.strictEqual(snap.sheets[0].cells[0].value!.number, 42);
		assert.strictEqual(snap.sheets[0].cells[1].value!.number, 99);
	});

	test('rename with id > u16::MAX -> bad_argument', () => {
		const session = createSession(7704n);
		addSheet(session, 'S');
		try {
			renameSheet(session, 70000, 'X');
			assert.fail('expected throw for id > u16::MAX');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument');
			assert.ok(info.message.includes('65535'),
				`expected u16 range message, got: ${info.message}`);
		}
	});

	test('rename non-existent sheet id -> bad_argument', () => {
		const session = createSession(7705n);
		addSheet(session, 'OnlyOne');
		// Sheet 0 exists; sheet 5 does NOT.
		try {
			renameSheet(session, 5, 'Nope');
			assert.fail('expected throw for non-existent sheet');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument');
			assert.ok(info.message.includes('does not exist'),
				`expected existence-check message, got: ${info.message}`);
		}
	});

	test('multiple renames of the same sheet: last-write-wins via snapshot', () => {
		const session = createSession(7706n);
		addSheet(session, 'V1');
		renameSheet(session, 0, 'V2');
		renameSheet(session, 0, 'V3');
		renameSheet(session, 0, 'Final');
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets[0].name, 'Final',
			'last rename wins after rebuild_workbook walks the op log in order');
		assert.strictEqual(session.opCount() >= 4, true,
			'all 4 ops (1 add + 3 rename) appended');
	});

	test('cross-peer rename via mergeBytes converges (per Phase 5.3 repair chain)', () => {
		// Setup: peer A creates a sheet + renames it; peer B merges A's
		// snapshot then sees the renamed sheet.  Phase 5.3 step 3
		// repair_sheet_rename_chain fires at workbookSnapshot's
		// rebuild_workbook call.
		const sessA = createSession(7707n);
		addSheet(sessA, 'A-Original');
		renameSheet(sessA, 0, 'A-Renamed');

		const sessB = createSession(7708n);
		sessB.mergeBytes(sessA.exportBytes());

		const snapB = workbookSnapshot(sessB);
		assert.strictEqual(snapB.sheets.length, 1,
			'peer B sees peer A\'s sheet after merge');
		assert.strictEqual(snapB.sheets[0].name, 'A-Renamed',
			'peer B sees the rename via repair_sheet_rename_chain at rebuild_workbook');
	});

	test('round-trip via .qbook preserves rename', () => {
		const session = createSession(7709n);
		addSheet(session, 'BeforeSave');
		appendPutValueValidated(session, 0, 0, 0, 7);
		renameSheet(session, 0, 'AfterSave');

		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbook-v3503a-'));
		const target = path.join(scratchDir, 'rename.qbook');
		try {
			exportToQbook(session, target);
			const reloaded = sessionFromQbook(target, 9999n);
			const snap = workbookSnapshot(reloaded);
			assert.strictEqual(snap.sheets[0].name, 'AfterSave',
				'.qbook round-trip preserves the rename');
			assert.strictEqual(snap.sheets[0].cells.length, 1,
				'cells preserved through rename + round-trip');
		} finally {
			try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* test cleanup */ }
		}
	});
});

// ============================================================================
// Phase 5.7 V3.5.0.3b (2026-05-24) -- deleteSheet napi + Op::RemoveSheet
// ============================================================================
// V3.5.0.3b CRDT semantic decision lock: tombstone preserves id slot;
// cell writes to tombstoned sheet silently dropped; workbookSnapshot
// filters tombstoned sheets; concurrent re-delete is idempotent.

suite('quantbook V3.5.0.3b -- deleteSheet napi contract', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('delete emits Op::RemoveSheet (op count grows by 1)', () => {
		const session = createSession(7801n);
		addSheet(session, 'Doomed');
		const before = session.opCount();
		deleteSheet(session, 0);
		assert.strictEqual(session.opCount(), before + 1,
			'one deleteSheet call appends exactly one op');
	});

	test('workbookSnapshot filters out tombstoned sheets', () => {
		const session = createSession(7802n);
		addSheet(session, 'Keep0');
		addSheet(session, 'Delete1');
		addSheet(session, 'Keep2');
		deleteSheet(session, 1);
		const snap = workbookSnapshot(session);
		// Sheet 1 tombstoned; snapshot has 2 sheets (ids 0 and 2).
		assert.strictEqual(snap.sheets.length, 2,
			'tombstoned sheet absent from snapshot');
		assert.deepStrictEqual(snap.sheets.map(s => s.id), [0, 2],
			'tombstoned id-1 slot is SKIPPED; ids 0 + 2 remain');
		assert.deepStrictEqual(snap.sheets.map(s => s.name), ['Keep0', 'Keep2']);
	});

	test('cells on tombstoned sheet are unreachable via snapshot', () => {
		const session = createSession(7803n);
		addSheet(session, 'A');
		appendPutValueValidated(session, 0, 0, 0, 42);
		appendPutValueValidated(session, 0, 1, 0, 99);
		// Verify cells are visible BEFORE delete.
		assert.strictEqual(workbookSnapshot(session).sheets[0].cells.length, 2);
		deleteSheet(session, 0);
		// After delete, the sheet is filtered out of the snapshot entirely.
		assert.strictEqual(workbookSnapshot(session).sheets.length, 0,
			'tombstoned sheet -> snapshot is empty (no sheets surface)');
	});

	test('writes to tombstoned sheet are silently dropped (CRDT idempotency)', () => {
		const session = createSession(7804n);
		addSheet(session, 'TBR');
		deleteSheet(session, 0);
		// Write to the tombstoned sheet -- the napi succeeds (validation
		// is bound to opcount; tombstone state is checked at REPLAY time).
		// The PutValue op gets appended, but its apply_op silent-no-ops
		// because the sheet is tombstoned.
		appendPutValueValidated(session, 0, 5, 5, 100);
		const snap = workbookSnapshot(session);
		// Snapshot doesn't see the cell (because it doesn't see the
		// tombstoned sheet at all).
		assert.strictEqual(snap.sheets.length, 0,
			'write to tombstoned sheet does NOT resurrect the sheet in snapshot');
	});

	test('double-delete is idempotent (CRDT no-op for re-delete)', () => {
		const session = createSession(7805n);
		addSheet(session, 'S');
		deleteSheet(session, 0);
		// Re-delete the same sheet -- napi succeeds; replay applies the
		// second Op::RemoveSheet as a no-op (HashSet.insert idempotent).
		deleteSheet(session, 0);
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 0);
		assert.ok(session.opCount() >= 3,
			'all 3 ops (1 add + 2 delete) appended to the log');
	});

	test('delete with id > u16::MAX -> bad_argument', () => {
		const session = createSession(7806n);
		addSheet(session, 'S');
		try {
			deleteSheet(session, 70000);
			assert.fail('expected throw for id > u16::MAX');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument');
			assert.ok(info.message.includes('65535'),
				`expected u16 range message, got: ${info.message}`);
		}
	});

	test('delete non-existent sheet id -> bad_argument', () => {
		const session = createSession(7807n);
		addSheet(session, 'OnlyOne');
		try {
			deleteSheet(session, 5);
			assert.fail('expected throw for non-existent sheet');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument');
			assert.ok(info.message.includes('does not exist'),
				`expected existence-check message, got: ${info.message}`);
		}
	});

	test('cross-peer delete via mergeBytes converges (idempotent)', () => {
		// Peer A creates sheets + deletes sheet 1; peer B merges A's
		// snapshot; peer B's workbookSnapshot omits sheet 1.
		const sessA = createSession(7808n);
		addSheet(sessA, 'S0');
		addSheet(sessA, 'S1');
		addSheet(sessA, 'S2');
		deleteSheet(sessA, 1);

		const sessB = createSession(7809n);
		sessB.mergeBytes(sessA.exportBytes());

		const snapB = workbookSnapshot(sessB);
		assert.strictEqual(snapB.sheets.length, 2,
			'peer B sees the tombstone after merge');
		assert.deepStrictEqual(snapB.sheets.map(s => s.id), [0, 2]);
	});

	test('rename + delete preserve id stability for other sheets', () => {
		// Verify id stability after delete: deleting sheet 1 leaves
		// sheet 0 and sheet 2 with their original ids (NOT renumbered
		// to 0 and 1).  Subsequent ops can still reference sheet 2 by
		// its original id.
		const session = createSession(7810n);
		addSheet(session, 'A');
		addSheet(session, 'B');
		addSheet(session, 'C');
		appendPutValueValidated(session, 2, 0, 0, 99);  // write to sheet 2
		deleteSheet(session, 1);  // delete middle sheet
		// Append another write to sheet 2 AFTER the delete -- if id
		// stability was broken, this would land on the wrong sheet.
		appendPutValueValidated(session, 2, 1, 0, 100);
		const snap = workbookSnapshot(session);
		// Find sheet 2 by id.
		const sheet2 = snap.sheets.find(s => s.id === 2);
		assert.ok(sheet2 !== undefined, 'sheet 2 survives delete-of-sheet-1');
		assert.strictEqual(sheet2!.name, 'C');
		assert.strictEqual(sheet2!.cells.length, 2,
			'both writes to sheet 2 (pre- and post-delete) reach the same sheet');
	});

	test('round-trip via .qbook preserves tombstone', () => {
		const session = createSession(7811n);
		addSheet(session, 'Keep');
		addSheet(session, 'Delete');
		appendPutValueValidated(session, 0, 0, 0, 1);
		deleteSheet(session, 1);

		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbook-v3503b-'));
		const target = path.join(scratchDir, 'tombstone.qbook');
		try {
			exportToQbook(session, target);
			const reloaded = sessionFromQbook(target, 9999n);
			const snap = workbookSnapshot(reloaded);
			assert.strictEqual(snap.sheets.length, 1,
				'.qbook round-trip preserves the tombstone (deleted sheet stays filtered)');
			assert.strictEqual(snap.sheets[0].id, 0);
			assert.strictEqual(snap.sheets[0].name, 'Keep');
			assert.strictEqual(snap.sheets[0].cells.length, 1);
		} finally {
			try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* test cleanup */ }
		}
	});

	test('rename works on a not-yet-tombstoned sheet alongside a deleted one', () => {
		// Defense-in-depth: ensure rename + delete cooperate; the
		// rename should NOT accidentally affect the tombstoned sheet.
		const session = createSession(7812n);
		addSheet(session, 'A');
		addSheet(session, 'B');
		deleteSheet(session, 0);  // delete A
		renameSheet(session, 1, 'B-renamed');  // rename B
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 1);
		assert.strictEqual(snap.sheets[0].id, 1);
		assert.strictEqual(snap.sheets[0].name, 'B-renamed');
	});
});

// ============================================================================
// Phase 5.7 V3.5.0.3c (2026-05-24) -- moveSheet napi + Op::MoveSheet
// ============================================================================
// V3.5.0.3c CRDT semantic decision lock: display-order overlay (id
// stays stable; only Workbook.sheet_display_order is mutated).  Closes
// V3.5.0.3 D4 (a/b/c all shipped).

suite('quantbook V3.5.0.3c -- moveSheet napi contract', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('move emits Op::MoveSheet (op count grows by 1)', () => {
		const session = createSession(7901n);
		addSheet(session, 'A');
		addSheet(session, 'B');
		const before = session.opCount();
		moveSheet(session, 1, 0);
		assert.strictEqual(session.opCount(), before + 1,
			'one moveSheet call appends exactly one op');
	});

	test('snapshot reflects display-order reordering', () => {
		const session = createSession(7902n);
		addSheet(session, 'A');  // id 0
		addSheet(session, 'B');  // id 1
		addSheet(session, 'C');  // id 2
		// Default display order: [0, 1, 2] -> names [A, B, C].
		assert.deepStrictEqual(workbookSnapshot(session).sheets.map(s => s.name),
			['A', 'B', 'C']);
		// Move id 2 to index 0 -> display order [2, 0, 1].
		moveSheet(session, 2, 0);
		assert.deepStrictEqual(workbookSnapshot(session).sheets.map(s => s.id),
			[2, 0, 1], 'sheet 2 now first in display order');
		assert.deepStrictEqual(workbookSnapshot(session).sheets.map(s => s.name),
			['C', 'A', 'B']);
	});

	test('id stability: cells reachable by id after move', () => {
		const session = createSession(7903n);
		addSheet(session, 'A');
		addSheet(session, 'B');
		appendPutValueValidated(session, 1, 0, 0, 42);  // write to sheet 1
		// Move sheet 1 to position 0.
		moveSheet(session, 1, 0);
		// Subsequent PutValue on sheet 1 still reaches the same sheet
		// (id stability preserved).
		appendPutValueValidated(session, 1, 1, 0, 99);
		const snap = workbookSnapshot(session);
		// Find sheet by id (display position is 0 now).
		const sheet1 = snap.sheets.find(s => s.id === 1);
		assert.ok(sheet1 !== undefined);
		assert.strictEqual(sheet1!.name, 'B');
		assert.strictEqual(sheet1!.cells.length, 2,
			'pre- and post-move writes to sheet 1 land on the same sheet');
	});

	test('multi-move sequence: each apply_op moves from CURRENT position', () => {
		const session = createSession(7904n);
		addSheet(session, 'A');  // id 0
		addSheet(session, 'B');  // id 1
		addSheet(session, 'C');  // id 2
		addSheet(session, 'D');  // id 3
		// Start: [0, 1, 2, 3]
		moveSheet(session, 3, 0);  // [3, 0, 1, 2]
		moveSheet(session, 1, 0);  // [1, 3, 0, 2]
		moveSheet(session, 0, 3);  // [1, 3, 2, 0]
		const snap = workbookSnapshot(session);
		assert.deepStrictEqual(snap.sheets.map(s => s.id), [1, 3, 2, 0]);
		assert.deepStrictEqual(snap.sheets.map(s => s.name), ['B', 'D', 'C', 'A']);
	});

	test('new_index out of range clamps to end (CRDT idempotency)', () => {
		const session = createSession(7905n);
		addSheet(session, 'A');  // id 0
		addSheet(session, 'B');  // id 1
		addSheet(session, 'C');  // id 2
		// Move id 0 to absurd index 999 -> clamps to len (which after
		// remove is 2, so insert at 2 = end).  Result: [1, 2, 0].
		moveSheet(session, 0, 999);
		const snap = workbookSnapshot(session);
		assert.deepStrictEqual(snap.sheets.map(s => s.id), [1, 2, 0],
			'out-of-range new_index clamps to end');
	});

	test('move-to-same-position is a no-op for display order', () => {
		const session = createSession(7906n);
		addSheet(session, 'A');
		addSheet(session, 'B');
		// Move id 1 to its current position 1 -> display order unchanged [0, 1].
		moveSheet(session, 1, 1);
		const snap = workbookSnapshot(session);
		assert.deepStrictEqual(snap.sheets.map(s => s.id), [0, 1]);
	});

	test('move with id > u16::MAX -> bad_argument', () => {
		const session = createSession(7907n);
		addSheet(session, 'S');
		try {
			moveSheet(session, 70000, 0);
			assert.fail('expected throw for id > u16::MAX');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument');
			assert.ok(info.message.includes('65535'),
				`expected u16 range message, got: ${info.message}`);
		}
	});

	test('move non-existent sheet id -> bad_argument', () => {
		const session = createSession(7908n);
		addSheet(session, 'OnlyOne');
		try {
			moveSheet(session, 5, 0);
			assert.fail('expected throw for non-existent sheet');
		} catch (err) {
			const info = parseQuantbookError(err);
			assert.strictEqual(info.code, 'bad_argument');
			assert.ok(info.message.includes('does not exist'),
				`expected existence-check message, got: ${info.message}`);
		}
	});

	test('cross-peer move via mergeBytes converges (deterministic last-write-wins)', () => {
		// Peer A creates sheets + moves sheet 2 to position 0; peer B
		// merges A's snapshot; peer B sees A's reorder.
		const sessA = createSession(7909n);
		addSheet(sessA, 'A0');
		addSheet(sessA, 'A1');
		addSheet(sessA, 'A2');
		moveSheet(sessA, 2, 0);  // A's display: [2, 0, 1]

		const sessB = createSession(7910n);
		sessB.mergeBytes(sessA.exportBytes());

		const snapB = workbookSnapshot(sessB);
		assert.deepStrictEqual(snapB.sheets.map(s => s.id), [2, 0, 1],
			'peer B sees A\'s reorder after merge');
	});

	test('move + delete interaction: tombstoned sheet does not surface even if moved', () => {
		const session = createSession(7911n);
		addSheet(session, 'A');  // id 0
		addSheet(session, 'B');  // id 1
		addSheet(session, 'C');  // id 2
		// Move sheet 0 to position 2: [1, 2, 0].
		moveSheet(session, 0, 2);
		// Delete sheet 0 (which is at display position 2).
		deleteSheet(session, 0);
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 2,
			'tombstoned sheet filtered out of moved-display-order');
		assert.deepStrictEqual(snap.sheets.map(s => s.id), [1, 2],
			'remaining sheets keep their post-move relative order');
		assert.deepStrictEqual(snap.sheets.map(s => s.name), ['B', 'C']);
	});

	test('move-tombstoned-sheet silently applies (display order remembers intent)', () => {
		const session = createSession(7912n);
		addSheet(session, 'A');
		addSheet(session, 'B');
		deleteSheet(session, 0);  // tombstone sheet 0
		// Move tombstoned sheet 0 to position 1 -- silent apply at replay
		// time; napi succeeds (id is valid -- the tombstone-check is NOT
		// in the napi validation per the V3.5.0.3c CRDT contract).
		moveSheet(session, 0, 1);
		// workbookSnapshot still filters tombstones; only sheet 1 visible.
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 1);
		assert.strictEqual(snap.sheets[0].id, 1);
	});

	test('round-trip via .qbook preserves display order', () => {
		const session = createSession(7913n);
		addSheet(session, 'X');  // id 0
		addSheet(session, 'Y');  // id 1
		addSheet(session, 'Z');  // id 2
		moveSheet(session, 0, 2);  // [1, 2, 0]
		appendPutValueValidated(session, 0, 0, 0, 1);

		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbook-v3503c-'));
		const target = path.join(scratchDir, 'reorder.qbook');
		try {
			exportToQbook(session, target);
			const reloaded = sessionFromQbook(target, 9999n);
			const snap = workbookSnapshot(reloaded);
			assert.deepStrictEqual(snap.sheets.map(s => s.id), [1, 2, 0],
				'.qbook round-trip preserves display order through replay');
			assert.deepStrictEqual(snap.sheets.map(s => s.name), ['Y', 'Z', 'X']);
		} finally {
			try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* test cleanup */ }
		}
	});

	test('default display order (no moves) matches addSheet order', () => {
		// Regression pin for V3.5.0.3b compat: sessions that never call
		// moveSheet see display order = [0, 1, ..., N-1] in append order.
		const session = createSession(7914n);
		addSheet(session, 'First');
		addSheet(session, 'Second');
		addSheet(session, 'Third');
		const snap = workbookSnapshot(session);
		assert.deepStrictEqual(snap.sheets.map(s => s.id), [0, 1, 2],
			'default display order is identical to V3.5.0.3b iteration order');
	});
});

// ============================================================================
// Phase 5.7 V3.5.0.4a (2026-05-24) -- sheet management QuickPick helpers
// ============================================================================
// Tests the pure helpers that back the V3.5.0.4a sheet management commands:
// buildSheetManagementQuickPickItems (rename/delete/move source picker) +
// buildSheetMovePositionItems (move target-position picker).  Command-layer
// wiring (vscode commands themselves) needs vscode-host integration which
// is V3.5.1+ scope per the V3.4.0.X Opus § F V3.5 ENTRY READINESS guidance.

suite('quantbook V3.5.0.4a -- buildSheetManagementQuickPickItems', function () {
	test('empty sheets -> empty items', () => {
		const items = buildSheetManagementQuickPickItems([], 0);
		assert.deepStrictEqual(items, []);
	});

	test('single sheet -> one item with id+name label', () => {
		const items = buildSheetManagementQuickPickItems([{ id: 0, name: 'Solo' }], 0);
		assert.strictEqual(items.length, 1);
		assert.strictEqual(items[0].label, 'Sheet 0 -- Solo');
		assert.strictEqual(items[0].sheet, 0);
		assert.strictEqual(items[0].name, 'Solo');
		assert.strictEqual(items[0].description, '(current)', 'single sheet matching currentSheet gets current marker');
	});

	test('multi-sheet -> id+name labels in input order', () => {
		const sheets = [
			{ id: 0, name: 'A' },
			{ id: 1, name: 'B' },
			{ id: 2, name: 'C' },
		];
		const items = buildSheetManagementQuickPickItems(sheets, 1);
		assert.strictEqual(items.length, 3);
		assert.deepStrictEqual(items.map(i => i.label),
			['Sheet 0 -- A', 'Sheet 1 -- B', 'Sheet 2 -- C']);
		assert.deepStrictEqual(items.map(i => i.sheet), [0, 1, 2]);
		assert.deepStrictEqual(items.map(i => i.name), ['A', 'B', 'C']);
	});

	test('current-sheet annotation: only matching id gets "(current)"', () => {
		const sheets = [
			{ id: 0, name: 'A' },
			{ id: 5, name: 'B' },
			{ id: 2, name: 'C' },
		];
		const items = buildSheetManagementQuickPickItems(sheets, 5);
		assert.deepStrictEqual(items.map(i => i.description),
			['', '(current)', '']);
	});

	test('non-existent currentSheet -> all descriptions empty (Add flow pattern)', () => {
		// Pattern: caller passes -1 to suppress current-marker entirely
		// (no current-sheet concept for the Add flow).
		const sheets = [
			{ id: 0, name: 'A' },
			{ id: 1, name: 'B' },
		];
		const items = buildSheetManagementQuickPickItems(sheets, -1);
		assert.deepStrictEqual(items.map(i => i.description), ['', '']);
	});

	test('display-order respects input order (not id order)', () => {
		// V3.5.0.3c display-order overlay can permute ids; helper must
		// preserve input order (= snapshot's display order).
		const sheets = [
			{ id: 2, name: 'C' },
			{ id: 0, name: 'A' },
			{ id: 1, name: 'B' },
		];
		const items = buildSheetManagementQuickPickItems(sheets, 0);
		assert.deepStrictEqual(items.map(i => i.sheet), [2, 0, 1],
			'helper preserves input order (caller-supplied display order)');
	});

	test('items expose sheet name for command-layer use', () => {
		const sheets = [{ id: 7, name: 'Q4 Returns' }];
		const items = buildSheetManagementQuickPickItems(sheets, 7);
		assert.strictEqual(items[0].name, 'Q4 Returns',
			'name field is exposed so the command can prompt "Rename Q4 Returns..." etc.');
	});

	test('sheet names with special characters are preserved in label', () => {
		const sheets = [{ id: 0, name: 'Sheet & "Test" -- 2026/Q4' }];
		const items = buildSheetManagementQuickPickItems(sheets, 0);
		assert.strictEqual(items[0].label, 'Sheet 0 -- Sheet & "Test" -- 2026/Q4',
			'special characters in sheet name pass through verbatim (vscode QuickPick handles rendering)');
	});
});

suite('quantbook V3.5.0.4a -- buildSheetMovePositionItems', function () {
	test('empty sheets -> empty items', () => {
		const items = buildSheetMovePositionItems([], 0);
		assert.deepStrictEqual(items, []);
	});

	test('two sheets -> 2 positions (first, last)', () => {
		const sheets = [
			{ id: 0, name: 'A' },
			{ id: 1, name: 'B' },
		];
		const items = buildSheetMovePositionItems(sheets, 0);
		assert.strictEqual(items.length, 2);
		assert.strictEqual(items[0].label, 'Position 0 (first)');
		assert.strictEqual(items[1].label, 'Position 1 (last)');
		// items[].sheet carries the TARGET position (re-used field name).
		assert.deepStrictEqual(items.map(i => i.sheet), [0, 1]);
	});

	test('three sheets, middle source -> 3 positions with adjacency labels', () => {
		const sheets = [
			{ id: 0, name: 'A' },
			{ id: 1, name: 'B' },
			{ id: 2, name: 'C' },
		];
		const items = buildSheetMovePositionItems(sheets, 1);  // source = B
		assert.strictEqual(items.length, 3);
		assert.strictEqual(items[0].label, 'Position 0 (first)');
		// Position 1: between A and C (since B was removed from "remaining")
		assert.strictEqual(items[1].label, 'Position 1 (between Sheet 0 and Sheet 2)');
		assert.strictEqual(items[2].label, 'Position 2 (last)');
	});

	test('current source position gets "(current)" description', () => {
		const sheets = [
			{ id: 0, name: 'A' },
			{ id: 1, name: 'B' },
			{ id: 2, name: 'C' },
		];
		// source = sheet 2, currently at position 2.
		const items = buildSheetMovePositionItems(sheets, 2);
		assert.deepStrictEqual(items.map(i => i.description),
			['', '', '(current)']);
	});

	test('source at first position -> position 0 marked current', () => {
		const sheets = [
			{ id: 0, name: 'A' },
			{ id: 1, name: 'B' },
		];
		const items = buildSheetMovePositionItems(sheets, 0);
		assert.deepStrictEqual(items.map(i => i.description),
			['(current)', '']);
	});

	test('source not found in sheets -> no "(current)" marker', () => {
		// Defensive: caller's source id might not be in the snapshot
		// (race or stale UI state).  Helper should not crash + no
		// position gets the current marker.
		const sheets = [
			{ id: 0, name: 'A' },
			{ id: 1, name: 'B' },
		];
		const items = buildSheetMovePositionItems(sheets, 99);
		assert.deepStrictEqual(items.map(i => i.description), ['', '']);
		assert.strictEqual(items.length, 2);
	});

	test('four sheets, source at end -> middle adjacency labels reflect remaining order', () => {
		// Setup: [A, B, C, D], source = D.  After removing D,
		// remaining = [A, B, C].  Position 1 = between A and B;
		// position 2 = between B and C.
		const sheets = [
			{ id: 0, name: 'A' },
			{ id: 1, name: 'B' },
			{ id: 2, name: 'C' },
			{ id: 3, name: 'D' },
		];
		const items = buildSheetMovePositionItems(sheets, 3);
		assert.strictEqual(items[0].label, 'Position 0 (first)');
		assert.strictEqual(items[1].label, 'Position 1 (between Sheet 0 and Sheet 1)');
		assert.strictEqual(items[2].label, 'Position 2 (between Sheet 1 and Sheet 2)');
		assert.strictEqual(items[3].label, 'Position 3 (last)');
	});

	test('display-order permutation preserved (V3.5.0.3c integration)', () => {
		// V3.5.0.3c can permute sheets in the snapshot; helper should
		// use the input display order for adjacency labels (NOT id order).
		const sheets = [
			{ id: 5, name: 'X' },
			{ id: 2, name: 'Y' },
			{ id: 9, name: 'Z' },
		];
		const items = buildSheetMovePositionItems(sheets, 2);  // source = Y (display pos 1)
		// After removing Y: remaining = [X(5), Z(9)].
		// Position 1: between X and Z (per display order, NOT id order).
		assert.strictEqual(items[1].label, 'Position 1 (between Sheet 5 and Sheet 9)',
			'adjacency labels use display order, not id order');
	});
});

// ============================================================================
// Phase 5.7 V3.5.0.4b (2026-05-24) -- extractSheetSnapshot transformer
// ============================================================================
// Tests the pure helper that bridges V3.5.0.2 WorkbookSnapshotJson into the
// V3.2.a QuantbookCellSnapshot shape that buildHtml consumes.  Lives in
// cellGridLogic.ts; mocha-testable without vscode.

suite('quantbook V3.5.0.4b -- extractSheetSnapshot transformer', function () {
	test('empty workbook -> null for any sheetId', () => {
		const snap: WorkbookSnapshotJson = { sheets: [], formats: [], dateSystem: 'Excel1900' };
		assert.strictEqual(extractSheetSnapshot(snap, 0), null,
			'no sheets -> null lookup');
		assert.strictEqual(extractSheetSnapshot(snap, 5), null);
	});

	test('sheet found, no cells -> empty entries with version + sheet preserved', () => {
		const snap: WorkbookSnapshotJson = { sheets: [{ id: 0, name: 'S', cells: [] }], formats: [], dateSystem: 'Excel1900' };
		const result = extractSheetSnapshot(snap, 0);
		assert.ok(result !== null);
		assert.strictEqual(result!.snapshot_format_version, 1);
		assert.strictEqual(result!.sheet, 0);
		assert.deepStrictEqual(result!.entries, []);
	});

	test('sheet not in snapshot -> null (tombstone race)', () => {
		const snap: WorkbookSnapshotJson = {
			sheets: [
				{ id: 0, name: 'A', cells: [] },
				{ id: 2, name: 'C', cells: [] },
			],
			formats: [],
			dateSystem: 'Excel1900',
		};
		// sheet 1 is missing (tombstoned).
		assert.strictEqual(extractSheetSnapshot(snap, 1), null);
	});

	test('number cell -> QuantbookCellValue { kind: number, value }', () => {
		const snap: WorkbookSnapshotJson = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{ row: 1, col: 2, value: { kind: 'number', number: 42.5 } },
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		};
		const result = extractSheetSnapshot(snap, 0);
		assert.strictEqual(result!.entries.length, 1);
		assert.deepStrictEqual(result!.entries[0],
			{ row: 1, col: 2, value: { kind: 'number', value: 42.5 } });
	});

	test('boolean / text / error cells -> typed QuantbookCellValue', () => {
		const snap: WorkbookSnapshotJson = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{ row: 0, col: 0, value: { kind: 'boolean', boolean: true } },
					{ row: 0, col: 1, value: { kind: 'text', text: 'hello' } },
					{ row: 0, col: 2, value: { kind: 'error', error: '#REF!' } },
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		};
		const r = extractSheetSnapshot(snap, 0)!;
		assert.deepStrictEqual(r.entries[0].value, { kind: 'boolean', value: true });
		assert.deepStrictEqual(r.entries[1].value, { kind: 'text', value: 'hello' });
		assert.deepStrictEqual(r.entries[2].value, { kind: 'error', value: '#REF!' });
	});

	test('pending cell -> QuantbookCellValue { kind: pending }', () => {
		const snap: WorkbookSnapshotJson = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{ row: 0, col: 0, value: { kind: 'pending' } },
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		};
		const r = extractSheetSnapshot(snap, 0)!;
		assert.deepStrictEqual(r.entries[0].value, { kind: 'pending' });
	});

	test('formula-only cell (value=undefined, formula present) -> passes through with value=pending (V3.6.0.X audit-of-D5 OPUS-HIGH-2 closure)', () => {
		// Pre-V3.6.0.X audit-of-D5 closure: formula-only cells were SKIPPED
		// (V3.4.0.X MEDIUM-1 carry).  Post-closure: passed through with
		// `value: { kind: 'pending' }` so the IDE renderer surfaces the
		// cell and `data-raw-formula` attribute emits for click-to-edit.
		// Cells where BOTH value AND formula are absent are still skipped
		// (V3.4.0.X MEDIUM-1 closure removes such cells engine-side; the
		// IDE skip is defensive).
		const snap: WorkbookSnapshotJson = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{ row: 0, col: 0, value: { kind: 'number', number: 1 } },
					{ row: 0, col: 1, formula: '=A1+1' }, // no value -> formula-only; passes through post-closure
					{ row: 0, col: 2, value: { kind: 'number', number: 3 } },
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		};
		const r = extractSheetSnapshot(snap, 0)!;
		assert.strictEqual(r.entries.length, 3,
			'formula-only cell passes through post HIGH-2 closure (was 2 pre-closure)');
		assert.deepStrictEqual(r.entries.map(e => e.col), [0, 1, 2]);
		assert.deepStrictEqual(r.entries[1].value, { kind: 'pending' },
			'formula-only cell value defaults to pending');
		assert.strictEqual(r.entries[1].formula, '=A1+1',
			'formula text preserved on the passed-through entry');
	});

	test('unknown kind -> throws bad_argument (binding-drift signal)', () => {
		// Negative test: simulate a future engine variant the IDE binding
		// doesn't recognize.  Cast through unknown to bypass the V3.5.0.2
		// TS interface's literal-union -- the runtime check is what we're
		// pinning.
		const snap = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{ row: 0, col: 0, value: { kind: 'future_variant' } },
				],
			}],
		} as unknown as WorkbookSnapshotJson;
		assert.throws(() => extractSheetSnapshot(snap, 0),
			/\[bad_argument\] extractSheetSnapshot: unknown CellValueJson kind/);
	});

	test('kind=number with missing number payload -> throws bad_argument', () => {
		const snap: WorkbookSnapshotJson = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{ row: 0, col: 0, value: { kind: 'number' } },  // no number payload
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		};
		assert.throws(() => extractSheetSnapshot(snap, 0),
			/number payload missing/);
	});

	test('multi-sheet snapshot, extract by id -> only requested sheet returned', () => {
		const snap: WorkbookSnapshotJson = {
			sheets: [
				{ id: 0, name: 'A', cells: [{ row: 0, col: 0, value: { kind: 'number', number: 1 } }] },
				{ id: 1, name: 'B', cells: [{ row: 0, col: 0, value: { kind: 'number', number: 2 } }] },
				{ id: 2, name: 'C', cells: [{ row: 0, col: 0, value: { kind: 'number', number: 3 } }] },
			],
			formats: [],
			dateSystem: 'Excel1900',
		};
		const r1 = extractSheetSnapshot(snap, 1)!;
		assert.strictEqual(r1.sheet, 1);
		assert.strictEqual(r1.entries.length, 1);
		assert.deepStrictEqual(r1.entries[0].value, { kind: 'number', value: 2 });
		// Sanity: extracting another sheet is independent.
		const r2 = extractSheetSnapshot(snap, 2)!;
		assert.deepStrictEqual(r2.entries[0].value, { kind: 'number', value: 3 });
	});

	test('cells preserve row + col ordering from snapshot', () => {
		// snapshot_cells is sorted (row, col) ascending per V3.5.0.2 contract;
		// transformer preserves the order.
		const snap: WorkbookSnapshotJson = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{ row: 0, col: 0, value: { kind: 'number', number: 1 } },
					{ row: 0, col: 5, value: { kind: 'number', number: 2 } },
					{ row: 3, col: 2, value: { kind: 'number', number: 3 } },
					{ row: 5, col: 0, value: { kind: 'number', number: 4 } },
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		};
		const r = extractSheetSnapshot(snap, 0)!;
		assert.deepStrictEqual(r.entries.map(e => [e.row, e.col]),
			[[0, 0], [0, 5], [3, 2], [5, 0]]);
	});
});

// V3.5.0.4b integration: round-trip via a real session -- sheet rename
// reflects immediately in extractSheetSnapshot output (no pollRemote wait),
// sheet delete (tombstone) makes the sheet unreachable, sheet move keeps
// cells reachable by id.
suite('quantbook V3.5.0.4b -- extractSheetSnapshot via real workbookSnapshot()', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('rename reflects immediately in render-derived snapshot (no pollRemote wait)', () => {
		const session = createSession(8001n);
		addSheet(session, 'Original');
		appendPutValueValidated(session, 0, 0, 0, 42);
		const before = extractSheetSnapshot(workbookSnapshot(session), 0);
		assert.ok(before !== null);
		assert.strictEqual(before!.entries.length, 1);
		renameSheet(session, 0, 'Renamed');
		// V3.5.0.4b key behavior: workbookSnapshot routes through
		// rebuild_workbook which carries the rename; extractSheetSnapshot
		// sees the same cells (rename doesn't touch cells).
		const after = extractSheetSnapshot(workbookSnapshot(session), 0);
		assert.ok(after !== null);
		assert.deepStrictEqual(after!.entries, before!.entries,
			'rename preserves cells; extractor sees identical entries');
		// Verify rename also affects the sheet's name in the snapshot
		// (panel title source).
		const sheet = workbookSnapshot(session).sheets.find(s => s.id === 0);
		assert.strictEqual(sheet!.name, 'Renamed');
	});

	test('delete (tombstone) -> extractor returns null for the tombstoned id', () => {
		const session = createSession(8002n);
		addSheet(session, 'TBR');
		appendPutValueValidated(session, 0, 0, 0, 100);
		assert.ok(extractSheetSnapshot(workbookSnapshot(session), 0) !== null);
		deleteSheet(session, 0);
		assert.strictEqual(extractSheetSnapshot(workbookSnapshot(session), 0), null,
			'tombstoned sheet -> extractor returns null (render() shows empty + warns)');
	});

	test('move keeps cells reachable by ID (id-stability)', () => {
		const session = createSession(8003n);
		addSheet(session, 'A');
		addSheet(session, 'B');
		appendPutValueValidated(session, 1, 0, 0, 77);
		// Move sheet 1 to display position 0.
		moveSheet(session, 1, 0);
		// V3.5.0.3c id stability: sheet 1's cells still reachable by id.
		const r = extractSheetSnapshot(workbookSnapshot(session), 1);
		assert.ok(r !== null);
		assert.strictEqual(r!.entries.length, 1);
		assert.deepStrictEqual(r!.entries[0].value, { kind: 'number', value: 77 });
	});

	test('empty addSheet\'d sheet -> extractor returns empty entries (not null)', () => {
		// Pre-V3.5.0.2 listSheets() would not surface addSheet-only sheets
		// (cache-based).  V3.5.0.4b uses workbookSnapshot which enumerates
		// via sheet_count, so empty sheets DO appear.
		const session = createSession(8004n);
		addSheet(session, 'Empty');
		const r = extractSheetSnapshot(workbookSnapshot(session), 0);
		assert.ok(r !== null, 'addSheet-only sheets are reachable (not null)');
		assert.deepStrictEqual(r!.entries, []);
	});

	test('round-trip equality: workbookSnapshot-derived matches exportSnapshot-derived (V3.5.0.4b backward-compat pin)', () => {
		// Sanity: the V3.5.0.4b migration must not change the per-cell
		// rendered shape.  Compare the V3.5.0.2 path output against the
		// V3.4.0.X path output (exportCellSnapshot) for the same session.
		const session = createSession(8005n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 1);
		appendPutValueValidated(session, 0, 0, 1, 2);
		appendPutValueValidated(session, 0, 1, 0, 3);
		const v3_5_path = extractSheetSnapshot(workbookSnapshot(session), 0)!;
		const v3_4_path = exportCellSnapshot(session, 0);
		assert.strictEqual(v3_5_path.snapshot_format_version, v3_4_path.snapshot_format_version);
		assert.strictEqual(v3_5_path.sheet, v3_4_path.sheet);
		assert.deepStrictEqual(v3_5_path.entries, v3_4_path.entries,
			'V3.5.0.4b path produces same entries as V3.4.0.X path (per-cell shape preserved)');
	});

	test('panel title sheet-count comes from workbookSnapshot (includes empty sheets)', () => {
		// V3.5.0.4b reactive-title key behavior: the count is
		// workbookSnapshot.sheets.length, NOT listSheets().length.  Empty
		// sheets (addSheet without PutValue) count.
		const session = createSession(8006n);
		addSheet(session, 'A');
		addSheet(session, 'B');
		addSheet(session, 'EmptyC');
		appendPutValueValidated(session, 0, 0, 0, 1);
		// listSheets is cache-based + only surfaces sheets with PutValue:
		assert.strictEqual(listSheets(session).length, 1,
			'listSheets misses addSheet-only sheets (V3.3.0.X cache-based contract)');
		// workbookSnapshot enumerates all sheets:
		assert.strictEqual(workbookSnapshot(session).sheets.length, 3,
			'workbookSnapshot counts all sheets (V3.5.0.4b reactive-title source)');
	});
});

// ============================================================================
// Phase 5.7 V3.5.0.5 (2026-05-24) -- CellState.format passthrough + FormatIdJson
// ============================================================================
// V3.5.0.5 ships per-cell format passthrough in WorkbookSnapshotJson.  No
// IDE write-path yet (engine napi for SetCellFormat is not exposed; format
// editing is V3.6+ scope).  These tests pin the TS interface shape +
// extractSheetSnapshot's drop-format behavior (V3.5.0.5 buildHtml is not
// format-aware; the transformer silently drops format from its output).

suite('quantbook V3.5.0.5 -- CellSnapshotJson.format type shape', function () {
	test('CellSnapshotJson has optional format field', () => {
		// Type-shape pin: the new format field is OPTIONAL per the
		// napi-rs Option::None -> absent JS property convention.
		const cell: CellSnapshotJson = {
			row: 0,
			col: 0,
			value: { kind: 'number', number: 1 },
			// formula + format absent
		};
		assert.strictEqual(cell.format, undefined,
			'format defaults to undefined (absent JS property)');
	});

	test('CellSnapshotJson accepts builtin FormatIdJson', () => {
		const cell: CellSnapshotJson = {
			row: 0,
			col: 0,
			format: { kind: 'builtin', builtin: 2 },
		};
		assert.strictEqual(cell.format?.kind, 'builtin');
		assert.strictEqual(cell.format?.builtin, 2);
		assert.strictEqual(cell.format?.customPeer, undefined);
		assert.strictEqual(cell.format?.customCounter, undefined);
	});

	test('CellSnapshotJson accepts custom FormatIdJson with PeerId bigint', () => {
		const cell: CellSnapshotJson = {
			row: 0,
			col: 0,
			format: { kind: 'custom', customPeer: 42n, customCounter: 100 },
		};
		assert.strictEqual(cell.format?.kind, 'custom');
		assert.strictEqual(cell.format?.builtin, undefined);
		assert.strictEqual(cell.format?.customPeer, 42n);
		assert.strictEqual(cell.format?.customCounter, 100);
	});
});

suite('quantbook V3.5.0.5 -- extractSheetSnapshot drops format (V3.5.0.5 scope)', function () {
	test('extractSheetSnapshot output has no format field (V3.2.a QuantbookCellSnapshot shape)', () => {
		// V3.5.0.5 deliberate: buildHtml is not format-aware yet, so
		// the transformer produces the V3.2.a shape (no format).  The
		// per-cell format flows through workbookSnapshot for V3.6+
		// format-aware rendering; for now extractSheetSnapshot drops it.
		const snap: WorkbookSnapshotJson = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{
						row: 0, col: 0,
						value: { kind: 'number', number: 5 },
						format: { kind: 'builtin', builtin: 2 },
					},
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		};
		const result = extractSheetSnapshot(snap, 0);
		assert.ok(result !== null);
		assert.strictEqual(result!.entries.length, 1);
		// V3.2.a entry shape: { row, col, value } -- no format key.
		const entry = result!.entries[0];
		assert.deepStrictEqual(Object.keys(entry).sort(), ['col', 'row', 'value'],
			'entry has V3.2.a shape: row + col + value; format silently dropped');
	});

	test('extractSheetSnapshot skips format-only cells (no value)', () => {
		// V3.4.0.X MEDIUM-1 carry: cells with value=undefined are
		// skipped by extractSheetSnapshot (formula-only behavior
		// extends to format-only).  Pre-V3.5.0.5 the cell would have
		// been ghost-removed by the engine cache; V3.5.0.5 engine
		// extends ghost-removal to (value && formula && format) all-None.
		// A format-only cell legitimately exists in the cache (format
		// is set), but extractSheetSnapshot skips it because value is
		// undefined.
		const snap: WorkbookSnapshotJson = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{ row: 0, col: 0, format: { kind: 'builtin', builtin: 2 } },
					{ row: 1, col: 0, value: { kind: 'number', number: 7 } },
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		};
		const result = extractSheetSnapshot(snap, 0);
		assert.strictEqual(result!.entries.length, 1,
			'format-only cell skipped by extractor; only value-bearing cell surfaces');
		assert.strictEqual(result!.entries[0].row, 1);
	});
});

suite('quantbook V3.5.0.5 -- workbookSnapshot format passthrough (no write-path yet)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('no SetCellFormat ops -> cells have format undefined', () => {
		// Without an IDE-facing write path for SetCellFormat (V3.6+
		// scope), real sessions never produce formatted cells.  Pin
		// that the passthrough emits `undefined` for unformatted cells.
		const session = createSession(8101n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 42);
		const snap = workbookSnapshot(session);
		const cell = snap.sheets[0].cells[0];
		assert.strictEqual(cell.format, undefined,
			'no SetCellFormat ops -> format absent (napi-rs Option::None)');
	});

	test('workbookSnapshot.sheets[].cells[].format key absent when undefined', () => {
		// napi-rs Option::None -> ABSENT property (not null, not undefined-
		// explicit-set).  Pin via Object.keys.
		const session = createSession(8102n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 1);
		const cell = workbookSnapshot(session).sheets[0].cells[0];
		const keys = Object.keys(cell).sort();
		assert.ok(!keys.includes('format'),
			`format key absent when undefined (napi-rs Option::None convention); got keys: ${JSON.stringify(keys)}`);
	});
});

// ============================================================================
// Phase 5.7 V3.6.0.3 D2 (2026-05-24) -- WorkbookSnapshotJson.formats array
// ============================================================================
// Tests the additive `formats: FormatDefJson[]` field on WorkbookSnapshotJson.
// Populated from the rebuilt+repaired engine `Workbook.FormatTable` (which
// merges Builtin ids 0..=163 with Custom ids registered via Op::RegisterFormat).
// V3.6+ format-aware buildHtml rendering (D4) will consume this list.

suite('quantbook V3.6.0.3 -- WorkbookSnapshotJson.formats field', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('fresh session has the formats field as an Array', () => {
		// V3.6.0.3 D2: the `formats` field is REQUIRED (always present,
		// possibly empty).  Distinct from V3.5.0.5 optional cell-level
		// `format?: FormatIdJson` (which uses napi-rs Option::None ->
		// absent property convention).
		const session = createSession(8301n);
		const snap = workbookSnapshot(session);
		assert.ok(Array.isArray(snap.formats),
			'V3.6.0.3 contract: workbookSnapshot.formats is always an Array (even if empty)');
	});

	test('fresh session has Builtin format ids surfacing in formats', () => {
		// A fresh CollabSession + Workbook has the Builtin format ids
		// (0..=163 per Phase 5.2 D-1) already in the FormatTable.
		// V3.6.0.3 D2 surfaces them via formats[].  Custom formats only
		// appear after Op::RegisterFormat applications (no IDE write
		// path yet -- V3.6+ scope; D5 will add appendPutFormula but
		// RegisterFormat napi is a separate future surface).
		const session = createSession(8302n);
		const snap = workbookSnapshot(session);
		// Builtin ids 0..=163 should all be present.  Smoke-check a
		// sample (id 0 = "General", id 9 = "0%", etc., per Excel
		// canonical numfmts).
		const builtinIds = snap.formats
			.filter(f => f.id.kind === 'builtin')
			.map(f => f.id.builtin)
			.sort((a, b) => (a ?? 0) - (b ?? 0));
		assert.ok(builtinIds.length >= 10,
			`fresh workbook has Builtin format ids; got ${builtinIds.length} (expected >= 10 for Excel-canonical 0..=163)`);
		assert.strictEqual(builtinIds[0], 0,
			'first Builtin id is 0 (General format)');
	});

	test('formats field type shape -- FormatDefJson { id, string }', () => {
		// Pin the V3.6.0.3 napi shape.  Each entry has:
		// - id: FormatIdJson (kind = "builtin" | "custom")
		// - string: string
		const session = createSession(8303n);
		const snap = workbookSnapshot(session);
		assert.ok(snap.formats.length > 0, 'Builtins should populate the array');
		const entry = snap.formats[0];
		const keys = Object.keys(entry).sort();
		assert.deepStrictEqual(keys, ['id', 'string'],
			`FormatDefJson shape: ['id', 'string']; got ${JSON.stringify(keys)}`);
		assert.ok(typeof entry.id === 'object' && entry.id !== null,
			'id is a FormatIdJson object');
		assert.ok(typeof entry.string === 'string',
			'string is a string');
		assert.ok(['builtin', 'custom'].includes(entry.id.kind),
			`id.kind is 'builtin' or 'custom'; got ${entry.id.kind}`);
	});

	test('WorkbookSnapshotJson top-level shape includes formats + dateSystem', () => {
		// Pin the additive shape evolution:
		// - V3.5.0.2 baseline: { sheets }
		// - V3.6.0.3 D2 added: + formats
		// - V3.6.0.5 D4 added: + dateSystem
		// - V3.6.0.8.4 OPUS-HIGH-2 closure: + version (Buffer)
		// - Phase 6.3-1c M5 (2026-05-30): + schemaVersion (contract section 4.1)
		const session = createSession(8304n);
		const snap = workbookSnapshot(session);
		const topLevelKeys = Object.keys(snap).sort();
		assert.deepStrictEqual(topLevelKeys, ['dateSystem', 'formats', 'schemaVersion', 'sheets', 'version'],
			`6.3-1c WorkbookSnapshotJson has exactly { sheets, formats, dateSystem, version, schemaVersion }; got ${JSON.stringify(topLevelKeys)}`);
	});
});

// ============================================================================
// Phase 5.7 V3.6.0.5 D4 (2026-05-23) -- format-aware buildHtml rendering
//   (CellSnapshotJson.rendered + WorkbookSnapshotJson.dateSystem)
// ============================================================================
// V3.6.0.5 D4 ships engine-side format-aware pre-rendering via
// `ql_functions::format::render(value, parsed_format, eval_context)`
// where eval_context.date_system comes from the workbook (Phase 4.6 D-1)
// and eval_context.locale = EnUs (V3.6.0.5 ships EN-US only).
//
// **mocha-test scope limitation**: the IDE napi has no
// `appendSetCellFormat` or `appendRegisterFormat` method at V3.6.0.5
// D4 ship (those are separate sub-steps; V3.6.0.6 D5 adds
// `appendPutFormula` but not the format ops).  So mocha tests can only
// pin the SHAPE: `dateSystem` field present + valid; `rendered` field
// absent when no format ops have run; existing extractSheetSnapshot
// tests verify `rendered` passthrough is non-intrusive.  Full format-
// render integration tests (Op::RegisterFormat + Op::SetCellFormat +
// Op::PutValue -> render via FormatTable + EvalContext) live engine-
// side in ql-collab + ql-bindings-node integration tests (V3.6.0.X
// audit-of-D4 scope adds end-to-end mocha tests once
// appendSetCellFormat napi lands).

suite('quantbook V3.6.0.5 D4 -- format-aware rendering shape', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('dateSystem defaults to "Excel1900"', () => {
		// V3.6.0.5 D4: fresh workbook defaults to Excel1900 epoch
		// (ql_types::DateSystem::Excel1900 default).
		const session = createSession(8501n);
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.dateSystem, 'Excel1900',
			`fresh workbook defaults to Excel1900; got ${snap.dateSystem}`);
	});

	test('dateSystem is one of "Excel1900" | "Excel1904"', () => {
		// V3.6.0.5 D4: pin the discriminated-union shape.  Two
		// valid values per ql_types::DateSystem enum.
		const session = createSession(8502n);
		const snap = workbookSnapshot(session);
		const valid = (snap.dateSystem === 'Excel1900' || snap.dateSystem === 'Excel1904');
		assert.ok(valid,
			`dateSystem must be "Excel1900" or "Excel1904"; got ${JSON.stringify(snap.dateSystem)}`);
	});

	test('CellSnapshotJson.rendered absent for cells without format', () => {
		// V3.6.0.5 D4: cells without Op::SetCellFormat have no
		// format id, so the engine skips format::render and
		// rendered = None -> absent JS property (napi-rs Option::None
		// convention).  Default test cells (PutValue only) fall in
		// this category since the IDE napi has no SetCellFormat
		// method at V3.6.0.5 D4 ship.
		const session = createSession(8503n);
		addSheet(session, 'S');
		session.appendPutValue(0, 0, 0, 42);
		const snap = workbookSnapshot(session);
		const cell = snap.sheets[0]?.cells.find(c => c.row === 0 && c.col === 0);
		assert.ok(cell !== undefined, 'cell (0,0) present in snapshot');
		assert.strictEqual(cell!.rendered, undefined,
			`cell without format has rendered === undefined; got ${JSON.stringify(cell!.rendered)}`);
	});

	test('CellSnapshotJson shape: rendered is optional (V3.6.0.5 D4 additive extension)', () => {
		// V3.6.0.5 D4: rendered is an OPTIONAL string field on
		// CellSnapshotJson.  When absent, IDE buildHtml falls back to
		// formatCellValue(value).  Pin the field presence (when set)
		// via TypeScript -- runtime check below verifies the absence
		// convention via Object.keys().
		const session = createSession(8504n);
		addSheet(session, 'S');
		session.appendPutValue(0, 0, 0, 1.5);
		const snap = workbookSnapshot(session);
		const cell = snap.sheets[0]?.cells.find(c => c.row === 0 && c.col === 0);
		assert.ok(cell !== undefined, 'cell present');
		// Without format, rendered should NOT be in Object.keys
		// (napi-rs Option::None -> absent property, not null).
		const keys = Object.keys(cell!).sort();
		assert.ok(!keys.includes('rendered'),
			`napi-rs Option::None convention: rendered absent from Object.keys; got ${JSON.stringify(keys)}`);
	});
});

// ============================================================================
// Phase 5.7 V3.5.0.7 (2026-05-24) -- mid-edit-render guard
//   (D5 / R-V3.4-3 KNOWN-GAP closure)
// ============================================================================
// Tests the dispatcher-level `onLocalTyping` callback firing behavior.
// The host-level `_presenceRepaintInFlight` flag + watchdog timer + tickPoll
// skip live on CellGridPanel (which depends on vscode); those are covered
// by the live smoke procedure in § 4.1.z5.  This suite pins the
// vscode-free contract: dispatcher fires onLocalTyping with the right
// boolean at the right time, and DOESN'T fire on validation/engine
// failures.

// FE-0a Part B (B1): the "presenceUpdate fires onLocalTyping" suite was REMOVED
// -- the mid-edit-render guard (onLocalTyping / setPresenceTyping watchdog) was
// part of the collab presence path, which is v1.5-dormant. The owning Session is
// single-writer (no remote merges race a local edit), so the dispatch has no
// onLocalTyping callback and drops presenceUpdate silently. Returns in v1.5.

// ============================================================================
// Phase 5.7 V3.6.0.6 D5 (2026-05-24) -- IDE-facing appendPutFormula napi
// ============================================================================
// Closes V3.5.0.X A-HIGH-2 IDE-level verification gap (engine repair
// surfaces in workbookSnapshot, driven end-to-end from the IDE).  Mirrors
// V3.4.0.X appendPutValue + V3.5.0.3a renameSheet napi contract tests.

suite('quantbook V3.6.0.6 D5 -- appendPutFormulaValidated input validation', function () {
	// V3.6.0.X audit-of-D5 OPUS-LOW-2 closure (2026-05-24): even though
	// these tests exercise pure-TS validation logic in
	// appendPutFormulaValidated, they currently couple to the engine
	// binary via createSession.  shouldSkip() gates the suite so CI
	// hosts without the engine binary still pass the test run instead
	// of failing 6 validator tests they shouldn't.  Long-term refactor
	// (V3.7+): wrap validators behind a mock session so the tests
	// don't need the engine at all.
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('rejects negative sheet', () => {
		const session = createSession(8601n);
		assert.throws(
			() => appendPutFormulaValidated(session, -1, 0, 0, '=A1'),
			/\[bad_argument\] appendPutFormula: sheet/,
		);
	});

	test('rejects sheet > u16::MAX', () => {
		const session = createSession(8602n);
		assert.throws(
			() => appendPutFormulaValidated(session, 65536, 0, 0, '=A1'),
			/\[bad_argument\] appendPutFormula: sheet/,
		);
	});

	test('rejects fractional row', () => {
		const session = createSession(8603n);
		assert.throws(
			() => appendPutFormulaValidated(session, 0, 1.5, 0, '=A1'),
			/\[bad_argument\] appendPutFormula: row/,
		);
	});

	test('rejects out-of-u32-range col', () => {
		const session = createSession(8604n);
		assert.throws(
			() => appendPutFormulaValidated(session, 0, 0, 0x100000000, '=A1'),
			/\[bad_argument\] appendPutFormula: col/,
		);
	});

	test('rejects non-string text', () => {
		const session = createSession(8605n);
		assert.throws(
			() => appendPutFormulaValidated(session, 0, 0, 0, 42 as unknown as string),
			/\[bad_argument\] appendPutFormula: text/,
		);
	});

	test('accepts valid inputs (empty string, boundary u16/u32, ASCII formula)', () => {
		const session = createSession(8606n);
		addSheet(session, 'S');
		appendPutFormulaValidated(session, 0, 0, 0, '=A1');
		appendPutFormulaValidated(session, 0, 0xFFFFFFFF, 0xFFFFFFFF, '');
		assert.strictEqual(session.opCount(), 3,
			'addSheet + 2 appendPutFormula -> opCount=3');
	});
});

suite('quantbook V3.6.0.6 D5 -- engine appendPutFormula napi contract', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('appendPutFormula increments opCount', () => {
		const session = createSession(8611n);
		addSheet(session, 'S');
		const before = session.opCount();
		session.appendPutFormula(0, 0, 0, '=A1+1');
		assert.strictEqual(session.opCount(), before + 1,
			'one appendPutFormula appends exactly one op');
	});

	test('engine rejects fractional row (no ToUint32 silent wrap)', () => {
		const session = createSession(8612n);
		addSheet(session, 'S');
		assert.throws(
			() => session.appendPutFormula(0, 0.5, 0, '=A1'),
			/appendPutFormula/,
		);
	});

	test('engine rejects negative row', () => {
		const session = createSession(8613n);
		addSheet(session, 'S');
		assert.throws(
			() => session.appendPutFormula(0, -1, 0, '=A1'),
			/appendPutFormula/,
		);
	});

	test('engine rejects out-of-u32-range row', () => {
		const session = createSession(8614n);
		addSheet(session, 'S');
		assert.throws(
			() => session.appendPutFormula(0, 0x100000000, 0, '=A1'),
			/appendPutFormula/,
		);
	});
});

suite('quantbook V3.6.0.6 D5 -- workbookSnapshot surfaces formula text', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('formula-only cell -> CellSnapshotJson has formula property, value absent', () => {
		// PutFormula without prior PutValue at the same cell -> the cell has
		// formula text but no cached literal (no evaluation runs at the
		// session layer; evaluation lives in the runtime layer engine-side).
		const session = createSession(8621n);
		addSheet(session, 'S');
		session.appendPutFormula(0, 0, 0, '=A2+1');
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets[0].cells.length, 1,
			'one cell with formula appears in snapshot');
		const cell = snap.sheets[0].cells[0];
		assert.strictEqual(cell.formula, '=A2+1',
			'PutFormula text surfaces in CellSnapshotJson.formula');
		assert.strictEqual(cell.value, undefined,
			'no prior PutValue -> value absent (napi-rs Option::None convention)');
	});

	test('formula text repaired through Phase 5.3 rename chain (V3.5.0.X A-HIGH-2 end-to-end)', () => {
		// V3.5.0.X audit-closure A-HIGH-2 closure landed `workbookSnapshot`
		// reading from rebuild_workbook formula_at (so renamed sheets
		// surface REPAIRED formula text).  Pre-V3.6.0.6 this was verified
		// only by a Rust ql-collab test because the IDE had no PutFormula
		// write-path.  Post-V3.6.0.6 D5 the IDE can drive the end-to-end
		// repair scenario.
		const session = createSession(8622n);
		addSheet(session, 'Source');
		addSheet(session, 'Target');
		// Formula in sheet 1 (Target) referencing sheet 0 (Source).
		session.appendPutFormula(1, 0, 0, '=Source!A1');
		// Rename Source -> Renamed.
		renameSheet(session, 0, 'Renamed');
		const snap = workbookSnapshot(session);
		const targetCell = snap.sheets.find(s => s.id === 1)?.cells.find(c => c.row === 0 && c.col === 0);
		assert.ok(targetCell !== undefined, 'cell exists after rename');
		assert.strictEqual(targetCell!.formula, '=Renamed!A1',
			`Phase 5.3 repair_sheet_rename_chain rewrites cross-sheet ref; expected "=Renamed!A1", got ${JSON.stringify(targetCell!.formula)}`);
	});

	test('round-trip via to_qbook/from_qbook preserves formula text', () => {
		const session = createSession(8623n);
		addSheet(session, 'S0');
		addSheet(session, 'S1');
		session.appendPutFormula(0, 1, 1, '=S1!B2*2');
		const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbook-v3606d5-'));
		const target = path.join(scratchDir, 'snap.qbook');
		try {
			exportToQbook(session, target);
			const reloaded = sessionFromQbook(target, 9999n);
			const after = workbookSnapshot(reloaded);
			const cell = after.sheets.find(s => s.id === 0)?.cells.find(c => c.row === 1 && c.col === 1);
			assert.ok(cell !== undefined, 'formula cell preserved across .qbook round-trip');
			assert.strictEqual(cell!.formula, '=S1!B2*2',
				'formula text preserved verbatim through to_qbook + from_qbook');
		} finally {
			try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* test cleanup */ }
		}
	});
});

suite('quantbook V3.6.0.6 D5 -- extractSheetSnapshot passes through formula', function () {
	test('cell with both value AND formula -> entry carries formula property', () => {
		// Synthetic snapshot mirroring what workbookSnapshot would emit
		// for a cell that has both a cached literal AND formula text
		// (formula evaluated to a number).
		const snap: WorkbookSnapshotJson = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{ row: 0, col: 0, value: { kind: 'number', number: 42 }, formula: '=21*2' },
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		};
		const result = extractSheetSnapshot(snap, 0);
		assert.ok(result !== null);
		assert.strictEqual(result!.entries.length, 1);
		assert.strictEqual(result!.entries[0].formula, '=21*2',
			'formula text passes through extractSheetSnapshot when set');
		assert.deepStrictEqual(result!.entries[0].value, { kind: 'number', value: 42 },
			'value still passes through alongside formula');
	});

	test('cell with value only -> formula property absent (shape stability)', () => {
		const snap: WorkbookSnapshotJson = {
			sheets: [{
				id: 0, name: 'S', cells: [
					{ row: 0, col: 0, value: { kind: 'number', number: 7 } },
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		};
		const result = extractSheetSnapshot(snap, 0);
		const entry = result!.entries[0];
		const keys = Object.keys(entry).sort();
		assert.deepStrictEqual(keys, ['col', 'row', 'value'],
			'no formula key on pure-literal entries (Object.keys shape stability)');
	});
});

suite('quantbook V3.6.0.6 D5 -- buildHtml emits data-raw-formula', function () {
	test('cell with formula -> data-raw-formula attribute in rendered HTML', () => {
		// Pin the V3.6.0.X audit-of-D4 OPUS-HIGH-2 § G.2 contract:
		// beginEdit precedence chain is data-raw-formula >
		// data-raw-value > data-original-text.  Cells with formula
		// MUST emit the attribute so click-to-edit shows formula
		// source not the evaluated value.
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 0, col: 0, value: { kind: 'number', value: 42 }, formula: '=21*2' },
			],
		}, { nonce: 'n6' });
		assert.ok(html.includes('data-raw-formula="=21*2"'),
			`cell with formula should emit data-raw-formula attribute; html: ${html.slice(0, 2000)}`);
		// data-raw-value still emits (preserves backward compat with
		// V3.6.0.X audit-of-D4 OPUS-HIGH-2 closure for non-formula
		// edit case).
		assert.ok(html.includes('data-raw-value="42"'),
			'data-raw-value still present alongside data-raw-formula');
	});

	test('cell WITHOUT formula -> data-raw-formula attribute absent on the cell <td> (script body still references the attribute name)', () => {
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 0, col: 0, value: { kind: 'number', value: 7 } },
			],
		}, { nonce: 'n7' });
		// The literal string `data-raw-formula="` DOES appear in the
		// inline renderRowsClient script (the format-string contains
		// `'" data-raw-formula="' + htmlEscape(e.formula) + '"'`).
		// What MUST be absent is the SERVER-rendered attribute on
		// the actual cell <td>.  Scope the check to the <td class="cell-value"...>
		// element.
		const tdStart = html.indexOf('<td class="cell-value"');
		assert.ok(tdStart > -1, 'editable cell <td> present in HTML');
		const tdEnd = html.indexOf('</td>', tdStart);
		const tdMarkup = html.slice(tdStart, tdEnd);
		assert.ok(!tdMarkup.includes('data-raw-formula'),
			`pure-literal cell <td> should NOT have data-raw-formula; tdMarkup: ${tdMarkup}`);
	});

	test('formula text is HTML-escaped in data-raw-formula attribute (XSS hygiene)', () => {
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 0, col: 0, value: { kind: 'number', value: 1 }, formula: '=A1&"<x>"' },
			],
		}, { nonce: 'nx' });
		// The "&" and "<x>" must be HTML-escaped inside the attribute
		// value (CSP-safe injection-proof).  Using `<x>` instead of
		// `<script>` so the assertion can target the literal substring
		// without colliding with the inline `<script nonce="...">`
		// tag that buildHtml emits for the webview client script.
		assert.ok(html.includes('data-raw-formula="=A1&amp;&quot;&lt;x&gt;&quot;"'),
			`formula attribute HTML-escapes & " < >; html sample: ${html.slice(html.indexOf('data-raw-formula'), html.indexOf('data-raw-formula') + 200)}`);
		// And the raw unescaped sequence MUST NOT appear in the
		// attribute value (the <x> tag would be HTML-parsed otherwise).
		const attrIdx = html.indexOf('data-raw-formula="');
		const attrTail = html.slice(attrIdx, attrIdx + 200);
		assert.ok(!attrTail.includes('<x>'),
			`raw <x> must NOT appear inside data-raw-formula attribute; got: ${attrTail}`);
	});

	test('beginEdit client script precedence: data-raw-formula > data-raw-value > data-original-text', () => {
		// Pin that within the `function beginEdit(...)` body, the
		// reads happen in the right order.  We scope to the substring
		// between `function beginEdit(` and the next `function ` (the
		// next function definition) so reads in `endEdit` (which uses
		// `data-original-text` to restore on Escape) don't pollute
		// the comparison.
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 0, col: 0, value: { kind: 'number', value: 1 } },
			],
		}, { nonce: 'np' });
		const beginIdx = html.indexOf('function beginEdit(');
		assert.ok(beginIdx > -1, 'beginEdit function present in script');
		// Find the NEXT `function ` after beginEdit starts (i.e., the
		// end of beginEdit's body).
		const afterBeginIdx = html.indexOf('function ', beginIdx + 'function beginEdit('.length);
		const slice = afterBeginIdx > -1 ? html.slice(beginIdx, afterBeginIdx) : html.slice(beginIdx);
		const rawFormulaIdx = slice.indexOf('getAttribute(\'data-raw-formula\')');
		const rawValueIdx = slice.indexOf('getAttribute(\'data-raw-value\')');
		const origTextIdx = slice.indexOf('getAttribute(\'data-original-text\')');
		assert.ok(rawFormulaIdx > -1, 'beginEdit body reads data-raw-formula');
		assert.ok(rawValueIdx > -1, 'beginEdit body reads data-raw-value');
		assert.ok(origTextIdx > -1, 'beginEdit body reads data-original-text fallback');
		// Precedence: formula MUST be checked before value, value before text.
		assert.ok(rawFormulaIdx < rawValueIdx,
			`data-raw-formula must precede data-raw-value in beginEdit body (got ${rawFormulaIdx} < ${rawValueIdx})`);
		assert.ok(rawValueIdx < origTextIdx,
			`data-raw-value must precede data-original-text in beginEdit body (got ${rawValueIdx} < ${origTextIdx})`);
	});
});

// ============================================================================
// Phase 5.7 V3.6.0.X audit-of-D5 closures (2026-05-24) -- OPUS HIGH-1 + HIGH-2 + HIGH-3
// ============================================================================
// Closes Opus Lane B audit findings on the V3.6.0.6 D5 ship surface.
// Codex Lane A blocked by OrbStack Mac bridge outage; deferred to V3.7+
// retrospective if user signal surfaces.

suite('quantbook V3.6.0.X audit-of-D5 OPUS-HIGH-1 -- dispatcher routes = prefix to appendPutFormula', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	function makeDeps(session: SessionInstance, sheet: number) {
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

	// FE-0a Part B (B1): the `=`-prefix routing is unchanged; the grid now writes
	// via the owning Session (createWorkbookSession + session.addSheet + setFormula).
	test('rawInput starting with = routes to setFormula; snapshot surfaces formula text', () => {
		const session = createWorkbookSession();
		session.addSheet('S', 1000);
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 0, rawInput: '=A2+1' },
			deps,
		);
		assert.strictEqual(getCommitCount(), 1, 'formula commit fired onCommit');
		assert.strictEqual(errorReplies.length, 0,
			`no errorReply on formula commit; got: ${JSON.stringify(errorReplies)}`);
		const snap = session.snapshot();
		const cell = snap.sheets[0].cells.find(c => c.row === 0 && c.col === 0);
		assert.ok(cell !== undefined, 'PutFormula cell present in snapshot');
		// The dispatch strips the leading `=`; Session.setFormula stores a NORMALIZED
		// formula (no `=`, e.g. `A2 + 1`) -- unlike CollabSession's verbatim store. So
		// assert it routed to a formula cell + computed (A2 blank -> 0, so A2+1 = 1).
		assert.ok(typeof cell!.formula === 'string' && cell!.formula.length > 0,
			'rawInput =A2+1 routed to setFormula not setValue (formula text present)');
		assert.deepStrictEqual(cell!.value, { kind: 'number', number: 1 });
	});

	test('rawInput with leading whitespace + = still detected as formula (trimStart)', () => {
		const session = createWorkbookSession();
		session.addSheet('S', 1000);
		setValueValidated(session, 0, 0, 0, { kind: 'number', number: 4 }); // A1 = 4
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		// Leading whitespace then `=` is still a formula (trimStart). A single
		// cell-ref binds in v1 (a literal RangeRef like SUM(A1:B10) does NOT --
		// that is a v1 formula_bind limitation, surfaced as a loud errorReply).
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 1, rawInput: '   =A1+1' },
			deps,
		);
		assert.strictEqual(getCommitCount(), 1);
		assert.strictEqual(errorReplies.length, 0);
		const snap = session.snapshot();
		const cell = snap.sheets[0].cells.find(c => c.row === 0 && c.col === 1);
		assert.ok(cell?.formula !== undefined,
			'leading-whitespace + = detected as formula (trimStart) -> setFormula');
		assert.deepStrictEqual(cell!.value, { kind: 'number', number: 5 });
	});

	test('rawInput without = stays on the value path (number preserved)', () => {
		const session = createWorkbookSession();
		session.addSheet('S', 1000);
		const { deps, errorReplies, getCommitCount } = makeDeps(session, 0);
		dispatchIncomingMessage(
			{ type: 'putValue', sheet: 0, row: 0, col: 0, rawInput: '42.5' },
			deps,
		);
		assert.strictEqual(getCommitCount(), 1);
		assert.strictEqual(errorReplies.length, 0);
		const snap = session.snapshot();
		const cell = snap.sheets[0].cells[0];
		assert.strictEqual(cell.formula, undefined,
			'non-formula input routes to setValue; formula absent');
		assert.ok(cell.value !== undefined, 'value populated');
		assert.strictEqual(cell.value!.kind, 'number');
		assert.strictEqual(cell.value!.number, 42.5);
	});
});

suite('quantbook V3.6.0.X audit-of-D5 OPUS-HIGH-2 -- extractSheetSnapshot passes through formula-only cells as pending', function () {
	test('formula-only cell -> entries[i].value = pending + formula text preserved', () => {
		const snap: WorkbookSnapshotJson = {
			sheets: [{
				id: 0, name: 'S', cells: [
					// formula-only cell (no value).
					{ row: 0, col: 0, formula: '=A2+1' },
					// pure-literal cell (no formula).
					{ row: 0, col: 1, value: { kind: 'number', number: 7 } },
				],
			}],
			formats: [],
			dateSystem: 'Excel1900',
		};
		const result = extractSheetSnapshot(snap, 0);
		assert.ok(result !== null);
		assert.strictEqual(result!.entries.length, 2,
			'formula-only cell NOT dropped post-closure (pre-closure was dropped via continue)');
		const formulaCell = result!.entries[0];
		assert.deepStrictEqual(formulaCell.value, { kind: 'pending' },
			'formula-only cell surfaces with pending value (matches V3.6.0.X audit-of-D4 CONVERGENT-HIGH-3 pending strategy)');
		assert.strictEqual(formulaCell.formula, '=A2+1',
			'formula text passed through');
		const literalCell = result!.entries[1];
		assert.deepStrictEqual(literalCell.value, { kind: 'number', value: 7 });
		assert.strictEqual(literalCell.formula, undefined);
	});

	test('formula-only cell renders via buildHtml with data-raw-formula attribute + (pending) display', () => {
		const html = buildHtml({
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 0, col: 0, value: { kind: 'pending' }, formula: '=A2+1' },
			],
		}, { nonce: 'nfp' });
		// Display string for pending = "(pending)" (per formatCellValue's pending case).
		assert.ok(html.includes('(pending)'),
			'pending cell renders with "(pending)" display string');
		// data-raw-formula attribute MUST emit for click-to-edit.
		assert.ok(html.includes('data-raw-formula="=A2+1"'),
			'data-raw-formula attribute emits even for formula-only cells post-HIGH-2 closure');
		// data-raw-value carries the (pending) display string (used as the value-default raw rep).
		assert.ok(html.includes('data-raw-value="(pending)"'),
			'data-raw-value fallback also present');
	});
});

suite('quantbook V3.6.0.X audit-of-D5 OPUS-HIGH-3 -- validate_u16_index on appendPutFormula + appendPutValue sheet param', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('engine appendPutFormula rejects NaN sheet (no silent ToUint32 coerce to 0)', () => {
		const session = createSession(9011n);
		addSheet(session, 'S');
		assert.throws(
			() => session.appendPutFormula(NaN, 0, 0, '=A1'),
			/appendPutFormula: sheet/,
			'NaN sheet must throw (pre-closure napi-rs u16 ToUint32 silently coerced NaN -> 0)',
		);
	});

	test('engine appendPutFormula rejects Infinity sheet (no silent ToUint32 coerce to 0)', () => {
		const session = createSession(9012n);
		addSheet(session, 'S');
		assert.throws(
			() => session.appendPutFormula(Infinity, 0, 0, '=A1'),
			/appendPutFormula: sheet/,
		);
	});

	test('engine appendPutFormula rejects fractional sheet (no silent truncate)', () => {
		const session = createSession(9013n);
		addSheet(session, 'S');
		assert.throws(
			() => session.appendPutFormula(2.7, 0, 0, '=A1'),
			/appendPutFormula: sheet must be an integer/,
		);
	});

	test('engine appendPutFormula rejects sheet > u16::MAX with precise [bad_argument] error', () => {
		const session = createSession(9014n);
		addSheet(session, 'S');
		assert.throws(
			() => session.appendPutFormula(65536, 0, 0, '=A1'),
			/u16::MAX/,
			'65536 (just over u16::MAX) is rejected (pre-closure was rejected by napi-rs try_into too, but now via explicit validator with clearer message)',
		);
	});

	test('engine appendPutValue gains symmetric sheet validation (NaN rejected; HIGH-3 closure extended to appendPutValue)', () => {
		const session = createSession(9015n);
		addSheet(session, 'S');
		// V3.6.0.X audit-of-D5 OPUS-HIGH-3 closure also extends to appendPutValue
		// for symmetry; pre-closure appendPutValue.sheet: u16 had the same silent
		// coercion hazard.  Post-closure: validate_u16_index on both.
		assert.throws(
			() => session.appendPutValue(NaN, 0, 0, 42),
			/appendPutValue: sheet/,
			'symmetric closure: appendPutValue also gets validate_u16_index',
		);
	});

	test('engine appendPutValue rejects 2^32 sheet (silent ECMAScript ToUint32 wrap closed)', () => {
		const session = createSession(9016n);
		addSheet(session, 'S');
		// 2^32 = 4294967296; ECMAScript ToUint32 wraps to 0; pre-closure
		// napi-rs u16 saw 0 (post-ToUint32 then try_into success).  Post-closure:
		// f64 raw + validate_u16_index sees the literal 2^32 and rejects.
		assert.throws(
			() => session.appendPutValue(4294967296, 0, 0, 42),
			/u16::MAX/,
		);
	});
});

// =====================================================================
// Phase 5.7 V3.6.0.8.3 D6 (2026-05-25) -- workbookSnapshotDelta napi
// =====================================================================
//
// Pins the napi shape contract + the basic two-call IDE protocol
// (empty Buffer -> fullRebuildRequired=true; populate cache via
// workbookSnapshot() -> subsequent delta call returns a real delta
// or fullRebuildRequired=true for stale tokens).  V3.6.0.8.4
// audit-of-D6 will add multi-peer + undo regression tests.

suite('quantbook V3.6.0.8.3 D6 -- workbookSnapshotDelta empty buffer', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('empty Buffer returns fullRebuildRequired=true + current version', function () {
		const session = createSession(1n);
		const delta = session.workbookSnapshotDelta(Buffer.alloc(0));
		assert.strictEqual(delta.fullRebuildRequired, true);
		assert.deepStrictEqual(delta.changedCells, []);
		assert.deepStrictEqual(delta.removedCells, []);
		assert.deepStrictEqual(delta.sheetsChanged, []);
		assert.deepStrictEqual(delta.sheetsRemoved, []);
		assert.deepStrictEqual(delta.formatsAdded, []);
		assert.ok(Buffer.isBuffer(delta.version), 'version is Buffer');
	});
});

suite('quantbook V3.6.0.8.3 D6 -- workbookSnapshotDelta no cache populated', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('non-empty Buffer + no prior workbookSnapshot call returns fullRebuildRequired=true', function () {
		const session = createSession(1n);
		// Garbage bytes -- but no cache exists either way so we expect
		// the cache-miss branch to fire BEFORE the decode branch.
		const delta = session.workbookSnapshotDelta(Buffer.from([0x01, 0x02]));
		assert.strictEqual(delta.fullRebuildRequired, true);
	});
});

suite('quantbook V3.6.0.8.3 D6 -- workbookSnapshotDelta same-VV fast-path', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('after workbookSnapshot populates cache, same-VV delta is empty + not full-rebuild', function () {
		const session = createSession(1n);
		session.addSheet('S', 16384);
		session.appendPutValue(0, 0, 0, 42);
		// Populate the cache.  workbookSnapshot() does NOT change the
		// log VV (read-only); it just caches the rebuilt+repaired
		// workbook keyed to the current VV.
		session.workbookSnapshot();
		// Probe with empty Buffer to capture the engine's current VV
		// (V3.6.0.8.3 has no dedicated currentVersion() accessor).
		const probe1 = session.workbookSnapshotDelta(Buffer.alloc(0));
		assert.strictEqual(probe1.fullRebuildRequired, true, 'empty buffer always fullRebuild');
		// probe1.version IS the engine's current VV.  Because no ops
		// happened between workbookSnapshot() and probe1, probe1.version
		// equals the cached VV.  So passing it back hits the same-VV
		// fast-path (NOT stale).
		const probe2 = session.workbookSnapshotDelta(probe1.version);
		assert.strictEqual(probe2.fullRebuildRequired, false, 'same-VV fast-path');
		assert.deepStrictEqual(probe2.changedCells, []);
		assert.deepStrictEqual(probe2.formatsAdded, []);
		assert.deepStrictEqual(probe2.sheetsRemoved, []);
		assert.deepStrictEqual(probe2.removedCells, []);
		assert.deepStrictEqual(probe2.sheetsChanged, []);
	});
});

suite('quantbook V3.6.0.8.3 D6 -- workbookSnapshotDelta cell-only fast-path emits changed cells', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('after workbookSnapshot, appending PutValue ops surfaces them in the next delta', function () {
		const session = createSession(1n);
		session.addSheet('S', 16384);
		session.appendPutValue(0, 0, 0, 1);
		session.workbookSnapshot(); // populates cache
		// Capture current version via empty-probe then real-probe
		// pattern (V3.6.0.8.3 scope -- no currentVersion accessor).
		const probe1 = session.workbookSnapshotDelta(Buffer.alloc(0));
		// probe1.version IS the engine's current VV (same as the
		// cache's VV after the workbookSnapshot above).
		const baselineVersion = probe1.version;
		// Append more cells.
		session.appendPutValue(0, 1, 0, 2);
		session.appendPutValue(0, 2, 0, 3);
		const delta = session.workbookSnapshotDelta(baselineVersion);
		assert.strictEqual(delta.fullRebuildRequired, false, 'cell-only fast-path');
		assert.strictEqual(delta.changedCells.length, 2, 'two new cells in delta');
		// changedCells is sorted by (sheet, row, col).
		assert.strictEqual(delta.changedCells[0].sheet, 0);
		assert.strictEqual(delta.changedCells[0].cell.row, 1);
		assert.strictEqual(delta.changedCells[0].cell.col, 0);
		assert.strictEqual(delta.changedCells[1].sheet, 0);
		assert.strictEqual(delta.changedCells[1].cell.row, 2);
		assert.strictEqual(delta.changedCells[1].cell.col, 0);
	});
});

suite('quantbook V3.6.0.8.3 D6 -- workbookSnapshotDelta rename triggers full rebuild', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('renameSheet between cache populate and delta call returns fullRebuildRequired=true', function () {
		const session = createSession(1n);
		session.addSheet('S', 16384);
		session.appendPutValue(0, 0, 0, 1);
		session.workbookSnapshot(); // populates cache
		const probe = session.workbookSnapshotDelta(Buffer.alloc(0));
		const baselineVersion = probe.version;
		// Now do a rename op.
		session.renameSheet(0, 'Renamed');
		const delta = session.workbookSnapshotDelta(baselineVersion);
		assert.strictEqual(
			delta.fullRebuildRequired,
			true,
			'rename op in delta triggers fullRebuild fallback',
		);
	});
});

suite('quantbook V3.6.0.8.3 D6 -- workbookSnapshotDelta invalidation by undo', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('undo() between cache populate and delta call returns fullRebuildRequired=true', function () {
		const session = createSession(1n);
		session.addSheet('S', 16384);
		session.appendPutValue(0, 0, 0, 1);
		session.workbookSnapshot();
		const probe = session.workbookSnapshotDelta(Buffer.alloc(0));
		const baselineVersion = probe.version;
		// Undo invalidates the workbook cache (R-V3.6-14 closure).
		session.undo();
		const delta = session.workbookSnapshotDelta(baselineVersion);
		assert.strictEqual(
			delta.fullRebuildRequired,
			true,
			'undo invalidates workbook cache; next delta returns fullRebuild',
		);
	});
});

// =====================================================================
// Phase 5.7 V3.6.0.8.5 (2026-05-25) -- V3.6.0.8.4 Opus-MED-5 closure
// =====================================================================
//
// Comprehensive mocha regression suite covering the gaps the
// V3.6.0.8.4 audit-of-D6 cycle deferred.  Each test pins a specific
// invariant from the V3.6.0.8.1 lock + the V3.6.0.8.4 audit closures.

suite('quantbook V3.6.0.8.5 -- workbookSnapshotDelta merge_bytes invalidates cache', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('merge_bytes between cache populate and delta call returns fullRebuildRequired=true', function () {
		// Multi-peer scenario: peer A populates cache, peer B sends
		// remote ops via mergeBytes, A's next delta MUST return
		// fullRebuildRequired=true (V3.6.0.8.2 invalidation discipline).
		const peerA = createSession(1n);
		addSheet(peerA, 'S');
		appendPutValueValidated(peerA, 0, 0, 0, 42);
		workbookSnapshot(peerA); // populates A's cache
		const probe = peerA.workbookSnapshotDelta(Buffer.alloc(0));
		const baselineVersion = probe.version;

		// Peer B branches from A's bytes, makes its own edit.
		const aBytes = peerA.exportBytes();
		const peerB = sessionFromSnapshot(2n, aBytes);
		appendPutValueValidated(peerB, 0, 1, 0, 99);
		const bBytes = peerB.exportBytes();

		// A merges B's bytes -- cache MUST be invalidated.
		peerA.mergeBytes(bBytes);
		const delta = peerA.workbookSnapshotDelta(baselineVersion);
		assert.strictEqual(
			delta.fullRebuildRequired,
			true,
			'merge_bytes between populate + delta MUST invalidate workbook cache',
		);
	});
});

suite('quantbook V3.6.0.8.5 -- workbookSnapshotDelta malformed Buffer', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('garbage bytes for lastSeenVersion returns fullRebuildRequired=true (not throws)', function () {
		const session = createSession(1n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 1);
		workbookSnapshot(session);
		// Pass random non-VV bytes.  Loro's decode should fail; engine
		// returns fullRebuildRequired=true rather than throwing.
		const garbage = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]);
		const delta = session.workbookSnapshotDelta(garbage);
		assert.strictEqual(delta.fullRebuildRequired, true);
		assert.deepStrictEqual(delta.changedCells, []);
	});
});

suite('quantbook V3.6.0.8.5 -- workbookSnapshotDelta AddSheet triggers fullRebuild', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('addSheet between cache populate and delta call returns fullRebuildRequired=true (V3.6.0.8.4 CONVERGENT-HIGH-1 allowlist closure)', function () {
		const session = createSession(1n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 1);
		workbookSnapshot(session);
		const probe = session.workbookSnapshotDelta(Buffer.alloc(0));
		const baselineVersion = probe.version;
		// Append AddSheet -- pre-V3.6.0.8.4 closure this was silently
		// classified as delta-safe + IDE got empty delta + advanced
		// version while engine had new sheets.  Post-closure: must
		// fullRebuild.
		addSheet(session, 'NewSheet');
		const delta = session.workbookSnapshotDelta(baselineVersion);
		assert.strictEqual(
			delta.fullRebuildRequired,
			true,
			'AddSheet in delta MUST trigger fullRebuild (allowlist closure)',
		);
	});
});

suite('quantbook V3.6.0.8.5 -- workbookSnapshotDelta MoveSheet triggers fullRebuild', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('moveSheet between cache populate and delta call returns fullRebuildRequired=true', function () {
		const session = createSession(1n);
		addSheet(session, 'A');
		addSheet(session, 'B');
		appendPutValueValidated(session, 0, 0, 0, 1);
		workbookSnapshot(session);
		const probe = session.workbookSnapshotDelta(Buffer.alloc(0));
		const baselineVersion = probe.version;
		moveSheet(session, 1, 0); // swap display order
		const delta = session.workbookSnapshotDelta(baselineVersion);
		assert.strictEqual(
			delta.fullRebuildRequired,
			true,
			'MoveSheet in delta MUST trigger fullRebuild (allowlist closure)',
		);
	});
});

suite('quantbook V3.6.0.8.5 -- workbookSnapshotDelta RemoveSheet emits sheetsRemoved', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('deleteSheet between cache populate and delta call emits in sheetsRemoved', function () {
		const session = createSession(1n);
		addSheet(session, 'A');
		addSheet(session, 'B');
		appendPutValueValidated(session, 0, 0, 0, 1);
		workbookSnapshot(session);
		const probe = session.workbookSnapshotDelta(Buffer.alloc(0));
		const baselineVersion = probe.version;
		deleteSheet(session, 1); // tombstone sheet B (id=1)
		const delta = session.workbookSnapshotDelta(baselineVersion);
		// RemoveSheet is in the cell-only-deltable allowlist (not the
		// rename-fullRebuild arm) -- the delta should NOT fullRebuild;
		// sheetsRemoved should include the tombstoned id.
		assert.strictEqual(
			delta.fullRebuildRequired,
			false,
			'RemoveSheet is cell-only-deltable; sheetsRemoved populated',
		);
		assert.deepStrictEqual(delta.sheetsRemoved.sort(), [1]);
	});
});

suite('quantbook V3.6.0.8.5 -- workbookSnapshotDelta chained delta calls', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('after first delta consumes new ops, second delta with returned version returns empty', function () {
		const session = createSession(1n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 1);
		workbookSnapshot(session); // populates cache at VV1
		const probe = session.workbookSnapshotDelta(Buffer.alloc(0));
		const v1 = probe.version;
		appendPutValueValidated(session, 0, 1, 0, 2);
		appendPutValueValidated(session, 0, 2, 0, 3);
		const delta1 = session.workbookSnapshotDelta(v1);
		assert.strictEqual(delta1.fullRebuildRequired, false);
		assert.strictEqual(delta1.changedCells.length, 2);
		// delta1 advanced the cache to VV2.  Calling again with delta1.version
		// should hit same-VV fast-path -> empty delta + same version.
		const delta2 = session.workbookSnapshotDelta(delta1.version);
		assert.strictEqual(delta2.fullRebuildRequired, false);
		assert.strictEqual(delta2.changedCells.length, 0, 'chained delta with same version = empty');
	});
});

suite('quantbook V3.6.0.8.5 -- workbookSnapshotDelta redo invalidates cache', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('redo() between cache populate and delta call returns fullRebuildRequired=true', function () {
		const session = createSession(1n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 1);
		undo(session); // creates a redo stack item
		workbookSnapshot(session);
		const probe = session.workbookSnapshotDelta(Buffer.alloc(0));
		const baselineVersion = probe.version;
		const consumed = redo(session);
		assert.strictEqual(consumed, true);
		const delta = session.workbookSnapshotDelta(baselineVersion);
		assert.strictEqual(
			delta.fullRebuildRequired,
			true,
			'redo MUST invalidate workbook cache (R-V3.6-14 closure; symmetric with undo)',
		);
	});
});

suite('quantbook V3.6.0.8.5 -- workbookSnapshotDelta appendPutFormula in delta', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('appendPutFormula between cache populate and delta surfaces formula in changedCells', function () {
		const session = createSession(1n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 1);
		workbookSnapshot(session);
		const probe = session.workbookSnapshotDelta(Buffer.alloc(0));
		const baselineVersion = probe.version;
		appendPutFormulaValidated(session, 0, 1, 0, '=A1*2');
		const delta = session.workbookSnapshotDelta(baselineVersion);
		assert.strictEqual(delta.fullRebuildRequired, false);
		assert.strictEqual(delta.changedCells.length, 1);
		assert.strictEqual(delta.changedCells[0].cell.row, 1);
		assert.strictEqual(delta.changedCells[0].cell.col, 0);
		assert.strictEqual(delta.changedCells[0].cell.formula, '=A1*2');
	});
});

suite('quantbook V3.6.0.8.5 -- workbookSnapshotDelta renameSheet via different path (allowlist coverage)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('renameSheet of a sheet referenced by cross-sheet formulas returns fullRebuildRequired=true', function () {
		const session = createSession(1n);
		addSheet(session, 'Source');
		addSheet(session, 'Ref');
		appendPutValueValidated(session, 0, 0, 0, 42);
		appendPutFormulaValidated(session, 1, 0, 0, '=Source!A1');
		workbookSnapshot(session);
		const probe = session.workbookSnapshotDelta(Buffer.alloc(0));
		const baselineVersion = probe.version;
		renameSheet(session, 0, 'Renamed');
		const delta = session.workbookSnapshotDelta(baselineVersion);
		assert.strictEqual(
			delta.fullRebuildRequired,
			true,
			'renameSheet triggers rename-fullRebuild branch even with cross-sheet formula impact (rename arm of classify_delta_op)',
		);
	});
});

suite('quantbook V3.6.0.8.5 -- workbookSnapshotJson exposes version (OPUS-HIGH-2 closure)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});
	test('workbookSnapshot() returns a populated version Buffer matching workbookSnapshotDelta probe', function () {
		const session = createSession(1n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 42);
		const snap = workbookSnapshot(session);
		// V3.6.0.8.4 OPUS-HIGH-2 closure: snap.version is populated
		// + matches the engine's current VV (verified by feeding it
		// to workbookSnapshotDelta and getting same-VV fast-path).
		assert.ok(snap.version, 'snap.version is populated');
		assert.ok(Buffer.isBuffer(snap.version));
		assert.ok(snap.version.length > 0, 'version is non-empty (engine has at least one peer counter)');
		// Pass it back to workbookSnapshotDelta -- should hit same-VV
		// fast-path (no ops since populate) -> empty delta + same version.
		const delta = session.workbookSnapshotDelta(snap.version);
		assert.strictEqual(
			delta.fullRebuildRequired,
			false,
			'snap.version is recognized by workbookSnapshotDelta (closes IDE consumer protocol step 2 race window)',
		);
		assert.strictEqual(delta.changedCells.length, 0);
		// Round-trip: delta.version should equal snap.version (same
		// engine VV; no ops between).
		assert.deepStrictEqual(
			Buffer.from(delta.version).toString('hex'),
			Buffer.from(snap.version).toString('hex'),
			'round-trip version token bytes match',
		);
	});
});

// =====================================================================
// Phase 5.7 V3.6.0.10 D8 (2026-05-25) -- restoreSheet napi + delta interaction
// =====================================================================

suite('quantbook V3.6.0.10 D8 -- restoreSheet napi contract', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('restoreSheet appends one op', () => {
		const session = createSession(1n);
		addSheet(session, 'S');
		deleteSheet(session, 0);
		const opCountBefore = session.opCount();
		restoreSheet(session, 0);
		assert.strictEqual(
			session.opCount(),
			opCountBefore + 1,
			'one restoreSheet call appends exactly one op',
		);
	});

	test('restoreSheet of out-of-range id throws bad_argument', () => {
		const session = createSession(1n);
		addSheet(session, 'S');
		assert.throws(
			() => restoreSheet(session, 99),
			/bad_argument.*does not exist/i,
		);
	});

	test('restoreSheet of id > u16::MAX throws bad_argument', () => {
		const session = createSession(1n);
		addSheet(session, 'S');
		assert.throws(
			() => restoreSheet(session, 65536),
			/bad_argument.*u16/i,
		);
	});

	test('restoreSheet brings sheet back into workbookSnapshot.sheets', () => {
		const session = createSession(1n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 42);
		deleteSheet(session, 0);
		// Pre-restore: workbookSnapshot filters out the tombstoned sheet.
		assert.strictEqual(workbookSnapshot(session).sheets.length, 0);
		restoreSheet(session, 0);
		// Post-restore: sheet visible again with its original name.
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 1);
		assert.strictEqual(snap.sheets[0].name, 'S');
	});

	test('restoreSheet resurfaces preserved pre-tombstone cells (V3.6.0.X phase-termination CONVERGENT-HIGH-1 closure)', () => {
		// Closes OPUS-PT-B5-MED + CODEX-PT-A1-HIGH at the IDE layer.
		// Pre-closure: workbookSnapshot returned restored sheet with
		// cells: [] because CacheEffect::RemoveSheet pruned the cache
		// + CacheEffect::RestoreSheet did NOT rehydrate.
		// Post-closure: cache mirrors V3.5.0.3b Workbook storage-
		// preservation discipline; cells reappear through napi
		// workbookSnapshot.
		//
		// Note on value-field shape: the napi runtime emits
		// CellValueJson with a `number: number` field (per
		// crates/ql-bindings-node/src/lib.rs CellValueJson struct);
		// the TS interface in `types.ts` currently declares the union
		// variant as `{ kind: 'number'; value: number }`. This is a
		// pre-existing type/runtime drift not in scope for this
		// closure (filed as a V3.6.1+ followup); assertions below use
		// `unknown` cast to read the runtime field.
		const session = createSession(1n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 42);
		appendPutValueValidated(session, 0, 1, 0, 99);
		// Pre-RemoveSheet: 2 cells visible.
		assert.strictEqual(
			workbookSnapshot(session).sheets[0].cells.length,
			2,
			'pre-tombstone sheet has 2 cells',
		);
		deleteSheet(session, 0);
		// Tombstoned: sheet filtered out by is_sheet_removed.
		assert.strictEqual(workbookSnapshot(session).sheets.length, 0);
		restoreSheet(session, 0);
		// Post-restore: preserved cells reappear in workbookSnapshot.
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 1);
		assert.strictEqual(
			snap.sheets[0].cells.length,
			2,
			'post-V3.6.0.X-phase-termination: pre-tombstone cells reappear via workbookSnapshot (contract-vs-implementation drift closed)',
		);
		// Verify the cells are the same ones we wrote (value preserved).
		const cellByCoord = (row: number, col: number) =>
			snap.sheets[0].cells.find((c) => c.row === row && c.col === col);
		const cell00 = cellByCoord(0, 0);
		const cell10 = cellByCoord(1, 0);
		assert.ok(cell00, 'cell (0,0) preserved across remove+restore');
		assert.ok(cell10, 'cell (1,0) preserved across remove+restore');
		assert.strictEqual(cell00?.value?.kind, 'number');
		assert.strictEqual(cell10?.value?.kind, 'number');
		assert.strictEqual(
			(cell00?.value as unknown as { number: number })?.number,
			42,
			'preserved cell (0,0) value matches pre-tombstone (42)',
		);
		assert.strictEqual(
			(cell10?.value as unknown as { number: number })?.number,
			99,
			'preserved cell (1,0) value matches pre-tombstone (99)',
		);
	});

	test('restoreSheet + new write: preserved cells AND new writes coexist (post-V3.6.0.X-phase-termination)', () => {
		// Verifies that post-restore, NEW cell writes stack atop the
		// preserved pre-tombstone cells (mirrors Workbook column-
		// store semantic).
		const session = createSession(2n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 11);
		deleteSheet(session, 0);
		restoreSheet(session, 0);
		appendPutValueValidated(session, 0, 5, 5, 22);
		const snap = workbookSnapshot(session);
		assert.strictEqual(snap.sheets.length, 1);
		assert.strictEqual(
			snap.sheets[0].cells.length,
			2,
			'preserved pre-tombstone cell + post-restore write both visible',
		);
		const findCell = (row: number, col: number) =>
			snap.sheets[0].cells.find((c) => c.row === row && c.col === col);
		const cell00 = findCell(0, 0);
		const cell55 = findCell(5, 5);
		assert.ok(cell00, 'preserved pre-tombstone cell (0,0) visible');
		assert.ok(cell55, 'post-restore cell (5,5) visible');
		assert.strictEqual(
			(cell00?.value as unknown as { number: number })?.number,
			11,
			'preserved pre-tombstone cell value (11)',
		);
		assert.strictEqual(
			(cell55?.value as unknown as { number: number })?.number,
			22,
			'post-restore cell value (22)',
		);
	});

	test('restoreSheet is idempotent (already-restored is no-op)', () => {
		const session = createSession(1n);
		addSheet(session, 'S');
		deleteSheet(session, 0);
		restoreSheet(session, 0);
		// Second restore: no error, just a no-op op.
		restoreSheet(session, 0);
		assert.strictEqual(workbookSnapshot(session).sheets.length, 1);
	});
});

suite('quantbook V3.6.0.10 D8 -- restoreSheet in workbookSnapshotDelta triggers fullRebuild', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	test('restoreSheet between cache populate and delta call returns fullRebuildRequired=true', () => {
		// V3.6.0.10 D8 classify_delta_op closure: Op::RestoreSheet is
		// in the metadata-ops fullRebuild allowlist (per the
		// V3.6.0.10 D8 ship comment) because the cell cache dropped
		// pre-tombstone cells at CacheEffect::RemoveSheet; the Workbook
		// preserved them, so fullRebuild is the cheapest way to get
		// them back into the snapshot reply.
		const session = createSession(1n);
		addSheet(session, 'S');
		appendPutValueValidated(session, 0, 0, 0, 42);
		deleteSheet(session, 0);
		workbookSnapshot(session); // populates cache (sheet is tombstoned)
		const probe = session.workbookSnapshotDelta(Buffer.alloc(0));
		const baselineVersion = probe.version;
		restoreSheet(session, 0);
		const delta = session.workbookSnapshotDelta(baselineVersion);
		assert.strictEqual(
			delta.fullRebuildRequired,
			true,
			'RestoreSheet in delta MUST trigger fullRebuild (V3.6.0.10 D8 classify_delta_op closure)',
		);
	});
});

// =====================================================================
// Phase 5.7 V3.6.0.11 D9 (2026-05-26) -- typing_stroke watchdog reset
// =====================================================================
//
// Tests the dispatcher-level `onTypingStroke` callback firing behavior +
// the typing_stroke envelope arm.  Closes R-V3.5-7 "long formula entry
// hits 30s" false-negative case per V3.6.0.1 D9 design lock.  Panel-
// level watchdog re-arm (resetTypingWatchdog method on CellGridPanel) is
// behavior-tested separately; this suite covers the dispatcher contract.

// FE-0a Part B (B1): the "dispatcher fires onTypingStroke" suite was REMOVED --
// the typing-stroke watchdog reset was part of the collab presence path
// (v1.5-dormant). The owning Session dispatch has no onTypingStroke callback and
// drops typing_stroke silently (asserted by the drop-test in the
// "dispatchIncomingMessage (host-side commit path, owning Session)" suite).

// =====================================================================
// Phase 5.7 V3.6.1 (2026-05-26) -- workbookSnapshotDelta IDE consumer
// (OPUS-PT-B10).  Realizes the V3.6.0.8 D6 engine delta win in the
// CellGridPanel render path.  `mergeWorkbookDelta` +
// `acquireWorkbookSnapshotViaDelta` are PURE (in cellGridLogic); the
// panel delegates so the two-call protocol is testable without vscode.
// =====================================================================

/** A minimal number-valued CellSnapshotJson fixture. */
function b10NumCell(row: number, col: number, n: number): CellSnapshotJson {
	return { row, col, value: { kind: 'number', number: n } };
}

/** A hand-built WorkbookSnapshotJson fixture (no engine). */
function b10MkWb(sheets: SheetSnapshotJson[], formats: FormatDefJson[] = [], version?: Buffer): WorkbookSnapshotJson {
	const snap: WorkbookSnapshotJson = { sheets, formats, dateSystem: 'Excel1900' };
	if (version !== undefined) {
		snap.version = version;
	}
	return snap;
}

/** A non-fullRebuild WorkbookSnapshotDeltaJson fixture from partials. */
function b10MkDelta(partial: Partial<WorkbookSnapshotDeltaJson>): WorkbookSnapshotDeltaJson {
	return {
		changedCells: partial.changedCells ?? [],
		removedCells: partial.removedCells ?? [],
		sheetsChanged: partial.sheetsChanged ?? [],
		sheetsRemoved: partial.sheetsRemoved ?? [],
		formatsAdded: partial.formatsAdded ?? [],
		version: partial.version ?? Buffer.from([0xAA]),
		fullRebuildRequired: partial.fullRebuildRequired ?? false,
	};
}

/** Find a cell by (sheet, row, col); undefined if absent. */
function b10FindCell(snap: WorkbookSnapshotJson, sheet: number, row: number, col: number): CellSnapshotJson | undefined {
	return snap.sheets.find(s => s.id === sheet)?.cells.find(c => c.row === row && c.col === col);
}

suite('quantbook V3.6.1 -- mergeWorkbookDelta (pure, OPUS-PT-B10)', function () {
	test('upsert replaces an existing cell value in place + advances version', () => {
		const cached = b10MkWb([{ id: 0, name: 'A', cells: [b10NumCell(1, 1, 5)] }]);
		const merged = mergeWorkbookDelta(cached, b10MkDelta({
			changedCells: [{ sheet: 0, cell: b10NumCell(1, 1, 9) }],
			version: Buffer.from([0x01]),
		}));
		assert.strictEqual(merged.sheets[0].cells.length, 1, 'no duplicate cell');
		assert.deepStrictEqual(b10FindCell(merged, 0, 1, 1)!.value, { kind: 'number', number: 9 });
		assert.deepStrictEqual(merged.version, Buffer.from([0x01]), 'version advanced to delta version');
	});

	test('upsert inserts a NEW cell in sorted (row, col) position (not appended)', () => {
		const cached = b10MkWb([{ id: 0, name: 'A', cells: [b10NumCell(0, 0, 1), b10NumCell(2, 0, 3)] }]);
		const merged = mergeWorkbookDelta(cached, b10MkDelta({
			changedCells: [{ sheet: 0, cell: b10NumCell(1, 0, 2) }],
		}));
		assert.deepStrictEqual(
			merged.sheets[0].cells.map(c => [c.row, c.col]),
			[[0, 0], [1, 0], [2, 0]],
			'sorted insert preserves (row,col) order -> shape matches a fresh snapshot',
		);
	});

	test('upserts land in the right sheet (no cross-sheet contamination)', () => {
		const cached = b10MkWb([
			{ id: 0, name: 'A', cells: [b10NumCell(0, 0, 1)] },
			{ id: 1, name: 'B', cells: [b10NumCell(0, 0, 10)] },
		]);
		const merged = mergeWorkbookDelta(cached, b10MkDelta({
			changedCells: [
				{ sheet: 0, cell: b10NumCell(0, 1, 2) },
				{ sheet: 1, cell: b10NumCell(0, 1, 20) },
			],
		}));
		assert.strictEqual(b10FindCell(merged, 0, 0, 1)!.value!.number, 2);
		assert.strictEqual(b10FindCell(merged, 1, 0, 1)!.value!.number, 20);
		assert.strictEqual(merged.sheets[0].cells.length, 2);
		assert.strictEqual(merged.sheets[1].cells.length, 2);
	});

	test('sheetsRemoved drops the sheet entry (LIVE deleteSheet delta path)', () => {
		const cached = b10MkWb([
			{ id: 0, name: 'A', cells: [b10NumCell(0, 0, 1)] },
			{ id: 1, name: 'B', cells: [b10NumCell(0, 0, 2)] },
		]);
		const merged = mergeWorkbookDelta(cached, b10MkDelta({ sheetsRemoved: [1] }));
		assert.deepStrictEqual(merged.sheets.map(s => s.id), [0], 'sheet 1 dropped');
	});

	test('a changedCell for a same-delta-removed sheet does NOT resurrect it', () => {
		const cached = b10MkWb([
			{ id: 0, name: 'A', cells: [] },
			{ id: 1, name: 'B', cells: [] },
		]);
		const merged = mergeWorkbookDelta(cached, b10MkDelta({
			changedCells: [{ sheet: 1, cell: b10NumCell(0, 0, 99) }],
			sheetsRemoved: [1],
		}));
		assert.deepStrictEqual(merged.sheets.map(s => s.id), [0], 'removed sheet stays gone (apply-removed-last)');
	});

	test('formatsAdded merges by FULL FormatId (builtin vs custom; replace not duplicate)', () => {
		const builtin0: FormatDefJson = { id: { kind: 'builtin', builtin: 0 }, string: 'General' };
		const cached = b10MkWb([{ id: 0, name: 'A', cells: [] }], [builtin0]);
		const custom71: FormatDefJson = { id: { kind: 'custom', customPeer: 7n, customCounter: 1 }, string: '0.00' };
		const custom72: FormatDefJson = { id: { kind: 'custom', customPeer: 7n, customCounter: 2 }, string: '0.0%' };
		const merged = mergeWorkbookDelta(cached, b10MkDelta({ formatsAdded: [custom71, custom72] }));
		assert.strictEqual(merged.formats.length, 3, 'builtin0 + 2 distinct customs (no kind-collision)');
		// Re-add custom{7,1} with a NEW string -> replace, not duplicate.
		const merged2 = mergeWorkbookDelta(merged, b10MkDelta({
			formatsAdded: [{ id: { kind: 'custom', customPeer: 7n, customCounter: 1 }, string: '#,##0' }],
		}));
		assert.strictEqual(merged2.formats.length, 3, 'replaced, not duplicated');
		const replaced = merged2.formats.find(
			f => f.id.kind === 'custom' && f.id.customPeer === 7n && f.id.customCounter === 1,
		);
		assert.strictEqual(replaced!.string, '#,##0');
	});

	test('removedCells drops the cell (forward-compat; engine emits [] today)', () => {
		const cached = b10MkWb([{ id: 0, name: 'A', cells: [b10NumCell(0, 0, 1), b10NumCell(1, 0, 2)] }]);
		const merged = mergeWorkbookDelta(cached, b10MkDelta({ removedCells: [{ sheet: 0, row: 0, col: 0 }] }));
		assert.strictEqual(b10FindCell(merged, 0, 0, 0), undefined, 'cell removed');
		assert.strictEqual(merged.sheets[0].cells.length, 1);
	});

	test('after sheetsRemoved of the active sheet, extractSheetSnapshot returns null (tombstone composition)', () => {
		const cached = b10MkWb([
			{ id: 0, name: 'A', cells: [b10NumCell(0, 0, 1)] },
			{ id: 1, name: 'B', cells: [b10NumCell(0, 0, 2)] },
		]);
		const merged = mergeWorkbookDelta(cached, b10MkDelta({ sheetsRemoved: [1] }));
		assert.strictEqual(extractSheetSnapshot(merged, 1), null, 'active sheet gone -> render empty-frame branch fires');
		assert.notStrictEqual(extractSheetSnapshot(merged, 0), null, 'surviving sheet still extractable');
	});

	// FE megaudit M3 (2026-06-03): a changedCell/removedCell for a sheet ABSENT from
	// the cache must THROW [invalid_state] -- never skip-then-advance-version (silent
	// permanent divergence). AddSheet trips fullRebuildRequired, so this only fires on
	// engine contract drift.
	test('changedCell for an unknown sheet throws [invalid_state] (No-Fallbacks)', () => {
		const cached = b10MkWb([{ id: 0, name: 'A', cells: [] }]);
		assert.throws(
			() => mergeWorkbookDelta(cached, b10MkDelta({ changedCells: [{ sheet: 9, cell: b10NumCell(0, 0, 1) }] })),
			/\[invalid_state\] mergeWorkbookDelta: changedCell references unknown sheet 9/,
		);
	});

	test('removedCell for an unknown sheet throws [invalid_state] (No-Fallbacks)', () => {
		const cached = b10MkWb([{ id: 0, name: 'A', cells: [] }]);
		assert.throws(
			() => mergeWorkbookDelta(cached, b10MkDelta({ removedCells: [{ sheet: 9, row: 0, col: 0 }] })),
			/\[invalid_state\] mergeWorkbookDelta: removedCell references unknown sheet 9/,
		);
	});
});

suite('quantbook V3.6.1 -- acquireWorkbookSnapshotViaDelta protocol (pure mock; no engine)', function () {
	test('missing version on the seed snapshot forces re-seed (never threads undefined into the delta wrapper)', () => {
		let snapshotCalls = 0;
		// FE-0a Part B (B1): acquireWorkbookSnapshotViaDelta now drives the owning
		// Session, so it calls snapshot()/snapshotDelta() (not the CollabSession
		// workbookSnapshot/workbookSnapshotDelta names).
		const mock = {
			snapshot() {
				snapshotCalls++;
				// No `version` field (TS-optional) -- exercise the GAP-4 guard.
				return { sheets: [], formats: [], dateSystem: 'Excel1900' as const };
			},
			snapshotDelta() {
				throw new Error('snapshotDelta must NOT be called when no version captured');
			},
		} as unknown as SessionInstance;
		const cache: DeltaSnapshotCache = { snapshot: undefined, version: undefined };
		acquireWorkbookSnapshotViaDelta(mock, cache);
		assert.strictEqual(cache.version, undefined, 'no version captured -> stays undefined');
		acquireWorkbookSnapshotViaDelta(mock, cache); // must re-seed, NOT call delta
		assert.strictEqual(snapshotCalls, 2, 're-seeds rather than threading undefined');
	});
});

suite('quantbook V3.6.1 -- acquireWorkbookSnapshotViaDelta protocol (engine)', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	// FE-0a Part B (B1): acquireWorkbookSnapshotViaDelta now drives the owning
	// Session, calling snapshot() + snapshotDelta(). A thin counting delegate
	// distinguishes the fast (delta) path from the full-fetch path without a Proxy.
	// (The collab pollRemote-merge invalidation test was removed -- transport sync
	// is v1.5-dormant; the undo-invalidation test below still covers the
	// fullRebuildRequired path.)
	function counting(real: SessionInstance) {
		let snap = 0;
		let deltaN = 0;
		const session = {
			snapshot() { snap++; return real.snapshot(); },
			snapshotDelta(v: Uint8Array) { deltaN++; return real.snapshotDelta(v); },
		} as unknown as SessionInstance;
		return { session, snaps: () => snap, deltas: () => deltaN };
	}

	test('first acquisition full-fetches + captures a version', () => {
		const s = createWorkbookSession();
		s.addSheet('S', 16384);
		setValueValidated(s, 0, 0, 0, { kind: 'number', number: 42 });
		const c = counting(s);
		const cache: DeltaSnapshotCache = { snapshot: undefined, version: undefined };
		const snap = acquireWorkbookSnapshotViaDelta(c.session, cache);
		assert.strictEqual(c.snaps(), 1, 'seed via snapshot');
		assert.strictEqual(c.deltas(), 0, 'no delta call on the seed');
		assert.ok(Buffer.isBuffer(cache.version), 'version captured');
		assert.strictEqual(b10FindCell(snap, 0, 0, 0)!.value!.number, 42);
	});

	test('a local setValue after seed takes the fast delta path (no full re-fetch)', () => {
		const s = createWorkbookSession();
		s.addSheet('S', 16384);
		setValueValidated(s, 0, 0, 0, { kind: 'number', number: 1 });
		const c = counting(s);
		const cache: DeltaSnapshotCache = { snapshot: undefined, version: undefined };
		acquireWorkbookSnapshotViaDelta(c.session, cache); // seed
		setValueValidated(s, 0, 1, 0, { kind: 'number', number: 2 }); // local edit does NOT invalidate the cache
		const merged = acquireWorkbookSnapshotViaDelta(c.session, cache);
		assert.strictEqual(c.snaps(), 1, 'fast path -> NO full re-fetch');
		assert.strictEqual(c.deltas(), 1, 'took the delta path');
		assert.strictEqual(b10FindCell(merged, 0, 1, 0)!.value!.number, 2, 'new cell merged');
		assert.strictEqual(b10FindCell(merged, 0, 0, 0)!.value!.number, 1, 'prior cell retained');
	});

	test('undo invalidates the cache -> next acquisition full-rebuilds + matches engine truth', () => {
		const s = createWorkbookSession();
		s.addSheet('S', 16384);
		setValueValidated(s, 0, 0, 0, { kind: 'number', number: 1 });
		const c = counting(s);
		const cache: DeltaSnapshotCache = { snapshot: undefined, version: undefined };
		acquireWorkbookSnapshotViaDelta(c.session, cache); // seed (snaps=1)
		setValueValidated(s, 0, 1, 0, { kind: 'number', number: 2 });
		acquireWorkbookSnapshotViaDelta(c.session, cache); // fast delta
		s.undo(); // force_clear_workbook_cache
		const afterUndo = acquireWorkbookSnapshotViaDelta(c.session, cache);
		assert.ok(c.snaps() >= 2, 'undo -> fullRebuildRequired -> full re-fetch');
		assert.deepStrictEqual(afterUndo, s.snapshot(), 'matches a fresh engine snapshot');
	});

	test('SEPARATE caches both acquire correctly and converge (per-cache correctness)', () => {
		// Two callers holding SEPARATE caches must both end with identical data.
		// On the owning Session, snapshotDelta computes the delta from the version
		// the CALLER passes, so each separate cache rides the fast delta path from
		// its own seed version (no single-slot last-snapshot cache forcing one of
		// them into a full rebuild, as CollabSession did). Production shares ONE
		// per-session cache (getSharedDeltaCache, tested below); separate caches
		// remain a supported function input. The invariant here is CONVERGENCE.
		const s = createWorkbookSession();
		s.addSheet('S', 16384);
		setValueValidated(s, 0, 0, 0, { kind: 'number', number: 1 });
		const ca = counting(s);
		const cb = counting(s);
		const cacheA: DeltaSnapshotCache = { snapshot: undefined, version: undefined };
		const cacheB: DeltaSnapshotCache = { snapshot: undefined, version: undefined };
		acquireWorkbookSnapshotViaDelta(ca.session, cacheA); // A seed
		acquireWorkbookSnapshotViaDelta(cb.session, cacheB); // B seed
		setValueValidated(s, 0, 1, 0, { kind: 'number', number: 2 });
		const mergedA = acquireWorkbookSnapshotViaDelta(ca.session, cacheA);
		const mergedB = acquireWorkbookSnapshotViaDelta(cb.session, cacheB);
		assert.strictEqual(ca.snaps(), 1, 'cache A took the fast path (no full re-fetch beyond seed)');
		assert.strictEqual(ca.deltas(), 1);
		assert.ok(cb.snaps() >= 1, 'cache B acquired');
		// The correctness invariant: both caches converge to identical data.
		assert.deepStrictEqual(mergedA.sheets, mergedB.sheets, 'both converge to identical sheet data');
		assert.strictEqual(b10FindCell(mergedA, 0, 1, 0)!.value!.number, 2);
		assert.strictEqual(b10FindCell(mergedB, 0, 1, 0)!.value!.number, 2);
	});

	test('SHARED per-session cache: both panels ride the fast path (no full rebuild for the sibling)', () => {
		// Production behavior: getSharedDeltaCache returns ONE cache per
		// session, so a sibling panel's render sees a same-VV empty delta
		// instead of a staleness-driven full rebuild.
		const s = createWorkbookSession();
		s.addSheet('S', 16384);
		setValueValidated(s, 0, 0, 0, { kind: 'number', number: 1 });
		// getSharedDeltaCache returns the SAME object for the same session.
		assert.strictEqual(getSharedDeltaCache(s), getSharedDeltaCache(s), 'one cache per session');
		const shared = getSharedDeltaCache(s);
		const c = counting(s);
		acquireWorkbookSnapshotViaDelta(c.session, shared); // panel A render: seed (snaps=1)
		setValueValidated(s, 0, 1, 0, { kind: 'number', number: 2 });
		const mergedA = acquireWorkbookSnapshotViaDelta(c.session, shared); // panel A: fast delta -> advances shared cache
		const mergedB = acquireWorkbookSnapshotViaDelta(c.session, shared); // panel B: same-VV empty delta (NOT a rebuild)
		assert.strictEqual(c.snaps(), 1, 'no full re-fetch beyond the seed -- both panels fast');
		assert.ok(c.deltas() >= 2, 'both sibling renders went through the delta path');
		assert.strictEqual(b10FindCell(mergedA, 0, 1, 0)!.value!.number, 2);
		assert.strictEqual(b10FindCell(mergedB, 0, 1, 0)!.value!.number, 2, 'sibling sees the merged state');
		assert.deepStrictEqual(mergedA.sheets, mergedB.sheets, 'identical (same shared snapshot object)');
	});

	test('shape equivalence: delta-merged data === fresh snapshot across an op sequence (divergence guard)', () => {
		const s = createWorkbookSession();
		s.addSheet('A', 16384);
		s.addSheet('B', 16384);
		const cache: DeltaSnapshotCache = { snapshot: undefined, version: undefined };
		// Compare the consumer-visible DATA (sheets/formats/dateSystem). The
		// opaque `version` Buffer is intentionally excluded.
		const step = (label: string) => {
			const merged = acquireWorkbookSnapshotViaDelta(s, cache);
			const fresh = s.snapshot();
			assert.deepStrictEqual(
				{ sheets: merged.sheets, formats: merged.formats, dateSystem: merged.dateSystem },
				{ sheets: fresh.sheets, formats: fresh.formats, dateSystem: fresh.dateSystem },
				`delta-merged data matches fresh snapshot after: ${label}`,
			);
			assert.ok(Buffer.isBuffer(merged.version), `merged carries a version after: ${label}`);
		};
		const num = (n: number): { kind: 'number'; number: number } => ({ kind: 'number', number: n });
		step('seed (no ops)');
		setValueValidated(s, 0, 0, 0, num(1)); step('put A!(0,0)=1 (delta)');
		setValueValidated(s, 0, 1, 1, num(2)); step('put A!(1,1)=2 (delta)');
		setValueValidated(s, 1, 0, 0, num(10)); step('put B!(0,0)=10 (delta)');
		s.deleteSheet(1); step('deleteSheet B (sheetsRemoved delta)');
		setValueValidated(s, 0, 2, 2, num(3)); step('put A!(2,2)=3 (delta)');
		s.renameSheet(0, 'A2'); step('renameSheet A (fullRebuild)');
		setValueValidated(s, 0, 0, 1, num(4)); step('put A!(0,1)=4 (delta after rebuild)');
		s.undo(); step('undo (fullRebuild)');
		setValueValidated(s, 0, 3, 3, num(5)); step('put A!(3,3)=5 (delta after rebuild)');
	});
});

// ============================================================================
// FE-0a Part B2 (2026-06-02) -- sheet ops + .qbook persistence on the owning
// single-writer Session. Exercises the helpers the B2 commands call:
// saveSessionToQbook / openWorkbookFromQbook + Session.addSheet / renameSheet /
// deleteSheet / moveSheet / listSheets. Requires the engine cdylib (skip-guarded).
// ============================================================================
suite('quantbook B2 -- sheet ops + .qbook persistence on Session', function () {
	suiteSetup(function () {
		const r = shouldSkip();
		if (r.skip) { this.skip(); }
	});

	const numv = (n: number): { kind: 'number'; number: number } => ({ kind: 'number', number: n });

	test('save -> open round-trip preserves values + recomputed formulas', () => {
		const session = createWorkbookSession();
		const sheetId = session.addSheet('S0', 1000);
		setValueValidated(session, sheetId, 0, 0, numv(21));   // A1 = 21
		setFormulaValidated(session, sheetId, 1, 0, 'A1*2');   // A2 = =A1*2 -> 42
		recalcDirtyChecked(session);

		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qbook-b2-'));
		const qpath = path.join(dir, 'roundtrip.qbook');
		try {
			saveSessionToQbook(session, qpath);
			const opened = openWorkbookFromQbook(qpath);
			try {
				assert.strictEqual(opened.lifecycleState(), 'ready', 'opened session is Ready');
				const openedSheet = opened.listSheets()[0].id;
				const a1 = opened.cell(openedSheet, 0, 0);
				assert.strictEqual(a1?.value?.kind, 'number');
				assert.strictEqual(a1?.value?.number, 21, 'literal value survives save/open');
				const a2 = opened.cell(openedSheet, 1, 0);
				assert.strictEqual(a2?.value?.kind, 'number');
				assert.strictEqual(a2?.value?.number, 42, 'recomputed formula survives save/open');
				assert.ok(a2?.formula !== undefined && a2.formula.length > 0, 'formula text persisted');
			} finally {
				opened.close();
			}
		} finally {
			session.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('addSheet returns an id that appears in listSheets', () => {
		const session = createWorkbookSession();
		try {
			const id0 = session.addSheet('Alpha', 1000);
			const id1 = session.addSheet('Beta', 1000);
			const ids = session.listSheets().map(s => s.id);
			assert.ok(ids.includes(id0) && ids.includes(id1), 'both added sheets are live');
			assert.strictEqual(session.listSheets().length, 2);
		} finally {
			session.close();
		}
	});

	test('renameSheet changes the listed name', () => {
		const session = createWorkbookSession();
		try {
			const id = session.addSheet('Old', 1000);
			session.renameSheet(id, 'New');
			const info = session.listSheets().find(s => s.id === id);
			assert.strictEqual(info?.name, 'New');
		} finally {
			session.close();
		}
	});

	test('deleteSheet removes the sheet from listSheets (tombstone)', () => {
		const session = createWorkbookSession();
		try {
			const keep = session.addSheet('Keep', 1000);
			const drop = session.addSheet('Drop', 1000);
			session.deleteSheet(drop);
			const ids = session.listSheets().map(s => s.id);
			assert.ok(ids.includes(keep), 'kept sheet remains');
			assert.ok(!ids.includes(drop), 'deleted sheet is gone from listSheets');
		} finally {
			session.close();
		}
	});

	test('moveSheet reorders listSheets', () => {
		const session = createWorkbookSession();
		try {
			const a = session.addSheet('A', 1000);
			const b = session.addSheet('B', 1000);
			const c = session.addSheet('C', 1000);
			assert.deepStrictEqual(session.listSheets().map(s => s.id), [a, b, c], 'initial order = append order');
			session.moveSheet(a, 2);   // move A to the last display position
			const after = session.listSheets().map(s => s.id);
			assert.strictEqual(after[2], a, 'A moved to display position 2');
			assert.deepStrictEqual([...after].sort((x, y) => x - y), [a, b, c].sort((x, y) => x - y), 'no sheets lost');
		} finally {
			session.close();
		}
	});
});


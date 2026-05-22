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
 *   cargo build -p ql-bindings-node --release
 *
 * On macOS that's typically:
 *   cd ~/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
 *   cargo build -p ql-bindings-node --release
 */

import * as assert from 'assert';
import * as fs from 'fs';

import {
	loadQuantbookEngine,
	resolveEnginePath,
	_resetQuantbookEngineCacheForTests,
} from '../src/quantbook/loader';
import {
	appendPutValueValidated,
	createSession,
	isAutoFlushPolicy,
	loopbackTransportPair,
	quantbookEngineVersion,
	sessionFromSnapshot,
} from '../src/quantbook/session';

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

	test('flushDeltaToTransport vs flushToTransport: delta is incremental, full is total', () => {
		// Pin the semantic difference: after first flush of each kind
		// from a 1-op state, attach a fresh transport and observe.
		// (Delta will send 0 ops because last_flushed_vv was reset by
		// attach, then immediately advanced by the flush; full sends
		// the snapshot — but actual byte-count comparison is engine-
		// internal. We just pin behavioral correctness here.)
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

	test('setAutoFlushPolicy accepts aliases (Disabled, OnAppend, on-append)', () => {
		// The engine-side parser is lenient; the strict camelCase check
		// is in `isAutoFlushPolicy` (TS guard). Pin both behaviors.
		const session = createSession(1n);
		// `as` casts: TS type narrows to the camelCase union; the engine
		// alias acceptance is engine-side behavior.
		assert.doesNotThrow(() => session.setAutoFlushPolicy('Disabled' as 'disabled'));
		assert.doesNotThrow(() => session.setAutoFlushPolicy('OnAppend' as 'onAppend'));
		assert.doesNotThrow(() => session.setAutoFlushPolicy('on-append' as 'onAppend'));
		// Return value is always canonical camelCase.
		const prior = session.setAutoFlushPolicy('disabled');
		assert.strictEqual(prior, 'onAppend', 'return is canonical camelCase');
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

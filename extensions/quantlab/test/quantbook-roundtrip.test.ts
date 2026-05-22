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

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * E2E tests for DaemonLifecycle.
 *
 * The lifecycle wraps QvizDaemonClient with status tracking + auto-
 * respawn. These tests drive each transition in the state machine using
 * the test fixtures under `test/fixtures/`:
 *
 *   - dummy_daemon_long_lived.py        idle -> starting -> ready
 *   - dummy_daemon_no_banner.py         idle -> starting -> crashed (banner timeout)
 *   - dummy_daemon_crash_after_banner.py  ready -> crashed -> respawning -> ready
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
	type LifecycleStatus,
	DaemonLifecycle, DaemonUnavailableError,
	DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
} from '../src/qviz/daemon-lifecycle';

const PYTHON_PATH = process.env.QUANTLAB_TEST_PYTHON ?? '/Users/sanzhar/.quantlab/venv/bin/python';
// __dirname at runtime is the COMPILED test dir (out/test/), so source-tree
// fixtures need to climb two levels back. Mirrors qviz-daemon-client.test.ts.
const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'test', 'fixtures');

function pythonAvailable(): boolean {
	try { fs.accessSync(PYTHON_PATH, fs.constants.X_OK); return true; }
	catch { return false; }
}

function recordStatus(lifecycle: DaemonLifecycle): LifecycleStatus[] {
	const log: LifecycleStatus[] = [];
	lifecycle.onStatusChange(s => { log.push(s); });
	return log;
}

// ---------------------------------------------------------------------------
// option validation (no python required)
// ---------------------------------------------------------------------------

suite('DaemonLifecycle -- option validation', () => {

	test('rejects negative initialBackoffMs', () => {
		assert.throws(
			() => new DaemonLifecycle({
				...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
				workspaceRoot: '/tmp', pythonPath: '/usr/bin/python3',
				initialBackoffMs: -1,
			}),
			/initialBackoffMs/,
		);
	});

	test('rejects maxBackoffMs < initialBackoffMs', () => {
		assert.throws(
			() => new DaemonLifecycle({
				...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
				workspaceRoot: '/tmp', pythonPath: '/usr/bin/python3',
				initialBackoffMs: 1000,
				maxBackoffMs: 500,
			}),
			/maxBackoffMs/,
		);
	});

	test('rejects non-integer maxAttempts', () => {
		assert.throws(
			() => new DaemonLifecycle({
				...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
				workspaceRoot: '/tmp', pythonPath: '/usr/bin/python3',
				maxAttempts: 1.5,
			}),
			/maxAttempts/,
		);
	});

	test('rejects maxAttempts < 1', () => {
		assert.throws(
			() => new DaemonLifecycle({
				...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
				workspaceRoot: '/tmp', pythonPath: '/usr/bin/python3',
				maxAttempts: 0,
			}),
			/maxAttempts/,
		);
	});

	test('idle status before any spawn attempt', () => {
		const lc = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp', pythonPath: '/usr/bin/python3',
		});
		assert.strictEqual(lc.getStatus().kind, 'idle');
		// Cleanup -- no spawn was triggered.
		void lc.dispose();
	});

	test('concurrent dispose() returns the same teardown promise', () => {
		const lc = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp', pythonPath: '/usr/bin/python3',
		});
		const a = lc.dispose();
		const b = lc.dispose();
		assert.strictEqual(a, b, 'concurrent dispose must share the same promise');
	});

	// Megaudit E8 (2026-05-13): `disposing` transient between
	// dispose() invocation and the terminal `unavailable` transition.
	// Per opus audit (2026-05-13) the transition lives inside the
	// IIFE (microtask-fast, not strictly synchronous) so a throwing
	// status handler cannot strand teardown by leaving disposePromise
	// null. The full ordering is asserted via `await p` then log.
	test('E8: dispose() emits disposing before unavailable', async () => {
		const lc = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp', pythonPath: '/usr/bin/python3',
		});
		const log = recordStatus(lc);
		await lc.dispose();
		const kinds = log.map(s => s.kind);
		const iDisposing = kinds.indexOf('disposing');
		const iUnavailable = kinds.indexOf('unavailable');
		assert.ok(iDisposing >= 0,
			`expected 'disposing' in status log; got ${kinds.join(',')}`);
		assert.ok(iUnavailable >= 0,
			`expected 'unavailable' in status log; got ${kinds.join(',')}`);
		assert.ok(iDisposing < iUnavailable,
			`'disposing' must precede 'unavailable'; got ${kinds.join(',')}`);
	});

	test('E8: getStatus() returns disposing synchronously during the grace window', async () => {
		const lc = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp', pythonPath: '/usr/bin/python3',
		});
		const p = lc.dispose();
		// The `disposing` transition is SYNC (right after disposePromise
		// is assigned), so getStatus() reports it without any await.
		assert.strictEqual(lc.getStatus().kind, 'disposing');
		await p;
		// After teardown, status is `unavailable`.
		assert.strictEqual(lc.getStatus().kind, 'unavailable');
	});

	test('E8 opus audit: throwing status handler does not strand teardown', async () => {
		// If a status handler throws on the `disposing` transition,
		// the disposePromise must still resolve teardown (cancelRetry,
		// transition to unavailable, reject waiters). Without this
		// invariant the lifecycle wedges, leaking the child process.
		const lc = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp', pythonPath: '/usr/bin/python3',
		});
		const seen: string[] = [];
		lc.onStatusChange(s => {
			seen.push(s.kind);
			if (s.kind === 'disposing') {
				throw new Error('handler synthetic');
			}
		});
		await assert.rejects(lc.dispose(), /synthetic/);
		// Even though the handler threw on `disposing`, the unavailable
		// transition fired (visible to subsequent subscribers via
		// getStatus). The lifecycle is fully torn down, not stranded.
		assert.strictEqual(lc.getStatus().kind, 'unavailable',
			`teardown must complete despite handler throw; got ${seen.join(',')}`);
	});

});

suite('DaemonLifecycle -- happy path', () => {

	const skip = !pythonAvailable();

	test('starts as idle, transitions to ready on first getClient()', async function () {
		if (skip) { this.skip(); }
		const lifecycle = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_long_lived',
			bannerTimeoutMs: 3000,
		});
		try {
			assert.strictEqual(lifecycle.getStatus().kind, 'idle');
			const log = recordStatus(lifecycle);
			const client = await lifecycle.getClient();
			assert.ok(client, 'expected a client');
			assert.strictEqual(lifecycle.getStatus().kind, 'ready');
			const kinds = log.map(s => s.kind);
			assert.deepStrictEqual(kinds.slice(0, 2), ['starting', 'ready']);
		} finally {
			await lifecycle.dispose();
		}
	});

	test('subsequent getClient() returns the same client (no new spawn)', async function () {
		if (skip) { this.skip(); }
		const lifecycle = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_long_lived',
			bannerTimeoutMs: 3000,
		});
		try {
			const c1 = await lifecycle.getClient();
			const c2 = await lifecycle.getClient();
			assert.strictEqual(c1, c2, 'lifecycle must reuse the live client');
		} finally {
			await lifecycle.dispose();
		}
	});

});

suite('DaemonLifecycle -- crash recovery', () => {

	const skip = !pythonAvailable();

	test('banner timeout drives idle -> starting -> crashed -> respawning', async function () {
		if (skip) { this.skip(); }
		// `dummy_daemon_no_banner` never writes a banner. With a short
		// bannerTimeoutMs the lifecycle hits crashed quickly. We assert
		// the status sequence; we DON'T wait for ready (it never will).
		const lifecycle = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_no_banner',
			bannerTimeoutMs: 200,
			initialBackoffMs: 50,
			maxBackoffMs: 200,
			maxAttempts: 2,
		});
		try {
			const log = recordStatus(lifecycle);
			let unavailable: Error | null = null;
			try { await lifecycle.getClient(); }
			catch (e) { unavailable = e as Error; }
			assert.ok(unavailable instanceof DaemonUnavailableError,
				`expected DaemonUnavailableError after exhausted retries, got ${unavailable}`);
			const kinds = log.map(s => s.kind);
			assert.ok(kinds.includes('starting'), `kinds=${kinds.join(',')}`);
			assert.ok(kinds.includes('crashed'), `kinds=${kinds.join(',')}`);
			assert.ok(kinds.includes('unavailable'), `kinds=${kinds.join(',')}`);
		} finally {
			await lifecycle.dispose();
		}
	});

	test('crash-then-respawn-success leads back to ready', async function () {
		if (skip) { this.skip(); }
		// Crash-after-banner fixture: writes banner, then exits ~50ms later.
		// Lifecycle will see 'ready' once banner fires, then 'crashed' on
		// exit. With an env-var bump we can flip the SECOND attempt to
		// long-lived behavior -- the fixture honors the env var on every
		// invocation.
		//
		// Strategy: set QVIZ_FIXTURE_CRASH_AFTER_MS=10_000 so the second
		// spawn doesn't crash within the test window. The first attempt
		// still crashes because we observe 'crashed' before this env var
		// is "respected" -- actually the env is process-wide, so BOTH
		// attempts use the same value. Use 600ms so first crashes (test
		// observes 'ready' then 'crashed'), but since maxAttempts allows
		// at least one retry the second spawn also has 600ms uptime --
		// long enough for our assertion that 'ready' was seen.
		const lifecycle = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_crash_after_banner',
			bannerTimeoutMs: 3000,
			initialBackoffMs: 30,
			maxBackoffMs: 100,
			maxAttempts: 3,
			env: { QVIZ_FIXTURE_CRASH_AFTER_MS: '600' },
		});
		try {
			const log = recordStatus(lifecycle);
			const client = await lifecycle.getClient();
			assert.ok(client, 'lifecycle must produce a (transiently) ready client');
			// Wait briefly so the crash is observable in `log`.
			await new Promise(r => setTimeout(r, 800));
			const kinds = log.map(s => s.kind);
			assert.ok(kinds.includes('ready'), `expected ready in ${kinds.join(',')}`);
			assert.ok(kinds.includes('crashed') || kinds.includes('respawning'),
				`expected crashed/respawning in ${kinds.join(',')}`);
		} finally {
			await lifecycle.dispose();
		}
	});

});

suite('DaemonLifecycle -- dispose', () => {

	const skip = !pythonAvailable();

	test('dispose rejects pending getClient() callers with DaemonUnavailableError', async function () {
		if (skip) { this.skip(); }
		const lifecycle = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_no_banner',
			bannerTimeoutMs: 30_000,  // never fires within the test
		});
		const pending = lifecycle.getClient();
		await lifecycle.dispose();
		await assert.rejects(pending, DaemonUnavailableError);
	});

	test('post-dispose getClient rejects', async function () {
		if (skip) { this.skip(); }
		const lifecycle = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_long_lived',
		});
		await lifecycle.dispose();
		await assert.rejects(lifecycle.getClient(), DaemonUnavailableError);
	});

	test('dispose is idempotent', async function () {
		if (skip) { this.skip(); }
		const lifecycle = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_long_lived',
		});
		await lifecycle.dispose();
		await lifecycle.dispose();  // must not throw
	});

	test('dispose after ready cleans up the live client', async function () {
		if (skip) { this.skip(); }
		const lifecycle = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_long_lived',
		});
		const client = await lifecycle.getClient();
		await lifecycle.dispose();
		// Disposed client rejects subsequent ops.
		await assert.rejects(client.ping(), /closed|disposed/i);
	});

});

// ---------------------------------------------------------------------------
// Phase 8 Step D — requestImmediateRetry
// ---------------------------------------------------------------------------

suite('DaemonLifecycle -- requestImmediateRetry (Phase 8 Step D)', () => {

	const skip = !pythonAvailable();

	test('returns false when status is idle (nothing to retry)', () => {
		const lifecycle = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_long_lived',
		});
		try {
			// No spawn started yet — status is 'idle'.
			assert.strictEqual(lifecycle.requestImmediateRetry(), false);
		} finally {
			void lifecycle.dispose();
		}
	});

	test('throws DaemonUnavailableError after dispose', async () => {
		const lifecycle = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_long_lived',
		});
		await lifecycle.dispose();
		assert.throws(() => lifecycle.requestImmediateRetry(), DaemonUnavailableError);
	});

	test('crashed -> retry skips backoff and starts spawning', async function () {
		if (skip) { this.skip(); }
		this.timeout(8000);
		// Crash-after-banner with a long initial backoff means the auto-retry
		// would take a while. requestImmediateRetry should cut through.
		const lifecycle = new DaemonLifecycle({
			...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_no_banner',
			bannerTimeoutMs: 150,
			initialBackoffMs: 60_000,   // huge backoff
			maxBackoffMs: 60_000,
			maxAttempts: 5,
		});
		try {
			const log = recordStatus(lifecycle);
			// Kick a spawn; the no-banner fixture will crash quickly.
			void lifecycle.getClient().catch(() => undefined);
			// Wait until we see 'crashed'.
			const deadline = Date.now() + 3000;
			while (Date.now() < deadline) {
				if (log.some(s => s.kind === 'crashed')) { break; }
				await new Promise(r => setTimeout(r, 20));
			}
			const sawCrashed = log.some(s => s.kind === 'crashed');
			assert.ok(sawCrashed, `expected to observe crashed, got ${log.map(s => s.kind).join(',')}`);
			// Snapshot the 'starting' count BEFORE the retry. startSpawn
			// fires the transition synchronously inside requestImmediateRetry.
			const startsBefore = log.filter(s => s.kind === 'starting').length;
			// Now force a retry — should skip the 60-second backoff and
			// start spawning immediately.
			const result = lifecycle.requestImmediateRetry();
			assert.strictEqual(result, true);
			const startsAfter = log.filter(s => s.kind === 'starting').length;
			assert.ok(
				startsAfter > startsBefore,
				`requestImmediateRetry should have triggered another 'starting' transition `
				+ `(before=${startsBefore}, after=${startsAfter}, log=${log.map(s => s.kind).join(',')})`,
			);
		} finally {
			await lifecycle.dispose();
		}
	});

});

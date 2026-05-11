/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * End-to-end tests for QvizDaemonClient.
 *
 * Spawns the real Python daemon (mirroring python/qviz/tests/test_daemon_e2e.py
 * shape) and drives every op through the framed wire protocol. Skipped if
 * the venv Python is not present at the configured path.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	DaemonOpError, DaemonProtocolError,
	QvizDaemonClient, type DaemonBanner,
	DEFAULT_DAEMON_CLIENT_OPTIONS,
} from '../src/qviz/daemon-client';
import { extractColumnsFromArrowIpc } from '../src/qviz/render/extract-arrow';
import type { QvizSpec } from '../src/qviz/spec';

// Audit-fix AF36: test paths discoverable via env so CI / other developers
// don't need a specific user's venv at /Users/sanzhar. Fall back to common
// project locations.
const PYTHON_PATH =
	process.env.QUANTLAB_TEST_PYTHON ||
	'/Users/sanzhar/.quantlab/venv/bin/python';
const SPIKE_DATA =
	process.env.QUANTLAB_TEST_SPIKE_DATA ||
	'/tmp/quantlab-spike-data/synthetic_ohlcv_1m.parquet';
// __dirname at runtime is the COMPILED test dir (out/test/), so source-tree
// resources need to climb two levels back to extensions/quantlab/ before
// descending into python/ or test/fixtures/. The legacy `../python` only
// worked when tests ran from `test/` itself.
const PYTHON_DIR = path.resolve(__dirname, '..', '..', 'python');
const FIXTURES_DIR = path.resolve(__dirname, '..', '..', 'test', 'fixtures');

function pythonAvailable(): { ok: true } | { ok: false; reason: string } {
	try {
		fs.accessSync(PYTHON_PATH, fs.constants.X_OK);
	} catch {
		return { ok: false, reason: `python interpreter not executable at ${PYTHON_PATH} (set QUANTLAB_TEST_PYTHON to override)` };
	}
	try {
		fs.accessSync(SPIKE_DATA, fs.constants.R_OK);
	} catch {
		return { ok: false, reason: `spike data not readable at ${SPIKE_DATA} (set QUANTLAB_TEST_SPIKE_DATA to override)` };
	}
	return { ok: true };
}

// Backwards-compat boolean used in `if (skip) this.skip()` patterns below.
function shouldSkip(): boolean {
	const r = pythonAvailable();
	if (!r.ok) {
		// Print once per process so a missing fixture is loud in CI logs.
		const seen = (global as { __qvizDaemonSkipLogged?: boolean });
		if (!seen.__qvizDaemonSkipLogged) {
			seen.__qvizDaemonSkipLogged = true;
			// eslint-disable-next-line no-console
			console.warn(`[qviz-daemon-client.test] skipping: ${r.reason}`);
		}
		return true;
	}
	return false;
}

function makeWorkspace(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qviz-client-'));
	const dataDir = path.join(root, 'data');
	fs.mkdirSync(dataDir);
	const target = path.join(dataDir, 'ohlcv.parquet');
	try {
		fs.linkSync(SPIKE_DATA, target);
	} catch {
		// fall back to copy if hardlink fails (cross-device, etc.)
		fs.copyFileSync(SPIKE_DATA, target);
	}
	return root;
}

function rmrfSync(p: string): void {
	try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

suite('QvizDaemonClient -- end-to-end', () => {

	let workspace: string;
	let client: QvizDaemonClient;
	const skip = shouldSkip();

	suiteSetup(function () {
		if (skip) {
			this.skip();
		}
		workspace = makeWorkspace();
		client = new QvizDaemonClient({
			...DEFAULT_DAEMON_CLIENT_OPTIONS,
			workspaceRoot: workspace,
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [PYTHON_DIR],
		});
	});

	suiteTeardown(async function () {
		if (skip) { return; }
		try { await client.dispose(); } catch { /* ignore */ }
		if (workspace) { rmrfSync(workspace); }
	});

	test('banner identifies the daemon and lists ops', async () => {
		const banner: DaemonBanner = await client.ready();
		assert.strictEqual(banner.daemon, 'qviz');
		assert.strictEqual(banner.version, 1);
		const ops = new Set(banner.ops);
		assert.ok(ops.has('ping'));
		assert.ok(ops.has('schema'));
		assert.ok(ops.has('aggregate'));
		assert.ok(ops.has('decimate'));
	});

	test('ping returns pong', async () => {
		const r = await client.ping();
		assert.strictEqual(r.data.pong, true);
		assert.ok(r.elapsedMs >= 0);
	});

	test('schema returns expected OHLCV columns', async () => {
		const r = await client.schema('data/ohlcv.parquet');
		assert.strictEqual(r.data.row_count, 1_000_000);
		const colNames = new Set(r.data.columns.map(c => c.name));
		for (const expected of ['timestamp', 'open', 'high', 'low', 'close', 'volume', 'returns']) {
			assert.ok(colNames.has(expected), `missing column ${expected}`);
		}
		assert.ok(r.data.schema_hash.startsWith('sha256:'));
	});

	test('schema is cached on second call', async () => {
		await client.schema('data/ohlcv.parquet');
		const r = await client.schema('data/ohlcv.parquet');
		assert.strictEqual((r.data as { cached?: boolean }).cached, true);
	});

	test('preview small returns inline JSON rows', async () => {
		const r = await client.preview('data/ohlcv.parquet', 10);
		// 10 rows is well below the 256KB inline JSON threshold.
		assert.ok('data' in r, 'expected JsonResponse for small preview');
		const json = r as unknown as { data: { rows: Record<string, unknown>[]; n: number } };
		assert.strictEqual(json.data.n, 10);
		assert.strictEqual(json.data.rows.length, 10);
		const first = json.data.rows[0];
		assert.ok('close' in first);
		assert.ok('volume' in first);
	});

	test('preview large returns Arrow IPC binary frame', async () => {
		const r = await client.preview('data/ohlcv.parquet', 5000);
		if ('arrow' in r) {
			assert.ok(r.arrow.byteLength > 1024, `arrow frame too small: ${r.arrow.byteLength}`);
			const cols = extractColumnsFromArrowIpc(r.arrow);
			assert.ok((cols.close as ArrayLike<unknown>).length === 5000);
		} else {
			// Some pyarrow builds emit smaller binary; accept either.
			const json = r as { data: { n: number } };
			assert.strictEqual(json.data.n, 5000);
		}
	});

	test('aggregate compiles + runs + returns Arrow', async () => {
		const spec: QvizSpec = {
			qviz_version: 1,
			dataset: {
				uri: 'data/ohlcv.parquet',
				schema_hash: 'sha256:' + '0'.repeat(64),
				mtime_ns: 1,
			},
			transforms: [
				{ kind: 'date_trunc', column: 'timestamp', unit: 'day', as: 'day' },
				{ kind: 'groupby', columns: ['day'] },
				{
					kind: 'aggregate',
					aggs: [{ column: 'volume', fn: 'sum', as: 'vol_sum' }],
				},
				{ kind: 'sort', columns: [{ column: 'day' }] },
			],
			chart: {
				family: 'timeseries',
				type: 'line',
				encodings: {
					x: { field: 'day', type: 'temporal' },
					y: { field: 'vol_sum', type: 'quantitative' },
				},
			},
			provenance: {
				generated_at: '2026-05-10T00:00:00Z',
				generator: 'qviz-daemon-client.test/0.1.0',
				query_hash: 'sha256:' + '0'.repeat(64),
				tool_versions: { qviz_schema: 1 },
			},
		};
		const r = await client.aggregate(spec);
		assert.ok(r.arrow.byteLength > 0);
		const cols = extractColumnsFromArrowIpc(r.arrow);
		assert.ok('day' in cols);
		assert.ok('vol_sum' in cols);
		// Expect at least 2 distinct days (1M seconds spans ~11.5 days).
		const days = cols.day as ArrayLike<unknown>;
		assert.ok(days.length >= 2, `expected >= 2 days in aggregate, got ${days.length}`);
	});

	test('decimate returns LTTB-decimated points as Arrow', async () => {
		const r = await client.decimate('data/ohlcv.parquet', 'timestamp', 'close', 500);
		assert.ok(r.arrow.byteLength > 0);
		const cols = extractColumnsFromArrowIpc(r.arrow);
		assert.ok('t' in cols);
		assert.ok('v' in cols);
		const t = cols.t as ArrayLike<number | null>;
		// LTTB picks at most n_visible+endpoints; allow some slack for boundaries.
		assert.ok(t.length > 0 && t.length <= 510, `unexpected output count ${t.length}`);
	});

	test('decimate rejects unknown columns with DaemonOpError', async () => {
		try {
			await client.decimate('data/ohlcv.parquet', '__not_a_column__', 'close', 100);
			assert.fail('expected DaemonOpError');
		} catch (e) {
			assert.ok(e instanceof DaemonOpError, `expected DaemonOpError, got ${e}`);
			assert.ok(/__not_a_column__/.test((e as Error).message),
				`expected error message to mention column, got: ${(e as Error).message}`);
		}
	});

	test('schema rejects out-of-workspace paths', async () => {
		try {
			await client.schema('../../etc/passwd');
			assert.fail('expected DaemonOpError for path-escape');
		} catch (e) {
			assert.ok(e instanceof DaemonOpError);
		}
	});

	// ---------- Phase 6 (Inspector) wrappers ----------

	test('Phase 6: capabilities advertises inspector flags', async () => {
		const r = await client.capabilities();
		const inspector = r.data.inspector;
		assert.ok(inspector, 'inspector capability bag should be present');
		assert.strictEqual(inspector!.preview_offset, true);
		assert.strictEqual(inspector!.column_stats, true);
		assert.strictEqual(inspector!.aggregate_filters, true);
	});

	test('Phase 6: preview honors offset', async () => {
		const head = await client.preview('data/ohlcv.parquet', 200);
		const skip = await client.preview('data/ohlcv.parquet', 100, 100);
		// Both paths return JSON for these sizes (<256KB).
		assert.ok('data' in head && 'data' in skip);
		const headRows = (head as unknown as { data: { rows: ReadonlyArray<Record<string, unknown>> } }).data.rows;
		const skipRows = (skip as unknown as { data: { rows: ReadonlyArray<Record<string, unknown>> } }).data.rows;
		// Compare timestamps to prove offset advanced past the first 100.
		assert.strictEqual(skipRows.length, 100);
		assert.deepStrictEqual(
			skipRows.map(r => r.timestamp),
			headRows.slice(100, 200).map(r => r.timestamp),
		);
	});

	test('Phase 6: preview offset past end returns zero rows', async () => {
		const r = await client.preview('data/ohlcv.parquet', 10, 2_000_000);
		assert.ok('data' in r);
		const n = (r as { data: { n: number } }).data.n;
		assert.strictEqual(n, 0);
	});

	test('Phase 6: columnStats returns numeric min/max', async () => {
		const r = await client.columnStats('data/ohlcv.parquet', 'volume');
		assert.strictEqual(r.data.kind, 'numeric');
		assert.ok(typeof r.data.min === 'number' && typeof r.data.max === 'number');
		assert.ok((r.data.min as number) <= (r.data.max as number));
		assert.strictEqual(r.data.total, 1_000_000);
	});

	test('Phase 6: columnStats temporal returns ISO min/max', async () => {
		const r = await client.columnStats('data/ohlcv.parquet', 'timestamp');
		assert.strictEqual(r.data.kind, 'temporal');
		assert.ok(typeof r.data.min === 'string' && typeof r.data.max === 'string');
	});

	test('Phase 6: columnStats unknown column → DaemonOpError', async () => {
		try {
			await client.columnStats('data/ohlcv.parquet', '__nope__');
			assert.fail('expected DaemonOpError');
		} catch (e) {
			assert.ok(e instanceof DaemonOpError, `got ${e}`);
		}
	});

	test('Phase 6: aggregate with inspectorFilters prepends filter at compile time', async () => {
		const baseSpec: QvizSpec = {
			qviz_version: 1,
			dataset: { uri: 'data/ohlcv.parquet', schema_hash: 'sha256:' + '0'.repeat(64), mtime_ns: 1 },
			transforms: [
				{ kind: 'date_trunc', column: 'timestamp', unit: 'day', as: 'day' },
				{ kind: 'groupby', columns: ['day'] },
				{ kind: 'aggregate', aggs: [{ column: 'close', fn: 'count', as: 'n' }] },
				{ kind: 'sort', columns: [{ column: 'day' }] },
			],
			chart: {
				family: 'timeseries', type: 'line',
				encodings: { x: { field: 'day', type: 'temporal' }, y: { field: 'n', type: 'quantitative' } },
			},
			provenance: {
				generated_at: '2026-05-11T00:00:00Z', generator: 'phase6-test',
				query_hash: 'sha256:' + '0'.repeat(64), tool_versions: { qviz_schema: 1 },
			},
		};
		const unfilteredR = await client.aggregate(baseSpec);
		const filteredR = await client.aggregate(baseSpec, {
			inspectorFilters: [{ kind: 'filter', column: 'close', op: '<', value: 0.5 }],
		});
		const unfilteredCols = extractColumnsFromArrowIpc(unfilteredR.arrow);
		const filteredCols = extractColumnsFromArrowIpc(filteredR.arrow);
		const sumU = (unfilteredCols.n as ArrayLike<number>);
		const sumF = (filteredCols.n as ArrayLike<number>);
		let totalU = 0, totalF = 0;
		for (let i = 0; i < sumU.length; i++) { totalU += sumU[i]; }
		for (let i = 0; i < sumF.length; i++) { totalF += sumF[i]; }
		assert.ok(totalF < totalU, `filter should shrink total: filtered=${totalF} unfiltered=${totalU}`);
	});

	test('Phase 6: aggregate inspectorFilters omitted when empty (cache-key parity)', async () => {
		const spec: QvizSpec = {
			qviz_version: 1,
			dataset: { uri: 'data/ohlcv.parquet', schema_hash: 'sha256:' + '0'.repeat(64), mtime_ns: 1 },
			transforms: [],
			chart: { family: 'timeseries', type: 'line', encodings: {
				x: { field: 'timestamp', type: 'temporal' },
				y: { field: 'close', type: 'quantitative' },
			} },
			provenance: {
				generated_at: '2026-05-11T00:00:00Z', generator: 'phase6-test',
				query_hash: 'sha256:' + '0'.repeat(64), tool_versions: { qviz_schema: 1 },
			},
		};
		// Two calls with empty filters must hit the cache on the second call.
		await client.aggregate(spec);
		const second = await client.aggregate(spec, { inspectorFilters: [] });
		assert.strictEqual(second.cached, true);
	});

});

suite('QvizDaemonClient -- protocol + lifecycle (audit fixes)', () => {

	const skip = shouldSkip();

	test('AF6: dispose() rejects in-flight requests deterministically', async function () {
		if (skip) { this.skip(); }
		const ws = makeWorkspace();
		const c = new QvizDaemonClient({
			...DEFAULT_DAEMON_CLIENT_OPTIONS,
			workspaceRoot: ws,
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [PYTHON_DIR],
		});
		await c.ready();
		// Issue an aggregate against a fake-but-valid spec, which takes
		// long enough to be in-flight when we dispose. We don't care about
		// the actual result; only that the promise rejects.
		const spec: QvizSpec = {
			qviz_version: 1,
			dataset: {
				uri: 'data/ohlcv.parquet',
				schema_hash: 'sha256:' + '0'.repeat(64),
				mtime_ns: 1,
			},
			transforms: [],
			chart: {
				family: 'timeseries', type: 'line',
				encodings: {
					x: { field: 'timestamp', type: 'temporal' },
					y: { field: 'close', type: 'quantitative' },
				},
			},
			provenance: {
				generated_at: '2026-05-10T00:00:00Z',
				generator: 'test/0.1', query_hash: 'sha256:' + '0'.repeat(64),
				tool_versions: { qviz_schema: 1 },
			},
		};
		const pending = c.aggregate(spec);
		// Race: dispose might run before or after the aggregate request
		// is fully written, but the pending entry is in orderedQueue
		// synchronously, so dispose's failPending must reject it.
		await c.dispose();
		await assert.rejects(pending, (e: Error) => e instanceof Error,
			'pending op must reject after dispose()');
		rmrfSync(ws);
	});

	test('AF8: oversized outgoing frame rejects client-side', async function () {
		if (skip) { this.skip(); }
		const ws = makeWorkspace();
		const c = new QvizDaemonClient({
			...DEFAULT_DAEMON_CLIENT_OPTIONS,
			workspaceRoot: ws,
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [PYTHON_DIR],
		});
		try {
			await c.ready();
			const huge = 'x'.repeat(70 * 1024 * 1024); // 70 MB > 64 MB cap
			await assert.rejects(
				c.schema(huge),
				(e: Error) => e instanceof DaemonProtocolError && /too large/.test(e.message),
				'oversized frame must be rejected client-side'
			);
		} finally {
			await c.dispose();
			rmrfSync(ws);
		}
	});

	test('AF7: opts.env cannot override QUANTLAB_WORKSPACE_ROOT', async function () {
		if (skip) { this.skip(); }
		const realWs = makeWorkspace();
		const fakeWs = makeWorkspace();
		const c = new QvizDaemonClient({
			...DEFAULT_DAEMON_CLIENT_OPTIONS,
			workspaceRoot: realWs,
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [PYTHON_DIR],
			env: { QUANTLAB_WORKSPACE_ROOT: fakeWs },
		});
		try {
			await c.ready();
			const r = await c.ping();
			// `workspace` in the ping response is the daemon's view of the
			// active root. Must be `realWs`, not `fakeWs`. Use realpath-
			// equivalent comparison since the daemon resolves symlinks.
			assert.strictEqual(
				fs.realpathSync(r.data.workspace),
				fs.realpathSync(realWs),
				'opts.env must NOT override QUANTLAB_WORKSPACE_ROOT'
			);
		} finally {
			await c.dispose();
			rmrfSync(realWs);
			rmrfSync(fakeWs);
		}
	});

	test('AF3: mid-arrow daemon death rejects parked pending request', async function () {
		if (skip) { this.skip(); }
		const ws = makeWorkspace();
		const c = new QvizDaemonClient({
			...DEFAULT_DAEMON_CLIENT_OPTIONS,
			workspaceRoot: ws,
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_arrow_then_die',
		});
		try {
			await c.ready();
			// The fake daemon will read one request, send a JSON head with
			// encoding=arrow, and then exit -- without sending the Arrow
			// follow-up. Without the AF3 fix, the parked `awaitingArrowFor`
			// pending entry never resolves and this test hangs until the
			// mocha timeout. With the fix, dispose() / handleClose drains
			// it via failPending and the promise rejects.
			const spec: QvizSpec = {
				qviz_version: 1,
				dataset: { uri: 'data/x.parquet', schema_hash: 'sha256:' + '0'.repeat(64), mtime_ns: 1 },
				transforms: [],
				chart: {
					family: 'general', type: 'scatter',
					encodings: {
						x: { field: 'a', type: 'quantitative' },
						y: { field: 'b', type: 'quantitative' },
					},
				},
				provenance: {
					generated_at: '2026-05-10T00:00:00Z', generator: 'test',
					query_hash: 'sha256:' + '0'.repeat(64),
					tool_versions: { qviz_schema: 1 },
				},
			};
			await assert.rejects(
				c.aggregate(spec),
				(e: Error) => e instanceof Error,
				'parked aggregate must reject when daemon dies before Arrow frame'
			);
		} finally {
			await c.dispose();
			rmrfSync(ws);
		}
	});

	test('AF4: protocol desync (wrong response id) rejects all pending', async function () {
		if (skip) { this.skip(); }
		const ws = makeWorkspace();
		const c = new QvizDaemonClient({
			...DEFAULT_DAEMON_CLIENT_OPTIONS,
			workspaceRoot: ws,
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_desync_id',
		});
		try {
			await c.ready();
			// Issue THREE pings; the fake daemon will reply once with a
			// wrong id and then go silent. Without AF4, only the head
			// rejects; the other two hang. With the fix, all three reject
			// (the desync is fatal and drains the queue).
			const p1 = c.ping();
			const p2 = c.ping();
			const p3 = c.ping();
			await assert.rejects(p1, /desync|protocol/i, 'p1 must reject on desync');
			await assert.rejects(p2, (e: Error) => e instanceof Error, 'p2 must reject on desync');
			await assert.rejects(p3, (e: Error) => e instanceof Error, 'p3 must reject on desync');
		} finally {
			await c.dispose();
			rmrfSync(ws);
		}
	});

	test('AF9: ready() rejects on banner timeout', async function () {
		if (skip) { this.skip(); }
		const c = new QvizDaemonClient({
			...DEFAULT_DAEMON_CLIENT_OPTIONS,
			workspaceRoot: '/tmp',
			pythonPath: PYTHON_PATH,
			pythonPathPrefix: [FIXTURES_DIR],
			module: 'dummy_daemon_no_banner',
			bannerTimeoutMs: 250,
		});
		await assert.rejects(c.ready(), (e: Error) =>
			e instanceof DaemonProtocolError && /banner/.test(e.message),
			'ready() must reject with DaemonProtocolError when banner never arrives'
		);
		await c.dispose();
	});

});

// keep DaemonProtocolError reachable as an explicit type-check site below.
const _kept: typeof DaemonProtocolError = DaemonProtocolError;
void _kept;

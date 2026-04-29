/*
 * Phase 3 integration: full qviz stack render demo.
 *
 *   QvizSpec  +  ColumnData  -->  TimeseriesPlan  -->  @charts-plus Chart
 *
 * This is the spike that proves the spec-compile-render pipeline works
 * with a real Chart instance, not just unit tests against shapes.
 *
 * Stand-in for the daemon: synthesizes the same shape of column data the
 * daemon would return for an aggregate operation. When the webview wiring
 * lands in Phase 5, the daemon is the data source.
 */

import {
	compileTimeseriesPlan,
} from '../../../../extensions/quantlab/src/qviz/render/timeseries';
import {
	applyTimeseriesPlan,
} from '../../../../extensions/quantlab/src/qviz/render/applier';
import type {
	ColumnData,
	QvizTheme,
} from '../../../../extensions/quantlab/src/qviz/render/types';
import type { QvizSpec } from '../../../../extensions/quantlab/src/qviz/spec';

const DARK_THEME: QvizTheme = {
	background: '#0a0f18',
	foreground: '#e7e9ee',
	grid: 'rgba(255, 255, 255, 0.06)',
	axisText: 'rgba(231, 233, 238, 0.7)',
	seriesPalette: ['#4fc3f7', '#81c784', '#ffb74d'],
	upColor: '#26a69a',
	downColor: '#ef5350',
};

const N = 1_000_000;

interface DemoResult {
	N: number;
	compileMs: number;
	applyMs: number;
	totalMs: number;
	planSeries: number;
	error?: string;
}

function generateColumns(): ColumnData {
	const startMs = Date.parse('2026-01-01T00:00:00Z');
	const t = new Float64Array(N);
	const v = new Float64Array(N);
	let prev = 100;
	for (let i = 0; i < N; i++) {
		t[i] = startMs + i * 1000;
		prev += (Math.random() - 0.5) * 0.05;
		v[i] = prev;
	}
	return { time: t, close: v };
}

function buildSpec(): QvizSpec {
	return {
		qviz_version: 1,
		title: 'BTC close (synthetic 1M points)',
		dataset: {
			uri: 'data/btc_1s_2026.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1_735_689_600_000_000_000,
			row_count: N,
		},
		transforms: [],
		chart: {
			family: 'timeseries',
			type: 'line',
			encodings: {
				x: { field: 'time', type: 'temporal', title: 'Time' },
				y: { field: 'close', type: 'quantitative', title: 'Close price' },
			},
			options: { show_grid: true, decimation: 'auto' },
		},
		trading_options: {
			timezone: 'UTC',
		},
		provenance: {
			generated_at: new Date().toISOString(),
			generator: 'visualise-spike-qviz-demo/0.1.0',
			query_hash: 'sha256:' + '0'.repeat(64),
			tool_versions: { qviz_schema: 1 },
			source: 'user-built',
		},
	};
}

function render(): void {
	const root = document.getElementById('chart');
	const stats = document.getElementById('stats');
	if (!root || !stats) { return; }

	const result: DemoResult = {
		N, compileMs: 0, applyMs: 0, totalMs: 0, planSeries: 0,
	};

	try {
		const t0 = performance.now();
		const spec = buildSpec();
		const columns = generateColumns();

		const t1 = performance.now();
		const plan = compileTimeseriesPlan(spec, columns, DARK_THEME);
		result.compileMs = performance.now() - t1;
		result.planSeries = plan.series.length;

		const t2 = performance.now();
		applyTimeseriesPlan(root, plan);
		result.applyMs = performance.now() - t2;

		result.totalMs = performance.now() - t0;

		// Wait two frames to ensure paint completes, then mark done for
		// the headless runner.
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				(window as { __qvizDemoResult?: DemoResult }).__qvizDemoResult = result;
				(window as { __qvizDemoDone?: boolean }).__qvizDemoDone = true;
				updateStats(result);
			});
		});
	} catch (err) {
		result.error = String((err as Error).message ?? err);
		updateStats(result);
		(window as { __qvizDemoResult?: DemoResult }).__qvizDemoResult = result;
		(window as { __qvizDemoDone?: boolean }).__qvizDemoDone = true;
	}

	updateStats(result);
}

function updateStats(r: DemoResult): void {
	const stats = document.getElementById('stats');
	if (!stats) { return; }
	const fmt = (n: number) => n.toFixed(1) + 'ms';
	stats.innerHTML = `
		<div><strong>Phase 3 — qviz timeseries render demo</strong></div>
		<hr style="border:0;border-top:1px solid #334155;margin:8px 0">
		<div>N: <span style="color:#4fc3f7">${r.N.toLocaleString()}</span></div>
		<div>compileTimeseriesPlan: <span style="color:#4fc3f7">${fmt(r.compileMs)}</span></div>
		<div>applyTimeseriesPlan: <span style="color:#4fc3f7">${fmt(r.applyMs)}</span></div>
		<div>total spec→chart: <span style="color:#4fc3f7">${fmt(r.totalMs)}</span></div>
		<div>series in plan: <span style="color:#4fc3f7">${r.planSeries}</span></div>
		${r.error ? `<div style="color:#f06292">err: ${r.error}</div>` : ''}
	`;
}

window.addEventListener('error', (e) => {
	const stats = document.getElementById('stats');
	if (stats) {
		stats.innerHTML += `<div style="color:#f06292">Error: ${e.message}</div>`;
	}
	(window as { __qvizDemoResult?: DemoResult }).__qvizDemoResult = {
		N, compileMs: 0, applyMs: 0, totalMs: 0, planSeries: 0,
		error: String(e.message ?? e),
	};
	(window as { __qvizDemoDone?: boolean }).__qvizDemoDone = true;
});

render();

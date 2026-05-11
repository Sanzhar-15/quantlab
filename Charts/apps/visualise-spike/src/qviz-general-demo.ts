/*
 * Phase 4 integration: full qviz general-family stack render demo.
 *
 *   QvizSpec  +  ColumnData  -->  GeneralPlan  -->  Vega-Lite (vega-embed)
 *
 * Mirrors the Phase 3 timeseries demo but exercises the Vega-Lite render
 * target. Stresses scatter (the canonical general-family chart) with a
 * realistic post-aggregation dataset size. The Phase 5 daemon-client will
 * supply the same shape of column data; this synthesizes it.
 *
 * Captures compile/apply timing into window.__qvizGeneralDemoResult so the
 * headless Playwright runner can assert performance characteristics.
 */

import { compileGeneralPlan } from '../../../../extensions/quantlab/src/qviz/render/general';
import { applyGeneralPlan } from '../../../../extensions/quantlab/src/qviz/render/general-applier';
import type { ColumnData, QvizTheme } from '../../../../extensions/quantlab/src/qviz/render/types';
import type { QvizSpec } from '../../../../extensions/quantlab/src/qviz/spec';

const DARK_THEME: QvizTheme = {
	background: '#0a0f18',
	foreground: '#e7e9ee',
	grid: 'rgba(255, 255, 255, 0.06)',
	axisText: 'rgba(231, 233, 238, 0.7)',
	seriesPalette: ['#4fc3f7', '#81c784', '#ffb74d', '#f06292', '#ba68c8', '#4dd0e1'],
	upColor: '#26a69a',
	downColor: '#ef5350',
};

const N = 50_000;

interface DemoResult {
	N: number;
	compileMs: number;
	applyMs: number;
	totalMs: number;
	rowCount: number;
	mark: string;
	hasViewHandle: boolean;
	hasCanvas: boolean;
	error?: string;
}

/**
 * Generate a reproducible scatter dataset that looks like aggregated
 * intraday market data: each row is a (volume, |return|) point colored
 * by hour-of-day. Deterministic seed so test runs are stable.
 */
function generateColumns(): ColumnData {
	const volume = new Float64Array(N);
	const absReturn = new Float64Array(N);
	const hour = new Float64Array(N);

	let s = 0x9e3779b1;
	const rng = () => {
		s = (s + 0x6d2b79f5) | 0;
		let t = Math.imul(s ^ (s >>> 15), 1 | s);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	for (let i = 0; i < N; i++) {
		const u = rng();
		const v = rng();
		// Box-Muller for a normal-ish |return|; clamp to keep finite.
		const z = Math.sqrt(-2 * Math.log(u + 1e-9)) * Math.cos(2 * Math.PI * v);
		const ret = Math.abs(z) * 0.0008;
		absReturn[i] = ret;
		// Volume: log-normal so log scale shows structure.
		volume[i] = Math.exp(2 + rng() * 3.5);
		hour[i] = Math.floor(rng() * 24);
	}
	return { volume, abs_ret: absReturn, hour };
}

function buildSpec(): QvizSpec {
	return {
		qviz_version: 1,
		title: 'Returns vs volume scatter (synthetic 50k points)',
		description: 'General-family scatter rendering through the qviz pipeline.',
		dataset: {
			uri: 'data/synthetic.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1_735_689_600_000_000_000,
			row_count: N,
		},
		transforms: [],
		chart: {
			family: 'general',
			type: 'scatter',
			encodings: {
				x: { field: 'volume', type: 'quantitative', title: 'Volume', scale: 'log' },
				y: { field: 'abs_ret', type: 'quantitative', title: '|Return|' },
				color: { field: 'hour', type: 'ordinal', title: 'Hour' },
			},
			options: { show_grid: true, show_legend: true },
		},
		provenance: {
			generated_at: new Date().toISOString(),
			generator: 'visualise-spike-qviz-general-demo/0.1.0',
			query_hash: 'sha256:' + '0'.repeat(64),
			tool_versions: { qviz_schema: 1 },
			source: 'user-built',
		},
	};
}

function publish(result: DemoResult): void {
	(window as { __qvizGeneralDemoResult?: DemoResult }).__qvizGeneralDemoResult = result;
	(window as { __qvizGeneralDemoDone?: boolean }).__qvizGeneralDemoDone = true;
	updateStats(result);
}

async function render(): Promise<void> {
	const root = document.getElementById('chart');
	const stats = document.getElementById('stats');
	if (!root || !stats) {
		// Audit-fix AF37: previously this returned silently, leaving the
		// runner to time out with no diagnostic. Publish an error so the
		// failure is visible in run-qviz-general-demo.mjs's exit code.
		publish({
			N, compileMs: 0, applyMs: 0, totalMs: 0,
			rowCount: 0, mark: '', hasViewHandle: false, hasCanvas: false,
			error: `missing DOM nodes: ${root ? '' : '#chart '}${stats ? '' : '#stats'}`,
		});
		return;
	}

	const result: DemoResult = {
		N,
		compileMs: 0,
		applyMs: 0,
		totalMs: 0,
		rowCount: 0,
		mark: '',
		hasViewHandle: false,
		hasCanvas: false,
	};

	try {
		const t0 = performance.now();
		const spec = buildSpec();
		const columns = generateColumns();

		const t1 = performance.now();
		const plan = compileGeneralPlan(spec, columns, DARK_THEME);
		result.compileMs = performance.now() - t1;
		result.rowCount = plan.spec.data.values.length;
		const m = plan.spec.mark;
		result.mark = typeof m === 'string' ? m : m.type;

		const t2 = performance.now();
		const handle = await applyGeneralPlan(root, plan);
		result.applyMs = performance.now() - t2;
		result.hasViewHandle = handle !== undefined && typeof handle.finalize === 'function';

		result.totalMs = performance.now() - t0;

		// Two RAFs to ensure paint completes, then mark done for the headless
		// runner. Mirrors the Phase 3 demo's pattern.
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				result.hasCanvas = root.querySelector('canvas') !== null;
				publish(result);
			});
		});
	} catch (err) {
		result.error = String((err as Error).message ?? err);
		publish(result);
	}

	updateStats(result);
}

function updateStats(r: DemoResult): void {
	const stats = document.getElementById('stats');
	if (!stats) { return; }
	const fmt = (n: number) => n.toFixed(1) + 'ms';
	stats.innerHTML = `
		<div><strong>Phase 4 - qviz general (Vega-Lite) render demo</strong></div>
		<hr style="border:0;border-top:1px solid #334155;margin:8px 0">
		<div>N: <span style="color:#4fc3f7">${r.N.toLocaleString()}</span></div>
		<div>compileGeneralPlan: <span style="color:#4fc3f7">${fmt(r.compileMs)}</span></div>
		<div>applyGeneralPlan: <span style="color:#4fc3f7">${fmt(r.applyMs)}</span></div>
		<div>total spec to chart: <span style="color:#4fc3f7">${fmt(r.totalMs)}</span></div>
		<div>plan rows: <span style="color:#4fc3f7">${r.rowCount.toLocaleString()}</span></div>
		<div>mark: <span style="color:#4fc3f7">${r.mark}</span></div>
		<div>view handle: <span style="color:#4fc3f7">${r.hasViewHandle ? 'yes' : 'no'}</span></div>
		<div>canvas painted: <span style="color:#4fc3f7">${r.hasCanvas ? 'yes' : 'no'}</span></div>
		${r.error ? `<div style="color:#f06292">err: ${r.error}</div>` : ''}
	`;
}

window.addEventListener('error', (e) => {
	publish({
		N,
		compileMs: 0,
		applyMs: 0,
		totalMs: 0,
		rowCount: 0,
		mark: '',
		hasViewHandle: false,
		hasCanvas: false,
		error: String(e.message ?? e),
	});
});

window.addEventListener('unhandledrejection', (e) => {
	publish({
		N,
		compileMs: 0,
		applyMs: 0,
		totalMs: 0,
		rowCount: 0,
		mark: '',
		hasViewHandle: false,
		hasCanvas: false,
		error: 'unhandled rejection: ' + String(e.reason),
	});
});

void render();

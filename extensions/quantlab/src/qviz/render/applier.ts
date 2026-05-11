/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Side-effecting Chart construction. Takes a pure TimeseriesPlan and creates
 * a real @charts-plus Chart instance bound to a DOM container.
 *
 * MUST run in the webview context -- imports from @charts-plus which carries
 * Canvas2D / WebGPU runtime code that has no meaning in the extension host.
 *
 * The compile/apply split keeps this file the only place that depends on
 * @charts-plus. Plan compilation is unit-testable without it.
 */

import {
	type BaselineSeriesOptions,
	type Chart,
	type CreateChartOptions,
	type DataPoint,
	type OhlcDataPoint,
} from '@charts-plus/chart-core';
import { createChart } from '@charts-plus/chart-render-canvas2d';
import '@charts-plus/chart-render-canvas2d/worker';

import type {
	CandlestickPlan, LinePlan, AreaPlan, BarPlan, BaselinePlan, HistogramPlan,
	TimeseriesPlan, TimeseriesSeriesPlan,
} from './types';


/**
 * Apply a TimeseriesPlan to a fresh Chart bound to `container`.
 *
 * Returns the Chart so callers can keep a handle for later updates
 * (re-applying a plan, disposing on unmount, etc.).
 *
 * IMPORTANT (audit finding #10): callers who plan to re-render must pass
 * the previous Chart via `existing` so it is disposed before a new one is
 * created. Without this, a builder UI that reapplies on every encoding
 * change leaks one Chart + its workers per call.
 *
 *   let chart: Chart | undefined;
 *   onPlanChange(plan => {
 *     chart = applyTimeseriesPlan(container, plan, chart);
 *   });
 *
 * setData(1M) is ~27ms (spike), so tear down + re-create is fine for v1.
 * A patch-in-place updater (changing only encodings, not chart type) is
 * a Phase 8 polish item.
 */
export function applyTimeseriesPlan(
	container: HTMLElement,
	plan: TimeseriesPlan,
	existing?: Chart
): Chart {
	if (existing) {
		// Megaudit M-4: prior implementation explicitly swallowed
		// dispose errors with `void e;` and a comment justifying the
		// swallow. CLAUDE.md prohibits this; the matching change to
		// `general-applier.ts` was AF20. Let dispose errors propagate
		// — RendererHost wraps applier calls and surfaces the error
		// as a structured RenderResult.
		disposeChart(existing, container);
	}

	const chartOptions: CreateChartOptions = buildCreateChartOptions(plan);
	const chart = createChart(container, chartOptions);

	for (const series of plan.series) {
		applySeries(chart, series);
	}

	return chart;
}

/**
 * Tear down a Chart instance and clear the container.
 *
 * @charts-plus has a moving disposal API across versions; this helper
 * tries the common shapes (`chart.remove()`, `chart.destroy()`,
 * `chart.dispose()`) and finally falls back to clearing the container's
 * children. Call this before discarding a Chart reference.
 */
export function disposeChart(chart: Chart, container?: HTMLElement): void {
	const c = chart as unknown as Record<string, unknown>;
	for (const methodName of ['remove', 'destroy', 'dispose'] as const) {
		const fn = c[methodName];
		if (typeof fn === 'function') {
			(fn as () => void).call(chart);
			break;
		}
	}
	if (container) {
		while (container.firstChild) {
			container.removeChild(container.firstChild);
		}
	}
}

/** Build CreateChartOptions from the plan + (optional) theme tokens. */
function buildCreateChartOptions(plan: TimeseriesPlan): CreateChartOptions {
	const opts: CreateChartOptions = {
		autoSize: plan.chart.autoSize ?? true,
		seriesRenderer: 'main',
	};
	if (plan.chart.width !== undefined) { (opts as { width?: number }).width = plan.chart.width; }
	if (plan.chart.height !== undefined) { (opts as { height?: number }).height = plan.chart.height; }
	if (plan.chart.timezone !== undefined) {
		(opts as { timeZone?: string }).timeZone = plan.chart.timezone;
	}
	return opts;
}

/** Add one series to the chart based on its plan kind. */
function applySeries(chart: Chart, series: TimeseriesSeriesPlan): void {
	switch (series.kind) {
		case 'line': {
			const s = chart.addLineSeries({ color: (series as LinePlan).color });
			s.setData(toDataPoints((series as LinePlan).data));
			return;
		}
		case 'area': {
			const s = chart.addAreaSeries({ color: (series as AreaPlan).color });
			s.setData(toDataPoints((series as AreaPlan).data));
			return;
		}
		case 'bar': {
			const s = chart.addBarSeries({ color: (series as BarPlan).color });
			s.setData(toDataPoints((series as BarPlan).data));
			return;
		}
		case 'histogram': {
			const s = chart.addHistogramSeries({ color: (series as HistogramPlan).color });
			s.setData(toHistogramPoints((series as HistogramPlan).data));
			return;
		}
		case 'baseline': {
			const bp = series as BaselinePlan;
			const opts: BaselineSeriesOptions = { color: bp.color, baseValue: bp.baseValue };
			const s = chart.addBaselineSeries(opts);
			s.setData(toDataPoints(bp.data));
			return;
		}
		case 'candlestick': {
			const s = chart.addCandlestickSeries({});
			s.setData(toOhlcPoints((series as CandlestickPlan).data));
			return;
		}
		default: {
			// Exhaustiveness check: TS will flag if a new plan kind is added.
			const exhaustive: never = series;
			throw new Error(`unknown series plan kind: ${(exhaustive as { kind: string }).kind}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Coercion: our plan types <-> chart-core's DataPoint / OhlcDataPoint
// ---------------------------------------------------------------------------

function toDataPoints(plan: readonly { t: number; v: number | null }[]): DataPoint[] {
	const out: DataPoint[] = new Array(plan.length);
	for (let i = 0; i < plan.length; i++) {
		out[i] = { t: plan[i].t, v: plan[i].v };
	}
	return out;
}

function toHistogramPoints(plan: readonly { t: number; v: number | null }[]): { t: number; v: number; color?: string }[] {
	// Audit finding #4: histogram silently truncates null y rows. Diagnostic
	// is surfaced via the plan layer (TimeseriesPlan.diagnostics) for null
	// counts; this function is the rendering coercion only and intentionally
	// drops nulls because chart-core's HistogramSeries does not have a
	// null-bucket concept. Callers wanting null-bucket semantics should
	// pre-aggregate (count rows per bin in the daemon) instead of relying
	// on this implicit drop.
	const out: { t: number; v: number; color?: string }[] = [];
	for (let i = 0; i < plan.length; i++) {
		const v = plan[i].v;
		if (v === null) { continue; }
		out.push({ t: plan[i].t, v });
	}
	return out;
}

function toOhlcPoints(plan: readonly { t: number; o: number; h: number; l: number; c: number }[]): OhlcDataPoint[] {
	const out: OhlcDataPoint[] = new Array(plan.length);
	for (let i = 0; i < plan.length; i++) {
		const p = plan[i];
		out[i] = { t: p.t, o: p.o, h: p.h, l: p.l, c: p.c };
	}
	return out;
}

// Theme adapter intentionally omitted in this iteration. chart-core's
// ThemeTokens shape is rich enough that a partial mapping is misleading;
// we let the spike app set the theme via its own getThemePreset() call
// while we work out the full QvizTheme -> ThemeTokens mapping in Phase 8.

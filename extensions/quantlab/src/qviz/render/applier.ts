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
 * NOTE: this creates a NEW chart on every call. Callers wanting to update
 * an existing chart should add an updateTimeseriesPlan helper later. For v1,
 * tear down + re-create is fine -- the spike showed setData(1M) at 27ms.
 */
export function applyTimeseriesPlan(
	container: HTMLElement,
	plan: TimeseriesPlan
): Chart {
	const chartOptions: CreateChartOptions = buildCreateChartOptions(plan);
	const chart = createChart(container, chartOptions);

	for (const series of plan.series) {
		applySeries(chart, series);
	}

	return chart;
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
	const out: { t: number; v: number; color?: string }[] = new Array(plan.length);
	let outIdx = 0;
	for (let i = 0; i < plan.length; i++) {
		const v = plan[i].v;
		if (v === null) { continue; }
		out[outIdx++] = { t: plan[i].t, v };
	}
	out.length = outIdx;
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

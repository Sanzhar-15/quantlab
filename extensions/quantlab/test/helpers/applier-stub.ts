/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stub for `@charts-plus/*` imports. Tests for the qviz renderer
 * statically load `src/qviz/render/applier.ts`, which imports from
 * `@charts-plus/chart-core` etc. — packages not available on the
 * plain-mocha path. This stub satisfies the module loader; tests that
 * actually exercise renderer behavior pass their own `appliers`
 * implementation to RendererHost so this stub's exports are never
 * invoked.
 */

// Named exports the appliers import — kept as throw-on-call factories
// so the `import { createChart } from '@charts-plus/chart-render-canvas2d'`
// line resolves without throwing at load time. Tests that exercise
// renderer behavior pass their own `appliers` to RendererHost.
//
// Megaudit Wave 11.5: type signatures must match what `applier.ts`
// actually calls so the project's `tsc -p ./` compiles cleanly. If
// charts-plus's real API changes, regenerate from its `.d.ts`.

// Megaudit-2 A6-MAJOR-5: tighten the stub's structural shape to match
// what `src/qviz/render/applier.ts` ACTUALLY emits, so renaming a key
// in `toDataPoints` / `toOhlcPoints` / adding a new chart method
// produces a compile error here rather than slipping through to
// production. Source of truth: applier.ts (the call patterns) and the
// sibling Charts repo's `.d.ts` (the runtime contract).
//
// If charts-plus's real API changes, regenerate from its `.d.ts` —
// the divergence will be caught when the production esbuild build
// resolves the real package.

export interface DataPoint {
	readonly t: number;
	readonly v: number | null;
}

export interface OhlcDataPoint {
	readonly t: number;
	readonly o: number;
	readonly h: number;
	readonly l: number;
	readonly c: number;
}

export interface HistogramDataPoint {
	readonly t: number;
	readonly v: number;
	readonly color?: string;
}

export interface BaselineSeriesOptions {
	readonly color?: string;
	readonly baseValue?: number;
}

export interface SeriesHandle<TPoint> {
	setData(data: readonly TPoint[]): void;
}

export interface Chart {
	addLineSeries(opts?: { readonly color?: string }): SeriesHandle<DataPoint>;
	addAreaSeries(opts?: { readonly color?: string }): SeriesHandle<DataPoint>;
	addBarSeries(opts?: { readonly color?: string }): SeriesHandle<DataPoint>;
	addHistogramSeries(opts?: { readonly color?: string }): SeriesHandle<HistogramDataPoint>;
	addBaselineSeries(opts?: BaselineSeriesOptions): SeriesHandle<DataPoint>;
	addCandlestickSeries(opts?: Record<string, unknown>): SeriesHandle<OhlcDataPoint>;
	// Disposal methods: the real chart-core's API has migrated across
	// `remove` / `destroy` / `dispose` over versions; `applier.disposeChart`
	// probes for the first one defined. All three are optional here so
	// the probe compiles, but at least one MUST exist at runtime
	// (production charts-plus guarantees this).
	remove?(): void;
	destroy?(): void;
	dispose?(): void;
}

export interface CreateChartOptions {
	readonly autoSize?: boolean;
	readonly seriesRenderer?: string;
	readonly width?: number;
	readonly height?: number;
	readonly timeZone?: string;
	// Permit additional opaque keys the real API supports.
	readonly [k: string]: unknown;
}

export function createChart(_container: HTMLElement, _opts?: CreateChartOptions): Chart {
	throw new Error(
		'applier-stub.createChart: charts-plus is not installed in the test env. '
		+ 'Tests must inject a custom `appliers` into RendererHost.',
	);
}

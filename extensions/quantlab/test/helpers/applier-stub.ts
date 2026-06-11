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

// ---------------------------------------------------------------------------
// W4 (2026-06-11): the chart WEBVIEW (webview/chart/chartApi.ts) is now also
// typechecked against this stub when chart tests pull it into the tsc graph.
// The richer series/Chart surface below is regenerated from the sibling
// Charts repo's chart-core/dist/api.d.ts (the runtime contract). Option types
// stay all-optional so applier.ts's narrow object literals remain assignable.
// ---------------------------------------------------------------------------

export type SeriesMarkerShape = 'circle' | 'square' | 'arrowUp' | 'arrowDown';
export type SeriesMarkerPosition = 'above' | 'below' | 'on';

export type SeriesMarker = {
	time: number;
	text?: string;
	color?: string;
	textColor?: string;
	size?: number;
	shape?: SeriesMarkerShape;
	position?: SeriesMarkerPosition;
};

export type ThemeTokens = {
	background: string;
	gridMajor: string;
	gridMinor: string;
	axisText: string;
	crosshair: string;
	focusBand: string;
	tooltipBackground?: string;
	tooltipText?: string;
	tooltipBorder?: string;
	seriesPrimary: string;
	seriesSecondary: string;
	seriesTertiary: string;
	seriesQuaternary: string;
	seriesQuinary: string;
	fontFamily: string;
	fontSizePx: number;
};

export type ThemeTokensInput = Partial<ThemeTokens>;

export type WatermarkPosition = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export type WatermarkOptions = {
	text?: string;
	color?: string;
	opacity?: number;
	fontSizePx?: number;
	fontFamily?: string;
	imageSrc?: string;
	imageWidth?: number;
	imageHeight?: number;
	position?: WatermarkPosition;
};

export type VisibleTimeRange = {
	from: number;
	to: number;
};

export type CrosshairMoveEvent = {
	time: number;
	formattedTime: string;
	x: number;
	y: number;
	paneId?: string;
	seriesValues: Map<string, { value: number | null; formatted: string }>;
};

export type Rect = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type PaneLayout = {
	id: string;
	plotRect: Rect;
	leftAxisRect: Rect | null;
	rightAxisRect: Rect | null;
};

export type LayoutResult = {
	chartRect: Rect;
	plotRect: Rect;
	leftAxisRect: Rect | null;
	rightAxisRect: Rect | null;
	timeAxisRect: Rect | null;
	panes?: PaneLayout[];
};

export type PluginRenderState = {
	layout: LayoutResult;
	plotRect: Rect;
	visibleRange: VisibleTimeRange;
	panOffset?: number;
	theme: ThemeTokens;
	timeToX: (time: number) => number;
	xToTime: (x: number) => number;
	valueToY: (value: number) => number;
	valueToYLeft: (value: number) => number;
	valueToYRight: (value: number) => number;
	yToValue: (y: number) => number;
	snapX: (x: number) => number;
	snapY: (y: number) => number;
};

export type PluginPointerEvent = {
	type: 'down' | 'move' | 'up' | 'leave';
	x: number;
	y: number;
	time: number | null;
	inPlot: boolean;
};

export type ChartPlugin<Ctx = unknown> = {
	onInit?: (chart: Chart) => void;
	onRenderUnderlay?: (ctx: Ctx, state: PluginRenderState) => void;
	onRenderOverlay?: (ctx: Ctx, state: PluginRenderState) => void;
	onPointer?: (event: PluginPointerEvent, state: PluginRenderState) => boolean | void;
};

export type LineSeriesOptions = {
	id?: string;
	paneId?: string;
	axis?: 'left' | 'right';
	title?: string;
	color?: string;
	width?: number;
	dash?: number[];
	opacity?: number;
	visible?: boolean;
	lastValueVisible?: boolean;
	priceLineVisible?: boolean;
	isVolume?: boolean;
	valueFormatter?: (value: number) => string;
};

export type HistogramSeriesOptions = LineSeriesOptions;
export type AreaSeriesOptions = LineSeriesOptions;
export type CandlestickSeriesOptions = LineSeriesOptions & {
	upColor?: string;
	downColor?: string;
};

export interface LineSeries {
	readonly id: string;
	setData(points: readonly DataPoint[]): void;
	setMarkers(markers: SeriesMarker[]): void;
	setVisible(visible: boolean): void;
	getVisible(): boolean;
}

export interface AreaSeries {
	readonly id: string;
	setData(points: readonly DataPoint[]): void;
	setMarkers(markers: SeriesMarker[]): void;
	setVisible(visible: boolean): void;
	getVisible(): boolean;
}

export interface HistogramSeries {
	readonly id: string;
	setData(points: readonly HistogramDataPoint[]): void;
	setMarkers(markers: SeriesMarker[]): void;
	setVisible(visible: boolean): void;
	getVisible(): boolean;
}

export interface CandlestickSeries {
	readonly id: string;
	setData(points: readonly OhlcDataPoint[]): void;
	setMarkers(markers: SeriesMarker[]): void;
	setVisible(visible: boolean): void;
	getVisible(): boolean;
}

export type AxisOptions = {
	formatter?: (value: number) => string;
	decimals?: number;
	tickCount?: number;
	minWidth?: number;
};

export interface PaneApi {
	readonly id: string;
	setHeight(height: number): void;
	getHeight(): number | null;
	setStretchFactor(stretchFactor: number): void;
	getStretchFactor(): number;
	setVisible(visible: boolean): void;
	isVisible(): boolean;
	moveTo(index: number): void;
	setPreserveEmptyPane(preserve: boolean): void;
	preserveEmptyPane(): boolean;
}

export interface Chart {
	addLineSeries(opts?: LineSeriesOptions): LineSeries;
	addAreaSeries(opts?: AreaSeriesOptions): AreaSeries;
	addBarSeries(opts?: { readonly color?: string }): SeriesHandle<DataPoint>;
	addHistogramSeries(opts?: HistogramSeriesOptions): HistogramSeries;
	addBaselineSeries(opts?: BaselineSeriesOptions): SeriesHandle<DataPoint>;
	addCandlestickSeries(opts?: CandlestickSeriesOptions): CandlestickSeries;
	addPane(preserveEmptyPane?: boolean): string;
	getPane(id: string): PaneApi | null;
	getPanes(): PaneApi[];
	batch(fn: () => void): void;
	addPlugin<Ctx>(plugin: ChartPlugin<Ctx>): void;
	setAxisOptions(axis: 'left' | 'right', options: AxisOptions): void;
	setPaneAxisOptions(paneId: string, axis: 'left' | 'right', options: AxisOptions): void;
	setVisibleTimeRange(range: VisibleTimeRange): void;
	getVisibleTimeRange(): VisibleTimeRange;
	onVisibleTimeRangeChange(cb: (range: VisibleTimeRange) => void): () => void;
	setCrosshair(state: { time: number; paneId?: string; yRatio?: number } | null): void;
	onCrosshairMove(cb: (event: CrosshairMoveEvent) => void): () => void;
	setTheme(theme: ThemeTokensInput): void;
	setWatermark(options: WatermarkOptions | null): void;
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

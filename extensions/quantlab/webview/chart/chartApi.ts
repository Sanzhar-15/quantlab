/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createChart } from '@charts-plus/chart-render-canvas2d';
import type {
	AreaSeries,
	CandlestickSeries,
	Chart,
	HistogramSeries,
	LineSeries,
	SeriesMarker,
	ThemeTokensInput
} from '@charts-plus/chart-core';

export interface OhlcvBar {
	t: number;
	o: number;
	h: number;
	l: number;
	c: number;
	v?: number;
}

export interface EquityPoint {
	t: number;
	v: number;
}

export interface SignalPoint {
	t: number;
	type: 'entry' | 'exit';
	label?: string;
	price?: number;
}

export interface TradeOrderPoint {
	id: string;
	symbol: string;
	side: 'buy' | 'sell';
	type: string;
	quantity: number;
	price?: number;
	status: string;
	createdAt: number;
}

export interface TradePositionPoint {
	symbol: string;
	quantity: number;
	avgPrice: number;
	currentPrice: number;
	unrealizedPnL: number;
	updatedAt?: number;
}

export interface TradeFillPoint {
	id: string;
	orderId: string;
	symbol: string;
	side: 'buy' | 'sell';
	quantity: number;
	price: number;
	timestamp: number;
}

export type VisualizationCommand =
	| { type: 'addPane'; id: string; height?: number }
	| { type: 'addIndicator'; indicator: string; params: Record<string, unknown> }
	| { type: 'removeIndicator'; id: string }
	| { type: 'plotSeries'; series: 'line' | 'histogram' | 'area'; data: Array<{ t: number; v: number }>; options?: Record<string, unknown> }
	| { type: 'markEntries'; entries: Array<{ t: number; label?: string; price?: number }> }
	| { type: 'markExits'; exits: Array<{ t: number; label?: string; price?: number }> }
	| { type: 'setEquityCurve'; equity: Array<{ t: number; v: number }> }
	| { type: 'clear'; target: 'signals' | 'equity' | 'indicators' | 'all' };

type SeriesHandle = LineSeries | HistogramSeries | AreaSeries;

type VisualizationSeriesHandle = {
	type: 'line' | 'histogram' | 'area';
	paneKey?: string;
	optionsKey: string;
	series: SeriesHandle;
	active: boolean;
};

interface ChartColors {
	positive: string;
	negative: string;
	warning: string;
	info: string;
	neutral: string;
}

interface ChartBounds {
	start: number;
	end: number;
}

const ORD_STEP_MS = 86_400_000; // 1 day -- universal step for ordinal spacing

class OrdinalTimeMap {
	readonly realTimes: number[];
	private readonly _r2f: Map<number, number>;

	constructor(realTimes: number[]) {
		this.realTimes = realTimes;
		this._r2f = new Map();
		for (let i = 0; i < realTimes.length; i++) {
			this._r2f.set(realTimes[i], i * ORD_STEP_MS);
		}
	}

	/** Snap a real timestamp to the nearest bar's fake time (binary search). */
	snapToFake(realTime: number): number {
		const exact = this._r2f.get(realTime);
		if (exact !== undefined) { return exact; }
		const arr = this.realTimes;
		if (arr.length === 0) { return 0; }
		if (realTime <= arr[0]) { return 0; }
		if (realTime >= arr[arr.length - 1]) { return (arr.length - 1) * ORD_STEP_MS; }
		let lo = 0, hi = arr.length - 1;
		while (lo < hi - 1) {
			const mid = (lo + hi) >>> 1;
			if (arr[mid] <= realTime) { lo = mid; } else { hi = mid; }
		}
		const idx = (realTime - arr[lo] <= arr[hi] - realTime) ? lo : hi;
		return idx * ORD_STEP_MS;
	}

	/** Convert fake time back to real time (for display formatting). */
	toReal(fakeTime: number): number {
		const idx = Math.max(0, Math.min(Math.round(fakeTime / ORD_STEP_MS), this.realTimes.length - 1));
		return this.realTimes[idx];
	}
}

export class ChartClient {
	private chart: Chart | undefined;
	private candleSeries: CandlestickSeries | undefined;
	private equitySeries: LineSeries | undefined;
	private static readonly MAX_VIZ_SERIES = 64;
	private visualizationSeries: VisualizationSeriesHandle[] = [];
	private signalMarkers: SeriesMarker[] = [];
	private tradeOrderMarkers: SeriesMarker[] = [];
	private tradePositionMarkers: SeriesMarker[] = [];
	private tradeFillMarkers: SeriesMarker[] = [];
	private lastSignals: SignalPoint[] = [];
	private lastTradeOrders: TradeOrderPoint[] = [];
	private lastTradePositions: TradePositionPoint[] = [];
	private lastTradeFills: TradeFillPoint[] = [];
	private initPromise: Promise<void> | undefined;
	private theme: 'light' | 'dark' = 'dark';
	private timeframe = '1D';
	private colors = this.resolveColors();
	private paneMap = new Map<string, string>();
	private fittedBounds: ChartBounds | undefined;
	private colorProbe: HTMLSpanElement | undefined;
	private fontProbe: HTMLSpanElement | undefined;
	private timeFormatters = new Map<string, Intl.DateTimeFormat>();
	private paneDividerColor = this.resolveColorVar('--vscode-editorGroup-border', 'rgba(255, 255, 255, 0.2)');
	private strategyPaneKeys = new Set<string>();
	private strategyPaneVisible = true;
	private ordinalMap: OrdinalTimeMap | null = null;

	constructor(private readonly container: HTMLElement) { }

	private snapTime(t: number): number {
		return this.ordinalMap ? this.ordinalMap.snapToFake(t) : t;
	}

	async initialize(theme: 'light' | 'dark'): Promise<void> {
		this.theme = theme;
		if (!this.initPromise) {
			this.initPromise = this.createChart();
		}
		await this.initPromise;
		this.applyThemeTokens();
	}

	async setData(data: OhlcvBar[]): Promise<void> {
		await this.ensureChart();
		if (!this.candleSeries) {
			return;
		}

		// Build ordinal map from real timestamps and remap bars
		const realTimes = data.map(bar => bar.t);
		this.ordinalMap = new OrdinalTimeMap(realTimes);
		const remapped = data.map((bar, i) => ({ ...bar, t: i * ORD_STEP_MS }));

		this.candleSeries.setData(remapped);
		this.fitToData(remapped);

		// Re-remap existing overlay markers against the new ordinal map
		this.rebuildMarkers();
	}

	async setEquityCurve(data: EquityPoint[]): Promise<void> {
		await this.ensureChart();
		if (!this.chart) {
			return;
		}

		if (!data.length) {
			if (this.equitySeries) {
				this.equitySeries.setData([]);
				this.equitySeries.setVisible(false);
			}
			return;
		}

		const paneId = this.ensurePane('equity');
		if (!this.equitySeries) {
			this.equitySeries = this.chart.addLineSeries({
				color: this.colors.warning,
				width: 2,
				paneId,
				axis: 'right',
				priceLineVisible: false
			});
		}

		this.equitySeries.setVisible(true);
		this.equitySeries.setData(data.map(pt => ({ t: this.snapTime(pt.t), v: pt.v })));
	}

	async setSignals(signals: SignalPoint[]): Promise<void> {
		await this.ensureChart();
		this.lastSignals = signals;
		this.signalMarkers = this.buildSignalMarkers(signals);
		this.updateMarkers();
	}

	setTimeframe(timeframe: string): void {
		const normalized = timeframe.trim();
		if (!normalized) {
			return;
		}
		this.timeframe = normalized;

		if (this.chart && this.fittedBounds) {
			this.chart.setVisibleTimeRange({ from: this.fittedBounds.start, to: this.fittedBounds.end });
		}
	}

	async applyVisualization(commands: VisualizationCommand[]): Promise<void> {
		await this.ensureChart();
		if (!this.chart) {
			return;
		}

		const entries: SignalPoint[] = [];
		const exits: SignalPoint[] = [];
		const pendingEquity: OhlcvBar[][] = [];

		this.chart.batch(() => {
			this.resetVisualizationSeries();
			for (const command of commands) {
				switch (command.type) {
					case 'addPane':
						this.ensurePane(command.id, command.height);
						break;
					case 'plotSeries': {
						const paneKey = typeof command.options?.paneId === 'string' ? command.options?.paneId : undefined;
						const resolvedPane = paneKey ? this.ensurePane(paneKey) : undefined;
						const seriesOptions = this.buildSeriesOptions(command.options, resolvedPane);
						const optionsKey = this.buildSeriesOptionsKey(seriesOptions, command.series);
						const handle = this.getVisualizationSeries(command.series, optionsKey, paneKey, seriesOptions);
						handle.series.setVisible(true);
						handle.series.setData(command.data.map(pt => ({ t: this.snapTime(pt.t), v: pt.v })));
						handle.active = true;
						break;
					}
					case 'markEntries':
						for (const entry of command.entries) {
							entries.push({ ...entry, type: 'entry' });
						}
						break;
					case 'markExits':
						for (const exit of command.exits) {
							exits.push({ ...exit, type: 'exit' });
						}
						break;
					case 'setEquityCurve':
						pendingEquity.push(command.equity);
						break;
					case 'clear':
						if (command.target === 'signals' || command.target === 'all') {
							this.clearSignals();
						}
						if (command.target === 'equity' || command.target === 'all') {
							pendingEquity.push([]);
						}
						// indicators already reset at the top of the batch closure
						break;
					case 'addIndicator':
					case 'removeIndicator':
					default:
						break;
				}
			}
		});

		for (const equity of pendingEquity) {
			await this.setEquityCurve(equity);
		}

		if (entries.length || exits.length) {
			await this.setSignals([...entries, ...exits]);
		}

		this.syncStrategyPaneVisibility();
	}

	async setTradeOrders(orders: TradeOrderPoint[]): Promise<void> {
		await this.ensureChart();
		this.lastTradeOrders = orders;
		this.tradeOrderMarkers = orders
			.filter(order => typeof order.price === 'number')
			.map(order => ({
				time: this.snapTime(order.createdAt),
				text: order.side === 'buy' ? 'Buy' : 'Sell',
				color: order.side === 'buy' ? this.colors.positive : this.colors.negative,
				shape: 'square',
				position: order.side === 'buy' ? 'below' : 'above'
			}));
		this.updateMarkers();
	}

	async setTradePositions(positions: TradePositionPoint[]): Promise<void> {
		await this.ensureChart();
		this.lastTradePositions = positions;
		this.tradePositionMarkers = positions
			.filter(position => Number.isFinite(position.avgPrice) || Number.isFinite(position.currentPrice))
			.map(position => ({
				time: this.snapTime(position.updatedAt ?? Date.now()),
				text: 'Pos',
				color: this.colors.info,
				shape: 'circle',
				position: 'on'
			}));
		this.updateMarkers();
	}

	async setTradeFills(fills: TradeFillPoint[]): Promise<void> {
		await this.ensureChart();
		this.lastTradeFills = fills;
		this.tradeFillMarkers = fills.map(fill => ({
			time: this.snapTime(fill.timestamp),
			text: fill.side === 'buy' ? 'Fill' : 'Exit',
			color: fill.side === 'buy' ? this.colors.positive : this.colors.negative,
			shape: fill.side === 'buy' ? 'arrowUp' : 'arrowDown',
			position: fill.side === 'buy' ? 'below' : 'above'
		}));
		this.updateMarkers();
	}

	clearTradeOverlays(): void {
		this.tradeOrderMarkers = [];
		this.tradePositionMarkers = [];
		this.tradeFillMarkers = [];
		this.lastTradeOrders = [];
		this.lastTradePositions = [];
		this.lastTradeFills = [];
		this.updateMarkers();
	}

	clearSignals(): void {
		this.signalMarkers = [];
		this.lastSignals = [];
		this.updateMarkers();
	}

	setTheme(theme: 'light' | 'dark'): void {
		this.theme = theme;
		this.colors = this.resolveColors();
		this.paneDividerColor = this.resolveColorVar('--vscode-editorGroup-border', 'rgba(255, 255, 255, 0.2)');
		this.applyThemeTokens();
		this.rebuildMarkers();
	}

	refreshLayout(): void {
		if (!this.chart) {
			return;
		}
		const range = this.chart.getVisibleTimeRange();
		this.chart.setVisibleTimeRange(range);
	}

	setStrategyPaneVisible(visible: boolean): void {
		this.strategyPaneVisible = visible;
		this.syncStrategyPaneVisibility();
	}

	toggleStrategyPane(): boolean {
		this.setStrategyPaneVisible(!this.strategyPaneVisible);
		return this.strategyPaneVisible;
	}

	private async ensureChart(): Promise<void> {
		if (!this.initPromise) {
			await this.initialize(this.theme);
			return;
		}
		await this.initPromise;
	}

	private async createChart(): Promise<void> {
		this.colors = this.resolveColors();
		this.chart = createChart(this.container, {
			theme: this.buildThemeTokens(),
			autoSize: true,
			timeFormatter: (time: number) => this.formatTime(time),
			timeScale: {
				elasticClamp: true,
				elasticMaxRatio: 0.12,
			},
			interaction: {
				pan: {
					freezeAxis: false,
					freezeAxisThreshold: 0.15,
				},
				crosshair: {
					snapToData: true,
				},
			},
		});
		this.installPaneDividerPlugin();
		this.candleSeries = this.chart.addCandlestickSeries({
			upColor: this.colors.positive,
			downColor: this.colors.negative,
			axis: 'right'
		});
	}

	private ensurePane(key: string, height?: number): string {
		if (!this.chart) {
			return key;
		}
		if (this.isStrategyKey(key)) {
			this.strategyPaneKeys.add(key);
		}
		const existing = this.paneMap.get(key);
		if (existing) {
			if (typeof height === 'number') {
				this.applyPaneHeight(existing, height);
			}
			return existing;
		}
		const paneId = this.chart.addPane(true);
		this.paneMap.set(key, paneId);
		const pane = this.chart.getPane(paneId);
		pane?.setPreserveEmptyPane(true);
		if (this.isStrategyKey(key) && !this.strategyPaneVisible) {
			pane?.setVisible(false);
		}
		if (typeof height === 'number') {
			this.applyPaneHeight(paneId, height);
		} else if (this.isStrategyKey(key)) {
			this.applyPaneHeight(paneId, 0.25);
		}
		return paneId;
	}

	private applyPaneHeight(paneId: string, height: number): void {
		if (!this.chart || !Number.isFinite(height) || height <= 0) {
			return;
		}
		const pane = this.chart.getPane(paneId);
		if (!pane) {
			return;
		}
		if (height <= 1) {
			pane.setStretchFactor(height);
			return;
		}
		pane.setHeight(height);
	}

	private isStrategyKey(key: string): boolean {
		return key !== 'equity';
	}

	private getStrategyPaneIds(): string[] {
		const paneIds: string[] = [];
		for (const key of this.strategyPaneKeys) {
			const paneId = this.paneMap.get(key);
			if (paneId) {
				paneIds.push(paneId);
			}
		}
		return paneIds;
	}

	private syncStrategyPaneVisibility(): void {
		if (!this.chart) {
			return;
		}
		const paneIds = this.getStrategyPaneIds();
		for (const paneId of paneIds) {
			const pane = this.chart.getPane(paneId);
			if (!pane) {
				continue;
			}
			pane.setVisible(this.strategyPaneVisible);
		}
	}

	private resetVisualizationSeries(): void {
		for (const handle of this.visualizationSeries) {
			handle.active = false;
			handle.series.setVisible(false);
		}
	}

	private getVisualizationSeries(
		type: 'line' | 'histogram' | 'area',
		optionsKey: string,
		paneKey: string | undefined,
		options: Record<string, unknown>
	): VisualizationSeriesHandle {
		const candidate = this.visualizationSeries.find(handle =>
			!handle.active && handle.type === type && handle.optionsKey === optionsKey && handle.paneKey === paneKey
		);
		if (candidate) {
			candidate.active = true;
			return candidate;
		}

		if (!this.chart) {
			throw new Error('Chart not initialized');
		}

		let series: SeriesHandle;
		const typedOptions = options as any;
		if (type === 'histogram') {
			series = this.chart.addHistogramSeries(typedOptions);
		} else if (type === 'area') {
			series = this.chart.addAreaSeries(typedOptions);
		} else {
			series = this.chart.addLineSeries(typedOptions);
		}

		const handle: VisualizationSeriesHandle = {
			type,
			paneKey,
			optionsKey,
			series,
			active: true
		};

		// Evict oldest inactive series if at capacity
		while (this.visualizationSeries.length >= ChartClient.MAX_VIZ_SERIES) {
			const inactiveIdx = this.visualizationSeries.findIndex(h => !h.active);
			if (inactiveIdx === -1) {
				break; // All active -- allow temporary overflow
			}
			const evicted = this.visualizationSeries.splice(inactiveIdx, 1)[0];
			this.chart?.removeSeries(evicted.series);
			// Prune pane entry only if no remaining series reference it AND
			// the new handle being added doesn't share the same paneKey
			if (evicted.paneKey !== undefined && evicted.paneKey !== paneKey) {
				const stillUsed = this.visualizationSeries.some(h => h.paneKey === evicted.paneKey);
				if (!stillUsed) {
					this.paneMap.delete(evicted.paneKey);
					this.strategyPaneKeys.delete(evicted.paneKey);
				}
			}
		}

		this.visualizationSeries.push(handle);
		return handle;
	}

	private updateMarkers(): void {
		if (!this.candleSeries) {
			return;
		}
		const markers = [
			...this.signalMarkers,
			...this.tradeOrderMarkers,
			...this.tradePositionMarkers,
			...this.tradeFillMarkers
		].sort((a, b) => a.time - b.time);
		this.candleSeries.setMarkers(markers);
	}

	private rebuildMarkers(): void {
		this.signalMarkers = this.buildSignalMarkers(this.lastSignals);
		this.tradeOrderMarkers = this.lastTradeOrders
			.filter(order => typeof order.price === 'number')
			.map(order => ({
				time: this.snapTime(order.createdAt),
				text: order.side === 'buy' ? 'Buy' : 'Sell',
				color: order.side === 'buy' ? this.colors.positive : this.colors.negative,
				shape: 'square',
				position: order.side === 'buy' ? 'below' : 'above'
			}));
		this.tradePositionMarkers = this.lastTradePositions
			.filter(position => Number.isFinite(position.avgPrice) || Number.isFinite(position.currentPrice))
			.map(position => ({
				time: this.snapTime(position.updatedAt ?? Date.now()),
				text: 'Pos',
				color: this.colors.info,
				shape: 'circle',
				position: 'on'
			}));
		this.tradeFillMarkers = this.lastTradeFills.map(fill => ({
			time: this.snapTime(fill.timestamp),
			text: fill.side === 'buy' ? 'Fill' : 'Exit',
			color: fill.side === 'buy' ? this.colors.positive : this.colors.negative,
			shape: fill.side === 'buy' ? 'arrowUp' : 'arrowDown',
			position: fill.side === 'buy' ? 'below' : 'above'
		}));
		this.updateMarkers();
	}

	private buildSignalMarkers(signals: SignalPoint[]): SeriesMarker[] {
		return signals
			.filter(signal => typeof signal.t === 'number')
			.map(signal => {
				const isEntry = signal.type === 'entry';
				return {
					time: this.snapTime(signal.t),
					text: signal.label ?? (isEntry ? 'Entry' : 'Exit'),
					color: isEntry ? this.colors.positive : this.colors.negative,
					shape: isEntry ? 'arrowUp' : 'arrowDown',
					position: isEntry ? 'below' : 'above'
				};
			});
	}

	private applyThemeTokens(): void {
		if (!this.chart) {
			return;
		}
		this.chart.setTheme(this.buildThemeTokens());
	}

	private installPaneDividerPlugin(): void {
		if (!this.chart) {
			return;
		}

		this.chart.addPlugin({
			onRenderOverlay: (ctx, state) => {
				const panes = state.layout.panes ?? [];
				if (panes.length <= 1) {
					return;
				}
				ctx.save();
				ctx.strokeStyle = this.paneDividerColor;
				ctx.lineWidth = 2;
				for (let i = 0; i < panes.length - 1; i++) {
					const pane = panes[i];
					const y = state.snapY(pane.plotRect.y + pane.plotRect.height);
					ctx.beginPath();
					ctx.moveTo(state.plotRect.x, y);
					ctx.lineTo(state.plotRect.x + state.plotRect.width, y);
					ctx.stroke();
				}
				ctx.restore();
			}
		});
	}

	private fitToData(data: OhlcvBar[]): void {
		if (!this.chart || data.length < 2) {
			return;
		}

		const start = data[0]?.t ?? 0;
		const end = data[data.length - 1]?.t ?? 0;
		if (!Number.isFinite(start) || !Number.isFinite(end)) {
			return;
		}

		if (this.fittedBounds && this.fittedBounds.start === start && this.fittedBounds.end === end) {
			return;
		}

		this.chart.setVisibleTimeRange({ from: start, to: end });
		this.fittedBounds = { start, end };
	}

	private resolveColors(): ChartColors {
		return {
			positive: this.resolveColorVar('--ql-status-positive', '#059669'),
			negative: this.resolveColorVar('--ql-status-negative', '#dc2626'),
			warning: this.resolveColorVar('--ql-status-warning', '#d97706'),
			info: this.resolveColorVar('--ql-status-info', '#2563eb'),
			neutral: this.resolveColorVar('--ql-status-neutral', '#6b7280')
		};
	}

	private formatTime(time: number): string {
		if (!Number.isFinite(time)) {
			return '';
		}
		const realTime = this.ordinalMap ? this.ordinalMap.toReal(time) : time;
		const kind = this.resolveTimeFormatKind();
		const formatter = this.getTimeFormatter(kind);
		return formatter.format(new Date(realTime));
	}

	private resolveTimeFormatKind(): 'minute' | 'hour' | 'day' | 'month' {
		switch (this.timeframe) {
			case '1m':
			case '5m':
			case '15m':
			case '30m':
				return 'minute';
			case '1H':
			case '4H':
				return 'hour';
			case '1M':
				return 'month';
			case '1W':
			case '1D':
			default:
				return 'day';
		}
	}

	private getTimeFormatter(kind: 'minute' | 'hour' | 'day' | 'month'): Intl.DateTimeFormat {
		const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
		const key = `${locale}:${kind}`;
		const cached = this.timeFormatters.get(key);
		if (cached) {
			return cached;
		}

		const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC' };
		if (kind === 'minute') {
			options.month = 'short';
			options.day = 'numeric';
			options.hour = '2-digit';
			options.minute = '2-digit';
		} else if (kind === 'hour') {
			options.month = 'short';
			options.day = 'numeric';
			options.hour = '2-digit';
		} else if (kind === 'month') {
			options.month = 'short';
			options.year = 'numeric';
		} else {
			options.month = 'short';
			options.day = 'numeric';
			options.year = 'numeric';
		}

		const formatter = new Intl.DateTimeFormat(locale, options);
		this.timeFormatters.set(key, formatter);
		return formatter;
	}

	private buildThemeTokens(): ThemeTokensInput {
		const styles = getComputedStyle(document.documentElement);
		const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
		const background = this.resolveColor(read('--ql-bg', '#0a0f18'));
		const axisText = this.resolveColor(read('--ql-fg', '#e7edf8'));
		const gridMajor = this.resolveColor(read('--vscode-editorGroup-border', 'rgba(255,255,255,0.12)'));
		const gridMinor = this.resolveColor(read('--vscode-editorWidget-border', 'rgba(255,255,255,0.06)'));
		const crosshair = this.resolveColor(read('--vscode-focusBorder', this.colors.info));
		const focusBand = this.resolveColor(read('--vscode-editor-inactiveSelectionBackground', 'rgba(89,145,255,0.12)'));
		const tooltipBackground = this.resolveColor(read('--vscode-editorHoverWidget-background', background));
		const tooltipText = this.resolveColor(read('--vscode-editorHoverWidget-foreground', axisText));
		const tooltipBorder = this.resolveColor(read('--vscode-editorHoverWidget-border', gridMajor));
		const fontFamily = this.resolveFontFamily(read('--ql-font-family', 'system-ui, sans-serif'));
		const fontSizePx = this.resolveFontSize(read('--ql-font-size-base', '12px'));

		return {
			background,
			gridMajor,
			gridMinor,
			axisText,
			crosshair,
			focusBand,
			tooltipBackground,
			tooltipText,
			tooltipBorder,
			seriesPrimary: this.colors.info,
			seriesSecondary: this.colors.negative,
			seriesTertiary: this.colors.positive,
			seriesQuaternary: this.colors.warning,
			seriesQuinary: this.colors.neutral,
			fontFamily,
			fontSizePx
		};
	}

	private resolveColorVar(name: string, fallback: string): string {
		const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
		return this.resolveColor(value);
	}

	private resolveColor(value: string): string {
		if (!this.colorProbe) {
			this.colorProbe = document.createElement('span');
			this.colorProbe.style.position = 'absolute';
			this.colorProbe.style.opacity = '0';
			this.colorProbe.style.pointerEvents = 'none';
			document.body.appendChild(this.colorProbe);
		}
		this.colorProbe.style.color = value;
		const computed = getComputedStyle(this.colorProbe).color;
		return computed || value;
	}

	private resolveFontFamily(value: string): string {
		if (!this.fontProbe) {
			this.fontProbe = document.createElement('span');
			this.fontProbe.style.position = 'absolute';
			this.fontProbe.style.opacity = '0';
			this.fontProbe.style.pointerEvents = 'none';
			document.body.appendChild(this.fontProbe);
		}
		this.fontProbe.style.fontFamily = value;
		return getComputedStyle(this.fontProbe).fontFamily || value;
	}

	private resolveFontSize(value: string): number {
		if (!this.fontProbe) {
			this.fontProbe = document.createElement('span');
			this.fontProbe.style.position = 'absolute';
			this.fontProbe.style.opacity = '0';
			this.fontProbe.style.pointerEvents = 'none';
			document.body.appendChild(this.fontProbe);
		}
		this.fontProbe.style.fontSize = value;
		const computed = getComputedStyle(this.fontProbe).fontSize;
		const parsed = Number.parseFloat(computed);
		return Number.isFinite(parsed) ? parsed : 12;
	}

	private buildSeriesOptions(options?: Record<string, unknown>, paneId?: string): Record<string, unknown> {
		const seriesOptions: Record<string, unknown> = {
			priceLineVisible: false,
			axis: 'right'
		};

		if (paneId) {
			seriesOptions.paneId = paneId;
		}

		if (!options) {
			return seriesOptions;
		}

		if (typeof options.color === 'string') {
			seriesOptions.color = options.color;
		}
		if (typeof options.title === 'string') {
			seriesOptions.title = options.title;
		}
		const width = typeof options.lineWidth === 'number' ? options.lineWidth : Number(options.lineWidth);
		if (Number.isFinite(width)) {
			seriesOptions.width = width;
		} else if (typeof options.width === 'number' && Number.isFinite(options.width)) {
			seriesOptions.width = options.width;
		}
		if (typeof options.lineStyle === 'string') {
			const dash = this.resolveDash(options.lineStyle);
			if (dash) {
				seriesOptions.dash = dash;
			}
		}
		if (typeof options.opacity === 'number') {
			seriesOptions.opacity = options.opacity;
		}
		if (typeof options.priceLineVisible === 'boolean') {
			seriesOptions.priceLineVisible = options.priceLineVisible;
		}

		return seriesOptions;
	}

	private resolveDash(style: string): number[] | undefined {
		const normalized = style.toLowerCase();
		if (normalized === 'dashed') {
			return [6, 4];
		}
		if (normalized === 'dotted') {
			return [2, 4];
		}
		return undefined;
	}

	private buildSeriesOptionsKey(options: Record<string, unknown>, seriesType: string): string {
		const key = {
			seriesType,
			paneId: options.paneId ?? null,
			axis: options.axis ?? null,
			color: options.color ?? null,
			title: options.title ?? null,
			width: options.width ?? null,
			dash: options.dash ?? null,
			opacity: options.opacity ?? null,
			priceLineVisible: options.priceLineVisible ?? null
		};
		return JSON.stringify(key);
	}

	private async applyClearCommand(target: 'signals' | 'equity' | 'indicators' | 'all'): Promise<void> {
		if (target === 'signals' || target === 'all') {
			this.clearSignals();
		}
		if (target === 'equity' || target === 'all') {
			await this.setEquityCurve([]);
		}
		if (target === 'indicators' || target === 'all') {
			this.resetVisualizationSeries();
		}
	}
}

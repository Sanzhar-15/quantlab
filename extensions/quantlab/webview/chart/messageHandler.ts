/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChartClient, EquityPoint, OhlcvBar, SignalPoint, TradeFillPoint, TradeOrderPoint, TradePositionPoint, VisualizationCommand } from './chartApi';
import type { ParameterPanel, ParameterDefinition } from './parameterPanel';

interface ComplexityInfo {
	level: 'safe' | 'partial' | 'viewOnly';
	score: number;
	reasons: string[];
}

interface LocalFileDataSource {
	kind: 'localFile';
	filePath: string;
	displayName: string;
}

interface ServerDataSource {
	kind: 'server';
	symbol: string;
	displayName: string;
	/** Routes crypto symbols to the crypto bars endpoint; must round-trip. */
	assetClass?: string;
}

type DataSourceDescriptor = LocalFileDataSource | ServerDataSource;

function isLocalFileSource(source: DataSourceDescriptor): source is LocalFileDataSource {
	return source.kind === 'localFile';
}

function isServerSource(source: DataSourceDescriptor): source is ServerDataSource {
	return source.kind === 'server';
}

interface ChartToolbarState {
	dataSource?: DataSourceDescriptor;
	timeframe?: string;
	dateRange?: { start: string; end: string };
	recentSources?: DataSourceDescriptor[];
	complexity: ComplexityInfo;
	hasVisualization: boolean;
	viewOnly: boolean;
	/** 'data' = market-data viewing (server-symbol tabs); 'strategy' = classic surface. */
	mode?: 'data' | 'strategy';
}

type ChartErrorAction = 'selectData' | 'editVisualization' | 'reload';

type ChartMessage =
	| { type: 'init'; payload: { theme: 'light' | 'dark'; toolbar: ChartToolbarState; parameters: ParameterDefinition[]; overrides: Record<string, unknown> } }
	| { type: 'setToolbar'; toolbar: ChartToolbarState }
	| { type: 'setRecentSources'; sources: DataSourceDescriptor[] }
	| { type: 'setData'; requestId: number; data: OhlcvBar[] }
	| { type: 'setDataBinary'; requestId: number; buffer: ArrayBuffer; count: number }
	| { type: 'setSignals'; requestId: number; signals: SignalPoint[] }
	| { type: 'addSignal'; signal: SignalPoint }
	| { type: 'showLoading'; requestId: number }
	| { type: 'showEmptyState' }
	| { type: 'setEquityCurve'; requestId: number; equity: EquityPoint[] }
	| { type: 'setVisualization'; requestId: number; commands: VisualizationCommand[] }
	| { type: 'setTradeOrders'; sessionId: string; orders: TradeOrderPoint[] }
	| { type: 'setTradePositions'; sessionId: string; positions: TradePositionPoint[] }
	| { type: 'setTradeFills'; sessionId: string; fills: TradeFillPoint[] }
	| { type: 'clearTradeOverlays'; sessionId: string }
	| { type: 'setParameters'; parameters: ParameterDefinition[] }
	| { type: 'setOverrides'; overrides: Record<string, unknown> }
	| { type: 'setComplexity'; complexity: ComplexityInfo }
	| { type: 'setTheme'; theme: 'light' | 'dark' }
	| { type: 'toggleParameters'; collapsed: boolean }
	| { type: 'showBanner'; message: string; tone?: 'info' | 'warning' }
	| { type: 'showError'; message: string; detail?: string; actions?: ChartErrorAction[] };

interface MessageHandlerContext {
	postMessage: (message: unknown) => void;
	chart: ChartClient;
	parameterPanel: ParameterPanel;
	banner: HTMLElement;
	noViz: HTMLElement;
	/** Applies data/strategy mode to the shell (chrome swap, volume pane). */
	applyMode: (mode: 'data' | 'strategy') => void;
	/** Market header (data mode): quote/presets driven by toolbar + bars. */
	marketHeader: {
		setSource(symbol: string | undefined, displayName: string | undefined, assetClass?: string): void;
		setTimeframe(timeframe: string | undefined): void;
		updateFromBars(bars: OhlcvBar[]): void;
		setRange(range: { start: string; end: string } | undefined): void;
	};
	/** OHLC legend (data mode): symbol + bar history for hover readouts. */
	legend: {
		setSymbol(symbol: string | undefined): void;
		setBars(bars: OhlcvBar[]): void;
	};
	/** Loading pill shown while a bar fetch is in flight (H17). */
	loading: HTMLElement;
	/** Get-started placeholder shown when no data source is selected (H17). */
	emptyState: HTMLElement;
	toolbar: {
		dataSourceButton: HTMLButtonElement;
		dataSourceDropdown: HTMLElement;
		timeframeLabel: HTMLElement;
		dateStart: HTMLInputElement;
		dateEnd: HTMLInputElement;
		complexity: HTMLElement;
	};
	panelRoot: HTMLElement;
	errorOverlay: HTMLElement;
	errorMessage: HTMLElement;
	errorActions: HTMLElement;
}

export function createMessageHandler(context: MessageHandlerContext): (message: unknown) => void {
	let parameters: ParameterDefinition[] = [];
	let overrides: Record<string, unknown> = {};
	let lastDataRequestId = 0;
	let lastVizRequestId = 0;

	const setBanner = (message: string, tone?: 'info' | 'warning') => {
		context.banner.textContent = message;
		context.banner.classList.toggle('show', Boolean(message));
		context.banner.dataset.tone = tone ?? 'info';
	};

	const setLoading = (visible: boolean) => {
		context.loading.classList.toggle('show', visible);
	};

	const setEmptyState = (visible: boolean) => {
		context.emptyState.classList.toggle('show', visible);
	};

	const setComplexity = (complexity: ComplexityInfo) => {
		context.toolbar.complexity.textContent = `Complexity: ${complexity.level}`;
		context.toolbar.complexity.classList.remove('safe', 'partial', 'viewOnly');
		context.toolbar.complexity.classList.add(complexity.level);
	};

	// M32: the toolbar's verdict on whether the 'Add visualize()' bar SHOULD
	// show. Actual visibility additionally requires the error overlay to be
	// hidden -- the two stacked on strategy tabs whose visualize() errored.
	let noVizDesired = false;
	const syncNoViz = () => {
		const errorVisible = context.errorOverlay.classList.contains('show');
		context.noViz.classList.toggle('show', noVizDesired && !errorVisible);
	};

	const clearError = () => {
		context.errorOverlay.classList.remove('show');
		context.errorMessage.textContent = '';
		context.errorMessage.title = '';
		context.errorActions.innerHTML = '';
		syncNoViz();
	};

	const renderError = (message: string, actions: ChartErrorAction[] = [], detail?: string) => {
		if (!message) {
			clearError();
			return;
		}

		// A real error supersedes the loading pill and the get-started state.
		setLoading(false);
		setEmptyState(false);

		context.errorMessage.textContent = message;
		context.errorMessage.title = detail ?? '';
		context.errorActions.innerHTML = '';

		const actionList = actions.length ? actions : ['reload' as ChartErrorAction];
		for (const action of actionList) {
			const button = document.createElement('button');
			button.className = action === 'reload' ? 'primary' : '';
			button.textContent = action === 'selectData'
				? 'Select Data'
				: action === 'editVisualization'
					? 'Edit Visualization Code'
					: 'Reload Chart';

			button.addEventListener('click', () => {
				if (action === 'selectData') {
					context.postMessage({ type: 'requestFilePicker' });
					return;
				}
				if (action === 'editVisualization') {
					context.postMessage({ type: 'editVisualization' });
					return;
				}
				context.postMessage({ type: 'refresh' });
			});

			context.errorActions.appendChild(button);
		}

		context.errorOverlay.classList.add('show');
		syncNoViz();
	};

	const populateDropdown = (sources: DataSourceDescriptor[]) => {
		// Remove all children except the browse button (last child)
		const browseButton = context.toolbar.dataSourceDropdown.querySelector('.data-source-option.browse');
		context.toolbar.dataSourceDropdown.innerHTML = '';

		// Separate server and local sources for grouping
		const serverSources = sources.filter(isServerSource);
		const localSources = sources.filter(isLocalFileSource);

		// Add server sources first (if any)
		if (serverSources.length > 0) {
			const serverHeader = document.createElement('div');
			serverHeader.className = 'data-source-header';
			serverHeader.textContent = 'Server Symbols';
			context.toolbar.dataSourceDropdown.appendChild(serverHeader);

			for (const source of serverSources) {
				const option = document.createElement('div');
				option.className = 'data-source-option server';

				const nameEl = document.createElement('div');
				nameEl.textContent = source.displayName;
				option.appendChild(nameEl);

				const symbolEl = document.createElement('div');
				symbolEl.className = 'symbol-label';
				symbolEl.textContent = source.symbol;
				option.appendChild(symbolEl);

				option.addEventListener('click', () => {
					context.toolbar.dataSourceDropdown.classList.remove('show');
					context.postMessage({ type: 'selectServerSymbol', symbol: source.symbol, displayName: source.displayName, assetClass: source.assetClass });
				});

				context.toolbar.dataSourceDropdown.appendChild(option);
			}
		}

		// Add local file sources
		if (localSources.length > 0) {
			const localHeader = document.createElement('div');
			localHeader.className = 'data-source-header';
			localHeader.textContent = 'Local Files';
			context.toolbar.dataSourceDropdown.appendChild(localHeader);

			for (const source of localSources) {
				const option = document.createElement('div');
				option.className = 'data-source-option local';

				const nameEl = document.createElement('div');
				nameEl.textContent = source.displayName;
				option.appendChild(nameEl);

				const pathEl = document.createElement('div');
				pathEl.className = 'file-path';
				pathEl.textContent = source.filePath;
				option.appendChild(pathEl);

				option.addEventListener('click', () => {
					context.toolbar.dataSourceDropdown.classList.remove('show');
					context.postMessage({ type: 'selectDataSource', filePath: source.filePath });
				});

				context.toolbar.dataSourceDropdown.appendChild(option);
			}
		}

		if (browseButton) {
			context.toolbar.dataSourceDropdown.appendChild(browseButton);
		} else {
			const browse = document.createElement('div');
			browse.className = 'data-source-option browse';
			browse.textContent = 'Browse Local Files...';
			browse.addEventListener('click', () => {
				context.toolbar.dataSourceDropdown.classList.remove('show');
				context.postMessage({ type: 'requestFilePicker' });
			});
			context.toolbar.dataSourceDropdown.appendChild(browse);
		}
	};

	const updateToolbar = (toolbar: ChartToolbarState) => {
		const mode = toolbar.mode ?? 'strategy';
		context.applyMode(mode);
		if (mode === 'data') {
			const source = toolbar.dataSource;
			if (source && isServerSource(source)) {
				context.marketHeader.setSource(source.symbol, source.displayName, source.assetClass);
				context.legend.setSymbol(source.symbol);
				context.chart.setWatermark(source.symbol);
			} else {
				context.marketHeader.setSource(undefined, undefined);
				context.legend.setSymbol(undefined);
				context.chart.setWatermark(null);
			}
			context.marketHeader.setTimeframe(toolbar.timeframe);
			context.marketHeader.setRange(toolbar.dateRange);
		} else {
			context.legend.setSymbol(undefined);
			context.chart.setWatermark(null);
		}
		context.toolbar.dataSourceButton.textContent = toolbar.dataSource?.displayName ?? 'No Data';
		// Set tooltip based on source type
		let sourceTooltip = 'Select a data source';
		if (toolbar.dataSource) {
			if (isServerSource(toolbar.dataSource)) {
				sourceTooltip = `Server: ${toolbar.dataSource.symbol}`;
			} else if (isLocalFileSource(toolbar.dataSource)) {
				sourceTooltip = toolbar.dataSource.filePath;
			}
		}
		context.toolbar.dataSourceButton.title = sourceTooltip;
		context.toolbar.timeframeLabel.textContent = toolbar.timeframe ?? '';
		context.toolbar.dateStart.value = toolbar.dateRange?.start ?? '';
		context.toolbar.dateEnd.value = toolbar.dateRange?.end ?? '';
		setComplexity(toolbar.complexity);
		// The visualize() prompt is developer-facing -- never show it on a
		// market-data tab (the virtual symbol template has no visualize()).
		// M32: it also yields to the error overlay while one is visible.
		noVizDesired = !toolbar.hasVisualization && !toolbar.viewOnly && mode !== 'data';
		syncNoViz();

		if (toolbar.recentSources) {
			populateDropdown(toolbar.recentSources);
		}
	};

	return async (message: unknown) => {
		const data = message as ChartMessage;
		if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') {
			return;
		}

		switch (data.type) {
			case 'init':
				parameters = data.payload.parameters;
				overrides = data.payload.overrides;
				updateToolbar(data.payload.toolbar);
				context.parameterPanel.render(parameters, overrides);
				context.chart.setTimeframe(data.payload.toolbar.timeframe ?? '1D');
				await context.chart.initialize(data.payload.theme);
				return;
			case 'setToolbar':
				updateToolbar(data.toolbar);
				context.chart.setTimeframe(data.toolbar.timeframe ?? '1D');
				return;
			case 'setRecentSources':
				populateDropdown(data.sources);
				return;
			case 'setData':
				if (typeof data.requestId !== 'number' || data.requestId < lastDataRequestId) {
					return;
				}
				if (!Array.isArray(data.data)) {
					return;
				}
				lastDataRequestId = data.requestId;
				clearError();
				setLoading(false);
				setEmptyState(false);
				context.marketHeader.updateFromBars(data.data);
				context.legend.setBars(data.data);
				await context.chart.setData(data.data);
				return;
			case 'setDataBinary': {
				if (typeof data.requestId !== 'number' || data.requestId < lastDataRequestId) {
					return;
				}
				if (!(data.buffer instanceof ArrayBuffer) || typeof data.count !== 'number' || data.count < 0) {
					return;
				}
				lastDataRequestId = data.requestId;
				clearError();
				setLoading(false);
				setEmptyState(false);
				const decoded = decodeOhlcvBuffer(data.buffer, data.count);
				context.marketHeader.updateFromBars(decoded);
				context.legend.setBars(decoded);
				await context.chart.setData(decoded);
				return;
			}
			case 'showLoading':
				// H17: visible fetch feedback. A stale id (older than data we
				// already rendered) must not re-arm the pill.
				if (typeof data.requestId !== 'number' || data.requestId < lastDataRequestId) {
					return;
				}
				setLoading(true);
				setEmptyState(false);
				clearError();
				return;
			case 'showEmptyState':
				// H17: get-started state -- no data source selected.
				setLoading(false);
				clearError();
				setEmptyState(true);
				return;
			case 'addSignal':
				// H15: live trade fill markers appended without replacing the set.
				if (!data.signal || typeof data.signal.t !== 'number') {
					return;
				}
				await context.chart.addSignal(data.signal);
				return;
			case 'setSignals':
				await context.chart.setSignals(data.signals);
				return;
			case 'setEquityCurve':
				await context.chart.setEquityCurve(data.equity);
				return;
			case 'setVisualization':
				if (data.requestId < lastVizRequestId) {
					return;
				}
				lastVizRequestId = data.requestId;
				await context.chart.applyVisualization(data.commands);
				return;
			case 'setTradeOrders':
				await context.chart.setTradeOrders(data.orders);
				return;
			case 'setTradePositions':
				await context.chart.setTradePositions(data.positions);
				return;
			case 'setTradeFills':
				await context.chart.setTradeFills(data.fills);
				return;
			case 'clearTradeOverlays':
				context.chart.clearTradeOverlays();
				return;
			case 'setParameters':
				parameters = data.parameters;
				context.parameterPanel.render(parameters, overrides);
				return;
			case 'setOverrides':
				overrides = data.overrides;
				context.parameterPanel.setOverrides(overrides);
				return;
			case 'setComplexity':
				setComplexity(data.complexity);
				return;
			case 'setTheme':
				context.chart.setTheme(data.theme);
				return;
			case 'toggleParameters':
				context.panelRoot.classList.toggle('params-collapsed', data.collapsed);
				return;
			case 'showBanner':
				setBanner(data.message, data.tone);
				return;
			case 'showError':
				renderError(data.message, data.actions, data.detail);
				return;
			default:
				return;
		}
	};
}

function decodeOhlcvBuffer(buffer: ArrayBuffer, count: number): OhlcvBar[] {
	const view = new Float64Array(buffer);
	const bars: OhlcvBar[] = [];
	const stride = 6;

	for (let i = 0; i < count; i++) {
		const offset = i * stride;
		bars.push({
			t: view[offset],
			o: view[offset + 1],
			h: view[offset + 2],
			l: view[offset + 3],
			c: view[offset + 4],
			v: view[offset + 5]
		});
	}

	return bars;
}

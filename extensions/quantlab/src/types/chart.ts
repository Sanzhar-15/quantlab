/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ComplexityLevel, ParameterDefinition } from './strategy';
import { DataSourceDescriptor, Timeframe } from './market';
import { VisualizationCommand } from './visualization';

export type ChartTheme = 'light' | 'dark';

export interface ChartDateRange {
	start: string;
	end: string;
}

export interface ComplexityInfo {
	level: ComplexityLevel;
	score: number;
	reasons: string[];
}

export interface ChartToolbarState {
	dataSource?: DataSourceDescriptor;
	timeframe?: Timeframe;
	dateRange?: ChartDateRange;
	recentSources?: DataSourceDescriptor[];
	complexity: ComplexityInfo;
	hasVisualization: boolean;
	viewOnly: boolean;
	/**
	 * 'data' = market-data viewing (quantlab-server:// symbol tabs): the webview
	 * shows the market header + range presets and hides the strategy chrome
	 * (parameters panel, complexity badge, visualize() prompts).
	 * 'strategy' = the classic strategy-charting surface for real files.
	 */
	mode: 'data' | 'strategy';
}

export type ChartErrorAction = 'selectData' | 'editVisualization' | 'reload';

export interface OhlcvBar {
	t: number;
	o: number;
	h: number;
	l: number;
	c: number;
	v?: number;
}

export interface SignalMarker {
	t: number;
	type: 'entry' | 'exit';
	label?: string;
	price?: number;
}

export interface EquityPoint {
	t: number;
	v: number;
}

export interface ChartInitPayload {
	theme: ChartTheme;
	toolbar: ChartToolbarState;
	parameters: ParameterDefinition[];
	overrides: Record<string, unknown>;
}

export type ChartOutboundMessage =
	| { type: 'init'; payload: ChartInitPayload }
	| { type: 'setToolbar'; toolbar: ChartToolbarState }
	| { type: 'setRecentSources'; sources: DataSourceDescriptor[] }
	| { type: 'setData'; requestId: number; data: OhlcvBar[] }
	| { type: 'setDataBinary'; requestId: number; buffer: ArrayBuffer; count: number }
	| { type: 'setSignals'; requestId: number; signals: SignalMarker[] }
	| { type: 'addSignal'; signal: SignalMarker }
	| { type: 'showLoading'; requestId: number }
	| { type: 'showEmptyState' }
	| { type: 'setEquityCurve'; requestId: number; equity: EquityPoint[] }
	| { type: 'setVisualization'; requestId: number; commands: VisualizationCommand[] }
	| { type: 'setTradeOrders'; sessionId: string; orders: Array<{ id: string; symbol: string; side: 'buy' | 'sell'; type: string; quantity: number; price?: number; status: string; createdAt: number; updatedAt: number }> }
	| { type: 'setTradePositions'; sessionId: string; positions: Array<{ symbol: string; quantity: number; avgPrice: number; currentPrice: number; unrealizedPnL: number; updatedAt?: number }> }
	| { type: 'setTradeFills'; sessionId: string; fills: Array<{ id: string; orderId: string; symbol: string; side: 'buy' | 'sell'; quantity: number; price: number; timestamp: number }> }
	| { type: 'clearTradeOverlays'; sessionId: string }
	| { type: 'setParameters'; parameters: ParameterDefinition[] }
	| { type: 'setOverrides'; overrides: Record<string, unknown> }
	| { type: 'setComplexity'; complexity: ComplexityInfo }
	| { type: 'setTheme'; theme: ChartTheme }
	| { type: 'toggleParameters'; collapsed: boolean }
	| { type: 'showBanner'; message: string; tone?: 'info' | 'warning' }
	| { type: 'showError'; message: string; detail?: string; actions?: ChartErrorAction[] };

export type ChartInboundMessage =
	| { type: 'ready' }
	| { type: 'parameterChange'; id: string; value: unknown }
	| { type: 'resetDefaults' }
	| { type: 'applyToCode' }
	| { type: 'requestFilePicker' }
	| { type: 'selectDataSource'; filePath: string }
	| { type: 'selectServerSymbol'; symbol: string; displayName: string; assetClass?: string }
	| { type: 'overrideDateRange'; range?: ChartDateRange }
	| { type: 'refresh' }
	| { type: 'screenshot' }
	| { type: 'openSettings' }
	| { type: 'toggleParameters'; collapsed: boolean }
	| { type: 'addVisualization' }
	| { type: 'generateVisualization' }
	| { type: 'editVisualization' }
	| { type: 'dropFile'; filePath: string }
	| { type: 'dropRun'; runId: string }
	| { type: 'toggleFullscreen' }
	| { type: 'selectTool'; tool: string | null };

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DataSourceDescriptor, Timeframe } from './market';

export type ViewType = 'editor' | 'chart' | 'action' | 'trade' | 'visualise' | 'stats';

// Data file views (separate from strategy views)
export type DataViewType = 'editor' | 'visualise' | 'stats' | 'action';

export interface TabViewState {
	tabInstanceId: string;
	filePath: string;
	currentView: ViewType;
	chartState?: ChartState;
	actionState?: TabActionState;
	tradeState?: TradeState;
}

export interface ChartState {
	symbol?: string;
	timeframe?: Timeframe;
	dataSource?: DataSourceDescriptor;
	dateRange?: { start: string; end: string };
	parameterOverrides: Record<string, unknown>;
	panelCollapsed?: boolean;
	scrollPosition?: number;
}

export interface TabActionState {
	selectedAction: string | null;
	configuration: Record<string, unknown>;
	lastRunId: string | null;
}

export interface TradeState {
	sessionId: string | null;
	scrollPosition?: number;
}

export const VIEW_COLORS: Record<ViewType, string | null> = {
	editor: null,
	chart: '#059669',
	action: '#D97706',
	trade: '#DC2626',
	visualise: '#7C3AED',
	stats: '#0891B2'
};

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { DataSourceDescriptor, GlobalMarketState, Timeframe, isLocalFileSource, isServerSource } from '../../types/market';

const STORAGE_KEY = 'quantlab.globalMarketState';
const RECENT_DATA_SOURCES_KEY = 'quantlab.recentDataSources';
const MAX_RECENT_SOURCES = 10;
const DEFAULT_STATE: GlobalMarketState = {
	dataSource: undefined,
	timeframe: undefined
};

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M'];

interface GlobalMarketStateStored {
	dataSource?: DataSourceDescriptor;
	timeframe?: Timeframe;
	dateRange?: { start: string; end: string };
}

function dataSourcesEqual(a: DataSourceDescriptor | undefined, b: DataSourceDescriptor | undefined): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	if (a.kind !== b.kind) {
		return false;
	}
	if (isLocalFileSource(a) && isLocalFileSource(b)) {
		return a.filePath === b.filePath;
	}
	if (isServerSource(a) && isServerSource(b)) {
		return a.symbol === b.symbol;
	}
	return false;
}

export class GlobalState {
	private static instance: GlobalState | undefined;

	private disposed = false;
	private state: GlobalMarketState;
	private pendingPersist: NodeJS.Timeout | undefined;

	private readonly _onDidChangeDataSource = new vscode.EventEmitter<DataSourceDescriptor | undefined>();
	readonly onDidChangeDataSource = this._onDidChangeDataSource.event;

	private readonly _onDidChangeTimeframe = new vscode.EventEmitter<Timeframe | undefined>();
	readonly onDidChangeTimeframe = this._onDidChangeTimeframe.event;

	private readonly _onDidChange = new vscode.EventEmitter<GlobalMarketState>();
	readonly onDidChange = this._onDidChange.event;

	private constructor(private readonly context: vscode.ExtensionContext) {
		this.state = this.restore();
	}

	static initialize(context: vscode.ExtensionContext): GlobalState {
		if (!GlobalState.instance) {
			GlobalState.instance = new GlobalState(context);
		}
		return GlobalState.instance;
	}

	static getInstance(): GlobalState {
		if (!GlobalState.instance) {
			throw new Error('GlobalState not initialized');
		}
		return GlobalState.instance;
	}

	getDataSource(): DataSourceDescriptor | undefined {
		return this.state.dataSource;
	}

	setDataSource(dataSource: DataSourceDescriptor | undefined): void {
		if (this.disposed || dataSourcesEqual(this.state.dataSource, dataSource)) {
			return;
		}

		this.state = { ...this.state, dataSource };
		this._onDidChangeDataSource.fire(dataSource);
		this._onDidChange.fire({ ...this.state });
		this.schedulePersist();

		if (dataSource) {
			this.addRecentDataSource(dataSource);
		}
	}

	getTimeframe(): Timeframe | undefined {
		return this.state.timeframe;
	}

	setTimeframe(timeframe: Timeframe | undefined): void {
		if (this.disposed) { return; }
		if (timeframe !== undefined) {
			const normalized = this.normalizeTimeframe(timeframe);
			if (normalized === this.state.timeframe) {
				return;
			}
			this.state = { ...this.state, timeframe: normalized };
			this._onDidChangeTimeframe.fire(normalized);
		} else {
			if (this.state.timeframe === undefined) {
				return;
			}
			this.state = { ...this.state, timeframe: undefined };
			this._onDidChangeTimeframe.fire(undefined);
		}
		this._onDidChange.fire({ ...this.state });
		this.schedulePersist();
	}

	getDateRange(): { start: Date; end: Date } | undefined {
		return this.state.dateRange;
	}

	setDateRange(range: { start: Date; end: Date } | undefined): void {
		if (this.disposed) { return; }
		const nextRange = range ? { start: range.start, end: range.end } : undefined;
		const current = this.state.dateRange;
		const isSame = Boolean(current && nextRange &&
			current.start.getTime() === nextRange.start.getTime() &&
			current.end.getTime() === nextRange.end.getTime());

		if (!range && !current) {
			return;
		}

		if (isSame) {
			return;
		}

		this.state = { ...this.state, dateRange: nextRange };
		this._onDidChange.fire({ ...this.state });
		this.schedulePersist();
	}

	getRecentDataSources(): DataSourceDescriptor[] {
		return this.context.workspaceState.get<DataSourceDescriptor[]>(RECENT_DATA_SOURCES_KEY, []);
	}

	addRecentDataSource(source: DataSourceDescriptor): void {
		if (this.disposed) { return; }
		const current = this.getRecentDataSources();
		const next = [source, ...current.filter(s => !dataSourcesEqual(s, source))].slice(0, MAX_RECENT_SOURCES);
		void this.context.workspaceState.update(RECENT_DATA_SOURCES_KEY, next);
	}

	private normalizeTimeframe(timeframe: Timeframe): Timeframe {
		return TIMEFRAMES.includes(timeframe) ? timeframe : '1D';
	}

	private schedulePersist(): void {
		if (this.pendingPersist) {
			clearTimeout(this.pendingPersist);
		}

		this.pendingPersist = setTimeout(() => {
			this.pendingPersist = undefined;
			void this.persist();
		}, 200);
	}

	private async persist(): Promise<void> {
		const stored: GlobalMarketStateStored = {
			dataSource: this.state.dataSource,
			timeframe: this.state.timeframe,
			dateRange: this.state.dateRange
				? { start: this.state.dateRange.start.toISOString(), end: this.state.dateRange.end.toISOString() }
				: undefined
		};

		await this.context.workspaceState.update(STORAGE_KEY, stored);
	}

	dispose(): void {
		this.disposed = true;
		if (this.pendingPersist) {
			clearTimeout(this.pendingPersist);
			this.pendingPersist = undefined;
			// Flush any unsaved state synchronously before disposing
			void this.persist();
		}
		this._onDidChangeDataSource.dispose();
		this._onDidChangeTimeframe.dispose();
		this._onDidChange.dispose();
	}

	static resetInstance(): void {
		if (GlobalState.instance) {
			GlobalState.instance.dispose();
			GlobalState.instance = undefined;
		}
	}

	private restore(): GlobalMarketState {
		const stored = this.context.workspaceState.get<GlobalMarketStateStored>(STORAGE_KEY);
		if (!stored) {
			return { ...DEFAULT_STATE };
		}

		const dataSource = stored.dataSource;
		const timeframe = stored.timeframe ? this.normalizeTimeframe(stored.timeframe) : undefined;
		let dateRange: GlobalMarketState['dateRange'];

		if (stored.dateRange?.start && stored.dateRange?.end) {
			const start = new Date(stored.dateRange.start);
			const end = new Date(stored.dateRange.end);
			if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
				dateRange = { start, end };
			}
		}

		return { dataSource, timeframe, dateRange };
	}
}

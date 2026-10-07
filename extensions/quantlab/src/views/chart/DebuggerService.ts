/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Debugger Service for Time-Travel Debugging.
 *
 * Manages the integration between:
 * - Debug files from backtest runs
 * - Chart view (bar position)
 * - Code editor (line highlighting)
 * - State inspection panel
 *
 * Spec Reference: Product Spec Section 4.2, Technical Spec Section 19
 */

import * as vscode from 'vscode';
import { CodeSyncManager, ConditionCapture } from './CodeSync';

/** Debug state at a specific bar */
export interface DebugState {
	barIndex: number;
	timestamp: string;
	cash: string;
	equity: string;
	positions: Record<string, string>;
	pendingOrders: number;
	unrealizedPnl: string;
	realizedPnl: string;
	grossExposure: string;
}

/** Debug file metadata */
export interface DebugMetadata {
	schemaVersion: string;
	strategyPath: string;
	strategyHash: string;
	dataRevId: string;
	barCount: number;
	symbol: string;
	symbols: string[];
	timeframe: string;
	startDate: string;
	endDate: string;
	createdAt: string;
	engineVersion: string;
	initialCash: string;
	fillAssumption: string;
}

/** Signal at a bar */
export interface DebugSignal {
	barIndex: number;
	signalId: string;
	symbol: string;
	side: string;
	quantity: string;
	orderType: string;
	limitPrice?: string;
	stopPrice?: string;
}

/** Fill at a bar */
export interface DebugFill {
	barIndex: number;
	fillId: string;
	orderId: string;
	symbol: string;
	side: string;
	quantity: string;
	price: string;
	commission: string;
}

/** Complete debug data for a bar */
export interface DebugBarData {
	state: DebugState;
	conditions: ConditionCapture[];
	signals: DebugSignal[];
	fills: DebugFill[];
}

/**
 * What the `quantlab.engine.readDebugFile` command returns: the debug file, already parsed (the command reads the
 * file and runs JSON.parse itself; it returns null after showing its own error when it could not).
 */
export interface DebugFileContents {
	metadata: DebugMetadata;
	states: DebugState[];
	conditions: ConditionCapture[];
	signals: DebugSignal[];
	fills: DebugFill[];
	tradeBarIndices: number[];
}

/** Debugger state change event */
export interface DebuggerStateEvent {
	type: 'enabled' | 'disabled' | 'barChanged' | 'dataLoaded';
	barIndex?: number;
	totalBars?: number;
}

/**
 * Debugger Service.
 *
 * Singleton service that manages time-travel debugging.
 */
export class DebuggerService implements vscode.Disposable {
	private static instance: DebuggerService | undefined;

	private disposables: vscode.Disposable[] = [];
	private codeSyncManager: CodeSyncManager;

	// State
	private enabled: boolean = false;
	private metadata: DebugMetadata | null = null;
	private currentBarIndex: number = 0;
	private totalBars: number = 0;
	private tradeBarIndices: number[] = [];

	// Cached data
	private statesCache: Map<number, DebugState> = new Map();
	private conditionsCache: Map<number, ConditionCapture[]> = new Map();
	private signalsCache: Map<number, DebugSignal[]> = new Map();
	private fillsCache: Map<number, DebugFill[]> = new Map();

	// Events
	private readonly _onStateChange = new vscode.EventEmitter<DebuggerStateEvent>();
	readonly onStateChange = this._onStateChange.event;

	private constructor() {
		this.codeSyncManager = new CodeSyncManager();
		this.disposables.push(this.codeSyncManager);
	}

	static getInstance(): DebuggerService {
		if (!DebuggerService.instance) {
			DebuggerService.instance = new DebuggerService();
		}
		return DebuggerService.instance;
	}

	/**
	 * Check if debugger is enabled.
	 */
	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Get current bar index.
	 */
	getCurrentBarIndex(): number {
		return this.currentBarIndex;
	}

	/**
	 * Get total number of bars.
	 */
	getTotalBars(): number {
		return this.totalBars;
	}

	/**
	 * Get bar indices where trades occurred.
	 */
	getTradeBarIndices(): number[] {
		return [...this.tradeBarIndices];
	}

	/**
	 * Get debug file metadata.
	 */
	getMetadata(): DebugMetadata | null {
		return this.metadata;
	}

	/**
	 * Load a debug file. Any failure (engine, empty result, a result that is not the parsed debug file) rejects with a named error.
	 */
	async loadDebugFile(filePath: string): Promise<void> {
		// Call Python engine to read debug file
		const data = await this.readDebugFile(filePath);

		this.metadata = data.metadata;
		this.totalBars = data.metadata.barCount;
		this.tradeBarIndices = data.tradeBarIndices;

		// Cache all data
		this.statesCache.clear();
		this.conditionsCache.clear();
		this.signalsCache.clear();
		this.fillsCache.clear();

		for (const state of data.states) {
			this.statesCache.set(state.barIndex, state);
		}

		for (const condition of data.conditions) {
			const existing = this.conditionsCache.get(condition.barIndex) || [];
			existing.push(condition);
			this.conditionsCache.set(condition.barIndex, existing);
		}

		for (const signal of data.signals) {
			const existing = this.signalsCache.get(signal.barIndex) || [];
			existing.push(signal);
			this.signalsCache.set(signal.barIndex, existing);
		}

		for (const fill of data.fills) {
			const existing = this.fillsCache.get(fill.barIndex) || [];
			existing.push(fill);
			this.fillsCache.set(fill.barIndex, existing);
		}

		// Set up code sync
		if (this.metadata.strategyPath) {
			this.codeSyncManager.setStrategyFile(this.metadata.strategyPath);
			this.codeSyncManager.loadConditions(data.conditions);
		}

		this.enabled = true;
		this.currentBarIndex = 0;

		this._onStateChange.fire({
			type: 'enabled',
			barIndex: 0,
			totalBars: this.totalBars,
		});

		this._onStateChange.fire({
			type: 'dataLoaded',
			barIndex: 0,
			totalBars: this.totalBars,
		});
	}

	/**
	 * Disable debugger and clear state.
	 */
	disable(): void {
		this.enabled = false;
		this.metadata = null;
		this.currentBarIndex = 0;
		this.totalBars = 0;
		this.tradeBarIndices = [];

		this.statesCache.clear();
		this.conditionsCache.clear();
		this.signalsCache.clear();
		this.fillsCache.clear();

		this.codeSyncManager.clearDecorations();

		this._onStateChange.fire({ type: 'disabled' });
	}

	/**
	 * Jump to a specific bar.
	 */
	jumpToBar(barIndex: number): DebugBarData | null {
		if (!this.enabled || barIndex < 0 || barIndex >= this.totalBars) {
			return null;
		}

		this.currentBarIndex = barIndex;
		this.codeSyncManager.setBarIndex(barIndex);

		this._onStateChange.fire({
			type: 'barChanged',
			barIndex,
			totalBars: this.totalBars,
		});

		return this.getBarData(barIndex);
	}

	/**
	 * Step forward one bar.
	 */
	stepForward(): DebugBarData | null {
		if (this.currentBarIndex < this.totalBars - 1) {
			return this.jumpToBar(this.currentBarIndex + 1);
		}
		return null;
	}

	/**
	 * Step backward one bar.
	 */
	stepBackward(): DebugBarData | null {
		if (this.currentBarIndex > 0) {
			return this.jumpToBar(this.currentBarIndex - 1);
		}
		return null;
	}

	/**
	 * Jump to the next bar with a trade.
	 */
	jumpToNextTrade(): DebugBarData | null {
		const next = this.tradeBarIndices.find((i) => i > this.currentBarIndex);
		if (next !== undefined) {
			return this.jumpToBar(next);
		}
		return null;
	}

	/**
	 * Jump to the previous bar with a trade.
	 */
	jumpToPrevTrade(): DebugBarData | null {
		const prev = [...this.tradeBarIndices]
			.reverse()
			.find((i) => i < this.currentBarIndex);
		if (prev !== undefined) {
			return this.jumpToBar(prev);
		}
		return null;
	}

	/**
	 * Highlight a line in the code editor.
	 */
	async highlightLine(lineNumber: number): Promise<void> {
		await this.codeSyncManager.highlightLine(lineNumber);
	}

	/**
	 * Get data for a specific bar.
	 */
	getBarData(barIndex: number): DebugBarData | null {
		const state = this.statesCache.get(barIndex);
		if (!state) {
			return null;
		}

		return {
			state,
			conditions: this.conditionsCache.get(barIndex) || [],
			signals: this.signalsCache.get(barIndex) || [],
			fills: this.fillsCache.get(barIndex) || [],
		};
	}

	/**
	 * Get current bar data.
	 */
	getCurrentBarData(): DebugBarData | null {
		return this.getBarData(this.currentBarIndex);
	}

	/**
	 * Read debug file using the engine command. The command returns the parsed object (DebugFileContents); one
	 * route, no second reader, and every shortfall is a named error.
	 */
	private async readDebugFile(filePath: string): Promise<DebugFileContents> {
		let result: DebugFileContents | null | undefined;
		try {
			result = await vscode.commands.executeCommand<DebugFileContents | null>(
				'quantlab.engine.readDebugFile',
				filePath
			);
		} catch (error) {
			throw new Error(`quantlab debugger: the engine could not read the debug file ${filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}

		if (result === undefined || result === null) {
			throw new Error(`quantlab debugger: the engine returned no debug data for ${filePath}`);
		}

		return DebuggerService.validateDebugFile(result, filePath);
	}

	/** The command's result as DebugFileContents, or a named error for the first required field that is missing or invalid. */
	private static validateDebugFile(result: unknown, filePath: string): DebugFileContents {
		const invalid = (problem: string) => new Error(`quantlab debugger: the debug data for ${filePath} is invalid (${problem})`);
		if (typeof result !== 'object' || result === null || Array.isArray(result)) {
			throw invalid(`expected the parsed debug file object, got ${Array.isArray(result) ? 'an array' : typeof result}`);
		}
		const file = result as Record<string, unknown>;
		const metadata = file.metadata;
		if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
			throw invalid('metadata is missing');
		}
		const { barCount, strategyPath } = metadata as Record<string, unknown>;
		if (typeof barCount !== 'number' || !Number.isInteger(barCount) || barCount < 0) {
			throw invalid(`metadata.barCount is ${String(barCount)}, not a whole number of bars`);
		}
		if (strategyPath !== undefined && typeof strategyPath !== 'string') {
			throw invalid(`metadata.strategyPath is ${String(strategyPath)}, not a path`);
		}
		for (const field of ['states', 'conditions', 'signals', 'fills'] as const) {
			const entries = file[field];
			if (!Array.isArray(entries)) {
				throw invalid(`${field} is missing`);
			}
			entries.forEach((entry: unknown, i) => {
				const barIndex = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).barIndex : undefined;
				if (typeof barIndex !== 'number' || !Number.isInteger(barIndex) || barIndex < 0) {
					throw invalid(`${field}[${i}] has no whole barIndex (${String(barIndex)})`);
				}
			});
		}
		const trades = file.tradeBarIndices;
		if (!Array.isArray(trades)) {
			throw invalid('tradeBarIndices is missing');
		}
		trades.forEach((index: unknown, i) => {
			if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
				throw invalid(`tradeBarIndices[${i}] is ${String(index)}, not a bar index`);
			}
		});
		return result as DebugFileContents;
	}

	/**
	 * Dispose resources.
	 */
	dispose(): void {
		this.disable();
		this._onStateChange.dispose();
		this.disposables.forEach((d) => d.dispose());
	}
}

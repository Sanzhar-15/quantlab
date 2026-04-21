/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IpcClient } from '../ipc/ipcTypes.js';
import { QicError } from '../canonical/types.js';

/**
 * Result types for QIC-specific daemon methods.
 */
export interface TimeSeriesAnalysis {
	isTimeSeries: boolean;
	frequency?: string;
	stationarity?: { adfStatistic: number; pValue: number; isStationary: boolean };
	outliers: Array<{ index: number; value: number; zscore: number }>;
	summary: { mean: number; std: number; min: number; max: number; count: number };
}

export interface FrequencyInfo {
	detected: string;
	confidence: number;
	sampleSize: number;
	gaps: Array<{ start: string; end: string; count: number }>;
}

export interface StatTestResult {
	testName: string;
	statistic: number;
	pValue: number;
	significant: boolean;
	details?: Record<string, unknown>;
}

export interface BacktestAnalysis {
	sharpeRatio: number;
	sortinoRatio: number;
	maxDrawdown: number;
	maxDrawdownDuration?: number;
	totalReturn: number;
	annualizedReturn: number;
	volatility: number;
	alpha?: number;
	beta?: number;
	calmarRatio: number;
	winRate: number;
	profitFactor: number;
	tradeCount: number;
}

export interface DataFramePreviewOptions {
	maxRows?: number;
	maxColumns?: number;
	format?: 'csv' | 'parquet' | 'feather';
}

export interface DataFramePreview {
	shape: [number, number];
	columns: ColumnInfo[];
	head: Record<string, unknown>[];
	tail: Record<string, unknown>[];
	dtypes: Record<string, string>;
	memoryUsageMb: number;
	nullCounts: Record<string, number>;
}

export interface ColumnInfo {
	name: string;
	dtype: string;
	nullCount: number;
	unique?: number;
	min?: number | string;
	max?: number | string;
}

/**
 * Bridge to the existing Quantlab Python engine daemon via JSON-RPC.
 *
 * AUDIT FIX III-QI2 (CRITICAL): Routes requests through the existing IPC layer
 * to the existing engine daemon at engine/quantlab/daemon/main.py.
 * Does NOT spawn a new Python sidecar process.
 *
 * AUDIT FIX III-QI3 (HIGH): Uses IPC types mirrored from
 * extensions/quantlab/src/core/ipc/types.ts.
 */
export class QicPythonBridge {

	private static readonly IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private startedOnDemand = false;

	constructor(
		private readonly ipcClient: IpcClient,
	) {}

	/**
	 * Ensure the engine daemon is running.
	 * If not running (no trading session active), starts it on demand
	 * and manages idle timeout.
	 */
	async ensureRunning(): Promise<void> {
		if (this.ipcClient.isConnected()) {
			this.resetIdleTimer();
			return;
		}

		// Try a health check first
		try {
			await this.call<{ status: string }>('health.check', {});
			this.resetIdleTimer();
			return;
		} catch {
			// Daemon not running — need to start on demand
			// The activation layer (Prompt 18) handles actual process spawning
			throw new QicError('QIC-Q002', 'Engine daemon not running. Start a trading session or enable daemon auto-start.');
		}
	}

	/**
	 * Send a QIC-specific JSON-RPC request to the existing engine daemon.
	 * Uses the existing IPC layer — does NOT spawn a new process.
	 * Applies a 30-second timeout to prevent indefinite hangs.
	 */
	async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
		this.resetIdleTimer();
		let timerId: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timerId = setTimeout(() => reject(new QicError('QIC-Q003', `IPC call '${method}' timed out after 30s`)), 30_000);
		});
		try {
			return await Promise.race([this.ipcClient.request<T>(method, params), timeout]);
		} finally {
			if (timerId !== undefined) { clearTimeout(timerId); }
		}
	}

	/**
	 * Analyze time series data via the existing engine daemon.
	 */
	async analyzeTimeSeries(data: number[], freq?: string): Promise<TimeSeriesAnalysis> {
		await this.ensureRunning();
		return this.call('qic.analyze_time_series', { data, freq });
	}

	/**
	 * Detect frequency of timestamps.
	 */
	async detectFrequency(timestamps: string[]): Promise<FrequencyInfo> {
		await this.ensureRunning();
		return this.call('qic.detect_frequency', { timestamps });
	}

	/**
	 * Run a statistical test via the engine daemon.
	 */
	async statisticalTest(data: number[], testName: string): Promise<StatTestResult> {
		await this.ensureRunning();
		return this.call('qic.statistical_test', { data, test_name: testName });
	}

	/**
	 * Analyze backtest results via the engine daemon.
	 */
	async analyzeBacktest(returns: number[], benchmark?: number[]): Promise<BacktestAnalysis> {
		await this.ensureRunning();
		return this.call('qic.analyze_backtest', { returns, benchmark });
	}

	/**
	 * Preview a DataFrame via the engine daemon.
	 * AUDIT FIX III-QI10: Delegates file reading to existing data loaders.
	 */
	async previewDataFrame(filePath: string, options?: DataFramePreviewOptions): Promise<DataFramePreview> {
		await this.ensureRunning();
		return this.call('qic.preview_dataframe', { path: filePath, ...options });
	}

	/**
	 * Stop the engine daemon if QIC started it on demand.
	 */
	async stop(): Promise<void> {
		this.clearIdleTimer();
		if (this.startedOnDemand) {
			try {
				await this.call('session.stop', { reason: 'qic_idle_timeout' });
			} catch {
				// Ignore errors during shutdown
			}
			this.startedOnDemand = false;
		}
	}

	private resetIdleTimer(): void {
		this.clearIdleTimer();
		if (this.startedOnDemand) {
			this.idleTimer = setTimeout(() => {
				void this.stop();
			}, QicPythonBridge.IDLE_TIMEOUT_MS);
		}
	}

	private clearIdleTimer(): void {
		if (this.idleTimer !== null) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}
}

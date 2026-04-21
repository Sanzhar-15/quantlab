/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { QicPythonBridge } from '../../../common/quant/qicPythonBridge.js';
import { DataFrameSafety } from '../../../common/quant/dataframeSafety.js';
import { QuantPatterns } from '../../../common/quant/quantPatterns.js';
import { TimeSeriesDetector } from '../../../common/quant/timeSeries.js';
import type { IpcClient } from '../../../common/ipc/ipcTypes.js';

// Mock IPC client
function createMockIpcClient(responses?: Map<string, unknown>): IpcClient {
	const handlers: Array<(method: string, params: unknown) => void> = [];
	return {
		request: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
			if (responses?.has(method)) {
				return responses.get(method) as T;
			}
			throw new Error(`No mock response for method: ${method}`);
		},
		notify: async () => {},
		onNotification: (handler) => { handlers.push(handler); },
		isConnected: () => true,
	};
}

suite('QicPythonBridge', () => {
	test('call delegates to IPC client', async () => {
		const responses = new Map<string, unknown>();
		responses.set('health.check', { status: 'ok' });
		const bridge = new QicPythonBridge(createMockIpcClient(responses));

		const result = await bridge.call<{ status: string }>('health.check', {});
		assert.strictEqual(result.status, 'ok');
	});

	test('analyzeBacktest calls qic.analyze_backtest', async () => {
		const expectedResult = {
			sharpeRatio: 1.5,
			sortinoRatio: 2.1,
			maxDrawdown: 0.15,
			totalReturn: 0.45,
			annualizedReturn: 0.22,
			volatility: 0.18,
			calmarRatio: 1.47,
			winRate: 0.55,
			profitFactor: 1.8,
			tradeCount: 100,
		};

		const responses = new Map<string, unknown>();
		responses.set('health.check', { status: 'ok' });
		responses.set('qic.analyze_backtest', expectedResult);
		const bridge = new QicPythonBridge(createMockIpcClient(responses));

		const result = await bridge.analyzeBacktest([0.01, -0.02, 0.03, 0.01, -0.005]);
		assert.strictEqual(result.sharpeRatio, 1.5);
		assert.strictEqual(result.maxDrawdown, 0.15);
	});

	test('previewDataFrame calls qic.preview_dataframe', async () => {
		const expectedPreview = {
			shape: [1000, 5] as [number, number],
			columns: [
				{ name: 'date', dtype: 'datetime64', nullCount: 0 },
				{ name: 'close', dtype: 'float64', nullCount: 0 },
			],
			head: [{ date: '2024-01-01', close: 100.5 }],
			tail: [{ date: '2024-12-31', close: 105.2 }],
			dtypes: { date: 'datetime64', close: 'float64' },
			memoryUsageMb: 0.04,
			nullCounts: { date: 0, close: 0 },
		};

		const responses = new Map<string, unknown>();
		responses.set('health.check', { status: 'ok' });
		responses.set('qic.preview_dataframe', expectedPreview);
		const bridge = new QicPythonBridge(createMockIpcClient(responses));

		const result = await bridge.previewDataFrame('/data/prices.parquet');
		assert.deepStrictEqual(result.shape, [1000, 5]);
		assert.strictEqual(result.columns.length, 2);
	});

	test('throws QicError when daemon not connected', async () => {
		const client = createMockIpcClient();
		(client as { isConnected: () => boolean }).isConnected = () => false;
		const bridge = new QicPythonBridge(client);

		await assert.rejects(
			() => bridge.analyzeTimeSeries([1, 2, 3]),
			/Engine daemon not running/,
		);
	});
});

suite('DataFrameSafety', () => {
	test('preview delegates to bridge', async () => {
		const expectedPreview = {
			shape: [500, 3] as [number, number],
			columns: [],
			head: [],
			tail: [],
			dtypes: {},
			memoryUsageMb: 0.01,
			nullCounts: {},
		};

		const responses = new Map<string, unknown>();
		responses.set('health.check', { status: 'ok' });
		responses.set('qic.preview_dataframe', expectedPreview);
		const bridge = new QicPythonBridge(createMockIpcClient(responses));
		const safety = new DataFrameSafety(bridge);

		const result = await safety.preview('/data/test.csv', { maxRows: 10 });
		assert.deepStrictEqual(result.shape, [500, 3]);
	});
});

suite('QuantPatterns', () => {
	const patterns = new QuantPatterns();

	test('detects look-ahead bias with negative shift', () => {
		const code = 'df["signal"] = df["close"].shift(-1)';
		const warnings = patterns.analyzeCode(code);
		assert.ok(warnings.some(w => w.pattern === 'look_ahead_bias'));
	});

	test('detects survivorship bias', () => {
		const code = 'grouped = df.groupby("ticker")';
		const warnings = patterns.analyzeCode(code);
		assert.ok(warnings.some(w => w.pattern === 'survivorship_bias'));
	});

	test('detects incorrect Sharpe ratio', () => {
		const code = 'sharpe = returns.mean() / returns.std()';
		const warnings = patterns.analyzeCode(code);
		assert.ok(warnings.some(w => w.pattern === 'incorrect_sharpe'));
	});

	test('detects .iloc with string index', () => {
		const code = 'df.iloc["AAPL"]';
		const warnings = patterns.analyzeCode(code);
		assert.ok(warnings.some(w => w.pattern === 'loc_iloc_confusion'));
	});

	test('detects iterrows performance issue', () => {
		const code = 'for idx, row in df.iterrows():';
		const warnings = patterns.analyzeCode(code);
		assert.ok(warnings.some(w => w.pattern === 'iterrows_performance'));
	});

	test('no warnings for clean code', () => {
		const code = 'returns = prices.pct_change().dropna(subset=["close"])';
		const warnings = patterns.analyzeCode(code);
		assert.strictEqual(warnings.length, 0);
	});

	test('detects quant libraries', () => {
		const code = 'import pandas as pd\nimport numpy as np\nfrom scipy import stats';
		const ctx = patterns.getCompletionContext(code);
		assert.ok(ctx.detectedLibraries.includes('pandas'));
		assert.ok(ctx.detectedLibraries.includes('numpy'));
		assert.ok(ctx.detectedLibraries.includes('scipy'));
	});

	test('identifies quant files', () => {
		assert.ok(patterns.isQuantFile('strategies/momentum.py'));
		assert.ok(patterns.isQuantFile('backtest/runner.py'));
		assert.ok(patterns.isQuantFile('algo.strategy.py'));
		assert.ok(!patterns.isQuantFile('utils/helpers.py'));
	});
});

suite('TimeSeriesDetector', () => {
	test('constructs without error', () => {
		const responses = new Map<string, unknown>();
		responses.set('health.check', { status: 'ok' });
		const bridge = new QicPythonBridge(createMockIpcClient(responses));
		const detector = new TimeSeriesDetector(bridge);
		assert.ok(detector);
	});
});

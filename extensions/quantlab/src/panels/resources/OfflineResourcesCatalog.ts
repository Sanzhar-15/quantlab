/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Offline Resources Catalog
// Hardcoded resources that work without the Delta Plus Server.
// 2 statistics + 2 strategy resources.

import { ResourceCategory } from '../../types/resources';
import { ConfigSchema, ResourceMeta } from '../../types/action';

// -- Statistics section -------------------------------------------------------

export const OFFLINE_STATISTICS: ResourceCategory[] = [
	{
		id: 'offline-cat-stationarity',
		label: 'Stationarity Tests',
		description: 'Unit root and stationarity tests for time series.',
		order: -2,
		icon: 'graph-line',
		context_hints: ['any', 'single-series'],
		tools: [
			{
				id: 'offline-stationarity',
				label: 'Stationarity Test',
				description: 'Test for unit root using ADF, KPSS, or ADF (t-stat autolag)',
				tier: 'essential',
				implemented: true,
				cross_ref: null,
			},
		],
	},
	{
		id: 'offline-cat-distribution',
		label: 'Distribution Tests',
		description: 'Normality and distribution tests.',
		order: -1,
		icon: 'pulse',
		context_hints: ['any', 'single-series'],
		tools: [
			{
				id: 'offline-normality',
				label: 'Normality Test',
				description: 'Test normality using Jarque-Bera, Shapiro-Wilk, or Anderson-Darling',
				tier: 'essential',
				implemented: true,
				cross_ref: null,
			},
		],
	},
];

// -- Strategy section ---------------------------------------------------------

export const OFFLINE_STRATEGY: ResourceCategory[] = [
	{
		id: 'offline-cat-backtest',
		label: 'Backtesting',
		description: 'Run strategies on historical data.',
		order: -2,
		icon: 'play',
		context_hints: ['any'],
		tools: [
			{
				id: 'offline-backtest',
				label: 'Simple Backtest',
				description: 'Run strategy on historical data and view metrics',
				tier: 'essential',
				implemented: true,
				cross_ref: null,
			},
		],
	},
	{
		id: 'offline-cat-simulation',
		label: 'Simulation',
		description: 'Randomized simulations for risk analysis.',
		order: -1,
		icon: 'flame',
		context_hints: ['any'],
		tools: [
			{
				id: 'offline-montecarlo',
				label: 'Monte Carlo Simulation',
				description: 'Randomized simulations to estimate strategy risk',
				tier: 'essential',
				implemented: true,
				cross_ref: null,
			},
		],
	},
];

// -- Schemas ------------------------------------------------------------------

export function getOfflineResourceSchema(resourceId: string): ConfigSchema | null {
	switch (resourceId) {
		case 'offline-stationarity':
			return {
				id: 'quantlab.offline.stationarity',
				label: 'Stationarity Test',
				sections: [
					{
						id: 'data',
						label: 'Data',
						fields: [
							{ id: 'dataSource', label: 'Data File', type: 'file', required: true, fileFilter: ['*.csv', '*.parquet', '*.xlsx'] },
							{ id: 'column', label: 'Column', type: 'select', required: false, options: [], description: 'Auto-selects first numeric column if empty' },
						],
					},
					{
						id: 'test',
						label: 'Test Method',
						fields: [
							{
								id: 'testMethod', label: 'Test', type: 'select', required: true,
								options: [
									{ label: 'ADF (Augmented Dickey-Fuller)', value: 'adf' },
									{ label: 'KPSS', value: 'kpss' },
									{ label: 'ADF (t-stat autolag)', value: 'pp' },
								],
								description: 'ADF variants H0: unit root exists. KPSS H0: series is stationary.',
							},
						],
					},
					{
						id: 'parameters',
						label: 'Parameters',
						fields: [
							{
								id: 'regression', label: 'Regression Type', type: 'select',
								options: [
									{ label: 'Constant (c)', value: 'c' },
									{ label: 'Constant + Trend (ct)', value: 'ct' },
									// allow-any-unicode-next-line
									{ label: 'Constant + Trend + Trend² (ctt)', value: 'ctt' },
									{ label: 'None (n)', value: 'n' },
								],
							},
							{ id: 'maxlag', label: 'Max Lags', type: 'number', min: 0, max: 100, description: 'Leave empty for automatic selection' },
						],
					},
				],
			};
		case 'offline-normality':
			return {
				id: 'quantlab.offline.normality',
				label: 'Normality Test',
				sections: [
					{
						id: 'data',
						label: 'Data',
						fields: [
							{ id: 'dataSource', label: 'Data File', type: 'file', required: true, fileFilter: ['*.csv', '*.parquet', '*.xlsx'] },
							{ id: 'column', label: 'Column', type: 'select', required: false, options: [], description: 'Auto-selects first numeric column if empty' },
						],
					},
					{
						id: 'test',
						label: 'Test Method',
						fields: [
							{
								id: 'testMethod', label: 'Test', type: 'select', required: true,
								options: [
									{ label: 'Jarque-Bera', value: 'jarque-bera' },
									{ label: 'Shapiro-Wilk', value: 'shapiro-wilk' },
									{ label: 'Anderson-Darling', value: 'anderson-darling' },
								],
								description: 'Tests whether data follows a normal distribution.',
							},
						],
					},
					{
						id: 'parameters',
						label: 'Parameters',
						fields: [
							{ id: 'alpha', label: 'Significance Level', type: 'number', min: 0.001, max: 0.5, step: 0.01, description: 'Default: 0.05' },
						],
					},
				],
			};
		case 'offline-backtest':
			return {
				id: 'quantlab.offline.backtest',
				label: 'Simple Backtest',
				sections: [
					{
						id: 'data',
						label: 'Data',
						fields: [
							{ id: 'dataSource', label: 'Data Source', type: 'file', required: true, fileFilter: ['*.csv', '*.parquet'] },
							{ id: 'dateStart', label: 'Start Date', type: 'date' },
							{ id: 'dateEnd', label: 'End Date', type: 'date' },
						],
					},
					{
						id: 'action',
						label: 'Configuration',
						fields: [
							{
								id: 'metric', label: 'Metric', type: 'select',
								options: [
									{ label: 'Sharpe', value: 'sharpe' },
									{ label: 'Return', value: 'return' },
								],
							},
						],
					},
				],
			};
		case 'offline-montecarlo':
			return {
				id: 'quantlab.offline.montecarlo',
				label: 'Monte Carlo Simulation',
				sections: [
					{
						id: 'data',
						label: 'Data',
						fields: [
							{ id: 'dataSource', label: 'Data Source', type: 'file', required: true, fileFilter: ['*.csv', '*.parquet'] },
							{ id: 'dateStart', label: 'Start Date', type: 'date' },
							{ id: 'dateEnd', label: 'End Date', type: 'date' },
						],
					},
					{
						id: 'action',
						label: 'Configuration',
						fields: [
							{ id: 'simulations', label: 'Simulations', type: 'number', min: 100, max: 10000, step: 100, description: 'Number of randomized simulations' },
							{ id: 'confidence', label: 'Confidence %', type: 'number', min: 50, max: 99, step: 1, description: 'Confidence interval percentage' },
						],
					},
				],
			};
		default:
			return null;
	}
}

// -- Metadata -----------------------------------------------------------------

export function getOfflineResourceMeta(resourceId: string): ResourceMeta | null {
	switch (resourceId) {
		case 'offline-stationarity':
			return {
				description: 'Test whether a time series has a unit root (is non-stationary). Stationarity is a key assumption for many statistical models and trading strategies.',
				testExplanations: {
					adf: 'The Augmented Dickey-Fuller test checks for a unit root. Rejecting the null hypothesis suggests the series is stationary.',
					kpss: 'The KPSS test has stationarity as the null hypothesis. Rejecting it suggests non-stationarity.',
					pp: 'ADF with t-statistic lag selection. A true Phillips-Perron (non-parametric serial-correlation correction) is pending.',
				},
				resultHints: ['Check p-value against significance level (typically 0.05)', 'Compare test statistic with critical values'],
			};
		case 'offline-normality':
			return {
				description: 'Test whether data follows a normal (Gaussian) distribution. Many financial models assume normality of returns.',
				testExplanations: {
					'jarque-bera': 'Tests normality based on skewness and kurtosis. Good for large samples.',
					'shapiro-wilk': 'Powerful test for normality, best for small to medium samples (n < 5000).',
					'anderson-darling': 'Tests against a specific distribution. Gives more weight to tails than other tests.',
				},
				resultHints: ['p-value < alpha suggests data is NOT normally distributed', 'Financial returns are typically non-normal (fat tails)'],
			};
		case 'offline-backtest':
			return {
				description: 'Run your strategy on historical data to evaluate performance metrics like Sharpe ratio, total return, and max drawdown.',
				resultHints: ['Sharpe > 1.0 is generally considered acceptable', 'Check max drawdown for worst-case risk'],
			};
		case 'offline-montecarlo':
			return {
				description: 'Randomize trade sequences to estimate the distribution of possible outcomes. Helps assess whether strategy performance is robust or due to luck.',
				resultHints: ['Wide confidence intervals suggest high uncertainty', 'Compare median vs mean for skewness'],
			};
		default:
			return null;
	}
}

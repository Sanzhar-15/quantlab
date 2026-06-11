/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Complete Statistical Test Catalog
// Full definitions with parameters for Stats view configuration

import { StatsCategory, StatsTestDefinition, StatsParameterDefinition } from '../types/stats';

// -----------------------------------------------------------------------------
// Parameter Templates (reusable)
// -----------------------------------------------------------------------------

const CONFIDENCE_PARAM: StatsParameterDefinition = {
	id: 'confidence',
	label: 'Confidence Level',
	type: 'select',
	default: '0.95',
	options: [
		{ value: '0.90', label: '90%' },
		{ value: '0.95', label: '95%' },
		{ value: '0.99', label: '99%' }
	]
};

const LAG_PARAM: StatsParameterDefinition = {
	id: 'lags',
	label: 'Number of Lags',
	type: 'number',
	default: 12,
	min: 1,
	max: 100,
	description: 'Number of lags to include in the test'
};

const WINDOW_PARAM: StatsParameterDefinition = {
	id: 'window',
	label: 'Window Size',
	type: 'number',
	default: 20,
	min: 5,
	max: 500,
	description: 'Rolling window size in periods'
};

// -----------------------------------------------------------------------------
// Test Definitions
// -----------------------------------------------------------------------------

export const STATS_TEST_DEFINITIONS: StatsTestDefinition[] = [
	// DESCRIPTIVE STATISTICS
	{
		id: 'summary',
		label: 'Summary Statistics',
		description: 'Comprehensive summary including mean, standard deviation, skewness, kurtosis, and percentiles',
		category: 'descriptive',
		requiredColumns: { count: '1+', types: ['float64', 'int64'] },
		parameters: [
			{
				id: 'percentiles',
				label: 'Percentiles',
				type: 'array',
				default: [0.05, 0.25, 0.5, 0.75, 0.95],
				description: 'Percentiles to calculate'
			}
		]
	},
	{
		id: 'returns',
		label: 'Returns Analysis',
		description: 'Calculate and analyze returns: log returns, simple returns, cumulative returns',
		category: 'descriptive',
		requiredColumns: { count: 1, types: ['float64', 'int64'] },
		parameters: [
			{
				id: 'returnType',
				label: 'Return Type',
				type: 'select',
				default: 'log',
				options: [
					{ value: 'log', label: 'Log Returns' },
					{ value: 'simple', label: 'Simple Returns' },
					{ value: 'both', label: 'Both' }
				]
			}
		]
	},
	{
		id: 'rolling',
		label: 'Rolling Statistics',
		description: 'Rolling mean, standard deviation, and other statistics',
		category: 'descriptive',
		requiredColumns: { count: '1+', types: ['float64', 'int64'] },
		parameters: [
			WINDOW_PARAM,
			{
				id: 'stats',
				label: 'Statistics',
				type: 'select',
				default: 'mean_std',
				options: [
					{ value: 'mean', label: 'Mean Only' },
					{ value: 'std', label: 'Std Only' },
					{ value: 'mean_std', label: 'Mean & Std' },
					{ value: 'all', label: 'All (mean, std, min, max)' }
				]
			}
		]
	},

	// STATIONARITY TESTS
	{
		id: 'adf',
		label: 'Augmented Dickey-Fuller',
		description: 'Test for unit root (non-stationarity) in time series',
		category: 'stationarity',
		requiredColumns: { count: 1, types: ['float64', 'int64'] },
		parameters: [
			{
				id: 'regression',
				label: 'Regression Type',
				type: 'select',
				default: 'c',
				options: [
					{ value: 'n', label: 'No constant' },
					{ value: 'c', label: 'Constant only' },
					{ value: 'ct', label: 'Constant + trend' },
					{ value: 'ctt', label: 'Constant + linear + quadratic trend' }
				]
			},
			{
				id: 'maxlag',
				label: 'Max Lags (auto if empty)',
				type: 'number',
				default: null,
				min: 0,
				max: 50
			}
		]
	},
	{
		id: 'kpss',
		label: 'KPSS Test',
		description: 'Test for stationarity (null = stationary, opposite of ADF)',
		category: 'stationarity',
		requiredColumns: { count: 1, types: ['float64', 'int64'] },
		parameters: [
			{
				id: 'regression',
				label: 'Regression Type',
				type: 'select',
				default: 'c',
				options: [
					{ value: 'c', label: 'Constant (level stationarity)' },
					{ value: 'ct', label: 'Constant + trend (trend stationarity)' }
				]
			},
			{
				id: 'nlags',
				label: 'Number of Lags',
				type: 'select',
				default: 'auto',
				options: [
					{ value: 'auto', label: 'Auto (Schwert)' },
					{ value: 'legacy', label: 'Legacy (sqrt(n))' }
				]
			}
		]
	},
	{
		id: 'pp',
		label: 'ADF (t-stat autolag)',
		description: 'Unit root test: ADF with t-statistic lag selection (Phillips-Perron pending)',
		category: 'stationarity',
		requiredColumns: { count: 1, types: ['float64', 'int64'] },
		parameters: [
			{
				id: 'regression',
				label: 'Regression Type',
				type: 'select',
				default: 'c',
				options: [
					{ value: 'n', label: 'No constant' },
					{ value: 'c', label: 'Constant only' },
					{ value: 'ct', label: 'Constant + trend' }
				]
			}
		]
	},

	// DISTRIBUTION TESTS
	{
		id: 'normality',
		label: 'Normality Tests',
		description: 'Multiple tests: Jarque-Bera, Shapiro-Wilk, Anderson-Darling',
		category: 'distribution',
		requiredColumns: { count: 1, types: ['float64', 'int64'] },
		parameters: [
			{
				id: 'tests',
				label: 'Tests to Run',
				type: 'select',
				default: 'all',
				options: [
					{ value: 'all', label: 'All tests' },
					{ value: 'jarque-bera', label: 'Jarque-Bera only' },
					{ value: 'shapiro', label: 'Shapiro-Wilk only' },
					{ value: 'anderson', label: 'Anderson-Darling only' }
				]
			}
		]
	},

	// DEPENDENCE TESTS
	{
		id: 'correlation',
		label: 'Correlation Matrix',
		description: 'Compute correlation matrix with multiple methods',
		category: 'dependence',
		requiredColumns: { count: '2+', types: ['float64', 'int64'] },
		parameters: [
			{
				id: 'method',
				label: 'Correlation Method',
				type: 'select',
				default: 'pearson',
				options: [
					{ value: 'pearson', label: 'Pearson' },
					{ value: 'spearman', label: 'Spearman' },
					{ value: 'kendall', label: 'Kendall' },
					{ value: 'all', label: 'All methods' }
				]
			}
		]
	},
	{
		id: 'acf-pacf',
		label: 'ACF/PACF Analysis',
		description: 'Autocorrelation and partial autocorrelation functions',
		category: 'dependence',
		requiredColumns: { count: 1, types: ['float64', 'int64'] },
		parameters: [
			{ ...LAG_PARAM, default: 40 },
			CONFIDENCE_PARAM
		]
	},
	{
		id: 'ljung-box',
		label: 'Ljung-Box Test',
		description: 'Test for serial correlation in residuals',
		category: 'dependence',
		requiredColumns: { count: 1, types: ['float64', 'int64'] },
		parameters: [
			{ ...LAG_PARAM, default: 10 }
		]
	},

	// RISK METRICS
	{
		id: 'var',
		label: 'Value at Risk',
		description: 'VaR using historical, parametric, or Monte Carlo methods',
		category: 'risk',
		requiredColumns: { count: 1, types: ['float64', 'int64'] },
		parameters: [
			CONFIDENCE_PARAM,
			{
				id: 'method',
				label: 'Method',
				type: 'select',
				default: 'historical',
				options: [
					{ value: 'historical', label: 'Historical' },
					{ value: 'parametric', label: 'Parametric (Normal)' },
					{ value: 'cornish-fisher', label: 'Cornish-Fisher' }
				]
			},
			{
				id: 'horizon',
				label: 'Horizon (days)',
				type: 'number',
				default: 1,
				min: 1,
				max: 30
			}
		]
	},
	{
		id: 'es',
		label: 'Expected Shortfall',
		description: 'CVaR / Expected Shortfall beyond VaR',
		category: 'risk',
		requiredColumns: { count: 1, types: ['float64', 'int64'] },
		parameters: [
			CONFIDENCE_PARAM,
			{
				id: 'method',
				label: 'Method',
				type: 'select',
				default: 'historical',
				options: [
					{ value: 'historical', label: 'Historical' },
					{ value: 'parametric', label: 'Parametric' }
				]
			}
		]
	},
	{
		id: 'sharpe',
		label: 'Risk-Adjusted Returns',
		description: 'Sharpe, Sortino, Calmar, and other risk-adjusted metrics',
		category: 'risk',
		requiredColumns: { count: 1, types: ['float64', 'int64'] },
		parameters: [
			{
				id: 'riskFreeRate',
				label: 'Risk-Free Rate (annualized)',
				type: 'number',
				default: 0.0,
				min: 0,
				max: 0.2
			},
			{
				id: 'periods',
				label: 'Periods per Year',
				type: 'select',
				default: '252',
				options: [
					{ value: '252', label: 'Daily (252)' },
					{ value: '52', label: 'Weekly (52)' },
					{ value: '12', label: 'Monthly (12)' }
				]
			}
		]
	}
];

// -----------------------------------------------------------------------------
// Lookup Functions
// -----------------------------------------------------------------------------

export function getTestById(testId: string): StatsTestDefinition | undefined {
	return STATS_TEST_DEFINITIONS.find(t => t.id === testId);
}

export function getTestsByCategory(category: StatsCategory): StatsTestDefinition[] {
	return STATS_TEST_DEFINITIONS.filter(t => t.category === category);
}

export function getAllCategories(): StatsCategory[] {
	return ['descriptive', 'stationarity', 'distribution', 'dependence', 'risk'];
}

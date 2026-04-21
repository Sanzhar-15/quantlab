# Prompt 08: Stats Test Catalog

## Objective
Create the complete statistical test catalog with full definitions including parameters.

## Context
Prompt 07 created lightweight metadata for the Resources panel. This prompt creates the full test definitions used by the Stats view for configuration UI.

## File to Create

### `extensions/quantlab/src/stats/StatsCatalog.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Complete Statistical Test Catalog
 *  Full definitions with parameters for Stats view configuration
 *--------------------------------------------------------------------------------------------*/

import { StatsCategory, StatsTestDefinition, StatsParameterDefinition } from '../types/stats';

// ─────────────────────────────────────────────────────────────────────────────
// Parameter Templates (reusable)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Test Definitions
// ─────────────────────────────────────────────────────────────────────────────

export const STATS_TEST_DEFINITIONS: StatsTestDefinition[] = [
    // ═══════════════════════════════════════════════════════════════════════
    // DESCRIPTIVE STATISTICS
    // ═══════════════════════════════════════════════════════════════════════
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

    // ═══════════════════════════════════════════════════════════════════════
    // STATIONARITY TESTS
    // ═══════════════════════════════════════════════════════════════════════
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
        label: 'Phillips-Perron',
        description: 'Non-parametric unit root test, robust to heteroskedasticity',
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
    {
        id: 'zivot',
        label: 'Zivot-Andrews',
        description: 'Unit root test allowing for a structural break',
        category: 'stationarity',
        requiredColumns: { count: 1, types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'breakType',
                label: 'Break Type',
                type: 'select',
                default: 'intercept',
                options: [
                    { value: 'intercept', label: 'Intercept break' },
                    { value: 'trend', label: 'Trend break' },
                    { value: 'both', label: 'Both' }
                ]
            }
        ]
    },
    {
        id: 'variance-ratio',
        label: 'Variance Ratio Test',
        description: 'Lo-MacKinlay test for random walk hypothesis',
        category: 'stationarity',
        requiredColumns: { count: 1, types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'periods',
                label: 'Periods',
                type: 'array',
                default: [2, 4, 8, 16],
                description: 'Holding periods to test'
            }
        ]
    },

    // ═══════════════════════════════════════════════════════════════════════
    // DISTRIBUTION TESTS
    // ═══════════════════════════════════════════════════════════════════════
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
    {
        id: 'ks',
        label: 'Kolmogorov-Smirnov',
        description: 'Test if data follows a specified distribution',
        category: 'distribution',
        requiredColumns: { count: 1, types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'distribution',
                label: 'Reference Distribution',
                type: 'select',
                default: 'norm',
                options: [
                    { value: 'norm', label: 'Normal' },
                    { value: 't', label: 'Student-t' },
                    { value: 'expon', label: 'Exponential' },
                    { value: 'uniform', label: 'Uniform' }
                ]
            }
        ]
    },
    {
        id: 'qq',
        label: 'Q-Q Analysis',
        description: 'Quantile-quantile plot and analysis',
        category: 'distribution',
        requiredColumns: { count: 1, types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'distribution',
                label: 'Reference Distribution',
                type: 'select',
                default: 'norm',
                options: [
                    { value: 'norm', label: 'Normal' },
                    { value: 't', label: 'Student-t' }
                ]
            }
        ]
    },
    {
        id: 'tail',
        label: 'Tail Analysis',
        description: 'Extreme value analysis with GPD fitting',
        category: 'distribution',
        requiredColumns: { count: 1, types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'tail',
                label: 'Tail to Analyze',
                type: 'select',
                default: 'both',
                options: [
                    { value: 'left', label: 'Left tail only' },
                    { value: 'right', label: 'Right tail only' },
                    { value: 'both', label: 'Both tails' }
                ]
            },
            {
                id: 'threshold',
                label: 'Threshold Percentile',
                type: 'number',
                default: 95,
                min: 90,
                max: 99.9,
                description: 'Percentile for threshold selection'
            }
        ]
    },

    // ═══════════════════════════════════════════════════════════════════════
    // DEPENDENCE TESTS
    // ═══════════════════════════════════════════════════════════════════════
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
        id: 'granger',
        label: 'Granger Causality',
        description: 'Test if one series Granger-causes another',
        category: 'dependence',
        requiredColumns: { count: 2, types: ['float64', 'int64'] },
        parameters: [
            {
                ...LAG_PARAM,
                default: 4
            },
            CONFIDENCE_PARAM
        ]
    },
    {
        id: 'cointegration',
        label: 'Cointegration Tests',
        description: 'Engle-Granger and/or Johansen cointegration tests',
        category: 'dependence',
        requiredColumns: { count: '2+', types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'method',
                label: 'Test Method',
                type: 'select',
                default: 'engle-granger',
                options: [
                    { value: 'engle-granger', label: 'Engle-Granger (2 series)' },
                    { value: 'johansen', label: 'Johansen (2+ series)' },
                    { value: 'both', label: 'Both' }
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
            {
                ...LAG_PARAM,
                default: 40
            },
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
            {
                ...LAG_PARAM,
                default: 10
            }
        ]
    },

    // ═══════════════════════════════════════════════════════════════════════
    // VOLATILITY ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════
    {
        id: 'garch',
        label: 'GARCH Models',
        description: 'Fit and diagnose GARCH-family volatility models',
        category: 'volatility',
        requiredColumns: { count: 1, types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'model',
                label: 'Model Type',
                type: 'select',
                default: 'GARCH',
                options: [
                    { value: 'GARCH', label: 'GARCH(1,1)' },
                    { value: 'EGARCH', label: 'EGARCH' },
                    { value: 'GJR-GARCH', label: 'GJR-GARCH (asymmetric)' },
                    { value: 'FIGARCH', label: 'FIGARCH (long memory)' }
                ]
            },
            {
                id: 'distribution',
                label: 'Error Distribution',
                type: 'select',
                default: 'normal',
                options: [
                    { value: 'normal', label: 'Normal' },
                    { value: 't', label: 'Student-t' },
                    { value: 'skewt', label: 'Skewed Student-t' }
                ]
            }
        ]
    },
    {
        id: 'realized',
        label: 'Realized Volatility',
        description: 'Realized variance and bipower variation',
        category: 'volatility',
        requiredColumns: { count: 1, types: ['float64', 'int64'] },
        parameters: [
            WINDOW_PARAM,
            {
                id: 'annualize',
                label: 'Annualize',
                type: 'boolean',
                default: true,
                description: 'Annualize volatility (assumes 252 trading days)'
            }
        ]
    },
    {
        id: 'regime',
        label: 'Regime Detection',
        description: 'Markov switching model for volatility regimes',
        category: 'volatility',
        requiredColumns: { count: 1, types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'nRegimes',
                label: 'Number of Regimes',
                type: 'select',
                default: '2',
                options: [
                    { value: '2', label: '2 regimes' },
                    { value: '3', label: '3 regimes' }
                ]
            }
        ]
    },
    {
        id: 'leverage',
        label: 'Leverage Effect',
        description: 'Test for asymmetric volatility response',
        category: 'volatility',
        requiredColumns: { count: 1, types: ['float64', 'int64'] },
        parameters: [LAG_PARAM]
    },

    // ═══════════════════════════════════════════════════════════════════════
    // REGRESSION ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════
    {
        id: 'ols',
        label: 'OLS Regression',
        description: 'Ordinary least squares with full diagnostics',
        category: 'regression',
        requiredColumns: { count: '2+', types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'addConstant',
                label: 'Add Constant',
                type: 'boolean',
                default: true
            },
            {
                id: 'robustSE',
                label: 'Robust Standard Errors',
                type: 'select',
                default: 'none',
                options: [
                    { value: 'none', label: 'None' },
                    { value: 'HC0', label: 'White (HC0)' },
                    { value: 'HC1', label: 'HC1' },
                    { value: 'HC3', label: 'HC3' },
                    { value: 'HAC', label: 'Newey-West (HAC)' }
                ]
            }
        ]
    },
    {
        id: 'robust',
        label: 'Robust Regression',
        description: 'M-estimators robust to outliers',
        category: 'regression',
        requiredColumns: { count: '2+', types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'method',
                label: 'Method',
                type: 'select',
                default: 'huber',
                options: [
                    { value: 'huber', label: 'Huber' },
                    { value: 'bisquare', label: 'Bisquare (Tukey)' },
                    { value: 'lts', label: 'Least Trimmed Squares' }
                ]
            }
        ]
    },
    {
        id: 'quantile',
        label: 'Quantile Regression',
        description: 'Regression at different quantiles of the distribution',
        category: 'regression',
        requiredColumns: { count: '2+', types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'quantiles',
                label: 'Quantiles',
                type: 'array',
                default: [0.25, 0.5, 0.75],
                description: 'Quantiles to estimate'
            }
        ]
    },
    {
        id: 'rolling-reg',
        label: 'Rolling Regression',
        description: 'Time-varying regression coefficients',
        category: 'regression',
        requiredColumns: { count: '2+', types: ['float64', 'int64'] },
        parameters: [
            {
                ...WINDOW_PARAM,
                default: 60
            }
        ]
    },
    {
        id: 'pca',
        label: 'PCA Analysis',
        description: 'Principal component analysis for dimensionality reduction',
        category: 'regression',
        requiredColumns: { count: '2+', types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'nComponents',
                label: 'Components to Keep',
                type: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: 'Auto (95% variance)' },
                    { value: '1', label: '1 component' },
                    { value: '2', label: '2 components' },
                    { value: '3', label: '3 components' },
                    { value: 'all', label: 'All' }
                ]
            }
        ]
    },

    // ═══════════════════════════════════════════════════════════════════════
    // RISK METRICS
    // ═══════════════════════════════════════════════════════════════════════
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
                    { value: 'cornish-fisher', label: 'Cornish-Fisher' },
                    { value: 'monte-carlo', label: 'Monte Carlo' }
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
        id: 'drawdown',
        label: 'Drawdown Analysis',
        description: 'Maximum drawdown, drawdown duration, underwater periods',
        category: 'risk',
        requiredColumns: { count: 1, types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'isReturns',
                label: 'Input Type',
                type: 'select',
                default: 'prices',
                options: [
                    { value: 'prices', label: 'Prices' },
                    { value: 'returns', label: 'Returns' }
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
    },
    {
        id: 'beta',
        label: 'Beta Analysis',
        description: 'Market beta and factor exposures',
        category: 'risk',
        requiredColumns: { count: 2, types: ['float64', 'int64'] },
        parameters: [
            {
                id: 'rolling',
                label: 'Rolling Beta',
                type: 'boolean',
                default: false
            },
            {
                ...WINDOW_PARAM,
                id: 'rollingWindow',
                label: 'Rolling Window',
                default: 60
            }
        ]
    }
];

// ─────────────────────────────────────────────────────────────────────────────
// Lookup Functions
// ─────────────────────────────────────────────────────────────────────────────

export function getTestById(testId: string): StatsTestDefinition | undefined {
    return STATS_TEST_DEFINITIONS.find(t => t.id === testId);
}

export function getTestsByCategory(category: StatsCategory): StatsTestDefinition[] {
    return STATS_TEST_DEFINITIONS.filter(t => t.category === category);
}

export function getAllCategories(): StatsCategory[] {
    return ['descriptive', 'stationarity', 'distribution', 'dependence', 'volatility', 'regression', 'risk'];
}
```

## Test

1. TypeScript should compile:
   ```bash
   cd extensions/quantlab && npx tsc --noEmit
   ```

2. Test lookups:
   ```typescript
   import { getTestById, getTestsByCategory } from './stats/StatsCatalog';

   const adf = getTestById('adf');
   console.log(adf?.parameters); // Should show regression, maxlag params

   const stationarity = getTestsByCategory('stationarity');
   console.log(stationarity.length); // Should be 5
   ```

## Dependencies
- Prompt 01 (types) must be complete

## Next
Proceed to `09_Stats_View_Provider.md`

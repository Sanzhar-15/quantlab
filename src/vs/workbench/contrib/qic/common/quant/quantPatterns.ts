/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface QuantWarning {
	pattern: string;
	severity: 'error' | 'warning' | 'info';
	message: string;
	line?: number;
	suggestion?: string;
}

export interface QuantContext {
	isQuantFile: boolean;
	detectedLibraries: string[];
	suggestedImports: string[];
	warnings: QuantWarning[];
}

interface PatternRule {
	name: string;
	pattern: RegExp;
	severity: QuantWarning['severity'];
	message: string;
	suggestion: string;
}

// Anti-pattern detection rules
const ANTI_PATTERNS: PatternRule[] = [
	// Look-ahead bias
	{
		name: 'look_ahead_bias',
		pattern: /\.shift\(\s*-\d+\s*\)/,
		severity: 'error',
		message: 'Possible look-ahead bias: negative shift uses future data in backtest',
		suggestion: 'Use positive shift values to reference past data only',
	},
	{
		name: 'look_ahead_bias_future',
		pattern: /\bdf\[['"].*['"]\]\s*=\s*df\[['"].*['"]\]\.shift\(\s*-/,
		severity: 'error',
		message: 'Look-ahead bias: assigning future-shifted data to current row',
		suggestion: 'Only use shift(n) with n >= 0 to avoid seeing future data',
	},
	// Survivorship bias
	{
		name: 'survivorship_bias',
		pattern: /\.groupby\(\s*['"](?:ticker|symbol|stock)['"]\s*\)/i,
		severity: 'warning',
		message: 'Potential survivorship bias: grouping by ticker without survival filter',
		suggestion: 'Apply a delisting filter before grouping to account for delisted securities',
	},
	// Missing transaction costs
	{
		name: 'missing_transaction_costs',
		pattern: /(?:returns?|pnl)\s*=\s*(?:close|price)\s*[./]\s*(?:close|price)\.shift/i,
		severity: 'warning',
		message: 'Return calculation without transaction cost modeling',
		suggestion: 'Subtract estimated transaction costs (slippage + commission) from returns',
	},
	// Incorrect Sharpe ratio
	{
		name: 'incorrect_sharpe',
		pattern: /\.mean\(\)\s*\/\s*\.std\(\)/,
		severity: 'warning',
		message: 'Sharpe ratio may use wrong annualization factor',
		suggestion: 'For daily returns: multiply by sqrt(252). For monthly: sqrt(12). Subtract risk-free rate.',
	},
	// Pandas .loc vs .iloc confusion
	{
		name: 'loc_iloc_confusion',
		pattern: /\.iloc\[\s*['"].*['"]\s*\]/,
		severity: 'error',
		message: 'Using string index with .iloc (expects integer index)',
		suggestion: 'Use .loc[] for label-based indexing, .iloc[] for integer-based indexing',
	},
	{
		name: 'loc_iloc_confusion_2',
		pattern: /\.loc\[\s*\d+\s*\]/,
		severity: 'warning',
		message: 'Using integer index with .loc — behavior depends on index type',
		suggestion: 'Use .iloc[] for explicit integer-position indexing',
	},
	// Data snooping
	{
		name: 'data_snooping',
		pattern: /train_test_split.*test_size\s*=\s*(?:0\.[0-4]|[0-3]0)/,
		severity: 'info',
		message: 'Consider using walk-forward validation instead of fixed train/test split for time series',
		suggestion: 'Use TimeSeriesSplit or expanding/rolling window cross-validation',
	},
	// Dangerous operations on full dataset
	{
		name: 'full_dataset_operation',
		pattern: /\.dropna\(\s*\)/,
		severity: 'info',
		message: 'Dropping all NaN rows may introduce bias in time series data',
		suggestion: 'Consider forward-fill (.ffill()) or specify subset of columns for dropna',
	},
	// Vectorized vs loop
	{
		name: 'iterrows_performance',
		pattern: /\.iterrows\(\)/,
		severity: 'warning',
		message: 'iterrows() is slow for large DataFrames',
		suggestion: 'Use vectorized operations, .apply(), or numpy operations instead',
	},
];

// Quant library detection patterns
const LIBRARY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
	{ name: 'pandas', pattern: /(?:^|\s)import\s+pandas|from\s+pandas/ },
	{ name: 'numpy', pattern: /(?:^|\s)import\s+numpy|from\s+numpy/ },
	{ name: 'scipy', pattern: /(?:^|\s)import\s+scipy|from\s+scipy/ },
	{ name: 'statsmodels', pattern: /(?:^|\s)import\s+statsmodels|from\s+statsmodels/ },
	{ name: 'sklearn', pattern: /(?:^|\s)import\s+sklearn|from\s+sklearn/ },
	{ name: 'matplotlib', pattern: /(?:^|\s)import\s+matplotlib|from\s+matplotlib/ },
	{ name: 'plotly', pattern: /(?:^|\s)import\s+plotly|from\s+plotly/ },
	{ name: 'pyarrow', pattern: /(?:^|\s)import\s+pyarrow|from\s+pyarrow/ },
	{ name: 'ta-lib', pattern: /(?:^|\s)import\s+talib|from\s+talib/ },
	{ name: 'zipline', pattern: /(?:^|\s)import\s+zipline|from\s+zipline/ },
	{ name: 'backtrader', pattern: /(?:^|\s)import\s+backtrader|from\s+backtrader/ },
	{ name: 'quantlib', pattern: /(?:^|\s)import\s+QuantLib|from\s+QuantLib/ },
	{ name: 'cvxpy', pattern: /(?:^|\s)import\s+cvxpy|from\s+cvxpy/ },
	{ name: 'alpaca', pattern: /(?:^|\s)import\s+alpaca|from\s+alpaca/ },
];

// File patterns that indicate quant code
const QUANT_FILE_PATTERNS = [
	/strategies?\//i,
	/backtest/i,
	/\.strategy\.(ts|py|json)$/i,
	/portfolio/i,
	/trading/i,
	/alpha/i,
	/signal/i,
	/risk/i,
	/returns?/i,
];

/**
 * Quant-specific code intelligence for completions and warnings.
 *
 * Detects common quant coding anti-patterns:
 * - Look-ahead bias (using future data in backtest)
 * - Survivorship bias (indexing by ticker without survival filter)
 * - Data snooping (fitting parameters to test set)
 * - Missing transaction cost modeling
 * - Incorrect Sharpe ratio calculation
 * - Pandas .loc vs .iloc confusion
 */
export class QuantPatterns {

	/**
	 * Detect common quant coding anti-patterns and provide warnings.
	 */
	analyzeCode(code: string): QuantWarning[] {
		const warnings: QuantWarning[] = [];
		const lines = code.split('\n');

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			for (const rule of ANTI_PATTERNS) {
				if (rule.pattern.test(line)) {
					warnings.push({
						pattern: rule.name,
						severity: rule.severity,
						message: rule.message,
						line: i + 1,
						suggestion: rule.suggestion,
					});
				}
			}
		}

		return warnings;
	}

	/**
	 * Provide quant-aware completion context.
	 */
	getCompletionContext(code: string, filePath?: string): QuantContext {
		const isQuantFile = filePath ? this.isQuantFile(filePath) : this.looksLikeQuantCode(code);
		const detectedLibraries = this.detectLibraries(code);
		const suggestedImports = this.suggestImports(code, detectedLibraries);
		const warnings = this.analyzeCode(code);

		return {
			isQuantFile,
			detectedLibraries,
			suggestedImports,
			warnings,
		};
	}

	/**
	 * Check if a file path looks like quant code.
	 */
	isQuantFile(filePath: string): boolean {
		return QUANT_FILE_PATTERNS.some(pattern => pattern.test(filePath));
	}

	/**
	 * Detect imported quant libraries in code.
	 */
	private detectLibraries(code: string): string[] {
		const detected: string[] = [];
		for (const lib of LIBRARY_PATTERNS) {
			if (lib.pattern.test(code)) {
				detected.push(lib.name);
			}
		}
		return detected;
	}

	/**
	 * Suggest missing imports based on code usage.
	 */
	private suggestImports(code: string, alreadyImported: string[]): string[] {
		const suggestions: string[] = [];

		// If using pd.DataFrame but no pandas import
		if (/pd\.DataFrame|pandas\.DataFrame/.test(code) && !alreadyImported.includes('pandas')) {
			suggestions.push('import pandas as pd');
		}

		// If using np. but no numpy import
		if (/np\./.test(code) && !alreadyImported.includes('numpy')) {
			suggestions.push('import numpy as np');
		}

		// If computing sharpe/sortino but no scipy
		if (/sharpe|sortino|t_test|norm\.ppf/i.test(code) && !alreadyImported.includes('scipy')) {
			suggestions.push('from scipy import stats');
		}

		return suggestions;
	}

	/**
	 * Heuristic check if code looks like quant/trading code.
	 */
	private looksLikeQuantCode(code: string): boolean {
		const quantTerms = /sharpe|sortino|drawdown|backtest|portfolio|alpha|beta|pnl|returns?\s*=|\.resample|\.rolling|signal/i;
		return quantTerms.test(code);
	}
}

"""Descriptive statistics for QuantLab."""

import pandas as pd
import numpy as np
from scipy import stats as scipy_stats


def summary_stats(df: pd.DataFrame, params: dict) -> dict:
    """Calculate comprehensive summary statistics."""
    percentiles = params.get('percentiles', [0.05, 0.25, 0.5, 0.75, 0.95])

    results = {}
    for col in df.columns:
        series = df[col].dropna()
        results[col] = {
            'count': int(len(series)),
            'mean': float(series.mean()),
            'std': float(series.std()),
            'min': float(series.min()),
            'max': float(series.max()),
            'skewness': float(scipy_stats.skew(series)),
            'kurtosis': float(scipy_stats.kurtosis(series)),
            'percentiles': {f'{p*100:.0f}%': float(series.quantile(p)) for p in percentiles}
        }

    return {
        'testId': 'summary',
        'testName': 'Summary Statistics',
        'statistic': float(df.iloc[:, 0].mean()),
        'pValue': None,
        'conclusion': f'Summary computed for {len(df.columns)} column(s)',
        'interpretation': f'Sample size: {len(df)}. See details for full statistics.',
        'details': results
    }


def returns_analysis(df: pd.DataFrame, params: dict) -> dict:
    """Analyze returns."""
    col = df.iloc[:, 0].dropna()
    return_type = params.get('returnType', 'log')

    if return_type == 'log' or return_type == 'both':
        log_returns = np.log(col / col.shift(1)).dropna()
    if return_type == 'simple' or return_type == 'both':
        simple_returns = col.pct_change().dropna()

    if return_type == 'log':
        returns = log_returns
        ret_name = 'Log Returns'
    elif return_type == 'simple':
        returns = simple_returns
        ret_name = 'Simple Returns'
    else:
        returns = log_returns
        ret_name = 'Log Returns'

    cum_returns = (1 + returns).cumprod() - 1

    return {
        'testId': 'returns',
        'testName': 'Returns Analysis',
        'statistic': float(returns.mean()),
        'pValue': None,
        'conclusion': f'{ret_name}: Mean={returns.mean()*100:.4f}%, Std={returns.std()*100:.4f}%',
        'interpretation': f'Total return: {cum_returns.iloc[-1]*100:.2f}%',
        'details': {
            'mean': float(returns.mean()),
            'std': float(returns.std()),
            'skewness': float(scipy_stats.skew(returns)),
            'kurtosis': float(scipy_stats.kurtosis(returns)),
            'totalReturn': float(cum_returns.iloc[-1])
        }
    }


def rolling_stats(df: pd.DataFrame, params: dict) -> dict:
    """Calculate rolling statistics."""
    window = params.get('window', 20)
    stats_type = params.get('stats', 'mean_std')

    col = df.iloc[:, 0].dropna()

    results = {'window': window}

    if stats_type in ['mean', 'mean_std', 'all']:
        rolling_mean = col.rolling(window=window).mean()
        results['rolling_mean'] = rolling_mean.dropna().tolist()

    if stats_type in ['std', 'mean_std', 'all']:
        rolling_std = col.rolling(window=window).std()
        results['rolling_std'] = rolling_std.dropna().tolist()

    if stats_type == 'all':
        rolling_min = col.rolling(window=window).min()
        rolling_max = col.rolling(window=window).max()
        results['rolling_min'] = rolling_min.dropna().tolist()
        results['rolling_max'] = rolling_max.dropna().tolist()

    return {
        'testId': 'rolling',
        'testName': 'Rolling Statistics',
        'statistic': float(col.rolling(window=window).mean().iloc[-1]),
        'pValue': None,
        'conclusion': f'Rolling {stats_type} computed with window={window}',
        'interpretation': f'Last rolling mean: {results.get("rolling_mean", [0])[-1] if results.get("rolling_mean") else "N/A"}',
        'details': results
    }

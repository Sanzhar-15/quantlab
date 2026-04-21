"""Stationarity tests for QuantLab."""

import pandas as pd
import numpy as np
from statsmodels.tsa.stattools import adfuller, kpss


def adf_test(df: pd.DataFrame, params: dict) -> dict:
    """Augmented Dickey-Fuller test."""
    col = df.iloc[:, 0].dropna()
    regression = params.get('regression', 'c')
    maxlag = params.get('maxlag')

    result = adfuller(col, regression=regression, maxlag=maxlag)
    stat, pvalue, usedlag, nobs, critical_values, icbest = result

    # Determine conclusion
    is_stationary = pvalue < 0.05

    return {
        'testId': 'adf',
        'testName': 'Augmented Dickey-Fuller Test',
        'statistic': float(stat),
        'pValue': float(pvalue),
        'criticalValues': {k: float(v) for k, v in critical_values.items()},
        'conclusion': 'Series is stationary (reject unit root)' if is_stationary else 'Series has unit root (non-stationary)',
        'interpretation': f'ADF statistic: {stat:.4f}. P-value: {pvalue:.4f}. With regression type "{regression}", used {usedlag} lags.',
        'details': {
            'usedLag': int(usedlag),
            'nobs': int(nobs),
            'icbest': float(icbest),
            'regression': regression
        }
    }


def kpss_test(df: pd.DataFrame, params: dict) -> dict:
    """KPSS stationarity test."""
    col = df.iloc[:, 0].dropna()
    regression = params.get('regression', 'c')
    nlags = params.get('nlags', 'auto')

    if nlags == 'legacy':
        nlags = int(np.sqrt(len(col)))
    elif nlags == 'auto':
        nlags = None

    stat, pvalue, usedlag, critical_values = kpss(col, regression=regression, nlags=nlags)

    # KPSS null is stationarity, so reject means non-stationary
    is_stationary = pvalue > 0.05

    return {
        'testId': 'kpss',
        'testName': 'KPSS Test',
        'statistic': float(stat),
        'pValue': float(pvalue),
        'criticalValues': {k: float(v) for k, v in critical_values.items()},
        'conclusion': 'Series is stationary (cannot reject)' if is_stationary else 'Series is non-stationary (reject stationarity)',
        'interpretation': f'KPSS statistic: {stat:.4f}. P-value: {pvalue:.4f}. Note: KPSS null hypothesis is stationarity.',
        'details': {
            'usedLag': int(usedlag),
            'regression': regression
        }
    }


def pp_test(df: pd.DataFrame, params: dict) -> dict:
    """Phillips-Perron test."""
    from statsmodels.tsa.stattools import adfuller

    col = df.iloc[:, 0].dropna()
    regression = params.get('regression', 'c')

    # PP test in statsmodels is accessed via adfuller with autolag='t-stat'
    result = adfuller(col, regression=regression, autolag='t-stat')
    stat, pvalue, usedlag, nobs, critical_values, icbest = result

    is_stationary = pvalue < 0.05

    return {
        'testId': 'pp',
        'testName': 'Phillips-Perron Test',
        'statistic': float(stat),
        'pValue': float(pvalue),
        'criticalValues': {k: float(v) for k, v in critical_values.items()},
        'conclusion': 'Series is stationary (reject unit root)' if is_stationary else 'Series has unit root (non-stationary)',
        'interpretation': f'PP statistic: {stat:.4f}. P-value: {pvalue:.4f}.',
        'details': {
            'usedLag': int(usedlag),
            'nobs': int(nobs),
            'regression': regression
        }
    }

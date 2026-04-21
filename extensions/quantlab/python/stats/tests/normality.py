"""Normality tests for QuantLab."""

import pandas as pd
import numpy as np
from scipy import stats as scipy_stats


def jarque_bera(df: pd.DataFrame, params: dict) -> dict:
    """Jarque-Bera test for normality."""
    col = df.iloc[:, 0].dropna()
    alpha = float(params.get('alpha', 0.05))

    jb_stat, jb_p = scipy_stats.jarque_bera(col)

    is_normal = jb_p >= alpha

    return {
        'testId': 'normality',
        'testName': 'Jarque-Bera Normality Test',
        'statistic': float(jb_stat),
        'pValue': float(jb_p),
        'conclusion': 'Cannot reject normality' if is_normal else 'Data is likely non-normal',
        'interpretation': (
            f'Jarque-Bera statistic: {jb_stat:.4f}. P-value: {jb_p:.4f}. '
            f'At alpha={alpha}, {"cannot reject" if is_normal else "reject"} normality. '
            f'Skewness: {float(col.skew()):.4f}, Kurtosis: {float(col.kurtosis()):.4f}.'
        ),
        'details': {
            'skewness': float(col.skew()),
            'kurtosis': float(col.kurtosis()),
            'n_samples': len(col),
            'alpha': alpha,
        }
    }


def shapiro_wilk(df: pd.DataFrame, params: dict) -> dict:
    """Shapiro-Wilk test for normality."""
    col = df.iloc[:, 0].dropna()
    alpha = float(params.get('alpha', 0.05))

    # Shapiro-Wilk has a limit of 5000 samples
    sample = col.head(5000)
    sw_stat, sw_p = scipy_stats.shapiro(sample)

    is_normal = sw_p >= alpha

    return {
        'testId': 'normality',
        'testName': 'Shapiro-Wilk Normality Test',
        'statistic': float(sw_stat),
        'pValue': float(sw_p),
        'conclusion': 'Cannot reject normality' if is_normal else 'Data is likely non-normal',
        'interpretation': (
            f'Shapiro-Wilk statistic: {sw_stat:.4f}. P-value: {sw_p:.4f}. '
            f'At alpha={alpha}, {"cannot reject" if is_normal else "reject"} normality.'
            f'{" (Used first 5000 samples)" if len(col) > 5000 else ""}'
        ),
        'details': {
            'n_samples': len(sample),
            'n_total': len(col),
            'alpha': alpha,
        }
    }


def anderson_darling(df: pd.DataFrame, params: dict) -> dict:
    """Anderson-Darling test for normality."""
    col = df.iloc[:, 0].dropna()
    alpha = float(params.get('alpha', 0.05))

    result = scipy_stats.anderson(col, dist='norm')
    ad_stat = float(result.statistic)

    # Find the critical value for the closest significance level
    sig_levels = result.significance_level  # e.g., [15, 10, 5, 2.5, 1]
    critical_values = result.critical_values

    # Map to standard format
    cv_dict = {}
    reject = False
    for sl, cv in zip(sig_levels, critical_values):
        cv_dict[f'{sl}%'] = float(cv)
        if sl == 5.0:  # Use 5% as default
            reject = ad_stat > cv

    # If alpha doesn't match 5%, find closest level
    alpha_pct = alpha * 100
    closest_idx = min(range(len(sig_levels)),
                      key=lambda i: abs(sig_levels[i] - alpha_pct))
    reject = ad_stat > critical_values[closest_idx]

    is_normal = not reject

    return {
        'testId': 'normality',
        'testName': 'Anderson-Darling Normality Test',
        'statistic': ad_stat,
        'pValue': None,  # Anderson-Darling doesn't produce a p-value directly
        'criticalValues': cv_dict,
        'conclusion': 'Cannot reject normality' if is_normal else 'Data is likely non-normal',
        'interpretation': (
            f'Anderson-Darling statistic: {ad_stat:.4f}. '
            f'At {sig_levels[closest_idx]}% significance level, '
            f'critical value is {critical_values[closest_idx]:.4f}. '
            f'{"Cannot reject" if is_normal else "Reject"} normality.'
        ),
        'details': {
            'significance_levels': [float(s) for s in sig_levels],
            'critical_values': [float(c) for c in critical_values],
            'n_samples': len(col),
            'alpha': alpha,
        }
    }

#!/usr/bin/env python3
"""
Stats test runner for QuantLab
Receives job request as JSON, executes statistical test, outputs results as JSON
"""

import argparse
import json
import sys
from pathlib import Path

import pandas as pd
import numpy as np
from scipy import stats as scipy_stats

# Add parent to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from tests import stationarity, descriptive, normality


def emit_progress(progress: float, message: str):
    """Emit progress update to stdout."""
    print(json.dumps({'type': 'progress', 'progress': progress, 'message': message}))
    sys.stdout.flush()


def emit_result(result: dict):
    """Emit final result to stdout."""
    result['type'] = 'result'
    print(json.dumps(result))
    sys.stdout.flush()


def load_data(path: str, columns: list[str]) -> pd.DataFrame:
    """Load data from file."""
    p = Path(path)
    ext = p.suffix.lower()

    if ext == '.csv':
        df = pd.read_csv(p)
    elif ext == '.parquet':
        df = pd.read_parquet(p)
    elif ext == '.xlsx':
        df = pd.read_excel(p)
    else:
        raise ValueError(f"Unsupported file type: {ext}")

    # Select columns
    if columns:
        df = df[columns]

    return df


def run_test(job: dict) -> dict:
    """Execute the statistical test."""
    test_id = job['testId']
    data_path = job['dataPath']
    columns = job['columns']
    parameters = job.get('parameters', {})

    emit_progress(10, 'Loading data...')
    df = load_data(data_path, columns)

    emit_progress(30, 'Running test...')

    # Route to appropriate test
    if test_id == 'adf':
        return stationarity.adf_test(df, parameters)
    elif test_id == 'kpss':
        return stationarity.kpss_test(df, parameters)
    elif test_id == 'pp':
        return stationarity.pp_test(df, parameters)
    elif test_id == 'summary':
        return descriptive.summary_stats(df, parameters)
    elif test_id == 'returns':
        return descriptive.returns_analysis(df, parameters)
    elif test_id == 'rolling':
        return descriptive.rolling_stats(df, parameters)
    elif test_id == 'normality':
        return run_normality_test(df, parameters)
    elif test_id == 'normality-jb':
        return normality.jarque_bera(df, parameters)
    elif test_id == 'normality-sw':
        return normality.shapiro_wilk(df, parameters)
    elif test_id == 'normality-ad':
        return normality.anderson_darling(df, parameters)
    elif test_id == 'correlation':
        return run_correlation(df, parameters)
    elif test_id == 'acf-pacf':
        return run_acf_pacf(df, parameters)
    elif test_id == 'ljung-box':
        return run_ljung_box(df, parameters)
    elif test_id == 'var':
        return run_var(df, parameters)
    elif test_id == 'es':
        return run_es(df, parameters)
    elif test_id == 'sharpe':
        return run_risk_metrics(df, parameters)
    else:
        raise ValueError(f"Unknown test: {test_id}")


def run_normality_test(df: pd.DataFrame, params: dict) -> dict:
    """Run normality tests - routes to specific test based on test_method param."""
    test_method = params.get('test_method', 'jarque-bera')

    if test_method == 'shapiro-wilk':
        return normality.shapiro_wilk(df, params)
    elif test_method == 'anderson-darling':
        return normality.anderson_darling(df, params)
    else:
        # Default: Jarque-Bera (also handles legacy calls without test_method)
        return normality.jarque_bera(df, params)


def run_correlation(df: pd.DataFrame, params: dict) -> dict:
    """Compute correlation matrix."""
    method = params.get('method', 'pearson')

    if method == 'all':
        pearson = df.corr(method='pearson')
        spearman = df.corr(method='spearman')
        details = {
            'pearson': pearson.to_dict(),
            'spearman': spearman.to_dict()
        }
        corr = pearson
    else:
        corr = df.corr(method=method)
        details = {'correlation': corr.to_dict()}

    return {
        'testId': 'correlation',
        'testName': 'Correlation Matrix',
        'statistic': float(corr.values[0, 1]) if corr.shape[0] > 1 else 1.0,
        'pValue': None,
        'conclusion': f'{method.capitalize()} correlation computed',
        'interpretation': f'Correlation matrix computed using {method} method.',
        'details': details
    }


def run_acf_pacf(df: pd.DataFrame, params: dict) -> dict:
    """Run ACF/PACF analysis."""
    from statsmodels.tsa.stattools import acf, pacf

    col = df.iloc[:, 0].dropna()
    lags = params.get('lags', 40)

    acf_vals = acf(col, nlags=lags)
    pacf_vals = pacf(col, nlags=min(lags, len(col)//2 - 1))

    return {
        'testId': 'acf-pacf',
        'testName': 'ACF/PACF Analysis',
        'statistic': float(acf_vals[1]),
        'pValue': None,
        'conclusion': 'ACF and PACF computed successfully',
        'interpretation': f'First-order autocorrelation: {acf_vals[1]:.4f}',
        'details': {
            'acf': acf_vals.tolist(),
            'pacf': pacf_vals.tolist(),
            'lags': list(range(len(acf_vals)))
        }
    }


def run_ljung_box(df: pd.DataFrame, params: dict) -> dict:
    """Run Ljung-Box test."""
    from statsmodels.stats.diagnostic import acorr_ljungbox

    col = df.iloc[:, 0].dropna()
    lags = params.get('lags', 10)

    result = acorr_ljungbox(col, lags=[lags], return_df=True)
    lb_stat = float(result['lb_stat'].values[0])
    lb_p = float(result['lb_pvalue'].values[0])

    return {
        'testId': 'ljung-box',
        'testName': 'Ljung-Box Test',
        'statistic': lb_stat,
        'pValue': lb_p,
        'conclusion': 'Serial correlation detected' if lb_p < 0.05 else 'No significant serial correlation',
        'interpretation': f'At lag {lags}: Q-statistic={lb_stat:.4f}, p-value={lb_p:.4f}',
        'details': {'lag': lags}
    }


def run_var(df: pd.DataFrame, params: dict) -> dict:
    """Calculate Value at Risk."""
    col = df.iloc[:, 0].dropna()
    confidence = float(params.get('confidence', 0.95))
    method = params.get('method', 'historical')

    returns = col.pct_change().dropna()

    if method == 'historical':
        var = float(np.percentile(returns, (1 - confidence) * 100))
    elif method == 'parametric':
        var = float(scipy_stats.norm.ppf(1 - confidence, returns.mean(), returns.std()))
    else:
        var = float(np.percentile(returns, (1 - confidence) * 100))

    return {
        'testId': 'var',
        'testName': 'Value at Risk',
        'statistic': var,
        'pValue': None,
        'conclusion': f'{confidence*100:.0f}% VaR: {var*100:.2f}%',
        'interpretation': f'With {confidence*100:.0f}% confidence, the maximum expected loss is {abs(var)*100:.2f}%',
        'details': {'var': var, 'confidence': confidence, 'method': method}
    }


def run_es(df: pd.DataFrame, params: dict) -> dict:
    """Calculate Expected Shortfall."""
    col = df.iloc[:, 0].dropna()
    confidence = float(params.get('confidence', 0.95))

    returns = col.pct_change().dropna()
    var = np.percentile(returns, (1 - confidence) * 100)
    es = float(returns[returns <= var].mean())

    return {
        'testId': 'es',
        'testName': 'Expected Shortfall',
        'statistic': es,
        'pValue': None,
        'conclusion': f'{confidence*100:.0f}% ES: {es*100:.2f}%',
        'interpretation': f'Expected loss given that loss exceeds VaR: {abs(es)*100:.2f}%',
        'details': {'es': es, 'var': float(var), 'confidence': confidence}
    }


def run_risk_metrics(df: pd.DataFrame, params: dict) -> dict:
    """Calculate risk-adjusted return metrics."""
    col = df.iloc[:, 0].dropna()
    rf = float(params.get('riskFreeRate', 0.0))
    periods = int(params.get('periods', 252))

    returns = col.pct_change().dropna()

    # Annualized metrics
    mean_return = returns.mean() * periods
    std_return = returns.std() * np.sqrt(periods)

    # Sharpe ratio
    sharpe = (mean_return - rf) / std_return if std_return > 0 else 0

    # Sortino ratio (downside deviation)
    downside = returns[returns < 0]
    downside_std = downside.std() * np.sqrt(periods) if len(downside) > 0 else 0
    sortino = (mean_return - rf) / downside_std if downside_std > 0 else 0

    return {
        'testId': 'sharpe',
        'testName': 'Risk-Adjusted Returns',
        'statistic': float(sharpe),
        'pValue': None,
        'conclusion': f'Sharpe Ratio: {sharpe:.2f}',
        'interpretation': f'Annualized return: {mean_return*100:.2f}%, Volatility: {std_return*100:.2f}%',
        'details': {
            'sharpe': float(sharpe),
            'sortino': float(sortino),
            'annualized_return': float(mean_return),
            'annualized_volatility': float(std_return)
        }
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', required=True, help='JSON job request')
    args = parser.parse_args()

    # Initialize job dict before try block for error handling
    job = {'testId': 'unknown'}

    try:
        job = json.loads(args.job)

        emit_progress(0, 'Starting test...')
        result = run_test(job)
        emit_progress(100, 'Complete')
        emit_result(result)

    except json.JSONDecodeError as e:
        print(json.dumps({
            'type': 'result',
            'testId': 'unknown',
            'testName': 'Error',
            'statistic': 0,
            'pValue': None,
            'conclusion': f'Failed to parse job request: {str(e)}',
            'interpretation': '',
            'details': {'error': str(e)}
        }))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({
            'type': 'result',
            'testId': job.get('testId', 'unknown'),
            'testName': 'Error',
            'statistic': 0,
            'pValue': None,
            'conclusion': f'Test failed: {str(e)}',
            'interpretation': '',
            'details': {'error': str(e)}
        }))
        sys.exit(1)


if __name__ == '__main__':
    main()

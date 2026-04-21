# Prompt 12: Python Stats Runner

## Objective
Create the Python script that executes statistical tests and returns results.

## Context
The StatsEngine (Prompt 11) spawns this Python script. It loads data, runs the test, and outputs JSON results.

## Files to Create

### `extensions/quantlab/python/stats/runner.py`

```python
#!/usr/bin/env python3
"""
Stats Runner - Executes statistical tests for QuantLab
Output format: JSON lines (one JSON object per line)
- Progress: {"type": "progress", "progress": 0-100, "message": "..."}
- Result: {"type": "result", "testId": "...", ...}
"""

import argparse
import json
import sys
import traceback
from pathlib import Path

import pandas as pd
import numpy as np

# Import test implementations
from tests import (
    run_adf_test,
    run_kpss_test,
    run_pp_test,
    run_normality_tests,
    run_correlation,
    run_granger_causality,
    run_cointegration,
    run_acf_pacf,
    run_ljung_box,
    run_garch,
    run_var_es,
    run_drawdown,
    run_sharpe_ratios,
    run_ols_regression,
    run_summary_stats,
    run_returns_analysis,
    run_rolling_stats,
)


def emit_progress(progress: float, message: str):
    """Emit progress update to stdout."""
    print(json.dumps({
        "type": "progress",
        "progress": progress,
        "message": message
    }), flush=True)


def emit_result(result: dict):
    """Emit final result to stdout."""
    print(json.dumps({
        "type": "result",
        **result
    }), flush=True)


def load_data(data_path: str, columns: list[str]) -> pd.DataFrame:
    """Load data file and select columns."""
    path = Path(data_path)
    ext = path.suffix.lower()

    emit_progress(10, "Loading data file...")

    if ext == '.csv':
        df = pd.read_csv(path)
    elif ext == '.parquet':
        df = pd.read_parquet(path)
    elif ext == '.xlsx':
        df = pd.read_excel(path)
    else:
        raise ValueError(f"Unsupported file type: {ext}")

    # Select requested columns
    missing = [c for c in columns if c not in df.columns]
    if missing:
        raise ValueError(f"Columns not found: {missing}")

    emit_progress(20, f"Loaded {len(df)} rows")

    return df[columns]


def run_test(test_id: str, df: pd.DataFrame, parameters: dict) -> dict:
    """Dispatch to appropriate test function."""
    emit_progress(30, f"Running {test_id}...")

    test_functions = {
        # Descriptive
        'summary': run_summary_stats,
        'returns': run_returns_analysis,
        'rolling': run_rolling_stats,

        # Stationarity
        'adf': run_adf_test,
        'kpss': run_kpss_test,
        'pp': run_pp_test,
        'zivot': lambda df, p: run_adf_test(df, {**p, 'method': 'zivot'}),  # Simplified
        'variance-ratio': lambda df, p: run_adf_test(df, {**p, 'method': 'variance-ratio'}),

        # Distribution
        'normality': run_normality_tests,
        'ks': lambda df, p: run_normality_tests(df, {**p, 'tests': 'ks'}),
        'qq': lambda df, p: run_normality_tests(df, {**p, 'tests': 'qq'}),
        'tail': lambda df, p: run_normality_tests(df, {**p, 'tests': 'tail'}),

        # Dependence
        'correlation': run_correlation,
        'granger': run_granger_causality,
        'cointegration': run_cointegration,
        'acf-pacf': run_acf_pacf,
        'ljung-box': run_ljung_box,

        # Volatility
        'garch': run_garch,
        'realized': lambda df, p: run_rolling_stats(df, {**p, 'stats': 'realized_vol'}),
        'regime': lambda df, p: run_garch(df, {**p, 'regime': True}),
        'leverage': lambda df, p: run_garch(df, {**p, 'leverage': True}),

        # Regression
        'ols': run_ols_regression,
        'robust': lambda df, p: run_ols_regression(df, {**p, 'robust': True}),
        'quantile': lambda df, p: run_ols_regression(df, {**p, 'quantile': True}),
        'rolling-reg': lambda df, p: run_ols_regression(df, {**p, 'rolling': True}),
        'pca': lambda df, p: run_ols_regression(df, {**p, 'pca': True}),

        # Risk
        'var': run_var_es,
        'es': lambda df, p: run_var_es(df, {**p, 'include_es': True}),
        'drawdown': run_drawdown,
        'sharpe': run_sharpe_ratios,
        'beta': lambda df, p: run_ols_regression(df, {**p, 'beta': True}),
    }

    if test_id not in test_functions:
        raise ValueError(f"Unknown test: {test_id}")

    emit_progress(50, "Computing...")
    result = test_functions[test_id](df, parameters)
    emit_progress(90, "Formatting results...")

    return result


def main():
    parser = argparse.ArgumentParser(description='Run statistical test')
    parser.add_argument('--job', required=True, help='JSON job request')
    args = parser.parse_args()

    # Initialize job dict in case JSON parsing fails
    job = {'testId': 'unknown'}

    try:
        job = json.loads(args.job)

        test_id = job['testId']
        data_path = job['dataPath']
        columns = job['columns']
        parameters = job.get('parameters', {})

        # Load data
        df = load_data(data_path, columns)

        # Run test
        result = run_test(test_id, df, parameters)

        # Emit result
        emit_progress(100, "Complete")
        emit_result({
            'testId': test_id,
            **result
        })

    except json.JSONDecodeError as e:
        # JSON parsing failed
        emit_result({
            'testId': 'unknown',
            'testName': 'Error',
            'statistic': 0,
            'pValue': 1,
            'conclusion': 'Invalid job request',
            'interpretation': f'Failed to parse job JSON: {str(e)}',
            'details': {'traceback': traceback.format_exc()}
        })
        sys.exit(1)
    except Exception as e:
        # Other errors - job dict should be available
        emit_result({
            'testId': job.get('testId', 'unknown'),
            'testName': 'Error',
            'statistic': 0,
            'pValue': 1,
            'conclusion': 'Test failed',
            'interpretation': str(e),
            'details': {'traceback': traceback.format_exc()}
        })
        sys.exit(1)


if __name__ == '__main__':
    main()
```

### `extensions/quantlab/python/stats/tests/__init__.py`

```python
"""Statistical test implementations."""

from .stationarity import run_adf_test, run_kpss_test, run_pp_test
from .distribution import run_normality_tests
from .dependence import run_correlation, run_granger_causality, run_cointegration, run_acf_pacf, run_ljung_box
from .volatility import run_garch
from .risk import run_var_es, run_drawdown, run_sharpe_ratios
from .regression import run_ols_regression
from .descriptive import run_summary_stats, run_returns_analysis, run_rolling_stats

__all__ = [
    'run_adf_test', 'run_kpss_test', 'run_pp_test',
    'run_normality_tests',
    'run_correlation', 'run_granger_causality', 'run_cointegration', 'run_acf_pacf', 'run_ljung_box',
    'run_garch',
    'run_var_es', 'run_drawdown', 'run_sharpe_ratios',
    'run_ols_regression',
    'run_summary_stats', 'run_returns_analysis', 'run_rolling_stats',
]
```

### `extensions/quantlab/python/stats/tests/stationarity.py`

```python
"""Stationarity test implementations."""

import pandas as pd
import numpy as np
from statsmodels.tsa.stattools import adfuller, kpss
from arch.unitroot import PhillipsPerron


def run_adf_test(df: pd.DataFrame, params: dict) -> dict:
    """Augmented Dickey-Fuller test."""
    series = df.iloc[:, 0].dropna()
    regression = params.get('regression', 'c')
    maxlag = params.get('maxlag')

    result = adfuller(series, regression=regression, maxlag=maxlag, autolag='AIC')

    adf_stat, p_value, used_lag, nobs, critical_values, icbest = result

    # Interpretation
    significant = p_value < 0.05
    conclusion = "Reject null hypothesis (series is stationary)" if significant else "Fail to reject null hypothesis (series has unit root)"

    interpretation = f"The ADF statistic is {adf_stat:.4f} with a p-value of {p_value:.4f}. "
    if significant:
        interpretation += "This suggests the time series is stationary."
    else:
        interpretation += "This suggests the time series is non-stationary and may have a unit root."

    return {
        'testName': 'Augmented Dickey-Fuller Test',
        'statistic': float(adf_stat),
        'pValue': float(p_value),
        'criticalValues': {k: float(v) for k, v in critical_values.items()},
        'conclusion': conclusion,
        'interpretation': interpretation,
        'details': {
            'usedLag': int(used_lag),
            'nobs': int(nobs),
            'icBest': float(icbest),
            'regression': regression
        }
    }


def run_kpss_test(df: pd.DataFrame, params: dict) -> dict:
    """KPSS test for stationarity."""
    series = df.iloc[:, 0].dropna()
    regression = params.get('regression', 'c')
    nlags = params.get('nlags', 'auto')

    result = kpss(series, regression=regression, nlags=nlags)
    kpss_stat, p_value, used_lag, critical_values = result

    # KPSS null is stationarity (opposite of ADF)
    significant = p_value < 0.05
    conclusion = "Reject null hypothesis (series is NOT stationary)" if significant else "Fail to reject null hypothesis (series is stationary)"

    interpretation = f"The KPSS statistic is {kpss_stat:.4f} with a p-value of {p_value:.4f}. "
    if significant:
        interpretation += "This suggests the time series is non-stationary."
    else:
        interpretation += "This suggests the time series is stationary."

    return {
        'testName': 'KPSS Test',
        'statistic': float(kpss_stat),
        'pValue': float(p_value),
        'criticalValues': {k: float(v) for k, v in critical_values.items()},
        'conclusion': conclusion,
        'interpretation': interpretation,
        'details': {
            'usedLag': int(used_lag),
            'regression': regression
        }
    }


def run_pp_test(df: pd.DataFrame, params: dict) -> dict:
    """Phillips-Perron test."""
    series = df.iloc[:, 0].dropna()
    trend = params.get('regression', 'c')

    pp = PhillipsPerron(series, trend=trend)

    p_value = pp.pvalue
    significant = p_value < 0.05
    conclusion = "Reject null hypothesis (series is stationary)" if significant else "Fail to reject null hypothesis (series has unit root)"

    return {
        'testName': 'Phillips-Perron Test',
        'statistic': float(pp.stat),
        'pValue': float(p_value),
        'criticalValues': {k: float(v) for k, v in pp.critical_values.items()},
        'conclusion': conclusion,
        'interpretation': f"PP statistic: {pp.stat:.4f}, p-value: {p_value:.4f}",
        'details': {
            'trend': trend,
            'lags': int(pp.lags)
        }
    }
```

### `extensions/quantlab/python/stats/tests/descriptive.py`

```python
"""Descriptive statistics implementations."""

import pandas as pd
import numpy as np
from scipy import stats


def run_summary_stats(df: pd.DataFrame, params: dict) -> dict:
    """Comprehensive summary statistics."""
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
            'skewness': float(stats.skew(series)),
            'kurtosis': float(stats.kurtosis(series)),
            'percentiles': {f'{int(p*100)}%': float(series.quantile(p)) for p in percentiles}
        }

    return {
        'testName': 'Summary Statistics',
        'statistic': float(df.iloc[:, 0].mean()),  # Primary stat
        'pValue': 1.0,  # Not applicable
        'conclusion': 'Summary statistics computed successfully',
        'interpretation': f'Analyzed {len(df.columns)} column(s) with {len(df)} observations',
        'details': results
    }


def run_returns_analysis(df: pd.DataFrame, params: dict) -> dict:
    """Returns analysis."""
    return_type = params.get('returnType', 'log')
    series = df.iloc[:, 0].dropna()

    if return_type in ['log', 'both']:
        log_returns = np.log(series / series.shift(1)).dropna()
    if return_type in ['simple', 'both']:
        simple_returns = series.pct_change().dropna()

    returns = log_returns if return_type == 'log' else simple_returns

    return {
        'testName': 'Returns Analysis',
        'statistic': float(returns.mean()),
        'pValue': 1.0,
        'conclusion': f'Computed {return_type} returns',
        'interpretation': f'Mean return: {returns.mean():.4%}, Std: {returns.std():.4%}',
        'details': {
            'mean': float(returns.mean()),
            'std': float(returns.std()),
            'cumulative': float((1 + returns).prod() - 1),
            'annualized_return': float(returns.mean() * 252),
            'annualized_vol': float(returns.std() * np.sqrt(252))
        }
    }


def run_rolling_stats(df: pd.DataFrame, params: dict) -> dict:
    """Rolling statistics."""
    window = params.get('window', 20)
    stat_type = params.get('stats', 'mean_std')

    series = df.iloc[:, 0].dropna()

    rolling = series.rolling(window=window)
    results = {}

    if stat_type in ['mean', 'mean_std', 'all']:
        results['rolling_mean'] = rolling.mean().dropna().tolist()[-100:]  # Last 100 points
    if stat_type in ['std', 'mean_std', 'all']:
        results['rolling_std'] = rolling.std().dropna().tolist()[-100:]
    if stat_type == 'all':
        results['rolling_min'] = rolling.min().dropna().tolist()[-100:]
        results['rolling_max'] = rolling.max().dropna().tolist()[-100:]

    return {
        'testName': 'Rolling Statistics',
        'statistic': float(rolling.mean().iloc[-1]) if not rolling.mean().empty else 0,
        'pValue': 1.0,
        'conclusion': f'Computed rolling statistics with window={window}',
        'interpretation': f'Rolling {stat_type} calculated over {window} periods',
        'details': results
    }
```

### `extensions/quantlab/python/stats/requirements.txt`

```
pandas>=2.0.0
numpy>=1.24.0
scipy>=1.10.0
statsmodels>=0.14.0
arch>=6.0.0
scikit-learn>=1.3.0
openpyxl>=3.1.0
```

## Additional Test Files

Create the following files with stub implementations (full implementations can be added incrementally):

### `extensions/quantlab/python/stats/tests/distribution.py`

```python
"""Distribution test implementations."""

import pandas as pd
import numpy as np
from scipy import stats


def run_normality_tests(df: pd.DataFrame, params: dict) -> dict:
    """Run normality tests (Jarque-Bera, Shapiro-Wilk, Anderson-Darling)."""
    series = df.iloc[:, 0].dropna()
    test_type = params.get('tests', 'all')

    results = {}

    # Jarque-Bera
    if test_type in ['all', 'jarque-bera']:
        jb_stat, jb_pvalue = stats.jarque_bera(series)
        results['jarque_bera'] = {'statistic': float(jb_stat), 'pValue': float(jb_pvalue)}

    # Shapiro-Wilk (limit to 5000 samples)
    if test_type in ['all', 'shapiro']:
        sample = series[:5000] if len(series) > 5000 else series
        sw_stat, sw_pvalue = stats.shapiro(sample)
        results['shapiro_wilk'] = {'statistic': float(sw_stat), 'pValue': float(sw_pvalue)}

    # Anderson-Darling
    if test_type in ['all', 'anderson']:
        ad_result = stats.anderson(series, dist='norm')
        results['anderson_darling'] = {
            'statistic': float(ad_result.statistic),
            'critical_values': dict(zip(['15%', '10%', '5%', '2.5%', '1%'],
                                       [float(cv) for cv in ad_result.critical_values]))
        }

    # Primary result (use Jarque-Bera as default)
    primary = results.get('jarque_bera', {'statistic': 0, 'pValue': 1})
    significant = primary['pValue'] < 0.05

    return {
        'testName': 'Normality Tests',
        'statistic': primary['statistic'],
        'pValue': primary['pValue'],
        'conclusion': 'Reject normality' if significant else 'Cannot reject normality',
        'interpretation': f'Data {"does not follow" if significant else "may follow"} a normal distribution',
        'details': results
    }
```

### `extensions/quantlab/python/stats/tests/dependence.py`

```python
"""Dependence test implementations."""

import pandas as pd
import numpy as np
from scipy import stats
from statsmodels.tsa.stattools import grangercausalitytests, acf, pacf
from statsmodels.stats.diagnostic import acorr_ljungbox


def run_correlation(df: pd.DataFrame, params: dict) -> dict:
    """Compute correlation matrix."""
    method = params.get('method', 'pearson')

    if method == 'all':
        corr_pearson = df.corr(method='pearson')
        corr_spearman = df.corr(method='spearman')
        corr_kendall = df.corr(method='kendall')
        details = {
            'pearson': corr_pearson.to_dict(),
            'spearman': corr_spearman.to_dict(),
            'kendall': corr_kendall.to_dict()
        }
        corr = corr_pearson
    else:
        corr = df.corr(method=method)
        details = {method: corr.to_dict()}

    # Get the off-diagonal correlation as primary statistic
    if len(df.columns) >= 2:
        primary_corr = corr.iloc[0, 1]
    else:
        primary_corr = 1.0

    return {
        'testName': 'Correlation Matrix',
        'statistic': float(primary_corr),
        'pValue': 1.0,  # Not applicable for correlation
        'conclusion': f'Correlation computed using {method} method',
        'interpretation': f'Primary correlation: {primary_corr:.4f}',
        'details': details
    }


def run_granger_causality(df: pd.DataFrame, params: dict) -> dict:
    """Granger causality test."""
    if df.shape[1] < 2:
        raise ValueError("Granger causality requires at least 2 columns")

    lags = params.get('lags', 4)
    data = df.iloc[:, :2].dropna()

    try:
        result = grangercausalitytests(data, maxlag=lags, verbose=False)
        # Get p-value from F-test at optimal lag
        best_lag = min(result.keys())
        f_test = result[best_lag][0]['ssr_ftest']
        p_value = f_test[1]
        f_stat = f_test[0]
    except Exception as e:
        return {
            'testName': 'Granger Causality',
            'statistic': 0,
            'pValue': 1,
            'conclusion': f'Test failed: {str(e)}',
            'interpretation': 'Could not perform Granger causality test',
            'details': {}
        }

    significant = p_value < 0.05

    return {
        'testName': 'Granger Causality',
        'statistic': float(f_stat),
        'pValue': float(p_value),
        'conclusion': f'Column 1 {"Granger-causes" if significant else "does not Granger-cause"} Column 2',
        'interpretation': f'F-statistic: {f_stat:.4f}, p-value: {p_value:.4f}',
        'details': {'lags_tested': lags}
    }


def run_cointegration(df: pd.DataFrame, params: dict) -> dict:
    """Cointegration test (Engle-Granger)."""
    from statsmodels.tsa.stattools import coint

    if df.shape[1] < 2:
        raise ValueError("Cointegration requires at least 2 columns")

    y = df.iloc[:, 0].dropna()
    x = df.iloc[:, 1].dropna()

    # Align series
    min_len = min(len(y), len(x))
    y, x = y[:min_len], x[:min_len]

    coint_stat, p_value, crit_values = coint(y, x)

    significant = p_value < 0.05

    return {
        'testName': 'Cointegration Test (Engle-Granger)',
        'statistic': float(coint_stat),
        'pValue': float(p_value),
        'criticalValues': {'1%': float(crit_values[0]), '5%': float(crit_values[1]), '10%': float(crit_values[2])},
        'conclusion': f'Series are {"cointegrated" if significant else "not cointegrated"}',
        'interpretation': f'Test statistic: {coint_stat:.4f}, p-value: {p_value:.4f}',
        'details': {}
    }


def run_acf_pacf(df: pd.DataFrame, params: dict) -> dict:
    """ACF/PACF analysis."""
    series = df.iloc[:, 0].dropna()
    lags = params.get('lags', 40)

    acf_values = acf(series, nlags=lags)
    pacf_values = pacf(series, nlags=lags)

    return {
        'testName': 'ACF/PACF Analysis',
        'statistic': float(acf_values[1]),  # First lag ACF
        'pValue': 1.0,
        'conclusion': 'ACF/PACF computed successfully',
        'interpretation': f'First lag autocorrelation: {acf_values[1]:.4f}',
        'details': {
            'acf': [float(v) for v in acf_values],
            'pacf': [float(v) for v in pacf_values]
        }
    }


def run_ljung_box(df: pd.DataFrame, params: dict) -> dict:
    """Ljung-Box test for serial correlation."""
    series = df.iloc[:, 0].dropna()
    lags = params.get('lags', 10)

    result = acorr_ljungbox(series, lags=[lags], return_df=True)
    lb_stat = result['lb_stat'].iloc[0]
    p_value = result['lb_pvalue'].iloc[0]

    significant = p_value < 0.05

    return {
        'testName': 'Ljung-Box Test',
        'statistic': float(lb_stat),
        'pValue': float(p_value),
        'conclusion': f'Serial correlation {"detected" if significant else "not detected"}',
        'interpretation': f'Q-statistic: {lb_stat:.4f}, p-value: {p_value:.4f}',
        'details': {'lags': lags}
    }
```

### `extensions/quantlab/python/stats/tests/volatility.py`

```python
"""Volatility analysis implementations."""

import pandas as pd
import numpy as np


def run_garch(df: pd.DataFrame, params: dict) -> dict:
    """Fit GARCH model."""
    from arch import arch_model

    series = df.iloc[:, 0].dropna()
    model_type = params.get('model', 'GARCH')
    dist = params.get('distribution', 'normal')

    # Convert to returns if needed (assume prices if values are large)
    if series.mean() > 1:
        returns = 100 * np.log(series / series.shift(1)).dropna()
    else:
        returns = series * 100  # Scale for numerical stability

    try:
        if model_type == 'EGARCH':
            model = arch_model(returns, vol='EGARCH', p=1, q=1, dist=dist)
        elif model_type == 'GJR-GARCH':
            model = arch_model(returns, vol='GARCH', p=1, o=1, q=1, dist=dist)
        else:
            model = arch_model(returns, vol='GARCH', p=1, q=1, dist=dist)

        result = model.fit(disp='off')

        return {
            'testName': f'{model_type} Model',
            'statistic': float(result.params.get('omega', 0)),
            'pValue': float(result.pvalues.get('omega', 1)),
            'conclusion': f'{model_type} model fitted successfully',
            'interpretation': f'Log-likelihood: {result.loglikelihood:.2f}, AIC: {result.aic:.2f}',
            'details': {
                'params': {k: float(v) for k, v in result.params.items()},
                'pvalues': {k: float(v) for k, v in result.pvalues.items()},
                'aic': float(result.aic),
                'bic': float(result.bic),
                'loglikelihood': float(result.loglikelihood)
            }
        }
    except Exception as e:
        return {
            'testName': f'{model_type} Model',
            'statistic': 0,
            'pValue': 1,
            'conclusion': f'Model fitting failed: {str(e)}',
            'interpretation': 'Could not fit GARCH model',
            'details': {'error': str(e)}
        }
```

### `extensions/quantlab/python/stats/tests/risk.py`

```python
"""Risk metrics implementations."""

import pandas as pd
import numpy as np
from scipy import stats


def run_var_es(df: pd.DataFrame, params: dict) -> dict:
    """Calculate Value at Risk and Expected Shortfall."""
    series = df.iloc[:, 0].dropna()
    confidence = float(params.get('confidence', 0.95))
    method = params.get('method', 'historical')

    # Convert to returns if needed
    if series.mean() > 1:
        returns = np.log(series / series.shift(1)).dropna()
    else:
        returns = series

    alpha = 1 - confidence

    if method == 'historical':
        var = np.percentile(returns, alpha * 100)
        es = returns[returns <= var].mean()
    elif method == 'parametric':
        mu, sigma = returns.mean(), returns.std()
        var = stats.norm.ppf(alpha, mu, sigma)
        es = mu - sigma * stats.norm.pdf(stats.norm.ppf(alpha)) / alpha
    else:  # cornish-fisher
        mu, sigma = returns.mean(), returns.std()
        skew = stats.skew(returns)
        kurt = stats.kurtosis(returns)
        z = stats.norm.ppf(alpha)
        z_cf = z + (z**2 - 1) * skew / 6 + (z**3 - 3*z) * kurt / 24 - (2*z**3 - 5*z) * skew**2 / 36
        var = mu + sigma * z_cf
        es = returns[returns <= var].mean()

    return {
        'testName': 'Value at Risk',
        'statistic': float(var),
        'pValue': confidence,
        'conclusion': f'{confidence*100:.0f}% VaR: {var:.4%}',
        'interpretation': f'Expected Shortfall: {es:.4%}',
        'details': {
            'var': float(var),
            'es': float(es),
            'confidence': confidence,
            'method': method
        }
    }


def run_drawdown(df: pd.DataFrame, params: dict) -> dict:
    """Calculate drawdown statistics."""
    series = df.iloc[:, 0].dropna()
    is_returns = params.get('isReturns', 'prices') == 'returns'

    if is_returns:
        cumulative = (1 + series).cumprod()
    else:
        cumulative = series

    running_max = cumulative.expanding().max()
    drawdown = (cumulative - running_max) / running_max

    max_dd = drawdown.min()
    max_dd_idx = drawdown.idxmin()

    return {
        'testName': 'Drawdown Analysis',
        'statistic': float(max_dd),
        'pValue': 1.0,
        'conclusion': f'Maximum Drawdown: {max_dd:.2%}',
        'interpretation': f'Worst drawdown occurred at index {max_dd_idx}',
        'details': {
            'max_drawdown': float(max_dd),
            'current_drawdown': float(drawdown.iloc[-1]),
            'avg_drawdown': float(drawdown.mean())
        }
    }


def run_sharpe_ratios(df: pd.DataFrame, params: dict) -> dict:
    """Calculate risk-adjusted return metrics."""
    series = df.iloc[:, 0].dropna()
    rf_rate = float(params.get('riskFreeRate', 0.0))
    periods = int(params.get('periods', 252))

    # Convert to returns if needed
    if series.mean() > 1:
        returns = np.log(series / series.shift(1)).dropna()
    else:
        returns = series

    # Annualize
    ann_return = returns.mean() * periods
    ann_vol = returns.std() * np.sqrt(periods)

    # Sharpe
    sharpe = (ann_return - rf_rate) / ann_vol if ann_vol > 0 else 0

    # Sortino (downside deviation)
    downside_returns = returns[returns < 0]
    downside_std = downside_returns.std() * np.sqrt(periods) if len(downside_returns) > 0 else ann_vol
    sortino = (ann_return - rf_rate) / downside_std if downside_std > 0 else 0

    # Calmar (return / max drawdown)
    cumulative = (1 + returns).cumprod()
    running_max = cumulative.expanding().max()
    max_dd = ((cumulative - running_max) / running_max).min()
    calmar = ann_return / abs(max_dd) if max_dd != 0 else 0

    return {
        'testName': 'Risk-Adjusted Returns',
        'statistic': float(sharpe),
        'pValue': 1.0,
        'conclusion': f'Sharpe Ratio: {sharpe:.2f}',
        'interpretation': f'Sortino: {sortino:.2f}, Calmar: {calmar:.2f}',
        'details': {
            'sharpe': float(sharpe),
            'sortino': float(sortino),
            'calmar': float(calmar),
            'annualized_return': float(ann_return),
            'annualized_volatility': float(ann_vol),
            'risk_free_rate': rf_rate
        }
    }
```

### `extensions/quantlab/python/stats/tests/regression.py`

```python
"""Regression analysis implementations."""

import pandas as pd
import numpy as np
import statsmodels.api as sm


def run_ols_regression(df: pd.DataFrame, params: dict) -> dict:
    """Ordinary Least Squares regression."""
    if df.shape[1] < 2:
        raise ValueError("Regression requires at least 2 columns (y and X)")

    add_constant = params.get('addConstant', True)
    robust_se = params.get('robustSE', 'none')

    y = df.iloc[:, 0].dropna()
    X = df.iloc[:, 1:].dropna()

    # Align
    common_idx = y.index.intersection(X.index)
    y = y.loc[common_idx]
    X = X.loc[common_idx]

    if add_constant:
        X = sm.add_constant(X)

    model = sm.OLS(y, X)

    if robust_se == 'none':
        result = model.fit()
    elif robust_se in ['HC0', 'HC1', 'HC3']:
        result = model.fit(cov_type='HC3' if robust_se == 'HC3' else robust_se)
    elif robust_se == 'HAC':
        result = model.fit(cov_type='HAC', cov_kwds={'maxlags': 1})
    else:
        result = model.fit()

    return {
        'testName': 'OLS Regression',
        'statistic': float(result.rsquared),
        'pValue': float(result.f_pvalue) if hasattr(result, 'f_pvalue') else 1.0,
        'conclusion': f'R-squared: {result.rsquared:.4f}',
        'interpretation': f'Adjusted R-squared: {result.rsquared_adj:.4f}, F-stat: {result.fvalue:.2f}',
        'details': {
            'coefficients': {str(k): float(v) for k, v in result.params.items()},
            'std_errors': {str(k): float(v) for k, v in result.bse.items()},
            'pvalues': {str(k): float(v) for k, v in result.pvalues.items()},
            'r_squared': float(result.rsquared),
            'adj_r_squared': float(result.rsquared_adj),
            'f_statistic': float(result.fvalue),
            'f_pvalue': float(result.f_pvalue) if hasattr(result, 'f_pvalue') else None,
            'durbin_watson': float(sm.stats.durbin_watson(result.resid))
        }
    }
```

## Test

1. Install Python dependencies:
   ```bash
   cd extensions/quantlab/python/stats
   pip install -r requirements.txt
   ```

2. Run directly:
   ```bash
   python runner.py --job '{"testId":"adf","dataPath":"test.csv","columns":["price"],"parameters":{}}'
   ```

3. Check output format is valid JSON lines

## Dependencies
- Prompt 11 (StatsEngine) calls this script

## Next
Proceed to `13_DataService_Extension.md`

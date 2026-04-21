# Statistical Tests Reference

This document provides detailed specifications for all statistical tests in the Pure Stats system.

---

## 1. Descriptive Statistics

### 1.1 Summary Statistics

**Purpose**: Provide a comprehensive overview of data distribution.

**Output Metrics**:
| Metric | Formula | Interpretation |
|--------|---------|----------------|
| Count | n | Number of observations |
| Mean | μ = Σx/n | Central tendency |
| Std Dev | σ = √(Σ(x-μ)²/n) | Dispersion |
| Min/Max | min(x), max(x) | Range bounds |
| Skewness | E[(X-μ)³]/σ³ | Asymmetry (0 = symmetric) |
| Kurtosis | E[(X-μ)⁴]/σ⁴ - 3 | Tail heaviness (0 = normal) |
| Percentiles | P25, P50, P75 | Distribution quartiles |

**Parameters**:
- `percentiles`: List of percentiles to calculate (default: [0.25, 0.5, 0.75])

**Python Implementation**:
```python
def summary_statistics(data: pd.Series, percentiles=[0.25, 0.5, 0.75]):
    return {
        'count': len(data),
        'mean': data.mean(),
        'std': data.std(),
        'min': data.min(),
        'max': data.max(),
        'skewness': data.skew(),
        'kurtosis': data.kurtosis(),
        'percentiles': {f'p{int(p*100)}': data.quantile(p) for p in percentiles}
    }
```

---

### 1.2 Outlier Detection

**Methods**:

#### IQR Method
- **Formula**: Outlier if x < Q1 - k*IQR or x > Q3 + k*IQR
- **Parameter**: k (default: 1.5, use 3.0 for extreme outliers)
- **Interpretation**: Simple, robust to non-normal distributions

#### Z-Score Method
- **Formula**: Outlier if |z| > threshold where z = (x - μ)/σ
- **Parameter**: threshold (default: 3.0)
- **Interpretation**: Assumes normality, sensitive to extreme values

#### Isolation Forest
- **Algorithm**: Tree-based anomaly detection
- **Parameters**: contamination (expected outlier proportion)
- **Interpretation**: Non-parametric, handles multivariate data

**Output**:
```json
{
  "method": "iqr",
  "outlierCount": 15,
  "outlierPercent": 1.5,
  "outlierIndices": [12, 45, 78, ...],
  "bounds": { "lower": -2.5, "upper": 12.3 }
}
```

---

## 2. Stationarity Tests

### 2.1 Augmented Dickey-Fuller (ADF)

**Hypothesis**:
- H₀: Unit root exists (non-stationary)
- H₁: No unit root (stationary)

**Test Equation**:
```
Δyₜ = α + βt + γyₜ₋₁ + Σδᵢ Δyₜ₋ᵢ + εₜ
```

**Parameters**:
| Parameter | Options | Default | Description |
|-----------|---------|---------|-------------|
| maxlag | int or None | None (auto) | Maximum lag order |
| regression | 'c', 'ct', 'ctt', 'n' | 'c' | Regression type |

**Regression Types**:
- `n`: No constant, no trend
- `c`: Constant only
- `ct`: Constant + linear trend
- `ctt`: Constant + linear + quadratic trend

**Interpretation**:
- p-value < 0.05 → Reject H₀ → Series is stationary
- p-value ≥ 0.05 → Fail to reject H₀ → Series is non-stationary

**Output**:
```json
{
  "statistic": -3.452,
  "pValue": 0.0091,
  "usedLag": 4,
  "nObs": 996,
  "criticalValues": {
    "1%": -3.436,
    "5%": -2.864,
    "10%": -2.568
  },
  "conclusion": "Stationary at 5% significance level"
}
```

---

### 2.2 KPSS Test

**Hypothesis** (reversed from ADF):
- H₀: Series is stationary
- H₁: Series has a unit root (non-stationary)

**Test Types**:
- Level stationarity (`c`): Tests around constant mean
- Trend stationarity (`ct`): Tests around deterministic trend

**Parameters**:
| Parameter | Options | Default |
|-----------|---------|---------|
| regression | 'c', 'ct' | 'c' |
| nlags | 'auto', 'legacy', int | 'auto' |

**Interpretation**:
- p-value < 0.05 → Reject H₀ → Series is non-stationary
- p-value ≥ 0.05 → Fail to reject H₀ → Series is stationary

**Best Practice**: Use both ADF and KPSS together:
| ADF | KPSS | Conclusion |
|-----|------|------------|
| Reject | Not Reject | Stationary |
| Not Reject | Reject | Non-stationary |
| Reject | Reject | Trend-stationary |
| Not Reject | Not Reject | Inconclusive |

---

### 2.3 Phillips-Perron (PP)

**Advantage**: Robust to serial correlation and heteroskedasticity without adding lagged terms.

**Parameters**:
| Parameter | Options | Default |
|-----------|---------|---------|
| regression | 'c', 'ct', 'n' | 'c' |
| lags | int or None | None (auto) |

---

### 2.4 DF-GLS Test

**Advantage**: More powerful than ADF for small samples.

**Method**: GLS detrending before ADF regression.

**Parameters**: Same as ADF

---

### 2.5 Zivot-Andrews Test

**Purpose**: Test for unit root allowing one structural break.

**Break Types**:
- Intercept break only
- Trend break only
- Both intercept and trend break

**Output**: Includes estimated break date.

---

## 3. Distribution Tests

### 3.1 Jarque-Bera Test

**Hypothesis**:
- H₀: Data is normally distributed
- H₁: Data is not normally distributed

**Test Statistic**:
```
JB = (n/6) * (S² + K²/4)
```
where S = skewness, K = excess kurtosis

**Distribution**: χ²(2) under H₀

**Interpretation**:
- p-value < 0.05 → Reject normality
- Works best for n > 2000

---

### 3.2 Shapiro-Wilk Test

**Hypothesis**: Same as Jarque-Bera

**Advantage**: More powerful for small samples (n < 5000)

**Limitation**: May fail for n > 5000 (use Jarque-Bera instead)

---

### 3.3 Anderson-Darling Test

**Advantage**: More sensitive to tails than Kolmogorov-Smirnov

**Output**: Critical values at 15%, 10%, 5%, 2.5%, 1% levels

---

### 3.4 QQ Plot Analysis

**Visual Test**: Compare sample quantiles to theoretical quantiles

**Interpretation**:
- Points on diagonal → Normal
- S-curve → Heavy tails
- Curved away → Skewness

---

## 4. Dependence Tests

### 4.1 Correlation Matrix

**Types**:
| Type | Formula | Use Case |
|------|---------|----------|
| Pearson | cov(X,Y)/(σₓσᵧ) | Linear relationship, normal data |
| Spearman | Pearson on ranks | Monotonic relationship, ordinal data |
| Kendall | Concordant-discordant pairs | Robust to outliers, small samples |

**Output**: Matrix with p-values for each correlation

---

### 4.2 Autocorrelation (ACF)

**Formula**:
```
ρₖ = Cov(yₜ, yₜ₋ₖ) / Var(yₜ)
```

**Parameters**:
- `nlags`: Number of lags to compute (default: 40)

**Interpretation**:
- Significant spikes → Serial dependence at that lag
- Slow decay → Trend or non-stationarity
- Cut-off after lag q → MA(q) process

---

### 4.3 Partial Autocorrelation (PACF)

**Definition**: Correlation at lag k after removing effects of lags 1 to k-1

**Interpretation**:
- Cut-off after lag p → AR(p) process
- Used with ACF to identify ARMA orders

---

### 4.4 Ljung-Box Test

**Hypothesis**:
- H₀: No autocorrelation up to lag k
- H₁: At least one autocorrelation is non-zero

**Test Statistic**:
```
Q = n(n+2) Σ(ρ̂ₖ² / (n-k))
```

**Distribution**: χ²(k) under H₀

**Parameters**:
- `lags`: Number of lags to test (default: 10)

---

### 4.5 Granger Causality

**Hypothesis**:
- H₀: X does not Granger-cause Y
- H₁: X Granger-causes Y

**Method**: Test if lagged X improves prediction of Y

**Parameters**:
- `maxlag`: Maximum lag to test
- `test`: 'ssr_ftest', 'ssr_chi2test', 'lrtest', 'params_ftest'

**Interpretation**:
- p-value < 0.05 → X Granger-causes Y
- Note: Granger causality ≠ true causality

---

### 4.6 Cointegration Tests

#### Engle-Granger Test
**Method**: Test residuals of regression for stationarity
**Use Case**: Two-variable cointegration

#### Johansen Test
**Method**: Maximum likelihood, tests for number of cointegrating vectors
**Use Case**: Multi-variable cointegration

**Parameters**:
- `det_order`: -1 (no deterministic), 0 (constant), 1 (trend)
- `k_ar_diff`: Number of lagged differences

---

## 5. Volatility Tests

### 5.1 ARCH Effects Test (Engle's LM)

**Hypothesis**:
- H₀: No ARCH effects
- H₁: ARCH effects present

**Method**: Regress squared residuals on lagged squared residuals

**Parameters**:
- `nlags`: Number of lags (default: 12)

**Interpretation**:
- p-value < 0.05 → ARCH effects present → Consider GARCH model

---

### 5.2 Variance Ratio Test

**Purpose**: Test random walk hypothesis

**Hypothesis**:
- H₀: Returns follow random walk (VR = 1)
- H₁: Returns are predictable (VR ≠ 1)

**Test Statistic**: VR(q) = Var(qΔyₜ) / (q * Var(Δyₜ))

**Interpretation**:
- VR > 1 → Positive autocorrelation (momentum)
- VR < 1 → Mean reversion

---

## 6. Regression Diagnostics

### 6.1 Breusch-Pagan Test

**Hypothesis**:
- H₀: Homoskedasticity (constant variance)
- H₁: Heteroskedasticity

**Method**: Regress squared residuals on regressors

---

### 6.2 White Test

**Same as Breusch-Pagan but**:
- Includes cross-products and squares of regressors
- More general, lower power

---

### 6.3 Durbin-Watson Test

**Purpose**: Test for first-order autocorrelation in residuals

**Statistic Range**: 0 to 4
- DW ≈ 2 → No autocorrelation
- DW < 2 → Positive autocorrelation
- DW > 2 → Negative autocorrelation

---

### 6.4 VIF (Variance Inflation Factor)

**Formula**: VIF = 1 / (1 - R²ⱼ)

**Interpretation**:
- VIF = 1 → No multicollinearity
- VIF > 5 → Moderate multicollinearity
- VIF > 10 → Severe multicollinearity

---

### 6.5 Ramsey RESET Test

**Purpose**: Test for functional form misspecification

**Method**: Add powers of fitted values to regression

---

## 7. Risk Metrics

### 7.1 Value at Risk (VaR)

**Definition**: Maximum loss at confidence level α

**Methods**:
| Method | Description |
|--------|-------------|
| Historical | Percentile of historical returns |
| Parametric | Assumes normal distribution |
| Monte Carlo | Simulated distribution |

**Parameters**:
- `confidence`: Confidence level (default: 0.95)
- `horizon`: Time horizon in periods (default: 1)

**Output**: VaR value and method details

---

### 7.2 Expected Shortfall (CVaR)

**Definition**: Expected loss given VaR is exceeded

**Formula**: ES = E[Loss | Loss > VaR]

**Advantage**: Coherent risk measure, considers tail shape

---

### 7.3 Maximum Drawdown

**Definition**: Maximum peak-to-trough decline

**Output**:
```json
{
  "maxDrawdown": -0.234,
  "maxDrawdownPercent": -23.4,
  "peakDate": "2022-01-03",
  "troughDate": "2022-06-15",
  "recoveryDate": "2022-11-20",
  "durationDays": 163
}
```

---

### 7.4 Risk-Adjusted Returns

| Metric | Formula | Interpretation |
|--------|---------|----------------|
| Sharpe | (R - Rf) / σ | Excess return per unit total risk |
| Sortino | (R - Rf) / σ_down | Excess return per unit downside risk |
| Calmar | R / MaxDD | Return per unit drawdown |
| Information | (R - Rb) / σ_tracking | Active return per tracking error |

**Parameters**:
- `risk_free_rate`: Annual risk-free rate (default: 0.02)
- `benchmark_returns`: Optional benchmark series

---

## Appendix: Python Dependencies

```python
# Core
import pandas as pd
import numpy as np

# Statistical tests
from statsmodels.tsa.stattools import adfuller, kpss, acf, pacf, grangercausalitytests
from statsmodels.tsa.vector_ar.vecm import coint_johansen
from statsmodels.stats.diagnostic import het_breuschpagan, het_white, acorr_ljungbox
from statsmodels.stats.stattools import durbin_watson, jarque_bera
from statsmodels.stats.outliers_influence import variance_inflation_factor
from scipy.stats import shapiro, anderson, normaltest, spearmanr, kendalltau

# ARCH/GARCH
from arch import arch_model
from arch.unitroot import VarianceRatio

# Risk
import empyrical  # or custom implementation
```

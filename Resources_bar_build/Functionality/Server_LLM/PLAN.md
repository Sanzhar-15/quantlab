# Resources Functionality — Server-Side Plan (Server LLM)

## Context

QuantLab is a VS Code fork for quantitative traders. Its **Resources panel** displays ~566 quantitative analysis tools. The QuantLab client extension currently executes 15 statistical tests locally via Python subprocesses. We are moving computation to the **Delta Plus Server** so it can execute tool computations centrally, support server-sourced market data, and keep the client lightweight.

**Your job**: Implement server-side tool execution endpoints and computation modules for the 15 currently-implemented tools.

**Server stack**: Python, FastAPI (or equivalent), running at `http://localhost:8080`. All responses use the wrapper format `{ "success": true, "data": <payload> }`. All endpoints require `Authorization: Bearer <access_token>` from the login flow.

---

## Existing Server Endpoints (already implemented)

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/v1/auth/login` | Authenticate → returns `access_token` |
| POST | `/v1/auth/refresh` | Refresh token |
| GET | `/v1/symbols` | List all symbols |
| GET | `/v1/bars/{symbol}` | Historical OHLCV bars (`?timeframe=1h&limit=500`) |
| GET/POST/PUT/DELETE | `/v1/watchlists` | Watchlist CRUD |
| GET/POST/PUT/DELETE | `/v1/alerts` | Alert CRUD |
| GET | `/v1/resources/catalog` | Full tool catalog (~566 tools) |
| GET | `/v1/resources/tools/{toolId}` | Tool detail with parameters |
| Various | `/v1/demo/*` | Demo playback control |
| GET | `ws://localhost:8080/ws?token=<token>` | WebSocket for real-time quotes |

---

## New Endpoints to Implement

### 1. `POST /v1/tools/execute` — Submit Tool Execution

**Request body:**

For server-sourced data (user selected a symbol in QuantLab):
```json
{
  "tool_id": "augmented-dickey-fuller",
  "data_source": {
    "kind": "server",
    "symbol": "AAPL",
    "timeframe": "1h"
  },
  "columns": ["close"],
  "parameters": {
    "regression": "c",
    "maxlag": null
  }
}
```

For client-uploaded data (user opened a local CSV/Parquet file):
```json
{
  "tool_id": "augmented-dickey-fuller",
  "data_source": {
    "kind": "inline",
    "format": "csv",
    "data": "<base64-encoded file content>",
    "filename": "portfolio.csv"
  },
  "columns": ["close"],
  "parameters": {
    "regression": "c",
    "maxlag": null
  }
}
```

**Response — synchronous (for fast tools, <2s):**
```json
{
  "success": true,
  "data": {
    "job_id": "job-a1b2c3d4e5f6",
    "status": "complete",
    "result": {
      "test_id": "augmented-dickey-fuller",
      "test_name": "Augmented Dickey-Fuller Test",
      "statistic": -3.456,
      "p_value": 0.0089,
      "critical_values": {
        "1%": -3.43,
        "5%": -2.86,
        "10%": -2.57
      },
      "conclusion": "Series is stationary (reject unit root)",
      "interpretation": "ADF statistic: -3.4560. P-value: 0.0089. With regression type \"c\", used 4 lags.",
      "details": {
        "used_lag": 4,
        "n_observations": 248,
        "ic_best": -1234.56,
        "regression": "c"
      },
      "visualizations": []
    }
  }
}
```

**Response — asynchronous (for slow tools):**
```json
{
  "success": true,
  "data": {
    "job_id": "job-d4e5f6a7b8c9",
    "status": "queued"
  }
}
```

**Decision logic**: Tools in `SYNC_TOOLS` set execute inline. Others are queued for async execution.

---

### 2. `GET /v1/tools/{jobId}/status` — Poll Job Status

**Response:**
```json
{
  "success": true,
  "data": {
    "job_id": "job-d4e5f6a7b8c9",
    "status": "running",
    "progress": 45,
    "message": "Running Monte Carlo simulation (4500/10000 iterations)"
  }
}
```

`status` values: `queued` | `running` | `complete` | `failed` | `cancelled`

---

### 3. `GET /v1/tools/{jobId}/result` — Get Completed Result

Only valid when `status === 'complete'`. Returns the same `result` object as the synchronous execute response.

**Response:**
```json
{
  "success": true,
  "data": {
    "test_id": "value-at-risk",
    "test_name": "Value at Risk",
    "statistic": -0.0234,
    "p_value": null,
    "critical_values": null,
    "conclusion": "95% VaR: -2.34%",
    "interpretation": "With 95% confidence, the maximum expected loss is 2.34%",
    "details": {
      "var": -0.0234,
      "confidence": 0.95,
      "method": "historical"
    },
    "visualizations": []
  }
}
```

Returns HTTP 400 if job status is not `complete`.
Returns HTTP 404 if job not found (expired or never existed).

---

### 4. `DELETE /v1/tools/{jobId}` — Cancel Running Job

**Response:**
```json
{
  "success": true,
  "data": {
    "job_id": "job-d4e5f6a7b8c9",
    "status": "cancelled"
  }
}
```

---

### 5. WebSocket Job Events

When a client is connected via `ws://localhost:8080/ws?token=<token>`, push job progress alongside existing quote messages:

**Progress event:**
```json
{
  "type": "job-progress",
  "job_id": "job-d4e5f6a7b8c9",
  "progress": 67,
  "message": "Computing Expected Shortfall..."
}
```

**Completion event:**
```json
{
  "type": "job-complete",
  "job_id": "job-d4e5f6a7b8c9"
}
```

The client fetches the full result via the REST endpoint after receiving `job-complete`.

---

### 6. `GET /v1/resources/tools/{toolId}` — Verify Full Schema

This endpoint likely already exists. Ensure it returns `required_columns` and `parameters` for all 15 implemented tools. See the full parameter schemas in the **Parameter Schemas** section below.

---

## Server Architecture

```
app/
  api/v1/
    tools.py                 # Route handlers for /v1/tools/*
  services/
    tool_executor.py         # Orchestrates sync/async execution
    job_store.py             # In-memory job storage with TTL
  compute/
    __init__.py
    registry.py              # Maps tool_id → handler function
    descriptive.py           # summary-statistics, returns-analysis, rolling-statistics
    stationarity.py          # augmented-dickey-fuller, kpss, phillips-perron
    distribution.py          # jarque-bera, shapiro-wilk, anderson-darling
    dependence.py            # pearson-correlation, acf-pacf, ljung-box
    risk.py                  # value-at-risk, expected-shortfall, sharpe-ratio
  models/
    tool_execution.py        # Pydantic models for request/response
```

---

## Implementation Steps

### Step 1: Pydantic Models (`models/tool_execution.py`)

```python
from pydantic import BaseModel, Field
from typing import Optional, Any, Literal, Union
from enum import Enum
from datetime import datetime
import uuid


class DataSourceServer(BaseModel):
    kind: Literal["server"]
    symbol: str
    timeframe: str


class DataSourceInline(BaseModel):
    kind: Literal["inline"]
    format: str    # "csv", "parquet", "xlsx"
    data: str      # base64-encoded file content
    filename: str


class ToolExecuteRequest(BaseModel):
    tool_id: str
    data_source: Union[DataSourceServer, DataSourceInline] = Field(discriminator="kind")
    columns: list[str] = []
    parameters: dict[str, Any] = {}


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETE = "complete"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ToolResult(BaseModel):
    test_id: str
    test_name: str
    statistic: float
    p_value: Optional[float] = None
    critical_values: Optional[dict[str, float]] = None
    conclusion: str
    interpretation: str
    details: dict[str, Any] = {}
    visualizations: list[dict] = []


class ToolJob(BaseModel):
    job_id: str
    status: JobStatus
    progress: Optional[float] = None
    message: Optional[str] = None
    result: Optional[ToolResult] = None
    error: Optional[str] = None
    created_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
```

---

### Step 2: Job Store (`services/job_store.py`)

In-memory store with TTL cleanup. Simple dict-based — no external database needed.

```python
import threading
import time
from typing import Optional
from models.tool_execution import ToolJob, JobStatus, ToolResult


class JobStore:
    """In-memory job storage with automatic TTL expiration."""

    def __init__(self, ttl_seconds: int = 1800):  # 30 minutes
        self._jobs: dict[str, ToolJob] = {}
        self._ttl = ttl_seconds
        self._lock = threading.Lock()

    def create(self, job_id: str) -> ToolJob:
        job = ToolJob(job_id=job_id, status=JobStatus.QUEUED)
        with self._lock:
            self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Optional[ToolJob]:
        with self._lock:
            return self._jobs.get(job_id)

    def update_progress(self, job_id: str, progress: float, message: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job and job.status in (JobStatus.QUEUED, JobStatus.RUNNING):
                job.status = JobStatus.RUNNING
                job.progress = progress
                job.message = message

    def complete(self, job_id: str, result: ToolResult) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.status = JobStatus.COMPLETE
                job.progress = 100
                job.result = result

    def fail(self, job_id: str, error: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job:
                job.status = JobStatus.FAILED
                job.error = error

    def cancel(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job and job.status in (JobStatus.QUEUED, JobStatus.RUNNING):
                job.status = JobStatus.CANCELLED

    def cleanup_expired(self) -> int:
        """Remove jobs older than TTL. Returns count of removed jobs."""
        now = time.time()
        removed = 0
        with self._lock:
            expired = [
                jid for jid, job in self._jobs.items()
                if (now - time.mktime(time.strptime(job.created_at[:19], "%Y-%m-%dT%H:%M:%S"))) > self._ttl
            ]
            for jid in expired:
                del self._jobs[jid]
                removed += 1
        return removed
```

---

### Step 3: Compute Modules (5 files)

Port from the existing client-side Python at:
- `extensions/quantlab/python/stats/runner.py` (lines 56-278)
- `extensions/quantlab/python/stats/tests/stationarity.py`
- `extensions/quantlab/python/stats/tests/descriptive.py`

**Each handler signature**: `(df: pd.DataFrame, parameters: dict) -> ToolResult`

The key difference from existing code: results must use `ToolResult` model with `snake_case` field names.

#### `compute/descriptive.py`

```python
import pandas as pd
import numpy as np
from scipy import stats as scipy_stats
from models.tool_execution import ToolResult


def summary_statistics(df: pd.DataFrame, parameters: dict) -> ToolResult:
    """Comprehensive summary: mean, std, skewness, kurtosis, percentiles."""
    percentiles = parameters.get("percentiles", [0.05, 0.25, 0.5, 0.75, 0.95])

    col_results = {}
    for col in df.columns:
        s = df[col].dropna()
        col_results[col] = {
            "count": int(len(s)),
            "mean": float(s.mean()),
            "std": float(s.std()),
            "min": float(s.min()),
            "max": float(s.max()),
            "skewness": float(scipy_stats.skew(s)),
            "kurtosis": float(scipy_stats.kurtosis(s)),
            "percentiles": {f"{p*100:.0f}%": float(s.quantile(p)) for p in percentiles},
        }

    return ToolResult(
        test_id="summary-statistics",
        test_name="Summary Statistics",
        statistic=float(df.iloc[:, 0].mean()),
        p_value=None,
        conclusion=f"Summary computed for {len(df.columns)} column(s)",
        interpretation=f"Sample size: {len(df)}. See details for full statistics.",
        details=col_results,
    )


def returns_analysis(df: pd.DataFrame, parameters: dict) -> ToolResult:
    """Log/simple/cumulative returns analysis."""
    col = df.iloc[:, 0].dropna()
    return_type = parameters.get("returnType", "log")

    if return_type in ("log", "both"):
        log_returns = np.log(col / col.shift(1)).dropna()
    if return_type in ("simple", "both"):
        simple_returns = col.pct_change().dropna()

    returns = log_returns if return_type != "simple" else simple_returns
    ret_name = "Log Returns" if return_type == "log" else "Simple Returns" if return_type == "simple" else "Log Returns"
    cum_returns = (1 + returns).cumprod() - 1

    return ToolResult(
        test_id="returns-analysis",
        test_name="Returns Analysis",
        statistic=float(returns.mean()),
        p_value=None,
        conclusion=f"{ret_name}: Mean={returns.mean()*100:.4f}%, Std={returns.std()*100:.4f}%",
        interpretation=f"Total return: {cum_returns.iloc[-1]*100:.2f}%",
        details={
            "mean": float(returns.mean()),
            "std": float(returns.std()),
            "skewness": float(scipy_stats.skew(returns)),
            "kurtosis": float(scipy_stats.kurtosis(returns)),
            "total_return": float(cum_returns.iloc[-1]),
        },
    )


def rolling_statistics(df: pd.DataFrame, parameters: dict) -> ToolResult:
    """Rolling mean, std, min, max."""
    window = parameters.get("window", 20)
    stats_type = parameters.get("stats", "mean_std")
    col = df.iloc[:, 0].dropna()

    details = {"window": window}
    if stats_type in ("mean", "mean_std", "all"):
        details["rolling_mean"] = col.rolling(window=window).mean().dropna().tolist()
    if stats_type in ("std", "mean_std", "all"):
        details["rolling_std"] = col.rolling(window=window).std().dropna().tolist()
    if stats_type == "all":
        details["rolling_min"] = col.rolling(window=window).min().dropna().tolist()
        details["rolling_max"] = col.rolling(window=window).max().dropna().tolist()

    return ToolResult(
        test_id="rolling-statistics",
        test_name="Rolling Statistics",
        statistic=float(col.rolling(window=window).mean().iloc[-1]),
        p_value=None,
        conclusion=f"Rolling {stats_type} computed with window={window}",
        interpretation=f"Window size: {window} periods",
        details=details,
    )
```

#### `compute/stationarity.py`

```python
import pandas as pd
import numpy as np
from statsmodels.tsa.stattools import adfuller, kpss
from models.tool_execution import ToolResult


def adf_test(df: pd.DataFrame, parameters: dict) -> ToolResult:
    col = df.iloc[:, 0].dropna()
    regression = parameters.get("regression", "c")
    maxlag = parameters.get("maxlag")

    stat, pvalue, usedlag, nobs, critical_values, icbest = adfuller(
        col, regression=regression, maxlag=maxlag
    )
    is_stationary = pvalue < 0.05

    return ToolResult(
        test_id="augmented-dickey-fuller",
        test_name="Augmented Dickey-Fuller Test",
        statistic=float(stat),
        p_value=float(pvalue),
        critical_values={k: float(v) for k, v in critical_values.items()},
        conclusion="Series is stationary (reject unit root)" if is_stationary
                   else "Series has unit root (non-stationary)",
        interpretation=f'ADF statistic: {stat:.4f}. P-value: {pvalue:.4f}. '
                       f'Regression type "{regression}", used {usedlag} lags.',
        details={"used_lag": int(usedlag), "n_observations": int(nobs),
                 "ic_best": float(icbest), "regression": regression},
    )


def kpss_test(df: pd.DataFrame, parameters: dict) -> ToolResult:
    col = df.iloc[:, 0].dropna()
    regression = parameters.get("regression", "c")
    nlags = parameters.get("nlags", "auto")

    if nlags == "legacy":
        nlags = int(np.sqrt(len(col)))
    elif nlags == "auto":
        nlags = None

    stat, pvalue, usedlag, critical_values = kpss(col, regression=regression, nlags=nlags)
    is_stationary = pvalue > 0.05

    return ToolResult(
        test_id="kpss",
        test_name="KPSS Test",
        statistic=float(stat),
        p_value=float(pvalue),
        critical_values={k: float(v) for k, v in critical_values.items()},
        conclusion="Series is stationary (cannot reject)" if is_stationary
                   else "Series is non-stationary (reject stationarity)",
        interpretation=f"KPSS statistic: {stat:.4f}. P-value: {pvalue:.4f}. "
                       "Note: KPSS null hypothesis is stationarity.",
        details={"used_lag": int(usedlag), "regression": regression},
    )


def pp_test(df: pd.DataFrame, parameters: dict) -> ToolResult:
    col = df.iloc[:, 0].dropna()
    regression = parameters.get("regression", "c")

    stat, pvalue, usedlag, nobs, critical_values, icbest = adfuller(
        col, regression=regression, autolag="t-stat"
    )
    is_stationary = pvalue < 0.05

    return ToolResult(
        test_id="phillips-perron",
        test_name="Phillips-Perron Test",
        statistic=float(stat),
        p_value=float(pvalue),
        critical_values={k: float(v) for k, v in critical_values.items()},
        conclusion="Series is stationary (reject unit root)" if is_stationary
                   else "Series has unit root (non-stationary)",
        interpretation=f"PP statistic: {stat:.4f}. P-value: {pvalue:.4f}.",
        details={"used_lag": int(usedlag), "n_observations": int(nobs), "regression": regression},
    )
```

#### `compute/distribution.py`

```python
import pandas as pd
from scipy import stats as scipy_stats
from models.tool_execution import ToolResult


def jarque_bera(df: pd.DataFrame, parameters: dict) -> ToolResult:
    col = df.iloc[:, 0].dropna()
    stat, p = scipy_stats.jarque_bera(col)

    return ToolResult(
        test_id="jarque-bera",
        test_name="Jarque-Bera Normality Test",
        statistic=float(stat),
        p_value=float(p),
        conclusion="Data is likely non-normal" if p < 0.05 else "Cannot reject normality",
        interpretation=f"Jarque-Bera statistic: {stat:.4f}, p-value: {p:.4f}. "
                       "Tests whether sample skewness and kurtosis match a normal distribution.",
        details={"skewness": float(scipy_stats.skew(col)), "kurtosis": float(scipy_stats.kurtosis(col))},
    )


def shapiro_wilk(df: pd.DataFrame, parameters: dict) -> ToolResult:
    col = df.iloc[:, 0].dropna().head(5000)  # Shapiro-Wilk max 5000 samples
    stat, p = scipy_stats.shapiro(col)

    return ToolResult(
        test_id="shapiro-wilk",
        test_name="Shapiro-Wilk Normality Test",
        statistic=float(stat),
        p_value=float(p),
        conclusion="Data is likely non-normal" if p < 0.05 else "Cannot reject normality",
        interpretation=f"Shapiro-Wilk statistic: {stat:.4f}, p-value: {p:.4f}. "
                       f"Sample size: {len(col)}.",
        details={"sample_size": len(col)},
    )


def anderson_darling(df: pd.DataFrame, parameters: dict) -> ToolResult:
    col = df.iloc[:, 0].dropna()
    result = scipy_stats.anderson(col, dist="norm")

    # Anderson-Darling doesn't return a p-value directly; use critical values
    critical_values = {
        f"{sl}%": float(cv) for sl, cv in zip(result.significance_level, result.critical_values)
    }

    # Determine significance at 5% level
    idx_5 = list(result.significance_level).index(5.0) if 5.0 in result.significance_level else 2
    is_normal = result.statistic < result.critical_values[idx_5]

    return ToolResult(
        test_id="anderson-darling",
        test_name="Anderson-Darling Normality Test",
        statistic=float(result.statistic),
        p_value=None,  # AD test doesn't produce a p-value
        critical_values=critical_values,
        conclusion="Cannot reject normality" if is_normal else "Data is likely non-normal",
        interpretation=f"Anderson-Darling statistic: {result.statistic:.4f}. "
                       f"Critical value at 5%: {result.critical_values[idx_5]:.4f}.",
        details={"significance_levels": list(result.significance_level)},
    )
```

#### `compute/dependence.py`

```python
import pandas as pd
import numpy as np
from models.tool_execution import ToolResult


def pearson_correlation(df: pd.DataFrame, parameters: dict) -> ToolResult:
    method = parameters.get("method", "pearson")

    if method == "all":
        details = {
            "pearson": df.corr(method="pearson").to_dict(),
            "spearman": df.corr(method="spearman").to_dict(),
        }
        corr = df.corr(method="pearson")
    else:
        corr = df.corr(method=method)
        details = {"correlation": corr.to_dict()}

    return ToolResult(
        test_id="pearson-correlation",
        test_name="Correlation Matrix",
        statistic=float(corr.values[0, 1]) if corr.shape[0] > 1 else 1.0,
        p_value=None,
        conclusion=f"{method.capitalize()} correlation computed",
        interpretation=f"Correlation matrix computed using {method} method.",
        details=details,
    )


def acf_pacf_analysis(df: pd.DataFrame, parameters: dict) -> ToolResult:
    from statsmodels.tsa.stattools import acf, pacf

    col = df.iloc[:, 0].dropna()
    lags = parameters.get("lags", 40)

    acf_vals = acf(col, nlags=lags)
    pacf_vals = pacf(col, nlags=min(lags, len(col) // 2 - 1))

    return ToolResult(
        test_id="acf-pacf",
        test_name="ACF/PACF Analysis",
        statistic=float(acf_vals[1]),
        p_value=None,
        conclusion="ACF and PACF computed successfully",
        interpretation=f"First-order autocorrelation: {acf_vals[1]:.4f}",
        details={
            "acf": acf_vals.tolist(),
            "pacf": pacf_vals.tolist(),
            "lags": list(range(len(acf_vals))),
        },
    )


def ljung_box(df: pd.DataFrame, parameters: dict) -> ToolResult:
    from statsmodels.stats.diagnostic import acorr_ljungbox

    col = df.iloc[:, 0].dropna()
    lags = parameters.get("lags", 10)

    result = acorr_ljungbox(col, lags=[lags], return_df=True)
    lb_stat = float(result["lb_stat"].values[0])
    lb_p = float(result["lb_pvalue"].values[0])

    return ToolResult(
        test_id="ljung-box",
        test_name="Ljung-Box Test",
        statistic=lb_stat,
        p_value=lb_p,
        conclusion="Serial correlation detected" if lb_p < 0.05
                   else "No significant serial correlation",
        interpretation=f"At lag {lags}: Q-statistic={lb_stat:.4f}, p-value={lb_p:.4f}",
        details={"lag": lags},
    )
```

#### `compute/risk.py`

```python
import pandas as pd
import numpy as np
from scipy import stats as scipy_stats
from models.tool_execution import ToolResult


def value_at_risk(df: pd.DataFrame, parameters: dict) -> ToolResult:
    col = df.iloc[:, 0].dropna()
    confidence = float(parameters.get("confidence", 0.95))
    method = parameters.get("method", "historical")

    returns = col.pct_change().dropna()

    if method == "historical":
        var = float(np.percentile(returns, (1 - confidence) * 100))
    elif method == "parametric":
        var = float(scipy_stats.norm.ppf(1 - confidence, returns.mean(), returns.std()))
    elif method == "cornish-fisher":
        z = scipy_stats.norm.ppf(1 - confidence)
        s = scipy_stats.skew(returns)
        k = scipy_stats.kurtosis(returns)
        z_cf = z + (z**2 - 1) * s / 6 + (z**3 - 3*z) * k / 24 - (2*z**3 - 5*z) * s**2 / 36
        var = float(returns.mean() + z_cf * returns.std())
    else:
        var = float(np.percentile(returns, (1 - confidence) * 100))

    return ToolResult(
        test_id="value-at-risk",
        test_name="Value at Risk",
        statistic=var,
        p_value=None,
        conclusion=f"{confidence*100:.0f}% VaR: {var*100:.2f}%",
        interpretation=f"With {confidence*100:.0f}% confidence, the maximum expected loss is {abs(var)*100:.2f}%",
        details={"var": var, "confidence": confidence, "method": method},
    )


def expected_shortfall(df: pd.DataFrame, parameters: dict) -> ToolResult:
    col = df.iloc[:, 0].dropna()
    confidence = float(parameters.get("confidence", 0.95))

    returns = col.pct_change().dropna()
    var = np.percentile(returns, (1 - confidence) * 100)
    es = float(returns[returns <= var].mean())

    return ToolResult(
        test_id="expected-shortfall",
        test_name="Expected Shortfall",
        statistic=es,
        p_value=None,
        conclusion=f"{confidence*100:.0f}% ES: {es*100:.2f}%",
        interpretation=f"Expected loss given that loss exceeds VaR: {abs(es)*100:.2f}%",
        details={"es": es, "var": float(var), "confidence": confidence},
    )


def risk_adjusted_returns(df: pd.DataFrame, parameters: dict) -> ToolResult:
    col = df.iloc[:, 0].dropna()
    rf = float(parameters.get("riskFreeRate", 0.0))
    periods = int(parameters.get("periods", 252))

    returns = col.pct_change().dropna()
    mean_return = returns.mean() * periods
    std_return = returns.std() * np.sqrt(periods)

    sharpe = (mean_return - rf) / std_return if std_return > 0 else 0

    downside = returns[returns < 0]
    downside_std = downside.std() * np.sqrt(periods) if len(downside) > 0 else 0
    sortino = (mean_return - rf) / downside_std if downside_std > 0 else 0

    return ToolResult(
        test_id="sharpe-ratio",
        test_name="Risk-Adjusted Returns",
        statistic=float(sharpe),
        p_value=None,
        conclusion=f"Sharpe Ratio: {sharpe:.2f}",
        interpretation=f"Annualized return: {mean_return*100:.2f}%, Volatility: {std_return*100:.2f}%",
        details={
            "sharpe": float(sharpe),
            "sortino": float(sortino),
            "annualized_return": float(mean_return),
            "annualized_volatility": float(std_return),
        },
    )
```

---

### Step 4: Compute Registry (`compute/registry.py`)

```python
from typing import Callable
import pandas as pd
from models.tool_execution import ToolResult
from compute import descriptive, stationarity, distribution, dependence, risk

# Handler type: (DataFrame, parameters_dict) -> ToolResult
ToolHandler = Callable[[pd.DataFrame, dict], ToolResult]

TOOL_HANDLERS: dict[str, ToolHandler] = {
    "summary-statistics":       descriptive.summary_statistics,
    "returns-analysis":         descriptive.returns_analysis,
    "rolling-statistics":       descriptive.rolling_statistics,
    "augmented-dickey-fuller":  stationarity.adf_test,
    "kpss":                     stationarity.kpss_test,
    "phillips-perron":          stationarity.pp_test,
    "jarque-bera":              distribution.jarque_bera,
    "shapiro-wilk":             distribution.shapiro_wilk,
    "anderson-darling":         distribution.anderson_darling,
    "pearson-correlation":      dependence.pearson_correlation,
    "acf-pacf":                 dependence.acf_pacf_analysis,
    "ljung-box":                dependence.ljung_box,
    "value-at-risk":            risk.value_at_risk,
    "expected-shortfall":       risk.expected_shortfall,
    "sharpe-ratio":             risk.risk_adjusted_returns,
}

# Tools that complete fast enough for synchronous execution (<2s typically)
SYNC_TOOLS: set[str] = {
    "summary-statistics",
    "returns-analysis",
    "rolling-statistics",
    "augmented-dickey-fuller",
    "kpss",
    "phillips-perron",
    "jarque-bera",
    "shapiro-wilk",
    "anderson-darling",
    "pearson-correlation",
    "acf-pacf",
    "ljung-box",
    "expected-shortfall",
    "sharpe-ratio",
}
# Note: value-at-risk with Monte Carlo method could be slow → async
```

---

### Step 5: Tool Executor Service (`services/tool_executor.py`)

```python
import asyncio
import base64
import io
import uuid
from typing import Optional

import pandas as pd

from models.tool_execution import ToolExecuteRequest, ToolJob, ToolResult, JobStatus
from services.job_store import JobStore
from compute.registry import TOOL_HANDLERS, SYNC_TOOLS


class ToolExecutor:
    def __init__(self, job_store: JobStore, ws_manager=None, bar_store=None):
        self.job_store = job_store
        self.ws_manager = ws_manager  # for WebSocket push
        self.bar_store = bar_store    # for server data source

    async def execute(self, request: ToolExecuteRequest, user_id: str) -> ToolJob:
        handler = TOOL_HANDLERS.get(request.tool_id)
        if not handler:
            raise ValueError(f"Unknown tool: {request.tool_id}")

        job_id = f"job-{uuid.uuid4().hex[:12]}"

        # Load data
        df = await self._load_data(request)

        # Select columns if specified
        if request.columns:
            missing = [c for c in request.columns if c not in df.columns]
            if missing:
                raise ValueError(f"Columns not found in data: {missing}")
            df = df[request.columns]

        if request.tool_id in SYNC_TOOLS:
            # Execute synchronously
            job = self.job_store.create(job_id)
            try:
                result = await asyncio.to_thread(handler, df, request.parameters)
                self.job_store.complete(job_id, result)
            except Exception as e:
                self.job_store.fail(job_id, str(e))
            return self.job_store.get(job_id)
        else:
            # Execute asynchronously
            job = self.job_store.create(job_id)
            asyncio.create_task(
                self._run_async(job_id, handler, df, request.parameters, user_id)
            )
            return job

    async def _run_async(self, job_id, handler, df, parameters, user_id):
        try:
            self.job_store.update_progress(job_id, 0, "Starting...")
            if self.ws_manager:
                await self.ws_manager.send_to_user(user_id, {
                    "type": "job-progress",
                    "job_id": job_id,
                    "progress": 0,
                    "message": "Starting...",
                })

            result = await asyncio.to_thread(handler, df, parameters)

            self.job_store.complete(job_id, result)
            if self.ws_manager:
                await self.ws_manager.send_to_user(user_id, {
                    "type": "job-complete",
                    "job_id": job_id,
                })
        except Exception as e:
            self.job_store.fail(job_id, str(e))

    async def _load_data(self, request: ToolExecuteRequest) -> pd.DataFrame:
        ds = request.data_source

        if ds.kind == "server":
            # Fetch from internal bar storage
            if not self.bar_store:
                raise ValueError("Server data source not available")
            bars = self.bar_store.get_bars(ds.symbol, ds.timeframe)
            return pd.DataFrame(bars)

        elif ds.kind == "inline":
            raw = base64.b64decode(ds.data)
            if ds.format == "csv":
                return pd.read_csv(io.BytesIO(raw))
            elif ds.format == "parquet":
                return pd.read_parquet(io.BytesIO(raw))
            elif ds.format == "xlsx":
                return pd.read_excel(io.BytesIO(raw))
            else:
                raise ValueError(f"Unsupported format: {ds.format}")

        raise ValueError(f"Unknown data source kind: {ds.kind}")
```

---

### Step 6: Route Handlers (`api/v1/tools.py`)

```python
from fastapi import APIRouter, Depends, HTTPException
from models.tool_execution import ToolExecuteRequest, JobStatus
# Import your auth dependency and service singletons

router = APIRouter(prefix="/v1/tools", tags=["tools"])


@router.post("/execute")
async def execute_tool(request: ToolExecuteRequest, user=Depends(get_current_user)):
    executor = get_tool_executor()
    try:
        job = await executor.execute(request, user.id)
        return {"success": True, "data": job.dict(exclude_none=True)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{job_id}/status")
async def get_job_status(job_id: str, user=Depends(get_current_user)):
    job = get_job_store().get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return {
        "success": True,
        "data": {
            "job_id": job.job_id,
            "status": job.status.value,
            "progress": job.progress,
            "message": job.message,
        },
    }


@router.get("/{job_id}/result")
async def get_job_result(job_id: str, user=Depends(get_current_user)):
    job = get_job_store().get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != JobStatus.COMPLETE:
        raise HTTPException(status_code=400, detail=f"Job not complete (status: {job.status.value})")
    return {"success": True, "data": job.result.dict()}


@router.delete("/{job_id}")
async def cancel_job(job_id: str, user=Depends(get_current_user)):
    store = get_job_store()
    store.cancel(job_id)
    return {"success": True, "data": {"job_id": job_id, "status": "cancelled"}}
```

---

### Step 7: WebSocket Extension

Extend the existing WebSocket manager to track connections by user and support sending job events:

```python
class WebSocketManager:
    def __init__(self):
        self._connections: dict[str, list] = {}  # user_id -> [websocket, ...]

    async def connect(self, user_id: str, websocket):
        if user_id not in self._connections:
            self._connections[user_id] = []
        self._connections[user_id].append(websocket)

    async def disconnect(self, user_id: str, websocket):
        if user_id in self._connections:
            self._connections[user_id].remove(websocket)

    async def send_to_user(self, user_id: str, message: dict):
        for ws in self._connections.get(user_id, []):
            try:
                await ws.send_json(message)
            except Exception:
                pass  # connection may have dropped
```

---

### Step 8: Ensure Tool Schema Endpoint

Verify that `GET /v1/resources/tools/{toolId}` returns `required_columns` and `parameters` for all 15 tools.

---

## Parameter Schemas for All 15 Tools

These must be returned by `GET /v1/resources/tools/{toolId}`:

### summary-statistics
```json
{ "required_columns": { "count": "1+", "types": ["float64", "int64"] },
  "parameters": [{ "id": "percentiles", "label": "Percentiles", "type": "array", "default": [0.05, 0.25, 0.5, 0.75, 0.95], "description": "Percentiles to calculate" }] }
```

### returns-analysis
```json
{ "required_columns": { "count": 1, "types": ["float64", "int64"] },
  "parameters": [{ "id": "returnType", "label": "Return Type", "type": "select", "default": "log", "options": [{"value":"log","label":"Log Returns"},{"value":"simple","label":"Simple Returns"},{"value":"both","label":"Both"}] }] }
```

### rolling-statistics
```json
{ "required_columns": { "count": "1+", "types": ["float64", "int64"] },
  "parameters": [{ "id": "window", "label": "Window Size", "type": "number", "default": 20, "min": 5, "max": 500, "description": "Rolling window size in periods" }, { "id": "stats", "label": "Statistics", "type": "select", "default": "mean_std", "options": [{"value":"mean","label":"Mean Only"},{"value":"std","label":"Std Only"},{"value":"mean_std","label":"Mean & Std"},{"value":"all","label":"All (mean, std, min, max)"}] }] }
```

### augmented-dickey-fuller
```json
{ "required_columns": { "count": 1, "types": ["float64", "int64"] },
  "parameters": [{ "id": "regression", "label": "Regression Type", "type": "select", "default": "c", "options": [{"value":"n","label":"No constant"},{"value":"c","label":"Constant only"},{"value":"ct","label":"Constant + trend"},{"value":"ctt","label":"Constant + linear + quadratic trend"}] }, { "id": "maxlag", "label": "Max Lags (auto if empty)", "type": "number", "default": null, "min": 0, "max": 50 }] }
```

### kpss
```json
{ "required_columns": { "count": 1, "types": ["float64", "int64"] },
  "parameters": [{ "id": "regression", "label": "Regression Type", "type": "select", "default": "c", "options": [{"value":"c","label":"Constant (level stationarity)"},{"value":"ct","label":"Constant + trend (trend stationarity)"}] }, { "id": "nlags", "label": "Number of Lags", "type": "select", "default": "auto", "options": [{"value":"auto","label":"Auto (Schwert)"},{"value":"legacy","label":"Legacy (sqrt(n))"}] }] }
```

### phillips-perron
```json
{ "required_columns": { "count": 1, "types": ["float64", "int64"] },
  "parameters": [{ "id": "regression", "label": "Regression Type", "type": "select", "default": "c", "options": [{"value":"n","label":"No constant"},{"value":"c","label":"Constant only"},{"value":"ct","label":"Constant + trend"}] }] }
```

### jarque-bera, shapiro-wilk, anderson-darling
```json
{ "required_columns": { "count": 1, "types": ["float64", "int64"] },
  "parameters": [] }
```

### pearson-correlation
```json
{ "required_columns": { "count": "2+", "types": ["float64", "int64"] },
  "parameters": [{ "id": "method", "label": "Correlation Method", "type": "select", "default": "pearson", "options": [{"value":"pearson","label":"Pearson"},{"value":"spearman","label":"Spearman"},{"value":"kendall","label":"Kendall"},{"value":"all","label":"All methods"}] }] }
```

### acf-pacf
```json
{ "required_columns": { "count": 1, "types": ["float64", "int64"] },
  "parameters": [{ "id": "lags", "label": "Number of Lags", "type": "number", "default": 40, "min": 1, "max": 100 }, { "id": "confidence", "label": "Confidence Level", "type": "select", "default": "0.95", "options": [{"value":"0.90","label":"90%"},{"value":"0.95","label":"95%"},{"value":"0.99","label":"99%"}] }] }
```

### ljung-box
```json
{ "required_columns": { "count": 1, "types": ["float64", "int64"] },
  "parameters": [{ "id": "lags", "label": "Number of Lags", "type": "number", "default": 10, "min": 1, "max": 100, "description": "Number of lags to include in the test" }] }
```

### value-at-risk
```json
{ "required_columns": { "count": 1, "types": ["float64", "int64"] },
  "parameters": [{ "id": "confidence", "label": "Confidence Level", "type": "select", "default": "0.95", "options": [{"value":"0.90","label":"90%"},{"value":"0.95","label":"95%"},{"value":"0.99","label":"99%"}] }, { "id": "method", "label": "Method", "type": "select", "default": "historical", "options": [{"value":"historical","label":"Historical"},{"value":"parametric","label":"Parametric (Normal)"},{"value":"cornish-fisher","label":"Cornish-Fisher"}] }, { "id": "horizon", "label": "Horizon (days)", "type": "number", "default": 1, "min": 1, "max": 30 }] }
```

### expected-shortfall
```json
{ "required_columns": { "count": 1, "types": ["float64", "int64"] },
  "parameters": [{ "id": "confidence", "label": "Confidence Level", "type": "select", "default": "0.95", "options": [{"value":"0.90","label":"90%"},{"value":"0.95","label":"95%"},{"value":"0.99","label":"99%"}] }, { "id": "method", "label": "Method", "type": "select", "default": "historical", "options": [{"value":"historical","label":"Historical"},{"value":"parametric","label":"Parametric"}] }] }
```

### sharpe-ratio
```json
{ "required_columns": { "count": 1, "types": ["float64", "int64"] },
  "parameters": [{ "id": "riskFreeRate", "label": "Risk-Free Rate (annualized)", "type": "number", "default": 0.0, "min": 0, "max": 0.2 }, { "id": "periods", "label": "Periods per Year", "type": "select", "default": "252", "options": [{"value":"252","label":"Daily (252)"},{"value":"52","label":"Weekly (52)"},{"value":"12","label":"Monthly (12)"}] }] }
```

---

## Python Dependencies

```
pandas>=2.0
numpy>=1.24
scipy>=1.11
statsmodels>=0.14
openpyxl>=3.1    # for xlsx
pyarrow>=14.0    # for parquet
```

---

## Constraints

- Inline data uploads: max **50 MB** (base64-encoded)
- Server-side data fetches: max **100,000 bars**
- Job results stored **30 minutes**, then garbage collected
- All endpoints require `Authorization: Bearer <token>`
- All responses wrapped in `{ "success": true, "data": <payload> }`

---

## Implementation Order

1. Pydantic models (Step 1)
2. Job store (Step 2)
3. Compute modules (Step 3) — port existing Python
4. Compute registry (Step 4)
5. Tool executor service (Step 5)
6. Route handlers (Step 6)
7. WebSocket extensions (Step 7)
8. Schema endpoint verification (Step 8)

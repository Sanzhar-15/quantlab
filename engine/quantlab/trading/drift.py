"""
Trade Drift Detection.

Compares backtest execution with live trading to detect discrepancies
that may indicate strategy issues or market condition changes.

Includes statistical hypothesis tests:
- Two-sample t-test for P&L mean comparison
- Chi-squared test for win rate comparison
- Kolmogorov-Smirnov test for distribution comparison

Spec Reference: Technical Spec §12.3 (Safety Layer)
"""

import logging
import math
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timedelta
from decimal import Decimal
from enum import Enum
from typing import Any
from typing import Callable


logger = logging.getLogger(__name__)


# =============================================================================
# Statistical Test Functions (Pure Python - No scipy dependency)
# =============================================================================


def _normal_cdf(x: float) -> float:
    """
    Approximation of the cumulative distribution function for standard normal.

    Uses Abramowitz and Stegun approximation (error < 1.5e-7).
    """
    # Constants
    a1 = 0.254829592
    a2 = -0.284496736
    a3 = 1.421413741
    a4 = -1.453152027
    a5 = 1.061405429
    p = 0.3275911

    # Save the sign
    sign = 1 if x >= 0 else -1
    x = abs(x) / math.sqrt(2)

    # A&S formula 7.1.26
    t = 1.0 / (1.0 + p * x)
    y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * math.exp(-x * x)

    return 0.5 * (1.0 + sign * y)


def _t_distribution_cdf(t: float, df: int) -> float:
    """
    Approximation of the t-distribution CDF using normal approximation for large df.

    For df > 30, uses normal approximation.
    For smaller df, uses a series approximation.
    """
    if df > 30:
        # Normal approximation for large df
        return _normal_cdf(t)

    # For smaller df, use a simple approximation
    # This is a rough approximation but sufficient for our purposes
    x = df / (df + t * t)

    # Use regularized incomplete beta function approximation
    # For our purposes, we'll use a simpler approach
    if t >= 0:
        return 1 - 0.5 * _incomplete_beta(df / 2, 0.5, x)
    else:
        return 0.5 * _incomplete_beta(df / 2, 0.5, x)


def _incomplete_beta(a: float, b: float, x: float) -> float:
    """Simple approximation of regularized incomplete beta function."""
    if x == 0:
        return 0
    if x == 1:
        return 1

    # Use continued fraction approximation
    # This is a simplified version
    bt = math.exp(
        math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b) +
        a * math.log(x) + b * math.log(1 - x)
    )

    if x < (a + 1) / (a + b + 2):
        return bt * _betacf(a, b, x) / a
    else:
        return 1 - bt * _betacf(b, a, 1 - x) / b


def _betacf(a: float, b: float, x: float) -> float:
    """Continued fraction for incomplete beta function."""
    max_iter = 100
    eps = 3e-7

    qab = a + b
    qap = a + 1
    qam = a - 1
    c = 1.0
    d = 1 - qab * x / qap
    if abs(d) < 1e-30:
        d = 1e-30
    d = 1 / d
    h = d

    for m in range(1, max_iter + 1):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < eps:
            break

    return h


def _chi2_cdf(x: float, df: int) -> float:
    """
    Approximation of chi-squared CDF using incomplete gamma function.
    """
    if x <= 0:
        return 0
    return _lower_incomplete_gamma(df / 2, x / 2)


def _lower_incomplete_gamma(a: float, x: float) -> float:
    """
    Regularized lower incomplete gamma function P(a, x).

    Uses series expansion for small x, continued fraction for large x.
    """
    if x < 0 or a <= 0:
        return 0

    if x < a + 1:
        # Series expansion
        return _gamma_series(a, x)
    else:
        # Continued fraction
        return 1 - _gamma_cf(a, x)


def _gamma_series(a: float, x: float) -> float:
    """Series expansion for lower incomplete gamma."""
    max_iter = 100
    eps = 3e-7

    if x == 0:
        return 0

    ap = a
    delta_sum = 1 / a
    total = delta_sum

    for _ in range(max_iter):
        ap += 1
        delta_sum *= x / ap
        total += delta_sum
        if abs(delta_sum) < abs(total) * eps:
            break

    return total * math.exp(-x + a * math.log(x) - math.lgamma(a))


def _gamma_cf(a: float, x: float) -> float:
    """Continued fraction for upper incomplete gamma."""
    max_iter = 100
    eps = 3e-7

    b = x + 1 - a
    c = 1 / 1e-30
    d = 1 / b
    h = d

    for i in range(1, max_iter + 1):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        if abs(d) < 1e-30:
            d = 1e-30
        c = b + an / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < eps:
            break

    return math.exp(-x + a * math.log(x) - math.lgamma(a)) * h


@dataclass
class StatisticalTestResult:
    """Result of a statistical hypothesis test."""

    test_name: str
    statistic: float
    p_value: float
    is_significant: bool  # p < 0.05
    is_highly_significant: bool  # p < 0.01
    interpretation: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "testName": self.test_name,
            "statistic": self.statistic,
            "pValue": self.p_value,
            "isSignificant": self.is_significant,
            "isHighlySignificant": self.is_highly_significant,
            "interpretation": self.interpretation,
        }


def two_sample_t_test(
    sample1: list[float],
    sample2: list[float],
    equal_var: bool = False,
) -> StatisticalTestResult:
    """
    Perform two-sample t-test (Welch's t-test by default).

    Tests if the means of two samples are significantly different.

    Args:
        sample1: First sample (e.g., backtest P&L values)
        sample2: Second sample (e.g., live P&L values)
        equal_var: Assume equal variances (Student's t-test) or not (Welch's)

    Returns:
        StatisticalTestResult with test statistic and p-value
    """
    n1, n2 = len(sample1), len(sample2)

    if n1 < 2 or n2 < 2:
        return StatisticalTestResult(
            test_name="Two-Sample T-Test",
            statistic=0.0,
            p_value=1.0,
            is_significant=False,
            is_highly_significant=False,
            interpretation="Insufficient samples for t-test (need at least 2 per group)",
        )

    # Calculate means
    mean1 = sum(sample1) / n1
    mean2 = sum(sample2) / n2

    # Calculate variances
    var1 = sum((x - mean1) ** 2 for x in sample1) / (n1 - 1)
    var2 = sum((x - mean2) ** 2 for x in sample2) / (n2 - 1)

    if equal_var:
        # Pooled variance (Student's t-test)
        sp = math.sqrt(((n1 - 1) * var1 + (n2 - 1) * var2) / (n1 + n2 - 2))
        se = sp * math.sqrt(1 / n1 + 1 / n2)
        df = n1 + n2 - 2
    else:
        # Welch's t-test (unequal variances)
        se = math.sqrt(var1 / n1 + var2 / n2)
        if se == 0:
            return StatisticalTestResult(
                test_name="Welch's T-Test",
                statistic=0.0,
                p_value=1.0,
                is_significant=False,
                is_highly_significant=False,
                interpretation="Zero variance in samples",
            )

        # Welch-Satterthwaite degrees of freedom
        num = (var1 / n1 + var2 / n2) ** 2
        denom = (var1 / n1) ** 2 / (n1 - 1) + (var2 / n2) ** 2 / (n2 - 1)
        df = int(num / denom) if denom > 0 else n1 + n2 - 2

    # Calculate t-statistic
    t_stat = (mean1 - mean2) / se if se > 0 else 0

    # Two-tailed p-value
    p_value = 2 * (1 - _t_distribution_cdf(abs(t_stat), df))

    is_sig = p_value < 0.05
    is_highly_sig = p_value < 0.01

    if is_highly_sig:
        interpretation = f"Highly significant difference (p={p_value:.4f}): means differ substantially"
    elif is_sig:
        interpretation = f"Significant difference (p={p_value:.4f}): means likely differ"
    else:
        interpretation = f"No significant difference (p={p_value:.4f}): means are compatible"

    return StatisticalTestResult(
        test_name="Welch's T-Test" if not equal_var else "Student's T-Test",
        statistic=t_stat,
        p_value=p_value,
        is_significant=is_sig,
        is_highly_significant=is_highly_sig,
        interpretation=interpretation,
    )


def chi_squared_test(
    observed_wins: int,
    observed_losses: int,
    expected_win_rate: float,
) -> StatisticalTestResult:
    """
    Perform chi-squared test for win rate comparison.

    Tests if observed win/loss ratio differs significantly from expected.

    Args:
        observed_wins: Number of winning trades
        observed_losses: Number of losing trades
        expected_win_rate: Expected win rate (0-1)

    Returns:
        StatisticalTestResult with chi-squared statistic and p-value
    """
    total = observed_wins + observed_losses

    if total < 5:
        return StatisticalTestResult(
            test_name="Chi-Squared Test",
            statistic=0.0,
            p_value=1.0,
            is_significant=False,
            is_highly_significant=False,
            interpretation="Insufficient samples for chi-squared test (need at least 5)",
        )

    # Expected values
    expected_wins = total * expected_win_rate
    expected_losses = total * (1 - expected_win_rate)

    if expected_wins < 1 or expected_losses < 1:
        return StatisticalTestResult(
            test_name="Chi-Squared Test",
            statistic=0.0,
            p_value=1.0,
            is_significant=False,
            is_highly_significant=False,
            interpretation="Expected frequencies too low for reliable test",
        )

    # Chi-squared statistic
    chi2 = (
        (observed_wins - expected_wins) ** 2 / expected_wins +
        (observed_losses - expected_losses) ** 2 / expected_losses
    )

    # p-value (1 degree of freedom)
    p_value = 1 - _chi2_cdf(chi2, 1)

    is_sig = p_value < 0.05
    is_highly_sig = p_value < 0.01

    observed_rate = observed_wins / total * 100
    expected_rate = expected_win_rate * 100

    if is_highly_sig:
        interpretation = (
            f"Highly significant deviation (p={p_value:.4f}): "
            f"observed {observed_rate:.1f}% vs expected {expected_rate:.1f}%"
        )
    elif is_sig:
        interpretation = (
            f"Significant deviation (p={p_value:.4f}): "
            f"observed {observed_rate:.1f}% vs expected {expected_rate:.1f}%"
        )
    else:
        interpretation = (
            f"No significant deviation (p={p_value:.4f}): "
            f"observed {observed_rate:.1f}% compatible with expected {expected_rate:.1f}%"
        )

    return StatisticalTestResult(
        test_name="Chi-Squared Test",
        statistic=chi2,
        p_value=p_value,
        is_significant=is_sig,
        is_highly_significant=is_highly_sig,
        interpretation=interpretation,
    )


def ks_test(
    sample1: list[float],
    sample2: list[float],
) -> StatisticalTestResult:
    """
    Perform two-sample Kolmogorov-Smirnov test.

    Tests if two samples come from the same distribution.

    Args:
        sample1: First sample (e.g., backtest returns)
        sample2: Second sample (e.g., live returns)

    Returns:
        StatisticalTestResult with KS statistic and p-value
    """
    n1, n2 = len(sample1), len(sample2)

    if n1 < 4 or n2 < 4:
        return StatisticalTestResult(
            test_name="Kolmogorov-Smirnov Test",
            statistic=0.0,
            p_value=1.0,
            is_significant=False,
            is_highly_significant=False,
            interpretation="Insufficient samples for KS test (need at least 4 per group)",
        )

    # Sort both samples
    sorted1 = sorted(sample1)
    sorted2 = sorted(sample2)

    # Combine and sort all values for CDF computation
    all_values = sorted(set(sample1) | set(sample2))

    # Compute CDFs at each point and find max difference
    max_diff = 0.0

    for val in all_values:
        # CDF of sample1 at val
        cdf1 = sum(1 for x in sorted1 if x <= val) / n1
        # CDF of sample2 at val
        cdf2 = sum(1 for x in sorted2 if x <= val) / n2

        diff = abs(cdf1 - cdf2)
        if diff > max_diff:
            max_diff = diff

    # KS statistic
    d_stat = max_diff

    # Approximate p-value using asymptotic formula
    # For the two-sample KS test
    en = math.sqrt(n1 * n2 / (n1 + n2))
    lambda_ks = (en + 0.12 + 0.11 / en) * d_stat

    # Approximate p-value
    if lambda_ks < 0.27:
        p_value = 1.0
    else:
        # Use sum approximation
        p_value = 2 * sum(
            ((-1) ** (i - 1)) * math.exp(-2 * i * i * lambda_ks * lambda_ks)
            for i in range(1, 101)
        )
        p_value = max(0, min(1, p_value))

    is_sig = p_value < 0.05
    is_highly_sig = p_value < 0.01

    if is_highly_sig:
        interpretation = f"Highly significant (p={p_value:.4f}): distributions are very different"
    elif is_sig:
        interpretation = f"Significant (p={p_value:.4f}): distributions likely differ"
    else:
        interpretation = f"No significant difference (p={p_value:.4f}): distributions are compatible"

    return StatisticalTestResult(
        test_name="Kolmogorov-Smirnov Test",
        statistic=d_stat,
        p_value=p_value,
        is_significant=is_sig,
        is_highly_significant=is_highly_sig,
        interpretation=interpretation,
    )


class DriftSeverity(Enum):
    """Severity level of detected drift."""

    INFO = "info"  # Minor deviation, informational only
    WARNING = "warning"  # Notable deviation, monitor closely
    ALERT = "alert"  # Significant deviation, consider action
    CRITICAL = "critical"  # Major deviation, may require intervention


class DriftType(Enum):
    """Type of drift detected."""

    SIGNAL_TIMING = "signal_timing"  # Signals at different times
    SIGNAL_DIRECTION = "signal_direction"  # Different signal direction
    ORDER_SKIPPED = "order_skipped"  # Order in backtest not placed live
    UNEXPECTED_ORDER = "unexpected_order"  # Order placed live not in backtest
    FILL_PRICE = "fill_price"  # Fill price significantly different
    FILL_QUANTITY = "fill_quantity"  # Fill quantity different
    EXECUTION_DELAY = "execution_delay"  # Execution took longer than expected
    SLIPPAGE_EXCESS = "slippage_excess"  # Slippage higher than expected
    WIN_RATE_DEVIATION = "win_rate_deviation"  # Win rate differs from backtest
    PNL_DEVIATION = "pnl_deviation"  # P&L differs from expected


@dataclass
class DriftEvent:
    """A single drift detection event."""

    drift_type: DriftType
    severity: DriftSeverity
    timestamp: datetime
    symbol: str
    description: str
    backtest_value: Any = None
    live_value: Any = None
    deviation_percent: float | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "driftType": self.drift_type.value,
            "severity": self.severity.value,
            "timestamp": self.timestamp.isoformat(),
            "symbol": self.symbol,
            "description": self.description,
            "backtestValue": str(self.backtest_value) if self.backtest_value else None,
            "liveValue": str(self.live_value) if self.live_value else None,
            "deviationPercent": self.deviation_percent,
        }


@dataclass
class DriftThresholds:
    """Configurable thresholds for drift detection."""

    # Timing thresholds (seconds)
    signal_timing_warning: float = 5.0
    signal_timing_alert: float = 30.0
    execution_delay_warning: float = 1.0
    execution_delay_alert: float = 5.0

    # Price thresholds (percent)
    fill_price_warning: float = 0.5  # 0.5%
    fill_price_alert: float = 1.0  # 1%
    slippage_warning: float = 0.2  # 0.2%
    slippage_alert: float = 0.5  # 0.5%

    # Statistical thresholds
    win_rate_deviation_warning: float = 10.0  # 10% deviation
    win_rate_deviation_alert: float = 20.0  # 20% deviation
    pnl_deviation_warning: float = 15.0  # 15% deviation
    pnl_deviation_alert: float = 30.0  # 30% deviation

    # Minimum samples for statistical checks
    min_trades_for_stats: int = 20


@dataclass
class BacktestSignal:
    """A signal from backtest for comparison."""

    timestamp: datetime
    symbol: str
    action: str  # "buy", "sell", "close"
    price: Decimal
    quantity: Decimal
    reason: str = ""


@dataclass
class LiveExecution:
    """A live execution for comparison."""

    timestamp: datetime
    symbol: str
    action: str
    order_price: Decimal | None
    fill_price: Decimal
    quantity: Decimal
    slippage: Decimal = Decimal("0")
    execution_time_ms: float = 0


@dataclass
class DriftSummary:
    """Summary of drift detection results."""

    session_id: str
    period_start: datetime
    period_end: datetime
    total_events: int
    events_by_severity: dict[str, int]
    events_by_type: dict[str, int]
    critical_events: list[DriftEvent]
    overall_health: str  # "healthy", "degraded", "critical"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "sessionId": self.session_id,
            "periodStart": self.period_start.isoformat(),
            "periodEnd": self.period_end.isoformat(),
            "totalEvents": self.total_events,
            "eventsBySeverity": self.events_by_severity,
            "eventsByType": self.events_by_type,
            "criticalEvents": [e.to_dict() for e in self.critical_events],
            "overallHealth": self.overall_health,
        }


class TradeDriftDetector:
    """
    Detects drift between backtest expectations and live trading.

    Monitors:
    - Signal timing differences
    - Fill price deviations
    - Execution delays
    - Statistical divergence (win rate, P&L)

    Alerts when live trading deviates significantly from
    what the strategy showed in backtesting.
    """

    def __init__(
        self,
        session_id: str,
        thresholds: DriftThresholds | None = None,
        on_drift: Callable[[DriftEvent], None] | None = None,
        on_critical: Callable[[DriftEvent], None] | None = None,
    ) -> None:
        """
        Initialize drift detector.

        Args:
            session_id: Trading session ID
            thresholds: Detection thresholds
            on_drift: Callback for all drift events
            on_critical: Callback for critical drift events only
        """
        self._session_id = session_id
        self._thresholds = thresholds or DriftThresholds()
        self._on_drift = on_drift
        self._on_critical = on_critical

        # Tracking data
        self._events: list[DriftEvent] = []
        self._backtest_signals: list[BacktestSignal] = []
        self._live_executions: list[LiveExecution] = []
        self._matched_pairs: list[tuple[BacktestSignal, LiveExecution]] = []

        # Statistics
        self._backtest_win_rate: float | None = None
        self._backtest_avg_pnl: Decimal | None = None
        self._backtest_pnl_values: list[float] = []  # For statistical tests
        self._live_wins: int = 0
        self._live_losses: int = 0
        self._live_total_pnl: Decimal = Decimal("0")
        self._live_pnl_values: list[float] = []  # For statistical tests

    @property
    def events(self) -> list[DriftEvent]:
        """Get all drift events."""
        return list(self._events)

    @property
    def critical_events(self) -> list[DriftEvent]:
        """Get critical drift events."""
        return [e for e in self._events if e.severity == DriftSeverity.CRITICAL]

    def set_backtest_baseline(
        self,
        signals: list[BacktestSignal],
        win_rate: float | None = None,
        avg_pnl: Decimal | None = None,
        pnl_values: list[float] | None = None,
    ) -> None:
        """
        Set backtest baseline for comparison.

        Args:
            signals: Expected signals from backtest
            win_rate: Backtest win rate (0-100)
            avg_pnl: Backtest average P&L per trade
            pnl_values: List of individual P&L values for statistical tests
        """
        self._backtest_signals = list(signals)
        self._backtest_win_rate = win_rate
        self._backtest_avg_pnl = avg_pnl
        self._backtest_pnl_values = list(pnl_values) if pnl_values else []
        logger.info(f"Drift detector baseline set: {len(signals)} signals")

    def record_live_execution(self, execution: LiveExecution) -> list[DriftEvent]:
        """
        Record a live execution and check for drift.

        Args:
            execution: Live execution data

        Returns:
            List of drift events detected
        """
        self._live_executions.append(execution)
        events = []

        # Try to match with backtest signal
        matched_signal = self._find_matching_signal(execution)

        if matched_signal:
            self._matched_pairs.append((matched_signal, execution))
            events.extend(self._compare_execution(matched_signal, execution))
        else:
            # Unexpected order - not in backtest
            event = DriftEvent(
                drift_type=DriftType.UNEXPECTED_ORDER,
                severity=DriftSeverity.WARNING,
                timestamp=execution.timestamp,
                symbol=execution.symbol,
                description=f"Order {execution.action} {execution.quantity} not found in backtest",
                live_value=f"{execution.action} {execution.quantity} @ {execution.fill_price}",
            )
            events.append(event)

        # Check for execution delay
        if execution.execution_time_ms > self._thresholds.execution_delay_alert * 1000:
            severity = DriftSeverity.ALERT
        elif execution.execution_time_ms > self._thresholds.execution_delay_warning * 1000:
            severity = DriftSeverity.WARNING
        else:
            severity = None

        if severity:
            event = DriftEvent(
                drift_type=DriftType.EXECUTION_DELAY,
                severity=severity,
                timestamp=execution.timestamp,
                symbol=execution.symbol,
                description=f"Execution took {execution.execution_time_ms:.0f}ms",
                live_value=execution.execution_time_ms,
            )
            events.append(event)

        # Check slippage
        if execution.slippage != 0:
            slippage_pct = float(abs(execution.slippage) / execution.fill_price * 100)
            if slippage_pct > self._thresholds.slippage_alert:
                severity = DriftSeverity.ALERT
            elif slippage_pct > self._thresholds.slippage_warning:
                severity = DriftSeverity.WARNING
            else:
                severity = None

            if severity:
                event = DriftEvent(
                    drift_type=DriftType.SLIPPAGE_EXCESS,
                    severity=severity,
                    timestamp=execution.timestamp,
                    symbol=execution.symbol,
                    description=f"Slippage of {slippage_pct:.2f}%",
                    live_value=execution.slippage,
                    deviation_percent=slippage_pct,
                )
                events.append(event)

        # Record events
        for event in events:
            self._record_event(event)

        return events

    def record_trade_result(self, pnl: Decimal, is_win: bool) -> list[DriftEvent]:
        """
        Record a trade result for statistical comparison.

        Args:
            pnl: Trade P&L
            is_win: Whether trade was profitable

        Returns:
            List of drift events detected
        """
        self._live_total_pnl += pnl
        self._live_pnl_values.append(float(pnl))
        if is_win:
            self._live_wins += 1
        else:
            self._live_losses += 1

        events = []
        total_trades = self._live_wins + self._live_losses

        # Check statistical drift after minimum trades
        if total_trades >= self._thresholds.min_trades_for_stats:
            events.extend(self._check_statistical_drift())

        return events

    def run_statistical_tests(self) -> dict[str, StatisticalTestResult]:
        """
        Run comprehensive statistical tests comparing live vs backtest.

        Returns:
            Dictionary of test name -> StatisticalTestResult
        """
        results: dict[str, StatisticalTestResult] = {}
        total_trades = self._live_wins + self._live_losses

        # Chi-squared test for win rate
        if self._backtest_win_rate is not None and total_trades >= 5:
            results["win_rate"] = chi_squared_test(
                self._live_wins,
                self._live_losses,
                self._backtest_win_rate / 100,  # Convert from percentage
            )

        # T-test for P&L means
        if (
            len(self._backtest_pnl_values) >= 2 and
            len(self._live_pnl_values) >= 2
        ):
            results["pnl_mean"] = two_sample_t_test(
                self._backtest_pnl_values,
                self._live_pnl_values,
            )

        # KS test for P&L distribution
        if (
            len(self._backtest_pnl_values) >= 4 and
            len(self._live_pnl_values) >= 4
        ):
            results["pnl_distribution"] = ks_test(
                self._backtest_pnl_values,
                self._live_pnl_values,
            )

        return results

    def get_statistical_summary(self) -> dict[str, Any]:
        """
        Get a summary of statistical comparison between live and backtest.

        Returns:
            Dictionary with statistical metrics and test results
        """
        total_trades = self._live_wins + self._live_losses

        summary: dict[str, Any] = {
            "sample_sizes": {
                "live_trades": total_trades,
                "backtest_pnl_samples": len(self._backtest_pnl_values),
            },
            "live_metrics": {
                "wins": self._live_wins,
                "losses": self._live_losses,
                "win_rate": (self._live_wins / total_trades * 100) if total_trades > 0 else None,
                "total_pnl": str(self._live_total_pnl),
                "avg_pnl": str(self._live_total_pnl / Decimal(total_trades)) if total_trades > 0 else None,
            },
            "backtest_metrics": {
                "win_rate": self._backtest_win_rate,
                "avg_pnl": str(self._backtest_avg_pnl) if self._backtest_avg_pnl else None,
            },
            "statistical_tests": {},
        }

        # Run tests and add to summary
        test_results = self.run_statistical_tests()
        for name, result in test_results.items():
            summary["statistical_tests"][name] = result.to_dict()

        # Overall drift assessment
        significant_tests = sum(1 for r in test_results.values() if r.is_significant)
        highly_significant_tests = sum(1 for r in test_results.values() if r.is_highly_significant)

        if highly_significant_tests > 0:
            summary["drift_assessment"] = "critical"
            summary["drift_message"] = (
                f"{highly_significant_tests} test(s) show highly significant drift - "
                "live performance is statistically different from backtest"
            )
        elif significant_tests > 0:
            summary["drift_assessment"] = "warning"
            summary["drift_message"] = (
                f"{significant_tests} test(s) show significant drift - "
                "monitor closely for continued deviation"
            )
        else:
            summary["drift_assessment"] = "normal"
            summary["drift_message"] = "No statistically significant drift detected"

        return summary

    def check_missed_signals(self) -> list[DriftEvent]:
        """
        Check for backtest signals that weren't executed live.

        Should be called periodically during trading.

        Returns:
            List of drift events for missed signals
        """
        events = []
        now = datetime.now()
        grace_period = timedelta(seconds=self._thresholds.signal_timing_alert)

        for signal in self._backtest_signals:
            # Skip future signals
            if signal.timestamp > now:
                continue

            # Check if signal is old enough to be concerned
            if (now - signal.timestamp) < grace_period:
                continue

            # Check if already matched
            matched = any(
                s.timestamp == signal.timestamp and s.symbol == signal.symbol
                for s, _ in self._matched_pairs
            )

            if not matched:
                event = DriftEvent(
                    drift_type=DriftType.ORDER_SKIPPED,
                    severity=DriftSeverity.ALERT,
                    timestamp=signal.timestamp,
                    symbol=signal.symbol,
                    description=f"Expected {signal.action} signal not executed",
                    backtest_value=f"{signal.action} {signal.quantity} @ {signal.price}",
                )
                self._record_event(event)
                events.append(event)

        return events

    def get_summary(
        self,
        period_start: datetime | None = None,
        period_end: datetime | None = None,
    ) -> DriftSummary:
        """
        Get summary of drift detection.

        Args:
            period_start: Start of period (default: session start)
            period_end: End of period (default: now)

        Returns:
            DriftSummary with statistics
        """
        period_end = period_end or datetime.now()
        period_start = period_start or (
            self._events[0].timestamp if self._events else datetime.now()
        )

        # Filter events in period
        period_events = [
            e for e in self._events
            if period_start <= e.timestamp <= period_end
        ]

        # Count by severity
        by_severity: dict[str, int] = {s.value: 0 for s in DriftSeverity}
        for event in period_events:
            by_severity[event.severity.value] += 1

        # Count by type
        by_type: dict[str, int] = {t.value: 0 for t in DriftType}
        for event in period_events:
            by_type[event.drift_type.value] += 1

        # Determine overall health
        if by_severity["critical"] > 0:
            health = "critical"
        elif by_severity["alert"] > 2:
            health = "critical"
        elif by_severity["alert"] > 0 or by_severity["warning"] > 5:
            health = "degraded"
        else:
            health = "healthy"

        return DriftSummary(
            session_id=self._session_id,
            period_start=period_start,
            period_end=period_end,
            total_events=len(period_events),
            events_by_severity=by_severity,
            events_by_type=by_type,
            critical_events=[e for e in period_events if e.severity == DriftSeverity.CRITICAL],
            overall_health=health,
        )

    def _find_matching_signal(self, execution: LiveExecution) -> BacktestSignal | None:
        """Find a backtest signal matching this execution."""
        for signal in self._backtest_signals:
            # Match by symbol and action
            if signal.symbol != execution.symbol:
                continue
            if signal.action != execution.action:
                continue

            # Match by timing (within threshold)
            time_diff = abs((signal.timestamp - execution.timestamp).total_seconds())
            if time_diff <= self._thresholds.signal_timing_alert:
                return signal

        return None

    def _compare_execution(
        self, signal: BacktestSignal, execution: LiveExecution
    ) -> list[DriftEvent]:
        """Compare a matched signal/execution pair."""
        events = []

        # Check timing difference
        time_diff = abs((signal.timestamp - execution.timestamp).total_seconds())
        if time_diff > self._thresholds.signal_timing_alert:
            severity = DriftSeverity.ALERT
        elif time_diff > self._thresholds.signal_timing_warning:
            severity = DriftSeverity.WARNING
        else:
            severity = None

        if severity:
            events.append(DriftEvent(
                drift_type=DriftType.SIGNAL_TIMING,
                severity=severity,
                timestamp=execution.timestamp,
                symbol=execution.symbol,
                description=f"Signal timing difference of {time_diff:.1f}s",
                backtest_value=signal.timestamp.isoformat(),
                live_value=execution.timestamp.isoformat(),
            ))

        # Check fill price difference
        if signal.price > 0:
            price_diff_pct = abs(float(execution.fill_price - signal.price) / float(signal.price) * 100)
            if price_diff_pct > self._thresholds.fill_price_alert:
                severity = DriftSeverity.ALERT
            elif price_diff_pct > self._thresholds.fill_price_warning:
                severity = DriftSeverity.WARNING
            else:
                severity = None

            if severity:
                events.append(DriftEvent(
                    drift_type=DriftType.FILL_PRICE,
                    severity=severity,
                    timestamp=execution.timestamp,
                    symbol=execution.symbol,
                    description=f"Fill price differs by {price_diff_pct:.2f}%",
                    backtest_value=signal.price,
                    live_value=execution.fill_price,
                    deviation_percent=price_diff_pct,
                ))

        # Check quantity difference
        if execution.quantity != signal.quantity:
            qty_diff_pct = abs(float(execution.quantity - signal.quantity) / float(signal.quantity) * 100)
            events.append(DriftEvent(
                drift_type=DriftType.FILL_QUANTITY,
                severity=DriftSeverity.WARNING,
                timestamp=execution.timestamp,
                symbol=execution.symbol,
                description=f"Quantity differs: expected {signal.quantity}, got {execution.quantity}",
                backtest_value=signal.quantity,
                live_value=execution.quantity,
                deviation_percent=qty_diff_pct,
            ))

        return events

    def _check_statistical_drift(self) -> list[DriftEvent]:
        """Check for statistical drift from backtest using hypothesis tests."""
        events = []
        total_trades = self._live_wins + self._live_losses

        # Run statistical tests
        test_results = self.run_statistical_tests()

        # Check win rate using chi-squared test
        if "win_rate" in test_results:
            result = test_results["win_rate"]
            if result.is_highly_significant:
                severity = DriftSeverity.CRITICAL
            elif result.is_significant:
                severity = DriftSeverity.ALERT
            else:
                severity = None

            if severity:
                live_win_rate = (self._live_wins / total_trades) * 100
                events.append(DriftEvent(
                    drift_type=DriftType.WIN_RATE_DEVIATION,
                    severity=severity,
                    timestamp=datetime.now(),
                    symbol="PORTFOLIO",
                    description=(
                        f"Win rate drift: {live_win_rate:.1f}% vs backtest "
                        f"{self._backtest_win_rate:.1f}% (p={result.p_value:.4f})"
                    ),
                    backtest_value=self._backtest_win_rate,
                    live_value=live_win_rate,
                    deviation_percent=abs(live_win_rate - (self._backtest_win_rate or 0)),
                ))

        # Check P&L mean using t-test
        if "pnl_mean" in test_results:
            result = test_results["pnl_mean"]
            if result.is_highly_significant:
                severity = DriftSeverity.CRITICAL
            elif result.is_significant:
                severity = DriftSeverity.ALERT
            else:
                severity = None

            if severity:
                live_avg_pnl = self._live_total_pnl / Decimal(total_trades)
                events.append(DriftEvent(
                    drift_type=DriftType.PNL_DEVIATION,
                    severity=severity,
                    timestamp=datetime.now(),
                    symbol="PORTFOLIO",
                    description=(
                        f"P&L mean drift: {live_avg_pnl:.2f} vs backtest "
                        f"{self._backtest_avg_pnl:.2f} (t={result.statistic:.2f}, p={result.p_value:.4f})"
                    ),
                    backtest_value=self._backtest_avg_pnl,
                    live_value=live_avg_pnl,
                ))

        # Check P&L distribution using KS test
        if "pnl_distribution" in test_results:
            result = test_results["pnl_distribution"]
            if result.is_highly_significant:
                # Distribution drift is an additional warning
                events.append(DriftEvent(
                    drift_type=DriftType.PNL_DEVIATION,
                    severity=DriftSeverity.WARNING,
                    timestamp=datetime.now(),
                    symbol="PORTFOLIO",
                    description=(
                        f"P&L distribution changed (KS={result.statistic:.3f}, p={result.p_value:.4f})"
                    ),
                ))

        # Also check simple threshold-based drift for backwards compatibility
        if self._backtest_win_rate is not None and "win_rate" not in test_results:
            live_win_rate = (self._live_wins / total_trades) * 100
            deviation = abs(live_win_rate - self._backtest_win_rate)

            if deviation > self._thresholds.win_rate_deviation_alert:
                severity = DriftSeverity.CRITICAL
            elif deviation > self._thresholds.win_rate_deviation_warning:
                severity = DriftSeverity.ALERT
            else:
                severity = None

            if severity:
                events.append(DriftEvent(
                    drift_type=DriftType.WIN_RATE_DEVIATION,
                    severity=severity,
                    timestamp=datetime.now(),
                    symbol="PORTFOLIO",
                    description=f"Win rate {live_win_rate:.1f}% vs backtest {self._backtest_win_rate:.1f}%",
                    backtest_value=self._backtest_win_rate,
                    live_value=live_win_rate,
                    deviation_percent=deviation,
                ))

        if (
            self._backtest_avg_pnl is not None and
            self._backtest_avg_pnl != 0 and
            "pnl_mean" not in test_results
        ):
            live_avg_pnl = self._live_total_pnl / Decimal(total_trades)
            deviation = abs(float((live_avg_pnl - self._backtest_avg_pnl) / self._backtest_avg_pnl * 100))

            if deviation > self._thresholds.pnl_deviation_alert:
                severity = DriftSeverity.ALERT
            elif deviation > self._thresholds.pnl_deviation_warning:
                severity = DriftSeverity.WARNING
            else:
                severity = None

            if severity:
                events.append(DriftEvent(
                    drift_type=DriftType.PNL_DEVIATION,
                    severity=severity,
                    timestamp=datetime.now(),
                    symbol="PORTFOLIO",
                    description=f"Avg P&L {live_avg_pnl:.2f} vs backtest {self._backtest_avg_pnl:.2f}",
                    backtest_value=self._backtest_avg_pnl,
                    live_value=live_avg_pnl,
                    deviation_percent=deviation,
                ))

        return events

    def _record_event(self, event: DriftEvent) -> None:
        """Record a drift event and trigger callbacks."""
        self._events.append(event)

        if self._on_drift:
            self._on_drift(event)

        if event.severity == DriftSeverity.CRITICAL and self._on_critical:
            self._on_critical(event)

        logger.warning(
            f"Drift detected [{event.severity.value}]: {event.drift_type.value} - "
            f"{event.description}"
        )

    def clear(self) -> None:
        """Clear all drift data."""
        self._events.clear()
        self._backtest_signals.clear()
        self._live_executions.clear()
        self._matched_pairs.clear()
        self._live_wins = 0
        self._live_losses = 0
        self._live_total_pnl = Decimal("0")
        self._live_pnl_values.clear()
        self._backtest_pnl_values.clear()
        self._backtest_win_rate = None
        self._backtest_avg_pnl = None

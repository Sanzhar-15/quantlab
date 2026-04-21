"""
Drawdown Calculations.

Calculates drawdown metrics from equity curves.

Spec Reference: Technical Spec §7.3
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Sequence


@dataclass
class DrawdownPeriod:
    """Single drawdown period."""

    start_idx: int
    end_idx: int
    valley_idx: int
    peak_value: Decimal
    valley_value: Decimal
    drawdown: Decimal  # As positive decimal
    recovery_idx: int | None = None
    duration: int = 0
    recovery_duration: int | None = None

    @property
    def is_recovered(self) -> bool:
        """Check if drawdown has recovered."""
        return self.recovery_idx is not None


@dataclass
class DrawdownMetrics:
    """Complete drawdown metrics."""

    max_drawdown: Decimal
    max_drawdown_pct: Decimal
    avg_drawdown: Decimal
    avg_drawdown_pct: Decimal
    max_drawdown_duration: int
    avg_drawdown_duration: Decimal
    current_drawdown: Decimal
    current_drawdown_pct: Decimal
    num_drawdowns: int
    drawdown_periods: list[DrawdownPeriod]


def drawdown_series(
    equity: Sequence[Decimal],
    validate: bool = True,
) -> list[Decimal]:
    """
    Calculate drawdown at each point.

    Drawdown_t = (Peak_t - Equity_t) / Peak_t

    Args:
        equity: Equity curve
        validate: If True, raises ValueError for negative equity values

    Returns:
        Drawdown series (as positive decimals)

    Raises:
        ValueError: If validate=True and any equity value is negative
    """
    if not equity:
        return []

    # Validate equity values (optional, enabled by default)
    if validate:
        for i, value in enumerate(equity):
            if value < Decimal("0"):
                raise ValueError(
                    f"Invalid negative equity at index {i}: {value}. "
                    f"Check for data errors or excessive losses."
                )

    drawdowns = []
    peak = equity[0]

    for value in equity:
        peak = max(peak, value)
        if peak <= Decimal("0"):
            # Handle zero/negative peak - no meaningful drawdown
            dd = Decimal("0")
        else:
            dd = (peak - value) / peak
        drawdowns.append(dd)

    return drawdowns


def max_drawdown(equity: Sequence[Decimal]) -> Decimal:
    """
    Calculate maximum drawdown.

    Args:
        equity: Equity curve

    Returns:
        Maximum drawdown (positive value, 0.1 = 10%)
    """
    if len(equity) < 2:
        return Decimal("0")

    dd_series = drawdown_series(equity)
    return max(dd_series) if dd_series else Decimal("0")


def underwater_curve(equity: Sequence[Decimal]) -> list[Decimal]:
    """
    Calculate underwater curve (drawdown depth at each point).

    Negative values indicate being underwater.

    Args:
        equity: Equity curve

    Returns:
        Underwater curve (negative values)
    """
    dd_series = drawdown_series(equity)
    return [-dd for dd in dd_series]


def identify_drawdown_periods(
    equity: Sequence[Decimal],
    threshold: Decimal = Decimal("0.01"),  # Minimum 1% drawdown
) -> list[DrawdownPeriod]:
    """
    Identify all drawdown periods.

    Args:
        equity: Equity curve
        threshold: Minimum drawdown to count as a period

    Returns:
        List of drawdown periods
    """
    if len(equity) < 2:
        return []

    periods: list[DrawdownPeriod] = []
    dd_series = drawdown_series(equity)

    peak = equity[0]
    peak_idx = 0
    in_drawdown = False
    valley = peak
    valley_idx = 0

    for i, value in enumerate(equity):
        if value >= peak:
            # New peak - close any open drawdown
            if in_drawdown:
                period = DrawdownPeriod(
                    start_idx=peak_idx,
                    end_idx=valley_idx,
                    valley_idx=valley_idx,
                    peak_value=peak,
                    valley_value=valley,
                    drawdown=(peak - valley) / peak if peak > 0 else Decimal("0"),
                    recovery_idx=i,
                    duration=valley_idx - peak_idx,
                    recovery_duration=i - valley_idx,
                )
                if period.drawdown >= threshold:
                    periods.append(period)

            peak = value
            peak_idx = i
            valley = value
            valley_idx = i
            in_drawdown = False

        elif value < valley:
            # New valley in current drawdown
            valley = value
            valley_idx = i
            in_drawdown = True

    # Handle open drawdown at end
    if in_drawdown and peak > Decimal("0"):
        dd = (peak - valley) / peak
        if dd >= threshold:
            periods.append(DrawdownPeriod(
                start_idx=peak_idx,
                end_idx=valley_idx,
                valley_idx=valley_idx,
                peak_value=peak,
                valley_value=valley,
                drawdown=dd,
                recovery_idx=None,
                duration=valley_idx - peak_idx,
                recovery_duration=None,
            ))

    return periods


def max_drawdown_duration(
    equity: Sequence[Decimal],
) -> int:
    """
    Calculate maximum drawdown duration in periods.

    Duration from peak to recovery.

    Args:
        equity: Equity curve

    Returns:
        Maximum duration in periods
    """
    periods = identify_drawdown_periods(equity, Decimal("0"))

    max_dur = 0
    for period in periods:
        if period.recovery_idx is not None:
            dur = period.recovery_idx - period.start_idx
        else:
            dur = len(equity) - 1 - period.start_idx
        max_dur = max(max_dur, dur)

    return max_dur


def average_drawdown(equity: Sequence[Decimal]) -> Decimal:
    """
    Calculate average drawdown.

    Args:
        equity: Equity curve

    Returns:
        Average drawdown
    """
    periods = identify_drawdown_periods(equity, Decimal("0.01"))

    if not periods:
        return Decimal("0")

    return sum(p.drawdown for p in periods) / Decimal(str(len(periods)))


def time_in_drawdown(equity: Sequence[Decimal]) -> Decimal:
    """
    Calculate percentage of time in drawdown.

    Args:
        equity: Equity curve

    Returns:
        Fraction of time in drawdown (0-1)
    """
    if len(equity) < 2:
        return Decimal("0")

    dd_series = drawdown_series(equity)
    in_dd_count = sum(1 for dd in dd_series if dd > Decimal("0"))

    return Decimal(str(in_dd_count)) / Decimal(str(len(dd_series)))


def ulcer_index(equity: Sequence[Decimal]) -> Decimal:
    """
    Calculate Ulcer Index.

    UI = sqrt(mean(drawdown^2))

    Measures the depth and duration of drawdowns.

    Args:
        equity: Equity curve

    Returns:
        Ulcer Index
    """
    if len(equity) < 2:
        return Decimal("0")

    import math

    dd_series = drawdown_series(equity)
    squared_dd = [dd ** 2 for dd in dd_series]
    mean_sq = sum(squared_dd) / Decimal(str(len(squared_dd)))

    return Decimal(str(math.sqrt(float(mean_sq))))


def calculate_drawdown_metrics(
    equity: Sequence[Decimal],
) -> DrawdownMetrics:
    """
    Calculate complete drawdown metrics.

    Args:
        equity: Equity curve

    Returns:
        DrawdownMetrics with all calculations
    """
    if len(equity) < 2:
        return DrawdownMetrics(
            max_drawdown=Decimal("0"),
            max_drawdown_pct=Decimal("0"),
            avg_drawdown=Decimal("0"),
            avg_drawdown_pct=Decimal("0"),
            max_drawdown_duration=0,
            avg_drawdown_duration=Decimal("0"),
            current_drawdown=Decimal("0"),
            current_drawdown_pct=Decimal("0"),
            num_drawdowns=0,
            drawdown_periods=[],
        )

    dd_series = drawdown_series(equity)
    periods = identify_drawdown_periods(equity, Decimal("0.01"))

    max_dd = max(dd_series)
    avg_dd = average_drawdown(equity)
    current_dd = dd_series[-1] if dd_series else Decimal("0")

    # Max duration
    max_dur = 0
    total_dur = 0
    for p in periods:
        dur = p.duration + (p.recovery_duration or 0)
        max_dur = max(max_dur, dur)
        total_dur += dur

    avg_dur = Decimal(str(total_dur)) / Decimal(str(len(periods))) if periods else Decimal("0")

    return DrawdownMetrics(
        max_drawdown=max_dd,
        max_drawdown_pct=max_dd * Decimal("100"),
        avg_drawdown=avg_dd,
        avg_drawdown_pct=avg_dd * Decimal("100"),
        max_drawdown_duration=max_dur,
        avg_drawdown_duration=avg_dur,
        current_drawdown=current_dd,
        current_drawdown_pct=current_dd * Decimal("100"),
        num_drawdowns=len(periods),
        drawdown_periods=periods,
    )

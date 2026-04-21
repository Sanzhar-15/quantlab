"""
Tests for Drawdown Calculations.

Tests drawdown metrics calculations from equity curves.
"""

from decimal import Decimal

import pytest

from quantlab.metrics.drawdown import (
    DrawdownPeriod,
    DrawdownMetrics,
    drawdown_series,
    max_drawdown,
    underwater_curve,
    identify_drawdown_periods,
    max_drawdown_duration,
    average_drawdown,
    time_in_drawdown,
    ulcer_index,
    calculate_drawdown_metrics,
)


class TestDrawdownPeriod:
    """Tests for DrawdownPeriod dataclass."""

    def test_creation(self) -> None:
        """Test period creation."""
        period = DrawdownPeriod(
            start_idx=0,
            end_idx=5,
            valley_idx=3,
            peak_value=Decimal("100000"),
            valley_value=Decimal("90000"),
            drawdown=Decimal("0.10"),
        )

        assert period.start_idx == 0
        assert period.valley_idx == 3
        assert period.drawdown == Decimal("0.10")

    def test_is_recovered_true(self) -> None:
        """Test is_recovered when recovered."""
        period = DrawdownPeriod(
            start_idx=0,
            end_idx=5,
            valley_idx=3,
            peak_value=Decimal("100000"),
            valley_value=Decimal("90000"),
            drawdown=Decimal("0.10"),
            recovery_idx=10,
        )

        assert period.is_recovered is True

    def test_is_recovered_false(self) -> None:
        """Test is_recovered when not recovered."""
        period = DrawdownPeriod(
            start_idx=0,
            end_idx=5,
            valley_idx=3,
            peak_value=Decimal("100000"),
            valley_value=Decimal("90000"),
            drawdown=Decimal("0.10"),
            recovery_idx=None,
        )

        assert period.is_recovered is False


class TestDrawdownSeries:
    """Tests for drawdown_series function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity curve."""
        result = drawdown_series([])
        assert result == []

    def test_single_value(self) -> None:
        """Test with single value."""
        equity = [Decimal("100000")]
        result = drawdown_series(equity)

        assert len(result) == 1
        assert result[0] == Decimal("0")

    def test_increasing_equity(self) -> None:
        """Test with always increasing equity."""
        equity = [Decimal("100"), Decimal("110"), Decimal("120"), Decimal("130")]
        result = drawdown_series(equity)

        # No drawdown when always increasing
        for dd in result:
            assert dd == Decimal("0")

    def test_simple_drawdown(self) -> None:
        """Test simple drawdown calculation."""
        equity = [Decimal("100"), Decimal("90"), Decimal("95")]
        result = drawdown_series(equity)

        assert result[0] == Decimal("0")
        assert result[1] == Decimal("0.10")  # 10% drawdown
        assert result[2] == Decimal("0.05")  # 5% drawdown

    def test_peak_tracking(self) -> None:
        """Test that peak is tracked correctly."""
        equity = [Decimal("100"), Decimal("120"), Decimal("100")]
        result = drawdown_series(equity)

        assert result[0] == Decimal("0")
        assert result[1] == Decimal("0")  # New peak
        # Third point: (120-100)/120 = 0.1667
        assert abs(float(result[2]) - 0.1667) < 0.001

    def test_zero_peak_handled(self) -> None:
        """Test zero peak is handled without division error."""
        equity = [Decimal("0"), Decimal("100"), Decimal("90")]
        result = drawdown_series(equity)

        assert result[0] == Decimal("0")


class TestMaxDrawdown:
    """Tests for max_drawdown function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = max_drawdown([])
        assert result == Decimal("0")

    def test_single_value(self) -> None:
        """Test with single value."""
        result = max_drawdown([Decimal("100")])
        assert result == Decimal("0")

    def test_no_drawdown(self) -> None:
        """Test with no drawdown."""
        equity = [Decimal("100"), Decimal("110"), Decimal("120")]
        result = max_drawdown(equity)
        assert result == Decimal("0")

    def test_simple_max_drawdown(self) -> None:
        """Test simple max drawdown."""
        equity = [Decimal("100"), Decimal("80"), Decimal("100")]
        result = max_drawdown(equity)
        assert result == Decimal("0.20")  # 20% max drawdown

    def test_multiple_drawdowns_picks_max(self) -> None:
        """Test that max of multiple drawdowns is returned."""
        equity = [
            Decimal("100"),
            Decimal("90"),   # 10% dd
            Decimal("100"),  # Recovery
            Decimal("75"),   # 25% dd (max)
            Decimal("100"),  # Recovery
        ]
        result = max_drawdown(equity)
        assert result == Decimal("0.25")


class TestUnderwaterCurve:
    """Tests for underwater_curve function."""

    def test_returns_negative_drawdowns(self) -> None:
        """Test underwater curve is negative of drawdown."""
        equity = [Decimal("100"), Decimal("90"), Decimal("95")]
        result = underwater_curve(equity)

        assert result[0] == Decimal("0")
        assert result[1] == Decimal("-0.10")
        assert result[2] == Decimal("-0.05")


class TestIdentifyDrawdownPeriods:
    """Tests for identify_drawdown_periods function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = identify_drawdown_periods([])
        assert result == []

    def test_single_value(self) -> None:
        """Test with single value."""
        result = identify_drawdown_periods([Decimal("100")])
        assert result == []

    def test_no_significant_drawdowns(self) -> None:
        """Test with no significant drawdowns (below threshold)."""
        equity = [Decimal("100"), Decimal("99.5"), Decimal("100")]  # 0.5% dd
        result = identify_drawdown_periods(equity, threshold=Decimal("0.01"))
        assert result == []

    def test_one_recovered_drawdown(self) -> None:
        """Test identifying one recovered drawdown."""
        equity = [
            Decimal("100"),
            Decimal("90"),   # Start of drawdown
            Decimal("85"),   # Valley
            Decimal("95"),
            Decimal("100"),  # Recovery
        ]
        result = identify_drawdown_periods(equity, threshold=Decimal("0.01"))

        assert len(result) == 1
        assert result[0].is_recovered is True
        assert result[0].drawdown == Decimal("0.15")

    def test_open_drawdown(self) -> None:
        """Test identifying open (unrecovered) drawdown."""
        equity = [
            Decimal("100"),
            Decimal("90"),   # Start of drawdown
            Decimal("85"),   # Valley, no recovery
        ]
        result = identify_drawdown_periods(equity, threshold=Decimal("0.01"))

        assert len(result) == 1
        assert result[0].is_recovered is False


class TestMaxDrawdownDuration:
    """Tests for max_drawdown_duration function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = max_drawdown_duration([])
        assert result == 0

    def test_no_drawdown(self) -> None:
        """Test with no drawdown."""
        equity = [Decimal("100"), Decimal("110"), Decimal("120")]
        result = max_drawdown_duration(equity)
        assert result == 0

    def test_short_drawdown(self) -> None:
        """Test duration of short drawdown."""
        equity = [
            Decimal("100"),  # 0
            Decimal("90"),   # 1 - start
            Decimal("100"),  # 2 - recovery
        ]
        result = max_drawdown_duration(equity)
        assert result == 2  # 2 periods from peak to recovery


class TestAverageDrawdown:
    """Tests for average_drawdown function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = average_drawdown([])
        assert result == Decimal("0")

    def test_no_drawdowns(self) -> None:
        """Test with no drawdowns."""
        equity = [Decimal("100"), Decimal("110"), Decimal("120")]
        result = average_drawdown(equity)
        assert result == Decimal("0")

    def test_single_drawdown(self) -> None:
        """Test with single drawdown."""
        equity = [
            Decimal("100"),
            Decimal("85"),
            Decimal("100"),
        ]
        result = average_drawdown(equity)
        assert result == Decimal("0.15")


class TestTimeInDrawdown:
    """Tests for time_in_drawdown function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = time_in_drawdown([])
        assert result == Decimal("0")

    def test_single_value(self) -> None:
        """Test with single value."""
        result = time_in_drawdown([Decimal("100")])
        assert result == Decimal("0")

    def test_always_at_peak(self) -> None:
        """Test when always at peak."""
        equity = [Decimal("100"), Decimal("110"), Decimal("120")]
        result = time_in_drawdown(equity)
        assert result == Decimal("0")

    def test_partial_time_in_drawdown(self) -> None:
        """Test partial time in drawdown."""
        equity = [
            Decimal("100"),  # Not in dd
            Decimal("90"),   # In dd
            Decimal("100"),  # Not in dd
            Decimal("95"),   # In dd
        ]
        result = time_in_drawdown(equity)
        assert result == Decimal("0.5")  # 2 out of 4


class TestUlcerIndex:
    """Tests for ulcer_index function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = ulcer_index([])
        assert result == Decimal("0")

    def test_single_value(self) -> None:
        """Test with single value."""
        result = ulcer_index([Decimal("100")])
        assert result == Decimal("0")

    def test_no_drawdown(self) -> None:
        """Test with no drawdown."""
        equity = [Decimal("100"), Decimal("110"), Decimal("120")]
        result = ulcer_index(equity)
        assert result == Decimal("0")

    def test_with_drawdown(self) -> None:
        """Test ulcer index with drawdown."""
        equity = [Decimal("100"), Decimal("90"), Decimal("80")]
        result = ulcer_index(equity)
        assert result > Decimal("0")


class TestCalculateDrawdownMetrics:
    """Tests for calculate_drawdown_metrics function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = calculate_drawdown_metrics([])

        assert result.max_drawdown == Decimal("0")
        assert result.num_drawdowns == 0

    def test_single_value(self) -> None:
        """Test with single value."""
        result = calculate_drawdown_metrics([Decimal("100")])

        assert result.max_drawdown == Decimal("0")
        assert result.num_drawdowns == 0

    def test_complete_metrics(self) -> None:
        """Test complete metrics calculation."""
        equity = [
            Decimal("100"),
            Decimal("90"),   # 10% dd
            Decimal("85"),   # 15% dd
            Decimal("100"),  # Recovery
            Decimal("80"),   # 20% dd
            Decimal("100"),  # Recovery
        ]
        result = calculate_drawdown_metrics(equity)

        assert result.max_drawdown == Decimal("0.20")
        assert result.max_drawdown_pct == Decimal("20")
        assert result.num_drawdowns >= 1
        assert result.current_drawdown == Decimal("0")

    def test_current_drawdown_in_drawdown(self) -> None:
        """Test current drawdown when in drawdown."""
        equity = [Decimal("100"), Decimal("90")]  # Currently in 10% dd
        result = calculate_drawdown_metrics(equity)

        assert result.current_drawdown == Decimal("0.10")
        assert result.current_drawdown_pct == Decimal("10")

    def test_metrics_dataclass_fields(self) -> None:
        """Test that all metrics fields are populated."""
        equity = [Decimal("100"), Decimal("85"), Decimal("100")]
        result = calculate_drawdown_metrics(equity)

        assert isinstance(result, DrawdownMetrics)
        assert hasattr(result, "max_drawdown")
        assert hasattr(result, "max_drawdown_pct")
        assert hasattr(result, "avg_drawdown")
        assert hasattr(result, "avg_drawdown_pct")
        assert hasattr(result, "max_drawdown_duration")
        assert hasattr(result, "avg_drawdown_duration")
        assert hasattr(result, "current_drawdown")
        assert hasattr(result, "current_drawdown_pct")
        assert hasattr(result, "num_drawdowns")
        assert hasattr(result, "drawdown_periods")

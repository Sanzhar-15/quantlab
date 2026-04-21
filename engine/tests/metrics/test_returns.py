"""
Tests for Return Calculations.

Tests return metrics calculations from equity curves.
"""

from decimal import Decimal

import pytest

from quantlab.metrics.returns import (
    ReturnMetrics,
    simple_returns,
    log_returns,
    total_return,
    annualized_return,
    cumulative_returns,
    rolling_returns,
    excess_returns,
    mean_return,
    geometric_mean_return,
    calculate_return_metrics,
)


class TestSimpleReturns:
    """Tests for simple_returns function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = simple_returns([])
        assert result == []

    def test_single_value(self) -> None:
        """Test with single value."""
        result = simple_returns([Decimal("100")])
        assert result == []

    def test_positive_return(self) -> None:
        """Test positive return calculation."""
        equity = [Decimal("100"), Decimal("110")]
        result = simple_returns(equity)

        assert len(result) == 1
        assert result[0] == Decimal("0.10")  # 10% return

    def test_negative_return(self) -> None:
        """Test negative return calculation."""
        equity = [Decimal("100"), Decimal("90")]
        result = simple_returns(equity)

        assert len(result) == 1
        assert result[0] == Decimal("-0.10")  # -10% return

    def test_zero_denominator(self) -> None:
        """Test zero denominator handling."""
        equity = [Decimal("0"), Decimal("100")]
        result = simple_returns(equity)

        assert result[0] == Decimal("0")

    def test_multiple_periods(self) -> None:
        """Test multiple period returns."""
        equity = [Decimal("100"), Decimal("110"), Decimal("121")]
        result = simple_returns(equity)

        assert len(result) == 2
        assert result[0] == Decimal("0.10")
        assert result[1] == Decimal("0.10")


class TestLogReturns:
    """Tests for log_returns function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = log_returns([])
        assert result == []

    def test_single_value(self) -> None:
        """Test with single value."""
        result = log_returns([Decimal("100")])
        assert result == []

    def test_positive_log_return(self) -> None:
        """Test positive log return."""
        equity = [Decimal("100"), Decimal("110")]
        result = log_returns(equity)

        assert len(result) == 1
        # ln(110/100) ≈ 0.0953
        assert abs(float(result[0]) - 0.0953) < 0.001

    def test_zero_equity_handled(self) -> None:
        """Test zero equity handled."""
        equity = [Decimal("0"), Decimal("100")]
        result = log_returns(equity)

        assert result[0] == Decimal("0")

    def test_negative_equity_handled(self) -> None:
        """Test negative equity handled."""
        equity = [Decimal("100"), Decimal("-10")]
        result = log_returns(equity)

        assert result[0] == Decimal("0")


class TestTotalReturn:
    """Tests for total_return function."""

    def test_with_equity_curve(self) -> None:
        """Test with equity curve."""
        equity = [Decimal("100"), Decimal("120")]
        result = total_return(equity)

        assert result == Decimal("0.20")

    def test_with_direct_values(self) -> None:
        """Test with direct values."""
        result = total_return(Decimal("100"), Decimal("120"))

        assert result == Decimal("0.20")

    def test_empty_curve(self) -> None:
        """Test with empty curve."""
        result = total_return([])
        assert result == Decimal("0")

    def test_single_value_curve(self) -> None:
        """Test with single value curve."""
        result = total_return([Decimal("100")])
        assert result == Decimal("0")

    def test_zero_initial_equity(self) -> None:
        """Test zero initial equity."""
        result = total_return(Decimal("0"), Decimal("100"))
        assert result == Decimal("0")

    def test_direct_values_no_final(self) -> None:
        """Test direct values with no final."""
        result = total_return(Decimal("100"))
        assert result == Decimal("0")


class TestAnnualizedReturn:
    """Tests for annualized_return function."""

    def test_zero_periods(self) -> None:
        """Test with zero periods."""
        result = annualized_return(Decimal("0.20"), 0)
        assert result == Decimal("0")

    def test_negative_periods(self) -> None:
        """Test with negative periods."""
        result = annualized_return(Decimal("0.20"), -5)
        assert result == Decimal("0")

    def test_one_year(self) -> None:
        """Test with one year of data."""
        # 20% return over 252 days
        result = annualized_return(Decimal("0.20"), 252, 252)
        assert abs(float(result) - 0.20) < 0.001

    def test_half_year(self) -> None:
        """Test with half year of data."""
        # 10% return over 126 days should annualize to ~21%
        result = annualized_return(Decimal("0.10"), 126, 252)
        assert float(result) > 0.20  # Should be greater than period return


class TestCumulativeReturns:
    """Tests for cumulative_returns function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = cumulative_returns([])
        assert result == [Decimal("0")]

    def test_single_return(self) -> None:
        """Test with single return."""
        result = cumulative_returns([Decimal("0.10")])

        assert len(result) == 2
        assert result[0] == Decimal("0")
        assert result[1] == Decimal("0.10")

    def test_compounding(self) -> None:
        """Test compound returns."""
        # Two 10% returns should give 21% cumulative
        returns = [Decimal("0.10"), Decimal("0.10")]
        result = cumulative_returns(returns)

        assert len(result) == 3
        assert result[0] == Decimal("0")
        assert result[1] == Decimal("0.10")
        assert result[2] == Decimal("0.21")


class TestRollingReturns:
    """Tests for rolling_returns function."""

    def test_insufficient_data(self) -> None:
        """Test with insufficient data."""
        equity = [Decimal("100"), Decimal("110")]
        result = rolling_returns(equity, window=5)

        assert result == []

    def test_simple_rolling_return(self) -> None:
        """Test simple rolling return."""
        equity = [Decimal("100"), Decimal("110"), Decimal("121")]
        result = rolling_returns(equity, window=2)

        assert len(result) == 1
        assert result[0] == Decimal("0.21")  # 121/100 - 1

    def test_zero_window_start_handled(self) -> None:
        """Test zero at window start handled."""
        equity = [Decimal("0"), Decimal("100"), Decimal("110")]
        result = rolling_returns(equity, window=2)

        assert result[0] == Decimal("0")


class TestExcessReturns:
    """Tests for excess_returns function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = excess_returns([], Decimal("0.05"))
        assert result == []

    def test_simple_excess(self) -> None:
        """Test simple excess return."""
        returns = [Decimal("0.001")]  # 0.1% daily
        rf = Decimal("0.05")  # 5% annual
        result = excess_returns(returns, rf, periods_per_year=252)

        # 0.1% - (5%/252) = 0.1% - 0.0198% ≈ 0.08%
        assert result[0] < Decimal("0.001")


class TestMeanReturn:
    """Tests for mean_return function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = mean_return([])
        assert result == Decimal("0")

    def test_single_return(self) -> None:
        """Test with single return."""
        result = mean_return([Decimal("0.10")])
        assert result == Decimal("0.10")

    def test_multiple_returns(self) -> None:
        """Test with multiple returns."""
        returns = [Decimal("0.10"), Decimal("0.20"), Decimal("0.30")]
        result = mean_return(returns)

        assert result == Decimal("0.20")


class TestGeometricMeanReturn:
    """Tests for geometric_mean_return function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = geometric_mean_return([])
        assert result == Decimal("0")

    def test_single_return(self) -> None:
        """Test with single return."""
        result = geometric_mean_return([Decimal("0.10")])
        assert abs(float(result) - 0.10) < 0.001

    def test_consistent_returns(self) -> None:
        """Test with consistent returns."""
        # Two 10% returns: geo mean should be 10%
        returns = [Decimal("0.10"), Decimal("0.10")]
        result = geometric_mean_return(returns)

        assert abs(float(result) - 0.10) < 0.001

    def test_variable_returns(self) -> None:
        """Test with variable returns."""
        # Geometric mean is less than arithmetic mean
        returns = [Decimal("0.20"), Decimal("-0.10")]
        result = geometric_mean_return(returns)

        # Arithmetic mean: 5%, geometric will be less
        assert float(result) < 0.05


class TestCalculateReturnMetrics:
    """Tests for calculate_return_metrics function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = calculate_return_metrics([])

        assert result.total_return == Decimal("0")
        assert result.periods == 0

    def test_single_value(self) -> None:
        """Test with single value."""
        result = calculate_return_metrics([Decimal("100")])

        assert result.total_return == Decimal("0")
        assert result.periods == 0

    def test_complete_metrics(self) -> None:
        """Test complete metrics calculation."""
        equity = [Decimal("100"), Decimal("110"), Decimal("120")]
        result = calculate_return_metrics(equity)

        assert result.total_return == Decimal("0.20")
        assert result.total_return_pct == Decimal("20")
        assert result.periods == 2
        assert result.trading_days == 2

    def test_metrics_dataclass_fields(self) -> None:
        """Test that all metrics fields are populated."""
        equity = [Decimal("100"), Decimal("120")]
        result = calculate_return_metrics(equity)

        assert isinstance(result, ReturnMetrics)
        assert hasattr(result, "total_return")
        assert hasattr(result, "annualized_return")
        assert hasattr(result, "total_return_pct")
        assert hasattr(result, "annualized_return_pct")
        assert hasattr(result, "periods")
        assert hasattr(result, "trading_days")

    def test_annualized_return_calculation(self) -> None:
        """Test annualized return is calculated."""
        equity = [Decimal("100"), Decimal("120")]
        result = calculate_return_metrics(equity, periods_per_year=252)

        # With only 1 period, annualized should be very high
        assert result.annualized_return != Decimal("0")

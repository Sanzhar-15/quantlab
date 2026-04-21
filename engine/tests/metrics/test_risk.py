"""
Tests for Metrics Module.

Tests risk-adjusted metrics, drawdown calculations, and trade statistics.
"""

from decimal import Decimal
from typing import Sequence

import pytest

from quantlab.metrics import (
    calmar_ratio,
    drawdown_series,
    max_drawdown,
    max_drawdown_duration,
    profit_factor,
    sharpe_ratio,
    sortino_ratio,
    stability_score,
    total_return,
    volatility,
    win_rate,
)


class TestReturnCalculations:
    """Tests for return calculations."""

    @pytest.fixture
    def equity_curve(self) -> list[Decimal]:
        """Sample equity curve."""
        return [
            Decimal("100000"),
            Decimal("101000"),
            Decimal("99500"),
            Decimal("102000"),
            Decimal("103500"),
            Decimal("101500"),
            Decimal("104000"),
        ]

    def test_total_return(self, equity_curve: list[Decimal]) -> None:
        """Test total return calculation."""
        result = total_return(equity_curve)

        expected = (Decimal("104000") - Decimal("100000")) / Decimal("100000")
        assert abs(result - expected) < Decimal("0.0001")

    def test_total_return_flat(self) -> None:
        """Test total return with no change."""
        curve = [Decimal("100000")] * 5
        result = total_return(curve)

        assert result == Decimal("0")


class TestVolatility:
    """Tests for volatility calculations."""

    @pytest.fixture
    def returns(self) -> list[Decimal]:
        """Sample returns."""
        return [
            Decimal("0.01"),
            Decimal("-0.005"),
            Decimal("0.02"),
            Decimal("0.015"),
            Decimal("-0.01"),
            Decimal("0.008"),
        ]

    def test_volatility_positive(self, returns: list[Decimal]) -> None:
        """Test volatility is always positive."""
        result = volatility(returns)
        assert result > Decimal("0")

    def test_volatility_zero_constant(self) -> None:
        """Test zero volatility for constant returns."""
        returns = [Decimal("0.01")] * 10
        result = volatility(returns)
        assert result == Decimal("0")


class TestSharpeRatio:
    """Tests for Sharpe ratio."""

    def test_sharpe_ratio_positive(self) -> None:
        """Test positive Sharpe ratio."""
        returns = [Decimal("0.01"), Decimal("0.02"), Decimal("0.015"), Decimal("0.018")]
        result = sharpe_ratio(returns, risk_free_rate=Decimal("0.001"))

        assert result > Decimal("0")

    def test_sharpe_ratio_negative(self) -> None:
        """Test negative Sharpe ratio for losing strategy."""
        returns = [Decimal("-0.01"), Decimal("-0.02"), Decimal("-0.015")]
        result = sharpe_ratio(returns, risk_free_rate=Decimal("0.001"))

        assert result < Decimal("0")


class TestDrawdown:
    """Tests for drawdown calculations."""

    @pytest.fixture
    def equity_curve(self) -> list[Decimal]:
        """Equity curve with drawdown."""
        return [
            Decimal("100"),
            Decimal("110"),
            Decimal("105"),
            Decimal("108"),
            Decimal("95"),
            Decimal("98"),
            Decimal("112"),
        ]

    def test_max_drawdown(self, equity_curve: list[Decimal]) -> None:
        """Test max drawdown calculation."""
        result = max_drawdown(equity_curve)

        # From peak 110 to trough 95 = 13.6%
        expected = (Decimal("110") - Decimal("95")) / Decimal("110")
        assert abs(result - expected) < Decimal("0.01")

    def test_drawdown_series(self, equity_curve: list[Decimal]) -> None:
        """Test drawdown series calculation."""
        dd_series = drawdown_series(equity_curve)

        assert len(dd_series) == len(equity_curve)
        assert dd_series[0] == Decimal("0")  # First point has no drawdown
        assert all(dd >= Decimal("0") for dd in dd_series)


class TestTradeMetrics:
    """Tests for trade metrics."""

    @pytest.fixture
    def trade_pnl(self) -> list[Decimal]:
        """Sample trade P&L."""
        return [
            Decimal("100"),
            Decimal("-50"),
            Decimal("200"),
            Decimal("-30"),
            Decimal("150"),
            Decimal("-80"),
            Decimal("120"),
        ]

    def test_win_rate(self, trade_pnl: list[Decimal]) -> None:
        """Test win rate calculation."""
        result = win_rate(trade_pnl)

        # 4 wins out of 7 trades
        assert abs(result - Decimal("0.571")) < Decimal("0.01")

    def test_profit_factor(self, trade_pnl: list[Decimal]) -> None:
        """Test profit factor calculation."""
        result = profit_factor(trade_pnl)

        # Gross profit 570 / Gross loss 160 = 3.5625
        expected = Decimal("570") / Decimal("160")
        assert abs(result - expected) < Decimal("0.01")


class TestCalmarRatio:
    """Tests for Calmar ratio."""

    def test_calmar_ratio_positive(self) -> None:
        """Test positive Calmar ratio."""
        equity_curve = [
            Decimal("100"),
            Decimal("110"),
            Decimal("105"),
            Decimal("120"),
            Decimal("115"),
            Decimal("130"),
        ]

        result = calmar_ratio(equity_curve)
        assert result > Decimal("0")

    def test_calmar_ratio_no_drawdown(self) -> None:
        """Test Calmar with no drawdown."""
        equity_curve = [
            Decimal("100"),
            Decimal("110"),
            Decimal("120"),
            Decimal("130"),
        ]

        result = calmar_ratio(equity_curve)
        # Should return infinity or very large number
        assert result > Decimal("100") or result == Decimal("inf")


class TestSortinoRatio:
    """Tests for Sortino ratio."""

    def test_sortino_ratio(self) -> None:
        """Test Sortino ratio calculation."""
        returns = [
            Decimal("0.02"),
            Decimal("-0.01"),
            Decimal("0.03"),
            Decimal("-0.005"),
            Decimal("0.015"),
        ]

        result = sortino_ratio(returns)
        assert result > Decimal("0")  # Positive on net positive returns


class TestStabilityScore:
    """Tests for stability score."""

    def test_stability_linear_growth(self) -> None:
        """Test stability of linear growth."""
        equity_curve = [Decimal(str(100 + i * 10)) for i in range(10)]

        result = stability_score(equity_curve)
        # Linear growth should have R² close to 1
        assert result > Decimal("0.95")

    def test_stability_volatile(self) -> None:
        """Test stability of volatile curve."""
        equity_curve = [
            Decimal("100"),
            Decimal("120"),
            Decimal("90"),
            Decimal("140"),
            Decimal("80"),
            Decimal("130"),
        ]

        result = stability_score(equity_curve)
        # Volatile curve should have lower stability
        assert result < Decimal("0.5")


# Additional tests for complete coverage of quantlab.metrics.risk module

from quantlab.metrics.risk import (
    standard_deviation,
    downside_deviation,
    omega_ratio,
    information_ratio,
    value_at_risk,
    conditional_var,
    calculate_risk_metrics,
    RiskMetrics,
)


class TestStandardDeviation:
    """Tests for standard_deviation function."""

    def test_empty_values(self) -> None:
        """Test with empty values."""
        result = standard_deviation([])
        assert result == Decimal("0")

    def test_single_value(self) -> None:
        """Test with single value."""
        result = standard_deviation([Decimal("10")])
        assert result == Decimal("0")

    def test_identical_values(self) -> None:
        """Test with identical values."""
        values = [Decimal("5"), Decimal("5"), Decimal("5")]
        result = standard_deviation(values)
        assert result == Decimal("0")

    def test_simple_std(self) -> None:
        """Test simple standard deviation."""
        values = [Decimal("2"), Decimal("4"), Decimal("4"), Decimal("4"), Decimal("5"), Decimal("5"), Decimal("7"), Decimal("9")]
        result = standard_deviation(values)
        # Mean = 5, sample std ≈ 2.14
        assert abs(float(result) - 2.14) < 0.2


class TestDownsideDeviationDetailed:
    """Additional tests for downside_deviation function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = downside_deviation([])
        assert result == Decimal("0")

    def test_all_positive_returns(self) -> None:
        """Test with all positive returns."""
        returns = [Decimal("0.05"), Decimal("0.03"), Decimal("0.02")]
        result = downside_deviation(returns)
        assert result == Decimal("0")

    def test_all_negative_returns(self) -> None:
        """Test with all negative returns."""
        returns = [Decimal("-0.05"), Decimal("-0.03"), Decimal("-0.02")]
        result = downside_deviation(returns)
        assert result > Decimal("0")


class TestOmegaRatio:
    """Tests for omega_ratio function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = omega_ratio([])
        assert result == Decimal("0")

    def test_all_gains(self) -> None:
        """Test with all positive returns."""
        returns = [Decimal("0.05"), Decimal("0.03"), Decimal("0.02")]
        result = omega_ratio(returns)
        # All gains, no losses - returns large finite value
        assert result == Decimal("999999")

    def test_all_losses(self) -> None:
        """Test with all negative returns."""
        returns = [Decimal("-0.05"), Decimal("-0.03"), Decimal("-0.02")]
        result = omega_ratio(returns)
        assert result == Decimal("0")

    def test_mixed_returns(self) -> None:
        """Test with mixed returns."""
        returns = [Decimal("0.10"), Decimal("-0.05"), Decimal("0.08"), Decimal("-0.03")]
        result = omega_ratio(returns)
        # Gains: 0.10 + 0.08 = 0.18
        # Losses: 0.05 + 0.03 = 0.08
        # Omega = 0.18 / 0.08 = 2.25
        assert abs(float(result) - 2.25) < 0.01


class TestInformationRatio:
    """Tests for information_ratio function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = information_ratio([], [])
        assert result == Decimal("0")

    def test_single_return(self) -> None:
        """Test with single return."""
        result = information_ratio([Decimal("0.01")], [Decimal("0.01")])
        assert result == Decimal("0")

    def test_mismatched_lengths(self) -> None:
        """Test with mismatched lengths raises ValueError."""
        with pytest.raises(ValueError, match="must equal benchmark length"):
            information_ratio(
                [Decimal("0.01"), Decimal("0.02")],
                [Decimal("0.01")],
            )

    def test_identical_returns(self) -> None:
        """Test when portfolio equals benchmark."""
        returns = [Decimal("0.01"), Decimal("0.02"), Decimal("-0.01")]
        result = information_ratio(returns, returns)
        # Zero tracking error = zero information ratio
        assert result == Decimal("0")

    def test_positive_alpha(self) -> None:
        """Test with positive alpha (varying outperformance)."""
        # Portfolio consistently beats benchmark but by varying amounts
        portfolio = [Decimal("0.02"), Decimal("0.03"), Decimal("0.015"), Decimal("0.025"), Decimal("0.02")]
        benchmark = [Decimal("0.00"), Decimal("0.01"), Decimal("0.005"), Decimal("0.01"), Decimal("0.005")]
        result = information_ratio(portfolio, benchmark)
        # Portfolio outperforms benchmark with varying tracking error
        assert result > Decimal("0")


class TestValueAtRisk:
    """Tests for value_at_risk function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = value_at_risk([])
        assert result == Decimal("0")

    def test_all_positive_returns(self) -> None:
        """Test with all positive returns."""
        returns = [Decimal("0.05"), Decimal("0.03"), Decimal("0.02"), Decimal("0.04")]
        result = value_at_risk(returns, confidence=Decimal("0.95"))
        # VaR should be negative of the worst return in tail
        assert result < Decimal("0")  # Negative VaR means no loss

    def test_mixed_returns(self) -> None:
        """Test with mixed returns."""
        # 20 returns: need 5% tail = 1 observation
        returns = [Decimal(str(i / 100)) for i in range(-10, 10)]
        result = value_at_risk(returns, confidence=Decimal("0.95"))
        # Worst 5% is the most negative
        assert result > Decimal("0")


class TestConditionalVar:
    """Tests for conditional_var function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = conditional_var([])
        assert result == Decimal("0")

    def test_all_positive_returns(self) -> None:
        """Test with all positive returns."""
        returns = [Decimal("0.05"), Decimal("0.03"), Decimal("0.02")]
        result = conditional_var(returns)
        # Should return VaR when no tail losses
        assert result is not None

    def test_cvar_greater_than_var(self) -> None:
        """Test that CVaR >= VaR."""
        returns = [Decimal(str(i / 100)) for i in range(-10, 10)]
        var_95 = value_at_risk(returns, confidence=Decimal("0.95"))
        cvar_95 = conditional_var(returns, confidence=Decimal("0.95"))
        # CVaR is average loss in tail, should be >= VaR
        assert cvar_95 >= var_95


class TestCalculateRiskMetrics:
    """Tests for calculate_risk_metrics function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = calculate_risk_metrics([])

        assert result.sharpe_ratio == Decimal("0")
        assert result.sortino_ratio == Decimal("0")
        assert result.volatility == Decimal("0")

    def test_single_value(self) -> None:
        """Test with single value."""
        result = calculate_risk_metrics([Decimal("100")])

        assert result.sharpe_ratio == Decimal("0")
        assert result.volatility == Decimal("0")

    def test_two_values(self) -> None:
        """Test with two values."""
        result = calculate_risk_metrics([Decimal("100"), Decimal("110")])

        # Should still have minimal metrics with only one return
        assert isinstance(result, RiskMetrics)

    def test_complete_metrics(self) -> None:
        """Test complete metrics calculation."""
        equity = [
            Decimal("100"),
            Decimal("105"),
            Decimal("102"),
            Decimal("108"),
            Decimal("115"),
        ]
        result = calculate_risk_metrics(equity)

        assert isinstance(result, RiskMetrics)
        assert result.volatility >= Decimal("0")
        assert result.max_drawdown >= Decimal("0")

    def test_with_provided_max_dd(self) -> None:
        """Test with pre-calculated max drawdown."""
        equity = [Decimal("100"), Decimal("90"), Decimal("95"), Decimal("100")]
        result = calculate_risk_metrics(equity, max_dd=Decimal("0.10"))

        assert result.max_drawdown == Decimal("0.10")

    def test_metrics_dataclass_fields(self) -> None:
        """Test that all fields are present."""
        equity = [Decimal("100"), Decimal("110"), Decimal("100"), Decimal("120")]
        result = calculate_risk_metrics(equity)

        assert hasattr(result, "sharpe_ratio")
        assert hasattr(result, "sortino_ratio")
        assert hasattr(result, "calmar_ratio")
        assert hasattr(result, "volatility")
        assert hasattr(result, "downside_deviation")
        assert hasattr(result, "var_95")
        assert hasattr(result, "cvar_95")
        assert hasattr(result, "max_drawdown")

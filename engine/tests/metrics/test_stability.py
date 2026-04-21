"""
Tests for Stability Metrics.

Tests stability score, R-squared, and equity curve quality metrics.
"""

from decimal import Decimal

import pytest

from quantlab.metrics.stability import (
    StabilityMetrics,
    linear_regression,
    r_squared,
    stability_score,
    skewness,
    kurtosis,
    tail_ratio,
    common_sense_ratio,
    gain_to_pain_ratio,
    recovery_factor,
    kelly_criterion,
    calculate_stability_metrics,
)


class TestLinearRegression:
    """Tests for linear_regression function."""

    def test_empty_values(self) -> None:
        """Test with empty values."""
        intercept, slope = linear_regression([])
        assert intercept == Decimal("0")
        assert slope == Decimal("0")

    def test_single_value(self) -> None:
        """Test with single value."""
        intercept, slope = linear_regression([Decimal("100")])
        assert intercept == Decimal("0")
        assert slope == Decimal("0")

    def test_two_values_increasing(self) -> None:
        """Test with two increasing values."""
        intercept, slope = linear_regression([Decimal("100"), Decimal("110")])
        assert slope == Decimal("10")
        assert intercept == Decimal("100")

    def test_linear_data(self) -> None:
        """Test with perfectly linear data."""
        # y = 100 + 10*x
        y = [Decimal(str(100 + i * 10)) for i in range(10)]
        intercept, slope = linear_regression(y)
        assert abs(slope - Decimal("10")) < Decimal("0.01")
        assert abs(intercept - Decimal("100")) < Decimal("0.01")

    def test_constant_values(self) -> None:
        """Test with constant values (zero slope)."""
        y = [Decimal("50")] * 10
        intercept, slope = linear_regression(y)
        assert slope == Decimal("0")
        assert intercept == Decimal("50")


class TestRSquared:
    """Tests for r_squared function."""

    def test_empty_values(self) -> None:
        """Test with empty values."""
        result = r_squared([])
        assert result == Decimal("0")

    def test_single_value(self) -> None:
        """Test with single value."""
        result = r_squared([Decimal("100")])
        assert result == Decimal("0")

    def test_perfect_linear_fit(self) -> None:
        """Test with perfectly linear data."""
        y = [Decimal(str(100 + i * 10)) for i in range(10)]
        result = r_squared(y)
        assert result == Decimal("1")

    def test_constant_values(self) -> None:
        """Test with constant values."""
        y = [Decimal("100")] * 10
        result = r_squared(y)
        # Perfect fit for constant values
        assert result == Decimal("1")

    def test_noisy_data(self) -> None:
        """Test with noisy data."""
        y = [Decimal("100"), Decimal("120"), Decimal("90"), Decimal("140"), Decimal("80")]
        result = r_squared(y)
        # Should be less than perfect fit
        assert Decimal("0") <= result <= Decimal("1")


class TestStabilityScore:
    """Tests for stability_score function."""

    def test_linear_growth(self) -> None:
        """Test stability of linear growth."""
        equity = [Decimal(str(100 + i * 10)) for i in range(10)]
        result = stability_score(equity)
        # Linear growth should have high stability
        assert result > Decimal("0.95")

    def test_volatile_equity(self) -> None:
        """Test stability of volatile equity curve."""
        equity = [Decimal("100"), Decimal("120"), Decimal("90"), Decimal("130"), Decimal("80")]
        result = stability_score(equity)
        # Volatile curve should have lower stability
        assert result < Decimal("0.5")

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = stability_score([])
        assert result == Decimal("0")


class TestSkewness:
    """Tests for skewness function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = skewness([])
        assert result == Decimal("0")

    def test_insufficient_data(self) -> None:
        """Test with insufficient data."""
        result = skewness([Decimal("0.01"), Decimal("0.02")])
        assert result == Decimal("0")

    def test_symmetric_returns(self) -> None:
        """Test with symmetric returns."""
        returns = [Decimal("-0.02"), Decimal("-0.01"), Decimal("0"), Decimal("0.01"), Decimal("0.02")]
        result = skewness(returns)
        # Should be close to zero for symmetric distribution
        assert abs(result) < Decimal("0.5")

    def test_positive_skew(self) -> None:
        """Test with positive skew."""
        # More extreme positive values
        returns = [Decimal("0.01")] * 10 + [Decimal("0.10")]
        result = skewness(returns)
        # Should be positive
        assert result > Decimal("0")

    def test_constant_returns(self) -> None:
        """Test with constant returns."""
        returns = [Decimal("0.01")] * 10
        result = skewness(returns)
        # Zero variance -> zero skewness
        assert result == Decimal("0")


class TestKurtosis:
    """Tests for kurtosis function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = kurtosis([])
        assert result == Decimal("0")

    def test_insufficient_data(self) -> None:
        """Test with insufficient data."""
        result = kurtosis([Decimal("0.01"), Decimal("0.02"), Decimal("0.03")])
        assert result == Decimal("0")

    def test_constant_returns(self) -> None:
        """Test with constant returns."""
        returns = [Decimal("0.01")] * 10
        result = kurtosis(returns)
        # Zero variance -> zero kurtosis
        assert result == Decimal("0")

    def test_normal_like_returns(self) -> None:
        """Test with normal-like returns."""
        # Mix of small and moderate returns
        returns = [Decimal("0.01"), Decimal("-0.01"), Decimal("0.02"), Decimal("-0.02"),
                   Decimal("0.005"), Decimal("-0.005"), Decimal("0.015"), Decimal("-0.015")]
        result = kurtosis(returns)
        # Should produce some value
        assert isinstance(result, Decimal)


class TestTailRatio:
    """Tests for tail_ratio function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = tail_ratio([])
        assert result == Decimal("0")

    def test_positive_tail_ratio(self) -> None:
        """Test with favorable tail ratio."""
        # More extreme positive than negative
        returns = [Decimal("-0.02"), Decimal("-0.01"), Decimal("0"), Decimal("0.01"),
                   Decimal("0.03"), Decimal("0.05")]
        result = tail_ratio(returns)
        # Right tail bigger than left
        assert result > Decimal("0")

    def test_zero_left_tail(self) -> None:
        """Test with zero left tail."""
        returns = [Decimal("0"), Decimal("0.01"), Decimal("0.02")]
        result = tail_ratio(returns)
        # Division by zero protection
        assert result == Decimal("0")

    def test_single_return(self) -> None:
        """Test with single return."""
        result = tail_ratio([Decimal("0.01")])
        # Should return some value without error
        assert isinstance(result, Decimal)


class TestCommonSenseRatio:
    """Tests for common_sense_ratio function."""

    def test_basic_calculation(self) -> None:
        """Test basic CSR calculation."""
        result = common_sense_ratio(Decimal("2.0"), Decimal("0.20"))
        # CSR = 2.0 * (1 - 0.20) = 2.0 * 0.80 = 1.6
        assert result == Decimal("1.6")

    def test_no_drawdown(self) -> None:
        """Test with no drawdown."""
        result = common_sense_ratio(Decimal("1.5"), Decimal("0"))
        assert result == Decimal("1.5")

    def test_large_drawdown(self) -> None:
        """Test with large drawdown."""
        result = common_sense_ratio(Decimal("3.0"), Decimal("0.50"))
        # CSR = 3.0 * 0.50 = 1.5
        assert result == Decimal("1.5")


class TestGainToPainRatio:
    """Tests for gain_to_pain_ratio function."""

    def test_empty_returns(self) -> None:
        """Test with empty returns."""
        result = gain_to_pain_ratio([])
        assert result == Decimal("0")

    def test_all_positive(self) -> None:
        """Test with all positive returns."""
        returns = [Decimal("0.01"), Decimal("0.02"), Decimal("0.03")]
        result = gain_to_pain_ratio(returns)
        # No pain, should return high value
        assert result == Decimal("999")

    def test_mixed_returns(self) -> None:
        """Test with mixed returns."""
        returns = [Decimal("0.03"), Decimal("-0.01"), Decimal("0.02")]
        result = gain_to_pain_ratio(returns)
        # Total = 0.04, pain = 0.01
        assert result == Decimal("4")

    def test_zero_sum_returns(self) -> None:
        """Test with zero sum returns."""
        returns = [Decimal("0.01"), Decimal("-0.01")]
        result = gain_to_pain_ratio(returns)
        # Total = 0, pain = 0.01
        assert result == Decimal("0")


class TestRecoveryFactor:
    """Tests for recovery_factor function."""

    def test_basic_calculation(self) -> None:
        """Test basic recovery factor calculation."""
        result = recovery_factor(Decimal("0.50"), Decimal("0.10"))
        # RF = 0.50 / 0.10 = 5
        assert result == Decimal("5")

    def test_zero_drawdown(self) -> None:
        """Test with zero drawdown."""
        result = recovery_factor(Decimal("0.30"), Decimal("0"))
        assert result == Decimal("0")

    def test_negative_return(self) -> None:
        """Test with negative total return."""
        result = recovery_factor(Decimal("-0.10"), Decimal("0.20"))
        assert result == Decimal("-0.5")


class TestKellyCriterion:
    """Tests for kelly_criterion function."""

    def test_basic_kelly(self) -> None:
        """Test basic Kelly calculation."""
        # Win rate 60%, payoff 1.5
        result = kelly_criterion(Decimal("0.60"), Decimal("1.5"))
        # Kelly = 0.60 - (0.40 / 1.5) = 0.60 - 0.267 = 0.333
        assert abs(result - Decimal("0.333")) < Decimal("0.01")

    def test_break_even(self) -> None:
        """Test break-even scenario."""
        # Win rate 50%, payoff 1.0
        result = kelly_criterion(Decimal("0.50"), Decimal("1.0"))
        # Kelly = 0.50 - 0.50 = 0
        assert result == Decimal("0")

    def test_zero_payoff(self) -> None:
        """Test with zero payoff ratio."""
        result = kelly_criterion(Decimal("0.60"), Decimal("0"))
        assert result == Decimal("0")

    def test_negative_kelly(self) -> None:
        """Test when Kelly is negative (don't bet)."""
        # Win rate 30%, payoff 1.0
        result = kelly_criterion(Decimal("0.30"), Decimal("1.0"))
        # Would be negative, but capped at 0
        assert result == Decimal("0")


class TestCalculateStabilityMetrics:
    """Tests for calculate_stability_metrics function."""

    def test_empty_equity(self) -> None:
        """Test with empty equity."""
        result = calculate_stability_metrics([])
        assert isinstance(result, StabilityMetrics)
        assert result.stability_score == Decimal("0")

    def test_complete_metrics(self) -> None:
        """Test complete metrics calculation."""
        equity = [Decimal("100"), Decimal("105"), Decimal("103"), Decimal("108"), Decimal("115")]
        result = calculate_stability_metrics(
            equity,
            profit_factor=Decimal("1.5"),
            max_drawdown=Decimal("0.05"),
        )

        assert isinstance(result, StabilityMetrics)
        assert result.stability_score >= Decimal("0")
        assert result.common_sense_ratio > Decimal("0")

    def test_with_provided_returns(self) -> None:
        """Test with provided returns."""
        equity = [Decimal("100"), Decimal("110"), Decimal("105"), Decimal("120")]
        returns = [Decimal("0.10"), Decimal("-0.045"), Decimal("0.143")]

        result = calculate_stability_metrics(
            equity,
            returns=returns,
            profit_factor=Decimal("2.0"),
            max_drawdown=Decimal("0.10"),
        )

        assert isinstance(result, StabilityMetrics)
        # Should use provided returns for skewness/kurtosis calculations

    def test_metrics_dataclass_fields(self) -> None:
        """Test that all fields are present."""
        equity = [Decimal("100"), Decimal("110"), Decimal("100"), Decimal("120")]
        result = calculate_stability_metrics(equity)

        assert hasattr(result, "stability_score")
        assert hasattr(result, "linearity")
        assert hasattr(result, "skewness")
        assert hasattr(result, "kurtosis")
        assert hasattr(result, "tail_ratio")
        assert hasattr(result, "common_sense_ratio")

    def test_calculates_returns_automatically(self) -> None:
        """Test that returns are calculated from equity."""
        equity = [Decimal("100"), Decimal("110"), Decimal("120"), Decimal("115"), Decimal("130")]
        result = calculate_stability_metrics(equity)

        # Should calculate metrics without error
        assert isinstance(result.skewness, Decimal)
        assert isinstance(result.kurtosis, Decimal)

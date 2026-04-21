"""
Numerical Tolerance Module.

Defines tolerances for comparing reproduced results.

Per §8.3, results are considered equivalent if within tolerance:
| Metric Type       | Absolute Tolerance | Relative Tolerance |
|-------------------|-------------------|-------------------|
| Equity values     | $0.01             | 1e-6              |
| Returns           | —                 | 1e-6              |
| Ratios            | 1e-4              | 1e-4              |
| Trade counts      | 0                 | —                 |
| Signal bars       | 0                 | —                 |

Spec Reference: Technical Spec §8.3
"""

from dataclasses import dataclass
from enum import Enum
from typing import Any


class MetricType(Enum):
    """Types of metrics for tolerance checking."""

    EQUITY = "equity"
    RETURN = "return"
    RATIO = "ratio"
    COUNT = "count"
    SIGNAL = "signal"


@dataclass
class Tolerance:
    """Tolerance specification for a metric type."""

    absolute: float | None = None
    relative: float | None = None

    def is_within(self, expected: float, actual: float) -> bool:
        """
        Check if actual value is within tolerance of expected.

        Args:
            expected: Expected value
            actual: Actual value

        Returns:
            True if within tolerance
        """
        if expected == actual:
            return True

        diff = abs(actual - expected)

        # Check absolute tolerance
        if self.absolute is not None and diff <= self.absolute:
            return True

        # Check relative tolerance
        if self.relative is not None and expected != 0:
            rel_diff = diff / abs(expected)
            if rel_diff <= self.relative:
                return True

        return False


# Standard tolerances per spec §8.3
TOLERANCES: dict[MetricType, Tolerance] = {
    MetricType.EQUITY: Tolerance(absolute=0.01, relative=1e-6),
    MetricType.RETURN: Tolerance(absolute=None, relative=1e-6),
    MetricType.RATIO: Tolerance(absolute=1e-4, relative=1e-4),
    MetricType.COUNT: Tolerance(absolute=0, relative=None),
    MetricType.SIGNAL: Tolerance(absolute=0, relative=None),
}


def get_tolerance(metric_type: MetricType) -> Tolerance:
    """Get tolerance for a metric type."""
    return TOLERANCES.get(metric_type, Tolerance())


def is_equivalent(
    expected: float,
    actual: float,
    metric_type: MetricType,
) -> bool:
    """
    Check if two values are equivalent within tolerance.

    Args:
        expected: Expected value
        actual: Actual value
        metric_type: Type of metric

    Returns:
        True if equivalent
    """
    tolerance = get_tolerance(metric_type)
    return tolerance.is_within(expected, actual)


@dataclass
class ComparisonResult:
    """Result of comparing two values."""

    metric_name: str
    metric_type: MetricType
    expected: float
    actual: float
    equivalent: bool
    absolute_diff: float
    relative_diff: float | None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "metricName": self.metric_name,
            "metricType": self.metric_type.value,
            "expected": self.expected,
            "actual": self.actual,
            "equivalent": self.equivalent,
            "absoluteDiff": self.absolute_diff,
            "relativeDiff": self.relative_diff,
        }


def compare_value(
    metric_name: str,
    expected: float,
    actual: float,
    metric_type: MetricType,
) -> ComparisonResult:
    """
    Compare two values and return detailed result.

    Args:
        metric_name: Name of the metric
        expected: Expected value
        actual: Actual value
        metric_type: Type of metric

    Returns:
        ComparisonResult with details
    """
    equivalent = is_equivalent(expected, actual, metric_type)
    absolute_diff = abs(actual - expected)
    relative_diff = None
    if expected != 0:
        relative_diff = absolute_diff / abs(expected)

    return ComparisonResult(
        metric_name=metric_name,
        metric_type=metric_type,
        expected=expected,
        actual=actual,
        equivalent=equivalent,
        absolute_diff=absolute_diff,
        relative_diff=relative_diff,
    )


@dataclass
class ReproductionComparisonResult:
    """Result of comparing reproduced run to original."""

    all_equivalent: bool
    comparisons: list[ComparisonResult]
    failed_comparisons: list[ComparisonResult]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "allEquivalent": self.all_equivalent,
            "comparisons": [c.to_dict() for c in self.comparisons],
            "failedComparisons": [c.to_dict() for c in self.failed_comparisons],
        }


def compare_results(
    expected_metrics: dict[str, Any],
    actual_metrics: dict[str, Any],
    metric_types: dict[str, MetricType] | None = None,
) -> ReproductionComparisonResult:
    """
    Compare two sets of results.

    Args:
        expected_metrics: Expected metric values
        actual_metrics: Actual metric values
        metric_types: Mapping of metric names to types

    Returns:
        ReproductionComparisonResult
    """
    # Default metric type mappings
    default_types = {
        "total_return": MetricType.RETURN,
        "cagr": MetricType.RETURN,
        "sharpe_ratio": MetricType.RATIO,
        "sortino_ratio": MetricType.RATIO,
        "calmar_ratio": MetricType.RATIO,
        "max_drawdown": MetricType.RETURN,
        "win_rate": MetricType.RATIO,
        "profit_factor": MetricType.RATIO,
        "total_trades": MetricType.COUNT,
        "winning_trades": MetricType.COUNT,
        "losing_trades": MetricType.COUNT,
        "initial_capital": MetricType.EQUITY,
        "final_equity": MetricType.EQUITY,
    }

    types = metric_types or {}
    types = {**default_types, **types}

    comparisons: list[ComparisonResult] = []

    for name, expected_value in expected_metrics.items():
        if name not in actual_metrics:
            continue

        actual_value = actual_metrics[name]

        # Skip non-numeric values
        if not isinstance(expected_value, (int, float)) or not isinstance(
            actual_value, (int, float)
        ):
            continue

        metric_type = types.get(name, MetricType.RATIO)
        comparison = compare_value(name, expected_value, actual_value, metric_type)
        comparisons.append(comparison)

    failed = [c for c in comparisons if not c.equivalent]

    return ReproductionComparisonResult(
        all_equivalent=len(failed) == 0,
        comparisons=comparisons,
        failed_comparisons=failed,
    )

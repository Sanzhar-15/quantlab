"""
Benchmark Analysis Module.

Provides statistical analysis and visualization of benchmark results.
"""

import json
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class AnalysisResult:
    """Analysis of benchmark results."""

    name: str
    run_count: int
    mean: float
    median: float
    std: float
    min: float
    max: float
    p50: float
    p75: float
    p90: float
    p95: float
    p99: float
    variance: float
    coefficient_of_variation: float  # std / mean


def load_results(filepath: Path) -> dict[str, Any]:
    """Load benchmark results from JSON file."""
    with filepath.open() as f:
        return json.load(f)


def analyze_benchmark(name: str, runs: list[float]) -> AnalysisResult:
    """Perform statistical analysis on benchmark runs."""
    if not runs:
        return AnalysisResult(
            name=name,
            run_count=0,
            mean=0,
            median=0,
            std=0,
            min=0,
            max=0,
            p50=0,
            p75=0,
            p90=0,
            p95=0,
            p99=0,
            variance=0,
            coefficient_of_variation=0,
        )

    sorted_runs = sorted(runs)
    n = len(sorted_runs)

    def percentile(p: float) -> float:
        """Calculate percentile value."""
        k = (n - 1) * p / 100
        f = int(k)
        c = f + 1 if f + 1 < n else f
        return sorted_runs[f] + (k - f) * (sorted_runs[c] - sorted_runs[f])

    mean = statistics.mean(runs)
    std = statistics.stdev(runs) if n > 1 else 0

    return AnalysisResult(
        name=name,
        run_count=n,
        mean=mean,
        median=statistics.median(runs),
        std=std,
        min=min(runs),
        max=max(runs),
        p50=percentile(50),
        p75=percentile(75),
        p90=percentile(90),
        p95=percentile(95),
        p99=percentile(99),
        variance=statistics.variance(runs) if n > 1 else 0,
        coefficient_of_variation=std / mean if mean > 0 else 0,
    )


def compare_results(
    baseline: dict[str, Any],
    current: dict[str, Any],
) -> dict[str, dict[str, float]]:
    """
    Compare current results against baseline.

    Returns dict mapping benchmark name to comparison metrics.
    """
    comparisons = {}

    baseline_by_name = {r["name"]: r for r in baseline.get("results", [])}
    current_by_name = {r["name"]: r for r in current.get("results", [])}

    for name in set(baseline_by_name.keys()) | set(current_by_name.keys()):
        baseline_result = baseline_by_name.get(name)
        current_result = current_by_name.get(name)

        if baseline_result and current_result:
            baseline_p95 = baseline_result.get("p95", 0)
            current_p95 = current_result.get("p95", 0)

            if baseline_p95 > 0:
                change_ratio = current_p95 / baseline_p95
                change_percent = (change_ratio - 1) * 100
            else:
                change_ratio = float("inf") if current_p95 > 0 else 1.0
                change_percent = float("inf") if current_p95 > 0 else 0

            comparisons[name] = {
                "baseline_p95": baseline_p95,
                "current_p95": current_p95,
                "change_ratio": change_ratio,
                "change_percent": change_percent,
                "regression": change_ratio > 1.0,
            }
        elif current_result:
            comparisons[name] = {
                "baseline_p95": None,
                "current_p95": current_result.get("p95", 0),
                "change_ratio": None,
                "change_percent": None,
                "regression": False,
                "note": "New benchmark (no baseline)",
            }
        else:
            comparisons[name] = {
                "baseline_p95": baseline_result.get("p95", 0) if baseline_result else 0,
                "current_p95": None,
                "change_ratio": None,
                "change_percent": None,
                "regression": False,
                "note": "Missing in current run",
            }

    return comparisons


def format_analysis(analysis: AnalysisResult) -> str:
    """Format analysis result as human-readable text."""
    return f"""
Benchmark: {analysis.name}
{'=' * 50}
Runs:     {analysis.run_count}
Mean:     {analysis.mean:.4f}s
Median:   {analysis.median:.4f}s
Std Dev:  {analysis.std:.4f}s
Min:      {analysis.min:.4f}s
Max:      {analysis.max:.4f}s

Percentiles:
  p50:    {analysis.p50:.4f}s
  p75:    {analysis.p75:.4f}s
  p90:    {analysis.p90:.4f}s
  p95:    {analysis.p95:.4f}s
  p99:    {analysis.p99:.4f}s

CV:       {analysis.coefficient_of_variation:.2%}
"""


def format_comparison(comparisons: dict[str, dict[str, float]]) -> str:
    """Format comparison results as human-readable text."""
    lines = [
        "BENCHMARK COMPARISON",
        "=" * 70,
        f"{'Name':<20} {'Baseline':>12} {'Current':>12} {'Change':>12} {'Status':>10}",
        "-" * 70,
    ]

    for name, comp in sorted(comparisons.items()):
        baseline = f"{comp['baseline_p95']:.3f}s" if comp["baseline_p95"] else "N/A"
        current = f"{comp['current_p95']:.3f}s" if comp["current_p95"] else "N/A"

        if comp.get("change_percent") is not None:
            change = f"{comp['change_percent']:+.1f}%"
            status = "REGRESS" if comp["regression"] else "OK"
        else:
            change = comp.get("note", "N/A")[:12]
            status = "-"

        lines.append(f"{name:<20} {baseline:>12} {current:>12} {change:>12} {status:>10}")

    lines.append("=" * 70)
    return "\n".join(lines)

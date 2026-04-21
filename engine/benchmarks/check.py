"""
Benchmark Regression Checker.

Compares current benchmark results against a baseline and fails if
regression exceeds threshold.

Usage:
    python -m benchmarks.check --baseline baseline.json --current current.json --threshold 1.5
    python -m benchmarks.check --baseline main --threshold 1.5  # Uses git to fetch baseline
"""

import argparse
import json
import sys
from pathlib import Path

from .analysis import compare_results
from .analysis import format_comparison
from .analysis import load_results


# Threshold multipliers by benchmark type
DEFAULT_THRESHOLDS = {
    "bench_small": 1.5,   # 50% regression allowed
    "bench_medium": 1.5,  # 50% regression allowed
    "bench_large": 1.25,  # 25% regression allowed (large tests are more stable)
    "bench_multi": 1.5,   # 50% regression allowed
}


def check_regression(
    baseline_path: Path,
    current_path: Path,
    threshold: float | None = None,
    thresholds: dict[str, float] | None = None,
) -> tuple[bool, str]:
    """
    Check for performance regressions.

    Args:
        baseline_path: Path to baseline results JSON
        current_path: Path to current results JSON
        threshold: Global threshold multiplier (default 1.5 = 50% slower allowed)
        thresholds: Per-benchmark threshold overrides

    Returns:
        Tuple of (passed: bool, report: str)
    """
    if thresholds is None:
        thresholds = DEFAULT_THRESHOLDS.copy()

    if threshold is not None:
        # Override all thresholds with global value
        thresholds = {k: threshold for k in thresholds}

    baseline = load_results(baseline_path)
    current = load_results(current_path)

    comparisons = compare_results(baseline, current)

    regressions = []
    for name, comp in comparisons.items():
        if comp.get("change_ratio") is not None:
            bench_threshold = thresholds.get(name, 1.5)
            if comp["change_ratio"] > bench_threshold:
                regressions.append({
                    "name": name,
                    "baseline_p95": comp["baseline_p95"],
                    "current_p95": comp["current_p95"],
                    "change_ratio": comp["change_ratio"],
                    "threshold": bench_threshold,
                })

    report_lines = [format_comparison(comparisons), ""]

    if regressions:
        report_lines.extend([
            "REGRESSIONS DETECTED:",
            "-" * 50,
        ])
        for reg in regressions:
            report_lines.append(
                f"  {reg['name']}: {reg['change_ratio']:.2f}x slower "
                f"(threshold: {reg['threshold']:.2f}x)"
            )
        report_lines.append("")
        report_lines.append("FAILED: Performance regression detected")
        return False, "\n".join(report_lines)

    report_lines.append("PASSED: No significant regressions detected")
    return True, "\n".join(report_lines)


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="Check for benchmark regressions")
    parser.add_argument(
        "--baseline", "-b",
        required=True,
        help="Baseline results JSON file or git ref (e.g., 'main')",
    )
    parser.add_argument(
        "--current", "-c",
        default="benchmark-results.json",
        help="Current results JSON file",
    )
    parser.add_argument(
        "--threshold", "-t",
        type=float,
        help="Global regression threshold multiplier (e.g., 1.5 = 50%% slower allowed)",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Use strict thresholds (1.1 = 10%% slower allowed)",
    )
    args = parser.parse_args()

    # Determine baseline path
    baseline_path = Path(args.baseline)
    if not baseline_path.exists():
        # TODO: Implement git-based baseline fetching
        print(f"Error: Baseline file not found: {baseline_path}")
        print("Note: Git-based baseline fetching not yet implemented")
        sys.exit(1)

    current_path = Path(args.current)
    if not current_path.exists():
        print(f"Error: Current results file not found: {current_path}")
        sys.exit(1)

    threshold = args.threshold
    if args.strict:
        threshold = 1.1

    passed, report = check_regression(
        baseline_path=baseline_path,
        current_path=current_path,
        threshold=threshold,
    )

    print(report)
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()

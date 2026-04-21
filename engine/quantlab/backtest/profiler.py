"""
Backtest Performance Profiler.

Provides detailed timing and performance metrics for backtests
to identify bottlenecks and optimize execution.

Usage:
    profiler = BacktestProfiler()

    with profiler.section("order_processing"):
        process_orders()

    with profiler.section("strategy_evaluation"):
        evaluate_strategy()

    report = profiler.get_report()

Spec Reference: Technical Spec §17 (Diagnostics)
"""

import functools
import logging
import statistics
import time
from contextlib import contextmanager
from dataclasses import dataclass
from dataclasses import field
from decimal import Decimal
from typing import Any
from typing import Callable
from typing import Generator

logger = logging.getLogger(__name__)


@dataclass
class TimingRecord:
    """Record of a single timing measurement."""

    section: str
    duration_ms: float
    bar_index: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class SectionStats:
    """Aggregated statistics for a timing section."""

    section: str
    call_count: int
    total_ms: float
    min_ms: float
    max_ms: float
    mean_ms: float
    median_ms: float
    std_ms: float
    p95_ms: float
    p99_ms: float

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "section": self.section,
            "call_count": self.call_count,
            "total_ms": round(self.total_ms, 3),
            "min_ms": round(self.min_ms, 3),
            "max_ms": round(self.max_ms, 3),
            "mean_ms": round(self.mean_ms, 3),
            "median_ms": round(self.median_ms, 3),
            "std_ms": round(self.std_ms, 3),
            "p95_ms": round(self.p95_ms, 3),
            "p99_ms": round(self.p99_ms, 3),
            "pct_of_total": 0.0,  # Set by profiler
        }


@dataclass
class ProfileReport:
    """Complete profiling report."""

    total_duration_ms: float
    sections: list[SectionStats]
    bar_count: int
    orders_processed: int
    fills_executed: int
    avg_bar_ms: float
    slowest_bar_index: int | None
    slowest_bar_ms: float
    memory_peak_mb: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "total_duration_ms": round(self.total_duration_ms, 3),
            "total_duration_s": round(self.total_duration_ms / 1000, 2),
            "bar_count": self.bar_count,
            "orders_processed": self.orders_processed,
            "fills_executed": self.fills_executed,
            "avg_bar_ms": round(self.avg_bar_ms, 3),
            "slowest_bar_index": self.slowest_bar_index,
            "slowest_bar_ms": round(self.slowest_bar_ms, 3) if self.slowest_bar_ms else None,
            "memory_peak_mb": round(self.memory_peak_mb, 2) if self.memory_peak_mb else None,
            "sections": [s.to_dict() for s in self.sections],
            "metadata": self.metadata,
        }

    def summary(self) -> str:
        """Get human-readable summary."""
        lines = [
            f"Backtest Profile Report",
            f"=" * 50,
            f"Total Duration: {self.total_duration_ms:.1f}ms ({self.total_duration_ms/1000:.2f}s)",
            f"Bars Processed: {self.bar_count}",
            f"Average per Bar: {self.avg_bar_ms:.3f}ms",
            f"Orders Processed: {self.orders_processed}",
            f"Fills Executed: {self.fills_executed}",
        ]

        if self.slowest_bar_index is not None:
            lines.append(f"Slowest Bar: #{self.slowest_bar_index} ({self.slowest_bar_ms:.3f}ms)")

        if self.memory_peak_mb:
            lines.append(f"Peak Memory: {self.memory_peak_mb:.1f}MB")

        lines.append("")
        lines.append("Section Breakdown:")
        lines.append("-" * 50)

        # Sort sections by total time descending
        sorted_sections = sorted(self.sections, key=lambda s: s.total_ms, reverse=True)

        for section in sorted_sections:
            pct = (section.total_ms / self.total_duration_ms * 100) if self.total_duration_ms > 0 else 0
            lines.append(
                f"  {section.section:25s} {section.total_ms:8.1f}ms "
                f"({pct:5.1f}%) [{section.call_count:6d} calls, {section.mean_ms:.3f}ms avg]"
            )

        return "\n".join(lines)


class BacktestProfiler:
    """
    Profile backtest execution for performance analysis.

    Features:
    - Section-based timing with nested support
    - Per-bar timing tracking
    - Statistical aggregation (mean, median, P95, P99)
    - Memory usage tracking (optional)
    - Export to JSON/dict

    Usage:
        profiler = BacktestProfiler()
        profiler.start()

        for bar in bars:
            profiler.set_bar(bar_index)

            with profiler.section("order_processing"):
                process_orders()

            with profiler.section("strategy"):
                evaluate()

        report = profiler.stop()
        print(report.summary())
    """

    def __init__(self, track_memory: bool = True) -> None:
        """
        Initialize profiler.

        Args:
            track_memory: Whether to track memory usage (requires psutil)
        """
        self._track_memory = track_memory
        self._records: list[TimingRecord] = []
        self._start_time: float | None = None
        self._end_time: float | None = None
        self._current_bar: int | None = None
        self._bar_times: dict[int, float] = {}
        self._orders_processed = 0
        self._fills_executed = 0
        self._memory_peak_mb: float | None = None
        self._enabled = True

        # Try to import psutil for memory tracking
        self._psutil = None
        if track_memory:
            try:
                import psutil
                self._psutil = psutil
            except ImportError:
                logger.debug("psutil not available, memory tracking disabled")

    @property
    def is_running(self) -> bool:
        """Check if profiler is currently running."""
        return self._start_time is not None and self._end_time is None

    def enable(self) -> None:
        """Enable profiling."""
        self._enabled = True

    def disable(self) -> None:
        """Disable profiling (no-op sections)."""
        self._enabled = False

    def start(self) -> None:
        """Start profiling session."""
        self._records.clear()
        self._bar_times.clear()
        self._orders_processed = 0
        self._fills_executed = 0
        self._memory_peak_mb = None
        self._start_time = time.perf_counter()
        self._end_time = None

        if self._psutil:
            process = self._psutil.Process()
            self._memory_peak_mb = process.memory_info().rss / (1024 * 1024)

    def stop(self) -> ProfileReport:
        """
        Stop profiling and generate report.

        Returns:
            ProfileReport with all metrics
        """
        self._end_time = time.perf_counter()

        if self._psutil:
            process = self._psutil.Process()
            current_mem = process.memory_info().rss / (1024 * 1024)
            if self._memory_peak_mb is None or current_mem > self._memory_peak_mb:
                self._memory_peak_mb = current_mem

        return self.get_report()

    def set_bar(self, bar_index: int) -> None:
        """Set current bar index for timing context."""
        self._current_bar = bar_index

    def record_bar_time(self, bar_index: int, duration_ms: float) -> None:
        """Record total time for a bar."""
        self._bar_times[bar_index] = duration_ms

    def record_order(self) -> None:
        """Record that an order was processed."""
        self._orders_processed += 1

    def record_fill(self) -> None:
        """Record that a fill was executed."""
        self._fills_executed += 1

    @contextmanager
    def section(self, name: str, **metadata: Any) -> Generator[None, None, None]:
        """
        Time a section of code.

        Args:
            name: Section name
            **metadata: Additional metadata to record

        Usage:
            with profiler.section("order_processing"):
                process_orders()
        """
        if not self._enabled:
            yield
            return

        start = time.perf_counter()
        try:
            yield
        finally:
            end = time.perf_counter()
            duration_ms = (end - start) * 1000

            self._records.append(TimingRecord(
                section=name,
                duration_ms=duration_ms,
                bar_index=self._current_bar,
                metadata=metadata,
            ))

    def timed(self, section_name: str) -> Callable:
        """
        Decorator to time a function.

        Args:
            section_name: Name for the timing section

        Usage:
            @profiler.timed("strategy_evaluation")
            def evaluate_strategy():
                ...
        """
        def decorator(func: Callable) -> Callable:
            @functools.wraps(func)
            def wrapper(*args: Any, **kwargs: Any) -> Any:
                with self.section(section_name):
                    return func(*args, **kwargs)
            return wrapper
        return decorator

    def get_report(self) -> ProfileReport:
        """
        Generate profiling report.

        Returns:
            ProfileReport with aggregated statistics
        """
        total_duration_ms = 0.0
        if self._start_time and self._end_time:
            total_duration_ms = (self._end_time - self._start_time) * 1000
        elif self._start_time:
            total_duration_ms = (time.perf_counter() - self._start_time) * 1000

        # Aggregate by section
        section_records: dict[str, list[float]] = {}
        for record in self._records:
            if record.section not in section_records:
                section_records[record.section] = []
            section_records[record.section].append(record.duration_ms)

        sections = []
        for section_name, durations in section_records.items():
            if not durations:
                continue

            sorted_durations = sorted(durations)
            n = len(sorted_durations)

            sections.append(SectionStats(
                section=section_name,
                call_count=n,
                total_ms=sum(durations),
                min_ms=min(durations),
                max_ms=max(durations),
                mean_ms=statistics.mean(durations),
                median_ms=statistics.median(durations),
                std_ms=statistics.stdev(durations) if n > 1 else 0.0,
                p95_ms=sorted_durations[int(n * 0.95)] if n > 0 else 0.0,
                p99_ms=sorted_durations[int(n * 0.99)] if n > 0 else 0.0,
            ))

        # Find slowest bar
        slowest_bar_index = None
        slowest_bar_ms = 0.0
        if self._bar_times:
            slowest_bar_index = max(self._bar_times, key=self._bar_times.get)
            slowest_bar_ms = self._bar_times[slowest_bar_index]

        bar_count = len(self._bar_times) if self._bar_times else max(
            (r.bar_index or 0 for r in self._records), default=0
        ) + 1

        avg_bar_ms = total_duration_ms / bar_count if bar_count > 0 else 0.0

        return ProfileReport(
            total_duration_ms=total_duration_ms,
            sections=sections,
            bar_count=bar_count,
            orders_processed=self._orders_processed,
            fills_executed=self._fills_executed,
            avg_bar_ms=avg_bar_ms,
            slowest_bar_index=slowest_bar_index,
            slowest_bar_ms=slowest_bar_ms,
            memory_peak_mb=self._memory_peak_mb,
        )

    def get_section_stats(self, section: str) -> SectionStats | None:
        """Get statistics for a specific section."""
        durations = [
            r.duration_ms for r in self._records if r.section == section
        ]

        if not durations:
            return None

        sorted_durations = sorted(durations)
        n = len(sorted_durations)

        return SectionStats(
            section=section,
            call_count=n,
            total_ms=sum(durations),
            min_ms=min(durations),
            max_ms=max(durations),
            mean_ms=statistics.mean(durations),
            median_ms=statistics.median(durations),
            std_ms=statistics.stdev(durations) if n > 1 else 0.0,
            p95_ms=sorted_durations[int(n * 0.95)] if n > 0 else 0.0,
            p99_ms=sorted_durations[int(n * 0.99)] if n > 0 else 0.0,
        )

    def clear(self) -> None:
        """Clear all recorded data."""
        self._records.clear()
        self._bar_times.clear()
        self._start_time = None
        self._end_time = None
        self._current_bar = None
        self._orders_processed = 0
        self._fills_executed = 0
        self._memory_peak_mb = None

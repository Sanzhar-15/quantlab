"""
Memory Monitoring with OOM Handling.

Provides memory tracking, limits, and graceful degradation.

Spec Reference: Technical Spec §10.1
"""

import gc
import logging
import os
import signal
import threading
import time
from dataclasses import dataclass
from dataclasses import field
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any
from typing import Callable


logger = logging.getLogger(__name__)

try:
    import psutil

    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False
    logger.warning(
        "psutil not installed. Memory monitoring features will be limited. "
        "Install with: pip install psutil"
    )


class MemoryUnit(Enum):
    """Memory size units."""

    BYTES = 1
    KB = 1024
    MB = 1024 * 1024
    GB = 1024 * 1024 * 1024


@dataclass
class MemorySnapshot:
    """Snapshot of memory usage."""

    timestamp: float
    rss_bytes: int  # Resident Set Size
    vms_bytes: int  # Virtual Memory Size
    shared_bytes: int
    percent: float
    available_bytes: int
    total_bytes: int

    @property
    def rss_mb(self) -> float:
        """RSS in megabytes."""
        return self.rss_bytes / MemoryUnit.MB.value

    @property
    def vms_mb(self) -> float:
        """VMS in megabytes."""
        return self.vms_bytes / MemoryUnit.MB.value

    @property
    def available_mb(self) -> float:
        """Available memory in megabytes."""
        return self.available_bytes / MemoryUnit.MB.value


@dataclass
class MemoryLimits:
    """Memory limit configuration."""

    soft_limit_mb: int = 4096  # 4GB soft limit
    hard_limit_mb: int = 8192  # 8GB hard limit
    warning_threshold: float = 0.75  # 75% of soft limit
    critical_threshold: float = 0.90  # 90% of soft limit


class MemoryAction(Enum):
    """Actions to take when memory thresholds are exceeded."""

    NONE = "none"
    LOG_WARNING = "log_warning"
    FORCE_GC = "force_gc"
    PAUSE_PROCESSING = "pause_processing"
    ABORT = "abort"


@dataclass
class MemoryEvent:
    """Memory-related event."""

    timestamp: float
    event_type: str
    snapshot: MemorySnapshot
    message: str
    action_taken: MemoryAction


class MemoryMonitor:
    """
    Monitor and manage memory usage.

    Features:
    - Track memory usage over time
    - Enforce soft/hard limits
    - Trigger garbage collection
    - Graceful degradation on OOM risk
    """

    def __init__(
        self,
        limits: MemoryLimits | None = None,
        check_interval_sec: float = 1.0,
        enable_monitoring: bool = True,
    ) -> None:
        """
        Initialize memory monitor.

        Args:
            limits: Memory limits configuration
            check_interval_sec: How often to check memory
            enable_monitoring: Whether to enable background monitoring
        """
        self.limits = limits or MemoryLimits()
        self.check_interval_sec = check_interval_sec
        self.enable_monitoring = enable_monitoring

        self._history: list[MemorySnapshot] = []
        self._events: list[MemoryEvent] = []
        self._callbacks: list[Callable[[MemoryEvent], None]] = []

        self._monitor_thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._paused = threading.Event()
        self._paused.set()  # Not paused initially

        self._peak_rss_bytes = 0
        self._gc_count = 0

    def start(self) -> None:
        """Start background monitoring."""
        if not self.enable_monitoring:
            return

        if not HAS_PSUTIL:
            return

        if self._monitor_thread is not None and self._monitor_thread.is_alive():
            return

        self._stop_event.clear()
        self._monitor_thread = threading.Thread(
            target=self._monitoring_loop,
            daemon=True,
            name="QuantlabMemoryMonitor",
        )
        self._monitor_thread.start()

    def stop(self) -> None:
        """Stop background monitoring."""
        self._stop_event.set()

        if self._monitor_thread is not None:
            self._monitor_thread.join(timeout=5.0)
            self._monitor_thread = None

    def _monitoring_loop(self) -> None:
        """Background monitoring loop."""
        while not self._stop_event.is_set():
            try:
                snapshot = self.take_snapshot()

                if snapshot is not None:
                    self._check_limits(snapshot)

            except Exception:
                pass  # Don't crash monitor on errors

            time.sleep(self.check_interval_sec)

    def take_snapshot(self) -> MemorySnapshot | None:
        """
        Take a memory snapshot.

        Returns:
            MemorySnapshot or None if psutil not available
        """
        if not HAS_PSUTIL:
            return None

        process = psutil.Process()
        mem_info = process.memory_info()
        virtual_mem = psutil.virtual_memory()

        snapshot = MemorySnapshot(
            timestamp=time.time(),
            rss_bytes=mem_info.rss,
            vms_bytes=mem_info.vms,
            shared_bytes=getattr(mem_info, "shared", 0),
            percent=process.memory_percent(),
            available_bytes=virtual_mem.available,
            total_bytes=virtual_mem.total,
        )

        self._history.append(snapshot)

        # Track peak
        if snapshot.rss_bytes > self._peak_rss_bytes:
            self._peak_rss_bytes = snapshot.rss_bytes

        # Limit history size
        max_history = 3600  # ~1 hour at 1 sec intervals
        if len(self._history) > max_history:
            self._history = self._history[-max_history:]

        return snapshot

    def _check_limits(self, snapshot: MemorySnapshot) -> None:
        """Check memory limits and take action if needed."""
        rss_mb = snapshot.rss_mb
        soft_limit = self.limits.soft_limit_mb

        # Calculate threshold levels
        warning_level = soft_limit * self.limits.warning_threshold
        critical_level = soft_limit * self.limits.critical_threshold

        if rss_mb >= self.limits.hard_limit_mb:
            # Hard limit exceeded - abort
            event = MemoryEvent(
                timestamp=time.time(),
                event_type="hard_limit_exceeded",
                snapshot=snapshot,
                message=f"Hard memory limit exceeded: {rss_mb:.1f}MB >= {self.limits.hard_limit_mb}MB",
                action_taken=MemoryAction.ABORT,
            )
            self._record_event(event)
            self._handle_abort()

        elif rss_mb >= critical_level:
            # Critical threshold - pause and GC
            event = MemoryEvent(
                timestamp=time.time(),
                event_type="critical_threshold",
                snapshot=snapshot,
                message=f"Critical memory threshold: {rss_mb:.1f}MB >= {critical_level:.1f}MB",
                action_taken=MemoryAction.PAUSE_PROCESSING,
            )
            self._record_event(event)
            self._handle_critical()

        elif rss_mb >= warning_level:
            # Warning threshold - force GC
            event = MemoryEvent(
                timestamp=time.time(),
                event_type="warning_threshold",
                snapshot=snapshot,
                message=f"Memory warning threshold: {rss_mb:.1f}MB >= {warning_level:.1f}MB",
                action_taken=MemoryAction.FORCE_GC,
            )
            self._record_event(event)
            self._handle_warning()

    def _record_event(self, event: MemoryEvent) -> None:
        """Record memory event and notify callbacks."""
        self._events.append(event)

        # Limit events history
        max_events = 1000
        if len(self._events) > max_events:
            self._events = self._events[-max_events:]

        # Notify callbacks
        for callback in self._callbacks:
            try:
                callback(event)
            except Exception:
                pass

    def _handle_warning(self) -> None:
        """Handle warning threshold."""
        self.force_gc()

    def _handle_critical(self) -> None:
        """Handle critical threshold."""
        self._paused.clear()  # Pause processing
        self.force_gc()

        # Check if GC helped
        snapshot = self.take_snapshot()
        if snapshot is not None:
            rss_mb = snapshot.rss_mb
            critical_level = self.limits.soft_limit_mb * self.limits.critical_threshold

            if rss_mb < critical_level:
                self._paused.set()  # Resume

    def _handle_abort(self) -> None:
        """Handle hard limit exceeded."""
        # Signal abort to main process
        os.kill(os.getpid(), signal.SIGTERM)

    def force_gc(self) -> int:
        """
        Force garbage collection.

        Returns:
            Number of objects collected
        """
        self._gc_count += 1

        # Run full collection
        collected = gc.collect(generation=2)

        return collected

    def register_callback(
        self,
        callback: Callable[[MemoryEvent], None],
    ) -> None:
        """Register callback for memory events."""
        self._callbacks.append(callback)

    def unregister_callback(
        self,
        callback: Callable[[MemoryEvent], None],
    ) -> None:
        """Unregister callback."""
        if callback in self._callbacks:
            self._callbacks.remove(callback)

    def wait_if_paused(self, timeout: float | None = None) -> bool:
        """
        Wait if processing is paused due to memory pressure.

        Args:
            timeout: Maximum time to wait

        Returns:
            True if not paused (or became unpaused), False if timed out
        """
        return self._paused.wait(timeout=timeout)

    def is_paused(self) -> bool:
        """Check if processing is paused."""
        return not self._paused.is_set()

    def resume(self) -> None:
        """Resume processing (manual override)."""
        self._paused.set()

    def get_current_usage(self) -> dict[str, Any]:
        """Get current memory usage."""
        snapshot = self.take_snapshot()

        if snapshot is None:
            return {"error": "psutil not available"}

        return {
            "rss_mb": snapshot.rss_mb,
            "vms_mb": snapshot.vms_mb,
            "available_mb": snapshot.available_mb,
            "percent": snapshot.percent,
            "peak_rss_mb": self._peak_rss_bytes / MemoryUnit.MB.value,
            "gc_count": self._gc_count,
            "is_paused": self.is_paused(),
        }

    def get_history(
        self,
        last_n: int | None = None,
    ) -> list[MemorySnapshot]:
        """Get memory history."""
        if last_n is not None:
            return self._history[-last_n:]
        return self._history.copy()

    def get_events(
        self,
        event_type: str | None = None,
    ) -> list[MemoryEvent]:
        """Get memory events, optionally filtered by type."""
        if event_type is not None:
            return [e for e in self._events if e.event_type == event_type]
        return self._events.copy()

    def reset_peak(self) -> None:
        """Reset peak memory tracking."""
        snapshot = self.take_snapshot()
        if snapshot is not None:
            self._peak_rss_bytes = snapshot.rss_bytes

    def __enter__(self) -> "MemoryMonitor":
        """Context manager entry."""
        self.start()
        return self

    def __exit__(self, *args: Any) -> None:
        """Context manager exit."""
        self.stop()


class MemoryTracker:
    """
    Track memory allocation for specific operations.

    Useful for profiling memory usage of backtest runs.
    """

    def __init__(self) -> None:
        """Initialize memory tracker."""
        self._allocations: dict[str, list[tuple[float, int]]] = {}
        self._start_rss: int = 0

    def start_tracking(self, label: str) -> None:
        """Start tracking memory for an operation."""
        if not HAS_PSUTIL:
            return

        process = psutil.Process()
        self._start_rss = process.memory_info().rss

        if label not in self._allocations:
            self._allocations[label] = []

    def end_tracking(self, label: str) -> int:
        """
        End tracking and record allocation.

        Returns:
            Bytes allocated during operation
        """
        if not HAS_PSUTIL:
            return 0

        process = psutil.Process()
        end_rss = process.memory_info().rss
        allocated = end_rss - self._start_rss

        if label in self._allocations:
            self._allocations[label].append((time.time(), allocated))

        return allocated

    def get_allocations(self, label: str) -> list[tuple[float, int]]:
        """Get allocation history for a label."""
        return self._allocations.get(label, [])

    def get_total_allocated(self, label: str) -> int:
        """Get total bytes allocated for a label."""
        allocations = self._allocations.get(label, [])
        return sum(alloc for _, alloc in allocations)

    def get_average_allocation(self, label: str) -> float:
        """Get average allocation for a label."""
        allocations = self._allocations.get(label, [])
        if not allocations:
            return 0.0
        return sum(alloc for _, alloc in allocations) / len(allocations)

    def clear(self) -> None:
        """Clear all tracking data."""
        self._allocations.clear()
        self._start_rss = 0


@dataclass
class OOMConfig:
    """Out-of-memory handling configuration."""

    enable_oom_killer: bool = True
    pre_oom_gc: bool = True
    dump_heap_on_oom: bool = False
    heap_dump_path: Path | None = None


class OOMHandler:
    """
    Handle out-of-memory situations gracefully.

    Features:
    - Attempt recovery through GC
    - Optional heap dump for debugging
    - Graceful shutdown
    """

    def __init__(
        self,
        config: OOMConfig | None = None,
    ) -> None:
        """Initialize OOM handler."""
        self.config = config or OOMConfig()
        self._oom_callbacks: list[Callable[[], None]] = []
        self._is_handling_oom = False

    def register_oom_callback(
        self,
        callback: Callable[[], None],
    ) -> None:
        """Register callback to be called on OOM."""
        self._oom_callbacks.append(callback)

    def handle_oom(self, context: str = "") -> bool:
        """
        Handle an out-of-memory situation.

        Args:
            context: Description of what was happening

        Returns:
            True if recovery was successful
        """
        if self._is_handling_oom:
            return False

        self._is_handling_oom = True

        try:
            # Try GC first
            if self.config.pre_oom_gc:
                gc.collect(generation=2)

                # Check if GC helped
                if HAS_PSUTIL:
                    process = psutil.Process()
                    mem_percent = process.memory_percent()

                    if mem_percent < 80:  # Under 80% is acceptable
                        return True

            # Dump heap if configured
            if self.config.dump_heap_on_oom and self.config.heap_dump_path:
                self._dump_heap()

            # Notify callbacks
            for callback in self._oom_callbacks:
                try:
                    callback()
                except Exception:
                    pass

            return False

        finally:
            self._is_handling_oom = False

    def _dump_heap(self) -> None:
        """Dump heap for debugging."""
        if self.config.heap_dump_path is None:
            return

        try:
            import tracemalloc

            if tracemalloc.is_tracing():
                snapshot = tracemalloc.take_snapshot()
                stats = snapshot.statistics("lineno")

                dump_path = self.config.heap_dump_path / f"heap_{time.time():.0f}.txt"

                with open(dump_path, "w") as f:
                    f.write(f"Heap dump at {time.ctime()}\n")
                    f.write("=" * 60 + "\n\n")

                    for stat in stats[:100]:
                        f.write(f"{stat}\n")

        except Exception:
            pass


def get_memory_info() -> dict[str, Any]:
    """
    Get current memory information.

    Returns:
        Dictionary with memory stats
    """
    if not HAS_PSUTIL:
        return {"error": "psutil not available"}

    process = psutil.Process()
    mem_info = process.memory_info()
    virtual_mem = psutil.virtual_memory()

    return {
        "process": {
            "rss_mb": mem_info.rss / MemoryUnit.MB.value,
            "vms_mb": mem_info.vms / MemoryUnit.MB.value,
            "percent": process.memory_percent(),
        },
        "system": {
            "total_mb": virtual_mem.total / MemoryUnit.MB.value,
            "available_mb": virtual_mem.available / MemoryUnit.MB.value,
            "percent_used": virtual_mem.percent,
        },
    }

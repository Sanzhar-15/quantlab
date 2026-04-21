"""
Disk Space Monitoring and Management.

Provides disk space tracking, alerts at configurable thresholds,
and cleanup actions.

Spec Reference: Technical Spec §10.2 (Resource Management)
"""

import logging
import os
import shutil
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from datetime import timedelta
from enum import Enum
from pathlib import Path
from typing import Any
from typing import Callable


logger = logging.getLogger(__name__)


class DiskAlertLevel(Enum):
    """Disk space alert severity levels."""

    NORMAL = "normal"  # < 90% used
    WARNING = "warning"  # 90-95% used
    CRITICAL = "critical"  # 95-99% used
    EMERGENCY = "emergency"  # >= 99% used


@dataclass
class DiskSnapshot:
    """Snapshot of disk space usage."""

    timestamp: float
    path: str
    total_bytes: int
    used_bytes: int
    free_bytes: int
    percent_used: float

    @property
    def total_gb(self) -> float:
        """Total space in gigabytes."""
        return self.total_bytes / (1024**3)

    @property
    def used_gb(self) -> float:
        """Used space in gigabytes."""
        return self.used_bytes / (1024**3)

    @property
    def free_gb(self) -> float:
        """Free space in gigabytes."""
        return self.free_bytes / (1024**3)

    @property
    def alert_level(self) -> DiskAlertLevel:
        """Determine alert level based on usage."""
        if self.percent_used >= 99:
            return DiskAlertLevel.EMERGENCY
        elif self.percent_used >= 95:
            return DiskAlertLevel.CRITICAL
        elif self.percent_used >= 90:
            return DiskAlertLevel.WARNING
        return DiskAlertLevel.NORMAL

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "timestamp": self.timestamp,
            "path": self.path,
            "total_gb": round(self.total_gb, 2),
            "used_gb": round(self.used_gb, 2),
            "free_gb": round(self.free_gb, 2),
            "percent_used": round(self.percent_used, 1),
            "alert_level": self.alert_level.value,
        }


@dataclass
class DiskThresholds:
    """Disk space threshold configuration."""

    warning_percent: float = 90.0  # 90% used
    critical_percent: float = 95.0  # 95% used
    emergency_percent: float = 99.0  # 99% used
    min_free_gb: float = 1.0  # Minimum 1GB free required


@dataclass
class DiskEvent:
    """Disk space event."""

    timestamp: float
    event_type: str
    snapshot: DiskSnapshot
    message: str
    action_taken: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "timestamp": self.timestamp,
            "event_type": self.event_type,
            "disk": self.snapshot.to_dict(),
            "message": self.message,
            "action_taken": self.action_taken,
        }


@dataclass
class CleanupResult:
    """Result of a cleanup operation."""

    success: bool
    bytes_freed: int
    files_deleted: int
    errors: list[str]

    @property
    def mb_freed(self) -> float:
        """Megabytes freed."""
        return self.bytes_freed / (1024**2)

    @property
    def gb_freed(self) -> float:
        """Gigabytes freed."""
        return self.bytes_freed / (1024**3)


class DiskSpaceMonitor:
    """
    Monitor and manage disk space usage.

    Features:
    - Track disk space over time
    - Alert at 90%/95%/99% thresholds
    - Automatic cleanup of old files
    - Graceful degradation on low space
    """

    def __init__(
        self,
        paths: list[Path | str] | None = None,
        thresholds: DiskThresholds | None = None,
        check_interval_sec: float = 60.0,
        enable_monitoring: bool = True,
    ) -> None:
        """
        Initialize disk space monitor.

        Args:
            paths: Paths to monitor (default: ~/.quantlab and working directory)
            thresholds: Disk space thresholds
            check_interval_sec: How often to check disk space
            enable_monitoring: Whether to enable background monitoring
        """
        self._paths = [Path(p) for p in paths] if paths else self._default_paths()
        self.thresholds = thresholds or DiskThresholds()
        self.check_interval_sec = check_interval_sec
        self.enable_monitoring = enable_monitoring

        self._history: dict[str, list[DiskSnapshot]] = {}
        self._events: list[DiskEvent] = []
        self._callbacks: list[Callable[[DiskEvent], None]] = []

        self._monitor_thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()

        # Track alert states to avoid repeated alerts
        self._last_alert_level: dict[str, DiskAlertLevel] = {}

    def _default_paths(self) -> list[Path]:
        """Get default paths to monitor."""
        paths = []

        # Quantlab data directory
        quantlab_dir = Path.home() / ".quantlab"
        if quantlab_dir.exists():
            paths.append(quantlab_dir)

        # Working directory
        paths.append(Path.cwd())

        return paths

    def add_path(self, path: Path | str) -> None:
        """Add a path to monitor."""
        path = Path(path)
        if path not in self._paths:
            self._paths.append(path)

    def remove_path(self, path: Path | str) -> None:
        """Remove a path from monitoring."""
        path = Path(path)
        if path in self._paths:
            self._paths.remove(path)

    def start(self) -> None:
        """Start background monitoring."""
        if not self.enable_monitoring:
            return

        if self._monitor_thread is not None and self._monitor_thread.is_alive():
            return

        self._stop_event.clear()
        self._monitor_thread = threading.Thread(
            target=self._monitoring_loop,
            daemon=True,
            name="QuantlabDiskMonitor",
        )
        self._monitor_thread.start()
        logger.info(f"Disk space monitor started for {len(self._paths)} paths")

    def stop(self) -> None:
        """Stop background monitoring."""
        self._stop_event.set()

        if self._monitor_thread is not None:
            self._monitor_thread.join(timeout=5.0)
            self._monitor_thread = None
            logger.info("Disk space monitor stopped")

    def _monitoring_loop(self) -> None:
        """Background monitoring loop."""
        while not self._stop_event.is_set():
            try:
                self.check_all_paths()
            except Exception as e:
                logger.error(f"Disk monitoring error: {e}")

            # Wait for interval or stop signal
            self._stop_event.wait(self.check_interval_sec)

    def take_snapshot(self, path: Path | str) -> DiskSnapshot:
        """
        Take a disk space snapshot for a path.

        Args:
            path: Path to check

        Returns:
            DiskSnapshot with current usage
        """
        path = Path(path)

        # Get disk usage for the path's filesystem
        try:
            usage = shutil.disk_usage(path)
        except OSError:
            # Path doesn't exist, try parent
            usage = shutil.disk_usage(path.parent if path.parent.exists() else Path.home())

        snapshot = DiskSnapshot(
            timestamp=time.time(),
            path=str(path),
            total_bytes=usage.total,
            used_bytes=usage.used,
            free_bytes=usage.free,
            percent_used=(usage.used / usage.total) * 100 if usage.total > 0 else 0,
        )

        # Store in history
        path_key = str(path)
        with self._lock:
            if path_key not in self._history:
                self._history[path_key] = []
            self._history[path_key].append(snapshot)

            # Limit history size (24 hours at 1 minute intervals)
            max_history = 1440
            if len(self._history[path_key]) > max_history:
                self._history[path_key] = self._history[path_key][-max_history:]

        return snapshot

    def check_all_paths(self) -> dict[str, DiskSnapshot]:
        """
        Check disk space for all monitored paths.

        Returns:
            Dictionary of path -> DiskSnapshot
        """
        results: dict[str, DiskSnapshot] = {}

        for path in self._paths:
            snapshot = self.take_snapshot(path)
            results[str(path)] = snapshot
            self._check_thresholds(snapshot)

        return results

    def _check_thresholds(self, snapshot: DiskSnapshot) -> None:
        """Check disk space thresholds and generate alerts."""
        path_key = str(snapshot.path)
        current_level = snapshot.alert_level
        last_level = self._last_alert_level.get(path_key, DiskAlertLevel.NORMAL)

        # Only alert on level changes or initial critical/emergency
        if current_level == last_level and current_level == DiskAlertLevel.NORMAL:
            return

        # Generate event based on level
        if current_level == DiskAlertLevel.EMERGENCY:
            self._generate_alert(
                snapshot,
                "disk_emergency",
                f"EMERGENCY: Disk nearly full ({snapshot.percent_used:.1f}%) on {snapshot.path}",
                "pause_operations",
            )
        elif current_level == DiskAlertLevel.CRITICAL:
            self._generate_alert(
                snapshot,
                "disk_critical",
                f"CRITICAL: Disk space critically low ({snapshot.percent_used:.1f}%) on {snapshot.path}",
                "cleanup_recommended",
            )
        elif current_level == DiskAlertLevel.WARNING:
            self._generate_alert(
                snapshot,
                "disk_warning",
                f"WARNING: Disk space low ({snapshot.percent_used:.1f}%) on {snapshot.path}",
                "monitor_closely",
            )
        elif last_level != DiskAlertLevel.NORMAL:
            # Recovered from alert state
            self._generate_alert(
                snapshot,
                "disk_recovered",
                f"Disk space recovered to {snapshot.percent_used:.1f}% on {snapshot.path}",
                "none",
            )

        self._last_alert_level[path_key] = current_level

    def _generate_alert(
        self,
        snapshot: DiskSnapshot,
        event_type: str,
        message: str,
        action: str,
    ) -> None:
        """Generate and record a disk alert event."""
        event = DiskEvent(
            timestamp=time.time(),
            event_type=event_type,
            snapshot=snapshot,
            message=message,
            action_taken=action,
        )

        with self._lock:
            self._events.append(event)

            # Limit events history
            max_events = 1000
            if len(self._events) > max_events:
                self._events = self._events[-max_events:]

        # Log based on severity
        if event_type == "disk_emergency":
            logger.critical(message)
        elif event_type == "disk_critical":
            logger.error(message)
        elif event_type == "disk_warning":
            logger.warning(message)
        else:
            logger.info(message)

        # Notify callbacks
        for callback in self._callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.error(f"Disk event callback error: {e}")

    def register_callback(self, callback: Callable[[DiskEvent], None]) -> None:
        """Register callback for disk events."""
        self._callbacks.append(callback)

    def unregister_callback(self, callback: Callable[[DiskEvent], None]) -> None:
        """Unregister callback."""
        if callback in self._callbacks:
            self._callbacks.remove(callback)

    def get_current_usage(self) -> dict[str, dict[str, Any]]:
        """Get current disk usage for all paths."""
        return {
            str(path): self.take_snapshot(path).to_dict()
            for path in self._paths
        }

    def get_history(
        self,
        path: Path | str,
        last_n: int | None = None,
    ) -> list[DiskSnapshot]:
        """Get disk usage history for a path."""
        path_key = str(path)
        with self._lock:
            history = self._history.get(path_key, [])
            if last_n is not None:
                return history[-last_n:]
            return history.copy()

    def get_events(
        self,
        event_type: str | None = None,
        since: float | None = None,
    ) -> list[DiskEvent]:
        """Get disk events, optionally filtered."""
        with self._lock:
            events = self._events.copy()

        if event_type is not None:
            events = [e for e in events if e.event_type == event_type]

        if since is not None:
            events = [e for e in events if e.timestamp >= since]

        return events

    def cleanup_old_files(
        self,
        directory: Path | str,
        max_age_days: int = 30,
        patterns: list[str] | None = None,
        dry_run: bool = False,
    ) -> CleanupResult:
        """
        Clean up old files to free disk space.

        Args:
            directory: Directory to clean
            max_age_days: Delete files older than this
            patterns: File patterns to match (e.g., ["*.log", "*.tmp"])
            dry_run: If True, only report what would be deleted

        Returns:
            CleanupResult with details of cleanup
        """
        directory = Path(directory)
        cutoff = datetime.now() - timedelta(days=max_age_days)
        cutoff_timestamp = cutoff.timestamp()

        bytes_freed = 0
        files_deleted = 0
        errors: list[str] = []

        if patterns is None:
            patterns = ["*"]

        for pattern in patterns:
            for file_path in directory.rglob(pattern):
                if not file_path.is_file():
                    continue

                try:
                    stat = file_path.stat()
                    if stat.st_mtime < cutoff_timestamp:
                        file_size = stat.st_size

                        if not dry_run:
                            file_path.unlink()
                            logger.debug(f"Deleted: {file_path} ({file_size} bytes)")

                        bytes_freed += file_size
                        files_deleted += 1

                except PermissionError:
                    errors.append(f"Permission denied: {file_path}")
                except OSError as e:
                    errors.append(f"Error deleting {file_path}: {e}")

        action = "would delete" if dry_run else "deleted"
        logger.info(
            f"Cleanup {action} {files_deleted} files, freeing "
            f"{bytes_freed / (1024**2):.1f} MB from {directory}"
        )

        return CleanupResult(
            success=len(errors) == 0,
            bytes_freed=bytes_freed,
            files_deleted=files_deleted,
            errors=errors,
        )

    def cleanup_quantlab_logs(
        self,
        max_age_days: int = 30,
        dry_run: bool = False,
    ) -> CleanupResult:
        """
        Clean up old Quantlab log files.

        Args:
            max_age_days: Delete logs older than this
            dry_run: If True, only report what would be deleted

        Returns:
            CleanupResult with details of cleanup
        """
        log_dir = Path.home() / ".quantlab" / "logs"

        if not log_dir.exists():
            return CleanupResult(
                success=True,
                bytes_freed=0,
                files_deleted=0,
                errors=[],
            )

        return self.cleanup_old_files(
            directory=log_dir,
            max_age_days=max_age_days,
            patterns=["*.log", "*.jsonl", "*.log.gz"],
            dry_run=dry_run,
        )

    def cleanup_quantlab_cache(
        self,
        max_age_days: int = 7,
        dry_run: bool = False,
    ) -> CleanupResult:
        """
        Clean up Quantlab cache files.

        Args:
            max_age_days: Delete cache files older than this
            dry_run: If True, only report what would be deleted

        Returns:
            CleanupResult with details of cleanup
        """
        cache_dir = Path.home() / ".quantlab" / "cache"

        if not cache_dir.exists():
            return CleanupResult(
                success=True,
                bytes_freed=0,
                files_deleted=0,
                errors=[],
            )

        return self.cleanup_old_files(
            directory=cache_dir,
            max_age_days=max_age_days,
            patterns=["*"],
            dry_run=dry_run,
        )

    def auto_cleanup(
        self,
        target_free_gb: float = 5.0,
        dry_run: bool = False,
    ) -> dict[str, CleanupResult]:
        """
        Automatically clean up files to reach target free space.

        Cleans in order of priority:
        1. Cache files (7+ days old)
        2. Log files (30+ days old)
        3. Older log files (14+ days old)
        4. Even older log files (7+ days old)

        Args:
            target_free_gb: Target free space in GB
            dry_run: If True, only report what would be deleted

        Returns:
            Dictionary of cleanup operation -> CleanupResult
        """
        results: dict[str, CleanupResult] = {}

        # Check current space
        snapshot = self.take_snapshot(Path.home() / ".quantlab")

        if snapshot.free_gb >= target_free_gb:
            logger.info(f"Disk has {snapshot.free_gb:.1f} GB free, no cleanup needed")
            return results

        logger.info(
            f"Disk has {snapshot.free_gb:.1f} GB free, "
            f"targeting {target_free_gb:.1f} GB"
        )

        # Stage 1: Clean cache
        results["cache_7d"] = self.cleanup_quantlab_cache(
            max_age_days=7, dry_run=dry_run
        )

        snapshot = self.take_snapshot(Path.home() / ".quantlab")
        if snapshot.free_gb >= target_free_gb:
            return results

        # Stage 2: Clean old logs
        results["logs_30d"] = self.cleanup_quantlab_logs(
            max_age_days=30, dry_run=dry_run
        )

        snapshot = self.take_snapshot(Path.home() / ".quantlab")
        if snapshot.free_gb >= target_free_gb:
            return results

        # Stage 3: Clean more recent logs
        results["logs_14d"] = self.cleanup_quantlab_logs(
            max_age_days=14, dry_run=dry_run
        )

        snapshot = self.take_snapshot(Path.home() / ".quantlab")
        if snapshot.free_gb >= target_free_gb:
            return results

        # Stage 4: Clean even more recent logs
        results["logs_7d"] = self.cleanup_quantlab_logs(
            max_age_days=7, dry_run=dry_run
        )

        return results

    def check_space_for_operation(
        self,
        required_gb: float,
        path: Path | str | None = None,
    ) -> tuple[bool, str]:
        """
        Check if there's enough space for an operation.

        Args:
            required_gb: Required free space in GB
            path: Path to check (default: ~/.quantlab)

        Returns:
            Tuple of (has_space, message)
        """
        if path is None:
            path = Path.home() / ".quantlab"

        snapshot = self.take_snapshot(path)

        if snapshot.free_gb >= required_gb:
            return True, f"Sufficient space: {snapshot.free_gb:.1f} GB free"

        shortfall = required_gb - snapshot.free_gb
        return (
            False,
            f"Insufficient space: need {required_gb:.1f} GB, "
            f"have {snapshot.free_gb:.1f} GB (short {shortfall:.1f} GB)",
        )

    def status(self) -> dict[str, Any]:
        """Get overall disk status."""
        return {
            "monitored_paths": [str(p) for p in self._paths],
            "current_usage": self.get_current_usage(),
            "recent_events": [e.to_dict() for e in self._events[-10:]],
            "alert_states": {k: v.value for k, v in self._last_alert_level.items()},
        }

    def __enter__(self) -> "DiskSpaceMonitor":
        """Context manager entry."""
        self.start()
        return self

    def __exit__(self, *args: Any) -> None:
        """Context manager exit."""
        self.stop()


def get_disk_usage(path: Path | str | None = None) -> dict[str, Any]:
    """
    Get current disk usage for a path.

    Args:
        path: Path to check (default: current directory)

    Returns:
        Dictionary with disk usage stats
    """
    if path is None:
        path = Path.cwd()
    else:
        path = Path(path)

    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return {"error": f"Cannot access path: {path}"}

    return {
        "path": str(path),
        "total_gb": usage.total / (1024**3),
        "used_gb": usage.used / (1024**3),
        "free_gb": usage.free / (1024**3),
        "percent_used": (usage.used / usage.total) * 100 if usage.total > 0 else 0,
    }


def check_disk_space(
    min_free_gb: float = 1.0,
    path: Path | str | None = None,
) -> tuple[bool, str]:
    """
    Quick check if disk has minimum free space.

    Args:
        min_free_gb: Minimum required free space in GB
        path: Path to check

    Returns:
        Tuple of (has_space, message)
    """
    usage = get_disk_usage(path)

    if "error" in usage:
        return False, usage["error"]

    if usage["free_gb"] >= min_free_gb:
        return True, f"OK: {usage['free_gb']:.1f} GB free"

    return (
        False,
        f"Low space: {usage['free_gb']:.1f} GB free, need {min_free_gb:.1f} GB",
    )

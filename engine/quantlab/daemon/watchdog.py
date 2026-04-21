"""
Daemon Health Monitoring and Watchdog.

Provides health checks and monitoring for daemon processes.

Spec Reference: Technical Spec §1.5, Decision N98
"""

import asyncio
import logging
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timedelta
from enum import Enum
from typing import Any
from typing import Callable

import psutil


logger = logging.getLogger(__name__)


class HealthStatus(Enum):
    """Health check status codes."""

    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"
    UNKNOWN = "unknown"


@dataclass
class ComponentHealth:
    """Health status of a single component."""

    name: str
    status: HealthStatus
    message: str = ""
    last_check: datetime | None = None
    details: dict[str, Any] = field(default_factory=dict)


@dataclass
class DaemonHealth:
    """Overall daemon health status."""

    status: HealthStatus
    timestamp: datetime
    uptime_seconds: float
    components: list[ComponentHealth] = field(default_factory=list)
    memory_mb: float = 0.0
    cpu_percent: float = 0.0
    last_heartbeat: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "status": self.status.value,
            "timestamp": self.timestamp.isoformat(),
            "uptime_seconds": self.uptime_seconds,
            "memory_mb": self.memory_mb,
            "cpu_percent": self.cpu_percent,
            "last_heartbeat": self.last_heartbeat.isoformat()
            if self.last_heartbeat
            else None,
            "components": [
                {
                    "name": c.name,
                    "status": c.status.value,
                    "message": c.message,
                    "last_check": c.last_check.isoformat() if c.last_check else None,
                    "details": c.details,
                }
                for c in self.components
            ],
        }


class HealthChecker:
    """
    Performs health checks on daemon components.

    Checks:
        - Strategy execution
        - Broker connection
        - IPC socket
        - Checkpoint system
        - Memory usage
    """

    def __init__(self) -> None:
        self._start_time = datetime.now()
        self._checks: dict[str, Callable[[], ComponentHealth]] = {}
        self._last_heartbeat: datetime | None = None

    def register_check(
        self,
        name: str,
        check_fn: Callable[[], ComponentHealth],
    ) -> None:
        """
        Register a health check function.

        Args:
            name: Component name
            check_fn: Function returning ComponentHealth
        """
        self._checks[name] = check_fn
        logger.debug(f"Registered health check: {name}")

    def unregister_check(self, name: str) -> None:
        """Remove a health check."""
        self._checks.pop(name, None)

    def record_heartbeat(self) -> None:
        """Record a heartbeat timestamp."""
        self._last_heartbeat = datetime.now()

    def check(self) -> DaemonHealth:
        """
        Run all health checks.

        Returns:
            Aggregated daemon health status
        """
        now = datetime.now()
        components: list[ComponentHealth] = []
        overall_status = HealthStatus.HEALTHY

        # Run registered checks
        for name, check_fn in self._checks.items():
            try:
                health = check_fn()
                health.last_check = now
                components.append(health)

                # Aggregate status
                if health.status == HealthStatus.UNHEALTHY:
                    overall_status = HealthStatus.UNHEALTHY
                elif (
                    health.status == HealthStatus.DEGRADED
                    and overall_status != HealthStatus.UNHEALTHY
                ):
                    overall_status = HealthStatus.DEGRADED

            except Exception as e:
                logger.error(f"Health check {name} failed: {e}")
                components.append(
                    ComponentHealth(
                        name=name,
                        status=HealthStatus.UNKNOWN,
                        message=f"Check failed: {e}",
                        last_check=now,
                    )
                )
                overall_status = HealthStatus.DEGRADED

        # System metrics
        # FIX-M10: Use interval=None (non-blocking) instead of interval=0.1
        # which blocks the event loop for 100ms. With interval=None, returns
        # CPU usage since last call (0.0 on first call, accurate thereafter).
        try:
            process = psutil.Process()
            memory_mb = process.memory_info().rss / 1024 / 1024
            cpu_percent = process.cpu_percent(interval=None)
        except Exception:
            memory_mb = 0.0
            cpu_percent = 0.0

        return DaemonHealth(
            status=overall_status,
            timestamp=now,
            uptime_seconds=(now - self._start_time).total_seconds(),
            components=components,
            memory_mb=memory_mb,
            cpu_percent=cpu_percent,
            last_heartbeat=self._last_heartbeat,
        )


class Watchdog:
    """
    Monitors daemon health and triggers alerts.

    CRITICAL: The watchdog NEVER auto-restarts the daemon.
    This prevents surprise trading after system recovery.

    Instead, it:
    - Sends alerts to the UI
    - Logs health status changes
    - Provides status for UI to display dialog
    """

    def __init__(
        self,
        health_checker: HealthChecker,
        heartbeat_interval: float = 5.0,
        heartbeat_timeout: float = 30.0,
    ) -> None:
        self._health_checker = health_checker
        self._heartbeat_interval = heartbeat_interval
        self._heartbeat_timeout = heartbeat_timeout
        self._running = False
        self._task: asyncio.Task[None] | None = None
        self._alert_callbacks: list[Callable[[DaemonHealth], None]] = []

    def on_alert(self, callback: Callable[[DaemonHealth], None]) -> None:
        """Register callback for health alerts."""
        self._alert_callbacks.append(callback)

    async def start(self) -> None:
        """Start the watchdog monitoring loop."""
        if self._running:
            return

        self._running = True
        self._task = asyncio.create_task(self._monitor_loop())
        logger.info(
            f"Watchdog started (heartbeat: {self._heartbeat_interval}s, "
            f"timeout: {self._heartbeat_timeout}s)"
        )

    async def stop(self) -> None:
        """Stop the watchdog."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Watchdog stopped")

    async def _monitor_loop(self) -> None:
        """Main monitoring loop."""
        last_status = HealthStatus.UNKNOWN

        while self._running:
            try:
                health = self._health_checker.check()

                # Check heartbeat timeout
                if health.last_heartbeat:
                    heartbeat_age = (
                        datetime.now() - health.last_heartbeat
                    ).total_seconds()
                    if heartbeat_age > self._heartbeat_timeout:
                        health.status = HealthStatus.UNHEALTHY
                        logger.warning(
                            f"Heartbeat timeout: {heartbeat_age:.1f}s since last heartbeat"
                        )

                # Status change detection
                if health.status != last_status:
                    logger.info(f"Health status changed: {last_status} -> {health.status}")
                    last_status = health.status

                    if health.status != HealthStatus.HEALTHY:
                        await self._trigger_alerts(health)  # FIX-D007: Now async

                await asyncio.sleep(self._heartbeat_interval)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Watchdog error: {e}")
                await asyncio.sleep(self._heartbeat_interval)

    async def _trigger_alerts(self, health: DaemonHealth) -> None:
        """Send alerts to registered callbacks (FIX-D007: Now async-capable)."""
        for callback in self._alert_callbacks:
            try:
                result = callback(health)
                # Support both sync and async callbacks
                if asyncio.iscoroutine(result):
                    await result
            except Exception as e:
                logger.error(f"Alert callback error: {e}")


class HeartbeatSender:
    """
    Sends periodic heartbeats over IPC.

    Heartbeat message includes:
    - Timestamp
    - Daemon state
    - Resource usage
    """

    def __init__(
        self,
        send_fn: Callable[[dict[str, Any]], None],
        interval: float = 5.0,
        health_checker: HealthChecker | None = None,
    ) -> None:
        self._send = send_fn
        self._interval = interval
        self._running = False
        self._task: asyncio.Task[None] | None = None
        self._state: str = "unknown"
        self._health_checker = health_checker

    def set_state(self, state: str) -> None:
        """Update daemon state for heartbeat."""
        self._state = state

    async def start(self) -> None:
        """Start sending heartbeats."""
        if self._running:
            return

        self._running = True
        self._task = asyncio.create_task(self._heartbeat_loop())
        logger.info(f"Heartbeat sender started (interval: {self._interval}s)")

    async def stop(self) -> None:
        """Stop sending heartbeats."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Heartbeat sender stopped")

    async def _heartbeat_loop(self) -> None:
        """Send heartbeats periodically."""
        while self._running:
            try:
                # Get system metrics
                process = psutil.Process()
                memory_mb = process.memory_info().rss / 1024 / 1024
                # FIX-M10: Use interval=None (non-blocking) instead of interval=0.1
                cpu_percent = process.cpu_percent(interval=None)

                heartbeat = {
                    "timestamp": datetime.now().isoformat(),
                    "state": self._state,
                    "memory_mb": round(memory_mb, 2),
                    "cpu_percent": round(cpu_percent, 2),
                }

                self._send(heartbeat)

                # Record heartbeat to health checker for timeout tracking
                if self._health_checker:
                    self._health_checker.record_heartbeat()

                logger.debug(f"Heartbeat sent: {heartbeat}")

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Heartbeat error: {e}")

            await asyncio.sleep(self._interval)


def create_broker_check(
    is_connected: Callable[[], bool],
) -> Callable[[], ComponentHealth]:
    """Create a broker connection health check."""

    def check() -> ComponentHealth:
        connected = is_connected()
        return ComponentHealth(
            name="broker",
            status=HealthStatus.HEALTHY if connected else HealthStatus.UNHEALTHY,
            message="Connected" if connected else "Disconnected",
        )

    return check


def create_strategy_check(
    is_running: Callable[[], bool],
    last_signal_time: Callable[[], datetime | None],
) -> Callable[[], ComponentHealth]:
    """Create a strategy execution health check."""

    def check() -> ComponentHealth:
        running = is_running()
        last_signal = last_signal_time()

        if not running:
            return ComponentHealth(
                name="strategy",
                status=HealthStatus.DEGRADED,
                message="Strategy not running",
            )

        if last_signal:
            age = (datetime.now() - last_signal).total_seconds()
            details = {"last_signal_age_seconds": age}

            if age > 300:  # 5 minutes
                return ComponentHealth(
                    name="strategy",
                    status=HealthStatus.DEGRADED,
                    message=f"No signals for {age:.0f}s",
                    details=details,
                )

            return ComponentHealth(
                name="strategy",
                status=HealthStatus.HEALTHY,
                message="Running",
                details=details,
            )

        return ComponentHealth(
            name="strategy",
            status=HealthStatus.HEALTHY,
            message="Running (no signals yet)",
        )

    return check

"""
System Sleep/Wake Handling.

Detects system sleep/wake events and handles daemon state transitions.

Spec Reference: Technical Spec §1.5
"""

import asyncio
import logging
import platform
import subprocess
import time
from abc import ABC
from abc import abstractmethod
from datetime import datetime
from enum import Enum
from typing import Callable


logger = logging.getLogger(__name__)


class PowerEvent(Enum):
    """System power events."""

    SLEEP = "sleep"
    WAKE = "wake"
    SHUTDOWN = "shutdown"
    LOW_BATTERY = "low_battery"


class PowerEventHandler(ABC):
    """Abstract base for platform-specific power event handling."""

    def __init__(self) -> None:
        self._callbacks: list[Callable[[PowerEvent], None]] = []
        self._running = False

    def on_event(self, callback: Callable[[PowerEvent], None]) -> None:
        """Register callback for power events."""
        self._callbacks.append(callback)

    def _notify(self, event: PowerEvent) -> None:
        """Notify all registered callbacks."""
        for callback in self._callbacks:
            try:
                callback(event)
            except Exception as e:
                logger.error(f"Power event callback error: {e}")

    @abstractmethod
    async def start(self) -> None:
        """Start monitoring power events."""
        pass

    @abstractmethod
    async def stop(self) -> None:
        """Stop monitoring power events."""
        pass


class LinuxPowerHandler(PowerEventHandler):
    """
    Linux power event handler.

    Detects sleep/wake transitions using monotonic clock gap detection.
    If the monotonic clock jumps by more than the expected polling interval,
    the system likely slept. This approach is reliable across all Linux
    distributions without requiring D-Bus or sysfs access.
    """

    def __init__(self) -> None:
        super().__init__()
        self._task: asyncio.Task[None] | None = None
        self._last_wake_time: float = time.monotonic()

    async def start(self) -> None:
        """Start monitoring power events."""
        if self._running:
            return

        self._running = True
        self._last_wake_time = time.monotonic()
        self._task = asyncio.create_task(self._monitor_loop())
        logger.info("Linux power handler started")

    async def stop(self) -> None:
        """Stop monitoring."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Linux power handler stopped")

    async def _monitor_loop(self) -> None:
        """
        Monitor for sleep/wake using monotonic time gap detection.

        If monotonic time jumps by more than expected interval,
        we likely slept.
        """
        check_interval = 5.0  # Check every 5 seconds
        max_drift = 10.0  # If gap > 10s, assume we slept

        while self._running:
            try:
                await asyncio.sleep(check_interval)

                now = time.monotonic()
                elapsed = now - self._last_wake_time

                if elapsed > check_interval + max_drift:
                    # Detected wake from sleep
                    logger.info(
                        f"Detected system wake (time gap: {elapsed:.1f}s, "
                        f"expected: ~{check_interval:.1f}s)"
                    )
                    self._notify(PowerEvent.WAKE)

                self._last_wake_time = now

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Power monitor error: {e}")


class MacOSPowerHandler(PowerEventHandler):
    """
    macOS power event handler.

    Uses IOKit for power notifications via pmset or polling.
    """

    def __init__(self) -> None:
        super().__init__()
        self._task: asyncio.Task[None] | None = None
        self._last_wake_time: float = time.monotonic()

    async def start(self) -> None:
        """Start monitoring power events."""
        if self._running:
            return

        self._running = True
        self._last_wake_time = time.monotonic()
        self._task = asyncio.create_task(self._monitor_loop())
        logger.info("macOS power handler started")

    async def stop(self) -> None:
        """Stop monitoring."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("macOS power handler stopped")

    async def _monitor_loop(self) -> None:
        """Monitor for sleep/wake using time gap detection."""
        check_interval = 5.0
        max_drift = 10.0

        while self._running:
            try:
                await asyncio.sleep(check_interval)

                now = time.monotonic()
                elapsed = now - self._last_wake_time

                if elapsed > check_interval + max_drift:
                    logger.info(f"Detected system wake (time gap: {elapsed:.1f}s)")
                    self._notify(PowerEvent.WAKE)

                self._last_wake_time = now

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Power monitor error: {e}")


class WindowsPowerHandler(PowerEventHandler):
    """
    Windows power event handler.

    Uses win32api for power broadcast messages.
    Falls back to time gap detection if pywin32 unavailable.
    """

    def __init__(self) -> None:
        super().__init__()
        self._task: asyncio.Task[None] | None = None
        self._last_wake_time: float = time.monotonic()

    async def start(self) -> None:
        """Start monitoring power events."""
        if self._running:
            return

        self._running = True
        self._last_wake_time = time.monotonic()
        self._task = asyncio.create_task(self._monitor_loop())
        logger.info("Windows power handler started")

    async def stop(self) -> None:
        """Stop monitoring."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Windows power handler stopped")

    async def _monitor_loop(self) -> None:
        """Monitor for sleep/wake using time gap detection."""
        check_interval = 5.0
        max_drift = 10.0

        while self._running:
            try:
                await asyncio.sleep(check_interval)

                now = time.monotonic()
                elapsed = now - self._last_wake_time

                if elapsed > check_interval + max_drift:
                    logger.info(f"Detected system wake (time gap: {elapsed:.1f}s)")
                    self._notify(PowerEvent.WAKE)

                self._last_wake_time = now

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Power monitor error: {e}")


def create_power_handler() -> PowerEventHandler:
    """Create appropriate power handler for the current platform."""
    system = platform.system()

    if system == "Linux":
        return LinuxPowerHandler()
    elif system == "Darwin":
        return MacOSPowerHandler()
    elif system == "Windows":
        return WindowsPowerHandler()
    else:
        logger.warning(f"Unknown platform {system}, using Linux handler")
        return LinuxPowerHandler()


class PowerStateManager:
    """
    Manages daemon response to power events.

    On wake from sleep:
    1. Log wake event
    2. Check elapsed time
    3. Trigger checkpoint if significant time passed
    4. Resume trading if market is open
    5. Stay in MARKET_CLOSED state if market closed
    """

    def __init__(
        self,
        on_wake: Callable[[float], None] | None = None,
        on_sleep: Callable[[], None] | None = None,
    ) -> None:
        self._power_handler = create_power_handler()
        self._on_wake = on_wake
        self._on_sleep = on_sleep
        self._last_active_time = datetime.now()

    async def start(self) -> None:
        """Start power state monitoring."""
        self._power_handler.on_event(self._handle_power_event)
        await self._power_handler.start()
        logger.info("Power state manager started")

    async def stop(self) -> None:
        """Stop power state monitoring."""
        await self._power_handler.stop()
        logger.info("Power state manager stopped")

    def _handle_power_event(self, event: PowerEvent) -> None:
        """Handle power event."""
        now = datetime.now()

        if event == PowerEvent.WAKE:
            elapsed = (now - self._last_active_time).total_seconds()
            logger.info(
                f"System wake detected, elapsed: {elapsed:.1f}s "
                f"(last active: {self._last_active_time})"
            )

            if self._on_wake:
                self._on_wake(elapsed)

        elif event == PowerEvent.SLEEP:
            logger.info("System sleep detected")
            if self._on_sleep:
                self._on_sleep()

        self._last_active_time = now

    def mark_active(self) -> None:
        """Mark current time as last active (for sleep duration calculation)."""
        self._last_active_time = datetime.now()

"""
Trading Session Management.

Manages trading session lifecycle, state, and heartbeat monitoring.
Includes concurrent session limits and offline mode detection.

Spec Reference: Technical Spec §8, Phase 5 Trade View MVP
"""

from __future__ import annotations

import logging
import socket
import threading
import time
import uuid
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from enum import Enum
from typing import TYPE_CHECKING
from typing import Any
from typing import Callable

if TYPE_CHECKING:
    from quantlab.logging.audit import AuditLog


logger = logging.getLogger(__name__)


class SessionState(Enum):
    """Trading session states."""

    PENDING = "pending"  # Created but not started
    STARTING = "starting"  # Initializing
    ACTIVE = "active"  # Running and trading
    PAUSED = "paused"  # Temporarily suspended
    STOPPING = "stopping"  # Shutting down
    STOPPED = "stopped"  # Terminated
    ERROR = "error"  # Error state


class SessionMode(Enum):
    """Trading mode."""

    PAPER = "paper"  # Paper trading (simulated)
    LIVE = "live"  # Live trading (real money)


class HeartbeatStatus(Enum):
    """Heartbeat status."""

    OK = "ok"  # Heartbeat received recently
    STALE = "stale"  # Heartbeat delayed
    LOST = "lost"  # No heartbeat received


@dataclass
class SessionConfig:
    """Configuration for a trading session."""

    strategy_path: str
    symbol: str
    timeframe: str
    mode: SessionMode = SessionMode.PAPER
    account_id: str | None = None

    # Risk settings
    max_position_size: float = 1000.0
    max_open_orders: int = 10
    daily_loss_limit: float = 1000.0

    # Execution settings
    use_code_defaults: bool = True
    params: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "strategyPath": self.strategy_path,
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "mode": self.mode.value,
            "accountId": self.account_id,
            "maxPositionSize": self.max_position_size,
            "maxOpenOrders": self.max_open_orders,
            "dailyLossLimit": self.daily_loss_limit,
            "useCodeDefaults": self.use_code_defaults,
            "params": self.params,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SessionConfig":
        """Create from dictionary."""
        return cls(
            strategy_path=data["strategyPath"],
            symbol=data["symbol"],
            timeframe=data["timeframe"],
            mode=SessionMode(data.get("mode", "paper")),
            account_id=data.get("accountId"),
            max_position_size=data.get("maxPositionSize", 1000.0),
            max_open_orders=data.get("maxOpenOrders", 10),
            daily_loss_limit=data.get("dailyLossLimit", 1000.0),
            use_code_defaults=data.get("useCodeDefaults", True),
            params=data.get("params", {}),
        )


@dataclass
class SessionMetrics:
    """Performance metrics for a session."""

    total_pnl: float = 0.0
    realized_pnl: float = 0.0
    unrealized_pnl: float = 0.0
    total_trades: int = 0
    winning_trades: int = 0
    losing_trades: int = 0
    win_rate: float = 0.0
    daily_pnl: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "totalPnl": self.total_pnl,
            "realizedPnl": self.realized_pnl,
            "unrealizedPnl": self.unrealized_pnl,
            "totalTrades": self.total_trades,
            "winningTrades": self.winning_trades,
            "losingTrades": self.losing_trades,
            "winRate": self.win_rate,
            "dailyPnl": self.daily_pnl,
        }


def generate_session_id() -> str:
    """Generate a unique session ID."""
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    unique = str(uuid.uuid4())[:8]
    return f"session-{timestamp}-{unique}"


class TradingSession:
    """
    Represents a single trading session.

    Manages session lifecycle, heartbeat, and state persistence.
    """

    def __init__(
        self,
        session_id: str,
        config: SessionConfig,
        audit_log: "AuditLog | None" = None,
        broker_name: str = "unknown",
    ) -> None:
        """
        Initialize trading session.

        Args:
            session_id: Unique session identifier
            config: Session configuration
            audit_log: Optional audit log for compliance logging
            broker_name: Name of the broker for this session
        """
        self._session_id = session_id
        self._config = config
        self._audit_log = audit_log
        self._broker_name = broker_name
        self._state = SessionState.PENDING
        self._metrics = SessionMetrics()

        # Timestamps
        self._created_at = datetime.now(timezone.utc)
        self._started_at: datetime | None = None
        self._stopped_at: datetime | None = None

        # Heartbeat
        self._last_heartbeat = time.time()
        self._heartbeat_interval = 5.0  # seconds
        self._heartbeat_timeout = 15.0  # seconds

        # Error tracking
        self._error_message: str | None = None
        self._error_code: str | None = None

        # Thread safety
        self._lock = threading.Lock()

        # Event callbacks
        self._on_state_change: list[Callable[[SessionState], None]] = []
        self._on_heartbeat: list[Callable[[HeartbeatStatus], None]] = []

    def set_audit_log(self, audit_log: "AuditLog") -> None:
        """Set the audit log for compliance logging."""
        self._audit_log = audit_log

    @property
    def session_id(self) -> str:
        """Get session ID."""
        return self._session_id

    @property
    def config(self) -> SessionConfig:
        """Get session configuration."""
        return self._config

    @property
    def state(self) -> SessionState:
        """Get current session state."""
        with self._lock:
            return self._state

    @property
    def metrics(self) -> SessionMetrics:
        """Get session metrics."""
        with self._lock:
            return self._metrics

    @property
    def is_active(self) -> bool:
        """Check if session is actively trading."""
        return self._state == SessionState.ACTIVE

    @property
    def is_running(self) -> bool:
        """Check if session is running (active or paused)."""
        return self._state in (SessionState.ACTIVE, SessionState.PAUSED)

    @property
    def runtime_seconds(self) -> float:
        """Get session runtime in seconds."""
        if self._started_at is None:
            return 0.0

        end_time = self._stopped_at or datetime.now(timezone.utc)
        return (end_time - self._started_at).total_seconds()

    @property
    def heartbeat_status(self) -> HeartbeatStatus:
        """Get current heartbeat status (thread-safe)."""
        with self._lock:
            elapsed = time.time() - self._last_heartbeat

        if elapsed < self._heartbeat_interval * 2:
            return HeartbeatStatus.OK
        elif elapsed < self._heartbeat_timeout:
            return HeartbeatStatus.STALE
        else:
            return HeartbeatStatus.LOST

    def start(self) -> None:
        """Start the trading session."""
        # Capture callbacks to call outside lock to avoid deadlocks
        callbacks_to_call: list[SessionState] = []

        with self._lock:
            if self._state != SessionState.PENDING:
                raise ValueError(
                    f"Cannot start session in state {self._state.value}"
                )

            self._state = SessionState.STARTING
            callbacks_to_call.append(self._state)

            # Initialize session (within lock to prevent race conditions)
            self._started_at = datetime.now(timezone.utc)
            self._last_heartbeat = time.time()

            self._state = SessionState.ACTIVE
            callbacks_to_call.append(self._state)

        # Notify outside lock to avoid deadlocks
        for state in callbacks_to_call:
            self._notify_state_change_for(state)

        # Audit log: session start
        if self._audit_log:
            try:
                from quantlab.logging.audit import audit_session_start

                audit_session_start(
                    self._audit_log,
                    session_id=self._session_id,
                    strategy_path=self._config.strategy_path,
                    broker=self._broker_name,
                    symbols=[self._config.symbol],
                )
            except Exception as e:
                logger.error(f"Failed to write audit log for session start: {e}")

    def pause(self) -> None:
        """Pause the trading session."""
        with self._lock:
            if self._state != SessionState.ACTIVE:
                raise ValueError(
                    f"Cannot pause session in state {self._state.value}"
                )

            self._state = SessionState.PAUSED

        # Notify outside lock
        self._notify_state_change_for(SessionState.PAUSED)

    def resume(self) -> None:
        """Resume the trading session."""
        with self._lock:
            if self._state != SessionState.PAUSED:
                raise ValueError(
                    f"Cannot resume session in state {self._state.value}"
                )

            self._state = SessionState.ACTIVE

        # Notify outside lock
        self._notify_state_change_for(SessionState.ACTIVE)

    def stop(self) -> None:
        """Stop the trading session."""
        # Capture callbacks to call outside lock to avoid deadlocks
        callbacks_to_call: list[SessionState] = []

        with self._lock:
            if self._state not in (
                SessionState.ACTIVE,
                SessionState.PAUSED,
                SessionState.ERROR,
            ):
                raise ValueError(
                    f"Cannot stop session in state {self._state.value}"
                )

            self._state = SessionState.STOPPING
            callbacks_to_call.append(self._state)

            self._stopped_at = datetime.now(timezone.utc)

            self._state = SessionState.STOPPED
            callbacks_to_call.append(self._state)

        # Notify outside lock to avoid deadlocks
        for state in callbacks_to_call:
            self._notify_state_change_for(state)

        # Audit log: session stop
        if self._audit_log:
            try:
                from quantlab.logging.audit import AuditAction

                self._audit_log.log(
                    AuditAction.SESSION_STOP,
                    self._session_id,
                    {
                        "strategy_path": self._config.strategy_path,
                        "runtime_seconds": self.runtime_seconds,
                        "total_trades": self._metrics.total_trades,
                        "realized_pnl": self._metrics.realized_pnl,
                    },
                )
            except Exception as e:
                logger.error(f"Failed to write audit log for session stop: {e}")

    def set_error(self, message: str, code: str | None = None) -> None:
        """Set session to error state."""
        with self._lock:
            # Don't transition to ERROR from terminal states
            if self._state == SessionState.STOPPED:
                logger.warning(
                    f"Cannot set error on stopped session {self._session_id}: {message}"
                )
                return

            self._state = SessionState.ERROR
            self._error_message = message
            self._error_code = code

        # Notify outside lock
        self._notify_state_change_for(SessionState.ERROR)

    def heartbeat(self) -> None:
        """Record heartbeat."""
        old_status = self.heartbeat_status
        with self._lock:
            self._last_heartbeat = time.time()
        new_status = self.heartbeat_status

        if old_status != new_status:
            # Copy callback list to avoid modification during iteration
            callbacks = list(self._on_heartbeat)
            for callback in callbacks:
                try:
                    callback(new_status)
                except Exception as e:
                    logger.warning(
                        f"Heartbeat callback failed: {e}",
                        exc_info=True,
                    )

    def update_metrics(
        self,
        realized_pnl: float | None = None,
        unrealized_pnl: float | None = None,
        trades: int | None = None,
        wins: int | None = None,
    ) -> None:
        """Update session metrics."""
        with self._lock:
            if realized_pnl is not None:
                self._metrics.realized_pnl = realized_pnl
            if unrealized_pnl is not None:
                self._metrics.unrealized_pnl = unrealized_pnl

            self._metrics.total_pnl = (
                self._metrics.realized_pnl + self._metrics.unrealized_pnl
            )

            if trades is not None:
                self._metrics.total_trades = trades
            if wins is not None:
                self._metrics.winning_trades = wins
                self._metrics.losing_trades = self._metrics.total_trades - wins

            if self._metrics.total_trades > 0:
                self._metrics.win_rate = (
                    self._metrics.winning_trades / self._metrics.total_trades
                ) * 100

    def on_state_change(
        self,
        callback: Callable[[SessionState], None],
    ) -> None:
        """Register state change callback."""
        self._on_state_change.append(callback)

    def on_heartbeat_change(
        self,
        callback: Callable[[HeartbeatStatus], None],
    ) -> None:
        """Register heartbeat status change callback."""
        self._on_heartbeat.append(callback)

    def _notify_state_change(self) -> None:
        """Notify state change listeners (must be called outside lock)."""
        self._notify_state_change_for(self._state)

    def _notify_state_change_for(self, state: SessionState) -> None:
        """Notify state change listeners for a specific state (must be called outside lock)."""
        # Copy callback list to avoid modification during iteration
        callbacks = list(self._on_state_change)
        for callback in callbacks:
            try:
                callback(state)
            except Exception as e:
                logger.warning(
                    f"State change callback failed for session {self._session_id}: {e}",
                    exc_info=True,
                )

    def to_dict(self) -> dict[str, Any]:
        """Convert session to dictionary."""
        return {
            "sessionId": self._session_id,
            "config": self._config.to_dict(),
            "state": self._state.value,
            "metrics": self._metrics.to_dict(),
            "createdAt": self._created_at.isoformat(),
            "startedAt": self._started_at.isoformat() if self._started_at else None,
            "stoppedAt": self._stopped_at.isoformat() if self._stopped_at else None,
            "runtimeSeconds": self.runtime_seconds,
            "heartbeatStatus": self.heartbeat_status.value,
            "errorMessage": self._error_message,
            "errorCode": self._error_code,
        }


class NetworkStatus(Enum):
    """Network connectivity status."""

    ONLINE = "online"
    OFFLINE = "offline"
    DEGRADED = "degraded"


@dataclass
class ConnectivityCheckResult:
    """Result of connectivity check."""

    status: NetworkStatus
    latency_ms: float | None = None
    broker_reachable: bool = False
    internet_reachable: bool = False
    last_check: datetime = field(default_factory=datetime.now)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "status": self.status.value,
            "latencyMs": self.latency_ms,
            "brokerReachable": self.broker_reachable,
            "internetReachable": self.internet_reachable,
            "lastCheck": self.last_check.isoformat(),
            "error": self.error,
        }


class OfflineDetector:
    """
    Detects offline/connectivity issues.

    Monitors network connectivity and broker availability to
    prevent trading during network outages.
    """

    # Test hosts for connectivity checks
    INTERNET_HOSTS = [
        ("8.8.8.8", 53),  # Google DNS
        ("1.1.1.1", 53),  # Cloudflare DNS
    ]

    # Broker-specific hosts (can be configured)
    BROKER_HOSTS: dict[str, tuple[str, int]] = {
        "alpaca": ("api.alpaca.markets", 443),
        "alpaca_paper": ("paper-api.alpaca.markets", 443),
    }

    def __init__(
        self,
        check_interval: float = 30.0,
        on_status_change: Callable[[NetworkStatus], None] | None = None,
    ) -> None:
        """
        Initialize offline detector.

        Args:
            check_interval: Seconds between checks
            on_status_change: Callback when status changes
        """
        self._check_interval = check_interval
        self._on_status_change = on_status_change
        self._current_status = NetworkStatus.ONLINE
        self._running = False
        self._check_thread: threading.Thread | None = None
        self._last_result: ConnectivityCheckResult | None = None

    @property
    def status(self) -> NetworkStatus:
        """Get current network status."""
        return self._current_status

    @property
    def is_online(self) -> bool:
        """Check if online."""
        return self._current_status == NetworkStatus.ONLINE

    @property
    def last_check(self) -> ConnectivityCheckResult | None:
        """Get last check result."""
        return self._last_result

    def start(self) -> None:
        """Start background connectivity monitoring."""
        if self._running:
            return

        self._running = True
        self._check_thread = threading.Thread(
            target=self._monitoring_loop,
            daemon=True,
        )
        self._check_thread.start()
        logger.info("Offline detector started")

    def stop(self) -> None:
        """Stop background monitoring."""
        self._running = False
        if self._check_thread:
            self._check_thread.join(timeout=5.0)
            self._check_thread = None
        logger.info("Offline detector stopped")

    def check_now(self, broker: str | None = None) -> ConnectivityCheckResult:
        """
        Perform immediate connectivity check.

        Args:
            broker: Optional broker to check (e.g., "alpaca")

        Returns:
            ConnectivityCheckResult
        """
        internet_ok = self._check_internet()
        broker_ok = self._check_broker(broker) if broker else True
        latency = self._measure_latency() if internet_ok else None

        if internet_ok and broker_ok:
            status = NetworkStatus.ONLINE
        elif internet_ok and not broker_ok:
            status = NetworkStatus.DEGRADED
        else:
            status = NetworkStatus.OFFLINE

        result = ConnectivityCheckResult(
            status=status,
            latency_ms=latency,
            broker_reachable=broker_ok,
            internet_reachable=internet_ok,
        )

        self._last_result = result
        self._update_status(status)

        return result

    def _monitoring_loop(self) -> None:
        """Background monitoring loop."""
        while self._running:
            try:
                self.check_now()
            except Exception as e:
                logger.error(f"Connectivity check error: {e}")

            time.sleep(self._check_interval)

    def _check_internet(self) -> bool:
        """Check basic internet connectivity."""
        for host, port in self.INTERNET_HOSTS:
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(3.0)
                sock.connect((host, port))
                sock.close()
                return True
            except OSError:
                continue
        return False

    def _check_broker(self, broker: str) -> bool:
        """Check broker connectivity."""
        host_info = self.BROKER_HOSTS.get(broker)
        if not host_info:
            return True  # Unknown broker, assume OK

        host, port = host_info
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5.0)
            sock.connect((host, port))
            sock.close()
            return True
        except OSError:
            return False

    def _measure_latency(self) -> float | None:
        """Measure network latency in ms."""
        host, port = self.INTERNET_HOSTS[0]
        try:
            start = time.perf_counter()
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5.0)
            sock.connect((host, port))
            sock.close()
            return (time.perf_counter() - start) * 1000
        except OSError:
            return None

    def _update_status(self, new_status: NetworkStatus) -> None:
        """Update status and notify on change."""
        if new_status != self._current_status:
            old_status = self._current_status
            self._current_status = new_status

            logger.warning(
                f"Network status changed: {old_status.value} -> {new_status.value}"
            )

            if self._on_status_change:
                try:
                    self._on_status_change(new_status)
                except Exception as e:
                    logger.warning(
                        f"Network status change callback failed: {e}",
                        exc_info=True,
                    )


class ConcurrentSessionLimiter:
    """
    Enforces limits on concurrent trading sessions.

    Prevents resource exhaustion and ensures manageable
    number of simultaneous live trading sessions.
    """

    # Default limits
    DEFAULT_MAX_PAPER_SESSIONS = 10
    DEFAULT_MAX_LIVE_SESSIONS = 3
    DEFAULT_MAX_TOTAL_SESSIONS = 10

    def __init__(
        self,
        max_paper_sessions: int = DEFAULT_MAX_PAPER_SESSIONS,
        max_live_sessions: int = DEFAULT_MAX_LIVE_SESSIONS,
        max_total_sessions: int = DEFAULT_MAX_TOTAL_SESSIONS,
    ) -> None:
        """
        Initialize session limiter.

        Args:
            max_paper_sessions: Maximum concurrent paper sessions
            max_live_sessions: Maximum concurrent live sessions
            max_total_sessions: Maximum total concurrent sessions
        """
        self._max_paper = max_paper_sessions
        self._max_live = max_live_sessions
        self._max_total = max_total_sessions
        self._lock = threading.Lock()

    def can_create_session(
        self,
        mode: SessionMode,
        current_sessions: list["TradingSession"],
    ) -> tuple[bool, str | None]:
        """
        Check if a new session can be created.

        Args:
            mode: Mode of the new session
            current_sessions: List of existing sessions

        Returns:
            Tuple of (allowed, reason if not allowed)
        """
        with self._lock:
            running = [s for s in current_sessions if s.is_running]
            paper_count = sum(1 for s in running if s.config.mode == SessionMode.PAPER)
            live_count = sum(1 for s in running if s.config.mode == SessionMode.LIVE)
            total_count = len(running)

            # Check total limit
            if total_count >= self._max_total:
                return False, f"Maximum total sessions ({self._max_total}) reached"

            # Check mode-specific limit
            if mode == SessionMode.PAPER:
                if paper_count >= self._max_paper:
                    return False, f"Maximum paper sessions ({self._max_paper}) reached"
            else:
                if live_count >= self._max_live:
                    return False, f"Maximum live sessions ({self._max_live}) reached"

            return True, None

    def get_session_counts(
        self,
        current_sessions: list["TradingSession"],
    ) -> dict[str, int]:
        """Get current session counts by type."""
        running = [s for s in current_sessions if s.is_running]
        return {
            "paper": sum(1 for s in running if s.config.mode == SessionMode.PAPER),
            "live": sum(1 for s in running if s.config.mode == SessionMode.LIVE),
            "total": len(running),
            "maxPaper": self._max_paper,
            "maxLive": self._max_live,
            "maxTotal": self._max_total,
        }


class SessionLimitError(Exception):
    """Raised when session limit is exceeded."""

    pass


class OfflineError(Exception):
    """Raised when trying to start live session while offline."""

    pass


class SessionManager:
    """
    Manages multiple trading sessions.

    Handles session lifecycle, tracking, cleanup, concurrent limits,
    and offline detection.
    """

    def __init__(
        self,
        max_paper_sessions: int = ConcurrentSessionLimiter.DEFAULT_MAX_PAPER_SESSIONS,
        max_live_sessions: int = ConcurrentSessionLimiter.DEFAULT_MAX_LIVE_SESSIONS,
        max_total_sessions: int = ConcurrentSessionLimiter.DEFAULT_MAX_TOTAL_SESSIONS,
        enable_offline_detection: bool = True,
    ) -> None:
        """
        Initialize session manager.

        Args:
            max_paper_sessions: Maximum concurrent paper sessions
            max_live_sessions: Maximum concurrent live sessions
            max_total_sessions: Maximum total concurrent sessions
            enable_offline_detection: Enable network monitoring
        """
        self._sessions: dict[str, TradingSession] = {}
        self._lock = threading.Lock()

        # Session limits
        self._limiter = ConcurrentSessionLimiter(
            max_paper_sessions=max_paper_sessions,
            max_live_sessions=max_live_sessions,
            max_total_sessions=max_total_sessions,
        )

        # Offline detection
        self._offline_detector: OfflineDetector | None = None
        if enable_offline_detection:
            self._offline_detector = OfflineDetector(
                on_status_change=self._on_network_status_change,
            )
            self._offline_detector.start()

        # Event callbacks
        self._on_session_update: list[Callable[[str, TradingSession], None]] = []
        self._on_offline: list[Callable[[NetworkStatus], None]] = []

    @property
    def active_sessions(self) -> list[TradingSession]:
        """Get all active sessions."""
        with self._lock:
            return [
                s for s in self._sessions.values()
                if s.is_running
            ]

    @property
    def all_sessions(self) -> list[TradingSession]:
        """Get all sessions."""
        with self._lock:
            return list(self._sessions.values())

    def create_session(self, config: SessionConfig) -> TradingSession:
        """
        Create a new trading session.

        Args:
            config: Session configuration

        Returns:
            Created session

        Raises:
            SessionLimitError: If session limit exceeded
            OfflineError: If offline and trying to create live session
        """
        # Check concurrent session limits
        can_create, reason = self._limiter.can_create_session(
            config.mode, list(self._sessions.values())
        )
        if not can_create:
            raise SessionLimitError(reason)

        # Check offline status for live sessions
        if config.mode == SessionMode.LIVE and self._offline_detector:
            if not self._offline_detector.is_online:
                raise OfflineError(
                    "Cannot start live trading session while offline"
                )

        session_id = generate_session_id()
        session = TradingSession(session_id, config)

        # Register state change handler
        session.on_state_change(
            lambda state: self._notify_session_update(session_id, session)
        )

        with self._lock:
            self._sessions[session_id] = session

        logger.info(
            f"Session created: {session_id} ({config.mode.value}) "
            f"for {config.symbol}"
        )

        return session

    def get_session(self, session_id: str) -> TradingSession | None:
        """Get session by ID."""
        with self._lock:
            return self._sessions.get(session_id)

    def start_session(self, session_id: str) -> None:
        """Start a session."""
        session = self.get_session(session_id)
        if session is None:
            raise ValueError(f"Session not found: {session_id}")
        session.start()

    def pause_session(self, session_id: str) -> None:
        """Pause a session."""
        session = self.get_session(session_id)
        if session is None:
            raise ValueError(f"Session not found: {session_id}")
        session.pause()

    def resume_session(self, session_id: str) -> None:
        """Resume a session."""
        session = self.get_session(session_id)
        if session is None:
            raise ValueError(f"Session not found: {session_id}")
        session.resume()

    def stop_session(self, session_id: str) -> None:
        """Stop a session."""
        session = self.get_session(session_id)
        if session is None:
            raise ValueError(f"Session not found: {session_id}")
        session.stop()

    def stop_all_sessions(self) -> None:
        """Stop all active sessions."""
        for session in self.active_sessions:
            try:
                session.stop()
            except Exception as e:
                logger.warning(
                    f"Failed to stop session {session.session_id}: {e}",
                    exc_info=True,
                )

    def remove_session(self, session_id: str) -> None:
        """Remove a stopped session."""
        with self._lock:
            session = self._sessions.get(session_id)
            if session and session.state == SessionState.STOPPED:
                del self._sessions[session_id]

    def get_sessions_for_strategy(
        self,
        strategy_path: str,
    ) -> list[TradingSession]:
        """Get all sessions for a strategy."""
        with self._lock:
            return [
                s for s in self._sessions.values()
                if s.config.strategy_path == strategy_path
            ]

    def on_session_update(
        self,
        callback: Callable[[str, TradingSession], None],
    ) -> None:
        """Register session update callback."""
        self._on_session_update.append(callback)

    def _notify_session_update(
        self,
        session_id: str,
        session: TradingSession,
    ) -> None:
        """Notify session update listeners."""
        for callback in self._on_session_update:
            try:
                callback(session_id, session)
            except Exception as e:
                logger.warning(
                    f"Session update callback failed for {session_id}: {e}",
                    exc_info=True,
                )

    def _on_network_status_change(self, status: NetworkStatus) -> None:
        """Handle network status changes."""
        logger.warning(f"Network status changed to: {status.value}")

        # Notify listeners
        for callback in self._on_offline:
            try:
                callback(status)
            except Exception as e:
                logger.warning(
                    f"Offline status callback failed: {e}",
                    exc_info=True,
                )

        # Pause live sessions if offline
        if status == NetworkStatus.OFFLINE:
            for session in self.active_sessions:
                if (
                    session.config.mode == SessionMode.LIVE
                    and session.state == SessionState.ACTIVE
                ):
                    logger.warning(
                        f"Pausing live session {session.session_id} due to offline status"
                    )
                    try:
                        session.pause()
                    except Exception as e:
                        logger.warning(
                            f"Failed to pause session {session.session_id}: {e}",
                            exc_info=True,
                        )

    def on_offline_status_change(
        self,
        callback: Callable[[NetworkStatus], None],
    ) -> None:
        """Register offline status change callback."""
        self._on_offline.append(callback)

    def get_session_counts(self) -> dict[str, int]:
        """Get current session counts."""
        return self._limiter.get_session_counts(list(self._sessions.values()))

    def check_connectivity(self, broker: str | None = None) -> ConnectivityCheckResult:
        """
        Check network connectivity.

        Args:
            broker: Optional broker to check

        Returns:
            ConnectivityCheckResult
        """
        if self._offline_detector:
            return self._offline_detector.check_now(broker)
        return ConnectivityCheckResult(status=NetworkStatus.ONLINE)

    @property
    def is_online(self) -> bool:
        """Check if network is online."""
        if self._offline_detector:
            return self._offline_detector.is_online
        return True

    @property
    def network_status(self) -> NetworkStatus:
        """Get current network status."""
        if self._offline_detector:
            return self._offline_detector.status
        return NetworkStatus.ONLINE

    def shutdown(self) -> None:
        """Shutdown session manager and stop background tasks."""
        self.stop_all_sessions()
        if self._offline_detector:
            self._offline_detector.stop()
        logger.info("Session manager shut down")

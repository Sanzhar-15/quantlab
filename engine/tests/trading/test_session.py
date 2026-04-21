"""
Tests for Trading Session module.

Tests TradingSession, SessionManager, and related classes.
"""

import pytest
import time

from quantlab.trading import (
    SessionState,
    SessionMode,
    HeartbeatStatus,
    SessionConfig,
    SessionMetrics,
    TradingSession,
    SessionManager,
    generate_session_id,
)


class TestSessionState:
    """Tests for SessionState enum."""

    def test_state_values(self) -> None:
        """Test session state values."""
        assert SessionState.PENDING.value == "pending"
        assert SessionState.STARTING.value == "starting"
        assert SessionState.ACTIVE.value == "active"
        assert SessionState.PAUSED.value == "paused"
        assert SessionState.STOPPING.value == "stopping"
        assert SessionState.STOPPED.value == "stopped"
        assert SessionState.ERROR.value == "error"


class TestSessionMode:
    """Tests for SessionMode enum."""

    def test_mode_values(self) -> None:
        """Test session mode values."""
        assert SessionMode.PAPER.value == "paper"
        assert SessionMode.LIVE.value == "live"


class TestHeartbeatStatus:
    """Tests for HeartbeatStatus enum."""

    def test_status_values(self) -> None:
        """Test heartbeat status values."""
        assert HeartbeatStatus.OK.value == "ok"
        assert HeartbeatStatus.STALE.value == "stale"
        assert HeartbeatStatus.LOST.value == "lost"


class TestSessionConfig:
    """Tests for SessionConfig dataclass."""

    def test_creation(self) -> None:
        """Test config creation."""
        config = SessionConfig(
            strategy_path="/path/to/strategy.py",
            symbol="AAPL",
            timeframe="1D",
        )
        assert config.strategy_path == "/path/to/strategy.py"
        assert config.symbol == "AAPL"
        assert config.mode == SessionMode.PAPER

    def test_defaults(self) -> None:
        """Test default values."""
        config = SessionConfig(
            strategy_path="/strategy.py",
            symbol="GOOG",
            timeframe="1H",
        )
        assert config.max_position_size == 1000.0
        assert config.max_open_orders == 10
        assert config.daily_loss_limit == 1000.0

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        config = SessionConfig(
            strategy_path="/strategy.py",
            symbol="MSFT",
            timeframe="1D",
            mode=SessionMode.LIVE,
        )
        d = config.to_dict()

        assert d["strategyPath"] == "/strategy.py"
        assert d["symbol"] == "MSFT"
        assert d["mode"] == "live"

    def test_from_dict(self) -> None:
        """Test creation from dictionary."""
        data = {
            "strategyPath": "/strategy.py",
            "symbol": "TSLA",
            "timeframe": "4H",
            "mode": "paper",
            "maxPositionSize": 5000,
        }
        config = SessionConfig.from_dict(data)

        assert config.strategy_path == "/strategy.py"
        assert config.symbol == "TSLA"
        assert config.max_position_size == 5000


class TestSessionMetrics:
    """Tests for SessionMetrics dataclass."""

    def test_creation(self) -> None:
        """Test metrics creation."""
        metrics = SessionMetrics(
            total_pnl=500.0,
            realized_pnl=400.0,
            unrealized_pnl=100.0,
        )
        assert metrics.total_pnl == 500.0
        assert metrics.realized_pnl == 400.0

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        metrics = SessionMetrics(
            total_trades=10,
            winning_trades=6,
            win_rate=60.0,
        )
        d = metrics.to_dict()

        assert d["totalTrades"] == 10
        assert d["winningTrades"] == 6
        assert d["winRate"] == 60.0


class TestGenerateSessionId:
    """Tests for generate_session_id function."""

    def test_format(self) -> None:
        """Test session ID format."""
        session_id = generate_session_id()

        assert session_id.startswith("session-")
        parts = session_id.split("-")
        assert len(parts) >= 3

    def test_uniqueness(self) -> None:
        """Test that IDs are unique."""
        ids = set()
        for _ in range(10):
            ids.add(generate_session_id())
            time.sleep(0.001)

        assert len(ids) >= 5


class TestTradingSession:
    """Tests for TradingSession class."""

    @pytest.fixture
    def config(self) -> SessionConfig:
        """Create test config."""
        return SessionConfig(
            strategy_path="/strategy.py",
            symbol="AAPL",
            timeframe="1D",
        )

    @pytest.fixture
    def session(self, config: SessionConfig) -> TradingSession:
        """Create test session."""
        return TradingSession("test-session-001", config)

    def test_creation(self, session: TradingSession) -> None:
        """Test session creation."""
        assert session.session_id == "test-session-001"
        assert session.state == SessionState.PENDING
        assert session.is_active is False

    def test_start(self, session: TradingSession) -> None:
        """Test starting a session."""
        session.start()

        assert session.state == SessionState.ACTIVE
        assert session.is_active is True
        assert session.is_running is True

    def test_pause_resume(self, session: TradingSession) -> None:
        """Test pausing and resuming."""
        session.start()
        session.pause()

        assert session.state == SessionState.PAUSED
        assert session.is_active is False
        assert session.is_running is True

        session.resume()

        assert session.state == SessionState.ACTIVE
        assert session.is_active is True

    def test_stop(self, session: TradingSession) -> None:
        """Test stopping a session."""
        session.start()
        session.stop()

        assert session.state == SessionState.STOPPED
        assert session.is_running is False

    def test_error_state(self, session: TradingSession) -> None:
        """Test setting error state."""
        session.start()
        session.set_error("Connection lost", "ERR_CONN")

        assert session.state == SessionState.ERROR

    def test_heartbeat_status(self, session: TradingSession) -> None:
        """Test heartbeat status."""
        session.start()
        session.heartbeat()

        assert session.heartbeat_status == HeartbeatStatus.OK

    def test_update_metrics(self, session: TradingSession) -> None:
        """Test updating metrics."""
        session.start()
        session.update_metrics(
            realized_pnl=500.0,
            trades=10,
            wins=6,
        )

        metrics = session.metrics
        assert metrics.realized_pnl == 500.0
        assert metrics.total_trades == 10
        assert metrics.winning_trades == 6
        assert metrics.win_rate == 60.0

    def test_runtime_seconds(self, session: TradingSession) -> None:
        """Test runtime calculation."""
        assert session.runtime_seconds == 0.0

        session.start()
        time.sleep(0.1)

        assert session.runtime_seconds >= 0.1

    def test_state_change_callback(self, session: TradingSession) -> None:
        """Test state change callback."""
        states: list[SessionState] = []
        session.on_state_change(lambda s: states.append(s))

        session.start()
        session.pause()
        session.resume()
        session.stop()

        assert SessionState.ACTIVE in states
        assert SessionState.PAUSED in states
        assert SessionState.STOPPED in states

    def test_to_dict(self, session: TradingSession) -> None:
        """Test conversion to dictionary."""
        session.start()
        d = session.to_dict()

        assert d["sessionId"] == "test-session-001"
        assert d["state"] == "active"
        assert "config" in d
        assert "metrics" in d

    def test_cannot_start_twice(self, session: TradingSession) -> None:
        """Test that starting twice raises error."""
        session.start()

        with pytest.raises(ValueError):
            session.start()

    def test_cannot_pause_when_not_active(self, session: TradingSession) -> None:
        """Test that pausing non-active raises error."""
        with pytest.raises(ValueError):
            session.pause()


class TestSessionManager:
    """Tests for SessionManager class."""

    @pytest.fixture
    def manager(self) -> SessionManager:
        """Create test manager."""
        return SessionManager()

    @pytest.fixture
    def config(self) -> SessionConfig:
        """Create test config."""
        return SessionConfig(
            strategy_path="/strategy.py",
            symbol="AAPL",
            timeframe="1D",
        )

    def test_create_session(
        self,
        manager: SessionManager,
        config: SessionConfig,
    ) -> None:
        """Test creating a session."""
        session = manager.create_session(config)

        assert session is not None
        assert session.state == SessionState.PENDING
        assert session.config.symbol == "AAPL"

    def test_get_session(
        self,
        manager: SessionManager,
        config: SessionConfig,
    ) -> None:
        """Test getting a session by ID."""
        session = manager.create_session(config)
        retrieved = manager.get_session(session.session_id)

        assert retrieved is session

    def test_get_nonexistent_session(self, manager: SessionManager) -> None:
        """Test getting a non-existent session."""
        result = manager.get_session("nonexistent")
        assert result is None

    def test_start_session(
        self,
        manager: SessionManager,
        config: SessionConfig,
    ) -> None:
        """Test starting a session via manager."""
        session = manager.create_session(config)
        manager.start_session(session.session_id)

        assert session.state == SessionState.ACTIVE

    def test_pause_resume_session(
        self,
        manager: SessionManager,
        config: SessionConfig,
    ) -> None:
        """Test pausing and resuming via manager."""
        session = manager.create_session(config)
        manager.start_session(session.session_id)
        manager.pause_session(session.session_id)

        assert session.state == SessionState.PAUSED

        manager.resume_session(session.session_id)

        assert session.state == SessionState.ACTIVE

    def test_stop_session(
        self,
        manager: SessionManager,
        config: SessionConfig,
    ) -> None:
        """Test stopping a session via manager."""
        session = manager.create_session(config)
        manager.start_session(session.session_id)
        manager.stop_session(session.session_id)

        assert session.state == SessionState.STOPPED

    def test_active_sessions(
        self,
        manager: SessionManager,
        config: SessionConfig,
    ) -> None:
        """Test getting active sessions."""
        session1 = manager.create_session(config)
        session2 = manager.create_session(config)

        manager.start_session(session1.session_id)

        active = manager.active_sessions
        assert len(active) == 1
        assert active[0] is session1

    def test_all_sessions(
        self,
        manager: SessionManager,
        config: SessionConfig,
    ) -> None:
        """Test getting all sessions."""
        manager.create_session(config)
        manager.create_session(config)

        all_sessions = manager.all_sessions
        assert len(all_sessions) == 2

    def test_stop_all_sessions(
        self,
        manager: SessionManager,
        config: SessionConfig,
    ) -> None:
        """Test stopping all sessions."""
        session1 = manager.create_session(config)
        session2 = manager.create_session(config)

        manager.start_session(session1.session_id)
        manager.start_session(session2.session_id)

        manager.stop_all_sessions()

        assert session1.state == SessionState.STOPPED
        assert session2.state == SessionState.STOPPED

    def test_remove_session(
        self,
        manager: SessionManager,
        config: SessionConfig,
    ) -> None:
        """Test removing a stopped session."""
        session = manager.create_session(config)
        session_id = session.session_id

        manager.start_session(session_id)
        manager.stop_session(session_id)
        manager.remove_session(session_id)

        assert manager.get_session(session_id) is None

    def test_get_sessions_for_strategy(
        self,
        manager: SessionManager,
    ) -> None:
        """Test getting sessions for a strategy."""
        config1 = SessionConfig(
            strategy_path="/strategy1.py",
            symbol="AAPL",
            timeframe="1D",
        )
        config2 = SessionConfig(
            strategy_path="/strategy2.py",
            symbol="GOOG",
            timeframe="1D",
        )

        manager.create_session(config1)
        manager.create_session(config1)
        manager.create_session(config2)

        sessions = manager.get_sessions_for_strategy("/strategy1.py")
        assert len(sessions) == 2

    def test_session_update_callback(
        self,
        manager: SessionManager,
        config: SessionConfig,
    ) -> None:
        """Test session update callback."""
        updates: list[tuple[str, TradingSession]] = []
        manager.on_session_update(lambda sid, s: updates.append((sid, s)))

        session = manager.create_session(config)
        manager.start_session(session.session_id)

        assert len(updates) >= 1


class TestTradingSessionAdvanced:
    """Advanced tests for TradingSession covering edge cases."""

    @pytest.fixture
    def config(self) -> SessionConfig:
        """Create test config."""
        return SessionConfig(
            strategy_path="/strategy.py",
            symbol="AAPL",
            timeframe="1D",
        )

    @pytest.fixture
    def session(self, config: SessionConfig) -> TradingSession:
        """Create test session."""
        return TradingSession("test-session-001", config)

    def test_heartbeat_status_stale(self, session: TradingSession) -> None:
        """Test heartbeat status STALE when delayed."""
        session.start()
        # Set last heartbeat to 12 seconds ago (between interval*2 and timeout)
        session._last_heartbeat = time.time() - 12.0
        session._heartbeat_interval = 5.0
        session._heartbeat_timeout = 15.0

        assert session.heartbeat_status == HeartbeatStatus.STALE

    def test_heartbeat_status_lost(self, session: TradingSession) -> None:
        """Test heartbeat status LOST when no heartbeat for too long."""
        session.start()
        # Set last heartbeat to 20 seconds ago (beyond timeout)
        session._last_heartbeat = time.time() - 20.0
        session._heartbeat_interval = 5.0
        session._heartbeat_timeout = 15.0

        assert session.heartbeat_status == HeartbeatStatus.LOST

    def test_cannot_resume_when_not_paused(self, session: TradingSession) -> None:
        """Test that resuming when not paused raises error."""
        session.start()
        # Session is ACTIVE, not PAUSED
        with pytest.raises(ValueError) as exc_info:
            session.resume()
        assert "resume" in str(exc_info.value).lower()

    def test_cannot_stop_when_pending(self, session: TradingSession) -> None:
        """Test that stopping pending session raises error."""
        # Session is PENDING
        with pytest.raises(ValueError) as exc_info:
            session.stop()
        assert "stop" in str(exc_info.value).lower()

    def test_stop_from_error_state(self, session: TradingSession) -> None:
        """Test that session can be stopped from ERROR state."""
        session.start()
        session.set_error("Connection failed", "ERR_CONN")
        # Should be able to stop from ERROR state
        session.stop()
        assert session.state == SessionState.STOPPED

    def test_stop_from_paused_state(self, session: TradingSession) -> None:
        """Test that session can be stopped from PAUSED state."""
        session.start()
        session.pause()
        # Should be able to stop from PAUSED state
        session.stop()
        assert session.state == SessionState.STOPPED

    def test_heartbeat_callback_triggered(self, session: TradingSession) -> None:
        """Test heartbeat status change callback is triggered."""
        statuses: list[HeartbeatStatus] = []
        session.on_heartbeat_change(lambda s: statuses.append(s))

        session.start()
        # Make heartbeat stale
        session._last_heartbeat = time.time() - 20.0

        # Now send heartbeat to bring back to OK
        session.heartbeat()

        # Should have triggered callback
        assert len(statuses) >= 1
        assert HeartbeatStatus.OK in statuses

    def test_heartbeat_callback_exception_handled(self, session: TradingSession) -> None:
        """Test that exceptions in heartbeat callbacks are handled."""

        def bad_callback(status: HeartbeatStatus) -> None:
            raise RuntimeError("Callback error")

        session.on_heartbeat_change(bad_callback)
        session.start()
        session._last_heartbeat = time.time() - 20.0

        # Should not raise despite callback error
        session.heartbeat()

    def test_state_change_callback_exception_handled(
        self, session: TradingSession
    ) -> None:
        """Test that exceptions in state change callbacks are handled."""

        def bad_callback(state: SessionState) -> None:
            raise RuntimeError("Callback error")

        session.on_state_change(bad_callback)

        # Should not raise despite callback error
        session.start()
        assert session.state == SessionState.ACTIVE

    def test_update_metrics_with_unrealized_pnl(self, session: TradingSession) -> None:
        """Test updating metrics with unrealized PnL."""
        session.start()
        session.update_metrics(
            realized_pnl=500.0,
            unrealized_pnl=100.0,
        )

        metrics = session.metrics
        assert metrics.unrealized_pnl == 100.0
        assert metrics.total_pnl == 600.0  # realized + unrealized

    def test_update_metrics_win_rate_calculation(
        self, session: TradingSession
    ) -> None:
        """Test win rate calculation in metrics update."""
        session.start()
        session.update_metrics(
            trades=20,
            wins=15,
        )

        metrics = session.metrics
        assert metrics.total_trades == 20
        assert metrics.winning_trades == 15
        assert metrics.losing_trades == 5  # 20 - 15
        assert metrics.win_rate == 75.0  # 15/20 * 100

    def test_runtime_after_stop(self, session: TradingSession) -> None:
        """Test runtime is preserved after stop."""
        session.start()
        time.sleep(0.05)
        session.stop()

        runtime = session.runtime_seconds
        time.sleep(0.05)

        # Runtime should be frozen after stop
        assert abs(session.runtime_seconds - runtime) < 0.01

    def test_to_dict_with_error(self, session: TradingSession) -> None:
        """Test to_dict includes error information."""
        session.start()
        session.set_error("Test error", "ERR_TEST")

        d = session.to_dict()
        assert d["errorMessage"] == "Test error"
        assert d["errorCode"] == "ERR_TEST"


class TestOfflineDetector:
    """Tests for OfflineDetector class."""

    def test_creation(self) -> None:
        """Test offline detector creation."""
        from quantlab.trading.session import OfflineDetector, NetworkStatus

        detector = OfflineDetector()
        assert detector.status == NetworkStatus.ONLINE
        assert detector.is_online is True
        assert detector.last_check is None

    def test_creation_with_callback(self) -> None:
        """Test creation with status change callback."""
        from quantlab.trading.session import OfflineDetector

        callback_called = []
        detector = OfflineDetector(
            check_interval=30.0,
            on_status_change=lambda s: callback_called.append(s),
        )
        assert detector._on_status_change is not None

    def test_start_stop(self) -> None:
        """Test starting and stopping monitoring."""
        from quantlab.trading.session import OfflineDetector

        detector = OfflineDetector(check_interval=60.0)  # Long interval
        detector.start()

        assert detector._running is True
        assert detector._check_thread is not None

        detector.stop()

        assert detector._running is False

    def test_start_when_already_running(self) -> None:
        """Test that start is idempotent."""
        from quantlab.trading.session import OfflineDetector

        detector = OfflineDetector(check_interval=60.0)
        detector.start()
        # Starting again should be safe
        detector.start()

        assert detector._running is True

        detector.stop()


class TestConnectivityCheckResult:
    """Tests for ConnectivityCheckResult dataclass."""

    def test_creation(self) -> None:
        """Test result creation."""
        from quantlab.trading.session import ConnectivityCheckResult, NetworkStatus

        result = ConnectivityCheckResult(
            status=NetworkStatus.ONLINE,
            latency_ms=50.0,
            broker_reachable=True,
            internet_reachable=True,
        )
        assert result.status == NetworkStatus.ONLINE
        assert result.latency_ms == 50.0
        assert result.broker_reachable is True

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        from quantlab.trading.session import ConnectivityCheckResult, NetworkStatus

        result = ConnectivityCheckResult(
            status=NetworkStatus.OFFLINE,
            latency_ms=None,
            broker_reachable=False,
            internet_reachable=False,
            error="Network unreachable",
        )
        d = result.to_dict()

        assert d["status"] == "offline"
        assert d["latencyMs"] is None
        assert d["brokerReachable"] is False
        assert d["error"] == "Network unreachable"


class TestNetworkStatus:
    """Tests for NetworkStatus enum."""

    def test_status_values(self) -> None:
        """Test network status values."""
        from quantlab.trading.session import NetworkStatus

        assert NetworkStatus.ONLINE.value == "online"
        assert NetworkStatus.OFFLINE.value == "offline"
        assert NetworkStatus.DEGRADED.value == "degraded"

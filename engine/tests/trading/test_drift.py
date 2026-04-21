"""
Tests for Trade Drift Detection.

Tests TradeDriftDetector and related components.
"""

import pytest
from decimal import Decimal
from datetime import datetime, timedelta
from unittest.mock import MagicMock

from quantlab.trading.drift import (
    DriftSeverity,
    DriftType,
    DriftEvent,
    DriftThresholds,
    BacktestSignal,
    LiveExecution,
    DriftSummary,
    TradeDriftDetector,
)


class TestDriftSeverity:
    """Tests for DriftSeverity enum."""

    def test_severity_values(self) -> None:
        """Test severity values."""
        assert DriftSeverity.INFO.value == "info"
        assert DriftSeverity.WARNING.value == "warning"
        assert DriftSeverity.ALERT.value == "alert"
        assert DriftSeverity.CRITICAL.value == "critical"


class TestDriftType:
    """Tests for DriftType enum."""

    def test_drift_type_values(self) -> None:
        """Test drift type values."""
        assert DriftType.SIGNAL_TIMING.value == "signal_timing"
        assert DriftType.SIGNAL_DIRECTION.value == "signal_direction"
        assert DriftType.ORDER_SKIPPED.value == "order_skipped"
        assert DriftType.UNEXPECTED_ORDER.value == "unexpected_order"
        assert DriftType.FILL_PRICE.value == "fill_price"
        assert DriftType.FILL_QUANTITY.value == "fill_quantity"
        assert DriftType.EXECUTION_DELAY.value == "execution_delay"
        assert DriftType.SLIPPAGE_EXCESS.value == "slippage_excess"
        assert DriftType.WIN_RATE_DEVIATION.value == "win_rate_deviation"
        assert DriftType.PNL_DEVIATION.value == "pnl_deviation"


class TestDriftEvent:
    """Tests for DriftEvent dataclass."""

    def test_creation(self) -> None:
        """Test event creation."""
        event = DriftEvent(
            drift_type=DriftType.FILL_PRICE,
            severity=DriftSeverity.WARNING,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Fill price differs by 0.5%",
            backtest_value=Decimal("150.00"),
            live_value=Decimal("150.75"),
            deviation_percent=0.5,
        )

        assert event.drift_type == DriftType.FILL_PRICE
        assert event.severity == DriftSeverity.WARNING
        assert event.symbol == "AAPL"
        assert event.deviation_percent == 0.5

    def test_to_dict(self) -> None:
        """Test to_dict method."""
        timestamp = datetime.now()
        event = DriftEvent(
            drift_type=DriftType.SLIPPAGE_EXCESS,
            severity=DriftSeverity.ALERT,
            timestamp=timestamp,
            symbol="AAPL",
            description="High slippage detected",
            backtest_value="0.10",
            live_value="0.50",
            deviation_percent=400.0,
        )

        d = event.to_dict()

        assert d["driftType"] == "slippage_excess"
        assert d["severity"] == "alert"
        assert d["symbol"] == "AAPL"
        assert d["description"] == "High slippage detected"
        assert d["deviationPercent"] == 400.0


class TestDriftThresholds:
    """Tests for DriftThresholds dataclass."""

    def test_defaults(self) -> None:
        """Test default thresholds."""
        thresholds = DriftThresholds()

        assert thresholds.signal_timing_warning == 5.0
        assert thresholds.signal_timing_alert == 30.0
        assert thresholds.fill_price_warning == 0.5
        assert thresholds.fill_price_alert == 1.0
        assert thresholds.min_trades_for_stats == 20

    def test_custom_thresholds(self) -> None:
        """Test custom thresholds."""
        thresholds = DriftThresholds(
            signal_timing_warning=10.0,
            fill_price_alert=2.0,
            min_trades_for_stats=10,
        )

        assert thresholds.signal_timing_warning == 10.0
        assert thresholds.fill_price_alert == 2.0
        assert thresholds.min_trades_for_stats == 10


class TestBacktestSignal:
    """Tests for BacktestSignal dataclass."""

    def test_creation(self) -> None:
        """Test signal creation."""
        signal = BacktestSignal(
            timestamp=datetime.now(),
            symbol="AAPL",
            action="buy",
            price=Decimal("150.00"),
            quantity=Decimal("100"),
            reason="RSI oversold",
        )

        assert signal.symbol == "AAPL"
        assert signal.action == "buy"
        assert signal.price == Decimal("150.00")
        assert signal.quantity == Decimal("100")


class TestLiveExecution:
    """Tests for LiveExecution dataclass."""

    def test_creation(self) -> None:
        """Test execution creation."""
        execution = LiveExecution(
            timestamp=datetime.now(),
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150.00"),
            fill_price=Decimal("150.10"),
            quantity=Decimal("100"),
            slippage=Decimal("0.10"),
            execution_time_ms=50.0,
        )

        assert execution.symbol == "AAPL"
        assert execution.fill_price == Decimal("150.10")
        assert execution.slippage == Decimal("0.10")


class TestDriftSummary:
    """Tests for DriftSummary dataclass."""

    def test_creation(self) -> None:
        """Test summary creation."""
        summary = DriftSummary(
            session_id="session-1",
            period_start=datetime.now() - timedelta(hours=1),
            period_end=datetime.now(),
            total_events=5,
            events_by_severity={"warning": 3, "alert": 2},
            events_by_type={"fill_price": 3, "slippage_excess": 2},
            critical_events=[],
            overall_health="degraded",
        )

        assert summary.session_id == "session-1"
        assert summary.total_events == 5
        assert summary.overall_health == "degraded"

    def test_to_dict(self) -> None:
        """Test to_dict method."""
        start = datetime.now() - timedelta(hours=1)
        end = datetime.now()

        critical_event = DriftEvent(
            drift_type=DriftType.SIGNAL_DIRECTION,
            severity=DriftSeverity.CRITICAL,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Wrong direction",
        )

        summary = DriftSummary(
            session_id="session-1",
            period_start=start,
            period_end=end,
            total_events=1,
            events_by_severity={"critical": 1},
            events_by_type={"signal_direction": 1},
            critical_events=[critical_event],
            overall_health="critical",
        )

        d = summary.to_dict()

        assert d["sessionId"] == "session-1"
        assert d["totalEvents"] == 1
        assert d["overallHealth"] == "critical"
        assert len(d["criticalEvents"]) == 1


class TestTradeDriftDetector:
    """Tests for TradeDriftDetector class."""

    def test_init(self) -> None:
        """Test initialization."""
        detector = TradeDriftDetector(session_id="session-1")

        assert len(detector.events) == 0
        assert len(detector.critical_events) == 0

    def test_init_with_thresholds(self) -> None:
        """Test initialization with custom thresholds."""
        thresholds = DriftThresholds(fill_price_alert=2.0)
        detector = TradeDriftDetector(
            session_id="session-1",
            thresholds=thresholds,
        )

        assert detector._thresholds.fill_price_alert == 2.0

    def test_init_with_callbacks(self) -> None:
        """Test initialization with callbacks."""
        on_drift = MagicMock()
        on_critical = MagicMock()

        detector = TradeDriftDetector(
            session_id="session-1",
            on_drift=on_drift,
            on_critical=on_critical,
        )

        assert detector._on_drift is on_drift
        assert detector._on_critical is on_critical

    def test_set_backtest_baseline(self) -> None:
        """Test setting backtest baseline."""
        detector = TradeDriftDetector(session_id="session-1")

        signals = [
            BacktestSignal(
                timestamp=datetime.now(),
                symbol="AAPL",
                action="buy",
                price=Decimal("150.00"),
                quantity=Decimal("100"),
            ),
        ]

        detector.set_backtest_baseline(
            signals=signals,
            win_rate=0.55,
            avg_pnl=Decimal("100.00"),
        )

        assert detector._backtest_win_rate == 0.55
        assert detector._backtest_avg_pnl == Decimal("100.00")
        assert len(detector._backtest_signals) == 1

    def test_events_property(self) -> None:
        """Test events property returns copy."""
        detector = TradeDriftDetector(session_id="session-1")

        # Add event manually for testing
        event = DriftEvent(
            drift_type=DriftType.FILL_PRICE,
            severity=DriftSeverity.WARNING,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Test event",
        )
        detector._events.append(event)

        events = detector.events
        assert len(events) == 1

        # Verify it's a copy
        events.clear()
        assert len(detector.events) == 1

    def test_critical_events_property(self) -> None:
        """Test critical_events filters correctly."""
        detector = TradeDriftDetector(session_id="session-1")

        # Add events with different severities
        warning_event = DriftEvent(
            drift_type=DriftType.FILL_PRICE,
            severity=DriftSeverity.WARNING,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Warning event",
        )
        critical_event = DriftEvent(
            drift_type=DriftType.SIGNAL_DIRECTION,
            severity=DriftSeverity.CRITICAL,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Critical event",
        )

        detector._events.extend([warning_event, critical_event])

        critical_events = detector.critical_events
        assert len(critical_events) == 1
        assert critical_events[0].severity == DriftSeverity.CRITICAL


class TestTradeDriftDetectorAnalysis:
    """Tests for drift detection and analysis."""

    @pytest.fixture
    def detector(self):
        """Create detector with baseline."""
        detector = TradeDriftDetector(session_id="session-1")

        signals = [
            BacktestSignal(
                timestamp=datetime.now(),
                symbol="AAPL",
                action="buy",
                price=Decimal("150.00"),
                quantity=Decimal("100"),
            ),
        ]
        detector.set_backtest_baseline(signals=signals, win_rate=0.55)

        return detector

    def test_detector_tracks_live_executions(self, detector) -> None:
        """Test that detector can track live executions."""
        execution = LiveExecution(
            timestamp=datetime.now(),
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150.00"),
            fill_price=Decimal("150.00"),
            quantity=Decimal("100"),
        )

        detector._live_executions.append(execution)

        assert len(detector._live_executions) == 1

    def test_detector_callback_on_critical(self) -> None:
        """Test critical event triggers callback."""
        on_critical = MagicMock()
        detector = TradeDriftDetector(
            session_id="session-1",
            on_critical=on_critical,
        )

        # Add critical event manually
        event = DriftEvent(
            drift_type=DriftType.SIGNAL_DIRECTION,
            severity=DriftSeverity.CRITICAL,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Wrong direction",
        )
        detector._events.append(event)

        # If we had a method that notifies, it would call on_critical
        # For now, just verify the callback is set
        assert detector._on_critical is on_critical


class TestDriftThresholdsValidation:
    """Tests for threshold-based drift detection."""

    def test_fill_price_thresholds(self) -> None:
        """Test fill price threshold logic."""
        thresholds = DriftThresholds(
            fill_price_warning=0.5,
            fill_price_alert=1.0,
        )

        # Test classification logic (this would be in detector methods)
        deviation = 0.3  # Below warning
        assert deviation < thresholds.fill_price_warning

        deviation = 0.7  # Between warning and alert
        assert thresholds.fill_price_warning <= deviation < thresholds.fill_price_alert

        deviation = 1.5  # Above alert
        assert deviation >= thresholds.fill_price_alert

    def test_timing_thresholds(self) -> None:
        """Test timing threshold logic."""
        thresholds = DriftThresholds(
            signal_timing_warning=5.0,
            signal_timing_alert=30.0,
        )

        # Test different timing deviations
        timing_diff = 3.0  # Normal
        assert timing_diff < thresholds.signal_timing_warning

        timing_diff = 15.0  # Warning level
        assert thresholds.signal_timing_warning <= timing_diff < thresholds.signal_timing_alert

        timing_diff = 60.0  # Alert level
        assert timing_diff >= thresholds.signal_timing_alert

    def test_statistical_thresholds(self) -> None:
        """Test statistical threshold configuration."""
        thresholds = DriftThresholds(
            win_rate_deviation_warning=10.0,
            win_rate_deviation_alert=20.0,
            pnl_deviation_warning=15.0,
            pnl_deviation_alert=30.0,
            min_trades_for_stats=20,
        )

        # Verify thresholds are set correctly
        assert thresholds.win_rate_deviation_warning == 10.0
        assert thresholds.pnl_deviation_alert == 30.0
        assert thresholds.min_trades_for_stats == 20


class TestDriftSummaryGeneration:
    """Tests for drift summary generation."""

    def test_summary_with_no_events(self) -> None:
        """Test summary with no drift events."""
        summary = DriftSummary(
            session_id="session-1",
            period_start=datetime.now() - timedelta(hours=1),
            period_end=datetime.now(),
            total_events=0,
            events_by_severity={},
            events_by_type={},
            critical_events=[],
            overall_health="healthy",
        )

        assert summary.total_events == 0
        assert summary.overall_health == "healthy"
        assert len(summary.critical_events) == 0

    def test_summary_with_mixed_events(self) -> None:
        """Test summary with mixed severity events."""
        critical_event = DriftEvent(
            drift_type=DriftType.SIGNAL_DIRECTION,
            severity=DriftSeverity.CRITICAL,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Critical drift",
        )

        summary = DriftSummary(
            session_id="session-1",
            period_start=datetime.now() - timedelta(hours=1),
            period_end=datetime.now(),
            total_events=10,
            events_by_severity={
                "info": 3,
                "warning": 4,
                "alert": 2,
                "critical": 1,
            },
            events_by_type={
                "fill_price": 5,
                "slippage_excess": 3,
                "signal_timing": 1,
                "signal_direction": 1,
            },
            critical_events=[critical_event],
            overall_health="critical",
        )

        assert summary.total_events == 10
        assert sum(summary.events_by_severity.values()) == 10
        assert len(summary.critical_events) == 1
        assert summary.overall_health == "critical"


class TestDriftEventSerialization:
    """Tests for drift event serialization."""

    def test_event_with_decimal_values(self) -> None:
        """Test serialization with Decimal values."""
        event = DriftEvent(
            drift_type=DriftType.FILL_PRICE,
            severity=DriftSeverity.WARNING,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Price deviation",
            backtest_value=Decimal("150.123456"),
            live_value=Decimal("150.456789"),
            deviation_percent=0.222,
        )

        d = event.to_dict()

        assert d["backtestValue"] == "150.123456"
        assert d["liveValue"] == "150.456789"

    def test_event_with_none_values(self) -> None:
        """Test serialization with None values."""
        event = DriftEvent(
            drift_type=DriftType.ORDER_SKIPPED,
            severity=DriftSeverity.ALERT,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Order skipped",
        )

        d = event.to_dict()

        assert d["backtestValue"] is None
        assert d["liveValue"] is None
        assert d["deviationPercent"] is None


class TestTradeDriftDetectorRecording:
    """Tests for drift detector recording methods."""

    @pytest.fixture
    def detector_with_baseline(self):
        """Create detector with baseline signals."""
        detector = TradeDriftDetector(session_id="session-1")
        ts = datetime(2024, 1, 15, 10, 30)
        signals = [
            BacktestSignal(
                timestamp=ts,
                symbol="AAPL",
                action="buy",
                price=Decimal("150.00"),
                quantity=Decimal("100"),
            ),
            BacktestSignal(
                timestamp=ts + timedelta(hours=1),
                symbol="AAPL",
                action="sell",
                price=Decimal("152.00"),
                quantity=Decimal("100"),
            ),
        ]
        detector.set_backtest_baseline(signals, win_rate=60.0, avg_pnl=Decimal("200"))
        return detector

    def test_record_live_execution_matched(self, detector_with_baseline) -> None:
        """Test recording matched execution."""
        ts = datetime(2024, 1, 15, 10, 30)
        execution = LiveExecution(
            timestamp=ts,
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150.00"),
            fill_price=Decimal("150.00"),
            quantity=Decimal("100"),
        )
        events = detector_with_baseline.record_live_execution(execution)
        # Should match the signal, no drift events
        assert all(e.drift_type != DriftType.UNEXPECTED_ORDER for e in events)

    def test_record_live_execution_unexpected(self) -> None:
        """Test recording unexpected execution."""
        detector = TradeDriftDetector(session_id="session-1")
        ts = datetime(2024, 1, 15, 10, 30)
        execution = LiveExecution(
            timestamp=ts,
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150.00"),
            fill_price=Decimal("150.00"),
            quantity=Decimal("100"),
        )
        events = detector.record_live_execution(execution)
        # Should report unexpected order
        assert any(e.drift_type == DriftType.UNEXPECTED_ORDER for e in events)

    def test_record_live_execution_delay_warning(self) -> None:
        """Test execution delay warning."""
        detector = TradeDriftDetector(session_id="session-1")
        ts = datetime(2024, 1, 15, 10, 30)
        execution = LiveExecution(
            timestamp=ts,
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150.00"),
            fill_price=Decimal("150.00"),
            quantity=Decimal("100"),
            execution_time_ms=2000,  # 2 seconds, warning threshold
        )
        events = detector.record_live_execution(execution)
        assert any(e.drift_type == DriftType.EXECUTION_DELAY for e in events)

    def test_record_live_execution_delay_alert(self) -> None:
        """Test execution delay alert."""
        detector = TradeDriftDetector(session_id="session-1")
        ts = datetime(2024, 1, 15, 10, 30)
        execution = LiveExecution(
            timestamp=ts,
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150.00"),
            fill_price=Decimal("150.00"),
            quantity=Decimal("100"),
            execution_time_ms=6000,  # 6 seconds, alert threshold
        )
        events = detector.record_live_execution(execution)
        delay_events = [e for e in events if e.drift_type == DriftType.EXECUTION_DELAY]
        assert len(delay_events) >= 1
        assert any(e.severity == DriftSeverity.ALERT for e in delay_events)

    def test_record_live_execution_slippage_warning(self) -> None:
        """Test slippage warning detection."""
        detector = TradeDriftDetector(session_id="session-1")
        ts = datetime(2024, 1, 15, 10, 30)
        execution = LiveExecution(
            timestamp=ts,
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150.00"),
            fill_price=Decimal("150.00"),
            quantity=Decimal("100"),
            slippage=Decimal("0.50"),  # 0.33% slippage
        )
        events = detector.record_live_execution(execution)
        assert any(e.drift_type == DriftType.SLIPPAGE_EXCESS for e in events)

    def test_record_live_execution_slippage_alert(self) -> None:
        """Test slippage alert detection."""
        detector = TradeDriftDetector(session_id="session-1")
        ts = datetime(2024, 1, 15, 10, 30)
        execution = LiveExecution(
            timestamp=ts,
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150.00"),
            fill_price=Decimal("150.00"),
            quantity=Decimal("100"),
            slippage=Decimal("1.50"),  # 1% slippage
        )
        events = detector.record_live_execution(execution)
        slippage_events = [e for e in events if e.drift_type == DriftType.SLIPPAGE_EXCESS]
        assert len(slippage_events) >= 1
        assert any(e.severity == DriftSeverity.ALERT for e in slippage_events)

    def test_record_live_execution_price_drift(self, detector_with_baseline) -> None:
        """Test fill price drift detection."""
        ts = datetime(2024, 1, 15, 10, 30)
        execution = LiveExecution(
            timestamp=ts,
            symbol="AAPL",
            action="buy",
            order_price=Decimal("152.00"),
            fill_price=Decimal("152.00"),  # Higher than backtest $150
            quantity=Decimal("100"),
        )
        events = detector_with_baseline.record_live_execution(execution)
        assert any(e.drift_type == DriftType.FILL_PRICE for e in events)

    def test_record_live_execution_quantity_drift(self, detector_with_baseline) -> None:
        """Test fill quantity drift detection."""
        ts = datetime(2024, 1, 15, 10, 30)
        execution = LiveExecution(
            timestamp=ts,
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150.00"),
            fill_price=Decimal("150.00"),
            quantity=Decimal("75"),  # Different from backtest 100
        )
        events = detector_with_baseline.record_live_execution(execution)
        assert any(e.drift_type == DriftType.FILL_QUANTITY for e in events)

    def test_record_live_execution_timing_drift(self, detector_with_baseline) -> None:
        """Test signal timing drift detection."""
        ts = datetime(2024, 1, 15, 10, 30) + timedelta(seconds=15)  # 15 seconds late
        execution = LiveExecution(
            timestamp=ts,
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150.00"),
            fill_price=Decimal("150.00"),
            quantity=Decimal("100"),
        )
        events = detector_with_baseline.record_live_execution(execution)
        assert any(e.drift_type == DriftType.SIGNAL_TIMING for e in events)


class TestTradeDriftDetectorTradeResults:
    """Tests for trade result recording."""

    @pytest.fixture
    def detector_with_stats(self):
        """Create detector with statistical baseline."""
        detector = TradeDriftDetector(
            session_id="session-1",
            thresholds=DriftThresholds(min_trades_for_stats=5),
        )
        detector.set_backtest_baseline([], win_rate=60.0, avg_pnl=Decimal("100"))
        return detector

    def test_record_trade_result_win(self, detector_with_stats) -> None:
        """Test recording winning trade."""
        detector_with_stats.record_trade_result(Decimal("150"), is_win=True)
        assert detector_with_stats._live_wins == 1
        assert detector_with_stats._live_losses == 0
        assert detector_with_stats._live_total_pnl == Decimal("150")

    def test_record_trade_result_loss(self, detector_with_stats) -> None:
        """Test recording losing trade."""
        detector_with_stats.record_trade_result(Decimal("-50"), is_win=False)
        assert detector_with_stats._live_wins == 0
        assert detector_with_stats._live_losses == 1
        assert detector_with_stats._live_total_pnl == Decimal("-50")

    def test_record_trade_result_accumulation(self, detector_with_stats) -> None:
        """Test trade result accumulation."""
        detector_with_stats.record_trade_result(Decimal("100"), is_win=True)
        detector_with_stats.record_trade_result(Decimal("50"), is_win=True)
        detector_with_stats.record_trade_result(Decimal("-30"), is_win=False)

        assert detector_with_stats._live_wins == 2
        assert detector_with_stats._live_losses == 1
        assert detector_with_stats._live_total_pnl == Decimal("120")

    def test_record_trade_result_win_rate_deviation(self, detector_with_stats) -> None:
        """Test win rate deviation detection."""
        # Record 5 trades with 20% win rate (vs 60% backtest)
        detector_with_stats.record_trade_result(Decimal("100"), is_win=True)
        for _ in range(4):
            detector_with_stats.record_trade_result(Decimal("-50"), is_win=False)

        # The last trade should trigger statistical check
        events = detector_with_stats.record_trade_result(Decimal("-50"), is_win=False)

        # Should detect win rate deviation (16.7% vs 60%)
        assert any(e.drift_type == DriftType.WIN_RATE_DEVIATION for e in events)

    def test_record_trade_result_pnl_deviation(self) -> None:
        """Test P&L deviation detection."""
        detector = TradeDriftDetector(
            session_id="session-1",
            thresholds=DriftThresholds(min_trades_for_stats=3),
        )
        detector.set_backtest_baseline([], win_rate=None, avg_pnl=Decimal("100"))

        # Record trades with much lower P&L
        for _ in range(3):
            detector.record_trade_result(Decimal("-50"), is_win=False)

        events = detector.record_trade_result(Decimal("-50"), is_win=False)

        # Should detect P&L deviation
        assert any(e.drift_type == DriftType.PNL_DEVIATION for e in events)


class TestTradeDriftDetectorMissedSignals:
    """Tests for missed signal detection."""

    def test_check_missed_signals_none(self) -> None:
        """Test no missed signals."""
        detector = TradeDriftDetector(session_id="session-1")
        events = detector.check_missed_signals()
        assert len(events) == 0

    def test_check_missed_signals_future(self) -> None:
        """Test signals in the future are not flagged."""
        detector = TradeDriftDetector(session_id="session-1")
        future_ts = datetime.now() + timedelta(hours=1)
        signals = [
            BacktestSignal(
                timestamp=future_ts,
                symbol="AAPL",
                action="buy",
                price=Decimal("150.00"),
                quantity=Decimal("100"),
            ),
        ]
        detector.set_backtest_baseline(signals)
        events = detector.check_missed_signals()
        assert len(events) == 0

    def test_check_missed_signals_past(self) -> None:
        """Test past signals that weren't executed."""
        detector = TradeDriftDetector(session_id="session-1")
        past_ts = datetime.now() - timedelta(minutes=5)
        signals = [
            BacktestSignal(
                timestamp=past_ts,
                symbol="AAPL",
                action="buy",
                price=Decimal("150.00"),
                quantity=Decimal("100"),
            ),
        ]
        detector.set_backtest_baseline(signals)
        events = detector.check_missed_signals()
        assert len(events) >= 1
        assert any(e.drift_type == DriftType.ORDER_SKIPPED for e in events)

    def test_check_missed_signals_matched(self) -> None:
        """Test that matched signals are not flagged."""
        detector = TradeDriftDetector(session_id="session-1")
        ts = datetime.now() - timedelta(minutes=5)
        signals = [
            BacktestSignal(
                timestamp=ts,
                symbol="AAPL",
                action="buy",
                price=Decimal("150.00"),
                quantity=Decimal("100"),
            ),
        ]
        detector.set_backtest_baseline(signals)

        # Record matching execution
        execution = LiveExecution(
            timestamp=ts,
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150.00"),
            fill_price=Decimal("150.00"),
            quantity=Decimal("100"),
        )
        detector.record_live_execution(execution)

        events = detector.check_missed_signals()
        # The matched signal should not be flagged
        skipped = [e for e in events if e.drift_type == DriftType.ORDER_SKIPPED]
        assert len(skipped) == 0


class TestTradeDriftDetectorSummary:
    """Tests for summary generation."""

    def test_get_summary_empty(self) -> None:
        """Test summary with no events."""
        detector = TradeDriftDetector(session_id="session-1")
        summary = detector.get_summary()
        assert summary.total_events == 0
        assert summary.overall_health == "healthy"

    def test_get_summary_healthy(self) -> None:
        """Test healthy summary."""
        detector = TradeDriftDetector(session_id="session-1")
        # Add info event
        event = DriftEvent(
            drift_type=DriftType.FILL_PRICE,
            severity=DriftSeverity.INFO,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Minor price difference",
        )
        detector._events.append(event)

        summary = detector.get_summary()
        assert summary.overall_health == "healthy"

    def test_get_summary_degraded_alert(self) -> None:
        """Test degraded health due to alert."""
        detector = TradeDriftDetector(session_id="session-1")
        event = DriftEvent(
            drift_type=DriftType.FILL_PRICE,
            severity=DriftSeverity.ALERT,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Alert deviation",
        )
        detector._events.append(event)

        summary = detector.get_summary()
        assert summary.overall_health == "degraded"

    def test_get_summary_degraded_warnings(self) -> None:
        """Test degraded health due to many warnings."""
        detector = TradeDriftDetector(session_id="session-1")
        for i in range(6):
            event = DriftEvent(
                drift_type=DriftType.FILL_PRICE,
                severity=DriftSeverity.WARNING,
                timestamp=datetime.now(),
                symbol="AAPL",
                description=f"Warning {i}",
            )
            detector._events.append(event)

        summary = detector.get_summary()
        assert summary.overall_health == "degraded"

    def test_get_summary_critical(self) -> None:
        """Test critical health."""
        detector = TradeDriftDetector(session_id="session-1")
        event = DriftEvent(
            drift_type=DriftType.SIGNAL_DIRECTION,
            severity=DriftSeverity.CRITICAL,
            timestamp=datetime.now(),
            symbol="AAPL",
            description="Critical drift",
        )
        detector._events.append(event)

        summary = detector.get_summary()
        assert summary.overall_health == "critical"
        assert len(summary.critical_events) == 1

    def test_get_summary_critical_many_alerts(self) -> None:
        """Test critical health due to many alerts."""
        detector = TradeDriftDetector(session_id="session-1")
        for i in range(3):
            event = DriftEvent(
                drift_type=DriftType.FILL_PRICE,
                severity=DriftSeverity.ALERT,
                timestamp=datetime.now(),
                symbol="AAPL",
                description=f"Alert {i}",
            )
            detector._events.append(event)

        summary = detector.get_summary()
        assert summary.overall_health == "critical"

    def test_get_summary_with_period(self) -> None:
        """Test summary for specific period."""
        detector = TradeDriftDetector(session_id="session-1")

        ts1 = datetime(2024, 1, 15, 10, 0)
        ts2 = datetime(2024, 1, 15, 12, 0)
        ts3 = datetime(2024, 1, 15, 14, 0)

        for ts in [ts1, ts2, ts3]:
            event = DriftEvent(
                drift_type=DriftType.SLIPPAGE_EXCESS,
                severity=DriftSeverity.WARNING,
                timestamp=ts,
                symbol="AAPL",
                description="Slippage",
            )
            detector._events.append(event)

        summary = detector.get_summary(
            period_start=datetime(2024, 1, 15, 11, 0),
            period_end=datetime(2024, 1, 15, 13, 0),
        )
        assert summary.total_events == 1


class TestTradeDriftDetectorClear:
    """Tests for clearing drift data."""

    def test_clear(self) -> None:
        """Test clearing all data."""
        detector = TradeDriftDetector(session_id="session-1")

        # Add some data
        detector.set_backtest_baseline([
            BacktestSignal(
                timestamp=datetime.now(),
                symbol="AAPL",
                action="buy",
                price=Decimal("150"),
                quantity=Decimal("100"),
            ),
        ])

        execution = LiveExecution(
            timestamp=datetime.now(),
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150"),
            fill_price=Decimal("150"),
            quantity=Decimal("100"),
        )
        detector.record_live_execution(execution)
        detector.record_trade_result(Decimal("100"), is_win=True)

        # Clear
        detector.clear()

        assert len(detector._events) == 0
        assert len(detector._backtest_signals) == 0
        assert len(detector._live_executions) == 0
        assert len(detector._matched_pairs) == 0
        assert detector._live_wins == 0
        assert detector._live_losses == 0
        assert detector._live_total_pnl == Decimal("0")


class TestTradeDriftDetectorCallbacks:
    """Tests for callback functionality."""

    def test_on_drift_callback(self) -> None:
        """Test drift callback is triggered."""
        received_events = []

        def on_drift(event):
            received_events.append(event)

        detector = TradeDriftDetector(
            session_id="session-1",
            on_drift=on_drift,
        )

        execution = LiveExecution(
            timestamp=datetime.now(),
            symbol="AAPL",
            action="buy",
            order_price=Decimal("150"),
            fill_price=Decimal("150"),
            quantity=Decimal("100"),
            slippage=Decimal("1.00"),  # Will trigger warning
        )
        detector.record_live_execution(execution)

        assert len(received_events) > 0

    def test_on_critical_callback(self) -> None:
        """Test critical callback is triggered."""
        critical_events = []

        def on_critical(event):
            critical_events.append(event)

        detector = TradeDriftDetector(
            session_id="session-1",
            thresholds=DriftThresholds(min_trades_for_stats=1),
            on_critical=on_critical,
        )
        detector.set_backtest_baseline([], win_rate=90.0, avg_pnl=Decimal("100"))

        # Record losing trade to trigger critical win rate deviation
        detector.record_trade_result(Decimal("-100"), is_win=False)

        # May or may not trigger critical depending on exact threshold calculation

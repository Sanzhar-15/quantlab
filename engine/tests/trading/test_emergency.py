"""
Tests for Emergency Flatten Protocol.

Tests EmergencyFlatten with mocked dependencies.
"""

import pytest
from decimal import Decimal
from datetime import datetime, timedelta
from unittest.mock import MagicMock, AsyncMock, patch

from quantlab.trading.emergency import (
    FlattenStage,
    FlattenReason,
    FlattenProgress,
    FlattenResult,
    FlattenConfig,
    EmergencyFlatten,
    emergency_flatten,
)
from quantlab.trading.broker import MarketQuote
from quantlab.trading.positions import Position


class TestFlattenStage:
    """Tests for FlattenStage enum."""

    def test_stage_values(self) -> None:
        """Test stage values."""
        assert FlattenStage.PENDING.value == "pending"
        assert FlattenStage.CANCELING_ORDERS.value == "canceling_orders"
        assert FlattenStage.STAGE_1_LIMIT.value == "stage_1_limit"
        assert FlattenStage.STAGE_2_MARKET.value == "stage_2_market"
        assert FlattenStage.COMPLETED.value == "completed"
        assert FlattenStage.FAILED.value == "failed"


class TestFlattenReason:
    """Tests for FlattenReason enum."""

    def test_reason_values(self) -> None:
        """Test reason values."""
        assert FlattenReason.USER_REQUEST.value == "user_request"
        assert FlattenReason.RISK_VIOLATION.value == "risk_violation"
        assert FlattenReason.MAX_DRAWDOWN.value == "max_drawdown"
        assert FlattenReason.DAILY_LOSS_LIMIT.value == "daily_loss_limit"
        assert FlattenReason.SYSTEM_ERROR.value == "system_error"
        assert FlattenReason.HEARTBEAT_FAILURE.value == "heartbeat_failure"
        assert FlattenReason.BROKER_DISCONNECT.value == "broker_disconnect"


class TestFlattenProgress:
    """Tests for FlattenProgress dataclass."""

    def test_creation(self) -> None:
        """Test progress creation."""
        progress = FlattenProgress(
            symbol="AAPL",
            initial_quantity=Decimal("100"),
            remaining_quantity=Decimal("50"),
            stage=FlattenStage.STAGE_1_LIMIT,
        )

        assert progress.symbol == "AAPL"
        assert progress.initial_quantity == Decimal("100")
        assert progress.remaining_quantity == Decimal("50")
        assert progress.stage == FlattenStage.STAGE_1_LIMIT
        assert progress.orders_submitted == []
        assert progress.last_error is None
        assert progress.attempts == 0


class TestFlattenResult:
    """Tests for FlattenResult dataclass."""

    def test_creation(self) -> None:
        """Test result creation."""
        result = FlattenResult(
            session_id="session-1",
            reason=FlattenReason.USER_REQUEST,
            started_at=datetime.now(),
            completed_at=None,
            stage=FlattenStage.PENDING,
            positions_flattened=0,
            positions_remaining=2,
            total_pnl=Decimal("0"),
        )

        assert result.session_id == "session-1"
        assert result.reason == FlattenReason.USER_REQUEST
        assert result.is_complete is False
        assert result.is_failed is False

    def test_is_complete(self) -> None:
        """Test is_complete property."""
        result = FlattenResult(
            session_id="session-1",
            reason=FlattenReason.USER_REQUEST,
            started_at=datetime.now(),
            completed_at=datetime.now(),
            stage=FlattenStage.COMPLETED,
            positions_flattened=2,
            positions_remaining=0,
            total_pnl=Decimal("100"),
        )

        assert result.is_complete is True
        assert result.is_failed is False

    def test_is_failed(self) -> None:
        """Test is_failed property."""
        result = FlattenResult(
            session_id="session-1",
            reason=FlattenReason.SYSTEM_ERROR,
            started_at=datetime.now(),
            completed_at=datetime.now(),
            stage=FlattenStage.FAILED,
            positions_flattened=1,
            positions_remaining=1,
            total_pnl=Decimal("-50"),
        )

        assert result.is_complete is False
        assert result.is_failed is True

    def test_to_dict(self) -> None:
        """Test to_dict method."""
        started = datetime.now()
        completed = started + timedelta(seconds=5)

        result = FlattenResult(
            session_id="session-1",
            reason=FlattenReason.USER_REQUEST,
            started_at=started,
            completed_at=completed,
            stage=FlattenStage.COMPLETED,
            positions_flattened=1,
            positions_remaining=0,
            total_pnl=Decimal("50.25"),
            progress={
                "AAPL": FlattenProgress(
                    symbol="AAPL",
                    initial_quantity=Decimal("100"),
                    remaining_quantity=Decimal("0"),
                    stage=FlattenStage.COMPLETED,
                    orders_submitted=["order-1"],
                    attempts=1,
                )
            },
        )

        d = result.to_dict()

        assert d["sessionId"] == "session-1"
        assert d["reason"] == "user_request"
        assert d["stage"] == "completed"
        assert d["positionsFlattened"] == 1
        assert d["positionsRemaining"] == 0
        assert d["totalPnl"] == "50.25"
        assert "AAPL" in d["progress"]
        assert d["progress"]["AAPL"]["stage"] == "completed"


class TestFlattenConfig:
    """Tests for FlattenConfig dataclass."""

    def test_defaults(self) -> None:
        """Test default configuration."""
        config = FlattenConfig()

        assert config.stage1_spread_multiplier == Decimal("1.5")
        assert config.stage1_timeout_seconds == 5.0
        assert config.stage2_enabled is True
        assert config.stage2_max_retries == 3
        assert config.stage2_base_delay_seconds == 1.0
        assert config.stage2_max_delay_seconds == 30.0
        assert config.require_quote_validation is True
        assert config.max_quote_age_seconds == 5.0
        assert config.max_spread_percent == Decimal("0.05")
        assert config.reject_wide_spread is True
        assert config.order_timeout_seconds == 30.0

    def test_custom_config(self) -> None:
        """Test custom configuration."""
        on_progress = MagicMock()
        on_complete = MagicMock()

        config = FlattenConfig(
            stage1_spread_multiplier=Decimal("2.0"),
            stage2_max_retries=5,
            on_progress=on_progress,
            on_complete=on_complete,
        )

        assert config.stage1_spread_multiplier == Decimal("2.0")
        assert config.stage2_max_retries == 5
        assert config.on_progress is on_progress
        assert config.on_complete is on_complete


class TestEmergencyFlatten:
    """Tests for EmergencyFlatten class."""

    @pytest.fixture
    def mock_broker(self):
        """Create mock broker."""
        broker = MagicMock()
        broker.get_quote = AsyncMock(
            return_value=MarketQuote(
                symbol="AAPL",
                bid=Decimal("149.90"),
                ask=Decimal("150.10"),
                last=Decimal("150.00"),
                timestamp=datetime.now(),
            )
        )
        broker.submit_order = AsyncMock(return_value="order-123")
        broker.cancel_order = AsyncMock(return_value=True)
        return broker

    @pytest.fixture
    def mock_order_manager(self):
        """Create mock order manager."""
        manager = MagicMock()
        manager.get_open_orders.return_value = []
        manager.create_order.return_value = MagicMock(order_id="order-123")
        manager.cancel_order = MagicMock()
        return manager

    @pytest.fixture
    def mock_position_tracker(self):
        """Create mock position tracker."""
        tracker = MagicMock()
        tracker.get_positions_for_session.return_value = []
        tracker.get_position.return_value = None
        return tracker

    def test_init(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test initialization."""
        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
        )

        assert flattener.is_running is False
        assert flattener.result is None

    def test_init_with_config(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test initialization with custom config."""
        config = FlattenConfig(stage2_max_retries=5)

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=config,
        )

        assert flattener._config.stage2_max_retries == 5

    @pytest.mark.asyncio
    async def test_execute_no_positions(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test execute with no positions."""
        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
        )

        result = await flattener.execute(FlattenReason.USER_REQUEST)

        assert result.is_complete is True
        assert result.positions_flattened == 0
        assert result.positions_remaining == 0

    @pytest.mark.asyncio
    async def test_execute_with_positions(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test execute with positions to flatten."""
        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )

        mock_position_tracker.get_positions_for_session.side_effect = [
            [position],  # Initial call
            [],  # After flattening (check if complete)
            [],  # _all_positions_flat check
        ]
        mock_position_tracker.get_position.return_value = None

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(
                stage1_timeout_seconds=0.1,
                require_quote_validation=False,
            ),
        )

        result = await flattener.execute(FlattenReason.USER_REQUEST)

        assert result.stage == FlattenStage.COMPLETED
        mock_order_manager.create_order.assert_called()

    @pytest.mark.asyncio
    async def test_execute_already_running(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test execute when already running."""
        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
        )

        flattener._is_running = True

        with pytest.raises(RuntimeError, match="Flatten already in progress"):
            await flattener.execute(FlattenReason.USER_REQUEST)

    @pytest.mark.asyncio
    async def test_execute_cancels_open_orders(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test that execute cancels open orders first."""
        open_order = MagicMock()
        open_order.order_id = "open-order-1"
        open_order.broker_order_id = "broker-order-1"

        mock_order_manager.get_open_orders.return_value = [open_order]

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
        )

        await flattener.execute(FlattenReason.USER_REQUEST)

        mock_broker.cancel_order.assert_called_with("broker-order-1")
        mock_order_manager.cancel_order.assert_called_with("open-order-1")

    @pytest.mark.asyncio
    async def test_execute_calls_on_complete(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test that on_complete callback is called."""
        on_complete = MagicMock()

        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )

        mock_position_tracker.get_positions_for_session.side_effect = [
            [position],  # Initial call
            [],  # After flattening
            [],  # Final check
        ]
        mock_position_tracker.get_position.return_value = None

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(
                on_complete=on_complete,
                stage1_timeout_seconds=0.1,
                require_quote_validation=False,
            ),
        )

        await flattener.execute(FlattenReason.USER_REQUEST)

        on_complete.assert_called_once()

    @pytest.mark.asyncio
    async def test_calculate_marketable_limit_long_position(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test marketable limit calculation for long position."""
        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
        )

        quote = MarketQuote(
            symbol="AAPL",
            bid=Decimal("100.00"),
            ask=Decimal("100.20"),
            last=Decimal("100.10"),
            timestamp=datetime.now(),
        )

        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),  # Long
            avg_entry_price=Decimal("99.00"),
        )

        price = flattener._calculate_marketable_limit(position, quote)

        # Should be below bid for selling
        assert price < quote.bid

    @pytest.mark.asyncio
    async def test_calculate_marketable_limit_short_position(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test marketable limit calculation for short position."""
        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
        )

        quote = MarketQuote(
            symbol="AAPL",
            bid=Decimal("100.00"),
            ask=Decimal("100.20"),
            last=Decimal("100.10"),
            timestamp=datetime.now(),
        )

        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("-100"),  # Short
            avg_entry_price=Decimal("101.00"),
        )

        price = flattener._calculate_marketable_limit(position, quote)

        # Should be above ask for buying
        assert price > quote.ask


class TestEmergencyFlattenQuoteValidation:
    """Tests for quote validation in EmergencyFlatten."""

    @pytest.fixture
    def mock_broker(self):
        """Create mock broker."""
        broker = MagicMock()
        return broker

    @pytest.fixture
    def mock_order_manager(self):
        """Create mock order manager."""
        return MagicMock()

    @pytest.fixture
    def mock_position_tracker(self):
        """Create mock position tracker."""
        return MagicMock()

    @pytest.mark.asyncio
    async def test_quote_validation_disabled(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test with quote validation disabled."""
        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(require_quote_validation=False),
        )

        quote = await flattener._get_validated_quote("AAPL")

        assert quote is not None
        assert quote.symbol == "AAPL"
        mock_broker.get_quote.assert_not_called()

    @pytest.mark.asyncio
    async def test_quote_validation_no_quote(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test with no quote available."""
        mock_broker.get_quote = AsyncMock(return_value=None)

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
        )

        quote = await flattener._get_validated_quote("AAPL")

        assert quote is None

    @pytest.mark.asyncio
    async def test_quote_validation_stale_quote(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test with stale quote."""
        stale_quote = MarketQuote(
            symbol="AAPL",
            bid=Decimal("100.00"),
            ask=Decimal("100.20"),
            last=Decimal("100.10"),
            timestamp=datetime.now() - timedelta(seconds=60),  # Old
        )
        mock_broker.get_quote = AsyncMock(return_value=stale_quote)

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(max_quote_age_seconds=5.0),
        )

        quote = await flattener._get_validated_quote("AAPL")

        assert quote is None

    @pytest.mark.asyncio
    async def test_quote_validation_valid_quote(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test with valid quote."""
        valid_quote = MarketQuote(
            symbol="AAPL",
            bid=Decimal("100.00"),
            ask=Decimal("100.20"),
            last=Decimal("100.10"),
            timestamp=datetime.now(),
        )
        mock_broker.get_quote = AsyncMock(return_value=valid_quote)

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
        )

        quote = await flattener._get_validated_quote("AAPL")

        assert quote is not None
        assert quote.symbol == "AAPL"


class TestEmergencyFlattenFunction:
    """Tests for emergency_flatten convenience function."""

    @pytest.fixture
    def mock_broker(self):
        """Create mock broker."""
        broker = MagicMock()
        broker.cancel_order = AsyncMock()
        return broker

    @pytest.fixture
    def mock_order_manager(self):
        """Create mock order manager."""
        manager = MagicMock()
        manager.get_open_orders.return_value = []
        return manager

    @pytest.fixture
    def mock_position_tracker(self):
        """Create mock position tracker."""
        tracker = MagicMock()
        tracker.get_positions_for_session.return_value = []
        return tracker

    @pytest.mark.asyncio
    async def test_emergency_flatten_function(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test emergency_flatten convenience function."""
        result = await emergency_flatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            reason=FlattenReason.USER_REQUEST,
        )

        assert result.session_id == "session-1"
        assert result.reason == FlattenReason.USER_REQUEST
        assert result.is_complete is True

    @pytest.mark.asyncio
    async def test_emergency_flatten_with_config(
        self, mock_broker, mock_order_manager, mock_position_tracker
    ) -> None:
        """Test emergency_flatten with custom config."""
        on_complete = MagicMock()

        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )

        mock_position_tracker.get_positions_for_session.side_effect = [
            [position],  # Initial call
            [],  # After flattening
            [],  # Final check
        ]
        mock_position_tracker.get_position.return_value = None

        config = FlattenConfig(
            on_complete=on_complete,
            stage1_timeout_seconds=0.1,
            require_quote_validation=False,
        )

        result = await emergency_flatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            reason=FlattenReason.RISK_VIOLATION,
            config=config,
        )

        assert result.reason == FlattenReason.RISK_VIOLATION
        on_complete.assert_called_once()


class TestEmergencyFlattenStage2:
    """Tests for Stage 2 market order execution."""

    @pytest.fixture
    def mock_broker(self):
        """Create mock broker."""
        broker = MagicMock()
        broker.get_quote = AsyncMock(
            return_value=MarketQuote(
                symbol="AAPL",
                bid=Decimal("149.90"),
                ask=Decimal("150.10"),
                last=Decimal("150.00"),
                timestamp=datetime.now(),
            )
        )
        broker.submit_order = AsyncMock(return_value="order-123")
        broker.cancel_order = AsyncMock(return_value=True)
        return broker

    @pytest.fixture
    def mock_order_manager(self):
        """Create mock order manager."""
        manager = MagicMock()
        manager.get_open_orders.return_value = []
        manager.create_order.return_value = MagicMock(order_id="order-123")
        manager.cancel_order = MagicMock()
        return manager

    @pytest.mark.asyncio
    async def test_stage_2_executed_when_stage_1_fails(
        self, mock_broker, mock_order_manager
    ) -> None:
        """Test Stage 2 executes when Stage 1 doesn't flatten all."""
        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )

        mock_position_tracker = MagicMock()
        # Position remains after stage 1, then flattens in stage 2
        mock_position_tracker.get_positions_for_session.side_effect = [
            [position],  # Initial
            [position],  # After stage 1 - still has position
            [],  # After stage 2 - flat
        ]
        mock_position_tracker.get_position.side_effect = [
            position,  # For stage 1 update
            None,  # After stage 2
        ]

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(
                stage1_timeout_seconds=0.1,
                stage2_enabled=True,
                stage2_base_delay_seconds=0.1,
                order_timeout_seconds=0.1,
                require_quote_validation=False,
            ),
        )

        result = await flattener.execute(FlattenReason.USER_REQUEST)

        assert result.stage == FlattenStage.COMPLETED

    @pytest.mark.asyncio
    async def test_stage_2_disabled(self, mock_broker, mock_order_manager) -> None:
        """Test that Stage 2 doesn't run when disabled."""
        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )

        mock_position_tracker = MagicMock()
        # Position remains after stage 1
        mock_position_tracker.get_positions_for_session.side_effect = [
            [position],  # Initial
            [position],  # After stage 1
            [position],  # Final check
        ]
        mock_position_tracker.get_position.return_value = position

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(
                stage1_timeout_seconds=0.1,
                stage2_enabled=False,
                require_quote_validation=False,
            ),
        )

        result = await flattener.execute(FlattenReason.USER_REQUEST)

        # Should fail since stage 2 disabled and positions remain
        assert result.stage == FlattenStage.FAILED
        # Check there's an error
        assert len(result.errors) > 0


class TestEmergencyFlattenExceptionHandling:
    """Tests for exception handling in EmergencyFlatten."""

    @pytest.mark.asyncio
    async def test_execute_handles_exception(self) -> None:
        """Test execute handles exceptions gracefully."""
        mock_broker = MagicMock()
        mock_broker.cancel_order = AsyncMock()

        mock_order_manager = MagicMock()
        mock_order_manager.get_open_orders.side_effect = Exception("Database error")

        mock_position_tracker = MagicMock()

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
        )

        result = await flattener.execute(FlattenReason.USER_REQUEST)

        assert result.stage == FlattenStage.FAILED
        assert "Database error" in result.errors
        assert flattener.is_running is False  # Cleaned up

    @pytest.mark.asyncio
    async def test_cancel_order_handles_exception(self) -> None:
        """Test that cancel order failures are handled."""
        mock_broker = MagicMock()
        mock_broker.cancel_order = AsyncMock(side_effect=Exception("Cancel failed"))

        open_order = MagicMock()
        open_order.order_id = "order-1"
        open_order.broker_order_id = "broker-1"

        mock_order_manager = MagicMock()
        mock_order_manager.get_open_orders.return_value = [open_order]

        mock_position_tracker = MagicMock()
        mock_position_tracker.get_positions_for_session.return_value = []

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
        )

        # Should not raise - just log warning
        result = await flattener.execute(FlattenReason.USER_REQUEST)
        assert result.is_complete  # Continues despite cancel failure


class TestEmergencyFlattenOrderSubmission:
    """Tests for order submission in EmergencyFlatten."""

    @pytest.fixture
    def mock_broker(self):
        """Create mock broker."""
        broker = MagicMock()
        broker.get_quote = AsyncMock(return_value=None)
        broker.submit_order = AsyncMock(return_value="order-123")
        broker.cancel_order = AsyncMock()
        return broker

    @pytest.fixture
    def mock_order_manager(self):
        """Create mock order manager."""
        manager = MagicMock()
        manager.get_open_orders.return_value = []
        manager.create_order.return_value = MagicMock(order_id="order-123")
        return manager

    @pytest.mark.asyncio
    async def test_submit_order_failure(
        self, mock_broker, mock_order_manager
    ) -> None:
        """Test that order submission failures are handled."""
        mock_broker.submit_order = AsyncMock(side_effect=Exception("Submit failed"))

        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )

        mock_position_tracker = MagicMock()
        mock_position_tracker.get_positions_for_session.side_effect = [
            [position],
            [position],  # Still has position
            [position],
        ]
        mock_position_tracker.get_position.return_value = position

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(
                stage1_timeout_seconds=0.1,
                stage2_enabled=False,
                require_quote_validation=False,
            ),
        )

        result = await flattener.execute(FlattenReason.USER_REQUEST)

        # Should fail since couldn't submit orders
        assert result.stage == FlattenStage.FAILED

    @pytest.mark.asyncio
    async def test_quote_validation_exception(
        self, mock_broker, mock_order_manager
    ) -> None:
        """Test quote validation exception handling."""
        mock_broker.get_quote = AsyncMock(side_effect=Exception("Quote service down"))

        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )

        mock_position_tracker = MagicMock()
        mock_position_tracker.get_positions_for_session.side_effect = [
            [position],
            [position],
            [position],
        ]
        mock_position_tracker.get_position.return_value = position

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(
                stage1_timeout_seconds=0.1,
                stage2_enabled=False,
                require_quote_validation=True,  # Requires validation
            ),
        )

        result = await flattener.execute(FlattenReason.USER_REQUEST)

        # Quote validation failure should be handled
        assert result.stage == FlattenStage.FAILED

    @pytest.mark.asyncio
    async def test_wide_spread_quote_logs_warning(
        self, mock_broker, mock_order_manager
    ) -> None:
        """Test that wide spread quote logs warning but continues."""
        wide_spread_quote = MarketQuote(
            symbol="AAPL",
            bid=Decimal("100.00"),
            ask=Decimal("120.00"),  # 20% spread
            last=Decimal("110.00"),
            timestamp=datetime.now(),
        )
        mock_broker.get_quote = AsyncMock(return_value=wide_spread_quote)

        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("110.00"),
        )

        mock_position_tracker = MagicMock()
        mock_position_tracker.get_positions_for_session.side_effect = [
            [position],
            [],  # Flat after stage 1
            [],
        ]
        mock_position_tracker.get_position.return_value = None

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(
                stage1_timeout_seconds=0.1,
                max_spread_percent=Decimal("0.05"),  # 5% max
            ),
        )

        result = await flattener.execute(FlattenReason.USER_REQUEST)

        # Should still complete despite wide spread
        assert result.stage == FlattenStage.COMPLETED


class TestEmergencyFlattenProgressNotification:
    """Tests for progress notification callbacks."""

    @pytest.mark.asyncio
    async def test_on_progress_callback(self) -> None:
        """Test that on_progress callback is called."""
        on_progress = MagicMock()

        mock_broker = MagicMock()
        mock_broker.cancel_order = AsyncMock()
        mock_broker.submit_order = AsyncMock(return_value="order-123")
        mock_broker.get_quote = AsyncMock(return_value=None)

        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )

        mock_order_manager = MagicMock()
        mock_order_manager.get_open_orders.return_value = []
        mock_order_manager.create_order.return_value = MagicMock(order_id="order-1")

        mock_position_tracker = MagicMock()
        mock_position_tracker.get_positions_for_session.side_effect = [
            [position],
            [],
            [],
        ]
        mock_position_tracker.get_position.return_value = None

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(
                on_progress=on_progress,
                stage1_timeout_seconds=0.1,
                require_quote_validation=False,
            ),
        )

        await flattener.execute(FlattenReason.USER_REQUEST)

        # Progress callback should have been called
        assert on_progress.call_count >= 1

    @pytest.mark.asyncio
    async def test_update_progress_tracks_positions(self) -> None:
        """Test that _update_progress correctly tracks position changes."""
        mock_broker = MagicMock()
        mock_broker.cancel_order = AsyncMock()
        mock_broker.submit_order = AsyncMock(return_value="order-123")
        mock_broker.get_quote = AsyncMock(return_value=None)

        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )

        mock_order_manager = MagicMock()
        mock_order_manager.get_open_orders.return_value = []
        mock_order_manager.create_order.return_value = MagicMock(order_id="order-1")

        mock_position_tracker = MagicMock()
        mock_position_tracker.get_positions_for_session.side_effect = [
            [position],
            [],  # Flat
            [],
        ]
        # Position gone after flatten
        mock_position_tracker.get_position.return_value = None

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(
                stage1_timeout_seconds=0.1,
                require_quote_validation=False,
            ),
        )

        result = await flattener.execute(FlattenReason.USER_REQUEST)

        # Should track that AAPL was flattened
        assert "AAPL" in result.progress
        assert result.progress["AAPL"].remaining_quantity == Decimal("0")


class TestEmergencyFlattenZeroQuantityPosition:
    """Tests for handling zero quantity positions."""

    @pytest.mark.asyncio
    async def test_skip_zero_quantity_positions(self) -> None:
        """Test that zero quantity positions are skipped."""
        mock_broker = MagicMock()
        mock_broker.cancel_order = AsyncMock()
        mock_broker.submit_order = AsyncMock(return_value="order-123")
        mock_broker.get_quote = AsyncMock(return_value=None)

        # Position with zero quantity
        position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("0"),  # Zero quantity
            avg_entry_price=Decimal("150.00"),
        )

        mock_order_manager = MagicMock()
        mock_order_manager.get_open_orders.return_value = []
        mock_order_manager.create_order.return_value = MagicMock(order_id="order-1")

        mock_position_tracker = MagicMock()
        mock_position_tracker.get_positions_for_session.side_effect = [
            [position],
            [],
            [],
        ]

        flattener = EmergencyFlatten(
            session_id="session-1",
            broker=mock_broker,
            order_manager=mock_order_manager,
            position_tracker=mock_position_tracker,
            config=FlattenConfig(
                stage1_timeout_seconds=0.1,
                require_quote_validation=False,
            ),
        )

        result = await flattener.execute(FlattenReason.USER_REQUEST)

        # Should complete, zero qty position skipped
        assert result.stage == FlattenStage.COMPLETED
        # No order should be created for zero qty position
        mock_order_manager.create_order.assert_not_called()

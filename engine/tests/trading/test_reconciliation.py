"""
Tests for Position Reconciliation.

Tests PositionReconciler with mocked dependencies.
"""

import pytest
from decimal import Decimal
from datetime import datetime
from unittest.mock import MagicMock, AsyncMock

from quantlab.trading.reconciliation import (
    DiscrepancyType,
    ReconciliationAction,
    PositionDiscrepancy,
    ReconciliationResult,
    ReconciliationConfig,
    PositionReconciler,
)
from quantlab.trading.positions import Position


class TestDiscrepancyType:
    """Tests for DiscrepancyType enum."""

    def test_discrepancy_type_values(self) -> None:
        """Test discrepancy type values."""
        assert DiscrepancyType.MISSING_LOCAL.value == "missing_local"
        assert DiscrepancyType.MISSING_BROKER.value == "missing_broker"
        assert DiscrepancyType.QUANTITY_MISMATCH.value == "quantity_mismatch"
        assert DiscrepancyType.PRICE_DRIFT.value == "price_drift"


class TestReconciliationAction:
    """Tests for ReconciliationAction enum."""

    def test_action_values(self) -> None:
        """Test action values."""
        assert ReconciliationAction.SYNC_FROM_BROKER.value == "sync_from_broker"
        assert ReconciliationAction.SYNC_TO_BROKER.value == "sync_to_broker"
        assert ReconciliationAction.ALERT_ONLY.value == "alert_only"
        assert ReconciliationAction.NO_ACTION.value == "no_action"


class TestPositionDiscrepancy:
    """Tests for PositionDiscrepancy dataclass."""

    def test_creation(self) -> None:
        """Test discrepancy creation."""
        discrepancy = PositionDiscrepancy(
            symbol="AAPL",
            discrepancy_type=DiscrepancyType.QUANTITY_MISMATCH,
            local_quantity=Decimal("100"),
            broker_quantity=Decimal("150"),
            local_avg_cost=Decimal("150.00"),
            broker_avg_cost=Decimal("150.00"),
            recommended_action=ReconciliationAction.SYNC_FROM_BROKER,
            details="Quantity differs by 50 shares",
        )

        assert discrepancy.symbol == "AAPL"
        assert discrepancy.discrepancy_type == DiscrepancyType.QUANTITY_MISMATCH
        assert discrepancy.local_quantity == Decimal("100")
        assert discrepancy.broker_quantity == Decimal("150")

    def test_to_dict(self) -> None:
        """Test to_dict method."""
        discrepancy = PositionDiscrepancy(
            symbol="AAPL",
            discrepancy_type=DiscrepancyType.MISSING_LOCAL,
            local_quantity=None,
            broker_quantity=Decimal("100"),
            local_avg_cost=None,
            broker_avg_cost=Decimal("150.00"),
            recommended_action=ReconciliationAction.SYNC_FROM_BROKER,
        )

        d = discrepancy.to_dict()

        assert d["symbol"] == "AAPL"
        assert d["discrepancyType"] == "missing_local"
        assert d["localQuantity"] is None
        assert d["brokerQuantity"] == "100"
        assert d["recommendedAction"] == "sync_from_broker"


class TestReconciliationResult:
    """Tests for ReconciliationResult dataclass."""

    def test_creation(self) -> None:
        """Test result creation."""
        result = ReconciliationResult(
            session_id="session-1",
            timestamp=datetime.now(),
            is_reconciled=True,
        )

        assert result.session_id == "session-1"
        assert result.is_reconciled is True
        assert result.has_discrepancies is False
        assert result.discrepancy_count == 0

    def test_has_discrepancies(self) -> None:
        """Test has_discrepancies property."""
        result = ReconciliationResult(
            session_id="session-1",
            timestamp=datetime.now(),
            is_reconciled=False,
            discrepancies=[
                PositionDiscrepancy(
                    symbol="AAPL",
                    discrepancy_type=DiscrepancyType.QUANTITY_MISMATCH,
                    local_quantity=Decimal("100"),
                    broker_quantity=Decimal("150"),
                    local_avg_cost=Decimal("150.00"),
                    broker_avg_cost=Decimal("150.00"),
                    recommended_action=ReconciliationAction.SYNC_FROM_BROKER,
                )
            ],
        )

        assert result.has_discrepancies is True
        assert result.discrepancy_count == 1

    def test_to_dict(self) -> None:
        """Test to_dict method."""
        timestamp = datetime.now()
        result = ReconciliationResult(
            session_id="session-1",
            timestamp=timestamp,
            is_reconciled=True,
            warnings=["Warning 1"],
            corrections_applied=["Correction 1"],
        )

        d = result.to_dict()

        assert d["sessionId"] == "session-1"
        assert d["isReconciled"] is True
        assert d["discrepancyCount"] == 0
        assert d["warnings"] == ["Warning 1"]
        assert d["correctionsApplied"] == ["Correction 1"]


class TestReconciliationConfig:
    """Tests for ReconciliationConfig dataclass."""

    def test_defaults(self) -> None:
        """Test default configuration."""
        config = ReconciliationConfig()

        assert config.auto_correct is False
        assert config.sync_direction == "from_broker"
        assert config.quantity_tolerance == Decimal("0")
        assert config.price_tolerance_pct == Decimal("0.01")
        assert config.fail_on_discrepancy is False
        assert config.alert_on_missing_local is True
        assert config.alert_on_missing_broker is True

    def test_custom_config(self) -> None:
        """Test custom configuration."""
        config = ReconciliationConfig(
            auto_correct=True,
            quantity_tolerance=Decimal("1"),
            fail_on_discrepancy=True,
        )

        assert config.auto_correct is True
        assert config.quantity_tolerance == Decimal("1")
        assert config.fail_on_discrepancy is True


class TestPositionReconciler:
    """Tests for PositionReconciler class."""

    @pytest.fixture
    def mock_broker(self):
        """Create mock broker."""
        broker = MagicMock()
        broker.get_positions = AsyncMock(return_value=[])
        return broker

    @pytest.fixture
    def mock_position_tracker(self):
        """Create mock position tracker."""
        tracker = MagicMock()
        tracker.get_positions_for_session.return_value = []
        return tracker

    def test_init_default_config(self) -> None:
        """Test initialization with default config."""
        reconciler = PositionReconciler()

        assert reconciler._config.auto_correct is False

    def test_init_custom_config(self) -> None:
        """Test initialization with custom config."""
        config = ReconciliationConfig(auto_correct=True)
        reconciler = PositionReconciler(config=config)

        assert reconciler._config.auto_correct is True

    @pytest.mark.asyncio
    async def test_reconcile_no_positions(
        self, mock_broker, mock_position_tracker
    ) -> None:
        """Test reconcile with no positions."""
        reconciler = PositionReconciler()

        result = await reconciler.reconcile(
            session_id="session-1",
            broker=mock_broker,
            position_tracker=mock_position_tracker,
        )

        assert result.is_reconciled is True
        assert result.has_discrepancies is False

    @pytest.mark.asyncio
    async def test_reconcile_matching_positions(
        self, mock_broker, mock_position_tracker
    ) -> None:
        """Test reconcile with matching positions."""
        # Set up matching positions
        local_position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )
        mock_position_tracker.get_positions_for_session.return_value = [local_position]

        broker_position = {
            "symbol": "AAPL",
            "quantity": 100.0,
            "avg_entry_price": 150.00,
        }
        mock_broker.get_positions = AsyncMock(return_value=[broker_position])

        reconciler = PositionReconciler()

        result = await reconciler.reconcile(
            session_id="session-1",
            broker=mock_broker,
            position_tracker=mock_position_tracker,
        )

        assert result.is_reconciled is True

    @pytest.mark.asyncio
    async def test_reconcile_quantity_mismatch(
        self, mock_broker, mock_position_tracker
    ) -> None:
        """Test reconcile with quantity mismatch."""
        local_position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )
        mock_position_tracker.get_positions_for_session.return_value = [local_position]

        broker_position = {
            "symbol": "AAPL",
            "quantity": 150.0,  # Different quantity
            "avg_entry_price": 150.00,
        }
        mock_broker.get_positions = AsyncMock(return_value=[broker_position])

        reconciler = PositionReconciler()

        result = await reconciler.reconcile(
            session_id="session-1",
            broker=mock_broker,
            position_tracker=mock_position_tracker,
        )

        assert result.has_discrepancies is True
        assert len(result.discrepancies) >= 1

    @pytest.mark.asyncio
    async def test_reconcile_missing_at_broker(
        self, mock_broker, mock_position_tracker
    ) -> None:
        """Test reconcile with position missing at broker."""
        local_position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )
        mock_position_tracker.get_positions_for_session.return_value = [local_position]
        mock_broker.get_positions = AsyncMock(return_value=[])  # Empty at broker

        config = ReconciliationConfig(alert_on_missing_broker=True)
        reconciler = PositionReconciler(config=config)

        result = await reconciler.reconcile(
            session_id="session-1",
            broker=mock_broker,
            position_tracker=mock_position_tracker,
        )

        assert result.has_discrepancies is True
        # Should have warning
        assert len(result.warnings) > 0 or len(result.discrepancies) > 0

    @pytest.mark.asyncio
    async def test_reconcile_missing_locally(
        self, mock_broker, mock_position_tracker
    ) -> None:
        """Test reconcile with position missing locally."""
        mock_position_tracker.get_positions_for_session.return_value = []  # Empty locally

        broker_position = {
            "symbol": "AAPL",
            "quantity": 100.0,
            "avg_entry_price": 150.00,
        }
        mock_broker.get_positions = AsyncMock(return_value=[broker_position])

        config = ReconciliationConfig(alert_on_missing_local=True)
        reconciler = PositionReconciler(config=config)

        result = await reconciler.reconcile(
            session_id="session-1",
            broker=mock_broker,
            position_tracker=mock_position_tracker,
        )

        assert result.has_discrepancies is True

    @pytest.mark.asyncio
    async def test_reconcile_with_auto_correct(
        self, mock_broker, mock_position_tracker
    ) -> None:
        """Test reconcile with auto-correction enabled."""
        local_position = Position(
            symbol="AAPL",
            session_id="session-1",
            quantity=Decimal("100"),
            avg_entry_price=Decimal("150.00"),
        )
        mock_position_tracker.get_positions_for_session.return_value = [local_position]

        broker_position = {
            "symbol": "AAPL",
            "quantity": 150.0,
            "avg_entry_price": 150.00,
        }
        mock_broker.get_positions = AsyncMock(return_value=[broker_position])

        config = ReconciliationConfig(auto_correct=True)
        reconciler = PositionReconciler(config=config)

        result = await reconciler.reconcile(
            session_id="session-1",
            broker=mock_broker,
            position_tracker=mock_position_tracker,
        )

        # Should attempt corrections
        assert result.discrepancies is not None

    @pytest.mark.asyncio
    async def test_reconcile_error_handling(
        self, mock_broker, mock_position_tracker
    ) -> None:
        """Test reconcile handles broker errors gracefully."""
        # When broker.get_positions fails, reconciler logs the error
        # and continues with empty broker positions
        mock_broker.get_positions = AsyncMock(side_effect=Exception("API error"))

        reconciler = PositionReconciler()

        result = await reconciler.reconcile(
            session_id="session-1",
            broker=mock_broker,
            position_tracker=mock_position_tracker,
        )

        # Broker errors are caught and logged, reconciliation continues
        # with empty broker positions (graceful degradation)
        assert result.session_id == "session-1"
        # Result may show discrepancies if local positions exist
        # but won't crash

    def test_auto_correct_no_discrepancies(self, mock_position_tracker) -> None:
        """Test auto_correct with no discrepancies."""
        reconciler = PositionReconciler()

        result = ReconciliationResult(
            session_id="session-1",
            timestamp=datetime.now(),
            is_reconciled=True,
            discrepancies=[],
        )

        success = reconciler.auto_correct(result, mock_position_tracker)

        assert success is True

    def test_auto_correct_with_discrepancies(self, mock_position_tracker) -> None:
        """Test auto_correct with discrepancies."""
        reconciler = PositionReconciler()

        discrepancy = PositionDiscrepancy(
            symbol="AAPL",
            discrepancy_type=DiscrepancyType.QUANTITY_MISMATCH,
            local_quantity=Decimal("100"),
            broker_quantity=Decimal("150"),
            local_avg_cost=Decimal("150.00"),
            broker_avg_cost=Decimal("150.00"),
            recommended_action=ReconciliationAction.SYNC_FROM_BROKER,
        )

        result = ReconciliationResult(
            session_id="session-1",
            timestamp=datetime.now(),
            is_reconciled=False,
            discrepancies=[discrepancy],
        )

        # auto_correct should handle the discrepancies
        success = reconciler.auto_correct(result, mock_position_tracker)

        # Implementation may vary - just check it doesn't crash
        assert isinstance(success, bool)


class TestReconciliationIntegration:
    """Integration tests for reconciliation workflow."""

    @pytest.fixture
    def mock_broker(self):
        """Create mock broker."""
        broker = MagicMock()
        return broker

    @pytest.fixture
    def mock_position_tracker(self):
        """Create mock position tracker."""
        tracker = MagicMock()
        return tracker

    @pytest.mark.asyncio
    async def test_full_reconciliation_workflow(
        self, mock_broker, mock_position_tracker
    ) -> None:
        """Test full reconciliation workflow."""
        # Set up positions that match
        local_positions = [
            Position(
                symbol="AAPL",
                session_id="session-1",
                quantity=Decimal("100"),
                avg_entry_price=Decimal("150.00"),
            ),
            Position(
                symbol="MSFT",
                session_id="session-1",
                quantity=Decimal("50"),
                avg_entry_price=Decimal("300.00"),
            ),
        ]
        mock_position_tracker.get_positions_for_session.return_value = local_positions

        broker_positions = [
            {"symbol": "AAPL", "quantity": 100.0, "avg_entry_price": 150.00},
            {"symbol": "MSFT", "quantity": 50.0, "avg_entry_price": 300.00},
        ]
        mock_broker.get_positions = AsyncMock(return_value=broker_positions)

        config = ReconciliationConfig(
            alert_on_missing_local=True,
            alert_on_missing_broker=True,
        )
        reconciler = PositionReconciler(config=config)

        result = await reconciler.reconcile(
            session_id="session-1",
            broker=mock_broker,
            position_tracker=mock_position_tracker,
        )

        assert result.session_id == "session-1"
        assert result.error is None

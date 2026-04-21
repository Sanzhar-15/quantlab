"""
Tests for Fill Reconciliation Module.

Tests fill tracking, idempotency, and aggregation.
"""

from datetime import datetime
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

from quantlab.trading.fills import (
    FillStatus,
    Fill,
    FillReconciliationResult,
    FillReconciliationState,
    FillReconciler,
    FillAggregator,
)
from quantlab.trading.positions import PositionTracker


class TestFillStatus:
    """Tests for FillStatus enum."""

    def test_status_values(self) -> None:
        """Test all status values."""
        assert FillStatus.PENDING.value == "pending"
        assert FillStatus.APPLIED.value == "applied"
        assert FillStatus.DUPLICATE.value == "duplicate"
        assert FillStatus.REJECTED.value == "rejected"
        assert FillStatus.ERROR.value == "error"


class TestFill:
    """Tests for Fill dataclass."""

    def test_creation(self) -> None:
        """Test fill creation."""
        fill = Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
        )

        assert fill.fill_id == "F001"
        assert fill.symbol == "AAPL"
        assert fill.side == "buy"
        assert fill.quantity == Decimal("100")
        assert fill.price == Decimal("150.00")

    def test_default_values(self) -> None:
        """Test fill default values."""
        fill = Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
        )

        assert fill.commission == Decimal("0")
        assert fill.execution_venue == ""
        assert fill.liquidity == ""

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        timestamp = datetime(2024, 1, 15, 10, 30, 0)
        fill = Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
            commission=Decimal("1.00"),
            timestamp=timestamp,
        )

        d = fill.to_dict()

        assert d["fillId"] == "F001"
        assert d["symbol"] == "AAPL"
        assert d["quantity"] == "100"
        assert d["price"] == "150.00"
        assert "2024-01-15" in d["timestamp"]

    def test_from_dict(self) -> None:
        """Test creation from dictionary."""
        data = {
            "fillId": "F001",
            "brokerOrderId": "B001",
            "clientOrderId": "C001",
            "symbol": "AAPL",
            "side": "buy",
            "quantity": "100",
            "price": "150.00",
            "timestamp": "2024-01-15T10:30:00",
        }

        fill = Fill.from_dict(data)

        assert fill.fill_id == "F001"
        assert fill.symbol == "AAPL"
        assert fill.quantity == Decimal("100")

    def test_roundtrip(self) -> None:
        """Test to_dict/from_dict roundtrip."""
        original = Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
            commission=Decimal("1.50"),
        )

        d = original.to_dict()
        restored = Fill.from_dict(d)

        assert restored.fill_id == original.fill_id
        assert restored.quantity == original.quantity
        assert restored.price == original.price


class TestFillReconciliationResult:
    """Tests for FillReconciliationResult dataclass."""

    def test_creation(self) -> None:
        """Test result creation."""
        result = FillReconciliationResult(
            fill_id="F001",
            status=FillStatus.APPLIED,
            message="Success",
            position_updated=True,
        )

        assert result.fill_id == "F001"
        assert result.status == FillStatus.APPLIED
        assert result.position_updated is True

    def test_default_values(self) -> None:
        """Test result default values."""
        result = FillReconciliationResult(
            fill_id="F001",
            status=FillStatus.PENDING,
        )

        assert result.message == ""
        assert result.position_updated is False
        assert result.previous_quantity is None
        assert result.new_quantity is None


class TestFillReconciliationState:
    """Tests for FillReconciliationState dataclass."""

    def test_creation(self) -> None:
        """Test state creation."""
        state = FillReconciliationState(session_id="session-1")

        assert state.session_id == "session-1"
        assert len(state.processed_fill_ids) == 0
        assert len(state.pending_fills) == 0
        assert state.total_fills_processed == 0

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        state = FillReconciliationState(
            session_id="session-1",
            processed_fill_ids={"F001", "F002"},
            total_fills_processed=2,
        )

        d = state.to_dict()

        assert d["sessionId"] == "session-1"
        assert "F001" in d["processedFillIds"]
        assert d["totalFillsProcessed"] == 2

    def test_from_dict(self) -> None:
        """Test creation from dictionary."""
        data = {
            "sessionId": "session-1",
            "processedFillIds": ["F001", "F002"],
            "totalFillsProcessed": 2,
            "totalDuplicatesRejected": 1,
            "pendingFills": [],
        }

        state = FillReconciliationState.from_dict(data)

        assert state.session_id == "session-1"
        assert "F001" in state.processed_fill_ids
        assert state.total_fills_processed == 2

    def test_from_dict_with_timestamp(self) -> None:
        """Test from_dict with last fill timestamp."""
        data = {
            "sessionId": "session-1",
            "processedFillIds": [],
            "lastFillTimestamp": "2024-01-15T10:30:00",
            "pendingFills": [],
        }

        state = FillReconciliationState.from_dict(data)

        assert state.last_fill_timestamp is not None
        assert state.last_fill_timestamp.year == 2024


class TestFillReconciler:
    """Tests for FillReconciler class."""

    @pytest.fixture
    def position_tracker(self):
        """Create mock position tracker."""
        tracker = MagicMock(spec=PositionTracker)
        mock_position = MagicMock()
        mock_position.quantity = Decimal("0")
        tracker.get_or_create_position.return_value = mock_position
        return tracker

    @pytest.fixture
    def reconciler(self, position_tracker, tmp_path):
        """Create reconciler with temp directory."""
        return FillReconciler(
            session_id="test-session",
            position_tracker=position_tracker,
            state_dir=tmp_path,
        )

    @pytest.fixture
    def sample_fill(self):
        """Create a sample fill."""
        return Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
        )

    def test_init(self, reconciler) -> None:
        """Test reconciler initialization."""
        assert reconciler.total_processed == 0
        assert reconciler.total_duplicates == 0

    def test_process_fill_success(self, reconciler, sample_fill) -> None:
        """Test successful fill processing."""
        result = reconciler.process_fill(sample_fill)

        assert result.status == FillStatus.APPLIED
        assert result.position_updated is True
        assert reconciler.total_processed == 1

    def test_process_fill_duplicate(self, reconciler, sample_fill) -> None:
        """Test duplicate fill detection."""
        # Process once
        reconciler.process_fill(sample_fill)

        # Process again - should be duplicate
        result = reconciler.process_fill(sample_fill)

        assert result.status == FillStatus.DUPLICATE
        assert reconciler.total_duplicates == 1

    def test_process_fill_validation_missing_fill_id(
        self, reconciler
    ) -> None:
        """Test fill rejected with missing fill_id."""
        fill = Fill(
            fill_id="",  # Empty
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
        )

        result = reconciler.process_fill(fill)

        assert result.status == FillStatus.REJECTED
        assert "fill id" in result.message.lower()

    def test_process_fill_validation_invalid_side(self, reconciler) -> None:
        """Test fill rejected with invalid side."""
        fill = Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="invalid",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
        )

        result = reconciler.process_fill(fill)

        assert result.status == FillStatus.REJECTED
        assert "side" in result.message.lower()

    def test_process_fill_validation_zero_quantity(self, reconciler) -> None:
        """Test fill rejected with zero quantity."""
        fill = Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("0"),
            price=Decimal("150.00"),
        )

        result = reconciler.process_fill(fill)

        assert result.status == FillStatus.REJECTED
        assert "quantity" in result.message.lower()

    def test_process_fill_validation_zero_price(self, reconciler) -> None:
        """Test fill rejected with zero price."""
        fill = Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("0"),
        )

        result = reconciler.process_fill(fill)

        assert result.status == FillStatus.REJECTED
        assert "price" in result.message.lower()

    def test_process_fills_batch(self, reconciler) -> None:
        """Test batch fill processing."""
        fills = [
            Fill(
                fill_id=f"F00{i}",
                broker_order_id=f"B00{i}",
                client_order_id=f"C00{i}",
                symbol="AAPL",
                side="buy",
                quantity=Decimal("100"),
                price=Decimal("150.00"),
            )
            for i in range(3)
        ]

        results = reconciler.process_fills_batch(fills)

        assert len(results) == 3
        assert all(r.status == FillStatus.APPLIED for r in results)

    def test_is_fill_processed(self, reconciler, sample_fill) -> None:
        """Test is_fill_processed check."""
        assert reconciler.is_fill_processed(sample_fill.fill_id) is False

        reconciler.process_fill(sample_fill)

        assert reconciler.is_fill_processed(sample_fill.fill_id) is True

    def test_get_last_fill_timestamp(self, reconciler, sample_fill) -> None:
        """Test get_last_fill_timestamp."""
        assert reconciler.get_last_fill_timestamp() is None

        reconciler.process_fill(sample_fill)

        assert reconciler.get_last_fill_timestamp() is not None

    def test_on_fill_applied_callback(self, position_tracker, tmp_path) -> None:
        """Test on_fill_applied callback is called."""
        callback = MagicMock()
        reconciler = FillReconciler(
            session_id="test-session",
            position_tracker=position_tracker,
            state_dir=tmp_path,
            on_fill_applied=callback,
        )

        fill = Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
        )

        reconciler.process_fill(fill)

        callback.assert_called_once_with(fill)

    def test_add_pending_fill(self, reconciler, sample_fill) -> None:
        """Test adding pending fill."""
        reconciler.add_pending_fill(sample_fill)

        state = reconciler.get_state()
        assert len(state.pending_fills) == 1

    def test_process_pending_fills(self, reconciler, sample_fill) -> None:
        """Test processing pending fills."""
        reconciler.add_pending_fill(sample_fill)

        results = reconciler.process_pending_fills()

        assert len(results) == 1
        assert results[0].status == FillStatus.APPLIED

        # Pending queue should be empty
        state = reconciler.get_state()
        assert len(state.pending_fills) == 0

    def test_reset(self, reconciler, sample_fill) -> None:
        """Test state reset."""
        reconciler.process_fill(sample_fill)
        assert reconciler.total_processed == 1

        reconciler.reset()

        assert reconciler.total_processed == 0
        assert reconciler.total_duplicates == 0


class TestFillReconcilerReconciliation:
    """Tests for fill reconciliation after reconnect."""

    @pytest.fixture
    def position_tracker(self):
        """Create mock position tracker."""
        tracker = MagicMock(spec=PositionTracker)
        mock_position = MagicMock()
        mock_position.quantity = Decimal("0")
        tracker.get_or_create_position.return_value = mock_position
        return tracker

    @pytest.fixture
    def reconciler(self, position_tracker, tmp_path):
        """Create reconciler with temp directory."""
        return FillReconciler(
            session_id="test-session",
            position_tracker=position_tracker,
            state_dir=tmp_path,
        )

    def test_reconcile_after_reconnect(self, reconciler) -> None:
        """Test reconciliation after reconnect."""
        # Process one fill
        fill1 = Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
            timestamp=datetime(2024, 1, 15, 10, 0, 0),
        )
        reconciler.process_fill(fill1)

        # Simulate reconnect with broker fills
        broker_fills = [
            Fill(
                fill_id="F001",  # Already processed
                broker_order_id="B001",
                client_order_id="C001",
                symbol="AAPL",
                side="buy",
                quantity=Decimal("100"),
                price=Decimal("150.00"),
                timestamp=datetime(2024, 1, 15, 10, 0, 0),
            ),
            Fill(
                fill_id="F002",  # New fill
                broker_order_id="B002",
                client_order_id="C002",
                symbol="AAPL",
                side="buy",
                quantity=Decimal("50"),
                price=Decimal("151.00"),
                timestamp=datetime(2024, 1, 15, 11, 0, 0),
            ),
        ]

        results = reconciler.reconcile_after_reconnect(broker_fills)

        # Should only process the new fill
        assert len(results) == 1
        assert results[0].fill_id == "F002"


class TestFillAggregator:
    """Tests for FillAggregator class."""

    @pytest.fixture
    def aggregator(self):
        """Create fill aggregator."""
        return FillAggregator()

    @pytest.fixture
    def sample_fills(self):
        """Create sample fills for same order."""
        return [
            Fill(
                fill_id="F001",
                broker_order_id="B001",
                client_order_id="C001",
                symbol="AAPL",
                side="buy",
                quantity=Decimal("50"),
                price=Decimal("150.00"),
                commission=Decimal("0.50"),
            ),
            Fill(
                fill_id="F002",
                broker_order_id="B001",
                client_order_id="C001",
                symbol="AAPL",
                side="buy",
                quantity=Decimal("50"),
                price=Decimal("151.00"),
                commission=Decimal("0.50"),
            ),
        ]

    def test_init(self, aggregator) -> None:
        """Test aggregator initialization."""
        assert aggregator.get_order_fills("nonexistent") == []

    def test_add_fill(self, aggregator, sample_fills) -> None:
        """Test adding fills."""
        for fill in sample_fills:
            aggregator.add_fill(fill)

        fills = aggregator.get_order_fills("C001")
        assert len(fills) == 2

    def test_get_filled_quantity(self, aggregator, sample_fills) -> None:
        """Test getting total filled quantity."""
        for fill in sample_fills:
            aggregator.add_fill(fill)

        qty = aggregator.get_filled_quantity("C001")
        assert qty == Decimal("100")

    def test_get_filled_quantity_no_fills(self, aggregator) -> None:
        """Test getting filled quantity with no fills."""
        qty = aggregator.get_filled_quantity("C001")
        assert qty == Decimal("0")

    def test_get_average_fill_price(self, aggregator, sample_fills) -> None:
        """Test getting VWAP."""
        for fill in sample_fills:
            aggregator.add_fill(fill)

        # (50*150 + 50*151) / 100 = 150.50
        avg = aggregator.get_average_fill_price("C001")
        assert avg == Decimal("150.50")

    def test_get_average_fill_price_no_fills(self, aggregator) -> None:
        """Test VWAP with no fills."""
        avg = aggregator.get_average_fill_price("C001")
        assert avg is None

    def test_get_total_commission(self, aggregator, sample_fills) -> None:
        """Test getting total commission."""
        for fill in sample_fills:
            aggregator.add_fill(fill)

        commission = aggregator.get_total_commission("C001")
        assert commission == Decimal("1.00")

    def test_is_order_complete(self, aggregator, sample_fills) -> None:
        """Test order completion check."""
        for fill in sample_fills:
            aggregator.add_fill(fill)

        assert aggregator.is_order_complete("C001", Decimal("100")) is True
        assert aggregator.is_order_complete("C001", Decimal("150")) is False

    def test_clear_order(self, aggregator, sample_fills) -> None:
        """Test clearing order fills."""
        for fill in sample_fills:
            aggregator.add_fill(fill)

        aggregator.clear_order("C001")

        assert aggregator.get_order_fills("C001") == []

    def test_clear_all(self, aggregator, sample_fills) -> None:
        """Test clearing all fills."""
        for fill in sample_fills:
            aggregator.add_fill(fill)

        aggregator.clear_all()

        assert aggregator.get_order_fills("C001") == []

    def test_uses_client_order_id(self, aggregator) -> None:
        """Test that client_order_id is preferred."""
        fill = Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="C001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
        )
        aggregator.add_fill(fill)

        # Should be findable by client_order_id
        fills = aggregator.get_order_fills("C001")
        assert len(fills) == 1

    def test_uses_broker_order_id_if_no_client(self, aggregator) -> None:
        """Test fallback to broker_order_id."""
        fill = Fill(
            fill_id="F001",
            broker_order_id="B001",
            client_order_id="",  # Empty
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("150.00"),
        )
        aggregator.add_fill(fill)

        # Should be findable by broker_order_id
        fills = aggregator.get_order_fills("B001")
        assert len(fills) == 1

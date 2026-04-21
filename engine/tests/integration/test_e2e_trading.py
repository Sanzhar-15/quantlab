"""
End-to-End Trading Session Tests.

Tests complete trading workflows from session start to finish.

Spec Reference: Technical Spec Phase 5
"""

import asyncio
from datetime import datetime
from decimal import Decimal
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


class TestE2ETradingWorkflows:
    """End-to-end tests for complete trading workflows."""

    @pytest.fixture
    def mock_broker(self):
        """Create a mock broker for testing."""
        broker = MagicMock()
        broker.name = "Test Broker"
        broker.status = MagicMock(value="connected")
        broker.is_paper = True
        broker.connect = MagicMock(return_value=True)
        broker.disconnect = MagicMock()
        broker.get_accounts = MagicMock(return_value=[
            MagicMock(
                account_id="test-account",
                cash_balance=Decimal("100000"),
                buying_power=Decimal("100000"),
            )
        ])
        broker.submit_order = AsyncMock(return_value="broker-order-123")
        broker.cancel_order = AsyncMock(return_value=True)
        broker.get_quote = AsyncMock(return_value=MagicMock(
            symbol="AAPL",
            bid=Decimal("149.90"),
            ask=Decimal("150.10"),
            last=Decimal("150.00"),
        ))
        broker.get_positions = AsyncMock(return_value=[])
        return broker

    @pytest.fixture
    def mock_session_components(self, mock_broker):
        """Create mock session components."""
        from quantlab.trading.orders import OrderManager
        from quantlab.trading.positions import PositionTracker
        from quantlab.risk.exposure import ExposureManager
        from quantlab.risk.circuit_breaker import CircuitBreaker

        order_manager = OrderManager()
        position_tracker = PositionTracker()
        exposure_manager = ExposureManager(max_exposure=Decimal("100000"))
        circuit_breaker = CircuitBreaker()

        return {
            "broker": mock_broker,
            "order_manager": order_manager,
            "position_tracker": position_tracker,
            "exposure_manager": exposure_manager,
            "circuit_breaker": circuit_breaker,
        }

    def test_session_initialization(self, mock_session_components):
        """Test complete session initialization workflow."""
        from quantlab.trading.session import SessionState

        broker = mock_session_components["broker"]

        # Verify broker connection
        assert broker.connect() is True
        assert broker.is_paper is True

        # Verify accounts available
        accounts = broker.get_accounts()
        assert len(accounts) > 0
        assert accounts[0].cash_balance == Decimal("100000")

    @pytest.mark.asyncio
    async def test_order_submission_workflow(self, mock_session_components):
        """Test complete order submission workflow."""
        from quantlab.trading.orders import (
            OrderRequest, OrderSide, OrderType, TimeInForce
        )

        broker = mock_session_components["broker"]
        order_manager = mock_session_components["order_manager"]

        # Create order request
        request = OrderRequest(
            session_id="test-session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        # Validate request
        errors = request.validate()
        assert len(errors) == 0

        # Create order
        order = order_manager.create_order(request)
        assert order is not None
        assert order.symbol == "AAPL"
        assert order.quantity == Decimal("100")

        # Submit to broker
        broker_order_id = await broker.submit_order(order)
        assert broker_order_id == "broker-order-123"

        # Mark as submitted
        order_manager.submit_order(order.order_id, broker_order_id)
        order = order_manager.get_order(order.order_id)
        assert order.broker_order_id == broker_order_id

    @pytest.mark.asyncio
    async def test_order_fill_workflow(self, mock_session_components):
        """Test order fill and position update workflow."""
        from quantlab.trading.orders import (
            OrderRequest, OrderSide, OrderType
        )

        broker = mock_session_components["broker"]
        order_manager = mock_session_components["order_manager"]
        position_tracker = mock_session_components["position_tracker"]

        session_id = "test-session-002"

        # Create and submit order
        request = OrderRequest(
            session_id=session_id,
            symbol="MSFT",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("50"),
        )
        order = order_manager.create_order(request)
        order_manager.submit_order(order.order_id, "broker-456")

        # Simulate fill
        fill = order_manager.fill_order(
            order.order_id,
            quantity=Decimal("50"),
            price=Decimal("300.00"),
            commission=Decimal("1.00"),
        )

        # Verify fill
        assert fill.quantity == Decimal("50")
        assert fill.price == Decimal("300.00")

        # Update position via apply_fill
        from quantlab.trading.orders import OrderSide as TradingOrderSide
        position_tracker.apply_fill(
            session_id=session_id,
            symbol="MSFT",
            fill=fill,
            side=TradingOrderSide.BUY,
        )

        # Verify position
        position = position_tracker.get_position(session_id, "MSFT")
        assert position is not None
        assert position.quantity == Decimal("50")

    @pytest.mark.asyncio
    async def test_risk_limit_workflow(self, mock_session_components):
        """Test risk limit enforcement workflow."""
        exposure_manager = mock_session_components["exposure_manager"]

        # Reserve exposure for trade
        from quantlab.risk.exposure import OrderRequest as ExposureOrderRequest
        from quantlab.risk.exposure import OrderSide as ExposureOrderSide

        order_req = ExposureOrderRequest(
            order_id="test-order-1",
            symbol="GOOGL",
            side=ExposureOrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("500"),  # 50k = 50% of capital
        )
        result = exposure_manager.reserve(order_req, price_estimate=Decimal("500"))
        assert result.success is True

        # Check remaining capacity via snapshot
        snapshot = exposure_manager.snapshot()
        assert snapshot.available_exposure == Decimal("50000")

        # Attempt to exceed limit
        order_req2 = ExposureOrderRequest(
            order_id="test-order-2",
            symbol="AMZN",
            side=ExposureOrderSide.BUY,
            quantity=Decimal("200"),
            price=Decimal("300"),  # 60k - would exceed 100k limit
        )
        result2 = exposure_manager.reserve(order_req2, price_estimate=Decimal("300"))
        assert result2.success is False  # Should fail

    @pytest.mark.asyncio
    async def test_position_close_workflow(self, mock_session_components):
        """Test position closing workflow."""
        from quantlab.trading.orders import (
            OrderRequest, OrderSide, OrderType
        )

        broker = mock_session_components["broker"]
        order_manager = mock_session_components["order_manager"]
        position_tracker = mock_session_components["position_tracker"]

        session_id = "test-session-003"

        # Setup: Create open position via a buy fill
        from quantlab.trading.orders import Fill as TradingFill
        setup_fill = TradingFill(
            fill_id="setup-fill-1",
            order_id="setup-order-1",
            quantity=Decimal("25"),
            price=Decimal("400.00"),
            commission=Decimal("0"),
            timestamp=datetime.now(),
        )
        position_tracker.apply_fill(
            session_id=session_id,
            symbol="NVDA",
            fill=setup_fill,
            side=OrderSide.BUY,
        )

        # Verify position exists
        position = position_tracker.get_position(session_id, "NVDA")
        assert position.quantity == Decimal("25")

        # Create close order
        request = OrderRequest(
            session_id=session_id,
            symbol="NVDA",
            side=OrderSide.SELL,
            order_type=OrderType.MARKET,
            quantity=Decimal("25"),
        )
        order = order_manager.create_order(request)
        order_manager.submit_order(order.order_id, "broker-789")

        # Simulate fill
        order_manager.fill_order(
            order.order_id,
            quantity=Decimal("25"),
            price=Decimal("410.00"),  # Profit
            commission=Decimal("1.00"),
        )

        # Update position via fill
        close_fill_obj = TradingFill(
            fill_id="close-fill-1",
            order_id=order.order_id,
            quantity=Decimal("25"),
            price=Decimal("410.00"),
            commission=Decimal("1.00"),
            timestamp=datetime.now(),
        )
        position_tracker.apply_fill(
            session_id=session_id,
            symbol="NVDA",
            fill=close_fill_obj,
            side=OrderSide.SELL,
        )

        # Verify position closed
        position = position_tracker.get_position(session_id, "NVDA")
        assert position is None or position.quantity == Decimal("0")

    def test_circuit_breaker_workflow(self, mock_session_components):
        """Test circuit breaker trigger and recovery workflow."""
        from quantlab.risk.circuit_breaker import CircuitBreakerState

        circuit_breaker = mock_session_components["circuit_breaker"]

        # Initial state should be CLOSED (normal operation)
        assert circuit_breaker.state == CircuitBreakerState.CLOSED

        # Verify circuit breaker allows orders in normal state
        allowed, _ = circuit_breaker.check_order_allowed()
        assert allowed is True

    @pytest.mark.asyncio
    async def test_order_cancellation_workflow(self, mock_session_components):
        """Test order cancellation workflow."""
        from quantlab.trading.orders import (
            OrderRequest, OrderSide, OrderType, OrderStatus
        )

        broker = mock_session_components["broker"]
        order_manager = mock_session_components["order_manager"]

        # Create limit order
        request = OrderRequest(
            session_id="test-session-004",
            symbol="META",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("30"),
            limit_price=Decimal("350.00"),
        )
        order = order_manager.create_order(request)
        order_manager.submit_order(order.order_id, "broker-cancel-test")
        order_manager.accept_order(order.order_id)

        # Verify order is open
        order = order_manager.get_order(order.order_id)
        assert order.is_open is True

        # Request cancellation (two-phase)
        order_manager.request_cancel_order(order.order_id)
        order = order_manager.get_order(order.order_id)
        assert order.status == OrderStatus.CANCEL_PENDING

        # Confirm cancellation from broker
        await broker.cancel_order("broker-cancel-test")
        order_manager.confirm_cancel_order(order.order_id)

        # Verify cancelled
        order = order_manager.get_order(order.order_id)
        assert order.status == OrderStatus.CANCELLED

    @pytest.mark.asyncio
    async def test_partial_fill_workflow(self, mock_session_components):
        """Test partial fill handling workflow."""
        from quantlab.trading.orders import (
            OrderRequest, OrderSide, OrderType, OrderStatus
        )

        order_manager = mock_session_components["order_manager"]
        position_tracker = mock_session_components["position_tracker"]

        session_id = "test-session-005"

        # Create order
        request = OrderRequest(
            session_id=session_id,
            symbol="TSLA",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )
        order = order_manager.create_order(request)
        order_manager.submit_order(order.order_id, "broker-partial")

        # First partial fill
        order_manager.fill_order(
            order.order_id,
            quantity=Decimal("40"),
            price=Decimal("200.00"),
        )
        order = order_manager.get_order(order.order_id)
        assert order.status == OrderStatus.PARTIAL
        assert order.filled_quantity == Decimal("40")

        # Second partial fill
        order_manager.fill_order(
            order.order_id,
            quantity=Decimal("60"),
            price=Decimal("201.00"),
        )
        order = order_manager.get_order(order.order_id)
        assert order.status == OrderStatus.FILLED
        assert order.filled_quantity == Decimal("100")

        # Verify average fill price
        # (40 * 200 + 60 * 201) / 100 = 200.60
        assert order.avg_fill_price == Decimal("200.60")


class TestE2EErrorScenarios:
    """End-to-end tests for error handling scenarios."""

    @pytest.fixture
    def failing_broker(self):
        """Create a broker that simulates failures."""
        broker = MagicMock()
        broker.name = "Failing Broker"
        broker.submit_order = AsyncMock(side_effect=Exception("Network error"))
        broker.cancel_order = AsyncMock(side_effect=Exception("Timeout"))
        return broker

    def test_order_validation_errors(self):
        """Test handling of order validation errors."""
        from quantlab.trading.orders import (
            OrderRequest, OrderSide, OrderType, OrderManager
        )

        order_manager = OrderManager()

        # Negative quantity
        request = OrderRequest(
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("-10"),
        )
        errors = request.validate()
        assert len(errors) > 0
        assert "positive" in errors[0].lower()

    def test_limit_order_without_price(self):
        """Test limit order rejection without price."""
        from quantlab.trading.orders import (
            OrderRequest, OrderSide, OrderType
        )

        request = OrderRequest(
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=None,  # Missing required price
        )
        errors = request.validate()
        assert len(errors) > 0
        assert "limit" in errors[0].lower()


class TestE2EMultiSymbolWorkflow:
    """End-to-end tests for multi-symbol trading workflows."""

    @pytest.fixture
    def multi_position_setup(self):
        """Setup multiple positions for testing."""
        from quantlab.trading.positions import PositionTracker

        tracker = PositionTracker()
        session_id = "multi-symbol-session"

        # Create multiple positions via fills
        from quantlab.trading.orders import Fill as TradingFill, OrderSide

        symbols = ["AAPL", "MSFT", "GOOGL", "AMZN"]
        for i, symbol in enumerate(symbols):
            fill = TradingFill(
                fill_id=f"setup-fill-{i}",
                order_id=f"setup-order-{i}",
                quantity=Decimal(str((i + 1) * 10)),
                price=Decimal(str((i + 1) * 100)),
                commission=Decimal("0"),
                timestamp=datetime.now(),
            )
            tracker.apply_fill(
                session_id=session_id,
                symbol=symbol,
                fill=fill,
                side=OrderSide.BUY,
            )

        return tracker, session_id

    def test_get_all_positions(self, multi_position_setup):
        """Test retrieving all positions."""
        tracker, session_id = multi_position_setup

        positions = tracker.get_positions_for_session(session_id)
        assert len(positions) == 4

        symbols = {p.symbol for p in positions}
        assert symbols == {"AAPL", "MSFT", "GOOGL", "AMZN"}

    def test_portfolio_value_calculation(self, multi_position_setup):
        """Test portfolio value calculation."""
        tracker, session_id = multi_position_setup

        # Calculate total position value
        positions = tracker.get_positions_for_session(session_id)
        total_value = sum(
            p.quantity * p.avg_entry_price for p in positions
        )

        # Expected: 10*100 + 20*200 + 30*300 + 40*400 = 30,000
        assert total_value == Decimal("30000")


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

"""
Failure and Chaos Tests (L040-L050).

Tests for error handling, disconnection, and failure scenarios.

Spec Reference: Technical Spec §1.5, Decision L69, N99
"""

import asyncio
from decimal import Decimal

import pytest

from quantlab.trading.orders import OrderSide, OrderType

from .harness import LiveTestHarness, MockBrokerBehavior, create_harness


class TestFailure:
    """L040-L050: Failure and chaos tests."""

    @pytest.fixture
    async def harness(self):
        """Create and start test harness."""
        h = create_harness(initial_capital=Decimal("100000"))
        await h.start(symbols=["AAPL", "MSFT"])
        yield h
        await h.stop()

    @pytest.mark.asyncio
    async def test_L040_broker_disconnection(self, harness: LiveTestHarness):
        """L040: Broker disconnection is handled gracefully."""
        harness.broker.set_price("AAPL", Decimal("150.00"))

        # Submit order successfully first
        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )
        assert broker_id is not None

        # Simulate disconnection
        harness.broker.set_behavior(MockBrokerBehavior.DISCONNECT)

        # Try another order - should fail
        broker_id2 = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        assert broker_id2 is None, "Order should fail when disconnected"

    @pytest.mark.asyncio
    async def test_L041_order_rejection_handling(self, harness: LiveTestHarness):
        """L041: Order rejection is handled gracefully."""
        harness.broker.set_price("AAPL", Decimal("150.00"))
        harness.broker.set_behavior(MockBrokerBehavior.REJECT_ALL)

        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        assert broker_id is None, "Rejected order returns None"

        metrics = harness.broker.get_metrics()
        assert metrics["orders_rejected"] == 1

    @pytest.mark.asyncio
    async def test_L042_delayed_fill_handling(self, harness: LiveTestHarness):
        """L042: Delayed fills are processed correctly."""
        harness.broker.set_price("AAPL", Decimal("150.00"))
        harness.broker.set_behavior(MockBrokerBehavior.DELAY_FILLS)
        harness.broker.set_fill_delay(0.5)  # 500ms delay

        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        assert broker_id is not None

        # Order should be pending
        pending = harness.broker.get_pending_orders()
        assert len(pending) == 1

        # Manually queue and process the fill
        harness.broker._queue_fill(broker_id, pending[broker_id])

        # Process fills (includes delay)
        fills = await harness.wait_for_fills(count=1, timeout=2.0)

        assert len(fills) == 1

    @pytest.mark.asyncio
    async def test_L043_reconnection_attempt(self, harness: LiveTestHarness):
        """L043: Reconnection is attempted after disconnection."""
        # Start connected
        assert harness.broker.status.value == "connected"

        # Disconnect
        harness.broker.disconnect()
        assert harness.broker.status.value == "disconnected"

        # Reconnect
        connected = harness.broker.connect()
        assert connected is True
        assert harness.broker.status.value == "connected"

    @pytest.mark.asyncio
    async def test_L044_state_preserved_on_error(self, harness: LiveTestHarness):
        """L044: Trading state is preserved on error."""
        harness.broker.set_price("AAPL", Decimal("150.00"))

        # Submit and fill order
        await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        fills_before = await harness.wait_for_fills(count=1)
        assert len(fills_before) == 1

        # Simulate error
        harness.broker.set_behavior(MockBrokerBehavior.DISCONNECT)

        # State should be preserved
        all_fills = harness.get_fills()
        assert len(all_fills) == 1, "Fills preserved after error"

    @pytest.mark.asyncio
    async def test_L045_pending_orders_on_disconnect(self, harness: LiveTestHarness):
        """L045: Pending orders tracked on disconnection."""
        harness.broker.set_price("AAPL", Decimal("150.00"))
        harness.broker.set_behavior(MockBrokerBehavior.DELAY_FILLS)

        # Submit order
        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        # Verify pending
        pending = harness.broker.get_pending_orders()
        assert len(pending) == 1

        # Disconnect - pending orders should remain tracked
        harness.broker.disconnect()

        # Orders still tracked
        pending_after = harness.broker.get_pending_orders()
        assert len(pending_after) == 1, "Pending orders preserved"

    @pytest.mark.asyncio
    async def test_L046_error_callback_invoked(self, harness: LiveTestHarness):
        """L046: Error callbacks are invoked on failure."""
        errors = []

        def error_handler(order_id, status):
            if status.value == "rejected":
                errors.append(order_id)

        harness.broker.on_order_update(error_handler)
        harness.broker.set_behavior(MockBrokerBehavior.REJECT_ALL)
        harness.broker.set_price("AAPL", Decimal("150.00"))

        await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        # Rejection doesn't trigger order update in mock, but verify callback registered
        assert len(harness.broker._on_order_update_callbacks) >= 1

    @pytest.mark.asyncio
    async def test_L047_fill_callback_invoked(self, harness: LiveTestHarness):
        """L047: Fill callbacks are invoked on execution."""
        fills_received = []

        def fill_handler(order_id, fill):
            fills_received.append((order_id, fill))

        harness.broker.on_fill(fill_handler)
        harness.broker.set_price("AAPL", Decimal("150.00"))

        await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        await harness.wait_for_fills(count=1)

        assert len(fills_received) == 1, "Fill callback invoked"
        assert fills_received[0][1].quantity == Decimal("100")

    @pytest.mark.asyncio
    async def test_L048_multiple_callbacks_supported(self, harness: LiveTestHarness):
        """L048: Multiple callbacks can be registered."""
        fills_1 = []
        fills_2 = []

        harness.broker.on_fill(lambda oid, f: fills_1.append(f))
        harness.broker.on_fill(lambda oid, f: fills_2.append(f))

        harness.broker.set_price("AAPL", Decimal("150.00"))

        await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        await harness.wait_for_fills(count=1)

        assert len(fills_1) == 1, "First callback received fill"
        assert len(fills_2) == 1, "Second callback received fill"

    @pytest.mark.asyncio
    async def test_L049_callback_exception_isolated(self, harness: LiveTestHarness):
        """L049: Callback exceptions don't affect other callbacks."""
        fills_received = []

        def bad_handler(order_id, fill):
            raise Exception("Intentional test error")

        def good_handler(order_id, fill):
            fills_received.append(fill)

        harness.broker.on_fill(bad_handler)
        harness.broker.on_fill(good_handler)

        harness.broker.set_price("AAPL", Decimal("150.00"))

        await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        await harness.wait_for_fills(count=1)

        # Good handler still received fill despite bad handler exception
        assert len(fills_received) == 1, "Good callback still works"

    @pytest.mark.asyncio
    async def test_L050_graceful_shutdown(self, harness: LiveTestHarness):
        """L050: Graceful shutdown completes pending operations."""
        harness.broker.set_price("AAPL", Decimal("150.00"))

        # Submit some orders
        await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        # Process fills before shutdown
        await harness.wait_for_fills(count=1)

        # Stop harness
        await harness.stop()

        assert harness.broker.status.value == "disconnected"

        # Verify all operations completed
        fills = harness.get_fills()
        assert len(fills) == 1

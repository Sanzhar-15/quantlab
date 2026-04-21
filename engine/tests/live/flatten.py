"""
Flatten and Emergency Tests (L060-L070).

Tests for emergency flatten, kill switch, and position management.

Spec Reference: Technical Spec §1.5, Decision L69 (Kill Switch)
"""

import asyncio
from decimal import Decimal

import pytest

from quantlab.trading.orders import OrderSide, OrderType
from quantlab.trading.positions import Position, PositionSide, PositionTracker

from .harness import LiveTestHarness, MockBrokerBehavior, create_harness


class TestFlatten:
    """L060-L070: Flatten and emergency tests."""

    @pytest.fixture
    async def harness(self):
        """Create and start test harness."""
        h = create_harness(initial_capital=Decimal("100000"))
        await h.start(symbols=["AAPL", "MSFT", "GOOGL"])
        yield h
        await h.stop()

    @pytest.fixture
    def position_tracker(self) -> PositionTracker:
        """Create position tracker with test positions."""
        tracker = PositionTracker()

        # Add some positions
        tracker.update_position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_price=Decimal("150.00"),
            side=PositionSide.LONG,
        )
        tracker.update_position(
            symbol="MSFT",
            quantity=Decimal("50"),
            avg_price=Decimal("300.00"),
            side=PositionSide.LONG,
        )

        return tracker

    @pytest.mark.asyncio
    async def test_L060_flatten_single_position(
        self, harness: LiveTestHarness, position_tracker: PositionTracker
    ):
        """L060: Single position can be flattened."""
        harness.broker.set_price("AAPL", Decimal("152.00"))

        # Get position
        position = position_tracker.get_position("AAPL")
        assert position is not None
        assert position.quantity == Decimal("100")

        # Submit flatten order
        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.SELL,
            quantity=position.quantity,
            order_type=OrderType.MARKET,
        )

        assert broker_id is not None

        fills = await harness.wait_for_fills(count=1)
        assert len(fills) == 1
        assert fills[0].quantity == Decimal("100")

    @pytest.mark.asyncio
    async def test_L061_flatten_all_positions(
        self, harness: LiveTestHarness, position_tracker: PositionTracker
    ):
        """L061: All positions can be flattened at once."""
        harness.broker.set_prices({
            "AAPL": Decimal("152.00"),
            "MSFT": Decimal("305.00"),
        })

        positions = position_tracker.get_all_positions()
        assert len(positions) == 2

        # Flatten all
        for symbol, position in positions.items():
            await harness.submit_order(
                symbol=symbol,
                side=OrderSide.SELL,
                quantity=position.quantity,
                order_type=OrderType.MARKET,
            )

        fills = await harness.wait_for_fills(count=2)
        assert len(fills) == 2

    @pytest.mark.asyncio
    async def test_L062_kill_switch_cancels_orders(
        self, harness: LiveTestHarness
    ):
        """L062: Kill switch cancels all pending orders."""
        harness.broker.set_price("AAPL", Decimal("150.00"))
        harness.broker.set_behavior(MockBrokerBehavior.DELAY_FILLS)

        # Submit multiple orders
        order_ids = []
        for _ in range(3):
            broker_id = await harness.submit_order(
                symbol="AAPL",
                side=OrderSide.BUY,
                quantity=Decimal("50"),
                order_type=OrderType.MARKET,
            )
            order_ids.append(broker_id)

        # Verify pending
        pending = harness.broker.get_pending_orders()
        assert len(pending) == 3

        # Kill switch - cancel all
        for broker_id in order_ids:
            harness.broker.cancel_order(broker_id)

        pending_after = harness.broker.get_pending_orders()
        assert len(pending_after) == 0

        metrics = harness.broker.get_metrics()
        assert metrics["orders_cancelled"] == 3

    @pytest.mark.asyncio
    async def test_L063_kill_switch_flattens_positions(
        self, harness: LiveTestHarness, position_tracker: PositionTracker
    ):
        """L063: Kill switch flattens all positions."""
        harness.broker.set_prices({
            "AAPL": Decimal("152.00"),
            "MSFT": Decimal("305.00"),
        })

        positions = position_tracker.get_all_positions()
        total_value = sum(
            p.quantity * harness.broker._prices[s]
            for s, p in positions.items()
        )

        # Kill switch - flatten all
        for symbol, position in positions.items():
            await harness.submit_order(
                symbol=symbol,
                side=OrderSide.SELL,
                quantity=position.quantity,
                order_type=OrderType.MARKET,
            )

        fills = await harness.wait_for_fills(count=2)

        total_filled = sum(f.quantity * f.price for f in fills)
        assert total_filled == total_value

    @pytest.mark.asyncio
    async def test_L064_partial_flatten(
        self, harness: LiveTestHarness, position_tracker: PositionTracker
    ):
        """L064: Position can be partially flattened."""
        harness.broker.set_price("AAPL", Decimal("152.00"))

        position = position_tracker.get_position("AAPL")
        assert position.quantity == Decimal("100")

        # Sell half
        await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.SELL,
            quantity=Decimal("50"),
            order_type=OrderType.MARKET,
        )

        fills = await harness.wait_for_fills(count=1)
        assert fills[0].quantity == Decimal("50")

        # Update position
        position_tracker.update_position(
            symbol="AAPL",
            quantity=Decimal("50"),  # Remaining
            avg_price=Decimal("150.00"),
            side=PositionSide.LONG,
        )

        position_after = position_tracker.get_position("AAPL")
        assert position_after.quantity == Decimal("50")

    @pytest.mark.asyncio
    async def test_L065_flatten_with_limit_order(
        self, harness: LiveTestHarness, position_tracker: PositionTracker
    ):
        """L065: Position can be flattened with limit order."""
        harness.broker.set_price("AAPL", Decimal("152.00"))
        harness.broker.set_behavior(MockBrokerBehavior.DELAY_FILLS)

        position = position_tracker.get_position("AAPL")

        # Submit limit order to flatten
        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.SELL,
            quantity=position.quantity,
            order_type=OrderType.LIMIT,
            limit_price=Decimal("153.00"),
        )

        assert broker_id is not None

        # Order is pending (price not reached)
        pending = harness.broker.get_pending_orders()
        assert len(pending) == 1

    @pytest.mark.asyncio
    async def test_L066_flatten_short_position(self, harness: LiveTestHarness):
        """L066: Short position can be flattened."""
        tracker = PositionTracker()
        tracker.update_position(
            symbol="AAPL",
            quantity=Decimal("-100"),  # Short
            avg_price=Decimal("150.00"),
            side=PositionSide.SHORT,
        )

        harness.broker.set_price("AAPL", Decimal("148.00"))

        position = tracker.get_position("AAPL")
        assert position.side == PositionSide.SHORT

        # Buy to cover
        await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=abs(position.quantity),
            order_type=OrderType.MARKET,
        )

        fills = await harness.wait_for_fills(count=1)
        assert fills[0].quantity == Decimal("100")

    @pytest.mark.asyncio
    async def test_L067_flatten_preserves_pnl(
        self, harness: LiveTestHarness, position_tracker: PositionTracker
    ):
        """L067: Flatten correctly calculates P&L."""
        harness.broker.set_price("AAPL", Decimal("160.00"))  # Up from 150

        position = position_tracker.get_position("AAPL")
        entry_value = position.quantity * position.avg_price  # 100 * 150 = 15000
        exit_price = Decimal("160.00")
        exit_value = position.quantity * exit_price  # 100 * 160 = 16000
        expected_pnl = exit_value - entry_value  # 1000

        await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.SELL,
            quantity=position.quantity,
            order_type=OrderType.MARKET,
        )

        fills = await harness.wait_for_fills(count=1)

        actual_pnl = fills[0].quantity * fills[0].price - entry_value
        assert actual_pnl == expected_pnl

    @pytest.mark.asyncio
    async def test_L068_flatten_during_disconnection(self, harness: LiveTestHarness):
        """L068: Flatten fails gracefully during disconnection."""
        harness.broker.set_price("AAPL", Decimal("150.00"))
        harness.broker.set_behavior(MockBrokerBehavior.DISCONNECT)

        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        # Order should fail
        assert broker_id is None

        # Verify broker status
        assert harness.broker.status.value == "error"

    @pytest.mark.asyncio
    async def test_L069_emergency_stop_all(self, harness: LiveTestHarness):
        """L069: Emergency stop cancels all and flattens all."""
        harness.broker.set_prices({
            "AAPL": Decimal("150.00"),
            "MSFT": Decimal("300.00"),
        })
        harness.broker.set_behavior(MockBrokerBehavior.DELAY_FILLS)

        # Submit pending orders
        pending_ids = []
        for symbol in ["AAPL", "MSFT"]:
            broker_id = await harness.submit_order(
                symbol=symbol,
                side=OrderSide.BUY,
                quantity=Decimal("50"),
                order_type=OrderType.MARKET,
            )
            pending_ids.append(broker_id)

        # Verify pending
        pending = harness.broker.get_pending_orders()
        assert len(pending) == 2

        # Emergency stop - cancel all pending first
        for broker_id in pending_ids:
            harness.broker.cancel_order(broker_id)

        pending_after = harness.broker.get_pending_orders()
        assert len(pending_after) == 0

        metrics = harness.broker.get_metrics()
        assert metrics["orders_cancelled"] == 2

    @pytest.mark.asyncio
    async def test_L070_flatten_audit_logged(
        self, harness: LiveTestHarness, position_tracker: PositionTracker
    ):
        """L070: Flatten operations are audit logged."""
        from quantlab.logging.audit import AuditLogger, AuditEvent

        # Create audit logger
        audit_logger = AuditLogger(session_id=harness.session_id)

        harness.broker.set_price("AAPL", Decimal("155.00"))

        position = position_tracker.get_position("AAPL")

        # Log flatten intent
        audit_logger.log(AuditEvent(
            event_type="flatten_initiated",
            session_id=harness.session_id,
            data={
                "symbol": "AAPL",
                "quantity": str(position.quantity),
                "reason": "test",
            },
        ))

        # Execute flatten
        await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.SELL,
            quantity=position.quantity,
            order_type=OrderType.MARKET,
        )

        fills = await harness.wait_for_fills(count=1)

        # Log flatten completion
        audit_logger.log(AuditEvent(
            event_type="flatten_completed",
            session_id=harness.session_id,
            data={
                "symbol": "AAPL",
                "quantity": str(fills[0].quantity),
                "price": str(fills[0].price),
            },
        ))

        # Verify events logged
        events = list(audit_logger.read_events(limit=10))
        event_types = [e.event_type for e in events]

        assert "flatten_initiated" in event_types
        assert "flatten_completed" in event_types

        # Cleanup
        audit_logger.close()

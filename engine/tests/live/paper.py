"""
Paper Trading Tests (L001-L010).

Core paper trading functionality tests.

Spec Reference: Technical Spec §1.5, Phase 5
"""

import asyncio
from decimal import Decimal

import pytest

from quantlab.trading.orders import OrderSide, OrderType

from .harness import LiveTestHarness, MockBrokerBehavior, create_harness


class TestPaperTrading:
    """L001-L010: Paper trading core tests."""

    @pytest.fixture
    async def harness(self):
        """Create and start test harness."""
        h = create_harness(initial_capital=Decimal("100000"))
        await h.start(symbols=["AAPL", "MSFT", "GOOGL"])
        yield h
        await h.stop()

    @pytest.mark.asyncio
    async def test_L001_market_order_buy(self, harness: LiveTestHarness):
        """L001: Market buy order executes at current price."""
        # Set price
        harness.broker.set_price("AAPL", Decimal("150.00"))

        # Submit market buy
        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        assert broker_id is not None, "Order should be accepted"

        # Wait for fill
        fills = await harness.wait_for_fills(count=1)

        assert len(fills) == 1, "Should receive one fill"
        assert fills[0].quantity == Decimal("100")
        assert fills[0].price == Decimal("150.00")

    @pytest.mark.asyncio
    async def test_L002_market_order_sell(self, harness: LiveTestHarness):
        """L002: Market sell order executes at current price."""
        harness.broker.set_price("AAPL", Decimal("155.00"))

        # Submit market sell
        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.SELL,
            quantity=Decimal("50"),
            order_type=OrderType.MARKET,
        )

        assert broker_id is not None
        fills = await harness.wait_for_fills(count=1)

        assert len(fills) == 1
        assert fills[0].quantity == Decimal("50")
        assert fills[0].price == Decimal("155.00")

    @pytest.mark.asyncio
    async def test_L003_limit_order_buy_fills_at_limit(self, harness: LiveTestHarness):
        """L003: Limit buy order fills at limit price when price drops."""
        harness.broker.set_price("AAPL", Decimal("150.00"))

        # Submit limit buy below current price
        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.LIMIT,
            limit_price=Decimal("148.00"),
        )

        assert broker_id is not None

        # Price hasn't dropped, should have no fills yet
        pending = harness.broker.get_pending_orders()
        assert len(pending) == 1, "Order should be pending"

        # Drop price to trigger fill
        harness.broker.set_price("AAPL", Decimal("147.50"))
        # Re-queue the fill now that price has dropped
        harness.broker._queue_fill(broker_id, pending[broker_id])

        fills = await harness.wait_for_fills(count=1)
        assert len(fills) == 1
        # Fill at market price (147.50) which is better than limit
        assert fills[0].price == Decimal("147.50")

    @pytest.mark.asyncio
    async def test_L004_limit_order_sell_fills_at_limit(self, harness: LiveTestHarness):
        """L004: Limit sell order fills at limit price when price rises."""
        harness.broker.set_price("MSFT", Decimal("300.00"))

        broker_id = await harness.submit_order(
            symbol="MSFT",
            side=OrderSide.SELL,
            quantity=Decimal("50"),
            order_type=OrderType.LIMIT,
            limit_price=Decimal("305.00"),
        )

        assert broker_id is not None

        # Price hasn't risen, should be pending
        pending = harness.broker.get_pending_orders()
        assert len(pending) == 1

        # Raise price
        harness.broker.set_price("MSFT", Decimal("306.00"))
        harness.broker._queue_fill(broker_id, pending[broker_id])

        fills = await harness.wait_for_fills(count=1)
        assert len(fills) == 1
        assert fills[0].price == Decimal("306.00")

    @pytest.mark.asyncio
    async def test_L005_multiple_orders_same_symbol(self, harness: LiveTestHarness):
        """L005: Multiple orders on same symbol execute correctly."""
        harness.broker.set_price("AAPL", Decimal("150.00"))

        # Submit multiple orders
        order_ids = []
        for i in range(3):
            broker_id = await harness.submit_order(
                symbol="AAPL",
                side=OrderSide.BUY,
                quantity=Decimal("25"),
                order_type=OrderType.MARKET,
            )
            order_ids.append(broker_id)

        assert all(oid is not None for oid in order_ids)

        fills = await harness.wait_for_fills(count=3)
        assert len(fills) == 3

        total_qty = sum(f.quantity for f in fills)
        assert total_qty == Decimal("75")

    @pytest.mark.asyncio
    async def test_L006_multiple_symbols_concurrent(self, harness: LiveTestHarness):
        """L006: Orders on multiple symbols execute concurrently."""
        harness.broker.set_prices({
            "AAPL": Decimal("150.00"),
            "MSFT": Decimal("300.00"),
            "GOOGL": Decimal("2800.00"),
        })

        # Submit orders on different symbols
        order_ids = []
        for symbol in ["AAPL", "MSFT", "GOOGL"]:
            broker_id = await harness.submit_order(
                symbol=symbol,
                side=OrderSide.BUY,
                quantity=Decimal("10"),
                order_type=OrderType.MARKET,
            )
            order_ids.append(broker_id)

        assert all(oid is not None for oid in order_ids)

        fills = await harness.wait_for_fills(count=3)
        assert len(fills) == 3

        symbols_filled = {f.order_id for f in fills}
        assert len(symbols_filled) == 3

    @pytest.mark.asyncio
    async def test_L007_order_cancel(self, harness: LiveTestHarness):
        """L007: Pending order can be cancelled."""
        harness.broker.set_price("AAPL", Decimal("150.00"))
        harness.broker.set_behavior(MockBrokerBehavior.DELAY_FILLS)

        # Submit order that won't immediately fill
        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        assert broker_id is not None

        # Verify order is pending
        pending = harness.broker.get_pending_orders()
        assert len(pending) == 1

        # Cancel order
        cancelled = await harness.broker.cancel_order(broker_id)
        assert cancelled is True

        # Verify no pending orders
        pending = harness.broker.get_pending_orders()
        assert len(pending) == 0

        metrics = harness.broker.get_metrics()
        assert metrics["orders_cancelled"] == 1

    @pytest.mark.asyncio
    async def test_L008_partial_fill_handling(self, harness: LiveTestHarness):
        """L008: Partial fills are handled correctly."""
        harness.broker.set_price("AAPL", Decimal("150.00"))
        harness.broker.set_behavior(MockBrokerBehavior.PARTIAL_FILLS)
        harness.broker.set_partial_fill_ratio(0.5)

        broker_id = await harness.submit_order(
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            order_type=OrderType.MARKET,
        )

        assert broker_id is not None

        fills = await harness.wait_for_fills(count=1)
        assert len(fills) == 1
        assert fills[0].quantity == Decimal("50")  # 50% of 100

    @pytest.mark.asyncio
    async def test_L009_quote_retrieval(self, harness: LiveTestHarness):
        """L009: Quote data is retrievable."""
        harness.broker.set_price("AAPL", Decimal("152.50"))

        quote = await harness.broker.get_quote("AAPL")

        assert quote is not None
        assert quote.symbol == "AAPL"
        assert quote.last == Decimal("152.50")
        assert quote.bid < quote.last < quote.ask
        assert quote.spread > 0

    @pytest.mark.asyncio
    async def test_L010_multi_quote_retrieval(self, harness: LiveTestHarness):
        """L010: Multiple quotes retrieved in single call."""
        harness.broker.set_prices({
            "AAPL": Decimal("150.00"),
            "MSFT": Decimal("300.00"),
        })

        quotes = await harness.broker.get_quotes(["AAPL", "MSFT"])

        assert len(quotes) == 2
        assert "AAPL" in quotes
        assert "MSFT" in quotes
        assert quotes["AAPL"].last == Decimal("150.00")
        assert quotes["MSFT"].last == Decimal("300.00")

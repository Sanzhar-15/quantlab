"""Tests for stop-limit order handling."""

from decimal import Decimal

import pytest

from quantlab.backtest.bar import Bar
from quantlab.orders.base import FillInfo
from quantlab.orders.base import NoFill
from quantlab.orders.base import OrderSide
from quantlab.orders.base import OrderType
from quantlab.orders.stop_limit import StopLimitOrderHandler
from quantlab.orders.stop_limit import StopLimitState


class TestStopLimitOrderHandlerOrderType:
    """Tests for order type property."""

    def test_order_type_is_stop_limit(self):
        """Order type should be STOP_LIMIT."""
        handler = StopLimitOrderHandler()
        assert handler.order_type == OrderType.STOP_LIMIT


class TestStopLimitOrderHandlerCanFill:
    """Tests for can_fill method."""

    @pytest.fixture
    def handler(self):
        return StopLimitOrderHandler()

    @pytest.fixture
    def sample_bar(self):
        return Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("10000"),
        )

    def test_can_fill_returns_false_when_stop_price_none(self, handler, sample_bar):
        """Should return False when stop_price is None."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("103.00"),
            stop_price=None,
        )
        assert result is False

    def test_can_fill_returns_false_when_limit_price_none(self, handler, sample_bar):
        """Should return False when limit_price is None."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=None,
            stop_price=Decimal("102.00"),
        )
        assert result is False

    def test_can_fill_returns_false_on_zero_volume(self, handler):
        """Should return False on zero volume bar."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("0"),
        )
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("103.00"),
            stop_price=Decimal("102.00"),
        )
        assert result is False

    def test_can_fill_buy_stop_not_triggered(self, handler, sample_bar):
        """Buy stop not triggered when bar high < stop_price."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,  # high=105
            limit_price=Decimal("110.00"),
            stop_price=Decimal("106.00"),  # above high
        )
        assert result is False

    def test_can_fill_buy_stop_triggered_limit_achievable(self, handler, sample_bar):
        """Buy can fill when stop triggered and limit achievable."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,  # high=105, low=95
            limit_price=Decimal("103.00"),  # achievable (low <= limit)
            stop_price=Decimal("102.00"),  # triggered (high >= stop)
        )
        assert result is True

    def test_can_fill_buy_stop_triggered_limit_not_achievable(self, handler, sample_bar):
        """Buy cannot fill when stop triggered but limit not achievable."""
        result = handler.can_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,  # low=95
            limit_price=Decimal("94.00"),  # not achievable (low > limit)
            stop_price=Decimal("102.00"),  # triggered
        )
        assert result is False

    def test_can_fill_sell_stop_not_triggered(self, handler, sample_bar):
        """Sell stop not triggered when bar low > stop_price."""
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,  # low=95
            limit_price=Decimal("90.00"),
            stop_price=Decimal("94.00"),  # below low
        )
        assert result is False

    def test_can_fill_sell_stop_triggered_limit_achievable(self, handler, sample_bar):
        """Sell can fill when stop triggered and limit achievable."""
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,  # low=95, high=105
            limit_price=Decimal("97.00"),  # achievable (high >= limit)
            stop_price=Decimal("98.00"),  # triggered (low <= stop)
        )
        assert result is True

    def test_can_fill_sell_stop_triggered_limit_not_achievable(self, handler, sample_bar):
        """Sell cannot fill when stop triggered but limit not achievable."""
        result = handler.can_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,  # high=105
            limit_price=Decimal("106.00"),  # not achievable (high < limit)
            stop_price=Decimal("98.00"),  # triggered
        )
        assert result is False


class TestStopLimitOrderHandlerCalculateFill:
    """Tests for calculate_fill method."""

    @pytest.fixture
    def handler(self):
        return StopLimitOrderHandler()

    @pytest.fixture
    def sample_bar(self):
        return Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("10000"),
        )

    def test_calculate_fill_no_stop_price(self, handler, sample_bar):
        """Should return NoFill when stop_price is None."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("103.00"),
            stop_price=None,
        )
        assert isinstance(result, NoFill)
        assert "Stop price not specified" in result.reason

    def test_calculate_fill_no_limit_price(self, handler, sample_bar):
        """Should return NoFill when limit_price is None."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=None,
            stop_price=Decimal("102.00"),
        )
        assert isinstance(result, NoFill)
        assert "Limit price not specified" in result.reason

    def test_calculate_fill_zero_volume(self, handler):
        """Should return NoFill on zero volume bar."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("0"),
        )
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("103.00"),
            stop_price=Decimal("102.00"),
        )
        assert isinstance(result, NoFill)
        assert "Zero volume" in result.reason

    # Buy stop-limit tests
    def test_calculate_fill_buy_stop_not_triggered(self, handler, sample_bar):
        """Buy stop not triggered returns NoFill."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,  # high=105
            limit_price=Decimal("110.00"),
            stop_price=Decimal("106.00"),  # above high
        )
        assert isinstance(result, NoFill)
        assert "not triggered" in result.reason

    def test_calculate_fill_buy_stop_triggered_limit_not_reached(self, handler, sample_bar):
        """Buy stop triggered but limit not reached returns NoFill."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,  # low=95
            limit_price=Decimal("94.00"),  # below low
            stop_price=Decimal("102.00"),  # triggered
        )
        assert isinstance(result, NoFill)
        assert "limit" in result.reason.lower()
        assert "not reached" in result.reason.lower()

    def test_calculate_fill_buy_open_above_stop_within_limit(self, handler):
        """Buy fill at open when open >= stop and open <= limit."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("103.00"),  # above stop
            high=Decimal("106.00"),
            low=Decimal("101.00"),
            close=Decimal("104.00"),
            volume=Decimal("10000"),
        )
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("105.00"),  # above open
            stop_price=Decimal("102.00"),  # below open
        )
        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("103.00")  # fill at open

    def test_calculate_fill_buy_open_above_stop_above_limit(self, handler):
        """Buy NoFill when open >= stop but open > limit."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("106.00"),  # above stop AND above limit
            high=Decimal("108.00"),
            low=Decimal("105.00"),
            close=Decimal("107.00"),
            volume=Decimal("10000"),
        )
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("105.00"),  # below open
            stop_price=Decimal("104.00"),  # below open
        )
        assert isinstance(result, NoFill)
        assert "above limit" in result.reason.lower()

    def test_calculate_fill_buy_stop_triggered_during_bar(self, handler, sample_bar):
        """Buy fill at stop when stop triggered during bar."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,  # open=100
            limit_price=Decimal("105.00"),  # above stop
            stop_price=Decimal("102.00"),  # above open
        )
        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("102.00")  # fill at stop

    def test_calculate_fill_buy_stop_triggered_limit_below_stop(self, handler, sample_bar):
        """Buy fill at limit when limit < stop (better price)."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,  # open=100, low=95
            limit_price=Decimal("96.00"),  # below stop
            stop_price=Decimal("102.00"),  # above open
        )
        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("96.00")  # fill at limit (better)

    # Sell stop-limit tests
    def test_calculate_fill_sell_stop_not_triggered(self, handler, sample_bar):
        """Sell stop not triggered returns NoFill."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,  # low=95
            limit_price=Decimal("90.00"),
            stop_price=Decimal("94.00"),  # below low
        )
        assert isinstance(result, NoFill)
        assert "not triggered" in result.reason

    def test_calculate_fill_sell_stop_triggered_limit_not_reached(self, handler, sample_bar):
        """Sell stop triggered but limit not reached returns NoFill."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,  # high=105
            limit_price=Decimal("106.00"),  # above high
            stop_price=Decimal("98.00"),  # triggered
        )
        assert isinstance(result, NoFill)
        assert "limit" in result.reason.lower()
        assert "not reached" in result.reason.lower()

    def test_calculate_fill_sell_open_below_stop_within_limit(self, handler):
        """Sell fill at open when open <= stop and open >= limit."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("97.00"),  # below stop
            high=Decimal("99.00"),
            low=Decimal("94.00"),
            close=Decimal("96.00"),
            volume=Decimal("10000"),
        )
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("95.00"),  # below open
            stop_price=Decimal("98.00"),  # above open
        )
        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("97.00")  # fill at open

    def test_calculate_fill_sell_open_below_stop_below_limit(self, handler):
        """Sell NoFill when open <= stop but open < limit."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("94.00"),  # below stop AND below limit
            high=Decimal("96.00"),
            low=Decimal("92.00"),
            close=Decimal("95.00"),
            volume=Decimal("10000"),
        )
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("95.00"),  # above open
            stop_price=Decimal("96.00"),  # above open
        )
        assert isinstance(result, NoFill)
        assert "below limit" in result.reason.lower()

    def test_calculate_fill_sell_stop_triggered_during_bar(self, handler, sample_bar):
        """Sell fill at stop when stop triggered during bar."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,  # open=100
            limit_price=Decimal("95.00"),  # below stop
            stop_price=Decimal("98.00"),  # below open
        )
        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("98.00")  # fill at stop

    def test_calculate_fill_sell_stop_triggered_limit_above_stop(self, handler, sample_bar):
        """Sell fill at limit when limit > stop (better price)."""
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=sample_bar,  # open=100, high=105
            limit_price=Decimal("104.00"),  # above stop
            stop_price=Decimal("98.00"),  # below open
        )
        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("104.00")  # fill at limit (better)

    # Volume participation tests
    def test_calculate_fill_respects_volume_participation(self, handler, sample_bar):
        """Fill quantity limited by max_participation."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("5000"),
            bar=sample_bar,  # volume=10000
            limit_price=Decimal("105.00"),
            stop_price=Decimal("102.00"),
            max_participation=Decimal("0.1"),  # 10% = 1000 shares max
        )
        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("1000")
        assert result.remaining_quantity == Decimal("4000")

    def test_calculate_fill_partial_fill(self, handler, sample_bar):
        """Partial fill when quantity > available volume."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("15000"),  # more than volume
            bar=sample_bar,  # volume=10000
            limit_price=Decimal("105.00"),
            stop_price=Decimal("102.00"),
            max_participation=Decimal("1.0"),
        )
        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("10000")
        assert result.remaining_quantity == Decimal("5000")

    def test_calculate_fill_full_fill(self, handler, sample_bar):
        """Full fill when quantity <= available volume."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("105.00"),
            stop_price=Decimal("102.00"),
        )
        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("100")
        assert result.remaining_quantity == Decimal("0")

    def test_calculate_fill_volume_participation_exceeded(self, handler):
        """NoFill when volume participation results in zero fill."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("1"),  # very low volume
        )
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("105.00"),
            stop_price=Decimal("102.00"),
            max_participation=Decimal("0.001"),  # too restrictive
        )
        # Should return partial fill of volume * participation
        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("0.001")

    def test_calculate_fill_reason_includes_prices(self, handler, sample_bar):
        """Fill reason includes stop and fill prices."""
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=sample_bar,
            limit_price=Decimal("105.00"),
            stop_price=Decimal("102.00"),
        )
        assert isinstance(result, FillInfo)
        assert "102" in result.reason  # stop price
        assert "triggered" in result.reason.lower()


class TestStopLimitState:
    """Tests for StopLimitState class."""

    def test_init_creates_empty_activated_set(self):
        """New state has no activated orders."""
        state = StopLimitState()
        assert state.is_activated("order1") is False

    def test_is_activated_returns_false_for_unknown_order(self):
        """is_activated returns False for unknown orders."""
        state = StopLimitState()
        assert state.is_activated("unknown") is False

    def test_activate_marks_order_as_activated(self):
        """activate marks order as activated."""
        state = StopLimitState()
        state.activate("order1")
        assert state.is_activated("order1") is True

    def test_activate_multiple_orders(self):
        """Can activate multiple orders."""
        state = StopLimitState()
        state.activate("order1")
        state.activate("order2")
        state.activate("order3")
        assert state.is_activated("order1") is True
        assert state.is_activated("order2") is True
        assert state.is_activated("order3") is True

    def test_activate_idempotent(self):
        """Activating same order multiple times is safe."""
        state = StopLimitState()
        state.activate("order1")
        state.activate("order1")
        assert state.is_activated("order1") is True

    def test_clear_removes_order_from_tracking(self):
        """clear removes order from activated set."""
        state = StopLimitState()
        state.activate("order1")
        state.clear("order1")
        assert state.is_activated("order1") is False

    def test_clear_unknown_order_is_safe(self):
        """clear on unknown order doesn't raise."""
        state = StopLimitState()
        state.clear("unknown")  # should not raise
        assert state.is_activated("unknown") is False

    def test_clear_does_not_affect_other_orders(self):
        """clear only affects the specified order."""
        state = StopLimitState()
        state.activate("order1")
        state.activate("order2")
        state.clear("order1")
        assert state.is_activated("order1") is False
        assert state.is_activated("order2") is True


class TestStopLimitStateCheckTrigger:
    """Tests for check_trigger method."""

    @pytest.fixture
    def state(self):
        return StopLimitState()

    @pytest.fixture
    def sample_bar(self):
        return Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("10000"),
        )

    def test_check_trigger_returns_true_if_already_activated(self, state, sample_bar):
        """check_trigger returns True for already activated orders."""
        state.activate("order1")
        result = state.check_trigger(
            order_id="order1",
            side=OrderSide.BUY,
            stop_price=Decimal("200.00"),  # unreachable
            bar=sample_bar,
        )
        assert result is True

    def test_check_trigger_buy_triggered(self, state, sample_bar):
        """Buy trigger when bar.high >= stop_price."""
        result = state.check_trigger(
            order_id="order1",
            side=OrderSide.BUY,
            stop_price=Decimal("103.00"),  # high=105 >= 103
            bar=sample_bar,
        )
        assert result is True
        assert state.is_activated("order1") is True

    def test_check_trigger_buy_not_triggered(self, state, sample_bar):
        """Buy not triggered when bar.high < stop_price."""
        result = state.check_trigger(
            order_id="order1",
            side=OrderSide.BUY,
            stop_price=Decimal("106.00"),  # high=105 < 106
            bar=sample_bar,
        )
        assert result is False
        assert state.is_activated("order1") is False

    def test_check_trigger_buy_at_exact_high(self, state, sample_bar):
        """Buy triggered when bar.high == stop_price."""
        result = state.check_trigger(
            order_id="order1",
            side=OrderSide.BUY,
            stop_price=Decimal("105.00"),  # high=105 == 105
            bar=sample_bar,
        )
        assert result is True
        assert state.is_activated("order1") is True

    def test_check_trigger_sell_triggered(self, state, sample_bar):
        """Sell trigger when bar.low <= stop_price."""
        result = state.check_trigger(
            order_id="order1",
            side=OrderSide.SELL,
            stop_price=Decimal("97.00"),  # low=95 <= 97
            bar=sample_bar,
        )
        assert result is True
        assert state.is_activated("order1") is True

    def test_check_trigger_sell_not_triggered(self, state, sample_bar):
        """Sell not triggered when bar.low > stop_price."""
        result = state.check_trigger(
            order_id="order1",
            side=OrderSide.SELL,
            stop_price=Decimal("94.00"),  # low=95 > 94
            bar=sample_bar,
        )
        assert result is False
        assert state.is_activated("order1") is False

    def test_check_trigger_sell_at_exact_low(self, state, sample_bar):
        """Sell triggered when bar.low == stop_price."""
        result = state.check_trigger(
            order_id="order1",
            side=OrderSide.SELL,
            stop_price=Decimal("95.00"),  # low=95 == 95
            bar=sample_bar,
        )
        assert result is True
        assert state.is_activated("order1") is True

    def test_check_trigger_tracks_multiple_orders(self, state, sample_bar):
        """check_trigger tracks each order independently."""
        # Trigger order1 (buy)
        state.check_trigger(
            order_id="order1",
            side=OrderSide.BUY,
            stop_price=Decimal("103.00"),
            bar=sample_bar,
        )
        # Don't trigger order2 (sell with unreachable stop)
        state.check_trigger(
            order_id="order2",
            side=OrderSide.SELL,
            stop_price=Decimal("94.00"),  # below low
            bar=sample_bar,
        )
        # Trigger order3 (sell)
        state.check_trigger(
            order_id="order3",
            side=OrderSide.SELL,
            stop_price=Decimal("97.00"),
            bar=sample_bar,
        )

        assert state.is_activated("order1") is True
        assert state.is_activated("order2") is False
        assert state.is_activated("order3") is True


class TestStopLimitOrderHandlerEdgeCases:
    """Edge case tests for stop-limit orders."""

    @pytest.fixture
    def handler(self):
        return StopLimitOrderHandler()

    def test_buy_stop_equals_limit(self, handler):
        """Buy with stop == limit fills at that price."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("10000"),
        )
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("102.00"),
            stop_price=Decimal("102.00"),  # same as limit
        )
        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("102.00")

    def test_sell_stop_equals_limit(self, handler):
        """Sell with stop == limit fills at that price."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("10000"),
        )
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("98.00"),
            stop_price=Decimal("98.00"),  # same as limit
        )
        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("98.00")

    def test_buy_gap_up_through_both_prices(self, handler):
        """Buy gap up through both stop and limit."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("110.00"),  # above both
            high=Decimal("112.00"),
            low=Decimal("108.00"),
            close=Decimal("111.00"),
            volume=Decimal("10000"),
        )
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("105.00"),  # below open
            stop_price=Decimal("102.00"),  # below open
        )
        # Open is above limit, so should not fill
        assert isinstance(result, NoFill)
        assert "limit" in result.reason.lower()
        assert "not reached" in result.reason.lower()

    def test_sell_gap_down_through_both_prices(self, handler):
        """Sell gap down through both stop and limit."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("90.00"),  # below both
            high=Decimal("92.00"),
            low=Decimal("88.00"),
            close=Decimal("91.00"),
            volume=Decimal("10000"),
        )
        result = handler.calculate_fill(
            side=OrderSide.SELL,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("95.00"),  # above open
            stop_price=Decimal("98.00"),  # above open
        )
        # Open is below limit, so should not fill
        assert isinstance(result, NoFill)
        assert "limit" in result.reason.lower()
        assert "not reached" in result.reason.lower()

    def test_very_small_quantity(self, handler):
        """Handle very small quantity orders."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("100.00"),
            high=Decimal("105.00"),
            low=Decimal("95.00"),
            close=Decimal("102.00"),
            volume=Decimal("10000"),
        )
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("0.001"),
            bar=bar,
            limit_price=Decimal("105.00"),
            stop_price=Decimal("102.00"),
        )
        assert isinstance(result, FillInfo)
        assert result.fill_quantity == Decimal("0.001")

    def test_very_large_prices(self, handler):
        """Handle very large price values."""
        bar = Bar(
            symbol="AAPL",
            timestamp=0,
            open=Decimal("1000000.00"),
            high=Decimal("1050000.00"),
            low=Decimal("950000.00"),
            close=Decimal("1020000.00"),
            volume=Decimal("10000"),
        )
        result = handler.calculate_fill(
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            bar=bar,
            limit_price=Decimal("1050000.00"),
            stop_price=Decimal("1020000.00"),
        )
        assert isinstance(result, FillInfo)
        assert result.fill_price == Decimal("1020000.00")

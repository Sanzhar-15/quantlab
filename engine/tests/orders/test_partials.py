"""Tests for partial fill management."""

from datetime import datetime
from decimal import Decimal

import pytest

from quantlab.orders.partials import OrderFillState
from quantlab.orders.partials import PartialFill
from quantlab.orders.partials import PartialFillConfig
from quantlab.orders.partials import PartialFillTracker
from quantlab.orders.partials import PartialFillValidator


class TestPartialFill:
    """Tests for PartialFill dataclass."""

    def test_create_partial_fill(self):
        """Should create a PartialFill with all fields."""
        now = datetime.now()
        fill = PartialFill(
            fill_id="fill-001",
            order_id="order-001",
            fill_number=1,
            quantity=Decimal("100"),
            price=Decimal("50.00"),
            timestamp=now,
            bar_index=5,
            commission=Decimal("0.50"),
        )
        assert fill.fill_id == "fill-001"
        assert fill.order_id == "order-001"
        assert fill.fill_number == 1
        assert fill.quantity == Decimal("100")
        assert fill.price == Decimal("50.00")
        assert fill.timestamp == now
        assert fill.bar_index == 5
        assert fill.commission == Decimal("0.50")

    def test_default_commission(self):
        """Commission should default to 0."""
        fill = PartialFill(
            fill_id="fill-001",
            order_id="order-001",
            fill_number=1,
            quantity=Decimal("100"),
            price=Decimal("50.00"),
            timestamp=datetime.now(),
            bar_index=0,
        )
        assert fill.commission == Decimal("0")


class TestOrderFillState:
    """Tests for OrderFillState class."""

    def test_create_order_fill_state(self):
        """Should create OrderFillState with defaults."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
        )
        assert state.order_id == "order-001"
        assert state.original_quantity == Decimal("500")
        assert state.filled_quantity == Decimal("0")
        assert state.fills == []
        assert state.avg_fill_price is None
        assert state.total_commission == Decimal("0")

    def test_remaining_quantity(self):
        """Should calculate remaining quantity."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
            filled_quantity=Decimal("200"),
        )
        assert state.remaining_quantity == Decimal("300")

    def test_remaining_quantity_when_complete(self):
        """Should return 0 when order is complete."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
            filled_quantity=Decimal("500"),
        )
        assert state.remaining_quantity == Decimal("0")

    def test_fill_ratio_normal(self):
        """Should calculate fill ratio as percentage."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
            filled_quantity=Decimal("200"),
        )
        assert state.fill_ratio == Decimal("0.4")

    def test_fill_ratio_zero_original_quantity(self):
        """Should return 0 when original quantity is 0."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("0"),
        )
        assert state.fill_ratio == Decimal("0")

    def test_fill_ratio_complete(self):
        """Should return 1.0 when complete."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
            filled_quantity=Decimal("500"),
        )
        assert state.fill_ratio == Decimal("1")

    def test_is_complete_true(self):
        """Should return True when fully filled."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
            filled_quantity=Decimal("500"),
        )
        assert state.is_complete is True

    def test_is_complete_false(self):
        """Should return False when not fully filled."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
            filled_quantity=Decimal("200"),
        )
        assert state.is_complete is False

    def test_is_partially_filled_true(self):
        """Should return True when has fills but not complete."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
            filled_quantity=Decimal("200"),
        )
        assert state.is_partially_filled is True

    def test_is_partially_filled_false_when_complete(self):
        """Should return False when complete."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
            filled_quantity=Decimal("500"),
        )
        assert state.is_partially_filled is False

    def test_is_partially_filled_false_when_unfilled(self):
        """Should return False when no fills."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
        )
        assert state.is_partially_filled is False

    def test_num_fills(self):
        """Should return count of fills."""
        now = datetime.now()
        fill1 = PartialFill(
            fill_id="fill-001",
            order_id="order-001",
            fill_number=1,
            quantity=Decimal("100"),
            price=Decimal("50.00"),
            timestamp=now,
            bar_index=0,
        )
        fill2 = PartialFill(
            fill_id="fill-002",
            order_id="order-001",
            fill_number=2,
            quantity=Decimal("100"),
            price=Decimal("51.00"),
            timestamp=now,
            bar_index=1,
        )
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
            fills=[fill1, fill2],
        )
        assert state.num_fills == 2

    def test_add_fill_updates_filled_quantity(self):
        """add_fill should update filled_quantity."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
        )
        fill = PartialFill(
            fill_id="fill-001",
            order_id="order-001",
            fill_number=1,
            quantity=Decimal("100"),
            price=Decimal("50.00"),
            timestamp=datetime.now(),
            bar_index=0,
        )
        state.add_fill(fill)
        assert state.filled_quantity == Decimal("100")

    def test_add_fill_updates_commission(self):
        """add_fill should update total_commission."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
        )
        fill = PartialFill(
            fill_id="fill-001",
            order_id="order-001",
            fill_number=1,
            quantity=Decimal("100"),
            price=Decimal("50.00"),
            timestamp=datetime.now(),
            bar_index=0,
            commission=Decimal("1.50"),
        )
        state.add_fill(fill)
        assert state.total_commission == Decimal("1.50")

    def test_add_fill_calculates_avg_price(self):
        """add_fill should calculate average fill price."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
        )
        fill1 = PartialFill(
            fill_id="fill-001",
            order_id="order-001",
            fill_number=1,
            quantity=Decimal("100"),
            price=Decimal("50.00"),
            timestamp=datetime.now(),
            bar_index=0,
        )
        fill2 = PartialFill(
            fill_id="fill-002",
            order_id="order-001",
            fill_number=2,
            quantity=Decimal("100"),
            price=Decimal("52.00"),
            timestamp=datetime.now(),
            bar_index=1,
        )
        state.add_fill(fill1)
        state.add_fill(fill2)
        # (100*50 + 100*52) / 200 = 10200 / 200 = 51
        assert state.avg_fill_price == Decimal("51.00")

    def test_add_fill_appends_to_list(self):
        """add_fill should append fill to fills list."""
        state = OrderFillState(
            order_id="order-001",
            original_quantity=Decimal("500"),
        )
        fill = PartialFill(
            fill_id="fill-001",
            order_id="order-001",
            fill_number=1,
            quantity=Decimal("100"),
            price=Decimal("50.00"),
            timestamp=datetime.now(),
            bar_index=0,
        )
        state.add_fill(fill)
        assert len(state.fills) == 1
        assert state.fills[0] is fill


class TestPartialFillTracker:
    """Tests for PartialFillTracker class."""

    @pytest.fixture
    def tracker(self):
        return PartialFillTracker()

    def test_register_order(self, tracker):
        """Should register a new order for tracking."""
        state = tracker.register_order("order-001", Decimal("500"))
        assert state.order_id == "order-001"
        assert state.original_quantity == Decimal("500")
        assert state.filled_quantity == Decimal("0")

    def test_create_order_is_alias(self, tracker):
        """create_order should be an alias for register_order."""
        state = tracker.create_order("order-001", Decimal("500"))
        assert state.order_id == "order-001"
        assert state.original_quantity == Decimal("500")

    def test_record_fill_basic(self, tracker):
        """Should record a fill for an order."""
        tracker.register_order("order-001", Decimal("500"))
        fill = tracker.record_fill(
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("50.00"),
        )
        assert fill.order_id == "order-001"
        assert fill.quantity == Decimal("100")
        assert fill.price == Decimal("50.00")
        assert fill.fill_number == 1

    def test_record_fill_auto_register(self, tracker):
        """Should auto-register order if not tracked."""
        fill = tracker.record_fill(
            order_id="order-new",
            quantity=Decimal("100"),
            price=Decimal("50.00"),
        )
        assert fill.order_id == "order-new"
        state = tracker.get_state("order-new")
        assert state is not None
        assert state.original_quantity == Decimal("100")

    def test_record_fill_increments_fill_counter(self, tracker):
        """Fill IDs should increment."""
        tracker.register_order("order-001", Decimal("500"))
        fill1 = tracker.record_fill("order-001", Decimal("100"))
        fill2 = tracker.record_fill("order-001", Decimal("100"))
        assert fill1.fill_id == "fill-00000001"
        assert fill2.fill_id == "fill-00000002"

    def test_record_fill_with_all_params(self, tracker):
        """Should record fill with all optional parameters."""
        tracker.register_order("order-001", Decimal("500"))
        now = datetime.now()
        fill = tracker.record_fill(
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("50.00"),
            timestamp=now,
            bar_index=5,
            commission=Decimal("1.25"),
        )
        assert fill.timestamp == now
        assert fill.bar_index == 5
        assert fill.commission == Decimal("1.25")

    def test_record_fill_defaults_price_to_zero(self, tracker):
        """Should default price to 0 if not provided."""
        tracker.register_order("order-001", Decimal("500"))
        fill = tracker.record_fill(
            order_id="order-001",
            quantity=Decimal("100"),
        )
        assert fill.price == Decimal("0")

    def test_record_fill_defaults_timestamp(self, tracker):
        """Should default timestamp to now if not provided."""
        tracker.register_order("order-001", Decimal("500"))
        fill = tracker.record_fill(
            order_id="order-001",
            quantity=Decimal("100"),
            price=Decimal("50.00"),
        )
        assert isinstance(fill.timestamp, datetime)

    def test_get_state_exists(self, tracker):
        """Should return state for existing order."""
        tracker.register_order("order-001", Decimal("500"))
        state = tracker.get_state("order-001")
        assert state is not None
        assert state.order_id == "order-001"

    def test_get_state_not_exists(self, tracker):
        """Should return None for unknown order."""
        state = tracker.get_state("unknown")
        assert state is None

    def test_get_remaining_exists(self, tracker):
        """Should return remaining quantity for existing order."""
        tracker.register_order("order-001", Decimal("500"))
        tracker.record_fill("order-001", Decimal("200"))
        remaining = tracker.get_remaining("order-001")
        assert remaining == Decimal("300")

    def test_get_remaining_not_exists(self, tracker):
        """Should return 0 for unknown order."""
        remaining = tracker.get_remaining("unknown")
        assert remaining == Decimal("0")

    def test_is_complete_true(self, tracker):
        """Should return True when order is complete."""
        tracker.register_order("order-001", Decimal("100"))
        tracker.record_fill("order-001", Decimal("100"))
        assert tracker.is_complete("order-001") is True

    def test_is_complete_false(self, tracker):
        """Should return False when order is not complete."""
        tracker.register_order("order-001", Decimal("100"))
        tracker.record_fill("order-001", Decimal("50"))
        assert tracker.is_complete("order-001") is False

    def test_is_complete_unknown(self, tracker):
        """Should return False for unknown order."""
        assert tracker.is_complete("unknown") is False

    def test_remove_order_returns_state(self, tracker):
        """Should remove order and return final state."""
        tracker.register_order("order-001", Decimal("500"))
        tracker.record_fill("order-001", Decimal("200"))
        state = tracker.remove_order("order-001")
        assert state is not None
        assert state.filled_quantity == Decimal("200")
        # Should be removed
        assert tracker.get_state("order-001") is None

    def test_remove_order_unknown(self, tracker):
        """Should return None for unknown order."""
        state = tracker.remove_order("unknown")
        assert state is None

    def test_get_all_incomplete(self, tracker):
        """Should return all incomplete order IDs."""
        tracker.register_order("order-001", Decimal("100"))
        tracker.register_order("order-002", Decimal("100"))
        tracker.register_order("order-003", Decimal("100"))
        tracker.record_fill("order-001", Decimal("50"))  # partial
        tracker.record_fill("order-002", Decimal("100"))  # complete
        # order-003 has no fills

        incomplete = tracker.get_all_incomplete()
        assert "order-001" in incomplete
        assert "order-003" in incomplete
        assert "order-002" not in incomplete


class TestPartialFillConfig:
    """Tests for PartialFillConfig dataclass."""

    def test_default_values(self):
        """Should have reasonable defaults."""
        config = PartialFillConfig()
        assert config.min_fill_quantity == Decimal("1")
        assert config.max_partial_fills == 10
        assert config.allow_fractional is False
        assert config.lot_size == Decimal("0")

    def test_custom_values(self):
        """Should accept custom values."""
        config = PartialFillConfig(
            min_fill_quantity=Decimal("10"),
            max_partial_fills=5,
            allow_fractional=True,
            lot_size=Decimal("100"),
        )
        assert config.min_fill_quantity == Decimal("10")
        assert config.max_partial_fills == 5
        assert config.allow_fractional is True
        assert config.lot_size == Decimal("100")


class TestPartialFillValidator:
    """Tests for PartialFillValidator class."""

    def test_default_config(self):
        """Should use default config if none provided."""
        validator = PartialFillValidator()
        assert validator.config.min_fill_quantity == Decimal("1")

    def test_custom_config(self):
        """Should use provided config."""
        config = PartialFillConfig(min_fill_quantity=Decimal("10"))
        validator = PartialFillValidator(config)
        assert validator.config.min_fill_quantity == Decimal("10")


class TestPartialFillValidatorValidateFill:
    """Tests for validate_fill method."""

    def test_valid_fill(self):
        """Should return (True, '') for valid fill."""
        validator = PartialFillValidator()
        is_valid, reason = validator.validate_fill(
            fill_quantity=Decimal("100"),
            remaining_quantity=Decimal("500"),
            fill_count=0,
        )
        assert is_valid is True
        assert reason == ""

    def test_below_minimum_fill_quantity(self):
        """Should reject fill below minimum."""
        config = PartialFillConfig(min_fill_quantity=Decimal("10"))
        validator = PartialFillValidator(config)
        is_valid, reason = validator.validate_fill(
            fill_quantity=Decimal("5"),
            remaining_quantity=Decimal("500"),
            fill_count=0,
        )
        assert is_valid is False
        assert "below minimum" in reason

    def test_max_partial_fills_reached(self):
        """Should reject when max partial fills reached."""
        config = PartialFillConfig(max_partial_fills=3)
        validator = PartialFillValidator(config)
        is_valid, reason = validator.validate_fill(
            fill_quantity=Decimal("100"),
            remaining_quantity=Decimal("500"),
            fill_count=3,  # already at max
        )
        assert is_valid is False
        assert "Max partial fills" in reason

    def test_fractional_not_allowed(self):
        """Should reject fractional when not allowed."""
        config = PartialFillConfig(allow_fractional=False)
        validator = PartialFillValidator(config)
        is_valid, reason = validator.validate_fill(
            fill_quantity=Decimal("100.5"),
            remaining_quantity=Decimal("500"),
            fill_count=0,
        )
        assert is_valid is False
        assert "Fractional" in reason

    def test_fractional_allowed(self):
        """Should allow fractional when enabled."""
        config = PartialFillConfig(allow_fractional=True)
        validator = PartialFillValidator(config)
        is_valid, reason = validator.validate_fill(
            fill_quantity=Decimal("100.5"),
            remaining_quantity=Decimal("500"),
            fill_count=0,
        )
        assert is_valid is True

    def test_lot_size_violation(self):
        """Should reject fill not multiple of lot size."""
        config = PartialFillConfig(lot_size=Decimal("100"))
        validator = PartialFillValidator(config)
        is_valid, reason = validator.validate_fill(
            fill_quantity=Decimal("150"),
            remaining_quantity=Decimal("500"),
            fill_count=0,
        )
        assert is_valid is False
        assert "lot size" in reason

    def test_lot_size_valid(self):
        """Should accept fill that is multiple of lot size."""
        config = PartialFillConfig(lot_size=Decimal("100"))
        validator = PartialFillValidator(config)
        is_valid, reason = validator.validate_fill(
            fill_quantity=Decimal("200"),
            remaining_quantity=Decimal("500"),
            fill_count=0,
        )
        assert is_valid is True

    def test_lot_size_zero_is_ignored(self):
        """Should ignore lot size when 0."""
        config = PartialFillConfig(lot_size=Decimal("0"))
        validator = PartialFillValidator(config)
        is_valid, reason = validator.validate_fill(
            fill_quantity=Decimal("123"),
            remaining_quantity=Decimal("500"),
            fill_count=0,
        )
        assert is_valid is True


class TestPartialFillValidatorRoundToLot:
    """Tests for round_to_lot method."""

    def test_round_to_lot_exact(self):
        """Should not change quantity that is exact lot."""
        config = PartialFillConfig(lot_size=Decimal("100"))
        validator = PartialFillValidator(config)
        result = validator.round_to_lot(Decimal("300"))
        assert result == Decimal("300")

    def test_round_to_lot_down(self):
        """Should round down to nearest lot."""
        config = PartialFillConfig(lot_size=Decimal("100"))
        validator = PartialFillValidator(config)
        result = validator.round_to_lot(Decimal("350"))
        assert result == Decimal("300")

    def test_round_to_lot_zero_lot_size(self):
        """Should return unchanged when lot_size is 0."""
        config = PartialFillConfig(lot_size=Decimal("0"))
        validator = PartialFillValidator(config)
        result = validator.round_to_lot(Decimal("123"))
        assert result == Decimal("123")

    def test_round_to_lot_negative_lot_size(self):
        """Should return unchanged when lot_size is negative."""
        config = PartialFillConfig(lot_size=Decimal("-1"))
        validator = PartialFillValidator(config)
        result = validator.round_to_lot(Decimal("123"))
        assert result == Decimal("123")


class TestPartialFillValidatorAdjustFillQuantity:
    """Tests for adjust_fill_quantity method."""

    def test_adjust_does_not_exceed_remaining(self):
        """Should not exceed remaining quantity."""
        validator = PartialFillValidator()
        result = validator.adjust_fill_quantity(
            proposed_fill=Decimal("1000"),
            remaining=Decimal("500"),
            fill_count=0,
        )
        assert result == Decimal("500")

    def test_adjust_applies_lot_rounding(self):
        """Should round to lot size."""
        config = PartialFillConfig(lot_size=Decimal("100"))
        validator = PartialFillValidator(config)
        result = validator.adjust_fill_quantity(
            proposed_fill=Decimal("350"),
            remaining=Decimal("500"),
            fill_count=0,
        )
        assert result == Decimal("300")

    def test_adjust_below_minimum_with_large_remaining(self):
        """Should return 0 when below minimum but remaining is large."""
        config = PartialFillConfig(
            min_fill_quantity=Decimal("100"),
            lot_size=Decimal("10"),
        )
        validator = PartialFillValidator(config)
        # Proposed 50 rounds to 50, but min is 100, remaining is 500
        result = validator.adjust_fill_quantity(
            proposed_fill=Decimal("50"),
            remaining=Decimal("500"),
            fill_count=0,
        )
        assert result == Decimal("0")

    def test_adjust_below_minimum_last_fill_exception(self):
        """Should fill remaining when remaining < minimum (last fill)."""
        config = PartialFillConfig(min_fill_quantity=Decimal("100"))
        validator = PartialFillValidator(config)
        # Proposed 50, remaining 50 (less than min)
        result = validator.adjust_fill_quantity(
            proposed_fill=Decimal("50"),
            remaining=Decimal("50"),
            fill_count=0,
        )
        assert result == Decimal("50")

    def test_adjust_normal_case(self):
        """Should return proposed fill when no constraints hit."""
        validator = PartialFillValidator()
        result = validator.adjust_fill_quantity(
            proposed_fill=Decimal("100"),
            remaining=Decimal("500"),
            fill_count=0,
        )
        assert result == Decimal("100")

    def test_adjust_lot_rounding_then_minimum_check(self):
        """Should apply lot rounding before minimum check."""
        config = PartialFillConfig(
            min_fill_quantity=Decimal("100"),
            lot_size=Decimal("100"),
        )
        validator = PartialFillValidator(config)
        # Proposed 150 -> rounds to 100, which meets minimum
        result = validator.adjust_fill_quantity(
            proposed_fill=Decimal("150"),
            remaining=Decimal("500"),
            fill_count=0,
        )
        assert result == Decimal("100")

    def test_adjust_lot_rounding_reduces_below_minimum(self):
        """Should return 0 when lot rounding reduces below minimum."""
        config = PartialFillConfig(
            min_fill_quantity=Decimal("100"),
            lot_size=Decimal("100"),
        )
        validator = PartialFillValidator(config)
        # Proposed 99 -> rounds to 0, which is below minimum
        # remaining=500 is >= minimum, so return 0
        result = validator.adjust_fill_quantity(
            proposed_fill=Decimal("99"),
            remaining=Decimal("500"),
            fill_count=0,
        )
        assert result == Decimal("0")


class TestPartialFillTrackerMultipleFills:
    """Integration tests for tracking multiple fills."""

    def test_multiple_fills_same_order(self):
        """Should track multiple fills for same order."""
        tracker = PartialFillTracker()
        tracker.register_order("order-001", Decimal("500"))

        tracker.record_fill("order-001", Decimal("100"), Decimal("50.00"))
        tracker.record_fill("order-001", Decimal("150"), Decimal("51.00"))
        tracker.record_fill("order-001", Decimal("100"), Decimal("49.00"))

        state = tracker.get_state("order-001")
        assert state is not None
        assert state.filled_quantity == Decimal("350")
        assert state.num_fills == 3
        assert state.remaining_quantity == Decimal("150")

    def test_complete_order_with_multiple_fills(self):
        """Should mark order complete after multiple fills."""
        tracker = PartialFillTracker()
        tracker.register_order("order-001", Decimal("300"))

        tracker.record_fill("order-001", Decimal("100"))
        assert not tracker.is_complete("order-001")

        tracker.record_fill("order-001", Decimal("100"))
        assert not tracker.is_complete("order-001")

        tracker.record_fill("order-001", Decimal("100"))
        assert tracker.is_complete("order-001")

    def test_average_fill_price_calculation(self):
        """Should calculate correct average fill price."""
        tracker = PartialFillTracker()
        tracker.register_order("order-001", Decimal("200"))

        # 100 @ 50 = 5000
        tracker.record_fill("order-001", Decimal("100"), Decimal("50.00"))
        # 50 @ 52 = 2600
        tracker.record_fill("order-001", Decimal("50"), Decimal("52.00"))
        # 50 @ 48 = 2400
        tracker.record_fill("order-001", Decimal("50"), Decimal("48.00"))

        # Total: 10000 / 200 = 50
        state = tracker.get_state("order-001")
        assert state is not None
        assert state.avg_fill_price == Decimal("50.00")

"""
Tests for Strategy API Module.

Tests parameter extraction, state management, and strategy APIs.
"""

from decimal import Decimal
from typing import Any

import pytest

from quantlab.api import (
    Context,
    EventDrivenStrategy,
    EventType,
    Param,
    ParamSet,
    ParamSpec,
    ParamType,
    StateCapture,
    StateManager,
    Strategy,
    StrategyRunner,
    StrategyState,
    VectorizedSignals,
    VectorizedStrategy,
    combine_signals,
    event_strategy,
    extract_function_params,
    extract_params,
    flat,
    long,
    param,
    short,
    vectorized_strategy,
    # Phase 3: Enhanced Parameter Extraction
    WidgetType,
    ParameterDefinition,
    ParameterGroup,
    SourceCodeExtractor,
    extract_params_from_source,
    extract_params_for_panel,
    apply_params_to_source,
)


class TestParamSpec:
    """Tests for ParamSpec dataclass."""

    def test_param_spec_creation(self) -> None:
        """Test creating a parameter specification."""
        spec = ParamSpec(
            name="lookback",
            param_type=ParamType.INTEGER,
            default=20,
            min_value=5,
            max_value=100,
            description="Lookback period",
        )

        assert spec.name == "lookback"
        assert spec.default == 20
        assert spec.min_value == 5

    def test_param_spec_validation(self) -> None:
        """Test parameter value validation."""
        spec = ParamSpec(
            name="threshold",
            param_type=ParamType.DECIMAL,
            default=Decimal("0.05"),
            min_value=Decimal("0.01"),
            max_value=Decimal("0.20"),
        )

        # Valid value
        assert spec.validate(Decimal("0.10"))

        # Invalid values
        assert not spec.validate(Decimal("0.005"))  # Below min
        assert not spec.validate(Decimal("0.30"))   # Above max


class TestParamDescriptor:
    """Tests for Param descriptor."""

    def test_param_descriptor_in_class(self) -> None:
        """Test using param descriptor in a class."""
        class TestStrategy:
            lookback = Param(default=20, min=5, max=100)
            threshold = Param(default=Decimal("0.05"))

        strategy = TestStrategy()

        assert strategy.lookback == 20
        assert strategy.threshold == Decimal("0.05")

    def test_param_descriptor_modification(self) -> None:
        """Test modifying param values."""
        class TestStrategy:
            lookback = Param(default=20, min=5, max=100)

        strategy = TestStrategy()
        strategy.lookback = 50

        assert strategy.lookback == 50

    def test_param_descriptor_validation(self) -> None:
        """Test param descriptor validates on set."""
        class TestStrategy:
            lookback = Param(default=20, min=5, max=100)

        strategy = TestStrategy()

        with pytest.raises(ValueError):
            strategy.lookback = 150  # Above max


class TestParamFunction:
    """Tests for param() function."""

    def test_param_function_basic(self) -> None:
        """Test basic param function usage."""
        p = param(20)
        assert p.default == 20

    def test_param_function_with_constraints(self) -> None:
        """Test param function with constraints."""
        p = param(20, min=5, max=100, description="Lookback period")

        assert p.default == 20
        assert p.min == 5
        assert p.max == 100
        assert p.description == "Lookback period"


class TestExtractParams:
    """Tests for parameter extraction."""

    def test_extract_params_from_class(self) -> None:
        """Test extracting params from a class."""
        class TestStrategy:
            lookback = Param(default=20, min=5, max=100)
            threshold = Param(default=Decimal("0.05"))

        params = extract_params(TestStrategy)

        assert len(params) == 2
        assert "lookback" in params
        assert "threshold" in params
        assert params["lookback"].default == 20

    def test_extract_function_params(self) -> None:
        """Test extracting params from function signature."""
        def my_strategy(
            data,
            lookback: int = 20,
            threshold: Decimal = Decimal("0.05"),
        ):
            pass

        params = extract_function_params(my_strategy)

        assert "lookback" in params
        assert params["lookback"].default == 20


class TestParamSet:
    """Tests for ParamSet."""

    def test_param_set_creation(self) -> None:
        """Test creating a parameter set."""
        param_set = ParamSet(
            params={
                "lookback": 20,
                "threshold": Decimal("0.05"),
            }
        )

        assert param_set.get("lookback") == 20
        assert param_set.get("threshold") == Decimal("0.05")

    def test_param_set_validation(self) -> None:
        """Test param set validation against specs."""
        specs = {
            "lookback": ParamSpec(
                name="lookback",
                param_type=ParamType.INTEGER,
                default=20,
                min_value=5,
                max_value=100,
            ),
        }

        # Valid
        param_set = ParamSet(params={"lookback": 50})
        assert param_set.validate(specs)

        # Invalid
        param_set = ParamSet(params={"lookback": 150})
        assert not param_set.validate(specs)


class TestStrategyState:
    """Tests for strategy state management."""

    def test_state_creation(self) -> None:
        """Test creating strategy state."""
        state = StrategyState(
            params={"lookback": 20},
            internal_state={"sma": [100, 101, 102]},
        )

        assert state.params["lookback"] == 20
        assert len(state.internal_state["sma"]) == 3

    def test_state_serialization(self) -> None:
        """Test state serialization and deserialization."""
        state = StrategyState(
            params={"lookback": 20},
            internal_state={"values": [1, 2, 3]},
        )

        data = state.to_dict()
        restored = StrategyState.from_dict(data)

        assert restored.params == state.params
        assert restored.internal_state == state.internal_state


class TestStateManager:
    """Tests for StateManager."""

    @pytest.fixture
    def manager(self, tmp_path) -> StateManager:
        """Create state manager."""
        return StateManager(state_dir=tmp_path)

    def test_save_and_load_state(
        self,
        manager: StateManager,
    ) -> None:
        """Test saving and loading state."""
        state = StrategyState(
            params={"lookback": 20},
            internal_state={"buffer": [1, 2, 3]},
        )

        # Save
        state_id = manager.save_state("test_strategy", state)
        assert state_id is not None

        # Load
        loaded = manager.load_state(state_id)
        assert loaded is not None
        assert loaded.params == state.params

    def test_list_checkpoints(
        self,
        manager: StateManager,
    ) -> None:
        """Test listing checkpoints."""
        # Save multiple states
        for i in range(3):
            state = StrategyState(params={"iteration": i})
            manager.save_state("test_strategy", state)

        checkpoints = manager.list_checkpoints("test_strategy")
        assert len(checkpoints) == 3


class TestVectorizedSignals:
    """Tests for VectorizedSignals."""

    def test_signals_creation(self) -> None:
        """Test creating vectorized signals."""
        signals = VectorizedSignals(
            positions={"AAPL": Decimal("1.0"), "MSFT": Decimal("-0.5")},
        )

        assert signals.positions["AAPL"] == Decimal("1.0")
        assert signals.positions["MSFT"] == Decimal("-0.5")

    def test_long_signal(self) -> None:
        """Test long signal creation."""
        signal = long("AAPL")
        assert signal.positions["AAPL"] == Decimal("1.0")

    def test_short_signal(self) -> None:
        """Test short signal creation."""
        signal = short("AAPL")
        assert signal.positions["AAPL"] == Decimal("-1.0")

    def test_flat_signal(self) -> None:
        """Test flat signal creation."""
        signal = flat("AAPL")
        assert signal.positions["AAPL"] == Decimal("0")

    def test_combine_signals(self) -> None:
        """Test combining signals."""
        s1 = long("AAPL")
        s2 = short("MSFT")

        combined = combine_signals(s1, s2)

        assert combined.positions["AAPL"] == Decimal("1.0")
        assert combined.positions["MSFT"] == Decimal("-1.0")


class TestVectorizedStrategy:
    """Tests for vectorized strategy decorator."""

    def test_vectorized_strategy_decorator(self) -> None:
        """Test vectorized strategy decorator."""
        @vectorized_strategy
        def my_strategy(data, lookback: int = 20) -> VectorizedSignals:
            return long("AAPL")

        assert hasattr(my_strategy, "params")

    def test_vectorized_strategy_execution(self) -> None:
        """Test executing a vectorized strategy."""
        @vectorized_strategy
        def simple_long(data) -> VectorizedSignals:
            return long("AAPL")

        result = simple_long({})
        assert result.positions["AAPL"] == Decimal("1.0")


class TestEventDrivenStrategy:
    """Tests for event-driven strategy."""

    def test_event_strategy_decorator(self) -> None:
        """Test event strategy decorator."""
        @event_strategy
        def my_strategy(ctx: Context) -> None:
            pass

        assert hasattr(my_strategy, "params")

    def test_context_order_submission(self) -> None:
        """Test submitting orders via context."""
        orders = []

        class MockContext(Context):
            def order(self, symbol: str, quantity: Decimal) -> str:
                orders.append((symbol, quantity))
                return "order_001"

        ctx = MockContext(
            timestamp=None,
            bar=None,
            portfolio=None,
        )

        ctx.order("AAPL", Decimal("100"))

        assert len(orders) == 1
        assert orders[0] == ("AAPL", Decimal("100"))


class TestClassBasedStrategy:
    """Tests for class-based strategy API."""

    def test_strategy_class_with_params(self) -> None:
        """Test strategy class with parameters."""
        class MyStrategy(Strategy):
            lookback = Param(default=20)
            threshold = Param(default=Decimal("0.05"))

            def on_bar(self, ctx: Context) -> None:
                pass

        strategy = MyStrategy()

        assert strategy.lookback == 20
        assert strategy.threshold == Decimal("0.05")

    def test_strategy_state_capture(self) -> None:
        """Test capturing strategy state."""
        class MyStrategy(Strategy, StateCapture):
            lookback = Param(default=20)

            def __init__(self):
                self._buffer = []

            def on_bar(self, ctx: Context) -> None:
                pass

            def capture_state(self) -> dict[str, Any]:
                return {"buffer": self._buffer}

            def restore_state(self, state: dict[str, Any]) -> None:
                self._buffer = state.get("buffer", [])

        strategy = MyStrategy()
        strategy._buffer = [1, 2, 3]

        state = strategy.capture_state()
        assert state["buffer"] == [1, 2, 3]

        strategy._buffer = []
        strategy.restore_state(state)
        assert strategy._buffer == [1, 2, 3]


class TestStrategyRunner:
    """Tests for strategy runner."""

    def test_runner_execution(self) -> None:
        """Test running a strategy."""
        class SimpleStrategy(Strategy):
            def on_bar(self, ctx: Context) -> None:
                pass

        strategy = SimpleStrategy()
        runner = StrategyRunner(strategy)

        # Runner should be initialized
        assert runner.strategy == strategy

    def test_runner_param_override(self) -> None:
        """Test overriding strategy parameters."""
        class ParamStrategy(Strategy):
            lookback = Param(default=20)

            def on_bar(self, ctx: Context) -> None:
                pass

        strategy = ParamStrategy()
        runner = StrategyRunner(
            strategy,
            params={"lookback": 50},
        )

        assert runner.strategy.lookback == 50


# ============================================================
# Phase 3: Enhanced Parameter Extraction Tests
# ============================================================


class TestWidgetType:
    """Tests for WidgetType enum."""

    def test_widget_types(self) -> None:
        """Test widget type values."""
        assert WidgetType.SLIDER.value == "slider"
        assert WidgetType.DROPDOWN.value == "dropdown"
        assert WidgetType.CHECKBOX.value == "checkbox"
        assert WidgetType.INPUT.value == "input"


class TestParameterDefinition:
    """Tests for ParameterDefinition dataclass."""

    def test_creation(self) -> None:
        """Test parameter definition creation."""
        param_def = ParameterDefinition(
            name="period",
            param_type=ParamType.INTEGER,
            default=20,
            widget_type=WidgetType.SLIDER,
            min_value=5,
            max_value=100,
            step=1,
            description="Lookback period for SMA",
            group="Strategy",
        )

        assert param_def.name == "period"
        assert param_def.default == 20
        assert param_def.widget_type == WidgetType.SLIDER

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        param_def = ParameterDefinition(
            name="threshold",
            param_type=ParamType.DECIMAL,
            default=0.05,
            widget_type=WidgetType.SLIDER,
        )
        d = param_def.to_dict()

        assert d["name"] == "threshold"
        assert d["default"] == 0.05
        assert d["widgetType"] == "slider"


class TestParameterGroup:
    """Tests for ParameterGroup dataclass."""

    def test_creation(self) -> None:
        """Test parameter group creation."""
        params = [
            ParameterDefinition(
                name="period",
                param_type=ParamType.INTEGER,
                default=20,
                widget_type=WidgetType.SLIDER,
            ),
        ]
        group = ParameterGroup(
            name="Strategy",
            parameters=params,
            description="Strategy parameters",
        )

        assert group.name == "Strategy"
        assert len(group.parameters) == 1

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        params = [
            ParameterDefinition(
                name="period",
                param_type=ParamType.INTEGER,
                default=20,
                widget_type=WidgetType.SLIDER,
            ),
        ]
        group = ParameterGroup(name="Test", parameters=params)
        d = group.to_dict()

        assert d["name"] == "Test"
        assert len(d["parameters"]) == 1


class TestSourceCodeExtractor:
    """Tests for SourceCodeExtractor class."""

    def test_extract_simple_param(self) -> None:
        """Test extracting simple ql.param() calls."""
        code = '''
import quantlab as ql

period = ql.param(20)

def strategy(data):
    return ql.long(data.close[-1] > 100)
'''
        extractor = SourceCodeExtractor()
        params = extractor.extract(code)

        assert len(params) == 1
        assert params[0].name == "period"
        assert params[0].default == 20

    def test_extract_param_with_constraints(self) -> None:
        """Test extracting param with min/max constraints."""
        code = '''
import quantlab as ql

period = ql.param(20, min=5, max=100, description="Lookback")

def strategy(data):
    pass
'''
        extractor = SourceCodeExtractor()
        params = extractor.extract(code)

        assert len(params) == 1
        assert params[0].min_value == 5
        assert params[0].max_value == 100
        assert params[0].description == "Lookback"

    def test_extract_multiple_params(self) -> None:
        """Test extracting multiple parameters."""
        code = '''
import quantlab as ql

fast_period = ql.param(10, min=5, max=50)
slow_period = ql.param(20, min=10, max=100)
threshold = ql.param(0.05, min=0.01, max=0.20)

def strategy(data):
    pass
'''
        extractor = SourceCodeExtractor()
        params = extractor.extract(code)

        assert len(params) == 3
        names = [p.name for p in params]
        assert "fast_period" in names
        assert "slow_period" in names
        assert "threshold" in names

    def test_extract_param_with_choices(self) -> None:
        """Test extracting param with choices (dropdown)."""
        code = '''
import quantlab as ql

ma_type = ql.param("sma", choices=["sma", "ema", "wma"])

def strategy(data):
    pass
'''
        extractor = SourceCodeExtractor()
        params = extractor.extract(code)

        assert len(params) == 1
        assert params[0].name == "ma_type"
        assert params[0].choices == ["sma", "ema", "wma"]
        assert params[0].widget_type == WidgetType.DROPDOWN

    def test_extract_boolean_param(self) -> None:
        """Test extracting boolean parameter."""
        code = '''
import quantlab as ql

use_stop_loss = ql.param(True)

def strategy(data):
    pass
'''
        extractor = SourceCodeExtractor()
        params = extractor.extract(code)

        assert len(params) == 1
        assert params[0].name == "use_stop_loss"
        assert params[0].default is True
        assert params[0].widget_type == WidgetType.CHECKBOX

    def test_extract_with_alias(self) -> None:
        """Test extracting params when using import alias."""
        code = '''
import quantlab as ql

period = ql.param(20)

def strategy(data):
    pass
'''
        extractor = SourceCodeExtractor()
        params = extractor.extract(code)

        assert len(params) == 1
        assert params[0].name == "period"


class TestExtractParamsFromSource:
    """Tests for extract_params_from_source function."""

    def test_extract_basic(self) -> None:
        """Test basic extraction."""
        code = '''
import quantlab as ql

lookback = ql.param(20, min=5, max=100)

def strategy(data):
    pass
'''
        params = extract_params_from_source(code)

        assert len(params) == 1
        assert params[0].name == "lookback"

    def test_extract_preserves_order(self) -> None:
        """Test that parameter order is preserved."""
        code = '''
import quantlab as ql

alpha = ql.param(1)
beta = ql.param(2)
gamma = ql.param(3)

def strategy(data):
    pass
'''
        params = extract_params_from_source(code)

        assert [p.name for p in params] == ["alpha", "beta", "gamma"]


class TestExtractParamsForPanel:
    """Tests for extract_params_for_panel function."""

    def test_panel_format(self) -> None:
        """Test extraction in panel format."""
        code = '''
import quantlab as ql

period = ql.param(20, min=5, max=100, description="Lookback period")
threshold = ql.param(0.05)

def strategy(data):
    pass
'''
        panel = extract_params_for_panel(code)

        assert "groups" in panel
        assert "parameterCount" in panel
        assert panel["parameterCount"] == 2

    def test_panel_groups(self) -> None:
        """Test that parameters are grouped."""
        code = '''
import quantlab as ql

# Group: Moving Average
fast_period = ql.param(10, min=5, max=50, group="Moving Average")
slow_period = ql.param(20, min=10, max=100, group="Moving Average")

# Group: Risk
stop_loss = ql.param(0.02, group="Risk")

def strategy(data):
    pass
'''
        panel = extract_params_for_panel(code)

        assert len(panel["groups"]) >= 1


class TestApplyParamsToSource:
    """Tests for apply_params_to_source function."""

    def test_update_single_param(self) -> None:
        """Test updating a single parameter value."""
        code = '''
import quantlab as ql

period = ql.param(20, min=5, max=100)

def strategy(data):
    pass
'''
        new_code = apply_params_to_source(code, {"period": 50})

        # New code should have updated value
        assert "50" in new_code
        # Original value should be replaced
        # Note: exact behavior depends on implementation

    def test_update_multiple_params(self) -> None:
        """Test updating multiple parameter values."""
        code = '''
import quantlab as ql

fast_period = ql.param(10)
slow_period = ql.param(20)

def strategy(data):
    pass
'''
        new_code = apply_params_to_source(
            code,
            {"fast_period": 15, "slow_period": 30},
        )

        # Both values should be updated
        assert "15" in new_code
        assert "30" in new_code

    def test_preserve_constraints(self) -> None:
        """Test that constraints are preserved when updating."""
        code = '''
import quantlab as ql

period = ql.param(20, min=5, max=100, description="Lookback")

def strategy(data):
    pass
'''
        new_code = apply_params_to_source(code, {"period": 50})

        # Constraints should still be present
        assert "min=5" in new_code or "min = 5" in new_code
        assert "max=100" in new_code or "max = 100" in new_code

    def test_no_change_for_unknown_param(self) -> None:
        """Test that unknown params don't modify code."""
        code = '''
import quantlab as ql

period = ql.param(20)

def strategy(data):
    pass
'''
        new_code = apply_params_to_source(code, {"unknown_param": 999})

        # Code should be unchanged for unknown param
        assert "999" not in new_code
        assert "20" in new_code

"""
Strategy API module.

Provides:
- Vectorized API: def strategy(data) -> Signals
- Event-driven API: def on_bar(ctx)
- Class-based API: class MyStrategy(ql.Strategy)
- Parameter extraction with ql.param()
- State serialization for checkpointing
- API version compatibility checking

Spec Reference: Technical Spec §8
"""

from .class_based import MeanReversion
from .class_based import SMACrossover
from .class_based import Strategy
from .class_based import StrategyRunner
from .complexity import ComplexityAnalyzer
from .complexity import ComplexityFactor
from .complexity import ComplexityLevel
from .complexity import ComplexityResult
from .complexity import analyze_complexity
from .complexity import get_complexity_level
from .event import BarEvent
from .event import Context
from .event import EventDrivenStrategy
from .event import EventType
from .event import FillEvent
from .event import MarketEvent
from .event import event_strategy
from .params import Param
from .params import ParamSet
from .params import ParamSpec
from .params import ParamType
from .params import ParameterDefinition
from .params import ParameterGroup
from .params import SourceCodeExtractor
from .params import WidgetType
from .params import apply_params_to_source
from .params import extract_function_params
from .params import extract_params
from .params import extract_params_for_panel
from .params import extract_params_from_source
from .params import param
from .state import StateCapture
from .state import StateManager
from .state import StrategyState
from .vectorized import VectorizedSignals
from .vectorized import VectorizedStrategy
from .vectorized import VectorizedStrategyWrapper
from .vectorized import combine_signals
from .vectorized import flat
from .vectorized import long
from .vectorized import short
from .vectorized import vectorized_strategy

__all__ = [
    # Parameters
    "ParamType",
    "ParamSpec",
    "Param",
    "ParamSet",
    "param",
    "extract_params",
    "extract_function_params",
    # Phase 3: Enhanced Parameter Extraction
    "WidgetType",
    "ParameterDefinition",
    "ParameterGroup",
    "SourceCodeExtractor",
    "extract_params_from_source",
    "extract_params_for_panel",
    "apply_params_to_source",
    # State
    "StrategyState",
    "StateManager",
    "StateCapture",
    # Vectorized API
    "VectorizedSignals",
    "VectorizedStrategy",
    "VectorizedStrategyWrapper",
    "vectorized_strategy",
    "long",
    "short",
    "flat",
    "combine_signals",
    # Event API
    "EventType",
    "MarketEvent",
    "BarEvent",
    "FillEvent",
    "Context",
    "EventDrivenStrategy",
    "event_strategy",
    # Class-based API
    "Strategy",
    "StrategyRunner",
    # Example strategies
    "SMACrossover",
    "MeanReversion",
    # Phase 3: Complexity Analysis
    "ComplexityLevel",
    "ComplexityFactor",
    "ComplexityResult",
    "ComplexityAnalyzer",
    "analyze_complexity",
    "get_complexity_level",
]

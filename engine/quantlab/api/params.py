"""
Strategy Parameter System.

Provides parameter definition, extraction, and validation.

Spec Reference: Technical Spec §8.1, Phase 3 Chart View MVP
"""

import ast
import inspect
import re
from dataclasses import dataclass
from dataclasses import field
from decimal import Decimal
from enum import Enum
from typing import Any
from typing import Callable
from typing import Generic
from typing import TypeVar
from typing import get_type_hints


T = TypeVar("T")

# Runtime overrides for function-based strategies.
# Populated by the backtest runner before executing the strategy function
# and cleared afterward.  Keyed by the ``id`` argument of ``ql.param()``.
_param_overrides: dict[str, Any] = {}


def set_param_overrides(overrides: dict[str, Any]) -> None:
    """Install parameter overrides for the current backtest run."""
    _param_overrides.clear()
    _param_overrides.update(overrides)


def clear_param_overrides() -> None:
    """Remove all parameter overrides."""
    _param_overrides.clear()


class ParamType(Enum):
    """Parameter types."""

    INT = "int"
    INTEGER = "int"  # Alias for test compatibility
    FLOAT = "float"
    DECIMAL = "decimal"
    BOOL = "bool"
    BOOLEAN = "bool"  # Alias for test compatibility
    STRING = "string"
    LIST = "list"
    CHOICE = "choice"
    RANGE = "range"


@dataclass
class ParamSpec:
    """
    Parameter specification.

    Defines a strategy parameter with validation rules.
    """

    name: str
    param_type: ParamType
    default: Any
    description: str = ""
    min_value: Any = None
    max_value: Any = None
    choices: list[Any] | None = None
    step: Any = None  # For optimization
    required: bool = False
    group: str | None = None  # For UI grouping

    def validate(self, value: Any) -> bool:
        """
        Validate a value against this spec.

        Returns:
            True if valid, False otherwise
        """
        # Type validation
        if self.param_type in (ParamType.INT, ParamType.INTEGER):
            if not isinstance(value, int) or isinstance(value, bool):
                return False
        elif self.param_type == ParamType.FLOAT:
            if not isinstance(value, (int, float)):
                return False
        elif self.param_type == ParamType.DECIMAL:
            if not isinstance(value, (int, float, Decimal)):
                return False
        elif self.param_type in (ParamType.BOOL, ParamType.BOOLEAN):
            if not isinstance(value, bool):
                return False
        elif self.param_type == ParamType.STRING:
            if not isinstance(value, str):
                return False
        elif self.param_type == ParamType.LIST:
            if not isinstance(value, list):
                return False
        elif self.param_type == ParamType.CHOICE:
            if self.choices and value not in self.choices:
                return False

        # Range validation
        if self.min_value is not None and value < self.min_value:
            return False

        if self.max_value is not None and value > self.max_value:
            return False

        return True

    def validate_with_message(self, value: Any) -> tuple[bool, str]:
        """
        Validate a value against this spec with error message.

        Returns:
            Tuple of (is_valid, error_message)
        """
        # Type validation
        if self.param_type in (ParamType.INT, ParamType.INTEGER):
            if not isinstance(value, int) or isinstance(value, bool):
                return False, f"{self.name} must be an integer"
        elif self.param_type == ParamType.FLOAT:
            if not isinstance(value, (int, float)):
                return False, f"{self.name} must be a number"
        elif self.param_type == ParamType.DECIMAL:
            if not isinstance(value, (int, float, Decimal)):
                return False, f"{self.name} must be a number"
        elif self.param_type in (ParamType.BOOL, ParamType.BOOLEAN):
            if not isinstance(value, bool):
                return False, f"{self.name} must be a boolean"
        elif self.param_type == ParamType.STRING:
            if not isinstance(value, str):
                return False, f"{self.name} must be a string"
        elif self.param_type == ParamType.LIST:
            if not isinstance(value, list):
                return False, f"{self.name} must be a list"
        elif self.param_type == ParamType.CHOICE:
            if self.choices and value not in self.choices:
                return False, f"{self.name} must be one of {self.choices}"

        # Range validation
        if self.min_value is not None and value < self.min_value:
            return False, f"{self.name} must be >= {self.min_value}"

        if self.max_value is not None and value > self.max_value:
            return False, f"{self.name} must be <= {self.max_value}"

        return True, ""

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "type": self.param_type.value,
            "default": self.default,
            "description": self.description,
            "min": self.min_value,
            "max": self.max_value,
            "choices": self.choices,
            "step": self.step,
            "required": self.required,
            "group": self.group,
        }


class Param(Generic[T]):
    """
    Parameter descriptor.

    Use with ql.param() to define strategy parameters.

    Example:
        class MyStrategy:
            lookback = ql.param(20, min=5, max=100)
            threshold = ql.param(0.5, min=0, max=1)
    """

    def __init__(
        self,
        default: T,
        *,
        min: Any = None,
        max: Any = None,
        choices: list[Any] | None = None,
        step: Any = None,
        description: str = "",
        group: str | None = None,
    ) -> None:
        """
        Define a parameter.

        Args:
            default: Default value
            min: Minimum value
            max: Maximum value
            choices: Allowed values
            step: Step size for optimization
            description: Human-readable description
            group: UI grouping
        """
        self.default = default
        self.min_value = min
        self.max_value = max
        self.min = min  # Alias for test compatibility
        self.max = max  # Alias for test compatibility
        self.choices = choices
        self.step = step
        self.description = description
        self.group = group

        # Infer type from default
        if isinstance(default, bool):
            self.param_type = ParamType.BOOL
        elif isinstance(default, int):
            self.param_type = ParamType.INT
        elif isinstance(default, float):
            self.param_type = ParamType.FLOAT
        elif isinstance(default, Decimal):
            self.param_type = ParamType.DECIMAL
        elif isinstance(default, str):
            self.param_type = ParamType.STRING
        elif isinstance(default, list):
            self.param_type = ParamType.LIST
        elif choices:
            self.param_type = ParamType.CHOICE
        else:
            self.param_type = ParamType.STRING

        self._name: str = ""
        self._storage_name: str = ""

    def __set_name__(self, owner: type, name: str) -> None:
        """Store the attribute name."""
        self._name = name
        # FIX-M3: Store on instance __dict__ instead of descriptor-level dict
        # keyed by id(obj), which leaks memory when instances are GC'd.
        self._storage_name = f"_param_{name}"

    def __get__(self, obj: Any, objtype: type | None = None) -> T:
        """Get parameter value."""
        if obj is None:
            return self  # type: ignore

        return obj.__dict__.get(self._storage_name, self.default)

    def __set__(self, obj: Any, value: T) -> None:
        """Set parameter value with validation."""
        # Validate against min/max constraints
        if self.min_value is not None and value < self.min_value:
            raise ValueError(
                f"{self._name} must be >= {self.min_value}, got {value}"
            )
        if self.max_value is not None and value > self.max_value:
            raise ValueError(
                f"{self._name} must be <= {self.max_value}, got {value}"
            )
        if self.choices is not None and value not in self.choices:
            raise ValueError(
                f"{self._name} must be one of {self.choices}, got {value}"
            )
        obj.__dict__[self._storage_name] = value

    def get_spec(self, name: str | None = None) -> ParamSpec:
        """Get parameter specification."""
        return ParamSpec(
            name=name or self._name,
            param_type=self.param_type,
            default=self.default,
            description=self.description,
            min_value=self.min_value,
            max_value=self.max_value,
            choices=self.choices,
            step=self.step,
            group=self.group,
        )


def param(
    default_or_id: T = None,
    *,
    default: T = None,
    min: Any = None,
    max: Any = None,
    choices: list[Any] | None = None,
    step: Any = None,
    description: str = "",
    group: str | None = None,
    # Accept extra UI kwargs without breaking
    id: str | None = None,
    name: str | None = None,
    **_extra_kwargs,
) -> T:
    """
    Define a strategy parameter.

    Convenience function for creating Param instances.

    Supports both engine-style and UI-style calling conventions:
        # Engine style
        lookback = param(20, min=5, max=100)

        # UI style (id-first, default as kwarg)
        lookback = param(id="lookback", default=20, min=5, max=100, name="Lookback")

    When called from a strategy function (not as class descriptor),
    returns the default value directly for immediate use.
    """
    # Resolve the three calling conventions to (id, value):
    #   1. Engine style:        param(20, min=5, max=100)            -> value=20
    #   2. UI style:            param(id="x", default=20, ...)       -> id="x", value=20
    #   3. Id-first positional: param("fast", default=10, ...)       -> id="fast", value=10
    #      (the shape the IDE's parameter extractor and AI-generated strategies use;
    #      a genuinely-string default still works because it arrives WITHOUT `default=`)
    if id is None and isinstance(default_or_id, str) and default is not None:
        id = default_or_id
        value = default
    elif default is not None:
        value = default
    else:
        value = default_or_id

    # When an id is known, it's being used inside a strategy function body.
    # Check for runtime overrides first, then fall back to the default value.
    if id is not None:
        if id in _param_overrides:
            return _param_overrides[id]  # type: ignore
        return value  # type: ignore

    # Otherwise, return a Param descriptor for class-based strategy usage
    # (e.g., lookback = param(20, min=5, max=100))
    return Param(
        value,
        min=min,
        max=max,
        choices=choices,
        step=step,
        description=description,
        group=group,
    )  # type: ignore


def extract_params(obj: Any) -> dict[str, ParamSpec]:
    """
    Extract parameter specifications from an object.

    Args:
        obj: Strategy instance or class

    Returns:
        Dictionary of parameter name -> ParamSpec
    """
    params = {}

    # Check class attributes
    cls = obj if isinstance(obj, type) else type(obj)

    for name, attr in vars(cls).items():
        if isinstance(attr, Param):
            params[name] = attr.get_spec(name)

    return params


def extract_function_params(func: Callable) -> dict[str, ParamSpec]:
    """
    Extract parameters from function signature.

    Args:
        func: Function to analyze

    Returns:
        Dictionary of parameter name -> ParamSpec
    """
    params = {}
    sig = inspect.signature(func)

    for name, param_obj in sig.parameters.items():
        if name in ("self", "data", "ctx", "context"):
            continue

        default = param_obj.default
        if default is inspect.Parameter.empty:
            default = None

        # Infer type from annotation
        annotation = param_obj.annotation
        if annotation is inspect.Parameter.empty:
            if default is not None:
                if isinstance(default, bool):
                    param_type = ParamType.BOOL
                elif isinstance(default, int):
                    param_type = ParamType.INT
                elif isinstance(default, float):
                    param_type = ParamType.FLOAT
                else:
                    param_type = ParamType.STRING
            else:
                param_type = ParamType.STRING
        elif annotation == int:
            param_type = ParamType.INT
        elif annotation == float:
            param_type = ParamType.FLOAT
        elif annotation == bool:
            param_type = ParamType.BOOL
        elif annotation == str:
            param_type = ParamType.STRING
        else:
            param_type = ParamType.STRING

        params[name] = ParamSpec(
            name=name,
            param_type=param_type,
            default=default,
            required=default is None,
        )

    return params


class ParamSet:
    """
    Collection of parameter values.

    Stores and validates a set of parameter values.
    """

    def __init__(
        self,
        specs: dict[str, ParamSpec] | None = None,
        values: dict[str, Any] | None = None,
        *,
        params: dict[str, Any] | None = None,
    ) -> None:
        """
        Initialize parameter set.

        Args:
            specs: Parameter specifications
            values: Initial values (uses defaults if not provided)
            params: Direct parameter values (alternative to specs/values)
        """
        self._specs = specs or {}
        self._values: dict[str, Any] = {}

        # If params is provided directly, use that
        if params is not None:
            self._values = dict(params)
        else:
            # Set defaults from specs
            for name, spec in self._specs.items():
                self._values[name] = spec.default

            # Override with provided values
            if values:
                for name, value in values.items():
                    if name in self._specs:
                        self._values[name] = value

    def get(self, name: str, default: Any = None) -> Any:
        """Get parameter value."""
        return self._values.get(name, default)

    def __getitem__(self, name: str) -> Any:
        """Get parameter value."""
        return self._values.get(name)

    def __setitem__(self, name: str, value: Any) -> None:
        """Set parameter value."""
        if self._specs and name not in self._specs:
            raise KeyError(f"Unknown parameter: {name}")

        if name in self._specs:
            spec = self._specs[name]
            is_valid = spec.validate(value)
            if not is_valid:
                raise ValueError(f"Invalid value for {name}")

        self._values[name] = value

    def validate(self, specs: dict[str, ParamSpec] | None = None) -> bool:
        """
        Validate all parameters against specs.

        Args:
            specs: Parameter specifications to validate against

        Returns:
            True if all values are valid
        """
        check_specs = specs or self._specs

        for name, spec in check_specs.items():
            value = self._values.get(name)

            if spec.required and value is None:
                return False

            if value is not None:
                if not spec.validate(value):
                    return False

        return True

    def validate_with_errors(self) -> list[str]:
        """
        Validate all parameters and return errors.

        Returns:
            List of validation errors (empty if valid)
        """
        errors = []

        for name, spec in self._specs.items():
            value = self._values.get(name)

            if spec.required and value is None:
                errors.append(f"{name} is required")
                continue

            if value is not None:
                is_valid, error = spec.validate_with_message(value)
                if not is_valid:
                    errors.append(error)

        return errors

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return self._values.copy()

    @classmethod
    def from_dict(
        cls,
        specs: dict[str, ParamSpec],
        data: dict[str, Any],
    ) -> "ParamSet":
        """Create from dictionary."""
        return cls(specs, data)


# Backward compatibility re-exports (FIX-M7: canonical definitions in state.py)
from quantlab.api.state import StrategyState  # noqa: F401
from quantlab.api.state import StateManager  # noqa: F401


# =============================================================================
# Phase 3: UI Widget Types for Chart Parameter Panel
# =============================================================================


class WidgetType(Enum):
    """UI widget types for parameter panel."""

    SLIDER = "slider"
    DROPDOWN = "dropdown"
    CHECKBOX = "checkbox"
    INPUT = "input"
    COLOR_PICKER = "colorPicker"
    DATE_PICKER = "datePicker"


@dataclass
class ParameterDefinition:
    """
    Full parameter definition for Chart Panel.

    Extended version of ParamSpec with UI-specific metadata.
    """

    name: str
    param_type: ParamType
    default: Any
    widget_type: WidgetType
    description: str = ""
    min_value: Any = None
    max_value: Any = None
    choices: list[Any] | None = None
    step: Any = None
    group: str = "Parameters"
    order: int = 0
    visible: bool = True
    enabled: bool = True
    unit: str | None = None  # e.g., "days", "$", "%"
    display_name: str | None = None  # Human-readable name
    placeholder: str | None = None  # Input placeholder
    line_number: int | None = None  # Source line number

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "name": self.name,
            "type": self.param_type.value,
            "default": self._serialize_value(self.default),
            "widgetType": self.widget_type.value,
            "description": self.description,
            "min": self._serialize_value(self.min_value),
            "max": self._serialize_value(self.max_value),
            "choices": self.choices,
            "step": self._serialize_value(self.step),
            "group": self.group,
        }

    def to_panel_dict(self) -> dict[str, Any]:
        """Convert to dictionary for parameter panel."""
        return {
            "name": self.name,
            "displayName": self.display_name or self.name,
            "type": self.param_type.value,
            "widget": self.widget_type.value,
            "default": self._serialize_value(self.default),
            "description": self.description,
            "min": self._serialize_value(self.min_value),
            "max": self._serialize_value(self.max_value),
            "choices": self.choices,
            "step": self._serialize_value(self.step),
            "group": self.group,
            "order": self.order,
            "visible": self.visible,
            "enabled": self.enabled,
            "unit": self.unit,
            "placeholder": self.placeholder,
            "lineNumber": self.line_number,
        }

    def _serialize_value(self, value: Any) -> Any:
        """Serialize a value for JSON."""
        if isinstance(value, Decimal):
            return float(value)
        return value

    @classmethod
    def infer_widget_type(cls, param_type: ParamType, choices: list | None = None) -> WidgetType:
        """Infer widget type from parameter type."""
        if choices:
            return WidgetType.DROPDOWN
        elif param_type == ParamType.BOOL:
            return WidgetType.CHECKBOX
        elif param_type in (ParamType.INT, ParamType.FLOAT, ParamType.DECIMAL):
            return WidgetType.SLIDER
        elif param_type == ParamType.STRING:
            return WidgetType.INPUT
        else:
            return WidgetType.INPUT


@dataclass
class ParameterGroup:
    """Group of related parameters."""

    name: str
    parameters: list[ParameterDefinition]
    description: str = ""
    collapsed: bool = False
    order: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "name": self.name,
            "parameters": [p.to_dict() for p in self.parameters],
            "description": self.description,
            "collapsed": self.collapsed,
            "order": self.order,
        }


class SourceCodeExtractor:
    """
    Extract ql.param() calls from strategy source code.

    Uses AST parsing to find parameter definitions with full metadata.
    """

    # Pattern for ql.param() or param() calls
    PARAM_PATTERNS = [
        r"(\w+)\s*=\s*(?:ql\.)?param\s*\(",
    ]

    def __init__(self) -> None:
        """Initialize extractor."""
        self._patterns = [re.compile(p) for p in self.PARAM_PATTERNS]

    def extract(self, source: str) -> list[ParameterDefinition]:
        """
        Extract parameters from source code.

        Args:
            source: Strategy source code

        Returns:
            List of ParameterDefinition objects
        """
        return self.extract_from_source(source)

    def extract_from_source(self, source: str) -> list[ParameterDefinition]:
        """
        Extract parameters from source code.

        Args:
            source: Strategy source code

        Returns:
            List of ParameterDefinition objects
        """
        parameters = []

        try:
            tree = ast.parse(source)
        except SyntaxError:
            return parameters

        # Find all param() calls
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                param_def = self._extract_from_assignment(node, source)
                if param_def:
                    parameters.append(param_def)

        return parameters

    def _extract_from_assignment(
        self,
        node: ast.Assign,
        source: str,
    ) -> ParameterDefinition | None:
        """Extract parameter from an assignment node."""
        # Get target name
        if not node.targets or not isinstance(node.targets[0], ast.Name):
            return None

        name = node.targets[0].id

        # Check if value is a param() call
        if not isinstance(node.value, ast.Call):
            return None

        func = node.value.func

        # Check for param() or ql.param()
        is_param_call = False
        if isinstance(func, ast.Name) and func.id == "param":
            is_param_call = True
        elif isinstance(func, ast.Attribute):
            if func.attr == "param":
                is_param_call = True

        if not is_param_call:
            return None

        # Extract call arguments
        call = node.value
        kwargs = self._extract_call_kwargs(call)

        # Get default value (first positional arg)
        default = None
        if call.args:
            default = self._eval_literal(call.args[0])

        if default is None:
            default = kwargs.get("default")

        if default is None:
            return None

        # Infer type
        param_type = self._infer_type(default, kwargs.get("choices"))

        # Infer widget type
        widget_type = ParameterDefinition.infer_widget_type(
            param_type,
            kwargs.get("choices"),
        )

        return ParameterDefinition(
            name=name,
            param_type=param_type,
            default=default,
            widget_type=widget_type,
            description=kwargs.get("description", ""),
            min_value=kwargs.get("min"),
            max_value=kwargs.get("max"),
            choices=kwargs.get("choices"),
            step=kwargs.get("step"),
            group=kwargs.get("group", "Parameters"),
            line_number=node.lineno,
        )

    def _extract_call_kwargs(self, call: ast.Call) -> dict[str, Any]:
        """Extract keyword arguments from a call."""
        kwargs = {}

        for keyword in call.keywords:
            if keyword.arg:
                value = self._eval_literal(keyword.value)
                kwargs[keyword.arg] = value

        return kwargs

    def _eval_literal(self, node: ast.expr) -> Any:
        """Safely evaluate an AST literal."""
        try:
            if isinstance(node, ast.Constant):
                return node.value
            elif isinstance(node, ast.Num):  # Python 3.7 compatibility
                return node.n
            elif isinstance(node, ast.Str):  # Python 3.7 compatibility
                return node.s
            elif isinstance(node, ast.NameConstant):  # Python 3.7 compatibility
                return node.value
            elif isinstance(node, ast.List):
                return [self._eval_literal(e) for e in node.elts]
            elif isinstance(node, ast.Tuple):
                return tuple(self._eval_literal(e) for e in node.elts)
            elif isinstance(node, ast.Dict):
                keys = [self._eval_literal(k) for k in node.keys if k is not None]
                values = [self._eval_literal(v) for v in node.values]
                return dict(zip(keys, values))
            elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
                value = self._eval_literal(node.operand)
                if isinstance(value, (int, float)):
                    return -value
            elif isinstance(node, ast.Call):
                # Handle Decimal("...")
                if isinstance(node.func, ast.Name) and node.func.id == "Decimal":
                    if node.args:
                        arg = self._eval_literal(node.args[0])
                        if isinstance(arg, str):
                            return Decimal(arg)
            return None
        except Exception:
            return None

    def _infer_type(self, default: Any, choices: list | None = None) -> ParamType:
        """Infer parameter type from default value."""
        if choices:
            return ParamType.CHOICE
        elif isinstance(default, bool):
            return ParamType.BOOL
        elif isinstance(default, int):
            return ParamType.INT
        elif isinstance(default, float):
            return ParamType.FLOAT
        elif isinstance(default, Decimal):
            return ParamType.DECIMAL
        elif isinstance(default, str):
            return ParamType.STRING
        elif isinstance(default, list):
            return ParamType.LIST
        else:
            return ParamType.STRING


def extract_params_from_source(source: str) -> list[ParameterDefinition]:
    """
    Extract parameter definitions from strategy source code.

    Args:
        source: Strategy source code

    Returns:
        List of ParameterDefinition objects
    """
    extractor = SourceCodeExtractor()
    return extractor.extract_from_source(source)


def extract_params_for_panel(source: str) -> dict[str, Any]:
    """
    Extract parameters formatted for Chart Parameter Panel.

    Args:
        source: Strategy source code

    Returns:
        Dictionary with groups and parameters for UI
    """
    params = extract_params_from_source(source)

    # Group parameters
    groups: dict[str, list[ParameterDefinition]] = {}
    for param in params:
        group_name = param.group or "Parameters"
        if group_name not in groups:
            groups[group_name] = []
        groups[group_name].append(param)

    # Sort within groups
    for group_params in groups.values():
        group_params.sort(key=lambda p: (p.order, p.name))

    # Build output structure
    result = {
        "groups": [
            {
                "name": group_name,
                "parameters": [p.to_panel_dict() for p in group_params],
            }
            for group_name, group_params in sorted(groups.items())
        ],
        "parameterCount": len(params),
    }

    return result


def apply_params_to_source(
    source: str,
    param_values: dict[str, Any],
) -> str:
    """
    Apply parameter value changes to source code.

    Args:
        source: Original source code
        param_values: Dictionary of param_name -> new_value

    Returns:
        Modified source code
    """
    # Use regex-based replacement for param() calls to preserve structure
    modified = source
    extractor = SourceCodeExtractor()
    params = extractor.extract_from_source(source)

    for name, new_value in param_values.items():
        for param in params:
            if param.name == name:
                # Format old and new values for regex
                old_val = repr(param.default) if isinstance(param.default, str) else str(param.default)
                new_val = repr(new_value) if isinstance(new_value, str) else str(new_value)

                # Pattern to match param() call with this name, capturing everything
                # Matches: name = ql.param(old_val, ...) or name = param(old_val, ...)
                # The key is to only replace the first argument while preserving the rest
                pattern = rf"({name}\s*=\s*(?:ql\.)?param\s*\(){old_val}(\s*[,)])"
                replacement = rf"\g<1>{new_val}\g<2>"
                modified = re.sub(pattern, replacement, modified)
                break

    return modified

"""
Strategy Validation (FIX-E002).

Validates strategy code before execution to catch common errors early.

Spec Reference: Technical Spec §3.4
"""

import ast
import inspect
import logging
from dataclasses import dataclass
from dataclasses import field
from typing import Any
from typing import Callable
from typing import Type


logger = logging.getLogger(__name__)


@dataclass
class ValidationResult:
    """Result of strategy validation."""

    valid: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "valid": self.valid,
            "errors": self.errors,
            "warnings": self.warnings,
        }


class StrategyValidator:
    """
    Validate strategy code before execution.

    Checks for:
    - Required methods (on_bar for class-based strategies)
    - Parameter types and defaults
    - Common mistakes (bare except, time.sleep, etc.)
    - Syntax errors
    """

    def validate(self, strategy: Any) -> ValidationResult:
        """
        Validate a strategy instance.

        Args:
            strategy: Strategy instance to validate

        Returns:
            ValidationResult with errors and warnings
        """
        errors: list[str] = []
        warnings: list[str] = []

        # Check required methods based on strategy type
        strategy_type = type(strategy).__name__

        if hasattr(strategy, "on_bar"):
            if not callable(getattr(strategy, "on_bar")):
                errors.append("Strategy.on_bar must be callable")
        elif hasattr(strategy, "on_event"):
            if not callable(getattr(strategy, "on_event")):
                errors.append("EventDrivenStrategy.on_event must be callable")
        else:
            errors.append(
                f"{strategy_type} must implement on_bar(ctx) or on_event(event, ctx)"
            )

        # Check parameters have valid defaults
        try:
            params = self._get_params(strategy)
            for name, value in params.items():
                if value is None:
                    warnings.append(f"Parameter '{name}' has None default")
        except Exception as e:
            warnings.append(f"Could not extract parameters: {e}")

        # Analyze source code for common mistakes
        try:
            source = inspect.getsource(type(strategy))
            source_warnings = self._analyze_source(source)
            warnings.extend(source_warnings)
        except (OSError, TypeError):
            # Source not available (e.g., built-in types)
            pass

        return ValidationResult(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
        )

    def validate_source(self, source_code: str) -> ValidationResult:
        """
        Validate strategy source code without instantiating.

        Args:
            source_code: Python source code

        Returns:
            ValidationResult with errors and warnings
        """
        errors: list[str] = []
        warnings: list[str] = []

        # Parse syntax
        try:
            tree = ast.parse(source_code)
        except SyntaxError as e:
            errors.append(f"Syntax error at line {e.lineno}: {e.msg}")
            return ValidationResult(valid=False, errors=errors, warnings=warnings)

        # Check for Strategy subclass
        has_strategy_class = False
        strategy_class_name = None

        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                for base in node.bases:
                    if isinstance(base, ast.Name) and base.id in (
                        "Strategy",
                        "EventDrivenStrategy",
                    ):
                        has_strategy_class = True
                        strategy_class_name = node.name
                        break
                    elif isinstance(base, ast.Attribute) and base.attr in (
                        "Strategy",
                        "EventDrivenStrategy",
                    ):
                        has_strategy_class = True
                        strategy_class_name = node.name
                        break

        if not has_strategy_class:
            errors.append("No Strategy or EventDrivenStrategy subclass found in source")
        else:
            # Check if on_bar or on_event method exists
            has_handler = False
            for node in ast.walk(tree):
                if isinstance(node, ast.FunctionDef) and node.name in ("on_bar", "on_event"):
                    has_handler = True
                    break
            if not has_handler:
                errors.append(f"Strategy '{strategy_class_name}' must implement on_bar() or on_event()")

        # Analyze for common mistakes
        source_warnings = self._analyze_source(source_code)
        warnings.extend(source_warnings)

        return ValidationResult(
            valid=len(errors) == 0,
            errors=errors,
            warnings=warnings,
        )

    def _analyze_source(self, source: str) -> list[str]:
        """Analyze source code for common mistakes."""
        warnings: list[str] = []

        try:
            tree = ast.parse(source)
        except SyntaxError:
            return warnings

        for node in ast.walk(tree):
            # Check for bare except clauses
            if isinstance(node, ast.ExceptHandler) and node.type is None:
                warnings.append(
                    f"Line {node.lineno}: Bare 'except:' clause may hide errors"
                )

            # Check for time.sleep (blocks event loop)
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Attribute) and node.func.attr == "sleep":
                    if isinstance(node.func.value, ast.Name) and node.func.value.id == "time":
                        warnings.append(
                            f"Line {node.lineno}: time.sleep() blocks event loop. "
                            "Use asyncio.sleep() in async code or avoid sleeping."
                        )

            # Check for global variables modification
            if isinstance(node, ast.Global):
                warnings.append(
                    f"Line {node.lineno}: Using 'global' keyword may cause state issues"
                )

            # Check for mutable default arguments
            if isinstance(node, ast.FunctionDef):
                for default in node.args.defaults:
                    if isinstance(default, (ast.List, ast.Dict, ast.Set)):
                        warnings.append(
                            f"Line {node.lineno}: Function '{node.name}' has mutable default argument"
                        )

        return warnings

    def _get_params(self, strategy: Any) -> dict[str, Any]:
        """Extract parameter values from strategy."""
        params: dict[str, Any] = {}

        # Check for params attribute or annotations
        if hasattr(strategy, "__annotations__"):
            for name in strategy.__annotations__:
                if not name.startswith("_"):
                    params[name] = getattr(strategy, name, None)

        return params


def validate_strategy(strategy: Any) -> ValidationResult:
    """Convenience function for strategy validation."""
    return StrategyValidator().validate(strategy)


def validate_strategy_source(source_code: str) -> ValidationResult:
    """Convenience function for source code validation."""
    return StrategyValidator().validate_source(source_code)

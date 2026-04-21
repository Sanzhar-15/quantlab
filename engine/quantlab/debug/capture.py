"""
Condition Capture for Time-Travel Debugger.

Captures condition evaluations during strategy execution for debugging.

This module provides:
- Instrumentation of strategy code to capture conditions
- Runtime capture of expression values
- Integration with backtest engine

Spec Reference: Technical Spec Section 19.3
"""

import ast
import logging
from dataclasses import dataclass
from dataclasses import field
from decimal import Decimal
from typing import Any
from typing import Callable

from .format import ConditionCapture


logger = logging.getLogger(__name__)


@dataclass
class CaptureContext:
    """Context for condition capture during execution."""

    bar_index: int = 0
    captures: list[ConditionCapture] = field(default_factory=list)
    enabled: bool = True
    max_captures_per_bar: int = 100


class ConditionCapturer:
    """
    Captures condition evaluations during strategy execution.

    This class instruments comparison operations to record their
    operands and results for the debugger.

    Usage:
        capturer = ConditionCapturer()

        # In the backtest loop
        capturer.set_bar_index(i)

        # Capture a condition
        result = capturer.capture(
            "fast_ma > slow_ma",
            fast_ma_value,
            ">",
            slow_ma_value,
            line_number=23
        )

        # Get captures for current bar
        conditions = capturer.get_captures()
    """

    def __init__(self, max_captures_per_bar: int = 100) -> None:
        """
        Initialize condition capturer.

        Args:
            max_captures_per_bar: Maximum conditions to capture per bar
        """
        self._context = CaptureContext(max_captures_per_bar=max_captures_per_bar)
        self._all_captures: dict[int, list[ConditionCapture]] = {}

    def set_bar_index(self, bar_index: int) -> None:
        """
        Set the current bar index.

        Saves previous captures and resets for new bar.

        Args:
            bar_index: Current bar index
        """
        # Save previous captures
        if self._context.captures:
            self._all_captures[self._context.bar_index] = list(self._context.captures)

        # Reset for new bar
        self._context.bar_index = bar_index
        self._context.captures = []

    @property
    def enabled(self) -> bool:
        """Check if capture is enabled."""
        return self._context.enabled

    @enabled.setter
    def enabled(self, value: bool) -> None:
        """Enable or disable capture."""
        self._context.enabled = value

    def capture(
        self,
        expression: str,
        left_value: Any,
        operator: str,
        right_value: Any,
        line_number: int = 0,
        context: dict[str, Any] | None = None,
    ) -> bool:
        """
        Capture a condition evaluation.

        Args:
            expression: The expression string (e.g., "fast_ma > slow_ma")
            left_value: Value of left operand
            operator: Comparison operator
            right_value: Value of right operand
            line_number: Source line number
            context: Additional context (variable names, etc.)

        Returns:
            The actual result of the comparison
        """
        # Evaluate the comparison
        result = self._evaluate(left_value, operator, right_value)

        if not self._context.enabled:
            return result

        if len(self._context.captures) >= self._context.max_captures_per_bar:
            return result

        # Format values for storage
        left_str = self._format_value(left_value)
        right_str = self._format_value(right_value)
        context_strs = {}
        if context:
            context_strs = {k: self._format_value(v) for k, v in context.items()}

        capture = ConditionCapture(
            bar_index=self._context.bar_index,
            line_number=line_number,
            expression=expression,
            left_value=left_str,
            operator=operator,
            right_value=right_str,
            result=result,
            context=context_strs,
        )

        self._context.captures.append(capture)

        return result

    def _evaluate(self, left: Any, operator: str, right: Any) -> bool:
        """Evaluate a comparison."""
        ops = {
            "<": lambda a, b: a < b,
            "<=": lambda a, b: a <= b,
            ">": lambda a, b: a > b,
            ">=": lambda a, b: a >= b,
            "==": lambda a, b: a == b,
            "!=": lambda a, b: a != b,
            "in": lambda a, b: a in b,
            "not in": lambda a, b: a not in b,
            "is": lambda a, b: a is b,
            "is not": lambda a, b: a is not b,
        }

        try:
            return ops.get(operator, lambda a, b: False)(left, right)
        except Exception:
            return False

    def _format_value(self, value: Any) -> str:
        """Format a value for display."""
        if isinstance(value, Decimal):
            return str(value)
        elif isinstance(value, float):
            return f"{value:.6f}"
        elif isinstance(value, (list, tuple)) and len(value) > 5:
            return f"[{len(value)} items]"
        elif isinstance(value, dict) and len(value) > 5:
            return f"{{{len(value)} items}}"
        else:
            return str(value)

    def get_captures(self, bar_index: int | None = None) -> list[ConditionCapture]:
        """
        Get captured conditions.

        Args:
            bar_index: Specific bar index, or None for current bar

        Returns:
            List of condition captures
        """
        if bar_index is None:
            return list(self._context.captures)

        if bar_index == self._context.bar_index:
            return list(self._context.captures)

        return self._all_captures.get(bar_index, [])

    def get_all_captures(self) -> dict[int, list[ConditionCapture]]:
        """Get all captured conditions indexed by bar."""
        # Include current bar
        result = dict(self._all_captures)
        if self._context.captures:
            result[self._context.bar_index] = list(self._context.captures)
        return result

    def clear(self) -> None:
        """Clear all captures."""
        self._all_captures.clear()
        self._context.captures = []

    def finalize(self) -> None:
        """Finalize captures (save current bar)."""
        if self._context.captures:
            self._all_captures[self._context.bar_index] = list(self._context.captures)


class ConditionInstrumentor(ast.NodeTransformer):
    """
    AST transformer to instrument conditions for capture.

    Transforms comparisons like:
        if fast_ma > slow_ma:

    Into:
        if __capture__("fast_ma > slow_ma", fast_ma, ">", slow_ma, 23):

    This allows the debugger to record all condition evaluations.
    """

    def __init__(self, capture_func_name: str = "__capture__") -> None:
        """
        Initialize instrumentor.

        Args:
            capture_func_name: Name of the capture function to inject
        """
        super().__init__()
        self._capture_func = capture_func_name
        self._in_condition = False

    def visit_Compare(self, node: ast.Compare) -> ast.AST:
        """Transform comparison expressions."""
        if not self._in_condition:
            return node

        # Only handle simple comparisons (one operator)
        if len(node.ops) != 1 or len(node.comparators) != 1:
            return self.generic_visit(node)

        left = node.left
        op = node.ops[0]
        right = node.comparators[0]

        # Get operator string
        op_str = self._op_to_str(op)
        if not op_str:
            return self.generic_visit(node)

        # Get expression string
        try:
            expr_str = ast.unparse(node)
        except Exception:
            expr_str = f"<comparison at line {node.lineno}>"

        # Create capture call
        return ast.Call(
            func=ast.Name(id=self._capture_func, ctx=ast.Load()),
            args=[
                ast.Constant(value=expr_str),
                left,
                ast.Constant(value=op_str),
                right,
                ast.Constant(value=node.lineno),
            ],
            keywords=[],
        )

    def visit_If(self, node: ast.If) -> ast.AST:
        """Mark conditions in if statements."""
        self._in_condition = True
        node.test = self.visit(node.test)
        self._in_condition = False

        node.body = [self.visit(stmt) for stmt in node.body]
        node.orelse = [self.visit(stmt) for stmt in node.orelse]

        return node

    def visit_While(self, node: ast.While) -> ast.AST:
        """Mark conditions in while statements."""
        self._in_condition = True
        node.test = self.visit(node.test)
        self._in_condition = False

        node.body = [self.visit(stmt) for stmt in node.body]
        node.orelse = [self.visit(stmt) for stmt in node.orelse]

        return node

    def visit_BoolOp(self, node: ast.BoolOp) -> ast.AST:
        """Visit boolean operations (and, or)."""
        node.values = [self.visit(v) for v in node.values]
        return node

    def _op_to_str(self, op: ast.cmpop) -> str | None:
        """Convert AST comparison operator to string."""
        op_map = {
            ast.Lt: "<",
            ast.LtE: "<=",
            ast.Gt: ">",
            ast.GtE: ">=",
            ast.Eq: "==",
            ast.NotEq: "!=",
            ast.In: "in",
            ast.NotIn: "not in",
            ast.Is: "is",
            ast.IsNot: "is not",
        }
        return op_map.get(type(op))


def instrument_code(source: str, capture_func_name: str = "__capture__") -> str:
    """
    Instrument Python source code for condition capture.

    Args:
        source: Python source code
        capture_func_name: Name of the capture function

    Returns:
        Instrumented source code
    """
    try:
        tree = ast.parse(source)
        instrumentor = ConditionInstrumentor(capture_func_name)
        new_tree = instrumentor.visit(tree)
        ast.fix_missing_locations(new_tree)
        return ast.unparse(new_tree)
    except Exception as e:
        logger.warning(f"Failed to instrument code: {e}")
        return source


def create_capture_wrapper(capturer: ConditionCapturer) -> Callable[..., bool]:
    """
    Create a capture function wrapper for use in instrumented code.

    Args:
        capturer: The condition capturer instance

    Returns:
        Capture function to inject into strategy globals
    """

    def capture(
        expression: str,
        left_value: Any,
        operator: str,
        right_value: Any,
        line_number: int = 0,
    ) -> bool:
        return capturer.capture(
            expression, left_value, operator, right_value, line_number
        )

    return capture

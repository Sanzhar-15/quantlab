"""
Tests for debug capture module.
"""

import ast
from decimal import Decimal

import pytest

from quantlab.debug.capture import (
    CaptureContext,
    ConditionCapturer,
    ConditionInstrumentor,
    create_capture_wrapper,
    instrument_code,
)


class TestCaptureContext:
    """Tests for CaptureContext dataclass."""

    def test_default_values(self) -> None:
        """Should have correct default values."""
        ctx = CaptureContext()

        assert ctx.bar_index == 0
        assert ctx.captures == []
        assert ctx.enabled is True
        assert ctx.max_captures_per_bar == 100

    def test_custom_values(self) -> None:
        """Should accept custom values."""
        ctx = CaptureContext(
            bar_index=10,
            enabled=False,
            max_captures_per_bar=50,
        )

        assert ctx.bar_index == 10
        assert ctx.enabled is False
        assert ctx.max_captures_per_bar == 50


class TestConditionCapturer:
    """Tests for ConditionCapturer class."""

    def test_init(self) -> None:
        """Should initialize with default settings."""
        capturer = ConditionCapturer()

        assert capturer.enabled is True
        assert capturer.get_captures() == []

    def test_init_custom_max_captures(self) -> None:
        """Should accept custom max captures."""
        capturer = ConditionCapturer(max_captures_per_bar=50)

        assert capturer._context.max_captures_per_bar == 50

    def test_set_bar_index(self) -> None:
        """Should set bar index and save previous captures."""
        capturer = ConditionCapturer()

        # Capture something at bar 0
        capturer.capture("a > b", 5, ">", 3, line_number=10)
        assert len(capturer.get_captures()) == 1

        # Move to bar 1
        capturer.set_bar_index(1)

        # Current bar should be empty
        assert len(capturer.get_captures()) == 0

        # Previous bar should have the capture
        assert len(capturer.get_captures(bar_index=0)) == 1

    def test_enabled_property(self) -> None:
        """Should enable and disable capture."""
        capturer = ConditionCapturer()

        assert capturer.enabled is True
        capturer.enabled = False
        assert capturer.enabled is False
        capturer.enabled = True
        assert capturer.enabled is True

    def test_capture_basic(self) -> None:
        """Should capture basic comparison."""
        capturer = ConditionCapturer()

        result = capturer.capture("a > b", 5, ">", 3, line_number=10)

        assert result is True
        captures = capturer.get_captures()
        assert len(captures) == 1
        assert captures[0].expression == "a > b"
        assert captures[0].left_value == "5"
        assert captures[0].operator == ">"
        assert captures[0].right_value == "3"
        assert captures[0].result is True
        assert captures[0].line_number == 10

    def test_capture_false_result(self) -> None:
        """Should capture condition with false result."""
        capturer = ConditionCapturer()

        result = capturer.capture("a > b", 1, ">", 5, line_number=20)

        assert result is False
        captures = capturer.get_captures()
        assert captures[0].result is False

    def test_capture_with_context(self) -> None:
        """Should capture with additional context."""
        capturer = ConditionCapturer()

        capturer.capture(
            "price > limit",
            100.0,
            ">",
            90.0,
            line_number=15,
            context={"symbol": "AAPL", "quantity": 100},
        )

        captures = capturer.get_captures()
        assert captures[0].context == {"symbol": "AAPL", "quantity": "100"}

    def test_capture_disabled(self) -> None:
        """Should not capture when disabled."""
        capturer = ConditionCapturer()
        capturer.enabled = False

        result = capturer.capture("a > b", 5, ">", 3, line_number=10)

        assert result is True  # Still evaluates
        assert len(capturer.get_captures()) == 0

    def test_capture_max_per_bar(self) -> None:
        """Should respect max captures per bar."""
        capturer = ConditionCapturer(max_captures_per_bar=3)

        for i in range(10):
            capturer.capture(f"expr{i}", i, ">", 0, line_number=i)

        captures = capturer.get_captures()
        assert len(captures) == 3

    def test_evaluate_operators(self) -> None:
        """Should evaluate all comparison operators."""
        capturer = ConditionCapturer()

        # Less than
        assert capturer.capture("a < b", 1, "<", 2) is True
        assert capturer.capture("a < b", 2, "<", 1) is False

        # Less than or equal
        assert capturer.capture("a <= b", 1, "<=", 1) is True
        assert capturer.capture("a <= b", 2, "<=", 1) is False

        # Greater than
        assert capturer.capture("a > b", 2, ">", 1) is True
        assert capturer.capture("a > b", 1, ">", 2) is False

        # Greater than or equal
        assert capturer.capture("a >= b", 1, ">=", 1) is True
        assert capturer.capture("a >= b", 1, ">=", 2) is False

        # Equal
        assert capturer.capture("a == b", 1, "==", 1) is True
        assert capturer.capture("a == b", 1, "==", 2) is False

        # Not equal
        assert capturer.capture("a != b", 1, "!=", 2) is True
        assert capturer.capture("a != b", 1, "!=", 1) is False

        # In
        assert capturer.capture("a in b", 1, "in", [1, 2, 3]) is True
        assert capturer.capture("a in b", 4, "in", [1, 2, 3]) is False

        # Not in
        assert capturer.capture("a not in b", 4, "not in", [1, 2, 3]) is True
        assert capturer.capture("a not in b", 1, "not in", [1, 2, 3]) is False

        # Is
        x = None
        assert capturer.capture("a is b", x, "is", None) is True
        assert capturer.capture("a is b", 1, "is", 1) is True

        # Is not
        assert capturer.capture("a is not b", 1, "is not", None) is True

    def test_evaluate_unknown_operator(self) -> None:
        """Should return False for unknown operator."""
        capturer = ConditionCapturer()

        result = capturer.capture("a ?? b", 1, "??", 2)

        assert result is False

    def test_evaluate_exception(self) -> None:
        """Should return False on evaluation exception."""
        capturer = ConditionCapturer()

        # Comparing incompatible types
        result = capturer.capture("a < b", "string", "<", 123)

        assert result is False

    def test_format_value_decimal(self) -> None:
        """Should format Decimal values."""
        capturer = ConditionCapturer()

        capturer.capture("a > b", Decimal("10.5"), ">", Decimal("5.0"))

        captures = capturer.get_captures()
        assert captures[0].left_value == "10.5"
        assert captures[0].right_value == "5.0"

    def test_format_value_float(self) -> None:
        """Should format float values with precision."""
        capturer = ConditionCapturer()

        capturer.capture("a > b", 3.14159265, ">", 1.0)

        captures = capturer.get_captures()
        assert captures[0].left_value == "3.141593"

    def test_format_value_large_list(self) -> None:
        """Should summarize large lists."""
        capturer = ConditionCapturer()

        capturer.capture("a in b", 1, "in", [1, 2, 3, 4, 5, 6, 7, 8])

        captures = capturer.get_captures()
        assert captures[0].right_value == "[8 items]"

    def test_format_value_large_dict(self) -> None:
        """Should summarize large dicts."""
        capturer = ConditionCapturer()

        big_dict = {f"key{i}": i for i in range(10)}
        capturer.capture("a in b", "key1", "in", big_dict)

        captures = capturer.get_captures()
        assert captures[0].right_value == "{10 items}"

    def test_format_value_small_list(self) -> None:
        """Should show small lists fully."""
        capturer = ConditionCapturer()

        capturer.capture("a in b", 1, "in", [1, 2, 3])

        captures = capturer.get_captures()
        assert captures[0].right_value == "[1, 2, 3]"

    def test_get_captures_specific_bar(self) -> None:
        """Should get captures for specific bar."""
        capturer = ConditionCapturer()

        capturer.capture("bar0", 1, ">", 0)
        capturer.set_bar_index(1)
        capturer.capture("bar1", 2, ">", 0)
        capturer.set_bar_index(2)
        capturer.capture("bar2", 3, ">", 0)

        # Get bar 0 captures
        bar0 = capturer.get_captures(bar_index=0)
        assert len(bar0) == 1
        assert bar0[0].expression == "bar0"

        # Get bar 1 captures
        bar1 = capturer.get_captures(bar_index=1)
        assert len(bar1) == 1
        assert bar1[0].expression == "bar1"

        # Get current bar (2) captures
        bar2 = capturer.get_captures()
        assert len(bar2) == 1
        assert bar2[0].expression == "bar2"

    def test_get_captures_nonexistent_bar(self) -> None:
        """Should return empty list for nonexistent bar."""
        capturer = ConditionCapturer()

        captures = capturer.get_captures(bar_index=999)

        assert captures == []

    def test_get_all_captures(self) -> None:
        """Should get all captures indexed by bar."""
        capturer = ConditionCapturer()

        capturer.capture("bar0", 1, ">", 0)
        capturer.set_bar_index(1)
        capturer.capture("bar1", 2, ">", 0)
        capturer.set_bar_index(2)
        capturer.capture("bar2", 3, ">", 0)

        all_captures = capturer.get_all_captures()

        assert 0 in all_captures
        assert 1 in all_captures
        assert 2 in all_captures  # Current bar included
        assert len(all_captures) == 3

    def test_clear(self) -> None:
        """Should clear all captures."""
        capturer = ConditionCapturer()

        capturer.capture("expr1", 1, ">", 0)
        capturer.set_bar_index(1)
        capturer.capture("expr2", 2, ">", 0)

        capturer.clear()

        assert capturer.get_captures() == []
        assert capturer.get_all_captures() == {}

    def test_finalize(self) -> None:
        """Should save current bar captures on finalize."""
        capturer = ConditionCapturer()

        capturer.capture("expr", 1, ">", 0)

        # Before finalize, current bar not in all_captures
        assert 0 not in capturer._all_captures

        capturer.finalize()

        # After finalize, current bar is saved
        assert 0 in capturer._all_captures
        assert len(capturer._all_captures[0]) == 1


class TestConditionInstrumentor:
    """Tests for ConditionInstrumentor class."""

    def test_init(self) -> None:
        """Should initialize with capture function name."""
        instrumentor = ConditionInstrumentor()
        assert instrumentor._capture_func == "__capture__"

        custom = ConditionInstrumentor("my_capture")
        assert custom._capture_func == "my_capture"

    def test_visit_if_comparison(self) -> None:
        """Should instrument if statement comparisons."""
        source = """
if a > b:
    pass
"""
        tree = ast.parse(source)
        instrumentor = ConditionInstrumentor()
        new_tree = instrumentor.visit(tree)

        # Check that the test is now a Call node
        if_stmt = new_tree.body[0]
        assert isinstance(if_stmt.test, ast.Call)
        assert if_stmt.test.func.id == "__capture__"

    def test_visit_while_comparison(self) -> None:
        """Should instrument while statement comparisons."""
        source = """
while x < 10:
    x += 1
"""
        tree = ast.parse(source)
        instrumentor = ConditionInstrumentor()
        new_tree = instrumentor.visit(tree)

        while_stmt = new_tree.body[0]
        assert isinstance(while_stmt.test, ast.Call)
        assert while_stmt.test.func.id == "__capture__"

    def test_visit_boolean_ops(self) -> None:
        """Should handle boolean operations."""
        source = """
if a > b and c < d:
    pass
"""
        tree = ast.parse(source)
        instrumentor = ConditionInstrumentor()
        new_tree = instrumentor.visit(tree)

        if_stmt = new_tree.body[0]
        # Test should be a BoolOp with instrumented comparisons
        assert isinstance(if_stmt.test, ast.BoolOp)
        assert isinstance(if_stmt.test.values[0], ast.Call)
        assert isinstance(if_stmt.test.values[1], ast.Call)

    def test_preserves_non_condition_comparisons(self) -> None:
        """Should not instrument comparisons outside conditions."""
        source = """
x = a > b
"""
        tree = ast.parse(source)
        instrumentor = ConditionInstrumentor()
        new_tree = instrumentor.visit(tree)

        assign = new_tree.body[0]
        # Should still be a Compare, not a Call
        assert isinstance(assign.value, ast.Compare)

    def test_handles_chained_comparisons(self) -> None:
        """Should not transform chained comparisons (a < b < c)."""
        source = """
if a < b < c:
    pass
"""
        tree = ast.parse(source)
        instrumentor = ConditionInstrumentor()
        new_tree = instrumentor.visit(tree)

        if_stmt = new_tree.body[0]
        # Chained comparison should not be transformed
        assert isinstance(if_stmt.test, ast.Compare)

    def test_op_to_str(self) -> None:
        """Should convert AST operators to strings."""
        instrumentor = ConditionInstrumentor()

        assert instrumentor._op_to_str(ast.Lt()) == "<"
        assert instrumentor._op_to_str(ast.LtE()) == "<="
        assert instrumentor._op_to_str(ast.Gt()) == ">"
        assert instrumentor._op_to_str(ast.GtE()) == ">="
        assert instrumentor._op_to_str(ast.Eq()) == "=="
        assert instrumentor._op_to_str(ast.NotEq()) == "!="
        assert instrumentor._op_to_str(ast.In()) == "in"
        assert instrumentor._op_to_str(ast.NotIn()) == "not in"
        assert instrumentor._op_to_str(ast.Is()) == "is"
        assert instrumentor._op_to_str(ast.IsNot()) == "is not"


class TestInstrumentCode:
    """Tests for instrument_code function."""

    def test_instrument_simple_if(self) -> None:
        """Should instrument simple if statement."""
        source = "if a > b:\n    pass"

        result = instrument_code(source)

        assert "__capture__" in result
        assert "a > b" in result

    def test_instrument_multiple_conditions(self) -> None:
        """Should instrument multiple conditions."""
        source = """
if x > 0:
    pass
if y < 10:
    pass
"""
        result = instrument_code(source)

        assert result.count("__capture__") == 2

    def test_instrument_invalid_code(self) -> None:
        """Should return original code for invalid syntax."""
        source = "if a > b  # syntax error"

        result = instrument_code(source)

        assert result == source

    def test_custom_capture_func_name(self) -> None:
        """Should use custom capture function name."""
        source = "if a > b:\n    pass"

        result = instrument_code(source, capture_func_name="my_capture")

        assert "my_capture" in result
        assert "__capture__" not in result


class TestCreateCaptureWrapper:
    """Tests for create_capture_wrapper function."""

    def test_create_wrapper(self) -> None:
        """Should create working capture wrapper."""
        capturer = ConditionCapturer()
        wrapper = create_capture_wrapper(capturer)

        result = wrapper("a > b", 5, ">", 3, 10)

        assert result is True
        captures = capturer.get_captures()
        assert len(captures) == 1
        assert captures[0].expression == "a > b"

    def test_wrapper_false_result(self) -> None:
        """Wrapper should return correct boolean result."""
        capturer = ConditionCapturer()
        wrapper = create_capture_wrapper(capturer)

        result = wrapper("a > b", 1, ">", 5, 10)

        assert result is False

    def test_wrapper_captures_multiple(self) -> None:
        """Wrapper should capture multiple conditions."""
        capturer = ConditionCapturer()
        wrapper = create_capture_wrapper(capturer)

        wrapper("a > b", 5, ">", 3, 10)
        wrapper("c < d", 1, "<", 2, 20)

        captures = capturer.get_captures()
        assert len(captures) == 2

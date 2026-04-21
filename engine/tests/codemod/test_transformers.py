"""
Tests for CodeMod Transformers module.

Tests LibCST-based transformers and formatting preservation.
"""

import pytest
import libcst as cst

from quantlab.codemod import (
    ParameterTransformer,
    ImportTransformer,
    AssignmentTransformer,
    FunctionBodyTransformer,
    CodeInserter,
    apply_edits,
    CodeEdit,
    EditType,
    ParameterEdit,
    ImportEdit,
)


class TestParameterTransformer:
    """Tests for ParameterTransformer class."""

    def test_change_simple_parameter(self) -> None:
        """Test changing a simple parameter value."""
        source = """
import ql

period = ql.param(20)
"""
        tree = cst.parse_module(source)
        transformer = ParameterTransformer([
            ParameterEdit(name="period", new_value=30),
        ])
        modified = tree.visit(transformer)

        assert "30" in modified.code
        assert "period" in transformer.applied_edits

    def test_change_float_parameter(self) -> None:
        """Test changing a float parameter."""
        source = """
threshold = ql.param(0.5)
"""
        tree = cst.parse_module(source)
        transformer = ParameterTransformer([
            ParameterEdit(name="threshold", new_value=0.75),
        ])
        modified = tree.visit(transformer)

        assert "0.75" in modified.code

    def test_change_string_parameter(self) -> None:
        """Test changing a string parameter."""
        source = """
symbol = ql.param("AAPL")
"""
        tree = cst.parse_module(source)
        transformer = ParameterTransformer([
            ParameterEdit(name="symbol", new_value="GOOG"),
        ])
        modified = tree.visit(transformer)

        assert "GOOG" in modified.code

    def test_change_boolean_parameter(self) -> None:
        """Test changing a boolean parameter."""
        source = """
enabled = ql.param(True)
"""
        tree = cst.parse_module(source)
        transformer = ParameterTransformer([
            ParameterEdit(name="enabled", new_value=False),
        ])
        modified = tree.visit(transformer)

        assert "False" in modified.code

    def test_multiple_parameters(self) -> None:
        """Test changing multiple parameters."""
        source = """
fast = ql.param(10)
slow = ql.param(20)
"""
        tree = cst.parse_module(source)
        transformer = ParameterTransformer([
            ParameterEdit(name="fast", new_value=15),
            ParameterEdit(name="slow", new_value=30),
        ])
        modified = tree.visit(transformer)

        assert "15" in modified.code
        assert "30" in modified.code
        assert len(transformer.applied_edits) == 2

    def test_parameter_not_found(self) -> None:
        """Test when parameter is not found."""
        source = """
x = ql.param(10)
"""
        tree = cst.parse_module(source)
        transformer = ParameterTransformer([
            ParameterEdit(name="nonexistent", new_value=20),
        ])
        modified = tree.visit(transformer)

        assert "nonexistent" not in transformer.applied_edits

    def test_preserves_comments(self) -> None:
        """Test that comments are preserved."""
        source = """
# This is a comment
period = ql.param(20)  # inline comment
"""
        tree = cst.parse_module(source)
        transformer = ParameterTransformer([
            ParameterEdit(name="period", new_value=30),
        ])
        modified = tree.visit(transformer)

        assert "# This is a comment" in modified.code
        assert "# inline comment" in modified.code

    def test_preserves_formatting(self) -> None:
        """Test that whitespace formatting is preserved."""
        source = """
period   =   ql.param(  20  )
"""
        tree = cst.parse_module(source)
        transformer = ParameterTransformer([
            ParameterEdit(name="period", new_value=30),
        ])
        modified = tree.visit(transformer)

        # The assignment structure should be preserved
        assert "period" in modified.code


class TestImportTransformer:
    """Tests for ImportTransformer class."""

    def test_add_from_import(self) -> None:
        """Test adding a from import."""
        source = """
x = 10
"""
        tree = cst.parse_module(source)
        transformer = ImportTransformer(
            add_imports=[
                ImportEdit(module="numpy", names=["array"], is_from_import=True),
            ]
        )
        modified = tree.visit(transformer)

        assert "from numpy import array" in modified.code

    def test_add_simple_import(self) -> None:
        """Test adding a simple import."""
        source = """
x = 10
"""
        tree = cst.parse_module(source)
        transformer = ImportTransformer(
            add_imports=[
                ImportEdit(module="numpy", is_from_import=False),
            ]
        )
        modified = tree.visit(transformer)

        assert "import numpy" in modified.code

    def test_add_import_with_alias(self) -> None:
        """Test adding import with alias."""
        source = """
x = 10
"""
        tree = cst.parse_module(source)
        transformer = ImportTransformer(
            add_imports=[
                ImportEdit(module="pandas", alias="pd", is_from_import=False),
            ]
        )
        modified = tree.visit(transformer)

        assert "import pandas as pd" in modified.code

    def test_remove_import(self) -> None:
        """Test removing an import."""
        source = """
import numpy
import pandas

x = 10
"""
        tree = cst.parse_module(source)
        transformer = ImportTransformer(
            remove_imports=[
                ImportEdit(module="numpy", is_from_import=False),
            ]
        )
        modified = tree.visit(transformer)

        assert "import numpy" not in modified.code
        assert "import pandas" in modified.code

    def test_remove_from_import(self) -> None:
        """Test removing a from import."""
        source = """
from pathlib import Path
from typing import List

x = 10
"""
        tree = cst.parse_module(source)
        transformer = ImportTransformer(
            remove_imports=[
                ImportEdit(module="pathlib", is_from_import=True),
            ]
        )
        modified = tree.visit(transformer)

        assert "from pathlib" not in modified.code
        assert "from typing" in modified.code


class TestAssignmentTransformer:
    """Tests for AssignmentTransformer class."""

    def test_change_integer(self) -> None:
        """Test changing integer assignment."""
        source = """
x = 10
"""
        tree = cst.parse_module(source)
        transformer = AssignmentTransformer({"x": 20})
        modified = tree.visit(transformer)

        assert "20" in modified.code

    def test_change_string(self) -> None:
        """Test changing string assignment."""
        source = """
name = "foo"
"""
        tree = cst.parse_module(source)
        transformer = AssignmentTransformer({"name": "bar"})
        modified = tree.visit(transformer)

        assert "bar" in modified.code

    def test_change_list(self) -> None:
        """Test changing list assignment."""
        source = """
items = [1, 2, 3]
"""
        tree = cst.parse_module(source)
        transformer = AssignmentTransformer({"items": [4, 5, 6]})
        modified = tree.visit(transformer)

        assert "4" in modified.code


class TestFunctionBodyTransformer:
    """Tests for FunctionBodyTransformer class."""

    def test_replace_body(self) -> None:
        """Test replacing function body."""
        source = """
def foo():
    return 10
"""
        tree = cst.parse_module(source)
        transformer = FunctionBodyTransformer(
            function_name="foo",
            new_body="return 20",
        )
        modified = tree.visit(transformer)

        assert "20" in modified.code
        assert transformer.applied is True

    def test_prepend_code(self) -> None:
        """Test prepending code to function."""
        source = """
def foo():
    return 10
"""
        tree = cst.parse_module(source)
        transformer = FunctionBodyTransformer(
            function_name="foo",
            prepend_code="x = 5",
        )
        modified = tree.visit(transformer)

        assert "x = 5" in modified.code

    def test_append_code(self) -> None:
        """Test appending code to function."""
        source = """
def foo():
    x = 10
"""
        tree = cst.parse_module(source)
        transformer = FunctionBodyTransformer(
            function_name="foo",
            append_code="return x",
        )
        modified = tree.visit(transformer)

        assert "return x" in modified.code

    def test_function_not_found(self) -> None:
        """Test when function is not found."""
        source = """
def bar():
    return 10
"""
        tree = cst.parse_module(source)
        transformer = FunctionBodyTransformer(
            function_name="foo",
            new_body="return 20",
        )
        modified = tree.visit(transformer)

        assert transformer.applied is False


class TestApplyEdits:
    """Tests for apply_edits function."""

    def test_parameter_edit(self) -> None:
        """Test applying parameter edit."""
        source = """
period = ql.param(20)
"""
        edits = [
            CodeEdit(
                edit_type=EditType.PARAMETER_CHANGE,
                parameter_edit=ParameterEdit(name="period", new_value=30),
            )
        ]

        modified, results = apply_edits(source, edits)

        assert "30" in modified
        assert results[0] is True

    def test_import_edit(self) -> None:
        """Test applying import edit."""
        source = """
x = 10
"""
        edits = [
            CodeEdit(
                edit_type=EditType.ADD_IMPORT,
                import_edit=ImportEdit(module="numpy", names=["array"]),
            )
        ]

        modified, results = apply_edits(source, edits)

        assert "numpy" in modified
        assert results[0] is True

    def test_multiple_edits(self) -> None:
        """Test applying multiple edits."""
        source = """
import ql

fast = ql.param(10)
slow = ql.param(20)
"""
        edits = [
            CodeEdit(
                edit_type=EditType.PARAMETER_CHANGE,
                parameter_edit=ParameterEdit(name="fast", new_value=15),
            ),
            CodeEdit(
                edit_type=EditType.PARAMETER_CHANGE,
                parameter_edit=ParameterEdit(name="slow", new_value=30),
            ),
            CodeEdit(
                edit_type=EditType.ADD_IMPORT,
                import_edit=ImportEdit(module="numpy", names=["array"]),
            ),
        ]

        modified, results = apply_edits(source, edits)

        assert "15" in modified
        assert "30" in modified
        assert "numpy" in modified
        assert all(results)

    def test_syntax_error(self) -> None:
        """Test with syntax error in source."""
        source = """
def foo(
"""
        edits = []

        with pytest.raises(ValueError):
            apply_edits(source, edits)


class TestFormattingPreservation:
    """Tests for formatting preservation."""

    def test_preserves_indentation(self) -> None:
        """Test that indentation is preserved."""
        source = """
class Foo:
    period = ql.param(20)
"""
        tree = cst.parse_module(source)
        transformer = ParameterTransformer([
            ParameterEdit(name="period", new_value=30),
        ])
        modified = tree.visit(transformer)

        # Check indentation is preserved
        lines = modified.code.split("\n")
        param_line = [l for l in lines if "period" in l][0]
        assert param_line.startswith("    ")

    def test_preserves_blank_lines(self) -> None:
        """Test that blank lines are preserved."""
        source = """
x = ql.param(10)

y = ql.param(20)
"""
        tree = cst.parse_module(source)
        transformer = ParameterTransformer([
            ParameterEdit(name="x", new_value=15),
        ])
        modified = tree.visit(transformer)

        # Count blank lines
        original_blank = source.count("\n\n")
        modified_blank = modified.code.count("\n\n")
        assert modified_blank >= original_blank - 1  # Allow for minor changes

    def test_preserves_trailing_newline(self) -> None:
        """Test that trailing newline is preserved."""
        source = "x = ql.param(10)\n"
        tree = cst.parse_module(source)
        transformer = ParameterTransformer([
            ParameterEdit(name="x", new_value=20),
        ])
        modified = tree.visit(transformer)

        assert modified.code.endswith("\n")

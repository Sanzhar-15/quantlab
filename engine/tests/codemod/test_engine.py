"""
Tests for CodeMod Engine module.

Tests CodeModEngine, SourceAnalyzer, and code transformation.
"""

import pytest

from quantlab.codemod import (
    CodeModEngine,
    EditRequest,
    EditStatus,
    ParseRequest,
    CodeEdit,
    EditType,
    ParameterEdit,
    ImportEdit,
    create_parameter_edit,
    create_import_edit,
)


class TestCodeModEngine:
    """Tests for CodeModEngine class."""

    @pytest.fixture
    def engine(self) -> CodeModEngine:
        """Create test engine."""
        return CodeModEngine()

    def test_parse_simple_code(self, engine: CodeModEngine) -> None:
        """Test parsing simple code."""
        source = """
import numpy as np

x = 10
y = 20

def foo(a, b):
    return a + b
"""
        request = ParseRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
        )

        response = engine.parse(request)

        assert response.status == EditStatus.SUCCESS
        assert len(response.imports) >= 1
        assert len(response.functions) >= 1

    def test_parse_parameters(self, engine: CodeModEngine) -> None:
        """Test parsing parameter definitions."""
        source = """
import quantlab as ql

period = ql.param(20)
threshold = ql.param(0.5, description="Signal threshold")
"""
        request = ParseRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
        )

        response = engine.parse(request)

        assert response.status == EditStatus.SUCCESS
        assert len(response.parameters) == 2

        param_names = [p.name for p in response.parameters]
        assert "period" in param_names
        assert "threshold" in param_names

    def test_parse_syntax_error(self, engine: CodeModEngine) -> None:
        """Test parsing code with syntax errors."""
        source = """
def foo(
    # missing closing paren
"""
        request = ParseRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
        )

        response = engine.parse(request)

        assert response.status == EditStatus.PARSE_ERROR
        assert response.error is not None

    def test_edit_empty_edits(self, engine: CodeModEngine) -> None:
        """Test edit with no edits."""
        source = "x = 10"
        request = EditRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
            edits=[],
        )

        response = engine.edit(request)

        assert response.status == EditStatus.SUCCESS
        assert response.modified_code == source

    def test_edit_parameter_change(self, engine: CodeModEngine) -> None:
        """Test editing a parameter value."""
        source = """
import quantlab as ql

period = ql.param(20)
"""
        request = EditRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
            edits=[
                create_parameter_edit("period", 30),
            ],
        )

        response = engine.edit(request)

        assert response.status == EditStatus.SUCCESS
        assert "30" in response.modified_code

    def test_edit_add_import(self, engine: CodeModEngine) -> None:
        """Test adding an import."""
        source = """
x = 10
"""
        request = EditRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
            edits=[
                create_import_edit("numpy", names=["array"]),
            ],
        )

        response = engine.edit(request)

        assert response.status == EditStatus.SUCCESS
        assert "numpy" in response.modified_code

    def test_edit_remove_import(self, engine: CodeModEngine) -> None:
        """Test removing an import."""
        source = """
import numpy
import pandas

x = 10
"""
        request = EditRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
            edits=[
                create_import_edit("numpy", remove=True),
            ],
        )

        response = engine.edit(request)

        assert response.status == EditStatus.SUCCESS
        assert "import numpy" not in response.modified_code
        assert "import pandas" in response.modified_code

    def test_edit_dry_run(self, engine: CodeModEngine) -> None:
        """Test dry run mode."""
        source = "x = 10"
        request = EditRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
            edits=[],
            dry_run=True,
        )

        response = engine.edit(request)

        assert response.status == EditStatus.SUCCESS
        assert response.modified_code is None  # Not returned in dry run

    def test_edit_generates_diff(self, engine: CodeModEngine) -> None:
        """Test that edit generates diff."""
        source = """
import quantlab as ql

period = ql.param(20)
"""
        request = EditRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
            edits=[
                create_parameter_edit("period", 30),
            ],
        )

        response = engine.edit(request)

        assert response.status == EditStatus.SUCCESS
        assert response.diff is not None
        assert "---" in response.diff
        assert "+++" in response.diff

    def test_edit_multiple_changes(self, engine: CodeModEngine) -> None:
        """Test multiple edits in one request."""
        source = """
import quantlab as ql

fast = ql.param(10)
slow = ql.param(20)
"""
        request = EditRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
            edits=[
                create_parameter_edit("fast", 15),
                create_parameter_edit("slow", 30),
            ],
        )

        response = engine.edit(request)

        assert response.status == EditStatus.SUCCESS
        assert "15" in response.modified_code
        assert "30" in response.modified_code

    def test_validate_syntax_valid(self, engine: CodeModEngine) -> None:
        """Test syntax validation with valid code."""
        source = """
def foo():
    return 42
"""
        is_valid, error = engine.validate_syntax(source)

        assert is_valid is True
        assert error is None

    def test_validate_syntax_invalid(self, engine: CodeModEngine) -> None:
        """Test syntax validation with invalid code."""
        source = """
def foo(
    # missing
"""
        is_valid, error = engine.validate_syntax(source)

        assert is_valid is False
        assert error is not None


class TestCreateParameterEdit:
    """Tests for create_parameter_edit helper."""

    def test_simple_edit(self) -> None:
        """Test creating simple parameter edit."""
        edit = create_parameter_edit("period", 30)

        assert edit.edit_type == EditType.PARAMETER_CHANGE
        assert edit.target == "period"
        assert edit.parameter_edit.new_value == 30

    def test_with_old_value(self) -> None:
        """Test with old value specified."""
        edit = create_parameter_edit("period", 30, old_value=20)

        assert edit.parameter_edit.old_value == 20


class TestCreateImportEdit:
    """Tests for create_import_edit helper."""

    def test_add_from_import(self) -> None:
        """Test creating from import."""
        edit = create_import_edit("numpy", names=["array", "zeros"])

        assert edit.edit_type == EditType.ADD_IMPORT
        assert edit.import_edit.module == "numpy"
        assert edit.import_edit.is_from_import is True

    def test_add_simple_import(self) -> None:
        """Test creating simple import."""
        edit = create_import_edit("pandas", alias="pd", is_from_import=False)

        assert edit.import_edit.alias == "pd"
        assert edit.import_edit.is_from_import is False

    def test_remove_import(self) -> None:
        """Test creating remove import."""
        edit = create_import_edit("numpy", remove=True)

        assert edit.edit_type == EditType.REMOVE_IMPORT


class TestSourceAnalyzer:
    """Tests for SourceAnalyzer via engine.parse()."""

    @pytest.fixture
    def engine(self) -> CodeModEngine:
        """Create test engine."""
        return CodeModEngine()

    def test_extract_imports(self, engine: CodeModEngine) -> None:
        """Test extracting imports."""
        source = """
import os
import sys
from pathlib import Path
from typing import List, Dict
"""
        request = ParseRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
        )

        response = engine.parse(request)

        assert len(response.imports) == 4

        # Check simple imports
        simple_imports = [i for i in response.imports if not i.is_from_import]
        assert len(simple_imports) == 2

        # Check from imports
        from_imports = [i for i in response.imports if i.is_from_import]
        assert len(from_imports) == 2

    def test_extract_functions(self, engine: CodeModEngine) -> None:
        """Test extracting functions."""
        source = '''
def simple():
    pass

def with_params(a, b, c):
    """Docstring."""
    return a + b + c

@decorator
def decorated():
    pass
'''
        request = ParseRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
        )

        response = engine.parse(request)

        assert len(response.functions) == 3

        # Check function with params
        with_params = next(f for f in response.functions if f.name == "with_params")
        assert len(with_params.parameters) == 3
        assert with_params.docstring is not None

        # Check decorated function
        decorated = next(f for f in response.functions if f.name == "decorated")
        assert "decorator" in decorated.decorators

    def test_extract_parameters(self, engine: CodeModEngine) -> None:
        """Test extracting ql.param() definitions."""
        source = """
import quantlab as ql

# Integer parameter
period = ql.param(20)

# Float parameter
threshold = ql.param(0.5)

# String parameter
symbol = ql.param("AAPL")

# Boolean parameter
enabled = ql.param(True)

# With description
ratio = ql.param(0.1, description="Risk ratio")
"""
        request = ParseRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
        )

        response = engine.parse(request)

        assert len(response.parameters) == 5

        # Check types
        period = next(p for p in response.parameters if p.name == "period")
        assert period.value == 20
        assert period.value_type == "int"

        threshold = next(p for p in response.parameters if p.name == "threshold")
        assert threshold.value == 0.5
        assert threshold.value_type == "float"

        symbol = next(p for p in response.parameters if p.name == "symbol")
        assert symbol.value == "AAPL"
        assert symbol.value_type == "str"

        enabled = next(p for p in response.parameters if p.name == "enabled")
        assert enabled.value is True
        assert enabled.value_type == "bool"

    def test_selective_extraction(self, engine: CodeModEngine) -> None:
        """Test selective extraction."""
        source = """
import numpy

x = 10

def foo():
    pass
"""
        request = ParseRequest(
            request_id="req-001",
            file_path="/test.py",
            source_code=source,
            extract_imports=True,
            extract_functions=False,
            extract_parameters=False,
        )

        response = engine.parse(request)

        assert len(response.imports) >= 1
        assert len(response.functions) == 0
        assert len(response.parameters) == 0

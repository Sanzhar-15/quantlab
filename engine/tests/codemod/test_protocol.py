"""
Tests for CodeMod Protocol module.

Tests NDJSON message serialization and parsing for Phase 6.
"""

import json
import pytest

from quantlab.codemod import (
    EditType,
    EditStatus,
    SourceLocation,
    SourceRange,
    ParameterEdit,
    ImportEdit,
    CodeEdit,
    EditRequest,
    EditResponse,
    EditResult,
    ParseRequest,
    ParseResponse,
    ParameterInfo,
    ImportInfo,
    FunctionInfo,
    CodeModParser,
    CodeModWriter,
)


class TestEditType:
    """Tests for EditType enum."""

    def test_values(self) -> None:
        """Test edit type values."""
        assert EditType.PARAMETER_CHANGE.value == "parameter_change"
        assert EditType.ADD_IMPORT.value == "add_import"
        assert EditType.REMOVE_IMPORT.value == "remove_import"
        assert EditType.MODIFY_FUNCTION.value == "modify_function"


class TestEditStatus:
    """Tests for EditStatus enum."""

    def test_values(self) -> None:
        """Test edit status values."""
        assert EditStatus.SUCCESS.value == "success"
        assert EditStatus.PARTIAL.value == "partial"
        assert EditStatus.FAILED.value == "failed"
        assert EditStatus.PARSE_ERROR.value == "parse_error"


class TestSourceLocation:
    """Tests for SourceLocation dataclass."""

    def test_creation(self) -> None:
        """Test location creation."""
        loc = SourceLocation(line=10, column=5)
        assert loc.line == 10
        assert loc.column == 5

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        loc = SourceLocation(line=10, column=5)
        d = loc.to_dict()

        assert d["line"] == 10
        assert d["column"] == 5

    def test_from_dict(self) -> None:
        """Test creation from dictionary."""
        data = {"line": 20, "column": 15}
        loc = SourceLocation.from_dict(data)

        assert loc.line == 20
        assert loc.column == 15


class TestSourceRange:
    """Tests for SourceRange dataclass."""

    def test_creation(self) -> None:
        """Test range creation."""
        start = SourceLocation(line=1, column=0)
        end = SourceLocation(line=5, column=10)
        range_ = SourceRange(start=start, end=end)

        assert range_.start.line == 1
        assert range_.end.line == 5

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        range_ = SourceRange(
            start=SourceLocation(line=1, column=0),
            end=SourceLocation(line=5, column=10),
        )
        d = range_.to_dict()

        assert d["start"]["line"] == 1
        assert d["end"]["line"] == 5


class TestParameterEdit:
    """Tests for ParameterEdit dataclass."""

    def test_creation(self) -> None:
        """Test parameter edit creation."""
        edit = ParameterEdit(
            name="threshold",
            new_value=0.5,
            old_value=0.3,
        )
        assert edit.name == "threshold"
        assert edit.new_value == 0.5

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        edit = ParameterEdit(name="period", new_value=20)
        d = edit.to_dict()

        assert d["name"] == "period"
        assert d["newValue"] == 20

    def test_from_dict(self) -> None:
        """Test creation from dictionary."""
        data = {"name": "period", "newValue": 30, "oldValue": 20}
        edit = ParameterEdit.from_dict(data)

        assert edit.name == "period"
        assert edit.new_value == 30
        assert edit.old_value == 20


class TestImportEdit:
    """Tests for ImportEdit dataclass."""

    def test_creation(self) -> None:
        """Test import edit creation."""
        edit = ImportEdit(
            module="numpy",
            names=["array", "zeros"],
            is_from_import=True,
        )
        assert edit.module == "numpy"
        assert "array" in edit.names

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        edit = ImportEdit(module="pandas", alias="pd", is_from_import=False)
        d = edit.to_dict()

        assert d["module"] == "pandas"
        assert d["alias"] == "pd"
        assert d["isFromImport"] is False


class TestCodeEdit:
    """Tests for CodeEdit dataclass."""

    def test_parameter_change(self) -> None:
        """Test parameter change edit."""
        edit = CodeEdit(
            edit_type=EditType.PARAMETER_CHANGE,
            target="threshold",
            parameter_edit=ParameterEdit(name="threshold", new_value=0.5),
        )
        assert edit.edit_type == EditType.PARAMETER_CHANGE
        assert edit.target == "threshold"

    def test_add_import(self) -> None:
        """Test add import edit."""
        edit = CodeEdit(
            edit_type=EditType.ADD_IMPORT,
            import_edit=ImportEdit(module="numpy", names=["array"]),
        )
        assert edit.edit_type == EditType.ADD_IMPORT

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        edit = CodeEdit(
            edit_type=EditType.PARAMETER_CHANGE,
            parameter_edit=ParameterEdit(name="x", new_value=10),
        )
        d = edit.to_dict()

        assert d["editType"] == "parameter_change"
        assert d["parameterEdit"]["name"] == "x"


class TestEditRequest:
    """Tests for EditRequest dataclass."""

    def test_creation(self) -> None:
        """Test request creation."""
        request = EditRequest(
            request_id="req-001",
            file_path="/path/to/file.py",
            source_code="x = 10",
            edits=[],
        )
        assert request.request_id == "req-001"
        assert request.file_path == "/path/to/file.py"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        request = EditRequest(
            request_id="req-001",
            file_path="/file.py",
            source_code="x = 10",
            edits=[],
            dry_run=True,
        )
        d = request.to_dict()

        assert d["type"] == "edit"
        assert d["requestId"] == "req-001"
        assert d["dryRun"] is True

    def test_to_ndjson(self) -> None:
        """Test conversion to NDJSON."""
        request = EditRequest(
            request_id="req-001",
            file_path="/file.py",
            source_code="x = 10",
            edits=[],
        )
        ndjson = request.to_ndjson()

        assert ndjson.endswith("\n")
        parsed = json.loads(ndjson)
        assert parsed["type"] == "edit"

    def test_from_dict(self) -> None:
        """Test creation from dictionary."""
        data = {
            "requestId": "req-002",
            "filePath": "/test.py",
            "sourceCode": "y = 20",
            "edits": [],
        }
        request = EditRequest.from_dict(data)

        assert request.request_id == "req-002"
        assert request.source_code == "y = 20"


class TestEditResponse:
    """Tests for EditResponse dataclass."""

    def test_success_response(self) -> None:
        """Test successful response."""
        response = EditResponse(
            request_id="req-001",
            status=EditStatus.SUCCESS,
            modified_code="x = 20",
        )
        assert response.status == EditStatus.SUCCESS
        assert response.modified_code == "x = 20"

    def test_failed_response(self) -> None:
        """Test failed response."""
        response = EditResponse(
            request_id="req-001",
            status=EditStatus.FAILED,
            error="Parse error",
        )
        assert response.status == EditStatus.FAILED
        assert response.error == "Parse error"

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        response = EditResponse(
            request_id="req-001",
            status=EditStatus.SUCCESS,
            modified_code="x = 20",
            diff="--- a/file.py\n+++ b/file.py",
        )
        d = response.to_dict()

        assert d["type"] == "editResponse"
        assert d["status"] == "success"
        assert d["diff"] is not None


class TestParseRequest:
    """Tests for ParseRequest dataclass."""

    def test_creation(self) -> None:
        """Test request creation."""
        request = ParseRequest(
            request_id="req-001",
            file_path="/file.py",
            source_code="import numpy",
        )
        assert request.extract_parameters is True
        assert request.extract_imports is True

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        request = ParseRequest(
            request_id="req-001",
            file_path="/file.py",
            source_code="x = 10",
            extract_functions=False,
        )
        d = request.to_dict()

        assert d["type"] == "parse"
        assert d["extractFunctions"] is False


class TestParseResponse:
    """Tests for ParseResponse dataclass."""

    def test_success_response(self) -> None:
        """Test successful response."""
        response = ParseResponse(
            request_id="req-001",
            status=EditStatus.SUCCESS,
            parameters=[
                ParameterInfo(
                    name="x",
                    value=10,
                    value_type="int",
                    location=SourceRange(
                        start=SourceLocation(1, 0),
                        end=SourceLocation(1, 10),
                    ),
                )
            ],
        )
        assert len(response.parameters) == 1
        assert response.parameters[0].name == "x"


class TestCodeModParser:
    """Tests for CodeModParser class."""

    def test_parse_single_message(self) -> None:
        """Test parsing a single message."""
        parser = CodeModParser()
        messages = parser.feed('{"type": "edit", "requestId": "001"}\n')

        assert len(messages) == 1
        assert messages[0]["type"] == "edit"

    def test_parse_multiple_messages(self) -> None:
        """Test parsing multiple messages."""
        parser = CodeModParser()
        data = '{"type": "edit"}\n{"type": "parse"}\n'
        messages = parser.feed(data)

        assert len(messages) == 2

    def test_partial_buffering(self) -> None:
        """Test buffering of partial messages."""
        parser = CodeModParser()

        messages1 = parser.feed('{"type": "ed')
        assert len(messages1) == 0

        messages2 = parser.feed('it"}\n')
        assert len(messages2) == 1
        assert messages2[0]["type"] == "edit"

    def test_flush(self) -> None:
        """Test flushing buffer."""
        parser = CodeModParser()
        parser.feed('{"type": "test"}')

        messages = parser.flush()
        assert len(messages) == 1

    def test_parse_request(self) -> None:
        """Test parsing request types."""
        parser = CodeModParser()

        edit_data = {
            "type": "edit",
            "requestId": "001",
            "filePath": "/file.py",
            "sourceCode": "x = 10",
            "edits": [],
        }
        request = parser.parse_request(edit_data)
        assert isinstance(request, EditRequest)

        parse_data = {
            "type": "parse",
            "requestId": "002",
            "filePath": "/file.py",
            "sourceCode": "x = 10",
        }
        request = parser.parse_request(parse_data)
        assert isinstance(request, ParseRequest)


class TestCodeModWriter:
    """Tests for CodeModWriter class."""

    def test_edit_response(self) -> None:
        """Test writing edit response."""
        outputs = []
        writer = CodeModWriter(output_func=outputs.append)

        writer.edit_response(
            request_id="req-001",
            status=EditStatus.SUCCESS,
            modified_code="x = 20",
        )

        assert len(outputs) == 1
        parsed = json.loads(outputs[0])
        assert parsed["type"] == "editResponse"
        assert parsed["status"] == "success"

    def test_parse_response(self) -> None:
        """Test writing parse response."""
        outputs = []
        writer = CodeModWriter(output_func=outputs.append)

        writer.parse_response(
            request_id="req-001",
            status=EditStatus.SUCCESS,
            parameters=[
                ParameterInfo(
                    name="x",
                    value=10,
                    value_type="int",
                    location=SourceRange(
                        start=SourceLocation(1, 0),
                        end=SourceLocation(1, 10),
                    ),
                )
            ],
        )

        parsed = json.loads(outputs[0])
        assert parsed["type"] == "parseResponse"

    def test_error(self) -> None:
        """Test writing error response."""
        outputs = []
        writer = CodeModWriter(output_func=outputs.append)

        writer.error(
            request_id="req-001",
            error="Something went wrong",
        )

        parsed = json.loads(outputs[0])
        assert parsed["status"] == "failed"
        assert parsed["error"] == "Something went wrong"

"""
Code Modification Protocol.

Defines request/response messages for code modification IPC.

Spec Reference: Technical Spec §20.5, Phase 6 Code Modification Contract
"""

import json
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from enum import Enum
from typing import Any


class EditType(Enum):
    """Types of code edits."""

    PARAMETER_CHANGE = "parameter_change"  # Change ql.param() value
    ADD_IMPORT = "add_import"  # Add an import statement
    REMOVE_IMPORT = "remove_import"  # Remove an import statement
    MODIFY_FUNCTION = "modify_function"  # Modify function body
    MODIFY_ASSIGNMENT = "modify_assignment"  # Modify variable assignment
    INSERT_CODE = "insert_code"  # Insert code at location
    DELETE_CODE = "delete_code"  # Delete code at location
    REPLACE_CODE = "replace_code"  # Replace code at location


class EditStatus(Enum):
    """Status of an edit operation."""

    SUCCESS = "success"
    PARTIAL = "partial"  # Some edits succeeded
    FAILED = "failed"
    PARSE_ERROR = "parse_error"
    VALIDATION_ERROR = "validation_error"


@dataclass
class SourceLocation:
    """Location in source code."""

    line: int
    column: int

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "line": self.line,
            "column": self.column,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SourceLocation":
        """Create from dictionary."""
        return cls(
            line=data["line"],
            column=data["column"],
        )


@dataclass
class SourceRange:
    """Range in source code."""

    start: SourceLocation
    end: SourceLocation

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "start": self.start.to_dict(),
            "end": self.end.to_dict(),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SourceRange":
        """Create from dictionary."""
        return cls(
            start=SourceLocation.from_dict(data["start"]),
            end=SourceLocation.from_dict(data["end"]),
        )


@dataclass
class ParameterEdit:
    """Edit to a parameter value."""

    name: str
    new_value: Any
    old_value: Any | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "newValue": self.new_value,
            "oldValue": self.old_value,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ParameterEdit":
        """Create from dictionary."""
        return cls(
            name=data["name"],
            new_value=data["newValue"],
            old_value=data.get("oldValue"),
        )


@dataclass
class ImportEdit:
    """Edit to an import statement."""

    module: str
    names: list[str] = field(default_factory=list)
    alias: str | None = None
    is_from_import: bool = True

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "module": self.module,
            "names": self.names,
            "alias": self.alias,
            "isFromImport": self.is_from_import,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ImportEdit":
        """Create from dictionary."""
        return cls(
            module=data["module"],
            names=data.get("names", []),
            alias=data.get("alias"),
            is_from_import=data.get("isFromImport", True),
        )


@dataclass
class CodeEdit:
    """Generic code edit."""

    edit_type: EditType
    target: str | None = None  # Function name, variable name, etc.
    location: SourceRange | None = None
    new_code: str | None = None
    parameter_edit: ParameterEdit | None = None
    import_edit: ImportEdit | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {
            "editType": self.edit_type.value,
        }
        if self.target:
            result["target"] = self.target
        if self.location:
            result["location"] = self.location.to_dict()
        if self.new_code:
            result["newCode"] = self.new_code
        if self.parameter_edit:
            result["parameterEdit"] = self.parameter_edit.to_dict()
        if self.import_edit:
            result["importEdit"] = self.import_edit.to_dict()
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CodeEdit":
        """Create from dictionary."""
        location = None
        if "location" in data:
            location = SourceRange.from_dict(data["location"])

        parameter_edit = None
        if "parameterEdit" in data:
            parameter_edit = ParameterEdit.from_dict(data["parameterEdit"])

        import_edit = None
        if "importEdit" in data:
            import_edit = ImportEdit.from_dict(data["importEdit"])

        return cls(
            edit_type=EditType(data["editType"]),
            target=data.get("target"),
            location=location,
            new_code=data.get("newCode"),
            parameter_edit=parameter_edit,
            import_edit=import_edit,
        )


@dataclass
class EditRequest:
    """Request to modify source code."""

    request_id: str
    file_path: str
    source_code: str
    edits: list[CodeEdit]
    dry_run: bool = False
    preserve_formatting: bool = True

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": "edit",
            "requestId": self.request_id,
            "filePath": self.file_path,
            "sourceCode": self.source_code,
            "edits": [e.to_dict() for e in self.edits],
            "dryRun": self.dry_run,
            "preserveFormatting": self.preserve_formatting,
        }

    def to_ndjson(self) -> str:
        """Convert to NDJSON line."""
        return json.dumps(self.to_dict()) + "\n"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "EditRequest":
        """Create from dictionary."""
        return cls(
            request_id=data["requestId"],
            file_path=data["filePath"],
            source_code=data["sourceCode"],
            edits=[CodeEdit.from_dict(e) for e in data["edits"]],
            dry_run=data.get("dryRun", False),
            preserve_formatting=data.get("preserveFormatting", True),
        )


@dataclass
class ParseRequest:
    """Request to parse source code and extract information."""

    request_id: str
    file_path: str
    source_code: str
    extract_parameters: bool = True
    extract_imports: bool = True
    extract_functions: bool = True

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": "parse",
            "requestId": self.request_id,
            "filePath": self.file_path,
            "sourceCode": self.source_code,
            "extractParameters": self.extract_parameters,
            "extractImports": self.extract_imports,
            "extractFunctions": self.extract_functions,
        }

    def to_ndjson(self) -> str:
        """Convert to NDJSON line."""
        return json.dumps(self.to_dict()) + "\n"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ParseRequest":
        """Create from dictionary."""
        return cls(
            request_id=data["requestId"],
            file_path=data["filePath"],
            source_code=data["sourceCode"],
            extract_parameters=data.get("extractParameters", True),
            extract_imports=data.get("extractImports", True),
            extract_functions=data.get("extractFunctions", True),
        )


@dataclass
class DiffHunk:
    """A hunk in a unified diff."""

    old_start: int
    old_count: int
    new_start: int
    new_count: int
    content: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "oldStart": self.old_start,
            "oldCount": self.old_count,
            "newStart": self.new_start,
            "newCount": self.new_count,
            "content": self.content,
        }


@dataclass
class EditResult:
    """Result of a single edit operation."""

    edit_index: int
    success: bool
    error: str | None = None
    location: SourceRange | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {
            "editIndex": self.edit_index,
            "success": self.success,
        }
        if self.error:
            result["error"] = self.error
        if self.location:
            result["location"] = self.location.to_dict()
        return result


@dataclass
class EditResponse:
    """Response to an edit request."""

    request_id: str
    status: EditStatus
    modified_code: str | None = None
    diff: str | None = None
    hunks: list[DiffHunk] = field(default_factory=list)
    results: list[EditResult] = field(default_factory=list)
    error: str | None = None
    error_location: SourceLocation | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {
            "type": "editResponse",
            "requestId": self.request_id,
            "status": self.status.value,
        }
        if self.modified_code is not None:
            result["modifiedCode"] = self.modified_code
        if self.diff is not None:
            result["diff"] = self.diff
        if self.hunks:
            result["hunks"] = [h.to_dict() for h in self.hunks]
        if self.results:
            result["results"] = [r.to_dict() for r in self.results]
        if self.error:
            result["error"] = self.error
        if self.error_location:
            result["errorLocation"] = self.error_location.to_dict()
        return result

    def to_ndjson(self) -> str:
        """Convert to NDJSON line."""
        return json.dumps(self.to_dict()) + "\n"


@dataclass
class ParameterInfo:
    """Information about a parameter in source code."""

    name: str
    value: Any
    value_type: str
    location: SourceRange
    description: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {
            "name": self.name,
            "value": self.value,
            "valueType": self.value_type,
            "location": self.location.to_dict(),
        }
        if self.description:
            result["description"] = self.description
        return result


@dataclass
class ImportInfo:
    """Information about an import in source code."""

    module: str
    names: list[str]
    alias: str | None
    is_from_import: bool
    location: SourceRange

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "module": self.module,
            "names": self.names,
            "alias": self.alias,
            "isFromImport": self.is_from_import,
            "location": self.location.to_dict(),
        }


@dataclass
class FunctionInfo:
    """Information about a function in source code."""

    name: str
    parameters: list[str]
    decorators: list[str]
    location: SourceRange
    docstring: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {
            "name": self.name,
            "parameters": self.parameters,
            "decorators": self.decorators,
            "location": self.location.to_dict(),
        }
        if self.docstring:
            result["docstring"] = self.docstring
        return result


@dataclass
class ParseResponse:
    """Response to a parse request."""

    request_id: str
    status: EditStatus
    parameters: list[ParameterInfo] = field(default_factory=list)
    imports: list[ImportInfo] = field(default_factory=list)
    functions: list[FunctionInfo] = field(default_factory=list)
    error: str | None = None
    error_location: SourceLocation | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        result: dict[str, Any] = {
            "type": "parseResponse",
            "requestId": self.request_id,
            "status": self.status.value,
        }
        if self.parameters:
            result["parameters"] = [p.to_dict() for p in self.parameters]
        if self.imports:
            result["imports"] = [i.to_dict() for i in self.imports]
        if self.functions:
            result["functions"] = [f.to_dict() for f in self.functions]
        if self.error:
            result["error"] = self.error
        if self.error_location:
            result["errorLocation"] = self.error_location.to_dict()
        return result

    def to_ndjson(self) -> str:
        """Convert to NDJSON line."""
        return json.dumps(self.to_dict()) + "\n"


class CodeModParser:
    """Parser for code modification NDJSON messages."""

    def __init__(self) -> None:
        """Initialize parser."""
        self._buffer = ""

    def feed(self, data: str) -> list[dict[str, Any]]:
        """
        Feed data to parser and return complete messages.

        Args:
            data: Input data

        Returns:
            List of parsed message dictionaries
        """
        self._buffer += data
        messages = []

        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            line = line.strip()
            if not line:
                continue

            try:
                msg = json.loads(line)
                messages.append(msg)
            except json.JSONDecodeError:
                # Skip invalid JSON
                pass

        return messages

    def flush(self) -> list[dict[str, Any]]:
        """Flush any remaining buffered data."""
        messages = []
        if self._buffer.strip():
            try:
                msg = json.loads(self._buffer.strip())
                messages.append(msg)
            except json.JSONDecodeError:
                pass
        self._buffer = ""
        return messages

    def parse_request(self, data: dict[str, Any]) -> EditRequest | ParseRequest:
        """
        Parse a request dictionary into appropriate request type.

        Args:
            data: Request dictionary

        Returns:
            Parsed request object

        Raises:
            ValueError: If request type is unknown
        """
        msg_type = data.get("type")
        if msg_type == "edit":
            return EditRequest.from_dict(data)
        elif msg_type == "parse":
            return ParseRequest.from_dict(data)
        else:
            raise ValueError(f"Unknown request type: {msg_type}")


class CodeModWriter:
    """Writer for code modification NDJSON messages."""

    def __init__(
        self,
        output_func: Any = None,
    ) -> None:
        """
        Initialize writer.

        Args:
            output_func: Function to call with output (default: print)
        """
        self._output = output_func or print

    def write(self, message: str) -> None:
        """Write a raw message."""
        self._output(message.rstrip("\n"))

    def edit_response(
        self,
        request_id: str,
        status: EditStatus,
        modified_code: str | None = None,
        diff: str | None = None,
        results: list[EditResult] | None = None,
        error: str | None = None,
    ) -> None:
        """Write an edit response."""
        response = EditResponse(
            request_id=request_id,
            status=status,
            modified_code=modified_code,
            diff=diff,
            results=results or [],
            error=error,
        )
        self.write(response.to_ndjson())

    def parse_response(
        self,
        request_id: str,
        status: EditStatus,
        parameters: list[ParameterInfo] | None = None,
        imports: list[ImportInfo] | None = None,
        functions: list[FunctionInfo] | None = None,
        error: str | None = None,
    ) -> None:
        """Write a parse response."""
        response = ParseResponse(
            request_id=request_id,
            status=status,
            parameters=parameters or [],
            imports=imports or [],
            functions=functions or [],
            error=error,
        )
        self.write(response.to_ndjson())

    def error(
        self,
        request_id: str,
        error: str,
        error_location: SourceLocation | None = None,
    ) -> None:
        """Write an error response."""
        response = EditResponse(
            request_id=request_id,
            status=EditStatus.FAILED,
            error=error,
            error_location=error_location,
        )
        self.write(response.to_ndjson())

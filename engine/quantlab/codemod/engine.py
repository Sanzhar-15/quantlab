"""
Code Modification Engine.

Main engine for parsing and modifying Python source code.

Spec Reference: Technical Spec §20.5, Phase 6 Code Modification Contract
"""

import difflib
from typing import Any

import libcst as cst
from libcst import metadata

from .protocol import (
    CodeEdit,
    EditRequest,
    EditResponse,
    EditResult,
    EditStatus,
    EditType,
    FunctionInfo,
    ImportInfo,
    ParameterInfo,
    ParseRequest,
    ParseResponse,
    SourceLocation,
    SourceRange,
)
from .transformers import (
    AssignmentTransformer,
    CodeInserter,
    FunctionBodyTransformer,
    ImportTransformer,
    ParameterTransformer,
    apply_edits,
)


class SourceAnalyzer(cst.CSTVisitor):
    """
    Analyzes source code to extract information.

    Extracts parameters, imports, and function definitions.
    """

    METADATA_DEPENDENCIES = (cst.metadata.PositionProvider,)

    def __init__(self) -> None:
        """Initialize analyzer."""
        super().__init__()
        self.parameters: list[ParameterInfo] = []
        self.imports: list[ImportInfo] = []
        self.functions: list[FunctionInfo] = []
        self._param_call_names = {"param", "ql.param"}

    def visit_SimpleStatementLine(
        self,
        node: cst.SimpleStatementLine,
    ) -> bool:
        """Process simple statement lines."""
        if len(node.body) != 1:
            return True

        stmt = node.body[0]

        # Check for parameter assignment: name = param(...)
        if isinstance(stmt, cst.Assign):
            self._check_parameter_assignment(stmt, node)

        return True

    def visit_Import(self, node: cst.Import) -> bool:
        """Process import statements."""
        if isinstance(node.names, cst.ImportStar):
            return True

        for alias in node.names:
            module_name = self._get_name(alias.name)
            alias_name = None
            if alias.asname and isinstance(alias.asname.name, cst.Name):
                alias_name = alias.asname.name.value

            pos = self._get_position(node)
            # Add import even if position is not available
            if pos is None:
                pos = SourceRange(
                    start=SourceLocation(line=1, column=0),
                    end=SourceLocation(line=1, column=0),
                )
            self.imports.append(ImportInfo(
                module=module_name,
                names=[],
                alias=alias_name,
                is_from_import=False,
                location=pos,
            ))

        return True

    def visit_ImportFrom(self, node: cst.ImportFrom) -> bool:
        """Process from ... import ... statements."""
        if node.module is None:
            return True

        module_name = self._get_name(node.module)

        names = []
        if isinstance(node.names, cst.ImportStar):
            names = ["*"]
        else:
            for alias in node.names:
                if isinstance(alias.name, cst.Name):
                    names.append(alias.name.value)

        pos = self._get_position(node)
        # Add import even if position is not available
        if pos is None:
            pos = SourceRange(
                start=SourceLocation(line=1, column=0),
                end=SourceLocation(line=1, column=0),
            )
        self.imports.append(ImportInfo(
            module=module_name,
            names=names,
            alias=None,
            is_from_import=True,
            location=pos,
        ))

        return True

    def visit_FunctionDef(self, node: cst.FunctionDef) -> bool:
        """Process function definitions."""
        name = node.name.value

        # Get parameters
        params = []
        for param in node.params.params:
            if isinstance(param.name, cst.Name):
                params.append(param.name.value)

        # Get decorators
        decorators = []
        for dec in node.decorators:
            if isinstance(dec.decorator, cst.Name):
                decorators.append(dec.decorator.value)
            elif isinstance(dec.decorator, cst.Attribute):
                decorators.append(self._get_name(dec.decorator))
            elif isinstance(dec.decorator, cst.Call):
                if isinstance(dec.decorator.func, cst.Name):
                    decorators.append(dec.decorator.func.value)

        # Get docstring
        docstring = None
        if isinstance(node.body, cst.IndentedBlock) and node.body.body:
            first_stmt = node.body.body[0]
            if isinstance(first_stmt, cst.SimpleStatementLine):
                if first_stmt.body and isinstance(first_stmt.body[0], cst.Expr):
                    expr = first_stmt.body[0].value
                    if isinstance(expr, cst.SimpleString):
                        docstring = expr.value.strip('"\'')

        pos = self._get_position(node)
        # Add function even if position is not available
        if pos is None:
            pos = SourceRange(
                start=SourceLocation(line=1, column=0),
                end=SourceLocation(line=1, column=0),
            )
        self.functions.append(FunctionInfo(
            name=name,
            parameters=params,
            decorators=decorators,
            location=pos,
            docstring=docstring,
        ))

        return True

    def _check_parameter_assignment(
        self,
        assign: cst.Assign,
        stmt: cst.SimpleStatementLine,
    ) -> None:
        """Check if assignment is a parameter definition."""
        if len(assign.targets) != 1:
            return

        target = assign.targets[0].target
        if not isinstance(target, cst.Name):
            return

        var_name = target.value
        value = assign.value

        # Check if value is a param() call
        if not isinstance(value, cst.Call):
            return

        func = value.func
        call_name = None

        if isinstance(func, cst.Name):
            call_name = func.value
        elif isinstance(func, cst.Attribute):
            call_name = self._get_name(func)

        if call_name not in self._param_call_names:
            return

        # Extract the default value
        default_value = None
        value_type = "unknown"

        if value.args:
            first_arg = value.args[0].value
            default_value, value_type = self._extract_value(first_arg)

        # Get description from second arg if present
        description = None
        if len(value.args) > 1:
            second_arg = value.args[1]
            if second_arg.keyword and second_arg.keyword.value == "description":
                if isinstance(second_arg.value, cst.SimpleString):
                    description = second_arg.value.value.strip('"\'')

        pos = self._get_position(stmt)
        # Add parameter even if position is not available
        if pos is None:
            pos = SourceRange(
                start=SourceLocation(line=1, column=0),
                end=SourceLocation(line=1, column=0),
            )
        self.parameters.append(ParameterInfo(
            name=var_name,
            value=default_value,
            value_type=value_type,
            location=pos,
            description=description,
        ))

    def _extract_value(self, node: cst.BaseExpression) -> tuple[Any, str]:
        """Extract a Python value from a CST node."""
        if isinstance(node, cst.Integer):
            return int(node.value), "int"
        elif isinstance(node, cst.Float):
            return float(node.value), "float"
        elif isinstance(node, cst.SimpleString):
            # Remove quotes
            val = node.value
            if val.startswith(('"""', "'''")):
                val = val[3:-3]
            elif val.startswith(('"', "'")):
                val = val[1:-1]
            return val, "str"
        elif isinstance(node, cst.Name):
            if node.value == "True":
                return True, "bool"
            elif node.value == "False":
                return False, "bool"
            elif node.value == "None":
                return None, "none"
            return node.value, "name"
        elif isinstance(node, cst.List):
            items = []
            for el in node.elements:
                if isinstance(el, cst.Element):
                    val, _ = self._extract_value(el.value)
                    items.append(val)
            return items, "list"
        elif isinstance(node, cst.Tuple):
            items = []
            for el in node.elements:
                if isinstance(el, cst.Element):
                    val, _ = self._extract_value(el.value)
                    items.append(val)
            return tuple(items), "tuple"
        elif isinstance(node, cst.Dict):
            items = {}
            for el in node.elements:
                if isinstance(el, cst.DictElement):
                    key, _ = self._extract_value(el.key)
                    val, _ = self._extract_value(el.value)
                    items[key] = val
            return items, "dict"
        elif isinstance(node, cst.UnaryOperation):
            # Handle negative numbers
            if isinstance(node.operator, cst.Minus):
                val, vtype = self._extract_value(node.expression)
                if isinstance(val, (int, float)):
                    return -val, vtype
        return None, "unknown"

    def _get_name(self, node: cst.BaseExpression) -> str:
        """Get the full name from a Name or Attribute node."""
        if isinstance(node, cst.Name):
            return node.value
        elif isinstance(node, cst.Attribute):
            base = self._get_name(node.value)
            return f"{base}.{node.attr.value}"
        return ""

    def _get_position(self, node: cst.CSTNode) -> SourceRange | None:
        """Get source position of a node."""
        try:
            pos = self.metadata.get(cst.metadata.PositionProvider, node)
            if pos:
                return SourceRange(
                    start=SourceLocation(
                        line=pos.start.line,
                        column=pos.start.column,
                    ),
                    end=SourceLocation(
                        line=pos.end.line,
                        column=pos.end.column,
                    ),
                )
        except Exception:
            pass
        return None


class CodeModEngine:
    """
    Main code modification engine.

    Handles parsing, analysis, and modification of Python source code.
    """

    def __init__(self) -> None:
        """Initialize engine."""
        pass

    def parse(self, request: ParseRequest) -> ParseResponse:
        """
        Parse source code and extract information.

        Args:
            request: Parse request

        Returns:
            Parse response with extracted information
        """
        try:
            tree = cst.parse_module(request.source_code)
        except Exception as e:
            # Handle all parse errors uniformly
            error_msg = str(e)
            error_line = 1

            # Try to extract line number from error message
            if hasattr(e, 'lines') and e.lines:
                error_line = e.lines[0]
            elif hasattr(e, 'message'):
                error_msg = e.message

            return ParseResponse(
                request_id=request.request_id,
                status=EditStatus.PARSE_ERROR,
                error=f"Syntax error: {error_msg}",
                error_location=SourceLocation(
                    line=error_line,
                    column=0,
                ),
            )

        # Wrap with metadata
        try:
            wrapper = metadata.MetadataWrapper(tree)
            analyzer = SourceAnalyzer()
            wrapper.visit(analyzer)
        except Exception as e:
            return ParseResponse(
                request_id=request.request_id,
                status=EditStatus.FAILED,
                error=f"Analysis error: {str(e)}",
            )

        return ParseResponse(
            request_id=request.request_id,
            status=EditStatus.SUCCESS,
            parameters=analyzer.parameters if request.extract_parameters else [],
            imports=analyzer.imports if request.extract_imports else [],
            functions=analyzer.functions if request.extract_functions else [],
        )

    def edit(self, request: EditRequest) -> EditResponse:
        """
        Apply edits to source code.

        Args:
            request: Edit request

        Returns:
            Edit response with modified code
        """
        if not request.edits:
            return EditResponse(
                request_id=request.request_id,
                status=EditStatus.SUCCESS,
                modified_code=None if request.dry_run else request.source_code,
            )

        try:
            modified_code, success_flags = apply_edits(
                request.source_code,
                request.edits,
            )
        except ValueError as e:
            return EditResponse(
                request_id=request.request_id,
                status=EditStatus.PARSE_ERROR,
                error=str(e),
            )
        except Exception as e:
            return EditResponse(
                request_id=request.request_id,
                status=EditStatus.FAILED,
                error=f"Edit failed: {str(e)}",
            )

        # Validate the modified code parses correctly
        try:
            cst.parse_module(modified_code)
        except Exception as e:
            return EditResponse(
                request_id=request.request_id,
                status=EditStatus.VALIDATION_ERROR,
                error=f"Modified code has syntax errors: {str(e)}",
                modified_code=modified_code,
            )

        # Create edit results
        results = [
            EditResult(edit_index=i, success=success)
            for i, success in enumerate(success_flags)
        ]

        # Determine overall status
        all_success = all(success_flags)
        any_success = any(success_flags)

        if all_success:
            status = EditStatus.SUCCESS
        elif any_success:
            status = EditStatus.PARTIAL
        else:
            status = EditStatus.FAILED

        # Generate diff
        diff = None
        if not request.dry_run:
            diff = self._generate_diff(
                request.source_code,
                modified_code,
                request.file_path,
            )

        return EditResponse(
            request_id=request.request_id,
            status=status,
            modified_code=modified_code if not request.dry_run else None,
            diff=diff,
            results=results,
        )

    def _generate_diff(
        self,
        original: str,
        modified: str,
        file_path: str,
    ) -> str:
        """Generate a unified diff between original and modified code."""
        original_lines = original.splitlines(keepends=True)
        modified_lines = modified.splitlines(keepends=True)

        diff_lines = difflib.unified_diff(
            original_lines,
            modified_lines,
            fromfile=f"a/{file_path}",
            tofile=f"b/{file_path}",
        )

        return "".join(diff_lines)

    def validate_syntax(self, source_code: str) -> tuple[bool, str | None]:
        """
        Validate that source code has correct Python syntax.

        Args:
            source_code: Source code to validate

        Returns:
            Tuple of (is_valid, error_message)
        """
        try:
            cst.parse_module(source_code)
            return True, None
        except Exception as e:
            error_msg = str(e)
            error_line = "?"

            # Try to extract line number from error
            if hasattr(e, 'lines') and e.lines:
                error_line = e.lines[0]
            elif hasattr(e, 'message'):
                error_msg = e.message

            return False, f"Syntax error at line {error_line}: {error_msg}"

    def format_preserving_edit(
        self,
        source_code: str,
        old_code: str,
        new_code: str,
    ) -> str | None:
        """
        Replace old_code with new_code while preserving surrounding formatting.

        Args:
            source_code: Original source code
            old_code: Code to find and replace
            new_code: Replacement code

        Returns:
            Modified source code or None if old_code not found
        """
        if old_code not in source_code:
            return None

        return source_code.replace(old_code, new_code, 1)


def create_parameter_edit(
    name: str,
    new_value: Any,
    old_value: Any | None = None,
) -> CodeEdit:
    """
    Create a parameter change edit.

    Args:
        name: Parameter name
        new_value: New value
        old_value: Optional old value for verification

    Returns:
        CodeEdit for parameter change
    """
    from .protocol import ParameterEdit

    return CodeEdit(
        edit_type=EditType.PARAMETER_CHANGE,
        target=name,
        parameter_edit=ParameterEdit(
            name=name,
            new_value=new_value,
            old_value=old_value,
        ),
    )


def create_import_edit(
    module: str,
    names: list[str] | None = None,
    alias: str | None = None,
    is_from_import: bool = True,
    remove: bool = False,
) -> CodeEdit:
    """
    Create an import add/remove edit.

    Args:
        module: Module name
        names: Names to import (for from imports)
        alias: Import alias
        is_from_import: Whether this is a from import
        remove: Whether to remove instead of add

    Returns:
        CodeEdit for import change
    """
    from .protocol import ImportEdit

    return CodeEdit(
        edit_type=EditType.REMOVE_IMPORT if remove else EditType.ADD_IMPORT,
        import_edit=ImportEdit(
            module=module,
            names=names or [],
            alias=alias,
            is_from_import=is_from_import,
        ),
    )

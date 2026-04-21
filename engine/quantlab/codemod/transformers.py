"""
LibCST-based Code Transformers.

Transformers that modify Python code while preserving formatting.

Spec Reference: Technical Spec §20.5, Phase 6 Code Modification Contract
"""

from typing import Any
from typing import Sequence

import libcst as cst
from libcst import matchers as m

from .protocol import (
    CodeEdit,
    EditType,
    ImportEdit,
    ParameterEdit,
    SourceLocation,
    SourceRange,
)


def _value_to_cst(value: Any) -> cst.BaseExpression:
    """
    Convert a Python value to a CST expression node.

    Args:
        value: Python value

    Returns:
        CST expression node
    """
    if value is None:
        return cst.Name("None")
    elif isinstance(value, bool):
        return cst.Name("True" if value else "False")
    elif isinstance(value, int):
        return cst.Integer(str(value))
    elif isinstance(value, float):
        return cst.Float(str(value))
    elif isinstance(value, str):
        # Preserve quote style if possible, default to double quotes
        return cst.SimpleString(f'"{value}"')
    elif isinstance(value, list):
        elements = [cst.Element(value=_value_to_cst(v)) for v in value]
        return cst.List(elements=elements)
    elif isinstance(value, dict):
        items = [
            cst.DictElement(
                key=_value_to_cst(k),
                value=_value_to_cst(v),
            )
            for k, v in value.items()
        ]
        return cst.Dict(elements=items)
    elif isinstance(value, tuple):
        elements = [cst.Element(value=_value_to_cst(v)) for v in value]
        return cst.Tuple(elements=elements)
    else:
        # Fallback: convert to string representation
        return cst.SimpleString(f'"{value}"')


def _get_position(node: cst.CSTNode, wrapper: cst.MetadataWrapper) -> SourceRange | None:
    """
    Get the source position of a CST node.

    Args:
        node: CST node
        wrapper: Metadata wrapper

    Returns:
        Source range or None
    """
    try:
        pos = wrapper.resolve(cst.metadata.PositionProvider)[node]
        return SourceRange(
            start=SourceLocation(line=pos.start.line, column=pos.start.column),
            end=SourceLocation(line=pos.end.line, column=pos.end.column),
        )
    except KeyError:
        return None


class ParameterTransformer(cst.CSTTransformer):
    """
    Transforms ql.param() calls to update parameter values.

    Preserves formatting, comments, and whitespace.
    """

    METADATA_DEPENDENCIES = (cst.metadata.PositionProvider,)

    def __init__(
        self,
        edits: list[ParameterEdit],
        param_call_names: Sequence[str] = ("param", "ql.param"),
    ) -> None:
        """
        Initialize transformer.

        Args:
            edits: Parameter edits to apply
            param_call_names: Names of param functions to match
        """
        super().__init__()
        self._edits = {e.name: e for e in edits}
        self._param_names = param_call_names
        self._applied: list[str] = []
        self._positions: dict[str, SourceRange] = {}

    @property
    def applied_edits(self) -> list[str]:
        """Get names of applied edits."""
        return self._applied

    @property
    def positions(self) -> dict[str, SourceRange]:
        """Get positions of modified parameters."""
        return self._positions

    def leave_SimpleStatementLine(
        self,
        original_node: cst.SimpleStatementLine,
        updated_node: cst.SimpleStatementLine,
    ) -> cst.SimpleStatementLine:
        """Process simple statement lines for parameter assignments."""
        # Look for: name = param(...) or name = ql.param(...)
        if len(updated_node.body) != 1:
            return updated_node

        stmt = updated_node.body[0]
        if not isinstance(stmt, cst.Assign):
            return updated_node

        # Get the variable name
        if len(stmt.targets) != 1:
            return updated_node

        target = stmt.targets[0].target
        if not isinstance(target, cst.Name):
            return updated_node

        var_name = target.value

        # Check if this parameter should be edited
        if var_name not in self._edits:
            return updated_node

        edit = self._edits[var_name]

        # Check if the value is a param() call
        value = stmt.value
        if not self._is_param_call(value):
            return updated_node

        # Modify the param call
        new_value = self._modify_param_call(value, edit.new_value)

        # Create new assignment
        new_stmt = stmt.with_changes(value=new_value)
        self._applied.append(var_name)

        return updated_node.with_changes(body=[new_stmt])

    def _is_param_call(self, node: cst.BaseExpression) -> bool:
        """Check if node is a param() or ql.param() call."""
        if not isinstance(node, cst.Call):
            return False

        func = node.func

        # Check for simple param(...)
        if isinstance(func, cst.Name) and func.value in self._param_names:
            return True

        # Check for ql.param(...)
        if isinstance(func, cst.Attribute):
            if isinstance(func.value, cst.Name):
                full_name = f"{func.value.value}.{func.attr.value}"
                if full_name in self._param_names:
                    return True

        return False

    def _modify_param_call(
        self,
        call: cst.Call,
        new_value: Any,
    ) -> cst.Call:
        """Modify a param() call with a new default value."""
        new_value_node = _value_to_cst(new_value)

        # If there are existing args, replace the first one
        if call.args:
            new_args = [
                call.args[0].with_changes(value=new_value_node),
                *call.args[1:],
            ]
            return call.with_changes(args=new_args)
        else:
            # Add the value as first argument
            new_args = [cst.Arg(value=new_value_node)]
            return call.with_changes(args=new_args)


class ImportTransformer(cst.CSTTransformer):
    """
    Transforms import statements.

    Handles adding and removing imports while preserving formatting.
    """

    def __init__(
        self,
        add_imports: list[ImportEdit] | None = None,
        remove_imports: list[ImportEdit] | None = None,
    ) -> None:
        """
        Initialize transformer.

        Args:
            add_imports: Imports to add
            remove_imports: Imports to remove
        """
        super().__init__()
        self._add_imports = add_imports or []
        self._remove_imports = remove_imports or []
        self._imports_added = False
        self._removed: list[str] = []

    @property
    def removed_imports(self) -> list[str]:
        """Get list of removed import modules."""
        return self._removed

    def leave_ImportFrom(
        self,
        original_node: cst.ImportFrom,
        updated_node: cst.ImportFrom,
    ) -> cst.ImportFrom | cst.RemovalSentinel:
        """Process from ... import ... statements."""
        # Check for removal
        if isinstance(updated_node.module, cst.Attribute):
            module_name = self._get_module_name(updated_node.module)
        elif isinstance(updated_node.module, cst.Name):
            module_name = updated_node.module.value
        else:
            return updated_node

        for remove in self._remove_imports:
            if remove.module == module_name:
                self._removed.append(module_name)
                return cst.RemovalSentinel.REMOVE

        return updated_node

    def leave_Import(
        self,
        original_node: cst.Import,
        updated_node: cst.Import,
    ) -> cst.Import | cst.RemovalSentinel:
        """Process import ... statements."""
        # Check for removal
        if isinstance(updated_node.names, cst.ImportStar):
            return updated_node

        for alias in updated_node.names:
            if isinstance(alias.name, cst.Name):
                module_name = alias.name.value
            elif isinstance(alias.name, cst.Attribute):
                module_name = self._get_module_name(alias.name)
            else:
                continue

            for remove in self._remove_imports:
                if remove.module == module_name:
                    self._removed.append(module_name)
                    return cst.RemovalSentinel.REMOVE

        return updated_node

    def leave_Module(
        self,
        original_node: cst.Module,
        updated_node: cst.Module,
    ) -> cst.Module:
        """Add new imports at the top of the module."""
        if not self._add_imports or self._imports_added:
            return updated_node

        new_imports = []
        for imp in self._add_imports:
            if imp.is_from_import:
                # Create: from module import name1, name2
                names = [
                    cst.ImportAlias(name=cst.Name(n))
                    for n in imp.names
                ]
                new_import = cst.SimpleStatementLine(
                    body=[
                        cst.ImportFrom(
                            module=self._create_module_attr(imp.module),
                            names=names,
                        )
                    ]
                )
            else:
                # Create: import module
                if imp.alias:
                    alias = cst.ImportAlias(
                        name=self._create_module_attr(imp.module),
                        asname=cst.AsName(
                            whitespace_before_as=cst.SimpleWhitespace(" "),
                            whitespace_after_as=cst.SimpleWhitespace(" "),
                            name=cst.Name(imp.alias),
                        ),
                    )
                else:
                    alias = cst.ImportAlias(
                        name=self._create_module_attr(imp.module),
                    )
                new_import = cst.SimpleStatementLine(
                    body=[cst.Import(names=[alias])]
                )

            new_imports.append(new_import)

        # Find insertion point (after existing imports, before other code)
        insert_idx = 0
        for i, stmt in enumerate(updated_node.body):
            if isinstance(stmt, cst.SimpleStatementLine):
                if any(
                    isinstance(s, (cst.Import, cst.ImportFrom))
                    for s in stmt.body
                ):
                    insert_idx = i + 1
                    continue
            # Skip docstrings at the top
            if i == 0 and isinstance(stmt, cst.SimpleStatementLine):
                if any(isinstance(s, cst.Expr) for s in stmt.body):
                    first_stmt = stmt.body[0]
                    if isinstance(first_stmt, cst.Expr):
                        if isinstance(first_stmt.value, cst.SimpleString):
                            insert_idx = 1
                            continue

        # Insert new imports
        new_body = list(updated_node.body)
        for imp in reversed(new_imports):
            new_body.insert(insert_idx, imp)

        self._imports_added = True
        return updated_node.with_changes(body=new_body)

    def _get_module_name(self, node: cst.Attribute | cst.Name) -> str:
        """Get the full module name from an Attribute or Name node."""
        if isinstance(node, cst.Name):
            return node.value
        elif isinstance(node, cst.Attribute):
            value = self._get_module_name(node.value)
            return f"{value}.{node.attr.value}"
        return ""

    def _create_module_attr(
        self,
        module_name: str,
    ) -> cst.Attribute | cst.Name:
        """Create a module Attribute or Name node from a dotted name."""
        parts = module_name.split(".")
        if len(parts) == 1:
            return cst.Name(parts[0])

        result = cst.Name(parts[0])
        for part in parts[1:]:
            result = cst.Attribute(value=result, attr=cst.Name(part))
        return result


class AssignmentTransformer(cst.CSTTransformer):
    """
    Transforms variable assignments.

    Modifies the value of variable assignments.
    """

    def __init__(
        self,
        edits: dict[str, Any],
    ) -> None:
        """
        Initialize transformer.

        Args:
            edits: Map of variable name to new value
        """
        super().__init__()
        self._edits = edits
        self._applied: list[str] = []

    @property
    def applied_edits(self) -> list[str]:
        """Get names of applied edits."""
        return self._applied

    def leave_Assign(
        self,
        original_node: cst.Assign,
        updated_node: cst.Assign,
    ) -> cst.Assign:
        """Process assignment statements."""
        # Get the variable name
        if len(updated_node.targets) != 1:
            return updated_node

        target = updated_node.targets[0].target
        if not isinstance(target, cst.Name):
            return updated_node

        var_name = target.value

        if var_name not in self._edits:
            return updated_node

        # Create new value
        new_value = _value_to_cst(self._edits[var_name])
        self._applied.append(var_name)

        return updated_node.with_changes(value=new_value)


class FunctionBodyTransformer(cst.CSTTransformer):
    """
    Transforms function bodies.

    Replaces or modifies function body content.
    """

    def __init__(
        self,
        function_name: str,
        new_body: str | None = None,
        prepend_code: str | None = None,
        append_code: str | None = None,
    ) -> None:
        """
        Initialize transformer.

        Args:
            function_name: Name of function to modify
            new_body: Complete new body (replaces existing)
            prepend_code: Code to add at start of function
            append_code: Code to add at end of function
        """
        super().__init__()
        self._function_name = function_name
        self._new_body = new_body
        self._prepend_code = prepend_code
        self._append_code = append_code
        self._applied = False

    @property
    def applied(self) -> bool:
        """Check if transformation was applied."""
        return self._applied

    def leave_FunctionDef(
        self,
        original_node: cst.FunctionDef,
        updated_node: cst.FunctionDef,
    ) -> cst.FunctionDef:
        """Process function definitions."""
        if updated_node.name.value != self._function_name:
            return updated_node

        body = updated_node.body

        if self._new_body:
            # Parse the new body and replace
            try:
                new_module = cst.parse_module(self._new_body)
                new_stmts = new_module.body
                body = cst.IndentedBlock(body=new_stmts)
                self._applied = True
            except Exception:
                pass
        else:
            # Prepend or append code
            if isinstance(body, cst.IndentedBlock):
                stmts = list(body.body)

                if self._prepend_code:
                    try:
                        prepend_module = cst.parse_module(self._prepend_code)
                        stmts = list(prepend_module.body) + stmts
                        self._applied = True
                    except Exception:
                        pass

                if self._append_code:
                    try:
                        append_module = cst.parse_module(self._append_code)
                        stmts = stmts + list(append_module.body)
                        self._applied = True
                    except Exception:
                        pass

                body = cst.IndentedBlock(body=stmts)

        return updated_node.with_changes(body=body)


class CodeInserter(cst.CSTTransformer):
    """
    Inserts code at specific locations.
    """

    def __init__(
        self,
        line: int,
        code: str,
        after: bool = True,
    ) -> None:
        """
        Initialize inserter.

        Args:
            line: Line number to insert at
            code: Code to insert
            after: Insert after the line (True) or before (False)
        """
        super().__init__()
        self._line = line
        self._code = code
        self._after = after
        self._applied = False
        self._current_line = 1

    @property
    def applied(self) -> bool:
        """Check if insertion was applied."""
        return self._applied

    def leave_Module(
        self,
        original_node: cst.Module,
        updated_node: cst.Module,
    ) -> cst.Module:
        """Insert code at the specified line."""
        try:
            new_stmts = cst.parse_module(self._code).body
        except Exception:
            return updated_node

        # Find the statement at the target line
        new_body = []
        inserted = False

        for stmt in updated_node.body:
            # Approximate line tracking (would need metadata for precise)
            if not inserted:
                # Insert before or after based on _after flag
                if self._after:
                    new_body.append(stmt)
                    if self._current_line >= self._line:
                        new_body.extend(new_stmts)
                        inserted = True
                        self._applied = True
                else:
                    if self._current_line >= self._line:
                        new_body.extend(new_stmts)
                        inserted = True
                        self._applied = True
                    new_body.append(stmt)

                self._current_line += 1
            else:
                new_body.append(stmt)

        # If not inserted yet, append at end
        if not inserted:
            new_body.extend(new_stmts)
            self._applied = True

        return updated_node.with_changes(body=new_body)


class CodeReplacer(cst.CSTTransformer):
    """
    Replaces code matching a pattern.

    Performs AST-based replacement of code fragments. The old_code pattern
    is parsed and matched against statements in the tree. When a match is
    found, it is replaced with the new_code.
    """

    def __init__(
        self,
        old_code: str,
        new_code: str,
    ) -> None:
        """
        Initialize replacer.

        Args:
            old_code: Code pattern to find
            new_code: Replacement code
        """
        super().__init__()
        self._old_code = old_code.strip()
        self._new_code = new_code
        self._applied = False

        # Parse the patterns for AST comparison
        try:
            self._old_tree = cst.parse_module(self._old_code)
            self._new_tree = cst.parse_module(self._new_code)
        except Exception:
            # Fall back to string-based comparison if parsing fails
            self._old_tree = None
            self._new_tree = None

    @property
    def applied(self) -> bool:
        """Check if replacement was applied."""
        return self._applied

    def leave_SimpleStatementLine(
        self,
        original_node: cst.SimpleStatementLine,
        updated_node: cst.SimpleStatementLine,
    ) -> cst.BaseStatement | cst.RemovalSentinel | cst.FlattenSentinel[cst.BaseStatement]:
        """Check and replace simple statements."""
        # Get the code representation of this statement
        try:
            node_code = updated_node.body[0] if updated_node.body else None
            if node_code is None:
                return updated_node

            # Use deep_equals for AST comparison if we have parsed trees
            if self._old_tree and self._new_tree:
                if len(self._old_tree.body) == 1:
                    old_stmt = self._old_tree.body[0]
                    if isinstance(old_stmt, cst.SimpleStatementLine):
                        if old_stmt.body and self._nodes_equal(node_code, old_stmt.body[0]):
                            self._applied = True
                            # Return the new statements
                            return self._new_tree.body[0] if len(self._new_tree.body) == 1 else cst.FlattenSentinel(self._new_tree.body)

            # Fall back to string comparison
            node_str = cst.parse_module("").code_for_node(updated_node).strip()
            if node_str == self._old_code:
                self._applied = True
                if self._new_tree and self._new_tree.body:
                    return self._new_tree.body[0] if len(self._new_tree.body) == 1 else cst.FlattenSentinel(self._new_tree.body)

        except Exception:
            pass

        return updated_node

    def leave_FunctionDef(
        self,
        original_node: cst.FunctionDef,
        updated_node: cst.FunctionDef,
    ) -> cst.BaseStatement | cst.RemovalSentinel | cst.FlattenSentinel[cst.BaseStatement]:
        """Check and replace function definitions."""
        try:
            # String-based comparison for function defs
            node_str = cst.parse_module("").code_for_node(updated_node).strip()
            if node_str == self._old_code:
                self._applied = True
                if self._new_tree and self._new_tree.body:
                    return self._new_tree.body[0] if len(self._new_tree.body) == 1 else cst.FlattenSentinel(self._new_tree.body)
        except Exception:
            pass

        return updated_node

    def leave_ClassDef(
        self,
        original_node: cst.ClassDef,
        updated_node: cst.ClassDef,
    ) -> cst.BaseStatement | cst.RemovalSentinel | cst.FlattenSentinel[cst.BaseStatement]:
        """Check and replace class definitions."""
        try:
            node_str = cst.parse_module("").code_for_node(updated_node).strip()
            if node_str == self._old_code:
                self._applied = True
                if self._new_tree and self._new_tree.body:
                    return self._new_tree.body[0] if len(self._new_tree.body) == 1 else cst.FlattenSentinel(self._new_tree.body)
        except Exception:
            pass

        return updated_node

    def _nodes_equal(self, node1: cst.CSTNode, node2: cst.CSTNode) -> bool:
        """
        Check if two CST nodes are semantically equal.

        Compares the structure of nodes, ignoring whitespace and formatting.
        """
        try:
            # Deep comparison using the code representation
            code1 = cst.parse_module("").code_for_node(node1).strip()
            code2 = cst.parse_module("").code_for_node(node2).strip()
            return code1 == code2
        except Exception:
            return False


def apply_edits(
    source: str,
    edits: list[CodeEdit],
) -> tuple[str, list[bool]]:
    """
    Apply a list of edits to source code.

    Args:
        source: Original source code
        edits: Edits to apply

    Returns:
        Tuple of (modified source, list of success flags per edit)
    """
    try:
        tree = cst.parse_module(source)
    except Exception as e:
        raise ValueError(f"Failed to parse source: {e}")

    results = [False] * len(edits)

    # Group edits by type for efficient processing
    param_edits = []
    add_imports = []
    remove_imports = []
    assignment_edits = {}

    for i, edit in enumerate(edits):
        if edit.edit_type == EditType.PARAMETER_CHANGE and edit.parameter_edit:
            param_edits.append((i, edit.parameter_edit))
        elif edit.edit_type == EditType.ADD_IMPORT and edit.import_edit:
            add_imports.append((i, edit.import_edit))
        elif edit.edit_type == EditType.REMOVE_IMPORT and edit.import_edit:
            remove_imports.append((i, edit.import_edit))
        elif edit.edit_type == EditType.MODIFY_ASSIGNMENT and edit.target:
            assignment_edits[edit.target] = (i, edit.new_code)

    # Apply parameter edits
    if param_edits:
        pe_list = [pe for _, pe in param_edits]
        transformer = ParameterTransformer(pe_list)
        tree = tree.visit(transformer)
        for i, pe in param_edits:
            if pe.name in transformer.applied_edits:
                results[i] = True

    # Apply import edits
    if add_imports or remove_imports:
        add_list = [ie for _, ie in add_imports]
        remove_list = [ie for _, ie in remove_imports]
        transformer = ImportTransformer(add_list, remove_list)
        tree = tree.visit(transformer)
        # Mark all import edits as successful (LibCST handles gracefully)
        for i, _ in add_imports:
            results[i] = True
        for i, ie in remove_imports:
            if ie.module in transformer.removed_imports:
                results[i] = True

    # Apply assignment edits
    if assignment_edits:
        edits_map = {name: code for name, (_, code) in assignment_edits.items()}
        transformer = AssignmentTransformer(edits_map)
        tree = tree.visit(transformer)
        for name, (i, _) in assignment_edits.items():
            if name in transformer.applied_edits:
                results[i] = True

    return tree.code, results

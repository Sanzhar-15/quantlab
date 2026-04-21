"""
LibCST-based Code Transformers.

Provides AST transformers for modifying Python code while preserving formatting.

Spec Reference: Technical Spec §9.2
"""

import logging
from dataclasses import dataclass
from dataclasses import field
from decimal import Decimal
from typing import Any
from typing import Sequence


logger = logging.getLogger(__name__)

try:
    import libcst as cst
    from libcst import matchers as m

    HAS_LIBCST = True
except ImportError:
    HAS_LIBCST = False
    logger.warning(
        "libcst not installed. Code transformation features will be unavailable. "
        "Install with: pip install libcst"
    )


@dataclass
class ParameterChange:
    """Describes a parameter change to make."""

    class_name: str | None  # None for module-level
    param_name: str
    old_value: Any
    new_value: Any


@dataclass
class TransformResult:
    """Result of a code transformation."""

    success: bool
    modified_code: str
    changes_made: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


if HAS_LIBCST:
    class ParameterTransformer(cst.CSTTransformer):
        """
        Transform parameter assignments in Python code.

        Handles:
        - Class attribute assignments (class Foo: x = 10)
        - Keyword arguments in __init__ (def __init__(self, x=10))
        - Module-level assignments (x = 10)
        """

        def __init__(
            self,
            changes: list[ParameterChange],
        ) -> None:
            super().__init__()
            self.changes = changes
            self.changes_made: list[str] = []
            self._current_class: str | None = None

        def visit_ClassDef(self, node: cst.ClassDef) -> bool:
            """Track current class."""
            self._current_class = node.name.value
            return True

        def leave_ClassDef(
            self,
            original_node: cst.ClassDef,
            updated_node: cst.ClassDef,
        ) -> cst.ClassDef:
            """Exit class scope."""
            self._current_class = None
            return updated_node

        def leave_SimpleStatementLine(
            self,
            original_node: cst.SimpleStatementLine,
            updated_node: cst.SimpleStatementLine,
        ) -> cst.SimpleStatementLine:
            """Transform assignment statements."""
            new_body = []

            for stmt in updated_node.body:
                if isinstance(stmt, (cst.Assign, cst.AnnAssign)):
                    new_stmt = self._transform_assignment(stmt)
                    new_body.append(new_stmt)
                else:
                    new_body.append(stmt)

            return updated_node.with_changes(body=new_body)

        def _transform_assignment(
            self,
            node: cst.Assign | cst.AnnAssign,
        ) -> cst.Assign | cst.AnnAssign:
            """Transform a single assignment."""
            # Get the target name
            if isinstance(node, cst.Assign):
                targets = node.targets
                if not targets:
                    return node
                target = targets[0].target
            else:  # AnnAssign
                target = node.target

            if not isinstance(target, cst.Name):
                return node

            param_name = target.value

            # Find matching change
            for change in self.changes:
                if change.param_name != param_name:
                    continue

                # Check class scope
                if change.class_name is not None:
                    if self._current_class != change.class_name:
                        continue
                elif self._current_class is not None:
                    continue  # Looking for module-level but in class

                # Create new value node
                new_value = self._value_to_cst(change.new_value)

                self.changes_made.append(
                    f"Changed {param_name} from {change.old_value} to {change.new_value}"
                )

                if isinstance(node, cst.Assign):
                    return node.with_changes(value=new_value)
                else:
                    return node.with_changes(value=new_value)

            return node

        def _value_to_cst(self, value: Any) -> cst.BaseExpression:
            """Convert Python value to CST node."""
            if isinstance(value, bool):
                return cst.Name("True" if value else "False")
            elif isinstance(value, int):
                if value < 0:
                    return cst.UnaryOperation(
                        operator=cst.Minus(),
                        expression=cst.Integer(str(abs(value))),
                    )
                return cst.Integer(str(value))
            elif isinstance(value, float):
                if value < 0:
                    return cst.UnaryOperation(
                        operator=cst.Minus(),
                        expression=cst.Float(str(abs(value))),
                    )
                return cst.Float(str(value))
            elif isinstance(value, str):
                return cst.SimpleString(f'"{value}"')
            elif isinstance(value, Decimal):
                return cst.Call(
                    func=cst.Name("Decimal"),
                    args=[cst.Arg(cst.SimpleString(f'"{value}"'))],
                )
            elif isinstance(value, list):
                elements = [
                    cst.Element(self._value_to_cst(v))
                    for v in value
                ]
                return cst.List(elements=elements)
            elif isinstance(value, dict):
                elements = [
                    cst.DictElement(
                        key=self._value_to_cst(k),
                        value=self._value_to_cst(v),
                    )
                    for k, v in value.items()
                ]
                return cst.Dict(elements=elements)
            elif value is None:
                return cst.Name("None")
            else:
                # Fallback to string representation
                return cst.SimpleString(f'"{value}"')


    class FunctionParameterTransformer(cst.CSTTransformer):
        """
        Transform function parameter defaults.

        Modifies default values in function signatures.
        """

        def __init__(
            self,
            function_name: str,
            param_changes: dict[str, Any],
        ) -> None:
            super().__init__()
            self.function_name = function_name
            self.param_changes = param_changes
            self.changes_made: list[str] = []

        def leave_FunctionDef(
            self,
            original_node: cst.FunctionDef,
            updated_node: cst.FunctionDef,
        ) -> cst.FunctionDef:
            """Transform function parameters."""
            if updated_node.name.value != self.function_name:
                return updated_node

            params = updated_node.params
            new_params = []

            for param in params.params:
                if param.name.value in self.param_changes:
                    new_value = self.param_changes[param.name.value]
                    new_default = self._value_to_cst(new_value)

                    self.changes_made.append(
                        f"Changed {param.name.value} default to {new_value}"
                    )

                    new_param = param.with_changes(default=new_default)
                    new_params.append(new_param)
                else:
                    new_params.append(param)

            new_params_obj = params.with_changes(params=new_params)
            return updated_node.with_changes(params=new_params_obj)

        def _value_to_cst(self, value: Any) -> cst.BaseExpression:
            """Convert value to CST node."""
            if isinstance(value, bool):
                return cst.Name("True" if value else "False")
            elif isinstance(value, int):
                return cst.Integer(str(value))
            elif isinstance(value, float):
                return cst.Float(str(value))
            elif isinstance(value, str):
                return cst.SimpleString(f'"{value}"')
            elif value is None:
                return cst.Name("None")
            else:
                return cst.SimpleString(f'"{value}"')


def transform_parameters(
    code: str,
    changes: list[ParameterChange],
) -> TransformResult:
    """
    Transform parameters in Python code.

    Args:
        code: Source code to transform
        changes: List of parameter changes

    Returns:
        TransformResult with modified code
    """
    if not HAS_LIBCST:
        return TransformResult(
            success=False,
            modified_code=code,
            errors=["libcst is not installed"],
        )

    try:
        tree = cst.parse_module(code)
        transformer = ParameterTransformer(changes)
        new_tree = tree.visit(transformer)

        return TransformResult(
            success=True,
            modified_code=new_tree.code,
            changes_made=transformer.changes_made,
        )

    except Exception as e:
        return TransformResult(
            success=False,
            modified_code=code,
            errors=[str(e)],
        )


def transform_function_defaults(
    code: str,
    function_name: str,
    param_changes: dict[str, Any],
) -> TransformResult:
    """
    Transform function parameter defaults.

    Args:
        code: Source code
        function_name: Name of function to modify
        param_changes: Dictionary of param_name -> new_value

    Returns:
        TransformResult with modified code
    """
    if not HAS_LIBCST:
        return TransformResult(
            success=False,
            modified_code=code,
            errors=["libcst is not installed"],
        )

    try:
        tree = cst.parse_module(code)
        transformer = FunctionParameterTransformer(function_name, param_changes)
        new_tree = tree.visit(transformer)

        return TransformResult(
            success=True,
            modified_code=new_tree.code,
            changes_made=transformer.changes_made,
        )

    except Exception as e:
        return TransformResult(
            success=False,
            modified_code=code,
            errors=[str(e)],
        )


def validate_syntax(code: str) -> tuple[bool, str]:
    """
    Validate Python syntax.

    Args:
        code: Code to validate

    Returns:
        Tuple of (is_valid, error_message)
    """
    try:
        compile(code, "<string>", "exec")
        return True, ""
    except SyntaxError as e:
        return False, f"Syntax error at line {e.lineno}: {e.msg}"

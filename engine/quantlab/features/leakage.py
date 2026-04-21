"""
Look-Ahead Protection Module.

Detects potential look-ahead bias in feature code using AST analysis.

Per §7.2, detects:
- Forward shifts (shift(-n) where n > 0)
- Future indexing (iloc[-n:] accessing future data)
- Lookahead joins (merge on future dates)

Spec Reference: Technical Spec §7.2
"""

import ast
import logging
from dataclasses import dataclass
from dataclasses import field
from enum import Enum
from typing import Any


logger = logging.getLogger(__name__)


class LeakageType(Enum):
    """Types of look-ahead leakage."""

    FORWARD_SHIFT = "forward_shift"
    FUTURE_INDEX = "future_index"
    LOOKAHEAD_JOIN = "lookahead_join"
    FUTURE_REFERENCE = "future_reference"


@dataclass
class LeakageWarning:
    """Warning about potential look-ahead leakage."""

    leakage_type: LeakageType
    line: int
    column: int
    code_snippet: str
    message: str
    severity: str = "warning"  # "warning" or "error"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": self.leakage_type.value,
            "line": self.line,
            "column": self.column,
            "code": self.code_snippet,
            "message": self.message,
            "severity": self.severity,
        }


@dataclass
class LeakageAnalysisResult:
    """Result of leakage analysis."""

    has_leakage: bool
    warnings: list[LeakageWarning] = field(default_factory=list)
    errors: list[LeakageWarning] = field(default_factory=list)

    @property
    def all_issues(self) -> list[LeakageWarning]:
        """All issues (warnings + errors)."""
        return self.warnings + self.errors

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "hasLeakage": self.has_leakage,
            "warnings": [w.to_dict() for w in self.warnings],
            "errors": [e.to_dict() for e in self.errors],
        }


class LeakageDetector(ast.NodeVisitor):
    """
    AST visitor that detects look-ahead leakage patterns.

    Detects:
    - .shift(-n) calls with negative values
    - .iloc[-n:] slices that might access future
    - merge/join operations on time columns
    - Direct future date references
    """

    def __init__(self, source_lines: list[str]) -> None:
        self.source_lines = source_lines
        self.warnings: list[LeakageWarning] = []
        self.errors: list[LeakageWarning] = []
        self._in_future_context = False

    def get_code_snippet(self, node: ast.AST) -> str:
        """Get code snippet for node."""
        try:
            return self.source_lines[node.lineno - 1].strip()
        except (IndexError, AttributeError):
            return ""

    def visit_Call(self, node: ast.Call) -> None:
        """Visit function calls."""
        # Check for .shift() with negative values
        if isinstance(node.func, ast.Attribute):
            if node.func.attr == "shift":
                self._check_shift_call(node)
            elif node.func.attr in ("merge", "join"):
                self._check_merge_call(node)
            elif node.func.attr == "rolling":
                self._check_rolling_call(node)

        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        """Visit subscript operations (indexing)."""
        # Check for iloc[-n:] patterns
        if isinstance(node.value, ast.Attribute):
            if node.value.attr == "iloc":
                self._check_iloc_slice(node)

        # Check for loc with future dates
        if isinstance(node.value, ast.Attribute):
            if node.value.attr == "loc":
                self._check_loc_slice(node)

        self.generic_visit(node)

    def _check_shift_call(self, node: ast.Call) -> None:
        """Check shift() call for forward shifts."""
        if not node.args:
            return

        arg = node.args[0]

        # Check for negative literal
        if isinstance(arg, ast.UnaryOp) and isinstance(arg.op, ast.USub):
            if isinstance(arg.operand, ast.Constant):
                self.errors.append(
                    LeakageWarning(
                        leakage_type=LeakageType.FORWARD_SHIFT,
                        line=node.lineno,
                        column=node.col_offset,
                        code_snippet=self.get_code_snippet(node),
                        message=f"Forward shift detected: shift(-{arg.operand.value}) accesses future data",
                        severity="error",
                    )
                )

        # Check for negative constant
        elif isinstance(arg, ast.Constant) and isinstance(arg.value, (int, float)):
            if arg.value < 0:
                self.errors.append(
                    LeakageWarning(
                        leakage_type=LeakageType.FORWARD_SHIFT,
                        line=node.lineno,
                        column=node.col_offset,
                        code_snippet=self.get_code_snippet(node),
                        message=f"Forward shift detected: shift({arg.value}) accesses future data",
                        severity="error",
                    )
                )

    def _check_merge_call(self, node: ast.Call) -> None:
        """Check merge/join for potential lookahead."""
        # Look for 'on' keyword argument with time-related column names
        time_columns = {"date", "time", "timestamp", "datetime", "dt"}

        for keyword in node.keywords:
            if keyword.arg == "on":
                if isinstance(keyword.value, ast.Constant):
                    col_name = str(keyword.value.value).lower()
                    if any(tc in col_name for tc in time_columns):
                        self.warnings.append(
                            LeakageWarning(
                                leakage_type=LeakageType.LOOKAHEAD_JOIN,
                                line=node.lineno,
                                column=node.col_offset,
                                code_snippet=self.get_code_snippet(node),
                                message=f"Merge on time column '{keyword.value.value}' may cause lookahead bias",
                                severity="warning",
                            )
                        )

    def _check_rolling_call(self, node: ast.Call) -> None:
        """Check rolling() for center=True which uses future data."""
        for keyword in node.keywords:
            if keyword.arg == "center":
                if isinstance(keyword.value, ast.Constant) and keyword.value.value:
                    self.errors.append(
                        LeakageWarning(
                            leakage_type=LeakageType.FUTURE_REFERENCE,
                            line=node.lineno,
                            column=node.col_offset,
                            code_snippet=self.get_code_snippet(node),
                            message="rolling(center=True) uses future data points",
                            severity="error",
                        )
                    )

    def _check_iloc_slice(self, node: ast.Subscript) -> None:
        """Check iloc slicing for future access."""
        slice_node = node.slice

        # Check for slice with negative stop that could access future
        if isinstance(slice_node, ast.Slice):
            # Check if this is a negative slice that might indicate future access
            # Pattern: iloc[-n:] or iloc[:-n]
            if slice_node.lower is not None:
                if isinstance(slice_node.lower, ast.UnaryOp):
                    if isinstance(slice_node.lower.op, ast.USub):
                        if slice_node.upper is None:
                            # This is iloc[-n:] which gets last n rows - could be future
                            self.warnings.append(
                                LeakageWarning(
                                    leakage_type=LeakageType.FUTURE_INDEX,
                                    line=node.lineno,
                                    column=node.col_offset,
                                    code_snippet=self.get_code_snippet(node),
                                    message="iloc with negative indexing may access future data in streaming context",
                                    severity="warning",
                                )
                            )

    def _check_loc_slice(self, node: ast.Subscript) -> None:
        """Check loc slicing for future date access.

        Detects patterns that might indicate future date slicing:
        - Variables named with future-suggesting names (future_date, tomorrow, etc.)
        - Date arithmetic with positive timedelta (date + timedelta(days=1))
        - BinOp patterns that add time to dates
        """
        slice_node = node.slice

        # Check slice bounds for suspicious patterns
        if isinstance(slice_node, ast.Slice):
            self._check_slice_for_future_access(slice_node.lower, node)
            self._check_slice_for_future_access(slice_node.upper, node)
        else:
            # Single index access
            self._check_slice_for_future_access(slice_node, node)

    def _check_slice_for_future_access(
        self, expr: ast.expr | None, parent_node: ast.Subscript
    ) -> None:
        """Check an expression for patterns indicating future date access."""
        if expr is None:
            return

        # Check for suspicious variable names
        if isinstance(expr, ast.Name):
            suspicious_names = {
                "future_date", "future", "tomorrow", "next_day", "next_date",
                "forward_date", "future_time", "next_timestamp", "lookahead",
                "future_idx", "next_idx",
            }
            name_lower = expr.id.lower()
            if name_lower in suspicious_names or "future" in name_lower:
                self.warnings.append(
                    LeakageWarning(
                        leakage_type=LeakageType.FUTURE_REFERENCE,
                        line=parent_node.lineno,
                        column=parent_node.col_offset,
                        code_snippet=self.get_code_snippet(parent_node),
                        message=f"Variable '{expr.id}' in loc[] may reference future data",
                        severity="warning",
                    )
                )

        # Check for date arithmetic: date + timedelta(...)
        elif isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Add):
            if self._is_timedelta_call(expr.right) or self._is_timedelta_call(expr.left):
                # Check if the timedelta is positive (adding time = future)
                timedelta_node = expr.right if self._is_timedelta_call(expr.right) else expr.left
                if self._is_positive_timedelta(timedelta_node):
                    self.errors.append(
                        LeakageWarning(
                            leakage_type=LeakageType.FUTURE_REFERENCE,
                            line=parent_node.lineno,
                            column=parent_node.col_offset,
                            code_snippet=self.get_code_snippet(parent_node),
                            message="Adding positive timedelta in loc[] accesses future data",
                            severity="error",
                        )
                    )

        # Check for subtraction with negative timedelta (same as adding positive)
        elif isinstance(expr, ast.BinOp) and isinstance(expr.op, ast.Sub):
            if self._is_timedelta_call(expr.right):
                if self._is_negative_timedelta(expr.right):
                    self.errors.append(
                        LeakageWarning(
                            leakage_type=LeakageType.FUTURE_REFERENCE,
                            line=parent_node.lineno,
                            column=parent_node.col_offset,
                            code_snippet=self.get_code_snippet(parent_node),
                            message="Subtracting negative timedelta in loc[] accesses future data",
                            severity="error",
                        )
                    )

    def _is_timedelta_call(self, node: ast.expr) -> bool:
        """Check if node is a timedelta-related call."""
        if not isinstance(node, ast.Call):
            return False

        # Check for timedelta(...), pd.Timedelta(...), datetime.timedelta(...)
        func = node.func
        if isinstance(func, ast.Name):
            return func.id.lower() in {"timedelta", "relativedelta", "dateoffset"}
        elif isinstance(func, ast.Attribute):
            return func.attr.lower() in {"timedelta", "relativedelta", "dateoffset"}
        return False

    def _is_positive_timedelta(self, node: ast.Call) -> bool:
        """Check if a timedelta call has positive time arguments."""
        # Check keyword arguments like days=1, hours=2, etc.
        positive_keywords = {"days", "hours", "minutes", "seconds", "weeks", "months", "years"}

        for kw in node.keywords:
            if kw.arg and kw.arg.lower() in positive_keywords:
                if isinstance(kw.value, ast.Constant):
                    if isinstance(kw.value.value, (int, float)) and kw.value.value > 0:
                        return True
                elif isinstance(kw.value, ast.UnaryOp) and isinstance(kw.value.op, ast.UAdd):
                    return True

        # Check positional arg (first arg is usually days)
        if node.args:
            arg = node.args[0]
            if isinstance(arg, ast.Constant):
                if isinstance(arg.value, (int, float)) and arg.value > 0:
                    return True

        return False

    def _is_negative_timedelta(self, node: ast.Call) -> bool:
        """Check if a timedelta call has negative time arguments."""
        positive_keywords = {"days", "hours", "minutes", "seconds", "weeks", "months", "years"}

        for kw in node.keywords:
            if kw.arg and kw.arg.lower() in positive_keywords:
                if isinstance(kw.value, ast.Constant):
                    if isinstance(kw.value.value, (int, float)) and kw.value.value < 0:
                        return True
                elif isinstance(kw.value, ast.UnaryOp) and isinstance(kw.value.op, ast.USub):
                    return True

        # Check positional arg
        if node.args:
            arg = node.args[0]
            if isinstance(arg, ast.Constant):
                if isinstance(arg.value, (int, float)) and arg.value < 0:
                    return True
            elif isinstance(arg, ast.UnaryOp) and isinstance(arg.op, ast.USub):
                return True

        return False


class FeatureLeakageError(Exception):
    """Exception raised when look-ahead leakage is detected."""

    def __init__(
        self,
        message: str,
        warnings: list[LeakageWarning] | None = None,
    ) -> None:
        super().__init__(message)
        self.warnings = warnings or []


def analyze_code_for_leakage(
    code: str,
    raise_on_error: bool = False,
) -> LeakageAnalysisResult:
    """
    Analyze code for potential look-ahead leakage.

    Args:
        code: Python source code to analyze
        raise_on_error: If True, raise FeatureLeakageError on errors

    Returns:
        LeakageAnalysisResult

    Raises:
        FeatureLeakageError: If raise_on_error and leakage detected
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return LeakageAnalysisResult(
            has_leakage=False,
            warnings=[],
            errors=[
                LeakageWarning(
                    leakage_type=LeakageType.FUTURE_REFERENCE,
                    line=e.lineno or 0,
                    column=e.offset or 0,
                    code_snippet="",
                    message=f"Syntax error: {e.msg}",
                    severity="error",
                )
            ],
        )

    source_lines = code.split("\n")
    detector = LeakageDetector(source_lines)
    detector.visit(tree)

    result = LeakageAnalysisResult(
        has_leakage=len(detector.errors) > 0,
        warnings=detector.warnings,
        errors=detector.errors,
    )

    if raise_on_error and result.has_leakage:
        error_msgs = [e.message for e in result.errors]
        raise FeatureLeakageError(
            f"Look-ahead leakage detected: {'; '.join(error_msgs)}",
            warnings=result.all_issues,
        )

    return result


def analyze_function_for_leakage(
    func: Any,
    raise_on_error: bool = False,
) -> LeakageAnalysisResult:
    """
    Analyze a function for potential look-ahead leakage.

    Args:
        func: Function to analyze
        raise_on_error: If True, raise FeatureLeakageError on errors

    Returns:
        LeakageAnalysisResult
    """
    import inspect

    try:
        source = inspect.getsource(func)
    except OSError:
        return LeakageAnalysisResult(has_leakage=False)

    return analyze_code_for_leakage(source, raise_on_error)


def safe_feature(func: Any) -> Any:
    """
    Decorator that checks a feature function for look-ahead leakage.

    Usage:
        @safe_feature
        def my_feature(data):
            return data.rolling(20).mean()

    Raises FeatureLeakageError if leakage is detected.
    """
    import functools

    # Analyze at decoration time
    result = analyze_function_for_leakage(func)

    if result.has_leakage:
        error_msgs = [e.message for e in result.errors]
        raise FeatureLeakageError(
            f"Look-ahead leakage in {func.__name__}: {'; '.join(error_msgs)}",
            warnings=result.all_issues,
        )

    if result.warnings:
        for warning in result.warnings:
            logger.warning(f"Potential leakage in {func.__name__}: {warning.message}")

    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        return func(*args, **kwargs)

    return wrapper

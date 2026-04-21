"""
Strategy Complexity Analyzer.

Analyzes strategy code to determine safe execution level.

Spec Reference: Technical Spec §8, Phase 3 Chart View MVP
"""

import ast
import re
from dataclasses import dataclass
from dataclasses import field
from enum import Enum
from pathlib import Path
from typing import Any


class ComplexityLevel(Enum):
    """Strategy complexity levels."""

    SAFE = "safe"  # Green - fully interactive, all features enabled
    PARTIAL = "partial"  # Yellow - limited interactivity
    VIEW_ONLY = "view_only"  # Red - display only, no parameter editing


@dataclass
class ComplexityFactor:
    """A factor contributing to complexity."""

    name: str
    category: str
    severity: int  # 1-10
    description: str
    line_number: int | None = None
    evidence: str | None = None


@dataclass
class ComplexityResult:
    """Result of complexity analysis."""

    level: ComplexityLevel
    score: int  # 0-100 (higher = more complex)
    confidence: float  # 0-1
    factors: list[ComplexityFactor] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for API."""
        return {
            "level": self.level.value,
            "score": self.score,
            "confidence": self.confidence,
            "factors": [
                {
                    "name": f.name,
                    "category": f.category,
                    "severity": f.severity,
                    "description": f.description,
                    "lineNumber": f.line_number,
                    "evidence": f.evidence,
                }
                for f in self.factors
            ],
            "warnings": self.warnings,
            "recommendations": self.recommendations,
        }

    @property
    def indicator_dots(self) -> int:
        """Get number of indicator dots (1-5)."""
        if self.score < 20:
            return 1
        elif self.score < 40:
            return 2
        elif self.score < 60:
            return 3
        elif self.score < 80:
            return 4
        else:
            return 5

    @property
    def color(self) -> str:
        """Get indicator color."""
        colors = {
            ComplexityLevel.SAFE: "#059669",  # Green
            ComplexityLevel.PARTIAL: "#d97706",  # Yellow/Amber
            ComplexityLevel.VIEW_ONLY: "#dc2626",  # Red
        }
        return colors[self.level]


class ComplexityAnalyzer:
    """
    Analyze strategy code for complexity and safety.

    Determines whether a strategy can safely have interactive
    parameters, or should be view-only.

    Complexity Factors:
    - External imports (non-standard libraries)
    - Dynamic code (eval, exec, compile)
    - External API calls (requests, httpx)
    - File system access
    - Multi-file imports
    - Complex parameter expressions
    - Parse errors
    """

    # Standard library modules that are safe
    SAFE_STDLIB = {
        "math",
        "statistics",
        "decimal",
        "fractions",
        "random",
        "datetime",
        "time",
        "collections",
        "itertools",
        "functools",
        "operator",
        "typing",
        "dataclasses",
        "enum",
        "abc",
        "copy",
        "json",
        "re",
    }

    # Quantlab modules that are safe
    SAFE_QUANTLAB = {
        "quantlab",
        "ql",
    }

    # Data science modules (safe for computation)
    SAFE_DATA_MODULES = {
        "numpy",
        "np",
        "pandas",
        "pd",
        "scipy",
        "sklearn",
        "ta",  # Technical analysis
        "talib",
    }

    # Dangerous patterns that force VIEW_ONLY
    DANGEROUS_PATTERNS = [
        (r"\beval\s*\(", "eval() usage"),
        (r"\bexec\s*\(", "exec() usage"),
        (r"\bcompile\s*\(", "compile() usage"),
        (r"\b__import__\s*\(", "dynamic import"),
        (r"\bgetattr\s*\([^)]*,\s*['\"][^'\"]+['\"]", "dynamic attribute access"),
        (r"\bos\.system\s*\(", "system command execution"),
        (r"\bsubprocess\.", "subprocess usage"),
        (r"\bopen\s*\([^)]*['\"]w['\"]", "file write access"),
    ]

    # Patterns indicating external API calls
    API_PATTERNS = [
        (r"\brequests\.", "HTTP requests"),
        (r"\bhttpx\.", "HTTP requests"),
        (r"\burllib\.", "URL library"),
        (r"\baiohttp\.", "async HTTP"),
        (r"\.get\s*\(['\"]https?://", "HTTP GET"),
        (r"\.post\s*\(['\"]https?://", "HTTP POST"),
    ]

    # Patterns indicating file system access
    FILESYSTEM_PATTERNS = [
        (r"\bopen\s*\(", "file open"),
        (r"\bPath\s*\(", "Path usage"),
        (r"\bos\.path\.", "OS path operations"),
        (r"\bshutil\.", "file operations"),
        (r"\bglob\.", "glob patterns"),
    ]

    def __init__(self) -> None:
        """Initialize analyzer."""
        self._dangerous_re = [(re.compile(p), d) for p, d in self.DANGEROUS_PATTERNS]
        self._api_re = [(re.compile(p), d) for p, d in self.API_PATTERNS]
        self._filesystem_re = [(re.compile(p), d) for p, d in self.FILESYSTEM_PATTERNS]

    def analyze(self, source: str) -> ComplexityResult:
        """
        Analyze strategy source code for complexity.

        Args:
            source: Strategy source code

        Returns:
            ComplexityResult with analysis
        """
        factors: list[ComplexityFactor] = []
        score = 0

        # Try to parse AST
        try:
            tree = ast.parse(source)
            parse_ok = True
        except SyntaxError as e:
            factors.append(ComplexityFactor(
                name="parse_error",
                category="syntax",
                severity=10,
                description=f"Syntax error: {e.msg}",
                line_number=e.lineno,
            ))
            # Parse error = VIEW_ONLY
            return ComplexityResult(
                level=ComplexityLevel.VIEW_ONLY,
                score=100,
                confidence=1.0,
                factors=factors,
                warnings=["Strategy has syntax errors and cannot be modified"],
            )

        # Analyze imports
        import_factors, import_score = self._analyze_imports(tree)
        factors.extend(import_factors)
        score += import_score

        # Analyze for dangerous patterns
        dangerous_factors = self._analyze_dangerous_patterns(source)
        if dangerous_factors:
            factors.extend(dangerous_factors)
            # Any dangerous pattern = VIEW_ONLY
            return ComplexityResult(
                level=ComplexityLevel.VIEW_ONLY,
                score=100,
                confidence=0.95,
                factors=factors,
                warnings=["Strategy uses dangerous code patterns"],
            )

        # Analyze for external API calls
        api_factors = self._analyze_api_patterns(source)
        if api_factors:
            factors.extend(api_factors)
            score += 30

        # Analyze for filesystem access
        fs_factors = self._analyze_filesystem_patterns(source)
        if fs_factors:
            factors.extend(fs_factors)
            score += 20

        # Analyze function complexity
        func_factors, func_score = self._analyze_functions(tree)
        factors.extend(func_factors)
        score += func_score

        # Analyze class complexity
        class_factors, class_score = self._analyze_classes(tree)
        factors.extend(class_factors)
        score += class_score

        # Analyze dynamic parameter expressions
        param_factors = self._analyze_parameters(tree, source)
        if param_factors:
            factors.extend(param_factors)
            score += len(param_factors) * 5

        # Determine level based on score and factors
        level = self._determine_level(score, factors)

        # Calculate confidence
        confidence = self._calculate_confidence(factors)

        # Generate recommendations
        recommendations = self._generate_recommendations(level, factors)

        return ComplexityResult(
            level=level,
            score=min(100, score),
            confidence=confidence,
            factors=factors,
            recommendations=recommendations,
        )

    def _analyze_imports(
        self,
        tree: ast.AST,
    ) -> tuple[list[ComplexityFactor], int]:
        """Analyze import statements."""
        factors = []
        score = 0

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    module = alias.name.split(".")[0]
                    factor = self._classify_import(module, node.lineno)
                    if factor:
                        factors.append(factor)
                        score += factor.severity

            elif isinstance(node, ast.ImportFrom):
                if node.module:
                    module = node.module.split(".")[0]
                    factor = self._classify_import(module, node.lineno)
                    if factor:
                        factors.append(factor)
                        score += factor.severity

        return factors, score

    def _classify_import(
        self,
        module: str,
        line_number: int,
    ) -> ComplexityFactor | None:
        """Classify an import as safe, partial, or dangerous."""
        if module in self.SAFE_STDLIB:
            return None  # Safe, no factor

        if module in self.SAFE_QUANTLAB:
            return None  # Safe

        if module in self.SAFE_DATA_MODULES:
            return None  # Safe for data computation

        # Unknown module
        return ComplexityFactor(
            name="external_import",
            category="imports",
            severity=3,
            description=f"External module: {module}",
            line_number=line_number,
        )

    def _analyze_dangerous_patterns(
        self,
        source: str,
    ) -> list[ComplexityFactor]:
        """Check for dangerous code patterns."""
        factors = []

        for pattern, description in self._dangerous_re:
            for match in pattern.finditer(source):
                line_num = source[:match.start()].count("\n") + 1
                factors.append(ComplexityFactor(
                    name="dangerous_code",
                    category="security",
                    severity=10,
                    description=description,
                    line_number=line_num,
                    evidence=match.group()[:50],
                ))

        return factors

    def _analyze_api_patterns(
        self,
        source: str,
    ) -> list[ComplexityFactor]:
        """Check for external API call patterns."""
        factors = []

        for pattern, description in self._api_re:
            for match in pattern.finditer(source):
                line_num = source[:match.start()].count("\n") + 1
                factors.append(ComplexityFactor(
                    name="external_api",
                    category="network",
                    severity=5,
                    description=description,
                    line_number=line_num,
                ))

        return factors

    def _analyze_filesystem_patterns(
        self,
        source: str,
    ) -> list[ComplexityFactor]:
        """Check for filesystem access patterns."""
        factors = []

        for pattern, description in self._filesystem_re:
            for match in pattern.finditer(source):
                line_num = source[:match.start()].count("\n") + 1
                factors.append(ComplexityFactor(
                    name="filesystem_access",
                    category="io",
                    severity=3,
                    description=description,
                    line_number=line_num,
                ))

        return factors

    def _analyze_functions(
        self,
        tree: ast.AST,
    ) -> tuple[list[ComplexityFactor], int]:
        """Analyze function definitions for complexity."""
        factors = []
        score = 0

        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                # Count function complexity (basic cyclomatic)
                complexity = self._function_complexity(node)

                if complexity > 10:
                    factors.append(ComplexityFactor(
                        name="complex_function",
                        category="code",
                        severity=2,
                        description=f"Function '{node.name}' has high complexity ({complexity})",
                        line_number=node.lineno,
                    ))
                    score += 2

        return factors, score

    def _function_complexity(self, node: ast.FunctionDef) -> int:
        """Calculate basic cyclomatic complexity of a function."""
        complexity = 1  # Base complexity

        for child in ast.walk(node):
            if isinstance(child, (ast.If, ast.While, ast.For, ast.ExceptHandler)):
                complexity += 1
            elif isinstance(child, ast.BoolOp):
                complexity += len(child.values) - 1

        return complexity

    def _analyze_classes(
        self,
        tree: ast.AST,
    ) -> tuple[list[ComplexityFactor], int]:
        """Analyze class definitions."""
        factors = []
        score = 0

        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                # Check for metaclasses
                if node.keywords:
                    for kw in node.keywords:
                        if kw.arg == "metaclass":
                            factors.append(ComplexityFactor(
                                name="metaclass",
                                category="advanced",
                                severity=4,
                                description=f"Class '{node.name}' uses metaclass",
                                line_number=node.lineno,
                            ))
                            score += 4

                # Check for __getattr__ override (dynamic attributes)
                for item in node.body:
                    if isinstance(item, ast.FunctionDef):
                        if item.name in ("__getattr__", "__setattr__", "__delattr__"):
                            factors.append(ComplexityFactor(
                                name="dynamic_attributes",
                                category="advanced",
                                severity=3,
                                description=f"Class '{node.name}' has dynamic attributes",
                                line_number=item.lineno,
                            ))
                            score += 3

        return factors, score

    def _analyze_parameters(
        self,
        tree: ast.AST,
        source: str,
    ) -> list[ComplexityFactor]:
        """Analyze parameter expressions for dynamic behavior."""
        factors = []

        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                # Check for dynamic parameter expressions
                if isinstance(node.value, ast.Call):
                    func = node.value.func

                    # Check for param() with non-literal arguments
                    is_param = False
                    if isinstance(func, ast.Name) and func.id == "param":
                        is_param = True
                    elif isinstance(func, ast.Attribute) and func.attr == "param":
                        is_param = True

                    if is_param:
                        for arg in node.value.args:
                            if not self._is_literal(arg):
                                factors.append(ComplexityFactor(
                                    name="dynamic_parameter",
                                    category="params",
                                    severity=5,
                                    description="Parameter default is dynamic expression",
                                    line_number=node.lineno,
                                ))

        return factors

    def _is_literal(self, node: ast.expr) -> bool:
        """Check if an AST node is a literal value."""
        if isinstance(node, ast.Constant):
            return True
        elif isinstance(node, (ast.List, ast.Tuple)):
            return all(self._is_literal(e) for e in node.elts)
        elif isinstance(node, ast.Dict):
            keys_ok = all(self._is_literal(k) for k in node.keys if k is not None)
            values_ok = all(self._is_literal(v) for v in node.values)
            return keys_ok and values_ok
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            return self._is_literal(node.operand)
        elif isinstance(node, ast.Call):
            # Allow Decimal("...")
            if isinstance(node.func, ast.Name) and node.func.id == "Decimal":
                return len(node.args) == 1 and self._is_literal(node.args[0])
        return False

    def _determine_level(
        self,
        score: int,
        factors: list[ComplexityFactor],
    ) -> ComplexityLevel:
        """Determine complexity level from score and factors."""
        # Check for VIEW_ONLY factors
        for factor in factors:
            if factor.category == "security" and factor.severity >= 8:
                return ComplexityLevel.VIEW_ONLY

        # Score-based determination
        if score < 15:
            return ComplexityLevel.SAFE
        elif score < 40:
            return ComplexityLevel.PARTIAL
        else:
            return ComplexityLevel.VIEW_ONLY

    def _calculate_confidence(
        self,
        factors: list[ComplexityFactor],
    ) -> float:
        """Calculate confidence in the analysis."""
        if not factors:
            return 0.95  # High confidence for clean code

        # Lower confidence with more factors
        base = 0.90
        penalty = len(factors) * 0.02
        return max(0.5, base - penalty)

    def _generate_recommendations(
        self,
        level: ComplexityLevel,
        factors: list[ComplexityFactor],
    ) -> list[str]:
        """Generate recommendations based on analysis."""
        recommendations = []

        if level == ComplexityLevel.VIEW_ONLY:
            recommendations.append(
                "This strategy has features that prevent safe parameter modification."
            )

        for factor in factors:
            if factor.category == "imports" and factor.severity > 2:
                recommendations.append(
                    f"Consider using standard library alternatives to {factor.description}"
                )
            elif factor.category == "network":
                recommendations.append(
                    "External API calls should be moved to a data provider"
                )
            elif factor.category == "params":
                recommendations.append(
                    "Use literal values for parameter defaults"
                )

        return recommendations


def analyze_complexity(source: str) -> ComplexityResult:
    """
    Analyze strategy complexity.

    Args:
        source: Strategy source code

    Returns:
        ComplexityResult with analysis
    """
    analyzer = ComplexityAnalyzer()
    return analyzer.analyze(source)


def get_complexity_level(source: str) -> ComplexityLevel:
    """
    Get just the complexity level for a strategy.

    Args:
        source: Strategy source code

    Returns:
        ComplexityLevel enum value
    """
    result = analyze_complexity(source)
    return result.level

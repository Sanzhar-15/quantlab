"""
Feature Dependency Tracking Module.

Tracks dependencies between features for cache invalidation
and correct computation order.

Spec Reference: Technical Spec §7
"""

import ast
import hashlib
import inspect
import logging
from dataclasses import dataclass
from dataclasses import field
from typing import Any
from typing import Callable


logger = logging.getLogger(__name__)


@dataclass
class FeatureInfo:
    """Information about a registered feature."""

    name: str
    func: Callable[..., Any]
    code_hash: str
    dependencies: list[str] = field(default_factory=list)
    parameters: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "codeHash": self.code_hash,
            "dependencies": self.dependencies,
            "parameters": self.parameters,
        }


class DependencyResolver:
    """
    Resolves and tracks feature dependencies.

    Provides:
    - Dependency graph construction
    - Topological sorting for computation order
    - Cache invalidation propagation
    """

    def __init__(self) -> None:
        self._features: dict[str, FeatureInfo] = {}
        self._dependency_graph: dict[str, set[str]] = {}
        self._reverse_graph: dict[str, set[str]] = {}

    def register(
        self,
        name: str,
        func: Callable[..., Any],
        dependencies: list[str] | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> FeatureInfo:
        """
        Register a feature.

        Args:
            name: Feature name
            func: Feature function
            dependencies: Explicit dependencies
            parameters: Feature parameters

        Returns:
            FeatureInfo
        """
        # Compute code hash
        try:
            source = inspect.getsource(func)
            code_hash = hashlib.sha256(source.encode()).hexdigest()[:20]
        except OSError:
            code_hash = hashlib.sha256(name.encode()).hexdigest()[:20]

        # Auto-detect dependencies if not provided
        if dependencies is None:
            dependencies = self._detect_dependencies(func)

        info = FeatureInfo(
            name=name,
            func=func,
            code_hash=code_hash,
            dependencies=dependencies,
            parameters=parameters or {},
        )

        self._features[name] = info

        # Update dependency graph
        self._dependency_graph[name] = set(dependencies)
        for dep in dependencies:
            if dep not in self._reverse_graph:
                self._reverse_graph[dep] = set()
            self._reverse_graph[dep].add(name)

        return info

    def get_feature(self, name: str) -> FeatureInfo | None:
        """Get registered feature by name."""
        return self._features.get(name)

    def get_dependencies(self, name: str) -> list[str]:
        """Get direct dependencies of a feature."""
        return list(self._dependency_graph.get(name, set()))

    def get_dependents(self, name: str) -> list[str]:
        """Get features that depend on this feature."""
        return list(self._reverse_graph.get(name, set()))

    def get_all_dependencies(self, name: str) -> list[str]:
        """Get all transitive dependencies of a feature."""
        visited: set[str] = set()
        result: list[str] = []

        def visit(n: str) -> None:
            if n in visited:
                return
            visited.add(n)
            for dep in self._dependency_graph.get(n, set()):
                visit(dep)
                result.append(dep)

        visit(name)
        return result

    def get_computation_order(self, features: list[str]) -> list[str]:
        """
        Get correct computation order for features.

        Returns features in topological order (dependencies first).

        Args:
            features: Features to compute

        Returns:
            Ordered list of features
        """
        # Collect all required features including dependencies
        required: set[str] = set()
        for name in features:
            required.add(name)
            required.update(self.get_all_dependencies(name))

        # Topological sort using Kahn's algorithm
        in_degree: dict[str, int] = {f: 0 for f in required}
        for f in required:
            for dep in self._dependency_graph.get(f, set()):
                if dep in required:
                    in_degree[f] = in_degree.get(f, 0) + 1

        queue = [f for f in required if in_degree[f] == 0]
        result: list[str] = []

        while queue:
            f = queue.pop(0)
            result.append(f)

            for dependent in self._reverse_graph.get(f, set()):
                if dependent in required:
                    in_degree[dependent] -= 1
                    if in_degree[dependent] == 0:
                        queue.append(dependent)

        if len(result) != len(required):
            raise ValueError("Circular dependency detected")

        return result

    def get_invalidation_cascade(self, name: str) -> list[str]:
        """
        Get all features that should be invalidated when a feature changes.

        Args:
            name: Changed feature

        Returns:
            List of features to invalidate (including the changed one)
        """
        visited: set[str] = set()
        result: list[str] = []

        def visit(n: str) -> None:
            if n in visited:
                return
            visited.add(n)
            result.append(n)
            for dependent in self._reverse_graph.get(n, set()):
                visit(dependent)

        visit(name)
        return result

    def get_dependency_hashes(self, name: str) -> dict[str, str]:
        """
        Get hashes of all dependencies for cache key.

        Args:
            name: Feature name

        Returns:
            Dict of dependency name -> code hash
        """
        hashes: dict[str, str] = {}
        for dep in self.get_all_dependencies(name):
            if dep in self._features:
                hashes[dep] = self._features[dep].code_hash
        return hashes

    def _detect_dependencies(self, func: Callable[..., Any]) -> list[str]:
        """
        Auto-detect dependencies from function code.

        Looks for:
        - Calls to registered features
        - References to feature names in strings
        """
        dependencies: list[str] = []

        try:
            source = inspect.getsource(func)
            tree = ast.parse(source)
        except (OSError, SyntaxError):
            return dependencies

        for node in ast.walk(tree):
            # Look for function calls
            if isinstance(node, ast.Call):
                if isinstance(node.func, ast.Name):
                    name = node.func.id
                    if name in self._features:
                        dependencies.append(name)
                elif isinstance(node.func, ast.Attribute):
                    name = node.func.attr
                    if name in self._features:
                        dependencies.append(name)

        return list(set(dependencies))


# Global resolver instance
_resolver = DependencyResolver()


def register_feature(
    name: str | None = None,
    dependencies: list[str] | None = None,
    parameters: dict[str, Any] | None = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """
    Decorator to register a feature with dependency tracking.

    Usage:
        @register_feature(dependencies=["sma"])
        def ema(data, period=20):
            return data.ewm(span=period).mean()

    Args:
        name: Feature name (defaults to function name)
        dependencies: Explicit dependencies
        parameters: Feature parameters

    Returns:
        Decorator function
    """
    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        feature_name = name or func.__name__
        _resolver.register(
            name=feature_name,
            func=func,
            dependencies=dependencies,
            parameters=parameters,
        )
        return func

    return decorator


def get_resolver() -> DependencyResolver:
    """Get the global dependency resolver."""
    return _resolver


def get_computation_order(features: list[str]) -> list[str]:
    """Get correct computation order for features."""
    return _resolver.get_computation_order(features)


def get_dependency_hashes(name: str) -> dict[str, str]:
    """Get hashes of all dependencies for cache key."""
    return _resolver.get_dependency_hashes(name)

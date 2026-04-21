"""
User Package Support.

Provides dynamic loading and management of user strategy packages.

Spec Reference: Technical Spec §10.3
"""

import hashlib
import importlib
import importlib.util
import inspect
import os
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from enum import Enum
from pathlib import Path
from types import ModuleType
from typing import Any
from typing import Callable
from typing import Type


class PackageStatus(Enum):
    """Status of a loaded package."""

    LOADED = "loaded"
    UNLOADED = "unloaded"
    ERROR = "error"
    INVALID = "invalid"


@dataclass
class PackageInfo:
    """Information about a loaded package."""

    package_id: str
    name: str
    version: str
    path: Path
    status: PackageStatus
    module: ModuleType | None = None
    strategies: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    loaded_at: datetime | None = None
    error_message: str | None = None
    content_hash: str | None = None


@dataclass
class StrategyInfo:
    """Information about a discovered strategy."""

    name: str
    class_name: str
    module_name: str
    package_id: str
    parameters: dict[str, Any] = field(default_factory=dict)
    description: str = ""
    version: str = "1.0.0"


class PackageValidationError(Exception):
    """Raised when package validation fails."""

    pass


class PackageValidator:
    """
    Validate user packages before loading.

    Security checks:
    - No suspicious imports
    - File size limits
    - Required structure
    """

    # Potentially dangerous modules
    BLOCKED_IMPORTS = {
        "subprocess",
        "os.system",
        "eval",
        "exec",
        "compile",
        "__import__",
        "importlib",
        "ctypes",
        "multiprocessing",
    }

    # Required files in package
    REQUIRED_FILES = ["__init__.py"]

    def __init__(
        self,
        max_file_size_mb: int = 10,
        max_total_size_mb: int = 50,
        allow_native_extensions: bool = False,
    ) -> None:
        """
        Initialize validator.

        Args:
            max_file_size_mb: Maximum size per file
            max_total_size_mb: Maximum total package size
            allow_native_extensions: Allow .so/.pyd files
        """
        self.max_file_size_mb = max_file_size_mb
        self.max_total_size_mb = max_total_size_mb
        self.allow_native_extensions = allow_native_extensions

    def validate_package(self, path: Path) -> tuple[bool, list[str]]:
        """
        Validate a package directory.

        Args:
            path: Path to package directory

        Returns:
            Tuple of (is_valid, list of errors)
        """
        errors: list[str] = []

        if not path.exists():
            errors.append(f"Path does not exist: {path}")
            return False, errors

        if not path.is_dir():
            errors.append(f"Path is not a directory: {path}")
            return False, errors

        # Check required files
        for required in self.REQUIRED_FILES:
            if not (path / required).exists():
                errors.append(f"Missing required file: {required}")

        # Check file sizes
        total_size = 0

        for file_path in path.rglob("*"):
            if not file_path.is_file():
                continue

            size_mb = file_path.stat().st_size / (1024 * 1024)
            total_size += size_mb

            if size_mb > self.max_file_size_mb:
                errors.append(f"File too large: {file_path.name} ({size_mb:.1f}MB)")

            # Check for native extensions
            if not self.allow_native_extensions:
                if file_path.suffix in (".so", ".pyd", ".dll"):
                    errors.append(f"Native extension not allowed: {file_path.name}")

        if total_size > self.max_total_size_mb:
            errors.append(f"Package too large: {total_size:.1f}MB")

        # Scan Python files for suspicious imports
        for py_file in path.rglob("*.py"):
            file_errors = self._scan_python_file(py_file)
            errors.extend(file_errors)

        return len(errors) == 0, errors

    def validate_zip(self, zip_path: Path) -> tuple[bool, list[str]]:
        """
        Validate a zipped package.

        Args:
            zip_path: Path to zip file

        Returns:
            Tuple of (is_valid, list of errors)
        """
        errors: list[str] = []

        if not zip_path.exists():
            errors.append(f"Zip file does not exist: {zip_path}")
            return False, errors

        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                # Check for zip bomb
                total_size = sum(info.file_size for info in zf.infolist())
                if total_size / (1024 * 1024) > self.max_total_size_mb:
                    errors.append(f"Zip contents too large: {total_size / (1024 * 1024):.1f}MB")
                    return False, errors

                # Extract to temp and validate
                with tempfile.TemporaryDirectory() as temp_dir:
                    zf.extractall(temp_dir)
                    temp_path = Path(temp_dir)

                    # Find package root
                    roots = [d for d in temp_path.iterdir() if d.is_dir()]

                    if len(roots) == 1:
                        package_path = roots[0]
                    else:
                        package_path = temp_path

                    is_valid, package_errors = self.validate_package(package_path)
                    errors.extend(package_errors)

        except zipfile.BadZipFile:
            errors.append("Invalid zip file")

        return len(errors) == 0, errors

    def _scan_python_file(self, file_path: Path) -> list[str]:
        """Scan a Python file for suspicious patterns."""
        errors = []

        try:
            content = file_path.read_text()

            for blocked in self.BLOCKED_IMPORTS:
                if blocked in content:
                    errors.append(f"Suspicious import in {file_path.name}: {blocked}")

        except Exception as e:
            errors.append(f"Error scanning {file_path.name}: {e}")

        return errors


class PackageLoader:
    """
    Load user strategy packages dynamically.

    Handles:
    - Directory packages
    - Zip packages
    - Module isolation
    - Dependency checking
    """

    def __init__(
        self,
        package_dir: Path | str | None = None,
        validator: PackageValidator | None = None,
        auto_validate: bool = True,
    ) -> None:
        """
        Initialize package loader.

        Args:
            package_dir: Directory to look for packages
            validator: Package validator
            auto_validate: Automatically validate before loading
        """
        if package_dir:
            self.package_dir = Path(package_dir)
        else:
            self.package_dir = Path.home() / ".quantlab" / "packages"

        self.package_dir.mkdir(parents=True, exist_ok=True)

        self.validator = validator or PackageValidator()
        self.auto_validate = auto_validate

        self._packages: dict[str, PackageInfo] = {}
        self._strategies: dict[str, StrategyInfo] = {}

    def _compute_hash(self, path: Path) -> str:
        """Compute content hash for a package."""
        hasher = hashlib.sha256()

        for file_path in sorted(path.rglob("*.py")):
            hasher.update(file_path.read_bytes())

        return hasher.hexdigest()[:20]

    def _generate_package_id(self, name: str) -> str:
        """Generate unique package ID."""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return f"{name}_{timestamp}"

    def load_package(
        self,
        path: Path | str,
        name: str | None = None,
        version: str = "1.0.0",
    ) -> PackageInfo:
        """
        Load a package from directory.

        Args:
            path: Path to package directory
            name: Package name (defaults to directory name)
            version: Package version

        Returns:
            PackageInfo with loaded package details
        """
        path = Path(path)
        name = name or path.name

        package_id = self._generate_package_id(name)

        # Validate if enabled
        if self.auto_validate:
            is_valid, errors = self.validator.validate_package(path)

            if not is_valid:
                return PackageInfo(
                    package_id=package_id,
                    name=name,
                    version=version,
                    path=path,
                    status=PackageStatus.INVALID,
                    error_message="; ".join(errors),
                )

        # Add parent directory to sys.path so the package can be imported
        parent_path = str(path.parent.absolute())
        if parent_path not in sys.path:
            sys.path.insert(0, parent_path)

        try:
            # Import the package
            module = importlib.import_module(name)

            # Discover strategies
            strategies = self._discover_strategies(module, package_id)

            content_hash = self._compute_hash(path)

            info = PackageInfo(
                package_id=package_id,
                name=name,
                version=version,
                path=path,
                status=PackageStatus.LOADED,
                module=module,
                strategies=[s.name for s in strategies],
                loaded_at=datetime.now(),
                content_hash=content_hash,
            )

            self._packages[package_id] = info

            # Register strategies
            for strategy in strategies:
                self._strategies[strategy.name] = strategy

            return info

        except Exception as e:
            return PackageInfo(
                package_id=package_id,
                name=name,
                version=version,
                path=path,
                status=PackageStatus.ERROR,
                error_message=str(e),
            )

    def load_zip(
        self,
        zip_path: Path | str,
        name: str | None = None,
        version: str = "1.0.0",
    ) -> PackageInfo:
        """
        Load a package from zip file.

        Args:
            zip_path: Path to zip file
            name: Package name
            version: Package version

        Returns:
            PackageInfo
        """
        zip_path = Path(zip_path)
        name = name or zip_path.stem

        # Validate
        if self.auto_validate:
            is_valid, errors = self.validator.validate_zip(zip_path)

            if not is_valid:
                return PackageInfo(
                    package_id=self._generate_package_id(name),
                    name=name,
                    version=version,
                    path=zip_path,
                    status=PackageStatus.INVALID,
                    error_message="; ".join(errors),
                )

        # Extract to package directory
        extract_path = self.package_dir / name

        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_path)

        # Check for nested directory
        roots = [d for d in extract_path.iterdir() if d.is_dir()]
        if len(roots) == 1 and roots[0].name == name:
            package_path = roots[0]
        else:
            package_path = extract_path

        return self.load_package(package_path, name, version)

    def load_module_from_string(
        self,
        code: str,
        module_name: str,
    ) -> ModuleType | None:
        """
        Load a module from a code string.

        Args:
            code: Python code
            module_name: Name for the module

        Returns:
            Loaded module or None on error
        """
        try:
            spec = importlib.util.spec_from_loader(
                module_name,
                loader=None,
                origin="<string>",
            )

            if spec is None:
                return None

            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module

            exec(code, module.__dict__)

            return module

        except Exception:
            return None

    def unload_package(self, package_id: str) -> bool:
        """
        Unload a package.

        Args:
            package_id: Package to unload

        Returns:
            True if unloaded successfully
        """
        if package_id not in self._packages:
            return False

        info = self._packages[package_id]

        # Remove from sys.path
        path_str = str(info.path.absolute())
        if path_str in sys.path:
            sys.path.remove(path_str)

        # Remove module from sys.modules
        if info.module and info.name in sys.modules:
            del sys.modules[info.name]

        # Remove strategies
        for strategy_name in info.strategies:
            if strategy_name in self._strategies:
                del self._strategies[strategy_name]

        info.status = PackageStatus.UNLOADED
        info.module = None

        return True

    def reload_package(self, package_id: str) -> PackageInfo | None:
        """
        Reload a package.

        Args:
            package_id: Package to reload

        Returns:
            Updated PackageInfo or None if not found
        """
        if package_id not in self._packages:
            return None

        info = self._packages[package_id]
        path = info.path
        name = info.name
        version = info.version

        self.unload_package(package_id)

        return self.load_package(path, name, version)

    def _discover_strategies(
        self,
        module: ModuleType,
        package_id: str,
    ) -> list[StrategyInfo]:
        """Discover strategies in a module."""
        strategies = []

        # Look for classes with 'Strategy' in name or specific base class
        for name, obj in inspect.getmembers(module, inspect.isclass):
            # Skip imported classes
            if obj.__module__ != module.__name__:
                continue

            # Check for strategy pattern
            if "Strategy" in name or self._has_strategy_methods(obj):
                params = self._extract_parameters(obj)

                info = StrategyInfo(
                    name=name,
                    class_name=name,
                    module_name=module.__name__,
                    package_id=package_id,
                    parameters=params,
                    description=obj.__doc__ or "",
                )

                strategies.append(info)

        return strategies

    def _has_strategy_methods(self, cls: Type) -> bool:
        """Check if class has strategy-like methods."""
        strategy_methods = {"on_bar", "on_data", "generate_signals", "next"}
        class_methods = set(dir(cls))
        return bool(strategy_methods & class_methods)

    def _extract_parameters(self, cls: Type) -> dict[str, Any]:
        """Extract parameters from a strategy class."""
        params = {}

        # Look for class attributes
        for name, value in vars(cls).items():
            if name.startswith("_"):
                continue

            if isinstance(value, (int, float, str, bool, list, dict)):
                params[name] = value

        # Look for __init__ parameters
        try:
            sig = inspect.signature(cls.__init__)

            for param_name, param in sig.parameters.items():
                if param_name in ("self", "cls"):
                    continue

                if param.default is not inspect.Parameter.empty:
                    params[param_name] = param.default

        except (ValueError, TypeError):
            pass

        return params

    def get_package(self, package_id: str) -> PackageInfo | None:
        """Get package by ID."""
        return self._packages.get(package_id)

    def get_package_by_name(self, name: str) -> PackageInfo | None:
        """Get package by name."""
        for info in self._packages.values():
            if info.name == name and info.status == PackageStatus.LOADED:
                return info
        return None

    def get_strategy(self, name: str) -> StrategyInfo | None:
        """Get strategy info by name."""
        return self._strategies.get(name)

    def get_strategy_class(self, name: str) -> Type | None:
        """Get strategy class by name."""
        info = self._strategies.get(name)

        if info is None:
            return None

        package = self._packages.get(info.package_id)

        if package is None or package.module is None:
            return None

        return getattr(package.module, info.class_name, None)

    def list_packages(
        self,
        status: PackageStatus | None = None,
    ) -> list[PackageInfo]:
        """List all packages, optionally filtered by status."""
        packages = list(self._packages.values())

        if status is not None:
            packages = [p for p in packages if p.status == status]

        return packages

    def list_strategies(
        self,
        package_id: str | None = None,
    ) -> list[StrategyInfo]:
        """List all strategies, optionally filtered by package."""
        strategies = list(self._strategies.values())

        if package_id is not None:
            strategies = [s for s in strategies if s.package_id == package_id]

        return strategies


class StrategyRegistry:
    """
    Registry for strategy classes.

    Provides:
    - Strategy registration
    - Factory pattern for instantiation
    - Parameter discovery
    """

    def __init__(self) -> None:
        """Initialize registry."""
        self._strategies: dict[str, Type] = {}
        self._factories: dict[str, Callable[..., Any]] = {}

    def register(
        self,
        name: str,
        strategy_class: Type,
    ) -> None:
        """
        Register a strategy class.

        Args:
            name: Strategy name
            strategy_class: Strategy class
        """
        self._strategies[name] = strategy_class

    def register_factory(
        self,
        name: str,
        factory: Callable[..., Any],
    ) -> None:
        """
        Register a strategy factory.

        Args:
            name: Strategy name
            factory: Factory function
        """
        self._factories[name] = factory

    def create(
        self,
        name: str,
        **kwargs: Any,
    ) -> Any:
        """
        Create a strategy instance.

        Args:
            name: Strategy name
            **kwargs: Parameters for strategy

        Returns:
            Strategy instance

        Raises:
            KeyError: If strategy not found
        """
        if name in self._factories:
            return self._factories[name](**kwargs)

        if name in self._strategies:
            return self._strategies[name](**kwargs)

        raise KeyError(f"Strategy not found: {name}")

    def get_class(self, name: str) -> Type | None:
        """Get strategy class by name."""
        return self._strategies.get(name)

    def list_strategies(self) -> list[str]:
        """List all registered strategy names."""
        return list(set(self._strategies.keys()) | set(self._factories.keys()))

    def unregister(self, name: str) -> bool:
        """Unregister a strategy."""
        removed = False

        if name in self._strategies:
            del self._strategies[name]
            removed = True

        if name in self._factories:
            del self._factories[name]
            removed = True

        return removed


# Module-level registry
_global_registry = StrategyRegistry()


def register_strategy(name: str | None = None) -> Callable[[Type], Type]:
    """
    Decorator to register a strategy class.

    Usage:
        @register_strategy("my_sma")
        class MySMAStrategy:
            ...
    """

    def decorator(cls: Type) -> Type:
        strategy_name = name or cls.__name__
        _global_registry.register(strategy_name, cls)
        return cls

    return decorator


def get_registry() -> StrategyRegistry:
    """Get the global strategy registry."""
    return _global_registry

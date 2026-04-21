"""
Code Snapshot Module.

Implements the code snapshot mandate per §17.3:
All run artifacts MUST include complete code snapshot.

Required for:
- Reproducibility
- Run comparison (code diff)
- Audit trail

Spec Reference: Technical Spec §17.3
"""

import hashlib
import json
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from pathlib import Path
from typing import Any


@dataclass
class CodeFile:
    """Represents a single code file in the snapshot."""

    path: str
    content: str
    checksum: str
    size_bytes: int

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "path": self.path,
            "content": self.content,
            "checksum": self.checksum,
            "sizeBytes": self.size_bytes,
        }

    @classmethod
    def from_file(cls, file_path: Path, base_path: Path | None = None) -> "CodeFile":
        """
        Create CodeFile from file path.

        Args:
            file_path: Path to the file
            base_path: Base path for relative path calculation

        Returns:
            CodeFile instance
        """
        content = file_path.read_text(encoding="utf-8")
        checksum = hashlib.sha256(content.encode("utf-8")).hexdigest()

        if base_path:
            rel_path = str(file_path.relative_to(base_path))
        else:
            rel_path = file_path.name

        return cls(
            path=rel_path,
            content=content,
            checksum=checksum,
            size_bytes=len(content.encode("utf-8")),
        )


@dataclass
class CodeSnapshot:
    """
    Complete code snapshot for a strategy run.

    Per §17.3, all run artifacts MUST include complete code snapshot
    for reproducibility, run comparison, and audit trail.
    """

    schema_version: str = "1.0"
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    strategy_file: str = ""
    strategy_hash: str = ""
    files: list[CodeFile] = field(default_factory=list)

    # Dependency information
    dependencies: dict[str, str] = field(default_factory=dict)
    python_version: str = ""
    quantlab_version: str = ""

    def add_file(self, code_file: CodeFile) -> None:
        """Add a file to the snapshot."""
        self.files.append(code_file)

    def add_file_from_path(
        self, file_path: Path, base_path: Path | None = None
    ) -> CodeFile:
        """
        Add a file to the snapshot from path.

        Args:
            file_path: Path to file
            base_path: Base path for relative paths

        Returns:
            Created CodeFile
        """
        code_file = CodeFile.from_file(file_path, base_path)
        self.add_file(code_file)
        return code_file

    def compute_strategy_hash(self) -> str:
        """
        Compute combined hash of all strategy files.

        Returns:
            SHA-256 hash of all file contents
        """
        combined = "".join(sorted(f.checksum for f in self.files))
        self.strategy_hash = hashlib.sha256(combined.encode()).hexdigest()
        return self.strategy_hash

    def to_dict(self) -> dict[str, Any]:
        """Convert snapshot to dictionary."""
        return {
            "schemaVersion": self.schema_version,
            "createdAt": self.created_at.isoformat(),
            "strategyFile": self.strategy_file,
            "strategyHash": self.strategy_hash,
            "files": [f.to_dict() for f in self.files],
            "environment": {
                "dependencies": self.dependencies,
                "pythonVersion": self.python_version,
                "quantlabVersion": self.quantlab_version,
            },
        }

    def to_json(self, indent: int = 2) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), indent=indent)

    def save(self, output_path: Path) -> Path:
        """
        Save snapshot to file.

        Args:
            output_path: Directory to write snapshot.json

        Returns:
            Path to written file
        """
        snapshot_path = output_path / "snapshot.json"
        with open(snapshot_path, "w", encoding="utf-8") as f:
            f.write(self.to_json())
        return snapshot_path

    def save_strategy_copy(self, output_path: Path) -> Path | None:
        """
        Save a copy of the main strategy file.

        Args:
            output_path: Directory to write strategy.py

        Returns:
            Path to written file, or None if no main strategy
        """
        # Find the main strategy file
        main_file = None
        for code_file in self.files:
            if code_file.path == self.strategy_file or code_file.path.endswith(
                self.strategy_file
            ):
                main_file = code_file
                break

        if not main_file:
            return None

        strategy_path = output_path / "strategy.py"
        with open(strategy_path, "w", encoding="utf-8") as f:
            f.write(main_file.content)
        return strategy_path

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CodeSnapshot":
        """Create snapshot from dictionary."""
        env = data.get("environment", {})
        files = [
            CodeFile(
                path=f["path"],
                content=f["content"],
                checksum=f["checksum"],
                size_bytes=f.get("sizeBytes", 0),
            )
            for f in data.get("files", [])
        ]

        created_at = data.get("createdAt", "")
        if created_at:
            created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        else:
            created_at = datetime.now(timezone.utc)

        return cls(
            schema_version=data.get("schemaVersion", "1.0"),
            created_at=created_at,
            strategy_file=data.get("strategyFile", ""),
            strategy_hash=data.get("strategyHash", ""),
            files=files,
            dependencies=env.get("dependencies", {}),
            python_version=env.get("pythonVersion", ""),
            quantlab_version=env.get("quantlabVersion", ""),
        )

    @classmethod
    def from_json(cls, json_str: str) -> "CodeSnapshot":
        """Create snapshot from JSON string."""
        return cls.from_dict(json.loads(json_str))

    @classmethod
    def load(cls, snapshot_path: Path) -> "CodeSnapshot":
        """Load snapshot from file."""
        with open(snapshot_path, encoding="utf-8") as f:
            return cls.from_json(f.read())


def capture_strategy_snapshot(
    strategy_path: Path,
    include_imports: bool = True,
    quantlab_version: str = "10.0.0",
) -> CodeSnapshot:
    """
    Capture a complete snapshot of a strategy and its dependencies.

    Args:
        strategy_path: Path to main strategy file
        include_imports: Whether to include imported local files
        quantlab_version: Quantlab version string

    Returns:
        CodeSnapshot containing all relevant files
    """
    import sys

    snapshot = CodeSnapshot(
        strategy_file=strategy_path.name,
        python_version=f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        quantlab_version=quantlab_version,
    )

    # Add main strategy file
    snapshot.add_file_from_path(strategy_path, strategy_path.parent)

    if include_imports:
        # Scan for local imports and add those files
        _scan_and_add_imports(snapshot, strategy_path, strategy_path.parent)

    # Compute combined hash
    snapshot.compute_strategy_hash()

    return snapshot


def _scan_and_add_imports(
    snapshot: CodeSnapshot, file_path: Path, base_path: Path
) -> None:
    """
    Scan file for local imports and add them to snapshot.

    Args:
        snapshot: Snapshot to add files to
        file_path: File to scan
        base_path: Base path for the strategy
    """
    import ast

    try:
        content = file_path.read_text(encoding="utf-8")
        tree = ast.parse(content)
    except (SyntaxError, OSError):
        return

    # Track already added paths to avoid duplicates
    added_paths = {f.path for f in snapshot.files}

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                _try_add_local_module(snapshot, alias.name, base_path, added_paths)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                _try_add_local_module(snapshot, node.module, base_path, added_paths)


def _try_add_local_module(
    snapshot: CodeSnapshot,
    module_name: str,
    base_path: Path,
    added_paths: set[str],
) -> None:
    """
    Try to add a local module to the snapshot.

    Args:
        snapshot: Snapshot to add file to
        module_name: Module name (dot-separated)
        base_path: Base path for strategy
        added_paths: Already added paths
    """
    # Convert module name to potential file path
    rel_path = module_name.replace(".", "/") + ".py"
    potential_path = base_path / rel_path

    if potential_path.exists() and rel_path not in added_paths:
        snapshot.add_file_from_path(potential_path, base_path)
        added_paths.add(rel_path)
        # Recursively scan for more imports
        _scan_and_add_imports(snapshot, potential_path, base_path)

    # Also try package __init__.py
    package_init = base_path / module_name.replace(".", "/") / "__init__.py"
    if package_init.exists():
        init_rel = str(package_init.relative_to(base_path))
        if init_rel not in added_paths:
            snapshot.add_file_from_path(package_init, base_path)
            added_paths.add(init_rel)

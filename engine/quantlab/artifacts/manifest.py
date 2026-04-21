"""
Artifact Manifest Module.

Defines artifact manifest schema and generation for backtest runs.

Spec Reference: Technical Spec §17.1, §17.2, §17.3
"""

import hashlib
import json
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = "1.0"


@dataclass
class ArtifactFile:
    """Single file in artifact manifest."""

    name: str
    path: str
    format: str
    checksum: str
    size_bytes: int = 0

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "name": self.name,
            "path": self.path,
            "format": self.format,
            "checksum": self.checksum,
            "sizeBytes": self.size_bytes,
        }

    @classmethod
    def from_path(cls, file_path: Path, base_path: Path | None = None) -> "ArtifactFile":
        """
        Create ArtifactFile from file path.

        Args:
            file_path: Path to the file
            base_path: Base path for relative path calculation

        Returns:
            ArtifactFile instance
        """
        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        # Calculate checksum
        checksum = _calculate_sha256(file_path)

        # Determine relative path
        if base_path:
            rel_path = str(file_path.relative_to(base_path))
        else:
            rel_path = file_path.name

        # Determine format from extension
        format_map = {
            ".json": "json",
            ".parquet": "parquet",
            ".csv": "csv",
            ".py": "python",
            ".html": "html",
            ".pdf": "pdf",
            ".png": "png",
            ".jpg": "jpeg",
            ".jpeg": "jpeg",
        }
        file_format = format_map.get(file_path.suffix.lower(), "binary")

        return cls(
            name=file_path.name,
            path=rel_path,
            format=file_format,
            checksum=checksum,
            size_bytes=file_path.stat().st_size,
        )


@dataclass
class ArtifactManifest:
    """
    Artifact manifest for a backtest run.

    Per §17.1, every artifact set must include a manifest.json
    that describes all files in the artifact folder.
    """

    schema_version: str = SCHEMA_VERSION
    job_id: str = ""
    job_type: str = "backtest"
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    files: list[ArtifactFile] = field(default_factory=list)

    # Optional metadata
    strategy_name: str = ""
    strategy_hash: str = ""
    data_rev: str = ""
    environment_hash: str = ""

    def add_file(self, artifact_file: ArtifactFile) -> None:
        """Add a file to the manifest."""
        self.files.append(artifact_file)

    def add_file_from_path(
        self, file_path: Path, base_path: Path | None = None
    ) -> ArtifactFile:
        """
        Add a file to the manifest from path.

        Args:
            file_path: Path to file
            base_path: Base path for relative paths

        Returns:
            Created ArtifactFile
        """
        artifact_file = ArtifactFile.from_path(file_path, base_path)
        self.add_file(artifact_file)
        return artifact_file

    def to_dict(self) -> dict[str, Any]:
        """Convert manifest to dictionary."""
        return {
            "schemaVersion": self.schema_version,
            "jobId": self.job_id,
            "jobType": self.job_type,
            "createdAt": self.created_at.isoformat(),
            "files": [f.to_dict() for f in self.files],
            "metadata": {
                "strategyName": self.strategy_name,
                "strategyHash": self.strategy_hash,
                "dataRev": self.data_rev,
                "environmentHash": self.environment_hash,
            },
        }

    def to_json(self, indent: int = 2) -> str:
        """Convert to JSON string."""
        return json.dumps(self.to_dict(), indent=indent)

    def save(self, output_path: Path) -> Path:
        """
        Save manifest to file.

        Args:
            output_path: Path to write manifest.json

        Returns:
            Path to written file
        """
        manifest_path = output_path / "manifest.json"
        with open(manifest_path, "w", encoding="utf-8") as f:
            f.write(self.to_json())
        return manifest_path

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ArtifactManifest":
        """Create manifest from dictionary."""
        metadata = data.get("metadata", {})
        files = [
            ArtifactFile(
                name=f["name"],
                path=f["path"],
                format=f["format"],
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
            schema_version=data.get("schemaVersion", SCHEMA_VERSION),
            job_id=data.get("jobId", ""),
            job_type=data.get("jobType", "backtest"),
            created_at=created_at,
            files=files,
            strategy_name=metadata.get("strategyName", ""),
            strategy_hash=metadata.get("strategyHash", ""),
            data_rev=metadata.get("dataRev", ""),
            environment_hash=metadata.get("environmentHash", ""),
        )

    @classmethod
    def from_json(cls, json_str: str) -> "ArtifactManifest":
        """Create manifest from JSON string."""
        return cls.from_dict(json.loads(json_str))

    @classmethod
    def load(cls, manifest_path: Path) -> "ArtifactManifest":
        """Load manifest from file."""
        with open(manifest_path, encoding="utf-8") as f:
            return cls.from_json(f.read())


def _calculate_sha256(file_path: Path) -> str:
    """Calculate SHA-256 checksum of file."""
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def generate_artifact_folder_name(
    job_type: str = "backtest",
    timestamp: datetime | None = None,
    job_id: str = "",
) -> str:
    """
    Generate artifact folder name per §17.2 spec.

    Format: {job_type}_{timestamp}_{hash}/

    Args:
        job_type: Type of job (backtest, optimize, etc.)
        timestamp: Timestamp for folder (defaults to now)
        job_id: Job ID for hash generation

    Returns:
        Folder name string
    """
    if timestamp is None:
        timestamp = datetime.now(timezone.utc)

    ts_str = timestamp.strftime("%Y%m%d_%H%M%S")

    # Generate short hash from job_id or timestamp
    if job_id:
        hash_input = job_id
    else:
        hash_input = str(timestamp.timestamp())
    short_hash = hashlib.sha256(hash_input.encode()).hexdigest()[:8]

    return f"{job_type}_{ts_str}_{short_hash}"


def create_artifact_structure(
    base_path: Path,
    job_id: str,
    job_type: str = "backtest",
    include_debug: bool = False,
) -> tuple[Path, ArtifactManifest]:
    """
    Create standard artifact folder structure per §17.2.

    Structure:
        backtest_{timestamp}_{hash}/
        ├── manifest.json
        ├── code/                    # MANDATORY
        │   ├── snapshot.json
        │   └── strategy.py
        ├── results.json
        ├── trades.parquet
        ├── equity.parquet
        └── debug/                   # If debug enabled

    Args:
        base_path: Base directory for artifacts
        job_id: Unique job identifier
        job_type: Type of job
        include_debug: Whether to create debug folder

    Returns:
        Tuple of (artifact_path, manifest)
    """
    folder_name = generate_artifact_folder_name(job_type=job_type, job_id=job_id)
    artifact_path = base_path / folder_name

    # Create folder structure
    artifact_path.mkdir(parents=True, exist_ok=True)
    (artifact_path / "code").mkdir(exist_ok=True)

    if include_debug:
        (artifact_path / "debug").mkdir(exist_ok=True)

    # Create manifest
    manifest = ArtifactManifest(
        job_id=job_id,
        job_type=job_type,
    )

    return artifact_path, manifest

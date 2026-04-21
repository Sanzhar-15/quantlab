"""
Backup and Migration Export/Import.

Provides functionality to export and import Quantlab settings,
keybindings, trusted workspaces, and configuration for migration
or backup purposes.

Spec Reference: Decision N94 (Backup/Migration Export)
"""

import hashlib
import json
import logging
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class ExportManifest:
    """Manifest describing exported content."""

    version: str = "1.0.0"
    exported_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    quantlab_version: str = ""
    includes: list[str] = field(default_factory=list)
    checksums: dict[str, str] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "version": self.version,
            "exported_at": self.exported_at,
            "quantlab_version": self.quantlab_version,
            "includes": self.includes,
            "checksums": self.checksums,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ExportManifest":
        """Create from dictionary."""
        return cls(
            version=data.get("version", "1.0.0"),
            exported_at=data.get("exported_at", ""),
            quantlab_version=data.get("quantlab_version", ""),
            includes=data.get("includes", []),
            checksums=data.get("checksums", {}),
            metadata=data.get("metadata", {}),
        )


@dataclass
class ExportConfig:
    """Configuration for what to export."""

    include_settings: bool = True
    include_keybindings: bool = True
    include_trusted_workspaces: bool = True
    include_strategies: bool = False
    include_risk_config: bool = True
    include_calendar_overrides: bool = True
    include_broker_configs: bool = False  # Sensitive - disabled by default
    custom_paths: list[Path] = field(default_factory=list)


@dataclass
class ImportResult:
    """Result of an import operation."""

    success: bool
    imported_items: list[str]
    skipped_items: list[str]
    errors: list[str]
    manifest: ExportManifest | None = None


class MigrationExporter:
    """
    Export Quantlab configuration for backup or migration.

    Creates a ZIP file containing:
    - manifest.json: Export metadata and checksums
    - settings.json: User settings
    - keybindings.json: Custom keybindings
    - trusted_workspaces.json: Trusted workspace list
    - risk_config.json: Risk management configuration
    - calendars/: Custom calendar overrides

    Usage:
        exporter = MigrationExporter(config_dir)

        # Export all
        zip_path = exporter.export_all("/path/to/backup.zip")

        # Export selective
        zip_path = exporter.export(
            "/path/to/backup.zip",
            ExportConfig(include_settings=True, include_keybindings=False)
        )
    """

    MANIFEST_FILE = "manifest.json"
    SETTINGS_FILE = "settings.json"
    KEYBINDINGS_FILE = "keybindings.json"
    TRUSTED_FILE = "trusted_workspaces.json"
    RISK_CONFIG_FILE = "risk_config.json"
    BROKER_CONFIG_FILE = "broker_configs.json"
    CALENDARS_DIR = "calendars"
    STRATEGIES_DIR = "strategies"

    def __init__(
        self,
        config_dir: Path,
        quantlab_version: str = "unknown",
    ) -> None:
        """
        Initialize exporter.

        Args:
            config_dir: Quantlab configuration directory
            quantlab_version: Current Quantlab version
        """
        self._config_dir = Path(config_dir)
        self._quantlab_version = quantlab_version

    def export(
        self,
        output_path: Path | str,
        config: ExportConfig | None = None,
    ) -> Path:
        """
        Export configuration to ZIP file.

        Args:
            output_path: Path for output ZIP file
            config: Export configuration (defaults to all except sensitive)

        Returns:
            Path to created ZIP file
        """
        config = config or ExportConfig()
        output_path = Path(output_path)

        manifest = ExportManifest(
            quantlab_version=self._quantlab_version,
        )

        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
            # Export settings
            if config.include_settings:
                self._export_json_file(
                    zf, self.SETTINGS_FILE, manifest, "settings"
                )

            # Export keybindings
            if config.include_keybindings:
                self._export_json_file(
                    zf, self.KEYBINDINGS_FILE, manifest, "keybindings"
                )

            # Export trusted workspaces
            if config.include_trusted_workspaces:
                self._export_json_file(
                    zf, self.TRUSTED_FILE, manifest, "trusted_workspaces"
                )

            # Export risk config
            if config.include_risk_config:
                self._export_json_file(
                    zf, self.RISK_CONFIG_FILE, manifest, "risk_config"
                )

            # Export broker configs (sensitive)
            if config.include_broker_configs:
                self._export_json_file(
                    zf, self.BROKER_CONFIG_FILE, manifest, "broker_configs"
                )
                manifest.metadata["includes_sensitive"] = True

            # Export calendar overrides
            if config.include_calendar_overrides:
                self._export_directory(
                    zf, self.CALENDARS_DIR, manifest, "calendars"
                )

            # Export strategies
            if config.include_strategies:
                self._export_directory(
                    zf, self.STRATEGIES_DIR, manifest, "strategies"
                )

            # Export custom paths
            for custom_path in config.custom_paths:
                if custom_path.exists():
                    self._export_custom_path(zf, custom_path, manifest)

            # Write manifest last
            manifest_data = json.dumps(manifest.to_dict(), indent=2)
            zf.writestr(self.MANIFEST_FILE, manifest_data)

        logger.info(
            f"Exported {len(manifest.includes)} items to {output_path} "
            f"({output_path.stat().st_size / 1024:.1f} KB)"
        )

        return output_path

    def export_all(self, output_path: Path | str) -> Path:
        """
        Export all configuration (except sensitive broker configs).

        Args:
            output_path: Path for output ZIP file

        Returns:
            Path to created ZIP file
        """
        return self.export(
            output_path,
            ExportConfig(
                include_settings=True,
                include_keybindings=True,
                include_trusted_workspaces=True,
                include_strategies=True,
                include_risk_config=True,
                include_calendar_overrides=True,
                include_broker_configs=False,  # Sensitive
            ),
        )

    def _export_json_file(
        self,
        zf: zipfile.ZipFile,
        filename: str,
        manifest: ExportManifest,
        item_name: str,
    ) -> None:
        """Export a JSON file if it exists."""
        file_path = self._config_dir / filename

        if not file_path.exists():
            logger.debug(f"Skipping {filename}: not found")
            return

        try:
            content = file_path.read_text()
            # Validate JSON
            json.loads(content)

            zf.writestr(filename, content)
            manifest.includes.append(item_name)
            manifest.checksums[filename] = self._compute_checksum(content)

            logger.debug(f"Exported {filename}")
        except Exception as e:
            logger.warning(f"Failed to export {filename}: {e}")

    def _export_directory(
        self,
        zf: zipfile.ZipFile,
        dirname: str,
        manifest: ExportManifest,
        item_name: str,
    ) -> None:
        """Export a directory recursively."""
        dir_path = self._config_dir / dirname

        if not dir_path.exists() or not dir_path.is_dir():
            logger.debug(f"Skipping {dirname}: not found")
            return

        files_exported = 0
        for file_path in dir_path.rglob("*"):
            if file_path.is_file():
                rel_path = file_path.relative_to(self._config_dir)
                content = file_path.read_bytes()
                zf.writestr(str(rel_path), content)
                manifest.checksums[str(rel_path)] = self._compute_checksum(content)
                files_exported += 1

        if files_exported > 0:
            manifest.includes.append(item_name)
            logger.debug(f"Exported {dirname}/ ({files_exported} files)")

    def _export_custom_path(
        self,
        zf: zipfile.ZipFile,
        path: Path,
        manifest: ExportManifest,
    ) -> None:
        """Export a custom path."""
        if path.is_file():
            content = path.read_bytes()
            zf.writestr(f"custom/{path.name}", content)
            manifest.includes.append(f"custom:{path.name}")
            manifest.checksums[f"custom/{path.name}"] = self._compute_checksum(content)
        elif path.is_dir():
            for file_path in path.rglob("*"):
                if file_path.is_file():
                    rel_path = file_path.relative_to(path.parent)
                    content = file_path.read_bytes()
                    zf.writestr(f"custom/{rel_path}", content)
                    manifest.checksums[f"custom/{rel_path}"] = self._compute_checksum(content)
            manifest.includes.append(f"custom:{path.name}/")

    def _compute_checksum(self, content: str | bytes) -> str:
        """Compute SHA-256 checksum."""
        if isinstance(content, str):
            content = content.encode("utf-8")
        return hashlib.sha256(content).hexdigest()


class MigrationImporter:
    """
    Import Quantlab configuration from backup.

    Usage:
        importer = MigrationImporter(config_dir)

        # Preview what will be imported
        manifest = importer.preview("/path/to/backup.zip")

        # Import all
        result = importer.import_all("/path/to/backup.zip")

        # Import selective
        result = importer.import_from(
            "/path/to/backup.zip",
            include=["settings", "keybindings"]
        )
    """

    def __init__(self, config_dir: Path) -> None:
        """
        Initialize importer.

        Args:
            config_dir: Quantlab configuration directory
        """
        self._config_dir = Path(config_dir)
        self._config_dir.mkdir(parents=True, exist_ok=True)

    def preview(self, zip_path: Path | str) -> ExportManifest:
        """
        Preview contents of export file without importing.

        Args:
            zip_path: Path to export ZIP file

        Returns:
            Export manifest describing contents

        Raises:
            ValueError: If manifest is missing or invalid
        """
        zip_path = Path(zip_path)

        with zipfile.ZipFile(zip_path, "r") as zf:
            if MigrationExporter.MANIFEST_FILE not in zf.namelist():
                raise ValueError("Invalid export file: manifest.json not found")

            manifest_data = json.loads(
                zf.read(MigrationExporter.MANIFEST_FILE).decode("utf-8")
            )
            return ExportManifest.from_dict(manifest_data)

    def import_all(
        self,
        zip_path: Path | str,
        overwrite: bool = False,
        backup_existing: bool = True,
    ) -> ImportResult:
        """
        Import all items from export file.

        Args:
            zip_path: Path to export ZIP file
            overwrite: Whether to overwrite existing files
            backup_existing: Whether to backup existing files before overwrite

        Returns:
            Import result
        """
        return self.import_from(zip_path, overwrite=overwrite, backup_existing=backup_existing)

    def import_from(
        self,
        zip_path: Path | str,
        include: list[str] | None = None,
        exclude: list[str] | None = None,
        overwrite: bool = False,
        backup_existing: bool = True,
    ) -> ImportResult:
        """
        Import items from export file.

        Args:
            zip_path: Path to export ZIP file
            include: Items to include (None = all)
            exclude: Items to exclude
            overwrite: Whether to overwrite existing files
            backup_existing: Whether to backup existing files before overwrite

        Returns:
            Import result
        """
        zip_path = Path(zip_path)
        exclude = exclude or []

        result = ImportResult(
            success=True,
            imported_items=[],
            skipped_items=[],
            errors=[],
        )

        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                # Read manifest
                if MigrationExporter.MANIFEST_FILE not in zf.namelist():
                    result.success = False
                    result.errors.append("Invalid export file: manifest.json not found")
                    return result

                manifest_data = json.loads(
                    zf.read(MigrationExporter.MANIFEST_FILE).decode("utf-8")
                )
                result.manifest = ExportManifest.from_dict(manifest_data)

                # Verify checksums
                for filename, expected_checksum in result.manifest.checksums.items():
                    if filename in zf.namelist():
                        content = zf.read(filename)
                        actual_checksum = hashlib.sha256(content).hexdigest()
                        if actual_checksum != expected_checksum:
                            result.errors.append(
                                f"Checksum mismatch for {filename}"
                            )
                            result.success = False
                            return result

                # Filter items to import
                items_to_import = result.manifest.includes
                if include is not None:
                    items_to_import = [i for i in items_to_import if i in include]
                items_to_import = [i for i in items_to_import if i not in exclude]

                # Backup existing if requested
                if backup_existing:
                    self._backup_existing(items_to_import)

                # Import files
                for member in zf.namelist():
                    if member == MigrationExporter.MANIFEST_FILE:
                        continue

                    item_name = self._get_item_name(member)
                    if item_name not in items_to_import:
                        result.skipped_items.append(member)
                        continue

                    target_path = self._config_dir / member

                    # Check if exists
                    if target_path.exists() and not overwrite:
                        result.skipped_items.append(member)
                        continue

                    try:
                        target_path.parent.mkdir(parents=True, exist_ok=True)
                        content = zf.read(member)
                        target_path.write_bytes(content)
                        result.imported_items.append(member)
                    except Exception as e:
                        result.errors.append(f"Failed to import {member}: {e}")

        except Exception as e:
            result.success = False
            result.errors.append(str(e))

        if result.errors:
            result.success = False

        logger.info(
            f"Import complete: {len(result.imported_items)} imported, "
            f"{len(result.skipped_items)} skipped, "
            f"{len(result.errors)} errors"
        )

        return result

    def _get_item_name(self, filename: str) -> str:
        """Map filename to item name."""
        mapping = {
            MigrationExporter.SETTINGS_FILE: "settings",
            MigrationExporter.KEYBINDINGS_FILE: "keybindings",
            MigrationExporter.TRUSTED_FILE: "trusted_workspaces",
            MigrationExporter.RISK_CONFIG_FILE: "risk_config",
            MigrationExporter.BROKER_CONFIG_FILE: "broker_configs",
        }

        if filename in mapping:
            return mapping[filename]

        if filename.startswith(MigrationExporter.CALENDARS_DIR + "/"):
            return "calendars"
        if filename.startswith(MigrationExporter.STRATEGIES_DIR + "/"):
            return "strategies"
        if filename.startswith("custom/"):
            return "custom"

        return filename

    def _backup_existing(self, items: list[str]) -> None:
        """Backup existing files before import."""
        backup_dir = self._config_dir / ".import_backup"
        backup_dir.mkdir(exist_ok=True)

        files_to_backup = []
        if "settings" in items:
            files_to_backup.append(MigrationExporter.SETTINGS_FILE)
        if "keybindings" in items:
            files_to_backup.append(MigrationExporter.KEYBINDINGS_FILE)
        if "trusted_workspaces" in items:
            files_to_backup.append(MigrationExporter.TRUSTED_FILE)
        if "risk_config" in items:
            files_to_backup.append(MigrationExporter.RISK_CONFIG_FILE)

        for filename in files_to_backup:
            src = self._config_dir / filename
            if src.exists():
                dst = backup_dir / f"{filename}.{datetime.now().strftime('%Y%m%d_%H%M%S')}"
                shutil.copy2(src, dst)
                logger.debug(f"Backed up {filename} to {dst}")


def create_export(
    config_dir: Path | str,
    output_path: Path | str,
    quantlab_version: str = "unknown",
    **kwargs: Any,
) -> Path:
    """
    Convenience function to create an export.

    Args:
        config_dir: Quantlab configuration directory
        output_path: Path for output ZIP file
        quantlab_version: Current Quantlab version
        **kwargs: Additional options passed to ExportConfig

    Returns:
        Path to created ZIP file
    """
    exporter = MigrationExporter(Path(config_dir), quantlab_version)
    config = ExportConfig(**kwargs)
    return exporter.export(output_path, config)


def import_from_export(
    config_dir: Path | str,
    zip_path: Path | str,
    **kwargs: Any,
) -> ImportResult:
    """
    Convenience function to import from export.

    Args:
        config_dir: Quantlab configuration directory
        zip_path: Path to export ZIP file
        **kwargs: Additional options for import_from

    Returns:
        Import result
    """
    importer = MigrationImporter(Path(config_dir))
    return importer.import_from(zip_path, **kwargs)

"""
Code Backup Management.

Provides backup and restore functionality for code modifications.

Spec Reference: Technical Spec §9.1
"""

import hashlib
import shutil
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from pathlib import Path
from typing import Any


@dataclass
class BackupEntry:
    """Single backup entry."""

    backup_id: str
    original_path: Path
    backup_path: Path
    timestamp: datetime
    content_hash: str
    file_size: int
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "backup_id": self.backup_id,
            "original_path": str(self.original_path),
            "backup_path": str(self.backup_path),
            "timestamp": self.timestamp.isoformat(),
            "content_hash": self.content_hash,
            "file_size": self.file_size,
            "description": self.description,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BackupEntry":
        """Create from dictionary."""
        return cls(
            backup_id=data["backup_id"],
            original_path=Path(data["original_path"]),
            backup_path=Path(data["backup_path"]),
            timestamp=datetime.fromisoformat(data["timestamp"]),
            content_hash=data["content_hash"],
            file_size=data["file_size"],
            description=data.get("description", ""),
        )


class BackupManager:
    """
    Manage code file backups.

    Creates and manages backups before code modifications.
    """

    def __init__(
        self,
        backup_dir: Path | str | None = None,
        max_backups_per_file: int = 10,
    ) -> None:
        """
        Initialize backup manager.

        Args:
            backup_dir: Directory to store backups
            max_backups_per_file: Maximum backups to keep per file
        """
        if backup_dir:
            self.backup_dir = Path(backup_dir)
        else:
            self.backup_dir = Path.home() / ".quantlab" / "backups"

        self.backup_dir.mkdir(parents=True, exist_ok=True)
        self.max_backups_per_file = max_backups_per_file

        self._entries: dict[str, BackupEntry] = {}
        self._counter_file = self.backup_dir / ".backup_counter"
        self._backup_counter = self._load_counter()

    def _load_counter(self) -> int:
        """Load persisted backup counter or start from 0."""
        try:
            if self._counter_file.exists():
                return int(self._counter_file.read_text().strip())
        except (ValueError, OSError):
            pass
        return 0

    def _save_counter(self) -> None:
        """Persist backup counter to disk."""
        try:
            self._counter_file.write_text(str(self._backup_counter))
        except OSError:
            pass  # Best-effort persistence

    def _compute_hash(self, content: str | bytes) -> str:
        """Compute content hash."""
        if isinstance(content, str):
            content = content.encode("utf-8")
        # Use 20 chars instead of 16 to reduce collision risk
        return hashlib.sha256(content).hexdigest()[:20]

    def _generate_backup_id(self) -> str:
        """Generate unique backup ID."""
        self._backup_counter += 1
        self._save_counter()  # Persist counter on each increment
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        return f"bak_{timestamp}_{self._backup_counter:04d}"

    def backup_file(
        self,
        file_path: Path | str,
        description: str = "",
    ) -> BackupEntry:
        """
        Create a backup of a file.

        Args:
            file_path: Path to file to backup
            description: Description of why backup was created

        Returns:
            BackupEntry with backup details
        """
        file_path = Path(file_path)

        if not file_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        # Read content and compute hash
        content = file_path.read_text()
        content_hash = self._compute_hash(content)

        # Generate backup path
        backup_id = self._generate_backup_id()
        backup_name = f"{file_path.stem}_{backup_id}{file_path.suffix}.bak"
        backup_path = self.backup_dir / backup_name

        # Copy file
        shutil.copy2(file_path, backup_path)

        # Create entry
        entry = BackupEntry(
            backup_id=backup_id,
            original_path=file_path.absolute(),
            backup_path=backup_path,
            timestamp=datetime.now(),
            content_hash=content_hash,
            file_size=len(content),
            description=description,
        )

        self._entries[backup_id] = entry

        # Cleanup old backups
        self._cleanup_old_backups(file_path)

        return entry

    def backup_content(
        self,
        content: str,
        file_path: Path | str,
        description: str = "",
    ) -> BackupEntry:
        """
        Create a backup from content (without reading file).

        Args:
            content: Content to backup
            file_path: Original file path (for naming)
            description: Description

        Returns:
            BackupEntry
        """
        file_path = Path(file_path)
        content_hash = self._compute_hash(content)

        backup_id = self._generate_backup_id()
        backup_name = f"{file_path.stem}_{backup_id}{file_path.suffix}.bak"
        backup_path = self.backup_dir / backup_name

        # Write content to backup
        backup_path.write_text(content)

        entry = BackupEntry(
            backup_id=backup_id,
            original_path=file_path.absolute() if file_path.exists() else file_path,
            backup_path=backup_path,
            timestamp=datetime.now(),
            content_hash=content_hash,
            file_size=len(content),
            description=description,
        )

        self._entries[backup_id] = entry
        return entry

    def restore(self, backup_id: str) -> bool:
        """
        Restore a file from backup.

        Args:
            backup_id: Backup ID to restore

        Returns:
            True if successful
        """
        if backup_id not in self._entries:
            return False

        entry = self._entries[backup_id]

        if not entry.backup_path.exists():
            return False

        # Backup current state before restore
        if entry.original_path.exists():
            self.backup_file(entry.original_path, "Pre-restore backup")

        # Restore
        shutil.copy2(entry.backup_path, entry.original_path)
        return True

    def get_backups_for_file(
        self,
        file_path: Path | str,
    ) -> list[BackupEntry]:
        """
        Get all backups for a file.

        Args:
            file_path: File to get backups for

        Returns:
            List of backup entries, newest first
        """
        file_path = Path(file_path).absolute()

        entries = [
            entry
            for entry in self._entries.values()
            if entry.original_path == file_path
        ]

        return sorted(entries, key=lambda e: e.timestamp, reverse=True)

    def get_latest_backup(
        self,
        file_path: Path | str,
    ) -> BackupEntry | None:
        """Get latest backup for a file."""
        backups = self.get_backups_for_file(file_path)
        return backups[0] if backups else None

    def read_backup(self, backup_id: str) -> str | None:
        """
        Read content from a backup.

        Args:
            backup_id: Backup ID

        Returns:
            Content or None if not found
        """
        if backup_id not in self._entries:
            return None

        entry = self._entries[backup_id]

        if not entry.backup_path.exists():
            return None

        return entry.backup_path.read_text()

    def delete_backup(self, backup_id: str) -> bool:
        """
        Delete a backup.

        Args:
            backup_id: Backup ID to delete

        Returns:
            True if deleted
        """
        if backup_id not in self._entries:
            return False

        entry = self._entries[backup_id]

        if entry.backup_path.exists():
            entry.backup_path.unlink()

        del self._entries[backup_id]
        return True

    def _cleanup_old_backups(self, file_path: Path) -> int:
        """
        Remove old backups exceeding limit.

        Args:
            file_path: File to cleanup backups for

        Returns:
            Number of backups removed
        """
        backups = self.get_backups_for_file(file_path)

        if len(backups) <= self.max_backups_per_file:
            return 0

        to_remove = backups[self.max_backups_per_file:]
        removed = 0

        for entry in to_remove:
            if self.delete_backup(entry.backup_id):
                removed += 1

        return removed

    def list_all_backups(self) -> list[BackupEntry]:
        """List all backup entries."""
        return sorted(
            self._entries.values(),
            key=lambda e: e.timestamp,
            reverse=True,
        )

    def verify_backup(self, backup_id: str) -> bool:
        """
        Verify backup integrity.

        Args:
            backup_id: Backup ID to verify

        Returns:
            True if backup is valid
        """
        if backup_id not in self._entries:
            return False

        entry = self._entries[backup_id]

        if not entry.backup_path.exists():
            return False

        content = entry.backup_path.read_text()
        current_hash = self._compute_hash(content)

        return current_hash == entry.content_hash

    def get_disk_usage(self) -> int:
        """Get total disk usage of backups in bytes."""
        total = 0
        for entry in self._entries.values():
            if entry.backup_path.exists():
                total += entry.backup_path.stat().st_size
        return total

    def cleanup_all(self) -> int:
        """
        Remove all backups.

        Returns:
            Number of backups removed
        """
        removed = 0
        for backup_id in list(self._entries.keys()):
            if self.delete_backup(backup_id):
                removed += 1
        return removed

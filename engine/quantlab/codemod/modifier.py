"""
Safe Code Modifier.

Provides safe code modification with preview, backup, and undo.

Spec Reference: Technical Spec §9.3
"""

import difflib
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from pathlib import Path
from typing import Any

from quantlab.codemod.backup import BackupEntry
from quantlab.codemod.backup import BackupManager
from quantlab.codemod.transformer import ParameterChange
from quantlab.codemod.transformer import TransformResult
from quantlab.codemod.transformer import transform_function_defaults
from quantlab.codemod.transformer import transform_parameters
from quantlab.codemod.transformer import validate_syntax


@dataclass
class ModificationPreview:
    """Preview of code modification."""

    file_path: Path
    original_content: str
    modified_content: str
    diff: str
    changes: list[str]
    is_valid: bool
    validation_errors: list[str] = field(default_factory=list)


@dataclass
class ModificationResult:
    """Result of applying a code modification."""

    success: bool
    file_path: Path
    backup_entry: BackupEntry | None = None
    changes_made: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class SafeCodeModifier:
    """
    Safe code modification with backup and preview.

    Features:
    - Creates backup before any modification
    - Validates syntax before writing
    - Generates diff for preview
    - Supports undo via backup restoration
    """

    def __init__(
        self,
        backup_dir: Path | str | None = None,
        auto_backup: bool = True,
        validate_before_write: bool = True,
    ) -> None:
        """
        Initialize safe code modifier.

        Args:
            backup_dir: Directory for backups
            auto_backup: Automatically create backups
            validate_before_write: Validate syntax before writing
        """
        self.backup_manager = BackupManager(backup_dir)
        self.auto_backup = auto_backup
        self.validate_before_write = validate_before_write

        self._modification_history: list[ModificationResult] = []

    def preview_changes(
        self,
        file_path: Path | str,
        changes: list[ParameterChange],
    ) -> ModificationPreview:
        """
        Preview changes without applying them.

        Args:
            file_path: Path to file to modify
            changes: List of parameter changes

        Returns:
            ModificationPreview with diff and validation
        """
        file_path = Path(file_path)

        if not file_path.exists():
            return ModificationPreview(
                file_path=file_path,
                original_content="",
                modified_content="",
                diff="",
                changes=[],
                is_valid=False,
                validation_errors=[f"File not found: {file_path}"],
            )

        original = file_path.read_text()
        result = transform_parameters(original, changes)

        if not result.success:
            return ModificationPreview(
                file_path=file_path,
                original_content=original,
                modified_content=original,
                diff="",
                changes=[],
                is_valid=False,
                validation_errors=result.errors,
            )

        # Validate syntax
        is_valid, error = validate_syntax(result.modified_code)
        validation_errors = [error] if not is_valid else []

        # Generate diff
        diff = self._generate_diff(original, result.modified_code, str(file_path))

        return ModificationPreview(
            file_path=file_path,
            original_content=original,
            modified_content=result.modified_code,
            diff=diff,
            changes=result.changes_made,
            is_valid=is_valid,
            validation_errors=validation_errors,
        )

    def apply_changes(
        self,
        file_path: Path | str,
        changes: list[ParameterChange],
        description: str = "",
    ) -> ModificationResult:
        """
        Apply changes to a file.

        Args:
            file_path: Path to file to modify
            changes: List of parameter changes
            description: Description for backup

        Returns:
            ModificationResult with outcome
        """
        file_path = Path(file_path)

        if not file_path.exists():
            return ModificationResult(
                success=False,
                file_path=file_path,
                errors=[f"File not found: {file_path}"],
            )

        original = file_path.read_text()

        # Transform code
        result = transform_parameters(original, changes)

        if not result.success:
            return ModificationResult(
                success=False,
                file_path=file_path,
                errors=result.errors,
            )

        # Validate syntax
        if self.validate_before_write:
            is_valid, error = validate_syntax(result.modified_code)
            if not is_valid:
                return ModificationResult(
                    success=False,
                    file_path=file_path,
                    errors=[f"Syntax validation failed: {error}"],
                )

        # Create backup
        backup_entry = None
        if self.auto_backup:
            backup_entry = self.backup_manager.backup_content(
                original,
                file_path,
                description or f"Before parameter changes: {', '.join(c.param_name for c in changes)}",
            )

        # Write changes
        try:
            file_path.write_text(result.modified_code)
        except Exception as e:
            return ModificationResult(
                success=False,
                file_path=file_path,
                backup_entry=backup_entry,
                errors=[f"Write failed: {e}"],
            )

        mod_result = ModificationResult(
            success=True,
            file_path=file_path,
            backup_entry=backup_entry,
            changes_made=result.changes_made,
        )

        self._modification_history.append(mod_result)
        return mod_result

    def modify_function_defaults(
        self,
        file_path: Path | str,
        function_name: str,
        param_changes: dict[str, Any],
        description: str = "",
    ) -> ModificationResult:
        """
        Modify function parameter defaults.

        Args:
            file_path: Path to file
            function_name: Name of function to modify
            param_changes: Dictionary of param_name -> new_value
            description: Description for backup

        Returns:
            ModificationResult
        """
        file_path = Path(file_path)

        if not file_path.exists():
            return ModificationResult(
                success=False,
                file_path=file_path,
                errors=[f"File not found: {file_path}"],
            )

        original = file_path.read_text()

        # Transform code
        result = transform_function_defaults(original, function_name, param_changes)

        if not result.success:
            return ModificationResult(
                success=False,
                file_path=file_path,
                errors=result.errors,
            )

        # Validate
        if self.validate_before_write:
            is_valid, error = validate_syntax(result.modified_code)
            if not is_valid:
                return ModificationResult(
                    success=False,
                    file_path=file_path,
                    errors=[f"Syntax validation failed: {error}"],
                )

        # Backup
        backup_entry = None
        if self.auto_backup:
            backup_entry = self.backup_manager.backup_content(
                original,
                file_path,
                description or f"Before modifying {function_name} defaults",
            )

        # Write
        try:
            file_path.write_text(result.modified_code)
        except Exception as e:
            return ModificationResult(
                success=False,
                file_path=file_path,
                backup_entry=backup_entry,
                errors=[f"Write failed: {e}"],
            )

        mod_result = ModificationResult(
            success=True,
            file_path=file_path,
            backup_entry=backup_entry,
            changes_made=result.changes_made,
        )

        self._modification_history.append(mod_result)
        return mod_result

    def undo_last(self) -> bool:
        """
        Undo the last modification.

        Returns:
            True if successful
        """
        if not self._modification_history:
            return False

        last_mod = self._modification_history[-1]

        if last_mod.backup_entry is None:
            return False

        if self.backup_manager.restore(last_mod.backup_entry.backup_id):
            self._modification_history.pop()
            return True

        return False

    def undo_by_backup_id(self, backup_id: str) -> bool:
        """
        Undo a specific modification by backup ID.

        Args:
            backup_id: Backup ID to restore

        Returns:
            True if successful
        """
        return self.backup_manager.restore(backup_id)

    def get_modification_history(self) -> list[ModificationResult]:
        """Get modification history."""
        return self._modification_history.copy()

    def get_file_history(
        self,
        file_path: Path | str,
    ) -> list[BackupEntry]:
        """Get backup history for a file."""
        return self.backup_manager.get_backups_for_file(file_path)

    def _generate_diff(
        self,
        original: str,
        modified: str,
        file_name: str,
    ) -> str:
        """Generate unified diff."""
        original_lines = original.splitlines(keepends=True)
        modified_lines = modified.splitlines(keepends=True)

        diff = difflib.unified_diff(
            original_lines,
            modified_lines,
            fromfile=f"a/{file_name}",
            tofile=f"b/{file_name}",
        )

        return "".join(diff)


class CodeModificationSession:
    """
    Session for batched code modifications.

    Allows grouping multiple changes with single backup.
    """

    def __init__(
        self,
        modifier: SafeCodeModifier,
    ) -> None:
        """
        Initialize modification session.

        Args:
            modifier: SafeCodeModifier to use
        """
        self.modifier = modifier
        self._pending_changes: dict[Path, list[ParameterChange]] = {}
        self._session_backups: list[BackupEntry] = []

    def add_change(
        self,
        file_path: Path | str,
        change: ParameterChange,
    ) -> None:
        """
        Add a change to the session.

        Args:
            file_path: File to modify
            change: Change to add
        """
        file_path = Path(file_path)

        if file_path not in self._pending_changes:
            self._pending_changes[file_path] = []

        self._pending_changes[file_path].append(change)

    def preview_all(self) -> dict[Path, ModificationPreview]:
        """
        Preview all pending changes.

        Returns:
            Dictionary of file_path -> preview
        """
        previews = {}

        for file_path, changes in self._pending_changes.items():
            preview = self.modifier.preview_changes(file_path, changes)
            previews[file_path] = preview

        return previews

    def apply_all(
        self,
        description: str = "",
    ) -> list[ModificationResult]:
        """
        Apply all pending changes.

        Args:
            description: Description for backups

        Returns:
            List of modification results
        """
        results = []

        for file_path, changes in self._pending_changes.items():
            result = self.modifier.apply_changes(
                file_path,
                changes,
                description or f"Batch modification session",
            )
            results.append(result)

            if result.backup_entry:
                self._session_backups.append(result.backup_entry)

        # Clear pending changes
        self._pending_changes.clear()

        return results

    def rollback_session(self) -> int:
        """
        Rollback all changes from this session.

        Returns:
            Number of files restored
        """
        restored = 0

        for backup in reversed(self._session_backups):
            if self.modifier.backup_manager.restore(backup.backup_id):
                restored += 1

        self._session_backups.clear()
        return restored

    def clear(self) -> None:
        """Clear pending changes without applying."""
        self._pending_changes.clear()

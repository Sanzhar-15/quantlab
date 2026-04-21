"""
Tests for Code Modification Module.

Tests LibCST transformations, backup management, and safe modifications.
"""

from decimal import Decimal
from pathlib import Path

import pytest

from quantlab.codemod import (
    BackupEntry,
    BackupManager,
    CodeModificationSession,
    ModificationPreview,
    ModificationResult,
    ParameterChange,
    SafeCodeModifier,
    TransformResult,
    transform_function_defaults,
    transform_parameters,
    validate_syntax,
)


class TestValidateSyntax:
    """Tests for syntax validation."""

    def test_valid_python_syntax(self) -> None:
        """Test validation of valid Python code."""
        code = '''
def foo(x: int = 10) -> int:
    return x * 2

class Bar:
    value = 42
'''
        is_valid, error = validate_syntax(code)
        assert is_valid
        assert error == ""

    def test_invalid_python_syntax(self) -> None:
        """Test validation of invalid Python code."""
        code = '''
def foo(x: int = 10:  # Missing closing paren
    return x * 2
'''
        is_valid, error = validate_syntax(code)
        assert not is_valid
        assert "Syntax error" in error


class TestParameterChange:
    """Tests for ParameterChange dataclass."""

    def test_parameter_change_creation(self) -> None:
        """Test creating a parameter change."""
        change = ParameterChange(
            class_name="MyStrategy",
            param_name="lookback",
            old_value=20,
            new_value=50,
        )

        assert change.class_name == "MyStrategy"
        assert change.param_name == "lookback"
        assert change.old_value == 20
        assert change.new_value == 50

    def test_module_level_change(self) -> None:
        """Test module-level parameter change."""
        change = ParameterChange(
            class_name=None,  # Module level
            param_name="THRESHOLD",
            old_value=0.05,
            new_value=0.10,
        )

        assert change.class_name is None


class TestTransformParameters:
    """Tests for transform_parameters function."""

    def test_transform_class_attribute(self) -> None:
        """Test transforming class attribute."""
        code = '''
class MyStrategy:
    lookback = 20
    threshold = 0.05
'''
        changes = [
            ParameterChange(
                class_name="MyStrategy",
                param_name="lookback",
                old_value=20,
                new_value=50,
            ),
        ]

        result = transform_parameters(code, changes)

        assert result.success
        assert "lookback = 50" in result.modified_code
        assert "threshold = 0.05" in result.modified_code

    def test_transform_module_level_variable(self) -> None:
        """Test transforming module-level variable."""
        code = '''
DEFAULT_LOOKBACK = 20
MAX_EXPOSURE = 0.5
'''
        changes = [
            ParameterChange(
                class_name=None,
                param_name="DEFAULT_LOOKBACK",
                old_value=20,
                new_value=100,
            ),
        ]

        result = transform_parameters(code, changes)

        assert result.success
        assert "DEFAULT_LOOKBACK = 100" in result.modified_code

    def test_transform_decimal_value(self) -> None:
        """Test transforming to Decimal value."""
        code = '''
class Config:
    threshold = 0.05
'''
        changes = [
            ParameterChange(
                class_name="Config",
                param_name="threshold",
                old_value=0.05,
                new_value=Decimal("0.10"),
            ),
        ]

        result = transform_parameters(code, changes)

        assert result.success
        assert 'Decimal("0.10")' in result.modified_code or "0.10" in result.modified_code

    def test_transform_preserves_formatting(self) -> None:
        """Test that transformation preserves code formatting."""
        code = '''class MyStrategy:
    # Important comment
    lookback = 20  # inline comment

    def __init__(self):
        pass
'''
        changes = [
            ParameterChange(
                class_name="MyStrategy",
                param_name="lookback",
                old_value=20,
                new_value=50,
            ),
        ]

        result = transform_parameters(code, changes)

        assert result.success
        # Comments should be preserved
        assert "Important comment" in result.modified_code

    def test_transform_multiple_changes(self) -> None:
        """Test multiple simultaneous changes."""
        code = '''
class Strategy:
    param1 = 10
    param2 = 20
    param3 = 30
'''
        changes = [
            ParameterChange("Strategy", "param1", 10, 100),
            ParameterChange("Strategy", "param3", 30, 300),
        ]

        result = transform_parameters(code, changes)

        assert result.success
        assert "param1 = 100" in result.modified_code
        assert "param2 = 20" in result.modified_code  # Unchanged
        assert "param3 = 300" in result.modified_code


class TestTransformFunctionDefaults:
    """Tests for transform_function_defaults function."""

    def test_transform_function_default(self) -> None:
        """Test transforming function parameter default."""
        code = '''
def my_function(x: int = 10, y: float = 0.5) -> float:
    return x * y
'''
        result = transform_function_defaults(
            code,
            function_name="my_function",
            param_changes={"x": 50},
        )

        assert result.success
        assert "x: int = 50" in result.modified_code
        assert "y: float = 0.5" in result.modified_code  # Unchanged

    def test_transform_multiple_defaults(self) -> None:
        """Test transforming multiple function defaults."""
        code = '''
def strategy(data, lookback: int = 20, threshold: float = 0.05):
    pass
'''
        result = transform_function_defaults(
            code,
            function_name="strategy",
            param_changes={"lookback": 50, "threshold": 0.10},
        )

        assert result.success
        assert "lookback: int = 50" in result.modified_code
        assert "threshold: float = 0.1" in result.modified_code


class TestBackupManager:
    """Tests for BackupManager."""

    @pytest.fixture
    def backup_manager(self, tmp_path: Path) -> BackupManager:
        """Create backup manager with temp directory."""
        return BackupManager(backup_dir=tmp_path)

    def test_backup_file(
        self,
        backup_manager: BackupManager,
        tmp_path: Path,
    ) -> None:
        """Test backing up a file."""
        # Create test file
        test_file = tmp_path / "test.py"
        test_file.write_text("x = 10")

        entry = backup_manager.backup_file(test_file)

        assert entry.original_path == test_file.absolute()
        assert entry.backup_path.exists()
        assert entry.backup_path.read_text() == "x = 10"

    def test_backup_content(
        self,
        backup_manager: BackupManager,
        tmp_path: Path,
    ) -> None:
        """Test backing up content directly."""
        entry = backup_manager.backup_content(
            content="original content",
            file_path=tmp_path / "test.py",
            description="Test backup",
        )

        assert entry.backup_path.exists()
        assert backup_manager.read_backup(entry.backup_id) == "original content"

    def test_restore_backup(
        self,
        backup_manager: BackupManager,
        tmp_path: Path,
    ) -> None:
        """Test restoring from backup."""
        # Create and modify file
        test_file = tmp_path / "test.py"
        test_file.write_text("original")

        entry = backup_manager.backup_file(test_file)

        test_file.write_text("modified")

        # Restore
        success = backup_manager.restore(entry.backup_id)

        assert success
        assert test_file.read_text() == "original"

    def test_get_backups_for_file(
        self,
        backup_manager: BackupManager,
        tmp_path: Path,
    ) -> None:
        """Test getting backups for a file."""
        test_file = tmp_path / "test.py"
        test_file.write_text("v1")

        backup_manager.backup_file(test_file)
        test_file.write_text("v2")
        backup_manager.backup_file(test_file)

        backups = backup_manager.get_backups_for_file(test_file)

        assert len(backups) == 2

    def test_verify_backup_integrity(
        self,
        backup_manager: BackupManager,
        tmp_path: Path,
    ) -> None:
        """Test backup integrity verification."""
        entry = backup_manager.backup_content(
            content="test content",
            file_path=tmp_path / "test.py",
        )

        assert backup_manager.verify_backup(entry.backup_id)

        # Corrupt the backup
        entry.backup_path.write_text("corrupted")

        assert not backup_manager.verify_backup(entry.backup_id)


class TestSafeCodeModifier:
    """Tests for SafeCodeModifier."""

    @pytest.fixture
    def modifier(self, tmp_path: Path) -> SafeCodeModifier:
        """Create safe code modifier."""
        return SafeCodeModifier(
            backup_dir=tmp_path / "backups",
            auto_backup=True,
            validate_before_write=True,
        )

    @pytest.fixture
    def test_file(self, tmp_path: Path) -> Path:
        """Create test Python file."""
        test_file = tmp_path / "strategy.py"
        test_file.write_text('''
class MyStrategy:
    lookback = 20
    threshold = 0.05

    def run(self):
        pass
''')
        return test_file

    def test_preview_changes(
        self,
        modifier: SafeCodeModifier,
        test_file: Path,
    ) -> None:
        """Test previewing changes without applying."""
        changes = [
            ParameterChange("MyStrategy", "lookback", 20, 50),
        ]

        preview = modifier.preview_changes(test_file, changes)

        assert preview.is_valid
        assert "lookback = 50" in preview.modified_content
        assert len(preview.diff) > 0
        # File should be unchanged
        assert "lookback = 20" in test_file.read_text()

    def test_apply_changes(
        self,
        modifier: SafeCodeModifier,
        test_file: Path,
    ) -> None:
        """Test applying changes."""
        changes = [
            ParameterChange("MyStrategy", "lookback", 20, 50),
        ]

        result = modifier.apply_changes(test_file, changes)

        assert result.success
        assert result.backup_entry is not None
        assert "lookback = 50" in test_file.read_text()

    def test_undo_last_modification(
        self,
        modifier: SafeCodeModifier,
        test_file: Path,
    ) -> None:
        """Test undoing last modification."""
        changes = [
            ParameterChange("MyStrategy", "lookback", 20, 50),
        ]

        modifier.apply_changes(test_file, changes)
        assert "lookback = 50" in test_file.read_text()

        success = modifier.undo_last()

        assert success
        assert "lookback = 20" in test_file.read_text()

    def test_modify_function_defaults(
        self,
        modifier: SafeCodeModifier,
        tmp_path: Path,
    ) -> None:
        """Test modifying function parameter defaults."""
        test_file = tmp_path / "func.py"
        test_file.write_text('''
def calculate(x: int = 10, y: float = 0.5) -> float:
    return x * y
''')

        result = modifier.modify_function_defaults(
            test_file,
            function_name="calculate",
            param_changes={"x": 100},
        )

        assert result.success
        assert "x: int = 100" in test_file.read_text()


class TestCodeModificationSession:
    """Tests for CodeModificationSession."""

    @pytest.fixture
    def modifier(self, tmp_path: Path) -> SafeCodeModifier:
        """Create modifier."""
        return SafeCodeModifier(backup_dir=tmp_path / "backups")

    @pytest.fixture
    def test_files(self, tmp_path: Path) -> tuple[Path, Path]:
        """Create test files."""
        file1 = tmp_path / "strategy1.py"
        file1.write_text("class S1:\n    param = 10\n")

        file2 = tmp_path / "strategy2.py"
        file2.write_text("class S2:\n    value = 20\n")

        return file1, file2

    def test_batch_changes(
        self,
        modifier: SafeCodeModifier,
        test_files: tuple[Path, Path],
    ) -> None:
        """Test batching changes across files."""
        file1, file2 = test_files

        session = CodeModificationSession(modifier)

        session.add_change(
            file1,
            ParameterChange("S1", "param", 10, 100),
        )
        session.add_change(
            file2,
            ParameterChange("S2", "value", 20, 200),
        )

        results = session.apply_all()

        assert len(results) == 2
        assert all(r.success for r in results)

        assert "param = 100" in file1.read_text()
        assert "value = 200" in file2.read_text()

    def test_preview_all(
        self,
        modifier: SafeCodeModifier,
        test_files: tuple[Path, Path],
    ) -> None:
        """Test previewing all changes."""
        file1, file2 = test_files

        session = CodeModificationSession(modifier)

        session.add_change(
            file1,
            ParameterChange("S1", "param", 10, 100),
        )

        previews = session.preview_all()

        assert file1 in previews
        assert previews[file1].is_valid

    def test_rollback_session(
        self,
        modifier: SafeCodeModifier,
        test_files: tuple[Path, Path],
    ) -> None:
        """Test rolling back all session changes."""
        file1, file2 = test_files

        session = CodeModificationSession(modifier)

        session.add_change(
            file1,
            ParameterChange("S1", "param", 10, 100),
        )
        session.add_change(
            file2,
            ParameterChange("S2", "value", 20, 200),
        )

        session.apply_all()

        # Verify changes applied
        assert "param = 100" in file1.read_text()

        # Rollback
        restored = session.rollback_session()

        assert restored == 2
        assert "param = 10" in file1.read_text()
        assert "value = 20" in file2.read_text()


class TestTransformResult:
    """Tests for TransformResult."""

    def test_successful_result(self) -> None:
        """Test successful transformation result."""
        result = TransformResult(
            success=True,
            modified_code="x = 50",
            changes_made=["Changed x from 20 to 50"],
        )

        assert result.success
        assert len(result.changes_made) == 1
        assert len(result.errors) == 0

    def test_failed_result(self) -> None:
        """Test failed transformation result."""
        result = TransformResult(
            success=False,
            modified_code="original",
            errors=["Parse error at line 5"],
        )

        assert not result.success
        assert len(result.errors) == 1


class TestParameterTransformerValueConversions:
    """Tests for _value_to_cst method with various types."""

    def test_transform_negative_integer(self) -> None:
        """Test transforming to negative integer."""
        code = '''
class Config:
    offset = 10
'''
        changes = [
            ParameterChange("Config", "offset", 10, -5),
        ]
        result = transform_parameters(code, changes)
        assert result.success
        assert "-5" in result.modified_code

    def test_transform_negative_float(self) -> None:
        """Test transforming to negative float."""
        code = '''
class Config:
    threshold = 0.5
'''
        changes = [
            ParameterChange("Config", "threshold", 0.5, -0.1),
        ]
        result = transform_parameters(code, changes)
        assert result.success
        assert "-0.1" in result.modified_code

    def test_transform_to_none(self) -> None:
        """Test transforming to None value."""
        code = '''
class Config:
    default = 10
'''
        changes = [
            ParameterChange("Config", "default", 10, None),
        ]
        result = transform_parameters(code, changes)
        assert result.success
        assert "None" in result.modified_code

    def test_transform_to_boolean_true(self) -> None:
        """Test transforming to True."""
        code = '''
class Config:
    enabled = 0
'''
        changes = [
            ParameterChange("Config", "enabled", 0, True),
        ]
        result = transform_parameters(code, changes)
        assert result.success
        assert "True" in result.modified_code

    def test_transform_to_boolean_false(self) -> None:
        """Test transforming to False."""
        code = '''
class Config:
    enabled = 1
'''
        changes = [
            ParameterChange("Config", "enabled", 1, False),
        ]
        result = transform_parameters(code, changes)
        assert result.success
        assert "False" in result.modified_code

    def test_transform_to_string(self) -> None:
        """Test transforming to string."""
        code = '''
class Config:
    name = "old"
'''
        changes = [
            ParameterChange("Config", "name", "old", "new_value"),
        ]
        result = transform_parameters(code, changes)
        assert result.success
        assert '"new_value"' in result.modified_code

    def test_transform_to_list(self) -> None:
        """Test transforming to list."""
        code = '''
class Config:
    values = []
'''
        changes = [
            ParameterChange("Config", "values", [], [1, 2, 3]),
        ]
        result = transform_parameters(code, changes)
        assert result.success
        assert "[1, 2, 3]" in result.modified_code

    def test_transform_to_dict(self) -> None:
        """Test transforming to dict."""
        code = '''
class Config:
    settings = {}
'''
        changes = [
            ParameterChange("Config", "settings", {}, {"a": 1, "b": 2}),
        ]
        result = transform_parameters(code, changes)
        assert result.success
        # Check dict elements are present
        assert '"a"' in result.modified_code
        assert '"b"' in result.modified_code

    def test_transform_to_unknown_type(self) -> None:
        """Test transforming to unknown type falls back to string."""
        code = '''
class Config:
    custom = "old"
'''

        class CustomType:
            pass

        changes = [
            ParameterChange("Config", "custom", "old", CustomType()),
        ]
        result = transform_parameters(code, changes)
        assert result.success
        # Unknown types fall back to string representation

    def test_transform_annotated_assignment(self) -> None:
        """Test transforming annotated assignment."""
        code = '''
class Config:
    lookback: int = 20
'''
        changes = [
            ParameterChange("Config", "lookback", 20, 50),
        ]
        result = transform_parameters(code, changes)
        assert result.success
        assert "50" in result.modified_code


class TestFunctionParameterTransformerEdgeCases:
    """Edge case tests for FunctionParameterTransformer."""

    def test_transform_function_not_found(self) -> None:
        """Test transforming when function not found."""
        code = '''
def other_function(x: int = 10) -> int:
    return x
'''
        result = transform_function_defaults(
            code,
            function_name="nonexistent_function",
            param_changes={"x": 20},
        )
        assert result.success
        # No changes made since function not found
        assert "x: int = 10" in result.modified_code

    def test_transform_function_string_default(self) -> None:
        """Test transforming function default to string."""
        code = '''
def process(name: str = "default") -> str:
    return name
'''
        result = transform_function_defaults(
            code,
            function_name="process",
            param_changes={"name": "new_name"},
        )
        assert result.success
        assert '"new_name"' in result.modified_code

    def test_transform_function_none_default(self) -> None:
        """Test transforming function default to None."""
        code = '''
def process(callback = lambda x: x) -> None:
    callback(1)
'''
        result = transform_function_defaults(
            code,
            function_name="process",
            param_changes={"callback": None},
        )
        assert result.success
        assert "None" in result.modified_code

    def test_transform_function_bool_default(self) -> None:
        """Test transforming function default to bool."""
        code = '''
def check(enabled: bool = False) -> bool:
    return enabled
'''
        result = transform_function_defaults(
            code,
            function_name="check",
            param_changes={"enabled": True},
        )
        assert result.success
        assert "True" in result.modified_code

    def test_transform_function_unknown_type_default(self) -> None:
        """Test transforming function default to unknown type."""
        code = '''
def configure(setting = 1) -> None:
    pass
'''

        class CustomSetting:
            pass

        result = transform_function_defaults(
            code,
            function_name="configure",
            param_changes={"setting": CustomSetting()},
        )
        assert result.success


class TestTransformParametersEdgeCases:
    """Edge case tests for transform_parameters."""

    def test_transform_no_matching_class(self) -> None:
        """Test when class name doesn't match."""
        code = '''
class OtherClass:
    param = 10
'''
        changes = [
            ParameterChange("NonexistentClass", "param", 10, 20),
        ]
        result = transform_parameters(code, changes)
        assert result.success
        # No changes since class doesn't match
        assert "param = 10" in result.modified_code

    def test_transform_module_level_when_in_class(self) -> None:
        """Test module-level change doesn't affect class attributes."""
        code = '''
GLOBAL_PARAM = 5

class MyClass:
    param = 10
'''
        changes = [
            ParameterChange(None, "param", 10, 20),  # Module level
        ]
        result = transform_parameters(code, changes)
        assert result.success
        # Class attribute should be unchanged
        assert "param = 10" in result.modified_code

    def test_transform_with_syntax_error(self) -> None:
        """Test transform with invalid syntax."""
        code = '''
class Config:
    param =
'''  # Invalid syntax
        changes = [
            ParameterChange("Config", "param", None, 10),
        ]
        result = transform_parameters(code, changes)
        assert not result.success
        assert len(result.errors) > 0

    def test_transform_empty_changes(self) -> None:
        """Test transform with no changes."""
        code = '''
class Config:
    param = 10
'''
        changes: list[ParameterChange] = []
        result = transform_parameters(code, changes)
        assert result.success
        assert result.modified_code == code

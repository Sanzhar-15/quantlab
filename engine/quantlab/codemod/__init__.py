"""
Code modification module.

Provides:
- SafeCodeModifier for parameter updates
- LibCST-based AST transformation (preserves formatting)
- Backup management
- Diff generation for preview
- Syntax validation before write
- NDJSON IPC protocol for subprocess communication (Phase 6)

Spec Reference: Technical Spec §9, §20.5
"""

from .backup import BackupEntry
from .backup import BackupManager
from .modifier import CodeModificationSession
from .modifier import ModificationPreview
from .modifier import ModificationResult
from .modifier import SafeCodeModifier
from .transformer import ParameterChange
from .transformer import TransformResult
from .transformer import transform_function_defaults
from .transformer import transform_parameters
from .transformer import validate_syntax

# Phase 6 Protocol-based components
from .protocol import (
    EditType,
    EditStatus,
    SourceLocation,
    SourceRange,
    ParameterEdit,
    ImportEdit,
    CodeEdit,
    EditRequest,
    EditResponse,
    EditResult,
    ParseRequest,
    ParseResponse,
    DiffHunk,
    ParameterInfo,
    ImportInfo,
    FunctionInfo,
    CodeModParser,
    CodeModWriter,
)

from .engine import (
    CodeModEngine,
    SourceAnalyzer,
    create_parameter_edit,
    create_import_edit,
)

from .transformers import (
    ParameterTransformer,
    ImportTransformer,
    AssignmentTransformer,
    FunctionBodyTransformer,
    CodeInserter,
    apply_edits,
)

from .handler import (
    CodeModHandler,
    handle_single_request,
    main as codemod_main,
)

__all__ = [
    # Backup
    "BackupEntry",
    "BackupManager",
    # Transformer (legacy)
    "ParameterChange",
    "TransformResult",
    "transform_parameters",
    "transform_function_defaults",
    "validate_syntax",
    # Modifier (legacy)
    "ModificationPreview",
    "ModificationResult",
    "SafeCodeModifier",
    "CodeModificationSession",
    # Phase 6 Protocol
    "EditType",
    "EditStatus",
    "SourceLocation",
    "SourceRange",
    "ParameterEdit",
    "ImportEdit",
    "CodeEdit",
    "EditRequest",
    "EditResponse",
    "EditResult",
    "ParseRequest",
    "ParseResponse",
    "DiffHunk",
    "ParameterInfo",
    "ImportInfo",
    "FunctionInfo",
    "CodeModParser",
    "CodeModWriter",
    # Phase 6 Engine
    "CodeModEngine",
    "SourceAnalyzer",
    "create_parameter_edit",
    "create_import_edit",
    # Phase 6 Transformers
    "ParameterTransformer",
    "ImportTransformer",
    "AssignmentTransformer",
    "FunctionBodyTransformer",
    "CodeInserter",
    "apply_edits",
    # Phase 6 Handler
    "CodeModHandler",
    "handle_single_request",
    "codemod_main",
]

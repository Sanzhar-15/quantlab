"""
Run artifacts module.

Provides:
- Artifact manifest generation (§17.1)
- Artifact folder structure (§17.2)
- Code snapshot mandate (§17.3)
- Report schemas for PDF/HTML export (§17.4)
- Export disclosure

Spec Reference: Technical Spec §17
"""

from .code_snapshot import CodeFile
from .code_snapshot import CodeSnapshot
from .code_snapshot import capture_strategy_snapshot
from .manifest import SCHEMA_VERSION
from .manifest import ArtifactFile
from .manifest import ArtifactManifest
from .manifest import create_artifact_structure
from .manifest import generate_artifact_folder_name
from .report import ChartSpec
from .report import DateRange
from .report import Disclaimer
from .report import HTMLReportSchema
from .report import MetricsTableRow
from .report import PDFReportSchema
from .report import ProvenanceInfo
from .report import ReportFooter
from .report import ReportHeader
from .report import ReportSummary
from .report import TradeTableRow
from .report import create_metrics_table
from .report import create_report_summary
from .report import create_trades_table

__all__ = [
    # Schema version
    "SCHEMA_VERSION",
    # Manifest
    "ArtifactFile",
    "ArtifactManifest",
    "generate_artifact_folder_name",
    "create_artifact_structure",
    # Code snapshot
    "CodeFile",
    "CodeSnapshot",
    "capture_strategy_snapshot",
    # Report schemas
    "DateRange",
    "ProvenanceInfo",
    "ReportSummary",
    "ChartSpec",
    "MetricsTableRow",
    "TradeTableRow",
    "Disclaimer",
    "ReportFooter",
    "ReportHeader",
    "PDFReportSchema",
    "HTMLReportSchema",
    # Helper functions
    "create_report_summary",
    "create_metrics_table",
    "create_trades_table",
]

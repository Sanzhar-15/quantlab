"""
Report Export Module.

Provides export functionality for backtest results:
- JSON: Full programmatic access
- CSV: Spreadsheet-compatible trades and metrics
- HTML: Visual report for sharing
- Migration: Backup and restore configuration

Spec Reference: Technical Spec §17.4, Decision K64, Decision N94
"""

from .json import JSONExporter, export_to_json
from .csv import CSVExporter, export_trades_csv, export_metrics_csv
from .html import HTMLReportGenerator, export_to_html
from .migration import (
    ExportManifest,
    ExportConfig,
    ImportResult,
    MigrationExporter,
    MigrationImporter,
    create_export,
    import_from_export,
)

__all__ = [
    # Report exports
    "JSONExporter",
    "export_to_json",
    "CSVExporter",
    "export_trades_csv",
    "export_metrics_csv",
    "HTMLReportGenerator",
    "export_to_html",
    # Migration exports
    "ExportManifest",
    "ExportConfig",
    "ImportResult",
    "MigrationExporter",
    "MigrationImporter",
    "create_export",
    "import_from_export",
]

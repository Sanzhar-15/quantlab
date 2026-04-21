"""
Data handling module.

Provides:
- DataRev tracking for data provenance
- UniverseRev for universe versioning
- Content hashing (full and sampled)
- Schema detection
- Survivorship bias protection

Spec Reference: Technical Spec §5
"""

from .hash import ContentHasher
from .hash import HashResult
from .hash import RowHasher
from .hash import SampledHasher
from .hash import hash_bytes_quick
from .hash import hash_file_quick
from .rev import DataFormat
from .rev import DataRev
from .rev import DataRevBuilder
from .rev import DataRevStore
from .rev import DataSchema
from .rev import DataSource
from .universe import MembershipChange
from .universe import MembershipChangeType
from .universe import PredefinedUniverses
from .universe import UniverseBuilder
from .universe import UniverseRev
from .universe import UniverseSnapshot
from .universe import UniverseStore
from .universe import UniverseType
from .service import BinaryEncoder
from .service import CacheEntry
from .service import CSVLoader
from .service import DataCache
from .service import DataService
from .service import MockDataGenerator
from .service import OHLCVBar
from .service import OHLCVSeries
from .service import Timeframe
from .corporate_actions import (
    CorporateActionType,
    CorporateAction,
    DetectedAnomaly,
    ValidationResult,
    CorporateActionsDetector,
    CorporateActionsAdjuster,
    CorporateActionsStore,
    validate_data_for_corporate_actions,
    create_adjuster_from_file,
)

__all__ = [
    # Hashing
    "HashResult",
    "ContentHasher",
    "SampledHasher",
    "RowHasher",
    "hash_file_quick",
    "hash_bytes_quick",
    # DataRev
    "DataSource",
    "DataFormat",
    "DataSchema",
    "DataRev",
    "DataRevBuilder",
    "DataRevStore",
    # UniverseRev
    "UniverseType",
    "MembershipChangeType",
    "MembershipChange",
    "UniverseSnapshot",
    "UniverseRev",
    "UniverseBuilder",
    "UniverseStore",
    "PredefinedUniverses",
    # DataService (Phase 3)
    "Timeframe",
    "OHLCVBar",
    "OHLCVSeries",
    "CacheEntry",
    "DataCache",
    "BinaryEncoder",
    "CSVLoader",
    "MockDataGenerator",
    "DataService",
    # Corporate Actions
    "CorporateActionType",
    "CorporateAction",
    "DetectedAnomaly",
    "ValidationResult",
    "CorporateActionsDetector",
    "CorporateActionsAdjuster",
    "CorporateActionsStore",
    "validate_data_for_corporate_actions",
    "create_adjuster_from_file",
]

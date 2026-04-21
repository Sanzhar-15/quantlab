"""
Environment snapshot module.

Provides:
- Environment state capture for reproducibility (§8.1)
- Determinism enforcement (§8.2)
- Numerical tolerance configuration (§8.3)

Spec Reference: Technical Spec §8
"""

from .determinism import ReproductionContext
from .determinism import ReproductionError
from .determinism import VersionMismatch
from .determinism import set_reproducible_seed
from .determinism import setup_deterministic_execution
from .environment import EnvironmentSnapshot
from .environment import PackageVersion
from .environment import PythonInfo
from .environment import RandomState
from .environment import SystemInfo
from .environment import capture_environment
from .tolerance import ComparisonResult
from .tolerance import MetricType
from .tolerance import ReproductionComparisonResult
from .tolerance import Tolerance
from .tolerance import TOLERANCES
from .tolerance import compare_results
from .tolerance import compare_value
from .tolerance import get_tolerance
from .tolerance import is_equivalent

__all__ = [
    # Environment
    "PackageVersion",
    "PythonInfo",
    "SystemInfo",
    "RandomState",
    "EnvironmentSnapshot",
    "capture_environment",
    # Determinism
    "VersionMismatch",
    "ReproductionContext",
    "ReproductionError",
    "setup_deterministic_execution",
    "set_reproducible_seed",
    # Tolerance
    "MetricType",
    "Tolerance",
    "TOLERANCES",
    "get_tolerance",
    "is_equivalent",
    "ComparisonResult",
    "ReproductionComparisonResult",
    "compare_value",
    "compare_results",
]

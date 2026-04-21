"""
Feature store module.

Provides:
- Feature cache key computation (§7.1)
- Caching layer for computed features
- Look-ahead protection via AST analysis (§7.2)
- Dependency tracking

Spec Reference: Technical Spec §7
"""

from .cache import CacheEntry
from .cache import CacheKey
from .cache import FeatureCache
from .cache import cached_feature
from .cache import compute_feature_cache_key
from .dependencies import DependencyResolver
from .dependencies import FeatureInfo
from .dependencies import get_computation_order
from .dependencies import get_dependency_hashes
from .dependencies import get_resolver
from .dependencies import register_feature
from .leakage import FeatureLeakageError
from .leakage import LeakageAnalysisResult
from .leakage import LeakageDetector
from .leakage import LeakageType
from .leakage import LeakageWarning
from .leakage import analyze_code_for_leakage
from .leakage import analyze_function_for_leakage
from .leakage import safe_feature

__all__ = [
    # Cache
    "CacheKey",
    "CacheEntry",
    "FeatureCache",
    "compute_feature_cache_key",
    "cached_feature",
    # Leakage detection
    "LeakageType",
    "LeakageWarning",
    "LeakageAnalysisResult",
    "LeakageDetector",
    "FeatureLeakageError",
    "analyze_code_for_leakage",
    "analyze_function_for_leakage",
    "safe_feature",
    # Dependencies
    "FeatureInfo",
    "DependencyResolver",
    "register_feature",
    "get_resolver",
    "get_computation_order",
    "get_dependency_hashes",
]

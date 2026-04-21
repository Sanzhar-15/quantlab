"""
Feature Cache Module.

Provides deterministic caching for computed features.

Per §7.1, cache keys are computed from:
- Code hash
- Data rev hash
- Symbol
- Timeframe
- Date range
- Engine version
- Dependency hashes

Spec Reference: Technical Spec §7.1
"""

import hashlib
import io
import json
import logging
import pickle
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from pathlib import Path
from typing import Any
from typing import Callable
from typing import TypeVar


logger = logging.getLogger(__name__)


# FIX-M12: Restricted unpickler to prevent arbitrary code execution.
# Only allows known-safe modules used by cached feature values.
_SAFE_PICKLE_MODULES = frozenset({
    "builtins",
    "collections",
    "datetime",
    "decimal",
    "quantlab.features.cache",
    "numpy",
    "numpy.core.multiarray",
    "numpy.core.numeric",
    "numpy.core._multiarray_umath",
    "pandas.core.frame",
    "pandas.core.series",
    "pandas.core.indexes.base",
    "pandas.core.indexes.range",
    "pandas.core.internals.managers",
    "pandas.core.internals.blocks",
    "pandas._libs.tslibs.timestamps",
})


class _RestrictedUnpickler(pickle.Unpickler):
    """Unpickler that only allows classes from known-safe modules."""

    def find_class(self, module: str, name: str) -> Any:
        if module in _SAFE_PICKLE_MODULES:
            return super().find_class(module, name)
        raise pickle.UnpicklingError(
            f"Refused to unpickle class {module}.{name}: module not in allowlist"
        )


T = TypeVar("T")


@dataclass
class CacheKey:
    """
    Deterministic cache key for features.

    Combines all factors that affect feature computation.
    """

    code_hash: str
    data_rev: str
    symbol: str
    timeframe: str
    start_date: str
    end_date: str
    engine_version: str
    dependency_hashes: dict[str, str] = field(default_factory=dict)
    parameters: dict[str, Any] = field(default_factory=dict)

    def compute(self) -> str:
        """Compute the final cache key hash."""
        data = json.dumps(
            {
                "code_hash": self.code_hash,
                "data_rev": self.data_rev,
                "symbol": self.symbol,
                "timeframe": self.timeframe,
                "start_date": self.start_date,
                "end_date": self.end_date,
                "engine_version": self.engine_version,
                "dependency_hashes": self.dependency_hashes,
                "parameters": self.parameters,
            },
            sort_keys=True,
        )
        return hashlib.sha256(data.encode()).hexdigest()

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "codeHash": self.code_hash,
            "dataRev": self.data_rev,
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "startDate": self.start_date,
            "endDate": self.end_date,
            "engineVersion": self.engine_version,
            "dependencyHashes": self.dependency_hashes,
            "parameters": self.parameters,
        }


@dataclass
class CacheEntry:
    """Cached feature entry."""

    key: str
    value: Any
    created_at: datetime
    size_bytes: int
    metadata: dict[str, Any] = field(default_factory=dict)


class FeatureCache:
    """
    Cache for computed features.

    Provides disk-based caching with LRU eviction.
    """

    def __init__(
        self,
        cache_dir: Path | None = None,
        max_size_bytes: int = 1024 * 1024 * 1024,  # 1GB
    ) -> None:
        self.cache_dir = cache_dir or Path.home() / ".quantlab" / "feature_cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.max_size_bytes = max_size_bytes
        self._in_memory: dict[str, CacheEntry] = {}

    def get(self, key: CacheKey) -> Any | None:
        """
        Get cached feature.

        Args:
            key: Cache key

        Returns:
            Cached value or None if not found
        """
        key_hash = key.compute()

        # Check in-memory cache first
        if key_hash in self._in_memory:
            return self._in_memory[key_hash].value

        # Check disk cache
        cache_path = self._get_cache_path(key_hash)
        if cache_path.exists():
            try:
                with open(cache_path, "rb") as f:
                    entry = _RestrictedUnpickler(f).load()
                    self._in_memory[key_hash] = entry
                    return entry.value
            except Exception as e:
                logger.warning(f"Cache read failed for {key_hash}: {e}")
                cache_path.unlink(missing_ok=True)

        return None

    def set(
        self,
        key: CacheKey,
        value: Any,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        """
        Cache a feature value.

        Args:
            key: Cache key
            value: Value to cache
            metadata: Optional metadata
        """
        key_hash = key.compute()

        # Serialize to get size
        try:
            data = pickle.dumps(value)
            size_bytes = len(data)
        except Exception as e:
            logger.warning(f"Cannot cache value: {e}")
            return

        entry = CacheEntry(
            key=key_hash,
            value=value,
            created_at=datetime.now(timezone.utc),
            size_bytes=size_bytes,
            metadata=metadata or {},
        )

        # Store in memory
        self._in_memory[key_hash] = entry

        # Store on disk
        cache_path = self._get_cache_path(key_hash)
        try:
            with open(cache_path, "wb") as f:
                pickle.dump(entry, f)
        except Exception as e:
            logger.warning(f"Cache write failed for {key_hash}: {e}")

        # Evict if needed
        self._evict_if_needed()

    def invalidate(self, key: CacheKey) -> bool:
        """
        Invalidate a cached entry.

        Args:
            key: Cache key

        Returns:
            True if entry was found and removed
        """
        key_hash = key.compute()

        removed = False

        if key_hash in self._in_memory:
            del self._in_memory[key_hash]
            removed = True

        cache_path = self._get_cache_path(key_hash)
        if cache_path.exists():
            cache_path.unlink()
            removed = True

        return removed

    def clear(self) -> None:
        """Clear all cached entries."""
        self._in_memory.clear()

        for cache_file in self.cache_dir.glob("*.cache"):
            try:
                cache_file.unlink()
            except Exception:
                pass

    def _get_cache_path(self, key_hash: str) -> Path:
        """Get path for cache file."""
        return self.cache_dir / f"{key_hash}.cache"

    def _evict_if_needed(self) -> None:
        """Evict entries if cache is too large."""
        total_size = sum(
            f.stat().st_size
            for f in self.cache_dir.glob("*.cache")
            if f.exists()
        )

        if total_size <= self.max_size_bytes:
            return

        # Get files sorted by modification time (oldest first)
        files = sorted(
            self.cache_dir.glob("*.cache"),
            key=lambda f: f.stat().st_mtime,
        )

        # Remove oldest files until under limit
        for cache_file in files:
            if total_size <= self.max_size_bytes:
                break

            file_size = cache_file.stat().st_size
            key_hash = cache_file.stem

            try:
                cache_file.unlink()
                total_size -= file_size

                if key_hash in self._in_memory:
                    del self._in_memory[key_hash]

                logger.debug(f"Evicted cache entry: {key_hash}")
            except Exception:
                pass


def compute_feature_cache_key(
    code: str,
    data_rev: str,
    symbol: str,
    timeframe: str,
    start_date: datetime,
    end_date: datetime,
    engine_version: str = "10.0.0",
    dependencies: dict[str, str] | None = None,
    parameters: dict[str, Any] | None = None,
) -> CacheKey:
    """
    Compute cache key for a feature.

    Args:
        code: Feature code (function source)
        data_rev: Data revision hash
        symbol: Symbol
        timeframe: Timeframe
        start_date: Start date
        end_date: End date
        engine_version: Engine version
        dependencies: Dependency hashes
        parameters: Feature parameters

    Returns:
        CacheKey
    """
    code_hash = hashlib.sha256(code.encode()).hexdigest()

    return CacheKey(
        code_hash=code_hash,
        data_rev=data_rev,
        symbol=symbol,
        timeframe=timeframe,
        start_date=start_date.isoformat(),
        end_date=end_date.isoformat(),
        engine_version=engine_version,
        dependency_hashes=dependencies or {},
        parameters=parameters or {},
    )


def cached_feature(
    cache: FeatureCache,
    data_rev: str,
    symbol: str,
    timeframe: str,
    start_date: datetime,
    end_date: datetime,
) -> Callable[[Callable[..., T]], Callable[..., T]]:
    """
    Decorator for caching feature computations.

    Usage:
        @cached_feature(cache, data_rev, "AAPL", "1d", start, end)
        def compute_sma(data, period=20):
            return data.rolling(period).mean()

    Args:
        cache: Feature cache
        data_rev: Data revision
        symbol: Symbol
        timeframe: Timeframe
        start_date: Start date
        end_date: End date

    Returns:
        Decorator function
    """
    import inspect

    def decorator(func: Callable[..., T]) -> Callable[..., T]:
        def wrapper(*args: Any, **kwargs: Any) -> T:
            # Get function source for code hash
            try:
                source = inspect.getsource(func)
            except OSError:
                source = func.__name__

            # Create cache key
            key = compute_feature_cache_key(
                code=source,
                data_rev=data_rev,
                symbol=symbol,
                timeframe=timeframe,
                start_date=start_date,
                end_date=end_date,
                parameters=kwargs,
            )

            # Check cache
            cached = cache.get(key)
            if cached is not None:
                logger.debug(f"Cache hit for {func.__name__}")
                return cached

            # Compute and cache
            result = func(*args, **kwargs)
            cache.set(key, result)
            logger.debug(f"Cached result for {func.__name__}")

            return result

        return wrapper

    return decorator

"""LRU cache for query results, keyed by (file_uri, mtime_ns, plan_hash).

Why this matters: the spike measured aggregations at ~200ms cold, ~0.05ms warm.
Interactive editing (filter slider, encoding swap) would be unusable without
caching — every spec change re-runs the daemon's full pipeline. With this
cache, only the first instance of a given (file, plan) pair pays the cold cost.

Invalidation:
  - File path changes (URI) -> different key.
  - File mtime changes -> different key (file was rewritten).
  - Plan changes (any byte of compiled SQL or params) -> different key.

We deliberately key on (path, mtime, plan_hash) NOT schema_hash. Schema is
stable across mtime changes for an unchanged-format file; mtime captures
content changes more cheaply than re-hashing the schema.

Eviction:
  - LRU on count (max_entries).
  - Total bytes cap (max_bytes) — large entries evict more aggressively.
  - Touch on read: most recent access goes to the back.

Concurrency: not threadsafe. The daemon is single-threaded (one query at a
time per workspace); add a lock if that ever changes.
"""

from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Generic, TypeVar


T = TypeVar("T")


@dataclass
class CacheEntry(Generic[T]):
    value: T
    bytes_estimate: int


class LRUCache(Generic[T]):
    """Bounded LRU with both count and byte caps."""

    def __init__(self, max_entries: int = 256, max_bytes: int = 256 * 1024 * 1024):
        if max_entries < 1:
            raise ValueError(f"max_entries must be >= 1: {max_entries}")
        if max_bytes < 1024:
            raise ValueError(f"max_bytes must be >= 1024: {max_bytes}")
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self._store: OrderedDict[str, CacheEntry[T]] = OrderedDict()
        self._total_bytes = 0
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> T | None:
        entry = self._store.get(key)
        if entry is None:
            self.misses += 1
            return None
        # Touch — move to end (most recently used).
        self._store.move_to_end(key)
        self.hits += 1
        return entry.value

    def put(self, key: str, value: T, bytes_estimate: int = 0) -> None:
        if key in self._store:
            old = self._store.pop(key)
            self._total_bytes -= old.bytes_estimate
        self._store[key] = CacheEntry(value=value, bytes_estimate=bytes_estimate)
        self._total_bytes += bytes_estimate
        self._evict_if_needed()

    def __contains__(self, key: str) -> bool:
        return key in self._store

    def __len__(self) -> int:
        return len(self._store)

    @property
    def total_bytes(self) -> int:
        return self._total_bytes

    def clear(self) -> None:
        self._store.clear()
        self._total_bytes = 0

    def stats(self) -> dict:
        total = self.hits + self.misses
        hit_rate = self.hits / total if total else 0.0
        return {
            "entries": len(self._store),
            "bytes": self._total_bytes,
            "hits": self.hits,
            "misses": self.misses,
            "hit_rate": hit_rate,
        }

    def _evict_if_needed(self) -> None:
        while len(self._store) > self.max_entries or self._total_bytes > self.max_bytes:
            if not self._store:
                break
            _, evicted = self._store.popitem(last=False)
            self._total_bytes -= evicted.bytes_estimate


# ---------------------------------------------------------------------------
# Key construction
# ---------------------------------------------------------------------------


def make_cache_key(*, file_path: str, mtime_ns: int, plan: dict | str) -> str:
    """Build a stable cache key for a (file, plan) pair.

    `plan` can be a dict (we'll JSON-serialize with sorted keys) or a string
    (already-canonical SQL or compiled-form).
    """
    if isinstance(plan, dict):
        plan_repr = json.dumps(plan, sort_keys=True, separators=(",", ":"))
    else:
        plan_repr = str(plan)
    h = hashlib.sha256()
    h.update(file_path.encode("utf-8"))
    h.update(b"|")
    h.update(str(mtime_ns).encode("utf-8"))
    h.update(b"|")
    h.update(plan_repr.encode("utf-8"))
    return h.hexdigest()

"""LRU cache for query results, keyed by (file_uri, mtime_ns, plan_hash).

Why this matters: the spike measured aggregations at ~200ms cold, ~0.05ms warm.
Interactive editing (filter slider, encoding swap) would be unusable without
caching — every spec change re-runs the daemon's full pipeline. With this
cache, only the first instance of a given (file, plan) pair pays the cold cost.

Invalidation:
  - File path changes (URI) -> different key.
  - File mtime changes -> different key (file was rewritten).
  - Plan changes (any byte of compiled SQL or params) -> different key.
  - Schema changes -> different key (audit finding #5: TOCTOU race).

The TOCTOU concern: a file can be rewritten with the SAME mtime (mtime
truncation, restore-from-backup, race in nanosecond resolution on slow FS,
or a malicious actor replacing the file). Keying only on mtime leaves a
window where a cached aggregate built against the old schema is returned
for the new file. Including schema_hash closes that window: any structural
change to the file invalidates the cache regardless of mtime.

For the schema cache itself the schema_hash IS the value, so we don't pass
it -- the key stays (path, mtime, "schema").

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
        # Megaudit M-8 defense-in-depth: bytes_estimate must be a sane
        # non-negative integer. A caller passing 0 (or a misreported
        # negative) for a 100MB blob would defeat the byte cap. Refuse
        # loudly so the caller's bug surfaces rather than silently
        # corrupting the cache accounting.
        # Megaudit-2 A4-M3: also reject `bool` explicitly. CPython
        # makes `bool` a subclass of `int`, so `isinstance(True, int)`
        # is True; passing `True`/`False` here is a caller bug (they
        # meant to compute a real byte count, never literally "is this
        # cacheable") and should fail loudly per CLAUDE.md "errors
        # must be visible".
        if isinstance(bytes_estimate, bool) or not isinstance(bytes_estimate, int) or bytes_estimate < 0:
            raise ValueError(
                f"bytes_estimate must be a non-negative int, got {bytes_estimate!r}",
            )
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


def make_cache_key(
    *,
    file_path: str,
    fingerprint: dict,
    plan: dict | str,
) -> str:
    """Build a stable cache key for a (file, plan) pair.

    `fingerprint` is a dict produced by `reader.file_fingerprint(...)`. It
    is hashed in canonical (sorted-keys) JSON form so any change to its
    contents -- mtime, size, ctime, schema -- invalidates the cache. This
    closes the TOCTOU race far more thoroughly than mtime alone.

    `plan` can be a dict (we'll JSON-serialize with sorted keys) or a string
    (already-canonical SQL or compiled-form).

    Both inputs are required. There is no "legacy mtime-only" path; the
    only callers in this codebase pass a fingerprint, so the API forces
    correctness.
    """
    if not isinstance(fingerprint, dict) or not fingerprint:
        raise ValueError("fingerprint must be a non-empty dict")
    if isinstance(plan, dict):
        plan_repr = json.dumps(plan, sort_keys=True, separators=(",", ":"))
    else:
        plan_repr = str(plan)
    fp_repr = json.dumps(fingerprint, sort_keys=True, separators=(",", ":"))
    h = hashlib.sha256()
    h.update(file_path.encode("utf-8"))
    h.update(b"|fp=")
    h.update(fp_repr.encode("utf-8"))
    h.update(b"|plan=")
    h.update(plan_repr.encode("utf-8"))
    return h.hexdigest()

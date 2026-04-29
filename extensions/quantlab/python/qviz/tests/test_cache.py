"""Tests for the LRU cache."""

from __future__ import annotations

import pytest

from qviz.cache import LRUCache, make_cache_key


def test_basic_put_get() -> None:
    c: LRUCache[str] = LRUCache(max_entries=10)
    c.put("k", "value", bytes_estimate=10)
    assert c.get("k") == "value"


def test_miss_returns_none() -> None:
    c: LRUCache[str] = LRUCache()
    assert c.get("missing") is None


def test_lru_eviction_by_count() -> None:
    c: LRUCache[int] = LRUCache(max_entries=3)
    for i in range(5):
        c.put(f"k{i}", i, bytes_estimate=1)
    assert len(c) == 3
    assert c.get("k0") is None
    assert c.get("k1") is None
    assert c.get("k2") == 2
    assert c.get("k3") == 3
    assert c.get("k4") == 4


def test_lru_eviction_by_bytes() -> None:
    # min max_bytes is 1024; use 3072 to fit 3 entries of 1024 bytes each.
    c: LRUCache[bytes] = LRUCache(max_entries=100, max_bytes=3072)
    c.put("k1", b"a" * 1024, bytes_estimate=1024)
    c.put("k2", b"b" * 1024, bytes_estimate=1024)
    c.put("k3", b"c" * 1024, bytes_estimate=1024)
    assert len(c) == 3
    # Adding a fourth pushes total to 4096, exceeds 3072 cap; oldest evicts.
    c.put("k4", b"d" * 1024, bytes_estimate=1024)
    assert len(c) == 3
    assert c.get("k1") is None  # oldest evicted


def test_get_promotes_to_most_recent() -> None:
    c: LRUCache[int] = LRUCache(max_entries=3)
    c.put("a", 1, 1); c.put("b", 2, 1); c.put("c", 3, 1)
    c.get("a")  # promotes a
    c.put("d", 4, 1)  # evicts b (now LRU after a's promotion)
    assert c.get("a") == 1
    assert c.get("b") is None
    assert c.get("c") == 3
    assert c.get("d") == 4


def test_put_overwrite_updates_bytes() -> None:
    c: LRUCache[int] = LRUCache()
    c.put("k", 1, bytes_estimate=100)
    assert c.total_bytes == 100
    c.put("k", 2, bytes_estimate=50)
    assert c.total_bytes == 50
    assert c.get("k") == 2


def test_clear() -> None:
    c: LRUCache[int] = LRUCache()
    c.put("a", 1, 10)
    c.clear()
    assert len(c) == 0
    assert c.total_bytes == 0
    assert c.get("a") is None


def test_stats_track_hits_misses() -> None:
    c: LRUCache[int] = LRUCache()
    c.put("a", 1, 1)
    c.get("a")  # hit
    c.get("a")  # hit
    c.get("b")  # miss
    s = c.stats()
    assert s["hits"] == 2
    assert s["misses"] == 1
    assert abs(s["hit_rate"] - 2 / 3) < 1e-9


def test_invalid_max_entries() -> None:
    with pytest.raises(ValueError):
        LRUCache(max_entries=0)


def test_invalid_max_bytes() -> None:
    with pytest.raises(ValueError):
        LRUCache(max_bytes=10)


# ---------- make_cache_key ----------


def test_cache_key_stable_for_same_inputs() -> None:
    k1 = make_cache_key(file_path="/data/x.parquet", mtime_ns=1, plan={"a": 1, "b": 2})
    k2 = make_cache_key(file_path="/data/x.parquet", mtime_ns=1, plan={"b": 2, "a": 1})
    assert k1 == k2  # dict ordering doesn't matter


def test_cache_key_changes_on_path() -> None:
    k1 = make_cache_key(file_path="/a.parquet", mtime_ns=1, plan={"x": 1})
    k2 = make_cache_key(file_path="/b.parquet", mtime_ns=1, plan={"x": 1})
    assert k1 != k2


def test_cache_key_changes_on_mtime() -> None:
    k1 = make_cache_key(file_path="/x.parquet", mtime_ns=1, plan={"x": 1})
    k2 = make_cache_key(file_path="/x.parquet", mtime_ns=2, plan={"x": 1})
    assert k1 != k2


def test_cache_key_changes_on_plan() -> None:
    k1 = make_cache_key(file_path="/x.parquet", mtime_ns=1, plan={"x": 1})
    k2 = make_cache_key(file_path="/x.parquet", mtime_ns=1, plan={"x": 2})
    assert k1 != k2


def test_cache_key_string_plan() -> None:
    k = make_cache_key(file_path="/x.parquet", mtime_ns=1, plan="SELECT 1")
    assert isinstance(k, str)
    assert len(k) == 64  # sha256 hex

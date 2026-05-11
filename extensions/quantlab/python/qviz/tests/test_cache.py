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


# Megaudit-2 A4-M3: bytes_estimate validation. The cache refuses
# negatives, non-int (incl. float), and -- per CPython's quirk that
# bool is a subclass of int -- the test for bool too, because passing
# `True` as bytes_estimate is a caller bug that previously crept past
# the `isinstance(x, int)` check (True is int(1)). The defense
# tightened in cache.py rejects `bool` explicitly.


def test_put_rejects_negative_bytes_estimate() -> None:
    c: LRUCache[str] = LRUCache()
    with pytest.raises(ValueError, match="non-negative"):
        c.put("k", "v", bytes_estimate=-1)


def test_put_rejects_float_bytes_estimate() -> None:
    c: LRUCache[str] = LRUCache()
    with pytest.raises(ValueError, match="non-negative int"):
        c.put("k", "v", bytes_estimate=1.5)  # type: ignore[arg-type]


def test_put_rejects_bool_bytes_estimate() -> None:
    # bool is technically int in Python; the cache should still refuse
    # it because `True`/`False` as a size estimate is always a bug.
    c: LRUCache[str] = LRUCache()
    with pytest.raises(ValueError, match="non-negative int"):
        c.put("k", "v", bytes_estimate=True)  # type: ignore[arg-type]


def test_put_rejects_none_bytes_estimate() -> None:
    c: LRUCache[str] = LRUCache()
    with pytest.raises(ValueError, match="non-negative int"):
        c.put("k", "v", bytes_estimate=None)  # type: ignore[arg-type]


def test_put_accepts_zero_bytes_estimate() -> None:
    # Zero is the documented default and must remain accepted -- a
    # legitimate use for cheap entries where the byte cap isn't the
    # limiting factor.
    c: LRUCache[str] = LRUCache()
    c.put("k", "v", bytes_estimate=0)
    assert c.get("k") == "v"


# ---------- make_cache_key ----------


def _fp(mtime_ns: int = 1, size: int = 100, ctime_ns: int = 1, schema_hash: str | None = None) -> dict:
    fp: dict = {"mtime_ns": mtime_ns, "size": size, "ctime_ns": ctime_ns}
    if schema_hash is not None:
        fp["schema_hash"] = schema_hash
    return fp


def test_cache_key_stable_for_same_inputs() -> None:
    k1 = make_cache_key(file_path="/data/x.parquet", fingerprint=_fp(), plan={"a": 1, "b": 2})
    k2 = make_cache_key(file_path="/data/x.parquet", fingerprint=_fp(), plan={"b": 2, "a": 1})
    assert k1 == k2  # plan dict ordering doesn't matter


def test_cache_key_changes_on_path() -> None:
    k1 = make_cache_key(file_path="/a.parquet", fingerprint=_fp(), plan={"x": 1})
    k2 = make_cache_key(file_path="/b.parquet", fingerprint=_fp(), plan={"x": 1})
    assert k1 != k2


def test_cache_key_changes_on_mtime() -> None:
    k1 = make_cache_key(file_path="/x.parquet", fingerprint=_fp(mtime_ns=1), plan={"x": 1})
    k2 = make_cache_key(file_path="/x.parquet", fingerprint=_fp(mtime_ns=2), plan={"x": 1})
    assert k1 != k2


def test_cache_key_changes_on_plan() -> None:
    k1 = make_cache_key(file_path="/x.parquet", fingerprint=_fp(), plan={"x": 1})
    k2 = make_cache_key(file_path="/x.parquet", fingerprint=_fp(), plan={"x": 2})
    assert k1 != k2


def test_cache_key_string_plan() -> None:
    k = make_cache_key(file_path="/x.parquet", fingerprint=_fp(), plan="SELECT 1")
    assert isinstance(k, str)
    assert len(k) == 64  # sha256 hex


def test_cache_key_changes_on_schema_hash() -> None:
    # Audit finding #5: TOCTOU. Same path/mtime/plan/size/ctime but different
    # schemas MUST produce different cache keys.
    base = dict(file_path="/x.parquet", plan={"sql": "SELECT * FROM t"})
    k0 = make_cache_key(**base, fingerprint=_fp())  # no schema_hash
    k1 = make_cache_key(**base, fingerprint=_fp(schema_hash="sha256:" + "a" * 64))
    k2 = make_cache_key(**base, fingerprint=_fp(schema_hash="sha256:" + "b" * 64))
    assert k0 != k1, "key without schema_hash differs from one with"
    assert k1 != k2, "different schemas yield different cache keys"


def test_cache_key_stable_with_same_schema_hash() -> None:
    base = dict(file_path="/x.parquet", plan={"sql": "SELECT 1"})
    sh = "sha256:" + "a" * 64
    fp = _fp(schema_hash=sh)
    assert make_cache_key(**base, fingerprint=fp) == make_cache_key(**base, fingerprint=fp)


def test_cache_key_changes_on_size() -> None:
    # Audit finding (Codex): same mtime + same schema + DIFFERENT size
    # (file overwrite preserves mtime via touch -t but contents differ
    # in length) MUST invalidate the cache.
    base = dict(file_path="/x.parquet", plan={"sql": "SELECT 1"})
    k_a = make_cache_key(**base, fingerprint=_fp(size=100))
    k_b = make_cache_key(**base, fingerprint=_fp(size=200))
    assert k_a != k_b, "different file sizes yield different cache keys"


def test_cache_key_changes_on_ctime() -> None:
    # Audit finding (Codex): rename-replace updates ctime even if mtime
    # is preserved (mv/install/atomic-replace patterns). MUST invalidate.
    base = dict(file_path="/x.parquet", plan={"sql": "SELECT 1"})
    k_a = make_cache_key(**base, fingerprint=_fp(ctime_ns=1000))
    k_b = make_cache_key(**base, fingerprint=_fp(ctime_ns=2000))
    assert k_a != k_b, "different ctimes yield different cache keys"


def test_cache_key_rejects_empty_fingerprint() -> None:
    with pytest.raises(ValueError):
        make_cache_key(file_path="/x.parquet", fingerprint={}, plan={"x": 1})

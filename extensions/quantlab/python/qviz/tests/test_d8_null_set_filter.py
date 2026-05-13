"""Megaudit D8 (2026-05-13): pin the daemon-side
`_compile_inspector_filters_to_sql` behavior for `null` in IN values.

The set-filter widget passes `null` directly through the wire
(matching ColumnStats.distinct's JSON shape). The daemon must split
None out of the IN clause and emit `IS NULL OR col IN (...)`, NOT
`col IN (NULL, ...)` (the latter would silently exclude NULL rows
under DuckDB's trivalent logic).

A second test exercises `op_preview` on a real parquet to confirm
the SQL change actually returns the right rows end-to-end.
"""

from __future__ import annotations

from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest


def _schema() -> pa.Schema:
    return pa.schema([
        pa.field("label", pa.string(), nullable=True),
        pa.field("n", pa.int64(), nullable=True),
    ])


def test_d8_in_with_null_emits_is_null_or_in() -> None:
    from qviz.daemon import _compile_inspector_filters_to_sql
    sql, params = _compile_inspector_filters_to_sql([{
        "kind": "filter", "column": "label", "op": "in",
        "value": [None, "a", "b"],
    }], _schema())
    assert '"label" IS NULL' in sql, sql
    assert '"label" IN (?,?)' in sql, sql
    assert " OR " in sql, sql
    assert params == ["a", "b"]


def test_d8_in_only_null_collapses_to_is_null() -> None:
    from qviz.daemon import _compile_inspector_filters_to_sql
    sql, params = _compile_inspector_filters_to_sql([{
        "kind": "filter", "column": "label", "op": "in", "value": [None],
    }], _schema())
    assert '"label" IS NULL' in sql, sql
    assert "IN (" not in sql, sql
    assert params == []


def test_d8_not_in_with_null_emits_is_not_null() -> None:
    from qviz.daemon import _compile_inspector_filters_to_sql
    sql, params = _compile_inspector_filters_to_sql([{
        "kind": "filter", "column": "label", "op": "not_in",
        "value": [None, "a"],
    }], _schema())
    assert '"label" IS NOT NULL' in sql, sql
    assert '"label" NOT IN (?)' in sql, sql
    assert " AND " in sql, sql
    assert params == ["a"]


def test_d8_in_no_null_unchanged() -> None:
    """Regression pin: when no None is in the value list, the SQL
    shape must be unchanged from pre-D8."""
    from qviz.daemon import _compile_inspector_filters_to_sql
    sql, params = _compile_inspector_filters_to_sql([{
        "kind": "filter", "column": "label", "op": "in",
        "value": ["a", "b", "c"],
    }], _schema())
    assert "IS NULL" not in sql, sql
    assert '"label" IN (?,?,?)' in sql, sql
    assert params == ["a", "b", "c"]


def test_d8_trivalent_semantics_not_in_without_null_excludes_null_rows(
    tmp_path: Path,
) -> None:
    """Codex D8 audit (2026-05-13): pin the SQL/Excel-style trivalent
    behaviour. `not_in ["a"]` excludes BOTH the "a" rows AND the NULL
    rows — NULL is "unknown", not "different from 'a'". This is NOT
    boolean complement (which would include NULL rows). Document via
    a pinning test so a future refactor that drifts toward complement
    breaks here."""
    from qviz.daemon import Daemon
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    p = data_dir / "mixed.parquet"
    table = pa.table({"label": pa.array(["a", "b", None, "a", None, "c"])})
    pq.write_table(table, str(p))

    d = Daemon(tmp_path)
    resp, _ = d.handle({
        "op": "preview", "id": 1,
        "path": "data/mixed.parquet", "n": 100, "offset": 0,
        "inspector_filters": [{
            "kind": "filter", "column": "label", "op": "not_in",
            "value": ["a"],
        }],
    })
    assert resp["ok"] is True, resp
    rows = resp["data"]["rows"]
    labels = [r["label"] for r in rows]
    # Only "b" and "c" — NULLs are excluded (trivalent), and "a" is excluded.
    assert sorted(x for x in labels if x is not None) == ["b", "c"], labels
    assert None not in labels, (
        "trivalent semantics: not_in ['a'] must NOT include NULL rows; "
        "they pass through as UNKNOWN under SQL trivalent logic"
    )


def test_d8_trivalent_semantics_not_in_with_null_excludes_both(
    tmp_path: Path,
) -> None:
    """`not_in [None, 'a']` is the user's "uncheck both null and 'a'"
    intent. SQL: `col IS NOT NULL AND col NOT IN ('a')` → excludes
    both NULL and 'a' rows. Pin so the comment-as-spec doesn't drift."""
    from qviz.daemon import Daemon
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    p = data_dir / "mixed.parquet"
    table = pa.table({"label": pa.array(["a", "b", None, "c"])})
    pq.write_table(table, str(p))

    d = Daemon(tmp_path)
    resp, _ = d.handle({
        "op": "preview", "id": 1,
        "path": "data/mixed.parquet", "n": 100, "offset": 0,
        "inspector_filters": [{
            "kind": "filter", "column": "label", "op": "not_in",
            "value": [None, "a"],
        }],
    })
    assert resp["ok"] is True, resp
    labels = [r["label"] for r in resp["data"]["rows"]]
    assert sorted(labels) == ["b", "c"], labels


def test_d8_column_stats_includes_null_in_distinct(tmp_path: Path) -> None:
    """Megaudit D8 opus audit: when a column has NULL rows, the
    column-stats `distinct` list must surface `null` at the head so
    the set-filter widget can render a `(null)` checkbox. Without
    this, D8's SQL-NULL handling is dead UI code."""
    from qviz.daemon import Daemon
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    p = data_dir / "mixed.parquet"
    table = pa.table({
        "label": pa.array(["a", "b", None, "a", None]),
    })
    pq.write_table(table, str(p))
    d = Daemon(tmp_path)
    resp, _ = d.handle({
        "op": "column_stats",
        "id": 1,
        "path": "data/mixed.parquet",
        "column": "label",
    })
    assert resp["ok"] is True, resp
    distinct = resp["data"]["distinct"]
    # NULL is surfaced at the head; non-null values follow.
    assert distinct[0] is None, distinct
    assert set(distinct[1:]) == {"a", "b"}, distinct
    # Cardinality counts null as a distinct value.
    assert resp["data"]["cardinality"] == 3, resp["data"]
    assert resp["data"]["null_count"] == 2, resp["data"]


def test_d8_column_stats_no_nulls_omits_null_from_distinct(tmp_path: Path) -> None:
    """Regression pin: when null_count == 0, the distinct list must
    NOT carry a sentinel null entry."""
    from qviz.daemon import Daemon
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    p = data_dir / "clean.parquet"
    table = pa.table({"label": pa.array(["a", "b", "c", "a"])})
    pq.write_table(table, str(p))
    d = Daemon(tmp_path)
    resp, _ = d.handle({
        "op": "column_stats",
        "id": 1,
        "path": "data/clean.parquet",
        "column": "label",
    })
    assert resp["ok"] is True, resp
    distinct = resp["data"]["distinct"]
    assert None not in distinct, distinct
    assert sorted(distinct) == ["a", "b", "c"], distinct
    assert resp["data"]["cardinality"] == 3, resp["data"]


def test_d8_end_to_end_via_daemon_preview(tmp_path: Path) -> None:
    """Bug-witness end-to-end: a real parquet with mixed SQL-NULL and
    literal-string-`"null"` rows, filtered by `[None]`, returns ONLY
    the SQL-NULL rows."""
    from qviz.daemon import Daemon
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True)
    p = data_dir / "mixed.parquet"
    table = pa.table({
        "label": pa.array(["a", "null", "b", None, "null", None]),
        "n": pa.array([1, 2, 3, 4, 5, 6], type=pa.int64()),
    })
    pq.write_table(table, str(p))

    d = Daemon(tmp_path)
    resp, _ = d.handle({
        "op": "preview",
        "id": 1,
        "path": "data/mixed.parquet",
        "n": 100, "offset": 0,
        "inspector_filters": [{
            "kind": "filter", "column": "label", "op": "in", "value": [None],
        }],
    })
    assert resp["ok"] is True, resp
    rows = resp["data"]["rows"]
    # ONLY None rows. Literal string "null" must NOT appear.
    assert all(r["label"] is None for r in rows), rows
    assert len(rows) == 2, rows

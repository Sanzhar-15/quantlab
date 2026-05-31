# 6.2-1b Audit -- SYNTHESIS

Phase 6.2-1b (`ql-service` cluster C structure/sheets + cluster D tables -- 10
EngineSession methods bound over HTTP). Parallel 2-lane audit on the uncommitted
working tree: **Codex** (read-only, `model_reasoning_effort=high`, default model) +
**fresh Opus** (general-purpose).

## Verdicts

- **Codex -> SHIP-WITH-FIXES** -- 0 HIGH, 0 MED, 2 LOW (both test-observability). (`.codex-6-2-1b-audit.out` at repo root.)
- **Opus -> SHIP** -- 0 findings at any severity.

Both lanes verified at source: `TableSpecWire` mirrors napi `TableSpecJson` field-for-field
(camelCase, sheet u16, top_row/top_col/rows/cols u32, `columnNames` REQUIRED -> omission is a
loud deserialize error matching napi); every handler calls the correct trait method with the
correct arg order (`resize_table(name, new_rows, new_cols, added, removed)`,
`rename_column(table, old, new)`, `move_sheet(id, new_index)`, ...) under `with_session`
(panic boundary + session-not-found preserved); pure transport (zero rows/cols and inverted
ranges reach the engine un-prechecked -> engine `table_create_rejected` / normalization);
error-code/status mapping correct end-to-end. ql-exec **802/0** unchanged.

## LOW findings + resolution (both from Codex; Opus found none)

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | LOW | `TableSpecWire` mapping unit test used mostly-zero coordinates -> a broken mapper swapping/dropping `sheet`/`topRow`/`topCol` could pass. | **FIXED** (`wire.rs`): the unit test now uses DISTINCT nonzero coords (sheet 2, topRow 5, topCol 7, rows 3, cols 2) and asserts ALL 9 mapped fields -- a swap/drop now fails it. |
| 2 | LOW | Two negative-path tests asserted only HTTP 400, not the stable problem `code` (weaker against wrong-reason regressions). | **FIXED** (`cluster_c_d_http.rs`): the out-of-range `move-sheet` and the missing-`columnNames` `create-table` negatives now also assert `code == "bad_argument"`. |

No HIGH/MED behavioral or contract defect in the service implementation from either lane.

## Post-fold verification (Mac host)

- `cargo test -p ql-service` -> **18/18** (13 wire unit + 2 cluster_a_b + 2 cluster_c_d + 1 golden_flow_http).
- `cargo clippy -p ql-service --all-targets` -> **0** (no ql-service warnings).
- `cargo build -p ql-service` debug + release -> **0/0**.
- `cargo test -p ql-exec` default + `--features xlsx-write` -> **802/0 unchanged** (pure-transport invariant).
- `cargo build --workspace` -> clean.

**Outcome: SHIP.** No HIGH/MED from either lane; both LOW test-observability fixes folded.
6.2-1 clusters A-D are now bound over the service; 6.2-1c (E atomic/txn + reserved bulk +
undo/delta + functions) remains.

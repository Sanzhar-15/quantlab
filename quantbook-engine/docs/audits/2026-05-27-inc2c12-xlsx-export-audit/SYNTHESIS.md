# inc.2c-12 audit synthesis — `export("xlsx")` + xlsx-writer feature-gate

**Date:** 2026-05-27 · **Increment:** Phase 6.1B inc.2c-12 · **Branch:** `feat/quantbook-engine`
**Reviewers:** Codex (gpt-5.5, reasoning xhigh, read-only sandbox) + Opus (fresh-context sub-agent).
**Verdict:** **CLEAN — ship it.** No HIGH / MEDIUM / LOW from either reviewer. Both verified every
load-bearing claim at source (including the umya `write_writer` ≡ `write` byte-equivalence in the
registry source, and the feature graph via read-only `cargo tree`).

## What shipped
- `WorkbookSession::export("xlsx")` — whole-workbook xlsx export returning `Vec<u8>`, real behind the
  `ql-exec` `xlsx-write` feature; without it, honest `Capability/not_implemented_in_v1_core`.
- In-memory writer: umya 2.2.0 exposes `writer::xlsx::write_writer<W: io::Write>`, so a new
  `export_xlsx_bytes` serializes straight to a `Vec<u8>` (no tempfile). The path exporter
  (`export_xlsx_path`/`export_new_workbook`) now delegates to a shared bytes core
  (`export_new_workbook_to_bytes`) + one `atomic_write_to_path`; `post_process_zip` became the
  bytes-in/bytes-out `post_process_bytes`.
- Feature-gate: ql-io-xlsx `umya-spreadsheet` is `optional`; `default = ["write"]`,
  `write = ["dep:umya-spreadsheet"]`. ql-exec depends `default-features = false` (reader only) +
  `xlsx-write = ["ql-io-xlsx/write"]`; a `[dev-dependencies]` re-enables `write` so the test fixture
  (`import_xlsx_round_trip_loads_cells_and_recomputes`, which uses `export_xlsx_path`) compiles.

## Verification (all green, re-confirmed by the reviewers)
| Config | Result |
|---|---|
| `cargo build/test -p ql-exec --lib` (default) | **729/0**; umya **absent** from the normal dep tree (`cargo tree -i umya-spreadsheet` → "nothing to print") |
| `cargo test -p ql-exec --lib --features xlsx-write` | **729/0**; umya **present** in the tree; session xlsx round-trip test passes |
| `cargo test -p ql-io-xlsx` (default = write on) | **60 lib + 49 calamine_smoke / 0 failed** (rest pre-`#[ignore]`d corpus) |
| `cargo build --workspace` | ok |
| `cargo build -p ql-io-xlsx --no-default-features` | ok (reader only) |
| clippy ql-io-xlsx {default, --no-default-features} | clean |
| clippy ql-exec --all-targets {default, --features xlsx-write} | clean (after fixing a `single_element_loop` introduced when the deferred-methods test array shrank to one element) |

## Findings (both reviewers)
**HIGH / MEDIUM / LOW: none.** INFO items (all confirm correctness or are pre-existing):
1. **Byte-equivalence** — `write_writer` and path `write` both go through `make_buffer(spreadsheet, false)`
   (umya `writer/xlsx.rs:184-190, 221-234`), so the path export's bytes are identical to before; the
   post-process body is unchanged except its read/write endpoints. The W5-D-PM-4 atomic write-then-rename
   is preserved (now done by the path caller). Strict file-removal contract in `export_xlsx_path`
   untouched.
2. **Feature plumbing** — correctly scoped; workspace `resolver = "2"` ensures the dev-dep `write` does
   NOT leak into ql-exec's normal lib build; ql-exec is the *only* ql-io-xlsx dependent.
3. **cfg arm** — exactly one block survives cfg-stripping as the arm's `EngineResult<Vec<u8>>` tail;
   `export_xlsx_bytes`/`XlsxExportOptions` referenced only feature-on; `map_xlsx_err` stays used by
   `import` regardless → no dead-code/unused.
4. **No-Fallbacks** — feature-off is a loud Capability error; `export_xlsx_bytes` rejects `UpdateOriginal`
   loudly (no silent NewWorkbook downgrade); the discarded export report is the documented `&self`
   no-warning-channel limitation (csv export likewise surfaces no fidelity report). No swallowed errors
   introduced.
5. **Error mapping** — all current `XlsxError` variants mapped (Appendix A), foreign `#[non_exhaustive]`
   future variant → loud `unmapped_xlsx_error`.
6. **Dead code** — `post_process_zip` fully removed (no callers); `atomic_write_to_path` still used.

### Applied post-audit
- Tightened the `export("xlsx")` doc comment in `session.rs` (the "consistent across serializers"
  phrasing → explicit "csv export likewise surfaces no export-fidelity report") per both reviewers' INFO.

### Tracked (NOT this increment — pre-existing / cross-cutting)
- Opus INFO: `post_process_bytes` emits fresh sheet-rels in `HashMap` iteration order (pre-existing,
  affects only multi-table/multi-sheet workbooks lacking pre-existing rels). Folds into the existing
  cross-cutting serializer follow-up; out of scope here.
- The storage-level effective-non-blank-value extent API (csv/xlsx/.qbook all iterate the conservative
  `Sheet::bounds`) remains tracked cross-cutting.

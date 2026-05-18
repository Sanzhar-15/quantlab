---
audit: Tier D1 — WorkbookRuntime monolith split (consolidated)
auditors: Codex + Opus subagent (parallel 2-way pass)
date: 2026-05-18
commit_range: 2e8566e35f0..118b4be1611 (10 commits)
closures_landed_at: <head-after-this-commit>
companion_docs:
  - docs/audits/2026-05-18-tier-d1-codex.md
  - docs/audits/2026-05-18-tier-d1-opus.md
---

# Tier D1 audit — consolidated findings + closure summary

Parallel 2-way audit on the full D1 commit chain (`2e8566e35f0`
design through `118b4be1611` Step 4). Codex ran on host; Opus
subagent ran in read-only Explore mode.

## Verdict

- **Codex**: 2 MEDIUM + 5 LOW findings.
- **Opus**: 0 findings (clean).

Codex caught what Opus missed in the doc-attachment / mod.rs-size /
visibility-tightening / test-partitioning dimensions. Closed
2 MEDIUMs + 1 LOW (visibility) in the closure commit; deferred 4
LOWs (test partitioning polish) to v2 backlog.

## Closed in this commit

### Codex M-1 — `recompute_all` doc misattached to `validate_formula`

File: `crates/ql-exec/src/workbook_runtime/validate.rs:50` (pre-fix).

The Step 3.8 move pulled the doc-comment block for
`recompute_all` (Phase 2B.2 RecomputeResult contract,
~22 lines) along with `validate_formula` because the original
mod.rs had a hanging doc adjacency: `recompute_all`'s doc block
sat right above `validate_formula`'s doc block, separated only
by a blank line. Rust attaches both blocks to the next
function. After Step 3.6 moved `recompute_all` to `recompute.rs`
without taking its doc, the `recompute_all` doc was orphaned at
mod.rs and got carried into `validate.rs` with `validate_formula`.

**Closure:** moved the `recompute_all` doc block from
`validate.rs::validate_formula` to `recompute.rs::recompute_all`.
Pre-fix the doc was 22 lines explaining HashMap-order eval +
Phase 2B.2 signature change + cell-success semantics — all
relevant to recompute_all, none relevant to validate_formula.

### Codex M-2 — mod.rs misses ≤ 250 LOC acceptance target

File: `crates/ql-exec/src/workbook_runtime/mod.rs` (pre-fix 299
LOC, target ≤ 250 per the design doc).

The extraction-history block (lines 53-91 pre-fix, 45 lines of
"Step N (date, commit): ..." entries) plus 3 stale tail-of-file
marker comments accounted for the overshoot. Acceptance target
was set in the design doc; mod.rs body itself was already
minimal (struct + 4 constructors + cache_stats + 2 validate
helpers).

**Closure:** trimmed the per-step history block from 45 lines
to 6 lines (pointer to `docs/PHASE-4-V2-BACKLOG.md` § D1 for
the full commit-hash chain + pointer to design doc); removed
the 3 stale tail marker comments. Post-fix: 247 LOC, **under
the 250 target**.

### Codex L-1 — `validate_sheet` visibility too loose

File: `crates/ql-exec/src/workbook_runtime/mod.rs:107` (pre-fix
`pub(crate)`).

The comment claimed `WorkbookTransaction` needed it, but a
grep across the codebase shows `transaction.rs` imports
`validate_cell` (which internally calls `validate_sheet`), not
`validate_sheet` directly. No other external caller exists.

**Closure:** tightened to private (`fn validate_sheet`). Inline
doc updated to explain the audit-driven tightening.

## Deferred to v2 backlog (test partitioning polish)

Codex L-2 through L-5 are test-misplacement nits that don't
affect correctness, semantics, or gates. Bundling them into a
single backlog entry rather than closing piecemeal:

- **L-2**: `add_sheet_rejects_zero_chunk_rows`,
  `add_sheet_rejects_invalid_chunk_rows`, etc. in
  `validate.rs:163` should move to `sheets.rs::tests`.
- **L-3**: `clear_formula_rejects_invalid_sheet`,
  `clear_formula_rejects_invalid_cell` in `validate.rs:187`
  should move to `cells.rs::tests`.
- **L-4**: W5-147 `set_formula` canonicalization tests in
  `tables.rs:2122` should move to `cells.rs::tests`;
  `set_reference_mode_op_round_trips_through_replay` in
  `tables.rs:2182` should move to `config.rs::tests`.
- **L-5**: pure table API tests
  (`drop_table_removes_metadata...`, `drop_table_missing_errors`)
  in `cells.rs:4388` should move to `tables.rs::tests`.

**Rationale for deferring**: all 4 are mechanical test-cluster
moves with no behavioral impact. The bundling came from how the
extraction was chunked (e.g., Phase 2B.7 cluster contained tests
of multiple methods that all happened to be in the same banner
block). Re-partitioning is appropriate polish but not blocking.

Added as a new entry in `docs/PHASE-4-V2-BACKLOG.md` as **D1.a
test-cluster re-partitioning**.

## OK items (both auditors agree)

- Sibling impl-block pattern correctly applied across 9
  submodules.
- Private-field access across siblings is idiomatic.
- `write_spill` is the only method that needed `pub(super)`
  elevation (and it got it in Step 3.7).
- All 6 `make_runtime_workbook` copies are byte-identical.
- Doc-comment misattachments from Step 3.2 (rename_table) and
  Step 3.3 (validate_cell) were correctly fixed at the time.
- `pub use error::{...}` re-exports preserve external-caller
  compatibility.
- 4141 / 4141 tests passing across every D1 commit; zero
  drift.
- No TODO/FIXME/HACK comments left behind.

## Test count

- 4141 tests across all 10 D1 commits.
- After audit closures (this commit): still 4141 (closures are
  pure doc/visibility/comment changes; no test additions).

## Final state

- HEAD: post-closure commit.
- `mod.rs`: 247 LOC (target: ≤ 250 ✅).
- 9 sibling submodules; total post-split LOC: ~13,229 (up 504
  from pre-split 12,725, all overhead from module docs + impl
  block wrappers).
- All gates clean: `cargo fmt`, `cargo clippy --workspace
  --all-targets -D warnings`, `cargo test --workspace`, `cargo
  doc`.

## Audit-discipline meta-note

The 2-way pattern (Codex + Opus) caught what either alone would
have missed. Opus's verdict was "everything looks fine" — clean
across all 8 dimensions it examined. Codex caught the doc
misattachment (M-1), the mod.rs overshoot (M-2), the visibility
nit (L-1), and 4 test-partitioning polish items (L-2..L-5).
This is the discipline rule's value: independent passes find
different classes of issue. The single-Opus verdict alone would
have shipped D1 with the recompute_all doc orphaned, the mod.rs
LOC target missed, and `validate_sheet` overly permissive.

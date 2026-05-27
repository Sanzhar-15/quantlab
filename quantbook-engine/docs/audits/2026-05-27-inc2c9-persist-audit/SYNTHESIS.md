# inc.2c-9 persistence (`open`/`save`) — parallel Codex + Opus audit synthesis (2026-05-27)

**Scope:** the `WorkbookSession` persistence increment — `open`/`save` (Option 1) +
`map_persistence_err` + `ensure_openable` + tests, in `crates/ql-exec/src/session.rs`.
`import`/`export` remain honest `not_implemented_in_v1_core` (a follow-up).

**Method:** parallel **Codex (gpt-5.5, reasoning xhigh, read-only)** + a fresh-context **Opus** source
reviewer. Every finding re-verified at source by the orchestrator before action.

## Findings + dispositions

| # | Sev | Source | Finding | Disposition |
|---|-----|--------|---------|-------------|
| 1 | **HIGH** | Codex | `open` loaded the sidecar op-log via `load_workbook_with_oplog` (which validates only the Loro snapshot **framing**) and discarded it **without iterating** — but per-op JSON is deserialized lazily by `OpLog::iter()` (`ql-oplog/src/log.rs:112`). A frame-valid but **payload-corrupt** sidecar (e.g. a pre-Tier-D3 op shape, pinned by `ql-oplog/tests/d1_step8_legacy_op_shape.rs`) was therefore silently accepted, then masked by the next `save`'s overwrite — contradicting this increment's own "corrupt `oplog.bin` fails loud on open" promise (No-Fallbacks). | **FIXED.** Verified the lazy-`iter()` + framing-only claims at source. Added an explicit validation loop in `open` (`for op in discarded_oplog.iter() { op.map_err(|e| map_persistence_err(PersistenceError::OpLog(e)))?; }`) BEFORE `*self = ...` (atomicity preserved). Kept local to `open` (moving it into `ql_io` would change other callers' contracts — out of scope). + regression test `open_with_corrupt_oplog_sidecar_fails_loud_persistence`. |
| 2 | LOW | Codex | Module doc (top of `session.rs`) still listed persistence + undo/redo among deferred `Capability` methods. | **FIXED.** Updated the module doc: undo/redo (inc.2c-7) + `.qbook` open/save (inc.2c-9) are REAL; only `import`/`export` + functions + bulk remain deferred. |
| 3 | LOW | Opus | No test pins `can_undo()` false immediately after `open` (the design rests on the fresh `UndoManager` + detached recompute appending nothing undoable). | **FIXED.** Added `can_undo_false_immediately_after_open` (asserts content present, `!can_undo()`, undo is a no-op — cannot cross the open point). |
| 4 | LOW | Opus | No test covers save→open→re-save→open stability (the documented Option-1 history reset must not cost document state). | **FIXED.** Added `save_open_resave_open_stable`. |
| 5 | INFO | both | `save("/tmp/.")` derives name `"tmp"`; `.qbook` derives `.qbook` — surprising but non-empty (only `..`/`/`/`.` yield `None` → loud `BadArgument`). Not a silent-fallback. | **No code change.** Acknowledged; `save_path_without_stem_fails_bad_argument` covers the `None` path. |
| 6 | INFO | both | Appendix A listed loose variant names `{Qbook,Oplog,UnsupportedVersion,TruncatedHeader}` (impl matches the real enum exactly); `open`'s Ready-re-open semantic was only implied. | **FIXED (docs).** Appendix A now uses the exact `ql_io::PersistenceError` variant names + the `unmapped_persistence_error` catch-all row; §3.1 documents the Ready-re-open + Option-1 semantics. |

## Verifications that passed (cited at source by both reviewers)
1. **open-failure atomicity** — the `?` on the load returns before `*self = ...`; a failed open leaves the
   session `Ready` + usable (`open_nonexistent_path_fails_loud_persistence`).
2. **post-open undo invariant** — `recompute_all` writes computed values into `self.workbook` but not
   `baseline`; `rematerialize` clones `baseline`, replays, then `recompute_all` again, so stale computed
   values in `baseline` are harmless. Worst case open→set_value→undo loses/corrupts nothing. The invariant
   is over user-values + formula-text; the computed overlay is always re-derived.
3. **recompute op-log isolation** — `with_runtime_no_oplog` appends no ops; `from_workbook` builds a fresh
   `OpLog` + an `UndoManager` subscribed to it, so `can_undo()` is false right after open.
4. **registry ordering** — preserved-`Arc` restored before the recompute runs.
5. **map_persistence_err** — all 4 real variants → the Appendix-A codes; foreign `#[non_exhaustive]`
   wildcard → loud `Internal`/`unmapped_persistence_error` (no generic caller-visible code).
6. **lifecycle gating** — `ensure_openable` allows `New|Ready`, rejects `Busy`/terminal; `save` uses
   `ensure_readable`; a pre-open delta token is invalidated via the epoch re-mint.

## Verdict
Opus: **SHIP** (the 2 LOW were test additions, not correctness defects). Codex: 1 HIGH + 1 LOW.
After fixes: **ql-exec lib 719/0 + e2e 21/0, clippy clean, workspace build green.** Shipped.

Raw transcripts: `.codex-6-1b-inc2c9-persist-audit.out` (Codex) + the Opus reviewer's returned report
(captured in the session log).

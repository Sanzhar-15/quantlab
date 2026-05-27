# Phase 6.1B inc.2d — `WorkbookSession` over napi: audit synthesis

**Date:** 2026-05-28. **Scope:** the new `Session` napi class in `crates/ql-bindings-node/src/lib.rs`
(wrapping `ql_exec::WorkbookSession`) + the `ql-exec`/`ql-session` deps + the engine-repo cdylib smoke
(`tests/smoke_session.mjs`). The engine-side half of the 6.1B Node smoke-path migration
(decision-lock §2 item 3 / risk-mitigation #1). Existing `CollabSession` façade untouched.

**Method:** parallel **Codex** (gpt-5.5 xhigh, `codex exec -s read-only`) + an independent **Opus** agent,
each reviewing the additive FFI surface against the `ql-session` contract + the `ql-exec` impl + the proven
`CollabSession` patterns. Both verdicts: **SHIP** (no HIGH, no MEDIUM). Every finding verified at source.

## Verification gate (all green)
- `cargo build -p ql-bindings-node` ✅ — the `const _ASSERT_BINDING_SESSION_SEND` compile-proof PASSES,
  so `WorkbookSession: Send` is *proven* (not claimed) → `Arc<Mutex<WorkbookSession>>` is `Send + Sync`.
  **No contract finding** — the owning session is FFI-shareable as-is.
- `cargo check --workspace` ✅; `cargo check -p ql-bindings-node --features test-fixtures` ✅.
- Live FFI smoke (`node tests/smoke_session.mjs`, plain Node `process.dlopen`) ✅ — drives
  `new → addSheet → setValue(A1,10) → setFormula(B1,"A1+1") → recalcDirty → cell/snapshot` = 11, plus
  clear-preserves-value, setValue(blank)-clears, and unknown-kind → `[bad_argument]`.
- inc.2d code is **clippy-clean** (verified by capping the 4 pre-existing deny-errors to warn and
  confirming zero lints reference the new block).

## Findings & dispositions

| # | Lane | Sev | Finding | Disposition |
|---|------|-----|---------|-------------|
| 1 | Codex + Opus | LOW | `Session::clear` docstring said "Clear a cell (value + formula)" but `clear`→`clear_formula` = convert-to-literal (value PRESERVED, formula removed). | **FIXED** — docstring now states convert-to-literal + points to `setValue(blank)` + flags the "delete contents" 6.1C decision (`lib.rs` `clear`). |
| 2 | Codex | LOW | `Session.snapshot().formats` order is non-deterministic: `WorkbookSession::snapshot` builds it from `FormatTable::iter()` (arbitrary), while `WorkbookSnapshotJson` docs promise sorted `FormatId` order. | **DEFER → 6.1C.** Pre-existing **engine-session** gap (root cause in `ql-exec/src/session.rs` `snapshot`, affects ALL bindings — not a binding-layer band-aid). No live consumer of `Session.snapshot` yet (IDE still uses the CollabSession path, which sorts). Tracked. |
| 3 | Codex | INFO | `WorkbookSnapshotJson` omits `ql_session::WorkbookSnapshot.schema_version`. | **DEFER → 6.3.** Pre-existing DTO (the CollabSession producer also omits it); a contract-versioning concern for full bindings. |
| 4 | Codex + Opus | INFO | No `catch_unwind`; under `panic = "abort"` an engine invariant panic (e.g. a `recalc` kernel assert) aborts the process rather than becoming a JS error. `FaultGuard` only marks `Faulted` on unwind. | **DOCUMENT.** Engine-wide known property, **identical** to the existing `CollabSession` surface (no regression). Panic-boundary hardening (napi `catch_unwind` or `panic=unwind`+FaultGuard) is future work. |
| 5 | Opus | INFO | `recalcDirty`/`recalcAll` return an op-id, but `Session` exposes no `operationStatus`/`cancel` yet. | **By design** (6.3 scope, per the class docstring). Returned id is informational on the JS side for now. |
| 6 | Codex + Opus | INFO | Contract observations to carry into 6.1C: (a) `setFormula` text = body **without** leading `=` (matches `appendPutFormula`); (b) `clear` = convert-to-literal; (c) no single "delete cell contents" (value+formula) command; (d) `addSheet` returns `SheetId` (collab `addSheet` returns `()`). | **FLAG → 6.1C.** Documented in the handoff. |

## Confirmed-correct (both lanes, verified at source)
- All index args are `f64` + `validate_u16_index`/`validate_u32_index` (no JS `ToUint32` silent coercion).
- `engine_error_to_napi` = `Error::from_reason(e.to_string())`; `EngineError::Display = "[code] message"`
  → `code` recoverable from the bracket prefix (same wire shape as `collab_session_error_to_napi`).
- DTO mappers cover all 6 `CellValue` variants (incl. `Blank`/`Pending`); `session_cell_value_from_json`
  rejects missing payload, non-finite numbers, and `error`/`pending`/unknown kinds (No-Fallbacks).
- `SessionVersion(Vec<u8>)`→`Buffer` opaque round-trip; `FormatId` Builtin/Custom (`peer:u64`→BigInt);
  `SheetId:u16`→`u32` lossless; `DateSystem`→string.
- Adding `ql-exec` does NOT pull the umya xlsx-writer / image-codec tree into the default cdylib
  (`ql-exec` default features empty; `xlsx-write` opt-in).
- The smoke test's assertions are non-vacuous and correct against the contract.

## Pre-existing clippy debt (NOT this increment; do not block)
`cargo clippy -p ql-bindings-node` is RED at HEAD (it has `#![deny(clippy::all)]`) due to the `rust-1.95.0`
clippy bump: 4 deny-errors in pre-existing CollabSession-path code — `lib.rs:416` (clone_on_copy), `:502`
(doc_overindented_list_items), `:564` (empty_line_after_outer_attr), `:2788` (redundant_locals). The
workspace also has warn-level `doc_lazy_continuation`/`type_complexity` in ql-storage/ql-oplog/ql-collab.
**Needs a focused, separate hygiene pass** (the `:564` one requires relocating an orphan doc block — not a
one-liner). The inc.2d additions are clean.

**Conclusion:** SHIP. One LOW (doc) fixed; the rest are pre-existing/out-of-scope and tracked for 6.1C/6.3.

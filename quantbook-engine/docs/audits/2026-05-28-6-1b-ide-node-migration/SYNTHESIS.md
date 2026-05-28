# Audit synthesis — Phase 6.1B IDE-side Node `Session` migration (2026-05-28)

**Scope.** Cross-repo increment closing decision-lock §2 item 3 + risk-mit #1 (migrate the Node
path early to catch missing commands). Wires the engine's owning `WorkbookSession` (the `Session`
napi class, engine inc.2d `ea5987e4253`) into the IDE (VS Code fork, branch `feat/visualise-v1`),
rebuilds the cdylib so two SOURCE-ONLY `CollabSession` fixes go live, and adds mocha tests.

**IDE diff (5 files, repo `…/quantlab/quantlab`):**
- `extensions/quantlab/src/quantbook/types.ts` — `SheetInfoJson`, `SessionCellValueInput`,
  `SessionInstance`, `SessionConstructor`, `Session` on `QuantbookNativeModule`.
- `extensions/quantlab/src/quantbook/loader.ts` — `Session` constructor + prototype-method
  shape-check in `loadQuantbookEngine()` (mirrors the existing per-version checks).
- `extensions/quantlab/src/quantbook/session.ts` — `createWorkbookSession()`.
- `extensions/quantlab/test/quantbook-session.test.ts` — NEW: owning-Session smoke through the real
  loader + B#1 + S2-01 regressions.
- `extensions/quantlab/test/quantbook-roundtrip.test.ts` — the V2.8 fixture-optionality test's fake
  module gained a `Session` stub (the loader now requires `Session`).

**Engine change:** none (code already at `ea5987e4253`). The cdylib was REBUILT
(`cargo build -p ql-bindings-node --release --features test-fixtures`) so the new `Session` class +
B#1 (`ff09a5e17a7`) + S2-01 (`7e536fc07b2`) are live in `target/release/libql_bindings_node.dylib`.

**Tests:** full IDE suite **1435 passing / 0 failing / 25 pending** (was 1424; +11 new). The new
file's 11 tests pass through the real `loadQuantbookEngine()` load path.

## Parallel Codex + Opus audit

Both lanes verified at engine source. **Opus: SHIP** (0 HIGH/0 MED). **Codex: one MED + one LOW +
one INFO.** Convergent on the load-bearing facts; the MED is the one actionable finding.

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | **MED** (Codex) | The S2-01 **cross-window** test was vacuous as a regression guard: `sessB.mergeBytes(...)` force-invalidates B's workbook cache (`ql-collab/src/session.rs:1761/1770`), so `workbookSnapshotDelta(vB)` deterministically returns `fullRebuildRequired=true` and never reaches the `changedCells` filter the S2-01 fix lives in — it would pass even on the buggy binary. (Opus had rationalized the same underlying fact as "acceptable, leak-free either way"; Codex's read that it doesn't *discriminate the fix* is the correct one.) | **FIXED.** A true two-peer fast-path delta is impossible (any merge clears the cache). Reframed the test honestly: it no longer claims to guard the filter; it now deterministically asserts `fullRebuildRequired===true` + `changedCells.length===0` + B's full snapshot omits the tombstoned sheet (end-to-end no-leak via the full-rebuild fallback). The **LOCAL** S2-01 test is the real filter regression — both lanes confirmed it is non-vacuous (RemoveSheet behind the baseline, abnormal PutValue in-window, `fullRebuildRequired===false` so the filter is genuinely hit; passes only with the `is_sheet_removed_in_cache` skip at `lib.rs:2701-2717`). |
| 2 | **LOW** (Codex) | `WorkbookSnapshotJson.version` is optional in TS but the Rust DTO always populates it (`lib.rs:916`, `Session.snapshot()` `lib.rs:4373`). | **Pre-existing** (the shared CollabSession DTO; not introduced here). Tightening it to required risks other consumers' narrowing. **Tracked for 6.1C/6.3 DTO-fidelity** alongside the `schema_version` omission. Not changed in this increment. |
| 3 | **INFO** (Codex) | The new suite skips when the cdylib is absent (matches the existing pattern), so CI must ensure the engine is rebuilt or the proof is vacuous; a stale binary present on disk is NOT skipped — the loader now fails loudly on a missing `Session` (good). | Accepted; consistent with the sibling suite. Tracked: CI must build `ql-bindings-node --release --features test-fixtures` before these tests are meaningful. |

**Verified (both lanes):** type fidelity — every `SessionInstance` signature + `SessionCellValueInput`
(kinds `number|boolean|text|blank`, `error`/`pending` rejected) + `SheetInfoJson{id,name}` exactly
mirror the engine `impl Session` (`lib.rs:4295-4388`) and its `#[napi(object)]` DTOs; loader
`Session` check + 9-method prototype list complete and consistent; **B#1 local + S2-01 local are
genuinely discriminating** (would fail pre-fix, pass post-rebuild); no No-Fallback violations in the
5 files.

## Findings carried to 6.1C
- `Session` exposes no `workbookSnapshotDelta` / transport / presence / undo over napi (only full
  `snapshot()`) → the live `CellGridPanel` delta path cannot be driven by `Session` yet (later
  increment / 6.3). Method-shape diffs vs `CollabSession` documented in `types.ts`.
- DTO fidelity: `WorkbookSnapshotJson.version` optional-in-TS vs always-present; `schema_version`
  omission; snapshot `formats` non-deterministic ordering; no `catch_unwind` under `panic=abort`.
- Making fixes LIVE in a running IDE requires a main-process restart (not just reload-window).

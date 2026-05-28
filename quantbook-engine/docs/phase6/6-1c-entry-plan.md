# Phase 6.1C — Security/Design Audit · Entry Plan

**Status:** ✅ SCOPED 2026-05-28. Ready to launch in a fresh session.
**Predecessor:** 6.1B IDE-side Node `Session` migration SHIPPED (cross-repo, IDE `feat/visualise-v1` `c24222315ed`; engine doc-sync `fbef9d8be1f`). Synthesis `docs/audits/2026-05-28-6-1b-ide-node-migration/`.
**Mandate:** Decision-lock §2 item 4 — *MANDATORY before broader binding/service exposure.* Produces the **Phase-6 exit-packet** audit artifact (`docs/phase6/exit-packet.md`-feeder per §6).

## 1. Why a dedicated session

This is a **5-way parallel megaudit** (4 Codex lanes + Opus orchestration/synthesis), the heaviest audit class on the Phase 6 path. The owning `WorkbookSession` is **~5117 lines** + the napi binding **~4426 lines** + the `ql-session` contract crate **~316 lines** ≈ **~9859 lines** of core surface, plus the IDE TS consumer (types/loader). Auditor independence + a clean context devoted to the megaudit are load-bearing: phase-level closures historically use 3-5-way parallel audits and catch findings that per-batch audits miss (memory: "Phase 4.11+4.12 used 5-way [megaudits] and caught 22 HIGHs invisible per-batch").

## 2. Surface in scope

| Area | Files | LoC |
|---|---|---|
| Owning `WorkbookSession` (the subject) | `crates/ql-exec/src/session.rs` | 5117 |
| `Session` napi binding (FFI boundary) | `crates/ql-bindings-node/src/lib.rs` (the `Session` class — search `js_name = "Session"`, `impl Session` ~`:4276–:4402`; `engine_error_to_napi` ~`:4115`; `session_cell_value_from_json` ~`:4140`; the Send/Sync compile-proof ~`:4404`). `CollabSession` is OUT OF SCOPE for 6.1C except where the shared DTOs/error pattern matter. | ~150 (Session-specific) |
| Contract crate (DTOs + EngineSession trait + EngineError + lifecycle) | `crates/ql-session/src/` (especially `session.rs`, `dto.rs`, `error.rs`) | ~316 + DTO/error modules |
| IDE consumer wiring (DTO fidelity check) | `extensions/quantlab/src/quantbook/{types.ts,loader.ts,session.ts}` in the IDE repo `quantlab/quantlab` (`feat/visualise-v1` `c24222315ed`) | small |
| Shared `#[napi(object)]` DTOs (read for fidelity) | `WorkbookSnapshotJson`, `SheetSnapshotJson`, `CellSnapshotJson`, `CellValueJson`, `FormatIdJson`, `FormatDefJson`, `SheetInfoJson` in the napi `lib.rs` | small |

**Cross-references:**
- Contract: `docs/api/session-api.md` (v2, Codex-validated).
- Implementation plan: `docs/api/workbook-session-impl-plan.md` §0 (live state).
- Decision lock: `docs/phase6/decision-lock.md` §3 (what 6.1 must lock) + §4 (UDF graph-invalidation; v1 acceptance items).
- Prior audits: `docs/audits/2026-05-27-inc2-session-audit/` + `…-inc2c{5,67,9,10,11,12}-*` + `…-2026-05-28-inc2d-session-napi-audit/` + `…-2026-05-28-6-1b-ide-node-migration/`.

## 3. Seed inputs (migration-deferred findings — must be addressed)

Compiled from the inc.2d audit + the IDE-migration audit. Each lane must either close or formally file each item.

1. **FFI panic boundary — no `catch_unwind` under `panic=abort`** (engine-wide; identical to `CollabSession`). napi-rs does not catch panics; under `panic=abort` a Rust panic in any binding method aborts the host process. → **Lane A.**
2. **Snapshot `formats` ordering non-determinism.** `WorkbookSession::snapshot()` consumes `FormatTable::iter()` which is HashMap-backed (arbitrary order); the consumer DTO docs promise sorted-by-FormatId. Affects ALL bindings + golden tests. → **Lane C.**
3. **`WorkbookSnapshotJson.version` optional-in-TS vs always-present-in-Rust.** Pre-existing DTO drift (the shared CollabSession DTO too); inflicts `Buffer|undefined` narrowing on consumers. Codex LOW from the IDE migration. → **Lane C.**
4. **`schema_version` omission on `WorkbookSnapshotJson`** (and the other DTOs). No forward-compat versioning surfaced to consumers; how do they detect a schema break? → **Lane C.**
5. **No single "delete cell contents" (value+formula) command.** `clear` = convert-to-literal (value preserved); `setValue({kind:'blank'})` clears value only. A consumer that wants "delete this cell entirely" must compose. UX/spec gap. → **Lane C.**
6. **`Session` has no `workbookSnapshotDelta`/transport/presence/undo over napi.** This blocks driving the live `CellGridPanel` off `Session` — the IDE migration scoped *out* the live-UI swap on this basis. 6.1C must decide: is delta-over-napi a 6.1 surface obligation (i.e., add it) or formally 6.3? → **Lane B (delta) + Lane C (overall scope).**
7. **Method-shape diffs `Session` vs `CollabSession`** (`addSheet` returns id vs void; `listSheets` returns `{id,name}[]` vs `number[]`; `setValue`/`setFormula` vs `appendPutValue`/`appendPutFormula`). Intentional, but consumer-side surprise. → **Lane C** (document the contract delta).
8. **Cross-cutting tracked: storage-level effective-non-blank-value extent API.** csv/xlsx/.qbook all iterate the conservative `Sheet::bounds` which grows on `Blank` writes → blank-inflated exports. Plus a pre-existing HashMap-ordered fresh-sheet-rels emission in the xlsx exporter. → **Lane D.**
9. **`ops` + `events` unbounded growth.** No retention horizon (`change_log` IS bounded; Loro undo capped at 100). Memory leak under sustained use. → **Lane C.**
10. **Workspace clippy debt (rust-1.95.0).** warn-level `doc_lazy_continuation` in ql-storage(1)/ql-oplog(3)/ql-collab(14) + `type_complexity` in ql-collab(×4 → candidate `PendingUndoCells` alias). Non-breaking; a focused hygiene pass. → **filed as a tracked follow-up** (NOT a 6.1C lane).

## 4. Lanes

Each lane runs `codex exec -s read-only` against a self-contained prompt file in `docs/phase6/6-1c-prep/` and produces a `.out` artifact. Run in parallel (Mac bridge, background). Opus orchestration consumes all 4 + cross-correlates.

| Lane | Scope | Prompt | Output |
|---|---|---|---|
| **A** | FFI boundary · panic / `catch_unwind` · Send/Sync · `engine_error_to_napi` · index validation · owned-data discipline | `6-1c-prep/lane-a-ffi-panic.md` | `6-1c-prep/lane-a.out` |
| **B** | Lifecycle/state machine · cancellation honesty · `{epoch, state_seq}` token · `snapshot_delta` change-log · op-log + Loro UndoManager coherence | `6-1c-prep/lane-b-lifecycle.md` | `6-1c-prep/lane-b.out` |
| **C** | DTO fidelity · snapshot determinism · `schema_version` · unbounded growth · method-shape diffs vs CollabSession · the "delete cell contents" gap | `6-1c-prep/lane-c-dto-determinism.md` | `6-1c-prep/lane-c.out` |
| **D** | Persistence (`.qbook` open/save) · import/export (xlsx/csv) · op-log payload integrity · the effective-extent cross-cutting · xlsx feature-gate correctness | `6-1c-prep/lane-d-persistence-io.md` | `6-1c-prep/lane-d.out` |
| **E (Opus)** | Synthesis · cross-lane convergence · severity assessment · blocking vs filed | not a Codex prompt — Opus orchestrator + the orchestration `README.md` | `docs/audits/2026-05-2X-6-1c-megaudit/SYNTHESIS.md` |

## 5. Orchestration

See `6-1c-prep/README.md` for the run script + the fresh-session opening prompt (`6-1c-prep/SESSION-OPENING-PROMPT.md`).

Order in the fresh session:
1. Orient: read the entry plan + `current_work.md` (the IDE migration is shipped; engine HEAD at `fbef9d8be1f`).
2. Launch all 4 Codex lanes in parallel (background tasks, ~5–15 min each).
3. While Codex runs, dispatch a parallel Opus reviewer (an Agent) over the same scope as a 5th independent lane.
4. Wait for all 5 to complete (wait on the completion notifications).
5. Read every output in full (Codex writes findings asynchronously — patience).
6. Synthesize: cross-correlate findings across lanes; verify each at source; assess severity (HIGH/MED/LOW/INFO); decide blocking-for-6.1C-exit vs filed-as-follow-up.
7. Implement any HIGH/MED blockers (separate audit-fix commit).
8. Write the synthesis doc at `docs/audits/2026-05-2X-6-1c-megaudit/SYNTHESIS.md`.
9. Doc-sync (impl-plan §0, MASTER-PLAN, `.plans/_active.md`, memory).

## 6. Exit criteria

6.1C is COMPLETE when:
- All 4 Codex lanes + the Opus lane have produced findings.
- Every finding is verified at source (cite `file:line`).
- Every HIGH/MED is either fixed or formally filed with rationale.
- The 10 seed inputs above are each closed or filed with a clear disposition.
- The synthesis doc exists + is doc-synced into impl-plan / MASTER-PLAN / `.plans/_active.md` / memory.
- The decision is made (and documented): does `Session` need `workbookSnapshotDelta`/transport/presence/undo over napi at 6.1 exit, or are those formally 6.3 work?
- The Phase-6 exit-packet artifact has a clear seed pointing here.

## 7. Discipline (carry-over)

- ≤2 plan-implement-audit cycles per session. 6.1C alone is 1 audit cycle; an audit-fix commit (if needed) is a 2nd.
- Run codex/agents 3–10 min — be patient, read the FULL output.
- Mac-host gotchas: `rg` not installed (grep); `cargo`/`rustfmt` not on PATH (`$HOME/.cargo/bin/...`); commit via `mac zsh -lc`; commit-msg-file + `git commit -F`; NEVER `--no-verify`.
- Stage explicit files; verify `git show HEAD:<path> | wc -l` == `wc -l < <path>` (the git-index padding race has recurred).
- Co-Authored-By trailer.

# Lane B — Lifecycle · cancellation · `{epoch, state_seq}` · `snapshot_delta` · op-log / Loro UndoManager coherence (read-only)

You are auditing the **state machine + temporal invariants** of the owning `WorkbookSession`. **READ-ONLY** — verify at source; do not build/run/edit. Report findings as HIGH/MED/LOW/INFO with `file:line` anchors and a SHIP/REVISE verdict.

## Repo
- Engine worktree: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine` (branch `feat/quantbook-engine`).
- `rg` NOT installed → grep. File reads direct.

## Surface in scope
- `crates/ql-exec/src/session.rs` (5117 lines) — the WHOLE file, but focus on:
  - The `WorkbookSession` struct (fields: `workbook`, `oplog`, `graph`, `plans`, `registry`, `undo_manager`, `baseline`, `state`, `epoch`, `state_seq`, `change_log`, `ops`, `events`, `txns`, `next_txn_id`).
  - The `ensure_*` gates (`ensure_ready`, `ensure_readable`, `ensure_openable`, etc. — find them by grep).
  - State transitions: `Lifecycle::New|Ready|Busy|Faulted|Closed` (and `from_workbook` / `close`).
  - `with_runtime` FaultGuard + `with_runtime_no_oplog` (post-inc.2 F3 fix `879f3601747`).
  - `bump_epoch`, `advance_state_seq`, `record_changes` — the token + change-log surface.
  - `snapshot_delta` (inc.2c-3 `20427b1c4c7`) — empty/epoch/future/stale paths + epoch-bump for delta-inexpressible states.
  - `batch` (inc.2c-4) + the transaction handle (inc.2c-5) — validation-atomicity + same-cell conflict guard.
  - `undo` / `redo` (inc.2c-7) — Loro `UndoManager` field + `rematerialize` (baseline-replay) + `bump_epoch` post-undo.
  - `recalc_dirty` / `recalc_all` — the Busy gating + the op-registry events.
  - `cancel(op_id)` + `operation_status` — the cancellation surface.
- `crates/ql-oplog/src/lib.rs` (or wherever `OpLog::append`/`iter` live) — only the bits the session uses.
- `crates/ql-session/src/operation.rs` (or similar) — `OperationId`, `OperationStatus`, lifecycle enum.

## Verify (with severity)

### B1 — State machine completeness + invalid-transition reachability
- Enumerate every state-changing transition: `New → Ready`, `Ready → Busy`, `Busy → Ready`, `Ready/Busy → Faulted`, `* → Closed`.
- For each `#[napi]` (and `EngineSession`) method, confirm the precondition gate (`ensure_*`) matches the documented contract in `docs/api/session-api.md` §2.3 + §3 (commands). Flag any method that:
  - Accepts in a state the docs say it shouldn't (or vice-versa).
  - Mutates state without going through a single canonical setter (concurrent observers may see a torn state).
  - Uses `mem::take` / `mem::replace` on `WorkbookSession` itself (inc.2c-9 `open`, inc.2c-10 `import` — verify `*self = from_workbook(loaded_wb)` is atomic from JS's perspective; the lock is held; no `await` mid-replace).
- The `FaultGuard` (`with_runtime`): does it cover EVERY runtime mutation? A panic inside any other code path (outside `with_runtime`) won't transition to `Faulted` — is that intentional? Reachability?
- `close` semantics: idempotent? Repeated `close` calls?

### B2 — Cancellation honesty
- Contract (`session-api.md` §3.3 + `decision-lock.md` §3): in-engine recalc cancellation is **pre-start-cancel-only** in v1 (recompute_* are synchronous commit-as-you-go loops; CalcgraphSession isn't Clone; hard no-late-commit only for out-of-process UDF/SQL/AI).
- Audit: walk `cancel(op_id)` + `recalc_dirty` / `recalc_all`. Does the cancel actually do anything mid-recalc? Or is it a no-op (cancellation request recorded, but the recalc finishes and commits regardless)? Document the truth.
- `operation_status(op_id)`: does it track every long op? Are operations cleaned up post-terminal? (Lane C audits unbounded growth — coordinate there if `ops` HashMap never prunes.)
- Are there any `Busy` operations that don't register an OperationId? (e.g. a slow `recalc_all` with no externally-cancellable handle.)

### B3 — `{epoch, state_seq}` version token correctness
- The 24-byte token (epoch + state_seq + magic). Verify the encoder/decoder is fail-loud for malformed bytes (Codex 6.1A HIGH from the session-api review: `invalid_version_token`).
- **`state_seq` invariants** (inc.2c-3): advances on every committed mutation + every recompute-with-changes + Blank-clear (closed via inc.2c-6 `Op::ClearValue`). Walk every mutation path and confirm exactly one tick per command:
  - `set_value` (incl. Blank), `set_formula`, `clear`, `set_format`, `register_format`.
  - `add_sheet`, `rename_sheet`, `delete_sheet`, `restore_sheet`, `move_sheet`, `set_name`.
  - `create_table`, `rename_table`, `rename_column`, `resize_table`, `drop_table`.
  - `batch`, `commit_transaction` (one tick for the whole BatchCommit, not per inner op — verify).
  - `undo`, `redo` (one tick? plus `bump_epoch` — verify the order is sound).
  - `recalc_dirty`, `recalc_all` — tick iff `changed_cells` non-empty.
  - `import`, `open` — they re-mint epoch + reset state_seq; verify.
- **Epoch-bump for delta-inexpressible states**: `move_sheet`, `restore_sheet`, all table ops, `open`, `import`, `undo`, `redo`. Confirm each bumps the epoch BEFORE the mutation so any in-flight `snapshot_delta` token reads as EpochMismatch.

### B4 — `snapshot_delta` change-log integrity
- `change_log` (inc.2c-3 design (a)) — keyed by `state_seq`, bounded `CHANGE_LOG_CAP`. Find the cap value; document it.
- The four token-status paths (§4.3 in session-api.md):
  - **empty `lastSeen`** → `NoPriorVersion` (full snapshot).
  - **epoch mismatch** → `EpochMismatch` (full).
  - **future seq** (caller > current) → fail-loud `invalid_version_token`.
  - **stale (`seq < floor`)** → `StaleHorizon` (full).
- For each, find the engine code path. Confirm: future seq is fail-loud (NOT a silent full-fallback — that would be a No-Fallbacks violation).
- The `RecomputeResult.changed_cells` (added in inc.2c-3): does it accurately reflect what `record_changes` writes? Are there changes that bypass the change-log (e.g. format-only changes — does the delta DTO carry them)?
- Lane C will audit DTO fidelity (`changedCells`, `removedCells`, `sheetsChanged`, `sheetsRemoved`, `formatsAdded`); HERE focus on the engine-side change-tracking correctness.

### B5 — Op-log + Loro `UndoManager` coherence
- `OpLog::append` + `loro::UndoManager` interaction (inc.2c-7 `4f8e9858d77`). Both sit on the same Loro substrate. Verify:
  - Every committed mutation produces exactly ONE Loro commit (1-command-1-undo-unit; `set_merge_interval(0)`).
  - `rename_table` / `rename_column` are wrapped in `grouped()` (F10 fix is now defense-in-depth after inc.2c-8 made them single-`BatchCommit` by construction).
  - `rematerialize` after undo/redo: replay the post-undo op-log onto a CLONE of `baseline: Workbook` → `rebuild_from_workbook` → `recompute_all` (op-log detached) → `bump_epoch`. Verify this sequence is atomic from JS's perspective (lock held) + the `baseline` field is correctly populated in BOTH `from_workbook` paths (the `Workbook::new()` and the populated-load path — Codex HIGH from the inc.2c-7 audit closed this; verify it still holds for inc.2c-9 `open` + inc.2c-10 `import`).
- The 100-step Loro undo cap (Loro default). Documented? Surfaced to consumers? Cleanly silently-drops oldest, not crashes? Verify by reading the Loro UndoManager docs / inc.2c-7 source comments.
- **F2 closure** (inc.2c-6 `Op::ClearValue`): every value-clear path emits it (`set_value(Blank)`, batch's `Clear` variant, transaction's `Clear`, undo of a non-Blank value).
- Op-log payload validation on `.qbook` open (Codex HIGH inc.2c-9 closed): verify the `iter()` payload-walk still exists in `open`.

### B6 — Atomicity of multi-step operations
- `batch(ops, options)`: validate-all up front → ONE `Op::BatchCommit` → apply via `with_session_state_no_oplog` → `record_changes`. Verify the validation-atomicity is GENUINE (a partial-validation-then-mutate scenario would corrupt state). Same-cell value/formula conflict rejection (`conflicting_batch_ops`) — fail-loud, not silent-resolve.
- `commit_transaction`: drains the buffer through the same `batch` machinery. Failed commit keeps the txn open + buffer restored — verify.
- `rename_table` / `rename_column` (inc.2c-8 F10): single `Op::BatchCommit` append-before-mutate. Verify the inner ops carry exactly `[Rename*, PutFormula × N]` and the replay reconstructs the end state.
- `delete_sheet` / `restore_sheet` / `move_sheet`: append-before-mutate. Double-delete = no-op (F5). Restore-of-live = Conflict (F5).

### B7 — `Busy` correctness during recalc
- `recalc_dirty` / `recalc_all` transitions to `Busy`, then back to `Ready` (or `Faulted`). Are there any methods that can be called WHILE `Busy` that the contract says shouldn't? (e.g. mutations during a recalc — the contract says reject with `Busy` error.)
- The op-registry: every recalc-bound work item registers + transitions on completion.

## Output format
- Bullet list of findings (severity-tagged, `file:line` anchors).
- SHIP / REVISE verdict.
- A "verified clean" list of confirmed invariants.

If you cannot ground a claim in a `file:line`, mark it speculation/INFO. Do NOT report findings without source verification.

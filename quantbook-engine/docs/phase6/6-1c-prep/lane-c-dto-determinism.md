# Lane C — DTO fidelity · snapshot determinism · `schema_version` · unbounded growth · method-shape diffs (read-only)

You are auditing the **consumer-visible contracts + drift** between the Rust source-of-truth and the TypeScript / generic-binding DTOs, plus the unbounded-growth invariants. **READ-ONLY** — verify at source; do not build/run/edit. Report findings as HIGH/MED/LOW/INFO with `file:line` anchors and a SHIP/REVISE verdict.

## Repos in scope
- Engine: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine` (branch `feat/quantbook-engine`).
- IDE consumer (the only realized binding today): `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab` (branch `feat/visualise-v1`).
- `rg` NOT installed → grep.

## Surface in scope
- Rust DTO source-of-truth: `crates/ql-bindings-node/src/lib.rs` — every `#[napi(object)]` struct (`WorkbookSnapshotJson`, `SheetSnapshotJson`, `CellSnapshotJson`, `CellValueJson`, `FormatIdJson`, `FormatDefJson`, `SheetInfoJson`, `WorkbookSnapshotDeltaJson` + its constituents, `PresenceStateJson` if relevant). Find each by searching `#[napi(object)]`.
- Rust DTO mappers: `workbook_snapshot_json_from_session`, `cell_snapshot_json_from_session`, `sheet_info_json_from_session`, `format_id_json_from_*`, `format_def_json_from_*`. Read the `formats` ordering at the source (`FormatTable::iter()` — likely in `crates/ql-storage/src/format_table.rs` or `crates/ql-types/...`).
- TS mirror: `extensions/quantlab/src/quantbook/types.ts` (IDE repo).
- Growth-bound fields: `ops`, `events`, `change_log`, `txns`, `next_txn_id`, Loro `UndoManager` (cap 100). Source: `crates/ql-exec/src/session.rs`.
- `Session` napi method signatures vs `CollabSession` (the migration surfaced diffs): grep both in `lib.rs`.

## Verify (with severity)

### C1 — DTO field-by-field parity (Rust ↔ TS)
For each `#[napi(object)]` Rust struct, read the corresponding TS interface in `types.ts`. Build a field table: `Rust field` ↔ `TS field` ↔ `Rust type` ↔ `TS type` ↔ `Required?`. Flag every drift:
- **Optional drift** (e.g. `WorkbookSnapshotJson.version: Buffer` in Rust always-populated, `version?: Buffer` in TS — the inc.2d/IDE-migration Codex LOW). Real consumer-side narrowing burden? Should the Rust be `Option<Buffer>` to honestly reflect a path where it's `None`, OR the TS made non-optional?
- **Type drift** (any `u32` ↔ `number` mismatches; `BigInt` consistency; `Buffer` vs `Uint8Array`).
- **Discriminator drift** in `CellValueJson` `kind`: Rust accepts `'number'|'boolean'|'text'|'blank'` as INPUT (verified by inc.2d/IDE migration), emits `'number'|'boolean'|'text'|'error'|'pending'` as OUTPUT. Does the TS surface separate input vs output (the IDE migration added `SessionCellValueInput` — confirm it's correct), or does it conflate them?
- **Missing fields** either side (e.g. `rendered`/`formula` on `CellSnapshotJson` — both present, both `Option`).
- **Inconsistent `Option` semantics**: Rust `Option<T>` ↔ TS `T?` ↔ TS `T | null`. The `cell(...)` napi returns `Result<Option<CellSnapshotJson>>` → TS should be `CellSnapshotJson | null`. Confirm.

### C2 — `schema_version` (or its absence)
- None of the `#[napi(object)]` DTOs carry a `schema_version` field (the IDE migration noted this as a 6.1C input). Is that the right call? If so, document the forward-compat strategy: a breaking DTO change is detected how — by the loader's prototype shape-check? By an `engineVersion()` discriminator? By a magic field on the snapshot?
- For each DTO, propose (in the audit output, not in code) the minimum compatibility surface: add a `schema_version: u32` to each top-level DTO? Or to just `WorkbookSnapshotJson`? Or none and rely on `engine.version()` + the loader check?
- Cost of adding `schema_version` to every DTO: serialization overhead (1 u32 per object), consumer migration. Cost of NOT having it: silent-drift on a breaking change.

### C3 — Snapshot `formats` ordering non-determinism (the inc.2d-deferred finding)
- `WorkbookSession::snapshot()` → `workbook_snapshot_json_from_session` → reads `FormatTable` (find the type at `crates/ql-storage/src/format_table.rs` or similar). The iteration source: is it `HashMap::iter()` (arbitrary), `BTreeMap::iter()` (sorted), or a `Vec` (insertion-ordered)? **Find the actual source and quote it.**
- Consumer impact: golden-test diffing, snapshot equality assertions, cross-binding parity. The IDE has shape-equivalence tests that pass today — verify them; do they sort before comparing?
- Cost of forcing sorted order at the engine: a `BTreeMap` swap or a `sort_by_key` per snapshot. Acceptable for v1?
- Recommend: emit sorted by `FormatId` (deterministic) at the engine. Severity?

### C4 — Method-shape diffs `Session` vs `CollabSession` (the migration surfaced these)
- `Session.addSheet(name, chunkRows) -> u32 (SheetId)` vs `CollabSession.addSheet(name, chunkRows) -> void`. Intentional?
- `Session.listSheets() -> Vec<SheetInfoJson{id,name}>` vs `CollabSession.listSheets() -> Vec<u32>`. Intentional?
- `Session.setValue(sheet,row,col, CellValueJson)` vs `CollabSession.appendPutValue(sheet,row,col, f64)`. Different in: (a) method name, (b) value type (typed input vs raw number), (c) the void-vs-error semantics.
- `Session.setFormula(sheet,row,col, String)` vs `CollabSession.appendPutFormula(...)`. Same shape, different name.
- `Session` has NO `workbookSnapshotDelta`/`pollRemote`/`mergeBytes`/`exportBytes`/`attachTransport`/`undo` (over napi). This is the migration's load-bearing finding (the live `CellGridPanel` cannot consume `Session` until at least `workbookSnapshotDelta` is added).

**Decision needed (this is a 6.1C call):** does `Session` need any of these over napi at 6.1 exit? Audit:
- `workbookSnapshotDelta`: required to drive the live grid. 6.3 (full bindings) or 6.1?
- `undo`/`redo`: the engine impl exists (inc.2c-7); bridging to napi is mechanical. 6.1 surface obligation?
- `import`/`export`/`open`/`save`: same — engine impls exist. 6.1 obligation?
- `batch`/`begin_transaction`/...: more delicate FFI design (opaque transaction handle, batch DTO). Likely 6.3.

Recommend a clear cut-line per method.

### C5 — Unbounded growth audit
For each in-memory store on `WorkbookSession`, document the retention policy + reachability of an unbounded-state attack/leak:
- `ops: HashMap<OperationId, OperationStatus>` (or similar). Grows on every operation. Does it ever prune? If not, a long-running session leaks. Severity?
- `events: Vec<SessionEvent>` (`poll_events` drains; but if nothing polls, it grows). What's the consumer obligation? Drained-on-poll? Capped?
- `txns: HashMap<TransactionId, Vec<SessionOp>>`. Drained on commit/rollback/close. Are there paths where a transaction is begun but never closed (a leaked handle from a crashed consumer)?
- `next_txn_id: u64`. `checked_add` per inc.2c-5 — verify. id-space exhaustion → `Internal/transaction_id_exhausted`.
- `change_log` — bounded `CHANGE_LOG_CAP`. Find the cap value. Is it documented? Configurable?
- Loro `UndoManager` — 100-step Loro default. Documented. Configurable?
- The `Workbook` itself (cell storage) — unbounded by design (user data). Out of scope here.

### C6 — "Delete cell contents" UX gap
- The contract today: `clear(sheet,row,col)` removes the FORMULA but PRESERVES the value (convert-to-literal); `setValue(..., {kind:'blank'})` clears the VALUE only. No single "delete everything in this cell" command.
- A consumer that wants to fully empty a cell must call BOTH (in what order? interleaved with a recalc?). Is there a path where the value is recomputed from elsewhere between the two calls?
- Recommend: should there be a `delete_cell(sheet,row,col)` op that does both? Or is the compose-two-calls pattern fine + just needs documentation?

### C7 — Other DTO observations
- `Buffer` vs `Uint8Array` consistency in TS (`Buffer.alloc(0)` shows up in the IDE tests; type says `Buffer`). Node-only or also web-compatible (if bindings target WASM later)?
- `BigInt` use (operation IDs, peer IDs). Are any napi `BigInt` returns guarded for lossy u64 conversion? (The IDE memory mentions ECMAScript `ToUint32` gotchas on `f64` indices but `BigInt` is its own surface.)
- DTO doc-comments: are they accurate? Any docstring that overstates a contract the code doesn't honor?

## Output format
- Bullet list of findings (severity-tagged, `file:line` anchors).
- A field-by-field DTO drift table (C1).
- A method-shape-diff table (C4) with cut-line recommendations.
- SHIP / REVISE verdict.
- "Verified clean" list.

If you cannot ground a claim, mark it speculation/INFO.

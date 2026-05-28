# Lane A — FFI boundary · panic / `catch_unwind` · Send/Sync · error mapping · validation (read-only)

You are auditing the **napi binding's safety boundary** for the owning `WorkbookSession` exposed as the `Session` class in `ql-bindings-node`. This is the 6.1C lane on FFI safety. **READ-ONLY** — verify at source, do not build/run/edit. Report findings as HIGH/MED/LOW/INFO with `file:line` anchors and a clear SHIP/REVISE verdict.

## Repo + branch
- Engine worktree: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine` (branch `feat/quantbook-engine`).
- `rg` NOT installed → use grep. Git via `mac zsh -lc 'cd <repo> && git ...'` if needed, but file reads via the filesystem are fine.

## Surface in scope (the `Session` path only — `CollabSession` is OUT OF SCOPE except where the shared error/DTO patterns matter)
- `crates/ql-bindings-node/src/lib.rs` — the `Session` class. Anchors: `js_name = "Session"`, `impl Session` (~`:4276–:4402`), `engine_error_to_napi` (~`:4115`), `session_cell_value_from_json` (~`:4140`), `_ASSERT_BINDING_SESSION_SEND` compile-proof (~`:4404`), the DTO mappers (`workbook_snapshot_json_from_session`, `cell_snapshot_json_from_session`, `sheet_info_json_from_session` — find them by reading the `impl Session` neighborhood), `validate_u16_index` / `validate_u32_index` helpers.
- `crates/ql-exec/src/session.rs` — only the **lifecycle / fault paths** the napi calls into (the `with_runtime` FaultGuard ~F3 closed in inc.2 audit-fix `879f3601747`; the `ensure_*` gates).
- `crates/ql-bindings-node/Cargo.toml` + the workspace `Cargo.toml` profile sections — the `[profile.*]` `panic` setting (look for `panic = "abort"` or `panic = "unwind"`). If unspecified, document the default for `cdylib` targets.
- `crates/ql-session/src/error.rs` — the `EngineError` taxonomy + `Display` (the `"[code] message"` format that downstream consumers parse).

## Verify (with severity)

### A1 — Panic boundary
- Find every `#[napi]` method on `Session` (and the free fn DTO mappers it calls). Does any path have a `catch_unwind` wrapper? If not (expected), what is the workspace's `[profile.release].panic` setting? If `abort` (and on `panic=abort` `catch_unwind` is a no-op anyway): **what is the production failure mode** when a Rust panic occurs inside a `Session` method?
  - Aborts the host process? (Bad — taking down the IDE.)
  - Does napi-rs translate the panic into a JS Error? (Verify at the napi-rs source if needed.)
  - Is there a feature/profile combination that compiles the cdylib with `panic = "unwind"` while keeping the binary lean? Document the cost.
- Enumerate the panic-shaped operations inside `impl Session` methods (any `.unwrap()`, `.expect()`, indexing `[i]`, `match`-on-`Option`, arithmetic overflow paths). For each, **rate the reachability** from JS input. HIGH only if a JS caller can reach it with valid-shape input.
- The `CollabSession` precedent: does it use `catch_unwind`? If yes, why is `Session` different? If no, document the deliberate-stance-consistency.

### A2 — Send / Sync proof
- `_ASSERT_BINDING_SESSION_SEND` (~`:4404`) is a compile-proof that `WorkbookSession: Send` + `Session: Send + Sync`. **Re-derive the field tree.** Walk `WorkbookSession`'s fields (`crates/ql-exec/src/session.rs` around the struct definition) and confirm every field is `Send`. Specifically watch for:
  - `loro::UndoManager`, `OpLog`, `CalcgraphSession`, `Workbook`, `PlanCache`, `Arc<FunctionRegistry>`, `parking_lot::Mutex`, `tokio` types, raw pointers.
  - Any new field added by inc.2c-3/4/5/6/7/8/9/10/11/12 that wasn't covered by the original proof.
- `Arc<parking_lot::Mutex<WorkbookSession>>: Send + Sync` follows iff `T: Send`. Confirm.
- **Per the audit-discipline rule** (memory `quantbook_engine_audit_discipline.md` rule 4): negative trait claims (`!Send`/`!Sync`/`!Unpin`) need positive compile proof OR per-field walk. Here the claim is POSITIVE (`Send + Sync`); the compile-proof exists. Still verify the field walk is honest — no `_phantom: PhantomData<*const ()>` or similar that would silently break the bound.

### A3 — `engine_error_to_napi` + error-mapping completeness
- `engine_error_to_napi(e: EngineError) -> Error { Error::from_reason(e.to_string()) }` (~`lib.rs:4115`). Verify `EngineError::Display` produces the `[<code>] <message>` format that `parseQuantbookError` (IDE consumer side) parses. Walk `EngineError`'s variants (`ql-session/src/error.rs`) and confirm `Display` is exhaustive + each variant emits a stable `[code]`.
- Are there error paths in `impl Session` that bypass `engine_error_to_napi`? Search for `Error::from_reason`, `Err(napi::Error::*)`, panics, plain `.unwrap()`. Any direct napi-Error construction should map a known EngineError code OR be a documented validation error (`[bad_argument]`).
- `session_cell_value_from_json` (~`:4140`): unknown `kind` returns what? Verify it produces a `[bad_argument]`-prefixed napi Error (the IDE migration's smoke test asserts this regex). Is the input validation complete: NaN/Infinity numbers, empty `text`, missing required field per kind?
- Closed `#[non_exhaustive]` enums in `ql-session`: any wildcard `_` arm that silently degrades to a generic message instead of an `Internal/unmapped_*` code? (The `map_persistence_err` / `map_xlsx_err` / `map_csv_err` patterns explicitly do this for the engine-side. Audit the napi-side equivalents.)

### A4 — Index validation discipline (No silent ECMAScript coercion)
- All `f64` index params (`sheet`, `row`, `col`, `chunk_rows`) go through `validate_u16_index` / `validate_u32_index`. Read those helpers. Confirm they reject:
  - NaN, ±Infinity.
  - Negative values.
  - Fractional values (`2.5`).
  - Out-of-range (>u16::MAX for sheet, >u32::MAX for row/col).
- Walk every `#[napi]` method on `Session` and confirm every index param goes through one of these helpers BEFORE entering Rust-side processing. (The inc.2d audit closed an open question on this; verify it still holds — and that any post-inc.2d addition kept the discipline.)

### A5 — Owned-data discipline (no borrowed refs across FFI)
- Every method returns owned types: `Result<u32>`, `Result<()>`, `Result<WorkbookSnapshotJson>`, `Result<Option<CellSnapshotJson>>`, `Result<Vec<SheetInfoJson>>`, `Result<BigInt>`. Confirm no `Result<&T>`, `Result<Cow<'_, T>>`, or guard-leaking patterns.
- Check the DTO mappers: do any return `&str` or `&[T]` slices to inner workbook state? If so they'd UB across FFI.

### A6 — Lock-hold discipline
- Every `#[napi]` method holds the `parking_lot::Mutex` (via `self.inner.lock()`). Verify no async/`await` happens while the lock is held (would deadlock or freeze the engine). Verify no panic-shaped operations happen with the lock held (parking_lot doesn't poison, but a panic with the lock held still leaves the session in an inconsistent in-Rust state).
- Any path that recursively re-locks `self.inner`? (parking_lot is NOT reentrant — second lock from the same thread deadlocks.)

### A7 — `EngineSession` trait conformance
- The `WorkbookSession` claims `impl EngineSession`. Read `ql-session/src/session.rs` for the trait definition. Confirm every trait method is implemented on `WorkbookSession` and that the napi `Session` exposes the v1 subset agreed at the IDE migration (the 10 methods). Flag any trait method that has drifted between the contract and the impl since inc.2d.

## Output format

End with:
- A bullet list of findings, severity-tagged, each with `file:line`.
- A verdict: SHIP / REVISE (with the count of HIGH/MED that must be addressed before 6.1C exits).
- A "verified clean" list of things you positively confirmed.

Do NOT speculate. If you cannot ground a claim in a `file:line`, mark it INFO/speculation.

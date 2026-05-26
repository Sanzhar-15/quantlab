# Phase 5 Megaudit (5.8) — LANE D transcript (API/contract/binding consistency + deferred-item audit + test-coverage gaps)

**Lane:** D (contract / napi↔TS parity / producer-replay symmetry / deferred re-validation / coverage gaps / error-diagnostics).
**Mode:** read-only static analysis. No source modified.
**Audited at:** engine source HEAD `1465b1db4c4` (working tree at `dfa3d113c90`, docs-only commits on top — confirmed via `git log`); IDE HEAD `d028568b53b` (V3.6.1.2).
**Mac bridge:** live (`echo bridge-ok` OK).
**Method:** read the full contract §4.1.z5 + §4.1.z6 (ide-consumer-contract.md lines 1300–2287); compared all 12 napi `#[napi(object)]` structs + the `CollabSessionInstance` method surface against `extensions/quantlab/src/quantbook/types.ts`; read every sheet-op producer (`lib.rs` rename/delete/restore/move/appendPutValue/appendPutFormula) against the corresponding `replay.rs` apply_op arm and the `Workbook` permissive accessors; read `classify_delta_op`, `workbook_snapshot`, `workbook_snapshot_delta`; enumerated all 134 ql-collab inline `#[test]`, the ql-oplog/ql-collab-ws/ql-exec test files, and the 424 IDE mocha `test()` cases; scanned both repos for No-Fallbacks violations.

---

## D1 — CONTRACT-vs-IMPLEMENTATION drift (whole Phase 5 contract)

The contract is in remarkably good shape post-V3.6.0.10 docs megaudit. The load-bearing V3.6 behavioral claims VERIFY against current code. Specific verifications:

- **A-HIGH-2 / CLOSURE-CODEX-MED-4 (formula text from repaired workbook, no cache fallback)** — TRUE. `lib.rs:2262-2268` reads `repaired_formula` exclusively from `workbook.formula_at(...)`; the prior `.or(state.formula)` fallback is gone.
- **`classify_delta_op` metadata allowlist (CONVERGENT-HIGH-1)** — TRUE. `lib.rs:392-466`: explicit per-variant arms; AddSheet/MoveSheet/RestoreSheet/tables/SetName/SetLocale/SetReferenceMode/SetDateSystem all force fullRebuild; RemoveSheet → `sheetsRemoved` (cell-only-deltable); cell ops → changedCells; RegisterFormat → formatsAdded; `_ => *has_rename=true` conservative wildcard.
- **R-V3.6-9 D7×D8 ordering** ("RestoreSheet must precede rename-repair on rebuild_workbook") — TRUE. `session.rs:2657-2660`: `replay_into` (applies `Op::RestoreSheet`) runs before the three `repair_*_chain` passes.
- **Producer/replay asymmetry (OPUS-PT-B8, contract line 2143)** — TRUE (see D3).
- **D6 cache-invalidation 5-callsite set** — TRUE (merge_bytes / discard_pending_ops / undo / redo / poll_remote_with_limit; append_op excluded).

The only drift found is a stale docstring (see Finding D1-1).

---

## D2 — napi↔TS PARITY (81 `#[napi]` methods + 12 napi structs)

Field-by-field comparison of all `#[napi(object)]` structs vs `types.ts` interfaces. **The CellValueJson "discriminated union" claim is the documented suspect — confirmed (see D2-1).** No other structural type drift found; the napi-rs Option-convention is honored correctly (with the subtle method-return-vs-struct-field distinction the TS correctly observes).

Struct parity table:

| napi struct (lib.rs) | TS interface | Verdict |
|---|---|---|
| `CellValueJson` (582) | `CellValueJson` (73) | shapes match; runtime is a loose bag not a true union — D2-1 |
| `FormatIdJson` (660) | `FormatIdJson` (184) | MATCH (kind + 3 optionals; snake→camel auto) |
| `CellSnapshotJson` (719) | `CellSnapshotJson` (100) | MATCH (row/col/value?/formula?/format?/rendered?) |
| `SheetSnapshotJson` (809) | `SheetSnapshotJson` (205) | MATCH |
| `WorkbookSnapshotJson` (843) | `WorkbookSnapshotJson` (233) | `version: Buffer` (req) vs `version?: Buffer` (opt) — intentional, documented (D2-2) |
| `FormatDefJson` (949) | `FormatDefJson` (322) | MATCH |
| `ChangedCellJson` (968) | `ChangedCellJson` (343) | MATCH |
| `RemovedCellJson` (981) | `RemovedCellJson` (354) | MATCH |
| `WorkbookSnapshotDeltaJson` (1018) | `WorkbookSnapshotDeltaJson` (372) | MATCH (7 fields incl version + fullRebuildRequired) |
| `PresenceStateJson` (1078) | `PresenceStateJson` (51) | MATCH (snake→camel: selection_end_row→selectionEndRow) |

Method-return Option mapping confirmed CORRECT: `peerPresence` returns `Option<PresenceStateJson>` → TS `PresenceStateJson | null` (napi-rs maps method-return `None`→`null`, NOT undefined). This is DISTINCT from struct-field `Option<T>` which maps to absent/undefined. The TS correctly uses `| null` for the method return and `?:` for struct fields. IDE mocha `peerPresence on never-updated peer returns null` (test line 3607) pins the `null` runtime. **No drift — the convention is applied with the correct two-mode distinction.**

The 81 `#[napi]` methods include transport/fixture internals (`Transport`, `LoopbackPair`, `BlockingTransportFixture`) not all surfaced on `CollabSessionInstance`; the TS surfaces them via `TransportInstance` / `LoopbackPairInstance` / `BlockingTransportFixtureInstance` + `QuantbookNativeModule`. All exposed method signatures match.

---

## D3 — PRODUCER/REPLAY VALIDATION SYMMETRY

**Verdict: CONSISTENT + INTENTIONAL across all sheet ops.** No producer is permissive where it should guard; no wrong guard found.

Evidence:
- **Producers (napi) are STRICT.** `rename_sheet` (lib.rs:1328-1360), `delete_sheet` (1408-1435), `restore_sheet` (1472-1496), `move_sheet` (1547-1575) ALL: (a) reject `id > u16::MAX` with `[bad_argument]`; (b) pre-rebuild the workbook and reject `id >= sheet_count()` with `[bad_argument]`. `appendPutValue` (1577) / `appendPutFormula` (1650) use `validate_u16_index` (sheet) + `validate_u32_index` (row/col) + finite-value check.
- **Replay is PERMISSIVE (silent no-op).** `Op::MoveSheet`→`workbook.move_sheet` (workbook.rs:809-818: `None => return` on id-not-in-display-order; clamps new_index); `Op::RemoveSheet`→`workbook.remove_sheet` (749-753: guards `id < sheets.len()`); `Op::RestoreSheet`→`workbook.restore_sheet` (781-785: guards `id < sheets.len()`). Cell-keyed ops call `validate_cell` (replay.rs:1565) which DOES error on out-of-range sheet/row/col — but the producer's f64+validate path means a producer-emitted cell op is always in-range, so the strict replay never fires for produced ops; it only catches hand-built/corrupted logs.
- The asymmetry is the documented OPUS-PT-B8 design: producer gives the IDE a clear `[bad_argument]` instead of emitting an op the permissive replay would silently swallow → no cache/workbook divergence reachable via napi producers.

**Note (not a defect):** `renameSheet`/`moveSheet`/`deleteSheet`/`restoreSheet` producers do NOT validate the *content* (new name string) — `RenameSheet` carries an unvalidated `new_name`. This is correct: replay's AddSheet/RenameSheet disambiguation handles name collisions (replay.rs:580-651), and empty/reserved names are caught at AddSheet replay. The producer-side name path is intentionally thin.

---

## D4 — DEFERRED-ITEM RE-VALIDATION

| # | Deferred item | Verdict | Justification |
|---|---|---|---|
| 1 | CODEX-MED-1 / CLOSURE-CODEX-MED-1 (out-of-range RemoveSheet cache-vs-replay parity) | STILL-VALIDLY-DEFERRED | "Only reachable via malformed logs" claim re-verified TRUE: D3 confirms all sheet-op producers guard `id<sheet_count` with `[bad_argument]`, so a divergence-causing op cannot be emitted via napi. Only the stray Lane A tmp probe (`codex_lane_a_out_of_range_remove_sheet_cache_replay_parity`) exercises it; no committed regression test, but the reachability boundary is closed by the producer guard. |
| 2 | V2 V4 V2 K4 chunking | STILL-VALIDLY-DEFERRED | Pure perf/transport optimization (large-blob chunking); not a correctness gap; offline-queue×reconnect works without it (auto_flush.rs offline suite passes). |
| 3 | R-V3.6-9 D7 #REF! substitution (conditional, unshipped) | STILL-VALIDLY-DEFERRED | D7 not shipped; the D7×D8 ordering note ("RestoreSheet precedes rename-repair on rebuild_workbook") is ACCURATE (session.rs:2657-2660 — verified D1). Tombstoned-sheet formula refs stay as text strings; no crash. |
| 4 | sheet-tabs UI (V3.5.0.4c / V3.6+ multi-tab) | STILL-VALIDLY-DEFERRED | Multi-sheet UX covered by Command Palette commands + reactive title (R-V3.5-3 ACCEPTED); polish, not correctness. |
| 5 | B9 removedCells (always [], V3.7+) | STILL-VALIDLY-DEFERRED (exemplary) | `lib.rs:2804 removed_cells: Vec::new()`; contract+TS both document "always empty". IDE `mergeWorkbookDelta` (cellGridLogic.ts:1020-1030) IMPLEMENTS + fixture-tests the removedCells merge path so a future engine emitting them cannot silently diverge the cache. True removals trip fullRebuildRequired instead. Not rotted. |
| 6 | CellValueJson union cleanup (scoped) | SHOULD-CLOSE-NOW (low priority) | The loose-bag shape (D2-1) is a real, persistent footgun; no IDE code currently relies on the absent-payload invariant being structurally enforced, but a typed union (or a serde-tagged enum on the wire) would eliminate the discriminate-by-hand requirement. Defer is tolerable but the cleanup is overdue and cheap; flag as a Phase 6 entry candidate. |
| 7 | incremental DOM patching (V3.6.2+) | STILL-VALIDLY-DEFERRED | Full `webview.html` reassign per render is the current model; the delta layer (V3.6.1) already cut the *engine* cost 228×. DOM-level patching is a further IDE-side perf step, not a correctness gap. |
| 8 | Smaller backlog: transportLastErrorInfo() / willFlushSend() / LoopbackTransport.close() / HandshakeFailed fixture / CollabSessionError::Transport(_) origin / @napi-rs/cli publish / #[napi(strict)] sweep / AtomicUsize conn_id wrap / per-cell incoming-tint / status-bar item / push-API inbound observation / jsdom virtualization test | STILL-VALIDLY-DEFERRED (all) | All are ergonomics/diagnostics/dev-tooling/UX-polish items, none on the v1-critical correctness path. `transportLastError()` (unstructured string) exists today; the structured `transportLastErrorInfo()` is a nicety. `#[napi(strict)]` sweep is mitigated by the per-method `validate_u16/u32_index` discipline already in place. |
| 9 | Codex INFO-3/INFO-5 stable-op-ID migration (R-V3.6-10) | STILL-VALIDLY-DEFERRED | Positional-index fragility under Loro UndoManager retract is CLOSED operationally via `rebuild_op_indices_only` (undo/redo refresh indices); stable-op-ID is the long-term V3.7+ cleanliness fix, not a live bug. Pinned by `v3_6_0_4_d3_undo_refreshes_indices_after_loro_retract`. |

---

## D5 — TEST-COVERAGE GAPS (concrete untested invariants)

Coverage is broad (134 ql-collab inline + 67 ql-oplog + 42 ql-collab-ws + 424 IDE mocha + ql-exec conflict-matrix). Specific gaps:

**GAP-1 (MED): `Op::Unknown(String)` forward-compat variant has NO encode→decode→replay round-trip test.** PLAN §2.3 explicitly requires every wire variant (incl `Unknown(String)`) to have round-trip + multi-peer coverage. `wire.rs` tests only `rejects_unknown_field_in_*` + `rejects_unknown_kind_tag` (rejection of malformed input), NOT acceptance/round-trip of a deliberately-constructed `Op::Unknown`. The forward-compat catch-all is the single most important variant for cross-version safety and it is unexercised.

**GAP-2 (MED): No multi-peer `CollabSession::merge_bytes` convergence test for AddSheet / MoveSheet / RemoveSheet / RenameSheet / PutFormula / ClearFormula.** Sheet-op convergence is tested at the ql-oplog `replay_into`-on-merged-log level (`phase_5_3_step2_rename_concurrent.rs`) and through the WorkbookRuntime (`phase_5_3_conflict_matrix_probe.rs`), and RestoreSheet has `v3_6_0_10_restore_sheet_remote_merge_converges`, but the actual Loro-CRDT path the IDE uses (`CollabSession::merge_bytes`) only has cross-peer convergence tests for SetCellFormat, RegisterFormat, RestoreSheet, presence, and PutValue. MoveSheet (display-order overlay) concurrent-merge convergence through the collab crate is the most notable absence.

**GAP-3 (LOW): `CreateTable` / `ResizeTable` concurrent-merge convergence untested.** `phase_5_3_step4/step5` cover concurrent RenameTable / RenameColumn / DropTable, but concurrent CreateTable (e.g., two peers create same-named table) and concurrent ResizeTable convergence have no test. Phase 5 exit criterion #2 names "tables merge deterministically" — the create/resize sub-cases are unverified. Mitigated by: no napi/IDE producer for table ops (they're wire-only), so the divergence is not reachable from the product surface today.

**GAP-4 (LOW): SetName (named-range) convergence is tested only at the ql-exec/WorkbookRuntime layer, not the ql-collab `merge_bytes` layer.** `row5_setname_concurrent_same_name_converges` (phase_5_3_conflict_matrix_probe.rs:408) covers it via WorkbookRuntime; there is no `CollabSession::merge_bytes`-level SetName convergence test and no napi/IDE producer. Names "merge deterministically" (exit criterion #2) is verified but at one layer removed from the collab CRDT path.

**Adequately covered (NOT gaps):** offline-queue×reconnect (auto_flush.rs:1344-1634 + websocket_transport.rs:384 reattach-after-close-delivers-offline-ops + IDE mocha line 693 VV-baseline-reset + 1970 reconnect-mid-flight); all 7 CacheEffect walker arms (PutValue/PutFormula/ClearFormula/RegisterFormat/SetCellFormat/RemoveSheet/RestoreSheet all have inline tests incl tombstone variants); grouped-undo + merge-interval; partial-invalidate side-by-side equality across all cell-keyed ops; delta cell-only fast-path + staleness + all metadata-op fullRebuild triggers (IDE mocha 6488-7057); V3.6.1 delta-merge shape-equivalence divergence guard (`delta-merged === fresh workbookSnapshot`, test line 7486) + shared-per-session cache (7464); typing-stroke watchdog dispatcher (7110-7170).

---

## D6 — ERROR / DIAGNOSTICS surface + No-Fallbacks scan

**Error taxonomy is well-structured.** `CollabSessionError::kind()` (session.rs:381-388) maps to stable strings (`session_oplog`/`session_presence`/`session_undo`/`session_replay`, Transport passes through inner kind). `QuantbookErrorCode` union (types.ts:1420-1479) mirrors all engine kinds + napi `[bad_argument]` + transport/websocket/qbook codes. Conflict/argument diagnostics ARE surfaced, not swallowed: the IDE `dispatchIncomingMessage` putValue arm (cellGridLogic.ts:451-461) emits a structured `errorReply` to the webview with `info.code`+`info.message`; `tickPollRemote` merged-branch render failures (cellGridPanel.ts:1036-1053) log the code + on fatal `bad_argument`/`session_oplog` surface `showWarningMessage` + dispose. CRDT merge itself never "conflicts" in a user-visible failure sense (Loro converges deterministically); divergence/decode errors surface as `[session_oplog]`/`[session_replay]`.

**No-Fallbacks scan — documented boundary fallbacks (acceptable under the CLAUDE.md system-boundary exception, all made visible):**
- format-render parse failure → `rendered=None` (lib.rs:2305/2316/2739, `.ok()?`): documented Phase 5.6 conservative discipline + contract line 765; the IDE falls back to value-default. This is the one place a real error (malformed format string) is silently dropped to `None`. Flag D6-1.
- tombstoned-sheet-mid-lifetime → empty frame + `console.warn` (cellGridPanel.ts:805-820): UI boundary, made visible via warn + explicitly acknowledged in docstring.
- malformed delta `lastSeenVersion` Buffer → `fullRebuildRequired=true` (lib.rs:2519-2526): a DESIGNED recovery signal, not a swallowed error; the IDE re-fetches. Correct.
- `acquireWorkbookSnapshotViaDelta` `fullRebuildRequired` → full re-fetch (cellGridLogic.ts:1108-1112): designed signal, correct.
- `post-reconnect flush failed` → logged-then-continue (cellGridPanel.ts:1107-1114): logs the code, deliberately doesn't escalate (next tick retries). Borderline but logged.
- two `catch { /* best-effort */ }` on `detachTransport()` (cellGridPanel.ts:1085, 1158, 1168): teardown/reconnect cleanup where the transport may already be dead; swallow is at a cleanup boundary. Borderline — see D6-2.

No `|| default` / `rescue nil` / silent-degradation that hides a real *correctness* error was found in the Phase 5 surface beyond the format-render one (D6-1).

---

## FINDINGS (per-finding format)

### D1-1 — `workbookSnapshotDelta` `# Errors` docstring claims `[bad_argument]` on malformed Buffer, but the code returns `fullRebuildRequired=true`
- **Severity:** LOW
- **Files:** engine `crates/ql-bindings-node/src/lib.rs:2485` (docstring) vs `crates/ql-bindings-node/src/lib.rs:2519-2526` (code)
- **Evidence:** Docstring `# Errors` says "`[bad_argument]` on malformed `last_seen_version` Buffer (Loro decode error)." Actual code: `Err(_) => { ... return Ok(empty_delta(current_version_bytes, true)); }` — it does NOT throw; it returns a delta with `fullRebuildRequired=true`. The contract (line 1067), the TS docstring (types.ts:415), and the mocha test `garbage bytes for lastSeenVersion returns fullRebuildRequired=true (not throws)` (roundtrip test:6670) all correctly say it does NOT throw. Only the Rust `# Errors` docstring is stale.
- **Recommendation:** Fix the Rust docstring `# Errors` section to say malformed Buffer → `fullRebuildRequired=true` (not `[bad_argument]`). Doc-only; one-line edit. Defer-OK (cosmetic), but it directly contradicts the verified behavior.

### D2-1 — `CellValueJson` documented as a discriminated union but is a loose bag (kind + 4 independent optional payloads)
- **Severity:** LOW (INFO-adjacent; known suspect, confirmed)
- **Files:** engine `crates/ql-bindings-node/src/lib.rs:581-587`; IDE `extensions/quantlab/src/quantbook/types.ts:73-82`
- **Evidence:** napi struct is `{ kind: String, number: Option<f64>, boolean: Option<bool>, text: Option<String>, error: Option<String> }` — a flat record, NOT a tagged enum. The TS interface is `{ kind: '...'; number?: number; boolean?: boolean; text?: string; error?: string }` — also a loose bag. Both docstrings *call* it a "discriminated union" and instruct consumers to "switch on `kind`", but neither the wire shape nor the TS type structurally enforces that exactly the kind-matching payload is present. A producer bug or future variant could set the wrong payload (e.g., `kind:'number'` with `text:'x'`) and no layer would reject it. Contrast the cleaner `QuantbookCellValue` union (types.ts:1091-1096) used by `exportSnapshot`, which IS a real TS discriminated union.
- **Recommendation:** This is the V3.6.1-backlog "CellValueJson union cleanup" item (D4-6). Convert the TS `CellValueJson` to a real discriminated union (`{kind:'number';number:number} | {kind:'boolean';boolean:boolean} | ...`) so the compiler narrows the payload by `kind` — zero engine change required, pure TS. The engine `From<CellWireValue>` impl already produces correct shapes; the TS just under-types them. SHOULD-CLOSE-NOW (cheap, removes a real footgun).

### D2-2 — `WorkbookSnapshotJson.version` is required in Rust (`Buffer`) but optional in TS (`version?: Buffer`)
- **Severity:** INFO
- **Files:** engine `crates/ql-bindings-node/src/lib.rs:932` (`pub version: Buffer`); IDE `types.ts:311` (`version?: Buffer`)
- **Evidence:** napi always populates `version` (lib.rs:2406-2412); the TS marks it optional. The TS docstring (types.ts:300-309) documents this as INTENTIONAL: optional so fixture-literal unit tests don't need a `Buffer.alloc(0)` placeholder; real napi calls always populate it. This is a deliberate ergonomics choice, correctly documented + pinned by `Object.keys(snap)` shape tests.
- **Recommendation:** No action. Documented + tested. Consumers reading `version` for delta calls treat it as required-when-from-a-real-call (per docstring). Acceptable.

### D5-1 — `Op::Unknown(String)` forward-compat wire variant has no round-trip / replay test
- **Severity:** MED
- **Files:** engine `crates/ql-oplog/src/op.rs:511` (`Unknown(String)`); test gap in `crates/ql-oplog/src/wire.rs` + `crates/ql-oplog/tests/*.rs`
- **Evidence:** PLAN §2.3 requires every wire variant — explicitly including `Unknown(String)` — to have encode→decode→replay round-trip + multi-peer coverage. The only `Unknown`-touching tests are negative (`rejects_unknown_field_in_builtin_variant`, `rejects_unknown_field_in_custom_variant`, `rejects_unknown_kind_tag` at wire.rs:525/537/561) — they verify rejection of malformed input, not acceptance + replay-no-op of a deliberately-constructed `Op::Unknown`. The forward-compat catch-all is the variant most relied on for cross-version wire safety, and it is unexercised.
- **Recommendation:** Add a ql-oplog test constructing an `Op::Unknown("...")`, encoding it, decoding it, and asserting replay treats it as a benign no-op (or whatever the replay arm does — verify the arm exists). MED because forward-compat is a stated wire guarantee with zero current coverage. Phase-6-entry candidate.

### D5-2 — No `CollabSession::merge_bytes` (collab-crate) convergence test for MoveSheet / AddSheet / RemoveSheet / RenameSheet / PutFormula / ClearFormula
- **Severity:** LOW
- **Files:** test gap in `crates/ql-collab/src/session.rs` (inline tests) + `crates/ql-collab/tests/`
- **Evidence:** Cross-peer convergence through the Loro-CRDT `merge_bytes` path (the path the IDE actually uses) is tested for SetCellFormat (`cross_peer_set_cell_format_converges_via_merge_bytes`), RegisterFormat (`v3_6_0_x_audit_of_d2_cross_peer_concurrent_same_id_diff_string_converges`), RestoreSheet (`v3_6_0_10_restore_sheet_remote_merge_converges`), presence, and PutValue (`two_sessions_converge_via_attached_loopback`). The other sheet/cell ops are tested only at the ql-oplog `replay_into`-on-merged-log level (`phase_5_3_step2_rename_concurrent.rs`) — which is the CRDT-determinism level but NOT the collab-crate merge path. MoveSheet display-order-overlay concurrent convergence is the most notable absence (overlay merge under Loro is subtle).
- **Recommendation:** Add ql-collab two-session merge_bytes convergence tests for MoveSheet (concurrent reorders) and RemoveSheet (concurrent delete + edit). LOW — replay-level convergence is proven; this closes the layer gap.

### D5-3 — No concurrent-merge convergence test for CreateTable / ResizeTable; SetName convergence tested only at WorkbookRuntime layer
- **Severity:** LOW
- **Files:** test gap in `crates/ql-oplog/tests/` (only RenameTable/RenameColumn/DropTable concurrent covered at step4/step5) + `crates/ql-collab/`
- **Evidence:** Phase 5 exit criterion #2 names "tables merge deterministically" and "names merge deterministically." Tables: only RenameTable / RenameColumn / DropTable have concurrent tests (`phase_5_3_step4/step5`); concurrent CreateTable (two peers same-name) and ResizeTable have none. Names: `row5_setname_concurrent_same_name_converges` (`crates/ql-exec/tests/phase_5_3_conflict_matrix_probe.rs:408`) covers SetName convergence but via WorkbookRuntime, not ql-collab merge_bytes; no napi/IDE producer for either tables or names.
- **Recommendation:** Add concurrent CreateTable + ResizeTable convergence tests at the replay/merge level. LOW because tables + names have NO product producer (wire-only), so divergence is unreachable from the v1 surface — but the exit criterion claims determinism, so the create/resize sub-cases should be pinned before declaring "tables merge deterministically" fully verified.

### D6-1 — Engine format-render parse failure silently drops to `rendered=None` (No-Fallbacks tension)
- **Severity:** LOW
- **Files:** engine `crates/ql-bindings-node/src/lib.rs:2305,2316` (workbook_snapshot) + `2732,2739` (delta path), `format::parse(fmt_str).ok()?`
- **Evidence:** When a registered format string fails to parse, `.ok()?` swallows the parse error and yields `rendered=None`; the IDE falls back to value-default rendering. The cell value still surfaces (no data loss) but a malformed-format diagnostic is invisible. Documented in the contract (line 765) + CellSnapshotJson docstring (lib.rs:762-765) as "silent fallback per Phase 5.6 conservative discipline; no error surfaced." Under CLAUDE.md No-Fallbacks this is a swallow, justified only by the "format-render is best-effort display" boundary argument.
- **Recommendation:** Acceptable for v1 (display-only, value preserved). For completeness, consider logging the parse failure to a diagnostics channel (engine has none today) or surfacing a `renderError?: string` field so the IDE can show a format-broken indicator. Defer-OK but note it's the one genuine silent-error swallow in the Phase 5 engine surface.

### D6-2 — `catch { /* best-effort */ }` swallows on `detachTransport()` during reconnect/teardown
- **Severity:** INFO
- **Files:** IDE `extensions/quantlab/src/quantbook/cellGrid/cellGridPanel.ts:1085, 1158, 1168`
- **Evidence:** `handleTransportClosed` (1083-1085) and `disposeAttachment` (1156-1158, 1166-1168) wrap `detachTransport()` / `spawnedRelay.kill()` in `catch { /* best-effort */ }` with no log. These are teardown/reconnect-cleanup paths where the transport may already be dead, so a detach error is expected and non-actionable. Unlike the other catches in this file (which log the code), these are fully silent.
- **Recommendation:** Minor No-Fallbacks polish: add a `state.log.appendLine` in these three catches so even cleanup failures are visible (the file's own convention everywhere else). INFO — cleanup boundary, low risk, but inconsistent with the file's otherwise-disciplined logging.

### D6-3 — Stray untracked test file `megaudit_lane_a_tmp.rs` in the engine source tree
- **Severity:** INFO (hygiene)
- **Files:** engine `crates/ql-collab/tests/megaudit_lane_a_tmp.rs` (git status `??` — untracked)
- **Evidence:** A Codex Lane A scratch test file (test fns `codex_lane_a_adversarial_pairs`, `codex_lane_a_wire_and_replay_roundtrip_all_known_variants`, `codex_lane_a_forward_compat_unknowns_surface_without_panic`, `codex_lane_a_out_of_range_remove_sheet_cache_replay_parity`, `codex_lane_a_raw_replay_rejects_out_of_range_cell_without_panic`) sits in the committed-tests directory. It will compile + run as part of `cargo test -p ql-collab`, perturbing the "158/158 ql-collab" baseline the exit packet must cite. It is THIS megaudit's Lane A working file (parallel lane); not a defect, but it must be removed or committed before the Phase 5 exit test-count attestation.
- **Recommendation:** Lane E / orchestrator: `git clean` or fold any keeper probes into committed tests before finalizing the exit packet's test-count attestation. Note: it interestingly DOES cover GAP-1 (Unknown round-trip) + the CODEX-MED-1 parity probe — consider promoting those two into the committed ql-oplog suite to close D5-1 + the CODEX-MED-1 coverage gap permanently.

---

## VERDICT

**Lane D: PASS-WITH-FINDINGS.** Zero HIGH. The documented contract matches reality across the whole Phase 5 surface; napi↔TS parity holds (the one known suspect — CellValueJson loose-bag — confirmed and is a typing-cleanliness LOW, not a runtime drift); producer/replay validation symmetry is consistent + intentional across every sheet op; all deferred items are validly deferred (B9 removedCells is exemplary defensive deferral) except CellValueJson cleanup which SHOULD-CLOSE-NOW (cheap TS-only); error/diagnostics surface conflict info correctly with only one justified-boundary engine swallow (format-render) and a stray Lane-A tmp file to clean up.

Phase 5 exit criteria from Lane D's vantage:
- (#1 ql-collab real) — confirmed real (10.7k LOC, 134 inline tests, full CRDT merge path).
- (#2 cells/formulas/names/sheets/tables merge deterministically) — cells/sheets/format CONFIRMED at collab-merge level; **names + tables verified at replay/runtime level but with the merge-layer coverage gaps D5-2/D5-3** (no v1 producer, so not exit-blocking, but the "deterministic" claim is one layer removed for names/tables/create/resize).
- (#3 offline sync + conflict diagnostics) — offline×reconnect well-tested; diagnostics surfaced via structured error codes.
- (#4 single-writer op-log not confused with collaboration) — the producer/replay asymmetry + the CRDT merge tests demonstrate the distinction holds.

**Counts:** HIGH 0 · MED 1 (D5-1) · LOW 5 (D1-1, D2-1, D5-2, D5-3, D6-1) · INFO 3 (D2-2, D6-2, D6-3). Total 9 findings.

### Deferred-item disposition table

| Item | Disposition |
|---|---|
| CODEX-MED-1 out-of-range RemoveSheet parity | STILL-DEFERRED |
| V2 V4 V2 K4 chunking | STILL-DEFERRED |
| R-V3.6-9 D7 #REF! substitution | STILL-DEFERRED |
| sheet-tabs UI (V3.5.0.4c) | STILL-DEFERRED |
| B9 removedCells (V3.7+) | STILL-DEFERRED (exemplary guard) |
| CellValueJson union cleanup | CLOSE-NOW (TS-only; D2-1) |
| incremental DOM patching (V3.6.2+) | STILL-DEFERRED |
| transportLastErrorInfo / willFlushSend / LoopbackTransport.close / HandshakeFailed fixture / Transport(_) origin / @napi-rs/cli publish / #[napi(strict)] sweep / AtomicUsize conn_id wrap / per-cell incoming-tint / status-bar item / push-API inbound / jsdom virtualization test | STILL-DEFERRED (all) |
| Codex INFO-3/INFO-5 stable-op-ID (R-V3.6-10) | STILL-DEFERRED |

### Coverage-gap list (D5)
- GAP-1 / D5-1 (MED): `Op::Unknown(String)` no round-trip/replay test.
- GAP-2 / D5-2 (LOW): no collab-`merge_bytes` convergence test for MoveSheet/AddSheet/RemoveSheet/RenameSheet/PutFormula/ClearFormula (replay-level covered).
- GAP-3 / D5-3 (LOW): no concurrent CreateTable/ResizeTable convergence test; SetName convergence only at WorkbookRuntime layer.

### Coverage note (D1–D6)
All six checklist items COMPLETED:
- D1 ✅ whole contract §4.1.z5+§4.1.z6 verified against engine+IDE code; 1 stale docstring found.
- D2 ✅ all 12 napi structs + method surface diffed vs types.ts; CellValueJson loose-bag confirmed; Option-convention two-mode distinction verified correct.
- D3 ✅ producer/replay symmetry verified across rename/delete/restore/move/appendPutValue/appendPutFormula vs replay arms + Workbook permissive accessors — consistent + intentional.
- D4 ✅ all listed deferred items re-validated with verdicts.
- D5 ✅ test coverage enumerated (Op variants, CacheEffect arms, convergence, offline×reconnect, delta layer) — 3 concrete gaps named.
- D6 ✅ error taxonomy + No-Fallbacks scan both repos — 1 justified engine swallow, 2 INFO hygiene items.

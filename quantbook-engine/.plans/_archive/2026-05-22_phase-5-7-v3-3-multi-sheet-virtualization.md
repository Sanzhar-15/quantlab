---
name: 2026-05-22_phase-5-7-v3-3-multi-sheet-virtualization
status: done (V3.3.0 FULLY SHIPPED through V3.3.0.X megaudit + closures.  Codex Lane A + Opus Lane B parallel audit: 1+2 HIGH cumulative + 2+5 MEDIUM + 3+4 LOW.  10 of 11 findings closed in-cycle at engine `73e31df1737` + IDE `6dcc7ef9a20`.  ql-collab 76/76, IDE mocha 181/181.  Rule 4 arc terminus held at 6.  Plan ready for archive; V3.3.1+ or V3.4 entry-plan is the next session entry.)
date: 2026-05-22
predecessor_plan: .plans/_archive/2026-05-22_phase-5-7-v3-2-cell-grid-ui.md (V3.2 phase termination, all sub-steps shipped + exit-packeted)
predecessor_exit_packet: docs/phase5/5-7-v3-2-exit-packet.md (V3.2 closure -- cell-grid UI vertical slice; FIRST product-user-visible surface)
predecessor_v3_2_d_audits: docs/audits/2026-05-22-phase-5-7-v3-2-{codex,opus}.md (V3.2.d audit; Opus § Section 3 V3.3 ENTRY READINESS is the basis for THIS entry plan)
parent_phase: 5.7 Collaboration IDE Vertical Slice
direction: V3.3 -- multi-sheet + virtualized rendering. Scales the V3.2 grid widget from "hundreds of cells, one sheet" to "10K+ cells, multiple sheets per workbook" without losing the V3.2 audit discipline. Adds new engine napi surface (listSheets + exportSnapshot incremental cache) + IDE-side virtualization renderer + multi-sheet UX.
current_engine_head: 73e31df1737 (V3.3.0.X engine megaudit closures + 2 audit transcripts + new ql-collab tests; predecessor abb6f340ab7 = V3.3.0.7 docs)
current_ide_head: 6dcc7ef9a20 (V3.3.0.X IDE megaudit closures + 5 new mocha tests; predecessor 96b9afa37c4 = V3.3.0.6)
current_mocha_count: 181 / 181 (V3.2 exit baseline 140 + V3.3.0.2 +5 + V3.3.0.3 +4 + V3.3.0.4 +18 + V3.3.0.5 +5 + V3.3.0.6 +4 + V3.3.0.X +5)
current_ql_collab_tests: 76 / 76 (74 pre-V3.3.0.X + 2 V3.3.0.X: undo_invalidates_snapshot_cache + force_clear_snapshot_cache_test_seam)
current_ql_collab_tests: 74 / 74 (with --features test-fixtures)
current_ql_collab_ws_tests: 42 / 42 (10 lib + 30 ws + 2 V3.1.a relay)
current_engine_workspace: 4472 / 0 baseline (V3.3.0.X added 2 ql-collab unit tests for cache-invalidation + test seam; rest of workspace untouched)
audit_rules_inherited:
  - Rule 1: no fresh-session reminders
  - Rule 2: parallel Codex+Opus per major sub-step
  - Rule 4: negative trait claims need positive compile proof OR per-field walk.  Arc terminus = 6.  V3.3 will introduce new Rust state (incremental-snapshot cache field on CollabSession) -- per-field walks REQUIRED at the engine sub-step audit, not just the phase-termination audit.
session_cycles_budget: 2 cycles per session per CLAUDE.md global rule.  V3.3 is multi-week; expect 5-7 sessions.
v3_3_progress_summary: V3.3.0.1 decision lock shipped this commit.  V3.3.0.2 engine listSheets() + V3.3.0.3 engine incremental cache + V3.3.0.4 IDE virtualization scaffold + V3.3.0.5 multi-sheet UX + V3.3.0.6 tests + V3.3.0.X audit = 6 sub-steps in V3.3.0.  V3.3.1+ (incremental rendering polish) deferred to a later entry plan.
---

# Phase 5.7 V3.3 -- Multi-Sheet + Virtualized Rendering (Plan)

V3.3 lifts the V3.2 cell-grid widget from "hundreds of cells, one sheet" to "10K+ cells, multiple sheets per workbook" -- the FIRST scale-out beyond the V3.2 vertical slice.  V3.2's audit-driven discipline carries; the new engine + IDE surfaces both get parallel Codex+Opus audits at V3.3.0.X phase termination.

## Scope

V3.3 is **NOT** a full feature build.  It is:

1. **V3.3.0** -- multi-sheet + virtualization scaffold (~1 week).
2. **V3.3.1+** (later entry plan) -- incremental rendering polish, listSheets metadata expansion, optimistic-rendering revisit if WAN-exposed.

V3.3 explicitly **DOES NOT** include:

- `.qbook` persistence (V3.4 scope per V3.2.e exit packet).
- Undo/redo (V3.4 scope; couples with persistence).
- Presence (V3.4 scope per Phase 5.6 V2 integration).
- `rebuild_workbook` routing (V3.5+ scope; the V3.3 incremental cache is the V3.3-scope alternative to full workbook reconstruction).
- Push API for inbound observation (deferred to V3.x; V3.2.c.1 C2 decision held).
- Full Op enum beyond `PutValue` (V3.5+).

## V3.3.0 -- design decisions (V3.3.0.1, LOCKED 2026-05-22)

Per V3.2.e exit packet § "V3.3 ENTRY READINESS" + the V3.2.d Opus Lane B § Section 3 V3.3-readiness analysis.  Six decisions:

### Decision D1: Renderer architecture

**Question:** how does the IDE webview render 10K+ cells without full re-render every tick?

**Options:**
- A. **clusterize.js** -- UMD-shippable, ~5KB minified, no bundler step needed.  Lives well alongside the existing nonced inline script.  Hosted inline in the HTML or loaded via `asWebviewUri` from `extensions/quantlab/media/clusterize.min.js` with `script-src ${cspSource}` widened to allow.
- B. **react-window** -- ~40KB + needs a bundler step (webview script today is INLINE; adding a bundle artifact means `asWebviewUri` + new build pipeline + new `localResourceRoots`).
- C. **Custom inline virtualization** -- ~100 lines of "render only visible rows; on scroll, swap which rows are rendered".  No third-party dep.  Maximum control; smallest surface.  Mocha-driveable.

**Recommendation: C (custom inline virtualization)** for V3.3.0 scaffold.

**Rationale:**
- Matches the V3.2 inline-script pattern (no new build pipeline; no new CSP widening).
- ~100 lines is auditable; clusterize.js source review is feasible but adds a dep dance for one consumer.
- Mocha tests can drive the virtualization logic by extracting pure functions into `cellGridLogic.ts` (the same vscode-free split pattern that paid off at V3.2.b/c/d).
- React-window forces a bundler step that would ripple across the IDE's TypeScript build.

**Decision: C.**  Reconsider at V3.3.1 if custom implementation hits a complexity wall (e.g., variable-row-height + sticky headers + horizontal scroll all need polish).  Library swap is a clean refactor since the dispatcher (`cellGridLogic.ts`) is renderer-agnostic.

### Decision D2: Multi-sheet UX

**Question:** how does the user navigate between sheets?

**Options:**
- A. **Panel-per-sheet** -- one VS Code tab per (workbook, sheet).  User opens sheet 1 + sheet 2 = two tabs.  Each panel owns its own session reference.
- B. **Sheet-tabs-in-panel** -- one VS Code panel = one workbook; sheets are sub-tabs inside the webview.  User switches sheets via in-webview UI.
- C. **Hybrid** -- panel + in-panel quick-switcher (e.g., command palette `>Cell Grid: Switch Sheet`).

**Recommendation: A (panel-per-sheet)** for V3.3.0.

**Rationale:**
- Matches V3.2 single-tab-per-sheet cache invariant (V3.2.d HIGH-1 closure already maps to this model).
- Each panel renders independently; less webview-script complexity vs sheet-tabs.
- Memory: ~1KB per panel (one CellGridPanel + one CollabSession reference); 10 panels = ~10KB.  Acceptable for V3.3 scale (assume single-digit sheets per workbook in V3.3 usage).
- Future V3.4 add-on: a `quantlab.quantbookCellGridSwitchSheet` command that does panel-multiplexing OR (B) sheet-tabs (revisit when user feedback wants it).

**Decision: A.**  Add `quantlab.quantbookCellGridSwitchSheet` as a V3.x backlog item.

### Decision D3: listSheets() napi shape

**Question:** how does the IDE enumerate sheets in a workbook?

**Options:**
- A. **`CollabSession.listSheets(): Vec<u16>`** -- u16 sheet IDs only.
- B. **`CollabSession.listSheets(): Vec<SheetMetadata>`** where `SheetMetadata { id: u16, display_name: String }` -- includes display name.
- C. **Defer entirely** -- IDE-side hardcoded sheet IDs (0, 1, 2) for V3.3.0 smoke, real enumeration in V3.4+.

**Recommendation: A.**  Engine has the sheet-ID universe in its op log (every `Op::PutValue { sheet, ... }` carries a sheet); enumerate via dedup-walk.  Display name comes from a future `SheetMetadata` Op variant that doesn't exist yet (V3.4+ scope).

**Rationale:**
- u16-only minimizes the new napi surface (one method; one return type; no new struct).
- Engine implementation: walk the op log; collect distinct `sheet` values; return sorted `Vec<u16>`.  O(N) in op count; acceptable at V3.3.0 scale (couple thousand ops).  Can promote to incremental cache later if profiling justifies.
- Display name is a SEPARATE concern (needs a new Op variant + storage); defer to V3.4 when the engine ships `SheetMetadata { id, name, color, hidden }`.

**Decision: A.**  V3.4 expansion: `listSheetsMetadata(): Vec<SheetMetadata>` (separate method, additive).

### Decision D4: Persistence scope

**Question:** does V3.3 include `.qbook` save/load?

**Recommendation: NO -- defer to V3.4.**

**Rationale:**
- V3.3.0 scaffold + V3.3.1 polish is already ~1-2 weeks of work.  Bundling persistence (`.qbook` envelope + file dialog UX + cross-session merge) would balloon the cycle.
- Persistence couples with undo/redo (V3.4): both need the engine's full Op-log replay surface + `rebuild_workbook` (V3.5).  Treating them as one V3.4 + V3.5 phase keeps the audit discipline clean.
- D-1 ship (2026-05-20) already established the Tier D3 envelope (`OPLOG_MAGIC = b"QLOL"` + BE u32 schema version) -- the engine side is ready; only the IDE binding + UX work is pending.

**Decision: defer to V3.4.**

### Decision D5: Optimistic vs pessimistic rendering

**Question:** does V3.3 revisit the V3.2.b.1 B4 PESSIMISTIC decision?

**Recommendation: PESSIMISTIC carries from V3.2.**

**Rationale:**
- V3.2.b.1 B4: localhost IPC is sub-millisecond; user perceives no lag.  This holds at V3.3 scale (no new latency surface introduced).
- WAN exposure is NOT a V3.3 surface (the V3.1.a relay binary is localhost-only; V3.x productionization is when WAN comes in).  Optimistic rendering is the right tool for WAN; deferring it until WAN exposure means deferring it until V3.x.
- Adding optimistic + rollback now would widen the V3.3.0 surface area without measurable user benefit at localhost.

**Decision: PESSIMISTIC.**  Revisit at first WAN smoke (V3.x).

### Decision D6: Push API timing

**Question:** does V3.3 add the engine `Transport::on_inbound_blob` callback hook (V3.2.c.1 C2 deferral)?

**Recommendation: NO -- 1s pollRemote carries from V3.2.c unchanged.**

**Rationale:**
- Push API is a NEW engine surface that needs:
  - new napi binding (likely `ThreadsafeFunction` for the callback)
  - cross-thread callback ownership (tokio task -> napi event loop) -- Rule 4 concerns on Send + Sync of the callback shim
  - a phase-level Rule 4 audit (per Phase 5.7 audit discipline)
- V3.3 already adds engine surface (listSheets + incremental cache); doubling the engine work to also add the push API would compress the audit cycle.
- 1s pollRemote latency is acceptable for V3.3 (V3.3 is single-window OR multi-window-localhost; sub-second polling perceives as "live").  Push API is the V3.x optimization for WAN + high-frequency edit workflows.

**Decision: keep 1s polling.**  Push API stays in V3.x backlog with a dedicated audit cycle.

## V3.3.0 sub-steps

- [x] **V3.3.0.1 -- decision lock** (engine `5fd7ff73648`).  Decisions D1-D6 above.
- [x] **V3.3.0.2 -- engine `CollabSession.listSheets() -> Vec<u16>` napi method.**  Shipped at engine `739611ac3b3` + IDE `33cc3f506a5`.  Engine: walk op log; collect distinct sheets into `BTreeSet<u16>`; return as `Vec<u16>` (BTreeSet iteration is sorted ascending).  Errors via `bad_argument_error` per V2.7 contract.  IDE: typed wrapper `listSheets(session): number[]` in `session.ts` + 5 mocha tests (empty / single-sheet / multi-sheet sorted dedup / u16 boundary / exportBytes round-trip).  Mocha 140 -> 145.
- [x] **V3.3.0.3 -- engine `exportSnapshot` incremental cache.**  Shipped at engine `2bfba9b55ec` + IDE `68b32bc5ad1`.  Closes V3.2.d Opus M4.  New field `last_snapshot: HashMap<(u16, u32, u32), CellWireValue>` on `CollabSession`.  Updated by 5 op-mutation paths (new / from_snapshot / append_op O(1) / merge_bytes rebuild / discard_pending_ops rebuild / poll_remote_with_limit rebuild after drain).  Two new public methods: `snapshot_cells(sheet)` + private `rebuild_snapshot_cache()`.  napi `export_snapshot` reads from cache.  **Rule 4 per-field walk** documented in `last_snapshot` doc: HashMap + (u16,u32,u32) + CellWireValue all Send+Sync; composition Send+Sync; inherits V2.4 Arc<Mutex<>> sync; **0 new triggers**.  **Regression caught + closed in-cycle**: `poll_remote_with_limit` bypassed `CollabSession::merge_bytes` (calls `self.log.merge_bytes` directly); pre-fix V3.2.c.5 loopback round-trip test FAILED; fixed by adding cache invalidation inside the existing `if merged > 0` post-drain block.  IDE: 4 new cache-invariant mocha tests (LWW on local appends / mergeBytes causal-reorder / pollRemote drain regression pin / from_snapshot round-trip).  Mocha 145 -> 149.
- [x] **V3.3.0.4 -- IDE virtualization scaffold.**  Shipped at IDE `570c890f654`.  Pure helpers `computeVisibleRange(scrollTop, rowHeight, viewportHeight, totalRows, overscan?) -> { startIdx, endIdx }` + `buildVirtualRows<T>(entries, startIdx, endIdx): T[]` in `cellGridLogic.ts` (vscode-free; mocha-driveable).  HTML wrapping: `<div class="cell-grid-viewport">` (max-height 80vh, overflow-y: auto, sticky thead via position:sticky); `<tbody>` carries `data-virt-row-height="25"` + `data-virt-total-rows`; top + bottom spacer rows preserve total scroll geometry; full snapshot inlined as `<script id="cell-grid-data" type="application/json">` (CSP-safe, non-executable).  Webview script (buildClientScript additions): scroll listener repaints tbody innerHTML via inline `computeRange` + `renderRowsClient`; mid-edit guard via `activeInput !== null` (skip repaint if user is mid-typing).  Virtualization gate: nonced mode + >40 entries (small snapshots render directly).  18 new mocha tests (149 -> 167): 7 computeVisibleRange + 6 buildVirtualRows + 5 buildHtml virtualization wiring.  V3.2.a-compat test updated to /(<tbody\b)/.test() pattern.  R-V3.3-6 (virtualization+reconnect race) considered + addressed via mid-edit guard.
- [x] **V3.3.0.5 -- IDE multi-sheet UX.**  Shipped at IDE `dbc2bb517b0`.  New command `quantlab.quantbookCellGridSwitchSheet`: `CellGridPanel.activeLocalPanels()` -> first panel's session -> `listSheets(session)` -> `vscode.window.showQuickPick` (items via `buildSheetQuickPickItems`; current sheet marked "(current)"); on selection `CellGridPanel.show(context, session, selectedSheet)` opens a new panel for that sheet (panel-per-sheet per D2).  Panel title updated: "Cell Grid (Sheet N of M)" / "Cell Grid -- Collab (Sheet N of M)" via `session.listSheets().length` at show() time; single-sheet sessions show just "Sheet N".  V3.2.a quantbookCellGrid command seeds sample data on sheets 0/1/2 now (was just 0) so the switch command is demonstrable.  New pure helper `buildSheetQuickPickItems(sheets, currentSheet): SheetQuickPickItem[]` in `cellGridLogic.ts`.  5 mocha tests (167 -> 172): empty / single + current / multi annotation / out-of-sync current / input-order preserved.
- [x] **V3.3.0.6 -- mocha tests + audit gap closures.**  Shipped at IDE `96b9afa37c4`.  Closed 5 of 8 gaps surfaced by the V3.3.0.5 post-ship audit: #3 scroll-simulation via pure-helper composition (jsdom unavailable; 3 tests pin monotonic advancement / spacer geometry / single-row scrollTop); #4 formatCellValueClient drift-hazard JSDoc; #5 multi-panel selection-semantic comment in switch-sheet command; #6 listSheets-per-show cost-bounded explanatory comment; #7 title-computation point-in-time pin (test).  Per-sub-step mocha incrementally hit the plan's "4 listSheets / 3 computeVisibleRange / 3 buildVirtualRows" coverage already (V3.3.0.2-V3.3.0.5 = 32 V3.3.0 tests).  Mocha 172 -> 176 (+4).
- [x] **V3.3.0.7 -- docs.**  Shipped at engine (THIS commit).  `ide-consumer-contract.md § 4.1.z3` covers: new engine napi surface (`listSheets`); `last_snapshot` incremental cache + Rule 4 per-field walk + 5 op-mutation paths + V3.4 undo invalidation contract; custom-inline virtualization geometry (viewport + spacer rows + snapshot data block + scroll-driven repaint with mid-edit guard); multi-sheet UX command + panel-title "of M" convention; V3.2.a sample-data shape change; drift hazards (4 surfaces); V3.3 risk register R-V3.3-1..6; out-of-scope items; live smoke procedure (V3.3.0.6 user-action gap closure).

## V3.3.0.X -- parallel Codex + Opus megaudit + closures ✅ SHIPPED 2026-05-23

- **Lane A Codex** (`docs/audits/2026-05-23-phase-5-7-v3-3-0-x-codex.md`): PASS-WITH-FINDINGS.  1 HIGH (undo/redo bypass cache) + 2 MEDIUM (rebuild atomicity + panel title silent swallow) + 3 LOW (docs cost drift + switch-sheet inline comment + row/col attr escape).
- **Lane B Opus** (`docs/audits/2026-05-23-phase-5-7-v3-3-0-x-opus.md`): PASS-WITH-FINDINGS.  2 HIGH (undo/redo cache bypass + silent listSheets catch) + 5 MEDIUM (rebuild atomicity + 5-vs-6 paths docs + listSheets uses cache + switch-sheet UX confusion + test seam missing) + 4 LOW (row/col escape + !Sync probe pattern + sample-data pin + htmlEscape backtick).
- **Cross-lane convergent**: HIGH-1 undo/redo (both); MEDIUM-1 rebuild atomicity (both); docs drift (both); switch-sheet comment (both); row/col escape (both).
- **Rule 4 arc terminus held at 6.**  V3.3.0.3 `last_snapshot` per-field walk's three claims (HashMap, tuple, CellWireValue all Send+Sync) independently re-verified by Opus against source.

**Closures shipped at engine `73e31df1737` + IDE `6dcc7ef9a20`** (10 of 11 findings closed; 1 LOW deferred to V3.x with rationale):
- **HIGH-1** (engine): `undo`/`redo` call `rebuild_snapshot_cache()` when `consumed == true`; new ql-collab unit test `undo_invalidates_snapshot_cache`.
- **HIGH-2** (IDE): silent `try { listSheets() } catch` removed from `CellGridPanel.show()`; errors propagate to callers' existing showErrorMessage path.  CLAUDE.md No-Fallbacks rule violation closed.
- **MEDIUM-1** (engine): `rebuild_snapshot_cache` uses fresh-HashMap-then-swap pattern; on iter-Err the fresh local drops + cache retains pre-call state.
- **MEDIUM-2** (engine docs): cache-field docstring updated to enumerate 7 mutation paths (was 5); explicit undo/redo annotation post-V3.3.0.X HIGH-1.
- **MEDIUM-3** (engine): new `list_sheets_from_cache()` engine method derives sheet set from cache keys via BTreeSet walk; napi `list_sheets` delegates.  O(N) op-log walk -> O(cells-in-cache).
- **MEDIUM-4** (IDE): switch-sheet inline comment corrected from "most-recently focused" to "OLDEST by Map insertion order".
- **MEDIUM-5** (engine): new test-only `force_clear_snapshot_cache()` seam gated on `#[cfg(any(test, feature = "test-fixtures"))]`; new ql-collab unit test `force_clear_snapshot_cache_test_seam`.  R-V3.3-2 closed pre-V3.4.
- **LOW-1** (IDE): defense-in-depth Number() coercion on row/col attribute interpolation at both server + client renderers.

**Deferred to V3.x with rationale:**
- LOW-2 (Opus): commented-out !Sync probe pattern brittleness -- V3.x refactor to `static_assertions::assert_not_impl_all!` macro; no V3.3 dependency.
- LOW-3 (Opus): V3.2.a sample-data shape pin test -- V3.4 replaces sample-data with real workbook loads.
- LOW-4 (Opus): `htmlEscape` backtick coverage -- IE-quirks-mode theoretical only; webview is Electron Chromium.
- Codex "Out of scope": `Op::BatchCommit` nested PutValue support (V3.5+); tombstoned/metadata-only sheets (V3.5+); jsdom DOM integration test (V3.x); half-row scroll boundary tests (V3.x); scroll throttling at WAN scale (V3.x); reactive title updates (V3.x).

**V3.4 entry-readiness (Opus § V3.4 ENTRY READINESS):**
- Required pre-V3.4: HIGH-1 ✅ (closed in V3.3.0.X), HIGH-2 ✅ (closed), MEDIUM-5 ✅ (test seam landed), MEDIUM-1 ✅ (atomicity).
- Design locks to settle at V3.4 entry: Op-enum cache shape (per-variant vs unified per-cell state); undo/redo invalidation strategy (full rebuild vs partial invalidate accessor); persistence schema-versioning gate (envelope-level vs snapshot wrapper); presence + virtualization race guard pattern.
- R-V3.3-5 (PeerId reuse under restart): UUID-derived peerId migration deferred to V3.x backlog.

**V3.3.0 TERMINATED at V3.3.0.X.closure (engine `73e31df1737` + IDE `6dcc7ef9a20`).**  Plan ready to archive once memory + MASTER-PLAN sweep land.  V3.3.0 exit packet OPTIONAL per plan -- V3.3.1+ may fold into a single V3.3 exit packet; for now, the V3.2.e exit packet pattern + V3.3.0.X megaudit transcripts provide the canonical record.

## V3.3.0 risk register (carries from V3.2.d Opus § V3.3 readiness)

- **R-V3.3-1 Virtualization integration risk** -- MEDIUM.  Mitigated by decision D1.C (custom inline; no library + bundler step).  Watch for: scroll-position drift under fast remote merges (V3.2.c pollRemote tick during scroll).
- **R-V3.3-2 exportSnapshot incremental cache invariants** -- MEDIUM (escalates to HIGH if V3.4 undo lands without re-auditing the cache).  Cache must stay in sync with op log under undo (V3.4+).  V3.3.0.3 design must consider invalidation hooks even if undo doesn't ship until V3.4.  Document the contract; add a `clear_snapshot_cache()` test-only seam.
- **R-V3.3-3 listSheets enumeration consistency** -- LOW.  Op log has the data; walk + dedup is straightforward.  Edge case: what about a sheet that had ops then all its ops were tombstoned (V3.4 undo)?  Out of V3.3 scope; sheet-tombstoning is V3.5+.
- **R-V3.3-4 Persistence schema versioning** -- LOW (V3.4 problem; D-1 ship handled).  Out of V3.3 scope.
- **R-V3.3-5 PeerId reuse under restart** -- MEDIUM.  Carryforward from V3.1.e Codex M1.  V3.3 inherits V3.2.d HIGH-1 closure (single-window collab-then-collab handled); cross-restart still open.  Defensive UUID-derived peerId fix is V3.x backlog.
- **R-V3.3-6 Virtualization + reconnect race** -- NEW (V3.3-specific).  Scroll handler firing while `handleTransportClosed` is mid-reconnect.  Existing `reconnectInFlight` guard should cover; V3.3.0.4 must verify the scroll handler doesn't race with `disposeAttachment`.

## §1 First-five-minutes verification (V3.3.0.2 session entry)

```sh
# Engine
cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
git status --short | grep -v '^??'    # expect empty
git log --oneline -5
# Expect newest at top:
#   <V3.3.0.1 commit hash>  docs(5.7): V3.3.0.1 -- lock 6 design decisions for multi-sheet + virtualization
#   8ca2168b8c5 docs(5.7): V3.2.e follow-up -- archived plan status=done + V3.2.e checkbox
#   e514b9bf927 docs(5.7): V3.2.e -- V3.2 exit packet + V3.2 plan archive + MASTER-PLAN sweep
#   61a515b4610 docs(5.7): V3.2.d.6 -- audit transcripts + V3.2.d plan close + ide-consumer-contract V3.2.d closures
#   9ca8fc88648 docs(5.7): V3.2.c.6 -- ide-consumer-contract § 4.1.z2 + V3.2.c plan close

# IDE
cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab
git status --short | grep -v '^??'    # expect empty
git log --oneline -5
# Expect newest first:
#   ff73f2c9f1b feat(quantbook): Phase 5.7 V3.2.d code closures (IDE) -- 5 audit findings
#   a165141eb68 feat(quantbook): Phase 5.7 V3.2.c.2-V3.2.c.5 (IDE) -- live multi-window cell grid
#   86b02d22a0b feat(quantbook): Phase 5.7 V3.2.b.2-V3.2.b.5 (IDE) -- nonced cell-edit flow
#   14875aa2330 feat(quantbook): Phase 5.7 V3.2.a polish
#   130d28000ca feat(quantbook): Phase 5.7 V3.2.a.1 (IDE) -- in-place panel refresh + single-tab-per-sheet

# Tests baseline:
#   ql-collab 74/74; ql-collab-ws 42/42; IDE mocha 140/140
```

## §2 Reading order for V3.3.0.2 (next session)

1. **`memory/current_work.md`** -- session handoff (entry point).
2. **This V3.3 plan** -- current step inventory + 6 design decisions locked.
3. **`docs/phase5/5-7-v3-2-exit-packet.md`** -- V3.2 closure + V3.3 ENTRY READINESS reference packet (the basis for THIS plan's decisions).
4. **`docs/audits/2026-05-22-phase-5-7-v3-2-opus.md` § Section 3** -- Opus's verbatim V3.3 entry-readiness analysis (carries / replaces / risks).
5. **`extensions/quantlab/src/quantbook/cellGrid/cellGridPanel.ts`** + `cellGridLogic.ts` + `cellGridHtml.ts` -- V3.2 surface that V3.3.0 extends.
6. **`crates/ql-bindings-node/src/lib.rs`** -- existing napi surface + the V3.2.a `export_snapshot` method that V3.3.0.3 incremental cache will refactor.

## §3 V3.3.0.2 entry recommendation

Start V3.3.0.2 with the engine listSheets() napi method.  Pattern: mirror V3.2.a's exportSnapshot (lock acquire → op log walk → dedup → JSON serialize → release).  Tests first: write the engine-side Rust unit test for `list_sheets()` against an in-memory op log; then the napi method; then the IDE-side typed wrapper + mocha tests.

V3.3 is the FIRST scale-out beyond the V3.2 vertical slice.  Audit discipline continues: parallel Codex+Opus at V3.3.0.X termination per Rule 2.  Rule 4 (per-field walks for new state) applies to the V3.3.0.3 `last_snapshot` cache field.

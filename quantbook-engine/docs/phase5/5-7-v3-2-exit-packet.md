---
title: Phase 5.7 V3.2 exit packet (cell-grid UI vertical slice)
date: 2026-05-22
status: ACTIVE -- Phase 5.7 V3.2 SHIPPED across V3.2.a + V3.2.a.1 + V3.2.b + V3.2.c + V3.2.d
ship_commit_range_engine: |
  V3.2.a: 355a3226f0a (engine napi `exportSnapshot`) -> 748c09194d9 (Cargo.lock fix for serde_json dep)
  V3.2.a docs sweep: 93277be4d7f -> a8c9b939c03 -> 4ce19d963f7
  V3.2.b.1 decision lock: ce5d697cb17
  V3.2.b.6 docs + plan close: 9cd9fd6f5b9
  V3.2.c.1 decision lock: 14b6ad1e932
  V3.2.c.6 docs + plan close: 9ca8fc88648
  V3.2.d.6 audit transcripts + closures docs: 61a515b4610
ship_commit_range_ide: |
  V3.2.a IDE typed wrapper + tests: 831c9f2bf37
  V3.2.a scaffold (webview + quantbookCellGrid command): fcfe9e91188
  V3.2.a.1 in-place refresh + single-tab-per-sheet: 130d28000ca
  V3.2.a polish (CSS readability): 14875aa2330
  V3.2.b.2-V3.2.b.5 nonced cell-edit flow: 86b02d22a0b
  V3.2.c.2-V3.2.c.5 live multi-window cell grid: a165141eb68
  V3.2.d code closures (5 findings, +8 mocha tests): ff73f2c9f1b
predecessor_exit_packet: docs/phase5/5-7-v2-exit-packet.md (V2 -- Transport binding)
v3_design_reference: docs/audits/2026-05-22-phase-5-7-v3-1-opus.md § Section 3 (Opus V3.2 entry-readiness analysis from V3.1.e audit)
audit_cycle_total_v3_2: |
  V3.2.a snapshot foundation (no per-step audit; folded into V3.2.d)
  V3.2.a.1 ergonomic refresh (no per-step audit; folded into V3.2.d)
  V3.2.b.1 decision lock (5 design decisions for cell-edit flow)
  V3.2.b.2-V3.2.b.6 nonced CSP + scripts ON + putValue/errorReply envelope (no per-step audit; folded into V3.2.d)
  V3.2.c.1 decision lock (7 design decisions for live multi-window propagation)
  V3.2.c.2-V3.2.c.6 collab attach + 1s pollRemote + V3.1.c reconnect reuse (no per-step audit; folded into V3.2.d)
  V3.2.d parallel Codex (Lane A) + Opus (Lane B) audit + 5 in-cycle code closures
  = 4 ship cycles + 1 cumulative 2-lane audit cycle = 5 cycles total
audit_transcripts_inventory_v3_2: |
  2 total in docs/audits/2026-05-22-phase-5-7-*:
  - V3.2.d: v3-2-codex.md (Lane A protocol/correctness, Q1-Q10)
  - V3.2.d: v3-2-opus.md (Lane B adversarial + V3.3 readiness, targets A-G)
  V3.2.a + V3.2.b + V3.2.c per-step audits intentionally skipped per the V3.2 plan
  (deferred to V3.2.d cumulative pass). Same pattern as V2.8 megaudit which
  caught 22 HIGHs invisible at per-batch level.
test_counts_at_v3_2_exit: |
  Engine workspace: 4472 / 0 baseline (V3.2 does not touch ql-collab core; verified at V2.5 ship gate, holds)
  ql-collab --features test-fixtures: 74 / 74
  ql-collab-ws: 42 / 42 (10 lib + 2 V3.1.a relay integration + 30 ws transport integration)
  ql-bindings-node Rust lib tests: 3 / 3 (V3.2.a adds 0 Rust lib tests; coverage is via IDE mocha)
  IDE quantbook mocha: 140 / 140
    (was 95 at V2 exit;
     +1 V2.9 round-trip;
     +1 V3.1.b multi-window round-trip;
     +1 V3.1.e Codex-L5 reconnect-mid-flight;
     +5 V3.2.a exportSnapshot snapshot;
     +5 V3.2.a HTML rendering;
     +18 V3.2.b.5 nonced cell-edit (HTML + parser + dispatcher);
     +6 V3.2.c.5 classifyPollTick + two-session round-trip;
     +8 V3.2.d [bad_argument] code symmetry + dispatcher type-guard
     = 140)
v3_2_rule_4_arc_count: |
  6 cumulative triggers (unchanged from V2 exit; V3.1.e + V3.2.a + V3.2.a.1
  + V3.2.b + V3.2.c + V3.2.d all yielded ZERO new triggers).  V3.2 is
  all-TypeScript except for the V3.2.a `CollabSession::export_snapshot` napi
  method which inherits the V2.4 `Arc<Mutex<CoreCollabSession>>` Send+Sync
  pinning.  No new Rust trait surface; no new negative-trait claim.
v3_3_readiness: |
  CONDITIONAL GO.  V3.2.d Lane B Opus identified 5 V3.3-entry items:
  3 must close pre-V3.3 (already shipped at V3.2.d: HIGH-1 cache mode-split
  + HIGH-2 IDE validator code symmetry; the third was a virtualization-
  library decision deferred to V3.3.0 entry plan).  V3.3 design decisions
  to lock at entry plan time (NOT here): virtualization library
  (clusterize.js vs react-window), multi-sheet UX (panel-per-sheet vs
  sheet-tabs-in-panel), listSheets() napi shape, persistence scope
  (V3.3 vs V3.4), optimistic-rendering revisit (still PESSIMISTIC?),
  push-API vs continued-1s-poll.
phase_5_8_readiness: |
  UNBLOCKED (since V2.8 cfg-gate closure).  V3.2 does not change the
  Phase 5.8 megaudit scope; V3.3+ work can run in parallel with Phase 5.8.
  Phase 5.8 should sweep the now-complete V1 + V2 + V3.1 + V3.2 surface.
---

# Phase 5.7 V3.2 -- Cell-Grid UI Vertical Slice Exit Packet

## Summary

Phase 5.7 V3.2 ships the **first product-user-visible surface** of the entire Phase 5.7 arc: a working cell-grid UI bound to a `CollabSession`, with click-to-edit + live multi-window propagation via the V3.1 multi-window relay infrastructure.  V1 shipped the engine + IDE binding; V2 bound the Transport surface; V3.1 added the multi-window demo (a periodic-append loop, not a real product surface); V3.2 turns the binding into a **grid widget** the user can actually interact with.

V3.2 took **4 ship cycles + 1 audit cycle = 5 cycles total** across two calendar days (2026-05-22).  Each sub-step (a/b/c) shipped without a per-step audit by design; V3.2.d is the cumulative pass.  This is a different cadence from V2 (which ran per-step audits) and matches the V2.8-megaudit insight that phase-level audits catch HIGHs invisible at per-step level.

### Highlights

- **First product-visible vertical slice.**  Three new VS Code commands surface the cell grid: `quantlab.quantbookCellGrid` (local-only, fast-start dev), `quantlab.quantbookCellGridRefresh` (in-place re-render), `quantlab.quantbookCellGridCollab` (live multi-window with auto-flush + 1s pollRemote).
- **Webview security: nonced CSP + scripts-on, no XSS surface.**  V3.2.b introduces the first scripts-on webview in the quantbook surface area.  CSP is `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';` with a 32-char alphanumeric nonce regenerated per render.  V3.2.d Opus Target B adversarial walks confirmed no XSS surface (escape-html covers `<>&"'`; createTextNode is one-way; selector-injection is Number()-coerced; title-attribute is plain text).
- **vscode-free split for testability.**  Three new files: `cellGridHtml.ts` (pure HTML builder), `cellGridLogic.ts` (vscode-free dispatcher + parser + classifier), `cellGridPanel.ts` (vscode lifecycle wrapper).  Mocha can drive HTML output + dispatcher behaviour without a vscode shim.
- **V3.1.b/V3.1.c orchestration reused verbatim.**  `connectOrSpawn` + `reconnectWithBackoff` are now exported from `multiWindowDemo.ts`; the cell-grid collab command uses the SAME try-connect-first / spawn-on-fail / race-retry ladder (V3.1.e Opus M2 / Codex L1 convergent closure preserved) AND the SAME 3-try 500/1000/2000ms reconnect chain (V3.1.c closure preserved).
- **V3.2.d audit caught 2 HIGHs invisible at per-step level.**  Same pattern as V2.8 megaudit.  HIGH-1 (cache mode-conflation -> PeerId-uniqueness violation in collab-then-collab) + HIGH-2 (IDE-side validator code symmetry); both closed in-cycle.
- **Rule 4 arc terminus stays at 6.**  Six cumulative triggers across V1+V2.3+V2.4+V2.5; V2.7 + V2.8 + V3.1.e + ALL V3.2 sub-steps contributed ZERO new triggers.

### What V3.2 deliberately did NOT do

V3.2 is the cell-grid V0.  Out of scope (kept for V3.3+):

- **Virtualized rendering.**  V3.2 does full HTML rebuild on every render.  Works at hundreds-of-cells scale; breaks at 10K+.  V3.3 must pick a virtualization library (Opus suggested clusterize.js as the leading candidate; final decision deferred to V3.3.0 entry plan).
- **Multi-sheet.**  One panel = one sheet, with `sheet` baked into the script's `SHEET` constant.  V3.3 needs either multi-sheet-per-panel (tabs) or sheet-selector UI + a `listSheets()` napi method.
- **Text / boolean / error cell editing.**  Cells of those variants can be RECEIVED via mergeBytes from peers but cannot be CREATED from JS — the V1 napi `appendPutValue` is `f64`-only.  V3.3+ adds `appendPutValueText` / `appendPutValueBool` napi bindings.
- **Optimistic rendering.**  V3.2 is pessimistic (input element stays until host confirms).  Localhost IPC is sub-millisecond so this is imperceptible; V3.x WAN exposure may revisit.
- **Push API for inbound observation.**  V3.2.c uses 1s `pollRemote` polling per V3.2.c.1 decision C2.  Push (engine-side `Transport::on_inbound_blob` callback hook into napi ThreadsafeFunction) is V3.x backlog -- needs new engine API + Rule 4 audit.
- **Per-cell "incoming" tint animation.**  V3.2.c.1 decision C5 deferred.  CSS-animation + snapshot-diff complexity not load-bearing for V3.2.c contract.
- **Persistent status bar item.**  V3.2.c.1 decision C4 used OutputChannel-only status reporting.  Persistent `vscode.window.createStatusBarItem` deferred to V3.x.
- **`rebuild_workbook` routing.**  V3.2 reads the local op log directly via `exportSnapshot`.  V3.3 may continue this (the snapshot shape is decoupled from the source); V3.4+ undo/redo + V3.5+ formula evaluation will need `rebuild_workbook`.
- **`.qbook` persistence.**  V3.2 has none.  V3.3 or V3.4 (decision deferred to V3.3.0 entry plan).
- **Undo/redo.**  V3.4 scope per V3.2 plan.  V3.2.c.6 § 4.1.z2 didn't list it in the deferred section initially; V3.2.d.6 added it.
- **Presence (who-edits-this-cell).**  V3.4 (Phase 5.6 V2 integration).
- **Two-window live UI smoke** in a real VS Code window pair.  Mocha covers HTML + dispatcher + parser + classifier + engine round-trip via LoopbackPair, but the actual cross-window WebSocket relay flow has NOT been smoke-tested at the OS level for V3.2.b / V3.2.c / V3.2.d.

## V3.2 commit ladder (cumulative)

Engine `feat/quantbook-engine`:

| Sub-step | Ship | Closure |
|---|---|---|
| V3.1 archive + V3.2 entry plan | `55a689a0797` | -- |
| V3.2.a engine `exportSnapshot` napi | `355a3226f0a` | -- |
| V3.2.a status updates + Cargo.lock + session-end audit sweep | `93277be4d7f` -> `a8c9b939c03` -> `748c09194d9` -> `4ce19d963f7` | -- |
| V3.2.b.1 5-decision lock | `ce5d697cb17` | -- |
| V3.2.b.6 docs + plan close | `9cd9fd6f5b9` | -- |
| V3.2.c.1 7-decision lock | `14b6ad1e932` | -- |
| V3.2.c.6 docs + plan close | `9ca8fc88648` | -- |
| V3.2.d.6 audit transcripts + closures docs + plan close | `61a515b4610` | -- |

IDE `feat/visualise-v1`:

| Sub-step | Commit |
|---|---|
| V3.2.a IDE typed wrapper + 5 snapshot mocha tests | `831c9f2bf37` |
| V3.2.a scaffold (webview + `quantlab.quantbookCellGrid` command + 5 HTML mocha tests) | `fcfe9e91188` |
| V3.2.a.1 in-place refresh + single-tab-per-sheet (activePanels Map; +0 mocha) | `130d28000ca` |
| V3.2.a polish (per-rule CSS readability) | `14875aa2330` |
| V3.2.b.2-V3.2.b.5 nonced cell-edit flow (+18 mocha tests; 108 -> 126) | `86b02d22a0b` |
| V3.2.c.2-V3.2.c.5 live multi-window cell grid (+6 mocha tests; 126 -> 132) | `a165141eb68` |
| V3.2.d code closures (5 findings; +8 mocha tests; 132 -> 140) | `ff73f2c9f1b` |

**Final HEADs:** engine `61a515b4610` / IDE `ff73f2c9f1b`.  Both repos tracked-clean at V3.2 exit.

## V3.2 surface contract

### New VS Code commands (`package.json` + `package.nls.json`)

| Command | Title | Mode | Purpose |
|---|---|---|---|
| `quantlab.quantbookCellGrid` | Quantbook: Open Cell Grid | Local-only | Fast-start dev / smoke.  Creates a fresh session with 5 sample PutValues; opens a CellGridPanel without a transport.  Edits commit locally but don't sync. |
| `quantlab.quantbookCellGridRefresh` | Quantbook: Refresh Cell Grid | Both | Iterates `localPanels` + `collabPanels` Maps; calls `render()` on each.  Surfaces `showInformationMessage` if no panels are open. |
| `quantlab.quantbookCellGridCollab` | Quantbook: Open Cell Grid (Collab) | Collab | Multi-window cell grid.  `connectOrSpawn` (try ws://127.0.0.1:7117 then spawn V3.1.a `relay-server` binary on fail).  Creates a session with peerId = `BigInt(process.pid)`.  Attaches transport + sets AutoFlushPolicy = OnAppend + starts 1s pollRemote loop. |

### New engine napi method (`ql-bindings-node`)

```ts
class CollabSession {
  // V3.2.a (2026-05-22): JSON-serialized snapshot for the IDE grid widget.
  exportSnapshot(sheet: number): string;  // u16 sheet; returns JSON
}
```

Return shape (`snapshot_format_version = 1`):

```json
{
  "snapshot_format_version": 1,
  "sheet": <u16>,
  "entries": [
    { "row": <u32>, "col": <u32>, "value": <CellValueJson> },
    ...
  ]
}
```

Where `CellValueJson` is a tagged-union mirroring `ql_oplog::CellWireValue`:

- `{ "kind": "number",  "value": <f64> }`
- `{ "kind": "boolean", "value": <bool> }`
- `{ "kind": "text",    "value": <string> }`
- `{ "kind": "error",   "value": <string> }`
- `{ "kind": "pending" }`

Entries are sorted by `(row, col)` for deterministic output.  Iteration semantics: last-write-wins per `(row, col)` over the entire local op log.  Errors emit `[bad_argument]` prefixed messages (V2.7 contract).

### New IDE types (`extensions/quantlab/src/quantbook/types.ts`)

```ts
type QuantbookCellValue =
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'text'; value: string }
  | { kind: 'error'; value: string }
  | { kind: 'pending' };

interface QuantbookCellSnapshot {
  readonly snapshot_format_version: 1;
  readonly sheet: number;
  readonly entries: ReadonlyArray<{
    readonly row: number;
    readonly col: number;
    readonly value: QuantbookCellValue;
  }>;
}
```

### New IDE module files (vscode-free split)

| File | Surface |
|---|---|
| `cellGrid/cellGridHtml.ts` | `buildHtml(snapshot, { nonce? })` + `formatCellValue(value)` + `CellGridHtmlOptions` interface.  Pure functions; no vscode import. |
| `cellGrid/cellGridLogic.ts` | `PutValueRequest` + `ErrorReplyMessage` envelope types; `parseCellRawInput(raw: string): number`; `dispatchIncomingMessage(raw, deps)`; `classifyPollTick(session): PollTickResult`; `PollTickResult` tagged-union ({idle, merged, transportClosed, error}); `DispatchDeps` interface.  No vscode import. |
| `cellGrid/cellGridPanel.ts` | `CellGridPanel` class with `show(context, session, sheet, attachment?)` factory + `refreshAll()` static + `render()` + `handleIncoming()` + `wireAttachment()` + `tickPollRemote()` + `handleTransportClosed()` + `disposeAttachment()`.  `CollabAttachment` interface.  Owns vscode lifecycle. |

### New IDE wrapper functions (`extensions/quantlab/src/quantbook/session.ts`)

```ts
// V3.2.a: typed wrapper around exportSnapshot napi.  Parses JSON + validates
// snapshot_format_version === 1; throws [bad_argument] on drift.
function exportCellSnapshot(session: CollabSessionInstance, sheet: number): QuantbookCellSnapshot;

// V3.2.d HIGH-2 closure (2026-05-22): all 4 validator throws prefixed with
// [bad_argument] for parseQuantbookError code-routing symmetry.
function appendPutValueValidated(session, sheet, row, col, value): void;
```

### Webview message envelope (V3.2.b.1 decision B1)

Outgoing (webview -> extension host):

```ts
{ type: 'putValue', sheet: number, row: number, col: number, rawInput: string }
```

Incoming (extension host -> webview):

```ts
{ type: 'errorReply', sheet, row, col, code: QuantbookErrorCode, message: string }
```

Unknown `type` values from EITHER direction are logged + ignored.  Success path is a full HTML rebuild via `panel.webview.html = buildHtml(snapshot, { nonce })` -- not a message.

## V3.2 decision locks

### V3.2.b decision locks (V3.2.b.1 at engine `ce5d697cb17`)

- **B1 Message envelope shape.**  `putValue` out / `errorReply` in.  `rawInput` is the literal user-typed string; host parses + validates + commits.  Unknown types logged + dropped both directions.
- **B2 Nonce derivation.**  32-char alphanumeric, regenerated per `render()` call.  Matches `LoginWebviewPanel._nonce` pattern.  NOT `crypto.randomUUID()` (UUID dashes need CSP escaping).
- **B3 ErrorReply UX.**  Per-cell `.cell-edit-error` red border + `title="[code] message"` tooltip.  Added by webview script on errorReply, NOT by re-rendering (keeps the user's input element visible for correction).
- **B4 Pessimistic rendering.**  Input element stays until host confirms via refresh (success path: full re-render) or errorReply (failure path: decorate + keep input).  Localhost IPC is sub-ms so no perceptible lag.
- **B5 No remote auto-refresh in V3.2.b.**  Remote-peer ops require V3.2.c; V3.2.b users use the V3.2.a.1 Refresh command.

### V3.2.c decision locks (V3.2.c.1 at engine `14b6ad1e932`)

- **C1 Attach model.**  REUSE V3.1.b `connectOrSpawn` verbatim (try-connect, spawn-on-fail, race-retry on spawn loss).  NEW command `quantlab.quantbookCellGridCollab` uses this.  Keep V3.2.a `quantlab.quantbookCellGrid` as local-only.
- **C2 Inbound model.**  1-second `pollRemote()` polling.  Push API deferred to V3.x.
- **C3 Re-render granularity.**  Coarse: `pollRemote() > 0` triggers full `this.render()` rebuild.  Per-cell diffing deferred to V3.3 virtualization.
- **C4 Status indicator.**  OutputChannel log lines + reconnect-exhaustion `showWarningMessage('Restart Cell Grid (Collab)')`.  No persistent `createStatusBarItem` (V3.x).
- **C5 Per-cell incoming tint.**  DEFERRED to V3.x polish.
- **C6 Reconnect.**  REUSE V3.1.c `reconnectWithBackoff` (3 tries at 500/1000/2000 ms).  On exhaustion: dispose panel + kill spawned relay + warning + Restart action.
- **C7 Helper sharing.**  EXPORT `connectOrSpawn` + `reconnectWithBackoff` from `multiWindowDemo.ts` (single-file home; V3.2.d may revisit extracting to a third file).  V3.2.d audit Opus reviewed + agreed to keep as-is until a third consumer arrives.

## V3.2.d audit findings + closure-vs-defer rationale

V3.2.d ran a 2-lane parallel audit (Codex Lane A protocol/correctness Q1-Q10 + Opus Lane B adversarial targets A-G).  Total: **2 HIGH + 7 MEDIUM + 9 LOW + V3.3 entry-readiness packet.**  Transcripts at `docs/audits/2026-05-22-phase-5-7-v3-2-{codex,opus}.md`.

### Closed in V3.2.d (5 items, all at IDE commit `ff73f2c9f1b`)

| # | Finding | Source(s) | Closure |
|---|---|---|---|
| 1 | **activePanels cache conflated local + collab** | Codex M2 + Opus HIGH-1 (cross-lane convergent; adjudicated HIGH) | Split into `localPanels` + `collabPanels` Maps; collab-then-collab now reveals existing + `showInformationMessage` (no duplicate session under same PID); `refreshAll` iterates both maps. |
| 2 | **IDE-side validators bypassed `[bad_argument]` prefix** | Codex L1 + Opus HIGH-2 (cross-lane convergent; adjudicated MEDIUM) | Prefix all 4 `appendPutValueValidated` throws with `[bad_argument]`; add dispatcher-side `typeof req.rawInput !== 'string'` runtime guard. |
| 3 | **`transport_closed` during edit doesn't flush pending** | Codex M1 | `handleTransportClosed` checks `session.hasPendingFlush()` after `attachTransport(fresh)`; calls `flushDeltaToTransport()` if true. |
| 4 | **`tickPollRemote.merged` no try/catch** | Codex M3 | Wrap `render()` in try/catch; on `bad_argument` / `session_oplog` (fatal), dispose panel + show Restart; on transient codes, skip the tick. |
| 5 | **postMessage to disposed/hidden panel silently lost** | Opus M1 | Track `_disposed: boolean` flag set in `onDidDispose` BEFORE `disposeAttachment`; `onError` falls back to `vscode.window.showWarningMessage` if disposed. |

### Deferred to V3.x with rationale (4 items)

| # | Finding | Source | Rationale |
|---|---|---|---|
| 6 | **Reconnected transport leaked when panel disposed mid-await** | Opus M2 | Not a strict leak; V8 GC eventually collects + Rust-side Drop releases the WebSocket connection.  Non-deterministic but bounded.  Promote to HIGH if reconnect churn becomes measurable in V3.3+. |
| 7 | **`formatCellValue(NaN)` displays `'NaN'`** | Opus M3 | Unreachable through V1+ API (engine's `appendPutValue` validator rejects non-finite f64).  Only reachable via mergeBytes from a pre-V1 peer (doesn't exist).  V3.x polish: route to `'#NUM!'` like Excel. |
| 8 | **`exportSnapshot` lock-hold scales linearly with op log size** | Opus M4 | V3.3 scale problem (100K+ ops).  V3.2 scale (~thousands) holds lock sub-millisecond.  V3.3 incremental-cache decision (Option A in Opus § V3.3 entry-readiness) addresses. |
| 9-17 | **9 LOW items: observability + polish** | Codex L1/L2 + Opus L1/L2/L3/L4/L5/L6/L7 | All non-load-bearing.  See audit transcripts for individual rationale.  Includes: errorReply selector log on no-match, sheet-mismatch UX surface, JSON.parse bracket prefix, websocketConnect app-layer timeout, sample-data observability, exportSnapshot u16 ToUint32 hygiene, cancel-path unit test gap. |

### Codex deferred (4 items, separate from above MEDIUM/LOW)

| # | Finding | Rationale |
|---|---|---|
| 18 | **Tighten inline style CSP** | Codex D1.  `style-src 'unsafe-inline'` could move to nonced or `asWebviewUri`-loaded.  Not load-bearing (dynamic content is escaped).  V3.x polish. |
| 19 | **Decide which non-transport poll errors are fatal** | Codex D2.  Today `tickPollRemote.error` path logs + skips uniformly.  V3.x should taxonomize. |
| 20 | **Preserve input after Enter if slow failure arrives after blur** | Codex D3.  Race window narrow at localhost; revisit at WAN exposure. |
| 21 | **Keep relay constants configurable** | Codex D4.  Hardcoded port 7117 is V3.x productionization. |

## Rule 4 arc state at V3.2 exit

**Cumulative arc terminus: 6** (unchanged from V2 exit).

Triggers (3 in V1, 1 each at V2.3 / V2.4 / V2.5):

1. V1 megaudit -- napi-rs `Reference` Sync confusion
2. V1 megaudit -- `CollabSession` !Send vs napi-class Send
3. V1 megaudit -- `LoopbackTransport` channel ownership
4. V2.3 -- napi-rs `Reference` exclusivity vs async re-entry (resolved by V2.4 Arc<Mutex>)
5. V2.4 -- docstring drift on `CollabSession: Send + Sync` after refactor
6. V2.5 -- false `FlushAck: Send + !Sync` claim (per-field walk showed Send + Sync auto-impl)

**Zero new triggers in V3.2.a + V3.2.a.1 + V3.2.b + V3.2.c + V3.2.d.**  V3.2 is all-TypeScript except for the V3.2.a `CollabSession::export_snapshot` napi method which inherits the V2.4 `Arc<Mutex<CoreCollabSession>>` Send+Sync pinning (compile-asserted at `crates/ql-bindings-node/src/lib.rs`).  No new Rust trait surface; no new negative-trait claim.

V3.2.d Opus Lane B Target F (Rule 4 sweep) explicitly verified this: serde_json dep adds no extern "C" symbols; attachmentState 7-field walk shows no thread-safety concerns under Node.js single-threading; `CollabAttachment` interface is `readonly`.

## V3.3+ backlog (consolidated)

From the V3.2 arc:

| Source | Item | Priority |
|---|---|---|
| V3.2.c.1 C4 | Persistent `vscode.window.createStatusBarItem` for Cell Grid (Collab) status | V3.x polish |
| V3.2.c.1 C5 | Per-cell "incoming" tint animation on merged-remote ops | V3.x polish |
| V3.2.c.1 C2 | Push API (engine `Transport::on_inbound_blob` callback -> napi ThreadsafeFunction) | V3.x; needs Rule 4 audit |
| V3.2.d Codex M2 | Cell-grid panel registry semantics docs update (covered by HIGH-1 closure) | (closed) |
| V3.2.d Opus M2 | Explicit close of `fresh` transport in dispose-during-reconnect path | V3.x or V3.3 |
| V3.2.d Opus M3 | `formatCellValue(NaN)` -> `#NUM!` Excel-style | V3.x polish |
| V3.2.d Opus M4 | `exportSnapshot` incremental cache (Option A in V3.3-readiness) | V3.3 (required pre-virtualization ship) |
| V3.2.d Codex/Opus 9 LOWs | Misc observability + polish | V3.x |
| V3.2.d Codex D1 | Tighten inline style CSP | V3.x polish |
| V3.2.d Codex D2 | Taxonomize non-transport poll errors | V3.x |
| V3.2.d Codex D3 | Race window after Enter -> blur | V3.x (revisit at WAN) |
| V3.2.d Codex D4 | Relay constants -> config | V3.x productionization |

Inherited from V3.1.e:

| Source | Item | Priority |
|---|---|---|
| V3.1.e Codex M1 | PID-only PeerId collision migration | V3.x (defensive UUID-derived peerId) |
| V3.1.e Codex L3 | AtomicUsize conn_id wrap at 4B+ conns on relay | V3.x theoretical |
| V3.1.e Codex L4 | (closed at V3.1.e + carried into V3.2.c.3 spawned-relay predicate) | (closed) |
| V3.1.e Opus L1-L9 | 8 of 9 LOWs | V3.x polish |

Inherited from V2 exit packet:

| Source | Item | Priority |
|---|---|---|
| V2.7 backlog | Structured `transportLastErrorInfo()` accessor | V3.x |
| V2 backlog | `willFlushSend` helper | V3.x |
| V2 backlog | `LoopbackTransport.close` binding | V3.x |
| V2 backlog | `HandshakeFailed` test fixture | V3.x |
| V2 backlog | `CollabSessionError::Transport(_)` origin tracking | V3.x |
| V2 backlog | `@napi-rs/cli` publish pipeline | V3.x productionization |

Phase 5.7 V3 product scope (waiting on V3.3+):

- **V3.3 multi-sheet + virtualization** (see "V3.3 ENTRY READINESS" section below).
- **V3.4 undo/redo** (UndoGroupGuard RAII translation; engine has the surface, IDE needs the binding).
- **V3.4 presence** (PresenceState + sweep_presence integration with the grid widget's collaborator-cursor UX).
- **V3.5 `rebuild_workbook` wiring** (Phase 5.3 production visibility -- formula recompute + name resolution).
- **V3.5+ `.qbook` persistence** (save/load; Tier D3 envelope is ready since D-1 ship 2026-05-20).
- **V3.5+ full Op enum** (beyond `PutValue`).

Phase 5 megaudit (Phase 5.8):

- **UNBLOCKED.**  Should sweep the now-complete V1 + V2 + V3.1 + V3.2 surface.  Can run in parallel with V3.3+ work.  ~4-6 days.

## V3.3 ENTRY READINESS

Copied verbatim from `docs/audits/2026-05-22-phase-5-7-v3-2-opus.md` § "V3.3 ENTRY READINESS analysis" for easy reference.

### Required pre-V3.3 entry

- [x] **HIGH-1 single-tab cache** -- closed at V3.2.d.  Breaks at multi-sheet scale; now mode-split.
- [x] **HIGH-2 dispatcher error-code symmetry** -- closed at V3.2.d.  Multi-sheet panel will be a heavier consumer of the structured-error contract.
- [ ] **Decide virtualization library** -- clusterize.js vs react-window vs other.  Locked in the V3.3.0 entry plan, NOT here.
- [ ] **Add `CollabSession.listSheets()` napi method** -- V3.3.0 ship.  Today V1 binding has no sheet enumeration.
- [ ] **Add `exportSnapshot` incremental cache** (Option A) OR defer until first profiling-justified ship of virtualized grid.

### Deferred-acceptable for V3.3 entry

- MEDIUM-1 (postMessage delivery contract via `_disposed` guard -- already shipped at V3.2.d).
- MEDIUM-2 (reconnect-disposal leak) -- noisy but not load-bearing.
- MEDIUM-3 (NaN cell display) -- unreachable through V1+ API paths.
- MEDIUM-4 (lock-hold time) -- close at first profiling complaint via Option A above.
- All LOW items.

### V3.3 scope decisions to lock at V3.3.0 entry plan

1. **Renderer architecture:** virtualized library + diffing strategy.  Opus suggests clusterize.js (UMD-shippable, no bundler) as the leading candidate; react-window is the heavier alternative.
2. **Multi-sheet UX:** panel-per-sheet vs sheet-tabs-in-panel.  Opus recommends panel-per-sheet for V3.3 (matches V3.2 full-rebuild model; incremental updates apply within a sheet).
3. **`listSheets` API:** napi shape + how sheet IDs are surfaced (u16 only, or u16 + display name from a future `SheetMetadata` Op).
4. **Persistence scope:** V3.3 includes `.qbook` save/load OR V3.4?
5. **Optimistic rendering:** V3.3 still keeps PESSIMISTIC (decision B4)?  Slow-network case (ngrok/tailscale) may surface at V3.3; revisit.
6. **Push notification API:** V3.2.c § C2 deferred to V3.x.  V3.3 entry should decide: keep 1s poll, or invest in the napi push surface.

### V3.3 risk summary (from Opus)

- **R-V3.3-1 Virtualization integration risk:** MEDIUM.  New library + bundling step.  Mitigation: pick UMD-shippable lib.
- **R-V3.3-2 exportSnapshot incremental cache invariants:** MEDIUM.  Cache must stay in sync with op log under undo (V3.4+); design with V3.4 in mind.
- **R-V3.3-3 listSheets enumeration consistency:** LOW.  Op log has the data; walk + dedup.
- **R-V3.3-4 Persistence schema versioning:** LOW (V3.5 problem).  D-1 ship established the Tier D3 envelope.
- **R-V3.3-5 PeerId reuse under restart:** MEDIUM.  Carryforward from V3.1.e Codex M1 + V3.2.d HIGH-1 (collab-then-collab same PID -- closed by mode-split, but the cross-restart case remains).

## Audit transcript inventory (25 total)

In `docs/audits/2026-05-22-phase-5-7-*`:

| Phase | Files |
|---|---|
| V1 | `v1-codex.md`, `v1-opus.md`, `v1-megaudit-codex.md`, `v1-megaudit-opus-a-docs.md`, `v1-megaudit-opus-b-v2.md` (5) |
| V2.1-V2.4 | `v2-{1,2,3,4}-{codex,opus}.md` (8) |
| V2.5+V2.6 | `v2-5-plan-review-codex.md`, `v2-5-codex.md`, `v2-5-opus.md` (3) |
| V2.7 | `v2-7-codex.md`, `v2-7-opus.md` (2) |
| V2.8 megaudit | `v2-megaudit-codex.md`, `v2-megaudit-opus-a-docs.md`, `v2-megaudit-opus-b-v3.md` (3) |
| V3.1.e | `v3-1-codex.md`, `v3-1-opus.md` (2) |
| V3.2.d | `v3-2-codex.md`, `v3-2-opus.md` (2) |

## Test counts at V3.2 exit

- ql-collab `--features test-fixtures`: **74 / 74**
- ql-collab-ws: **42 / 42** (10 lib + 30 ws transport integration + 2 V3.1.a relay integration)
- ql-bindings-node Rust lib tests: **3 / 3**
- Engine workspace baseline: **4472 / 0**
- IDE quantbook mocha: **140 / 140**

Mocha breakdown:
- V2 baseline: 95
- V2.9 round-trip: +1 -> 96
- V3.1.b multi-window round-trip: +1 -> 97
- V3.1.e Codex-L5 reconnect-mid-flight: +1 -> 98
- V3.2.a exportSnapshot snapshot: +5 -> 103
- V3.2.a HTML rendering: +5 -> 108
- V3.2.b.5 nonced cell-edit (HTML/CSP/data-attrs + parser + dispatcher): +18 -> 126
- V3.2.c.5 classifyPollTick + two-session loopback round-trip: +6 -> 132
- V3.2.d [bad_argument] code symmetry + dispatcher type-guard: +8 -> 140

## Honest gaps at V3.2 exit

1. **No V3.2 live UI smoke.**  Mocha covers HTML output + dispatcher behaviour + parser + classifier + engine round-trip (via LoopbackPair), but the actual cross-window WebSocket relay flow + click-to-edit + reconnect-UX in live VS Code is unverified at the OS level.  Per CLAUDE.md, stated explicitly here.  A 30-minute manual smoke (build engine cdylib with `--features test-fixtures`; launch VS Code dev; open 2 windows; run `quantbookCellGridCollab` in each; observe cross-window propagation) would close this.

2. **2 audit transcripts only** (vs the V2.8 megaudit's 3 lanes).  V3.2.d folded the docs-readiness lane into Opus Lane B since V3.2 hadn't shipped a full exit packet to audit AT THE TIME of the audit.  THIS exit packet is now the docs that future audits (Phase 5.8 megaudit) can sweep.

3. **V3.2.b.4 AutoFlushPolicy wiring DEFERRED.**  V3.2.b's `quantlab.quantbookCellGrid` command creates an unattached session; edits don't sync to peers.  V3.2.c's `quantlab.quantbookCellGridCollab` is the workaround (it wires AutoFlushPolicy via `wireAttachment`).  V3.2.b plan §V3.2.b.4 is marked [deferred] not [x].

4. **Single-tab-per-sheet cache split** (HIGH-1 closure) **doesn't address cross-restart PID reuse.**  If the OS reuses a PID after VS Code restart, a new collab session may collide with a peer's persisted state.  V3.1.e Codex M1 + V3.3 risk R-V3.3-5 carry this forward; defensive UUID-derived peerId is the V3.x fix.

5. **`refreshAll` count semantics.**  The V3.2.d HIGH-1 closure makes `refreshAll` iterate both Maps + return their combined count.  If a user has 1 local + 1 collab panel on the same sheet, `refreshAll()` returns 2 (both refreshed) -- which is correct, but the existing `quantlab.quantbookCellGridRefresh` command's information-message text says "Refreshed N cell-grid panel(s)" without distinguishing modes.  Cosmetic.

## Next-phase recommendation

V3.2 is **fully shipped**.  The recommended next move is the **V3.3.0 entry plan** following the V3.2 entry-plan pattern (locked design decisions BEFORE coding).  Alternative: Phase 5.8 megaudit (unblocked since V2.8; could run before V3.3 to sweep V1+V2+V3.1+V3.2 cumulatively and identify any cross-phase findings).

If picking V3.3.0:

1. Read this exit packet + `docs/audits/2026-05-22-phase-5-7-v3-2-opus.md` § "V3.3 ENTRY READINESS analysis" (the basis for V3.3.0's design decisions).
2. Draft `quantbook-engine/.plans/_active.md` V3.3 entry plan with 6 decision items locked at entry (see "V3.3 scope decisions" above).
3. V3.3.0 = scaffold (clusterize.js or alternative + listSheets napi + sheet-tabs-in-panel).
4. V3.3.1+ = incremental rendering + persistence + undo/redo.
5. V3.3.X audit at phase termination.

If picking Phase 5.8 megaudit first:

1. Read all 25 V1+V2+V3.1+V3.2 audit transcripts as priors.
2. Draft a 3-lane megaudit prompt (Codex + Opus-A docs + Opus-B forward-looking) sweeping the cumulative Phase 5.7 surface.
3. Cross-lane convergent HIGHs MUST close in-cycle.
4. Phase 5.8 closure ships an exit packet at `docs/phase5/phase-5-megaudit-exit-packet.md` (or similar).

---

V3.2 SHIPPED.  Phase 5.7 V1 + V2 + V3.1 + V3.2 surface is now complete + audited.

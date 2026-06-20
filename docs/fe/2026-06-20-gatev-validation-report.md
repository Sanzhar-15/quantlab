# GATE-V — Validation & Perf (first pass)

**Date:** 2026-06-20 (w101) · **Branch:** IDE `fe/sheet-tabs` @ `dce4c20a92f` · engine `feat/quantbook-engine` @ `d4b9a47da8f`
**Owner of this pass:** automated/headless lanes. **Owner of the GUI half:** operator (see Part C).

> GATE-V is the locked lead of `v1-rebaseline-sequence.md`: *validation before more feature
> breadth.* It has four parts: (A) measure the DoD #4 perf contract, (B) a `.qbook` data-loss
> round-trip pass, (C) GUI-smoke the ~16-wave backlog, (D) the R2 render bakeoff. Parts A and B
> are fully automatable and were run this session. Parts C and D need the live Electron webview —
> this report hands the operator a grounded, checkable runbook for them.

---

## Headline

| Part | What | Result |
|---|---|---|
| **B — Data-loss** | `.qbook` full-fidelity round-trip through the production single-file path | ✅ **PASS** — every v11 field survives; new permanent regression guard landed |
| **A — Perf: bulk** | 25M-cell SIMD recalc (DoD #4 <100ms) | ✅ **3.46 ms** (29× under) |
| **A — Perf: edit (small)** | 10k-chain single edit (DoD #4 <15ms) | ✅ **9.68 ms** |
| **A — Perf: edit (at scale)** | **single edit on a 1M-cell grid** (DoD #4 <15ms) | ✅ **~18 µs** (set_value ~8.7µs + recompute ~9.5µs) — was mis-measured as ~106ms (a benchmark **drop artifact**, not the edit op; see Finding F-1, corrected w103) |
| **C — GUI smoke** | ~16-wave interactive backlog | ⏳ operator-manual (runbook below) |
| **D — R2 bakeoff** | Canvas2D-vs-GPU render gates + 60fps scroll | ⏳ operator-manual (`Quantbook: Open Render Bench`) |

**Bottom line:** persistence is solid; the SIMD bulk path is far under budget; and — **after the w103
correction** — interactive edit latency holds with enormous margin: a single edit on a million-cell
grid is **~18 µs** (set_value ~8.7µs + recompute_dirty ~9.5µs), ~820× under the 15ms budget. The
original w101 ~106ms reading was a criterion
measurement artifact (the bench dropped the 1M-cell workbook inside the timed region), **not** an
O(graph) engine cost. The edit path is O(dirty-set). See Finding F-1 below for the full correction.

---

## Part A — Perf contract (DoD #4)

DoD #4: *25M-cell recalc < 100ms; single edit recalc < 15ms; 60fps scroll.*

### Measured (engine benches, release, Mac/orbstack aarch64)

Run: `mac zsh -lc 'export PATH=$HOME/.cargo/bin:$PATH && cd <engine> && cargo bench -p <crate> --bench <name> --locked'`

| Bench | Scenario | Median | DoD target | Verdict |
|---|---|---|---|---|
| `ql-exec og02_mul2` | 25M-cell `=A*2` **SIMD kernel** bulk | **3.46 ms** | <100ms | ✅ (kernel only — see caveat) |
| `ql-exec a3_10k_dirty_recompute` (cold) | 10k chain, edit head, full incremental recalc | **9.68 ms** | <15ms | ✅ |
| `ql-exec a3_10k_dirty_recompute` (idempotent) | 10k chain, VEQ short-circuit | **4.04 ms** | — | ✅ |
| `ql-calcgraph region_split_merge` (Phase-0) | 25M-cell dirty propagation, 10k edits | **42 ms** | <50ms | ✅ |
| `ql-exec gatev_recalc_contract` (w101, BUGGY) | `set_value`, 1 cell, 1M grid — **drop timed inside closure** | ~103–117 ms | <15ms | ❌ artifact (not the op) |
| `ql-exec gatev_recalc_contract` **(w103 CORRECTED)** | **`set_value`, 1 cell, 1M grid** (drop deferred) | **~8.7 µs** | <15ms | ✅ |
| `ql-exec gatev_recalc_contract` **(w103 CORRECTED)** | **`recompute_dirty`, 1 dependent, 1M grid** (drop deferred) | **~9.5 µs** | <15ms | ✅ |
| `ql-exec gatev_recalc_contract` **(w103 CORRECTED)** | cold full recalc, 100k chain, `recompute_all` | **~160 ms** | (informational) | — genuine full-eval (F-2); unchanged by the drop fix, confirming the µs collapse is not dead-code elision |

> A full interactive single edit runs **both** sub-ops back to back: `set_value` (~8.7µs) + `recompute_dirty`
> (~9.5µs) ≈ **~18µs**, ~820× under the 15ms DoD #4 budget. (Production is if anything faster: the IDE's
> persistent `PlanCache` means `recompute_dirty` re-uses the bound plan instead of re-planning as the
> fresh-`with_graph` bench does.)

### Honesty caveats (why the NEW bench was added)

- `og02_mul2` times **only the SIMD `mul_scalar` kernel** over preallocated chunks — not the full
  parse + Tarjan + evaluate path. It validates the *architectural bet* (homogeneous region fast-path),
  not a realistic heterogeneous recalc.
- `a3_10k` is a **10k chain** — too small to expose any per-call cost that scales with graph size.
- The NEW `gatev_recalc_contract` bench closes both gaps with the real `recompute_dirty` /
  `recompute_all` API at 1M / 100k scale.

### ✅ Finding F-1 — CORRECTED (w103, 2026-06-20): the ~106ms was a benchmark drop artifact

> **w101 originally filed F-1 as HIGH:** "edit latency scales with GRAPH size, not dirty-set size —
> ~106ms single edit on 1M cells; O(graph) per-call cost paid on every interactive edit; recommend a
> dedicated engine perf wave." **w103 took that wave, root-caused it, and found the premise was wrong.**
> The finding is preserved verbatim below the line for the record; the correction is here.

**What was actually happening.** The w101 `gatev_recalc_contract` benches took the 1M-cell `Workbook` +
`CalcgraphSession` *by value* in the `iter_batched` routine closure and returned `()`. `criterion`
excludes the **setup** closure's time but **times the routine body — including the drop of anything the
closure owns and lets fall out of scope**; it only *defers* the drop of the value the routine
**returns**. So the benches measured `(tiny edit op) + (drop of the workbook (1M literal + 1M formula
cells) + its ~1M-node graph)` — only formula cells become graph nodes; the literals live in the
`cell_to_formulas` reverse map. That drop is millions of deallocations (per-node adjacency `Vec`s,
formula `Arc<str>`s, the cell/dep HashMaps) ≈ ~100ms — which is exactly why `set_value`-only ≈
`recompute_dirty`-only ≈ combined (all
three timed the *same* drop; the w101 "first op pays O(graph)" reconciliation was an artifact of that).

**The fix + the proof (same machine, w103).** The three bench closures now **return the owned
`(wb, graph, reg)`** so criterion drops them outside the timed region. The op stays byte-identical:

| Bench (1M-cell grid) | w101 (drop timed) | w103 (drop deferred) | DoD #4 |
|---|---|---|---|
| `set_value`, 1 cell | 117.17 ms | **8.74 µs** | <15ms ✅ |
| `recompute_dirty`, 1 dependent | 115.15 ms | **9.46 µs** | <15ms ✅ |
| `recompute_all`, 100k chain (control) | 166.62 ms | **159.75 ms** | informational |

(A full interactive edit = `set_value` + `recompute_dirty` ≈ **~18µs**, ~820× under the 15ms budget.)

The `recompute_all` control is the key: it **stayed ~160ms** after the same drop-deferral fix, proving
the µs collapse on the two edit benches is the drop leaving the timer — **not** dead-code elimination
of the op (if the compiler had elided the work, the control would have collapsed too; it didn't).

**Why the engine was already correct.** The single-cell-edit path is O(dirty-set), not O(graph) — traced
end to end: `set_value` → `on_set_value` → `mark_dirty_from_cell_write` (address-keyed lookups; empty
stripes / aggregate cache for a plain `=A*2` grid; 1-step BFS) → `schedule_dirty` (drains only the dirty
set) → `schedule_with_supplemental` (Tarjan over the **dirty subset only**, `dirty.contains` filtering
every child) → evaluate the one dirty formula. Every primitive (`cell_address_for`, `cell_node_for`,
`Graph::node`, `candidates_for_cell`) is O(1). Independently adversarially verified.

**No production analog.** The IDE holds a **persistent** `WorkbookSession` (`crates/ql-exec/src/
session.rs`: owns `workbook` + `graph` + `PlanCache`; napi `Arc<Mutex<…>>` per file). Per edit it only
rebuilds the borrow-wrapper `WorkbookRuntime` (`with_session_state`, a pure struct constructor — no
scan, no lazy init); the 1M-cell workbook is dropped **once at file close, never per edit**. So the
w101 "~100ms paid on every interactive edit" claim has **no production path** — the artifact was
benchmark-only.

**Severity: NONE** (was HIGH). DoD #4's single-edit budget holds with ~820× margin (~18µs vs 15ms). **No engine
change shipped or needed.** Guards landed: (1) the corrected bench (`gatev_recalc_contract`, drop
deferred — wall-clock observability + a header comment so the pitfall is not reintroduced); (2) a
deterministic CI test `crates/ql-exec/tests/gatev_edit_latency_contract.rs` asserting a single-cell edit
recomputes exactly **one** dependent regardless of grid size (the O(dirty-set) invariant — CI-safe, no
wall-clock flakiness).

<details><summary>Original w101 F-1 text (preserved for the record — superseded by the correction above)</summary>

> A single-cell edit (exactly one dependent recomputed — asserted `attempted == 1`) on a 1,000,000-cell
> grid took ~106ms via `recompute_dirty` … concluded a per-runtime-attachment, first-graph-operation
> O(graph) cost paid on every interactive edit; recommended a dedicated engine perf wave to make
> `recompute_dirty` O(dirty-set). **[w103: the ~106ms was the in-closure drop of the 1M-cell structures;
> the full edit is ~18µs (set_value + recompute, ~9µs each) and the path was already O(dirty-set).]**

</details>

### Not measured here (GUI-only)

- **60fps scroll** — needs the live webview. Covered by Part D (the render bench's SCROLL scenario).

---

## Part B — Data-loss / persistence validation ✅

### What was tested

A new engine integration test — `crates/ql-io/tests/gatev_qbook_full_fidelity.rs` — builds ONE
workbook populating **every v11 persisted field family at once** and round-trips it through the
**production single-file `.qbook` path** (the path the IDE CustomEditor actually saves through):

- 3 sheets; all value variants incl. a unicode-heavy string (accents, emoji, RTL, combining mark);
  local + **cross-sheet** formulas (text verbatim).
- Workbook-scoped names (all 4 target kinds: Constant / Cell / Range / Formula) **and** sheet-scoped
  names (same text `"Rate"` on two sheets → two distinct targets).
- Custom number format + overlay binding; rich cell styles (every border edge + font attrs + fill +
  text-color) + overlay; **a single cell carrying a text value + a format overlay + a style overlay
  simultaneously** (cross-field interaction the isolated unit tests never mix).
- Structured table with totals functions + stable column ids; non-adjacent hidden rows (v11);
  non-default date system (1904) / reference mode (R1C1) / locale (de).

### Why this was the gap

Per-field round-trip *is* covered by `qbook_format.rs` unit tests — but each family **in isolation**
and through the **directory** path. The single-file container path only had H1's 4-field smoke. This
is the first end-to-end "does a realistic full workbook survive a real save→reopen" proof, including
the `_with_oplog` variant and a determinism check.

### Result

```
test full_v11_fidelity_through_single_file_path ... ok
test full_v11_fidelity_through_oplog_file_path   ... ok
test full_v11_workbook_save_is_deterministic     ... ok
test result: ok. 3 passed; 0 failed
```

**No data-loss or corruption bug surfaced.** Persistence round-trips losslessly and deterministically.
Run: `cargo test -p ql-io --test gatev_qbook_full_fidelity --locked`.

> Note: this validates the **engine serializer**. The GUI-level save/reopen/hot-exit/revert lifecycle
> (the CustomEditor wiring) is Part C items P1–P7 — still operator-manual.

---

## Part C — Operator GUI-smoke runbook (the ~16-wave backlog)

These waves shipped **headless** and were never interactively verified. Run each in the live Extension
Host and tick pass/fail. Triggers below are grounded in `package.json` / the webview source (exact
command ids, menu paths, toolbar `data-cmd`s).

### Launch
- **How:** this is the `quantlab` VS Code fork — build core + webviews (`npm run compile` +
  `npm run build:webviews` in `extensions/quantlab`) and start the dev Extension Host as you normally
  do (`.vscode/launch.json` → *Attach to Extension Host*, or `./scripts/code.sh`).
- **Open a blank workbook:** Command Palette → **`Quantbook: Open Cell Grid`** (`quantlab.quantbookCellGrid`)
  → a demo workbook (Returns / Prices / Scratch; `=SHARPE` / `=MAX_DRAWDOWN` seeded).
- **Trust gate:** `.qnb` files require workspace trust (`capabilities.untrustedWorkspaces: "limited"`).
  First open prompts for trust.

### Persistence (.qbook) — the highest-stakes surface
- [ ] **P1 Save As** — `Quantbook: Save As...` (`quantlab.quantbookSaveAs`) → writes a `.qbook` file.
- [ ] **P2 Open existing** — double-click a `.qbook` in Explorer → opens in the custom editor
  (`quantlab.quantbookCellGridEditor`); or `Quantbook: Open...` (`quantlab.quantbookOpen`).
- [ ] **P3 Dirty dot + save** — edit a cell → tab shows the modified dot; `Ctrl/Cmd+S` → dot clears.
- [ ] **P4 Revert** — make edits → *File: Revert File* → reloads from disk, edits gone.
- [ ] **P5 Hot-exit** — edit, do NOT save, reload the window → reopens with the unsaved edits restored.
- [ ] **P6 Full round-trip** — build a workbook with styles + number formats + a table + a named range
  + hidden rows + a freeze → save → close → reopen → **everything intact** (GUI mirror of Part B).
- [ ] **P7 Two tabs independent** — open two `.qbook` files → scroll/edit each independently.

### Grid editing & structure
- [ ] **E1 Edit/commit/escape**, arrow-key nav, type-to-edit.
- [ ] **E2 Insert/Delete rows & cols** — right-click cell/header → *Insert Row Above/Below*,
  *Insert Column Left/Right*, *Delete Row/Column*.
- [ ] **E3 Hide/Unhide rows** — right-click a row span → *Hide Rows* (collapses to 0 height) /
  *Unhide Rows* / *Unhide All Rows*.
- [ ] **E4 Resize** — drag a column border (width) and a row border (height); rows stay uniform until
  individually dragged.
- [ ] **E5 Decimal nudge** — toolbar buttons **`Increase decimal places` / `Decrease decimal places`**
  (`data-cmd="decimal-increase"` / `"decimal-decrease"`) with a numeric cell selected.
- [ ] **E6 Number format** — toolbar `numfmt` button, or `Quantbook: Set Cell Format`.
- [ ] **E7 Styling** — toolbar `bold` / `italic` / `underline` / `strikethrough` / `borders` /
  text-color; verify the rendered cell updates.
- [ ] **E8 Formula-text coloring** — type `=SUM(A1:A3)+B2` → tokens are colored in the formula bar
  AND in-cell; referenced ranges get matching colored outlines on the grid (`formulaInk.ts`).

### Selection / clipboard
- [ ] **C1 Cut / Copy / Paste** (right-click), fill-handle drag, multi-cell + multi-range selection.
- [ ] **C2 Clear Contents** (right-click).

### Formula intelligence
- [ ] **F1 Autocomplete + signature help** while typing a function name / args.
- [ ] **F2 Range-pick** — while editing a formula, click/drag cells to insert refs.

### Sort / Filter
- [ ] **S1 Sort A→Z / Z→A** — right-click a range → *Sort Range A to Z* / *Z to A*.
- [ ] **S2 Sort refusal** — sort a range that contains formulas → an **honest refusal message**
  (NOT silent corruption). This is the v1 behavior until Wave M lands ref-translation.
- [ ] **S3 AutoFilter** — `Quantbook: Toggle AutoFilter` → header filter-triangles → open the dropdown →
  uncheck values → *Apply* → matching rows hide; *Clear* → restore. Toggle off → triangles gone, a
  manually-hidden row stays hidden (not unhidden).

### Freeze / Split
- [ ] **W1 Freeze** — `Quantbook: Freeze Panes at Selection` (or right-click *Freeze Panes Here*) →
  rows/cols above-left pin; scroll confirms; *Unfreeze Panes*.
- [ ] **W2 Split** — `Quantbook: Split Window at Selection` → top & bottom panes scroll independently
  on Y; *Remove Window Split*. (Freeze and split are mutually exclusive.)

### Find / Replace / Names
- [ ] **N1 Find** — `Quantbook: Find in Workbook...` → QuickPick hit list (snapshot read).
- [ ] **N2 Replace All** — `Ctrl/Cmd+H` (`quantlab.quantbookReplaceAll`).
- [ ] **N3 Names** — *Define Name...* (right-click), *Name Manager...* (`Ctrl/Cmd+F3`), *Go to Name...*.

### Tables
- [ ] **T1 Create Table** — right-click a data range → *Create Table from Selection...* → banded
  styling + structured refs work.
- [ ] **T2 Rename / Resize / Drop table; Rename Column** (right-click).

### Sidebars (Activity Bar → **Quantbook** container; all gated on an open grid)
- [ ] **B1 Live Python** (`quantlab.livePythonView`).
- [ ] **B2 Dependencies** (`quantlab.depGraphView`).
- [ ] **B3 Errors / diagnostics** (`quantlab.diagnosticsView`) — enter `=1/0` → `#DIV/0!` surfaces in
  the Errors view + as a squiggle/DiagnosticCollection entry.
- [ ] **B4 Functions catalog** (`quantlab.functionCatalogView`) — browse the function reference,
  click-to-copy. (Note: shows built-ins; real UDFs depend on Wave L's registration flow.)
- [ ] **B5 SQL Query** (`quantlab.sqlQueryView`) — run a read-only `SELECT` into a target range on the
  focused grid.

### Local-first / AI
- [ ] **A1 Local-First Privacy** — `Quantbook: Local-First Privacy` → modal privacy statement.
- [ ] **A2 AI key** — `Quantbook: Set Anthropic API Key` (stored in the OS secret store) /
  `Quantbook: Clear Anthropic API Key`.
- [ ] **A3 Explain Cell with AI** — right-click a formula cell → *Quantbook: Explain Cell with AI*
  (or palette) → a streamed explanation appears in the **"Quantbook AI"** output channel.
  Egress is **formula + A1 + error only** (no sheet name, no data values).

### Export
- [ ] **X1 Export to CSV** (`quantlab.quantbookExportCsv`).
- [ ] **X2 Export to XLSX** (`quantlab.quantbookExportXlsx`).

### Graceful-degradation (out-of-v1 affordances present in the toolbar)
- [ ] **O1** — the toolbar carries `merge` / `print` / `wrap` / `zoom` buttons that are **out-of-v1**
  per the rebaseline. Confirm they are clearly stubbed/disabled and do not crash or corrupt — they
  should not look like first-class working features in a v1 demo.

---

## Part D — R2 render bakeoff (already built — just run it)

The bakeoff harness **already exists and is fully instrumented** — R2 is "run it + record the verdict,"
not "build it."

- **Run:** Command Palette → **`Quantbook: Open Render Bench (FE-2 bakeoff)`**
  (`quantlab.quantbookRenderBench`) → click **Run all datasets**.
- **What it measures** (per `webview/render-bench/metrics.ts`): SCROLL fps, single-cell + 1k-cell
  DAMAGE commit p95, INPUT-TO-PAINT p95, peak JS heap — against the FE-2 gates:

| Gate | Threshold |
|---|---|
| Scroll p50 | ≥ 58 fps |
| Scroll p95 frame | ≤ 24 ms |
| Scroll worst-1s | ≥ 50 fps |
| Input-to-paint p95 | ≤ 32 ms |
| Damage p95 (1-cell) | ≤ 16 ms |
| Damage p95 (1k-cell) | ≤ 50 ms |
| Heap | ≤ 350 MB |

- **Record:** the final **VERDICT** line (`ALL GATES PASS -> Canvas2D locks for v1` or
  `GATE MISS(ES) -> ... a documented miss forces GPU`) + the per-gate table. This **also closes the
  DoD #4 60fps-scroll check** (the SCROLL scenario).

---

## Findings & follow-ups

- **F-1 (CORRECTED w103 — was HIGH, now NONE):** the ~106ms "edit latency O(graph)" was a criterion
  drop-timing artifact (the bench dropped the 1M-cell workbook inside the timed region). Corrected edit
  op = **~18µs** (set_value ~8.7µs + recompute ~9.5µs) on a 1M grid (~820× under the <15ms budget); the
  path is O(dirty-set). Fixed the bench
  (drop deferred) + added a deterministic O(dirty) CI guard (`tests/gatev_edit_latency_contract.rs`). No
  engine change. See the corrected Finding F-1 above.
- **F-2 (info):** `recompute_all` cold full-recalc (load/replay path) is ~160ms at 100k — expected
  (it re-parses + rebuilds an ephemeral graph). Not a gate; flagged so the perf story isn't misread.
- **Runbook caveats to confirm during the GUI pass** (from grounding, not yet GUI-verified):
  - `merge` / `print` / `wrap` / `zoom` toolbar buttons are out-of-v1 (item O1).
  - F3 "find next" navigation is not bound (only find-all via palette).
  - SQL sidebar runs SELECT-into-range, but **SQL→cell lineage/persistence** is not wired (Wave L/R23).
  - Functions catalog shows built-ins only until the Wave L UDF-registration flow lands.

## Artifacts landed this pass
- Engine `feat/quantbook-engine`:
  - `crates/ql-io/tests/gatev_qbook_full_fidelity.rs` (3 tests, passing) — data-loss regression guard.
  - `crates/ql-exec/benches/gatev_recalc_contract.rs` + Cargo.toml `[[bench]]` entry — perf-contract
    reproducer (surfaced F-1).
- IDE `fe/sheet-tabs`: this report (`docs/fe/2026-06-20-gatev-validation-report.md`).

### w103 (2026-06-20) — F-1 correction
- Engine `feat/quantbook-engine`:
  - `crates/ql-exec/benches/gatev_recalc_contract.rs` — fixed: routines return owned `(wb, graph, reg)`
    so criterion drops them outside the timed region (+ a header note documenting the pitfall). The two
    edit benches now read ~9µs; the `recompute_all` control stays ~160ms (proves no dead-code elision).
  - `crates/ql-exec/tests/gatev_edit_latency_contract.rs` (NEW) — deterministic O(dirty) edit guard
    (single-cell edit recomputes exactly one dependent regardless of grid size).
- IDE `fe/sheet-tabs`: F-1 section + headline + follow-ups corrected in this report;
  `.plans/active/v1-rebaseline-sequence.md` F-1 reclassified.

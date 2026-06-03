# FE Megaudit — SYNTHESIS + Adversarial Verification

**Date:** 2026-06-03
**Branch:** `feat/visualise-v1` HEAD `1c8c8e366b2`
**Scope:** the landed Quantbook FE (FE-0a single-writer `Session` migration + FE-0b persistent bundled webview + own Canvas2D renderer).
**Method:** dedup across the 12 lane reports (S1–S7, O1, O2, C1, C2, C3), then **verify each HIGH and notable MED at source** — opening the cited files and confirming/refuting with the real code. Read-only audit; no product code changed.

---

## Executive summary

**Overall verdict: SHIP-WITH-FIXES.** The architecture is sound (O1: no dead-ends; the renderer/geometry seams are clean for FE-1/1.5/2), the security surface is clean (C1: no XSS / arbitrary-file / out-of-range-write / napi-panic path), the coordinate/HiDPI math is correct (S1 + C2 both worked it numerically and agree), and the cross-repo error-code sync is complete (C3: the D-H1/H2 `sql_error`/`sql_table_build`/`source_not_found` codes are present; the napi DTO mirrors are faithful). The happy-path single-panel edit→commit→recalc→render loop is correct.

The defects cluster in **lifecycle / single-writer integrity, formula edit semantics, build wiring, diagnostics wiring, and No-Fallbacks gaps** — none of which block the architecture, all of which are bounded fixes.

**Confirmed counts after dedup + verification:**

| Severity | Count | IDs (consolidated) |
|---|---|---|
| HIGH | 5 | F1 formula-`=`-drop data loss · F2 panel-registry single-writer break + session leak · F3 dead UDF diagnostics · F4 session never closed on dispose + listener over-scoped · F5 quantbook bundle not in aggregate build |
| MEDIUM | 9 | M1 undo sibling-panel stale · M2 watch-build swallow · M3 unknown-sheet delta silent-skip+version-advance · M4 deleted-sheet renders as empty · M5 dropped-render no user signal · M6 refreshAll-catch log-only ×4 + disposed-panel miscount · M7 palette/font No-Fallbacks · M8 in-flight edit reply correlation · M9 oversized rawInput DoS |
| LOW | ~12 | (rolled up — see cluster + low table) |

**Refuted / downgraded during verification:**
- **S2-L2 (moveSheet picker off-by-one out-of-range) → REFUTED.** The loop is `pos < sheets.length`, producing positions `0..sheets.length-1`; `moveSheet`'s valid range is `[0, sheetCount)` (the source sheet is still live during the op), so every generated item is in range. No `[bad_argument]`.
- **S2-H2 (undo multi-panel) → CONFIRMED but DOWNGRADED HIGH→MED.** Real, but no data loss (the engine undo succeeded); only a sibling panel's *display* is stale, and the case requires two panels on one session across two sheets.
- **S4-H1 (packaged build ships blank grid) → CONFIRMED-real but PARTIAL framing.** The wiring gap is real, but it is the *same* manual-npm-script story the already-shipping chart/action/trade webviews use (both gitignored `dist/`, neither in `esbuildMediaScripts`) — not a quantbook regression. Kept HIGH as a build-hygiene gate.
- **S3-H1 vs S4-L1 (watch-build swallow) → CONFIRMED, severity reconciled to MED** (dev-only watch path; one-shot build fails loud; shared file across 7 extensions, pre-existing).
- **O2-H3 / S2-M1/M2 / C2-HIGH-2 (in-flight edit correlation, errorReply re-arm) → CONFIRMED but MED**, structurally blocked today (one sheet per webview; sheet-switch mints a fresh panel), latent for multi-sheet panels.

---

## Consolidated findings (severity-ranked, verified)

### HIGH

---

#### F1 — Formula re-edit drops the leading `=`, so a no-op re-submit silently converts a formula cell to a text cell (DATA LOSS)
**Lanes:** S2-H1, C2-HIGH-1 (cross-corroborated).
**Files:** `webview/sheets-webview/index.ts:145`; dispatch routing `cellGridLogic.ts:376,385,388`; `classifyCellInput` `cellGridLogic.ts:197-207`; snapshot passthrough `cellGridLogic.ts:744,840`.

**VERIFICATION: CONFIRMED.** Traced begin→Enter→dispatch at source:
- `index.ts:145` pre-fills the editor with `typeof entry.formula === 'string' ? entry.formula : formatCellValue(entry.value)` — **no `=` prefix**.
- `entry.formula` is the engine's *normalized body* (e.g. `A1 * 2`), passed verbatim from the snapshot (`extractSheetSnapshot` sets `entry.formula = cell.formula`, `cellGridLogic.ts:744/840`). The dispatch comment at `:381` confirms the engine stores a normalized form without `=`.
- Dispatch (`cellGridLogic.ts:376`) only routes to `setFormula` when `req.rawInput.trimStart().startsWith('=')`. A re-submitted `A1 * 2` (no `=`) → `classifyCellInput('A1 * 2')` → `Number('A1 * 2')` is `NaN` → not finite → `{ kind: 'text', text: 'A1 * 2' }` → `setValueValidated` → **the formula cell becomes a text cell.**

**Impact:** the single most user-damaging bug. Click a formula cell, press Enter without editing → the formula is destroyed and replaced with its text. Also a UX-blindness bug (user cannot see they are editing a formula vs text).
**Minimal fix:** prefix `=` when pre-filling: `inputEl.value = typeof entry.formula === 'string' ? '=' + entry.formula : formatCellValue(entry.value)`. Add a regression test: re-edit a formula cell, press Enter unchanged, assert it stays a formula.
**Effort: S. Blocking for v1.**

---

#### F2 — Panel registry keyed by sheet-id only: a 2nd `Session` is silently discarded + leaked, the wrong workbook is shown, and command-path single-writer is violated
**Lanes:** O2-H1 (primary); related to S7-H1 (the leak half) and the H1-cluster.
**Files:** `cellGridPanel.ts:69` (registry), `:82-89` (`show`), `:213-219` (`activeLocalPanels`); `quantbookCommands.ts:231-261` (`quantbookCellGrid` mints a fresh session per call), `:286-291` (B2 commands use `localPanels[0]`).

**VERIFICATION: CONFIRMED (both halves).** At source:
- `const panels: Map<number, CellGridPanel>` — keyed by **sheet number alone, no session identity** (`:69`).
- `show()` (`:84-89`): if `panels.get(sheet)` exists it `reveal()`s + `render()`s that panel **regardless of whether `existing.session === session`**.
- `quantbookCommands.ts:235` calls `createWorkbookSession()` on **every** `quantlab.quantbookCellGrid` invocation, with no single-instance guard and no close/dispose of any prior session.
- Therefore: run the command twice → session B is minted + seeded → `show(context, B, 0)` returns the **A** panel (revealed against A's data). **Session B is never shown, never registered, and never `.close()`d → leaked native handle, and the user sees A under the belief they opened a fresh book.**
- Command path: B2 sheet-management / Save-As operate on `localPanels[0]` = arbitrary insertion-order pick (comment at `quantbookCommands.ts:278-279` admits "OLDEST open local panel"); there is no active-panel tracking (`onDidChangeViewState`), so with two sessions open the user can rename/save the *wrong* workbook.

**Impact:** breaks the single-writer model the FE-0a migration was supposed to establish, the moment a second session exists. Leak + wrong-data-shown + wrong-target-command.
**Minimal fix:** key the registry by `(session, sheet)` (e.g. `WeakMap<SessionInstance, Map<number, CellGridPanel>>`); in `show()` only reveal-existing when `existing.session === session`, else create a new panel and `close()` the displaced session. Track last-focused panel via `panel.onDidChangeViewState` for the command path. At minimum, `quantbookCellGrid` must refuse-or-replace+close a prior session rather than leak.
**Effort: M. Blocking for v1.**

---

#### F3 — Engine cell-diagnostic tooltips are dead end-to-end: UDF `#CALC!`/`#TIMEOUT!` reasons never surface
**Lanes:** O2-H2 (primary); S5-H4 corroborates the "tests cover the dead path, not the live tooltip" angle.
**Files:** `cellGridPanel.ts:284-312` (`render()`); `cellGridLogic.ts:879,912` (`buildCellDiagnosticMessages`/`attachCellDiagnostics`); webview `index.ts:229` (hover reads `entry.diagnostic`); `session.ts:pollEvents` (never drained live).

**VERIFICATION: CONFIRMED.** Grep of non-test source shows the **only** references to `attachCellDiagnostics`/`buildCellDiagnosticMessages` are their own definitions, a comment in the DEAD `cellGridHtml.ts`, and type docstrings. `render()` (`cellGridPanel.ts:284`) does `acquireWorkbookSnapshot → extractSheetSnapshot → store → post` and **never calls them**; `extractSheetSnapshot` never sets `diagnostic`. `session.pollEvents()` is never drained on the live path (only referenced by the loader's method-presence check and type defs). The webview's `entry.diagnostic` hover branch (`index.ts:229`) is therefore permanently fed `undefined`.

**Impact:** when a UDF cell computes to `#CALC!`/`#TIMEOUT!`/`#CALC!(no worker)`, the structured engine explanation is produced and then dropped before the user — a lost-error integration seam.
**Caveat on reachability:** the current `quantbookCellGrid` seed path uses plain numbers and sets no UDF worker, so UDF diagnostics are not exercised by the demo grid today; impact is gated on whether UDF eval is reachable in v1. The wiring is clearly *intended* to be live (the whole tooltip apparatus exists).
**Minimal fix:** in `render()`, after `extractSheetSnapshot`, drain `session.pollEvents(cursor)` (per-panel cursor), `buildCellDiagnosticMessages(events, sheet)`, then `attachCellDiagnostics(snapshot, messages)` before storing `latestSnapshot`. If UDF eval is out of v1 grid scope, delete the dead helpers + the webview hover branch so the dead path isn't mistaken for working.
**Effort: S–M. Blocking-vs-forward: forward if UDFs are out of v1 grid scope; blocking if a UDF can reach the grid (decide explicitly).**

---

#### F4 — Session is never closed on panel dispose + the message listener is anchored to extension lifetime, not panel lifetime
**Lanes:** S7-H1 (session close), S7-H2 (listener scope).
**Files:** `cellGridPanel.ts:132-142` (onDidDispose), `:118-122` (`onDidReceiveMessage(..., context.subscriptions)`), `:143` (`context.subscriptions.push(panel)`); `quantbookCommands.ts:231-261`.

**VERIFICATION: CONFIRMED (both).** The `onDidDispose` handler (`:132-142`) sets `_disposed`, clears the watchdog, and removes the registry entry — but **does not call `session.close()`**. The session is reachable via the panel instance, which is pinned by `context.subscriptions` until extension deactivation, so it is not even GC-eligible. Combined with F2 (a fresh session minted per command invocation), repeated open/close cycles accumulate zombie engine `WorkbookSession` handles. Separately, `onDidReceiveMessage` is registered with `context.subscriptions` (`:121`) as its disposable array — extension lifetime, not panel lifetime — so the listener outlives the panel (a late buffered webview message can still reach `handleIncoming` → `dispatchIncomingMessage` on a logically-dead panel/closed session).

**Impact:** deterministic native-handle leak across open/close; stale-closure callback into a closed session.
**Minimal fix:** call `instance.session.close()` inside `onDidDispose` (log on failure, don't swallow); collect the message listener in a panel-scoped disposable array and dispose it in `onDidDispose`. (F2's session-keyed-registry fix and this dispose-close fix should land together.)
**Effort: S. Blocking for v1** (resource correctness; pairs with F2).

---

#### F5 — Quantbook webview bundle is not wired into any aggregate / CI / prepublish build path
**Lanes:** S4-H1.
**Files:** `build/lib/extensions.ts:563-571` (`esbuildMediaScripts`); `extensions/quantlab/package.json:19-20` (`build:webviews:quantbook` npm script); `cellGridPanel.ts:111,126,430` (runtime hardcodes `dist/webview/quantbook/`); watchdog at `:348`.

**VERIFICATION: CONFIRMED-real, PARTIAL on framing.** `esbuildMediaScripts` is a hardcoded list of 7 scripts; `quantlab/esbuild-quantbook-webviews.mjs` is absent. Grep confirms `build:webviews:quantbook` is chained **nowhere** — no `vscode:prepublish`, no gulp task, no root script, no CI stage. The bundle is built only by the manual mac-host npm script; `extensions/**/dist/` is gitignored. **However**, the same is true of the already-shipping chart/action/trade webviews (their `esbuild-webview.mjs` is *also* absent from `esbuildMediaScripts`, `dist/` *also* gitignored) — so this is the extension's existing webview-build pattern, not a quantbook-introduced regression. A fresh CI checkout that never runs the npm script produces a missing `sheets-webview.js`; the webview loads nothing and the 6 s `readyWatchdog` (`cellGridPanel.ts:342-352`) shows a loud error telling the user to run `npm run build:webviews:quantbook`. So the failure is eventually VISIBLE, not silent.

**Impact:** any aggregate/packaged build that doesn't run the manual step ships a non-functional grid (loud-after-6s). Build-hygiene gate.
**Minimal fix:** add `'quantlab/esbuild-quantbook-webviews.mjs'` (and the chart `esbuild-webview.mjs`) to `esbuildMediaScripts`, OR add a `vscode:prepublish` / build chain that runs `build:webviews:quantbook`. **Note the `--outputRoot` nesting caveat** (S4-H1): the shared `run()` computes `outdir = join(outputRoot, basename(outdir))`, so a nested `dist/webview/quantbook` target needs reconciling with the runtime `dist/webview/quantbook/` path (flatten the outDir, or special-case the outputRoot) — don't add it blind. Also note Linux-CI esbuild is darwin-only today (I1).
**Effort: M. Blocking for any non-manual packaging; forward if packaging stays manual-mac-only for v1.**

---

### MEDIUM

#### M1 — Undo/redo re-renders only the dispatching panel; sibling panels on the same session show stale display
**Lanes:** S2-H2 (rated HIGH; **DOWNGRADED to MED** in verification — no data loss).
**Files:** `cellGridLogic.ts:286-295` (undo branch calls `deps.onCommit()`), `cellGridPanel.ts:383` (`onCommit = () => this.render()`).
**VERIFICATION: CONFIRMED, narrow.** The undo/redo branch calls `deps.onCommit()` which is the panel-local `this.render()`; `refreshAll()` is only called by sheet-management commands, not undo. Two panels on one session (different sheets, via switch-sheet) → after an undo affecting the sibling's sheet, the sibling shows stale data until the next action. **No data loss** (engine undo succeeded); display-only. Reachability is limited by F2 (a 2nd command invocation mints a *separate* session rather than sharing).
**Fix:** route undo/redo's re-render through `CellGridPanel.refreshAll()` (scoped to the mutated session once F2 lands). **Effort: S. Forward.**

#### M2 — Watch-mode esbuild errors are swallowed (No-Fallbacks)
**Lanes:** S3-H1 (HIGH), S4-L1 (LOW) → reconciled **MED**.
**Files:** `extensions/esbuild-webview-common.mjs:45-51` (`tryBuild`), used at `:84,86`.
**VERIFICATION: CONFIRMED.** `tryBuild` catches and only `console.error`s (no re-throw/exit), used for both initial and incremental watch builds; the one-shot path (`:88-95`) correctly `process.exit(1)`s with the error logged. In `--watch`, a build failure leaves a stale bundle silently. Dev-only; the integration point (one-shot) is loud; shared file across 7 extensions (pre-existing).
**Fix:** in `tryBuild`, after `console.error`, annotate with the script name and `process.exit(1)` (the watcher restarts on next edit) — or drop `tryBuild` and let the rejection surface. **Effort: S. Forward (dev hygiene).**

#### M3 — `mergeWorkbookDelta` silently skips changed/removed cells for unknown sheets AND advances the cache version → permanent divergence
**Lanes:** C2-MEDIUM-2 (MED), C3-LOW-1 (LOW) → **MED**.
**Files:** `cellGridLogic.ts:1069-1071, 1078-1080` (`continue` on unknown sheet), `:1110` (`cached.version = delta.version` unconditional).
**VERIFICATION: CONFIRMED.** On a non-fullRebuild delta referencing a sheet absent from the cache, the cell update is dropped (`continue`) yet `cached.version` is advanced — so the next delta starts after the lost update and the cache can stay permanently divergent from a fresh `snapshot()`. Only reachable on an engine contract violation/drift (the comments correctly note AddSheet trips `fullRebuildRequired`), so not reachable on the current engine.
**Fix:** throw `[invalid_state] mergeWorkbookDelta: cell for unknown sheet …` (or force a full resync) instead of skip-then-advance. **Effort: S. Forward-hardening.**

#### M4 — A deleted active sheet renders as an ordinary empty sheet, not a tombstone
**Lanes:** C2-MEDIUM-1, O2-M3, S2-L3 (cross-corroborated).
**Files:** `cellGridPanel.ts:286-297` (null→empty snapshot + `console.warn`), webview empty-state message.
**VERIFICATION: CONFIRMED.** `extractSheetSnapshot` correctly returns `null` for a tombstoned sheet, but `render()` converts it to a normal `{ entries: [] }` snapshot and only `console.warn`s. The user sees "(empty — no PutValue ops on this sheet)" on a deleted sheet — the tombstone is masked as a valid empty sheet (No-Fallbacks-adjacent: anomalous state, only a dev-console signal).
**Fix:** send an explicit deleted-sheet render state (webview banner) or auto-close/switch the panel; at minimum a visible warning tied to the panel. **Effort: S. Forward.**

#### M5 — A dropped `render` postMessage is downgraded to `console.warn`; the grid can show stale values with no user signal (asymmetric with errorReply)
**Lanes:** O2-H3 (rated HIGH → **MED** in verification), S7-M4, C3-MEDIUM-2 (errorReply-rejection half).
**Files:** `cellGridPanel.ts:327-334` (render: `!delivered` → `console.warn`), `:398-407` (errorReply: `!delivered` → `showWarningMessage`, reject → `console.error`).
**VERIFICATION: CONFIRMED, low-probability.** With `retainContextWhenHidden:true` the channel is normally retained, so non-delivery is rare. But the asymmetry is real: a dropped *errorReply* escalates to a warning toast while a dropped *render* (the post-commit repaint) only logs — so a committed edit whose repaint was dropped leaves stale values silently. The errorReply **rejection** path (`:406`) is also only `console.error` (C3-MEDIUM-2). The `:386-388` comment is stale (claims a `retain:false` case that never occurs).
**Fix:** treat a dropped render like a dropped errorReply (visible "grid may be stale — run Refresh"); add `showWarningMessage` to the errorReply rejection arm; correct the comment. **Effort: S. Forward.**

#### M6 — `refreshAll` failures are log-only (×4 sheet ops) + disposed panels miscounted as "refreshed"
**Lanes:** S3-M6 + S3-H2 (disposed miscount, rated HIGH → **MED**), S2-L1.
**Files:** `quantbookCommands.ts:467-479,540-550,607-618,671-682` (catch → `log.appendLine`, no toast); `cellGridPanel.ts:194-197` (`safeRender` returns `true` for disposed).
**VERIFICATION: CONFIRMED.** The four sheet-management commands wrap `refreshAll()` in a try whose catch only `log.appendLine`s (no `showWarningMessage`) — a re-render failure after a successful sheet op is invisible unless the user has the output channel open. Separately, `safeRender` returns `true` (counted as `refreshed`) for a disposed panel, so `refreshAll` can report "Refreshed N panel(s)" for panels that did nothing.
**Fix:** add `showWarningMessage` in the four catches; return a third `'skipped'` outcome (or filter disposed panels before counting) so the count is honest. **Effort: S. Forward.**

#### M7 — Renderer palette/font reads silently fall back to hardcoded defaults (No-Fallbacks)
**Lanes:** S1-M1/M2/L1, S3-M1/M2/L2, O1-LOW-1 (cross-corroborated).
**Files:** `canvasGrid.ts:258-272` (`readPalette` 7× `v(name, fallback)`), `:276` (`readFonts` `|| 'sans-serif'`), `:67` (`resolveDpr` `|| 1`).
**VERIFICATION: CONFIRMED.** Every `--vscode-*` palette var has a silent hardcoded fallback; `--vscode-font-family` falls back to `sans-serif`. Cosmetic for colours; the **font** fallback is worse — wrong metrics silently corrupt `truncateToWidth`. In practice VS Code always injects these vars, so impact is low, but it is a genuine No-Fallbacks violation (`value || default` masking broken state).
**Fix:** `console.error/warn` once when a core var is missing before falling back (font especially); for `resolveDpr` throw on `0`/`undefined`. **Effort: S. Forward.**

#### M8 — In-flight edit replies are not correlated to the edit that produced them
**Lanes:** C2-HIGH-2 (rated HIGH → **MED**, structurally blocked today), S2-M1/M2.
**Files:** `index.ts:145-179` (single `pendingCommit` flag on current `editState`), `:191-197` (blur), `:272-280` (errorReply resets `pendingCommit` unconditionally).
**VERIFICATION: CONFIRMED, latent.** `beginEdit` cancels an existing edit even with a commit in flight; `errorReply` blindly clears `pendingCommit` on whatever `editState` is current; `applyRender → cancelEdit()` drops an in-flight edit. With fast click-B-while-A-pending, B's typing can be lost or B's commit double-sent. **Today this is hard to hit** (single sheet per webview; renders are committed-state). Latent the moment edits can interleave.
**Fix:** add a `(sheet,row,col,commitId)` to `EditState`; only clear `pendingCommit`/decorate when the reply matches; block a new edit while a commit is pending (or keep the pending editor live). **Effort: M. Forward.**

#### M9 — Host accepts unbounded `rawInput` strings before formula/text parsing (engine DoS)
**Lanes:** C1-M1.
**Files:** `cellGridLogic.ts:333-389`, `session.ts:213-216,249-252`, engine `lib.rs:5736-5749`.
**VERIFICATION: CONFIRMED (per C1's trace; not independently re-run, but the path is clear).** The dispatcher checks only `typeof rawInput === 'string'`; the TS wrappers cap coordinate domains but not length; the napi method parses the whole formula synchronously. A hostile/tampered local bundle can post a huge `rawInput` → memory pressure / expensive parse. No out-of-range write (C1 cleared that), but a real DoS surface.
**Fix:** cap cell-input length at the host boundary (reject over-limit with `[bad_argument]`), mirror in the napi boundary; add oversized-input tests. **Effort: S. Forward (defense-in-depth; not a v1 blocker absent untrusted webview content).**

---

### LOW (consolidated, verified-by-citation)

| ID | Lanes | File:line | Note | Verdict |
|---|---|---|---|---|
| L-a | S2-L2 | `cellGridLogic.ts:626` | moveSheet picker "off-by-one out-of-range" | **REFUTED** — positions `0..len-1` all in `[0, sheetCount)` |
| L-b | S1-L3, S7-L1 | `index.ts:288,221` | scroll/mousemove not rAF-throttled | CONFIRMED, safe today, FE-2 concern |
| L-c | S1-L4 | `canvasGrid.ts:89` | DPR change on monitor-switch not detected until next resize | CONFIRMED, cosmetic |
| L-d | S1-L5 | `sheets-webview.css:69` vs `canvasGrid.ts:28` | editor pad 6px vs canvas 8px → 2px text jump | CONFIRMED, cosmetic |
| L-e | C2-LOW-2 | `gridLayout.ts:149-160` | `truncateToWidth` can split surrogate pairs | CONFIRMED, minor display glitch |
| L-f | C2-LOW-1, S6-M2 | `cellGridLogic.ts:453` | host `computeVisibleRange` lacks shrink-clamp | CONFIRMED, **dead** (no live caller) |
| L-g | C2-LOW-3, O2-L2 | `cellGridLogic.ts:344-347` | putValue sheet-mismatch dropped (no errorReply) → editor stuck pending | CONFIRMED, blocked today |
| L-h | S7-M1/M2/L4 | `index.ts:288-299` | ResizeObserver/MutationObserver/scroll listener never disconnected | CONFIRMED, bounded (persistent webview) |
| L-i | S7-M3 | `canvasGrid.ts:246-256` | `measureCache` clear-all eviction → thundering miss | CONFIRMED, safe at 3-col scale, FE-2 concern |
| L-j | S7-L3/L5, O2-L1/L4 | `cellGridPanel.ts:69`, `index.ts:90,240` | panels-Map cleanup relies on onDidDispose; undo keydown on `document`; errorCells sheet-implicit | CONFIRMED, latent / hygiene |
| L-k | C1-L1/L2/L3 | `utils/webview.ts:21`, `cellGridLogic.ts:394`, `esbuild-quantbook-webviews.mjs:48` | nonce uses `Math.random` not CSPRNG; unsanitized coords echoed in errorReply; no-host-runtime guard is a narrow denylist (`.tsx`/`.d.ts`/`.dylib`/`.so` gaps) | CONFIRMED, defense-in-depth |
| L-l | S4-M1 | `cellGridPanel.ts:443` | ESM bundle loaded via classic `<script>` (no `type="module"`); other 3 webviews use `type="module"` | CONFIRMED, works today, consistency hazard |

**Dead-code / drift (S6, O1-LOW-3): all CONFIRMED, all known-deferred.** `cellGridHtml.ts` (788 LOC, ~74 test refs) + the dead host helpers `parseCellRawInput`, `computeVisibleRange`, `buildVirtualRows`, `classifyPollTick`, and the dormant presence/collab surface in `session.ts` are dead-in-v1, retained for v1.5/test, but several lack a dormancy label and several `types.ts`/`cellGridLogic.ts` docstrings still name `buildHtml`/`renderRows` as the live consumer (drift). The risk of *keeping* them is v1.5 re-enable confusion (M-4: the inline script's `presenceUpdate`/`typing_stroke` shape is the wrong architecture for the persistent bundle). **No runtime risk; all forward-cleanup.**

---

## Cluster view

1. **Lifecycle / single-writer integrity (the heaviest cluster):** F2 (registry keyed by sheet only → leak + wrong workbook + wrong command target), F4 (session never closed on dispose + listener over-scoped), M1 (undo sibling-panel stale), M6 (refreshAll miscount/log-only). *These four are the core of "the single-writer migration is not yet integrity-complete across multiple sessions/panels."* **Blocking: F2, F4. Forward: M1, M6.**
2. **Edit semantics / data integrity:** F1 (formula-`=`-drop = data loss — top priority), M8 (in-flight edit correlation), L-g (sheet-mismatch stuck editor). **Blocking: F1. Forward: M8, L-g.**
3. **Build / packaging:** F5 (bundle not in aggregate build), M2 (watch-build swallow). **Blocking-for-non-manual-packaging: F5. Forward: M2.**
4. **Diagnostics wiring:** F3 (UDF diagnostics dead end-to-end). **Decide v1 scope.**
5. **No-Fallbacks gaps:** M3 (delta unknown-sheet skip+advance), M4 (tombstone masked as empty), M5 (dropped-render silent), M6, M7 (palette/font), C3-MEDIUM-2 (errorReply-reject log-only). **All forward-hardening; none reachable on the current engine happy path except M4/M7.**
6. **Test coverage (S5):** `classifyCellInput`, the formula-error dispatch path, the `extractSheetSnapshot` blank-throw, the delta schema-version assertion, and the panel startup handshake are untested; ~65 `buildHtml` tests give *false coverage signal* (they pass even if the canvas path breaks). **Forward; add the pure-helper tests (cheap) with the F1 fix.**
7. **Forward-readiness (O1):** sound foundation, no dead-ends. The two seams to strengthen before FE-2 are the renderer interface (MED-1: no named `GridRenderer` type; `style.transform` blit lives in `index.ts`) and the render granularity (MED-2: full-snapshot-on-every-commit + edit-cancel-on-render will bite FE-1.5 reactive bursts). **All forward.**
8. **CLEARED:** security (C1: no XSS/file/OOB-write/panic), coordinate+HiDPI math (S1+C2), cross-repo error-code sync (C3).

---

## Fix-priority ordering

| # | Fix | Cluster | Effort | Gate |
|---|---|---|---|---|
| 1 | **F1** — prefix `=` on formula re-edit (`index.ts:145`) + regression test | edit semantics | **S** | **v1 blocker — data loss** |
| 2 | **F2 + F4 together** — session-keyed registry + `existing.session===session` reveal guard + `session.close()` on dispose + panel-scoped listener | lifecycle/single-writer | **M** | **v1 blocker — leak + wrong workbook** |
| 3 | **F5** — wire `build:webviews:quantbook` into the aggregate/prepublish path (with the `--outputRoot` reconciliation) | build/packaging | **M** | **blocker for any non-manual packaging** |
| 4 | **F3** — decide v1 UDF-diagnostics scope: wire `pollEvents → attachCellDiagnostics` in `render()`, or delete the dead helpers+hover branch | diagnostics | **S–M** | **decide explicitly** |
| 5 | **M4 + M7 + M6 + M5** — the user-visible No-Fallbacks batch (tombstone surface, palette/font warn-before-fallback, refreshAll toasts + honest count, dropped-render warning) + S5 pure-helper tests | No-Fallbacks + tests | **S each** | forward, do next |

Then the remaining MEDs (M1 undo-refreshAll, M2 watch-build, M3 delta-throw, M8 edit-correlation, M9 input cap) and the dead-code/drift labelling (S6) and the FE-2 readiness seams (O1 MED-1/2) as forward work before/with FE-1.5.

---

## What the audit CLEARED (green results on record)

- **Security (C1): clean.** No XSS (shell HTML is static; all cell/formula/diagnostic data flows through `textContent`/`input.value`/canvas `fillText`/`canvas.title`, never markup), no `.qbook` path-traversal/arbitrary-file (engine validates fixed child paths + schema before the FE swaps sessions), no out-of-range write (TS + Rust both validate u16/u32 coordinate domains before mutation), no napi panic path (bound Session methods are `catch_unwind`-guarded). Only defense-in-depth LOWs (nonce CSPRNG, oversized input, build-guard breadth).
- **Coordinate + HiDPI math (S1 + C2, independently worked numerically, agree):** the `transform: translate(scrollLeft, scrollTop)` blit, sticky-header rejection in local coords before adding scroll, content-coord overlay editor placement, `setTransform(dpr,…)` per-frame (non-cumulative), and crisp-line `round(...)-0.5` math are all correct.
- **Cross-repo / wire protocol (C3): error-code sync complete.** The TS union includes the D-H1/H2 `sql_error`/`sql_table_build`/`source_not_found` codes; `parseQuantbookError` reads native structured `code/class/details/retryable`; the napi DTO mirrors (`CellValueJson`, `WorkbookSnapshotJson`, delta DTOs, `BoundRangeJson.bindingId`) are faithful; fusion primitives (`publishDataset`/`bindRange`/`writeRange`/`refreshSource`/`materializeQuery`) are present and required by the loader (no silent no-op stubs).
- **Architecture (O1): sound foundation, no dead-ends.** All load-bearing locked decisions honored (own Canvas2D behind a usable seam; persistent bundled webview; build isolation; reuse engine snapshot/delta path; loader cdylib guard; text-cell fix); `gridLayout` is pure and golden-tested; module boundaries are right; FE-1/1.5 reactive chain (`publishDataset → recalcDirty → refreshAll()`) is wireable today without touching the webview contract.
- **The happy-path single-panel loop** (click → hit-test → edit → Enter → putValue → classify → setValue/setFormula → recalc → render → repaint) is correct, including the `webviewReady` handshake race (render-before-ready is buffered and re-sent) and the delta/`fullRebuildRequired` re-fetch.

---

## CLOSURE (2026-06-03) — all findings fixed + re-audited

Fixes landed on `feat/visualise-v1` in two commits: **`e6730e7a3ff`** (batch 1: v1 blockers
F1/F2/F4 + M1/M2/M6/L-l) and **`c9871601b3d`** (batch 2: F3, M3/M4/M5/M7/M8/M9, L-g/L-k/L-b/L-d/L-e/L-i,
classifyCellInput trim, S5 tests, S6 labels).

**Dual fix re-audit** (Codex + fresh-Opus, reports `REAUDIT-codex.md` / `REAUDIT-opus.md`):
Opus SHIP (0H/0M/3L); Codex SHIP-WITH-FIXES (0H/2M/2L). The 2 MED **regressions the fixes
introduced** were folded: MED-1 (M1's session-wide refresh cancelled a sibling panel's in-progress
edit -> `applyRender` is now edit-aware) and MED-2 (F2's show() reorder could orphan a panel on a
failing first render -> register + dispose-on-throw before render). Re-verified after folding:
**tsc clean, webview build green, 480 passing / 1 pre-existing-V2.8 fail.**

**DEFERRED (documented forward-work, not skipped):**
- **F5** — aggregate/CI build wiring of `build:webviews:quantbook`. Risky to do blind (the
  `--outputRoot` basename-flatten mismatch); matches the existing chart/action/trade webview pattern;
  the readyWatchdog makes a missing bundle loud-after-6s. Do it deliberately with packaging setup.
- **Full `cellGridHtml.ts` retirement** (~74 test refs) — its own bounded cleanup increment.
- **O1 FE-2 readiness seams** — a named `GridRenderer` interface + a `renderDelta` partial-update
  message. These are FE-2/FE-1.5 FEATURES, not fixes.
- **Residual LOWs:** accumulated-diagnostic growth bound + error->error staleness (needs an engine
  diagnostic-clear event); M5 toast dedup-under-storm.
- **L-a** was REFUTED (not a bug).

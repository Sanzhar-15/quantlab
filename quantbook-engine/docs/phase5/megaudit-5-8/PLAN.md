# 5.8 Phase 5 Megaudit — Execution-Ready Plan

**Status:** ✅ EXECUTED 2026-05-26 — **PASS-WITH-FINDINGS → PHASE 5 COMPLETE** (0 reachable HIGH; risk register 39/39 confirmed). Synthesis + verdict: `closures.md`. Exit packet: `../phase-5-exit-packet.md`. (This PLAN is preserved as the dispatch record.)

**This is the formal Phase 5 exit gate** ("Megaudit after 5.7" checkpoint, `MASTER-PLAN §679/§684`) and the entry gate for Phase 6 (`docs/phase6/entry-plan.md` §3). **V3.6 exit ≠ Phase 5 exit** — the V3.6.0.X phase-termination megaudit covered only the V3.6 D-decision surface; THIS megaudit covers the **entire Phase 5 collaboration surface**.

**Audit at:** engine `1465b1db4c4` (V3.6 PHASE CLEAN; source HEAD — later commits `841978..3e8c63` are docs-only) + IDE `d028568b53b` (V3.6.1.2). Re-confirm both at dispatch (`git log --oneline -1`).

---

## 1. What "pass" means — Phase 5 Exit Criteria (`MASTER-PLAN §690`)

The megaudit must verify each, with evidence:

1. **`ql-collab` is real** (not a stub).
2. **Cells, formulas, names, sheets, AND tables merge deterministically** under concurrency. ← *names + tables are the under-exercised ones; recent work centered on cells/sheets/format. Verify explicitly.*
3. **Offline sync + conflict diagnostics work.**
4. **Single-writer op log is not confused with collaboration** (the op-log scaffolding vs real CRDT distinction holds).

PASS = all 4 verified + zero open HIGH findings + every closed risk confirmed-closed in current code + Phase 5 exit packet written. Any HIGH ⇒ close in-cycle (or, if multi-session, log + defer Phase 6 entry until closed).

---

## 2. Scope inventory — the full Phase 5 surface (enumerate; miss nothing)

### 2.1 Sub-phases in scope (ALL of Phase 5 — the megaudit re-verifies the whole arc)
- **5 V1** (initial `ql-collab` + binding).
- **5 D-1** (CRDT data model lock; `docs/architecture/crdt-data-model.md`).
- **5.3** (collaboration substrate).
- **5.5 V2 V2** (auto-flush) + **V2 V3 steps 1–6** (version-vector / poll-remote / offline-write-queue / websocket-transport / full-arc / exit-packet) + **V2 V4 V1** (12/13 Tier items; K4 chunking deferred to V2 V4 V2).
- **5.7 V1**; **V2** (V2.1→V2.7 + V2.8 megaudit + V2.9); **V3.1** (a–e multi-window IDE demo); **V3.2** (a/a.1/b/c/d/e cell-grid UI); **V3.3.0** (0.1–0.7 multi-sheet virtualization); **V3.4** (0.1–0.7 undo/persistence/presence); **V3.5** (0.1–0.9 WorkbookSnapshot + sheet-ops + format + partial-invalidate undo + mid-edit guard); **V3.6** (0.1–0.11 on_push/format-registry/op-index/format-render/PutFormula/delta/RestoreSheet/typing-watchdog) + **V3.6.1** (B10 delta consumer + shared cache, IDE-side).

### 2.2 Crates (≈27k LOC)
- `ql-collab` (10.7k) — CollabSession, cache walker, undo, presence, snapshot/delta. **Core.**
- `ql-oplog` (4.9k) — Op enum, replay, VersionVector, persistence.
- `ql-collab-ws` (1.1k) — websocket transport + relay.
- `ql-bindings-node` (4.1k) — napi surface (81 `#[napi]` methods).
- `ql-storage` (6.0k) — Workbook, sheets, tombstones, FormatTable (the merge target).
- IDE consumer: `extensions/quantlab/src/quantbook/**` (TS; session.ts, cellGrid/*, types.ts).

### 2.3 Wire surface (`ql-oplog/src/op.rs`) — ~20 `Op` variants + 3 wire enums
PutValue, PutFormula, ClearFormula, SetName, AddSheet, RenameSheet, RemoveSheet, RestoreSheet, MoveSheet, RegisterFormat, SetCellFormat, BatchCommit, CreateTable, DropTable, RenameTable, RenameColumn, ResizeTable, SetReferenceMode, SetLocale, SetDateSystem. **[CORRECTED by the 5.8 megaudit — A#5/B#4/D5-1: there is NO top-level `Op::Unknown(String)`. `Op` uses `#[serde(deny_unknown_fields, tag="kind")]`, so unknown op kinds REJECT at decode. Forward-compat is via the wire SUB-enums' Unknown arms + `.qbook` `snapshot_format_version` — NOT a catch-all op variant. (Decision 2026-05-26: amend the spec, do not build a catch-all arm; cross-version op-log compat is a V3.7+ stable-op-ID concern.)]** Wire enums: LocaleWire (En/De/Fr/Unknown), ReferenceModeWire, DateSystemWire. **Every variant needs encode→decode→replay round-trip + multi-peer convergence coverage.**

### 2.4 Cache surface (`ql-collab/src/session.rs`) — 7 `CacheEffect` variants
PutValue, PutFormula, ClearFormula, RegisterFormat, SetCellFormat, RemoveSheet, RestoreSheet. Plus cache fields: `last_snapshot`, `format_table_cache`, `cell_op_index`, `sheet_op_index`, `tombstones`, `last_snapshot_workbook`/`_oplog_vv`/`_op_count`, undo-group state. **Walker correctness + tombstone preservation + index sync are the bug-dense areas (CONVERGENT-HIGH-1 lived here).**

### 2.5 API surface
- 57 `pub fn` on CollabSession + 81 `#[napi]` methods + the `types.ts` TS mirror. **napi↔TS parity + producer/replay validation symmetry are audit targets.**

### 2.6 Risk register — verify EACH is in its claimed state (39 entries: R-V3.3-1..6 + R-V3.4-1..7 + R-V3.5-1..7 + R-V3.6-1..19)
- **R-V3.3-1..6**, **R-V3.4-1..7**, **R-V3.5-1..7**, **R-V3.6-1..19**.
- For each CLOSED risk: confirm the closure code exists at current HEAD + a regression test pins it. For each OPEN/conditional risk (e.g., R-V3.6-9 D7): confirm it's appropriately deferred, not silently broken.

### 2.7 Deferred / conditional carryovers — PRIME megaudit targets (did deferral rot into a bug?)
- **CODEX-MED-1 / CLOSURE-CODEX-MED-1**: out-of-range RemoveSheet cache-vs-replay parity (deferred V3.5.1+; "only reachable via malformed logs" — re-verify that claim).
- **V2 V4 V2 K4 chunking** (~2–3d; deferred).
- **R-V3.6-9 D7 `#REF!`** (conditional, unshipped).
- **sheet-tabs UI** (V3.5.0.4c / V3.6+ multi-tab redesign).
- **V3.6.1 backlog**: B9 `removedCells` (V3.7+), CellValueJson union cleanup (scoped), incremental DOM patching (V3.6.2+). B8 (producer/replay) + B10 (delta consumer) now closed.
- **Smaller backlog** (V2/V3.1.e/V3.2.d/V3.3.0.6/V3.4.0.5): `transportLastErrorInfo()`, `willFlushSend()`, `LoopbackTransport.close()`, HandshakeFailed fixture, `CollabSessionError::Transport(_)` origin, `@napi-rs/cli` publish, `#[napi(strict)]` sweep, AtomicUsize conn_id wrap, per-cell incoming-tint, status-bar item, push-API for inbound observation, jsdom virtualization test.
- **Codex INFO-3/INFO-5**: V3.7+ stable-op-ID migration (OpLog positional-index fragility, R-V3.6-10 long-term fix).

### 2.8 Already-audited (so the megaudit does NOT just repeat per-step work)
140 Phase-5 audit transcripts exist (per sub-phase: 5 V1 + 13 V2.1–2.7 + 3 V2.8 + 2 V3.1.e + 2 V3.2.d + 2 V3.3.0.X + 2 V3.4.0.X + 2 V3.5.0.X + V3.6.0.2/3/4/5/6/8/10/X). **The megaudit's value is the CROSS-sub-phase + deferred-item + whole-surface-re-verification layer that per-step audits structurally cannot see** (the discipline note: per-batch audits missed 22 HIGHs that the Phase 4.11/4.12 5-way megaudit caught; V3.6.0.X CONVERGENT-HIGH-1 was invisible to the per-step D8 audit).

---

## 3. Megaudit design — 5-way (4 parallel audit lanes + 1 synthesis)

Per audit-discipline memory (phase-level closures use 3–5-way; Phase 4.11/4.12 5-way caught 22 invisible HIGHs). Phase 5 is the largest, most interaction-dense surface ⇒ **5-way is justified.** Lanes are focus-partitioned to minimize redundancy while maximizing coverage. Full prompts in §7.

| Lane | Engine | Focus (distinct) | Why this lane |
|---|---|---|---|
| **A** | Codex (`codex exec`) | **Adversarial empirical + CRDT convergence.** Multi-peer interleavings across ALL op types; offline-queue×reconnect; undo×merge; wire round-trips; panic/unwrap hunt. Builds + runs tmp probes. | Codex's empirical probing caught the grouped-undo + RestoreSheet HIGHs. |
| **B** | Opus (Agent) | **Per-sub-phase invariants + risk-register verification.** Walk every R-V3.x; cache-walker invariants; Rule-4 Send+Sync per-field walk; VV/op_count + clone-cost. | Deep static correctness; confirms claimed closures are real in current code. |
| **C** | Opus (Agent) | **Cross-sub-phase interaction matrix.** {transport/merge}×{snapshot/delta}×{undo/redo}×{sheet-ops}×{format}×{tables}×{virtualization}. The per-step-invisible class. | This is where phase megaudits earn their keep. |
| **D** | Opus or Codex (Agent/exec) | **API/contract/binding consistency + deferred-item audit + docs.** ide-consumer-contract.md vs reality (whole contract); types.ts↔Rust parity; producer/replay symmetry; every deferred item re-validated; test-coverage gaps. | Contract drift (V3.6.0.10 found lots); deferred-rot. |
| **E** | claude-self (this assistant) | **Synthesis.** Dedup → convergent findings → severity-rank → scope-coverage check (no crate/sub-phase/risk missed) → closures doc → Phase 5 exit verdict vs §1. | Composes the megaudit; decides PASS/FAIL. |

---

## 4. Methodology

- **Dispatch (parallel):** Lanes A–D run in parallel.
  - Codex lane(s): `mac zsh -lc 'cd <engine> && codex exec --sandbox workspace-write --skip-git-repo-check - < docs/phase5/megaudit-5-8/lane-a-codex.md > docs/phase5/megaudit-5-8/lane-a.out 2>&1'` (run in background; ~30–60 min; **per Codex-patience rule, wait without polling, re-read the .out after exit — Codex writes findings async**; do NOT use a `tee` pipe — it SIGPIPE-aborted last session; redirect to file).
  - Opus lanes (B/C/D): dispatch via the **Agent tool** (`subagent_type: general-purpose` or `Explore` for read-only), one Agent per lane, in parallel (single message, multiple Agent calls, `run_in_background: true`).
- **Transcripts:** each lane writes a findings transcript to `docs/phase5/megaudit-5-8/lane-{a,b,c,d}.md` (Codex writes directly; for Opus lanes, the Agent returns findings → this assistant writes the transcript). Format: one finding per block — `#`, Finding, Severity (HIGH/MED/LOW/INFO), Files (path:line), Evidence (empirical probe result or cited code), Recommendation.
- **Synthesis (Lane E):** after A–D land, write `docs/phase5/megaudit-5-8/closures.md` — convergent-finding table, severity-ranked, scope-coverage attestation, Phase 5 exit verdict.
- **Closure:** close convergent HIGHs in-cycle (code + regression test). MED/LOW per judgment; defer with explicit rationale. Re-run full test suites after any code change (ql-collab/ql-oplog/ql-collab-ws + IDE mocha).
- **Cycle discipline:** dispatch+transcripts+synthesis is one logical megaudit; closures may span sessions. Respect CLAUDE.md ≤2 plan-implement-audit cycles/session — if closures are large, split across sessions (the prior Phase 5.7 work routinely did this with user-directed overrides). Codex-patience rule applies throughout.
- **No-Fallbacks:** findings must surface real errors; do not let a lane "pass" by swallowing a failed probe.

---

## 5. Acceptance / exit

- All four Phase 5 exit criteria (§1) verified with evidence.
- Zero open HIGH (closed in-cycle or Phase 6 entry explicitly blocked until closed).
- Every risk-register entry confirmed in its claimed state.
- Scope-coverage attestation: every crate (§2.2), every Op variant (§2.3), every CacheEffect (§2.4), every risk (§2.6), every deferred item (§2.7) was touched by ≥1 lane.
- Deliverable: `docs/phase5/5-7-phase-termination-exit-packet.md` (or `docs/phase5/megaudit-5-8/closures.md` as the canonical record) + update `MASTER-PLAN` Phase 5 status to PHASE 5 COMPLETE + update `docs/phase6/entry-plan.md` §3 (gate closed).

---

## 6. Execution checklist (next window: do these in order)

1. `git -C <engine> log --oneline -1` + `git -C <ide> log --oneline -1` → confirm `1465b1db4c4` source / `d028568b53b` IDE (or note drift).
2. `mac zsh -lc 'echo bridge-ok'` → confirm Mac bridge live (needed for Codex + cargo).
3. Read this PLAN.md fully + skim `docs/phase6/entry-plan.md`.
4. Dispatch Lane A (Codex, background) + Lanes B/C/D (Opus Agents, background) — single message, parallel.
5. While they run, (optional) pre-read the highest-risk areas (cache walker `apply_cache_effect`; `replay.rs`; the delta path).
6. As each lands: read the FULL transcript (Codex async-write — wait + re-read .out); commit each transcript.
7. Lane E synthesis → `closures.md` → severity-rank → close convergent HIGHs (code+tests) → re-run suites.
8. Write Phase 5 exit packet; flip `MASTER-PLAN` Phase 5 → COMPLETE; flip `docs/phase6/entry-plan.md` §3 gate → CLOSED.
9. Update memory `current_work.md` + `MEMORY.md`.

---

## 7. Lane prompts (verbatim — dispatch as-is)

Prompts live as separate files in this directory for direct dispatch:
- `lane-a-codex.md` — Lane A (Codex; `codex exec < lane-a-codex.md`).
- `lane-b-opus.md` — Lane B (Opus Agent prompt).
- `lane-c-opus.md` — Lane C (Opus Agent prompt).
- `lane-d-contract.md` — Lane D (Opus/Codex Agent prompt).

Each prompt is self-contained (re-states scope + HEAD + output format) so it can be fed verbatim without this PLAN as context. Lane E (synthesis) is performed by the orchestrating assistant per §4.

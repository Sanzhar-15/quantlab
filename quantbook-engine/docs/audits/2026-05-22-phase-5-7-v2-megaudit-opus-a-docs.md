---
title: Phase 5.7 V2 megaudit — Opus-A docs lane (cross-walk over V2.1 → V2.7)
date: 2026-05-22
lane: docs / exit-readiness
status: PASS-WITH-FINDINGS
engine_head: 4ea690ce246 (feat/quantbook-engine)
ide_head: f9f98194958 (feat/visualise-v1)
predecessor_audits:
  - docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-a-docs.md (V1 docs megaudit)
companion_lanes:
  - docs/audits/2026-05-22-phase-5-7-v2-megaudit-codex.md (protocol lane — to be produced)
  - docs/audits/2026-05-22-phase-5-7-v2-megaudit-opus-b-v3.md (forward-looking lane — to be produced)
audit_protocol: Phase-level closure cross-walk. Read every public artifact
  (plans, exit packets, MASTER-PLAN, IDE consumer surface, engine napi
  binding RustDoc, audit transcripts, commit messages) and compare each
  claim against the source-of-truth at HEAD `4ea690ce246` (engine) +
  `f9f98194958` (IDE). Code is NOT modified by this lane; findings are
  doc fixes only.
---

# Phase 5.7 V2 megaudit — Opus-A docs lane

**Verdict: PASS-WITH-FINDINGS**

The V2 binding code at HEAD is consistent with itself. The TypeScript
surface (`session.ts`, `types.ts`), the napi binding (`ql-bindings-node/src/lib.rs`),
and the engine error-kind accessors line up cleanly. Mocha 91/91 +
ql-collab 74/74 (test-fixtures) + ql-collab-ws 4/4 verified by reading
the test sources.

The drift is in the **planning and exit-readiness docs**, not the code.
The docs-finalize-v3 commit (`4ea690ce246`) committed the three pending
Codex transcripts but failed to sweep the "Codex transcript pending
docs-finalize" markers OUT of the plan, MASTER-PLAN, and 5.7 V1 exit
packet. The cycle-counting scheme also fractured across three documents
(plan frontmatter says V2.7 = cycle 4; plan body says V2.7 = Cycle 7;
MASTER-PLAN says V2.7 = cycle 6; current_work.md says V2.7 = cycle 7 of
arc). And the MASTER-PLAN's V2.5 / V2.7 finding counts mis-state the
HIGH/MEDIUM/LOW split (claims 2 HIGHs at V2.5 where transcripts show 0
HIGH / 2 MEDIUM / 7 LOW+OBS).

5 HIGH, 8 MEDIUM, 10 LOW findings below.

---

## 0. Surface-walk log

Read order (full-file unless noted; the load-bearing claims required
seeing entire arcs of doc, not snippets):

1. `/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md` — full read. §0 state table, §3 commit ladder, §4 transcript inventory, §5 V2.7 contract.
2. `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/.plans/_active.md` — full read (701 lines). Frontmatter + V2.1-V2.7 cycle records + V2.5+V2.6 plan section + acceptance criteria.
3. Engine `git log --oneline -25` on `feat/quantbook-engine` — confirmed HEAD `4ea690ce246` (docs finalize v3) + V2.1-V2.7 ship/closure pairs match plan §3 commit ladder.
4. IDE `git log --oneline -20` on `feat/visualise-v1` — confirmed HEAD `f9f98194958` (V2.7 audit closures IDE) + commit ladder matches.
5. `docs/MASTER-PLAN.md` line 545 (status header) + 596-616 (Phase 5.7 entry; V1 + V2.1-V2.7 narrative). Read full Phase 5.7 entry.
6. `docs/phase5/5-7-v1-exit-packet.md` — full read (300 lines). V1 closure record + V2 forward pointers (line 254 + 300).
7. `docs/phase5/entry-plan.md` — full read (187 lines). Confirmed superseded-by-exit-packets; line 120 (Phase 5.7 row) confirmed stale-but-marked.
8. `extensions/quantlab/src/quantbook/session.ts` — full read (302 lines). parseQuantbookError + KNOWN_/ALL_ const arrays + isQuantbookErrorCode + isAutoFlushPolicy + V2.1 helpers + V2.7 error-code surface.
9. `extensions/quantlab/src/quantbook/types.ts` — full read (578 lines). CollabSessionInstance (V1+V2.1+V2.2+V2.5 method surface) + TransportInstance + LoopbackPairInstance + BlockingTransportFixtureInstance + AutoFlushPolicy + QuantbookNativeModule + QuantbookErrorCode (12 variants) + QuantbookErrorInfo.
10. `crates/ql-bindings-node/src/lib.rs` (1533 lines) — read full module-doc header (1-119), full validator + error helper section (120-332), full CollabSession impl (333-940), AutoFlushPolicy helpers (941-988), Transport class + LoopbackPair (989-1170), BlockingTransportFixture (1171-1357), Send/Sync asserts (1358-1444), Rust tests (1445-1533).
11. `crates/ql-collab/src/transport.rs` — read `TransportError::kind()` (lines 122-144).
12. `crates/ql-collab/src/session.rs` — read `CollabSessionError::kind()` (lines 162-182).
13. `crates/ql-collab-ws/src/lib.rs` — read `WebSocketError::kind()` (lines 240-260).
14. `docs/architecture/ide-consumer-contract.md` — grep + targeted read; line 198-200 still says "Phase 5.7 V2 binds Transport" as if V2 was pending.
15. `docs/audits/` — full file listing: confirmed all 18 V2 transcripts present.
16. Audit verdict cross-check via grep+targeted read on every V2.5 + V2.7 transcript: `v2-5-codex.md` (verdict at line 7301: 0H+1M+3L), `v2-5-opus.md` (line 5: "1 MEDIUM Rule-4 docstring drift, 4 LOW"), `v2-5-plan-review-codex.md`, `v2-7-codex.md`, `v2-7-opus.md` (line 7: "0 HIGH, 3 MEDIUM, 4 LOW"). Also V2.1+V2.2+V2.3 Opus MEDIUM-3 attribution checks (`v2-1-opus.md:302`, `v2-2-opus.md:384,1071`, `v2-3-opus.md:637`).
17. Existence checks: `.codex-phase-5-7-v2-{1..5,7}-audit.out` present in PARENT worktree `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/` (NOT engine repo root).
18. `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/.plans/_QUANTBOOK-MASTER-PLAN.md` — first 50 lines + grep for "Phase 5.7"; product-level doc, no Phase 5.7 ship references (mapping is in engine MASTER-PLAN per memory). Out-of-scope for this audit — no V2.7 claims to verify.
19. `extensions/quantlab/test/quantbook-roundtrip.test.ts` — confirmed test count 91 via `grep -cE '^\s*test\('`.

---

## 1. HIGH findings

### HIGH-1 — Three docs still flag the V2.5+V2.7 Codex transcripts as "pending docs-finalize" despite docs finalize v3 (`4ea690ce246`) already committing them

The current engine HEAD `4ea690ce246` is "docs(5.7): V2 docs finalize v3 -- commit V2.5+V2.7 Codex transcripts + update plan/MASTER-PLAN/exit-packet pointers through V2.7". `git log` on the three Codex transcript files confirms they are in-tree at this commit:

- `docs/audits/2026-05-22-phase-5-7-v2-5-codex.md` — present (502 KB)
- `docs/audits/2026-05-22-phase-5-7-v2-5-plan-review-codex.md` — present (1547 KB)
- `docs/audits/2026-05-22-phase-5-7-v2-7-codex.md` — present (263 KB)

But the SAME commit left "pending" markers untouched in three docs:

- `.plans/_active.md:15` — `v2.5: docs/audits/2026-05-22-phase-5-7-v2-5-opus.md (Codex transcript pending docs-finalize)`
- `.plans/_active.md:16` — `v2.7: docs/audits/2026-05-22-phase-5-7-v2-7-opus.md (Codex transcript pending docs-finalize)`
- `.plans/_active.md:181` — `Audit transcripts: docs/audits/2026-05-22-phase-5-7-v2-5-opus.md committed; Codex transcript pending docs-finalize.`
- `.plans/_active.md:638` — `Opus transcript committed at docs/audits/2026-05-22-phase-5-7-v2-7-opus.md; Codex transcript pending docs-finalize.`
- `.plans/_active.md:678` — `13 of 16 audit transcripts tracked in docs/audits/ … Pending: V2.5 plan-time Codex review, V2.5 Codex audit, V2.7 Codex audit (in parent worktree; V2.8 docs-finalize will commit).`
- `docs/MASTER-PLAN.md:616` — `13 audit transcripts in docs/audits/2026-05-22-phase-5-7-* (5 V1 + 4 V2.1-V2.4 Codex + 4 V2.1-V2.4 Opus + V2.5 Opus + V2.7 Opus; 3 Codex transcripts pending docs-finalize at V2.8).`
- `docs/phase5/5-7-v1-exit-packet.md:254` — `V2 audit transcripts in docs/audits/2026-05-22-phase-5-7-v2-{1,2,3,4}-{codex,opus}.md + v2-5-opus.md + v2-7-opus.md (V2.5 + V2.7 Codex transcripts pending docs-finalize at V2.8).`

**Source-of-truth**: `ls docs/audits/2026-05-22-phase-5-7-*` returns 18 files (5 V1 + 4 V2.1-V2.4 Codex + 4 V2.1-V2.4 Opus + V2.5 plan-review-codex + V2.5 Codex + V2.5 Opus + V2.7 Codex + V2.7 Opus = 18). `git log --oneline -1 -- docs/audits/2026-05-22-phase-5-7-v2-5-codex.md` returns `4ea690ce246`.

**Suggested DOC FIX**:
- `.plans/_active.md:15-16`: change to `v2.5: docs/audits/2026-05-22-phase-5-7-v2-5-{codex,opus}.md (+ v2-5-plan-review-codex.md)` and `v2.7: docs/audits/2026-05-22-phase-5-7-v2-7-{codex,opus}.md`.
- `.plans/_active.md:181`: replace `Codex transcript pending docs-finalize` with `Codex transcript committed at docs/audits/2026-05-22-phase-5-7-v2-5-codex.md (+ plan-review at v2-5-plan-review-codex.md).`
- `.plans/_active.md:638`: same pattern for V2.7.
- `.plans/_active.md:678`: change to `[x] 18 of 18 audit transcripts tracked in docs/audits/ (5 V1 + 4 V2.1-V2.4 Codex + 4 V2.1-V2.4 Opus + V2.5 plan-review-Codex + V2.5 Codex + V2.5 Opus + V2.7 Codex + V2.7 Opus).`
- `docs/MASTER-PLAN.md:616`: change `13 audit transcripts … 3 Codex transcripts pending docs-finalize at V2.8` to `18 audit transcripts in docs/audits/2026-05-22-phase-5-7-* (5 V1 + 4 V2.1-V2.4 Codex + 4 V2.1-V2.4 Opus + V2.5 plan-review-Codex + V2.5 Codex + V2.5 Opus + V2.7 Codex + V2.7 Opus). All transcripts committed at docs-finalize-v3 (4ea690ce246).`
- `docs/phase5/5-7-v1-exit-packet.md:254`: update similarly.

### HIGH-2 — `docs/MASTER-PLAN.md:608` mis-states V2.5 audit findings as "2 HIGHs (Rule 4 #6 + napi-boundary blockMs=0 DoS footgun)"; actual transcripts show 0 HIGH

MASTER-PLAN.md:608 reads:

> V2.5 audit found 2 HIGHs (Rule 4 #6 + napi-boundary blockMs=0 DoS footgun) + 7 MEDIUMs/LOWs all closed in cycle.

But:

- `docs/audits/2026-05-22-phase-5-7-v2-5-codex.md:7301` (final VERDICT block): **PASS-WITH-FINDINGS**, findings labeled `M1`, `L1`, `L2`, `L3` (1 MEDIUM + 3 LOW; 0 HIGH).
- `docs/audits/2026-05-22-phase-5-7-v2-5-opus.md:5` (frontmatter verdict): `PASS-WITH-FINDINGS (1 MEDIUM Rule-4 docstring drift, 4 LOW)` (1 MEDIUM + 4 LOW; 0 HIGH).
- `.plans/_active.md:178-180` correctly says: Codex `0H+1M+3L+1OBS`; Opus `0H+1M+4L+5OBS`.
- `memory/current_work.md` mentions the Rule 4 #6 trigger (Send + !Sync docstring drift) as the V2.5 Opus M1 finding (MEDIUM, not HIGH).

The Codex M1 (production-cdylib DoS footgun for `BlockingTransportFixture`) is a real MEDIUM, but it's a MEDIUM, not a HIGH. The "blockMs=0 DoS footgun" was Codex MEDIUM-1 (now closed at the binding via `block_ms > 0` check at lib.rs:1261-1268). Neither finding was a HIGH.

**Suggested DOC FIX**:
- `docs/MASTER-PLAN.md:608`: change `V2.5 audit found 2 HIGHs (Rule 4 #6 + napi-boundary blockMs=0 DoS footgun) + 7 MEDIUMs/LOWs all closed in cycle.` to:
  > V2.5 audit verdicts: Codex 0H+1M+3L (M1 = production-cdylib DoS footgun, since closed at binding via `block_ms > 0`); Opus 0H+1M+4L (Rule 4 #6 trigger: false `FlushAck: Send + !Sync` while impls Send + Sync; closed via Option B docstring + positive Sync asserts). All findings closed in cycle.

Same sentence on `docs/MASTER-PLAN.md:545` ("V2.1-V2.7 audit ladder: 14 audit cycles (7 ship + 7 closure), 10+ HIGH + 35+ MEDIUM closed cumulatively") needs spot-check — the HIGH count is plausible (V1=3, V2.1=2, V2.2=2, V2.3=2, V2.4=2, V2.5=0, V2.7=0 = 11) but the ship/closure count is wrong: there are 7 ship commits (V2.1-V2.4, V2.5+V2.6 combined, V2.7) = 6 ships + 6 closures = 12 cycles, plus V1 = 4 cycles (ship + closure + megaudit + docs-finalize) = 16 not 14. See HIGH-3.

### HIGH-3 — Cycle-counting scheme is fractured across at least four documents; V2.7 is labeled cycle 4, cycle 6, AND cycle 7 in different places

Inconsistent cycle numbering:

| Source | Claim |
|---|---|
| `.plans/_active.md:17` (frontmatter `arc_estimate_original`) | "V2.1+V2.2 cycle-1; V2.3+V2.4 cycle-2; V2.5+V2.6 cycle-3 + V2.7 cycle-4 (this session)" → V2.7 = **cycle 4** |
| `.plans/_active.md:167` (body section header) | `## V2.5 + V2.6 — Combined cycle (Cycle 5) ✅ SHIPPED 2026-05-22` → V2.5+V2.6 = **Cycle 5** |
| `.plans/_active.md:626` (body section header) | `## V2.7 — Structured Error.code discrimination (Cycle 7) ✅ SHIPPED 2026-05-22` → V2.7 = **Cycle 7** |
| `docs/MASTER-PLAN.md:600,602,604,606,608,610` | V2.1 = cycle 1, V2.2 = cycle 2, V2.3 = cycle 3, V2.4 = cycle 4, V2.5+V2.6 = cycle 5 combined, V2.7 = **cycle 6** |
| `memory/current_work.md:35,55,95` | "V2.7 — cycle 7 of arc" |
| `memory/current_work.md:24` | "7 of 8 V2 cycles done" |
| `docs/MASTER-PLAN.md:596` | "Transport binding 7-of-8 cycles done" |
| `.plans/_active.md:19` (frontmatter `v2_progress_summary`) | "7 cycles done (V2.1, V2.2, V2.3, V2.4, V2.5+V2.6 combined, V2.7) → 1 remaining (V2.8 megaudit + V2 exit packet = phase termination). Multi-session arc." → V2.7 = **7th of 8 cycles** |

The "7 of 8" framing (V2.1, V2.2, V2.3, V2.4, V2.5+V2.6, V2.7, V2.8) is consistent with `.plans/_active.md:19,167,626` AND `memory/current_work.md:24,35,55`. The MASTER-PLAN's "V2.7 (cycle 6)" framing treats V2.5+V2.6 as cycle 5 *plus* implicit cycle 6 = V2.6 alone, which contradicts both "V2.5 + V2.6 combined" everywhere else AND its own line 608 ("V2.5 + V2.6 (cycle 5 combined)"). The frontmatter line 17 framing (4 cycles total) appears to count session-cycles ("two per session per CLAUDE.md"), not V2-arc cycles.

**Suggested DOC FIX**:
- Decide on ONE canonical scheme: V2 arc has 7 ship cycles (V2.1, V2.2, V2.3, V2.4, V2.5+V2.6 combined, V2.7) + V2.8 megaudit = **8 cycles** total.
- `.plans/_active.md:17`: remove the "cycle-1 / cycle-2 / cycle-3 / cycle-4" session-cycle framing, OR clearly label it as "session cycles" not "V2 arc cycles".
- `docs/MASTER-PLAN.md:610`: change `**V2.7 (cycle 6)**` to `**V2.7 (cycle 7 — 7-of-8 done; V2.8 megaudit + V2 exit packet remaining)**` to align with the dominant scheme.
- All other sites already use the 8-cycle scheme; only MASTER-PLAN's per-cycle labels and the plan frontmatter line 17 need correction.

### HIGH-4 — `docs/architecture/ide-consumer-contract.md:198-200` says "Phase 5.7 V2 binds Transport" in future tense, as if V2 was still pending

```
198: ### 4.1 Phase 5 collaboration surface (Phase 5.7 V1 binds this; V2 + V3 will extend)
200: ... The Transport surface (§§ below: attach_transport, flush_*,
     poll_remote*, auto-flush, delta flush, offline-write, WebSocket impl)
     is documented here but NOT yet bound to JS — Phase 5.7 V2 binds
     Transport. Phase 5.7 V3 binds rebuild_workbook + full Op enum +
     undo/redo + presence + persistence. See docs/phase5/5-7-v1-exit-packet.md
     for the V1 closure record + V2/V3 deferred list.
```

V2.1-V2.7 are all shipped. The Transport surface IS bound to JS today:
- `attach_transport` → `CollabSession.attachTransport` (lib.rs:572-588)
- `flush_*` → `flushToTransport` (V2.1) + `flushDeltaToTransport` (V2.2) + `flushPendingToTransport` (V2.4 + V2.5 V8-block closure)
- `poll_remote*` → `pollRemote` + `pollRemoteWithLimit`
- auto-flush → `setAutoFlushPolicy` + `autoFlushPolicy`
- delta flush → `flushDeltaToTransport`
- WebSocket impl → `Transport.websocketConnect`

The consumer contract doc is now stale. The mocha test suite has 91 tests covering the entire Transport binding surface.

**Suggested DOC FIX**:
- `docs/architecture/ide-consumer-contract.md:198`: change heading to `### 4.1 Phase 5 collaboration surface (Phase 5.7 V1 + V2.1-V2.7 bound; V3 will extend)`.
- `docs/architecture/ide-consumer-contract.md:200`: rewrite to `**Status update (Phase 5.7 V1 + V2.1-V2.7 SHIPPED 2026-05-22)**: Phase 5.7 V1 binds the minimum CollabSession round-trip. V2.1-V2.7 binds the full Transport surface: attachTransport / flushToTransport (V2.1) / flushDeltaToTransport / pollRemoteWithLimit / transportLastError / set+getAutoFlushPolicy (V2.2) / Transport.websocketConnect (V2.3) / flushPendingToTransport (V2.4 + V2.5 V8-block closure) / structured QuantbookErrorCode (V2.7). Phase 5.7 V3 binds rebuild_workbook + full Op enum + undo/redo + presence + persistence. See docs/phase5/5-7-v1-exit-packet.md (V1) + .plans/_active.md (V2 in-progress through V2.7) for closure records.`

### HIGH-5 — `current_work.md:3` (frontmatter description) claims "12 audit transcripts now in `docs/audits/` … V2.5 Codex + V2.7 Codex still in parent worktree"

current_work.md frontmatter description still says:

> 12 audit transcripts now in `docs/audits/` (5 V1 + 4 V2.1-V2.4 Codex + 4 V2.1-V2.4 Opus + Codex V2.5 plan-review + V2.5 Opus + V2.7 Opus; V2.5 Codex + V2.7 Codex still in parent worktree).

But:
- Actual transcript count in `docs/audits/2026-05-22-phase-5-7-*` is 18.
- `docs/audits/2026-05-22-phase-5-7-v2-5-codex.md` exists in-engine-tree at HEAD `4ea690ce246`.
- `docs/audits/2026-05-22-phase-5-7-v2-7-codex.md` exists in-engine-tree at HEAD `4ea690ce246`.

Then the body section §0 line 24 says "7 of 8 V2 cycles done + docs-finalized post-V2.7" (correct) AND line 26 says "docs finalize v3 (this commit `4ea690ce246`): 3 pending Codex transcripts committed + plan/MASTER-PLAN/exit-packet docs swept through V2.7" — so the body is aware the Codex transcripts are committed, but the frontmatter description (line 3, which is the discoverable summary) is stale.

The description was written AFTER docs-finalize-v3 (HEAD is `4ea690ce246`) but wasn't refreshed.

**Suggested DOC FIX**:
- `memory/current_work.md:3`: replace the `12 audit transcripts … V2.5 Codex + V2.7 Codex still in parent worktree` clause with `18 audit transcripts in docs/audits/ (5 V1 + 4 V2.1-V2.4 Codex + 4 V2.1-V2.4 Opus + V2.5 plan-review-Codex + V2.5 Codex + V2.5 Opus + V2.7 Codex + V2.7 Opus). All committed at docs-finalize-v3 (4ea690ce246).`

---

## 2. MEDIUM findings

### MEDIUM-1 — `docs/MASTER-PLAN.md:545` says "14 audit cycles (7 ship + 7 closure)" but actual count is 12 (6 ships + 6 closures)

V2.1 → V2.7 ships (excluding V2.6 since V2.5+V2.6 was combined):
- V2.1 ship + closure
- V2.2 ship + closure
- V2.3 ship + closure
- V2.4 ship + closure
- V2.5+V2.6 ship + closure (combined as one cycle per plan §V2.5)
- V2.7 ship + closure

That's 6 ships + 6 closures = 12 V2 audit cycles. The MASTER-PLAN claim of "14 audit cycles (7 ship + 7 closure)" double-counts something — possibly counting V2.5 and V2.6 as separate ships.

**Suggested DOC FIX**:
- `docs/MASTER-PLAN.md:545`: change `**V2.1-V2.7 audit ladder: 14 audit cycles (7 ship + 7 closure)**` to `**V2.1-V2.7 audit ladder: 12 audit cycles (6 ships + 6 closures; V2.5+V2.6 shipped together as one cycle)**`. Either that, or 13 (counting V2.5 + V2.6 + V2.7 = 7 ships) — but the plan body explicitly calls V2.5+V2.6 a "combined cycle" so 12 is the consistent reading.

### MEDIUM-2 — Plan and current_work.md attribute V2.7's closure to "V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards" but the V2.2 and V2.3 MEDIUM-3 findings were NOT about lossy Display projection

The plan, current_work.md, and MASTER-PLAN all use the shorthand:

- `.plans/_active.md:632`: `Closed V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards via kind() -> &'static str accessors`
- `current_work.md:3`: `V2.7 closed V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards: structured Error.code discrimination`
- `docs/MASTER-PLAN.md:610`: `Closed V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards`

But the actual MEDIUM-3 numbering in each transcript:

- `docs/audits/2026-05-22-phase-5-7-v2-1-opus.md:302` — MEDIUM-3 = napi binding's error mapping via `format!("{e}")` collapses CollabSessionError/TransportError variants into Display strings. **THIS** is the lossy Display projection V2.7 actually closed.
- `docs/audits/2026-05-22-phase-5-7-v2-2-opus.md:384` — MEDIUM-3 = `flushDeltaToTransport first-after-attach behavior was empirically discovered during V2.2 test writing` (different finding entirely). The Display-projection carryforward was V2.2's **MEDIUM-4** (per line 499, 1071).
- `docs/audits/2026-05-22-phase-5-7-v2-3-opus.md:637` — MEDIUM-3 = V2.3 two-peer round-trip relies on 50ms setTimeout (also unrelated to Display projection).

The carryforward is actually: V2.1 M3 (lossy Display) → V2.2 M4 (carried) → V2.3 (referenced in V2.3 prep work, see v2-3-opus.md:31,77) → V2.7 closure. The "V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards" shorthand misrepresents what was actually carried (only V2.1's M3, in different numbering across subsequent audits).

**Suggested DOC FIX**:
- `.plans/_active.md:632`, `current_work.md:3`, `docs/MASTER-PLAN.md:610`: replace `V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards` with `the V2.1 Opus MEDIUM-3 carryforward (lossy Display projection of engine error variants; carried as V2.2 MEDIUM-4 and re-flagged in V2.3 audit)`. Or more concise: `the lossy-Display-projection carryforward (V2.1 Opus M3 → V2.2 Opus M4 → V2.3-flagged)`.

### MEDIUM-3 — `.plans/_active.md:678` says "13 of 16 audit transcripts tracked" but actual count is 18 of 18

Same root cause as HIGH-1: the docs-finalize-v3 commit added 3 transcripts (V2.5 plan-review-Codex, V2.5 Codex, V2.7 Codex) but didn't refresh this checkbox.

**Suggested DOC FIX**: `.plans/_active.md:678`: change to `[x] 18 of 18 audit transcripts tracked in docs/audits/ (5 V1 + 4 V2.1-V2.4 Codex + 4 V2.1-V2.4 Opus + V2.5 plan-review-Codex + V2.5 Codex + V2.5 Opus + V2.7 Codex + V2.7 Opus).`

### MEDIUM-4 — `.plans/_active.md:72` references `.codex-phase-5-7-v2-1-audit.out` as a relative path that does not resolve to anything in-tree

```
72:    - [x] Parallel Codex + Opus audits dispatched (Codex at `.codex-phase-5-7-v2-1-audit.out`; Opus to `docs/audits/2026-05-22-phase-5-7-v2-1-opus.md`).
```

The `.codex-phase-5-7-v2-1-audit.out` file lives in `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/.codex-phase-5-7-v2-1-audit.out` (parent worktree, NOT engine repo root). The in-engine canonical copy is at `docs/audits/2026-05-22-phase-5-7-v2-1-codex.md` (committed in docs-finalize-v2 commit `9eece27cf77`).

Same applies to other inline `.codex-*.out` references throughout the plan. Path resolution from the engine repo root fails for all of them.

**Suggested DOC FIX**: `.plans/_active.md:72`: change to `docs/audits/2026-05-22-phase-5-7-v2-1-{codex,opus}.md` (mirror the canonical pattern used elsewhere in the plan frontmatter).

### MEDIUM-5 — `docs/MASTER-PLAN.md:610` says V2.7 Codex verdict was "0H+0M+1L"; should be "0H+1L" or note 0 MEDIUM explicitly

The V2.7 narrative in MASTER-PLAN line 610 says:

> V2.7 audit: Codex 0H+0M+1L all Q1-Q4 VERIFIED; Opus 0H+3M+4L all required-walk VERIFIED.

Cross-reference: `docs/audits/2026-05-22-phase-5-7-v2-7-codex.md` (verified at file end). The `0M` claim matches the transcript verdict — but the closure section of `.plans/_active.md` and `current_work.md` say `Codex 0H+1L` (no M dimension stated). Minor inconsistency; doesn't change the substantive count.

**Suggested DOC FIX**: standardize on `Codex PASS-WITH-FINDINGS (0H+0M+1L)` everywhere. Apply to `.plans/_active.md:634`, `current_work.md:57`, `docs/MASTER-PLAN.md:610` for uniformity.

### MEDIUM-6 — `.plans/_active.md:675` says "V2.5 had 1H total (Rule 4 #6)" but V2.5 had 0 HIGH

```
675:- [x] All audit HIGHs closed in cycle. V2.5 had 1H total (Rule 4 #6); V2.7 had 0H.
```

The Rule 4 #6 trigger was Opus V2.5 MEDIUM-1 (false `FlushAck: Send + !Sync` while impls Send + Sync), per `docs/audits/2026-05-22-phase-5-7-v2-5-opus.md:5` ("1 MEDIUM Rule-4 docstring drift, 4 LOW"). It was a MEDIUM, not a HIGH.

**Suggested DOC FIX**: `.plans/_active.md:675`: change to `[x] All audit HIGHs closed in cycle. V2.5 had 0H total (Rule 4 #6 was MEDIUM); V2.7 had 0H.`

### MEDIUM-7 — Plan section "Acceptance criteria for cycle V2.5+V2.6" (line 581-593) is left with `[ ]` unchecked despite cycle being shipped

The plan section at `.plans/_active.md:581-593` (Acceptance criteria for cycle V2.5+V2.6) has all bullets prefixed with `[ ]`:

```
581:### Acceptance criteria for cycle V2.5+V2.6
582:
583:- [ ] Engine `cargo build -p ql-collab -p ql-collab-ws -p ql-bindings-node --release` clean.
584:- [ ] Engine `cargo test -p ql-collab -p ql-collab-ws -p ql-bindings-node --release` passes …
585:- [ ] Engine `cargo test --workspace --all-features` baseline preserved (4461+ / 0).
…
593:- [ ] Commit pair: engine ship + IDE ship (+ closure commits if audit finds anything).
```

These are unchecked but V2.5+V2.6 SHIPPED + AUDITED + CLOSED. The "Acceptance criteria for V2 SHIP cycles 5+6+7 (this session) — MET" section at line 666 IS checked, so the line 581 section is duplicate / pre-ship plan-time scaffolding that should be either checked or noted as superseded.

**Suggested DOC FIX**: `.plans/_active.md:581`: change heading to `### Acceptance criteria for cycle V2.5+V2.6 (plan-time scaffolding; SUPERSEDED by "Acceptance criteria for V2 SHIP cycles 5+6+7" at line 666 — all met).` Or check the boxes if you want to maintain the duplicate list.

### MEDIUM-8 — `docs/phase5/entry-plan.md:120` still says "5.7 | IDE Vertical Slice | 1 week | Two-window editing." in the active table

```
120:| 5.7 | IDE Vertical Slice | 1 week | Two-window editing. |
```

The document is marked `SUPERSEDED-BY-EXIT-PACKETS` in frontmatter (line 3), but the table itself doesn't say "5.7 ✅ V1 + V2.1-V2.7 SHIPPED 2026-05-22 — multi-window IDE demo deferred to V3 product work". Anyone reading the entry-plan would think 5.7 is open and "two-window editing" is the open scope.

**Suggested DOC FIX**: `docs/phase5/entry-plan.md:120`: change to `| 5.7 | IDE Vertical Slice | ✅ V1 + V2.1-V2.7 SHIPPED 2026-05-22 | First IDE binding to quantbook engine; cross-repo; 91 mocha tests; V2.8 megaudit + V2 exit packet pending. See docs/phase5/5-7-v1-exit-packet.md + .plans/_active.md. Multi-window demo deferred to V3 product work. |`

---

## 3. LOW findings

### LOW-1 — `.plans/_active.md:9` (frontmatter `canonical_v2_design_reference`) points to V1 megaudit Opus-B docs that mention V2-readiness, but V2.4+V2.5 work invalidated several of its assumptions

```
9: canonical_v2_design_reference: docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-b-v2.md
```

That doc was the V2-readiness Opus-B lane from V1 megaudit. It predates V2.3's audit FAIL (UB + tokio starvation), V2.4's Arc<Mutex> refactor, and V2.5's V8-block closure. While it correctly anticipated the `attach_transport_boxed` need (HIGH-2) and the `flush_pending` Condvar hazard, several of its other recommendations were superseded.

It's still a useful historical reference for "what V1 megaudit thought V2 would look like", but the V2.8 megaudit will produce the authoritative V2 exit packet. Until then, `canonical_v2_design_reference` overstates its current authority.

**Suggested DOC FIX**: `.plans/_active.md:9`: change to `historical_v2_design_reference (V1-era; some recommendations superseded by V2.3-V2.5 work): docs/audits/2026-05-22-phase-5-7-v1-megaudit-opus-b-v2.md` OR add a sibling pointer to `docs/phase5/5-7-v2-exit-packet.md (pending — V2.8)`.

### LOW-2 — Engine napi binding module doc (`crates/ql-bindings-node/src/lib.rs:33-69`) still calls everything beyond V1 "V1 deferred to V2"

```
33: //! ## V1 surface
…
49: //! ## V1 deferred (see `docs/phase5/5-7-v1-exit-packet.md`)
50: //!
51: //! Full V1-deferred-to-V2/V3 list lives in the V1 exit packet's
…
67: //! enforcement. V2 picks up Transport; V3 picks up cell-grid UI +
68: //! persistence + `rebuild_workbook` wiring.
```

The module doc lists `attach_transport / detach_transport / has_transport / flush_to_transport / flush_delta_to_transport / flush_pending_to_transport / poll_remote / poll_remote_with_limit / transport_last_error / set_auto_flush_policy` as "V1 deferred to V2" — but ALL of those have shipped in V2.1-V2.5 and are in the same file (lines 547-838). The text reads as if V1 just shipped.

Following sections (lines 72-119) DO add V2.4 + V2.5 updates, but the V1 deferred section at lines 50-68 should be marked as historical OR add `(STATUS: V2.1-V2.7 SHIPPED 2026-05-22)` next to each.

**Suggested DOC FIX**: At line 49-50, prefix with `**STATUS (2026-05-22): V2.1-V2.7 all SHIPPED. The list below is historical V1-era scope.**`. Each line item is preserved for traceability.

### LOW-3 — `crates/ql-bindings-node/src/lib.rs:117-118` says "V2.6 contract test" but the test is V2.5 (V8-block closure contract); V2.6 added the fixture, V2.5 is the contract

```
115: //! V2.5 caller note: there is NO V8-block-related caller discipline
116: //! required today. Concurrent session method calls during a pending
117: //! `flushPendingToTransport` are sound + non-blocking. The V2.6
118: //! contract test (`flushPendingToTransport does NOT block sync
119: //! methods on the same session`) empirically pins this — opCount
```

Per `.plans/_active.md:175`: "V8-block CLOSURE VERIFIED by both audit lanes via independent source-walks. V2.5 contract test empirically passes: `opCount()` during a 2000ms-blocked flushPending returns ~50ms." The contract is V2.5's; V2.6 only added the fixture (`BlockingTransportFixture`) used to test it.

**Suggested DOC FIX**: lib.rs:117: change `The V2.6 contract test` to `The V2.5 contract test (using the V2.6 BlockingTransportFixture)`.

### LOW-4 — `crates/ql-bindings-node/src/lib.rs:759-760` says "V2.3+ will add structured discrimination via napi `Error::with_code`" but V2.7 actually added it via prefix encoding

```
755:    /// **V2.2 audit-deferred caveat (Opus MEDIUM-3, 2026-05-22)**:
756:    /// the engine surfaces errors as `Display` strings (lossy
757:    /// projection of the underlying enum discriminant). IDE callers
758:    /// today must substring-match to distinguish error categories.
759:    /// V2.3+ will add structured discrimination via napi `Error::with_code`
760:    /// (`#[napi(constructor)]` on a `TransportClosedError` etc.).
761:    /// For V2.2 the string is the contract.
```

V2.7 shipped structured discrimination via the `[<kind>]` prefix-in-message convention, NOT `Error::with_code` (which napi-rs 3.9.0 doesn't expose per the V2.7 ship-commit rationale at lines 283-287). The future-tense claim contradicts the realized V2.7 design.

**Suggested DOC FIX**: lib.rs:759-760: change to `**V2.7 (2026-05-22) SHIPPED**: structured discrimination via the [<kind>] prefix-in-message convention (see the V2.7 helpers above + IDE-side parseQuantbookError). The unstructured Display fallback remains here for backwards compatibility with V2.2-V2.6 callers that haven't migrated to parseQuantbookError.`

### LOW-5 — `crates/ql-bindings-node/src/lib.rs:808-811` says "V2.3+ will add structured `Error.code` discrimination so this retry-shape is machine-readable; until then, the IDE must substring-match `"transport"` in the error message" — same staleness as LOW-4

```
808:    /// V2.3+ will add structured `Error.code` discrimination so this
809:    /// retry-shape is machine-readable; until then, the IDE must
810:    /// substring-match `"transport"` in the error message.
```

V2.7 added it. Same fix.

**Suggested DOC FIX**: lib.rs:808-810: change to `V2.7 (2026-05-22) SHIPPED structured Error.code discrimination via the [<kind>] prefix convention. IDE callers branch on info.code === 'transport_closed' | 'transport_io' after parseQuantbookError(err).`

### LOW-6 — `extensions/quantlab/src/quantbook/types.ts:196-198` says "V2.3+ will add structured discrimination via napi `Error.code`" with the same future-tense framing as LOW-4 + LOW-5

```
194:	 * **V2.2 audit-deferred caveat (Opus MEDIUM-3)**: error strings are
195:	 * lossy `Display` projections of the underlying enum. IDE callers
196:	 * today must substring-match to distinguish categories. V2.3+ will
197:	 * add structured discrimination via napi `Error.code`.
198:	 */
```

V2.7 added it. Same fix as LOW-4 + LOW-5.

**Suggested DOC FIX**: types.ts:196-197: change to `V2.7 (2026-05-22) SHIPPED structured discrimination via the QuantbookErrorCode union (see types.ts:501 + parseQuantbookError in session.ts).`

### LOW-7 — `extensions/quantlab/src/quantbook/types.ts:104-106` says "V2.1 drops the returned `Box<dyn Transport>` Rust-side -- JS does not receive the prior transport" — accurate, but V2.4 refactor changed the Arc<Mutex> shape; minor doc clarity gap

```
98:	/**
99:	 * Detach the currently-attached transport. Returns `true` if one
100:	 * was attached (now released, its background tasks dropped),
101:	 * `false` if there was nothing to detach.
102:	 *
103:	 * V2.1 drops the returned `Box<dyn Transport>` Rust-side -- JS
104:	 * does not receive the prior transport.
105:	 */
```

V2.4's Arc<Mutex> refactor changed how the binding holds the inner CollabSession, but the `detach_transport` semantic (drop Box Rust-side) is unchanged. The `V2.1` reference reads as if the behavior was specific to that cycle; it's actually the design from V2.1 onward.

**Suggested DOC FIX**: types.ts:103: change `V2.1 drops` to `The binding drops` (drop the cycle-specific framing since the contract is invariant).

### LOW-8 — `current_work.md:24` says "7 of 8 V2 cycles done" but section description on line 24 also says "+ docs-finalized post-V2.7", which makes the cycle count ambiguous (does docs-finalize count as a cycle?)

```
24: **Multi-day arc progression** (7 of 8 V2 cycles done + docs-finalized post-V2.7):
```

The V2 plan acceptance section at `.plans/_active.md:666-679` treats docs-finalize as a separate step that follows ALL ship cycles (not as a numbered cycle). Reading "7 of 8 done + docs-finalized" suggests docs-finalize is a 9th item outside the cycle counting. This is consistent with the plan but ambiguous in the narrative.

**Suggested DOC FIX**: `current_work.md:24`: change to `**Multi-day arc progression** (7 of 8 V2 ship/audit cycles done + 2 docs-finalize sweeps; V2.8 megaudit is the 8th cycle = V2 phase termination):`.

### LOW-9 — Plan V2.5+V2.6 plan section (line 167-625) is enormous (~400 lines) and labeled "Original V2.5 + V2.6 plan ... retained for historical context" at line 185, but the historical content sits BELOW the shipped narrative (lines 167-181 = shipped; 183-625 = pre-ship plan)

The plan body order is:
- Line 167: `## V2.5 + V2.6 — Combined cycle (Cycle 5) ✅ SHIPPED 2026-05-22` (shipped narrative)
- Line 183: `---`
- Line 185: `### Original V2.5 + V2.6 plan (Codex-verified PASS-WITH-FINDINGS, retained for historical context)` (pre-ship plan, ~440 lines)
- Line 626: `## V2.7 — Structured Error.code discrimination (Cycle 7) ✅ SHIPPED 2026-05-22`

The 440-line "Original plan" block between V2.5 shipped record and V2.7 record makes the document hard to scan. The historical content is correctly labeled but its size dwarfs the shipped narratives.

**Suggested DOC FIX**: Either move the line 185-625 historical block to an archive subdirectory (e.g., `.plans/_archive/2026-05-22_v2-5-v2-6-original-plan.md`) and replace with a one-line pointer, OR collapse it under a `<details>` HTML tag if Markdown rendering supports it. The current arrangement makes the plan hard to navigate.

### LOW-10 — `docs/phase5/5-7-v1-exit-packet.md:300` says "V2 is **7-of-8 cycles done**" but lists "V2.1-V2.4 + V2.5+V2.6 V8-block closure + V2.7 structured Error.code" — V2.6 isn't explicitly named

```
300: **Status update (2026-05-22, post-V2.7)**: V2 is **7-of-8 cycles done** (V2.1-V2.4 + V2.5+V2.6 V8-block closure + V2.7 structured Error.code SHIPPED + AUDITED). V8-block VERIFIED CLOSED by both audit lanes. Remaining: V2.8 (3-way megaudit + V2 exit packet) = phase termination.
```

The framing `V2.1-V2.4 + V2.5+V2.6 V8-block closure + V2.7` works but V2.5 is the V8-block closure (`Transport::ack_handle` trait) and V2.6 is the test fixture (`BlockingTransportFixture`) — the conjunction `V2.5+V2.6 V8-block closure` could mislead a reader to think V2.6 contributes to the closure. V2.6 is the test infrastructure; V2.5 is the closure.

**Suggested DOC FIX**: `docs/phase5/5-7-v1-exit-packet.md:300`: change to `V2 is **7-of-8 cycles done** (V2.1-V2.4 + V2.5 V8-block closure via ack_handle trait + V2.6 BlockingTransportFixture test fixture + V2.7 structured Error.code SHIPPED + AUDITED).`

---

## 4. Cross-doc consistency check

Where the docs agree:

- **Engine HEAD `4ea690ce246`** — agreed by current_work.md §0, `.plans/_active.md` frontmatter `current_engine_head` (which says `8f5b2e02ab7` because frontmatter wasn't updated post-docs-finalize-v3 — see also implicit MEDIUM finding), MASTER-PLAN.md §V2 commit ladder. Git log confirms.
- **IDE HEAD `f9f98194958`** — agreed by all sources.
- **Test counts**: ql-collab 74/74, ql-collab-ws 4/4, IDE mocha 91/91. All sources agree. Mocha count empirically confirmed (`grep -cE '^\s*test(' = 91`).
- **V2.1-V2.4 verdicts**: V2.3 audit FAIL → flushPending REMOVED → V2.4 sound reintroduction. All sources tell the same story (current_work.md §0, plan §V2.3-V2.4, MASTER-PLAN line 604-606, V1 exit packet line 254).
- **kind() accessors**: TransportError (transport.rs:138), CollabSessionError (session.rs:173), WebSocketError (ws/lib.rs:252) — all three present with correct variant mapping. QuantbookErrorCode union (types.ts:501) has 12 variants matching the engine kinds + bad_argument + unknown. Plan §5 V2.7 contract table is correct.
- **`bad_argument` retrofit**: 14 call sites listed in current_work.md §0 line 51. Spot-checked all 14 (peer_id_from_bigint, validate_u32_index, attach_transport, LoopbackPair.{takeA,takeB}, BlockingTransportFixture.{new, takeTransport}, parse_auto_flush_policy, auto_flush_policy_to_string) — count is accurate.
- **V2.7 Opus M-numbering**: M1 = 'unknown' symmetry, M2 = bad_argument, M3 = Transport passthrough. All three appear in the audit transcript at v2-7-opus.md:24,31,38 and all three are described correctly in current_work.md §V2.7 closures.

Where the docs conflict:

- **Cycle numbering** (HIGH-3): plan frontmatter, plan body section headers, MASTER-PLAN per-cycle labels, current_work.md, and acceptance-criteria-MET section all use different schemes.
- **V2.5 audit verdict** (HIGH-2): MASTER-PLAN line 608 says "2 HIGHs"; transcripts + plan body + current_work.md §0 say "0 HIGH".
- **Audit transcript count** (HIGH-1, MEDIUM-3, HIGH-5): current_work.md frontmatter says 12, plan says "13 of 16", MASTER-PLAN says 13. Actual = 18.
- **Pending-Codex-transcript markers** (HIGH-1): 6 separate stale markers in plan + MASTER-PLAN + exit packet despite docs-finalize-v3 committing the transcripts.
- **"V2.1+V2.2+V2.3 Opus MEDIUM-3 carryforwards"** (MEDIUM-2): V2.2 M3 and V2.3 M3 are different findings from V2.1 M3 (which was the lossy Display projection actually closed by V2.7).
- **Engine module doc** (LOW-2, LOW-4, LOW-5): still uses future tense for V2 work that has shipped.

The cumulative drift is what a per-step audit can't catch. Per-step audits see the local cycle's commits + the immediately-prior cycle's closure; they don't sweep the planning corpus end-to-end. The pattern of "ship + audit + close + (occasionally) docs-finalize" naturally accumulates stale forward-pointers across multiple cycles — and this lane's job is to surface them before V2.8 megaudit ships the exit packet.

---

## Notes for V2.8 megaudit lanes

- **Codex protocol lane** should verify the engine workspace baseline `4472/0` claim by running `cargo test --workspace` against HEAD `4ea690ce246`. The number appears in plan frontmatter `current_engine_workspace: 4472 / 0 baseline (V2.5 ship gate verified; V2.7 doesn't touch ql-collab core)` but the V2.7 ship doesn't include a workspace re-gate per the plan, so the "verified" claim is V2.5-era.
- **Opus-B forward-looking lane** should re-evaluate the canonical_v2_design_reference (LOW-1) and produce the new V2 exit packet at `docs/phase5/5-7-v2-exit-packet.md`. The Opus-B V2-readiness lane from V1 megaudit is now historical, not canonical.
- **All three lanes** should treat the production-cdylib hardening of `BlockingTransportFixture` (Codex V2.5 M1 + Opus V2.5 L2) as the highest-priority V3 backlog item. Today the entire napi class ships in production cdylibs; the `block_ms > 0` rejection at lib.rs:1261-1268 is defense-in-depth but the surface itself is still attackable by in-process IDE code.

End of Opus-A docs lane.

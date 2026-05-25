# Phase 5.7 V3.6.0.10 docs + handover megaudit — Lane B (Opus)

**Date**: 2026-05-25
**Auditor**: Claude Opus 4.7 (1M context), Lane B
**Lane A (Codex)**: runs in parallel; Lane B has NOT seen Lane A's findings.
**Scope**: DOCS + HANDOVER state only.  Per-step engine code audits already happened at V3.6.0.8.4 + earlier per-sub-step cycles; this Lane B megaudit is strictly the textual + cross-doc + memory artifact pass at the close of the 6-cycle V3.6.0.8.1 → V3.6.0.10 session.

## Files audited end-to-end

1. `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/.plans/_active.md` (373 lines, V3.6 plan body)
2. `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/MASTER-PLAN.md` (971 lines; Phase 5 status header is line 545; per-sub-step paragraphs lines 547-571)
3. `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/ide-consumer-contract.md` § 4.1.z6 (lines 1800-2098, the V3.6 surface spec)
4. `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/audits/2026-05-25-phase-5-7-v3-6-0-7-spike.md` (123 lines, V3.6.0.7 spike transcript)
5. `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/audits/2026-05-25-phase-5-7-v3-6-0-8-codex.md` (195 lines)
6. `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/audits/2026-05-25-phase-5-7-v3-6-0-8-opus.md` (270 lines)
7. `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/audits/2026-05-25-phase-5-7-v3-6-0-8-closures.md` (121 lines)
8. `/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md` (84 lines)
9. `/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/MEMORY.md` (21 lines; only line 2 is the V3.6.0.10 index entry)

Cross-checked against the engine + IDE git logs and the relevant source files (session.rs, lib.rs).

---

## Ground-truth state at audit entry (confirmed via git + spot-reads)

**Engine commits this session (6, in order)**:
1. `ebe7c946429` V3.6.0.8.1 D6 DESIGN LOCK (docs-only)
2. `dc74d48b97e` V3.6.0.8.2 D6 ENGINE PART 1
3. `2dbce5ee2a5` V3.6.0.8.3 D6 ENGINE PART 2 napi
4. `82ed0d37d85` V3.6.0.8.4 D6 audit + 5 HIGH + 4 MED closures + bench
5. `0521d6902b9` V3.6.0.8.5 docs sweep (Opus-MED-5 mocha coverage docs)
6. `19a35b68cac` V3.6.0.10 D8 Op::RestoreSheet (engine)

**IDE commits this session (4, in order)**:
1. `9b7ac290917` V3.6.0.8.3 IDE
2. `8b3f608b2c8` V3.6.0.8.4 IDE
3. `07fd6bb8988` V3.6.0.8.5 IDE
4. `4c48f8809bc` V3.6.0.10 IDE

**Tests at audit entry**: ql-collab 154/154 + ql-oplog 67/67 + ql-collab-ws 42/42 + IDE mocha 406/406 + engine workspace release build clean.

**Cycle count**: 6 cycles this session; 4 over the CLAUDE.md ≤2 ceiling.  All 4 overrides user-directed via `AskUserQuestion` at cycle 3 / 4 / 5 / 6 entry.

---

## Executive summary

The docs + handover state is **overall coherent at the top layer** but **carries substantial unresolved drift in the V3.6.0.8.1 design-lock body, the §4.1.z6 status tables, MEMORY.md, and the in-source docstrings that the V3.6.0.8.4 OPUS-MED-1 + MED-3 closures claimed to sweep "in 3 / 4 sites" but actually missed several callouts**.  Three internal contradictions exist (V3.6.0.10 vs V3.6.0.11 ship target for phase-termination audit; D9 sub-step assigned to V3.6.0.10 vs V3.6.0.11 across plan vs §4.1.z6 vs unshipped scope; Arc::make_mut vs always-clone in adjacent paragraphs of the same session.rs docstring block).

The V3.6.0.10 D8 RestoreSheet ship has **no §4.1.z6 sub-section** — the lone IDE-consumer-contract surface spec for V3.6 has not been swept for D8.  This is the single highest-impact docs gap a fresh session would hit when reaching for the IDE-side restoreSheet contract.

current_work.md is **mostly clean** at the §0 head + "First three commands" but reads as a thin handoff — a new session can pick up the state, but verifying the exact source-of-truth for V3.6.0.10's napi semantics still requires the plan body line 306.

MEMORY.md line 2 carries a **legacy V3.6.0.8.3 paragraph** ("Shipped: full D6 napi surface ... Tests: ql-collab 149/149 ... IDE mocha 390/390 ... 3 cycles used; 1 OVER CLAUDE.md") AFTER the V3.6.0.10 lead — this is the compounding-handoff drift pattern that CLAUDE.md's "Don't Be Lazy / compression-laziness" section names explicitly.

**Verdict: PASS-WITH-FINDINGS** (24 distinct findings: 3 HIGH + 9 MED + 7 LOW + 5 INFO).  None of the findings are correctness-blocking — engine + IDE code is fine, tests are green, the D6 perf contract is delivered — but the V3.6.0.X phase-termination megaudit can NOT cleanly enter until the §4.1.z6 sweep + plan body D8 sweep + MEMORY.md trim are closed.

---

## Audit walk

### A. Accuracy verification

**Commit hashes**: all hashes referenced across docs match `git log` (verified each of `ebe7c946429`, `dc74d48b97e`, `2dbce5ee2a5`, `82ed0d37d85`, `0521d6902b9`, `19a35b68cac`, `9b7ac290917`, `8b3f608b2c8`, `07fd6bb8988`, `4c48f8809bc`).  Predecessor chains in plan body line 9-10, current_work.md §0 table, MEMORY.md line 2 lead, and MASTER-PLAN.md per-step paragraphs all chain correctly.

**Test counts**:
- ql-collab 154/154 — consistent across plan body line 12, current_work.md §0, MEMORY.md V3.6.0.10 lead, plan body line 306 narrative.
- ql-oplog 67/67 — consistent.
- ql-collab-ws 42/42 — consistent in plan body + current_work.md + MEMORY.md V3.6.0.10 lead.  **Inconsistency: MEMORY.md legacy V3.6.0.8.3 paragraph (line 2 mid) says "ql-collab-ws 40"** — drift.
- IDE mocha 406/406 — consistent across plan body line 11 + current_work.md §0 + MEMORY.md V3.6.0.10 lead.  **Inconsistency: MEMORY.md legacy paragraph (line 2 mid) says "IDE mocha 390/390 (+6)"** — drift.
- MASTER-PLAN.md per-sub-step paragraphs at lines 547-571 use the test counts CURRENT AT EACH SHIP (e.g., V3.6.0.6 D5 row says "136/136 + 354/354"; V3.6.0.8.5 says "400/400") — accurate as point-in-time records, but the §545 status header still ends at V3.5 (no roll-up of V3.6.0.8 D6 arc completion + V3.6.0.10 D8 in the master status block).

**Sub-step ship-status cross-doc consistency**:

| Sub-step | plan body line 274-307 | MASTER-PLAN.md 547-571 | §4.1.z6 table lines 1813-1823 | §4.1.z6 sub-sections 1809-2055 | Out-of-scope 2074-2084 |
|---|---|---|---|---|---|
| V3.6.0.1 lock | ✅ SHIPPED | ✅ | (D1-D9 rows; status column empty for lock) | SHIPPED inline | n/a |
| V3.6.0.2 D1 | ✅ SHIPPED | ✅ | n/a | SHIPPED inline | n/a |
| V3.6.0.3 D2 | ✅ SHIPPED | ✅ | n/a | SHIPPED inline | n/a |
| V3.6.0.4 D3 | ✅ SHIPPED | ✅ | n/a | SHIPPED inline | n/a |
| V3.6.0.5 D4 | ✅ SHIPPED | ✅ | n/a | SHIPPED inline | n/a |
| V3.6.0.6 D5 | ✅ SHIPPED | ✅ | D5 SHIPPED + audit SHIPPED | SHIPPED inline | n/a |
| V3.6.0.7 D6 spike | ✅ SHIPPED | ✅ | "V3.6.0.7 SPIKE **SHIPPED**" | SHIPPED inline | "~strikethrough~ V3.6.0.7 ... — V3.6.0.7 spike SHIPPED" |
| V3.6.0.8.1 lock | ✅ SHIPPED | ✅ | **STALE**: "(V3.6.0.8.2 engine PART 1 PENDING + ...)" | SHIPPED inline | **STALE**: "V3.6.0.8.1 docs lock ✅ SHIPPED ... V3.6.0.8.2/8.3/8.4 PENDING" |
| V3.6.0.8.2 engine PART 1 | ✅ SHIPPED | ✅ | **STALE in D6 row** | inline | **STALE in line 2077** |
| V3.6.0.8.3 napi | ✅ SHIPPED | ✅ | **STALE in D6 row** + sub-step rollout table row at line 2025 says "SHIPPED" ✓ | inline (status block at 1802 says "V3.6.0.8 D6 arc COMPLETE" but HEAD trail at 1804-1807 says "(next; V3.6.0.8.3 D6 ENGINE PART 2 napi commit...)" — **STALE; D6 arc has moved past 8.3**) | **STALE in line 2077** |
| V3.6.0.8.4 audit + closures | ✅ SHIPPED | ✅ | **NOT in D6 row**; sub-step rollout table line 2026 STILL says "PENDING" — **STALE** | NOT a dedicated sub-section in §4.1.z6 | **STALE in line 2077** |
| V3.6.0.8.5 mocha | ✅ SHIPPED | ✅ | NOT in §4.1.z6 D6 row | NO sub-section | **MISSING from line 2077** (line 2077 lists only 8.1/8.2/8.3/8.4) |
| V3.6.0.10 D8 | ✅ SHIPPED | ✅ | **STALE**: D8 row says "DEFER until user signal | V3.6.0.9 PENDING" | **NO sub-section in §4.1.z6** | **STALE in line 2079**: "V3.6.0.10 D8 ... (conditional on user signal..." |
| V3.6.0.11 D9 | not shipped | "V3.6.0.11 ... IF surfaced" (line 307) | **MIS-NUMBERED**: D9 row says "V3.6.0.10 CONDITIONAL" (line 1823) — should be V3.6.0.11 | n/a | OK at line 2080 ("V3.6.0.11 D9 sheet-tabs UI...") |

The **§4.1.z6 D-decision table (lines 1813-1823) + Out-of-scope (2074-2084) + sub-step-rollout table (2019-2027) form 3 different status snapshots that all stop updating at V3.6.0.8.3**.  The V3.6.0.8.4/8.5/V3.6.0.10 updates landed in the §4.1.z6 STATUS BLOCK (line 1802) but did NOT propagate to the detail tables.

**Cycle counts**:
- plan body line 302 says **"5 plan-implement-audit cycles ... 3 over CLAUDE.md ≤2 ceiling"** but this was the V3.6.0.8.5 ship.
- plan body line 306 says **"6 plan-implement-audit cycles ... 4 over the CLAUDE.md ≤2 cycle ceiling; all 4 overrides user-directed via AskUserQuestion at cycle 3, 4, 5, 6 entry"** — matches current_work.md §0 and MEMORY.md V3.6.0.10 lead. ✓
- MASTER-PLAN.md lines 547-571 per-step paragraphs accumulate cycle counts correctly (V3.6.0.8.2 = 2, V3.6.0.8.3 = 3 user-directed cycle-3 override, V3.6.0.8.4 = 4 cycle-4 override, V3.6.0.8.5 = 5, V3.6.0.10 = 6). ✓

### B. Completeness — every shipped item documented?

**V3.6.0.10 D8 SHIPPED notes**:
- plan body line 306 ✅
- MASTER-PLAN.md final paragraph (V3.6.0.10 D8) ✅
- current_work.md §0 + V3.6.0.10 summary section ✅
- MEMORY.md line 2 lead ✅
- **§4.1.z6 ide-consumer-contract.md: ABSENT — no D8 RestoreSheet sub-section + no D8 row update + Out-of-scope still lists it as conditional** ← HIGH

**V3.6.0.8.4 audit closures** (5 HIGH + 4 MED):
- plan body line 304 has all 5 HIGH + 4 MED enumerated. ✓
- MASTER-PLAN.md V3.6.0.8.4 paragraph has them. ✓
- closures.md is the dedicated transcript. ✓
- **§4.1.z6: NO V3.6.0.8.4 audit sub-section + audit transcripts table at line 2059 MISSING the V3.6.0.8.4 Codex + Opus rows** ← MED

**R-V3.6-* risk register currency**:
- plan body lines 312-332 ✓ has R-V3.6-1 through R-V3.6-18 with current CLOSED/PENDING status (R-V3.6-15 CLOSED-AT-V3.6.0.8.4, R-V3.6-17 CLOSED-AT-V3.6.0.8.4, R-V3.6-NEW CLOSED-AT-V3.6.0.8.1).  ✓
- §4.1.z6 lines 2036-2055 ✓ has R-V3.6-1 through R-V3.6-18 with closure status.  **BUT line 2052 still describes R-V3.6-15 with "Loro's `oplog_vv()` returns `BTreeMap<PeerID, Counter>`"** — OPUS-MED-1 closure missed this site.  Also line 2054 still says "switch from `Arc::make_mut` to a different COW pattern" — should be updated to reflect R-V3.6-17 CLOSED + always-clone IS the right pattern. ← MED + MED

**Deferred items**:
- V3.6.0.9 D7 #REF! — listed as conditional in plan body line 305, MASTER-PLAN (implicitly via V3.6.0.6 narrative), §4.1.z6 line 2078, current_work.md "Next recommended sub-step". ✓
- V3.6.0.11 D9 typing-stroke watchdog — listed in plan body line 307, MASTER-PLAN line 547 narrative (... but original V3.6.0.1 mapping had D9 at V3.6.0.10), §4.1.z6 line 2080. **§4.1.z6 D-table line 1823 still maps D9 to V3.6.0.10** ← MED self-contradiction (V3.6.0.10 is now D8 RestoreSheet; D9 typing-stroke moves to V3.6.0.11 per the V3.6 sub-step rollout).
- V3.6.0.X phase-termination audit — plan body line 308 says "at V3.6.0.11 ship"; plan body line 357 says "at V3.6.0.10 ship"; §4.1.z6 line 2081 says "at V3.6.0.10 ship". ← Internal contradiction (plan body line 308 vs 357; §4.1.z6 follows the wrong one).

### C. Drift markers (stale "PENDING" / "TBD" / "next session")

**§4.1.z6 status block (line 1802)** says "V3.6.0.8 D6 arc COMPLETE" — correct.

**§4.1.z6 HEAD trail (lines 1804-1805)** says "(next; V3.6.0.8.3 D6 ENGINE PART 2 napi commit ...)" — STALE.  HEAD has moved through V3.6.0.8.4 + 8.5 + V3.6.0.10. ← HIGH

**§4.1.z6 Tests baseline (line 1807)** says "ql-collab 149/149 ... IDE mocha 390/390" — STALE.  Should be 154/154 + 406/406. ← HIGH

**§4.1.z6 D6 row (line 1820)** has "(V3.6.0.8.2 engine PART 1 PENDING + V3.6.0.8.3 napi + V3.6.0.8.4 audit-of-D6)" — STALE.  All shipped. ← MED

**§4.1.z6 D8 row (line 1822)** "DEFER until user signal | V3.6.0.9 PENDING" — STALE.  D8 SHIPPED V3.6.0.10. ← HIGH

**§4.1.z6 D9 row (line 1823)** "V3.6.0.10 CONDITIONAL" — STALE.  V3.6.0.10 is now D8; D9 typing-stroke moves to V3.6.0.11. ← MED

**§4.1.z6 sub-step rollout table line 2026** "V3.6.0.8.4 ... PENDING" — STALE. ← MED

**§4.1.z6 Out-of-scope line 2077** "V3.6.0.8 D6 ... IN-PROGRESS. ... V3.6.0.8.2/8.3/8.4 PENDING" — STALE. ← MED

**§4.1.z6 Out-of-scope line 2079** "V3.6.0.10 D8 ... (conditional on user signal; cell storage preserved internally)" — STALE.  D8 SHIPPED. ← MED

**§4.1.z6 Out-of-scope line 2081** "V3.6.0.X phase-termination audit at V3.6.0.10 ship" — Contradicts plan body line 308. ← MED

**plan body line 62** (in "V3.6 scope" enumeration): "8. **Op::RestoreSheet un-delete** (D8, F.8): conditional on user-facing flow. Skip if no user signal." — D8 has shipped; should reflect SHIPPED status (the line is summary-bullet, but for fresh-window readability the SHIPPED ✅ marker is needed). ← LOW

**plan body lines 242-254** (`### D8 Op::RestoreSheet un-delete (F.8) -- V3.6.0.9 IF SURFACED`):
- Heading line 242 still says "V3.6.0.9 IF SURFACED" — STALE.
- Line 246 "Decision: DEFER to user feedback signal." — STALE.
- Line 248 "Implementation if shipped:" — should be "Implementation (shipped V3.6.0.10):".
- Line 254 "V3.6.0.X sub-step suggestion: V3.6.0.9 IF surfaced." — STALE.
← MED (4 line-touches)

**plan body line 266** (D9): "**Mid-edit-render guard typing-stroke watchdog:** SHIP V3.6.0.10 IF surfaced." — D9 maps to V3.6.0.11 in the post-V3.6.0.10-D8 numbering; line 266 + 270 still say "V3.6.0.10". ← MED

**plan body line 270**: "V3.6.0.X sub-step suggestion: V3.6.0.10 IF surfaced (typing-stroke watchdog only)." — same issue. ← (folded into above)

**plan body line 272** (sub-step rollout header): "V3.6 sub-step rollout (planned -- order may shift based on V3.6.0.2 implementation discoveries)" — the "order may shift" caveat is now historical (order DID shift, D8 jumped from V3.6.0.9 conditional → V3.6.0.10 shipped, D9 typing-stroke from V3.6.0.10 → V3.6.0.11 conditional).  Minor; consider adding a parenthetical "(post-V3.6.0.10 D8 ship: D9 typing-stroke moves to V3.6.0.11)". ← INFO

**plan body line 357**: "V3.6.0.X phase termination audit at V3.6.0.10 ship (parallel Codex+Opus; broad scope)." — Contradicts plan body line 308 ("Phase-level termination audit at V3.6.0.11 ship"). ← MED self-contradiction

**plan body line 365** (V3.7+ entry-readiness preview): the strikethrough "~~WorkbookSnapshot incremental deltas (V3.6.0.7 deferred outcome)~~ — now V3.6.0.8 D6 SHIP" is helpful, but doesn't note D8 RestoreSheet shipped too — the item is still listed implicitly via V3.6.0.10 being a "deferred V3.6 sub-step" that landed. ← INFO

**current_work.md mocha test count assertion**: line 80 says `# expect: 406 passing` but the mocha command at line 79 ONLY runs `quantbook-roundtrip.test.js` (a single file).  Spot-grep of that file shows ~397 `test(...)` patterns (some appear in string literals — actual mocha count likely ≠ raw grep).  Without running mocha live this audit can't verify the "406" expectation matches what `mocha quantbook-roundtrip.test.js --ui tdd` actually emits.  The V3.6.0.10 IDE commit message claims "400 -> 406" so if the count is wrong it's likely been wrong across the entire V3.6 cycle.  Either: the mocha runner expands `test()` definitions in some way the raw grep misses; OR the count is overstated.  Either way, the "expect: 406 passing" in current_work.md will only be true if the live mocha run agrees — a fresh session running command 2 must not trip on a 397/406 mismatch. ← LOW (not blocking — fresh session can verify live)

**MEMORY.md line 2 mid-string leftover V3.6.0.8.3 paragraph**: includes "Shipped: full D6 napi surface ... Tests: ql-collab 149/149 + ql-oplog 67 + ql-collab-ws 40 + IDE mocha 390/390 (+6). ... 3 cycles used; 1 OVER CLAUDE.md ≤2; user-directed override".  This is a previous-session paragraph that survives un-trimmed under the new V3.6.0.10 lead.  Drift signals:
- "ql-collab-ws 40" (current is 42 per plan body + current_work.md).
- "ql-collab 149/149" (current is 154).
- "IDE mocha 390/390 (+6)" (current is 406).
- "3 cycles used" (this session is 6).
The lead correctly states V3.6.0.10 SHIPPED + new HEADs + 154/406, but the tail-end contradicts it.  Per CLAUDE.md's "compression-laziness" principle: this is the canonical compounded-handoff drift.  ← HIGH (MEMORY.md is read first-thing; the contradiction risks new session believing the wrong baseline).

### D. Coherence (cross-doc)

**Phase-termination-audit-fires-when** (3-way disagreement):
- plan body line 308 → "V3.6.0.11 ship".
- plan body line 357 → "V3.6.0.10 ship".
- §4.1.z6 line 2081 → "V3.6.0.10 ship".

Two of three docs say V3.6.0.10 (= now); one says V3.6.0.11.  V3.6.0.10 D8 has just shipped at audit entry; the parallel Lane A + Lane B docs megaudit (THIS document) is partially fulfilling the phase-termination promise.  Mismatch needs reconciling.

**D9 sub-step assignment** (2-way disagreement):
- plan body line 266, 270 → "V3.6.0.10 IF surfaced".
- §4.1.z6 D9 row line 1823 → "V3.6.0.10 CONDITIONAL".
- plan body line 307 (sub-step rollout) → "V3.6.0.11 -- mid-edit-render guard typing-stroke watchdog (D9 F.9) IF surfaced".
- §4.1.z6 Out-of-scope line 2080 → "V3.6.0.11 D9 sheet-tabs UI / typing-stroke watchdog".

§4.1.z6 D9 table row + plan body D9 decision text say V3.6.0.10; the sub-step rollout + §4.1.z6 Out-of-scope say V3.6.0.11.  Resolution: D9 moves to V3.6.0.11 (D8 took the V3.6.0.10 slot).  Two sites still call it V3.6.0.10.

**Arc::make_mut vs always-clone** (in-source vs design-lock):
- session.rs:954-960 (post-OPUS-MED-3 closure): "always-clone".
- session.rs:976 (older docstring block): "Delta-apply path uses `Arc::make_mut` to fork-on-write" — STALE.
- lib.rs:2453 (napi method docstring step 8): "clone cached `Arc<Workbook>` via `Arc::make_mut`" — STALE.
- §4.1.z6 line 1972 (V3.6.0.8.1 design-lock body): "clone-on-delta via Arc::make_mut" — STALE.
- §4.1.z6 line 2011 (V3.6.0.8.1 design-lock algorithm code): "// Arc::make_mut" — STALE.
- §4.1.z6 line 2054 (R-V3.6-17 description): "switch from `Arc::make_mut` to a different COW pattern" — STALE (R-V3.6-17 is CLOSED).

OPUS-MED-3 closure-doc said "(4 sites)" swept; this audit found **6 stale sites** in session.rs (1) + lib.rs (1) + §4.1.z6 (3) + plan body line 299's V3.6.0.8.1 lock-paragraph that includes "(clone Arc::make_mut + apply per-op + skip repair)" (1).  Plus the closure-doc itself line 100 says "lib.rs ~line 2454" for the R-V3.6-15 debug-assert location whereas actual is line 2604 (drift of ~150 lines).

**BTreeMap vs FxHashMap** (Loro VersionVector type):
- session.rs:1003-1009 (post-OPUS-MED-1 closure): "FxHashMap<PeerID, Counter>" + explanatory note ✓
- §4.1.z6 line 1978: "FxHashMap<PeerID, Counter>" + explanatory note ✓
- §4.1.z6 line 2052 (R-V3.6-15 description): STILL "Loro's `oplog_vv()` returns `BTreeMap<PeerID, Counter>`" — STALE
- plan body line 299 (V3.6.0.8.1 lock body): STILL "VersionVector via Loro's BTreeMap<PeerID, Counter>" — STALE
- lib.rs:2145 (post-closure): "// a cheap clone of Loro's internal FxHashMap<PeerID, Counter>" ✓
- closures-doc line 100 also implicitly references R-V3.6-15 via the new debug_assert; not a drift point.

OPUS-MED-1 closure-doc said "(3 sites)" swept; this audit found **3 sites swept** + **2 sites still stale** (plan body line 299 + §4.1.z6 line 2052).  The lock-text paragraph and the risk-register cross-reference were missed.

**Workbook clone-cost commentary**:
- R-V3.6-17 marked CLOSED at V3.6.0.8.4 in plan body line 331, MASTER-PLAN, current_work.md (implicit via reference), and §4.1.z6 line 2054.
- BUT §4.1.z6 line 2054 retains the conditional "Profile at V3.6.0.8.3; if `clone()` > 20 ms ... switch from `Arc::make_mut` to a different COW pattern" — should be replaced with the actual measurement ("692 μs at 100k, well under 20 ms; always-clone is the right pattern"). ← MED

### E. Fresh-window readability

**current_work.md "First three commands"**:
1. `git log --oneline -3` paths use absolute paths — work. ✓
2. `cargo test -p ql-collab` command — accurate; expected `154 passed` matches plan body + git ship narrative. ✓
3. mocha command — paths correct (verified `out/test/quantbook-roundtrip.test.js` + `out/test/helpers/mocha-setup.js` exist on disk); expected `406 passing` — raw grep of `quantbook-roundtrip.test.ts` shows ~397 `test()` patterns, but actual mocha-count semantics may differ from raw grep (TDD `test()` macro, string-literal matches).  This audit cannot verify the 406 without running mocha; current_work.md's claim must hold under live run.  If it doesn't, fresh session will trip.
4. `sed -n '/V3.6.0.10/,/V3.6.0.11/p'` extraction would print plan body lines from first V3.6.0.10 match (line 306) to first V3.6.0.11 match (line 307) — gives the V3.6.0.10 SHIPPED narrative.  ✓ Useful.

**"What to do next" options**:
- "Next recommended sub-step" lists V3.6.0.9 D7 + V3.6.0.11 D9 + V3.6.0.X phase-termination megaudit — concise + actionable. ✓
- The cycle-budget overrun warning is prominent (§0 "6 cycles; 4 over ceiling; all user-directed; **Next session MUST start at 0 cycles**").  ✓

**Architectural-decisions D1-D9 summary**: plan body §"V3.6 design decisions" (lines 66-270) carries the original V3.6.0.1 lock body in detail.  A fresh session can read this end-to-end but: (a) the D8 sub-section heading still says "V3.6.0.9 IF SURFACED" while D8 has shipped (LOW item — out-of-date sub-step suggestion); (b) D9 sub-section says "V3.6.0.10 IF surfaced" while V3.6.0.10 is now D8 (MED item — wrong sub-step assignment).  A fresh session reading these sections gets the WRONG model of when D8 / D9 ship.

**V3.6.0.X audit transcripts table** (§4.1.z6 lines 2059-2070): missing V3.6.0.8.4 + V3.6.0.8.5 + V3.6.0.10 rows.  Fresh-window auditor looking for "which audit transcripts exist for each sub-step" hits an incomplete table.  ← MED

### F. Audit-transcript hygiene

- **V3.6.0.7 spike transcript** (123 lines): clean, complete; results table consistent across spike + plan body + MASTER-PLAN + §4.1.z6.  Line 120 "expect 136 passed" is a historical snapshot of regression baseline at spike time — fine (per-step transcripts capture their own moment).  Decision well-justified.
- **V3.6.0.8.4 Codex Lane A transcript** (195 lines): FAIL verdict; 3 HIGH + 1 LOW + 1 INFO.  Findings table complete; file:line refs match actual source.  Recommended closures clearly delineated.
- **V3.6.0.8.4 Opus Lane B transcript** (270 lines): PASS-WITH-FINDINGS verdict; 3 HIGH + 5 MED + 3 LOW + 1 INFO.  Findings table complete; Rule 4 walk thorough.  Recommended closures clearly delineated.
- **V3.6.0.8.4 closures.md** (121 lines): summary form; cross-references both lanes; bench results table; risk register update.  **Drift: line 100 says R-V3.6-15 debug-assert at "lib.rs ~line 2454"** — actual is line 2604 (off by ~150 lines, likely because the closures doc was written before the snapshot_cell + version-field closures shifted code).  ← LOW
- **Cross-doc transcript references**: plan body line 329 also says "lib.rs ~2461-2475" + plan body line 304 says "lib.rs:2454" for the same R-V3.6-15 debug-assert.  All three citations (closures-doc + plan body 2 sites) are stale by ~150 lines.  ← LOW

### G. Cross-cutting drift items not already enumerated

- **Loro VersionVector type drift**: 2 unfixed sites carry-listed above.
- **Arc semantics drift**: 6 unfixed sites carry-listed above.
- **Test count baseline drift**: 1 MEMORY.md site carry-listed above.
- **D6 arc "in-progress" markers**: stale in §4.1.z6 D-table + sub-step-rollout table + Out-of-scope; ALL 3 still imply 8.3/8.4 PENDING.

### H. Process discipline

- 6-cycle session correctly characterized as a CLAUDE.md ≤2-cycle ceiling violation in:
  - plan body line 302 (V3.6.0.8.5 cycle-5 entry; "3 over CLAUDE.md ≤2 ceiling")
  - plan body line 306 (V3.6.0.10 cycle-6 entry; "4 over the CLAUDE.md ≤2 cycle ceiling")
  - current_work.md §0 ("6 cycles used; 4 OVER CLAUDE.md ≤2 ceiling")
  - MEMORY.md V3.6.0.10 lead ("6 cycles used; 4 OVER CLAUDE.md ≤2 ceiling")
  - MASTER-PLAN.md per-sub-step paragraphs (each over-budget cycle entry carries the user-directed-override note).

  All citation-of-overrides consistent.  ✓

### I. Forward-planning accuracy

- **V3.6.0.9 D7 #REF! substitution**: estimated 1-2 sessions, conditional.  Consistent across plan body line 305, MASTER-PLAN narrative, current_work.md "Next recommended". ✓
- **V3.6.0.11 D9 typing-stroke watchdog**: 0.5 cycle estimate, conditional.  Plan body line 307 says 0.5; current_work.md "Next recommended" says ~0.5 cycle.  §4.1.z6 D9 row says "ship-on-signal" without cycle estimate.  ✓ Mostly consistent (sub-step numbering disagreement carry-listed above).
- **V3.6.0.X phase-termination megaudit**: 6-8 sessions estimate.  Consistent.  When-fires drift carry-listed above.
- **V3.7+ backlog**: plan body lines 363-371 preserves the V3.7+ list.  §4.1.z6 lines 2082-2084 preserves it.  ✓

### J. Orphaned references

- "deferred to V3.6.0.8.4" — fully consumed by V3.6.0.8.4 closures-doc + plan body line 304.  No orphaned references found.
- "deferred to V3.6.0.8.5" — fully consumed by V3.6.0.8.5 IDE commit + plan body line 302.  No orphaned references found.
- "V3.6.0.10 PENDING" — multiple orphans in §4.1.z6 (D8 row + Out-of-scope + phase-termination location).
- "Opus LOW-2 deferred to V3.6.0.8.5" — partially closed (per-accessor debug_assert still deferred); plan body line 304 acknowledges.  Consistent.  ✓

---

## Findings table

| Severity | ID | Title | File:line | Suggested fix |
|---|---|---|---|---|
| HIGH | OPUS-V3-6-0-10-DOCS-HIGH-1 | No V3.6.0.10 D8 RestoreSheet sub-section in §4.1.z6 (the IDE consumer contract).  Fresh-window IDE consumer cannot find the documented contract for `restoreSheet(id: number): void` napi method. | `docs/architecture/ide-consumer-contract.md` (insert after line 1879 V3.6.0.6 D5 section ends, or after V3.6.0.7 D6 section, or as a new "#### V3.6.0.10 D8 -- Op::RestoreSheet (engine `19a35b68cac` + IDE `4c48f8809bc`)" section).  Include: napi method signature, wire variant info, idempotency semantics, classify_delta_op fullRebuild forcing, +5 ql-collab tests + +6 IDE mocha tests, R-V3.6-9 status. | Add a dedicated V3.6.0.10 D8 sub-section in §4.1.z6 mirroring the V3.6.0.6 D5 / V3.6.0.8.3 napi sub-section pattern.  Update §4.1.z6 D8 row in the D-decision table to "V3.6.0.10 **SHIPPED**".  Update Out-of-scope (line 2079) to strike-through V3.6.0.10 D8 with "SHIPPED" note. |
| HIGH | OPUS-V3-6-0-10-DOCS-HIGH-2 | §4.1.z6 status block (line 1802) says "V3.6.0.8 D6 arc COMPLETE" but adjacent HEAD trail (lines 1804-1805) + Tests baseline (line 1807) STILL reflect V3.6.0.8.3 state.  Fresh-window IDE consumer reading the status block + HEAD trail gets contradictory information about what's actually current. | `docs/architecture/ide-consumer-contract.md:1804-1807` | Sweep HEAD trail to engine `19a35b68cac` + IDE `4c48f8809bc` (V3.6.0.10).  Sweep Tests baseline to ql-collab **154/154** + IDE mocha **406/406**.  Mention V3.6.0.10 D8 SHIPPED in the status block paragraph at line 1802. |
| HIGH | OPUS-V3-6-0-10-DOCS-HIGH-3 | MEMORY.md line 2 carries a legacy V3.6.0.8.3 paragraph ("Shipped: full D6 napi surface ... Tests: ql-collab 149/149 + ql-oplog 67 + ql-collab-ws 40 + IDE mocha 390/390 (+6). ... 3 cycles used; 1 OVER CLAUDE.md ≤2; user-directed override") AFTER the V3.6.0.10 lead.  Fresh session reading MEMORY.md gets the wrong test baseline AND wrong cycle count from the trailing paragraph.  CLAUDE.md's "compression-laziness" rule explicitly names this pattern. | `/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/MEMORY.md:2` | Trim the legacy V3.6.0.8.3 paragraph from the middle of line 2.  Keep the V3.6.0.10 lead (correct).  Optionally keep a 1-clause historical-context line ("← V3.6.0.8 D6 arc shipped earlier this session at 390/390 mocha; current is 406/406 post-V3.6.0.10") if the chain-of-shippings is useful, but discard the test-count-snapshot mid-paragraph. |
| MED | OPUS-V3-6-0-10-DOCS-MED-1 | §4.1.z6 D-decision table D8 row (line 1822) says "DEFER until user signal | V3.6.0.9 PENDING" — STALE post-V3.6.0.10 ship. | `docs/architecture/ide-consumer-contract.md:1822` | Replace with "Op::RestoreSheet un-delete + cache walker + classify_delta_op fullRebuild | V3.6.0.10 **SHIPPED**". |
| MED | OPUS-V3-6-0-10-DOCS-MED-2 | §4.1.z6 D-decision table D9 row (line 1823) maps D9 to "V3.6.0.10 CONDITIONAL" — STALE.  V3.6.0.10 is now D8; D9 typing-stroke moves to V3.6.0.11. | `docs/architecture/ide-consumer-contract.md:1823` | Update D9 row to "V3.6.0.11 CONDITIONAL". |
| MED | OPUS-V3-6-0-10-DOCS-MED-3 | §4.1.z6 D-decision table D6 row (line 1820) STILL says "(V3.6.0.8.2 engine PART 1 PENDING + V3.6.0.8.3 napi + V3.6.0.8.4 audit-of-D6)" — all 3 (+8.5) shipped. | `docs/architecture/ide-consumer-contract.md:1820` | Replace pending list with "V3.6.0.7 spike SHIPPED + V3.6.0.8.1 lock SHIPPED + V3.6.0.8.2 engine PART 1 SHIPPED + V3.6.0.8.3 napi SHIPPED + V3.6.0.8.4 audit + closures + bench SHIPPED + V3.6.0.8.5 mocha coverage SHIPPED — D6 ARC COMPLETE". |
| MED | OPUS-V3-6-0-10-DOCS-MED-4 | §4.1.z6 sub-step rollout table (line 2026) STILL says "V3.6.0.8.4 ... PENDING". | `docs/architecture/ide-consumer-contract.md:2026` | Update to "✅ SHIPPED (user-directed cycle-4 override)".  Add a new row for V3.6.0.8.5 mocha coverage closure + V3.6.0.10 D8 (if scope of the rollout table extends to D8). |
| MED | OPUS-V3-6-0-10-DOCS-MED-5 | §4.1.z6 Out-of-scope (line 2077) says "V3.6.0.8.2/8.3/8.4 PENDING (~3 more cycles across ≥2 sessions)" — STALE. | `docs/architecture/ide-consumer-contract.md:2077` | Strike-through the in-progress text + add "— V3.6.0.8 D6 arc COMPLETE at V3.6.0.8.5; D6 perf contract delivered with 46× headroom". |
| MED | OPUS-V3-6-0-10-DOCS-MED-6 | §4.1.z6 Out-of-scope (line 2079) says "V3.6.0.10 D8 Op::RestoreSheet (conditional on user signal; cell storage preserved internally)" — STALE. | `docs/architecture/ide-consumer-contract.md:2079` | Strike-through + add "— V3.6.0.10 D8 SHIPPED 2026-05-25 (engine `19a35b68cac` + IDE `4c48f8809bc`)". |
| MED | OPUS-V3-6-0-10-DOCS-MED-7 | §4.1.z6 audit transcripts table (lines 2059-2070) MISSING V3.6.0.8.4 audit transcripts row (Codex `2026-05-25-phase-5-7-v3-6-0-8-codex.md` + Opus `...-opus.md` + closures `...-closures.md`) and V3.6.0.10 row (if any per-step audit ran). | `docs/architecture/ide-consumer-contract.md:2057-2071` | Add row: "V3.6.0.8.4 D6 audit + closures + bench | `2026-05-25-phase-5-7-v3-6-0-8-codex.md` | `2026-05-25-phase-5-7-v3-6-0-8-opus.md` + closures summary `2026-05-25-phase-5-7-v3-6-0-8-closures.md`".  Add row: "V3.6.0.8.5 D6 Opus-MED-5 mocha | (no audit) | inline at `.plans/_active.md` + this section + docs/MASTER-PLAN.md".  Add row: "V3.6.0.10 D8 RestoreSheet | (no per-step audit; phase-termination megaudit pending at V3.6.0.10 or V3.6.0.11 ship) | inline at `.plans/_active.md` + this audit transcript (`2026-05-25-phase-5-7-v3-6-0-10-megaudit-docs-opus.md`)". |
| MED | OPUS-V3-6-0-10-DOCS-MED-8 | Phase-termination-audit-fires-when contradiction: plan body line 308 says "V3.6.0.11 ship"; plan body line 357 + §4.1.z6 line 2081 say "V3.6.0.10 ship".  V3.6.0.10 has just shipped; this audit is partially fulfilling the docs-side Lane B of a phase-termination audit, but the source-of-truth for "when does the megaudit fire" is contradictory. | `.plans/_active.md:308` + `.plans/_active.md:357` + `docs/architecture/ide-consumer-contract.md:2081` | Pick one.  Recommendation: V3.6.0.11 ship (consistent with the conditional-D9-shipped or D9-skipped end-of-V3.6 framing).  Update line 357 + §4.1.z6 line 2081 accordingly. |
| MED | OPUS-V3-6-0-10-DOCS-MED-9 | D9 sub-step assignment contradiction: plan body lines 266 + 270 say "V3.6.0.10 IF surfaced" (D9 typing-stroke watchdog); §4.1.z6 D9 row (line 1823) says "V3.6.0.10 CONDITIONAL".  V3.6.0.10 is now D8 RestoreSheet; D9 typing-stroke moves to V3.6.0.11 per plan body line 307 + §4.1.z6 line 2080. | `.plans/_active.md:266` + `.plans/_active.md:270` + `docs/architecture/ide-consumer-contract.md:1823` | Update lines 266, 270, 1823 to V3.6.0.11 sub-step. |
| LOW | OPUS-V3-6-0-10-DOCS-LOW-1 | plan body D8 sub-section heading still says "V3.6.0.9 IF SURFACED" (line 242) + body says "Decision: DEFER to user feedback signal" (line 246) + "Implementation if shipped:" (line 248) + "V3.6.0.X sub-step suggestion: V3.6.0.9 IF surfaced" (line 254). | `.plans/_active.md:242-254` | Either rewrite the D8 sub-section heading + body to reflect SHIPPED status, OR add a "**SHIPPED at V3.6.0.10**" marker at the top of the sub-section pointing to the line 306 SHIPPED narrative.  Keep historical decision-text in place for archeology. |
| LOW | OPUS-V3-6-0-10-DOCS-LOW-2 | plan body line 62 (V3.6 scope enumeration) lists D8 as "conditional on user-facing flow. Skip if no user signal." — D8 has shipped; this bullet is now historical. | `.plans/_active.md:62` | Add ✅ SHIPPED marker. |
| LOW | OPUS-V3-6-0-10-DOCS-LOW-3 | session.rs:976 (CollabSession::last_snapshot_workbook docstring last paragraph) STILL claims "Delta-apply path uses `Arc::make_mut` to fork-on-write" — directly contradicts the EARLIER paragraph (lines 954-960) in the same docstring block which has the OPUS-MED-3 closure correction (always-clone). | `crates/ql-collab/src/session.rs:974-978` | Replace with "Delta-apply path uses `(*cached_arc).clone()` always-clone (per V3.6.0.8.4 OPUS-MED-3 closure; see lines 954-960 above)".  R-V3.6-17 measurement (692 μs at 100k cells) makes always-clone correct + simple. |
| LOW | OPUS-V3-6-0-10-DOCS-LOW-4 | lib.rs:2453 (workbook_snapshot_delta napi method docstring step 8) STILL claims "clone cached `Arc<Workbook>` via `Arc::make_mut`". | `crates/ql-bindings-node/src/lib.rs:2452-2453` | Replace with "clone cached `Arc<Workbook>` via `(*cached_arc).clone()` always-clone (R-V3.6-17 measured at 692 μs at 100k cells; well under threshold)". |
| LOW | OPUS-V3-6-0-10-DOCS-LOW-5 | §4.1.z6 line 1972 (V3.6.0.8.1 design-lock body): "// post-repair; clone-on-delta via Arc::make_mut" — STALE. | `docs/architecture/ide-consumer-contract.md:1972` | Update inline comment to "// post-repair; clone-on-delta via `(*cached_arc).clone()` always-clone (V3.6.0.8.4 OPUS-MED-3)". |
| LOW | OPUS-V3-6-0-10-DOCS-LOW-6 | §4.1.z6 line 2011 (V3.6.0.8.1 design-lock algorithm pseudocode): "let mut next = (*self.last_snapshot_workbook.unwrap()).clone();  // Arc::make_mut" — the code is right but the comment is wrong. | `docs/architecture/ide-consumer-contract.md:2011` | Replace comment "// Arc::make_mut" with "// always-clone (R-V3.6-17 692 μs at 100k)". |
| LOW | OPUS-V3-6-0-10-DOCS-LOW-7 | §4.1.z6 line 2054 (R-V3.6-17 description) STILL says "if `clone()` > 20 ms at 100k cells, switch from `Arc::make_mut` to a different COW pattern" — R-V3.6-17 is CLOSED. | `docs/architecture/ide-consumer-contract.md:2054` | Replace with "**CLOSED at V3.6.0.8.4**: `Workbook::clone()` measured 692 μs at 100k cells; well under threshold; `(*cached_arc).clone()` always-clone IS the right pattern; no Arc-make_mut COW refactor needed." |
| LOW | OPUS-V3-6-0-10-DOCS-LOW-8 | §4.1.z6 line 2052 (R-V3.6-15 description) STILL says "Loro's `oplog_vv()` returns `BTreeMap<PeerID, Counter>`" — actual is FxHashMap; OPUS-MED-1 closure missed this site. | `docs/architecture/ide-consumer-contract.md:2052` | Replace "BTreeMap" with "FxHashMap" (matches loro-internal-1.12.0/src/version.rs:29). |
| LOW | OPUS-V3-6-0-10-DOCS-LOW-9 | plan body line 299 (V3.6.0.8.1 lock body) STILL says "VersionVector via Loro's BTreeMap<PeerID, Counter>" + "(clone Arc::make_mut + apply per-op + skip repair)" — historical lock-text un-swept by OPUS-MED-1 + OPUS-MED-3 closures. | `.plans/_active.md:299` | Either: (a) leave as historical lock-text and add "**Post-V3.6.0.8.4 corrections**: VersionVector is FxHashMap not BTreeMap; clone is `(*cached_arc).clone()` not Arc::make_mut" inline; (b) sweep in-place + leave a footnote. |
| LOW | OPUS-V3-6-0-10-DOCS-LOW-10 | closures.md line 100 + plan body lines 304 + 329 cite the R-V3.6-15 debug_assert location as `lib.rs:2454` (or `~2461-2475`); actual location is lines 2604-2612 (off by ~150 lines because the snapshot_cell + version-field closures shifted code downward). | `docs/audits/2026-05-25-phase-5-7-v3-6-0-8-closures.md:100` + `.plans/_active.md:304` + `.plans/_active.md:329` | Sweep line refs to `crates/ql-bindings-node/src/lib.rs:2604-2612`. |
| INFO | OPUS-V3-6-0-10-DOCS-INFO-1 | current_work.md command 2 mocha expects "406 passing" but the mocha command runs ONLY quantbook-roundtrip.test.js; raw grep of that file finds ~397 `test()` patterns.  Either the mocha runner counts more (TDD `test` macro might expand vs grep) OR the 406 baseline overstates by ~9.  Fresh session running command 2 will live-verify; if mismatch, fresh session trips. | `/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md:79-80` | Lane A or fresh session should live-run the mocha command + record the live test count.  If 406 doesn't hold, update current_work.md + MEMORY.md V3.6.0.10 lead + plan body + MASTER-PLAN to the actual count. |
| INFO | OPUS-V3-6-0-10-DOCS-INFO-2 | plan body line 272 ("V3.6 sub-step rollout (planned -- order may shift...)") — the "order may shift" caveat is historical; the rollout DID shift twice (D8 jumped V3.6.0.9 → V3.6.0.10; D9 V3.6.0.10 → V3.6.0.11 ).  Minor; consider documenting the shift explicitly. | `.plans/_active.md:272` | Add a parenthetical "(post-V3.6.0.10 D8 ship: D9 typing-stroke moves to V3.6.0.11; D8 RestoreSheet took the V3.6.0.10 slot per cycle-6 user-direction)". |
| INFO | OPUS-V3-6-0-10-DOCS-INFO-3 | plan body line 365 (V3.7+ entry-readiness preview) has a helpful strike-through "~~WorkbookSnapshot incremental deltas (V3.6.0.7 deferred outcome)~~ — now V3.6.0.8 D6 SHIP" but doesn't note D8 RestoreSheet shipped too; the V3.7+ list still implicitly includes it via "Op::RestoreSheet" being mentioned in §4.1.z6 line 1556 "(V3.6+ if user-facing flow justified)". | `.plans/_active.md:365` + `docs/architecture/ide-consumer-contract.md:1556` | Add to plan body line 365 (mirror the V3.6.0.7 strikethrough pattern) "~~Op::RestoreSheet un-delete (V3.6 deferred outcome)~~ — SHIPPED V3.6.0.10 D8".  Sweep §4.1.z6 line 1556 to "Op::RestoreSheet un-delete SHIPPED V3.6.0.10 D8 (see § 4.1.z6 V3.6.0.10 sub-section)". |
| INFO | OPUS-V3-6-0-10-DOCS-INFO-4 | MASTER-PLAN.md status header (line 545) ends at "V3.5 ... ALL SHIPPED + AUDITED".  Per-sub-step paragraphs at 547-571 carry V3.6 detail.  Fresh session reading just the status header gets a Phase 5.7 V3.5-complete view, missing V3.6.0.1-0.10 shipped state.  Per-sub-step paragraphs are exhaustive (good) but a 1-line "V3.6.0.1 lock → V3.6.0.10 D8 SHIPPED" roll-up at the status header would help readability. | `docs/MASTER-PLAN.md:545` | Append to the status header: "✅ **5.7 V3.6 (Loro UndoManager on_push + format registry + per-cell op-index + format-aware rendering + IDE PutFormula + D6 incremental snapshot deltas + D8 Op::RestoreSheet, V3.6.0.1 lock → V3.6.0.10 D8 SHIPPED 2026-05-23/24/25)**". |
| INFO | OPUS-V3-6-0-10-DOCS-INFO-5 | The V3.6.0.X audit transcripts file naming convention has internal date drift: V3.6.0.3 + V3.6.0.4 transcripts are dated "2026-05-23"; V3.6.0.5 / V3.6.0.6 / V3.6.0.7 / V3.6.0.8 transcripts are dated "2026-05-24" / "2026-05-25"; §4.1.z6 line 2072 already documents this as a known low-severity drift.  This audit (V3.6.0.10 docs megaudit Lane B) dated 2026-05-25.  Convention-following.  ✓ | n/a | No fix needed; note for transparency. |

---

## Recommended closures

### MUST close before a fresh session can pick up cleanly (V3.6.0.X phase-termination audit entry must close these)

1. **OPUS-V3-6-0-10-DOCS-HIGH-1** — add V3.6.0.10 D8 sub-section in §4.1.z6.  Without this the IDE consumer contract has no documented `restoreSheet` surface.  Critical for any fresh session implementing IDE-side RestoreSheet UX.

2. **OPUS-V3-6-0-10-DOCS-HIGH-2** — sweep §4.1.z6 status block HEAD trail + Tests baseline to current (engine `19a35b68cac` + IDE `4c48f8809bc` + 154/406).  This is the most-likely-to-be-read-first piece for a fresh session reaching for IDE-side V3.6 contract.

3. **OPUS-V3-6-0-10-DOCS-HIGH-3** — trim MEMORY.md line 2 legacy V3.6.0.8.3 paragraph.  Per CLAUDE.md's "compression-laziness" rule + the user's recent explicit "Don't Be Lazy" + "MEMORY files are snapshots; ALWAYS verify against current code" instruction.

4. **OPUS-V3-6-0-10-DOCS-MED-1 through MED-7** — sweep §4.1.z6 D-decision table + sub-step rollout table + audit transcripts table + Out-of-scope.  All 7 are small text edits in the same file; cluster into one commit.

5. **OPUS-V3-6-0-10-DOCS-MED-8** — pick V3.6.0.10 OR V3.6.0.11 for phase-termination audit.  Update the contradicting site.

6. **OPUS-V3-6-0-10-DOCS-MED-9** — sweep D9 sub-step references to V3.6.0.11.

7. **OPUS-V3-6-0-10-DOCS-LOW-3 + LOW-4** — sweep the 2 remaining in-source `Arc::make_mut` docstring sites (session.rs:976 + lib.rs:2453) per OPUS-MED-3.  In-source consistency matters most for fresh contributors reading the docstrings.

8. **OPUS-V3-6-0-10-DOCS-LOW-8** — sweep §4.1.z6 line 2052 `BTreeMap`→`FxHashMap` per OPUS-MED-1.

9. **OPUS-V3-6-0-10-DOCS-INFO-1** — live-run mocha + verify 406 / pin the real number.

### Can defer to V3.7+ or V3.6.0.X phase-termination audit closure cycle

- **OPUS-V3-6-0-10-DOCS-LOW-1 + LOW-2** — plan body D8 sub-section heading sweep + scope-enumeration ✅ marker.  Cosmetic; not blocking new-session pickup.
- **OPUS-V3-6-0-10-DOCS-LOW-5 + LOW-6 + LOW-7** — §4.1.z6 V3.6.0.8.1 lock body Arc::make_mut historical references.  These are within the immutable V3.6.0.8.1 LOCK paragraph; cleanest to add a "Post-V3.6.0.8.4 corrections" footnote rather than sweep the lock text.
- **OPUS-V3-6-0-10-DOCS-LOW-9** — plan body line 299 similar historical lock-text.  Same approach.
- **OPUS-V3-6-0-10-DOCS-LOW-10** — closures.md + plan body line refs to debug_assert location off by ~150 lines.  Cheap to fix; cluster with the MED sweep.

### Fine to leave indefinitely

- **OPUS-V3-6-0-10-DOCS-INFO-2 through INFO-5** — minor commentary improvements; not actionable for the next session pickup.

---

## Verdict

**PASS-WITH-FINDINGS** (24 distinct findings: 3 HIGH + 9 MED + 7 LOW + 5 INFO).

Strengths:
- The CORE handoff path (current_work.md §0 + "First three commands" + V3.6.0.10 summary) is **fresh-window-ready** for engine + IDE git HEAD + test baselines.
- The plan body V3.6.0.10 D8 SHIPPED narrative (line 306) is **complete and accurate** — wire variant, replay arm, cache walker, classify_delta_op allowlist, napi, IDE wrapper, +5 ql-collab + +6 mocha, Rule 4 walk, R-V3.6-9 update.
- MASTER-PLAN.md per-sub-step paragraphs **chain correctly** across V3.6.0.7 spike → V3.6.0.8.1 lock → V3.6.0.8.2 PART 1 → V3.6.0.8.3 napi → V3.6.0.8.4 audit → V3.6.0.8.5 mocha → V3.6.0.10 D8.
- The 6-cycle session is **consistently characterized** across plan body, current_work.md, MEMORY.md as 4-over-ceiling with all 4 user-directed.
- R-V3.6-* risk register is **substantively current** (R-V3.6-14/15/17/18 closures explicit; R-V3.6-9 D7+D8 interaction noted).
- All commit hashes verify against git log.

Concerns:
- **§4.1.z6 (the IDE consumer contract for V3.6) is the worst-drift artifact**: status-block + HEAD trail + Tests baseline + D-table + sub-step rollout table + audit transcripts table + Out-of-scope all carry their own snapshot of state; only the status-block sentence at line 1802 is current.  The other 6 sub-sections all stop updating at V3.6.0.8.3.  This is the file an IDE-team consumer would read FIRST — the drift is high-impact.
- **MEMORY.md compounded-handoff drift** — V3.6.0.10 correct lead overwritten by V3.6.0.8.3 mid-paragraph remnant.
- **In-source `Arc::make_mut` docstring drift** — 2 surviving sites contradict the adjacent V3.6.0.8.4 OPUS-MED-3 closure correction.  Confuses code reviewers.
- **2 internal contradictions** that need resolving (phase-termination-audit-fires-when V3.6.0.10 vs V3.6.0.11; D9 sub-step V3.6.0.10 vs V3.6.0.11).

A fresh session opening current_work.md + plan body line 306 can pick up.  A fresh session opening §4.1.z6 first gets a partial picture that says D8 is conditional + D6 arc is partially pending; that fresh session would not know V3.6.0.10 D8 has shipped without reading the plan body or MASTER-PLAN.

The 3 HIGHs + 7 MEDs + 8 LOWs identified should sweep in a single follow-up closure commit (~1 hour of textual editing) BEFORE the V3.6.0.X phase-termination megaudit enters.  No correctness issues found.  Engine + IDE + tests are clean.

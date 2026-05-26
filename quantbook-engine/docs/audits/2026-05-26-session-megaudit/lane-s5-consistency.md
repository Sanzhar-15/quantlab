# Lane S5 — Cross-Document + Memory Consistency Audit

**Scope:** 2026-05-26 session. Narrow focus: do all docs and memory files AGREE with each other and with git reality?  
**Auditor:** Sonnet S5 (audit-only lane, no code changes).  
**Engine HEAD at audit:** `302c7243ddc` (git ground truth — confirmed via `git log`).

---

## Git Ground Truth (verified)

```
302c7243ddc  docs(quantbook): LOCK Phase 6 decision-lock (wedge-first, staged; Codex-validated)
a2722008b24  docs(quantbook): scope CellValueJson union retype (5.8 D2-1) -- validated, deferred
cabe0e2847b  docs(quantbook): mark 5.8 megaudit B#1 (export_snapshot) CLOSED in closures + exit packet
ff09a5e17a7  fix(quantbook): 5.8 megaudit B#1 -- export_snapshot must hide tombstoned-sheet cells
e70de65f112  docs(quantbook): PHASE 5 COMPLETE -- 5.8 megaudit exit (PASS-WITH-FINDINGS)
fe83dc1322d  docs(quantbook): 5.8 Phase 5 Megaudit -- 4 lane transcripts + Lane E synthesis
dfa3d113c90  docs(quantbook): point Phase 6 entry-plan at the now-ready 5.8 megaudit package
b19d6990b28  docs(quantbook): set out the 5.8 Phase 5 Megaudit -- execution-ready 5-way plan + lane prompts
```

**Key SHAs:**
- Engine HEAD: `302c7243ddc` (Phase 6 decision-lock docs commit)
- Last engine SOURCE change: `ff09a5e17a7` (B#1 export_snapshot fix)
- Phase-5-audited baseline (V3.6 PHASE CLEAN): `1465b1db4c4`
- IDE HEAD: `d028568b53b` (V3.6.1.2 shared delta cache — unchanged this session)

---

## Finding #1 — Test Count: "158 lib" at audit vs "154 lib" post-B#1 (ARITHMETIC INCONSISTENCY)

**Severity:** MEDIUM  
**Files:**
- `docs/phase5/megaudit-5-8/lane-b.md:5` — "ran ql-collab (158 lib + 101 integration, all green)"
- `docs/phase5/megaudit-5-8/lane-b.md:127` — "158 lib + 101 integration tests pass"
- `docs/phase5/megaudit-5-8/lane-b.md:136` — "ql-collab 158+101"
- `docs/phase5/megaudit-5-8/closures.md:42` — "ql-collab 158+101, ql-oplog 67, ql-storage 199"
- `docs/phase5/megaudit-5-8/closures.md:79` — "10.7k LOC, 158+101 passing tests"
- `docs/phase5/megaudit-5-8/closures.md:90` — "+1 ql-collab test (255 pass)"
- `docs/phase5/phase-5-exit-packet.md:22` — "158+101 tests"
- `docs/phase5/phase-5-exit-packet.md:39` — "+1 ql-collab regression test (255 pass / 0 fail)"
- `docs/MASTER-PLAN.md:694` — "ql-collab is real: 158+101 tests"
- `memory/current_work.md:3` — "ql-collab **255/0** (154 lib + 101 integration)"
- `memory/current_work.md:18` — "ql-collab 255 pass / 0 fail"
- `memory/MEMORY.md:2` — "ql-collab **255/0** (154 lib + 101 integration)"

**Evidence:**
The 5.8 megaudit ran against `1465b1db4c4` with 158 lib + 101 integration = 259 ql-collab tests. B#1 (`ff09a5e17a7`) added "+1 ql-collab regression test", which should give 159 lib + 101 integration = 260 total. But current_work.md and MEMORY.md report "255 pass (154 lib + 101 integration)". The math does not close:

- 158 lib (audited baseline) + 1 (B#1) = 159 lib expected post-fix
- current_work.md reports 154 lib (5 fewer than the V3.6 PHASE CLEAN value)
- 154 + 101 = 255 (total is internally consistent in current_work.md)
- 159 + 101 = 260 (what the arithmetic should yield from the chain)

The MASTER-PLAN V3.6.0.X termination (line 580) confirmed "ql-collab 158/158 (+4 over 154 V3.6.0.11 baseline)" at source `1465b1db4c4`. Then B#1 added 1, so the expected lib count at HEAD `ff09a5e17a7` is 159, not 154. The "154 lib" figure in current_work.md and MEMORY.md appears to be wrong by 5 — likely a copy/paste error from an earlier baseline (V3.6.0.11 was 154 before the +4 V3.6.0.X termination tests were added).

**Recommendation:** Verify the actual ql-collab test count at `ff09a5e17a7` by running `cargo test -p ql-collab` on the Mac host in the next session and correct whichever figure is wrong (either "154 lib" in current_work.md/MEMORY.md, or explain the discrepancy). The "255 total" figure may also be wrong (correct total might be 260 or the lib split at audit time may have been different).

---

## Finding #2 — closures.md §4 still says "158+101" without noting the post-B#1 update (STALE IN-DOC)

**Severity:** LOW  
**Files:**
- `docs/phase5/megaudit-5-8/closures.md:42` — Lane B summary row uses "158+101" (the pre-B#1 audit snapshot)
- `docs/phase5/megaudit-5-8/closures.md:79` — §4 exit criteria uses "158+101 passing tests"
- `docs/phase5/phase-5-exit-packet.md:22` — EC table row uses "158+101 tests"
- `docs/MASTER-PLAN.md:694` — Phase 5 exit criteria uses "158+101 tests"

**Evidence:**
The §5 closure table in closures.md (line 90) correctly records the post-B#1 count as "255 pass". But the §4 evidence rows (lines 42, 79) and the exit-packet EC table (line 22) and MASTER-PLAN exit criteria (line 694) all still say "158+101" — the count AT THE TIME THE LANES RAN, before B#1. This is technically correct as a historical record of what the audit verified, but these positions are read by the next session as the current test baseline, which is misleading.

**Recommendation:** Add a parenthetical note to closures.md §4 line 79, exit-packet EC table row 1, and MASTER-PLAN line 694 indicating the count was updated post-fix: "(at audit; post-B#1 fix: 255 pass)". This is low-priority since the §5 closure table already records the post-fix count correctly — but a reader who stops at §4 or the EC table gets an out-of-date number.

---

## Finding #3 — MEMORY.md still says "158" in one place (STALE ENTRY)

**Severity:** LOW  
**File:**
- `memory/MEMORY.md:3` (the quantbook_engine_phase4_shipped.md pointer line) — this is not the current-session work; it references Phase 4 and is correctly marked as historical. No stale "158" in the main current-session memory entries.

**Evidence:**
A search of MEMORY.md found no top-level stale "158" for Phase 5 test counts. The current-work line (MEMORY.md line 2) correctly says "255/0 (154 lib + 101 integration)" which is consistent with current_work.md. The old "158" value in Lane B transcripts and closures.md is a historical audit-time snapshot, not a stale memory entry.

**Verdict on #3:** No stale "158" in MEMORY.md's current-session entry. The concern from the audit brief is NOT confirmed for MEMORY.md itself — the old value is only in the engine docs (closures.md, exit-packet, MASTER-PLAN) as the audit-time baseline, which is expected.

---

## Finding #4 — decision-lock.md HEAD note references "a2722008b24" but actual HEAD is "302c7243ddc" (BENIGN SELF-REFERENCE)

**Severity:** INFO  
**File:**
- `docs/phase6/decision-lock.md:5` — "Engine source HEAD at lock: `ff09a5e17a7` (docs on top to `a2722008b24`)"

**Evidence:**
The decision-lock.md was written and committed at `302c7243ddc`, but its internal header says "docs on top to `a2722008b24`" — meaning the document was authored when `a2722008b24` was HEAD, and then the commit `302c7243ddc` adding decision-lock.md itself became the new HEAD. This is a standard "committed as HEAD" timing gap and is not a real inconsistency. The claim "last source change = `ff09a5e17a7`" is correct (git confirmed: `ff09a5e17a7` is the last non-docs commit).

**Recommendation:** No action needed. The pattern is identical to past decision-lock artifacts (V3.6.0.1 lock was also authored before the commit that added it).

---

## Finding #5 — Phase 6 Sequence: ALL DOCUMENTS AGREE (CLEAN)

**Severity:** PASS (no inconsistency)  
**Cross-checked across:**
- `docs/phase6/decision-lock.md:26-38` (§2 locked sequence, authoritative)
- `docs/phase6/entry-plan.md:3` (status header, superseded note)
- `docs/phase6/entry-plan.md:71` (§5 superseded note with full sequence)
- `docs/MASTER-PLAN.md:710` (Phase 6 DECISION-LOCKED paragraph)
- `memory/current_work.md:3` (MEMORY.md line 2)
- `memory/current_work.md:43` (Phase 6 next steps)

**Evidence:**
Every document that states the locked sequence uses the same order:
**6.1A → 6.1B → 6.1C → 6.4-0 → 6.4A → 6.4B → 6.3 → 6.2 → 6.5 → 6.6 → 6.7**

- decision-lock.md §2 items 2-12: `6.1A, 6.1B, 6.1C, 6.4-0, 6.4A, 6.4B, 6.3, 6.2, 6.5, 6.6, 6.7` ✅
- entry-plan.md §5 superseded note: "6.1A → 6.1B → 6.1C(audit) → 6.4-0(fn-metadata) → 6.4A(MVP UDF + minimal Python slice) → 6.4B(harden) → 6.3 → 6.2 → 6.5 → 6.6 → 6.7" ✅
- MASTER-PLAN.md Phase 6 paragraph: "6.1A session-API contract → 6.1B owning WorkbookSession → 6.1C security audit → 6.4-0 function-metadata substrate → 6.4A ... → 6.4B UDF hardening → 6.3 full bindings → 6.2 service (defer HTTP-vs-gRPC) → 6.5 SQL/connectors → 6.6 AI (sentinel; =AI() cell fn is v2-aligned) → 6.7 audit" ✅
- current_work.md §Next: same order ✅
- MEMORY.md current-work entry: same order ✅

The sequences are fully consistent across all five documents. No divergence found.

---

## Finding #6 — Disposition Consistency: EC#2, Op::Unknown, AI() (CLEAN)

**Severity:** PASS (no inconsistency)

**EC#2 = DEFER + amend** — checked across:
- `docs/phase5/megaudit-5-8/closures.md:103` (§6: "DEFER (recommended): amend Criterion #2..."; "DECIDED 2026-05-26 (user): (a) = DEFER + amend criterion") ✅
- `docs/phase5/phase-5-exit-packet.md:27-31` (§3: "Decision (DEFER + amend): Exit Criterion #2 is amended...") ✅
- `docs/MASTER-PLAN.md:695` ("Tables: collaborative merge DEFERRED (criterion amended 2026-05-26 per the 5.8 megaudit)") ✅
- `memory/current_work.md:30-31` ("Tables EC#2 = DEFER + amend criterion") ✅
- `memory/MEMORY.md:2` ("tables EC#2 = DEFER+amend") ✅

**Op::Unknown = amend spec** — checked across:
- `docs/phase5/megaudit-5-8/closures.md:107-110` (§6: "AMEND: document that top-level unknown ops intentionally reject at decode"; "DECIDED... (b) = AMEND the contract") ✅
- `docs/phase5/phase-5-exit-packet.md:33-35` (§4: "Decision (AMEND contract): top-level unknown ops intentionally reject at decode") ✅
- `docs/MASTER-PLAN.md:681` (mentions Op::Unknown proven UNREACHABLE) ✅ (does not contradict)
- `memory/current_work.md:32` ("Op::Unknown = amend spec") ✅
- `memory/MEMORY.md:2` ("Op::Unknown = amend spec") ✅

**AI() = defer; cell function v2-aligned** — checked across:
- `docs/phase6/decision-lock.md:19-21` (D3: "lock =AI() cell function as v2-aligned") ✅
- `docs/MASTER-PLAN.md:710` ("=AI() cell fn is v2-aligned") ✅
- `memory/current_work.md:43` ("=AI() cell fn v2-aligned") ✅
- `memory/MEMORY.md:2` ("=AI() cell fn v2-aligned") ✅

All three dispositions are stated consistently across every document that mentions them. No divergence found.

---

## Finding #7 — Phase 5 Verdict: ALL DOCS AGREE "PASS-WITH-FINDINGS / COMPLETE" (CLEAN)

**Severity:** PASS (no inconsistency)  
**Cross-checked:**
- `docs/phase5/megaudit-5-8/PLAN.md:3` — "EXECUTED 2026-05-26 — PASS-WITH-FINDINGS → PHASE 5 COMPLETE" ✅
- `docs/phase5/megaudit-5-8/closures.md:1-3` — "VERDICT: PASS-WITH-FINDINGS → PHASE 5 COMPLETE" ✅
- `docs/phase5/phase-5-exit-packet.md:3` — "PHASE 5 COMPLETE (2026-05-26)" ✅
- `docs/phase6/entry-plan.md:39-41` — "DONE 2026-05-26... PASS-WITH-FINDINGS → PHASE 5 COMPLETE... This gate is CLOSED" ✅
- `docs/phase6/entry-plan.md:83` — "R-P6-1 RESOLVED 2026-05-26 — Phase 5 stable enough to expose is now audited, not asserted" ✅
- `docs/MASTER-PLAN.md:681` — "EXECUTED 2026-05-26 (PASS-WITH-FINDINGS)" ✅
- `memory/current_work.md:3` — "PHASE 5 COMPLETE... PASS-WITH-FINDINGS" ✅
- `memory/MEMORY.md:2` — "PHASE 5 COMPLETE... PASS-WITH-FINDINGS" ✅

No document says Phase 5 is still in-progress or the gate is still open. All are consistently marked COMPLETE / gate CLOSED.

---

## Finding #8 — No Stale "5.8 is the open gate / READY TO EXECUTE" Pointers (CLEAN)

**Severity:** PASS (no inconsistency)  
**Evidence:**
- `docs/phase5/megaudit-5-8/PLAN.md:3` — correctly marked "EXECUTED 2026-05-26" ✅
- `docs/phase6/entry-plan.md §3` — correctly marked gate CLOSED; the pre-run analysis preserved below §3 is explicitly labeled "[Pre-run analysis — provenance]" and "[Pre-run recommendation — provenance, now DONE]" ✅
- `docs/phase6/entry-plan.md:73` — "Do not enter Phase 6 before this passes / closes" is in the provenance section, immediately preceded by "now DONE" ✅
- MEMORY.md — no "5.8 megaudit is the open gate" language; current entry says COMPLETE ✅

The entry-plan §5 pre-lock bullet "1. 5.8 Phase 5 Megaudit (gate; 3-lane; ~4–6 d) → formal Phase 5 exit. Do not enter Phase 6 before this passes / closes." is retained as provenance under the "SUPERSEDED" warning and a "[Pre-run recommendation — provenance, now DONE]" label. This is clearly marked as historical; it does not claim the gate is still open.

---

## Finding #9 — Git SHA Consistency Across All Documents (MOSTLY CLEAN; ONE NUANCE)

**Severity:** INFO  
**Cross-check of stated SHAs vs git reality:**

| SHA | Claimed role | Git reality | Status |
|---|---|---|---|
| `302c7243ddc` | Engine HEAD (Phase 6 decision-lock) | ✅ Confirmed as current HEAD via `git log` | MATCH |
| `ff09a5e17a7` | Last engine SOURCE change (B#1 fix) | ✅ Confirmed: `fix(quantbook): 5.8 megaudit B#1` | MATCH |
| `1465b1db4c4` | Phase-5-audited baseline (V3.6 PHASE CLEAN) | ✅ Cited consistently in closures.md, exit-packet, PLAN.md, entry-plan.md | MATCH |
| `d028568b53b` | IDE HEAD (V3.6.1.2 shared delta cache) | Not directly verifiable from engine repo (IDE is separate) | NOT VERIFIABLE |
| `a2722008b24` | "docs on top" at decision-lock authoring | ✅ Confirmed: `docs(quantbook): scope CellValueJson union retype` | MATCH |

**Nuance:** `decision-lock.md:5` says "Engine source HEAD at lock: `ff09a5e17a7` (docs on top to `a2722008b24`)". This is the HEAD *when the document was authored*, before the `302c7243ddc` commit that added decision-lock.md itself. This is consistent and expected — the HEAD moved to `302c7243ddc` because adding decision-lock.md was the commit.

All documents that cite these SHAs (closures.md, exit-packet, PLAN.md, entry-plan.md, current_work.md, MEMORY.md, decision-lock.md, codex-decision-lock-review.md) cite them consistently. No SHA mismatch found.

---

## Finding #10 — IDE Mocha Count "1424/0" Only in Memory (INFO — Not a Doc Inconsistency)

**Severity:** INFO  
**Files:**
- `memory/current_work.md:3` and `memory/current_work.md:19` — "IDE mocha 1424/0"
- `memory/MEMORY.md:2` — "IDE mocha 1424/0"

**Evidence:**
The IDE mocha count "1424/0" appears in both current_work.md and MEMORY.md and is internally consistent. It does NOT appear in the engine docs (closures.md, exit-packet, decision-lock.md, entry-plan.md, MASTER-PLAN.md). This is expected: the engine doc set does not track IDE mocha counts at the exit-packet level. The memory docs track it for next-session orientation.

No inconsistency found. The count is stable at 1424 across both memory files.

---

## Finding #11 — entry-plan.md "Authored at" SHA Predates Megaudit (INFO — Correct Provenance)

**Severity:** INFO  
**File:**
- `docs/phase6/entry-plan.md:5` — "Authored at: engine `741b9530b3d` (V3.6.1.2 + B8/CellValueJson doc closes; engine SOURCE unchanged at `1465b1db4c4` = V3.6 PHASE TERMINATION CLEAN) + IDE `d028568b53b` (V3.6.1.2)."

**Evidence:**
The entry-plan was authored before the 5.8 megaudit ran (the authoring SHA `741b9530b3d` appears in the git log further back). The status header correctly says "LOCKED 2026-05-26" and redirects to decision-lock.md. The "Authored at" field is historical provenance (like a "created at" timestamp) and does not conflict with the current lock status. This is a correct and expected asymmetry between authoring SHA and locking SHA.

---

## Summary Table

| # | Finding | Severity | Clean? |
|---|---|---|---|
| 1 | Test count arithmetic: 158 lib at audit + 1 (B#1) ≠ 154 lib claimed in current_work.md/MEMORY.md (expected 159; reported 154; total 255 vs expected 260) | MEDIUM | INCONSISTENT |
| 2 | closures.md §4, exit-packet EC table, MASTER-PLAN exit criteria still say "158+101" without post-B#1 update note | LOW | MINOR STALE |
| 3 | MEMORY.md main current-session entry: no stale "158" (concern in audit brief NOT confirmed) | INFO | CLEAN |
| 4 | decision-lock.md HEAD note references pre-self-commit SHA (benign timing artifact) | INFO | CLEAN |
| 5 | Phase 6 sequence (6.1A→…→6.7): fully consistent across all 5 documents | PASS | CLEAN |
| 6 | Dispositions (EC#2=DEFER+amend, Op::Unknown=amend, AI()=v2-aligned): fully consistent | PASS | CLEAN |
| 7 | Phase 5 verdict (PASS-WITH-FINDINGS / COMPLETE): fully consistent across all 8 docs | PASS | CLEAN |
| 8 | Stale "5.8 gate still open" pointers: none found; all correctly marked EXECUTED/DONE | PASS | CLEAN |
| 9 | Git SHA cross-check: all cited SHAs match git reality | PASS | CLEAN |
| 10 | IDE mocha count "1424/0": consistent across both memory files; not tracked in engine docs (expected) | INFO | CLEAN |
| 11 | entry-plan.md "Authored at" predates megaudit: correct historical provenance | INFO | CLEAN |

---

## VERDICT

**The doc set is MOSTLY CONSISTENT.** The following are confirmed:

- All Phase 5 status claims (COMPLETE / PASS-WITH-FINDINGS) are consistent across MASTER-PLAN, exit-packet, closures.md, entry-plan.md §3, current_work.md, MEMORY.md.
- The Phase 6 locked sequence is identical across all five documents.
- The three user-decided dispositions (EC#2, Op::Unknown, AI()) are stated consistently everywhere they appear.
- Git SHAs are correct throughout.
- No document still describes Phase 5 as in-progress or the 5.8 gate as open.
- IDE mocha count is stable at 1424 across both memory files.

**ONE REAL INCONSISTENCY requiring investigation (Finding #1):**

The lib test count in current_work.md and MEMORY.md is stated as "154 lib + 101 integration = 255 total". The V3.6.0.X phase-termination megaudit (MASTER-PLAN line 580) confirmed the baseline at `1465b1db4c4` was "ql-collab 158/158 (+4 over 154)". After B#1 added one test, the expected count is 159 lib, not 154. The total should be 159+101=260, not 255. Either:
- (a) "154 lib" in current_work.md/MEMORY.md is a copy-paste error from the V3.6.0.11 baseline (154 was the count before the +4 V3.6.0.X termination tests were added), OR
- (b) The "101" in "158+101" at audit time includes some tests that are counted differently in "154 lib + 101 integration" at current_work time (different counting boundary), OR
- (c) The "255 total" is the true measured value and the "154 lib" split is wrong.

The next session should run `cargo test -p ql-collab` at `ff09a5e17a7` (HEAD before the docs commits) to confirm the actual lib and integration test counts, then correct whichever of these figures is wrong.

**ONE MINOR STALE NOTE (Finding #2):** The "158+101" citation in closures.md §4, exit-packet EC table, and MASTER-PLAN exit criteria are accurate as of when the lanes ran (the audit-time baseline) but do not note the post-B#1 update. Add a parenthetical "(at audit; post-B#1 fix: 255 pass)" to these lines to prevent next-session confusion.

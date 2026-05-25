# Phase 5.7 V3.6.0.10 D8 Megaaudit -- Docs + Handover Coherence (Codex Lane A)

**Date**: 2026-05-25
**Scope**: documentation, handover artifacts, active plan, MASTER-PLAN, IDE consumer contract, audit transcripts, memory handoff reachability. Engine implementation audit is out of scope.
**Engine HEAD observed**: `19a35b68cac`
**IDE HEAD observed**: `4c48f8809bc`

## Verification Performed

- Engine git trail observed: `19a35b68cac` <- `0521d6902b9` <- `82ed0d37d85` <- `2dbce5ee2a5` <- `dc74d48b97e` <- `ebe7c946429`.
- IDE git trail observed: `4c48f8809bc` <- `07fd6bb8988` <- `8b3f608b2c8` <- `9b7ac290917`.
- Quantbook mocha dry-run count: `406/406` using compiled `out/test/quantbook*.test.js`.
- Cargo test-list counts: ql-collab lib `154`, ql-oplog lib `67`, ql-collab-ws lib `10` + websocket transport `30`; the documented ql-collab-ws `42` includes the separate doctest pair.
- `cargo` was not on PATH in this shell; list commands used `~/.cargo/bin/cargo`.
- Memory handoff path `/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md` was not accessible in this sandbox. The analogous `/Users/sanzhar/.claude/.../memory/current_work.md` path was also absent.

## Summary

The final shipped state is recoverable from the combination of git log, `.plans/_active.md` rollout line 306, and `docs/MASTER-PLAN.md` line 572, but the handover documents are not drift-free. The highest-risk drift is in the active-plan frontmatter and `docs/architecture/ide-consumer-contract.md` section 4.1.z6: both are primary fresh-window entry surfaces, and both still contain pre-V3.6.0.10 or pre-D6-completion state.

The existing 2026-05-25 V3.6 transcript files are the expected four files:

- `docs/audits/2026-05-25-phase-5-7-v3-6-0-7-spike.md`
- `docs/audits/2026-05-25-phase-5-7-v3-6-0-8-codex.md`
- `docs/audits/2026-05-25-phase-5-7-v3-6-0-8-opus.md`
- `docs/audits/2026-05-25-phase-5-7-v3-6-0-8-closures.md`

No per-step V3.6.0.10 D8 audit transcript exists. That is not necessarily wrong, but the contract/plan audit tables should explicitly state D8 shipped with built-in +5 ql-collab and +6 mocha coverage and no separate per-step audit.

## Detailed Audit Notes

### `.plans/_active.md`

- Final test counters are correct: line 11 says `406 / 406`, line 12 says `154 / 154`, and independent dry-run/list checks matched those counts.
- The rollout body does include V3.6.0.10 D8 as shipped at line 306 with the correct +5 ql-collab and +6 mocha deltas.
- Frontmatter status/head state is stale: line 3 stops at V3.6.0.8.5 and then drifts backward into V3.6.0.X audit-of-D4 closure text; line 9 claims the current engine head is V3.6.0.8.3; line 10 claims the current IDE head is V3.6.0.8.5.
- The D7/D8/D9 design subsections are stale: D8 is still "DEFER to user feedback signal" and suggested as V3.6.0.9 at lines 242-254, while D9 still claims V3.6.0.10 at lines 266-270.
- The D6 rollout parent row still says "IN-PROGRESS" at line 298 even though line 304 says D6 ARC COMPLETE. Also, V3.6.0.8.5 is listed before V3.6.0.8.4 at lines 302 and 304.
- The risk register is uneven: R-V3.6-15 and R-V3.6-17 are explicitly closed, but most R-V3.6-1..18 entries are not status-normalized. R-V3.6-18 line 332 still describes the pre-8.4 `iter().skip()` implementation even though the D6 closure switched `apply_ops_in_range` to `OpLog::get`.
- The active out-of-scope list correctly does not list D8, but the audit pre-allocation section is stale: lines 355-357 still list D5 audit pending and phase termination at V3.6.0.10.

### `docs/MASTER-PLAN.md`

- The V3.6.0.8.1, 8.2, 8.3, 8.4, 8.5, and 0.10 paragraphs are present and ordered correctly at lines 562, 564, 566, 568, 570, and 572.
- The V3.6.0.8.4 paragraph correctly states the D6 perf contract: 1.08 ms delta vs 246 ms full snapshot, 228x faster, 46x under threshold; R-V3.6-15 and R-V3.6-17 are closed.
- The V3.6.0.10 paragraph has the final test baseline: ql-collab 154/154, ql-oplog 67/67, ql-collab-ws 42/42, IDE mocha 406/406, engine workspace release build clean.
- The leading V3.6 summary at line 547 is stale. It still says D6 is deferred pending profiling, D8 is deferred until user signal, D9 typing watchdog is V3.6.0.10, and only 13 risks exist. Later paragraphs correct this, but the first paragraph a fresh reader sees is contradictory.

### `docs/architecture/ide-consumer-contract.md` section 4.1.z6

- Section 4.1.z6 is the most drifted document.
- Status line 1802 stops at V3.6.0.8.5 and does not mention V3.6.0.10 D8.
- Engine and IDE head trails at lines 1804-1805 are stale and omit all current shipped heads.
- Test baseline line 1807 is stale at ql-collab 149/149 and IDE mocha 390/390; actual/documented final state is ql-collab 154/154 and IDE mocha 406/406.
- Decision table lines 1820-1823 still marks D6 partially pending, D7 as V3.6.0.8 pending, D8 as V3.6.0.9 pending, and D9 as V3.6.0.10 conditional.
- There is no V3.6.0.10 D8 subsection.
- D6 sub-step table line 2026 still marks V3.6.0.8.4 pending.
- Risk summary lines 2046, 2052, and 2054 are stale: R-V3.6-9 says D8 is not shipped; R-V3.6-15 still says BTreeMap and partial closure; R-V3.6-17 is still open.
- Audit transcript table lines 2057-2071 omits the V3.6.0.8 Codex/Opus/closures transcripts and does not record D8's no-separate-audit status.
- Out-of-scope lines 2077-2081 still list D6 in progress and D8 conditional, and put phase termination at V3.6.0.10 even though the active plan now says V3.6.0.11/D9 can still precede termination.

### Audit Transcripts

- The D6 audit Codex and Opus transcripts intentionally remain point-in-time findings. They are not stale by themselves because `2026-05-25-phase-5-7-v3-6-0-8-closures.md` documents the closures.
- The closure transcript correctly records D6 HIGH closures, R-V3.6-15 closure, R-V3.6-17 closure, and perf numbers.
- The closure transcript line 69 defers Opus-MED-5 to V3.6.0.8.5+; that is historically valid, but active/contract audit tables should now add the V3.6.0.8.5 closure state so readers do not stop at the historical deferral.

### Fresh-Window Readability

A fresh session can identify the true shipped state only by cross-checking conflicting documents against git. The final facts exist, but they are not consistently presented:

- Shipped this session: D6 8.1 through 8.5 and D8 0.10.
- Still pending/conditional: D7 `#REF!` substitution, D9 typing-stroke watchdog/sheet-tabs strategy, phase termination megaudit.
- Test counts are correct in the active plan and MASTER-PLAN final paragraph, stale in the IDE contract.
- The cycle-overrun warning is present in active plan and MASTER-PLAN final D8 paragraphs, but absent from the IDE contract.
- Memory handoff could not be checked because the file path is inaccessible.

## Verdict

**PASS-WITH-FINDINGS**

The documentation contains enough correct final-state material to recover the truth, but the primary fresh-window surfaces have high-severity drift that should be swept before the next implementation session.

## Findings Table

| Severity | ID | Title | File:line | Suggested fix |
|---|---|---|---|---|
| HIGH | CODEX-V3-6-0-10-DOCS-HIGH-1 | Active-plan frontmatter misstates shipped state and current heads | `.plans/_active.md:3` | Rewrite `status`, `current_engine_head`, `current_ide_head`, and `current_engine_workspace` to the V3.6.0.10 state. Engine trail should start `19a35b68cac <- 0521d6902b9 <- 82ed0d37d85 <- 2dbce5ee2a5 <- dc74d48b97e <- ebe7c946429`; IDE trail should start `4c48f8809bc <- 07fd6bb8988 <- 8b3f608b2c8 <- 9b7ac290917`. |
| HIGH | CODEX-V3-6-0-10-DOCS-HIGH-2 | IDE consumer contract section 4.1.z6 is pre-D8/pre-D6-completion in multiple primary fields | `docs/architecture/ide-consumer-contract.md:1802` | Update status, engine/IDE head trails, tests baseline, D6/D8/D9 decision rows, D6 sub-step table, and out-of-scope list. Add a V3.6.0.10 D8 subsection with restoreSheet surface, delta fullRebuild behavior, +5 ql-collab, +6 mocha, and cycle-6 warning. |
| MED | CODEX-V3-6-0-10-DOCS-MED-1 | MASTER-PLAN leading V3.6 summary contradicts later shipped paragraphs | `docs/MASTER-PLAN.md:547` | Refresh the lead V3.6 paragraph to say D6 shipped and D8 shipped, D7 remains pending at V3.6.0.9, D9 is V3.6.0.11 conditional, and risks now run through R-V3.6-18. Preserve the correct detailed paragraphs at lines 562-572. |
| MED | CODEX-V3-6-0-10-DOCS-MED-2 | Active-plan D7/D8/D9 design and rollout numbering still carry stale conditional numbering | `.plans/_active.md:242` | Mark D8 as user-directed shipped at V3.6.0.10, renumber D7/D9 forward-looking notes consistently, change D6 parent row from IN-PROGRESS to COMPLETE, and order V3.6.0.8.4 before V3.6.0.8.5. |
| MED | CODEX-V3-6-0-10-DOCS-MED-3 | V3.6 risk summaries are not status-normalized and contain pre-closure claims | `docs/architecture/ide-consumer-contract.md:2046` | Normalize R-V3.6-1..18 to CLOSED/PARTIAL/OPEN across active plan and contract. Specifically fix R-V3.6-9 after D8 shipped with D7 pending, R-V3.6-15 as CLOSED with FxHashMap, R-V3.6-17 as CLOSED with 692 us clone cost, and R-V3.6-18/apply_ops_in_range as using `OpLog::get` after V3.6.0.8.4. |
| MED | CODEX-V3-6-0-10-DOCS-MED-4 | Audit transcript tables omit D6 audit closures, V3.6.0.8.5 closure, and D8 no-audit status | `docs/architecture/ide-consumer-contract.md:2057` | Add rows for `2026-05-25-phase-5-7-v3-6-0-8-{codex,opus,closures}.md`, add V3.6.0.8.5 as Opus-MED-5 mocha coverage closure, and add V3.6.0.10 D8 as shipped without a separate per-step audit but with integrated tests. Mirror the same update in `.plans/_active.md` pending-audits section. |
| LOW | CODEX-V3-6-0-10-DOCS-LOW-1 | D6 lock text still contains stale Arc::make_mut/BTreeMap wording in contract and active plan | `docs/architecture/ide-consumer-contract.md:1972` | Either mark the V3.6.0.8.1 lock block explicitly as historical/pre-closure or update the wording to `(*cached_arc).clone()` always-clone and `FxHashMap<PeerID, Counter>`. Also sweep `.plans/_active.md:299` for the same historical lock text. |
| INFO | CODEX-V3-6-0-10-DOCS-INFO-1 | Memory handoff could not be audited from this sandbox | `/home/sanzhar/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/current_work.md` | Path does not exist in this environment. A follow-up with memory access should verify HEAD claims, test counts, D8 closure summary, first three commands, zero-cycle warning, and 6-cycle overrun accounting. |

## Recommended In-Cycle Closures

Must sweep before the next implementation session:

1. **HIGH-1**: active-plan frontmatter/head/status correction.
2. **HIGH-2**: IDE consumer contract V3.6.0.10 sweep, including D8 subsection and final test counts.

Should sweep before V3.6.0.X phase-termination audit:

1. **MED-1**: MASTER-PLAN leading V3.6 summary.
2. **MED-2**: active-plan D7/D8/D9 forward-looking numbering and D6 row ordering.
3. **MED-3**: risk status normalization across active plan and contract.
4. **MED-4**: audit transcript table updates.
5. **LOW-1**: D6 lock historical wording cleanup.

Memory handoff remains blocked until the requested path is available.

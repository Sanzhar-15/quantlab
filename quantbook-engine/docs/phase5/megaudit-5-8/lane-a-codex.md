Phase 5 Megaudit (5.8) — LANE A (Codex): adversarial empirical + CRDT convergence.

You are auditing the COMPLETE Quantbook Phase 5 collaboration surface (engine-internal Phase 5 "Multi-User CRDT Collaboration"). This is a PHASE-LEVEL megaudit, NOT a per-sub-step audit — the per-step audits already ran (140 transcripts in docs/audits/). Your value is finding bugs that only emerge across the FULL surface, under concurrency, and via empirical probing that static review misses. Audit-only: do NOT fix; report findings.

Repo (engine): /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
Source HEAD: `1465b1db4c4` (V3.6 PHASE TERMINATION CLEAN). Confirm with `git log --oneline -1`.

PHASE 5 EXIT CRITERIA you are helping verify (find anything that violates these):
1. Cells, formulas, names, sheets, AND TABLES merge deterministically under concurrency.
2. Offline sync + conflict diagnostics work.
3. Single-writer op log is not confused with collaboration.

CRATES: crates/ql-collab (CollabSession, cache walker, undo, presence, snapshot/delta), crates/ql-oplog (Op enum, replay, VersionVector, persistence), crates/ql-collab-ws (websocket transport/relay), crates/ql-bindings-node (napi), crates/ql-storage (Workbook, tombstones, FormatTable).

WIRE OPS (crates/ql-oplog/src/op.rs) — ~20 variants: PutValue, PutFormula, ClearFormula, SetName, AddSheet, RenameSheet, RemoveSheet, RestoreSheet, MoveSheet, RegisterFormat, SetCellFormat, BatchCommit, CreateTable, DropTable, RenameTable, RenameColumn, ResizeTable, SetReferenceMode, SetLocale, SetDateSystem, Unknown(String). Wire enums: LocaleWire, ReferenceModeWire, DateSystemWire.

YOUR ADVERSARIAL CHECKLIST (build + run tmp probes under crates/ql-collab/tests or a scratch bin; clean up after):
A1. Multi-peer CONVERGENCE across EVERY op type. For each Op variant and key pairs (esp. {RemoveSheet,RestoreSheet}, {RenameSheet,RenameSheet}, {MoveSheet,MoveSheet}, {RegisterFormat,RegisterFormat same id different string}, {CreateTable,DropTable}, {RenameTable,RenameColumn}, {ResizeTable,PutValue-in-range}): two peers apply concurrently, exchange bytes, merge both ways — assert BOTH peers converge to identical workbook AND identical snapshot. Report any non-convergence or order-dependence.
A2. TABLES + NAMES specifically (exit criterion 1, under-exercised): concurrent table ops + named-range ops merging deterministically. Probe CreateTable/DropTable/RenameTable/RenameColumn/ResizeTable + SetName convergence.
A3. Offline write queue × reconnect × merge (5.5 V2 V3 step 3): queue ops offline, reconnect, flush, merge — assert no loss, no dup, correct order, conflict diagnostics surface.
A4. Undo/redo × remote-merge interleavings (the grouped-undo bug class, R-V3.6-14/16): undo while remote ops in flight; redo after merge; grouped undo + merge-interval undo + remote interleave. Assert cache + workbook stay consistent; no stale cells.
A5. Snapshot/delta correctness under concurrency: workbookSnapshot + workbookSnapshotDelta after multi-peer merges, sheet removes/restores, renames. Assert the delta path's fullRebuildRequired fires whenever a non-deltable change happened; assert merged snapshot == fresh snapshot (no divergence). Probe the V3.6.0.X CONVERGENT-HIGH-1 area (RemoveSheet→RestoreSheet preserved-cells) for any remaining gap.
A6. Wire round-trips: for EVERY Op variant, encode→persist→load→replay produces identical workbook. Forward-compat: Op::Unknown + LocaleWire::Unknown etc. survive round-trip without panic/loss. .qbook persistence (oplog.bin + snapshot) round-trip.
A7. Panic/unwrap/overflow hunt: feed adversarial inputs (out-of-range sheet/row/col ids, u16::MAX boundaries, malformed version Buffers, empty/huge BatchCommit, deeply nested, NaN/Infinity at napi boundary) to the public + napi surface. Any panic/unwrap/index-OOB/silent-coercion is a finding.
A8. CODEX-MED-1 re-verify: out-of-range RemoveSheet cache-vs-replay parity was deferred V3.5.1+ as "only reachable via malformed logs." Empirically test whether any PRODUCER (napi or BatchCommit composition) can emit an out-of-range RemoveSheet that diverges cache from workbook.

DISCIPLINE: verify empirically where possible (build a probe, run it, report the actual result). Cite file:line for static findings. Distinguish PROVEN bugs from suspicions. Note any Phase 5 exit criterion you could NOT verify.

OUTPUT: write your findings transcript to docs/phase5/megaudit-5-8/lane-a.md. Format per finding:
---
#: <n>
Finding: <one line>
Severity: HIGH | MED | LOW | INFO
Files: <path:line, ...>
Evidence: <probe result OR cited code>
Recommendation: <closure direction>
---
End with: VERDICT (PASS / PASS-WITH-FINDINGS / FAIL) + a coverage note (which checklist items A1–A8 you completed; which you could not and why).

# 2026-05-26 Session Mega-Audit — Synthesis (Lane E)

**Scope:** everything the 2026-05-26 session shipped — the 5.8 Phase 5 megaudit + verdict (Phase 5 COMPLETE), the B#1 export_snapshot code fix, the Phase 6 decision-lock. Audited via 7 lanes: **Codex** (gpt-5.5, empirical) + **1 Opus agent** (verdict/claims) + **5 focused Sonnet agents** (B#1 code, leak-hunt, decision-lock citations, Phase 5 doc citations, cross-doc consistency) + this synthesis.
**Audited at:** engine HEAD `302c7243ddc` (session output `dfa3d113c90..302c7243ddc`; only code change `ff09a5e17a7`). IDE `d028568b53b`.

---

## 1. Overall verdict

**The session's work is SOUND.** Phase 5 COMPLETE is the right call; both dispositions (tables DEFER+amend, Op::Unknown amend-spec) and the Phase 6 decision-lock are validated. **Zero HIGH findings stand.** The audit found **one real code gap (S2-01, MED, now FIXED)** that B#1 had left, plus a cluster of **doc-accuracy issues** (now corrected). Lane verdicts: Codex (B#1 sound but flagged the delta gap), Opus (SOUND), S1 (B#1 correct), S2 (found the gap), S3 (decision-lock sound), S4 (citations accurate), S5 (consistent).

---

## 2. The one real code finding — S2-01 (MED) — FIXED `7e536fc07b2`

**Convergent (Codex C2 + Sonnet S2).** B#1 closed the `export_snapshot` tombstone leak but missed the analogous gap in the LIVE `workbook_snapshot_delta` path: its changedCells filter (`lib.rs:2714`) checked only `removed_sheet_set` (RemoveSheet ops *in the current delta window*), so a sheet tombstoned in a PRIOR window then written via a later PutValue leaked a `changedCells` entry for an already-removed sheet.
- **Severity = MEDIUM** (resolved between Codex's HIGH and S2's MED by independent verification of BOTH repos): a real bug in the live engine delta API, but masked end-to-end by (a) the abnormal flow required (`appendPutValue` on a deleted sheet) and (b) the IDE `mergeWorkbookDelta` defensive skip of changedCells for unknown sheets (`cellGridLogic.ts:1008-1014`). Codex's HIGH is correct on API-correctness; S2's MED is correct on user impact. Fixed because relying on the consumer's defensive skip for engine correctness is fragile (No-Fallbacks spirit).
- **Fix:** `lib.rs:2714` now also checks `inner.is_sheet_removed_in_cache(sheet)` (reflects ALL tombstones, both windows) — reusing the accessor B#1 added, completing the R-V3.6-19 / B#1 tombstone-leak closure. cargo check clean; ql-collab 255/0. **Follow-up:** a cross-window mocha integration test (needs a `.node` rebuild — same napi-can't-cargo-test constraint as B#1).

---

## 3. Verdict-soundness confirmations (Opus + Codex)

- **Table-unreachability (the PASS pivot) HOLDS — and is stronger than the session argued.** Opus: `ql-collab` + `ql-bindings-node` do NOT depend on `ql-exec` (where the only table producers, `WorkbookRuntime`, live) — so the table producers are **not linkable** from the collaborative surface, not merely uncalled. Codex independently confirmed: no napi/`WorkbookRuntime`/`BatchCommit` path emits `CreateTable/RenameTable/RenameColumn` into a mergeable `CollabSession` (only direct test `append_op` injection). Lane A's table HIGHs are genuinely UNREACHABLE → PASS-WITH-FINDINGS is correct. (Both flag: re-open the table HIGHs before exposing any collaborative table producer — already captured in the EC#2 amendment + decision-lock.)
- **Dispositions sound:** Op::Unknown "amend-not-build" verified (no top-level `Op::Unknown`; `deny_unknown_fields`; forward-compat via the 3 wire sub-enums). Tables DEFER consistent with the v1.5-collab classification.
- **B#1 fix correct (S1 + Codex C1):** tombstone source correct, empty-entries is the right shape, restore symmetric, no regression; the new ql-collab test is meaningful.
- **No regression (Codex C4):** ql-collab 255, ql-oplog 92, ql-storage 199 pass. (ql-collab-ws relay integration failed only on a sandbox `TcpListener::bind` permission denial — environment, not code.)

---

## 4. Doc-accuracy findings (convergent) — CORRECTED

| # | Finding (lanes) | Fix |
|---|---|---|
| DA-1 | **ql-collab lib test count is 154, not 158** (Opus O5 ran it; S5 converged). The "158+101" cited as exit evidence in closures.md / exit-packet:22 / MASTER-PLAN:694 was a pre-existing over-count (Lane B's integration "101" was exactly right). Total 255/0 is correct. | Corrected 158→154 (255 total) in the canonical exit docs. Transcripts left as historical record. |
| DA-2 | **Risk register is 39, not 38** (S4: 6+7+7+19=39; lane-b table has 39 rows). Substance correct (all walked, 0 falsely-closed). | Corrected "38/38"→"39/39" in closures.md + exit-packet. |
| DA-3 | **EC#2 ✅ overstates depth for names/tables** (Opus O6): verified only at the replay/WorkbookRuntime layer, not the collab merge path; concurrent CreateTable/ResizeTable untested. Not exit-blocking (no v1 producer). | Added a per-layer caveat to the EC#2 amendment. |
| DA-4 | **decision-lock citation drift** (S3): `mark_dirty_from_cell_write` is `1384-1432` not `1370-1395`; §4 "owns" should read "borrows" for the current WorkbookRuntime hook (the *target* WorkbookSession owns). | Corrected in decision-lock.md. |
| DA-5 (INFO) | Megaudit doc citations (`lib.rs:1757/2226/2804`, session.rs fns) **shifted +10/+16** because the B#1 commit added 54 lines to session.rs — accurate when written at `1465b1db4c4` (S4). | Noted; not rewritten (they were correct at the audited commit). |

---

## 5. Deferred (LOW / non-blocking; logged for the polish session)
- S1-F07: `export_snapshot` `# Semantics` docstring is stale (describes V3.2.a; inline comment covers the tombstone rationale).
- S2-04 / cellGridPanel.ts:12: stale docstring; and `exportSnapshot` is confirmed DEAD in all live IDE render paths (test-only) — so the original B#1 was even more latent than framed.
- S2-01 mocha cross-window integration test (needs `.node` rebuild).
- CellValueJson union retype (recipe in closures.md §5), coverage gaps (D5), other doc-drift.

---

## 6. Bottom line
The session shipped sound work: a correct Phase 5 exit, a correct B#1 fix (now *completed* by S2-01), and a well-validated Phase 6 lock. The audit's value was finding S2-01 (the half-finished tombstone closure, now fixed) and tightening four propagated doc-accuracy claims (now corrected). No verdict was wrong; no HIGH stands. Engine HEAD after the audit: `7e536fc07b2` (S2-01 fix) + the doc corrections.

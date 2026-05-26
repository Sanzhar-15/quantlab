# 2026-05-26 Session Megaudit — LANE OPUS (verdict soundness + claims integrity)

**Auditor:** Opus Agent (independent re-derivation, audit-only — nothing changed).
**Audit target:** the 2026-05-26 Quantbook session's three claims — (1) 5.8 Phase 5 Megaudit → PASS-WITH-FINDINGS → MASTER-PLAN Phase 5 COMPLETE + EC#2 amendment + Op::Unknown amendment + exit packet; (2) B#1 engine fix (`ff09a5e17a7`); (3) Phase 6 decision-lock (`302c7243ddc`).
**Repos at audit:** engine HEAD `302c7243ddc` (source unchanged at `1465b1db4c4` + B#1 fix `ff09a5e17a7`); IDE HEAD `d028568b53b`.
**Method:** read PLAN.md + closures.md + 4 lane transcripts; then *re-derived the decisive claims directly from code* — the reachability claim (grep table-op producers + Cargo dep graph), the Op::Unknown claim (op.rs enum), the EC#2 wording, the B#1 fix, the test counts (ran `cargo test -p ql-collab -p ql-oplog` on the Mac host), and a spot-check of the risk-register walk.

---

## Headline

**The session's central verdict is SOUND.** The pivot that flips Lane A's FAIL to PASS-WITH-FINDINGS — "the table-convergence HIGHs are unreachable because no collaborative table producer exists" — is **independently CONFIRMED by the strongest possible evidence: the crate dependency graph.** Neither `ql-collab` nor `ql-bindings-node` depends on `ql-exec`, where the only table-op producers (`WorkbookRuntime`) live. Both dispositions (tables DEFER+amend; Op::Unknown amend-not-build) are correct. The B#1 fix is real and tested. I found **no PROVEN wrong conclusion** in the session's decisions.

I found **0 HIGH, 2 MED, 4 LOW, 3 INFO**. The MEDs are claims-integrity issues (a wrong test-count split that propagated into the canonical exit docs, and an exit-criterion attestation that is asserted-by-trace rather than tested at the claimed layer), not correctness defects in the engine.

---

## A1 — Re-verify the 5.8 megaudit VERDICT independently

### Finding O1 — The reachability claim ("no collaborative table producer") is INDEPENDENTLY CONFIRMED via the crate dependency graph — the strongest evidence, stronger than the grep the session relied on
- **Severity:** INFO (positive confirmation — this is the load-bearing claim and it holds)
- **Files:** `crates/ql-collab/Cargo.toml` (no `ql-exec` dep); `crates/ql-bindings-node/Cargo.toml:` deps = `ql-collab`, `ql-collab-ws`, `ql-oplog`, `ql-storage` (no `ql-exec`); `crates/ql-exec/src/workbook_runtime/tables.rs:162,231,308,447,714` (the ONLY `Op::CreateTable/DropTable/RenameTable/RenameColumn/ResizeTable` constructions in the workspace, all inside `WorkbookRuntime`).
- **Evidence:** I re-ran the reachability analysis from scratch:
  - `grep "Op::CreateTable|Op::DropTable|Op::RenameTable|Op::RenameColumn|Op::ResizeTable"` across `ql-bindings-node/src/` + `ql-collab/src/` returns ONLY pattern-matches (in `classify_delta_op` lib.rs:399/445-447 and `repair.rs` walkers) — **zero struct-literal constructions**. The only constructions are `oplog.append(Op::CreateTable{...})` etc. in `ql-exec/src/workbook_runtime/tables.rs`.
  - The only `append_*` napi methods are `append_put_value` (lib.rs:1578) and `append_put_formula` (lib.rs:1651). No `appendCreateTable`/`appendRegisterFormat`/`appendClearFormula`/`appendSetCellFormat` exists.
  - No table/column-producing `pub fn` on `CollabSession` (`grep "pub fn .*table|pub fn .*column" ql-collab/src/session.rs` → only `format_table_cache_iter`).
  - Every `WorkbookRuntime` mention in `ql-collab`/`ql-bindings-node` source is a comment or docstring — never a call (verified by reading each of the 11 hits).
  - **The decisive proof the session UNDER-stated:** `ql-collab` has NO `ql-exec` dependency (the only "ql-exec" string in its Cargo.toml is a comment), and `ql-bindings-node` depends only on collab/collab-ws/oplog/storage — NOT ql-exec. `WorkbookRuntime` lives in `ql-exec`. Therefore the table producers are not merely "uncalled" — they are **not even linkable** from the collaborative surface. A conflicting table log is producible only by hand-constructing raw `Op` values (exactly Codex's probe), the malformed-logs-only class.
- **Conclusion:** Lane A's A#2/#3/#4 are **PROVEN replay aborts but genuinely LATENT/UNREACHABLE.** The session's reconciliation (closures.md §3) is correct, and is in fact more robustly true than the session argued — the dependency-graph cut is a stronger argument than "no producer is wired in." **The verdict flip from FAIL → PASS-WITH-FINDINGS is sound.** Same logic confirmed for A#6 (no `appendRegisterFormat`) and C#1 (no `appendClearFormula`/`appendSetCellFormat`).

### Finding O2 — Lane A's FAIL was the correct *strict* reading; the synthesis correctly out-weighted it against three reachability-assessing lanes
- **Severity:** INFO
- **Evidence:** Lane A read EC#2 literally ("a `rebuild_workbook` that aborts is not a deterministic merge → FAIL", lane-a.md:72) and was right to do so — the aborts are real and Codex proved them empirically. But Lane A explicitly did NOT assess reachability (its job was adversarial empirical probing). Lanes B/C/D — the three that DID assess the shipped surface — all returned PASS / PASS-WITH-FINDINGS with 0 HIGH, each independently noting "no producer" (lane-b risk-register, lane-c finding-#1 Reachability para, lane-d D5-3/GAP-3). The synthesis (closures.md §1-3) correctly identifies that the lone FAIL rests entirely on the unreachable cluster and that the reachability-aware lanes concur. This is sound megaudit synthesis, not papering-over: the disagreement is surfaced faithfully (closures.md §3 "Lane A reads … strictly … Lane D reads … pragmatically … resolved against the code directly").

## A2 — Were the DISPOSITIONS sound?

### Finding O3 — Op::Unknown disposition ("amend spec, don't build") is CORRECT — re-verified against op.rs
- **Severity:** INFO (positive confirmation)
- **Files:** `crates/ql-oplog/src/op.rs:46-49` (`Op` derives `#[serde(deny_unknown_fields, tag="kind")]` + `#[non_exhaustive]`); 22 concrete variants PutValue..SetDateSystem (op.rs:51-493); `Unknown(String)` arms ONLY on the three wire sub-enums — `ReferenceModeWire` (op.rs:511), `LocaleWire` (op.rs:570), `DateSystemWire` (op.rs:636).
- **Evidence:** I read the enum. There is **no top-level `Op::Unknown`** — confirmed. `deny_unknown_fields` + `tag="kind"` means an unknown op kind hard-rejects at decode (exactly what Codex's serde probe showed, lane-a.md:59). The three wire sub-enums each have an `Unknown(String)` read-side arm whose `from_str` maps unknown strings to `Unknown(_)` (op.rs:553/611/673) and whose replay surfaces `ReplayError::Unknown{Locale,ReferenceMode,DateSystem}`. So forward-compat for *bounded value spaces* (locale/refmode/datesystem) exists via the sub-enums; cross-version *op-kind* forward-compat does not, and is the documented V3.7+ stable-op-ID concern. **The decision to amend the spec (top-level unknown ops intentionally reject; forward-compat via wire sub-enums + `.qbook snapshot_format_version`) rather than build a catch-all arm is correct** — building an opaque `Op::Unknown` now would be speculative (no cross-version producer exists) and would complicate the deny_unknown_fields invariant. 3-lane convergent (A#5/B#4/D5-1) and all three agree the PLAN named a mechanism that doesn't exist; the fix is a doc/spec correction.

### Finding O4 — Tables EC#2 DEFER+amend is DEFENSIBLE given the engine plan classes collab as v1.5-deferred
- **Severity:** INFO (positive confirmation) + one wording caveat folded into O6
- **Files:** `docs/MASTER-PLAN.md:34` (engine Phase 5 collab → "Product Phase 9 (deferred to v1.5 per canonical plan)"); `docs/phase5/phase-5-exit-packet.md:31`; closures.md §6(a).
- **Evidence:** MASTER-PLAN §0 row explicitly maps "Engine 5 (Collaboration CRDT) → Product Phase 9 (deferred to v1.5)." Collaborative table editing requires a collaborative table producer, which arrives with Engine Phase 6+/collab work = Product Phase 9 = v1.5. So deferring *collaborative* table-merge while keeping *single-writer* table ops (WorkbookRuntime, fully tested per repair_tables.rs 8 tests + ql-exec conflict matrix) correct-and-tested is internally consistent with the plan's own deferral classification. The amendment also correctly attaches the binding obligation: the future producer MUST land conflict-resolution (stable table/column IDs, non-aborting merge) + `removedCells` emission in the same change (phase-5-exit-packet.md:31, MASTER-PLAN.md:695). This is a real tracking commitment, not a silent punt. **Defensible.** (The one risk — that the deferral could mask a problem — is mitigated by the fact that the abort is loud (`rebuild_workbook` returns `Err`), not a silent wrong merge; a future producer cannot ship without hitting it.)

## A3 — Claims-vs-reality drift

### Finding O5 — MED — Test-count SPLIT is wrong in the canonical exit docs: ql-collab lib is **154**, not 158. The "158+101" figure propagated into closures.md, lane-b.md, MASTER-PLAN, AND the exit packet
- **Severity:** MED (claims integrity — a wrong number is repeated as evidence in four canonical Phase-5-exit documents)
- **Files:** `docs/phase5/megaudit-5-8/closures.md:42,79` ("ql-collab 158+101"); `docs/phase5/megaudit-5-8/lane-b.md:5,127,136` ("158 lib + 101 integration"); `docs/MASTER-PLAN.md:694` ("158+101 tests"); `docs/phase5/phase-5-exit-packet.md:22` ("158+101 tests").
- **Evidence:** I ran `cargo test -p ql-collab` on the Mac host at HEAD `302c7243ddc`. Per-binary result:
  - `unittests src/lib.rs` → **154 passed**, 0 failed (+ 6 ignored doctests).
  - integration: auto_flush 61 + rebuild_workbook 6 + repair_columns 8 + repair_columns_cross_kind 5 + repair_renames 13 + repair_tables 8 = **101 passed**, 0 failed.
  - **Total = 154 + 101 = 255 pass / 0 fail.** ql-oplog: 67 passed (one binary) — matches the cited "67". ql-storage not re-run this lane but Lane B cited 199 (not re-verified by me).
  - So the B#1 closure note's "255 pass" (closures.md:90, phase-5-exit-packet.md:39) is **CORRECT**, but the "158 lib" split repeated everywhere is **WRONG by 4** — the lib count is 154. The "158" appears to be a stale figure from an earlier HEAD that was carried forward without re-running. (After the B#1 fix added +1 test, the lib count would be 154 including it, so even "158 pre-fix" is not reconcilable with the live 154.)
- **Why it matters:** The exit packet and MASTER-PLAN cite "158+101" as the *evidence* that EC#1 ("ql-collab is real") is met. The evidence figure is wrong. The conclusion (ql-collab is real, suites green) is still TRUE — 255 pass / 0 fail — but a canonical exit attestation should cite the number that the suite actually reports.
- **Recommendation:** Correct "158+101" → "154+101 (255 pass / 0 fail)" in closures.md, lane-b.md, MASTER-PLAN.md:694, and phase-5-exit-packet.md:22. Trivial doc edit; do it before any external citation of the exit packet.

### Finding O6 — MED — EC#2 attestation for NAMES + TABLES is "verified-by-trace at a removed layer," not tested at the collab merge layer — the exit docs phrase it as ✅ without consistently flagging the layer gap
- **Severity:** MED (claims integrity — the ✅ is stronger than the evidence at the collab-CRDT layer for names/tables; the lanes flagged it but the top-line MASTER-PLAN line reads as fully-verified)
- **Files:** `docs/MASTER-PLAN.md:695` ("Cells, formulas, names, and sheets merge deterministically. ✅ … names verified at the WorkbookRuntime layer"); closures.md §4 #2 ("Names: ✅ at the WorkbookRuntime layer … one layer removed from collab"); lane-d.md D5-2/D5-3/GAP-2/GAP-3/4 (the actual gaps).
- **Evidence:** Lane D states it plainly (lane-d.md:175): "names + tables verified at replay/runtime level but with the merge-layer coverage gaps D5-2/D5-3 … the 'deterministic' claim is one layer removed for names/tables/create/resize." Concretely:
  - **Names:** convergence tested only via `WorkbookRuntime` (`phase_5_3_conflict_matrix_probe.rs:408 row5_setname_concurrent_same_name_converges`), NOT via `CollabSession::merge_bytes` (the path the IDE actually uses). GAP-4/D5-3.
  - **Tables:** concurrent CreateTable + ResizeTable convergence have NO test at any layer (GAP-3/D5-3); only RenameTable/RenameColumn/DropTable concurrent are covered (`phase_5_3_step4/step5`).
  - **Sheet ops at collab layer:** MoveSheet/AddSheet/RemoveSheet/RenameSheet/PutFormula/ClearFormula have no `merge_bytes`-layer convergence test (only replay-level); D5-2/GAP-2.
  - This is genuinely not exit-blocking (no v1 producer for tables/names — same reachability cut as O1), and closures.md §4 + the MASTER-PLAN parenthetical DO note "at the WorkbookRuntime layer." But the MASTER-PLAN top-line renders "names … merge deterministically ✅" with the caveat in a sub-clause, and the exit-packet table (phase-5-exit-packet.md:23) marks the whole row ✅ for "names at WorkbookRuntime layer." A reader scanning the ✅ would conclude the collab-CRDT merge path is tested for names; it is not.
- **Why it's MED not LOW:** EC#2 is a *stated exit criterion*. For two of its five subjects (names, tables) the determinism evidence is at a layer the product does not use and, for create/resize tables, is absent entirely. The disposition (defer the collab-layer coverage to post-exit polish item §5.3) is reasonable, but the ✅ overstates the *verification depth* for names/tables relative to cells/formulas/sheets (which ARE tested at merge_bytes). Honest phrasing would be "names/tables: deterministic at replay/runtime layer; collab-merge-layer coverage deferred (no v1 producer)."
- **Recommendation:** No code action. Tighten the MASTER-PLAN:695 + exit-packet:23 wording to distinguish "tested at collab merge_bytes layer" (cells/formulas/sheets/format) from "tested at replay/runtime layer only, collab-layer coverage deferred" (names/tables). The post-exit coverage items D5-2/D5-3 already capture the work.

### Finding O7 — LOW — Exit docs claim "all 4 exit criteria met" but EC#2 is literally NOT met (it was amended); the precise framing exists in closures but the one-liners overstate
- **Severity:** LOW
- **Files:** `docs/phase5/phase-5-exit-packet.md:14` ("ZERO reachable HIGH findings"), :4 ("PASS-WITH-FINDINGS"); MASTER-PLAN.md:545 ("exit criteria met for the reachable surface"); closures.md §4 #2 ("⚠️ … the one criterion not literally met").
- **Evidence:** closures.md §4 is scrupulously honest — it marks EC#2 "⚠️ … Tables: ✗ at replay (documented V1 hard-fail), but UNREACHABLE" and calls it "the one criterion not literally met." But MASTER-PLAN.md:545 compresses this to "exit criteria met for the reachable surface" and the exit packet §2 table shows EC#2 as ✅ (with "DEFERRED" only in the cell text). The accurate statement is: 3 of 4 criteria met as written; the 4th (EC#2) was *amended* to scope tables out, then met as amended. "Met for the reachable surface" is defensible shorthand but slightly launders the fact that a stated criterion was changed to pass. This is a transparency nuance, not a falsehood — the amendment is documented in the same files.
- **Recommendation:** No action required; the amendment is disclosed. If tightening, phrase as "3/4 criteria met as written; EC#2 amended (tables collaborative-merge deferred) and met as amended."

### Finding O8 — LOW — Risk-register closure citations have drifted ~16 lines (force_clear sites cited at 3808/3902, actually 3824/3918 at HEAD); substance correct
- **Severity:** LOW (cosmetic — but it is *citation* drift in the evidence column of the risk-register, the artifact whose whole value is precise file:line proof)
- **Files:** lane-b.md:114 (R-V3.6-14 cites `session.rs:3808/3902`); actual `force_clear_workbook_cache` calls at HEAD: 1699 (merge_bytes), 3265 (discard_pending_ops), 3660 (poll_remote), 3824 (undo), 3918 (redo) — verified by grep. Also lane-b.md itself flags R-V3.6-15 cite drift (Finding 2: doc says 2604-2613, actual 2609-2617) and R-V3.6-1 title drift (Finding 3: "on_pop" vs `set_on_push`).
- **Evidence:** I spot-checked R-V3.6-19 (RemoveSheet no-prune arm, session.rs:1611 — confirmed: the arm only does `buckets.tombstones.insert(id)` with a comment "Post-closure: preserved") and R-V3.6-14 (force_clear before undo — confirmed present at 3824, and the +16-line drift is explained by the B#1 fix + intervening edits shifting lines). The substance of the risk-register walk is sound; the line numbers are a few lines stale because the lanes ran against `1465b1db4c4` working-tree and the file shifted. Lane B's "38/38 confirmed, 0 falsely-closed" is substantiated for my spot-checks (R-V3.6-19, R-V3.6-14, and the export_snapshot side-effect it correctly attributed to R-V3.6-19).
- **Recommendation:** Re-pin the cited line numbers on the next docs sweep (the closures.md §5 item-4 "doc-drift sweep" already captures B#2/B#3; add the force_clear-site re-pin).

## A4 — Coverage gaps in the 5.8 megaudit itself

### Finding O9 — Lane A's "partial" coverage gaps (A5 napi delta, A6 .qbook, A7 NaN/Infinity) are appropriately covered by OTHER lanes + the IDE mocha suite — NOT papered over
- **Severity:** INFO (positive confirmation — I checked each gap against actual coverage rather than trusting the synthesis)
- **Evidence:** Lane A's coverage note (lane-a.md:79-82) honestly marked A5/A6/A7 "partially completed." I verified each is covered elsewhere:
  - **A5 (napi `workbookSnapshotDelta` not empirically run by Codex):** Lane C traced the entire delta path end-to-end statically (lane-c.md C1-C11) AND the IDE mocha suite exercises the REAL compiled `.node` binding — 70 `workbookSnapshotDelta`/`mergeWorkbookDelta` references in `test/quantbook-roundtrip.test.ts` including empty-buffer→fullRebuild, no-cache, same-VV fast-path, cell-only emits changes, rename→fullRebuild, undo-invalidation, and the shape-equivalence guard (`delta-merged === fresh workbookSnapshot`, ~:7486). The napi delta path is well-covered.
  - **A6 (.qbook persistence not re-probed):** 25 `toQbook`/`fromQbook`/`.qbook` references in the IDE mocha suite exercise the real round-trip through the binding (`to_qbook` lib.rs:2076, `from_qbook` lib.rs:2873). The forward-compat sub-concern (unknown ops surviving persistence) IS the Op::Unknown item, already dispositioned (O3).
  - **A7 (napi NaN/Infinity not run):** `validate_u32_index` (lib.rs:169) + `validate_u16_index` (lib.rs:219) both check `!value.is_finite()` and reject at the FFI boundary; Lane D's D3 confirmed producer/replay symmetry statically; and MASTER-PLAN records IDE mocha tests "u16 sheet rejection on both appendPutValue and appendPutFormula (NaN/Infinity/fractional/2^32)." Covered.
  - The stray `megaudit_lane_a_tmp.rs` (D6-3) is confirmed REMOVED (`ls` → No such file; `git status` clean) so the "255 pass" baseline is not perturbed by Lane A's scratch probes.
- **Conclusion:** The synthesis did NOT paper over Lane A's partials — each falls inside another lane's coverage or the IDE mocha binding-level suite. **No real risk left unaudited by the partials.**

### Finding O10 — LOW — The "38/38 risk register confirmed" is substantiated, but 3 of the 38 (R-V3.4-3, R-V3.5-7, R-V3.6-12) are IDE-side closures whose TS code Lane B explicitly did NOT verify (it confirmed only engine-side prerequisites)
- **Severity:** LOW (the claim is technically defensible — Lane B flagged the boundary openly — but "38/38 confirmed" reads as fuller than the actual engine-lane verification)
- **Files:** lane-b.md:89/100/112 (R-V3.4-3, R-V3.5-7, R-V3.6-12 marked "IDE — out of engine-lane scope"); lane-b.md:147 (coverage note: "their TS closure code lives in the `extensions/quantlab/` worktree NOT in this engine repo, so the final TS verification belongs to Lane D / the IDE-facing lane — flagged explicitly, not silently skipped").
- **Evidence:** Lane B is honest: it walked all 38 and for the 3 IDE-only risks confirmed the engine-side prerequisite exists but states the TS closure was not verified in its lane. Lane D (the IDE-facing lane) covered contract/parity but did not re-verify those 3 specific IDE risk closures by name either (its D-section is contract/coverage, not a risk-register re-walk). So the 3 IDE-side risk closures (presence repaint race R-V3.4-3, mid-edit watchdog R-V3.5-7, click-to-edit rendered-string R-V3.6-12) rest on per-step audits, not on a 5.8-megaudit re-verification of their TS code. Given these are V3.5.0.7/V3.6.0.11-era closures with their own audits and are IDE-UX (not engine-correctness), this is acceptable — but "38/38 confirmed" slightly overstates: it's "35/38 confirmed at code level this megaudit + 3 IDE-side confirmed-at-prerequisite-level, deferred to prior per-step audits."
- **Recommendation:** No action. If precise, phrase as "35 engine risks re-verified at code; 3 IDE-side risks confirmed at engine-prerequisite level (TS closures rest on their V3.5/V3.6 per-step audits)."

---

## Cross-checks on the other two session claims (context, not core focus)

- **B#1 fix (`ff09a5e17a7`) is REAL and correct.** `CollabSession::is_sheet_removed_in_cache` exists (session.rs:1812); `export_snapshot` now returns `Vec::new()` for a tombstoned sheet (lib.rs:1763-1767), mirroring `workbook_snapshot`'s `is_sheet_removed` skip; `snapshot_cells` deliberately left tombstone-agnostic (its R-V3.6-19 invariant tests depend on it); regression test `is_sheet_removed_in_cache_tracks_tombstone_while_snapshot_cells_preserves` present (session.rs:6052). Suites green (255 pass / 0 fail). The fix matches its closure note exactly.
- **Phase 6 decision-lock (`302c7243ddc`) exists + is Codex-validated.** `docs/phase6/decision-lock.md` LOCKED 2026-05-26; full Codex review at `codex-decision-lock-review.md` (24.9KB) + prompt + `.out` (1.4MB console log). Wedge-first / staged-6.4 / Python-slice decisions documented; Codex sharpened 3 points (6.4/6.3-Python split, GIL→process isolation, 6.4-0 fn-metadata prerequisite). Not deeply re-audited (outside A1-A4 scope), but the artifacts substantiate the "Codex-validated" claim.

---

## VERDICT

**The session's Phase-5-COMPLETE marking and both dispositions are SOUND.** The verdict flip (Lane A FAIL → PASS-WITH-FINDINGS) is correct and rests on a reachability claim I independently confirmed via the crate dependency graph (`ql-collab` and `ql-bindings-node` do not depend on `ql-exec`, where the only table producers live) — a *stronger* proof than the session itself articulated. Op::Unknown amend-not-build is correct (re-verified against op.rs). Tables EC#2 DEFER+amend is consistent with the plan's own v1.5-collab classification and attaches a real binding obligation. The B#1 fix is real and tested. Coverage gaps in Lane A's partials are genuinely covered by other lanes + the IDE mocha binding-level suite, not papered over.

**No PROVEN wrong conclusion found.** The findings are claims-integrity issues, not correctness defects:
- **O5 (MED):** the "158+101" ql-collab test-count split is wrong — the lib count is **154** (total 255 pass / 0 fail is correct). This wrong figure is cited as exit evidence in 4 canonical docs and should be corrected.
- **O6 (MED):** EC#2's ✅ for *names + tables* overstates verification depth — they're tested only at the replay/WorkbookRuntime layer (not the collab `merge_bytes` path the product uses), and concurrent CreateTable/ResizeTable have no test at all. Not exit-blocking (no v1 producer), but the ✅ should be qualified per-layer.
- **O7/O8/O10 (LOW):** "all 4 criteria met" launders the EC#2 amendment slightly; risk-register force_clear citations drifted ~16 lines; "38/38 confirmed" includes 3 IDE-side closures whose TS Lane B did not re-verify.

Net: **Phase 5 COMPLETE is the right call.** The decisions are correct. Tighten the four claims-integrity items (especially the test-count split O5 and the names/tables layer caveat O6) before the exit packet is cited downstream.

### Coverage note
- A1 (verdict re-derivation): COMPLETE — re-derived reachability from Cargo deps + grep + reading op.rs; ran the test suites; confirmed B#1 fix.
- A2 (dispositions): COMPLETE — Op::Unknown re-verified against op.rs enum; tables-defer cross-checked against MASTER-PLAN §0 v1.5 classification.
- A3 (claims drift): COMPLETE — re-ran `cargo test -p ql-collab -p ql-oplog` (live counts 154+101=255 / 67); read the MASTER-PLAN Phase 5 section + exit packet + closures for overclaim; found the test-count split error + the EC#2 layer-depth overstatement.
- A4 (megaudit coverage gaps): COMPLETE — verified each Lane A partial (A5 delta, A6 .qbook, A7 NaN/Inf) against other-lane + IDE-mocha coverage; spot-checked the 38/38 risk walk (R-V3.6-19, R-V3.6-14) and found the IDE-side-3 caveat.
- NOT done (out of scope / not re-run by this lane): ql-storage 199 not re-run; full IDE mocha suite (1424) not re-run; Phase 6 decision-lock not deeply re-audited; Loro CRDT internal merge semantics taken as given (Lane B/C's domain).

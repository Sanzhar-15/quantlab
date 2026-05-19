# Opus audit — Phase 5.2 D-1 step 3 (FormatId enum + 241 cascade fixups) 2026-05-19

Auditor: Opus subagent (independent of the engineer who shipped `af803f1a3f2`).
HEAD audited: `af803f1a3f2` (Phase 5.2 D-1 step 3 — FormatId enum + cascading downstream fixups). Doc follow-up at `36d580aa723`.
Total: 95,564 tokens / 44 tool uses / 383s wall.

## HIGH (blocks step 4)

None.

## MEDIUM (should-fix this cycle)

**M1 — `FormatId::Builtin(n)` accepts `n > 163` without enforcement.** The enum has no type-level or constructor-level guard preventing `FormatId::Builtin(200)` (semantically a custom xlsx-numFmtId encoded as a built-in variant). Format.rs:462 and :515 actively construct `Builtin(200)` in tests. Consequences:
- `to_legacy_u32(Builtin(200))` returns `Some(200)`, then `legacy_from_u32(200)` returns `Custom(LEGACY_PEER, 36)`. **The "round-trip" is asymmetric**: the storage→u32→storage hop is NOT identity for `Builtin(n)` with n≥164. The `legacy_round_trip_through_helpers` test only validates u32→storage→u32 (the safe direction).
- Mitigations are environmental: production code never constructs `Builtin(n)` with n>163 (verified by grep); xlsx import / qbook loader / replay go through `legacy_from_u32` which routes 164+ to Custom. So this is contractual debt, not a live bug, but it can bite in step 4 when an in-memory FormatId crosses the wire boundary and serializes via `to_legacy_u32`.
- Fix this cycle by either: (a) adding a `debug_assert!(n <= FIRST_XLSX_BUILTIN_MAX)` in a `Builtin` constructor and switching test sites to `legacy_from_u32(200)`; or (b) documenting the invariant prominently and renaming the test value to ≤163. Recommend (a).

**M2 — `register_at` matrix case 4 (Builtin input → no advance) is untested.** Cases 1-3 are covered by `register_at_advances_local_counter_for_own_peer`, `register_at_other_peer_does_not_advance_local_counter`, and the test for `c < next_custom_counter` is implicit in the existing replay-determinism test. Case 4 (registering a `Builtin(N)` must not advance the counter) is verified only by code inspection. Add a one-line test before step 4. (Audit-prompt item 4.)

## LOW (polish — defer to step N)

**L1 — `set_local_peer` mid-life counter semantics not pinned by test or doc.** The implementation preserves a single global counter across `set_local_peer` calls (Question 5). This is the correct choice — `(peer, counter)` pairs remain globally unique even if the per-peer counter sequence has gaps — but the docstring on `set_local_peer` only says "Existing entries are NOT relabeled" and never addresses the counter. Step 4's `CollabSession::attach` will hit this. Add an explicit sentence to the docstring and a test pinning the gap behavior.

**L2 — Single `expect()` message uses "step-4" wording but actually guards a step-6 invariant in xlsx export.** The 3 xlsx-export expect()s (umya_export.rs:299, 350, 1004) say `"pre-step-6 xlsx export sees only legacy FormatId"`. Consistent. But qbook_format.rs:1120 and :1197 say `"pre-step-4 FormatId must be expressible as legacy u32"` — yet step 4 is the wire-Op-shape change, not the qbook envelope schema bump (step 5). The qbook envelope wording should say "pre-step-5". Cosmetic; defer to step 5.

**L3 — `from_u32_legacy` numerical alignment is implicit.** Both crates compute the boundary with different identifiers (`FIRST_CUSTOM_FORMAT_ID = 164` in storage; `FIRST_XLSX_BUILTIN_MAX + 1` in wire). They agree today (164) but no single source of truth links them. A `const _: () = assert!(...)` static check across crates isn't currently possible, but a doc-comment cross-reference exists in `FormatId::legacy_from_u32`. Acceptable but worth noting in step-8 megaudit.

**L4 — No test pins the `FormatId::Builtin(0) != FormatId::Custom(LEGACY_PEER, 0)` Eq/Hash distinction.** This is guaranteed by `derive(Hash, Eq)` on the enum variant tag, but a single-line `assert_ne!` test would document the invariant for future readers. (Audit-prompt item 8.)

## PASS items

- Q1: round-trip test passes; 4 boundary values (0, 163, 164, 999) and 8 across-the-board values all check. (Forward direction; see M1 for reverse.)
- Q3: boundary alignment storage↔wire is exact (`164` both sides; storage subtracts `FIRST_CUSTOM_FORMAT_ID`, wire subtracts `FIRST_XLSX_BUILTIN_MAX + 1`; both = 164).
- Q4 cases 1-3: covered by tests; case 4 covered by code-path inspection (see M2).
- Q5: single-counter semantics is correct; (peer, counter) pairs remain globally unique. (See L1 for missing test.)
- Q6: 5 `to_legacy_u32().expect()` sites enumerated (1 in intern_format, 1 in set_cell_format, 2 in qbook_format save, 3 in umya_export — sort, custom_formats, cellxfs roster). All 5 safe at step 3: no production caller invokes `FormatTable::with_peer(non_LEGACY)` or `set_local_peer(non_LEGACY)`. Confirmed by `rg`: only `crates/ql-storage/src/format.rs` test module exercises non-LEGACY peers, and those tests don't reach the expect() paths.
- Q7: cascade callsite completeness. `rg "FormatId\("` finds only `FormatId::Builtin/Custom/legacy_from_u32/GENERAL` patterns + doc-comment references to the pre-step-3 shape. `rg "\.0[^...]" | rg format` finds only `.0` accesses on `(u32, u32)` tuples (row/col) and doc-comment references. **Zero leftover tuple-struct constructions or `.0` field accesses on FormatId.**
- Q8: Eq + Hash derive for enum guarantees `Builtin(0) != Custom(_, 0)` even at the same payload. Live behavior depends on Eq (not just Hash); HashMap is safe. (See L4 for missing test.)
- Q9: Default semantics preserved. Pre-step-3 `derive(Default)` on `pub struct FormatId(pub u32)` yielded `FormatId(0) = GENERAL`. Post-step-3 hand-impl returns `Builtin(0) = GENERAL`. Identical.
- Q10: `FormatId::GENERAL = Builtin(0)`; BUILTIN_FORMATS populates `(0, "General")` via `FormatId::Builtin(0)` (line 233). Type assertion holds; test `general_is_builtin_zero` pins it.
- Q11: producer-replay determinism preserved. Both `apply_producer_side` (line 196) and replay handler (line 513) go through `FormatId::legacy_from_u32`. Identical conversion. The post-step-3 equivalence comparator (line 324) collects HashMap<FormatId, String> directly — no u32 hop. Determinism intact.
- Q12: `Op::RegisterFormat { id: u32 }` and `Op::SetCellFormat { id: Option<u32> }` are still bare u32 in this commit; step 3 correctly does not preempt step 4.
- Q13: forward-readiness for step 4. The 5 `to_legacy_u32().expect()` sites in intern_format and set_cell_format will become mechanical drop-ins (`Op::RegisterFormat { id: fid.to_wire() }`). The 5 sites in qbook_format and umya_export are NOT touched by step 4 (they're step 5 and step 6 respectively). Replay's `legacy_from_u32` hop at replay.rs:513 and :536 disappears in step 4 (Op carries FormatIdWire directly; convert via FormatId::from_wire). **No gnarly sites.** `producer_replay_equivalence`'s `apply_producer_side` will need a corresponding update — slightly load-bearing but mechanical.
- Q14: searched for known-gaps documents; no existing gap is invalidated. GAP-F-12 (format_cache staleness, documented on `read_display`) is independent of step 3.
- Q15: module docstring claims verified — `FormatId::Builtin(u32)` / `Custom(PeerId, u32)` shape matches; `local_peer` field matches; `legacy_from_u32` mirrors `FormatIdWire::from_u32_legacy` matches; cross-refs to docs accurate. Minor: line 4 says "Custom variant" — accurate.
- Workspace gates: **4244 tests pass**, fmt clean, clippy clean — independently verified via mac bridge.

## Overall verdict

**PASS** — proceed-with-noted-followups.

Step 3 is foundational and lands cleanly. The 241-callsite cascade is mechanically sound (no leftover `.0` accesses, no leftover tuple-struct constructions in live code), the producer/replay determinism path is preserved, all 5 `expect()` invariants are safe at this step (verified by grep that no caller uses non-LEGACY peers), the storage/wire boundary alignment is exact, and the gates report matches workspace truth.

The two MEDIUMs (M1, M2) are type-contract gaps rather than live bugs and are cheap to close before step 4. The four LOWs are polish that can ride along with steps 4-6. Nothing blocks step 4.

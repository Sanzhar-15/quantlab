# Opus audit — Phase 5.2 D-1 step 4 (Op wire + by_string restructure) 2026-05-20

Auditor: Opus subagent (independent of the engineer who shipped `6a4b8b0922f`).
HEAD audited: `6a4b8b0922f`.
Total: 148,416 tokens / 56 tool uses / 366s wall.

## HIGH (blocks step 5)

None. Step 4 ships clean structurally.

## MEDIUM (should-fix this cycle)

**M1 — Commit message and d-1 checklist do not call out the oplog.bin wire-format break.** The commit message lists deliverables but never says "any pre-step-4 `oplog.bin` saved by an earlier build will fail to deserialize post-step-4 until step 7 ships the magic-byte / schema-version envelope." Mitigation: (a) confirmed no `.bin` fixture files exist anywhere outside `target/` and `.references/`; (b) Loro snapshot reload of a pre-step-4 export would fail at the `serde_json::from_str::<Op>` boundary with a useful `OpLogError::Deserialize` (visible error, no silent corruption). So no production data is at risk yet; this is a documentation/scoping nit, but worth one line in step 7's commit message.

## LOW (polish — defer to step 5/6/8)

**L1 — No direct unit test for `FormatIdWire::from_storage` / `to_storage` round-trip.** All 4 boundary points (Builtin(0), Builtin(163), Custom(LEGACY_PEER, 0), Custom(non-LEGACY, _)) are exercised transitively through producer/replay equivalence tests, but a dedicated round-trip test would document the lossless-projection contract explicitly.

**L2 — `intern` allocates a `String` per lookup.** The hashmap key is `(PeerId, String)`, so `self.by_custom_string.get(&(self.local_peer, s.to_string()))` heap-allocates on every call. Pre-step-4 used `get(s: &str)` directly. For hot paths (import loops calling `intern` for thousands of cells), this is a measurable regression. Mitigation: use `raw_entry_mut` or `Borrow`-based lookup. Defer to step 8 if profiling surfaces it.

**L3 — Step-4 LibreOffice path bloats FormatTable on real-world xlsx.** Any xlsx file declaring redundant `<numFmt numFmtId="164" formatCode="0.00"/>` (custom declaration of a string already in built-ins) now creates a Custom entry plus the Builtin entry. Pre-step-4 was silent-skip. Same user-visible behavior, more memory + serialized bytes. Track as future xlsx-export concern.

**L4 — Step-2 Opus L4 (`debug_assert_ne!(peer, 0)`) discharged at `CollabSession::new` but not at `OpLog::set_peer_id`.** The step-2 LOW item said "belongs in the OpLog API." Step 4 added the guard at the higher-level CollabSession::new, which catches most call sites, but `OpLog::set_peer_id` is `pub` and could be called directly without going through CollabSession. Either reaffirm the placement choice or add the same guard at the lower-level API.

**L5 — `register_at_string_collision_errors_same_variant_namespace` no longer covers the Builtin-vs-Builtin same-string-different-id case.** The pre-step-4 test asserted that registering "General" at a non-zero Builtin-or-equivalent id errors. The renamed test covers same-peer Custom-vs-Custom only. Builtin-vs-Builtin collision still triggers StringCollision in the new code path, but isn't directly tested.

## PASS items

- **Op shape change confirmed correct.** `Op::RegisterFormat { id: FormatIdWire, string }` + `Op::SetCellFormat { id: Option<FormatIdWire>, .. }` in op.rs:118-148. `ReplayError::FormatNotRegistered { id: ql_storage::FormatId, .. }` in replay.rs:127.
- **FormatIdWire ↔ FormatId conversions are lossless and symmetric.** `from_storage` (wire.rs:330) and `to_storage` (wire.rs:341) are direct match-arm projections.
- **`by_string` restructure correct.** All 5 enumerated semantic cases hold and are tested. `cargo test -p ql-storage --lib format::tests` = **28 passing** including all new step-4 tests.
- **Producer/replay symmetry holds.** `ql-exec::intern_format` + `set_cell_format` emit `FormatIdWire::from_storage(id)`. `ql-oplog::replay::apply_op` for both Op variants converts via `wire_id.to_storage()`. `ql-oplog::tests::producer_replay_equivalence::apply_producer_side` also uses `id.to_storage()`. All three boundaries match.
- **No remaining `.expect()` in oplog producer/replay paths.** Workspace grep for `to_legacy_u32` shows only `qbook_format.rs` (step 5 work), `umya_export.rs` (step 6 work), test assertions. Zero `.expect()` chains remain in producer/replay code.
- **`debug_assert_ne!(peer_id.as_u64(), 0)` in `CollabSession::new`.** Confirmed at session.rs:171-175. Verified: no ql-collab test constructs `CollabSession::new(PeerId::new(0))`. `cargo test -p ql-collab --lib` = **64 passing**.
- **xlsx LibreOffice path correctness.** `register_custom_formats` silent-skip path still reachable for same-namespace collisions. The General-at-164 test correctly asserts `n == 1` and both Builtin(0) + Custom(LEGACY_PEER, 0) resolve to "General".
- **Cargo dep direction holds.** ql-storage deps: arrow-array, arrow-schema, ql-types, thiserror. NO ql-oplog. ql-oplog deps include ql-storage — correct one-way arrow. Tier D2 architectural lock intact.
- **Workspace truncation check.** All 9 files: HEAD blob line count == disk line count.
- **Forward-readiness for step 5.** Op serializes via serde_json::to_string in log.rs:94, deserializes via serde_json::from_str in log.rs:129. FormatIdWire's tagged serde shape is verified by round_trips_worst_case_through_serde_json. The end-to-end binary export → replay test passes with the new wire shape.
- **JSON shape verified.** `Op::RegisterFormat { id: FormatIdWire::Builtin { id: 14 }, string: "m/d/yyyy" }` serializes as `{"RegisterFormat":{"id":{"kind":"builtin","id":14},"string":"m/d/yyyy"}}`. `deny_unknown_fields` rejects schema drift.
- **All workspace gates green.** `cargo test --workspace` = **4251 passed, 0 failed**. fmt clean. clippy clean.
- **No .bin fixtures at risk.** Workspace search for `*.bin` outside `target/` and `.references/` returns zero hits.
- **No leftover `Op::RegisterFormat { id: <u32_literal>, .. }` constructors.** Workspace grep confirms the sweep was complete across all 9 touched files.

## Overall verdict

**PASS — proceed to step 5.**

Step 4 is structurally clean: Op wire format shift + `by_string` restructure + producer/replay symmetry + xlsx LibreOffice path update + Opus step-2 L4 partial closure, all landing together with 4251 passing tests, fmt+clippy clean, dep-direction intact, no truncation, no fixture breakage. The two HIGH items the step-3 audit caught (Codex HIGH-1 set_local_peer counter resync + Codex HIGH-2 cross-peer string collision) are now closed by code AND tests that invert the step-3 KNOWN LIMITATION pin to assert success.

M1 is a docs-polish item for step 7's commit, not a code bug. L1-L5 are deferred-to-step-8 polish, none of which would surface in step 5's qbook envelope migration work. Step 4 is the structural pivot the rest of D-1 builds on; the foundation it lays is correct.

Step 5 (qbook envelope schema bump + legacy loader) can build on `FormatIdWire::from_u32_legacy` (step 2 helper) + the lossless `from_storage`/`to_storage` boundary + the now-peer-scoped `FormatTable::register_at` (which won't false-positive collide on legacy-loaded `Custom(LEGACY_PEER, _)` ids).

# Opus audit — Phase 5.2 D-1 step 2 (FormatIdWire) 2026-05-19

Auditor: Opus subagent (independent of the engineer who shipped `135bbb99f75`).
HEAD audited: `135bbb99f75` (Phase 5.2 D-1 step 2 — introduce FormatIdWire).
Predecessor: `11765c5c48e` (step 1 audit transcripts) → `1e383dc9eeb` (step 1.1).
Total: 77,112 tokens / 27 tool uses / 223s wall.

## HIGH (blocks step 3)

None.

## MEDIUM (should-fix this cycle)

**M1 — `#[serde(deny_unknown_fields)]` missing on `FormatIdWire`.** Verified empirically: `{"kind":"builtin","id":14,"extra":1}` deserializes silently to `Builtin { id: 14 }`. `qbook_format.rs:561, 571` already uses `#[serde(deny_unknown_fields)]` on `FormatEntry` / `FormatOverlayEntry` for exactly this protection. `NamedTargetWire` (wire.rs:137-139) lacks it too — likely a pre-existing gap rather than a step-2-introduced regression — but `FormatIdWire` going on the wire in step 4 makes the gap newly load-bearing. Either add `#[serde(deny_unknown_fields)]` on `FormatIdWire` now, or document the decision (alongside `NamedTargetWire`) that wire types accept extra fields for forward-compat. Per the global "No Fallbacks" rule, silent acceptance of unknown fields is the kind of soft failure that masks producer bugs.

**M2 — Test name `round_trips_through_loro_value_bincode` is misleading.** wire.rs:471. The test uses `serde_json::to_string` / `serde_json::from_str` (verified at log.rs:94, 129 — ops serialize via JSON, not bincode, and not `LoroValue` natively). The test body is correct (worst-case u64-near-MAX + u32::MAX); only the name implies a serialization path that doesn't exist. Rename to e.g. `round_trips_worst_case_through_serde_json`.

## LOW (polish)

**L1 — `FIRST_XLSX_BUILTIN_MAX` not `pub`.** wire.rs:295 keeps the const file-private. Step 5 (qbook envelope loader) and step 6 (xlsx export at `umya_export.rs`) both will want a shared boundary value. Two options: (a) export `pub const FIRST_XLSX_BUILTIN_MAX` (or `FIRST_XLSX_CUSTOM_NUMFMT = 164`) from `ql_oplog::wire`, OR (b) defer — duplicate the const in step 5/6 callers and audit then. Either works; (a) is mildly cleaner because the d-1-checklist already names `FIRST_XLSX_CUSTOM_NUMFMT` as a shared concept. Not blocking step 3 (step 3 has no use for this constant).

**L2 — No `is_builtin` / `is_custom` / `peer` / `counter` accessors.** Step 3's storage `FormatId` will mirror this shape, and the many `id.0 >= FIRST_CUSTOM_FORMAT_ID` discriminators (qbook_format.rs:1179; ql-io-xlsx tests at 68, 115, 49, 169, 229, 400, 766, 264, 769, 887 — 10+ sites) become `is_custom()` calls at step 3. Adding `is_builtin` / `is_custom` here in step 2 would be premature (the storage type owns those once it mirrors the shape); deferring to step 3 is fine. Document either way.

**L3 — No `#[non_exhaustive]` on `FormatIdWire`.** wire.rs:281. Comparison: `WireDecodeError` (wire.rs:45) has it; `CellWireValue` + `NamedTargetWire` don't. Since `FormatIdWire` is a wire format under an already-bumped schema (Phase 5.2 D-1), and the no-fallbacks rule says future variants should produce a `WireDecodeError::UnknownFormatIdKind` rather than silently dispatching, `#[non_exhaustive]` would document the open-set intent. Low priority; deferring is fine.

**L4 — `LEGACY_PEER` rationale doc-only.** `LEGACY_PEER = PeerId(0)` collision-freedom guarantee depends on `peer_id != 0` being enforced for active peers (peer.rs:99-105 documents this; Phase 5.2.b is named as the enforcement spot). Step 2 does not add a runtime assertion. Step 4 / step 5 should add a `debug_assert_ne!(peer_id.as_u64(), 0)` at `OpLog::set_peer_id` if not already present, to make the legacy-collision invariant tooled. Not a step-2 issue.

## PASS items

- Serde JSON shapes match the spec exactly: `{"kind":"builtin","id":14}` and `{"kind":"custom","peer":42,"counter":7}` (verified via `cargo test -p ql-oplog format_id_wire`). PeerId's `#[serde(transparent)]` (peer.rs:54) correctly produces the bare u64.
- `from_u32_legacy` boundary `FIRST_XLSX_BUILTIN_MAX = 163` (wire.rs:295) + `+1 = 164` matches `ql_storage::FIRST_CUSTOM_FORMAT_ID = 164` (format.rs:29) exactly. Round-trips through both directions: pre-5.2 save of `id=164` → `Custom { peer: LEGACY_PEER, counter: 0 }`.
- No pre-5.2 reserved sentinel ids exist that need rejection — `FormatId(0)` = General is a legitimate builtin; all other `0..=163` are Excel canonical or sparse-unregistered. No special-case needed in `from_u32_legacy`.
- Collision-freedom guarantee at wire level: `distinct_peers_with_same_counter_dont_collide` (wire.rs:447) pins the contract; equality + Hash derive correctness verified.
- No arithmetic on `Op::RegisterFormat.id: u32` or `Op::SetCellFormat.id: Option<u32>` in replay (replay.rs:497-540) or producer (formats.rs:41-114) — only `==` / `lookup` lookups + `>= FIRST_CUSTOM_FORMAT_ID` filter at save (qbook_format.rs:1179). Step 4 swap is a clean signature change at these sites; step 5 reads the filter through `from_u32_legacy`.
- Negative serde cases empirically verified clean: unknown `kind`, bare `u32`, missing required field all error. Producer corruption fails loudly, satisfying the no-fallbacks rule.
- Re-export at `ql_oplog::FormatIdWire` (lib.rs:48) is wired correctly.
- d-1-checklist entry (§ Step 2, line 103) accurately reflects what shipped: 9 tests, boundaries (0/163/164/large), equality + hash, distinct-peer, LEGACY_PEER usage, re-export.
- fmt + clippy + 4233 workspace tests + 9 new format_id_wire tests all clean (verified via mac bridge).
- Step 3 readiness: existing `FormatTable::register_at` (format.rs:129) + `intern` (format.rs:112) + `next_custom_id` (format.rs:171) are already strict (no panics, explicit collision errors); mirror to tagged-tuple shape is mechanical. `FormatTable` likely needs a `local_peer: PeerId` field for the allocator (checklist line 115 anticipates this).

## Overall verdict

**PASS — proceed-with-noted-followups.**

The wire type ships correctly, the serde shape is exactly what the spec promises, the `from_u32_legacy` boundary aligns with the existing `FIRST_CUSTOM_FORMAT_ID = 164`, collision-freedom holds at the type level, and 4233 tests + the 9 new ones are clean. Step 3 can proceed.

The M1 `deny_unknown_fields` gap is worth fixing this cycle (single-line annotation) because step 4 puts `FormatIdWire` on the wire and silent acceptance of extra fields is exactly the soft failure the global no-fallbacks rule forbids. M2 (test name) is a one-line cosmetic fix. L1-L4 are deferrable to step 3 / step 4 / step 5 closures as their consumers materialize.

Key file refs: `crates/ql-oplog/src/wire.rs:281-329` (FormatIdWire + from_u32_legacy), `:362-487` (tests), `crates/ql-storage/src/format.rs:20,29,112,129` (mirror target), `crates/ql-types/src/peer.rs:54,108` (PeerId serde + LEGACY_PEER), `crates/ql-oplog/src/op.rs:121,128-135` (step-4 targets), `crates/ql-io/src/qbook_format.rs:561,571,1179` (step-5 site + existing deny_unknown_fields precedent).

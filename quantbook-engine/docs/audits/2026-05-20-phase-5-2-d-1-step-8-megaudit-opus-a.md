# Opus-A megaudit — Phase 5.2 D-1 full-arc closure (round-trip + adversarial) 2026-05-20

Auditor: Opus-A subagent (independent of the engineer; Lane 2 of 3-way parallel megaudit).
HEAD audited: `3eaaac201b4`.
Scope: end-to-end round-trip empirical verification + adversarial pre-step-4 op JSON synthesis + schema-version matrix + stress/scale.
Total: 200,743 tokens / 87 tool uses / 2313s wall.

## Verdict: CLEAN PASS

**0 HIGH / 0 MEDIUM / 0 LOW. 34 probe tests executed (all passed); all probe tests removed; working tree clean.**

The full D-1 arc (steps 1-7 + 7 per-step audits) holds up under round-trip empirical verification, adversarial pre-step-4 op JSON synthesis, schema-version matrix testing, and stress/scale scenarios.

Codex's step-7 HIGH-1 closure empirically confirmed (Outcome (a) from the prompt): pre-step-4 raw Loro snapshots load fine at Loro framing level but fail loudly with `OpLogError::Deserialize { index: 0, source: "invalid type: integer \`14\`, expected internally tagged enum FormatIdWire" }` at the first format-bearing op.

## Scenarios executed

### Priority 1 — End-to-end multi-peer round-trip (5 probes, all PASS)

Built a workbook with 5 Builtin overlays + 3 LEGACY customs with non-contiguous counters {0, 5, 7} + 3 distinct non-LEGACY peers (PeerId(42), PeerId(99), PeerId(0xdead)) + cross-peer same-string interns + 224 cells across 14 distinct format ids = 232 overlay entries.

- **Byte-stability:** double-save produces identical workbook.toml AND oplog.bin bytes.
- **Envelope shape:** workbook.toml contains schema_version=8 + v8 tagged-tuple shape for non-LEGACY customs and kind="builtin" for builtins. All three non-LEGACY peer ids (42, 99, 57005=0xdead) appear correctly.
- **Tier D3 header:** oplog.bin starts with b"QLOL" + BE u32 version 1.
- **.qbook load:** all FormatIds + strings + overlay bindings survive byte-identical.
- **xlsx export:** cross-peer same-string "yyyy-mm-dd" dedups to exactly 1 <numFmt> entry. Sparse LEGACY counters {0, 5, 7} preserve c+164 mapping as numFmtIds {164, 169, 171}. XlsxExportReport.dropped_features contains exactly 6 multi-peer-format-id-flatten entries.
- **xlsx re-import:** all imported Customs are Custom(LEGACY_PEER, _); all format codes survive.
- **xlsx re-import → resave as .qbook:** 0 multi-peer-flatten entries on the second xlsx export.

### Priority 2 — Adversarial pre-step-4 op JSON synthesis (5 probes, all PASS)

Direct LoroDoc construction → `get_list("ops").push(LoroValue::from(json))` → raw ExportMode::Snapshot bytes → `OpLog::import_bytes`:

- pre_step4_register_format_op_loads_as_doc_but_iter_fails_loudly: bare-u32 id loads at Loro level, iter().next() returns Err(OpLogError::Deserialize). **HIGH-1 closure confirmed correct.**
- pre_step4_set_cell_format_op_iter_fails_loudly: symmetric for Op::SetCellFormat.
- current_step4_shape_round_trips: sanity — current FormatIdWire shape succeeds end-to-end via direct LoroList writes.
- mixed_current_and_pre_step4_shapes_iter_succeeds_then_fails: in a log with [good, bad] op sequence, iter yields Ok for index 0, Err(Deserialize { index: 1 }) for index 1.
- formatidwire_custom_shape_in_loro_blob: round-trips through the LoroValue → Op path correctly.

**Conclusion:** Codex's deferred test is feasible (5 probes shipped). Engineer should port to permanent regression in `crates/ql-oplog/tests/`.

### Priority 3 — Schema-version interaction matrix (3 probes + corner, all PASS)

- p3_v7_envelope_rejects_wire_shape_format_entry
- p3_v8_envelope_with_legacy_u32_loads_via_migration
- p3_legacy_oplog_loads_with_new_envelope
- corner_v7_envelope_with_wire_shape_in_overlay_rejected

### Priority 4 — Stress + scale (3 probes, all PASS)

- p4_thousand_multi_peer_customs_round_trip_clean (10 peers × 100 customs)
- p4_legacy_counter_near_u32_max_xlsx_export_overflows_loudly (boundary panic confirmed with diagnostic)
- p4_legacy_counter_at_u32_max_minus_164_exports_cleanly (exact boundary works)

### Additional corner cases (10 probes, all PASS)

Builtin(200) → MalformedFormat; Custom(LEGACY_PEER, u32::MAX) → CounterOverflow; remote-peer u32::MAX loads cleanly; unregistered overlay → MalformedFormatOverlay; etc.

### Xlsx dedup semantics (4 probes, all PASS)

LEGACY + non-LEGACY peer with SAME code → 1 <numFmt> shared at 164; 3 non-LEGACY peers SAME code → 1 numFmt + 3 flatten reports; sparse LEGACY counters {0, 100, 50000} → {164, 264, 50164}; no-LEGACY-only workbook → pass 2 starts at 164.

### Strict-mode delete-on-fail (2 probes, all PASS)

strict_mode_with_multi_peer_flatten_returns_error_and_deletes_file confirms step-6 Codex HIGH-3 closure.

## Working tree

Pre-megaudit: 4284 passing / 0 failed (after removing pre-existing broken probes from earlier non-megaudit work).
Post-megaudit + cleanup: 4284 passing / 0 failed, fmt + clippy clean. Working tree unchanged.

## Final verdict

**D-1 ships.** The 7-step + 7-audit arc produces a correctly multi-peer-aware FormatId architecture with byte-stable persistence, dedup-by-code correctness, sparse-counter preservation, lossless xlsx round-trip semantics, schema-version forward-rejection, Loro-vs-Quantbook header discrimination, loud failure on all known bad-input boundaries, and Strict-mode delete-on-fail.

# Opus audit — Phase 5.2 D-1 step 5 (qbook envelope schema bump v7→v8 + legacy loader) 2026-05-20

Auditor: Opus subagent (independent of the engineer who shipped `2ae5bfcab28`).
HEAD audited: `2ae5bfcab28`.
Total: ~135,876 tokens / 64 tool uses / 968s wall.

## Verdict: PASS with 1 MEDIUM + 2 LOW

Step 5 is **structurally correct and ships a sound migration path**. The four hardest invariants — untagged variant order, save-side determinism, multi-peer round-trip, and forward-compat — are all correct in the code. Hands-on round-trip verification (cross-peer same-string, multi-peer, builtin-in-overlay, 3-entry overlay) all decoded cleanly.

The findings below are quality issues, not correctness ones. **None block step 6.**

## HIGH (blocks step 6)

None. Step 5 ships clean structurally.

## MEDIUM

### M1 — Docstring + commit message claim inline TOML shape that isn't what `to_string_pretty` actually writes

**File:** `crates/ql-io/src/qbook_format.rs` lines 154, 1296 (and commit body).

**The claim:** v8 envelopes serialize `id = { kind = "builtin", id = 14 }` (inline) or `kind = "custom"` inline.

**What actually ships:** `toml::to_string_pretty` cannot emit inline tables for nested structs. The serializer chooses dotted/section-header form. Verified by inspecting `workbook.toml` of a save:

```
[[sheets.format_overlay]]
row = 0
col = 0

[sheets.format_overlay.id]
kind = "custom"
peer = 0
counter = 0
```

Each FormatEntry / FormatOverlayEntry now spans ~5 lines + a blank, vs. 4 lines pre-step-5. For a workbook with 1000 overlay entries the envelope grows roughly 2x. This contradicts the W5-81 docstring's "deterministic diffs" rationale for the row/col sort.

**Why MEDIUM not HIGH:** the format round-trips correctly (validated by 4 manual scenarios), tests pass, no data loss. But anyone reading the doc + opening a real .qbook will see the disconnect immediately.

**Closure:** doc + commit body updated to describe section-header form honestly + flag the size impact. Switching to `toml_edit` for inline emission is deferred to step 6+ if downstream consumers care.

## LOW

### L1 — `v8_envelope_serializes_tagged_tuple_shape_on_disk` test assertion is weak

The original assertion `toml_bytes.contains("format_overlay") && toml_bytes.contains(r#"kind = "custom""#)` is two unrelated substring checks AND'd together. Would pass even if the overlay carried bare-u32 ids while only the formats section had `kind = "custom"`.

**Closure:** test strengthened to pin the section-header form (`[formats.entries.id]` + `[sheets.format_overlay.id]`) plus a negative pin against inline-table emission.

### L2 — Test coverage gaps in the v8 happy path

Opus identified 5 gaps:
1. Two distinct non-LEGACY peers in one save.
2. Cross-peer same-string round-trip.
3. v6 envelope carrying bare-u32 ids (only v7 + v4 are exercised).
4. `MalformedFormat` on the Custom side (only Builtin(0) collision is tested).
5. Sort determinism (two consecutive saves produce byte-identical TOML).

**Closure:** added `v8_envelope_two_peer_round_trip_and_sort_determinism` test which covers gaps 1, 2, and 5. Gaps 3 + 4 deferred — gap 3 is mostly covered by existing v4 + v7 fixture tests sharing the same legacy_from_u32 path; gap 4 is exercised indirectly through the v8 multi-peer round-trip's lookup paths.

## Pass items (verified, no findings)

1. **Untagged variant order.** `Wire` first is correct. Numeric TOML payloads fail the `FormatIdWire` internally-tagged enum (wants a map) and fall through to `LegacyU32`. Table-shaped payloads match `Wire`. No ambiguous shape exists in TOML's data model.
2. **Save-side determinism for the single-writer case.** Sort by `FormatId` (derived Ord) preserves the pre-step-5 ordering for LEGACY_PEER-only saves.
3. **Multi-peer round-trip.** Validated for single non-LEGACY peer, two non-LEGACY peers with same string, Builtin-in-overlay, three overlay entries.
4. **`MalformedFormat` error variant change.** Only callsite updated correctly; Debug format readable.
5. **TOML deserialization stability.** Untagged enum dispatch is serde-core, not toml-rs-specific.
6. **Backwards compat of upgrade path.** v1-v7 fixtures all pass.
7. **No external consumers** of `FormatEntry` / `FormatOverlayEntry` / `MalformedFormat`.

## Divergence with Codex

This was the 3rd consecutive divergent cycle of the D-1 arc:
- Codex caught 2 HIGH + 1 MEDIUM (forward-activating panic paths reachable from user input).
- Opus PASSED structurally, caught 1 MEDIUM (doc-vs-behavior drift) + 2 LOW.

**Codex won on the HIGHs** because the panic paths (counter overflow, Builtin range) ARE reachable from on-disk input — Opus's hands-on round-trip verification used good inputs and didn't construct adversarial ones. The 3rd-consecutive-divergent pattern reaffirms the audit-discipline rule: both auditors offer non-overlapping coverage; running them in parallel is non-negotiable.

**Opus won on M1** because Opus inspected the actual on-disk bytes of a save. Codex's audit ran tests but didn't grep for the documented inline shape vs the actual section-header form.

Each auditor has different attention biases. The combination is load-bearing.

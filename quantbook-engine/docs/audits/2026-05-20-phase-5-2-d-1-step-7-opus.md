# Opus audit — Phase 5.2 D-1 step 7 (Tier D3 oplog.bin magic bytes + version header) 2026-05-20

Auditor: Opus subagent (independent of the engineer who shipped `0ccc859958f`).
HEAD audited: `0ccc859958f`.
Total: 103,030 tokens / 42 tool uses / 605s wall.

## Verdict: PASS with 3 MEDIUM + 2 LOW (no HIGH)

Empirically verified the most-likely-to-bite concern (MAGIC collision): Loro 1.12.0 uses lowercase `b"loro"` as snapshot magic. Uppercase `b"QLOL"` has fully disjoint byte set. Probes confirmed every Loro snapshot starts with `6c 6f 72 6f 00 00 00 00`.

## HIGH (blocks step 8)

None.

## MEDIUM

### M1 — Stale oplog.bin docstrings outside the touched file

Four docstring sites describe `oplog.bin` as "raw Loro snapshot" or "the same Loro snapshot blob" — post-Tier-D3 that's only true for the BODY (after header strip), not the file as a whole. Sites:
- `crates/ql-collab/src/session.rs:248-252` — CollabSession::export_bytes
- `crates/ql-collab/src/session.rs:596` — sweep_presence docstring
- `crates/ql-collab/src/presence.rs:19` — presence module doc
- `crates/ql-oplog/src/log.rs:18-22` — log module persistence comment

Also `docs/architecture/crdt-data-model.md:437` — `.qbook/oplog.bin` "remains the same Loro snapshot blob."

**Why MEDIUM:** the file-vs-transport contract boundary is real but undocumented. Future engineer wiring transport bytes straight to disk creates an unheadered file (still works via legacy branch — silently bypassing the version gate).

### M2 — Version 0 silently accepted (no MIN_SUPPORTED gate)

Loader checks `version > OPLOG_SCHEMA_VERSION` but not `version < MIN`. Version 0 passes the gate. Asymmetric with `qbook_format`'s `MIN_SUPPORTED_SCHEMA_VERSION` pattern.

### M3 — Module docstring overstates migration story

Module-level comment claims "future v2 reader can detect a v2 oplog.bin and apply a migration." Actual code only rejects unknown versions; per-version dispatch infrastructure doesn't exist. Constant-level docstring is more honest.

## LOW

- L1 — Constants not re-exported at `ql_io::*`. `OPLOG_FILENAME` is re-exported but `OPLOG_MAGIC` / `OPLOG_SCHEMA_VERSION` / `OPLOG_HEADER_LEN` only appear at `ql_io::oplog_persistence::*`. Minor consistency win.
- L2 — `bytes[..OPLOG_MAGIC.len()] == OPLOG_MAGIC` vs idiomatic `bytes.starts_with(&OPLOG_MAGIC)`. Cosmetic.

## Pass items (verified, no findings)

- MAGIC collision risk: PASS (Loro magic is lowercase `b"loro"`).
- Empty-file boundary: PASS (`OpLog::import_bytes(b"")` returns DecodeError).
- 4-byte boundary: PASS (returns OplogTruncatedHeader{found_bytes:4, required:8}).
- Recovery interaction: PASS (recovery code is directory-level; doesn't parse oplog.bin).
- Endianness symmetric: PASS (`to_be_bytes`/`from_be_bytes` match).
- Docstring byte layout accurate: PASS.
- 5 new tests all pass.
- Helper extraction (decode_oplog_bytes) cleanly centralizes format detection.
- No checked-in oplog.bin fixtures (no backward-compat fixtures to worry about).
- Large oplog round-trip: PASS (verified with 100-op probe).

## Divergence with Codex

Codex unique HIGH-1 (legacy compat incomplete for pre-step-4 op shapes) — Opus PASS on this area, didn't construct adversarial pre-step-4 op JSON.

Opus unique MEDIUM-3 (migration-story-overstated module docstring) — Codex didn't flag.

Convergent:
- Codex MEDIUM-2 ↔ Opus MEDIUM-1 (doc drift across collab + oplog).
- Codex LOW-1 ↔ Opus MEDIUM-2 (version 0 acceptance, severity disagreement).

**5th consecutive divergent-HIGH cycle.** Codex's tactical adversarial framing surfaces the per-op-deserialize edge case; Opus's holistic analysis surfaces the doc-vs-code drift + missing MIN_SUPPORTED symmetry.

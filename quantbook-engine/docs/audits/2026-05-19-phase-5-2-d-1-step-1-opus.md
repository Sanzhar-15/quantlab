# Opus audit — Phase 5.2 D-1 step 1 (move PeerId to ql-oplog) 2026-05-19

Auditor: Opus subagent (independent of the engineer who shipped `aaa54d32f4d`).
HEAD audited: `aaa54d32f4d` (Phase 5.2 D-1 step 1 — move PeerId to ql-oplog layer).
Predecessor: `6eba27a374d` (handoff completeness audit closure).
Total: 67,108 tokens / 26 tool uses / 109s wall.

## HIGH (blocks step 2)

None.

## MEDIUM (should-fix this cycle)

None.

## LOW (polish)

**L1 — Doc-link to `PeerId::Display` won't resolve in rustdoc.** `crates/ql-oplog/src/log.rs:202` writes `` [`PeerId::Display`](crate::PeerId) ``. The URL `crate::PeerId` is correct, but the label `PeerId::Display` references a trait impl (`impl std::fmt::Display for PeerId`), not an associated item on `PeerId`. Rustdoc won't resolve it as a hyperlink to the Display impl — the underlined text just points at `crate::PeerId` (the type page). The pre-move text "`ql_collab::PeerId::Display`" had the same flaw, so this is not a regression — just an opportunity to fix. Cleaner: `` 16-hex form of [`crate::PeerId`]'s `Display` impl `` or `` 16-hex form of [`PeerId`](crate::PeerId) ``.

**L2 — `ql-oplog/src/peer.rs:13` `[`crate::OpLog::set_peer_id`]` intra-doc link.** Worth confirming this resolves; `OpLog` is re-exported at the crate root via `pub use log::{OpLog, ...}`. Intra-doc supports re-exports, so this should resolve, but a `cargo doc --no-deps -p ql-oplog` would confirm. Defer-noted only.

**L3 — `ql-oplog/src/peer.rs:1` module-level doc title still reads "Per-peer identifier for Phase 5 collaboration."** The type is no longer scoped to "collaboration" — it now sits in the op-log layer to back `FormatId::Custom(PeerId, _)` too. Mild docstring drift. Optional touch.

## PASS items

- **Dep direction held.** `crates/ql-oplog/Cargo.toml` has no `ql-collab` dep; `cargo tree -p ql-oplog` shows only `loro/serde/serde_json/thiserror/ql-types/ql-storage/ql-functions` — no `collab` substring. Tier D2 floor preserved.
- **No external callers use `ql_collab::peer::PeerId`.** Workspace-wide grep yields zero non-comment hits for `ql_collab::peer`. The two surviving comment references in `ql-collab/src/lib.rs:13,63` are historical changelog text inside docstrings, which is correct.
- **3 peer tests survived the move.** `cargo test -p ql-oplog peer::` reports `3 passed; 0 failed` — `round_trips_through_u64`, `display_is_16_hex_chars`, `equality_and_hash_consistent`. `crates/ql-collab/src/` no longer contains `peer.rs` (`ls` confirms only `lib.rs/presence.rs/session.rs/transport.rs/undo.rs`).
- **Back-compat re-export is correct.** `ql-collab/src/lib.rs:73` `pub use ql_oplog::PeerId;`. Internal callsites `presence.rs:58` and `session.rs:52` both pulled directly from `ql_oplog` (preferred — avoids self-re-export aliasing). External callers using `ql_collab::PeerId` still resolve through the re-export. No callers exist outside ql-collab anyway (no other workspace crate depends on ql-collab per Cargo.toml scan).
- **Cross-references internally consistent.** `ql-oplog/src/peer.rs` describes itself accurately as "introduced as ql_collab::PeerId, moved to ql_oplog::PeerId"; uses module-relative `crate::OpLog`; references `ql_collab::CollabSession/presence` as downstream consumers (correct direction). `ql-collab/src/lib.rs` Stability bullet at line 62-66 is strictly accurate — moves the type, preserves re-export, no signature change.
- **Stability section claim is true.** No `ql_collab::peer::*` direct module-path import survives anywhere. The `pub use peer::PeerId` line was removed (line 18 in old → line 73 with new source); `pub use ql_oplog::PeerId` resolves identically for `use ql_collab::PeerId;` consumers.
- **LEGACY_PEER deferral defensible.** D-1 checklist locates the sentinel at step 5 (qbook envelope schema bump) where its only call-site (the legacy-u32 loader) is born. Adding the constant in step 1 with no consumer would (a) violate the no-unused-symbols hygiene the project enforces and (b) prematurely commit to one of two equally-valid encodings (`PeerId(0)` vs `PeerId(u64::MAX - 1)`). The checklist explicitly hedges "Pick one in step 1" but the decision criterion (Loro acceptance, sentinel collision avoidance) is more naturally informed by step 5's loader needs. Defer is correct.
- **Forward-readiness for step 2 is clean.** `crates/ql-oplog/src/wire.rs` (281 LOC) follows a consistent pattern: `pub enum WireDecodeError` (thiserror), `pub enum CellWireValue` (serde derive + impl), `pub enum NamedTargetWire` (serde derive + impl), plus two free helpers. Adding `pub enum FormatIdWire { Builtin(u32), Custom([u8; 8], u32) }` or `Custom(PeerId, u32)` slots in alongside `CellWireValue`/`NamedTargetWire` with no naming clash. `WireDecodeError` is `#[non_exhaustive]` (line 45) so step 2 can add a `FormatIdDecode { ... }` variant without breaking callers. `PeerId` is now accessible in-crate as `crate::PeerId` for the wire type's owned form — no re-route needed. The pub-use line in `ql-oplog/src/lib.rs:50` (`pub use wire::{CellWireValue, NamedTargetWire, WireDecodeError};`) needs a tiny extension to add `FormatIdWire` — trivial.
- **Workspace gates re-verified by me at this HEAD:** `cargo test -p ql-oplog peer::` 3 passed. Engineer's full-workspace 4222-test count is consistent with the pattern (moved file, not added test).
- **Git rename detection clean.** `git show --stat` reports `rename from ... rename to ... similarity index 67%` — confirms a true rename, not a delete+create that would lose blame history.

## Overall verdict

**PASS.** Commit `aaa54d32f4d` is a clean preparatory refactor. No HIGH or MEDIUM issues. The three LOW items are pre-existing doc-link nits and naming drift — none block step 2, none introduce risk, all can be folded into a later doc-polish pass (or punted to Phase 5.8 megaudit). Proceed to step 2 (`FormatIdWire` in `ql-oplog::wire`).

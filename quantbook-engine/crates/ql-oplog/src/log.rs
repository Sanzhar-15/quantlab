//! `OpLog` — Loro-backed append-only operation log.
//!
//! Phase 2A.3.a (2026-05-12): scaffolding-only API. The log stores ops as
//! JSON-encoded strings inside a single Loro `LoroList` container named
//! `"ops"`. Each `OpLog::append` call serializes the `Op`, pushes a string
//! into the list, and commits the Loro doc.
//!
//! ## Why JSON-in-Loro
//!
//! Per Round 7 architectural lock T1-D05, Loro is reserved for the op log
//! layer. Phase 2A.3.a aims for minimum viable scaffolding — full CRDT
//! semantics (LoroMap-per-op with typed fields) is reserved for Phase 5+
//! when inter-peer merging becomes load-bearing. The JSON layer is
//! invisible to callers: they see typed `Op` values via `iter`.
//!
//! ## Persistence
//!
//! `export_bytes` produces a `Vec<u8>` via `ExportMode::Snapshot`. The
//! resulting blob includes the full state plus history; **suitable for
//! transport to other peers** (consumed by `merge_bytes` on the
//! receiver). For `.qbook/oplog.bin` file persistence, the
//! `ql_io::oplog_persistence` layer wraps this blob in a Quantlab
//! header (Phase 5.2 D-1 step 7 — Tier D3: `OPLOG_MAGIC` + version u32).
//! Do NOT write `export_bytes()` output directly to `oplog.bin`;
//! use `save_workbook_with_oplog` instead.
//!
//! `import_bytes` reconstructs an `OpLog` from such a blob (raw Loro
//! snapshot — the persistence layer strips the Quantlab header before
//! calling this fn). The reader probes the `"ops"` LoroList; if absent
//! (or the wrong shape), the import returns `OpLogError::SchemaMismatch`.

use loro::{CommitOptions, ExportMode, LoroDoc, LoroList, LoroValue, ValueOrContainer};

use crate::error::OpLogError;
use crate::op::Op;

/// The Loro container name our ops live under. Hard-coded; Phase 5+
/// CRDT-level refactoring may add more containers (versions, peer state,
/// etc.) but `"ops"` is reserved.
const OPS_CONTAINER: &str = "ops";

/// **Phase 5.6 (2026-05-19):** Loro container name for the per-peer
/// ephemeral presence map (cursor + selection + typing indicator).
/// Per the audit-closed Phase 5.1 design at
/// `docs/architecture/crdt-data-model.md` § Presence container.
/// Keys are peer-id strings; values are opaque JSON blobs (the
/// typed `PresenceState` encoding lives in `ql_collab::presence`).
const PRESENCE_CONTAINER: &str = "presence";

/// **Phase 5.4 V1 (2026-05-19):** commit-origin tag for presence
/// writes. `ql_collab::CollabSession` wires this to Loro's
/// `UndoManager::add_exclude_origin_prefix` so cursor movements
/// don't pollute the undo stack. Exported as `pub` so the higher-
/// layer (ql-collab) can reference the same string constant.
///
/// **Reserved-namespace convention:** trailing `":"` so the prefix
/// `presence:` only matches deliberately-namespaced origins (e.g.
/// a future `presence:typing` would also be excluded; an
/// independent `"presence-foo"` origin would NOT). This protects
/// against accidental over-exclusion as more origins land
/// (Codex+Opus 5.4 V1 audit findings A4/M5).
pub const PRESENCE_COMMIT_ORIGIN: &str = "presence:";

/// Append-only operation log backed by Loro.
///
/// Construct via `OpLog::new()` for a fresh log or `OpLog::import_bytes(...)`
/// to reconstruct from a persisted snapshot. Mutations go through `append`;
/// reads through `iter` / `len` / `is_empty`.
pub struct OpLog {
    doc: LoroDoc,
}

impl std::fmt::Debug for OpLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpLog")
            .field("len", &self.len())
            .field("doc", &"<LoroDoc>")
            .finish()
    }
}

impl Default for OpLog {
    fn default() -> Self {
        Self::new()
    }
}

impl OpLog {
    /// Construct an empty log.
    pub fn new() -> Self {
        Self {
            doc: LoroDoc::new(),
        }
    }

    /// Append one `Op` to the log. Serializes via `serde_json`, stores as
    /// a `LoroValue::String` in the `"ops"` LoroList, and commits the
    /// underlying Loro doc.
    pub fn append(&mut self, op: Op) -> Result<(), OpLogError> {
        let json = serde_json::to_string(&op).map_err(OpLogError::Serialize)?;
        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
        list.push(LoroValue::from(json.as_str()))?;
        self.doc.commit();
        Ok(())
    }

    /// Iterate the log in append order. Each yielded item is a
    /// `Result<Op, OpLogError>` — a deserialization failure yields
    /// `Err(OpLogError::Deserialize { index, source })` and iteration
    /// continues (no short-circuit). Callers wanting fail-fast can use
    /// `iter().collect::<Result<Vec<_>, _>>()`.
    pub fn iter(&self) -> impl Iterator<Item = Result<Op, OpLogError>> + '_ {
        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
        let len = list.len();
        (0..len).map(move |index| {
            let entry = list.get(index).ok_or(OpLogError::SchemaMismatch(
                "ops LoroList lost an entry between len() and get()",
            ))?;
            let value = match entry {
                ValueOrContainer::Value(v) => v,
                ValueOrContainer::Container(_) => {
                    return Err(OpLogError::SchemaMismatch(
                        "ops LoroList holds a container; expected JSON-string values",
                    ));
                }
            };
            let s = match value {
                LoroValue::String(s) => s,
                _ => {
                    return Err(OpLogError::SchemaMismatch(
                        "ops LoroList holds a non-string LoroValue; expected JSON-string",
                    ));
                }
            };
            serde_json::from_str::<Op>(&s)
                .map_err(|source| OpLogError::Deserialize { index, source })
        })
    }

    /// Number of ops currently visible in the `"ops"` LoroList.
    ///
    /// **Phase 5.4 V1 (2026-05-19):** queries Loro directly each call
    /// (was a cached `usize` field through 5.6). Codex 5.4 V1 audit
    /// HIGH found the cache became stale after `loro::UndoManager`
    /// retracted ops from the visible list. Returning Loro's
    /// authoritative count is correct by construction; per-call
    /// cost is one container handle lookup + a length read.
    pub fn len(&self) -> usize {
        self.doc.get_list(OPS_CONTAINER).len()
    }

    /// **Phase 5.7 V3.6.0.4 D3 (2026-05-23) -- random-access op lookup.**
    ///
    /// Returns `Some(Ok(op))` if `index < len()` and the entry deserializes
    /// successfully, `Some(Err(OpLogError::Deserialize { .. }))` if the
    /// JSON at that index is malformed, `Some(Err(OpLogError::Schema-
    /// Mismatch))` if the Loro list shape is unexpected, or `None` if
    /// the index is out of range.
    ///
    /// Mirrors a single iteration of [`OpLog::iter`] at the given index.
    /// Internally uses `LoroList::get(index)` (an indexed BTree lookup
    /// over Loro's internal list representation -- O(log N) per Loro
    /// 1.12.0 per `loro::LoroList::get` -> `LengthFinder` query over
    /// `generic_btree::BTree` at `state/list_state.rs:317`; not pure
    /// O(1) as earlier comments claimed, but still avoids the
    /// full-log scan that `iter()` would impose on the caller).
    ///
    /// **Use case**: V3.6.0.4 D3 `invalidate_cell` consults the session
    /// `cell_op_index: HashMap<(SheetId, RowId, ColId), Vec<usize>>` to
    /// get the (small) set of log indices touching the target cell,
    /// then fetches each via this method.  Without random-access lookup
    /// `invalidate_cell` would still walk the full log (O(N)) and only
    /// filter at the apply step (which defeats the index's purpose).
    ///
    /// **Visible-counter caveat**: `index` indexes Loro's CURRENTLY-VISIBLE
    /// list (post any UndoManager retracts).  Indexes captured before a
    /// retract may resolve to a different op (or out-of-range) after.
    /// V3.6.0.X audit-of-D2 closure for V3.6.0.2 D1 documents the
    /// `pending_undo_cells` Mutex pattern that re-establishes consistency
    /// on undo/redo via on_push staging; the cell_op_index is rebuilt
    /// during the post-undo full-rebuild fallback path so stale indices
    /// don't survive retracts.
    pub fn get(&self, index: usize) -> Option<Result<Op, OpLogError>> {
        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
        if index >= list.len() {
            return None;
        }
        let entry = match list.get(index) {
            Some(e) => e,
            None => {
                return Some(Err(OpLogError::SchemaMismatch(
                    "ops LoroList lost an entry between len() and get()",
                )));
            }
        };
        let value = match entry {
            ValueOrContainer::Value(v) => v,
            ValueOrContainer::Container(_) => {
                return Some(Err(OpLogError::SchemaMismatch(
                    "ops LoroList holds a container; expected JSON-string values",
                )));
            }
        };
        let s = match value {
            LoroValue::String(s) => s,
            _ => {
                return Some(Err(OpLogError::SchemaMismatch(
                    "ops LoroList holds a non-string LoroValue; expected JSON-string",
                )));
            }
        };
        Some(
            serde_json::from_str::<Op>(&s)
                .map_err(|source| OpLogError::Deserialize { index, source }),
        )
    }

    /// True iff `len() == 0`.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// **Phase 5.2.b (2026-05-19):** set this log's Loro peer id.
    ///
    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
    /// to wire its stable `PeerId` through to Loro so concurrent
    /// appends carry the right origin in the CRDT merge metadata.
    ///
    /// Loro takes `&self` (interior mutability), so this method is
    /// `&self` too. Calling it twice with the same id leaves the
    /// peer id unchanged but is NOT a strict no-op at Loro's
    /// internal layer: Loro re-stores the atom and emits a
    /// `peer_id_change_subs` notification each call. Avoid calling
    /// repeatedly in hot paths.
    ///
    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
    /// 1. NEVER reuse the same peer id across concurrent writers
    ///    (multiple tabs / devices for the same user). Duplicate peer
    ///    ids corrupt the document via conflicting OpIDs.
    /// 2. Avoid pinning a peer id to a stable user/device identity
    ///    unless you also enforce single-ownership locking. Prefer a
    ///    per-process-random peer id.
    /// 3. Setting peer id AFTER an import is safe — existing imported
    ///    ops retain their original peer ids; only this log's future
    ///    appends use the new id.
    /// 4. Loro reserves `u64::MAX` as a sentinel; passing it returns
    ///    `OpLogError::Loro(LoroError::InvalidPeerID)`.
    /// 5. **Phase 5.4 V1 (2026-05-19):** if a `loro::UndoManager`
    ///    (constructed via [`new_undo_manager`]) is alive, Loro
    ///    SILENTLY CLEARS its undo + redo stacks on the peer-id
    ///    change (`loro-internal::undo:654-662`). Callers must
    ///    treat post-construction peer-id changes as undo-stack-
    ///    invalidating events.
    ///
    /// Signature note: `&mut self` (Phase 5.4 V1 audit closure)
    /// even though Loro's `LoroDoc::set_peer_id` is `&self`. The
    /// `&mut` prevents accidental peer-id changes through a shared
    /// `&OpLog` (`CollabSession::op_log()`) which would silently
    /// clear an attached `UndoManager`'s stacks per pitfall 5.
    ///
    /// **Phase 5.2 D-1 step 8 megaudit closure (Opus-B HIGH-1,
    /// 2026-05-20):** asserts `peer != 0`. PeerId(0) is `LEGACY_PEER`
    /// — reserved as the sentinel for pre-collab single-writer +
    /// qbook envelope migration. An active session whose Loro peer
    /// id is 0 would silently collide with the LEGACY_PEER semantic
    /// in `FormatTable::with_peer(LEGACY_PEER)` (the cross-peer
    /// same-string design assumes LEGACY_PEER is sentinel-only).
    /// `CollabSession::new` + `from_snapshot` already assert this at
    /// the higher level; this guard catches direct callers of
    /// `OpLog::set_peer_id` that bypass the CollabSession constructor.
    pub fn set_peer_id(&mut self, peer: u64) -> Result<(), OpLogError> {
        assert_ne!(
            peer, 0,
            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
             OpLog::set_peer_id must be called with a non-zero peer; collides with LEGACY_PEER otherwise."
        );
        self.doc.set_peer_id(peer)?;
        Ok(())
    }

    /// Current Loro peer id for this log. Wraps `LoroDoc::peer_id`.
    pub fn peer_id(&self) -> u64 {
        self.doc.peer_id()
    }

    /// **Phase 5.6 (2026-05-19):** write the given peer's presence blob
    /// into the `"presence"` LoroMap.
    ///
    /// `peer_key` is a string identifier (typically the 16-hex form of
    /// [`PeerId::Display`](crate::PeerId)); `json` is an opaque blob — the
    /// typed `PresenceState` encoding lives in `ql_collab::presence`.
    /// This layer doesn't interpret the bytes.
    ///
    /// LWW semantics per peer: a later `presence_set` for the same
    /// `peer_key` from any peer (including the same peer in a different
    /// session) replaces the previous value at merge time. Concurrent
    /// `presence_set` calls for DIFFERENT `peer_key`s are independent
    /// and both survive merge.
    ///
    /// Triggers `doc.commit_with(origin=PRESENCE_COMMIT_ORIGIN)` so
    /// the write is durable through `export_bytes` / `merge_bytes`
    /// immediately AND is excluded from `UndoManager` (Phase 5.4
    /// V1 wires `add_exclude_origin_prefix(PRESENCE_COMMIT_ORIGIN)`).
    pub fn presence_set(&mut self, peer_key: &str, json: &str) -> Result<(), OpLogError> {
        let map = self.doc.get_map(PRESENCE_CONTAINER);
        map.insert(peer_key, LoroValue::from(json))?;
        self.doc
            .commit_with(CommitOptions::new().origin(PRESENCE_COMMIT_ORIGIN));
        Ok(())
    }

    /// **Phase 5.6 (2026-05-19):** read the given peer's presence blob.
    /// Returns `None` if the peer has no presence entry.
    ///
    /// Surfaces `OpLogError::SchemaMismatch` if the `"presence"` map
    /// holds a non-string or container value at `peer_key` (only
    /// reachable if a future writer puts wrong-shape data into the
    /// container; current API only writes strings).
    pub fn presence_get(&self, peer_key: &str) -> Result<Option<String>, OpLogError> {
        let map = self.doc.get_map(PRESENCE_CONTAINER);
        let Some(entry) = map.get(peer_key) else {
            return Ok(None);
        };
        let value = match entry {
            ValueOrContainer::Value(v) => v,
            ValueOrContainer::Container(_) => {
                return Err(OpLogError::SchemaMismatch(
                    "presence LoroMap holds a container value; expected JSON string",
                ));
            }
        };
        match value {
            LoroValue::String(s) => Ok(Some(s.to_string())),
            _ => Err(OpLogError::SchemaMismatch(
                "presence LoroMap holds a non-string LoroValue; expected JSON string",
            )),
        }
    }

    /// **Phase 5.6 (2026-05-19):** remove the given peer's presence
    /// entry. Idempotent — deleting a non-existent key is a no-op
    /// (Loro returns Ok). Triggers
    /// `doc.commit_with(origin=PRESENCE_COMMIT_ORIGIN)` so the
    /// tombstone propagates AND is excluded from undo.
    pub fn presence_remove(&mut self, peer_key: &str) -> Result<(), OpLogError> {
        let map = self.doc.get_map(PRESENCE_CONTAINER);
        map.delete(peer_key)?;
        self.doc
            .commit_with(CommitOptions::new().origin(PRESENCE_COMMIT_ORIGIN));
        Ok(())
    }

    /// **Phase 5.4 V1 (2026-05-19):** construct a Loro `UndoManager`
    /// bound to this log's underlying `LoroDoc`.
    ///
    /// Per Loro 1.12.0 docs (`lib.rs:3708`):
    /// - "Local-only: undo/redo affects only local operations from
    ///   the bound peer; it does not revert remote edits."
    /// - "keep the `peer_id` stable while an `UndoManager` is in
    ///   use."
    ///
    /// Callers MUST construct the manager AFTER `set_peer_id` and
    /// SHOULD NOT change the peer id while it's alive. The returned
    /// manager subscribes to the doc's commit stream; subsequent
    /// `append` / `presence_set` / `presence_remove` calls feed it.
    ///
    /// Presence writes use the `PRESENCE_COMMIT_ORIGIN` origin
    /// (see [`presence_set`]). To exclude them from the undo stack
    /// call `manager.add_exclude_origin_prefix(PRESENCE_COMMIT_ORIGIN)`
    /// after construction. The `ql_collab::CollabSession`
    /// integration does this automatically.
    pub fn new_undo_manager(&self) -> loro::UndoManager {
        loro::UndoManager::new(&self.doc)
    }

    /// **Phase 5.6 (2026-05-19):** list the peer keys currently
    /// represented in the `"presence"` map.
    ///
    /// Order is Loro's iteration order (not stable across versions).
    /// Callers wanting deterministic order should sort the result.
    pub fn presence_peers(&self) -> Vec<String> {
        let map = self.doc.get_map(PRESENCE_CONTAINER);
        let mut out = Vec::with_capacity(map.len());
        map.for_each(|key, _| out.push(key.to_owned()));
        out
    }

    /// Export the log to a binary blob suitable for on-disk persistence.
    /// Uses Loro's `ExportMode::Snapshot` — includes full state + history,
    /// compressed.
    pub fn export_bytes(&self) -> Result<Vec<u8>, OpLogError> {
        Ok(self.doc.export(ExportMode::Snapshot)?)
    }

    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** export the delta of
    /// ops added SINCE the given version vector `from`. Uses
    /// `ExportMode::updates(&from)`.
    ///
    /// `from = &VersionVector::default()` (empty VV) is equivalent to
    /// `ExportMode::all_updates()` — sends every op the doc has ever
    /// seen. Use for fresh-peer handshakes.
    ///
    /// `from = &self.oplog_vv()` (current VV) produces a payload with
    /// no new ops — typically an empty / near-empty wire blob. Use
    /// for "did anything happen since last sync" checks.
    ///
    /// Returns the encoded bytes. Loro's `import` transparently
    /// consumes both `Snapshot` and `Updates` blobs on the receiver
    /// side, so the wire format is opaque to peers.
    pub fn export_delta_bytes(&self, from: &loro::VersionVector) -> Result<Vec<u8>, OpLogError> {
        Ok(self.doc.export(ExportMode::updates(from))?)
    }

    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** read the doc's
    /// current op-log version vector. Cheap — clones an internal
    /// `VersionVector` whose size is O(peer-count), not O(op-count)
    /// (per Loro 1.12: `LoroDoc::oplog_vv` returns
    /// `self.oplog.lock().vv().clone()`; size is one `u32` per
    /// distinct peer that has ever contributed an op).
    ///
    /// Called by `ql_collab::CollabSession::flush_delta_to_transport`
    /// (which depends on `ql-oplog`); there is no reverse
    /// dependency.
    pub fn oplog_vv(&self) -> loro::VersionVector {
        self.doc.oplog_vv()
    }

    /// **Phase 5.5 V2 V4 V1 step 5 (2026-05-21) — Tier I2.** Fork
    /// the underlying `LoroDoc` at the given VersionVector, returning
    /// a new `OpLog` whose history ends at that VV. Used by
    /// [`ql_collab::CollabSession::discard_pending_ops`] to revert
    /// pending ops back to the last-flushed checkpoint.
    ///
    /// Composes `LoroDoc::vv_to_frontiers` + `LoroDoc::fork_at`:
    /// 1. Convert `vv` to the precise causal-history Frontiers marker.
    /// 2. Fork the doc — the new doc contains ONLY ops with
    ///    counter ≤ the corresponding entry in `vv`, per peer.
    ///
    /// The returned `OpLog`'s `oplog_vv()` matches the input `vv`
    /// exactly. The peer-id of the new doc is fresh (Loro's default
    /// at construction time); callers should `set_peer_id` if they
    /// want to preserve their stable PeerId for subsequent appends.
    ///
    /// # Errors
    ///
    /// - `OpLogError::InvalidVersionVector(_)` if `vv` is ahead of
    ///   the current `oplog_vv` (per-peer counter exceeds the local)
    ///   or references peers not in the local history. **V2 V4 V1
    ///   step 5 audit closure (Codex M1, 2026-05-21):** Loro 1.12's
    ///   `vv_to_frontiers` internally `.unwrap()`s in these cases
    ///   and would panic; pre-validate at the OpLog API boundary
    ///   and surface as a proper Err.
    /// - `OpLogError::Loro(_)` if `LoroDoc::fork_at` fails post-
    ///   validation (should not happen if validation passes, but
    ///   defensive `?` propagation).
    pub fn fork_at_vv(&self, vv: &loro::VersionVector) -> Result<Self, OpLogError> {
        // V2 V4 V1 step 5 audit closure (Codex M1): pre-validate
        // the VV against our current oplog_vv. Reject if vv has any
        // peer with a counter greater than ours (vv is ahead) OR
        // references a peer we've never seen.
        let current = self.doc.oplog_vv();
        for (peer, vv_counter) in vv.iter() {
            let current_counter = current.get(peer).copied().unwrap_or(0);
            if *vv_counter > current_counter {
                return Err(OpLogError::InvalidVersionVector(format!(
                    "VV references peer {peer:?} with counter {vv_counter} > current {current_counter}; \
                     cannot fork ahead of local history"
                )));
            }
        }
        let frontiers = self.doc.vv_to_frontiers(vv);
        let forked = self.doc.fork_at(&frontiers)?;
        Ok(Self { doc: forked })
    }

    /// Reconstruct an `OpLog` from a previously-exported snapshot.
    /// If the snapshot doesn't carry our `"ops"` container shape,
    /// subsequent `iter` / `len` calls operate on an empty list
    /// (Loro creates absent root containers on first access).
    pub fn import_bytes(bytes: &[u8]) -> Result<Self, OpLogError> {
        let doc = LoroDoc::new();
        doc.import(bytes)?;
        Ok(Self { doc })
    }

    /// **Phase 5.2 D-4 (2026-05-19):** merge another peer's snapshot
    /// into this log via Loro's CRDT merge. Concurrent appends to
    /// the `"ops"` LoroList are preserved in deterministic causal
    /// order (Fugue/origin-based with peer-id tiebreaker per
    /// `loro-internal::container::richtext::tracker::crdt_rope`).
    ///
    /// Typical pattern for multi-peer collaboration:
    /// 1. Both peers start from a shared snapshot (`import_bytes`).
    /// 2. Each peer appends its own ops independently.
    /// 3. Peer A exports its current state via `export_bytes`.
    /// 4. Peer B calls `merge_bytes(&a_bytes)` — peer B's log now
    ///    contains both peers' ops in causal order.
    /// 5. Replay against a workbook reconstructs the merged state.
    /// 6. `WorkbookRuntime::recompute_all` resolves derived state
    ///    (spills, formula values) from the merged final state.
    ///
    /// Returns the new `len()` after merge.
    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, OpLogError> {
        self.doc.import(bytes)?;
        Ok(self.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{CellWireValue, NamedTargetWire};

    fn put_value(sheet: u16, row: u32, col: u32, n: f64) -> Op {
        Op::PutValue {
            sheet,
            row,
            col,
            value: CellWireValue::Number(n),
        }
    }

    #[test]
    fn new_log_is_empty() {
        let log = OpLog::new();
        assert!(log.is_empty());
        assert_eq!(log.len(), 0);
        assert!(log.iter().next().is_none());
    }

    #[test]
    fn append_single_op_round_trips() {
        let mut log = OpLog::new();
        let op = put_value(0, 5, 3, 42.0);
        log.append(op.clone()).unwrap();
        assert_eq!(log.len(), 1);
        let read: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(read, vec![op]);
    }

    #[test]
    fn append_each_variant_round_trips() {
        let ops = vec![
            put_value(0, 0, 0, 1.0),
            // F2 Blank-durability closure: ClearValue round-trips on the wire.
            Op::ClearValue {
                sheet: 0,
                row: 0,
                col: 0,
            },
            Op::PutFormula {
                sheet: 0,
                row: 1,
                col: 0,
                text: "A1 * 2".to_owned(),
            },
            Op::ClearFormula {
                sheet: 0,
                row: 1,
                col: 0,
            },
            Op::SetName {
                scope: None,
                name: "TaxRate".to_owned(),
                target: NamedTargetWire::Constant {
                    value: CellWireValue::Number(0.21),
                },
            },
            // FE-5 W-N: RemoveName (the compensating op for SetName) must round-trip
            // too. Cover both scope arms, mirroring SetName's shape: workbook-scoped
            // (`None`) and sheet-scoped (`Some(id)`).
            Op::RemoveName {
                scope: None,
                name: "TaxRate".to_owned(),
            },
            Op::RemoveName {
                scope: Some(1),
                name: "LocalRate".to_owned(),
            },
            Op::AddSheet {
                name: "Inventory".to_owned(),
                chunk_rows: 16384,
            },
            Op::BatchCommit {
                ops: vec![
                    put_value(0, 0, 0, 7.0),
                    Op::PutFormula {
                        sheet: 0,
                        row: 0,
                        col: 1,
                        text: "A1 + 1".to_owned(),
                    },
                ],
            },
        ];
        let mut log = OpLog::new();
        for op in &ops {
            log.append(op.clone()).unwrap();
        }
        assert_eq!(log.len(), ops.len());
        let read: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(read, ops);
    }

    #[test]
    fn binary_export_import_preserves_order() {
        let mut log = OpLog::new();
        let ops = vec![
            put_value(0, 0, 0, 1.0),
            put_value(0, 0, 1, 2.0),
            put_value(0, 0, 2, 3.0),
            Op::PutFormula {
                sheet: 0,
                row: 1,
                col: 0,
                text: "A1 + B1 + C1".to_owned(),
            },
            Op::AddSheet {
                name: "Sheet2".to_owned(),
                chunk_rows: 16384,
            },
        ];
        for op in &ops {
            log.append(op.clone()).unwrap();
        }
        let bytes = log.export_bytes().unwrap();
        let restored = OpLog::import_bytes(&bytes).unwrap();
        assert_eq!(restored.len(), ops.len());
        let read: Vec<Op> = restored.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(read, ops);
    }

    #[test]
    fn import_empty_snapshot_yields_empty_log() {
        let original = OpLog::new();
        let bytes = original.export_bytes().unwrap();
        let restored = OpLog::import_bytes(&bytes).unwrap();
        assert!(restored.is_empty());
        assert_eq!(restored.len(), 0);
    }

    #[test]
    fn import_garbage_bytes_returns_loro_error() {
        let bytes = b"this is not a loro snapshot";
        let result = OpLog::import_bytes(bytes);
        assert!(
            matches!(result, Err(OpLogError::Loro(_))),
            "expected Loro error for garbage bytes, got {result:?}"
        );
    }

    #[test]
    fn set_peer_id_changes_doc_peer_id() {
        let mut log = OpLog::new();
        let before = log.peer_id();
        log.set_peer_id(0xdead_beef_cafe_babe).unwrap();
        assert_eq!(log.peer_id(), 0xdead_beef_cafe_babe);
        assert_ne!(log.peer_id(), before, "set_peer_id must replace default");
    }

    #[test]
    fn set_peer_id_after_import_works() {
        // Origin writes ops under peer 11.
        let mut origin = OpLog::new();
        origin.set_peer_id(11).unwrap();
        // Append a real op so the snapshot carries committed history
        // (Codex/Opus 5.2.b audit caught: prior version of this test
        // exported an empty doc, so the "imported ops retain peer 11"
        // promise was never exercised).
        origin.append(put_value(0, 0, 0, 1.0)).unwrap();
        let bytes = origin.export_bytes().unwrap();

        // Reborn imports + reassigns peer id; future appends use 22.
        let mut reborn = OpLog::import_bytes(&bytes).unwrap();
        reborn.set_peer_id(22).unwrap();
        assert_eq!(reborn.peer_id(), 22);
        // The imported op is still readable (so the snapshot round-trip
        // survived the peer-id change).
        let read: Vec<Op> = reborn.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(read.len(), 1);
        // Reborn can append further ops under its new peer id.
        reborn.append(put_value(0, 1, 0, 2.0)).unwrap();
        assert_eq!(reborn.len(), 2);
        assert_eq!(reborn.peer_id(), 22);
    }

    #[test]
    fn presence_set_get_round_trip() {
        let mut log = OpLog::new();
        // Initially empty.
        assert!(log.presence_get("peer-a").unwrap().is_none());
        assert!(log.presence_peers().is_empty());

        // Write.
        log.presence_set("peer-a", r#"{"sheet":0,"row":1,"col":2}"#)
            .unwrap();
        let read = log.presence_get("peer-a").unwrap().unwrap();
        assert_eq!(read, r#"{"sheet":0,"row":1,"col":2}"#);
        assert_eq!(log.presence_peers(), vec!["peer-a".to_owned()]);

        // Overwrite (LWW).
        log.presence_set("peer-a", r#"{"sheet":1,"row":0,"col":0}"#)
            .unwrap();
        assert_eq!(
            log.presence_get("peer-a").unwrap().unwrap(),
            r#"{"sheet":1,"row":0,"col":0}"#
        );

        // Independent key.
        log.presence_set("peer-b", "{}").unwrap();
        let mut peers = log.presence_peers();
        peers.sort();
        assert_eq!(peers, vec!["peer-a".to_owned(), "peer-b".to_owned()]);

        // Remove.
        log.presence_remove("peer-a").unwrap();
        assert!(log.presence_get("peer-a").unwrap().is_none());
        assert_eq!(log.presence_peers(), vec!["peer-b".to_owned()]);
    }

    #[test]
    fn presence_survives_export_import_round_trip() {
        let mut log = OpLog::new();
        log.presence_set("peer-a", r#"{"sheet":0}"#).unwrap();
        let bytes = log.export_bytes().unwrap();
        let restored = OpLog::import_bytes(&bytes).unwrap();
        assert_eq!(
            restored.presence_get("peer-a").unwrap().unwrap(),
            r#"{"sheet":0}"#
        );
    }

    #[test]
    fn presence_same_key_lww_under_concurrent_merge() {
        // Audit-discipline closure (Codex 5.6 V1 LOW-1 / C2): two
        // peers writing to the SAME presence key produces ONE
        // surviving value at merge time (LoroMap LWW by Lamport
        // then peer id). Pin the behavior so a future Loro upgrade
        // can't silently change it.
        //
        // The "same key, different peers" case is the deliberate
        // duplicate-peer-id scenario the docstrings warn against,
        // but we want to verify the data IS still single-valued
        // post-merge rather than corrupted.
        let mut base = OpLog::new();
        base.set_peer_id(1).unwrap();
        let base_bytes = base.export_bytes().unwrap();

        let mut peer_a = OpLog::import_bytes(&base_bytes).unwrap();
        peer_a.set_peer_id(10).unwrap();
        peer_a
            .presence_set("shared-key", r#"{"from":"A"}"#)
            .unwrap();

        let mut peer_b = OpLog::import_bytes(&base_bytes).unwrap();
        peer_b.set_peer_id(20).unwrap();
        peer_b
            .presence_set("shared-key", r#"{"from":"B"}"#)
            .unwrap();

        // A merges B.
        peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();

        // Exactly one value survives — LWW by (lamport, peer_id).
        // Both peers had lamport=1 so peer-id tiebreaker picks B's
        // value (20 > 10). Whichever loro chose, assert it's ONE of
        // the two writes (no corruption) and that listing peers
        // returns exactly one entry.
        let value = peer_a.presence_get("shared-key").unwrap().unwrap();
        assert!(
            value == r#"{"from":"A"}"# || value == r#"{"from":"B"}"#,
            "same-key concurrent write must produce one of the two values, got {value:?}"
        );
        assert_eq!(
            peer_a.presence_peers(),
            vec!["shared-key".to_owned()],
            "same-key concurrent write must yield exactly one map entry"
        );
    }

    #[test]
    fn presence_independent_from_op_log() {
        // Presence writes MUST NOT increment the op log len.
        let mut log = OpLog::new();
        log.presence_set("peer-a", "{}").unwrap();
        assert_eq!(log.len(), 0, "presence is not in the 'ops' container");
        assert!(log.is_empty());

        // And vice-versa: appending an op MUST NOT touch presence.
        log.append(put_value(0, 0, 0, 1.0)).unwrap();
        assert_eq!(log.len(), 1);
        assert!(log.presence_get("peer-a").unwrap().is_some());
    }

    #[test]
    fn set_peer_id_max_is_rejected_as_loro_sentinel() {
        // Loro 1.12.0 reserves u64::MAX as an internal sentinel
        // (`LoroError::InvalidPeerID`). Pin the rejection behavior so
        // a future Loro upgrade can't silently change it.
        let mut log = OpLog::new();
        let result = log.set_peer_id(u64::MAX);
        assert!(
            matches!(result, Err(OpLogError::Loro(_))),
            "u64::MAX must be rejected as a Loro sentinel; got {result:?}"
        );
    }

    // ============================================================
    // V2 V4 V1 step 4 — Tier K7: empty Message::Binary frame test
    // ============================================================

    #[test]
    fn merge_bytes_with_empty_slice_does_not_panic() {
        // **V2 V4 V1 step 4 (Tier K7, 2026-05-21):** pin Loro's
        // contract for `OpLog::merge_bytes(&[])`. A misbehaving (or
        // adversarial) peer could send a 0-byte `Message::Binary(b"")`
        // via WebSocketTransport; ql-collab-ws's reader task forwards
        // it as `Vec::new()` to `CollabSession::merge_bytes(&[])`
        // which calls `OpLog::merge_bytes(&[])` which calls
        // `LoroDoc::import(&[])`. Whatever Loro 1.12 does here, pin
        // it as a contract — if a future Loro upgrade changes the
        // empty-input behavior (Ok → Err, or Err → panic), this
        // test surfaces the regression.
        //
        // Per V2 V3 step 5 megaudit Opus-B L3: this scenario was
        // documented-but-not-pinned. Step 4 closes the gap.
        let mut log = OpLog::new();
        let pre_len = log.len();
        let result = log.merge_bytes(&[]);

        // **V2 V4 V1 step 4 audit closure (Opus L2):** the test
        // PINS: "no panic + no partial-state (log.len() unchanged)."
        // It does NOT strictly pin Ok-vs-Err. Loro 1.12 currently
        // returns Err(Loro(_)), but a future Loro version could
        // accept empty as a no-op (Ok) — both shapes are acceptable
        // here. The strict pinned invariants are: (1) does not panic,
        // (2) log.len() remains pre_len, (3) Err variant (if any) is
        // OpLogError::Loro (the documented passthrough variant), not
        // some other variant. Treating Ok and Err as equally valid
        // is a deliberate trade-off — strict Err pinning would catch
        // intentional Loro behavior shifts as test failures.
        match result {
            Ok(post_len) => {
                // If a future Loro version accepts empty as a no-op,
                // verify the len() didn't change.
                assert_eq!(
                    post_len, pre_len,
                    "Ok(empty merge) MUST leave log.len() unchanged"
                );
            }
            Err(OpLogError::Loro(_)) => {
                // Current Loro 1.12 behavior. Verify the log is
                // unchanged (no partial-state on Err).
                assert_eq!(
                    log.len(),
                    pre_len,
                    "Err(empty merge) MUST leave log.len() unchanged (no partial-state)"
                );
            }
            Err(other) => {
                panic!("merge_bytes(&[]) returned an unexpected error variant: {other:?}")
            }
        }
    }

    // ============================================================
    // V2 V4 V1 step 5 audit closure (Codex M1) — fork_at_vv validation
    // ============================================================

    #[test]
    fn fork_at_vv_rejects_ahead_of_local_history() {
        // **V2 V4 V1 step 5 audit closure (Codex M1, 2026-05-21):**
        // pin the new InvalidVersionVector Err path. Without this
        // validation, Loro 1.12's `vv_to_frontiers` would panic on
        // a VV referencing peers/counters not in local history.
        let mut local = OpLog::new();
        local.set_peer_id(1).unwrap();
        local.append(put_value(0, 0, 0, 1.0)).unwrap();
        let local_vv = local.oplog_vv();

        // Construct a separate doc with MORE ops + a different peer.
        // Its VV is "ahead" of local in the sense that it references
        // a peer (2) the local has never seen.
        let mut other = OpLog::new();
        other.set_peer_id(2).unwrap();
        other.append(put_value(0, 1, 0, 2.0)).unwrap();
        other.append(put_value(0, 1, 1, 3.0)).unwrap();
        let other_vv = other.oplog_vv();

        // Pre-validation should reject — local has no peer 2.
        let result = local.fork_at_vv(&other_vv);
        assert!(
            matches!(result, Err(OpLogError::InvalidVersionVector(_))),
            "fork_at_vv with VV referencing unknown peer MUST return InvalidVersionVector, got {result:?}"
        );

        // Same-doc VV (round-trip) should succeed.
        let same_result = local.fork_at_vv(&local_vv);
        assert!(
            same_result.is_ok(),
            "fork_at_vv with this doc's own oplog_vv MUST succeed, got {same_result:?}"
        );
    }
}

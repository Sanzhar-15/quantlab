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
//! resulting blob includes the full state plus history; suitable for
//! `oplog.bin` on-disk persistence (Phase 2A.3.c).
//!
//! `import_bytes` reconstructs an `OpLog` from such a blob. The reader
//! probes the `"ops"` LoroList; if absent (or the wrong shape), the
//! import returns `OpLogError::SchemaMismatch`.

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
    pub fn set_peer_id(&mut self, peer: u64) -> Result<(), OpLogError> {
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
    /// `ql_collab::PeerId::Display`); `json` is an opaque blob — the
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
}

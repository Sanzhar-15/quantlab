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

use loro::{ExportMode, LoroDoc, LoroList, LoroValue, ValueOrContainer};

use crate::error::OpLogError;
use crate::op::Op;

/// The Loro container name our ops live under. Hard-coded; Phase 5+
/// CRDT-level refactoring may add more containers (versions, peer state,
/// etc.) but `"ops"` is reserved.
const OPS_CONTAINER: &str = "ops";

/// Append-only operation log backed by Loro.
///
/// Construct via `OpLog::new()` for a fresh log or `OpLog::import_bytes(...)`
/// to reconstruct from a persisted snapshot. Mutations go through `append`;
/// reads through `iter` / `len` / `is_empty`.
pub struct OpLog {
    doc: LoroDoc,
    /// Cached count to avoid round-tripping into Loro for `len()`. Always
    /// equal to `doc.get_list(OPS_CONTAINER).len()`; updated on append
    /// and on import.
    cached_len: usize,
}

impl std::fmt::Debug for OpLog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpLog")
            .field("cached_len", &self.cached_len)
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
            cached_len: 0,
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
        self.cached_len += 1;
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

    /// Number of ops in the log.
    pub fn len(&self) -> usize {
        self.cached_len
    }

    /// True iff `len() == 0`.
    pub fn is_empty(&self) -> bool {
        self.cached_len == 0
    }

    /// Export the log to a binary blob suitable for on-disk persistence.
    /// Uses Loro's `ExportMode::Snapshot` — includes full state + history,
    /// compressed.
    pub fn export_bytes(&self) -> Result<Vec<u8>, OpLogError> {
        Ok(self.doc.export(ExportMode::Snapshot)?)
    }

    /// Reconstruct an `OpLog` from a previously-exported snapshot.
    /// Probes the `"ops"` container to set the cached length; if the
    /// snapshot doesn't carry our shape, returns `OpLogError::SchemaMismatch`.
    pub fn import_bytes(bytes: &[u8]) -> Result<Self, OpLogError> {
        let doc = LoroDoc::new();
        doc.import(bytes)?;
        let list: LoroList = doc.get_list(OPS_CONTAINER);
        let cached_len = list.len();
        Ok(Self { doc, cached_len })
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
}

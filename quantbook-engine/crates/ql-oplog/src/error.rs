//! Error types for the op log.

use thiserror::Error;

/// Errors emitted by `OpLog` operations.
///
/// Phase 2A.3.a (2026-05-12): three failure modes —
/// 1. Serializing a well-formed `Op` to JSON should never fail; if it does
///    that's a programmer-error condition (bug in our `Op` derive).
/// 2. Deserializing back is the failure mode that fires under corrupted
///    on-disk op-log data.
/// 3. Loro's own export/import surface its own errors via `loro::LoroError`.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum OpLogError {
    /// JSON serialization of an `Op` failed. Should be unreachable for
    /// well-formed `Op` values produced by our own code.
    #[error("op log serialize error: {0}")]
    Serialize(#[source] serde_json::Error),

    /// JSON deserialization of an `Op` from the log failed. Typically
    /// indicates a corrupted on-disk op-log (`oplog.bin`) or version
    /// drift (older binary reading newer ops).
    #[error("op log deserialize error at op index {index}: {source}")]
    Deserialize {
        index: usize,
        #[source]
        source: serde_json::Error,
    },

    /// Wrapped Loro internal error (commit / import / container access).
    /// Surfaces through `#[from]` so call sites that use `?` get automatic
    /// conversion.
    #[error("op log loro error: {0}")]
    Loro(#[from] loro::LoroError),

    /// Wrapped Loro encode error (raised by `LoroDoc::export`). Distinct
    /// from `LoroError` (decode) in Loro 1.12.0's API surface.
    #[error("op log loro encode error: {0}")]
    LoroEncode(#[from] loro::LoroEncodeError),

    /// The op log's internal Loro shape doesn't match what we wrote. Fires
    /// when an imported snapshot was produced by code that wrote a
    /// different container layout (e.g., a future version of this crate).
    #[error("op log schema mismatch: {0}")]
    SchemaMismatch(&'static str),

    /// **Phase 5.5 V2 V4 V1 step 5 audit closure (Codex M1,
    /// 2026-05-21):** the VersionVector passed to a method like
    /// `OpLog::fork_at_vv` is ahead of the current log's
    /// `oplog_vv` (per-peer counter exceeds the local) or
    /// references peers not in the local history. Loro 1.12's
    /// `vv_to_frontiers` internally `.unwrap()`s in this case and
    /// would panic. Pre-validate and surface as this Err variant
    /// instead.
    ///
    /// Reachable only through external callers — internal session
    /// state (`last_flushed_vv`) always comes from this same log's
    /// `oplog_vv` and round-trips correctly.
    #[error("op log invalid version vector: {0}")]
    InvalidVersionVector(String),

    /// **TB6 / Tier C2 follow-up (2026-06-25):** `append` was handed an
    /// `Op::BatchCommit` tree nested deeper than the append ceiling
    /// (`MAX_APPEND_BATCH_DEPTH` in `log.rs`, set strictly below both the
    /// replay-side `MAX_REPLAY_BATCH_DEPTH` and `serde_json`'s ~63-level
    /// round-trip limit). `serde_json::to_string` has no serialize-side
    /// recursion limit, so serializing such an op recurses one stack frame per
    /// nesting level and would overflow the thread's stack *before* the op is
    /// ever stored — and even short of overflow, a batch beyond ~63 levels could
    /// never be read back by `OpLog::iter` (the 128-level *deserialize* limit).
    /// Rejecting here (with a bounded pre-check that cannot itself overflow)
    /// keeps every appended op both overflow-safe and round-trippable. `max` is
    /// the ceiling enforced.
    #[error("op log append rejected: batch nesting too deep (max {max})")]
    BatchDepthExceeded { max: u32 },
}

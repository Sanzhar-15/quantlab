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
}

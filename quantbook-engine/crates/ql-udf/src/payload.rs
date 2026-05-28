//! Typed `CALL` / `RETURN` frame payloads — the correlation + dispatch header that
//! rides in front of the Arrow grid.
//!
//! **6.4-3a audit-fix (`call-return-missing-ids`).** The wire protocol (design §3)
//! specifies `CALL { handle, call_id, args }` and `RETURN { call_id, result }` —
//! NOT a bare Arrow grid. Without `handle` the worker cannot know which registered
//! Python callable to invoke; without `call_id` the engine cannot correlate a
//! response, drop a late result after a deadline/kill, or address a `CANCEL`
//! (contract §6.2 / §10.4 exit test 6). This module defines those payload structures
//! so the contract a real Python worker speaks is pinned NOW, at the protocol layer,
//! rather than retrofitted under the 6.4-3c eval-wiring audit.
//!
//! **On-wire layout** (the [`crate::frame`] envelope wraps these as the `payload`):
//! - `CALL`   payload = `[u64 LE handle][u64 LE call_id][Arrow IPC args grid]`
//! - `RETURN` payload = `[u64 LE call_id][Arrow IPC result grid]`
//!
//! The fixed `u64`-LE header is deliberately trivial (no Arrow, no length prefix —
//! the [`crate::frame`] layer already delimits the whole payload). The grid bytes
//! are produced/consumed by [`crate::codec`], which validates them as a trust
//! boundary. A payload shorter than its header is a loud [`CodecError::ShortHeader`]
//! — never a panic (No-Fallbacks; design §5).
//!
//! The actual correlation MECHANICS (minting `call_id`s, the in-flight table,
//! dropping late results) live in the process-backed worker handle (6.4-3b); this
//! module owns only the on-wire structure + its codec.

use ql_types::ArrayValue;

use crate::codec::{decode_grid, encode_grid, CodecError};

/// Width of a `u64`-LE header field.
const U64: usize = 8;

/// A `CALL` frame's payload: which UDF (`handle`), correlation id (`call_id`), and
/// the evaluated argument grid.
#[derive(Debug, Clone, PartialEq)]
pub struct CallPayload {
    /// Opaque worker-side function id (the `FunctionImplHandle` minted IDE-side).
    pub handle: u64,
    /// Correlates the [`ReturnPayload`] / a `CANCEL`; lets the engine drop a result
    /// that arrives after the deadline (exit test 6).
    pub call_id: u64,
    /// The evaluated UDF arguments as a grid (a scalar is a 1×1 grid).
    pub args: ArrayValue,
}

/// A `RETURN` frame's payload: the `call_id` it answers + the result grid.
#[derive(Debug, Clone, PartialEq)]
pub struct ReturnPayload {
    /// Echoes the originating [`CallPayload::call_id`].
    pub call_id: u64,
    /// The UDF result as a grid (a scalar is a 1×1 grid).
    pub result: ArrayValue,
}

/// Encode a [`CallPayload`] to `CALL`-frame payload bytes.
pub fn encode_call(p: &CallPayload) -> Result<Vec<u8>, CodecError> {
    let grid = encode_grid(&p.args)?;
    let mut buf = Vec::with_capacity(2 * U64 + grid.len());
    buf.extend_from_slice(&p.handle.to_le_bytes());
    buf.extend_from_slice(&p.call_id.to_le_bytes());
    buf.extend_from_slice(&grid);
    Ok(buf)
}

/// Decode `CALL`-frame payload bytes back to a [`CallPayload`].
pub fn decode_call(bytes: &[u8]) -> Result<CallPayload, CodecError> {
    let need = 2 * U64;
    if bytes.len() < need {
        return Err(CodecError::ShortHeader {
            need,
            got: bytes.len(),
        });
    }
    let handle = u64::from_le_bytes(bytes[0..U64].try_into().expect("8 bytes"));
    let call_id = u64::from_le_bytes(bytes[U64..2 * U64].try_into().expect("8 bytes"));
    let args = decode_grid(&bytes[2 * U64..])?;
    Ok(CallPayload {
        handle,
        call_id,
        args,
    })
}

/// Encode a [`ReturnPayload`] to `RETURN`-frame payload bytes.
pub fn encode_return(p: &ReturnPayload) -> Result<Vec<u8>, CodecError> {
    let grid = encode_grid(&p.result)?;
    let mut buf = Vec::with_capacity(U64 + grid.len());
    buf.extend_from_slice(&p.call_id.to_le_bytes());
    buf.extend_from_slice(&grid);
    Ok(buf)
}

/// Decode `RETURN`-frame payload bytes back to a [`ReturnPayload`].
pub fn decode_return(bytes: &[u8]) -> Result<ReturnPayload, CodecError> {
    let need = U64;
    if bytes.len() < need {
        return Err(CodecError::ShortHeader {
            need,
            got: bytes.len(),
        });
    }
    let call_id = u64::from_le_bytes(bytes[0..U64].try_into().expect("8 bytes"));
    let result = decode_grid(&bytes[U64..])?;
    Ok(ReturnPayload { call_id, result })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_types::Value;
    use std::sync::Arc;

    #[test]
    fn call_payload_round_trips_handle_call_id_and_args() {
        let args = ArrayValue::new(
            1,
            2,
            vec![Value::Number(3.0), Value::Text(Arc::from("hi"))],
        )
        .unwrap();
        let p = CallPayload {
            handle: 0xDEAD_BEEF_0000_0007,
            call_id: 42,
            args,
        };
        let bytes = encode_call(&p).unwrap();
        let back = decode_call(&bytes).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn return_payload_round_trips_call_id_and_result() {
        let result = ArrayValue::singleton(Value::Boolean(true));
        let p = ReturnPayload {
            call_id: u64::MAX,
            result,
        };
        let bytes = encode_return(&p).unwrap();
        let back = decode_return(&bytes).unwrap();
        assert_eq!(back, p);
    }

    #[test]
    fn decode_call_rejects_a_truncated_header() {
        // 15 bytes < the 16-byte handle+call_id header.
        let e = decode_call(&[0u8; 15]).unwrap_err();
        assert!(
            matches!(e, CodecError::ShortHeader { need: 16, got: 15 }),
            "got {e:?}"
        );
    }

    #[test]
    fn decode_return_rejects_a_truncated_header() {
        let e = decode_return(&[0u8; 7]).unwrap_err();
        assert!(
            matches!(e, CodecError::ShortHeader { need: 8, got: 7 }),
            "got {e:?}"
        );
    }

    #[test]
    fn decode_call_propagates_a_bad_grid_loudly() {
        // Valid 16-byte header + garbage grid bytes → the codec error surfaces (not a panic).
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&7u64.to_le_bytes());
        bytes.extend_from_slice(&1u64.to_le_bytes());
        bytes.extend_from_slice(b"not arrow ipc");
        assert!(decode_call(&bytes).is_err());
    }
}

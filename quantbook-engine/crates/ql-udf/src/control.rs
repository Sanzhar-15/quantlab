//! Control-frame payload codecs: `HELLO` / `HELLO_ACK` / `RAISE` / `LOG` / `CANCEL`.
//!
//! **6.4-3b.** 6.4-3a defined the [`crate::frame`] envelope + the data-frame
//! ([`crate::payload`]) `CALL`/`RETURN` payloads, and left the CONTROL-frame payload
//! internals deliberately opaque `Vec<u8>` until a real worker pinned the handshake.
//! This module pins them. On-wire layouts (the [`crate::frame`] envelope wraps each
//! as the `payload`):
//!
//! - `HELLO`     (engine→worker): `[u32 LE protocol_version]`
//! - `HELLO_ACK` (worker→engine): `[u32 LE protocol_version][u32 LE worker_pid]`
//! - `RAISE`     (worker→engine): `[u64 LE call_id][u32 LE exc_type_len][exc_type utf8][message utf8…]`
//! - `LOG`       (worker→engine): `[u8 level][message utf8…]`
//! - `CANCEL`    (engine→worker): `[u64 LE call_id]`
//!
//! Every short/garbage payload is a loud [`CodecError`] — never a panic, never a
//! silent default (No-Fallbacks; design §5). All multi-byte integers are
//! little-endian, matching [`crate::frame`] + [`crate::payload`]. Strings are raw
//! UTF-8 (no length prefix on the trailing string, which runs to the payload end).
//!
//! The protocol version the engine speaks. Bumped on any breaking wire change.
//! The worker echoes it in `HELLO_ACK`; a mismatch is a handshake failure.

use crate::codec::CodecError;

/// The wire protocol version the engine and worker must agree on at handshake.
pub const PROTOCOL_VERSION: u32 = 1;

const U32: usize = 4;
const U64: usize = 8;

fn need(bytes: &[u8], n: usize) -> Result<(), CodecError> {
    if bytes.len() < n {
        return Err(CodecError::ShortHeader {
            need: n,
            got: bytes.len(),
        });
    }
    Ok(())
}

fn read_u32_le(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + U32].try_into().expect("4 bytes"))
}

// ---- HELLO ----------------------------------------------------------------

/// Encode a `HELLO` payload (engine→worker): the engine's protocol version.
pub fn encode_hello(protocol_version: u32) -> Vec<u8> {
    protocol_version.to_le_bytes().to_vec()
}

/// Decode a `HELLO` payload → the protocol version.
pub fn decode_hello(bytes: &[u8]) -> Result<u32, CodecError> {
    need(bytes, U32)?;
    Ok(read_u32_le(bytes, 0))
}

// ---- HELLO_ACK ------------------------------------------------------------

/// The worker's handshake acknowledgement: the protocol version it accepts +
/// its OS pid (surfaced to the IDE for debugpy attach at 6.4-3d).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HelloAck {
    pub protocol_version: u32,
    pub worker_pid: u32,
}

/// Encode a `HELLO_ACK` payload (worker→engine).
pub fn encode_hello_ack(ack: &HelloAck) -> Vec<u8> {
    let mut buf = Vec::with_capacity(2 * U32);
    buf.extend_from_slice(&ack.protocol_version.to_le_bytes());
    buf.extend_from_slice(&ack.worker_pid.to_le_bytes());
    buf
}

/// Decode a `HELLO_ACK` payload.
pub fn decode_hello_ack(bytes: &[u8]) -> Result<HelloAck, CodecError> {
    need(bytes, 2 * U32)?;
    Ok(HelloAck {
        protocol_version: read_u32_le(bytes, 0),
        worker_pid: read_u32_le(bytes, U32),
    })
}

// ---- RAISE ----------------------------------------------------------------

/// A Python exception surfaced by the worker (maps to [`crate::UdfError::Raised`]).
/// `call_id` correlates the raise to the originating `CALL` (design §3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Raise {
    pub call_id: u64,
    pub exc_type: String,
    pub message: String,
}

/// Encode a `RAISE` payload (worker→engine).
pub fn encode_raise(raise: &Raise) -> Vec<u8> {
    let et = raise.exc_type.as_bytes();
    let mut buf = Vec::with_capacity(U64 + U32 + et.len() + raise.message.len());
    buf.extend_from_slice(&raise.call_id.to_le_bytes());
    buf.extend_from_slice(&(et.len() as u32).to_le_bytes());
    buf.extend_from_slice(et);
    buf.extend_from_slice(raise.message.as_bytes());
    buf
}

/// Decode a `RAISE` payload. The `exc_type` length-prefix must not exceed the
/// remaining bytes (a lying length is a loud error, not an OOB panic).
pub fn decode_raise(bytes: &[u8]) -> Result<Raise, CodecError> {
    need(bytes, U64 + U32)?;
    let call_id = u64::from_le_bytes(bytes[0..U64].try_into().expect("8 bytes"));
    let et_len = read_u32_le(bytes, U64) as usize;
    let after_len = &bytes[U64 + U32..];
    if after_len.len() < et_len {
        return Err(CodecError::ShortHeader {
            need: U64 + U32 + et_len,
            got: bytes.len(),
        });
    }
    let exc_type = std::str::from_utf8(&after_len[..et_len])
        .map_err(|_| CodecError::BadUtf8 { field: "exc_type" })?
        .to_string();
    let message = std::str::from_utf8(&after_len[et_len..])
        .map_err(|_| CodecError::BadUtf8 { field: "message" })?
        .to_string();
    Ok(Raise {
        call_id,
        exc_type,
        message,
    })
}

// ---- LOG ------------------------------------------------------------------

/// A worker log line (stdout/stderr passthrough), surfaced as a diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Log {
    pub level: u8,
    pub message: String,
}

/// Encode a `LOG` payload (worker→engine).
pub fn encode_log(log: &Log) -> Vec<u8> {
    let mut buf = Vec::with_capacity(1 + log.message.len());
    buf.push(log.level);
    buf.extend_from_slice(log.message.as_bytes());
    buf
}

/// Decode a `LOG` payload.
pub fn decode_log(bytes: &[u8]) -> Result<Log, CodecError> {
    need(bytes, 1)?;
    let level = bytes[0];
    let message = std::str::from_utf8(&bytes[1..])
        .map_err(|_| CodecError::BadUtf8 { field: "log message" })?
        .to_string();
    Ok(Log { level, message })
}

// ---- CANCEL ---------------------------------------------------------------

/// Encode a `CANCEL` payload (engine→worker): the `call_id` to cancel.
pub fn encode_cancel(call_id: u64) -> Vec<u8> {
    call_id.to_le_bytes().to_vec()
}

/// Decode a `CANCEL` payload → the `call_id`.
pub fn decode_cancel(bytes: &[u8]) -> Result<u64, CodecError> {
    need(bytes, U64)?;
    Ok(u64::from_le_bytes(bytes[0..U64].try_into().expect("8 bytes")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_round_trips() {
        let bytes = encode_hello(PROTOCOL_VERSION);
        assert_eq!(decode_hello(&bytes).unwrap(), PROTOCOL_VERSION);
    }

    #[test]
    fn hello_ack_round_trips() {
        let ack = HelloAck {
            protocol_version: 1,
            worker_pid: 4242,
        };
        assert_eq!(decode_hello_ack(&encode_hello_ack(&ack)).unwrap(), ack);
    }

    #[test]
    fn raise_round_trips_including_empty_and_unicode() {
        for r in [
            Raise {
                call_id: 5,
                exc_type: "ValueError".into(),
                message: "boom".into(),
            },
            Raise {
                call_id: 0,
                exc_type: "".into(),
                message: "".into(),
            },
            Raise {
                call_id: u64::MAX,
                exc_type: "KeyError".into(),
                message: "naïve λ message with : colons".into(),
            },
        ] {
            assert_eq!(decode_raise(&encode_raise(&r)).unwrap(), r);
        }
    }

    #[test]
    fn log_round_trips() {
        let log = Log {
            level: 3,
            message: "a warning".into(),
        };
        assert_eq!(decode_log(&encode_log(&log)).unwrap(), log);
    }

    #[test]
    fn cancel_round_trips() {
        let bytes = encode_cancel(u64::MAX);
        assert_eq!(decode_cancel(&bytes).unwrap(), u64::MAX);
    }

    #[test]
    fn short_payloads_are_loud_not_panics() {
        assert!(matches!(
            decode_hello(&[1, 2]).unwrap_err(),
            CodecError::ShortHeader { need: 4, got: 2 }
        ));
        assert!(matches!(
            decode_hello_ack(&[0u8; 7]).unwrap_err(),
            CodecError::ShortHeader { need: 8, got: 7 }
        ));
        assert!(matches!(
            decode_cancel(&[0u8; 3]).unwrap_err(),
            CodecError::ShortHeader { need: 8, got: 3 }
        ));
        // RAISE shorter than its call_id + exc_type-len header.
        assert!(matches!(
            decode_raise(&[1, 2]).unwrap_err(),
            CodecError::ShortHeader { .. }
        ));
        // LOG with an empty payload (need the level byte).
        assert!(matches!(
            decode_log(&[]).unwrap_err(),
            CodecError::ShortHeader { need: 1, got: 0 }
        ));
    }

    #[test]
    fn raise_with_lying_exc_type_length_is_loud() {
        // call_id (8) + claim exc_type is 100 bytes but provide only 2 → ShortHeader, not OOB panic.
        let mut bytes = 1u64.to_le_bytes().to_vec();
        bytes.extend_from_slice(&(100u32).to_le_bytes());
        bytes.extend_from_slice(b"ab");
        assert!(matches!(
            decode_raise(&bytes).unwrap_err(),
            CodecError::ShortHeader { .. }
        ));
    }

    #[test]
    fn raise_rejects_invalid_utf8() {
        // call_id (8) + exc_type_len = 2, then two invalid-UTF-8 bytes.
        let mut bytes = 1u64.to_le_bytes().to_vec();
        bytes.extend_from_slice(&(2u32).to_le_bytes());
        bytes.extend_from_slice(&[0xFF, 0xFE]);
        assert!(matches!(
            decode_raise(&bytes).unwrap_err(),
            CodecError::BadUtf8 { field: "exc_type" }
        ));
    }
}

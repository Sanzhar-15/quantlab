//! The UDF wire envelope: `[u32 LE total_len][u8 frame_type][payload…]`.
//!
//! **6.4-3a.** `total_len` counts the type byte + payload (so a frame with an
//! empty payload is `total_len == 1`). The payload bytes are **opaque at this
//! layer**: for [`FrameType::Call`] / [`FrameType::Return`] they are the Arrow
//! IPC stream from [`crate::codec`]; for the control frames
//! ([`FrameType::Hello`] / `HelloAck` / `Raise` / `Cancel` / `Log`) the internal
//! field encoding is intentionally deferred to 6.4-3b (where the real worker
//! handshake pins it). This module owns only the framing + the type tag, so the
//! transport is exercisable and round-trip-tested now.

use std::io::{Read, Write};

/// Discriminates the kind of a [`Frame`]. The `u8` tag is stable wire identity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameType {
    /// Worker→? handshake request (protocol version, capabilities).
    Hello = 1,
    /// ?→worker handshake ack (worker pid for debugpy, accepted version).
    HelloAck = 2,
    /// Engine→worker: one UDF invocation. Payload = Arrow IPC args grid.
    Call = 3,
    /// Worker→engine: success. Payload = Arrow IPC result grid.
    Return = 4,
    /// Worker→engine: the Python callable raised. Payload = error detail.
    Raise = 5,
    /// Engine→worker: cooperative cancel of an in-flight call.
    Cancel = 6,
    /// Worker→engine: a log line (stdout/stderr passthrough), surfaced as a diagnostic.
    Log = 7,
}

impl FrameType {
    fn from_u8(b: u8) -> Option<Self> {
        match b {
            1 => Some(FrameType::Hello),
            2 => Some(FrameType::HelloAck),
            3 => Some(FrameType::Call),
            4 => Some(FrameType::Return),
            5 => Some(FrameType::Raise),
            6 => Some(FrameType::Cancel),
            7 => Some(FrameType::Log),
            _ => None,
        }
    }
}

/// A single framed message: a [`FrameType`] tag plus an opaque payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub frame_type: FrameType,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(frame_type: FrameType, payload: Vec<u8>) -> Self {
        Self {
            frame_type,
            payload,
        }
    }
}

/// Errors framing/deframing can produce. Loud — a malformed frame is never
/// silently skipped (No-Fallbacks).
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("frame io: {0}")]
    Io(#[from] std::io::Error),
    /// The declared length was zero — there is no room even for the type byte.
    #[error("frame: zero-length frame (need at least the 1-byte type tag)")]
    ZeroLength,
    /// The type byte was not a known [`FrameType`].
    #[error("frame: unknown frame type tag {0}")]
    UnknownType(u8),
    /// A frame payload exceeded the sanity cap.
    #[error("frame: length {0} exceeds the {MAX_FRAME_LEN}-byte cap")]
    TooLarge(u32),
}

/// Sanity cap on a single frame (64 MiB). A larger declared length is rejected
/// rather than used to allocate — defends the reader against a corrupt/hostile
/// length prefix.
pub const MAX_FRAME_LEN: u32 = 64 * 1024 * 1024;

/// Write one frame: `[u32 LE (1 + payload.len())][type][payload]`.
pub fn write_frame<W: Write>(w: &mut W, frame: &Frame) -> Result<(), FrameError> {
    let total = 1u64 + frame.payload.len() as u64;
    if total > u64::from(MAX_FRAME_LEN) {
        return Err(FrameError::TooLarge(MAX_FRAME_LEN));
    }
    let total = total as u32;
    w.write_all(&total.to_le_bytes())?;
    w.write_all(&[frame.frame_type as u8])?;
    w.write_all(&frame.payload)?;
    Ok(())
}

/// Read one frame. Returns `Ok(None)` on a clean EOF *before any bytes of the
/// length prefix* (the stream ended between frames); any other short read is a
/// loud error.
pub fn read_frame<R: Read>(r: &mut R) -> Result<Option<Frame>, FrameError> {
    let mut len_buf = [0u8; 4];
    match read_exact_or_eof(r, &mut len_buf)? {
        ReadOutcome::Eof => return Ok(None),
        ReadOutcome::Filled => {}
    }
    let total = u32::from_le_bytes(len_buf);
    if total == 0 {
        return Err(FrameError::ZeroLength);
    }
    if total > MAX_FRAME_LEN {
        return Err(FrameError::TooLarge(total));
    }
    let mut type_buf = [0u8; 1];
    r.read_exact(&mut type_buf)?;
    let frame_type = FrameType::from_u8(type_buf[0]).ok_or(FrameError::UnknownType(type_buf[0]))?;
    let payload_len = (total - 1) as usize;
    let mut payload = vec![0u8; payload_len];
    r.read_exact(&mut payload)?;
    Ok(Some(Frame {
        frame_type,
        payload,
    }))
}

enum ReadOutcome {
    Filled,
    Eof,
}

/// Like `read_exact`, but distinguishes a clean EOF *before the first byte* (the
/// stream ended between frames — a normal shutdown) from a partial read (a torn
/// frame — an error).
fn read_exact_or_eof<R: Read>(r: &mut R, buf: &mut [u8]) -> Result<ReadOutcome, FrameError> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => {
                if filled == 0 {
                    return Ok(ReadOutcome::Eof);
                }
                return Err(FrameError::Io(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "torn length prefix",
                )));
            }
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(FrameError::Io(e)),
        }
    }
    Ok(ReadOutcome::Filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trips_through_a_byte_buffer() {
        let frames = vec![
            Frame::new(FrameType::Hello, vec![1, 2, 3]),
            Frame::new(FrameType::Call, vec![0u8; 1000]),
            Frame::new(FrameType::Cancel, vec![]), // empty payload → total_len == 1
            Frame::new(FrameType::Return, vec![255, 0, 128]),
            Frame::new(FrameType::Log, b"a warning".to_vec()),
        ];
        let mut buf = Vec::new();
        for f in &frames {
            write_frame(&mut buf, f).unwrap();
        }
        let mut cursor = std::io::Cursor::new(buf);
        let mut got = Vec::new();
        while let Some(f) = read_frame(&mut cursor).unwrap() {
            got.push(f);
        }
        assert_eq!(got, frames);
    }

    #[test]
    fn read_returns_none_on_clean_eof_between_frames() {
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        assert_eq!(read_frame(&mut cursor).unwrap(), None);
    }

    #[test]
    fn read_rejects_unknown_type_tag() {
        // total_len = 1 (just the type byte), type = 99 (unknown).
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.push(99);
        let mut cursor = std::io::Cursor::new(bytes);
        let e = read_frame(&mut cursor).unwrap_err();
        assert!(matches!(e, FrameError::UnknownType(99)), "got {e:?}");
    }

    #[test]
    fn read_rejects_zero_length_frame() {
        let mut cursor = std::io::Cursor::new(0u32.to_le_bytes().to_vec());
        let e = read_frame(&mut cursor).unwrap_err();
        assert!(matches!(e, FrameError::ZeroLength), "got {e:?}");
    }

    #[test]
    fn read_rejects_oversized_length_without_allocating() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(MAX_FRAME_LEN + 1).to_le_bytes());
        let mut cursor = std::io::Cursor::new(bytes);
        let e = read_frame(&mut cursor).unwrap_err();
        assert!(matches!(e, FrameError::TooLarge(_)), "got {e:?}");
    }

    #[test]
    fn torn_length_prefix_is_an_error_not_eof() {
        // Two bytes then EOF — a partial length prefix is a torn frame, not a
        // clean between-frames shutdown.
        let mut cursor = std::io::Cursor::new(vec![1u8, 0u8]);
        let e = read_frame(&mut cursor).unwrap_err();
        assert!(matches!(e, FrameError::Io(_)), "got {e:?}");
    }
}

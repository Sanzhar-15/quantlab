//! `ql-udf` — out-of-process Python UDF worker transport + codec.
//!
//! **Phase 6.4-3 (the wedge).** Design: `docs/phase6/6-4-3-design.md`. This crate
//! owns the *mechanics* of talking to a managed Python worker process: the wire
//! protocol (length-prefixed frames), the Arrow ↔ engine-`Value` codec, and the
//! [`UdfWorker`] abstraction. It is a **leaf** (dependency-inversion, mirroring
//! `ql-io-csv` / `ql-io-xlsx`): it depends only on `ql-types`, `arrow`, and
//! `thiserror`, and is consumed by `ql-exec` at the dispatch site (6.4-3c), which
//! adapts `FunctionArg`/`FunctionReturn` ↔ [`ql_types::ArrayValue`] and injects a
//! worker into the eval context.
//!
//! **6.4-3a scope (this cycle — Rust-only, no Python, no subprocess):**
//! - [`codec`] — `ArrayValue` ⇄ Arrow IPC stream bytes (the "fiddly part", with
//!   round-trip property tests over every `Value` variant).
//! - [`frame`] — the `[u32 LE len][u8 type][payload]` envelope + [`frame::FrameType`].
//! - [`worker`] — the [`worker::UdfWorker`] trait + an in-process
//!   [`worker::MockWorker`] (proves call / raise / timeout mapping without a
//!   subprocess) + the [`worker::UdfError`] taxonomy.
//!
//! **Deliberately deferred** (later 6.4-3 cycles): real subprocess spawn /
//! handshake / kill (6.4-3b); the eval-site `RegisteredFn::Udf` dispatch arm
//! (6.4-3c); debugpy + trusted-workspace gating (6.4-3d). The control-frame
//! payload internals (Hello/Raise/Log field encodings) are intentionally opaque
//! `Vec<u8>` at this layer until 6.4-3b pins the worker handshake.
//!
//! The on-wire batch format is Arrow IPC (chosen so the Python side uses
//! `pyarrow` natively); the [`codec`] boundary keeps it swappable.

pub mod codec;
pub mod frame;
pub mod worker;

pub use frame::{Frame, FrameType};
pub use worker::{MockWorker, UdfError, UdfWorker};

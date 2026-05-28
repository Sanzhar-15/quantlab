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
//! **Modules:**
//! - [`codec`] — `ArrayValue` ⇄ Arrow IPC stream bytes (the "fiddly part"). The
//!   decoder is a trust boundary for worker-controlled bytes: it validates the exact
//!   schema and rejects null/non-finite/short-column/reordered/trailing-batch input
//!   loudly, never panicking (6.4-3a + its audit-fix).
//! - [`frame`] — the `[u32 LE len][u8 type][payload]` envelope + [`frame::FrameType`].
//! - [`payload`] — the typed `CALL` / `RETURN` data payloads ([`payload::CallPayload`]
//!   `{ handle, call_id, args }` / [`payload::ReturnPayload`] `{ call_id, result }`).
//! - [`control`] — the `HELLO` / `HELLO_ACK` / `RAISE` / `LOG` / `CANCEL` control-frame
//!   payload codecs + [`control::PROTOCOL_VERSION`] (6.4-3b pinned these; 6.4-3a left
//!   them opaque).
//! - [`worker`] — the [`worker::UdfWorker`] trait + the [`worker::UdfError`] taxonomy
//!   + an in-process [`worker::MockWorker`] (test double).
//! - [`process`] — [`process::ProcessWorker`]: the real, process-backed worker
//!   (6.4-3b) that spawns `python -m quantbook.worker`, handshakes, calls, and
//!   timeout-kills/respawns. Implements [`UdfWorker`].
//!
//! It is a **leaf** (dependency-inversion, mirroring `ql-io-csv` / `ql-io-xlsx`):
//! depends only on `ql-types`, `arrow`, `thiserror`, and `std`. `ql-exec` will consume
//! it at the dispatch site (6.4-3c), adapting `FunctionArg`/`FunctionReturn` ↔
//! [`ql_types::ArrayValue`] and injecting a worker into the eval context.
//!
//! **Deferred** to later 6.4-3 cycles: the eval-site `RegisteredFn::Udf` dispatch arm
//! (6.4-3c); debugpy attach + trusted-workspace gating + IDE handle-minting +
//! `LOG`→`CellDiagnostic` routing (6.4-3d). The on-wire batch format is Arrow IPC
//! (so the Python side uses `pyarrow` natively); the [`codec`] boundary keeps it
//! swappable. The Python worker lives in `crates/quantbook-py/python/quantbook/`.

pub mod codec;
pub mod control;
pub mod frame;
pub mod payload;
pub mod process;
pub mod worker;

pub use frame::{Frame, FrameType};
pub use payload::{CallPayload, ReturnPayload};
pub use process::{ProcessWorker, PythonWorkerConfig};
pub use worker::{MockWorker, UdfError, UdfWorker};

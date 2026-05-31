//! `ql-service` -- Phase 6.2 local engine-as-service (HTTP+SSE transport).
//!
//! A long-running service exposing the **frozen** `EngineSession` contract
//! (6.3-5 FROZEN v1) over HTTP for the IDE / web frontends. It is the THIRD
//! consumer of the contract after the napi (`ql-bindings-node`) and pyo3
//! (`quantbook-py`) binding rows, and reproduces the SAME wire DTO shapes
//! (camelCase keys, u64 as decimal strings, structured `problem+json` errors).
//! This is a pure transport layer -- NO engine logic lives here.
//!
//! **Wire parity caveat:** the DTO *shapes* are byte-identical to the napi row,
//! with ONE documented, 6.2-4-deferred number-encoding divergence -- integer-
//! valued `f64` `number` fields render `6.0` (serde) vs `6` (napi
//! `JSON.stringify`); see [`wire::CellValueWire`] for the full scope and the
//! 6.2-4 resolution.
//!
//! **Shipped so far:** 6.2-0 (crate foundation + golden-flow endpoint set proving
//! SVC-6-01: open/edit/recalc/snapshot over HTTP on `hyper`); 6.2-1a (cluster A
//! read/format/validate/query and cluster B persistence); 6.2-1b (cluster C
//! structure/sheets and cluster D tables). Remaining: 6.2-1c (atomic/txn,
//! reserved bulk, undo/delta, functions); SSE event streaming (SVC-6-02); op-id
//! cancellation (SVC-6-03); auth hooks, protocol versioning, and lifecycle/TTL
//! hardening (SVC-6-04 / 6.2-3); the golden-parity third row (6.2-4).
//!
//! Transport: HTTP/1.1 on `hyper` 1.x (`http1::Builder::serve_connection`), one
//! tokio task per connection, `hyper_util::rt::TokioIo` adapting the tokio
//! `TcpStream`. The version prefix is `/v1` (SVC-6-04).

use std::net::SocketAddr;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

pub mod error;
pub mod guarded;
mod router;
pub mod session_store;
pub mod wire;

pub use session_store::SessionStore;

/// Serve HTTP on an already-bound [`TcpListener`] until an `accept()` error.
///
/// The caller binds the listener (so tests can use `127.0.0.1:0` and read the
/// assigned port via [`TcpListener::local_addr`] before spawning this). Each
/// accepted connection is driven on its own tokio task; a per-connection serve
/// error is logged to stderr and does not stop the accept loop.
pub async fn serve(listener: TcpListener, store: SessionStore) -> std::io::Result<()> {
    loop {
        let (stream, _peer) = listener.accept().await?;
        let io = TokioIo::new(stream);
        let store = store.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req| {
                let store = store.clone();
                async move { Ok::<_, std::convert::Infallible>(router::handle(req, store).await) }
            });
            if let Err(err) = http1::Builder::new().serve_connection(io, service).await {
                eprintln!("ql-service: connection error: {err}");
            }
        });
    }
}

/// Bind `addr` and [`serve`] on it (the binary entry point). Returns the bind
/// error loudly if the address is unavailable.
pub async fn bind_and_serve(addr: SocketAddr, store: SessionStore) -> std::io::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    eprintln!("ql-service: listening on http://{addr}/v1");
    serve(listener, store).await
}

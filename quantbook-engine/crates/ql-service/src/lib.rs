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
//! structure/sheets and cluster D tables); 6.2-1c (cluster E atomic/transactions,
//! the reserved sec-3.5 bulk methods as `not_implemented_in_v1_core` Capability
//! stubs, undo/redo, `snapshotDelta` -- the first `version`-consuming endpoint --
//! and function register/unregister/list) -- which COMPLETES 6.2-1; 6.2-2 (the
//! operations/events surface: the M2 split-recalc `startRecalc`/`awaitRecalc`,
//! op-id `cancel`/`operationStatus`, `pollEvents`, and the SVC-6-02 long-lived
//! `text/event-stream` events endpoint forwarding the engine event ring); 6.2-3a
//! (request-path hardening: a request-body size cap on both the JSON and raw-blob
//! paths, `schemaVersion` echo + mismatch rejection, and RFC-correct 405 + `Allow`);
//! 6.2-3b (identity/lifecycle: a pluggable auth hook -- default no-op + a bearer-token
//! stub -- unguessable CSPRNG session ids, and idle-TTL session reaping via a
//! background task). Remaining: the golden-parity third row (6.2-4).
//!
//! Transport: HTTP/1.1 on `hyper` 1.x (`http1::Builder::serve_connection`), one
//! tokio task per connection, `hyper_util::rt::TokioIo` adapting the tokio
//! `TcpStream`. The version prefix is `/v1` (SVC-6-04).

use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

pub mod auth;
pub mod error;
pub mod guarded;
mod router;
pub mod session_store;
pub mod wire;

pub use auth::{AuthReject, Authorizer, BearerToken, NoAuth};
pub use session_store::SessionStore;

/// Service-level configuration (transport hardening knobs). Cheap to `Clone` --
/// one is cloned into every connection task. 6.2-3a carries the request-body size
/// caps; 6.2-3b will extend it with the auth hook + idle-TTL.
#[derive(Clone)]
pub struct ServiceConfig {
    /// Max bytes accepted for a JSON request body (every endpoint except `import`).
    /// Over-limit -> `413 payload_too_large` (No-Fallbacks: a loud cap, never a
    /// silent truncation). A bound against unbounded memory, not a policy limit.
    pub max_json_body_bytes: usize,
    /// Max bytes accepted for the raw `import` blob body (`.qbook`/xlsx/csv).
    pub max_blob_body_bytes: usize,
    /// 6.2-3b: per-request authorization gate. Default [`NoAuth`] (open localhost --
    /// the documented v1 posture); a [`BearerToken`] gates on a shared secret.
    pub auth: Arc<dyn Authorizer>,
    /// 6.2-3b: idle-session TTL. `Some(ttl)` spawns a background reaper in
    /// [`serve_with_config`] that evicts sessions idle longer than `ttl` (an in-use
    /// session -- one with an in-flight request, or an SSE stream mid-poll -- is never
    /// reaped); `None` (default) disables reaping (sessions live until `DELETE` or
    /// process exit). Set `ttl` in seconds, comfortably above the internal SSE poll
    /// interval (~250ms), so an idle-but-streaming session stays warm between polls;
    /// sub-second TTLs are not a supported configuration.
    pub idle_ttl: Option<Duration>,
}

impl Default for ServiceConfig {
    fn default() -> Self {
        Self {
            max_json_body_bytes: 16 * 1024 * 1024,
            max_blob_body_bytes: 512 * 1024 * 1024,
            auth: Arc::new(NoAuth),
            idle_ttl: None,
        }
    }
}

// Manual `Debug` (the `Arc<dyn Authorizer>` field is not `Debug`). The authorizer is
// rendered opaquely -- NEVER print a bearer secret into logs.
impl fmt::Debug for ServiceConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServiceConfig")
            .field("max_json_body_bytes", &self.max_json_body_bytes)
            .field("max_blob_body_bytes", &self.max_blob_body_bytes)
            .field("auth", &"<authorizer>")
            .field("idle_ttl", &self.idle_ttl)
            .finish()
    }
}

/// Serve HTTP on an already-bound [`TcpListener`] with the default
/// [`ServiceConfig`]. Back-compat entry point (used by the integration tests).
pub async fn serve(listener: TcpListener, store: SessionStore) -> std::io::Result<()> {
    serve_with_config(listener, store, ServiceConfig::default()).await
}

/// Serve HTTP on an already-bound [`TcpListener`] until an `accept()` error,
/// applying `cfg` (the request-body caps) to every connection.
///
/// The caller binds the listener (so tests can use `127.0.0.1:0` and read the
/// assigned port via [`TcpListener::local_addr`] before spawning this). Each
/// accepted connection is driven on its own tokio task; a per-connection serve
/// error is logged to stderr and does not stop the accept loop.
pub async fn serve_with_config(
    listener: TcpListener,
    store: SessionStore,
    cfg: ServiceConfig,
) -> std::io::Result<()> {
    // 6.2-3b: spawn the idle-session reaper when an idle-TTL is configured. It sweeps
    // on an interval (ttl/2, clamped) and lives for the process; with no TTL (the
    // default) NO task is spawned -- back-compat + determinism for the existing tests.
    if let Some(ttl) = cfg.idle_ttl {
        let weak = store.downgrade();
        let interval = reaper_interval(ttl);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                // A Weak handle: once the serving task drops its `SessionStore`,
                // `upgrade` returns None and the reaper ends -- it never keeps sessions
                // alive past the service's lifetime (audit LOW).
                match weak.upgrade() {
                    Some(store) => {
                        store.reap_idle(ttl);
                    }
                    None => break,
                }
            }
        });
    }
    loop {
        let (stream, _peer) = listener.accept().await?;
        let io = TokioIo::new(stream);
        let store = store.clone();
        let cfg = cfg.clone();
        tokio::spawn(async move {
            let service = service_fn(move |req| {
                let store = store.clone();
                let cfg = cfg.clone();
                async move { Ok::<_, std::convert::Infallible>(router::handle(req, store, cfg).await) }
            });
            if let Err(err) = http1::Builder::new().serve_connection(io, service).await {
                eprintln!("ql-service: connection error: {err}");
            }
        });
    }
}

/// The reaper sweep interval for a given idle-TTL: `ttl/2` clamped to [50ms, 30s] --
/// frequent enough to evict promptly (and be observable in tests) without busy-looping.
fn reaper_interval(ttl: Duration) -> Duration {
    (ttl / 2).clamp(Duration::from_millis(50), Duration::from_secs(30))
}

/// Bind `addr` and [`serve_with_config`] on it (the binary entry point). Returns
/// the bind error loudly if the address is unavailable.
pub async fn bind_and_serve(
    addr: SocketAddr,
    store: SessionStore,
    cfg: ServiceConfig,
) -> std::io::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    eprintln!("ql-service: listening on http://{addr}/v1");
    serve_with_config(listener, store, cfg).await
}

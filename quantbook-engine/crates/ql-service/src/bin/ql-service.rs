//! Phase 6.2-0 (2026-06-01) -- `ql-service` binary entry point.
//!
//! Binds `127.0.0.1:$QL_SERVICE_PORT` (default 7321) and serves the engine over
//! HTTP/1.1 + (later) SSE. Ctrl-C triggers a clean shutdown of the accept loop.
//!
//!   QL_SERVICE_PORT=7321 cargo run -p ql-service --bin ql-service

use std::io;
use std::net::SocketAddr;

use ql_service::{bind_and_serve, SessionStore};

#[tokio::main]
async fn main() -> io::Result<()> {
    // A SET-but-unparseable port is a loud error (No-Fallbacks); only a genuinely
    // unset var uses the documented default.
    let port: u16 = match std::env::var("QL_SERVICE_PORT") {
        Ok(s) => s.parse().map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("QL_SERVICE_PORT is set but invalid ({s:?}): {e}"),
            )
        })?,
        Err(_) => 7321,
    };
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let store = SessionStore::new();

    tokio::select! {
        r = bind_and_serve(addr, store) => r,
        _ = tokio::signal::ctrl_c() => {
            eprintln!("ql-service: received Ctrl-C, shutting down");
            Ok(())
        }
    }
}

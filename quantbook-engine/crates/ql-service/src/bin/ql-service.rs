//! Phase 6.2-0 (2026-06-01) -- `ql-service` binary entry point.
//!
//! Binds `127.0.0.1:$QL_SERVICE_PORT` (default 7321) and serves the engine over
//! HTTP/1.1 + (later) SSE. Ctrl-C triggers a clean shutdown of the accept loop.
//!
//!   QL_SERVICE_PORT=7321 cargo run -p ql-service --bin ql-service

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use ql_service::{bind_and_serve, Authorizer, BearerToken, NoAuth, ServiceConfig, SessionStore};

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
    let cfg = service_config_from_env()?;

    tokio::select! {
        r = bind_and_serve(addr, store, cfg) => r,
        _ = tokio::signal::ctrl_c() => {
            eprintln!("ql-service: received Ctrl-C, shutting down");
            Ok(())
        }
    }
}

/// Build the [`ServiceConfig`] from optional env overrides. Unset -> the documented
/// default; SET-but-unparseable -> a loud error (No-Fallbacks), mirroring the port.
fn service_config_from_env() -> io::Result<ServiceConfig> {
    let d = ServiceConfig::default();
    Ok(ServiceConfig {
        max_json_body_bytes: env_usize("QL_SERVICE_MAX_JSON_BYTES", d.max_json_body_bytes)?,
        max_blob_body_bytes: env_usize("QL_SERVICE_MAX_BLOB_BYTES", d.max_blob_body_bytes)?,
        auth: auth_from_env()?,
        idle_ttl: idle_ttl_from_env()?,
    })
}

/// `QL_SERVICE_BEARER_TOKEN`: unset -> open (NoAuth); set+non-empty -> a bearer gate;
/// set+empty -> loud error (No-Fallbacks: an empty secret would accept all bearers);
/// set+non-Unicode -> loud error.
fn auth_from_env() -> io::Result<Arc<dyn Authorizer>> {
    match std::env::var("QL_SERVICE_BEARER_TOKEN") {
        Ok(t) if !t.trim().is_empty() => Ok(Arc::new(BearerToken::new(t))),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "QL_SERVICE_BEARER_TOKEN is set but empty or all-whitespace",
        )),
        Err(std::env::VarError::NotPresent) => Ok(Arc::new(NoAuth)),
        // Redacted: do NOT format the VarError -- `NotUnicode` embeds the offending
        // value (the secret) in its `Display` (audit MED: secret leakage).
        Err(std::env::VarError::NotUnicode(_)) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "QL_SERVICE_BEARER_TOKEN is set but not valid Unicode",
        )),
    }
}

/// `QL_SERVICE_IDLE_TTL_SECS`: unset -> None (no reaper); set+valid (>0) -> Some(ttl);
/// set+invalid/zero/non-Unicode -> loud error.
fn idle_ttl_from_env() -> io::Result<Option<Duration>> {
    match std::env::var("QL_SERVICE_IDLE_TTL_SECS") {
        Ok(s) => {
            let secs: u64 = s.parse().map_err(|e| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("QL_SERVICE_IDLE_TTL_SECS is set but invalid ({s:?}): {e}"),
                )
            })?;
            if secs == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "QL_SERVICE_IDLE_TTL_SECS must be > 0",
                ));
            }
            Ok(Some(Duration::from_secs(secs)))
        }
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(e @ std::env::VarError::NotUnicode(_)) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("QL_SERVICE_IDLE_TTL_SECS is set but not valid Unicode: {e}"),
        )),
    }
}

/// Read an optional `usize` env override (set-but-invalid -> loud error).
fn env_usize(key: &str, default: usize) -> io::Result<usize> {
    match std::env::var(key) {
        Ok(s) => s.parse().map_err(|e| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{key} is set but invalid ({s:?}): {e}"),
            )
        }),
        // Only a genuinely-unset var uses the default (No-Fallbacks): a SET-but-
        // non-Unicode value is a loud error, never a silent fallback to default.
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(e @ std::env::VarError::NotUnicode(_)) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{key} is set but not valid Unicode: {e}"),
        )),
    }
}

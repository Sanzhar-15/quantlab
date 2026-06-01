//! Phase 6.2-3b (2026-06-01) -- identity / lifecycle hardening over real HTTP.
//!
//! Drives the running service to prove: (1) the pluggable auth gate (BearerToken
//! stub) rejects missing/wrong tokens with 401 + WWW-Authenticate + Connection:close
//! and admits the correct token, while the default (NoAuth) config is unchanged;
//! (2) session ids are unguessable 32-char hex (not the old sequential s<n>);
//! (3) idle sessions are reaped by the background reaper, while an actively-touched
//! session is kept warm.
//!
//! Self-contained hand-rolled HTTP/1.1 client (Connection: close) that can set
//! arbitrary request headers -- the shared golden client cannot, and this file must
//! not perturb it.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use ql_service::{serve_with_config, BearerToken, ServiceConfig, SessionStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Spawn the service with `cfg` on an ephemeral port; return its addr.
async fn spawn(cfg: ServiceConfig) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("local_addr");
    tokio::spawn(async move { serve_with_config(listener, SessionStore::new(), cfg).await });
    addr
}

/// One request over a fresh Connection: close socket. Returns
/// (status, lowercased-header-map, body).
async fn req(
    addr: SocketAddr,
    method: &str,
    path: &str,
    body: Option<&str>,
    headers: &[(&str, &str)],
) -> (u16, HashMap<String, String>, String) {
    let body = body.unwrap_or("");
    let mut raw = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (k, v) in headers {
        raw.push_str(&format!("{k}: {v}\r\n"));
    }
    raw.push_str("\r\n");
    raw.push_str(body);

    let mut stream = TcpStream::connect(addr).await.expect("connect");
    stream.write_all(raw.as_bytes()).await.expect("write");
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.expect("read");
    let text = String::from_utf8_lossy(&buf).into_owned();

    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
    let mut lines = head.lines();
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .expect("status line");
    let mut hmap = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(": ") {
            hmap.insert(k.to_ascii_lowercase(), v.trim().to_string());
        }
    }
    (status, hmap, body.to_string())
}

/// Extract `"sessionId":"<id>"` from a create-session response body.
fn session_id(body: &str) -> String {
    let key = "\"sessionId\":\"";
    let start = body.find(key).expect("sessionId in body") + key.len();
    let rest = &body[start..];
    let end = rest.find('"').expect("closing quote");
    rest[..end].to_string()
}

/// Extract `"code":"<code>"` from a problem+json body.
fn code(body: &str) -> String {
    let key = "\"code\":\"";
    let start = body.find(key).expect("code in body") + key.len();
    let rest = &body[start..];
    let end = rest.find('"').expect("closing quote");
    rest[..end].to_string()
}

#[tokio::test]
async fn bearer_auth_gates_requests() {
    let addr = spawn(ServiceConfig {
        auth: Arc::new(BearerToken::new("s3cret-token")),
        ..ServiceConfig::default()
    })
    .await;

    // No Authorization -> 401 + WWW-Authenticate: Bearer + Connection: close.
    let (st, h, b) = req(addr, "POST", "/v1/sessions", None, &[]).await;
    assert_eq!(st, 401, "missing token -> 401: {b}");
    assert_eq!(code(&b), "unauthorized", "{b}");
    assert_eq!(
        h.get("www-authenticate").map(String::as_str),
        Some("Bearer"),
        "401 carries the challenge: {h:?}"
    );
    assert_eq!(
        h.get("connection").map(|s| s.to_ascii_lowercase()),
        Some("close".to_string()),
        "unauthorized socket is closed: {h:?}"
    );
    // The version is still advertised even on a reject.
    assert_eq!(h.get("x-ql-schema-version").map(String::as_str), Some("1"));

    // Wrong token -> 401.
    let (st, _h, _b) = req(
        addr,
        "POST",
        "/v1/sessions",
        None,
        &[("Authorization", "Bearer wrong")],
    )
    .await;
    assert_eq!(st, 401, "wrong token -> 401");

    // Correct token -> 201 create.
    let (st, _h, b) = req(
        addr,
        "POST",
        "/v1/sessions",
        None,
        &[("Authorization", "Bearer s3cret-token")],
    )
    .await;
    assert_eq!(st, 201, "correct token -> 201: {b}");
}

#[tokio::test]
async fn default_config_requires_no_auth() {
    // Back-compat: the default (NoAuth) config admits a request with no Authorization.
    let addr = spawn(ServiceConfig::default()).await;
    let (st, _h, b) = req(addr, "POST", "/v1/sessions", None, &[]).await;
    assert_eq!(st, 201, "NoAuth admits unauthenticated create: {b}");
}

#[tokio::test]
async fn session_ids_are_unguessable_hex() {
    let addr = spawn(ServiceConfig::default()).await;
    let (_s1, _h1, b1) = req(addr, "POST", "/v1/sessions", None, &[]).await;
    let (_s2, _h2, b2) = req(addr, "POST", "/v1/sessions", None, &[]).await;
    let (a, b) = (session_id(&b1), session_id(&b2));
    assert_ne!(a, b, "ids differ");
    for id in [&a, &b] {
        assert_eq!(id.len(), 32, "32 hex chars: {id}");
        assert!(
            id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "lowercase hex only: {id}"
        );
        assert_ne!(id, "s1", "not the old sequential scheme");
        assert_ne!(id, "s2", "not the old sequential scheme");
    }
}

#[tokio::test]
async fn idle_session_is_reaped() {
    let addr = spawn(ServiceConfig {
        idle_ttl: Some(Duration::from_millis(250)),
        ..ServiceConfig::default()
    })
    .await;
    let (st, _h, b) = req(addr, "POST", "/v1/sessions", None, &[]).await;
    assert_eq!(st, 201, "create: {b}");
    let sid = session_id(&b);
    let lifecycle = format!("/v1/sessions/{sid}/lifecycle");

    // Alive immediately.
    let (st, _h, _b) = req(addr, "GET", &lifecycle, None, &[]).await;
    assert_eq!(st, 200, "session alive right after create");

    // Leave it idle well past ttl (250ms) + a few reaper sweeps (interval ~125ms).
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let (st, _h, b) = req(addr, "GET", &lifecycle, None, &[]).await;
    assert_eq!(st, 404, "idle session reaped: {b}");
    assert_eq!(code(&b), "session_not_found", "{b}");
}

#[tokio::test]
async fn active_session_is_kept_warm() {
    let addr = spawn(ServiceConfig {
        idle_ttl: Some(Duration::from_millis(400)),
        ..ServiceConfig::default()
    })
    .await;
    let (st, _h, b) = req(addr, "POST", "/v1/sessions", None, &[]).await;
    assert_eq!(st, 201, "create: {b}");
    let sid = session_id(&b);
    let lifecycle = format!("/v1/sessions/{sid}/lifecycle");

    // Touch every 100ms (< ttl 400ms) for ~700ms: each GET refreshes last_access, so
    // the reaper must NOT evict it.
    for _ in 0..7 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let (st, _h, _b) = req(addr, "GET", &lifecycle, None, &[]).await;
        assert_eq!(st, 200, "active session stays warm under periodic access");
    }

    // Stop touching -> reaped after ttl + sweeps.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let (st, _h, b) = req(addr, "GET", &lifecycle, None, &[]).await;
    assert_eq!(st, 404, "session reaped once idle: {b}");
}

//! Phase 6.2-3b (2026-06-01) -- pluggable request authorization.
//!
//! v1 ql-service is a localhost engine-as-service; authentication is OPTIONAL and
//! pluggable. The [`Authorizer`] trait is consulted once per request in
//! [`crate::router::handle`] (after the schema-version check, before the body-size
//! cap and route dispatch). The default [`NoAuth`] allows every request -- the
//! documented open-localhost posture, an explicit configured choice (NOT a
//! No-Fallbacks silent-allow). A [`BearerToken`] stub gates on a shared secret for
//! embedders that expose the service beyond loopback.
//!
//! Authorization failure is a TRANSPORT-layer rejection (401/403), not an engine
//! `ErrorClass` -- the frozen engine taxonomy has no auth class. The router maps an
//! [`AuthReject`] to a `problem+json` response (401 carries `WWW-Authenticate: Bearer`
//! per RFC 7235) with `Connection: close`.

use http::request::Parts;

/// A per-request authorization gate. Implementors inspect the request head (method,
/// path, headers -- never the body, which is not yet read) and either allow the
/// request or reject it with an [`AuthReject`]. Must be `Send + Sync`: a single
/// `Arc<dyn Authorizer>` is shared across every per-connection tokio task.
pub trait Authorizer: Send + Sync {
    /// Allow the request (`Ok`) or reject it (`Err`). Called once, before dispatch.
    fn authorize(&self, parts: &Parts) -> Result<(), AuthReject>;
}

/// A transport-layer authorization rejection. Maps to 401 (`Unauthorized`, with a
/// `WWW-Authenticate: Bearer` challenge) or 403 (`Forbidden`).
#[derive(Clone, Debug)]
pub enum AuthReject {
    /// Missing/invalid credentials -> 401 + `WWW-Authenticate: Bearer`.
    Unauthorized { message: String },
    /// Valid credentials but insufficient -> 403. (Unused by the v1 stubs; provided
    /// for embedders' custom authorizers.)
    Forbidden { message: String },
}

/// The default authorizer: allow every request. This is the documented v1
/// open-localhost posture (the service binds `127.0.0.1` only), an explicit choice
/// surfaced in [`crate::ServiceConfig`] -- not a silent fallback.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoAuth;

impl Authorizer for NoAuth {
    fn authorize(&self, _parts: &Parts) -> Result<(), AuthReject> {
        Ok(())
    }
}

/// A shared-secret bearer-token gate (stub). Requires `Authorization: Bearer <token>`
/// with `<token>` matching the configured secret EXACTLY (constant-time compared to
/// avoid a timing oracle; no surrounding-whitespace trimming). A missing header, a
/// non-`Bearer` scheme, or a mismatch -> 401. Stub scope: the embedder must supply a
/// sufficiently long, high-entropy secret (no minimum length is enforced).
pub struct BearerToken {
    expected: Vec<u8>,
}

impl BearerToken {
    /// Construct from the expected secret. Panics on an EMPTY token (a No-Fallbacks
    /// guard: an empty expected secret would accept a bare `Authorization: Bearer `).
    /// The binary enforces non-empty before constructing; this is belt-and-braces.
    pub fn new(token: impl Into<String>) -> Self {
        let token = token.into();
        assert!(
            !token.trim().is_empty(),
            "BearerToken secret must be non-empty and not all-whitespace"
        );
        Self {
            expected: token.into_bytes(),
        }
    }
}

impl Authorizer for BearerToken {
    fn authorize(&self, parts: &Parts) -> Result<(), AuthReject> {
        let reject = || AuthReject::Unauthorized {
            message: "missing or invalid bearer token".to_string(),
        };
        let header = parts
            .headers
            .get(http::header::AUTHORIZATION)
            .ok_or_else(reject)?;
        let value = header.to_str().map_err(|_| reject())?;
        let (scheme, token) = value.split_once(' ').ok_or_else(reject)?;
        if !scheme.eq_ignore_ascii_case("Bearer") {
            return Err(reject());
        }
        if ct_eq(token.as_bytes(), &self.expected) {
            Ok(())
        } else {
            Err(reject())
        }
    }
}

/// Constant-time byte-slice equality (avoids a timing oracle on token comparison).
/// Length inequality short-circuits -- acceptable for this stub-grade gate (a length
/// side-channel does not reveal token bytes); the loop covers value comparison.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts_with(headers: &[(&str, &str)]) -> Parts {
        let mut b = http::Request::builder().method("GET").uri("/");
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        b.body(()).expect("request").into_parts().0
    }

    #[test]
    fn noauth_allows_everything() {
        assert!(NoAuth.authorize(&parts_with(&[])).is_ok());
        assert!(NoAuth
            .authorize(&parts_with(&[("authorization", "Bearer whatever")]))
            .is_ok());
    }

    #[test]
    fn bearer_requires_matching_token() {
        let a = BearerToken::new("s3cret");
        assert!(a.authorize(&parts_with(&[])).is_err(), "missing header");
        assert!(
            a.authorize(&parts_with(&[("authorization", "Basic s3cret")]))
                .is_err(),
            "wrong scheme"
        );
        assert!(
            a.authorize(&parts_with(&[("authorization", "Bearer nope")]))
                .is_err(),
            "wrong token"
        );
        assert!(
            a.authorize(&parts_with(&[("authorization", "Bearer s3cret")]))
                .is_ok(),
            "correct token"
        );
        // Scheme is case-insensitive per RFC 7235.
        assert!(a
            .authorize(&parts_with(&[("authorization", "bearer s3cret")]))
            .is_ok());
    }

    #[test]
    fn ct_eq_basic() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(!ct_eq(b"", b"x"));
    }

    #[test]
    #[should_panic(expected = "non-empty")]
    fn empty_bearer_token_panics() {
        let _ = BearerToken::new("");
    }

    #[test]
    #[should_panic(expected = "non-empty")]
    fn whitespace_bearer_token_panics() {
        let _ = BearerToken::new("   ");
    }

    #[test]
    fn token_compare_is_exact_no_trim() {
        // A trailing space must NOT authorize against an un-padded secret (no trim).
        let a = BearerToken::new("s3cret");
        assert!(a
            .authorize(&parts_with(&[("authorization", "Bearer s3cret ")]))
            .is_err());
    }
}

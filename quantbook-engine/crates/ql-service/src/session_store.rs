//! Phase 6.2-0 (2026-06-01) -- connection/session registry.
//!
//! The contract's "session-per-connection" model maps to opaque session ids over
//! HTTP: `POST /v1/sessions` allocates a `WorkbookSession` and returns an id; every
//! subsequent request carries that id; `DELETE /v1/sessions/:id` drops it. Each
//! session is an `Arc<Mutex<WorkbookSession>>` (parking_lot, no poisoning -- see
//! [`crate::guarded`]); the store maps id -> handle behind its own mutex.
//!
//! v1 ids are process-local sequential opaque tokens (`"s<n>"`) -- sufficient for a
//! single-process local service. Cryptographic/unguessable ids + auth + idle-TTL
//! reaping are 6.2-3 (auth hooks + lifecycle hardening).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use ql_exec::WorkbookSession;

/// A live engine session behind a non-poisoning mutex.
pub type SessionHandle = Arc<Mutex<WorkbookSession>>;

/// Cloneable handle to the shared session registry (clone shares the same map).
#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<StoreInner>,
}

struct StoreInner {
    sessions: Mutex<HashMap<String, SessionHandle>>,
    next_id: AtomicU64,
}

impl SessionStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(StoreInner {
                sessions: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    /// Allocate a fresh `WorkbookSession`, register it, and return `(id, handle)`.
    pub fn create(&self) -> (String, SessionHandle) {
        let n = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let id = format!("s{n}");
        let handle: SessionHandle = Arc::new(Mutex::new(WorkbookSession::new()));
        self.inner
            .sessions
            .lock()
            .insert(id.clone(), Arc::clone(&handle));
        (id, handle)
    }

    /// Look up a session handle by id (clones the `Arc`).
    pub fn get(&self, id: &str) -> Option<SessionHandle> {
        self.inner.sessions.lock().get(id).map(Arc::clone)
    }

    /// Remove a session by id; returns `true` if it was present. The underlying
    /// `WorkbookSession` is dropped when the last `Arc` (any in-flight request)
    /// releases it.
    pub fn remove(&self, id: &str) -> bool {
        self.inner.sessions.lock().remove(id).is_some()
    }

    /// Number of live sessions (diagnostics/tests).
    pub fn len(&self) -> usize {
        self.inner.sessions.lock().len()
    }

    /// Whether the store has no live sessions.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}

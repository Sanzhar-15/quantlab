//! Phase 6.2-0 (2026-06-01) -- connection/session registry.
//!
//! The contract's "session-per-connection" model maps to opaque session ids over
//! HTTP: `POST /v1/sessions` allocates a `WorkbookSession` and returns an id; every
//! subsequent request carries that id; `DELETE /v1/sessions/:id` drops it. Each
//! session is an `Arc<Mutex<WorkbookSession>>` (parking_lot, no poisoning -- see
//! [`crate::guarded`]); the store maps id -> entry behind its own mutex.
//!
//! 6.2-3b (2026-06-01) hardened identity + lifecycle:
//! - ids are now UNGUESSABLE: 16 CSPRNG bytes (`getrandom::fill`) rendered as 32-char
//!   lowercase hex, replacing the prior sequential `s<n>` (guessable + enumerable).
//!   128 bits of entropy -> collision is negligible (no retry loop).
//! - each entry carries a lock-free `last_access` timestamp (millis since the store's
//!   monotonic `start`), refreshed on every [`SessionStore::get`] -- the single lookup
//!   chokepoint for all routes. [`SessionStore::reap_idle`] evicts entries idle longer
//!   than a TTL; the service spawns a background reaper when an idle-TTL is configured
//!   (see [`crate::serve_with_config`]). The reaper touches only the map mutex + the
//!   per-entry atomic, never the engine session mutex, so it never contends with an
//!   in-flight `guarded` engine call (a mid-flight request holds an `Arc` clone, so the
//!   session stays alive until that request returns -- same as `DELETE`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use ql_exec::WorkbookSession;

/// A live engine session behind a non-poisoning mutex.
pub type SessionHandle = Arc<Mutex<WorkbookSession>>;

/// A registry entry: the session handle plus its last-access time (millis since the
/// store's monotonic `start`, stored lock-free so the reaper reads it without locking
/// the engine session mutex).
struct SessionEntry {
    handle: SessionHandle,
    last_access: AtomicU64,
}

/// Cloneable handle to the shared session registry (clone shares the same map).
#[derive(Clone)]
pub struct SessionStore {
    inner: Arc<StoreInner>,
}

struct StoreInner {
    sessions: Mutex<HashMap<String, SessionEntry>>,
    /// Monotonic base for `last_access` deltas (avoids storing `Instant` atomically).
    start: Instant,
}

impl SessionStore {
    /// Create an empty store.
    pub fn new() -> Self {
        Self {
            inner: Arc::new(StoreInner {
                sessions: Mutex::new(HashMap::new()),
                start: Instant::now(),
            }),
        }
    }

    /// Milliseconds since this store's monotonic `start`, saturating to `u64::MAX`
    /// (`as u64` would TRUNCATE the `u128`; `try_from` saturates honestly).
    fn now_millis(&self) -> u64 {
        u64::try_from(self.inner.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    /// Register an already-constructed `WorkbookSession`, returning its fresh
    /// unguessable id. The construction is done by the caller so it -- and this call,
    /// which generates a CSPRNG id -- can run under the panic boundary
    /// ([`crate::guarded`]): a CSPRNG failure surfaces as a `[panic]`/500, never a
    /// silent or guessable id (No-Fallbacks).
    pub fn register(&self, session: WorkbookSession) -> String {
        let id = fresh_id();
        let entry = SessionEntry {
            handle: Arc::new(Mutex::new(session)),
            last_access: AtomicU64::new(self.now_millis()),
        };
        self.inner.sessions.lock().insert(id.clone(), entry);
        id
    }

    /// Allocate a fresh `WorkbookSession`, register it, and return `(id, handle)`.
    /// (Convenience for tests / non-guarded callers; the HTTP `create` handler
    /// constructs + registers under [`crate::guarded`].)
    pub fn create(&self) -> (String, SessionHandle) {
        let id = self.register(WorkbookSession::new());
        let handle = self
            .get(&id)
            .expect("handle present immediately after register");
        (id, handle)
    }

    /// Look up a session handle by id (clones the `Arc`) and refresh its last-access
    /// time. This is the single lookup chokepoint for every route, so an active
    /// session -- including one held open by a polling SSE stream -- stays warm and is
    /// never reaped while in use.
    pub fn get(&self, id: &str) -> Option<SessionHandle> {
        let map = self.inner.sessions.lock();
        let entry = map.get(id)?;
        entry.last_access.store(self.now_millis(), Ordering::Relaxed);
        Some(Arc::clone(&entry.handle))
    }

    /// Remove a session by id; returns `true` if it was present. The underlying
    /// `WorkbookSession` is dropped when the last `Arc` (any in-flight request)
    /// releases it.
    pub fn remove(&self, id: &str) -> bool {
        self.inner.sessions.lock().remove(id).is_some()
    }

    /// Evict every session that is BOTH idle longer than `ttl` AND not currently in
    /// use; returns the number removed. "In use" = an extra `Arc` clone exists beyond
    /// the map's own (`strong_count > 1`), i.e. some request handler (or a just-issued
    /// `get`) still holds the handle. This guards the case a `guarded` engine call
    /// outlives the TTL: `last_access` is only refreshed at `get()` (op START), so a
    /// long op would otherwise be reaped out from under itself and the next request
    /// would see `session_not_found` (audit MED, both lanes). Touches only the map
    /// mutex + per-entry atomics + `Arc::strong_count` -- never the engine session
    /// mutex -- so it never deadlocks with an in-flight call.
    pub fn reap_idle(&self, ttl: Duration) -> usize {
        let now = self.now_millis();
        let ttl_ms = u64::try_from(ttl.as_millis()).unwrap_or(u64::MAX);
        let mut map = self.inner.sessions.lock();
        let before = map.len();
        map.retain(|_, e| {
            Arc::strong_count(&e.handle) > 1
                || now.saturating_sub(e.last_access.load(Ordering::Relaxed)) <= ttl_ms
        });
        before - map.len()
    }

    /// Downgrade to a [`WeakSessionStore`] for the background reaper, which must NOT
    /// keep the store (and thus all sessions) alive after the service stops.
    pub fn downgrade(&self) -> WeakSessionStore {
        WeakSessionStore(Arc::downgrade(&self.inner))
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

/// A weak handle to the registry held by the background idle-reaper. The reaper must
/// not keep the store alive on its own; [`Self::upgrade`] returns `None` once the
/// serving task drops its [`SessionStore`], which ends the reaper loop (see
/// [`crate::serve_with_config`]).
pub struct WeakSessionStore(Weak<StoreInner>);

impl WeakSessionStore {
    /// Upgrade to a live [`SessionStore`], or `None` if the service has stopped.
    pub fn upgrade(&self) -> Option<SessionStore> {
        self.0.upgrade().map(|inner| SessionStore { inner })
    }
}

/// Generate an unguessable session id: 16 CSPRNG bytes -> 32-char lowercase hex.
/// A `getrandom` failure (no OS entropy source) is catastrophic + essentially never
/// on a healthy host; it panics loudly (caught by the caller's [`crate::guarded`]
/// boundary -> 500) rather than degrading to a weak id (No-Fallbacks).
fn fresh_id() -> String {
    use std::fmt::Write as _;
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("getrandom: OS CSPRNG unavailable");
    let mut s = String::with_capacity(32);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unguessable_hex_and_distinct() {
        let store = SessionStore::new();
        let a = store.register(WorkbookSession::new());
        let b = store.register(WorkbookSession::new());
        assert_ne!(a, b, "ids must differ");
        for id in [&a, &b] {
            assert_eq!(id.len(), 32, "id is 32 hex chars: {id}");
            assert!(
                id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
                "id is lowercase hex: {id}"
            );
            assert!(
                !id.starts_with('s'),
                "id must not be the old sequential s<n>: {id}"
            );
        }
    }

    #[test]
    fn reap_idle_evicts_by_ttl() {
        let store = SessionStore::new();
        let _ = store.register(WorkbookSession::new());
        let _ = store.register(WorkbookSession::new());
        assert_eq!(store.len(), 2);
        // A huge TTL evicts nothing (both just-registered).
        assert_eq!(store.reap_idle(Duration::from_secs(3600)), 0);
        assert_eq!(store.len(), 2);
        // After a short idle, a tiny TTL evicts both.
        std::thread::sleep(Duration::from_millis(5));
        assert_eq!(store.reap_idle(Duration::from_millis(1)), 2);
        assert_eq!(store.len(), 0);
    }

    #[test]
    fn get_refreshes_last_access() {
        let store = SessionStore::new();
        let id = store.register(WorkbookSession::new());
        std::thread::sleep(Duration::from_millis(80));
        // Touch via get -> resets last_access to "now".
        assert!(store.get(&id).is_some());
        // ttl (50ms) < the 80ms idle BEFORE the touch: only a get() that refreshed
        // last_access keeps the session (a no-touch get would leave it stale -> reaped).
        assert_eq!(store.reap_idle(Duration::from_millis(50)), 0);
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn reap_skips_in_use_sessions() {
        let store = SessionStore::new();
        let id = store.register(WorkbookSession::new());
        // Hold an extra Arc clone -> the session is "in use" (strong_count > 1).
        let held = store.get(&id).expect("handle");
        std::thread::sleep(Duration::from_millis(10));
        // Stale by timestamp (ttl 1ms < 10ms idle) BUT in use -> NOT reaped: a long
        // op outliving the TTL must not be evicted out from under itself.
        assert_eq!(store.reap_idle(Duration::from_millis(1)), 0, "in-use kept");
        assert_eq!(store.len(), 1);
        // Once the handle is released, the now-idle session is reaped.
        drop(held);
        assert_eq!(store.reap_idle(Duration::from_millis(1)), 1, "released+idle reaped");
        assert_eq!(store.len(), 0);
    }
}

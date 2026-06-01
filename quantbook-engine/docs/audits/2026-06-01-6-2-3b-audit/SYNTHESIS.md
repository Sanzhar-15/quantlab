# 6.2-3b audit synthesis (2026-06-01)

**Scope:** `ql-service` identity + lifecycle hardening (the 3rd binding row over the FROZEN
engine contract). Pluggable auth trait (`Authorizer`; default `NoAuth`, `BearerToken` stub),
unguessable CSPRNG session ids (16 `getrandom::fill` bytes -> 32-char hex, replacing the
sequential `s<n>`), and idle-TTL session reaping (lock-free `last_access` per entry +
`reap_idle` + a background reaper spawned by `serve_with_config` when an idle-TTL is set).
`spawn_blocking` for long synchronous engine calls is documented-and-deferred (user decision).
PURE transport: ql-exec 802/0 (default + xlsx-write) UNCHANGED.

**Method:** parallel 2-lane review per the repo discipline -- Codex (`-s read-only`,
`-c model_reasoning_effort=high`, on the VM) + a fresh Opus lane (general-purpose agent). Both
reviewed ONLY the 6.2-3b working tree. Both verdicts: **SHIP-WITH-FIXES, 0 HIGH.**

## Findings + dispositions (all folded)

### MED -- active-session eviction (BOTH lanes; Codex MED-1 + Opus M1)
`get()` refreshes `last_access` at op START only. A `guarded` engine call (or an SSE poll gap)
that outlives the TTL could be reaped mid-flight; the call still completes (the in-flight `Arc`
keeps the engine session alive), but the next request gets `session_not_found`. Opus framed the
same defect at the SSE boundary (`idle_ttl < SSE_POLL_INTERVAL` 250ms).
**FOLD:** `reap_idle` now keeps an entry when it is still in use --
`Arc::strong_count(&e.handle) > 1` (the lightweight per-entry "lease" Codex suggested, for free
via `Arc`) -- OR not yet stale. New deterministic unit test `reap_skips_in_use_sessions` (a held
clone is NOT reaped despite a stale timestamp; reaped once released). Docstrings on
`reap_idle`/`get`/`ServiceConfig::idle_ttl` corrected to state the precise guarantee + the
"set ttl in seconds, above the ~250ms poll interval; sub-second TTLs unsupported" caveat.

### MED -- bearer-secret leakage in startup error (Codex MED-2; Opus missed)
`bin/ql-service.rs` formatted the `QL_SERVICE_BEARER_TOKEN` `NotUnicode` error with `{e}`, and
`VarError::NotUnicode` embeds the offending `OsString` (the secret) in its `Display`.
**FOLD:** redacted -- the branch now emits a fixed message with no embedded value.

### LOW -- `as u64` truncation vs "saturating" comment (Codex)
`now_millis`/`reap_idle` used `Duration::as_millis() as u64`, which TRUNCATES the `u128` (the
comment falsely said "saturating"); an absurd `Duration` could wrap and reap early.
**FOLD:** `u64::try_from(..).unwrap_or(u64::MAX)` -- honest saturation.

### LOW -- detached reaper holds a strong store (Codex)
The reaper owned a strong `SessionStore` clone and looped forever, so it could outlive the
serving task and retain sessions.
**FOLD:** the reaper now holds a `WeakSessionStore`; `upgrade()` returns `None` once the serving
task drops its store, ending the loop. No real leak in the binary path (tokio::select! + ctrl_c
-> process exit) or tests (runtime teardown aborts tasks), but the `Weak` pattern is correct.

### LOW -- token `.trim()` lax/asymmetric (BOTH lanes; Opus L1 + Codex)
`authorize` trimmed the presented token, so `"Bearer secret "` matched secret `"secret"`, while
the expected secret was stored un-trimmed (asymmetric). Not a bypass (secret bytes still
required), but laxer than a strict bearer compare.
**FOLD:** dropped `.trim()` -- exact constant-time compare of the post-scheme token. New unit
test `token_compare_is_exact_no_trim`.

### LOW -- whitespace-only secret accepted (BOTH lanes; Opus L2 + Codex)
`" "` passed the `!is_empty()` guard (construction + env), constructing a service that 401s every
request with no startup error.
**FOLD:** reject `trim().is_empty()` in `BearerToken::new` (panic) AND `auth_from_env` (loud
io::Error). New `whitespace_bearer_token_panics` test.

### LOW (informational) -- no minimum secret length (Opus L3)
Stub scope; not enforced. **FOLD:** documented on `BearerToken` that the embedder must supply a
sufficiently long, high-entropy secret.

## Items verified CORRECT by both lanes (no finding)
- Reaper never locks the engine session mutex (only the map mutex + atomics + `strong_count`);
  no deadlock with an in-flight `guarded` call; dropping a map `Arc` while a request holds a
  clone does not drop the session early.
- `get()` is the single lookup chokepoint (every route, incl. SSE/export/delete, resolves via it;
  no direct map access in router.rs).
- Auth ordering schema -> auth -> body-cap -> dispatch: an unauthorized client cannot probe
  routes or submit a body; 401 carries `WWW-Authenticate: Bearer` + `Connection: close` +
  `x-ql-schema-version`.
- Unguessable ids: `{b:02x}` lowercase, zero-padded, exactly 32 chars, leading-zero bytes
  preserved; `fresh_id`'s `getrandom` panic is caught (register runs inside the create_session
  `guarded` closure -> 500, not a dropped connection).
- No-Fallbacks: env wiring loud on every set-but-invalid case; secret never logged
  (`BearerToken` has no `Debug`; `ServiceConfig` manual Debug prints `"<authorizer>"`).
- Back-compat: default `ServiceConfig` = NoAuth + idle_ttl None -> no reaper; the 6 serve()-based
  test files unaffected; `..ServiceConfig::default()` added to the 2 protocol_hardening literals.
- Test rigor: each new test fails under a broken/no-op impl; timing tests use generous margins.

## Verification (Mac host, after fold)
cargo build -p ql-service --all-targets 0/0 (debug) + release 0/0; cargo test -p ql-service ALL
green (lib unit 36; identity_lifecycle_http 5/5; protocol_hardening_http 5/5; all prior); clippy
-p ql-service --all-targets 0 ql-service warnings (ql-storage/ql-oplog/ql-exec warnings are
PRE-EXISTING dep-crate); ql-exec --lib 802/0 (default + xlsx-write) UNCHANGED; cargo check
--workspace clean; non-ASCII sweep clean; Cargo.lock churn = only the getrandom direct edge.

**Verdict after fold: SHIP.**

# 6.2-3a audit synthesis (2026-06-01)

**Increment:** Phase 6.2-3a -- `ql-service` request-path / protocol hardening: a request-body
size cap (on both the JSON `read_json` path and the raw-`import` `read_bytes` path), a
`schemaVersion` echo + mismatch rejection, and RFC-correct **405 + `Allow`** on a known-path /
wrong-method. Pure transport; no engine logic changed. (6.2-3 was split a/b per the user; 6.2-3b
= auth trait + unguessable ids + idle-TTL reaping is the next increment.)

**Method:** parallel 2-lane review per repo discipline -- Codex (`-c model_reasoning_effort=high`,
`-s read-only`, VM) + a fresh Opus lane (general-purpose agent). Both reviewed ONLY the 6.2-3a
changes (`lib.rs`, `router.rs`, `bin/ql-service.rs`, new `tests/protocol_hardening_http.rs`).

## Verdicts

- **Codex: SHIP-WITH-FIXES** -- 0 HIGH, 1 MED, 4 LOW.
- **Opus: SHIP-WITH-FIXES** -- 0 HIGH, 1 MED, 3 LOW.

Both independently confirmed: the `LengthLimitError` downcast is reliable on the pinned
`http-body-util 0.1.3` (exact-limit accepted, `limit+1` rejected); `HeaderValue::from(SCHEMA_VERSION)`
is sound for `u16`; the `GET_VERBS`/`POST_VERBS` 405 registry is an **exact** match to the route
table (10 GET + 42 POST, verified by enumeration in both lanes); the schema echo reaches every
response path including the SSE `events` stream; back-compat `serve(listener, store)` retained;
`ql-exec` untouched.

## Findings + dispositions (all folded)

1. **Codex MED -- body cap only bound the routes that actually READ the body.** Bodyless POST
   routes (`recalc`, `begin-transaction`, `undo`, `redo`, `mark-volatiles-dirty`, create-session,
   `start-recalc`) never call `read_json`/`read_bytes`, so the `Limited` wrap was never polled and
   the cap never fired on them. **FOLDED:** added a **Content-Length preflight** in `handle` -- a
   declared `Content-Length` over the per-route limit is rejected 413 (connection closed) BEFORE
   dispatch, on every route. The `Limited` wrap remains the streaming enforcement for the
   body-reading routes (and chunked / understated-length bodies). *Residual (documented):* an
   oversized **chunked** body (no `Content-Length`) to a **bodyless** route is neither preflighted
   nor read -- but it is never buffered or processed either, so it is harmless (no memory DoS).

2. **Opus MED / Codex LOW -- a 413 left the request body undrained -> keep-alive desync risk.**
   **FOLDED:** `map_body_err` now wraps both the 413 (over-limit) and the 400 (other read error)
   in `with_close`, forcing `Connection: close`; the preflight 413 also closes. v1 clients send
   `Connection: close` anyway, but this makes the close authoritative for the keep-alive path.

3. **Codex LOW -- `env_usize` treated all `VarError` as unset** (a SET-but-non-Unicode
   `QL_SERVICE_MAX_*_BYTES` silently fell back to default -- a No-Fallbacks violation). **FOLDED:**
   now `NotPresent => default`, `NotUnicode => loud io::Error`.

4. **Codex LOW / Opus LOW -- under-limit acceptance asserted only as `assert_ne!(413)`.**
   **FOLDED:** the under-limit case now POSTs `add-sheet` and asserts a concrete **200**, proving
   the body is read AND dispatched. Added a dedicated `body_cap_binds_bodyless_routes_via_content_length`
   test (oversized body to `recalc` -> 413 via the preflight).

5. **Codex LOW / Opus LOW -- error responses (405/413) not asserted to echo the schema header.**
   **FOLDED:** added `x-ql-schema-version` echo assertions on the 405 and 413 responses.

6. **Codex LOW / Opus LOW -- debug-only `__force_panic` returns 404 (not 405) on a wrong method**
   (it is deliberately absent from `POST_VERBS`). **FOLDED (doc):** added a comment at `POST_VERBS`
   explaining the intentional exclusion (the probe must not be advertised; 404 is correct).

7. **Opus LOW -- `query_value` does no percent-decoding** (pre-existing, not 6.2-3a). Out of
   scope; the `import` cap keys on the path segment, not the query, so it is unaffected.

## Process note (transparency)

Mid-implementation I misread an output-bleed-corrupted clippy line as "unused import: EngineSession"
and removed that import -- but `EngineSession` is the trait whose methods every handler calls, so
the removal broke the build (15x `E0599`). The REAL warning was `doc_lazy_continuation` on the new
module-doc bullet. Caught by reading the authoritative compiler exit codes (`BUILD_EXIT=101`),
restored the import, and rewrote the doc note as prose. Lesson: trust compiler/exit-code gates over
rendered warning text when the channel is noisy; verify an "unused import" claim against actual usage
before removing it.

## Verification (post-fold, Mac host)

- `cargo build -p ql-service` 0; `cargo test -p ql-service` **0 failures** (26 unit + integration;
  `protocol_hardening_http` = 5 tests); `cargo clippy -p ql-service --all-targets` **0 ql-service warnings** (a post-commit re-check caught 5 `doc_lazy_continuation` warnings on the 6.2-3a module-doc block -- a raw blank line instead of a `//!` doc-blank made rustdoc read the new paragraph as a lazy list continuation; fixed in the feat commit by making line 61 a `//!` doc-blank, re-verified 0); `cargo build -p ql-service --release` 0.
- **`cargo test -p ql-exec --lib` = 802/0; `--features xlsx-write` = 802/0 -- UNCHANGED** (pure
  transport proven).
- `cargo check --workspace` clean; non-ASCII sweep clean.

**Verdict: SHIP.** All findings from both lanes folded; full gate green.

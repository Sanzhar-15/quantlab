# 6.2 Mid-Phase Deep Megaudit -- SYNTHESIS

Deep megaudit of EVERYTHING shipped in Phase 6.2 so far (`ql-service` 6.2-0 +
6.2-1a + 6.2-1b) at the user's request ("is everything optimal and complete?
also the documentation"). 4 lanes: **Codex** (read-only, high) + 3 fresh **Opus**
lanes (A code-correctness, B docs-consistency, C completeness-critic). Engine HEAD
at audit: `d69437b349a`.

## Lane verdicts (as received)

- **Codex -> NO (not optimal/complete):** 4 must-fix -- (1) `POST /v1/sessions` constructor outside the panic boundary; (2) entry-plan method arithmetic wrong; (3) `session-api` `RangeResult` DTO doc stale; (4) the number-parity deferral note should cover `-0`/exponents/non-finite.
- **Opus Lane A (code) -> SHIP** (no HIGH; 5 LOW all deferred-by-plan). Verified wire fidelity of every shipped DTO + method accounting.
- **Opus Lane B (docs) -> NOT optimal:** 3 MED (arithmetic; `start_recalc`/`await_recalc` unaccounted; wrong 6.2-0 commit hash `cbec...`) + LOW.
- **Opus Lane C (completeness) -> hidden gaps:** 3 HIGH (lifecycle-gating 409 untested; `export`/`delete` duplicated plumbing untested; no body-size cap) + MED test-coverage gaps.

## Cross-lane resolution (verified at source, not taken on trust)

- **Trait method count = 53** (Codex + Lane B correct; Lane A's "50" was WRONG -- I counted the trait directly: 53 `fn`s). The correct decomposition arithmetic is `39 = 53 - 9 (6.2-0) - 5 (6.2-2)`, split `11 (1a) + 10 (1b) + 18 (1c)`. The broken "`- 5 in 6.2-0`" framing had been propagated into the entry-plan, `_active.md`, and memory -- all corrected.
- **`start_recalc`/`await_recalc`** are real trait methods; they belong in **6.2-2** (they are the M2 split-recalc that opens the pre-start cancel window) -- the entry-plan 6.2-2 bullet now enumerates all 5 (start_recalc/await_recalc/cancel/operation_status/poll_events). No trait method is unaccounted-for.
- **Lifecycle-gating 409 (Lane C HIGH) is NOT deterministically HTTP-reachable at the current endpoint set** -- a verification finding that corrected Lane C's "just add a test": `close` is bound to DELETE which also REMOVES the session (-> 404, not a Closed-state 409), and a `Faulted` session needs a panic INSIDE a real engine op (the engine `FaultGuard` arms only around engine calls). The debug `__force_panic` route panics in the SERVICE closure without touching the engine, so the session stays Ready after the caught panic (parking_lot, no poison) -- I wrote that test, it returned 200 not 409, proving the point. Documented in `tests/error_paths_http.rs` + filed to 6.2-3 (lifecycle hardening).

## What was FOLDED this pass

**Code:**
- `create_session` now constructs `WorkbookSession::new()` under `guarded("createSession", ...)` (Codex must-fix #1) -- added `SessionStore::register(session)`; `create()` delegates to it. Every engine call is now inside the panic boundary.

**Tests (new `tests/error_paths_http.rs`):** the reachable parts of Lane C's HIGH/MED gaps -- invalid-JSON body -> 400 `bad_argument` (the generic `read_json` path, previously only unit-reasoned, now wire-tested); `export`/`DELETE` of an unknown id -> 404 (the DUPLICATED `store.get` plumbing that bypasses `with_session`); post-DELETE mutation -> 404. (The unreachable Faulted-409 test was removed + documented, see above.)

**Docs:**
- entry-plan: fixed the method arithmetic (53/9/5/39/11+10+18); enumerated 6.2-2's 5 methods + 6.2-1c's exact 18; fixed the wrong 6.2-0 commit hash (`cbec...` -> `d7407678312`/`c6129031d56`); expanded §5 deferred-items with the megaudit forward decisions (number-encoding full scope incl. `-0`/exponents; body-cap blast radius = `read_json` AND `read_bytes`; idle-TTL+ids; binary-parity 6.2-4; the `spawn_blocking`/keep-alive/405/table-read-back forward decisions).
- `session-api.md`: corrected the `RangeResult` DTO shape (removed the non-existent `layout`/`include`/`ArrowHandle`; `RangeQueryOptions` is an INPUT); added `schema_version` to the `WorkbookSnapshot` summary; updated the transport-pick + service-row gRPC wording to "HTTP/1.1+SSE on hyper, decided".
- `lib.rs` crate doc refreshed to the current checkpoint + a wire-parity caveat pointing at `CellValueWire`; `wire.rs` `CellValueWire` number-deferral note expanded to `-0`/exponent-thresholds/non-finite (Codex must-fix #4).
- `_active.md` + memory (`current_work.md`, `MEMORY.md`) arithmetic corrected.

**Verification of the fold caught 2 regressions (fixed before ship):** (a) the false-premise Faulted test (returned 200, not 409 -- removed); (b) 15 new `clippy::doc_lazy_continuation` warnings from the doc edits (a wrapped line starting with `+`, and a `- ` list without bracketing blank lines -- both reworded; clippy back to 0).

## Deferred (tracked, safe for the localhost-single-client v1 scope)

Body-size cap + idle-TTL + unguessable session ids -> 6.2-3; the number-encoding byte-identical fix -> 6.2-4; `spawn_blocking` for long engine calls, keep-alive coverage, 405-vs-404, and table/format read-back -> explicit forward decisions now written into the entry-plan §5 (no longer silent gaps).

## Post-fold verification (Mac host)

- `cargo test -p ql-service` -> **19 tests** pass (13 wire unit + 2 cluster_a_b + 2 cluster_c_d + 1 golden_flow + 1 error_paths).
- `cargo clippy -p ql-service --all-targets` -> **0** ql-service warnings.
- `cargo build -p ql-service` debug + release -> **0/0**.
- `cargo test -p ql-exec` default + `--features xlsx-write` -> **802/0 unchanged** (pure-transport invariant; engine untouched).

## OVERALL

**Now optimal & complete for the checkpoint, after the fold.** The one real code gap (unguarded constructor) is closed; the documentation defects (arithmetic, `start_recalc`/`await_recalc`, wrong hash, stale `RangeResult`/`WorkbookSnapshot`/gRPC) are corrected; the reachable test-coverage gaps are filled and the unreachable one is documented + filed. All remaining deferrals are tracked in the entry-plan and safe for the current local-single-client scope. Ready to proceed to 6.2-1c.

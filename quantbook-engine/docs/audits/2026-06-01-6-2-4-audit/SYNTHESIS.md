# 6.2-4 closure megaudit synthesis (2026-06-01)

**Scope:** the FINAL increment of Phase 6.2 (`ql-service` HTTP transport over the FROZEN
engine contract). Two things: (A) resolve the long-deferred number-encoding divergence AT
THE SOURCE -- an ECMAScript `Number::toString` serializer so cell numbers cross as `6`/`0`/
`1e+21` (matching the frozen napi wire) instead of serde/ryu `6.0`/`-0.0`/`1e21`; (B) add a
3rd "service" row to the golden parity matrix (a stdlib-`urllib` emitter launching the
`ql-service` debug binary, driving the 23-step golden flow over HTTP), with a structural
cross-row gate + a narrow service-vs-node BYTE gate.

PURE transport: ql-exec 802/0 (default + xlsx-write) UNCHANGED.

## Lanes (3-way, per audit discipline)
- **Codex** (read-only, reasoning_effort=high): SHIP-WITH-FIXES.
- **Opus-A** (Rust serializer correctness): SHIP-WITH-FIXES, found HIGH-1.
- **Opus-B** (Python emitter + matrix integrity): SHIP-WITH-FIXES.

## HIGH-1 (Opus-A) -- the serializer was NOT byte-identical. CONFIRMED + FIXED.
Opus-A ran a 2M-value Rust-vs-Node differential fuzz and reported that Rust's `{:e}`/`Display`
shortest-float digits diverge from V8's on ~0.025% of finite f64 (a last-digit tie-break:
both round-trip, but Rust picks e.g. `1658206780088562.3` where V8 picks `...562.2`),
concentrated in the 10^11-10^15 fractional band. The original `ecma_number_string` was built
on `{:e}`, so it inherited this -- defeating the byte-identical goal of 6.2-4.

**Independently CONFIRMED** (not taken on trust): a direct Rust-vs-Node check on the exact
claimed bit patterns reproduced 3/8 divergences (Rust `...562.3` vs Node `...562.2`). The
golden flow's small-integer values never hit the band (the matrix passed), but the wire was
genuinely non-conformant for that value class.

**Fix (user decision -- "fix at source"):** replaced the hand-rolled `{:e}` case-split with
the `ryu-js` crate (`=1.0.2`, Boa's JS-semantics Ryu -- "ECMAScript compliant" float->string,
reproduces V8's shortest-decimal algorithm INCLUDING the tie-break). `ecma_number_string` is
now a thin wrapper over `ryu_js::Buffer::format`. Cost: one new pinned dep; verified it adds
**0 transitive runtime crates** (lock +7 lines, just ryu-js) -- respecting the workspace's
minimal-dep / `=`-exact-pin discipline. Added the HIGH-1 exemplars as regression pins in the
unit table + a 50k-value deterministic round-trip gate.

## MEDIUM-1 (all 3 lanes) -- non-finite panic was OUTSIDE the guarded boundary. FIXED.
`ecma_number_string` originally `assert!`ed on non-finite, and the wire doc claimed the panic
was caught by `guarded` -> 500. That was WRONG: serialization runs in `json()` AFTER `guarded`
has returned (and the connection task is a bare `tokio::spawn`), so a panic would drop the
connection / abort, not become a 500. **Fix:** `ecma_opt_number::serialize` now checks
`is_finite()` and returns a `serde::ser::Error` for non-finite (No-Fallbacks: `serde_json::to_*`
propagates the `Err`, which `json()` maps to a 500 problem+json). Doc corrected. (Unreachable
on the normal path -- the engine never stores NaN/Inf as a Number and `cell_value_from_wire`
rejects them on input -- but now correct-by-construction rather than by a false claim.)

## M1 (both Opus lanes) -- err_post_close masking hid the loud-failure code. FIXED.
The matrix masked the `err_post_close` error code for ALL rows, so the in-process rows no
longer asserted they failed with the RIGHT code. **Fix:** `normalize_closed_session` now
ASSERTS the per-transport expected code (verified empirically: node/python -> `invalid_state`,
service -> `session_not_found`; the service DELETE both closes AND removes, vs in-process
close-then-hit-closed-session) BEFORE normalizing. A regression to a wrong/absent code now
fails loud; only the legitimate per-transport value is masked.

## Opus-B H1 -- emitter had no happy-path status guard. FIXED.
`golden_flow_service.py` ignored HTTP status on every call but session-create, relying on
downstream KeyError to catch failures. **Fix:** `Client.call` now asserts 2xx by default
(`allow_error=True` for the deliberate-error steps via `code_of`), so a mid-flow failure fails
loud rather than risking a vacuous pass.

## Other folds
- **M2 (both):** `_free_port()` reserve-release TOCTOU race -> `_launch_ready` retries on a
  fresh port if the child dies early (up to 3 attempts).
- **M3 (Opus-B):** matrix now asserts Python >= 3.10 (pyo3 abi3-py310; host default is 3.9).
- **L1 (Opus-B):** `changedHit` uses `["value"]` (fail-loud) not `.get("value")`.
- **Codex LOW:** `_terminate` always reaps (`wait` after `kill`); no zombie.

## Verification (committed tree, Mac host; trust exit codes + git porcelain)
- ql-service build debug + release: 0/0. clippy: 0 ql-service warnings (the 3 "generated N
  warnings" lines are PRE-EXISTING ql-storage/ql-oplog/ql-exec dep-crate warnings -- 0 in
  crates/ql-service/).
- ql-service tests green: 40 lib unit (incl. the ECMAScript table with HIGH-1 pins, the 50k
  round-trip, the non-finite serde-error test) + all integration (incl. new
  number_encoding_http: raw-bytes ES-token gate).
- **ql-exec 802/0 (default + xlsx-write) UNCHANGED** -- pure-transport invariant.
- **parity_matrix.py (python3.12): "PARITY OK (23 steps ... Node + Python + Service;
  service==node byte-identical)".**
- workspace check clean; Cargo.lock churn = serde_json raw_value feature + ryu-js (0
  transitive crates); non-ASCII clean.

## Verdict
All three lanes SHIP-WITH-FIXES; all findings folded and re-verified. HIGH-1 was a genuine
byte-parity defect (independently confirmed) -- fixed at the source with ryu-js, not by
weakening the gate. **6.2-4 SHIPPED -> Phase 6.2 COMPLETE.**

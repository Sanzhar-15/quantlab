# 6.2-1a Audit -- SYNTHESIS

Phase 6.2-1a (`ql-service` cluster A read/format/validate/query + cluster B
persistence -- 11 EngineSession methods bound over HTTP). Parallel 2-lane audit
on the uncommitted working tree (per repo audit discipline): **Codex** (read-only,
`model_reasoning_effort=high`, default model) + **fresh Opus** (general-purpose).

## Verdicts

- **Codex -> DO-NOT-SHIP** -- 1 HIGH, 3 LOW. (Run/verdict: `.codex-6-2-1a-audit.out` at repo root.)
- **Opus -> SHIP** -- 0 HIGH, 0 MED, 3 LOW.

Both lanes independently confirmed the core checks: `format_id_from_wire` is a
correct strict tagged union (equivalent-or-stricter vs napi `session_format_id_from_json`;
the concrete u32/u64 wire types make serde enforce numeric range -- no silent-coercion
hole); `import` reads raw bytes + requires `?format`; `export` preserves the `guarded`
panic boundary on its hand-rolled lock path; `Capability` -> 501. No engine logic
changed (ql-exec **802/0** unchanged, default + xlsx-write).

## The cross-lane disagreement (Codex HIGH) + disposition

| # | Lane | Sev | Finding | Resolution |
|---|------|-----|---------|------------|
| 1 | Codex | HIGH | `CellValueWire.number` (f64) serializes as `6.0` (serde), but napi crosses it as a JS `Number` that `JSON.stringify` renders as `6` -- so number values are not byte-identical to the napi row (`queryRange`, and the already-shipped `snapshot`). Codex confirmed via a live `node` experiment. | **DEFERRED to 6.2-4 (user decision).** This is the EXACT 6.2-0 filed-forward item ("the whole-f64 cell-value representation question for byte-identical parity (6.0 vs 6) -- resolve in 6.2-4 against the matrix's actual comparison mode"). It is PRE-EXISTING: 6.2-0's `snapshot` endpoint already emits `number`; 6.2-1a's `queryRange` reuses the same `cell_value_to_wire`. Whether any fix is needed depends on the 6.2-4 comparison mode -- structural comparison treats `6.0`==`6` (no fix); only byte-identical needs a uniform ECMAScript `Number`->string serializer applied across ALL number-emitting endpoints (here + snapshot), which is why it is NOT patched piecemeal in cluster A. **Folded: an explicit doc note now lives at the `CellValueWire.number` code site (no longer silent) + a note on the wire test that pins `6.0`.** Opus did not flag it (it compared Rust field types/shapes, not the JS `JSON.stringify` integer rendering). |

## LOW findings + resolution

| # | Lane | Finding | Resolution |
|---|------|---------|------------|
| 2 | Codex | `register-format` test could pass under a broken handler returning an unrelated builtin (set-format round-trips any valid id). | **FIXED** (`cluster_a_b_http.rs`): after the round-trip, assert the registered id+string `{string:"0.00%", id:fmt}` is present in `snapshot().formats` -- a handler that did not actually register "0.00%" cannot satisfy this. |
| 3 | Codex | `query-range` test was 2x1 -- did not prove multi-column column-major layout or that `endCol` is honored. | **FIXED**: extended to a 2x2 rectangle (C1..C2 + D1..D2), asserting `columns.len()==2`, col0=[1,2] and col1=[3,4] top-to-bottom. |
| 4 | Codex | `mark-volatiles-dirty` is ack-only; a no-op `{ok:true}` passes. | **ACCEPTED (documented).** The dirty-set is not exposed over the wire and the only observable signal (a volatile value changing across recalc) is RNG/time-flaky -- unsuitable for a deterministic test. The test pins the route+lock+lifecycle+ack path; the semantics are covered by ql-exec's own tests (thin forwarder). A code comment records this. |
| 5 | Opus | `router.rs` `query_value` defaults a value-less query param (`format=`) to `""`. | **ACCEPTED.** Not error-masking: an empty `format` is forwarded and rejected loudly by the engine (`bad_argument`). Consistent with 6.2-0. |
| 6 | Opus | `export` is hand-rolled (lock + guarded + octet_stream) rather than `with_session`. | **ACCEPTED.** Necessary divergence (`with_session` requires `T: Serialize`/returns JSON; export returns raw bytes); verified equivalent -- same `session_not_found` precheck, same `guarded` boundary, valid `&self` borrow. |
| 7 | Opus | `export xlsx -> 501` test depends on `xlsx-write` being OFF. | **ACCEPTED.** ql-exec defaults exclude it + ql-service never enables it; robust for the default-feature build. |

## Post-fold verification (Mac host)

- `cargo test -p ql-service` -> **14/14** (11 wire unit + 2 cluster_a_b integration + 1 golden_flow_http).
- `cargo clippy -p ql-service --all-targets` -> **0**.
- `cargo build -p ql-service` debug + release -> **0/0**.
- `cargo test -p ql-exec` default + `--features xlsx-write` -> **802/0 unchanged** (pure-transport invariant).
- `cargo build --workspace` -> clean (napi + pyo3 still build).

**Outcome: SHIP.** The one HIGH is the pre-existing, deliberately-deferred 6.2-4
number-encoding item (now documented at the code site, not silent); all 3 actionable
LOWs folded or accepted with rationale. The cross-lane disagreement resolved by code
verification + the standing 6.2-0 deferral.

# 6.2-0 Audit — SYNTHESIS

Phase 6.2-0 (`ql-service` HTTP+SSE foundation + golden-flow vertical slice, SVC-6-01).
Parallel 2-lane audit on the uncommitted working tree (per repo audit discipline):
**Codex** (read-only, `model_reasoning_effort=high`) + **fresh Opus** (general-purpose).

## Verdicts
- **Codex → SHIP-WITH-FIXES** — 0 HIGH, 3 MED, 2 LOW. (Run log: `lane-codex-run.log`; verdict transcribed to `lane-codex.out` — codex's read-only sandbox can't self-write.)
- **Opus → SHIP** — 0 HIGH, 0 MED, 4 LOW.

Both lanes independently confirmed the highest-priority check — **wire-DTO freeze-fidelity**: `src/wire.rs` reproduces the napi `FooJson` JSON shapes (camelCase keys, Option→omitted, u64→quoted decimal string, kind/tag strings, schemaVersion forwarded). No engine logic changed (ql-exec **802/0** unchanged, default + xlsx-write).

## Findings + resolution

| # | Lane | Sev | Finding | Resolution |
|---|------|-----|---------|------------|
| 1 | Codex | MED | `router.rs` re-validates `chunkRows==0` before the engine — "masks the engine error" | **REJECTED (kept).** Verified the engine `add_sheet` has NO 0-guard — `chunk_rows==0` flows into `ColumnStore` chunk-index math and **panics**; napi prechecks it for exactly this reason (`ql-bindings-node` lib.rs:5660). Removing it would diverge from the frozen binding AND turn a clean `[bad_argument]` 400 into a `[panic]` 500. This is correct napi-parity + panic-prevention (Opus concurred it is parity, not divergence). |
| 2 | Codex MED / Opus LOW | MED | `problem()` last-resort `unwrap_or_default()` could emit an empty 500 body | **FIXED** (`router.rs`): static byte-literal valid problem+json as the last resort — never an empty body. |
| 3 | Codex | MED | `SessionVersion` hex has no decode helper / round-trip test | **FIXED** (`wire.rs`): added `hex_decode` (fail-loud `invalid_version_token` on odd-length/bad-digit) + a `hex_round_trips` unit test, before any version-consuming endpoint (6.2-1) relies on it. |
| 4 | Codex | LOW | test helper discards headers → `application/problem+json` not actually asserted | **FIXED** (`golden_flow_http.rs`): `http_full` captures Content-Type; asserts `problem+json` on the 400 and `application/json` on a success. |
| 5 | Codex | LOW | no serde golden test for `FormatIdWire` / option-omission | **FIXED** (`wire.rs` tests). **This caught a real latent freeze divergence:** `builtin`/`customCounter` were `f64` → serde emits `164.0`, but napi renders the whole f64 as the integer `164`. Re-typed them `u32` so the service emits integer JSON matching napi under both byte-identical AND structural comparison. (Both audits missed this — they compared Rust field *types*, not serialized output; writing the requested serde test surfaced it.) |
| 6 | Opus | LOW | `error.rs` details-serialize failure inlines text vs napi's hard `[panic]` | **Documented, not folded.** Unreachable path (`BTreeMap<String,Value>` serialize cannot fail); the current behavior surfaces the error text loudly in the response (No-Fallbacks-compliant — it does not mask). Strict `[panic]`/500 parity would need a signature change for an impossible path. |
| 7 | Opus | LOW | `read_json` has no request-body size cap (DoS if exposed beyond localhost) | **Deferred to 6.2-3** (auth + lifecycle hardening); documented. v1 is localhost single-client. |
| 8 | Opus | LOW | `recalc` returns `{op:"…"}` vs napi's bare BigInt | **Note for 6.2-4 parity:** transport wraps scalars in JSON objects; the *value encoding* (quoted decimal string) is faithful. The 6.2-4 parity row must treat `op` as encoding-checked/masked (op-ids legitimately differ across bindings), not value-equal. |

## Post-fold verification (independent re-run, Mac host)
- `cargo clippy -p ql-service --all-targets` → **0**.
- `cargo test -p ql-service` → **6 wire unit tests + 1 golden_flow_http integration test = 7/7 pass**.
- `cargo build -p ql-service` debug + release → **0/0**.
- `cargo test -p ql-exec` default + `--features xlsx-write` → **802/0 unchanged** (pure-transport invariant).
- `cargo build --workspace` → clean (napi + pyo3 bindings still build).

**Outcome: SHIP.** No HIGH from either lane; all valid MED/LOW folded or documented; the one cross-lane disagreement (Codex MED-1) resolved by code verification in favor of napi-parity + panic-prevention.

# Phase 6.4-3a `ql-udf` audit — SYNTHESIS

**Increment:** the new leaf crate `crates/ql-udf/` (UDF wire protocol + Arrow↔`Value` codec +
`UdfWorker` abstraction against an in-process mock). The Rust-only sliver of 6.4-3 (Python UDFs).
**Audited code:** engine `dce2e8bec3c` (6.4-3a code).
**Method:** parallel 2-way — Codex `gpt-5.5`/`xhigh` (`codex exec -s read-only`, crate-scoped) +
a fresh-context Opus reviewer (general-purpose agent). Lane outputs preserved at `lane-codex.out`
+ `lane-opus.md`. The auditor independently pre-confirmed the top HIGH (arrow `RecordBatch::column`
slice-OOB panic) at source before the lanes returned.

## The 2-way earned its keep (again)

Neither lane alone caught everything; the parallel discipline surfaced a net-new HIGH:

- **Codex ONLY — `call-return-missing-ids` (HIGH):** the `CALL`/`RETURN` frames carried ONLY the
  raw Arrow grid, with no `handle` (worker can't know which UDF to invoke) and no `call_id`
  (no response correlation / late-result drop / cancel — contract §6.2, exit test 6). Design §3
  specifies `CALL { handle, call_id, args }` / `RETURN { call_id, result }`. Opus + the auditor's
  pre-read both missed this entirely (focused on the decoder's panic-safety, not the absent
  payload structure).
- **Both lanes — `decode-short-columns-panic` (H1) + `decode-schema-not-validated` (H2):** the
  decoder indexed `batch.column(1..4)` with no column-count/schema guard. The auditor confirmed at
  source that arrow-array 58.3.0 `RecordBatch::column(idx)` is `&self.columns[index]` (slice OOB
  panic), so a worker-emitted RETURN with <5 columns panics the recompute thread (forbidden engine
  fault, design §5). The two `Utf8` columns (`str`/`err`) are also type-interchangeable → a
  reordered pyarrow batch silently mis-reads sigils as text.
- **Codex graded `decode-null-slot-coercion` HIGH; Opus graded it MED.** Both flagged it
  (No-Fallbacks: `value(i)` ignores the validity bitmap → `kind="number"` + null `num` silently
  decodes `0.0`). Reconciled HIGH (two independent lanes; it produces plausible-but-wrong values).
- **Opus ONLY:** M3 (`UdfError` taxonomy missing `Cancelled`/handshake), M4 (implicit arrow `ipc`
  feature), L2 (saturating-vs-checked mul), and the granular coverage gaps (untested `BadErrorSigil`/
  `MissingShape`/`BadShape` branches).

## Reconciled findings + dispositions

| ID | Codex | Opus | Reconciled | Disposition |
|----|-------|------|-----------|-------------|
| `call-return-missing-ids` (no handle/call_id on the wire) | HIGH | — | **HIGH** | FIXED — new `payload.rs`: `CallPayload{handle,call_id,args}` / `ReturnPayload{call_id,result}` codecs |
| `decode-short-columns-panic` (H1) | HIGH | HIGH | **HIGH** | FIXED — up-front `validate_grid_schema` before any positional access |
| `decode-schema-not-validated` (H2) | HIGH | HIGH | **HIGH** | FIXED — exact 5-field name+type+nullability validation (rejects reorder) |
| `decode-null-slot-coercion` | HIGH | MED | **HIGH** | FIXED — per-`kind` active-column `is_null` check → `NullPayload` |
| `nan-inf-leak` | MED | MED | **MED** | FIXED — decode rejects non-finite numbers (`NonFinite`) — most No-Fallbacks-honest |
| `extra-batches-dropped` | MED | LOW | **MED** | FIXED — `reader.next().is_some()` → `TrailingBatch` |
| arrow `ipc` feature implicit | — | MED | **MED** | FIXED — explicit `features = ["ipc"]` (no `default-features=false`: ignored-with-warning on inherited deps) |
| `UdfError` taxonomy (Cancelled/handshake) | — | MED | **MED** | FILED for 6.4-3b — documented in the `UdfError` doc + crate scope note |
| `write-too-large-report` | LOW | L4 | **LOW** | FIXED — `TooLarge(u64)` carries the actual length; read-side test pins it |
| `-0.0` weak assert | (folded) | LOW | **LOW** | FIXED — dedicated bit-exact (`to_bits`) test |
| saturating-vs-checked mul | — | LOW | **LOW** | FIXED — decode uses `checked_mul` (matches `ArrayValue::new`) → `ShapeOverflow` |
| missing negative tests | LOW | I3/I6 | **LOW→MED** | FIXED — +9 adversarial decode tests (short/reordered/null/non-finite/bad-sigil/missing+bad+mismatch shape/trailing) |
| frame layer / leaf-discipline | clean | I1 clean | — | CONFIRMED clean, no change |

**Verdicts:** Codex DO-NOT-SHIP; Opus SHIP-WITH-FIXES. Same fix set, different framing.
**Reconciled: SHIP-WITH-FIXES** — all actionable findings fixed this cycle; only the genuinely
forward `UdfError` taxonomy completion (M3, exercisable only with a real worker) is filed for 6.4-3b.

## Audit-fix changes (engine, `crates/ql-udf/`)

- **`codec.rs`** — decode rewritten as a hardened trust boundary: `validate_grid_schema` (exact 5
  fields by name+type+nullability) before any positional `column()` access (closes H1+H2);
  per-`kind` active-column null check (`NullPayload`); non-finite-number rejection (`NonFinite`);
  exactly-one-batch enforcement (`TrailingBatch`); `checked_mul` shape (`ShapeOverflow`). New
  `CodecError` variants: `BadSchema`, `TrailingBatch`, `ShapeOverflow`, `NullPayload`, `NonFinite`,
  `ShortHeader`. +9 adversarial decode tests + a bit-exact `-0.0` test (`negative_zero_round_trips_bit_for_bit`).
- **`payload.rs` (NEW)** — typed `CALL`/`RETURN` payloads (`[u64 LE handle][u64 LE call_id][grid]`
  / `[u64 LE call_id][grid]`) + `encode_call`/`decode_call`/`encode_return`/`decode_return` with
  short-header rejection (`ShortHeader`) + round-trip + truncation + bad-grid-propagation tests.
- **`frame.rs`** — `FrameError::TooLarge` now carries the actual `u64` length (symmetric read/write
  diagnostic); the oversized-length test asserts the carried value.
- **`worker.rs`** — `UdfError` doc records the deferred `Cancelled`/handshake variants (M3, 6.4-3b);
  the composition test now exercises the typed `CallPayload`/`ReturnPayload` and asserts `handle`
  + `call_id` survive the wire.
- **`lib.rs`** — `pub mod payload;` + re-exports; scope doc updated (decoder-as-trust-boundary,
  typed payloads, deferred taxonomy).
- **`Cargo.toml`** — explicit arrow `features = ["ipc"]` (leaf discipline + visibility).

## Verification (all green)

| Check | Result |
|-------|--------|
| `cargo test -p ql-udf` | **29/0** (was 15 → +14: payload round-trips/truncation, codec adversarial decodes, bit-exact `-0.0`) |
| `cargo clippy -p ql-udf --all-targets` | clean (0 warnings — fixed the `doc_lazy_continuation` from a `+`-leading doc line) |
| `cargo check --workspace` | clean (ql-udf joins via `members=["crates/*"]`; not yet a `default-member` — pulled in when ql-exec depends on it at 6.4-3c) |
| arrow inherited-dep `default-features` warning | resolved (dropped the ignored override; kept additive `features=["ipc"]`) |

## Still filed (non-blocking)

- **M3 — `UdfError` taxonomy completion (6.4-3b):** add `Cancelled` (distinct from `Timeout`) +
  handshake/protocol-version-mismatch variants once the real async pipe + `HELLO`/`HELLO_ACK` exist.
- **Real deadline/process-kill/no-late-commit coverage (exit test 6) is UNPROVEN here** (the mock
  can't reach it) — explicitly deferred to the 6.4-3b audit (Opus I4).
- **Carry-over from 6.4-2 (still open):** L2-OPUS `DepShape::LazyShape` `#[serde(alias)]` (6.4-3);
  I2-OPUS Phase-1.5 overlap `debug_assert` (6.4-3); L3-OPUS walker hot-path 2x HashMap-lookup (perf backlog).

## NEXT

**6.4-3b — real Python worker** (`quantbook-py` worker loop over stdio: spawn / `HELLO` handshake /
request-response / deadline→timeout-kill / respawn), implementing `UdfWorker` against this now-hardened
protocol + the typed payloads. Audit: 2-way (engine) + smoke against a real `python`. Then 6.4-3c
(eval wiring: `RegisteredFn::Udf` + `scalar.rs` arm + `Option<&mut dyn UdfWorker>` on the eval context;
re-examine 6.4-2 `register_udf` atomicity as a 3-way atomic), 6.4-3d (debugpy + trusted-workspace + IDE
bridge), then 6.4-4 exit tests (5-way megaudit, §10.4 tests 1-8).

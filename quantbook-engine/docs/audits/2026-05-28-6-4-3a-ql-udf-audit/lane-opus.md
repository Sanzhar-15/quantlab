# 6.4-3a `ql-udf` audit — OPUS LANE (fresh-context general-purpose reviewer)

Engine HEAD `dce2e8bec3c`. Scope: `crates/ql-udf/{lib.rs, codec.rs, frame.rs, worker.rs, Cargo.toml}`.
Audited as a real wire format a possibly-buggy/malicious Python (`pyarrow`) worker will speak.
Leaf-crate discipline: **CLEAN** (deps = `ql-types` + `arrow` `=58.3.0` + `thiserror`; no `ql-functions`/`ql-exec`).
**Verdict: SHIP-WITH-FIXES.**

## HIGH

### H1 · `decode_grid` panics on a RecordBatch with fewer than 5 columns · `codec.rs:191-195` (via `col` → `batch.column(idx)` at `codec.rs:175`)
`decode_grid` reads columns by positional constant (`COL_KIND=0 … COL_ERR=4`); `col` calls
`batch.column(idx)` which per arrow-rs 58.3.0 **panics if `index` ≥ `num_columns`** (`&self.columns[index]`).
The batch is produced by `StreamReader` from worker-controlled bytes (`codec.rs:184-185`), so a worker
emitting a 1- to 4-column batch panics `batch.column(1..4)`. This is the forbidden engine fault
(design §5 / exit tests 6+7): worker-controlled-byte paths must map to a deterministic cell error, never
a recompute-thread panic. Reachable TODAY via `decode_grid` (no subprocess needed).
**Fix.** Validate shape before any positional access: `if batch.num_columns() != 5 { return Err(CodecError::BadColumn("expected 5 columns")); }`, OR switch to name-based lookup (H2). Regression test: a <5-column IPC stream → `Err`, not panic.

### H2 · Columns trusted by positional index, not field name; `str` and `err` are both `Utf8` → silent mis-read · `codec.rs:69-73, 191-195`
Decode binds semantics to positions and `col::<T>` checks only the Arrow *type* at that index, not its
*name*. `str` (idx 2) and `err` (idx 4) are both `Utf8` → interchangeable by type alone. A real pyarrow
worker's column order is not guaranteed to match the Rust positional contract; a type-compatible
permutation makes decode silently read `text` payload from the `err` column (or sigils-as-text) with NO
error. Field names from `grid_schema` (`codec.rs:76-81`) are written but never checked on decode.
No-Fallbacks violation + latent data corruption the moment a real worker (6.4-3b) is written by anyone
other than this file's author.
**Fix.** Look columns up by name + assert name→type binding (`batch.column_by_name("kind").ok_or(BadColumn)…`).
Fixes H1 (no positional OOB) AND pins the schema contract. Test: permuted/renamed columns → `BadColumn`.

## MEDIUM

### M1 · Null data-slot under a non-null `kind` silently coerced to `0.0`/`false`/`""` · `codec.rs:211-213`
`Float64Array::value(i)`/`BooleanArray::value(i)`/`StringArray::value(i)` read the buffer WITHOUT
consulting the validity bitmap. Data columns are `nullable: true` (`codec.rs:77-81`). A worker sending
`kind="number"` + a NULL `num` slot yields silent `Value::Number(0.0)`; bool→`false`; text→`""`. No-Fallbacks
violation. **Fix.** Check `is_null(i)` per populated branch → loud `CodecError` (e.g. `NullPayload{kind,row}`).
Leave `blank` (all-null is legitimate). Test: `kind="number"` + null `num` → `Err`.

### M2 · NaN/Inf from the worker reaches the engine as raw, unsanitized `Value::Number` · `codec.rs:209-211`
Decode uses raw `Value::Number(num.value(i))` (comment: faithful bit-pattern round-trip), bypassing
`Value::number()`/`sanitize_f64`. A worker returning `nan`/`inf` arrives as unsanitized `Value::Number(NaN)`,
which the engine treats as a broken input that should be `Error(Num)`. Nothing in this crate records the
sanitization obligation, so 6.4-3c is liable to wire `RETURN`→`FunctionReturn` without sanitizing.
MED (not reachable as a fault yet; faithful transport is correct for a codec). **Fix.** Add an explicit
CONTRACT comment at `codec.rs:209` that the 6.4-3c eval adapter MUST sanitize via `Value::number()`; file
the obligation in the 6.4-3c plan. Optional bit-exact NaN round-trip test (`to_bits()`, since `NaN!=NaN`).

### M3 · `UdfError` taxonomy missing cancel-vs-timeout + handshake/version-mismatch · `worker.rs:21-38`
`UdfError = Raised | Timeout | WorkerDied | Codec`. No `Cancelled` (a hard cancel / `FrameType::Cancel`
collapses into `Timeout`/`WorkerDied`); no handshake/version-mismatch variant (`HELLO`/`HELLO_ACK`).
Exit test 6 wants a cancel diagnostic distinct from a timeout. Forward-concern (6.4-3b/3c), but the taxonomy
is the contract those cycles build against. **Fix (6.4-3b).** Add `Cancelled` + `Handshake{expected,got}`/
`ProtocolVersion`; document the taxonomy as intentionally incomplete pending 6.4-3b.

### M4 · arrow `ipc` feature dependency is implicit (umbrella defaults) · `Cargo.toml:25`
`arrow = { workspace = true }` relies on umbrella default features (incl. `ipc`). A future workspace-level
`default-features = false` would silently break this crate, and the hard `ipc` dependency isn't visible in
`Cargo.toml`. **Fix.** `arrow = { workspace = true, default-features = false, features = ["ipc"] }` (verify
`ipc` pulls `StreamReader`/`StreamWriter` deps), or at minimum a comment pinning the required feature.

## LOW

- **L1 · `-0.0` round-trip assertion is weak · `codec.rs:264`** — derived `PartialEq` compares `-0.0 == 0.0`
  true, so a sign flip / `-0.0`→`0.0` normalization passes undetected. Fix: assert `x.to_bits() == (-0.0f64).to_bits()`.
- **L2 · `saturating_mul` (decode `:198`) vs `checked_mul` (`ArrayValue::new` `:225`)** — defense-in-depth
  intact only because the 64 MiB frame cap bounds `num_rows`; different overflow policies for the same product
  is a latent inconsistency. Fix: use `checked_mul` in decode, explicit `ShapeMismatch` on overflow.
- **L3 · multi-batch IPC stream silently ignores trailing batches · `codec.rs:185`** — `reader.next().ok_or(Empty)??`
  reads only the first batch; doc says "exactly one" but code enforces "at least one". Fix: assert `reader.next().is_none()` else `Err`.
- **L4 · `MAX_FRAME_LEN` is global, not per-frame-type · `frame.rs:85,113`** — a 64 MiB `Cancel`/`Log` is accepted
  (minor DoS surface). Cap IS correctly checked before `vec![0u8; payload_len]` (✓). Defer per-type caps to 6.4-3b.

## INFO

- **I1 · Frame layer is genuinely solid.** clean-EOF→`Ok(None)` (`:106`); torn prefix→loud `Io(UnexpectedEof)`
  (`:144-147`, tested); zero→`ZeroLength` (tested); oversized→`TooLarge` BEFORE allocation (`:113` before `:120`,
  tested); unknown type→`UnknownType` (tested); LE symmetric; `read_exact_or_eof` handles `Interrupted` with no
  infinite loop; `u64→u32` cast guarded by the cap check; type byte via `read_exact` so a torn frame after a
  valid length errors (not mis-EOF). All correct.
- **I2 · `decode_rejects_unknown_kind_loudly` is honest** (`:324-342`) — real IPC stream, asserts `BadKind`.
- **I3 · `BadErrorSigil` decode path UNTESTED** (`:216-217`). Add `kind="error"` + bogus sigil → `BadErrorSigil`.
- **I4 · MockWorker timeout test is construction-only, correctly scoped** (`:133-137`) — zero coverage of real
  deadline/process-kill/no-late-commit (exit test 6), entirely deferred to 6.4-3b. Flag for the 6.4-3b audit.
- **I5 · `&mut self` on `UdfWorker::call`** (`:48`) — correct for a stateful process worker; forces
  `&mut EvalContext` threading at 6.4-3c (design §10 open-q 5). No defect; churn heads-up.
- **I6 · `MissingShape`/`BadShape` decode branches UNTESTED** (`:166-172`). Add: schema with no `rows` →
  `MissingShape`; `rows="abc"` → `BadShape`. (Branches correct by inspection; worker-forgets-metadata fails loud.)

## VERDICT: SHIP-WITH-FIXES
H1 must be fixed before 6.4-3c wires decode onto the recompute thread (reachable panic today). H2 should land
in the same change (name-based lookup eliminates H1's OOB and closes the silent text/sigil mis-read). Frame
layer solid; leaf-crate discipline clean. M1/M2 (No-Fallbacks null + NaN-sanitization obligation), M3 (taxonomy),
L1/L2/L3/I3/I6 (test-honesty/coverage) round out. None block 6.4-3a as a Rust-only sliver, but H1+H2 are
guaranteed defects once 6.4-3b/3c make the protocol real — fix now while the codec is the focus.

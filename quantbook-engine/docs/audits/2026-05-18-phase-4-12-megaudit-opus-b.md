# Phase 4.12 — Opus-B Defensive / Adversarial Audit Findings

**Branch:** `feat/quantbook-engine` HEAD `9134dad63a3`
**Auditor:** Opus-B (adversarial / defensive, engine-wide; XLSX scope owned by Phase 4.11)
**Method:** Five focused probe batches added under `tests/` with `#[ignore]`, run via
`cargo test ... -- --ignored --nocapture --test-threads=1`.

Probe files created (none modify production source):
- `crates/ql-formula-syntax/tests/p412_b_threaded_depth_probe.rs` — 64 MiB-stack threaded recursion thresholds
- `crates/ql-formula-syntax/tests/p412_b_pinpoint.rs` — 2 MiB-stack (cargo-test default) thresholds
- `crates/ql-oplog/tests/p412_defensive_oplog_probes.rs` — Loro snapshot corruption + replay recursion + out-of-bounds ops
- `crates/ql-io/tests/p412_qbook_corruption_probes.rs` — `.qbook/` envelope + sheet JSONL corruption

Existing Phase-4.12 probes that this audit also exercised:
- `crates/ql-formula-syntax/tests/p412_defensive_fuzz_probes.rs` (37 probes — pre-existing)
- `crates/ql-exec/tests/p412_function_arg_fuzz.rs` (15 probes — pre-existing)

Test-run logs (Mac host):
- `/tmp/p412-parser-safe.log` — 22 malformed/unicode/number probes (all green)
- `/tmp/p412-fnarg-fuzz.log` — 15 function-arg fuzz probes (15 green, 0 panic)
- `/tmp/p412-oplog-fuzz.log` — 10 oplog probes (all green)
- `/tmp/p412-qbook-fuzz.log` — 12 qbook corruption probes (all green)
- `/tmp/p412-b-threaded.log` — partial (64 MiB stack handles paren≤5000; paren=10000 likely hangs even with 64 MiB)
- `/tmp/p412-b-pinpoint.log` — partial (2 MiB stack succeeds at fn-call 100, hangs at 200)
- `/tmp/p412-parser-fuzz.log` — captured the deep-nesting crash (process killed at `deep_function_call_1000`)

---

## HIGH

### H-1. Parser has no recursion-depth limit; default 2 MiB thread stack overflows around 200 nested function calls

**Files:**
- `crates/ql-formula-syntax/src/parser.rs:138` (`parse()`) and `:175` (`parse_expr()`)
- `crates/ql-formula-syntax/src/parser.rs:500-510` (Token::LParen → `parse_expr(0)`)

**Repro:** A 200-deep nested `SUM(SUM(...SUM(1)))` evaluated through `parse(lex(s))` on the default cargo-test (2 MiB) thread stack hangs the test binary — no `parse_function_call[200, 2MiB stack]` line ever lands in `/tmp/p412-b-pinpoint.log`; the test process drops to 0% CPU with ~4 MiB RSS, characteristic of SIGSEGV-on-stack-overflow that `panic::catch_unwind` does NOT recover from. The pre-existing `deep_function_call_1000` probe in `p412_defensive_fuzz_probes.rs` does the same thing on the test-binary's main thread, killing the whole binary (no output past "deep_function_call_1000 ..." in `/tmp/p412-parser-fuzz.log`). On a 64 MiB stack the parser handles 5000-deep nesting fine (`deep_function_call[5000]: Ok` in `/tmp/p412-b-threaded.log`).

**Why HIGH:**
- The parser `parse_expr` → `parse_prefix` chain has *zero* recursion gating. `Token::LParen` arm at `parser.rs:500` blindly calls `self.parse_expr(0)?`.
- Production callers can hit the parser from threads with stacks well under 2 MiB (async runtime tasks default to 2 MiB on Tokio; spawning workers with `thread::Builder::default()` gives 8 MiB on Linux but 2 MiB on macOS).
- Excel's own canon caps nesting at 64 levels — the engine accepts arbitrarily deep without bound.
- A malicious or accidentally-corrupted `.qbook` (formula text in a sheet JSONL line) crashes the loading process via load_workbook → recompute_all → parse.

**Fix sketch:** Add an explicit depth counter in `Parser` (e.g., `depth: u32`, bumped in `parse_expr` / `parse_prefix`, rejected at e.g. 256) and emit a new `ParseError::DepthExceeded` variant. Pick the cap to safely fit a 2 MiB stack with the current per-frame footprint plus 4× safety; Excel's own canon (64) is a reasonable floor.

---

### H-2. `WorkbookRuntime::recompute_all` silently produces wrong values for cyclic formulas (no #CIRC! emission)

**Files:**
- `crates/ql-exec/src/workbook_runtime.rs:2993-3057` (`recompute_all`)
- `crates/ql-exec/src/workbook_runtime.rs:16` (doc says "no graph awareness" but never says "no cycle detection")

**Repro:** `crates/ql-exec/tests/p412_function_arg_fuzz.rs::self_referential_formula_direct` and `::two_cycle_a1_b1` — both ran in `/tmp/p412-fnarg-fuzz.log`:
```
test self_referential_formula_direct ... self_referential_formula_direct: OK: Number(1.0)
post-recompute A1 = Number(2.0)
test two_cycle_a1_b1 ... two_cycle_a1_b1: A1=OK: Number(1.0) B1=OK: Number(0.0)
post-recompute A1=Number(1.0) B1=Number(0.0)
```
Compare to the SCC-aware path which gets it right:
```
test two_cycle_a1_b1_with_graph ... post-recompute_dirty A1=Error(Circ) B1=Error(Circ)
```

**Why HIGH:**
- A `=A1+1` formula in cell A1 evaluates to `1.0` on `set_formula`, then `2.0` on first `recompute_all`, then `3.0` on the next, etc. Every recompute mutates the value. This is silent corruption — there is no #CIRC! error to alert the user.
- `recompute_all` is the path replay drives (see `crates/ql-oplog/src/replay.rs` module docstring §5 — replay does not re-evaluate; the caller follows up with `recompute_all`). So a `.qbook` with a cyclic formula loads, replays cleanly, then on first compute returns wrong numbers.
- The module docstring (`crates/ql-exec/src/workbook_runtime.rs:16`) describes `recompute_all` as "legacy HashMap-order full pass; no graph awareness" but does not mention the silent-cycle consequence. Callers reading the doc cannot infer "if your workbook has a cycle you will get garbage numbers instead of #CIRC!".

**Fix sketch (no-fallback compliant):** Either (a) make `recompute_all` panic-loud-fail when a self-reference / cycle is detectable cheaply (e.g., a single-formula-references-its-own-cell guard), or (b) deprecate `recompute_all` and force replay callers through `recompute_dirty`, OR (c) keep behavior but document it explicitly with the silent-corruption consequence called out. Option (c) alone is the bare minimum — current docs hide the failure mode.

---

### H-3. `Op::BatchCommit` replay recurses through `apply_op` with no depth guard; serde_json's *default* recursion limit (128) is the only thing standing between the producer and a stack overflow

**Files:**
- `crates/ql-oplog/src/replay.rs:490-499` (`Op::BatchCommit { ops } → for inner_op in ops { apply_op(inner_op, …, index)? }`)
- `crates/ql-oplog/src/op.rs:144` + comment at `:142-143` (`Nested BatchCommits are permitted by the schema but produced nowhere in production; replay handles them via recursion.`)

**Repro:** `crates/ql-oplog/tests/p412_defensive_oplog_probes.rs::replay_deeply_nested_batch_commit` ran in `/tmp/p412-oplog-fuzz.log`. A depth-100 nested `BatchCommit` already trips serde_json's default recursion limit at `OpLog::iter`/`replay_into`:
```
replay_deeply_nested_batch_commit[depth=10]: Ok(Ok("ok (1 ops applied)"))
replay_deeply_nested_batch_commit[depth=100]: Ok(Err("ReplayError: replay deserialize error at op index 0: op log deserialize error at op index 0: recursion limit exceeded at line 1 column 1856"))
```

**Why HIGH (not lower) despite the serde_json safety net:**
- The op-log layer's design comment at `op.rs:142` explicitly says "Nested BatchCommits are permitted by the schema but produced nowhere in production; replay handles them via recursion." That's an *intentional* defensive gap — relying on serde_json's *default* recursion limit to bound stack depth is an implicit dependency. Two ways this fails today or in the future:
  1. **serde_json default can change.** It was 128 historically; if upstream changes it (it's runtime-configurable via `serde_json::de::Deserializer::disable_recursion_limit()`), the engine inherits whatever they pick.
  2. **The op-log's wire format could change** away from `JSON-in-Loro-string` to e.g. raw Loro containers (already hinted at by `log.rs:6-14`) — at that point the JSON safety net evaporates and `apply_op` recurses unbounded.
- The defense is in the wrong layer. Replay should have its own depth guard regardless of wire format.

**Fix sketch:** Pass a depth counter through `apply_op` (currently `apply_op(op, workbook, index)`), bump on `BatchCommit`, return `ReplayError::DepthExceeded { index, depth }` past e.g. 64. Producer-side path already flat-only, so the cap doesn't restrict legitimate use.

---

### H-4. Lexer accepts NUL (`\u{00}`) inside string literals — silent data smuggling into round-trip output

**Files:**
- `crates/ql-formula-syntax/src/lexer.rs` — string literal lex path (no explicit NUL rejection)
- Recorded in `/tmp/p412-parser-safe.log`:
  ```
  test unicode_nul_in_string ... unicode_nul_in_string: Ok(Ok(String("foo\0bar")))
  ```

**Why HIGH:**
- Most adjacent ecosystems (TOML, JSONL, XLSX shared-strings, C interop) treat NUL as either invalid or string-terminating. The engine round-trips it transparently through parse → eval → save → load.
- A maliciously-crafted formula like `="cell\0name"` could:
  - Truncate strings when passed to C bindings (`ql-bindings-c/`) — silent data loss on the boundary.
  - Mis-render in display surfaces that treat NUL as terminator.
  - Smuggle invisible content past UI filters (search, sort, validation rules).
- The lexer rejects `\u{a0}` (NBSP), BOM, ZWJ, combining diacritics as `unexpected character`, but waves NUL through. Asymmetric: nothing about NUL is more legitimate than NBSP in a formula source.

**Fix sketch:** Add NUL (`\0`) to the lexer's reject list for string literals (and idents/sheet names if not already covered), surfacing a typed `LexError::ControlCharInString { codepoint: 0 }` or similar.

---

## MEDIUM

### M-1. Parser `deep_paren` 5000+ on 64 MiB stack is fine, but `deep_paren_thresholds[10000]` hangs the test binary on macOS even with a 64 MiB stack

**Files:** `crates/ql-formula-syntax/src/parser.rs:500-510` (LParen arm).

**Repro:** `/tmp/p412-b-threaded.log` shows progress up to `deep_paren[5000]: Ok`, then nothing — the next iteration is `deep_paren[10000]`, and the test process drops to 0% CPU at 70 KiB RSS. With a 64 MiB stack each parens layer is consuming ~6 KiB on average (combined `parse_expr` + `parse_prefix` frames + the LBrace/LParen advance, plus the captured `Expr` build-up on the heap), which puts 10 000 levels just past the per-thread stack ceiling. This is essentially the same defect as H-1 (no depth limit) at a different threshold. Captured separately as M because most production callers do not run with 64 MiB stacks, so H-1 dominates.

**Fix:** Same as H-1.

---

### M-2. `recompute_all` does not match `recompute_dirty`'s `BindError::UnknownTable` → `#NAME?` rewrite for *cycles*

**Files:** `crates/ql-exec/src/workbook_runtime.rs:3013-3030` (the `recompute_all` UnknownTable shim) vs the matching path in `recompute_dirty`.

**Symptom:** `recompute_all` has special-cased `UnknownTable` / `UnknownTableColumn` to emit `#NAME?` (a previously-closed HIGH from W5-156), proving that the legacy path can map a bind-time error to a typed sigil. The same special-case is **not** present for self-references / cycles, so cycles silently produce numerics (see H-2). The fix shape exists in the codebase already; cycles just weren't included.

---

### M-3. Op-log `import_byte_flipped_snapshot` always returns "ok=false" (typed Loro error) — but `import_truncated_snapshot[cut=bytes.len()-1]` also returns "ok=false". Edge: this exposes nothing exploitable, but indicates byte-flip detection is binary (any-flip → fail), not localized

**Files:** `crates/ql-oplog/src/log.rs:138-144` (`import_bytes` — wraps Loro's `LoroDoc::import`).

**Why M:** Defensive surface is acceptable today (every malformed snapshot returns `OpLogError::Loro(...)` rather than panicking). The note is for future hardening: if Loro adds checksumming or zstd payload framing changes upstream, the wrapper here is a thin pass-through and might miss class-shifting changes (e.g. format magic-byte added later — the wrapper doesn't sniff anything itself). Add an explicit min-bytes/magic-bytes pre-check at the wrapper layer to make the failure mode independent of Loro internals. Not a bug right now; defensive depth.

---

### M-4. `qbook_format::load_workbook` `envelope_truncated[cut=len-1]` returns `Ok` — the TOML parser succeeds when only the last byte is shaved

**Files:** `crates/ql-io/src/qbook_format.rs:1617` (`fs::read_to_string(&toml_path)`).

**Repro:** `/tmp/p412-qbook-fuzz.log`:
```
envelope_truncated[cut=0]: Ok(false)
envelope_truncated[cut=1]: Ok(false)
envelope_truncated[cut=8]: Ok(false)
envelope_truncated[cut=32]: Ok(false)
envelope_truncated[cut=66]: Ok(false)
envelope_truncated[cut=132]: Ok(true)   ← last-byte trim still loads
```
**Why M:** The envelope is TOML which is largely whitespace-tolerant, so dropping a trailing newline (typical "last byte") still parses. The bigger picture: there's no envelope-level checksum, so a flipped byte in the *middle* of `workbook.toml` that happens to keep TOML syntactically valid would load to a silently-wrong workbook. The existing two-phase load (`SchemaVersionProbe` first, then `WorkbookEnvelope` with `deny_unknown_fields`) is good defense against schema drift but not against value corruption.

**Fix sketch:** Add a content-hash sidecar (`workbook.toml.sha256`) written atomically with the envelope; cross-check at load. Out of scope for this audit; documented as defensive depth.

---

## LOW

### L-1. `panic::catch_unwind` does NOT recover from stack overflow on macOS, defeating the existing parser fuzz probes' isolation
**Files:** `crates/ql-formula-syntax/tests/p412_defensive_fuzz_probes.rs` — the `try_parse` wrapper uses `panic::catch_unwind` but doesn't isolate to a separate thread. When `deep_function_call_1000` overflows the test-binary main-thread stack, the whole binary aborts — no assertion ever runs, and all subsequent tests in the file silently skip. Engineering note for future fuzz work: every recursion probe must run inside a `thread::Builder::default().spawn(...)` so the overflow is contained.

### L-2. `iterative_kernels_near_singular::CHISQ.INV(0, 5)` returns `Number(0.0)` while `NORM.INV(0, 0, 1)` returns `Error(Num)`
**Files:** `crates/ql-functions/src/...` chisq vs norm dispatchers (precise file in `crates/ql-functions/src/registry.rs` registration).
**Repro:** `/tmp/p412-fnarg-fuzz.log`:
```
[p=0 → expect -Inf or #NUM!] NORM.INV(0, 0, 1) → OK: Error(Num)
[p=0]                       CHISQ.INV(0, 5)    → OK: Number(0.0)
```
Cross-distribution boundary handling is inconsistent (NORM.INV at p=0 is `#NUM!`, CHISQ.INV at p=0 is the lower-bound real value). Both are arguably defensible (Excel canon varies). Note for cross-function uniformity audit, not a bug.

### L-3. `IRR({-1, 1})` returns `Error(Value)` not `Error(Num)`
**Repro:** `/tmp/p412-fnarg-fuzz.log` shows `IRR({-1, 1}) → OK: Error(Value)`. Trivial 2-point should converge to `0%` (root at `r=0`) or surface `#NUM!`. `#VALUE!` is the wrong sigil class. Tag for Codex's correctness sweep; defensive-side, no crash.

### L-4. `BindError::UnsupportedVariant` message includes a long historical-trail explanation that may not be appropriate to bubble up to end users
**Files:** Bind-error display path. From `/tmp/p412-fnarg-fuzz.log`:
```
literal RangeRef in non-Function context is unsupported in v1; use a named range
(Phase 2B.4 AggregateNameRef) or wrap in an aggregate function.
(Updated W5-108 / Phase 4.7.O; original Phase 0 W4-1 message referenced ...)
```
The error string carries internal phase / workitem references. Fine for dev logs; should not surface to spreadsheet users.

### L-5. `PERCENTILE({}, 0.5)` surfaces a `ParseError: empty array literal '{}' is not allowed` — but the user wrote a function call, not raw `{}`
**Repro:** `/tmp/p412-fnarg-fuzz.log` — error message names the array literal rule (correct mechanistically) but doesn't explain that PERCENTILE got an empty argument. Minor UX wording.

---

## NOT FOUND (probes ran clean — useful for next reviewer)

- No PANICs across 15 function-arg fuzz probes (NaN/Inf/subnormal/Inf-overflow/empty-array variants of ABS/SIGN/SQRT/EXP/LN/LOG10/LOG/ROUND/MROUND/SIN/COS/TAN/ASIN/ACOS/ATAN/SINH/COSH/TANH/FACT/GAMMA/IF/IFERROR/IFNA/BITAND/BITOR/BITLSHIFT/DEC2BIN/DEC2HEX/GAMMALN). Every weird input surfaces a typed Error variant.
- No PANICs across 22 parser malformed/unicode probes — every bad input returns typed `LexError` or `ParseError`.
- No PANICs across 12 `.qbook` corruption probes — every form of corruption (truncated TOML, random bytes, wrong schema version, malformed JSONL, missing files, not-a-directory) surfaces a typed `QbookError`. Two-phase load (probe schema_version first, then deserialize with `deny_unknown_fields`) is doing its job.
- No PANICs across 10 op-log defensive probes — `OpLog::import_bytes` of random / truncated / byte-flipped / zero-length / 16 MiB-zero inputs all return typed `OpLogError::Loro(DecodeError(...))`. `replay_into` with `u32::MAX` coords or nonexistent sheet returns typed `ReplayError`. Out-of-bounds format-id surfaces `ReplayError::FormatNotRegistered`.
- 10 000-cell linear dependency chain (`A1=1, A2=A1+1, …, A10000=A9999+1`) recomputes cleanly in `recompute_all` — no stack overflow in eval, no n²-explosion runtime.
- 1 M cells via `SUM` arg-list (`SUM(1, 1, 1, …)` 1000 args; `sum_whole_column_million_cells_sparse`) — clean Error(Bind) until v2 named-range support lands.

---

## Net assessment

Engine-wide defensive posture is **strong on data-corruption surfaces (qbook + oplog)** and **weak on recursion-depth surfaces (parser + replay)**. The four HIGHs cluster around the same idiom: trusting the call stack to bound recursive descent.

The pattern to fix once for everything: explicit depth counters at recursion boundaries (`Parser::parse_expr`, `apply_op` for `BatchCommit`), surfacing `*::DepthExceeded` typed errors rather than depending on stack-size-as-DoS-budget. Cycles should also be detected and emit `#CIRC!` in the legacy `recompute_all` path, not just the SCC-aware `recompute_dirty` path — replay drives the legacy path today.

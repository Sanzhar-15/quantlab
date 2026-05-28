# Phase 6.4-2 cycle-2 audit — SYNTHESIS

**Increment:** engine trait wiring + napi DTO surface for
`register_function` / `unregister_function` / `list_functions`.
**Audited code:** engine `f8eeaaeadfe` (cycle 1 CODE), IDE `739b625b4fd` (allowlist).
**Audit-fix commit:** (this commit).
**Method:** parallel 2-way — Codex `gpt-5.5`/`xhigh` (`codex exec -s read-only`, engine-scoped)
+ fresh-context Opus reviewer (engine + cross-repo IDE). Lane outputs preserved at
`lane-codex.out` + `lane-opus.md`.

## Verdicts
- **Codex:** DO-NOT-SHIP (HIGH 2, MED 1, LOW 4).
- **Opus:** SHIP-WITH-FIXES (HIGH 1 + 1 HIGH doc-honesty same-root, MED 3, LOW 2).
- **Reconciled:** SHIP-WITH-FIXES after closing **2 HIGHs**. All findings below FIXED this commit.

## Why 2-way earned its keep this cycle
The usual pattern (Opus catches what Codex's repo-scoping misses) **inverted** here:
- **H1 (bad-name FFI panic)** — BOTH lanes found it independently. Opus added the decisive
  detail neither the author nor Codex stated: the panic fires while the **FaultGuard is armed**,
  so one bad JS input permanently seals the session `Faulted`. Opus also empirically confirmed
  the panic via a `catch_unwind` probe.
- **F2 (open/import graph built against a UDF-free registry)** — **Codex-only**. Opus graded the
  `Arc::make_mut` question (Scope 2) CLEAN and did not examine the `from_workbook` adoption path.
  Codex caught the divergence. Neither lane alone caught both HIGHs.

## Findings → dispositions

```
ID    Codex   Opus        Reconciled   Disposition
H1    F1 HIGH H1/H2 HIGH  HIGH (block) FIXED — validate canonical_name at the trait boundary
F2    F2 HIGH (missed)    HIGH (block) FIXED — from_workbook_with_registry adoption helper
F3    F3 MED  L2 LOW      MED          FIXED — strict ArityJson tagged union
M1    F5 LOW  M1 MED      MED          FIXED — dirties test proves fn_gen bump + dirty fanout
M2    F7 LOW  M2 MED      MED          FIXED — aggregate test pins NamedRangeInScalarContext
M3    F6 LOW  M3 MED      MED          FIXED — duplicate test asserts udf_handle directly
F4    F4 LOW  —           LOW          FIXED — ArityJson doc: undefined/absent, not null
L1    —       L1 LOW      LOW          FIXED — folded into M1 (trait-level fn_gen bump test)
```

### H1 — bad canonical_name PANICS across the napi boundary + doc lie (HIGH, blocking)
`function_metadata_from_json` forwarded `canonical_name` unchecked; `register_function` →
`register_udf` → `register_metadata`, whose `assert!`s (`registry.rs:357` empty, `:361` lowercase)
panic. napi has no `catch_unwind` (`lib.rs:19`) → the panic aborts/wraps as a generic JS Error
WITHOUT the `[code]` prefix, so the IDE `parseQuantbookError` classifies it `unknown` (breaks the
wire contract the allowlist depends on). Worse, the panic unwinds through the **armed FaultGuard**
→ session sealed `Faulted` permanently. The napi docstring (`lib.rs:4747`) falsely claimed this
surfaced `[bad_argument]`. Empirically confirmed by Opus (catch_unwind probe). Wholly untested
(smoke fixture used only uppercase "MYUDF").
**Fix:** new free fn `validate_canonical_function_name` called at the top of
`register_function` (before the FaultGuard is armed) — empty/lowercase → `EngineError::bad_argument`
(No-Fallbacks: a caller-contract violation surfaces, it is NOT silently normalized). The two
registry asserts become genuine unreachable invariants for the trait path. Docstring rewritten.
New `register_function_rejects_lowercase_or_empty_canonical_name_with_bad_argument` Rust test +
smoke negatives, both pinning the structured error AND the no-seal property (a valid registration
after rejected ones still succeeds).

### F2 — open/import rebuild the graph against a fresh UDF-free registry (HIGH, blocking)
`from_workbook` constructs a fresh `default_registry()` (UDF-free) and builds the graph against
it. The `open`/`import` adoption sites did `*self = from_workbook(wb); self.registry = preserved`,
leaving the graph extracted UDF-free while `self.registry` is UDF-aware — a graph⊥registry
divergence the increment introduces (pre-6.4-2 the registry was always builtin-only, so no drift
was possible). Same class as the 6.4-0 H2 / 6.4-1 H1 fixes; the adoption-site variant was the gap
those sweeps missed. **Live manifestation refined:** `open` self-heals via its post-swap
`recompute_all` (which rebuilds the graph against `self.registry`); **xlsx `import` does NOT
recompute after the swap**, so its graph stays divergent. CSV has no formulas.
**Fix:** new `from_workbook_with_registry(workbook, Arc<FunctionRegistry>)` builds the graph
against the caller-provided registry; `from_workbook` delegates to it with a fresh default. All
three adoption sites (`open`, xlsx `import`, csv `import`) now adopt via the helper (also removes
`open`'s wasteful double graph build). New
`from_workbook_with_registry_threads_udf_metadata_into_graph` test proves it: a `B1=MYVOL(A1)`
volatile-UDF workbook adopted with the UDF-aware registry lands B1 in the graph volatile set;
adopted with a fresh default registry it does NOT (the divergence the fix prevents).

### F3 — ArityJson not a strict tagged union (MED)
`arity_from_json` silently ignored extraneous fields (`{kind:"variadic", n:7}`, `{kind:"fixed",
n:3, min:5}`) — silent normalization, a No-Fallbacks violation. **Fix:** reject extraneous payload
fields per `kind`, and reject inverted ranges (`max < min`); doc updated. Smoke negative added.

### M1 — `register_function_dirties_dependent_formulas` was a false-positive (MED)
Asserted `#NAME?` before AND after + recalc `Completed` — a no-op recalc satisfies all three, so
it proved nothing about the fanout. **Fix:** assert `fn_generation()` bumped exactly once through
the trait (the H3 wire — also closes L1, which noted no trait-level fn_gen test existed) AND that
`graph.dirty_formulas()` grew after registration (the fanout actually fired).

### M2 — aggregate test pre-check accepted any error (MED)
`pre_rejected = pre.is_err() || cell-has-error` could pass for an unrelated failure. **Fix:**
`set_formula` returns `Err(Compute/formula_bind)` for the bind failure (verified at `:1336`);
assert that specific code + a message containing "scalar position" and the range name "MYRANGE"
(the `NamedRangeInScalarContext` display).

### M3 — duplicate test overclaimed handle-landing (MED)
`list_functions` returns metadata, not handles, so the metadata-count check could not prove handle
2 landed. **Fix:** assert `s.registry.udf_handle("MYUDF")` directly — `Some(1)` after the rejected
duplicate, `None` after unregister, `Some(2)` after re-register.

### F4 / L1 (LOW) — FIXED
F4: ArityJson doc now states optional fields must be OMITTED/`undefined`, never `null` (napi
`Option<T>` rejects `null` with `NumberExpected` before the mapper). L1: folded into the M1
fn_gen assertion.

## Items verified CLEAN (no fix needed) — from the Opus lane
Arc::make_mut soundness (Scope 2: no stored registry clone; calcgraph borrows `&FunctionRegistry`;
strong_count==1 at mutation), case consistency (Scope 1), register_udf atomicity (Scope 3),
FaultGuard happy/Conflict path (Scope 4), lifecycle gates (Scope 5), symmetric handle clearing
(Scope 6), enum mappers exhaustive+inverse (Scope 7), ArityJson value round-trip + BigInt checks
(Scope 8), No-Fallbacks (Scope 11), IDE cross-repo allowlist (both codes in union + Record; engine
Display `[{code}] {message}` matches the IDE regex; tsc clean; mapper exhaustive over the closed
enum).

## Verification (all green, post-fix)
- `cargo check --workspace`: clean.
- `cargo test -p ql-exec --lib` (default + `--features xlsx-write`): **755/0** (753 + 2 new).
- `cargo test -p ql-exec --tests`: all 18 integration suites green.
- `cargo test -p ql-functions --lib`: **1824/0** (unchanged — registry untouched this cycle).
- `cargo clippy -p ql-functions -p ql-exec -p ql-session -p ql-bindings-node --all-targets`:
  clean for edits.
- `node crates/ql-bindings-node/tests/smoke_session.mjs` through a freshly-built cdylib: PASS
  (incl. the new lowercase/empty-name + strict-arity negatives + the no-seal-after-reject check).

## Still filed (non-blocking, deferred)
- L2-OPUS `DepShape::LazyShape` `#[serde(alias)]` wire-compat (6.4-3 housekeeping).
- I2-OPUS Phase-1.5 overlap `debug_assert` (6.4-3 housekeeping).
- L3-OPUS walker hot-path 2x HashMap-lookup collapse (6.4 perf backlog).

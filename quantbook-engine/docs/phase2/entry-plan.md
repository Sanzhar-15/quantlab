# Phase 2 Entry Plan — Quantbook Engine

**Date last touched:** 2026-05-12 (Phase 2A.13 / megaudit cycle-3 closure)
**Branch:** `feat/quantbook-engine` (HEAD is the 2A.13 commit — current as of session end; check `git log -1` for the exact SHA)
**Audience:** the next session (and you, if you come back to this cold)

---

## Read this first (60 seconds)

**Phase 2A is complete.** The engine has shipped Phase 0 + Phase 1 + all of Phase 2A.1-.13. Two megaudit cycles ran (cycle 1: 2A.6 + closure 2A.7-.12; cycle 3: verification + 2A.13 fixes). The full audit findings are documented and almost entirely closed.

The Quantbook engine can:

1. Lex/parse/print Excel-canonical formula source (round-trip property tested).
2. Bind + evaluate scalar formulas with **Excel-canon coercion** (lenient text-to-number per 2A.9 M1) and **Excel-canon cross-type comparison** (Number < Text < Bool, 2A.9 M2).
3. SIMD-bulk-evaluate region-style operations (OG-02 hot path: 3.4 ms for 25M `=A*2`). **Division NOT lowered to SIMD** per 2A.9 H5 — goes scalar to emit Excel-canon `#DIV/0!`.
4. Persist multi-sheet workbooks to `.qbook/` directories with **schema v2**: NameTable persistence (2A.8 M12), Pending CellWireValue (2A.8 M11), `deny_unknown_fields` strictness, crash-safe atomic save via target↔backup-rename protocol (2A.8 H2 + 2A.13 H1 marker file). v1 fixtures still load with a one-line `eprintln!` warning on legacy `#NULL!+formula` migration.
5. Live-formula loop: `WorkbookRuntime::set_formula(sheet, row, col, text)` does lex→parse→bind→eval→persist in one call. Cell bounds validated at entry per 2A.7 H1 + 2A.13 H2.
6. Defined names round-trip through save/load. AI() reserved name refused at registration per 2A.9 M6.
7. Formula fingerprints are SipHash-2-4 keyed `(0, 0)` — stable across Rust toolchain bumps, locked by 29 golden tuples per 2A.10 + 2A.13 H3.

**~480 tests, all 7 gates green** (fmt / clippy / workspace tests / pin guard / build flags / multiversion clones / cargo audit).

The Phase 2 exit packet (`docs/phase2/exit-packet.md`) has the full story. This document is your **action-oriented entry point** — what to do first.

---

## Verify your starting state (5 minutes)

```bash
cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
git rev-parse --abbrev-ref HEAD                # expect: feat/quantbook-engine
git log --oneline -1                            # latest 2A.13 commit
git log --oneline -15                           # last ~13 commits = the 2A.7-.13 closure cycle
test -L node_modules || ln -s /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/node_modules node_modules

mac zsh -lc 'source "$HOME/.cargo/env" && \
  cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && \
  cargo fmt --all -- --check && \
  cargo clippy --workspace --all-targets --offline -- -D warnings && \
  cargo test --workspace --offline 2>&1 | grep "^test result" | awk -F"[ .;]+" "{ p += \$4; f += \$6 } END { print \"passed=\" p \" failed=\" f }" && \
  bash scripts/check-cargo-lock-pins.sh && \
  bash scripts/check-build-flags.sh && \
  bash scripts/check-multiversion-clones.sh && \
  cargo audit'
```

Expected:
- fmt clean
- clippy clean
- ~480 tests passed, 0 failed
- pin guard: 18 watched packages aligned
- A3 build flags clean
- A2 NEON `fmul.2d` multiversion clones present
- cargo audit clean (178 crates)
- A2 disassembly: 20 NEON `fmul.2d` (or equivalent x86_64 AVX2 instructions on Linux CI)

If any of these diverge, **STOP and investigate** before any new work. The engine should be in a clean state.

---

## What's done (don't redo)

Phase 0 (13/13 acceptance gates LOCKED):
- OG-01 / OG-02 / OG-03 / OG-04 / OG-05 / OG-06 / A1 / A2 / A3 / A4 / A5 / A6 / A7

Phase 1 engine-side (10 commits W5-1..W5-10 + 1 audit fix W5-7 + 1 doc):
- Pratt parser + AST printer + round-trip property
- First E2E integration test
- AI() runtime sentinel
- Timings struct + OG-06 fully closed (schema v2)
- `.qbook/` directory format (TOML envelope + JSONL per sheet)
- Atomic save with temp-dir + rename
- NaN/Inf save-side validation
- Workbook formula storage (formula_cells map)
- WorkbookRuntime live-formula facade

See `docs/phase1/exit-packet.md` for the full close-out.

---

## Two parallel tracks for Phase 2

The Phase 0 exit packet's "Phase 1" sequence had IDE integration as the gating real-world ship. That's still pending — it lives in `extensions/quantlab/` (TypeScript work, **different working tree**), not the engine repo.

Engine-side, Phase 2 splits into independent tracks:

### Track A — Engine collaboration foundation (~10 days)

Loro CRDT integration, op log scaffolding, multi-cell transaction API. This is engine work; you can do it here.

### Track B — IDE integration (~5 days)

Wires the engine's `WorkbookRuntime::set_formula` to the VS Code formula bar. **Not engine work — different repo.**

If the user asks "what's next?", default to Track A. If they specify "IDE" or "workbench", they want Track B (which is a different session entirely).

---

## Track A: engine-side Phase 2 — suggested sequence

### Phase 2A.1 — Named ranges + `Expr::NameRef` ✅ DONE (2026-05-12)

**Closed audit H2's deferred path.** Bare identifiers (4+ letter) now parse to `Expr::NameRef(name)` and resolve through the workbook's `NameTable` at bind time. Unresolved names surface as `BindError::UnresolvedName`. See commit message for Phase 2A.1 / W5-11.

**What shipped:**
1. `Expr::NameRef(Arc<str>)` variant in `ql-formula-syntax::ast` — updated `parser`, `printer` (round-trips as bare name), `fingerprint` (discriminant `10u8`).
2. Parser bare-identifier branch now emits `NameRef` (canonicalized upper-case) instead of `ParseError::Unexpected`. `TRUE`/`FALSE` remain explicit boolean exceptions.
3. `BindError::UnresolvedName(Arc<str>)` variant added.
4. New `pub trait NameLookup` + `pub enum ResolvedName` in `ql-exec::plan`; new `pub fn bind_with_names<L: NameLookup>(...)` — original `bind(...)` delegates to it with an empty lookup for back-compat.
5. `impl NameLookup for NameTable` lives in `ql-exec::env` (bridges ql-storage's `NameTable` to ql-exec's `NameLookup` trait without coupling the crates). Named-range cell targets resolve with `abs=(true,true)` per Excel canon.
6. `ql-storage::NameTable` replaced its Phase 0 stub with real HashMap-backed storage. New `Workbook::set_name(name, target)` uppercases names for canonical lookup.
7. `WorkbookRuntime::set_formula` + `recompute_all` both call `bind_with_names(&expr, sheet, self.workbook.names())`.
8. Tests added: 7 runtime tests (Cell / Number / Boolean / Text / unresolved → `UnresolvedName` / Range → `UnsupportedVariant` / mixed-case canonicalization), 2 parser tests (`parse_bare_identifier_*_to_name_ref`).

**Deferred to Phase 2B+:** named-range targets in aggregate context (`SUM(Sales)`), named-formula targets (`Profit = Revenue - Costs`), sheet-scoped names (`Sheet1!Local`).

**Spec reference:** `_QUANTBOOK-v1-SPECIFICATION.md` Part V §3 + Round 7 T2-D02 (defined names).

### Phase 2A.2 — Multi-cell transaction API ✅ DONE (2026-05-12)

**Shipped** in `quantbook-engine/crates/ql-exec/src/transaction.rs`. The IDE's "paste a block" path goes through one `WorkbookTransaction` instead of N individual `set_value` calls; the eventual op log (2A.3) gets one entry per transaction commit.

**API (final):**
```rust
pub struct WorkbookTransaction<'a> { /* &mut Workbook + &FunctionRegistry */ }

impl<'a> WorkbookTransaction<'a> {
    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self;
    pub fn put_value(&mut self, sheet, row, col, value: Value);
    pub fn put_formula(&mut self, sheet, row, col, text) -> Result<(), RuntimeError>;
    pub fn op_count(&self) -> usize;
    pub fn commit(self);
}
// Plus: WorkbookRuntime::transaction() -> WorkbookTransaction<'_>
```

**Semantics shipped:**
- **Eager validation**: `put_formula` runs lex + parse + bind at call time. Errors (syntax, `UnresolvedName`, `UnsupportedVariant`) surface BEFORE any state change.
- **Two-pass commit**: pass 1 applies all literal writes + persists all formula text; pass 2 evaluates each buffered formula against the post-pass-1 workbook and writes the result. Means a formula referencing a literal-value cell written EARLIER in the same transaction sees the new value (paste-block semantics).
- **Drop without commit = no-op**: the borrow checker enforces one active transaction per workbook, and dropping without `commit` discards the buffered ops cleanly. (IDE's "ESC cancels paste".)
- **Last-write-wins** within a transaction. Order in `ops` Vec dictates which write lands last.

**Known surprise (pinned by test, not yet fixed):** if a transaction does `put_formula(C)` then `put_value(C)` on the same cell, the literal's formula-clear happens in pass 1, but pass 2 still evaluates the buffered formula and overwrites the literal value — final state is the formula's value with no formula text. Documented in `value_after_formula_on_same_cell_clears_formula`. The IDE should not interleave value/formula on the same cell in one batch; if it ever does, revisit. (Phase 4 calcgraph integration with proper dependency-driven recompute supersedes this corner.)

**Deferred to Phase 2B+:** transaction-aware op log integration (2A.3 task), formula→formula intra-batch topological ordering (Phase 4 calcgraph).

**Tests:** 15 in `transaction::tests` (literal-only commit, formula commit, formula sees in-batch value, parse-error rejection, unresolved-name rejection, drop-no-commit, no-op commit, value clears existing formula, last-write-wins on dup, formula-overwrites-value, value-after-formula corner pin, named-constant resolution, error-value propagation, 5×2 paste block, runtime.transaction() integration).

### Phase 2A.3 — Loro op log scaffolding (2–3 days)

**Why:** Phase 5 ships full multi-user collaboration. Phase 2 scaffolds the API surface so Phase 5's wiring is incremental.

**Architectural locks (Round 7 T1-D05):**
- Loro CRDT for **op log only** (full collab in Phase 5+).
- `loro = "=1.12.0"` already pinned in workspace deps.

**Steps:**
1. New `ql-oplog` crate (already stubbed). Define `Op` enum: `PutValue`, `PutFormula`, `ClearFormula`, `AddSheet`, etc.
2. `OpLog` API: `append(op)`, `iter()`, `len()`, replay-against-Workbook.
3. Wire `WorkbookTransaction::commit` to append a single op per commit.
4. Wire `WorkbookRuntime::set_formula` (single-cell case) to append one op.
5. Serialize op log into `.qbook/oplog.bin` (Loro's binary format) on save.
6. Load + replay on load (or `recompute_all` after load).

**This is a deep dive.** Phase 5 will lift it to multi-user. Phase 2A.3 establishes the op grammar.

### Phase 2A.4 — Convenience: `load_workbook_and_recompute` ✅ DONE (2026-05-12)

**Shipped** in `quantbook-engine/crates/ql-exec/src/loader.rs`. New module + free function:

```rust
pub fn load_workbook_and_recompute(
    path: &Path,
    registry: &FunctionRegistry,
) -> Result<Workbook, LoadAndRecomputeError>;

pub enum LoadAndRecomputeError {
    Load(QbookError),
    Recompute(RuntimeError),
}
```

Promoted ql-io from dev-dependency to regular dependency of ql-exec (loader.rs uses `ql_io::load_workbook` at runtime). Re-exported from `ql-exec::lib`.

**Tests** (6 in `loader::tests`): formula refresh against stale-on-disk values, formula-free workbook, missing-path load error, empty workbook, multiple formulas all recomputed, named-range round-trip pins the persistence gap (`.qbook` doesn't yet serialize `NameTable`; load surfaces `Recompute(UnresolvedName)` — flagged for Phase 2B+).

**Surfaced gap (not fixed here):** named-range definitions don't persist through `save_workbook` / `load_workbook` — the on-disk schema has no NameTable section. Test `named_range_formula_round_trips_through_load_and_recompute` pins this; fix lives in `ql-io::qbook_format` (Phase 2B+).

### Phase 2A.5 — Lexer dotted identifiers (`VAR.S`, `STDEV.P`) ✅ DONE (2026-05-12)

**Shipped** in `ql-formula-syntax::lexer::lex_ident_or_ref`. After the initial letter run, a `while` loop allows `.LETTERS` continuation; once any dot is consumed, the token is committed to the `Ident` path (CellRef-style `$`/digit suffixes become errors). Orphan dots (no letter after) become a `LexError::UnexpectedChar('.')`.

**End-to-end verified:** `=VAR.S(1, 2, 3)` evaluates to 1.0; `=STDEV.P(2, 4, 4, 4, 5, 5, 7, 9)` evaluates to 2.0. The function registry already had `VAR.S` / `VAR.P` / `STDEV.S` / `STDEV.P` from Phase 0 — only the lexer needed the change.

**Tests:** 10 lexer tests (single-dot, multi-dot, lowercase preservation, function-call form, orphan-dot error, leading-/trailing-dollar rejection, trailing-digit rejection, `A1+.5` regression guard for CellRef-then-Number) + 1 parser test (`VAR.S(...)` → `Expr::Function`) + 2 runtime tests (`VAR.S` and `STDEV.P` end-to-end through `set_formula`).

**Multi-dot policy:** the `while` loop accepts patterns like `A.B.C` lexing as `Ident("A.B.C")`. Excel doesn't use these, but the binder rejects unknown function names downstream, so no extra restriction was warranted. Pinned by `dotted_ident_multi_dot` test.

### Phase 2A.6 — Phase 2 audit + acceptance (~1 day)

Same pattern as Phase 0 W3 audit + Phase 1 W5-7 audit: dispatch an independent agent, fix HIGH findings, ship audit-fix commit. Defer cosmetic items.

---

## Things to NOT do in the next session

- **Don't ship workbench integration** in the engine repo. That's TypeScript work in `extensions/quantlab/`. Engine APIs are stable; IDE work is a separate session.

- **Don't add dependency-graph wiring** to `WorkbookRuntime::recompute_all`. That's Phase 4+ work; needs calcgraph integration. Phase 2's recompute-all-everything is sufficient.

- **Don't change the `.qbook/` schema_version** unless a hard incompatibility forces it. The Phase 2 work (formulas, op log) is additive via new optional fields per the existing serde-skip pattern.

- **Don't pull `pulp` back into ql-exec**. We removed it in `820b857d027` due to RUSTSEC-2024-0436 (unmaintained `paste` transitive). Phase 4+ Welford SIMD will revisit when paste's situation changes.

---

## Quick-reference paths

**Live engine sources** (the things you'll modify most):
- `crates/ql-formula-syntax/src/{lexer,parser,printer,ast,token}.rs`
- `crates/ql-storage/src/{workbook,sheet,column,overlay}.rs`
- `crates/ql-calcgraph/src/{graph,node,edges,dirty,topo,fingerprint,stripes,stats}.rs`
- `crates/ql-functions/src/{registry,scalar_fns,welford}.rs`
- `crates/ql-exec/src/{plan,env,scalar,simd,lower,workbook_runtime}.rs`
- `crates/ql-profile/src/{graph_profile,timings}.rs`
- `crates/ql-io/src/qbook_format.rs`

**Phase 2 stub crates to populate**:
- `crates/ql-oplog/` — Track A.3 (Loro op log)
- `crates/ql-formula-semantics/` — defined-name + named-range resolution (Track A.1)

**Docs**:
- `docs/phase0/exit-packet.md` — Phase 0 viability close
- `docs/phase0/references-reading-log.md` — deep-read findings (CORR-21..25)
- `docs/phase1/progress.md` — Phase 1 progress snapshot (mid-Phase-1, slightly stale)
- `docs/phase1/exit-packet.md` — Phase 1 close (this commit)
- `docs/phase2/entry-plan.md` — THIS FILE

**Plan + decisions** (gitignored, in main checkout):
- `.plans/_active.md` — live plan file per the global plan protocol
- `.plans/_round-7-decisions-log.md` — CORR-01..25 corrections log

**Scripts** (`scripts/`):
- `check-build-flags.sh` — A3 target-cpu=native CI guard + --self-test
- `check-cargo-lock-pins.sh` — pin-guard (18 watched packages)
- `check-multiversion-clones.sh` — A2 disassembly verification

---

## Test commands cheat-sheet

```bash
# Full workspace test
mac zsh -lc 'source "$HOME/.cargo/env" && cd quantbook-engine && cargo test --locked --workspace'

# Single crate
cargo test --locked -p ql-exec

# A single test
cargo test --locked -p ql-exec workbook_runtime::tests::set_formula_literal_arithmetic

# Bench
cargo bench -p ql-exec --bench og02_mul2

# A2 disassembly check (multiversion clone verification)
bash scripts/check-multiversion-clones.sh

# All 5 local gates in one shot (used in this session repeatedly)
mac zsh -lc 'source "$HOME/.cargo/env" && cd quantbook-engine && \
  cargo fmt --all -- --check && \
  cargo clippy --locked --workspace --all-targets -- -D warnings && \
  cargo test --locked --workspace 2>&1 | grep "^test result" | awk -F"[ .;]+" "{ p += \$4; f += \$6 } END { print \"passed=\" p \" failed=\" f }" && \
  bash scripts/check-cargo-lock-pins.sh && \
  bash scripts/check-build-flags.sh && bash scripts/check-build-flags.sh --self-test'
```

---

## Audit posture

If you make non-trivial changes, **dispatch an independent audit agent** before declaring done. The pattern that's worked for both Phase 0 W3 and Phase 1 has been:

1. Make changes + add tests.
2. Run gates, verify green.
3. Push.
4. Dispatch a background audit agent (use the general-purpose agent type with a thorough prompt naming the files + findings categories: HIGH/MEDIUM/LOW + doc-rot).
5. While the agent runs, work on lower-priority things or write docs.
6. On agent return: fix HIGH findings in one focused commit, defer MEDIUM/LOW where appropriate.

Both audits surfaced real bugs (Phase 0 H1/H2/H3 in calcgraph; Phase 1 H1 printer + H2 parser + H4 qbook). The pattern pays back.

---

## Memory + plan-protocol pointers

Per the user's global instructions:
- Memory lives at `~/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/`.
- Update `current_work.md` at session end with a handoff snapshot.
- `.plans/_active.md` is the plan-protocol entry point.

This session's `current_work.md` should reflect:
- HEAD at `3717bc6b167` (or whatever HEAD is after this commit lands).
- Phase 1 engine-side complete-plus.
- Phase 2 entry-plan is THIS file.
- 659 tests, all gates green.

---

**TL;DR for the impatient**: read `docs/phase1/exit-packet.md` for what shipped, then come back here for what to do next. The 5-minute verification commands above are your first checklist.

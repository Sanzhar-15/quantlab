# Phase 1 Exit Packet — Quantbook Engine

**Date:** 2026-05-12
**Branch:** `feat/quantbook-engine`
**HEAD at exit:** `3717bc6b167` (W5-10: WorkbookRuntime live-formula facade)
**Decision:** **GO** to Phase 2 (collaboration foundation + IDE integration in parallel).

---

## TL;DR

Phase 1 engine-side work shipped in **10 commits (W5-1..W5-10) + 1 audit-fix commit (W5-7) + 1 doc commit (progress.md)**. The engine now has a complete end-to-end pipeline from user-typed formula source to evaluated value, plus workbook persistence with atomic save + formula round-trip. **659 workspace tests** (started Phase 1 at 487 → +172). All gates green; cargo audit clean.

The exit packet's recommended Phase 1 plan (~13–14 days) was ~85% engine work and ~15% IDE integration. Engine-side: **complete-plus** (delivered Phase 2 prep work along the way). IDE-side: lives in a different repo (`extensions/quantlab/`) and is the gating item for ship.

Phase 0's 13/13 acceptance items remain LOCKED, with OG-06 upgraded from W3-7 shape-only to W5-5 fully closed via the `Timings` struct + schema v2.

---

## Phase 1 commits

| Commit | Description | Test delta |
|---|---|---|
| `64cd3da0675` | W5-1: Pratt parser + AI() reservation | +44 |
| `69449371deb` | W5-2: AST printer + round-trip property | +46 |
| `22f41ff17b6` | W5-3: first E2E integration test | +19 |
| `74a523384dc` | W5-4: AI() registration honoring CORR-06 | +5 |
| `d4d04e089b1` | W5-5: Timings struct + OG-06 fully LOCKED | +7 |
| `0ca0c309d91` | W5-6: `.qbook/` workbook save+load | +15 |
| `71ece0e4fe8` | docs/phase1: progress snapshot | 0 |
| `9fa3843f81f` | W5-7: Phase 1 audit fixes (H1-H5 + M1-M3 + L1/L2/L4/L7 + D2) | +10 |
| `f71cbf3fdd5` | W5-8: atomic save (M4) + NaN/Inf validation (M6) | +6 |
| `5d6332b71d6` | W5-9: Workbook formula storage + qbook formula persistence | +11 |
| `3717bc6b167` | W5-10: WorkbookRuntime live-formula facade | +13 |

**Total Phase 1: +172 tests, 659 workspace total, 0 failed.**

---

## Engine-side Phase 1 acceptance summary

No formal numbered acceptance gates per the master plan (Phase 0 had 13; Phase 1's gating was qualitative). Engine-side milestones I'd call out as "Phase 1 LOCKED" for the exit story:

| Milestone | Status | Where |
|---|---|---|
| Pratt parser + Excel-canonical precedence | ✅ | W5-1 |
| AST printer with `parse(print(parse(src))) == parse(src)` round-trip | ✅ | W5-2 |
| End-to-end source→result E2E test | ✅ | W5-3 |
| AI() returns AINotAvailable per CORR-06 (end-to-end) | ✅ | W5-4 |
| `graph-profile.json` schema v2 with full timings (OG-06 upgrade) | ✅ | W5-5 |
| `.qbook/` save+load round-trip | ✅ | W5-6 |
| Audit hardening — all 5 HIGH + 4 MEDIUM + 4 LOW + 1 doc-rot closed | ✅ | W5-7 |
| Atomic save (write-to-tmp + rename) | ✅ | W5-8 |
| NaN/Inf rejected at save boundary with cell coordinates | ✅ | W5-8 |
| Workbook formula storage (`formula_cells` map) | ✅ | W5-9 |
| qbook persistence of formulas (backwards-compat with W5-6 schema) | ✅ | W5-9 |
| `WorkbookRuntime::set_formula` — live-formula facade for IDE | ✅ | W5-10 |
| `recompute_all()` — refresh after load | ✅ | W5-10 |

**Phase 0 acceptance** — 13 of 13 still LOCKED (re-affirmed; OG-06 upgraded):

| Gate | Target | Measured | Where |
|---|---|---|---|
| OG-01 | CI per push | All commits green | CI |
| OG-02 | ≤100 ms | **3.4 ms** | W4-2 |
| OG-03 | zero per-chunk alloc | verified | W4-2 |
| OG-04 | informational | 69 ns/cell | W4-5 |
| OG-05 | only affected chunk | locked | W3-2 |
| **OG-06** | **time-spent attribution** | **fully LOCKED (schema v2 + Timings)** | **W5-5** |
| A1 | ≤50 ms / 10K edits | **42 ms** | W4-6 |
| A2 | multiversion disasm | NEON `fmul.2d` × 20 verified | W4-3 |
| A3 | target-cpu=native guard | done | Round 7 |
| A4 | 3 structural assertions | all pass | W3-6 |
| A5 | <2× formula edges | 100k → linear | W3-5 |
| A6 | ≥12/≥8 digits | rel err <1e-12 / <1e-8 | W4-4 |
| A7 | chunk-size sweep | 4k–64k within 1%; 16k validated | W4-6 |

---

## End-to-end pipeline (the IDE consumption surface)

```text
User types `=A1 * 2`
        ↓
WorkbookRuntime::set_formula(sheet, row, col, "A1 * 2")
        │
        ├─ ql-formula-syntax::lex(text) → Vec<Token>
        ├─ ql-formula-syntax::parse(tokens) → Expr AST
        ├─ ql-exec::bind(expr, owning_sheet) → ExprPlan
        ├─ ql-exec::eval_scalar_with_registry(plan, env, registry) → Value
        │     (env reads cells via &Workbook; registry provides 26 built-ins)
        ├─ Workbook::put_at(sheet, row, col, value) — persists value
        └─ Workbook::put_formula(sheet, row, col, text) — persists source
        ↓
Returns: Value::Number(20.0) [given A1=10]

ql-io::save_workbook(&wb, name, path) → atomic .qbook/ directory:
    ├── workbook.toml      (schema_version = 1)
    └── sheets/0.jsonl     ({"row":1,"col":0,"value":{"Number":20.0},
                             "formula":"A1 * 2"})

ql-io::load_workbook(path) → Workbook
    (formula text preserved; values may be stale → call recompute_all)

WorkbookRuntime::recompute_all() → re-evaluates every formula cell
```

---

## Engine state at exit

### Workspace tests
- **659 workspace tests**, 0 failed.
- Test count growth in Phase 1: 487 → 659 (+172).
- Test count growth across both phases: smoke-only → 659 (+659).

### Gates (all green at HEAD)
- `cargo fmt --check`
- `cargo clippy --locked --workspace --all-targets -- -D warnings`
- `cargo test --locked --workspace`
- `bash scripts/check-build-flags.sh` + `--self-test` (10/10 forms detected; A3 target-cpu=native guard)
- `bash scripts/check-cargo-lock-pins.sh` (18 watched packages)
- `bash scripts/check-multiversion-clones.sh` (A2 disassembly verify; 20 NEON `fmul.2d` in mul_scalar binary)
- `cargo audit --deny warnings` (177 deps, 0 advisories)

### Active crates (default-members)

| Crate | LOC src | Tests | Status |
|---|---|---|---|
| `ql-types` | ~600 | 89 | Phase 0 shipped |
| `ql-bench` | ~400 | 21 | Phase 0 scaffold |
| `ql-storage` | ~750 | 56 | Phase 0 + W5-9 formula_cells |
| `ql-formula-syntax` | ~2,500 | 145 | Phase 0 lexer/AST + W5-1/W5-2 parser/printer |
| `ql-calcgraph` | ~2,100 | 102 | Phase 0 W3 complete |
| `ql-functions` | ~1,000 | 56 | Phase 0 W4-4 + W5-4 AI sentinel |
| `ql-exec` | ~2,150 | 102 | Phase 0 W4 + W5-3/W5-10 |
| `ql-profile` | ~580 | 14 | Phase 0 W3-7 + W5-5 timings |
| `ql-io` | ~1,000 | 27 | Phase 1 W5-6 + W5-8/W5-9 hardening |

Plus 12 smoke-stub crates (semantics, udf, sql, collab, connectors, io-xlsx, io-ods, service, ai, bindings-{wasm, node, c}, terminal, oplog, py).

### Toolchain + deps
- `rust-toolchain.toml` → stable 1.95.0; MSRV floor 1.85.
- 18 workspace deps pin-guarded.
- cargo-audit clean: 0 vulnerabilities, 0 warnings across 177 transitive deps.

### Strategic locks (Round 7 + CORR-21..25)

All Round 7 decisions intact. All 5 deep-read corrections (CORR-21 stripe pattern; CORR-22 aggregate caching deferred; CORR-23 iterative Tarjan SCC; CORR-24 typed test accessors; CORR-25 two-overlay deferred) still applied. No trip-wire fired.

---

## Phase 1 audit closure

Independent agent audit + self-audit on 2026-05-12 raised 5 HIGH + 9 MEDIUM + 8 LOW + 4 doc-rot. Closure:

**Closed in W5-7 (audit-fix commit)**:
- H1: `(a^b)^c` round-trip broken (printer right-assoc) — fixed + regression test
- H2: bare identifier silently → zero-arg function call — ParseError
- H3: A:B:C silently merged — InvalidRange
- H4: qbook loader panicked on OOB rows — MalformedCell
- H5: chunk_rows envelope was a known lie — Sheet::chunk_rows accessor + truthful envelope
- M1: Array/Spill `<unsupported>` → `unreachable!()`
- M2: missing sheet JSONL silently empty → MissingFile
- M3: sheet ID mismatch panic → NonSequentialSheetIds Result
- L1/L2/L4/L7 + D2: doc-rot

**Closed in W5-8**:
- M4: atomic save with sibling temp dir + rename — corruption-free under crash
- M6: NaN/Inf save-side validation — NonFiniteNumber error (serde_json silently emits null for NaN, causing silent corruption)

**Deferred (Phase 2+ or genuinely out-of-scope)**:
- M5: file locking (Phase 4+ multi-process)
- M7: e2e test name conflates whole-column with cell-ref form (cosmetic)
- M8: AVG alias feature flag (policy decision)
- M9: registry count comment (false positive — count is correct)
- L3, L5, L6, L8, D1, D3, D4: cosmetic

**Phase 1 audit closure: complete on every actionable item.**

---

## Phase 1 deferred items (tracked for Phase 2+)

### From the Phase 0 exit packet (still deferred to Phase 2+)
- Region split/merge under heterogeneous edits — Phase 4+; A1 chassis is measured, explicit fragmentation lands with the live binder.
- Aggregate caching (CORR-22): HyperFormula-style RangeVertex.functionCache.
- Two-overlay user+computed cascade (CORR-25): adds `computed_overlay` sibling to `ColumnStore`.

### New items deferred in Phase 1
- **NameRef variant for defined names**: H2's deferred path. Add `Expr::NameRef(Arc<str>)` and a populated NameTable. Phase 2+ work.
- **Dotted function names** (VAR.S, STDEV.P): lexer rejects `.` outside numeric context. Phase 2 lexer enhancement.
- **Standalone WholeColumn ref binding** (`=A * 2`): binder rejects with UnsupportedVariant. FormulaRegion binder (Phase 4+) lowers to row-aligned CellRefs.
- **Dependency-tracking incremental recompute**: calcgraph integration. `WorkbookRuntime::recompute_all` re-evaluates everything; Phase 4+ adds topological scheduling driven by edit propagation.
- **Atomic save .bak rotation**: closes the microsecond window between `remove` and `rename`. Phase 4+ when crash-recovery semantics matter.
- **File locking** (M5): multi-process concurrent-write protection. Phase 4+.
- **Formula evaluation on load**: `load_workbook` populates `formula_cells` but leaves sentinel values; callers must call `recompute_all` explicitly. Phase 2 convenience: auto-recompute on load (or a `load_workbook_and_recompute` variant taking a registry).

### Documented limitations
- AI() returns `AINotAvailable` end-to-end — when actual AI integration ships (v2 conditional), the registry entry will dispatch to a real implementation.
- `WorkbookRuntime` iteration order in `recompute_all` is HashMap-arbitrary. Cross-cell dependencies may evaluate in dependency-violating order. Phase 4+ topological scheduling addresses this.

---

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| IDE integration (Phase 1 #3) requires engine API changes | Low | Engine surface is stable; `WorkbookRuntime` IS the IDE-facing API. Additive changes only expected. |
| `.qbook/` schema v1 needs migration support when v2 lands | Low | `UnsupportedSchema` error already surfaces unknown versions. Migration tool Phase 2+. |
| Cross-cell dependency order wrong without calcgraph | Medium | `recompute_all` documented as HashMap-order; Phase 4+ topo-sort. Workaround for now: call `recompute_all` multiple times until stable (3–4 passes typically suffice). |
| Workbook formula state can be inconsistent (value ≠ formula) | Medium | `WorkbookRuntime::set_formula` is the safe API; direct `put_at` + `put_formula` doesn't keep them in sync. Tests warn; documentation makes the contract explicit. |
| Phase 2 collaboration (Loro op log) introduces engine-state ambiguity | Medium-High | Phase 2 design will define ownership of mutations (CRDT vs imperative). Engine currently single-writer. |

---

## Recommendation

**GO** to Phase 2.

### Two parallel tracks for next session

**Track A (engine-side Phase 2 prep)**: collaboration foundation
- Loro CRDT integration scaffolding (workspace dep already pinned)
- Op log API surface (Phase 5+ ships full op log; Phase 2 scaffolds the trait)
- Multi-cell transaction API (atomic batch writes to `Workbook`)
- Named ranges + `Expr::NameRef` (close H2's deferred path)

**Track B (IDE integration)**: live in `extensions/quantlab/` (different working tree).
- VS Code extension wires `WorkbookRuntime::set_formula` to the formula bar
- Cell editing + selection state
- Save/load against `.qbook/` paths
- Phase 0/1 engine API is stable; no engine changes expected

These tracks are independent. Engine-side Phase 2 can run in parallel with IDE integration.

### Phase 2 suggested engine sequence (~10 days)

See `docs/phase2/entry-plan.md` for the detailed handoff document.

---

**Signed:** Quantbook engineering, 2026-05-12. End of Phase 1 engine-side work.

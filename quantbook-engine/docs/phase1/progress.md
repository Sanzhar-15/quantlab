# Phase 1 Engine Progress — Quantbook

**Date:** 2026-05-12
**Branch:** `feat/quantbook-engine`
**Phase 0 exit:** `2df2e96293b` (GO; 13/13 acceptance after W5-5 closed OG-06)
**Phase 1 status:** Engine-side substantially complete; awaiting Phase 1 audit + IDE integration.

---

## TL;DR

Engine-side Phase 1 work — Pratt parser, AST printer, first E2E, AI() runtime
honoring, Timings struct closing OG-06, and `.qbook/` workbook serialization — is
shipped across 6 W5 commits. **619 workspace tests** (started Phase 1 at 487 →
+132). All gates green.

Remaining Phase 1 items per the Phase 0 exit packet:
- IDE workbench integration (~5 days) — **lives in a different repo/tree**, not the
  engine.
- Phase 1 audit + acceptance (~1 day) — in progress.

The engine can now: lex any Excel-canonical formula source, build an AST,
canonically print it back, evaluate it through scalar/SIMD paths, and persist/load
multi-sheet workbooks.

---

## Commits added in Phase 1

| Commit | Description | Test count delta |
|---|---|---|
| `64cd3da0675` | W5-1 Pratt parser + AI() reservation | +44 |
| `69449371deb` | W5-2 AST printer + round-trip property | +46 |
| `22f41ff17b6` | W5-3 first E2E integration test | +19 |
| `74a523384dc` | W5-4 AI() registration honoring CORR-06 | +5 |
| `d4d04e089b1` | W5-5 Timings struct + OG-06 fully LOCKED | +7 |
| `0ca0c309d91` | W5-6 `.qbook/` workbook save+load | +15 |

**Total Phase 1: +136 tests, 619 workspace total, 0 failed.**

---

## Capability matrix

| Capability | Status | Notes |
|---|---|---|
| Lex Excel-canonical formula source | ✓ Phase 0 W2-A | Lexer ships 55 tests |
| Parse to AST | ✓ Phase 1 W5-1 | Pratt parser, Excel-canonical precedence |
| Print AST back to canonical A1 source | ✓ Phase 1 W5-2 | Round-trip property tested |
| Bind AST → execution-ready ExprPlan | ✓ Phase 0 W4-1 | Sheet refs resolved |
| Per-cell scalar eval | ✓ Phase 0 W4-1 | Excel-compatible coercion + error propagation |
| Bulk SIMD eval (OG-02 hot path) | ✓ Phase 0 W4-2 | 3.4ms for 25M cells |
| Lower ExprPlan → SIMD shape | ✓ Phase 0 W4-3 | classify + dispatch |
| Function dispatch via registry | ✓ Phase 0 W4-5 | 26 built-ins incl. AI sentinel |
| Welford VAR/STDEV (A6 NIST) | ✓ Phase 0 W4-4 | Two-pass; ≥12 mean digits, ≥8 var digits |
| AI() returns AINotAvailable | ✓ Phase 1 W5-4 | CORR-06 honored end-to-end |
| Calc graph + dirty propagation | ✓ Phase 0 W3 | OG-05 / A1 / A4 / A5 all locked |
| Graph profile JSON export | ✓ Phase 1 W5-5 | Schema v2 with Timings (OG-06 fully closed) |
| Workbook save (.qbook/) | ✓ Phase 1 W5-6 | TOML envelope + JSONL per sheet |
| Workbook load (.qbook/) | ✓ Phase 1 W5-6 | Round-trip tested across all Value variants |

---

## End-to-end pipeline (Phase 1 + Phase 0)

```text
Source string  =A1 * 2
       ↓ ql-formula-syntax::lex (Phase 0 W2-A)
Vec<Token>     [BareColumn{A}, Op(Mul), Number(2)]  (for =A*2 / =A1*2)
       ↓ ql-formula-syntax::parse (Phase 1 W5-1)
Expr AST       Binary { Mul, CellRef(A1), Number(2) }
       ↓ ql-exec::bind (Phase 0 W4-1)
ExprPlan       Binary { Mul, CellRef{sheet:0, row:0, col:0}, Number(2) }
       ↓
   ┌───────┴───────┐
   ↓               ↓
Scalar path     SIMD path (W4-3 lower)
eval_scalar     classify → MulScalar{col:0, scalar:2}
   ↓               ↓
Value           dispatch(shape, &input_chunk, &mut out_chunk)
                   ↓
                ~3.4ms over 25M cells (Phase 0 W4-2 OG-02)
```

Persistence (Phase 1 W5-6):

```text
Workbook (in memory)
       ↓ ql-io::save_workbook
my-workbook.qbook/
├── workbook.toml      ← TOML envelope (schema v1)
└── sheets/0.jsonl     ← one JSON line per non-blank cell
       ↑ ql-io::load_workbook
Workbook (reconstructed)
```

---

## Phase 0 acceptance — 13 of 13 LOCKED (re-affirmed)

| Gate | Target | Measured | Where |
|---|---|---|---|
| OG-01 | CI per push | All commits green | CI |
| OG-02 | ≤100 ms | **3.4 ms** | W4-2 |
| OG-03 | zero per-chunk alloc | verified | W4-2 |
| OG-04 | informational | 69 ns/cell | W4-5 |
| OG-05 | only affected chunk | locked | W3-2 |
| **OG-06** | **time-spent attribution** | **fully LOCKED (W5-5 upgrade)** | W5-5 |
| A1 | ≤50 ms / 10K edits | **42 ms** | W4-6 |
| A2 | multiversion disasm | NEON `fmul.2d` × 20 verified | W4-3 |
| A3 | target-cpu=native guard | done | Round 7 |
| A4 | 3 structural assertions | all pass | W3-6 |
| A5 | <2× formula edges | 100k → linear | W3-5 |
| A6 | ≥12/≥8 digits | rel err <1e-12 / <1e-8 | W4-4 |
| A7 | chunk-size sweep | 4k-64k within 1%; 16k validated | W4-6 |

OG-06 promoted from W3-7 "shape locked" to W5-5 "fully LOCKED" via the
`Timings` struct + JSON schema v2 wiring. A senior engineer reading the profile
can now attribute time-spent per node-type, see SIMD/scalar dispatch ratios, and
read fingerprint cache hit rates.

---

## Engine state at this milestone

- **619 workspace tests**, 0 failed.
- 12 active Phase 0/1 crates (+1 new: ql-io); 12 still stubs.
- All 5 local gates green (fmt / clippy --locked --all-targets / cargo test
  --locked --workspace / A3 + 10/10 self-test / pin guard 18 packages).
- A2 disassembly check passes (20 NEON `fmul.2d` instructions in
  `og02_mul2` release binary).
- `cargo audit --deny warnings` clean (177 deps after toml addition).
- All 5 deep-read corrections (CORR-21..25) still folded in.

### Active crates (default-members; 12 of 24)

| Crate | LOC src | Tests | Phase |
|---|---|---|---|
| `ql-types` | ~600 | 89 | 0 |
| `ql-bench` | ~400 | 21 | 0 |
| `ql-storage` | ~700 | 49 | 0 |
| `ql-formula-syntax` | ~1,700 | 145 | 0 (lexer/AST) + 1 (parser/printer) |
| `ql-calcgraph` | ~2,100 | 102 | 0 |
| `ql-functions` | ~1,000 | 56 | 0 (+ AI W5-4) |
| `ql-exec` | ~1,700 | 102 | 0 + 1 (E2E + AI) |
| `ql-profile` | ~440 | 14 | 0 (W3-7 shape) + 1 (W5-5 timings) |
| `ql-io` | ~440 | 16 | **1 new (W5-6)** |
| `ql-oplog`, `ql-terminal`, `quantbook-py` | stubs | 1 each | future |

Other 13 crates (semantics, udf, sql, collab, connectors, io-xlsx, io-ods,
service, ai, bindings-{wasm,node,c}) are still smoke stubs.

---

## What's left in Phase 1 per the exit-packet plan

The Phase 0 exit packet's suggested Phase 1 sequence was ~13-14 days. After W5-1
through W5-6, the remaining items:

1. **Workbench integration** (~5 days): Quantlab IDE wiring — formula bar
   Monaco integration, cell editing, recompute on edit. This is **TypeScript
   work in the `extensions/quantlab/` IDE tree**, NOT the engine repo.
2. **Phase 1 audit + acceptance** (~1 day): in progress (independent agent
   audit dispatched on 2026-05-12).

The engine side of Phase 1 is essentially shipped. After the audit closes any
high-severity findings, Phase 1 engine work is complete.

---

## Known deferred items (Phase 2+)

### From Phase 0 exit packet (still deferred)

- Region split/merge under heterogeneous edits — Phase 4+; the A1 chassis is
  measured, explicit fragmentation lands with the live binder.
- Aggregate caching (CORR-22): HyperFormula-style RangeVertex.functionCache.
- Two-overlay user+computed cascade (CORR-25): adds `computed_overlay` sibling
  to `ColumnStore` when ql-exec writes formula outputs back.

### New deferred items surfaced in Phase 1

- **Cell formulas in .qbook/**: W5-6 saves Values only. Phase 2 adds formula
  persistence when the binder integrates with `Workbook`.
- **Named ranges in .qbook/**: NameTable empty in Phase 0/1; populated Phase 2+.
- **Dotted function names** (VAR.S, STDEV.P): lexer rejects `.` outside numeric
  context. Phase 2+ lexer enhancement.
- **Standalone WholeColumn ref binding** (=A * 2): binder rejects with
  UnsupportedVariant. FormulaRegion binder (Phase 4+) lowers to row-aligned
  CellRefs.
- **`ColumnStore::chunk_rows` public accessor**: needed for clean chunk_rows
  roundtrip in `.qbook/`. Phase 2 follow-up.
- **Atomic save** (`save_workbook` writes in place): if the process dies
  mid-write, the workbook is corrupted. Phase 2 fix: write to .tmp, then
  rename. Tracked.
- **File locking**: no concurrent-write protection. Phase 4+ if Quantbook
  ever supports multiple processes on the same workbook.

---

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| IDE integration (Phase 1 #3) requires engine API changes | Medium | Engine surface is stable; new APIs are additive. Audit may surface gaps. |
| `.qbook/` schema v1 needs migration support when v2 lands | Low | UnsupportedSchema error already surfaces unknown versions. Migration tool Phase 2+. |
| Phase 1 audit surfaces a HIGH finding | Medium-Low | Same pattern as Phase 0 W3 audit — fixed in one focused commit. |
| Workbench integration takes longer than 5 days | Medium | Tracked in IDE repo, not engine. Engine itself is done. |

---

**Engine-side Phase 1 status:** ready for IDE integration + Phase 1 audit closure.

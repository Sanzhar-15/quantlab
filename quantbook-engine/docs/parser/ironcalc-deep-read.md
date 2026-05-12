# IronCalc Parser Deep-Read + Quantbook Parser Gap Matrix

**Phase:** Engine Phase 4.1 (W5-44, 2026-05-12).
**Spec ID:** PAR-4-01 (gap matrix checked in), PAR-4-02 (parser
expansion gated on this doc), PAR-4-03 (legal/provenance).
**Status:** SHIPPED.

This document is the canonical reference for "what does IronCalc parse
that Quantbook doesn't?" — the gap matrix that Phase 4.2 (compatibility
matrix harness), Phase 4.6 (cross-sheet refs), Phase 4.7 (array
formulas), Phase 4.8 (structured refs), Phase 4.9 (R1C1 / localization /
implicit intersection), and Phase 4.11 (xlsx import) will consult. Per
PAR-4-02, no parser expansion begins until this document exists; this
file is the unlock.

## Provenance + license (PAR-4-03)

- **Source repo (read-only):** `.references/ironcalc/` (vendored at
  `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/.references/ironcalc/`).
- **License:** IronCalc is dual-licensed **MIT** + **Apache-2.0** (see
  `LICENSE-MIT`, `LICENSE-APACHE` in the IronCalc root). Copyright 2023
  EqualTo GmbH, Nicolás Hatcher.
- **Usage policy for Quantbook:** Reference-only. Quantbook does NOT
  link IronCalc at runtime nor vendor any IronCalc source files. We
  read for: (a) algorithmic patterns (recursive-descent shape,
  precedence tower, implicit intersection injection), (b) wire-format
  knowledge (xlsx, structured refs syntax), (c) error-class taxonomy
  comparison. Any future direct code reuse would require adding the
  MIT + Apache-2.0 dual-license footer to the affected files; this
  has not happened yet and isn't planned through Phase 4. Pattern
  adoption is fair use under both licenses.
- **Reference snapshot in `.references/` is a literal source mirror;
  it should NOT be edited.**

## 1. File tree (IronCalc parser subsystem)

```
ironcalc/base/src/expressions/
├── lexer/
│   ├── mod.rs                       — main lexer; A1 + R1C1 modes; locale/decimal-sep aware
│   ├── ranges.rs                    — A1 range parsing (A1:B10, A:A, 5:5, $)
│   ├── structured_references.rs     — Excel table syntax (Table[Column], Table[#All], Table[@…])
│   ├── util.rs                      — digit / whitespace helpers
│   └── test/                        — locale + token + R1C1 unit tests
├── parser/
│   ├── mod.rs                       — recursive descent; 12 parse fns ~1211 lines
│   ├── lambda.rs                    — LAMBDA() (Excel 365 dynamic arrays)
│   ├── move_formula.rs              — relative-ref shift on cut/paste
│   ├── static_analysis.rs           — implicit intersection injection, formula validation
│   ├── stringify.rs                 — AST → text round-trip (locale-aware)
│   └── tests/                       — locale, range, array, structured-ref tests
├── token.rs                         — TokenType enum (27 variants); Op{Compare,Sum,Product,Unary} enums
└── types.rs                         — ParsedReference, ParsedRange, CellReferenceRC, Area
```

## 2. Token-kind gap

### IronCalc tokens (27 variants)

```text
Illegal, EOF, Ident, String, Number, Boolean, Error,
Compare(OpCompare), Addition(OpSum), Product(OpProduct), Power,
LeftParenthesis, RightParenthesis, Colon, Semicolon,
LeftBracket, RightBracket, LeftBrace, RightBrace, Comma,
Bang(!), Percent, And(&), At(@), Spill(#), Backslash(\),
Reference{sheet: Option<String>, row, col, abs_col, abs_row},
Range{sheet: Option<String>, left: CellRef, right: CellRef},
StructuredReference{table_name, specifier, table_reference}
```

### Quantbook tokens (`ql-formula-syntax::token::Token`)

```text
Number, String, Ident, CellRef, BareColumn, BareRow,
Op(Operator), LParen, RParen, Comma, Colon, Semicolon

Operator: Plus, Minus, Mul, Div, Percent, Pow, Concat,
          Eq, Neq, Lt, Le, Gt, Ge
```

### Tokens IronCalc has, we don't

| Feature | IronCalc | Quantbook target phase |
|---|---|---|
| `LeftBracket` / `RightBracket` | Structured refs + R1C1 arrays | Phase 4.8 (structured refs), 4.9 (R1C1) |
| `LeftBrace` / `RightBrace` | Array literals `{1,2;3,4}` | Phase 4.7 (array formulas) |
| `Bang(!)` | Sheet qualifier `Sheet1!A1` | Phase 4.6 (cross-sheet refs) |
| `At(@)` | Implicit intersection | Phase 4.9 (implicit intersection) |
| `Spill(#)` | Spill range operator | Phase 4.7 |
| `Backslash(\)` | Column separator in R1C1 array literals | Phase 4.9 |
| `Reference{sheet, ...}` | Sheet-qualified cell ref at LEX time | Phase 4.6 |
| `Range{sheet, left, right}` | Sheet-qualified range at LEX time | Phase 4.6 |
| `StructuredReference{...}` | `Table[Column]` parsed at lex time | Phase 4.8 |
| `Boolean(bool)` | TRUE/FALSE as direct lex token | Phase 4.1 follow-up (small) |
| `Error(Error)` | `#REF!` etc. as lex token | Phase 4.4 (error matrix) |

### Tokens we have, IronCalc doesn't

- **Separate `CellRef` / `BareColumn` / `BareRow` tokens.** IronCalc
  packs all forms into `Reference{...}` + `Range{...}` at lex time.
  Quantbook keeps cell-ref disambiguation in the parser. Both shapes
  work; IronCalc's is slightly heavier at lex, lighter at parse.
- **`Operator` enum** (Plus/Minus/Mul/Div/...) — IronCalc uses three
  separate enums per precedence level (`OpCompare`, `OpSum`,
  `OpProduct`). Our single enum is more composable for downstream
  ExprPlan binding.

## 3. AST-node gap

### IronCalc `Node` (26 variants, `parser/mod.rs` lines ~120-233)

```text
Boolean, Number, String, Reference, Range, WrongReference, WrongRange,
OpRange, OpConcatenate, OpSum, OpProduct, OpPower,
Function{kind}, Lambda{params, body}, LambdaCall,
NamedFunction{id, name, args},
Array, DefinedName, TableName, NamedVariable,
ImplicitIntersection{automatic, child},
SpillRangeOperator{child},
Compare, Unary, Error, ParseError, EmptyArg
```

### Quantbook `Expr` (`ql-formula-syntax::ast::Expr`, 11 variants)

```text
Number, String, Bool,
CellRef(CellAddr), RangeRef(RangeRef),
Binary{op, lhs, rhs}, Unary{op, operand},
Function{name, args}, Array, Spill, NameRef
```

### AST gaps — IronCalc has, we don't

| Feature | IronCalc node | Quantbook target phase |
|---|---|---|
| LAMBDA closures + higher-order | `Lambda{params, body}`, `LambdaCall` | Post-v1 (Excel 365 feature, low priority for Phase 4) |
| Implicit intersection | `ImplicitIntersection{automatic, child}` | Phase 4.9 |
| Spill operator | `SpillRangeOperator{child}` | Phase 4.7 |
| Defined names as named AST nodes | `DefinedName` | Partial overlap with our `NameRef`; reconcile at Phase 4.8 |
| Table names as AST nodes | `TableName(String)` | Phase 4.8 |
| Named variables (LAMBDA params) | `NamedVariable{name, id}` | Post-v1 |
| Error-tolerant refs | `WrongReference`, `WrongRange` | Phase 4.4 (diagnostic UX); Quantbook currently errors at parse |
| Range as first-class operator | `OpRange` (`:` as binary operator node) | Phase 4.6/4.7 |
| Parse errors as tree nodes | `ParseError{formula, msg, pos}` | Phase 4.4 (recoverable parse) |
| Empty positional arg | `EmptyArg` for `SUM(, A2)` | Phase 4.3 (function library — IF/IFS/CHOOSE expect this shape) |

### AST shapes we have, IronCalc doesn't (or differs)

- **`CellAddr` struct** — separate sheet/row/col/abs fields. IronCalc
  inlines into each Node variant. Our approach is slightly cleaner for
  the binder's `ExprPlan::CellRef`.
- **`RangeRef` enum** — `Cells | WholeColumn | WholeRow`. IronCalc uses
  a single `Range` Node and validates at runtime. Our pre-categorized
  enum is friendlier for the Phase 3.3 stripe registration path.
- **`Bool(bool)` literal** — explicit AST variant. IronCalc parser
  promotes TRUE/FALSE identifiers at parse time.
- **`Binary` folds Compare/Sum/Product/Power into one op-tagged variant.**
  IronCalc keeps `OpCompare` etc. separate. Our fold is simpler; the
  bind layer handles op-specific dispatch.

## 4. Feature parity table (capability)

| Feature | IronCalc | Quantbook (post-Phase-3) | Phase to close |
|---|---|---|---|
| A1 cell refs (`$A$1`, `A1`, `$A1`, `A$1`) | ✅ | ✅ | shipped |
| A1 ranges (`A1:B10`, `A:A`, `1:1`) | ✅ | ✅ (whole-col/row via named ranges, Phase 3.6) | shipped |
| Operators (`+ - * / ^ & = <> < <= > >= %`) | ✅ | ✅ | shipped |
| Named refs (`Sales`) | ✅ | ✅ (Phase 2A.1, 2B.4) | shipped |
| **Cross-sheet refs** (`Sheet1!A1`) | ✅ | ❌ | **Phase 4.6** |
| Quoted sheet names (`'My Sheet'!A1`) | ✅ | ❌ | **Phase 4.6** |
| Cross-workbook refs (`[file.xlsx]Sheet1!A1`) | ✅ | ❌ | Post-v1 (xlsx-only feature; Phase 4.11) |
| **Array literals** (`{1,2;3,4}`) | ✅ | ❌ | **Phase 4.7** |
| Dynamic-array functions / spills (`A1#`) | ✅ | ❌ | **Phase 4.7** |
| **Structured refs** (`Table[Col]`, `Table[#All]`) | ✅ | ❌ | **Phase 4.8** |
| LAMBDA + closures | ✅ | ❌ | Post-v1 |
| **R1C1 mode** | ✅ | ❌ | **Phase 4.9** |
| Implicit intersection (`@A1:A10`) | ✅ | ❌ | **Phase 4.9** |
| Localization (decimal/arg sep + fn names) | ✅ | ❌ | **Phase 4.9** |
| Move-formula on copy/paste | ✅ | ❌ | Phase 4 (IDE-level feature; binder reuse) |
| Static analysis pass | ✅ | ⚠️ (we error at parse) | **Phase 4.4** (error matrix) |

## 5. Architectural style

IronCalc uses **recursive descent with explicit precedence hierarchy**:

```
expr     → concat (opCompare concat)*
concat   → term ('&' term)*
term     → factor (opSum factor)*
factor   → prod (opProd prod)*
prod     → power ('^' power)*
power    → (unaryOp)* range '%'*
range    → implicit (':' primary)?
implicit → '@' primary | primary '#' | primary
primary  → '(' expr ')' | number | function(args) | LAMBDA(...) | name | string | '{...}' | bool | error
```

Quantbook's parser (`crates/ql-formula-syntax/src/parser.rs`) is also
recursive descent, but with a slightly different precedence shape. We
should adopt IronCalc's `power → unary → range → primary` ordering
explicitly in Phase 4.7 (when range + spill operators enter the AST),
to avoid subtle precedence drift vs Excel.

**Error handling.** IronCalc represents parse errors as AST nodes
(`Node::ParseError{formula, msg, pos}`) — recoverable parsing. We
short-circuit with `Result<Expr, ParseError>`. For IDE UX (red-squiggle
on bad formula) we may want to switch in Phase 4.4 alongside the error
matrix.

**Locale / language threading.** IronCalc carries `&Locale` and
`&Language` refs through both lexer and parser; decimal separator,
argument separator, function-name lookup, error-text strings all key
off these. Phase 4.9 (localization) adopts this pattern.

**Move-formula as a separate pass.** Rather than baking
relative-ref adjustment into the parser, IronCalc exposes
`move_formula(node, &DisplaceData)` as a tree-walk function. Clean
separation; we should follow the same shape when Phase 5+ adds
copy/paste through `WorkbookSession`.

## 6. Recommended Phase 4 sequencing implications

The MASTER-PLAN sequences 4.1 → 4.2 → ... → 4.12. The gap matrix
suggests two adjustments worth raising at Phase 4.2 (compatibility
matrix) entry:

1. **Cross-sheet refs (Phase 4.6) and array formulas (Phase 4.7)
   benefit from doing token-shape changes ONCE.** Both add new
   tokens (`!`, `{`, `}`, `\`, structured `Reference{sheet,...}`).
   Plan 4.6 + 4.7 + 4.8 lexer work as one cohesive token-set
   expansion sprint rather than three back-to-back.
2. **Implicit intersection (4.9) operates on the bound plan + post-
   parse static analysis pass.** Can land independently of the lexer
   work above. Sequence-flexible.

## 7. Phase 3 megaudit carryovers that affect Phase 4 parser work

Per `docs/audits/2026-05-12-phase-3-megaudit.md`:

- **GAP-G-01** (append-only graph, rebind staleness) — Phase 4
  function library expansion (4.3) and array formulas (4.7) will both
  rebind formulas frequently. The delta-edge graph fix should land
  before 4.3 or be a known limitation gated by 4.12 megaudit.
- **GAP-G-03** (range deps not scheduler edges) — Phase 4.7 array
  formulas + 4.8 structured refs both produce range deps at scale.
  Same architectural decision needed.

These are PHASE 4 entry decisions, NOT parser-only decisions, but
calling them out here so the gap-matrix reader sees the dependency.

## 8. Acceptance gate checklist (Phase 4.1 / PAR-4-01..03)

- ✅ **PAR-4-01** — gap matrix checked in. THIS DOCUMENT.
- ✅ **PAR-4-02** — parser expansion (4.6/4.7/4.8/4.9 lexer + AST
  changes) is now formally unlocked. Phase 4.2 (compatibility matrix)
  is also unlocked.
- ✅ **PAR-4-03** — legal/provenance notes documented in §1
  (Provenance + license). IronCalc MIT + Apache-2.0; reference-only
  policy in effect.

## 9. Open follow-ups (not blockers)

1. **Re-survey IronCalc's `static_analysis.rs` deeper before Phase
   4.9** — implicit intersection injection has subtle semantics for
   legacy-formula compat.
2. **Re-survey IronCalc's `move_formula.rs` before Phase 5** —
   relative-ref shift on copy/paste needs `DisplaceData` analog in
   Quantbook.
3. **Lexer test set** — IronCalc's `lexer/test/` covers locale +
   R1C1 + token edge cases. Phase 4.9 should mirror the test fixtures.

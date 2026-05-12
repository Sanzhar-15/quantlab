# Excel Compatibility Matrix

**Phase:** Engine Phase 4.2 (W5-45, 2026-05-12).
**Spec ID:** ECM-4-01 (matrix exists), ECM-4-02 (each function carries
status / tests / category / Excel parity notes), ECM-4-03 (CI can
report coverage percentage).
**Companion script:** `scripts/report-compat-coverage.sh` reports the
implemented / total count by category.

This document is the canonical machine-parseable reference for what
Excel features Quantbook implements. Categories: operators, coercion,
errors, functions, arrays/spills, tables, date systems, localization,
xlsx round-trip.

**Phase 3.10/Codex audit closure (W5-48, 2026-05-13):** ECM-4-02
was originally written as "each function has status + tests +
category + Excel parity notes." After the audit caught the schema
mismatch (function tables have no `Category` column; categories
are encoded as `###` SECTION HEADERS under `## 1. Functions`), the
ECM-4-02 acceptance is now: each function row carries Status +
Tests + Phase + Notes; the function's CATEGORY is determined by
the `###` section it lives under (Aggregates/Statistical, Logical,
Math&Trig, Text, Date&Time, Lookup&Reference, Information,
Financial, Engineering, Database, Reserved). Many rows still have
empty/short Notes; per-row parity-note expansion is the
documented Phase 4.3+ follow-up (also captured in §"Open
follow-ups" below).

Each function row carries:

- **Status:** ✅ implemented · ⚠️ partial · 🔄 reserved · ❌ not-yet
- **Tests:** existing test count (`-` for non-function rows)
- **Phase:** Phase that closes / closed this row.
- **Notes:** Excel parity notes, known limitations, divergences.

The category for each row comes from the `###` section header it's
listed under (not a per-row column).

The `Status` column is the format `scripts/report-compat-coverage.sh`
counts: rows with `✅` count as implemented, rows with `⚠️` count
as partial, rows with `❌` are missing.

---

## 1. Functions

### Aggregates / Statistical (basic)

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| SUM | ✅ | 30+ | 0 | Aggregate over range/named-range works (Phase 3.6 cache); error propagation per Excel canon |
| AVERAGE (alias: AVG) | ✅ | 10+ | 0 | Welford-backed (A6 spec); empty range → #DIV/0! |
| COUNT | ✅ | 5+ | 0 | Numeric values only; errors / text / blanks skipped |
| COUNTA | ✅ | 3+ | 0 | All non-blank; errors + text counted |
| MIN | ✅ | 5+ | 0 | Empty → 0 (Excel canon); error propagates |
| MAX | ✅ | 5+ | 0 | Empty → 0 (Excel canon); error propagates |
| PRODUCT | ✅ | 5+ | 0 | Empty → 0 |
| VAR (alias: VAR.S) | ✅ | A6 | 0 | Welford-backed |
| VAR.P | ✅ | A6 | 0 | Welford-backed |
| STDEV (alias: STDEV.S) | ✅ | A6 | 0 | Welford-backed |
| STDEV.P | ✅ | A6 | 0 | Welford-backed |
| SUMIF | ❌ | 0 | 4.3 | Conditional sum |
| SUMIFS | ❌ | 0 | 4.3 | Multi-condition sum |
| COUNTIF | ❌ | 0 | 4.3 | Conditional count |
| COUNTIFS | ❌ | 0 | 4.3 | Multi-condition count |
| AVERAGEIF | ❌ | 0 | 4.3 | Conditional average |
| AVERAGEIFS | ❌ | 0 | 4.3 | Multi-condition average |
| MINIFS / MAXIFS | ❌ | 0 | 4.3 | Multi-condition min/max |
| MEDIAN | ❌ | 0 | 4.3 | Removed from `is_aggregate_function` Phase 2B.7 audit M1 |
| MODE / MODE.SNGL / MODE.MULT | ❌ | 0 | 4.3 | |
| LARGE / SMALL | ❌ | 0 | 4.3 | k-th largest/smallest |
| RANK / RANK.AVG / RANK.EQ | ❌ | 0 | 4.3 | |
| PERCENTILE / PERCENTILE.INC / PERCENTILE.EXC | ❌ | 0 | 4.10 | |
| QUARTILE / QUARTILE.INC / QUARTILE.EXC | ❌ | 0 | 4.10 | |
| CORREL / COVARIANCE.P / COVARIANCE.S | ❌ | 0 | 4.10 | |
| PEARSON / RSQ / SLOPE / INTERCEPT | ❌ | 0 | 4.10 | |
| FREQUENCY | ❌ | 0 | 4.10 | Array-result; needs 4.7 |
| NORM.DIST / NORM.S.DIST / NORM.INV / NORM.S.INV | ❌ | 0 | 4.10 | |
| T.DIST / T.INV / CHISQ.DIST / CHISQ.INV / F.DIST / F.INV | ❌ | 0 | 4.10 | |
| BINOM.DIST / BINOM.INV / POISSON.DIST / EXPON.DIST | ❌ | 0 | 4.10 | |
| GAMMA / GAMMA.DIST / GAMMA.INV / GAMMALN | ❌ | 0 | 4.10 | |
| BETA.DIST / BETA.INV | ❌ | 0 | 4.10 | |
| TREND / FORECAST / LINEST / LOGEST | ❌ | 0 | 4.10 | Array-result; needs 4.7 |

### Logical

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| IF | ⚠️ | 8+ | 0 (eager) | Eager both-branch eval; lazy semantics → 4.3 (FN4-03) |
| IFS | ❌ | 0 | 4.3 | Multi-condition selector |
| IFERROR | ⚠️ | 5+ | 0 (eager) | Eager eval; lazy → 4.3 |
| IFNA | ❌ | 0 | 4.3 | |
| AND / OR | ✅ | 5+ | 0 | Eager; truthy semantics per Excel |
| NOT | ✅ | 3+ | 0 | |
| XOR | ❌ | 0 | 4.3 | |
| TRUE / FALSE | ⚠️ | — | 0 | Parsed as identifiers; promoted at bind; explicit `Bool` Token deferred to 4.1 follow-up |
| SWITCH | ❌ | 0 | 4.3 | |

### Math & Trigonometry

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| ABS | ✅ | 3+ | 0 | |
| SQRT | ✅ | 3+ | 0 | Negative → #NUM! |
| ROUND | ✅ | 5+ | 0 | |
| ROUNDUP | ⚠️ | 4 | 4.3 V1 | Round away from zero; sign-preserving. **Binary-float gotcha:** `ROUNDUP(0.1 + 0.2, 1)` rounds `0.30000000000000004` to `0.4`, while Excel's 15-digit display-aware rounding usually yields `0.3`. Decimal-aware rounding lands Phase 4.5 (number formats). |
| ROUNDDOWN | ⚠️ | 2 | 4.3 V1 | Truncate toward zero. Same binary-float gotcha as ROUNDUP. **Negative-zero leak:** very-small negative inputs produce `Value::Number(-0.0)` (PartialEq says `0.0 == -0.0`; cosmetic only — display may show `-0`). |
| MROUND / CEILING / CEILING.MATH / CEILING.PRECISE | ❌ | 0 | 4.3 | |
| FLOOR / FLOOR.MATH / FLOOR.PRECISE | ❌ | 0 | 4.3 | |
| INT | ✅ | 3+ | 0 | Truncation toward -∞ |
| TRUNC | ✅ | 1 | 4.3 V1 | Truncation toward 0; optional `digits` arg |
| MOD | ✅ | 3+ | 0 | Excel mod semantics, sign-of-divisor |
| QUOTIENT | ❌ | 0 | 4.3 | |
| POWER | ✅ | 5+ | 0 | Same special cases as `^` operator |
| EXP | ✅ | 1 | 4.3 V1 | `#NUM!` on overflow |
| LN | ✅ | 2 | 4.3 V1 | Natural log; non-positive → `#NUM!` |
| LOG | ✅ | 3 | 4.3 V1 | Optional base; base=1 or non-positive → `#NUM!` |
| LOG10 | ✅ | 1 | 4.3 V1 | Base-10 log; non-positive → `#NUM!` |
| SIN / COS / TAN / ASIN / ACOS / ATAN / ATAN2 | ❌ | 0 | 4.3 | |
| SINH / COSH / TANH / ASINH / ACOSH / ATANH | ❌ | 0 | 4.10 | |
| PI | ✅ | 2 | 4.3 V1 | Constant; arity check |
| DEGREES | ✅ | 1 | 4.3 V1 | Radians → degrees |
| RADIANS | ✅ | 1 | 4.3 V1 | Degrees → radians |
| SIGN | ✅ | 1 | 4.3 V1 | -1/0/1 |
| FACT / FACTDOUBLE / COMBIN / COMBINA / PERMUT / PERMUTATIONA | ❌ | 0 | 4.10 | |
| GCD / LCM | ❌ | 0 | 4.10 | |
| RAND / RANDBETWEEN | ✅ | 3+ | 3.7 | xorshift64, seeded test fixture |
| RANDARRAY | ❌ | 0 | 4.7 | Array-result; needs 4.7 |
| SUMPRODUCT | ❌ | 0 | 4.3 | |
| SUMSQ / SUMX2MY2 / SUMX2PY2 / SUMXMY2 | ❌ | 0 | 4.10 | |
| AGGREGATE | ❌ | 0 | 4.10 | Conditional aggregation; depends on 4.7 |
| SUBTOTAL | ❌ | 0 | 4.10 | |

### Text

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| LEN | ✅ | 3 | 4.3 V1 | **DIVERGES from Excel for emoji ZWJ sequences.** Rust counts Unicode scalar values (`.chars().count()`); Excel counts UTF-16 code units (`LENB`-like for non-BMP). For ASCII / BMP-plane text, both match. ZWJ family emoji like `👨‍👩‍👧`: Quantbook = 5, Excel = 8. Pin Phase 4.9. |
| LEFT / RIGHT / MID | ❌ | 0 | 4.3 | |
| UPPER | ⚠️ | 2 | 4.3 V1 | Rust's Unicode-default mapping. **DIVERGES from Excel for German ß** (Quantbook = `SS`, Excel = `ß`) and any other locale-sensitive mapping (Turkish I, Greek final sigma). For ASCII-only text both match. Pin Phase 4.9 (locale-aware case). |
| LOWER | ⚠️ | 1 | 4.3 V1 | Rust Unicode-default. Same divergence class as UPPER. Pin Phase 4.9. |
| PROPER | ❌ | 0 | 4.3 | Title-case |
| TRIM | ✅ | 1 | 4.3 V1 | Strip + collapse internal space runs |
| CLEAN | ❌ | 0 | 4.3 | Strip non-printable ASCII |
| CONCAT / CONCATENATE | ❌ | 0 | 4.3 | The `&` operator works; functions defer |
| TEXTJOIN | ❌ | 0 | 4.3 | |
| FIND / SEARCH | ❌ | 0 | 4.3 | Case-sensitive vs not |
| SUBSTITUTE / REPLACE | ❌ | 0 | 4.3 | |
| REPT | ❌ | 0 | 4.3 | |
| EXACT | ❌ | 0 | 4.3 | |
| TEXT | ❌ | 0 | 4.5 | Needs format parser |
| VALUE / NUMBERVALUE | ❌ | 0 | 4.3 | Text → number coercion as function |
| FIXED / DOLLAR | ❌ | 0 | 4.5 | |
| CHAR / CODE / UNICODE / UNICHAR | ❌ | 0 | 4.3 | |
| REGEX / REGEXMATCH / REGEXEXTRACT / REGEXREPLACE | ❌ | 0 | post-v1 | Google Sheets extension; not in Excel canon |
| LEFTB / RIGHTB / MIDB / LENB / FINDB / SEARCHB | ❌ | 0 | 4.10 | Byte-length variants (DBCS) |
| TEXTBEFORE / TEXTAFTER / TEXTSPLIT | ❌ | 0 | 4.7 | Modern Excel; array-result |

### Date & Time

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| NOW / TODAY | ✅ | 5+ | 3.7 | Approximate Excel-1900 epoch; precise leap-year handling → 4.5 |
| DATE / TIME / DATEVALUE / TIMEVALUE | ❌ | 0 | 4.5 | |
| YEAR / MONTH / DAY / HOUR / MINUTE / SECOND | ❌ | 0 | 4.5 | |
| WEEKDAY / WEEKNUM / ISOWEEKNUM | ❌ | 0 | 4.5 | |
| DAYS / DAYS360 / NETWORKDAYS / NETWORKDAYS.INTL | ❌ | 0 | 4.5 | |
| WORKDAY / WORKDAY.INTL | ❌ | 0 | 4.5 | |
| EDATE / EOMONTH | ❌ | 0 | 4.5 | |
| DATEDIF | ❌ | 0 | 4.5 | Excel-specific; leap-month edge cases |
| YEARFRAC | ❌ | 0 | 4.5 | Multiple day-count bases |

### Lookup & Reference

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| VLOOKUP / HLOOKUP | ❌ | 0 | 4.3 | Range-arg; needs 4.7 partial |
| LOOKUP | ❌ | 0 | 4.3 | Vector & array forms |
| XLOOKUP | ❌ | 0 | 4.7 | Dynamic-array; modern Excel |
| MATCH / XMATCH | ❌ | 0 | 4.3 | |
| INDEX | ❌ | 0 | 4.3 | Range-arg semantics |
| OFFSET | ❌ | 0 | 4.7 | Volatile; whitelisted in 3.2 but not implemented |
| INDIRECT | ❌ | 0 | 4.7 | Volatile; whitelisted in 3.2 but not implemented |
| ADDRESS | ❌ | 0 | 4.3 | |
| ROW / COLUMN / ROWS / COLUMNS | ❌ | 0 | 4.3 | |
| TRANSPOSE | ❌ | 0 | 4.7 | Array-result |
| FILTER / SORT / SORTBY / UNIQUE | ❌ | 0 | 4.7 | Dynamic-array; modern Excel |
| CHOOSE / CHOOSEROWS / CHOOSECOLS | ❌ | 0 | 4.3 (CHOOSE) / 4.7 (rest) | |
| HYPERLINK | ❌ | 0 | post-v1 | Display-side, UI-coupled |

### Information

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| ISNUMBER | ✅ | 1 | 4.3 V1 | TRUE iff Value::Number |
| ISTEXT | ✅ | 1 | 4.3 V1 | TRUE iff Value::Text |
| ISBLANK | ✅ | 1 | 4.3 V1 | TRUE iff Value::Blank |
| ISLOGICAL | ✅ | 1 | 4.3 V1 | TRUE iff Value::Boolean |
| ISERROR | ✅ | 2 | 4.3 V1 | TRUE for ANY error |
| ISNA | ✅ | 1 | 4.3 V1 | TRUE only for `#N/A` |
| ISERR | ✅ | 1 | 4.3 V1 | TRUE for errors EXCEPT `#N/A` |
| ISFORMULA / ISEVEN / ISODD / ISREF | ❌ | 0 | 4.3 | |
| ISNONTEXT | ❌ | 0 | 4.3 | |
| TYPE / N | ❌ | 0 | 4.3 | |
| NA / ERROR.TYPE | ❌ | 0 | 4.3 | |
| INFO | ❌ | 0 | 4.7 | Volatile; whitelisted but not implemented |
| CELL | ❌ | 0 | 4.7 | Volatile; whitelisted but not implemented |
| SHEET / SHEETS | ❌ | 0 | 4.6 | Depends on cross-sheet machinery |

### Financial

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| PMT / IPMT / PPMT / PV / FV / NPER / RATE | ❌ | 0 | 4.10 | TVM core |
| NPV / XNPV / IRR / XIRR / MIRR | ❌ | 0 | 4.10 | |
| PRICE / YIELD / DURATION / MDURATION | ❌ | 0 | post-v1 | Bond math |
| DB / DDB / SLN / SYD / VDB | ❌ | 0 | 4.10 | Depreciation |
| FVSCHEDULE / RRI / PDURATION | ❌ | 0 | post-v1 | |
| ACCRINT / ACCRINTM / COUPDAYS / COUPNCD / COUPPCD | ❌ | 0 | post-v1 | Bond accrual |
| Currency / formatted (DOLLAR, etc.) | ❌ | 0 | 4.5 | Display-level; depends on TEXT/format parser |

### Engineering (post-v1 unless flagged)

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| BITAND / BITOR / BITXOR / BITLSHIFT / BITRSHIFT | ❌ | 0 | 4.10 | |
| DEC2BIN / BIN2DEC / DEC2HEX / HEX2DEC / DEC2OCT / OCT2DEC | ❌ | 0 | 4.10 | Base conversion |
| COMPLEX / IMABS / IMARGUMENT / IMCONJUGATE | ❌ | 0 | post-v1 | Complex-number math |
| ERF / ERFC / GAMMA / GAMMALN | ❌ | 0 | 4.10 | |
| CONVERT | ❌ | 0 | post-v1 | Unit conversion (large table) |

### Database (DGET, DSUM, etc.) — defer post-v1

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| DGET / DSUM / DCOUNT / DAVERAGE / DMAX / DMIN / DPRODUCT / DSTDEV / DVAR | ❌ | 0 | post-v1 | Database functions; rare in practice |

### Reserved / Quantbook-specific

| Function | Status | Tests | Phase | Notes |
|---|---|---|---|---|
| AI | 🔄 | 3+ | 0 | Returns `#AI_NOT_AVAILABLE_V1` sentinel per CORR-06 / T4-D05; real impl Phase 6.6 |
| LAMBDA | ❌ | 0 | post-v1 | Excel 365 closures; not in v1 target |

---

## 2. Operators

| Operator | Status | Tests | Notes |
|---|---|---|---|
| `+` (Plus) | ✅ | 50+ | Lenient text-to-number coercion (2A.9 M1) |
| `-` (Minus binary + unary) | ✅ | 30+ | |
| `*` (Mul) | ✅ | 30+ | |
| `/` (Div) | ✅ | 20+ | Excel-canon `#DIV/0!`; SIMD intentionally NOT lowered (2A.9 H5) |
| `^` (Pow) | ✅ | 20+ | `0^0 = #NUM!`; `0^-n = #DIV/0!`; negative base + non-integer exp = `#NUM!` |
| `%` (Percent unary postfix) | ✅ | 5+ | |
| `&` (Concat) | ✅ | 10+ | Coerces both via `to_text_for_formula` |
| `=` / `<>` / `<` / `<=` / `>` / `>=` | ✅ | 30+ | Excel-canon cross-type ordering (2A.9 M2): Number < Text < Bool |
| `:` (Range) | ✅ | 30+ | Token + bind path for `A1:B10`, `A:A`, `1:1` |
| `,` (Argument separator) | ✅ | 100+ | Localization → 4.9 (could be `;` per locale) |
| `;` (Statement separator) | ✅ | 5+ | Reserved for array literals (4.7) |
| `!` (Sheet qualifier) | ❌ | 0 | Phase 4.6 |
| `@` (Implicit intersection) | ❌ | 0 | Phase 4.9 |
| `#` (Spill range) | ❌ | 0 | Phase 4.7 |
| `[]` (Structured ref subscript) | ❌ | 0 | Phase 4.8 |

---

## 3. Coercion rules

| Rule | Status | Notes |
|---|---|---|
| Binary arithmetic text→number (lenient) | ✅ | `"5" + 1 = 6`; unparseable → `#VALUE!` (2A.9 M1) |
| Binary arithmetic bool→number | ✅ | `TRUE → 1`, `FALSE → 0` |
| Binary arithmetic blank→number | ✅ | `Blank → 0` |
| Binary comparison cross-type (Number < Text < Bool) | ✅ | 2A.9 M2 |
| Function-arg numeric coercion (SUM/AVERAGE skip non-numeric) | ✅ | |
| Function-arg numeric coercion (MIN/MAX skip non-numeric) | ✅ | |
| Function-arg numeric coercion (PRODUCT skip non-numeric) | ✅ | |
| Function-arg text→number (strict path) | ⚠️ | `to_number_strict` exists; usage scoped |
| Function-arg text→formula coercion | ✅ | `to_text_for_formula` for `&` |
| Date serial coercion | ❌ | Phase 4.5 |
| Empty-arg behavior in aggregates | ✅ | AVERAGE empty → `#DIV/0!`; MIN/MAX empty → 0; SUM empty → 0; PRODUCT empty → 0 |

---

## 4. Errors

| Variant | Sigil | Status | Notes |
|---|---|---|---|
| `Ref` | `#REF!` | ✅ | Missing-sheet read (2A.7 H6); xlsx-import-broken refs (4.11) |
| `Value` | `#VALUE!` | ✅ | Wrong-type op input |
| `NA` | `#N/A` | ✅ | Lookup-miss reserved class |
| `DivZero` | `#DIV/0!` | ✅ | `/0`, `0^-n`, AVERAGE empty |
| `Null` | `#NULL!` | ✅ | Intersection-of-disjoint-ranges (legacy v1 wire format ambiguity migrated in 2A.13 H4) |
| `Num` | `#NUM!` | ✅ | NaN, Inf, `0^0`, negative base + non-integer exp |
| `Name` | `#NAME?` | ✅ | Unresolved function name; bind-time UnresolvedName surfaces here too |
| `Spill` | `#SPILL!` | ⚠️ | Variant exists; emit logic in 4.7 |
| `Calc` | `#CALC!` | ✅ | Defensive fallback for AggregateNameRef pre-3.6; now unused but reserved |
| `Disconnected` | `#DISCONNECTED!` | ⚠️ | Variant exists; Phase 6.5 connectors |
| `Binding` | `#BINDING!` | ⚠️ | Variant exists; Phase 6.3 binding round-trips |
| `Timeout` | `#TIMEOUT!` | ⚠️ | Variant exists; Phase 6.1 (cancellation) + 6.4 (UDFs) |
| `Permission` | `#PERMISSION!` | ⚠️ | Variant exists; Phase 6.5 |
| `AINotAvailable` | `#AI_NOT_AVAILABLE_V1` | ✅ | CORR-06 sentinel; real impl 6.6 |
| `Circ` | `#CIRC!` | ✅ | Phase 3.4 Tarjan SCC emits for cycle members |

---

## 5. Arrays / spills

| Feature | Status | Phase | Notes |
|---|---|---|---|
| Array literals `{1,2;3,4}` | ❌ | 4.7 | Lex tokens `{`, `}`, `\`, `;` not in 4.1 scope |
| Dynamic-array functions (XLOOKUP, FILTER, etc.) | ❌ | 4.7 | |
| Spill ranges (`A1#`) | ❌ | 4.7 | |
| Spill blocking (`#SPILL!`) | ❌ | 4.7 | |
| Spill invalidation on resize | ❌ | 4.7 | |
| Computed overlay writeback for spills | ⚠️ | 4.7 | Phase 3.5 overlay split is the substrate |
| Array-context evaluation | ⚠️ | 4.7 | Phase 2B.4 `BindContext::AggregateArg` is the substrate |

---

## 6. Tables (structured references)

| Feature | Status | Phase | Notes |
|---|---|---|---|
| Table metadata in storage | ❌ | 4.8 | GAP-S-04 |
| `Table[Column]` parse | ❌ | 4.8 | Needs `[`, `]` tokens (per 4.1 gap matrix) |
| `Table[#All]` / `Table[#Headers]` / `Table[#Data]` | ❌ | 4.8 | |
| `Table[@Column]` (current-row) | ❌ | 4.8 | |
| Column insert/delete adjusts refs | ❌ | 4.8 | |
| Table aggregate deps via range graph | ❌ | 4.8 | Reuses Phase 3.3 stripe path |
| xlsx import creates tables | ❌ | 4.11 | |

---

## 7. Date systems

| Feature | Status | Phase | Notes |
|---|---|---|---|
| Excel 1900 epoch (Windows default) | ⚠️ | 4.5 | NOW/TODAY use approximate 1899-12-30 epoch; 1900 leap-year quirk NOT modeled |
| Excel 1904 epoch (Mac legacy) | ❌ | 4.5 | DTF-4-01 policy decision |
| Date serial arithmetic | ⚠️ | 4.5 | Number arithmetic works; date-aware fns absent |
| Time serial arithmetic | ❌ | 4.5 | |
| Display format parsing | ❌ | 4.5 | Storage value vs display split — DTF-4-04 |
| Locale-sensitive date formats | ❌ | 4.5 | en-US / en-GB / de / fr |

---

## 8. Localization

| Feature | Status | Phase | Notes |
|---|---|---|---|
| Decimal separator (`.` vs `,`) | ❌ | 4.9 | Lexer-side |
| Argument separator (`,` vs `;`) | ❌ | 4.9 | Lexer-side |
| Function name localization | ❌ | 4.9 | Excel translates function names per locale; we use English-canonical |
| Error sigil localization | ❌ | 4.9 | |
| R1C1 mode | ❌ | 4.9 | LOC-4-01 |
| Implicit intersection | ❌ | 4.9 | LOC-4-03 (`@` operator) |
| Locale toggle in IDE | ❌ | 4.9 | LOC-4-04 |

---

## 9. xlsx round-trip

| Feature | Status | Phase | Notes |
|---|---|---|---|
| xlsx import (read) | ❌ | 4.11 | `ql-io-xlsx` is a 15-line stub (GAP-P-02) |
| xlsx export (write) | ❌ | 4.11 | |
| Cached values | ❌ | 4.11 | XLSX-4-02 must recalc through graph |
| Names / tables / formats round-trip | ❌ | 4.11 | XLSX-4-03 |
| Corruption surfaces clean errors | ❌ | 4.11 | XLSX-4-04 |
| `.ods` import/export | ❌ | post-v1 | `ql-io-ods` stub (GAP-P-02) |

---

## How to use this matrix

### For implementers (Phase 4.3+)

Find your function row. Status = ❌ → implement it. Status = ⚠️ → fix
the noted partial. Update the row when shipping: change ❌→✅, add a
test count, add a Phase ref (the commit that closed it).

### For reviewers

Use this matrix to verify "is this function safe to call in
production Quantbook?" — ✅ rows are safe; ⚠️ rows have known
limitations documented in Notes; ❌ rows return `#NAME?` at runtime
(unknown function).

### For coverage tracking

Run `bash scripts/report-compat-coverage.sh` to get the current
implemented / partial / missing counts. The script greps this file
for the status emojis.

---

## Open follow-ups

1. **Function row count vs Phase 4.3/4.10 targets.** This matrix
   currently lists ~180 functions across categories. Phase 4.3
   targets 100 implemented; Phase 4.10 targets ~260. The matrix
   should grow to ~260 rows by 4.10 entry; many "post-v1" rows above
   should be promoted into 4.10 scope.
2. **Tests column accuracy.** The Tests column today is an estimate
   (visual scan of the test files). The script should be updated to
   parse `cargo test --workspace` output and reconcile against the
   matrix at CI time.
3. **Excel parity notes**. Most rows say "Phase X to close" without
   pinning the exact Excel semantic difference. Per ECM-4-02, each
   function row should grow a "parity note" describing Excel-vs-
   Quantbook semantics where they differ.

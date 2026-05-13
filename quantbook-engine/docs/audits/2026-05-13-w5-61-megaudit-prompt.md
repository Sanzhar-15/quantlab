# Mega-audit prompt — W5-61 Phase 4.3 polish wave 1

You are auditing the W5-61 commit (HEAD `90aea91f843` on
`feat/quantbook-engine`). One commit; 6 new functions + Excel-canon
wildcard support across criteria predicates AND SEARCH. **This is the
W5-52 pattern: be adversarial. Find what is wrong, missed, or oversold.**

## Branch + state

- Branch: `feat/quantbook-engine`
- Worktree: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook`
- HEAD: `90aea91f843` (W5-61 polish wave 1)
- Previous shippable: `f17a460efca` (W5-60 mega-audit closure)
- 1290 workspace tests pass, 0 fail. All 7 gates green.

## What landed (one commit, +1139 lines / -30)

NEW FUNCTIONS:
- `PROPER(text)` — scalar; title-case each word; non-letter ends a word.
- `CLEAN(text)` — scalar; strip ASCII 0x00–0x1F.
- `CEILING.MATH(number, [significance], [mode])` — scalar; `abs(significance)`; mode flag for negatives.
- `FLOOR.MATH(number, [significance], [mode])` — scalar; mirror.
- `RANK.AVG(value, ref, [order])` — range-aware; average rank for ties.
- `CONCAT(text1, ...)` — range-aware; flatten ranges row-major.

NEW MODULE `crates/ql-functions/src/wildcard.rs` (~330 lines, 17 tests):
- `WildcardPattern::compile(&str) -> Self`
- `.matches(&str) -> bool` (whole-string, case-insensitive)
- `.search_in(&str, start_idx_chars) -> Option<usize>` (substring; for SEARCH)
- `has_wildcards(&str) -> bool` (detect unescaped `?` / `*`)

PREDICATE INTEGRATION (`range_fns.rs`):
- New `Predicate::TextWildcard(CmpOp, WildcardPattern)`.
- `build_predicate` routes to TextWildcard for Eq/Ne text criteria
  containing ANY of `~`, `?`, `*` (even purely escaped like `~?`).
- Wildcard cells match ONLY text cells; Numbers/Bools never match.

SEARCH (`scalar_fns.rs`):
- Always routes through `WildcardPattern::search_in`. The pre-W5-61
  hand-rolled substring loop was deleted.

REGISTRY:
- 102 → 108 entries (6 new).
- `is_aggregate_function` whitelist gains `RANK.AVG` + `CONCAT`.

DOCS:
- `excel-matrix.md`: 6 new fns marked ✅; SUMIF/COUNTIF/SUMIFS/AVERAGEIF/SEARCH note wildcards.
- `audit-protocol.md`: gotchas 19 + 20 added.

## Required reading (cover-to-cover, in this order)

```
crates/ql-functions/src/wildcard.rs                  # NEW; ~330 lines + 17 tests
crates/ql-functions/src/range_fns.rs                 # build_predicate; rank_avg; concat; SUMIF/COUNTIF wildcard tests
crates/ql-functions/src/scalar_fns.rs                # proper; clean; ceiling_math; floor_math; search rewrite
crates/ql-functions/src/registry.rs                  # 6 new registrations; count assertion 108
crates/ql-exec/src/plan.rs                           # is_aggregate_function whitelist (RANK.AVG + CONCAT added)
docs/compat/excel-matrix.md                          # status flips
docs/process/audit-protocol.md                       # gotchas 19/20
```

## Specific concerns

### CONCERN-A: Wildcard semantics correctness

- Does the `WildcardPattern` matcher correctly handle pathological
  cases? Examples to verify:
  - `?` consuming an empty string → must return false.
  - `*` greediness vs `?` minimality interaction (`?*?`).
  - Unicode multi-byte chars under `?` — does the matcher consume
    "exactly one char" (Unicode scalar value), or one byte?
  - Empty pattern `""` — only matches the empty string?
  - Trailing `~` with no following char (e.g. `"foo~"`) — what
    happens? Is it treated as literal `~`?
- Does `has_wildcards` correctly skip the escaped char only ONCE?
  What about `~~?` — should the `~~` consume both tildes, then `?`
  is unescaped?
- Does `build_predicate`'s "route to wildcard if rest contains `~`"
  check accidentally over-trigger on benign text like
  `"file_path~temp.txt"` where `~` is meant as a literal? (Spoiler:
  yes, it will treat it as wildcard, but the compiled pattern will
  still match correctly. Verify.)

### CONCERN-B: SEARCH behavioral preservation

The W5-61 commit DELETED the hand-rolled substring path in SEARCH
and routes everything through `WildcardPattern`. Verify byte-for-byte
that:

- All pre-W5-61 SEARCH tests still pass (the commit claims this).
- Edge cases: empty needle returning start_num.
- start_num > total + 1 → #VALUE!.
- start_num < 1 → #VALUE!.
- start_idx beyond the haystack with non-empty needle.
- Performance: is there a worst-case regression for plain
  substring search (no wildcards)? Pattern compilation + recursive
  match vs the prior linear scan.

### CONCERN-C: CEILING.MATH / FLOOR.MATH edge cases

- significance = 0:
  - CEILING.MATH returns 0 (matches CEILING canon).
  - FLOOR.MATH(0, 0) returns 0; FLOOR.MATH(nonzero, 0) returns #DIV/0!.
  - Is this consistent with Excel? Or does Excel say differently?
- mode = 0 vs mode != 0 boundary:
  - The implementation uses `mode == 0.0` for the conditional. What
    about `mode = -0.0` (negative zero)? Or `mode = NaN`?
- Negative significance:
  - `abs(significance)` swallows the sign. Excel canon for
    CEILING.MATH WITH negative sig: does Excel accept it, or error?
- What about `significance < 0` AND `mode != 0`? The implementation
  takes `abs(significance)` first then branches on mode. Verify.
- `coerce_numeric` for the mode arg returns `Skip` for Blank, which
  gets coerced to 0.0. But the user wrote `CEILING.MATH(x, y, )`
  with an empty third arg — does the parser actually deliver
  `Value::Blank` for that, or omit the arg entirely (args.len() == 2)?

### CONCERN-D: PROPER + CLEAN edge cases

- PROPER with empty string returns empty (test covers).
- PROPER with Unicode (accented letters) — does
  `c.is_alphabetic()` + `c.to_uppercase()` / `to_lowercase()`
  produce Excel's expected behavior? Example: `"café"` → ?
- CLEAN with high control chars (0x7F = DEL): NOT stripped. Is that
  correct Excel canon? Excel strips ASCII 0–31 only; DEL stays.
- CLEAN with Unicode "non-printable" code points (e.g. zero-width
  joiner, format chars in the Cf category): pass-through. Excel
  matches?
- PROPER's behavior on multi-codepoint grapheme clusters (emoji ZWJ
  sequences): is the title-case logic per-codepoint or
  per-grapheme? Probably per-codepoint (Rust default) — which
  diverges from Excel?

### CONCERN-E: RANK.AVG correctness

- Tie-arithmetic: `r + (k-1)/2` for a tie of size k starting at
  rank r. Excel formula matches?
- Bit-pattern equality for tie detection (`x == target` on f64):
  - 0.0 == -0.0 in IEEE 754 → true. So a tie between 0.0 and -0.0
    is counted. Excel's behavior?
  - NaN: never equals itself. So a NaN target with NaN cells →
    `ties == 0` → #N/A. Excel: probably also doesn't handle NaN
    since Excel cells can't BE NaN.
- Empty `ref` → #N/A (matches RANK). Verify.
- value not in ref → #N/A. Verify.
- Order = TRUE (any non-zero): ascending. Order = FALSE/0/Blank:
  descending. Matches RANK.
- 3rd-arg arity test exists for "4 args = #VALUE!" — verify the
  shape.

### CONCERN-F: CONCAT correctness

- Range-flattening order: row-major. Verify against Excel canon
  (Excel: CONCAT across `A1:B2` reads `A1, B1, A2, B2`? Or
  `A1, A2, B1, B2`?). The implementation uses the natural row-major
  order of the `values` vec; check what order `read_range_with_shape`
  populates.
- Error propagation: first error wins. Verify the iteration order
  matches what Excel returns when multiple errors are present in
  different cells.
- Empty args → #VALUE! (matches CONCATENATE).
- Blank cells → empty string (no skip). Excel canon?
- Very long concatenation: Excel has a 32,767-char output cap. Does
  CONCAT enforce this? (REPT does; CONCATENATE doesn't seem to.)

### CONCERN-G: Predicate over-routing

`build_predicate` routes ANY criteria text containing `~` to the
wildcard path (even `"~"` alone or `"path~temp"` with no `?` / `*`).

- For `"~"` alone: compiles to one Literal part = `"~"`. Matches
  cells with literal `~`. Same as `Predicate::Text` would behave,
  so OK. But the WHY is subtle — make sure this is intentional and
  documented.
- For `"<>~?"`: matches all cells NOT equal to literal `?`. The
  TextWildcard branch's Ne logic — does it cover this?
- What about `"abc~"` (trailing ~ with no escape target)? `compile`
  treats trailing `~` as literal. Verify the test for this.

### CONCERN-H: is_aggregate_function whitelist sync invariant

The invariant test `is_aggregate_function_lists_only_registered_aggregates`
pins the whitelist against registered names. With RANK.AVG +
CONCAT added, does this test still pass? Specifically: every name
in the whitelist must be either a registered scalar fn (aggregate)
or a registered range-aware fn. Verify the test runs against the
new entries.

### CONCERN-I: Performance regressions

Wildcard pattern compilation happens PER-CALL for SUMIF/COUNTIF
criteria, every time the formula evaluates. For a formula
`SUMIF(A:A, "foo*", B:B)` over a 1M-row sheet, the pattern
compiles once and matches per cell — OK. But if the formula is
re-evaluated 1000 times, the compilation happens 1000 times.

Should the predicate cache the compiled pattern? Filed as
GAP-F-XX or deferred? Worth recording.

### CONCERN-J: Test coverage gaps

What edge cases were NOT tested? Examples to look for:
- PROPER with multi-byte Unicode.
- CLEAN with 0x7F (DEL).
- CEILING.MATH(NaN, 1, 0) — what does that return?
- CONCAT exceeding the 32K char cap.
- Wildcard matching the empty string.
- SUMIF with wildcard criteria over a range containing
  mixed Number + Text values.
- RANK.AVG with floats that have 0.0 / -0.0 distinction.

### CONCERN-K: Docs vs code consistency

The W5-61 commit message claims COUNTIF promoted ⚠️ → ✅. Verify
the matrix actually shows ✅. Verify the test count assertion in
registry.rs matches the body of the commit. Verify the polish doc
in the handoff doc still says "next session: Phase 4.4" or has it
drifted?

## What to report

```
# W5-61 mega-audit verdict (one paragraph)

## NEW HIGH (correctness bugs, false-confidence ships)
## NEW MEDIUM (overstatement, scope gap, missing test)
## NEW LOW (doc nits, naming, perf observations)

## Per-concern assessment
A: ...
B: ...
...

## What's needed for W5-62 closure
[Checklist if HIGHs found.]
```

Length budget: 1500–4000 words. Cite file paths + line numbers.

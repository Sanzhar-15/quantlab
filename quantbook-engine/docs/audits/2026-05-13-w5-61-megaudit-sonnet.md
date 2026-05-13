# W5-61 mega-audit — Sonnet independent verdict

**Branch / HEAD:** `feat/quantbook-engine` @ `90aea91f843` (W5-61 polish wave 1).
**Workspace:** 1290 tests pass (verified with `cargo test --workspace` on the audit host); all 7 gates green at HEAD.
**Method:** Read every file in the brief cover-to-cover, then injected scratch tests into `wildcard.rs` to probe the pathological cases the existing suite doesn't exercise. Scratch tests were removed before this report (`git diff --stat crates/ql-functions/src/wildcard.rs` after cleanup: 0 changed lines).

---

## Verdict

W5-61 is a **good ship for what it claims to do**, but it ships with one **HIGH** that needs naming (test-coverage invariant drift) and one **HIGH** that is a latent denial-of-service surface (recursive matcher exponential backtracking). The six functions are correctly implemented for the canonical and tested edge cases; the wildcard semantics for Eq/Ne, escape handling, case-insensitivity, and unicode-scalar `?` are all correct. SEARCH's substring path correctly delegates through `WildcardPattern` and the empty-needle / `start_num` guards are intact. Where it's oversold: the commit prose implies "Excel-canon wildcards" — but the matcher diverges from Excel on grapheme-cluster sequences (emoji ZWJ), CONCAT has no 32,767-char output cap (Excel canon), and the test for the `is_aggregate_function` invariant was extended in plan.rs but **the pinning test in workbook_runtime.rs was never updated to include `RANK.AVG` or `CONCAT`**. The invariant test that's supposed to detect this drift is itself drifting. Codex is running in parallel; my verdict is independent.

---

## NEW HIGH

### H1 — `is_aggregate_function` invariant test never pinned the W5-61 entries

`crates/ql-exec/src/plan.rs:234, 239` added `RANK.AVG` and `CONCAT` to the matcher arms. The whole point of `is_aggregate_function_lists_only_registered_aggregates` at `crates/ql-exec/src/workbook_runtime.rs:2525-2579` is to pin those names against the registry so a typo or unsynced rename gets caught at test-time. The test's `for name in &[ ... ]` loop on line 2542-2562 **omits both `RANK.AVG` and `CONCAT`**.

This isn't a correctness bug today — both names ARE in the registry, both are in the matcher — but the W5-61 commit demonstrates exactly the failure mode the invariant exists to catch: a contributor added two entries to `plan.rs` and never updated the assertion list. The test still passes, but it's no longer pinning what the docstring claims it pins. If a future commit removes `RANK.AVG` from the matcher arm, this test will not flag it.

**Cite:** `crates/ql-exec/src/plan.rs:233-240`; `crates/ql-exec/src/workbook_runtime.rs:2542-2562`. The W5-58 ship hit the same shape with MEDIAN/MODE — those were added to the test list, which is why the doc on line 2519 still reads "must only list functions actually registered". W5-61 broke that contract silently.

**Fix:** Add `"RANK.AVG"` and `"CONCAT"` to the loop at workbook_runtime.rs:2542. One-line patch each.

---

### H2 — Exponential backtracking in `match_parts` is a denial-of-service surface

`crates/ql-functions/src/wildcard.rs:115-144` implements `match_parts` as a recursive backtracker. The `Part::Star` arm tries every suffix of `text` against `rest` (line 134-142), and `rest` may contain another `Star` that does the same. There is no memoization, no NFA conversion, no termination ceiling.

Empirical probe: I added a temporary scratch test compiling pattern `"a*a*a*a*a*a*a*a*a*a*b"` (10 stars) and matched it against `"a".repeat(30)`. **It took 3.61 seconds to return false.** This is a synthetic example, but a real user who pastes the criteria `"*foo*bar*baz*qux*"` (4 stars) into `SUMIF(A:A, "*foo*bar*baz*qux*", B:B)` over a column with many long non-matching cells will trigger the same worst-case blowup per cell. Multiply by 100k rows on a real sheet and the engine stalls for many minutes — for what's syntactically a one-line formula.

This is a known anti-pattern for backtracking matchers (the "ReDoS" family). The standard fixes are (a) convert to an NFA (Thompson-style, linear-time), (b) memoize on `(text_pos, parts_pos)` — bounded O(n·m) — or (c) document an explicit pattern complexity cap and reject criteria with more than K unconstrained `*` runs.

Excel itself has bounded-time matching here (Excel's matcher is iterative); this divergence is invisible until someone actually exploits it. Filing as HIGH because (i) it's an unbounded-runtime path triggered by ordinary-looking user input, (ii) the W5-61 commit ships it as "production-ready Excel-canon wildcards" with no perf disclaimer, and (iii) Quantbook's larger story is "1M-row sheets that recompute fast" — exponential matching breaks that story silently.

**Cite:** `crates/ql-functions/src/wildcard.rs:115-144` (match_parts), `134-142` (Star arm with for-loop recursion), `148-176` (match_prefix has the same shape).

**Fix:** Memoize `(text_pos, parts_pos) → bool` in `match_parts` and `match_prefix` — bounded O(n·m) time and space. Cheap; one HashSet/Vec.

---

## NEW MEDIUM

### M1 — CONCAT has no 32,767-char output cap

`crates/ql-functions/src/range_fns.rs:1375-1397`. Excel's CONCAT (and its sibling TEXTJOIN) enforce a 32,767-character cap on the output and return `#VALUE!` when exceeded. REPT in this codebase already enforces this cap (`scalar_fns.rs:1841: if target_len > 32_767`). CONCAT just appends to `out` unbounded. A user who calls `CONCAT(A1:Z1000)` on a sheet of long text cells gets a multi-megabyte string instead of `#VALUE!`. Excel canon diverges. No test pins this either way.

**Cite:** `crates/ql-functions/src/range_fns.rs:1379-1395`; compare `crates/ql-functions/src/scalar_fns.rs:1841-1847` (REPT cap).

---

### M2 — `WildcardPattern` diverges from Excel on grapheme clusters

`?` matches "exactly one Unicode scalar value" because the matcher operates on `text.to_uppercase().chars().collect::<Vec<char>>()`. Each `char` is a Unicode scalar, not a grapheme cluster. For typical text this is what users want, but for emoji ZWJ sequences (`👨‍👩‍👧` = 5 scalars, 1 grapheme) the user-visible glyph count diverges from the matcher's count.

I verified this in a scratch test: `WildcardPattern::compile("?")` does NOT match the family-emoji string, but `WildcardPattern::compile("?????")` does. Excel's matcher treats grapheme clusters more leniently on modern builds. Modest divergence — flag as a known gap or pin a test that documents the chosen semantics.

**Cite:** `crates/ql-functions/src/wildcard.rs:87-91` (`matches` chars-collect), `100-111` (`search_in` chars-collect).

---

### M3 — SEARCH edge cases not pinned by tests

Three SEARCH edges that the implementation handles correctly but are not pinned by a test:

1. Empty `find_text` returning `start_num` directly (`scalar_fns.rs:1682-1684`).
2. `start_num > total + 1` → `#VALUE!` (`scalar_fns.rs:1677`).
3. `start_num < 1` → `#VALUE!` (same line, OR branch).

CONCERN-B in the audit brief specifically called these out. If the W5-61 commit prose claims "behavior-preserving rewrite", these are the exact contracts that need pinning to prevent a future refactor from silently regressing them. The W5-56 SEARCH ship may have had these tests; let me note that I greped `crates/ql-functions/src/scalar_fns.rs` for `search_empty\|search.*needle\|empty.*needle.*search` and got zero hits — neither the W5-56 ship nor W5-61 has them.

**Cite:** `crates/ql-functions/src/scalar_fns.rs:1677-1684`; tests at 2984-3031.

---

### M4 — `~?` over-routing is correct but no test pins literal-`~` criteria like `"foo~bar"` or `"abc~"` (trailing)

The brief's CONCERN-G ("predicate over-routing") spoiler says `"file_path~temp.txt"` triggers the wildcard path but still matches correctly. I walked through the routing manually: `has_wildcards("foo~bar")` returns false (consumes `~b` as escape), but `rest.contains('~')` is true, so `build_predicate` routes to `Predicate::TextWildcard(Eq, compile("foo~bar"))`. `compile` then treats `~b` as the lenient case (peek not in `?/*/~`, so `~` becomes a literal — line 58 of `wildcard.rs`), and the pattern is `[Literal("FOO~BAR")]`. Apply on `Value::Text("foo~bar")`: matches. Apply on `Value::Number(5.0)`: returns false. **Correct in both cases**, but the divergence-from-Predicate::Text on Number cells (TextWildcard never matches non-Text; Predicate::Text DOES try numeric parse) is subtle and not pinned by any test.

I also confirmed `"foo~"` (trailing tilde, no escape target) compiles correctly to `[Literal("FOO~")]` and matches the cell `"foo~"`. CONCERN-A asked about this specifically; not pinned by a test.

**Cite:** `crates/ql-functions/src/range_fns.rs:255-258` (over-routing condition), `crates/ql-functions/src/wildcard.rs:52-59` (lenient `~<other>` handling).

**Fix:** Two-line test additions in `range_fns.rs::tests` mod — `predicate_text_literal_tilde_inside`, `predicate_text_trailing_tilde`.

---

### M5 — CONCAT row-major flattening is correct but undocumented at the API level

`crates/ql-functions/src/range_fns.rs:1386-1394`. CONCAT flattens by iterating the `values` Vec in its natural order. The shape comes from `env.read_range_with_shape` at `crates/ql-exec/src/env.rs:144-189`, which populates `for row { for col { out.push(...) } }` — row-major (left-to-right within a row, then row-by-row). For `A1:B2` the order is `A1, B1, A2, B2`. **This matches Excel's CONCAT canon.** But the doc comment on line 1374 just says "row-major order" without explaining what that means for a 2D range. The test `concat_flattens_range` (line 2644) uses a 1×N range, so it doesn't exercise the 2D semantics. A future contributor refactoring `read_range_with_shape` could silently flip this to column-major and only smoke tests on real sheets would catch it.

**Cite:** `crates/ql-functions/src/range_fns.rs:1374` (docstring), `crates/ql-exec/src/env.rs:166-171, 181-186`.

**Fix:** Pin with a 2x2 range test: `concat(&[r2d(vec![t("a"), t("b"), t("c"), t("d")], 2, 2)])` → `t("abcd")`.

---

## NEW LOW

### L1 — `WildcardPattern::matches` and `search_in` allocate two Vec<char> per call

Each call: `text.to_uppercase()` (allocation 1), `.chars().collect::<Vec<char>>()` (allocation 2). For a 1M-row SUMIF, that's 2M allocations on the hot loop. Recommend pre-computing the per-call invariant `Vec<char>` once before the cell-iteration loop in `sumif` / `countif` / etc., or storing the pattern's literal parts as `&[char]` for prefix-matching.

**Cite:** `crates/ql-functions/src/wildcard.rs:87-91, 100-104`.

### L2 — Pattern compilation happens per-call inside `build_predicate`

CONCERN-I in the brief flagged this. Each `SUMIF(A:A, "foo*", B:B)` recompiles `WildcardPattern` on every formula evaluation. The pattern is invariant of the data, so a per-formula compile + cache (keyed on the criteria text) would help. This was filed as deferred-perf by the brief; I confirm it's worth a GAP-F entry rather than silent deferral.

**Cite:** `crates/ql-functions/src/range_fns.rs:256-258` (compile inside per-call build_predicate).

### L3 — PROPER's grapheme behavior diverges from Excel for Turkish dotted-I and some Unicode classes

`PROPER` iterates per-Unicode-scalar via `c.is_alphabetic()` and `c.to_uppercase() / to_lowercase()`. For Turkish locale, `İ.to_lowercase() = "i̇"` (two scalars: i + combining dot), which Excel's locale-aware PROPER would never produce. Filed as Phase 4.9 (DBCS/locale) per the matrix's `LEFTB/RIGHTB/...` row; document the divergence explicitly under the PROPER row in `excel-matrix.md` so the next session doesn't double-discover it.

**Cite:** `crates/ql-functions/src/scalar_fns.rs:1425-1438`.

### L4 — CLEAN's behavior on 0x7F (DEL) is correct but not pinned

`CLEAN` strips `(*c as u32) < 0x20` (`scalar_fns.rs:1454`). Excel's canon: strips 0x00-0x1F only; 0x7F (DEL) is NOT stripped. The impl is correct (DEL passes through), but no test pins this — `clean_preserves_high_chars` only covers space and `café`. CONCERN-D specifically called this out.

**Fix:** `clean(&[t("a\x7fb")])` → `t("a\x7fb")`.

### L5 — RANK.AVG ascending-order detection uses `*n != 0.0` for Number

`crates/ql-functions/src/range_fns.rs:1266`. The third arg `order` evaluates true (ascending) when `n != 0.0`. So `RANK.AVG(x, ref, 1.5)` is ascending, `RANK.AVG(x, ref, -1)` is ascending. Excel canon: any non-zero number is "true" for ascending — matches our impl. But `n == 0.0` matches `-0.0` (IEEE 754 equality), so `RANK.AVG(x, ref, -0.0)` is descending. Edge case, not pinned, probably fine.

### L6 — CEILING.MATH and FLOOR.MATH `mode == 0.0` branch on `-0.0` correctness

Both impls (`ceiling_math:956`, `floor_math:1018`) branch on `mode == 0.0`. In IEEE 754, `-0.0 == 0.0` is true. So `CEILING.MATH(-4.3, 1, -0.0)` follows the mode=0 branch. Reasonable; not pinned.

For `mode = NaN`: `NaN == 0.0` is false → falls into the mode≠0 branch. Excel would probably return `#VALUE!` for NaN mode. Quantbook treats NaN-mode as truthy and continues. Not breaking, not pinned.

### L7 — Excel-matrix table doesn't tag known divergence on PROPER (Unicode case folding) or CONCAT (32K cap)

The L3 and M1 divergences above are not surfaced in `docs/compat/excel-matrix.md:154` (PROPER row) or `:158` (CONCAT row). Both rows are `✅`. Either downgrade to `⚠️` with a footnote, or add the divergences to a known-gaps doc.

### L8 — Test naming inconsistency

The W5-61 SEARCH wildcard tests at `scalar_fns.rs:3000-3031` are well-named, but `search_wildcard_with_start_skips_earlier_match` actually verifies `search_in`'s 0-indexed math, which is more subtle than the name suggests. Minor; readability only.

---

## Per-concern assessment (A-K)

### A — Wildcard semantics correctness

**Mostly correct, with one HIGH and one MEDIUM.**

- `?` consuming empty string → returns false (verified at `match_parts:129-130`). ✓
- `*` greediness vs `?` minimality (e.g. `?*?`) → I added a scratch test `audit_question_minimality_vs_star_greed`; it correctly requires ≥2 chars and rejects empty / 1-char input. ✓
- Unicode multi-byte under `?` → operates on Unicode scalars (Vec<char>). Matches one scalar. Diverges from Excel on emoji ZWJ. **MEDIUM M2.**
- Empty pattern `""` → only matches empty string (test `empty_pattern_matches_only_empty:237-241`). ✓
- Trailing `~` with no escape target → treated as literal `~` (verified manually + scratch test). Correct Excel-lenient behavior. **No test pins it.**
- `has_wildcards` on `~~?` → `has_wildcards` consumes `~~` as escape pair, then `?` is unescaped, returns true. Walk: c='~', chars.next() consumes '~'. c='?', returns true. ✓
- `build_predicate` over-routing on `~`-containing benign text → compiles to literal match; behavior is correct. **No test pins it.**
- **NEW: pathological backtracking (H2) — 3.6s for 30-char input against 10-star pattern.**

### B — SEARCH behavioral preservation

**Correct delegation to `WildcardPattern`, but three edge cases not pinned by tests (M3).**

- All pre-W5-61 SEARCH tests still pass — verified `cargo test -p ql-functions --lib`: 360 tests pass.
- Empty needle returning `start_num`: handled at `scalar_fns.rs:1682-1684`. **No test.**
- `start_num > total + 1` → #VALUE!: handled at `scalar_fns.rs:1677`. **No test.**
- `start_num < 1` → #VALUE!: same line. **No test.**
- `start_idx == total` with non-empty needle: handled at `wildcard.rs:102-104` (range check) and the iteration `i in start_idx..=upper.len()`. Returns None. ✓
- Performance: no regression for plain text — pattern with one Literal part is O(n·m) like the prior linear scan. The two `to_uppercase + collect` allocations per call are a minor regression (L1).

### C — CEILING.MATH / FLOOR.MATH edge cases

**Mostly correct, well-tested, with two un-pinned subtleties (L6).**

- `significance = 0`: CEILING.MATH returns 0 unconditionally (matches CEILING canon); FLOOR.MATH returns 0 for number=0, DivZero otherwise. Both verified at `scalar_fns.rs:948-950, 1007-1012`. Test coverage at `ceiling_math_zero_significance_returns_zero` and `floor_math_zero_significance_*`. ✓
- `mode = 0` vs `mode != 0`: correct branch via `if number >= 0.0 || mode == 0.0`. Edge: `-0.0 == 0.0` is true, so -0.0 hits mode=0 branch. `NaN == 0.0` is false → mode≠0 branch. L6; not breaking.
- Negative significance: `abs(significance)` ignores sign. Tested at `ceiling_math_uses_abs_significance`. ✓
- `significance < 0 AND mode != 0`: `abs_sig` is positive, mode branch chooses the floor (line 959). Walk: `CEILING.MATH(-4.3, -1, 1)` → abs_sig=1.0, mode!=0, number<0, branch chooses `.floor()` → `(-4.3 / 1).floor() = -5`, * 1 = -5. Matches Excel.
- Empty third arg (`,`) delivering Blank vs being omitted: both paths coerce to mode=0.0 (line 942-944 / 1001-1003). Defensive coding, ✓.
- **NEW: NaN injection — `CEILING.MATH(NaN, 1, 0)` evaluates to NaN at the math layer, then `sanitize_f64` returns `Value::Error(Num)`. Not pinned by a test.**

### D — PROPER + CLEAN edge cases

**Correct for common cases; two un-pinned divergences (L3, L4).**

- PROPER on empty: ✓ pinned (`proper_empty_and_blank`).
- PROPER on Unicode `café`: produces `Café` (verified by reasoning). Correct.
- PROPER on Turkish dotted-I: would produce `i̇` (two chars). Diverges from Excel locale-aware version. **L3.**
- PROPER on emoji ZWJ: per-scalar; diverges from grapheme-aware Excel. **L3.**
- CLEAN on 0x7F: preserved (line 1454). Correct. **Not pinned.** **L4.**
- CLEAN on Unicode format chars (Cf): preserved (no special handling). Matches Excel's "strip 0x00-0x1F only" canon.

### E — RANK.AVG correctness

**Correct arithmetic; one un-pinned edge case (L5).**

- Tie-arithmetic: `better + 1 + (ties - 1) / 2`. Walked through `[10, 20, 20, 30]` desc with target=20 → better=1 (only 30), ties=2 → 1 + 1 + 0.5 = 2.5. Matches Excel formula `RANK.EQ + (ties-1)/2`. ✓ Tests at `rank_avg_descending_with_ties_averages` etc.
- 0.0 == -0.0 → counted as a tie (IEEE 754). Excel's behavior: also counted (no -0.0 in normal Excel data). Negligible. **L5.**
- NaN target: `ties = 0` → #N/A. Excel can't store NaN, so this is moot.
- Empty ref → #N/A. ✓ pinned.
- value not in ref → #N/A. ✓ pinned (`rank_avg_value_not_in_ref_is_na`).
- 4-arg arity → #VALUE!. ✓ pinned (`rank_avg_arity_error`).
- order interpretation: `n != 0.0` is ascending. ✓ matches Excel.

### F — CONCAT correctness

**Correct row-major iteration via `env.read_range_with_shape`. One Excel divergence (M1) and one un-pinned 2D test (M5).**

- Row-major order: verified `env.rs:166-171` (`for row { for col { ... } }`). For `A1:B2` → A1, B1, A2, B2. Matches Excel canon. ✓
- Error propagation: first error wins (line 1383, 1389-1391). ✓ pinned.
- Empty args → #VALUE!. ✓ pinned.
- Blank cells → "". ✓ pinned.
- 32K char cap: NOT enforced. Excel canon enforced. **M1.**
- No 2D-shape test pinned. **M5.**

### G — Predicate over-routing

**Benign in current implementation, but un-pinned.** See M4 above. Walked through `"<>~?"`, `"foo~"`, `"~"`, `"foo~bar"`. All compile to the correct pattern; all run-time behavior matches Excel canon. No bug today, but the contract isn't pinned.

### H — `is_aggregate_function` whitelist sync invariant

**Drifted. This is H1.** The matcher in `plan.rs:233-240` includes `RANK.AVG` and `CONCAT`, but the test in `workbook_runtime.rs:2542-2562` does not. The test still passes because the invariant is one-way ("matcher names must be registered"), not bidirectional, but the W5-58 ship for MEDIAN/MODE updated the test. The W5-61 ship didn't.

### I — Performance regressions

**One LOW, one LOW.** L1 (per-call Vec<char> allocation) and L2 (per-call pattern compile). Both are real, both are deferrable, both should be filed as GAP-F entries if not already.

### J — Test coverage gaps

The brief listed examples; I confirm the following are NOT pinned:

- PROPER with multi-byte Unicode (only "café" pass-through, no full case-folding test).
- CLEAN with 0x7F (DEL).
- `CEILING.MATH(NaN, 1, 0)`.
- CONCAT exceeding 32K char cap (M1).
- Wildcard matching empty string (`empty_pattern_matches_only_empty` covers `""` pattern, but not `"*"` on empty haystack — though `just_star_matches_anything` does cover that).
- SUMIF with wildcard criteria over mixed Number+Text values (`countif_wildcard_does_not_match_numbers` covers COUNTIF; the SUMIF analog isn't pinned).
- RANK.AVG with 0.0 / -0.0 distinction (L5).
- SEARCH with empty needle (M3).
- SEARCH with start beyond haystack with non-empty needle (M3).
- Predicate over-routing with literal-`~` criteria (M4).
- CONCAT row-major 2D test (M5).

### K — Docs vs code consistency

**Mostly consistent.**

- COUNTIF promoted ⚠️ → ✅: confirmed at `docs/compat/excel-matrix.md:69`. ✓
- Test count assertion at `registry.rs:338` says 108: confirmed via `cargo test`. ✓
- Phase 4.4 "next session" reference in `docs/audits/2026-05-13-engine-session-final-handoff.md:239`: still accurate post-W5-61 (the doc is the W5-60 handoff; W5-61 ships the polish micro-batch it predicted on line 9).
- SUMIF / SUMIFS / AVERAGEIF still ⚠️ in the matrix despite wildcards landing: not a contradiction — the ⚠️ is for the pre-existing W5-60 sum_range shape divergence, not wildcards. The row prose says so explicitly. ✓
- PROPER ✅ but actually diverges on Turkish locale + grapheme clusters (L3, L7).
- CONCAT ✅ but no 32K cap (M1, L7).
- Gotchas 19/20 in `docs/process/audit-protocol.md:318-326` correctly capture the wildcard semantics (text-cell only) and SEARCH-routing rule. ✓

---

## What's needed for W5-62 closure

1. **[H1] Pin `RANK.AVG` + `CONCAT` in the invariant test** — two lines added to `crates/ql-exec/src/workbook_runtime.rs:2542-2562`. Trivial fix, mandatory before next ship.

2. **[H2] Memoize `match_parts` / `match_prefix`** — either via a `(text_pos, parts_pos) → bool` cache or convert to an NFA. The current matcher is exponentially slow on `a*a*a*a*...b` patterns and is a denial-of-service path on user-controlled criteria text. **Mandatory before this ships to a user-facing sheet on real data.** If the project chooses to ship as-is, file as a known-gap and disclose explicitly in the matrix.

3. **[M1] CONCAT 32K cap** — match REPT's behavior; return `#VALUE!` when output exceeds 32,767 chars. Compile-time constant; ~5 lines.

4. **[M3] SEARCH edge-case tests** — three trivial test additions (empty needle, start_num too large, start_num < 1).

5. **[M4] Predicate routing tests** — two test additions for literal-`~` criteria.

6. **[M5] CONCAT 2D shape test** — one test using a 2×2 range fixture to pin row-major flattening.

7. **[M2, L3, L7] Document the grapheme/locale divergences** — flip the PROPER row to `⚠️` in `docs/compat/excel-matrix.md:154` with a footnote, or add to `docs/known-gaps.md`.

8. **[L1, L2] File GAP-F-XX entries for the two perf-deferred items** — per-call `to_uppercase + collect` allocation and per-call pattern compile.

Items 1, 2, and 3 are the only true blockers. The rest is paperwork and test-coverage hygiene.

**Bottom line:** W5-61 ships 6 working functions and a usable wildcard layer. The Excel-canon claim is mostly justified. The matcher needs memoization before this can survive an adversarial user, and the invariant-test drift must be repaired before the next ship to preserve the protocol's value.

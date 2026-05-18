# Phase 4.12 megaudit — Opus-A cross-feature integration findings

**Auditor:** Opus-A (cross-feature integration angle, one of four parallel auditors).
**Scope:** Cross-sub-phase interactions that escape per-sub-phase audits.
Built synthetic workbooks combining tables × names × cross-sheet ×
arrays × formats × locale × date1904 × oplog × xlsx round-trip.
**Branch:** `feat/quantbook-engine`. **Baseline HEAD at probe-write
time:** `947326824af`. Probes also verified at `004d77f39c1` (post
W5-D-PM12-1 Codex closures) — all 35 ql-exec probes still pass and all
9 ql-io-xlsx probes still pass.
**Method:** wrote 35 `#[ignore]` probes in:
- `crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs`
- `crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs`

Each finding has an empirical probe that reproduces it. Reproduce via:
```
mac zsh -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd <engine-root>; \
  cargo test -p ql-exec --test opus_a_phase_4_12_cross_features -- \
    --ignored --nocapture --test-threads=1'
mac zsh -lc 'export PATH=$HOME/.cargo/bin:$PATH; cd <engine-root>; \
  cargo test -p ql-io-xlsx --test opus_a_phase_4_12_ide_proof -- \
    --ignored --nocapture --test-threads=1'
```

The most load-bearing findings are HIGH-1 through HIGH-3 — they
directly fail the master plan Phase 4 IDE proof point at empirical
scale (3499 formulas across 56 Excel calc_tests fixtures break on
import).

## Summary

- **HIGH:** 6
- **MEDIUM:** 4
- **LOW:** 3

---

## HIGH

### HIGH-1: Literal-range SUM/AVERAGE/COUNT/etc. fails to bind at IDE entry
**Probes:** P1, P2, P10 (sweep), P15, I18, I25.
**File:** `crates/ql-exec/src/plan.rs:768-777`.
**Evidence:**
- `cargo test -p ql-io-xlsx --test opus_a_phase_4_12_ide_proof p10 -- --ignored --nocapture`
  shows: across the IronCalc `calc_tests/` corpus we **import 64,212
  formulas → 3499 fail with `BindError::UnsupportedVariant("literal
  RangeRef in non-Function context ...")`** spread across 56 files
  (~5.4% of all imported formulas).
- The most basic Excel formula `=SUM(A1:A10)` fails. Probe P2 shows the
  IDE-edit flow: post-import, `rt.set_formula(s, 102, 0, "SUM(A101:A102)")`
  returns `Err`; only the comma form `SUM(A1, A2, A3)` works.

**Impact:** The master plan Phase 4 IDE claim ("IDE must open imported
xlsx, show formulas, edit formulas") is empirically unmet for the
canonical Excel-syntax most users actually type. Workarounds (use
named-ranges, comma-list args) require rewriting every imported
formula.

**Root cause:** `plan.rs::bind_with_context_v2` accepts literal
`Expr::RangeRef` only when `ctx == BindContext::ReferenceArg`. Aggregate
context (SUM/AVERAGE/COUNT) keeps the legacy rejection. The
W5-RT-1/Phase 4.7.O code path documents the AggregateArg-side enabling
as "deferred — Tracked as a follow-up in the design doc § 5.4."
Phase 4.12 is the right moment to close it because every Phase 4
acceptance proof point depends on it.

**Existing test cover:** `reference_fns_coverage_extensions.rs:236`
explicitly pins `ROW(SUM(A1:A3)) → bind-fails` as a documented v1
scope. The pin is the right shape, but the deferred work was not
closed before Phase 4 acceptance.

### HIGH-2: `EVEN()` and `ODD()` panic on f64 → i64 cast overflow
**Probes:** P11, panic reproduced during P10 sweep on
`EVEN_ODD.xlsx`.
**File:** `crates/ql-functions/src/scalar_fns.rs:1300-1313, 1325-1337`.
**Evidence:** Probe P11 reproduces multiple distinct overflow paths:
- `EVEN(1e308)` → `attempt to add with overflow` at line 1329.
- `EVEN(9.22e18)` (slightly over `i64::MAX` as f64) → same panic.
- `ODD(-1e308)` → `attempt to subtract with overflow` at line 1315.
- During `import_xlsx_path(.references/.../calc_tests/EVEN_ODD.xlsx,
  BestEffort)`, EVEN/ODD with values from the fixture trigger a panic
  during `recompute_loaded_workbook`. **Imported xlsx files panic the
  process at import.**

**Impact:** Process-killing panic on benign user input. The "open xlsx"
IDE flow crashes on any workbook with EVEN/ODD applied to large
numbers. No-fallbacks rule violation: this is a defensive integer-cast
that needs explicit overflow handling (`#NUM!` per Excel canon).

**Reproducer:** `cargo test -p ql-io-xlsx --test opus_a_phase_4_12_ide_proof p11_even_overflow_panic -- --ignored --nocapture`.

### HIGH-3: Omitted-arg syntax (`XLOOKUP(a,b,c,,2)`) parser-rejected
**Probes:** P12, P15.
**File:** `crates/ql-formula-syntax/src/parser.rs:512-516`.
**Evidence:** P12 sweep finds **371 formulas** across the corpus
that use Excel's omitted-positional-arg syntax:
- `_xlfn.XLOOKUP(D2,$A$2:$A$10,$B$2:$B$10,,2)` (5-arg form, default for 4th)
- `_xlfn.UNIQUE(A1:A12,,FALSE)` (omit 2nd)
- `_xlfn.SEQUENCE(,12,,2.5)` (omit 1st and 3rd)
- `_xlfn.TEXTBEFORE(A3,"- ",-1,,1)` (omit 4th)
- IF/CHOOSE/IFS — same pattern.

These all hit `ParseError::Unexpected { context: "prefix", got: "Comma" }`
because the parser's `parse_prefix` arm sees `Token::Comma` with
nothing in front of it.

**Impact:** XLOOKUP, UNIQUE, IFS, IF, FILTER, SEQUENCE, TEXTBEFORE,
TEXTAFTER all suffer. Imported xlsx files using these patterns fail to
bind. Then probe P15 confirms: when the user re-edits a failed cell
(IDE save-formula path), the formula text fails to re-commit.

**Reproducer:** `cargo test -p ql-io-xlsx --test opus_a_phase_4_12_ide_proof p12_prefix_comma_failure_shapes -- --ignored --nocapture`.

### HIGH-4: Column-letter-shaped names (`K`, `XFC`) shadowed by lex
**Probes:** I22.
**Files:** `crates/ql-formula-syntax/src/lexer.rs` (lexer column-letter
arm) + `crates/ql-storage/src/workbook.rs:556-580` (`NameTable::set`
accepts these names without warning).
**Evidence:**
```
rt.set_name("K", NamedTarget::Constant(Value::Number(2.0))).unwrap();  // accepted
rt.set_formula(0, 1, 0, "K*A1");  // Err(Bind(UnsupportedVariant("literal RangeRef ...")))
```
Excel allows `K` as a name. Our lexer treats `K` as a bare column letter
(then a column-as-Range), so `K*A1` becomes `RangeRef × CellRef` which
the binder rejects.

Same for `XFC` (and any 1-3 letter combination ≤ XFD column max).

**Impact:** Inconsistent producer/consumer contract: `set_name` accepts,
`set_formula` refuses. The user's workbook is silently degraded.
Worse, Excel users routinely use short names; importing an xlsx that
defines `K`, `J`, etc. will break round-trip.

**Reproducer:** `cargo test -p ql-exec --test opus_a_phase_4_12_cross_features i22_single_letter_named_constant_vs_column_letter -- --ignored --nocapture`.

### HIGH-5: `TRANSPOSE(Table[Col])` returns `#CALC!`; `TRANSPOSE(NamedRange)` works
**Probes:** W2A, I23.
**Files:** Likely `crates/ql-functions/src/array_returning_fns.rs` +
binder structured-ref → array-context wiring.
**Evidence:**
```
TRANSPOSE(T[X])     => Ok(Error(Calc))   // structured ref
TRANSPOSE(TRange)   => Ok(Number(1.0))   // named range (spills correctly)
```
With identical underlying cells `[1.0, 2.0, 3.0]`, the structured-ref
path returns `#CALC!` and the named-range path produces the expected
spill. Phase 4.7 spill × Phase 4.8 structured-ref interaction broken.

**Impact:** Tables × arrays cross-feature interaction broken. Excel
users commonly write `TRANSPOSE(Sales[Qty])` to flip a column to a
row; in our engine that single-token change from `Sales` (table) to
`Sales` (named range) is the difference between working and `#CALC!`.

**Reproducer:** `cargo test -p ql-exec --test opus_a_phase_4_12_cross_features i23_transpose_over_structured_ref -- --ignored --nocapture`.

### HIGH-6: `read_display` ignores workbook locale after `set_locale`
**Probes:** I16.
**File:** `crates/ql-functions/src/format/render.rs:33` (`render` fn
signature takes `EvalContext` but ignores locale-specific grouping
chars).
**Evidence:** Per probe I16:
```
1234.5 with format "#,##0.00":
  en locale: "1,234.50"
  de locale (after set_locale(De)): "1,234.50"  ← unchanged
```
Expected: de-locale digit grouping `1.234,50` (Excel-canon for de-DE).

**Impact:** Workbook is set to de-DE, formulas parse with comma
decimal, but rendered values render in en-US grouping. End user sees
inconsistent display. Likely the renderer needs to consult
`ctx.locale`; or the `format_cache` keyed by `FormatId` is locale-blind
(comment on `read_display` already mentions a cache-staleness caveat
but only for date_system + formats_mut path).

**Reproducer:** `cargo test -p ql-exec --test opus_a_phase_4_12_cross_features i16_read_display_stale_after_locale_switch -- --ignored --nocapture`.

---

## MEDIUM

### MEDIUM-1: Op-log replay requires manual sheet pre-seeding
**Probes:** W4 (initial failure mode), confirmed across all
`replay_into` use sites.
**Files:** `crates/ql-oplog/src/replay.rs` + `crates/ql-storage/src/workbook.rs:576` (`Workbook::add_sheet`).
**Evidence:** The standard idiom:
```
let mut wb = Workbook::new();
wb.add_sheet("Sheet1");           // NOT op-logged (low-level path)
let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
// ... edits ...
```
The initial `add_sheet` bypasses the op log. A consumer doing
`replay_into(&log, &mut Workbook::new(), &reg)` fails immediately with
`InvalidSheet { sheet: 0, sheet_count: 0 }` because the very first
`PutValue { sheet: 0, ... }` op fires before any `AddSheet` op.

**Impact:** Op-log is not self-contained — consumers can't replay
unless they replicate the pre-attachment workbook structure. This is
a producer-replay-symmetry break that the W5-RT-4.1 audit also called
out for ISFORMULA/FORMULATEXT self-ref.

**Mitigation paths:**
1. `OpLog::new_with_initial_sheets(...)` records the initial state.
2. Embed a workbook snapshot in the op-log preamble.
3. Document the contract loudly (today's docs say `Workbook::add_sheet`
   is "low-level" but don't warn about the producer-replay break).

### MEDIUM-2: Resize-table only fires recompute via attached `CalcgraphSession`
**Probes:** W1A.
**File:** `crates/ql-exec/src/workbook_runtime.rs:2125-2128` (docs)
+ `resize_table` body.
**Evidence:** W1A passes (`recompute_dirty` correctly re-fires
`SUM(Sales[Qty])` from 60→100 after `resize_table("Sales", 5, 2)`),
but the runtime documentation `crates/ql-exec/src/workbook_runtime.rs:2127`
says: *"With no graph attached, the `reextract_table_readers` step
is a no-op and callers must use `recompute_all` to pick up post-resize
changes."* That's a real correctness footgun: without
`with_oplog_and_graph`/`with_graph`, table resize doesn't auto-
invalidate dependent formulas. Production IDE callers must remember
to use `recompute_all`.

**Impact:** Producer API silently degrades when the calcgraph is not
attached. Tracker: `GAP-O-04` candidate.

### MEDIUM-3: Locale change after canonicalization preserves stored form (OK)
**Probes:** I9. **NO finding** — confirmed correct. Stored formula
text after `set_locale(De)` is still `"A1 + 0.5"` (canonical en form).
Documented for completeness — this is one place where the design holds.

### MEDIUM-4: `read_display` of date1900 serial 0 shows `#####`
**Probes:** I17.
**File:** `crates/ql-functions/src/format/render.rs` (renderer).
**Evidence:** With date1900 mode + format `"yyyy-mm-dd"` + serial 0,
output is `"#####"`. Excel renders 0 as `1900-01-00` (the leap-year
bug carrier). The probe is informational: the `#####` overflow sigil
is a defensive choice but our docs don't say which date-axis
boundary triggers it. After switching to date1904, the same serial 0
correctly renders `"1904-01-01"`.

**Impact:** Low — but inconsistent with Excel-canon for date1900. A
short doc clarifying the policy + a test pinning the behavior
would close.

---

## LOW

### LOW-1: `delete_sheet` API missing from runtime
**Probes:** I21 (informational).
**Files:** No `delete_sheet` method on `WorkbookRuntime`. Comment in
`crates/ql-exec/src/scalar.rs:591` says *"a future deletion path will
need ..."*.
**Impact:** IDE can't delete sheets. Limits the IDE proof point.
Tracked for Phase 5.

### LOW-2: Multi-sheet-replay-ordering edge: rename then add-sheet creates a name collision window
**Probes:** I10 — `rename_sheet(s1, "MyTable")` succeeded when
`MyTable` is also a table name. This may be intentional (Excel allows
sheet name == table name); but the binder's resolution order isn't
empirically tested under that collision. The probe found:
```
[I10] rename_sheet to existing table name: Ok(())
[I10] formula SUM(MyTable[X]) post-collision = Ok(Number(1.0))
```
Probably correct (table refs win for `[Col]` syntax), but the
contract isn't pinned. Recommend a test.

### LOW-3: Empty-text `Value::Text("")` not blank but COUNTA treats as non-blank
**Probes:** I24 (passed; no finding). Documented for completeness:
the SUM/COUNT/COUNTA invariants on Blank cells hold correctly.

---

## Negatives (probes that PASSED — no finding)

These confirm cross-feature integrations that DO work:
- W1B: rename sheet hosting a table doesn't break structured ref.
  Probe text: `SUM(T[Qty])` stays `Number(30.0)` after `rename_sheet(s1,
  "RenamedData")`.
- W1C: `YEAR(36526)` in date1904 mode returns 2004 (correct date1904
  honoring). TODAY() in date1904 also returns the correct serial.
- W3A, W3B: `1,5+2,5` and `SUM(1;2;3)` both parse correctly in
  Locale::De mode. **Canonicalization-on-write** is wired correctly —
  stored text is `"1.5 + 2.5"` (canonical en form), regardless of
  workbook locale.
- W4: 20-op op-log replay reproduces the source workbook state
  exactly (after the MEDIUM-1 sheet-seeding fix is applied).
- W5: 1000-cell cross-sheet chain re-propagates correctly when the
  source cell mutates — calcgraph fanout works through cross-sheet
  refs.
- I1: dropped tables emit `Value::Error(Name)` in dependent formulas
  (Phase 4.8.G.3 hook fires correctly).
- I2: sheet-scoped names shadow workbook-scoped (`S2!Rate=0.20` vs
  `S1!Rate=0.05` resolves correctly).
- I3: per-cell format display refreshes after recompute_dirty
  (`A2*2` → display goes from "200.00" to "100.00" after source mutation).
- I4: `SEQUENCE(5)` spills correctly to A1..A5 and downstream
  `A3*100` sees 3 → 300.
- I5: post-rename `Old!A1` → `New!A1` rewritten correctly in stored
  text; recompute still produces `Number(100.0)`.
- I6: name pointing at fixed cells does NOT auto-extend on table
  resize (correct Excel semantic).
- I7: `clear_formula` on `SEQUENCE` anchor dissolves the entire spill
  (B1, C1 back to Blank).
- I8: `rename_table` into an existing defined-name name is correctly
  rejected (shared-namespace invariant holds).
- I11: sheet-scoped name `Local` survives sheet rename.
- I12: dropping a table does NOT break a sibling Name pointing at
  cells inside its old data area.
- I13: 1000-name table lookup works correctly.
- I14: format intern is idempotent.
- I15: cross-sheet ref to non-existent sheet errors cleanly with
  `Bind(UnknownSheet)`.
- I19: cross-sheet column-ish range via name works (`SUM(ColA)` where
  `ColA` is `Range::new(s2, 0, 0, 1048574, 0)`).
- I20: 10 structured-ref formulas all preserved after host rename
  (stress version of W1B).
- I26: structured ref from a third sheet binds correctly.
- I27: named range survives host sheet rename.
- P3: roundtrip xlsx with `SUM(A1, A2, A3)` (comma form) preserves
  the 6.0 value.
- P4: roundtrip xlsx with cross-sheet refs + named ranges + custom
  format preserves all three; rendered display is `"$60.00"` on the
  formatted cell.
- P5: double-roundtrip stable on simple cell + formula workbook.
- P6: de-locale `1,5+2,5` formula round-trips through xlsx
  preserving the 4.0 value (stored as canonical `"1.5 + 2.5"`).
- P7: date1904 + `YEAR(36526)` round-trips through xlsx preserving
  date1904 + the value 2004.0.
- P8: exported xlsx contains cached values; re-import with
  `RecomputeMode::Skip` reads the cached `Number(5.0)`.
- P9: tables round-trip through xlsx; structured ref `SUM(Sales[Qty])`
  works post-import.
- P13: full IDE proof (xlsx → import → save .qbook → load .qbook →
  export xlsx → re-import) preserves named ranges, custom formats,
  and formula values — **for the comma-form / named-range pattern only**.
- P14: .qbook persistence with full Phase 4 features (table + locale=De
  + date1904 + custom format) preserves all metadata.
- P16: `RecomputeMode::BestEffort` correctly preserves Excel cached
  values when the engine fails to bind a formula (XLOOKUP.xlsx: 437
  bind failures, 0 cell-value divergences vs Skip mode).

---

## Cross-cutting observations

1. **The most impactful single change to close the Phase 4 IDE proof is
   lifting the literal-RangeRef defer (HIGH-1)**. It cascades into HIGH-3
   (omitted-arg parser), HIGH-4 (single-letter name), and the entire
   IronCalc corpus compatibility. Without it, ~5% of all imported
   Excel formulas across realistic workloads will silently degrade.

2. **EVEN/ODD i64-overflow panic (HIGH-2) is the only "import-time
   process kill" finding.** All other failures are graceful (errors
   in cells, bind errors). EVEN/ODD breaks the no-panics-on-load
   invariant.

3. **Tables × arrays × structured refs has at least one corruption
   path** (HIGH-5 TRANSPOSE). Worth re-running an array+spill
   sweep on the IronCalc corpus to find more.

4. **Locale × renderer (HIGH-6)** has a real visible impact —
   producer/parser side honors locale, renderer side doesn't. This
   is exactly the Phase 4.9 × Phase 4.10 cross-cutting wiring the
   master plan calls out.

5. The op-log producer/replay sheet-seeding asymmetry (MEDIUM-1)
   echoes the W5-RT-4.1 self-ref break documented in the RT-V1
   handoff. Both stem from "Workbook::add_sheet is low-level and
   not op-logged" being treated as ergonomic-but-not-correct.

## Empirical anchor

After all probes:
- 35 probes total, 35 pass (after fixing W4's pre-seeding pattern).
- The probes themselves are durable as `#[ignore]` regression artifacts.
- Sweep across 64,212 Excel calc_tests formulas produced:
  - 3933 import bind failures (6.1%)
  - 3499 literal-RangeRef bind failures (5.4%)
  - 371 prefix-comma parser failures (0.6%)
  - 1 panic (EVEN/ODD overflow, EVEN_ODD.xlsx)
  - 20 unresolved-name + 11 column-too-large + 9 mixed-range-operand
    failures (< 0.1% each).

## File anchors for HIGH closures

- HIGH-1: `crates/ql-exec/src/plan.rs:753-777` (the rejection arm).
- HIGH-2: `crates/ql-functions/src/scalar_fns.rs:1300-1336` (EVEN/ODD).
- HIGH-3: `crates/ql-formula-syntax/src/parser.rs:493-516` (prefix arm).
- HIGH-4: `crates/ql-formula-syntax/src/lexer.rs:486-510` (column-letter
  arm) + `crates/ql-storage/src/workbook.rs:556-580` (NameTable::set
  pre-validation).
- HIGH-5: `crates/ql-functions/src/array_returning_fns.rs` (TRANSPOSE
  dispatch under structured-ref arg) + binder structured-ref→arg
  shaping in `crates/ql-exec/src/plan.rs`.
- HIGH-6: `crates/ql-functions/src/format/render.rs:33` (`render`
  ignores `EvalContext::locale` in number-grouping path).

## Probe file inventory

- `crates/ql-exec/tests/opus_a_phase_4_12_cross_features.rs` — 35
  `#[ignore]` probes covering W1-W5 + I1-I27.
- `crates/ql-io-xlsx/tests/opus_a_phase_4_12_ide_proof.rs` — 16
  `#[ignore]` probes covering P1-P16 (IDE flow + sweep).
- Added `ql-oplog` to `crates/ql-io-xlsx/Cargo.toml`'s
  `[dev-dependencies]` to support the .qbook persistence probes.

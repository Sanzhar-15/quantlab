# Phase 4.5 design doc review — Codex brief

You are reviewing the W5-68 Phase 4.5 architectural decision: **Dates / Times / Number Formats**. This is a design doc, NOT code. Implementation follows. Phase 4.4's W5-63 design-review cycle caught 3 HIGH + 4 MEDIUM + 3 LOW that would have been costly rework; this design needs the same adversarial reading.

**Be adversarial. Find what's wrong, missed, or oversold.**

## Branch + state

- Branch: `feat/quantbook-engine`
- HEAD: `f0ff99de41d` (W5-67 Phase 4.4 mega-audit closure)
- This W5-68 commit (when made) will be doc-only.
- 1424 workspace tests; all 7 gates green.

## Required reading

```
docs/architecture/2026-05-13-dates-times-formats.md   # THE DESIGN UNDER REVIEW
docs/MASTER-PLAN.md                                    # Phase 4.5 entry (acceptance DTF-4-01..04)
docs/architecture/2026-05-13-coercion-matrix.md        # Phase 4.4 architecture (cross-cutting context)
docs/compat/error-matrix.md                            # how Phase 4.5 fits the error semantics
docs/compat/excel-matrix.md                            # current function-library coverage
docs/known-gaps.md                                     # gap list
crates/ql-functions/src/volatile.rs                    # existing NOW/TODAY (~25569 offset)
crates/ql-types/src/value.rs                           # Value variant set + Display impl
crates/ql-types/src/coercion.rs                        # current coercion paths
crates/ql-types/src/lib.rs                             # public surface re-exports
.references/ironcalc/base/src/functions/date_and_time.rs   # 18-fn reference
.references/ironcalc/base/src/formatter/                # format parser reference
```

## Specific review concerns

### CONCERN-A: Storage representation

Design proposes keeping `Value::Number(f64)` as the date+time wire representation. **Verify:**

1. Excel's date serial is at most ~2,958,465 (year 9999). f64 mantissa has 53 bits — `2^53 ≈ 9e15` — way more than enough integer precision for the day part. Time-of-day at 1 second resolution requires `86400` distinct fractional steps; `1/86400 ≈ 1.16e-5`, well above f64 epsilon. No precision concern here?
2. Does ANY downstream Phase 4.6 / 4.7 path need to know "this Number is a date" vs "this Number is plain"? E.g., comparison: `=A1 = TODAY()` works because both are Number. But what about `=A1 + 7` where A1 is a date — produces a Number 7 days later, which is the right behavior. Any case where the cell needs to round-trip its "I am a date" tag?
3. The doc defers `Value::Date` variant ("would proliferate match arms"). Codex review: is that defensible, or is the value-of-the-tag worth the cost?

### CONCERN-B: 1900 leap-year bug centralization

Doc says all date arithmetic routes through `ymd_to_serial` / `serial_to_ymd` which centrally handle the bug. **Verify:**

1. Is this discipline maintainable? Future contributors writing `=DATE + 1` arithmetic might bypass — what guards against it?
2. The bug specifically: in 1900 system, serial 60 = "1900-02-29". For dates `>= 1900-03-01`, the bug just shifts the offset by 1. For dates `<= 1900-02-28`, the bug is invisible. The actual divergence is `DATEVALUE("1900-02-29")` should return serial 60 in 1900 system (Quantbook + Excel), but `DATE(1900, 2, 29)` could either return 60 (Excel canon) or `#NUM!` (logical). What's the right call? Doc doesn't pin this.
3. Does IronCalc reference correctly handle the bug? Sanity check.

### CONCERN-C: Date library choice

Doc decides "roll our own ~500 LOC in `ql-types::date`." Alternatives surveyed:

1. **chrono**: 25k+ LOC, no native 1900-bug, std-only. Doc rejects — reasonable?
2. **time**: smaller, well-maintained. Doc rejects — same reasoning. Is the WASM friction with `time` real or imagined?
3. **jiff**: newest, by BurntSushi. Doc says "Excel-specific quirks not built-in" — does jiff actually have something like an "Excel epoch" extension we'd benefit from?
4. **icu_calendar**: not mentioned. Heavyweight but very correct.

Estimate: 15 fns × ~50 LOC = 750 LOC. Is the LOC estimate realistic for the V1 wave? Cross-check with IronCalc's 1703 LOC for 18 fns (their fns are more elaborate; would Quantbook's match scope?).

Risk: rolling our own means we OWN the date math forever. Tests against IronCalc reference cover the happy path; what about edge cases (year 100, year 9999, daylight-saving — Excel ignores DST, but do we handle it correctly for `TIME`?)?

### CONCERN-D: Function library scope

V1 wave (4.5.B) has 15 fns; V2 wave (4.5.C) has 10. **Verify:**

1. **DATEDIF** — undocumented Excel function. Should it be V1 or V2? Some users rely on it heavily. Doc puts in V2.
2. **NETWORKDAYS / NETWORKDAYS.INTL** — V2. Is this the right split? Most users want simple NETWORKDAYS.
3. **WORKDAY / WORKDAY.INTL** — V2. Same question.
4. **YEARFRAC** — V2. Finance users need this. Could be V1?
5. Missing entirely: `MONTHS()`, `YEARS()`, `DURATION()`, `XNPV()` — those are financial. Probably right to defer.
6. What about `EOMONTH(start, 0)` semantics — does the doc's "End-of-month after `months` offset" handle the 0-offset case? Excel returns last day of `start`'s month.

### CONCERN-E: Format parser scope (DTF-4-03)

Doc V1 scope:
- All digit placeholders + decimal/thousands.
- Common date/time tokens.
- Text literals, basic `;`-section split.
- Currency passthrough.

Doc V2 deferrals:
- Colors, conditional formats, fractions, full locale conversion.

**Verify:**

1. Is the V1/V2 split sound? Most user-visible formats are covered in V1, but conditional formats like `[Red][<0]` are surprisingly common.
2. The grammar lookup table — is it explicit enough? Excel's format-string language is technically `<positive>;<negative>;<zero>;<text>` with up to 4 sections; the doc covers this. What about the special case of `0;-0;;@` (suppress zeros entirely)?
3. Locale: V1 hardcodes en-US separators. Will the parser ACCEPT German `1.234,56` formats but render them as `1,234.56`, or does it reject parse-time? Doc says "locale-aware separators in parsing path" — but is that DTF-4-03's requirement?
4. The `_` (skip width) and `*` (repeat fill) tokens — V1 or V2? Doc doesn't specify.
5. `@` (text passthrough) — V1 listed but doc doesn't detail behavior.

### CONCERN-F: Cell-level format storage (DTF-4-04)

Doc proposes `cell.format_id: Option<FormatId>` + `Workbook::formats: IndexMap<String, FormatString>`. **Verify:**

1. Most Excel cells DON'T carry a custom format — they use the "General" default which is type-context-dependent (date if serial looks like one, number otherwise). The doc punts on the "looks like a date" heuristic. What is it actually? In Excel, the user has to apply a date format explicitly — General mode keeps the serial visible. Is that what Quantbook does, or should we auto-detect?
2. `FormatId` storage cost — `Option<u32>` per cell adds 8 bytes. For 1M cells that's 8MB. Acceptable, but worth a perf note.
3. The dedup table — when a cell's format changes, the old entry isn't garbage-collected. For long-running workbooks with many format changes, the table grows. Is there a "compact" pass needed?
4. xlsx I/O Phase 4.11 import: Excel's xlsx stores format strings as `<numFmts>` indexed entries. Mapping is mechanical, but the doc should be explicit about the index space (numbers 0-163 are built-in; 164+ are custom).

### CONCERN-G: NOW/TODAY upgrade path

Existing `volatile.rs::now/today` use `25569` flat offset. Doc says they get upgraded to leap-year-aware in Sub-phase 4.5.A. **Verify:**

1. The upgrade is a behavior change: pre-W5-68, `NOW()` returned the "approximate" Excel-canon serial; post-W5-68, it returns the EXACT Excel serial. For dates `>= 1900-03-01` this is identical. For dates `< 1900-03-01` it's different. Quantbook NOW always returns current date (post-2024), so no user impact — but the contract change should be noted.
2. The `set_test_now_secs(unix_secs)` test API — does the upgrade affect deterministic-RNG-seed tests in Phase 3.7's volatile suite? Probably not (those use the same Unix-secs path).
3. NOW() returns time-of-day as the fractional part. Excel does the same. But Quantbook's `set_test_now_secs(0)` would give exact `25569.0`; with the leap-year-aware conversion, is that still `25569.0` or shifted?

### CONCERN-H: Effort estimate

Doc estimates ~3 weeks total:
- 4.5.A: 3 days (epoch + serial)
- 4.5.B: 5 days (15 fns wave 1)
- 4.5.C: 5 days (10 fns wave 2)
- 4.5.D: 5 days (format parser)
- 4.5.E: 2 days (TEXT() + locale stubs)
- Mega-audit: 1 day

Compare to Phase 4.4 (estimated 2.5 sessions implementation + 0.5 audit; actually took 5 cycles W5-63 → W5-67 + mega-audit). Is the Phase 4.5 estimate similarly optimistic? Format parser in particular has a history of blowing past estimates.

### CONCERN-I: Risk surface — what's missing from § 10?

Doc § 10 lists 5 risks. What's NOT listed that should be?

1. **`DATEVALUE` parser edge cases**: Excel's `DATEVALUE("January 1, 2025")` works; `DATEVALUE("1/1/25")` works; `DATEVALUE("2025-01-01")` works. Locale-sensitive. V1 says en-US only — but locale parsing in xlsx might surface non-en-US strings. Risk?
2. **Storage migration for legacy `.qbook` files**: existing files don't carry `date_system`. Doc says "default-on-missing." But existing NOW/TODAY values stored in op log are computed with the 25569 offset — would replay produce different serials post-W5-68? Op-log determinism could break.
3. **xlsx import file with extreme dates**: Excel xlsx serials can technically be `< 0` (before epoch) or `> 2_958_465` (year > 9999). Doc says return `#NUM!` — but what does the IMPORTER do with such cells?

### CONCERN-J: Missing items entirely

What's the doc missing? Examples:

- Time-related arithmetic edge: `=NOW() - "1:30:00"` (subtract a time-of-day). Does this work via lenient coercion? The text "1:30:00" doesn't parse via `to_number_lenient` (that's locale-invariant ASCII numeric). Should TIMEVALUE be required?
- DST handling — doc says "Excel doesn't model time zones" — but does our `SystemTime::now()` give UTC or local? Excel gives local. Worth confirming.
- Multiple-section formats with `@`: `0;-0;0;@` — last section is text passthrough. Doc mentions `@` but doesn't describe the rendering path for it.

### CONCERN-K: Design discipline

The Phase 4.4 design doc was ~270 lines after Codex review synthesis. This Phase 4.5 draft is ~290 lines BEFORE Codex review. Is it ALREADY too long, or does the bigger scope warrant the length? Are there sections that should be split into separate sub-docs (e.g., format-parser spec as its own doc)?

## What to report

```
# Phase 4.5 design doc review — verdict (one paragraph)

## NEW HIGH (design flaws blocking implementation)
## NEW MEDIUM (improvements; rework recommended pre-implementation)
## NEW LOW (doc nits, naming, suggestions)

## Per-concern verdict (A–K)
A: ...
B: ...
...

## Recommended changes to the design doc (numbered, actionable)
```

Length budget: 2000-5000 words. Cite file paths + line numbers where relevant.

Save your full output where the dispatch script directs.

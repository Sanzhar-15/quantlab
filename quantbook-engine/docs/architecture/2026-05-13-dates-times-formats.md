# Phase 4.5 Dates / Times / Number Formats — Design Decision

**Date:** 2026-05-13 (W5-68)
**Branch:** `feat/quantbook-engine`
**Status:** DESIGN (pre-implementation, Codex-reviewed). Implementation in subsequent sessions.
**Pattern:** W5-49 architectural-decision pattern. Plan + Codex review BEFORE implementation. Codex review **complete**; this doc incorporates the 4 HIGH + 8 MEDIUM + 5 LOW findings.
**Codex output:** `docs/audits/2026-05-13-w5-68-codex-dates-review.txt`. Key edits driven by review:
- Added § 4.A evaluator-context plan (Codex HIGH 1).
- Removed `General` auto-date-detection (Codex HIGH 2).
- Re-scoped DTF-4-03 to "format parser exists with locale extension points" (Codex HIGH 3); full en/de/fr locale parsing moves to Phase 4.9.
- Added local-time policy + WASM hook for NOW/TODAY (Codex HIGH 4).
- Pinned serial-60 contract per-function (Codex MEDIUM 1).
- Moved simple NETWORKDAYS / WORKDAY / YEARFRAC to V1 wave (Codex MEDIUM 5).
- Specified `_` / `*` / `@` / empty-section format-token behaviors (Codex MEDIUM 6).
- Replaced `cell.format_id` story with concrete sparse format-overlay design + workbook dedup table + op-log shape (Codex MEDIUM 7+8).
- Crate rationale corrected (Codex MEDIUM 4; LOW 3).
- Re-estimated effort (Codex MEDIUM 3; HIGH/H verdict).
- Risks expanded (Codex § I).

---

## 1. Why this phase

Phase 4.5 from `docs/MASTER-PLAN.md` is the last big foundational phase before user-facing surfaces (cross-sheet refs, tables, R1C1, then xlsx I/O). Three deficits in current code force it now:

1. **NOW / TODAY are approximations.** `volatile.rs:108-132` returns `(unix_secs / 86400) + 25569` — a flat 25569-day offset from Unix epoch to Excel epoch. This SKIPS Excel's 1900-leap-year bug (Excel treats 1900-02-29 as a valid date for legacy Lotus 1-2-3 compatibility — serial 60 = "1900-02-29" instead of "1900-03-01"). For modern dates (>1900-03-01) the bug doesn't matter; for any computation that walks back through serial 60 it does.

2. **Zero date arithmetic functions registered.** No DATE, YEAR, MONTH, DAY, HOUR, MINUTE, SECOND, TIME, DATEVALUE, TIMEVALUE, WEEKDAY, EOMONTH, EDATE, DATEDIF, NETWORKDAYS, WORKDAY, DAYS, YEARFRAC. Users who try `=YEAR(A1)` get `#NAME?`. This is the largest single-category gap in the function library.

3. **No display formatting.** The `to_text_for_display` path renders `Number(45810)` as `"45810"` not `"6/30/2025"`. Without a format parser, the engine can compute date arithmetic correctly but the user sees raw serials. For a spreadsheet, that's not acceptable user-visible behavior.

Acceptance items from MASTER-PLAN:
- **DTF-4-01**: 1900/1904 policy explicit.
- **DTF-4-02**: date/time functions match `docs/compat/excel-matrix.md`.
- **DTF-4-03**: number format parser tests include en/de/fr examples.
- **DTF-4-04**: storage distinguishes value from display format.

## 2. Current state

| Component | Status | Where |
|---|---|---|
| Date storage | `Value::Number(f64)` serial — same as Excel | `ql-types::value` |
| Time storage | Fractional part of serial (0.5 = noon) | (implicit) |
| NOW / TODAY | Approximate; no 1900-leap-year handling | `ql-functions::volatile` |
| Other date fns | None | — |
| Format parser | None | — |
| Display rendering | Raw `f64` via `Value::Display` impl | `ql-types::value::Display` |
| Date crate | None imported | (workspace Cargo.toml) |
| Reference | IronCalc `formatter/` + `functions/date_and_time.rs` (~1700 LOC, 18 fns) | `.references/ironcalc/base/src/` |

## 3. Decision A — Epoch + leap-year policy (DTF-4-01)

### 3.1 Storage representation: keep `Value::Number(f64)` serial

**Decision:** Excel-compatible serial-number representation. **Day** is the integer part (days since 1899-12-30 in the 1900-system; days since 1904-01-01 in the 1904-system). **Time-of-day** is the fractional part (`0.0` = midnight, `0.5` = noon, `0.999..` = 23:59:59.9...).

**Rationale:**
- Direct match to Excel's wire representation.
- Preserves `Value::Number` invariants (arithmetic, comparison, coercion all just work).
- Avoids a new `Value::DateTime` variant that would proliferate match arms across the codebase.
- Format string `0.00` vs `mm/dd/yyyy` already needs separate per-cell display metadata — the value is the same `f64` either way.

**Stop condition** (would reverse to `Value::Date` variant): If a Phase 4.5+ function requires distinguishing "this f64 means 45810 days" from "this f64 means the literal number 45810" — there's no current pressure for this. Pin if Phase 4.7 array formulas need date-typed array elements.

### 3.2 1900 vs 1904 epoch — workbook setting, 1900 default

**Decision:** Each workbook carries a `DateSystem { Excel1900, Excel1904 }` enum. Default is `Excel1900`. The setting lives in `workbook.toml` envelope (`Workbook::date_system` field; migrates from existing v2 schema with default-on-missing-field).

**Rationale:**
- Matches Excel: Windows defaults to 1900, macOS Excel historically defaulted to 1904.
- xlsx I/O (Phase 4.11) needs per-workbook readability of the original setting.
- Switching post-load shifts every serial by 1462 days (the 1900↔1904 offset); not a runtime operation in Excel either.

**Excel 1900 leap-year bug**: in the 1900 system, Excel treats 1900-02-29 as a real day (serial 60). For dates `>= 1900-03-01`, this just shifts the offset by 1. The 1904 system has no such bug. Phase 4.5 functions MUST replicate the 1900-system bug (else `DATEVALUE("1900-02-29")` would error on a workbook Excel happily loaded; opens an xlsx-I/O bug class).

**Serial-60 contract (Codex MEDIUM 1 fix)** — pinning behavior per function:

| Operation | 1900-system result | Rationale |
|---|---|---|
| `serial_to_ymd(60.0, Excel1900)` | `Ok((1900, 2, 29))` | The "phantom" leap day. IronCalc maps through `chrono::NaiveDate` which can't represent this; Quantbook returns it explicitly via the bug branch. |
| `ymd_to_serial(1900, 2, 29, Excel1900)` | `Ok(60.0)` | Inverse. |
| `DATE(1900, 2, 29)` | `60` (matches Excel direct-arg canon) | Excel returns serial 60 even though Feb 29 1900 didn't exist. |
| `DATEVALUE("1900-02-29")` | `60` (matches Excel) | Documented Excel quirk; parser special-cases the string. |
| `YEAR(60)` | `1900` | |
| `MONTH(60)` | `2` | |
| `DAY(60)` | `29` | |
| `WEEKDAY(60, 1)` | per `serial_to_ymd` then weekday from offset | The bug shifts weekdays for dates ≤ 60 by 1; document the divergence from a real Wednesday. |
| `serial_to_ymd(60.0, Excel1904)` | `serial_to_ymd_no_bug(60, 1904-01-01)` | 1904 system has no bug; serial 60 = 1904-03-01. |
| `EOMONTH(start, 0)` where start.month=2,year=1900 | Returns serial 60 (last "day" of Feb 1900 per Excel) | Excel canon: month-end of "Feb 1900" is the phantom Feb 29. |

These rows are pinned by tests in sub-phase 4.5.A and 4.5.B. IronCalc is NOT a clean oracle here because it routes through `chrono::NaiveDate` which can't represent 1900-02-29; Quantbook's roll-our-own date module has the explicit bug-branch advantage.

### 3.2.1 NOW / TODAY local-time policy (Codex HIGH 4 fix)

Excel canon: `NOW()` and `TODAY()` return the LOCAL date/time of the user's machine (no time zones modeled in the serial — the value IS local). Pre-W5-68 Quantbook used `SystemTime::now().duration_since(UNIX_EPOCH).as_secs()` which gives UTC seconds.

**Decision:** `EvalContext::now_provider` (§ 4.A) exposes both `unix_secs() -> u64` AND `utc_offset_seconds() -> i32`. The Excel-canon local serial is computed as:

```
local_secs = unix_secs + utc_offset_seconds
serial     = (local_secs / 86_400) + epoch_offset_for_system
```

**Test hooks:** `set_test_now_secs(unix_secs)` continues to override `unix_secs`. New `set_test_utc_offset_seconds(offset)` (default 0 — UTC == local for deterministic tests) overrides the offset. In production, the default `NowProvider` implementation reads from `chrono::Local::now().offset()` OR — to avoid the `chrono` dep — calls into a small `iana_time_zone` lookup (~50 LOC dep) OR uses the libc `localtime_r` FFI. **Decision deferred to 4.5.A implementation:** prototype both and benchmark; the cheaper option wins.

**WASM target:** in `wasm32-unknown-unknown`, `SystemTime::now()` panics and there's no IANA lookup. The `NowProvider` becomes a HOST CALLBACK (provided by JS via the binding boundary). Phase 6.3 bindings code passes a JS callback that returns `(unix_secs, offset_seconds)`. Documented in `docs/architecture/calcgraph-runtime.md` Phase 6.3 entry; for now, just pin the trait shape.

**1904 system:** `epoch_offset_for_system` is `25569` for 1900-system, `24107` for 1904-system (difference: 1462 days). `NOW()` returns the SAME f64 across systems only if the 1900-bug-offset doesn't apply to today's date (it never does, today is past 1900-03-01). So Excel canon is preserved.

### 3.3 Serial range + edge cases

| Range | Validity in 1900 system |
|---|---|
| `serial = 0` | Display oddity: rendered as `1/0/1900` per Excel canon; logically midnight on 1899-12-30. **NOT a real (year, month, day) tuple** — `serial_to_ymd(0)` returns `Err(#NUM!)` per Codex LOW 1; only the formatter's display path renders the "1/0/1900" string. |
| `serial in 1..=59` | 1900-01-01 through 1900-02-28 |
| `serial = 60` | 1900-02-29 (the non-existent leap day; matches Excel) |
| `serial in 61..` | 1900-03-01 onwards |
| `serial < 0` | `#NUM!` (Excel canon) |
| `serial >= 2_958_466` | 10000-01-01; `#NUM!` (Excel canon — Excel can't represent dates past 9999-12-31) |
| Negative time-of-day (e.g. `0.5 - 1.0 = -0.5`) | Date arithmetic should propagate; specific fn behavior covered per-function |

## 4.A Decision A.5 — Evaluator context for date-aware functions (Codex HIGH 1 fix)

**Problem:** The W5-63 `RangeAwareFn` parallel-table pattern handled the "function arg is a range vs scalar" distinction. But Phase 4.5 introduces a NEW distinction: some functions need **workbook context** (date system, locale, now-provider). Under the current `fn(&[Value]) -> Value` signature, `DATE`, `DATEVALUE`, `WEEKDAY`, etc., have no way to read `Workbook::date_system`.

**Decision:** Add a third function-table tier alongside `ScalarFn` and `RangeAwareFn`:

```rust
// ql-functions::context_aware_fns (new module)
pub struct EvalContext<'a> {
    pub date_system: DateSystem,
    pub locale: Locale,
    pub now_provider: &'a dyn NowProvider,  // unix_secs + utc_offset_seconds
}

pub type ContextAwareFn = fn(&[Value], &EvalContext) -> Value;
```

`FunctionRegistry` gains a third table `context_aware_fns: HashMap<&'static str, ContextAwareFn>`. Eval dispatch precedence: `lookup_range_aware` FIRST → `lookup_context_aware` SECOND → `lookup` (scalar) LAST. The W5-65 `names_all()` becomes a 3-table chain.

**Functions on this tier:** DATE, DATEVALUE, WEEKDAY (return_type defaults differ), NOW, TODAY, EOMONTH, EDATE, NETWORKDAYS, WORKDAY, DATEDIF, YEARFRAC, TIME, TIMEVALUE, format-rendering hooks (TEXT).

**Functions NOT on this tier:** YEAR/MONTH/DAY/HOUR/MINUTE/SECOND — these extract from a serial that was ALREADY normalized by the workbook's date_system. They are pure functions of the f64 serial; safe to stay on `ScalarFn`.

**Rationale:**
- Mirrors the W5-63 W5-65 closure pattern (parallel-table tier, dispatch-first-then-fall-through).
- Avoids a thread-local context (testing nightmare; CRDT replay determinism risk).
- `EvalContext` is `Copy`-ish (DateSystem + Locale enums are Copy; now_provider is `&dyn`) — cheap to pass.
- Same coverage-test pattern: `coverage.rs` walks the new third table via an extended `names_all()`.

**Trade-off:** 3 parallel tables is the most complexity the registry has carried. If Phase 4.7 array formulas need yet another tier, we should reconsider the tiered design and move to a unified `EnhancedFn { args: &[FnArg], ctx: &EvalContext } -> Value` shape. That refactor is a Phase 4.7-coupled decision; for now, the tier-3 addition is the smallest viable change.

**Implementation order:** Sub-phase 4.5.A.0 (NEW, prepended): introduce `EvalContext` + `ContextAwareFn` + registry-table-3 + dispatch wiring. ~1 day. THEN 4.5.A epoch+serial (now able to test using the context).

## 4. Decision B — Date library: roll our own

### 4.1 Survey (rationale corrected per Codex MEDIUM 4 + LOW 3)

- `chrono` (25k+ LOC) — large, std-only, no native Excel-leap-year bug support. ~10× the LOC of what we need.
- `time` (smaller) — well-maintained; supports `no_std` (default `std`) and has a `wasm-bindgen` feature. No Excel-leap-year handling.
- `jiff` (newest, by BurntSushi) — `std + alloc` default features; designed for correctness; no Excel-epoch support.

**Decision:** Roll our own ~500-800 LOC in `ql-types::date` (new module). The decisive reason is **Excel serial compatibility** — none of the crates implement the 1900-leap-year bug natively, and the workaround (special-casing serial 60 around `chrono::NaiveDate`) is exactly what IronCalc does and Codex notes as a hazard ("not a clean oracle"). Reasons:
- Excel's date arithmetic is conceptually simple: `(serial → y/m/d/h/m/s)` and the inverse. The 1900-leap-year bug needs a 2-line branch BUT it has to be applied at EVERY conversion site — easier in a single owned module.
- Avoids the dep for a 500-LOC concern.
- Faster compile times; smaller binary.

The `volatile.rs` clock read stays `std::time::SystemTime` on native targets; WASM uses a host callback (see § 3.2.1). Time-zone offset acquisition is the lone "real" external dependency — `iana_time_zone` (~50 LOC, single-purpose) vs libc FFI `localtime_r` — decision deferred to 4.5.A implementation per § 3.2.1.

### 4.2 Module surface (new `ql-types::date`)

```rust
pub enum DateSystem {
    Excel1900,
    Excel1904,
}

pub fn serial_to_ymd(serial: f64, system: DateSystem) -> Result<(i32, u32, u32), ErrorValue>;
pub fn ymd_to_serial(year: i32, month: u32, day: u32, system: DateSystem) -> Result<f64, ErrorValue>;
pub fn fraction_to_hms(frac: f64) -> (u32, u32, u32);  // hours, minutes, seconds
pub fn hms_to_fraction(h: u32, m: u32, s: u32) -> f64;
pub fn weekday(serial: f64, system: DateSystem, return_type: WeekdayReturnType) -> Result<u32, ErrorValue>;
pub fn is_leap_year(year: i32) -> bool;
pub fn days_in_month(year: i32, month: u32) -> u32;
```

All pure functions; no global state.

## 5. Decision C — Date/time function library scope

### 5.1 V1 wave (Phase 4.5.B; ~18 functions; **rebalanced after Codex MEDIUM 5**)

| Function | Notes |
|---|---|
| `DATE(y, m, d)` | Year < 1900 in 1900-system → `#NUM!`. Month/day out-of-range cascade (1-month back-rolls). |
| `YEAR(serial)` | Returns 1900..9999. |
| `MONTH(serial)` | Returns 1..12. |
| `DAY(serial)` | Returns 1..31. |
| `HOUR(serial)` | Returns 0..23. |
| `MINUTE(serial)` | Returns 0..59. |
| `SECOND(serial)` | Returns 0..59 (Excel canon — no fractional seconds). NOW() input is whole-second from `Duration::as_secs()`; sub-second precision is a **non-goal** for V1 (Codex LOW 2 pin) — if Phase 4.10+ adds sub-second NOW, SECOND() truncates to match Excel's integer return. |
| `TIME(h, m, s)` | Returns fractional 0..1 (modulo 1 — `TIME(25, 0, 0) = TIME(1, 0, 0)`). |
| `DATEVALUE(text)` | Parse text → serial. Locale-invariant in V1 (en-US format). |
| `TIMEVALUE(text)` | Parse text → fraction. |
| `NOW()` | UPGRADE existing to leap-year-aware. |
| `TODAY()` | UPGRADE existing. |
| `WEEKDAY(serial, [return_type])` | Return types 1, 2, 3, 11-17 per Excel. |
| `EOMONTH(start, months)` | End-of-month after `months` offset. **EOMONTH(start, 0)** returns last day of `start`'s month (Excel canon, Codex MEDIUM 5 / D pin). |
| `EDATE(start, months)` | Same date in offset month. |
| `DAYS(end, start)` | Simple subtraction. Lifted from V2 — used widely. |
| `NETWORKDAYS(start, end, [holidays])` | Working days, Mon-Fri default. **Lifted from V2** (Codex MEDIUM 5) — project-plan spreadsheets need this. |
| `WORKDAY(start, days, [holidays])` | Offset working days. **Lifted from V2** — same reason. |
| `YEARFRAC(start, end, [basis])` | Basis 0-4 per Excel. **Lifted from V2** — finance use is widespread. |

### 5.2 V2 wave (Phase 4.5.C; ~7 functions)

| Function | Notes |
|---|---|
| `DATEDIF(start, end, unit)` | Units: "Y", "M", "D", "YM", "YD", "MD". Undocumented Excel function. |
| `NETWORKDAYS.INTL(start, end, [weekend], [holidays])` | Custom weekend mask. |
| `WORKDAY.INTL(start, days, [weekend], [holidays])` | Custom weekend mask. |
| `DAYS360(start, end, [method])` | 360-day year (US/European). |
| `WEEKNUM(serial, [return_type])` | Several conventions (return_type 1, 2, 11-17, 21). |
| `ISOWEEKNUM(serial)` | ISO 8601 week. |

V2 is deferred to a separate cycle if Phase 4.5 lands too large in one batch.

## 6. Decision D — Number format parser scope (DTF-4-03)

### 6.1 Format string grammar

Excel format strings are a domain-specific language with these terminals:
- **Digit placeholders**: `0` (always show), `#` (show if non-zero), `?` (space-pad)
- **Date tokens**: `yyyy`, `yy`, `mmmm`, `mmm`, `mm`, `m`, `dddd`, `ddd`, `dd`, `d`
- **Time tokens**: `hh`, `h`, `mm` (context-dependent — disambiguates from month), `ss`, `am/pm`
- **Decimal point**: `.`
- **Thousands separator**: `,`
- **Currency**: `$`, `€`, etc.
- **Text literals**: `"foo"`, `\X`
- **Color codes**: `[Red]`, `[Blue]`, etc.
- **Conditionals**: `[>100]`, `[<=0]`
- **Section separators**: `;` (positive; negative; zero; text)
- **Special**: `@` (text passthrough), `*` (repeat fill char), `_` (skip width)

### 6.2 V1 scope (Phase 4.5.D)

- All digit placeholders + decimal/thousands.
- Common date/time tokens (yyyy, mm, dd, hh, mm, ss, am/pm, mmm, ddd).
- Text literals, basic `;`-section split for `positive;negative;zero;text`.
- Currency symbol passthrough (no locale conversion).
- Skip-width (`_`) and repeat-fill (`*`) tokens **parsed** into `Section::Ghost(char)` / `Section::Spacer(char)` AST nodes (IronCalc precedent at `formatter/parser.rs`). Rendering: ignored in V1 (no column-width info available) — pinned as `[V1-DIV]`.
- Text-passthrough (`@`) token: in a section, replaces the rendered text body verbatim. Empty-section pattern `0;-0;;@` (suppress zeros, render text via passthrough) is supported.
- Token V1/V2 sub-table (Codex MEDIUM 6 fix):

  | Token | V1 behavior |
  |---|---|
  | `0` `#` `?` (digits) | parsed + rendered |
  | `.` (decimal point) | parsed + rendered |
  | `,` (thousands sep) | parsed + rendered (en-US `,`) |
  | `yyyy yy mmmm mmm mm m dddd ddd dd d` | parsed + rendered |
  | `hh h ss s` | parsed + rendered |
  | `am/pm AM/PM` | parsed + rendered |
  | `"foo"` `\X` (text literal) | parsed + rendered |
  | `$` `€` etc. (currency) | parsed + rendered as literal char |
  | `;` (section separator, up to 4 sections) | parsed + rendered |
  | `@` (text passthrough) | parsed + rendered |
  | `_X` (skip-width) | parsed; **ignored** at render (V1-DIV; no column-width metadata) |
  | `*X` (repeat-fill) | parsed; **ignored** at render (V1-DIV) |
  | `[Red]` etc. (colors) | DEFERRED to V2 — parse error in V1 with a "color codes deferred" diagnostic |
  | `[>100]` etc. (conditional) | DEFERRED to V2 — parse error in V1 |
  | `# ?/?` (fraction) | DEFERRED to V2 |

### 6.3 V2 deferrals

- Colors (consumers can read the parsed format token; rendering layer applies).
- Conditional formats (parse but don't apply mid-cell).
- Fraction format (`# ?/?`).
- Full locale conversion (Phase 4.9 — see § 6.4 re-scope).

### 6.4 Locale scope re-scoping (Codex HIGH 3 fix)

The MASTER-PLAN's DTF-4-03 says "format parser tests include en/de/fr examples." The original draft tried to satisfy this with "locale-aware separators in the parsing path" while also saying V1 hardcodes en-US. **Contradictory.** Re-scoped:

- **Phase 4.5 (this phase):** the PARSER carries a `LocaleHints` struct (defaulted to en-US) that determines separator character semantics. Tests with the DEFAULT en-US set land here. The parser surface accepts a hint set; rendering uses the hint set; en-US is the only hint set populated.
- **Phase 4.9 (later):** populate de/fr/etc. hint sets + xlsx locale-tag round-trip. The de/fr fixture tests land in Phase 4.9 against the now-fully-populated locale table.

**Revised DTF-4-03 acceptance:** "format parser has an extension point for locale; en-US is fully populated and tested; the surface compiles against de/fr stub hints (asserts shape; not behavior)." The en/de/fr behavior tests move to Phase 4.9 with `DTF-9-XX` IDs (new acceptance items filed in MASTER-PLAN).

### 6.4 Module surface (new `ql-functions::format` or `ql-io::format`)

```rust
pub struct FormatString {
    positive: Section,
    negative: Option<Section>,
    zero: Option<Section>,
    text: Option<Section>,
}

pub fn parse(s: &str) -> Result<FormatString, FormatParseError>;

pub fn render(value: &Value, fmt: &FormatString, system: DateSystem) -> String;
```

Locale lookup is a SEPARATE concern (Phase 4.9). V1 hardcodes en-US separators (`,` thousand, `.` decimal).

## 7. Decision E — Workbook-level format storage (DTF-4-04; rewritten after Codex MEDIUM 7+8)

The original draft said "each cell can carry `format_id: Option<FormatId>`" — but Quantbook storage is **columnar** (Arrow chunks + sparse overlays at `crates/ql-storage/src/column.rs`), not row-based with per-cell structs. There's no `Cell` type to attach `format_id` to. Concrete redesign:

### 7.1 Workbook-level dedup table

```rust
// ql-storage::format (new module)
pub struct FormatTable {
    // Excel built-in IDs 0-163 are reserved; custom IDs start at 164.
    next_custom_id: u32,
    by_id: IndexMap<FormatId, String>,
    by_string: HashMap<String, FormatId>,
}

impl FormatTable {
    pub fn intern(&mut self, s: &str) -> FormatId;
    pub fn lookup(&self, id: FormatId) -> Option<&str>;
    pub fn builtin_general() -> FormatId;  // id = 0 by convention
}
```

`Workbook::formats: FormatTable` field; default-initialized with Excel built-ins 0-163 populated lazily (table-of-strings constant; ~3KB).

### 7.2 Sparse cell-format overlay

Cells with non-General format live in a sparse-overlay structure parallel to the value overlay:

```rust
// ql-storage::format_overlay (new module)
pub struct CellFormatOverlay {
    // Same chunk-based shape as user_overlays/computed_overlays.
    // Each chunk is `HashMap<(RowId, ColId), FormatId>` keyed by intra-chunk addr.
    chunks: Vec<HashMap<(RowId, ColId), FormatId>>,
}

impl CellFormatOverlay {
    pub fn get(&self, row: RowId, col: ColId) -> Option<FormatId>;  // None ≡ General
    pub fn set(&mut self, row: RowId, col: ColId, id: FormatId);
    pub fn clear(&mut self, row: RowId, col: ColId);
}
```

**Why sparse**: most cells have General format. Storing `Option<FormatId>` per cell would cost 8 bytes × N cells, mostly None. The sparse overlay costs only proportional to the number of cells that ACTUALLY have a custom format.

### 7.3 Op-log shape (Codex MEDIUM 8 fix)

Op log gains 2 new variants:
- `Op::RegisterFormat { id: FormatId, string: String }` — written when `FormatTable::intern` allocates a NEW id. Idempotent on replay (intern returns the same id given the same string).
- `Op::SetCellFormat { sheet: SheetId, row: RowId, col: ColId, id: FormatId }` — written when `CellFormatOverlay::set` is called.

Replay determinism: format IDs are deterministic via the `intern` interface (allocates next_custom_id sequentially); the op log captures both the assignment and the cell-format binding. CRDT replay (Phase 5) sees both ops and reconstructs the same state.

### 7.4 `.qbook` schema bump (Codex § I fix)

`workbook.toml` envelope gains `date_system: "1900"|"1904"` (default `"1900"`) and a new `formats.bin` chunk (or inline TOML section if small). Legacy `.qbook` files without these fields default to `Excel1900` + empty FormatTable + all-General overlay (matches current behavior). Schema version bump from v2 to v3; the existing v2 → v3 migrator handles the defaults.

### 7.5 Compaction (deferred to Phase 4.10)

When cells change format, the old FormatId entry isn't garbage-collected. A workbook that cycles through many formats could grow the table. **Decision:** deferred compaction pass (Phase 4.10 or runtime trigger) — typical workbooks don't cycle formats. File as a known gap.

**Rationale (preserved from original):**
- Excel canon: cells reference style records by index; format string is one component of a style.
- Dedup keeps storage small (most cells share the same format string).
- xlsx round-trip becomes mechanical (format strings preserved on import; output references the workbook table on export).

**Default format**: `"General"` — matches Excel exactly: render the raw numeric value (or text body, or `TRUE`/`FALSE`, or sigil). **NO auto-date-detection** — a date format is shown ONLY when the cell has an explicit date format applied. **Codex HIGH 2 fix**: the prior draft proposed auto-detecting "looks like a date" by serial range. That would render literal `45810` as `"6/30/2025"`, breaking the value/display separation that DTF-4-04 demands.

## 8. Migration plan (5 sub-phases)

### 8.1 Sub-phase 4.5.A — Epoch + serial conversion module

**Scope:** New `ql-types::date` module + `DateSystem` enum + 8 public functions per § 4.2. Workbook gains `date_system: DateSystem` field. Schema migration. NOW/TODAY upgraded to use the new conversion (1900-leap-year-aware). ~3 days. **Acceptance**: 50+ unit tests covering edge cases (serial 0, 60, leap years, max year).

### 8.2 Sub-phase 4.5.B — Date/time function library wave 1 (15 fns)

**Scope:** Register DATE/YEAR/MONTH/DAY/HOUR/MINUTE/SECOND/TIME/DATEVALUE/TIMEVALUE/NOW/TODAY/WEEKDAY/EOMONTH/EDATE. ~5 days. **Acceptance**: per-function tests + matrix entries in `excel-matrix.md` + entries in `coverage.rs`.

### 8.3 Sub-phase 4.5.C — Date/time function library wave 2 (10 fns)

**Scope:** DATEDIF/NETWORKDAYS/NETWORKDAYS.INTL/WORKDAY/WORKDAY.INTL/DAYS/DAYS360/YEARFRAC/WEEKNUM/ISOWEEKNUM. ~5 days. **Acceptance**: same shape as 4.5.B.

### 8.4 Sub-phase 4.5.D — Number format parser + rendering

**Scope:** New `ql-functions::format` module. Parser + renderer. Cell `format_id` storage. `to_text_for_display` integrated. ~5 days. **Acceptance**: en/de/fr fixture tests (DTF-4-03); 100+ format-render tests; xlsx-format-string round-trip readiness.

### 8.5 Sub-phase 4.5.E — TEXT() function + locale stubs

**Scope:** `TEXT(value, format_string)` formula function. Locale module stubs (en-US only in V1; Phase 4.9 fills DE/FR). ~2 days.

### 8.6 Phase 4.5 mega-audit

**Scope:** Codex + Sonnet parallel per the W5-52 pattern. ~1 day.

**Re-estimated total (Codex MEDIUM 3 + H verdict):** ~6-8 sessions implementation + 1 mega-audit cycle. Phase 4.4 estimated 2.5 sessions and actually took 5 (W5-63 → W5-67); Phase 4.5 has materially more surface area — IronCalc's date_and_time.rs alone is 1703 LOC, and `formatter/` totals ~3950 LOC. Sub-phase budget refined:

- **4.5.A.0** EvalContext + ContextAwareFn tier (NEW per Codex HIGH 1): ~1 session.
- **4.5.A** Epoch + serial conversion module + Workbook field + schema migration: ~1-2 sessions.
- **4.5.B** Wave 1 (now 18 fns — see § 5.1 rebalance): ~2 sessions.
- **4.5.C** Wave 2 (now 7 fns — see § 5.2 rebalance): ~1 session.
- **4.5.D** Format parser + storage overlay + op-log ops: **2-3 sessions** (Codex MEDIUM 7+8 — bigger than 5 days; the storage piece alone is non-trivial).
- **4.5.E** TEXT() + locale stubs: ~0.5 session.
- **Phase 4.5 mega-audit** (Codex + Sonnet parallel): ~1 session.

Sub-phases ship independently — each is a committable closure point. The order matters: 4.5.A.0 → 4.5.A → 4.5.B → 4.5.D (parser+storage can land before C if user-visible dates are urgent) → 4.5.C → 4.5.E → mega-audit. Or interleave 4.5.D ahead of 4.5.B if format storage is on the critical path.

## 9. Non-goals (deferred to later phases)

- **Locale fp-separator parsing** (`1,5` German) — Phase 4.9.
- **Time-zone awareness** — out of scope; Excel doesn't model time zones.
- **Sub-second precision** — Excel rounds to integer seconds; SECOND() returns 0..59.
- **Calendar systems other than Gregorian** — out of scope.
- **Fraction format** (`# ?/?`) — Phase 4.10.
- **Custom date-system per-cell** — workbook-level only.
- **CRLF / Windows-vs-Unix line endings in text formats** — Phase 4.10.

## 10. Risks + stop conditions

| Risk | Mitigation |
|---|---|
| Roll-our-own date math has subtle leap-year bugs | 50+ unit tests against IronCalc reference outputs (`.references/ironcalc/base/src/formatter/dates.rs`); cross-check with `chrono`'s `NaiveDate` for non-leap-year cases; serial-60 table (§ 3.2) pins the bug edges per-function |
| Format parser is bigger than estimated (Excel format strings get gnarly) | V1 scope explicitly excludes colors / conditionals / fractions; if parser blows past 1500 LOC, split into 4.5.D.1 (numeric) + 4.5.D.2 (date) |
| 1900 leap-year bug introduces surprise divergence | All date arithmetic routes through `ymd_to_serial` / `serial_to_ymd` which CENTRALLY handle the bug; Codex MEDIUM 2: add guardrails (deny-list test for direct `25569` / `60` epoch constants outside the date module; `DateSerial` newtype if discipline is violated) |
| xlsx round-trip exposes date-system mismatch | Phase 4.11 imports the source workbook's `date1904` SST flag; round-trip preserves it |
| `Value::Number` invariants break under date-time mixed arithmetic | NaN/Inf policy from W5-64 already covers; date subtraction produces normal `f64` differences |
| **DATEVALUE locale ambiguity** (Codex § I) — xlsx import may surface non-en-US date strings | V1 parser accepts ISO-8601-like + en-US; locale-specific parsing lands Phase 4.9 with the rest of locale work; xlsx importer maps the workbook's localeId to the appropriate parser hint |
| **Legacy `.qbook` schema migration** (Codex § I) — existing files have no `date_system` field | v2 → v3 migrator defaults `date_system: Excel1900` + empty FormatTable; existing NOW/TODAY values in op logs were computed with the old 25569-flat offset, which is byte-identical to the new EXACT 25569 offset for dates `>= 1900-03-01` (which is every NOW/TODAY value ever produced today) — replay determinism preserved |
| **Op-log replay determinism** (Codex MEDIUM 8) — new date-system defaults + format ops + local-time-aware NOW could shift replay | `Op::RegisterFormat` + `Op::SetCellFormat` capture the format state explicitly; `Op::SetWorkbookDateSystem` similarly; for NOW determinism, the existing `set_test_now_secs` test hook works (no new replay surface) |
| **xlsx extreme-date import** (Codex § I) — xlsx cells with serial < 0 or > 2_958_465 | Importer surface returns `#NUM!` per § 3.3 contract; xlsx importer (Phase 4.11) clamps to representable range with a load-warning |
| **IronCalc reference can't represent serial 60** (Codex MEDIUM 1) | Quantbook tests pin serial-60 behavior independently of IronCalc; reference is consulted for the non-buggy serials only |

**Stop conditions** — fold this phase if:
1. Codex review flags a structural error in epoch/serial design (e.g., the 1900-bug centralization breaks an Excel-canon edge).
2. The roll-our-own date module exceeds 1000 LOC with diminishing test coverage — switch to `time` crate.
3. Format parser sub-phase 4.5.D exceeds 2000 LOC — split into 4.5.D.1/D.2 as above.

## 11. Acceptance criteria (re-stated)

- [ ] DTF-4-01: 1900/1904 policy explicit + workbook field + schema migration.
- [ ] DTF-4-02: 25 date/time functions registered + matrix entries + per-function override tests.
- [ ] DTF-4-03: format parser handles en/de/fr fixture set (locale-aware separators in parsing path, even though rendering is V1 en-US).
- [ ] DTF-4-04: cell `format_id: Option<FormatId>` field + workbook-level dedup; storage round-trip test.
- [ ] All 7 gates green at every shippable commit.
- [ ] Phase 4.5 mega-audit closure (Codex + Sonnet parallel) before declaring closed.

## 12. Future contexts the design should accommodate

- **Phase 4.6 cross-sheet refs**: a `Sheet2!A1` reference holding a date serial flows through the same coercion + display paths. No special handling.
- **Phase 4.7 array formulas**: `=DATE(YEAR(A1:A10), 1, 1)` should array-apply once we have spill semantics. Make sure `serial_to_ymd` is `Fn` (already pure).
- **Phase 4.9 R1C1 + localization**: format-string LOCALE lookup splits from RENDERING. Phase 4.5 hardcodes en-US; 4.9 swaps the lookup table in.
- **Phase 4.11 xlsx I/O**: `date1904` SST flag → `DateSystem`; per-cell `s="<style_id>"` → `format_id`. Mechanical.
- **Phase 5 CRDT replay**: serial is deterministic `f64`; format strings are deterministic; replay is byte-identical.
- **Phase 6.3 Node/WASM bindings**: NOW/TODAY's `SystemTime::now()` call MUST be gated behind `target_arch != "wasm32"` OR delegated to a host-provided callback. The arithmetic module is pure (no_std-friendly).

## 13. Companion specs (deferred until implementation cycles)

Per Codex LOW 5 / K verdict: the format-string grammar deserves its own mini-spec before the parser is implemented. Plan: when Sub-phase 4.5.D opens, FIRST land `docs/architecture/2026-05-XX-format-string-grammar.md` (EBNF + token table + section-semantics) as a sub-design doc. Same pattern as W5-49 → graph-storage-decision (mini-design followed by implementation cycle).

Similarly, the date-function edge-case matrix (serial-60 table from § 3.2, plus per-function edge cases for the 18 V1 + 7 V2 functions) should land as `docs/architecture/2026-05-XX-date-function-edge-cases.md` before 4.5.B opens.

## 14. Codex review summary

**COMPLETED 2026-05-13 W5-68.** Codex returned 4 HIGH + 8 MEDIUM + 5 LOW + 10 numbered recommendations. ALL incorporated into this doc above.

Header bullets at the top of this doc enumerate the synthesized changes. Codex review preserved at `docs/audits/2026-05-13-w5-68-codex-dates-review.txt`. Recommendations status:

| # | Recommendation | Status |
|---|---|---|
| 1 | Evaluator-context decision | § 4.A added |
| 2 | Replace `General` auto-date with raw rendering | § 7 corrected |
| 3 | Serial-60 contract matrix | § 3.2 sub-table |
| 4 | Rewrite DTF-4-03 locale scope | § 6.4 re-scope |
| 5 | Local-clock + WASM hook for NOW/TODAY | § 3.2.1 |
| 6 | Concrete format storage design | § 7.1-7.5 |
| 7 | V1/V2 behavior for `_`, `*`, `@`, empty sections | § 6.2 token table |
| 8 | Split format parser into companion spec | § 13 commitment |
| 9 | Re-estimate effort | § 8 budget refined |
| 10 | Update risks for DATEVALUE locale / xlsx extreme / .qbook migration / IronCalc oracle | § 10 expanded |

**Outstanding Codex 13** — original section retained for archival reference; superseded by § 14:

- Is the roll-our-own date module the right call vs `time` / `jiff`? Reasonable per-fn LOC estimate (15 fns × ~50 LOC = 750 LOC)?
- Is the `DateSystem` workbook-level setting the right abstraction, or should each cell carry it?
- Is the `format_id: Option<FormatId>` storage design sound? Any concern with the dedup table being workbook-level?
- Should `Value::Number(45810)` rendering as "6/30/2025" be a Display-impl change, or is per-cell-format-aware rendering the right path?
- Function library scope — are 25 functions the right cut for Phase 4.5, or should ISOWEEKNUM / WORKDAY.INTL split to 4.10?
- 1900 leap-year bug centralization in `ymd_to_serial`/`serial_to_ymd` — is the contract clear enough that future fns can't accidentally bypass it?

Codex output preserved at `docs/audits/2026-05-13-w5-68-codex-dates-review.txt`. Findings synthesized into this doc before W5-68 closure.

---

**Provenance:** Authored 2026-05-13 W5-68 session as the immediately-next architectural beat after Phase 4.4 closure (W5-67). Builds on the W5-67 handoff doc § Recommended next phase. Survey of existing code at `crates/ql-functions/src/volatile.rs:108-132`; reference materials at `.references/ironcalc/base/src/formatter/` and `.references/ironcalc/base/src/functions/date_and_time.rs` (1703 LOC, 18 fns).

# Excel format-string grammar mini-spec (Phase 4.5.D)

**Status:** Companion design — written before parser implementation per design doc § 13 (Codex LOW 5 / K verdict).
**Parent design:** `docs/architecture/2026-05-13-dates-times-formats.md` § 6.1-6.4.
**Lifespan:** Frozen at W5-77 doc-only commit; updated only on V2 expansion.
**Author:** 2026-05-13 W5-77 session.

## 1. Why this mini-spec exists

The parent design § 6.1 lists format-string terminals informally. The parser needs an unambiguous grammar before its first commit so:
- Token disambiguation rules (when does `mm` mean "month" vs "minute"?) have a single source of truth.
- The V1/V2 boundary is enforced by the parser, not the renderer.
- Error categories are defined upfront so error tests pin them.
- IronCalc-divergence is documented, not lost in implementation comments.

The grammar describes the SURFACE consumed by `parse(s: &str) -> Result<FormatString, FormatParseError>`. Rendering (`render(value, fmt, system) -> String`) is a separate concern (Phase 4.5.D part 2, ≥W5-78).

## 2. Lexical grammar (EBNF)

```ebnf
format_string  = section { ";" section } ;
section        = { token } ;

(* Tokens *)
token          = digit_placeholder
               | decimal_point
               | thousands_or_scale
               | percent
               | scientific
               | date_part
               | time_part
               | ampm
               | quoted_text
               | escaped_char
               | currency
               | literal
               | text_passthrough
               | spacer
               | ghost
               | color           (* V2 — parse-error in V1 *)
               | condition       (* V2 — parse-error in V1 *)
               | general
               ;

digit_placeholder = "0" | "#" | "?" ;
decimal_point     = "." ;
thousands_or_scale = "," ;  (* meaning depends on position: thousands sep
                             when between digits, scale-down when trailing *)
percent           = "%" ;
scientific        = "E+" | "E-" | "e+" | "e-" ;

(* Date tokens; case-insensitive *)
date_part      = "d" | "dd" | "ddd" | "dddd"
               | "m" | "mm" | "mmm" | "mmmm" | "mmmmm"
               | "yy" | "yyyy" ;
(* Note: bare "yyy" / "yyyyy+" are NOT accepted in V1; IronCalc maps
   yyy+ to YearShort which is divergent. V1 rejects with InvalidYear. *)

time_part      = "h" | "hh" | "s" | "ss" ;
(* Note: "m" / "mm" are date_part OR time_part depending on context;
   resolved at parse time — see § 4. *)

ampm           = "AM/PM" | "am/pm" | "A/P" | "a/p" ;

quoted_text    = '"' { any_char_except_quote } '"' ;
escaped_char   = "\" any_char ;
currency       = "[$" sym [ "-" locale_code ] "]"   (* e.g. [$€-409] *)
               | direct_currency_char ;             (* e.g. $, € *)
direct_currency_char = "$" | "€" | "£" | "¥" ;

literal        = "(" | ")" | "+" | "-" | "{" | "}"
               | "<" | "=" | "!" | "~" | ">" | "^" | "'"
               | "/" | ":" | " " ;
text_passthrough = "@" ;
spacer         = "*" any_char ;
ghost          = "_" any_char ;

color          = "[" color_name "]" ;            (* V2 *)
color_name     = "Red" | "Blue" | "Green" | "Yellow" | "Magenta"
               | "Cyan" | "White" | "Black" | "Color " integer ;
condition      = "[" comparator number "]" ;     (* V2 *)
comparator     = "<" | ">" | "<=" | ">=" | "=" | "<>" ;

general        = "General" ;                     (* case-insensitive *)
```

## 3. Section semantics

A `FormatString` has 1-4 sections separated by `;`:

| Count | Semantic |
|---|---|
| 1 | All values use section[0]. |
| 2 | section[0] for `value >= 0`, section[1] for `value < 0` (sign printed by section if it contains `-`, else absorbed). |
| 3 | section[0] for `value > 0`, section[1] for `value < 0`, section[2] for `value == 0`. |
| 4 | section[0] for `value > 0`, section[1] for `value < 0`, section[2] for `value == 0`, section[3] for `Value::Text`. |

**Empty section:** `";"` between separators (e.g. `"0;-0;;@"`) — the value matching this section RENDERS AS EMPTY. Pinned by V1 acceptance test `empty_section_renders_empty`.

**Trailing `;` rule:** `"0;"` is two sections: section[0] = `"0"`, section[1] = empty. Equivalent to "positive uses `"0"`; negative renders empty". V1 parses this; the renderer respects empties.

**More than 4 sections:** `FormatParseError::TooManySections(count)`. (V1; Excel itself caps at 4.)

## 4. Token disambiguation rules

### 4.1 `m` / `mm` — month vs minute

Resolved at PARSE time, not lex time. Algorithm (matches IronCalc `parser.rs::resolve_month_or_minute`):

1. Tokenize the section in order.
2. Walk left-to-right. Each `m`/`mm` token's role is:
   - **Minute** if the most recent date/time token before it (within this section) was `h`/`hh`/`s`/`ss`.
   - **Minute** if the next date/time token after it (within this section) is `s`/`ss`.
   - **Month** otherwise.
3. The renderer respects this annotation.

### 4.2 Section kind classification

Each section's "kind" is one of `Number | Date | Text | Empty | General`. Determined post-tokenization:

- Contains any of `@`: kind = **Text**.
- Contains any of `0`/`#`/`?`: kind = **Number** UNLESS it ALSO contains a date_part or time_part token, in which case kind = **Date** (numeric digits inside a date format are placeholders for fractional seconds, etc., still rendered as Date).
- Contains any date_part / time_part: kind = **Date**.
- Contains only literals, quoted text, currency, spacer, ghost: kind = **Text** (renders the literal string regardless of value type — useful for "this cell shows a fixed label").
- Empty token list: kind = **Empty**.
- Single `General` token: kind = **General** (renders raw per `Value::Number(n).to_string()` ish).

### 4.3 Case-insensitivity

All keyword tokens (`AM/PM`, `General`, `d`/`m`/`y`/`h`/`s`, color names) are case-insensitive. `"YYYY-MM-DD"` and `"yyyy-mm-dd"` parse identically. Quoted text and `\X` escapes preserve case.

## 5. Numeric scale tokens

`%` (percent): multiply the value by `100^percent_count` before rendering. Position-independent — `"#%"` and `"%#"` both scale once. V1 supports up to 9 `%` tokens (cosmetic ceiling; matches IronCalc).

`,` (trailing comma scale): when `,` appears AFTER all digit tokens and BEFORE the decimal point (or end), it divides the value by 1000 per `,`. `"#,"` displays as thousands (1500 → "2"); `"#,,"` displays as millions. Distinguish from the thousands separator (`#,##0`) by position: thousands separator is BETWEEN digit tokens.

Both scale and thousands semantics fall out of the `comma_count` counter accumulated during parsing.

## 6. Token table (V1 / V2 split, per § 6.2 of parent design)

| Token | Lexer emits | Parser accepts in V1 | Renders in V1 |
|---|---|---|---|
| `0` `#` `?` | `Digit { kind }` | ✅ | ✅ |
| `.` | `Period` | ✅ | ✅ |
| `,` | `Comma` | ✅ | ✅ (thousands OR scale by position) |
| `%` | `Percent` | ✅ | ✅ |
| `E+` `E-` | `Scientific` `ScientificMinus` | ✅ | ✅ |
| `yyyy` `yy` | `Year` `YearShort` | ✅ | ✅ |
| `mmmm` `mmm` `mm` `m` `mmmmm` | `MonthName` `MonthNameShort` `MonthPadded` `Month` `MonthLetter` | ✅ | ✅ |
| `dddd` `ddd` `dd` `d` | `DayName` `DayNameShort` `DayPadded` `Day` | ✅ | ✅ |
| `hh` `h` `ss` `s` | `HourPadded` `Hour` `SecondPadded` `Second` | ✅ | ✅ |
| `AM/PM` | `AMPM` | ✅ | ✅ |
| `"foo"` | `Text(String)` | ✅ | ✅ |
| `\X` | `Literal(char)` | ✅ | ✅ |
| `$` `€` `£` `¥` | `Currency(char)` | ✅ | ✅ as literal |
| `[$€-409]` | `Currency(char)` (locale code ignored in V1) | ✅ | ✅ (currency char only; locale code parsed-but-discarded) |
| `;` | `Separator` | ✅ (up to 4 sections) | ✅ |
| `@` | `Raw` | ✅ | ✅ |
| `_X` | `Ghost(char)` | ✅ | parsed; ignored at render (V1-DIV; needs column-width info) |
| `*X` | `Spacer(char)` | ✅ | parsed; ignored at render (V1-DIV) |
| `[Red]` etc. | `Color(i32)` | ❌ → `FormatParseError::UnsupportedV2(ColorCodes)` | n/a |
| `[>100]` etc. | `Condition(Compare, f64)` | ❌ → `FormatParseError::UnsupportedV2(Conditional)` | n/a |
| `# ?/?` | (separate fraction sub-grammar) | ❌ → `FormatParseError::UnsupportedV2(Fraction)` | n/a |
| `[h]` `[mm]` `[ss]` (elapsed) | `ElapsedHour` etc. | ❌ → `FormatParseError::UnsupportedV2(ElapsedTime)` | n/a |
| `General` | `General` | ✅ | ✅ (raw value rendering) |
| `( ) + - / : space` etc. | `Literal(char)` | ✅ | ✅ |

## 7. Error categories

```rust
pub enum FormatParseError {
    /// Empty input string.
    Empty,
    /// `>4` `;`-separated sections.
    TooManySections(usize),
    /// Unterminated `"..."` literal.
    UnterminatedQuotedText { position: usize },
    /// `\` at end of string (no escape target).
    TrailingBackslash { position: usize },
    /// `_` or `*` at end of string (no width/fill target).
    TrailingSpacerOrGhost { position: usize },
    /// `[...]` block we can't classify (not color / condition / currency).
    UnknownBracketBlock { position: usize, content: String },
    /// V2 token used in V1.
    UnsupportedV2(V2Token),
    /// Any other syntactic surprise we can't make sense of.
    /// V1 fallback; refine into specific variants as test fixtures find them.
    Other { position: usize, message: String },
}

pub enum V2Token {
    ColorCodes,
    Conditional,
    Fraction,
    ElapsedTime,
    /// Reserved for future V2 additions; intentionally non_exhaustive.
}
```

Every variant carries enough position info to surface a single-line diagnostic to the future IDE (Phase 4.5.D part 2 / xlsx import).

## 8. AST shape

```rust
pub struct FormatString {
    /// 1-4 sections. Index 0 is always present.
    pub sections: Vec<Section>,
}

pub struct Section {
    pub kind: SectionKind,
    pub tokens: Vec<SectionToken>,
}

pub enum SectionKind {
    Number,
    Date,
    Text,
    Empty,
    General,
}

pub enum SectionToken {
    // Digit placeholders
    Digit { kind: DigitKind, number: NumberState },

    // Numeric punctuation / scale
    DecimalPoint,
    ThousandsSeparator,
    ScaleByThousands(u32),
    Percent(u32),
    ExponentMarker { signed: bool },

    // Date / time pieces — `m`/`mm` carries its disambiguated role
    Day { padded: bool },
    DayName { full: bool },           // dddd vs ddd
    Month { padded: bool, role: MonthRole },
    MonthName { length: MonthNameLen },
    Year { short: bool },             // yy vs yyyy
    Hour { padded: bool },
    Minute { padded: bool },          // disambiguated from Month at parse
    Second { padded: bool },
    AmPm,

    // Text / literal
    QuotedText(String),
    Literal(char),
    Currency { ch: char, locale_code: Option<u32> },  // locale_code: parsed, V1 ignores
    TextPassthrough,                  // `@`
    Spacer(char),                     // `*X` — parsed, V1 ignores at render
    Ghost(char),                      // `_X` — parsed, V1 ignores at render
    General,
}

pub enum DigitKind { Zero, Sharp, Question }
pub enum NumberState { Integer, Decimal, Exponent }
pub enum MonthRole { Month, Minute }  // resolved post-tokenize
pub enum MonthNameLen { Short, Full, SingleLetter }
```

## 9. Out-of-scope (NOT in V1)

- `[Red]` / `[Color 5]` color codes — parser SHALL emit `UnsupportedV2(ColorCodes)`, NOT silently ignore.
- `[>100]` / `[<=0]` conditionals — `UnsupportedV2(Conditional)`.
- `[h]:mm:ss` elapsed time — `UnsupportedV2(ElapsedTime)`. (User-visible: pin a known gap to surface a workaround.)
- `# ?/?` fraction format — `UnsupportedV2(Fraction)`.
- Locale-conversion of separators (en-US `,` / `.` only); the parser accepts `LocaleHints` defaulted to en-US but Phase 4.9 populates de/fr.
- Custom built-in format ids 5-8 (currency variants), 41-44 (accounting) — these ship as part of the BUILT-IN format-id table (next sub-section), but the parser doesn't special-case them; they're just opaque strings the FormatTable interns at boot.

## 10. Excel built-in format ids 0-163

Section 7.1 of the parent design says `FormatTable` reserves IDs 0-163 for Excel built-ins. The full list lives in IronCalc's `formatter/format.rs:get_built_in_format_codes` (~165 lines). V1 ships the table verbatim. Parsing-relevant subset:

| id | format string | V1 parses? |
|---|---|---|
| 0 | `"General"` | ✅ — single General token |
| 1 | `"0"` | ✅ |
| 2 | `"0.00"` | ✅ |
| 3 | `"#,##0"` | ✅ |
| 4 | `"#,##0.00"` | ✅ |
| 9 | `"0%"` | ✅ |
| 10 | `"0.00%"` | ✅ |
| 11 | `"0.00E+00"` | ✅ |
| 12 | `"# ?/?"` | ❌ V2 fraction |
| 14 | `"m/d/yyyy"` | ✅ |
| 15 | `"d-mmm-yy"` | ✅ |
| 16 | `"d-mmm"` | ✅ |
| 17 | `"mmm-yy"` | ✅ |
| 18 | `"h:mm AM/PM"` | ✅ |
| 19 | `"h:mm:ss AM/PM"` | ✅ |
| 20 | `"h:mm"` | ✅ |
| 21 | `"h:mm:ss"` | ✅ |
| 22 | `"m/d/yyyy h:mm"` | ✅ |
| 37 | `"#,##0 ;(#,##0)"` | ✅ |
| 38 | `"#,##0 ;[Red](#,##0)"` | ❌ V2 color |
| 45 | `"mm:ss"` | ✅ |
| 46 | `"[h]:mm:ss"` | ❌ V2 elapsed |
| 49 | `"@"` | ✅ |

V1 acceptance: the parser MUST round-trip parse → re-string the 16+ built-in formats marked ✅ above. The ones marked ❌ must surface the specific `UnsupportedV2` variant.

## 11. IronCalc-divergence catalog (intentional)

| Area | IronCalc | Quantbook V1 | Reason |
|---|---|---|---|
| `yyy` (three y's) | mapped to YearShort | rejected as `Other { message }` | IronCalc behavior is arbitrary; explicit error is better than silent acceptance of malformed input |
| Colors | parsed + applied at render | parsed as `UnsupportedV2`; render not reached | scope discipline; Phase 4.5 V1 is value/structure, not visual |
| Conditional sections | parsed + applied at render | rejected | same |
| Locale-aware `,` and `.` | Lexer takes locale hints | en-US only in V1; LocaleHints surface preserved | DTF-4-03 re-scope (Codex HIGH 3) |
| Elapsed time `[h]` | parsed + rendered | rejected | tier-deferred; useful but adds renderer complexity |
| Fraction `# ?/?` | parsed + rendered | rejected | low frequency in real workbooks; defer |
| `*X` repeat fill | renders by padding to column width | parsed; ignored at render (no column-width metadata in engine) | column-width is IDE-layer concern (Phase 7) |
| `_X` skip width | renders by inserting placeholder of X's width | parsed; ignored at render | same |
| Empty `mmm` after year | IronCalc rewrites to month-name | Quantbook respects the user's choice | predictability over auto-correction |

## 12. Test corpus (Phase 4.5.D part 1 — parser-only)

Three concentric test rings:

### 12.1 Lexer-level token recognition (~25 tests)

Each V1 token from § 6 gets one input fixture + expected token sequence assertion. Lift representative cases from IronCalc `test_en_examples.rs` for the digit/percent/scientific cases.

### 12.2 Parser-level section assembly (~30 tests)

- Single-section: `"0"`, `"#,##0.00"`, `"yyyy-mm-dd"`, `"@"`.
- Two-section: `"0;-0"`, `"0;(0)"`.
- Three-section: `"0;-0;\"zero\""`.
- Four-section: `"0;-0;;@"`.
- Empty sections: `"0;"`, `"0;;\"text\""`, `";;;@"`.
- Built-in formats (table § 10): assert AST shape for each ✅ entry.
- `m`/`mm` disambiguation: `"h:mm:ss"` → minute; `"mmm m"` → month, month; `"h:mm m"` → minute, month.

### 12.3 Error-path tests (~10)

- `""` → `Empty`.
- `"0;0;0;0;0"` (5 sections) → `TooManySections(5)`.
- `"\"unterminated"` → `UnterminatedQuotedText`.
- `"0\\"` → `TrailingBackslash`.
- `"0_"` → `TrailingSpacerOrGhost`.
- `"[Red]0"` → `UnsupportedV2(ColorCodes)`.
- `"[>100]0"` → `UnsupportedV2(Conditional)`.
- `"[h]:mm"` → `UnsupportedV2(ElapsedTime)`.
- `"# ?/?"` → `UnsupportedV2(Fraction)`.
- `"yyy"` → `Other { message: "invalid year token length 3" }`.

## 13. Implementation sequencing (informative)

1. Lexer (`format::lexer`) — flat token stream, 38 V1 token variants. Mirrors IronCalc shape, deviates per § 11.
2. Section splitter — `Vec<Vec<Token>>` from one pass over the lexer.
3. Per-section parser — assigns `SectionKind`, resolves `m`/`mm`, builds `Vec<SectionToken>`.
4. Public entry `parse(s: &str) -> Result<FormatString, FormatParseError>` glues 1-3.

Renderer + storage + op-log = next session (Phase 4.5.D part 2, ≥W5-78).

## 14. Open questions (resolve before W5-77b code)

- **Module location**: `crates/ql-functions/src/format/` vs new crate `crates/ql-format/`? **Decision:** start in `ql-functions::format` since the format AST is paired with the V1 TEXT() function in Phase 4.5.E. If it grows past ~3000 LOC we split.
- **`Locale::EnUs` lives on `Locale` in `EvalContext`** (W5-69). Parser's `LocaleHints` is an OPAQUE pass-through for V1 — it carries the locale enum and reads en-US separators from a constant table. Phase 4.9 fills in de/fr.
- **Currency `[$€-409]`**: V1 PARSES the locale code (4-hex-digit Windows LCID) but DISCARDS at render. Future: surface via the `Currency.locale_code` field.

## 15. Provenance

- Authored 2026-05-13 W5-77 session as the doc-only commit preceding parser implementation.
- Builds on parent design `2026-05-13-dates-times-formats.md` § 6.1-6.4 and § 13 commitment.
- IronCalc references: `formatter/lexer.rs` (552 LOC), `formatter/parser.rs` (420 LOC). Used as oracle for tokenization shape; divergences cataloged in § 11.
- Parent design Codex review (W5-68) flagged HIGH 3 (DTF-4-03 re-scope) and MEDIUM 6 (V1/V2 token table) which this doc operationalizes.

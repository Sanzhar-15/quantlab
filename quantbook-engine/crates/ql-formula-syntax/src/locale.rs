//! **W5-133 (Phase 4.9.A).** Formula-syntax data for each `Locale`:
//! the arg / decimal / array-row / array-col separator quartet that the
//! lexer + printer parameterize over.
//!
//! Per the Phase 4.9 design doc § 3.2 + § 4.1, locale identifiers live
//! in `ql-types` and the syntax-specific data lives here. The layering
//! choice: `ql-storage::Workbook` holds a `Locale`; the lexer + printer
//! (this crate) attach separator semantics via `locale_data(...)`.
//!
//! **No `intersection_operator` field.** The `@` glyph is invariant
//! across locales — it's also the structured-ref escape sentinel per
//! Phase 4.8 / OOXML, so locale-configuring it would break that
//! contract. See Phase 4.9 design doc § 3.2 (Codex closure + Sonnet H-5).
//!
//! **Hardcoded for en/de/fr in v1.** Per design § 2 non-goal, CLDR/ICU
//! integration is deferred to a future locale wave. Adding more
//! locales is a matter of growing `LOCALE_DATA_*` tables + the
//! `Locale` enum.

use ql_types::Locale;

/// Per-locale separator quartet used by the Phase 4.9 lexer + printer.
///
/// All fields are `char` because Excel separators are single-codepoint
/// glyphs in every locale we ship. If a future locale needs a multi-
/// codepoint separator (none known), this becomes `&'static str`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LocaleData {
    /// Function-argument separator. `SUM(a, b)` in en-US uses `,`;
    /// `SUM(a; b)` in de uses `;`.
    pub arg_separator: char,
    /// Decimal-point glyph inside a number literal. en-US `2.34`,
    /// de `2,34`.
    pub decimal_separator: char,
    /// Row separator inside an array literal `{1,2;3,4}` — Phase 4.7
    /// shipped EN `;` for rows; locale-aware in 4.9.
    pub array_row_separator: char,
    /// Column separator inside an array literal — Phase 4.7 EN `,`.
    pub array_col_separator: char,
}

const EN_US: LocaleData = LocaleData {
    arg_separator: ',',
    decimal_separator: '.',
    array_row_separator: ';',
    array_col_separator: ',',
};

// **Phase 4.9 design doc § 3.2 v1 separator table — tentative for de/fr.**
// IronCalc CLDR-derived data uses backslash for array column in
// decimal-comma locales; pinned definitively during 4.9.E lexer
// implementation. v1 table here is the design contract.
const DE: LocaleData = LocaleData {
    arg_separator: ';',
    decimal_separator: ',',
    array_row_separator: '.',
    array_col_separator: '\\',
};

const FR: LocaleData = LocaleData {
    arg_separator: ';',
    decimal_separator: ',',
    array_row_separator: '.',
    array_col_separator: '\\',
};

/// Look up the formula-syntax separator quartet for a `Locale`.
///
/// Returns `&'static LocaleData` — the tables live in static memory.
/// Cheap to call from hot paths (lexer + printer).
pub fn locale_data(locale: Locale) -> &'static LocaleData {
    match locale {
        Locale::EnUs => &EN_US,
        Locale::De => &DE,
        Locale::Fr => &FR,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn en_us_separators_match_phase_4_7_canon() {
        // Phase 4.7 array literal canon: `{1,2;3,4}` — `,` between
        // cols, `;` between rows. en-US is the engine default.
        let data = locale_data(Locale::EnUs);
        assert_eq!(data.arg_separator, ',');
        assert_eq!(data.decimal_separator, '.');
        assert_eq!(data.array_col_separator, ',');
        assert_eq!(data.array_row_separator, ';');
    }

    #[test]
    fn de_separators_match_design_doc_section_3_2() {
        let data = locale_data(Locale::De);
        assert_eq!(data.arg_separator, ';');
        assert_eq!(data.decimal_separator, ',');
        // de's `,` decimal forces `\\` array col (no glyph collision).
        assert_eq!(data.array_col_separator, '\\');
        assert_eq!(data.array_row_separator, '.');
    }

    #[test]
    fn fr_separators_match_design_doc_section_3_2() {
        let data = locale_data(Locale::Fr);
        assert_eq!(data.arg_separator, ';');
        assert_eq!(data.decimal_separator, ',');
        assert_eq!(data.array_col_separator, '\\');
        assert_eq!(data.array_row_separator, '.');
    }

    /// **Sanity:** separators must not collide WITHIN a single
    /// parsing context. They CAN share glyphs across contexts —
    /// EN's `arg_separator` and `array_col_separator` are both `,`
    /// because Excel disambiguates by context (`SUM(1, 2)` vs
    /// `{1, 2; 3, 4}`).
    ///
    /// Per-context constraints:
    /// 1. `decimal` vs `arg` — number literals inside an arg list.
    ///    `SUM(1.5, 2.5)` in EN; `SUM(1,5; 2,5)` in DE.
    /// 2. `decimal` vs `array_col` — number literals inside an
    ///    array cell. `{1.5, 2.5}` in EN; `{1,5\\2,5}` in DE.
    /// 3. `array_row` vs `array_col` — row vs col inside `{}`.
    #[test]
    fn locale_separators_have_no_within_context_collisions() {
        for locale in [Locale::EnUs, Locale::De, Locale::Fr] {
            let d = locale_data(locale);
            assert_ne!(
                d.decimal_separator, d.arg_separator,
                "locale {locale:?}: decimal vs arg collision blocks number lex in arg list"
            );
            assert_ne!(
                d.decimal_separator, d.array_col_separator,
                "locale {locale:?}: decimal vs array_col collision blocks number lex in array cell"
            );
            assert_ne!(
                d.array_row_separator, d.array_col_separator,
                "locale {locale:?}: array row vs col collision means rows can't be distinguished"
            );
        }
    }

    /// EN-US explicitly: `arg_separator` and `array_col_separator`
    /// SHARE `,` — this is Excel-canonical and disambiguated by
    /// parser context. Pin the design contract.
    #[test]
    fn en_us_arg_and_array_col_share_comma_by_design() {
        let d = locale_data(Locale::EnUs);
        assert_eq!(d.arg_separator, ',');
        assert_eq!(d.array_col_separator, ',');
        // The shared glyph is intentional — context disambiguates.
    }

    /// **Closes design § 3.2 Codex MEDIUM:** in DE locale, decimal
    /// and arg separators are distinct (`,` vs `;`) so a token stream
    /// is unambiguous despite the visual similarity. en-US uses `,`
    /// for ARG (not decimal), which is why `SUM(2,34)` means two args.
    #[test]
    fn de_vs_en_decimal_vs_arg_collision_avoided() {
        let en = locale_data(Locale::EnUs);
        let de = locale_data(Locale::De);
        // EN uses `,` for arg separator + `.` for decimal: the `,` is
        // an arg separator, never part of a number literal.
        assert_eq!(en.arg_separator, ',');
        assert_eq!(en.decimal_separator, '.');
        assert_ne!(en.arg_separator, en.decimal_separator);
        // DE swaps the roles: `,` is decimal, `;` is arg. So `2,34`
        // in a DE context is one number literal `2.34`; `SUM(2,34;5)`
        // means `SUM(2.34, 5)` per design doc test vector.
        assert_eq!(de.arg_separator, ';');
        assert_eq!(de.decimal_separator, ',');
        assert_ne!(de.arg_separator, de.decimal_separator);
    }
}

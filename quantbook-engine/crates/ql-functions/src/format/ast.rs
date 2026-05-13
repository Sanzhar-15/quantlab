//! Format-string AST shape.
//!
//! See `docs/architecture/2026-05-13-format-string-grammar.md` § 8.

/// One Excel-canon format string parsed into 1-4 sections.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FormatString {
    /// 1..=4 sections per the parent grammar. Index 0 is always present.
    pub sections: Vec<Section>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Section {
    pub kind: SectionKind,
    pub tokens: Vec<SectionToken>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SectionKind {
    /// Has digit placeholders, no date/time tokens.
    Number,
    /// Has date or time tokens (may also have digit placeholders).
    Date,
    /// Has `@` text passthrough.
    Text,
    /// Empty token list (between two `;`).
    Empty,
    /// Single `General` token.
    General,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SectionToken {
    // ===== Digit placeholders =====
    Digit {
        kind: DigitKind,
        number: NumberState,
    },

    // ===== Numeric punctuation / scale =====
    DecimalPoint,
    /// `,` between digit tokens — affects rendering by inserting the
    /// thousands separator (en-US `,`).
    ThousandsSeparator,
    /// One or more trailing `,` AFTER all digit tokens — scale down by
    /// `1000^count`.
    ScaleByThousands(u32),
    /// Count of `%` tokens. Multiply the value by `100^count` at render.
    Percent(u32),
    ExponentMarker {
        signed_minus: bool,
    },

    // ===== Date / time pieces =====
    Day {
        padded: bool,
    },
    DayName {
        full: bool,
    }, // ddd vs dddd
    Month {
        padded: bool,
        role: MonthRole,
    },
    MonthName {
        length: MonthNameLen,
    },
    Year {
        short: bool,
    },
    Hour {
        padded: bool,
    },
    Minute {
        padded: bool,
    }, // disambiguated from Month at parse
    Second {
        padded: bool,
    },
    AmPm,

    // ===== Text / literal =====
    QuotedText(String),
    Literal(char),
    Currency {
        ch: char,
        locale_code: Option<u32>,
    },
    /// `@` text passthrough.
    TextPassthrough,
    /// `*X` — parsed; V1 ignores at render (no column-width metadata).
    Spacer(char),
    /// `_X` — parsed; V1 ignores at render.
    Ghost(char),
    /// `General` keyword.
    General,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DigitKind {
    Zero,
    Sharp,
    Question,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NumberState {
    /// Digit appears before any `.` in the section.
    Integer,
    /// Digit appears after `.`.
    Decimal,
    /// Digit appears after `E+`/`E-` (the exponent's own digit run).
    Exponent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MonthRole {
    Month,
    Minute,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MonthNameLen {
    /// `mmm` — short form (Jan, Feb, ...).
    Short,
    /// `mmmm` — full name (January, February, ...).
    Full,
    /// `mmmmm` — single-letter (J, F, M, ...).
    SingleLetter,
}

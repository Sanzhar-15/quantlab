//! AST printer — produces an A1-canonical string from an `Expr`.
//!
//! Phase B per CORR-20 deliverable: round-trip property `parse(print(parse(src))) ==
//! parse(src)`. The printed form is NOT byte-identical to the source — operator
//! spacing, parenthesization, and function-name casing normalize. The semantic
//! equivalence is what matters (and what the round-trip property captures).
//!
//! ## Parenthesization
//!
//! The printer parenthesizes `Binary` and `Unary` subexpressions whenever the parent's
//! operator binding power would cause re-parsing to misorder the result. The rule:
//!
//! - For a child binary expression with op `c_op`, parenthesize if `bp(c_op).lbp <
//!   parent_min_bp`.
//! - For a power right-operand: parenthesize if `bp(c_op).rbp <= parent_rbp` (since `^`
//!   is right-associative).
//!
//! This produces canonical output: `=1 + 2 * 3` (no parens), `=(1 + 2) * 3` (parens
//! around the addition).
//!
//! ## Round-trip semantics
//!
//! `Number::Number(0.5)` doesn't round-trip to the source `50%` — the lexer normalized
//! percent at lex time. Other normalizations:
//! - Function names → uppercase (`sum(...)` → `SUM(...)`).
//! - Range corners → sorted (`A2:A1` → `A1:A2`).
//! - Whitespace → eliminated except inside string literals.
//!
//! These are intentional canonical-form rewrites, not bugs. The round-trip property
//! checks that `parse(printed) == parse(original)`, NOT that the strings match.

use crate::ast::{CellAddr, Expr, RangeRef, SheetRef};
use crate::token::{AxisSpec, Operator};
use ql_types::{Locale, ReferenceMode, MAX_COLUMN, MAX_ROW};

/// **W5-141 (Phase 4.9.D):** printer-side anchor cell. Required for
/// emitting `R[<offset>]C[<offset>]` from relative `Expr::R1C1Ref` or
/// from non-absolute `Expr::CellRef` when `mode == R1C1`.
///
/// Parallels `ql-exec::plan::BindSite::at_cell` on the bind side — see
/// design § 4.3. The bind-time site carries sheet + cell; the
/// printer-time site only needs the cell coords because the printer
/// is mode-only (sheet IDs are already resolved or `Current`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FormulaSite {
    pub cell: ql_types::Address,
}

impl FormulaSite {
    pub fn at_cell(cell: ql_types::Address) -> Self {
        Self { cell }
    }
}

/// **W5-141 (Phase 4.9.D):** printer error surface. Today's only
/// variant fires when `print_with(.., R1C1, _, None)` is called on an
/// AST containing a reference whose emission requires an anchor
/// (either an `Expr::CellRef` with at least one non-absolute axis, or
/// an `Expr::R1C1Ref` with at least one `AxisSpec::Rel(_)`).
///
/// Per design § 4.3, NO fallback — production storage canon always
/// supplies a `FormulaSite`; only synthetic / test paths can surface
/// this error.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
#[non_exhaustive]
pub enum PrintError {
    /// Anchor cell required for R1C1-mode emission of a relative ref.
    #[error("R1C1 emission requires a FormulaSite anchor (mode is R1C1 and a relative reference was encountered)")]
    R1C1RequiresAnchor,

    /// **W5-141:** the R1C1 axis resolution overflowed the i64 we use
    /// for offset arithmetic, OR an `AxisSpec::Abs(0)` slipped through.
    /// Defense-in-depth — both lexer + binder reject these earlier; this
    /// arm catches direct AST construction.
    #[error("R1C1 axis out of range: {context}")]
    R1C1AxisOutOfRange { context: &'static str },
}

/// **W5-141 (Phase 4.9.D):** internal printer context. Threads
/// `(mode, locale, site)` through the recursion. Not exposed in the
/// public API; callers configure via `print_with(...)` args.
#[derive(Clone, Copy)]
struct PrintCtx {
    mode: ReferenceMode,
    /// **W5-142 (Phase 4.9.F):** drives decimal separator in
    /// `print_number_with_locale`, function arg separator, and array
    /// row/col separators. Lookup via `crate::locale::locale_data`.
    locale: Locale,
    site: Option<FormulaSite>,
}

/// Print an `Expr` to its A1-canonical string form.
///
/// **W5-141 (Phase 4.9.D):** this is now a back-compat shim over
/// [`print_with`]. The shim is infallible because A1+EnUs+no-site is
/// guaranteed to succeed for every AST that originates from an A1
/// parse. The single exception — `Expr::R1C1Ref` with at least one
/// `Rel(_)` axis — surfaces as a panic via `.expect`. Callers that
/// might handle R1C1 forms should call [`print_with`] directly to
/// get a `Result`.
pub fn print(expr: &Expr) -> String {
    print_with(expr, ReferenceMode::A1, Locale::EnUs, None).expect(
        "print(): A1+EnUs with no FormulaSite cannot emit relative R1C1 references; \
         call print_with(.., R1C1, _, Some(site)) instead",
    )
}

/// **W5-141 (Phase 4.9.D):** mode- and locale-aware printer.
///
/// - `mode == A1`: emits canonical A1 source text (existing behavior,
///   matches today's `print()` exactly when `locale == EnUs`).
/// - `mode == R1C1`: emits canonical R1C1 source text. Absolute axes
///   emit as `R<n>` / `C<n>` (1-indexed source form). Relative axes
///   require `site`: emits `R[<offset>]` / `C[<offset>]`, OR bare
///   `R` / `C` when offset == 0 (Excel R1C1 canon).
/// - `site == None` + `mode == R1C1` + any relative ref →
///   `Err(PrintError::R1C1RequiresAnchor)`.
///
/// **Locale**: parameter is accepted today for signature stability
/// per design § 4.3; locale-aware decimal / separators on the print
/// side ship in 4.9.F.
pub fn print_with(
    expr: &Expr,
    mode: ReferenceMode,
    locale: Locale,
    site: Option<FormulaSite>,
) -> Result<String, PrintError> {
    let ctx = PrintCtx { mode, locale, site };
    let mut out = String::new();
    print_expr_ctx(expr, &ctx, &mut out, 0)?;
    Ok(out)
}

/// Convert a 0-indexed column number to Excel letters (A, B, ..., Z, AA, AB, ...).
fn column_index_to_letters(mut col: u32) -> String {
    let mut letters = String::new();
    // Excel column letters are base-26 with A=1 (not base-26 with A=0). The conversion:
    // 0 → A, 25 → Z, 26 → AA, 27 → AB, ..., 701 → ZZ, 702 → AAA.
    loop {
        let digit = (col % 26) as u8;
        letters.insert(0, (b'A' + digit) as char);
        if col < 26 {
            break;
        }
        col = col / 26 - 1;
    }
    letters
}

/// **W5-141 (Phase 4.9.D):** emit a `CellAddr` in either A1 or R1C1
/// form, driven by `ctx.mode`. The sheet prefix GLYPH (`Sheet1!`) is the
/// same in both modes per Excel canon, but its QUOTING is mode-aware (an
/// `R1C1`-shaped name is quoted in R1C1 mode -- see print_sheet_name).
fn print_cell_addr_ctx(
    addr: &CellAddr,
    ctx: &PrintCtx,
    out: &mut String,
) -> Result<(), PrintError> {
    print_sheet_prefix(&addr.sheet, ctx.mode, out);
    match ctx.mode {
        ReferenceMode::A1 => {
            if addr.abs_col {
                out.push('$');
            }
            out.push_str(&column_index_to_letters(addr.col));
            if addr.abs_row {
                out.push('$');
            }
            out.push_str(&(addr.row + 1).to_string());
            Ok(())
        }
        ReferenceMode::R1C1 => {
            // Emit `R<row-axis>C<col-axis>`. Row first; col second.
            // For each axis, abs → 1-indexed integer; rel → bracketed
            // signed offset from anchor (or bare letter if offset = 0).
            emit_r1c1_axis(
                addr.abs_row,
                addr.row,
                ctx.site.map(|s| s.cell.row),
                'R',
                out,
            )?;
            emit_r1c1_axis(
                addr.abs_col,
                addr.col,
                ctx.site.map(|s| s.cell.col),
                'C',
                out,
            )?;
            Ok(())
        }
    }
}

/// **W5-141 (Phase 4.9.D):** emit one R1C1 axis of an absolute-form
/// `CellAddr`. `is_abs` selects between absolute (`R<n>`) and relative
/// (`R[<offset>]` or bare `R`); `anchor` is needed for the relative
/// path, and missing-anchor surfaces `PrintError::R1C1RequiresAnchor`.
fn emit_r1c1_axis(
    is_abs: bool,
    coord: u32,
    anchor: Option<u32>,
    letter: char,
    out: &mut String,
) -> Result<(), PrintError> {
    if is_abs {
        out.push(letter);
        // 1-indexed source form. `coord` is `u32` with documented
        // max `MAX_ROW` / `MAX_COLUMN`, so `coord + 1` cannot overflow
        // (max is 1_048_576 / 16_384 — well below u32::MAX).
        out.push_str(&(coord + 1).to_string());
        return Ok(());
    }
    // Relative form: needs an anchor.
    let Some(anchor) = anchor else {
        return Err(PrintError::R1C1RequiresAnchor);
    };
    // `coord - anchor` may be negative; compute in i64 to avoid wrap.
    // Both operands fit easily in i64 (max ≈ 1M), so this can't
    // overflow under any well-formed CellAddr.
    let offset = coord as i64 - anchor as i64;
    out.push(letter);
    if offset != 0 {
        out.push('[');
        out.push_str(&offset.to_string());
        out.push(']');
    }
    // offset == 0 → bare letter (Excel canon: `R[0]C[0]` and `RC` are
    // semantically identical; canonical form is `RC`).
    Ok(())
}

/// **W5-141 (Phase 4.9.D):** emit one R1C1 axis from an `AxisSpec`
/// (used when the AST carries `Expr::R1C1Ref` / `RangeRef::R1C1Cells`
/// directly, i.e. parser-intermediate forms that bypass the
/// post-bind absolute-CellRef shape).
///
/// - `AxisSpec::Abs(n)` → `R<n>` / `C<n>` (n is already 1-indexed
///   in the AST per the lexer's spec).
/// - `AxisSpec::Rel(offset)` → `R[<offset>]` / `C[<offset>]`, or
///   bare `R` / `C` when `offset == 0`.
///
/// Site is NOT consulted here — the axis values are verbatim from
/// the source. (Cross-mode conversion — emitting A1 text from
/// `Expr::R1C1Ref` — uses `axis_spec_to_absolute_coord` to resolve
/// first.)
fn emit_r1c1_axis_from_spec(axis: AxisSpec, letter: char, out: &mut String) {
    out.push(letter);
    match axis {
        AxisSpec::Abs(n) => out.push_str(&n.to_string()),
        AxisSpec::Rel(offset) => {
            if offset != 0 {
                out.push('[');
                out.push_str(&offset.to_string());
                out.push(']');
            }
        }
    }
}

/// **W5-141 (Phase 4.9.D):** resolve one `AxisSpec` to an absolute
/// 0-indexed coord. Used by A1-mode emission of `Expr::R1C1Ref`:
/// absolute axes go straight to `n - 1`; relative axes require an
/// anchor and surface `R1C1RequiresAnchor` if missing.
///
/// Mirrors `ql-exec::plan::resolve_r1c1_axis` (same arithmetic,
/// printer-side error type). Kept duplicated for now rather than
/// shared via a third crate — the two sides use different error
/// enums and the body is ~15 lines.
/// **W5-152 (4.9.O Sonnet LOW-2 closure):** tightened bound from
/// `u32::MAX` to `bound` (MAX_ROW or MAX_COLUMN, passed by caller).
/// Pre-tightening, a synthetic `AxisSpec::Rel(16385)` at anchor 0
/// would resolve to col 16385 and the printer would emit
/// `column_index_to_letters(16385)` — a string beyond Excel's
/// `XFD` max that the lexer would reject on re-parse. Production
/// paths can't reach this (lexer caps `Abs(n) <= MAX+1` and binder
/// caps `anchor+offset <= MAX`), but defense-in-depth for
/// directly-constructed ASTs.
fn axis_spec_to_absolute_coord(
    axis: AxisSpec,
    anchor: Option<u32>,
    bound: u32,
) -> Result<u32, PrintError> {
    match axis {
        AxisSpec::Abs(n) => {
            if n == 0 {
                return Err(PrintError::R1C1AxisOutOfRange {
                    context: "AxisSpec::Abs(0) — R1C1 is 1-indexed",
                });
            }
            if n > bound + 1 {
                return Err(PrintError::R1C1AxisOutOfRange {
                    context: "AxisSpec::Abs(n) exceeds Excel grid bound",
                });
            }
            Ok(n - 1)
        }
        AxisSpec::Rel(offset) => {
            let Some(anchor) = anchor else {
                return Err(PrintError::R1C1RequiresAnchor);
            };
            let resolved = anchor as i64 + offset as i64;
            if !(0..=(bound as i64)).contains(&resolved) {
                return Err(PrintError::R1C1AxisOutOfRange {
                    context: "relative R1C1 offset resolves outside Excel grid",
                });
            }
            Ok(resolved as u32)
        }
    }
}

/// **W5-89 (Phase 4.6.A part 3):** emit `Sheet!` or `'Sheet name'!`
/// prefix for non-`Current` sheet refs.
///
/// **Contract:** `print` is pre-bind-only. The expected inputs are:
/// - `SheetRef::Current` — no prefix.
/// - `SheetRef::Name(_)` — the parser's output for a sheet-qualified
///   ref; emits `Sheet!` or `'Sheet name'!`.
///
/// `SheetRef::Id(_)` would require resolving the id back to a name,
/// which means threading workbook context through the printer. That
/// resolver-aware variant is a Phase 4.6.E follow-up polish item
/// tracked in `docs/known-gaps.md` (GAP-X-01). Until then, calling
/// `print` on a post-bind AST is a programmer error and panics with
/// the specific id so the call site is obvious.
///
/// **W5-93 (Phase 4.6.E closure):** Codex MEDIUM and Sonnet MEDIUM
/// converged on this finding. Closure stance: keep the panic (no-
/// fallbacks rule), improve the message, document the contract.
/// The current `rewrite_sheet_name_in_expr` path walks pre-bind
/// ASTs only, so the panic isn't reachable through any production
/// code path today.
fn print_sheet_prefix(sheet: &SheetRef, mode: ReferenceMode, out: &mut String) {
    match sheet {
        SheetRef::Current => {}
        SheetRef::Name(name) => {
            // `mode` is needed because the unquoted-name SET is mode-dependent: in R1C1 mode an
            // `R1C1`-shaped name would be (mis)lexed as a reference, so it must be quoted (see
            // print_sheet_name). The `!` separator glyph itself is mode-agnostic.
            print_sheet_name(name, mode, out);
            out.push('!');
        }
        SheetRef::Id(id) => panic!(
            "ql_formula_syntax::print: SheetRef::Id({id}) reached the printer, \
             but print() is pre-bind-only by contract (see fn doc comment). \
             The bound id has no associated name string at the AST level; a \
             resolver-aware print_with_resolver(expr, &workbook) API is \
             tracked as Phase 4.6.E follow-up. If you're trying to round-trip \
             a bound expression, re-parse from text instead — the binder \
             does NOT round-trip back through the printer."
        ),
    }
}

/// **W5-89 (Phase 4.6.A part 3):** emit a sheet name in its canonical
/// source form. Emitted UNQUOTED only when it re-lexes as an unquoted
/// sheet-name prefix IN THE TARGET `mode`: the FIRST char is `[A-Za-z_]`
/// (the lexer starts an unquoted name only there, `lexer.rs`) AND every
/// char is in `[A-Za-z0-9_.]` AND -- in R1C1 mode only -- the name is not
/// shaped like an R1C1 reference start. Quoted otherwise — empty
/// (defensive; empty names are rejected at registry time anyway), a leading
/// DIGIT (would lex as a number/row), a leading DOT (`.foo` — the prior rule
/// emitted it unquoted but the lexer cannot re-lex it; printer/lexer
/// round-trip mismatch, Codex Lane A 2026-06-09), an R1C1-shadow name in
/// R1C1 mode (`R1`, `R1C1`, `RC` — the R1C1 lexer consumes `R`+(`[`|digit|`C`)
/// as a reference BEFORE the sheet-name arm; Codex 2026-06-09), or any other
/// char. Embedded `'` is escaped as `''`.
fn print_sheet_name(name: &str, mode: ReferenceMode, out: &mut String) {
    // The first char must be `[A-Za-z_]` to match the lexer's unquoted-name start; a leading
    // digit OR a leading `.` (both otherwise in the allowed set) would print unquoted yet fail
    // to re-lex, so they force quoting.
    let first_char_ok = matches!(
        name.chars().next(),
        Some(c) if c.is_ascii_alphabetic() || c == '_'
    );
    // R1C1 mode only: the lexer dispatches `R`/`r` followed by `[`, an ASCII digit, or `C`/`c`
    // to the R1C1 reference lexer BEFORE `try_lex_sheet_name_prefix` (lexer.rs `try_lex_r1c1_ref`
    // `should_commit`), so such a name would be (mis)consumed as a reference, not a sheet prefix.
    // Quote it. (A leading `[` is already outside the `[A-Za-z0-9_.]` body set below; the live
    // unquoted-but-unsafe cases are `R`+digit / `R`+`C`. A1 mode never triggers this.)
    let r1c1_shadow = mode == ReferenceMode::R1C1 && {
        let mut cs = name.chars();
        let starts_r = matches!(cs.next(), Some(r) if r.eq_ignore_ascii_case(&'R'));
        let second = cs.next();
        starts_r
            && (matches!(second, Some('[') | Some('0'..='9'))
                || matches!(second, Some(c) if c.eq_ignore_ascii_case(&'C')))
    };
    let needs_quoting = !first_char_ok
        || r1c1_shadow
        || name
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'));
    if needs_quoting {
        out.push('\'');
        for c in name.chars() {
            if c == '\'' {
                out.push('\'');
                out.push('\'');
            } else {
                out.push(c);
            }
        }
        out.push('\'');
    } else {
        out.push_str(name);
    }
}

/// **W5-141 (Phase 4.9.D):** ctx-aware range printer.
fn print_range_ctx(r: &RangeRef, ctx: &PrintCtx, out: &mut String) -> Result<(), PrintError> {
    match r {
        RangeRef::Cells {
            sheet,
            start_col,
            start_row,
            end_col,
            end_row,
            abs_start_col,
            abs_start_row,
            abs_end_col,
            abs_end_row,
        } => {
            // Sheet prefix applies to the WHOLE range; emit once.
            print_sheet_prefix(sheet, ctx.mode, out);
            // Both endpoints get SheetRef::Current so the inner cell
            // print doesn't double the sheet prefix.
            let start = CellAddr {
                sheet: SheetRef::Current,
                col: *start_col,
                row: *start_row,
                abs_col: *abs_start_col,
                abs_row: *abs_start_row,
            };
            let end = CellAddr {
                sheet: SheetRef::Current,
                col: *end_col,
                row: *end_row,
                abs_col: *abs_end_col,
                abs_row: *abs_end_row,
            };
            print_cell_addr_ctx(&start, ctx, out)?;
            out.push(':');
            print_cell_addr_ctx(&end, ctx, out)?;
            Ok(())
        }
        RangeRef::WholeColumn {
            sheet,
            start_col,
            end_col,
            abs_start,
            abs_end,
        } => {
            print_sheet_prefix(sheet, ctx.mode, out);
            match ctx.mode {
                ReferenceMode::A1 => {
                    if *abs_start {
                        out.push('$');
                    }
                    out.push_str(&column_index_to_letters(*start_col));
                    out.push(':');
                    if *abs_end {
                        out.push('$');
                    }
                    out.push_str(&column_index_to_letters(*end_col));
                    Ok(())
                }
                ReferenceMode::R1C1 => {
                    // R1C1 whole-column form: `C<start>:C<end>` (cols
                    // only, no R). Excel canon doesn't have a dedicated
                    // R1C1 "whole-column" form; using the C-only range
                    // is the conventional translation. abs/rel
                    // distinction preserved per axis.
                    emit_r1c1_axis(
                        *abs_start,
                        *start_col,
                        ctx.site.map(|s| s.cell.col),
                        'C',
                        out,
                    )?;
                    out.push(':');
                    emit_r1c1_axis(*abs_end, *end_col, ctx.site.map(|s| s.cell.col), 'C', out)?;
                    Ok(())
                }
            }
        }
        RangeRef::WholeRow {
            sheet,
            start_row,
            end_row,
            abs_start,
            abs_end,
        } => {
            print_sheet_prefix(sheet, ctx.mode, out);
            match ctx.mode {
                ReferenceMode::A1 => {
                    if *abs_start {
                        out.push('$');
                    }
                    out.push_str(&(*start_row + 1).to_string());
                    out.push(':');
                    if *abs_end {
                        out.push('$');
                    }
                    out.push_str(&(*end_row + 1).to_string());
                    Ok(())
                }
                ReferenceMode::R1C1 => {
                    emit_r1c1_axis(
                        *abs_start,
                        *start_row,
                        ctx.site.map(|s| s.cell.row),
                        'R',
                        out,
                    )?;
                    out.push(':');
                    emit_r1c1_axis(*abs_end, *end_row, ctx.site.map(|s| s.cell.row), 'R', out)?;
                    Ok(())
                }
            }
        }
        // **W5-141 (Phase 4.9.D):** intermediate R1C1 range. Mirrors
        // `Expr::R1C1Ref` per-mode dispatch:
        // - R1C1 mode: emit `R<ax>C<ax>:R<ax>C<ax>` directly from
        //   the AxisSpec fields.
        // - A1 mode: resolve all 4 axes to absolute coords (relative
        //   axes need `ctx.site`), then emit as an A1 cell range.
        //   Per-axis abs/rel determines whether each gets `$`.
        RangeRef::R1C1Cells {
            sheet,
            start_row,
            start_col,
            end_row,
            end_col,
        } => {
            print_sheet_prefix(sheet, ctx.mode, out);
            match ctx.mode {
                ReferenceMode::R1C1 => {
                    emit_r1c1_axis_from_spec(*start_row, 'R', out);
                    emit_r1c1_axis_from_spec(*start_col, 'C', out);
                    out.push(':');
                    emit_r1c1_axis_from_spec(*end_row, 'R', out);
                    emit_r1c1_axis_from_spec(*end_col, 'C', out);
                    Ok(())
                }
                ReferenceMode::A1 => {
                    let s_row = axis_spec_to_absolute_coord(
                        *start_row,
                        ctx.site.map(|s| s.cell.row),
                        MAX_ROW,
                    )?;
                    let s_col = axis_spec_to_absolute_coord(
                        *start_col,
                        ctx.site.map(|s| s.cell.col),
                        MAX_COLUMN,
                    )?;
                    let e_row = axis_spec_to_absolute_coord(
                        *end_row,
                        ctx.site.map(|s| s.cell.row),
                        MAX_ROW,
                    )?;
                    let e_col = axis_spec_to_absolute_coord(
                        *end_col,
                        ctx.site.map(|s| s.cell.col),
                        MAX_COLUMN,
                    )?;
                    let abs = |a: &AxisSpec| matches!(a, AxisSpec::Abs(_));
                    if abs(start_col) {
                        out.push('$');
                    }
                    out.push_str(&column_index_to_letters(s_col));
                    if abs(start_row) {
                        out.push('$');
                    }
                    out.push_str(&(s_row + 1).to_string());
                    out.push(':');
                    if abs(end_col) {
                        out.push('$');
                    }
                    out.push_str(&column_index_to_letters(e_col));
                    if abs(end_row) {
                        out.push('$');
                    }
                    out.push_str(&(e_row + 1).to_string());
                    Ok(())
                }
            }
        }
    }
}

fn print_string_literal(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        if ch == '"' {
            out.push('"');
            out.push('"');
        } else {
            out.push(ch);
        }
    }
    out.push('"');
}

/// **W5-142 (Phase 4.9.F):** locale-aware number printer.
///
/// Replaces the canonical `.` decimal separator with the locale's
/// decimal glyph in the formatted output. Rust's `f64` Display
/// always emits `.` regardless of locale (it's a numeric, not
/// locale-aware, formatter), so we do a single byte substitution.
///
/// Scientific notation (`1e10`) — `e`/`E` are locale-invariant per
/// W5-135 design (numeric exponent marker is not separable from
/// decimal-separator choice in the lex direction either).
fn print_number_with_locale(n: f64, decimal_sep: char, out: &mut String) {
    if n.fract() == 0.0 && n.abs() < 1.0e16 {
        // Integer-valued f64 → no decimal point. Decimal sep irrelevant.
        out.push_str(&format!("{}", n as i64));
    } else {
        let canonical = format!("{n}");
        if decimal_sep == '.' {
            // Hot path: EN locale emits the canonical form verbatim.
            out.push_str(&canonical);
        } else {
            // DE/FR: swap `.` → locale glyph. f64 Display only emits a
            // single `.` per number (no thousands sep in `{n}` output),
            // so byte-level substitution is safe.
            for c in canonical.chars() {
                if c == '.' {
                    out.push(decimal_sep);
                } else {
                    out.push(c);
                }
            }
        }
    }
}

/// **W5-141 (Phase 4.9.D):** ctx-aware, fallible printer entry. Each
/// recursion threads `&PrintCtx`; the only fallible arms are the ones
/// that may need an R1C1 anchor (CellRef in R1C1 mode + non-abs axis;
/// R1C1Ref with rel axis in either mode without anchor; range
/// variants composed of the above).
///
/// Existing parenthesization logic is unchanged from the pre-W5-141
/// `print_expr` — operator precedence is mode-agnostic.
fn print_expr_ctx(
    expr: &Expr,
    ctx: &PrintCtx,
    out: &mut String,
    parent_min_bp: u8,
) -> Result<(), PrintError> {
    match expr {
        Expr::Number(n) => {
            // **W5-142 (Phase 4.9.F):** locale-aware decimal separator.
            let locale_data = crate::locale::locale_data(ctx.locale);
            print_number_with_locale(*n, locale_data.decimal_separator, out);
            Ok(())
        }
        Expr::Bool(b) => {
            out.push_str(if *b { "TRUE" } else { "FALSE" });
            Ok(())
        }
        Expr::String(s) => {
            print_string_literal(s, out);
            Ok(())
        }
        Expr::CellRef(addr) => print_cell_addr_ctx(addr, ctx, out),
        Expr::RangeRef(r) => print_range_ctx(r, ctx, out),
        Expr::Binary { op, lhs, rhs } => {
            let (lbp, rbp) = binary_bp(*op);
            let needs_parens = lbp < parent_min_bp;
            if needs_parens {
                out.push('(');
            }
            let is_right_assoc = lbp > rbp;
            let lhs_min_bp = if is_right_assoc { lbp + 1 } else { lbp };
            print_expr_ctx(lhs, ctx, out, lhs_min_bp)?;
            out.push(' ');
            out.push_str(op.as_str());
            out.push(' ');
            print_expr_ctx(rhs, ctx, out, rbp + 1)?;
            if needs_parens {
                out.push(')');
            }
            Ok(())
        }
        Expr::Unary { op, operand } => match op {
            Operator::Percent => {
                print_expr_ctx(operand, ctx, out, 61)?;
                out.push('%');
                Ok(())
            }
            Operator::Minus | Operator::Plus => {
                out.push_str(op.as_str());
                print_expr_ctx(operand, ctx, out, 70)
            }
            other => {
                out.push_str(other.as_str());
                print_expr_ctx(operand, ctx, out, 70)
            }
        },
        Expr::Function { name, args } => {
            // **W5-142 (Phase 4.9.F):** locale-aware argument separator.
            // EN: `,` → ", ". DE/FR: `;` → "; ". Trailing space kept
            // for readability; matches existing EN canonical style.
            let arg_sep = crate::locale::locale_data(ctx.locale).arg_separator;
            out.push_str(name);
            out.push('(');
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    out.push(arg_sep);
                    out.push(' ');
                }
                print_expr_ctx(a, ctx, out, 0)?;
            }
            out.push(')');
            Ok(())
        }
        // **Wave P (2026-06-20):** immediate invocation `LAMBDA(x,x+1)(41)`.
        // Print the callee expression tightly (high min_bp so any non-atomic
        // callee parenthesizes for a lossless round-trip — though today the
        // callee is always a `Function`/`Call`), then the call argument list.
        Expr::Call { callee, args } => {
            let arg_sep = crate::locale::locale_data(ctx.locale).arg_separator;
            print_expr_ctx(callee, ctx, out, 90)?;
            out.push('(');
            for (i, a) in args.iter().enumerate() {
                if i > 0 {
                    out.push(arg_sep);
                    out.push(' ');
                }
                print_expr_ctx(a, ctx, out, 0)?;
            }
            out.push(')');
            Ok(())
        }
        Expr::NameRef(name) => {
            out.push_str(name);
            Ok(())
        }
        Expr::Error(ev) => {
            out.push_str(ev.sigil());
            Ok(())
        }
        Expr::Array(rows) => {
            // **W5-142 (Phase 4.9.F):** locale-aware array row/col
            // separators. EN: row=`;`, col=`,`. DE/FR: row=`.`, col=`\\`.
            // Both followed by space for readability.
            if rows.is_empty() {
                unreachable!(
                    "print_expr_ctx: Expr::Array with zero rows — parser rejects empty \
                     literals via ParseError::EmptyArrayLiteral; constructing one \
                     directly is a programmer bug"
                );
            }
            let ld = crate::locale::locale_data(ctx.locale);
            let row_sep = ld.array_row_separator;
            let col_sep = ld.array_col_separator;
            out.push('{');
            for (i, row) in rows.iter().enumerate() {
                if i > 0 {
                    out.push(row_sep);
                    out.push(' ');
                }
                for (j, cell) in row.iter().enumerate() {
                    if j > 0 {
                        out.push(col_sep);
                        out.push(' ');
                    }
                    print_expr_ctx(cell, ctx, out, 0)?;
                }
            }
            out.push('}');
            Ok(())
        }
        Expr::Spill(_) => {
            // **W5-152 (4.9.O Sonnet LOW-1 closure):** updated from the
            // pre-4.9 docstring that claimed Phase 4.9 would add `A1#`
            // parsing. It didn't — Phase 4.9 closed without spill-range
            // syntax. `A1#` parsing remains a known gap for a future
            // phase; this arm guards future addition.
            unreachable!(
                "print_expr_ctx: Expr::Spill is reserved for a future Phase \
                 (Excel `A1#` spill-range syntax not yet added) — reaching \
                 here means the AST was directly constructed with this variant"
            );
        }
        Expr::StructuredRef { table_name, spec } => {
            out.push_str(table_name);
            out.push('[');
            print_sref_spec(spec, out);
            out.push(']');
            Ok(())
        }
        // **W5-143 (Phase 4.9.G):** implicit-intersection — emit
        // `@<inner>` for round-trip preservation. Inner is printed
        // with prefix-unary-bp so future binary-context nesting
        // re-parenthesizes correctly. Today's parser folds `@expr`
        // greedily so `print(parse("@A1")) == "@A1"`.
        Expr::ImplicitIntersection(inner) => {
            out.push('@');
            print_expr_ctx(inner, ctx, out, 70)
        }
        // **W5-141 (Phase 4.9.D):** intermediate R1C1 single ref. The
        // emission path depends on `ctx.mode`:
        //
        // - `R1C1`: emit directly from `AxisSpec` verbatim — `R1C1`,
        //   `R[-1]C[2]`, `RC` etc. Sheet prefix uses the existing
        //   `print_sheet_prefix` (mode-aware quoting: an `R1C1`-shaped sheet
        //   name is quoted here so it does not re-lex as a reference).
        // - `A1`: resolve each `AxisSpec` to an absolute 0-indexed
        //   coord (relative axes need `ctx.site`), then emit as a
        //   regular A1 `CellAddr`. `AxisSpec::Abs(n)` → `$<letter><row>`
        //   (absolute parts get `$` prefix); `AxisSpec::Rel(offset)`
        //   resolves to an absolute coord but emits WITHOUT `$`
        //   (Excel canon: relative R1C1 axes round-trip to non-abs A1).
        Expr::R1C1Ref {
            sheet,
            row_axis,
            col_axis,
        } => {
            print_sheet_prefix(sheet, ctx.mode, out);
            match ctx.mode {
                ReferenceMode::R1C1 => {
                    emit_r1c1_axis_from_spec(*row_axis, 'R', out);
                    emit_r1c1_axis_from_spec(*col_axis, 'C', out);
                    Ok(())
                }
                ReferenceMode::A1 => {
                    let row = axis_spec_to_absolute_coord(
                        *row_axis,
                        ctx.site.map(|s| s.cell.row),
                        MAX_ROW,
                    )?;
                    let col = axis_spec_to_absolute_coord(
                        *col_axis,
                        ctx.site.map(|s| s.cell.col),
                        MAX_COLUMN,
                    )?;
                    if matches!(col_axis, AxisSpec::Abs(_)) {
                        out.push('$');
                    }
                    out.push_str(&column_index_to_letters(col));
                    if matches!(row_axis, AxisSpec::Abs(_)) {
                        out.push('$');
                    }
                    out.push_str(&(row + 1).to_string());
                    Ok(())
                }
            }
        }
    }
}

/// **W5-113 (Phase 4.8.D):** apply OOXML structured-reference escapes
/// to a column-name string when emitting it inside `[...]` bracket
/// content. Each of `[`, `]`, `#`, `@`, `'` is preceded by `'`. The
/// lexer's `consume_structured_ref_bracket` reverses this on re-lex.
fn escape_for_sref(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if matches!(c, '[' | ']' | '#' | '@' | '\'') {
            out.push('\'');
        }
        out.push(c);
    }
    out
}

/// **W5-112 (Phase 4.8.C / 4.8.D):** print the bracket content of a
/// structured reference. Column names are emitted via
/// [`escape_for_sref`] so the round-trip lex(print(parse(x))) = x for
/// any well-formed column name.
fn print_sref_spec(spec: &crate::ast::TableSpecSubtree, out: &mut String) {
    use crate::ast::{SpecialItem, TableSpecItem, TableSpecSubtree};
    match spec {
        TableSpecSubtree::BareColumn(name) => {
            // BareColumn: name is the entire bracket content. Escape
            // any special chars (lexer unescapes).
            out.push_str(&escape_for_sref(name));
        }
        TableSpecSubtree::ThisRowColumn(name) => {
            // Canonical printed form: `@[Col]` (bracketed) so a name
            // starting with `[` or `#` doesn't collide with the
            // unbracketed `@Col` shorthand. Always emit brackets for
            // round-trip stability.
            out.push('@');
            out.push('[');
            out.push_str(&escape_for_sref(name));
            out.push(']');
        }
        TableSpecSubtree::ThisRowColumnRange(c1, c2) => {
            out.push('@');
            out.push('[');
            out.push_str(&escape_for_sref(c1));
            out.push(']');
            out.push(':');
            out.push('[');
            out.push_str(&escape_for_sref(c2));
            out.push(']');
        }
        TableSpecSubtree::Combination(items) => {
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                match item {
                    TableSpecItem::Special(s) => {
                        out.push('[');
                        out.push_str(match s {
                            SpecialItem::Headers => "#Headers",
                            SpecialItem::Totals => "#Totals",
                            SpecialItem::Data => "#Data",
                            SpecialItem::All => "#All",
                            SpecialItem::ThisRow => "#This Row",
                        });
                        out.push(']');
                    }
                    TableSpecItem::Column(c) => {
                        out.push('[');
                        out.push_str(&escape_for_sref(c));
                        out.push(']');
                    }
                    TableSpecItem::ColumnRange(c1, c2) => {
                        out.push('[');
                        out.push_str(&escape_for_sref(c1));
                        out.push(']');
                        out.push(':');
                        out.push('[');
                        out.push_str(&escape_for_sref(c2));
                        out.push(']');
                    }
                }
            }
        }
    }
}

/// Binding-power table for binary operators — must match `parser::infix_bp`.
fn binary_bp(op: Operator) -> (u8, u8) {
    match op {
        Operator::Eq
        | Operator::Neq
        | Operator::Lt
        | Operator::Le
        | Operator::Gt
        | Operator::Ge => (10, 11),
        Operator::Concat => (20, 21),
        Operator::Plus | Operator::Minus => (30, 31),
        Operator::Mul | Operator::Div => (40, 41),
        Operator::Pow => (51, 50),
        // Audit L4 fix (2026-05-12): Percent is postfix-only; `binary_bp(Percent)`
        // never occurs in correct code. Loud panic per the no-fallbacks rule.
        Operator::Percent => {
            unreachable!("binary_bp called with Operator::Percent (postfix-only); programmer bug")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lexer::lex;
    use crate::parser::parse;
    use std::sync::Arc;

    fn rt(src: &str) -> String {
        let expr = parse(lex(src).expect("lex")).expect("parse");
        print(&expr)
    }

    fn rt_roundtrip(src: &str) {
        // Round-trip property: parse(print(parse(src))) == parse(src).
        let first = parse(lex(src).expect("lex")).expect("parse");
        let printed = print(&first);
        let second = parse(lex(&printed).expect("lex of printed")).expect("re-parse");
        assert_eq!(
            first, second,
            "round-trip failed for: {src}\nprinted: {printed}"
        );
    }

    // ===== column letter conversion =====

    #[test]
    fn col_letters_basic() {
        assert_eq!(column_index_to_letters(0), "A");
        assert_eq!(column_index_to_letters(1), "B");
        assert_eq!(column_index_to_letters(25), "Z");
        assert_eq!(column_index_to_letters(26), "AA");
        assert_eq!(column_index_to_letters(27), "AB");
        assert_eq!(column_index_to_letters(51), "AZ");
        assert_eq!(column_index_to_letters(52), "BA");
        assert_eq!(column_index_to_letters(701), "ZZ");
        assert_eq!(column_index_to_letters(702), "AAA");
    }

    #[test]
    fn col_letters_max_excel() {
        // Excel max column = 16383 = XFD.
        assert_eq!(column_index_to_letters(16_383), "XFD");
    }

    // ===== literals =====

    #[test]
    fn print_integer_number() {
        assert_eq!(rt("42"), "42");
    }

    #[test]
    fn print_decimal_number() {
        assert_eq!(rt("3.5"), "3.5");
    }

    #[test]
    fn print_negative_number_via_unary() {
        // The parser produces Unary { Minus, Number(5) } (no negative literals).
        assert_eq!(rt("-5"), "-5");
    }

    #[test]
    fn print_bool() {
        assert_eq!(rt("TRUE"), "TRUE");
        assert_eq!(rt("false"), "FALSE"); // canonicalized to uppercase
    }

    #[test]
    fn print_string_basic() {
        assert_eq!(rt("\"hello\""), "\"hello\"");
    }

    #[test]
    fn print_string_with_embedded_quote() {
        // Source `"a""b"` lexes to String("a\"b"); printer must escape on print.
        let expr = parse(lex("\"a\"\"b\"").unwrap()).unwrap();
        assert_eq!(print(&expr), "\"a\"\"b\"");
    }

    // ===== cell refs =====

    #[test]
    fn print_cell_ref_a1() {
        assert_eq!(rt("A1"), "A1");
    }

    #[test]
    fn print_cell_ref_absolute() {
        assert_eq!(rt("$B$5"), "$B$5");
        assert_eq!(rt("$A1"), "$A1");
        assert_eq!(rt("A$1"), "A$1");
    }

    #[test]
    fn print_cell_ref_two_letter_col() {
        assert_eq!(rt("AA1"), "AA1");
        assert_eq!(rt("$XFD$1048576"), "$XFD$1048576");
    }

    // ===== ranges =====

    #[test]
    fn print_range_cells() {
        assert_eq!(rt("A1:B10"), "A1:B10");
    }

    #[test]
    fn print_range_whole_column() {
        assert_eq!(rt("A:A"), "A:A");
        assert_eq!(rt("A:C"), "A:C");
    }

    #[test]
    fn print_range_whole_row() {
        // Parser normalizes `1:1` via number_to_bare_row to WholeRow{start_row=0,end_row=0}.
        // Printer prints back as `1:1`.
        assert_eq!(rt("1:1"), "1:1");
        assert_eq!(rt("$1:$1"), "$1:$1");
    }

    // ===== arithmetic + precedence parenthesization =====

    #[test]
    fn print_binary_simple_add() {
        assert_eq!(rt("1 + 2"), "1 + 2");
    }

    #[test]
    fn print_mul_over_add_no_parens() {
        // 1 + 2 * 3 — the multiplication is RHS so it doesn't need parens.
        assert_eq!(rt("1 + 2 * 3"), "1 + 2 * 3");
    }

    #[test]
    fn print_explicit_parens_preserved_when_needed() {
        // (1 + 2) * 3 — the addition is LHS of multiplication; needs parens.
        assert_eq!(rt("(1 + 2) * 3"), "(1 + 2) * 3");
    }

    #[test]
    fn print_subtraction_left_assoc() {
        // 10 - 3 - 2 → (10 - 3) - 2 in AST; printer prints "10 - 3 - 2" (left assoc).
        assert_eq!(rt("10 - 3 - 2"), "10 - 3 - 2");
    }

    #[test]
    fn print_subtraction_with_negated_rhs() {
        // 10 - (5 - 2): the RHS is parenthesized because parser's right operand of `-`
        // gets min_bp = 31 (lbp+1), and 5-2 has bp 30 < 31 → parens.
        assert_eq!(rt("10 - (5 - 2)"), "10 - (5 - 2)");
    }

    #[test]
    fn print_power_right_assoc() {
        // 2 ^ 3 ^ 2 → 2 ^ (3 ^ 2) in AST. Printer: power is right-assoc with rbp 50;
        // the right operand of `^` needs parens only when its lbp < 51. 3^2 has lbp 51
        // which is NOT < 51, so NO parens (preserves right-assoc).
        assert_eq!(rt("2 ^ 3 ^ 2"), "2 ^ 3 ^ 2");
    }

    #[test]
    fn print_concat_with_arithmetic() {
        // A1 & 1 + 2 → A1 & (1 + 2) in AST. Printer: concat (bp 20/21) parent passes
        // min_bp = 21 to rhs; plus has lbp 30 ≥ 21 → no parens needed.
        assert_eq!(rt("A1 & 1 + 2"), "A1 & 1 + 2");
    }

    #[test]
    fn print_comparison() {
        assert_eq!(rt("A1 = B1"), "A1 = B1");
        assert_eq!(rt("A1 < B1"), "A1 < B1");
        assert_eq!(rt("A1 <= B1"), "A1 <= B1");
        assert_eq!(rt("A1 >= B1"), "A1 >= B1");
        assert_eq!(rt("A1 <> B1"), "A1 <> B1");
    }

    // ===== unary =====

    #[test]
    fn print_unary_minus() {
        assert_eq!(rt("-A1"), "-A1");
    }

    #[test]
    fn print_unary_minus_then_mul() {
        // -2 * 3 = (-2) * 3 in AST. Printer: mul lbp=40, unary parent min_bp=40, mul
        // operand has lbp 40 → no parens.
        assert_eq!(rt("-2 * 3"), "-2 * 3");
    }

    #[test]
    fn print_postfix_percent_on_grouped() {
        // (1 + 2)% — the parser produces Unary { Percent, Binary { Plus, 1, 2 } }.
        // Printer: percent's min_bp=61 passed to inner; plus has lbp 30 < 61 → parens.
        assert_eq!(rt("(1 + 2)%"), "(1 + 2)%");
    }

    // ===== function calls =====

    #[test]
    fn print_function_no_args() {
        assert_eq!(rt("NOW()"), "NOW()");
    }

    #[test]
    fn print_function_with_args() {
        assert_eq!(rt("SUM(1, 2, 3)"), "SUM(1, 2, 3)");
    }

    #[test]
    fn print_nested_function() {
        assert_eq!(rt("IF(A1 > 0, 1, 2)"), "IF(A1 > 0, 1, 2)");
    }

    #[test]
    fn print_function_name_canonicalized() {
        assert_eq!(rt("sum(1, 2)"), "SUM(1, 2)");
        assert_eq!(rt("Sum(1, 2)"), "SUM(1, 2)");
    }

    #[test]
    fn print_ai_function() {
        assert_eq!(rt("AI(\"hello\")"), "AI(\"hello\")");
        assert_eq!(rt("ai(\"x\")"), "AI(\"x\")");
    }

    #[test]
    fn print_function_with_range_arg() {
        assert_eq!(rt("SUM(A:A)"), "SUM(A:A)");
        assert_eq!(rt("SUM(A1:B10)"), "SUM(A1:B10)");
    }

    // ===== round-trip property tests =====
    //
    // These are stronger than the equality-of-printed-form tests above — they verify
    // `parse(print(parse(src))) == parse(src)` for a variety of inputs.

    #[test]
    fn roundtrip_literals() {
        rt_roundtrip("42");
        rt_roundtrip("3.5");
        rt_roundtrip("\"hello\"");
        rt_roundtrip("TRUE");
        rt_roundtrip("FALSE");
    }

    #[test]
    fn roundtrip_cellrefs() {
        rt_roundtrip("A1");
        rt_roundtrip("$B$5");
        rt_roundtrip("XFD1048576");
    }

    #[test]
    fn roundtrip_arithmetic() {
        rt_roundtrip("1 + 2");
        rt_roundtrip("1 + 2 * 3");
        rt_roundtrip("(1 + 2) * 3");
        rt_roundtrip("10 - 3 - 2");
        rt_roundtrip("2 ^ 3 ^ 2");
        rt_roundtrip("A1 + B1 * 2 - 5");
    }

    /// Audit H1 regression test (2026-05-12). `(a^b)^c` is left-grouped (Pow's LHS is
    /// itself a Pow). Previously the printer emitted `a ^ b ^ c` because both child
    /// and parent had lbp=51 and the `lbp < parent_min_bp` check was false. The
    /// resulting string re-parses as right-grouped `a^(b^c)`, breaking the AST. Fix:
    /// pass `lbp + 1` to the LHS for right-associative ops so the LHS-as-same-op gets
    /// parens.
    #[test]
    fn roundtrip_left_grouped_power() {
        // Direct round-trip: parse `(2^3)^4` should equal parse(print(parse(input))).
        rt_roundtrip("(2 ^ 3) ^ 4");
        // Adversarial deep left-grouping.
        rt_roundtrip("((2 ^ 3) ^ 4) ^ 5");
        // Confirm the surface form makes parens explicit. The parser of `2 ^ 3 ^ 4`
        // produces Pow(2, Pow(3, 4)) (right-assoc); printing must NOT add parens.
        // The parser of `(2 ^ 3) ^ 4` produces Pow(Pow(2, 3), 4); printing MUST add
        // parens around the LHS to preserve the AST.
        let right_grouped = parse(lex("2 ^ 3 ^ 4").unwrap()).unwrap();
        assert_eq!(print(&right_grouped), "2 ^ 3 ^ 4");
        let left_grouped = parse(lex("(2 ^ 3) ^ 4").unwrap()).unwrap();
        assert_eq!(print(&left_grouped), "(2 ^ 3) ^ 4");
    }

    #[test]
    fn roundtrip_comparison_concat() {
        rt_roundtrip("A1 = B1");
        rt_roundtrip("A1 & \"x\"");
        rt_roundtrip("A1 & 1 + 2");
    }

    #[test]
    fn roundtrip_unary() {
        rt_roundtrip("-5");
        rt_roundtrip("-A1");
        rt_roundtrip("-2 * 3");
        rt_roundtrip("(1 + 2)%");
    }

    #[test]
    fn roundtrip_functions() {
        rt_roundtrip("SUM(1, 2, 3)");
        rt_roundtrip("IF(A1 > 0, 1, 2)");
        rt_roundtrip("SUM(A1, B1)");
        rt_roundtrip("AI(\"prompt\")");
        rt_roundtrip("LOG10(100)");
    }

    #[test]
    fn roundtrip_ranges() {
        rt_roundtrip("A1:B10");
        rt_roundtrip("A:A");
        rt_roundtrip("1:1");
        rt_roundtrip("SUM(A:A)");
        rt_roundtrip("$1:$1");
    }

    #[test]
    fn roundtrip_complex_formula() {
        rt_roundtrip("IF(SUM(A1:A10) > 100, \"big\", AVERAGE(B1:B10) * 2)");
        rt_roundtrip("(A1 + B1) * (C1 - D1) / 2");
        rt_roundtrip("SUM(A1, IF(B1 > 0, C1, -C1))");
    }

    #[test]
    fn roundtrip_og02_pattern() {
        rt_roundtrip("A * 2");
        rt_roundtrip("A1 * 2");
        rt_roundtrip("(A1 + B1) * 2");
    }

    // ===== W5-1 corpus expansion (additional parser-corpus tests) =====

    #[test]
    fn roundtrip_chained_function_calls() {
        rt_roundtrip("ROUND(SUM(A1, B1), 2)");
    }

    #[test]
    fn roundtrip_deeply_nested() {
        rt_roundtrip("((((1 + 2) * 3) - 4) / 5)");
    }

    #[test]
    fn roundtrip_mixed_abs_markers() {
        rt_roundtrip("$A1:B$10");
        rt_roundtrip("$A$1 + B2");
    }

    #[test]
    fn roundtrip_string_with_special_chars() {
        // Embedded space, comma, equals — all preserved verbatim inside the string.
        rt_roundtrip("\"hello, world = 42\"");
    }

    #[test]
    fn roundtrip_iferror_pattern() {
        rt_roundtrip("IFERROR(A1 / B1, 0)");
    }

    #[test]
    fn roundtrip_with_many_args() {
        rt_roundtrip("SUM(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)");
    }

    /// Phase 2A.5 (2026-05-12): the lexer now accepts dotted identifiers, so
    /// `VAR.S(...)` round-trips through lex → parse → print. Replaces the prior
    /// "VAR alias workaround" path.
    #[test]
    fn roundtrip_dotted_function_name() {
        rt_roundtrip("VAR.S(1, 2, 3)");
        rt_roundtrip("STDEV.P(1, 2, 3, 4)");
    }

    /// Multi-dot identifiers (lexer-accepted, binder-rejected for unknown
    /// names) still round-trip through the printer cleanly. Pin per audit L9
    /// (2026-05-12) so a future printer change can't break dotted-name output.
    #[test]
    fn print_multi_dot_name_ref() {
        let e = parse(lex("A.B.C").expect("lex")).expect("parse");
        let printed = print(&e);
        assert_eq!(printed, "A.B.C");
    }

    // ===== W5-89 / Phase 4.6.A part 3 — sheet-prefix printing =====

    /// Helper: parse → print → assert round-trip text matches expected.
    fn round_trip(src: &str, expected: &str) {
        let e = parse(lex(src).expect("lex")).expect("parse");
        assert_eq!(print(&e), expected, "round-trip mismatch for {src:?}");
    }

    #[test]
    fn print_unquoted_sheet_prefix_cellref() {
        round_trip("Sheet1!A1", "Sheet1!A1");
    }

    #[test]
    fn print_dotted_sheet_name_unquoted() {
        round_trip("Data.2024!B5", "Data.2024!B5");
    }

    #[test]
    fn print_dot_initial_sheet_name_is_quoted() {
        // Codex Lane A (2026-06-09): a DOT-INITIAL name is in `[A-Za-z0-9_.]` and not digit-initial,
        // so the prior rule emitted `.foo` UNQUOTED -- but the lexer starts an unquoted sheet name
        // only on `[A-Za-z_]`, so the printed `.foo!A1` would FAIL to re-lex. Quote it (the lexer
        // accepts a quoted name) to close the printer/lexer round-trip mismatch. Built via direct AST
        // because the lexer would not produce a dot-initial name unquoted at the source.
        let e = Expr::CellRef(CellAddr {
            sheet: SheetRef::Name(Arc::from(".foo")),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        assert_eq!(print(&e), "'.foo'!A1");
    }

    #[test]
    fn print_dot_initial_sheet_name_round_trips_quoted() {
        // The QUOTED source `'.foo'!B2` (name `.foo`) must print back QUOTED so it re-lexes. The
        // round-trip property parse(print(parse(src))) == parse(src) PANICS at re-lex on the prior
        // unquoted output. Also cover the degenerate `.` and a `._1`.
        round_trip("'.foo'!B2", "'.foo'!B2");
        rt_roundtrip("'.foo'!B2");
        rt_roundtrip("'.'!A1");
        rt_roundtrip("'._1'!C3");
    }

    #[test]
    fn print_underscore_initial_sheet_name_stays_unquoted() {
        // Regression guard: a `_`-initial name is a valid unquoted lexer start, so it stays unquoted
        // (the fix adds quoting only for digit-/dot-initial names). `Data.2024` is covered above.
        round_trip("_foo!A1", "_foo!A1");
        round_trip("_1.2!B2", "_1.2!B2");
    }

    #[test]
    fn print_quoted_sheet_name_with_space() {
        round_trip("'Q3 2025'!A1", "'Q3 2025'!A1");
    }

    #[test]
    fn print_quoted_sheet_name_with_escape() {
        round_trip("'Ben''s Sheet'!A1", "'Ben''s Sheet'!A1");
    }

    #[test]
    fn print_sheet_prefix_on_range() {
        round_trip("Sheet1!A1:B2", "Sheet1!A1:B2");
    }

    #[test]
    fn print_sheet_prefix_on_whole_column() {
        round_trip("Sheet1!A:A", "Sheet1!A:A");
    }

    #[test]
    fn print_sheet_prefix_on_whole_row() {
        round_trip("Sheet1!1:5", "Sheet1!1:5");
    }

    #[test]
    fn print_redundant_explicit_form_normalizes_to_single_prefix() {
        // `Sheet1!A1:Sheet1!B2` parses + normalizes; print emits single-prefix form.
        let e = parse(lex("Sheet1!A1:Sheet1!B2").expect("lex")).expect("parse");
        assert_eq!(print(&e), "Sheet1!A1:B2");
    }

    #[test]
    fn print_sheet_prefix_in_binary_expression() {
        // Printer adds canonical spaces around binary operators.
        round_trip("Sheet2!A1+1", "Sheet2!A1 + 1");
    }

    #[test]
    fn print_sheet_prefix_in_function_arg() {
        round_trip("SUM(Sheet1!A1:A10)", "SUM(Sheet1!A1:A10)");
    }

    #[test]
    fn print_sheet_prefix_preserves_absolute_markers() {
        round_trip("Sheet1!$A$1", "Sheet1!$A$1");
    }

    #[test]
    fn print_sheet_name_with_special_char_is_quoted() {
        // A sheet name containing `-` would normally need quoting because `-`
        // is not in `[A-Za-z0-9_.]`. Tested via direct AST construction
        // (the parser/lexer wouldn't produce this without quoting at the
        // source).
        let e = Expr::CellRef(CellAddr {
            sheet: SheetRef::Name(Arc::from("Sales-Q1")),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        assert_eq!(print(&e), "'Sales-Q1'!A1");
    }

    #[test]
    fn print_sheet_name_starting_with_digit_is_quoted() {
        let e = Expr::CellRef(CellAddr {
            sheet: SheetRef::Name(Arc::from("2024")),
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        assert_eq!(print(&e), "'2024'!A1");
    }

    #[test]
    fn same_sheet_ref_omits_prefix() {
        // `SheetRef::Current` MUST NOT emit a prefix.
        round_trip("A1", "A1");
        round_trip("A1:B2", "A1:B2");
    }

    // ===== W5-98 (Phase 4.7.D) — array literals + error literals =====

    #[test]
    fn print_error_literal_round_trips() {
        round_trip("#REF!", "#REF!");
        round_trip("#N/A", "#N/A");
        round_trip("#DIV/0!", "#DIV/0!");
        round_trip("#NAME?", "#NAME?");
        round_trip("#VALUE!", "#VALUE!");
        round_trip("#NUM!", "#NUM!");
        round_trip("#NULL!", "#NULL!");
        round_trip("#SPILL!", "#SPILL!");
        round_trip("#CALC!", "#CALC!");
    }

    #[test]
    fn print_error_literal_canonicalizes_case() {
        // Lexer accepts case-insensitive; printer emits canonical.
        let e = parse(lex("#ref!").expect("lex")).expect("parse");
        assert_eq!(print(&e), "#REF!");
    }

    #[test]
    fn print_array_literal_1x3() {
        round_trip("{1, 2, 3}", "{1, 2, 3}");
    }

    #[test]
    fn print_array_literal_3x1() {
        round_trip("{1; 2; 3}", "{1; 2; 3}");
    }

    #[test]
    fn print_array_literal_2x2() {
        round_trip("{1, 2; 3, 4}", "{1, 2; 3, 4}");
    }

    #[test]
    fn print_array_literal_mixed_cells() {
        round_trip("{1, TRUE, \"hi\", #N/A, -5}", "{1, TRUE, \"hi\", #N/A, -5}");
    }

    #[test]
    fn print_array_literal_as_function_arg() {
        round_trip("SUM({1, 2, 3})", "SUM({1, 2, 3})");
    }

    #[test]
    fn print_array_normalizes_whitespace() {
        // Input has extra whitespace; printer emits canonical spacing.
        let e = parse(lex("{1,2;3,4}").expect("lex")).expect("parse");
        assert_eq!(print(&e), "{1, 2; 3, 4}");
    }

    #[test]
    fn print_array_round_trip_through_parse_print_parse() {
        // The fundamental round-trip property — parse(print(parse(s))) == parse(s).
        let s = "{1, 2; 3, 4}";
        let parsed_once = parse(lex(s).expect("lex")).expect("parse");
        let printed = print(&parsed_once);
        let parsed_twice = parse(lex(&printed).expect("lex")).expect("parse");
        assert_eq!(parsed_once, parsed_twice);
    }

    // ===== W5-113 (Phase 4.8.D) — structured-reference round-trip =====

    #[test]
    fn print_sref_bare_column() {
        round_trip("Sales[Qty]", "Sales[Qty]");
    }

    #[test]
    fn print_sref_bracketed_column_canonicalizes_to_bare() {
        // Parser distinguishes BareColumn (`Sales[Qty]`) from
        // Combination(vec![Column]) (`Sales[[Qty]]`). Printer renders
        // each in its canonical form. NOT semantically normalized at
        // parse time per design § 6.2.
        let e_bare = parse(lex("Sales[Qty]").expect("lex")).expect("parse");
        assert_eq!(print(&e_bare), "Sales[Qty]");
        let e_bracketed = parse(lex("Sales[[Qty]]").expect("lex")).expect("parse");
        assert_eq!(print(&e_bracketed), "Sales[[Qty]]");
    }

    #[test]
    fn print_sref_all_5_specifiers() {
        round_trip("Sales[[#Headers]]", "Sales[[#Headers]]");
        round_trip("Sales[[#Totals]]", "Sales[[#Totals]]");
        round_trip("Sales[[#Data]]", "Sales[[#Data]]");
        round_trip("Sales[[#All]]", "Sales[[#All]]");
        round_trip("Sales[[#This Row]]", "Sales[[#This Row]]");
    }

    #[test]
    fn print_sref_special_column_combination() {
        round_trip("Sales[[#Headers], [Qty]]", "Sales[[#Headers], [Qty]]");
    }

    #[test]
    fn print_sref_column_range() {
        round_trip("Sales[[Col1]:[Col2]]", "Sales[[Col1]:[Col2]]");
    }

    #[test]
    fn print_sref_three_item_combination() {
        round_trip(
            "Sales[[#Data], [#Totals], [Col]]",
            "Sales[[#Data], [#Totals], [Col]]",
        );
    }

    #[test]
    fn print_sref_at_column_shorthand_canonicalizes_to_bracketed() {
        // `[@Col]` lexes / parses as ThisRowColumn; printer emits the
        // bracketed form `[@[Col]]` for round-trip stability (a column
        // starting with `[` or `#` would otherwise collide with the
        // bare-`@Col` shorthand).
        let e = parse(lex("Sales[@Qty]").expect("lex")).expect("parse");
        assert_eq!(print(&e), "Sales[@[Qty]]");
        // The bracketed form round-trips unchanged.
        round_trip("Sales[@[Qty]]", "Sales[@[Qty]]");
    }

    #[test]
    fn print_sref_at_column_range_round_trips() {
        round_trip("Sales[@[Col1]:[Col2]]", "Sales[@[Col1]:[Col2]]");
    }

    // ===== Escape round-trip tests (the heart of 4.8.D) =====

    /// Column name containing `[` is escaped as `'[`. Pin: lex →
    /// parse extracts unescaped `[`; print → emits with `'[` escape;
    /// re-lex → unescape back to `[`.
    #[test]
    fn print_sref_column_name_with_bracket_round_trips() {
        // Source: `Tbl['[a]` — column name is `[a`. Print emits
        // `Tbl['[a]` again (unchanged source canon).
        round_trip("Tbl['[a]", "Tbl['[a]");
    }

    #[test]
    fn print_sref_column_name_with_close_bracket_round_trips() {
        round_trip("Tbl[a']]", "Tbl[a']]");
    }

    #[test]
    fn print_sref_column_name_with_hash_round_trips() {
        // Column literally named `#Foo` (NOT the #Headers specifier).
        // Stored as Column("#Foo"); printer escapes as `'#Foo`.
        let e = parse(lex("Tbl['#Foo]").expect("lex")).expect("parse");
        match &e {
            Expr::StructuredRef { spec, .. } => match spec {
                crate::ast::TableSpecSubtree::BareColumn(name) => {
                    assert_eq!(name.as_ref(), "#Foo");
                }
                other => panic!("expected BareColumn, got {other:?}"),
            },
            other => panic!("expected StructuredRef, got {other:?}"),
        }
        let printed = print(&e);
        assert_eq!(printed, "Tbl['#Foo]");
    }

    #[test]
    fn print_sref_column_name_with_at_sign_round_trips() {
        // Column literally named `@Foo` (NOT the @Col shorthand because
        // it's in bare-column position, not after `[@`).
        round_trip("Tbl['@Foo]", "Tbl['@Foo]");
    }

    #[test]
    fn print_sref_column_name_with_apostrophe_round_trips() {
        // `Bob''s` → column name `Bob's`. Apostrophe escapes itself.
        round_trip("Tbl[Bob''s]", "Tbl[Bob''s]");
    }

    /// The fundamental property: lex → parse → print → re-lex → re-parse
    /// produces an identical AST. Pins that escape emission is lossless.
    #[test]
    fn print_sref_round_trip_through_parse_print_parse() {
        let cases = [
            "Sales[Qty]",
            "Sales[[#Headers], [Qty]]",
            "Sales[[Col1]:[Col2]]",
            "Sales[@[Qty]]",
            "Sales[@[Col1]:[Col2]]",
            "Tbl['[a]",
            "Tbl[a']]",
            "Tbl['#Foo]",
            "Tbl['@Foo]",
            "Tbl[Bob''s]",
            "SUM(Sales[Qty])",
        ];
        for src in cases {
            let once = parse(lex(src).expect("lex")).expect("parse");
            let printed = print(&once);
            let twice = parse(lex(&printed).expect("lex")).expect("parse");
            assert_eq!(
                once, twice,
                "round-trip diverged for {src:?}: printed as {printed:?}"
            );
        }
    }

    // ===================================================================
    // W5-141 (Phase 4.9.D) — print_with tests.
    //
    // Tests cover the four (mode × source-form) combinations:
    //   - A1 mode + Expr::CellRef    → existing A1 emission
    //   - A1 mode + Expr::R1C1Ref    → resolve via site, emit A1
    //   - R1C1 mode + Expr::CellRef  → emit R1C1 (rel needs site)
    //   - R1C1 mode + Expr::R1C1Ref  → emit verbatim from AxisSpec
    // Plus error paths and back-compat invariants.
    // ===================================================================

    use crate::ast::CellAddr;
    use crate::lexer::lex_with;
    use ql_types::{Address, Locale, ReferenceMode};

    fn parse_a1(src: &str) -> Expr {
        parse(lex(src).expect("lex A1")).expect("parse A1")
    }

    fn parse_r1c1(src: &str) -> Expr {
        parse(lex_with(src, ReferenceMode::R1C1, Locale::EnUs).expect("lex R1C1"))
            .expect("parse R1C1")
    }

    fn site_at(row: u32, col: u32) -> FormulaSite {
        FormulaSite::at_cell(Address { sheet: 0, row, col })
    }

    /// **Back-compat invariant.** `print(expr)` and
    /// `print_with(expr, A1, EnUs, None)` produce byte-identical output
    /// for every existing A1 AST.
    #[test]
    fn print_and_print_with_a1_en_match_for_a1_inputs() {
        for src in [
            "1 + 2",
            "SUM(A1, B2)",
            "$A$1:$B$10",
            "Sheet1!A1",
            "TRUE",
            "\"hello\"",
            "#REF!",
            "{1, 2; 3, 4}",
        ] {
            let expr = parse_a1(src);
            let legacy = print(&expr);
            let via_with = print_with(&expr, ReferenceMode::A1, Locale::EnUs, None).unwrap();
            assert_eq!(legacy, via_with, "diverged for {src:?}");
        }
    }

    /// **Codex 2026-06-09 (R1C1 under-quoting).** In R1C1 mode the lexer dispatches
    /// `R`+(`[`|digit|`C`) to the R1C1 reference lexer BEFORE the sheet-name arm, so an
    /// `R1C1`-shaped sheet name printed UNQUOTED would mis-lex (`R1C1!R3C5` would not re-lex as
    /// `SheetName("R1C1") + Bang + R1C1Ref`). It must be quoted in R1C1 mode. The SAME name is a
    /// valid unquoted A1 sheet name (no A1 ambiguity), so A1 mode leaves it unquoted. NOTE: an
    /// `R1C1`-shaped name can only appear QUOTED in R1C1 source, so the round-trip starts from the
    /// quoted source (which parses to the mode-native `R1C1Ref`, not a `CellRef`).
    #[test]
    fn print_r1c1_mode_quotes_r1c1_shaped_sheet_name() {
        let e = parse_r1c1("'R1C1'!R1C1");
        let printed = print_with(&e, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        // Pre-fix this printed `R1C1!R1C1` (unquoted) and would not re-lex.
        assert_eq!(
            printed, "'R1C1'!R1C1",
            "an R1C1-shaped sheet name must stay quoted in R1C1 mode"
        );
        assert_eq!(
            parse_r1c1(&printed),
            e,
            "the quoted R1C1-mode form round-trips"
        );
        // In A1 mode the SAME name is a valid unquoted sheet name (no A1 ambiguity) -> stays unquoted.
        let a1 = parse_a1("R1C1!A1");
        assert_eq!(
            print(&a1),
            "R1C1!A1",
            "A1 mode does not quote an R1C1-shaped name"
        );
    }

    /// Regression guard against over-quoting: an `R`-initial name whose 2nd char is NOT a
    /// `[`/digit/`C` (so the R1C1 lexer does NOT dispatch it) stays UNQUOTED even in R1C1 mode;
    /// `RC` (an `R`+`C` trigger) stays QUOTED.
    #[test]
    fn print_r1c1_mode_leaves_non_trigger_r_name_unquoted() {
        // `Roster` = `R` + `o` -> not an R1C1 trigger -> lexes + prints unquoted in R1C1 mode.
        let e = parse_r1c1("Roster!R1C1");
        let printed = print_with(&e, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        assert_eq!(
            printed, "Roster!R1C1",
            "a non-trigger R-name is not quoted in R1C1 mode"
        );
        assert_eq!(parse_r1c1(&printed), e);
        // `RC` = `R` + `C` -> trigger -> can only appear quoted, and must re-quote on print.
        let rc = parse_r1c1("'RC'!R1C1");
        let printed_rc = print_with(&rc, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        assert_eq!(
            printed_rc, "'RC'!R1C1",
            "`RC` is an R1C1 trigger -> stays quoted"
        );
        assert_eq!(parse_r1c1(&printed_rc), rc);
    }

    /// **R1C1 mode + absolute CellRef.** `$A$1` parses to
    /// `CellRef { row: 0, col: 0, abs_row: true, abs_col: true }`;
    /// printing in R1C1 mode (no site needed for absolute) → `R1C1`.
    #[test]
    fn print_with_r1c1_emits_absolute_cellref_as_r1c1() {
        let expr = parse_a1("$A$1");
        let s = print_with(&expr, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "R1C1");
    }

    /// **R1C1 mode + relative CellRef.** `A1` parses to
    /// `CellRef { row: 0, col: 0, abs_row: false, abs_col: false }`.
    /// In R1C1 mode + site at (0, 0), this emits `RC` (both axes
    /// zero relative offset → bare letters).
    #[test]
    fn print_with_r1c1_emits_relative_cellref_at_anchor_as_rc() {
        let expr = parse_a1("A1");
        let s = print_with(
            &expr,
            ReferenceMode::R1C1,
            Locale::EnUs,
            Some(site_at(0, 0)),
        )
        .unwrap();
        assert_eq!(s, "RC");
    }

    /// **R1C1 mode + relative CellRef with non-zero offset.** Anchor
    /// at (5, 5), `A1` → `R[-5]C[-5]`.
    #[test]
    fn print_with_r1c1_emits_relative_offset_brackets() {
        let expr = parse_a1("A1");
        let s = print_with(
            &expr,
            ReferenceMode::R1C1,
            Locale::EnUs,
            Some(site_at(5, 5)),
        )
        .unwrap();
        assert_eq!(s, "R[-5]C[-5]");
    }

    /// **R1C1 mode + mixed abs/rel CellRef.** `$A1` → abs col,
    /// rel row. Anchor (3, 5) → `R[-3]C1`.
    #[test]
    fn print_with_r1c1_emits_mixed_abs_rel_per_axis() {
        let expr = parse_a1("$A1");
        let s = print_with(
            &expr,
            ReferenceMode::R1C1,
            Locale::EnUs,
            Some(site_at(3, 5)),
        )
        .unwrap();
        assert_eq!(s, "R[-3]C1");
    }

    /// **R1C1 mode + relative CellRef + no site → error.**
    /// Per-design: relative R1C1 emission needs an anchor.
    #[test]
    fn print_with_r1c1_relative_without_site_errors() {
        let expr = parse_a1("A1");
        let err = print_with(&expr, ReferenceMode::R1C1, Locale::EnUs, None).unwrap_err();
        assert!(matches!(err, PrintError::R1C1RequiresAnchor));
    }

    /// **R1C1 mode + range with all absolute axes.** `$A$1:$B$10` →
    /// `R1C1:R10C2`.
    #[test]
    fn print_with_r1c1_emits_absolute_range() {
        let expr = parse_a1("$A$1:$B$10");
        let s = print_with(&expr, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "R1C1:R10C2");
    }

    /// **R1C1 mode + range with relative axes uses site.** `A1:B2`
    /// at site (0, 0) → `RC:R[1]C[1]`.
    #[test]
    fn print_with_r1c1_emits_relative_range_with_site() {
        let expr = parse_a1("A1:B2");
        let s = print_with(
            &expr,
            ReferenceMode::R1C1,
            Locale::EnUs,
            Some(site_at(0, 0)),
        )
        .unwrap();
        assert_eq!(s, "RC:R[1]C[1]");
    }

    /// **R1C1 mode + Expr::R1C1Ref emits verbatim from AxisSpec.**
    /// No anchor needed — the AxisSpec values are already correct.
    #[test]
    fn print_with_r1c1_emits_r1c1_ref_verbatim() {
        let expr = parse_r1c1("R[-1]C[2]");
        let s = print_with(&expr, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "R[-1]C[2]");
    }

    /// **R1C1 mode + Expr::R1C1Ref bare RC.** `RC` round-trips as `RC`.
    #[test]
    fn print_with_r1c1_emits_bare_rc_verbatim() {
        let expr = parse_r1c1("RC");
        let s = print_with(&expr, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "RC");
    }

    /// **A1 mode + Expr::R1C1Ref absolute resolves to A1.** `R3C5`
    /// (parsed in R1C1 mode) printed in A1 mode → `$E$3`.
    #[test]
    fn print_with_a1_emits_r1c1ref_absolute_as_dollar_a1() {
        let expr = parse_r1c1("R3C5");
        let s = print_with(&expr, ReferenceMode::A1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "$E$3");
    }

    /// **A1 mode + Expr::R1C1Ref relative requires site.** Without
    /// `site`, fails with `R1C1RequiresAnchor`.
    #[test]
    fn print_with_a1_relative_r1c1ref_without_site_errors() {
        let expr = parse_r1c1("R[-1]C[2]");
        let err = print_with(&expr, ReferenceMode::A1, Locale::EnUs, None).unwrap_err();
        assert!(matches!(err, PrintError::R1C1RequiresAnchor));
    }

    /// **A1 mode + Expr::R1C1Ref relative + site → A1 form (no `$`).**
    /// `RC` (parsed in R1C1 mode) at site (3, 3) → `D4` (no `$` —
    /// relative R1C1 ↔ non-abs A1).
    #[test]
    fn print_with_a1_relative_r1c1ref_with_site_emits_a1() {
        let expr = parse_r1c1("RC");
        let s = print_with(&expr, ReferenceMode::A1, Locale::EnUs, Some(site_at(3, 3))).unwrap();
        assert_eq!(s, "D4");
    }

    /// **A1 mode + R1C1 range absolute resolves to A1 range.**
    /// `R1C1:R10C5` (R1C1 mode) → `$A$1:$E$10` in A1 mode (no site
    /// needed for fully absolute).
    #[test]
    fn print_with_a1_emits_r1c1_range_absolute_as_a1() {
        let expr = parse_r1c1("R1C1:R10C5");
        let s = print_with(&expr, ReferenceMode::A1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "$A$1:$E$10");
    }

    /// **R1C1 round-trip through parse + print.**
    /// `lex_with(R1C1) → parse → print_with(R1C1)` for cases that
    /// don't require an anchor (i.e. R1C1Ref-based ASTs from parser).
    #[test]
    fn r1c1_round_trip_lex_parse_print() {
        for src in ["R1C1", "RC", "R[-1]C[2]", "R1C[5]", "R1C1:R10C5"] {
            let expr = parse_r1c1(src);
            let printed = print_with(&expr, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
            assert_eq!(printed, src, "round-trip diverged for {src:?}");
        }
    }

    /// **R1C1 mode + Function call composes refs correctly.**
    /// `SUM(R1C1, R[-1]C)` at no-anchor: SUM args verbatim — R1C1 abs
    /// needs no site, R[-1]C is rel but R1C1Ref-form so axis is
    /// emitted verbatim without site lookup.
    #[test]
    fn print_with_r1c1_function_composes_r1c1_refs() {
        let expr = parse_r1c1("SUM(R1C1,R[-1]C)");
        let s = print_with(&expr, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "SUM(R1C1, R[-1]C)");
    }

    /// **Mixed: A1 CellRef abs lowered to R1C1 via mode dispatch.**
    /// Defends against accidental cross-form ASTs (A1 CellRef forms
    /// after binder lowering R1C1Ref → CellRef). Printing in R1C1
    /// mode emits R1C1 form.
    #[test]
    fn print_with_r1c1_handles_absolute_cellref_post_bind() {
        // Simulate post-bind absolute CellRef (what the binder would
        // emit from `Expr::R1C1Ref { Abs(3), Abs(5) }`).
        let cell = CellAddr {
            sheet: SheetRef::Current,
            col: 4, // 0-indexed E
            row: 2, // 0-indexed row 3
            abs_col: true,
            abs_row: true,
        };
        let expr = Expr::CellRef(cell);
        let s = print_with(&expr, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "R3C5");
    }

    /// **PrintError::R1C1AxisOutOfRange surfaces on AxisSpec::Abs(0).**
    /// Direct AST construction (parser rejects via MalformedR1C1).
    #[test]
    fn print_with_a1_axisspec_abs_zero_errors_loudly() {
        let expr = Expr::R1C1Ref {
            sheet: SheetRef::Current,
            row_axis: AxisSpec::Abs(0),
            col_axis: AxisSpec::Abs(1),
        };
        let err = print_with(&expr, ReferenceMode::A1, Locale::EnUs, None).unwrap_err();
        assert!(matches!(err, PrintError::R1C1AxisOutOfRange { .. }));
    }

    /// **R1C1 mode + WholeColumn `A:A` → `C1:C1`.** Cols translated;
    /// no row axis emitted (R1C1 doesn't have a dedicated whole-col
    /// form, the C-only range is the Quantbook translation).
    #[test]
    fn print_with_r1c1_whole_column_emits_col_only_range() {
        let expr = parse_a1("$A:$B");
        let s = print_with(&expr, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "C1:C2");
    }

    /// **R1C1 mode + WholeRow `1:5` (abs) → `R1:R5`.**
    #[test]
    fn print_with_r1c1_whole_row_emits_row_only_range() {
        let expr = parse_a1("$1:$5");
        let s = print_with(&expr, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "R1:R5");
    }

    // ===================================================================
    // W5-142 (Phase 4.9.F) — locale-aware print_with tests.
    //
    // Three locale-affected emission sites:
    //   1. Number decimal separator (print_number_with_locale).
    //   2. Function-call argument separator.
    //   3. Array literal row + col separators.
    //
    // Per locale table (matches the lexer-side W5-138 tables):
    //   EN: arg=`,`  decimal=`.`  row=`;`  col=`,`
    //   DE: arg=`;`  decimal=`,`  row=`.`  col=`\\`
    //   FR: same as DE
    // ===================================================================

    /// **DE: decimal in number literal uses `,`.** `2.5` parses in
    /// A1+EN, prints in A1+DE as `2,5`.
    #[test]
    fn print_with_de_locale_uses_comma_for_decimal() {
        let expr = parse_a1("2.5");
        let s = print_with(&expr, ReferenceMode::A1, Locale::De, None).unwrap();
        assert_eq!(s, "2,5");
    }

    /// **DE: integer-valued numbers have no decimal — no glyph
    /// affected.** `42` in DE → `42` (no separator emitted at all).
    #[test]
    fn print_with_de_locale_integer_unchanged() {
        let expr = parse_a1("42");
        let s = print_with(&expr, ReferenceMode::A1, Locale::De, None).unwrap();
        assert_eq!(s, "42");
    }

    /// **FR: matches DE (per design § 3.2).** Same decimal glyph.
    #[test]
    fn print_with_fr_locale_uses_comma_for_decimal() {
        let expr = parse_a1("3.14");
        let s = print_with(&expr, ReferenceMode::A1, Locale::Fr, None).unwrap();
        assert_eq!(s, "3,14");
    }

    /// **DE: function argument separator is `;`.** `SUM(A1, B2)` in
    /// EN → `SUM(A1; B2)` in DE. EN's `,` arg → DE's `;`.
    #[test]
    fn print_with_de_locale_uses_semicolon_for_function_args() {
        let expr = parse_a1("SUM(A1, B2)");
        let s = print_with(&expr, ReferenceMode::A1, Locale::De, None).unwrap();
        assert_eq!(s, "SUM(A1; B2)");
    }

    /// **EN: function argument separator stays `,`.** Sanity that
    /// EN doesn't drift from pre-W5-142 behavior.
    #[test]
    fn print_with_en_locale_function_args_stay_comma() {
        let expr = parse_a1("SUM(A1, B2)");
        let s = print_with(&expr, ReferenceMode::A1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "SUM(A1, B2)");
    }

    /// **DE: array row sep = `.`, col sep = `\\`.** `{1, 2; 3, 4}` in
    /// EN → `{1\ 2. 3\ 4}` in DE (EN canonical printer adds spaces
    /// after each separator).
    #[test]
    fn print_with_de_locale_array_uses_backslash_and_dot() {
        let expr = parse_a1("{1, 2; 3, 4}");
        let s = print_with(&expr, ReferenceMode::A1, Locale::De, None).unwrap();
        assert_eq!(s, "{1\\ 2. 3\\ 4}");
    }

    /// **EN: array separators stay `,` / `;`.** Sanity backstop.
    #[test]
    fn print_with_en_locale_array_stays_comma_semicolon() {
        let expr = parse_a1("{1, 2; 3, 4}");
        let s = print_with(&expr, ReferenceMode::A1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "{1, 2; 3, 4}");
    }

    /// **DE: number + arg sep + array sep compose.**
    /// `SUM(2.5, 3.5)` in EN → `SUM(2,5; 3,5)` in DE.
    #[test]
    fn print_with_de_locale_compound_function_and_decimals() {
        let expr = parse_a1("SUM(2.5, 3.5)");
        let s = print_with(&expr, ReferenceMode::A1, Locale::De, None).unwrap();
        assert_eq!(s, "SUM(2,5; 3,5)");
    }

    /// **DE: array with decimals.** `{1.5, 2.5}` → `{1,5\ 2,5}`.
    /// Validates that the decimal swap and array col-sep swap don't
    /// collide (DE col-sep is `\\`, not `,` — but the lexer's
    /// pre-dispatch maps `,` inside a number to decimal, so this is
    /// unambiguous on the parse side too).
    #[test]
    fn print_with_de_locale_array_with_decimals() {
        let expr = parse_a1("{1.5, 2.5}");
        let s = print_with(&expr, ReferenceMode::A1, Locale::De, None).unwrap();
        assert_eq!(s, "{1,5\\ 2,5}");
    }

    /// **EN ↔ DE round-trip via lex_with + parse + print_with.**
    /// Source `SUM(2,5; 3,5)` in DE locale → tokens → AST → DE print
    /// → same source text (modulo formatter spaces).
    #[test]
    fn print_with_de_round_trip_through_lex_parse() {
        use crate::lexer::lex_with;
        let tokens = lex_with("SUM(2,5; 3,5)", ReferenceMode::A1, Locale::De).expect("lex DE");
        let expr = parse(tokens).expect("parse DE tokens");
        let printed = print_with(&expr, ReferenceMode::A1, Locale::De, None).unwrap();
        assert_eq!(printed, "SUM(2,5; 3,5)");
    }

    /// **DE + R1C1 mode compose.** Both axes orthogonal: mode controls
    /// ref form, locale controls separator glyphs. `SUM(R1C1, R2C2)`
    /// in R1C1+DE → `SUM(R1C1; R2C2)`.
    #[test]
    fn print_with_r1c1_de_combines_correctly() {
        let expr = parse_r1c1("SUM(R1C1,R2C2)");
        let s = print_with(&expr, ReferenceMode::R1C1, Locale::De, None).unwrap();
        assert_eq!(s, "SUM(R1C1; R2C2)");
    }

    /// **DE scientific-notation numbers preserve `e`.** `1e10` is
    /// integer-valued (1e10 == 10000000000) so emits no separator
    /// at all. Sanity that we don't accidentally inject locale glyph
    /// when there's no decimal in the formatted output.
    #[test]
    fn print_with_de_locale_scientific_integer() {
        let expr = parse_a1("1e10");
        let s = print_with(&expr, ReferenceMode::A1, Locale::De, None).unwrap();
        assert_eq!(s, "10000000000");
    }

    /// **DE scientific with fractional mantissa.** `1.5e3` = 1500
    /// (integer); test a true fractional like `0.00001` to force the
    /// `{n}` non-integer branch. Rust's f64 Display emits this as
    /// `0.00001` — locale swap yields `0,00001`.
    #[test]
    fn print_with_de_locale_small_fraction() {
        let expr = parse_a1("0.00001");
        let s = print_with(&expr, ReferenceMode::A1, Locale::De, None).unwrap();
        assert_eq!(s, "0,00001");
    }

    /// **EN print remains decimal-`.` after locale plumbing.** Round
    /// out coverage: confirms no accidental EN drift.
    #[test]
    fn print_with_en_locale_decimal_stays_dot() {
        let expr = parse_a1("2.5");
        let s = print_with(&expr, ReferenceMode::A1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "2.5");
    }

    // ===================================================================
    // W5-143 (Phase 4.9.G) — implicit-intersection (`@`) printer tests.
    // ===================================================================

    /// **`@A1` round-trips.**
    #[test]
    fn at_cellref_round_trips() {
        let expr = parse_a1("@A1");
        let s = print(&expr);
        assert_eq!(s, "@A1");
        // Idempotent through re-parse:
        assert_eq!(parse_a1(&s), expr);
    }

    /// **`@A:A` round-trips as `@A:A`.** Range binds tighter than `@`.
    #[test]
    fn at_whole_column_round_trips() {
        let expr = parse_a1("@A:A");
        let s = print(&expr);
        assert_eq!(s, "@A:A");
    }

    /// **`@SUM(...)` round-trips.**
    #[test]
    fn at_function_call_round_trips() {
        let expr = parse_a1("@SUM(A1, B2)");
        let s = print(&expr);
        assert_eq!(s, "@SUM(A1, B2)");
    }

    /// **`Sheet1!@A1` round-trips with sheet attached to inner.**
    /// The printer emits `@Sheet1!A1` (canonical form: `@` first,
    /// inner CellRef carries its own sheet prefix). The AST is
    /// identical to that of `Sheet1!@A1` (Excel accepts both
    /// orderings), so the semantic round-trip property
    /// `parse(print(parse(x))) == parse(x)` holds.
    #[test]
    fn sheet_at_cellref_round_trips_via_ast() {
        let expr1 = parse_a1("Sheet1!@A1");
        let printed = print(&expr1);
        let expr2 = parse_a1(&printed);
        assert_eq!(expr1, expr2);
        // Confirm both source-order variants parse identically too.
        let expr3 = parse_a1("@Sheet1!A1");
        assert_eq!(expr1, expr3);
    }

    /// **`SUM(@A1, B2)` round-trips with @ inside arg.**
    #[test]
    fn at_inside_function_arg_round_trips() {
        let expr = parse_a1("SUM(@A1, B2)");
        let s = print(&expr);
        assert_eq!(s, "SUM(@A1, B2)");
    }

    /// **`@@A1` — nested wrap round-trips.**
    #[test]
    fn nested_at_round_trips() {
        let expr = parse_a1("@@A1");
        let s = print(&expr);
        assert_eq!(s, "@@A1");
    }

    /// **R1C1 mode prints `@` identically.** Mode affects ref form,
    /// not the `@` operator itself.
    #[test]
    fn at_under_r1c1_mode_emits_at_plus_r1c1_ref() {
        let expr = parse_r1c1("@R1C1");
        let s = print_with(&expr, ReferenceMode::R1C1, Locale::EnUs, None).unwrap();
        assert_eq!(s, "@R1C1");
    }

    /// **DE locale prints `@` identically — `@` is not locale-configurable.**
    /// (Closes Sonnet H-5 by construction; `@` is invariant across locales.)
    #[test]
    fn at_under_de_locale_emits_at_unchanged() {
        let expr = parse_a1("@A1");
        let s = print_with(&expr, ReferenceMode::A1, Locale::De, None).unwrap();
        assert_eq!(s, "@A1");
    }
}

//! Formula fingerprint — `fn fingerprint(&Expr) -> u64` for FormulaRegionNode memoization.
//!
//! Per spec Part V §4 Week 3 Day 3-4. The fingerprint is what lets `FormulaRegionNode`
//! collapse N cells with the same formula into ONE graph node: at region construction
//! time, the binder fingerprints each cell's formula `Expr` and groups cells with
//! identical fingerprints. Two cells share a node iff their fingerprints match.
//!
//! ## Why not derive `Hash` on `Expr`?
//!
//! `Expr::Number(f64)` doesn't `Hash` — Rust's stdlib refuses to derive `Hash` on `f64`
//! because of the NaN/Inf weirdness (`NaN != NaN` would break the hash-equality contract).
//! Hand-writing the hash lets us:
//!
//! 1. Use `f64::to_bits()` to coerce numeric literals to a `u64` and hash that — any two
//!    `Number(n)` values with the same bit pattern (which is the canonical comparison the
//!    `ql-types::Value::number` sanitizer enforces, since NaN/Inf are rejected at
//!    construction) produce the same fingerprint.
//!
//! 2. Hash `Arc<str>` by CONTENT, not pointer identity. Two `Arc<str>::from("SUM")`
//!    instances must fingerprint identically — otherwise FormulaRegionNode dedup is
//!    broken every time the parser allocates a fresh Arc.
//!
//! 3. Include variant discriminants explicitly so different variants with the "same"
//!    payload (e.g. `Number(0.0)` vs `Bool(false)`) don't collide.
//!
//! ## Hasher choice
//!
//! Uses `std::collections::hash_map::DefaultHasher` (SipHash-1-3) from stdlib. No new
//! workspace dep. `ahash` is in our Cargo.lock via Arrow's transitive but bringing it in
//! at the workspace level for an ~0.1× speedup on tiny payloads (sub-microsecond
//! fingerprinting) doesn't earn its place; revisit if profiling shows the fingerprint
//! is a hot path.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use ql_formula_syntax::Expr;

/// Compute a 64-bit fingerprint of a formula expression. Two `Expr`s that compare equal
/// (per `Expr: PartialEq`) — modulo Arc<str> identity-vs-content differences and f64
/// NaN-bit-pattern ambiguity — produce identical fingerprints.
///
/// Used by `FormulaRegionNode` to detect "these N cells all have the same formula" at
/// region construction time. Phase 0 doesn't memoize aggregate values (CORR-22 deferred
/// HF-style RangeVertex caching to Phase 4+); the fingerprint is purely for cell-grouping.
pub fn fingerprint(expr: &Expr) -> u64 {
    let mut h = DefaultHasher::new();
    hash_expr(expr, &mut h);
    h.finish()
}

fn hash_expr(expr: &Expr, h: &mut impl Hasher) {
    // Variant tag bytes are explicit: the discriminant of an enum isn't stable across
    // recompiles, and we want fingerprints to be stable for a given source-formula across
    // engine versions. The byte values are arbitrary but locked.
    match expr {
        Expr::Number(n) => {
            0u8.hash(h);
            n.to_bits().hash(h);
        }
        Expr::String(s) => {
            1u8.hash(h);
            // `Arc<str>` derefs to `&str`; hash by content (the stdlib `str` impl hashes
            // bytes + a length prefix). Arc identity does NOT affect the fingerprint.
            s.as_ref().hash(h);
        }
        Expr::Bool(b) => {
            2u8.hash(h);
            b.hash(h);
        }
        Expr::CellRef(addr) => {
            3u8.hash(h);
            // `CellAddr` derives `Hash` (verified in ql-formula-syntax/src/ast.rs).
            addr.hash(h);
        }
        Expr::RangeRef(r) => {
            4u8.hash(h);
            // `RangeRef` derives `Hash`.
            r.hash(h);
        }
        Expr::Binary { op, lhs, rhs } => {
            5u8.hash(h);
            // `Operator` derives `Hash`.
            op.hash(h);
            hash_expr(lhs, h);
            hash_expr(rhs, h);
        }
        Expr::Unary { op, operand } => {
            6u8.hash(h);
            op.hash(h);
            hash_expr(operand, h);
        }
        Expr::Function { name, args } => {
            7u8.hash(h);
            // Function name normalization is the parser's job (uppercase per Excel
            // canon); the fingerprint hashes whatever was actually stored. Two
            // distinct-cased `Arc<str>::from("SUM")` vs `Arc<str>::from("sum")` will
            // fingerprint differently — that's a parser-level invariant problem if it
            // ever happens.
            name.as_ref().hash(h);
            for arg in args {
                hash_expr(arg, h);
            }
            // Argument count: `f(a, b)` and `f(a, b, c)` must fingerprint differently
            // even when the first two args match. Without the explicit length, a
            // `Function { name, args: [a, b] }` could collide with `Function { name,
            // args: [a, b, junk] }` if `junk` hashed to zero bytes (unlikely but the
            // length-suffix is cheap insurance).
            args.len().hash(h);
        }
        Expr::Array(rows) => {
            8u8.hash(h);
            for row in rows {
                for cell in row {
                    hash_expr(cell, h);
                }
                row.len().hash(h);
            }
            rows.len().hash(h);
        }
        Expr::Spill(inner) => {
            9u8.hash(h);
            hash_expr(inner, h);
        }
        Expr::NameRef(name) => {
            // Phase 2A.1: defined-name reference. Hash by content (Arc-identity
            // independence) so two cells with the same name fingerprint identically.
            10u8.hash(h);
            name.as_ref().hash(h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_formula_syntax::{CellAddr, Expr, Operator, RangeRef};
    use std::sync::Arc;

    fn num(n: f64) -> Expr {
        Expr::Number(n)
    }

    fn cell(col: u32, row: u32) -> Expr {
        Expr::CellRef(CellAddr {
            sheet: None,
            col,
            row,
            abs_col: false,
            abs_row: false,
        })
    }

    #[test]
    fn same_expr_same_fingerprint() {
        let a = num(42.0);
        let b = num(42.0);
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn different_numbers_different_fingerprints() {
        // Very high probability — SipHash collision is ~2^-64.
        assert_ne!(fingerprint(&num(0.0)), fingerprint(&num(1.0)));
        assert_ne!(fingerprint(&num(1.0)), fingerprint(&num(1.1)));
        assert_ne!(
            fingerprint(&num(f64::MIN_POSITIVE)),
            fingerprint(&num(f64::MAX))
        );
    }

    #[test]
    fn arc_str_content_not_identity() {
        // Two separately-allocated Arc<str>s with the same content must fingerprint
        // identically — otherwise FormulaRegionNode dedup fails on every parser run.
        let a = Expr::String(Arc::from("hello"));
        let b = Expr::String(Arc::from("hello"));
        // Sanity check: they ARE different Arc instances.
        if let (Expr::String(sa), Expr::String(sb)) = (&a, &b) {
            assert!(!Arc::ptr_eq(sa, sb), "test assumes fresh Arc allocations");
        }
        assert_eq!(fingerprint(&a), fingerprint(&b));
    }

    #[test]
    fn variant_tags_disambiguate_payload_collisions() {
        // Number(0.0) and Bool(false) and the "zero" payload of various other variants
        // must not collide on the wire. Explicit variant tags in `hash_expr` enforce this.
        let n = num(0.0);
        let b = Expr::Bool(false);
        assert_ne!(fingerprint(&n), fingerprint(&b));
    }

    #[test]
    fn cellref_addr_round_trips() {
        let a = cell(0, 0);
        let b = cell(0, 0);
        let c = cell(0, 1);
        let d = cell(1, 0);
        assert_eq!(fingerprint(&a), fingerprint(&b));
        assert_ne!(fingerprint(&a), fingerprint(&c));
        assert_ne!(fingerprint(&a), fingerprint(&d));
    }

    #[test]
    fn cellref_absolute_flags_matter() {
        let relative = Expr::CellRef(CellAddr {
            sheet: None,
            col: 0,
            row: 0,
            abs_col: false,
            abs_row: false,
        });
        let abs_col = Expr::CellRef(CellAddr {
            sheet: None,
            col: 0,
            row: 0,
            abs_col: true,
            abs_row: false,
        });
        // `$A1` vs `A1` MUST fingerprint differently — they bind differently when copied
        // (relative refs adjust, absolute don't).
        assert_ne!(fingerprint(&relative), fingerprint(&abs_col));
    }

    #[test]
    fn binary_operator_matters() {
        // A1 + B1 vs A1 * B1: same operands, different op.
        let plus = Expr::Binary {
            op: Operator::Plus,
            lhs: Box::new(cell(0, 0)),
            rhs: Box::new(cell(1, 0)),
        };
        let times = Expr::Binary {
            op: Operator::Mul,
            lhs: Box::new(cell(0, 0)),
            rhs: Box::new(cell(1, 0)),
        };
        assert_ne!(fingerprint(&plus), fingerprint(&times));
    }

    #[test]
    fn binary_operand_order_matters() {
        // A1 + B1 vs B1 + A1: + is commutative arithmetically but the AST is ordered.
        // The fingerprint hashes structurally, NOT semantically. Two formulas the user
        // wrote differently are two different fingerprints.
        let ab = Expr::Binary {
            op: Operator::Plus,
            lhs: Box::new(cell(0, 0)),
            rhs: Box::new(cell(1, 0)),
        };
        let ba = Expr::Binary {
            op: Operator::Plus,
            lhs: Box::new(cell(1, 0)),
            rhs: Box::new(cell(0, 0)),
        };
        assert_ne!(fingerprint(&ab), fingerprint(&ba));
    }

    #[test]
    fn function_arg_count_matters() {
        let sum_one = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![cell(0, 0)],
        };
        let sum_two = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![cell(0, 0), cell(0, 1)],
        };
        assert_ne!(fingerprint(&sum_one), fingerprint(&sum_two));
    }

    #[test]
    fn function_arg_order_matters() {
        let sum_ab = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![cell(0, 0), cell(0, 1)],
        };
        let sum_ba = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![cell(0, 1), cell(0, 0)],
        };
        assert_ne!(fingerprint(&sum_ab), fingerprint(&sum_ba));
    }

    #[test]
    fn function_name_case_matters() {
        // Parser should uppercase function names per Excel canon. If two Exprs differ
        // only in name case, they fingerprint differently — surfaces the parser
        // invariant violation if it ever happens.
        let upper = Expr::Function {
            name: Arc::from("SUM"),
            args: vec![cell(0, 0)],
        };
        let lower = Expr::Function {
            name: Arc::from("sum"),
            args: vec![cell(0, 0)],
        };
        assert_ne!(fingerprint(&upper), fingerprint(&lower));
    }

    #[test]
    fn nested_binary_deterministic() {
        // (A1 + B1) * C1 — deep nesting. Should be deterministic across calls.
        let inner_plus = Expr::Binary {
            op: Operator::Plus,
            lhs: Box::new(cell(0, 0)),
            rhs: Box::new(cell(1, 0)),
        };
        let outer = Expr::Binary {
            op: Operator::Mul,
            lhs: Box::new(inner_plus.clone()),
            rhs: Box::new(cell(2, 0)),
        };
        let outer_dup = Expr::Binary {
            op: Operator::Mul,
            lhs: Box::new(inner_plus),
            rhs: Box::new(cell(2, 0)),
        };
        assert_eq!(fingerprint(&outer), fingerprint(&outer_dup));
    }

    #[test]
    fn rangeref_variants_distinguish() {
        let cells = Expr::RangeRef(RangeRef::Cells {
            sheet: None,
            start_col: 0,
            start_row: 0,
            end_col: 0,
            end_row: 9,
            abs_start_col: false,
            abs_start_row: false,
            abs_end_col: false,
            abs_end_row: false,
        });
        let whole_col = Expr::RangeRef(RangeRef::WholeColumn {
            sheet: None,
            start_col: 0,
            end_col: 0,
            abs_start: false,
            abs_end: false,
        });
        let whole_row = Expr::RangeRef(RangeRef::WholeRow {
            sheet: None,
            start_row: 0,
            end_row: 0,
            abs_start: false,
            abs_end: false,
        });
        // All three reference single-cell-equivalent things but the variant shape differs;
        // fingerprints must differ.
        let f_cells = fingerprint(&cells);
        let f_col = fingerprint(&whole_col);
        let f_row = fingerprint(&whole_row);
        assert_ne!(f_cells, f_col);
        assert_ne!(f_cells, f_row);
        assert_ne!(f_col, f_row);
    }

    #[test]
    fn formula_region_use_case_n_cells_with_same_formula() {
        // The Quantbook bet: column B has 1000 cells, each `=A_n * 2` for its own row.
        // EACH cell's binder produces its own Expr where the CellRef differs in `row`.
        // So fingerprints differ across the 1000 cells — meaning they DON'T share a
        // FormulaRegionNode in the naive sense.
        //
        // The "same formula" criterion for region grouping is therefore "same *structure*
        // after the row index is parameterized." That parameterization is the binder's
        // job, not the fingerprint's. The fingerprint reports raw structural equality.
        let f1 = fingerprint(&Expr::Binary {
            op: Operator::Mul,
            lhs: Box::new(cell(0, 0)),
            rhs: Box::new(num(2.0)),
        });
        let f2 = fingerprint(&Expr::Binary {
            op: Operator::Mul,
            lhs: Box::new(cell(0, 1)), // row differs
            rhs: Box::new(num(2.0)),
        });
        assert_ne!(f1, f2);
        // But: two cells whose binder produced literally the same Expr (e.g. both
        // referencing `$A$1 * 2`) DO share fingerprints:
        let abs = Expr::CellRef(CellAddr {
            sheet: None,
            col: 0,
            row: 0,
            abs_col: true,
            abs_row: true,
        });
        let g1 = fingerprint(&Expr::Binary {
            op: Operator::Mul,
            lhs: Box::new(abs.clone()),
            rhs: Box::new(num(2.0)),
        });
        let g2 = fingerprint(&Expr::Binary {
            op: Operator::Mul,
            lhs: Box::new(abs),
            rhs: Box::new(num(2.0)),
        });
        assert_eq!(g1, g2);
    }

    #[test]
    fn nan_bit_pattern_handled_without_panic() {
        // Phase 0 lexer rejects NaN/Inf at parse time (Value::number sanitizer); the
        // fingerprint MUST still handle a NaN that sneaks in (e.g. a constructed-via-
        // unit-test Expr::Number(NaN)). f64::to_bits is total; no panic.
        let n = num(f64::NAN);
        let _ = fingerprint(&n); // doesn't panic
                                 // Different NaN bit-patterns may fingerprint differently; that's not a contract
                                 // violation since NaN never arrives in production (lexer rejection). Just verify
                                 // no panic + the function is total.
        let inf = num(f64::INFINITY);
        let _ = fingerprint(&inf);
        let neg_inf = num(f64::NEG_INFINITY);
        let _ = fingerprint(&neg_inf);
    }
}

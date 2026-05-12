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
//! ## Hasher choice (Phase 2A.10 audit H3/M14)
//!
//! Uses `siphasher::sip::SipHasher24` with a fixed all-zeros seed
//! (`[0u8; 16]`). The seed pins the algorithm version so fingerprints are
//! deterministic across:
//!
//! 1. Repeated runs on the same binary (was: also true with stdlib
//!    `DefaultHasher` since it doesn't re-seed per process).
//! 2. Different builds of the engine on the same Rust toolchain (was: also
//!    true in practice but not contractually guaranteed by stdlib).
//! 3. **Different Rust toolchain versions** (this is the new guarantee). Rust
//!    explicitly does NOT contractually fix the algorithm behind
//!    `DefaultHasher`. A future toolchain bump could silently invalidate any
//!    persisted fingerprint cache. `siphasher` pins the algorithm contract.
//!
//! `siphasher` ships a no-std SipHash-2-4 implementation that's been stable
//! since 1.0.0. ~800 MB/s on commodity hardware, plenty for our use case
//! (fingerprints are not in the hot path). No new transitive deps; clean
//! cargo-audit.
//!
//! ### Operator / RangeRef hash hardening (audit M14)
//!
//! Operator and RangeRef in ql-formula-syntax derive Hash. The derived
//! impl writes the auto-assigned variant discriminant byte, which the
//! compiler MAY reorder if the source declaration changes. Stability is
//! achieved by ordering: a `golden_fingerprints_locked` test pins ~20
//! `(Expr, u64)` pairs covering each major variant; any algorithm change
//! OR discriminant reordering trips it. This is the early-warning system
//! the prior implementation lacked.
//!
//! ### Rotating the seed
//!
//! If a future audit discovers a collision pattern that warrants algorithm
//! rotation, change `FINGERPRINT_SEED` and regenerate the golden test
//! fixtures via a one-shot helper documented in the test file. Persisted
//! caches (Engine Phase 3+ calcgraph integration) MUST then bump their own
//! schema version.

use std::hash::{Hash, Hasher};

use ql_formula_syntax::Expr;
use siphasher::sip::SipHasher24;

/// Phase 2A.10 audit H3: the fixed seed pins the SipHash-2-4 algorithm
/// version. Pair of u64 keys matches `SipHasher24::new_with_keys(k0, k1)`.
const FINGERPRINT_SEED_K0: u64 = 0x0000_0000_0000_0000;
const FINGERPRINT_SEED_K1: u64 = 0x0000_0000_0000_0000;

/// Compute a 64-bit fingerprint of a formula expression. Two `Expr`s that compare equal
/// (per `Expr: PartialEq`) — modulo Arc<str> identity-vs-content differences and f64
/// NaN-bit-pattern ambiguity — produce identical fingerprints.
///
/// Used by `FormulaRegionNode` to detect "these N cells all have the same formula" at
/// region construction time. Phase 0 doesn't memoize aggregate values (CORR-22 deferred
/// HF-style RangeVertex caching to Phase 4+); the fingerprint is purely for cell-grouping.
pub fn fingerprint(expr: &Expr) -> u64 {
    let mut h = SipHasher24::new_with_keys(FINGERPRINT_SEED_K0, FINGERPRINT_SEED_K1);
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
            // Phase 2A.10 audit M14: hash CellAddr field-by-field with
            // explicit per-field bytes so the fingerprint doesn't depend on
            // the derived Hash for Option<SheetId> (which writes a
            // discriminant byte for None vs Some).
            hash_cell_addr(addr, h);
        }
        Expr::RangeRef(r) => {
            4u8.hash(h);
            // Phase 2A.10 audit M14: explicit per-variant tag bytes for
            // RangeRef. Derived Hash would auto-assign discriminants
            // (Cells=0, WholeColumn=1, WholeRow=2) based on source order;
            // explicit tags make the fingerprint immune to source reorders.
            hash_range_ref(r, h);
        }
        Expr::Binary { op, lhs, rhs } => {
            5u8.hash(h);
            hash_operator(op, h);
            hash_expr(lhs, h);
            hash_expr(rhs, h);
        }
        Expr::Unary { op, operand } => {
            6u8.hash(h);
            hash_operator(op, h);
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

/// Phase 2A.10 audit M14: explicit per-variant tag bytes for `Operator`. The
/// derived `Hash` impl writes the auto-assigned discriminant, which the
/// compiler can reorder if the source order changes. These tags are pinned so
/// the fingerprint is immune to that drift. The golden-fingerprints test
/// catches any accidental remapping.
fn hash_operator(op: &ql_formula_syntax::Operator, h: &mut impl Hasher) {
    use ql_formula_syntax::Operator;
    let tag: u8 = match op {
        Operator::Plus => 0x10,
        Operator::Minus => 0x11,
        Operator::Mul => 0x12,
        Operator::Div => 0x13,
        Operator::Percent => 0x14,
        Operator::Pow => 0x15,
        Operator::Concat => 0x16,
        Operator::Eq => 0x17,
        Operator::Neq => 0x18,
        Operator::Lt => 0x19,
        Operator::Le => 0x1A,
        Operator::Gt => 0x1B,
        Operator::Ge => 0x1C,
    };
    tag.hash(h);
}

/// Phase 2A.10 audit M14: explicit field-by-field hashing for `CellAddr`,
/// including an explicit Option-tag for the `sheet` field. Avoids depending
/// on Option<T>'s derived Hash which writes a None/Some discriminant byte.
fn hash_cell_addr(addr: &ql_formula_syntax::CellAddr, h: &mut impl Hasher) {
    match addr.sheet {
        None => 0u8.hash(h),
        Some(s) => {
            1u8.hash(h);
            s.hash(h);
        }
    }
    addr.col.hash(h);
    addr.row.hash(h);
    addr.abs_col.hash(h);
    addr.abs_row.hash(h);
}

/// Phase 2A.10 audit M14: explicit per-variant tag + field hashing for
/// `RangeRef`. The three variants (Cells, WholeColumn, WholeRow) get
/// distinct tag bytes. Within each variant, fields hash in a fixed
/// canonical order — including explicit Option-tags for `sheet`.
fn hash_range_ref(r: &ql_formula_syntax::RangeRef, h: &mut impl Hasher) {
    use ql_formula_syntax::RangeRef;
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
            0x20u8.hash(h);
            hash_option_sheet(sheet, h);
            start_col.hash(h);
            start_row.hash(h);
            end_col.hash(h);
            end_row.hash(h);
            abs_start_col.hash(h);
            abs_start_row.hash(h);
            abs_end_col.hash(h);
            abs_end_row.hash(h);
        }
        RangeRef::WholeColumn {
            sheet,
            start_col,
            end_col,
            abs_start,
            abs_end,
        } => {
            0x21u8.hash(h);
            hash_option_sheet(sheet, h);
            start_col.hash(h);
            end_col.hash(h);
            abs_start.hash(h);
            abs_end.hash(h);
        }
        RangeRef::WholeRow {
            sheet,
            start_row,
            end_row,
            abs_start,
            abs_end,
        } => {
            0x22u8.hash(h);
            hash_option_sheet(sheet, h);
            start_row.hash(h);
            end_row.hash(h);
            abs_start.hash(h);
            abs_end.hash(h);
        }
    }
}

fn hash_option_sheet(s: &Option<ql_types::SheetId>, h: &mut impl Hasher) {
    match s {
        None => 0u8.hash(h),
        Some(sheet) => {
            1u8.hash(h);
            sheet.hash(h);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_formula_syntax::{CellAddr, Expr, Operator, RangeRef};
    use std::sync::Arc;

    /// Phase 2A.10 audit H3/M14: golden fingerprint values pinned for the
    /// SipHash-2-4 algorithm with seed `(0, 0)` + the explicit-byte tagging
    /// established in this module. Any algorithm change OR variant
    /// discriminant remap trips this test.
    ///
    /// # Regenerating
    ///
    /// If a seed rotation or algorithm change is intentional:
    /// 1. Set every value below to `0`.
    /// 2. Run `cargo test golden_fingerprints_locked -- --nocapture` —
    ///    the test will fail and print the actual fingerprints via the
    ///    helper `print_golden_for_regeneration`.
    /// 3. Paste the printed values back into the array.
    /// 4. Bump any persisted-fingerprint schema version (Engine Phase 3+
    ///    calcgraph cache layer; see `docs/MASTER-PLAN.md` Phase 3.6).
    #[test]
    fn golden_fingerprints_locked() {
        let goldens: &[(&str, Expr, u64)] = &[
            ("Number(0.0)", Expr::Number(0.0), 0x2D50_8CD2_0C8F_0CEF),
            ("Number(1.0)", Expr::Number(1.0), 0x5302_6EAB_44F1_4041),
            ("Number(42.0)", Expr::Number(42.0), 0x9EDF_EEAE_63FC_8FFB),
            ("Bool(true)", Expr::Bool(true), 0xF81A_A5F7_E3B2_AB95),
            ("Bool(false)", Expr::Bool(false), 0xAC26_F227_9B59_E6BF),
            (
                r#"String("hello")"#,
                Expr::String(Arc::from("hello")),
                0xB2E9_1EC8_A3D8_04C0,
            ),
            (
                "CellRef(sheet=None, col=0, row=0)",
                Expr::CellRef(CellAddr {
                    sheet: None,
                    col: 0,
                    row: 0,
                    abs_col: false,
                    abs_row: false,
                }),
                0x9CB6_B28F_190F_7F83,
            ),
            (
                "CellRef abs A$1",
                Expr::CellRef(CellAddr {
                    sheet: None,
                    col: 0,
                    row: 0,
                    abs_col: false,
                    abs_row: true,
                }),
                0x81CF_1A50_E71C_A56C,
            ),
            (
                "RangeRef::WholeColumn A:A",
                Expr::RangeRef(RangeRef::WholeColumn {
                    sheet: None,
                    start_col: 0,
                    end_col: 0,
                    abs_start: false,
                    abs_end: false,
                }),
                0xC33C_9A45_502E_25EF,
            ),
            (
                "RangeRef::WholeRow 1:1",
                Expr::RangeRef(RangeRef::WholeRow {
                    sheet: None,
                    start_row: 0,
                    end_row: 0,
                    abs_start: false,
                    abs_end: false,
                }),
                0xC572_A637_808D_D76E,
            ),
            (
                "Binary(Plus, 1, 2)",
                Expr::Binary {
                    op: Operator::Plus,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                },
                0x234E_5D5D_93D2_3BD5,
            ),
            (
                "Binary(Mul, 1, 2)",
                Expr::Binary {
                    op: Operator::Mul,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                },
                0x28B8_19E9_C094_B7CE,
            ),
            (
                "Unary(Minus, 5)",
                Expr::Unary {
                    op: Operator::Minus,
                    operand: Box::new(Expr::Number(5.0)),
                },
                0x57FE_2ACA_8143_B937,
            ),
            (
                "Function SUM(1, 2)",
                Expr::Function {
                    name: Arc::from("SUM"),
                    args: vec![Expr::Number(1.0), Expr::Number(2.0)],
                },
                0x3B14_BA4C_BE5D_2E5B,
            ),
            (
                "NameRef(TAXRATE)",
                Expr::NameRef(Arc::from("TAXRATE")),
                0x5D19_7ECD_43FB_F118,
            ),
            // Phase 2A.13 audit cycle-3 H3: extended coverage. One golden per
            // Operator variant (we already had Plus, Mul, Minus above), plus
            // RangeRef::Cells, CellAddr-with-Some(sheet), Expr::Array, and
            // Expr::Spill. Catches any reorder of `Operator`'s declaration or
            // `RangeRef`'s variant assignment.
            (
                "Binary(Div, 1, 2)",
                Expr::Binary {
                    op: Operator::Div,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                },
                0xA4E3_0E3D_4072_B97A,
            ),
            (
                "Binary(Pow, 1, 2)",
                Expr::Binary {
                    op: Operator::Pow,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                },
                0xBCF4_42FD_C0F8_3B93,
            ),
            (
                "Binary(Concat, 1, 2)",
                Expr::Binary {
                    op: Operator::Concat,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                },
                0x457E_1335_9D76_C677,
            ),
            (
                "Binary(Eq, 1, 2)",
                Expr::Binary {
                    op: Operator::Eq,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                },
                0x2F34_C190_6455_A592,
            ),
            (
                "Binary(Neq, 1, 2)",
                Expr::Binary {
                    op: Operator::Neq,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                },
                0x0696_AFF0_30C2_B195,
            ),
            (
                "Binary(Lt, 1, 2)",
                Expr::Binary {
                    op: Operator::Lt,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                },
                0x8CA4_6FCE_5CD0_A40E,
            ),
            (
                "Binary(Le, 1, 2)",
                Expr::Binary {
                    op: Operator::Le,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                },
                0x3734_2851_52CA_2B34,
            ),
            (
                "Binary(Gt, 1, 2)",
                Expr::Binary {
                    op: Operator::Gt,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                },
                0x7355_6CFF_FDC4_6019,
            ),
            (
                "Binary(Ge, 1, 2)",
                Expr::Binary {
                    op: Operator::Ge,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                },
                0x00B4_53DE_645B_86D8,
            ),
            (
                "Unary(Percent, 50)",
                Expr::Unary {
                    op: Operator::Percent,
                    operand: Box::new(Expr::Number(50.0)),
                },
                0x4D0D_2F0D_928D_0468,
            ),
            (
                "RangeRef::Cells A1:B10",
                Expr::RangeRef(RangeRef::Cells {
                    sheet: None,
                    start_col: 0,
                    start_row: 0,
                    end_col: 1,
                    end_row: 9,
                    abs_start_col: false,
                    abs_start_row: false,
                    abs_end_col: false,
                    abs_end_row: false,
                }),
                0xCB13_4EA9_54B9_6057,
            ),
            (
                "CellRef sheet=Some(2)",
                Expr::CellRef(CellAddr {
                    sheet: Some(2),
                    col: 0,
                    row: 0,
                    abs_col: false,
                    abs_row: false,
                }),
                0x6E19_E429_4F2F_388E,
            ),
            (
                "Array [[1, 2], [3, 4]]",
                Expr::Array(vec![
                    vec![Expr::Number(1.0), Expr::Number(2.0)],
                    vec![Expr::Number(3.0), Expr::Number(4.0)],
                ]),
                0x03DC_67E4_D861_2386,
            ),
            (
                "Spill(1+2)",
                Expr::Spill(Box::new(Expr::Binary {
                    op: Operator::Plus,
                    lhs: Box::new(Expr::Number(1.0)),
                    rhs: Box::new(Expr::Number(2.0)),
                })),
                0x8D37_9920_D9A5_B01C,
            ),
        ];
        let mut mismatches = Vec::new();
        for (label, expr, expected) in goldens {
            let actual = fingerprint(expr);
            if actual != *expected {
                mismatches.push(format!(
                    "    ({label:?}, ..., 0x{actual:016X}_u64), // was 0x{expected:016X}"
                ));
            }
        }
        if !mismatches.is_empty() {
            panic!(
                "Phase 2A.10 fingerprint goldens drifted. If this is intentional, \
                 paste the lines below into the goldens array and document the \
                 reason in the seed-rotation log:\n\n{}\n",
                mismatches.join("\n")
            );
        }
    }

    /// Cross-process determinism: same Expr produces the same fingerprint
    /// 1000× in a row (no per-invocation randomness from `DefaultHasher`'s
    /// random seed, which the old impl had).
    #[test]
    fn fingerprint_deterministic_across_repeated_calls() {
        let e = Expr::Binary {
            op: Operator::Plus,
            lhs: Box::new(Expr::Number(1.0)),
            rhs: Box::new(Expr::CellRef(CellAddr {
                sheet: None,
                col: 3,
                row: 5,
                abs_col: false,
                abs_row: false,
            })),
        };
        let first = fingerprint(&e);
        for _ in 0..1000 {
            assert_eq!(fingerprint(&e), first);
        }
    }

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

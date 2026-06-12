//! Defined-name API for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.4 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Two
//! producer-side defined-name methods covering workbook-scoped
//! and sheet-scoped registrations. Pure code move; no behavior
//! change.
//!
//! Methods:
//! - [`WorkbookRuntime::set_name`] (Phase 2B.5) — register a
//!   workbook-scoped name, emit `Op::SetName { scope: None, .. }`,
//!   fire `CalcgraphSession::on_set_name`. Append-before-mutate
//!   ordering per Phase 2B.7 audit H3.
//! - [`WorkbookRuntime::set_sheet_scoped_name`] (W5-92) — register
//!   a sheet-scoped name, emit `Op::SetName { scope: Some(sheet),
//!   .. }`. Per design § 10.5 invalidates the plan cache so cached
//!   plans bound against the workbook-scoped value pick up the new
//!   sheet-scoped shadow on next recompute.

use ql_oplog::Op;
use ql_types::SheetId;

use super::{RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    /// Phase 2B.5 (2026-05-12): register a defined name through the runtime,
    /// emitting `Op::SetName` into the attached op log (if any). This is the
    /// op-log-recording wrapper for `Workbook::set_name`; product code SHOULD
    /// route through here so the mutation lands in the op log.
    ///
    /// Direct callers of `Workbook::set_name` bypass the op log silently —
    /// that path is documented as low-level and intended only for tests, the
    /// qbook loader (where the workbook is being constructed from disk and
    /// op-log history is loaded separately), and other engine-internal
    /// reconstruction code. See GAP-O-01 in `docs/known-gaps.md`.
    pub fn set_name(
        &mut self,
        name: &str,
        target: ql_storage::NamedTarget,
    ) -> Result<(), RuntimeError> {
        // Phase 2B.7 audit H3 (was 2B.5 mutate-first): validate → append →
        // mutate so neither failure mode leaves engine state divergent:
        //
        //   1. Reserved-name rejection: caught by `NameTable::would_accept`
        //      before anything else runs. Workbook unmodified, log unmodified.
        //   2. Op-log append failure: caught BEFORE the workbook mutation.
        //      Workbook still unmodified, log unmodified.
        //
        // The prior mutate-first ordering left a divergence window where
        // the workbook had the name but the log didn't — see audit H3 for
        // why that was wrong. The append-first ordering used by set_value /
        // set_formula / clear_formula / add_sheet now extends here.
        //
        // Wire-form encoding canonicalizes the name to upper case to match
        // `NameTable::set`'s on-write canonicalization, so the recorded
        // form is stable regardless of how the caller cased the name.
        self.workbook.names().would_accept(name)?;
        if let Some(oplog) = self.oplog.as_deref_mut() {
            let target_wire = ql_io::NamedTargetWire::from_target(&target);
            oplog.append(Op::SetName {
                scope: None,
                name: name.to_ascii_uppercase(),
                target: target_wire,
            })?;
        }
        // Now the mutation cannot fail (reserved-name already pre-checked).
        // `set_name` returns Result for forward-compat with future
        // NameTableError variants; expect them to be pre-checkable via
        // `would_accept`.
        self.workbook.set_name(name, target)?;

        // Phase 3.1: notify calcgraph. Today a counter-bump; Phase 3.3
        // will mark all formulas containing this name dirty.
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_set_name(name);
        }

        Ok(())
    }

    /// **W5-92 (Phase 4.6.D):** register a sheet-scoped defined name
    /// through the runtime, emitting `Op::SetName { scope: Some(sheet), .. }`
    /// into the attached op log (if any). Sheet-scoped names shadow
    /// workbook-scoped names with the same identifier when accessed
    /// from a formula on `sheet`, per Excel canon (XS-4-03).
    ///
    /// Validation matches `set_name`:
    /// - `Workbook::sheet(sheet)` must exist; otherwise
    ///   `RuntimeError::InvalidSheet`.
    /// - Reserved-name guard fires (currently `AI` per CORR-06); the
    ///   reserved set is workbook-global, so sheet-scoped names are
    ///   refused with the same rule.
    /// - Op-log append failure fails BEFORE the workbook mutation so
    ///   neither failure mode leaves engine state divergent.
    pub fn set_sheet_scoped_name(
        &mut self,
        sheet: SheetId,
        name: &str,
        target: ql_storage::NamedTarget,
    ) -> Result<(), RuntimeError> {
        // 1. Validate sheet id exists.
        let sheet_count = self.workbook.sheet_count();
        if self.workbook.sheet(sheet).is_none() {
            return Err(RuntimeError::InvalidSheet { sheet, sheet_count });
        }
        // 2. Pre-check reserved-name guard so a rejection doesn't
        //    leave a phantom op-log entry. We use the workbook's
        //    `NameTable::would_accept` since the reserved-name set
        //    is workbook-global (per is_reserved_name in storage).
        self.workbook.names().would_accept(name)?;
        // 3. Append op-log entry BEFORE mutation.
        if let Some(oplog) = self.oplog.as_deref_mut() {
            let target_wire = ql_io::NamedTargetWire::from_target(&target);
            oplog.append(Op::SetName {
                scope: Some(sheet),
                name: name.to_ascii_uppercase(),
                target: target_wire,
            })?;
        }
        // 4. Mutate. validation already passed; `set_scoped_name`
        //    returns Result for forward-compat.
        self.workbook
            .sheet_mut(sheet)
            .expect("sheet existence already validated")
            .set_scoped_name(name, target)?;

        // 5. Calcgraph notification — fan out the same as workbook-
        //    scoped sets. Phase 3.3's name→formula tracking is name-
        //    keyed and doesn't currently distinguish scopes; over-
        //    invalidation is the conservative direction here.
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_set_name(name);
        }

        // 6. **W5-93 (Phase 4.6.E closure):** invalidate the plan cache.
        //    Codex HIGH-2: the cache key currently includes only the
        //    workbook-scoped `NameTable::generation()` — a sheet-scoped
        //    name change wouldn't bump that counter, so cached plans
        //    bound against `=Rate` (resolved to workbook-scoped) would
        //    keep evaluating against the workbook value even after a
        //    sheet-scoped `Rate` was registered. Full flush is acceptable
        //    at edit rate (matches the rename pattern); per-sheet
        //    generation counters are design § 10.5 future polish.
        self.plan_cache.clear();

        Ok(())
    }

    /// **FE-5 W-N (2026-06-12):** remove a workbook-scoped defined name
    /// through the runtime, emitting `Op::RemoveName { scope: None, .. }`
    /// into the attached op log (if any). This is the compensating wrapper
    /// for [`set_name`](Self::set_name).
    ///
    /// **Why the op MUST be emitted (the resurrect bug).** `NameTable::clear`
    /// mutates only the live in-memory table. The op log is what the workbook
    /// is RE-DERIVED from on every undo/redo (`WorkbookSession::rematerialize`
    /// → `baseline + replay(oplog)`); without a compensating `Op::RemoveName`,
    /// the original `Op::SetName` keeps replaying and the deleted name silently
    /// RESURRECTS. So we append `RemoveName` BEFORE the in-memory clear (the
    /// same validate→append→mutate ordering as `set_name`, Phase 2B.7 audit
    /// H3): a failed append leaves both the workbook AND the log unmodified.
    ///
    /// **Fail-loud on unknown name (No-Fallbacks).** `NameTable::clear` is
    /// idempotent (silent no-op on a missing key). A `delete_name` for a name
    /// that doesn't exist is a caller error, not a no-op — it returns
    /// [`RuntimeError::NameNotFound`] and appends NOTHING to the log. The
    /// existence check uses `lookup_ci` so the caller need not pre-canonicalize.
    pub fn delete_name(&mut self, name: &str) -> Result<(), RuntimeError> {
        // 1. Fail loud if the name isn't registered (no silent clear no-op).
        if self.workbook.names().lookup_ci(name).is_none() {
            return Err(RuntimeError::NameNotFound {
                name: name.to_ascii_uppercase(),
                scope: None,
            });
        }
        // 2. Append the compensating op BEFORE mutating (so a failed append
        //    leaves the workbook untouched — see `set_name`'s H3 ordering).
        //    Canonicalize the name to upper case to match `NameTable`'s
        //    on-write canonicalization, so replay's `clear` hits the entry.
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::RemoveName {
                scope: None,
                name: name.to_ascii_uppercase(),
            })?;
        }
        // 3. Mutate the live table.
        self.workbook.names_mut().clear(name);
        // 4. Notify calcgraph — a removed name invalidates any formula that
        //    referenced it (same fan-out as a set; over-invalidation is the
        //    conservative direction, matching `set_name`).
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_set_name(name);
        }
        Ok(())
    }

    /// **FE-5 W-N (2026-06-12):** remove a sheet-scoped defined name through
    /// the runtime, emitting `Op::RemoveName { scope: Some(sheet), .. }`. The
    /// sheet-scoped compensating wrapper for [`set_sheet_scoped_name`].
    ///
    /// Same contract as [`delete_name`](Self::delete_name): validate the sheet
    /// id, fail loud if the name isn't registered on that sheet's table, then
    /// append-before-mutate. Invalidates the plan cache like
    /// `set_sheet_scoped_name` (a sheet-scoped change doesn't bump the
    /// workbook `NameTable::generation`).
    pub fn delete_sheet_scoped_name(
        &mut self,
        sheet: SheetId,
        name: &str,
    ) -> Result<(), RuntimeError> {
        // 1. Validate sheet id exists.
        let sheet_count = self.workbook.sheet_count();
        let sheet_ref = self
            .workbook
            .sheet(sheet)
            .ok_or(RuntimeError::InvalidSheet { sheet, sheet_count })?;
        // 2. Fail loud if the name isn't registered on this sheet's table.
        if sheet_ref.scoped_names().lookup_ci(name).is_none() {
            return Err(RuntimeError::NameNotFound {
                name: name.to_ascii_uppercase(),
                scope: Some(sheet),
            });
        }
        // 3. Append the compensating op BEFORE mutating.
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::RemoveName {
                scope: Some(sheet),
                name: name.to_ascii_uppercase(),
            })?;
        }
        // 4. Mutate the sheet-scoped table. Sheet existence already validated.
        self.workbook
            .sheet_mut(sheet)
            .expect("sheet existence already validated")
            .scoped_names_mut()
            .clear(name);
        // 5. Calcgraph notification (same fan-out as the workbook-scoped path).
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_set_name(name);
        }
        // 6. Invalidate the plan cache (mirrors `set_sheet_scoped_name`).
        self.plan_cache.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use ql_functions::default_registry;
    use ql_oplog::{Op, OpLog};
    use ql_storage::{NamedTarget, Workbook};
    use ql_types::Value;

    use crate::plan::BindError;
    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    /// Tier D1 Step 4: shared with the appended Phase 2A.1 named-
    /// range tests. The W5-92 / W5-93 tests above use `Workbook::new()`
    /// directly; the Phase 2A.1 tests built on this helper.
    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===== W5-92 (Phase 4.6.D) set_sheet_scoped_name =====

    #[test]
    fn set_sheet_scoped_name_lands_on_sheet_table() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_sheet_scoped_name(s0, "R", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        drop(rt);
        assert!(matches!(
            wb.sheet(s0).unwrap().scoped_names().lookup_ci("R"),
            Some(NamedTarget::Constant(Value::Number(n))) if n == 0.21
        ));
        // Workbook-scope is untouched.
        assert!(wb.names().is_empty());
    }

    #[test]
    fn set_sheet_scoped_name_invalid_sheet_errors() {
        let mut wb = Workbook::new();
        let _ = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .set_sheet_scoped_name(42, "R", NamedTarget::Constant(Value::Number(1.0)))
            .unwrap_err();
        assert!(matches!(err, RuntimeError::InvalidSheet { sheet: 42, .. }));
    }

    #[test]
    fn set_sheet_scoped_name_reserved_name_rejected() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .set_sheet_scoped_name(s0, "AI", NamedTarget::Constant(Value::Number(42.0)))
            .unwrap_err();
        assert!(matches!(err, RuntimeError::Name(_)));
        // Workbook unmutated.
        drop(rt);
        assert!(wb.sheet(s0).unwrap().scoped_names().is_empty());
    }

    #[test]
    fn set_sheet_scoped_name_emits_op_with_scope() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
        rt.set_sheet_scoped_name(s0, "R", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        drop(rt);
        let ops: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        match &ops[0] {
            Op::SetName {
                scope,
                name,
                target,
            } => {
                assert_eq!(*scope, Some(s0));
                assert_eq!(name, "R");
                assert!(matches!(target, ql_io::NamedTargetWire::Constant { .. }));
            }
            other => panic!("expected SetName, got {other:?}"),
        }
    }

    #[test]
    fn formula_resolves_sheet_scoped_over_workbook_scoped() {
        // End-to-end: workbook has Rate = 0.05, sheet 0 has scoped Rate = 0.21.
        // A formula `=Rate` on sheet 0 should evaluate to 0.21 (sheet-scoped
        // wins). On sheet 1 (no scoped Rate) it should evaluate to 0.05.
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        let s1 = wb.add_sheet("S1");
        wb.set_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
            .unwrap();
        wb.sheet_mut(s0)
            .unwrap()
            .set_scoped_name("Rate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v0 = rt.set_formula(s0, 0, 0, "Rate").unwrap();
        assert_eq!(v0, Value::Number(0.21));
        let v1 = rt.set_formula(s1, 0, 0, "Rate").unwrap();
        assert_eq!(v1, Value::Number(0.05));
    }

    // ===== W5-93 (Phase 4.6.E closure) — sheet-scoped slice =====

    #[test]
    fn set_sheet_scoped_name_invalidates_plan_cache() {
        // Codex HIGH-2: a workbook-scoped formula bound BEFORE the
        // sheet-scoped name was registered must re-bind on next
        // recompute. Pre-W5-93 the plan cache key only included the
        // workbook NameTable generation, so the cached plan would
        // keep using the workbook-scoped value.
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S0");
        wb.set_name("Rate", NamedTarget::Constant(Value::Number(0.05)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Bind once — `=Rate` resolves to workbook-scoped 0.05.
        let v0 = rt.set_formula(s0, 0, 0, "Rate").unwrap();
        assert_eq!(v0, Value::Number(0.05));
        // Register a sheet-scoped Rate on the same sheet.
        rt.set_sheet_scoped_name(s0, "Rate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        // Recompute — the cached plan should have been invalidated, so
        // we re-bind and pick up the sheet-scoped 0.21.
        let _ = rt.recompute_all();
        drop(rt);
        assert_eq!(
            wb.read(ql_types::Address::new(s0, 0, 0)),
            Value::Number(0.21),
            "cache invalidation: sheet-scoped value should win after registration"
        );
    }

    // ===== Phase 2A.1 — named-range resolution =====

    #[test]
    fn set_formula_resolves_named_cell_target() {
        use ql_storage::NamedTarget;
        use ql_types::Address;

        let mut wb = make_runtime_workbook();
        // A1 = 42; register MYREF → $A$1.
        wb.put_at(0, 0, 0, Value::Number(42.0));
        wb.set_name("MyRef", NamedTarget::Cell(Address::new(0, 0, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // =MyRef + 1 → 43. The bare ident parses as NameRef, the binder resolves
        // it to a CellRef via the workbook's name table.
        let v = rt.set_formula(0, 1, 0, "MyRef + 1").unwrap();
        assert_eq!(v, Value::Number(43.0));
    }

    #[test]
    fn set_formula_resolves_named_number_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        // TaxRate = 0.21 as a named constant.
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "100 * TaxRate").unwrap();
        assert_eq!(v, Value::Number(21.0));
    }

    #[test]
    fn set_formula_resolves_named_boolean_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        wb.set_name("UseFancy", NamedTarget::Constant(Value::Boolean(true)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Phase 0 binder accepts Boolean as ExprPlan::Bool literal. Evaluating
        // a bare NameRef should return the boolean.
        let v = rt.set_formula(0, 0, 0, "UseFancy").unwrap();
        assert_eq!(v, Value::Boolean(true));
    }

    #[test]
    fn set_formula_resolves_named_text_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        wb.set_name("Greeting", NamedTarget::Constant(Value::text("hello")))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let v = rt.set_formula(0, 0, 0, "Greeting").unwrap();
        assert_eq!(v, Value::text("hello"));
    }

    #[test]
    fn set_formula_unresolved_name_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // No name registered → bind-time UnresolvedName, surfaced as RuntimeError::Bind.
        let result = rt.set_formula(0, 0, 0, "UnknownName + 1");
        match result {
            Err(RuntimeError::Bind(BindError::UnresolvedName(name))) => {
                assert_eq!(name.as_ref(), "UNKNOWNNAME");
            }
            other => panic!("expected Bind(UnresolvedName), got {other:?}"),
        }
        // No partial write on bind failure.
        assert_eq!(wb.read(ql_types::Address::new(0, 0, 0)), Value::Blank);
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    /// Phase 2A.11 audit M16: error Display strings are human-readable, not
    /// Rust-debug syntax. Previously `RuntimeError::Bind(BindError::Unresolved
    /// Name("X"))` rendered via `{0:?}` and surfaced "bind error:
    /// UnresolvedName(\"X\")" — Rust debug format with an awkward bracket+
    /// quote spelling. Now reads "bind error: unresolved name \"X\"".
    #[test]
    fn runtime_error_bind_display_is_human_readable() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt
            .set_formula(0, 0, 0, "UnknownName + 1")
            .expect_err("expected an error");
        let display = err.to_string();
        // The display contains the user-facing canonical name; no Rust
        // debug-syntax markers like `UnresolvedName(...)`.
        assert!(
            display.contains("UNKNOWNNAME"),
            "Display lost the name: {display:?}"
        );
        assert!(
            !display.contains("UnresolvedName"),
            "Display still leaks Rust variant syntax: {display:?}"
        );
    }

    #[test]
    fn runtime_error_lex_display_is_human_readable() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // **W5-143 (Phase 4.9.G):** `@` is now the implicit-intersection
        // operator, so it's no longer a lex error. Use backtick (`)
        // which has no Excel-formula lexical role and stays
        // unrepresentable.
        let err = rt
            .set_formula(0, 0, 0, "`foo")
            .expect_err("expected an error");
        let display = err.to_string();
        assert!(
            display.contains("unexpected character"),
            "Display lost the message: {display:?}"
        );
        // No debug-syntax leak like `UnexpectedChar('`')`.
        assert!(
            !display.contains("UnexpectedChar"),
            "Display still leaks Rust variant syntax: {display:?}"
        );
    }

    /// Phase 2B.4 (2026-05-12): named range in a bare scalar position now
    /// surfaces the precise `NamedRangeInScalarContext` instead of the
    /// generic `UnsupportedVariant`. Aggregate-context usage (e.g.
    /// `=SUM(Sales)`) is now accepted and binds to `ExprPlan::AggregateNameRef`.
    /// NAG-04 acceptance.
    #[test]
    fn set_formula_named_range_in_scalar_context_errors() {
        use ql_storage::NamedTarget;
        use ql_types::Range;

        let mut wb = make_runtime_workbook();
        wb.set_name("Sales", NamedTarget::Range(Range::new(0, 1, 0, 10, 0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let result = rt.set_formula(0, 0, 0, "Sales");
        match result {
            Err(RuntimeError::Bind(BindError::NamedRangeInScalarContext(name))) => {
                // Parser canonicalizes to upper case.
                assert_eq!(name.as_ref(), "SALES");
            }
            other => panic!("expected Bind(NamedRangeInScalarContext), got {other:?}"),
        }
    }

    #[test]
    fn recompute_all_resolves_named_constant() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        // Seed a formula manually (skipping set_formula) so recompute_all does the work.
        wb.put_at(0, 0, 0, Value::Number(0.0));
        wb.put_formula(0, 0, 0, "1000 * TaxRate");

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let result = rt.recompute_all();
        assert_eq!(result.succeeded, 1);
        assert!(result.is_complete());
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 0)),
            Value::Number(210.0)
        );
    }

    #[test]
    fn set_name_uppercases_for_canonical_lookup() {
        use ql_storage::NamedTarget;

        let mut wb = make_runtime_workbook();
        // Register with mixed case — the parser will uppercase NameRef tokens, so
        // lookup must succeed regardless of how the source wrote the name.
        wb.set_name("MixedCaseName", NamedTarget::Constant(Value::Number(5.0)))
            .unwrap();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        // Lowercased reference still resolves.
        let v = rt.set_formula(0, 0, 0, "mixedcasename + 1").unwrap();
        assert_eq!(v, Value::Number(6.0));
    }

    // ===== FE-5 W-N (2026-06-12) — delete_name runtime wrapper =====

    #[test]
    fn delete_name_emits_remove_op_and_clears() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
        rt.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        rt.delete_name("TaxRate").unwrap();
        drop(rt);
        // In-memory table is clear.
        assert!(wb.names().lookup_ci("TaxRate").is_none());
        // The op log carries SetName THEN RemoveName (append-before-mutate).
        let ops: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 2);
        assert!(matches!(&ops[0], Op::SetName { name, .. } if name == "TAXRATE"));
        match &ops[1] {
            Op::RemoveName { scope, name } => {
                assert_eq!(*scope, None);
                assert_eq!(name, "TAXRATE"); // canonical upper case
            }
            other => panic!("expected RemoveName, got {other:?}"),
        }
    }

    #[test]
    fn delete_name_unknown_errors_and_appends_nothing() {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
        let err = rt.delete_name("NOPE").unwrap_err();
        assert!(matches!(
            err,
            RuntimeError::NameNotFound { scope: None, .. }
        ));
        drop(rt);
        // No op appended for the failed delete.
        let ops: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
        assert!(ops.is_empty());
    }

    #[test]
    fn delete_sheet_scoped_name_emits_scoped_remove_op() {
        let mut wb = Workbook::new();
        let s0 = wb.add_sheet("S");
        let reg = default_registry();
        let mut log = OpLog::new();
        let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut log);
        rt.set_sheet_scoped_name(s0, "R", NamedTarget::Constant(Value::Number(0.5)))
            .unwrap();
        rt.delete_sheet_scoped_name(s0, "R").unwrap();
        drop(rt);
        assert!(wb
            .sheet(s0)
            .unwrap()
            .scoped_names()
            .lookup_ci("R")
            .is_none());
        let ops: Vec<Op> = log.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 2);
        match &ops[1] {
            Op::RemoveName { scope, name } => {
                assert_eq!(*scope, Some(s0));
                assert_eq!(name, "R");
            }
            other => panic!("expected scoped RemoveName, got {other:?}"),
        }
    }

    #[test]
    fn delete_sheet_scoped_name_invalid_sheet_errors() {
        let mut wb = Workbook::new();
        let _ = wb.add_sheet("S");
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.delete_sheet_scoped_name(42, "R").unwrap_err();
        assert!(matches!(err, RuntimeError::InvalidSheet { sheet: 42, .. }));
    }
}

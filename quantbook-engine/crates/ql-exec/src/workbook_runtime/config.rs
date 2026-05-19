//! Workbook-level config setters for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.2 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Two
//! producer-side methods that update workbook-scoped IDE
//! preferences (reference-mode + locale). Pure code move; no
//! behavior change.
//!
//! Methods:
//! - [`WorkbookRuntime::set_reference_mode`] — switch between A1
//!   and R1C1 input/display modes. Idempotent.
//! - [`WorkbookRuntime::set_locale`] — switch between EnUs / De /
//!   Fr formula input/display locales. Idempotent.

use ql_oplog::Op;

use super::{RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    /// **W5-146 (Phase 4.9.K):** set the workbook's reference mode
    /// (A1 or R1C1) and append `Op::SetReferenceMode` to the op-log.
    /// Idempotent — setting to the current value is a no-op that
    /// emits NO op (keeps the log compact).
    ///
    /// Per design § 4.4 storage canon, formula text is stored in
    /// canonical A1 form regardless of `mode`; this setting only
    /// affects how the IDE renders formulas to the user and how
    /// future calls to `set_formula(text)` interpret the input
    /// reference syntax.
    pub fn set_reference_mode(
        &mut self,
        mode: ql_types::ReferenceMode,
    ) -> Result<(), RuntimeError> {
        if self.workbook.reference_mode() == mode {
            return Ok(());
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::SetReferenceMode {
                mode: ql_oplog::ReferenceModeWire::from_runtime(mode),
            })?;
        }
        self.workbook.set_reference_mode(mode);
        Ok(())
    }

    /// **W5-146 (Phase 4.9.K):** set the workbook's locale (EnUs /
    /// De / Fr) and append `Op::SetLocale` to the op-log.
    /// Idempotent — setting to the current value emits no op.
    ///
    /// Per design § 4.4 storage canon, formula text is stored in
    /// EN-locale form regardless of this setting; this setting only
    /// affects how the IDE renders formulas to the user (decimal
    /// separator, argument separator, array separators) and how
    /// future calls to `set_formula(text)` interpret input
    /// glyphs.
    pub fn set_locale(&mut self, locale: ql_types::Locale) -> Result<(), RuntimeError> {
        if self.workbook.locale() == locale {
            return Ok(());
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::SetLocale {
                locale: ql_oplog::LocaleWire::from_runtime(locale),
            })?;
        }
        self.workbook.set_locale(locale);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use ql_functions::default_registry;
    use ql_oplog::OpLog;
    use ql_storage::Workbook;

    use crate::workbook_runtime::WorkbookRuntime;

    // Mirror of `super::super::tests::make_runtime_workbook` — the
    // helper is `pub(super)` inside mod.rs's `tests` module and not
    // visible across sibling submodules. Trivial local helper keeps
    // the move self-contained.
    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===================================================================
    // W5-146 (Phase 4.9.K) — set_reference_mode / set_locale runtime API.
    // ===================================================================

    #[test]
    fn set_reference_mode_updates_workbook_and_emits_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_reference_mode(ql_types::ReferenceMode::R1C1)
                .unwrap();
        }
        assert_eq!(wb.reference_mode(), ql_types::ReferenceMode::R1C1);
        assert_eq!(oplog.len(), 1);
    }

    #[test]
    fn set_reference_mode_noop_when_unchanged_emits_no_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // default is A1; setting A1 again is a no-op.
            rt.set_reference_mode(ql_types::ReferenceMode::A1).unwrap();
        }
        assert_eq!(oplog.len(), 0);
    }

    #[test]
    fn set_locale_updates_workbook_and_emits_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_locale(ql_types::Locale::De).unwrap();
        }
        assert_eq!(wb.locale(), ql_types::Locale::De);
        assert_eq!(oplog.len(), 1);
    }

    #[test]
    fn set_locale_noop_when_unchanged_emits_no_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.set_locale(ql_types::Locale::EnUs).unwrap();
        }
        assert_eq!(oplog.len(), 0);
    }

    /// Phase 5 V1 D1.a re-partitioning (2026-05-19): moved from
    /// tables.rs::tests. Verifies that both `Op::SetReferenceMode`
    /// `Op::SetLocale` round-trip through replay correctly — natural
    /// test for config.rs's two methods.
    #[test]
    fn set_reference_mode_op_round_trips_through_replay() {
        // Producer side: append Op::SetReferenceMode + Op::SetLocale.
        let mut producer_wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut producer_wb, &reg, &mut oplog);
            rt.set_reference_mode(ql_types::ReferenceMode::R1C1)
                .unwrap();
            rt.set_locale(ql_types::Locale::De).unwrap();
        }
        // Replay side: fresh workbook, replay the log → same state.
        let mut replay_wb = make_runtime_workbook();
        ql_oplog::replay_into(&oplog, &mut replay_wb, &reg).unwrap();
        assert_eq!(replay_wb.reference_mode(), ql_types::ReferenceMode::R1C1);
        assert_eq!(replay_wb.locale(), ql_types::Locale::De);
    }
}

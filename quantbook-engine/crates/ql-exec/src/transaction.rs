//! `WorkbookTransaction` — Phase 2A.2 batch-write API.
//!
//! Buffers a sequence of value + formula writes, then applies them atomically on
//! `commit`. The IDE's "paste a 10×10 block" operation goes through one
//! transaction instead of 100 individual `set_value` calls — one save-state
//! change, one entry in the Phase 2A.3 op log per transaction.
//!
//! ## Semantics
//!
//! - **Eager validation**: `put_formula` runs lex + parse + bind at call time, so
//!   syntactic + name-resolution errors surface before any workbook state changes.
//!   Eval is deferred to commit (no `RuntimeError` from `commit` itself).
//! - **Two-pass commit**:
//!     1. Apply every literal value write + persist every formula's text. No
//!        formula evaluation yet.
//!     2. Evaluate each buffered formula against the now-updated workbook and
//!        write its result to the cell.
//!
//!   This means a formula that references a literal-value cell written EARLIER
//!   IN THE SAME TRANSACTION sees the new value (paste-block semantics).
//! - **Intra-batch formula→formula dependencies**: formulas evaluate in op-insert
//!   order. A formula referencing another formula in the same batch may see a
//!   stale value (whichever was computed last wins). Engine Phase 3 calcgraph
//!   integration adds topological scheduling (see `docs/MASTER-PLAN.md`
//!   Phase 3.4).
//! - **Drop without commit** = no-op. Buffered ops are discarded; workbook is
//!   unchanged. Useful for the IDE's "ESC cancels paste" path.
//! - **Last-write-wins**: writing the same cell twice in one transaction keeps
//!   both ops in the list, and pass 2 applies them in order — so the final value
//!   matches the last `put_*` for that cell.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use ql_formula_syntax::{lex, parse};
use ql_functions::FunctionRegistry;
use ql_io::CellWireValue;
use ql_oplog::{Op, OpLog};
use ql_storage::Workbook;
use ql_types::{ColId, RowId, SheetId, Value};
use ql_udf::UdfWorker;

use crate::env::{UdfCellDiagnostic, WorkbookEnv};
use crate::plan::{bind_with_site, BindSite, ExprPlan};
use crate::scalar::eval_scalar_with_registry;
use crate::workbook_runtime::{validate_cell, RuntimeError};

/// Phase 2A.6 audit H4: track the *kind* of op last buffered for each cell so
/// `put_value` after `put_formula` (or vice versa) on the same cell can be
/// rejected loudly at buffer time. Same-kind multi-writes (two `put_value`s,
/// two `put_formula`s) are still allowed — the existing last-write-wins
/// semantics handle them cleanly.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum OpKind {
    Value,
    Formula,
}

/// One pending operation in a transaction. Internal — the public API is the
/// `put_value` / `put_formula` methods.
enum PendingOp {
    Value {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: Value,
    },
    Formula {
        sheet: SheetId,
        row: RowId,
        col: ColId,
        text: Arc<str>,
        plan: ExprPlan,
    },
}

/// Batch writer for the workbook. Construct with `WorkbookTransaction::new` (or
/// via `WorkbookRuntime::transaction`), buffer writes via `put_value` and
/// `put_formula`, then call `commit` to apply them all.
///
/// The transaction holds a `&mut Workbook` for its entire lifetime — only one
/// transaction can exist per workbook at a time (enforced by the borrow checker).
///
/// Phase 2A.3.b (2026-05-12): optional op-log attachment via
/// `WorkbookTransaction::with_oplog` (or inherited from a runtime constructed
/// via `WorkbookRuntime::with_oplog`). When attached, `commit` produces a
/// single `Op::BatchCommit` containing one inner op per buffered write. Empty
/// transactions (no buffered ops) emit nothing.
pub struct WorkbookTransaction<'a> {
    workbook: &'a mut Workbook,
    registry: &'a FunctionRegistry,
    ops: Vec<PendingOp>,
    /// Phase 2A.6 audit H4: per-cell last-buffered op kind. Used to reject
    /// mixed-kind writes (value+formula on the same cell within one tx) at
    /// buffer time so the resulting workbook state is unambiguous.
    cell_kinds: HashMap<(SheetId, RowId, ColId), OpKind>,
    /// Phase 2A.3.b: optional op-log sink. `commit` emits a single
    /// `BatchCommit` at the end of pass 2 when this is `Some` and there is
    /// at least one buffered op.
    oplog: Option<&'a mut OpLog>,
    /// **6.4-3c (2026-05-29; CODEX-HIGH-2 audit fix):** borrowed handle to the
    /// session's Python-UDF worker, inherited from the `WorkbookRuntime` via
    /// `with_optional_oplog`. `None` for the bare `new`/`with_oplog`
    /// constructors. Threaded into pass-2's eval env so a UDF committed through
    /// a transaction COMPUTES instead of writing a permanent silent `#CALC!`
    /// (this struct keeps no calcgraph, so a stale `#CALC!` here would NOT
    /// self-heal). `None` (no worker) still yields a deterministic `#CALC!` at
    /// the dispatch site — honest, never a panic.
    udf_worker: Option<&'a RefCell<Box<dyn UdfWorker + Send>>>,
    /// **6.4B (FF-2):** borrowed `UdfCellDiagnostic` collector, forwarded from the
    /// `WorkbookRuntime` (which borrows the session's `udf_diagnostics`). Threaded
    /// into pass-2's eval env so a `=MYUDF(..)` that fails (or has no worker) while
    /// committing through THIS transaction records a structured diagnostic the
    /// session drains into an `Event::CellDiagnostic` — symmetric with the
    /// recompute / `set_formula` paths. `None` for the bare `new` / `with_oplog`
    /// constructors (their UDF failures still yield the correct cell value, just no
    /// diagnostic event). The standalone-transaction commit path was the one
    /// value-computing eval site that previously dropped UDF diagnostics
    /// (forward-risk: only test callers reach it today, but a future live commit
    /// path would otherwise silently lose them).
    udf_diagnostics: Option<&'a RefCell<Vec<UdfCellDiagnostic>>>,
}

impl<'a> WorkbookTransaction<'a> {
    pub fn new(workbook: &'a mut Workbook, registry: &'a FunctionRegistry) -> Self {
        Self {
            workbook,
            registry,
            ops: Vec::new(),
            cell_kinds: HashMap::new(),
            oplog: None,
            // 6.4-3c: bare constructor has no session, hence no worker. A UDF
            // committed through it is `#CALC!` (no-worker, honest + visible).
            udf_worker: None,
            // 6.4B (FF-2): no session collector on the bare constructor.
            udf_diagnostics: None,
        }
    }

    /// Phase 2A.3.b: construct a transaction that records its commit as a
    /// single `Op::BatchCommit` in the supplied op log. Useful when the
    /// caller wants ad-hoc transactions outside an enclosing
    /// `WorkbookRuntime::with_oplog`.
    pub fn with_oplog(
        workbook: &'a mut Workbook,
        registry: &'a FunctionRegistry,
        oplog: &'a mut OpLog,
    ) -> Self {
        Self {
            workbook,
            registry,
            ops: Vec::new(),
            cell_kinds: HashMap::new(),
            oplog: Some(oplog),
            // 6.4-3c: standalone op-log constructor, no session worker.
            udf_worker: None,
            // 6.4B (FF-2): standalone op-log constructor, no session collector.
            udf_diagnostics: None,
        }
    }

    /// Phase 2A.3.b: internal forwarding constructor used by
    /// `WorkbookRuntime::transaction` to pass through the runtime's
    /// (possibly absent) op-log handle via `Option::as_deref_mut`. Public
    /// callers should prefer `new` or `with_oplog`.
    ///
    /// **6.4-3c (2026-05-29; CODEX-HIGH-2 audit fix):** also forwards the
    /// runtime's (possibly absent) Python-UDF worker so UDFs committed through a
    /// runtime transaction compute correctly instead of writing a permanent
    /// silent `#CALC!`.
    pub fn with_optional_oplog(
        workbook: &'a mut Workbook,
        registry: &'a FunctionRegistry,
        oplog: Option<&'a mut OpLog>,
        udf_worker: Option<&'a RefCell<Box<dyn UdfWorker + Send>>>,
        // **6.4B (FF-2):** forward the runtime's (possibly absent) diagnostic
        // collector so transaction-committed UDF failures emit a `CellDiagnostic`.
        udf_diagnostics: Option<&'a RefCell<Vec<UdfCellDiagnostic>>>,
    ) -> Self {
        Self {
            workbook,
            registry,
            ops: Vec::new(),
            cell_kinds: HashMap::new(),
            oplog,
            udf_worker,
            udf_diagnostics,
        }
    }

    /// Buffer a literal value write. The write isn't visible to the workbook
    /// (or to other transactions) until `commit`. Any existing formula at the
    /// cell is cleared at commit (typing a value over a formula deletes it,
    /// per Excel canon).
    ///
    /// Phase 2A.6 audit H1: the destination `sheet` is validated up front so
    /// commit can't panic from `Workbook::put_at` mid-flight, leaving partial
    /// writes. Audit H4: rejects with `RuntimeError::ConflictingOps` if a
    /// formula was already buffered for the same cell in this transaction.
    pub fn put_value(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        value: Value,
    ) -> Result<(), RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;
        self.check_op_kind(sheet, row, col, OpKind::Value)?;
        self.ops.push(PendingOp::Value {
            sheet,
            row,
            col,
            value,
        });
        Ok(())
    }

    /// Buffer a formula write. The formula text is lexed + parsed + bound NOW
    /// (so syntactic + name-resolution errors surface before any state change),
    /// but evaluation is deferred to `commit` — meaning the formula sees writes
    /// from earlier ops in the same transaction.
    ///
    /// `formula_text` is the formula body without the leading `=`.
    ///
    /// Phase 2A.6 audit H1: validates `sheet` up front. Audit H4: rejects with
    /// `RuntimeError::ConflictingOps` if a value op was already buffered for
    /// the same cell in this transaction (mixing value+formula on one cell
    /// within a single batch was previously possible but produced surprising
    /// final state — see audit doc for the formula-text-cleared-but-formula-
    /// value-applied corner).
    ///
    /// Note on bound-plan staleness: bound plans capture the workbook's
    /// NameTable state at buffer time. Names registered between two
    /// transactions take effect for the next transaction's `put_formula` calls,
    /// but cannot be retroactively rebound (the transaction holds `&mut
    /// Workbook` for its lifetime, so the user can't mutate names mid-tx
    /// anyway).
    pub fn put_formula(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        formula_text: impl Into<Arc<str>>,
    ) -> Result<(), RuntimeError> {
        validate_cell(self.workbook, sheet, row, col)?;
        self.check_op_kind(sheet, row, col, OpKind::Formula)?;

        let text = formula_text.into();
        let tokens = lex(text.as_ref())?;
        let expr = parse(tokens)?;
        // Bind eagerly against the current workbook NameTable. The transaction
        // doesn't allow registering names mid-batch (the &mut Workbook borrow
        // prevents the user from mutating names while the tx is alive), so the
        // table is stable for the transaction's lifetime — eager binding is
        // safe and surfaces UnresolvedName / UnsupportedVariant before any
        // writes land.
        // W5-92 (Phase 4.6.D): pass `&Workbook` for names so the two-tier
        // sheet-then-workbook scope chain fires; was `self.workbook.names()`
        // (workbook-scoped only).
        // **W5-114 (Phase 4.8.E):** carry the formula's cell address.
        let plan = bind_with_site(
            &expr,
            BindSite::at_cell(ql_types::Address::new(sheet, row, col)),
            self.workbook,
            self.workbook,
            self.workbook,
            self.registry,
        )?;
        self.ops.push(PendingOp::Formula {
            sheet,
            row,
            col,
            text,
            plan,
        });
        Ok(())
    }

    /// Phase 2A.6 audit H4 helper. Returns Err if a different op kind was
    /// already buffered for `(sheet,row,col)`; otherwise records `kind` and
    /// returns Ok. Same-kind multi-writes are allowed (last-write-wins).
    fn check_op_kind(
        &mut self,
        sheet: SheetId,
        row: RowId,
        col: ColId,
        kind: OpKind,
    ) -> Result<(), RuntimeError> {
        match self.cell_kinds.get(&(sheet, row, col)) {
            Some(prior) if *prior != kind => Err(RuntimeError::ConflictingOps { sheet, row, col }),
            _ => {
                self.cell_kinds.insert((sheet, row, col), kind);
                Ok(())
            }
        }
    }

    /// Number of buffered ops. Useful for the IDE to display "5 writes pending".
    pub fn op_count(&self) -> usize {
        self.ops.len()
    }

    /// Apply all buffered ops to the workbook. See module docs for the two-pass
    /// semantics. Consumes the transaction.
    ///
    /// Phase 2A.3.b (2026-05-12): signature changed from `fn commit(self)` to
    /// `fn commit(self) -> Result<(), RuntimeError>` so a failing op-log
    /// append (Loro internal error, serde_json NaN/Inf refusal) surfaces to
    /// the caller. Callers without an attached op log never see an error
    /// from this path — `Ok(())` is the only outcome. Op-log append happens
    /// AFTER both workbook passes succeed, so a log-append failure leaves the
    /// workbook fully updated but the log without a corresponding
    /// `BatchCommit` entry. Callers attaching an op log are expected to
    /// treat this as an error condition (engine state has diverged from log
    /// state) and abort recording — analogous to the "no fallbacks" rule.
    pub fn commit(self) -> Result<(), RuntimeError> {
        let Self {
            workbook,
            registry,
            ops,
            cell_kinds: _,
            oplog,
            udf_worker,
            udf_diagnostics,
        } = self;

        // Phase 2B.7 audit H2/H4 (2026-05-12): build the log_ops list AND
        // append the BatchCommit BEFORE the workbook mutation passes. The
        // prior ordering (passes → append) left a divergence window where
        // a serialization failure mid-append would leave the workbook
        // fully mutated but the log without the BatchCommit. The new
        // ordering: any failure aborts before workbook state changes.
        //
        // Snapshot `pre_commit_had_formula` for each Value op — needed to
        // decide whether the BatchCommit's inner ops include a
        // `ClearFormula` after the `PutValue`. Read from the current
        // (pre-mutation) workbook state.
        if let Some(oplog) = oplog {
            let mut log_ops: Vec<Op> = Vec::with_capacity(ops.len() * 2);
            for op in &ops {
                match op {
                    PendingOp::Value {
                        sheet,
                        row,
                        col,
                        value,
                    } => {
                        // **F2 Blank-durability closure (2026-05-27):** mirror
                        // `set_value` — a Blank value (encoded as `None` by
                        // `from_value`) emits the durable `Op::ClearValue`
                        // rather than nothing, so a transaction's Blank-clear
                        // is reproducible on replay.
                        match CellWireValue::from_value(value) {
                            Some(wire) => log_ops.push(Op::PutValue {
                                sheet: *sheet,
                                row: *row,
                                col: *col,
                                value: wire,
                            }),
                            None => log_ops.push(Op::ClearValue {
                                sheet: *sheet,
                                row: *row,
                                col: *col,
                            }),
                        }
                        let had_formula = workbook.formula_at(*sheet, *row, *col).is_some();
                        if had_formula {
                            log_ops.push(Op::ClearFormula {
                                sheet: *sheet,
                                row: *row,
                                col: *col,
                            });
                        }
                    }
                    PendingOp::Formula {
                        sheet,
                        row,
                        col,
                        text,
                        ..
                    } => {
                        log_ops.push(Op::PutFormula {
                            sheet: *sheet,
                            row: *row,
                            col: *col,
                            text: text.as_ref().to_owned(),
                        });
                    }
                }
            }
            if !log_ops.is_empty() {
                // Append BEFORE the passes. If this fails, no workbook
                // mutation has happened.
                oplog.append(Op::BatchCommit { ops: log_ops })?;
            }
        }

        // Now safe to mutate: log has been durably appended (if attached).
        // Pass 1: apply literals + persist formula text. No formula eval yet.
        for op in &ops {
            match op {
                PendingOp::Value {
                    sheet,
                    row,
                    col,
                    value,
                } => {
                    workbook.put_at(*sheet, *row, *col, value.clone());
                    workbook.clear_formula(*sheet, *row, *col);
                }
                PendingOp::Formula {
                    sheet,
                    row,
                    col,
                    text,
                    ..
                } => {
                    workbook.put_formula(*sheet, *row, *col, Arc::clone(text));
                    // Phase 3.5 (CORR-25): the cell is becoming a formula
                    // cell. Drop any prior user-typed value so pass 2's
                    // computed write isn't masked by the read cascade
                    // (user → computed → base).
                    workbook.clear_user_at(*sheet, *row, *col);
                }
            }
        }

        // Pass 2: evaluate each buffered formula against the post-write workbook
        // and write the result. The env borrow is scoped to drop before the
        // mutable put_at — same pattern as workbook_runtime.rs.
        for op in &ops {
            if let PendingOp::Formula {
                sheet,
                row,
                col,
                plan,
                ..
            } = op
            {
                let value = {
                    // 6.4-3c (CODEX-HIGH-2): carry the session's UDF worker so a
                    // `=MYUDF(..)` committed through this transaction dispatches
                    // to the worker rather than writing a permanent `#CALC!`
                    // (this struct has no calcgraph to self-heal one). `None`
                    // worker still yields an honest `#CALC!` at the dispatch
                    // site. Scalar context: an array-returning UDF here is
                    // `#CALC!` (no spill on this no-graph path), same as any
                    // array-in-scalar-context.
                    // **6.4B (FF-2):** the diagnostics-carrying env ctor so a UDF
                    // failure here records a `CellDiagnostic` (no op-budget on the
                    // one-shot commit path — the per-call deadline bounds it).
                    let env = WorkbookEnv::with_formula_cell_worker_and_diagnostics(
                        workbook,
                        ql_types::Address::new(*sheet, *row, *col),
                        udf_worker,
                        udf_diagnostics,
                    );
                    eval_scalar_with_registry(plan, &env, registry)
                };
                // Phase 3.5 (CORR-25): formula outputs go to the computed
                // overlay, not the user lane.
                workbook.put_computed_at(*sheet, *row, *col, value);
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ql_functions::default_registry;
    use ql_storage::NamedTarget;
    use ql_types::{Address, ErrorValue};

    fn make_wb() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===== put_value =====

    #[test]
    fn put_value_buffers_until_commit() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_value(0, 0, 0, Value::Number(1.0)).unwrap();
        tx.put_value(0, 0, 1, Value::Number(2.0)).unwrap();
        tx.put_value(0, 0, 2, Value::Number(3.0)).unwrap();
        assert_eq!(tx.op_count(), 3);
        // Not yet visible.
        // (Can't read wb here — tx holds &mut. Drop tx first.)
        tx.commit().unwrap();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(1.0));
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(2.0));
        assert_eq!(wb.read(Address::new(0, 0, 2)), Value::Number(3.0));
    }

    #[test]
    fn dropping_transaction_without_commit_leaves_workbook_unchanged() {
        let mut wb = make_wb();
        let reg = default_registry();
        {
            let mut tx = WorkbookTransaction::new(&mut wb, &reg);
            tx.put_value(0, 0, 0, Value::Number(42.0)).unwrap();
            // Drop without commit.
        }
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
    }

    #[test]
    fn commit_with_no_ops_is_noop() {
        let mut wb = make_wb();
        let reg = default_registry();
        let tx = WorkbookTransaction::new(&mut wb, &reg);
        assert_eq!(tx.op_count(), 0);
        tx.commit().unwrap();
        // Workbook still empty.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Blank);
    }

    // ===== put_formula =====

    #[test]
    fn put_formula_commits_text_and_value() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_formula(0, 0, 0, "1 + 2 * 3").unwrap();
        tx.commit().unwrap();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(7.0));
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("1 + 2 * 3")
        );
    }

    #[test]
    fn formula_sees_value_written_in_same_transaction() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        // The classic paste-block scenario: A1 is a literal, B1 references A1.
        // At commit time, pass 1 writes A1=10; pass 2 evaluates B1=A1*2 against
        // the post-pass-1 workbook, seeing A1=10 → B1=20.
        tx.put_value(0, 0, 0, Value::Number(10.0)).unwrap();
        tx.put_formula(0, 0, 1, "A1 * 2").unwrap();
        tx.commit().unwrap();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(10.0));
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(20.0));
    }

    /// **CODEX-HIGH-2 (6.4-3c 3-way audit):** a UDF committed through a
    /// `WorkbookTransaction` that carries a worker COMPUTES, instead of writing
    /// a permanent silent `#CALC!` (this primitive keeps no calcgraph, so a
    /// stale `#CALC!` here would never self-heal). Without a worker it is an
    /// honest, visible `#CALC!` — never a panic or a wrong value.
    #[test]
    fn commit_dispatches_udf_through_worker() {
        use ql_session::function_meta::{
            ArgContext, ArgPolicy, Arity, BatchShape, CancelPolicy, DepShape, FunctionMetadata,
            Volatility,
        };
        use ql_session::session::FunctionImplHandle;
        use ql_udf::MockWorker;

        let udf_meta = |name: &str| FunctionMetadata {
            canonical_name: name.to_string(),
            display_name: None,
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Volatile,
            determinism: false,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::ArrayBatch,
            arg_policy: ArgPolicy::Strict,
            cancellation: CancelPolicy::WorkerKill,
            arg_context: ArgContext::Aggregate,
            provenance_tags: vec!["python".to_string()],
        };

        // (a) With a worker → computes (the fix).
        {
            let mut wb = make_wb();
            let mut reg = default_registry();
            reg.register_udf(udf_meta("MYUDF"), FunctionImplHandle(7))
                .unwrap();
            let worker: RefCell<Box<dyn UdfWorker + Send>> =
                RefCell::new(Box::new(MockWorker::new(|_h, args: &ql_types::ArrayValue| {
                    let n = match args.get(0, 0) {
                        Some(Value::Number(x)) => *x,
                        other => panic!("expected number, got {other:?}"),
                    };
                    Ok(ql_types::ArrayValue::singleton(Value::Number(n * 2.0)))
                })));
            let mut tx =
                WorkbookTransaction::with_optional_oplog(&mut wb, &reg, None, Some(&worker), None);
            tx.put_value(0, 0, 0, Value::Number(21.0)).unwrap();
            tx.put_formula(0, 0, 1, "MYUDF(A1)").unwrap();
            tx.commit().unwrap();
            assert_eq!(
                wb.read(Address::new(0, 0, 1)),
                Value::Number(42.0),
                "a worker-carrying transaction must dispatch the UDF, not write #CALC!"
            );
        }

        // (b) No worker → honest #CALC! (not a panic, not a wrong value).
        {
            let mut wb = make_wb();
            let mut reg = default_registry();
            reg.register_udf(udf_meta("MYUDF"), FunctionImplHandle(7))
                .unwrap();
            let mut tx = WorkbookTransaction::with_optional_oplog(&mut wb, &reg, None, None, None);
            tx.put_value(0, 0, 0, Value::Number(21.0)).unwrap();
            tx.put_formula(0, 0, 1, "MYUDF(A1)").unwrap();
            tx.commit().unwrap();
            assert_eq!(
                wb.read(Address::new(0, 0, 1)),
                Value::Error(ErrorValue::Calc),
                "no worker on the transaction → honest #CALC!"
            );
        }
    }

    /// **6.4B (FF-2):** a UDF that FAILS while committing through a transaction now
    /// records a `CellDiagnostic` into the forwarded collector — the
    /// standalone-transaction commit path is no longer a diagnostics black hole
    /// (forward-risk closure: only test callers reach it live today, but a future
    /// live commit path would otherwise silently drop UDF failure diagnostics).
    #[test]
    fn transaction_udf_failure_records_diagnostic() {
        use ql_session::function_meta::{
            ArgContext, ArgPolicy, Arity, BatchShape, CancelPolicy, DepShape, FunctionMetadata,
            Volatility,
        };
        use ql_session::session::FunctionImplHandle;
        use ql_udf::MockWorker;

        let mut wb = make_wb();
        let mut reg = default_registry();
        let meta = FunctionMetadata {
            canonical_name: "MYUDF".to_string(),
            display_name: None,
            aliases: vec![],
            arity: Arity::Variadic,
            volatility: Volatility::Volatile,
            determinism: false,
            dep_shape: DepShape::ValueDeps,
            batch_shape: BatchShape::ArrayBatch,
            arg_policy: ArgPolicy::Strict,
            cancellation: CancelPolicy::WorkerKill,
            arg_context: ArgContext::Aggregate,
            provenance_tags: vec!["python".to_string()],
        };
        reg.register_udf(meta, FunctionImplHandle(7)).unwrap();
        let worker: RefCell<Box<dyn UdfWorker + Send>> =
            RefCell::new(Box::new(MockWorker::new(|_h, _a: &ql_types::ArrayValue| {
                Err(ql_udf::UdfError::Raised {
                    exc_type: "ValueError".to_string(),
                    message: "boom".to_string(),
                })
            })));
        let diags: RefCell<Vec<UdfCellDiagnostic>> = RefCell::new(Vec::new());
        {
            let mut tx = WorkbookTransaction::with_optional_oplog(
                &mut wb,
                &reg,
                None,
                Some(&worker),
                Some(&diags),
            );
            tx.put_value(0, 0, 0, Value::Number(21.0)).unwrap();
            tx.put_formula(0, 0, 1, "MYUDF(A1)").unwrap();
            tx.commit().unwrap();
        }
        // The cell is #CALC! (a raise) AND the failure was recorded as a diagnostic.
        assert_eq!(
            wb.read(Address::new(0, 0, 1)),
            Value::Error(ErrorValue::Calc),
            "a raised UDF in a transaction is an honest #CALC!"
        );
        let recorded = diags.borrow();
        assert_eq!(recorded.len(), 1, "exactly one diagnostic recorded");
        assert_eq!(recorded[0].code, "udf_raised");
        assert_eq!(recorded[0].addr, Address::new(0, 0, 1));
    }

    #[test]
    fn put_formula_parse_error_rejects_op_immediately() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        // Buffer a good op first.
        tx.put_value(0, 0, 0, Value::Number(99.0)).unwrap();

        // Now a parse error.
        let result = tx.put_formula(0, 0, 1, "(1 + 2");
        assert!(matches!(result, Err(RuntimeError::Parse(_))));
        // The failed op didn't land in the buffer.
        assert_eq!(tx.op_count(), 1);

        // Subsequent good ops still work.
        tx.put_value(0, 0, 2, Value::Number(77.0)).unwrap();
        tx.commit().unwrap();

        // Good ops applied; failed op had no effect.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(99.0));
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Blank);
        assert_eq!(wb.read(Address::new(0, 0, 2)), Value::Number(77.0));
    }

    #[test]
    fn put_formula_unresolved_name_errors_at_buffer_time() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        // No name registered → bind-time UnresolvedName surfaces here.
        let result = tx.put_formula(0, 0, 0, "UnknownName + 1");
        assert!(
            matches!(
                result,
                Err(RuntimeError::Bind(crate::plan::BindError::UnresolvedName(
                    _
                )))
            ),
            "expected Bind(UnresolvedName), got {result:?}"
        );
        assert_eq!(tx.op_count(), 0);
    }

    #[test]
    fn value_write_clears_existing_formula() {
        let mut wb = make_wb();
        let reg = default_registry();
        // Seed A1 with a formula.
        wb.put_at(0, 0, 0, Value::Number(5.0));
        wb.put_formula(0, 0, 0, "1 + 4");
        assert!(wb.formula_at(0, 0, 0).is_some());

        // Transaction overwrites with a literal.
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_value(0, 0, 0, Value::Number(100.0)).unwrap();
        tx.commit().unwrap();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(100.0));
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    #[test]
    fn last_write_wins_when_same_cell_written_twice() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_value(0, 0, 0, Value::Number(1.0)).unwrap();
        tx.put_value(0, 0, 0, Value::Number(2.0)).unwrap();
        tx.put_value(0, 0, 0, Value::Number(3.0)).unwrap();
        tx.commit().unwrap();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(3.0));
    }

    /// Phase 2A.6 audit H4 (2026-05-12): mixing value + formula on the SAME cell
    /// within a single transaction was previously allowed and produced surprising
    /// final state (literal-then-formula left both consistent, but formula-then-
    /// literal left formula-value-with-cleared-formula-text). The fix rejects
    /// both orderings loudly with `ConflictingOps`.
    #[test]
    fn value_then_formula_on_same_cell_rejected_as_conflict() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        tx.put_value(0, 0, 0, Value::Number(99.0)).unwrap();
        let result = tx.put_formula(0, 0, 0, "10 + 5");
        match result {
            Err(RuntimeError::ConflictingOps { sheet, row, col }) => {
                assert_eq!((sheet, row, col), (0, 0, 0));
            }
            other => panic!("expected ConflictingOps, got {other:?}"),
        }
        // The first op stays buffered; the rejected op didn't.
        assert_eq!(tx.op_count(), 1);
        tx.commit().unwrap();
        // Final state reflects only the literal.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(99.0));
        assert!(wb.formula_at(0, 0, 0).is_none());
    }

    #[test]
    fn formula_then_value_on_same_cell_rejected_as_conflict() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        tx.put_formula(0, 0, 0, "10 + 5").unwrap();
        let result = tx.put_value(0, 0, 0, Value::Number(99.0));
        match result {
            Err(RuntimeError::ConflictingOps { sheet, row, col }) => {
                assert_eq!((sheet, row, col), (0, 0, 0));
            }
            other => panic!("expected ConflictingOps, got {other:?}"),
        }
        assert_eq!(tx.op_count(), 1);
        tx.commit().unwrap();
        // Final state reflects only the formula.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(15.0));
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("10 + 5"));
    }

    #[test]
    fn multiple_value_writes_on_same_cell_still_allowed_after_conflict_fix() {
        // Audit H4 introduces ConflictingOps for mixed-kind writes only. Same-kind
        // multi-writes (last-write-wins) must continue to work — pin it.
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_value(0, 0, 0, Value::Number(1.0)).unwrap();
        tx.put_value(0, 0, 0, Value::Number(2.0)).unwrap();
        tx.put_formula(0, 1, 0, "A1 + 100").unwrap();
        tx.put_formula(0, 1, 0, "A1 + 200").unwrap(); // last-write-wins for formulas
        tx.commit().unwrap();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(2.0));
        assert_eq!(wb.read(Address::new(0, 1, 0)), Value::Number(202.0));
        assert_eq!(wb.formula_at(0, 1, 0).map(|s| s.as_ref()), Some("A1 + 200"));
    }

    #[test]
    fn named_constant_resolves_inside_transaction() {
        let mut wb = make_wb();
        wb.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))
            .unwrap();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_formula(0, 0, 0, "1000 * TaxRate").unwrap();
        tx.commit().unwrap();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(210.0));
    }

    #[test]
    fn formula_error_value_propagates_through_commit() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        // 10/0 is a valid formula that evaluates to #DIV/0!. Commit applies it
        // without error — the error lives in the cell as a Value, not in the
        // commit return.
        tx.put_formula(0, 0, 0, "10 / 0").unwrap();
        tx.commit().unwrap();

        assert_eq!(
            wb.read(Address::new(0, 0, 0)),
            Value::Error(ErrorValue::DivZero)
        );
        // Formula text still persisted even on error-valued result.
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("10 / 0"));
    }

    #[test]
    fn paste_block_pattern_5x2_grid() {
        // The motivating use case: paste a small grid in one transaction, then
        // a formula referencing the block. Phase 1's scalar eval doesn't accept
        // range args (`SUM(A1:B5)` requires aggregate dispatch — Phase 2B+), so
        // the formula here references each cell individually. The point is that
        // 11 ops commit atomically and the formula sees every literal.
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        for r in 0..5u32 {
            tx.put_value(0, r, 0, Value::Number((r + 1) as f64))
                .unwrap();
            tx.put_value(0, r, 1, Value::Number(((r + 1) * 10) as f64))
                .unwrap();
        }
        tx.put_formula(0, 5, 0, "SUM(A1, B1, A2, B2, A3, B3, A4, B4, A5, B5)")
            .unwrap();
        assert_eq!(tx.op_count(), 11);
        tx.commit().unwrap();

        // Sum of 1,10, 2,20, 3,30, 4,40, 5,50 = 165.
        assert_eq!(wb.read(Address::new(0, 5, 0)), Value::Number(165.0));
    }

    // ===== Phase 2A.6 audit H1: sheet validation =====

    #[test]
    fn put_value_rejects_invalid_sheet() {
        let mut wb = make_wb(); // has one sheet (id 0)
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_value(99, 0, 0, Value::Number(1.0));
        match result {
            Err(RuntimeError::InvalidSheet { sheet, sheet_count }) => {
                assert_eq!(sheet, 99);
                assert_eq!(sheet_count, 1);
            }
            other => panic!("expected InvalidSheet, got {other:?}"),
        }
        assert_eq!(tx.op_count(), 0);
    }

    #[test]
    fn put_formula_rejects_invalid_sheet() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_formula(5, 0, 0, "1 + 1");
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidSheet {
                    sheet: 5,
                    sheet_count: 1
                })
            ),
            "expected InvalidSheet, got {result:?}"
        );
        assert_eq!(tx.op_count(), 0);
    }

    #[test]
    fn transaction_on_workbook_with_no_sheets_errors_at_buffer_time() {
        // Audit L5 regression guard: empty workbook (no sheets) used to panic at
        // commit time. Now: clean InvalidSheet error at buffer time.
        let mut wb = Workbook::new();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        let result = tx.put_value(0, 0, 0, Value::Number(1.0));
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidSheet {
                    sheet: 0,
                    sheet_count: 0
                })
            ),
            "expected InvalidSheet, got {result:?}"
        );
    }

    // ===== Phase 2A.7 audit H1: row/col validation =====

    #[test]
    fn put_value_rejects_row_above_max() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_value(0, 1_048_576, 0, Value::Number(1.0));
        assert!(
            matches!(
                result,
                Err(RuntimeError::InvalidCell { row: 1_048_576, .. })
            ),
            "expected InvalidCell, got {result:?}"
        );
        assert_eq!(tx.op_count(), 0);
    }

    #[test]
    fn put_formula_rejects_col_above_max() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_formula(0, 0, 16_384, "1 + 1");
        assert!(
            matches!(result, Err(RuntimeError::InvalidCell { col: 16_384, .. })),
            "expected InvalidCell, got {result:?}"
        );
        assert_eq!(tx.op_count(), 0);
    }

    #[test]
    fn put_value_at_max_row_max_col_ok() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_value(0, 1_048_575, 16_383, Value::Number(42.0))
            .unwrap();
        tx.commit().unwrap();
        assert_eq!(
            wb.read(Address::new(0, 1_048_575, 16_383)),
            Value::Number(42.0)
        );
    }

    // ===== Phase 2A.6 audit M2/M3: Blank/Error named-target rejection =====

    #[test]
    fn named_blank_constant_surfaces_as_distinct_bind_error() {
        use crate::plan::BindError;
        let mut wb = make_wb();
        wb.set_name("MyBlank", NamedTarget::Constant(Value::Blank))
            .unwrap();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_formula(0, 0, 0, "MyBlank + 1");
        match result {
            Err(RuntimeError::Bind(BindError::NamedTargetIsBlank(name))) => {
                // Parser canonicalizes to upper case.
                assert_eq!(name.as_ref(), "MYBLANK");
            }
            other => panic!("expected Bind(NamedTargetIsBlank), got {other:?}"),
        }
    }

    #[test]
    fn named_error_constant_surfaces_as_distinct_bind_error() {
        use crate::plan::BindError;
        let mut wb = make_wb();
        wb.set_name(
            "MyErr",
            NamedTarget::Constant(Value::Error(ErrorValue::DivZero)),
        )
        .unwrap();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let result = tx.put_formula(0, 0, 0, "MyErr + 1");
        match result {
            Err(RuntimeError::Bind(BindError::NamedTargetIsError(name, err))) => {
                assert_eq!(name.as_ref(), "MYERR");
                assert_eq!(err, ErrorValue::DivZero);
            }
            other => panic!("expected Bind(NamedTargetIsError), got {other:?}"),
        }
    }

    // ===== runtime → transaction integration =====

    #[test]
    fn runtime_transaction_method_returns_working_tx() {
        use crate::WorkbookRuntime;
        let mut wb = make_wb();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);

        let mut tx = rt.transaction();
        tx.put_value(0, 0, 0, Value::Number(7.0)).unwrap();
        tx.put_formula(0, 0, 1, "A1 * 2").unwrap();
        tx.commit().unwrap();

        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(7.0));
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(14.0));
    }

    /// Phase 2A.12 audit L6: 10k-op stress test for the paste-block use case.
    /// Asserts the buffer + commit can absorb a 10000-cell transaction in
    /// under 5 seconds on debug builds (release is much faster). Memory
    /// footprint isn't measured here (would need a custom allocator hook);
    /// the perf floor is the practical user-experience bound.
    #[test]
    fn stress_10k_op_paste_block_completes_under_5s_debug() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);

        let start = std::time::Instant::now();
        // 100 × 100 grid = 10_000 literal writes.
        for r in 0..100u32 {
            for c in 0..100u32 {
                tx.put_value(0, r, c, Value::Number((r * 100 + c) as f64))
                    .unwrap();
            }
        }
        assert_eq!(tx.op_count(), 10_000);
        tx.commit().unwrap();
        let elapsed = start.elapsed();
        assert!(
            elapsed.as_secs_f64() < 5.0,
            "10k-op stress took {elapsed:?}; perf-floor is 5s on debug"
        );

        // Spot-check a few cells to confirm the data landed.
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(0.0));
        assert_eq!(wb.read(Address::new(0, 50, 50)), Value::Number(5050.0));
        assert_eq!(wb.read(Address::new(0, 99, 99)), Value::Number(9999.0));
    }

    // ===== Phase 2A.3.b — op log producer wiring =====

    #[test]
    fn commit_empty_transaction_emits_no_batch_commit() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
            assert_eq!(tx.op_count(), 0);
            tx.commit().unwrap();
        }
        assert!(
            oplog.is_empty(),
            "empty commit must not append; got {} ops",
            oplog.len()
        );
    }

    #[test]
    fn commit_value_then_formula_emits_one_batch_commit_with_two_ops() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
            tx.put_value(0, 0, 0, Value::Number(10.0)).unwrap();
            tx.put_formula(0, 0, 1, "A1 * 2").unwrap();
            tx.commit().unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1, "expected one BatchCommit, got {ops:?}");
        match &ops[0] {
            Op::BatchCommit { ops: inner } => {
                assert_eq!(inner.len(), 2);
                assert!(matches!(inner[0], Op::PutValue { .. }));
                assert!(matches!(inner[1], Op::PutFormula { .. }));
            }
            other => panic!("expected BatchCommit, got {other:?}"),
        }
    }

    #[test]
    fn commit_value_over_existing_formula_emits_clear_formula_inside_batch() {
        let mut wb = make_wb();
        // Pre-existing formula at (0, 0); transaction writes a literal.
        wb.put_at(0, 0, 0, Value::Number(5.0));
        wb.put_formula(0, 0, 0, "1 + 4");
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
            tx.put_value(0, 0, 0, Value::Number(99.0)).unwrap();
            tx.commit().unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        match &ops[0] {
            Op::BatchCommit { ops: inner } => {
                // PutValue + ClearFormula because cell had a pre-existing
                // formula before the transaction.
                assert_eq!(inner.len(), 2);
                assert!(matches!(inner[0], Op::PutValue { .. }));
                assert!(matches!(inner[1], Op::ClearFormula { .. }));
            }
            other => panic!("expected BatchCommit, got {other:?}"),
        }
    }

    #[test]
    fn dropping_transaction_without_commit_emits_nothing() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
            tx.put_value(0, 0, 0, Value::Number(7.0)).unwrap();
            // Drop without commit.
        }
        assert!(oplog.is_empty());
    }

    #[test]
    fn transaction_via_runtime_inherits_oplog_handle() {
        use crate::WorkbookRuntime;
        let mut wb = make_wb();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            // Direct edit via the runtime → one PutValue op.
            rt.set_value(0, 0, 0, Value::Number(1.0)).unwrap();
            // Now run a transaction; its commit should emit one BatchCommit.
            let mut tx = rt.transaction();
            tx.put_value(0, 0, 1, Value::Number(2.0)).unwrap();
            tx.put_formula(0, 0, 2, "A1 + B1").unwrap();
            tx.commit().unwrap();
            // After the transaction, the runtime can still emit more direct
            // edits.
            rt.set_value(0, 0, 3, Value::Number(99.0)).unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // 1 direct PutValue + 1 BatchCommit (2 inner) + 1 direct PutValue = 3
        assert_eq!(ops.len(), 3);
        assert!(matches!(ops[0], Op::PutValue { .. }));
        assert!(matches!(ops[1], Op::BatchCommit { .. }));
        assert!(matches!(ops[2], Op::PutValue { .. }));
    }

    #[test]
    fn transaction_without_oplog_still_works() {
        let mut wb = make_wb();
        let reg = default_registry();
        let mut tx = WorkbookTransaction::new(&mut wb, &reg);
        tx.put_value(0, 0, 0, Value::Number(7.0)).unwrap();
        tx.put_formula(0, 0, 1, "A1 + 3").unwrap();
        tx.commit().unwrap();
        assert_eq!(wb.read(Address::new(0, 0, 0)), Value::Number(7.0));
        assert_eq!(wb.read(Address::new(0, 0, 1)), Value::Number(10.0));
    }

    #[test]
    fn commit_emits_clear_formula_only_for_pre_existing_formula_cells() {
        // Mixed-batch test: one Value op on a previously-formula cell (should
        // emit PutValue + ClearFormula); one Value op on a blank cell (should
        // emit just PutValue); one Formula op (should emit PutFormula).
        let mut wb = make_wb();
        wb.put_at(0, 0, 0, Value::Number(50.0));
        wb.put_formula(0, 0, 0, "10 * 5"); // pre-existing formula
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut tx = WorkbookTransaction::with_oplog(&mut wb, &reg, &mut oplog);
            tx.put_value(0, 0, 0, Value::Number(100.0)).unwrap(); // over formula
            tx.put_value(0, 0, 1, Value::Number(200.0)).unwrap(); // blank cell
            tx.put_formula(0, 0, 2, "A1 + B1").unwrap();
            tx.commit().unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        match &ops[0] {
            Op::BatchCommit { ops: inner } => {
                // First op: PutValue(0,0,0) + ClearFormula(0,0,0) = 2
                // Second op: PutValue(0,0,1) = 1
                // Third op: PutFormula(0,0,2) = 1
                // Total inner: 4
                assert_eq!(inner.len(), 4, "inner ops were: {inner:?}");
            }
            other => panic!("expected BatchCommit, got {other:?}"),
        }
    }
}

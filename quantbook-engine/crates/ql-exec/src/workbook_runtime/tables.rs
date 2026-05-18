//! Table mutation API for `WorkbookRuntime`.
//!
//! Tier D1 Step 3.5 (2026-05-18): extracted from `mod.rs` per
//! `docs/architecture/workbook-runtime-split-design.md`. Six
//! producer-side table methods + a private re-extract helper.
//! Pure code move; no behavior change.
//!
//! Methods:
//! - [`WorkbookRuntime::create_table`] (W5-118) — register a new
//!   workbook-scoped table with column validation, footprint
//!   uniqueness, name collision, op-log emission.
//! - [`WorkbookRuntime::drop_table`] (W5-118) — drop a table,
//!   surface a dropped-table BindError on next recompute of any
//!   formula that referenced it (design § 12.4).
//! - [`WorkbookRuntime::rename_table`] (W5-119) — rename + rewrite
//!   every `Table[Col]` reference in stored formula text via
//!   lex→parse→rewrite→print, emit BatchCommit atomically.
//! - [`WorkbookRuntime::rename_column`] (W5-121) — rename a column
//!   inside a table, rewrite stored formula text.
//! - [`WorkbookRuntime::resize_table`] (W5-122) — change a table's
//!   row/column footprint with validation.
//! - `reextract_table_readers` (private helper) — re-extract calc
//!   graph dep info for every formula that references a renamed
//!   table.

use std::sync::Arc;

use ql_formula_syntax::{lex, lex_with, parse};
use ql_oplog::Op;
use ql_types::{ColId, RowId, SheetId};

use crate::plan::{bind_with_site, BindSite};
use crate::plan_cache::PlanCacheKey;

use super::{RuntimeError, WorkbookRuntime};

impl<'a> WorkbookRuntime<'a> {
    // ===== W5-118 (Phase 4.8.H) — table mutation API =====

    /// **W5-118 (Phase 4.8.H):** register a new workbook-scoped table,
    /// emitting `Op::CreateTable` into the attached op log (if any).
    ///
    /// Validation (op log append is BEFORE storage mutation per the
    /// W5-103 atomicity pattern):
    /// - Sheet exists.
    /// - Footprint fits in the sheet (rows + cols > 0).
    /// - No overlap with any existing table footprint.
    /// - Name is unique against both `TableTable` AND `NameTable`
    ///   (shared namespace per design § 4.3 / § 13 decision #3).
    /// - Column count matches `column_names.len()`.
    /// - Column names are non-empty and unique case-insensitively.
    ///
    /// Each column is assigned a stable id from
    /// `TableTable::allocate_column_id`. Header / totals rows are
    /// metadata-only — this method does NOT write into the header row;
    /// callers can pre-populate cells via `set_value`.
    ///
    /// Direct callers of `Workbook::tables_mut().insert` bypass the op
    /// log silently — that path is documented as low-level (qbook
    /// loader + tests).
    #[allow(clippy::too_many_arguments)]
    pub fn create_table(
        &mut self,
        name: &str,
        sheet: SheetId,
        top_row: RowId,
        top_col: ColId,
        rows: u32,
        cols: u32,
        has_header: bool,
        has_totals: bool,
        column_names: Vec<String>,
    ) -> Result<(), RuntimeError> {
        let canonical = name.to_ascii_uppercase();
        // ----- Validation (all checks BEFORE op-log append) -----
        let sheet_count = self.workbook.sheet_count();
        if self.workbook.sheet(sheet).is_none() {
            return Err(RuntimeError::InvalidSheet { sheet, sheet_count });
        }
        if rows == 0 || cols == 0 {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "table rows and cols must both be > 0",
            });
        }
        // **W5-125 (Phase 4.8.O.1 — Codex HIGH-1):** validate footprint
        // upper bound fits within MAX_ROW / MAX_COLUMN. Closes the gap
        // where `for r in top_row..top_row + rows` either ran beyond
        // the addressable grid or u32-overflowed silently.
        if let Err(reason) =
            ql_storage::TableMetadata::validate_footprint_bounds(top_row, top_col, rows, cols)
        {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason,
            });
        }
        if column_names.len() != cols as usize {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "column_names length does not match cols",
            });
        }
        if column_names.iter().any(|s| s.is_empty()) {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "table column names cannot be empty",
            });
        }
        // Column-name uniqueness (case-insensitive).
        {
            use std::collections::HashSet;
            let mut seen: HashSet<String> = HashSet::new();
            for cn in &column_names {
                if !seen.insert(cn.to_ascii_lowercase()) {
                    return Err(RuntimeError::TableCreateRejected {
                        name: name.to_owned(),
                        reason: "table column names must be unique (case-insensitive)",
                    });
                }
            }
        }
        // Name uniqueness (shared namespace: TableTable + NameTable).
        if self.workbook.tables().lookup(&canonical).is_some() {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "table with this canonical name already exists",
            });
        }
        if self.workbook.names().lookup_ci(&canonical).is_some() {
            return Err(RuntimeError::TableCreateRejected {
                name: name.to_owned(),
                reason: "defined-name with this canonical name already exists (shared namespace)",
            });
        }
        // Non-overlap + no spill anchor inside the footprint.
        // **W5-124 (Phase 4.8.J.2):** spill-anchor invariant § 4.3 #5 —
        // Excel canon: array formulas can't anchor inside a table.
        // Previously enforced only at `write_spill` time (the write-side
        // check consults `Workbook::table_at(anchor)`); creating a
        // table over an existing anchor was silently allowed, leaving
        // the table claiming a cell whose value is computed-from-spill.
        // Single fused loop avoids walking the proposed footprint twice.
        for r in top_row..top_row + rows {
            for c in top_col..top_col + cols {
                if self.workbook.table_at(sheet, r, c).is_some() {
                    return Err(RuntimeError::TableCreateRejected {
                        name: name.to_owned(),
                        reason: "table footprint overlaps an existing table",
                    });
                }
                if self.workbook.spill_anchor_at(sheet, r, c).is_some() {
                    return Err(RuntimeError::TableCreateRejected {
                        name: name.to_owned(),
                        reason: "table footprint contains a spill anchor",
                    });
                }
            }
        }
        // ----- Op-log append (BEFORE mutation per W5-103 atomicity) -----
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::CreateTable {
                name: canonical.clone(),
                sheet,
                top_row,
                top_col,
                rows,
                cols,
                has_header,
                has_totals,
                column_names: column_names.clone(),
            })?;
        }
        // ----- Mutation -----
        use ql_storage::{TableColumn, TableMetadata};
        let columns: Vec<TableColumn> = column_names
            .iter()
            .map(|cn| TableColumn {
                id: self.workbook.tables_mut().allocate_column_id(),
                name: Arc::from(cn.to_ascii_lowercase().as_str()),
                display: Arc::from(cn.as_str()),
                totals_function: None,
            })
            .collect();
        let meta = TableMetadata {
            name: Arc::from(canonical.as_str()),
            display_name: Arc::from(name),
            sheet,
            top_row,
            top_col,
            rows,
            cols,
            has_header,
            has_totals,
            columns,
        };
        self.workbook
            .tables_mut()
            .insert(Arc::from(canonical.as_str()), meta);
        Ok(())
    }

    /// **W5-118 (Phase 4.8.H):** drop a table's metadata. Cells inside
    /// the table footprint are untouched. Formulas referencing the
    /// dropped table re-bind to `BindError::UnknownTable` on next
    /// recompute. Emits `Op::DropTable` to the attached op log (if any).
    ///
    /// **W5-155 (Phase 4.8.G.3):** also fires the calcgraph's
    /// `on_table_drop` hook (W5-154) so formulas previously
    /// referencing this table get BFS-dirty-fanned. Pre-W5-155 the
    /// drop completed without notifying the calcgraph — formulas
    /// with cached `ExprPlan::StructuredRef` plans would continue
    /// reading the (now-untyped) cell range until something else
    /// invalidated them. Post-W5-155 the hook fires:
    /// 1. `table_to_formulas[name]` enumerates the readers.
    /// 2. Each reader marked dirty + BFS-fanout (W5-91 H2 pattern).
    /// 3. Next recompute re-binds → `BindError::UnknownTable` →
    ///    `Value::Error(#NAME?)` per the existing 4.8.F binder.
    ///
    /// The hook fires AFTER the op-log append (atomic with the
    /// mutation, per W5-103) and BEFORE `tables_mut().remove`
    /// (graph fanout is read-only on workbook state; the order
    /// is irrelevant for correctness but matches the pre-existing
    /// rename/resize convention).
    pub fn drop_table(&mut self, name: &str) -> Result<(), RuntimeError> {
        let canonical = name.to_ascii_uppercase();
        if self.workbook.tables().lookup(&canonical).is_none() {
            return Err(RuntimeError::TableNotFound(name.to_owned()));
        }
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::DropTable {
                name: canonical.clone(),
            })?;
        }
        // **W5-155 (Phase 4.8.G.3):** dirty-fan readers BEFORE
        // removing the metadata. The hook receives the canonical
        // uppercase name; the index is keyed identically so the
        // exact-match path always hits.
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_table_drop(&canonical);
        }
        let _ = self.workbook.tables_mut().remove(&canonical);
        // **W5-156 (Phase 4.8.G.3 — HIGH-1 closure):** invalidate
        // the plan cache. `PlanCacheKey` doesn't include
        // `TableTable::generation()`, so a pre-drop cached plan
        // (`ExprPlan::StructuredRef { resolved: <pre-drop range> }`)
        // would HIT on the next recompute and silently read the
        // old cells — masking the W5-154 hook's dirty fanout and
        // violating the design § 12.4 contract ("re-bind to
        // BindError::UnknownTable → emit #NAME?"). Matches the
        // brute-force pattern in `rename_table` / `rename_column`
        // / `resize_table`. A future polish (table_gen in the
        // cache key) would replace this full flush with targeted
        // invalidation.
        self.plan_cache.clear();
        Ok(())
    }

    /// **W5-119 (Phase 4.8.I):** rename a table. Per design § 12.2 + HIGH-1
    /// closure (Codex pass-1), this REWRITES STORED FORMULA TEXT — Excel
    /// canon: the next bind sees the new name and binds successfully.
    ///
    /// Process:
    /// 1. Validate: source exists; target name available (TableTable +
    ///    NameTable shared namespace); not a no-op (same canonical name).
    /// 2. Op-log append `Op::RenameTable` (before any mutation).
    /// 3. Walk every formula cell; parse the text; rewrite via
    ///    `ast::rewrite_table_ref`; if the AST changed, print it back
    ///    and emit `Op::PutFormula` + update storage.
    /// 4. Re-key the `TableTable` entry from old canonical to new
    ///    canonical; update display_name.
    ///
    /// Returns the number of formula cells whose text was rewritten.
    ///
    /// **Tier D1 Step 3.2 doc-attachment fix:** the doc block above
    /// was previously misattached to `set_reference_mode` because
    /// that fn was inserted between this comment and `rename_table`.
    /// Step 3.2 moved the config setters to `config.rs`, so the doc
    /// now reaches its intended target.
    pub fn rename_table(&mut self, old_name: &str, new_name: &str) -> Result<usize, RuntimeError> {
        let old_canonical = old_name.to_ascii_uppercase();
        let new_canonical = new_name.to_ascii_uppercase();
        if self.workbook.tables().lookup(&old_canonical).is_none() {
            return Err(RuntimeError::TableNotFound(old_name.to_owned()));
        }
        // No-op rename (same canonical) — accept silently without
        // emitting an op so the log stays compact.
        if old_canonical == new_canonical {
            return Ok(0);
        }
        // Target uniqueness.
        if self.workbook.tables().lookup(&new_canonical).is_some() {
            return Err(RuntimeError::TableCreateRejected {
                name: new_name.to_owned(),
                reason: "table with this canonical name already exists (rename target)",
            });
        }
        if self.workbook.names().lookup_ci(&new_canonical).is_some() {
            return Err(RuntimeError::TableCreateRejected {
                name: new_name.to_owned(),
                reason: "defined-name with this canonical name already exists (rename target)",
            });
        }
        // Op-log append BEFORE mutation (W5-103 atomicity). We emit
        // RenameTable + N PutFormula ops; if the log append fails,
        // no workbook state has changed yet.
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::RenameTable {
                old_name: old_canonical.clone(),
                new_name: new_canonical.clone(),
            })?;
        }
        // Walk formula cells and rewrite. Collect first to avoid borrow
        // conflicts (iter holds &workbook; rewrite needs &mut workbook).
        let new_display_arc: Arc<str> = Arc::from(new_name);
        let formulas: Vec<(SheetId, RowId, ColId, Arc<str>)> = self
            .workbook
            .iter_formulas()
            .map(|(s, r, c, text)| (s, r, c, Arc::clone(text)))
            .collect();
        let mut rewritten = 0;
        for (s, r, c, text) in formulas {
            let tokens = match lex(text.as_ref()) {
                Ok(t) => t,
                Err(_) => continue, // malformed → leave alone (rewrite is best-effort)
            };
            let expr = match parse(tokens) {
                Ok(e) => e,
                Err(_) => continue,
            };
            let new_expr =
                ql_formula_syntax::rewrite_table_ref(&expr, &old_canonical, &new_display_arc);
            if new_expr == expr {
                continue; // no StructuredRef references the renamed table
            }
            let new_text = ql_formula_syntax::print(&new_expr);
            // Emit PutFormula so replay reconstructs the rewrite.
            if let Some(oplog) = self.oplog.as_deref_mut() {
                oplog.append(Op::PutFormula {
                    sheet: s,
                    row: r,
                    col: c,
                    text: new_text.clone(),
                })?;
            }
            // Update workbook formula text directly (bypass set_formula
            // to avoid re-running the bind eagerly; the recompute path
            // will re-bind against the new name at next eval).
            self.workbook.put_formula(s, r, c, new_text);
            rewritten += 1;
        }
        // Re-key the TableTable entry.
        let mut meta = self
            .workbook
            .tables_mut()
            .remove(&old_canonical)
            .expect("verified at top");
        let new_canonical_arc: Arc<str> = Arc::from(new_canonical.as_str());
        meta.name = Arc::clone(&new_canonical_arc);
        meta.display_name = Arc::clone(&new_display_arc);
        self.workbook.tables_mut().insert(new_canonical_arc, meta);
        // **W5-157 (Phase 4.8.G.3):** fire the calcgraph hook to
        // re-key `table_to_formulas[OLD] → [NEW]`, substitute the
        // Arc<str> in each reader's `deps.tables` so a future
        // `remove_formula_deps` cleans up correctly, and dirty-fan
        // the readers. Without this, a subsequent `drop_table(NEW)`
        // would miss every formula that previously bound against
        // `OLD` (the index still keys them under the stale name).
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_table_rename(&old_canonical, &new_canonical);
        }
        // Invalidate plan cache by clearing — every formula that
        // referenced the OLD name now has new text, so cache lookups
        // miss anyway; the bare invalidation prevents stale entries.
        self.plan_cache.clear();
        Ok(rewritten)
    }

    /// **W5-121 (Phase 4.8.I.2):** rename a column within an existing
    /// table. Mirrors [`Self::rename_table`] semantics for column refs:
    /// rewrites stored formula text in every cell whose StructuredRef
    /// references the renamed column (Excel canon — the next bind sees
    /// the new name).
    ///
    /// Process:
    /// 1. Validate: table exists; source column exists (case-insensitive);
    ///    target name available within the table; non-empty; not a no-op
    ///    (same lowercase canonical).
    /// 2. Op-log append `Op::RenameColumn` (before any mutation).
    /// 3. Walk every formula cell; parse the text; rewrite via
    ///    `ast::rewrite_column_ref` (scoped to refs matching the
    ///    canonical table name); if the AST changed, print + emit
    ///    `Op::PutFormula` + update storage.
    /// 4. Mutate the matching `TableColumn` entry's lowercase canonical
    ///    `name` and case-preserving `display`; bump TableTable
    ///    generation so plan caches invalidate.
    ///
    /// Returns the number of formula cells whose text was rewritten.
    /// Cross-table isolation: structured refs to OTHER tables pass
    /// through unchanged even when they mention a column with the same
    /// name. Same-canonical rename returns `Ok(0)` without emitting an
    /// op (mirrors [`Self::rename_table`]).
    pub fn rename_column(
        &mut self,
        table_name: &str,
        old_col: &str,
        new_col: &str,
    ) -> Result<usize, RuntimeError> {
        let table_canonical = table_name.to_ascii_uppercase();
        // Validate table exists.
        let meta = self
            .workbook
            .tables()
            .lookup(&table_canonical)
            .ok_or_else(|| RuntimeError::TableNotFound(table_name.to_owned()))?;
        // Validate source column exists.
        if meta.lookup_column(old_col).is_none() {
            return Err(RuntimeError::TableColumnNotFound {
                table: table_name.to_owned(),
                column: old_col.to_owned(),
            });
        }
        // Empty target rejected.
        if new_col.is_empty() {
            return Err(RuntimeError::TableColumnRejected {
                table: table_name.to_owned(),
                column: new_col.to_owned(),
                reason: "column name cannot be empty",
            });
        }
        // No-op rename (same lowercase canonical) — accept silently
        // without emitting an op. Mirrors `rename_table`. Display-only
        // case rename is deferred to a future sub-phase.
        let old_lower = old_col.to_ascii_lowercase();
        let new_lower = new_col.to_ascii_lowercase();
        if old_lower == new_lower {
            return Ok(0);
        }
        // Target uniqueness within the table.
        if meta.lookup_column(new_col).is_some() {
            return Err(RuntimeError::TableColumnRejected {
                table: table_name.to_owned(),
                column: new_col.to_owned(),
                reason: "column with this canonical name already exists (rename target)",
            });
        }
        // Op-log append BEFORE mutation (W5-103 atomicity). RenameColumn
        // + N PutFormula ops; if the log append fails, no workbook state
        // has changed yet.
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::RenameColumn {
                table: table_canonical.clone(),
                old_name: old_col.to_owned(),
                new_name: new_col.to_owned(),
            })?;
        }
        // Walk formula cells and rewrite. Collect first to avoid borrow
        // conflicts (iter holds &workbook; rewrite needs &mut workbook).
        let new_display_arc: Arc<str> = Arc::from(new_col);
        let formulas: Vec<(SheetId, RowId, ColId, Arc<str>)> = self
            .workbook
            .iter_formulas()
            .map(|(s, r, c, text)| (s, r, c, Arc::clone(text)))
            .collect();
        let mut rewritten = 0;
        for (s, r, c, text) in formulas {
            let tokens = match lex(text.as_ref()) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let expr = match parse(tokens) {
                Ok(e) => e,
                Err(_) => continue,
            };
            let new_expr = ql_formula_syntax::rewrite_column_ref(
                &expr,
                &table_canonical,
                old_col,
                &new_display_arc,
            );
            if new_expr == expr {
                continue;
            }
            let new_text = ql_formula_syntax::print(&new_expr);
            if let Some(oplog) = self.oplog.as_deref_mut() {
                oplog.append(Op::PutFormula {
                    sheet: s,
                    row: r,
                    col: c,
                    text: new_text.clone(),
                })?;
            }
            self.workbook.put_formula(s, r, c, new_text);
            rewritten += 1;
        }
        // Mutate the column metadata in place.
        let meta = self
            .workbook
            .tables_mut()
            .get_mut(&table_canonical)
            .expect("verified at top");
        let (col_idx, _) = meta
            .lookup_column(old_col)
            .expect("verified at top before any mutation");
        meta.columns[col_idx as usize].name = Arc::from(new_lower.as_str());
        meta.columns[col_idx as usize].display = Arc::clone(&new_display_arc);
        // `get_mut` doesn't bump generation; do it explicitly so plan
        // caches keyed on `TableTable::generation` invalidate.
        self.workbook.tables_mut().bump_generation();
        // **W5-158 (Phase 4.8.G.3):** fire the calcgraph hook so the
        // dirty set picks up every reader of this table. Coarse —
        // table-keyed rather than column-keyed (the reverse index
        // doesn't track columns). VEQ at recompute time suppresses
        // the typical no-op writes; the hook's value is keeping
        // the post-rename plan cache + dirty state machine
        // consistent for downstream tooling (debug, ql-profile).
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_column_rename(&table_canonical, old_col, new_col);
        }
        // Invalidate plan cache by clearing — every formula that
        // referenced the OLD column now has new text, so cache lookups
        // miss anyway; bare invalidation prevents stale entries.
        self.plan_cache.clear();
        Ok(rewritten)
    }

    /// **W5-122 (Phase 4.8.J):** resize a table's footprint per
    /// design § 12.3. Three scenarios are supported by a single op:
    ///
    /// - **Grow / shrink rows:** common path. Pass `added_columns =
    ///   removed_columns = []` and the new row count.
    /// - **Append column(s) at the END:** list each new display name
    ///   in `added_columns`; column ids are freshly allocated.
    /// - **Truncate trailing column(s):** list each in
    ///   `removed_columns` in their current left-to-right order
    ///   (case-insensitive on display).
    ///
    /// Inserting / removing a column in the MIDDLE is NOT supported in
    /// 4.8 (Phase 5 structural edits — requires physical cell move).
    ///
    /// Validation (all BEFORE op-log append per W5-103 atomicity):
    /// - Table exists.
    /// - `new_rows > 0` AND `new_cols > 0`.
    /// - `removed_columns.len() <= old_cols`.
    /// - Arithmetic: `new_cols == old_cols + added.len() - removed.len()`.
    /// - `removed_columns` exactly match trailing columns (case-insensitive).
    /// - `added_columns`: non-empty entries; final roster has unique
    ///   canonical (lowercase) names.
    /// - New footprint cells outside the OLD footprint don't overlap
    ///   another table.
    ///
    /// NOTE: a spill-anchor check inside the new footprint is
    /// intentionally OMITTED to mirror `create_table`, which doesn't
    /// check either. The runtime invariant § 4.3 #5 is enforced at
    /// `write_spill` time today; closing this uniformly across
    /// create+resize is a separate follow-up.
    ///
    /// No formula-text rewriting: resize doesn't change column NAMES
    /// of surviving columns, so existing references stay valid.
    /// Re-binding picks up the new range/columns on next eval via the
    /// cleared plan cache.
    ///
    /// **W5-159 (Phase 4.8.G.3):** resize bumps `TableTable::generation`,
    /// clears the plan cache, **re-extracts deps for every table reader**
    /// (via [`Self::reextract_table_readers`] so range stripes reflect
    /// the new range — critical: pre-W5-159 a write into the new growth
    /// area silently missed the formula's stripe), and fires the
    /// [`CalcgraphSession::on_table_resize`] hook to BFS-dirty-fan
    /// downstream readers. Downstream evaluation via
    /// [`Self::recompute_dirty`] then refreshes the `COMPUTED` overlay
    /// against the new metadata. With no graph attached, the
    /// `reextract_table_readers` step is a no-op and callers must use
    /// [`Self::recompute_all`] to pick up post-resize changes.
    pub fn resize_table(
        &mut self,
        name: &str,
        new_rows: u32,
        new_cols: u32,
        added_columns: Vec<String>,
        removed_columns: Vec<String>,
    ) -> Result<(), RuntimeError> {
        use ql_storage::TableColumn;
        let canonical = name.to_ascii_uppercase();
        // Snapshot the immutable bits we need to validate.
        let (sheet, top_row, top_col, old_rows, old_cols, old_displays) = {
            let meta = self
                .workbook
                .tables()
                .lookup(&canonical)
                .ok_or_else(|| RuntimeError::TableNotFound(name.to_owned()))?;
            (
                meta.sheet,
                meta.top_row,
                meta.top_col,
                meta.rows,
                meta.cols,
                meta.columns
                    .iter()
                    .map(|c| c.display.as_ref().to_owned())
                    .collect::<Vec<_>>(),
            )
        };
        // **W5-127 (Phase 4.8.O.3 — Codex LOW-1):** exact no-op
        // short-circuit. Mirrors `rename_column`'s same-canonical
        // semantics. Avoids emitting an `Op::ResizeTable`, bumping
        // `TableTable::generation`, and clearing the plan cache when
        // nothing actually changes. The table is known to exist
        // (snapshot above would have errored). All dims match and no
        // columns are being added/removed, so there's nothing to
        // mutate.
        if new_rows == old_rows
            && new_cols == old_cols
            && added_columns.is_empty()
            && removed_columns.is_empty()
        {
            return Ok(());
        }
        if new_rows == 0 || new_cols == 0 {
            return Err(RuntimeError::TableResizeRejected {
                name: name.to_owned(),
                reason: "table rows and cols must both be > 0",
            });
        }
        // **W5-125 (Phase 4.8.O.1 — Codex HIGH-1):** validate footprint
        // upper bound. `top_row` + `top_col` are inherited from the
        // existing TableMetadata (so they were validated at create
        // time), but new_rows / new_cols can extend past the addressable
        // grid; check before the overlap / spill-anchor walk.
        if let Err(reason) = ql_storage::TableMetadata::validate_footprint_bounds(
            top_row, top_col, new_rows, new_cols,
        ) {
            return Err(RuntimeError::TableResizeRejected {
                name: name.to_owned(),
                reason,
            });
        }
        let added_len = added_columns.len() as u32;
        let removed_len = removed_columns.len() as u32;
        if removed_len > old_cols {
            return Err(RuntimeError::TableResizeRejected {
                name: name.to_owned(),
                reason: "removed_columns count exceeds existing column count",
            });
        }
        if new_cols != old_cols + added_len - removed_len {
            return Err(RuntimeError::TableResizeRejected {
                name: name.to_owned(),
                reason: "new_cols does not match old_cols + added - removed",
            });
        }
        // removed_columns must exactly match trailing displays
        // (case-insensitive).
        let trailing_start = (old_cols - removed_len) as usize;
        for (i, expected) in removed_columns.iter().enumerate() {
            let idx = trailing_start + i;
            if !old_displays[idx].eq_ignore_ascii_case(expected) {
                return Err(RuntimeError::TableResizeRejected {
                    name: name.to_owned(),
                    reason: "removed_columns do not match trailing columns",
                });
            }
        }
        if added_columns.iter().any(|s| s.is_empty()) {
            return Err(RuntimeError::TableResizeRejected {
                name: name.to_owned(),
                reason: "added column names cannot be empty",
            });
        }
        // Build the final canonical (lowercase) roster + check
        // uniqueness.
        let mut final_canon: Vec<String> = old_displays
            .iter()
            .take(trailing_start)
            .map(|d| d.to_ascii_lowercase())
            .collect();
        for a in &added_columns {
            final_canon.push(a.to_ascii_lowercase());
        }
        {
            use std::collections::HashSet;
            let mut seen: HashSet<&str> = HashSet::new();
            for cn in &final_canon {
                if !seen.insert(cn.as_str()) {
                    return Err(RuntimeError::TableResizeRejected {
                        name: name.to_owned(),
                        reason: "final column roster has duplicate canonical names",
                    });
                }
            }
        }
        // Footprint-overlap + no-spill-anchor checks: only cells NEWLY
        // claimed need checking (cells in the OLD footprint already
        // belong to this table; create_table verified them at creation
        // time).
        // **W5-124 (Phase 4.8.J.2):** spill-anchor check mirrors
        // create_table's, restricted to newly-claimed cells.
        let old_end_row = top_row + old_rows;
        let old_end_col = top_col + old_cols;
        let new_end_row = top_row + new_rows;
        let new_end_col = top_col + new_cols;
        for r in top_row..new_end_row {
            for c in top_col..new_end_col {
                let inside_old = r < old_end_row && c < old_end_col;
                if inside_old {
                    continue;
                }
                if let Some(other) = self.workbook.table_at(sheet, r, c) {
                    if !other.name.eq_ignore_ascii_case(&canonical) {
                        return Err(RuntimeError::TableResizeRejected {
                            name: name.to_owned(),
                            reason: "new footprint overlaps an existing table",
                        });
                    }
                }
                if self.workbook.spill_anchor_at(sheet, r, c).is_some() {
                    return Err(RuntimeError::TableResizeRejected {
                        name: name.to_owned(),
                        reason: "new footprint contains a spill anchor",
                    });
                }
            }
        }
        // ----- Op-log append (BEFORE mutation per W5-103) -----
        if let Some(oplog) = self.oplog.as_deref_mut() {
            oplog.append(Op::ResizeTable {
                name: canonical.clone(),
                new_rows,
                new_cols,
                added_columns: added_columns.clone(),
                removed_columns: removed_columns.clone(),
            })?;
        }
        // ----- Mutation -----
        // Allocate new column ids first; mutable borrows on TableTable
        // versus TableMetadata conflict otherwise.
        let new_ids: Vec<u32> = (0..added_columns.len())
            .map(|_| self.workbook.tables_mut().allocate_column_id())
            .collect();
        let meta = self
            .workbook
            .tables_mut()
            .get_mut(&canonical)
            .expect("verified at top");
        meta.rows = new_rows;
        meta.cols = new_cols;
        meta.columns
            .truncate(meta.columns.len() - removed_len as usize);
        for (cn, id) in added_columns.iter().zip(new_ids) {
            meta.columns.push(TableColumn {
                id,
                name: Arc::from(cn.to_ascii_lowercase().as_str()),
                display: Arc::from(cn.as_str()),
                totals_function: None,
            });
        }
        self.workbook.tables_mut().bump_generation();
        // Full plan-cache flush so formulas re-bind against the new
        // range/column roster on next eval. Targeted `table_gen`-keyed
        // invalidation (W5-160) is optional polish; the brute-force
        // clear is correct, just coarser. Dirty propagation is
        // handled below via `reextract_table_readers` + the W5-159
        // `on_table_resize` hook.
        self.plan_cache.clear();
        // **W5-159 (Phase 4.8.G.3):** the resolved range each reader
        // bound against is now stale (rows or cols changed). Re-extract
        // deps for every reader so the calcgraph's range stripes
        // reflect the new range — without this, cell writes inside
        // the NEW range but OUTSIDE the OLD range would silently miss
        // the formula's stripe and never dirty it. Must run BEFORE
        // the hook fires (which dirty-fans via BFS through the
        // freshly-registered stripes).
        self.reextract_table_readers(&canonical);
        if let Some(g) = self.graph.as_deref_mut() {
            g.on_table_resize(&canonical);
        }
        Ok(())
    }

    /// **W5-159 (Phase 4.8.G.3):** re-bind every formula registered
    /// against `table_canonical` and call `reextract_deps` so the
    /// calcgraph's range-stripe state matches the new resolved range.
    /// Used after `resize_table` mutates `TableMetadata.rows`/`.cols`.
    ///
    /// Pattern mirrors `reextract_spill_footprint_readers` (W5-103):
    /// step 1 collects readers under an immutable graph borrow; step 2
    /// re-binds + re-extracts under alternating immutable workbook /
    /// mutable graph borrows. A bind failure (e.g., a column was
    /// removed by the resize) marks the reader dirty so
    /// `recompute_dirty`'s W5-156 bind-error mapping produces `#NAME?`
    /// at the cell.
    fn reextract_table_readers(&mut self, table_canonical: &str) {
        // Step 1: collect (node, sheet, row, col, text) under an
        // immutable borrow of the graph + workbook.
        let reader_info: Vec<(ql_calcgraph::NodeId, SheetId, RowId, ColId, Arc<str>)> = {
            let g = match self.graph.as_deref() {
                Some(g) => g,
                None => return,
            };
            g.dependents_for_table(table_canonical)
                .into_iter()
                .filter_map(|n| {
                    let (s, r, c) = g.cell_address_for(n)?;
                    let text = self.workbook.formula_at(s, r, c).cloned()?;
                    Some((n, s, r, c, text))
                })
                .collect()
        };

        // Step 2: re-bind + re-extract.
        for (node, sheet, row, col, text) in reader_info {
            let name_gen = self.workbook.names().generation();
            let cell_anchor = if text.contains('@') {
                Some((row, col))
            } else {
                None
            };
            let cache_key = PlanCacheKey {
                text: Arc::clone(&text),
                sheet,
                name_gen,
                cell_anchor,
            };
            let plan: Arc<crate::plan::ExprPlan> = match self
                .plan_cache
                .get_or_insert::<_, RuntimeError>(cache_key, || {
                    // W5-147: stored text is canonical A1+EnUs.
                    let tokens = lex_with(
                        text.as_ref(),
                        ql_types::ReferenceMode::A1,
                        ql_types::Locale::EnUs,
                    )?;
                    let expr = parse(tokens)?;
                    Ok(bind_with_site(
                        &expr,
                        BindSite::at_cell(ql_types::Address::new(sheet, row, col)),
                        self.workbook,
                        self.workbook,
                        self.workbook,
                    )?)
                }) {
                Ok(p) => p,
                Err(_) => {
                    // Bind broken by the resize (e.g., column removed).
                    // Mark dirty; recompute_dirty's W5-156 mapping at
                    // workbook_runtime.rs:3266 will produce #NAME?.
                    if let Some(g) = self.graph.as_deref_mut() {
                        g.mark_dirty(node);
                    }
                    continue;
                }
            };
            if let Some(g) = self.graph.as_deref_mut() {
                g.reextract_deps(node, plan.as_ref(), self.workbook);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use ql_functions::default_registry;
    use ql_oplog::{Op, OpLog};
    use ql_storage::Workbook;
    use ql_types::{ErrorValue, Value};

    use crate::workbook_runtime::{RuntimeError, WorkbookRuntime};

    fn make_runtime_workbook() -> Workbook {
        let mut wb = Workbook::new();
        wb.add_sheet("S");
        wb
    }

    // ===== W5-116 (Phase 4.8.G) — structured-ref eval through aggregate =====

    /// **First end-to-end test for Phase 4.8 structured refs.** Set up a
    /// table `Sales` with a `Qty` column; write `SUM(Sales[Qty])`; assert
    /// the result matches a hand-summed value. Exercises:
    /// - 4.8.A: TableMetadata + Workbook::tables_mut().insert.
    /// - 4.8.B: lexer Token::StructuredRef.
    /// - 4.8.C: parser Expr::StructuredRef + Combination/BareColumn.
    /// - 4.8.E: BindSite plumbing (cell address carried).
    /// - 4.8.F: TableLookup blanket impl + ExprPlan::StructuredRef
    ///   resolution against TableTable.
    /// - 4.8.G: eval-side StructuredRef arm in scalar.rs aggregate path.
    #[test]
    fn structured_ref_sum_qty_column_works_end_to_end() {
        use ql_storage::{TableColumn, TableMetadata};
        let mut wb = make_runtime_workbook();
        // Build Sales at A1:D5. Header row 0, no totals. 4 data rows.
        let col = |id, name: &str| TableColumn {
            id,
            name: Arc::from(name.to_ascii_lowercase().as_str()),
            display: Arc::from(name),
            totals_function: None,
        };
        let table = TableMetadata {
            name: Arc::from("SALES"),
            display_name: Arc::from("Sales"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 5,
            cols: 4,
            has_header: true,
            has_totals: false,
            columns: vec![
                col(0, "Region"),
                col(1, "Product"),
                col(2, "Qty"),
                col(3, "Price"),
            ],
        };
        wb.tables_mut().insert(Arc::clone(&table.name), table);
        // Seed data: Qty column (col 2) data rows 1..4 with 10, 20, 30, 40.
        wb.put(ql_types::Address::new(0, 1, 2), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 2), Value::Number(20.0));
        wb.put(ql_types::Address::new(0, 3, 2), Value::Number(30.0));
        wb.put(ql_types::Address::new(0, 4, 2), Value::Number(40.0));

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Anchor the formula at a cell outside the table footprint.
        let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
        drop(rt);
        assert_eq!(v, Value::Number(100.0), "SUM(Sales[Qty]) = 10+20+30+40");
    }

    /// **Phase 4.8.G.2 e2e:** `[@Qty]` shorthand inside a table data
    /// cell resolves to the same-row's Qty value. Pins eval-time row
    /// narrowing via `WorkbookEnv::with_formula_cell`.
    #[test]
    fn structured_ref_at_column_narrows_to_current_row() {
        use ql_storage::{TableColumn, TableMetadata};
        let mut wb = make_runtime_workbook();
        let table = TableMetadata {
            name: Arc::from("SALES"),
            display_name: Arc::from("Sales"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 4,
            cols: 2,
            has_header: true,
            has_totals: false,
            columns: vec![
                TableColumn {
                    id: 0,
                    name: Arc::from("qty"),
                    display: Arc::from("Qty"),
                    totals_function: None,
                },
                TableColumn {
                    id: 1,
                    name: Arc::from("doubled"),
                    display: Arc::from("Doubled"),
                    totals_function: None,
                },
            ],
        };
        wb.tables_mut().insert(Arc::clone(&table.name), table);
        // Header row at 0 (A1, B1). Data rows 1..3.
        // A2=10, A3=20, A4=30.
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        wb.put(ql_types::Address::new(0, 3, 0), Value::Number(30.0));

        let reg = default_registry();
        // Write `=Sales[@Qty]*2` into B2 (data row 1, col 1 → "Doubled").
        // Eval should narrow to A2 → 10 → result 20.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 1, 1, "Sales[@Qty]*2").unwrap();
        assert_eq!(v, Value::Number(20.0), "[@Qty] at B2 narrows to A2=10");
        // Same formula at B3 narrows to A3=20 → result 40.
        let v3 = rt.set_formula(0, 2, 1, "Sales[@Qty]*2").unwrap();
        assert_eq!(v3, Value::Number(40.0), "[@Qty] at B3 narrows to A3=20");
        // Same formula at B4 narrows to A4=30 → result 60.
        let v4 = rt.set_formula(0, 3, 1, "Sales[@Qty]*2").unwrap();
        assert_eq!(v4, Value::Number(60.0), "[@Qty] at B4 narrows to A4=30");
    }

    /// **Phase 4.8.G.2 e2e:** `[@Qty]` typed OUTSIDE the table's data
    /// rows → `#VALUE!` per Excel canon. Validates the
    /// `narrow_structured_ref` out-of-range guard.
    #[test]
    fn structured_ref_at_column_outside_table_returns_value_error() {
        use ql_storage::{TableColumn, TableMetadata};
        let mut wb = make_runtime_workbook();
        let table = TableMetadata {
            name: Arc::from("SALES"),
            display_name: Arc::from("Sales"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 2,
            cols: 1,
            has_header: true,
            has_totals: false,
            columns: vec![TableColumn {
                id: 0,
                name: Arc::from("qty"),
                display: Arc::from("Qty"),
                totals_function: None,
            }],
        };
        wb.tables_mut().insert(Arc::clone(&table.name), table);
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // Formula at row 5 — well outside the table (which is rows 0-1).
        let v = rt.set_formula(0, 5, 5, "Sales[@Qty]").unwrap();
        assert_eq!(
            v,
            Value::Error(ErrorValue::Value),
            "[@Qty] outside table data rows returns #VALUE!"
        );
    }

    // ===== W5-118 (Phase 4.8.H) — create_table / drop_table + op log =====

    #[test]
    fn create_table_happy_path_registers_and_emits_op() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                5,
                3,
                true,
                false,
                vec!["Region".into(), "Qty".into(), "Price".into()],
            )
            .unwrap();
        }
        let t = wb.lookup_table("Sales").expect("registered");
        assert_eq!(t.name.as_ref(), "SALES");
        assert_eq!(t.display_name.as_ref(), "Sales");
        assert_eq!(t.cols, 3);
        assert_eq!(t.rows, 5);
        assert!(t.has_header);
        assert!(!t.has_totals);
        // Verify op-log emission.
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        assert_eq!(ops.len(), 1);
        assert!(matches!(&ops[0], Op::CreateTable { name, .. } if name == "SALES"));
    }

    // ===== W5-119 (Phase 4.8.I) — rename_table =====

    #[test]
    fn rename_table_happy_path_rewrites_formula_text() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        // Formula referencing the table.
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
        }
        // Rename Sales → Orders.
        let rewritten = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.rename_table("Sales", "Orders").unwrap()
        };
        assert_eq!(rewritten, 1, "one formula was rewritten");
        // Verify table table re-keyed.
        assert!(wb.lookup_table("Sales").is_none());
        assert!(wb.lookup_table("Orders").is_some());
        // Verify formula text rewritten.
        let text = wb.formula_at(0, 10, 0).expect("formula present").clone();
        assert!(
            text.contains("Orders"),
            "formula text should now reference Orders, got: {text}"
        );
        assert!(
            !text.contains("Sales"),
            "formula text should NOT reference Sales after rename, got: {text}"
        );
        // Re-bind + re-eval after rename — value still 30.
        let v = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            assert!(rt.recompute_all().is_complete());
            wb.read(ql_types::Address::new(0, 10, 0))
        };
        assert_eq!(v, Value::Number(30.0));
    }

    #[test]
    fn rename_table_target_collision_with_table_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("A", 0, 0, 0, 2, 1, true, false, vec!["x".into()])
            .unwrap();
        rt.create_table("B", 0, 0, 5, 2, 1, true, false, vec!["y".into()])
            .unwrap();
        let err = rt.rename_table("A", "B").unwrap_err();
        match err {
            RuntimeError::TableCreateRejected { reason, .. } => {
                assert!(reason.contains("rename target"), "reason: {reason}");
            }
            other => panic!("expected TableCreateRejected, got {other:?}"),
        }
    }

    #[test]
    fn rename_table_missing_source_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.rename_table("Nope", "Yep").unwrap_err();
        match err {
            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
            other => panic!("expected TableNotFound, got {other:?}"),
        }
    }

    #[test]
    fn rename_table_emits_ops() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table("S", 0, 0, 0, 2, 1, true, false, vec!["Q".into()])
                .unwrap();
            rt.set_formula(0, 5, 0, "SUM(S[Q])").unwrap();
            let _ = rt.rename_table("S", "T").unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // CreateTable + PutFormula + RenameTable + PutFormula (rewrite).
        assert_eq!(ops.len(), 4, "got {ops:?}");
        assert!(matches!(&ops[2], Op::RenameTable { old_name, new_name }
            if old_name == "S" && new_name == "T"));
        match &ops[3] {
            Op::PutFormula { text, .. } => {
                assert!(text.contains('T'));
            }
            other => panic!("expected PutFormula for rewrite, got {other:?}"),
        }
    }

    /// **W5-157 (Phase 4.8.G.3):** `rename_table` fires
    /// `on_table_rename` so the calcgraph reverse index re-keys
    /// from OLD → NEW. A subsequent `drop_table(NEW)` must then
    /// produce `#NAME?` at the reader. Without the hook, the
    /// index stays under OLD and `drop_table(NEW)` would miss
    /// every previously-bound formula.
    #[test]
    fn rename_table_then_drop_new_name_emits_name_error() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
            let v = rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        let before_rename_count = graph.hook_counts().table_rename;

        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let rewritten = rt.rename_table("Sales", "Orders").unwrap();
            assert_eq!(rewritten, 1, "B1's formula text was rewritten");
            // Drain the rename's dirty fanout — B1 re-binds against Orders
            // and produces the same Number(30.0) (same cells, same data).
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        assert_eq!(
            graph.hook_counts().table_rename,
            before_rename_count + 1,
            "rename_table must fire on_table_rename exactly once"
        );
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(30.0),
            "post-rename: same cells, same value"
        );

        // Now drop under the NEW name — the index must find B1.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.drop_table("Orders").unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(
                result.failures.is_empty(),
                "no structural failures: {:?}",
                result.failures
            );
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Error(ErrorValue::Name),
            "rename(Sales→Orders) then drop(Orders): B1 must be #NAME? — \
             proves on_table_rename re-keyed the calcgraph index"
        );
    }

    // ===== W5-121 (Phase 4.8.I.2) — rename_column =====

    #[test]
    fn rename_column_happy_path_rewrites_formula_text() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
        }
        let rewritten = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
        };
        assert_eq!(rewritten, 1, "one formula was rewritten");
        // TableMetadata reflects rename.
        let meta = wb.lookup_table("Sales").expect("table present");
        let (idx, col) = meta.lookup_column("Quantity").expect("new column present");
        assert_eq!(idx, 0);
        assert_eq!(col.name.as_ref(), "quantity");
        assert_eq!(col.display.as_ref(), "Quantity");
        assert!(
            meta.lookup_column("Qty").is_none(),
            "old column gone from metadata"
        );
        // Formula text rewritten.
        let text = wb.formula_at(0, 10, 0).expect("formula present").clone();
        assert!(
            text.contains("Quantity"),
            "formula text should reference Quantity, got: {text}"
        );
        assert!(
            !text.contains("Qty"),
            "formula text should NOT reference Qty after rename, got: {text}"
        );
        // Recompute confirms re-bind against the new column name.
        let v = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            assert!(rt.recompute_all().is_complete());
            wb.read(ql_types::Address::new(0, 10, 0))
        };
        assert_eq!(v, Value::Number(30.0));
    }

    #[test]
    fn rename_column_combination_form_rewritten() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                3,
                2,
                true,
                false,
                vec!["Qty".into(), "Price".into()],
            )
            .unwrap();
        }
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            // Multi-item combination: select #Data rows of Qty.
            let v = rt
                .set_formula(0, 10, 0, "SUM(Sales[[#Data], [Qty]])")
                .unwrap();
            assert_eq!(v, Value::Number(30.0));
        }
        let rewritten = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
        };
        assert_eq!(rewritten, 1);
        let text = wb.formula_at(0, 10, 0).expect("formula").clone();
        assert!(text.contains("Quantity"), "got: {text}");
        assert!(!text.contains("Qty"), "got: {text}");
        // Other column untouched.
        let meta = wb.lookup_table("Sales").unwrap();
        assert!(meta.lookup_column("Price").is_some());
    }

    #[test]
    fn rename_column_this_row_form_rewritten() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                3,
                2,
                true,
                false,
                vec!["Qty".into(), "Doubled".into()],
            )
            .unwrap();
        }
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        // `=Sales[@Qty]*2` at B2 (data row 0).
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let v = rt.set_formula(0, 1, 1, "Sales[@Qty]*2").unwrap();
            assert_eq!(v, Value::Number(20.0));
        }
        let rewritten = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
        };
        assert_eq!(rewritten, 1);
        let text = wb.formula_at(0, 1, 1).expect("formula").clone();
        assert!(text.contains("Quantity"), "got: {text}");
        assert!(!text.contains("Qty"), "got: {text}");
        // Re-eval still produces 20.
        let v = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            assert!(rt.recompute_all().is_complete());
            wb.read(ql_types::Address::new(0, 1, 1))
        };
        assert_eq!(v, Value::Number(20.0));
    }

    #[test]
    fn rename_column_other_table_unaffected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            // Two tables with the same column name.
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.create_table("Orders", 0, 0, 5, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        wb.put(ql_types::Address::new(0, 6, 0), Value::Number(100.0));
        wb.put(ql_types::Address::new(0, 7, 0), Value::Number(200.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            rt.set_formula(0, 11, 0, "SUM(Orders[Qty])").unwrap();
        }
        let rewritten = {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.rename_column("Sales", "Qty", "Quantity").unwrap()
        };
        assert_eq!(rewritten, 1, "only the Sales formula was rewritten");
        // Sales formula updated.
        let sales_text = wb.formula_at(0, 10, 0).expect("formula").clone();
        assert!(sales_text.contains("Quantity"), "got: {sales_text}");
        // Orders formula untouched.
        let orders_text = wb.formula_at(0, 11, 0).expect("formula").clone();
        assert!(orders_text.contains("Qty"), "got: {orders_text}");
        assert!(!orders_text.contains("Quantity"), "got: {orders_text}");
        // Orders column metadata untouched too.
        let orders = wb.lookup_table("Orders").unwrap();
        assert!(orders.lookup_column("Qty").is_some());
        assert!(orders.lookup_column("Quantity").is_none());
    }

    #[test]
    fn rename_column_target_collision_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table(
            "Sales",
            0,
            0,
            0,
            2,
            2,
            true,
            false,
            vec!["Qty".into(), "Price".into()],
        )
        .unwrap();
        let err = rt.rename_column("Sales", "Qty", "Price").unwrap_err();
        match err {
            RuntimeError::TableColumnRejected { reason, .. } => {
                assert!(reason.contains("rename target"), "reason: {reason}");
            }
            other => panic!("expected TableColumnRejected, got {other:?}"),
        }
    }

    #[test]
    fn rename_column_missing_source_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 2, 1, true, false, vec!["Qty".into()])
            .unwrap();
        let err = rt.rename_column("Sales", "Nope", "Whatever").unwrap_err();
        match err {
            RuntimeError::TableColumnNotFound { table, column } => {
                assert_eq!(table, "Sales");
                assert_eq!(column, "Nope");
            }
            other => panic!("expected TableColumnNotFound, got {other:?}"),
        }
    }

    #[test]
    fn rename_column_unknown_table_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.rename_column("Nope", "A", "B").unwrap_err();
        match err {
            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
            other => panic!("expected TableNotFound, got {other:?}"),
        }
    }

    #[test]
    fn rename_column_empty_target_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 2, 1, true, false, vec!["Qty".into()])
            .unwrap();
        let err = rt.rename_column("Sales", "Qty", "").unwrap_err();
        match err {
            RuntimeError::TableColumnRejected { reason, .. } => {
                assert!(reason.contains("cannot be empty"), "reason: {reason}");
            }
            other => panic!("expected TableColumnRejected, got {other:?}"),
        }
    }

    #[test]
    fn rename_column_same_canonical_is_noop() {
        // Display-only case rename (e.g. "Qty" → "QTY") shares the
        // lowercase canonical, so the runtime accepts silently with
        // Ok(0) and emits no op. Mirrors `rename_table` policy.
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table("Sales", 0, 0, 0, 2, 1, true, false, vec!["Qty".into()])
                .unwrap();
            let n = rt.rename_column("Sales", "Qty", "QTY").unwrap();
            assert_eq!(n, 0);
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // Only the CreateTable op landed; no RenameColumn op emitted.
        assert_eq!(ops.len(), 1, "got {ops:?}");
        assert!(matches!(&ops[0], Op::CreateTable { .. }));
    }

    #[test]
    fn rename_column_emits_ops() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table("S", 0, 0, 0, 2, 1, true, false, vec!["Q".into()])
                .unwrap();
            rt.set_formula(0, 5, 0, "SUM(S[Q])").unwrap();
            let n = rt.rename_column("S", "Q", "R").unwrap();
            assert_eq!(n, 1);
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // CreateTable + PutFormula + RenameColumn + PutFormula (rewrite).
        assert_eq!(ops.len(), 4, "got {ops:?}");
        assert!(
            matches!(&ops[2], Op::RenameColumn { table, old_name, new_name }
            if table == "S" && old_name == "Q" && new_name == "R")
        );
        match &ops[3] {
            Op::PutFormula { text, .. } => {
                assert!(text.contains('R'), "text: {text}");
                assert!(!text.contains('Q'), "text: {text}");
            }
            other => panic!("expected PutFormula for rewrite, got {other:?}"),
        }
    }

    /// **W5-158 (Phase 4.8.G.3):** `rename_column` fires the
    /// `on_column_rename` hook → readers are in the dirty set →
    /// `recompute_dirty` re-binds them against the new column
    /// name. The cell value is unchanged (same column index, same
    /// data range; VEQ suppresses the write) but the hook
    /// observability + dirty/clean state are correct.
    #[test]
    fn rename_column_fires_hook_and_keeps_value_consistent() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
            let v = rt.set_formula(0, 0, 1, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        let before = graph.hook_counts().column_rename;
        let formula_node = graph
            .cell_node_for(0, 0, 1)
            .expect("B1 formula node registered");
        assert!(!graph.is_dirty(formula_node), "clean baseline");

        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let rewritten = rt.rename_column("Sales", "Qty", "Quantity").unwrap();
            assert_eq!(rewritten, 1);
        }
        assert_eq!(
            graph.hook_counts().column_rename,
            before + 1,
            "hook fired exactly once"
        );
        assert!(
            graph.is_dirty(formula_node),
            "post-rename: B1 must be in the dirty set so recompute re-binds"
        );

        // Recompute drains the dirty set; value stays at 30 (VEQ suppresses).
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.failures.is_empty());
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 1)),
            Value::Number(30.0),
            "post-rename value unchanged (same column index, same data)"
        );
        assert!(
            !graph.is_dirty(formula_node),
            "recompute drained the dirty set"
        );
    }

    // ===== W5-122 (Phase 4.8.J) — resize_table =====

    #[test]
    fn resize_table_grow_rows_extends_sum_range() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Initial: header at row 0, data at rows 1-2 = 10, 20 → SUM = 30.
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
        }
        // Add data BELOW current footprint, then resize to include it.
        wb.put(ql_types::Address::new(0, 3, 0), Value::Number(40.0));
        wb.put(ql_types::Address::new(0, 4, 0), Value::Number(50.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.resize_table("Sales", 5, 1, vec![], vec![]).unwrap();
            assert!(rt.recompute_all().is_complete());
        }
        // SUM now covers rows 1..4 = 10+20+40+50 = 120.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 10, 0)),
            Value::Number(120.0)
        );
        // Metadata reflects new dims.
        let meta = wb.lookup_table("Sales").unwrap();
        assert_eq!(meta.rows, 5);
        assert_eq!(meta.cols, 1);
    }

    /// **W5-159 (Phase 4.8.G.3):** the correctness bug the hook +
    /// re-extract closes. After `resize_table` grows the data range,
    /// a cell write into the NEW row (outside the OLD range) must
    /// dirty the formula via the calcgraph's range stripe and
    /// `recompute_dirty` must pick it up. Pre-W5-159 the stripe
    /// stayed registered at the OLD range; the write silently missed;
    /// the formula kept its post-resize-but-pre-write value
    /// indefinitely (until something else dirtied it). The
    /// `recompute_all` path in the existing W5-122 test happened to
    /// work because full passes don't rely on stripes — so this gap
    /// only surfaces on the incremental path.
    #[test]
    fn resize_table_grow_then_recompute_dirty_picks_up_new_range_writes() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        // Initial: header at row 0, data at rows 1-2 = 10, 20 → SUM = 30.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.set_value(0, 1, 0, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 0, Value::Number(20.0)).unwrap();
            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(30.0));
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        // Grow the table from 3 rows (header + 2 data) to 5 rows
        // (header + 4 data). recompute_dirty after the resize.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.resize_table("Sales", 5, 1, vec![], vec![]).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.failures.is_empty(), "no structural failures");
        }
        // Existing cells in rows 3-4 are blank → SUM unchanged at 30.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 10, 0)),
            Value::Number(30.0),
            "post-resize: rows 3-4 are blank → SUM stays 30"
        );

        // **THE CRITICAL ASSERTION:** write a NEW value into row 3
        // (inside the new range, outside the old range). The formula's
        // stripe MUST cover this cell after W5-159's re-extract.
        // recompute_dirty MUST pick up the change.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 3, 0, Value::Number(40.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.failures.is_empty());
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 10, 0)),
            Value::Number(70.0),
            "post-resize write at row 3: SUM = 10+20+40 = 70. \
             Pre-W5-159 this stayed at 30 because the stripe was stale."
        );

        // Same for row 4.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.set_value(0, 4, 0, Value::Number(50.0)).unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(result.failures.is_empty());
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 10, 0)),
            Value::Number(120.0),
            "row 4 write: SUM = 10+20+40+50 = 120"
        );
    }

    #[test]
    fn resize_table_shrink_rows_truncates_sum_range() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 5, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Header at row 0, data at rows 1-4 = 10, 20, 40, 50.
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));
        wb.put(ql_types::Address::new(0, 3, 0), Value::Number(40.0));
        wb.put(ql_types::Address::new(0, 4, 0), Value::Number(50.0));
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            let v = rt.set_formula(0, 10, 0, "SUM(Sales[Qty])").unwrap();
            assert_eq!(v, Value::Number(120.0));
        }
        // Shrink from 5 rows to 3 (drop bottom 2 data rows).
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.resize_table("Sales", 3, 1, vec![], vec![]).unwrap();
            assert!(rt.recompute_all().is_complete());
        }
        // SUM now covers rows 1..2 = 30.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 10, 0)),
            Value::Number(30.0)
        );
        // Cells at rows 3-4 still hold their values (storage isn't
        // touched), but they're no longer part of the table.
        assert_eq!(
            wb.read(ql_types::Address::new(0, 3, 0)),
            Value::Number(40.0)
        );
        assert!(wb.table_at(0, 3, 0).is_none(), "row 3 no longer in table");
    }

    #[test]
    fn resize_table_add_column_appends_new_column() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Resize: cols 1 → 2, add "Price".
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.resize_table("Sales", 3, 2, vec!["Price".into()], vec![])
                .unwrap();
        }
        let meta = wb.lookup_table("Sales").unwrap();
        assert_eq!(meta.cols, 2);
        assert_eq!(meta.columns.len(), 2);
        let (idx, col) = meta.lookup_column("Price").unwrap();
        assert_eq!(idx, 1);
        assert_eq!(col.name.as_ref(), "price");
        assert_eq!(col.display.as_ref(), "Price");
        // Pre-existing column intact.
        assert!(meta.lookup_column("Qty").is_some());
        // New column has a freshly allocated id distinct from Qty's.
        let qty_id = meta.lookup_column("Qty").unwrap().1.id;
        assert_ne!(col.id, qty_id);
    }

    #[test]
    fn resize_table_remove_last_column_drops_column() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                3,
                2,
                true,
                false,
                vec!["Qty".into(), "Price".into()],
            )
            .unwrap();
        }
        // Resize: drop "Price".
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            rt.resize_table("Sales", 3, 1, vec![], vec!["Price".into()])
                .unwrap();
        }
        let meta = wb.lookup_table("Sales").unwrap();
        assert_eq!(meta.cols, 1);
        assert_eq!(meta.columns.len(), 1);
        assert!(meta.lookup_column("Qty").is_some());
        assert!(meta.lookup_column("Price").is_none());
    }

    /// **W5-159 / W5-156 (Phase 4.8.G.3 — Codex closing-megaudit LOW
    /// closure):** resize removing a column that a formula references
    /// must (a) reach the formula via `reextract_table_readers`
    /// (re-bind fails with UnknownTableColumn → mark_dirty), and
    /// (b) be mapped to `#NAME?` by recompute_dirty's W5-156 failure
    /// arm. End-to-end this proves the W5-156 + W5-159 mapping covers
    /// `UnknownTableColumn` in addition to `UnknownTable`.
    #[test]
    fn resize_table_remove_referenced_column_emits_name_error() {
        use crate::CalcgraphSession;
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut graph = CalcgraphSession::new();
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                3,
                2,
                true,
                false,
                vec!["Qty".into(), "Price".into()],
            )
            .unwrap();
            rt.set_value(0, 1, 1, Value::Number(10.0)).unwrap();
            rt.set_value(0, 2, 1, Value::Number(20.0)).unwrap();
            let v = rt.set_formula(0, 0, 3, "SUM(Sales[Price])").unwrap();
            assert_eq!(v, Value::Number(30.0));
            let _ = rt.recompute_dirty().expect("graph attached");
        }
        // Drop the Price column.
        {
            let mut rt = WorkbookRuntime::with_graph(&mut wb, &reg, &mut graph);
            rt.resize_table("Sales", 3, 1, vec![], vec!["Price".into()])
                .unwrap();
            let result = rt.recompute_dirty().expect("graph attached");
            assert!(
                result.failures.is_empty(),
                "UnknownTableColumn must map to #NAME?, not RecomputeFailure — got: {:?}",
                result.failures
            );
        }
        assert_eq!(
            wb.read(ql_types::Address::new(0, 0, 3)),
            Value::Error(ErrorValue::Name),
            "SUM(Sales[Price]) → #NAME? after Price is removed by resize"
        );
    }

    #[test]
    fn resize_table_unknown_table_errors() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.resize_table("Nope", 5, 1, vec![], vec![]).unwrap_err();
        match err {
            RuntimeError::TableNotFound(n) => assert_eq!(n, "Nope"),
            other => panic!("expected TableNotFound, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_zero_dims_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        let err = rt.resize_table("Sales", 0, 1, vec![], vec![]).unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("> 0"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_arithmetic_mismatch_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        // old_cols=1, add 1, remove 0 → expect new_cols = 2; pass 3 instead.
        let err = rt
            .resize_table("Sales", 3, 3, vec!["Price".into()], vec![])
            .unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("does not match"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_removed_columns_not_trailing_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table(
            "Sales",
            0,
            0,
            0,
            3,
            3,
            true,
            false,
            vec!["A".into(), "B".into(), "C".into()],
        )
        .unwrap();
        // removed_columns = ["A"] — but A is NOT trailing (trailing is C).
        let err = rt
            .resize_table("Sales", 3, 2, vec![], vec!["A".into()])
            .unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("do not match trailing"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_overlap_with_other_table_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        {
            let mut rt = WorkbookRuntime::new(&mut wb, &reg);
            // Sales at rows 0-2, cols 0-0.
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            // Orders at rows 5-7, cols 0-0.
            rt.create_table("Orders", 0, 5, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
        }
        // Grow Sales to 10 rows — would overlap Orders at rows 5-7.
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let err = rt.resize_table("Sales", 10, 1, vec![], vec![]).unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(reason.contains("overlaps"), "reason: {reason}");
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_added_column_duplicate_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        // Adding "qty" (lowercase) collides with existing "Qty".
        let err = rt
            .resize_table("Sales", 3, 2, vec!["qty".into()], vec![])
            .unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(
                    reason.contains("duplicate canonical names"),
                    "reason: {reason}"
                );
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_removed_columns_excess_count_rejected() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        // Only 1 column exists; trying to remove 2. Use new_cols=1
        // so the zero-dims check doesn't fire first (the
        // excess-count check is what we want to pin here).
        let err = rt
            .resize_table("Sales", 3, 1, vec![], vec!["Qty".into(), "Phantom".into()])
            .unwrap_err();
        match err {
            RuntimeError::TableResizeRejected { reason, .. } => {
                assert!(
                    reason.contains("exceeds existing column count"),
                    "reason: {reason}"
                );
            }
            other => panic!("expected TableResizeRejected, got {other:?}"),
        }
    }

    #[test]
    fn resize_table_emits_ops() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
                .unwrap();
            rt.resize_table("Sales", 5, 2, vec!["Price".into()], vec![])
                .unwrap();
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // CreateTable + ResizeTable.
        assert_eq!(ops.len(), 2, "got {ops:?}");
        assert!(matches!(
            &ops[1],
            Op::ResizeTable {
                name,
                new_rows,
                new_cols,
                added_columns,
                removed_columns,
            } if name == "SALES"
                && *new_rows == 5
                && *new_cols == 2
                && added_columns == &vec!["Price".to_owned()]
                && removed_columns.is_empty()
        ));
    }

    /// **W5-127 (Phase 4.8.O.3 — Codex LOW-1):** exact no-op resize
    /// (same dims, no column changes) returns `Ok(())` without
    /// emitting an `Op::ResizeTable`. Mirrors `rename_column`'s
    /// same-canonical no-op contract — caller-visible behavior is
    /// unchanged but the op log stays compact.
    #[test]
    fn resize_table_exact_noop_emits_nothing() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut oplog = OpLog::new();
        {
            let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
            rt.create_table(
                "Sales",
                0,
                0,
                0,
                3,
                2,
                true,
                false,
                vec!["Qty".into(), "Price".into()],
            )
            .unwrap();
            // Exact no-op: same dims, empty added + removed.
            rt.resize_table("Sales", 3, 2, vec![], vec![])
                .expect("exact no-op must succeed silently");
        }
        let ops: Vec<Op> = oplog.iter().collect::<Result<_, _>>().unwrap();
        // Only the CreateTable op landed; no ResizeTable emitted.
        assert_eq!(ops.len(), 1, "got {ops:?}");
        assert!(matches!(&ops[0], Op::CreateTable { .. }));
        // Sanity: table metadata unchanged.
        let meta = wb.lookup_table("Sales").unwrap();
        assert_eq!(meta.rows, 3);
        assert_eq!(meta.cols, 2);
        assert_eq!(meta.columns.len(), 2);
    }

    /// **End-to-end with op log**: create_table emits Op::CreateTable;
    /// SUM(Sales[Qty]) using the just-created table works. Validates
    /// the runtime API end-to-end.
    #[test]
    fn create_table_then_sum_column_works() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.create_table("Sales", 0, 0, 0, 3, 1, true, false, vec!["Qty".into()])
            .unwrap();
        drop(rt);
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(7.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(13.0));
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 5, 0, "SUM(Sales[Qty])").unwrap();
        assert_eq!(v, Value::Number(20.0));
    }

    /// AVERAGE through the same path — confirms the cache fast path
    /// works for StructuredRef single-arg (not just SUM).
    #[test]
    fn structured_ref_average_qty_column_works_end_to_end() {
        use ql_storage::{TableColumn, TableMetadata};
        let mut wb = make_runtime_workbook();
        let table = TableMetadata {
            name: Arc::from("SALES"),
            display_name: Arc::from("Sales"),
            sheet: 0,
            top_row: 0,
            top_col: 0,
            rows: 3,
            cols: 1,
            has_header: true,
            has_totals: false,
            columns: vec![TableColumn {
                id: 0,
                name: Arc::from("qty"),
                display: Arc::from("Qty"),
                totals_function: None,
            }],
        };
        wb.tables_mut().insert(Arc::clone(&table.name), table);
        wb.put(ql_types::Address::new(0, 1, 0), Value::Number(10.0));
        wb.put(ql_types::Address::new(0, 2, 0), Value::Number(20.0));

        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        let v = rt.set_formula(0, 5, 0, "AVERAGE(Sales[Qty])").unwrap();
        drop(rt);
        assert_eq!(v, Value::Number(15.0), "AVERAGE(Sales[Qty]) = 15");
    }

    // (Tier D1 Step 3.2: W5-146 config tests moved to
    //  config.rs::tests.)

    // -------------------------------------------------------------
    // W5-147 (Phase 4.9.K) — set_formula canonical-storage tests.
    // -------------------------------------------------------------

    /// **R1C1 input canonicalizes to A1 in storage.** When the
    /// workbook is in R1C1 mode and user types `R1C1`, the stored
    /// formula text is `$A$1` (A1+EnUs canon).
    #[test]
    fn set_formula_canonicalizes_r1c1_input_to_a1() {
        let mut wb = make_runtime_workbook();
        wb.set_reference_mode(ql_types::ReferenceMode::R1C1);
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "R1C1+R2C2").unwrap();
        drop(rt);
        // Stored text uses A1 + absolute markers ($) since the source
        // R1C1Ref `Abs(1),Abs(1)` becomes A1's `$A$1`.
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("$A$1 + $B$2")
        );
    }

    /// **Relative R1C1 canonicalizes using the formula's own cell
    /// as anchor.** `R[-1]C` at cell (1, 0) → `A1` (no `$` — relative
    /// R1C1 ↔ unprefixed A1).
    #[test]
    fn set_formula_canonicalizes_relative_r1c1_to_unprefixed_a1() {
        let mut wb = make_runtime_workbook();
        wb.set_reference_mode(ql_types::ReferenceMode::R1C1);
        wb.put_at(0, 0, 0, ql_types::Value::Number(7.0));
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        // At cell (1, 0), R[-1]C means "row above, same column" = A1.
        rt.set_formula(0, 1, 0, "R[-1]C").unwrap();
        drop(rt);
        assert_eq!(wb.formula_at(0, 1, 0).map(|s| s.as_ref()), Some("A1"));
    }

    /// **DE locale input canonicalizes to EN.** `SUM(2,5; 3,5)`
    /// (DE — `,` decimal, `;` arg sep) → `SUM(2.5, 3.5)` (EN canon).
    #[test]
    fn set_formula_canonicalizes_de_locale_to_en() {
        let mut wb = make_runtime_workbook();
        wb.set_locale(ql_types::Locale::De);
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "SUM(2,5; 3,5)").unwrap();
        drop(rt);
        assert_eq!(
            wb.formula_at(0, 0, 0).map(|s| s.as_ref()),
            Some("SUM(2.5, 3.5)")
        );
    }

    /// **`@A1` (implicit intersection) survives canonicalization.**
    /// The `@` operator is mode + locale invariant per design § 3.3.
    #[test]
    fn set_formula_preserves_at_through_canonicalization() {
        let mut wb = make_runtime_workbook();
        let reg = default_registry();
        let mut rt = WorkbookRuntime::new(&mut wb, &reg);
        rt.set_formula(0, 0, 0, "@A1").unwrap();
        drop(rt);
        assert_eq!(wb.formula_at(0, 0, 0).map(|s| s.as_ref()), Some("@A1"));
    }

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

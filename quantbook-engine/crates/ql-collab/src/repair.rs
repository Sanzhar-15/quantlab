//! `ql_collab::repair` — Phase 5.3 step 3 rename-repair pass
//! (CORE 5.3 work, 2026-05-20).
//!
//! ## Purpose
//!
//! After merging concurrent ops from peers, formulas authored against
//! pre-rename sheet names may reference names that no longer exist.
//! Pre-step-3 behavior (D-3 V1 limitation): such formulas surface as
//! `BindError::UnknownSheet` → `#NAME?` at recompute time. This module
//! ships the post-merge repair pass that rewrites the formula text
//! in-place via the existing `ql_formula_syntax::rewrite_sheet_name_in_expr`
//! machinery (same one producer-side rename uses for single-writer flows).
//!
//! ## Caller contract
//!
//! `repair_sheet_rename_chain` is **caller-driven**, NOT hooked into
//! `merge_bytes`. Audit-locked design decision D-5.3-1 (see
//! `quantbook-engine/.plans/_active.md`). Typical call sequence:
//!
//! ```text
//! 1. CollabSession::merge_bytes(peer_b_bytes)   // pull peer's ops
//! 2. replay_into(log, &mut workbook, &registry) // apply ops to workbook
//! 3. ql_collab::repair_sheet_rename_chain(&mut workbook, &log)?  // <-- THIS module
//! 4. WorkbookRuntime::recompute_all(...)        // evaluate formulas
//! ```
//!
//! Step 3 is OPTIONAL (replay + recompute work without it), but skipping
//! it means concurrent-edit formulas referencing renamed sheets resolve
//! as `#NAME?`. Production callers in collaborative workflows SHOULD
//! invoke it before recompute; single-writer / qbook-load workflows
//! don't need it (no concurrent renames possible).
//!
//! ## Algorithm (chain-based, NOT causality-aware)
//!
//! Audit-locked design decision D-5.3-2.
//!
//! 1. Walk the op log; for each `Op::RenameSheet { id, old_name, .. }`
//!    (including ops nested in `BatchCommit`), record `old_name` as a
//!    historic name of `id`.
//!
//! 2. For each sheet, build the rewrite rule
//!    `(canonical_historic_name → current_display_name)`. Skip pairs
//!    where the canonical matches the sheet's CURRENT canonical
//!    (no-op). The "current" name is taken from the workbook post-replay
//!    — this captures step-2's auto-disambiguation suffixes (e.g.
//!    a sheet that wanted "X" but ended up "X(2)" rewrites historic
//!    references to "X(2)", not the intended "X").
//!
//! 3. Walk every formula in the workbook via `Workbook::iter_formulas`.
//!    For each, apply rewrites via [`rewrite_formula_with_rename`].
//!    Idempotent: the helper returns `None` when no change applies.
//!    Multiple rewrites may compose (transitive chain S1→S2→S3 produces
//!    rewrites for both S1 and S2 → final name).
//!
//! 4. Apply collected updates via `Workbook::put_formula`.
//!
//! ## Safety guard: skip rules where `old_canonical` is currently held
//!
//! Step 3 audit closure (Codex HIGH-1 + HIGH-2, 2026-05-20). Two
//! formula-corruption scenarios drove the guard:
//!
//! 1. **Cascade through rewritten names** (Codex HIGH-1): base sheets
//!    `A` and `B`. Peer renames `B → C`, then `A → B`. Final: sheet 0
//!    = B, sheet 1 = C. Pre-guard the rules `{A → B, B → C}` would
//!    apply iteratively: formula `A!A1` → `B!A1` (rule 1) → `C!A1`
//!    (rule 2). **Wrong** — the cell ends up referencing sheet 1
//!    when the formula author meant sheet 0 (now named B).
//!
//! 2. **Historic names live forever** (Codex HIGH-2): sheet S
//!    renamed to T. Later, a NEW sheet S is added (after the rename).
//!    A formula `S!A1` written after the new S is added INTENDS the
//!    new S. Pre-guard the historic rule `S → T` would rewrite the
//!    valid current reference to `T!A1`. **Wrong** — corrupts a
//!    valid formula.
//!
//! Closure: **skip rules where `old_canonical` is currently held by
//! ANY sheet in the workbook**. The `ambiguous_skipped` field of
//! `RepairReport` surfaces these for diagnostics (no silent loss —
//! per the no-fallback rule).
//!
//! ## Known limitations (V1, post-step-3 audit closure)
//!
//! - **Cross-sheet historic-name ambiguity** (when neither historic
//!   is currently held): two sheets had the same canonical name at
//!   different chain points, AND neither sheet currently holds that
//!   name. Rules end up in the vec; rule-iteration order picks the
//!   winner (sorted by sheet id, so lowest sheet_id's rule fires
//!   first). Rare; not closed in V1.
//!
//! - **Concurrent-rename intermediate names lost**: if peer A's chain
//!   is S1→S2→S3 with both ops applied in sequence, the intermediate
//!   name "S2" lives in `old_name` of the second op so it IS captured.
//!   But if a concurrent rename forced the second op to apply "from"
//!   a different name (step 2's last-wins policy), the old_name from
//!   the wire may not reflect what current was at apply-time. Formulas
//!   referencing that intermediate name may not be repaired. Mitigation
//!   for future: causality-aware tracking via Loro op-ids (deferred).
//!
//! - **Step 4 extension**: this V1 only handles sheet renames.
//!   `Op::RenameTable` + `Op::RenameColumn` need the same treatment;
//!   step 4 of the Phase 5.3 arc adds them.

use ql_oplog::{Op, OpLog, OpLogError};
use ql_storage::Workbook;
use ql_types::SheetId;
use std::collections::HashMap;
use std::sync::Arc;

/// Report returned by [`repair_sheet_rename_chain`]. Caller uses for
/// logging / diagnostics. Per the no-fallback rule (CLAUDE.md), this
/// surfaces *what was done* rather than silently absorbing the work.
#[derive(Debug, Clone, Default)]
pub struct RepairReport {
    /// Total number of formulas whose text was rewritten by the pass.
    pub formulas_rewritten: usize,

    /// Per-sheet rewrite summary: the sheet id, its final display name
    /// post-replay, and the historic canonical names whose references
    /// were rewritten. Empty if no sheet had a rename.
    pub sheet_rewrites: Vec<SheetRewriteSummary>,

    /// **Step 3 audit closure (Codex HIGH-1 + HIGH-2, Opus HIGH-1,
    /// 2026-05-20):** rules that were SKIPPED because their
    /// `old_canonical` is currently held by another (or the same)
    /// sheet — applying the rewrite would corrupt formulas that
    /// legitimately reference the current holder. Surfaced for
    /// diagnostics per the no-fallback rule.
    pub ambiguous_rules_skipped: Vec<AmbiguousSkip>,
}

/// Per-sheet summary line in [`RepairReport`].
#[derive(Debug, Clone)]
pub struct SheetRewriteSummary {
    pub sheet: SheetId,
    pub current_display_name: String,
    /// Historic canonical names from `Op::RenameSheet.old_name`. Sorted
    /// + deduped. Empty iff the sheet had no rename ops in the log.
    pub historic_canonicals: Vec<String>,
}

/// **Step 3 audit closure entry**: an ambiguous rule the pass refused
/// to apply because doing so would have corrupted a valid current
/// reference. See the safety guard in the module docs.
#[derive(Debug, Clone)]
pub struct AmbiguousSkip {
    /// Sheet id whose chain produced this rule.
    pub origin_sheet: SheetId,
    /// Historic canonical name (the rule's "old" side).
    pub historic_canonical: String,
    /// Sheet id of the current holder of `historic_canonical`. If equal
    /// to `origin_sheet`, the same sheet was renamed away and then back
    /// to its starting name (no-op, normally pruned earlier but recorded
    /// here for completeness).
    pub current_holder_sheet: SheetId,
}

/// Walk the op log to build a chain of sheet renames, then rewrite
/// every formula in `workbook` whose text references a historic
/// (pre-rename) sheet name. See module docs for the algorithm.
///
/// Returns a [`RepairReport`] describing what was changed. The report
/// is informational; the workbook is mutated in place.
///
/// **Errors**: only propagates `OpLogError` from iterating the op log
/// (e.g., a corrupted Loro `LoroValue::String` that fails serde
/// decode). Formula rewrites that fail to parse are SKIPPED silently
/// (the helper returns `None` on parse failure, preserving the
/// pre-rewrite text). This matches the producer-side helper's
/// behavior and avoids the no-fallback violation that would fire if
/// we returned an error for unparseable formulas (those formulas
/// would already produce parse errors at recompute time — repair
/// doesn't worsen that).
///
/// **Caller-driven**: NOT auto-invoked by `merge_bytes`. See module
/// docs for the expected call sequence.
pub fn repair_sheet_rename_chain(
    workbook: &mut Workbook,
    log: &OpLog,
) -> Result<RepairReport, OpLogError> {
    // ===== Phase 1: walk op log; collect historic old_names per sheet.
    let mut historic_by_sheet: HashMap<SheetId, Vec<String>> = HashMap::new();
    for op_result in log.iter() {
        let op = op_result?;
        collect_rename_old_names(&op, &mut historic_by_sheet);
    }

    // ===== Phase 2: snapshot current canonical names + their owning
    // sheet ids. Used by the ambiguity guard (step 3 audit closure)
    // to skip rules whose `old_canonical` is currently held by some
    // sheet — applying such a rule would corrupt formulas that
    // legitimately reference the current holder.
    let sheet_count = workbook.sheet_count() as u16;
    let mut canonical_to_current_sheet: HashMap<String, SheetId> = HashMap::new();
    for i in 0..sheet_count {
        if let Some(s) = workbook.sheet(i) {
            canonical_to_current_sheet.insert(Workbook::canonical_sheet_name(s.name()), i);
        }
    }

    // ===== Phase 3: build (canonical_historic → current_display_name) rules.
    // Skip pairs where canonical historic matches current canonical (no-op)
    // OR where `historic_canonical` is currently held by ANY sheet (would
    // corrupt the current holder's formula refs — Codex+Opus HIGH closure).
    let mut rules: Vec<(String, Arc<str>, SheetId)> = Vec::new();
    let mut sheet_rewrites: Vec<SheetRewriteSummary> = Vec::new();
    let mut ambiguous_rules_skipped: Vec<AmbiguousSkip> = Vec::new();
    let mut sheet_ids: Vec<SheetId> = historic_by_sheet.keys().copied().collect();
    sheet_ids.sort_unstable();
    for sheet_id in sheet_ids {
        let historic = historic_by_sheet
            .get(&sheet_id)
            .cloned()
            .unwrap_or_default();
        let Some(current) = workbook.sheet(sheet_id).map(|s| s.name().to_owned()) else {
            // Sheet ID is in the rename history but doesn't exist in the
            // current workbook. Should not happen for sheet renames (no
            // DropSheet op exists in V1). Defensive skip.
            continue;
        };
        let current_canonical = Workbook::canonical_sheet_name(&current);
        let current_arc: Arc<str> = Arc::from(current.as_str());

        // Dedupe historic canonicals; skip those matching current canonical
        // (no-op renames).
        let mut historic_canonicals: Vec<String> = historic
            .iter()
            .map(|s| Workbook::canonical_sheet_name(s))
            .filter(|c| c != &current_canonical)
            .collect();
        historic_canonicals.sort();
        historic_canonicals.dedup();

        for hc in &historic_canonicals {
            // **Audit closure (Codex+Opus HIGH-1 + Codex HIGH-2)**: if
            // `hc` is CURRENTLY held by any sheet, the rule would
            // corrupt that sheet's legitimate formula references.
            // E.g., sheet 0 renamed S→T; sheet 1 added as S afterward;
            // formula `=S!A1` intends sheet 1, not sheet 0. The rule
            // S→T would mis-rewrite it. Skip and report.
            //
            // Symmetric closure of the cascade case (Codex HIGH-1):
            // sheets 0+1 each renamed; sheet 0's chain `B→C, A→B`
            // and sheet 1's chain `S→...`. After all renames, sheet 0
            // is named B. A rule from a DIFFERENT sheet with old=B
            // would cascade-rewrite formulas that legitimately
            // reference sheet 0. The guard catches both.
            if let Some(holder) = canonical_to_current_sheet.get(hc) {
                ambiguous_rules_skipped.push(AmbiguousSkip {
                    origin_sheet: sheet_id,
                    historic_canonical: hc.clone(),
                    current_holder_sheet: *holder,
                });
                continue;
            }
            rules.push((hc.clone(), Arc::clone(&current_arc), sheet_id));
        }

        sheet_rewrites.push(SheetRewriteSummary {
            sheet: sheet_id,
            current_display_name: current,
            historic_canonicals,
        });
    }

    // ===== Phase 4: fast-path no-op when no rules survive.
    // (Audit closure: Opus MEDIUM-2 — empty `rules` should NOT incur
    // the per-formula iteration cost.)
    if rules.is_empty() {
        return Ok(RepairReport {
            formulas_rewritten: 0,
            sheet_rewrites,
            ambiguous_rules_skipped,
        });
    }

    // ===== Phase 5: walk formulas, collect updates.
    // Two-phase to avoid mut/immut borrow conflict on workbook.
    let mut to_update: Vec<(SheetId, u32, u32, String)> = Vec::new();
    for (sheet, row, col, text) in workbook.iter_formulas() {
        let mut current_text = text.to_string();
        let mut changed = false;
        for (old_canonical, new_name, _origin_sheet) in &rules {
            if let Some(rewritten) =
                rewrite_formula_with_rename(&current_text, old_canonical, new_name)
            {
                current_text = rewritten;
                changed = true;
            }
        }
        if changed {
            to_update.push((sheet, row, col, current_text));
        }
    }
    let rewrite_count = to_update.len();

    // ===== Phase 6: apply updates.
    for (sheet, row, col, new_text) in to_update {
        workbook.put_formula(sheet, row, col, new_text);
    }

    Ok(RepairReport {
        formulas_rewritten: rewrite_count,
        sheet_rewrites,
        ambiguous_rules_skipped,
    })
}

/// Walk an `Op`, including ops nested in `BatchCommit`, and record
/// `RenameSheet.old_name` entries in `historic`. Other op kinds are
/// ignored.
fn collect_rename_old_names(op: &Op, historic: &mut HashMap<SheetId, Vec<String>>) {
    match op {
        Op::RenameSheet { id, old_name, .. } => {
            historic.entry(*id).or_default().push(old_name.clone());
        }
        Op::BatchCommit { ops } => {
            for inner in ops {
                collect_rename_old_names(inner, historic);
            }
        }
        _ => {}
    }
}

/// Rewrite `text` (formula source) substituting every reference to
/// `old_canonical` (a canonical-uppercase sheet name) with `new_name`
/// (the new display name).
///
/// Mirror of the producer-side helper at
/// `crates/ql-exec/src/workbook_runtime/sheets.rs:37-60`. Kept here
/// because ql-collab has no dep on ql-exec (direction: ql-collab is
/// below ql-exec). Both helpers route through
/// `ql_formula_syntax::{lex, parse, rewrite_sheet_name_in_expr, print}`.
///
/// Returns `None` when:
/// - The text doesn't lex/parse (formula is malformed — caller should
///   not surface this as an error; recompute will surface it).
/// - The parsed AST doesn't reference `old_canonical` (no rewrite).
fn rewrite_formula_with_rename(
    text: &str,
    old_canonical: &str,
    new_name: &Arc<str>,
) -> Option<String> {
    let stripped = text.strip_prefix('=').unwrap_or(text);
    let tokens = ql_formula_syntax::lex(stripped).ok()?;
    let expr = ql_formula_syntax::parse(tokens).ok()?;
    let rewritten = ql_formula_syntax::rewrite_sheet_name_in_expr(&expr, old_canonical, new_name);
    if rewritten == expr {
        return None;
    }
    let printed = ql_formula_syntax::print(&rewritten);
    let with_eq = if text.starts_with('=') {
        format!("={printed}")
    } else {
        printed
    };
    Some(with_eq)
}

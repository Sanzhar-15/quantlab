# Engine session final handoff — 2026-05-14 (W5-77 → W5-91)

**This document is the canonical handoff for the next engine-track Claude window.**
Read it cover-to-cover, then read `docs/process/audit-protocol.md`, then verify state.

---

## TL;DR (60 seconds)

Branch `feat/quantbook-engine` at HEAD `083ad235d24` (W5-91, Phase 4.6.C
ship). 16 commits shipped this session on top of W5-76 closure. Two full
phase waves landed:

- **Phase 4.5.D** (number-format-string mini-language, lexer + AST + parser
  + renderer + `FormatTable` + sparse `CellFormatOverlay` + op-log ops +
  `.qbook` schema v3→v4 + runtime wrappers + `TEXT()`). W5-77a → W5-83.
- **Phase 4.5 closing mega-audit** — W5-84.
- **Phase 4.6 design + AA/A/B/C** — sheet registry + canonicalizer
  (W5-86), `SheetRef` AST migration (W5-87), lexer Bang/SheetName/
  QuotedSheetName tokens (W5-88), parser + printer cross-sheet round
  trip (W5-89), binder + runtime cross-sheet resolution (W5-90), sheet
  rename + formula-text rewrite + `Op::RenameSheet` (W5-91, this commit).

Workspace tests: **1948 passing / 0 failing** at W5-91 ship.
All 7 gates green. Working tree clean (after this commit lands).
Nothing pushed (per CLAUDE.md "never push unless asked").

**Phase 4.6 status:** A + B + C shipped; D + E open.
- **4.6.D (next):** sheet-scoped names + schema v5.
- **4.6.E:** closing mega-audit.

---

## Verify before acting

```bash
cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine
git log --oneline -3                                     # expect: 083ad235d24 W5-91 ...
git rev-parse --abbrev-ref HEAD                          # feat/quantbook-engine
git status -uno                                          # clean
mac zsh -lc 'export PATH="$HOME/.cargo/bin:$PATH"; \
  cargo test --workspace 2>&1 | grep -E "^test result: ok\." | \
  awk "{for (i=1;i<=NF;i++) if (\$i==\"passed;\") sum+=\$(i-1)} END {print sum}"'
# expect: 1948
```

If anything disagrees, STOP and read the engine `git log` before acting.
Stale assumptions are the dominant risk.

---

## Session ledger

| Commit | Subject | Tests after | Notes |
|---|---|---|---|
| `05e107d6def` | W5-77a — Phase 4.5.D companion: number-format-string grammar mini-spec | 1630 baseline | Doc-only |
| `d31c4a5f507` | W5-77b — parser scaffold: lexer + AST + parser | ~1660 | V1 grammar |
| `85e4c0c3967` | W5-78 — number format renderer | ~1690 | V1 renderer + V2 stubs |
| `aef90bb1e9b` | W5-79 — `FormatTable` + sparse `CellFormatOverlay` | ~1720 | Workbook-level interning |
| `09d3bd3b250` | W5-80 — op-log `Op::RegisterFormat` + `Op::SetCellFormat` | ~1750 | Producer-replay parity |
| `b467bf6d219` | W5-81 — `.qbook` schema v3→v4 (`FormatTable` + per-sheet overlay persistence) | ~1780 | Envelope-level migration |
| `e1413b54397` | W5-82 — `WorkbookRuntime` format wrappers + `read_display` | ~1810 | Public API |
| `7a85ccdf996` | W5-83 — `TEXT(value, format_string)` formula function | ~1830 | Locale-deferred to Phase 4.5.E |
| `2c25a123ea2` | W5-84 — Phase 4.5 closing mega-audit (Codex + Sonnet 2nd pass) | ~1850 | Phase 4.5 FULLY CLOSED |
| `09b35352e61` | W5-85 — Phase 4.6 cross-sheet references design (Codex-reviewed) | ~1850 | Doc-only |
| `0177fc6c269` | W5-86 — Phase 4.6.AA: sheet registry + canonicalizer | ~1870 | Workbook side-table |
| `77b932691b7` | W5-87 — Phase 4.6.A part 1: `SheetRef` AST migration | ~1890 | Replaces `Option<SheetId>` in AST |
| `85e2864fe93` | W5-88 — Phase 4.6.A part 2: lexer Bang/SheetName/QuotedSheetName | ~1900 | One-token lookahead |
| `5b26c3662d3` | W5-89 — Phase 4.6.A part 3: parser + printer cross-sheet round-trip | ~1920 | `Sheet2!A1` lexes + parses + prints |
| `1ec3c4d4724` | W5-90 — Phase 4.6.B: binder + runtime cross-sheet resolution | ~1930 | `SheetResolver` trait, `bind_with_names_and_sheets`, `RuntimeError::Bind(UnknownSheet)` |
| `083ad235d24` | **W5-91 — Phase 4.6.C: sheet rename + formula-text rewrite + `Op::RenameSheet`** | **1948** | `WorkbookRuntime::rename_sheet`, AST walker, op-log atomic batch |

Tests grew **+318 from session start at 1630 → 1948**.

---

## What W5-91 actually shipped (last commit)

### Storage (`crates/ql-storage`)
- `Workbook::rename_sheet(id, new_name)`. Validates new name (skipping
  the duplicate check when canonical key is unchanged, so case-only
  renames `Sheet1 → SHEET1` succeed). Returns `Err(SheetNameError)` on
  rejection.
- `Sheet::set_name(new_name)` accessor.
- 5 unit tests (basic / case-only / duplicate / empty / unknown-id).

### AST (`crates/ql-formula-syntax`)
- `rewrite_sheet_name_in_expr(expr, old_canonical, new_name)`.
  Recursively rewrites every `SheetRef::Name` whose canonical form
  matches `old_canonical`. `Current` and `Id` pass through. Walks
  Number / String / Bool / NameRef / CellRef / RangeRef (all 3 shapes)
  / Binary / Unary / Function / Array / Spill. 6 unit tests.

### Op log (`crates/ql-oplog`)
- `Op::RenameSheet { id, old_name, new_name }` variant. Replay handler
  with 3-case snapshot-vs-log reconciliation per design § 3.3:
  `current == old → apply` ; `current == new → no-op (replay-on-top-
  of-snapshot)` ; `else → SheetRenameNameMismatch`. Storage failures
  surface as `SheetRenameRejected`.
- Two new `ReplayError` variants for the above.
- 6 replay unit tests + 1 producer-replay-equivalence test (BatchCommit
  path included).

### Runtime (`crates/ql-exec`)
- `WorkbookRuntime::rename_sheet(id, new_name)` is the public entry
  point. Algorithm:
  1. Validate id + new name (case-only short-circuits dup check).
  2. Walk `iter_formulas`. For each formula whose text references the
     old sheet name, lex+parse→`rewrite_sheet_name_in_expr`→print.
     Lex/parse failures leave text untouched (no rename should break
     otherwise-recoverable workbooks).
  3. Log a single `BatchCommit { ops: [PutFormula × N, RenameSheet] }`
     — atomic for replay.
  4. Apply rewrites, swap name, `plan_cache.clear()` to invalidate
     plans bound against the old name.
- `RuntimeError::SheetName(#[from] SheetNameError)` carries validation
  failures up.
- 5 runtime tests (end-to-end rewrite + recompute, unrelated-formula
  isolation, duplicate-rejection, unknown-id, case-only rename).

---

## Phase 4.6 design reference

Read these before starting Phase 4.6.D:

- `docs/architecture/2026-05-13-cross-sheet-references.md` — full
  Phase 4.6 design with Codex review synthesis (4 HIGH + 9 MEDIUM +
  3 LOW).
- `docs/audits/2026-05-13-phase-4.6-design-codex-review.txt` — raw
  Codex findings.

Open Codex items for Phase 4.6.D:
- HIGH-2 status: schema bump v4→v5 for sheet-scoped names. The
  design doc fixes the policy at "strict `deny_unknown_fields`".
- Sheet-scoped names: `SheetId → BTreeMap<NameKey, NamedTarget>` plus
  the existing workbook-scoped table. Lookup order: sheet-scoped
  first, fall back to workbook-scoped. Resolver wiring goes through
  `bind_with_names_and_sheets`.

Phase 4.6.D scope candidate (not yet committed-to):
1. `SheetNamespacedNameTable` in `ql-storage` (or extend `NameTable`
   with a per-sheet axis).
2. New `Op::SetSheetScopedName` / `Op::ClearSheetScopedName`.
3. Schema v4→v5 migration. `deny_unknown_fields` strict — old
   readers fail loud on the new field (per design § 8.1).
4. Binder reads sheet-scoped first, workbook-scoped second.
5. Tests covering shadowing semantics + scope lookup order.

Phase 4.6.E (closing mega-audit) follows D.

---

## Known follow-ups (not blocking 4.6.D)

- **Plan-cache sheet-rename granularity.** Current `rename_sheet`
  flushes the entire `PlanCache`. The design doc § 10.5 / Codex
  MEDIUM-7 calls for a finer `sheet_gen` counter that only
  invalidates plans referencing the renamed sheet. Edit-rate not
  recompute-rate, so the full flush is acceptable; filed for a
  future polish micro-batch.
- **Phase 4.7 array-formula prereq.** `SUM(Sheet2!A1:A3)` (range
  literal as function arg) still rejects at the binder. Tracked
  through W5-90's deferred test note. Phase 4.7 (array formulas)
  is the right home for that.

---

## State (snapshot at HEAD `083ad235d24`)

- **Branch:** `feat/quantbook-engine` (worktree at
  `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/`).
- **HEAD:** `083ad235d24` (W5-91).
- **Tests:** 1948 workspace tests passing.
- **Gates (all green):** fmt | clippy `-D warnings` | workspace
  tests | check-build-flags | check-cargo-lock-pins |
  check-multiversion-clones | cargo audit (1 allowed
  `atomic-polyfill` warning, pre-existing).
- **Unpushed:** all 16 session commits + prior backlog (per CLAUDE.md
  "never push unless asked").

---

## Cycle discipline note

This session ran past the ≤2 cycle CLAUDE.md guideline (user drove with
`continue` / `proceed` directives throughout the W5-77 → W5-91 wave).
A fresh session is the right call before opening Phase 4.6.D. If the
next session inherits this branch state, mega-audit budget for 4.6.E
should be reserved BEFORE starting 4.6.D rather than after, so the
cycle budget isn't exhausted on implementation alone.

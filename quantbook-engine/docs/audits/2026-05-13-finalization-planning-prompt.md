# Engine session finalization — planning brief for Codex

## Context

I (Claude Opus) just finished a 10-commit session on the Quantbook engine on branch `feat/quantbook-engine`. Working copy at `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/`. HEAD is `d6a6bcdcfc5` (W5-58, FN4-01 closure). 24 commits unpushed. 1212 workspace tests, all 7 gates green at every shippable point.

## What the user wants now

> "Document, finalize, audit everything done so far, prepare the next Claude Code window that is going to handle the rest. Make sure the next window is fully optimal and knows exactly what to do and does it very well, including audits after every single phase completed or every single run completed. Document absolutely everything in detail, ensuring nothing is missed. Use Codex in everything to make sure the next window is fully optimal."

The user also asked me to think in depth WITH you (Codex) separately and build a merged plan before executing.

## Read in full before answering

Required reading (none of this is optional):

```
git log --oneline -20                              # last 20 commits
quantbook-engine/docs/MASTER-PLAN.md               # full master plan, Phase 4 status
quantbook-engine/docs/known-gaps.md                # all open + closed gaps
quantbook-engine/docs/compat/excel-matrix.md       # 217-row function compat matrix
quantbook-engine/docs/architecture/2026-05-13-graph-storage-decision.md  # W5-49 decision
quantbook-engine/docs/architecture/calcgraph-runtime.md
quantbook-engine/docs/audits/2026-05-12-phase-2B.md
quantbook-engine/docs/audits/2026-05-12-phase-3-megaudit.md
quantbook-engine/docs/audits/2026-05-13-deep-audit-closure.md
quantbook-engine/docs/audits/2026-05-13-session-handoff.md
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-prompt.md
quantbook-engine/docs/audits/2026-05-13-codex-graph-decision-review.txt   # the W5-49 Codex review
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-prompt.md
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-codex.txt    # W5-52 audit
quantbook-engine/docs/audits/2026-05-13-w5-49-50-51-megaudit-sonnet.md    # W5-52 audit (parallel)
```

Then for code state:

```
crates/ql-functions/src/registry.rs               # default_registry: 102 entries
crates/ql-functions/src/range_fns.rs              # range-aware functions (SUMIF/COUNTIF/VLOOKUP/INDEX/MATCH/MEDIAN/MODE/LARGE/SMALL/RANK/AVERAGEIF/SUMIFS/COUNTIFS/AVERAGEIFS/SUMPRODUCT/CHOOSE/HLOOKUP)
crates/ql-functions/src/scalar_fns.rs             # ~80 scalar entries
crates/ql-functions/src/range_aware_fns.rs        # FnArg infra (W5-53)
crates/ql-exec/src/scalar.rs                      # eval_scalar_with_cache + range-aware dispatch
crates/ql-exec/src/calcgraph_session.rs           # extract_and_register_deps, build_range_supplemental, on_clear_formula
crates/ql-exec/src/plan.rs                        # is_aggregate_function whitelist
crates/ql-calcgraph/src/graph.rs                  # Graph (clear_outgoing, clear_range_deps_for_formula)
crates/ql-calcgraph/src/stripes.rs                # StripeIndex (formula_to_stripe_keys)
crates/ql-calcgraph/src/topo.rs                   # schedule_with_supplemental
```

## Session ledger (10 commits)

```
d6a6bcdcfc5 W5-58 Stats family (+23 → 1212 tests; FN4-01 CLOSED at 102 entries)
7a80eaf4412 W5-57 Math completion + hyperbolic trig (+28 → 1189)
6c65fea5037 W5-56 Text wave 2 (+29 → 1161)
234d8db429c W5-55 IFS family + SUMPRODUCT (+31 → 1132)
127e42432f6 W5-54 Lookup family — VLOOKUP/HLOOKUP/MATCH/INDEX/CHOOSE (+31 → 1101)
b836236302f W5-53 GAP-F-05 + SUMIF/COUNTIF (+38 → 1070)
26e98d6b467 W5-52 Mega-audit closure (on_clear_formula HIGH fix + LOWs) (+3 → 1032)
9cb63c86cc5 W5-51 Trig batch (+13 → 1029)
bddd209f9ae W5-50 GAP-G-01 + GAP-G-03 SHIPPED (+35 → 1016)
183aad96337 W5-49 GAP-G-01 + GAP-G-03 architectural decision (doc-only)
```

## What I need from you (Codex)

This is a PLANNING brief, not an audit. The audit pass happens in a separate dispatch later. I want you to think independently about how to approach the user's ask, then I'll merge with my own plan.

Answer the following 7 questions specifically:

### 1. What artifacts should the handoff produce?

Recommend a specific list with file paths, structure, and content per artifact. I'm thinking:
- A comprehensive handoff doc summarizing the 10 commits + architectural decisions + gotchas
- An audit-protocol doc that the next window follows
- Updated `memory/current_work.md`
- The Codex/Sonnet artifacts from the meta-audit (saved alongside)

What am I missing? Push back if my list is wrong.

### 2. Audit-protocol design

Design the structure of `docs/process/audit-protocol.md`. The next window should:

- Audit after every phase completion (the W5-52 Codex+Sonnet parallel mega-audit pattern)
- Run all 7 gates at every shippable commit (fmt, clippy `-D warnings`, workspace tests, build-flags, cargo-lock pin, multiversion clones, cargo audit)
- Use Plan mode for non-trivial decisions
- Dispatch Codex BEFORE implementation for architectural choices (the W5-49 pattern → `docs/architecture/<date>-<topic>.md`)
- Stay within ≤2 plan-implement-audit cycles per session (CLAUDE.md)
- Verify state with the OrbStack `mac zsh -lc 'export PATH="$HOME/.cargo/bin:$PATH"; cargo ...'` bridge

What should the protocol explicitly require? What checks should be mandatory vs recommended? What's the optimal cadence for audits — every phase only, or every shippable commit too?

### 3. What issues across the 10 commits should I fix BEFORE handing off?

This is critical — the next window should NOT inherit known bugs / doc drift. Look for:

- Code-vs-doc drift (commit messages claim X but code shows Y)
- Test gaps that the W5-52 audit flagged but didn't fully close
- Inconsistencies (e.g., the W5-55 named-range cell-ref collision gotcha — is it documented anywhere besides the W5-55 commit message?)
- Polish items that are 5-minute fixes worth doing now (like the FLOOR vs CEILING zero-significance divergence — should that be more prominent?)
- Anything overstated in commit messages
- The `is_aggregate_function` whitelist now has SUMIF/COUNTIF/MATCH/INDEX/VLOOKUP/HLOOKUP/CHOOSE/AVERAGEIF/SUMIFS/COUNTIFS/AVERAGEIFS/SUMPRODUCT/LARGE/SMALL/RANK/RANK.EQ/MEDIAN/MODE/MODE.SNGL plus the original scalar aggregates — verify naming/comments still make sense

Be specific. Cite file paths and line numbers.

### 4. Gotchas for the next window

What sharp edges should be documented PROMINENTLY in the audit-protocol doc so the next window doesn't trip on them? My list:

- OrbStack mac bridge: `cargo` not on default PATH in the VM; needs `mac zsh -lc 'export PATH="$HOME/.cargo/bin:$PATH"; cargo ...'`
- VM `/tmp` ≠ Mac `/tmp` — Codex prompt files must live under `/Users/sanzhar/...` to be visible to both
- Named ranges colliding with cell-ref shapes (W5-55 discovery): names like `L1`, `Q1`, `A`, `B` get parsed as cell refs. Use longer names (`LabelsA`, `Prices`).
- `to_number_strict` rejects Inf/NaN at INPUT (not at output) — affects test expectations for trig fns
- VEQ + supplemental edges (Codex W5-49 watch list — still untested)
- `is_aggregate_function` whitelist must be kept in sync with `default_registry` (the test pins this)
- W5-53 introduced the `FnArg::Range { values, rows, cols }` variant; W5-54 refactored to add shape. SUMIF/COUNTIF ignore shape; lookups use it.
- Pre-commit husky hook runs `npm run -s precommit` — no special action needed unless it fails

What else am I missing?

### 5. What's the optimal next phase?

The remaining engine-plan items:
- **Phase 4.3 polish** (NOT gating wave 1): wildcards (`?` / `*`) in SUMIF/COUNTIF/SEARCH; CONCAT (range-aware CONCATENATE); PROPER / CLEAN scalar text fns; RANK.AVG (different tie semantics); CEILING.MATH / FLOOR.MATH (mode flags); MODE.MULT (returns array — needs spill); FN4-03 lazy IF/IFERROR (scalar.rs Function-branch refactor)
- **Phase 4.4** — Coercion + Error Semantics Matrix
- **Phase 4.5** — Dates / Times / Number Formats (substantial — Excel epoch policy + format parser)
- **Phase 4.6** — Cross-Sheet References + Sheet-Scoped Names
- **Phase 4.7** — Array Formulas + Dynamic Spills (the Phase 4.7 "FormulaRegion binder" deferred from W5-49)
- **Phase 4.8** — Structured References + Tables
- **Phase 4.9** — R1C1 + Localization + Implicit Intersection
- **Phase 4.10** — Function Library Wave 2 (target ~260)
- **Phase 4.11** — XLSX Import/Export
- **Phase 4.12** — Phase 4 megaudit + compat freeze

What's the RIGHT next batch? Trade-offs:
- 4.3 polish is fast + clean (low risk, high cleanup value, lets us megaudit a tight Phase 4.3)
- 4.4 is foundational (gates the rest of Phase 4 correctness work; would benefit from W5-49-style Codex-reviewed design)
- 4.5 is needed for any real workbook (dates are everywhere) but substantial scope
- 4.6 is the natural progression after function library breadth
- 4.7 unlocks dynamic-array Excel features (MODE.MULT, FILTER, SORT, etc.) and consumes Option B from W5-49

What's the optimal sequencing for the next ~5 sessions?

### 6. Next-window first 10-minute script

Write the LITERAL first 10 minutes of the next session as a concrete script of files to read + commands to run + decisions to make. Format: ordered list of actions. Include the verify-before-acting cargo test command.

### 7. Risk-of-skipping-this-audit-protocol

What's the biggest risk if the audit-protocol doc is NOT baked in? What scenarios go wrong? The user's emphasis on "audits after every single phase or run" makes this especially critical to lock down.

## Output format

```
# Codex planning verdict (one-paragraph TL;DR)

## 1. Artifacts
## 2. Audit-protocol design
## 3. Pre-handoff fixes
## 4. Gotchas
## 5. Optimal next phase
## 6. First-10-min script
## 7. Audit-skipping risks
```

Be decisive. If you disagree with my framing, say so plainly. Cite file paths + line numbers. Length budget: 2000-4000 words. Save the verdict at `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/session-finalization-planning-codex.txt` in addition to printing.

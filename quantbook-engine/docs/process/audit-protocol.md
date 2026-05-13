# Audit protocol — Quantbook engine

**Status:** MANDATORY for every Claude Code window working on the Quantbook engine.
**Established:** 2026-05-13 (W5-59 finalization session).
**Companion:** `docs/audits/2026-05-13-engine-session-final-handoff.md` (current handoff). Read that FIRST, then this.

This is the operating manual. Every rule below is either **MANDATORY**, **RECOMMENDED**, or **FORBIDDEN**. Use Codex (and where indicated, a Sonnet agent in parallel) per the cadence specified — the W5-52 mega-audit pattern caught a real HIGH bug that single-auditor review would not have found.

---

## Purpose

Lock down the practices that keep the engine shipping correct, honest, auditable code across sessions. The biggest risk is silent doc/code divergence becoming the next window's starting premise — that already almost happened in W5-50 (`on_clear_formula` clear-path bug shipped under "GAP-G-01 closed" framing; caught only by the W5-52 parallel mega-audit). This protocol prevents that.

---

## Cycle discipline (CLAUDE.md alignment)

- **MANDATORY ≤2 plan-implement-audit cycles per session.** A cycle is: design + implement + verify. If you're hitting cycle 3, STOP and write a handoff for a fresh session.
- **MANDATORY pause-for-context-reset at ~60% context budget.** Recommend fresh session at >60%; strongly recommend at >80%.
- **The W5-49 → W5-58 session ran past this limit** under explicit user direction. The user is responsible for that override — DO NOT do it on your own.

---

## Per-commit gates (MANDATORY — all 7 green at every shippable commit)

Run these as a strict block before any commit. If any fail, fix and re-run.

```bash
# 1. fmt
mac zsh -lc 'export PATH="$HOME/.cargo/bin:$PATH"; \
  cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && \
  cargo fmt --all -- --check'

# 2. clippy with -D warnings (workspace + all targets)
mac zsh -lc 'export PATH="$HOME/.cargo/bin:$PATH"; \
  cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && \
  cargo clippy --workspace --all-targets -- -D warnings'

# 3. workspace tests (verify count vs the latest baseline)
mac zsh -lc 'export PATH="$HOME/.cargo/bin:$PATH"; \
  cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && \
  cargo test --locked --workspace 2>&1 | grep -E "^test result:" | \
  awk "/ok\. [0-9]+ passed/ {sum+=\$4} END {print sum}"'

# 4. build-flags guard (catches -Ctarget-cpu=native sneaking in)
bash /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/scripts/check-build-flags.sh

# 5. cargo-lock pin guard (18 watched packages must stay aligned)
bash /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/scripts/check-cargo-lock-pins.sh

# 6. multiversion clones (Mac-side disassembly check)
mac zsh -lc 'bash /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/scripts/check-multiversion-clones.sh'

# 7. cargo audit (1 pre-existing allowed warning OK: atomic-polyfill)
mac zsh -lc 'export PATH="$HOME/.cargo/bin:$PATH"; \
  cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && \
  cargo audit'
```

**FORBIDDEN:**
- Committing without all 7 gates green.
- Bypassing gates with `--no-verify` (the pre-commit husky hook). If a hook fails, fix the underlying cause.
- Claiming "all gates green" in a commit message without actually running them.

**RECOMMENDED:**
- Run a targeted `cargo test -p <crate> --lib <pattern>` first when iterating; full workspace last.
- After `docs/compat/excel-matrix.md` edits, run `scripts/report-compat-coverage.sh` to confirm coverage number is honest.
- Before `git commit`, run `git diff --check` for whitespace errors.

---

## Per-phase mega-audit (MANDATORY — the W5-52 pattern)

After every phase completion OR substantial run (e.g. ≥3 commits in one feature area), dispatch **TWO independent auditors in parallel**: Codex and a Sonnet agent. Why both: the W5-52 audit found a HIGH bug because both auditors independently flagged it — single-auditor review would not have given the same confidence.

### Auditor brief template

The brief MUST include:
1. **Context** — branch state, HEAD, commits to audit (shas), test count, gate status
2. **Required reading** — exact file paths (docs + code) the auditor must read
3. **Session ledger** — commit-by-commit summary
4. **Specific concerns** — what to challenge (don't just ask "is it correct"; ask 6-8 concrete questions, like the W5-49 review brief did)
5. **What to report** — HIGH / MEDIUM / LOW + test gaps + verdict

Save brief at `docs/audits/<date>-<scope>-megaudit-prompt.md`.

### Codex dispatch

```bash
mac zsh -lc 'codex exec \
  --skip-git-repo-check \
  --sandbox read-only \
  --color never \
  -C /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook \
  < /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/audits/<date>-<scope>-megaudit-prompt.md \
  > /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/audits/<date>-<scope>-megaudit-codex.txt \
  2>&1; echo CODEX_EXIT=$?'
```

Run **in background** (`run_in_background: true` on Bash tool, 600000ms timeout).

### Sonnet agent dispatch

Use the `Agent` tool with `subagent_type: "general-purpose"` and `model: "sonnet"`. Pass the same brief. Tell it to save its report at `docs/audits/<date>-<scope>-megaudit-sonnet.md`. Run **in background** as well so both auditors execute in parallel.

### Synthesis (Codex Patience rule)

- **MANDATORY:** wait for BOTH to complete before reading either. Do not pre-write conclusions.
- **MANDATORY:** read Codex's full output (often 5-10k lines). Critical findings are often near the end.
- Compare findings:
  - **HIGH found by BOTH** = real correctness bug. Fix immediately before any other work.
  - **HIGH found by ONE** = investigate carefully; usually real but verify with code reading.
  - **MEDIUM** = either fix or file in `known-gaps.md` with target phase.
  - **LOW / doc-drift** = fix immediately if 5-min; else defer with explicit note.

### Closure commit

After fixes, commit a closure commit (e.g. `W5-NN / <scope>-megaudit-closure: <HIGH fix subjects>`). Reference both auditors in the commit message.

**FORBIDDEN:**
- Claiming "audit clean" without dispatching either auditor.
- Synthesizing before both auditors complete.
- Treating Sonnet's distilled report as a replacement for Codex's full review (each catches things the other misses).

---

## Architectural-decision pattern (MANDATORY for non-trivial design)

When facing a design with multiple valid approaches, breaking changes, or architecture impact (e.g. W5-49's graph storage choice), follow this pattern:

1. **Enter Plan mode** via `EnterPlanMode` tool.
2. **Read enough code** to ground the decision (don't decide from memory).
3. **Dispatch Codex for an independent second opinion BEFORE implementing.** Brief Codex on the problem, the options you're considering, and your preliminary view. Ask Codex to challenge — not validate.
4. **Wait for Codex's full output** (Codex Patience).
5. **Write a decision doc** at `docs/architecture/<YYYY-MM-DD>-<topic>.md`. Include: problem, options, decision, reasoning, implementation outline, Codex review summary, risks, stop conditions.
6. **Call ExitPlanMode** for user approval.
7. **Implementation in the next session (or same if the implementation is small).**

This is the W5-49 pattern that produced `docs/architecture/2026-05-13-graph-storage-decision.md` and the W5-49 Codex review at `docs/audits/2026-05-13-codex-graph-decision-review.txt`.

**FORBIDDEN:**
- Making non-trivial architectural decisions without Codex consultation.
- Implementing without a decision doc when the change has multiple valid approaches.
- Treating Plan mode as optional for non-trivial work.

---

## Codex dispatch — exact incantation

```bash
mac zsh -lc 'codex exec \
  --skip-git-repo-check \
  --sandbox read-only \
  --color never \
  -C /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook \
  < <prompt-file-under-/Users/sanzhar/...> \
  > <output-file-under-/Users/sanzhar/...> \
  2>&1; echo CODEX_EXIT=$?'
```

**Constraints:**
- Run via `mac zsh -lc` — codex lives on the Mac host (`~/.nvm/versions/node/.../bin/codex`).
- Prompt + output files MUST live under `/Users/sanzhar/...` (shared filesystem); `/tmp` is split between VM and Mac (see Gotchas).
- Background only (`run_in_background: true` on Bash tool); 600000ms (10 min) timeout.
- DO NOT poll; wait for the task notification.
- Read full output before responding; critical findings often near the end.

---

## Session-start checklist (MANDATORY)

Every Claude Code window working on the engine begins with:

```
[ ] Read auto-memory current_work.md (auto-loaded at session start)
[ ] Read docs/audits/<latest>-session-handoff.md cover-to-cover
[ ] Read this audit-protocol doc cover-to-cover
[ ] Read docs/MASTER-PLAN.md (current phase status)
[ ] Read docs/known-gaps.md (open + recently closed gaps)
[ ] cd to repo root, git status -uno (clean expected), git log --oneline -15
[ ] Run cargo test --workspace via mac bridge — confirm baseline test count
[ ] Run the 7 gates per § Per-commit gates — confirm clean state
[ ] Decide work mode (per-handoff-recommendation or user-requested)
```

**FORBIDDEN:** starting code work without all 9 items above completed.

---

## Critical gotchas — sharp edges the next window must know

These are bugs that have actually tripped me up. Read them before any work.

### 1. OrbStack mac bridge — cargo PATH

`cargo` is NOT on the default PATH inside the OrbStack Linux VM. EVERY cargo command must go through:

```bash
mac zsh -lc 'export PATH="$HOME/.cargo/bin:$PATH"; \
  cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && \
  cargo <subcommand> [args]'
```

A direct `cargo test --workspace` from inside the VM SILENTLY produces no output (it can't find `cargo`).

### 2. VM `/tmp` ≠ Mac `/tmp`

When dispatching Codex via `mac zsh -lc 'codex exec ...'`, the prompt and output files MUST live under `/Users/sanzhar/...` (shared filesystem). `/tmp/anything` is invisible across the boundary. Examples:
- BAD: prompt at `/tmp/audit-prompt.md`
- GOOD: prompt at `/Users/sanzhar/.../quantlab-quantbook/quantbook-engine/docs/audits/<file>.md`

### 3. Named-range cell-reference collision (W5-55)

Short uppercase-letter-plus-digit identifiers like `L1`, `Q1`, `A`, `B`, `XFD1048576` are PARSED AS CELL REFERENCES by the formula parser, not as name lookups. This is true even when the name is registered in the workbook's NameTable. The binder does not currently consult the name table for tokens shaped like cell refs.

**Practical rule:** name your ranges with multi-character non-cell-ref names: `LabelsA`, `Prices`, `Quantities`, `MyTable`, `Sales2024`. Avoid: anything 1-2 letters followed by digits.

Phase 4.6 (cross-sheet refs) may revisit this — filed as future-binder-ambiguity follow-up in the W5-55 commit message and `docs/audits/2026-05-13-engine-session-final-handoff.md`.

### 4. `to_number_strict` rejects ±Inf and NaN at INPUT

`coerce_numeric` calls `coercion::to_number_strict` which rejects `Value::Number(±Inf)` and `Value::Number(NaN)` with `Err(ErrorValue::Num)` BEFORE the function body sees the value. So even `atan(INFINITY)` (mathematically well-defined as ±π/2) returns `#NUM!`.

When writing tests, expect `#NUM!` for ±Inf/NaN inputs to any function that goes through `coerce_numeric`, regardless of whether the math would be defined.

### 5. `is_aggregate_function` whitelist sync invariant

The `is_aggregate_function` matcher in `crates/ql-exec/src/plan.rs` is the binder's decision for "does this function accept aggregate-range / named-range args." Every range-aware function (SUMIF, COUNTIF, lookups, IFS family, stats) plus scalar aggregates (SUM, AVERAGE, etc.) must be in this list.

The invariant test `is_aggregate_function_lists_only_registered_aggregates` in `workbook_runtime.rs` enforces sync between this list and the registry. If you add a range-aware function:

1. Register in `default_registry` via `register_range_aware`
2. Add to `is_aggregate_function` whitelist
3. Extend the invariant test

**Misleading name:** `is_aggregate_function` is really "function whose arg list allows `AggregateNameRef` in arg positions" — not "is a scalar aggregate." Rename pending Phase 4.7 / Phase 4.10 when per-function metadata replaces this hardcoded list.

### 6. `FnArg::Range { values, rows, cols }` shape contract (W5-54)

`FnArg::Range` is a struct variant since W5-54. Shape invariant: `rows * cols == values.len()`.

- 1D consumers (SUMIF, COUNTIF) pattern-match `FnArg::Range { values, .. }` and iterate flat.
- 2D consumers (VLOOKUP, HLOOKUP, INDEX) use full shape: `values[row * cols + col]`.
- The dispatcher builds shape via `env.read_range_with_shape(range)` — `WorkbookEnv` clamps to sheet bounds.

**Shape bugs pass SUMIF/COUNTIF tests** (which ignore shape) but fail VLOOKUP/INDEX. When debugging range-aware functions, check shape FIRST.

### 7. Range-aware dispatch checks `lookup_range_aware` FIRST

In `scalar.rs::eval_scalar_with_cache`, the function dispatch:
```rust
if let Some(raf) = registry.lookup_range_aware(name) { /* build Vec<FnArg> */ }
else { /* fall through to scalar lookup */ }
```

If you register a range-aware function via the scalar `register(...)` method by accident, it SILENTLY loses range shape: the dispatch builds flat `Vec<Value>` from a flattened range, the function gets a list of Values without per-arg structure, and SUMIF-style semantics break in subtle ways.

**Always use `register_range_aware` for range-aware functions.** The registry's cross-table-collision panic catches the reverse (registering both scalar and range-aware with the same name).

### 8. `FunctionRegistry::names()` only returns scalar names

The `names()` iterator on `FunctionRegistry` only walks the scalar `fns` table — it does NOT include range-aware names. Any code that enumerates the registry (e.g. to dump the function list) must walk both `fns` AND `range_aware_fns`. Currently no caller does this; this is a latent bug if any enumeration code is added.

### 9. `Graph::clear_outgoing` / `clear_range_deps_for_formula` bump revision even on no-op

Both APIs always bump `Graph::revision()` even when called on a node with no outgoing edges / no range deps. State-idempotent, revision-not-idempotent. Affects only callers using revision as a cheapness proxy — none today, but Phase 4.7 array formulas may add one.

### 10. VEQ + supplemental edges — UNTESTED interaction

Codex's W5-49 watch list named: "VEQ behavior for range-dep formulas (Phase 3.8 short-circuit + supplemental edges must compose)." Phase 3.8's value-equality short-circuit may interact with W5-50's `supplemental` edges in unexpected ways. No test covers this composition. Add a regression test if Phase 4.7 (or earlier) touches either path, OR if a real bug surfaces in the field.

### 11. CEILING(n, 0) vs FLOOR(n, 0) divergence

Excel canon (NOT a bug):
- `CEILING(n, 0)` → returns `0` even for non-zero `n`.
- `FLOOR(n, 0)` → returns `#DIV/0!` for non-zero `n`; `0` for `n=0`.

Easy to "normalize" these two into matching behavior. DON'T — Excel disagrees with itself on the two functions.

### 12. macOS `/tmp/xcrun_db` warnings under sandbox

When Codex runs with `--sandbox read-only`, git emits:
```
warning: confstr() failed with code 5: couldn't get path of DARWIN_USER_TEMP_DIR; using /tmp instead
```

These are NOT failures. Ignore.

### 13. 24+ commits unpushed BY DESIGN

The session intentionally accumulates commits locally per CLAUDE.md's "never push unless asked" rule. The next window should default to NOT pushing. Only push when the user explicitly says so.

### 14. Repo root broad search

The workspace root has `node_modules/`, session-export `.txt` files, etc. Broad `rg` / `find` from repo root returns huge unrelated results. Scope to `quantbook-engine/` unless intentionally checking workspace-level files.

### 15. Pre-commit husky hook

`git commit` triggers `npm run -s precommit` (a husky hook). It's automatic; no special action needed unless it fails. Per CLAUDE.md, DO NOT bypass with `--no-verify` — fix the underlying issue.

---

## Audit-closure expectations

After any audit (per-phase mega-audit, or per-commit gate failure that surfaces a finding):

- **HIGH (correctness bug, false-confidence ship):** fix IMMEDIATELY. Write a closure commit (`W5-NN / <scope>-audit-closure`). Document fix + reference auditor finding.
- **MEDIUM (overstatement, scope gap, missing test):** fix if 5-min; otherwise file in `docs/known-gaps.md` with target phase. NEVER ignore.
- **LOW (doc typo, naming inconsistency):** fix immediately during closure; or batch into the next regular commit with an "audit cleanup" subject line.

**FORBIDDEN:**
- Ignoring a HIGH finding.
- Calling something "fixed" without a regression test.
- Claiming a phase complete with open MEDIUM findings unfiled.

---

## When NOT to push

**MANDATORY default: don't push.** Per CLAUDE.md and the session's accumulated 24+ local commits, push only when:

- The user explicitly says "push", or
- A planned CI run / collaborator handoff requires it (with explicit user approval).

`git push` is a hard-to-reverse, externally-visible action; treat it accordingly.

---

## Cycle budget tracking (in your own task list)

Track cycles explicitly in your `TaskCreate` / `TaskList` workflow:
- Cycle 1: design / decision / Plan mode work
- Cycle 2: implementation OR audit-closure
- If contemplating cycle 3: write a handoff, end the session.

---

## Decision tree (what to do when)

```
User request comes in
  │
  ├─ Trivial 1-line fix? → Direct edit + 7 gates + commit
  │
  ├─ Non-trivial implementation?
  │   ├─ Architectural choice (multiple valid approaches)?
  │   │   → Plan mode + Codex BEFORE implementation + decision doc
  │   ├─ New batch of similar functions (e.g. text wave 2)?
  │   │   → Implement with 7 gates per commit + per-batch audit
  │   └─ Substantial cross-cutting change?
  │       → Plan mode + Codex review + multi-cycle plan
  │
  ├─ Phase boundary or end of substantial run?
  │   → MANDATORY Codex + Sonnet parallel mega-audit
  │
  └─ Hit cycle 3?
      → STOP. Write handoff. End session.
```

---

## What good looks like

A session that follows this protocol produces:
- Every commit's 7 gates green
- One decision doc per architectural choice
- One mega-audit (Codex + Sonnet) per phase or substantial run
- All HIGH findings closed in the same arc
- An updated handoff doc at session end
- An updated `memory/current_work.md`
- ≤2 cycles
- Zero pushed commits unless explicitly requested

The W5-49 → W5-58 session matched most of this except cycle-count discipline (user-overridden, with quality preserved by per-commit gates + per-phase audits).

---

## Provenance

Established by Claude Opus 4.7 in the W5-59 finalization session, 2026-05-13. Codex co-author for the protocol design via the planning brief at `docs/audits/2026-05-13-finalization-planning-prompt.md` and Codex's verdict at `docs/audits/2026-05-13-finalization-planning-codex.txt`. The protocol is a forcing function: it makes every session leave an auditable trail of what changed, what was checked, and what the next window must not assume.

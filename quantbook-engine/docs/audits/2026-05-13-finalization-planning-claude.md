# My (Claude Opus) own planning draft

Independent of Codex. Will merge with Codex's response when it returns.

## 1. Artifacts to produce

### A. `quantbook-engine/docs/audits/2026-05-13-session-comprehensive-handoff.md` — THE handoff

Single source of truth for everything that happened W5-49 → W5-58. Structure:

1. One-line summary + branch state
2. Verify-before-acting commands (mac PATH + cargo test)
3. Session ledger (10 commits table)
4. Architectural decisions (W5-49 graph storage; W5-52 clear-formula; W5-53 RangeAwareFn; W5-54 FnArg 2D shape)
5. Per-commit detailed shipped contents
6. Known divergences from Excel canon (UTF-8/16, ROUNDUP binary-float, UPPER ß→SS, text in range, wildcards)
7. Closed gaps this session (GAP-G-01, G-03, F-05)
8. Open gaps + carryovers (GAP-R-07, R-08, R-01, R-06, S-06, G-02; FN4-03; polish items)
9. Phase 4 sub-item status table
10. Critical gotchas (cross-reference audit-protocol doc)
11. Recommended next phase + trade-offs
12. Pointers (audit-protocol, memory, master plan, decision doc)

### B. `quantbook-engine/docs/process/audit-protocol.md` — THE protocol (new directory)

Operating manual for the next window. Structure:

1. Purpose statement
2. Cycle discipline (≤2 per CLAUDE.md, pause/reset rules)
3. Per-commit gates (7, exact commands incl. mac bridge)
4. Per-phase mega-audit (W5-52 pattern: Codex+Sonnet parallel, brief template)
5. Architectural decision pattern (W5-49: Plan mode + Codex review + decision doc)
6. Codex dispatch incantation + shared-fs requirement + 10-min budget
7. Critical gotchas:
   - cargo PATH in VM
   - VM/Mac /tmp split
   - Named-range cell-ref collision (W5-55 discovery)
   - to_number_strict rejects Inf/NaN at input
   - VEQ + supplemental edges untested
   - is_aggregate_function whitelist sync invariant
   - FnArg::Range shape contract (W5-54)
   - W5-53 RangeAwareFn dispatch goes through `lookup_range_aware` FIRST
8. Files to read at session start (ordered)
9. When NOT to push (default: don't, per CLAUDE.md)
10. Pre-flight checklist (the first-10-min script)
11. Decision tree (non-trivial? plan-mode; phase boundary? mega-audit; new pattern? decision doc; cycle 3? stop)

### C. Updated `~/.claude/projects/-Users-.../memory/current_work.md`

- Date-stamp updated
- Primary pointer: handoff doc
- Secondary pointer: audit protocol
- Branch + HEAD + test count
- Next-phase recommendation summary

### D. Codex planning artifact

Save Codex's planning response at:
`quantbook-engine/docs/audits/2026-05-13-session-finalization-planning-codex.txt`

(After meta-audit, also save Codex+Sonnet meta-audit at:
`quantbook-engine/docs/audits/2026-05-13-session-megaudit-{codex.txt,sonnet.md,prompt.md}`)

## 2. Audit-protocol design

I think the next window should follow this strict workflow:

**Per shippable commit (mandatory, every commit):**
- All 7 gates: fmt, clippy -D warnings, workspace tests, build-flags, cargo-lock pin, multiversion-clones, cargo audit
- Commit message tracks tests delta + which gates ran

**Per phase completion (mandatory):**
- Mega-audit via Codex + Sonnet parallel (the W5-52 pattern)
- Both auditors get same brief
- Synthesize independently
- HIGH issues → immediate closure commit
- MEDIUM/LOW → documented or fixed per scope

**Per architectural decision (mandatory if non-trivial):**
- Enter Plan mode
- Dispatch Codex for second opinion BEFORE implementation
- Write decision doc at `docs/architecture/<date>-<topic>.md`
- ExitPlanMode for approval
- Implementation in subsequent session (or same if small)

**Per session entry (mandatory):**
- Read memory/current_work.md
- Read latest session-handoff doc
- Read audit-protocol doc
- Run 7 gates to verify clean state
- THEN start work

**Cycle limits (CLAUDE.md):**
- ≤2 plan-implement-audit cycles per session
- If hitting cycle 3, pause and hand off to fresh session
- The 10-commit-this-session pattern was due to user override; default is ≤2

## 3. Pre-handoff fixes I'd apply

Before committing W5-59 (the finalization commit):

1. **Search for W5-55 named-range gotcha mentions** — make sure it's documented in the audit-protocol doc gotchas section, not just buried in a commit message
2. **Verify all `is_aggregate_function` entries** have matching registry registrations (the invariant test should catch this but a manual check is cheap)
3. **Scan for doc-vs-code drift** — does MASTER-PLAN say "X shipped W5-Y" accurately?
4. **Test the actual handoff doc by trying to follow it** — read it as if I were the next window
5. **Don't touch any code in W5-59** — pure docs + memory commit

## 4. Gotchas list

In priority order (most critical first):

1. **OrbStack mac bridge** — `cargo` is NOT on the default PATH inside the Linux VM. Use `mac zsh -lc 'export PATH="$HOME/.cargo/bin:$PATH"; cargo ...'` for every cargo command. Tripped me up multiple times early in the session.

2. **VM `/tmp` ≠ Mac `/tmp`** — When dispatching Codex (`mac zsh -lc 'codex exec ...'`), the prompt + output files must live in `/Users/sanzhar/...` (shared filesystem). Anything in `/tmp` is invisible across the boundary.

3. **Named-range cell-reference collision (W5-55)** — Names like `L1`, `Q1`, `A`, `B`, `XFD1048576` get PARSED as cell references, NOT as name lookups. Use longer names (`LabelsA`, `Prices`, `MyTable`) in tests. The binder doesn't consult the NameTable for identifiers shaped like cell refs.

4. **`to_number_strict` rejects Inf/NaN at INPUT** — affected my W5-51 trig tests. `Value::Number(f64::INFINITY)` → `to_number_strict` → `Err(ErrorValue::Num)` BEFORE the function body sees the value. So even `atan(INFINITY)` which is well-defined returns `#NUM!`.

5. **`is_aggregate_function` whitelist sync** — every range-aware function (SUMIF, COUNTIF, lookups, IFS, stats) must be added to BOTH `default_registry` and the `is_aggregate_function` whitelist. The invariant test `is_aggregate_function_lists_only_registered_aggregates` enforces this.

6. **`FnArg::Range { values, rows, cols }` shape** — W5-54 made this a struct variant. Pattern-match `FnArg::Range { values, .. }` for 1D consumers (SUMIF, COUNTIF). Use full shape for VLOOKUP/HLOOKUP/INDEX.

7. **VEQ + supplemental edges (untested)** — Codex's W5-49 watch list named "VEQ behavior for range-dep formulas (Phase 3.8 short-circuit + supplemental edges must compose)". I never added a test. Could surface as a real bug if a range-dep formula's value happens to equal its prior.

8. **Pre-commit husky hook** — Runs `npm run -s precommit`. Don't bypass with --no-verify per CLAUDE.md.

9. **24 commits unpushed** — by design, per CLAUDE.md "never push unless asked". Next window should default to not pushing.

## 5. Optimal next phase

My recommendation: **Phase 4.3 polish in one tight commit, then pivot to 4.4 with W5-49-pattern decision doc.**

Reasoning:
- 4.3 polish (wildcards in SUMIF/COUNTIF/SEARCH + CONCAT + PROPER + CLEAN + FN4-03 lazy IF/IFERROR) is ~6-8 small functions, all using existing infra, fits one focused session. Closes Phase 4.3 cleanly for the Phase 4.12 megaudit later.
- Then 4.4 (Coercion + Error Semantics Matrix) is the most foundational of the remaining sub-items. Gates correctness of every subsequent phase. The Codex-reviewed design pass (W5-49 pattern) makes sense here because the coercion rules tie into binder + scalar.rs + every function — getting it wrong is expensive.

Alternative: skip 4.3 polish, go straight to 4.4. Pros: bigger phase-level progress. Cons: leaves loose ends for Phase 4.12 megaudit.

Sequencing for the next ~5 sessions:
1. **Session N+1**: 4.3 polish batch (one commit, ~6-8 functions + wildcards in SUMIF/COUNTIF/SEARCH + FN4-03 lazy IF). 1212 → ~1240 tests.
2. **Session N+2**: 4.4 architectural decision (Plan mode + Codex). Decision doc at `docs/architecture/2026-05-14-coercion-matrix.md`. No code.
3. **Session N+3**: 4.4 implementation. Centralized coercion module. Per-function audit against the matrix.
4. **Session N+4**: 4.5 dates + times (Excel epoch policy + format parser). Substantial.
5. **Session N+5**: 4.6 cross-sheet refs (binder + runtime).

Then 4.7 (array formulas / FormulaRegion binder, the W5-49 Option B) is the next big architectural beat, gating 4.8 / 4.9 final pieces, then 4.10/4.11/4.12 to close Phase 4.

## 6. First-10-minute script for next window

```
1. Read auto-memory current_work.md (auto-loaded at session start)
2. Read quantbook-engine/docs/audits/2026-05-13-session-comprehensive-handoff.md cover-to-cover
3. Read quantbook-engine/docs/process/audit-protocol.md cover-to-cover (especially the gotchas section)
4. cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
5. git log --oneline -12   # verify HEAD includes W5-58 + any W5-59/60 finalization commits
6. git status -uno  # expect clean
7. git branch --show-current  # expect feat/quantbook-engine
8. mac zsh -lc 'export PATH="$HOME/.cargo/bin:$PATH"; cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && cargo test --workspace 2>&1 | grep -E "^test result:" | awk "/ok\. [0-9]+ passed/ {sum+=\$4} END {print sum}"'   # expect 1212+
9. Verify all 7 gates clean per audit-protocol (run them)
10. If user has asked for specific work → execute. Otherwise default to next-phase per the handoff doc's recommendation. If the work is non-trivial (architectural), enter Plan mode + dispatch Codex per the audit-protocol.
```

## 7. Audit-skipping risks

Without the audit protocol baked in:

1. **Hidden bugs ship.** The W5-52 audit found a real HIGH bug (on_clear_formula clear-path) that neither I nor Codex flagged during W5-50. Without the audit pattern, that bug would have shipped silently.

2. **Doc drift accumulates.** I had several minor doc-vs-code drifts (ATAN2 docstring "y, x" vs "x, y") that the W5-52 audit caught. Without per-phase audits, these compound.

3. **Test gaps become invisible.** The Sonnet+Codex parallel pattern triangulates differently than either alone. Each catches things the other misses (e.g., Sonnet caught the supplemental-edge duplicate-G issue Codex missed).

4. **Architecture-doc-vs-implementation drift.** Without the W5-49 pattern, architectural choices get made implicitly and then can't be challenged later.

5. **Cycle creep.** Without ≤2-cycle discipline, sessions become "15 plan-implement-audit cycles" like the prior session — quality stays honest at each step but the cumulative effect is poor decision-making at the macro level.

6. **The user's explicit ask** — "audits after every single phase or every single run" — is satisfied only by an explicit protocol. The next window cannot reliably infer this from prior commits.

## Plan for the actual execution

After Codex returns:
1. Read its full output
2. Merge any new insights into my draft
3. Write the comprehensive handoff doc
4. Write the audit-protocol doc
5. Update memory/current_work.md
6. Run 7 gates + commit W5-59
7. Meta-audit via Codex+Sonnet parallel
8. Apply any meta-audit findings + W5-60 closure if needed
9. Final summary to user

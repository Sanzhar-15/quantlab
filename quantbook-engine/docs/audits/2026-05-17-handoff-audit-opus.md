# Handoff doc audit — Opus, 2026-05-17

**Target:** `~/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/quantbook_engine_session_2026_05_14_handoff.md`
**Audit goal:** verify a fresh post-compaction session can pick up from this doc alone, with no ambiguity.

## Verification performed

- `git log --oneline -1` → `2c308332ab5 W5-183.1 / VDB audit closures` ✓ matches handoff.
- `git branch --show-current` → `feat/quantbook-engine` ✓.
- `git rev-list --count origin/main..HEAD` → `292` ✓ matches handoff line 34.
- Workspace test run (via `mac zsh -lc 'cargo test --workspace ...'`) → `3082 passing` ✓.
- `assert_eq!(r.len(), 193)` in `crates/ql-functions/src/registry.rs:800` ✓ matches handoff's 193-fns claim.
- Session arc commit count `git log ccae0a64c3a^..2c308332ab5 | wc -l` → 50 ✓.
- Internal commit-segment arithmetic 17+7+12+5+1+1+1+1+1+1+1+1+1 = 50 ✓.
- Test cumulative arithmetic (2932 → 2948 → 2968 → 2988 → 3007 → 3024 → 3042 → 3048 → 3070 → 3082) ✓.
- File-path existence: `docs/audits/2026-05-17-w5180-w5182-depreciation-audit-summary.md`, `docs/audits/2026-05-17-w5183-vdb-audit-summary.md`, `docs/architecture/2026-05-16-phase-4.10-function-library-wave-2.md`, `docs/compat/excel-matrix.md`, `docs/MASTER-PLAN.md`, `.references/ironcalc/base/src/functions/statistical/{correl.rs,pearson.rs}`, `.references/ironcalc/base/src/functions/financial.rs`, all closing-megaudit codex docs ✓.
- `/home/sanzhar/.claude/projects/.../memory/quantbook_engine_audit_discipline.md` exists ✓.
- `MEMORY.md` points to both the handoff doc AND the audit-discipline memory ✓.
- Audit-log HEAD references: W5-182.1 → `1e0916ba3ad` ✓; W5-183.1 → `2c308332ab5` ✓ (verified via `git log`).
- VDB row in `docs/compat/excel-matrix.md` line 265: ✅ with 33 tests ✓ matches handoff.

The handoff is **substantially accurate and self-sufficient** for a cold-start pickup. The ground-truth numbers (HEAD, branch, test count, fn count, ahead-of-origin, audit doc paths, IronCalc reference paths) are all correct. The forward map is concrete. The audit-discipline rule is discoverable both via the wikilink in the handoff and the explicit MEMORY.md pointer.

Findings below are accuracy / consistency / discoverability nits; none are session-blocking.

---

### HIGH-1: "2 convergent HIGHs" claim for W5-183.1 is inaccurate — `salvage > cost` was Codex-only, not convergent

**Location:** `quantbook_engine_session_2026_05_14_handoff.md` lines 23, 33, 275-279, 419 (across multiple summary sections).

**Issue:** The handoff repeatedly characterizes W5-183.1 as having "**2 convergent HIGHs**: DoS guard off-by-one ... + `salvage > cost` silent-zero." The audit summary (`docs/audits/2026-05-17-w5183-vdb-audit-summary.md`) is unambiguous that only **DoS off-by-one** was convergent (Codex MEDIUM-1, Opus HIGH-1, reconciled to HIGH). `salvage > cost` was a **Codex-only** finding (Codex HIGH-1; not in Opus's list). The audit summary explicitly lists it under "Codex-unique findings". Even the handoff itself, on line 279, correctly calls it "Codex HIGH" — but the TL;DR + audit log do not match.

**Why it matters for a fresh session:** A new session reading the TL;DR will form an inaccurate model of how parallel-audit convergence works in practice — leading to over-confidence that "if both reviewers catch X it's convergent" when in reality the doc bundles Codex-unique findings into the convergence claim. This undermines one of the doc's most important teaching moments (the value of parallel-audit-with-distinct-models).

**Fix:** Reword to "2 HIGH findings (1 convergent on DoS off-by-one — Codex MEDIUM, Opus HIGH; 1 Codex-only on `salvage > cost`)." Apply the same rewording on lines 23, 33, and 419. Optionally also note that the actual VDB-audit lesson is "non-overlapping findings is the point" — Codex caught what Opus missed and vice versa.

---

### HIGH-2: Section header "8 commits" contradicts table + frontmatter "7 commits"

**Location:** Line 51 (`### Phase 4.8.G.3 calcgraph-hook polish wave (W5-154 → W5-161, 8 commits)`) vs line 3 frontmatter (`4.8.G.3 (7 commits)`) and line 450 table (`Phase 4.8.G.3 ...    7 commits`).

**Issue:** Ground truth: `git log b83c19c7a7d^..39e17bc4167 | wc -l` = 7. W5-160 was skipped per the table footnote on line 450 ("W5-160 skipped"). The "8 commits" prose label is wrong — the W5-numbering range 154→161 spans 8 W5 numbers but only 7 commits exist.

**Why it matters for a fresh session:** Self-contradiction in commit counts undermines confidence in the broader doc. A reader cross-checking against `git log` will land on either side of the contradiction and have to resolve it manually.

**Fix:** Change line 51 to `### Phase 4.8.G.3 calcgraph-hook polish wave (W5-154 → W5-161, 7 commits; W5-160 skipped)`.

---

### MEDIUM-1: VDB test-delta discrepancy (`+11 net` on line 296 vs `+12 tests` on line 461)

**Location:** Lines 259, 296 say "added 11 more tests" / "VDB tests: 22 → 33 (+11 net)"; line 461 commit-segment table says `W5-183.1 ... +12 tests; 3070 → 3082`.

**Issue:** Both can be true (VDB gained 11, DB gained 1 from `db_huge_life_rejected` upgrade → 12 total), but the handoff doesn't reconcile them. A reader auditing the numbers will see "+11" vs "+12" and assume drift.

**Why it matters for a fresh session:** Minor confusion when verifying numbers. Not blocking but undermines the doc's reliability budget when investigated.

**Fix:** Add a parenthetical on line 296 like "(+11 VDB; DB +1 from upgraded `db_huge_life_rejected` test → +12 total). " OR add an explicit "+1 DB" entry to the table line on 461.

---

### MEDIUM-2: Test count summary "2862 → 2932" on line 452 has no upstream anchor

**Location:** Line 452: `Phase 4.10 polish (W5-173 → W5-176):      5 commits  ... (+70 tests; 2862 → 2932)`.

**Issue:** The starting point 2862 isn't established earlier in the table. Phase 4.9 ends at 2642 (line 449); Phase 4.8.G.3 and Wave 2 both say "+ε tests" with no number. Then suddenly the polish row starts at 2862. The math 2862-2642 = +220 tests across Phase 4.8.G.3 + Wave 2 is unstated.

**Why it matters for a fresh session:** Cumulative arithmetic verification fails unless reader knows the +220 implicit gap. Anyone running `git log --grep` to verify will have to reconstruct.

**Fix:** Replace "+ε tests" on lines 450-451 with explicit values: Phase 4.8.G.3 +N, Wave 2 +M, summing to the 2862 anchor. The actual deltas can be derived from `git diff` between segment boundaries.

---

### MEDIUM-3: Wikilink filename mismatch (`[[quantbook-engine-audit-discipline]]` vs `quantbook_engine_audit_discipline.md`)

**Location:** Lines 3, 219, 421, 471 reference `[[quantbook-engine-audit-discipline]]` (dashes); the actual filename on disk is `quantbook_engine_audit_discipline.md` (underscores).

**Issue:** The wikilink uses the YAML `name:` field. Whether a fresh session's tooling resolves `[[name]]` to the on-disk underscored filename depends on what reads the memory. If the resolver only supports literal filenames, the wikilink fails. MEMORY.md does provide the correct underscored filename, but the handoff doc by itself would not lead the reader to the right `ls` target.

**Why it matters for a fresh session:** Discoverability of the most important workflow rule introduced in this session. If a session reads only the handoff (not MEMORY.md) and tries to open the linked memory by filename, the lookup fails.

**Fix:** Either change the four wikilinks to explicit filename references like `[quantbook-engine-audit-discipline](quantbook_engine_audit_discipline.md)`, or add a clarifying parenthetical on first use: `[[quantbook-engine-audit-discipline]] (file: quantbook_engine_audit_discipline.md)`.

---

### MEDIUM-4: "Reading order" section item 1 says "THIS doc (you're reading it)" but pickup checklist on line 336 is more discoverable

**Location:** Lines 468-478 ("Reading order for the next session") and 336-351 ("Pickup checklist").

**Issue:** The handoff has two near-duplicate "where to start" sections. A fresh session arriving at the doc top will find the TL;DR + "Fresh-session opener" code block + "Pickup checklist" + "Forward map" + ... eventually a "Reading order" near the bottom. The two pickup paths are mostly compatible but the "Reading order" reorders a few items (audit summaries before architecture; etc.). Not strictly contradictory, but redundant.

**Why it matters for a fresh session:** A reader who follows the "Reading order" verbatim may double-read the audit summaries (steps 3-4 of "Reading order" duplicates step 2 of "Pickup checklist"). Wasted cycles.

**Fix:** Either delete one and refactor the other to be the canonical path, OR cross-reference: in "Pickup checklist" add "(extended reading order below at § Reading order)" and in "Reading order" lead with "First 5 minutes covered above at § Pickup checklist; this is the deep-dive list".

---

### MEDIUM-5: Forward map's "Option A.1 Reference-tier" architectural scope is light on file paths

**Location:** Lines 360-364 (Option A.1).

**Issue:** Per audit checklist item 6 (forward map completeness), reference-tier is the highest-priority next move but the scoping says: "Needs new `FunctionArg::Reference { sheet, row, col }` tier + `ReferenceAwareFn` signature in `crates/ql-functions/src/registry.rs`. Today's `FunctionArg` has only `Scalar` and `Range` — no address handle. ~3-5 days incl. design doc."

That's a single file (`registry.rs`) for what is genuinely a cross-cutting change: the binder (`crates/ql-exec` or wherever it lives) needs to know to emit Reference args, the dispatcher needs new arms, the existing 193 functions need to be checked for whether any can opt into Reference inputs, etc. A fresh session pursuing this option without re-reading the W5-162.1 design doc context would underestimate the work.

**Why it matters for a fresh session:** A new session would dive into `registry.rs` thinking the change is local, hit the binder/dispatcher walls, and have to expand scope mid-flight. Better to pre-flag the breadth.

**Fix:** Expand Option A.1 with a bullet list: "Touches: `crates/ql-functions/src/registry.rs` (new variant + tier), `crates/ql-exec/<bind module>` (emit Reference args during binding — file path TBD; see W5-162.1 design doc), dispatcher for new arm, `docs/architecture/<date>-reference-tier-design.md` (design doc with Codex pre-review, matching the 4.10.AA pattern)." Also explicitly name the IronCalc port reference (likely `.references/ironcalc/base/src/functions/information.rs` for ISFORMULA, ISREF + `.references/ironcalc/base/src/functions/lookup_and_reference.rs` for ROW/COLUMN/ROWS/COLUMNS/FORMULATEXT — would be worth verifying which file).

---

### MEDIUM-6: Wave 3 forward map (Option A) bundles Codex+Opus mandate but doesn't give a sample prompt path

**Location:** Lines 358-359.

**Issue:** Says "Apply the parallel-Codex+Opus audit-discipline rule to every batch" but doesn't point at where the audit prompt skeleton lives. The skeleton is in the audit-discipline memory (lines 44-69) but a fresh session focused on Option A may not realize they need to open that memory before launching the first Wave 3 batch.

**Why it matters for a fresh session:** Without an explicit pointer, the audit prompt may be reinvented poorly. Reinventing slightly-different audit prompts loses the reconciliation-summary-doc pattern that has worked twice.

**Fix:** Add to line 358: "See `[[quantbook-engine-audit-discipline]]` § Sample audit prompt skeleton for the canonical audit prompt template. Reconciliation docs go in `docs/audits/<date>-<scope>-audit-summary.md`."

---

### LOW-1: Stale "next substantive work" note from prior handoff still present in MEMORY.md but pointing at old descriptor

**Location:** Not in the handoff itself, but the MEMORY.md entry on line 4 includes "Next substantive: distributions / percentile / reference-tier / Phase 4.11 XLSX I/O."

**Issue:** MEMORY.md doesn't explicitly say reference-tier is the HIGHEST priority among those candidates. The handoff doc says so on lines 350, 360, 530. Minor mismatch in priority signal between MEMORY.md and handoff.

**Why it matters for a fresh session:** A session that only skims MEMORY.md before opening the handoff might treat all four as peers. Minor.

**Fix:** Optional. Update MEMORY.md line 4 to lead with "reference-tier (highest priority per handoff)".

---

### LOW-2: Codex-output line count mismatch (130 vs 132 lines)

**Location:** Line 221 says Codex W5-180/W5-182 output is "130 lines". Audit summary file actually has 130 lines (`wc -l` confirms). Line 17 of audit summary says "130 lines" too. But line 221 of handoff says Codex W5-183 output is "132 lines" and `wc -l docs/audits/2026-05-17-w5183-vdb-codex.md` returns 132. All checked.

**Issue:** None — both are correct after verification.

**Fix:** None.

---

### LOW-3: "(50 total, all on `feat/quantbook-engine`)" + "(W5-138 → W5-183.1)" not visible in table headers

**Location:** Line 446 vs table on lines 449-464.

**Issue:** The "50 total" is in the section heading "## Commits this session arc (50 total, all on `feat/quantbook-engine`)" but a reader copying just the table block won't see the total label until they scroll to TOTAL row 463. Minor structural nit.

**Fix:** Optional — add a one-line caption above the code block.

---

### LOW-4: "W5-170 / Wave 2 closing self-audit" prose says "9 new e2e smoke tests" but doesn't appear in table

**Location:** Line 80 ("W5-170 self-audit closure — e2e dispatch gap for batches 4.10.E + 4.10.G ... closed with 9 new e2e smoke tests.")

**Issue:** The W5-170 commit's test contribution isn't broken out in the commit-segment table on line 451 ("Phase 4.10 Wave 2 (W5-162 → W5-172): 12 commits"). The 12-commit Wave 2 segment covers W5-162.1 → W5-172 inclusive and bundles all of W5-162 + W5-162.1 + 7 batch commits + W5-170 + W5-171 + W5-172 = 12. The +9 self-audit smoke tests would be folded into Wave 2's total. Minor — same drawback as the "+ε" issue (MEDIUM-2): Wave 2 has no test delta in the table.

**Fix:** Bundled into the MEDIUM-2 fix; adding explicit Wave 2 test count resolves both.

---

### LOW-5: "Pickup" closing line at bottom (530) duplicates lines 350-351 verbatim style

**Location:** Lines 350-351 vs 530.

**Issue:** Three near-identical "pick A/B/C, reference-tier is highest priority" statements (lines 350-351, line 478, line 530). Mild redundancy.

**Fix:** Optional. Keep one canonical, soften the others to back-references.

---

### LOW-6: Tone check — no "fresh session" anxiety language found

**Location:** Scanned entire doc for "fresh session strongly recommended", "cycle budget", "session is long", etc.

**Issue:** None — the handoff is neutral and actionable per the user's rule 1 from the audit-discipline memory. The only mentions of "fresh session" are factual ("a fresh session reading this doc", "a fresh session would underestimate", etc.). Compliance ✓.

**Fix:** None.

---

## Summary

The handoff is **fit for cold-start pickup**. Ground-truth claims (HEAD, branch, test count, fn count, file paths, audit closures, deferred LOWs ledger, audit-discipline rule pointer) are all verified accurate. The forward map is concrete and Options A/B/C have enough scope for a fresh session to choose among them.

The HIGH findings (2 inaccuracies in convergence framing + commit count) are factual cleanups, not blockers — a fresh session would not be actively misled into doing the wrong work. The MEDIUM findings are discoverability and arithmetic-transparency improvements that would tighten the doc's reliability budget. The LOWs are polish.

**Recommended priority for fixes (if applied):**
1. HIGH-1 (convergence framing) and HIGH-2 (commit count) — both are 5-minute edits.
2. MEDIUM-3 (wikilink) — discoverability of the audit-discipline rule is critical.
3. MEDIUM-5 (reference-tier scope) — helps the next session not under-budget.
4. Everything else is optional polish.

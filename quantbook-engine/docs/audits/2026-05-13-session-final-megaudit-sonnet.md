# Sonnet mega-audit — W5-49 through W5-59

**Auditor:** Claude Sonnet 4.6 (adversarial, read-only pass)  
**Date:** 2026-05-13  
**Scope:** 11 commits `183aad96337..51fedf11c68`; full code read of W5-53..W5-58 surface (range_fns.rs, range_aware_fns.rs, registry.rs, scalar_fns.rs lines 700-1620, scalar.rs, plan.rs, env.rs)  
**Protocol:** audit brief at `docs/audits/2026-05-13-session-final-megaudit-prompt.md`

---

## Verdict (one paragraph)

The W5-49..W5-59 arc shipped substantial, real capability with genuine correctness discipline. The W5-52 parallel-auditor pattern caught a real HIGH bug; every commit ran 7 gates. However, the session ran past the CLAUDE.md cycle limit under user direction, and the throughput push created three problems I'm filing as new findings: (1) **MROUND(non-zero, 0)** returns `0` where Excel returns `#NUM!`, and it is tracked in `excel-matrix.md` as `✅` (wrong status); (2) the handoff's registry alias-count arithmetic is internally inconsistent in two places — the W5-58 commit message and the handoff table both state numbers that don't add up; (3) the `is_aggregate_function` naming and its CHOOSE inclusion create a correctness gotcha that's partially documented but undersells the actual risk. The W5-53..W5-58 function implementations are mostly correct against Excel canon; the critical issues are a documented-but-mislabeled divergence, counting errors in documentation, and structural protocol gaps.

---

## NEW HIGH (correctness bugs or false-confidence ships)

### H1 — MROUND(non-zero, 0) returns 0; marked ✅ in excel-matrix.md

**File:** `crates/ql-functions/src/scalar_fns.rs:925-926`  
**Code:** `if multiple == 0.0 { return Value::Number(0.0); }`  
**Problem:** In Excel, `MROUND(1, 0)` returns `#NUM!` for any non-zero number. The code returns `0` for every number. The test at `scalar_fns.rs:2986` explicitly asserts `mround(&[n(7.0), n(0.0)]) = n(0.0)`, which validates the wrong behavior.  
**Aggravator:** `docs/compat/excel-matrix.md:115` marks MROUND as `✅` with the note `multiple=0 returns 0` — but this is a divergence that should be `⚠️ partial` or moved to the "known divergences" list in the handoff.  
**Contrast:** FLOOR(n, 0) correctly returns `#DIV/0!` for non-zero n (as documented in the handoff's divergence #8). MROUND(n, 0) → `#NUM!` in Excel is the direct analog. The asymmetric treatment is undocumented.  
**Action needed:** Either fix the implementation to return `#NUM!` for non-zero number with zero multiple, OR downgrade the excel-matrix.md status from `✅` to `⚠️` and add to the handoff's known-divergences list.

---

## NEW MEDIUM (overstatement, scope gap, missing test)

### M1 — Registry alias count arithmetic is wrong in two places

**File 1:** `docs/audits/2026-05-13-engine-session-final-handoff.md` (session ledger table, W5-58 row)  
The row says: `+5 → 78 unique + 2 aliases = 102 registry entries`. **78 + 2 = 80, not 102.** The "2 aliases" number appears to refer only to RANK.EQ and MODE.SNGL, but the registry has 5 aliases total (AVG=AVERAGE, VAR=VAR.S, STDEV=STDEV.S, RANK.EQ=RANK, MODE.SNGL=MODE). The correct summary is **97 unique implementations + 5 aliases = 102 total entries**.

**File 2:** W5-58 commit message: `"95 unique + 7 aliases counting RANK.EQ / MODE.SNGL / AVG / VAR.S / VAR.P / STDEV.S / STDEV.P"`. VAR.S, VAR.P, STDEV.S, STDEV.P are NOT aliases — they are distinct registered implementations with distinct function pointers. Only VAR (→ VAR.S), STDEV (→ STDEV.S) are aliases. The commit message mislabels 4 independent implementations as aliases.

**File 3:** The handoff's prose says `"Function library grew +48 (30 → 78 unique fns; 102 registry entries with aliases)"`. My count: 97 unique implementations (not 78).

Actual count from code:
- Scalar table: 83 entries (confirmed by test `assert_eq!(r.len(), 102)` + separate count)
- Range-aware table: 19 entries  
- True aliases (same fn pointer): AVG, VAR, STDEV, RANK.EQ, MODE.SNGL = 5
- Unique implementations: 102 - 5 = 97

**Impact:** Misleads the next window on the true function coverage number. Not a correctness bug in the code, but a documentation bug that affects planning (FN4-01 acceptance is legitimate; only the alias count is off).

### M2 — CHOOSE as range-aware is an underdocumented user footgun

**File:** `crates/ql-functions/src/range_fns.rs:677-701`; `crates/ql-functions/src/registry.rs:270`  
**Problem:** CHOOSE is registered as `range_aware` and listed in `is_aggregate_function`. This means `=CHOOSE(1, Sales, Costs)` where Sales/Costs are named ranges will pass the binder, the dispatcher will build `FnArg::Range` for args[1] and args[2], and CHOOSE will return `#VALUE!` at runtime (line 699: `FnArg::Range { .. } => Value::Error(ErrorValue::Value)`).  

This fails silently with `#VALUE!` instead of a clear "CHOOSE does not support range args." The gotchas list in `audit-protocol.md` mentions this briefly under gotcha #6 but doesn't name CHOOSE explicitly. A user writing `=CHOOSE(1, TableA, TableB)` (a common Excel pattern) gets a cryptic `#VALUE!` with no diagnostic.

**Not a correctness regression** — the current V1 behavior is intentional — but the audit protocol gotchas should explicitly name CHOOSE as a function that's in `is_aggregate_function` for binder-compat reasons yet silently rejects Range args at eval time.

### M3 — VEQ + supplemental edges: still untested, and now more surface to worry about

**Context:** Codex's W5-49 watch list flagged "VEQ behavior for range-dep formulas (Phase 3.8 short-circuit + supplemental edges must compose)." This is still UNTESTED through all 11 commits.

**New exposure:** W5-53..W5-58 added 19 range-aware functions, all of which create entries in the aggregate cache (`InMemAggregateCache`) AND in `build_range_supplemental`. The VEQ path (`recompute_dirty` value-equality short-circuit) may skip re-evaluating a formula whose supplemental-edge dependencies changed inside a range without the formula's own cell deps changing.

**Concrete risk scenario:** A SUMIF formula is not in the dirty set because none of its named cell dependencies changed. But a cell inside its criteria range was updated. The supplemental edge should force re-evaluation. If VEQ short-circuits before the supplemental edges are checked, the SUMIF result is stale. No test covers this scenario.

**Filed as MEDIUM** (not HIGH) because the CLAUDE.md rule is explicit: `supplemental` edges are designed to handle dirty formula pairs, and the GAP-R-08 note covers the related volatile+VEQ interaction. But 19 new range-aware functions significantly increase the probability of hitting this in production. The open-items section of the handoff does list this, but the handoff underemphasizes the severity now that the range-aware function surface has expanded 19×.

### M4 — W5-51 commit message claims "Function library: 52 → 59 entries"

**File:** W5-51 commit message  
At the time of W5-51, the registry had 59 scalar entries. The message is accurate for the raw scalar table. However, the W5-53 commit (2 commits later) says "+2 → 39 (61 entries with aliases)." The 39 and 61 figures are using a different counting scheme (unique functions vs entries-with-aliases) from the "52 → 59" in W5-51. This is not a correctness bug but reflects a counting-convention inconsistency across commit messages that obscures progress tracking.

### M5 — `formula_to_stripe_keys` reverse-index memory is still unbenchmarked

**Prior finding:** W5-52 audit (Codex) flagged `formula_to_stripe_keys` as an unbounded growth concern at scale.  
**Status through W5-59:** Still unaddressed, still untracked in `known-gaps.md`.  
**New exposure:** W5-53..W5-58 added 19 range-aware functions. Any formula using these functions creates stripe registrations via `register_range_dependency`. The reverse-index grows with each unique (formula_node, stripe_key) pair. For workbooks with many SUMIF/VLOOKUP formulas over large named ranges, this could be significant.  
**Action:** Add a `GAP-G-04` entry in `known-gaps.md` covering `formula_to_stripe_keys` memory at scale, with a target phase (4.7 or later).

---

## NEW LOW (doc nits, naming, stale text)

### L1 — Handoff doc claims W5-53 starts at "39 (61 entries with aliases)" but prior count was 59

The W5-51 test asserted 59 entries (scalar only). W5-53 says "+2 → 39 (61 entries with aliases)". The "39" is a new counting unit (unique non-alias functions in the scalar table only?) that's never defined. The ledger table uses inconsistent counting units across rows, making it impossible to reconstruct the history from the table alone.

### L2 — excel-matrix.md MROUND row should be ⚠️, not ✅

As noted in H1: `docs/compat/excel-matrix.md:115` marks MROUND `✅` with the note `multiple=0 returns 0`. This should be `⚠️ partial` noting the Excel divergence for non-zero numbers with zero multiple.

### L3 — audit-protocol.md § Sonnet agent dispatch uses undocumented tool name

**File:** `docs/process/audit-protocol.md:105`  
`"Use the Agent tool with subagent_type: 'general-purpose' and model: 'sonnet'."` This refers to an internal tool API that may not be stable across Claude Code versions. The reference is a gotcha for future sessions if the tool API changes. Suggest augmenting to say "or equivalent Sonnet-dispatch mechanism per current Claude Code docs."

### L4 — Handoff pointer #10 references an audit file that doesn't exist yet

**File:** `docs/audits/2026-05-13-engine-session-final-handoff.md:258`  
`"docs/audits/2026-05-13-phase-4.3-v2-session-audit-*.{md,txt}"` — these files are listed as expected to exist but are the outputs of THIS audit (the one dispatched post-W5-59). The handoff correctly explains they may not be there, but the pre-flight checklist at line 273 says "if not, that's the FIRST work item" — which is accurate and correctly guards against false assumptions.

### L5 — `lookup_search` in range_fns.rs: MATCH type=1 break-on-Greater is linear, not binary

**File:** `crates/ql-functions/src/range_fns.rs:548-556`  
The MATCH type=1 approximate algorithm uses `break` on the first `Greater` comparison. This is documented as "assumes ascending sort; linear for now." The break is only valid for sorted data — on unsorted data it gives wrong answers silently. The doc comment says "un-sorted input yields undefined results per Excel canon," which is correct. But there's no test asserting that unsorted input gives either `#N/A` or a documented wrong answer. Low risk since Excel itself gives undefined results on unsorted MATCH.

---

## Per-commit assessment

**W5-49 (`183aad96337`)** — HONEST. Doc-only. Decision was Codex-reviewed before implementation. The commit message is accurate.

**W5-50 (`bddd209f9ae`)** — SHIPPED WITH A LATENT BUG (the `on_clear_formula` omission caught by W5-52). The commit message claimed GAP-G-01 "closed" when the clear path was missing. The W5-52 parallel audit caught it. The process worked as intended — this is the exact case study the audit-protocol uses. No remaining hidden issues found in the W5-50 diff.

**W5-51 (`9cb63c86cc5`)** — CORRECT. Seven trig functions. Edge cases (TAN at π/2, ASIN/ACOS domain, ATAN2(0,0)) all handled correctly. The ATAN2 arg order (x,y) is correct; the docstring fix landed in W5-52. Minor: commit message uses raw entry count "52 → 59" without the alias-accounting used in later commits.

**W5-52 (`26e98d6b467`)** — CORRECT closure. The HIGH fix (clear-path missing) is real and correctly applied. LOW fixes are accurate. The ATAN2 docstring was the most subtle — the body was correct but the title said `(y,x)`. Fixed correctly.

**W5-53 (`b836236302f`)** — CORRECT architecture. The `FnArg::Range` flat-to-struct evolution was handled cleanly. SUMIF semantics (errors propagate in sum_range; blank skipped) match Excel canon. COUNTIF semantics (errors not propagated, blank counted via predicate) also match. Cross-table collision panic at registration is a good guard.

**W5-54 (`127e42432f6`)** — MOSTLY CORRECT. The 2D shape refactor is correct. VLOOKUP/HLOOKUP/MATCH/INDEX implementations handle the critical edge cases. One note: CHOOSE is registered as range_aware even though all its value-args must be Scalar. This is intentional (see M2) but undersupported in the protocol docs.

**W5-55 (`234d8db429c`)** — CORRECT. SUMIFS arg order (sum_range first, unlike SUMIF which has it last) is correctly documented and implemented. The `parse_ifs_pairs` shape check (flat-length match) is appropriate. SUMPRODUCT lenient coercion (Text→0) matches Excel canon and is correctly divergent from SUMIF/SUM behavior.

**W5-56 (`6c65fea5037`)** — CORRECT. Text functions use UTF-8 char-count semantics (documented divergence). FIND empty-needle returns start_num (Excel canon). SEARCH case-insensitive via `.to_uppercase()` char conversion is correct for ASCII/BMP but documented as deferred for locale-sensitive cases. REPT 32,767-char cap enforced. SUBSTITUTE empty old_text no-op is Excel canon.

**W5-57 (`7a80eaf4412`)** — MOSTLY CORRECT. CEILING/FLOOR sign rules are correct. MROUND sign-mismatch caught correctly. However, MROUND(non-zero, 0) returns 0 instead of #NUM! (H1 above). ACOSH domain check `n < 1.0` is correct (ACOSH(1) = 0, valid). ATANH domain is `|n| < 1` with `±1` → `#NUM!` which matches Excel. LCM using u128 to defer overflow is sound. GCD with gcd(0,0) = 0 is correct.

**W5-58 (`d6a6bcdcfc5`)** — CORRECT implementations, wrong alias count in commit message. LARGE/SMALL: k boundary `k < 1 || k > count` correct. RANK: `arr.contains(&target)` using f64 PartialEq is fine since NaN/Inf are rejected upstream by `collect_numbers_strict`. MEDIAN even-count average is correct. MODE bit-pattern equality via `u64::to_bits()` is safe since NaN/Inf are filtered upstream. First-appearance tie-break via `first_idx` in HashMap is correct. The "95 unique + 7 aliases" in the commit message overcounts aliases (see M1).

**W5-59 (`51fedf11c68`)** — DOC COMMIT WITH TWO INHERITED ERRORS. The doc-drift fixes Codex caught (MASTER-PLAN date/HEAD, known-gaps GAP-F-01, graph-decision-doc status, 3 source comments) are all applied correctly. The handoff doc itself is well-structured and accurate on substance. However it inherits the alias-count arithmetic errors from W5-58 (see M1), and the excel-matrix.md MROUND status is not updated to ⚠️ (see H1). The audit-protocol is sound and well-formatted.

---

## W5-59 finalization verdict

### Handoff accuracy

The handoff is accurate on the substance that matters: what phases shipped, which gaps are open, the architectural decisions, and the gotchas list. The 13 critical gotchas are real and important. The phase status table is correct. The "verify before acting" commands are correct.

The two inaccuracies are numerical: (a) "78 unique fns" should be ~97 unique; (b) "78 + 2 aliases = 102" doesn't add up. These don't affect the next window's ability to do correct work, but they'd cause confusion if someone tried to reconcile them.

### Protocol enforceability

The protocol is well-structured with MANDATORY/RECOMMENDED/FORBIDDEN labels. The cycle-discipline rule is realistic. The mega-audit template is specific.

However, CONCERN-E is valid: the protocol has no enforcement mechanism. Three structural gaps:

1. **No self-check command.** The protocol should include a script the window can run at session-end to verify it followed the protocol: "was a mega-audit dispatched for this phase? Did I commit without running gates?" A one-line `git log --format="%s" -5 | grep -c "mega-audit\|gates green"` style check would catch drift.

2. **No recovery section.** The protocol says what to do if cycle 3 hits, but doesn't say what to do if you discover mid-session that the prior window skipped a gate or lied in a commit message. Adding "if you discover a gate was skipped, run it now and commit a correction" would close this.

3. **Cycle-3 enforcement.** "If cycle 3 → STOP" is self-enforced by the agent. The next window can simply continue. The only real enforcement is the CLAUDE.md instruction and user oversight. The protocol should note this explicitly: "enforcement is via CLAUDE.md + user oversight, not a technical constraint."

### Doc-drift fixes accuracy

All six doc-drift fixes that Codex flagged and the session applied are correct:
- MASTER-PLAN date/HEAD: confirmed updated to 2026-05-13 / d6a6bcdcfc5 ✓
- known-gaps.md GAP-F-01: correctly marked ✅ CLOSED W5-58 ✓
- graph-storage-decision.md "NOT shipped" → status timeline: correct ✓
- calcgraph_session.rs:487-498 append-only comment: updated to revocation contract ✓
- scalar.rs:71-82 legacy #CALC! comment: correctly annotated as "legacy no-registry path only" ✓
- plan.rs:159-185 "replaced in Phase 4.3" comment: retargeted to Phase 4.7/4.10 ✓

The one missed doc-drift: **excel-matrix.md MROUND row is ✅ but should be ⚠️** (see H1). Codex's planning pass did not catch this; neither did Claude.

---

## What's needed for W5-60 closure (HIGH issues that MUST be fixed)

The following must be done before starting new Phase 4.4 implementation:

- [ ] **H1 — Fix MROUND(non-zero, 0):** Either change the implementation to return `#NUM!` for non-zero number with zero multiple (correct Excel behavior), OR explicitly mark it as a documented divergence by: (a) moving the `multiple=0 → 0` behavior note to the handoff's "Known divergences" list, AND (b) changing `excel-matrix.md` MROUND status from `✅` to `⚠️ partial`. The test at `scalar_fns.rs:2986` must be updated to reflect whichever choice is made.

- [ ] **M1 — Fix alias count in documentation:** Update the W5-58 row in the session ledger to say "97 unique implementations + 5 aliases = 102 registry entries." Update the handoff prose: "Function library grew +48 (30 → 97 unique fn implementations; 102 registry entries with 5 aliases)." (The code is correct; only the documentation numbers are wrong.)

The following are deferred but should be filed before W5-60 starts:

- [ ] **M3 — VEQ + supplemental edges:** Add a `GAP-G-04` entry in `known-gaps.md` explicitly covering the VEQ+supplemental interaction now that 19 range-aware functions exist. Target phase: 4.7 (array formulas, which will exercise this path heavily).

- [ ] **M5 — `formula_to_stripe_keys` memory:** Add `GAP-G-05` in `known-gaps.md` for the reverse-index memory growth concern. Target phase: 4.7 or benchmarking micro-batch.

- [ ] **Protocol enhancement:** Add a "self-check" section to `audit-protocol.md` with a command the next window can run to verify gates were run, and a "recovery" section for when a prior gate or audit is discovered missing.

---

## CONCERN-F assessment — W5-52 open items

**VEQ + supplemental:** Still open, now more critical (see M3). Correctly deferred but underweighted.

**`formula_to_stripe_keys` memory:** Still untracked in `known-gaps.md`. Should be filed (see M5).

**W5-50 commit per-file test counts off by ±1:** Acknowledged in W5-52 commit message. This is a documentation nit; the code is correct. The ±1 discrepancy in per-file counts vs total count is expected when a single test function tests multiple behaviors — no action needed beyond noting it remains unresolved.

None of these constitute a correctness regression that blocks Phase 4.4. They do represent unbounded liability if Phase 4.7 (array formulas) ships without pinning the VEQ+supplemental interaction.

---

## CONCERN-G — What's missing from the audit protocol

1. **No "self-check at session end"** command. As noted above.

2. **No gate for "excel-matrix.md status accuracy."** The protocol says "After `excel-matrix.md` edits, run `scripts/report-compat-coverage.sh`" but doesn't say "verify all ✅ statuses actually match implementation." MROUND would have been caught by such a rule.

3. **No rule about alias counting.** The protocol doesn't define what "unique function" means vs "alias." A convention should be pinned: "an alias is a name that maps to the same `fn` pointer; count it separately from unique implementations."

4. **The CHOOSE footgun pattern** (registered range-aware, silently rejects Range at eval) is not in the gotchas list explicitly. Should add: "CHOOSE is range-aware for binder-compat but returns `#VALUE!` for Range args — common user pattern `=CHOOSE(1, NamedRange1, NamedRange2)` silently fails."

5. **No "what to do when both auditors disagree" section.** The protocol says "HIGH found by ONE = investigate carefully." But it doesn't give a decision tree for when Codex says HIGH and Sonnet says MEDIUM (or vice versa). Add: "Disagreement between auditors: read both code paths; the one with the more concrete reproduction wins."

---

*End of audit. Report saved to `docs/audits/2026-05-13-session-final-megaudit-sonnet.md`.*

# Lane S3 — Decision-Lock Code Citation Audit

**Date:** 2026-05-26  
**Lane:** S3 (Sonnet audit — code-citation verification only)  
**Scope:** Verify every load-bearing code citation in `docs/phase6/decision-lock.md` and `docs/phase6/codex-decision-lock-review.md` against actual source at HEAD `302c7243ddc`.  
**Audit-only:** no code changes.

---

## Citation Accuracy Table

| # | Citation | Document | Claimed Content | Verdict | Notes |
|---|----------|----------|-----------------|---------|-------|
| C1 | `calcgraph_session.rs:69-71` | both | Phase 6.1 WorkbookSession will absorb Workbook+OpLog+CalcgraphSession+PlanCache+FunctionRegistry | ACCURATE | Lines 69-71 are exactly the doc comment stating this. |
| C2 | `calcgraph_session.rs:139-145` | both | Volatility is a hardcoded whitelist; Phase 4.3 replaces with per-function metadata | ACCURATE (minor) | Lines 139-145 are the doc comment for `is_volatile_function`. The function body begins at 149. The claimed "hardcoded whitelist" and Phase 4.3 note both appear verbatim in the cited range. |
| C3 | `registry.rs:119-167` (lock) / `119-149, 151-167` (review) | both | FunctionRegistry stores dispatch variants, not a first-class metadata record | ACCURATE | Lines 119-149: `RegisteredFn` enum with 5 dispatch tiers. Lines 151-167 (164-167 specifically): `FunctionRegistry` struct holding `HashMap<&'static str, RegisteredFn>`. No metadata fields. |
| C4 | `workbook_runtime/mod.rs:145-151` | both | WorkbookRuntime owns optional graph hooks; calls them after successful mutation | PARTIALLY INACCURATE | The field at 145-151 is `graph: Option<&'a mut crate::CalcgraphSession>` — a borrowed mutable reference, NOT an owned value. The word "owns" in the claim is wrong. "Calls them after successful mutation" is accurate per the doc comment at 146-147. |
| C5 | `calcgraph_session.rs:453-498` | codex review | CalcgraphSession stores per-formula dependency state and dirty sets | ACCURATE | Line 453: `formula_deps` field comment. Line 498: `dirty: HashSet<NodeId>`. The range accurately covers all dep-state + dirty fields. |
| C6 | `calcgraph_session.rs:980-1025` | both | on_set_formula registers deps + dirties downstream | ACCURATE | Function doc starts at 980, closes exactly at 1025. Content confirmed: dep registration + `mark_dirty_from_cell_write` call. |
| C7 | `calcgraph_session.rs:1370-1395` | both | mark_dirty_from_cell_write fans out direct/range dependencies and invalidates aggregate caches | INACCURATE (range) | The function signature is at line 1384 (not 1370). Lines 1370-1383 are the doc comment. The function runs to line 1432, well past 1395. The cited range covers only the doc comment + opening + aggregate cache invalidation. The BFS fanout (the main body of the claim) runs from 1396 to 1432. The claim is substantively correct but the line range is materially wrong: 1384-1432, not 1370-1395. |
| C8 | `calcgraph_session.rs:1470-1493` | both | volatile dirtying entry point | ACCURATE (minor off-by-one) | Doc comment at 1470, function `mark_volatile_dirty` signature at 1480, closing brace at 1494. The cited range 1470-1493 is off by one on the closing brace (1494 not cited) but covers the full semantic content of the function. |
| C9 | `ql-udf/src/lib.rs:1-10` | codex review | Empty Phase 6.4 placeholder | ACCURATE (truncated) | File has 20 lines. Lines 1-10 cover the module doc comment + `#![allow(dead_code)]`. Lines 13-20 are a `#[cfg(test)]` stub. The "empty placeholder" claim is substantively accurate; the range is truncated but does not misrepresent content. |
| C10 | `quantbook-py/src/lib.rs:1-10` | codex review | Empty Phase 6.3 placeholder; pyproject.toml reserves maturin/PyO3 | ACCURATE (truncated) | File has 20 lines; 1-10 is half. Same structure as ql-udf. pyproject.toml claim is accurate (file confirmed: maturin>=1.7 + pyo3 features). |
| C11 | `quantbook-py/pyproject.toml:1-24` | codex review | Reserves maturin/PyO3 packaging | ACCURATE | File is exactly 24 lines. Maturin build-backend + PyO3 extension-module features confirmed. |
| C12 | `ql-ai/src/lib.rs:1-12` | codex review | Reserved empty implementation crate | ACCURATE (truncated) | File has 23 lines. Lines 1-12 cover module doc comment + `#![allow(dead_code)]`. Remaining lines are `#[cfg(test)]` stub. Claim stands. |
| C13 | `scalar_fns.rs:703-715` | both | AI is a sentinel returning AINotAvailable | ACCURATE (off-by-one) | The section comment is at 703, fn `ai` signature at 714, `Value::Error(ErrorValue::AINotAvailable)` at 715. Closing brace is at 716 (not cited). Semantic claim is fully supported by the cited range. |
| C14 | `ql-bindings-node/src/lib.rs:311-340` | both | "prefix-message-with-code" error-code workaround | ACCURATE | Lines 311-340 are the block comment explaining the V2.7 error-code prefix design, including the napi-rs limitation rationale. |
| C15 | `ql-bindings-node/src/lib.rs:1113-1137` | codex review | CollabSession wraps ql_collab::CollabSession | ACCURATE | Lines 1113-1137: doc comment (1113 says "JS-facing wrapper for `ql_collab::CollabSession`") + `#[napi]` attr + struct definition holding `Arc<Mutex<CoreCollabSession>>`. `CoreCollabSession` is confirmed as `use ql_collab::CollabSession as CoreCollabSession` at line 130. |
| C16 | `ql-bindings-node/src/lib.rs:3418-3435` | both | flushPendingToTransport detach-then-spawn_blocking pattern | ACCURATE (off-by-one) | Line 3418: `let handle_opt = { let inner = ...`. Line 3435: `.map_err(transport_error_to_napi)`. Line 3436: closing `}`. The closing brace is not cited, but the full pattern (extract handle under lock, release lock, `spawn_blocking`) is fully captured in the cited range. |
| C17 | `ql-bindings-node/src/lib.rs:1650-1673` | codex review | appendPutFormula | ACCURATE (off-by-one) | Line 1650: `#[napi(js_name = "appendPutFormula")]`. Line 1673: `Ok(())`. Line 1674: closing `}`. The closing brace is missed by one line. The claim ("collab Op::PutFormula append path, not the final stable WorkbookSession evaluation API") is accurate. |
| C18 | `ql-bindings-node/src/lib.rs:2497-2560` | codex review | workbookSnapshotDelta — evidence that version tokens and full-rebuild fallbacks are already needed | ACCURATE (truncated) | Function starts at 2497, ends at 2821. The cited range 2497-2560 covers version decoding + full-rebuild return paths. The truncation is appropriate for the specific claim being made (version tokens + fallbacks), which IS shown in lines 2497-2560. |
| C19 | `ql-oplog/src/replay.rs:14-17` | codex review | Replay writes formula text and does NOT evaluate | ACCURATE | Lines 14-17: "PutFormula → Workbook::put_formula (text only; replay does NOT re-evaluate — that's a separate step the caller drives via WorkbookRuntime::recompute_all)". Verbatim match. |
| C20 | `Cargo.toml:97-99` | codex review | PyO3 pin | ACCURATE | Lines 97-99: comment "Python interop (Phase 5; reserved…)" + `pyo3 = { version = "=0.28.3", ... }`. Note: the comment says "Phase 5" (historical label) not "Phase 6.3/6.4" — this is a comment in the code itself, not a citation error in the documents. |

---

## Findings

### F-1 — "WorkbookRuntime owns optional graph hooks" is semantically wrong

**Severity:** LOW (wording error, not architectural error)  
**Files:** `crates/ql-exec/src/workbook_runtime/mod.rs:145-151`  
**Evidence:** The actual field declaration at line 151 is:
```rust
graph: Option<&'a mut crate::CalcgraphSession>,
```
`WorkbookRuntime` holds a **borrowed mutable reference** to a `CalcgraphSession` that is externally owned (caller allocates the session, passes `&mut` to `with_graph()`). The term "owns" is incorrect. The caller owns the `CalcgraphSession`; `WorkbookRuntime` borrows it for the lifetime `'a` of the runtime.

**Impact on decisions:** The actual pattern (borrow for a short edit window) is architecturally sound and is exactly the ownership model described in the module-level doc comments of `calcgraph_session.rs`. The imprecision does not affect any Phase 6 decision. The decision-lock's call for `WorkbookSession` to truly OWN these components (§2, step 3) is correct and is actually a step up from the current borrow pattern.

**Recommendation:** In `session-api.md` and implementation docs for 6.1B, use precise language: "WorkbookRuntime borrows a CalcgraphSession per edit window; WorkbookSession will own it outright."

---

### F-2 — `mark_dirty_from_cell_write` citation range is materially misaligned

**Severity:** LOW-MEDIUM (incorrect line numbers; misleads any implementer navigating to the citation)  
**Files:** `crates/ql-exec/src/calcgraph_session.rs:1370-1395` (cited) vs `1384-1432` (actual)  
**Evidence:**
- Line 1368: doc comment begins ("Phase 3.3 (single-hop)…")
- Line 1384: `fn mark_dirty_from_cell_write(…) {` — actual function signature
- Line 1395: `self.aggregate_cache.invalidate_at(sheet, row, col);` — first statement in body
- Line 1432: closing `}` of the function

The cited range 1370-1395 starts 14 lines into the doc comment (not at the doc-comment start, and not at the function sig) and ends at the first statement. The BFS fanout that implements "fans out direct/range dependencies" runs from line 1396 to 1431. A developer following this citation to study the fanout algorithm would land in the wrong place.

**Impact on decisions:** The claim itself ("fans out direct/range dependencies and invalidates aggregate caches") is correct; only the range is wrong. No decision is invalidated.

**Recommendation:** Correct to `calcgraph_session.rs:1368-1432` (or `1384-1432` for function-only). Update the citation in both `decision-lock.md §4` and `codex-decision-lock-review.md §C`.

---

### F-3 — Placeholder crate citation ranges are consistently truncated

**Severity:** LOW (cosmetic)  
**Files:**
- `crates/ql-udf/src/lib.rs` cited as `:1-10`, actual file is 20 lines
- `crates/quantbook-py/src/lib.rs` cited as `:1-10`, actual file is 20 lines  
- `crates/ql-ai/src/lib.rs` cited as `:1-12`, actual file is 23 lines

**Evidence:** All three files follow the same 20-23 line structure: module doc comment (lines 1-10/12) + `#![allow(dead_code)]` + blank + `#[cfg(test)]` stub. The unread portion in each case is just the test stub (`#[cfg(test)] mod tests { #[test] fn smoke() { // Phase X.Y work lands here. } }`).

**Impact:** The "empty placeholder" claim is substantively accurate — no public surface in any of these crates. The truncated ranges do not misrepresent the crates.

**Recommendation:** Update to `:1-20` / `:1-23` for completeness, or note "first N lines of N-line file" explicitly. Not a blocker.

---

### F-4 — `workbookSnapshotDelta` range is heavily truncated (2497-2560 vs actual 2497-2821)

**Severity:** LOW (acceptable truncation given the specific claim)  
**Files:** `crates/ql-bindings-node/src/lib.rs:2497-2560` (cited) vs `:2497-2821` (actual function end)  
**Evidence:** The function is 324 lines long. The cited 64-line range covers only the version token decoding and the full-rebuild-fallback guard paths. The BFS delta walk, workbook cloning, cell rendering, format collection, and delta JSON construction all appear after line 2560.

**Impact:** The codex review cites this as "evidence that version tokens and full-rebuild fallbacks are already needed" — a claim that IS accurately supported by lines 2497-2560 alone. The truncation is fit-for-purpose for that specific claim. However, anyone who follows the citation expecting to find the full delta algorithm will miss ~260 lines of it.

**Recommendation:** Expand to `:2497-2821` in any doc that intends to reference the full function, or annotate the partial citation as "entry + fallback paths only."

---

### F-5 — `scalar_fns.rs:703-715` off-by-one on AI sentinel function closing brace

**Severity:** LOW (cosmetic, closing brace is at 716)  
**Files:** `crates/ql-functions/src/scalar_fns.rs:703-716` is the full range; `:703-715` is cited  
**Evidence:** Line 715: `Value::Error(ErrorValue::AINotAvailable)`. Line 716: `}`. The missing closing brace does not affect the claim ("AI is a sentinel returning AINotAvailable").  
**Recommendation:** Trivial fix to `:703-716`. No decision impact.

---

### F-6 — `appendPutFormula` and `flushPendingToTransport` off-by-one on closing braces

**Severity:** LOW (cosmetic)  
**Files:**
- `lib.rs:1650-1673`: closing `}` is at 1674
- `lib.rs:3418-3435`: closing `}` is at 3436

Both are single-line off-by-one errors on the function closing brace. Semantic content of both citations is fully accurate.  
**Recommendation:** Trivial fixes; no decision impact.

---

## Internal Consistency Check: Decision-Lock §2 vs §1 vs MASTER-PLAN

**§1 decisions vs §2 sequence:** CONSISTENT.  
- D1 (wedge-first, 6.4 immediately after 6.1, 6.4A pulls minimal Python slice): §2 steps 1-7 implement this precisely — decision-lock → 6.1A → 6.1B → 6.1C → 6.4-0 → 6.4A → 6.4B.  
- D2 (defer transport until 6.2): §2 step 9 schedules 6.2 after 6.3, with explicit HTTP+SSE default lean. Internally consistent.  
- D3 (defer AI, cell function v2): §2 step 11 ("6.6 AI boundary or explicit deferral; =AI() cell function v2-aligned"). Consistent.

**§2 vs MASTER-PLAN Phase 6 sub-items:** CONSISTENT with minor labeling. MASTER-PLAN §725-728 defines 6.1 acceptance as API6-01/02/03 (one trait, cancellation, structured errors). Decision-lock §3 maps to those exactly. The decision-lock inserts a `6.4-0` (function-metadata substrate) step that is not a separate numbered sub-item in MASTER-PLAN but is noted in MASTER-PLAN §721 ("Python UDFs depend on function metadata"). The insertion is architecturally grounded.

**`entry-plan.md` vs `decision-lock.md`:** The entry-plan §5 sequencing is explicitly superseded (confirmed: entry-plan §5 header says "SUPERSEDED by `docs/phase6/decision-lock.md` §2"). No contradiction — the lock is the later, authoritative document.

**Codex review vs decision-lock:** The codex review is the input that sharpened three decisions (6.4/6.3 split, GIL hard-cancel, 6.4-0 metadata prerequisite). All three sharpenings appear verbatim in `decision-lock.md §1` with "Correction (Codex, validated)" or "Refinement (Codex, validated)" labels. No contradiction or omission.

**No self-contradictions found** in the decision-lock's internal structure.

---

## Summary Table

| Citation | Verdict | Severity |
|----------|---------|----------|
| `calcgraph_session.rs:69-71` | ACCURATE | — |
| `calcgraph_session.rs:139-145` | ACCURATE | — |
| `registry.rs:119-167` | ACCURATE | — |
| `workbook_runtime/mod.rs:145-151` — "owns" | INACCURATE (wording) | LOW |
| `calcgraph_session.rs:453-498` | ACCURATE | — |
| `calcgraph_session.rs:980-1025` | ACCURATE | — |
| `calcgraph_session.rs:1370-1395` | INACCURATE (line range) | LOW-MEDIUM |
| `calcgraph_session.rs:1470-1493` | ACCURATE (off-by-one) | LOW |
| `ql-udf/src/lib.rs:1-10` | ACCURATE (truncated) | LOW |
| `quantbook-py/src/lib.rs:1-10` | ACCURATE (truncated) | LOW |
| `quantbook-py/pyproject.toml:1-24` | ACCURATE | — |
| `ql-ai/src/lib.rs:1-12` | ACCURATE (truncated) | LOW |
| `scalar_fns.rs:703-715` | ACCURATE (off-by-one) | LOW |
| `lib.rs:311-340` | ACCURATE | — |
| `lib.rs:1113-1137` | ACCURATE | — |
| `lib.rs:3418-3435` | ACCURATE (off-by-one) | LOW |
| `lib.rs:1650-1673` | ACCURATE (off-by-one) | LOW |
| `lib.rs:2497-2560` | ACCURATE (truncated) | LOW |
| `replay.rs:14-17` | ACCURATE | — |
| `Cargo.toml:97-99` | ACCURATE | — |

**Findings count:** 6 total — 0 HIGH, 1 LOW-MEDIUM (F-2: mark_dirty range), 5 LOW (cosmetic).

---

## VERDICT

**The decision-lock's code claims are SOUND.** Every substantive claim checked against the actual source is correct:

- The Phase 6.1 anticipation comment is verbatim in `calcgraph_session.rs:69-71`.
- The volatility whitelist and its Phase 4.3 replacement note are verbatim in the cited range.
- `FunctionRegistry` stores only dispatch enum variants; no metadata record exists anywhere in the registry.
- `WorkbookRuntime` does call graph hooks after successful mutation (the "owns" wording is imprecise but the behavior is correct).
- All three placeholder crates (`ql-udf`, `quantbook-py`, `ql-ai`) have no public API surface and are genuinely empty except for test stubs.
- The AI sentinel, replay semantics, error-code prefix, CollabSession wrapper, and PyO3 pin are all exactly as cited.

Two citations have imprecision worth noting before implementation work begins:

1. **F-2** (mark_dirty line range 1370-1395 vs actual 1384-1432): a developer navigating to this citation to study the fanout algorithm would land inside the doc comment rather than the function body, and would miss the BFS pass entirely. Correct the range before the 6.4 graph-invalidation implementation phase.
2. **F-1** ("owns" vs borrows): the 6.1B implementation must truly own these components, not borrow them. The imprecision in the existing doc could mislead the implementer into replicating the borrow pattern. The explicit "owning WorkbookSession" language in the decision-lock §2 step 3 is already correct; the §4 wording should match.

Neither finding invalidates any Phase 6 decision. The decision-lock is safe to act on.

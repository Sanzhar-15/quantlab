---
title: Phase 5.7 V1 megaudit - Opus-A docs completeness lane
date: 2026-05-22
audit_target_engine: 6003db4ce2c
audit_target_ide: a517d7c5f71
lane: documentation completeness + cross-doc consistency
verdict: PASS-WITH-FINDINGS
findings_total: HIGH=2 MEDIUM=9 LOW=11 OBSERVATIONS=5
---

# Phase 5.7 V1 megaudit -- Opus-A docs completeness lane

Cross-doc consistency + memory-file accuracy audit for the Phase 5.7 V1 cross-repo ship.
Engine HEAD `6003db4ce2c` on `feat/quantbook-engine`; IDE HEAD `a517d7c5f71` on `feat/visualise-v1`.

## Audit methodology

1. Verified both repo HEADs match the prompt's targets via `git log --oneline -3` + `git rev-parse HEAD`.
2. Read every doc in the prompt's "Files to audit" list end-to-end (or full grep + targeted Read for the longer ones).
3. Cross-referenced claims between docs (e.g., "doc X says Y shipped at commit Z; verify Z is real").
4. Compared docstring claims (lib.rs / session.rs / transport.rs / loader.ts / etc.) against the actual code state.
5. Checked memory files against their staleness markers + current branch state.
6. Verified uncommitted local changes via `git diff HEAD` -- discovered that 4 docs already carry uncommitted fixes
   for several drift items called out in the user's pre-megaudit list.

## Critical pre-audit context: uncommitted local drift fixes

**A `git diff HEAD` against the engine repo shows FOUR files have UNCOMMITTED changes** that already address
several of the user's pre-megaudit drift items:

- `docs/MASTER-PLAN.md` -- line 545 status updated 2026-05-22; line 596 5.7 entry updated to ✅ SHIPPED; line 598 5.8 updated.
- `docs/PHASE-4-V2-BACKLOG.md` -- H9 disposition updated 2026-05-22 to "Phase 5.7 V3 work, NOT V1".
- `docs/phase5/5-7-v1-exit-packet.md` -- lines 5-6 `[closure commit]` placeholders replaced with `6003db4ce2c` + `a517d7c5f71`.
- `docs/phase5/v1-exit-packet.md` -- status line updated with V2 V4 V1 + 5.7 V1 + 5.7 V2/V3 forward map.

**The user's pre-megaudit drift items 1, 2, 3, 4, 6 ARE addressed in this uncommitted diff.** Items 5 (lib.rs "~330 lines")
and 7 (`quantlab_branch_state.md` 31 days old) are still real.

**HIGH-1** below flags that these uncommitted changes need to be COMMITTED (otherwise the next session sees a clean
HEAD `6003db4ce2c` -- which is what `git log` reports -- but the working tree has docs the next session can't see
through `git log`).

---

## HIGH findings

### HIGH-1. Four engine docs have uncommitted local fixes that will be invisible to the next session

**Files:**
- `quantbook-engine/docs/MASTER-PLAN.md`
- `quantbook-engine/docs/PHASE-4-V2-BACKLOG.md`
- `quantbook-engine/docs/phase5/5-7-v1-exit-packet.md`
- `quantbook-engine/docs/phase5/v1-exit-packet.md`

**What's wrong:** `git status --porcelain` reports all four as modified-but-uncommitted. The audit-target HEAD
`6003db4ce2c` does NOT contain these fixes. If a fresh session reads `current_work.md` § 1 ("verify HEAD =
`6003db4ce2c`") and treats that as canonical, it will see the STALE versions of these files because the working-tree
fixes are not yet committed.

`current_work.md` says "git status --short # expect empty (or only untracked .codex-* / .plans/_archive/* if those
aren't tracked)" -- this is now wrong: 4 tracked files are modified.

**Closure recommendation:** commit the 4 modified docs as a single follow-up commit `docs: post-V1-ship cross-doc drift sweep`.
Commit BEFORE the next session starts. Alternatively, document the uncommitted state in `current_work.md` § 1 expectations
so the fresh session knows to look for it (lower-quality option -- forgetting to commit creates compounding drift).

**Convergent prediction:** Codex (protocol lane) will not flag this (not a protocol concern). Opus-B (V2-readiness)
may flag it if it asks "what does V2 START FROM?" -- the answer is the working-tree state, not HEAD.

### HIGH-2. session.rs:609-612 still calls Phase 5.7 IDE binding "to wire", but Phase 5.7 V1 SHIPPED without wiring rebuild_workbook

**File:** `quantbook-engine/crates/ql-collab/src/session.rs:609-612`

**What's wrong (quoting the file):**
```
/// - HIGH-1 (Opus step 5b audit): `rebuild_workbook` is shipped as
///   the API entry point for Phase 5.7 IDE binding to wire. No
///   production code path calls it yet — the user-visible D-3
///   closure happens at step 7, not 5b.
```

The docstring says "Phase 5.7 IDE binding TO WIRE" (future-tense, "step 7" ambiguous), but Phase 5.7 V1 has now
shipped (HEAD `6003db4ce2c`) and DID NOT bind `rebuild_workbook` -- the V2-backlog H9 update (uncommitted) explicitly
defers it to Phase 5.7 V3. The docstring still pins the user-visible D-3 closure on "step 7" which no longer matches
the post-5.7-V1 plan (now 5.7 V3).

Why HIGH: this docstring is the inline-source contract that V2/V3 implementers will read FIRST when wiring
`rebuild_workbook` into the IDE. If it claims V1 will do it but V1 didn't, the reader is left ambiguous about
which version of 5.7 actually wires it.

**Closure recommendation:** replace lines 609-612 with:
```
/// - HIGH-1 (Opus step 5b audit): `rebuild_workbook` is shipped as
///   the API entry point but is NOT yet wired by Phase 5.7 V1 (V1
///   binds the minimum CollabSession surface: constructor /
///   fromSnapshot / appendPutValue / exportBytes / mergeBytes /
///   observability accessors; see crates/ql-bindings-node/src/lib.rs
///   module docs for full V1 scope). The user-visible D-3 closure
///   (post-merge rename-repair on real workbook formulas) lands at
///   Phase 5.7 V3 (cell-grid UI + persistence) where the
///   merge-then-recompute path becomes user-visible. V2 (Transport
///   binding) does not need rebuild_workbook either. Tracked at
///   docs/PHASE-4-V2-BACKLOG.md H9.
```

**Convergent prediction:** Codex (protocol) may flag this -- the docstring describes a contract that no longer matches reality.

---

## MEDIUM findings

### MEDIUM-1. lib.rs module doc claims `Send + !Sync` but V2 V4 V1 step 3 audit-discipline Rule 4 should mandate a positive compile proof of `!Sync`

**File:** `quantbook-engine/crates/ql-bindings-node/src/lib.rs:58-77`

**What's wrong:** The module doc says `CollabSession` is `Send + !Sync` (line 58) "verified per V2 V4 V1 step 3 +
audit-discipline Rule 4". Per audit-discipline Rule 4 (added 2026-05-21 EXACTLY because a wrong `!Sync` claim survived
3 audits), negative trait claims require a positive compile PROOF (`assert_not_impl_any!`) OR a per-field walk.

The doc cites Rule 4 but doesn't carry a `static_assertions::assert_not_impl_any!(CollabSession: Sync)` (the canonical
way to enforce a negative trait claim). The `session.rs` IS asserting `Send` positively on line 74-77 but neither file
asserts `!Sync` positively.

**Closure recommendation:** add `static_assertions::assert_not_impl_any!(CollabSession: Sync);` to the binding's
`#[cfg(test)]` module OR to a `const _: fn() = ...` block. Audit-discipline Rule 4 is load-bearing precisely because
the V2 V3 step 4 docstring `!Sync` claim was wrong -- the same class of error could repeat here.

**Convergent prediction:** Opus-B (V2-readiness) very likely flags this; Codex may too (it's in scope for "protocol
correctness" because it's a trait-contract claim).

### MEDIUM-2. transport.rs:62-63 says "Phase 5.5 V2 V3 remaining (pending): full-arc megaudit (step 5) and exit packet (step 6)" — both steps SHIPPED 2026-05-21

**File:** `quantbook-engine/crates/ql-collab/src/transport.rs:62-63`

**What's wrong (quoting):**
```
//! **Phase 5.5 V2 V3 remaining (pending):** full-arc megaudit
//! (step 5) and exit packet (step 6).
```

Both steps are already shipped (steps 5 + 6 at `bce64a5c1ce` + `8a8236840f2` on 2026-05-21, predating Phase 5.7 V1).
The `transport.rs` module doc has been updated through V2 V3 step 4 + V2 V4 V1 step 3 but missed this "pending" claim.

**Closure recommendation:** replace lines 62-63 with:
```
//! **Phase 5.5 V2 V3 step 5 megaudit (2026-05-21, `bce64a5c1ce`):**
//! 3-way Codex+Opus-A+Opus-B; lifted `last_error()` to the trait
//! (see line 156 below), plus `TaskExitGuard` RAII + Close-frame
//! reason capture + poisoned-mutex no-fallback fix.
//! **Phase 5.5 V2 V3 step 6 exit packet (2026-05-21):** at
//! `docs/phase5/v2-v3-exit-packet.md` + consumer doc rewrite at
//! `docs/architecture/ide-consumer-contract.md` § 4.1.1-3.
//! **Phase 5.5 V2 V4 V1 (2026-05-21, 12/13 Tier items):** ack
//! channel, `pending_op_count`, `discard_pending_ops`, defensive
//! hardening; see `docs/phase5/v2-v4-v1-exit-packet.md`.
//! **Phase 5.7 V1 (2026-05-22):** FIRST IDE binding via napi-rs;
//! see `docs/phase5/5-7-v1-exit-packet.md`.
```

**Convergent prediction:** likely Codex; possibly Opus-B.

### MEDIUM-3. session.rs:13-20 module doc says Phase 5.5 V2 V2 / V3 "pending"; says Phase 5.7 "becomes the engine handle that the IDE attaches"

**File:** `quantbook-engine/crates/ql-collab/src/session.rs:13-26`

**What's wrong:**
- Line 19-20: "V2 V2 / V3 pending — auto-flush + version-vector deltas + WebSocket impl." -- all shipped.
- Line 25-26: "Phase 5.7 — IDE binding: `CollabSession` becomes the engine handle that the IDE attaches to each open workbook." -- now PAST tense for V1 (the binding shipped 2026-05-22; the IDE does attach, but only the minimum V1 surface).

**Closure recommendation:** replace lines 13-26 with a single block:
```
//! - **Phase 5.5** ✅ V2 V3 V1 SHIPPED 2026-05-21 + V2 V4 V1 SHIPPED 2026-05-21.
//!   V1: LoopbackTransport. V2 V1: attach/detach/has/flush/poll. V2 V2: AutoFlushPolicy.
//!   V2 V3 steps 1-6: delta flush + poll auto-flush + offline-write + WebSocket
//!   + 3-way megaudit + exit packet. V2 V4 V1: 12/13 Tier items (ack channel,
//!   pending_op_count, discard_pending_ops, defensive hardening). V2 V4 V2 (K4
//!   chunking) deferred.
//! - ~~**Phase 5.6**~~ ✅ V1 + V2 SHIPPED.
//! - **Phase 5.7** ✅ V1 SHIPPED 2026-05-22. First IDE binding via napi-rs:
//!   `crates/ql-bindings-node/` exposes CollabSession as a napi class to the
//!   quantlab VS Code fork. V1 surface = constructor / fromSnapshot /
//!   appendPutValue / exportBytes / mergeBytes / observability. Transport
//!   binding is V2 (recommended next, ~3-5d); cell-grid UI + rebuild_workbook
//!   wiring is V3 (~1-2wk). See docs/phase5/5-7-v1-exit-packet.md.
```

**Convergent prediction:** likely Codex.

### MEDIUM-4. ide-consumer-contract.md:198 says "preview — for Phase 5.7 IDE vertical slice"

**File:** `quantbook-engine/docs/architecture/ide-consumer-contract.md:198`

**What's wrong:**
```
### 4.1 Phase 5 collaboration surface (preview — for Phase 5.7 IDE vertical slice)
```

The framing "preview -- for Phase 5.7 IDE vertical slice" was true when V2 V3 step 6 shipped (2026-05-21). It's now
out of date: 5.7 V1 has shipped, and there's a concrete binding in `crates/ql-bindings-node/` that consumes part of
this contract. The "preview" framing implies "not yet consumed" -- inaccurate.

**Closure recommendation:** replace heading with:
```
### 4.1 Phase 5 collaboration surface (Phase 5.7 V1 binds this; V2+V3 will extend)
```

and add a paragraph after the heading:
```
**Status update (Phase 5.7 V1, 2026-05-22)**: a Node binding now consumes part of this
surface via `crates/ql-bindings-node/`. V1 binds the minimum CollabSession round-trip
(constructor / fromSnapshot / appendPutValue / exportBytes / mergeBytes / observability).
The Transport surface (§§ below: attach_transport, flush_*, poll_remote*, auto-flush,
delta flush, offline-write, WebSocket impl) is documented here but NOT yet bound to JS;
Phase 5.7 V2 binds Transport. Phase 5.7 V3 binds rebuild_workbook + full Op enum +
undo/redo + presence + persistence.
```

**Convergent prediction:** likely Codex.

### MEDIUM-5. v2-v4-v1-exit-packet.md:124 still calls Phase 5.7 a "different repo" future option

**File:** `quantbook-engine/docs/phase5/v2-v4-v1-exit-packet.md:124`

**What's wrong:**
```
1. **Phase 5.7 IDE vertical slice** (~1 week, different repo). Build the actual IDE binding in the VS Code fork. Real product progress.
```

Out of date: V1 already shipped 2026-05-22. The "Forward direction" section needs updating.

**Closure recommendation:** replace lines 120-130 with:
```
## Forward direction

**Status update (post-V2 V4 V1):** Phase 5.7 V1 SHIPPED 2026-05-22 (engine
`677ee03ee8b` + IDE `1a7fc8bbe3f`; closure pair `6003db4ce2c` + `a517d7c5f71`).
See `docs/phase5/5-7-v1-exit-packet.md`. The recommendation below is now post-V1.

**Next options:**

1. **Phase 5.7 V2 — Transport binding** (~3-5d, recommended). Bind the
   Transport trait + LoopbackTransport + WebSocketTransport + flush/poll methods
   + multi-window demo.

2. **Phase 5.5 V2 V4 V2 — K4 chunking** (~2-3d). Architectural cleanup of the
   transport's unbounded outbound queue.

3. **Phase 5.7 V3 — Cell grid + persistence** (~1-2wk). Real spreadsheet UI;
   depends on V2.

4. **Phase 5.8 megaudit** (~4-6d). Now best done after V2+ binding so the
   IDE-side state is in scope.

**Recommendation**: Phase 5.7 V2 (engineering throughput on the user-visible
collaboration story).
```

**Convergent prediction:** likely Opus-B (V2-readiness).

### MEDIUM-6. v2-v3-exit-packet.md:148-187 still treats Phase 5.7 as future ("not blocking", "Phase 5.7 IDE vertical slice. Two-window editing demo.")

**File:** `quantbook-engine/docs/phase5/v2-v3-exit-packet.md:148, 161, 183, 187`

**What's wrong:**
- Line 148: "**UNBLOCKED.** The Phase 5.7 IDE vertical slice can be built today against the V2 V3 V1 substrate..."
- Line 161: "**Not blocking Phase 5.7**..."
- Line 183: "**Next**: Phase 5.7 IDE vertical slice. Two-window editing demo. ~1 week."
- Line 187: "**Phase 5.8 megaudit**: ... Depends on 5.7 complete."

All four lines reference Phase 5.7 as future work. V1 is now SHIPPED; V2 + V3 remain.

**Closure recommendation:** add a status block at the top of "Phase 5.7 readiness assessment" (around line 146):
```
**Status update (Phase 5.7 V1 SHIPPED 2026-05-22)**: V1 binds the minimum
CollabSession surface (no Transport). V2 + V3 still build on the substrate
described below. See `docs/phase5/5-7-v1-exit-packet.md`.
```

Update line 183 to "**Next**: Phase 5.7 V2 -- Transport binding. ~3-5d." Update line 187 to "Depends on 5.7 V2+
(V1 substrate is too thin for megaudit value)."

**Convergent prediction:** unlikely to be flagged by Codex/Opus-B; in-scope for this lane.

### MEDIUM-7. entry-plan.md:118, 120 — table rows for 5.5 and 5.7 are stale

**File:** `quantbook-engine/docs/phase5/entry-plan.md:118, 120`

**What's wrong:**
- Line 118: "🟡 V1 + V2 V1 + V2 V2 + V2 V3 steps 1-3 SHIPPED" -- now V2 V3 V1 + V2 V4 V1.
- Line 120: "5.7 | IDE Vertical Slice | 1 week | Two-window editing." -- V1 has shipped.

Note: this doc IS marked `status: SUPERSEDED-BY-EXIT-PACKETS` in frontmatter (line 3). However, supersedence
doesn't mean the body is rendered unreadable; future agents may grep it. Three options: (a) update the body too;
(b) move the file to `_archive/`; (c) explicitly truncate the body with a redirect.

**Closure recommendation:** Update line 118 to "🟢 V2 V4 V1 SHIPPED 2026-05-21" and line 120 to "🟢 V1 SHIPPED 2026-05-22"
(matches the existing 5.3 + 5.4 + 5.6 row patterns). Frontmatter supersedence stays.

**Convergent prediction:** unlikely to be flagged by other lanes (the doc is officially superseded).

### MEDIUM-8. d-1-exit-packet.md:138 says "Phase 5.7 IDE vertical slice... Depends on D-1 + 5.3 + 5.5 V2 V2 — don't start until all three are done"

**File:** `quantbook-engine/docs/phase5/d-1-exit-packet.md:138, 141`

**What's wrong:**
- Line 138: "**5.7** IDE vertical slice ... **Depends on D-1 + 5.3 + 5.5 V2 V2** — don't start until all three are done."
- Line 141: similar framing.

All three dependencies (D-1 + 5.3 + 5.5 V2 V2) DID land before 5.7 started, but the wording "don't start until all
three are done" is now incoherent because the user DID start (and finish) 5.7 V1.

**Closure recommendation:** add a status update block at the bottom of d-1-exit-packet.md:
```
## Status update (2026-05-22)

5.7 V1 SHIPPED 2026-05-22 (after D-1 + 5.3 + 5.5 V2 V2 + V2 V3 V1 + V2 V4 V1
all landed first, satisfying the dependency chain documented above). See
`docs/phase5/5-7-v1-exit-packet.md` for the V1 closure record. The forward-options
table at line 138 is HISTORICAL -- check current_work.md for live forward direction.
```

**Convergent prediction:** unlikely.

### MEDIUM-9. 5-3-exit-packet.md:146, 170, 173, 175 — multiple "Phase 5.7 will wire rebuild_workbook" claims; V1 didn't

**File:** `quantbook-engine/docs/phase5/5-3-exit-packet.md:146, 170, 173, 175`

**What's wrong:**
- Line 146: "Phase 5.7 IDE binding will actually call it (step 5b Opus HIGH-1 framing closure)." -- V1 did NOT.
- Line 170: "At this point, the user-visible D-3 closure (concurrent rename + edit) requires step 7..." -- still requires 5.7 V3.
- Line 175: implies "5.5 → 5.7 → 5.8" sequence; reality is 5.5 V2 V3 → V2 V4 V1 → 5.7 V1 → V2 → V3 → 5.8.

**Closure recommendation:** add an inline footnote/aside at line 146:
```
*(Status update 2026-05-22: Phase 5.7 V1 SHIPPED without wiring rebuild_workbook
-- V1 was minimum-surface and rebuild_workbook needs FunctionRegistry binding,
deferred to Phase 5.7 V3. The user-visible D-3 closure now lands at V3 rather
than V1. See `docs/PHASE-4-V2-BACKLOG.md` H9.)*
```

And replace line 175's sequence with "5.5 → 5.7 V1 → 5.7 V2 → 5.7 V3 → 5.8".

**Convergent prediction:** unlikely; in-scope for this lane.

---

## LOW findings

### LOW-1. v1-exit-packet.md:375 — claim "23 audit transcripts at docs/audits/2026-05-19-*.md" but `ls` shows 33 transcripts

**File:** `quantbook-engine/docs/phase5/v1-exit-packet.md:375`

**What's wrong:** "**docs/audits/2026-05-19-*.md** — 23 audit transcripts across 11 audit cycles". `ls
docs/audits/2026-05-19-*.md | wc -l` returns 33.

This was likely accurate at original write-time; post-exit-packet additions (5.6 V2, D1.a, etc.) added more
transcripts. Not load-bearing (cross-reference still resolves to a real glob), but the count claim is wrong.

**Closure recommendation:** update to "30+ audit transcripts" OR drop the count and just cite the glob.

### LOW-2. v1-exit-packet.md:64 says "23 commits to exit-packet ship + 7 post-exit-packet commits = 30 commits total"

**File:** `quantbook-engine/docs/phase5/v1-exit-packet.md:64`

**What's wrong:** post-exit-packet commits have grown well beyond 7 (D-1 multi-day arc + 5.3 multi-day arc + 5.5
multi-day arc + 5.7 V1 cross-repo arc). The count is frozen at the exit-packet ship date but the doc is otherwise
being updated.

**Closure recommendation:** add a note "(count frozen at original ship 2026-05-19; subsequent multi-day arcs added many more commits -- see successor exit packets for tallies)".

### LOW-3. 5-7-v1-exit-packet.md:9 frontmatter says "workspace 4461+ / 0" — the "+" is ambiguous

**File:** `quantbook-engine/docs/phase5/5-7-v1-exit-packet.md:9`

**What's wrong:** "test_count_at_v1_exit: workspace 4461+ / 0". The "+" suggests "at least 4461". `current_work.md`
gives the exact count "4461 / 0". Either remove the "+" (commit to the exact count) or document why it's a lower bound.

**Closure recommendation:** drop the "+" since `current_work.md` line 39 commits to exactly 4461.

### LOW-4. 5-7-v1-exit-packet.md:194 + memory: workspace test count claimed as 4461, but no doc reports the verify command was run

**File:** `quantbook-engine/docs/phase5/5-7-v1-exit-packet.md:194`

**What's wrong:** "Engine workspace tests: 4461 / 0 (workspace, `--test-threads=1`)". This count is asserted in
multiple docs but the per-step audit transcripts at `docs/audits/2026-05-22-phase-5-7-v1-opus.md` don't carry a
test-count verification line. The number propagates between docs without a verification anchor.

The 4461 number is plausible (V2 V4 V1 exit was 4459, +6 from step 5 = 4459 if you don't double-count; +2 unit tests in `ql-bindings-node` brings it to 4461). But it should be verifiable.

**Closure recommendation:** when committing the engine-side closure commit, run `cargo test --workspace --all-features
-- --test-threads=1 2>&1 | tail -5` and paste the actual result into a `## Workspace test verification (run at HEAD
`6003db4ce2c`)` section in the exit packet. Pure-documentation; deferred OK if time-bound.

### LOW-5. lib.rs:1-5 says "(Phase 5.7 V1 (2026-05-22, this ship)" — load-bearing inside source but possibly inconsistent vocabulary

**File:** `quantbook-engine/crates/ql-bindings-node/src/lib.rs:3`

**What's wrong:** "**Phase 5.7 V1 (2026-05-22, this ship):** binds `CollabSession`..." Throughout the codebase,
"this ship" is sometimes used to mean "the commit that introduces this comment" (audit-transcript style). For
inline source docs that get re-read months later, "this ship" is ambiguous. The reader doesn't know which commit.

**Closure recommendation:** replace "this ship" with the explicit commit hash: "Phase 5.7 V1 (2026-05-22, ship
`677ee03ee8b` + closure `6003db4ce2c`)". Consistent with how `transport.rs:45-46` cites commits.

### LOW-6. lib.rs:48 V2 deferred list misses `discard_pending_ops`

**File:** `quantbook-engine/crates/ql-bindings-node/src/lib.rs:49-54`

**What's wrong:** "Transport binding (LoopbackTransport, WebSocketTransport), undo/redo, presence, full Op enum,
format IDs, `rebuild_workbook` (D-3 production-visible closure), all flush_* methods. V2 picks these up."

Missing from the list: `discard_pending_ops`, `transport_last_error`, `attach_transport` / `detach_transport` /
`has_transport`, `set_auto_flush_policy` / `auto_flush_policy`. Compare against the full deferred list in the
5-7-v1-exit-packet.md table at lines 148-169.

**Closure recommendation:** expand the V1 deferred section in lib.rs to match the exit-packet's deferred table, OR
delegate to the table: "V1 deferred items: see `docs/phase5/5-7-v1-exit-packet.md` § 'V1 deferred to V2'."

### LOW-7. session.ts:22 still references ".plans/_active.md (engine repo) for V2 deferred list" but the V2 deferred list is now in the 5-7-v1-exit-packet.md

**File:** `quantlab/extensions/quantlab/src/quantbook/session.ts:22`

**What's wrong (quoting):**
```
* **Per V1 scope:** no Transport, no presence, no undo, no formula
* support. See `.plans/_active.md` (engine repo) for V2 deferred list.
```

The engine's `.plans/_active.md` may not exist (and indeed: `.plans/_archive/2026-05-22_phase-5-7-v1-vertical-slice.md`
is the archived plan; `_active.md` likely empty/missing). The V2 deferred list now lives in
`docs/phase5/5-7-v1-exit-packet.md`.

**Closure recommendation:** update to "See `quantbook-engine/docs/phase5/5-7-v1-exit-packet.md` § 'V1 deferred to V2'
for the full deferred list (engine + IDE side)."

### LOW-8. quantbook-roundtrip.test.ts:19-21 — build command not idiomatic

**File:** `quantlab/extensions/quantlab/test/quantbook-roundtrip.test.ts:19-21`

**What's wrong (quoting):**
```
* Build the binary before running:
*   cd ../quantlab-quantbook/quantbook-engine
*   cargo build -p ql-bindings-node --release
```

This is a worktree-layout-dependent path. From the test file's perspective the `cd` target is `../../../quantlab-quantbook/quantbook-engine`
(IDE root is 3 levels up from `extensions/quantlab/test/`). Memory file `current_work.md` § 9 has the right path.

**Closure recommendation:** match `current_work.md` § 9 by giving an absolute-path example, or note that the relative
path depends on the cwd.

### LOW-9. PHASE-4-V2-BACKLOG.md (uncommitted version) H9 still doesn't update line 444 "ZERO non-test callers"

**File:** `quantbook-engine/docs/PHASE-4-V2-BACKLOG.md:444`

**What's wrong:** even the uncommitted H9 update says "Behavior: `CollabSession::rebuild_workbook` is shipped as the
API entry point but has ZERO non-test callers in the engine". This is still TRUE post-V1 (V1 didn't bind it), but
the "Behavior" paragraph reads as if nothing changed -- the disposition paragraph is the only place that mentions V1
shipping.

**Closure recommendation:** restate the behavior more precisely:
```
- **Behavior:** `CollabSession::rebuild_workbook` is shipped as the API entry
  point but has ZERO non-test callers (engine or IDE) at HEAD `6003db4ce2c` /
  `a517d7c5f71`. The user-visible D-3 closure requires the IDE-side
  merge-then-recompute path to call `rebuild_workbook`, which requires
  binding FunctionRegistry first -- deferred to Phase 5.7 V3.
```

### LOW-10. crdt-data-model.md:255 — "(Phase 5.7)" in past parenthetical, but Phase 5.7 now means V1 (shipped) vs V2 (Transport) vs V3 (cell grid)

**File:** `quantbook-engine/docs/architecture/crdt-data-model.md:255`

**What's wrong:** "visually distinguishable in the IDE (Phase 5.7) since they..." -- the "Phase 5.7" reference is
abstract; now that Phase 5.7 has 3 sub-versions (V1 shipped, V2 forward, V3 forward), readers may be confused which
sub-version owns the "visually distinguishable" requirement.

**Closure recommendation:** clarify: "(Phase 5.7 V3 -- cell-grid UI work)".

### LOW-11. ide-consumer-contract.md:3 — "Status: Engine Phase 2B.6 — first vertical-slice surface" + "Stability: DRAFT"

**File:** `quantbook-engine/docs/architecture/ide-consumer-contract.md:3-5`

**What's wrong:** the file frontmatter declares it Phase 2B.6 vintage (line 3-4) with "Stability: DRAFT — names + shapes
will change as Engine Phase 6.1 (Stable Engine Session API) formalizes them. This document is the SPEC that 6.1 will harden."

But the doc has been HEAVILY extended through Phase 5 (V2 V3 V1, V2 V4 V1, worked examples in § 4.1.1-3). The "Phase 2B.6"
header is now an anachronism, even though it's the doc's official birth-phase. New readers may not realize that § 4.1+ is
Phase 5 content.

**Closure recommendation:** update line 3-4 to:
```
**Status:** Engine Phase 2B.6 (origin) -- substantially extended through Phase 5 V2 V4 V1 (collaboration surface § 4.1)
**Date:** 2026-05-12 (origin); last substantive update 2026-05-21 (V2 V4 V1 closure)
```

---

## OBSERVATIONS (noteworthy but not actionable in this cycle)

### OBS-1. quantlab_branch_state.md is 31 days old and references the pre-merge branch state

**File:** `~/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/quantlab_branch_state.md` (31 days old)

The memory file says "real work on `backup/implementation-on-disk-2026-04-21`; build fixes on `build-fixes/macos-clang21`."
Current IDE work has shifted: `feat/visualise-v1` is the active IDE branch (carries the qviz arc + Phase 5.7 V1 IDE binding).
The memory file is correct about the engine-worktree note ("Quantbook engine work lives on a separate worktree at
`quantlab-quantbook/` on `feat/quantbook-engine`"); incorrect about the active IDE branch.

The auto-loaded `system-reminder` "This memory is 31 days old" already prompts verification; functionally the next session
WILL verify before acting on it. Recommend updating the body to mention `feat/visualise-v1` as the active IDE branch and
note that the active branch has shifted multiple times in the 31-day interval.

Note: this is OBS not LOW because Claude's system-reminder mechanism already mitigates it.

### OBS-2. MEMORY.md index entry for quantlab_branch_state.md doesn't flag the staleness

**File:** `~/.claude/projects/-Users-sanzhar-Documents-Sanzhar-Sanzhar-quantlab/memory/MEMORY.md:12`

The MEMORY.md description for quantlab_branch_state.md says "real work on `backup/implementation-on-disk-2026-04-21`...
**Quantbook engine work lives on a separate worktree at `quantlab-quantbook/` on `feat/quantbook-engine`.**"

The trailing engine-worktree clause is current; the lead clause is now wrong (IDE work has migrated forward). Consider
adding a note like "(branch state evolves frequently; verify with `git branch --show-current` at session start)".

### OBS-3. Engine + IDE repo bidirectional reference asymmetry

Engine docs reference IDE paths (e.g., `extensions/quantlab/...`) using engine-repo-relative paths.
IDE docs reference engine paths using engine-repo-relative paths.

A reader landing in EITHER repo can't navigate the other without knowing the worktree-layout convention
(`~/Documents/Sanzhar/Sanzhar/quantlab/{quantlab,quantlab-quantbook}/`). The two repos do not have a top-level
`README.md` or similar that says "these are sibling repos at this layout".

Consider adding a `WORKTREE-LAYOUT.md` at the top of each repo (or a single one at the parent dir) explaining the
sibling-repo convention. Deferred to V2 or beyond; not blocking.

### OBS-4. The audit transcript naming convention has drift

Audits prior to Phase 5.5 V2 V4 V1 used `docs/audits/YYYY-MM-DD-phase-5-N-step-M-{codex,opus}.md`. The Phase 5.7 V1
audits use `docs/audits/2026-05-22-phase-5-7-v1-{codex,opus}.md` (no step number; the cycle had only 1 ship + 1 closure
which arguably doesn't need step numbers). This megaudit will produce `2026-05-22-phase-5-7-v1-megaudit-opus-a-docs.md`
etc. -- another minor variation.

Not a defect, just an observation. A future "audit-transcript-naming-convention.md" doc would be useful for grep-based
audit-history queries.

### OBS-5. The 5-7-v1-exit-packet.md table at lines 148-169 ("V1 deferred to V2") is the canonical V2 backlog; should be cross-referenced from PHASE-4-V2-BACKLOG.md

The 5-7-v1-exit-packet.md carries a "V1 deferred to V2" table with 16 line items. PHASE-4-V2-BACKLOG.md is the
top-level forward-work backlog. The 16 V1-deferred items are NOT in PHASE-4-V2-BACKLOG.md, even though some (e.g.,
Windows-specific `.dll` naming, CI `QUANTBOOK_REQUIRE_ENGINE=1`, SharedArrayBuffer defensive copy) are
production-ship-blocking concerns.

Recommend adding a "Tier P -- Phase 5.7 V2/V3 forward work (from V1 exit packet)" section to PHASE-4-V2-BACKLOG.md
that mirrors the 5-7-v1-exit-packet.md table or cross-references it. V2/V3 implementers reading PHASE-4-V2-BACKLOG.md
would see the 5.7-specific items.

---

## Summary

**Verdict:** PASS-WITH-FINDINGS. The Phase 5.7 V1 documentation is substantially correct; HIGH-1 is procedural (commit
the uncommitted fixes) and HIGH-2 is a single load-bearing source-code docstring drift. MEDIUM findings are
post-V1-ship "preview / future / pending" language that should now be ✅ SHIPPED markers across 7 docs + 2 source files.
LOW findings are minor inconsistencies + path/build-command hygiene + a missing positive `!Sync` compile proof.

**Cross-doc consistency** is overall good given the multi-day arc. The exit packets cite each other correctly; commit
hashes are accurate where they appear; the V2 V4 V1 step 3 audit-discipline Rule 4 correctly flowed into the 5.7 V1
binding's Send/Sync documentation (even if the positive `!Sync` proof is still missing per MEDIUM-1).

**Memory-file accuracy:** `current_work.md` (the file every next session reads first) is well-organized,
internally consistent, and accurate to the current state. `MEMORY.md` index is current for the Phase 5.7 V1 entry.
Older memory files (visualise_v1_handover, visualise_v2_expression_language, quantlab_branch_state) are flagged
stale by system-reminders and don't actively contradict current state EXCEPT quantlab_branch_state.md's lead claim
(OBS-1).

**Highest-leverage closure**: commit the 4 uncommitted doc fixes (HIGH-1). Without that, the next session sees a doc
state that differs from what `git log` reports, undermining the §1 verification ritual.

**Closure ordering (recommended):**
1. HIGH-1 (commit the 4 uncommitted docs) -- 1 commit, ~5 min
2. HIGH-2 (session.rs:609-612) -- include in same closure commit
3. MEDIUM-1 through MEDIUM-9 -- batch into a "post-megaudit doc sweep" commit, ~30 min
4. LOW-1 through LOW-11 -- defer or batch into same sweep commit, ~20 min
5. OBSERVATIONS -- defer, document forward.

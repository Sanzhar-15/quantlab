# 6.1C Megaudit — Orchestration Index

5-way parallel audit (4 Codex lanes + 1 Opus reviewer + Opus synthesis). Self-contained: every artifact a fresh session needs is in this directory. **Read `../6-1c-entry-plan.md` first** for scope + seed inputs.

## Lanes

| Lane | Focus | Prompt | Output target |
|---|---|---|---|
| A | FFI boundary · panic · Send/Sync · `engine_error_to_napi` · validation · owned data | [`lane-a-ffi-panic.md`](lane-a-ffi-panic.md) | `lane-a.out` (Codex artifact) |
| B | Lifecycle/state machine · cancellation honesty · `{epoch, state_seq}` · `snapshot_delta` · op-log / Loro UndoManager coherence | [`lane-b-lifecycle.md`](lane-b-lifecycle.md) | `lane-b.out` |
| C | DTO fidelity · snapshot determinism · `schema_version` · unbounded growth · method-shape diffs vs CollabSession · "delete cell contents" gap | [`lane-c-dto-determinism.md`](lane-c-dto-determinism.md) | `lane-c.out` |
| D | Persistence (`.qbook`) · import/export (xlsx/csv) · op-log payload integrity · effective-extent cross-cutting · `OPLOG_SCHEMA_VERSION` | [`lane-d-persistence-io.md`](lane-d-persistence-io.md) | `lane-d.out` |
| E (Opus) | Independent cross-lane review (the Opus reviewer; runs as a fresh-context Agent) | (the Agent prompt — built from the four lane prompts plus a "cross-correlate" instruction; see below) | inline agent result |

## Launch (fresh session)

The four Codex lanes can run in parallel as background tasks. The Opus reviewer runs as an `Agent` (general-purpose, fresh context). All five complete independently; **a 5th Opus synthesis pass** then reads all five outputs and produces the final synthesis doc.

### Step 1 — orient (5 min, before any launch)
- Read `docs/phase6/6-1c-entry-plan.md` (scope + the 10 seed inputs).
- Verify engine HEAD: `mac zsh -lc 'cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && git log --oneline -3'` → expect `fbef9d8be1f` (6.1B IDE-migration doc-sync) ← `c24222315ed` (IDE) is on the **IDE** repo, NOT here.
- Verify IDE HEAD: `mac zsh -lc 'cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab && git log --oneline -2'` → expect `c24222315ed` (the IDE-migration commit).
- Read `docs/audits/2026-05-28-6-1b-ide-node-migration/SYNTHESIS.md` (this audit consumes its tracked findings).

### Step 2 — launch the 4 Codex lanes in parallel (Mac bridge, background)
For each `lane in {a,b,c,d}`:
```sh
mac zsh -lc 'cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine \
  && codex exec -s read-only "$(cat docs/phase6/6-1c-prep/lane-<LANE>-<...>.md)" \
  > docs/phase6/6-1c-prep/lane-<lane>.out 2>&1; echo "LANE_<LANE>_EXIT=$?"'
```
Issue **all four in the same Claude turn** (Bash with `run_in_background: true` × 4) so they truly parallelize. **Patience: each Codex run takes 3–10 minutes.** The completion notification fires per-lane. Do NOT poll with Linux `pgrep`/wait-loops — Mac-host Codex procs aren't visible.

### Step 3 — in parallel with Codex, launch the Opus reviewer (Agent)
A single `Agent` (general-purpose, fresh context) with a prompt that combines the four lane briefs plus the cross-correlate instruction:
> Read all four lane prompts in `docs/phase6/6-1c-prep/lane-{a,b,c,d}-*.md`. Verify their claims independently at source. Produce a findings list as if you were a 5th independent auditor (severity-tagged, `file:line` anchors). Be skeptical; don't anchor on what Codex would find.

Run it `run_in_background: true` so it overlaps with Codex.

### Step 4 — read every output IN FULL (no early skim)
- Codex writes findings asynchronously after shell-exit; the file may be partial mid-run. Wait for the completion notification THEN read. **Re-read** if the tail looks abruptly cut — memory `codex_exec_async_output.md` documents this.
- The five outputs may converge OR conflict on the same finding. Both signals are useful; cross-correlate.

### Step 5 — synthesize
- Cross-correlate findings: same `file:line` mentioned by ≥2 lanes is a strong signal; lane-unique is weaker.
- For each finding, classify: HIGH (block 6.1C exit), MED (block unless filed with rationale), LOW (file + fix opportunistically), INFO (note).
- Cross-check each finding against the seed inputs in `../6-1c-entry-plan.md` §3 — every seed input must be closed or formally filed.
- **Decision: `Session` over-napi surface cut-line** (entry plan §3 item 6). Document which methods land at 6.1 vs 6.3.

### Step 6 — write the synthesis doc
Path: `docs/audits/2026-05-2X-6-1c-megaudit/SYNTHESIS.md` (use the actual run date). Structure:
1. Scope + lanes run.
2. Findings table (severity, lane, anchor, disposition).
3. Seed-input dispositions (one row per item in entry plan §3).
4. The over-napi cut-line decision.
5. Verdict: SHIP / REVISE / SHIP-WITH-FIXES.
6. Exit-packet seed (the 1-line summary that feeds `docs/phase6/exit-packet.md`).

### Step 7 — implement HIGH/MED fixes (separate commit)
If REVISE or SHIP-WITH-FIXES: a single audit-fix commit on `feat/quantbook-engine`. Then re-verify the affected lanes (focused, not the full megaudit).

### Step 8 — doc-sync (separate commit)
- Update `docs/api/workbook-session-impl-plan.md` §0 (6.1C exit).
- Update `docs/MASTER-PLAN.md` (the 6.1C entry; NEXT = 6.4-0).
- Update `.plans/_active.md` (status; NEXT).
- Update `memory/current_work.md` + `MEMORY.md`.

## Discipline checklist
- ≤2 plan-implement-audit cycles per session. The megaudit IS 1 cycle; any audit-fix is the 2nd.
- Mac bridge for cargo/git: `mac zsh -lc '...$HOME/.cargo/bin/cargo ...'`. `rg` not installed (grep). Linux `pgrep`/wait-loops can't see Mac-host procs — use background-task completion notifications.
- Commit-msg-file + `git commit -F`; NEVER `--no-verify`.
- Stage explicit files; verify `git show HEAD:<path> | wc -l == wc -l < <path>`.
- Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>.
- Pre-existing untracked artifacts in the engine worktree: do NOT stage. The pre-existing `.plans/_archive/2026-05-24…` mod is NOT yours; do NOT stage.

## Exit-readiness signals
- All 4 Codex lanes produced findings (each `.out` non-empty + ends in a verdict).
- Opus reviewer produced findings independently.
- Synthesis doc exists + is doc-synced.
- Every seed input has a disposition.
- The over-napi cut-line decision is documented.
- The exit-packet seed line is written.

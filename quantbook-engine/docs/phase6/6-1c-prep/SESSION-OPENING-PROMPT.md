# Fresh-session opening prompt — Phase 6.1C megaudit

Paste this into a fresh Claude Code session (Opus 4.7 1M; `/fast` optional). It assumes a clean context and contains everything needed to launch.

---

Take over **Phase 6.1C — Security/Design Audit**. This is decision-lock §2 item 4 (MANDATORY before broader binding/service exposure). It's a 5-way parallel megaudit: 4 Codex lanes + 1 Opus reviewer + an Opus synthesis pass. Produces the **Phase-6 exit-packet** audit artifact.

Engine worktree: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine` (branch `feat/quantbook-engine`).
IDE repo (cross-ref): `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab` (branch `feat/visualise-v1`).

## Step 1 — orient (read these in this order)

1. **`memory/current_work.md` + `MEMORY.md`** — the handoff. Confirm: 6.1B IDE-side Node `Session` migration SHIPPED 2026-05-28 (cross-repo IDE `c24222315ed`; engine doc-sync `fbef9d8be1f`); next = 6.1C.
2. **`docs/phase6/decision-lock.md`** §2 item 4 (the mandate) + §3 (what 6.1 must lock) + §4 (graph-invalidation contract).
3. **`docs/phase6/6-1c-entry-plan.md`** — the canonical scope, the 10 seed inputs, the lane map.
4. **`docs/phase6/6-1c-prep/README.md`** — the orchestration index.
5. **`docs/audits/2026-05-28-6-1b-ide-node-migration/SYNTHESIS.md`** — the prior audit whose tracked findings feed THIS one.

## Step 2 — confirm git state

```sh
mac zsh -lc 'cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && git log --oneline -3'
```
Expect: `fbef9d8be1f` (6.1B IDE-migration doc-sync) ← `0b7ed1c6072` ← `2d22f1f82e2` (last code).

```sh
mac zsh -lc 'cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab && git log --oneline -2'
```
Expect IDE: `c24222315ed` (IDE-migration) ← `d028568b53b`.

## Step 3 — launch in one turn (parallelize)

In a single Claude turn, issue **5 tool calls in parallel**:

- 4× `Bash run_in_background: true` for the Codex lanes:
  ```sh
  mac zsh -lc 'cd /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine && codex exec -s read-only "$(cat docs/phase6/6-1c-prep/lane-a-ffi-panic.md)" > docs/phase6/6-1c-prep/lane-a.out 2>&1; echo LANE_A_EXIT=$?'
  ```
  (repeat for `lane-b-lifecycle.md` → `lane-b.out`, `lane-c-dto-determinism.md` → `lane-c.out`, `lane-d-persistence-io.md` → `lane-d.out`).
- 1× `Agent` (general-purpose, `run_in_background: true`) for the **Opus reviewer**. Prompt:
  > READ-ONLY. You are the 5th independent lane of a 5-way 6.1C megaudit of the `WorkbookSession` + `Session` napi binding at `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine`. Read `docs/phase6/6-1c-entry-plan.md` + each of `docs/phase6/6-1c-prep/lane-{a,b,c,d}-*.md` to understand scope. Then audit independently — verify every claim at source, find what Codex might miss (cross-cutting issues, weak rationalizations, untested invariants). Be skeptical. Report findings as HIGH/MED/LOW/INFO with `file:line` anchors and a SHIP/REVISE verdict. `rg` not installed; git via `mac zsh -lc 'cd <repo> && git ...'`. Do NOT edit.

All 5 run concurrently. **Patience: 3–10 min each.** Do not poll Linux `pgrep` (Mac-host procs invisible) — wait on background-task completion notifications.

## Step 4 — read every output in FULL

Codex writes findings asynchronously after shell-exit (see memory `codex_exec_async_output.md`). After each completion notification, **wait + re-read** if the tail looks abrupt. Do NOT skim or summarize before the file is complete.

## Step 5 — synthesize

- Cross-correlate findings across the 5 lanes. Same `file:line` mentioned by ≥2 lanes = strong signal.
- Classify HIGH/MED/LOW/INFO. Verify every HIGH/MED at source independently before agreeing with it.
- Walk the **10 seed inputs** in `6-1c-entry-plan.md` §3 — every one must close or be formally filed with rationale.
- Make the **over-napi cut-line decision**: does `Session` need `workbookSnapshotDelta` / `undo` / `import` / `export` / `open` / `save` / `batch` / `register_function` / etc. over napi at 6.1 exit, or are those formally 6.3?
- Write the synthesis at `docs/audits/2026-05-2X-6-1c-megaudit/SYNTHESIS.md` (real run date). Structure per `6-1c-prep/README.md` Step 6.
- Verdict: SHIP / REVISE / SHIP-WITH-FIXES.

## Step 6 — fixes (if REVISE / SHIP-WITH-FIXES)

Implement HIGH/MED fixes in a single audit-fix commit on `feat/quantbook-engine`. Re-verify the affected lanes (focused, NOT the full megaudit). Then proceed to doc-sync.

## Step 7 — doc-sync (separate commit)

Update `docs/api/workbook-session-impl-plan.md` §0, `docs/MASTER-PLAN.md`, `.plans/_active.md`, `memory/current_work.md`, `MEMORY.md`. NEXT = **6.4-0 function-metadata substrate** (decision-lock §2 item 5).

## Discipline

- ≤2 plan-implement-audit cycles per session.
- Mac bridge for everything (`mac zsh -lc '...'`). `rg` not installed. Linux `pgrep`/wait-loops invisible to Mac procs.
- `git commit -F <msgfile>`; NEVER `--no-verify`.
- Stage explicit files; verify blob == tree wc -l.
- Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>.
- Pre-existing untracked artifacts (`.codex-*`, `.plans/_archive/*`, `2026-*-this-session-is-being-continued*.txt`, `node_modules/` etc.) + the pre-existing `.plans/_archive/2026-05-24` mod: do NOT stage.

Begin.

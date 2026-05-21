Reading prompt from stdin...
OpenAI Codex v0.130.0
--------
workdir: /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
model: gpt-5.5
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /Users/sanzhar/.codex/memories]
reasoning effort: xhigh
reasoning summaries: none
session id: 019e4965-1148-7fa1-9e7a-b6ab11db7c20
--------
user
# Phase 5.5 V2 V3 step 2 audit — `poll_remote` auto-flush wiring

## Context

Working dir: `/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook` (engine worktree on `feat/quantbook-engine`).

**Audit target**: HEAD `e4e1ce282b1` (V2 V3 step 2 ship). Predecessor: `e5ff11d549a` (V2 V3 step 1 audit-closure).

**Workspace tests at ship**: 4401 / 0 with `--test-threads=1` (+3 net from 4398). fmt + clippy clean.

**Plan**: `quantbook-engine/.plans/_active.md` (status: in-progress; archive at audit closure).

## What shipped

Step 2 of V2 V3 — wires `poll_remote*` into auto-flush. Closes V2 V2 audit M1 (Codex+Opus convergent: "receive-side excluded by design") now that V2 V3 step 1's idempotency guard prevents echo loops.

### Code change (in `crates/ql-collab/src/session.rs`)

`poll_remote_with_limit` adds an auto-flush call after the drain loop, gated on `merged > 0`:

```rust
if merged > 0 {
    self.maybe_auto_flush()?;
}
Ok(merged)
```

One flush per call (not per-blob). Skip-when-zero guard avoids wasted VV-clone+compare when inbox was empty.

### Test changes (3 new + 1 inverted)

1. **Inverted**: `poll_remote_does_not_trigger_auto_flush_by_design` → `poll_remote_triggers_auto_flush_under_on_append`. Now asserts the OPPOSITE: under OnAppend, drain → auto-flush back through paired transport.
2. NEW `poll_remote_idempotent_merge_short_circuits_no_wire_send` — A flushes; B sends A's own state; A polls; idempotency guard short-circuits; observer's pending_recv stays 0.
3. NEW `poll_remote_empty_drain_does_not_attempt_flush` — empty inbox, no flush attempt.
4. NEW `poll_remote_with_closed_transport_returns_zero_no_flush` — closed transport + empty inbox → Ok(0) with no flush attempt.

### Doc surfaces updated (6)

- `AutoFlushPolicy::OnAppend` docstring + `poll_remote*` docstrings.
- `crates/ql-collab/src/transport.rs` module-doc.
- `docs/architecture/ide-consumer-contract.md`.
- `docs/MASTER-PLAN.md` § 5.5.
- `docs/phase5/v1-exit-packet.md`.
- `docs/phase5/entry-plan.md` table row.

## Files to focus your audit on

* `crates/ql-collab/src/session.rs` lines ~885-970 (poll_remote + poll_remote_with_limit + the new auto-flush call).
* `crates/ql-collab/src/session.rs` lines ~190-280 (AutoFlushPolicy::OnAppend docstring with updated step 2 section).
* `crates/ql-collab/tests/auto_flush.rs` last ~150 lines (3 new tests + 1 inverted).
* `crates/ql-collab/src/transport.rs` module-doc.
* `docs/architecture/ide-consumer-contract.md` (the auto-flush + receive-side bullet).

## Specific audit dimensions

### 1. Did I miss any other paths that should auto-flush?

`poll_remote_with_limit` is the new wire. Are there any OTHER methods on `CollabSession` that mutate `self.log` and don't fire `maybe_auto_flush`? Quick grep:
- `append_op` ✓ (V2 V2)
- `merge_bytes` ✓ (V2 V2)
- `update_presence` / `clear_presence` / `sweep_presence` ✓ (V2 V2)
- `undo` / `redo` ✓ (V2 V2; consumed-gated)
- `poll_remote_with_limit` ✓ (V2 V3 step 2 — this ship)

Constructors (`new`, `from_snapshot`) don't fire — correct (no transport attached yet).

`set_peer_id` on the inner OpLog — but CollabSession doesn't expose this directly; the wrapper is in constructors.

Anything else?

### 2. Echo-loop safety under various policy combinations

Test the 4 quadrants of peer A × peer B × {Disabled, OnAppend}:
- (A Disabled, B Disabled): V2 V1 explicit-drive. No echoes possible.
- (A OnAppend, B Disabled): A flushes, B receives via poll (no auto-flush since Disabled). One-way wire.
- (A Disabled, B OnAppend): same shape, mirrored.
- (A OnAppend, B OnAppend): SYMMETRIC. A appends → A flush → B poll (auto-flush back) → A poll (auto-flush back) → ... Loro dedupes; V2 V3 step 1 idempotency guard short-circuits when VV unchanged.

For the symmetric case, the existing `symmetric_on_append_two_peers_converge_with_bounded_wire_bytes` test (V2 V3 step 1 closure) already exercises the loop bound. After V2 V3 step 2, that test should pass with FEWER explicit-flush calls needed (since `poll_remote` auto-flushes). Does that test still pass? (Verified — workspace gates passed WS=4401.) But: the test still calls `flush_delta_to_transport` explicitly after each poll. Now that poll auto-flushes, those calls are redundant. Worth a docstring/test update?

### 3. Self-loopback via paired transport

When peer B sends to A's inbox, A polls + merges + auto-flushes back to the SAME paired transport. The bytes land in B's inbox. If B is OnAppend and B then polls its own inbox, B sees A's snapshot (which contains B's original ops). Loro dedupes; B's VV doesn't advance; idempotency short-circuits. Verified by the `poll_remote_idempotent_merge_short_circuits_no_wire_send` test pattern, which simulates exactly this.

Is the "auto-flush back to same paired transport" pattern wasteful even with idempotency? In a real 3-peer hub topology where the hub has ONE attached transport but routes to multiple peers via the transport's internal multiplexing, sending back to the same transport endpoint means the SENDING peer receives an echo of its own bytes (Loro-deduped). Bandwidth waste; not a correctness bug. Documented as V1 limit.

### 4. Test that the V2 V3 step 1 `symmetric_on_append_*` test still works as intended

That test does:
```
peer_a.poll_remote(); peer_b.poll_remote();
peer_a.flush_delta_to_transport(); peer_b.flush_delta_to_transport();
```

After V2 V3 step 2, the explicit `flush_delta_to_transport()` calls are no-ops (auto-flush already fired during poll_remote). Both calls return Ok(false). The test's loop convergence check still passes because the round-trip terminates eventually.

But the test's semantic claim ("symmetric OnAppend over paired transport converges") is now PROVED by the auto-flush path itself, not by the explicit follow-up flushes. Worth updating the test docstring to reflect this?

### 5. Error path: what if auto-flush after poll fails?

The new code:
```rust
if merged > 0 {
    self.maybe_auto_flush()?;  // ← propagates Err
}
Ok(merged)
```

If `maybe_auto_flush()` fails, the method returns `Err(CollabSessionError::Transport(_))` and the caller never sees `Ok(merged)`. Local log has the merged ops. Partial-state contract.

Edge case: a transport that succeeds for `try_recv` (drain) but errors on `send` (flush). Possible? Real WebSocket impls could exhibit half-open behavior. The existing `OneShotFailingTransport` in V2 V3 step 1 closure fails on send only — but it returns Err on the FIRST send, then succeeds. Doesn't quite test the "drain ok, send Err" scenario directly. Could add a test.

### 6. Skip-when-zero is correct?

`if merged > 0` — if drain returned 0 blobs (empty inbox), don't attempt flush. Rationale: state didn't change locally; idempotency would short-circuit anyway. Saves VV-clone+compare.

But: what if `current_vv != last_flushed_vv` BEFORE the poll for some reason (e.g., a prior failed flush left the VV stale)? Then the local state has un-flushed ops, but `poll_remote` sees 0 inbound blobs, and the skip-zero guard prevents a flush of the un-flushed local state.

This is actually correct behavior for `poll_remote` — its job is to drain inbound, not to retry outbound flushes. Callers needing to retry an outbound flush should use explicit `flush_delta_to_transport`. Worth a docstring note.

### 7. Docstring claims to verify

- "ONE flush per call (not per-blob)" — verified by code shape (call AFTER the loop).
- "Bandwidth-efficient" — yes; N drained blobs = 1 outbound flush.
- "Idempotency guard prevents echo loops" — Codex already verified Loro VV equality in step 1 audit. Confirm V2 V3 step 2 doesn't break this.
- "Skip-when-zero defensive optimization" — verified by code.
- "Partial-state on flush Err" — verified by `?` propagation pattern.

### 8. Any regressions in existing V2 V2 / V2 V3 step 1 tests?

The workspace gate (WS=4401) confirms no regressions. But adversarial: any tests that ASSUMED `poll_remote` doesn't auto-flush (other than the one that was inverted)? Spot-check by searching for `poll_remote` in `crates/ql-collab/tests/`.

## Output

**VERDICT: PASS / PASS-WITH-FINDINGS / FAIL**

Bucketed findings (HIGH / MEDIUM / LOW) with file:line evidence. Don't paraphrase code; quote it.

## Note

Don't run cargo test — gates already verified at WS=4401.

Audit transcript will be saved to `quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v3-step-2-codex.md`.

codex
I’ll audit this as a code review against the stated HEAD, focusing on the auto-flush call path, tests, and docs without running the test suite. I’ll first verify the relevant diff and then inspect the surrounding call sites for other log mutations.
exec
/bin/zsh -lc 'git rev-parse --short=11 HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
e4e1ce282b1

exec
/bin/zsh -lc 'git diff --stat e5ff11d549a..HEAD -- crates/ql-collab/src/session.rs crates/ql-collab/tests/auto_flush.rs crates/ql-collab/src/transport.rs docs/architecture/ide-consumer-contract.md docs/MASTER-PLAN.md docs/phase5/v1-exit-packet.md docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
exec
/bin/zsh -lc 'git status --short' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 907ms:
?? .codex-phase-5-5-v2-v3-step-2-audit-prompt.md
?? .codex-phase-5-5-v2-v3-step-2-audit.out
?? 2026-05-11-222312-this-session-is-being-continued-from-a-previous-c.txt
?? 2026-05-13-003338-this-session-is-being-continued-from-a-previous-c.txt
?? node_modules
?? quantbook-engine/.codex/prompts/2026-05-14-AA-design-review.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-127-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-128-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-129-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-132-133followup-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-HIGH3-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-LOW-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-MEDIUM4-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-J-megaudit-MEDIUM5-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-K-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-L-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-M-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-N-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-O-closure-verify.md
?? quantbook-engine/.codex/prompts/2026-05-14-O-megaudit.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.I-review.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.J-megaudit-pass2.md
?? quantbook-engine/.codex/prompts/2026-05-14-phase-4.7.J-review.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-closing-megaudit.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-closure-verify.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.8-final-reverify.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.9-design-review.md
?? quantbook-engine/.codex/prompts/2026-05-15-phase-4.9-mid-arc-audit.md
?? quantbook-engine/.plans/_active.md
?? quantbook-engine/.plans/_archive/2026-05-13_w5-77-phase-4.5d-format-parser.md
?? quantbook-engine/.plans/_archive/2026-05-13_w5-78-phase-4.5d-renderer.md
?? quantbook-engine/.plans/_archive/2026-05-14_w5-121-phase-4.8.i.2-rename-column.md
?? quantbook-engine/.plans/_archive/2026-05-14_w5-122-phase-4.8.j-resize-table.md
?? quantbook-engine/.plans/_archive/2026-05-14_w5-123-phase-4.8.l-persistence-v6.md
?? quantbook-engine/.plans/_archive/2026-05-15_phase-4.8.O-findings.md
?? quantbook-engine/.plans/_archive/2026-05-17_phase-4-10-v1-260-closeout.md
?? quantbook-engine/.plans/_archive/2026-05-17_rt-v1-01-reference-tier-mini-phase.md
?? quantbook-engine/.plans/_archive/2026-05-18_phase-4-11-xlsx-import-export.md
?? quantbook-engine/.plans/_archive/2026-05-18_tier-a-api-stability.md
?? quantbook-engine/.plans/_archive/2026-05-21_phase-5-5-v2-v2-auto-flush.md
?? quantbook-engine/.plans/_archive/2026-05-21_phase-5-5-v2-v3-step-1-version-vector.md
?? quantbook-engine/2026-05-14-222539-this-session-is-being-continued-from-a-previous-c.txt
?? quantbook-engine/2026-05-16-175547-this-session-is-being-continued-from-a-previous-c.txt

codex
HEAD matches `e4e1ce282b1`. The worktree has unrelated untracked files, so I’m treating the audited commit as immutable and using commit/diff reads only.
exec
/bin/zsh -lc 'git diff --stat e5ff11d549a..HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
 quantbook-engine/crates/ql-collab/src/session.rs   | 108 ++++++++-----
 quantbook-engine/crates/ql-collab/src/transport.rs |  41 ++---
 .../crates/ql-collab/tests/auto_flush.rs           | 174 +++++++++++++++------
 quantbook-engine/docs/MASTER-PLAN.md               |   7 +-
 .../docs/architecture/ide-consumer-contract.md     |   2 +-
 quantbook-engine/docs/phase5/entry-plan.md         |   2 +-
 quantbook-engine/docs/phase5/v1-exit-packet.md     |  41 +++--
 7 files changed, 252 insertions(+), 123 deletions(-)

exec
/bin/zsh -lc 'git diff --name-only e5ff11d549a..HEAD' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/src/session.rs
quantbook-engine/crates/ql-collab/src/transport.rs
quantbook-engine/crates/ql-collab/tests/auto_flush.rs
quantbook-engine/docs/MASTER-PLAN.md
quantbook-engine/docs/architecture/ide-consumer-contract.md
quantbook-engine/docs/phase5/entry-plan.md
quantbook-engine/docs/phase5/v1-exit-packet.md

exec
/bin/zsh -lc "rg --files -g 'session.rs' -g 'auto_flush.rs' -g 'transport.rs' -g 'ide-consumer-contract.md' -g 'MASTER-PLAN.md' -g 'v1-exit-packet.md' -g 'entry-plan.md'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/MASTER-PLAN.md
quantbook-engine/docs/architecture/ide-consumer-contract.md
quantbook-engine/docs/phase5/v1-exit-packet.md
quantbook-engine/docs/phase5/entry-plan.md
quantbook-engine/docs/phase2/entry-plan.md
quantbook-engine/crates/ql-collab/src/transport.rs
quantbook-engine/crates/ql-collab/src/session.rs
quantbook-engine/crates/ql-collab/tests/auto_flush.rs

codex
The changed paths are under `quantbook-engine/`, which explains the earlier path-filter miss. I’m reading the implementation, focused tests, and documentation with line numbers now so the final review can cite exact evidence.
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '180,290p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '840,990p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   180	/// [`CollabSession`]. Determines when (if ever) the session pushes
   181	/// its current snapshot through the attached transport without an
   182	/// explicit [`CollabSession::flush_to_transport`] call.
   183	///
   184	/// V2 V2 (this ship) adds two variants. V2 V3 will add a `Threshold`
   185	/// variant for byte-budget-based batching.
   186	///
   187	/// `#[non_exhaustive]` so adding a `Threshold(usize)` variant later
   188	/// is non-breaking — callers MUST handle the `_` arm in `match`.
   189	#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
   190	#[non_exhaustive]
   191	pub enum AutoFlushPolicy {
   192	    /// Default. V2 V1 behavior preserved: caller drives flush + poll
   193	    /// explicitly via [`CollabSession::flush_to_transport`] +
   194	    /// [`CollabSession::poll_remote`]. Auto-flush never fires.
   195	    #[default]
   196	    Disabled,
   197	    /// Flush automatically after every public method that mutates the
   198	    /// underlying `LoroDoc`. Triggers on: `append_op`, `merge_bytes`,
   199	    /// `update_presence`, `clear_presence`, `sweep_presence`,
   200	    /// `undo`, `redo`, `poll_remote`, `poll_remote_with_limit`.
   201	    ///
   202	    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** auto-flush routes
   203	    /// through [`flush_delta_to_transport`] (delta path) rather than
   204	    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
   205	    /// O(per-op delta) instead of O(full state). The idempotency
   206	    /// short-circuit means a flush after no state change is a true
   207	    /// no-op (no transport.send invocation) — this closes the V2 V2
   208	    /// audit echo-loop class.
   209	    ///
   210	    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** `poll_remote*` now
   211	    /// triggers auto-flush AFTER the drain batch (one flush per
   212	    /// call, not per-blob) — bandwidth-efficient. Reverses the V2 V2
   213	    /// "receive-side excluded by design" exclusion now that V2 V3
   214	    /// step 1's idempotency guard prevents echo loops at the source
   215	    /// (Loro-deduped merge leaves VV unchanged → flush short-circuits
   216	    /// to `Ok(false)`). The 3-peer hub-fanout pattern now works
   217	    /// automatically.
   218	    ///
   219	    /// Does NOT trigger on:
   220	    /// - Accessor methods (read-only).
   221	    /// - Undo-group boundary methods (`start_undo_group` /
   222	    ///   `end_undo_group`) — only their inner appends fire, via
   223	    ///   `append_op`. Each mid-group append produces ONE auto-flush;
   224	    ///   the group is a LOCAL undo unit only (peers see each append
   225	    ///   land independently). Phase 5.5 V2 V2 audit closure (Opus
   226	    ///   L1) — undo-group atomicity-over-wire deferred to V2 V3.
   227	    /// - Transport-lifecycle methods (`attach_transport` etc.).
   228	    ///
   229	    /// If no transport is attached, this is silently a no-op (the
   230	    /// flush hook checks `self.transport.is_some()` first).
   231	    ///
   232	    /// **Partial-state contract on auto-flush error**: if the auto-
   233	    /// flush attempt fails (transport closed, I/O error), the
   234	    /// surrounding mutator (`append_op` etc.) returns
   235	    /// `Err(CollabSessionError::Transport(_))`. The local mutation
   236	    /// has ALREADY been committed to `self.log` (mutate-then-flush
   237	    /// ordering — Loro doesn't support "ungrowing" an op log, V1
   238	    /// limitation H7). Callers MUST treat their local state as
   239	    /// authoritative for the local UI and either retry the flush
   240	    /// (transport recovered) or detach the transport.
   241	    ///
   242	    /// **Symmetric-OnAppend (Phase 5.5 V2 V3 step 1 closure,
   243	    /// 2026-05-21):** enabling `OnAppend` on BOTH peers of a paired
   244	    /// transport is safe via the V2 V3 idempotency guard. The
   245	    /// guard short-circuits `flush_delta_to_transport` when no ops
   246	    /// have been appended since the last successful flush. A
   247	    /// merged peer-snapshot that didn't actually advance local
   248	    /// state (Loro CRDT dedupe) leaves the VV unchanged, so the
   249	    /// subsequent auto-flush is a no-op send. The original V2 V2
   250	    /// echo-loop concern is closed at the source. With V2 V3 step 2,
   251	    /// `poll_remote` also auto-flushes — the round-trip back to the
   252	    /// SAME paired transport hits the idempotency guard if the
   253	    /// drained bytes were duplicates, otherwise sends the delta
   254	    /// (peer's Loro dedupes any ops it already has).
   255	    ///
   256	    /// **V1 limit (V2 V3 step 2)**: auto-flush from `poll_remote`
   257	    /// goes back to the SAME transport the bytes came from. In a
   258	    /// true multi-transport hub topology, the merged state would
   259	    /// only fan to ONE transport per session. V2 V3 step 4
   260	    /// (WebSocket + multi-transport routing) may add per-transport
   261	    /// fanout.
   262	    OnAppend,
   263	}
   264	
   265	/// Per-peer collaboration state holder.
   266	///
   267	/// Owns an `OpLog` + a stable `PeerId`. Tested with `NoopTransport`
   268	/// at scaffold time; Phase 5.5 will add the live transport
   269	/// integration via `Transport::send` / `try_recv`.
   270	///
   271	/// The session is the engine-side handle for one peer's view of a
   272	/// shared workbook. Multiple peers each hold their own
   273	/// `CollabSession`, exchange byte blobs via [`crate::Transport`],
   274	/// and call `merge_bytes` to incorporate remote ops. All sessions
   275	/// converge to the same `OpLog` content after exchange (per Loro's
   276	/// CRDT determinism — Phase 5.1 audit Codex V1).
   277	pub struct CollabSession {
   278	    peer_id: PeerId,
   279	    log: OpLog,
   280	    /// Phase 5.4 V1 — peer-local undo/redo.
   281	    ///
   282	    /// Drop-order note (Codex 5.4 V1 audit LOW): Rust drops fields
   283	    /// in DECLARATION order, so this drops LAST (after `log`).
   284	    /// That is safe here because `loro::UndoManager` owns its own
   285	    /// `LoroDoc` clone (`loro-internal::undo:166,670`) — it doesn't
   286	    /// borrow from `log`'s doc and won't UAF when `log` drops first.
   287	    undo: loro::UndoManager,
   288	    /// **Phase 5.5 V2 V1 (2026-05-19):** optional attached
   289	    /// transport. `None` until `attach_transport` is called.
   290	    /// Boxed + `Send` so callers can move sessions between

 succeeded in 0ms:
   840	        };
   841	        // Now borrow transport mutably for the send. Done in two
   842	        // phases because we needed self.log (immut) above and need
   843	        // self.transport (mut) here — borrow-checker dance.
   844	        let transport = self.transport.as_mut().expect("just-checked is_some above");
   845	        transport.send(&bytes)?;
   846	        // Advance the VV checkpoint. Only on success — Err leaves
   847	        // last_flushed_vv at its prior value so retry sends the
   848	        // same delta.
   849	        self.last_flushed_vv = Some(current_vv);
   850	        Ok(true)
   851	    }
   852	
   853	    /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** drain
   854	    /// the attached transport's recv queue up to a default cap
   855	    /// (`DEFAULT_POLL_REMOTE_LIMIT = 64` blobs), merging each
   856	    /// blob into the local `OpLog`. Returns the number of blobs
   857	    /// merged.
   858	    ///
   859	    /// For unbounded drain (or a different cap), use
   860	    /// [`poll_remote_with_limit`]. The cap prevents one
   861	    /// `poll_remote` call from starving the calling thread when
   862	    /// a future externally-fed transport is producing faster
   863	    /// than we drain.
   864	    ///
   865	    /// Returns `Ok(0)` if no transport attached.
   866	    /// `TransportError::Closed` is handled gracefully — the
   867	    /// trait contract guarantees Closed only after the queue
   868	    /// drains, so the merge count reflects all queued blobs and
   869	    /// the function returns `Ok(merged)`. `Io` errors propagate
   870	    /// as `CollabSessionError::Transport` — any merges before
   871	    /// the error already persist in the local `OpLog`.
   872	    ///
   873	    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** triggers ONE
   874	    /// auto-flush after the drain batch (not per-blob), routed
   875	    /// through [`flush_delta_to_transport`] when
   876	    /// [`auto_flush_policy`] is `OnAppend` AND at least one blob
   877	    /// was actually drained. V2 V3 step 1's idempotency short-
   878	    /// circuit handles the Loro-deduped (no-op) merge case: if
   879	    /// the drained bytes contained only ops already known
   880	    /// locally, the post-merge VV doesn't advance and the
   881	    /// auto-flush returns `Ok(false)` without invoking
   882	    /// `transport.send`.
   883	    ///
   884	    /// V2 V2 audit (Codex M1 + Opus M1) flagged the prior
   885	    /// exclusion of `poll_remote*` from auto-flush. V2 V3 step 1's
   886	    /// version-vector idempotency guard makes wiring it in safe
   887	    /// (no echo loop), and V2 V3 step 2 (this) reverses the
   888	    /// exclusion. The 3-peer fanout pattern (hub drains peer B's
   889	    /// blob → hub auto-flushes merged state onward) now works
   890	    /// automatically under `OnAppend`.
   891	    pub fn poll_remote(&mut self) -> Result<usize, CollabSessionError> {
   892	        self.poll_remote_with_limit(DEFAULT_POLL_REMOTE_LIMIT)
   893	    }
   894	
   895	    /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** like
   896	    /// [`poll_remote`] but with an explicit per-call cap on the
   897	    /// number of blobs to drain.
   898	    ///
   899	    /// `max_blobs == 0` is a no-op (returns `Ok(0)` even if
   900	    /// blobs are queued — call again with a non-zero cap).
   901	    ///
   902	    /// Returns `Ok(merged)` where `merged <= max_blobs`. If the
   903	    /// returned count equals `max_blobs`, more blobs may still
   904	    /// be queued — call again. If less, the queue drained
   905	    /// (either empty or transport reported `Closed`).
   906	    ///
   907	    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** when at least one
   908	    /// blob was drained AND [`auto_flush_policy`] is `OnAppend`,
   909	    /// fires ONE auto-flush after the loop (per-batch, not
   910	    /// per-blob — bandwidth efficient). Routed through
   911	    /// [`flush_delta_to_transport`]; V2 V3 step 1's idempotency
   912	    /// guard short-circuits when the post-merge VV equals the
   913	    /// pre-poll `last_flushed_vv` (i.e., the drained blobs only
   914	    /// contained ops already known locally — Loro-deduped merge).
   915	    ///
   916	    /// **Partial-state contract on auto-flush failure**: if the
   917	    /// post-batch auto-flush fails (closed transport, I/O error
   918	    /// during the send), the method returns
   919	    /// `Err(CollabSessionError::Transport(_))` AFTER all `merged`
   920	    /// blobs have been committed to `self.log`. The caller never
   921	    /// sees `Ok(merged)` in this case; inspect `op_count()` to
   922	    /// determine how many merges actually committed locally.
   923	    /// `last_flushed_vv` is NOT advanced on flush Err — a retry
   924	    /// (e.g., manual [`flush_delta_to_transport`] after detaching
   925	    /// and reattaching a working transport) sends the same delta the
   926	    /// failed call would have.
   927	    pub fn poll_remote_with_limit(
   928	        &mut self,
   929	        max_blobs: usize,
   930	    ) -> Result<usize, CollabSessionError> {
   931	        let Some(transport) = self.transport.as_mut() else {
   932	            return Ok(0);
   933	        };
   934	        let mut merged = 0usize;
   935	        while merged < max_blobs {
   936	            match transport.try_recv() {
   937	                Ok(Some(bytes)) => {
   938	                    self.log.merge_bytes(&bytes)?;
   939	                    merged += 1;
   940	                }
   941	                Ok(None) => break,
   942	                Err(TransportError::Closed) => {
   943	                    // Trait contract: Closed only after queue drains. Any
   944	                    // already-drained bytes are accounted in `merged`.
   945	                    // Treat as graceful end-of-stream.
   946	                    break;
   947	                }
   948	                Err(other) => return Err(CollabSessionError::Transport(other)),
   949	            }
   950	        }
   951	        // **Phase 5.5 V2 V3 step 2 (2026-05-21):** auto-flush after
   952	        // the drain batch. ONE flush per call (not per-blob) —
   953	        // bandwidth-efficient. V2 V3 step 1's idempotency guard at
   954	        // `flush_delta_to_transport` returns Ok(false) without
   955	        // invoking transport.send when no state advanced (Loro-
   956	        // deduped merge). Skip when 0 blobs drained: state didn't
   957	        // change locally, no point firing the VV-clone+compare
   958	        // path (defensive optimization).
   959	        if merged > 0 {
   960	            self.maybe_auto_flush()?;
   961	        }
   962	        Ok(merged)
   963	    }
   964	
   965	    /// **Phase 5.6 V1 (2026-05-19):** write this session's own
   966	    /// presence state into the shared `"presence"` LoroMap.
   967	    ///
   968	    /// Uses the session's `PeerId` as the map key (16-hex
   969	    /// `Display` form). Subsequent calls overwrite the previous
   970	    /// value (LWW per peer); merges with other peers'
   971	    /// presence writes preserve all distinct peers.
   972	    ///
   973	    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
   974	    /// [`auto_flush_policy`]. Partial-state contract on flush
   975	    /// failure: the presence write is already committed to
   976	    /// `self.log` when the auto-flush attempt runs — same shape
   977	    /// as `append_op` (see [`AutoFlushPolicy::OnAppend`]).
   978	    pub fn update_presence(&mut self, state: PresenceState) -> Result<(), CollabSessionError> {
   979	        let key = presence::peer_key(self.peer_id);
   980	        let json = serde_json::to_string(&state).map_err(PresenceError::Serialize)?;
   981	        self.log.presence_set(&key, &json)?;
   982	        self.maybe_auto_flush()?;
   983	        Ok(())
   984	    }
   985	
   986	    /// **Phase 5.6 V1 (2026-05-19):** read a peer's most recent
   987	    /// presence state. Returns `Ok(None)` if the peer has never
   988	    /// updated its presence in this session (or has been removed
   989	    /// via `clear_presence`).
   990	    pub fn peer_presence(&self, peer: PeerId) -> Result<Option<PresenceState>, CollabSessionError> {

exec
/bin/zsh -lc 'nl -ba quantbook-engine/crates/ql-collab/tests/auto_flush.rs | tail -n 220' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/transport.rs | sed -n '1,140p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! `Transport` trait — wire-byte channel for Phase 5 collaboration.
     2	//!
     3	//! **Phase 5.2.a (2026-05-19, scaffold):** trait shape defined.
     4	//! **Phase 5.5 V1 (2026-05-19, `924750819bc`):** `LoopbackTransport`
     5	//! shipped — in-process paired endpoints for 2-peer tests.
     6	//! **Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05` + audit closure):**
     7	//! `CollabSession` exposes 5 typed transport methods
     8	//! (`attach_transport` / `detach_transport` / `has_transport` /
     9	//! `flush_to_transport` / `poll_remote` (+ `poll_remote_with_limit`)).
    10	//! V2 V1 is "explicit drive" — caller invokes flush + poll on a
    11	//! tick.
    12	//! **Phase 5.5 V2 V2 (2026-05-21):** `AutoFlushPolicy` enum on
    13	//! `CollabSession`. Opt-in `OnAppend` invokes flush automatically
    14	//! after every mutator. Default is `Disabled` (V2 V1 behavior
    15	//! preserved). See [`crate::AutoFlushPolicy`] +
    16	//! [`crate::CollabSession::set_auto_flush_policy`].
    17	//! **Phase 5.5 V2 V3 step 1 (2026-05-21):** version-vector tracking
    18	//! for the **currently attached** transport baseline + delta flushes.
    19	//! `CollabSession::flush_delta_to_transport` sends only the delta
    20	//! since the last successful flush via `LoroDoc::ExportMode::Updates`.
    21	//! Auto-flush routes through this delta path — wire payload is
    22	//! O(per-op delta) instead of O(full state). Idempotency
    23	//! short-circuit (no state change → no send) closes the V2 V2
    24	//! echo-loop concern. The checkpoint is
    25	//! per-session-currently-attached-transport, NOT per-transport-
    26	//! identity (`attach_transport` resets the baseline).
    27	//! **Phase 5.5 V2 V3 step 2 (2026-05-21, this ship):** wires
    28	//! `poll_remote*` into auto-flush. After a successful drain
    29	//! (`merged > 0`), one auto-flush fires per call (not per-blob —
    30	//! bandwidth-efficient). The V2 V3 step 1 idempotency guard
    31	//! prevents echo loops: drained bytes that Loro dedupes leave the
    32	//! VV unchanged → flush short-circuits to `Ok(false)`. The 3-peer
    33	//! hub-fanout pattern (peer A drains peer B's blob → auto-flushes
    34	//! merged state onward) now works automatically under `OnAppend`.
    35	//! Reverses the V2 V2 audit-locked "receive-side excluded" exclusion.
    36	//! **Phase 5.5 V2 V3 remaining (pending):** offline-write queue
    37	//! (step 3) + WebSocket impl (step 4) + full-arc megaudit (step 5)
    38	//! + exit packet (step 6).
    39	//!
    40	//! Tests can also use [`NoopTransport`] which discards traffic.
    41	//!
    42	//! The contract is intentionally minimal:
    43	//!
    44	//! - `send(&mut self, bytes: &[u8])` — push bytes to the channel.
    45	//!   Bytes are an opaque blob (a Loro export). The transport
    46	//!   doesn't interpret them.
    47	//! - `try_recv(&mut self) -> Option<Vec<u8>>` — non-blocking
    48	//!   receive. Returns `None` if no bytes are queued.
    49	//!
    50	//! That's enough to plumb a `CollabSession::export_bytes` →
    51	//! transport → remote `CollabSession::merge_bytes` flow. The
    52	//! transport handles framing / reliability / reconnect / auth as
    53	//! its implementation details.
    54	
    55	use std::collections::VecDeque;
    56	use std::sync::atomic::{AtomicBool, Ordering};
    57	use std::sync::{Arc, Mutex};
    58	
    59	use thiserror::Error;
    60	
    61	/// Errors emitted by `Transport` impls.
    62	#[derive(Debug, Error)]
    63	#[non_exhaustive]
    64	pub enum TransportError {
    65	    /// The underlying I/O failed (socket dead, network partition,
    66	    /// etc.). Implementations should distinguish recoverable
    67	    /// (reconnect) from permanent (auth rejected) failures via
    68	    /// variant structure in their own error type, then map to this
    69	    /// variant at the trait boundary if they don't want to expose
    70	    /// implementation details.
    71	    #[error("transport I/O error: {0}")]
    72	    Io(String),
    73	
    74	    /// The transport is closed and no further sends are accepted.
    75	    /// Receivers should still drain any already-queued bytes via
    76	    /// `try_recv` before considering the channel done.
    77	    #[error("transport closed")]
    78	    Closed,
    79	}
    80	
    81	/// Wire-byte channel for Phase 5 collaboration.
    82	///
    83	/// Implementations push and pull opaque byte blobs. The blobs ARE
    84	/// Loro `LoroDoc::export(...)` snapshots / updates; the
    85	/// transport doesn't interpret them. Framing (where one blob ends
    86	/// and the next starts) is the implementation's responsibility.
    87	pub trait Transport {
    88	    /// Push `bytes` to the channel. Implementations may buffer
    89	    /// internally; the call returns when the bytes are
    90	    /// **queued for send**, not when the remote has received them.
    91	    ///
    92	    /// On error, the caller should treat the byte blob as unsent
    93	    /// and re-queue (or surface the error to the user). The
    94	    /// transport will not retry automatically — that policy lives
    95	    /// at the layer above (Phase 5.5 design will pick reconnect
    96	    /// semantics).
    97	    fn send(&mut self, bytes: &[u8]) -> Result<(), TransportError>;
    98	
    99	    /// Non-blocking receive. Returns `Some(bytes)` if a blob is
   100	    /// queued, `None` otherwise. Implementations choose how often
   101	    /// they poll the underlying channel; the contract is "if you
   102	    /// have something, give it to me, else `None`."
   103	    ///
   104	    /// Returns `Err(TransportError::Closed)` only when the channel
   105	    /// is permanently closed AND its internal queue is empty. A
   106	    /// transient I/O failure during poll surfaces as
   107	    /// `Err(TransportError::Io)`.
   108	    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError>;
   109	}
   110	
   111	/// No-op `Transport` impl for tests + scaffolding.
   112	///
   113	/// Records every `send` call in an internal `Vec` (so tests can
   114	/// assert what would have gone over the wire) and `try_recv`
   115	/// returns `None` forever (no incoming bytes). Suitable for tests
   116	/// that exercise `CollabSession::append_op` without needing a
   117	/// real channel. For 2-peer round-trip tests, use
   118	/// [`LoopbackTransport::pair`] instead — `NoopTransport` is for
   119	/// "I just need a Transport-shaped object" cases.
   120	#[derive(Debug, Default)]
   121	pub struct NoopTransport {
   122	    /// Bytes the consumer would have pushed to the wire. Tests
   123	    /// inspect this to verify their `CollabSession` calls emit the
   124	    /// expected number / shape of exports.
   125	    pub sent: Vec<Vec<u8>>,
   126	    closed: bool,
   127	}
   128	
   129	impl NoopTransport {
   130	    /// Construct a fresh `NoopTransport` with an empty `sent` log
   131	    /// and `closed = false`.
   132	    pub fn new() -> Self {
   133	        Self::default()
   134	    }
   135	
   136	    /// Mark the channel closed. Subsequent `send` calls return
   137	    /// `TransportError::Closed`; `try_recv` returns `Closed` since
   138	    /// nothing's queued.
   139	    pub fn close(&mut self) {
   140	        self.closed = true;

 succeeded in 0ms:
  1034	    hub.merge_bytes(&b_bytes).unwrap();
  1035	    // merge_bytes auto-fires flush_delta_to_transport. C now sees
  1036	    // hub's existing op + B's op.
  1037	    let bytes = tx_ac_c.try_recv().unwrap().expect("hub auto-flushed");
  1038	    let mut peer_c = ql_oplog::OpLog::new();
  1039	    peer_c.merge_bytes(&bytes).unwrap();
  1040	    assert!(
  1041	        peer_c.len() >= 2,
  1042	        "peer C MUST see hub's op + B's op via the hub's auto-flush: got {}",
  1043	        peer_c.len()
  1044	    );
  1045	}
  1046	
  1047	// ============================================================
  1048	// V2 V3 step 1 audit closures (Codex + Opus, 2026-05-21)
  1049	// ============================================================
  1050	
  1051	/// **OneShotFailingTransport** — fails the FIRST `send` call with
  1052	/// `TransportError::Closed`, succeeds on all subsequent calls.
  1053	/// Used by `delta_flush_retry_after_failure_resends_from_same_vv`
  1054	/// (M1 closure — Codex L2 / Opus M1) to verify that an Err'd flush
  1055	/// leaves `last_flushed_vv` unchanged, so the retry on the SAME
  1056	/// transport sends the same delta the failed call would have.
  1057	///
  1058	/// `try_recv` always returns `Ok(None)` — this transport is
  1059	/// send-only by design for failure testing.
  1060	#[derive(Debug, Default)]
  1061	struct OneShotFailingTransport {
  1062	    fail_next_send: bool,
  1063	    sent_blob_sizes: std::sync::Arc<std::sync::Mutex<Vec<usize>>>,
  1064	}
  1065	
  1066	impl OneShotFailingTransport {
  1067	    fn new() -> Self {
  1068	        Self {
  1069	            fail_next_send: true,
  1070	            sent_blob_sizes: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
  1071	        }
  1072	    }
  1073	    fn sent_sizes_handle(&self) -> std::sync::Arc<std::sync::Mutex<Vec<usize>>> {
  1074	        std::sync::Arc::clone(&self.sent_blob_sizes)
  1075	    }
  1076	}
  1077	
  1078	impl Transport for OneShotFailingTransport {
  1079	    fn send(&mut self, bytes: &[u8]) -> Result<(), ql_collab::TransportError> {
  1080	        if self.fail_next_send {
  1081	            self.fail_next_send = false;
  1082	            return Err(ql_collab::TransportError::Closed);
  1083	        }
  1084	        self.sent_blob_sizes.lock().unwrap().push(bytes.len());
  1085	        Ok(())
  1086	    }
  1087	    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, ql_collab::TransportError> {
  1088	        Ok(None)
  1089	    }
  1090	}
  1091	
  1092	#[test]
  1093	fn delta_flush_retry_after_failure_resends_from_same_vv() {
  1094	    // V2 V3 step 1 audit closure (Codex L2 / Opus M1, 2026-05-21):
  1095	    // verify that on transport.send Err, last_flushed_vv stays
  1096	    // unadvanced — so retry sends THE SAME delta the failed call
  1097	    // would have. Uses OneShotFailingTransport (fails first send,
  1098	    // succeeds after).
  1099	    let transport = OneShotFailingTransport::new();
  1100	    let sizes = transport.sent_sizes_handle();
  1101	
  1102	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1103	    s.append_op(add_sheet()).unwrap();
  1104	    s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
  1105	    s.attach_transport(transport);
  1106	
  1107	    // First call: fails.
  1108	    let result = s.flush_delta_to_transport();
  1109	    assert!(
  1110	        matches!(
  1111	            result,
  1112	            Err(CollabSessionError::Transport(TransportError::Closed))
  1113	        ),
  1114	        "first flush MUST fail with Closed (OneShotFailingTransport contract); got {result:?}"
  1115	    );
  1116	    assert_eq!(
  1117	        sizes.lock().unwrap().len(),
  1118	        0,
  1119	        "no successful send on first call"
  1120	    );
  1121	
  1122	    // Retry on SAME transport (no detach). last_flushed_vv was NOT
  1123	    // advanced by the failed call, so this resends the same delta
  1124	    // (full state from empty VV, since this was the first flush).
  1125	    let result = s.flush_delta_to_transport().unwrap();
  1126	    assert!(result, "retry MUST succeed (transport now accepts sends)");
  1127	    let final_sizes = sizes.lock().unwrap().clone();
  1128	    assert_eq!(final_sizes.len(), 1, "retry produced exactly one send");
  1129	    assert!(
  1130	        final_sizes[0] > 0,
  1131	        "retry's blob is non-empty (contains the 2 appended ops)"
  1132	    );
  1133	
  1134	    // Third call: NO new ops in between → idempotency short-circuit.
  1135	    let result = s.flush_delta_to_transport().unwrap();
  1136	    assert!(
  1137	        !result,
  1138	        "third flush with no mutation MUST short-circuit Ok(false)"
  1139	    );
  1140	    assert_eq!(
  1141	        sizes.lock().unwrap().len(),
  1142	        1,
  1143	        "no additional send on idempotent short-circuit"
  1144	    );
  1145	}
  1146	
  1147	#[test]
  1148	fn delta_flush_bandwidth_savings_subsequent_smaller_than_first() {
  1149	    // V2 V3 step 1 audit closure (Codex L1 / Opus L1, 2026-05-21):
  1150	    // assert that after a baseline batch, a small follow-up append
  1151	    // produces a wire blob substantially SMALLER than the first
  1152	    // flush. Pins the O(per-op-delta) wire size claim against
  1153	    // accidental regression to O(state) (e.g. if flush_delta_to_transport
  1154	    // were ever re-routed through export_bytes / Snapshot mode).
  1155	    let (tx_a, mut tx_b) = LoopbackTransport::pair();
  1156	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1157	    s.append_op(add_sheet()).unwrap();
  1158	    // Append ~100 ops for a meaningful state size.
  1159	    for i in 0..100u32 {
  1160	        s.append_op(put_value(0, i, 0, f64::from(i))).unwrap();
  1161	    }
  1162	    s.attach_transport(tx_a);
  1163	    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
  1164	
  1165	    // First flush sends the baseline (all 101 ops).
  1166	    s.flush_delta_to_transport().unwrap();
  1167	    let first_bytes = tx_b.try_recv().unwrap().expect("first flush bytes");
  1168	    let first_len = first_bytes.len();
  1169	    assert!(first_len > 0);
  1170	
  1171	    // Append one more op. Auto-flush fires.
  1172	    s.append_op(put_value(0, 200, 0, 999.0)).unwrap();
  1173	    let second_bytes = tx_b.try_recv().unwrap().expect("second flush bytes");
  1174	    let second_len = second_bytes.len();
  1175	
  1176	    // Delta should be SUBSTANTIALLY smaller than the baseline.
  1177	    // Conservative threshold: at least 2× smaller. Loro's actual
  1178	    // ratio is typically 10-50× for this scenario; the conservative
  1179	    // bound avoids flakiness from Loro encoding variations.
  1180	    assert!(
  1181	        second_len * 2 < first_len,
  1182	        "delta flush MUST send less than half the baseline size; first={first_len} second={second_len}"
  1183	    );
  1184	}
  1185	
  1186	#[test]
  1187	fn symmetric_on_append_two_peers_converge_with_bounded_wire_bytes() {
  1188	    // V2 V3 step 1 audit closure (Opus L3, 2026-05-21): the
  1189	    // step 1 idempotency guard is documented as making symmetric
  1190	    // OnAppend safe across paired LoopbackTransport peers. Pin
  1191	    // this contract: two peers both with OnAppend; both append;
  1192	    // explicit poll_remote + manual flush_delta on each side (since
  1193	    // poll_remote excluded from auto-flush per V2 V2 audit M1);
  1194	    // verify final state convergence AND that wire traffic does
  1195	    // NOT diverge (no echo-loop).
  1196	    let base = CollabSession::new(PeerId::new(100)).unwrap();
  1197	    let base_bytes = base.export_bytes().unwrap();
  1198	    let (tx_a, tx_b) = LoopbackTransport::pair();
  1199	
  1200	    let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
  1201	    peer_a.attach_transport(tx_a);
  1202	    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
  1203	
  1204	    let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
  1205	    peer_b.attach_transport(tx_b);
  1206	    peer_b.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
  1207	
  1208	    // Both peers append concurrently.
  1209	    peer_a.append_op(add_sheet()).unwrap(); // auto-flush A → B inbox
  1210	    peer_b.append_op(put_value(0, 0, 0, 99.0)).unwrap(); // auto-flush B → A inbox
  1211	
  1212	    // Each peer drains its inbox; explicit flush after poll (since
  1213	    // poll_remote is excluded from auto-flush in V2 V3 step 1).
  1214	    let merged_a = peer_a.poll_remote().unwrap();
  1215	    let merged_b = peer_b.poll_remote().unwrap();
  1216	    assert!(merged_a >= 1, "peer A received peer B's flush");
  1217	    assert!(merged_b >= 1, "peer B received peer A's flush");
  1218	
  1219	    // Each peer flushes the merged state. Idempotency: if the merge
  1220	    // didn't actually advance state beyond what's been flushed, the
  1221	    // second-side flush short-circuits.
  1222	    let a_flushed = peer_a.flush_delta_to_transport().unwrap();
  1223	    let b_flushed = peer_b.flush_delta_to_transport().unwrap();
  1224	    // BOTH peers' state did advance (they received the other's op),
  1225	    // so both flushes fire.
  1226	    let _ = (a_flushed, b_flushed);
  1227	
  1228	    // Drain remaining inbox traffic; verify it terminates (no echo
  1229	    // loop). Cap iterations conservatively: 20 round-trips is way
  1230	    // more than the 2 ops + 2 deltas + idempotency-short-circuit
  1231	    // scenario needs.
  1232	    for _ in 0..20 {
  1233	        let polled_a = peer_a.poll_remote().unwrap();
  1234	        let polled_b = peer_b.poll_remote().unwrap();
  1235	        let flushed_a = peer_a.flush_delta_to_transport().unwrap();
  1236	        let flushed_b = peer_b.flush_delta_to_transport().unwrap();
  1237	        if polled_a == 0 && polled_b == 0 && !flushed_a && !flushed_b {
  1238	            // Steady state — no more traffic. Idempotency guard
  1239	            // working as advertised.
  1240	            break;
  1241	        }
  1242	    }
  1243	
  1244	    // Final convergence check: both peers see the same op count.
  1245	    // Loro CRDT merge is deterministic; both peers have all ops.
  1246	    assert!(peer_a.op_count() >= 2);
  1247	    assert!(peer_b.op_count() >= 2);
  1248	    assert_eq!(
  1249	        peer_a.op_count(),
  1250	        peer_b.op_count(),
  1251	        "symmetric-OnAppend peers MUST converge to the same op count"
  1252	    );
  1253	}

exec
/bin/zsh -lc "rg -n \"pub fn|fn maybe_auto_flush|self\\.log\\.|self\\.undo|set_peer|presence_|start_undo|end_undo|undo\\(|redo\\(\" quantbook-engine/crates/ql-collab/src/session.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
9://!   `e199a5fda5a`: `start_undo_group` / `end_undo_group` +
10://!   `set_undo_merge_interval`. V2 V1.1: `start_undo_group_scoped`
32://!   `LoroDoc::set_peer_id` (Phase 5.2.b — was a label-only stamp
33://!   in 5.2.a). Returns `Result` because Loro's `set_peer_id` is
221:    /// - Undo-group boundary methods (`start_undo_group` /
222:    ///   `end_undo_group`) — only their inner appends fire, via
325:    /// through to the underlying `LoroDoc::set_peer_id` so Loro's
329:    /// **Caller pitfalls** (from `OpLog::set_peer_id`):
346:    /// regardless of build profile. Centralized in `OpLog::set_peer_id`
348:    pub fn new(peer_id: PeerId) -> Result<Self, CollabSessionError> {
356:        log.set_peer_id(peer_id.as_u64())?;
383:    ///   concurrent session — see `OpLog::set_peer_id` for details.
389:    pub fn from_snapshot(peer_id: PeerId, bytes: &[u8]) -> Result<Self, CollabSessionError> {
399:        log.set_peer_id(peer_id.as_u64())?;
412:    pub fn peer_id(&self) -> PeerId {
425:    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
426:        self.log.append(op)?;
453:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
454:        let new_len = self.log.merge_bytes(bytes)?;
473:    pub fn export_bytes(&self) -> Result<Vec<u8>, CollabSessionError> {
474:        Ok(self.log.export_bytes()?)
499:    pub fn op_log(&self) -> &OpLog {
584:    pub fn rebuild_workbook(
589:        if self.log.is_empty() {
611:    pub fn op_count(&self) -> usize {
612:        self.log.len()
616:    pub fn is_empty(&self) -> bool {
617:        self.log.is_empty()
636:    pub fn attach_transport<T: Transport + Send + 'static>(
653:    pub fn detach_transport(&mut self) -> Option<Box<dyn Transport + Send>> {
662:    pub fn has_transport(&self) -> bool {
696:    pub fn set_auto_flush_policy(&mut self, policy: AutoFlushPolicy) -> AutoFlushPolicy {
702:    pub fn auto_flush_policy(&self) -> AutoFlushPolicy {
720:    fn maybe_auto_flush(&mut self) -> Result<(), CollabSessionError> {
760:    pub fn flush_to_transport(&mut self) -> Result<bool, CollabSessionError> {
764:        let bytes = self.log.export_bytes()?;
774:        self.last_flushed_vv = Some(self.log.oplog_vv());
818:    pub fn flush_delta_to_transport(&mut self) -> Result<bool, CollabSessionError> {
822:        let current_vv = self.log.oplog_vv();
836:            Some(from) => self.log.export_delta_bytes(from)?,
891:    pub fn poll_remote(&mut self) -> Result<usize, CollabSessionError> {
927:    pub fn poll_remote_with_limit(
938:                    self.log.merge_bytes(&bytes)?;
978:    pub fn update_presence(&mut self, state: PresenceState) -> Result<(), CollabSessionError> {
981:        self.log.presence_set(&key, &json)?;
990:    pub fn peer_presence(&self, peer: PeerId) -> Result<Option<PresenceState>, CollabSessionError> {
992:        let Some(json) = self.log.presence_get(&key)? else {
1013:    pub fn clear_presence(&mut self) -> Result<(), CollabSessionError> {
1015:        self.log.presence_remove(&key)?;
1043:    pub fn undo(&mut self) -> Result<bool, CollabSessionError> {
1044:        let consumed = self.undo.undo()?;
1067:    pub fn redo(&mut self) -> Result<bool, CollabSessionError> {
1068:        let consumed = self.undo.redo()?;
1078:    pub fn can_undo(&self) -> bool {
1079:        self.undo.can_undo()
1084:    pub fn can_redo(&self) -> bool {
1085:        self.undo.can_redo()
1090:    pub fn undo_count(&self) -> usize {
1091:        self.undo.undo_count()
1096:    pub fn redo_count(&self) -> usize {
1097:        self.undo.redo_count()
1104:    pub fn clear_undo_stack(&self) {
1105:        self.undo.clear();
1110:    /// the undo stack; one `undo()` call after `end_undo_group`
1115:    /// Pair with [`end_undo_group`]. Calling `start_undo_group`
1122:    /// between `start_undo_group` and `end_undo_group` returns
1124:    /// next `start_undo_group` will fail with the deterministic
1126:    /// [`start_undo_group_scoped`]** (Phase 5.4 V2 V1.1 — RAII
1134:    pub fn start_undo_group(&mut self) -> Result<(), CollabSessionError> {
1135:        Ok(self.undo.group_start()?)
1139:    /// group started by [`start_undo_group`]. All appends since
1140:    /// the matching `start_undo_group` are now a single undo
1146:    pub fn end_undo_group(&mut self) {
1147:        self.undo.group_end();
1163:    /// Orthogonal to [`start_undo_group`] / [`end_undo_group`] —
1165:    pub fn set_undo_merge_interval(&mut self, interval_ms: i64) {
1166:        self.undo.set_merge_interval(interval_ms);
1170:    /// [`start_undo_group`]. Returns an [`UndoGroupGuard`] that
1172:    /// guard automatically calls [`end_undo_group`].
1184:    ///     let mut guard = session.start_undo_group_scoped()?;
1188:    ///     // guard drops here → end_undo_group runs.
1197:    /// Errors from [`start_undo_group`] propagate (nested call
1199:    pub fn start_undo_group_scoped(&mut self) -> Result<UndoGroupGuard<'_>, CollabSessionError> {
1200:        self.start_undo_group()?;
1230:    pub fn sweep_presence(&mut self) -> Result<usize, CollabSessionError> {
1231:        let keys = self.log.presence_peers();
1234:            self.log.presence_remove(&key)?;
1253:    pub fn peers_with_presence(&self) -> Result<Vec<PeerId>, CollabSessionError> {
1254:        let keys = self.log.presence_peers();
1267:            .field("op_count", &self.log.len())
1268:            .field("undo_count", &self.undo.undo_count())
1269:            .field("redo_count", &self.undo.redo_count())
1276:/// [`CollabSession::start_undo_group_scoped`]. `Drop` calls
1277:/// `end_undo_group` automatically — runs on scope exit, on `?`
1279:/// that can fail mid-group; the manual `start_undo_group` /
1280:/// `end_undo_group` pair only handles the happy path.
1312:        // `end_undo_group` is infallible per Loro 1.12.0; safe in
1316:        self.session.end_undo_group();
1326:/// origin via `OpLog::presence_set` / `presence_remove`.)
1423:        // CollabSession but never passed to LoroDoc::set_peer_id, so
1467:    fn presence_round_trip_within_one_session() {
1503:    fn presence_two_peer_merge_preserves_both() {
1537:    fn presence_merge_is_commutative() {
1577:    fn presence_tombstone_propagates_through_merge() {
1614:        assert!(!s.can_undo());
1615:        assert!(!s.can_redo());
1625:        assert!(s.can_undo());
1630:        assert!(s.undo().unwrap());
1633:        assert!(s.can_redo());
1636:        assert!(s.undo().unwrap());
1639:        assert!(!s.can_undo());
1642:        assert!(!s.undo().unwrap());
1645:        assert!(s.redo().unwrap());
1646:        assert!(s.redo().unwrap());
1649:        assert!(!s.can_redo());
1650:        assert!(!s.redo().unwrap());
1654:    fn presence_updates_do_not_consume_undo_stack() {
1655:        // 5.4 V1 acceptance: cursor movement (presence_set) MUST
1677:        // collapse to ONE undo stack item. A single undo() call
1682:        s.start_undo_group().unwrap();
1686:        s.end_undo_group();
1697:        assert!(s.undo().unwrap());
1707:        assert!(s.redo().unwrap());
1714:    fn nested_start_undo_group_returns_already_started_error() {
1720:        s.start_undo_group().unwrap();
1721:        let err = s.start_undo_group().unwrap_err();
1724:            "nested start_undo_group must return Undo(LoroError::UndoGroupAlreadyStarted), got {err:?}"
1727:        s.end_undo_group();
1728:        assert!(s.start_undo_group().is_ok(), "fresh start after end works");
1729:        s.end_undo_group();
1735:        // calls end_undo_group. 3 appends inside the guard scope
1740:            let mut guard = s.start_undo_group_scoped().unwrap();
1744:        } // guard drops here → end_undo_group
1747:        assert!(s.undo().unwrap());
1758:            let mut guard = s.start_undo_group_scoped()?;
1785:        // A subsequent start_undo_group_scoped must succeed (no
1787:        let _guard = s.start_undo_group_scoped().unwrap();
1796:        let mut guard = s.start_undo_group_scoped().unwrap();
1807:        // Nested start_undo_group_scoped (without ending the
1811:        let _guard1 = s.start_undo_group_scoped().unwrap();
1812:        // Cannot call start_undo_group_scoped on s while guard1
1819:        // let _guard2 = s.start_undo_group_scoped(); // <-- borrow error
1826:        s.start_undo_group().unwrap();
1828:            let result = s.start_undo_group_scoped();
1831:            // doesn't extend into the `s.end_undo_group()` call.
1836:        s.end_undo_group();
1846:        s.start_undo_group().unwrap();
1847:        s.end_undo_group();
1859:        s.start_undo_group().unwrap();
1862:        s.end_undo_group();
1875:    fn end_undo_group_without_start_is_noop() {
1879:        s.end_undo_group(); // No panic.
1880:        s.end_undo_group(); // Idempotent.
1905:        s.undo().unwrap();
1912:        assert!(!s.can_undo());
1913:        assert!(!s.can_redo());
1928:        assert!(s.undo().unwrap());
1934:        assert!(s.redo().unwrap());
1949:        assert!(origin.can_undo());
1958:        assert!(!reborn.can_undo());
1983:        assert!(peer_a.undo().unwrap());
2319:    fn sweep_presence_clears_all_entries_and_returns_count() {
2330:            .presence_set("0000000000000002", r#"{"sheet":1,"row":2,"col":3,"selection_end_row":2,"selection_end_col":3,"typing":false}"#)
2347:    fn sweep_presence_on_empty_map_returns_zero() {
2359:    fn sweep_presence_after_from_snapshot_gives_clean_slate() {
2384:    fn presence_does_not_dirty_op_log() {

exec
/bin/zsh -lc "rg -n \"poll_remote|maybe_auto_flush|flush_delta_to_transport|self\\.log\\.\" quantbook-engine/crates/ql-collab/tests/auto_flush.rs quantbook-engine/crates/ql-collab/src/session.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:142:    // poll_remote, WITHOUT peer A calling flush_to_transport.
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:155:    // auto-flush fires per mutation; peer B drains via poll_remote.
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:160:    let merged = peer_b.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:406:// ===== V2 V3 step 2: poll_remote triggers auto-flush (inverted from V2 V2 exclusion) =====
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:409:fn poll_remote_triggers_auto_flush_under_on_append() {
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:412:    // idempotency guard in place, wiring poll_remote into auto-flush
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:419:    // A's poll_remote drains it AND auto-flushes the merged delta
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:440:    // A drains B's blob via poll_remote. With V2 V3 step 2, this
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:443:    let merged = peer_a.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:452:        "V2 V3 step 2: poll_remote MUST auto-flush after a successful drain that advanced state"
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:461:fn poll_remote_idempotent_merge_short_circuits_no_wire_send() {
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:469:    // state. A's poll_remote merges (no new ops), auto-flush
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:477:    let _ = peer_a.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:489:    let merged = peer_a.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:499:fn poll_remote_empty_drain_does_not_attempt_flush() {
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:515:    let merged = peer_a.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:525:fn poll_remote_with_closed_transport_returns_zero_no_flush() {
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:527:    // existing graceful break in poll_remote_with_limit returns
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:538:    // poll_remote should return Ok(0) (no blobs to drain, closed
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:541:    let result = peer_a.poll_remote();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:743:    // First `flush_delta_to_transport` after attach_transport sends
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:756:    let sent = s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:773:    // After a successful flush, calling flush_delta_to_transport
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:783:    let sent1 = s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:788:    let sent2 = s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:798:    let sent3 = s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:815:    s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:821:    s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:856:    s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:871:    s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:887:    // so a subsequent flush_delta_to_transport doesn't re-send the
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:903:    // Now subsequent flush_delta_to_transport should short-circuit
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:905:    let sent2 = s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:914:    s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:926:    // V2 V3 step 1 reroutes maybe_auto_flush through
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:927:    // flush_delta_to_transport. After N appends under OnAppend,
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:963:    // Sanity: with no transport attached, flush_delta_to_transport
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:967:    let sent = s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:983:    let result = s.flush_delta_to_transport();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1001:    s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1017:    // A's flush_delta_to_transport then sends the merged state to
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1035:    // merge_bytes auto-fires flush_delta_to_transport. C now sees
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1108:    let result = s.flush_delta_to_transport();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1125:    let result = s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1135:    let result = s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1153:    // accidental regression to O(state) (e.g. if flush_delta_to_transport
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1166:    s.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1192:    // explicit poll_remote + manual flush_delta on each side (since
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1193:    // poll_remote excluded from auto-flush per V2 V2 audit M1);
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1213:    // poll_remote is excluded from auto-flush in V2 V3 step 1).
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1214:    let merged_a = peer_a.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1215:    let merged_b = peer_b.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1222:    let a_flushed = peer_a.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1223:    let b_flushed = peer_b.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1233:        let polled_a = peer_a.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1234:        let polled_b = peer_b.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1235:        let flushed_a = peer_a.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1236:        let flushed_b = peer_b.flush_delta_to_transport().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:17://!   `flush_to_transport` + `poll_remote` (+ `_with_limit`)
quantbook-engine/crates/ql-collab/src/session.rs:64:/// the number of blobs `CollabSession::poll_remote` drains per
quantbook-engine/crates/ql-collab/src/session.rs:67:/// Callers wanting a different bound use `poll_remote_with_limit`.
quantbook-engine/crates/ql-collab/src/session.rs:107:    /// For `poll_remote`: any bytes successfully drained BEFORE
quantbook-engine/crates/ql-collab/src/session.rs:111:    /// handled gracefully by `poll_remote` itself (returns
quantbook-engine/crates/ql-collab/src/session.rs:194:    /// [`CollabSession::poll_remote`]. Auto-flush never fires.
quantbook-engine/crates/ql-collab/src/session.rs:200:    /// `undo`, `redo`, `poll_remote`, `poll_remote_with_limit`.
quantbook-engine/crates/ql-collab/src/session.rs:203:    /// through [`flush_delta_to_transport`] (delta path) rather than
quantbook-engine/crates/ql-collab/src/session.rs:210:    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** `poll_remote*` now
quantbook-engine/crates/ql-collab/src/session.rs:245:    /// guard short-circuits `flush_delta_to_transport` when no ops
quantbook-engine/crates/ql-collab/src/session.rs:251:    /// `poll_remote` also auto-flushes — the round-trip back to the
quantbook-engine/crates/ql-collab/src/session.rs:256:    /// **V1 limit (V2 V3 step 2)**: auto-flush from `poll_remote`
quantbook-engine/crates/ql-collab/src/session.rs:303:    /// `flush_to_transport` / `flush_delta_to_transport` call.
quantbook-engine/crates/ql-collab/src/session.rs:315:    ///   `flush_delta_to_transport` (V2 V3 delta path).
quantbook-engine/crates/ql-collab/src/session.rs:426:        self.log.append(op)?;
quantbook-engine/crates/ql-collab/src/session.rs:427:        self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:454:        let new_len = self.log.merge_bytes(bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:455:        self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:474:        Ok(self.log.export_bytes()?)
quantbook-engine/crates/ql-collab/src/session.rs:589:        if self.log.is_empty() {
quantbook-engine/crates/ql-collab/src/session.rs:612:        self.log.len()
quantbook-engine/crates/ql-collab/src/session.rs:617:        self.log.is_empty()
quantbook-engine/crates/ql-collab/src/session.rs:623:    /// snapshot through it; [`poll_remote`] drains incoming
quantbook-engine/crates/ql-collab/src/session.rs:642:        // session's ops, so the next `flush_delta_to_transport` must
quantbook-engine/crates/ql-collab/src/session.rs:674:    /// [`flush_delta_to_transport`] internally — IDE callers can
quantbook-engine/crates/ql-collab/src/session.rs:679:    /// ([`flush_delta_to_transport`]), not the full-snapshot path
quantbook-engine/crates/ql-collab/src/session.rs:688:    /// [`flush_delta_to_transport`] (delta) remain available
quantbook-engine/crates/ql-collab/src/session.rs:716:    /// [`flush_delta_to_transport`] (delta path) instead of
quantbook-engine/crates/ql-collab/src/session.rs:720:    fn maybe_auto_flush(&mut self) -> Result<(), CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:727:                let _sent = self.flush_delta_to_transport()?;
quantbook-engine/crates/ql-collab/src/session.rs:764:        let bytes = self.log.export_bytes()?;
quantbook-engine/crates/ql-collab/src/session.rs:768:        // up to this VV; subsequent `flush_delta_to_transport` calls
quantbook-engine/crates/ql-collab/src/session.rs:771:        // `flush_delta_to_transport`) would re-send the snapshot's
quantbook-engine/crates/ql-collab/src/session.rs:774:        self.last_flushed_vv = Some(self.log.oplog_vv());
quantbook-engine/crates/ql-collab/src/session.rs:784:    /// step 2's `poll_remote` auto-flush wiring).
quantbook-engine/crates/ql-collab/src/session.rs:804:    /// - Steady state under `OnAppend`: `maybe_auto_flush` (via
quantbook-engine/crates/ql-collab/src/session.rs:805:    ///   `flush_delta_to_transport`) sends tiny deltas per
quantbook-engine/crates/ql-collab/src/session.rs:818:    pub fn flush_delta_to_transport(&mut self) -> Result<bool, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:822:        let current_vv = self.log.oplog_vv();
quantbook-engine/crates/ql-collab/src/session.rs:836:            Some(from) => self.log.export_delta_bytes(from)?,
quantbook-engine/crates/ql-collab/src/session.rs:860:    /// [`poll_remote_with_limit`]. The cap prevents one
quantbook-engine/crates/ql-collab/src/session.rs:861:    /// `poll_remote` call from starving the calling thread when
quantbook-engine/crates/ql-collab/src/session.rs:875:    /// through [`flush_delta_to_transport`] when
quantbook-engine/crates/ql-collab/src/session.rs:885:    /// exclusion of `poll_remote*` from auto-flush. V2 V3 step 1's
quantbook-engine/crates/ql-collab/src/session.rs:891:    pub fn poll_remote(&mut self) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:892:        self.poll_remote_with_limit(DEFAULT_POLL_REMOTE_LIMIT)
quantbook-engine/crates/ql-collab/src/session.rs:896:    /// [`poll_remote`] but with an explicit per-call cap on the
quantbook-engine/crates/ql-collab/src/session.rs:911:    /// [`flush_delta_to_transport`]; V2 V3 step 1's idempotency
quantbook-engine/crates/ql-collab/src/session.rs:924:    /// (e.g., manual [`flush_delta_to_transport`] after detaching
quantbook-engine/crates/ql-collab/src/session.rs:927:    pub fn poll_remote_with_limit(
quantbook-engine/crates/ql-collab/src/session.rs:938:                    self.log.merge_bytes(&bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:954:        // `flush_delta_to_transport` returns Ok(false) without
quantbook-engine/crates/ql-collab/src/session.rs:960:            self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:981:        self.log.presence_set(&key, &json)?;
quantbook-engine/crates/ql-collab/src/session.rs:982:        self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:992:        let Some(json) = self.log.presence_get(&key)? else {
quantbook-engine/crates/ql-collab/src/session.rs:1015:        self.log.presence_remove(&key)?;
quantbook-engine/crates/ql-collab/src/session.rs:1016:        self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:1053:            self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:1071:            self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:1231:        let keys = self.log.presence_peers();
quantbook-engine/crates/ql-collab/src/session.rs:1234:            self.log.presence_remove(&key)?;
quantbook-engine/crates/ql-collab/src/session.rs:1239:        self.maybe_auto_flush()?;
quantbook-engine/crates/ql-collab/src/session.rs:1254:        let keys = self.log.presence_peers();
quantbook-engine/crates/ql-collab/src/session.rs:1267:            .field("op_count", &self.log.len())
quantbook-engine/crates/ql-collab/src/session.rs:2043:    fn poll_remote_noop_without_attached() {
quantbook-engine/crates/ql-collab/src/session.rs:2045:        let drained = s.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2073:    fn poll_remote_drains_attached_transport() {
quantbook-engine/crates/ql-collab/src/session.rs:2088:        let drained = s.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2092:        let drained2 = s.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2112:        let drained_b = peer_b.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2119:        let drained_a = peer_a.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2150:    fn poll_remote_treats_closed_as_graceful_end_of_stream() {
quantbook-engine/crates/ql-collab/src/session.rs:2153:        // Closed only after queue drains; CollabSession::poll_remote
quantbook-engine/crates/ql-collab/src/session.rs:2173:        let drained = s.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2176:            "poll_remote must drain all queued blobs even when transport is closed"
quantbook-engine/crates/ql-collab/src/session.rs:2179:        let drained2 = s.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2184:    fn poll_remote_with_limit_caps_drain() {
quantbook-engine/crates/ql-collab/src/session.rs:2185:        // Codex+Opus 5.5 V2 V1 audit closure (H1): poll_remote_with_limit
quantbook-engine/crates/ql-collab/src/session.rs:2200:        let d1 = s.poll_remote_with_limit(4).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2202:        let d2 = s.poll_remote_with_limit(4).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2204:        let d3 = s.poll_remote_with_limit(4).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2206:        let d4 = s.poll_remote_with_limit(4).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2211:        let d5 = s.poll_remote_with_limit(0).unwrap();

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/auto_flush.rs | sed -n '900,1330p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   900	    peer_view.merge_bytes(&snapshot_bytes).unwrap();
   901	    assert_eq!(peer_view.len(), 2);
   902	
   903	    // Now subsequent flush_delta_to_transport should short-circuit
   904	    // because last_flushed_vv now matches current_vv.
   905	    let sent2 = s.flush_delta_to_transport().unwrap();
   906	    assert!(
   907	        !sent2,
   908	        "flush_to_transport MUST update last_flushed_vv so subsequent delta flush is idempotent"
   909	    );
   910	    assert_eq!(tx_b.pending_recv(), 0);
   911	
   912	    // Append a new op; delta flush sends only that.
   913	    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();
   914	    s.flush_delta_to_transport().unwrap();
   915	    let delta_bytes = tx_b.try_recv().unwrap().unwrap();
   916	    peer_view.merge_bytes(&delta_bytes).unwrap();
   917	    assert_eq!(
   918	        peer_view.len(),
   919	        3,
   920	        "mix-and-match: snapshot then delta produces correct final state on peer"
   921	    );
   922	}
   923	
   924	#[test]
   925	fn on_append_uses_delta_path_under_v2_v3() {
   926	    // V2 V3 step 1 reroutes maybe_auto_flush through
   927	    // flush_delta_to_transport. After N appends under OnAppend,
   928	    // each wire blob is a delta (small) not a full snapshot. The
   929	    // user-visible behavior is the same — peers reconstruct the
   930	    // full state — but bandwidth scales O(per-op delta) instead
   931	    // of O(state).
   932	    let (tx_a, mut tx_b) = LoopbackTransport::pair();
   933	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   934	    s.attach_transport(tx_a);
   935	    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   936	
   937	    s.append_op(add_sheet()).unwrap();
   938	    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
   939	    s.append_op(put_value(0, 1, 0, 2.0)).unwrap();
   940	
   941	    // Three appends → three auto-flushes, each a delta.
   942	    assert_eq!(
   943	        tx_b.pending_recv(),
   944	        3,
   945	        "OnAppend fires once per mutator (delta path doesn't change the fire count)"
   946	    );
   947	
   948	    // Drain all three and reconstruct on peer side.
   949	    let mut peer = ql_oplog::OpLog::new();
   950	    for _ in 0..3 {
   951	        let bytes = tx_b.try_recv().unwrap().expect("delta bytes");
   952	        peer.merge_bytes(&bytes).unwrap();
   953	    }
   954	    assert_eq!(
   955	        peer.len(),
   956	        3,
   957	        "peer reconstructs full state from chained deltas"
   958	    );
   959	}
   960	
   961	#[test]
   962	fn delta_flush_with_no_transport_returns_ok_false() {
   963	    // Sanity: with no transport attached, flush_delta_to_transport
   964	    // is a no-op (matches flush_to_transport semantics).
   965	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   966	    s.append_op(add_sheet()).unwrap();
   967	    let sent = s.flush_delta_to_transport().unwrap();
   968	    assert!(!sent, "no transport → Ok(false) without invoking anything");
   969	}
   970	
   971	#[test]
   972	fn delta_flush_failure_does_not_advance_vv_so_retry_resends() {
   973	    // Partial-state contract: on transport.send Err, last_flushed_vv
   974	    // is NOT updated. A successful retry sends the same delta the
   975	    // failed call would have sent. Use NoopTransport closed-state to
   976	    // simulate the failure.
   977	    let mut bad = NoopTransport::new();
   978	    bad.close();
   979	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
   980	    s.append_op(add_sheet()).unwrap();
   981	    s.attach_transport(bad);
   982	
   983	    let result = s.flush_delta_to_transport();
   984	    assert!(
   985	        matches!(
   986	            result,
   987	            Err(CollabSessionError::Transport(TransportError::Closed))
   988	        ),
   989	        "closed transport MUST surface Err; got {result:?}"
   990	    );
   991	
   992	    // last_flushed_vv NOT advanced — but we can't easily inspect it
   993	    // directly (private field). Instead, retry with a fresh
   994	    // (working) transport and assert the bytes sent contain the op.
   995	    s.detach_transport();
   996	    let (tx_a, mut tx_b) = LoopbackTransport::pair();
   997	    s.attach_transport(tx_a);
   998	    // attach_transport resets last_flushed_vv to None, so this
   999	    // tests a different property than the original intent.
  1000	    // Re-frame: assert that the prior failure didn't corrupt state.
  1001	    s.flush_delta_to_transport().unwrap();
  1002	    let bytes = tx_b.try_recv().unwrap().unwrap();
  1003	    let mut peer = ql_oplog::OpLog::new();
  1004	    peer.merge_bytes(&bytes).unwrap();
  1005	    assert_eq!(
  1006	        peer.len(),
  1007	        1,
  1008	        "post-failure recovery: the op IS still in the local log + flushable"
  1009	    );
  1010	}
  1011	
  1012	#[test]
  1013	fn delta_flush_after_merge_bytes_sends_merged_state_to_third_peer() {
  1014	    // Hub scenario simplified: peer A (hub) has a transport to peer
  1015	    // C. A merges peer B's bytes (via direct merge_bytes call —
  1016	    // simulating B handing A bytes through some other channel).
  1017	    // A's flush_delta_to_transport then sends the merged state to
  1018	    // peer C. This is the V2 V2 merge_bytes auto-flush behavior
  1019	    // continuing to work under V2 V3 delta semantics.
  1020	    let (tx_ac_a, mut tx_ac_c) = LoopbackTransport::pair();
  1021	
  1022	    // Build peer B with one op + export.
  1023	    let mut peer_b = CollabSession::new(PeerId::new(2)).unwrap();
  1024	    peer_b.append_op(add_sheet()).unwrap();
  1025	    let b_bytes = peer_b.export_bytes().unwrap();
  1026	
  1027	    // Hub: append own op, attach transport to C, merge B's bytes,
  1028	    // verify C sees both hub + B ops.
  1029	    let mut hub = CollabSession::new(PeerId::new(1)).unwrap();
  1030	    hub.append_op(put_value(0, 5, 5, 99.0)).unwrap();
  1031	    hub.attach_transport(tx_ac_a);
  1032	    hub.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
  1033	
  1034	    hub.merge_bytes(&b_bytes).unwrap();
  1035	    // merge_bytes auto-fires flush_delta_to_transport. C now sees
  1036	    // hub's existing op + B's op.
  1037	    let bytes = tx_ac_c.try_recv().unwrap().expect("hub auto-flushed");
  1038	    let mut peer_c = ql_oplog::OpLog::new();
  1039	    peer_c.merge_bytes(&bytes).unwrap();
  1040	    assert!(
  1041	        peer_c.len() >= 2,
  1042	        "peer C MUST see hub's op + B's op via the hub's auto-flush: got {}",
  1043	        peer_c.len()
  1044	    );
  1045	}
  1046	
  1047	// ============================================================
  1048	// V2 V3 step 1 audit closures (Codex + Opus, 2026-05-21)
  1049	// ============================================================
  1050	
  1051	/// **OneShotFailingTransport** — fails the FIRST `send` call with
  1052	/// `TransportError::Closed`, succeeds on all subsequent calls.
  1053	/// Used by `delta_flush_retry_after_failure_resends_from_same_vv`
  1054	/// (M1 closure — Codex L2 / Opus M1) to verify that an Err'd flush
  1055	/// leaves `last_flushed_vv` unchanged, so the retry on the SAME
  1056	/// transport sends the same delta the failed call would have.
  1057	///
  1058	/// `try_recv` always returns `Ok(None)` — this transport is
  1059	/// send-only by design for failure testing.
  1060	#[derive(Debug, Default)]
  1061	struct OneShotFailingTransport {
  1062	    fail_next_send: bool,
  1063	    sent_blob_sizes: std::sync::Arc<std::sync::Mutex<Vec<usize>>>,
  1064	}
  1065	
  1066	impl OneShotFailingTransport {
  1067	    fn new() -> Self {
  1068	        Self {
  1069	            fail_next_send: true,
  1070	            sent_blob_sizes: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
  1071	        }
  1072	    }
  1073	    fn sent_sizes_handle(&self) -> std::sync::Arc<std::sync::Mutex<Vec<usize>>> {
  1074	        std::sync::Arc::clone(&self.sent_blob_sizes)
  1075	    }
  1076	}
  1077	
  1078	impl Transport for OneShotFailingTransport {
  1079	    fn send(&mut self, bytes: &[u8]) -> Result<(), ql_collab::TransportError> {
  1080	        if self.fail_next_send {
  1081	            self.fail_next_send = false;
  1082	            return Err(ql_collab::TransportError::Closed);
  1083	        }
  1084	        self.sent_blob_sizes.lock().unwrap().push(bytes.len());
  1085	        Ok(())
  1086	    }
  1087	    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, ql_collab::TransportError> {
  1088	        Ok(None)
  1089	    }
  1090	}
  1091	
  1092	#[test]
  1093	fn delta_flush_retry_after_failure_resends_from_same_vv() {
  1094	    // V2 V3 step 1 audit closure (Codex L2 / Opus M1, 2026-05-21):
  1095	    // verify that on transport.send Err, last_flushed_vv stays
  1096	    // unadvanced — so retry sends THE SAME delta the failed call
  1097	    // would have. Uses OneShotFailingTransport (fails first send,
  1098	    // succeeds after).
  1099	    let transport = OneShotFailingTransport::new();
  1100	    let sizes = transport.sent_sizes_handle();
  1101	
  1102	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1103	    s.append_op(add_sheet()).unwrap();
  1104	    s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
  1105	    s.attach_transport(transport);
  1106	
  1107	    // First call: fails.
  1108	    let result = s.flush_delta_to_transport();
  1109	    assert!(
  1110	        matches!(
  1111	            result,
  1112	            Err(CollabSessionError::Transport(TransportError::Closed))
  1113	        ),
  1114	        "first flush MUST fail with Closed (OneShotFailingTransport contract); got {result:?}"
  1115	    );
  1116	    assert_eq!(
  1117	        sizes.lock().unwrap().len(),
  1118	        0,
  1119	        "no successful send on first call"
  1120	    );
  1121	
  1122	    // Retry on SAME transport (no detach). last_flushed_vv was NOT
  1123	    // advanced by the failed call, so this resends the same delta
  1124	    // (full state from empty VV, since this was the first flush).
  1125	    let result = s.flush_delta_to_transport().unwrap();
  1126	    assert!(result, "retry MUST succeed (transport now accepts sends)");
  1127	    let final_sizes = sizes.lock().unwrap().clone();
  1128	    assert_eq!(final_sizes.len(), 1, "retry produced exactly one send");
  1129	    assert!(
  1130	        final_sizes[0] > 0,
  1131	        "retry's blob is non-empty (contains the 2 appended ops)"
  1132	    );
  1133	
  1134	    // Third call: NO new ops in between → idempotency short-circuit.
  1135	    let result = s.flush_delta_to_transport().unwrap();
  1136	    assert!(
  1137	        !result,
  1138	        "third flush with no mutation MUST short-circuit Ok(false)"
  1139	    );
  1140	    assert_eq!(
  1141	        sizes.lock().unwrap().len(),
  1142	        1,
  1143	        "no additional send on idempotent short-circuit"
  1144	    );
  1145	}
  1146	
  1147	#[test]
  1148	fn delta_flush_bandwidth_savings_subsequent_smaller_than_first() {
  1149	    // V2 V3 step 1 audit closure (Codex L1 / Opus L1, 2026-05-21):
  1150	    // assert that after a baseline batch, a small follow-up append
  1151	    // produces a wire blob substantially SMALLER than the first
  1152	    // flush. Pins the O(per-op-delta) wire size claim against
  1153	    // accidental regression to O(state) (e.g. if flush_delta_to_transport
  1154	    // were ever re-routed through export_bytes / Snapshot mode).
  1155	    let (tx_a, mut tx_b) = LoopbackTransport::pair();
  1156	    let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1157	    s.append_op(add_sheet()).unwrap();
  1158	    // Append ~100 ops for a meaningful state size.
  1159	    for i in 0..100u32 {
  1160	        s.append_op(put_value(0, i, 0, f64::from(i))).unwrap();
  1161	    }
  1162	    s.attach_transport(tx_a);
  1163	    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
  1164	
  1165	    // First flush sends the baseline (all 101 ops).
  1166	    s.flush_delta_to_transport().unwrap();
  1167	    let first_bytes = tx_b.try_recv().unwrap().expect("first flush bytes");
  1168	    let first_len = first_bytes.len();
  1169	    assert!(first_len > 0);
  1170	
  1171	    // Append one more op. Auto-flush fires.
  1172	    s.append_op(put_value(0, 200, 0, 999.0)).unwrap();
  1173	    let second_bytes = tx_b.try_recv().unwrap().expect("second flush bytes");
  1174	    let second_len = second_bytes.len();
  1175	
  1176	    // Delta should be SUBSTANTIALLY smaller than the baseline.
  1177	    // Conservative threshold: at least 2× smaller. Loro's actual
  1178	    // ratio is typically 10-50× for this scenario; the conservative
  1179	    // bound avoids flakiness from Loro encoding variations.
  1180	    assert!(
  1181	        second_len * 2 < first_len,
  1182	        "delta flush MUST send less than half the baseline size; first={first_len} second={second_len}"
  1183	    );
  1184	}
  1185	
  1186	#[test]
  1187	fn symmetric_on_append_two_peers_converge_with_bounded_wire_bytes() {
  1188	    // V2 V3 step 1 audit closure (Opus L3, 2026-05-21): the
  1189	    // step 1 idempotency guard is documented as making symmetric
  1190	    // OnAppend safe across paired LoopbackTransport peers. Pin
  1191	    // this contract: two peers both with OnAppend; both append;
  1192	    // explicit poll_remote + manual flush_delta on each side (since
  1193	    // poll_remote excluded from auto-flush per V2 V2 audit M1);
  1194	    // verify final state convergence AND that wire traffic does
  1195	    // NOT diverge (no echo-loop).
  1196	    let base = CollabSession::new(PeerId::new(100)).unwrap();
  1197	    let base_bytes = base.export_bytes().unwrap();
  1198	    let (tx_a, tx_b) = LoopbackTransport::pair();
  1199	
  1200	    let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
  1201	    peer_a.attach_transport(tx_a);
  1202	    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
  1203	
  1204	    let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
  1205	    peer_b.attach_transport(tx_b);
  1206	    peer_b.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
  1207	
  1208	    // Both peers append concurrently.
  1209	    peer_a.append_op(add_sheet()).unwrap(); // auto-flush A → B inbox
  1210	    peer_b.append_op(put_value(0, 0, 0, 99.0)).unwrap(); // auto-flush B → A inbox
  1211	
  1212	    // Each peer drains its inbox; explicit flush after poll (since
  1213	    // poll_remote is excluded from auto-flush in V2 V3 step 1).
  1214	    let merged_a = peer_a.poll_remote().unwrap();
  1215	    let merged_b = peer_b.poll_remote().unwrap();
  1216	    assert!(merged_a >= 1, "peer A received peer B's flush");
  1217	    assert!(merged_b >= 1, "peer B received peer A's flush");
  1218	
  1219	    // Each peer flushes the merged state. Idempotency: if the merge
  1220	    // didn't actually advance state beyond what's been flushed, the
  1221	    // second-side flush short-circuits.
  1222	    let a_flushed = peer_a.flush_delta_to_transport().unwrap();
  1223	    let b_flushed = peer_b.flush_delta_to_transport().unwrap();
  1224	    // BOTH peers' state did advance (they received the other's op),
  1225	    // so both flushes fire.
  1226	    let _ = (a_flushed, b_flushed);
  1227	
  1228	    // Drain remaining inbox traffic; verify it terminates (no echo
  1229	    // loop). Cap iterations conservatively: 20 round-trips is way
  1230	    // more than the 2 ops + 2 deltas + idempotency-short-circuit
  1231	    // scenario needs.
  1232	    for _ in 0..20 {
  1233	        let polled_a = peer_a.poll_remote().unwrap();
  1234	        let polled_b = peer_b.poll_remote().unwrap();
  1235	        let flushed_a = peer_a.flush_delta_to_transport().unwrap();
  1236	        let flushed_b = peer_b.flush_delta_to_transport().unwrap();
  1237	        if polled_a == 0 && polled_b == 0 && !flushed_a && !flushed_b {
  1238	            // Steady state — no more traffic. Idempotency guard
  1239	            // working as advertised.
  1240	            break;
  1241	        }
  1242	    }
  1243	
  1244	    // Final convergence check: both peers see the same op count.
  1245	    // Loro CRDT merge is deterministic; both peers have all ops.
  1246	    assert!(peer_a.op_count() >= 2);
  1247	    assert!(peer_b.op_count() >= 2);
  1248	    assert_eq!(
  1249	        peer_a.op_count(),
  1250	        peer_b.op_count(),
  1251	        "symmetric-OnAppend peers MUST converge to the same op count"
  1252	    );
  1253	}

exec
/bin/zsh -lc 'git diff --unified=80 e5ff11d549a..HEAD -- quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-collab/tests/auto_flush.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
diff --git a/quantbook-engine/crates/ql-collab/src/session.rs b/quantbook-engine/crates/ql-collab/src/session.rs
index d4a3ae92ba3..588c07f421d 100644
--- a/quantbook-engine/crates/ql-collab/src/session.rs
+++ b/quantbook-engine/crates/ql-collab/src/session.rs
@@ -120,223 +120,222 @@ pub enum CollabSessionError {
     /// `replay_into` on the session's `OpLog` and replay failed at
     /// some op index. The fresh workbook constructed internally was
     /// in a HALF-MERGED state when the error fired and was DROPPED
     /// before the error was returned (the wrapper owns it). The
     /// session's `OpLog` is unaffected (replay reads only).
     ///
     /// Carries the underlying [`ReplayError`] via `#[source]` so
     /// callers can `match err.source()` for the original op index +
     /// diagnostic.
     #[error("replay error: {0}")]
     Replay(#[from] ReplayError),
 }
 
 /// **Phase 5.3 step 5b (2026-05-20) — production wiring closure
 /// (Opus-A Scenario E HIGH):** result of
 /// [`CollabSession::rebuild_workbook`]. Combines the replay op count
 /// with the two repair reports so callers can log a single
 /// diagnostic surface.
 ///
 /// `#[non_exhaustive]` per Codex step 5b audit LOW closure: column
 /// repair (Phase 5.3 step 5c) is expected to add another field
 /// (`column_repair: ColumnRepairReport`) — external struct literal
 /// construction is forbidden so future field additions are
 /// non-breaking.
 #[derive(Debug, Clone, Default)]
 #[non_exhaustive]
 pub struct SyncReport {
     /// Total ops applied by `replay_into`. Same as the success
     /// value of `replay_into` itself.
     pub ops_replayed: usize,
     /// Sheet rename-repair pass diagnostics (formulas rewritten,
     /// ambiguous-skipped rules).
     pub sheet_repair: SheetRepairReport,
     /// Table rename-repair pass diagnostics.
     pub table_repair: TableRepairReport,
     /// Column rename-repair pass diagnostics (Phase 5.3 step 5c —
     /// closes Opus-A megaudit V1 LIM #3 HIGH).
     pub column_repair: ColumnRepairReport,
 }
 
 /// Phase 5.3 step 5b audit closure (Opus MEDIUM-2) + step 5c update:
 /// one-line `Display` impl for log-line diagnostic use. Format:
 /// `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`.
 impl std::fmt::Display for SyncReport {
     fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
         write!(
             f,
             "sync: ops={} sheet_rewrites={}(skip={}) table_rewrites={}(skip={}) column_rewrites={}(skip={})",
             self.ops_replayed,
             self.sheet_repair.formulas_rewritten,
             self.sheet_repair.ambiguous_rules_skipped.len(),
             self.table_repair.formulas_rewritten,
             self.table_repair.ambiguous_rules_skipped.len(),
             self.column_repair.formulas_rewritten,
             self.column_repair.ambiguous_rules_skipped.len(),
         )
     }
 }
 
 /// **Phase 5.5 V2 V2 (2026-05-21):** auto-flush policy for
 /// [`CollabSession`]. Determines when (if ever) the session pushes
 /// its current snapshot through the attached transport without an
 /// explicit [`CollabSession::flush_to_transport`] call.
 ///
 /// V2 V2 (this ship) adds two variants. V2 V3 will add a `Threshold`
 /// variant for byte-budget-based batching.
 ///
 /// `#[non_exhaustive]` so adding a `Threshold(usize)` variant later
 /// is non-breaking — callers MUST handle the `_` arm in `match`.
 #[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
 #[non_exhaustive]
 pub enum AutoFlushPolicy {
     /// Default. V2 V1 behavior preserved: caller drives flush + poll
     /// explicitly via [`CollabSession::flush_to_transport`] +
     /// [`CollabSession::poll_remote`]. Auto-flush never fires.
     #[default]
     Disabled,
     /// Flush automatically after every public method that mutates the
     /// underlying `LoroDoc`. Triggers on: `append_op`, `merge_bytes`,
     /// `update_presence`, `clear_presence`, `sweep_presence`,
-    /// `undo`, `redo`.
+    /// `undo`, `redo`, `poll_remote`, `poll_remote_with_limit`.
     ///
     /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** auto-flush routes
     /// through [`flush_delta_to_transport`] (delta path) rather than
     /// [`flush_to_transport`] (full-snapshot path). Wire payload is
     /// O(per-op delta) instead of O(full state). The idempotency
     /// short-circuit means a flush after no state change is a true
     /// no-op (no transport.send invocation) — this closes the V2 V2
     /// audit echo-loop class.
     ///
+    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** `poll_remote*` now
+    /// triggers auto-flush AFTER the drain batch (one flush per
+    /// call, not per-blob) — bandwidth-efficient. Reverses the V2 V2
+    /// "receive-side excluded by design" exclusion now that V2 V3
+    /// step 1's idempotency guard prevents echo loops at the source
+    /// (Loro-deduped merge leaves VV unchanged → flush short-circuits
+    /// to `Ok(false)`). The 3-peer hub-fanout pattern now works
+    /// automatically.
+    ///
     /// Does NOT trigger on:
     /// - Accessor methods (read-only).
     /// - Undo-group boundary methods (`start_undo_group` /
     ///   `end_undo_group`) — only their inner appends fire, via
     ///   `append_op`. Each mid-group append produces ONE auto-flush;
     ///   the group is a LOCAL undo unit only (peers see each append
     ///   land independently). Phase 5.5 V2 V2 audit closure (Opus
     ///   L1) — undo-group atomicity-over-wire deferred to V2 V3.
     /// - Transport-lifecycle methods (`attach_transport` etc.).
-    /// - `poll_remote` / `poll_remote_with_limit` — **receive-side
-    ///   excluded by design** (audit-locked Phase 5.5 V2 V2, Codex
-    ///   M1 + Opus M1, 2026-05-21). When a remote feeds you their
-    ///   snapshot, your peer-fanout side is responsible for
-    ///   batching its own flushes via explicit
-    ///   [`CollabSession::flush_to_transport`] after the drain. The
-    ///   exclusion exists for two reasons: (1) avoids the echo-loop
-    ///   class with two symmetric-OnAppend peers (see caveat
-    ///   below); (2) callers polling a high-volume inbound stream
-    ///   commonly want to coalesce many merged blobs into one
-    ///   outbound flush. V2 V3 with per-transport version vectors
-    ///   will revisit (idempotent re-flush of unchanged state is
-    ///   safe under deltas).
     ///
     /// If no transport is attached, this is silently a no-op (the
     /// flush hook checks `self.transport.is_some()` first).
     ///
     /// **Partial-state contract on auto-flush error**: if the auto-
     /// flush attempt fails (transport closed, I/O error), the
     /// surrounding mutator (`append_op` etc.) returns
     /// `Err(CollabSessionError::Transport(_))`. The local mutation
     /// has ALREADY been committed to `self.log` (mutate-then-flush
     /// ordering — Loro doesn't support "ungrowing" an op log, V1
     /// limitation H7). Callers MUST treat their local state as
     /// authoritative for the local UI and either retry the flush
     /// (transport recovered) or detach the transport.
     ///
     /// **Symmetric-OnAppend (Phase 5.5 V2 V3 step 1 closure,
     /// 2026-05-21):** enabling `OnAppend` on BOTH peers of a paired
-    /// transport is now safe via the V2 V3 idempotency guard. The
+    /// transport is safe via the V2 V3 idempotency guard. The
     /// guard short-circuits `flush_delta_to_transport` when no ops
     /// have been appended since the last successful flush. A
     /// merged peer-snapshot that didn't actually advance local
     /// state (Loro CRDT dedupe) leaves the VV unchanged, so the
     /// subsequent auto-flush is a no-op send. The original V2 V2
-    /// echo-loop concern (each peer re-flushing the same snapshot)
-    /// is closed at the source. V2 V3 step 2 can then safely wire
-    /// `poll_remote` into auto-flush without re-introducing the
-    /// loop.
-    ///
-    /// Note: the `poll_remote*` exclusion above STILL applies in V2
-    /// V3 step 1 — it's wired in step 2 separately. Until step 2,
-    /// callers fanning a polled batch onward must use explicit
-    /// [`flush_delta_to_transport`] or [`flush_to_transport`].
+    /// echo-loop concern is closed at the source. With V2 V3 step 2,
+    /// `poll_remote` also auto-flushes — the round-trip back to the
+    /// SAME paired transport hits the idempotency guard if the
+    /// drained bytes were duplicates, otherwise sends the delta
+    /// (peer's Loro dedupes any ops it already has).
+    ///
+    /// **V1 limit (V2 V3 step 2)**: auto-flush from `poll_remote`
+    /// goes back to the SAME transport the bytes came from. In a
+    /// true multi-transport hub topology, the merged state would
+    /// only fan to ONE transport per session. V2 V3 step 4
+    /// (WebSocket + multi-transport routing) may add per-transport
+    /// fanout.
     OnAppend,
 }
 
 /// Per-peer collaboration state holder.
 ///
 /// Owns an `OpLog` + a stable `PeerId`. Tested with `NoopTransport`
 /// at scaffold time; Phase 5.5 will add the live transport
 /// integration via `Transport::send` / `try_recv`.
 ///
 /// The session is the engine-side handle for one peer's view of a
 /// shared workbook. Multiple peers each hold their own
 /// `CollabSession`, exchange byte blobs via [`crate::Transport`],
 /// and call `merge_bytes` to incorporate remote ops. All sessions
 /// converge to the same `OpLog` content after exchange (per Loro's
 /// CRDT determinism — Phase 5.1 audit Codex V1).
 pub struct CollabSession {
     peer_id: PeerId,
     log: OpLog,
     /// Phase 5.4 V1 — peer-local undo/redo.
     ///
     /// Drop-order note (Codex 5.4 V1 audit LOW): Rust drops fields
     /// in DECLARATION order, so this drops LAST (after `log`).
     /// That is safe here because `loro::UndoManager` owns its own
     /// `LoroDoc` clone (`loro-internal::undo:166,670`) — it doesn't
     /// borrow from `log`'s doc and won't UAF when `log` drops first.
     undo: loro::UndoManager,
     /// **Phase 5.5 V2 V1 (2026-05-19):** optional attached
     /// transport. `None` until `attach_transport` is called.
     /// Boxed + `Send` so callers can move sessions between
     /// threads with attached transports.
     ///
     /// V2 V1 scope was explicit-drive (caller invokes flush + poll
     /// on a tick). V2 V2 (2026-05-21) adds `AutoFlushPolicy::OnAppend`
     /// for IDE callers who want every mutator to propagate.
     transport: Option<Box<dyn Transport + Send>>,
     /// **Phase 5.5 V2 V2 (2026-05-21):** auto-flush policy. Default
     /// is `Disabled` so existing V2 V1 callers see no behavior
     /// change. Set via [`set_auto_flush_policy`].
     auto_flush_policy: AutoFlushPolicy,
     /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** tracks the
     /// `loro::VersionVector` at the time of the last successful
     /// `flush_to_transport` / `flush_delta_to_transport` call.
     ///
     /// `None` means "no successful flush yet" — the next delta-flush
     /// sends from the empty VV (= all ops the doc has ever seen).
     ///
     /// Lifecycle:
     /// - Initialized `None` in `new` + `from_snapshot`.
     /// - Reset to `None` on `attach_transport` (a new transport-peer
     ///   needs the full state from scratch) and `detach_transport`
     ///   (orphaned VV is meaningless).
     /// - Updated to `Some(current_vv)` after a successful send via
     ///   either `flush_to_transport` (full snapshot path) or
     ///   `flush_delta_to_transport` (V2 V3 delta path).
     /// - NOT updated on flush failure (`Err`) — caller can retry.
     last_flushed_vv: Option<loro::VersionVector>,
 }
 
 impl CollabSession {
     /// Construct a fresh session with an empty op log.
     ///
     /// Use this when no shared base snapshot exists yet (the first
     /// peer to open a brand-new workbook). The `peer_id` is wired
     /// through to the underlying `LoroDoc::set_peer_id` so Loro's
     /// CRDT merge metadata attributes this session's appends to
     /// `peer_id` (not Loro's default random per-doc id).
     ///
     /// **Caller pitfalls** (from `OpLog::set_peer_id`):
     /// - Two concurrent sessions MUST use distinct peer ids.
     ///   Duplicate ids corrupt the document via conflicting OpIDs.
     /// - Prefer per-process-random peer ids over user-/device-pinned
     ///   ids unless your transport layer enforces single-ownership.
     /// - `PeerId(u64::MAX)` is a Loro-reserved sentinel and returns
     ///   `CollabSessionError::OpLog`.
     /// - **Phase 5.2 D-1 step 4 (Opus step-2 L4 closure):**
     ///   `PeerId(0)` is reserved as `LEGACY_PEER` — the sentinel used
     ///   by the qbook envelope's pre-5.2 u32 → tagged-tuple FormatId
     ///   migration. Active multi-peer sessions MUST use a non-zero
     ///   peer id; **release builds enforce** this here so misuse
     ///   fails loudly in production too.
@@ -794,210 +793,249 @@ impl CollabSession {
     /// `Snapshot` and `Updates` blobs, so the wire format is opaque
     /// to peers — switching from snapshots to deltas is a
     /// SENDER-SIDE optimization with NO PEER-SIDE CHANGES required.
     ///
     /// # Mix-and-match with `flush_to_transport`
     ///
     /// Both APIs maintain the SHARED `last_flushed_vv` field, so
     /// callers can interleave full snapshots and deltas freely. A
     /// typical pattern:
     /// - Initial handshake: `flush_to_transport` to seed the peer
     ///   with full state.
     /// - Steady state under `OnAppend`: `maybe_auto_flush` (via
     ///   `flush_delta_to_transport`) sends tiny deltas per
     ///   mutation.
     /// - On peer reconnect: caller may choose to `flush_to_transport`
     ///   again as a safety net (Loro deduplicates on import; no
     ///   harm even if the peer already has those ops).
     ///
     /// # Error handling
     ///
     /// Same partial-state contract as `flush_to_transport`:
     /// - `CollabSessionError::OpLog` on `export_delta_bytes` failure.
     /// - `CollabSessionError::Transport` on `send` failure (Closed, Io).
     /// - `last_flushed_vv` is NOT updated on `Err` — a retry sends
     ///   the same delta the failed call would have sent.
     pub fn flush_delta_to_transport(&mut self) -> Result<bool, CollabSessionError> {
         if self.transport.is_none() {
             return Ok(false);
         }
         let current_vv = self.log.oplog_vv();
         // Idempotency short-circuit: no state change since last flush.
         // Closes V2 V2 audit M2/M3 (echo-loop). NOTE: VersionVector
         // equality is by value (Loro impls PartialEq via the
         // underlying op count per peer); a session that hasn't
         // appended/merged anything since the prior flush returns
         // Ok(false) without invoking transport.send.
         if let Some(last_vv) = self.last_flushed_vv.as_ref() {
             if last_vv == &current_vv {
                 return Ok(false);
             }
         }
         // Encode delta bytes. `from = last_flushed_vv` (or empty if None).
         let bytes = match self.last_flushed_vv.as_ref() {
             Some(from) => self.log.export_delta_bytes(from)?,
             None => self
                 .log
                 .export_delta_bytes(&loro::VersionVector::default())?,
         };
         // Now borrow transport mutably for the send. Done in two
         // phases because we needed self.log (immut) above and need
         // self.transport (mut) here — borrow-checker dance.
         let transport = self.transport.as_mut().expect("just-checked is_some above");
         transport.send(&bytes)?;
         // Advance the VV checkpoint. Only on success — Err leaves
         // last_flushed_vv at its prior value so retry sends the
         // same delta.
         self.last_flushed_vv = Some(current_vv);
         Ok(true)
     }
 
     /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** drain
     /// the attached transport's recv queue up to a default cap
     /// (`DEFAULT_POLL_REMOTE_LIMIT = 64` blobs), merging each
     /// blob into the local `OpLog`. Returns the number of blobs
     /// merged.
     ///
     /// For unbounded drain (or a different cap), use
     /// [`poll_remote_with_limit`]. The cap prevents one
     /// `poll_remote` call from starving the calling thread when
     /// a future externally-fed transport is producing faster
     /// than we drain.
     ///
     /// Returns `Ok(0)` if no transport attached.
     /// `TransportError::Closed` is handled gracefully — the
     /// trait contract guarantees Closed only after the queue
     /// drains, so the merge count reflects all queued blobs and
     /// the function returns `Ok(merged)`. `Io` errors propagate
     /// as `CollabSessionError::Transport` — any merges before
     /// the error already persist in the local `OpLog`.
     ///
-    /// **Phase 5.5 V2 V2 audit closure (Codex M1 + Opus M1,
-    /// 2026-05-21) — does NOT auto-flush.** Drains merge directly
-    /// into `self.log` (low-level `OpLog::merge_bytes`), bypassing
-    /// `CollabSession::merge_bytes` and therefore
-    /// [`AutoFlushPolicy::OnAppend`]'s post-mutator hook. **By
-    /// design** — see [`AutoFlushPolicy::OnAppend`] § "Does NOT
-    /// trigger on" for the rationale (echo-loop avoidance + caller-
-    /// batch coalescing). If you need to fan a polled batch
-    /// onward, call [`flush_to_transport`] explicitly after the
-    /// drain. V2 V3 may revisit once per-transport version vectors
-    /// make unchanged-state re-flush a no-op.
+    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** triggers ONE
+    /// auto-flush after the drain batch (not per-blob), routed
+    /// through [`flush_delta_to_transport`] when
+    /// [`auto_flush_policy`] is `OnAppend` AND at least one blob
+    /// was actually drained. V2 V3 step 1's idempotency short-
+    /// circuit handles the Loro-deduped (no-op) merge case: if
+    /// the drained bytes contained only ops already known
+    /// locally, the post-merge VV doesn't advance and the
+    /// auto-flush returns `Ok(false)` without invoking
+    /// `transport.send`.
+    ///
+    /// V2 V2 audit (Codex M1 + Opus M1) flagged the prior
+    /// exclusion of `poll_remote*` from auto-flush. V2 V3 step 1's
+    /// version-vector idempotency guard makes wiring it in safe
+    /// (no echo loop), and V2 V3 step 2 (this) reverses the
+    /// exclusion. The 3-peer fanout pattern (hub drains peer B's
+    /// blob → hub auto-flushes merged state onward) now works
+    /// automatically under `OnAppend`.
     pub fn poll_remote(&mut self) -> Result<usize, CollabSessionError> {
         self.poll_remote_with_limit(DEFAULT_POLL_REMOTE_LIMIT)
     }
 
     /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** like
     /// [`poll_remote`] but with an explicit per-call cap on the
     /// number of blobs to drain.
     ///
     /// `max_blobs == 0` is a no-op (returns `Ok(0)` even if
     /// blobs are queued — call again with a non-zero cap).
     ///
     /// Returns `Ok(merged)` where `merged <= max_blobs`. If the
     /// returned count equals `max_blobs`, more blobs may still
     /// be queued — call again. If less, the queue drained
     /// (either empty or transport reported `Closed`).
+    ///
+    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** when at least one
+    /// blob was drained AND [`auto_flush_policy`] is `OnAppend`,
+    /// fires ONE auto-flush after the loop (per-batch, not
+    /// per-blob — bandwidth efficient). Routed through
+    /// [`flush_delta_to_transport`]; V2 V3 step 1's idempotency
+    /// guard short-circuits when the post-merge VV equals the
+    /// pre-poll `last_flushed_vv` (i.e., the drained blobs only
+    /// contained ops already known locally — Loro-deduped merge).
+    ///
+    /// **Partial-state contract on auto-flush failure**: if the
+    /// post-batch auto-flush fails (closed transport, I/O error
+    /// during the send), the method returns
+    /// `Err(CollabSessionError::Transport(_))` AFTER all `merged`
+    /// blobs have been committed to `self.log`. The caller never
+    /// sees `Ok(merged)` in this case; inspect `op_count()` to
+    /// determine how many merges actually committed locally.
+    /// `last_flushed_vv` is NOT advanced on flush Err — a retry
+    /// (e.g., manual [`flush_delta_to_transport`] after detaching
+    /// and reattaching a working transport) sends the same delta the
+    /// failed call would have.
     pub fn poll_remote_with_limit(
         &mut self,
         max_blobs: usize,
     ) -> Result<usize, CollabSessionError> {
         let Some(transport) = self.transport.as_mut() else {
             return Ok(0);
         };
         let mut merged = 0usize;
         while merged < max_blobs {
             match transport.try_recv() {
                 Ok(Some(bytes)) => {
                     self.log.merge_bytes(&bytes)?;
                     merged += 1;
                 }
                 Ok(None) => break,
                 Err(TransportError::Closed) => {
                     // Trait contract: Closed only after queue drains. Any
                     // already-drained bytes are accounted in `merged`.
                     // Treat as graceful end-of-stream.
                     break;
                 }
                 Err(other) => return Err(CollabSessionError::Transport(other)),
             }
         }
+        // **Phase 5.5 V2 V3 step 2 (2026-05-21):** auto-flush after
+        // the drain batch. ONE flush per call (not per-blob) —
+        // bandwidth-efficient. V2 V3 step 1's idempotency guard at
+        // `flush_delta_to_transport` returns Ok(false) without
+        // invoking transport.send when no state advanced (Loro-
+        // deduped merge). Skip when 0 blobs drained: state didn't
+        // change locally, no point firing the VV-clone+compare
+        // path (defensive optimization).
+        if merged > 0 {
+            self.maybe_auto_flush()?;
+        }
         Ok(merged)
     }
 
     /// **Phase 5.6 V1 (2026-05-19):** write this session's own
     /// presence state into the shared `"presence"` LoroMap.
     ///
     /// Uses the session's `PeerId` as the map key (16-hex
     /// `Display` form). Subsequent calls overwrite the previous
     /// value (LWW per peer); merges with other peers'
     /// presence writes preserve all distinct peers.
     ///
     /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
     /// [`auto_flush_policy`]. Partial-state contract on flush
     /// failure: the presence write is already committed to
     /// `self.log` when the auto-flush attempt runs — same shape
     /// as `append_op` (see [`AutoFlushPolicy::OnAppend`]).
     pub fn update_presence(&mut self, state: PresenceState) -> Result<(), CollabSessionError> {
         let key = presence::peer_key(self.peer_id);
         let json = serde_json::to_string(&state).map_err(PresenceError::Serialize)?;
         self.log.presence_set(&key, &json)?;
         self.maybe_auto_flush()?;
         Ok(())
     }
 
     /// **Phase 5.6 V1 (2026-05-19):** read a peer's most recent
     /// presence state. Returns `Ok(None)` if the peer has never
     /// updated its presence in this session (or has been removed
     /// via `clear_presence`).
     pub fn peer_presence(&self, peer: PeerId) -> Result<Option<PresenceState>, CollabSessionError> {
         let key = presence::peer_key(peer);
         let Some(json) = self.log.presence_get(&key)? else {
             return Ok(None);
         };
         let state: PresenceState =
             serde_json::from_str(&json).map_err(|source| PresenceError::Deserialize {
                 peer_key: key,
                 source,
             })?;
         Ok(Some(state))
     }
 
     /// **Phase 5.6 V1 (2026-05-19):** remove this session's own
     /// presence entry from the shared map. Use this when the
     /// peer leaves the session (window close, disconnect). After
     /// removal, other peers' `peer_presence(self_id)` returns
     /// `Ok(None)`.
     ///
     /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
     /// [`auto_flush_policy`]. Same partial-state contract as
     /// `update_presence` — the removal is committed locally
     /// before the auto-flush attempt.
     pub fn clear_presence(&mut self) -> Result<(), CollabSessionError> {
         let key = presence::peer_key(self.peer_id);
         self.log.presence_remove(&key)?;
         self.maybe_auto_flush()?;
         Ok(())
     }
 
     /// **Phase 5.4 V1 (2026-05-19):** undo this session's last
     /// local op. Loro's `UndoManager` semantically inverts it by
     /// appending an inverse op (NOT by physical removal). Returns
     /// `Ok(true)` if an undo stack item was consumed,
     /// `Ok(false)` if the stack was empty.
     ///
     /// Local-only per Loro's `UndoManager` contract — remote ops
     /// from other peers (merged via `merge_bytes`) are NOT
     /// affected.
     ///
     /// Presence updates are excluded from the undo stack by
     /// construction (see `CollabSession::new`), so cursor movements
     /// don't consume undo slots.
     ///
     /// **Phase 5.5 V2 V2 + audit closure (2026-05-21):** triggers
     /// auto-flush per [`auto_flush_policy`], but ONLY when
     /// `consumed == true` (an inverse op was actually appended).
     /// `Ok(false)` on an empty stack never attempts the flush, so
     /// a closed transport cannot turn a "nothing to undo" into a
     /// spurious `Err(Transport(_))` (Codex M2 closure). Partial-
     /// state contract on flush failure when `consumed == true`:
     /// the inverse op is already committed to `self.log` — same
diff --git a/quantbook-engine/crates/ql-collab/tests/auto_flush.rs b/quantbook-engine/crates/ql-collab/tests/auto_flush.rs
index a24a19b5fc0..0a1045a248f 100644
--- a/quantbook-engine/crates/ql-collab/tests/auto_flush.rs
+++ b/quantbook-engine/crates/ql-collab/tests/auto_flush.rs
@@ -326,224 +326,300 @@ fn undo_with_item_consumed_still_fires_auto_flush() {
     s.append_op(put_value(0, 0, 0, 99.0)).unwrap();
 
     s.attach_transport(tx_a);
     s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
 
     assert_eq!(observer.pending_recv(), 0);
     let consumed = s.undo().unwrap();
     assert!(consumed, "undo stack has an item from prior append");
     assert_eq!(
         observer.pending_recv(),
         1,
         "undo with consumed=true MUST still auto-flush"
     );
 }
 
 // ===== Codex M3 closure: failure coverage on merge_bytes =====
 
 #[test]
 fn merge_bytes_with_closed_transport_surfaces_err_after_local_commit() {
     // Phase 5.5 V2 V2 audit closure (Codex M3, 2026-05-21): extend
     // failure coverage beyond append_op. merge_bytes follows the
     // same partial-state contract — the merge is committed locally
     // before the auto-flush attempt.
     let base = CollabSession::new(PeerId::new(100)).unwrap();
     let base_bytes = base.export_bytes().unwrap();
     let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
     peer_b.append_op(add_sheet()).unwrap();
     let b_bytes = peer_b.export_bytes().unwrap();
 
     let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
     let mut bad = NoopTransport::new();
     bad.close();
     peer_a.attach_transport(bad);
     peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
 
     let result = peer_a.merge_bytes(&b_bytes);
     assert!(
         matches!(
             result,
             Err(CollabSessionError::Transport(TransportError::Closed))
         ),
         "merge_bytes with closed transport MUST surface Err; got {result:?}"
     );
 
     // Partial-state contract: peer B's op is already merged locally.
     assert!(
         peer_a.op_count() >= 1,
         "merge MUST be committed locally before flush attempt; op_count={}",
         peer_a.op_count()
     );
 }
 
 // ===== Opus L1 closure: pin undo-group + OnAppend semantics =====
 
 #[test]
 fn on_append_within_undo_group_fires_per_append_not_per_group() {
     // Phase 5.5 V2 V2 audit closure (Opus L1, 2026-05-21): pin the
     // current contract — undo-group is a LOCAL undo unit; on the
     // wire each mid-group append fires its own auto-flush. If a
     // future change wants atomic-over-wire group semantics, this
     // test must be updated deliberately.
     let (tx_a, observer) = LoopbackTransport::pair();
     let mut s = CollabSession::new(PeerId::new(1)).unwrap();
     s.attach_transport(tx_a);
     s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
 
     s.start_undo_group().unwrap();
     s.append_op(add_sheet()).unwrap();
     s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
     s.end_undo_group();
 
     // V2 V2 contract: 2 auto-flushes (one per mid-group append).
     // 0 auto-flushes on end_undo_group (boundary-only, no mutation).
     assert_eq!(
         observer.pending_recv(),
         2,
         "V2 V2 contract: mid-group appends each auto-flush; group is local-only on the wire"
     );
 }
 
-// ===== Codex M1 + Opus M1 closure: poll_remote is receive-side-excluded by design =====
+// ===== V2 V3 step 2: poll_remote triggers auto-flush (inverted from V2 V2 exclusion) =====
 
 #[test]
-fn poll_remote_does_not_trigger_auto_flush_by_design() {
-    // Phase 5.5 V2 V2 audit closure (Codex M1 + Opus M1, 2026-05-21):
-    // poll_remote merges directly into self.log (low-level OpLog
-    // method) and does NOT fire maybe_auto_flush. This is audit-
-    // locked behavior — see AutoFlushPolicy::OnAppend docstring §
-    // "Does NOT trigger on" for the rationale (echo-loop avoidance
-    // + caller batches its own flushes).
+fn poll_remote_triggers_auto_flush_under_on_append() {
+    // **Phase 5.5 V2 V3 step 2 (2026-05-21):** reverses the V2 V2
+    // "receive-side excluded by design" exclusion. With V2 V3 step 1's
+    // idempotency guard in place, wiring poll_remote into auto-flush
+    // is safe — duplicate (Loro-deduped) merges leave the VV
+    // unchanged and the auto-flush short-circuits to Ok(false).
     //
-    // Topology: 3 peers. Hub (A) is connected to B via T1 (A holds
-    // tx_ab_a, B's "channel" is tx_ab_b) AND to C via T2 (A holds
-    // tx_ac_a, observer holds tx_ac_c). When B sends ops via T1, A's
-    // poll_remote drains them but does NOT auto-flush onward to C
-    // via T2. The hub pattern requires an explicit flush after the
-    // poll batch.
-    let (tx_ab_a, mut tx_ab_b) = LoopbackTransport::pair();
-    let (tx_ac_a, tx_ac_c) = LoopbackTransport::pair();
-
-    let mut hub = CollabSession::new(PeerId::new(1)).unwrap();
-    hub.attach_transport(tx_ac_a);
-    hub.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
+    // Test (replaces V2 V2 audit closure test which asserted the
+    // OPPOSITE — now the contract is inverted): peer A has OnAppend +
+    // transport. Peer B sends a blob with a NEW op into A's inbox.
+    // A's poll_remote drains it AND auto-flushes the merged delta
+    // back onto the same paired transport. tx_b (B's side) sees the
+    // round-trip arrive.
+    let (tx_a, mut tx_b) = LoopbackTransport::pair();
+    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
+    peer_a.attach_transport(tx_a);
+    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
 
-    // B pushes a byte blob into A's inbox via tx_ab_b.send.
+    // Peer B (fresh session, no transport) crafts a snapshot with one
+    // op and pushes the bytes into A's inbox via the paired endpoint.
     let mut peer_b = CollabSession::new(PeerId::new(2)).unwrap();
     peer_b.append_op(add_sheet()).unwrap();
     let b_bytes = peer_b.export_bytes().unwrap();
-    tx_ab_b.send(&b_bytes).unwrap();
+    tx_b.send(&b_bytes).unwrap();
 
-    // Hub's poll_remote uses the T2 transport (A's only attached one).
-    // But it CAN'T see T1 bytes — A doesn't have T1 attached. So this
-    // test needs the hub to swap transports temporarily.
-    //
-    // Simpler model: hub has T1 attached, drains T1's inbox via
-    // poll_remote, and we observe that T2's observer endpoint stays
-    // empty (because A doesn't have T2 in this configuration).
-    //
-    // The simplest empirical assertion is just: with poll_remote
-    // bringing in bytes, the SAME-side observer sees nothing.
-    drop(hub);
-    let mut hub = CollabSession::new(PeerId::new(1)).unwrap();
-    hub.attach_transport(tx_ab_a);
-    hub.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
+    assert_eq!(
+        tx_b.pending_recv(),
+        0,
+        "pre-poll: B's inbox is empty (A hasn't flushed anything yet)"
+    );
 
-    // Drain B's bytes into hub. After poll_remote, hub's log has B's
-    // op. But because poll_remote is excluded from auto-flush, NO
-    // bytes should appear on tx_ab_b's inbox (the hub doesn't fan
-    // its newly-merged state back through the same transport).
-    let merged = hub.poll_remote().unwrap();
-    assert_eq!(merged, 1, "hub drained 1 blob from B");
+    // A drains B's blob via poll_remote. With V2 V3 step 2, this
+    // ALSO auto-flushes the post-merge delta back through the same
+    // transport — bytes land in B's inbox.
+    let merged = peer_a.poll_remote().unwrap();
+    assert_eq!(merged, 1, "A drained 1 blob from peer B");
     assert!(
-        hub.op_count() >= 1,
-        "hub's log now contains B's op (poll_remote merged it)"
+        peer_a.op_count() >= 1,
+        "A's log now contains B's op via the merge"
+    );
+    assert_eq!(
+        tx_b.pending_recv(),
+        1,
+        "V2 V3 step 2: poll_remote MUST auto-flush after a successful drain that advanced state"
+    );
+
+    // Verify the round-trip blob can be Loro-imported (sanity).
+    let bytes_back = tx_b.try_recv().unwrap().expect("round-trip bytes");
+    let _imported = ql_oplog::OpLog::import_bytes(&bytes_back).unwrap();
+}
+
+#[test]
+fn poll_remote_idempotent_merge_short_circuits_no_wire_send() {
+    // V2 V3 step 2 + step 1 interaction: if the drained blob only
+    // contains ops the local session ALREADY knows (Loro dedupe), the
+    // post-merge VV equals last_flushed_vv, and the auto-flush
+    // short-circuits to Ok(false) without invoking transport.send.
+    //
+    // Setup: peer A appends an op, attaches a transport, flushes once
+    // (last_flushed_vv = current). Peer B sends A its EXACT current
+    // state. A's poll_remote merges (no new ops), auto-flush
+    // short-circuits — tx_b sees no new bytes from the round-trip.
+    let (tx_a, mut tx_b) = LoopbackTransport::pair();
+    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
+    peer_a.append_op(add_sheet()).unwrap();
+    peer_a.attach_transport(tx_a);
+    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
+    // Explicit first flush to set last_flushed_vv = current.
+    let _ = peer_a.flush_delta_to_transport().unwrap();
+    let baseline_recv = tx_b.try_recv().unwrap();
+    assert!(baseline_recv.is_some(), "first explicit flush delivered");
+    assert_eq!(tx_b.pending_recv(), 0);
+
+    // Send A's OWN state back to itself — simulates B sending a
+    // snapshot containing only ops A already has.
+    let a_state = peer_a.export_bytes().unwrap();
+    tx_b.send(&a_state).unwrap();
+
+    // Poll: drain succeeds, merge is a Loro-dedupe no-op, VV
+    // unchanged, auto-flush short-circuits.
+    let merged = peer_a.poll_remote().unwrap();
+    assert_eq!(merged, 1, "A drained 1 blob");
+    assert_eq!(
+        tx_b.pending_recv(),
+        0,
+        "idempotent merge: auto-flush MUST short-circuit (no wire send)"
     );
+}
+
+#[test]
+fn poll_remote_empty_drain_does_not_attempt_flush() {
+    // Defensive optimization in V2 V3 step 2: when `merged == 0`,
+    // skip the flush call entirely (no VV-clone + compare). Confirms
+    // 0-blob drain → 0 send attempt.
+    //
+    // Uses NoopTransport (records every send in `sent: Vec<Vec<u8>>`).
+    // But we can't introspect through `Box<dyn Transport>` — use
+    // LoopbackTransport with an empty inbox and assert nothing
+    // appears on the peer's pending_recv.
+    let (tx_a, observer) = LoopbackTransport::pair();
+    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
+    peer_a.append_op(add_sheet()).unwrap();
+    peer_a.attach_transport(tx_a);
+    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
+
+    // Drain on EMPTY inbox → 0 merged → no flush attempted.
+    let merged = peer_a.poll_remote().unwrap();
+    assert_eq!(merged, 0, "empty inbox → no blobs drained");
     assert_eq!(
-        tx_ab_b.pending_recv(),
+        observer.pending_recv(),
         0,
-        "poll_remote MUST NOT trigger auto-flush — no bytes back to B's inbox"
+        "0 blobs drained → no auto-flush attempted (no wire send)"
     );
+}
 
-    // T2 observer also stays empty because hub doesn't hold T2 in
-    // this configuration; this is just a sanity check.
-    let _ = tx_ac_c;
+#[test]
+fn poll_remote_with_closed_transport_returns_zero_no_flush() {
+    // When the transport is closed AND its inbox is empty, the
+    // existing graceful break in poll_remote_with_limit returns
+    // Ok(0). With V2 V3 step 2, the `merged > 0` guard prevents a
+    // spurious flush attempt (which would error on the closed
+    // transport's send side).
+    let mut bad = NoopTransport::new();
+    bad.close();
+    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
+    peer_a.append_op(add_sheet()).unwrap();
+    peer_a.attach_transport(bad);
+    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
+
+    // poll_remote should return Ok(0) (no blobs to drain, closed
+    // gracefully). The merged > 0 guard prevents an auto-flush
+    // attempt that would have errored.
+    let result = peer_a.poll_remote();
+    assert!(
+        matches!(result, Ok(0)),
+        "closed-transport empty-drain MUST return Ok(0) without attempting flush; got {result:?}"
+    );
 }
 
 // ===== Auto-flush fires on every documented mutator =====
 
 #[test]
 fn on_append_fires_on_merge_bytes() {
     let base = CollabSession::new(PeerId::new(100)).unwrap();
     let base_bytes = base.export_bytes().unwrap();
 
     // Build a peer-B snapshot with one op to merge.
     let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
     peer_b.append_op(add_sheet()).unwrap();
     let b_bytes = peer_b.export_bytes().unwrap();
 
     // Peer A: OnAppend + transport. Merging peer B's bytes must
     // auto-flush the post-merge union.
     let (tx_a, mut tx_observer) = LoopbackTransport::pair();
     let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
     peer_a.attach_transport(tx_a);
     peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
 
     assert_eq!(tx_observer.pending_recv(), 0);
     peer_a.merge_bytes(&b_bytes).unwrap();
     assert_eq!(
         tx_observer.pending_recv(),
         1,
         "merge_bytes MUST auto-flush so 3rd-party peers see the merged union"
     );
     let _ = tx_observer.try_recv();
 }
 
 #[test]
 fn on_append_fires_on_update_and_clear_presence() {
     let (tx_a, observer) = LoopbackTransport::pair();
     let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
     peer_a.attach_transport(tx_a);
     peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
 
     assert_eq!(observer.pending_recv(), 0);
     peer_a
         .update_presence(PresenceState::at_cell(0, 3, 4))
         .unwrap();
     assert_eq!(
         observer.pending_recv(),
         1,
         "update_presence MUST auto-flush — peers need cursor updates"
     );
 
     peer_a.clear_presence().unwrap();
     assert_eq!(
         observer.pending_recv(),
         2,
         "clear_presence MUST auto-flush — 'I left' must propagate"
     );
 }
 
 #[test]
 fn on_append_fires_on_sweep_presence_once_per_call() {
     // sweep_presence removes N entries but auto-flushes ONCE per call
     // (not per-key) — bandwidth-friendly batching.
     let base = CollabSession::new(PeerId::new(100)).unwrap();
     let base_bytes = base.export_bytes().unwrap();
 
     // Pre-populate presence: two peers' entries.
     let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
     peer_a
         .update_presence(PresenceState::at_cell(0, 1, 1))
         .unwrap();
     let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
     peer_b
         .update_presence(PresenceState::at_cell(0, 2, 2))
         .unwrap();
     peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();
     assert!(peer_a.peers_with_presence().unwrap().len() >= 2);
 
     // Now attach transport + OnAppend, then sweep.
     let (tx_a, observer) = LoopbackTransport::pair();
     peer_a.attach_transport(tx_a);
     peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
 

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/tests/auto_flush.rs | sed -n '390,560p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   390	    s.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   391	
   392	    s.start_undo_group().unwrap();
   393	    s.append_op(add_sheet()).unwrap();
   394	    s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
   395	    s.end_undo_group();
   396	
   397	    // V2 V2 contract: 2 auto-flushes (one per mid-group append).
   398	    // 0 auto-flushes on end_undo_group (boundary-only, no mutation).
   399	    assert_eq!(
   400	        observer.pending_recv(),
   401	        2,
   402	        "V2 V2 contract: mid-group appends each auto-flush; group is local-only on the wire"
   403	    );
   404	}
   405	
   406	// ===== V2 V3 step 2: poll_remote triggers auto-flush (inverted from V2 V2 exclusion) =====
   407	
   408	#[test]
   409	fn poll_remote_triggers_auto_flush_under_on_append() {
   410	    // **Phase 5.5 V2 V3 step 2 (2026-05-21):** reverses the V2 V2
   411	    // "receive-side excluded by design" exclusion. With V2 V3 step 1's
   412	    // idempotency guard in place, wiring poll_remote into auto-flush
   413	    // is safe — duplicate (Loro-deduped) merges leave the VV
   414	    // unchanged and the auto-flush short-circuits to Ok(false).
   415	    //
   416	    // Test (replaces V2 V2 audit closure test which asserted the
   417	    // OPPOSITE — now the contract is inverted): peer A has OnAppend +
   418	    // transport. Peer B sends a blob with a NEW op into A's inbox.
   419	    // A's poll_remote drains it AND auto-flushes the merged delta
   420	    // back onto the same paired transport. tx_b (B's side) sees the
   421	    // round-trip arrive.
   422	    let (tx_a, mut tx_b) = LoopbackTransport::pair();
   423	    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
   424	    peer_a.attach_transport(tx_a);
   425	    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   426	
   427	    // Peer B (fresh session, no transport) crafts a snapshot with one
   428	    // op and pushes the bytes into A's inbox via the paired endpoint.
   429	    let mut peer_b = CollabSession::new(PeerId::new(2)).unwrap();
   430	    peer_b.append_op(add_sheet()).unwrap();
   431	    let b_bytes = peer_b.export_bytes().unwrap();
   432	    tx_b.send(&b_bytes).unwrap();
   433	
   434	    assert_eq!(
   435	        tx_b.pending_recv(),
   436	        0,
   437	        "pre-poll: B's inbox is empty (A hasn't flushed anything yet)"
   438	    );
   439	
   440	    // A drains B's blob via poll_remote. With V2 V3 step 2, this
   441	    // ALSO auto-flushes the post-merge delta back through the same
   442	    // transport — bytes land in B's inbox.
   443	    let merged = peer_a.poll_remote().unwrap();
   444	    assert_eq!(merged, 1, "A drained 1 blob from peer B");
   445	    assert!(
   446	        peer_a.op_count() >= 1,
   447	        "A's log now contains B's op via the merge"
   448	    );
   449	    assert_eq!(
   450	        tx_b.pending_recv(),
   451	        1,
   452	        "V2 V3 step 2: poll_remote MUST auto-flush after a successful drain that advanced state"
   453	    );
   454	
   455	    // Verify the round-trip blob can be Loro-imported (sanity).
   456	    let bytes_back = tx_b.try_recv().unwrap().expect("round-trip bytes");
   457	    let _imported = ql_oplog::OpLog::import_bytes(&bytes_back).unwrap();
   458	}
   459	
   460	#[test]
   461	fn poll_remote_idempotent_merge_short_circuits_no_wire_send() {
   462	    // V2 V3 step 2 + step 1 interaction: if the drained blob only
   463	    // contains ops the local session ALREADY knows (Loro dedupe), the
   464	    // post-merge VV equals last_flushed_vv, and the auto-flush
   465	    // short-circuits to Ok(false) without invoking transport.send.
   466	    //
   467	    // Setup: peer A appends an op, attaches a transport, flushes once
   468	    // (last_flushed_vv = current). Peer B sends A its EXACT current
   469	    // state. A's poll_remote merges (no new ops), auto-flush
   470	    // short-circuits — tx_b sees no new bytes from the round-trip.
   471	    let (tx_a, mut tx_b) = LoopbackTransport::pair();
   472	    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
   473	    peer_a.append_op(add_sheet()).unwrap();
   474	    peer_a.attach_transport(tx_a);
   475	    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   476	    // Explicit first flush to set last_flushed_vv = current.
   477	    let _ = peer_a.flush_delta_to_transport().unwrap();
   478	    let baseline_recv = tx_b.try_recv().unwrap();
   479	    assert!(baseline_recv.is_some(), "first explicit flush delivered");
   480	    assert_eq!(tx_b.pending_recv(), 0);
   481	
   482	    // Send A's OWN state back to itself — simulates B sending a
   483	    // snapshot containing only ops A already has.
   484	    let a_state = peer_a.export_bytes().unwrap();
   485	    tx_b.send(&a_state).unwrap();
   486	
   487	    // Poll: drain succeeds, merge is a Loro-dedupe no-op, VV
   488	    // unchanged, auto-flush short-circuits.
   489	    let merged = peer_a.poll_remote().unwrap();
   490	    assert_eq!(merged, 1, "A drained 1 blob");
   491	    assert_eq!(
   492	        tx_b.pending_recv(),
   493	        0,
   494	        "idempotent merge: auto-flush MUST short-circuit (no wire send)"
   495	    );
   496	}
   497	
   498	#[test]
   499	fn poll_remote_empty_drain_does_not_attempt_flush() {
   500	    // Defensive optimization in V2 V3 step 2: when `merged == 0`,
   501	    // skip the flush call entirely (no VV-clone + compare). Confirms
   502	    // 0-blob drain → 0 send attempt.
   503	    //
   504	    // Uses NoopTransport (records every send in `sent: Vec<Vec<u8>>`).
   505	    // But we can't introspect through `Box<dyn Transport>` — use
   506	    // LoopbackTransport with an empty inbox and assert nothing
   507	    // appears on the peer's pending_recv.
   508	    let (tx_a, observer) = LoopbackTransport::pair();
   509	    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
   510	    peer_a.append_op(add_sheet()).unwrap();
   511	    peer_a.attach_transport(tx_a);
   512	    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   513	
   514	    // Drain on EMPTY inbox → 0 merged → no flush attempted.
   515	    let merged = peer_a.poll_remote().unwrap();
   516	    assert_eq!(merged, 0, "empty inbox → no blobs drained");
   517	    assert_eq!(
   518	        observer.pending_recv(),
   519	        0,
   520	        "0 blobs drained → no auto-flush attempted (no wire send)"
   521	    );
   522	}
   523	
   524	#[test]
   525	fn poll_remote_with_closed_transport_returns_zero_no_flush() {
   526	    // When the transport is closed AND its inbox is empty, the
   527	    // existing graceful break in poll_remote_with_limit returns
   528	    // Ok(0). With V2 V3 step 2, the `merged > 0` guard prevents a
   529	    // spurious flush attempt (which would error on the closed
   530	    // transport's send side).
   531	    let mut bad = NoopTransport::new();
   532	    bad.close();
   533	    let mut peer_a = CollabSession::new(PeerId::new(1)).unwrap();
   534	    peer_a.append_op(add_sheet()).unwrap();
   535	    peer_a.attach_transport(bad);
   536	    peer_a.set_auto_flush_policy(AutoFlushPolicy::OnAppend);
   537	
   538	    // poll_remote should return Ok(0) (no blobs to drain, closed
   539	    // gracefully). The merged > 0 guard prevents an auto-flush
   540	    // attempt that would have errored.
   541	    let result = peer_a.poll_remote();
   542	    assert!(
   543	        matches!(result, Ok(0)),
   544	        "closed-transport empty-drain MUST return Ok(0) without attempting flush; got {result:?}"
   545	    );
   546	}
   547	
   548	// ===== Auto-flush fires on every documented mutator =====
   549	
   550	#[test]
   551	fn on_append_fires_on_merge_bytes() {
   552	    let base = CollabSession::new(PeerId::new(100)).unwrap();
   553	    let base_bytes = base.export_bytes().unwrap();
   554	
   555	    // Build a peer-B snapshot with one op to merge.
   556	    let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
   557	    peer_b.append_op(add_sheet()).unwrap();
   558	    let b_bytes = peer_b.export_bytes().unwrap();
   559	
   560	    // Peer A: OnAppend + transport. Merging peer B's bytes must

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '700,835p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   700	    /// **Phase 5.5 V2 V2 (2026-05-21):** read the current auto-flush
   701	    /// policy. Default is [`AutoFlushPolicy::Disabled`].
   702	    pub fn auto_flush_policy(&self) -> AutoFlushPolicy {
   703	        self.auto_flush_policy
   704	    }
   705	
   706	    /// **Phase 5.5 V2 V2 (2026-05-21):** internal hook called by every
   707	    /// public mutator after a successful state change. Fires
   708	    /// [`flush_to_transport`] when policy is `OnAppend` AND a transport
   709	    /// is attached; otherwise no-op.
   710	    ///
   711	    /// Errors propagate to the caller; the local mutation is already
   712	    /// committed at the point this is called (per the partial-state
   713	    /// contract documented at [`AutoFlushPolicy::OnAppend`]).
   714	    ///
   715	    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** routes through
   716	    /// [`flush_delta_to_transport`] (delta path) instead of
   717	    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
   718	    /// now O(ops since last flush) instead of O(state); a flush
   719	    /// after no state change short-circuits to `Ok(false)`.
   720	    fn maybe_auto_flush(&mut self) -> Result<(), CollabSessionError> {
   721	        match self.auto_flush_policy {
   722	            AutoFlushPolicy::Disabled => Ok(()),
   723	            AutoFlushPolicy::OnAppend => {
   724	                if self.transport.is_none() {
   725	                    return Ok(());
   726	                }
   727	                let _sent = self.flush_delta_to_transport()?;
   728	                Ok(())
   729	            }
   730	        }
   731	    }
   732	
   733	    /// **Phase 5.5 V2 V1 (2026-05-19):** export the current
   734	    /// session snapshot and push it through the attached
   735	    /// transport. No-op (returns `Ok(false)`) if no transport
   736	    /// attached.
   737	    ///
   738	    /// Returns `Ok(true)` if bytes were sent. Errors:
   739	    /// - `CollabSessionError::OpLog` if `OpLog::export_bytes`
   740	    ///   fails (Loro encode error).
   741	    /// - `CollabSessionError::Transport` if `Transport::send`
   742	    ///   fails (Closed, Io).
   743	    ///
   744	    /// In both error cases the local `OpLog` is unaffected
   745	    /// (export runs first, send is the last step). Caller can
   746	    /// retry the flush after addressing the underlying cause.
   747	    ///
   748	    /// V2 V1 sends the FULL snapshot each call (O(state)). V2 V3
   749	    /// will track per-transport version vectors and send deltas
   750	    /// only.
   751	    ///
   752	    /// **Phase 5.5 V2 V2 (2026-05-21):** this method remains
   753	    /// available for explicit-drive callers regardless of
   754	    /// [`auto_flush_policy`]. With `OnAppend`, [`append_op`] etc.
   755	    /// invoke this internally — calling it directly is harmless
   756	    /// (just sends an extra idempotent snapshot). Mix-and-match
   757	    /// is supported: set `OnAppend` for steady-state appends but
   758	    /// still call `flush_to_transport` after an explicit batch
   759	    /// operation if you want a deterministic flush point.
   760	    pub fn flush_to_transport(&mut self) -> Result<bool, CollabSessionError> {
   761	        let Some(transport) = self.transport.as_mut() else {
   762	            return Ok(false);
   763	        };
   764	        let bytes = self.log.export_bytes()?;
   765	        transport.send(&bytes)?;
   766	        // **Phase 5.5 V2 V3 step 1 (2026-05-21):** advance
   767	        // `last_flushed_vv` to current. The peer now has everything
   768	        // up to this VV; subsequent `flush_delta_to_transport` calls
   769	        // send only ops appended AFTER this point. Without this
   770	        // update, a mixed-call sequence (`flush_to_transport` then
   771	        // `flush_delta_to_transport`) would re-send the snapshot's
   772	        // contents as a delta — wasted bandwidth, no correctness
   773	        // issue (Loro dedupes on import).
   774	        self.last_flushed_vv = Some(self.log.oplog_vv());
   775	        Ok(true)
   776	    }
   777	
   778	    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** export and send the
   779	    /// DELTA of ops added since the last successful flush to the
   780	    /// attached transport. Returns `Ok(true)` if bytes were sent,
   781	    /// `Ok(false)` if no transport is attached OR if no ops have
   782	    /// been appended since the last flush (idempotency short-
   783	    /// circuit — closes V2 V2 audit M2/M3 echo-loop class for
   784	    /// step 2's `poll_remote` auto-flush wiring).
   785	    ///
   786	    /// Wire bytes are `LoroDoc::ExportMode::Updates { from: last_flushed_vv }`.
   787	    /// The first flush after `attach_transport` (or after `new`)
   788	    /// sends from the empty VV — equivalent to `all_updates()` —
   789	    /// delivering the full history to the new transport-peer.
   790	    /// Subsequent flushes send only the delta since the prior flush.
   791	    ///
   792	    /// Loro's `LoroDoc::import` transparently consumes both
   793	    /// `Snapshot` and `Updates` blobs, so the wire format is opaque
   794	    /// to peers — switching from snapshots to deltas is a
   795	    /// SENDER-SIDE optimization with NO PEER-SIDE CHANGES required.
   796	    ///
   797	    /// # Mix-and-match with `flush_to_transport`
   798	    ///
   799	    /// Both APIs maintain the SHARED `last_flushed_vv` field, so
   800	    /// callers can interleave full snapshots and deltas freely. A
   801	    /// typical pattern:
   802	    /// - Initial handshake: `flush_to_transport` to seed the peer
   803	    ///   with full state.
   804	    /// - Steady state under `OnAppend`: `maybe_auto_flush` (via
   805	    ///   `flush_delta_to_transport`) sends tiny deltas per
   806	    ///   mutation.
   807	    /// - On peer reconnect: caller may choose to `flush_to_transport`
   808	    ///   again as a safety net (Loro deduplicates on import; no
   809	    ///   harm even if the peer already has those ops).
   810	    ///
   811	    /// # Error handling
   812	    ///
   813	    /// Same partial-state contract as `flush_to_transport`:
   814	    /// - `CollabSessionError::OpLog` on `export_delta_bytes` failure.
   815	    /// - `CollabSessionError::Transport` on `send` failure (Closed, Io).
   816	    /// - `last_flushed_vv` is NOT updated on `Err` — a retry sends
   817	    ///   the same delta the failed call would have sent.
   818	    pub fn flush_delta_to_transport(&mut self) -> Result<bool, CollabSessionError> {
   819	        if self.transport.is_none() {
   820	            return Ok(false);
   821	        }
   822	        let current_vv = self.log.oplog_vv();
   823	        // Idempotency short-circuit: no state change since last flush.
   824	        // Closes V2 V2 audit M2/M3 (echo-loop). NOTE: VersionVector
   825	        // equality is by value (Loro impls PartialEq via the
   826	        // underlying op count per peer); a session that hasn't
   827	        // appended/merged anything since the prior flush returns
   828	        // Ok(false) without invoking transport.send.
   829	        if let Some(last_vv) = self.last_flushed_vv.as_ref() {
   830	            if last_vv == &current_vv {
   831	                return Ok(false);
   832	            }
   833	        }
   834	        // Encode delta bytes. `from = last_flushed_vv` (or empty if None).
   835	        let bytes = match self.last_flushed_vv.as_ref() {

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '1010,1245p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '410,470p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  1010	    /// [`auto_flush_policy`]. Same partial-state contract as
  1011	    /// `update_presence` — the removal is committed locally
  1012	    /// before the auto-flush attempt.
  1013	    pub fn clear_presence(&mut self) -> Result<(), CollabSessionError> {
  1014	        let key = presence::peer_key(self.peer_id);
  1015	        self.log.presence_remove(&key)?;
  1016	        self.maybe_auto_flush()?;
  1017	        Ok(())
  1018	    }
  1019	
  1020	    /// **Phase 5.4 V1 (2026-05-19):** undo this session's last
  1021	    /// local op. Loro's `UndoManager` semantically inverts it by
  1022	    /// appending an inverse op (NOT by physical removal). Returns
  1023	    /// `Ok(true)` if an undo stack item was consumed,
  1024	    /// `Ok(false)` if the stack was empty.
  1025	    ///
  1026	    /// Local-only per Loro's `UndoManager` contract — remote ops
  1027	    /// from other peers (merged via `merge_bytes`) are NOT
  1028	    /// affected.
  1029	    ///
  1030	    /// Presence updates are excluded from the undo stack by
  1031	    /// construction (see `CollabSession::new`), so cursor movements
  1032	    /// don't consume undo slots.
  1033	    ///
  1034	    /// **Phase 5.5 V2 V2 + audit closure (2026-05-21):** triggers
  1035	    /// auto-flush per [`auto_flush_policy`], but ONLY when
  1036	    /// `consumed == true` (an inverse op was actually appended).
  1037	    /// `Ok(false)` on an empty stack never attempts the flush, so
  1038	    /// a closed transport cannot turn a "nothing to undo" into a
  1039	    /// spurious `Err(Transport(_))` (Codex M2 closure). Partial-
  1040	    /// state contract on flush failure when `consumed == true`:
  1041	    /// the inverse op is already committed to `self.log` — same
  1042	    /// shape as `append_op`.
  1043	    pub fn undo(&mut self) -> Result<bool, CollabSessionError> {
  1044	        let consumed = self.undo.undo()?;
  1045	        // **Phase 5.5 V2 V2 audit closure (Codex M2, 2026-05-21):** only
  1046	        // auto-flush when an undo item was actually consumed. The prior
  1047	        // "flush unconditionally" pattern turned `Ok(false)` into
  1048	        // `Err(Transport(_))` when the transport was closed AND the
  1049	        // undo stack was empty — spurious failure semantics. With the
  1050	        // gate, `undo` on an empty stack stays `Ok(false)` regardless
  1051	        // of transport state (no mutation, no flush attempt).
  1052	        if consumed {
  1053	            self.maybe_auto_flush()?;
  1054	        }
  1055	        Ok(consumed)
  1056	    }
  1057	
  1058	    /// **Phase 5.4 V1 (2026-05-19):** redo the last undone op.
  1059	    /// Returns `Ok(true)` if a redo stack item was consumed,
  1060	    /// `Ok(false)` if the stack was empty.
  1061	    ///
  1062	    /// **Phase 5.5 V2 V2 + audit closure (2026-05-21):** matches
  1063	    /// [`undo`] — auto-flush fires only when `consumed == true`.
  1064	    /// Partial-state contract on flush failure when consumed:
  1065	    /// the redo's appended op is already in `self.log` (mutate-
  1066	    /// then-flush).
  1067	    pub fn redo(&mut self) -> Result<bool, CollabSessionError> {
  1068	        let consumed = self.undo.redo()?;
  1069	        // Phase 5.5 V2 V2 audit closure (Codex M2): gate matches `undo`.
  1070	        if consumed {
  1071	            self.maybe_auto_flush()?;
  1072	        }
  1073	        Ok(consumed)
  1074	    }
  1075	
  1076	    /// **Phase 5.4 V1 (2026-05-19):** true iff the undo stack has
  1077	    /// at least one item.
  1078	    pub fn can_undo(&self) -> bool {
  1079	        self.undo.can_undo()
  1080	    }
  1081	
  1082	    /// **Phase 5.4 V1 (2026-05-19):** true iff the redo stack has
  1083	    /// at least one item.
  1084	    pub fn can_redo(&self) -> bool {
  1085	        self.undo.can_redo()
  1086	    }
  1087	
  1088	    /// **Phase 5.4 V1 (2026-05-19):** number of items currently
  1089	    /// on the undo stack.
  1090	    pub fn undo_count(&self) -> usize {
  1091	        self.undo.undo_count()
  1092	    }
  1093	
  1094	    /// **Phase 5.4 V1 (2026-05-19):** number of items currently
  1095	    /// on the redo stack.
  1096	    pub fn redo_count(&self) -> usize {
  1097	        self.undo.redo_count()
  1098	    }
  1099	
  1100	    /// **Phase 5.4 V1 (2026-05-19):** clear both undo and redo
  1101	    /// stacks. Use when starting a fresh logical session (e.g.
  1102	    /// opening a new workbook tab while reusing the
  1103	    /// `CollabSession` shell).
  1104	    pub fn clear_undo_stack(&self) {
  1105	        self.undo.clear();
  1106	    }
  1107	
  1108	    /// **Phase 5.4 V2 V1 (2026-05-19):** begin a new undo group.
  1109	    /// All subsequent appends merge into a SINGLE undo unit on
  1110	    /// the undo stack; one `undo()` call after `end_undo_group`
  1111	    /// reverts all of them as a unit. Useful for atomic multi-
  1112	    /// cell operations (paste, fill-down, table import) where
  1113	    /// per-cell undo would surprise the user.
  1114	    ///
  1115	    /// Pair with [`end_undo_group`]. Calling `start_undo_group`
  1116	    /// while a group is already open returns
  1117	    /// `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`
  1118	    /// deterministically (Loro 1.12.0 `loro-internal::undo:674-688`).
  1119	    /// Nesting is NOT supported.
  1120	    ///
  1121	    /// **Caller pitfall — panic / error mid-group:** if a call
  1122	    /// between `start_undo_group` and `end_undo_group` returns
  1123	    /// `Err` (via `?`) or panics, the group stays open and the
  1124	    /// next `start_undo_group` will fail with the deterministic
  1125	    /// `UndoGroupAlreadyStarted` error. **Prefer
  1126	    /// [`start_undo_group_scoped`]** (Phase 5.4 V2 V1.1 — RAII
  1127	    /// guard that auto-closes the group on scope exit, including
  1128	    /// on panic-unwind) over manual start/end pairing for any
  1129	    /// code path that can return `Err` mid-group.
  1130	    ///
  1131	    /// Closes GAP-C-04's "command grouping" half. Merge-interval
  1132	    /// auto-grouping is the complement — see
  1133	    /// [`set_undo_merge_interval`].
  1134	    pub fn start_undo_group(&mut self) -> Result<(), CollabSessionError> {
  1135	        Ok(self.undo.group_start()?)
  1136	    }
  1137	
  1138	    /// **Phase 5.4 V2 V1 (2026-05-19):** close the current undo
  1139	    /// group started by [`start_undo_group`]. All appends since
  1140	    /// the matching `start_undo_group` are now a single undo
  1141	    /// unit.
  1142	    ///
  1143	    /// Loro's `group_end` is infallible; calling it without a
  1144	    /// matching `group_start` is a no-op. Safe to call in `Drop`
  1145	    /// guards.
  1146	    pub fn end_undo_group(&mut self) {
  1147	        self.undo.group_end();
  1148	    }
  1149	
  1150	    /// **Phase 5.4 V2 V1 (2026-05-19):** set the auto-merge
  1151	    /// interval in milliseconds. Consecutive changes within this
  1152	    /// window auto-merge into a single undo unit — useful for
  1153	    /// rapid typing where per-keystroke undo is too granular.
  1154	    ///
  1155	    /// `0` (Loro default) disables auto-merge. Negative values
  1156	    /// behave as `0` (Loro stores the raw `i64` and the compare
  1157	    /// `now - last_undo_time < interval_ms` is false for any
  1158	    /// non-negative elapsed time vs a negative threshold). Phase
  1159	    /// 5.4 V1 used the default; V2 V1 callers can opt in via
  1160	    /// this method. Recommended IDE settings: 200-500 ms for
  1161	    /// typing windows.
  1162	    ///
  1163	    /// Orthogonal to [`start_undo_group`] / [`end_undo_group`] —
  1164	    /// explicit groups take precedence over the interval.
  1165	    pub fn set_undo_merge_interval(&mut self, interval_ms: i64) {
  1166	        self.undo.set_merge_interval(interval_ms);
  1167	    }
  1168	
  1169	    /// **Phase 5.4 V2 V1.1 (2026-05-19):** RAII variant of
  1170	    /// [`start_undo_group`]. Returns an [`UndoGroupGuard`] that
  1171	    /// holds a `&mut` borrow of this session; `Drop` on the
  1172	    /// guard automatically calls [`end_undo_group`].
  1173	    ///
  1174	    /// Panic-safe: if any code between this call and the guard's
  1175	    /// drop panics (including the body of a paste / fill-down /
  1176	    /// table-import operation), the guard's `Drop` still runs
  1177	    /// during unwinding and closes the group cleanly. Compare
  1178	    /// the manual start/end pattern which leaks group state on
  1179	    /// panic.
  1180	    ///
  1181	    /// Usage:
  1182	    /// ```ignore
  1183	    /// {
  1184	    ///     let mut guard = session.start_undo_group_scoped()?;
  1185	    ///     for (row, col, value) in paste_data {
  1186	    ///         guard.append_op(Op::PutValue { sheet: 0, row, col, value })?;
  1187	    ///     }
  1188	    ///     // guard drops here → end_undo_group runs.
  1189	    /// }
  1190	    /// // All N PutValue ops are now one undo unit.
  1191	    /// ```
  1192	    ///
  1193	    /// The guard implements `Deref<Target = CollabSession>` +
  1194	    /// `DerefMut`, so all of `CollabSession`'s methods are
  1195	    /// callable directly on the guard.
  1196	    ///
  1197	    /// Errors from [`start_undo_group`] propagate (nested call
  1198	    /// returns `Err(CollabSessionError::Undo(LoroError::UndoGroupAlreadyStarted))`).
  1199	    pub fn start_undo_group_scoped(&mut self) -> Result<UndoGroupGuard<'_>, CollabSessionError> {
  1200	        self.start_undo_group()?;
  1201	        Ok(UndoGroupGuard { session: self })
  1202	    }
  1203	
  1204	    /// **Phase 5.6 V2 (2026-05-19):** clear ALL presence entries
  1205	    /// from the shared `"presence"` LoroMap. Returns the number
  1206	    /// of entries removed.
  1207	    ///
  1208	    /// Use after [`from_snapshot`] when the caller wants a clean
  1209	    /// slate — without this call, presence entries persist across
  1210	    /// `.qbook` save/load (V1 known limitation: presence lives in
  1211	    /// the same `LoroDoc` whose snapshot is wrapped into the
  1212	    /// post-Tier-D3 `oplog.bin` file format).
  1213	    ///
  1214	    /// Typical pattern for "rejoin with clean presence":
  1215	    /// ```ignore
  1216	    /// let mut s = CollabSession::from_snapshot(peer_id, bytes)?;
  1217	    /// s.sweep_presence()?;
  1218	    /// // Presence is empty; first update_presence sets self fresh.
  1219	    /// ```
  1220	    ///
  1221	    /// Caller-opt-in by design: a session that WANTS to see other
  1222	    /// peers' last-known positions (e.g. an IDE rejoining a live
  1223	    /// collab session) skips the sweep.
  1224	    ///
  1225	    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers ONE auto-flush
  1226	    /// after the batch removal (not per-key — N intermediate
  1227	    /// snapshots would be wasted bandwidth). Partial-state contract
  1228	    /// on flush failure: all N presence entries are already
  1229	    /// removed locally when the auto-flush attempt runs.
  1230	    pub fn sweep_presence(&mut self) -> Result<usize, CollabSessionError> {
  1231	        let keys = self.log.presence_peers();
  1232	        let count = keys.len();
  1233	        for key in keys {
  1234	            self.log.presence_remove(&key)?;
  1235	        }
  1236	        // Phase 5.5 V2 V2: single auto-flush after the batch removal,
  1237	        // not per-key. Sending N intermediate snapshots would be wasted
  1238	        // bandwidth (peers only need the final post-sweep state).
  1239	        self.maybe_auto_flush()?;
  1240	        Ok(count)
  1241	    }
  1242	
  1243	    /// **Phase 5.6 V1 (2026-05-19):** list every peer with a
  1244	    /// presence entry in the shared map.
  1245	    ///

 succeeded in 0ms:
   410	
   411	    /// Stable peer id assigned at session creation.
   412	    pub fn peer_id(&self) -> PeerId {
   413	        self.peer_id
   414	    }
   415	
   416	    /// Append a local op. Delegates to `OpLog::append`.
   417	    ///
   418	    /// **Phase 5.5 V2 V2 (2026-05-21):** if [`auto_flush_policy`]
   419	    /// is `OnAppend` AND a transport is attached, fires
   420	    /// [`flush_to_transport`] internally after the append. Transport
   421	    /// failures during the auto-flush surface as
   422	    /// `Err(CollabSessionError::Transport(_))` AFTER the op has been
   423	    /// committed locally (partial-state contract — see
   424	    /// [`AutoFlushPolicy::OnAppend`]).
   425	    pub fn append_op(&mut self, op: Op) -> Result<(), CollabSessionError> {
   426	        self.log.append(op)?;
   427	        self.maybe_auto_flush()?;
   428	        Ok(())
   429	    }
   430	
   431	    /// Merge a remote peer's snapshot into this session's log. Loro's
   432	    /// CRDT preserves both peers' concurrent appends in deterministic
   433	    /// causal order (Fugue/origin-based with peer-id tiebreaker per
   434	    /// Phase 5.1 audit Codex V1). Returns the new `len()` after merge.
   435	    ///
   436	    /// **Phase 5.3 step 5b audit closure (Codex MEDIUM-2):** does NOT
   437	    /// auto-invoke the repair pass — audit-locked D-5.3-1 keeps repair
   438	    /// caller-driven so callers can batch multiple `merge_bytes` calls
   439	    /// before paying the replay+repair cost. Collaborative callers
   440	    /// rebuilding a workbook from the post-merge log MUST then call
   441	    /// [`Self::rebuild_workbook`] (NOT raw `replay_into`) so the
   442	    /// rename-repair pass fires and concurrent-rename formulas resolve
   443	    /// correctly. Without `rebuild_workbook`, those formulas surface
   444	    /// as `#NAME?` at recompute time.
   445	    ///
   446	    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
   447	    /// [`auto_flush_policy`]. After merging peer ops the local snapshot
   448	    /// contains the union; auto-flushing it propagates the union to
   449	    /// any third-party peer attached via the transport (3+ peer fanout
   450	    /// via this session's transport endpoint). Same partial-state
   451	    /// contract as `append_op` if the auto-flush fails — the local
   452	    /// merge is already committed.
   453	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
   454	        let new_len = self.log.merge_bytes(bytes)?;
   455	        self.maybe_auto_flush()?;
   456	        Ok(new_len)
   457	    }
   458	
   459	    /// Produce a Loro snapshot blob suitable for **transport to other
   460	    /// peers** (consumed by [`Self::merge_bytes`] on the receiving end
   461	    /// OR by `OpLog::merge_bytes` directly).
   462	    ///
   463	    /// **Phase 5.2 D-1 step 7 audit closure (2026-05-20):** these are
   464	    /// RAW Loro snapshot bytes — NOT directly suitable as
   465	    /// `.qbook/oplog.bin` file contents. The post-Tier-D3 file format
   466	    /// requires a Quantlab header (`OPLOG_MAGIC` + version u32) that
   467	    /// this function does NOT add. Use
   468	    /// `ql_io::oplog_persistence::save_workbook_with_oplog` for file
   469	    /// writes; that wrapper prepends the header. Writing raw export
   470	    /// bytes directly to `oplog.bin` would still load (via the

codex
The core code path matches the intended shape: `poll_remote_with_limit` drains through `self.log.merge_bytes` and calls `maybe_auto_flush()` once after the loop when `merged > 0`. I’m checking the adjacent mutators and doc/test consistency now.
exec
/bin/zsh -lc "nl -ba quantbook-engine/docs/architecture/ide-consumer-contract.md | sed -n '1,220p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	# IDE consumer contract
     2	
     3	**Status:** Engine Phase 2B.6 — first vertical-slice surface  
     4	**Date:** 2026-05-12  
     5	**Stability:** **DRAFT** — names + shapes will change as Engine Phase 6.1 (Stable Engine Session API) formalizes them. This document is the SPEC that 6.1 will harden.
     6	
     7	This document describes how the Quantlab IDE (`extensions/quantlab/`, a separate worktree) consumes the Quantbook engine. It is informed by the IDE-2B-01..05 acceptance criteria in `docs/MASTER-PLAN.md` Phase 2B.6 and exercised in `crates/ql-exec/tests/ide_simulation.rs`.
     8	
     9	## 1. Lifecycle (one workbook session)
    10	
    11	```text
    12	                                         ┌────────────────────────────┐
    13	   IDE opens .qbook                      │ engine state:              │
    14	   ────────────►  load_workbook_with_oplog─►  Workbook + OpLog        │
    15	                                         └────────────┬───────────────┘
    16	                                                      │
    17	                                                      ▼
    18	   user types in formula bar / pastes   ┌────────────────────────────┐
    19	   ──────────────────────────────────►  │ per-edit:                  │
    20	                                         │   WorkbookRuntime::with_oplog
    21	                                         │   .set_value / .set_formula│
    22	                                         │   .transaction().commit()  │
    23	                                         └────────────┬───────────────┘
    24	                                                      │ (mutates wb, appends ops)
    25	                                                      ▼
    26	   user saves                            ┌────────────────────────────┐
    27	   ──────────────────────────────────►  │ save_workbook_with_oplog   │
    28	                                         └────────────┬───────────────┘
    29	                                                      │
    30	   user reopens                                       ▼
    31	   ──────────────────────────────────►  load_workbook_with_oplog → restored
    32	```
    33	
    34	The IDE holds three pieces of state per open workbook:
    35	
    36	| State | Type | Lifetime |
    37	|---|---|---|
    38	| `wb` | `ql_storage::Workbook` | Open until save / close |
    39	| `oplog` | `ql_oplog::OpLog` | Open until save / close. Carries mutation history. |
    40	| `registry` | `ql_functions::FunctionRegistry` | Process-wide singleton (`default_registry()`) |
    41	
    42	`WorkbookRuntime` is **per-edit**, not per-session. It borrows `&mut wb` + `&reg` + `&mut oplog` for the duration of one user action (one set_formula call, one paste transaction, one recompute). Borrowing `&mut wb` for the runtime's lifetime prevents the IDE from reading the workbook through other paths while an edit is in flight — that's intentional. The IDE typically constructs a runtime, performs ONE operation, drops the runtime, then re-reads cells for grid rendering.
    43	
    44	Engine Phase 6.1 will formalize this as a `WorkbookSession` struct that owns wb + oplog + registry, exposing edit methods directly without the borrow dance. 2B.6 doesn't ship that — the test scaffolding in `ide_simulation.rs` documents the pattern.
    45	
    46	## 2. Operations the IDE invokes
    47	
    48	### 2.1 Open / load
    49	
    50	```rust
    51	let (wb, oplog) = ql_io::load_workbook_with_oplog(path)?;
    52	```
    53	
    54	- Loads the `.qbook/` directory.
    55	- `oplog.bin` MUST be present (Phase 2A.3.c contract; load fails with `MissingFile` otherwise).
    56	- The IDE then renders the grid by walking cells via `wb.sheet(id)?.read(row, col)` for each visible cell, and `wb.formula_at(sheet, row, col)` for the formula bar.
    57	
    58	**Tier D2 (2026-05-19, `e15e8908742`):** the persistence API moved from `ql_oplog::{load,save}_workbook_with_oplog` to `ql_io::{load,save}_workbook_with_oplog`. The old import paths fail to compile.
    59	
    60	If the workbook has no op log (legacy save or external tool), use the bare `ql_io::load_workbook(path)` and construct a fresh empty `OpLog::new()` — but note that subsequent saves via `ql_io::save_workbook_with_oplog` will write the new (empty-then-growing) log over the absent one.
    61	
    62	### 2.2 Edit a single cell
    63	
    64	User types `=A1 * 2` and hits Enter:
    65	
    66	```rust
    67	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
    68	let value = rt.set_formula(sheet, row, col, "A1 * 2")?;
    69	// value is Value::Number(20.0) given A1=10
    70	// rt drops; wb + oplog observable again
    71	```
    72	
    73	The IDE renders `value` in the cell. If `set_formula` returns `Err(RuntimeError::...)`:
    74	- The Display string is user-facing — render it in a diagnostic panel / hover tooltip.
    75	- The workbook is unchanged (no partial write, per the no-fallbacks rule).
    76	- The op log is unchanged (append-before-mutate ordering).
    77	
    78	Common error variants the IDE renders:
    79	- `RuntimeError::Lex(...)` — syntax / tokenization error (e.g., unexpected `@`).
    80	- `RuntimeError::Parse(...)` — parse error (e.g., unclosed paren).
    81	- `RuntimeError::Bind(BindError::UnresolvedName(...))` — `#NAME?` analogue.
    82	- `RuntimeError::Bind(BindError::NamedRangeInScalarContext(...))` — use SUM/AVERAGE/COUNT etc.
    83	- `RuntimeError::Bind(BindError::NamedFormulaUnsupported(...))` — named formulas are Engine Phase 4.
    84	- `RuntimeError::InvalidSheet { ... }` / `InvalidCell { ... }` — coordinate out of range.
    85	
    86	### 2.3 Edit a single cell to a literal
    87	
    88	User types `42` (no leading `=`):
    89	
    90	```rust
    91	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
    92	rt.set_value(sheet, row, col, Value::Number(42.0))?;
    93	```
    94	
    95	Sets a literal; clears any prior formula. Emits `Op::PutValue` (+ `Op::ClearFormula` if cell had a formula).
    96	
    97	### 2.4 Cancel an edit
    98	
    99	User starts typing, presses Esc. **The IDE simply does not call `set_formula` / `set_value`.** No engine state changes. No op log entry. The runtime is never constructed.
   100	
   101	This is the canonical "no-op cancel" path. The engine offers no explicit cancel API because none is needed — borrow-checked mutation requires explicit `&mut` access, and the IDE never grants it for cancelled edits.
   102	
   103	### 2.5 Paste a block
   104	
   105	User pastes 10 cells (literals + formulas):
   106	
   107	```rust
   108	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   109	{
   110	    let mut tx = rt.transaction();
   111	    for (row, col, value) in pasted_literals {
   112	        tx.put_value(sheet, row, col, value)?;
   113	    }
   114	    for (row, col, formula) in pasted_formulas {
   115	        tx.put_formula(sheet, row, col, formula)?;
   116	    }
   117	    tx.commit()?;
   118	}
   119	```
   120	
   121	The transaction:
   122	- Buffers all writes; eager bind validation surfaces formula errors BEFORE the commit (so the paste atomically succeeds or rejects).
   123	- Drop without commit = no-op (canonical "ESC cancels paste" path).
   124	- Emits exactly one `Op::BatchCommit { ops: [...] }` per commit.
   125	
   126	### 2.6 Set / remove a defined name
   127	
   128	User adds a named range in the Name Manager:
   129	
   130	```rust
   131	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   132	rt.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))?;
   133	```
   134	
   135	Emits `Op::SetName`. Returns `RuntimeError::Name(NameTableError::Reserved(...))` for reserved names (currently just `AI` per CORR-06).
   136	
   137	### 2.7 Add a sheet
   138	
   139	```rust
   140	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   141	let new_sheet_id = rt.add_sheet("Sheet2", 16_384)?;
   142	```
   143	
   144	`16_384` is the engine default chunk size; pass the same unless deliberately tuning.
   145	
   146	### 2.8 Clear a formula (keep value)
   147	
   148	User edits the formula bar to remove the leading `=` (Excel-canon: strips formula, leaves last-evaluated value as a literal):
   149	
   150	```rust
   151	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   152	rt.clear_formula(sheet, row, col)?;
   153	```
   154	
   155	Emits `Op::PutValue(current) + Op::ClearFormula` (preserves the "strip formula, keep value" semantic across replay). No-op if cell had no formula.
   156	
   157	### 2.9 Recompute on demand
   158	
   159	After an out-of-band mutation (e.g., a UDF refresh, a future connector update) the IDE forces a full recompute:
   160	
   161	```rust
   162	let mut rt = WorkbookRuntime::with_oplog(&mut wb, &reg, &mut oplog);
   163	let result = rt.recompute_all();
   164	if !result.is_complete() {
   165	    for failure in &result.failures {
   166	        // display per-cell diagnostic
   167	    }
   168	}
   169	```
   170	
   171	Hit/miss counters in the bind-plan cache visible via `rt.cache_stats()` — IDE can surface these in a status bar / debug pane (Engine Phase 6.2 wires them into the ql-profile JSON for the IDE to render).
   172	
   173	### 2.10 Save
   174	
   175	```rust
   176	ql_io::save_workbook_with_oplog(&wb, &oplog, "name", path)?;
   177	```
   178	
   179	Atomic save (`.qbook/` + `oplog.bin` ride the same temp-then-rename protocol). The op log persists in full — any future session reloading this `.qbook` sees the same history.
   180	
   181	## 3. What the IDE does NOT do
   182	
   183	- **The IDE does NOT call `Workbook::set_name`, `Workbook::add_sheet`, `Workbook::put_at`, or `Workbook::clear_formula` directly.** Those are LOW-LEVEL methods (doc-marked Phase 2B.5) used by the qbook loader, the op-log replay path, runtime-internal recompute pass 2, and tests. Direct calls bypass the op log silently — a correctness hole for product code.
   184	- **The IDE does NOT manage the op log directly.** No `oplog.append(...)` calls. The runtime emits ops; the IDE just hands the runtime an `&mut OpLog` and the runtime handles the rest.
   185	- **The IDE does NOT evaluate formulas itself.** All evaluation goes through the runtime. The IDE consumes results, never produces them.
   186	- **The IDE does NOT cache parsed/bound plans.** That's the runtime's `PlanCache`. The IDE consumes hit/miss stats for observability but never inserts directly.
   187	
   188	## 4. Engine surfaces NOT yet shipped (filed in `docs/known-gaps.md`)
   189	
   190	The IDE will need these eventually; they're not blocking the Phase 2B.6 vertical slice:
   191	
   192	- ~~**On-keystroke validation.**~~ ✅ SHIPPED in Phase 2B.7: `WorkbookRuntime::validate_formula(sheet, row, col, text) -> Result<Value, RuntimeError>` exists. Closes GAP-I-04.
   193	- ~~**Undo / redo.**~~ ✅ SHIPPED in Phase 5.4 V1/V2 V1/V2 V1.1 (2026-05-19). See `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)" — `CollabSession::{undo,redo,can_undo,can_redo,undo_count,redo_count,clear_undo_stack,start_undo_group,end_undo_group,start_undo_group_scoped,set_undo_merge_interval}`.
   194	- **Incremental dependency-aware recompute.** `recompute_all` re-walks every formula. The IDE wants "this cell changed → recompute its dependents only." GAP-R-01 (Engine Phase 3 — calcgraph integration).
   195	- **Cross-sheet diagnostics on rename.** ✅ Phase 5.2 D-3 shipped the `BindError::UnknownSheet → #NAME?` mapping. ✅ **Phase 5.3 SHIPPED 2026-05-20** — causality-aware rename-repair pass via `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` wrapper. See § 4.1 below for the IDE-facing API.
   196	- **Long-running cancellation.** No `Cancel-token` on long operations. Engine Phase 6.1 work.
   197	
   198	### 4.1 Phase 5 collaboration surface (preview — for Phase 5.7 IDE vertical slice)
   199	
   200	Phase 5 V1 (2026-05-19) added the engine-side multi-user CRDT collaboration substrate as the `ql-collab` crate. Full API inventory at `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)". IDE callers will use:
   201	
   202	- **`ql_collab::CollabSession`** — per-peer session holder. Wraps an `OpLog` + `loro::UndoManager` + optional `Box<dyn Transport>`.
   203	- **`CollabSession::new(peer_id) -> Result<Self, _>`** + **`from_snapshot(peer_id, bytes)`** — construction.
   204	- **Op log:** `append_op` / `merge_bytes` / `export_bytes`.
   205	- **Undo:** `undo` / `redo` / `start_undo_group_scoped` (returns RAII `UndoGroupGuard` — recommended for paste/fill-down/table-import).
   206	- **Transport:** `attach_transport<T: Transport + Send + 'static>` / `flush_to_transport` / `poll_remote` / `poll_remote_with_limit`. V1 ships `NoopTransport` + `LoopbackTransport::pair()` (in-process 2-peer); Phase 5.5 V2 V3 will add WebSocket.
   207	- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
   208	- **Delta flush (✅ Phase 5.5 V2 V3 step 1 SHIPPED 2026-05-21):** `CollabSession::flush_delta_to_transport()` sends only the delta of ops added since the last successful flush, using `LoroDoc::ExportMode::Updates`. Wire payload is O(per-op delta) instead of O(full state). Idempotency short-circuit: a flush after no state change returns `Ok(false)` without invoking `transport.send` — closes the V2 V2 audit echo-loop class. **Auto-flush now routes through this delta path by default** (V2 V3 step 1 reroute of `maybe_auto_flush`). Loro's `import` transparently accepts both snapshot and update bytes, so peers don't need any changes. First flush after `attach_transport` sends from the empty VV (= all ops the session has ever appended) — the new transport-peer reconstructs the full history. Use `flush_to_transport` (snapshot) for explicit-handshake / reseed flows; `flush_delta_to_transport` for steady-state syncing.
   209	- **Receive-side auto-flush (✅ Phase 5.5 V2 V3 step 2 SHIPPED 2026-05-21)**: `poll_remote` / `poll_remote_with_limit` now auto-flush after the drain batch (one flush per call, not per-blob — bandwidth-efficient) when `OnAppend` is set AND at least one blob was drained. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion now that V2 V3 step 1's idempotency guard prevents echo loops at the source. **3-peer fanout (A↔hub↔B)**: the HUB with `OnAppend` now automatically propagates peer A's writes onward to peer B without an explicit flush after the drain. **Symmetric-OnAppend**: safe — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)` (no wire send). **V1 limit**: auto-flush from `poll_remote` goes back to the SAME transport the bytes came from. In a true multi-transport hub topology (one session, multiple attached transports), only one transport receives the fanout. V2 V3 step 4 (WebSocket + multi-transport routing) may add per-transport fanout. **Partial-state contract on flush Err**: if the post-batch auto-flush fails (closed transport, I/O error), the method returns `Err(CollabSessionError::Transport(_))` AFTER all `merged` blobs have been committed to the local log. Inspect `op_count()` to determine how many merged.
   210	- **Presence:** `update_presence(state)` / `peer_presence(peer)` / `clear_presence` / `peers_with_presence` / `sweep_presence` (V2 — caller-opt-in clean-slate on rejoin).
   211	- **Post-merge rename-repair (✅ Phase 5.3 SHIPPED 2026-05-20):** after `merge_bytes`, before recompute, call `CollabSession::rebuild_workbook(&FunctionRegistry) -> Result<(Workbook, SyncReport), CollabSessionError>` to atomically chain `replay_into → repair_sheet_rename_chain → repair_table_rename_chain → repair_column_rename_chain`. Returns a FRESH workbook (caller doesn't pass a workbook by mut-ref — eliminates double-call / stale-workbook misuse class per step 5b audit closure). The `SyncReport` has a one-line `Display` impl for `log::info!` consumption: `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`. Caller-driven by design (audit-locked D-5.3-1: repair is NOT auto-invoked by `merge_bytes` so callers can batch multiple merges before paying replay+repair cost). **Without this call**, concurrent-rename formulas surface as `#NAME?` at recompute. Raw `replay_into` + per-pass repair calls remain available for diagnostic / partial-replay flows; see `crates/ql-collab/src/repair.rs` module docs § "Caller contract" for the manual sequence. Repair report types: `SheetRepairReport` + `TableRepairReport` + `ColumnRepairReport` (post-Tier-H8 rename for API symmetry; pre-H8 was `RepairReport` for sheets) — each with `formulas_rewritten: usize` + per-rename summaries + `ambiguous_rules_skipped` diagnostic surfaces. See `docs/phase5/5-3-exit-packet.md` for the full closure record.
   212	
   213	**D-1 (✅ SHIPPED 2026-05-20 — all 8 steps + 7 per-step audits + 1 megaudit):** `FormatId` is now `enum { Builtin(u32), Custom(PeerId, u32) }` in `ql-storage::format`. IDE callers MUST pattern-match the variant rather than reading `.0`. Use `FormatId::is_builtin()` / `is_custom()` / `GENERAL` accessors. For pre-D-1 bare-u32 ids (xlsx import), use `FormatId::legacy_from_u32(n)`. `Op::RegisterFormat` + `Op::SetCellFormat` carry `FormatIdWire` on the wire. `.qbook` envelope v8 carries the tagged-tuple `FormatEntryId` shape losslessly for multi-peer ids; v<8 envelopes auto-migrate. xlsx export flattens multi-peer FormatIds via dedup-by-code; non-LEGACY peer flattens reported via `XlsxExportReport.dropped_features`. xlsx import surfaces unresolved-overlay-numfmt as `report.unsupported` entries. `.qbook/oplog.bin` files wrapped in Tier D3 header (`OPLOG_MAGIC = b"QLOL"` + BE u32 `OPLOG_SCHEMA_VERSION`). `CollabSession::new` + `from_snapshot` + `OpLog::set_peer_id` assert `PeerId != 0` (release-firing). See `docs/phase5/d-1-exit-packet.md` for the full closure record.
   214	
   215	## 5. Acceptance pattern (`crates/ql-exec/tests/ide_simulation.rs`)
   216	
   217	The simulation test exercises this contract end-to-end without an actual IDE. Each `#[test]` corresponds to one of IDE-2B-01..05:
   218	
   219	| Test | Acceptance | What it proves |
   220	|---|---|---|

exec
/bin/zsh -lc 'rg -n "receive-side|poll_remote|auto-flush|OnAppend|flush_delta|same transport|skip|retry|zero|0" quantbook-engine/docs/architecture/ide-consumer-contract.md quantbook-engine/docs/MASTER-PLAN.md quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-collab/src/transport.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/phase5/v1-exit-packet.md:3:status: ACTIVE — Phase 5 V1 surface complete 2026-05-19. **D-1 SHIPPED 2026-05-20**. **5.3 SHIPPED 2026-05-20**. **5.5 V2 V2 (auto-flush) SHIPPED 2026-05-21**. **5.5 V2 V3 step 1 (version-vector delta flush) SHIPPED 2026-05-21**. **5.5 V2 V3 step 2 (poll_remote auto-flush) SHIPPED 2026-05-21**. See `docs/phase5/d-1-exit-packet.md` + `docs/phase5/5-3-exit-packet.md`. 5.5 V2 V3 steps 3-6 (offline-write queue + WebSocket impl + megaudit + exit packet), 5.7 IDE slice, and 5.8 megaudit remain.
quantbook-engine/docs/phase5/v1-exit-packet.md:4:date: 2026-05-19
quantbook-engine/docs/phase5/v1-exit-packet.md:5:updated: 2026-05-20 (post-exit-packet additions: 5.6 V2 sweep_presence + D1.a 4-cluster closure + D-1 ALL STEPS SHIPPED)
quantbook-engine/docs/phase5/v1-exit-packet.md:20:Phase 5.2 D-1 (FormatId tagged tuple) ✅ SHIPPED 2026-05-20 — see
quantbook-engine/docs/phase5/v1-exit-packet.md:22:✅ SHIPPED 2026-05-20 — see `docs/phase5/5-3-exit-packet.md`.
quantbook-engine/docs/phase5/v1-exit-packet.md:23:Phase 5.5 V2 V2 (auto-flush) ✅ SHIPPED 2026-05-21. Phase 5.5 V2 V3
quantbook-engine/docs/phase5/v1-exit-packet.md:24:step 1 (version-vector delta flush) ✅ SHIPPED 2026-05-21. Phase 5.5
quantbook-engine/docs/phase5/v1-exit-packet.md:25:V2 V3 step 2 (poll_remote auto-flush) ✅ SHIPPED 2026-05-21. Phase 5.5
quantbook-engine/docs/phase5/v1-exit-packet.md:34:| A5V1-01 | All workspace gates green | ✅ | 4222 workspace tests passing; fmt + clippy clean workspace-wide |
quantbook-engine/docs/phase5/v1-exit-packet.md:35:| A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
quantbook-engine/docs/phase5/v1-exit-packet.md:36:| A5V1-03 | `ql-collab` substantively populated | ✅ | 5 modules (peer / session / transport / presence / undo) + ~30 public methods + 67 unit tests + 1 integration test |
quantbook-engine/docs/phase5/v1-exit-packet.md:37:| A5V1-04 | Op-log + Loro merge semantics verified for multi-peer | ✅ | `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` (4 tests) + 8 paired LoopbackTransport tests + 2-peer round-trip via attached transport |
quantbook-engine/docs/phase5/v1-exit-packet.md:38:| A5V1-05 | Audit discipline preserved | ✅ | 2-way Codex + Opus audit dispatched after every substantive cycle; 7 of 10 cycles caught HIGH/MEDIUM findings convergently |
quantbook-engine/docs/phase5/v1-exit-packet.md:47:| Tier D2 | `ql-oplog → ql-io` dependency inversion | ✅ SHIPPED | `e15e8908742` |
quantbook-engine/docs/phase5/v1-exit-packet.md:50:| 5.2 D-4 | OpLog::merge_bytes + 2-peer spill probe | ✅ SHIPPED | `2f217a2067a` |
quantbook-engine/docs/phase5/v1-exit-packet.md:51:| 5.2.a | `ql-collab` scaffold (PeerId + CollabSession + Transport) | ✅ SHIPPED | `66a571b30af` |
quantbook-engine/docs/phase5/v1-exit-packet.md:52:| 5.2.b | PeerId → LoroDoc::set_peer_id wiring | ✅ SHIPPED | `ef056f50bee` + `524b5a8c231` (audit closures) |
quantbook-engine/docs/phase5/v1-exit-packet.md:53:| 5.6 V1 | Presence map (per-peer cursor + selection) | ✅ SHIPPED | `c677e244704` + `43f20abc887` (audit closures) |
quantbook-engine/docs/phase5/v1-exit-packet.md:54:| 5.4 V1 | Peer-local undo/redo via Loro UndoManager | ✅ SHIPPED | `89c02b9d83e` + `e2ba052a626` (audit closures) |
quantbook-engine/docs/phase5/v1-exit-packet.md:55:| 5.5 V1 | LoopbackTransport for 2-peer round-trip tests | ✅ SHIPPED | `3590aa6d89e` + `924750819bc` (truncation fix) + `bfa8401e1b5` (audit closures) |
quantbook-engine/docs/phase5/v1-exit-packet.md:56:| 5.5 V2 V1 | CollabSession transport wrappers (attach/detach/flush/poll) | ✅ SHIPPED | `ffd8f6e5f05` + `ad9b18fe133` (audit closures) |
quantbook-engine/docs/phase5/v1-exit-packet.md:57:| 5.4 V2 V1 | Undo grouping + merge-interval | ✅ SHIPPED | `6138a7203f6` + `e199a5fda5a` (truncation fix + audit closures) |
quantbook-engine/docs/phase5/v1-exit-packet.md:59:| **Phase 5 V1 exit packet** (this doc) | ✅ shipped | `b8b2e04e0d7` |
quantbook-engine/docs/phase5/v1-exit-packet.md:61:| D1.a cluster 1 (add_sheet_rejects test → sheets.rs) | ✅ shipped | `06252f2b638` |
quantbook-engine/docs/phase5/v1-exit-packet.md:63:| D1.a clusters 3+4 (set_formula canonicalization + drop_table) — **D1.a COMPLETE** | ✅ shipped | `93210e43567` |
quantbook-engine/docs/phase5/v1-exit-packet.md:65:**23 commits to exit-packet ship + 7 post-exit-packet commits = 30 commits total** in the Phase 5 V1 arc.
quantbook-engine/docs/phase5/v1-exit-packet.md:67:Post-exit-packet adds (2026-05-19 session-end additions):
quantbook-engine/docs/phase5/v1-exit-packet.md:69:- D1.a re-partitioning across 4 clusters (9 tests relocated; net 0 workspace test count change since these are byte-identical relocations).
quantbook-engine/docs/phase5/v1-exit-packet.md:121:    pub fn poll_remote(&mut self) -> Result<usize, _>;
quantbook-engine/docs/phase5/v1-exit-packet.md:122:    pub fn poll_remote_with_limit(&mut self, max: usize) -> Result<usize, _>;
quantbook-engine/docs/phase5/v1-exit-packet.md:153:Total: **~31 public methods + 5 types** on `ql-collab` (was 30 at exit-packet; +1 sweep_presence in V2 follow-up).
quantbook-engine/docs/phase5/v1-exit-packet.md:159:| D-1 | `FormatId` → tagged tuple `{ Builtin(u32), Custom(PeerId, u32) }` | ✅ SHIPPED 2026-05-20 — all 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit. See `docs/phase5/d-1-exit-packet.md`. |
quantbook-engine/docs/phase5/v1-exit-packet.md:162:| D-4 | Spill semantics: replay defers to recompute, not per-op | ✅ SHIPPED `2f217a2067a` |
quantbook-engine/docs/phase5/v1-exit-packet.md:166:The 2-way Codex + Opus audit rule was applied to **9 of 10** substantive cycles (5.6 V1 ran Codex-only due to Anthropic 529 outage × 3 Opus retries; 5.4 V2 V1.1 ran Codex-only as a documented follow-up to a pre-audited design).
quantbook-engine/docs/phase5/v1-exit-packet.md:174:| 5.5 V2 V1 transport wrappers | MEDIUM: poll_remote unbounded + partial-merge ambiguity | HIGH: same | Yes |
quantbook-engine/docs/phase5/v1-exit-packet.md:176:| 5.4 V2 V1.1 RAII guard | (Codex-only) PASS | (skipped — pre-audited design) | N/A |
quantbook-engine/docs/phase5/v1-exit-packet.md:190:1. Phase 5.5 V1 (`3590aa6d89e`, truncated `session.rs` + `transport.rs`) — caught by self-audit reading git diff; repaired in `924750819bc`.
quantbook-engine/docs/phase5/v1-exit-packet.md:191:2. Phase 5.4 V2 V1 (`6138a7203f6`, truncated `session.rs`) — caught by BOTH Codex + Opus 2-way audit via clean-checkout verification; repaired in `e199a5fda5a`.
quantbook-engine/docs/phase5/v1-exit-packet.md:192:3. Phase 5.4 V2 V1.1 audit-closure commit + 5.4 V2 V1 audit-closure commit + D1.a cluster 2 commit each hit `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` in the pre-commit hook (recovered via re-stage + retry; no truncation made it into the blob those times — different failure mode than incidents 1+2 but same root cause: cargo fmt × git add timing on large files).
quantbook-engine/docs/phase5/v1-exit-packet.md:207:| Phase 5.6 V1 ship + audit | 4180 (+16) |
quantbook-engine/docs/phase5/v1-exit-packet.md:210:| Phase 5.5 V2 V1 ship + audit | 4209 (+13) |
quantbook-engine/docs/phase5/v1-exit-packet.md:214:| D1.a clusters 1-4 (relocations) | **4222** (0 net; byte-identical) |
quantbook-engine/docs/phase5/v1-exit-packet.md:222:- **Phase 5.2 D-1 — FormatId tagged tuple.** ✅ **SHIPPED 2026-05-20.**
quantbook-engine/docs/phase5/v1-exit-packet.md:232:  2026-05-20** (4 days actual vs 4-7 day estimate; HEAD
quantbook-engine/docs/phase5/v1-exit-packet.md:241:  See `docs/phase5/5-3-exit-packet.md` + 20 audit transcripts at
quantbook-engine/docs/phase5/v1-exit-packet.md:242:  `docs/audits/2026-05-20-phase-5-3-*.md`. 13 V1 limitations tracked
quantbook-engine/docs/phase5/v1-exit-packet.md:245:- **Phase 5.5 V2 V2 — auto-flush on append.** ✅ **SHIPPED
quantbook-engine/docs/phase5/v1-exit-packet.md:246:  2026-05-21**. `AutoFlushPolicy::{Disabled, OnAppend}` enum on
quantbook-engine/docs/phase5/v1-exit-packet.md:248:  `OnAppend` triggers flush after every mutator (delta path in
quantbook-engine/docs/phase5/v1-exit-packet.md:255:  **SHIPPED 2026-05-21** (`603bdc9aa6c` + `e5ff11d549a`
quantbook-engine/docs/phase5/v1-exit-packet.md:256:  audit-closure). New `CollabSession::flush_delta_to_transport`
quantbook-engine/docs/phase5/v1-exit-packet.md:263:- **Phase 5.5 V2 V3 step 2 — poll_remote auto-flush.** ✅
quantbook-engine/docs/phase5/v1-exit-packet.md:264:  **SHIPPED 2026-05-21**. Wires `poll_remote*` into auto-flush
quantbook-engine/docs/phase5/v1-exit-packet.md:267:  the V2 V2 audit-locked "receive-side excluded" exclusion. 3-peer
quantbook-engine/docs/phase5/v1-exit-packet.md:268:  hub fanout now works automatically under `OnAppend`. 3 new
quantbook-engine/docs/phase5/v1-exit-packet.md:303:  across 4 commits (`06252f2b638`, `9b45ee656eb`, `4528dc62c3b`,
quantbook-engine/docs/phase5/v1-exit-packet.md:304:  `93210e43567`). 9 tests relocated to their semantically correct
quantbook-engine/docs/phase5/v1-exit-packet.md:305:  owning submodules. Pure mechanical, net 0 test count change.
quantbook-engine/docs/phase5/v1-exit-packet.md:309:  (re-stage + retry) reliable but root cause is forward work.
quantbook-engine/docs/phase5/v1-exit-packet.md:315:- `docs/known-gaps.md` — GAP-C-03 / C-04 / C-05 closed at V1; remaining items.
quantbook-engine/docs/phase5/v1-exit-packet.md:317:- `docs/audits/2026-05-19-*.md` — 23 audit transcripts across 11 audit cycles (each cycle produced 2-3 docs: Codex + Opus + Consolidated, with 5.6 V1 missing Opus due to Anthropic 529 × 3 retries and 5.4 V2 V1.1 Codex-only per documented justification).
quantbook-engine/crates/ql-collab/src/transport.rs:3://! **Phase 5.2.a (2026-05-19, scaffold):** trait shape defined.
quantbook-engine/crates/ql-collab/src/transport.rs:4://! **Phase 5.5 V1 (2026-05-19, `924750819bc`):** `LoopbackTransport`
quantbook-engine/crates/ql-collab/src/transport.rs:6://! **Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05` + audit closure):**
quantbook-engine/crates/ql-collab/src/transport.rs:9://! `flush_to_transport` / `poll_remote` (+ `poll_remote_with_limit`)).
quantbook-engine/crates/ql-collab/src/transport.rs:12://! **Phase 5.5 V2 V2 (2026-05-21):** `AutoFlushPolicy` enum on
quantbook-engine/crates/ql-collab/src/transport.rs:13://! `CollabSession`. Opt-in `OnAppend` invokes flush automatically
quantbook-engine/crates/ql-collab/src/transport.rs:17://! **Phase 5.5 V2 V3 step 1 (2026-05-21):** version-vector tracking
quantbook-engine/crates/ql-collab/src/transport.rs:19://! `CollabSession::flush_delta_to_transport` sends only the delta
quantbook-engine/crates/ql-collab/src/transport.rs:27://! **Phase 5.5 V2 V3 step 2 (2026-05-21, this ship):** wires
quantbook-engine/crates/ql-collab/src/transport.rs:28://! `poll_remote*` into auto-flush. After a successful drain
quantbook-engine/crates/ql-collab/src/transport.rs:29://! (`merged > 0`), one auto-flush fires per call (not per-blob —
quantbook-engine/crates/ql-collab/src/transport.rs:33://! hub-fanout pattern (peer A drains peer B's blob → auto-flushes
quantbook-engine/crates/ql-collab/src/transport.rs:34://! merged state onward) now works automatically under `OnAppend`.
quantbook-engine/crates/ql-collab/src/transport.rs:35://! Reverses the V2 V2 audit-locked "receive-side excluded" exclusion.
quantbook-engine/crates/ql-collab/src/transport.rs:71:    #[error("transport I/O error: {0}")]
quantbook-engine/crates/ql-collab/src/transport.rs:94:    /// transport will not retry automatically — that policy lives
quantbook-engine/crates/ql-collab/src/transport.rs:161:/// **Phase 5.5 V1 (2026-05-19):** in-process paired `Transport`
quantbook-engine/crates/ql-collab/src/transport.rs:181:/// **Phase 5.5 V2 V2 (2026-05-21):** `CollabSession` supports
quantbook-engine/crates/ql-collab/src/transport.rs:182:/// opt-in auto-flush via `AutoFlushPolicy::OnAppend` — every
quantbook-engine/crates/ql-collab/src/transport.rs:190:/// land on the wire (e.g. ordering tests). `poll_remote` does
quantbook-engine/crates/ql-collab/src/transport.rs:191:/// NOT auto-flush by design — see `AutoFlushPolicy::OnAppend` for
quantbook-engine/crates/ql-collab/src/transport.rs:231:                &self.inbox.lock().map(|q| q.len()).unwrap_or(0),
quantbook-engine/crates/ql-collab/src/transport.rs:235:                &self.outbox.lock().map(|q| q.len()).unwrap_or(0),
quantbook-engine/crates/ql-collab/src/transport.rs:280:        self.inbox.lock().map(|q| q.len()).unwrap_or(0)
quantbook-engine/crates/ql-collab/src/transport.rs:398:        for i in 0..10u8 {
quantbook-engine/crates/ql-collab/src/transport.rs:401:        for i in 0..10u8 {
quantbook-engine/crates/ql-collab/src/transport.rs:409:        assert_eq!(b.pending_recv(), 0);
quantbook-engine/crates/ql-collab/src/transport.rs:413:        assert_eq!(a.pending_recv(), 0, "a's inbox unaffected by a.send");
quantbook-engine/docs/phase5/entry-plan.md:3:status: SUPERSEDED-BY-EXIT-PACKETS — Phase 5 V1 COMPLETE 2026-05-19. **D-1 SHIPPED 2026-05-20** + **5.3 SHIPPED 2026-05-20**. See `docs/phase5/d-1-exit-packet.md` (D-1 closure) + `docs/phase5/5-3-exit-packet.md` (5.3 closure) + `docs/phase5/v1-exit-packet.md` (canonical V1 record) + `docs/phase5/d-1-starting-checklist.md` (D-1 execution-trace history). 5.5 V2 V2/V3, 5.7, and 5.8 remain.
quantbook-engine/docs/phase5/entry-plan.md:4:date: 2026-05-19
quantbook-engine/docs/phase5/entry-plan.md:11:  - e15e8908742  # Tier D2 — ql-oplog → ql-io reverse dep cleanup (Phase 4.12 Opus-C HIGH-3 closure)
quantbook-engine/docs/phase5/entry-plan.md:14:  - 2f217a2067a  # Phase 5.2 D-4 closure — 2-peer spill probe + OpLog::merge_bytes
quantbook-engine/docs/phase5/entry-plan.md:15:  - 66a571b30af  # Phase 5.2.a — ql-collab scaffold (PeerId + CollabSession + Transport)
quantbook-engine/docs/phase5/entry-plan.md:16:  - ef056f50bee  # Phase 5.2.b — wire PeerId through to LoroDoc::set_peer_id (closes handoff-audit M-8)
quantbook-engine/docs/phase5/entry-plan.md:17:  - c677e244704  # Phase 5.6 V1 — presence map (per-peer cursor + selection LoroMap LWW)
quantbook-engine/docs/phase5/entry-plan.md:18:  - 89c02b9d83e  # Phase 5.4 V1 — peer-local undo/redo via Loro UndoManager
quantbook-engine/docs/phase5/entry-plan.md:19:  - 924750819bc  # Phase 5.5 V1 — LoopbackTransport for 2-peer round-trip tests
quantbook-engine/docs/phase5/entry-plan.md:20:  - ffd8f6e5f05  # Phase 5.5 V2 V1 — CollabSession transport wrappers (attach/detach/flush/poll)
quantbook-engine/docs/phase5/entry-plan.md:21:  - 6138a7203f6  # Phase 5.4 V2 V1 — undo grouping + merge-interval
quantbook-engine/docs/phase5/entry-plan.md:23:  - b8b2e04e0d7  # Phase 5 V1 exit packet
quantbook-engine/docs/phase5/entry-plan.md:25:  - 93210e43567  # D1.a complete (Tier D1 test-cluster re-partitioning, 9 tests relocated)
quantbook-engine/docs/phase5/entry-plan.md:48:| Phase 4 semantics broad enough (value / formula / name / table / format models stable) | ✅ (4160 workspace tests, 260 fns, xlsx I/O, structured refs, locale, dates) |
quantbook-engine/docs/phase5/entry-plan.md:49:| Stable operation vocabulary from `ql-oplog` | ✅ (Phase 4.12 Opus-C HIGH-3 dependency-direction issue closed at Tier D2, `e15e8908742` — `ql-oplog` is now the dependency floor; `CellWireValue` + `NamedTargetWire` moved to `ql_oplog::wire`) |
quantbook-engine/docs/phase5/entry-plan.md:55:> **2026-05-19 status update:** Most Phase 5 prep is SHIPPED.
quantbook-engine/docs/phase5/entry-plan.md:59:> - Tier D2 (ql-oplog → ql-io reverse dep cleanup): ✅ shipped this session at `e15e8908742`.
quantbook-engine/docs/phase5/entry-plan.md:60:> - Tier D3 (oplog.bin magic bytes + version header): ✅ SHIPPED via D-1 step 7 (`0ccc859958f` + audit `0ad835f6060`).
quantbook-engine/docs/phase5/entry-plan.md:71:### Tier A — API stability (mechanical, ship-before-0.2.0)
quantbook-engine/docs/phase5/entry-plan.md:114:| 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
quantbook-engine/docs/phase5/entry-plan.md:115:| 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold; D-2/D-3/D-4; 5.2.b; **D-1 ✅ SHIPPED 2026-05-20** (all 8 steps + 7 per-step audits + 1 megaudit; see `docs/phase5/d-1-exit-packet.md`). |
quantbook-engine/docs/phase5/entry-plan.md:116:| 5.3 | Conflict Resolution Semantics | ✅ SHIPPED 2026-05-20 (4 days actual) | Causality-aware rename-repair pass for sheets + tables + columns. `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` wrapper. See `docs/phase5/5-3-exit-packet.md`. |
quantbook-engine/docs/phase5/entry-plan.md:117:| 5.4 | Undo/Redo + Operation Grouping | 1 week | **🟢 V1 + V2 V1 + V2 V1.1 SHIPPED 2026-05-19** — V1 `89c02b9d83e`: 7 undo/redo methods, presence-origin excluded. V2 V1 `6138a7203f6` + `e199a5fda5a`: grouping + merge-interval. V2 V1.1: `start_undo_group_scoped` returns `UndoGroupGuard` (RAII, panic/Err-safe). V2 V2 follow-up: push/pop listeners. |
quantbook-engine/docs/phase5/entry-plan.md:118:| 5.5 | Transport Layer + Offline Sync | 1-2 weeks | **🟡 V1 + V2 V1 + V2 V2 + V2 V3 steps 1-2 SHIPPED** — V1 `924750819bc`: `Transport` trait + `NoopTransport` + `LoopbackTransport`. V2 V1 `ffd8f6e5f05`: explicit-drive `attach/detach/has_transport` + `flush_to_transport` + `poll_remote`. V2 V2 ✅ 2026-05-21 (`51748b02944` + `b7aa4cb7bb9`): `AutoFlushPolicy::{Disabled, OnAppend}`. V2 V3 step 1 ✅ 2026-05-21 (`603bdc9aa6c` + `e5ff11d549a`): `CollabSession::flush_delta_to_transport` + `last_flushed_vv` + `OpLog::{oplog_vv, export_delta_bytes}` helpers. Auto-flush reroutes through delta path; idempotency short-circuit closes echo-loop class. **V2 V3 step 2 ✅ 2026-05-21**: wires `poll_remote*` into auto-flush (one flush per drain batch). 3-peer hub fanout now works automatically under `OnAppend`. V2 V3 steps 3-6 pending: offline-write queue + WebSocket impl + megaudit + exit packet. |
quantbook-engine/docs/phase5/entry-plan.md:119:| 5.6 | Presence + Awareness | 3-5 days | **🟢 V1 + V2 SHIPPED** — V1 `c677e244704`: `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods + 11 tests. V2 `d4b3cdb2dc2`: `sweep_presence` (caller-opt-in clean-slate; closes V1 persistence known-limitation). Remaining V2 V2: presence-changed callbacks (lower priority). |
quantbook-engine/docs/phase5/entry-plan.md:127:> **2026-05-19 update:** risks 1, 3, 4, 5 are CLOSED. Only risk 2
quantbook-engine/docs/phase5/entry-plan.md:140:   byte-for-byte identical; 4160 tests passing.
quantbook-engine/docs/phase5/entry-plan.md:142:   Tier C1 shipped at `3451d90a03f` + audit closures
quantbook-engine/docs/phase5/entry-plan.md:147:   stability docs shipped at `40bb584a25b`. Phase 5 additions
quantbook-engine/docs/phase5/entry-plan.md:148:   to `Op`, error types, etc. won't break 0.2.0 consumers.
quantbook-engine/docs/phase5/entry-plan.md:150:   2026-05-19 at Phase 5.2.b. `OpLog::set_peer_id` added; called
quantbook-engine/docs/phase5/entry-plan.md:176:- `docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md` —
quantbook-engine/docs/phase5/entry-plan.md:186:- ~~`docs/architecture/conflict-resolution.md` — at 5.3 close.~~ **Superseded**: the conflict-resolution semantics live in `docs/architecture/crdt-data-model.md` § "Conflict resolution semantics" (lines 311+) — a separate file was never created. Phase 5.3 step 5 megaudit Opus-B LOW-2 closure (2026-05-20).
quantbook-engine/docs/architecture/ide-consumer-contract.md:4:**Date:** 2026-05-12  
quantbook-engine/docs/architecture/ide-consumer-contract.md:7:This document describes how the Quantlab IDE (`extensions/quantlab/`, a separate worktree) consumes the Quantbook engine. It is informed by the IDE-2B-01..05 acceptance criteria in `docs/MASTER-PLAN.md` Phase 2B.6 and exercised in `crates/ql-exec/tests/ide_simulation.rs`.
quantbook-engine/docs/architecture/ide-consumer-contract.md:58:**Tier D2 (2026-05-19, `e15e8908742`):** the persistence API moved from `ql_oplog::{load,save}_workbook_with_oplog` to `ql_io::{load,save}_workbook_with_oplog`. The old import paths fail to compile.
quantbook-engine/docs/architecture/ide-consumer-contract.md:69:// value is Value::Number(20.0) given A1=10
quantbook-engine/docs/architecture/ide-consumer-contract.md:92:rt.set_value(sheet, row, col, Value::Number(42.0))?;
quantbook-engine/docs/architecture/ide-consumer-contract.md:105:User pastes 10 cells (literals + formulas):
quantbook-engine/docs/architecture/ide-consumer-contract.md:132:rt.set_name("TaxRate", NamedTarget::Constant(Value::Number(0.21)))?;
quantbook-engine/docs/architecture/ide-consumer-contract.md:135:Emits `Op::SetName`. Returns `RuntimeError::Name(NameTableError::Reserved(...))` for reserved names (currently just `AI` per CORR-06).
quantbook-engine/docs/architecture/ide-consumer-contract.md:173:### 2.10 Save
quantbook-engine/docs/architecture/ide-consumer-contract.md:192:- ~~**On-keystroke validation.**~~ ✅ SHIPPED in Phase 2B.7: `WorkbookRuntime::validate_formula(sheet, row, col, text) -> Result<Value, RuntimeError>` exists. Closes GAP-I-04.
quantbook-engine/docs/architecture/ide-consumer-contract.md:193:- ~~**Undo / redo.**~~ ✅ SHIPPED in Phase 5.4 V1/V2 V1/V2 V1.1 (2026-05-19). See `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)" — `CollabSession::{undo,redo,can_undo,can_redo,undo_count,redo_count,clear_undo_stack,start_undo_group,end_undo_group,start_undo_group_scoped,set_undo_merge_interval}`.
quantbook-engine/docs/architecture/ide-consumer-contract.md:194:- **Incremental dependency-aware recompute.** `recompute_all` re-walks every formula. The IDE wants "this cell changed → recompute its dependents only." GAP-R-01 (Engine Phase 3 — calcgraph integration).
quantbook-engine/docs/architecture/ide-consumer-contract.md:195:- **Cross-sheet diagnostics on rename.** ✅ Phase 5.2 D-3 shipped the `BindError::UnknownSheet → #NAME?` mapping. ✅ **Phase 5.3 SHIPPED 2026-05-20** — causality-aware rename-repair pass via `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` wrapper. See § 4.1 below for the IDE-facing API.
quantbook-engine/docs/architecture/ide-consumer-contract.md:200:Phase 5 V1 (2026-05-19) added the engine-side multi-user CRDT collaboration substrate as the `ql-collab` crate. Full API inventory at `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)". IDE callers will use:
quantbook-engine/docs/architecture/ide-consumer-contract.md:206:- **Transport:** `attach_transport<T: Transport + Send + 'static>` / `flush_to_transport` / `poll_remote` / `poll_remote_with_limit`. V1 ships `NoopTransport` + `LoopbackTransport::pair()` (in-process 2-peer); Phase 5.5 V2 V3 will add WebSocket.
quantbook-engine/docs/architecture/ide-consumer-contract.md:207:- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
quantbook-engine/docs/architecture/ide-consumer-contract.md:208:- **Delta flush (✅ Phase 5.5 V2 V3 step 1 SHIPPED 2026-05-21):** `CollabSession::flush_delta_to_transport()` sends only the delta of ops added since the last successful flush, using `LoroDoc::ExportMode::Updates`. Wire payload is O(per-op delta) instead of O(full state). Idempotency short-circuit: a flush after no state change returns `Ok(false)` without invoking `transport.send` — closes the V2 V2 audit echo-loop class. **Auto-flush now routes through this delta path by default** (V2 V3 step 1 reroute of `maybe_auto_flush`). Loro's `import` transparently accepts both snapshot and update bytes, so peers don't need any changes. First flush after `attach_transport` sends from the empty VV (= all ops the session has ever appended) — the new transport-peer reconstructs the full history. Use `flush_to_transport` (snapshot) for explicit-handshake / reseed flows; `flush_delta_to_transport` for steady-state syncing.
quantbook-engine/docs/architecture/ide-consumer-contract.md:209:- **Receive-side auto-flush (✅ Phase 5.5 V2 V3 step 2 SHIPPED 2026-05-21)**: `poll_remote` / `poll_remote_with_limit` now auto-flush after the drain batch (one flush per call, not per-blob — bandwidth-efficient) when `OnAppend` is set AND at least one blob was drained. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion now that V2 V3 step 1's idempotency guard prevents echo loops at the source. **3-peer fanout (A↔hub↔B)**: the HUB with `OnAppend` now automatically propagates peer A's writes onward to peer B without an explicit flush after the drain. **Symmetric-OnAppend**: safe — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)` (no wire send). **V1 limit**: auto-flush from `poll_remote` goes back to the SAME transport the bytes came from. In a true multi-transport hub topology (one session, multiple attached transports), only one transport receives the fanout. V2 V3 step 4 (WebSocket + multi-transport routing) may add per-transport fanout. **Partial-state contract on flush Err**: if the post-batch auto-flush fails (closed transport, I/O error), the method returns `Err(CollabSessionError::Transport(_))` AFTER all `merged` blobs have been committed to the local log. Inspect `op_count()` to determine how many merged.
quantbook-engine/docs/architecture/ide-consumer-contract.md:211:- **Post-merge rename-repair (✅ Phase 5.3 SHIPPED 2026-05-20):** after `merge_bytes`, before recompute, call `CollabSession::rebuild_workbook(&FunctionRegistry) -> Result<(Workbook, SyncReport), CollabSessionError>` to atomically chain `replay_into → repair_sheet_rename_chain → repair_table_rename_chain → repair_column_rename_chain`. Returns a FRESH workbook (caller doesn't pass a workbook by mut-ref — eliminates double-call / stale-workbook misuse class per step 5b audit closure). The `SyncReport` has a one-line `Display` impl for `log::info!` consumption: `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`. Caller-driven by design (audit-locked D-5.3-1: repair is NOT auto-invoked by `merge_bytes` so callers can batch multiple merges before paying replay+repair cost). **Without this call**, concurrent-rename formulas surface as `#NAME?` at recompute. Raw `replay_into` + per-pass repair calls remain available for diagnostic / partial-replay flows; see `crates/ql-collab/src/repair.rs` module docs § "Caller contract" for the manual sequence. Repair report types: `SheetRepairReport` + `TableRepairReport` + `ColumnRepairReport` (post-Tier-H8 rename for API symmetry; pre-H8 was `RepairReport` for sheets) — each with `formulas_rewritten: usize` + per-rename summaries + `ambiguous_rules_skipped` diagnostic surfaces. See `docs/phase5/5-3-exit-packet.md` for the full closure record.
quantbook-engine/docs/architecture/ide-consumer-contract.md:213:**D-1 (✅ SHIPPED 2026-05-20 — all 8 steps + 7 per-step audits + 1 megaudit):** `FormatId` is now `enum { Builtin(u32), Custom(PeerId, u32) }` in `ql-storage::format`. IDE callers MUST pattern-match the variant rather than reading `.0`. Use `FormatId::is_builtin()` / `is_custom()` / `GENERAL` accessors. For pre-D-1 bare-u32 ids (xlsx import), use `FormatId::legacy_from_u32(n)`. `Op::RegisterFormat` + `Op::SetCellFormat` carry `FormatIdWire` on the wire. `.qbook` envelope v8 carries the tagged-tuple `FormatEntryId` shape losslessly for multi-peer ids; v<8 envelopes auto-migrate. xlsx export flattens multi-peer FormatIds via dedup-by-code; non-LEGACY peer flattens reported via `XlsxExportReport.dropped_features`. xlsx import surfaces unresolved-overlay-numfmt as `report.unsupported` entries. `.qbook/oplog.bin` files wrapped in Tier D3 header (`OPLOG_MAGIC = b"QLOL"` + BE u32 `OPLOG_SCHEMA_VERSION`). `CollabSession::new` + `from_snapshot` + `OpLog::set_peer_id` assert `PeerId != 0` (release-firing). See `docs/phase5/d-1-exit-packet.md` for the full closure record.
quantbook-engine/docs/architecture/ide-consumer-contract.md:217:The simulation test exercises this contract end-to-end without an actual IDE. Each `#[test]` corresponds to one of IDE-2B-01..05:
quantbook-engine/docs/architecture/ide-consumer-contract.md:221:| `ide_01_formula_edit_returns_value` | IDE-2B-01 | `set_formula` returns the evaluated Value; IDE can render it |
quantbook-engine/docs/architecture/ide-consumer-contract.md:222:| `ide_02_bind_errors_carry_user_facing_display` | IDE-2B-02 | Errors round-trip with non-empty Display strings; no fallback values |
quantbook-engine/docs/architecture/ide-consumer-contract.md:223:| `ide_03_cancel_pattern_no_state_change` | IDE-2B-03 | The borrow-check-enforced "no call = no mutation" pattern works |
quantbook-engine/docs/architecture/ide-consumer-contract.md:224:| `ide_04_paste_block_via_transaction` | IDE-2B-04 | Transaction commit emits exactly one BatchCommit; partial drop = no state |
quantbook-engine/docs/architecture/ide-consumer-contract.md:225:| `ide_05_save_reload_preserves_state_and_oplog` | IDE-2B-05 | Round-trip preserves workbook + oplog length + visible cell values |
quantbook-engine/crates/ql-collab/src/session.rs:3://! **Phase 5.2.a (2026-05-19, scaffold ship):** wraps `ql_oplog::OpLog`
quantbook-engine/crates/ql-collab/src/session.rs:8://!   `89c02b9d83e`: 7 undo/redo methods. V2 V1 `6138a7203f6` +
quantbook-engine/crates/ql-collab/src/session.rs:14://!   `924750819bc` (LoopbackTransport for in-process 2-peer
quantbook-engine/crates/ql-collab/src/session.rs:15://!   tests). V2 V1 shipped at `ffd8f6e5f05` —
quantbook-engine/crates/ql-collab/src/session.rs:17://!   `flush_to_transport` + `poll_remote` (+ `_with_limit`)
quantbook-engine/crates/ql-collab/src/session.rs:19://!   on a tick). V2 V2 / V3 pending — auto-flush + version-
quantbook-engine/crates/ql-collab/src/session.rs:21://! - ~~**Phase 5.6**~~ ✅ V1 + V2 shipped — V1 `c677e244704`:
quantbook-engine/crates/ql-collab/src/session.rs:28://! What ships in 5.2.a (5.2.b update 2026-05-19):
quantbook-engine/crates/ql-collab/src/session.rs:63:/// **Phase 5.5 V2 V1 audit closure (2026-05-19):** default cap on
quantbook-engine/crates/ql-collab/src/session.rs:64:/// the number of blobs `CollabSession::poll_remote` drains per
quantbook-engine/crates/ql-collab/src/session.rs:67:/// Callers wanting a different bound use `poll_remote_with_limit`.
quantbook-engine/crates/ql-collab/src/session.rs:85:    #[error("op log error: {0}")]
quantbook-engine/crates/ql-collab/src/session.rs:90:    #[error("presence error: {0}")]
quantbook-engine/crates/ql-collab/src/session.rs:97:    #[error("undo/redo error: {0}")]
quantbook-engine/crates/ql-collab/src/session.rs:100:    /// **Phase 5.5 V2 (2026-05-19):** the attached `Transport`
quantbook-engine/crates/ql-collab/src/session.rs:105:    /// `Transport::send`). Caller can retry the flush.
quantbook-engine/crates/ql-collab/src/session.rs:107:    /// For `poll_remote`: any bytes successfully drained BEFORE
quantbook-engine/crates/ql-collab/src/session.rs:111:    /// handled gracefully by `poll_remote` itself (returns
quantbook-engine/crates/ql-collab/src/session.rs:114:    /// of retrying poll.
quantbook-engine/crates/ql-collab/src/session.rs:115:    #[error("transport error: {0}")]
quantbook-engine/crates/ql-collab/src/session.rs:118:    /// **Phase 5.3 step 5b (2026-05-20) — production wiring closure
quantbook-engine/crates/ql-collab/src/session.rs:129:    #[error("replay error: {0}")]
quantbook-engine/crates/ql-collab/src/session.rs:133:/// **Phase 5.3 step 5b (2026-05-20) — production wiring closure
quantbook-engine/crates/ql-collab/src/session.rs:151:    /// ambiguous-skipped rules).
quantbook-engine/crates/ql-collab/src/session.rs:162:/// `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`.
quantbook-engine/crates/ql-collab/src/session.rs:167:            "sync: ops={} sheet_rewrites={}(skip={}) table_rewrites={}(skip={}) column_rewrites={}(skip={})",
quantbook-engine/crates/ql-collab/src/session.rs:170:            self.sheet_repair.ambiguous_rules_skipped.len(),
quantbook-engine/crates/ql-collab/src/session.rs:172:            self.table_repair.ambiguous_rules_skipped.len(),
quantbook-engine/crates/ql-collab/src/session.rs:174:            self.column_repair.ambiguous_rules_skipped.len(),
quantbook-engine/crates/ql-collab/src/session.rs:179:/// **Phase 5.5 V2 V2 (2026-05-21):** auto-flush policy for
quantbook-engine/crates/ql-collab/src/session.rs:194:    /// [`CollabSession::poll_remote`]. Auto-flush never fires.
quantbook-engine/crates/ql-collab/src/session.rs:200:    /// `undo`, `redo`, `poll_remote`, `poll_remote_with_limit`.
quantbook-engine/crates/ql-collab/src/session.rs:202:    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** auto-flush routes
quantbook-engine/crates/ql-collab/src/session.rs:203:    /// through [`flush_delta_to_transport`] (delta path) rather than
quantbook-engine/crates/ql-collab/src/session.rs:210:    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** `poll_remote*` now
quantbook-engine/crates/ql-collab/src/session.rs:211:    /// triggers auto-flush AFTER the drain batch (one flush per
quantbook-engine/crates/ql-collab/src/session.rs:213:    /// "receive-side excluded by design" exclusion now that V2 V3
quantbook-engine/crates/ql-collab/src/session.rs:223:    ///   `append_op`. Each mid-group append produces ONE auto-flush;
quantbook-engine/crates/ql-collab/src/session.rs:232:    /// **Partial-state contract on auto-flush error**: if the auto-
quantbook-engine/crates/ql-collab/src/session.rs:239:    /// authoritative for the local UI and either retry the flush
quantbook-engine/crates/ql-collab/src/session.rs:242:    /// **Symmetric-OnAppend (Phase 5.5 V2 V3 step 1 closure,
quantbook-engine/crates/ql-collab/src/session.rs:243:    /// 2026-05-21):** enabling `OnAppend` on BOTH peers of a paired
quantbook-engine/crates/ql-collab/src/session.rs:245:    /// guard short-circuits `flush_delta_to_transport` when no ops
quantbook-engine/crates/ql-collab/src/session.rs:249:    /// subsequent auto-flush is a no-op send. The original V2 V2
quantbook-engine/crates/ql-collab/src/session.rs:251:    /// `poll_remote` also auto-flushes — the round-trip back to the
quantbook-engine/crates/ql-collab/src/session.rs:256:    /// **V1 limit (V2 V3 step 2)**: auto-flush from `poll_remote`
quantbook-engine/crates/ql-collab/src/session.rs:262:    OnAppend,
quantbook-engine/crates/ql-collab/src/session.rs:285:    /// `LoroDoc` clone (`loro-internal::undo:166,670`) — it doesn't
quantbook-engine/crates/ql-collab/src/session.rs:288:    /// **Phase 5.5 V2 V1 (2026-05-19):** optional attached
quantbook-engine/crates/ql-collab/src/session.rs:294:    /// on a tick). V2 V2 (2026-05-21) adds `AutoFlushPolicy::OnAppend`
quantbook-engine/crates/ql-collab/src/session.rs:297:    /// **Phase 5.5 V2 V2 (2026-05-21):** auto-flush policy. Default
quantbook-engine/crates/ql-collab/src/session.rs:301:    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** tracks the
quantbook-engine/crates/ql-collab/src/session.rs:303:    /// `flush_to_transport` / `flush_delta_to_transport` call.
quantbook-engine/crates/ql-collab/src/session.rs:315:    ///   `flush_delta_to_transport` (V2 V3 delta path).
quantbook-engine/crates/ql-collab/src/session.rs:316:    /// - NOT updated on flush failure (`Err`) — caller can retry.
quantbook-engine/crates/ql-collab/src/session.rs:337:    ///   `PeerId(0)` is reserved as `LEGACY_PEER` — the sentinel used
quantbook-engine/crates/ql-collab/src/session.rs:339:    ///   migration. Active multi-peer sessions MUST use a non-zero
quantbook-engine/crates/ql-collab/src/session.rs:344:    /// 2026-05-20):** the prior `debug_assert_ne!` was a no-op in
quantbook-engine/crates/ql-collab/src/session.rs:351:            0,
quantbook-engine/crates/ql-collab/src/session.rs:352:            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
quantbook-engine/crates/ql-collab/src/session.rs:353:             Active CollabSession peers MUST use a non-zero PeerId."
quantbook-engine/crates/ql-collab/src/session.rs:386:    ///   `PeerId(0)` is `LEGACY_PEER` — debug-asserted just like
quantbook-engine/crates/ql-collab/src/session.rs:388:    ///   active sessions and must use a non-zero peer id.
quantbook-engine/crates/ql-collab/src/session.rs:390:        // Step 8 megaudit closure (Opus-B HIGH-1, 2026-05-20):
quantbook-engine/crates/ql-collab/src/session.rs:394:            0,
quantbook-engine/crates/ql-collab/src/session.rs:395:            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
quantbook-engine/crates/ql-collab/src/session.rs:396:             Snapshot-join CollabSession peers MUST use a non-zero PeerId, same as `new`."
quantbook-engine/crates/ql-collab/src/session.rs:418:    /// **Phase 5.5 V2 V2 (2026-05-21):** if [`auto_flush_policy`]
quantbook-engine/crates/ql-collab/src/session.rs:419:    /// is `OnAppend` AND a transport is attached, fires
quantbook-engine/crates/ql-collab/src/session.rs:421:    /// failures during the auto-flush surface as
quantbook-engine/crates/ql-collab/src/session.rs:424:    /// [`AutoFlushPolicy::OnAppend`]).
quantbook-engine/crates/ql-collab/src/session.rs:446:    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
quantbook-engine/crates/ql-collab/src/session.rs:448:    /// contains the union; auto-flushing it propagates the union to
quantbook-engine/crates/ql-collab/src/session.rs:451:    /// contract as `append_op` if the auto-flush fails — the local
quantbook-engine/crates/ql-collab/src/session.rs:463:    /// **Phase 5.2 D-1 step 7 audit closure (2026-05-20):** these are
quantbook-engine/crates/ql-collab/src/session.rs:503:    /// **Phase 5.3 step 5b + 5b audit closure + step 5c (2026-05-20) —
quantbook-engine/crates/ql-collab/src/session.rs:539:    ///   (empirical probe P10).
quantbook-engine/crates/ql-collab/src/session.rs:620:    /// **Phase 5.5 V2 V1 (2026-05-19):** attach a `Transport`
quantbook-engine/crates/ql-collab/src/session.rs:623:    /// snapshot through it; [`poll_remote`] drains incoming
quantbook-engine/crates/ql-collab/src/session.rs:629:    /// **Phase 5.5 V2 V2 (2026-05-21):** V2 V1 was explicit-drive
quantbook-engine/crates/ql-collab/src/session.rs:631:    /// the opt-in [`AutoFlushPolicy::OnAppend`] for IDE callers who
quantbook-engine/crates/ql-collab/src/session.rs:640:        // **Phase 5.5 V2 V3 step 1 (2026-05-21):** reset `last_flushed_vv`
quantbook-engine/crates/ql-collab/src/session.rs:642:        // session's ops, so the next `flush_delta_to_transport` must
quantbook-engine/crates/ql-collab/src/session.rs:645:        // 0..stale_vv and end up with a corrupt view.
quantbook-engine/crates/ql-collab/src/session.rs:650:    /// **Phase 5.5 V2 V1 (2026-05-19):** detach the current
quantbook-engine/crates/ql-collab/src/session.rs:660:    /// **Phase 5.5 V2 V1 (2026-05-19):** true iff a transport is
quantbook-engine/crates/ql-collab/src/session.rs:666:    /// **Phase 5.5 V2 V2 (2026-05-21):** set the auto-flush policy
quantbook-engine/crates/ql-collab/src/session.rs:671:    /// [`AutoFlushPolicy::OnAppend`] makes every public mutator on
quantbook-engine/crates/ql-collab/src/session.rs:674:    /// [`flush_delta_to_transport`] internally — IDE callers can
quantbook-engine/crates/ql-collab/src/session.rs:677:    /// **Phase 5.5 V2 V3 step 1 audit closure (Opus M2, 2026-05-21):**
quantbook-engine/crates/ql-collab/src/session.rs:678:    /// auto-flush routes through the delta path
quantbook-engine/crates/ql-collab/src/session.rs:679:    /// ([`flush_delta_to_transport`]), not the full-snapshot path
quantbook-engine/crates/ql-collab/src/session.rs:681:    /// instead of O(state). See [`AutoFlushPolicy::OnAppend`] for
quantbook-engine/crates/ql-collab/src/session.rs:684:    /// Orthogonal to [`attach_transport`]: setting `OnAppend` without
quantbook-engine/crates/ql-collab/src/session.rs:685:    /// a transport is harmless (auto-flush is silently a no-op until
quantbook-engine/crates/ql-collab/src/session.rs:688:    /// [`flush_delta_to_transport`] (delta) remain available
quantbook-engine/crates/ql-collab/src/session.rs:691:    /// **Partial-state contract**: if an auto-flush attempt fails
quantbook-engine/crates/ql-collab/src/session.rs:695:    /// [`AutoFlushPolicy::OnAppend`] for the full contract.
quantbook-engine/crates/ql-collab/src/session.rs:700:    /// **Phase 5.5 V2 V2 (2026-05-21):** read the current auto-flush
quantbook-engine/crates/ql-collab/src/session.rs:706:    /// **Phase 5.5 V2 V2 (2026-05-21):** internal hook called by every
quantbook-engine/crates/ql-collab/src/session.rs:708:    /// [`flush_to_transport`] when policy is `OnAppend` AND a transport
quantbook-engine/crates/ql-collab/src/session.rs:713:    /// contract documented at [`AutoFlushPolicy::OnAppend`]).
quantbook-engine/crates/ql-collab/src/session.rs:715:    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** routes through
quantbook-engine/crates/ql-collab/src/session.rs:716:    /// [`flush_delta_to_transport`] (delta path) instead of
quantbook-engine/crates/ql-collab/src/session.rs:723:            AutoFlushPolicy::OnAppend => {
quantbook-engine/crates/ql-collab/src/session.rs:727:                let _sent = self.flush_delta_to_transport()?;
quantbook-engine/crates/ql-collab/src/session.rs:733:    /// **Phase 5.5 V2 V1 (2026-05-19):** export the current
quantbook-engine/crates/ql-collab/src/session.rs:746:    /// retry the flush after addressing the underlying cause.
quantbook-engine/crates/ql-collab/src/session.rs:752:    /// **Phase 5.5 V2 V2 (2026-05-21):** this method remains
quantbook-engine/crates/ql-collab/src/session.rs:754:    /// [`auto_flush_policy`]. With `OnAppend`, [`append_op`] etc.
quantbook-engine/crates/ql-collab/src/session.rs:757:    /// is supported: set `OnAppend` for steady-state appends but
quantbook-engine/crates/ql-collab/src/session.rs:766:        // **Phase 5.5 V2 V3 step 1 (2026-05-21):** advance
quantbook-engine/crates/ql-collab/src/session.rs:768:        // up to this VV; subsequent `flush_delta_to_transport` calls
quantbook-engine/crates/ql-collab/src/session.rs:771:        // `flush_delta_to_transport`) would re-send the snapshot's
quantbook-engine/crates/ql-collab/src/session.rs:778:    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** export and send the
quantbook-engine/crates/ql-collab/src/session.rs:784:    /// step 2's `poll_remote` auto-flush wiring).
quantbook-engine/crates/ql-collab/src/session.rs:804:    /// - Steady state under `OnAppend`: `maybe_auto_flush` (via
quantbook-engine/crates/ql-collab/src/session.rs:805:    ///   `flush_delta_to_transport`) sends tiny deltas per
quantbook-engine/crates/ql-collab/src/session.rs:816:    /// - `last_flushed_vv` is NOT updated on `Err` — a retry sends
quantbook-engine/crates/ql-collab/src/session.rs:818:    pub fn flush_delta_to_transport(&mut self) -> Result<bool, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:847:        // last_flushed_vv at its prior value so retry sends the
quantbook-engine/crates/ql-collab/src/session.rs:853:    /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** drain
quantbook-engine/crates/ql-collab/src/session.rs:860:    /// [`poll_remote_with_limit`]. The cap prevents one
quantbook-engine/crates/ql-collab/src/session.rs:861:    /// `poll_remote` call from starving the calling thread when
quantbook-engine/crates/ql-collab/src/session.rs:865:    /// Returns `Ok(0)` if no transport attached.
quantbook-engine/crates/ql-collab/src/session.rs:873:    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** triggers ONE
quantbook-engine/crates/ql-collab/src/session.rs:874:    /// auto-flush after the drain batch (not per-blob), routed
quantbook-engine/crates/ql-collab/src/session.rs:875:    /// through [`flush_delta_to_transport`] when
quantbook-engine/crates/ql-collab/src/session.rs:876:    /// [`auto_flush_policy`] is `OnAppend` AND at least one blob
quantbook-engine/crates/ql-collab/src/session.rs:881:    /// auto-flush returns `Ok(false)` without invoking
quantbook-engine/crates/ql-collab/src/session.rs:885:    /// exclusion of `poll_remote*` from auto-flush. V2 V3 step 1's
quantbook-engine/crates/ql-collab/src/session.rs:889:    /// blob → hub auto-flushes merged state onward) now works
quantbook-engine/crates/ql-collab/src/session.rs:890:    /// automatically under `OnAppend`.
quantbook-engine/crates/ql-collab/src/session.rs:891:    pub fn poll_remote(&mut self) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:892:        self.poll_remote_with_limit(DEFAULT_POLL_REMOTE_LIMIT)
quantbook-engine/crates/ql-collab/src/session.rs:895:    /// **Phase 5.5 V2 V1 (2026-05-19, audit-tightened):** like
quantbook-engine/crates/ql-collab/src/session.rs:896:    /// [`poll_remote`] but with an explicit per-call cap on the
quantbook-engine/crates/ql-collab/src/session.rs:899:    /// `max_blobs == 0` is a no-op (returns `Ok(0)` even if
quantbook-engine/crates/ql-collab/src/session.rs:900:    /// blobs are queued — call again with a non-zero cap).
quantbook-engine/crates/ql-collab/src/session.rs:907:    /// **Phase 5.5 V2 V3 step 2 (2026-05-21):** when at least one
quantbook-engine/crates/ql-collab/src/session.rs:908:    /// blob was drained AND [`auto_flush_policy`] is `OnAppend`,
quantbook-engine/crates/ql-collab/src/session.rs:909:    /// fires ONE auto-flush after the loop (per-batch, not
quantbook-engine/crates/ql-collab/src/session.rs:911:    /// [`flush_delta_to_transport`]; V2 V3 step 1's idempotency
quantbook-engine/crates/ql-collab/src/session.rs:916:    /// **Partial-state contract on auto-flush failure**: if the
quantbook-engine/crates/ql-collab/src/session.rs:917:    /// post-batch auto-flush fails (closed transport, I/O error
quantbook-engine/crates/ql-collab/src/session.rs:923:    /// `last_flushed_vv` is NOT advanced on flush Err — a retry
quantbook-engine/crates/ql-collab/src/session.rs:924:    /// (e.g., manual [`flush_delta_to_transport`] after detaching
quantbook-engine/crates/ql-collab/src/session.rs:927:    pub fn poll_remote_with_limit(
quantbook-engine/crates/ql-collab/src/session.rs:932:            return Ok(0);
quantbook-engine/crates/ql-collab/src/session.rs:934:        let mut merged = 0usize;
quantbook-engine/crates/ql-collab/src/session.rs:951:        // **Phase 5.5 V2 V3 step 2 (2026-05-21):** auto-flush after
quantbook-engine/crates/ql-collab/src/session.rs:954:        // `flush_delta_to_transport` returns Ok(false) without
quantbook-engine/crates/ql-collab/src/session.rs:956:        // deduped merge). Skip when 0 blobs drained: state didn't
quantbook-engine/crates/ql-collab/src/session.rs:959:        if merged > 0 {
quantbook-engine/crates/ql-collab/src/session.rs:965:    /// **Phase 5.6 V1 (2026-05-19):** write this session's own
quantbook-engine/crates/ql-collab/src/session.rs:973:    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
quantbook-engine/crates/ql-collab/src/session.rs:976:    /// `self.log` when the auto-flush attempt runs — same shape
quantbook-engine/crates/ql-collab/src/session.rs:977:    /// as `append_op` (see [`AutoFlushPolicy::OnAppend`]).
quantbook-engine/crates/ql-collab/src/session.rs:986:    /// **Phase 5.6 V1 (2026-05-19):** read a peer's most recent
quantbook-engine/crates/ql-collab/src/session.rs:1003:    /// **Phase 5.6 V1 (2026-05-19):** remove this session's own
quantbook-engine/crates/ql-collab/src/session.rs:1009:    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers auto-flush per
quantbook-engine/crates/ql-collab/src/session.rs:1012:    /// before the auto-flush attempt.
quantbook-engine/crates/ql-collab/src/session.rs:1020:    /// **Phase 5.4 V1 (2026-05-19):** undo this session's last
quantbook-engine/crates/ql-collab/src/session.rs:1034:    /// **Phase 5.5 V2 V2 + audit closure (2026-05-21):** triggers
quantbook-engine/crates/ql-collab/src/session.rs:1035:    /// auto-flush per [`auto_flush_policy`], but ONLY when
quantbook-engine/crates/ql-collab/src/session.rs:1045:        // **Phase 5.5 V2 V2 audit closure (Codex M2, 2026-05-21):** only
quantbook-engine/crates/ql-collab/src/session.rs:1046:        // auto-flush when an undo item was actually consumed. The prior
quantbook-engine/crates/ql-collab/src/session.rs:1058:    /// **Phase 5.4 V1 (2026-05-19):** redo the last undone op.
quantbook-engine/crates/ql-collab/src/session.rs:1062:    /// **Phase 5.5 V2 V2 + audit closure (2026-05-21):** matches
quantbook-engine/crates/ql-collab/src/session.rs:1063:    /// [`undo`] — auto-flush fires only when `consumed == true`.
quantbook-engine/crates/ql-collab/src/session.rs:1076:    /// **Phase 5.4 V1 (2026-05-19):** true iff the undo stack has
quantbook-engine/crates/ql-collab/src/session.rs:1082:    /// **Phase 5.4 V1 (2026-05-19):** true iff the redo stack has
quantbook-engine/crates/ql-collab/src/session.rs:1088:    /// **Phase 5.4 V1 (2026-05-19):** number of items currently
quantbook-engine/crates/ql-collab/src/session.rs:1094:    /// **Phase 5.4 V1 (2026-05-19):** number of items currently
quantbook-engine/crates/ql-collab/src/session.rs:1100:    /// **Phase 5.4 V1 (2026-05-19):** clear both undo and redo
quantbook-engine/crates/ql-collab/src/session.rs:1108:    /// **Phase 5.4 V2 V1 (2026-05-19):** begin a new undo group.
quantbook-engine/crates/ql-collab/src/session.rs:1118:    /// deterministically (Loro 1.12.0 `loro-internal::undo:674-688`).
quantbook-engine/crates/ql-collab/src/session.rs:1131:    /// Closes GAP-C-04's "command grouping" half. Merge-interval
quantbook-engine/crates/ql-collab/src/session.rs:1138:    /// **Phase 5.4 V2 V1 (2026-05-19):** close the current undo
quantbook-engine/crates/ql-collab/src/session.rs:1150:    /// **Phase 5.4 V2 V1 (2026-05-19):** set the auto-merge
quantbook-engine/crates/ql-collab/src/session.rs:1155:    /// `0` (Loro default) disables auto-merge. Negative values
quantbook-engine/crates/ql-collab/src/session.rs:1156:    /// behave as `0` (Loro stores the raw `i64` and the compare
quantbook-engine/crates/ql-collab/src/session.rs:1160:    /// this method. Recommended IDE settings: 200-500 ms for
quantbook-engine/crates/ql-collab/src/session.rs:1169:    /// **Phase 5.4 V2 V1.1 (2026-05-19):** RAII variant of
quantbook-engine/crates/ql-collab/src/session.rs:1186:    ///         guard.append_op(Op::PutValue { sheet: 0, row, col, value })?;
quantbook-engine/crates/ql-collab/src/session.rs:1204:    /// **Phase 5.6 V2 (2026-05-19):** clear ALL presence entries
quantbook-engine/crates/ql-collab/src/session.rs:1223:    /// collab session) skips the sweep.
quantbook-engine/crates/ql-collab/src/session.rs:1225:    /// **Phase 5.5 V2 V2 (2026-05-21):** triggers ONE auto-flush
quantbook-engine/crates/ql-collab/src/session.rs:1229:    /// removed locally when the auto-flush attempt runs.
quantbook-engine/crates/ql-collab/src/session.rs:1236:        // Phase 5.5 V2 V2: single auto-flush after the batch removal,
quantbook-engine/crates/ql-collab/src/session.rs:1243:    /// **Phase 5.6 V1 (2026-05-19):** list every peer with a
quantbook-engine/crates/ql-collab/src/session.rs:1275:/// **Phase 5.4 V2 V1.1 (2026-05-19):** RAII guard returned by
quantbook-engine/crates/ql-collab/src/session.rs:1312:        // `end_undo_group` is infallible per Loro 1.12.0; safe in
quantbook-engine/crates/ql-collab/src/session.rs:1351:        assert_eq!(s.op_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1363:        s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1377:        origin.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1388:        let mut base = CollabSession::new(PeerId::new(100)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1397:        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1400:        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1414:        s.append_op(put_value(0, 0, 0, 1.0)).ok();
quantbook-engine/crates/ql-collab/src/session.rs:1427:        let s = CollabSession::new(PeerId::new(0xdead_beef_cafe_babe)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1428:        assert_eq!(s.peer_id().as_u64(), 0xdead_beef_cafe_babe);
quantbook-engine/crates/ql-collab/src/session.rs:1429:        assert_eq!(s.op_log().peer_id(), 0xdead_beef_cafe_babe);
quantbook-engine/crates/ql-collab/src/session.rs:1461:        reborn.append_op(put_value(0, 0, 0, 99.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1476:            row: 10,
quantbook-engine/crates/ql-collab/src/session.rs:1490:        let state2 = PresenceState::at_cell(0, 0, 0);
quantbook-engine/crates/ql-collab/src/session.rs:1511:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0x0a), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1513:            .update_presence(PresenceState::at_cell(0, 3, 4))
quantbook-engine/crates/ql-collab/src/session.rs:1516:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0x0b), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1518:            .update_presence(PresenceState::at_cell(1, 100, 200))
quantbook-engine/crates/ql-collab/src/session.rs:1526:        let a = peer_a.peer_presence(PeerId::new(0x0a)).unwrap().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1527:        assert_eq!(a, PresenceState::at_cell(0, 3, 4));
quantbook-engine/crates/ql-collab/src/session.rs:1528:        let b = peer_a.peer_presence(PeerId::new(0x0b)).unwrap().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1529:        assert_eq!(b, PresenceState::at_cell(1, 100, 200));
quantbook-engine/crates/ql-collab/src/session.rs:1533:        assert_eq!(peers, vec![PeerId::new(0x0a), PeerId::new(0x0b)]);
quantbook-engine/crates/ql-collab/src/session.rs:1545:            let mut a = CollabSession::from_snapshot(PeerId::new(0xa1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1546:            a.update_presence(PresenceState::at_cell(0, 1, 2)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1547:            let mut b = CollabSession::from_snapshot(PeerId::new(0xb1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1585:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xaa), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1587:            .update_presence(PresenceState::at_cell(0, 0, 0))
quantbook-engine/crates/ql-collab/src/session.rs:1590:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xbb), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1593:            peer_b.peer_presence(PeerId::new(0xaa)).unwrap().is_some(),
quantbook-engine/crates/ql-collab/src/session.rs:1603:            peer_b.peer_presence(PeerId::new(0xaa)).unwrap(),
quantbook-engine/crates/ql-collab/src/session.rs:1616:        assert_eq!(s.undo_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1617:        assert_eq!(s.redo_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1624:        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1627:        assert_eq!(s.redo_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1637:        assert_eq!(s.undo_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1648:        assert_eq!(s.redo_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1661:        for row in 0..10 {
quantbook-engine/crates/ql-collab/src/session.rs:1662:            s.update_presence(PresenceState::at_cell(0, row, 0))
quantbook-engine/crates/ql-collab/src/session.rs:1680:        assert_eq!(s.undo_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1683:        for col in 0..5 {
quantbook-engine/crates/ql-collab/src/session.rs:1684:            s.append_op(put_value(0, 0, col, col as f64)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1696:        // to ≤ 0 — Loro retracts all 5 from the visible list).
quantbook-engine/crates/ql-collab/src/session.rs:1698:        assert_eq!(s.undo_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1702:            0,
quantbook-engine/crates/ql-collab/src/session.rs:1710:        assert_eq!(s.redo_count(), 0, "redo consumed the only redo item");
quantbook-engine/crates/ql-collab/src/session.rs:1738:        assert_eq!(s.undo_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1741:            guard.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1742:            guard.append_op(put_value(0, 0, 1, 2.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1743:            guard.append_op(put_value(0, 0, 2, 3.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1748:        assert_eq!(s.op_log().iter().count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1759:            guard.append_op(put_value(0, 0, 0, 1.0))?;
quantbook-engine/crates/ql-collab/src/session.rs:1769:                guard.append_op(put_value(0, 0, 1, 2.0))?;
quantbook-engine/crates/ql-collab/src/session.rs:1798:        assert_eq!(guard.op_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1799:        guard.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1857:        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1860:        s.append_op(put_value(0, 0, 1, 2.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1861:        s.append_op(put_value(0, 0, 2, 3.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1864:        s.append_op(put_value(0, 0, 3, 4.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1881:        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1893:        s.set_undo_merge_interval(0); // Loro default — disabled.
quantbook-engine/crates/ql-collab/src/session.rs:1894:        s.set_undo_merge_interval(500); // 500ms typing window.
quantbook-engine/crates/ql-collab/src/session.rs:1895:        s.set_undo_merge_interval(0); // Back to disabled.
quantbook-engine/crates/ql-collab/src/session.rs:1897:        assert_eq!(s.op_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1903:        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1904:        s.append_op(put_value(0, 0, 1, 2.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1910:        assert_eq!(s.undo_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1911:        assert_eq!(s.redo_count(), 0);
quantbook-engine/crates/ql-collab/src/session.rs:1923:        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1924:        s.append_op(put_value(0, 0, 1, 2.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1947:        origin.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1948:        origin.append_op(put_value(0, 0, 1, 2.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1955:            0,
quantbook-engine/crates/ql-collab/src/session.rs:1973:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1974:        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1976:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb1), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1977:        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1986:            a_iter < 1 || a_iter == 0,
quantbook-engine/crates/ql-collab/src/session.rs:2043:    fn poll_remote_noop_without_attached() {
quantbook-engine/crates/ql-collab/src/session.rs:2045:        let drained = s.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2046:        assert_eq!(drained, 0, "poll with no transport returns 0");
quantbook-engine/crates/ql-collab/src/session.rs:2054:        s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2059:            0,
quantbook-engine/crates/ql-collab/src/session.rs:2073:    fn poll_remote_drains_attached_transport() {
quantbook-engine/crates/ql-collab/src/session.rs:2088:        let drained = s.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2092:        let drained2 = s.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2093:        assert_eq!(drained2, 0);
quantbook-engine/crates/ql-collab/src/session.rs:2104:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2106:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2110:        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2112:        let drained_b = peer_b.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2117:        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2119:        let drained_a = peer_a.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2132:        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2150:    fn poll_remote_treats_closed_as_graceful_end_of_stream() {
quantbook-engine/crates/ql-collab/src/session.rs:2153:        // Closed only after queue drains; CollabSession::poll_remote
quantbook-engine/crates/ql-collab/src/session.rs:2165:        for _ in 0..3 {
quantbook-engine/crates/ql-collab/src/session.rs:2173:        let drained = s.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2176:            "poll_remote must drain all queued blobs even when transport is closed"
quantbook-engine/crates/ql-collab/src/session.rs:2178:        // Next poll: queue is empty + closed → still Ok(0) (graceful).
quantbook-engine/crates/ql-collab/src/session.rs:2179:        let drained2 = s.poll_remote().unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2180:        assert_eq!(drained2, 0);
quantbook-engine/crates/ql-collab/src/session.rs:2184:    fn poll_remote_with_limit_caps_drain() {
quantbook-engine/crates/ql-collab/src/session.rs:2185:        // Codex+Opus 5.5 V2 V1 audit closure (H1): poll_remote_with_limit
quantbook-engine/crates/ql-collab/src/session.rs:2186:        // bounds the drain. Pre-populate 10 blobs, drain 4 at a time.
quantbook-engine/crates/ql-collab/src/session.rs:2195:        for _ in 0..10 {
quantbook-engine/crates/ql-collab/src/session.rs:2200:        let d1 = s.poll_remote_with_limit(4).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2202:        let d2 = s.poll_remote_with_limit(4).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2204:        let d3 = s.poll_remote_with_limit(4).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2206:        let d4 = s.poll_remote_with_limit(4).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2207:        assert_eq!(d4, 0, "queue empty");
quantbook-engine/crates/ql-collab/src/session.rs:2209:        // limit = 0 is a no-op even with queued blobs.
quantbook-engine/crates/ql-collab/src/session.rs:2211:        let d5 = s.poll_remote_with_limit(0).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2212:        assert_eq!(d5, 0, "limit=0 must be a no-op");
quantbook-engine/crates/ql-collab/src/session.rs:2221:        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2235:        s.append_op(put_value(0, 0, 1, 2.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2273:        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2274:        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2277:        peer_a.append_op(put_value(0, 0, 0, 42.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2291:        peer_b.append_op(put_value(0, 1, 0, 99.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2306:        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2325:        s.update_presence(PresenceState::at_cell(0, 0, 0)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2330:            .presence_set("0000000000000002", r#"{"sheet":1,"row":2,"col":3,"selection_end_row":2,"selection_end_col":3,"typing":false}"#)
quantbook-engine/crates/ql-collab/src/session.rs:2347:    fn sweep_presence_on_empty_map_returns_zero() {
quantbook-engine/crates/ql-collab/src/session.rs:2349:        // returns Ok(0), not an error.
quantbook-engine/crates/ql-collab/src/session.rs:2352:        assert_eq!(cleared, 0);
quantbook-engine/crates/ql-collab/src/session.rs:2353:        // Sweep is idempotent — second call also returns 0.
quantbook-engine/crates/ql-collab/src/session.rs:2355:        assert_eq!(cleared2, 0);
quantbook-engine/crates/ql-collab/src/session.rs:2362:        let mut origin = CollabSession::new(PeerId::new(0xa)).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2364:            .update_presence(PresenceState::at_cell(0, 3, 4))
quantbook-engine/crates/ql-collab/src/session.rs:2368:        let mut reborn = CollabSession::from_snapshot(PeerId::new(0xa), &bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2389:        s.update_presence(PresenceState::at_cell(0, 0, 0)).unwrap();
quantbook-engine/docs/MASTER-PLAN.md:3:**Status:** Canonical engine-side plan, Phase 4.3 V2 closure session 2026-05-13  
quantbook-engine/docs/MASTER-PLAN.md:4:**Date:** 2026-05-13 (last touched W5-58 — FN4-01 closure)  
quantbook-engine/docs/MASTER-PLAN.md:5:**Current HEAD:** see `docs/audits/2026-05-13-engine-session-final-handoff.md` § Session ledger for the exact hash (last shippable W5-58 = `d6a6bcdcfc5`; W5-59 finalization = `51fedf11c68`; W5-60 closure adds the final mega-audit fixes on top)  
quantbook-engine/docs/MASTER-PLAN.md:7:**Authored:** Claude Opus 4.7 + Codex (co-thinking session, 2026-05-12)
quantbook-engine/docs/MASTER-PLAN.md:13:## 0. How this document relates to the product master plan
quantbook-engine/docs/MASTER-PLAN.md:19:That document (dated 2026-05-10, 949 lines) is the **product source-of-truth**: the fusion thesis, the wedge, the v1 ship definition, the 11-phase / 9-12 month budget, the kill gates, the v1.5 deferrals, the legal posture, the renderer/Python/IDE phase plan. It is gitignored (lives outside this engine worktree). Future sessions should read it before making product-level decisions.
quantbook-engine/docs/MASTER-PLAN.md:21:This `MASTER-PLAN.md` is the **engine-side execution plan**: how the Rust engine work proceeds from where it is today (HEAD at W5-60 closure, post-FN4-01 wave 1 closure + final mega-audit fixes; see `docs/audits/2026-05-13-engine-session-final-handoff.md` for the precise hash) through to a state where every product-plan phase that needs engine support has it. It uses engine-internal phase numbers (`2B`, `3`, `4`, `5`, `6`, `7`) that DO NOT align with the canonical plan's numbering (`Phase 0..10`).
quantbook-engine/docs/MASTER-PLAN.md:27:| Engine 0 (Viability spike) ✅ | Product Phase 0 | Same. 13/13 gates locked. |
quantbook-engine/docs/MASTER-PLAN.md:28:| Engine 1 (Parser + persistence + runtime facade) ✅ | Product Phase 0 spillover + parts of Phase 2 (`.qbook/`) + parts of Phase 3 (parser, recompute) | Engine front-ran the canonical plan by absorbing parts of Phase 2 storage and Phase 3 parser. |
quantbook-engine/docs/MASTER-PLAN.md:30:| Engine 2A.3 (op log) ✅ | Product Phase 0 deliverable (`ql-oplog` scaffolding) advanced into producer wiring + persistence | Loro op log scaffolding called for in canonical Phase 0; we shipped it now because the API surface was ready. |
quantbook-engine/docs/MASTER-PLAN.md:33:| **Engine 4 (Excel Coverage)** | Product Phase 3 (depth) + Product Phase 4 (xlsx import) | Roughly 260 functions + arrays/spills/tables/cross-sheet refs + xlsx I/O. |
quantbook-engine/docs/MASTER-PLAN.md:36:| **Engine 7 (Hardening + Ship)** | Product Phase 10 | Same. Final release candidate. |
quantbook-engine/docs/MASTER-PLAN.md:46:The canonical plan is product-shaped and parallel-track (engine + renderer + Python + IDE proceeding in measured concurrency). The actual execution since 2026-05-11 has been engine-serial: depth-first through the Rust core. This engine plan reflects that reality and extends it. Future sessions should:
quantbook-engine/docs/MASTER-PLAN.md:56:Phase 0 proved that the engine shape is viable. The locked architectural gates are still binding:
quantbook-engine/docs/MASTER-PLAN.md:58:- T1-D02: hand-rolled dependency graph on the hot path, not petgraph.
quantbook-engine/docs/MASTER-PLAN.md:59:- T1-D03: direct Arrow kernels on the hot path, not Polars or DataFusion.
quantbook-engine/docs/MASTER-PLAN.md:60:- T1-D04: pulp plus multiversion SIMD.
quantbook-engine/docs/MASTER-PLAN.md:61:- T1-D05: Loro reserved for operation history and collaboration substrate work, not evaluator state.
quantbook-engine/docs/MASTER-PLAN.md:62:- T1-D06: stock VS Code APIs for v1.
quantbook-engine/docs/MASTER-PLAN.md:63:- T1-D07: Tier-0 wedge is Monaco-powered formula bar plus Python UDFs.
quantbook-engine/docs/MASTER-PLAN.md:64:- T2-D01: `.qbook/` directory plus `workbook.toml` envelope.
quantbook-engine/docs/MASTER-PLAN.md:65:- T3-D03: roughly 260 v1 spreadsheet functions.
quantbook-engine/docs/MASTER-PLAN.md:71:The engine now has **1219 workspace tests at W5-60 close** (was 816 at the time this paragraph was first written; ~+403 across the W5-49..W5-60 arc) and 7 green gates. That is a floor, not a trophy. The major unresolved problem is that the "fast engine" (`ql-calcgraph`, SIMD region lowering, storage profiles) and the "runtime engine" (`WorkbookRuntime`, per-formula scalar path) still do not form one engine.
quantbook-engine/docs/MASTER-PLAN.md:75:- `docs/phase0/references-reading-log.md` corrected the stripe design to Formualizer-style per-row/per-column/block stripes (`CORR-21`).
quantbook-engine/docs/MASTER-PLAN.md:91:| `ql-functions` | roughly 260 Excel-compatible functions, function metadata, volatility, lazy args |
quantbook-engine/docs/MASTER-PLAN.md:122:| 6 | Product Surfaces | Ship service mode, bindings, connectors, SQL, Python UDFs, and AI(). | 6-10 weeks | IDE, Node, Python, WASM, and service clients run the same engine contract. |
quantbook-engine/docs/MASTER-PLAN.md:133:- Phase 0, Phase 1, Phase 2A, and Phase 2A.3 are green at HEAD `fc977815cd2`.
quantbook-engine/docs/MASTER-PLAN.md:147:   References: `docs/phase0/references-reading-log.md`; `crates/ql-oplog/src/{op,log,replay,persistence}.rs`; `crates/ql-exec/tests/oplog_e2e.rs`.  
quantbook-engine/docs/MASTER-PLAN.md:148:   Acceptance: DOC-2B-01 all Phase 2 docs agree that 2A.3 shipped; DOC-2B-02 every known gap has a target phase; DOC-2B-03 no stale "Phase 4 calcgraph" wording remains where Phase 3 is meant.  
quantbook-engine/docs/MASTER-PLAN.md:154:   Acceptance: R2B-01 failure returns exact cell and formula text; R2B-02 successful earlier cells are counted; R2B-03 no panic on invalid persisted formula; R2B-04 load-and-recompute preserves partial workbook on recompute failure.  
quantbook-engine/docs/MASTER-PLAN.md:157:3. **2B.3 Bind-Plan Cache V0**  
quantbook-engine/docs/MASTER-PLAN.md:160:   Acceptance: BPC-01 repeated `recompute_all` does not re-lex/re-parse unchanged formulas; BPC-02 name changes invalidate affected plans; BPC-03 fingerprints remain stable; BPC-04 cache miss/hit counters visible in `ql-profile`.  
quantbook-engine/docs/MASTER-PLAN.md:163:4. **2B.4 Named-Range Aggregate Context Prep** ✅ SHIPPED (`f64ff00dcb1`)  
quantbook-engine/docs/MASTER-PLAN.md:166:   Acceptance shipped: NAG-01..04 + `nag_05_nested_aggregates_with_named_range_bind_cleanly` + `nag_06_round_with_nested_sum_of_named_range_binds_cleanly`.  
quantbook-engine/docs/MASTER-PLAN.md:172:   Acceptance: OPL-2B-01 every public product mutation has an op-log equivalent; OPL-2B-02 producer/replay equivalence covers values, formulas, names, sheets, and batches; OPL-2B-03 low-level bypass methods carry explicit docs and tests.  
quantbook-engine/docs/MASTER-PLAN.md:178:   Acceptance: IDE-2B-01 formula edit calls engine and displays value; IDE-2B-02 lex/parse/bind errors display without falling back; IDE-2B-03 cancel leaves workbook unchanged; IDE-2B-04 paste uses transaction API; IDE-2B-05 saved workbook reloads with same visible state and op log length.  
quantbook-engine/docs/MASTER-PLAN.md:184:   Acceptance: A2B-01 fmt, clippy, workspace tests, pin guard, build flags, multiversion clone guard, cargo audit all green; A2B-02 test count at least 1.5x Phase 2A.3 baseline or explicit exception; A2B-03 audit report checked in.  
quantbook-engine/docs/MASTER-PLAN.md:220:- Bind-plan cache V0 exists.
quantbook-engine/docs/MASTER-PLAN.md:230:1. **3.1 Calcgraph Runtime Ownership Model** ✅ SHIPPED 2026-05-12 (W5-34)  
quantbook-engine/docs/MASTER-PLAN.md:233:   Acceptance: G3-01 ✅ graph rebuilds deterministically (`rebuild_is_deterministic_across_runs`); G3-02 ✅ 5-hook mutation API (`on_set_value`, `on_set_formula`, `on_clear_formula`, `on_set_name`, `on_add_sheet`); G3-03 ✅ no petgraph hot-path dep — Phase 0 W3-1 hand-rolled `Graph` per Round 7 T1-D02 lock.  
quantbook-engine/docs/MASTER-PLAN.md:234:   Shipped: `CalcgraphSession` ownership shell at `crates/ql-exec/src/calcgraph_session.rs`; constructor variants (`new`, `with_oplog`, `with_graph`, `with_oplog_and_graph`); 11 unit tests + 4 wiring tests in `workbook_runtime.rs`. Future Phase 6.1 `WorkbookSession` will absorb Workbook + OpLog + CalcgraphSession + PlanCache + FunctionRegistry into one owning struct (GAP-PS-09).  
quantbook-engine/docs/MASTER-PLAN.md:237:2. **3.2 Dependency Extraction From Bound Plans** ✅ SHIPPED 2026-05-12 (W5-35)  
quantbook-engine/docs/MASTER-PLAN.md:240:   Acceptance: DEP-3-01 ✅ direct cell deps captured (`dep_3_01_direct_cell_refs_captured`); DEP-3-02 ✅ range deps remain compressed (`dep_3_02_range_deps_remain_compressed`); DEP-3-03 ✅ named deps captured (`dep_3_03_named_deps_captured`); DEP-3-04 ✅ volatile functions marked (`dep_3_04_volatile_functions_marked`).  
quantbook-engine/docs/MASTER-PLAN.md:241:   Shipped: `CalcgraphSession::{formula_deps, volatile_formulas, name_to_formulas}` side-tables; `walk_plan_for_deps` recursive walker; `RebuildResult` aggregates per-formula bind failures (parallel to `RecomputeResult`); `on_set_formula` takes `&ExprPlan` (no re-binding in the hook); `on_clear_formula` evicts dep state. 9 new tests; full ql-exec suite at 268 tests. Open follow-ups: GAP-R-07 (scalar `NameRef` name-tracking) and the 3.3 dirty-propagation wire-up that consumes this substrate.  
quantbook-engine/docs/MASTER-PLAN.md:244:3. **3.3 Dirty Propagation And Stripe Range Index** ✅ SHIPPED 2026-05-12 (W5-36)  
quantbook-engine/docs/MASTER-PLAN.md:247:   Acceptance: DIR-3-01 ✅ write inside range dirties dependent (`dir_3_01_write_inside_range_dirties_dependent`); DIR-3-02 ✅ write outside range does not dirty after precision check (`dir_3_02_write_outside_range_filtered_by_precision_check`); DIR-3-03 ✅ whole-row, whole-column, and bounded ranges covered (`dir_3_03_whole_col_whole_row_bounded_all_supported`); DIR-3-04 ✅ no per-cell edge explosion for full columns (`dir_3_04_no_per_cell_edge_explosion_for_full_columns`).  
quantbook-engine/docs/MASTER-PLAN.md:248:   Shipped: session-side `dirty: HashSet<NodeId>` plus the 5 hooks fanning out via `Graph::dependents_for_cell` (stripe + precision) for range deps and a new session-side `cell_to_formulas` reverse index for direct cell deps; `on_set_name` fans out via `name_to_formulas`; `take_dirty()` claims + clears for the future 3.4 SCC scheduler; `range_to_rangeref` converter promotes `Range { start_row: 0, end_row: MAX }` to `RangeRef::WholeColumn` (and symmetric for whole-row) to keep the stripe index O(width) instead of O(height). 10 new tests; full ql-exec suite at 278 tests, workspace at 892. Known limitation: stale Phase 0 stripe entries on re-bind (append-only `Graph`) — filed as GAP-G-01 (performance, not correctness; precision check filters at the read side).  
quantbook-engine/docs/MASTER-PLAN.md:249:   Effort: 4-6 days (actual: ~1 day; substrate already existed in `ql-calcgraph` from Phase 0 W3-5).
quantbook-engine/docs/MASTER-PLAN.md:251:4. **3.4 Tarjan SCC Scheduler And Full Topological Recompute** ✅ SHIPPED 2026-05-12 (W5-37)  
quantbook-engine/docs/MASTER-PLAN.md:253:   References: `.references/formualizer/crates/formualizer-eval/src/engine/scheduler.rs`; `.references/hyperformula/src/DependencyGraph/TopSort.ts`; `docs/phase0/references-reading-log.md` CORR-23.  
quantbook-engine/docs/MASTER-PLAN.md:254:   Acceptance: SCH-3-01 ✅ dependency chains schedule in dependency-first order (`sch_3_01_dependency_chains_schedule_in_dependency_first_order` + `recompute_dirty_cascades_dependency_chain`); SCH-3-02 ✅ cycles surface in `Schedule::cycled` (`sch_3_02_cycles_report_all_scc_members` + `recompute_dirty_writes_circ_error_for_cycle_members`); SCH-3-03 ✅ deterministic across runs (`sch_3_03_schedule_is_deterministic_across_runs`); SCH-3-04 ✅ dirty subset avoids unrelated formulas (`sch_3_04_dirty_subset_avoids_unrelated_formulas` + `recompute_dirty_skips_unrelated_formulas`).  
quantbook-engine/docs/MASTER-PLAN.md:256:   - Phase 0 W3-3 iterative Tarjan in `ql_calcgraph::topo::schedule` was already built (no recursion limit on deep chains). 3.4 wires it.  
quantbook-engine/docs/MASTER-PLAN.md:264:   - New `ErrorValue::Circ` variant (15th, was reserved at Phase 0; Phase 0 doc updated). Handled in `ql-io::qbook_format` wire roundtrip.  
quantbook-engine/docs/MASTER-PLAN.md:265:   16 new tests (10 session unit + 5 runtime integration + 1 wire roundtrip). ql-exec at 295, workspace at 905.  
quantbook-engine/docs/MASTER-PLAN.md:266:   Effort: 5-7 days (actual: ~1 day; substrate was already there from Phase 0 W3-3).
quantbook-engine/docs/MASTER-PLAN.md:268:5. **3.5 Computed-Overlay Separation** ✅ SHIPPED 2026-05-12 (W5-38)  
quantbook-engine/docs/MASTER-PLAN.md:270:   References: `.references/formualizer/crates/formualizer-eval/src/arrow_store/mod.rs`; `.references/formualizer/crates/formualizer-eval/src/engine/range_view.rs`; `docs/phase0/references-reading-log.md` CORR-25.  
quantbook-engine/docs/MASTER-PLAN.md:271:   Acceptance: OVR-3-01 ✅ formula output writes to computed overlay, not user (`ovr_3_01_set_formula_writes_to_computed_overlay_not_user`); OVR-3-02 ✅ typing over formula clears formula text + computed (`ovr_3_02_typing_over_formula_clears_formula_and_computed`); OVR-3-03 ✅ save/load preserves layer (`ovr_3_03_save_load_preserves_layer`); OVR-3-04 ✅ read cascade consistent (`ovr_3_04_read_cascade_consistent_across_lane_types`).  
quantbook-engine/docs/MASTER-PLAN.md:282:   - One additional Phase 3.5 acceptance test `ovr_3_02b_clear_formula_promotes_value_to_user_lane` pins the explicit-clear behavior.  
quantbook-engine/docs/MASTER-PLAN.md:283:   10 new tests (5 in ColumnStore + 5 OVR-* at runtime). ql-exec at 305 (was 295), ql-storage at 70 (was 65), workspace at 915 (was 905).  
quantbook-engine/docs/MASTER-PLAN.md:286:6. **3.6 Range Aggregate Cache V1** ✅ SHIPPED 2026-05-12 (W5-39)  
quantbook-engine/docs/MASTER-PLAN.md:289:   Acceptance: AGG-3-01 ✅ unrelated writes don't trigger rescan (`agg_3_01_no_rescan_on_unrelated_writes`); AGG-3-02 ✅ intersecting writes invalidate (`agg_3_02_intersecting_write_invalidates_cache`); AGG-3-03 ✅ full-column aggregate remains compressed (`agg_3_03_full_column_aggregate_remains_compressed`); AGG-3-04 ✅ results match scalar baseline for SUM/AVERAGE/MIN/MAX/COUNT/PRODUCT (`agg_3_04_results_match_scalar_baseline`).  
quantbook-engine/docs/MASTER-PLAN.md:291:   - New module `aggregate_cache.rs`: `AggregateCache` trait, `InMemAggregateCache` (HashMap-backed with `RefCell` interior mutability for `&self` stores), `NoAggregateCache` zero-cost no-op default. Stats: hits / misses / invalidations.  
quantbook-engine/docs/MASTER-PLAN.md:298:   16 new tests (7 aggregate_cache unit + 4 AGG-3-01..04 acceptance + 3 NAG-* updated for actual eval + 2 read_range correctness). ql-exec at 311 (was 295). Workspace at 926 (was 915).  
quantbook-engine/docs/MASTER-PLAN.md:302:7. **3.7 Volatile Function Invalidation** ✅ SHIPPED 2026-05-12 (W5-40)  
quantbook-engine/docs/MASTER-PLAN.md:305:   Acceptance: VOL-3-01 ✅ `mark_volatile_dirty` + `recompute_dirty` produces a new RAND() value (`vol_3_01_volatile_formulas_recompute_when_requested`); VOL-3-02 ✅ non-volatile dependents update when volatile changes (`vol_3_02_nonvolatile_dependents_update_when_volatile_changes`); VOL-3-03 ✅ seeded RNG produces deterministic RAND() sequence (`vol_3_03_seeded_rng_produces_deterministic_rand_sequence`).  
quantbook-engine/docs/MASTER-PLAN.md:307:   - New `ql-functions::volatile` module: NOW, TODAY, RAND, RANDBETWEEN. xorshift64 PRNG with thread-local state — no `rand` crate dep (Phase 0 pin-guard rule). Default seeds from SystemTime nanos; tests override via `set_test_rng_seed`. Excel epoch (1899-12-30) used for NOW/TODAY serial dates; `set_test_now_secs` pins for tests.  
quantbook-engine/docs/MASTER-PLAN.md:308:   - All 4 registered in `default_registry`. Registry count now 30 (was 26).  
quantbook-engine/docs/MASTER-PLAN.md:309:   - `CalcgraphSession::mark_volatile_dirty()` — adds all volatile formulas to the dirty set AND calls `mark_dirty_from_cell_write` for each to fan out the reverse-dep BFS (VOL-3-02 wiring; downstream chains pick up the new value). Returns count of marked formulas.  
quantbook-engine/docs/MASTER-PLAN.md:313:   13 new tests (9 volatile unit + 3 VOL-3-01..03 acceptance + 1 zero-volatile-noop). ql-exec at 315, ql-functions at 72, workspace at 939.  
quantbook-engine/docs/MASTER-PLAN.md:314:   Notes: RANDARRAY / INDIRECT / OFFSET / INFO / CELL still deferred to Phase 4.3 (function library expansion). NOW/TODAY date arithmetic is approximate (Excel 1900 leap-year quirk not modeled); Phase 4.5 (date/time + format) pins exact semantics.  
quantbook-engine/docs/MASTER-PLAN.md:317:8. **3.8 Value-Equality Short-Circuit** ✅ SHIPPED 2026-05-12 (W5-41)  
quantbook-engine/docs/MASTER-PLAN.md:320:   Acceptance: VEQ-3-01 ✅ unchanged upstream suppresses downstream recompute (`veq_3_01_unchanged_upstream_suppresses_downstream_recompute`); VEQ-3-02 ✅ error equality is correct (`veq_3_02_error_equality_suppresses_downstream`); VEQ-3-03 ✅ profile records skipped vertices via `RecomputeResult.skipped_value_equality` (`veq_3_03_profile_records_skipped_vertices`).  
quantbook-engine/docs/MASTER-PLAN.md:322:   - `RecomputeResult.skipped_value_equality: usize` — new public field counting how many dirty formulas were skipped via VEQ. Always 0 on `recompute_all` (legacy path).  
quantbook-engine/docs/MASTER-PLAN.md:323:   - `recompute_dirty` rewrite: snapshot prior values for all sched nodes; process in topo order; for each node, decide if it needs eval (volatile → yes, range deps → yes, top-level dirty → yes, has-changed-upstream → yes, otherwise → SKIP). After eval, compare new vs prior. If equal, suppress the computed-overlay write and don't mark as changed; downstream formulas observe "no changed deps" and skip too.  
quantbook-engine/docs/MASTER-PLAN.md:324:   - Cycled nodes apply VEQ: a pre-existing `#CIRC!` stays `#CIRC!`; skip the write but count.  
quantbook-engine/docs/MASTER-PLAN.md:326:   - Aggregate-cache hits (Phase 3.6) interact correctly: a cached aggregate result that matches prior still counts as a VEQ skip when the formula's eval returns it.  
quantbook-engine/docs/MASTER-PLAN.md:327:   4 new tests (VEQ-3-01..03 + volatile-bypass regression). ql-exec at 319 (was 315). Workspace at 943 (was 939).  
quantbook-engine/docs/MASTER-PLAN.md:331:9. **3.9 SIMD Region Through Graph Runtime** ✅ SHIPPED 2026-05-12 (W5-42, V1)  
quantbook-engine/docs/MASTER-PLAN.md:334:   Acceptance: SIMD-3-01 ✅ OG-02 `=A*2` pattern still classifies to `SimdShape::MulScalar`; `scripts/check-multiversion-clones.sh` confirms the multiversion clones are present in `mul_scalar` (`simd_3_01_og02_pattern_classifies_to_mul_scalar`); SIMD-3-02 ✅ `Operator::Div` returns `SimdShape::NotApplicable` so `10 / 0` emits Excel-canon `#DIV/0!` not `#NUM!` (`simd_3_02_division_falls_back_to_scalar`); SIMD-3-03 ✅ `RecomputeResult.simd_classified` counter exposes SIMD-eligibility of dirty formulas; legacy `recompute_all` is always 0 (`simd_3_03_profile_records_simd_eligible_formulas`).  
quantbook-engine/docs/MASTER-PLAN.md:336:   - `RecomputeResult.simd_classified: usize` — new public field, parallel to `skipped_value_equality`. Counts dirty formulas whose `lower::classify` returns an applicable `SimdShape`.  
quantbook-engine/docs/MASTER-PLAN.md:340:   Notes: this V1 is intentionally observability-focused. The MASTER-PLAN's 3-6 day effort estimate covered the full FormulaRegion-binder + per-region batched dispatch — that's structurally a Phase 4 task (depends on the array-formula binder + region detection at write time). Phase 3.10 megaudit will evaluate whether V1 is sufficient or whether a richer V1.1 is needed before Phase 4.  
quantbook-engine/docs/MASTER-PLAN.md:341:   Effort: 3-6 days (actual V1: ~0.5 day; the substrate from Phase 0 W4-2/3 and the bench gate already validated the kernel-level SIMD).
quantbook-engine/docs/MASTER-PLAN.md:343:10. **3.10 Phase 3 Megaudit** ✅ SHIPPED 2026-05-12 (W5-43)  
quantbook-engine/docs/MASTER-PLAN.md:345:    Acceptance: A3-01 ✅ all 7 gates green pre- and post-audit; A3-02 ✅ dependency-chain correctness locked (with H1/H3/H4 documented as Phase 4 carryovers — root cause: Phase 0 append-only graph contract); A3-03 ✅ `crates/ql-exec/benches/a3_10k_dirty_recompute.rs` checked in (chain + idempotent edit shapes); A3-04 ⚠️ documented exception (946 tests vs ~1724 target — Phase 3 was substrate-completion, not new-feature; 84 net tests cover every declared acceptance gate without redundancy; broad expansion lands Phase 4 with function library + array formulas + date/time + xlsx).  
quantbook-engine/docs/MASTER-PLAN.md:346:    Audit dispatched: Codex (gpt-5-codex via `codex exec`) reviewed Phase 3.1–3.9 commits independently. Findings: 4 HIGH (H1 range-deps-not-edges, H2 set_name not transitive, H3/H4 append-only-graph rebind staleness), 4 MEDIUM, 3 LOW, 6 test gaps. **Closed in audit commit:** H2 (BFS fanout fix + regression test `h2_set_name_propagates_dirty_transitively`), L1 (architecture doc rewrite), L2 (GAP-G-01 re-classified from performance-only to correctness), T4 (set_name regression test). **Deferred to Phase 4 with documented gaps:** H1 → GAP-G-03 (range-as-scheduler-edge), H3+H4 → GAP-G-01 (now correctness; needs delta-edge graph), M1 → GAP-R-08 (volatile-dependent recompute Excel-canon), M3 → GAP-S-06 (load bounds for formula-only cells). Full audit report: `docs/audits/2026-05-12-phase-3-megaudit.md`.  
quantbook-engine/docs/MASTER-PLAN.md:347:    Effort: 3-5 days (actual: ~0.5 day including Codex dispatch + audit closure fixes).
quantbook-engine/docs/MASTER-PLAN.md:383:- **GAP-G-01 + GAP-G-03 SHIPPED (W5-50, 2026-05-13).** Decision recorded in `docs/architecture/2026-05-13-graph-storage-decision.md` (W5-49) and implemented W5-50: Option A — `Graph::clear_outgoing` + `Graph::clear_range_deps_for_formula` + `StripeIndex::clear_for_formula` backed by `formula_to_stripe_keys` reverse index, wired into `extract_and_register_deps`. Option C — `topo::schedule_with_supplemental` accepts a HashMap of temp adjacency; `CalcgraphSession::build_range_supplemental` constructs F→G edges for dirty-formula pairs inside ranges. FormulaRegion binder (Option B) still deferred to Phase 4.7. Phase 4.3 V2 (SUMIF/COUNTIF/lookup family) is **now unblocked**. Tests: +35 vs Phase 3 exit (981 → 1016 workspace).
quantbook-engine/docs/MASTER-PLAN.md:389:- ~~Phase 4.3 V2 is gated on GAP-G-01 (Option A) + GAP-G-03 (small Option C).~~ **Gate cleared W5-50.** Phase 4.7 (array formulas) consumes Option A's revocation API as well.
quantbook-engine/docs/MASTER-PLAN.md:393:1. **4.1 IronCalc Parser Deep-Read And Parser Gap Matrix** ✅ SHIPPED 2026-05-12 (W5-44)  
quantbook-engine/docs/MASTER-PLAN.md:396:   Acceptance: PAR-4-01 ✅ gap matrix checked in at `docs/parser/ironcalc-deep-read.md`; PAR-4-02 ✅ parser expansion (4.6/4.7/4.8/4.9 lexer + AST work) is now formally unlocked; PAR-4-03 ✅ license + provenance documented (IronCalc MIT + Apache-2.0; reference-only policy).  
quantbook-engine/docs/MASTER-PLAN.md:399:   - Full AST-node gap analysis (IronCalc has 10 node variants we don't, mapped to Phase 4.6/4.7/4.8/4.9 / post-v1 buckets).  
quantbook-engine/docs/MASTER-PLAN.md:403:   - Surfaced GAP-G-01 + GAP-G-03 (Phase 3.10 megaudit carryovers) as Phase 4 entry decisions — array formulas + function library expansion both rebind formulas at scale; the append-only graph fix needs to happen before 4.3 or be a known limitation gated by 4.12 megaudit.  
quantbook-engine/docs/MASTER-PLAN.md:404:   Effort: 2-4 days (actual: ~0.5 day; Explore subagent did the IronCalc survey).
quantbook-engine/docs/MASTER-PLAN.md:406:2. **4.2 Excel Compatibility Matrix Harness** ✅ SHIPPED 2026-05-12 (W5-45); doc honesty patched W5-48  
quantbook-engine/docs/MASTER-PLAN.md:410:   - ECM-4-01 ✅ matrix exists at `docs/compat/excel-matrix.md`.  
quantbook-engine/docs/MASTER-PLAN.md:411:   - ECM-4-02 ⚠️ **PARTIAL** (revised W5-48 per Codex deep-audit): each function row carries Status + Tests + Phase + Notes; the CATEGORY for each function is the `###` section header it lives under (Aggregates/Statistical, Logical, Math&Trig, Text, Date&Time, Lookup&Reference, Information, Financial, Engineering, Database, Reserved) rather than a per-row column. ~52 rows have empty/short Notes — full per-row parity-note expansion is the documented Phase 4.3+ follow-up. The original ECM-4-02 prose was rewritten to match the actual schema.  
quantbook-engine/docs/MASTER-PLAN.md:412:   - ECM-4-03 ✅ `scripts/report-compat-coverage.sh` parses the matrix and emits human-readable + JSON output with per-category breakdown and headline `coverage=NN%`.  
quantbook-engine/docs/MASTER-PLAN.md:413:   Shipped baseline: 217 rows (post-W5-46 + W5-48 status revisions: 70 ✅ + 16 ⚠️ + 1 🔄 + 130 ❌) ≈ **40% coverage**.  
quantbook-engine/docs/MASTER-PLAN.md:414:   Effort: 2-3 days (actual: ~0.5 day for V1 + 0.1 day for audit closure).
quantbook-engine/docs/MASTER-PLAN.md:416:3. **4.3 Function Library Expansion Wave 1 - Core 100** 🔄 IN PROGRESS (V1 batch shipped 2026-05-13, W5-46; FN4-02 backfill W5-48)  
quantbook-engine/docs/MASTER-PLAN.md:418:   **V2 prerequisites (W5-49 decision; SHIPPED W5-50 + W5-52):**
quantbook-engine/docs/MASTER-PLAN.md:419:   - GAP-G-01 + GAP-G-03 (graph correctness): SHIPPED. W5-50 wired revocation into the rebind path; W5-52 (mega-audit closure) extended it to the clear path that W5-50 missed. See `docs/architecture/2026-05-13-graph-storage-decision.md`.
quantbook-engine/docs/MASTER-PLAN.md:420:   - ~~**GAP-F-05 (function-dispatch signature)**~~ **SHIPPED W5-53.** Parallel `RangeAwareFn = fn(&[FnArg]) -> Value` table added to `FunctionRegistry`; `enum FnArg { Scalar(Value), Range(Vec<Value>) }`. Eval-side dispatch checks the range-aware table first. SUMIF + COUNTIF shipped in the same commit as the first range-aware functions. The full range-aware family (SUMIFS / AVERAGEIF / SUMPRODUCT / VLOOKUP / HLOOKUP / MATCH / INDEX / CHOOSE) is now safely unblocked.
quantbook-engine/docs/MASTER-PLAN.md:424:   - FN4-01 ✅ **CLOSED W5-58** — registry at 102 entries (30 pre-W5-46 → 52 V1 → 59 W5-51 trig → 61 W5-53 SUMIF/COUNTIF → 66 W5-54 lookup → 71 W5-55 IFS + SUMPRODUCT → 81 W5-56 text wave 2 → 95 W5-57 math + hyperbolic → 102 W5-58 stats family). FN4-01 acceptance: 100-function target met.  
quantbook-engine/docs/MASTER-PLAN.md:425:   - FN4-02 ✅ (after W5-48 backfill) each V1-batch function now has positive + error + coercion + arity tests. Initial V1 commit (W5-46) had only positive tests for most fns; Codex deep-audit H5 flagged the gap; W5-48 closure adds 9 dedicated H5 backfill tests (ROUNDDOWN/TRUNC/SIGN/EXP/LOG10/DEGREES+RADIANS/UPPER+LOWER/TRIM/LEN-unicode).  
quantbook-engine/docs/MASTER-PLAN.md:426:   - FN4-03 ❌ IF/IFERROR lazy eval still deferred.  
quantbook-engine/docs/MASTER-PLAN.md:427:   - FN4-04 ✅ matrix updated; coverage 32% → 40%; UPPER/LOWER reclassified ⚠️ partial (Unicode-default mapping diverges from Excel for ß and other locale-sensitive chars); ROUNDUP/ROUNDDOWN reclassified ⚠️ partial (binary-float edge cases vs Excel's 15-digit display rounding); LEN annotated as known scalar-vs-UTF-16 divergence.  
quantbook-engine/docs/MASTER-PLAN.md:428:   V1 batch shipped (22 functions): ROUNDUP, ROUNDDOWN, TRUNC, SIGN, EXP, LN, LOG, LOG10, PI, DEGREES, RADIANS, LEN, UPPER, LOWER, TRIM, ISNUMBER, ISTEXT, ISBLANK, ISLOGICAL, ISERROR, ISNA, ISERR. All scalar (per-cell, no range deps beyond what 3.6 already provides). Excel-canon error propagation; W5-48 fixed M7 (DEGREES/RADIANS now sanitize output via `sanitize_f64` so Inf surfaces as `#NUM!`).  
quantbook-engine/docs/MASTER-PLAN.md:429:   FN4-01 closure complete (W5-58). Shipped: trig W5-51, SUMIF/COUNTIF W5-53, lookup family W5-54, IFS family + SUMPRODUCT W5-55, text wave 2 W5-56, math completion + hyperbolic W5-57, stats family W5-58. **Phase 4.3 polish wave 1 shipped W5-61 + closed W5-62**: wildcards in SUMIF/COUNTIF/SUMIFS/AVERAGEIF/SEARCH (`?`, `*`, `~` escape; text-cell-only), CONCAT (range-aware, 32K cap), PROPER, CLEAN, CEILING.MATH, FLOOR.MATH, RANK.AVG. Polish remaining (deferred to wave 2 / Phase 4.7+): MODE.MULT (needs spill), CEILING.PRECISE / FLOOR.PRECISE, FN4-03 lazy IF/IFERROR.  
quantbook-engine/docs/MASTER-PLAN.md:433:   - ROUNDUP/ROUNDDOWN: binary-float edges (`0.1 + 0.2` rounds up to `0.4` not `0.3`); Phase 4.5 number formats + decimal-aware rounding revisits.  
quantbook-engine/docs/MASTER-PLAN.md:434:   Effort: 2-3 weeks (V1 batch + audit closure: ~0.6 day; remaining: 1-2 weeks).
quantbook-engine/docs/MASTER-PLAN.md:439:   - **4.4 design (W5-63 ✅)** — `docs/architecture/2026-05-13-coercion-matrix.md` (Codex-reviewed, 3 HIGH + 4 MEDIUM + 3 LOW findings synthesized).
quantbook-engine/docs/MASTER-PLAN.md:440:   - **4.4.A helper migration (W5-64 ✅)** — `ql-types::coercion` gained `to_text_for_arg`, `to_int_arg`, `to_number_strict_skip_blank`, `format_number_for_arg` + NaN/Inf policy on text/display.
quantbook-engine/docs/MASTER-PLAN.md:443:   - **4.4 mega-audit closure (W5-67 ✅)** — Codex + Sonnet parallel mega-audit. 2 HIGH (COUNT canon mismatch → GAP-F-06 + V1 divergence relabel; error-matrix overclaim → honest framing) + 7 MEDIUM + 3 LOW all addressed.  
quantbook-engine/docs/MASTER-PLAN.md:445:   Acceptance: COER-4-01 matrix checked in ✅; COER-4-02 arithmetic, comparison, aggregate, logical, and text coercion cases covered ✅ (W5-65 tests); COER-4-03 no silent fallback for unsupported variants ✅ (W5-64 NaN/Inf policy + matrix-tests).  
quantbook-engine/docs/MASTER-PLAN.md:448:5. **4.5 Dates, Times, Number Formats — ✅ FULLY SHIPPED 2026-05-13 (W5-69 → W5-84)**  
quantbook-engine/docs/MASTER-PLAN.md:450:   **Design doc (Codex-reviewed W5-68):** `docs/architecture/2026-05-13-dates-times-formats.md` — 6 sub-phases (4.5.A.0 EvalContext tier, 4.5.A epoch+serial, 4.5.B 18-fn V1 wave, 4.5.C 7-fn V2 wave, 4.5.D format parser + sparse overlay + op-log, 4.5.E TEXT() + locale stubs). 4 HIGH + 8 MEDIUM + 5 LOW Codex findings synthesized into the design.  
quantbook-engine/docs/MASTER-PLAN.md:451:   **4.5.D companion mini-spec (W5-77):** `docs/architecture/2026-05-13-format-string-grammar.md` — EBNF + token table + section semantics + V1/V2 split + IronCalc-divergence catalog + error categories. Lands BEFORE parser implementation per design doc § 13 (W5-49 pattern).  
quantbook-engine/docs/MASTER-PLAN.md:453:   - **4.5.A.0** ✅ SHIPPED W5-69 — `EvalContext` + `ContextAwareFn` registry tier.
quantbook-engine/docs/MASTER-PLAN.md:454:   - **4.5.A** ✅ SHIPPED W5-70/W5-71 — `ql-types::date` module + `Workbook::date_system` + `.qbook` schema v3 migration.
quantbook-engine/docs/MASTER-PLAN.md:456:   - **4.5.C** ✅ SHIPPED W5-75 — V2 wave 4/6 (DATEDIF/DAYS360/WEEKNUM/ISOWEEKNUM; NETWORKDAYS.INTL + WORKDAY.INTL deferred to tier-4 build).
quantbook-engine/docs/MASTER-PLAN.md:462:   Acceptance: DTF-4-01 1900/1904 policy explicit; DTF-4-02 date/time functions match matrix; **DTF-4-03 re-scoped to "format parser has en-US fully populated + extension point for locale; en/de/fr behavior tests move to Phase 4.9"** (Codex HIGH 3) — **Phase 4.9 (W5-138 → W5-152, 2026-05-15) shipped R1C1 + locale separators + `@` but did NOT add format-string locale tests; those remain deferred to a future Phase**; DTF-4-04 storage distinguishes value from display format via sparse format overlay + workbook FormatTable.  
quantbook-engine/docs/MASTER-PLAN.md:465:6. **4.6 Cross-Sheet References And Sheet-Scoped Names** ✅ **FULLY SHIPPED** (W5-85 → W5-93, 2026-05-14)
quantbook-engine/docs/MASTER-PLAN.md:469:   - 4.6.B (W5-90) — `SheetResolver` trait + `bind_with_names_and_sheets` + `BindError::UnknownSheet`. **XS-4-01 closed.**
quantbook-engine/docs/MASTER-PLAN.md:471:   - 4.6.D (W5-92) — sheet-scoped names: `Sheet::scoped_names` + `NameLookup for Workbook` two-tier chain + `Op::SetName { scope, .. }` + schema v5 `NamedEntry.scope`. **XS-4-03 closed.**
quantbook-engine/docs/MASTER-PLAN.md:472:   - 4.6.E (W5-93) — closing mega-audit (Codex + Sonnet parallel). Closed 2 HIGH (sheet-name validation at storage/runtime/replay; PlanCache invalidation on sheet-scoped name change) + 3 MEDIUM (printer doc, producer-replay scope coverage, doc rot) + filed GAP-B-06 (`NamedTarget::Formula` rewrite on rename), GAP-B-07 (`A1!B2` lexer accepts), GAP-B-08 (resolver-aware print).
quantbook-engine/docs/MASTER-PLAN.md:474:   Acceptance: XS-4-01 ✅ cross-sheet cell refs parse, print, bind, and recompute; XS-4-02 ✅ quoted names work; XS-4-03 ✅ sheet-scoped names resolve before workbook-scoped names; XS-4-04 ✅ op-log preserves sheet identity (xlsx is Phase 4.11). **3D references explicit non-goal** per design doc § 10.5.
quantbook-engine/docs/MASTER-PLAN.md:475:   Effort actual: 8 commits W5-86→W5-92 plus W5-93 closure ≈ 1 week as planned. Design doc: `docs/architecture/2026-05-13-cross-sheet-references.md`. Audit prompt + Codex/Sonnet outputs in `docs/audits/2026-05-14-phase-4.6-closing-megaudit-*`.
quantbook-engine/docs/MASTER-PLAN.md:480:   Acceptance: ARR-4-01 array literals parse and evaluate; ARR-4-02 spill writes computed overlay only; ARR-4-03 blocked spills return the right error; ARR-4-04 dynamic spill resizing invalidates dependents.  
quantbook-engine/docs/MASTER-PLAN.md:486:   Acceptance: TBL-4-01 table refs parse/print; TBL-4-02 column insert/delete updates refs; TBL-4-03 table aggregate dependencies use range graph; TBL-4-04 xlsx import creates tables.  
quantbook-engine/docs/MASTER-PLAN.md:488:   **Status (2026-05-16): SHIPPED.** Phase 4.8 core shipped 2026-05-15 at `6717ae7fe9f` (closing megaudit SHIP-READY at W5-129); the 4.8.G.3 calcgraph-hook polish wave (originally marked OPTIONAL) shipped 2026-05-15 → 2026-05-16 at `3ff9c1501cc` (W5-159) after the W5-150 / W5-155 audit cycles demonstrated the hooks were load-bearing for the design § 12.4 contract ("dropped-table refs emit `#NAME?`"). Six commits closed 4.8.G.3: W5-154 `table_to_formulas` reverse index + `on_table_drop` hook; W5-155 wired drop_table; W5-156 HIGH-1 plan-cache flush + HIGH-2 bind-error → `#NAME?` mapping (3-way audited); W5-157 `on_table_rename` with `deps.tables` Arc substitution + re-key; W5-158 coarse `on_column_rename`; W5-159 `on_table_resize` + runtime-side `reextract_table_readers` for range-stripe refresh. Acceptance: TBL-4-01 ✅ parser/printer/binder coverage exhaustive; TBL-4-02 ✅ column rename/resize hooks + reverse index ship; TBL-4-03 ✅ range graph + stripe refresh after resize; TBL-4-04 ⏳ deferred to Phase 4.11 xlsx I/O. 4.8.N soft-fail (accept-text-then-error-cell) remains DEFERRED — backwards-incompatible. W5-160 plan-cache `table_gen` polish remains OPTIONAL (current `plan_cache.clear()` is correct; targeted `table_gen` would only marginally improve memory).
quantbook-engine/docs/MASTER-PLAN.md:493:   Acceptance: LOC-4-01 R1C1 parser/printer round-trips; LOC-4-02 localized separators covered; LOC-4-03 implicit intersection added where Excel requires it; LOC-4-04 IDE can toggle formula display mode.  
quantbook-engine/docs/MASTER-PLAN.md:495:   **Status (2026-05-15): SHIPPED triple-confirmed at `6523001b837` (W5-152).** All 15 sub-phases shipped (AA design + A types + B.1-.4 lexer + C parser+binder + D printer + F locale-printer + G `@`-parser-printer + H `@`-binder + I persistence v6→v7 + J op-log + K runtime+canonical + L round-trip + M coverage matrix + N polish + O closing megaudit). Acceptance closures: LOC-4-01 R1C1 round-trips pinned at lex/parse/bind/print stages; LOC-4-02 EN/DE/FR separators pinned by 30-cell coverage matrix; LOC-4-03 `@` operator + design § 3.3 9-rule narrowing implemented at bind time; LOC-4-04 `WorkbookRuntime::set_reference_mode` + `set_locale` APIs available. Closing megaudit (three-way: self-review + Sonnet + Codex async) found 1 HIGH (PlanCache × `@<range>` cell collision — fixed W5-150) + 2 MEDIUM (W5-151) + 3 LOW (W5-152). +175 net tests (2443 → 2618). Function-name localization remained OUT-of-scope per LOC-4-02 (separators only). Known gaps documented: rule 7 (array-returning function under `@` returns `#CALC!` per existing 4.7.G limit) → cell-boundary spill rewiring; cross-sheet structured refs (`Sheet1.Sales[Qty]`) → later Phase. Full audit trail in `docs/audits/2026-05-15-phase-4.9-*.md`.
quantbook-engine/docs/MASTER-PLAN.md:497:10. **4.10 Function Library Expansion Wave 2 - V1 260**  
quantbook-engine/docs/MASTER-PLAN.md:500:    Acceptance: FN4-260-01 roughly 260 target functions implemented or explicitly cut; FN4-260-02 every implemented function has matrix-backed tests; FN4-260-03 unsupported functions produce visible errors.  
quantbook-engine/docs/MASTER-PLAN.md:503:    **Status (2026-05-17 → 2026-05-18): SHIPPED at 260/260 registered fns** through MASTER-PLAN marker `5d117724f27` (impl HEAD `517bcab08b7` for W5-D-12.1 audit transcripts; subsequent megaudit closure W5-D-13.1 lands on top). Path: W5-D-1..W5-D-7 Wave 3 distributions (+38 → 238), W5-D-8 BIT* (+5 → 243), W5-D-9 base conversion (+6 → 249), W5-D-10 ERF/ERFC family (+4 → 253), W5-D-11 PERCENTILE/QUARTILE (+6 → 259), W5-D-12 SUBTOTAL (+1 → **260** — V1-260 hit). 12 closeout-arc batches with ship+audit commit pairs each (24 audit transcript files: 1 Codex + 1 Opus per batch). Matrix coverage 82% post-W5-D-13.1 megaudit closure per `scripts/report-compat-coverage.sh`. Acceptance: FN4-260-01 ✅ 260 registered; FN4-260-02 ✅ every fn has matrix-backed tests + coverage-discipline EXPLICITLY_DEFERRED entry; FN4-260-03 ✅ unregistered fns produce `#NAME?`. Per-batch audit-discipline rule (parallel Codex + separate-Opus) caught Codex 1H/2M/7L + Opus 5H/10M/20L across the 5 V1-260 closeout batches; all closed in-commit per the `.1` convention. **W5-D-13.1 phase megaudit** (2026-05-18, parallel Codex + Opus + self) caught 6 ADDITIONAL HIGH issues invisible at the per-batch level: 28 range-aware fns missing from `is_aggregate_function` binder admission (extending the W5-D-12 SUBTOTAL-only fix to the whole family), 3 fns unreachable from formula source text (ATAN2/SUMXMY2/DAYS360 — lexer letters>3+digit gap), `GAMMA.INV` finite-subnormal-scale panic (incomplete W5-D-5.1 closure), W5-D-12 closure shipped without recommended named-range e2e test, audit-discipline systemic blind spot for dispatch-path coverage, 21 fns in Date/Time + TRANSPOSE marked ❌ but registered (matrix-registry drift). All 6 HIGHs closed in W5-D-13.1. Known follow-ups (deferred, NOT regressions): (a) literal range refs in `AggregateArg` context (`SUM(A1:A10)`, `CORREL(A1:A4, B1:B4)`) remain unbindable — pre-existing engine-wide gap at `plan.rs:706-731` and `plan.rs:380-383`, affects EVERY aggregate not just Phase 4.10 fns; named-range and scalar-args paths work today via W5-D-13.1; (b) Batch E remainders LOOKUP vector form + LEFTB/RIGHTB/MIDB/LENB/FINDB/SEARCHB byte-length variants. Full audit trail: 24 per-batch transcripts at `docs/audits/2026-05-17-w5-d-*.md` + 3 megaudit transcripts at `docs/audits/2026-05-17-phase-4-10-megaudit-{codex,opus,self}.md`.
quantbook-engine/docs/MASTER-PLAN.md:505:11. **4.11 XLSX Import/Export** ✅ SHIPPED 2026-05-18 (W5-D-14a → W5-D-15.2 + W5-D-PM-1..5)
quantbook-engine/docs/MASTER-PLAN.md:507:    Acceptance: XLSX-4-01 ✅ import common workbooks (177/177 IronCalc fixtures); XLSX-4-02 ✅ formulas recalc through graph; XLSX-4-03 ✅ names/tables/formats/per-cell-application all survive round-trip; XLSX-4-04 ✅ corruption and unsupported features surface via `dropped_features` + Strict policy.
quantbook-engine/docs/MASTER-PLAN.md:508:    Shipped: 11 commits W5-D-14a → W5-D-15.2 + 5 megaudit closure batches (W5-D-PM-1..5) closing 17 of 20 unique HIGHs from a 5-way parallel megaudit. Phase 4.11 megaudit transcripts at `docs/audits/2026-05-18-phase-4-11-megaudit-{design,codex,opus-a,opus-b,opus-c,self,consolidated}.md`. 3 deferred items tracked in `docs/PHASE-4-V2-BACKLOG.md`.
quantbook-engine/docs/MASTER-PLAN.md:510:12. **4.12 Phase 4 Megaudit And Compatibility Freeze** ✅ SHIPPED 2026-05-18 (W5-D-PM12, PM12-1..PM12-3)
quantbook-engine/docs/MASTER-PLAN.md:512:    Acceptance: A4-01 ✅ all gates green (4135 workspace tests); A4-02 ✅ compatibility matrix (311 rows, 83% coverage); A4-03 ✅ Excel corpus smoke green (177/177 fixtures); A4-04 ✅ test count 4135 / 946 Phase 3 exit = 4.37× (target ≥ 2× cleared).
quantbook-engine/docs/MASTER-PLAN.md:513:    Shipped: 5-way parallel megaudit (Codex / Opus-A / Opus-B / Opus-C / self) caught 19 unique HIGHs invisible at per-sub-phase level; 5 closed (correctness + panic + matrix integrity + NUL-in-strings + parser-and-semantics index); 14 deferred to Phase 5 prep with explicit dispositions in `docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md` + tracked in `docs/PHASE-4-V2-BACKLOG.md`. Phase 4 exit packet at `docs/phase4/exit-packet.md` (ACTIVE).
quantbook-engine/docs/MASTER-PLAN.md:525:**Exit Criteria** — ALL MET (Phase 4 SHIPS 2026-05-18)
quantbook-engine/docs/MASTER-PLAN.md:528:- ✅ Function target reached (260 registered fns, V1-260 hit `5d117724f27`).
quantbook-engine/docs/MASTER-PLAN.md:537:- `docs/phase4/exit-packet.md` ✅ ACTIVE (2026-05-18).
quantbook-engine/docs/MASTER-PLAN.md:539:- `docs/architecture/parser-and-semantics.md` ✅ INDEX shipped 2026-05-18 (W5-D-PM12) pointing at 9 underlying architecture docs.
quantbook-engine/docs/MASTER-PLAN.md:541:- `docs/PHASE-4-V2-BACKLOG.md` ✅ (NEW 2026-05-18) — aggregated 14 deferred HIGHs from Phase 4.11+4.12 megaudits.
quantbook-engine/docs/MASTER-PLAN.md:545:**Status (2026-05-21): Phase 5 V1 + D-1 + 5.3 + 5.5 V2 V2 + 5.5 V2 V3 steps 1-2 COMPLETE.** Canonical records: `docs/phase5/v1-exit-packet.md` (V1) + `docs/phase5/d-1-exit-packet.md` (D-1 closure) + `docs/phase5/5-3-exit-packet.md` (5.3 closure). Remaining: 5.5 V2 V3 steps 3-6 (offline-write queue + WebSocket impl + megaudit + exit packet), 5.7 IDE slice, 5.8 Phase 5 megaudit (separate).
quantbook-engine/docs/MASTER-PLAN.md:562:1. **5.1 Collaboration Data Model Decision** ✅ SHIPPED 2026-05-19 (`918d7efdd91` + `df52cb44ad2`).
quantbook-engine/docs/MASTER-PLAN.md:563:   Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 ✅ SHIPPED 2026-05-20 (see 5.2 + `docs/phase5/d-1-exit-packet.md`).
quantbook-engine/docs/MASTER-PLAN.md:568:   - ✅ D-4 (`2f217a2067a`) OpLog::merge_bytes + 2-peer spill probe.
quantbook-engine/docs/MASTER-PLAN.md:569:   - ✅ 5.2.a scaffold (`66a571b30af`).
quantbook-engine/docs/MASTER-PLAN.md:570:   - ✅ 5.2.b PeerId → LoroDoc wiring (`ef056f50bee`).
quantbook-engine/docs/MASTER-PLAN.md:571:   - ✅ **D-1 (FormatId tagged tuple, multi-day) — SHIPPED 2026-05-20.** All 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit complete. **16/16 audit cycles caught real bugs.** Workspace tests: 4222 → 4291 (+69). See `docs/phase5/d-1-exit-packet.md` for the closure record + `docs/phase5/d-1-starting-checklist.md` for execution-trace history.
quantbook-engine/docs/MASTER-PLAN.md:573:3. **5.3 Conflict Resolution Semantics** ✅ SHIPPED 2026-05-20. Causality-aware rename-repair pass for sheets + tables + columns. 4 days actual (vs 4-7 day estimate). All 6 steps + 14 audit cycles complete. **14/14 audit cycles caught real bugs.** Workspace tests: 4291 → 4361 (+70). New public API: `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` convenience wrapper. See `docs/phase5/5-3-exit-packet.md` for the closure record + 20 audit transcripts at `docs/audits/2026-05-20-phase-5-3-*.md`. 13 V1 limitations tracked at `docs/PHASE-4-V2-BACKLOG.md` Tier H. **Production-visible D-3 closure happens at step 5.7 IDE binding** (rebuild_workbook is shipped as the API entry; IDE has to wire it).
quantbook-engine/docs/MASTER-PLAN.md:575:4. **5.4 Undo/Redo And Operation Grouping** ✅ V1 + V2 V1 + V2 V1.1 SHIPPED 2026-05-19.
quantbook-engine/docs/MASTER-PLAN.md:576:   - V1 (`89c02b9d83e`): 7 undo/redo methods on CollabSession wrapping `loro::UndoManager`; presence-origin commits auto-excluded.
quantbook-engine/docs/MASTER-PLAN.md:577:   - V2 V1 (`6138a7203f6` + `e199a5fda5a`): `start_undo_group` / `end_undo_group` + `set_undo_merge_interval`.
quantbook-engine/docs/MASTER-PLAN.md:581:5. **5.5 Transport Layer And Offline Sync** 🟡 V1 + V2 V1 + V2 V2 (auto-flush) + V2 V3 step 1 (delta flush) SHIPPED 2026-05-21; V2 V3 steps 2-6 pending.
quantbook-engine/docs/MASTER-PLAN.md:582:   - V1 (`924750819bc`): `Transport` trait + `NoopTransport` + `LoopbackTransport::pair()`.
quantbook-engine/docs/MASTER-PLAN.md:583:   - V2 V1 (`ffd8f6e5f05`): `CollabSession::{attach,detach,has}_transport` + `flush_to_transport` + `poll_remote` (+ `_with_limit`). Explicit-drive.
quantbook-engine/docs/MASTER-PLAN.md:584:   - V2 V2 (`51748b02944` ship + `b7aa4cb7bb9` audit-closure): `AutoFlushPolicy::{Disabled, OnAppend}` enum. Default `Disabled` (V2 V1 behavior); `OnAppend` triggers flush after every mutator.
quantbook-engine/docs/MASTER-PLAN.md:585:   - V2 V3 step 1 (`603bdc9aa6c` ship + `e5ff11d549a` audit-closure): per-transport version-vector tracking + `CollabSession::flush_delta_to_transport` using `LoroDoc::ExportMode::Updates`. Auto-flush reroutes through the delta path. Idempotency short-circuit closes V2 V2 audit echo-loop class. New `OpLog` API: `oplog_vv()` + `export_delta_bytes(&VersionVector)`.
quantbook-engine/docs/MASTER-PLAN.md:586:   - **V2 V3 step 2 ✅ SHIPPED 2026-05-21**: wires `poll_remote*` into auto-flush. One flush per drain batch (not per-blob). V2 V3 step 1's idempotency guard prevents echo loops — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)`. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion. 3-peer hub fanout now works automatically under `OnAppend`.
quantbook-engine/docs/MASTER-PLAN.md:589:6. **5.6 Presence And Awareness** ✅ V1 + V2 SHIPPED 2026-05-19.
quantbook-engine/docs/MASTER-PLAN.md:590:   - V1 (`c677e244704`): `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods.
quantbook-engine/docs/MASTER-PLAN.md:616:- `docs/phase5/v1-exit-packet.md` ✅ (Phase 5 V1 canonical closeout 2026-05-19).
quantbook-engine/docs/MASTER-PLAN.md:619:- 23 audit transcripts at `docs/audits/2026-05-19-*` covering 11 audit cycles.
quantbook-engine/docs/MASTER-PLAN.md:642:   Acceptance: API6-01 one Rust trait/API backs all bindings; API6-02 cancellation included; API6-03 errors are structured.  
quantbook-engine/docs/MASTER-PLAN.md:648:   Acceptance: SVC-6-01 service opens and edits workbook; SVC-6-02 streams diagnostics; SVC-6-03 cancellation works; SVC-6-04 protocol versioned.  
quantbook-engine/docs/MASTER-PLAN.md:654:   Acceptance: BND-6-01 smoke tests for all bindings; BND-6-02 C ABI guardrails; BND-6-03 Python wheel builds; BND-6-04 Node binding consumed by IDE path or test harness.  
quantbook-engine/docs/MASTER-PLAN.md:660:   Acceptance: UDF-6-01 Python UDF callable from formula; UDF-6-02 timeout/cancel works; UDF-6-03 type conversion matrix tested; UDF-6-04 sandbox limitations documented.  
quantbook-engine/docs/MASTER-PLAN.md:666:   Acceptance: SQL-6-01 query table/sheet; SQL-6-02 materialize result to sheet; SQL-6-03 refresh dirties dependents; CONN-6-01 CSV/local connector; CONN-6-02 errors visible.  
quantbook-engine/docs/MASTER-PLAN.md:672:   Acceptance: AI-6-01 AI() executes through configured backend; AI-6-02 missing credentials produce visible error; AI-6-03 cancellation works; AI-6-04 results carry provenance/caching metadata.  
quantbook-engine/docs/MASTER-PLAN.md:677:   Acceptance: A6-01 all gates green; A6-02 binding smoke matrix green; A6-03 security review checked in; A6-04 no unpinned deps.  
quantbook-engine/docs/MASTER-PLAN.md:722:   Acceptance: OBS-7-01 profile captures every critical runtime phase; OBS-7-02 IDE can show diagnostics; OBS-7-03 logs contain no secrets.  
quantbook-engine/docs/MASTER-PLAN.md:728:   Acceptance: SCALE-7-01 1B-cell sparse workbook opens without dense allocation; SCALE-7-02 target perf envelopes documented; SCALE-7-03 CI has short smoke and long manual profiles.  
quantbook-engine/docs/MASTER-PLAN.md:734:   Acceptance: PERF-7-01 no regression against Phase 0 locked gates; PERF-7-02 dirty recompute budgets documented; PERF-7-03 memory profiles collected.  
quantbook-engine/docs/MASTER-PLAN.md:740:   Acceptance: IDE-7-01 product walkthrough passes; IDE-7-02 no in-app fallback messages hiding engine errors; IDE-7-03 keyboard/mouse workflows usable.  
quantbook-engine/docs/MASTER-PLAN.md:746:   Acceptance: REL-7-01 reproducible release build; REL-7-02 artifacts signed/checksummed; REL-7-03 migration guide written; REL-7-04 rollback tested.  
quantbook-engine/docs/MASTER-PLAN.md:751:   Acceptance: SHIP-7-01 all gates green; SHIP-7-02 HIGH findings closed; SHIP-7-03 MEDIUM findings either closed or explicitly accepted; SHIP-7-04 release checklist signed.  
quantbook-engine/docs/MASTER-PLAN.md:768:- Docs are coherent from Phase 0 through v1.
quantbook-engine/docs/MASTER-PLAN.md:842:3. **Do we support 1900 and 1904 date systems in v1, and how do we expose workbook policy?**  
quantbook-engine/docs/MASTER-PLAN.md:850:5. **How much localization is v1 versus post-v1?** **DECIDED at Phase 4.9 (W5-138 → W5-152, 2026-05-15).**  
quantbook-engine/docs/MASTER-PLAN.md:852:   **Decision:** v1 ships locale-aware SEPARATORS only (decimal, argument, array row, array col) for EnUs / De / Fr. Function-name localization is OUT-of-scope for v1 per LOC-4-02 reading. UTF-16 string semantics + locale-aware case mapping (UPPER/LOWER) also out-of-scope for Phase 4.9; awaiting a future Phase. See `docs/architecture/2026-05-15-r1c1-locales-implicit-intersection.md` § 2 (non-goals).
quantbook-engine/docs/MASTER-PLAN.md:870:10. **Does `ql-terminal` remain in v1 scope?**  

exec
/bin/zsh -lc 'git diff --unified=40 e5ff11d549a..HEAD -- quantbook-engine/docs/architecture/ide-consumer-contract.md quantbook-engine/docs/MASTER-PLAN.md quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/entry-plan.md quantbook-engine/crates/ql-collab/src/transport.rs' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
diff --git a/quantbook-engine/crates/ql-collab/src/transport.rs b/quantbook-engine/crates/ql-collab/src/transport.rs
index d9599467afe..2ee2267568c 100644
--- a/quantbook-engine/crates/ql-collab/src/transport.rs
+++ b/quantbook-engine/crates/ql-collab/src/transport.rs
@@ -1,75 +1,78 @@
 //! `Transport` trait — wire-byte channel for Phase 5 collaboration.
 //!
 //! **Phase 5.2.a (2026-05-19, scaffold):** trait shape defined.
 //! **Phase 5.5 V1 (2026-05-19, `924750819bc`):** `LoopbackTransport`
 //! shipped — in-process paired endpoints for 2-peer tests.
 //! **Phase 5.5 V2 V1 (2026-05-19, `ffd8f6e5f05` + audit closure):**
 //! `CollabSession` exposes 5 typed transport methods
 //! (`attach_transport` / `detach_transport` / `has_transport` /
 //! `flush_to_transport` / `poll_remote` (+ `poll_remote_with_limit`)).
 //! V2 V1 is "explicit drive" — caller invokes flush + poll on a
 //! tick.
 //! **Phase 5.5 V2 V2 (2026-05-21):** `AutoFlushPolicy` enum on
 //! `CollabSession`. Opt-in `OnAppend` invokes flush automatically
 //! after every mutator. Default is `Disabled` (V2 V1 behavior
 //! preserved). See [`crate::AutoFlushPolicy`] +
 //! [`crate::CollabSession::set_auto_flush_policy`].
-//! **Phase 5.5 V2 V3 step 1 (2026-05-21, this ship):** version-vector
-//! tracking for the **currently attached** transport baseline + delta
-//! flushes. New `CollabSession::flush_delta_to_transport` sends only
-//! the delta since the last successful flush, using
-//! `LoroDoc::ExportMode::Updates`. Auto-flush now routes through
-//! this delta path — wire payload is O(per-op delta) instead of
-//! O(full state). Includes an idempotency short-circuit (no
-//! state change → no send), which closes the V2 V2 audit
-//! echo-loop concern. Codex step 1 audit L3 (2026-05-21): the
-//! checkpoint is per-session-currently-attached-transport, NOT
-//! per-transport-identity — `attach_transport` resets the baseline,
-//! so re-attaching a previously-attached transport starts a fresh
-//! delta chain (Loro dedupe on the peer keeps state convergent;
-//! bandwidth-wasted but correct). V2 V3 step 4 (WebSocket
-//! handshake) will optionally expose "peer already has VV X" so
-//! reconnects don't re-send history.
-//! **Phase 5.5 V2 V3 remaining (pending):** poll_remote auto-flush
-//! wiring (step 2) + offline-write queue (step 3) + WebSocket impl
-//! (step 4) + reconnect / offline sync semantics.
+//! **Phase 5.5 V2 V3 step 1 (2026-05-21):** version-vector tracking
+//! for the **currently attached** transport baseline + delta flushes.
+//! `CollabSession::flush_delta_to_transport` sends only the delta
+//! since the last successful flush via `LoroDoc::ExportMode::Updates`.
+//! Auto-flush routes through this delta path — wire payload is
+//! O(per-op delta) instead of O(full state). Idempotency
+//! short-circuit (no state change → no send) closes the V2 V2
+//! echo-loop concern. The checkpoint is
+//! per-session-currently-attached-transport, NOT per-transport-
+//! identity (`attach_transport` resets the baseline).
+//! **Phase 5.5 V2 V3 step 2 (2026-05-21, this ship):** wires
+//! `poll_remote*` into auto-flush. After a successful drain
+//! (`merged > 0`), one auto-flush fires per call (not per-blob —
+//! bandwidth-efficient). The V2 V3 step 1 idempotency guard
+//! prevents echo loops: drained bytes that Loro dedupes leave the
+//! VV unchanged → flush short-circuits to `Ok(false)`. The 3-peer
+//! hub-fanout pattern (peer A drains peer B's blob → auto-flushes
+//! merged state onward) now works automatically under `OnAppend`.
+//! Reverses the V2 V2 audit-locked "receive-side excluded" exclusion.
+//! **Phase 5.5 V2 V3 remaining (pending):** offline-write queue
+//! (step 3) + WebSocket impl (step 4) + full-arc megaudit (step 5)
+//! + exit packet (step 6).
 //!
 //! Tests can also use [`NoopTransport`] which discards traffic.
 //!
 //! The contract is intentionally minimal:
 //!
 //! - `send(&mut self, bytes: &[u8])` — push bytes to the channel.
 //!   Bytes are an opaque blob (a Loro export). The transport
 //!   doesn't interpret them.
 //! - `try_recv(&mut self) -> Option<Vec<u8>>` — non-blocking
 //!   receive. Returns `None` if no bytes are queued.
 //!
 //! That's enough to plumb a `CollabSession::export_bytes` →
 //! transport → remote `CollabSession::merge_bytes` flow. The
 //! transport handles framing / reliability / reconnect / auth as
 //! its implementation details.
 
 use std::collections::VecDeque;
 use std::sync::atomic::{AtomicBool, Ordering};
 use std::sync::{Arc, Mutex};
 
 use thiserror::Error;
 
 /// Errors emitted by `Transport` impls.
 #[derive(Debug, Error)]
 #[non_exhaustive]
 pub enum TransportError {
     /// The underlying I/O failed (socket dead, network partition,
     /// etc.). Implementations should distinguish recoverable
     /// (reconnect) from permanent (auth rejected) failures via
     /// variant structure in their own error type, then map to this
     /// variant at the trait boundary if they don't want to expose
     /// implementation details.
     #[error("transport I/O error: {0}")]
     Io(String),
 
     /// The transport is closed and no further sends are accepted.
     /// Receivers should still drain any already-queued bytes via
     /// `try_recv` before considering the channel done.
     #[error("transport closed")]
     Closed,
diff --git a/quantbook-engine/docs/MASTER-PLAN.md b/quantbook-engine/docs/MASTER-PLAN.md
index 6f9ac77b062..916c5b9ff15 100644
--- a/quantbook-engine/docs/MASTER-PLAN.md
+++ b/quantbook-engine/docs/MASTER-PLAN.md
@@ -505,122 +505,123 @@ The full v1 means all of these crates either ship real behavior or have a docume
 11. **4.11 XLSX Import/Export** ✅ SHIPPED 2026-05-18 (W5-D-14a → W5-D-15.2 + W5-D-PM-1..5)
     Make `ql-io-xlsx` real: workbook load, formulas, cached values, names, sheets, tables, formats, date systems, and export.
     Acceptance: XLSX-4-01 ✅ import common workbooks (177/177 IronCalc fixtures); XLSX-4-02 ✅ formulas recalc through graph; XLSX-4-03 ✅ names/tables/formats/per-cell-application all survive round-trip; XLSX-4-04 ✅ corruption and unsupported features surface via `dropped_features` + Strict policy.
     Shipped: 11 commits W5-D-14a → W5-D-15.2 + 5 megaudit closure batches (W5-D-PM-1..5) closing 17 of 20 unique HIGHs from a 5-way parallel megaudit. Phase 4.11 megaudit transcripts at `docs/audits/2026-05-18-phase-4-11-megaudit-{design,codex,opus-a,opus-b,opus-c,self,consolidated}.md`. 3 deferred items tracked in `docs/PHASE-4-V2-BACKLOG.md`.
 
 12. **4.12 Phase 4 Megaudit And Compatibility Freeze** ✅ SHIPPED 2026-05-18 (W5-D-PM12, PM12-1..PM12-3)
     Audit parser, functions, arrays, tables, xlsx, and compatibility matrix.
     Acceptance: A4-01 ✅ all gates green (4135 workspace tests); A4-02 ✅ compatibility matrix (311 rows, 83% coverage); A4-03 ✅ Excel corpus smoke green (177/177 fixtures); A4-04 ✅ test count 4135 / 946 Phase 3 exit = 4.37× (target ≥ 2× cleared).
     Shipped: 5-way parallel megaudit (Codex / Opus-A / Opus-B / Opus-C / self) caught 19 unique HIGHs invisible at per-sub-phase level; 5 closed (correctness + panic + matrix integrity + NUL-in-strings + parser-and-semantics index); 14 deferred to Phase 5 prep with explicit dispositions in `docs/audits/2026-05-18-phase-4-12-megaudit-consolidated.md` + tracked in `docs/PHASE-4-V2-BACKLOG.md`. Phase 4 exit packet at `docs/phase4/exit-packet.md` (ACTIVE).
 
 **Audit Checkpoints**
 
 - Parser audit after 4.1-4.2.
 - Megaudit after 4.11.
 
 **IDE Proof Points**
 
 - IDE must open an imported `.xlsx`, show formulas, edit formulas, save `.qbook`, and export `.xlsx`.
 - Formula bar must handle cross-sheet refs, arrays/spills, and localized/R1C1 modes if enabled.
 
 **Exit Criteria** — ALL MET (Phase 4 SHIPS 2026-05-18)
 
 - ✅ Excel compatibility matrix exists and drives work (`docs/compat/excel-matrix.md`, 311 rows, 83% coverage).
 - ✅ Function target reached (260 registered fns, V1-260 hit `5d117724f27`).
 - ✅ xlsx import/export works for v1 corpus (177/177 IronCalc fixtures).
 - ✅ Arrays/spills/tables/cross-sheet references are graph-integrated.
 
 **Phase 4 SHIPPED at HEAD `3b8939d9522` on `feat/quantbook-engine`.** Exit packet: `docs/phase4/exit-packet.md` (ACTIVE). Phase 4.11 + 4.12 megaudits closed 17 + 5 = 22 HIGHs invisible at per-batch level; 14 deferred to Phase 5 prep with explicit rationale.
 
 **Documentation Deliverables**
 
 - `docs/phase4/entry-plan.md` ⚠️ MISSING (Phase 4 was opportunistic; documented as v1 deferred per Phase 4.12 megaudit self-audit H-1).
 - `docs/phase4/exit-packet.md` ✅ ACTIVE (2026-05-18).
 - `docs/compat/excel-matrix.md` ✅ 311 rows, 83% coverage.
 - `docs/architecture/parser-and-semantics.md` ✅ INDEX shipped 2026-05-18 (W5-D-PM12) pointing at 9 underlying architecture docs.
 - Updated legal/provenance notes ⚠️ EXISTS per-source in `.references/` but no top-level summary; deferred.
 - `docs/PHASE-4-V2-BACKLOG.md` ✅ (NEW 2026-05-18) — aggregated 14 deferred HIGHs from Phase 4.11+4.12 megaudits.
 
 ## Phase 5 - Multi-User CRDT Collaboration
 
-**Status (2026-05-21): Phase 5 V1 + D-1 + 5.3 + 5.5 V2 V2 + 5.5 V2 V3 step 1 COMPLETE.** Canonical records: `docs/phase5/v1-exit-packet.md` (V1) + `docs/phase5/d-1-exit-packet.md` (D-1 closure) + `docs/phase5/5-3-exit-packet.md` (5.3 closure). Remaining: 5.5 V2 V3 steps 2-6 (poll_remote auto-flush + offline-write queue + WebSocket impl + megaudit + exit packet), 5.7 IDE slice, 5.8 Phase 5 megaudit (separate).
+**Status (2026-05-21): Phase 5 V1 + D-1 + 5.3 + 5.5 V2 V2 + 5.5 V2 V3 steps 1-2 COMPLETE.** Canonical records: `docs/phase5/v1-exit-packet.md` (V1) + `docs/phase5/d-1-exit-packet.md` (D-1 closure) + `docs/phase5/5-3-exit-packet.md` (5.3 closure). Remaining: 5.5 V2 V3 steps 3-6 (offline-write queue + WebSocket impl + megaudit + exit packet), 5.7 IDE slice, 5.8 Phase 5 megaudit (separate).
 
 **Purpose:** Turn collaboration from a single-writer op log into real multi-user CRDT state for sheets, cells, names, tables, presence, undo/redo, and offline sync.
 
 **Entry State Required**
 
 - Phase 3 graph runtime exists.
 - Phase 4 semantics are broad enough that collaboration does not need to redesign value/formula/table structures.
 
 **Dependencies**
 
 - Requires stable operation vocabulary from `ql-oplog`.
 - Requires storage semantics for computed versus user state.
 - Requires IDE proof surface for multi-user presence.
 
 **Sub-items**
 
 1. **5.1 Collaboration Data Model Decision** ✅ SHIPPED 2026-05-19 (`918d7efdd91` + `df52cb44ad2`).
    Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in `docs/architecture/crdt-data-model.md`. D-2/D-3/D-4 implemented; D-1 ✅ SHIPPED 2026-05-20 (see 5.2 + `docs/phase5/d-1-exit-packet.md`).
 
 2. **5.2 `ql-collab` Core Documents** 🟡 IN PROGRESS.
    - ✅ D-2 (`1ca19e2fa37`) AddSheet auto-rename.
    - ✅ D-3 (`e71312d4bcd`) UnknownSheet → #NAME?.
    - ✅ D-4 (`2f217a2067a`) OpLog::merge_bytes + 2-peer spill probe.
    - ✅ 5.2.a scaffold (`66a571b30af`).
    - ✅ 5.2.b PeerId → LoroDoc wiring (`ef056f50bee`).
    - ✅ **D-1 (FormatId tagged tuple, multi-day) — SHIPPED 2026-05-20.** All 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit complete. **16/16 audit cycles caught real bugs.** Workspace tests: 4222 → 4291 (+69). See `docs/phase5/d-1-exit-packet.md` for the closure record + `docs/phase5/d-1-starting-checklist.md` for execution-trace history.
 
 3. **5.3 Conflict Resolution Semantics** ✅ SHIPPED 2026-05-20. Causality-aware rename-repair pass for sheets + tables + columns. 4 days actual (vs 4-7 day estimate). All 6 steps + 14 audit cycles complete. **14/14 audit cycles caught real bugs.** Workspace tests: 4291 → 4361 (+70). New public API: `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` convenience wrapper. See `docs/phase5/5-3-exit-packet.md` for the closure record + 20 audit transcripts at `docs/audits/2026-05-20-phase-5-3-*.md`. 13 V1 limitations tracked at `docs/PHASE-4-V2-BACKLOG.md` Tier H. **Production-visible D-3 closure happens at step 5.7 IDE binding** (rebuild_workbook is shipped as the API entry; IDE has to wire it).
 
 4. **5.4 Undo/Redo And Operation Grouping** ✅ V1 + V2 V1 + V2 V1.1 SHIPPED 2026-05-19.
    - V1 (`89c02b9d83e`): 7 undo/redo methods on CollabSession wrapping `loro::UndoManager`; presence-origin commits auto-excluded.
    - V2 V1 (`6138a7203f6` + `e199a5fda5a`): `start_undo_group` / `end_undo_group` + `set_undo_merge_interval`.
    - V2 V1.1 (`7cbdc689ea9`): RAII `start_undo_group_scoped` returning `UndoGroupGuard` (panic/Err-safe). Codex audit PASS.
    - V2 V2 pending: push/pop listeners (lower priority, speculative).
 
 5. **5.5 Transport Layer And Offline Sync** 🟡 V1 + V2 V1 + V2 V2 (auto-flush) + V2 V3 step 1 (delta flush) SHIPPED 2026-05-21; V2 V3 steps 2-6 pending.
    - V1 (`924750819bc`): `Transport` trait + `NoopTransport` + `LoopbackTransport::pair()`.
    - V2 V1 (`ffd8f6e5f05`): `CollabSession::{attach,detach,has}_transport` + `flush_to_transport` + `poll_remote` (+ `_with_limit`). Explicit-drive.
    - V2 V2 (`51748b02944` ship + `b7aa4cb7bb9` audit-closure): `AutoFlushPolicy::{Disabled, OnAppend}` enum. Default `Disabled` (V2 V1 behavior); `OnAppend` triggers flush after every mutator.
-   - **V2 V3 step 1 ✅ SHIPPED 2026-05-21**: per-transport version-vector tracking + new `CollabSession::flush_delta_to_transport` using `LoroDoc::ExportMode::Updates`. Auto-flush reroutes through the delta path. Idempotency short-circuit closes V2 V2 audit echo-loop class. Wire payload is O(per-op delta) instead of O(full state). New `OpLog` API: `oplog_vv()` + `export_delta_bytes(&VersionVector)`.
-   - V2 V3 steps 2-6 pending: poll_remote auto-flush wiring (step 2) + offline-write queue (step 3) + WebSocket impl (step 4) + full-arc megaudit (step 5) + exit packet (step 6).
+   - V2 V3 step 1 (`603bdc9aa6c` ship + `e5ff11d549a` audit-closure): per-transport version-vector tracking + `CollabSession::flush_delta_to_transport` using `LoroDoc::ExportMode::Updates`. Auto-flush reroutes through the delta path. Idempotency short-circuit closes V2 V2 audit echo-loop class. New `OpLog` API: `oplog_vv()` + `export_delta_bytes(&VersionVector)`.
+   - **V2 V3 step 2 ✅ SHIPPED 2026-05-21**: wires `poll_remote*` into auto-flush. One flush per drain batch (not per-blob). V2 V3 step 1's idempotency guard prevents echo loops — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)`. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion. 3-peer hub fanout now works automatically under `OnAppend`.
+   - V2 V3 steps 3-6 pending: offline-write queue (step 3) + WebSocket impl (step 4) + full-arc megaudit (step 5) + exit packet (step 6).
 
 6. **5.6 Presence And Awareness** ✅ V1 + V2 SHIPPED 2026-05-19.
    - V1 (`c677e244704`): `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods.
    - V2 (`d4b3cdb2dc2`): `sweep_presence` caller-opt-in clean-slate.
 
 7. **5.7 Collaboration IDE Vertical Slice** — future. Depends on D-1 + 5.3 + 5.5 V2 V2/V3.
 
 8. **5.8 Phase 5 Megaudit** — future. Depends on 5.1-5.7 complete.
 
 **Audit Checkpoints**
 
 - Design audit after 5.1 before implementation.
 - Megaudit after 5.7.
 
 **IDE Proof Points**
 
 - This phase requires a two-peer IDE collaboration slice.
 
 **Exit Criteria**
 
 - `ql-collab` is real.
 - Cells, formulas, names, sheets, and tables merge deterministically.
 - Offline sync and conflict diagnostics work.
 - Single-writer op log is no longer confused with collaboration.
 
 **Documentation Deliverables**
 
 - `docs/phase5/entry-plan.md` ✅ (status: SUPERSEDED-BY-EXIT-PACKET).
 - `docs/phase5/v1-exit-packet.md` ✅ (Phase 5 V1 canonical closeout 2026-05-19).
 - `docs/phase5/d-1-starting-checklist.md` ✅ (D-1 fresh-session entry).
 - `docs/architecture/crdt-data-model.md` ✅ (locked design with D-1..D-4 status markers).
 - 23 audit transcripts at `docs/audits/2026-05-19-*` covering 11 audit cycles.
 - Protocol/versioning notes — pending D-1 + 5.5 V2 V2/V3 work.
 
 ## Phase 6 - Product Surfaces
 
 **Purpose:** Expose the same engine through service mode, WASM, Node, C, Python, SQL, connectors, Python UDFs, and AI().
 
 **Entry State Required**
 
diff --git a/quantbook-engine/docs/architecture/ide-consumer-contract.md b/quantbook-engine/docs/architecture/ide-consumer-contract.md
index dbd59b9f605..8cbadbed2f3 100644
--- a/quantbook-engine/docs/architecture/ide-consumer-contract.md
+++ b/quantbook-engine/docs/architecture/ide-consumer-contract.md
@@ -169,59 +169,59 @@ if !result.is_complete() {
 ```
 
 Hit/miss counters in the bind-plan cache visible via `rt.cache_stats()` — IDE can surface these in a status bar / debug pane (Engine Phase 6.2 wires them into the ql-profile JSON for the IDE to render).
 
 ### 2.10 Save
 
 ```rust
 ql_io::save_workbook_with_oplog(&wb, &oplog, "name", path)?;
 ```
 
 Atomic save (`.qbook/` + `oplog.bin` ride the same temp-then-rename protocol). The op log persists in full — any future session reloading this `.qbook` sees the same history.
 
 ## 3. What the IDE does NOT do
 
 - **The IDE does NOT call `Workbook::set_name`, `Workbook::add_sheet`, `Workbook::put_at`, or `Workbook::clear_formula` directly.** Those are LOW-LEVEL methods (doc-marked Phase 2B.5) used by the qbook loader, the op-log replay path, runtime-internal recompute pass 2, and tests. Direct calls bypass the op log silently — a correctness hole for product code.
 - **The IDE does NOT manage the op log directly.** No `oplog.append(...)` calls. The runtime emits ops; the IDE just hands the runtime an `&mut OpLog` and the runtime handles the rest.
 - **The IDE does NOT evaluate formulas itself.** All evaluation goes through the runtime. The IDE consumes results, never produces them.
 - **The IDE does NOT cache parsed/bound plans.** That's the runtime's `PlanCache`. The IDE consumes hit/miss stats for observability but never inserts directly.
 
 ## 4. Engine surfaces NOT yet shipped (filed in `docs/known-gaps.md`)
 
 The IDE will need these eventually; they're not blocking the Phase 2B.6 vertical slice:
 
 - ~~**On-keystroke validation.**~~ ✅ SHIPPED in Phase 2B.7: `WorkbookRuntime::validate_formula(sheet, row, col, text) -> Result<Value, RuntimeError>` exists. Closes GAP-I-04.
 - ~~**Undo / redo.**~~ ✅ SHIPPED in Phase 5.4 V1/V2 V1/V2 V1.1 (2026-05-19). See `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)" — `CollabSession::{undo,redo,can_undo,can_redo,undo_count,redo_count,clear_undo_stack,start_undo_group,end_undo_group,start_undo_group_scoped,set_undo_merge_interval}`.
 - **Incremental dependency-aware recompute.** `recompute_all` re-walks every formula. The IDE wants "this cell changed → recompute its dependents only." GAP-R-01 (Engine Phase 3 — calcgraph integration).
 - **Cross-sheet diagnostics on rename.** ✅ Phase 5.2 D-3 shipped the `BindError::UnknownSheet → #NAME?` mapping. ✅ **Phase 5.3 SHIPPED 2026-05-20** — causality-aware rename-repair pass via `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` wrapper. See § 4.1 below for the IDE-facing API.
 - **Long-running cancellation.** No `Cancel-token` on long operations. Engine Phase 6.1 work.
 
 ### 4.1 Phase 5 collaboration surface (preview — for Phase 5.7 IDE vertical slice)
 
 Phase 5 V1 (2026-05-19) added the engine-side multi-user CRDT collaboration substrate as the `ql-collab` crate. Full API inventory at `docs/phase5/v1-exit-packet.md` § "Final API surface (ql-collab)". IDE callers will use:
 
 - **`ql_collab::CollabSession`** — per-peer session holder. Wraps an `OpLog` + `loro::UndoManager` + optional `Box<dyn Transport>`.
 - **`CollabSession::new(peer_id) -> Result<Self, _>`** + **`from_snapshot(peer_id, bytes)`** — construction.
 - **Op log:** `append_op` / `merge_bytes` / `export_bytes`.
 - **Undo:** `undo` / `redo` / `start_undo_group_scoped` (returns RAII `UndoGroupGuard` — recommended for paste/fill-down/table-import).
 - **Transport:** `attach_transport<T: Transport + Send + 'static>` / `flush_to_transport` / `poll_remote` / `poll_remote_with_limit`. V1 ships `NoopTransport` + `LoopbackTransport::pair()` (in-process 2-peer); Phase 5.5 V2 V3 will add WebSocket.
 - **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
 - **Delta flush (✅ Phase 5.5 V2 V3 step 1 SHIPPED 2026-05-21):** `CollabSession::flush_delta_to_transport()` sends only the delta of ops added since the last successful flush, using `LoroDoc::ExportMode::Updates`. Wire payload is O(per-op delta) instead of O(full state). Idempotency short-circuit: a flush after no state change returns `Ok(false)` without invoking `transport.send` — closes the V2 V2 audit echo-loop class. **Auto-flush now routes through this delta path by default** (V2 V3 step 1 reroute of `maybe_auto_flush`). Loro's `import` transparently accepts both snapshot and update bytes, so peers don't need any changes. First flush after `attach_transport` sends from the empty VV (= all ops the session has ever appended) — the new transport-peer reconstructs the full history. Use `flush_to_transport` (snapshot) for explicit-handshake / reseed flows; `flush_delta_to_transport` for steady-state syncing.
-- **Receive-side exclusion**: `poll_remote` / `poll_remote_with_limit` do NOT auto-flush by design (audit-locked Phase 5.5 V2 V2 Codex M1 + Opus M1, 2026-05-21). V2 V3 step 1 keeps this exclusion intact; step 2 will wire `poll_remote` into auto-flush safely thanks to the V2 V3 idempotency guard. Until step 2 ships, callers fanning a polled batch onward must invoke explicit `flush_delta_to_transport` (or `flush_to_transport`) after the drain. **Fanout caveat (3+ peers)**: in a hub topology (A↔hub↔B) where each peer's writes should reach the other, the HUB must enable `OnAppend` AND call `flush_delta_to_transport` after each `poll_remote` batch. Symmetric `OnAppend` on both endpoints of a paired transport is safe under V2 V3 step 1 idempotency guard (each side short-circuits when its own state didn't advance).
+- **Receive-side auto-flush (✅ Phase 5.5 V2 V3 step 2 SHIPPED 2026-05-21)**: `poll_remote` / `poll_remote_with_limit` now auto-flush after the drain batch (one flush per call, not per-blob — bandwidth-efficient) when `OnAppend` is set AND at least one blob was drained. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion now that V2 V3 step 1's idempotency guard prevents echo loops at the source. **3-peer fanout (A↔hub↔B)**: the HUB with `OnAppend` now automatically propagates peer A's writes onward to peer B without an explicit flush after the drain. **Symmetric-OnAppend**: safe — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)` (no wire send). **V1 limit**: auto-flush from `poll_remote` goes back to the SAME transport the bytes came from. In a true multi-transport hub topology (one session, multiple attached transports), only one transport receives the fanout. V2 V3 step 4 (WebSocket + multi-transport routing) may add per-transport fanout. **Partial-state contract on flush Err**: if the post-batch auto-flush fails (closed transport, I/O error), the method returns `Err(CollabSessionError::Transport(_))` AFTER all `merged` blobs have been committed to the local log. Inspect `op_count()` to determine how many merged.
 - **Presence:** `update_presence(state)` / `peer_presence(peer)` / `clear_presence` / `peers_with_presence` / `sweep_presence` (V2 — caller-opt-in clean-slate on rejoin).
 - **Post-merge rename-repair (✅ Phase 5.3 SHIPPED 2026-05-20):** after `merge_bytes`, before recompute, call `CollabSession::rebuild_workbook(&FunctionRegistry) -> Result<(Workbook, SyncReport), CollabSessionError>` to atomically chain `replay_into → repair_sheet_rename_chain → repair_table_rename_chain → repair_column_rename_chain`. Returns a FRESH workbook (caller doesn't pass a workbook by mut-ref — eliminates double-call / stale-workbook misuse class per step 5b audit closure). The `SyncReport` has a one-line `Display` impl for `log::info!` consumption: `"sync: ops=N sheet_rewrites=N(skip=N) table_rewrites=N(skip=N) column_rewrites=N(skip=N)"`. Caller-driven by design (audit-locked D-5.3-1: repair is NOT auto-invoked by `merge_bytes` so callers can batch multiple merges before paying replay+repair cost). **Without this call**, concurrent-rename formulas surface as `#NAME?` at recompute. Raw `replay_into` + per-pass repair calls remain available for diagnostic / partial-replay flows; see `crates/ql-collab/src/repair.rs` module docs § "Caller contract" for the manual sequence. Repair report types: `SheetRepairReport` + `TableRepairReport` + `ColumnRepairReport` (post-Tier-H8 rename for API symmetry; pre-H8 was `RepairReport` for sheets) — each with `formulas_rewritten: usize` + per-rename summaries + `ambiguous_rules_skipped` diagnostic surfaces. See `docs/phase5/5-3-exit-packet.md` for the full closure record.
 
 **D-1 (✅ SHIPPED 2026-05-20 — all 8 steps + 7 per-step audits + 1 megaudit):** `FormatId` is now `enum { Builtin(u32), Custom(PeerId, u32) }` in `ql-storage::format`. IDE callers MUST pattern-match the variant rather than reading `.0`. Use `FormatId::is_builtin()` / `is_custom()` / `GENERAL` accessors. For pre-D-1 bare-u32 ids (xlsx import), use `FormatId::legacy_from_u32(n)`. `Op::RegisterFormat` + `Op::SetCellFormat` carry `FormatIdWire` on the wire. `.qbook` envelope v8 carries the tagged-tuple `FormatEntryId` shape losslessly for multi-peer ids; v<8 envelopes auto-migrate. xlsx export flattens multi-peer FormatIds via dedup-by-code; non-LEGACY peer flattens reported via `XlsxExportReport.dropped_features`. xlsx import surfaces unresolved-overlay-numfmt as `report.unsupported` entries. `.qbook/oplog.bin` files wrapped in Tier D3 header (`OPLOG_MAGIC = b"QLOL"` + BE u32 `OPLOG_SCHEMA_VERSION`). `CollabSession::new` + `from_snapshot` + `OpLog::set_peer_id` assert `PeerId != 0` (release-firing). See `docs/phase5/d-1-exit-packet.md` for the full closure record.
 
 ## 5. Acceptance pattern (`crates/ql-exec/tests/ide_simulation.rs`)
 
 The simulation test exercises this contract end-to-end without an actual IDE. Each `#[test]` corresponds to one of IDE-2B-01..05:
 
 | Test | Acceptance | What it proves |
 |---|---|---|
 | `ide_01_formula_edit_returns_value` | IDE-2B-01 | `set_formula` returns the evaluated Value; IDE can render it |
 | `ide_02_bind_errors_carry_user_facing_display` | IDE-2B-02 | Errors round-trip with non-empty Display strings; no fallback values |
 | `ide_03_cancel_pattern_no_state_change` | IDE-2B-03 | The borrow-check-enforced "no call = no mutation" pattern works |
 | `ide_04_paste_block_via_transaction` | IDE-2B-04 | Transaction commit emits exactly one BatchCommit; partial drop = no state |
 | `ide_05_save_reload_preserves_state_and_oplog` | IDE-2B-05 | Round-trip preserves workbook + oplog length + visible cell values |
 
 The test file is the spec for what the actual TypeScript binding (Engine Phase 6.3) will call.
diff --git a/quantbook-engine/docs/phase5/entry-plan.md b/quantbook-engine/docs/phase5/entry-plan.md
index 7355fca9582..51b28a7ffb1 100644
--- a/quantbook-engine/docs/phase5/entry-plan.md
+++ b/quantbook-engine/docs/phase5/entry-plan.md
@@ -78,81 +78,81 @@ sub-items begin:
 Total: ~4-6 hours mechanical work. Schedule as one closure cycle.
 
 ### Tier D — Phase 5 prep architectural
 
 - **D2.** `ql-oplog → ql-io` reverse dependency cleanup. Phase 5
   CRDT integration wants `ql-oplog` to be the dependency floor.
 - **D3.** `oplog.bin` magic bytes + version header. Bundle into
   Phase 5.1 / 5.2 design.
 
 D1 (WorkbookRuntime monolith split) is HIGH-impact but multi-day
 refactor. Recommendation: SCHEDULE A SEPARATE CYCLE for D1 between
 A* and 5.1. Phase 5 will add CRDT-aware mutation paths on top of
 WorkbookRuntime; doing the split FIRST avoids re-doing the work
 post-merge.
 
 ### Tier B — parser/binder gaps (defer or close opportunistically)
 
 - **B1.** Literal-range bind (5.4 % corpus break) — affects Phase
   6 IDE acceptance but doesn't block Phase 5 data-model decisions.
   Can defer.
 - **B2.** Omitted-arg syntax — same: Phase 6 IDE acceptance.
 - **B3.** Parser recursion depth — security hardening, can ship in
   parallel with Phase 5.
 
 ### Tier C — recompute / op-log correctness
 
 - **C1.** Cycle detection in `recompute_all`. Critical for `.qbook`
   load path. Affects Phase 5 because replay uses
   `recompute_all` per `ql-oplog::replay::replay_into`.
   **Recommendation: close C1 before 5.2.**
 - **C2.** BatchCommit depth guard. Pair with C1.
 
 ## Phase 5 sub-items (per master plan)
 
 | ID | Item | Effort | Notes |
 |---|---|---|---|
 | 5.1 | Collaboration Data Model Decision | 3-5 days | **✅ AUDIT-CLOSED 2026-05-19** (`918d7efdd91` + `df52cb44ad2`). Loro container shape locked = Option A op-log preservation; 4 audit decisions D-1..D-4 recorded in design doc. |
 | 5.2 | `ql-collab` Core Documents | 1-2 weeks | **🟡 IN PROGRESS** — 5.2.a scaffold; D-2/D-3/D-4; 5.2.b; **D-1 ✅ SHIPPED 2026-05-20** (all 8 steps + 7 per-step audits + 1 megaudit; see `docs/phase5/d-1-exit-packet.md`). |
 | 5.3 | Conflict Resolution Semantics | ✅ SHIPPED 2026-05-20 (4 days actual) | Causality-aware rename-repair pass for sheets + tables + columns. `ql_collab::repair_{sheet,table,column}_rename_chain` + `CollabSession::rebuild_workbook` wrapper. See `docs/phase5/5-3-exit-packet.md`. |
 | 5.4 | Undo/Redo + Operation Grouping | 1 week | **🟢 V1 + V2 V1 + V2 V1.1 SHIPPED 2026-05-19** — V1 `89c02b9d83e`: 7 undo/redo methods, presence-origin excluded. V2 V1 `6138a7203f6` + `e199a5fda5a`: grouping + merge-interval. V2 V1.1: `start_undo_group_scoped` returns `UndoGroupGuard` (RAII, panic/Err-safe). V2 V2 follow-up: push/pop listeners. |
-| 5.5 | Transport Layer + Offline Sync | 1-2 weeks | **🟡 V1 + V2 V1 + V2 V2 + V2 V3 step 1 SHIPPED** — V1 `924750819bc`: `Transport` trait + `NoopTransport` + `LoopbackTransport`. V2 V1 `ffd8f6e5f05`: explicit-drive `attach/detach/has_transport` + `flush_to_transport` + `poll_remote`. V2 V2 ✅ 2026-05-21 (`51748b02944` + `b7aa4cb7bb9`): `AutoFlushPolicy::{Disabled, OnAppend}`. **V2 V3 step 1 ✅ 2026-05-21**: `CollabSession::flush_delta_to_transport` + `last_flushed_vv` + new `OpLog::{oplog_vv, export_delta_bytes}` helpers. Auto-flush reroutes through delta path; idempotency short-circuit closes echo-loop class. V2 V3 steps 2-6 pending: poll_remote auto-flush + offline-write queue + WebSocket impl + megaudit + exit packet. |
+| 5.5 | Transport Layer + Offline Sync | 1-2 weeks | **🟡 V1 + V2 V1 + V2 V2 + V2 V3 steps 1-2 SHIPPED** — V1 `924750819bc`: `Transport` trait + `NoopTransport` + `LoopbackTransport`. V2 V1 `ffd8f6e5f05`: explicit-drive `attach/detach/has_transport` + `flush_to_transport` + `poll_remote`. V2 V2 ✅ 2026-05-21 (`51748b02944` + `b7aa4cb7bb9`): `AutoFlushPolicy::{Disabled, OnAppend}`. V2 V3 step 1 ✅ 2026-05-21 (`603bdc9aa6c` + `e5ff11d549a`): `CollabSession::flush_delta_to_transport` + `last_flushed_vv` + `OpLog::{oplog_vv, export_delta_bytes}` helpers. Auto-flush reroutes through delta path; idempotency short-circuit closes echo-loop class. **V2 V3 step 2 ✅ 2026-05-21**: wires `poll_remote*` into auto-flush (one flush per drain batch). 3-peer hub fanout now works automatically under `OnAppend`. V2 V3 steps 3-6 pending: offline-write queue + WebSocket impl + megaudit + exit packet. |
 | 5.6 | Presence + Awareness | 3-5 days | **🟢 V1 + V2 SHIPPED** — V1 `c677e244704`: `"presence"` LoroMap + `PresenceState` + 4 CollabSession methods + 11 tests. V2 `d4b3cdb2dc2`: `sweep_presence` (caller-opt-in clean-slate; closes V1 persistence known-limitation). Remaining V2 V2: presence-changed callbacks (lower priority). |
 | 5.7 | IDE Vertical Slice | 1 week | Two-window editing. |
 | 5.8 | Phase 5 Megaudit | 4-6 days | Randomized peer-merge tests + transport failure modes. |
 
 Total Phase 5 effort estimate: **~7-12 weeks**.
 
 ## Risks at entry
 
 > **2026-05-19 update:** risks 1, 3, 4, 5 are CLOSED. Only risk 2
 > (oplog.bin schema versioning) remains open — bundle into D-1 schema
 > work.
 
 1. ~~**Loro container shape uncertain**~~ — ✅ CLOSED. 5.1 design
    audit-closed at `918d7efdd91` + `df52cb44ad2`. Option A
    (op-log preservation on top of Loro `LoroList`) locked.
 2. **`oplog.bin` schema versioning is non-existent** — Phase 5
    needs magic bytes + version header (Tier D3). Bundle into D-1
    tagged-tuple FormatId schema work (next session).
 3. ~~**`WorkbookRuntime` monolith**~~ — ✅ CLOSED. Tier D1 split
    shipped this session: 12,725-LOC `workbook_runtime.rs` → 9
    sibling submodules + 247-LOC `mod.rs`. Public API surface
    byte-for-byte identical; 4160 tests passing.
 4. ~~**Cycle-detection gap in `recompute_all`**~~ — ✅ CLOSED.
    Tier C1 shipped at `3451d90a03f` + audit closures
    `8137697b5fc`. Replay paths now inherit cycle detection via
    ephemeral `CalcgraphSession`.
 5. ~~**API stability**~~ — ✅ CLOSED. Tier A
    `#[non_exhaustive]` pass + deprecated removals + per-crate
    stability docs shipped at `40bb584a25b`. Phase 5 additions
    to `Op`, error types, etc. won't break 0.2.0 consumers.
 6. ~~**`ql-collab` scaffold limitation (Phase 5.2.a)**~~ — ✅ CLOSED
    2026-05-19 at Phase 5.2.b. `OpLog::set_peer_id` added; called
    from `CollabSession::new` + `from_snapshot`. PeerId now wired
    through to Loro's merge metadata. Caller pitfall (concurrent
    sessions MUST use distinct peer ids) documented in
    `crates/ql-collab/src/peer.rs` + `crates/ql-oplog/src/log.rs`.
 
 ## Audit checkpoints
 
 Per master plan Phase 5:
diff --git a/quantbook-engine/docs/phase5/v1-exit-packet.md b/quantbook-engine/docs/phase5/v1-exit-packet.md
index e2e3f41b2b7..e9d8577e2ab 100644
--- a/quantbook-engine/docs/phase5/v1-exit-packet.md
+++ b/quantbook-engine/docs/phase5/v1-exit-packet.md
@@ -1,67 +1,68 @@
 ---
 title: Phase 5 V1 exit packet (5.1 → 5.6 V1+V2 + 5.4 V2 V1+V1.1 + 5.5 V2 V1 + D1.a)
-status: ACTIVE — Phase 5 V1 surface complete 2026-05-19. **D-1 SHIPPED 2026-05-20**. **5.3 SHIPPED 2026-05-20**. **5.5 V2 V2 (auto-flush) SHIPPED 2026-05-21**. **5.5 V2 V3 step 1 (version-vector delta flush) SHIPPED 2026-05-21**. See `docs/phase5/d-1-exit-packet.md` + `docs/phase5/5-3-exit-packet.md`. 5.5 V2 V3 steps 2-6 (poll_remote auto-flush + offline-write queue + WebSocket impl + megaudit + exit packet), 5.7 IDE slice, and 5.8 megaudit remain.
+status: ACTIVE — Phase 5 V1 surface complete 2026-05-19. **D-1 SHIPPED 2026-05-20**. **5.3 SHIPPED 2026-05-20**. **5.5 V2 V2 (auto-flush) SHIPPED 2026-05-21**. **5.5 V2 V3 step 1 (version-vector delta flush) SHIPPED 2026-05-21**. **5.5 V2 V3 step 2 (poll_remote auto-flush) SHIPPED 2026-05-21**. See `docs/phase5/d-1-exit-packet.md` + `docs/phase5/5-3-exit-packet.md`. 5.5 V2 V3 steps 3-6 (offline-write queue + WebSocket impl + megaudit + exit packet), 5.7 IDE slice, and 5.8 megaudit remain.
 date: 2026-05-19
 updated: 2026-05-20 (post-exit-packet additions: 5.6 V2 sweep_presence + D1.a 4-cluster closure + D-1 ALL STEPS SHIPPED)
 predecessor: docs/phase4/exit-packet.md + docs/phase5/entry-plan.md
 successor: docs/phase5/d-1-starting-checklist.md (fresh-session entry for the multi-day D-1 arc)
 supersedes_pointer: docs/phase5/entry-plan.md (entry-plan stays as historical scope reference; this packet is the closeout)
 ---
 
 # Phase 5 V1 exit packet — multi-user CRDT collaboration substrate
 
 This packet closes the Phase 5 **V1 surface** of the Quantbook
 engine. V1 shipped the engine-side collaboration data model end-to-
 end: CRDT data model decision (5.1), op-log semantic decisions
 (5.2 D-2/D-3/D-4 + 5.2.a scaffold + 5.2.b set_peer_id), peer-local
 undo (5.4 V1 + V2 V1 + V2 V1.1), in-process transport (5.5 V1 +
 V2 V1), and ephemeral presence (5.6 V1).
 
 Phase 5.2 D-1 (FormatId tagged tuple) ✅ SHIPPED 2026-05-20 — see
 `docs/phase5/d-1-exit-packet.md`. Phase 5.3 conflict resolution
 ✅ SHIPPED 2026-05-20 — see `docs/phase5/5-3-exit-packet.md`.
 Phase 5.5 V2 V2 (auto-flush) ✅ SHIPPED 2026-05-21. Phase 5.5 V2 V3
 step 1 (version-vector delta flush) ✅ SHIPPED 2026-05-21. Phase 5.5
-V2 V3 steps 2-6 (poll_remote auto-flush + offline-write queue +
-WebSocket transport + reconnect/offline sync) + Phase 5.7 IDE vertical
-slice remain ahead of the 5.8 megaudit.
+V2 V3 step 2 (poll_remote auto-flush) ✅ SHIPPED 2026-05-21. Phase 5.5
+V2 V3 steps 3-6 (offline-write queue + WebSocket transport + megaudit
++ exit packet) + Phase 5.7 IDE vertical slice remain ahead of the
+5.8 megaudit.
 
 ## Acceptance criteria status (Phase 5 V1)
 
 | ID | Criterion | Status | Evidence |
 |---|---|---|---|
 | A5V1-01 | All workspace gates green | ✅ | 4222 workspace tests passing; fmt + clippy clean workspace-wide |
 | A5V1-02 | CRDT data model audit-closed | ✅ | `docs/architecture/crdt-data-model.md` + `docs/audits/2026-05-19-phase-5-1-{codex,opus,consolidated}.md` |
 | A5V1-03 | `ql-collab` substantively populated | ✅ | 5 modules (peer / session / transport / presence / undo) + ~30 public methods + 67 unit tests + 1 integration test |
 | A5V1-04 | Op-log + Loro merge semantics verified for multi-peer | ✅ | `crates/ql-exec/tests/phase_5_2_d4_spill_2peer_probe.rs` (4 tests) + 8 paired LoopbackTransport tests + 2-peer round-trip via attached transport |
 | A5V1-05 | Audit discipline preserved | ✅ | 2-way Codex + Opus audit dispatched after every substantive cycle; 7 of 10 cycles caught HIGH/MEDIUM findings convergently |
 
 All five acceptance criteria empirically met.
 
 ## Sub-phase shipped tally
 
 | Sub-phase | Theme | Status | Commit(s) |
 |---|---|---|---|
 | 5.1 | CRDT data model decision | ✅ AUDIT-CLOSED | `918d7efdd91` (design) + `df52cb44ad2` (4 decisions D-1..D-4 locked) |
 | Tier D2 | `ql-oplog → ql-io` dependency inversion | ✅ SHIPPED | `e15e8908742` |
 | 5.2 D-2 | AddSheet auto-rename on duplicate | ✅ SHIPPED | `1ca19e2fa37` |
 | 5.2 D-3 | BindError::UnknownSheet → ErrorValue::Name | ✅ SHIPPED | `e71312d4bcd` |
 | 5.2 D-4 | OpLog::merge_bytes + 2-peer spill probe | ✅ SHIPPED | `2f217a2067a` |
 | 5.2.a | `ql-collab` scaffold (PeerId + CollabSession + Transport) | ✅ SHIPPED | `66a571b30af` |
 | 5.2.b | PeerId → LoroDoc::set_peer_id wiring | ✅ SHIPPED | `ef056f50bee` + `524b5a8c231` (audit closures) |
 | 5.6 V1 | Presence map (per-peer cursor + selection) | ✅ SHIPPED | `c677e244704` + `43f20abc887` (audit closures) |
 | 5.4 V1 | Peer-local undo/redo via Loro UndoManager | ✅ SHIPPED | `89c02b9d83e` + `e2ba052a626` (audit closures) |
 | 5.5 V1 | LoopbackTransport for 2-peer round-trip tests | ✅ SHIPPED | `3590aa6d89e` + `924750819bc` (truncation fix) + `bfa8401e1b5` (audit closures) |
 | 5.5 V2 V1 | CollabSession transport wrappers (attach/detach/flush/poll) | ✅ SHIPPED | `ffd8f6e5f05` + `ad9b18fe133` (audit closures) |
 | 5.4 V2 V1 | Undo grouping + merge-interval | ✅ SHIPPED | `6138a7203f6` + `e199a5fda5a` (truncation fix + audit closures) |
 | 5.4 V2 V1.1 | RAII UndoGroupGuard (panic/Err-safe grouping) | ✅ SHIPPED | `7cbdc689ea9` + `d49e873f237` (Codex audit PASS) |
 | **Phase 5 V1 exit packet** (this doc) | ✅ shipped | `b8b2e04e0d7` |
 | 5.6 V2 (sweep_presence — closes V1 persistence known-limitation) | ✅ shipped | `d4b3cdb2dc2` |
 | D1.a cluster 1 (add_sheet_rejects test → sheets.rs) | ✅ shipped | `06252f2b638` |
 | D1.a cluster 2 (clear_formula_rejects_* → cells.rs) | ✅ shipped | `9b45ee656eb` + `4528dc62c3b` (backlog status) |
 | D1.a clusters 3+4 (set_formula canonicalization + drop_table) — **D1.a COMPLETE** | ✅ shipped | `93210e43567` |
 
 **23 commits to exit-packet ship + 7 post-exit-packet commits = 30 commits total** in the Phase 5 V1 arc.
 
 Post-exit-packet adds (2026-05-19 session-end additions):
 - Phase 5.6 V2 sweep_presence (+3 tests; closes V1 persistence known-limitation).
@@ -214,94 +215,104 @@ session.
 
 Phase 5 V1 added **91 net tests** to the engine.
 
 ## What's deferred (forward work for next session(s))
 
 ### Major (multi-day)
 
 - **Phase 5.2 D-1 — FormatId tagged tuple.** ✅ **SHIPPED 2026-05-20.**
   All 8 steps + 7 per-step audits + 1 full-arc 3-way megaudit
   complete. See `docs/phase5/d-1-exit-packet.md` for the closure
   record (final HEAD `6e32c269c22`; workspace tests 4222 → 4291;
   16/16 audit cycles caught real bugs). Touched `ql-types::peer`,
   `ql-storage::format`, `ql-oplog::wire` + `op` + `replay`,
   `ql-io::qbook_format` (v7→v8) + `oplog_persistence` (Tier D3
   header), `ql-io-xlsx::write::umya_export` (XlsxNumFmtTranslation).
 
 - **Phase 5.3 — Conflict resolution semantics.** ✅ **SHIPPED
   2026-05-20** (4 days actual vs 4-7 day estimate; HEAD
   `24e9a775c98` post-step-6 exit packet). 6 steps + 14 audit cycles
   (14/14 caught real bugs). Causality-aware rename-repair pass at
   merge time for sheets + tables + columns:
   `ql_collab::repair_{sheet,table,column}_rename_chain` +
   `CollabSession::rebuild_workbook` production-wiring wrapper. The
   D-3 `#NAME?` simple-case from Phase 5.2 still ships as the
   raw-replay-without-repair fallback; production callers route
   through `rebuild_workbook` which atomically replays + repairs.
   See `docs/phase5/5-3-exit-packet.md` + 20 audit transcripts at
   `docs/audits/2026-05-20-phase-5-3-*.md`. 13 V1 limitations tracked
   at `docs/PHASE-4-V2-BACKLOG.md` Tier H.
 
 - **Phase 5.5 V2 V2 — auto-flush on append.** ✅ **SHIPPED
   2026-05-21**. `AutoFlushPolicy::{Disabled, OnAppend}` enum on
   `CollabSession` (default `Disabled` preserves V2 V1 behavior).
   `OnAppend` triggers flush after every mutator (delta path in
   V2 V3 step 1); partial-state contract documented for transport-
   failure case. 19 integration tests (14 ship + 5 audit-closure)
   at `crates/ql-collab/tests/auto_flush.rs`. No new external deps;
   no breaking changes to V2 V1 API.
 
 - **Phase 5.5 V2 V3 step 1 — version-vector delta flush.** ✅
-  **SHIPPED 2026-05-21**. New `CollabSession::flush_delta_to_transport`
+  **SHIPPED 2026-05-21** (`603bdc9aa6c` + `e5ff11d549a`
+  audit-closure). New `CollabSession::flush_delta_to_transport`
   + `last_flushed_vv: Option<VersionVector>` field. Auto-flush
   reroutes through delta path. Idempotency short-circuit closes
   V2 V2 audit echo-loop class. New `OpLog` helpers: `oplog_vv()`
-  + `export_delta_bytes(&VersionVector)`. 9 new integration tests
-  (total 28 at `crates/ql-collab/tests/auto_flush.rs`). No new
-  external deps.
-
-- **Phase 5.5 V2 V3 steps 2-6 — Production transport.** Step 2:
-  wire `poll_remote` into auto-flush (now safe with V2 V3 step 1
-  idempotency guard). Step 3: offline-write queue. Step 4:
-  WebSocket transport impl (+ reconnect / offline sync). Step 5:
-  full-arc megaudit. Step 6: V2 V3 exit packet. 3-6 days
-  estimated.
+  + `export_delta_bytes(&VersionVector)`. 12 new integration tests
+  (9 ship + 3 audit-closure). No new external deps.
+
+- **Phase 5.5 V2 V3 step 2 — poll_remote auto-flush.** ✅
+  **SHIPPED 2026-05-21**. Wires `poll_remote*` into auto-flush
+  (one flush per drain batch, not per-blob — bandwidth-efficient).
+  V2 V3 step 1's idempotency guard prevents echo loops; reverses
+  the V2 V2 audit-locked "receive-side excluded" exclusion. 3-peer
+  hub fanout now works automatically under `OnAppend`. 3 new
+  integration tests + 1 inverted test (replacing the V2 V2
+  exclusion-asserting test that documented the now-defunct contract).
+  Partial-state contract on flush Err: documented.
+
+- **Phase 5.5 V2 V3 steps 3-6 — Production transport.** Step 3:
+  offline-write queue (queue ops when transport detached; flush
+  on reconnect). Step 4: WebSocket transport impl (+ reconnect /
+  offline sync / multi-transport routing). Step 5: full-arc
+  megaudit (3-way Codex+Opus-A+Opus-B per Phase 5.3 step 5
+  precedent). Step 6: V2 V3 exit packet. 2.5-5 days estimated.
 
 - **Phase 5.7 — IDE vertical slice.** Two-window editing demo.
   1 week. Depends on D-1 + 5.3 + 5.5 V2 V2 (✅) + V2 V3.
 
 - **Phase 5.8 — Megaudit.** Randomized peer-merge tests +
   transport failure modes. 4-6 days.
 
 ### Minor (V2 V2 polish)
 
 - **Phase 5.4 V2 V2 — UndoManager push/pop listeners** (lower
   priority; UndoManager already exposed via `pub use loro::UndoManager`;
   Loro's API surface is complex — couples to `UndoOrRedo`,
   `CounterSpan`, `DiffEvent`, `UndoItemMeta`; defer until Phase 5.7
   IDE surfaces a concrete consumer need).
 - ~~**Phase 5.6 V2 — Presence eviction sweep**~~ — ✅ SHIPPED
   `d4b3cdb2dc2` as `CollabSession::sweep_presence` (caller-opt-in).
 
 ### Infrastructure
 
 - **Tier D3 — `oplog.bin` magic bytes + version header.** Bundle
   with D-1 schema work (it's the discriminator the loader uses to
   detect old envelope schemas for migration).
 - **Tier C2 — BatchCommit depth guard.** Low priority.
 - ~~**Tier D1.a — test-cluster re-partitioning**~~ — ✅ SHIPPED
   across 4 commits (`06252f2b638`, `9b45ee656eb`, `4528dc62c3b`,
   `93210e43567`). 9 tests relocated to their semantically correct
   owning submodules. Pure mechanical, net 0 test count change.
 - **Index-padding race root-cause** in husky precommit hook —
   recurring `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` on large-file edits
   + cargo fmt × git add race. 3 incidents this session; mitigation
   (re-stage + retry) reliable but root cause is forward work.
 
 ## Cross-references
 
 - `docs/phase5/entry-plan.md` — Phase 5 entry plan (still active for scope).
 - `docs/architecture/crdt-data-model.md` — full CRDT design with all D-1..D-4 markers.
 - `docs/known-gaps.md` — GAP-C-03 / C-04 / C-05 closed at V1; remaining items.
 - `docs/MASTER-PLAN.md` §541-621 — Phase 5 sub-items + acceptance.
 - `docs/audits/2026-05-19-*.md` — 23 audit transcripts across 11 audit cycles (each cycle produced 2-3 docs: Codex + Opus + Consolidated, with 5.6 V1 missing Opus due to Anthropic 529 × 3 retries and 5.4 V2 V1.1 Codex-only per documented justification).
 

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/transport.rs | sed -n '150,205p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   150	        Ok(())
   151	    }
   152	
   153	    fn try_recv(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
   154	        if self.closed {
   155	            return Err(TransportError::Closed);
   156	        }
   157	        Ok(None)
   158	    }
   159	}
   160	
   161	/// **Phase 5.5 V1 (2026-05-19):** in-process paired `Transport`
   162	/// impl for 2-peer round-trip testing.
   163	///
   164	/// Constructed via [`LoopbackTransport::pair`]: returns two
   165	/// endpoints `(a, b)` where `a.send(bytes)` lands in `b`'s recv
   166	/// queue and vice versa. The two endpoints share two
   167	/// `Arc<Mutex<VecDeque<Vec<u8>>>>` channels via interior
   168	/// mutability — `Send + Sync` so they can also be used across
   169	/// threads if a future test wants that.
   170	///
   171	/// ## Use case
   172	///
   173	/// Wire two `CollabSession`s together for tests like:
   174	/// ```ignore
   175	/// let (mut tx_a, mut tx_b) = LoopbackTransport::pair();
   176	/// let session_a = CollabSession::new(PeerId::new(1))?;
   177	/// let session_b = CollabSession::new(PeerId::new(2))?;
   178	/// // ... append ops on a, drain via tx_a.send / tx_b.try_recv ...
   179	/// ```
   180	///
   181	/// **Phase 5.5 V2 V2 (2026-05-21):** `CollabSession` supports
   182	/// opt-in auto-flush via `AutoFlushPolicy::OnAppend` — every
   183	/// session mutator (`append_op`, `merge_bytes`, presence writes,
   184	/// `undo` / `redo` when consumed, `sweep_presence`) then sends
   185	/// through the attached transport automatically. Default policy
   186	/// remains `Disabled` (V2 V1 explicit-drive behavior). Tests can
   187	/// still drive the flow manually: append, export_bytes, send via
   188	/// the transport, recv on the other side, merge_bytes — useful
   189	/// when the test wants deterministic control over when bytes
   190	/// land on the wire (e.g. ordering tests). `poll_remote` does
   191	/// NOT auto-flush by design — see `AutoFlushPolicy::OnAppend` for
   192	/// the rationale.
   193	///
   194	/// ## Close semantics
   195	///
   196	/// Each endpoint has its OWN `closed` flag (separate
   197	/// `AtomicBool`). `a.close()` shuts down endpoint A:
   198	/// - A's `send` returns `TransportError::Closed` immediately.
   199	/// - A's `try_recv` drains any already-queued bytes FIRST and
   200	///   only returns `Closed` once the queue is empty (per the
   201	///   `Transport` trait contract at the trait docstring).
   202	/// - B is unaffected: B can still `send` (bytes land in A's
   203	///   inbox; A drains them on the next try_recv before reporting
   204	///   Closed) and `try_recv` (drains B's inbox).
   205	///

exec
/bin/zsh -lc 'rg -n "poll_remote|auto-flush|receive-side|OnAppend|flush_delta" quantbook-engine/.plans/_active.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "rg -n \"V2 V3 step 1|poll_remote.*excluded|explicit poll_remote \\+ manual|manual flush_delta|BOTH peers' state did advance|second-side flush\" quantbook-engine/crates/ql-collab/tests/auto_flush.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
411:    // "receive-side excluded by design" exclusion. With V2 V3 step 1's
738:// Phase 5.5 V2 V3 step 1 — version-vector tracking + delta flush
926:    // V2 V3 step 1 reroutes maybe_auto_flush through
1048:// V2 V3 step 1 audit closures (Codex + Opus, 2026-05-21)
1094:    // V2 V3 step 1 audit closure (Codex L2 / Opus M1, 2026-05-21):
1149:    // V2 V3 step 1 audit closure (Codex L1 / Opus L1, 2026-05-21):
1188:    // V2 V3 step 1 audit closure (Opus L3, 2026-05-21): the
1192:    // explicit poll_remote + manual flush_delta on each side (since
1193:    // poll_remote excluded from auto-flush per V2 V2 audit M1);
1213:    // poll_remote is excluded from auto-flush in V2 V3 step 1).
1221:    // second-side flush short-circuits.
1224:    // BOTH peers' state did advance (they received the other's op),

 succeeded in 0ms:
2:name: 2026-05-21_phase-5-5-v2-v3-step-2-poll-remote-auto-flush
8:this_step: Step 2 of 6 — wire poll_remote into auto-flush (now safe with V2 V3 step 1 idempotency guard)
12:# Phase 5.5 V2 V3 step 2 — wire `poll_remote*` into auto-flush
16:V2 V2 audit Codex M1 + Opus M1 flagged: `poll_remote_with_limit` deliberately excluded from auto-flush, because the V2 V2 wire path was full-snapshot — symmetric-OnAppend peers ping-pong forever (each peer flushes the unchanged snapshot back to the other peer; Loro dedupes ops but wire payload churns).
18:V2 V3 step 1 closed the root cause by adding per-session-currently-attached-transport version-vector tracking. The idempotency short-circuit in `flush_delta_to_transport` returns `Ok(false)` without invoking `transport.send` when `current_vv == last_flushed_vv`. So a poll that produces a Loro-deduped (no-op) merge no longer triggers an outbound flush.
20:V2 V3 step 2 reverses the V2 V2 exclusion: `poll_remote_with_limit` now fires `maybe_auto_flush()` AFTER its drain loop. The most natural fanout pattern (3-peer hub: drain peer B → auto-flush merged state onward to peer C) now works automatically under `OnAppend`.
27:pub fn poll_remote_with_limit(
46:    // **V2 V3 step 2 (2026-05-21):** auto-flush after the drain
48:    // Idempotency guard at flush_delta_to_transport returns
63:| `poll_remote()` drains N>0 blobs, state advances | Ok(N), no flush | Ok(N), auto-flushes once (delta path) |
64:| `poll_remote()` drains N>0 blobs, all Loro-deduped (no state change) | Ok(N), no flush | Ok(N), auto-flush idempotency short-circuits to Ok(false), no wire send |
65:| `poll_remote()` drains 0 blobs (empty queue) | Ok(0), no flush | Ok(0), no flush (defensive skip via `merged > 0`) |
66:| `poll_remote()` with no transport | Ok(0), no flush | Ok(0), no flush (early return at top) |
67:| `poll_remote()` with policy Disabled | Ok(N), no flush | Ok(N), maybe_auto_flush no-ops (Disabled branch) |
68:| `poll_remote()` merges drain ok then flush fails | n/a | Err(Transport(_)); local log has merged ops; partial state |
79:Document on `poll_remote_with_limit` docstring.
83:1. **Invert** existing `poll_remote_does_not_trigger_auto_flush_by_design` → rename to `poll_remote_triggers_auto_flush_under_on_append`. Assert the OPPOSITE: when OnAppend + transport attached, poll → drain → auto-flush fires on the SAME transport. (Note: for echo-loop avoidance, the auto-flush goes back to the SAME transport endpoint that just delivered the bytes. Loro on the other side dedupes; the round-trip is harmless. Step 4 WebSocket impl may add per-transport routing optimizations later.)
85:2. **NEW** `poll_remote_auto_fanout_to_third_peer_under_on_append` — 3-peer hub topology. Hub has TWO transports: T1 (to peer B) AND T2 (to peer C). Wait — `CollabSession` only supports ONE attached transport. So the actual 3-peer hub uses some other plumbing (e.g., process-level fanout). For V2 V3 step 2 the unit-testable contract is just: "poll_remote → auto-flush fires on the attached transport". Reframe test as: peer A with OnAppend; peer B sends bytes to A's inbox via tx_b.send; A's poll_remote drains AND auto-flushes back via the same paired transport. Verify tx_b receives the merged-state delta (B's inbox grows). This tests the loop-back path with the idempotency guard.
87:3. **NEW** `poll_remote_idempotent_merge_short_circuits_no_wire_send` — peer A first flushes its state (last_flushed_vv = current). Peer B sends a snapshot that contains ONLY ops already in A's log (Loro dedupe). A's poll_remote drains B's blob; merge happens but VV doesn't advance. Auto-flush short-circuits. Verify tx_b.pending_recv() stays at the pre-poll count.
89:4. **NEW** `poll_remote_empty_drain_does_not_attempt_flush` — empty transport inbox; `poll_remote` returns Ok(0); no transport.send. Use NoopTransport (records sends) — assert `sent.len() == 0`.
91:5. **NEW** `poll_remote_with_closed_transport_returns_zero_no_flush` — transport closed; `poll_remote_with_limit` returns Ok(0) (Closed handled gracefully by the existing match arm); since merged == 0, no flush attempted. Important: confirms no spurious Err from the closed transport when there was nothing to drain.
95:- `symmetric_on_append_two_peers_converge_with_bounded_wire_bytes` (V2 V3 step 1 audit closure): this test ALREADY does the explicit `flush_delta_to_transport()` after `poll_remote()`. Under V2 V3 step 2, the explicit flush becomes redundant (already auto-fired). Test should still pass (idempotency guard fires Ok(false) on the explicit flush). Worth a docstring update to note the explicit flushes are no longer required.
97:- `on_append_two_peer_session_round_trip_via_auto_flush` (V2 V2): currently has peer B (Disabled) drain via poll_remote. With V2 V3 step 2, peer B is still Disabled → no auto-flush on poll. Test unaffected.
111:- [ ] **3. Add `maybe_auto_flush` call to `poll_remote_with_limit`** (single one-line change + comment).
112:- [ ] **4. Invert `poll_remote_does_not_trigger_auto_flush_by_design`** test → `poll_remote_triggers_auto_flush_under_on_append`.
114:- [ ] **6. Update docstrings**: `AutoFlushPolicy::OnAppend` (remove `poll_remote*` from exclusion list, add to trigger list), `poll_remote` + `poll_remote_with_limit` (remove "by design" exclusion paragraph, add partial-state contract note), `transport.rs` module-doc (V2 V3 step 2 ship note).
115:- [ ] **7. Update broader docs**: `MASTER-PLAN.md` § 5.5, `phase5/v1-exit-packet.md` (V2 V3 step 2 row), `architecture/ide-consumer-contract.md` (remove poll_remote exclusion bullet).
127:- [x] **Self-loopback auto-flush?** When peer B sends to A's inbox, A polls, A auto-flushes back to the SAME paired transport (i.e., back toward B). B's `try_recv` will receive A's snapshot. B's Loro on import dedupes the ops B already knows. Wasted bandwidth at V2 V3 step 2 scale; closes only at V2 V3 step 4 with per-transport version vectors. Documented.
132:- This step closes the V2 V2 audit-locked M1 (poll_remote exclusion) at the source, completing the V2 V2 audit-closure narrative.
134:- V2 V3 step 4 (WebSocket) is where multi-transport routing may revisit the "auto-flush back to same paired transport" V1 limit.

exec
/bin/zsh -lc 'rg -n "poll_remote.*excluded|excluded from auto-flush|does NOT auto-flush|NOT auto-flush|manual flush_delta|receive-side excluded|caller.*explicit.*flush|poll_remote.*does not|poll_remote.*does NOT" quantbook-engine' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/MASTER-PLAN.md:586:   - **V2 V3 step 2 ✅ SHIPPED 2026-05-21**: wires `poll_remote*` into auto-flush. One flush per drain batch (not per-blob). V2 V3 step 1's idempotency guard prevents echo loops — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)`. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion. 3-peer hub fanout now works automatically under `OnAppend`.
quantbook-engine/docs/architecture/ide-consumer-contract.md:207:- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
quantbook-engine/docs/architecture/ide-consumer-contract.md:209:- **Receive-side auto-flush (✅ Phase 5.5 V2 V3 step 2 SHIPPED 2026-05-21)**: `poll_remote` / `poll_remote_with_limit` now auto-flush after the drain batch (one flush per call, not per-blob — bandwidth-efficient) when `OnAppend` is set AND at least one blob was drained. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion now that V2 V3 step 1's idempotency guard prevents echo loops at the source. **3-peer fanout (A↔hub↔B)**: the HUB with `OnAppend` now automatically propagates peer A's writes onward to peer B without an explicit flush after the drain. **Symmetric-OnAppend**: safe — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)` (no wire send). **V1 limit**: auto-flush from `poll_remote` goes back to the SAME transport the bytes came from. In a true multi-transport hub topology (one session, multiple attached transports), only one transport receives the fanout. V2 V3 step 4 (WebSocket + multi-transport routing) may add per-transport fanout. **Partial-state contract on flush Err**: if the post-batch auto-flush fails (closed transport, I/O error), the method returns `Err(CollabSessionError::Transport(_))` AFTER all `merged` blobs have been committed to the local log. Inspect `op_count()` to determine how many merged.
quantbook-engine/docs/phase5/v1-exit-packet.md:267:  the V2 V2 audit-locked "receive-side excluded" exclusion. 3-peer
quantbook-engine/crates/ql-collab/src/transport.rs:35://! Reverses the V2 V2 audit-locked "receive-side excluded" exclusion.
quantbook-engine/crates/ql-collab/src/transport.rs:191:/// NOT auto-flush by design — see `AutoFlushPolicy::OnAppend` for
quantbook-engine/crates/ql-collab/src/session.rs:213:    /// "receive-side excluded by design" exclusion now that V2 V3
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-5b-codex.md:825:   418	    /// attached and got replaced. V2 V1 does NOT auto-flush on
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:411:    // "receive-side excluded by design" exclusion. With V2 V3 step 1's
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1192:    // explicit poll_remote + manual flush_delta on each side (since
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1193:    // poll_remote excluded from auto-flush per V2 V2 audit M1);
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1213:    // poll_remote is excluded from auto-flush in V2 V3 step 1).
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:4464:quantbook-engine/crates/ql-collab/src/transport.rs:157:/// CollabSession does NOT auto-flush to its attached Transport
quantbook-engine/docs/audits/2026-05-19-phase-5-2-d-1-step-3-codex.md:4657:quantbook-engine/crates/ql-collab/src/transport.rs:157:/// CollabSession does NOT auto-flush to its attached Transport
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:725:/// CollabSession does NOT auto-flush to its attached Transport
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v1-codex.md:1453:   148	/// CollabSession does NOT auto-flush to its attached Transport
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-opus.md:34:Concretely: peer A with `OnAppend` calls `poll_remote()` → merges N blobs from peer B → A's log grew by potentially many ops → A does NOT auto-flush the merged union back to peer C (a third peer attached via A's transport).
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-opus.md:42:- (b) **Document the asymmetry** with a fixed reason: "poll_remote does not auto-flush by design — when a remote feeds you their snapshot, your peer-fanout side is responsible for batching its own flushes via `flush_to_transport` after drain."
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-opus.md:82:**Recommended action right now (V2 V2):** add a one-line caveat to the `OnAppend` docstring: *"Symmetric OnAppend across two paired peers is unsafe in V2 V2 — the second peer's poll_remote currently does not auto-flush (see M1), but if that asymmetry is resolved without a version-vector guard, an echo loop results. V2 V3 closes both."* This costs nothing and prevents a future contributor from "fixing" M1 in isolation.
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v3-step-1-codex.md:1423:   181	/// NOT auto-flush by design — see `AutoFlushPolicy::OnAppend` for
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v3-step-1-codex.md:2010:quantbook-engine/docs/architecture/ide-consumer-contract.md:207:- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v3-step-1-codex.md:2012:quantbook-engine/docs/architecture/ide-consumer-contract.md:209:- **Receive-side exclusion**: `poll_remote` / `poll_remote_with_limit` do NOT auto-flush by design (audit-locked Phase 5.5 V2 V2 Codex M1 + Opus M1, 2026-05-21). V2 V3 step 1 keeps this exclusion intact; step 2 will wire `poll_remote` into auto-flush safely thanks to the V2 V3 idempotency guard. Until step 2 ships, callers fanning a polled batch onward must invoke explicit `flush_delta_to_transport` (or `flush_to_transport`) after the drain. **Fanout caveat (3+ peers)**: in a hub topology (A↔hub↔B) where each peer's writes should reach the other, the HUB must enable `OnAppend` AND call `flush_delta_to_transport` after each `poll_remote` batch. Symmetric `OnAppend` on both endpoints of a paired transport is safe under V2 V3 step 1 idempotency guard (each side short-circuits when its own state didn't advance).
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v3-step-1-codex.md:2183:-    /// safe today ONLY because `poll_remote` deliberately does not
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v3-step-1-codex.md:2544:   207	- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v3-step-1-codex.md:2546:   209	- **Receive-side exclusion**: `poll_remote` / `poll_remote_with_limit` do NOT auto-flush by design (audit-locked Phase 5.5 V2 V2 Codex M1 + Opus M1, 2026-05-21). V2 V3 step 1 keeps this exclusion intact; step 2 will wire `poll_remote` into auto-flush safely thanks to the V2 V3 idempotency guard. Until step 2 ships, callers fanning a polled batch onward must invoke explicit `flush_delta_to_transport` (or `flush_to_transport`) after the drain. **Fanout caveat (3+ peers)**: in a hub topology (A↔hub↔B) where each peer's writes should reach the other, the HUB must enable `OnAppend` AND call `flush_delta_to_transport` after each `poll_remote` batch. Symmetric `OnAppend` on both endpoints of a paired transport is safe under V2 V3 step 1 idempotency guard (each side short-circuits when its own state didn't advance).
quantbook-engine/docs/audits/2026-05-19-phase-5-4-v2-v1-codex.md:11153:quantbook-engine/crates/ql-collab/src/session.rs:261:    /// attached and got replaced. V2 V1 does NOT auto-flush on
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:397:crates/ql-collab/src/session.rs:233:    /// attached and got replaced. V2 V1 does NOT auto-flush on
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:1321:+    /// attached and got replaced. V2 V1 does NOT auto-flush on
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2252:   150	/// CollabSession does NOT auto-flush to its attached Transport
quantbook-engine/docs/audits/2026-05-19-phase-5-5-v2-v1-codex.md:2647:   233	    /// attached and got replaced. V2 V1 does NOT auto-flush on
quantbook-engine/docs/audits/2026-05-20-phase-5-3-step-1-codex.md:2556:   304	    /// attached and got replaced. V2 V1 does NOT auto-flush on
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:462:docs/architecture/ide-consumer-contract.md:207:- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo`, `redo`, `sweep_presence`) auto-invoke `flush_to_transport` after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` API remains available regardless of policy (mix-and-match supported).
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:1502:One important shape is already visible: `poll_remote_with_limit` mutates the log directly via `self.log.merge_bytes(&bytes)?` but does not pass through `CollabSession::merge_bytes` or `maybe_auto_flush`. I’m tracing whether that is intentional surface area or a contract/doc mismatch.
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:2131:   161	/// CollabSession does NOT auto-flush to its attached Transport
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:2322:   207	- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo`, `redo`, `sweep_presence`) auto-invoke `flush_to_transport` after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` API remains available regardless of policy (mix-and-match supported).
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:2722:docs/architecture/ide-consumer-contract.md:207:- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo`, `redo`, `sweep_presence`) auto-invoke `flush_to_transport` after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` API remains available regardless of policy (mix-and-match supported).
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:3507:docs/architecture/ide-consumer-contract.md:207:- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo`, `redo`, `sweep_presence`) auto-invoke `flush_to_transport` after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` API remains available regardless of policy (mix-and-match supported).
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:3838:No HIGH findings. The specific Loopback ping-pong trace is not confirmed for the official `poll_remote()` path, because `poll_remote_with_limit()` merges directly into `self.log` and does not call `CollabSession::merge_bytes()`.
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:3853:This contradicts docs like [session.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:197), [transport.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:12), and [ide-consumer-contract.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/ide-consumer-contract.md:207), which say auto-flush fires after “every mutator”. Either wire one post-drain flush when `merged > 0`, or explicitly document `poll_remote*` as receive-side excluded to avoid echoes.
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:3905:161 /// CollabSession does NOT auto-flush to its attached Transport
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:3924:No HIGH findings. The specific Loopback ping-pong trace is not confirmed for the official `poll_remote()` path, because `poll_remote_with_limit()` merges directly into `self.log` and does not call `CollabSession::merge_bytes()`.
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:3939:This contradicts docs like [session.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:197), [transport.rs](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:12), and [ide-consumer-contract.md](/Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/docs/architecture/ide-consumer-contract.md:207), which say auto-flush fires after “every mutator”. Either wire one post-drain flush when `merged > 0`, or explicitly document `poll_remote*` as receive-side excluded to avoid echoes.
quantbook-engine/docs/audits/2026-05-21-phase-5-5-v2-v2-codex.md:3991:161 /// CollabSession does NOT auto-flush to its attached Transport

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '90,130p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
    90	    #[error("presence error: {0}")]
    91	    Presence(#[from] PresenceError),
    92	
    93	    /// **Phase 5.4 V1:** a Loro `UndoManager` call (`undo` /
    94	    /// `redo`) returned an error. Reachable when the underlying
    95	    /// document is in an invalid state for the requested
    96	    /// operation (e.g. mid-transaction).
    97	    #[error("undo/redo error: {0}")]
    98	    Undo(#[from] loro::LoroError),
    99	
   100	    /// **Phase 5.5 V2 (2026-05-19):** the attached `Transport`
   101	    /// returned an error.
   102	    ///
   103	    /// For `flush_to_transport`: the local `OpLog` is unaffected
   104	    /// (the snapshot export happened first; the failed step was
   105	    /// `Transport::send`). Caller can retry the flush.
   106	    ///
   107	    /// For `poll_remote`: any bytes successfully drained BEFORE
   108	    /// the error were already `merge_bytes`'d into the local
   109	    /// `OpLog` — those merges persist. The error indicates the
   110	    /// transport itself is misbehaving (`Io`) — `Closed` is
   111	    /// handled gracefully by `poll_remote` itself (returns
   112	    /// `Ok(merged)`, see Codex+Opus 5.5 V2 V1 audit closure).
   113	    /// Caller should detach + reattach a new transport instead
   114	    /// of retrying poll.
   115	    #[error("transport error: {0}")]
   116	    Transport(#[from] TransportError),
   117	
   118	    /// **Phase 5.3 step 5b (2026-05-20) — production wiring closure
   119	    /// (Opus-A Scenario E HIGH).** `rebuild_workbook` invoked
   120	    /// `replay_into` on the session's `OpLog` and replay failed at
   121	    /// some op index. The fresh workbook constructed internally was
   122	    /// in a HALF-MERGED state when the error fired and was DROPPED
   123	    /// before the error was returned (the wrapper owns it). The
   124	    /// session's `OpLog` is unaffected (replay reads only).
   125	    ///
   126	    /// Carries the underlying [`ReplayError`] via `#[source]` so
   127	    /// callers can `match err.source()` for the original op index +
   128	    /// diagnostic.
   129	    #[error("replay error: {0}")]
   130	    Replay(#[from] ReplayError),

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/log.rs | sed -n '1,220p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
exec
/bin/zsh -lc "rg -n \"export_delta_bytes|oplog_vv|merge_bytes\\(\" quantbook-engine/crates/ql-oplog/src quantbook-engine/crates/ql-collab/src/session.rs" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/crates/ql-collab/src/session.rs:42://! - `merge_bytes(&mut self, &[u8])` — pull a remote peer's
quantbook-engine/crates/ql-collab/src/session.rs:453:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, CollabSessionError> {
quantbook-engine/crates/ql-collab/src/session.rs:454:        let new_len = self.log.merge_bytes(bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:494:    /// session.merge_bytes(&peer_b_bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:774:        self.last_flushed_vv = Some(self.log.oplog_vv());
quantbook-engine/crates/ql-collab/src/session.rs:814:    /// - `CollabSessionError::OpLog` on `export_delta_bytes` failure.
quantbook-engine/crates/ql-collab/src/session.rs:822:        let current_vv = self.log.oplog_vv();
quantbook-engine/crates/ql-collab/src/session.rs:836:            Some(from) => self.log.export_delta_bytes(from)?,
quantbook-engine/crates/ql-collab/src/session.rs:839:                .export_delta_bytes(&loro::VersionVector::default())?,
quantbook-engine/crates/ql-collab/src/session.rs:938:                    self.log.merge_bytes(&bytes)?;
quantbook-engine/crates/ql-collab/src/session.rs:1404:        let merged_count = peer_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1523:        peer_a.merge_bytes(&b_bytes).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1554:        a1.merge_bytes(&b1.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1558:        b2.merge_bytes(&a2.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1591:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1601:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1978:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:1991:        peer_b.merge_bytes(&peer_a.export_bytes().unwrap()).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2287:        peer_b.merge_bytes(&received).unwrap();
quantbook-engine/crates/ql-collab/src/session.rs:2297:        peer_a.merge_bytes(&b_received).unwrap();
quantbook-engine/crates/ql-oplog/src/log.rs:337:    /// `from = &self.oplog_vv()` (current VV) produces a payload with
quantbook-engine/crates/ql-oplog/src/log.rs:344:    pub fn export_delta_bytes(&self, from: &loro::VersionVector) -> Result<Vec<u8>, OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:351:    /// (per Loro 1.12: `LoroDoc::oplog_vv` returns
quantbook-engine/crates/ql-oplog/src/log.rs:358:    pub fn oplog_vv(&self) -> loro::VersionVector {
quantbook-engine/crates/ql-oplog/src/log.rs:359:        self.doc.oplog_vv()
quantbook-engine/crates/ql-oplog/src/log.rs:382:    /// 4. Peer B calls `merge_bytes(&a_bytes)` — peer B's log now
quantbook-engine/crates/ql-oplog/src/log.rs:389:    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, OpLogError> {
quantbook-engine/crates/ql-oplog/src/log.rs:631:        peer_a.merge_bytes(&peer_b.export_bytes().unwrap()).unwrap();

 succeeded in 0ms:
     1	//! `OpLog` — Loro-backed append-only operation log.
     2	//!
     3	//! Phase 2A.3.a (2026-05-12): scaffolding-only API. The log stores ops as
     4	//! JSON-encoded strings inside a single Loro `LoroList` container named
     5	//! `"ops"`. Each `OpLog::append` call serializes the `Op`, pushes a string
     6	//! into the list, and commits the Loro doc.
     7	//!
     8	//! ## Why JSON-in-Loro
     9	//!
    10	//! Per Round 7 architectural lock T1-D05, Loro is reserved for the op log
    11	//! layer. Phase 2A.3.a aims for minimum viable scaffolding — full CRDT
    12	//! semantics (LoroMap-per-op with typed fields) is reserved for Phase 5+
    13	//! when inter-peer merging becomes load-bearing. The JSON layer is
    14	//! invisible to callers: they see typed `Op` values via `iter`.
    15	//!
    16	//! ## Persistence
    17	//!
    18	//! `export_bytes` produces a `Vec<u8>` via `ExportMode::Snapshot`. The
    19	//! resulting blob includes the full state plus history; **suitable for
    20	//! transport to other peers** (consumed by `merge_bytes` on the
    21	//! receiver). For `.qbook/oplog.bin` file persistence, the
    22	//! `ql_io::oplog_persistence` layer wraps this blob in a Quantlab
    23	//! header (Phase 5.2 D-1 step 7 — Tier D3: `OPLOG_MAGIC` + version u32).
    24	//! Do NOT write `export_bytes()` output directly to `oplog.bin`;
    25	//! use `save_workbook_with_oplog` instead.
    26	//!
    27	//! `import_bytes` reconstructs an `OpLog` from such a blob (raw Loro
    28	//! snapshot — the persistence layer strips the Quantlab header before
    29	//! calling this fn). The reader probes the `"ops"` LoroList; if absent
    30	//! (or the wrong shape), the import returns `OpLogError::SchemaMismatch`.
    31	
    32	use loro::{CommitOptions, ExportMode, LoroDoc, LoroList, LoroValue, ValueOrContainer};
    33	
    34	use crate::error::OpLogError;
    35	use crate::op::Op;
    36	
    37	/// The Loro container name our ops live under. Hard-coded; Phase 5+
    38	/// CRDT-level refactoring may add more containers (versions, peer state,
    39	/// etc.) but `"ops"` is reserved.
    40	const OPS_CONTAINER: &str = "ops";
    41	
    42	/// **Phase 5.6 (2026-05-19):** Loro container name for the per-peer
    43	/// ephemeral presence map (cursor + selection + typing indicator).
    44	/// Per the audit-closed Phase 5.1 design at
    45	/// `docs/architecture/crdt-data-model.md` § Presence container.
    46	/// Keys are peer-id strings; values are opaque JSON blobs (the
    47	/// typed `PresenceState` encoding lives in `ql_collab::presence`).
    48	const PRESENCE_CONTAINER: &str = "presence";
    49	
    50	/// **Phase 5.4 V1 (2026-05-19):** commit-origin tag for presence
    51	/// writes. `ql_collab::CollabSession` wires this to Loro's
    52	/// `UndoManager::add_exclude_origin_prefix` so cursor movements
    53	/// don't pollute the undo stack. Exported as `pub` so the higher-
    54	/// layer (ql-collab) can reference the same string constant.
    55	///
    56	/// **Reserved-namespace convention:** trailing `":"` so the prefix
    57	/// `presence:` only matches deliberately-namespaced origins (e.g.
    58	/// a future `presence:typing` would also be excluded; an
    59	/// independent `"presence-foo"` origin would NOT). This protects
    60	/// against accidental over-exclusion as more origins land
    61	/// (Codex+Opus 5.4 V1 audit findings A4/M5).
    62	pub const PRESENCE_COMMIT_ORIGIN: &str = "presence:";
    63	
    64	/// Append-only operation log backed by Loro.
    65	///
    66	/// Construct via `OpLog::new()` for a fresh log or `OpLog::import_bytes(...)`
    67	/// to reconstruct from a persisted snapshot. Mutations go through `append`;
    68	/// reads through `iter` / `len` / `is_empty`.
    69	pub struct OpLog {
    70	    doc: LoroDoc,
    71	}
    72	
    73	impl std::fmt::Debug for OpLog {
    74	    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    75	        f.debug_struct("OpLog")
    76	            .field("len", &self.len())
    77	            .field("doc", &"<LoroDoc>")
    78	            .finish()
    79	    }
    80	}
    81	
    82	impl Default for OpLog {
    83	    fn default() -> Self {
    84	        Self::new()
    85	    }
    86	}
    87	
    88	impl OpLog {
    89	    /// Construct an empty log.
    90	    pub fn new() -> Self {
    91	        Self {
    92	            doc: LoroDoc::new(),
    93	        }
    94	    }
    95	
    96	    /// Append one `Op` to the log. Serializes via `serde_json`, stores as
    97	    /// a `LoroValue::String` in the `"ops"` LoroList, and commits the
    98	    /// underlying Loro doc.
    99	    pub fn append(&mut self, op: Op) -> Result<(), OpLogError> {
   100	        let json = serde_json::to_string(&op).map_err(OpLogError::Serialize)?;
   101	        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
   102	        list.push(LoroValue::from(json.as_str()))?;
   103	        self.doc.commit();
   104	        Ok(())
   105	    }
   106	
   107	    /// Iterate the log in append order. Each yielded item is a
   108	    /// `Result<Op, OpLogError>` — a deserialization failure yields
   109	    /// `Err(OpLogError::Deserialize { index, source })` and iteration
   110	    /// continues (no short-circuit). Callers wanting fail-fast can use
   111	    /// `iter().collect::<Result<Vec<_>, _>>()`.
   112	    pub fn iter(&self) -> impl Iterator<Item = Result<Op, OpLogError>> + '_ {
   113	        let list: LoroList = self.doc.get_list(OPS_CONTAINER);
   114	        let len = list.len();
   115	        (0..len).map(move |index| {
   116	            let entry = list.get(index).ok_or(OpLogError::SchemaMismatch(
   117	                "ops LoroList lost an entry between len() and get()",
   118	            ))?;
   119	            let value = match entry {
   120	                ValueOrContainer::Value(v) => v,
   121	                ValueOrContainer::Container(_) => {
   122	                    return Err(OpLogError::SchemaMismatch(
   123	                        "ops LoroList holds a container; expected JSON-string values",
   124	                    ));
   125	                }
   126	            };
   127	            let s = match value {
   128	                LoroValue::String(s) => s,
   129	                _ => {
   130	                    return Err(OpLogError::SchemaMismatch(
   131	                        "ops LoroList holds a non-string LoroValue; expected JSON-string",
   132	                    ));
   133	                }
   134	            };
   135	            serde_json::from_str::<Op>(&s)
   136	                .map_err(|source| OpLogError::Deserialize { index, source })
   137	        })
   138	    }
   139	
   140	    /// Number of ops currently visible in the `"ops"` LoroList.
   141	    ///
   142	    /// **Phase 5.4 V1 (2026-05-19):** queries Loro directly each call
   143	    /// (was a cached `usize` field through 5.6). Codex 5.4 V1 audit
   144	    /// HIGH found the cache became stale after `loro::UndoManager`
   145	    /// retracted ops from the visible list. Returning Loro's
   146	    /// authoritative count is correct by construction; per-call
   147	    /// cost is one container handle lookup + a length read.
   148	    pub fn len(&self) -> usize {
   149	        self.doc.get_list(OPS_CONTAINER).len()
   150	    }
   151	
   152	    /// True iff `len() == 0`.
   153	    pub fn is_empty(&self) -> bool {
   154	        self.len() == 0
   155	    }
   156	
   157	    /// **Phase 5.2.b (2026-05-19):** set this log's Loro peer id.
   158	    ///
   159	    /// Wraps `LoroDoc::set_peer_id`. Used by `ql_collab::CollabSession`
   160	    /// to wire its stable `PeerId` through to Loro so concurrent
   161	    /// appends carry the right origin in the CRDT merge metadata.
   162	    ///
   163	    /// Loro takes `&self` (interior mutability), so this method is
   164	    /// `&self` too. Calling it twice with the same id leaves the
   165	    /// peer id unchanged but is NOT a strict no-op at Loro's
   166	    /// internal layer: Loro re-stores the atom and emits a
   167	    /// `peer_id_change_subs` notification each call. Avoid calling
   168	    /// repeatedly in hot paths.
   169	    ///
   170	    /// **Caller pitfalls** (from `loro::LoroDoc::set_peer_id`):
   171	    /// 1. NEVER reuse the same peer id across concurrent writers
   172	    ///    (multiple tabs / devices for the same user). Duplicate peer
   173	    ///    ids corrupt the document via conflicting OpIDs.
   174	    /// 2. Avoid pinning a peer id to a stable user/device identity
   175	    ///    unless you also enforce single-ownership locking. Prefer a
   176	    ///    per-process-random peer id.
   177	    /// 3. Setting peer id AFTER an import is safe — existing imported
   178	    ///    ops retain their original peer ids; only this log's future
   179	    ///    appends use the new id.
   180	    /// 4. Loro reserves `u64::MAX` as a sentinel; passing it returns
   181	    ///    `OpLogError::Loro(LoroError::InvalidPeerID)`.
   182	    /// 5. **Phase 5.4 V1 (2026-05-19):** if a `loro::UndoManager`
   183	    ///    (constructed via [`new_undo_manager`]) is alive, Loro
   184	    ///    SILENTLY CLEARS its undo + redo stacks on the peer-id
   185	    ///    change (`loro-internal::undo:654-662`). Callers must
   186	    ///    treat post-construction peer-id changes as undo-stack-
   187	    ///    invalidating events.
   188	    ///
   189	    /// Signature note: `&mut self` (Phase 5.4 V1 audit closure)
   190	    /// even though Loro's `LoroDoc::set_peer_id` is `&self`. The
   191	    /// `&mut` prevents accidental peer-id changes through a shared
   192	    /// `&OpLog` (`CollabSession::op_log()`) which would silently
   193	    /// clear an attached `UndoManager`'s stacks per pitfall 5.
   194	    ///
   195	    /// **Phase 5.2 D-1 step 8 megaudit closure (Opus-B HIGH-1,
   196	    /// 2026-05-20):** asserts `peer != 0`. PeerId(0) is `LEGACY_PEER`
   197	    /// — reserved as the sentinel for pre-collab single-writer +
   198	    /// qbook envelope migration. An active session whose Loro peer
   199	    /// id is 0 would silently collide with the LEGACY_PEER semantic
   200	    /// in `FormatTable::with_peer(LEGACY_PEER)` (the cross-peer
   201	    /// same-string design assumes LEGACY_PEER is sentinel-only).
   202	    /// `CollabSession::new` + `from_snapshot` already assert this at
   203	    /// the higher level; this guard catches direct callers of
   204	    /// `OpLog::set_peer_id` that bypass the CollabSession constructor.
   205	    pub fn set_peer_id(&mut self, peer: u64) -> Result<(), OpLogError> {
   206	        assert_ne!(
   207	            peer, 0,
   208	            "PeerId(0) is LEGACY_PEER (reserved for pre-collab single-writer + qbook migration). \
   209	             OpLog::set_peer_id must be called with a non-zero peer; collides with LEGACY_PEER otherwise."
   210	        );
   211	        self.doc.set_peer_id(peer)?;
   212	        Ok(())
   213	    }
   214	
   215	    /// Current Loro peer id for this log. Wraps `LoroDoc::peer_id`.
   216	    pub fn peer_id(&self) -> u64 {
   217	        self.doc.peer_id()
   218	    }
   219	
   220	    /// **Phase 5.6 (2026-05-19):** write the given peer's presence blob

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-oplog/src/log.rs | sed -n '320,420p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
   320	    }
   321	
   322	    /// Export the log to a binary blob suitable for on-disk persistence.
   323	    /// Uses Loro's `ExportMode::Snapshot` — includes full state + history,
   324	    /// compressed.
   325	    pub fn export_bytes(&self) -> Result<Vec<u8>, OpLogError> {
   326	        Ok(self.doc.export(ExportMode::Snapshot)?)
   327	    }
   328	
   329	    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** export the delta of
   330	    /// ops added SINCE the given version vector `from`. Uses
   331	    /// `ExportMode::updates(&from)`.
   332	    ///
   333	    /// `from = &VersionVector::default()` (empty VV) is equivalent to
   334	    /// `ExportMode::all_updates()` — sends every op the doc has ever
   335	    /// seen. Use for fresh-peer handshakes.
   336	    ///
   337	    /// `from = &self.oplog_vv()` (current VV) produces a payload with
   338	    /// no new ops — typically an empty / near-empty wire blob. Use
   339	    /// for "did anything happen since last sync" checks.
   340	    ///
   341	    /// Returns the encoded bytes. Loro's `import` transparently
   342	    /// consumes both `Snapshot` and `Updates` blobs on the receiver
   343	    /// side, so the wire format is opaque to peers.
   344	    pub fn export_delta_bytes(&self, from: &loro::VersionVector) -> Result<Vec<u8>, OpLogError> {
   345	        Ok(self.doc.export(ExportMode::updates(from))?)
   346	    }
   347	
   348	    /// **Phase 5.5 V2 V3 step 1 (2026-05-21):** read the doc's
   349	    /// current op-log version vector. Cheap — clones an internal
   350	    /// `VersionVector` whose size is O(peer-count), not O(op-count)
   351	    /// (per Loro 1.12: `LoroDoc::oplog_vv` returns
   352	    /// `self.oplog.lock().vv().clone()`; size is one `u32` per
   353	    /// distinct peer that has ever contributed an op).
   354	    ///
   355	    /// Called by `ql_collab::CollabSession::flush_delta_to_transport`
   356	    /// (which depends on `ql-oplog`); there is no reverse
   357	    /// dependency.
   358	    pub fn oplog_vv(&self) -> loro::VersionVector {
   359	        self.doc.oplog_vv()
   360	    }
   361	
   362	    /// Reconstruct an `OpLog` from a previously-exported snapshot.
   363	    /// If the snapshot doesn't carry our `"ops"` container shape,
   364	    /// subsequent `iter` / `len` calls operate on an empty list
   365	    /// (Loro creates absent root containers on first access).
   366	    pub fn import_bytes(bytes: &[u8]) -> Result<Self, OpLogError> {
   367	        let doc = LoroDoc::new();
   368	        doc.import(bytes)?;
   369	        Ok(Self { doc })
   370	    }
   371	
   372	    /// **Phase 5.2 D-4 (2026-05-19):** merge another peer's snapshot
   373	    /// into this log via Loro's CRDT merge. Concurrent appends to
   374	    /// the `"ops"` LoroList are preserved in deterministic causal
   375	    /// order (Fugue/origin-based with peer-id tiebreaker per
   376	    /// `loro-internal::container::richtext::tracker::crdt_rope`).
   377	    ///
   378	    /// Typical pattern for multi-peer collaboration:
   379	    /// 1. Both peers start from a shared snapshot (`import_bytes`).
   380	    /// 2. Each peer appends its own ops independently.
   381	    /// 3. Peer A exports its current state via `export_bytes`.
   382	    /// 4. Peer B calls `merge_bytes(&a_bytes)` — peer B's log now
   383	    ///    contains both peers' ops in causal order.
   384	    /// 5. Replay against a workbook reconstructs the merged state.
   385	    /// 6. `WorkbookRuntime::recompute_all` resolves derived state
   386	    ///    (spills, formula values) from the merged final state.
   387	    ///
   388	    /// Returns the new `len()` after merge.
   389	    pub fn merge_bytes(&mut self, bytes: &[u8]) -> Result<usize, OpLogError> {
   390	        self.doc.import(bytes)?;
   391	        Ok(self.len())
   392	    }
   393	}
   394	
   395	#[cfg(test)]
   396	mod tests {
   397	    use super::*;
   398	    use crate::wire::{CellWireValue, NamedTargetWire};
   399	
   400	    fn put_value(sheet: u16, row: u32, col: u32, n: f64) -> Op {
   401	        Op::PutValue {
   402	            sheet,
   403	            row,
   404	            col,
   405	            value: CellWireValue::Number(n),
   406	        }
   407	    }
   408	
   409	    #[test]
   410	    fn new_log_is_empty() {
   411	        let log = OpLog::new();
   412	        assert!(log.is_empty());
   413	        assert_eq!(log.len(), 0);
   414	        assert!(log.iter().next().is_none());
   415	    }
   416	
   417	    #[test]
   418	    fn append_single_op_round_trips() {
   419	        let mut log = OpLog::new();
   420	        let op = put_value(0, 5, 3, 42.0);

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '1320,1435p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  1320	/// Construct + configure a Loro `UndoManager` bound to `log`'s
  1321	/// underlying doc.
  1322	///
  1323	/// Phase 5.4 V1 setup: register `PRESENCE_COMMIT_ORIGIN` as an
  1324	/// exclude prefix so cursor-movement commits don't fill the
  1325	/// undo stack. (Phase 5.6 V1 tags presence writes with that
  1326	/// origin via `OpLog::presence_set` / `presence_remove`.)
  1327	fn make_undo_manager(log: &OpLog) -> loro::UndoManager {
  1328	    let mut undo = log.new_undo_manager();
  1329	    undo.add_exclude_origin_prefix(PRESENCE_COMMIT_ORIGIN);
  1330	    undo
  1331	}
  1332	
  1333	#[cfg(test)]
  1334	mod tests {
  1335	    use super::*;
  1336	    use ql_oplog::CellWireValue;
  1337	
  1338	    fn put_value(sheet: u16, row: u32, col: u32, n: f64) -> Op {
  1339	        Op::PutValue {
  1340	            sheet,
  1341	            row,
  1342	            col,
  1343	            value: CellWireValue::Number(n),
  1344	        }
  1345	    }
  1346	
  1347	    #[test]
  1348	    fn new_session_is_empty() {
  1349	        let s = CollabSession::new(PeerId::new(1)).unwrap();
  1350	        assert_eq!(s.peer_id(), PeerId::new(1));
  1351	        assert_eq!(s.op_count(), 0);
  1352	        assert!(s.is_empty());
  1353	    }
  1354	
  1355	    #[test]
  1356	    fn append_grows_log() {
  1357	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  1358	        s.append_op(Op::AddSheet {
  1359	            name: "S".to_owned(),
  1360	            chunk_rows: 16384,
  1361	        })
  1362	        .unwrap();
  1363	        s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
  1364	        assert_eq!(s.op_count(), 2);
  1365	        assert!(!s.is_empty());
  1366	    }
  1367	
  1368	    #[test]
  1369	    fn from_snapshot_reconstructs_op_count() {
  1370	        let mut origin = CollabSession::new(PeerId::new(1)).unwrap();
  1371	        origin
  1372	            .append_op(Op::AddSheet {
  1373	                name: "S".to_owned(),
  1374	                chunk_rows: 16384,
  1375	            })
  1376	            .unwrap();
  1377	        origin.append_op(put_value(0, 0, 0, 1.0)).unwrap();
  1378	
  1379	        let bytes = origin.export_bytes().unwrap();
  1380	        let reborn = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
  1381	        assert_eq!(reborn.peer_id(), PeerId::new(2));
  1382	        assert_eq!(reborn.op_count(), 2);
  1383	    }
  1384	
  1385	    #[test]
  1386	    fn merge_bytes_grows_log_with_remote_ops() {
  1387	        // Two peers, shared base, each appends; one merges the other.
  1388	        let mut base = CollabSession::new(PeerId::new(100)).unwrap();
  1389	        base.append_op(Op::AddSheet {
  1390	            name: "S".to_owned(),
  1391	            chunk_rows: 16384,
  1392	        })
  1393	        .unwrap();
  1394	        let base_bytes = base.export_bytes().unwrap();
  1395	
  1396	        let mut peer_a = CollabSession::from_snapshot(PeerId::new(1), &base_bytes).unwrap();
  1397	        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();
  1398	
  1399	        let mut peer_b = CollabSession::from_snapshot(PeerId::new(2), &base_bytes).unwrap();
  1400	        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
  1401	
  1402	        // Peer A pulls peer B's bytes.
  1403	        let b_bytes = peer_b.export_bytes().unwrap();
  1404	        let merged_count = peer_a.merge_bytes(&b_bytes).unwrap();
  1405	        assert!(
  1406	            merged_count >= 3,
  1407	            "merged log has at least AddSheet + 2× PutValue (got {merged_count})"
  1408	        );
  1409	    }
  1410	
  1411	    #[test]
  1412	    fn debug_impl_includes_peer_id_and_count() {
  1413	        let mut s = CollabSession::new(PeerId::new(42)).unwrap();
  1414	        s.append_op(put_value(0, 0, 0, 1.0)).ok();
  1415	        let d = format!("{s:?}");
  1416	        assert!(d.contains("peer_id"), "Debug must include peer_id: {d}");
  1417	        assert!(d.contains("op_count"), "Debug must include op_count: {d}");
  1418	    }
  1419	
  1420	    #[test]
  1421	    fn peer_id_is_wired_to_underlying_loro_doc() {
  1422	        // Regression: prior to Phase 5.2.b the PeerId was stored on
  1423	        // CollabSession but never passed to LoroDoc::set_peer_id, so
  1424	        // op attribution at the CRDT layer used Loro's random
  1425	        // per-doc peer id. After 5.2.b the configured PeerId MUST
  1426	        // appear as the underlying log's peer_id().
  1427	        let s = CollabSession::new(PeerId::new(0xdead_beef_cafe_babe)).unwrap();
  1428	        assert_eq!(s.peer_id().as_u64(), 0xdead_beef_cafe_babe);
  1429	        assert_eq!(s.op_log().peer_id(), 0xdead_beef_cafe_babe);
  1430	    }
  1431	
  1432	    #[test]
  1433	    fn from_snapshot_overrides_imported_peer_id() {
  1434	        // The origin session writes ops under PeerId(11). The reborn
  1435	        // session imports the snapshot but uses its own PeerId(22)

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '2028,2225p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
  2028	        assert!(s.has_transport());
  2029	        let detached = s.detach_transport();
  2030	        assert!(detached.is_some());
  2031	        assert!(!s.has_transport());
  2032	        assert!(s.detach_transport().is_none(), "second detach is None");
  2033	    }
  2034	
  2035	    #[test]
  2036	    fn flush_to_transport_noop_without_attached() {
  2037	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  2038	        let flushed = s.flush_to_transport().unwrap();
  2039	        assert!(!flushed, "flush with no transport returns false");
  2040	    }
  2041	
  2042	    #[test]
  2043	    fn poll_remote_noop_without_attached() {
  2044	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  2045	        let drained = s.poll_remote().unwrap();
  2046	        assert_eq!(drained, 0, "poll with no transport returns 0");
  2047	    }
  2048	
  2049	    #[test]
  2050	    fn flush_to_transport_pushes_bytes_via_attached() {
  2051	        use crate::transport::LoopbackTransport;
  2052	        let (tx_a, mut tx_b) = LoopbackTransport::pair();
  2053	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  2054	        s.append_op(put_value(0, 0, 0, 42.0)).unwrap();
  2055	        s.attach_transport(tx_a);
  2056	
  2057	        assert_eq!(
  2058	            tx_b.pending_recv(),
  2059	            0,
  2060	            "transport idle until flush is called"
  2061	        );
  2062	        let flushed = s.flush_to_transport().unwrap();
  2063	        assert!(flushed);
  2064	        assert_eq!(tx_b.pending_recv(), 1, "flush pushed exactly one blob");
  2065	
  2066	        // Sanity: the pushed bytes are a valid Loro snapshot
  2067	        // (poll on B's side drains them).
  2068	        let received = tx_b.try_recv().unwrap().expect("tx_b drains one blob");
  2069	        assert!(!received.is_empty());
  2070	    }
  2071	
  2072	    #[test]
  2073	    fn poll_remote_drains_attached_transport() {
  2074	        use crate::transport::LoopbackTransport;
  2075	        let (tx_a, tx_b) = LoopbackTransport::pair();
  2076	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  2077	        // Pre-populate tx_a's inbox by writing into tx_b's outbox via
  2078	        // tx_b's send. (tx_b.send → tx_a.inbox)
  2079	        let snapshot = {
  2080	            let other = CollabSession::new(PeerId::new(2)).unwrap();
  2081	            other.export_bytes().unwrap()
  2082	        };
  2083	        let mut tx_b = tx_b; // own it for send
  2084	        tx_b.send(&snapshot).unwrap();
  2085	        tx_b.send(&snapshot).unwrap();
  2086	
  2087	        s.attach_transport(tx_a);
  2088	        let drained = s.poll_remote().unwrap();
  2089	        assert_eq!(drained, 2, "poll drained both queued blobs");
  2090	
  2091	        // Next poll is a no-op (queue empty).
  2092	        let drained2 = s.poll_remote().unwrap();
  2093	        assert_eq!(drained2, 0);
  2094	    }
  2095	
  2096	    #[test]
  2097	    fn two_sessions_converge_via_attached_loopback() {
  2098	        use crate::transport::LoopbackTransport;
  2099	        let (tx_a, tx_b) = LoopbackTransport::pair();
  2100	
  2101	        let base = CollabSession::new(PeerId::new(1)).unwrap();
  2102	        let base_bytes = base.export_bytes().unwrap();
  2103	
  2104	        let mut peer_a = CollabSession::from_snapshot(PeerId::new(0xa), &base_bytes).unwrap();
  2105	        peer_a.attach_transport(tx_a);
  2106	        let mut peer_b = CollabSession::from_snapshot(PeerId::new(0xb), &base_bytes).unwrap();
  2107	        peer_b.attach_transport(tx_b);
  2108	
  2109	        // A appends + flushes; B polls.
  2110	        peer_a.append_op(put_value(0, 0, 0, 10.0)).unwrap();
  2111	        peer_a.flush_to_transport().unwrap();
  2112	        let drained_b = peer_b.poll_remote().unwrap();
  2113	        assert_eq!(drained_b, 1);
  2114	        assert!(peer_b.op_count() >= peer_a.op_count());
  2115	
  2116	        // Reverse: B appends + flushes; A polls.
  2117	        peer_b.append_op(put_value(0, 1, 0, 20.0)).unwrap();
  2118	        peer_b.flush_to_transport().unwrap();
  2119	        let drained_a = peer_a.poll_remote().unwrap();
  2120	        assert_eq!(drained_a, 1);
  2121	        assert_eq!(peer_a.op_count(), peer_b.op_count());
  2122	    }
  2123	
  2124	    #[test]
  2125	    fn flush_to_transport_errors_when_transport_closed() {
  2126	        // Codex+Opus 5.5 V2 V1 audit closure: missing test for
  2127	        // flush-on-closed-transport. Attach a LoopbackTransport,
  2128	        // close it, then attempt flush — expect Transport::Closed.
  2129	        use crate::transport::LoopbackTransport;
  2130	        let (tx_a, _tx_b) = LoopbackTransport::pair();
  2131	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  2132	        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
  2133	        // Close BEFORE attaching: close() takes &self so we can do
  2134	        // this on the raw transport.
  2135	        tx_a.close();
  2136	        s.attach_transport(tx_a);
  2137	        let result = s.flush_to_transport();
  2138	        assert!(
  2139	            matches!(
  2140	                result,
  2141	                Err(CollabSessionError::Transport(TransportError::Closed))
  2142	            ),
  2143	            "flush on closed transport must Err(Closed), got {result:?}"
  2144	        );
  2145	        // Local OpLog unaffected — op still in the log.
  2146	        assert!(s.op_count() >= 1);
  2147	    }
  2148	
  2149	    #[test]
  2150	    fn poll_remote_treats_closed_as_graceful_end_of_stream() {
  2151	        // Codex+Opus 5.5 V2 V1 audit closure: pin partial-merge-
  2152	        // then-Closed semantics. The trait contract guarantees
  2153	        // Closed only after queue drains; CollabSession::poll_remote
  2154	        // returns Ok(merged) on Closed (NOT Err) so the caller sees
  2155	        // the merge count.
  2156	        use crate::transport::LoopbackTransport;
  2157	        let (tx_a, mut tx_b) = LoopbackTransport::pair();
  2158	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  2159	
  2160	        // Queue 3 snapshots in tx_a's inbox.
  2161	        let snapshot = {
  2162	            let other = CollabSession::new(PeerId::new(2)).unwrap();
  2163	            other.export_bytes().unwrap()
  2164	        };
  2165	        for _ in 0..3 {
  2166	            tx_b.send(&snapshot).unwrap();
  2167	        }
  2168	        // Close tx_a's endpoint. Per trait contract, A.try_recv
  2169	        // drains 3 queued blobs first, then returns Closed.
  2170	        tx_a.close();
  2171	        s.attach_transport(tx_a);
  2172	
  2173	        let drained = s.poll_remote().unwrap();
  2174	        assert_eq!(
  2175	            drained, 3,
  2176	            "poll_remote must drain all queued blobs even when transport is closed"
  2177	        );
  2178	        // Next poll: queue is empty + closed → still Ok(0) (graceful).
  2179	        let drained2 = s.poll_remote().unwrap();
  2180	        assert_eq!(drained2, 0);
  2181	    }
  2182	
  2183	    #[test]
  2184	    fn poll_remote_with_limit_caps_drain() {
  2185	        // Codex+Opus 5.5 V2 V1 audit closure (H1): poll_remote_with_limit
  2186	        // bounds the drain. Pre-populate 10 blobs, drain 4 at a time.
  2187	        use crate::transport::LoopbackTransport;
  2188	        let (tx_a, mut tx_b) = LoopbackTransport::pair();
  2189	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  2190	
  2191	        let snapshot = {
  2192	            let other = CollabSession::new(PeerId::new(2)).unwrap();
  2193	            other.export_bytes().unwrap()
  2194	        };
  2195	        for _ in 0..10 {
  2196	            tx_b.send(&snapshot).unwrap();
  2197	        }
  2198	        s.attach_transport(tx_a);
  2199	
  2200	        let d1 = s.poll_remote_with_limit(4).unwrap();
  2201	        assert_eq!(d1, 4, "first call drains 4");
  2202	        let d2 = s.poll_remote_with_limit(4).unwrap();
  2203	        assert_eq!(d2, 4, "second call drains 4");
  2204	        let d3 = s.poll_remote_with_limit(4).unwrap();
  2205	        assert_eq!(d3, 2, "third call drains the remaining 2");
  2206	        let d4 = s.poll_remote_with_limit(4).unwrap();
  2207	        assert_eq!(d4, 0, "queue empty");
  2208	
  2209	        // limit = 0 is a no-op even with queued blobs.
  2210	        tx_b.send(&snapshot).unwrap();
  2211	        let d5 = s.poll_remote_with_limit(0).unwrap();
  2212	        assert_eq!(d5, 0, "limit=0 must be a no-op");
  2213	    }
  2214	
  2215	    #[test]
  2216	    fn attach_flush_detach_reattach_cycle() {
  2217	        // Codex+Opus 5.5 V2 V1 audit closure: missing test for
  2218	        // full attach-flush-detach-reattach lifecycle.
  2219	        use crate::transport::LoopbackTransport;
  2220	        let mut s = CollabSession::new(PeerId::new(1)).unwrap();
  2221	        s.append_op(put_value(0, 0, 0, 1.0)).unwrap();
  2222	
  2223	        // Cycle 1: attach, flush, detach.
  2224	        let (tx_a1, tx_b1) = LoopbackTransport::pair();
  2225	        s.attach_transport(tx_a1);

exec
/bin/zsh -lc 'rg -n "poll_remote.*now auto|poll_remote.*does NOT|poll_remote.*excluded|poll_remote.*auto-flush|Receive-side auto-flush" quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-collab/src/transport.rs quantbook-engine/crates/ql-collab/tests/auto_flush.rs quantbook-engine/docs/architecture/ide-consumer-contract.md quantbook-engine/docs/MASTER-PLAN.md quantbook-engine/docs/phase5/v1-exit-packet.md quantbook-engine/docs/phase5/entry-plan.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/phase5/entry-plan.md:118:| 5.5 | Transport Layer + Offline Sync | 1-2 weeks | **🟡 V1 + V2 V1 + V2 V2 + V2 V3 steps 1-2 SHIPPED** — V1 `924750819bc`: `Transport` trait + `NoopTransport` + `LoopbackTransport`. V2 V1 `ffd8f6e5f05`: explicit-drive `attach/detach/has_transport` + `flush_to_transport` + `poll_remote`. V2 V2 ✅ 2026-05-21 (`51748b02944` + `b7aa4cb7bb9`): `AutoFlushPolicy::{Disabled, OnAppend}`. V2 V3 step 1 ✅ 2026-05-21 (`603bdc9aa6c` + `e5ff11d549a`): `CollabSession::flush_delta_to_transport` + `last_flushed_vv` + `OpLog::{oplog_vv, export_delta_bytes}` helpers. Auto-flush reroutes through delta path; idempotency short-circuit closes echo-loop class. **V2 V3 step 2 ✅ 2026-05-21**: wires `poll_remote*` into auto-flush (one flush per drain batch). 3-peer hub fanout now works automatically under `OnAppend`. V2 V3 steps 3-6 pending: offline-write queue + WebSocket impl + megaudit + exit packet. |
quantbook-engine/docs/phase5/v1-exit-packet.md:3:status: ACTIVE — Phase 5 V1 surface complete 2026-05-19. **D-1 SHIPPED 2026-05-20**. **5.3 SHIPPED 2026-05-20**. **5.5 V2 V2 (auto-flush) SHIPPED 2026-05-21**. **5.5 V2 V3 step 1 (version-vector delta flush) SHIPPED 2026-05-21**. **5.5 V2 V3 step 2 (poll_remote auto-flush) SHIPPED 2026-05-21**. See `docs/phase5/d-1-exit-packet.md` + `docs/phase5/5-3-exit-packet.md`. 5.5 V2 V3 steps 3-6 (offline-write queue + WebSocket impl + megaudit + exit packet), 5.7 IDE slice, and 5.8 megaudit remain.
quantbook-engine/docs/phase5/v1-exit-packet.md:25:V2 V3 step 2 (poll_remote auto-flush) ✅ SHIPPED 2026-05-21. Phase 5.5
quantbook-engine/docs/phase5/v1-exit-packet.md:263:- **Phase 5.5 V2 V3 step 2 — poll_remote auto-flush.** ✅
quantbook-engine/docs/phase5/v1-exit-packet.md:264:  **SHIPPED 2026-05-21**. Wires `poll_remote*` into auto-flush
quantbook-engine/docs/architecture/ide-consumer-contract.md:209:- **Receive-side auto-flush (✅ Phase 5.5 V2 V3 step 2 SHIPPED 2026-05-21)**: `poll_remote` / `poll_remote_with_limit` now auto-flush after the drain batch (one flush per call, not per-blob — bandwidth-efficient) when `OnAppend` is set AND at least one blob was drained. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion now that V2 V3 step 1's idempotency guard prevents echo loops at the source. **3-peer fanout (A↔hub↔B)**: the HUB with `OnAppend` now automatically propagates peer A's writes onward to peer B without an explicit flush after the drain. **Symmetric-OnAppend**: safe — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)` (no wire send). **V1 limit**: auto-flush from `poll_remote` goes back to the SAME transport the bytes came from. In a true multi-transport hub topology (one session, multiple attached transports), only one transport receives the fanout. V2 V3 step 4 (WebSocket + multi-transport routing) may add per-transport fanout. **Partial-state contract on flush Err**: if the post-batch auto-flush fails (closed transport, I/O error), the method returns `Err(CollabSessionError::Transport(_))` AFTER all `merged` blobs have been committed to the local log. Inspect `op_count()` to determine how many merged.
quantbook-engine/docs/MASTER-PLAN.md:586:   - **V2 V3 step 2 ✅ SHIPPED 2026-05-21**: wires `poll_remote*` into auto-flush. One flush per drain batch (not per-blob). V2 V3 step 1's idempotency guard prevents echo loops — duplicate (Loro-deduped) merges leave the VV unchanged → flush short-circuits to `Ok(false)`. Reverses the V2 V2 audit-locked "receive-side excluded" exclusion. 3-peer hub fanout now works automatically under `OnAppend`.
quantbook-engine/crates/ql-collab/src/transport.rs:28://! `poll_remote*` into auto-flush. After a successful drain
quantbook-engine/crates/ql-collab/src/session.rs:251:    /// `poll_remote` also auto-flushes — the round-trip back to the
quantbook-engine/crates/ql-collab/src/session.rs:784:    /// step 2's `poll_remote` auto-flush wiring).
quantbook-engine/crates/ql-collab/src/session.rs:885:    /// exclusion of `poll_remote*` from auto-flush. V2 V3 step 1's
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:406:// ===== V2 V3 step 2: poll_remote triggers auto-flush (inverted from V2 V2 exclusion) =====
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:412:    // idempotency guard in place, wiring poll_remote into auto-flush
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:419:    // A's poll_remote drains it AND auto-flushes the merged delta
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:452:        "V2 V3 step 2: poll_remote MUST auto-flush after a successful drain that advanced state"
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:469:    // state. A's poll_remote merges (no new ops), auto-flush
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1193:    // poll_remote excluded from auto-flush per V2 V2 audit M1);
quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1213:    // poll_remote is excluded from auto-flush in V2 V3 step 1).

exec
/bin/zsh -lc 'rg -n "flush_to_transport.*internally|maybe_auto_flush.*flush_to_transport|invoke.*flush_to_transport|auto-invoke `flush_to_transport`|auto-flush.*full snapshot|full-snapshot path|every mutator.*poll_remote" quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-collab/src/transport.rs quantbook-engine/docs/architecture/ide-consumer-contract.md' in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
zsh:1: command not found: flush_to_transport
quantbook-engine/docs/architecture/ide-consumer-contract.md:207:- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
quantbook-engine/docs/architecture/ide-consumer-contract.md:208:- **Delta flush (✅ Phase 5.5 V2 V3 step 1 SHIPPED 2026-05-21):** `CollabSession::flush_delta_to_transport()` sends only the delta of ops added since the last successful flush, using `LoroDoc::ExportMode::Updates`. Wire payload is O(per-op delta) instead of O(full state). Idempotency short-circuit: a flush after no state change returns `Ok(false)` without invoking `transport.send` — closes the V2 V2 audit echo-loop class. **Auto-flush now routes through this delta path by default** (V2 V3 step 1 reroute of `maybe_auto_flush`). Loro's `import` transparently accepts both snapshot and update bytes, so peers don't need any changes. First flush after `attach_transport` sends from the empty VV (= all ops the session has ever appended) — the new transport-peer reconstructs the full history. Use `flush_to_transport` (snapshot) for explicit-handshake / reseed flows; `flush_delta_to_transport` for steady-state syncing.
quantbook-engine/crates/ql-collab/src/session.rs:204:    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
quantbook-engine/crates/ql-collab/src/session.rs:420:    /// [`flush_to_transport`] internally after the append. Transport
quantbook-engine/crates/ql-collab/src/session.rs:437:    /// auto-invoke the repair pass — audit-locked D-5.3-1 keeps repair
quantbook-engine/crates/ql-collab/src/session.rs:630:    /// (caller invokes `flush_to_transport` per tick). V2 V2 added
quantbook-engine/crates/ql-collab/src/session.rs:679:    /// ([`flush_delta_to_transport`]), not the full-snapshot path
quantbook-engine/crates/ql-collab/src/session.rs:717:    /// [`flush_to_transport`] (full-snapshot path). Wire payload is

exec
/bin/zsh -lc "rg -n 'flush_to_transport.*internally|maybe_auto_flush.*flush_to_transport|invoke.*flush_to_transport|auto-invoke "'`flush_to_transport`|auto-flush.*full snapshot|full-snapshot path'"' quantbook-engine/crates/ql-collab/src/session.rs quantbook-engine/crates/ql-collab/src/transport.rs quantbook-engine/docs/architecture/ide-consumer-contract.md" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
quantbook-engine/docs/architecture/ide-consumer-contract.md:207:- **Auto-flush (✅ Phase 5.5 V2 V2 SHIPPED 2026-05-21):** `CollabSession::set_auto_flush_policy(AutoFlushPolicy::OnAppend)` makes every mutator (`append_op`, `merge_bytes`, presence writes, `undo` / `redo` when an item was consumed, `sweep_presence`) auto-flush after a successful state change. IDE callers can drop their scheduled-flush-tick loops. Default is `AutoFlushPolicy::Disabled` (V2 V1 explicit-drive behavior preserved — set explicitly to opt in). **Partial-state contract**: if auto-flush fails (closed transport, I/O error), the surrounding mutator returns `Err(CollabSessionError::Transport(_))` BUT the local op is already committed (mutate-then-flush ordering). Callers MUST treat local state as authoritative + either retry the flush or detach the transport. The explicit `flush_to_transport` (full snapshot) + `flush_delta_to_transport` (V2 V3 delta) APIs remain available regardless of policy (mix-and-match supported).
quantbook-engine/docs/architecture/ide-consumer-contract.md:208:- **Delta flush (✅ Phase 5.5 V2 V3 step 1 SHIPPED 2026-05-21):** `CollabSession::flush_delta_to_transport()` sends only the delta of ops added since the last successful flush, using `LoroDoc::ExportMode::Updates`. Wire payload is O(per-op delta) instead of O(full state). Idempotency short-circuit: a flush after no state change returns `Ok(false)` without invoking `transport.send` — closes the V2 V2 audit echo-loop class. **Auto-flush now routes through this delta path by default** (V2 V3 step 1 reroute of `maybe_auto_flush`). Loro's `import` transparently accepts both snapshot and update bytes, so peers don't need any changes. First flush after `attach_transport` sends from the empty VV (= all ops the session has ever appended) — the new transport-peer reconstructs the full history. Use `flush_to_transport` (snapshot) for explicit-handshake / reseed flows; `flush_delta_to_transport` for steady-state syncing.
quantbook-engine/crates/ql-collab/src/session.rs:204:    /// [`flush_to_transport`] (full-snapshot path). Wire payload is
quantbook-engine/crates/ql-collab/src/session.rs:420:    /// [`flush_to_transport`] internally after the append. Transport
quantbook-engine/crates/ql-collab/src/session.rs:630:    /// (caller invokes `flush_to_transport` per tick). V2 V2 added
quantbook-engine/crates/ql-collab/src/session.rs:679:    /// ([`flush_delta_to_transport`]), not the full-snapshot path
quantbook-engine/crates/ql-collab/src/session.rs:717:    /// [`flush_to_transport`] (full-snapshot path). Wire payload is

exec
/bin/zsh -lc "nl -ba quantbook-engine/crates/ql-collab/src/session.rs | sed -n '1,70p'" in /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook
 succeeded in 0ms:
     1	//! `CollabSession` — per-peer collaboration state holder.
     2	//!
     3	//! **Phase 5.2.a (2026-05-19, scaffold ship):** wraps `ql_oplog::OpLog`
     4	//! with peer-id-aware operations + transport plumbing. Subsequent
     5	//! phases populate richer behavior:
     6	//!
     7	//! - ~~**Phase 5.4**~~ ✅ V1 + V2 V1 + V2 V1.1 shipped — V1
     8	//!   `89c02b9d83e`: 7 undo/redo methods. V2 V1 `6138a7203f6` +
     9	//!   `e199a5fda5a`: `start_undo_group` / `end_undo_group` +
    10	//!   `set_undo_merge_interval`. V2 V1.1: `start_undo_group_scoped`
    11	//!   returns RAII `UndoGroupGuard` for panic/Err-safe grouping.
    12	//!   Presence-origin commits auto-excluded.
    13	//! - **Phase 5.5** — transport layer. V1 shipped at
    14	//!   `924750819bc` (LoopbackTransport for in-process 2-peer
    15	//!   tests). V2 V1 shipped at `ffd8f6e5f05` —
    16	//!   `CollabSession::{attach,detach,has}_transport` +
    17	//!   `flush_to_transport` + `poll_remote` (+ `_with_limit`)
    18	//!   typed methods; explicit-drive (caller invokes flush + poll
    19	//!   on a tick). V2 V2 / V3 pending — auto-flush + version-
    20	//!   vector deltas + WebSocket impl.
    21	//! - ~~**Phase 5.6**~~ ✅ V1 + V2 shipped — V1 `c677e244704`:
    22	//!   `presence` module + 4 typed methods. V2: `sweep_presence`
    23	//!   (caller-opt-in clean-slate on rejoin; closes V1 known
    24	//!   persistence limitation).
    25	//! - **Phase 5.7** — IDE binding: `CollabSession` becomes the engine
    26	//!   handle that the IDE attaches to each open workbook.
    27	//!
    28	//! What ships in 5.2.a (5.2.b update 2026-05-19):
    29	//!
    30	//! - `CollabSession::new(peer_id)` — fresh session with an empty
    31	//!   `OpLog` and the peer-id wired through to
    32	//!   `LoroDoc::set_peer_id` (Phase 5.2.b — was a label-only stamp
    33	//!   in 5.2.a). Returns `Result` because Loro's `set_peer_id` is
    34	//!   fallible.
    35	//! - `CollabSession::from_snapshot(peer_id, bytes)` — fork from a
    36	//!   shared base snapshot (used by both peers in the D-4 probe
    37	//!   pattern). The reborn session's peer id is `peer_id`; existing
    38	//!   ops in the imported snapshot retain their original
    39	//!   attribution.
    40	//! - `append_op(&mut self, Op)` — local append; delegates to
    41	//!   `OpLog::append`.
    42	//! - `merge_bytes(&mut self, &[u8])` — pull a remote peer's
    43	//!   snapshot via Loro's CRDT merge; delegates to
    44	//!   `OpLog::merge_bytes`.
    45	//! - `export_bytes(&self)` — produce a snapshot for transport.
    46	//! - `op_log(&self)` — read-only view of the underlying log
    47	//!   (for replay against a workbook).
    48	//! - `peer_id(&self)` — the session's stable peer id.
    49	
    50	use thiserror::Error;
    51	
    52	use ql_functions::FunctionRegistry;
    53	use ql_oplog::{replay_into, Op, OpLog, OpLogError, PeerId, ReplayError, PRESENCE_COMMIT_ORIGIN};
    54	use ql_storage::Workbook;
    55	
    56	use crate::presence::{self, PresenceError, PresenceState};
    57	use crate::repair::{
    58	    repair_column_rename_chain, repair_sheet_rename_chain, repair_table_rename_chain,
    59	    ColumnRepairReport, SheetRepairReport, TableRepairReport,
    60	};
    61	use crate::transport::{Transport, TransportError};
    62	
    63	/// **Phase 5.5 V2 V1 audit closure (2026-05-19):** default cap on
    64	/// the number of blobs `CollabSession::poll_remote` drains per
    65	/// call. Prevents one poll from starving the calling thread when
    66	/// an externally-fed transport produces faster than we merge.
    67	/// Callers wanting a different bound use `poll_remote_with_limit`.
    68	pub const DEFAULT_POLL_REMOTE_LIMIT: usize = 64;
    69	
    70	// Phase 5.5 V2 V1 audit closure: pin the Send contract the

codex
**VERDICT: PASS-WITH-FINDINGS**

**HIGH:** None.

**MEDIUM:** None.

**LOW:**

1. Stale `LoopbackTransport` rustdoc contradicts Step 2 behavior.  
[transport.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:181>) still says:
```rust
/// land on the wire (e.g. ordering tests). `poll_remote` does
/// NOT auto-flush by design — see `AutoFlushPolicy::OnAppend` for
/// the rationale.
```
That should be updated because [session.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:959>) now does:
```rust
if merged > 0 {
    self.maybe_auto_flush()?;
}
```

2. The symmetric-OnAppend test comments are now stale and describe the old Step 1 contract.  
[auto_flush.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1192>) says:
```rust
// explicit poll_remote + manual flush_delta on each side (since
// poll_remote excluded from auto-flush per V2 V2 audit M1);
```
and [auto_flush.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1212>) says:
```rust
// Each peer drains its inbox; explicit flush after poll (since
// poll_remote is excluded from auto-flush in V2 V3 step 1).
```
Those explicit flushes are now redundant. The test still passes, and the new direct Step 2 test covers the real behavior, but the comments should be updated to avoid preserving the old mental model.

3. Missing direct coverage for “drain succeeds, post-drain auto-flush send fails.”  
The implementation propagates the send error after committing merges:
```rust
if merged > 0 {
    self.maybe_auto_flush()?;
}
```
The added closed-transport test covers only the zero-drain guard:
```rust
let result = peer_a.poll_remote();
assert!(matches!(result, Ok(0)), ...)
```
A small receive-capable transport that returns one blob from `try_recv` and then fails `send` would pin the documented partial-state contract.

**Audit Notes**

I did not find another public `CollabSession` path that mutates `self.log` and misses the normal auto-flush hook: `append_op`, `merge_bytes`, presence writes/sweep, consumed `undo`/`redo`, and `poll_remote_with_limit` are wired. Constructors and transport lifecycle methods are correctly excluded.

I did not run cargo tests per your note.
tokens used
154,298
**VERDICT: PASS-WITH-FINDINGS**

**HIGH:** None.

**MEDIUM:** None.

**LOW:**

1. Stale `LoopbackTransport` rustdoc contradicts Step 2 behavior.  
[transport.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/transport.rs:181>) still says:
```rust
/// land on the wire (e.g. ordering tests). `poll_remote` does
/// NOT auto-flush by design — see `AutoFlushPolicy::OnAppend` for
/// the rationale.
```
That should be updated because [session.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/src/session.rs:959>) now does:
```rust
if merged > 0 {
    self.maybe_auto_flush()?;
}
```

2. The symmetric-OnAppend test comments are now stale and describe the old Step 1 contract.  
[auto_flush.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1192>) says:
```rust
// explicit poll_remote + manual flush_delta on each side (since
// poll_remote excluded from auto-flush per V2 V2 audit M1);
```
and [auto_flush.rs](</Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine/crates/ql-collab/tests/auto_flush.rs:1212>) says:
```rust
// Each peer drains its inbox; explicit flush after poll (since
// poll_remote is excluded from auto-flush in V2 V3 step 1).
```
Those explicit flushes are now redundant. The test still passes, and the new direct Step 2 test covers the real behavior, but the comments should be updated to avoid preserving the old mental model.

3. Missing direct coverage for “drain succeeds, post-drain auto-flush send fails.”  
The implementation propagates the send error after committing merges:
```rust
if merged > 0 {
    self.maybe_auto_flush()?;
}
```
The added closed-transport test covers only the zero-drain guard:
```rust
let result = peer_a.poll_remote();
assert!(matches!(result, Ok(0)), ...)
```
A small receive-capable transport that returns one blob from `try_recv` and then fails `send` would pin the documented partial-state contract.

**Audit Notes**

I did not find another public `CollabSession` path that mutates `self.log` and misses the normal auto-flush hook: `append_op`, `merge_bytes`, presence writes/sweep, consumed `undo`/`redo`, and `poll_remote_with_limit` are wired. Constructors and transport lifecycle methods are correctly excluded.

I did not run cargo tests per your note.

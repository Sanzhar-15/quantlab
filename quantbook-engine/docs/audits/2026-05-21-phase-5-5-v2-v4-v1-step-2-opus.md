# Phase 5.5 V2 V4 V1 step 2 — Opus adversarial audit

**Target:** HEAD `ff76fc99d49` (Tier I1 `pending_op_count()` helper).
**Predecessor:** `ef9e8f2f75c` (V2 V4 V1 step 1 closure).
**Workspace tests:** 4448 / 0 (+6 net). fmt + clippy clean.
**Auditor:** Opus (adversarial lane, parallel with Codex).
**Scope:** session.rs field + accessor, 6 tests, backlog SHIPPED marker, consumer doc gotcha #4.

## Verdict

**1 HIGH (doc-contract drift — saturating_sub justification is wrong, undo retracts and reaches the masked underflow path TODAY)**, **2 MEDIUM**, **3 LOW**, **plus confirmed-safe pairing/atomicity**.

The structural code is correct — every `last_flushed_vv` write site has a paired `last_flushed_op_count` write site, atomically (single-statement, single-borrow of `&mut self`). Field initialization, attach/detach reset, and both flush success paths are symmetric. The 6 new tests cover the basic contract.

The HIGH is a docstring-vs-reality contradiction that future maintainers will rely on. The MEDIUMs are an `from_snapshot` coverage gap + a consumer doc claim that's false under undo. LOWs are looseness in the new tests.

---

## HIGH

### H1 — `saturating_sub` justification contradicts `OpLog::len()` undo-retract contract; the underflow path is reachable TODAY, not just under hypothetical V2 V4 Tier I2

**Where:** `quantbook-engine/crates/ql-collab/src/session.rs:923-928` (pending_op_count docstring) and the commit message ("Loro op log is append-only today; future Tier I2 `discard_pending_ops` could push count backwards").

**The contradiction:**
- `quantbook-engine/crates/ql-oplog/src/log.rs:142-150` documents that `OpLog::len()` was changed from a cached counter to a live `LoroList` query specifically because **`loro::UndoManager` retracts ops from the visible list**. The 5.4 V1 audit HIGH that prompted this fix explicitly recorded that undo decreases `len()`.
- `pending_op_count`'s docstring justifies `saturating_sub` with "Loro's op log is append-only today, so the subtraction never actually underflows today." That is **false**. Undo retracts → `log.len()` decreases. If a successful flush set `last_flushed_op_count = Some(5)` and a subsequent undo (without a follow-up flush) drops `log.len()` to 4, the saturating subtraction silently masks underflow.

**Reachable scenario:**
1. Transport attached, `AutoFlushPolicy::Disabled` (the default).
2. `append_op` × 5 → `log.len() == 5`.
3. Caller explicitly calls `flush_delta_to_transport()` → `last_flushed_op_count = Some(5)`.
4. `set_auto_flush_policy(Disabled)` (already default) — undo will NOT auto-flush.
5. Caller invokes `undo()` → retracts the most recent op → `log.len() == 4`.
6. `pending_op_count()` returns `4.saturating_sub(5) = 0`.
7. The IDE indicator says "Synced — 0 pending," but `has_pending_flush()` returns `true` (current VV differs from last flushed VV). Two observables that the docstring claims pair naturally now contradict each other.

Even with `AutoFlushPolicy::OnAppend` the scenario is reachable: if the undo flush fails (`Err(Closed)`), `last_flushed_op_count` is preserved (Err path), `log.len()` is smaller, underflow path is hit.

**Why it's HIGH not MEDIUM:** the docstring affirmatively misleads future maintainers about WHY `saturating_sub` is needed. A future contributor reading "append-only today" might reasonably refactor to plain `-` (or `try_into()` for signed math) under "Phase 5.7 audit closure: remove unnecessary defensive arithmetic." That refactor would panic on the undo path the moment the IDE wires up `OnAppend` + a flaky transport.

**Fix:** rewrite the rationale paragraph:

```rust
/// `saturating_sub` defensively because `loro::UndoManager` retracts
/// ops from the visible LoroList (see `OpLog::len` docstring in
/// ql-oplog). After a flush sets `last_flushed_op_count = Some(N)`,
/// a subsequent undo can drop `log.len()` below N when:
///   - `auto_flush_policy = Disabled` (the default), OR
///   - the post-undo auto-flush fails (Err preserves the baseline).
/// V2 V4 Tier I2 `discard_pending_ops` would extend this path.
```

The current "append-only today" assertion is load-bearing wrong and should be removed.

---

## MEDIUM

### M1 — `from_snapshot` semantics pinned in docstring but not in any test

**Where:** `session.rs:952-955` docstring asserts: "`from_snapshot` session: returns the imported op count immediately, even before `attach_transport`. Matches `has_pending_flush() == true` for the same scenario."

**Gap:** none of the 6 new tests construct via `CollabSession::from_snapshot`. `from_snapshot` is used elsewhere in `auto_flush.rs` (lines 67, 148, 152, 351, 355, 632, 639, 686, 690, 1282, 1286) but none of those exercise `pending_op_count`. The docstring claim is unpinned — if a future refactor changes `from_snapshot` to initialize `last_flushed_op_count = Some(0)` "as a baseline," the claim silently becomes false and no test catches it.

**Why MEDIUM not HIGH:** the V2 V3 step 3 audit Opus M1 documented the parallel `has_pending_flush` gotcha for `from_snapshot`; this audit caught it. Pre-existing convention is to pin docstring claims in tests.

**Fix:** add one test:

```rust
#[test]
fn pending_op_count_after_from_snapshot_includes_imported_ops() {
    let mut src = CollabSession::new(PeerId::new(1)).unwrap();
    src.append_op(add_sheet()).unwrap();
    src.append_op(put_value(0, 0, 0, 1.0)).unwrap();
    let bytes = src.export_bytes().unwrap();

    let imported = CollabSession::from_snapshot(PeerId::new(2), &bytes).unwrap();
    assert!(
        imported.pending_op_count() >= 2,
        "from_snapshot imports ops; pending_op_count reflects them pre-attach"
    );
}
```

### M2 — Consumer-contract gotcha #4 claims "the boolean check is `pending_op_count() > 0`" — false under undo retraction

**Where:** `quantbook-engine/docs/architecture/ide-consumer-contract.md:255` (NEW gotcha #4): "Pairs naturally with `has_pending_flush()` (the boolean check is `pending_op_count() > 0`)."

Under the H1 scenario (flush + undo without follow-up flush), `pending_op_count() == 0` while `has_pending_flush() == true`. The two observables disagree. The IDE wiring `if pending_op_count() > 0 { show_unsynced() }` will silently MISS the undo-pending state — exactly the kind of "Synced!" lie this gotcha section is supposed to prevent.

**Fix:** weaken the claim. Either:
- "Pairs with `has_pending_flush()` in the common-case (append-then-flush)" with an undo caveat, OR
- Drop the equivalence claim entirely. The two are sibling observables, not always-equal.

---

## LOW

### L1 — Test assertions use `>=` rather than `==`, which masks off-by-one bugs

**Where:** all 6 new tests use `>= N` rather than `== N`. Pattern from prior step 3 tests — defensive against Loro counting internal container-creation ops.

`pending_op_count_grows_with_appends_pre_flush` asserts `>= 1` after one append and `>= 3` after three. If Loro silently counts container-init ops, the actual counts could be 1+K, 3+K for some constant K. Using `>=` lets the test pass for any K. A bug that double-counts (e.g., 2× per append → 2, 6) would still pass `>=`.

**Fix or accept:** at minimum, add an `assert_eq!(after_three - after_one, 2, "exact monotonic delta")` invariant on the DIFFERENCE — that's tighter than `>=` without committing to an absolute count.

### L2 — `pending_op_count_after_attach_includes_all_local_ops` actually exercises detach+attach, not bare attach

**Where:** `auto_flush.rs:1844-1868`. Test name says "after attach"; body is "after detach + attach a new transport." The detach call (line 1859) is load-bearing — it's what resets `last_flushed_op_count = None`. Pure `attach_transport` over an existing attached transport also resets (line 715). The test never exercises that path.

**Fix:** rename to `pending_op_count_after_reattach_includes_all_local_ops`, OR add a sibling test that attaches over an existing transport without detaching first.

### L3 — Backlog Tier I1 SHIPPED entry has placeholder `[V2 V4 V1 step 2 commit]` instead of `ff76fc99d49`

**Where:** `quantbook-engine/docs/PHASE-4-V2-BACKLOG.md:524`. Reads "shipped at HEAD `[V2 V4 V1 step 2 commit]`." Same placeholder pattern as Tier K1 line 571 ("`[V2 V4 V1 step 1 commit]`"). Forward-reference resolution that closure cycles typically tidy up.

**Fix:** replace both placeholders with the actual short-SHAs (`ff76fc99d49` for I1, `3342e21b964` for K1).

---

## Doc-surface drift

`quantbook-engine/docs/phase5/v2-v3-exit-packet.md:127` still lists "I1: `pending_op_count()` / `pending_op_summary()` for bounded-queue IDE policies" under "V2 V4 backlog (3 tiers from V2 V3 megaudits)" without a SHIPPED marker. Tier J/K entries above it have similar treatment. Likely fine to leave historical (the exit packet is a frozen snapshot of V2 V3 exit state), but worth noting that the BACKLOG.md correctly has the SHIPPED marker while the exit packet does not. Per convention historical transcripts are left as-is.

---

## Confirmed-safe paths

- **Pairing with `last_flushed_vv`**: every site that mutates `last_flushed_vv` mutates `last_flushed_op_count` on the immediately adjacent line. Verified at 7 sites: `new:402-403`, `from_snapshot:446-447`, `attach_transport:710-715`, `detach_transport:735-737`, `flush_to_transport:1034-1037`, `flush_delta_to_transport:1146-1149`, idempotency short-circuit `flush_delta_to_transport:1126-1130` (no write needed, both fields already match — correct). Single `&mut self` borrow throughout, atomicity by construction.
- **Off-by-one risk**: order is `transport.send(&bytes)?` → set `last_flushed_vv = Some(current_vv)` → set `last_flushed_op_count = Some(self.log.len())`. No concurrent mutation possible (CollabSession is `!Sync`); `self.log.len()` at the final step equals the value implicit in `current_vv` at step 1.
- **Counter semantics under merge** (`pending_op_count_with_merged_peer_ops_includes_them`): `merge_bytes` calls `doc.import(bytes)`, which populates the `OPS_CONTAINER` LoroList → `log.len()` grows; `last_flushed_op_count` is NOT touched (merge is not a flush) → count grows. This IS the intended semantic per the "log entries transport hasn't seen" framing.
- **`OpLog::len()` scope**: counts only `OPS_CONTAINER` (the wire op LoroList). Presence map (`PRESENCE_CONTAINER`) updates do NOT contribute. This is correct for the IDE consumer use case (bounded-queue policy cares about wire-ops, not presence churn). Worth a docstring sentence but not a finding.
- **Concurrent reads**: CollabSession is `!Sync`; `pending_op_count(&self)` cannot race with `&mut self` mutators. Safe.
- **No `Err`-path drift**: `flush_to_transport` and `flush_delta_to_transport` write `last_flushed_op_count` only AFTER `transport.send(&bytes)?` succeeds. Err short-circuits via `?` before any state mutation — both fields preserve prior values. Symmetric.

---

## Recommendation

Close H1 (rewrite the docstring) + M1 (add `from_snapshot` test) + M2 (weaken the consumer-doc equivalence claim) before considering this step's audit cycle closed. L1/L2/L3 are cosmetic and could be deferred to V2 V4 V1 step 3+ closure batch.

**Lines: 124**

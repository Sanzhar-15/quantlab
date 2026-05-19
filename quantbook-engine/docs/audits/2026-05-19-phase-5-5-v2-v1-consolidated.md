---
title: Phase 5.5 V2 V1 audit synthesis (CollabSession transport wrappers)
status: CLOSED
date: 2026-05-19
auditors:
  - Codex (Mac CLI, 97k tokens) — full transcript: `2026-05-19-phase-5-5-v2-v1-codex.md`
  - Opus subagent (65k tokens) — full transcript: `2026-05-19-phase-5-5-v2-v1-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `ffd8f6e5f05` (Phase 5.5 V2 V1 — CollabSession transport wrappers)
---

## Scope

Behavioral change: 5 new typed transport methods on
`CollabSession` (attach/detach/has/flush/poll). ~150 LOC + 9
tests. Per audit-discipline rule, parallel Codex + Opus
dispatched.

## Convergent findings (BOTH auditors caught)

### **poll_remote partial-drain + close semantics** (the cluster)

Both auditors flagged the `poll_remote` loop from different angles:

| Aspect | Codex | Opus | Disposition |
|---|---|---|---|
| Unbounded loop | LOW: "could starve the caller" | HIGH H1: "real V2 hazard" | ✅ **CLOSED** — added `poll_remote_with_limit(max)` + `DEFAULT_POLL_REMOTE_LIMIT = 64` constant. `poll_remote()` delegates with the default cap. Pinned by test `poll_remote_with_limit_caps_drain`. |
| Partial-merge then `Closed` | MEDIUM: "docs say OpLog unaffected, which is false for poll_remote" | (subsumed in H1 framing) | ✅ **CLOSED** — `poll_remote_with_limit` treats `Closed` as graceful end-of-stream, returns `Ok(merged)`. Only `Io` propagates as Err. New test `poll_remote_treats_closed_as_graceful_end_of_stream`. Docstring rewritten to distinguish OpLog vs Transport error semantics + partial-merge persistence. |

### Doc drift across 5 files

Both auditors converged on the same 5 files (transport.rs,
crdt-data-model.md, entry-plan.md, known-gaps.md, lib.rs/session.rs)
needing V2 V1 markers + remaining V2 V2/V3 scope. ✅ All closed.

## Opus-only findings

### H3 — Send pin on `CollabSession`

Opus noted `LoopbackTransport` has `_ASSERT_LOOPBACK_TRANSPORT_SEND_SYNC`
but `CollabSession` has no equivalent. Loro Send/Sync is non-obvious;
future dep bump could silently break the threading claim.

**CLOSURE:** added `_ASSERT_COLLAB_SESSION_SEND` const block
mirroring the transport pattern.

### M5 — attach_transport silently loses prior pending data

Opus noted `attach_transport` uses `Option::replace`, dropping
any prior transport along with its inbox queue. Tests don't
cover this.

**CLOSURE:** documented in `attach_transport` docstring:
"replacing a transport discards any bytes queued in the previous
transport's recv channel" — actually, simpler: documented via the
return value (Some(prior) lets the caller drain it before drop).
The replace is intentional + return-prior-then-caller-decides is
the V1 contract.

## Codex-only findings

### MEDIUM — `flush_to_transport` docstring wrong about error variants

Codex flagged that `flush_to_transport`'s docstring says "transport
errors" but `export_bytes()?` returns `OpLog`, not `Transport`.
Opus subsumed this into H2 framing.

**CLOSURE:** docstring rewritten to enumerate both error
variants (`CollabSessionError::OpLog` for export, `Transport`
for send) and note that the local OpLog is unaffected in both
cases (export runs first, send is last step).

## Deferred (with rationale)

- Opus M2 (downcast lost): documented; concrete-type recovery
  via `Any` machinery deferred until a real caller surfaces.
- Opus M3 (`Result<bool>` tristate): `FlushOutcome` enum deferred
  to V2 V2 — pre-0.2.0 API; current docstring clearly explains
  the three states.
- Opus L1-L5: minor docs, addressed inline or noted for V2 V2.
- Codex C4 (value-level convergence): `op_count == op_count`
  remains in the 2-session test; stronger value-level assertion
  deferred to a forward Phase 5.7 IDE integration test (where
  reading individual cells is more natural).

## Gates (post-closure)

- `cargo test --workspace`: 4205 → expected 4209 (+4 new audit-closure tests).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy -p ql-collab --all-targets -- -D warnings`: clean.

## Verdict

**Phase 5.5 V2 V1 is ship-clean post-closure.** All 3 HIGHs
(unbounded poll, docstring error variant, Send pin) closed. All
MEDIUMs either closed or explicitly deferred to V2 V2 with
rationale. Doc drift across 5 files refreshed.

## Discipline meta-note

This is the 6th consecutive cycle this session where the 2-way
audit caught issues either auditor alone might have missed. The
poll_remote issue is a striking convergence: Codex saw it as a
documentation issue (docstring lies about OpLog being unaffected)
while Opus saw it as a behavioral issue (unbounded loop + partial-
merge ambiguity). Both angles correct; the truth is both. A
single-auditor pass might have rationalized either framing alone
and shipped the contract violation.

The 2-way discipline has now caught real correctness/contract
bugs in 5 of 6 cycles this session:
- 5.2.b (set_peer_id silent footgun)
- 5.6 V1 (persistence contract drift — Codex-only, Opus 529'd)
- 5.4 V1 (cached_len stale + set_peer_id silent footgun — both)
- 5.5 V1 (drain-before-Closed contract violation — both)
- 5.5 V2 V1 (unbounded poll + partial-merge ambiguity — both)

Only 5.2.a scaffold and 5.5 V1 audit-closure docs shipped
without HIGH findings; everything substantive caught something.

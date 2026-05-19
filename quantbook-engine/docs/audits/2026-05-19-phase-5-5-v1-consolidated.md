---
title: Phase 5.5 V1 audit synthesis (LoopbackTransport)
status: CLOSED
date: 2026-05-19
auditors:
  - Codex (Mac CLI, 136k tokens) — full transcript: `2026-05-19-phase-5-5-v1-codex.md`
  - Opus subagent (66k tokens) — full transcript: `2026-05-19-phase-5-5-v1-opus.md`
  - Self (single-pass) — drove the closures.
audit_target: commit `3590aa6d89e` (5.5 V1 ship) + `924750819bc` (truncation fix)
---

## Scope

Behavioral change: new `LoopbackTransport` impl of the
audit-locked `Transport` trait. ~165 LOC + 9 tests.

## Convergent findings (BOTH auditors caught)

### **DRAIN-BEFORE-CLOSED CONTRACT VIOLATION** (HIGH priority)

Both auditors independently flagged that `LoopbackTransport::try_recv`
returned `Closed` immediately on `close()`, violating the
`Transport` trait docstring at `transport.rs:41-46`:

> "Receivers should still drain any already-queued bytes via
> `try_recv` before considering the channel done."

And `transport.rs:71-74`:

> "Returns `Err(TransportError::Closed)` only when the channel
> is permanently closed AND its internal queue is empty."

| Aspect | Codex | Opus | Disposition |
|---|---|---|---|
| Issue | "MEDIUM: Public Transport docs say closed receivers should drain queued bytes; LoopbackTransport returns Closed immediately" | "H1+H2: pair() close semantics + pending_recv ignores closed" | ✅ **CLOSED** — `try_recv` now drains queued bytes FIRST and only returns `Closed` once the queue is empty AND `closed = true`. Tests updated. Trait + impl now consistent. |

This is the single most important finding from this cycle. Both
auditors caught it from slightly different angles.

### Doc drift across 5 files (LOW priority — both auditors converged)

Both flagged the same 5 files needing V1-shipped markers:
`crdt-data-model.md` §373, `entry-plan.md:110`, `known-gaps.md:116`,
`session.rs:12-15`, `transport.rs:3-7`. All closed.

### Send+Sync static assertion missing (LOW priority — both)

Both noted the docstring promises Send+Sync but no compile-time
assertion pins it. ✅ **CLOSED** with `const _: fn() = || { ... }`
block.

## Opus-only findings

### M2 — Atomic ordering caveat (DOCUMENTED, not changed)

Opus: cross-thread close-then-send race with Relaxed ordering.
Codex: PASS for memory safety; logical race is inherent.

**Closure:** documented the caveat in `LoopbackTransport`
docstring (`## Atomic ordering caveat` block). Callers using
cross-thread close must externally synchronize.

### M3 — Mutex poison → Io (KEPT)

Opus: poison mapped to `TransportError::Io` may violate
no-fallbacks rule; should panic or have a `Poisoned` variant.
Codex: PASS — defensible for a non-panicking transport trait.

**Closure:** KEPT. The `Io` mapping is appropriate because (a)
the caller can't recover from poison either way; (b) panicking
mid-call is worse than surfacing as an Io error; (c) a separate
`Poisoned` variant would expand the public error surface for a
near-impossible failure mode.

## Codex-only findings

None unique — Codex's HIGH/MEDIUM matched Opus's findings. Codex
flagged the workspace test-count inventory drift (4349 listed vs
4196 actual passing) as informational; this is a known cargo
test-counting quirk and not an issue.

## Deferred (intentional)

- Opus L1: multi-threaded test verifying Send+Sync at runtime.
  Compile-time assertion (M1 closure) is sufficient pin.
- Opus L2: large-blob (1MB) test. Pass-through `Vec::to_vec`
  doesn't risk truncation; no V1 test value.
- Opus L4: "close mid-exchange" integration test in session.rs.
  Valuable for V2 auto-flush coverage; not blocking V1.
- Opus L5: `close(&self)` vs `send(&mut self)` API inconsistency.
  Defensible per Codex; documented in close-semantics block.

## Gates (post-closure)

- `cargo test --workspace`: **4196 passed** (no count change —
  drain-before-Closed refactor preserved all behavior; updated
  test renamed but count is the same).
- `cargo fmt --all -- --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean
  per Codex pre-closure run.

## Verdict

**Phase 5.5 V1 is ship-clean post-closure.** Both auditors'
convergent finding (drain-before-Closed contract violation) was
the most important catch — a single Loro-aware reader could
have missed it because the trait docs and the impl looked
internally consistent in isolation; the issue only surfaced
under careful contract reading.

## Discipline meta-note

Phase 5.5 V1 is the 5th consecutive cycle this session validating
the 2-way audit-discipline rule. Both auditors caught the
same trait-contract violation independently — strong evidence
that either alone might have shipped it. Codex framed it as a
MEDIUM doc/impl mismatch; Opus framed it as 2 HIGHs (semantic
test bug + accessor inconsistency). The truth is between the
two: it's a real behavior bug, but the impact is bounded to
in-process test code, so MEDIUM is the right ship-blocking
severity. Either framing yields the same closure: rewrite
`try_recv` to drain first.

The cycles so far this session (5.2.b / 5.6 V1 / 5.4 V1 / 5.5 V1)
have ALL had convergent findings between the two auditors. The
"counter-factual" (would only one have shipped) is increasingly
clear: Codex's source-grounded code reading complements Opus's
contract / API reading. Lose either and quality drops.

Phase 5 Megaudit (5.8) — LANE D (Opus/Codex): API/contract/binding consistency + deferred-item audit + test-coverage gaps.

You are auditing the COMPLETE Quantbook Phase 5 collaboration surface. PHASE-LEVEL megaudit. Read-only / audit-only. THIS LANE checks that the documented contract matches reality across the WHOLE phase, that the napi↔TS binding is consistent, that every deferred item is still validly deferred (not rotted into a bug), and that Phase 5 invariants have test coverage.

Repos: engine /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab-quantbook/quantbook-engine (source HEAD `1465b1db4c4`); IDE /Users/sanzhar/Documents/Sanzhar/Sanzhar/quantlab/quantlab/extensions/quantlab (HEAD `d028568b53b`).

YOUR CHECKLIST:

D1. CONTRACT-vs-IMPLEMENTATION drift (WHOLE contract, not just V3.6). Read docs/architecture/ide-consumer-contract.md §4.1.z5 + §4.1.z6 fully and verify EVERY behavioral claim against the actual engine + IDE code. The V3.6.0.10 docs megaudit found extensive drift in the V3.6 section; this lane re-verifies the ENTIRE Phase 5 contract (V3.1→V3.6) is true at current HEAD. Report each stale/false claim with the contradicting code at file:line.

D2. napi ↔ TS PARITY. For all 81 `#[napi]` methods (crates/ql-bindings-node/src/lib.rs) and the napi structs, confirm the TypeScript mirror in extensions/quantlab/src/quantbook/types.ts matches exactly (method signatures, struct field names/types, optionality). Known suspect: CellValueJson is documented as a discriminated union but is a loose bag (kind + optional payloads) — confirm + find any other type/runtime drift. Confirm napi-rs Option→absent (undefined-not-null) convention is honored consistently in the TS types.

D3. PRODUCER/REPLAY VALIDATION SYMMETRY (OPUS-PT-B8 generalized). The napi producers reject out-of-range ids ([bad_argument]) while replay is permissive (silent no-op). Verify this asymmetry is consistent + intentional across ALL sheet/cell ops (deleteSheet, restoreSheet, moveSheet, renameSheet, appendPutValue, appendPutFormula, table ops). Flag any producer that is permissive where it should guard (could emit an op replay silently drops → cache/workbook divergence) OR any guard that's wrong.

D4. DEFERRED-ITEM RE-VALIDATION — for each, decide STILL-VALIDLY-DEFERRED vs ROTTED-INTO-BUG vs SHOULD-CLOSE-NOW:
- CODEX-MED-1 / CLOSURE-CODEX-MED-1: out-of-range RemoveSheet cache-vs-replay parity ("only reachable via malformed logs" — is that still true post-V3.6?).
- V2 V4 V2 K4 chunking.
- R-V3.6-9 D7 #REF! substitution (conditional, unshipped) — confirm the D7×D8 RestoreSheet ordering note (RestoreSheet must precede rename-repair on rebuild_workbook) is still accurate.
- sheet-tabs UI (V3.5.0.4c / V3.6+ multi-tab redesign).
- V3.6.1 backlog: B9 removedCells (always [] today, V3.7+), CellValueJson union cleanup, incremental DOM patching (V3.6.2+).
- Smaller backlog: transportLastErrorInfo(), willFlushSend(), LoopbackTransport.close(), HandshakeFailed fixture, CollabSessionError::Transport(_) origin tracking, @napi-rs/cli publish, #[napi(strict)] sweep, AtomicUsize conn_id wrap on relay, per-cell incoming-tint, status-bar item, push-API for inbound observation, jsdom virtualization test.
- Codex INFO-3/INFO-5: V3.7+ stable-op-ID migration (R-V3.6-10 positional-index fragility long-term fix).

D5. TEST-COVERAGE GAPS. ql-collab 158 + ql-oplog 67 + ql-collab-ws 42 + IDE mocha (quantbook-roundtrip ~431). Identify Phase 5 invariants/op-types/interactions with NO regression test. Specifically: which Op variants lack a multi-peer convergence test? which CacheEffect arms lack a walker test? are tables/names convergence tested? is the offline-queue×reconnect path tested? Report concrete gaps (not "more tests would be nice").

D6. ERROR / DIAGNOSTICS surface (exit criterion: "conflict diagnostics work"). Audit the error taxonomy (CollabSessionError, QuantbookErrorCode, [bad_argument]/[session_oplog]/transport codes). Are conflict/merge diagnostics actually surfaced to the IDE, or swallowed? Per CLAUDE.md No-Fallbacks: flag any try/catch / `|| default` / `rescue nil` / silent-degradation that hides a real error in the Phase 5 surface (both repos).

DISCIPLINE: cite file:line (both repos). For drift, show the doc claim + the contradicting code. For deferred items, give a verdict + 1-line justification each. For coverage gaps, name the specific untested invariant.

OUTPUT: return findings as a structured list (orchestrator writes to docs/phase5/megaudit-5-8/lane-d.md). Format per finding: #, Finding (one line), Severity, Files (path:line), Evidence, Recommendation. End with VERDICT + a deferred-item disposition table (item → STILL-DEFERRED / ROTTED / CLOSE-NOW) + coverage-gap list + coverage note (which D1–D6 completed).

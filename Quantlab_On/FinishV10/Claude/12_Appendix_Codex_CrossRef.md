# Appendix: Codex Findings Cross-Reference

This document provides a complete inventory of all Codex audit findings, their overlap with existing audit sources, new items discovered, and conflict resolutions.

---

## Codex Audit Overview

**Source**: `FinishV10/Codex/` directory, 10 files, 7 phases
**Files**:
- `00_MASTER_PLAN.md` -- High-level project plan
- `01_DEEP_AUDIT_FINDINGS.md` -- Technical findings by system layer
- `02_PHASE_0_ARCH_DECISIONS_AND_CONTRACTS.md` -- Architecture decisions
- `03_PHASE_1_IPC_TRANSPORT_AND_PROTOCOL.md` -- IPC implementation
- `04_PHASE_2_DAEMON_LIFECYCLE_AND_SAFETY.md` -- Daemon lifecycle
- `05_PHASE_3_EXTENSION_UI_AND_WORKFLOWS.md` -- Extension UI
- `06_PHASE_4_ENGINE_COMPLETENESS.md` -- Engine completeness
- `07_PHASE_5_TEST_QA_RELEASE.md` -- Testing and QA
- `08_PHASE_6_OPERATIONS_SECURITY_GOVERNANCE.md` -- Operations
- `09_FINDINGS_TO_PHASES_MAP.md` -- Findings to phases mapping

---

## Section 1: Overlap Analysis (Codex + Claude/ChatGPT)

These findings were identified by both Codex and our audits. Codex adds specificity in some cases.

| # | Codex Finding | Our Fix ID | Overlap Detail | Added Value from Codex |
|---|--------------|-----------|----------------|----------------------|
| 1 | Auth handshake mismatch | FIX-CGP-001 | Same issue | Codex specifies daemon requires explicit `authenticate` msg |
| 2 | Method name mismatch (pause/resume/stop) | FIX-CGP-002 | Same issue | Codex specifies daemon has `pause`; spec needs `session.pause` |
| 3 | Schema casing mismatch | FIX-CGP-003 | Same issue | Codex adds: daemon wraps responses in objects; extension expects raw arrays |
| 4 | Notifications missing `.update` suffix | FIX-CGP-005 | Same issue | Codex specifies: daemon emits `positions`; client listens `positions.update` |
| 5 | CLI entry point issues | FIX-CGP-006 | Same issue | Codex specifies `--symbol` vs `--symbols` mismatch |
| 6 | Token race condition | FIX-CGP-007 | Same analysis | No additional detail |
| 7 | Secrets flow not wired | FIX-CGP-008 | Same analysis | No additional detail |
| 8 | Trust not enforced | FIX-CGP-010 | Same analysis | No additional detail |
| 9 | Pre-trade not invoked | FIX-CGP-014 | Same analysis | No additional detail |
| 10 | Update gating | NEW-UI-004 | Same analysis | No additional detail |
| 11 | Windows transport | FIX-PL003 | Same analysis | No additional detail |
| 12 | Parquet loader | FIX-E001 | Same issue | Codex adds: no streaming/chunked reads for large data |
| 13 | Borrow fee intraday | NEW-ENG-009 | Same issue | Codex adds: proration not implemented for intraday bars |
| 14 | Debug mmap | FIX-CGP-017 | Same analysis | No additional detail |

**Conclusion**: 14 overlapping findings. Codex provides additional specificity for 6 of them, which has been incorporated into our fix descriptions.

---

## Section 2: New Findings from Codex (14 items)

These are genuine new issues discovered by Codex that were NOT in the Claude or ChatGPT audits.

| ID | Priority | Finding | Evidence | Phase Assignment |
|----|----------|---------|----------|-----------------|
| CODEX-001 | **P0** | **Socket path mismatch**: Daemon `~/.quantlab/sockets/` vs extension `~/.quantlab/sessions/` | `ipc.py:168` socket_dir = "sockets"; `SocketTransport.ts:79` uses "sessions" | Phase 0 |
| CODEX-002 | **P0** | **CLI flag mismatch**: Extension sends `--symbol`, daemon expects `--symbols` | `LiveDaemonManager.ts:285` buildDaemonArgs; `__main__.py` parse_args | Phase 0 |
| CODEX-003 | **P0** | **Readiness signal missing**: Extension waits for `DAEMON_READY` but daemon never prints it | `LiveDaemonManager.ts:160` waitForReady; grep main.py: 0 hits | Phase 0 |
| CODEX-004 | **P0** | **Session config incomplete**: Extension doesn't pass broker name; daemon requires it | `SessionManager.ts:1122` startDaemonSession; `main.py:84` SessionConfig | Phase 0 |
| CODEX-005 | **P1** | **Risk limit mapping wrong**: `dailyLossLimit` passed as `--max-exposure` | `SessionManager.ts:1162` | Phase 2 |
| CODEX-006 | **P0** | **Live trading bypasses daemon**: `startLiveSession` uses in-extension broker adapter, not daemon | `tradeCommands.ts:29` -> `SessionManager.startSession()` | Phase 0 |
| CODEX-007 | **P1** | **Kill switch bypasses daemon**: Uses broker adapter, not `DaemonClient.flattenPositions()` | `KillSwitch.ts:89` | Phase 1 |
| CODEX-008 | **P1** | **State snapshot dropped**: Daemon sends snapshot with id=null, client ignores it | `ipc.py:444`; `DaemonClient.ts:601` | Phase 0 |
| CODEX-009 | **P1** | **History search is a stub**: Command exists but shows info message instead of searching | `historyCommands.ts:42` | Phase 4 |
| CODEX-010 | **P1** | **readDebugFile command missing**: Extension calls it but command not registered | `DebuggerService.ts:351` | Phase 4 |
| CODEX-011 | **P1** | **JobRunner backtest-only**: optimize, Monte Carlo, WFA modes not implemented | `JobRunner.ts:26` | Phase 4 |
| CODEX-012 | **MEDIUM** | **CSV parsing blocks UI**: No worker isolation for large datasets | Extension host thread | Phase 4 |
| CODEX-013 | **MEDIUM** | **Bundled Python unused**: Extension always uses system Python | `EngineHost.ts:67` | Phase 7 |
| CODEX-014 | **P1** | **IPC tests mock wrong contract**: Tests use camelCase + `flatten.all`, not actual protocol | `daemon.integration.test.ts:113` | Phase 4 |

---

## Section 3: Conflict Analysis

Where Codex and Claude/ChatGPT disagree on approach, we document the resolution.

### Conflict 1: Schema Adapter Strategy

| Aspect | Claude/ChatGPT View | Codex View |
|--------|---------------------|------------|
| Approach | Add `SchemaAdapter` in TypeScript (FIX-CGP-003) | Create shared IPC schema package (npm + pip) |
| Timeline | Immediate fix | Long-term solution |

**Resolution**: Use both. Phase 0 implements the TypeScript `SchemaAdapter` for immediate compatibility. A shared schema package is a Phase 9 stretch goal. The `SchemaAdapter` acts as the boundary translator regardless.

### Conflict 2: Live Trading Path

| Aspect | Claude/ChatGPT View | Codex View |
|--------|---------------------|------------|
| Approach | Wire daemon into SessionManager | Must architecturally commit to daemon-first before wiring |
| Implication | Fix SessionManager.startSession() | Add CODEX-006 as architectural decision blocker |

**Resolution**: Codex is correct. The daemon-first architecture must be an explicit decision (Phase 0 Decision Gate). CODEX-006 is added as a P0 fix: `startLiveSession` must route through `startDaemonSession()`, never through in-extension broker adapter.

### Conflict 3: Notification Naming

| Aspect | Claude/ChatGPT View | Codex View |
|--------|---------------------|------------|
| Fix | Add `.update` suffix to daemon notifications | Normalize to canonical names in shared schema |

**Resolution**: Compatible approaches. Our fix (FIX-CGP-005) adds `.update` suffix in daemon broadcasts, which is the canonical name. Codex's shared schema would define these names. No conflict.

### Conflict 4: Kill Switch Routing

| Aspect | Claude/ChatGPT View | Codex View |
|--------|---------------------|------------|
| Status | Kill switch is implemented (found complete) | Kill switch bypasses daemon for daemon sessions |
| Analysis | KillSwitch.ts exists and works | Routes through in-extension broker adapter, not DaemonClient |

**Resolution**: Codex is correct. The kill switch exists but uses the wrong path for daemon sessions. Added as CODEX-007: kill switch must route through `DaemonClient.flattenPositions()` for daemon-managed sessions, falling back to direct broker only if daemon is unreachable.

---

## Section 4: Codex Architectural Recommendations

### Phase 0 Decision Gate (Adopted)

Codex recommends a "Phase 0" before implementation to lock architectural decisions:

1. **Daemon-first vs extension-first live trading** -> Decision: Daemon-first. All live trading goes through the Python daemon. Extension never directly talks to broker for live sessions.

2. **Canonical IPC schema** -> Decision: snake_case on the wire (Python authoritative). TypeScript `SchemaAdapter` converts at boundary. Long-term: shared npm+pip schema package.

3. **Canonical socket path** -> Decision: `~/.quantlab/sessions/{session_id}.sock` (extension convention). Daemon `ipc.py` must change from `~/.quantlab/sockets/`.

4. **Python bundling strategy** -> Decision: System Python for development, PyInstaller bundle for distribution. `EngineHost.ts` resolver chain already supports this with the bundled path check added in CODEX-013.

These decisions are incorporated into our Phase 0 as prerequisite requirements.

### Shared Schema Package (Deferred)

Codex recommends creating a shared IPC schema package that is published to both npm and PyPI, ensuring TypeScript and Python always agree on message shapes. This is a sound long-term recommendation but:

- **Phase 0**: We use `SchemaAdapter.ts` for immediate compatibility
- **Phase 9+**: Shared schema package can be created as a post-V10 improvement

---

## Section 5: Phase Assignment Summary

Every Codex finding is assigned to exactly one phase in our execution plan:

| Codex ID | Phase | Rationale |
|----------|-------|-----------|
| CODEX-001 | Phase 0 | Socket path is a P0 blocker for all IPC |
| CODEX-002 | Phase 0 | CLI flags are a P0 blocker for daemon startup |
| CODEX-003 | Phase 0 | Readiness signal is a P0 blocker for extension connection |
| CODEX-004 | Phase 0 | Session config is a P0 blocker for broker connection |
| CODEX-005 | Phase 2 | Risk limit semantics affect trading safety |
| CODEX-006 | Phase 0 | Architectural decision blocking live trading |
| CODEX-007 | Phase 1 | Kill switch routing is a security/safety issue |
| CODEX-008 | Phase 0 | State snapshot needed for initial sync |
| CODEX-009 | Phase 4 | UI feature (history search) |
| CODEX-010 | Phase 4 | UI feature (debug file command) |
| CODEX-011 | Phase 4 | UI feature (JobRunner modes) |
| CODEX-012 | Phase 4 | UI performance (CSV worker) |
| CODEX-013 | Phase 7 | Build/distribution feature |
| CODEX-014 | Phase 4 | Test quality (IPC contract) |

---

## Section 6: Codex File-by-File Summary

For reference, a summary of what each Codex document contains:

| File | Content | Key Findings Used |
|------|---------|-------------------|
| `00_MASTER_PLAN.md` | 6-phase execution plan, guiding principles | Daemon-first architecture decision |
| `01_DEEP_AUDIT_FINDINGS.md` | 10-layer technical audit | Socket path, CLI flags, readiness signal, safety bypass |
| `02_PHASE_0_ARCH_DECISIONS.md` | Architecture decisions and contracts | Schema strategy, socket path decision |
| `03_PHASE_1_IPC_TRANSPORT.md` | IPC implementation details | Auth handshake, state snapshot |
| `04_PHASE_2_DAEMON_LIFECYCLE.md` | Daemon lifecycle and safety | Kill switch routing, circuit breaker |
| `05_PHASE_3_EXTENSION_UI.md` | Extension UI and workflows | History search stub, debug command, JobRunner |
| `06_PHASE_4_ENGINE.md` | Engine completeness | Parquet streaming, borrow fee proration |
| `07_PHASE_5_TEST_QA.md` | Testing and QA | IPC test contract mismatch |
| `08_PHASE_6_OPERATIONS.md` | Operations and security | CSV worker isolation, Python bundling |
| `09_FINDINGS_TO_PHASES_MAP.md` | Cross-reference mapping | Used for phase assignment validation |

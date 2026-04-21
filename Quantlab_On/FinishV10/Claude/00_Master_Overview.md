# FinishV10 Master Overview

**Date**: 2026-01-29
**Total Fixes**: 119 across 10 phases
**Sources**: Claude audit (67 FIX-*), ChatGPT audit (17 FIX-CGP-*), Codex audit (14 CODEX-*), New deep audit (21 NEW-*)

---

## Executive Summary

This document consolidates ALL gaps discovered across five independent audit sources into a single phased execution plan for completing Quantlab V10. The gaps span from critical IPC mismatches that prevent basic daemon communication to polish items like documentation.

### Critical Correction

The interim audits claim "0% TypeScript implemented" -- this is **wrong**. The extension has:
- 56 registered commands
- 4 custom editor views (chart, action, trade, AI panel)
- Full IPC client (`DaemonClient.ts`, 728 lines)
- Session management (`SessionManager.ts`, 1628 lines)
- Trust model (`TrustManager.ts`, 644 lines with SHA-256 verification)
- Pre-trade checklist (`PreTradeChecklist.ts`, 353 lines with 6 validation checks)
- Kill switch (`KillSwitch.ts`, 114 lines with configurable policies)
- Time-travel debugger (`DebuggerService.ts`, 401 lines)
- Socket transport (`SocketTransport.ts`, 336 lines)
- Live daemon manager (`LiveDaemonManager.ts`, 407 lines)

The gaps are about **wiring and integration**, not missing components.

---

## Dependency Graph

```
Phase 0 (IPC Integration)
    |
    +---> Phase 1 (Security) ---> Phase 2 (Risk) ---> Phase 5 (Trading Features)
    |                                                  |
    |                                                  +---> Phase 4 (UI Wiring)
    |
    +---> Phase 3 (Engine Correctness) ---> Phase 8 (Testing)
    |
    +---> Phase 6 (Charts) [independent]
    |
    +---> Phase 7 (Platform) [independent]
    |
    +---> Phase 9 (Documentation) [last]
```

**Critical path**: Phase 0 -> Phase 1 -> Phase 2 -> Phases 4+5 (parallel) -> Phase 8 -> Phase 9

**Independent tracks** (can run in parallel with critical path):
- Phase 3 (Engine Correctness) -- affects backtest accuracy, not live trading
- Phase 6 (Charts) -- affects visualization, not trading logic
- Phase 7 (Platform) -- only needed for Windows release

---

## Phase Summary

| Phase | Name | Fixes | P0 | P1 | P2 | P3 | Blocks |
|-------|------|-------|----|----|----|----|--------|
| 0 | IPC Integration | 19 | 12 | 4 | 3 | 0 | Everything |
| 1 | Security & Secrets | 10 | 2 | 8 | 0 | 0 | Live trading |
| 2 | Risk & Safety | 11 | 2 | 8 | 1 | 0 | Live trading |
| 3 | Engine Correctness | 16 | 0 | 8 | 5 | 3 | Backtest accuracy |
| 4 | UI Wiring | 17 | 0 | 11 | 5 | 1 | UI integration |
| 5 | Trading Features | 11 | 1 | 6 | 4 | 0 | Live features |
| 6 | Charts Fixes | 8 | 0 | 3 | 4 | 1 | Visualization |
| 7 | Platform & Build | 7 | 1 | 3 | 1 | 2 | Windows release |
| 8 | Testing & CI | 14 | 0 | 7 | 5 | 2 | Quality gates |
| 9 | Documentation | 6 | 0 | 1 | 3 | 2 | Polish |
| **Total** | | **119** | **18** | **59** | **31** | **11** | |

---

## Phase 0 Decision Gate (from Codex)

Before implementation begins, these architectural decisions must be locked:

1. **Daemon-first architecture**: All live trading goes through the Python daemon. The extension never talks directly to a broker for live sessions. This means `tradeCommands.ts:29` (startLiveSession) must route through `SessionManager.startDaemonSession()`, not `startSession()` with an in-extension broker adapter.

2. **Canonical IPC schema**: snake_case on the wire (Python daemon is authoritative). A `SchemaAdapter` in TypeScript converts to/from camelCase at the boundary. Long-term: shared schema package.

3. **Canonical socket path**: `~/.quantlab/sessions/{session_id}.sock` (extension convention wins; daemon `ipc.py:168` must change from `~/.quantlab/sockets/`).

4. **Python bundling strategy**: For development, use system Python. For distribution, bundle via PyInstaller/PyOxidizer. `EngineHost.ts:67` resolver chain already supports this.

---

## Source Audit Statistics

| Source | Document | Fixes Found | Fixes Included | Notes |
|--------|----------|-------------|----------------|-------|
| Claude interim | 91 gaps, 67 fix IDs | 67 | 67 | FIX-D, FIX-B, FIX-P, FIX-R, FIX-T, FIX-E, FIX-PL, FIX-CI, FIX-TEST |
| ChatGPT interim | 20 gaps | 17 | 17 | FIX-CGP-001 through FIX-CGP-017 |
| Codex audit | 10 files, 7 phases | 14 new | 14 | CODEX-001 through CODEX-014 |
| New deep audit | 15 core files + extensions + charts | 21 new | 21 | NEW-* IDs |

---

## Key File References

### Python Engine (engine/quantlab/)
| File | Lines | Role |
|------|-------|------|
| `daemon/ipc.py` | 869 | IPC server, token auth, broadcast, negotiate |
| `daemon/main.py` | 2168 | Live trading daemon, IPC handlers, risk integration |
| `daemon/__main__.py` | 321 | CLI entry point (start/status/stop) |
| `daemon/lifecycle.py` | 442 | PID files, daemonization, signal handling |
| `backtest/core.py` | 1256 | Backtest engine, fill logic, equity tracking |
| `risk/exposure.py` | 644 | Exposure reservation model |

### TypeScript Extension (extensions/quantlab/src/)
| File | Lines | Role |
|------|-------|------|
| `extension.ts` | 210 | Main entry point, activation |
| `core/trading/DaemonClient.ts` | 728 | IPC client, JSON-RPC, reconnection |
| `core/trading/SessionManager.ts` | 1628 | Session lifecycle, daemon sessions |
| `core/trading/LiveDaemonManager.ts` | 407 | Daemon process spawning |
| `core/ipc/SocketTransport.ts` | 336 | Socket connection, framing |
| `core/trust/TrustManager.ts` | 644 | Workspace/strategy trust, SHA-256 |
| `ui/dialogs/PreTradeChecklist.ts` | 353 | Pre-trade validation |
| `views/trade/KillSwitch.ts` | 114 | Emergency stop |
| `views/chart/DebuggerService.ts` | 401 | Time-travel debugger |
| `core/engine/JobRunner.ts` | 295 | Backtest job execution |
| `core/engine/EngineHost.ts` | 95 | Engine host, Python path resolution |
| `commands/tradeCommands.ts` | 196 | Trade command registration |
| `commands/historyCommands.ts` | 50 | History command stubs |

### Charts (Charts/packages/)
| File | Lines | Role |
|------|-------|------|
| `chart-core/src/render-pipeline.ts` | 66 | Render pipeline, data-layer bug |
| `chart-render-canvas2d/src/drawing-plugin.ts` | 7000+ | Drawing tools, Math.random IDs |
| `chart-render-canvas2d/src/renderer.ts` | 286 | Canvas2D renderer stubs |
| `chart-text/src/msdf-atlas.ts` | 223 | MSDF text atlas stubs |
| `chart-render-webgpu/src/renderer.ts` | 1148 | WebGPU renderer, commented renderers |
| `chart-trading/src/trading-overlay.ts` | 196 | Trading overlay, `any` types |
| `chart-drawings/src/drawing-manager.ts` | 347 | Drawing manager |
| `chart-core/src/error-handler.ts` | 169 | Error handler, telemetry |

---

## Verification Plan

After all phases complete:

1. **IPC smoke test**: Launch daemon from extension, submit mock order, receive fill notification
2. **Auth flow**: Extension connects with token, negotiate + auth handshake succeeds
3. **Security**: `grep -r "os.environ.*ALPACA" engine/` returns 0 hits in credential paths
4. **Risk**: Configure 2% daily loss -> daemon receives and enforces percentage-based limit
5. **Backtest golden tests**: `pytest engine/tests/golden/ -v` -- all G001-G105 pass
6. **Stop gap test**: Run golden test with overnight gap -> fill at open price, not stop price
7. **Charts**: Open chart view -> candles render (no undefined context errors)
8. **Live trading test**: `pytest engine/tests/live/ -v` -- all L001-L070 pass against mock broker
9. **Extension unit tests**: `npm run test` in extensions/quantlab/ -- all pass
10. **CI pipeline**: All workflows pass on push

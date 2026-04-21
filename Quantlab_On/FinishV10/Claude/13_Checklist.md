# FinishV10 Implementation Checklist

**Total: 119 fixes across 10 phases**
**Date**: 2026-01-29

---

## Phase 0: IPC Integration (19 fixes) -- BLOCKS EVERYTHING

- [x] CODEX-001 [P0]: Fix socket path mismatch (sockets/ -> sessions/)
- [x] CODEX-002 [P0]: Fix CLI flag --symbol -> --symbols, add --broker
- [x] CODEX-003 [P0]: Add DAEMON_READY stdout signal + socket health fallback
- [x] CODEX-004 [P0]: Pass broker name and symbol list in session config
- [x] CODEX-006 [P0]: Route live trading through daemon (not in-extension broker)
- [x] FIX-CGP-006 [P0]: Create/fix daemon __main__.py CLI entry point (already done)
- [x] FIX-CGP-001 [P0]: Add auth handshake after negotiate
- [x] FIX-CGP-002 [P0]: Standardize IPC method names to session.*, order.*, etc. (already done)
- [x] FIX-CGP-003 [P0]: Add camelCase <-> snake_case SchemaAdapter
- [x] FIX-CGP-004 [P0]: Add positions.get, orders.get, fills.get handlers (already done)
- [x] FIX-CGP-005 [P0]: Add *.update notification suffixes (already done)
- [x] FIX-P001 [P0]: Register missing IPC message types (already done)
- [x] CODEX-008 [P1]: Handle IPC state snapshot after auth (id=null)
- [x] FIX-CGP-007 [P1]: Fix token ownership race (poll for token file)
- [x] FIX-P003 [P1]: Compute fresh state snapshot on reconnect (already done)
- [x] NEW-IPC-001 [P1]: Add _meta.sequence consumption in DaemonClient
- [x] FIX-P005 [P2]: Fix version negotiation (pick highest mutual) (already done)
- [x] FIX-P004 [P2]: Replace magic error numbers with ErrorCode enum
- [x] FIX-D008 [P2]: Fix broadcast dict-during-iteration race (already done)

---

## Phase 1: Security & Secrets (10 fixes) -- BLOCKS LIVE TRADING

- [x] FIX-D001 [P0]: Change token log from INFO to DEBUG, remove file path (already done)
- [x] FIX-D002 [P0]: Fix devnull FD leak on Unix fork (already done)
- [x] FIX-CGP-008 [P1]: Wire secrets flow end-to-end (credentials.set IPC)
- [x] FIX-CGP-009 [P1]: Wire MasterKeyPrompt into credential setup
- [x] FIX-CGP-010 [P0]: Gate session start with TrustManager verification
- [x] CODEX-007 [P1]: Route kill switch through DaemonClient for daemon sessions
- [x] NEW-SEC-001 [P1]: Remove os.environ fallback in _connect_broker
- [x] NEW-SEC-002 [P1]: Wire log_order_submit/fill/cancel/reject into trading path (already done)
- [x] NEW-SEC-003 [P1]: Trust storage per-workspace, not global
- [x] NEW-SEC-004 [P1]: Extension update trust revocation

---

## Phase 2: Risk & Safety (11 fixes) -- BLOCKS LIVE TRADING

- [x] FIX-R001 [P0]: Verify exposure cleanup loop starts (already done — main.py:347)
- [x] FIX-R002 [P1]: Integrate ConsecutiveLossTracker with daemon (already done — CircuitBreakerRiskManager)
- [x] FIX-R003 [P1]: Complete circuit breaker integration (block, cancel, flatten, notify, log)
- [x] FIX-R004 [P1]: Fix position limits equity calculation for position flips (already done — limits.py:check_order)
- [x] FIX-R005 [P2]: Expose exposure metrics for monitoring
- [x] FIX-CGP-011 [P1]: Update risk limit defaults to match Decision L74 (2%/5%/3)
- [x] FIX-CGP-012 [P1]: Propagate risk limits from extension to daemon CLI (already done — Phase 0)
- [x] CODEX-005 [P1]: Fix risk limit mapping (dailyLossLimit != max-exposure) (already done — Phase 0)
- [x] FIX-T001-TRADING [P0]: Wire emergency flatten audit logging
- [x] NEW-RISK-001 [P1]: Expose consecutive loss limit in UI settings
- [x] NEW-RISK-002 [HIGH]: Fix exposure reservation age metrics null check

---

## Phase 3: Engine Correctness (16 fixes) -- Backtest Accuracy

- [x] NEW-ENG-001 [HIGH]: Fix stop/stop-limit overnight gap fill behavior (already done — core.py:816-824)
- [x] NEW-ENG-002 [HIGH]: Implement partial fill requeue for GTC + IOC cancellation (already done — core.py:654-694)
- [x] NEW-ENG-003 [HIGH]: Add multi-asset temporal alignment validation
- [x] NEW-ENG-004 [HIGH]: Implement forward-fill detection (spec S3.7)
- [x] NEW-ENG-005 [HIGH]: Integrate market calendar with data loader
- [x] NEW-ENG-006 [HIGH]: Add decimal precision quantization for dollar amounts
- [x] NEW-ENG-007 [MEDIUM]: Add equity curve negative value protection / margin call
- [x] NEW-ENG-008 [MEDIUM]: Improve zero-volume bar handling
- [x] NEW-ENG-009 [MEDIUM]: Fix borrow fee edge case (can drive cash negative)
- [x] NEW-ENG-010 [MEDIUM]: Fix backtest error return (equity includes positions MTM)
- [x] NEW-ENG-011 [MEDIUM]: Fix collateral calculation missing price validation
- [x] FIX-E001 [P1]: Implement Parquet data loader (already done — parquet_loader.py)
- [x] FIX-E002 [P1]: Add strategy validation before backtest run (already done — api/validation.py)
- [x] FIX-E003 [P2]: Centralize annualization factor (252/365/custom) (already done — metrics/annualize.py)
- [x] FIX-E005 [P2]: Support custom metrics registration (already done — metrics/__init__.py)
- [x] FIX-E006 [P3]: Expose DataRev chain verification (already done — data/rev.py:651)

---

## Phase 4: UI Wiring & Recovery (17 fixes)

- [x] FIX-CGP-014 [P1]: Invoke PreTradeChecklist from SessionManager.startSession()
- [x] FIX-CGP-015 [P1]: Wire RecoveryDialog on startup for orphaned sessions
- [x] FIX-CGP-013 [P1]: Create first-run risk configuration wizard
- [x] FIX-CGP-016 [P1]: Implement connection-loss UI banner and dialog
- [x] NEW-UI-001 [P1]: Wire risk disclosure dialog
- [x] NEW-UI-002 [P1]: Implement strategy hot-reload flow
- [x] CODEX-009 [P1]: Implement history search (currently a stub)
- [x] CODEX-010 [P1]: Implement quantlab.engine.readDebugFile command
- [x] CODEX-011 [P1]: Implement optimize, Monte Carlo, WFA modes in JobRunner
- [x] CODEX-014 [P1]: Fix IPC integration tests to use real daemon contract
- [x] NEW-UI-003 [MEDIUM]: Implement system tray integration
- [x] NEW-UI-004 [MEDIUM]: Wire update gating during active sessions
- [x] NEW-UI-005 [MEDIUM]: Implement reconciliation panel in Trade view
- [x] CODEX-012 [MEDIUM]: Move CSV parsing to worker thread
- [x] BACKTEST-FIX [P1]: Implement data source dropdown (type system + existing UI)
- [x] NEW-UI-006 [MEDIUM]: Wire AI Panel with input sanitization (already done — ai/sanitize.ts)
- [x] NEW-UI-007 [LOW]: Add WCAG 2.1 AA compliance verification tests

---

## Phase 5: Trading Features (11 fixes)

- [x] FIX-T002-TRADING [P0]: Implement Alpaca WebSocket streaming
- [x] FIX-D003 [P1]: Add order.modify IPC handler
- [x] FIX-D004 [P1]: Integrate market calendar for ACTIVE <-> MARKET_CLOSED
- [x] FIX-T003 [P1]: Make reconciliation interval configurable
- [x] FIX-T004 [P1]: Wire drift detection IPC notifications
- [x] FIX-T005 [P1]: Implement fill reconciliation auto-correct
- [x] FIX-T006 [P2]: Add session ledger JSON/CSV export
- [x] FIX-D005 [P1]: Improve Linux power handler (D-Bus)
- [x] FIX-D006 [P1]: Fix checkpoint directory fsync for non-Linux
- [x] NEW-TRADE-001 [MEDIUM]: Escalate broker reconnect after max retries
- [x] NEW-TRADE-002 [MEDIUM]: Add IPC rate limiting

---

## Phase 6: Charts Fixes (8 fixes)

- [x] NEW-CH-001 [HIGH]: Fix RenderPipeline data-layer attribute never set
- [x] NEW-CH-002 [HIGH]: Replace Math.random() with deterministic ID generation
- [x] NEW-CH-003 [HIGH]: Implement Canvas2D renderer stubs (rendering + PNG export)
- [x] NEW-CH-004 [MEDIUM]: Complete MSDF text atlas loading and rendering
- [x] NEW-CH-005 [MEDIUM]: Complete WebGPU indicator/drawing renderers
- [x] NEW-CH-006 [MEDIUM]: Replace `any` types with proper interfaces (15+ files)
- [x] NEW-CH-007 [MEDIUM]: Fix DrawingManager missing DrawingStyle interface
- [x] NEW-CH-008 [LOW]: Require explicit telemetry consent in error handler

---

## Phase 7: Platform & Build (7 fixes)

- [x] FIX-PL001 [P0]: Windows fcntl -> msvcrt file locking
- [x] FIX-PL002 [P1]: Windows daemonization (CREATE_NO_WINDOW)
- [x] FIX-PL003 [P1]: Windows named pipe transport
- [x] FIX-PL004 [P1]: Cross-platform signal handling
- [x] NEW-BUILD-001 [MAJOR]: Create per-OS build scripts (NSIS/DMG/AppImage)
- [x] NEW-BUILD-002 [MAJOR]: Python engine bundling for distribution
- [x] CODEX-013 [MEDIUM]: Wire bundled Python in EngineHost

---

## Phase 8: Testing & CI (14 fixes)

- [x] FIX-TEST-001 [P1]: Implement live trading test suite (L001-L070)
- [x] FIX-TEST-002 [P1]: Verify golden test pass/fail status
- [x] FIX-TEST-003 [P1]: Enhance mock broker fixture
- [x] FIX-TEST-004 [P2]: Implement chaos/failure tests
- [x] FIX-TEST-005 [P2]: Configure coverage reporting
- [x] FIX-B001 [P1]: Wire benchmark strategies to actual BacktestEngine
- [x] FIX-B002 [P1]: Add benchmark data generation to CI
- [x] FIX-B003 [P1]: Implement git-based baseline comparison
- [x] FIX-B004 [P2]: Fix benchmark module exports
- [x] FIX-CI001 [P1]: Create engine PR validation workflow
- [x] FIX-CI002 [P1]: Implement benchmark regression check
- [x] FIX-CI003 [P2]: Create security scanning workflow
- [x] FIX-CI004 [P2]: Implement memory profiling job
- [x] FIX-CGP-017 [P2]: Implement debug mmap reader for O(1) bar access

---

## Phase 9: Documentation & Polish (6 fixes)

- [x] FIX-D007 [P2]: Fix watchdog alert callback (async support)
- [x] FIX-P002 [P1]: Verify reliability manager tracks all critical message types
- [x] FIX-E004 [P2]: Document float conversion points in metrics
- [x] FIX-B005 [P2]: Add strategies directory __init__.py
- [x] FIX-B006 [P3]: Add --strategy CLI flag to benchmark runner
- [x] FIX-TEST-006 [P3]: Write test suite documentation

---

## Progress Summary

| Phase | Total | Done | Remaining |
|-------|-------|------|-----------|
| Phase 0: IPC | 19 | 19 | 0 |
| Phase 1: Security | 10 | 10 | 0 |
| Phase 2: Risk | 11 | 11 | 0 |
| Phase 3: Engine | 16 | 16 | 0 |
| Phase 4: UI | 17 | 17 | 0 |
| Phase 5: Trading | 11 | 11 | 0 |
| Phase 6: Charts | 8 | 8 | 0 |
| Phase 7: Platform | 7 | 7 | 0 |
| Phase 8: Testing | 14 | 14 | 0 |
| Phase 9: Docs | 6 | 6 | 0 |
| **TOTAL** | **119** | **119** | **0** |

**Overall Progress**: 119/119 (100%)

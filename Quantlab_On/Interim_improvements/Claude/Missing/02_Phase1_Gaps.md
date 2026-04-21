# Phase 1: Critical Infrastructure - Missing Gaps

**Plan Document**: `02_Phase_1_Critical_Infrastructure.md`
**Duration**: 5 weeks (per plan)

---

## 1. Daemon Architecture

### GAP-P1-001: TypeScript DaemonClient Not Implemented
- **Severity**: CRITICAL
- **Description**: Plan specifies `extensions/quantlab/src/core/trading/DaemonClient.ts` with `connect()`, `reconnect()`, `sendCommand()`, `onStateChange()`, `health()`, `disconnect()` methods. This file does not exist.
- **Impact**: No UI can communicate with the running daemon. The entire UI-to-daemon bridge is missing.
- **Plan Reference**: Phase 1 §1.2, §1.7

### GAP-P1-002: TypeScript SessionManager Not Updated
- **Severity**: CRITICAL
- **Description**: Plan specifies updating `extensions/quantlab/src/core/trading/SessionManager.ts` for daemon integration. This has not been done.
- **Impact**: Live sessions cannot be started from the UI.
- **Plan Reference**: Phase 1 §1.2

### GAP-P1-003: Daemon Market Hours State Transitions Incomplete
- **Severity**: Major
- **Description**: Plan §1.11 specifies daemon states (ACTIVE, PAUSED, MARKET_CLOSED) with automatic market hours transitions. While `DaemonState` enum exists in `lifecycle.py`, the automatic transition between ACTIVE and MARKET_CLOSED based on market calendar is not wired in `daemon/main.py`.
- **Current state**: `main.py` has state tracking but no automatic calendar-based transitions.
- **What's needed**: Integration between `calendar/` module and daemon state machine.

### GAP-P1-004: Daemon Concurrent Session Limit Not Enforced
- **Severity**: Major
- **Description**: Plan §1.2 mentions concurrent session limits. While PID files prevent the same session from running twice, there's no enforcement of a maximum number of concurrent sessions (e.g., max 3 live sessions).
- **What exists**: PID file locking per session.
- **What's missing**: Global session count enforcement.

---

## 2. Exposure Reservation Model

### GAP-P1-005: TypeScript ExposureManager Not Implemented
- **Severity**: CRITICAL
- **Description**: Plan §2.1.1 explicitly requires DUAL implementation - Python (authoritative) AND TypeScript (advisory). Only the Python side exists at `engine/risk/exposure.py`.
- **Missing file**: `extensions/quantlab/src/core/risk/ExposureManager.ts`
- **Impact**: UI cannot provide early feedback on exposure limits before orders reach daemon.
- **Plan Reference**: Phase 1 §2.1.1, §2.2

### GAP-P1-006: Exposure Timeout Cleanup Not Implemented
- **Severity**: Major
- **Description**: Plan §2.5 specifies "Timeout cleanup runs every 30 seconds" to release stale reservations. The `ExposureManager` in `exposure.py` has reservation tracking but no automatic timeout/cleanup loop.
- **What's needed**: Background task that periodically checks for reservations older than threshold and releases them.

### GAP-P1-007: Exposure Metrics Not Exposed
- **Severity**: Minor
- **Description**: Plan §2.5 acceptance criteria states "Reservation metrics exposed for monitoring". No metrics endpoint or reporting exists for exposure reservation state.

---

## 3. Secrets Encrypted Fallback

### GAP-P1-008: TypeScript Secrets Backend Not Implemented
- **Severity**: CRITICAL
- **Description**: Plan §3.2 specifies TypeScript implementations:
  - `extensions/quantlab/src/core/secrets/backend.ts`
  - `extensions/quantlab/src/core/secrets/encrypted.ts`
  - `extensions/quantlab/src/ui/MasterKeyPrompt.ts`
  - `extensions/quantlab/src/core/secrets/migration.ts`
  - `extensions/quantlab/src/core/secrets/rotation.ts`
  None of these exist.
- **Impact**: No UI for master key entry, no migration from keychain, no password change UI.

### GAP-P1-009: CLI `quantlab secrets init` Not Implemented
- **Severity**: Major
- **Description**: Plan §3.2 specifies `cli/src/commands/secrets.rs` for CLI-based secrets initialization. The Rust CLI module does not contain this command.
- **Impact**: Cannot initialize secrets from command line on headless systems.

### GAP-P1-010: Key Rotation Workflow Missing
- **Severity**: Major
- **Description**: Plan §3.7 specifies a "Change Master Password" workflow with re-encryption, atomic file replacement, and memory clearing. The Python `encrypted.py` has basic encrypt/decrypt but no rotation workflow.
- **Missing**: `rotate_master_key()`, atomic re-encryption, old key memory clearing.

### GAP-P1-011: Failed Unlock Backoff/Lockout Incomplete
- **Severity**: Major
- **Description**: Plan §3.5 specifies "Exponential backoff on failed unlock" (test S005) and "Lockout after 10 failures" (test S006). Need to verify if `encrypted.py` implements these.
- **What's needed**: Backoff timer and failure counter with lockout.

---

## 4. Structured Logging

### GAP-P1-012: Audit Log 7-Year Retention Not Enforced
- **Severity**: Major
- **Description**: Plan §5.1 specifies `audit.log` with 7-year retention and "never rotated". While `logging/audit.py` exists with append-only semantics, there's no enforcement mechanism for 7-year retention or archival.
- **What's needed**: Retention policy metadata, archival mechanism, warning when disk space is low.

---

## 5. Benchmark Harness

### GAP-P1-013: Benchmark Strategies Are Dead Code
- **Severity**: Major
- **Description**: Four benchmark strategy files exist (`sma_crossover.py`, `rsi_macd.py`, `momentum.py`, `rotation.py`) but use a high-level `ql.param()`/`ql.Signals()` API that is NOT wired into the benchmark runner. The runner hardcodes an inline `BenchmarkStrategyAdapter` with simple SMA logic.
- **Impact**: All 4 benchmarks run the same strategy. The RSI+MACD, Momentum, and Rotation benchmarks do not test their named strategies.
- **What's needed**: Either wire the strategy files to the runner, or rewrite the strategies using the actual engine API.

### GAP-P1-014: Benchmark Data Files Not Generated
- **Severity**: Major
- **Description**: `benchmarks/data/generate_data.py` exists to create CSV files, but the actual CSV files (`bench_small.csv`, `bench_medium.csv`, `bench_large.csv`, `bench_multi.csv`) do not exist on disk.
- **Impact**: Running benchmarks fails with "Data file not found".
- **Resolution**: Run `python -m benchmarks.data.generate_data` or add to CI setup step.

### GAP-P1-015: Git-Based Baseline Fetching Not Implemented
- **Severity**: Major
- **Description**: `benchmarks/check.py` line 123 has an explicit `TODO` - passing a git ref (e.g., `main`) as `--baseline` fails because git-based result fetching is not implemented.
- **Impact**: CI cannot compare against main branch baseline.

### GAP-P1-016: CI Regression Check Is Placeholder
- **Severity**: Major
- **Description**: `.github/workflows/engine-benchmark.yml` lines 53-57 contain:
  ```yaml
  echo "Benchmark regression check placeholder"
  echo "TODO: Implement baseline comparison"
  ```
- **Impact**: CI never actually checks for performance regressions.

### GAP-P1-017: CI Memory Profiling Is Placeholder
- **Severity**: Minor
- **Description**: The `memory-profile` job in `engine-benchmark.yml` is entirely a placeholder with TODO comments.
- **Impact**: No automated memory regression detection.

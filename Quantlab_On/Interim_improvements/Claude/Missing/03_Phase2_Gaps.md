# Phase 2: Core Engine - Missing Gaps

**Plan Document**: `03_Phase_2_Core_Engine.md`
**Duration**: 8 weeks (per plan)

---

## Overview

Phase 2 is the most complete phase. The Python engine has implementations for all major components specified in the plan. However, several secondary features and integration points are missing.

---

## 1. Backtest Engine

### GAP-P2-001: Parquet Data Loader Not Implemented
- **Severity**: Major
- **Description**: Plan specifies Parquet as the primary high-performance data format alongside CSV. The engine only has CSV loading (`backtest/bar.py` CSVLoader). No Parquet reader exists.
- **Impact**: Cannot use Apache Parquet files for large datasets. Performance limited to CSV parsing.
- **What's needed**: `data/parquet_loader.py` using `pyarrow.parquet`.

### GAP-P2-002: Data Provider Streaming Not Implemented
- **Severity**: Major
- **Description**: Plan specifies real-time data streaming from providers (Alpaca WebSocket). The `providers/alpaca.py` implements REST API polling but no WebSocket streaming.
- **What exists**: REST-based bar fetching, account info, order management.
- **What's missing**: WebSocket market data subscription, real-time bar assembly.

### GAP-P2-003: Corporate Actions Handler Incomplete
- **Severity**: Minor
- **Description**: `data/corporate_actions.py` exists but needs verification that it handles all corporate action types: splits, dividends, mergers, spin-offs. Plan references corporate actions in data provenance.
- **What's needed**: Verification and completion of edge cases.

---

## 2. Order Type Simulation

### GAP-P2-004: FOK (Fill-or-Kill) TIF Not Implemented
- **Severity**: Minor
- **Description**: Golden test N012 references FOK (Fill-or-Kill) order rejection. The `orders/tif.py` implements GTC, DAY/GFD, IOC but FOK may not be fully wired.
- **What's needed**: Verify FOK TIF in order processing pipeline.

### GAP-P2-005: Order Modification (Amend) Not Implemented
- **Severity**: Major
- **Description**: Plan specifies `order.modify` as a Critical IPC message type (Appendix_B §Message Catalog). The daemon `main.py` registers handlers for `order.submit` and `order.cancel` but NOT `order.modify`.
- **What's missing**: Order amendment handler in daemon and engine.
- **Impact**: Cannot modify pending orders (e.g., change limit price). Must cancel and resubmit.

---

## 3. Strategy API

### GAP-P2-006: API Versioning Not Implemented
- **Severity**: Minor
- **Description**: Plan §18 specifies API versioning with deprecation notices. No version markers or compatibility layer exists.
- **What's needed**: Version annotation for strategy API methods, deprecation decorator.

### GAP-P2-007: Strategy Validation Before Run Not Implemented
- **Severity**: Minor
- **Description**: Plan specifies pre-run strategy validation (syntax check, import verification, parameter validation). No validation step exists before `BacktestEngine.run()`.
- **What's needed**: Strategy validation function that checks for common errors before execution.

---

## 4. Data Provenance (DataRev)

### GAP-P2-008: DataRev Blockchain-Style Chaining Not Verified
- **Severity**: Minor
- **Description**: Plan specifies DataRev hashes should chain (each rev references parent hash). `data/rev.py` implements hashing but chain verification needs confirmation.
- **What's needed**: Verify `DataRevision.parent_hash` is properly maintained and validated.

---

## 5. Feature Store

### GAP-P2-009: Feature Dependency Graph Visualization Not Implemented
- **Severity**: Minor
- **Description**: Plan mentions feature dependency tracking. `features/dependencies.py` exists but no visualization or reporting of the dependency graph.
- **Impact**: Debugging feature calculation order is difficult.

---

## 6. Metrics Dictionary

### GAP-P2-010: Some Metrics May Use Float Instead of Decimal
- **Severity**: Major
- **Description**: Plan mandates Decimal precision throughout. Some metrics calculations in `metrics/` may perform intermediate calculations in float (e.g., `math.sqrt()`) then convert back. This is technically correct for statistics but should be documented.
- **What's needed**: Audit all metrics for float usage and document precision guarantees.

### GAP-P2-011: Custom Metrics Registration Not Implemented
- **Severity**: Minor
- **Description**: Plan mentions extensible metrics. No mechanism exists for users to register custom metrics functions.
- **What's needed**: `metrics.register_custom()` function.

---

## 7. Memory Management

### GAP-P2-012: Concurrent Backtest Memory Isolation Not Verified
- **Severity**: Major
- **Description**: Plan §14 specifies concurrent backtests with memory isolation. `runtime/memory.py` has memory monitoring but it's unclear if concurrent backtest runs properly isolate their memory.
- **What's needed**: Integration test verifying two concurrent backtests don't interfere.

---

## 8. Error Reporting

### GAP-P2-013: Error Telemetry Not Implemented
- **Severity**: Minor
- **Description**: Plan mentions error telemetry for product improvement. While `errors/taxonomy.py` provides structured errors, no telemetry collection or opt-in reporting exists.
- **What's needed**: Optional error telemetry with user consent.

---

## 9. Protocol/IPC Messages

### GAP-P2-014: Several IPC Message Types Not Implemented
- **Severity**: Major
- **Description**: Appendix_B IPC Protocol specifies these message types that appear missing from the daemon handler registration:
  - `performance.update` - Performance metrics streaming
  - `activity.update` - Strategy activity feed
  - `connection.status` - Broker connection state changes
  - `error.state` - Error state notifications
  - `debug.snapshot` - Debug data streaming
- **What exists**: `session.start/stop/pause/resume`, `order.submit/cancel`, `flatten.request`, heartbeat, `positions.update`, `orders.update`, `fills.update`
- **Impact**: UI cannot receive real-time performance updates, activity feed, or connection status changes.

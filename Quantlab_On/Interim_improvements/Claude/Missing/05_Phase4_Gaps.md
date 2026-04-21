# Phase 4: Live Trading - Missing Gaps

**Plan Document**: `05_Phase_4_Live_Trading.md`
**Duration**: 6 weeks (per plan)

---

## Overview

Phase 4 Python implementation is largely complete. The gaps are primarily in:
1. TypeScript UI components for live trading
2. Edge case handling in existing Python code
3. Complete broker adapter implementation

---

## 1. Emergency Flatten Protocol

### GAP-P4-001: Emergency Flatten UI Not Implemented
- **Severity**: CRITICAL
- **Description**: Plan §1 specifies a panic button in the UI that triggers emergency flatten. While `trading/emergency.py` implements the Python flatten logic (cancel all orders, close all positions), no UI trigger exists.
- **Missing**: TypeScript emergency flatten button, confirmation dialog, keyboard shortcut (Ctrl+Shift+F per plan).
- **Impact**: Cannot trigger emergency flatten from UI. Must use IPC directly.

### GAP-P4-002: Emergency Flatten Audit Trail
- **Severity**: Major
- **Description**: Plan specifies emergency flatten events must be logged to tamper-evident audit log with reason, who triggered it, and full position snapshot. Need to verify `audit/ledger.py` integration.
- **What's needed**: Verify `EmergencyFlatten` events are properly recorded with `EMERGENCY_FLATTEN` event type.

---

## 2. Position Reconciliation

### GAP-P4-003: Reconciliation Schedule Not Configured
- **Severity**: Major
- **Description**: Plan specifies periodic reconciliation (every 5 minutes during market hours). `trading/reconciliation.py` has the reconciliation logic but the scheduling is embedded in `daemon/main.py` _reconciliation_loop. Need to verify interval is configurable.
- **What's needed**: Configurable reconciliation interval, reconciliation on session start.

### GAP-P4-004: Reconciliation Discrepancy UI Alert Not Implemented
- **Severity**: Major
- **Description**: When reconciliation detects a position mismatch, the plan specifies a UI alert with options: [Accept Broker] | [Accept Local] | [Halt Trading]. No UI for this exists.
- **Missing**: TypeScript reconciliation alert component.

---

## 3. Broker Disconnect Handling

### GAP-P4-005: Broker Disconnect Grace Period Not Configurable
- **Severity**: Minor
- **Description**: Plan specifies configurable grace period before declaring broker disconnected. The `_broker_health_loop` in `daemon/main.py` has a heartbeat check but the grace period may be hardcoded.
- **What's needed**: Configurable `broker_disconnect_grace_seconds` setting.

### GAP-P4-006: Multiple Broker Support Not Implemented
- **Severity**: Minor (for V1)
- **Description**: Only Alpaca is implemented. Plan mentions "Data Provider Adapter" pattern but only one concrete adapter exists.
- **What exists**: `providers/alpaca.py`, `providers/base.py`, `providers/mock.py`
- **What's missing**: Other broker adapters (Interactive Brokers, etc.) - but this is explicitly deferred in plan's V1 scope.

---

## 4. Tamper-Evident Audit Log

### GAP-P4-007: Audit Log Chain Verification CLI Missing
- **Severity**: Major
- **Description**: Plan specifies a CLI tool to verify audit log chain integrity. `audit/ledger.py` writes chained hashes but no CLI verification tool exists.
- **What's needed**: `quantlab audit verify` CLI command that reads the audit log and verifies each entry's hash chain.

### GAP-P4-008: Audit Log Export Not Implemented
- **Severity**: Minor
- **Description**: Plan mentions audit log export for compliance. No export function exists in `audit/`.
- **What's needed**: Export function for audit entries in machine-readable format (JSON/CSV).

---

## 5. Fill Reconciliation

### GAP-P4-009: Fill Reconciliation Auto-Correct Not Implemented
- **Severity**: Major
- **Description**: Plan specifies that when fills from broker don't match local tracking, the system should auto-correct local state. `trading/fills.py` has fill tracking but auto-correction logic needs verification.
- **What's needed**: Verify `FillReconciler.reconcile()` properly handles unmatched fills.

---

## 6. Data Provider Adapter (Alpaca)

### GAP-P4-010: Alpaca WebSocket Streaming Not Implemented
- **Severity**: Major
- **Description**: `providers/alpaca.py` implements REST API but no WebSocket streaming for real-time market data.
- **What exists**: REST-based `fetch_bars()`, `get_account()`, `submit_order()`, `cancel_order()`.
- **What's missing**: WebSocket connection for real-time quotes, trades, and bars.
- **Impact**: Live trading relies on polling rather than real-time streaming.

### GAP-P4-011: Alpaca Paper Trading Mode Not Distinguished
- **Severity**: Minor
- **Description**: Plan specifies distinguishing between paper and live Alpaca accounts. Need to verify `providers/alpaca.py` correctly routes to paper vs live API endpoints.
- **What's needed**: Explicit paper trading mode with different base URL.

---

## 7. Trade Drift Detection

### GAP-P4-012: Drift Detection UI Alert Not Implemented
- **Severity**: Major
- **Description**: `trading/drift.py` detects position drift but cannot notify the UI because the TypeScript UI doesn't exist.
- **What exists**: Python drift detection logic.
- **What's missing**: IPC notification for drift events, UI alert component.

---

## 8. Auto-Update Protection

### GAP-P4-013: Auto-Update Protection UI Not Implemented
- **Severity**: Major
- **Description**: Plan specifies that auto-updates are blocked during live trading, with a UI notification. The daemon has `_handle_update_check_allowed` but no UI exists to display the update-blocked message.
- **What's needed**: TypeScript component showing "Update deferred - live session active".

---

## 9. Network Connectivity Handling

### GAP-P4-014: Network Status UI Not Implemented
- **Severity**: Major
- **Description**: Plan specifies a connection status indicator in the UI showing:
  - Broker connection status (connected/reconnecting/disconnected)
  - Data feed status
  - Network latency
- **Missing**: All TypeScript connection status UI components.

---

## 10. Session Ledger

### GAP-P4-015: Session Ledger Export Not Implemented
- **Severity**: Minor
- **Description**: `trading/ledger.py` tracks session activity but no export function exists for end-of-session reporting.
- **What's needed**: `SessionLedger.export()` method producing JSON/CSV.

---

## Summary

Phase 4 has **15 gaps**, of which **1 is CRITICAL** (emergency flatten UI), **9 are Major**, and **5 are Minor**. The Python-side live trading infrastructure is largely complete but all UI interaction points are missing, and a few important backend features (WebSocket streaming, audit verification CLI) are not implemented.

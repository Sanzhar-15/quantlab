# Phase 3: UI & Safety Systems - Missing Gaps

**Plan Document**: `04_Phase_3_UI_Safety.md`
**Duration**: 6 weeks (per plan)

---

## Overview

Phase 3 is the **least complete phase**. It is almost entirely TypeScript/UI work that has not been started. The only Python-side components (debug capture, report export) are implemented.

---

## 1. Pre-Trade Validation Checklist

### GAP-P3-001: Pre-Trade Validation UI Not Implemented
- **Severity**: CRITICAL
- **Description**: Plan §1 specifies a multi-step validation checklist before going live:
  1. Strategy has backtest with >0 trades
  2. Risk limits configured
  3. Broker connected and authenticated
  4. Data feed active
  5. Emergency flatten tested
  6. User acknowledges risk disclosure
- **Missing files**:
  - `extensions/quantlab/src/ui/PreTradeChecklist.ts`
  - `extensions/quantlab/src/core/validation/PreTradeValidator.ts`
- **Impact**: Users can potentially go live without proper setup verification.

---

## 2. Time-Travel Debugger

### GAP-P3-002: Time-Travel Debugger UI Not Implemented
- **Severity**: Major
- **Description**: Plan §2 specifies a rich UI for stepping through backtest history bar-by-bar:
  - Bar scrubber / timeline
  - Variable inspector showing portfolio state at each bar
  - Condition evaluation display
  - Signal annotations
  - Fill markers on chart
- **Python side**: `debug/capture.py`, `debug/format.py`, `debug/index.py` are **fully implemented** (Arrow IPC format, condition instrumentation, bar indexing).
- **Missing TypeScript files**:
  - `extensions/quantlab/src/ui/debugger/TimelinePanel.ts`
  - `extensions/quantlab/src/ui/debugger/StateInspector.ts`
  - `extensions/quantlab/src/ui/debugger/ConditionViewer.ts`
  - `extensions/quantlab/src/core/debug/DebugFileReader.ts` (Arrow IPC reader)
- **Impact**: Debug data is generated but there's no way to visualize it.

### GAP-P3-003: Debug File Memory-Mapped Reader Not Implemented
- **Severity**: Minor
- **Description**: Plan specifies memory-mapped reading of Arrow IPC debug files for large datasets. No mmap reader exists on either Python or TypeScript side.
- **Impact**: Large debug files will load slowly.

---

## 3. Workspace & Extension Trust

### GAP-P3-004: Workspace Trust Model Not Implemented
- **Severity**: Major
- **Description**: Plan §3 specifies trust levels for workspaces/extensions that can access live trading:
  - Trusted workspace: Full access
  - Restricted workspace: Read-only, no live trading
  - Untrusted: No access
- **Missing files**:
  - `extensions/quantlab/src/core/trust/WorkspaceTrust.ts`
  - `extensions/quantlab/src/core/trust/ExtensionTrust.ts`
- **Impact**: No security boundary between trusted and untrusted code.

---

## 4. Live Session UI Behaviors

### GAP-P3-005: Live Session UI Not Implemented
- **Severity**: CRITICAL
- **Description**: Plan §4 specifies comprehensive live session UI:
  - Position panel (real-time P&L)
  - Order blotter (pending/filled/cancelled)
  - Equity curve (live updating)
  - Risk panel (exposure, circuit breakers)
  - Alert panel (risk warnings)
  - Session status bar
  - Pause/Resume/Flatten buttons
- **Missing files**: All TypeScript UI components for live trading view.
- **Impact**: Even with a running daemon, there's no way to monitor or interact with a live session.

---

## 5. AI Panel with Security

### GAP-P3-006: AI Panel Not Implemented
- **Severity**: Minor
- **Description**: Plan §5 specifies an AI assistant panel integrated into the editor with:
  - Strategy suggestions
  - Code review for common errors
  - Backtest interpretation
  - Risk analysis
  - Security: AI cannot submit live orders
- **Missing files**: All AI panel TypeScript components.
- **Impact**: No AI-assisted development experience.

---

## 6. Pyright Integration

### GAP-P3-007: Pyright Integration Partial
- **Severity**: Minor
- **Description**: `pyrightconfig.json` exists with strict mode, but the plan specifies:
  - Custom Pyright rules for quantlab API
  - Strategy API type stubs for IntelliSense
  - Real-time type checking in editor
- **What exists**: Basic Pyright config.
- **What's missing**: Custom rules, API stubs as .pyi files.

---

## 7. Accessibility

### GAP-P3-008: Accessibility Not Implemented
- **Severity**: Major
- **Description**: Plan §7 specifies accessibility requirements:
  - WCAG 2.1 AA compliance
  - Screen reader support for charts
  - Keyboard navigation for all trading actions
  - High contrast mode
  - Focus management
- **Impact**: Application not accessible to users with disabilities. May have legal implications.

---

## 8. Report Export

### GAP-P3-009: Report Export Python Side Complete; UI Missing
- **Severity**: Major (UI)
- **Description**: Python export modules (`export/csv.py`, `export/html.py`, `export/json.py`) are **fully implemented**. However, no UI exists to trigger export or view HTML reports.
- **What exists**: Full CSV/HTML/JSON exporters with trade records, metrics, equity curves.
- **What's missing**: TypeScript UI for export dialog, report viewer panel.

---

## 9. Offline Mode

### GAP-P3-010: Offline Mode Not Implemented
- **Severity**: Minor
- **Description**: Plan mentions offline mode for backtesting without network. No explicit offline detection or mode switching exists.
- **Impact**: Low - backtesting already works offline. Only affects live trading connection status display.

---

## 10. Internationalization (i18n)

### GAP-P3-011: Internationalization Not Implemented
- **Severity**: Minor
- **Description**: Plan §10 specifies i18n support. No string externalization, locale detection, or translation files exist.
- **Impact**: Application only available in English.

---

## 11. Disk Space Management

### GAP-P3-012: Disk Space Management Not Implemented
- **Severity**: Minor
- **Description**: Plan mentions disk space monitoring for debug files, logs, and checkpoints. `runtime/disk.py` exists but UI warnings for low disk space are not implemented.
- **What exists**: `runtime/disk.py` with `DiskManager` class.
- **What's missing**: UI integration for disk space warnings.

---

## 12. First-Run Risk Configuration Wizard

### GAP-P3-013: Risk Configuration Wizard Not Implemented
- **Severity**: Major
- **Description**: Plan specifies a first-run wizard that guides users through:
  1. Account setup (broker selection)
  2. Risk limits configuration (max exposure, position limits)
  3. Emergency flatten configuration
  4. Risk disclosure acknowledgment
- **Missing files**: All wizard UI components.
- **Impact**: Users must manually configure risk limits, increasing risk of misconfiguration.

---

## 13. Strategy Hot-Reload During Live Session

### GAP-P3-014: Hot-Reload Not Implemented
- **Severity**: Major
- **Description**: Plan specifies ability to modify strategy code during a live session with:
  - Validation of changes before applying
  - Automatic backup
  - State preservation
  - Rollback on error
- **Missing**: Hot-reload mechanism in daemon, UI confirmation dialog.
- **Impact**: Strategy changes require stopping and restarting the session.

---

## Summary

Phase 3 has **14 gaps**, of which **2 are CRITICAL** (pre-trade validation, live session UI), **7 are Major**, and **5 are Minor**. The Python-side components (debug capture/format/index, report export) are complete, but all TypeScript/UI components are missing.

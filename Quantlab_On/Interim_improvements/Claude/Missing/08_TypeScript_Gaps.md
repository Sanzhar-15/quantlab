# TypeScript / VS Code Extension - Complete Gap Inventory

**Status**: 0% implemented
**Impact**: No user interface exists for the application

---

## Overview

The implementation plan specifies approximately 35-40 TypeScript files across the VS Code extension. None have been written. This document provides a complete inventory of every TypeScript component required.

---

## Phase 1: Critical Infrastructure (TypeScript)

| File | Purpose | Priority |
|------|---------|----------|
| `extensions/quantlab/src/core/trading/DaemonClient.ts` | IPC client connecting UI to daemon process | CRITICAL |
| `extensions/quantlab/src/core/trading/SessionManager.ts` | Live session lifecycle management | CRITICAL |
| `extensions/quantlab/src/core/risk/ExposureManager.ts` | Advisory pre-trade exposure checks | CRITICAL |
| `extensions/quantlab/src/core/secrets/backend.ts` | Secrets backend abstraction | Major |
| `extensions/quantlab/src/core/secrets/encrypted.ts` | AES-256-GCM encrypted file backend | Major |
| `extensions/quantlab/src/core/secrets/migration.ts` | Keychain to encrypted file migration | Minor |
| `extensions/quantlab/src/core/secrets/rotation.ts` | Master password rotation logic | Major |
| `extensions/quantlab/src/ui/MasterKeyPrompt.ts` | Master key entry dialog | Major |
| `extensions/quantlab/src/ui/ChangePasswordDialog.ts` | Password change dialog | Minor |

---

## Phase 3: UI & Safety (TypeScript)

### Pre-Trade Validation
| File | Purpose | Priority |
|------|---------|----------|
| `extensions/quantlab/src/ui/PreTradeChecklist.ts` | Pre-trade validation wizard | CRITICAL |
| `extensions/quantlab/src/core/validation/PreTradeValidator.ts` | Validation logic for pre-trade checks | CRITICAL |

### Time-Travel Debugger
| File | Purpose | Priority |
|------|---------|----------|
| `extensions/quantlab/src/ui/debugger/TimelinePanel.ts` | Bar-by-bar timeline scrubber | Major |
| `extensions/quantlab/src/ui/debugger/StateInspector.ts` | Portfolio state inspector at each bar | Major |
| `extensions/quantlab/src/ui/debugger/ConditionViewer.ts` | If-condition evaluation display | Major |
| `extensions/quantlab/src/core/debug/DebugFileReader.ts` | Arrow IPC file reader | Major |

### Workspace Trust
| File | Purpose | Priority |
|------|---------|----------|
| `extensions/quantlab/src/core/trust/WorkspaceTrust.ts` | Workspace trust level management | Major |
| `extensions/quantlab/src/core/trust/ExtensionTrust.ts` | Extension trust verification | Major |

### Live Session UI
| File | Purpose | Priority |
|------|---------|----------|
| `extensions/quantlab/src/ui/live/PositionPanel.ts` | Real-time position display | CRITICAL |
| `extensions/quantlab/src/ui/live/OrderBlotter.ts` | Order management panel | CRITICAL |
| `extensions/quantlab/src/ui/live/EquityCurve.ts` | Live equity curve chart | Major |
| `extensions/quantlab/src/ui/live/RiskPanel.ts` | Exposure and circuit breaker display | CRITICAL |
| `extensions/quantlab/src/ui/live/AlertPanel.ts` | Risk and system alert display | Major |
| `extensions/quantlab/src/ui/live/SessionStatusBar.ts` | Session status in VS Code status bar | Major |
| `extensions/quantlab/src/ui/live/SessionControls.ts` | Pause/Resume/Flatten controls | CRITICAL |

### AI Panel
| File | Purpose | Priority |
|------|---------|----------|
| `extensions/quantlab/src/ui/ai/AIPanel.ts` | AI assistant panel | Minor |
| `extensions/quantlab/src/core/ai/AIGuard.ts` | Security: prevent AI from live orders | Minor |

### Report Export
| File | Purpose | Priority |
|------|---------|----------|
| `extensions/quantlab/src/ui/export/ExportDialog.ts` | Export format selection dialog | Major |
| `extensions/quantlab/src/ui/export/ReportViewer.ts` | HTML report viewer panel | Major |

### Other UI
| File | Purpose | Priority |
|------|---------|----------|
| `extensions/quantlab/src/ui/RiskWizard.ts` | First-run risk configuration wizard | Major |
| `extensions/quantlab/src/ui/ConnectionStatus.ts` | Network/broker connection indicator | Major |
| `extensions/quantlab/src/ui/UpdateBlockedNotice.ts` | Update deferred notification | Minor |
| `extensions/quantlab/src/ui/ReconciliationAlert.ts` | Position discrepancy alert | Major |
| `extensions/quantlab/src/ui/DriftAlert.ts` | Trade drift notification | Major |

---

## Phase 4: Live Trading (TypeScript)

| File | Purpose | Priority |
|------|---------|----------|
| `extensions/quantlab/src/ui/EmergencyFlattenButton.ts` | Panic button (Ctrl+Shift+F) | CRITICAL |
| `extensions/quantlab/src/ui/EmergencyFlattenConfirm.ts` | Flatten confirmation dialog | CRITICAL |

---

## Tests (TypeScript)

| File | Purpose | Priority |
|------|---------|----------|
| `tests/risk/exposure.test.ts` | ExposureManager unit tests | Major |
| `tests/secrets/rotation.test.ts` | Secret rotation tests | Major |
| `tests/secrets/encrypted.test.ts` | Encrypted backend tests | Major |
| `tests/daemon/client.test.ts` | DaemonClient integration tests | Major |

---

## Total: ~38 TypeScript files needed

| Priority | Count |
|----------|-------|
| CRITICAL | 10 |
| Major | 20 |
| Minor | 8 |

---

## Recommended Implementation Order

1. **DaemonClient.ts** + **SessionManager.ts** (enables UI-daemon communication)
2. **ExposureManager.ts** (enables pre-trade risk checks in UI)
3. **SessionControls.ts** + **PositionPanel.ts** + **OrderBlotter.ts** (minimum live trading UI)
4. **EmergencyFlattenButton.ts** + **EmergencyFlattenConfirm.ts** (safety critical)
5. **RiskPanel.ts** + **AlertPanel.ts** (risk monitoring)
6. **PreTradeChecklist.ts** (safety gate)
7. **ConnectionStatus.ts** + **SessionStatusBar.ts** (operational awareness)
8. **TimelinePanel.ts** + **StateInspector.ts** (debugging)
9. **ExportDialog.ts** + **ReportViewer.ts** (reporting)
10. Everything else (secrets UI, trust, AI, i18n)

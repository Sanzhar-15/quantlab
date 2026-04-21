# UI Safety, Recovery, and Update‑Flow Gaps

---

## 1) Pre‑Trade Checklist Is Not Invoked

**Evidence**
- Checklist exists in `extensions/quantlab/src/ui/dialogs/PreTradeChecklist.ts`.
- No usage found elsewhere in the extension.

**Impact**
- Live trading can start without required checks (risk limits, broker state, trust).

**Optimal Fix**
- Call the checklist from `SessionManager.startSession()` and `startDaemonSession()` before any trading begins.

---

## 2) Recovery Dialog Exists but Is Unused

**Evidence**
- `extensions/quantlab/src/ui/dialogs/RecoveryDialog.ts` is never referenced.

**Impact**
- Checkpoint recovery (engine supports it) has no UI entrypoint.

**Optimal Fix**
- On extension start, detect any daemon checkpoint/session token and show RecoveryDialog.
- Add “Reconnect / Discard / View Only” flow aligned with Decision N97.

---

## 3) System Tray + Close Flow Missing

**Evidence**
- No `ui/tray` implementation; no system tray hooks in `extensions/quantlab/src`.

**Impact**
- Background trading status/controls are absent.

**Optimal Fix**
- Implement system tray integration and a close/minimize flow per the plan.

---

## 4) Update Gating Not Wired

**Evidence**
- Daemon exposes `update.check_allowed` handler in `engine/quantlab/daemon/main.py`.
- Client has `checkUpdateAllowed()` in `DaemonClient` but no call site.

**Impact**
- Updates could be applied during active trading, violating the “no surprise trading” constraint.

**Optimal Fix**
- Hook update checks to call `checkUpdateAllowed()` and block updates when the daemon is active.

---

## 5) Connection‑Loss UI Flow Missing

**Evidence**
- Daemon emits `status.update` for broker connectivity; UI expects `connection.status` but doesn’t surface any UI.

**Impact**
- Users may be unaware of broker disconnects or degraded trading state.

**Optimal Fix**
- Implement a connection status banner/toast in Trade view tied to broker connectivity events.

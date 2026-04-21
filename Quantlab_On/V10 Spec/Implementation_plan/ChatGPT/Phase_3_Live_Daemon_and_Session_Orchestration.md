# Phase 3 - Live Daemon and Session Orchestration

Date: 2026-01-26
Status: Planning
Owner: Quantlab Eng

## Objectives
- Implement Python live daemon with TS IPC bridge and authenticated JSON-RPC.
- Enable UI reconnection, session recovery, and background operation.
- Add system tray behaviors and safe window close flows.

## Spec Coverage
- Technical: 1.5, 1.6, 12.1-12.2, 15
- Product: 14.1-14.3, 14.5 (close flow, tray mode, recovery, connection loss)
- Ops: 2.3 (live session protection for auto-updates)
- Test: 4.4 (daemon lifecycle integration), 8.4 (daemon failures)
- Decisions: A4-A5, E29-E30, G41, H50-H53, L69-L70, N81-N82, N97-N99

## Decision Constraints (must implement)
- Daemon is Python; TS bridge handles IPC.
- IPC transport: Unix sockets/Named Pipes, JSON-RPC 2.0, token auth.
- Live sessions survive UI close; no auto-restart after OS reboot.
- Multiple sessions allowed; same broker account only used by one session.
- Sleep/wake handling and network loss handling required.
- Updates blocked for live sessions; warning only for paper sessions.

## Implementation Plan
### 1) Python Live Daemon
- Entry point: `engine/quantlab/daemon`.
- IPC sockets in `~/.quantlab/sockets/` and token in `~/.quantlab/sessions/{id}.token`.
- PID + checkpoint state in `~/.quantlab/sessions/`.
- Log files in `~/.quantlab/logs/`.
- Health endpoint (JSON-RPC `health`) and watchdog heartbeat.

### 2) TS IPC Bridge
- New `LiveDaemonManager` in extension host:
  - Start daemon with config payload.
  - Reconnect to existing sessions on activation.
  - Expose session discovery for recovery modal.
- Auth token validation per request.
- Ack/retry handling for critical messages.

### 3) UI Close and Recovery Flows
- Close interception modal (Product 14.1):
  - Minimize to tray, Stop Session and Close, Close UI Only.
- Session recovery modal on reconnect (Product 14.3).

### 4) System Tray Integration
- Windows: system tray icon.
- macOS: menu bar.
- Linux: tray if available; fallback to dock icon + notification.
- Tray menu actions: open UI, pause, flatten, stop.

### 5) Connection Loss Handling (Product 14.5)
- 0-30s: reconnecting toast.
- 30s-5min: warning banner.
- >5min: circuit breaker + modal.
- Integrate with daemon network monitoring.

### 6) Sleep/Wake Handling
- On sleep: pause strategy, checkpoint, close sockets gracefully.
- On wake: reconnect broker, reconcile positions, resume if market open.

### 7) Update Blocking
- Update system checks active daemon before download.
- Daemon refuses update signal if live session active.
- Paper sessions show warning (not blocked).

## Target Code Locations
- New: `engine/quantlab/daemon/*`.
- New: `extensions/quantlab/src/core/trading/LiveDaemonManager.ts`.
- Update: `extensions/quantlab/src/core/trading/SessionManager.ts`.
- Update: Electron main process for tray and close behaviors.

## Tests and Validation
- Daemon lifecycle tests (start, reconnect, crash recovery).
- UI recovery tests (reopen UI and reconnect).
- Tray actions call correct daemon commands.
- Sleep/wake simulation tests where possible.

## Exit Criteria
- Live daemon runs independently and survives UI close.
- UI can reconnect and display session recovery modal.
- Connection loss handling matches Product 14.5.


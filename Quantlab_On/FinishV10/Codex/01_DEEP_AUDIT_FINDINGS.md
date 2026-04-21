# Deep Audit Findings (Additional Lens)

Date: 2026-01-29
This file adds new findings beyond the prior audit summary. It is organized by system layer.

## 1) IPC Transport, Auth, and Protocol
- Socket path mismatch: daemon uses `~/.quantlab/sockets/*.sock` while extension connects to `~/.quantlab/sessions/*.sock`. `engine/quantlab/daemon/ipc.py:168`, `extensions/quantlab/src/core/ipc/SocketTransport.ts:79`
- Auth handshake mismatch: daemon requires an explicit `authenticate`/`auth` message before any request, but the extension only adds per-request `_auth` and never sends `authenticate`. `engine/quantlab/daemon/ipc.py:365`, `extensions/quantlab/src/core/ipc/TokenAuth.ts:97`, `extensions/quantlab/src/core/trading/DaemonClient.ts:146`
- Negotiation-only connect: DaemonClient sends `negotiate` then immediately starts requests; daemon expects `authenticate` after negotiate. `extensions/quantlab/src/core/trading/DaemonClient.ts:146`, `engine/quantlab/daemon/ipc.py:397`
- IPC snapshot is silently dropped: daemon sends a JSON-RPC result with `id: null` after auth, but client only routes responses if it has a pending request. `engine/quantlab/daemon/ipc.py:444`, `extensions/quantlab/src/core/trading/DaemonClient.ts:607`
- Protocol schema mismatch: daemon uses snake_case fields and wrapper objects; extension uses camelCase fields and expects raw arrays. `engine/quantlab/daemon/main.py:1532`, `extensions/quantlab/src/core/ipc/types.ts:182`
- Notification method mismatch: daemon emits `positions`, `orders`, `fills` (not `*.update`), while client only listens for `*.update`. `engine/quantlab/daemon/main.py:1738`, `extensions/quantlab/src/core/trading/DaemonClient.ts:664`
- Reliability layer mismatch: daemon uses `ReliabilityManager` and snapshot semantics, but extension only buffers and never resends or acks; tier mapping is also inconsistent (e.g. `flatten.all` vs `flatten.request`). `extensions/quantlab/src/core/ipc/MessageBuffer.ts:349`
- Windows live trading is effectively unsupported: daemon IPC server only binds Unix sockets; extension uses named pipes on Windows. `engine/quantlab/daemon/ipc.py:168`, `extensions/quantlab/src/core/ipc/SocketTransport.ts:79`

## 2) Daemon Lifecycle and CLI
- CLI flag mismatch blocks startup: extension uses `--symbol`, daemon requires `--symbols`. `extensions/quantlab/src/core/trading/LiveDaemonManager.ts:285`, `engine/quantlab/daemon/__main__.py:53`
- Readiness detection is broken: LiveDaemonManager waits for `DAEMON_READY` that is never printed by the daemon. `extensions/quantlab/src/core/trading/LiveDaemonManager.ts:154`
- Session config mismatch: daemon expects `symbols` list and broker name; extension only sends `symbol` and does not pass broker. `extensions/quantlab/src/core/trading/SessionManager.ts:1184`, `engine/quantlab/daemon/main.py:84`
- Risk limit mapping is incorrect (daily loss limit used as exposure). `extensions/quantlab/src/core/trading/SessionManager.ts:1162`

## 3) Safety, Trust, and Compliance
- Live trading path bypasses daemon safety: `startLiveSession` calls in-extension broker adapter, not daemon. `extensions/quantlab/src/commands/tradeCommands.ts:21`, `extensions/quantlab/src/core/trading/SessionManager.ts:418`
- TrustManager and PreTradeChecklist are never wired into the live trading flow. `extensions/quantlab/src/core/trust/TrustManager.ts:39`, `extensions/quantlab/src/ui/dialogs/PreTradeChecklist.ts:55`
- Kill Switch executes against broker adapter only; daemon sessions would bypass daemon-side safety actions. `extensions/quantlab/src/views/trade/KillSwitch.ts:37`
- `update.check_allowed` exists in daemon but is unused in extension; update gating is not enforced. `extensions/quantlab/src/core/trading/DaemonClient.ts:500`

## 4) UI and Workflow Gaps
- History search is a stub; user journey incomplete. `extensions/quantlab/src/commands/historyCommands.ts:34`
- Data panel sections (universes/sources) are placeholders; no data backend. `extensions/quantlab/src/panels/data/DataTreeProvider.ts:64`
- Time-travel debugger cannot load binary debug data (missing `quantlab.engine.readDebugFile` command). `extensions/quantlab/src/views/chart/DebuggerService.ts:351`
- Action view and chart view are local-only; no real-time broker data feed integration.

## 5) Engine Completeness and Data Pipeline
- Parquet ingestion is declared but not supported; no streaming or chunked reads for large data. `extensions/quantlab/src/core/engine/DataService.ts:111`
- Intraday borrow fee proration is explicitly not implemented. `engine/quantlab/backtest/core.py:991`
- Predefined universes are placeholders (empty components). `engine/quantlab/data/universe.py:507`
- Job runner only executes backtests even for optimize/monteCarlo/WFA actions. `extensions/quantlab/src/core/engine/JobRunner.ts:40`

## 6) Testing and Verification
- IPC integration tests target a mock protocol (camelCase + `flatten.all`) and do not validate daemon contract. `extensions/quantlab/src/test/integration/daemon.integration.test.ts:113`
- No end-to-end test that starts daemon + extension IPC in CI.

## 7) Build, Packaging, and Release
- Python bundling exists but extension always uses system Python; bundled Python is unused. `extensions/quantlab/src/core/engine/EngineHost.ts:49`
- Documentation drift: PATCHES.md references core patches not present in the current code.

## 8) Observability and Logging
- Daemon log stream exists (`log.entry`) but extension does not subscribe or surface it; no UI log panel for daemon IPC.

## 9) Versioning and Compatibility
- Spec-defined `_meta` fields (protocolVersion, sessionId, sequence, stream) are not populated by the extension; sequence handling is absent.

## 10) Performance and Stability
- CSV parsing and chart data handling happens in the extension host with no worker isolation; large datasets may block the extension host.

---

These findings feed directly into the phased implementation plan.

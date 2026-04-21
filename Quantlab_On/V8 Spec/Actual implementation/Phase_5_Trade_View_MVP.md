# Quantlab Phase 5 Trade View MVP - Full Implementation Plan

Version: 1.1
Owner: Quantlab PM/Eng
Timebox: 4-7 weeks
Goal: Implement Trade view UI, Trade panel session control, kill switch, safety gating, broker integration, and live chart overlays per V8.1.

## References (Source of Truth)
- Quantlab V8.1 UI/UX spec: `Quantlab_On/Full_spec/Quantlab_UX_Spec.md`
- General implementation plan: `Quantlab_On/General_Implementation_plan/Quantlab_Implementation.md`
- Deeper Phase 5 plan: `Quantlab_On/Deeper_implementation_plan/Phase_5_Trade_View_MVP.md`
- Phase 1 implementation plan (view system): `Quantlab_On/Actual implementation/Phase_1_Core_View_System.md`
- Phase 2 implementation plan (trade panel shell): `Quantlab_On/Actual implementation/Phase_2_Window_Chrome_Activity_Bar_History.md`
- Phase 3 implementation plan (chart view integration): `Quantlab_On/Actual implementation/Phase_3_Chart_View_MVP.md`
- Phase 4 implementation plan (action view + history): `Quantlab_On/Actual implementation/Phase_4_Action_View_MVP.md`
- Charting engine and docs: `Charts/`

Note: The Quantlab extension root is `extensions/quantlab` (built-in extension per Phase 1 decisions). If this extension folder does not yet exist in the repo, Phase 5 scaffolding includes creating it.

## Phase 5 Objectives
1. Implement Trade view as a CustomTextEditorProvider with two states: No Session and Active Session.
2. Upgrade the Trade panel to drive session control, show sessions, positions, orders, risk, and connections.
3. Add a SessionManager that supports paper and live sessions, multiple concurrent sessions, and heartbeat monitoring.
4. Implement Kill Switch policies with correct paper vs live behavior and logging.
5. Enforce safety gating: complexity-based blocks, pre-trade requirements, and warning prompts.
6. Integrate broker adapters (Alpaca plus Mock) with secure credential storage and real-time updates.
7. Wire real-time positions, orders, fills, performance metrics, and activity logs to the Trade view UI.
8. Implement Trade -> Chart integration with live overlays for fills, orders, and positions.
9. Handle Trade view error states (disconnects, rejections, crashes) with recovery actions.
10. Add unit, integration, and manual verification coverage for Trade view flows.

## Scope
In scope:
- Trade view webview UI for No Session and Active Session.
- Trade panel session control and status sections.
- Session lifecycle (start, pause, resume, stop) for paper and live.
- Kill Switch implementation and policy configuration.
- Safety gating and requirements checklist.
- Broker adapter abstraction with Alpaca and Mock implementations.
- Real-time updates (positions, orders, fills, performance, activity).
- Chart view live overlays for trading sessions.
- Error handling and recovery UI for Trade view.
- Tests and basic documentation for broker setup.

Out of scope:
- Full notifications system (Phase 6).
- Additional brokers beyond Alpaca (post-MVP).
- Advanced risk analytics (VaR, portfolio stress).
- Trade blotter and historical session browser.
- Live order entry UX beyond modify/cancel/close.
- Onboarding flow (Phase 6).

## Backend Optimization Principles (Non-UX)
- Coalesce broker updates and cap render updates (<= 10 Hz; coalesce 100-250 ms).
- Use per-session revision/sequence numbers and drop out-of-order updates.
- Maintain maps keyed by orderId and symbol; compute diffs and send minimal deltas.
- Use epoch ms timestamps across the message boundary; avoid Date serialization.
- Queue extension -> webview messages until `ready`; drop on disposal.
- Bound activity logs and event buffers (ring buffer, last 100-200 entries).
- Compute P&L and performance in the extension host; webview is render-only.
- Reference-count broker connections; disconnect when idle; reconnect with backoff.
- Route updates by sessionId and strategyPath to prevent cross-tab leakage.

## Phase 5 Decisions (Locked)
1. Trade view is implemented as a CustomTextEditorProvider matching Chart and Action views.
2. SessionManager runs in the extension host and owns broker connections for MVP.
3. Broker integrations are adapter-based with Alpaca as primary and Mock for tests.
4. Kill Switch configuration is stored in settings and executed by the extension host.
5. Trade view state persists to TabViewState as `tradeState.sessionId` and `tradeState.scrollPosition` per spec; sessionId is cleared if no active session.
6. Chart integration is additive (overlays) and does not modify core chart engine.
7. No new workbench patches are planned; any required patch is recorded in `extensions/quantlab/docs/PATCHES_PHASE_5.md`.
8. Reuse existing command IDs from Phase 2/Phase 1 where possible to avoid duplicates.

## Non-Negotiable V8.1 Requirements (Phase 5 Relevant)
- Trade view is a per-tab state with a red stripe (#DC2626).
- Trade view has two states: No active session and Active session.
- Kill Switch label reflects configured policy (Flatten, Cancel Only, Custom).
- Paper trading: Kill Switch executes immediately.
- Live trading: Kill Switch requires confirmation dialog.
- View-Only complexity blocks live trading entirely.
- Trade panel auto-expands when entering Trade view.
- Heartbeat indicator is visible in Active session state.
- "View in Chart" shows live price data and overlays fills and orders.
- Trade view is available only for `.py` strategies with valid structure and broker configured.
- Active trade sessions are locked to their start-time symbol/timeframe (global selectors do not override).

## Dependencies from Phases 1-4
- View system and view switching commands (`quantlab.switchToTrade`).
- Tab view state and per-tab persistence.
- Trade panel container and `quantlab.focusTradePanel` command.
- Chart view provider and overlay hooks (Phase 3).
- HistoryState for backtest eligibility checks (Phase 4).
- Strategy validation and complexity analysis (Phase 3).
- Global symbol/timeframe state (Phase 2).

## Workbench Patch Plan (Phase 5)
No workbench patches expected. If a patch is required for Trade view lifecycle or accessibility, record it in `extensions/quantlab/docs/PATCHES_PHASE_5.md` with exact file paths and rationale.

## Implementation Plan

### 1. Phase 5 file layout and build pipeline
Extend `extensions/quantlab` with Trade view and broker integration code.

```
extensions/quantlab/
  package.json
  src/
    extension.ts
    commands/
      tradeCommands.ts
    types/
      trading.ts
      tradeMessages.ts
    core/
      broker/
        BrokerAdapter.ts
        AlpacaAdapter.ts
        MockBrokerAdapter.ts
      trading/
        SessionManager.ts
    views/
      trade/
        TradeViewProvider.ts
        TradeWebview.ts
        KillSwitch.ts
    panels/
      trade/
        TradePanelProvider.ts
        TradeTreeProvider.ts
    utils/
      secureStorage.ts
  webview/
    trade/
      index.ts
      trade.ts
      trade.css
      states/
        noSession.ts
        activeSession.ts
      components/
        tables.ts
        dialogs.ts
        banners.ts
  dist/
    webview/
      trade.js
  docs/
    TRADING_SETUP.md
    PATCHES_PHASE_5.md (if needed)
```

Build pipeline:
- Add a webview bundler entry for Trade view (webpack or esbuild) outputting `dist/webview/trade.js`.
- Keep webview bundle separate from extension host bundle.
- Reuse shared webview utilities from Phase 3/4 (theme sync, message bridge).

### 2. Extension contributions and registrations
Update `extensions/quantlab/package.json`:
- `contributes.customEditors`:
  - viewType: `quantlab.tradeView`
  - selector: `*.py`
  - priority: `option`
- Commands:
  - `quantlab.startPaperSession`
  - `quantlab.startLiveSession`
  - `quantlab.pauseSession`
  - `quantlab.resumeSession`
  - `quantlab.stopSession`
  - `quantlab.viewSession`
  - `quantlab.trade.viewInChart` (internal, webview -> extension)
  - `quantlab.killSwitch` (Trade view only)
  - `quantlab.openRiskSettings`
  - `quantlab.openBrokerSettings`
- Menus:
  - Trade panel context actions (pause, resume, stop, view).
  - Command palette entries for Trade actions.
- Keybindings:
  - `Ctrl+Q T` for Trade view (already in Phase 1).
  - `Ctrl+Q K` for Kill Switch (Trade view only).
  - `Ctrl+Q 4` for Trade panel focus (Phase 2).
- Settings (`contributes.configuration`):
  - `quantlab.trading.killSwitchPolicy` (flatten, cancelOnly, custom)
  - `quantlab.trading.killSwitchCustomActions`
  - `quantlab.trading.requireBacktest`
  - `quantlab.trading.requirePaperTrading`
  - `quantlab.trading.requireRiskReview`
  - `quantlab.trading.dailyLossLimit`
  - `quantlab.trading.maxPositionSize`
  - `quantlab.trading.maxOpenOrders`

### 3. Types and contracts
Create `extensions/quantlab/src/types/trading.ts`:
- Session types, status, orders, fills, positions, performance metrics.
- RequirementsCheck and KillSwitch config types.
- RiskAlert, TradeErrorState, and BrokerAccount types.
- TradeErrorState includes `code`, `message`, and optional `recoverable` flag.
- OrderModification type for order edit flows.
- Use epoch ms timestamps in serialized shapes; convert to Date only at render boundaries.

Create `extensions/quantlab/src/types/tradeMessages.ts`:
- Strict message union types for extension <-> webview.
- Include `sessionId`, `strategyPath`, `timestamp`, and optional `seq` fields for routing.

### 4. Webview message protocol
Define a strict protocol to avoid ad hoc messaging.

Extension -> Webview:
```typescript
{ type: 'init', session: SessionInfo | null, requirements: RequirementsCheck, scrollPosition?: number }
{ type: 'sessionStarted', session: SessionInfo }
{ type: 'sessionStopped', sessionId: string, reason?: string }
{ type: 'positionsUpdate', sessionId: string, positions: Position[], seq?: number }
{ type: 'ordersUpdate', sessionId: string, orders: Order[], seq?: number }
{ type: 'fill', sessionId: string, fill: Fill, seq?: number }
{ type: 'performanceUpdate', sessionId: string, performance: PerformanceMetrics, seq?: number }
{ type: 'activity', sessionId: string, entry: ActivityEntry, seq?: number }
{ type: 'heartbeat', sessionId: string, status: 'ok' | 'stale' | 'lost', lastSeen: number }
{ type: 'riskAlert', sessionId: string, alert: RiskAlert }
{ type: 'errorState', sessionId: string, error: TradeErrorState }
```

Webview -> Extension:
```typescript
{ type: 'ready' }
{ type: 'openTradePanel' }
{ type: 'pauseSession', sessionId: string }
{ type: 'resumeSession', sessionId: string }
{ type: 'stopSession', sessionId: string }
{ type: 'killSwitch', sessionId: string, confirmed?: boolean }
{ type: 'viewInChart', sessionId: string }
{ type: 'modifyOrder', sessionId: string, orderId: string, changes: OrderModification }
{ type: 'cancelOrder', sessionId: string, orderId: string }
{ type: 'closePosition', sessionId: string, symbol: string }
{ type: 'openSessionSettings', sessionId: string }
{ type: 'scrollPosition', value: number }
```

### 5. Trade panel upgrade (Activity Bar)
Expand the existing Trade panel created in Phase 2:
- Session Control:
  - Strategy dropdown: list open strategy files.
  - Account dropdown: list configured broker accounts.
  - Start Paper and Start Live buttons.
- Active Sessions:
  - List sessions with runtime and PnL summary.
  - Actions: Pause, Stop, View.
- Positions (All):
  - Aggregate positions across sessions.
- Open Orders:
  - Aggregate open orders across sessions.
- Risk Status:
  - Daily loss percent and quick access to Risk Settings.
- Connections:
  - Broker connection status and reconnect action.

Implementation details:
- Wire TradePanelProvider and TradeTreeProvider to SessionManager.
- Disable Start Live when gating fails and show tooltip with reason.
- Disable Start Paper when strategy is invalid or no broker account is configured.
- Auto-expand Trade panel on Trade view entry via `quantlab.focusTradePanel`.
- Use stable `TreeItem.id` values to preserve selection and expansion.
- Refresh only affected sections on updates; no polling in Trade panel.
- Risk Settings and Broker Connections items open settings via `workbench.action.openSettings`.

### 6. Trade view provider and per-tab state
Create `TradeViewProvider.ts` and `TradeWebview.ts`:
- CustomTextEditorProvider that swaps editor content for Trade view.
- On open, resolve the active session for the strategy (if any).
- Persist `tradeState.sessionId` and `tradeState.scrollPosition` in TabViewState.
- Clear persisted sessionId if the session no longer exists on restore.
- Route session updates by sessionId to avoid cross-tab updates.
- When a session stops, clear `tradeState.sessionId` for any tabs bound to it.
- On entering Trade view, call `quantlab.focusTradePanel`.
- Use a `ready` handshake; queue outbound messages until webview signals readiness.
- Ignore global symbol/timeframe changes while a trade session is active (session is locked).
- Dispose session subscriptions on webview dispose to avoid leaks.

### 7. Webview UI: No Session and Active Session
No Session state:
- Title and empty state card.
- "Open Trade Panel" button.
- Requirements checklist with required vs recommended items.
- Blocking warning if required items are not met.

Active Session state:
- Header with Kill Switch button labeled by policy.
- Session info card (type, status, account, start time, strategy hash).
- Heartbeat indicator with OK, stale, lost states.
- Performance summary (session, today, open, realized).
- Positions table with close action.
- Orders table with modify/cancel actions and rejection reasons.
- Activity log (recent signals, orders, fills, alerts).
- Actions: Pause/Resume, View in Chart, Session Settings.

Accessibility:
- Keyboard focus for all interactive controls.
- ARIA labels for buttons and tables.
- Reduced motion support for transitions.
- Throttle scroll position persistence (send every 200-300 ms).

### 8. Session Manager and lifecycle
Create `core/trading/SessionManager.ts`:
- Start session: validate eligibility, connect broker, subscribe to updates.
- If broker connection fails, do not create a running session; emit errorState.
- Pause/Resume: update session state and emit updates.
- Stop: cleanly unsubscribe, close connections, and update UI.
- Support multiple sessions concurrently; map sessions by id and strategyPath.
- De-duplicate start requests for the same strategy/account and return existing session.
- Maintain per-account broker connections with reference counts; disconnect on last session.
- Heartbeat: track last broker update and emit ok/stale/lost based on thresholds.
- Maintain local caches for positions, orders, activity, performance; emit diffs.
- Track session summaries (type, strategyPath, endedAt) in workspaceState for checklist.
- Emit events for Trade view and Trade panel updates with sessionId routing.

### 9. Broker integration and credentials
Create adapter interfaces and implementations:
- `BrokerAdapter` abstract interface (connect, orders, positions, subscribe).
- `AlpacaAdapter` using REST for initial state and WebSocket for updates.
- Map broker statuses to internal `OrderStatus`; handle partial fills and rejections.
- Implement reconnect with exponential backoff + jitter and a manual retry hook.
- `MockBrokerAdapter` for tests (deterministic fills, latency control).

Credential storage:
- Use `context.secrets` in `utils/secureStorage.ts`.
- Store per-account API key and secret, never in settings or logs.
- Provide `quantlab.openBrokerSettings` to jump to broker settings entries.

### 10. Safety gating and requirements checklist
Implement gating using existing analyzers:
- Strategy validity: use StrategyValidator.
- Complexity: Safe/Partial allowed, View-Only blocks live trading.
- Broker configured: at least one connected account or stored credentials.
- Pre-trade requirements (settings):
  - Require backtest (HistoryState completed backtest).
  - Require paper session (optional; uses persisted session summaries).
  - Require risk review (optional; stored in workspaceState).
- For Partial complexity, show warning prompt on start.
- RequirementsCheck feeds both UI checklist and button enablement.
- Active sessions are locked to their start-time symbol/timeframe; ignore global selector changes.
- For invalid strategies, keep Trade view in No Session state and surface validation guidance.

### 11. Kill Switch system
Create `views/trade/KillSwitch.ts`:
- Read policy from settings.
- Supported policies:
  - Flatten: cancel orders, close positions.
  - Cancel Only: cancel orders only.
  - Custom: sequence of configured actions.
- Paper: execute immediately.
- Live: require confirmation dialog in webview.
- Execute actions serially and short-circuit on fatal errors.
- Log execution to "Quantlab Trading" output channel.
- Stop session after kill switch completes (even if partially successful).

### 12. Real-time data flow
Data flow:
- Broker updates -> SessionManager -> TradeWebview + TradePanel.
- Send snapshots on session start; incremental updates afterward.
- Throttle updates and batch changes (positions/orders) to reduce churn.
- Drop updates for disposed tabs or stopped sessions.
- Tag updates with `seq` and ignore stale events on the webview side.
- Keep payloads minimal (arrays of changed items) and avoid full table refreshes.

### 13. Trade -> Chart integration
Add a live overlay path in Chart view:
- Add `ChartViewProvider.attachLiveSession(sessionId)` and `detachLiveSession`.
- On "View in Chart", switch view to Chart in same tab and attach overlays.
- Overlays show live fills, orders, and positions on top of price data.
- Chart symbol/timeframe lock to session symbol while attached.
- Detach overlays on session stop or view switch.
- Keep trade overlays separate from backtest overlays; do not mutate chart state.

### 14. Risk management
Add baseline risk enforcement:
- Daily loss limit, max position size, max open orders.
- SessionManager computes risk status and emits RiskAlert.
- Trade panel shows daily loss percent and "Risk Settings" action.
- Trade view shows inline banners for critical alerts (notifications in Phase 6).
- Evaluate risk on each positions/orders update and on session start.
- Mark `riskReviewed` in workspaceState when Risk Settings is opened for a strategy.

### 15. Error handling and recovery
Trade view errors (V8.1):
- Broker disconnected: banner with retry and auto-reconnect.
- Order rejected: show rejection reason in order row.
- Session crashed: show "Session ended unexpectedly" with restart action.

Ensure errors are scoped to the session and do not affect other tabs.
Auto-reconnect should back off and surface a "lost" heartbeat if reconnection fails.

### 16. Settings, commands, and menus
Update commands and settings:
- Command routing in `commands/tradeCommands.ts`.
- Keybindings for Kill Switch and Trade panel focus.
- Settings entry points from Trade panel and Trade view via `workbench.action.openSettings` with `quantlab.trading` query.

### 17. Documentation and patch tracking
- Add `extensions/quantlab/docs/TRADING_SETUP.md` with Alpaca setup steps.
- Track any workbench patches in `extensions/quantlab/docs/PATCHES_PHASE_5.md`.

### 18. Implementation checklist (file-by-file)
Extension core:
- [ ] `extensions/quantlab/src/types/trading.ts`
- [ ] `extensions/quantlab/src/types/tradeMessages.ts`
- [ ] `extensions/quantlab/src/core/trading/SessionManager.ts`
- [ ] `extensions/quantlab/src/core/broker/BrokerAdapter.ts`
- [ ] `extensions/quantlab/src/core/broker/AlpacaAdapter.ts`
- [ ] `extensions/quantlab/src/core/broker/MockBrokerAdapter.ts`
- [ ] `extensions/quantlab/src/utils/secureStorage.ts`

Trade view:
- [ ] `extensions/quantlab/src/views/trade/TradeViewProvider.ts`
- [ ] `extensions/quantlab/src/views/trade/TradeWebview.ts`
- [ ] `extensions/quantlab/src/views/trade/KillSwitch.ts`
- [ ] `extensions/quantlab/webview/trade/index.ts`
- [ ] `extensions/quantlab/webview/trade/trade.ts`
- [ ] `extensions/quantlab/webview/trade/trade.css`
- [ ] `extensions/quantlab/webview/trade/states/noSession.ts`
- [ ] `extensions/quantlab/webview/trade/states/activeSession.ts`

Trade panel:
- [ ] `extensions/quantlab/src/panels/trade/TradePanelProvider.ts`
- [ ] `extensions/quantlab/src/panels/trade/TradeTreeProvider.ts`

Chart integration:
- [ ] `extensions/quantlab/src/views/chart/ChartViewProvider.ts`
- [ ] `extensions/quantlab/src/views/chart/TradeOverlayManager.ts`

Commands and configuration:
- [ ] `extensions/quantlab/src/commands/tradeCommands.ts`
- [ ] `extensions/quantlab/package.json` (custom editor, commands, menus, settings)

Docs and patches:
- [ ] `extensions/quantlab/docs/TRADING_SETUP.md`
- [ ] `extensions/quantlab/docs/PATCHES_PHASE_5.md` (if needed)

## Testing and Verification

### Unit tests
- SessionManager lifecycle (start, pause, resume, stop).
- Kill Switch policy execution (flatten, cancelOnly, custom).
- Requirements gating logic (backtest, paper, complexity).
- Risk status calculation and alert emission.
- Broker adapter mocks and mapping.
- TradeState persistence (sessionId + scrollPosition restore).
- Update routing drops stale/out-of-order events.

### Integration tests
- Start paper session updates Trade view and Trade panel.
- Kill Switch executes immediately for paper and confirms for live.
- View-Only complexity blocks live trading.
- Positions/orders updates render in Trade view tables.
- View in Chart attaches overlays and locks symbol/timeframe.
- Session stop removes overlays and returns Trade view to No Session state.
- Global symbol/timeframe changes do not alter active sessions.
- Broker reconnect restores heartbeat state without tab reload.

### Manual verification checklist
- Trade panel auto-expands on Trade view entry.
- No Session state shows checklist with required and recommended items.
- Start Live is disabled when gating fails, with explanation.
- Active Session shows heartbeat status and updates in real time.
- Kill Switch label matches policy and executes correctly.
- Order rejection shows reason and is visually flagged.
- Broker disconnect banner appears and reconnects.
- View in Chart shows fills/orders overlays in real time.
- Scroll position restores after tab reload.

## Exit Gates
- Trade view renders both No Session and Active Session states.
- Trade panel drives session control and reflects live status.
- Kill Switch works with correct policy and confirmation behavior.
- Safety gating blocks View-Only live trading and warns on Partial.
- Broker integration supports connect, positions, orders, and live updates.
- Trade -> Chart integration shows live overlays.
- Error states and recovery actions are implemented.
- Unit and integration tests pass.

## Performance Targets
- Trade view initial render under 200 ms.
- Update rendering under 50 ms P95 for positions/orders changes.
- Kill Switch execution under 5 seconds.
- WebSocket update latency under 100 ms.

## Appendix: Trade View Error States (V8.1)
- Broker disconnected: banner with retry and auto-reconnect.
- Order rejected: reason shown in row with modify/resubmit action.
- Session crashed: message with logs and restart option.

## Appendix: Settings Matrix (Phase 5)
- `quantlab.trading.killSwitchPolicy`: flatten | cancelOnly | custom
- `quantlab.trading.killSwitchCustomActions`: array of actions
- `quantlab.trading.requireBacktest`: boolean
- `quantlab.trading.requirePaperTrading`: boolean
- `quantlab.trading.requireRiskReview`: boolean
- `quantlab.trading.dailyLossLimit`: number (USD)
- `quantlab.trading.maxPositionSize`: number (shares)
- `quantlab.trading.maxOpenOrders`: number

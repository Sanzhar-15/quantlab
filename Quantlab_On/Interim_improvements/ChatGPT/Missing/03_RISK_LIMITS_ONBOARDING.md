# Risk Limits + Onboarding Gaps

---

## 1) Risk Limit Defaults Don’t Match Plan Decisions

**Evidence**
- Extension setting `quantlab.trading.dailyLossLimit` is USD‑based with default `0` in `extensions/quantlab/package.json`.
- Engine defaults are `daily_loss_limit=1000` and `max_drawdown_percent=20` in `engine/quantlab/trading/risk.py`.
- Plan decision L74 requires **percentage‑based defaults** (daily loss 2%, drawdown 5%, consecutive losses 3).

**Impact**
- Default limits are too loose (or disabled entirely), violating safety requirements.

**Optimal Fix**
- Replace USD default with percentage‑based limits:
  - `dailyLossPercent = 0.02` (2%)
  - `maxDrawdownPercent = 0.05` (5%)
  - `consecutiveLossLimit = 3`
- Normalize all risk limits to % of equity in both UI + daemon.

---

## 2) Risk Limits Not Propagated to Daemon

**Evidence**
- Extension passes `maxExposure/maxPositionSize/maxDailyLoss` to daemon CLI in `LiveDaemonManager.ts`.
- Daemon CLI ignores those flags (`engine/quantlab/daemon/main.py` parses only session/broker/symbols).

**Impact**
- Daemon runs with defaults, ignoring user risk configuration.

**Optimal Fix**
- Update daemon CLI to accept risk limit args and map them to `SessionConfig.risk_limits`.
- Ensure IPC `session.start` includes `risk_limits` per Appendix_B.

---

## 3) Consecutive Loss Limit Not Exposed in UI

**Evidence**
- Engine implements `consecutive_loss_limit` in `engine/quantlab/risk/circuit_breaker.py`.
- No UI setting or pre‑trade display exists for it.

**Impact**
- Users can’t configure or verify a required circuit breaker limit.

**Optimal Fix**
- Add `quantlab.trading.consecutiveLossLimit` setting.
- Show it in Pre‑Trade Checklist and risk status UI.

---

## 4) First‑Run Risk Wizard Missing (Decision L74)

**Evidence**
- `extensions/quantlab/src/ui/onboarding/` contains Welcome/FeatureDiscovery only.
- No risk configuration wizard or required acknowledgment flow exists.

**Impact**
- Users can start live trading without reviewing or confirming limits.

**Optimal Fix**
- Add a first‑launch risk wizard that forces configuration before live trading.
- Persist “risk confirmed” state and re‑prompt if limits change.

---

## 5) Risk Disclosure Dialog Missing

**Evidence**
- No dialog for formal risk acknowledgment beyond checklist; no files in `extensions/quantlab/src/ui/dialogs/` for disclosure.

**Impact**
- Compliance/safety expectations in the plan aren’t met.

**Optimal Fix**
- Add a risk disclosure dialog that must be accepted before the first live session.

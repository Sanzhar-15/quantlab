# Phase 4 - Live Safety, Data Providers, and Reconciliation

Date: 2026-01-26
Status: Planning
Owner: Quantlab Eng

## Objectives
- Implement live market data provider (Alpaca) with staleness handling.
- Add strict exposure reservation and risk enforcement for orders.
- Implement fill and position reconciliation, drift detection, and emergency flatten.
- Add tamper-evident audit logging with 7-year retention.

## Spec Coverage
- Technical: 6.4, 9.7, 10.5-10.7, 11.4.1, 12.3
- Product: 4.4-4.5 (flatten + pre-trade validation), 5.5 (risk limits)
- Ops: 2.6.1-2.6.2 (flatten quote validation, out-of-hours)
- Test: 2.2 (G100-G105 reservation), 3.4, 5.3 (live vectors)
- Decisions: B10-B15, L71, L74-L76, E31

## Decision Constraints (must implement)
- Data provider: Alpaca Data + local CSV/Parquet only.
- Real-time data required for live trading.
- Provider failover deferred to V1.1.
- Corporate actions deferred to V1.1 (use adjusted data in V1.0).
- Default risk limits are conservative; reservation is strict.
- Audit logs retained 7 years, tamper-evident (hash chain).

## Implementation Plan
### 1) Data Provider Adapter Layer
- Implement DataProviderAdapter for Alpaca Data.
- Support quotes, bars, trades; historical bars for gap fill.
- Staleness monitor with warning/critical thresholds.
- Local CSV/Parquet as fallback for backtest only (not live).

### 2) Exposure Reservation Model
- Reserve exposure at order submission; release on fill/cancel/modify.
- Atomic reservation adjustments on order modification.
- Strict rejection if limits breached.
- UI displays reserved vs available exposure.

### 3) Risk Limits and Pre-Trade Validation
- Enforce defaults: daily loss 2%, drawdown 5%, consecutive losses 3, gross exposure 100%.
- Pre-trade checklist includes reservation, trust, broker, and paper-trading requirement.

### 4) Reconciliation and Drift Detection
- Fill reconciliation with idempotency and out-of-order buffering.
- Position reconciliation edge cases and discrepancy reporting.
- Drift detection alerts and escalation rules.

### 5) Emergency Flatten and Out-of-Hours
- Two-stage flatten with quote validation (IOC then market fallback).
- Out-of-hours modal choices; extended-hours availability check.

### 6) Audit Log
- Append-only audit log under `~/.quantlab/audit/` with hash chaining.
- Log orders, risk actions, flatten events, daemon lifecycle events.

## Target Code Locations
- New: `engine/quantlab/live/data/*`, `engine/quantlab/live/risk/*`.
- Update: `extensions/quantlab/src/core/trading/SessionManager.ts`.
- Update: `extensions/quantlab/src/core/broker/*` (idempotency + reconciliation hooks).
- Update: `extensions/quantlab/src/views/trade/*` for reservation UI.

## Tests and Validation (Phase Gate)
- Exposure reservation tests (G100-G105 + Test 3.4).
- Live trading vectors L001-L070 pass.
- Reconciliation failure tests (Test 8).

## Exit Criteria
- Live sessions use Alpaca data with staleness handling.
- Orders enforce strict reservation and risk checks.
- Reconciliation and audit logging active in live sessions.


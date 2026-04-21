# Phase 2 - Daemon Lifecycle and Safety Enforcement

Goal: Make daemon lifecycle robust and enforce live-trading safety gates.

## Lifecycle Alignment
- Fix CLI flags (symbols vs symbol) and update LiveDaemonManager.
- Emit a readiness signal or replace with socket+health check readiness.
- Ensure daemon start/stop/pause/resume flows are stable.

## Safety and Trust
- Enforce TrustManager and PreTradeChecklist before live sessions.
- Ensure workspace and strategy trust gating cannot be bypassed.
- Wire kill switch to daemon for live sessions; fallback to broker only for paper.
- Use daemon `update.check_allowed` to block updates during live trading.

## Credentials and Secrets
- Provide a secure flow for credentials into daemon (credentials.set) with SecretStorage fallback.
- Document credentials lifecycle and encryption expectations.

## Risk Limits and State
- Fix risk limit mapping (daily loss vs exposure).
- Ensure `SessionConfig` uses broker and symbol list correctly.
- Ensure position/order state hydration uses canonical formats and types.

## Acceptance Criteria
- Live daemon session starts via UI without manual CLI and survives UI restart.
- Trust and pre-trade gating enforced for live trading.
- Kill switch executes daemon-side flatten/cancel for live sessions.
- Update blocked while live session active.
- Credentials can be stored and verified end-to-end.

Dependencies: Phase 1.
Gate: required before Phase 3.

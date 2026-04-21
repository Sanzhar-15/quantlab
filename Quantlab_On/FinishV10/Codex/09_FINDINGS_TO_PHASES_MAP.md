# Findings to Phases Map

This maps key findings to the phases that resolve them.

## IPC and Transport
- Socket path mismatch -> Phase 1
- Auth handshake mismatch -> Phase 1
- Method/payload casing mismatch -> Phase 1
- Notification method mismatch -> Phase 1
- Windows transport missing -> Phase 1 (or explicit constraint in Phase 0)

## Daemon Lifecycle
- CLI flags mismatch -> Phase 2
- Readiness signal mismatch -> Phase 2
- Risk limit mapping -> Phase 2

## Safety and Trust
- TrustManager and PreTradeChecklist not enforced -> Phase 2
- Kill switch bypasses daemon -> Phase 2
- Update gating unused -> Phase 2

## UI and Workflow
- History search stub -> Phase 3
- Data panel placeholders -> Phase 3
- Debugger read command missing -> Phase 3
- Reconciliation/audit panels missing -> Phase 3

## Engine Completeness
- Alpaca live adapter missing -> Phase 4
- Real-time quotes -> Phase 4
- Reconciliation core -> Phase 4
- Intraday borrow fee proration -> Phase 4
- Corporate actions -> Phase 4

## Testing and Release
- Mock IPC tests only -> Phase 5
- Golden vectors not run -> Phase 5
- CI gaps -> Phase 5

## Operations
- Runbooks, monitoring, security review -> Phase 6

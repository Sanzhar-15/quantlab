# Phase 6 - Operations, Security, Governance

Goal: Production-ready operational posture and maintainability.

## Operations
- Runbook for daemon incidents (disconnects, recovery, reconciliation).
- Monitoring hooks and log aggregation strategy.
- Data retention policy for logs, audit ledger, and artifacts.

## Security
- Secrets management policy (OS keychain + encrypted fallback) with explicit UX.
- Threat modeling for IPC, token storage, and extension trust.
- Mandatory update policy for security patches.

## Governance
- Patch management policy for VS Code upstream merges.
- License and third-party notices validation.
- Change management and audit trail for live trading changes.

## Acceptance Criteria
- Runbook completed and validated via tabletop scenario.
- Security review pass with mitigations tracked.
- Upstream merge SOP and checklist in place.

Dependencies: Phase 5.

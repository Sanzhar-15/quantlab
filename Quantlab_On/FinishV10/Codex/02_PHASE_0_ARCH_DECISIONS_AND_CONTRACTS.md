# Phase 0 - Architecture Decisions and Contract Freeze

Goal: Establish a single source of truth for protocol, CLI, schemas, and live-trading ownership.

## Decisions (Must be Explicit)
1) Live trading authority: daemon-first (recommended) vs extension broker adapter.
2) IPC contract canonical schema: snake_case vs camelCase; wrapper shapes vs raw arrays.
3) Socket path standard and Windows transport strategy.
4) Update policy during live trading (block vs allow).
5) Python bundling: extension uses bundled Python or user Python.

## Work Items
- Create shared IPC schema package (JSON schema or TS+Python types).
- Define canonical method list and payloads (including `*_get` responses and notifications).
- Define standard envelope with `_meta` (protocolVersion, sessionId, sequence, stream).
- Unify CLI arguments (symbols, broker, timeframe, risk limits).
- Document migration strategy for any breaking changes.

## Deliverables
- `docs/ipc/` with canonical spec + generated types.
- `docs/cli/daemon-cli.md` with canonical flags.
- `docs/architecture/live-trading.md` confirming daemon-first or extension-first.
- Decision log update in `Quantlab_On/V10 Spec` (addendum).

## Acceptance Criteria
- Single canonical spec published and referenced by both Python and TS.
- All mismatched method names and payloads are identified and mapped.
- Explicit decision on Windows support for live trading.

Dependencies: none.
Gate: must complete before Phase 1.

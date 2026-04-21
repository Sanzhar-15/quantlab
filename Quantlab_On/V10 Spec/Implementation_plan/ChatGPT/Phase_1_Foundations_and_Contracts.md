# Phase 1 - Foundations, Schemas, and Protocol Contracts

Date: 2026-01-26
Status: Planning
Owner: Quantlab Eng

## Objectives
- Define shared schemas and IPC protocol consistent with approved decisions.
- Implement protocol ordering, ack/retry, buffering, and authentication.
- Establish error taxonomy, logging strategy, and audit log schema.
- Define calendar/timezone/decimal precision schemas.

## Spec Coverage
- Technical: 1.4, 6, 7, 8, 14.3-14.5, 15.3-15.4, 16, 17.4, 12.3
- Product: 7 (data file handling), 12 (code modification safety, schemas)
- Test: 7 (determinism)
- Decisions: A1-A6, E29-E30, N81-N100 (protocol + reliability)

## Decision Constraints (must implement)
- IPC = JSON-RPC 2.0 over Unix sockets/Named Pipes.
- Auth = socket permissions + per-session token file.
- Reliability = ack/retry for critical messages; bounded buffer for backpressure.
- API versioning required in protocol envelope.
- Timezone handling = UTC internal, display local, DST-safe.
- Debug format = Arrow (schema defined here).

## Implementation Plan
### 1) Shared Schema Registry
- Create schema root: `schemas/quantlab/`.
- Define JSON schemas for:
  - Strategy package manifest + hashing metadata.
  - DataRev and UniverseRev identifiers.
  - Market calendar config (14.3), timezone policy (14.4), decimal precision (14.5).
  - Artifact manifest + results/trades/equity/report schemas (17.x).
  - Error taxonomy payloads (16) with structured context.
  - Audit log entries (12.3) including hash chaining fields.
  - Debug file index metadata (Arrow file descriptors).
- Generate or manually map TS/Python models from schemas.

### 2) IPC Protocol and Versioning
- JSON-RPC 2.0 envelope fields:
  - `protocolVersion`, `sessionId`, `sequence`, `timestamp`, `payloadType`, `stream`.
- Version negotiation (15.4): UI advertises range; daemon selects version.
- Ordering guarantees (15.3): monotonic sequence per stream.

### 3) Reliability, Ack/Retry, Buffering
- Implement message rules from Appendix B.
- Critical messages require ACK and retry (3x).
- Important streams use bounded buffers; overflow triggers UI banner.
- Reconnect uses full snapshots before resuming streams.

### 4) IPC Authentication
- Token file: `~/.quantlab/sessions/{id}.token`.
- Require token on every JSON-RPC request.
- Enforce owner-only permissions on sockets/pipes.

### 5) Error Taxonomy + Logging Strategy
- Implement error codes with categories, recoverable flag, and user action hints.
- Logging sinks:
  - Daemon logs (session-scoped).
  - UI logs for user-visible issues.
  - Audit logs (tamper-evident) for live trading actions.

### 6) Deterministic Hashing + Reproducibility
- Implement Tech 1.4 hashing in Python (authoritative).
- Store environment snapshots in artifact manifest.
- NFC normalization and exclusions list.

### 7) Calendar/Timezone/DST
- Calendar schema for exchange holidays.
- UTC internal timestamps, local display conversion.
- DST test vectors included in validation set.

## Target Code Locations
- New: `schemas/quantlab/*`.
- New: `engine/quantlab/protocol/*`.
- Update: `extensions/quantlab/src/types/engine.ts` (protocol events).
- Update: `extensions/quantlab/src/core/state/HistoryState.ts` (manifest metadata).

## Tests and Validation (Phase Gate)
- Engine unit test baseline >= 80% (D25).
- Schema validation tests (TS + Python).
- Protocol ordering, ack/retry, buffer overflow, and auth tests.
- Hashing determinism tests with fixed fixtures.

## Exit Criteria
- Schemas and protocol envelope defined and validated.
- Authenticated JSON-RPC channel spec complete with reliability rules.
- Error taxonomy and logging strategy ready for integration.

## References
- Appendix B: IPC Message Catalog and Reliability Rules.


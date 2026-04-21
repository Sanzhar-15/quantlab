# Phase 1 - IPC Transport and Protocol Normalization

Goal: Make daemon <-> extension IPC reliable and spec-compliant.

## Core Fixes
1) Socket path and transport parity
   - Use one canonical socket path on all platforms.
   - Add named pipe server for Windows or document Linux/macOS-only.

2) Authentication handshake
   - Extension must send `authenticate` after optional `negotiate`.
   - Server should accept per-request `_auth` only after handshake or enforce token for each request.

3) Protocol negotiation
   - Ensure negotiation occurs before authentication and is compatible with fallback mode.
   - Make version negotiation results visible to client.

4) Message contract alignment
   - Rename methods and fields to canonical naming.
   - Normalize notifications to `positions.update`, `orders.update`, `fills.update`.
   - Standardize `positions.get` / `orders.get` / `fills.get` responses (array vs wrapper).

5) Reliability handling
   - Either fully implement ACK/resend on both sides or disable reliability layer and remove false guarantees.
   - Ensure buffer tiers and method mappings match canonical spec.

## Tasks
- Extension: update `SocketTransport` to use canonical socket path.
- Extension: implement auth handshake (`authenticate`) on connect.
- Extension: parse `_meta` and handle state snapshot message.
- Extension: normalize request payloads to canonical schema.
- Daemon: align handlers and response shapes with canonical schema.
- Daemon: emit `*.update` notifications with arrays if that is canonical.
- Shared: update integration tests to use real daemon contract.

## Acceptance Criteria
- End-to-end IPC connect/auth works on Linux/macOS.
- Protocol negotiation + auth succeeds; client has protocolVersion.
- `session.start`, `order.submit`, `positions.get`, `orders.get`, `fills.get` succeed with correct data.
- Notifications are received and handled by UI.
- IPC integration tests target daemon contract and pass.

Dependencies: Phase 0.
Gate: required before Phase 2.

# Appendix B - IPC Message Catalog and Reliability Rules

Date: 2026-01-26
Status: Planning (Authoritative for Phase 1)
Owner: Engine + Platform

## Envelope (JSON-RPC 2.0)
Fields required on all messages:
- `protocolVersion`
- `sessionId`
- `sequence`
- `timestamp`
- `payloadType`
- `stream`

## Reliability Classes
- **Critical (ACK required)**: retry 3x with exponential backoff.
- **Important (best-effort + snapshot on reconnect)**: buffered, bounded, may drop oldest on overflow.
- **Telemetry (fire-and-forget)**: dropped when buffer full.

## Message Types and Rules
| Stream | Payload Type | Class | Ack | Buffer | Snapshot on Reconnect | Notes |
|--------|--------------|-------|-----|--------|------------------------|-------|
| control | session.start | Critical | Yes | None | N/A | Start live or paper session |
| control | session.stop | Critical | Yes | None | N/A | Stop session gracefully |
| control | session.pause | Critical | Yes | None | N/A | Pause strategy |
| control | session.resume | Critical | Yes | None | N/A | Resume strategy |
| control | order.submit | Critical | Yes | None | N/A | Includes idempotency key |
| control | order.cancel | Critical | Yes | None | N/A | Cancel by order id |
| control | order.modify | Critical | Yes | None | N/A | Atomic reservation update |
| control | flatten.request | Critical | Yes | None | N/A | Two-stage flatten |
| control | risk.action | Critical | Yes | None | N/A | Circuit breaker, kill switch |
| state | positions.update | Important | No | 1000 | Yes | Full snapshot on reconnect |
| state | orders.update | Important | No | 1000 | Yes | Full snapshot on reconnect |
| state | fills.update | Important | No | 1000 | Yes | Can replay last N |
| state | performance.update | Important | No | 1000 | Yes | Snapshot of P&L |
| state | activity.update | Important | No | 1000 | Yes | Activity log entries |
| status | heartbeat | Telemetry | No | 100 | N/A | 5s heartbeat |
| status | connection.status | Important | No | 1000 | Yes | Broker connectivity |
| status | risk.alert | Important | No | 1000 | Yes | Warning/critical alerts |
| status | error.state | Important | No | 1000 | Yes | Structured errors |
| logs | log.entry | Telemetry | No | 1000 | No | UI log stream |

## Buffer Overflow Behavior
- Important streams: drop oldest, set UI banner "data degraded".
- Telemetry streams: drop silently.

## Reconnect Semantics
On reconnect:
1. Authenticate with token.
2. Receive full snapshots for positions, orders, fills (last N), performance.
3. Resume stream updates.


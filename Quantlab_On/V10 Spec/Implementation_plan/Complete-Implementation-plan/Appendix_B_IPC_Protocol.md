# Appendix B: IPC Message Catalog and Reliability Rules

**Source**: ChatGPT plan (enhanced with Claude details)
**Status**: Authoritative for IPC protocol
**Owner**: Engine + Platform

---

## Protocol Overview

- **Format**: JSON-RPC 2.0
- **Transport**: Unix sockets (Linux/macOS), Named Pipes (Windows)
- **Authentication**: OS permissions (0600) + per-session token file
- **Versioning**: Required in envelope, negotiated on connect

---

## Envelope Format

All messages use JSON-RPC 2.0 with extended fields:

```json
{
  "jsonrpc": "2.0",
  "method": "order.submit",
  "params": {
    "symbol": "AAPL",
    "side": "BUY",
    "quantity": 100,
    "order_type": "MARKET"
  },
  "id": "req-001",
  "_meta": {
    "protocolVersion": "1.0",
    "sessionId": "sess-abc123",
    "sequence": 42,
    "timestamp": "2026-01-26T14:30:00.000Z",
    "stream": "control"
  }
}
```

### Required Envelope Fields

| Field | Type | Description |
|-------|------|-------------|
| `jsonrpc` | string | Always "2.0" |
| `method` | string | Message type (e.g., "order.submit") |
| `params` | object | Payload data |
| `id` | string | Request ID (omit for notifications) |
| `_meta.protocolVersion` | string | Protocol version (e.g., "1.0") |
| `_meta.sessionId` | string | Session identifier |
| `_meta.sequence` | number | Monotonic sequence number per stream |
| `_meta.timestamp` | string | ISO 8601 timestamp |
| `_meta.stream` | string | Stream name (control/state/status/logs) |

---

## Reliability Classes

### Critical (ACK Required)

- **Retry**: 3x with exponential backoff (100ms, 500ms, 2s)
- **Timeout**: 5 seconds per attempt
- **Failure**: Show error to user, do not proceed
- **Use for**: Orders, session control, flatten requests

### Important (Best-Effort + Snapshot)

- **Buffer**: 1000 messages per stream
- **Overflow**: Drop oldest, show UI banner "data degraded"
- **Reconnect**: Full snapshot sent before resuming stream
- **Use for**: Positions, orders, fills, performance, alerts

### Telemetry (Fire-and-Forget)

- **Buffer**: 100 messages
- **Overflow**: Drop silently
- **Reconnect**: No replay
- **Use for**: Heartbeats, logs

---

## Message Catalog

### Control Stream (Critical)

| Method | Direction | Params | Description |
|--------|-----------|--------|-------------|
| `session.start` | UI→Daemon | `SessionConfig` | Start live/paper session |
| `session.stop` | UI→Daemon | `{ graceful: bool }` | Stop session |
| `session.pause` | UI→Daemon | `{}` | Pause strategy |
| `session.resume` | UI→Daemon | `{}` | Resume strategy |
| `order.submit` | UI→Daemon | `OrderRequest` | Submit new order |
| `order.cancel` | UI→Daemon | `{ order_id: string }` | Cancel order |
| `order.modify` | UI→Daemon | `OrderModification` | Modify pending order |
| `flatten.request` | UI→Daemon | `{ confirm_code: string }` | Emergency flatten |
| `risk.action` | UI→Daemon | `{ action: string }` | Circuit breaker, kill switch |

### State Stream (Important)

| Method | Direction | Params | Description |
|--------|-----------|--------|-------------|
| `positions.update` | Daemon→UI | `Position[]` | Position updates |
| `orders.update` | Daemon→UI | `Order[]` | Order status updates |
| `fills.update` | Daemon→UI | `Fill[]` | Fill notifications |
| `performance.update` | Daemon→UI | `Performance` | P&L, metrics |
| `activity.update` | Daemon→UI | `ActivityEntry[]` | Activity log entries |

### Status Stream (Important/Telemetry)

| Method | Direction | Class | Params | Description |
|--------|-----------|-------|--------|-------------|
| `heartbeat` | Daemon→UI | Telemetry | `{ timestamp }` | 5s heartbeat |
| `connection.status` | Daemon→UI | Important | `ConnectionStatus` | Broker connectivity |
| `risk.alert` | Daemon→UI | Important | `RiskAlert` | Warning/critical alerts |
| `error.state` | Daemon→UI | Important | `ErrorState` | Structured errors |

### Logs Stream (Telemetry)

| Method | Direction | Params | Description |
|--------|-----------|--------|-------------|
| `log.entry` | Daemon→UI | `LogEntry` | Log messages |

---

## Type Definitions

### SessionConfig

```typescript
interface SessionConfig {
  id: string;                    // Session ID
  strategy_path: string;         // Path to strategy file
  broker: 'alpaca' | 'mock';     // Broker adapter
  mode: 'live' | 'paper';        // Trading mode
  risk_limits: RiskLimits;       // Risk configuration
  symbols: string[];             // Symbols to trade
}
```

### OrderRequest

```typescript
interface OrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  order_type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
  limit_price?: number;          // Required for LIMIT, STOP_LIMIT
  stop_price?: number;           // Required for STOP, STOP_LIMIT
  time_in_force: 'GFD' | 'GTC' | 'IOC';
  client_order_id: string;       // Idempotency key
}
```

### Position

```typescript
interface Position {
  symbol: string;
  quantity: number;              // Positive = long, negative = short
  avg_entry_price: number;
  market_value: number;
  unrealized_pnl: number;
  realized_pnl: number;
}
```

### Fill

```typescript
interface Fill {
  order_id: string;
  fill_id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  timestamp: string;
  commission: number;
  is_partial: boolean;
}
```

### RiskAlert

```typescript
interface RiskAlert {
  level: 'warning' | 'critical';
  type: 'daily_loss' | 'drawdown' | 'exposure' | 'consecutive_loss';
  message: string;
  current_value: number;
  threshold: number;
  action_required: boolean;
}
```

### ConnectionStatus

```typescript
interface ConnectionStatus {
  broker: 'connected' | 'disconnected' | 'reconnecting';
  data_feed: 'streaming' | 'delayed' | 'unavailable';
  latency_ms: number;
  last_quote_age_ms: number;
}
```

---

## Reconnect Semantics

### On UI Disconnect

1. Daemon continues running
2. Buffers Important messages (up to 1000 per stream)
3. Drops Telemetry when buffer full

### On UI Reconnect

1. UI sends `auth` with token
2. Daemon validates token
3. Daemon sends full snapshots:
   - `positions.update` (all positions)
   - `orders.update` (all open orders)
   - `fills.update` (last N fills)
   - `performance.update` (current P&L)
4. Resume streaming from sequence N+1

### Reconnect Sequence Diagram

```
UI                                    Daemon
 │                                      │
 │  ──── connect (socket) ────────────► │
 │                                      │
 │  ──── auth { token } ──────────────► │
 │                                      │
 │  ◄──── auth_result { ok } ────────── │
 │                                      │
 │  ◄──── positions.update [snapshot] ─ │
 │  ◄──── orders.update [snapshot] ──── │
 │  ◄──── fills.update [last N] ─────── │
 │  ◄──── performance.update [current]  │
 │                                      │
 │  ◄──── positions.update [stream] ─── │
 │  ◄──── fills.update [stream] ─────── │
 │                                      │
```

---

## Buffer Overflow Behavior

### Important Streams

When buffer exceeds 1000 messages:
1. Drop oldest messages
2. Set `_meta.overflow: true` on next message
3. UI shows banner: "Some updates may have been missed"

### Telemetry Streams

When buffer exceeds 100 messages:
1. Drop silently
2. No user notification (acceptable data loss)

---

## Error Handling

### JSON-RPC Errors

| Code | Message | Meaning |
|------|---------|---------|
| -32700 | Parse error | Invalid JSON |
| -32600 | Invalid Request | Not valid JSON-RPC |
| -32601 | Method not found | Unknown method |
| -32602 | Invalid params | Missing/invalid parameters |
| -32603 | Internal error | Daemon internal error |

### Application Errors

| Code | Message | Meaning |
|------|---------|---------|
| 1001 | Not authenticated | Missing/invalid token |
| 1002 | Session not found | Invalid session ID |
| 1003 | Session not active | Session paused/stopped |
| 2001 | Order rejected | Risk limit breach |
| 2002 | Order not found | Unknown order ID |
| 2003 | Order already filled | Cannot cancel filled order |
| 3001 | Broker disconnected | Broker connection lost |
| 3002 | Quote stale | Quote older than 30s |

---

## Version Negotiation

### On Connect

```json
// UI sends
{
  "jsonrpc": "2.0",
  "method": "negotiate",
  "params": {
    "supported_versions": ["1.0", "1.1"]
  },
  "id": "negotiate-1"
}

// Daemon responds
{
  "jsonrpc": "2.0",
  "result": {
    "selected_version": "1.0"
  },
  "id": "negotiate-1"
}
```

### Version Compatibility

- **Major version change**: Breaking, requires UI upgrade
- **Minor version change**: Backward compatible, new features optional

---

## Implementation Checklist

- [ ] JSON-RPC 2.0 parser/serializer
- [ ] Socket/pipe transport layer
- [ ] Token-based authentication
- [ ] Message buffering with overflow handling
- [ ] Reconnect with snapshot replay
- [ ] Sequence number tracking
- [ ] Error code mapping
- [ ] Version negotiation
- [ ] All message types implemented

---

*This appendix is authoritative for IPC protocol. Reference from Phase 1 implementation.*

# IPC Protocol and Message Handling Fixes

---

## FIX-P001: Missing IPC Message Types in Daemon (P0 - Critical)

**File**: `engine/quantlab/daemon/main.py`
**Issue**: The IPC Protocol (Appendix_B) specifies several message types that are not registered as daemon handlers or broadcast types:

| Missing Message | Class | Direction | Purpose |
|----------------|-------|-----------|---------|
| `order.modify` | Critical | UI → Daemon | Modify pending order |
| `performance.update` | Important | Daemon → UI | Performance metrics stream |
| `activity.update` | Telemetry | Daemon → UI | Strategy activity feed |
| `connection.status` | Important | Daemon → UI | Broker connection changes |
| `error.state` | Important | Daemon → UI | Error notifications |

**Fix**: Register missing handlers and add broadcast methods:

```python
# In _register_ipc_handlers():
self._ipc_server.register_handler("order.modify", self._handle_order_modify)

# Add broadcast methods for daemon-to-UI messages:
async def _broadcast_performance_update(self) -> None:
    """Send performance metrics to UI clients."""
    metrics = self._calculate_current_performance()
    await self._ipc_server.broadcast(Notification(
        message_type=MessageType.PERFORMANCE_UPDATE,
        params=metrics,
        session_id=self._session_id,
    ))

async def _broadcast_connection_status(self, status: str, details: dict) -> None:
    """Notify UI of broker connection status change."""
    await self._ipc_server.broadcast(Notification(
        message_type=MessageType.CONNECTION_STATUS,
        params={"status": status, **details},
        session_id=self._session_id,
    ))
```

Also add the missing `MessageType` enum values in `protocol/message.py`:
```python
class MessageType(str, Enum):
    # ... existing types ...
    PERFORMANCE_UPDATE = "performance.update"
    ACTIVITY_UPDATE = "activity.update"
    CONNECTION_STATUS = "connection.status"
    ERROR_STATE = "error.state"
    ORDER_MODIFY = "order.modify"
```

---

## FIX-P002: Reliability Manager Not Tracking All Critical Messages (P1 - High)

**File**: `engine/quantlab/protocol/reliability.py`
**Issue**: The reliability manager should track ACK for all Critical-class messages. Need to verify that `order.submit`, `order.cancel`, `order.modify`, `session.start/stop/pause/resume`, and `flatten.request` are all properly tracked for ACK with 3x retry + exponential backoff.

**Fix**: Verify and add message classification in the reliability config:
```python
CRITICAL_METHODS = {
    "session.start", "session.stop", "session.pause", "session.resume",
    "order.submit", "order.cancel", "order.modify",
    "flatten.request", "risk.action",
}

IMPORTANT_METHODS = {
    "positions.update", "orders.update", "fills.update",
    "performance.update", "connection.status", "risk.alert",
}

# In on_message_sent:
if message.type.value in CRITICAL_METHODS:
    self._pending_acks[message.id] = PendingMessage(
        message=message,
        sent_at=datetime.now(),
        retry_count=0,
        max_retries=3,
    )
```

---

## FIX-P003: State Snapshot on Reconnect May Be Stale (P1 - High)

**File**: `engine/quantlab/daemon/ipc.py:439-449`
**Issue**: On client reconnection, a state snapshot is sent. However, between the last disconnection and reconnection, multiple state changes may have occurred. The plan specifies that Important messages have a bounded buffer (1000) with state snapshots. Need to verify the snapshot includes the latest state, not a cached version.

**Fix**: Ensure snapshot is computed at reconnection time, not cached:
```python
# In _handle_client, after authentication:
if self._reliability:
    # Get FRESH snapshot at reconnection time
    snapshot = await self._reliability.get_reconnect_snapshot()
    if snapshot.positions or snapshot.orders:
        await client.send_result(None, {
            "type": "state_snapshot",
            "is_reconnect": True,
            "missed_message_count": snapshot.missed_count,
            "positions": snapshot.positions,
            "orders": snapshot.orders,
            "performance": snapshot.performance,
            "connectionStatus": snapshot.connection_status,
            "timestamp": datetime.now().isoformat(),
        })
```

---

## FIX-P004: JSON-RPC Error Codes Not Using Standard Values (P2 - Medium)

**File**: `engine/quantlab/daemon/ipc.py:521-530`
**Issue**: The `_process_message` method uses magic numbers for JSON-RPC error codes (-32700, -32600, -32601, -32603). These should reference the `ErrorCode` enum from `protocol/message.py` for consistency.

**Fix**:
```python
# Replace magic numbers with ErrorCode enum:
from quantlab.protocol.message import ErrorCode

# -32700 → ErrorCode.PARSE_ERROR
# -32600 → ErrorCode.INVALID_REQUEST
# -32601 → ErrorCode.METHOD_NOT_FOUND
# -32603 → ErrorCode.INTERNAL_ERROR

await client.send_error(None, ErrorCode.PARSE_ERROR, f"Parse error: {e}")
await client.send_error(msg_id, ErrorCode.INVALID_REQUEST, "...")
await client.send_error(msg_id, ErrorCode.METHOD_NOT_FOUND, f"Method not found: {method}")
await client.send_error(msg_id, ErrorCode.INTERNAL_ERROR, f"Internal error: {e}")
```

---

## FIX-P005: Version Negotiation Finds Lowest, Not Highest (P2 - Medium)

**File**: `engine/quantlab/daemon/ipc.py:484-489`
**Issue**: The version negotiation loop iterates `SUPPORTED_VERSIONS` and picks the first match. If `SUPPORTED_VERSIONS = ["1.0"]`, this works fine because there's only one version. But if future versions are added (e.g., `["2.0", "1.0"]`), it would pick 2.0 first which may not be the highest mutually supported version depending on iteration order.

**Fix**: Sort versions and pick highest mutually supported:
```python
# Find highest mutually supported version
mutual = set(SUPPORTED_VERSIONS) & set(client_versions)
if not mutual:
    # ... error handling
    return None

# Sort using semantic versioning comparison
negotiated = sorted(mutual, key=lambda v: tuple(int(x) for x in v.split(".")))[-1]
```

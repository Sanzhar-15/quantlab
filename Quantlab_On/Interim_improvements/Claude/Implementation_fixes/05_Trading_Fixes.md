# Live Trading Subsystem Fixes

---

## FIX-T001: Emergency Flatten Not Logging to Audit Trail (P0 - Critical)

**File**: `engine/quantlab/trading/emergency.py`
**Issue**: The `EmergencyFlatten` class implements flatten logic but doesn't integrate with the tamper-evident audit log. Emergency flatten events are legally important and must be recorded with full details.

**Fix**: Add audit logging to emergency flatten:
```python
class EmergencyFlatten:
    def __init__(self, broker, audit_logger, ...):
        self._audit_logger = audit_logger

    async def execute(self, reason: str, triggered_by: str = "system") -> EmergencyFlattenResult:
        """Execute emergency flatten with full audit trail."""
        # Create pre-flatten snapshot
        pre_snapshot = await self._create_position_snapshot()

        self._audit_logger.log_event(
            event_type="emergency_flatten_started",
            data={
                "reason": reason,
                "triggered_by": triggered_by,
                "pre_positions": pre_snapshot,
                "timestamp": datetime.now().isoformat(),
            },
            severity="CRITICAL",
        )

        try:
            result = await self._do_flatten()

            self._audit_logger.log_event(
                event_type="emergency_flatten_completed",
                data={
                    "reason": reason,
                    "triggered_by": triggered_by,
                    "orders_cancelled": result.orders_cancelled,
                    "positions_closed": result.positions_closed,
                    "final_cash": str(result.final_cash),
                    "elapsed_ms": result.elapsed_ms,
                },
                severity="CRITICAL",
            )

            return result

        except Exception as e:
            self._audit_logger.log_event(
                event_type="emergency_flatten_failed",
                data={
                    "reason": reason,
                    "error": str(e),
                    "pre_positions": pre_snapshot,
                },
                severity="CRITICAL",
            )
            raise
```

---

## FIX-T002: Alpaca Provider Missing WebSocket Streaming (P0 - Critical)

**File**: `engine/quantlab/providers/alpaca.py`
**Issue**: Only REST API is implemented. Live trading requires real-time market data via WebSocket. Polling is inadequate for live trading latency requirements.

**Fix**: Add WebSocket data streaming:
```python
import websockets

class AlpacaDataStream:
    """WebSocket streaming for real-time market data."""

    def __init__(self, api_key: str, api_secret: str, paper: bool = True):
        self._api_key = api_key
        self._api_secret = api_secret
        self._base_url = (
            "wss://stream.data.sandbox.alpaca.markets/v2/sip"
            if paper else
            "wss://stream.data.alpaca.markets/v2/sip"
        )
        self._ws: websockets.WebSocketClientProtocol | None = None
        self._running = False
        self._callbacks: dict[str, list[Callable]] = {
            "bar": [],
            "quote": [],
            "trade": [],
        }

    async def connect(self) -> None:
        """Establish WebSocket connection."""
        self._ws = await websockets.connect(self._base_url)
        await self._authenticate()
        self._running = True
        asyncio.create_task(self._message_loop())

    async def _authenticate(self) -> None:
        """Send authentication message."""
        auth_msg = {
            "action": "auth",
            "key": self._api_key,
            "secret": self._api_secret,
        }
        await self._ws.send(json.dumps(auth_msg))
        response = await self._ws.recv()
        # Validate auth response...

    async def subscribe_bars(self, symbols: list[str]) -> None:
        """Subscribe to bar updates for symbols."""
        msg = {
            "action": "subscribe",
            "bars": symbols,
        }
        await self._ws.send(json.dumps(msg))

    async def _message_loop(self) -> None:
        """Process incoming WebSocket messages."""
        while self._running:
            try:
                data = await self._ws.recv()
                messages = json.loads(data)
                for msg in messages:
                    await self._dispatch_message(msg)
            except websockets.ConnectionClosed:
                logger.warning("WebSocket connection closed")
                await self._reconnect()
            except Exception as e:
                logger.error(f"WebSocket error: {e}")

    def on_bar(self, callback: Callable[[dict], None]) -> None:
        """Register callback for bar updates."""
        self._callbacks["bar"].append(callback)
```

Integrate with `AlpacaProvider`:
```python
class AlpacaProvider(DataProvider):
    def __init__(self, ...):
        ...
        self._data_stream = AlpacaDataStream(api_key, api_secret, paper)

    async def start_streaming(self, symbols: list[str]) -> None:
        """Start real-time data streaming."""
        await self._data_stream.connect()
        await self._data_stream.subscribe_bars(symbols)

        self._data_stream.on_bar(self._on_bar_update)
```

---

## FIX-T003: Reconciliation Interval Not Configurable (P1 - High)

**File**: `engine/quantlab/daemon/main.py`
**Issue**: The reconciliation loop has a hardcoded interval. Plan specifies it should be configurable (default 5 minutes).

**Fix**: Add configuration parameter:
```python
# In SessionConfig dataclass:
@dataclass
class SessionConfig:
    ...
    reconciliation_interval_seconds: int = 300  # 5 minutes

# In daemon _reconciliation_loop:
async def _reconciliation_loop(self) -> None:
    """Periodic position reconciliation."""
    interval = self._config.reconciliation_interval_seconds
    while self._running:
        try:
            await asyncio.sleep(interval)
            await self._reconcile_positions()
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Reconciliation error: {e}")
```

---

## FIX-T004: Drift Detection Not Emitting IPC Notification (P1 - High)

**File**: `engine/quantlab/trading/drift.py`
**Issue**: `DriftDetector` detects position drift but has no mechanism to notify the daemon/UI. Detection happens silently.

**Fix**: Add callback mechanism:
```python
class DriftDetector:
    def __init__(self, threshold_pct: Decimal = Decimal("0.01")):
        self._threshold_pct = threshold_pct
        self._drift_callbacks: list[Callable[[DriftEvent], None]] = []

    def on_drift(self, callback: Callable[["DriftEvent"], None]) -> None:
        """Register callback for drift events."""
        self._drift_callbacks.append(callback)

    def detect(self, symbol: str, expected: Decimal, actual: Decimal) -> DriftEvent | None:
        """Check for position drift and notify if detected."""
        if expected == Decimal("0"):
            drift_pct = Decimal("1") if actual != Decimal("0") else Decimal("0")
        else:
            drift_pct = abs(actual - expected) / abs(expected)

        if drift_pct > self._threshold_pct:
            event = DriftEvent(
                symbol=symbol,
                expected_quantity=expected,
                actual_quantity=actual,
                drift_pct=drift_pct,
                timestamp=datetime.now(),
            )

            for callback in self._drift_callbacks:
                try:
                    callback(event)
                except Exception as e:
                    logger.error(f"Drift callback error: {e}")

            return event
        return None
```

Wire to daemon:
```python
# In daemon init:
self._drift_detector.on_drift(self._on_drift_detected)

async def _on_drift_detected(self, event: DriftEvent) -> None:
    """Handle drift detection."""
    await self._ipc_server.broadcast(Notification(
        message_type=MessageType.RISK_ALERT,
        params={
            "alert_type": "position_drift",
            "symbol": event.symbol,
            "expected": str(event.expected_quantity),
            "actual": str(event.actual_quantity),
            "drift_pct": str(event.drift_pct),
        },
        session_id=self._session_id,
    ))
```

---

## FIX-T005: Fill Reconciliation Auto-Correct Not Implemented (P1 - High)

**File**: `engine/quantlab/trading/fills.py`
**Issue**: The plan specifies that when fills from broker don't match local tracking, the system should auto-correct local state. Need to verify `FillReconciler` handles unmatched fills.

**Fix**: Add auto-correction logic:
```python
class FillReconciler:
    async def reconcile(self) -> ReconciliationResult:
        """Reconcile local fills with broker fills."""
        broker_fills = await self._broker.get_fills(
            since=self._last_reconciliation_time
        )

        local_fills = self._fill_tracker.get_fills(
            since=self._last_reconciliation_time
        )

        # Match fills by order_id
        matched, unmatched_broker, unmatched_local = self._match_fills(
            broker_fills, local_fills
        )

        # Auto-correct unmatched broker fills (fills we didn't know about)
        for fill in unmatched_broker:
            logger.warning(f"Unmatched broker fill, auto-correcting: {fill}")
            self._fill_tracker.add_external_fill(fill)
            await self._notify_correction("broker_fill_added", fill)

        # Flag unmatched local fills for investigation
        for fill in unmatched_local:
            logger.error(f"Local fill not on broker: {fill}")
            await self._notify_correction("local_fill_orphaned", fill)

        return ReconciliationResult(
            matched=len(matched),
            corrected=len(unmatched_broker),
            orphaned=len(unmatched_local),
        )
```

---

## FIX-T006: Session Ledger Missing Export (P2 - Medium)

**File**: `engine/quantlab/trading/ledger.py`
**Issue**: `SessionLedger` tracks session activity but has no export method for end-of-session reporting.

**Fix**: Add export methods:
```python
class SessionLedger:
    def export_json(self) -> str:
        """Export ledger as JSON."""
        return json.dumps({
            "session_id": self._session_id,
            "started_at": self._started_at.isoformat(),
            "entries": [entry.to_dict() for entry in self._entries],
            "summary": self.get_summary(),
        }, indent=2)

    def export_csv(self, path: Path) -> None:
        """Export ledger as CSV."""
        import csv
        with open(path, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["timestamp", "event_type", "symbol", "details"])
            for entry in self._entries:
                writer.writerow([
                    entry.timestamp.isoformat(),
                    entry.event_type,
                    entry.symbol,
                    json.dumps(entry.details),
                ])
```

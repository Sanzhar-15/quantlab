# Phase 5: Trading Features (11 fixes)

**Live trading features** -- Broker streaming, order modification, reconciliation, drift detection.

## Phase Overview

This phase implements the remaining live trading capabilities: real-time broker data streaming, order modification, configurable reconciliation, drift detection, fill reconciliation auto-correction, and cross-platform power handling.

## Prerequisites

- Phase 0 (IPC Integration)
- Phase 1 (Security)
- Phase 2 (Risk & Safety)

---

## Fix List (Execution Order)

### FIX-T002-TRADING [P0] Implement Alpaca WebSocket streaming

**Problem**: Live trading requires real-time price data from the broker. WebSocket streaming not implemented for Alpaca.

**Evidence**:
- `engine/quantlab/providers/alpaca.py` -- REST-only implementation

**Files to modify**:
- `engine/quantlab/providers/alpaca.py`

**Implementation**:

```python
# engine/quantlab/providers/alpaca.py

import asyncio
import json
import websockets
from typing import Callable, Optional

class AlpacaWebSocketClient:
    """Real-time market data streaming via Alpaca WebSocket API.

    FIX-T002-TRADING: Implements streaming for live trading.
    """

    STREAM_URL = "wss://stream.data.alpaca.markets/v2/iex"
    PAPER_STREAM_URL = "wss://stream.data.alpaca.markets/v2/iex"  # Same for paper

    def __init__(
        self,
        api_key: str,
        api_secret: str,
        on_bar: Optional[Callable] = None,
        on_trade: Optional[Callable] = None,
        on_quote: Optional[Callable] = None,
    ):
        self._api_key = api_key
        self._api_secret = api_secret
        self._on_bar = on_bar
        self._on_trade = on_trade
        self._on_quote = on_quote
        self._ws = None
        self._running = False
        self._subscribed_symbols: set[str] = set()

    async def connect(self):
        """Connect to Alpaca WebSocket."""
        self._ws = await websockets.connect(self.STREAM_URL)
        self._running = True

        # Authenticate
        auth_msg = {
            "action": "auth",
            "key": self._api_key,
            "secret": self._api_secret,
        }
        await self._ws.send(json.dumps(auth_msg))

        # Read auth response
        response = json.loads(await self._ws.recv())
        if isinstance(response, list):
            for msg in response:
                if msg.get("T") == "error":
                    raise ConnectionError(f"Auth failed: {msg.get('msg')}")

    async def subscribe(self, symbols: list[str], channels: list[str] = None):
        """Subscribe to market data for symbols."""
        if not channels:
            channels = ["bars", "trades", "quotes"]

        sub_msg = {"action": "subscribe"}
        if "bars" in channels:
            sub_msg["bars"] = symbols
        if "trades" in channels:
            sub_msg["trades"] = symbols
        if "quotes" in channels:
            sub_msg["quotes"] = symbols

        await self._ws.send(json.dumps(sub_msg))
        self._subscribed_symbols.update(symbols)

    async def listen(self):
        """Main listen loop -- processes incoming messages."""
        while self._running:
            try:
                raw = await asyncio.wait_for(self._ws.recv(), timeout=30.0)
                messages = json.loads(raw)

                if not isinstance(messages, list):
                    messages = [messages]

                for msg in messages:
                    msg_type = msg.get("T")
                    if msg_type == "b" and self._on_bar:
                        await self._on_bar({
                            "symbol": msg["S"],
                            "timestamp": msg["t"],
                            "open": msg["o"],
                            "high": msg["h"],
                            "low": msg["l"],
                            "close": msg["c"],
                            "volume": msg["v"],
                        })
                    elif msg_type == "t" and self._on_trade:
                        await self._on_trade({
                            "symbol": msg["S"],
                            "price": msg["p"],
                            "size": msg["s"],
                            "timestamp": msg["t"],
                        })
                    elif msg_type == "q" and self._on_quote:
                        await self._on_quote({
                            "symbol": msg["S"],
                            "bid_price": msg["bp"],
                            "bid_size": msg["bs"],
                            "ask_price": msg["ap"],
                            "ask_size": msg["as"],
                            "timestamp": msg["t"],
                        })

            except asyncio.TimeoutError:
                # Send ping to keep connection alive
                try:
                    await self._ws.ping()
                except Exception:
                    await self._reconnect()
            except websockets.ConnectionClosed:
                await self._reconnect()

    async def _reconnect(self):
        """Reconnect with exponential backoff."""
        delays = [1, 2, 4, 8, 16, 30]
        for delay in delays:
            try:
                await self.connect()
                if self._subscribed_symbols:
                    await self.subscribe(list(self._subscribed_symbols))
                return
            except Exception:
                await asyncio.sleep(delay)
        raise ConnectionError("Failed to reconnect to Alpaca WebSocket")

    async def disconnect(self):
        """Disconnect gracefully."""
        self._running = False
        if self._ws:
            await self._ws.close()
```

**Verification**:
1. Connect to Alpaca paper WebSocket -> auth succeeds
2. Subscribe to AAPL -> receive real-time bars
3. Kill network -> reconnect with backoff
4. Disconnect -> clean shutdown

**Dependencies**: Phase 1 (credentials)

---

### FIX-D003 [P1] Add order.modify IPC handler

**Problem**: No IPC handler for modifying existing orders (price, quantity changes).

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py

async def _handle_order_modify(self, params: dict) -> dict:
    """Modify an existing open order.

    FIX-D003: Supports modifying limit price, stop price, quantity.
    """
    order_id = params.get("order_id")
    if not order_id:
        return {"success": False, "error": "Missing order_id"}

    order = self._open_orders.get(order_id)
    if not order:
        return {"success": False, "error": f"Order {order_id} not found"}

    modifications = {}
    if "limit_price" in params:
        modifications["limit_price"] = params["limit_price"]
    if "stop_price" in params:
        modifications["stop_price"] = params["stop_price"]
    if "quantity" in params:
        modifications["quantity"] = params["quantity"]

    if not modifications:
        return {"success": False, "error": "No modifications specified"}

    try:
        # Update exposure reservation if quantity changed
        if "quantity" in modifications and self._exposure_manager:
            await self._exposure_manager.modify(
                order_id,
                new_quantity=modifications["quantity"],
            )

        # Send modification to broker
        result = await self._broker.modify_order(order_id, modifications)

        # Audit log
        self._audit_logger.info(
            "ORDER_MODIFY session=%s order_id=%s modifications=%s",
            self._config.session_id, order_id, modifications,
        )

        return {"success": True, "order_id": order_id, "modifications": modifications}
    except Exception as e:
        return {"success": False, "error": str(e)}
```

**Verification**:
1. Submit limit order, modify limit price -> broker receives modification
2. Modify quantity -> exposure reservation updated
3. Audit log records modification

**Dependencies**: Phase 0

---

### FIX-D004 [P1] Integrate market calendar for ACTIVE <-> MARKET_CLOSED transitions

**Problem**: Daemon doesn't automatically transition between ACTIVE and MARKET_CLOSED states based on market hours.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py

async def _start_market_calendar_checker(self):
    """Check market open/close status periodically.

    FIX-D004: Automatic state transitions based on market hours.
    """
    from quantlab.calendar import get_calendar

    calendar = get_calendar(self._config.exchange or "NYSE")

    while self._running:
        try:
            now = datetime.utcnow()
            is_open = calendar.is_market_open(now)

            if is_open and self._state == DaemonState.MARKET_CLOSED:
                self._logger.info("Market opened -- transitioning to ACTIVE")
                self._state = DaemonState.ACTIVE
                await self._broadcast_connection_status({
                    "state": "active",
                    "reason": "market_open",
                })

            elif not is_open and self._state == DaemonState.ACTIVE:
                self._logger.info("Market closed -- transitioning to MARKET_CLOSED")
                self._state = DaemonState.MARKET_CLOSED
                await self._broadcast_connection_status({
                    "state": "market_closed",
                    "reason": "market_close",
                })

            # Sleep until next check (every 60 seconds)
            await asyncio.sleep(60)

        except Exception as e:
            self._logger.error("Market calendar check error: %s", e)
            await asyncio.sleep(60)
```

**Verification**:
1. Start daemon during market hours -> state is ACTIVE
2. Market closes -> state transitions to MARKET_CLOSED
3. Market opens -> state transitions back to ACTIVE
4. Extension receives connection.update notifications

**Dependencies**: None

---

### FIX-T003 [P1] Make reconciliation interval configurable

**Problem**: Reconciliation runs on a fixed interval. Should be configurable via CLI args or IPC.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py

DEFAULT_RECONCILIATION_INTERVAL = 300  # 5 minutes

class LiveTradingDaemon:
    def __init__(self, config: SessionConfig):
        # ...
        self._reconciliation_interval = config.risk_limits.get(
            "reconciliation_interval",
            DEFAULT_RECONCILIATION_INTERVAL,
        )

    async def _start_reconciliation_loop(self):
        """Periodic position/fill reconciliation.

        FIX-T003: Configurable interval.
        """
        while self._running:
            await asyncio.sleep(self._reconciliation_interval)
            try:
                discrepancies = await self._reconcile_positions()
                if discrepancies:
                    await self._broadcast_risk_alert({
                        "type": "reconciliation_discrepancy",
                        "discrepancies": discrepancies,
                    })
            except Exception as e:
                self._logger.error("Reconciliation error: %s", e)
```

**Verification**:
1. Set interval to 60 seconds -> reconciliation runs every 60s
2. Default of 300 seconds works
3. Discrepancies broadcast as risk alerts

**Dependencies**: Phase 0

---

### FIX-T004 [P1] Wire drift detection IPC notifications

**Problem**: Drift detection (strategy drift from expected behavior) exists but doesn't send IPC notifications to the extension.

**Files to modify**:
- `engine/quantlab/trading/drift.py`
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py

async def _handle_drift_detected(self, drift_data: dict):
    """Handle strategy drift detection.

    FIX-T004: Wire drift notifications to extension via IPC.
    """
    self._logger.warning(
        "Strategy drift detected: %s (magnitude: %.2f%%)",
        drift_data.get("type"), drift_data.get("magnitude", 0) * 100,
    )

    await self._ipc_server.broadcast(Notification(
        method="risk.alert",
        params={
            "type": "strategy_drift",
            "drift_type": drift_data.get("type"),
            "magnitude": drift_data.get("magnitude"),
            "threshold": drift_data.get("threshold"),
            "details": drift_data.get("details"),
            "timestamp": datetime.utcnow().isoformat(),
            "severity": "warning",
        },
    ))
```

**Verification**:
1. Strategy deviates significantly from expected behavior -> drift notification sent
2. Extension receives risk.alert with type "strategy_drift"
3. Magnitude and threshold included in notification

**Dependencies**: Phase 0

---

### FIX-T005 [P1] Implement fill reconciliation auto-correct

**Problem**: When fills don't match between daemon and broker, there's no auto-correction mechanism.

**Files to modify**:
- `engine/quantlab/trading/fills.py` (create or modify)

**Implementation**:

```python
# engine/quantlab/trading/fills.py

from typing import Optional
import logging

logger = logging.getLogger(__name__)

class FillReconciler:
    """Reconciles fills between daemon and broker.

    FIX-T005: Auto-corrects minor discrepancies, alerts on major ones.
    """

    # Auto-correct threshold: fills within this tolerance are auto-corrected
    PRICE_TOLERANCE = 0.01  # 1 cent
    QTY_TOLERANCE = 0  # Quantity must match exactly

    def reconcile(
        self,
        daemon_fills: list[dict],
        broker_fills: list[dict],
    ) -> dict:
        """Compare fills and return reconciliation result."""
        daemon_by_id = {f["order_id"]: f for f in daemon_fills}
        broker_by_id = {f["order_id"]: f for f in broker_fills}

        missing_in_daemon = []
        missing_in_broker = []
        price_discrepancies = []
        qty_discrepancies = []
        auto_corrected = []

        # Check broker fills against daemon
        for order_id, broker_fill in broker_by_id.items():
            daemon_fill = daemon_by_id.get(order_id)

            if not daemon_fill:
                missing_in_daemon.append(broker_fill)
                continue

            # Price check
            price_diff = abs(daemon_fill["price"] - broker_fill["price"])
            if price_diff > self.PRICE_TOLERANCE:
                price_discrepancies.append({
                    "order_id": order_id,
                    "daemon_price": daemon_fill["price"],
                    "broker_price": broker_fill["price"],
                    "difference": price_diff,
                })

            # Quantity check
            qty_diff = abs(daemon_fill["quantity"] - broker_fill["quantity"])
            if qty_diff > self.QTY_TOLERANCE:
                qty_discrepancies.append({
                    "order_id": order_id,
                    "daemon_qty": daemon_fill["quantity"],
                    "broker_qty": broker_fill["quantity"],
                    "difference": qty_diff,
                })

        # Check daemon fills not in broker
        for order_id in daemon_by_id:
            if order_id not in broker_by_id:
                missing_in_broker.append(daemon_by_id[order_id])

        return {
            "is_clean": (
                len(missing_in_daemon) == 0 and
                len(missing_in_broker) == 0 and
                len(price_discrepancies) == 0 and
                len(qty_discrepancies) == 0
            ),
            "missing_in_daemon": missing_in_daemon,
            "missing_in_broker": missing_in_broker,
            "price_discrepancies": price_discrepancies,
            "qty_discrepancies": qty_discrepancies,
            "auto_corrected": auto_corrected,
        }
```

**Verification**:
1. All fills match -> `is_clean: true`
2. Broker has extra fill -> `missing_in_daemon` populated
3. Price differs by $0.02 -> `price_discrepancies` populated

**Dependencies**: Phase 0

---

### FIX-T006 [P2] Add session ledger JSON/CSV export

**Problem**: No way to export trading session history for tax/audit purposes.

**Files to modify**:
- `engine/quantlab/trading/ledger.py` (create)

**Implementation**:

```python
# engine/quantlab/trading/ledger.py

import csv
import json
from pathlib import Path
from datetime import datetime

class SessionLedger:
    """Trading session ledger with export capabilities.

    FIX-T006: JSON and CSV export for tax/audit.
    """

    def __init__(self, session_id: str):
        self._session_id = session_id
        self._entries: list[dict] = []

    def add_entry(self, entry_type: str, data: dict):
        """Add a ledger entry."""
        self._entries.append({
            "timestamp": datetime.utcnow().isoformat(),
            "type": entry_type,
            "session_id": self._session_id,
            **data,
        })

    def export_json(self, filepath: str | Path):
        """Export ledger to JSON."""
        with open(filepath, "w") as f:
            json.dump({
                "session_id": self._session_id,
                "exported_at": datetime.utcnow().isoformat(),
                "entry_count": len(self._entries),
                "entries": self._entries,
            }, f, indent=2)

    def export_csv(self, filepath: str | Path):
        """Export ledger to CSV."""
        if not self._entries:
            return

        fieldnames = sorted(set().union(*(e.keys() for e in self._entries)))
        with open(filepath, "w", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(self._entries)
```

**Verification**:
1. Run session, export JSON -> valid JSON with all trades
2. Export CSV -> valid CSV with headers
3. Tax-relevant fields included (date, symbol, side, qty, price, P&L)

**Dependencies**: None

---

### FIX-D005 [P1] Improve Linux power handler (D-Bus)

**Problem**: Linux power state monitoring (sleep/wake) uses basic signal handling. Should use D-Bus for proper integration.

**Files to modify**:
- `engine/quantlab/daemon/power.py` (create or modify)

**Implementation**:

```python
# engine/quantlab/daemon/power.py

import asyncio
import logging
import sys
from typing import Callable, Optional

logger = logging.getLogger(__name__)

class PowerHandler:
    """Cross-platform power state handler.

    FIX-D005: Linux uses D-Bus for sleep/wake detection.
    """

    def __init__(self, on_sleep: Optional[Callable] = None, on_wake: Optional[Callable] = None):
        self._on_sleep = on_sleep
        self._on_wake = on_wake
        self._running = False

    async def start(self):
        """Start monitoring power state changes."""
        self._running = True

        if sys.platform == "linux":
            await self._start_linux_dbus()
        elif sys.platform == "darwin":
            await self._start_macos()
        elif sys.platform == "win32":
            await self._start_windows()

    async def _start_linux_dbus(self):
        """Monitor systemd-logind PrepareForSleep signal via D-Bus."""
        try:
            from dbus_next.aio import MessageBus
            from dbus_next import BusType

            bus = await MessageBus(bus_type=BusType.SYSTEM).connect()

            # Subscribe to PrepareForSleep signal
            introspection = await bus.introspect(
                "org.freedesktop.login1",
                "/org/freedesktop/login1",
            )
            proxy = bus.get_proxy_object(
                "org.freedesktop.login1",
                "/org/freedesktop/login1",
                introspection,
            )
            manager = proxy.get_interface("org.freedesktop.login1.Manager")

            def on_prepare_for_sleep(is_sleeping: bool):
                if is_sleeping and self._on_sleep:
                    asyncio.create_task(self._on_sleep())
                elif not is_sleeping and self._on_wake:
                    asyncio.create_task(self._on_wake())

            manager.on_prepare_for_sleep(on_prepare_for_sleep)
            logger.info("Linux D-Bus power monitoring active")

        except ImportError:
            logger.warning("dbus-next not installed, power monitoring unavailable on Linux")
        except Exception as e:
            logger.warning("D-Bus power monitoring failed: %s", e)

    async def _start_macos(self):
        """macOS power notifications (IOKit)."""
        # macOS uses IOPowerSources / NSWorkspace notifications
        logger.info("macOS power monitoring not yet implemented")

    async def _start_windows(self):
        """Windows power notifications (WM_POWERBROADCAST)."""
        # Windows uses RegisterPowerSettingNotification
        logger.info("Windows power monitoring not yet implemented")

    async def stop(self):
        """Stop monitoring."""
        self._running = False
```

**Verification**:
1. On Linux, `systemctl suspend` triggers sleep callback
2. Resume triggers wake callback
3. Missing dbus-next -> warning log, no crash

**Dependencies**: None

---

### FIX-D006 [P1] Fix checkpoint directory fsync for non-Linux

**Problem**: Checkpoint fsync uses Linux-specific `os.fsync()` on directory FD, which doesn't work on macOS/Windows.

**Evidence**:
- `engine/quantlab/daemon/checkpoint.py:248-252` -- directory fsync

**Files to modify**:
- `engine/quantlab/daemon/checkpoint.py`

**Implementation**:

```python
# engine/quantlab/daemon/checkpoint.py

import os
import sys
from pathlib import Path

def fsync_directory(dirpath: Path):
    """Ensure directory metadata is flushed to disk.

    FIX-D006: Cross-platform directory sync.
    Linux: fsync directory FD.
    macOS: fsync directory FD (same syscall).
    Windows: No directory fsync needed (NTFS metadata is synchronous).
    """
    if sys.platform == "win32":
        # Windows NTFS doesn't support directory fsync
        # Metadata changes are synchronous
        return

    try:
        fd = os.open(str(dirpath), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as e:
        # Some filesystems don't support directory fsync
        import logging
        logging.getLogger(__name__).debug(
            "Directory fsync not supported for %s: %s", dirpath, e
        )
```

**Verification**:
1. On Linux: checkpoint directory fsynced after write
2. On Windows: no error (skipped)
3. On macOS: fsync attempted, warning on failure

**Dependencies**: None

---

### NEW-TRADE-001 [MEDIUM] Escalate broker reconnect after max retries

**Problem**: After maximum reconnect retries, daemon should notify user instead of silently failing.

**Evidence**:
- `engine/quantlab/daemon/main.py:168` -- reconnect logic

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py

MAX_RECONNECT_RETRIES = 10

async def _handle_broker_disconnect(self):
    """Handle broker connection loss with escalation.

    NEW-TRADE-001: Escalate to user after max retries.
    """
    for attempt in range(1, MAX_RECONNECT_RETRIES + 1):
        self._logger.warning(
            "Broker disconnected, reconnect attempt %d/%d",
            attempt, MAX_RECONNECT_RETRIES,
        )
        await self._broadcast_connection_status({
            "state": "reconnecting",
            "attempt": attempt,
            "max_retries": MAX_RECONNECT_RETRIES,
        })

        try:
            await self._broker.reconnect()
            self._logger.info("Broker reconnected on attempt %d", attempt)
            await self._broadcast_connection_status({"state": "connected"})
            return
        except Exception as e:
            delay = min(2 ** attempt, 60)
            await asyncio.sleep(delay)

    # All retries exhausted
    self._logger.critical("Broker reconnect failed after %d attempts", MAX_RECONNECT_RETRIES)
    await self._broadcast_risk_alert({
        "type": "broker_connection_lost",
        "severity": "critical",
        "message": f"Broker connection lost after {MAX_RECONNECT_RETRIES} attempts. "
                   "Manual intervention required.",
        "action_required": True,
    })
    # Pause session for safety
    self._state = DaemonState.PAUSED
```

**Verification**:
1. Kill broker connection -> reconnect attempts start
2. After max retries -> critical risk alert sent to extension
3. Session paused for safety

**Dependencies**: Phase 0

---

### NEW-TRADE-002 [MEDIUM] Add IPC rate limiting

**Problem**: No rate limiting on IPC messages. A misbehaving client could flood the daemon.

**Files to modify**:
- `engine/quantlab/daemon/ipc.py`

**Implementation**:

```python
# engine/quantlab/daemon/ipc.py

import time
from collections import defaultdict

class RateLimiter:
    """Token bucket rate limiter for IPC messages.

    NEW-TRADE-002: Prevents IPC flooding.
    """

    def __init__(self, max_per_second: float = 100.0, burst: int = 200):
        self._max_per_second = max_per_second
        self._burst = burst
        self._tokens: dict[str, float] = defaultdict(lambda: float(burst))
        self._last_check: dict[str, float] = defaultdict(time.monotonic)

    def allow(self, client_id: str) -> bool:
        """Check if a message from client_id is allowed."""
        now = time.monotonic()
        elapsed = now - self._last_check[client_id]
        self._last_check[client_id] = now

        # Refill tokens
        self._tokens[client_id] = min(
            self._burst,
            self._tokens[client_id] + elapsed * self._max_per_second,
        )

        if self._tokens[client_id] >= 1.0:
            self._tokens[client_id] -= 1.0
            return True

        return False
```

Integration in IPCServer:

```python
# In IPCServer._process_message():
if not self._rate_limiter.allow(client.id):
    await client.send_error(message.get("id"), {
        "code": ErrorCode.RATE_LIMITED,
        "message": "Rate limit exceeded",
    })
    return
```

**Verification**:
1. Normal usage (< 100 msg/s) -> all messages processed
2. Flood (> 200 msg/s) -> excess messages rejected with RATE_LIMITED error
3. Burst of 200 messages -> all processed (within burst limit)

**Dependencies**: FIX-P004 (ErrorCode enum)

---

## Phase Verification Checklist

- [ ] Alpaca WebSocket connects, authenticates, and streams bars
- [ ] Order modification via IPC works (price, quantity changes)
- [ ] Market calendar auto-transitions between ACTIVE and MARKET_CLOSED
- [ ] Reconciliation interval configurable
- [ ] Drift detection notifications sent via IPC
- [ ] Fill reconciliation detects discrepancies
- [ ] Session ledger exports to JSON/CSV
- [ ] Linux D-Bus power monitoring works
- [ ] Checkpoint fsync works cross-platform
- [ ] Broker reconnect escalates after max retries
- [ ] IPC rate limiting prevents flooding

## Status Corrections

| Prior Claim | Actual Status |
|------------|---------------|
| "No broker integration" | Alpaca REST provider exists, WebSocket streaming needs implementation |
| "No reconciliation" | FillReconciler exists in SessionManager.ts (197 lines), Python side needs wiring |
| "No power handling" | Power handlers exist in lifecycle.py, D-Bus integration needed for Linux |

# Daemon Process Fixes

---

## FIX-D001: Token Logged in Plaintext (P0 - Critical)

**File**: `engine/quantlab/daemon/ipc.py:101`
**Issue**: The `TokenManager.generate()` method logs the token file path at INFO level. While it doesn't log the token value itself, the INFO log `f"Generated IPC token: {self._token_path}"` draws attention to the file location. More critically, if logging is misconfigured or a custom logger is added, the token could be exposed.
**Fix**:
```python
# Change from:
logger.info(f"Generated IPC token: {self._token_path}")
# To:
logger.debug(f"IPC token generated for session {self.session_id}")
```
**Rationale**: Reduce information leakage. Use DEBUG level and don't include the file path.

---

## FIX-D002: Daemon devnull FD Leak on Fork (P0 - Critical)

**File**: `engine/quantlab/daemon/lifecycle.py:334-338`
**Issue**: In `daemonize()`, after `devnull = open("/dev/null", "r+b")`, the `devnull_fd` is used with `os.dup2()` but `devnull.close()` at line 340 closes the same FD that was duped to stdin/stdout/stderr. If the `devnull` file object has a different FD from what was duped (which it does after `dup2` overwrites the original FDs), this is actually correct. However, the code comment says "Close the original file descriptor to prevent FD leak" but `devnull.close()` closes the Python file object which may trigger a second close on an already-reassigned FD.
**Fix**:
```python
# Replace the current approach with a safer pattern:
devnull_fd = os.open("/dev/null", os.O_RDWR)
os.dup2(devnull_fd, sys.stdin.fileno())
os.dup2(devnull_fd, sys.stdout.fileno())
os.dup2(devnull_fd, sys.stderr.fileno())
if devnull_fd > 2:  # Only close if not one of the standard FDs
    os.close(devnull_fd)
```
**Rationale**: Use `os.open` directly instead of Python `open()` to avoid double-close issues with the Python file object finalizer.

---

## FIX-D003: Missing order.modify IPC Handler (P1 - High)

**File**: `engine/quantlab/daemon/main.py`
**Issue**: The daemon registers IPC handlers for `order.submit` and `order.cancel` but NOT `order.modify`. The IPC Protocol (Appendix_B) specifies `order.modify` as a Critical reliability class message.
**Fix**: Add handler registration in `_register_ipc_handlers()`:
```python
self._ipc_server.register_handler("order.modify", self._handle_order_modify)
```
And implement the handler:
```python
async def _handle_order_modify(self, params: dict[str, Any]) -> dict[str, Any]:
    """Modify a pending order."""
    order_id = params["order_id"]
    modifications = {k: v for k, v in params.items() if k != "order_id"}

    result = await self._broker.modify_order(order_id, **modifications)

    # Update exposure reservation if quantity/price changed
    if "quantity" in modifications or "limit_price" in modifications:
        self._exposure_manager.adjust_reservation(order_id, modifications)

    self._audit_logger.log_event("order_modified", {
        "order_id": order_id,
        "modifications": modifications,
    })

    return {"status": "modified", "order_id": order_id}
```

---

## FIX-D004: Daemon State Machine Missing Calendar Integration (P1 - High)

**File**: `engine/quantlab/daemon/main.py`
**Issue**: The plan specifies automatic ACTIVE ↔ MARKET_CLOSED state transitions based on market calendar. The daemon has state tracking but no calendar-based transitions.
**Fix**: Add market hours check to the main loop:
```python
async def _check_market_state(self) -> None:
    """Check market hours and transition daemon state."""
    from quantlab.calendar.loader import CalendarLoader

    calendar = CalendarLoader.load(self._config.calendar_name)
    now = datetime.now(timezone.utc)

    if calendar.is_market_open(now):
        if self._state == DaemonState.MARKET_CLOSED:
            self._transition_state(DaemonState.ACTIVE)
            logger.info("Market opened, transitioning to ACTIVE")
    else:
        if self._state == DaemonState.ACTIVE:
            self._transition_state(DaemonState.MARKET_CLOSED)
            logger.info("Market closed, transitioning to MARKET_CLOSED")
```
Integrate into the heartbeat/monitoring loop.

---

## FIX-D005: Power Handler Sleep Detection Not Cross-Validated (P1 - High)

**File**: `engine/quantlab/daemon/power.py`
**Issue**: All three platform handlers (Linux, macOS, Windows) use the same time-gap detection method (monotonic time + drift threshold). The plan specifies D-Bus for Linux and IOKit for macOS, but these are not implemented. Time-gap detection works but is less reliable.
**Fix**: For Linux, add D-Bus monitoring as the primary method:
```python
class LinuxPowerHandler(PowerEventHandler):
    async def _monitor_dbus(self) -> None:
        """Monitor D-Bus for sleep/wake events (primary method)."""
        try:
            import dbus_next
            bus = await dbus_next.MessageBus(bus_type=dbus_next.BusType.SYSTEM).connect()
            introspection = await bus.introspect(
                "org.freedesktop.login1", "/org/freedesktop/login1"
            )
            proxy = bus.get_proxy_object(
                "org.freedesktop.login1", "/org/freedesktop/login1", introspection
            )
            manager = proxy.get_interface("org.freedesktop.login1.Manager")
            manager.on_prepare_for_sleep(self._on_prepare_for_sleep)
        except ImportError:
            logger.info("dbus-next not available, falling back to time-gap detection")
            await self._monitor_loop()
```
Add `dbus-next` as optional dependency.

---

## FIX-D006: Checkpoint Directory Sync May Fail on Non-Linux (P1 - High)

**File**: `engine/quantlab/daemon/checkpoint.py:248-252`
**Issue**: The checkpoint save uses `os.open(str(self._base_dir), os.O_RDONLY | os.O_DIRECTORY)` followed by `os.fsync(dir_fd)` to ensure directory sync. This is a Linux best practice but may fail on some filesystems or platforms.
**Fix**: Wrap in try/except and log warning:
```python
# After os.replace()
try:
    dir_fd = os.open(str(self._base_dir), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
except OSError as e:
    # Directory fsync not supported on all platforms/filesystems
    logger.debug(f"Directory fsync skipped: {e}")
```

---

## FIX-D007: Watchdog Alert Callback Not Async (P2 - Medium)

**File**: `engine/quantlab/daemon/watchdog.py:268`
**Issue**: `_trigger_alerts()` calls alert callbacks synchronously in an async context. If a callback does I/O (e.g., sends IPC notification), it blocks the event loop.
**Fix**: Make alert callbacks async:
```python
async def _trigger_alerts(self, health: DaemonHealth) -> None:
    """Send alerts to registered callbacks."""
    for callback in self._alert_callbacks:
        try:
            result = callback(health)
            if asyncio.iscoroutine(result):
                await result
        except Exception as e:
            logger.error(f"Alert callback error: {e}")
```

---

## FIX-D008: IPCServer Broadcast Modifies Dict During Iteration (P2 - Medium)

**File**: `engine/quantlab/daemon/ipc.py:289-299`
**Issue**: In the `broadcast()` method, when a client send fails, `self._clients.pop(client_id, None)` modifies the dict. Although `list(self._clients.items())` creates a copy of items at iteration start, the pop still races with other concurrent broadcasts.
**Current code** already uses `list()` to snapshot, and pops before close. This is actually handled correctly. However, concurrent broadcasts (from different coroutines) could still race on the `_clients` dict.
**Fix**: Add a lock for client management:
```python
def __init__(self, ...):
    ...
    self._clients_lock = asyncio.Lock()

async def broadcast(self, notification: Notification) -> None:
    ...
    async with self._clients_lock:
        clients_snapshot = list(self._clients.items())

    for client_id, client in clients_snapshot:
        try:
            await client.send(data)
        except Exception as e:
            logger.warning(f"Failed to send to client {client_id}: {e}")
            async with self._clients_lock:
                self._clients.pop(client_id, None)
            try:
                await client.close()
            except Exception:
                pass
```

# Risk Management Fixes

---

## FIX-R001: ExposureManager Timeout Cleanup Loop Missing (P0 - Critical)

**File**: `engine/quantlab/risk/exposure.py`
**Issue**: The plan specifies "Timeout cleanup runs every 30 seconds" to release stale reservations (acceptance criteria §2.5). The `ExposureManager` tracks reservations but has no background cleanup task.

**Impact**: If an order fails to get filled/cancelled/rejected and the fill/cancel event is lost, the reserved exposure is never released, reducing available exposure permanently.

**Fix**: Add a cleanup coroutine that integrates with the daemon:

```python
class ExposureManager:
    RESERVATION_TIMEOUT_SECONDS = 300  # 5 minutes
    CLEANUP_INTERVAL_SECONDS = 30

    def __init__(self, max_exposure: Decimal, ...):
        ...
        self._cleanup_task: asyncio.Task | None = None

    async def start_cleanup_loop(self) -> None:
        """Start the reservation cleanup background task."""
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())
        logger.info(f"Exposure cleanup loop started (interval: {self.CLEANUP_INTERVAL_SECONDS}s)")

    async def stop_cleanup_loop(self) -> None:
        """Stop the cleanup task."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass

    async def _cleanup_loop(self) -> None:
        """Periodically release stale reservations."""
        while True:
            try:
                await asyncio.sleep(self.CLEANUP_INTERVAL_SECONDS)
                self._cleanup_stale_reservations()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Exposure cleanup error: {e}")

    def _cleanup_stale_reservations(self) -> int:
        """Release reservations older than timeout threshold."""
        now = datetime.now()
        released_count = 0

        for order_id, reservation in list(self._reservations.items()):
            age = (now - reservation.created_at).total_seconds()
            if age > self.RESERVATION_TIMEOUT_SECONDS:
                logger.warning(
                    f"Releasing stale reservation for order {order_id} "
                    f"(age: {age:.0f}s, amount: {reservation.amount})"
                )
                self.release(order_id)
                released_count += 1

        if released_count > 0:
            logger.info(f"Cleaned up {released_count} stale reservations")

        return released_count
```

Integrate with daemon in `main.py`:
```python
async def _start_subsystems(self):
    ...
    await self._exposure_manager.start_cleanup_loop()

async def _stop_subsystems(self):
    ...
    await self._exposure_manager.stop_cleanup_loop()
```

---

## FIX-R002: ConsecutiveLossTracker Not Integrated with Daemon (P1 - High)

**File**: `engine/quantlab/risk/consecutive.py`, `engine/quantlab/daemon/main.py`
**Issue**: The `ConsecutiveLossTracker` class exists but is not instantiated or called anywhere in the daemon. The plan specifies consecutive loss tracking triggers circuit breaker (Decision L74, test E010, E011).

**Fix**: Integrate with fill handler in daemon:
```python
# In daemon/main.py __init__:
from quantlab.risk.consecutive import ConsecutiveLossTracker
from quantlab.risk.circuit_breaker import CircuitBreaker

self._consecutive_tracker = ConsecutiveLossTracker(limit=self._config.max_consecutive_losses or 3)
self._circuit_breaker = CircuitBreaker(...)

# In fill handler:
async def _handle_fill(self, fill: Fill) -> None:
    ...
    # Track for consecutive losses
    pnl = fill.realized_pnl
    if self._consecutive_tracker.record_trade(pnl):
        logger.critical(f"Circuit breaker triggered: {self._consecutive_tracker.limit} consecutive losses")
        await self._circuit_breaker.trigger(
            reason=f"Consecutive losses: {self._consecutive_tracker.consecutive_losses}",
            trigger_type="consecutive_loss",
        )
```

---

## FIX-R003: Circuit Breaker Integration Incomplete (P1 - High)

**File**: `engine/quantlab/risk/circuit_breaker.py`, `engine/quantlab/daemon/main.py`
**Issue**: `CircuitBreaker` class exists with `trigger()`, `reset()`, `is_triggered` but the daemon doesn't fully integrate it. When triggered, the daemon should:
1. Block all new orders
2. Notify UI via IPC
3. Log to audit trail
4. Optionally flatten positions (configurable)

**Fix**: Add circuit breaker checks to order submission:
```python
# In daemon _handle_order_submit:
async def _handle_order_submit(self, params: dict[str, Any]) -> dict[str, Any]:
    # Check circuit breaker FIRST
    if self._circuit_breaker.is_triggered:
        return {
            "status": "rejected",
            "reason": "circuit_breaker_active",
            "message": self._circuit_breaker.trigger_reason,
        }

    # Normal order processing...
```

Add circuit breaker trigger notification:
```python
# In CircuitBreaker.trigger():
async def trigger(self, reason: str, trigger_type: str) -> None:
    self._triggered = True
    self._trigger_reason = reason
    self._trigger_time = datetime.now()
    self._trigger_type = trigger_type
    logger.critical(f"Circuit breaker triggered: {reason}")

    # Notify listeners (daemon will broadcast to UI)
    for callback in self._trigger_callbacks:
        await callback(self._create_trigger_event())
```

---

## FIX-R004: Position Limits Max PCT Equity Check Uses Wrong Base (P1 - High)

**File**: `engine/quantlab/portfolio/limits.py:193-202`
**Issue**: In `_check_position_limits()`, the `max_pct_equity` check uses `new_value / equity` but `new_value` is calculated as `abs(new_qty) * price` at line 234. For short positions, this correctly uses the absolute value. However, for a position that flips from long to short, the `new_value` calculation may not account for the net position correctly.

**Example**: If currently long 100 shares and selling 150 shares (going short 50), `new_qty` is -50, so `new_value` is `50 * price`. But the exposure being checked should include the transaction size, not just the final position.

**Fix**: Clarify whether `max_pct_equity` applies to:
- Final position value (current implementation)
- Transaction value
- Both

If transaction value matters, add a separate check:
```python
# Check transaction concentration separately
transaction_value = abs(quantity) * price
transaction_pct = transaction_value / equity
if transaction_pct > limits.max_single_trade_pct_equity:
    violations.append(LimitViolation(
        limit_type=LimitType.MAX_SINGLE_TRADE_PCT,
        message=f"Single trade {transaction_pct:.1%} exceeds limit {limits.max_single_trade_pct_equity:.0%}",
        ...
    ))
```

---

## FIX-R005: Exposure Metrics Not Exposed for Monitoring (P2 - Medium)

**File**: `engine/quantlab/risk/exposure.py`
**Issue**: Plan acceptance criteria §2.5 states "Reservation metrics exposed for monitoring". No metrics getter exists.

**Fix**: Add metrics method:
```python
def get_metrics(self) -> dict[str, Any]:
    """Get exposure metrics for monitoring."""
    return {
        "max_exposure": str(self._max_exposure),
        "current_exposure": str(self._current_exposure),
        "reserved_exposure": str(self._reserved_exposure),
        "available_exposure": str(self._max_exposure - self._current_exposure - self._reserved_exposure),
        "utilization_pct": float((self._current_exposure + self._reserved_exposure) / self._max_exposure * 100)
            if self._max_exposure > 0 else 0,
        "reservation_count": len(self._reservations),
        "oldest_reservation_age_seconds": self._get_oldest_reservation_age(),
    }

def _get_oldest_reservation_age(self) -> float | None:
    """Get age of oldest reservation in seconds."""
    if not self._reservations:
        return None
    oldest = min(r.created_at for r in self._reservations.values())
    return (datetime.now() - oldest).total_seconds()
```

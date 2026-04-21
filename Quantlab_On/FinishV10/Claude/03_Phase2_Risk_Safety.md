# Phase 2: Risk & Safety (11 fixes)

**BLOCKS LIVE TRADING** -- Risk limits, circuit breakers, and safety controls must work before real money flows.

## Phase Overview

This phase ensures risk management components are properly integrated, circuit breakers function end-to-end, and risk limits propagate correctly from the extension UI to the daemon engine.

## Prerequisites

- Phase 0 (IPC Integration) -- daemon must be reachable
- Phase 1 (Security) -- credentials and trust must be in place

---

## Fix List (Execution Order)

### FIX-R001 [P0] Verify exposure cleanup loop starts

**Problem**: ExposureManager has a cleanup loop for expired reservations, but it may not be started by the daemon.

**Evidence**:
- `engine/quantlab/risk/exposure.py:502-531` -- `start_cleanup()`, `_cleanup_loop()` are async
- `engine/quantlab/daemon/main.py:339` -- daemon initialization

**Root Cause**: Cleanup loop requires explicit `await start_cleanup()` call from daemon.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py
# In LiveTradingDaemon.start() or __init__, ensure cleanup starts:

async def start(self):
    """Start the live trading daemon."""
    # ... existing init ...

    # Initialize risk components
    self._exposure_manager = ExposureManager(
        max_exposure=self._config.risk_limits.get("max_exposure", float("inf"))
    )

    # FIX-R001: Start the exposure cleanup loop
    await self._exposure_manager.start_cleanup()
    self._logger.info("Exposure cleanup loop started (interval: %ss)",
                      self._exposure_manager.CLEANUP_INTERVAL.total_seconds())

    # ... rest of start ...

async def stop(self):
    """Stop the daemon gracefully."""
    # ... existing shutdown ...

    # FIX-R001: Stop cleanup loop
    if self._exposure_manager:
        await self._exposure_manager.stop_cleanup()

    # ... rest of stop ...
```

**Verification**:
1. Start daemon, wait 60 seconds
2. Check logs: cleanup loop should have run at least once
3. Create a reservation, wait 5+ minutes -- should be cleaned up
4. `exposure.get_metrics()` should show 0 expired reservations

**Dependencies**: Phase 0

---

### FIX-R002 [P1] Integrate ConsecutiveLossTracker with daemon

**Problem**: ConsecutiveLossTracker exists but isn't wired into the daemon fill processing pipeline.

**Evidence**:
- `engine/quantlab/risk/consecutive.py` -- standalone tracker
- `engine/quantlab/daemon/main.py` -- fill handler doesn't update tracker

**Root Cause**: Component was built but integration was deferred.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py
# In __init__, add consecutive loss tracker:

from quantlab.risk.consecutive import ConsecutiveLossTracker

class LiveTradingDaemon:
    def __init__(self, config: SessionConfig):
        # ... existing init ...

        # FIX-R002: Initialize consecutive loss tracker
        consecutive_limit = int(config.risk_limits.get("consecutive_loss_limit", 3))
        self._consecutive_tracker = ConsecutiveLossTracker(
            max_consecutive_losses=consecutive_limit,
            on_breach=self._handle_consecutive_loss_breach,
        )

    async def _handle_consecutive_loss_breach(self, count: int):
        """Handle consecutive loss limit breach."""
        self._logger.warning(
            "Consecutive loss limit breached: %d losses in a row (limit: %d)",
            count, self._consecutive_tracker.max_consecutive_losses,
        )
        # Trigger circuit breaker
        await self._handle_circuit_breaker_trip({
            "reason": "consecutive_loss_limit",
            "count": count,
            "limit": self._consecutive_tracker.max_consecutive_losses,
        })

    # In _handle_broker_fill(), after processing fill:
    async def _handle_broker_fill(self, fill_data: dict):
        """Handle fill from broker."""
        # ... existing fill processing ...

        # FIX-R002: Track consecutive losses
        if fill_data.get("realized_pnl") is not None:
            pnl = fill_data["realized_pnl"]
            self._consecutive_tracker.record_trade(pnl)
```

**Verification**:
1. Set consecutive loss limit to 3
2. Submit 3 losing trades
3. After 3rd loss, circuit breaker should trip
4. Check logs: "Consecutive loss limit breached: 3 losses"

**Dependencies**: FIX-R001

---

### FIX-R003 [P1] Complete circuit breaker integration

**Problem**: Circuit breaker exists but full integration (block orders, notify clients, audit log, flatten) is incomplete.

**Evidence**:
- `engine/quantlab/risk/circuit_breaker.py` -- circuit breaker implementation
- `engine/quantlab/daemon/main.py:238-395` -- partial handlers exist

**Root Cause**: Circuit breaker was wired for state changes but not all consequences.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py

async def _handle_circuit_breaker_trip(self, trigger_data: dict):
    """Handle circuit breaker trip -- full safety response."""
    reason = trigger_data.get("reason", "unknown")
    self._logger.critical(
        "CIRCUIT BREAKER TRIPPED: session=%s reason=%s data=%s",
        self._config.session_id, reason, trigger_data,
    )

    # FIX-R003 Step 1: Block new order submissions
    self._orders_blocked = True

    # FIX-R003 Step 2: Cancel all open orders
    cancelled_count = 0
    for order_id in list(self._open_orders.keys()):
        try:
            await self._cancel_order(order_id)
            cancelled_count += 1
        except Exception as e:
            self._logger.error("Failed to cancel order %s during circuit break: %s", order_id, e)

    # FIX-R003 Step 3: Flatten all positions (if configured)
    if self._circuit_breaker.should_flatten_on_trip:
        await self._emergency_flatten()

    # FIX-R003 Step 4: Notify all connected clients
    await self._broadcast_risk_alert({
        "type": "circuit_breaker_trip",
        "reason": reason,
        "cancelled_orders": cancelled_count,
        "positions_flattened": self._circuit_breaker.should_flatten_on_trip,
        "timestamp": datetime.utcnow().isoformat(),
        "severity": "critical",
    })

    # FIX-R003 Step 5: Audit log
    self._audit_logger.critical(
        "CIRCUIT_BREAKER_TRIP session=%s reason=%s cancelled=%d flatten=%s",
        self._config.session_id, reason, cancelled_count,
        self._circuit_breaker.should_flatten_on_trip,
    )

    # FIX-R003 Step 6: Update daemon state
    self._state = DaemonState.PAUSED

async def _handle_order_submit(self, params: dict) -> dict:
    """Handle order submission with circuit breaker check."""
    # FIX-R003: Block orders when circuit breaker is tripped
    if self._orders_blocked:
        return {
            "success": False,
            "error": "Orders blocked: circuit breaker tripped",
            "circuit_breaker_state": self._circuit_breaker.state.value,
        }

    # ... existing order submission ...
```

**Verification**:
1. Trigger circuit breaker (e.g., via consecutive losses)
2. All open orders cancelled
3. Extension receives `risk.alert` notification with type `circuit_breaker_trip`
4. Subsequent order submissions rejected with circuit breaker message
5. Audit log shows CIRCUIT_BREAKER_TRIP entry

**Dependencies**: FIX-R002

---

### FIX-R004 [P1] Fix position limits equity calculation for position flips

**Problem**: Position limits calculation doesn't handle position flips (long -> short or vice versa) correctly, potentially allowing oversized positions.

**Evidence**:
- `engine/quantlab/portfolio/limits.py:193-202` -- equity calculation

**Root Cause**: Flip from long to short is treated as two separate operations (close + open) but the size check only sees the opening side.

**Files to modify**:
- `engine/quantlab/portfolio/limits.py`

**Implementation**:

```python
# engine/quantlab/portfolio/limits.py
# In position size validation (around line 193):

def validate_order_size(
    self,
    symbol: str,
    side: str,
    quantity: int,
    current_position: int,
    equity: float,
    price: float,
) -> tuple[bool, str]:
    """Validate order size against position limits.

    FIX-R004: Handle position flips correctly.
    """
    max_position_pct = self._max_position_pct
    max_position_value = equity * max_position_pct

    # Calculate resulting position after this order
    if side in ("buy", "buy_to_cover"):
        resulting_position = current_position + quantity
    else:  # sell, sell_short
        resulting_position = current_position - quantity

    # FIX-R004: Check absolute resulting position value, not just order size
    resulting_value = abs(resulting_position) * price

    if resulting_value > max_position_value:
        return False, (
            f"Resulting position value ${resulting_value:,.2f} exceeds "
            f"limit ${max_position_value:,.2f} ({max_position_pct:.0%} of equity ${equity:,.2f})"
        )

    # Also check per-order limits if configured
    order_value = quantity * price
    if self._max_order_value and order_value > self._max_order_value:
        return False, (
            f"Order value ${order_value:,.2f} exceeds per-order limit ${self._max_order_value:,.2f}"
        )

    return True, ""
```

**Verification**:
1. Set max position to 10% of equity ($10k equity -> $1k max)
2. Buy 5 shares at $150 ($750 value) -- allowed
3. Sell 15 shares at $150 (flip to -10 shares, $1500 value) -- blocked
4. Sell 8 shares at $150 (flip to -3 shares, $450 value) -- allowed

**Dependencies**: None

---

### FIX-R005 [P2] Expose exposure metrics for monitoring

**Problem**: ExposureManager has `get_metrics()` but it's not exposed via IPC for monitoring.

**Evidence**:
- `engine/quantlab/risk/exposure.py:238-258` -- `get_metrics()` returns dict
- No IPC handler exposes this

**Root Cause**: Metrics method exists but wasn't wired to IPC.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py
# Add to _register_ipc_handlers():

server.register_handler("exposure.metrics", self._handle_exposure_metrics)

# Add handler:
async def _handle_exposure_metrics(self, params: dict) -> dict:
    """Return exposure metrics for monitoring."""
    if not self._exposure_manager:
        return {"error": "Exposure manager not initialized"}

    metrics = self._exposure_manager.get_metrics()
    return {"metrics": metrics}
```

**Verification**:
1. Call `exposure.metrics` via IPC
2. Response includes: max_exposure, current_exposure, utilization_pct, reservation_count

**Dependencies**: FIX-R001

---

### FIX-CGP-011 [P1] Update risk limit defaults to match Decision L74

**Problem**: Default risk limits in extension settings don't match the project's Decision L74 (2% daily loss, 5% max drawdown, 3 consecutive losses).

**Evidence**:
- `extensions/quantlab/package.json` -- contributes.configuration defaults

**Root Cause**: Defaults were set before the L74 decision.

**Files to modify**:
- `extensions/quantlab/package.json`

**Implementation**:

```json
// extensions/quantlab/package.json
// In contributes.configuration, update defaults:
{
    "quantlab.risk.dailyLossLimit": {
        "type": "number",
        "default": 0.02,
        "description": "Daily loss limit as percentage of equity (Decision L74: 2%)"
    },
    "quantlab.risk.maxDrawdownPercent": {
        "type": "number",
        "default": 0.05,
        "description": "Maximum drawdown percentage (Decision L74: 5%)"
    },
    "quantlab.risk.consecutiveLossLimit": {
        "type": "integer",
        "default": 3,
        "description": "Maximum consecutive losing trades before halt (Decision L74: 3)"
    },
    "quantlab.risk.maxExposure": {
        "type": "number",
        "default": 1.0,
        "description": "Maximum total exposure as multiple of equity (1.0 = 100%)"
    },
    "quantlab.risk.maxPositionSize": {
        "type": "number",
        "default": 0.25,
        "description": "Maximum single position as percentage of equity (25%)"
    }
}
```

**Verification**:
1. Open extension settings
2. Risk defaults show: 2% daily loss, 5% max drawdown, 3 consecutive losses
3. Starting a session without overrides uses these defaults

**Dependencies**: None

---

### FIX-CGP-012 [P1] Propagate risk limits from extension to daemon CLI

**Problem**: Risk limits configured in extension settings need to be passed through to daemon CLI args.

**Evidence**:
- `extensions/quantlab/src/core/trading/LiveDaemonManager.ts:285` -- `buildDaemonArgs()`
- `engine/quantlab/daemon/__main__.py:25-142` -- CLI accepts risk args

**Root Cause**: Risk limit args were partially wired in CODEX-002 but need full verification.

**Files to modify**:
- `extensions/quantlab/src/core/trading/LiveDaemonManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/LiveDaemonManager.ts
// Ensure buildDaemonArgs() passes all risk limits:

private buildDaemonArgs(config: DaemonConfig): string[] {
    const args: string[] = [
        '-m', 'quantlab.daemon',
        'start',
        '--session-id', config.sessionId,
        '--strategy', config.strategyPath,
        '--broker', config.broker ?? 'alpaca',
        '--symbols', ...(config.symbols ?? ['AAPL']),
        '--timeframe', config.timeframe ?? '1min',
    ];

    if (config.paper) {
        args.push('--paper');
    }

    // FIX-CGP-012: Pass all risk limits
    const limits = config.riskLimits;
    if (limits) {
        if (limits.maxExposure !== undefined && limits.maxExposure !== null) {
            args.push('--max-exposure', String(limits.maxExposure));
        }
        if (limits.maxPositionSize !== undefined && limits.maxPositionSize !== null) {
            args.push('--max-position-size', String(limits.maxPositionSize));
        }
        if (limits.dailyLossLimit !== undefined && limits.dailyLossLimit !== null) {
            args.push('--daily-loss-limit', String(limits.dailyLossLimit));
        }
        if (limits.maxDrawdownPercent !== undefined && limits.maxDrawdownPercent !== null) {
            args.push('--max-drawdown-percent', String(limits.maxDrawdownPercent));
        }
        if (limits.consecutiveLossLimit !== undefined && limits.consecutiveLossLimit !== null) {
            args.push('--consecutive-loss-limit', String(limits.consecutiveLossLimit));
        }
    }

    if (config.logLevel) {
        args.push('--log-level', config.logLevel);
    }

    return args;
}
```

Also ensure daemon parses these correctly:

```python
# engine/quantlab/daemon/__main__.py
# In run_daemon() (around line 231), build risk_limits properly:

async def run_daemon(args):
    """Run the live trading daemon."""
    risk_limits = {}
    if args.max_exposure is not None:
        risk_limits["max_exposure"] = args.max_exposure
    if args.max_position_size is not None:
        risk_limits["max_position_size"] = args.max_position_size
    if args.daily_loss_limit is not None:
        risk_limits["daily_loss_limit"] = args.daily_loss_limit
    if args.max_drawdown_percent is not None:
        risk_limits["max_drawdown_percent"] = args.max_drawdown_percent
    if args.consecutive_loss_limit is not None:
        risk_limits["consecutive_loss_limit"] = args.consecutive_loss_limit

    config = SessionConfig(
        session_id=args.session_id,
        strategy_path=args.strategy,
        broker=args.broker if not args.paper else f"{args.broker}_paper",
        symbols=args.symbols,
        risk_limits=risk_limits,
    )

    daemon = LiveTradingDaemon(config)
    await daemon.start()
```

**Verification**:
1. Configure risk limits in extension settings
2. Start daemon session
3. Check daemon logs: risk limits match extension settings
4. Trigger a limit -- daemon enforces it

**Dependencies**: CODEX-002

---

### CODEX-005 [P1] Fix risk limit mapping: `dailyLossLimit` sent as `max-exposure`

**Problem**: Extension passes `dailyLossLimit` value as `--max-exposure` CLI arg -- completely wrong semantics. Daily loss limit (2%) is not max exposure (dollar amount).

**Evidence**:
- `extensions/quantlab/src/core/trading/SessionManager.ts:1162` -- incorrect mapping

**Root Cause**: Copy-paste error or misunderstanding of field semantics.

**Files to modify**:
- `extensions/quantlab/src/core/trading/SessionManager.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/trading/SessionManager.ts
// Fix the risk limit mapping in startDaemonSession() (around line 1162):

// CODEX-005: Each risk limit maps to its own CLI arg
const riskLimits = {
    maxExposure: riskConfig.get<number>('maxExposure'),           // -> --max-exposure
    maxPositionSize: riskConfig.get<number>('maxPositionSize'),   // -> --max-position-size
    dailyLossLimit: riskConfig.get<number>('dailyLossLimit'),     // -> --daily-loss-limit (NOT --max-exposure!)
    maxDrawdownPercent: riskConfig.get<number>('maxDrawdownPercent'), // -> --max-drawdown-percent
    consecutiveLossLimit: riskConfig.get<number>('consecutiveLossLimit'), // -> --consecutive-loss-limit
};

// WRONG (what was happening before):
// args.push('--max-exposure', String(riskLimits.dailyLossLimit));
//
// RIGHT:
// Each field maps to its corresponding CLI flag (handled in buildDaemonArgs)
```

**Verification**:
1. Set daily loss limit to 0.02 (2%) in settings
2. Start daemon, check CLI args: `--daily-loss-limit 0.02` (NOT `--max-exposure 0.02`)
3. Set max exposure to 100000 in settings
4. Start daemon, check CLI args: `--max-exposure 100000`

**Dependencies**: FIX-CGP-012

---

### FIX-T001-TRADING [P0] Wire emergency flatten audit logging

**Problem**: Emergency flatten (kill switch) should produce detailed audit logs for post-incident analysis.

**Evidence**:
- `engine/quantlab/trading/emergency.py` -- emergency flatten implementation

**Root Cause**: Emergency flatten exists but audit logging is insufficient.

**Files to modify**:
- `engine/quantlab/daemon/main.py`

**Implementation**:

```python
# engine/quantlab/daemon/main.py

async def _emergency_flatten(self):
    """Emergency flatten all positions with full audit trail."""
    self._audit_logger.critical(
        "EMERGENCY_FLATTEN_START session=%s positions=%d",
        self._config.session_id, len(self._positions),
    )

    flatten_results = []
    for symbol, pos in list(self._positions.items()):
        if pos.quantity == 0:
            continue

        # Determine close side
        side = "sell" if pos.quantity > 0 else "buy_to_cover"
        quantity = abs(pos.quantity)

        self._audit_logger.critical(
            "EMERGENCY_FLATTEN_ORDER session=%s symbol=%s side=%s qty=%d",
            self._config.session_id, symbol, side, quantity,
        )

        try:
            # Submit market order to close
            order_id = await self._submit_emergency_order(symbol, side, quantity)
            flatten_results.append({
                "symbol": symbol,
                "side": side,
                "quantity": quantity,
                "order_id": order_id,
                "status": "submitted",
            })
        except Exception as e:
            self._audit_logger.error(
                "EMERGENCY_FLATTEN_FAILED session=%s symbol=%s error=%s",
                self._config.session_id, symbol, str(e),
            )
            flatten_results.append({
                "symbol": symbol,
                "side": side,
                "quantity": quantity,
                "status": "failed",
                "error": str(e),
            })

    self._audit_logger.critical(
        "EMERGENCY_FLATTEN_COMPLETE session=%s results=%s",
        self._config.session_id, flatten_results,
    )

    return flatten_results
```

**Verification**:
1. Trigger emergency flatten (via kill switch or circuit breaker)
2. Check audit log: EMERGENCY_FLATTEN_START, _ORDER for each position, _COMPLETE
3. All positions should be closed
4. Failed orders are logged with error details

**Dependencies**: Phase 0

---

### NEW-RISK-001 [P1] Expose consecutive loss limit in UI settings

**Problem**: Consecutive loss limit exists in daemon but isn't configurable from extension UI.

**Evidence**:
- `extensions/quantlab/package.json` -- may not have consecutiveLossLimit setting

**Root Cause**: Setting was added to daemon before UI.

**Files to modify**:
- `extensions/quantlab/package.json`

**Implementation**:

Already included in FIX-CGP-011 above. Verify the setting exists:

```json
{
    "quantlab.risk.consecutiveLossLimit": {
        "type": "integer",
        "default": 3,
        "minimum": 1,
        "maximum": 20,
        "description": "Maximum consecutive losing trades before automatic halt"
    }
}
```

Also ensure PreTradeChecklist validates it:

```typescript
// extensions/quantlab/src/ui/dialogs/PreTradeChecklist.ts
// In checkRiskLimits() (around line 171), add consecutive loss check:

private checkRiskLimits(config: SessionConfig): ChecklistItem {
    const riskConfig = vscode.workspace.getConfiguration('quantlab.risk');
    const issues: string[] = [];

    // Existing checks...
    const dailyLoss = riskConfig.get<number>('dailyLossLimit', 0.02);
    if (dailyLoss <= 0 || dailyLoss > 1) {
        issues.push(`Daily loss limit ${dailyLoss} is invalid (must be 0-100%)`);
    }

    // NEW-RISK-001: Check consecutive loss limit
    const consecutiveLimit = riskConfig.get<number>('consecutiveLossLimit', 3);
    if (consecutiveLimit < 1) {
        issues.push('Consecutive loss limit must be at least 1');
    }

    if (issues.length > 0) {
        return { status: 'fail', label: 'Risk Limits', details: issues.join('; ') };
    }

    return {
        status: 'pass',
        label: 'Risk Limits',
        details: `Daily loss: ${(dailyLoss * 100).toFixed(1)}%, Consecutive: ${consecutiveLimit}`,
    };
}
```

**Verification**:
1. Open settings, find `quantlab.risk.consecutiveLossLimit`
2. Set to 5, start session
3. PreTradeChecklist shows "Consecutive: 5"

**Dependencies**: FIX-CGP-011

---

### NEW-RISK-002 [HIGH] Fix exposure reservation age metrics null check

**Problem**: `_get_oldest_reservation_age()` may return `None` if no reservations exist, but caller doesn't handle it.

**Evidence**:
- `engine/quantlab/risk/exposure.py:260-265` -- returns None when no reservations

**Root Cause**: Missing null guard in metrics aggregation.

**Files to modify**:
- `engine/quantlab/risk/exposure.py`

**Implementation**:

```python
# engine/quantlab/risk/exposure.py
# In get_metrics() (around line 238):

def get_metrics(self) -> dict:
    """Return exposure metrics for monitoring."""
    with self._lock:
        oldest_age = self._get_oldest_reservation_age()
        return {
            "max_exposure": self._max_exposure,
            "current_exposure": self._current_exposure,
            "reserved_exposure": self._reserved_exposure,
            "available_exposure": self.available_exposure,
            "utilization_pct": (
                (self._current_exposure + self._reserved_exposure) / self._max_exposure * 100
                if self._max_exposure > 0 else 0.0
            ),
            "reservation_count": len(self._reservations),
            # NEW-RISK-002: Handle None for oldest reservation age
            "oldest_reservation_age_seconds": oldest_age if oldest_age is not None else 0.0,
            "position_count": len(self._positions),
        }
```

**Verification**:
1. Call `get_metrics()` with no reservations -- `oldest_reservation_age_seconds` should be 0.0 (not None)
2. Create a reservation, call `get_metrics()` -- should show positive age
3. No TypeError from None comparison

**Dependencies**: None

---

## Phase Verification Checklist

- [ ] Exposure cleanup loop starts and runs on schedule
- [ ] Consecutive loss tracker integrated and triggers circuit breaker
- [ ] Circuit breaker blocks orders, cancels open orders, notifies clients, audit logs
- [ ] Position flip validation correct (resulting position, not order size)
- [ ] Exposure metrics accessible via IPC
- [ ] Risk limit defaults match Decision L74 (2%/5%/3)
- [ ] All risk limits propagated from extension to daemon CLI
- [ ] `dailyLossLimit` NOT mapped to `--max-exposure`
- [ ] Emergency flatten fully audit-logged
- [ ] Consecutive loss limit configurable in UI
- [ ] No null pointer on exposure metrics with empty reservations

## Status Corrections

| Prior Claim | Actual Status |
|------------|---------------|
| "No risk management" | ExposureManager (644 lines), ConsecutiveLossTracker, CircuitBreaker all exist |
| "Circuit breaker not implemented" | Circuit breaker exists but integration (block orders, flatten, notify) is incomplete |
| "Risk limits not configurable" | Extension has settings, but propagation to daemon needs fixing |

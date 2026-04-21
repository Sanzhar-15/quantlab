# Quantlab Verified Audit — Implementation Plan

**Date:** 2026-01-31
**Scope:** 2 Critical, 10 High, 14 Medium confirmed bugs across the Python engine and VS Code extension
**Estimated phases:** 5 (ordered by impact, grouped by file proximity)

---

## Phase 1 — Critical Correctness (2 bugs)

These must be fixed before any further backtest or live-trading work.
Touching 2 files, zero interdependency.

---

### FIX-C1: Exposure manager `_current_exposure` never decreases

**File:** `engine/quantlab/risk/exposure.py`
**Lines:** 602-604 (`_calculate_fill_exposure`), 370-375 (`commit`)
**Bug:** `_calculate_fill_exposure` returns `fill_quantity * fill_price` regardless of direction. `commit()` always adds this positive value to `_current_exposure`. After enough round-trips, available exposure reaches zero and all orders are rejected.
**Root cause:** `_calculate_projected_exposure` (line 584-600) correctly accounts for position-closing, but its closing-position logic is not mirrored in the commit path.

**Fix — recompute from ground truth in `commit()`:**

The simplest correct approach: after every fill, recompute `_current_exposure` from the authoritative position map rather than maintaining a drifting running total.

In `commit()`, after `self._update_position(fill)` (line 408), replace the running-total logic:

```python
# --- CURRENT (broken) ---
# Line 371:
actual_exposure = self._calculate_fill_exposure(fill)
# Line 375:
self._current_exposure += actual_exposure

# --- REPLACEMENT ---
# Remove lines 371 and 375 entirely.
# After self._update_position(fill) at line 408, add:
self._recompute_current_exposure(fill.fill_price, fill.symbol)
```

Add new helper after `_update_position`:

```python
def _recompute_current_exposure(
    self, latest_price: Decimal, symbol: str
) -> None:
    """Recompute current exposure from positions (ground truth).

    Stores fill prices for mark-to-market.  O(n) in position count
    which is negligible (typically < 100 symbols).
    """
    self._last_prices[symbol] = latest_price
    self._current_exposure = sum(
        abs(qty) * self._last_prices.get(sym, Decimal("0"))
        for sym, qty in self._positions.items()
    )
```

Add `_last_prices` dict to `__init__`:

```python
self._last_prices: dict[str, Decimal] = {}
```

Also clear it in `reset()`:

```python
self._last_prices.clear()
```

The legacy no-reservation path (lines 364-368) also needs the same fix — call `_recompute_current_exposure` instead of the direct `+=`.

**Also delete `_calculate_fill_exposure`** entirely — it is now unused.

**Test:** Write a round-trip test: open 100 shares at $50, close 100 shares at $55. Assert `current_exposure == 0`, `available_exposure == max_exposure`.

---

### FIX-C2: `StateCapture.capture_state()` passes wrong keyword

**File:** `engine/quantlab/api/state.py`
**Line:** 500
**Bug:** `custom_state=self._custom_state.copy()` — `StrategyState.__init__` has no `custom_state` parameter. The field is `internal_state` (line 30). `custom_state` is only a `@property` alias (line 61). This raises `TypeError` at runtime.

**Fix — single token replacement:**

```python
# --- CURRENT (line 498-502) ---
return StrategyState(
    strategy_name=strategy_name,
    custom_state=self._custom_state.copy(),    # <-- wrong
    indicator_state=self._indicator_cache.copy(),
)

# --- REPLACEMENT ---
return StrategyState(
    strategy_name=strategy_name,
    internal_state=self._custom_state.copy(),   # <-- correct field name
    indicator_state=self._indicator_cache.copy(),
)
```

**Test:** Call `StateCapture().capture_state("test")` — must not raise.

---

## Phase 2 — Trading Safety (4 bugs)

Bugs that affect live-trading reliability and emergency operations.
Touching 3 files across extension and engine.

---

### FIX-H1: Kill switch stops after first failed position close

**File:** `extensions/quantlab/src/views/trade/KillSwitch.ts`
**Lines:** 131-154 (`flattenPositions`), 118-129 (`cancelOrders`)
**Bug:** Both methods `throw error` inside the `for` loop, aborting remaining iterations.

**Fix — catch-and-continue, throw aggregate after:**

`flattenPositions` (lines 131-154):

```typescript
private async flattenPositions(
    broker: BrokerAdapter, output: vscode.OutputChannel
): Promise<void> {
    const positions = await broker.getPositions();
    const errors: string[] = [];

    for (const position of positions) {
        if (!position.quantity) continue;

        const request: OrderRequest = {
            symbol: position.symbol,
            side: position.quantity > 0 ? 'sell' : 'buy',
            type: 'market',
            quantity: Math.abs(position.quantity),
            timeInForce: 'day'
        };

        try {
            await broker.placeOrder(request);
            output.appendLine(
                `Flattened ${position.symbol} (${position.quantity})`
            );
        } catch (error) {
            const msg = (error as Error).message;
            output.appendLine(
                `FAILED to flatten ${position.symbol}: ${msg}`
            );
            errors.push(position.symbol);
            // DO NOT throw — continue to next position
        }
    }

    if (errors.length > 0) {
        throw new Error(
            `Kill switch: failed to flatten ${errors.length} position(s): `
            + errors.join(', ')
        );
    }
}
```

Apply the identical pattern to `cancelOrders` (lines 118-129): remove the `throw error` inside the loop, collect failures, throw once after.

**Test:** Mock broker that rejects the first order but accepts the second. Assert both positions are attempted.

---

### FIX-H8: Deadlock — callbacks fired inside lock in risk trackers

**File:** `engine/quantlab/risk/consecutive.py`
**Lines:** 220-237 (`ConsecutiveLossTracker.update_limit`), 309-320 (`DailyLossTracker.record_pnl`)
**Bug:** Both methods call `_execute_callbacks` / `_trigger_limit_breach` while holding `self._lock`. If a callback calls `reset()` or another method on the same tracker, it deadlocks (the lock is `threading.Lock`, not reentrant in `DailyLossTracker` at line 265).

**Fix for `update_limit` (lines 220-237):**

Follow the pattern already used by `record_trade` at lines 189-191 — collect events inside the lock, fire outside.

```python
def update_limit(self, new_limit: int) -> None:
    event = None
    with self._lock:
        old_limit = self._limit
        self._limit = new_limit
        logger.info(f"Loss limit updated: {old_limit} -> {new_limit}")

        if self._consecutive_losses >= self._limit:
            event = LossStreakEvent(
                consecutive_losses=self._consecutive_losses,
                threshold=self._limit,
                total_loss=self._total_loss,
                triggered_at=datetime.now(),
                trades=list(self._recent_trades),
            )
            self._trigger_count += 1

    # Fire OUTSIDE lock
    if event:
        self._execute_callbacks(event)
```

**Fix for `record_pnl` (lines 297-321):**

```python
def record_pnl(self, pnl: Decimal) -> bool:
    should_trigger = False
    with self._lock:
        self._current_pnl += pnl
        self._trade_count += 1

        logger.debug(
            f"Daily P&L: {self._current_pnl} (limit: -{self._daily_limit})"
        )

        if self._current_pnl < -self._daily_limit:
            should_trigger = True

    # Fire OUTSIDE lock
    if should_trigger:
        self._trigger_limit_breach()

    return should_trigger
```

**Note:** `DailyLossTracker` uses `threading.Lock` (not RLock), so reentrancy from a callback would deadlock. `ConsecutiveLossTracker` uses `threading.RLock` which allows reentrancy, but firing callbacks outside the lock is still correct practice — it prevents long callback chains from blocking other threads.

**Test:** Register a callback that calls `tracker.reset()`. Record enough losses to trigger. Must not deadlock.

---

### FIX-H9: Token file TOCTOU race condition

**File:** `engine/quantlab/daemon/ipc.py`
**Lines:** 99-103 (`generate_token`), 117-119 (`set_token`)
**Bug:** Token is written with default file permissions, then `chmod(0o600)`. Between write and chmod, any same-user process can read the token.

**Fix — atomic write with restricted permissions from creation:**

```python
def generate_token(self) -> str:
    self._base_dir.mkdir(parents=True, exist_ok=True)
    self._token = secrets.token_urlsafe(TOKEN_LENGTH)
    self._write_token_secure(self._token)
    logger.debug(f"IPC token generated for session {self.session_id}")
    return self._token

def set_token(self, token: str) -> None:
    self._base_dir.mkdir(parents=True, exist_ok=True)
    self._token = token
    self._write_token_secure(token)
    logger.debug(f"IPC token set for session {self.session_id}")

def _write_token_secure(self, token: str) -> None:
    """Write token to file with 0o600 permissions from creation."""
    fd = os.open(
        str(self._token_path),
        os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
        0o600,
    )
    try:
        os.write(fd, token.encode("utf-8"))
    finally:
        os.close(fd)
```

**Test:** Stat the token file immediately after creation — assert mode is `0o600`.

---

### FIX-H2: Borrow fee day-count inconsistency (252 vs 365)

**Files:**
- `engine/quantlab/backtest/core.py:1119` — uses 252
- `engine/quantlab/portfolio/short.py:99` — uses 365
- `engine/quantlab/portfolio/fees.py:90` — defaults to 365

**Nature:** Both 252 (trading days, used in backtest accrual per bar) and 365 (calendar days, used by brokers) are valid conventions in different contexts. The problem is inconsistency when mixing code paths.

**Fix — make day-count explicit everywhere, centralize constants:**

1. Add constants to `engine/quantlab/metrics/risk.py` (already has `EQUITY_TRADING_DAYS_PER_YEAR = 252`):

```python
# Already exists at line 19-22:
EQUITY_TRADING_DAYS_PER_YEAR = 252
CRYPTO_TRADING_DAYS_PER_YEAR = 365
```

2. In `backtest/core.py:1119`, import the constant:

```python
from quantlab.metrics.risk import EQUITY_TRADING_DAYS_PER_YEAR
# ...
daily_rate = annual_rate / Decimal(str(EQUITY_TRADING_DAYS_PER_YEAR))
```

3. In `portfolio/short.py:99`, add an explicit parameter and docstring:

```python
def daily_fee(
    self, price: Decimal, day_count: int = 365
) -> Decimal:
    """Calculate daily borrow fee.

    Args:
        price: Current market price
        day_count: Days per year (365 for calendar/broker convention,
                   252 for trading-day convention)
    """
    return (self.quantity * price * self.rate) / Decimal(str(day_count))
```

4. `fees.py` already accepts `day_count` as a constructor parameter — no change needed.

5. Add a note in `DESIGN_SYSTEM.md` or a `CONVENTIONS.md` documenting the choice.

---

## Phase 3 — Data Integrity & Type Unification (6 bugs)

Structural inconsistencies that cause type mismatches at module boundaries.
Can be done in one sweep since many are single-line fixes.

---

### FIX-H7: `OrderSide` enum fragmentation

**Files:**
- `backtest/core.py:42-48` — BUY, SELL, SELL_SHORT, BUY_TO_COVER
- `orders/base.py:19-22` — BUY, SELL
- `risk/exposure.py:52-56` — BUY, SELL

**Fix — canonical enum in shared location:**

Create `engine/quantlab/types.py` (or add to existing shared module):

```python
from enum import Enum

class OrderSide(Enum):
    BUY = "buy"
    SELL = "sell"
    SELL_SHORT = "sell_short"
    BUY_TO_COVER = "buy_to_cover"

    @property
    def is_buy(self) -> bool:
        return self in (OrderSide.BUY, OrderSide.BUY_TO_COVER)

    @property
    def is_sell(self) -> bool:
        return self in (OrderSide.SELL, OrderSide.SELL_SHORT)
```

Replace imports in `backtest/core.py`, `orders/base.py`, `risk/exposure.py`.
In the orders/ handlers, use `side.is_buy` / `side.is_sell` for fill logic so they naturally handle all four sides.

**Do the same for `TimeInForce`:** Create one canonical enum in `types.py` with all values (GFD, GTC, IOC, FOK, GTD, OPG, CLS), import everywhere.

---

### FIX-H10: `ErrorCode` conflict between `protocol/message.py` and `errors.py`

**Files:**
- `protocol/message.py:455-490` — plain class with integer constants
- `errors.py:47-77` — Enum with different numeric codes

**Bug:** `NOT_AUTHENTICATED` is 1001 in message.py, 2001 in errors.py.

**Fix:** The `protocol/message.py` codes are the IPC wire format and are used by the daemon server. The `errors.py` codes are the internal error taxonomy. These should be reconciled:

1. Keep `protocol/message.py` ErrorCode as the **wire-format** codes (used in JSON-RPC responses). Rename to `RpcErrorCode` for clarity.
2. Keep `errors.py` ErrorCode as the **internal** error taxonomy.
3. Add a mapping function in `errors.py`:

```python
def to_rpc_error_code(code: ErrorCode) -> int:
    """Map internal error code to JSON-RPC wire format code."""
    _MAP = {
        ErrorCode.NOT_AUTHENTICATED: 1001,
        ErrorCode.SESSION_NOT_FOUND: 1002,
        ErrorCode.ORDER_REJECTED: 2001,
        # ... etc
    }
    return _MAP.get(code, -32603)  # default: INTERNAL_ERROR
```

This keeps wire compatibility while resolving the naming conflict.

---

### FIX-M7: Duplicate class definitions

**Files and actions:**

| Duplicate | Canonical Location | Action |
|---|---|---|
| `data/rev.py` UniverseRev (lines 571-643) | `data/universe.py` UniverseRev | Delete from `rev.py`, import from `universe.py` |
| `api/params.py` StrategyState (lines 538-572) | `api/state.py` StrategyState (line 20) | Delete from `params.py`, import from `state.py` |
| `api/params.py` StateManager (lines 575-694) | `api/state.py` StateManager | Delete from `params.py`, import from `state.py` |

For each: grep all imports, update to point to canonical location.

---

### FIX-M8: `forward_fill_bars` creates `Bar` without `symbol`

**File:** `engine/quantlab/data/loader.py:352-359`
**Bug:** `Bar()` constructor called without `symbol=`, but `providers/base.py` requires it.

**Fix:**

```python
filled = Bar(
    symbol=last_bar.symbol,   # <-- add this
    timestamp=td,
    open=last_bar.close,
    high=last_bar.close,
    low=last_bar.close,
    close=last_bar.close,
    volume=0,
)
```

One-line addition. The `last_bar` is set at line 342 from the actual bar data, so `last_bar.symbol` is always available.

---

### FIX-M4 + M5: Systemic `datetime.utcnow()` and naive "Z" timestamps

**Scope:** 18+ files across the engine.

**Fix — batch find-and-replace with two patterns:**

Pattern 1 — Default factory in dataclasses:
```python
# BEFORE:
created_at: datetime = field(default_factory=datetime.utcnow)
# AFTER:
from datetime import timezone
created_at: datetime = field(
    default_factory=lambda: datetime.now(timezone.utc)
)
```

Pattern 2 — Inline calls:
```python
# BEFORE:
timestamp = datetime.utcnow()
# AFTER:
timestamp = datetime.now(timezone.utc)
```

Pattern 3 — Serialization with "Z":
```python
# BEFORE:
"timestamp": self.timestamp.isoformat() + "Z",
# AFTER:
"timestamp": self.timestamp.isoformat(),
# (datetime.now(timezone.utc).isoformat() already outputs "+00:00")
```

Pattern 4 — Deserialization stripping "Z":
```python
# BEFORE:
timestamp=datetime.fromisoformat(meta.get("timestamp", "").rstrip("Z"))
# AFTER:
raw = meta.get("timestamp", "")
timestamp=datetime.fromisoformat(raw.replace("Z", "+00:00"))
```

**Files to touch** (complete list from audit):
- `protocol/message.py` (lines 203, 225, 249, 266, 287, 347, 418, 434)
- `errors.py` (line 310)
- `features/cache.py` (line 173)
- `api/params.py` (line 604)
- `api/state.py` (line 51, 97)
- `audit/recovery.py` (line 84)
- `debug/format.py` (line 244)
- `logging/config.py` (line 96)
- `logging/audit.py` (line 303)
- `snapshot/environment.py` (lines 124, 188)
- `artifacts/manifest.py` (lines 100, 184, 238)
- `artifacts/code_snapshot.py` (lines 80, 200)
- `artifacts/report.py` (lines 180, 258, 390)
- `export/json.py` (line 29)
- `export/html.py` (line 100)
- `export/migration.py` (line 31)
- `jobs/protocol.py` (lines 50, 78, 143, 168)
- `jobs/base.py` (line 472)
- `daemon/main.py` (line 633 — also fix `datetime.now()` → `datetime.now(tz)`)
- `data/csv_loader.py` (line 115 — `utcfromtimestamp`)

---

### FIX-M6: `cleanup_old_checkpoints` passes dict instead of Path

**File:** `engine/quantlab/api/state.py:454`
**Bug:** `list_checkpoints()` returns a list of dicts. `delete_checkpoint()` expects a path. `for filepath in to_delete` iterates dicts.

**Fix:**

```python
# --- CURRENT (line 454) ---
for filepath in to_delete:
    if self.delete_checkpoint(filepath):

# --- REPLACEMENT ---
for checkpoint in to_delete:
    if self.delete_checkpoint(checkpoint["filepath"]):
```

---

## Phase 4 — Portfolio & Metrics Accuracy (6 bugs)

Fixes that affect reported numbers (Sharpe, equity, P&L).
Touching metrics/, portfolio/, backtest/ modules.

---

### FIX-H3: Population vs. sample variance inconsistency

**Files:**
- `metrics/calculator.py:119, 144, 252` — uses `/ len(returns)` (population)
- `jobs/backtest.py:880`, `jobs/optimize.py:492`, `jobs/montecarlo.py:538`, `jobs/wfa.py:587` — inline Sharpe with population variance

**Fix — two steps:**

**Step 1:** Fix `MetricsCalculator` to use sample variance (n-1):

```python
# calculator.py line 119 — _calculate_volatility:
variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)

# calculator.py line 144 — _calculate_sharpe:
variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)

# calculator.py line 252 — SQN:
variance = sum((p - mean_pnl) ** 2 for p in pnls) / (len(pnls) - 1)
```

**Step 2:** Replace all inline Sharpe calculations in `jobs/*.py` with a call to the centralized function. Example for `jobs/backtest.py`:

```python
# BEFORE (inline):
mean_ret = sum(returns) / len(returns)
variance = sum((r - mean_ret) ** 2 for r in returns) / len(returns)
std = math.sqrt(variance)
sharpe = (mean_ret / std) * math.sqrt(252) if std > 0 else 0.0

# AFTER:
from quantlab.metrics.calculator import MetricsCalculator
_calc = MetricsCalculator(trading_days_per_year=252)
sharpe = _calc._calculate_sharpe(returns)
```

Or better — extract a standalone `sharpe_float()` utility:

```python
# In metrics/calculator.py, add a module-level function:
def quick_sharpe(
    returns: list[float],
    trading_days: int = 252,
    risk_free_rate: float = 0.0,
) -> float:
    """Sharpe ratio from float returns. Uses sample variance."""
    if len(returns) < 2:
        return 0.0
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
    std = math.sqrt(variance)
    if std == 0:
        return 0.0
    daily_rf = risk_free_rate / trading_days
    return ((mean - daily_rf) / std) * math.sqrt(trading_days)
```

Then replace all 5 inline implementations with `quick_sharpe(returns)`.

---

### FIX-H5: `apply_fill` doesn't update `last_price`; tautological `validate_equity_identity`

**File:** `engine/quantlab/portfolio/state.py`

**Fix Part A — update `last_price` in `apply_fill` (after line 442):**

Add before the flat-position cleanup:

```python
# After position update logic (line 442), before flat check:
# Update last_price so equity is immediately correct
if symbol in self.positions:
    self.positions[symbol].update_price(price)
```

**Fix Part B — make `validate_equity_identity` meaningful (lines 449-456):**

```python
def validate_equity_identity(
    self,
    prices: dict[str, Decimal] | None = None,
    tolerance: Decimal = Decimal("0.01"),
) -> bool:
    """
    Validate equity identity against independent price source.

    If prices are provided, computes equity independently and
    compares against self.equity.  If not provided, falls back to
    checking internal consistency (long_value + short_value vs
    sum of position market_values).
    """
    if prices is not None:
        independent_equity = self.cash
        for sym, pos in self.positions.items():
            p = prices.get(sym, pos.last_price)
            independent_equity += pos.quantity * p
        return abs(independent_equity - self.equity) < tolerance

    # Fallback: verify position-level values sum correctly
    expected_long = sum(
        pos.market_value for pos in self.positions.values()
        if pos.is_long
    )
    expected_short = sum(
        abs(pos.market_value) for pos in self.positions.values()
        if pos.is_short
    )
    return (
        abs(expected_long - self.long_value) < tolerance
        and abs(expected_short - self.short_value) < tolerance
    )
```

---

### FIX-H6: `BacktestConfig.to_dict()` drops `Decimal("0")` limits

**File:** `engine/quantlab/backtest/config.py:85-86`

**Fix — use `is not None` instead of truthiness:**

```python
# BEFORE:
"max_position_size": str(self.max_position_size) if self.max_position_size else None,
"max_exposure": str(self.max_exposure) if self.max_exposure else None,

# AFTER:
"max_position_size": str(self.max_position_size) if self.max_position_size is not None else None,
"max_exposure": str(self.max_exposure) if self.max_exposure is not None else None,
```

---

### FIX-H4: `ExposureManager.modify()` loses original price/quantity

**File:** `engine/quantlab/risk/exposure.py:469-473`

**Fix — derive defaults from existing reservation:**

```python
# BEFORE (lines 469-473):
if new_quantity is not None or new_price is not None:
    price = new_price or Decimal("0")
    quantity = new_quantity or Decimal("0")
    new_amount = quantity * price

# AFTER:
if new_quantity is not None or new_price is not None:
    # Derive original per-unit price from reservation
    if reservation.original_quantity > Decimal("0"):
        original_unit_price = reservation.amount / reservation.original_quantity
    else:
        original_unit_price = Decimal("0")

    price = new_price if new_price is not None else original_unit_price
    quantity = new_quantity if new_quantity is not None else reservation.original_quantity
    new_amount = quantity * price
```

---

### FIX-M1: `VolatilitySlippage` fill price can exceed bar range

**File:** `engine/quantlab/backtest/slippage.py:157-171`

**Fix — clamp to bar boundaries:**

```python
def calculate(
    self,
    base_price: Decimal,
    quantity: Decimal,
    is_buy: bool,
    bar: Bar,
) -> Decimal:
    slippage_amount = bar.range * self.range_fraction

    if is_buy:
        result = base_price + slippage_amount
        return min(result, bar.high)          # <-- clamp to high
    else:
        result = base_price - slippage_amount
        return max(result, self.min_price, bar.low)  # <-- clamp to low
```

---

### FIX-M2: `ShortBorrow.accrued_fee` integer-day truncation

**File:** `engine/quantlab/portfolio/short.py:101-111`

**Fix — use fractional days:**

```python
def accrued_fee(
    self,
    price: Decimal,
    from_date: datetime,
    to_date: datetime,
) -> Decimal:
    """Calculate accrued fee for a period (supports fractional days)."""
    delta = to_date - from_date
    total_seconds = Decimal(str(delta.total_seconds()))
    if total_seconds <= Decimal("0"):
        return Decimal("0")
    fractional_days = total_seconds / Decimal("86400")
    return self.daily_fee(price) * fractional_days
```

---

## Phase 5 — Infrastructure Hardening (8 bugs)

Lower-risk robustness improvements. Can be parallelized.

---

### FIX-M3: `Param` descriptor memory leak via `id(obj)` keying

**File:** `engine/quantlab/api/params.py:237-267`

**Fix — store on the instance's `__dict__` directly:**

```python
def __get__(self, obj: Any, objtype: type | None = None) -> T:
    if obj is None:
        return self  # type: ignore
    return obj.__dict__.get(self._storage_name, self.default)

def __set__(self, obj: Any, value: T) -> None:
    # ... existing validation ...
    obj.__dict__[self._storage_name] = value

def __set_name__(self, owner: type, name: str) -> None:
    self._name = name
    self._storage_name = f"_param_{name}"
```

Delete `self._values: dict[int, T] = {}` from `__init__`. This uses Python's standard descriptor-on-instance pattern, is GC-friendly, and requires no `weakref`.

---

### FIX-M10: `psutil.cpu_percent(interval=0.1)` blocks async event loop

**File:** `engine/quantlab/daemon/watchdog.py:161-166`

**Fix — run in thread executor:**

```python
# BEFORE:
process = psutil.Process()
cpu = process.cpu_percent(interval=0.1)

# AFTER:
import asyncio, functools
loop = asyncio.get_running_loop()
process = psutil.Process()
cpu = await loop.run_in_executor(
    None,
    functools.partial(process.cpu_percent, interval=0.1),
)
```

---

### FIX-M11: Session ID path injection in daemon

**Files:**
- `engine/quantlab/daemon/ipc.py:73-76` (TokenManager)
- `engine/quantlab/protocol/transport.py:273-285` (get_socket_path)
- `engine/quantlab/daemon/lifecycle.py` (PidFile)

**Fix — add validation helper, call at entry points:**

```python
import re

_VALID_SESSION_ID = re.compile(r'^[a-zA-Z0-9_\-]{1,128}$')

def validate_session_id(session_id: str) -> str:
    """Validate session ID is safe for use in file paths."""
    if not _VALID_SESSION_ID.match(session_id):
        raise ValueError(
            f"Invalid session ID: {session_id!r}. "
            "Must be 1-128 alphanumeric/dash/underscore characters."
        )
    return session_id
```

Call `validate_session_id(session_id)` in `TokenManager.__init__`, `get_socket_path()`, and `PidFile.__init__`.

---

### FIX-M12: `pickle.load()` on untrusted files

**Files:**
- `engine/quantlab/features/cache.py:136-139`
- `engine/quantlab/api/state.py:300-302`

**Fix — replace pickle with JSON + HMAC integrity check:**

For `features/cache.py`, replace pickle with JSON serialization:

```python
# BEFORE:
data = pickle.load(f)

# AFTER:
import json
data = json.load(f)
```

If the cached data contains numpy arrays or complex types, use `json` with a custom encoder/decoder, or use `pyarrow` serialization (already a dependency) which is safe:

```python
import pyarrow as pa
# Write:
pa.ipc.write_tensor(pa.Tensor.from_numpy(array), sink)
# Read:
tensor = pa.ipc.read_tensor(source)
array = tensor.to_numpy()
```

For `api/state.py`, the `StrategyState` already has `to_dict()`/`from_dict()` which use JSON-safe types. Replace pickle save/load with JSON:

```python
# Save:
with open(path, 'w') as f:
    json.dump(state.to_dict(), f)

# Load:
with open(path, 'r') as f:
    return StrategyState.from_dict(json.load(f))
```

---

### FIX-M13: Broker reconnection has no jitter

**File:** `engine/quantlab/daemon/main.py:174`

**Fix — add randomized jitter to exponential backoff:**

```python
import random

# In the reconnection loop:
delay = self._broker_reconnect_base_delay * (2 ** attempt)
jitter = random.uniform(0, delay * 0.5)
actual_delay = delay + jitter
await asyncio.sleep(actual_delay)
```

This prevents thundering herd when multiple daemon instances reconnect after a broker outage.

---

### FIX-M14: O(n^2) pending order removal in `backtest/core.py`

**File:** `engine/quantlab/backtest/core.py:803-805`

**Fix — use a set for batch removal:**

```python
# BEFORE (lines 803-805):
for order in orders_to_remove:
    self._state.pending_orders.remove(order)

# AFTER:
if orders_to_remove:
    remove_ids = {id(o) for o in orders_to_remove}
    self._state.pending_orders = [
        o for o in self._state.pending_orders
        if id(o) not in remove_ids
    ]
```

This is O(n) instead of O(n*m). For a better long-term fix, change `pending_orders` from a `list` to an `OrderedDict` keyed by `order_id`, making both lookup and removal O(1).

---

### FIX-M9: AES-GCM missing Associated Additional Data

**File:** `engine/quantlab/secrets/encrypted.py:297, 463`

**Fix — bind ciphertext to vault identity:**

```python
# Derive AAD from the vault file path (stable, unique per vault)
aad = str(self._file_path.resolve()).encode("utf-8")

# Encrypt (line ~463):
ciphertext = aesgcm.encrypt(nonce, plaintext, aad)

# Decrypt (line ~297):
plaintext = aesgcm.decrypt(nonce, ciphertext, aad)
```

**Migration:** Existing vaults were encrypted with `None` AAD. Add a version byte to the vault header:
- Version 1: `AAD=None` (legacy)
- Version 2: `AAD=file_path`

On decrypt, check version and use appropriate AAD. On next save, always write version 2.

---

## Phase Summary

| Phase | Fixes | Files touched | Risk |
|-------|-------|---------------|------|
| **1 — Critical** | C1, C2 | 2 Python files | Zero — pure bugfixes |
| **2 — Safety** | H1, H8, H9, H2 | 2 TS, 2 Python files | Low — isolated changes |
| **3 — Types** | H7, H10, M7, M8, M4/M5, M6 | 20+ files (mostly imports + datetime) | Medium — wide but mechanical |
| **4 — Accuracy** | H3, H5, H6, H4, M1, M2 | 5 Python files | Low — math fixes |
| **5 — Hardening** | M3, M10, M11, M12, M13, M14, M9 | 8 Python files | Low — independent changes |

**Dependency order:** Phase 1 must go first. Phases 2-5 are independent of each other and can run in parallel if multiple developers are available. Within Phase 3, the enum unification (H7) should precede the duplicate-class cleanup (M7) since M7 may reference the new canonical types.

---

## Retracted Findings (do NOT implement)

| Original ID | Claim | Why it's wrong |
|---|---|---|
| CRIT-06 | Sharpe uses std of raw returns not excess | `std(X-c) = std(X)` for constant c. Mathematically correct. |
| CRIT-01/finding#1 | Look-ahead bias in `ql.backtest()` | Standard vectorized backtesting pattern. Not a bug. |
| CRIT-14 | innerHTML XSS in webview | CSP with nonce blocks script execution. Not exploitable. |
| CRIT-02/finding#4 | Decimal→float in runner | float has 15+ digits. Sufficient for OHLCV signals. |
| CRIT-10 | Unrestricted exec() | Standard for backtesting. User runs own code. |
| CRIT-11 | Empty deactivate() | Process exit reclaims all resources. |
| HIGH-33 | FillReconciler unbounded growth | Has maxTrackedFills=10K cap with 10% eviction. |

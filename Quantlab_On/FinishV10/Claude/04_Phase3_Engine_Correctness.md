# Phase 3: Engine Correctness (16 fixes)

**Affects backtest accuracy** -- Independent of live trading, can run in parallel with Phases 1-2.

## Phase Overview

This phase fixes backtest engine edge cases: stop order gap fills, partial fill handling, temporal alignment, forward-fill detection, decimal precision, and data loading improvements. These impact the correctness of backtest results.

## Prerequisites

- Phase 0 (IPC Integration) -- for testing engine via extension
- Can run in parallel with Phases 1-2 (independent track)

---

## Fix List (Execution Order)

### NEW-ENG-001 [HIGH] Fix stop/stop-limit overnight gap fill behavior

**Problem**: Stop orders fill at the stop price even when the market gaps through. A stop at $100 with open at $95 should fill at $95 (the gap-through price), not $100.

**Evidence**:
- `engine/quantlab/backtest/core.py:803-844` -- `_fill_stop_order()`
- `engine/quantlab/backtest/core.py:846-895` -- `_fill_stop_limit_order()`

**Root Cause**: Gap-through detection exists but may not use open price correctly for overnight gaps.

**Files to modify**:
- `engine/quantlab/backtest/core.py`

**Implementation**:

```python
# engine/quantlab/backtest/core.py
# In _fill_stop_order() (around line 803):

def _fill_stop_order(
    self, order: Order, bar: dict, bar_index: int
) -> Fill | None:
    """Fill stop order with gap-through handling.

    NEW-ENG-001: On overnight gap-through, fill at open price, not stop price.
    A sell stop at $100 with open at $95 fills at $95 (worse for seller).
    A buy stop at $100 with open at $105 fills at $105 (worse for buyer).
    """
    open_price = bar["open"]
    high = bar["high"]
    low = bar["low"]
    stop_price = order.stop_price

    if order.is_sell:
        # Sell stop triggers when price falls to or below stop
        if low <= stop_price:
            # NEW-ENG-001: Gap-through check
            if open_price <= stop_price:
                # Gap opened below stop -- fill at open (worse for seller)
                fill_price = open_price
            else:
                # Intraday trigger -- fill at stop price
                fill_price = stop_price

            return self._create_fill(order, fill_price, bar_index, bar)
    else:
        # Buy stop triggers when price rises to or above stop
        if high >= stop_price:
            # NEW-ENG-001: Gap-through check
            if open_price >= stop_price:
                # Gap opened above stop -- fill at open (worse for buyer)
                fill_price = open_price
            else:
                # Intraday trigger -- fill at stop price
                fill_price = stop_price

            return self._create_fill(order, fill_price, bar_index, bar)

    return None

# Similarly fix _fill_stop_limit_order():
def _fill_stop_limit_order(
    self, order: Order, bar: dict, bar_index: int
) -> Fill | None:
    """Fill stop-limit order with gap-through handling.

    NEW-ENG-001: If gap opens past stop AND past limit, order is NOT filled
    (unlike plain stop which fills at open).
    """
    open_price = bar["open"]
    high = bar["high"]
    low = bar["low"]
    stop_price = order.stop_price
    limit_price = order.limit_price

    if order.is_sell:
        # Sell stop-limit: trigger when low <= stop, fill if price >= limit
        if low <= stop_price:
            if open_price <= stop_price:
                # Gap through stop -- check if limit is still achievable
                if open_price >= limit_price:
                    fill_price = open_price  # Gap but still above limit
                else:
                    return None  # Gap through both stop and limit -- no fill
            else:
                # Normal intraday trigger
                fill_price = max(stop_price, limit_price)

            return self._create_fill(order, fill_price, bar_index, bar)
    else:
        # Buy stop-limit: trigger when high >= stop, fill if price <= limit
        if high >= stop_price:
            if open_price >= stop_price:
                # Gap through stop -- check if limit is still achievable
                if open_price <= limit_price:
                    fill_price = open_price  # Gap but still below limit
                else:
                    return None  # Gap through both stop and limit -- no fill
            else:
                # Normal intraday trigger
                fill_price = min(stop_price, limit_price)

            return self._create_fill(order, fill_price, bar_index, bar)

    return None
```

**Verification**:
1. Create golden test: sell stop at $100, bar opens at $95 -> fill at $95
2. Create golden test: buy stop at $100, bar opens at $105 -> fill at $105
3. Create golden test: sell stop-limit (stop $100, limit $98), bar opens at $90 -> NO fill
4. All existing golden tests still pass

**Dependencies**: None

---

### NEW-ENG-002 [HIGH] Implement partial fill requeue for GTC + IOC cancellation

**Problem**: GTC orders that are partially filled should have the remaining quantity requeued. IOC orders should cancel the unfilled portion.

**Evidence**:
- `engine/quantlab/backtest/core.py:460-495` -- `_process_pending_orders()`

**Root Cause**: Partial fill handling exists for order status but requeue/cancel logic may be incomplete.

**Files to modify**:
- `engine/quantlab/backtest/core.py`

**Implementation**:

```python
# engine/quantlab/backtest/core.py
# In _process_pending_orders() after fill attempt:

def _process_pending_orders(self, bar: dict, bar_index: int):
    """Process all pending orders for the current bar."""
    # Sort by priority
    sorted_orders = sorted(
        self._state.pending_orders,
        key=lambda o: o.get_priority(self._state.positions.get(o.symbol, 0)),
        reverse=True,
    )

    remaining_orders = []
    for order in sorted_orders:
        fill = self._attempt_fill(order, bar, bar_index)

        if fill:
            self._apply_fill(fill)
            self._state.fills.append(fill)

            # NEW-ENG-002: Handle partial fills
            if fill.quantity < order.remaining_quantity + fill.quantity:
                # Partial fill
                order.filled_quantity += fill.quantity
                order.status = OrderStatus.PARTIALLY_FILLED

                if order.time_in_force == TimeInForce.IOC:
                    # IOC: cancel remaining
                    order.status = OrderStatus.CANCELLED
                elif order.time_in_force == TimeInForce.GTC:
                    # GTC: requeue remaining for next bar
                    remaining_orders.append(order)
                elif order.time_in_force == TimeInForce.GFD:
                    # GFD: requeue within same day
                    remaining_orders.append(order)
                elif order.time_in_force == TimeInForce.FOK:
                    # FOK should never partial fill (rejected earlier)
                    order.status = OrderStatus.CANCELLED
            else:
                # Full fill
                order.status = OrderStatus.FILLED
                order.filled_quantity = order.quantity
        else:
            # No fill -- check expiration
            if order.time_in_force == TimeInForce.IOC:
                order.status = OrderStatus.CANCELLED
            elif order.time_in_force == TimeInForce.FOK:
                order.status = OrderStatus.CANCELLED
            else:
                remaining_orders.append(order)

    self._state.pending_orders = remaining_orders
```

**Verification**:
1. Submit GTC limit order for 100 shares, bar has volume for only 50 -> partial fill, 50 remaining
2. Next bar has volume for 50 more -> full fill
3. Submit IOC order for 100 shares, partial fill 30 -> remaining 70 cancelled
4. Submit FOK order for 100 shares, only 50 available -> entire order rejected

**Dependencies**: None

---

### NEW-ENG-003 [HIGH] Add multi-asset temporal alignment validation

**Problem**: Multi-asset backtests validate bar count matches but not temporal alignment. Two assets could have same bar count but different date ranges.

**Evidence**:
- `engine/quantlab/backtest/core.py:299-337` -- `load_data()`

**Root Cause**: Bar count check is necessary but not sufficient.

**Files to modify**:
- `engine/quantlab/backtest/core.py`

**Implementation**:

```python
# engine/quantlab/backtest/core.py
# In load_data() (around line 299):

def load_data(self, data: dict[str, Any]) -> None:
    """Load and validate multi-asset bar data.

    NEW-ENG-003: Validate temporal alignment, not just bar count.
    """
    if not data:
        raise ValueError("No data provided")

    bar_counts = {}
    date_ranges = {}

    for symbol, bars in data.items():
        if not bars or len(bars) == 0:
            raise ValueError(f"Empty data for symbol {symbol}")

        bar_counts[symbol] = len(bars)

        # NEW-ENG-003: Extract date ranges for alignment check
        if "timestamp" in bars[0]:
            first_ts = bars[0]["timestamp"]
            last_ts = bars[-1]["timestamp"]
            date_ranges[symbol] = (first_ts, last_ts)

    # Check bar counts match
    unique_counts = set(bar_counts.values())
    if len(unique_counts) > 1:
        raise ValueError(
            f"Bar count mismatch across symbols: {bar_counts}. "
            "All symbols must have the same number of bars."
        )

    # NEW-ENG-003: Check temporal alignment
    if len(date_ranges) > 1:
        first_symbol = next(iter(date_ranges))
        ref_start, ref_end = date_ranges[first_symbol]

        for symbol, (start, end) in date_ranges.items():
            if symbol == first_symbol:
                continue
            if start != ref_start or end != ref_end:
                raise ValueError(
                    f"Temporal misalignment: {first_symbol} covers "
                    f"{ref_start} to {ref_end}, but {symbol} covers "
                    f"{start} to {end}. Use aligned data or apply "
                    f"forward-fill to synchronize."
                )

    self._data = data
    self._bar_count = next(iter(bar_counts.values()))
```

**Verification**:
1. Load AAPL and MSFT with same dates -> passes
2. Load AAPL (2020-2024) and MSFT (2021-2025) with same bar count -> raises ValueError
3. Load single asset -> passes (no alignment needed)

**Dependencies**: None

---

### NEW-ENG-004 [HIGH] Implement forward-fill detection (spec S3.7)

**Problem**: Data with missing bars (holidays, halts) should be detected and optionally forward-filled per spec section 3.7.

**Evidence**:
- `engine/quantlab/data/loader.py` -- no forward-fill detection

**Root Cause**: Feature specified but not implemented.

**Files to modify**:
- `engine/quantlab/data/loader.py`

**Implementation**:

```python
# engine/quantlab/data/loader.py

import pandas as pd
from typing import Optional

def detect_gaps(
    bars: list[dict],
    expected_freq: str = "1D",
    calendar: Optional[Any] = None,
) -> list[dict]:
    """Detect missing bars in a time series.

    Args:
        bars: List of bar dicts with 'timestamp' key
        expected_freq: Expected bar frequency ('1D', '1H', '1min', etc.)
        calendar: Optional market calendar for trading days

    Returns:
        List of gap descriptions with start, end, count
    """
    if not bars or len(bars) < 2:
        return []

    timestamps = [bar["timestamp"] for bar in bars]
    ts_series = pd.DatetimeIndex(timestamps)

    # Generate expected index
    if calendar:
        expected = calendar.trading_dates(ts_series[0], ts_series[-1], freq=expected_freq)
    else:
        expected = pd.date_range(ts_series[0], ts_series[-1], freq=expected_freq)

    # Find missing timestamps
    missing = expected.difference(ts_series)

    if len(missing) == 0:
        return []

    # Group consecutive gaps
    gaps = []
    gap_start = missing[0]
    gap_end = missing[0]

    for i in range(1, len(missing)):
        if (missing[i] - missing[i - 1]).days <= 3:  # Allow weekends
            gap_end = missing[i]
        else:
            gaps.append({
                "start": gap_start.isoformat(),
                "end": gap_end.isoformat(),
                "count": len(missing[(missing >= gap_start) & (missing <= gap_end)]),
            })
            gap_start = missing[i]
            gap_end = missing[i]

    gaps.append({
        "start": gap_start.isoformat(),
        "end": gap_end.isoformat(),
        "count": len(missing[(missing >= gap_start) & (missing <= gap_end)]),
    })

    return gaps


def forward_fill(
    bars: list[dict],
    expected_freq: str = "1D",
    calendar: Optional[Any] = None,
    max_fill_days: int = 5,
) -> list[dict]:
    """Forward-fill missing bars in a time series.

    NEW-ENG-004: Implements spec S3.7 forward-fill detection.

    Args:
        bars: List of bar dicts with OHLCV + timestamp
        expected_freq: Expected bar frequency
        calendar: Optional market calendar
        max_fill_days: Maximum consecutive days to forward-fill

    Returns:
        List of bars with gaps filled (volume=0 for filled bars)
    """
    if not bars:
        return bars

    df = pd.DataFrame(bars)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.set_index("timestamp").sort_index()

    # Generate expected index
    if calendar:
        expected = calendar.trading_dates(df.index[0], df.index[-1], freq=expected_freq)
    else:
        expected = pd.date_range(df.index[0], df.index[-1], freq=expected_freq)

    # Reindex and forward-fill
    df = df.reindex(expected)

    # Mark filled bars
    filled_mask = df["open"].isna()

    # Forward-fill OHLC (close of previous bar)
    for col in ["open", "high", "low", "close"]:
        df[col] = df[col].ffill(limit=max_fill_days)

    # Set volume to 0 for filled bars
    df.loc[filled_mask, "volume"] = 0

    # Drop bars that couldn't be filled (beyond max_fill_days)
    df = df.dropna(subset=["open"])

    # Add metadata for filled bars
    df["is_forward_filled"] = filled_mask & ~df["open"].isna()

    # Convert back to list of dicts
    result = []
    for ts, row in df.iterrows():
        bar = row.to_dict()
        bar["timestamp"] = ts.isoformat()
        result.append(bar)

    return result
```

**Verification**:
1. Data with Monday gap (holiday) -> detected, forward-filled with Friday close, volume=0
2. Data with 10-day gap -> first 5 days filled, rest dropped (max_fill_days=5)
3. `is_forward_filled` flag set correctly
4. No forward-fill needed -> data unchanged

**Dependencies**: None

---

### NEW-ENG-005 [HIGH] Integrate market calendar with data loader

**Problem**: Data loader doesn't use market calendar to distinguish trading vs non-trading days. Gaps on holidays are incorrectly flagged.

**Evidence**:
- `engine/quantlab/calendar/` -- calendar implementation exists
- `engine/quantlab/data/loader.py` -- no calendar integration

**Files to modify**:
- `engine/quantlab/data/loader.py`

**Implementation**:

```python
# engine/quantlab/data/loader.py
# Add calendar integration:

from quantlab.calendar import get_calendar

def load_bars(
    filepath: str,
    symbol: str,
    timeframe: str = "1D",
    exchange: str = "NYSE",
    forward_fill: bool = True,
) -> list[dict]:
    """Load bar data with calendar-aware gap handling.

    NEW-ENG-005: Uses market calendar to avoid false gap detection on holidays.
    """
    # Load raw data
    bars = _load_raw_bars(filepath)

    # Get market calendar
    calendar = get_calendar(exchange)

    if forward_fill:
        bars = forward_fill(
            bars,
            expected_freq=timeframe,
            calendar=calendar,
        )

    return bars
```

**Verification**:
1. Load data with US holiday (e.g., July 4th) -> no false gap flagged
2. Load data with legitimate missing day -> gap detected and forward-filled
3. Exchange-specific calendars work (NYSE vs NASDAQ)

**Dependencies**: NEW-ENG-004

---

### NEW-ENG-006 [HIGH] Add decimal precision quantization for dollar amounts

**Problem**: Floating-point arithmetic can cause penny rounding errors in cash calculations (e.g., $100.00 becomes $99.99999999).

**Evidence**:
- `engine/quantlab/backtest/core.py` -- uses float throughout
- `engine/quantlab/orders/*.py` -- prices as floats

**Root Cause**: Standard float arithmetic without rounding.

**Files to modify**:
- `engine/quantlab/precision/` (create if needed)
- `engine/quantlab/backtest/core.py`

**Implementation**:

```python
# engine/quantlab/precision/money.py

from decimal import Decimal, ROUND_HALF_UP

# Standard precision for dollar amounts
DOLLAR_PRECISION = Decimal("0.01")
SHARE_PRECISION = Decimal("0.0001")  # For fractional shares
PRICE_PRECISION = Decimal("0.0001")  # For price calculations


def quantize_dollars(amount: float) -> float:
    """Round dollar amount to nearest cent.

    NEW-ENG-006: Prevents floating-point penny errors.
    """
    return float(Decimal(str(amount)).quantize(DOLLAR_PRECISION, rounding=ROUND_HALF_UP))


def quantize_price(price: float) -> float:
    """Round price to 4 decimal places."""
    return float(Decimal(str(price)).quantize(PRICE_PRECISION, rounding=ROUND_HALF_UP))


def quantize_shares(quantity: float) -> float:
    """Round share quantity to 4 decimal places (fractional shares)."""
    return float(Decimal(str(quantity)).quantize(SHARE_PRECISION, rounding=ROUND_HALF_UP))
```

Apply in backtest engine:

```python
# engine/quantlab/backtest/core.py
from quantlab.precision.money import quantize_dollars

# In _apply_fill():
def _apply_fill(self, fill: Fill):
    cost = fill.quantity * fill.price
    commission = fill.commission

    if fill.side == OrderSide.BUY:
        self._state.cash -= quantize_dollars(cost + commission)
    elif fill.side == OrderSide.SELL:
        self._state.cash += quantize_dollars(cost - commission)
    # ... etc

# In _calculate_equity():
def _calculate_equity(self, bar: dict) -> float:
    equity = self._state.cash
    for symbol, qty in self._state.positions.items():
        price = bar.get(symbol, {}).get("close", 0)
        equity += qty * price
    return quantize_dollars(equity)
```

**Verification**:
1. Run 10,000 trade simulation -- final cash should be exactly rounded to cents
2. No floating-point drift (e.g., $99.999999 instead of $100.00)
3. Performance impact minimal (<1% overhead)

**Dependencies**: None

---

### NEW-ENG-007 [MEDIUM] Add equity curve negative value protection / margin call

**Problem**: Equity can go negative without triggering a margin call or halting the backtest. Strategies with excessive leverage can generate unrealistic results.

**Evidence**:
- `engine/quantlab/backtest/core.py:363,452` -- equity calculation doesn't check for negative

**Files to modify**:
- `engine/quantlab/backtest/core.py`

**Implementation**:

```python
# engine/quantlab/backtest/core.py
# In _process_bar() or after _calculate_equity():

def _check_margin_call(self, equity: float, bar_index: int):
    """NEW-ENG-007: Check for margin call condition."""
    if equity <= 0:
        self._logger.warning(
            "MARGIN CALL: Equity dropped to $%.2f at bar %d. Liquidating all positions.",
            equity, bar_index,
        )
        # Force-close all positions at current prices
        for symbol, qty in list(self._state.positions.items()):
            if qty != 0:
                bar = self._data[symbol][bar_index]
                side = OrderSide.SELL if qty > 0 else OrderSide.BUY_TO_COVER
                fill = Fill(
                    order_id=f"MARGIN_CALL_{symbol}",
                    symbol=symbol,
                    side=side,
                    quantity=abs(qty),
                    price=bar["close"],
                    commission=0,  # Margin call -- no additional commission
                    slippage=0,
                    bar_index=bar_index,
                    timestamp=bar.get("timestamp"),
                )
                self._apply_fill(fill)
                self._state.fills.append(fill)

        self._state.margin_called = True
        self._state.margin_call_bar = bar_index
```

**Verification**:
1. Strategy that goes heavily short, market rallies -> equity hits 0 -> margin call triggered
2. All positions liquidated at current prices
3. Backtest result shows `margin_called: true`

**Dependencies**: None

---

### NEW-ENG-008 [MEDIUM] Improve zero-volume bar handling

**Problem**: Bars with zero volume should not generate fills for volume-dependent order types.

**Evidence**:
- `engine/quantlab/backtest/fills.py:126-132` -- volume check

**Files to modify**:
- `engine/quantlab/backtest/core.py`

**Implementation**:

```python
# engine/quantlab/backtest/core.py
# In _attempt_fill(), check volume:

def _attempt_fill(self, order: Order, bar: dict, bar_index: int) -> Fill | None:
    """Attempt to fill an order against the current bar."""
    volume = bar.get("volume", 0)

    # NEW-ENG-008: Skip fills on zero-volume bars
    if volume == 0 and order.order_type != OrderType.MARKET:
        # Market orders can still fill on zero-volume (e.g., illiquid securities)
        # but limit/stop orders should not
        return None

    # Volume participation limit (default 10% of bar volume)
    if volume > 0:
        max_fill_qty = int(volume * self._volume_participation_rate)
        if max_fill_qty < order.remaining_quantity:
            # Partial fill only up to participation limit
            # This is handled in fill methods
            pass

    # ... dispatch to specific fill method ...
```

**Verification**:
1. Bar with volume=0 and pending limit order -> no fill
2. Bar with volume=0 and pending market order -> fills (configurable)
3. Bar with low volume -> partial fill up to participation rate

**Dependencies**: None

---

### NEW-ENG-009 [MEDIUM] Fix borrow fee edge case (can drive cash negative)

**Problem**: Borrow fee accrual can drive cash negative without margin call check. A short position held indefinitely accumulates fees.

**Evidence**:
- `engine/quantlab/backtest/core.py:995-1024` -- `_accrue_borrow_fees()`

**Root Cause**: Borrow fees deducted from cash without checking if cash becomes negative.

**Files to modify**:
- `engine/quantlab/backtest/core.py`

**Implementation**:

```python
# engine/quantlab/backtest/core.py
# In _accrue_borrow_fees() (around line 995):

def _accrue_borrow_fees(self, bar: dict):
    """Accrue borrow fees for short positions.

    NEW-ENG-009: Check for cash going negative from borrow fees.
    Prorated for intraday bars.
    """
    if not self._borrow_rate:
        return

    daily_rate = self._borrow_rate / 252.0

    # NEW-ENG-009: Prorate for intraday bars
    timeframe_fraction = self._get_timeframe_fraction()
    bar_rate = daily_rate * timeframe_fraction

    total_fee = 0.0
    for symbol, qty in self._state.positions.items():
        if qty < 0:  # Short position
            price = bar.get(symbol, {}).get("close", 0)
            notional = abs(qty) * price
            fee = notional * bar_rate
            total_fee += fee

    if total_fee > 0:
        self._state.cash -= quantize_dollars(total_fee)
        self._state.total_borrow_fees += total_fee

        # NEW-ENG-009: Warn if cash goes negative from borrow fees
        if self._state.cash < 0:
            self._logger.warning(
                "Cash negative ($%.2f) after borrow fee accrual of $%.2f",
                self._state.cash, total_fee,
            )

def _get_timeframe_fraction(self) -> float:
    """Return fraction of a trading day for the current timeframe."""
    tf = self._config.get("timeframe", "1D")
    if tf == "1D" or tf == "D":
        return 1.0
    elif tf == "1H" or tf == "60min":
        return 1.0 / 6.5  # 6.5 trading hours
    elif tf == "30min":
        return 1.0 / 13.0
    elif tf == "15min":
        return 1.0 / 26.0
    elif tf == "5min":
        return 1.0 / 78.0
    elif tf == "1min":
        return 1.0 / 390.0
    else:
        return 1.0  # Default to daily
```

**Verification**:
1. Short position with 5% annual borrow rate on daily bars -> $0.99/day per $100 short
2. Short position on 1-minute bars -> fee prorated to 1/390th of daily rate
3. Cash going negative from fees triggers warning

**Dependencies**: NEW-ENG-006 (quantize_dollars)

---

### NEW-ENG-010 [MEDIUM] Fix backtest error return (equity should include positions MTM)

**Problem**: If backtest encounters an error mid-run, the returned equity may only include cash, not mark-to-market positions value.

**Evidence**:
- `engine/quantlab/backtest/core.py:392-404` -- error return path

**Files to modify**:
- `engine/quantlab/backtest/core.py`

**Implementation**:

```python
# engine/quantlab/backtest/core.py
# In run() error handling (around line 392):

def run(self, strategy: Strategy) -> BacktestResult:
    """Run the backtest."""
    try:
        for bar_index in range(1, self._bar_count):
            self._process_bar(bar_index, strategy)
    except Exception as e:
        self._logger.error("Backtest error at bar %d: %s", self._state.bar_index, e)
        # NEW-ENG-010: Calculate final equity including positions MTM
        final_equity = self._state.cash
        if self._state.bar_index > 0:
            last_bar = {
                sym: self._data[sym][self._state.bar_index]
                for sym in self._data
            }
            for symbol, qty in self._state.positions.items():
                price = last_bar.get(symbol, {}).get("close", 0)
                final_equity += qty * price

        return BacktestResult(
            config=self._config,
            equity_curve=self._state.equity_curve,
            trades=self._state.fills,
            final_equity=final_equity,  # NEW-ENG-010: includes positions
            total_return=(final_equity / self._initial_capital) - 1,
            total_trades=len(self._state.fills),
            winning_trades=self._count_winning_trades(),
            losing_trades=self._count_losing_trades(),
            start_time=self._start_time,
            end_time=datetime.utcnow(),
            total_borrow_fees=self._state.total_borrow_fees,
            error=str(e),
        )

    # ... normal completion path ...
```

**Verification**:
1. Inject error at bar 50 of 100-bar backtest
2. Final equity includes position values at bar 50 close prices
3. Error message included in result

**Dependencies**: None

---

### NEW-ENG-011 [MEDIUM] Fix collateral calculation missing price validation

**Problem**: Short selling collateral calculation may use stale or zero prices, leading to incorrect collateral requirements.

**Evidence**:
- `engine/quantlab/backtest/core.py:515-539` -- collateral calculation

**Files to modify**:
- `engine/quantlab/backtest/core.py`

**Implementation**:

```python
# engine/quantlab/backtest/core.py
# In collateral validation (around line 515):

def _validate_collateral(
    self, order: Order, bar: dict
) -> tuple[bool, str]:
    """Validate collateral for short selling.

    NEW-ENG-011: Validate price before collateral calculation.
    """
    if not order.is_short:
        return True, ""

    price = bar.get("close", 0)

    # NEW-ENG-011: Price validation
    if price <= 0:
        return False, f"Invalid price {price} for {order.symbol} -- cannot calculate collateral"

    notional = order.quantity * price
    required_collateral = notional * self._collateral_ratio  # Default 1.0 (100%)

    available_cash = self._state.cash
    if available_cash < required_collateral:
        return False, (
            f"Insufficient collateral: need ${required_collateral:,.2f} "
            f"({self._collateral_ratio:.0%} of ${notional:,.2f}), "
            f"available ${available_cash:,.2f}"
        )

    return True, ""
```

**Verification**:
1. Short sell order with valid price -> collateral calculated correctly
2. Short sell order with price=0 -> rejected with "Invalid price" message
3. Short sell with insufficient cash -> rejected with detailed message

**Dependencies**: None

---

### FIX-E001 [P1] Implement Parquet data loader

**Problem**: Engine only loads CSV data. Parquet support needed for large datasets and efficient columnar access.

**Evidence**:
- `engine/quantlab/data/` -- no parquet loader

**Files to create**:
- `engine/quantlab/data/parquet_loader.py`

**Implementation**:

```python
# engine/quantlab/data/parquet_loader.py

"""Parquet data loader for efficient columnar bar data.

FIX-E001: Adds Parquet support alongside existing CSV loader.
Supports both single-file and partitioned Parquet datasets.
"""

import logging
from pathlib import Path
from typing import Optional

import pyarrow.parquet as pq
import pandas as pd

logger = logging.getLogger(__name__)

# Required columns for OHLCV bar data
REQUIRED_COLUMNS = {"timestamp", "open", "high", "low", "close", "volume"}

# Column aliases for common naming conventions
COLUMN_ALIASES = {
    "date": "timestamp",
    "datetime": "timestamp",
    "time": "timestamp",
    "Date": "timestamp",
    "Open": "open",
    "High": "high",
    "Low": "low",
    "Close": "close",
    "Volume": "volume",
    "Adj Close": "adj_close",
}


def load_parquet(
    filepath: str | Path,
    symbol: Optional[str] = None,
    columns: Optional[list[str]] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    chunk_size: Optional[int] = None,
) -> list[dict]:
    """Load bar data from a Parquet file.

    Args:
        filepath: Path to .parquet file or directory (partitioned)
        symbol: Filter by symbol column (for multi-symbol files)
        columns: Specific columns to load (None = all)
        start_date: Filter start date (ISO format)
        end_date: Filter end date (ISO format)
        chunk_size: If set, read in chunks for large files

    Returns:
        List of bar dicts with OHLCV + timestamp
    """
    filepath = Path(filepath)

    if not filepath.exists():
        raise FileNotFoundError(f"Parquet file not found: {filepath}")

    # Build filters
    filters = []
    if symbol:
        filters.append(("symbol", "=", symbol))
    if start_date:
        filters.append(("timestamp", ">=", pd.Timestamp(start_date)))
    if end_date:
        filters.append(("timestamp", "<=", pd.Timestamp(end_date)))

    # Read Parquet
    if filepath.is_dir():
        # Partitioned dataset
        dataset = pq.ParquetDataset(filepath, filters=filters or None)
        table = dataset.read(columns=columns)
    else:
        # Single file
        table = pq.read_table(
            filepath,
            columns=columns,
            filters=filters or None,
        )

    df = table.to_pandas()

    # Normalize column names
    df = df.rename(columns=COLUMN_ALIASES)

    # Validate required columns
    missing = REQUIRED_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns: {missing}")

    # Sort by timestamp
    df = df.sort_values("timestamp")

    # Convert to list of dicts
    records = df.to_dict("records")

    # Convert timestamps to ISO strings
    for record in records:
        if isinstance(record["timestamp"], pd.Timestamp):
            record["timestamp"] = record["timestamp"].isoformat()

    logger.info("Loaded %d bars from %s", len(records), filepath)
    return records


def load_parquet_chunked(
    filepath: str | Path,
    chunk_size: int = 100_000,
):
    """Generator that yields bar data in chunks for large files.

    Codex addition: streaming/chunked reads for large datasets.
    """
    filepath = Path(filepath)
    parquet_file = pq.ParquetFile(filepath)

    for batch in parquet_file.iter_batches(batch_size=chunk_size):
        df = batch.to_pandas()
        df = df.rename(columns=COLUMN_ALIASES)
        yield df.to_dict("records")
```

**Verification**:
1. Load a Parquet file with OHLCV data -> returns list of dicts
2. Filter by date range -> only matching bars returned
3. Chunked loading for 1M+ row file -> memory stays low
4. Missing required columns -> raises ValueError

**Dependencies**: None

---

### FIX-E002 [P1] Add strategy validation before backtest run

**Problem**: Invalid strategies (missing evaluate method, wrong signature) cause cryptic runtime errors. Should validate upfront.

**Files to create**:
- `engine/quantlab/api/validation.py`

**Implementation**:

```python
# engine/quantlab/api/validation.py

"""Strategy validation for backtest runs.

FIX-E002: Validates strategy structure before execution to provide
clear error messages instead of cryptic runtime failures.
"""

import inspect
import importlib.util
from pathlib import Path
from typing import Any

class ValidationError(Exception):
    """Strategy validation failed."""
    def __init__(self, message: str, errors: list[str]):
        self.errors = errors
        super().__init__(message)


def validate_strategy_file(filepath: str) -> list[str]:
    """Validate a strategy file before execution.

    Returns list of error messages (empty = valid).
    """
    errors = []
    path = Path(filepath)

    # Check file exists
    if not path.exists():
        errors.append(f"Strategy file not found: {filepath}")
        return errors

    if not path.suffix == ".py":
        errors.append(f"Strategy file must be a .py file, got: {path.suffix}")
        return errors

    # Try to import the module
    try:
        spec = importlib.util.spec_from_file_location("strategy_module", filepath)
        if spec is None or spec.loader is None:
            errors.append(f"Cannot create module spec from {filepath}")
            return errors

        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except SyntaxError as e:
        errors.append(f"Syntax error in strategy: {e}")
        return errors
    except Exception as e:
        errors.append(f"Failed to load strategy: {e}")
        return errors

    # Check for evaluate function or Strategy class
    has_evaluate = hasattr(module, "evaluate")
    has_strategy_class = False

    for name, obj in inspect.getmembers(module, inspect.isclass):
        if hasattr(obj, "evaluate"):
            has_strategy_class = True
            # Validate evaluate signature
            sig = inspect.signature(obj.evaluate)
            params = list(sig.parameters.keys())
            if len(params) < 3:  # self, data, bar_index
                errors.append(
                    f"Class {name}.evaluate() must accept (self, data, bar_index), "
                    f"got {params}"
                )

    if not has_evaluate and not has_strategy_class:
        errors.append(
            "Strategy must define either an 'evaluate' function or a class "
            "with an 'evaluate' method that accepts (data, bar_index)"
        )

    return errors


def validate_strategy(strategy: Any) -> list[str]:
    """Validate a strategy instance."""
    errors = []

    if not hasattr(strategy, "evaluate"):
        errors.append("Strategy must have an 'evaluate' method")
        return errors

    sig = inspect.signature(strategy.evaluate)
    params = list(sig.parameters.keys())

    # Should accept data and bar_index (plus self if bound)
    if "data" not in params and "bar_index" not in params:
        if len(params) < 2:
            errors.append(
                f"Strategy.evaluate() must accept (data, bar_index), got params: {params}"
            )

    return errors
```

**Verification**:
1. Valid strategy file -> empty errors list
2. Missing evaluate method -> clear error message
3. Wrong signature -> error with expected signature
4. Syntax error in file -> error with line info

**Dependencies**: None

---

### FIX-E003 [P2] Centralize annualization factor (252/365/custom)

**Problem**: Annualization factor (252 trading days vs 365 calendar days) is hardcoded in multiple places.

**Files to modify**:
- `engine/quantlab/metrics/annualize.py` (create)

**Implementation**:

```python
# engine/quantlab/metrics/annualize.py

"""Centralized annualization factor.

FIX-E003: Single source of truth for trading day count.
"""

from enum import Enum

class AnnualizationBasis(Enum):
    TRADING_DAYS = 252
    CALENDAR_DAYS = 365
    CRYPTO = 365  # 24/7 markets

# Default: US equity trading days
DEFAULT_TRADING_DAYS = 252

def get_annualization_factor(
    timeframe: str = "1D",
    basis: AnnualizationBasis = AnnualizationBasis.TRADING_DAYS,
) -> float:
    """Get annualization factor for a given timeframe and basis.

    Returns the number of periods per year.
    """
    base = basis.value

    factors = {
        "1D": base,
        "1W": base / 5,
        "1M": 12,
        "1H": base * 6.5,       # 6.5 trading hours/day
        "30min": base * 13,
        "15min": base * 26,
        "5min": base * 78,
        "1min": base * 390,
    }

    return factors.get(timeframe, base)
```

**Verification**:
1. Daily Sharpe uses sqrt(252)
2. Hourly Sharpe uses sqrt(252 * 6.5)
3. Crypto daily Sharpe uses sqrt(365)

**Dependencies**: None

---

### FIX-E005 [P2] Support custom metrics registration

**Problem**: Users can't register custom performance metrics for backtest results.

**Files to modify**:
- `engine/quantlab/metrics/__init__.py`

**Implementation**:

```python
# engine/quantlab/metrics/__init__.py

"""Metrics registry with custom metric support.

FIX-E005: Users can register custom metrics that are computed
alongside built-in metrics after each backtest run.
"""

from typing import Callable, Any

# Registry of custom metrics
_custom_metrics: dict[str, Callable] = {}


def register_metric(
    name: str,
    fn: Callable[[list[float], dict], float],
    description: str = "",
):
    """Register a custom metric function.

    Args:
        name: Metric name (e.g., 'ulcer_index')
        fn: Function(equity_curve, context) -> float
        description: Human-readable description
    """
    _custom_metrics[name] = {
        "fn": fn,
        "description": description,
    }


def compute_custom_metrics(
    equity_curve: list[float],
    context: dict,
) -> dict[str, float]:
    """Compute all registered custom metrics."""
    results = {}
    for name, spec in _custom_metrics.items():
        try:
            results[name] = spec["fn"](equity_curve, context)
        except Exception as e:
            results[name] = float("nan")
    return results


def list_metrics() -> list[dict]:
    """List all registered custom metrics."""
    return [
        {"name": name, "description": spec["description"]}
        for name, spec in _custom_metrics.items()
    ]
```

**Verification**:
1. Register custom metric (e.g., Ulcer Index)
2. Run backtest -> custom metric appears in results
3. Error in custom metric -> NaN value, no crash

**Dependencies**: None

---

### FIX-E006 [P3] Expose DataRev chain verification

**Problem**: DataRev provenance tracking exists but verification is not exposed.

**Files to modify**:
- `engine/quantlab/data/rev.py`

**Implementation**:

```python
# engine/quantlab/data/rev.py
# Add verification method:

def verify_chain(self) -> tuple[bool, list[str]]:
    """Verify the DataRev chain integrity.

    FIX-E006: Exposes chain verification for audit purposes.

    Returns:
        (is_valid, list_of_errors)
    """
    errors = []

    for i, rev in enumerate(self._chain):
        # Verify hash
        expected_hash = self._compute_hash(rev.data)
        if rev.hash != expected_hash:
            errors.append(
                f"Rev {i} hash mismatch: expected {expected_hash[:16]}..., "
                f"got {rev.hash[:16]}..."
            )

        # Verify parent link
        if i > 0 and rev.parent_hash != self._chain[i - 1].hash:
            errors.append(
                f"Rev {i} parent hash mismatch: expected {self._chain[i-1].hash[:16]}..., "
                f"got {rev.parent_hash[:16]}..."
            )

    return len(errors) == 0, errors
```

**Verification**:
1. Build chain with 3 revisions -> verify returns (True, [])
2. Tamper with a revision -> verify returns (False, [error details])

**Dependencies**: None

---

## Phase Verification Checklist

- [ ] Stop orders fill at gap-through price (open), not stop price
- [ ] Stop-limit orders correctly handle gap past both prices
- [ ] GTC partial fills requeue remaining quantity
- [ ] IOC partial fills cancel remaining quantity
- [ ] Multi-asset temporal alignment validated (not just bar count)
- [ ] Forward-fill detection identifies gaps using market calendar
- [ ] Dollar amounts quantized to cents (no floating-point drift)
- [ ] Margin call triggered when equity hits zero
- [ ] Zero-volume bars don't generate limit/stop fills
- [ ] Borrow fees prorated for intraday timeframes
- [ ] Error return includes positions MTM in final equity
- [ ] Collateral calculation rejects zero/negative prices
- [ ] Parquet data loader works with single files and partitioned datasets
- [ ] Strategy validation catches missing evaluate method
- [ ] All existing golden tests still pass after fixes

## Status Corrections

| Prior Claim | Actual Status |
|------------|---------------|
| "Backtest engine not implemented" | BacktestEngine is 1256 lines with full order lifecycle |
| "No fill logic" | Fill logic exists for all 4 order types, needs edge case fixes |
| "No short selling" | Short selling with 100% collateral model, borrow fees, and collateral validation exists |

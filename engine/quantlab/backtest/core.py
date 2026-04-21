"""
Core Backtest Engine.

Implements the main backtest loop with t/t+1 signal/execution bar semantics.

Spec Reference: Technical Spec §3.1

Time Indexing:
    - Signal bar t: Data used to compute signals (OHLCV known)
    - Execution bar t+1: Bar during which orders fill
    - Strategy sees data up to and including signal bar
    - Orders generated from bar t execute on bar t+1
"""

import logging
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Any
from typing import Callable
from typing import Protocol

from quantlab.backtest.bar import Bar
from quantlab.backtest.bar import BarSeries
from quantlab.backtest.commission import CommissionCalculator
from quantlab.backtest.commission import create_commission_calculator
from quantlab.backtest.config import BacktestConfig
from quantlab.backtest.fills import FillAssumption
from quantlab.precision.money import quantize_dollars
from quantlab.backtest.fills import FillResult
from quantlab.backtest.fills import VolumeTracker
from quantlab.backtest.fills import get_fill_calculator
from quantlab.backtest.slippage import SlippageCalculator
from quantlab.backtest.slippage import create_slippage_calculator


logger = logging.getLogger(__name__)


from quantlab.orders.base import OrderSide  # noqa: E402 — canonical definition in orders/base.py


class OrderType(Enum):
    """Order type."""

    MARKET = "market"
    LIMIT = "limit"
    STOP = "stop"
    STOP_LIMIT = "stop_limit"


from quantlab.orders.tif import TimeInForce  # noqa: E402 — canonical definition in orders/tif.py


class OrderStatus(Enum):
    """Order status."""

    PENDING = "pending"
    FILLED = "filled"
    PARTIALLY_FILLED = "partially_filled"
    CANCELLED = "cancelled"
    REJECTED = "rejected"
    EXPIRED = "expired"


class OrderPriority(Enum):
    """
    Order priority for processing.

    Spec Reference: Technical Spec §4 - Order Priority
    Priority order: exits > stop-losses > entries

    Higher values = higher priority (processed first).
    """

    EXIT = 3  # Closing positions (SELL existing long, BUY_TO_COVER short)
    STOP_LOSS = 2  # Stop orders (protective stops)
    ENTRY = 1  # Opening new positions


@dataclass
class Order:
    """Order representation."""

    order_id: str
    symbol: str
    side: OrderSide
    order_type: OrderType
    quantity: Decimal
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    time_in_force: TimeInForce = TimeInForce.GFD
    signal_bar_index: int = 0  # Bar that generated this order
    created_at: datetime | None = None
    status: OrderStatus = OrderStatus.PENDING
    filled_quantity: Decimal = Decimal("0")
    avg_fill_price: Decimal | None = None

    @property
    def remaining_quantity(self) -> Decimal:
        """Remaining quantity to fill."""
        return self.quantity - self.filled_quantity

    @property
    def is_buy(self) -> bool:
        """Check if buy order (including buy to cover)."""
        return self.side in (OrderSide.BUY, OrderSide.BUY_TO_COVER)

    @property
    def is_sell(self) -> bool:
        """Check if sell order (including short sell)."""
        return self.side in (OrderSide.SELL, OrderSide.SELL_SHORT)

    @property
    def is_short(self) -> bool:
        """Check if short-related order."""
        return self.side in (OrderSide.SELL_SHORT, OrderSide.BUY_TO_COVER)

    def get_priority(self, current_position: Decimal) -> OrderPriority:
        """
        Determine order priority based on current position.

        Priority order per spec: exits > stop-losses > entries

        Args:
            current_position: Current position quantity for this symbol
                             (positive = long, negative = short, zero = flat)

        Returns:
            OrderPriority for sorting
        """
        # Stop orders get stop-loss priority (protective)
        if self.order_type in (OrderType.STOP, OrderType.STOP_LIMIT):
            return OrderPriority.STOP_LOSS

        # Check if this is an exit order (reduces or closes position)
        if current_position > Decimal("0"):
            # Long position: SELL is exit
            if self.side == OrderSide.SELL:
                return OrderPriority.EXIT
        elif current_position < Decimal("0"):
            # Short position: BUY_TO_COVER is exit
            if self.side == OrderSide.BUY_TO_COVER:
                return OrderPriority.EXIT

        # Everything else is an entry
        return OrderPriority.ENTRY


@dataclass
class Fill:
    """Fill event."""

    order_id: str
    symbol: str
    side: OrderSide
    quantity: Decimal
    price: Decimal
    commission: Decimal
    slippage: Decimal
    bar_index: int
    timestamp: datetime


@dataclass
class Signal:
    """Strategy signal."""

    symbol: str
    side: OrderSide
    quantity: Decimal
    order_type: OrderType = OrderType.MARKET
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    time_in_force: TimeInForce = TimeInForce.GFD

    @property
    def is_short_related(self) -> bool:
        """Check if signal is short-related (sell short or buy to cover)."""
        return self.side in (OrderSide.SELL_SHORT, OrderSide.BUY_TO_COVER)


class Strategy(Protocol):
    """Strategy protocol."""

    def evaluate(self, data: dict[str, BarSeries], bar_index: int) -> list[Signal]:
        """
        Evaluate strategy and generate signals.

        Args:
            data: Dictionary of symbol -> BarSeries (up to current bar)
            bar_index: Current bar index

        Returns:
            List of signals to execute
        """
        ...


@dataclass
class BacktestState:
    """Current backtest state."""

    bar_index: int = 0
    cash: Decimal = Decimal("0")
    positions: dict[str, Decimal] = field(default_factory=dict)  # symbol -> quantity
    pending_orders: list[Order] = field(default_factory=list)
    fills: list[Fill] = field(default_factory=list)
    equity_curve: list[Decimal] = field(default_factory=list)
    total_borrow_fees: Decimal = Decimal("0")  # Accumulated borrow fees for shorts
    margin_called: bool = False  # NEW-ENG-007: Whether margin call was triggered
    margin_call_bar: int | None = None  # NEW-ENG-007: Bar index where margin call occurred

    @property
    def long_value(self) -> Decimal:
        """Total value of long positions (needs prices)."""
        return Decimal("0")  # Will be calculated with prices

    @property
    def short_value(self) -> Decimal:
        """Total value of short positions (needs prices)."""
        return Decimal("0")  # Will be calculated with prices


@dataclass
class BacktestResult:
    """Complete backtest result."""

    config: BacktestConfig
    equity_curve: list[Decimal]
    trades: list[Fill]
    final_equity: Decimal
    total_return: Decimal
    total_trades: int
    winning_trades: int
    losing_trades: int
    start_time: datetime
    end_time: datetime
    total_borrow_fees: Decimal = Decimal("0")  # Total borrow fees paid for shorts
    margin_called: bool = False  # NEW-ENG-007: Whether margin call was triggered
    margin_call_bar: int | None = None  # NEW-ENG-007: Bar index where margin call occurred
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "final_equity": str(self.final_equity),
            "total_return": str(self.total_return),
            "total_trades": self.total_trades,
            "winning_trades": self.winning_trades,
            "losing_trades": self.losing_trades,
            "total_borrow_fees": str(self.total_borrow_fees),
            "start_time": self.start_time.isoformat(),
            "end_time": self.end_time.isoformat(),
            "error": self.error,
        }


class BacktestEngine:
    """
    Core backtest engine.

    Implements the canonical backtest loop with proper t/t+1 semantics.
    """

    def __init__(self, config: BacktestConfig) -> None:
        self.config = config

        # Initialize cost models
        self._fill_calculator = get_fill_calculator(config.fill_assumption)
        self._slippage = create_slippage_calculator(
            config.slippage_model,
            config.slippage_params,
        )
        self._commission = create_commission_calculator(
            config.commission_model,
            config.commission_params,
        )
        self._volume_tracker = VolumeTracker(config.max_volume_participation)

        # State
        self._state = BacktestState(cash=config.initial_capital)
        self._data: dict[str, BarSeries] = {}
        self._order_id_counter = 0

        # Callbacks
        self._on_bar: Callable[[int, Bar], None] | None = None
        self._on_fill: Callable[[Fill], None] | None = None

    def load_data(self, data: dict[str, BarSeries]) -> None:
        """
        Load bar data for backtest.

        Args:
            data: Dictionary of symbol -> BarSeries

        Raises:
            ValueError: If symbols have different bar counts
        """
        if not data:
            self._data = data
            return

        # Validate that all symbols have the same number of bars
        bar_counts = {symbol: len(series) for symbol, series in data.items()}
        unique_counts = set(bar_counts.values())

        if len(unique_counts) > 1:
            # Build detailed error message
            count_groups: dict[int, list[str]] = {}
            for symbol, count in bar_counts.items():
                if count not in count_groups:
                    count_groups[count] = []
                count_groups[count].append(symbol)

            details = "; ".join(
                f"{count} bars: {', '.join(symbols[:3])}"
                + (f" (+{len(symbols)-3} more)" if len(symbols) > 3 else "")
                for count, symbols in sorted(count_groups.items())
            )

            raise ValueError(
                f"Multi-asset bar alignment error: symbols have different bar counts. {details}. "
                f"All symbols must have the same number of bars for backtest."
            )

        # NEW-ENG-003: Validate temporal alignment (not just bar count)
        if len(data) > 1:
            symbols = list(data.keys())
            ref_symbol = symbols[0]
            ref_series = data[ref_symbol]
            ref_first = ref_series[0].timestamp if hasattr(ref_series[0], 'timestamp') else None
            ref_last = ref_series[-1].timestamp if hasattr(ref_series[-1], 'timestamp') else None

            if ref_first is not None and ref_last is not None:
                for symbol in symbols[1:]:
                    series = data[symbol]
                    sym_first = series[0].timestamp if hasattr(series[0], 'timestamp') else None
                    sym_last = series[-1].timestamp if hasattr(series[-1], 'timestamp') else None

                    if sym_first is not None and sym_last is not None:
                        if sym_first != ref_first or sym_last != ref_last:
                            raise ValueError(
                                f"Temporal misalignment: {ref_symbol} covers "
                                f"{ref_first} to {ref_last}, but {symbol} covers "
                                f"{sym_first} to {sym_last}. "
                                f"All symbols must share the same date range."
                            )

        self._data = data
        logger.info(f"Loaded data for {len(data)} symbols ({next(iter(unique_counts))} bars each)")

    def run(self, strategy: Strategy) -> BacktestResult:
        """
        Run the backtest.

        Args:
            strategy: Strategy to backtest

        Returns:
            BacktestResult with all metrics
        """
        start_time = datetime.now()

        try:
            # Validate we have data
            if not self._data:
                raise ValueError("No data loaded")

            # Get number of bars (assume all series same length)
            first_series = next(iter(self._data.values()))
            num_bars = len(first_series)

            logger.info(f"Starting backtest: {num_bars} bars")

            # Initialize equity curve
            self._state.equity_curve = [self.config.initial_capital]

            # Main loop
            for bar_index in range(num_bars):
                self._process_bar(bar_index, strategy)

            # Final mark-to-market
            final_equity = self._calculate_equity(num_bars - 1)

            # Calculate winning/losing trades once (efficiency fix)
            winning_trades, losing_trades = self._count_winning_and_losing_trades()

            return BacktestResult(
                config=self.config,
                equity_curve=self._state.equity_curve,
                trades=self._state.fills,
                final_equity=final_equity,
                total_return=(final_equity / self.config.initial_capital) - Decimal("1"),
                total_trades=len(self._state.fills),
                winning_trades=winning_trades,
                losing_trades=losing_trades,
                start_time=start_time,
                end_time=datetime.now(),
                total_borrow_fees=self._state.total_borrow_fees,
                margin_called=self._state.margin_called,
                margin_call_bar=self._state.margin_call_bar,
            )

        except Exception as e:
            logger.error(f"Backtest error: {e}")

            # NEW-ENG-010: Calculate final equity including positions MTM, not just cash
            final_equity = self._state.cash
            if self._state.bar_index > 0:
                for symbol, qty in self._state.positions.items():
                    if symbol in self._data and qty != Decimal("0"):
                        price = self._data[symbol][self._state.bar_index].close
                        final_equity += qty * price

            return BacktestResult(
                config=self.config,
                equity_curve=self._state.equity_curve,
                trades=self._state.fills,
                final_equity=final_equity,
                total_return=(final_equity / self.config.initial_capital) - Decimal("1") if self.config.initial_capital > 0 else Decimal("0"),
                total_trades=len(self._state.fills),
                winning_trades=0,
                losing_trades=0,
                start_time=start_time,
                end_time=datetime.now(),
                total_borrow_fees=self._state.total_borrow_fees,
                margin_called=self._state.margin_called,
                margin_call_bar=self._state.margin_call_bar,
                error=str(e),
            )

    def _process_bar(self, bar_index: int, strategy: Strategy) -> None:
        """
        Process a single bar.

        Order of operations:
        1. Process fills from pending orders (orders from t-1 execute on t)
        2. Expire unfilled GFD orders (after they've had a chance to fill)
        3. Strategy evaluates on bar t data
        4. New orders queued for execution on t+1
        5. Mark-to-market at close
        """
        self._state.bar_index = bar_index

        # 1. Process fills from previous bar's orders FIRST
        # Orders must get a chance to execute before being expired
        if bar_index > 0:
            self._process_pending_orders(bar_index)

        # 2. Expire unfilled GFD orders AFTER fill processing
        # GFD orders should be valid for one execution opportunity
        self._expire_gfd_orders(bar_index)

        # 3. Strategy evaluates
        # Create view of data up to current bar
        data_view = {
            symbol: series.up_to(bar_index)
            for symbol, series in self._data.items()
        }

        signals = strategy.evaluate(data_view, bar_index)

        # 4. Queue new orders for next bar execution
        for signal in signals:
            # Check if short selling is allowed
            if signal.is_short_related and not self.config.allow_short:
                # Reject short-related signals when shorting is disabled
                continue

            order = self._create_order(signal, bar_index)
            self._state.pending_orders.append(order)

        # 5. Accrue borrow fees for short positions (if enabled)
        if self.config.allow_short and self.config.borrow_fee_rate > Decimal("0"):
            self._accrue_borrow_fees(bar_index)

        # 6. Mark-to-market
        equity = self._calculate_equity(bar_index)
        self._state.equity_curve.append(equity)

        # NEW-ENG-007: Margin call protection — liquidate all positions if equity <= 0
        if equity <= Decimal("0") and self._state.positions:
            logger.warning(
                "MARGIN CALL: Equity dropped to %s at bar %d. Liquidating all positions.",
                equity, bar_index,
            )
            for symbol, qty in list(self._state.positions.items()):
                if qty == Decimal("0"):
                    continue
                close_bar = self._data[symbol][bar_index]
                side = OrderSide.SELL if qty > Decimal("0") else OrderSide.BUY_TO_COVER
                margin_fill = Fill(
                    order_id=f"MARGIN_CALL_{symbol}_{bar_index}",
                    symbol=symbol,
                    side=side,
                    quantity=abs(qty),
                    price=close_bar.close,
                    commission=Decimal("0"),
                    slippage=Decimal("0"),
                    bar_index=bar_index,
                    timestamp=close_bar.timestamp,
                )
                self._apply_fill(margin_fill)
                self._state.fills.append(margin_fill)
            self._state.pending_orders.clear()
            self._state.margin_called = True
            self._state.margin_call_bar = bar_index

        # Callback
        if self._on_bar:
            bar = next(iter(self._data.values()))[bar_index]
            self._on_bar(bar_index, bar)

    def _process_pending_orders(self, execution_bar_index: int) -> None:
        """
        Process pending orders on the execution bar.

        Orders are processed in priority order per spec:
        exits > stop-losses > entries
        """
        orders_to_remove = []

        # Track accumulated exposure from fills within this bar
        accumulated_exposure = Decimal("0")

        # Sort orders by priority (exits first, then stop-losses, then entries)
        # Higher priority value = processed first
        def order_sort_key(order: Order) -> tuple[int, int]:
            current_position = self._state.positions.get(order.symbol, Decimal("0"))
            priority = order.get_priority(current_position)
            # Negate priority value for descending sort (higher priority first)
            # Use signal_bar_index as secondary sort for FIFO within same priority
            return (-priority.value, order.signal_bar_index)

        sorted_orders = sorted(self._state.pending_orders, key=order_sort_key)

        for order in sorted_orders:
            # Only process orders that were created before this bar
            if order.signal_bar_index >= execution_bar_index:
                continue

            # GFD orders only get one execution opportunity (the bar after creation)
            # If we're past that bar, skip the order (it will be expired later)
            if order.time_in_force == TimeInForce.GFD:
                execution_bar = order.signal_bar_index + 1
                if execution_bar_index > execution_bar:
                    # Past the execution bar - skip, will be expired
                    continue

            # Get execution bar
            if order.symbol not in self._data:
                order.status = OrderStatus.REJECTED
                orders_to_remove.append(order)
                continue

            execution_bar = self._data[order.symbol][execution_bar_index]

            # Check buying power for buy orders
            if order.is_buy:
                estimated_cost = order.remaining_quantity * execution_bar.open
                if estimated_cost > self._state.cash:
                    order.status = OrderStatus.REJECTED
                    orders_to_remove.append(order)
                    continue

            # Check collateral requirement for short selling
            # Must account for TOTAL collateral (existing shorts + new short)
            if order.side == OrderSide.SELL_SHORT:
                # NEW-ENG-011: Validate price before collateral calculation
                if execution_bar.open <= Decimal("0"):
                    logger.warning(
                        f"Short order rejected: invalid price {execution_bar.open} "
                        f"for {order.symbol} — cannot calculate collateral"
                    )
                    order.status = OrderStatus.REJECTED
                    orders_to_remove.append(order)
                    continue

                # Calculate value of new short position
                new_short_value = order.remaining_quantity * execution_bar.open

                # Calculate value of existing short positions at current prices
                existing_short_value = Decimal("0")
                has_invalid_short_price = False
                for symbol, position in self._state.positions.items():
                    if position < Decimal("0"):  # Negative position = short
                        if symbol in self._data:
                            symbol_bar = self._data[symbol][execution_bar_index]
                            # NEW-ENG-011: Validate prices for collateral calculation
                            if symbol_bar.open > Decimal("0"):
                                existing_short_value += abs(position) * symbol_bar.open
                            else:
                                has_invalid_short_price = True
                                logger.warning(
                                    f"Short position in {symbol} has invalid price "
                                    f"(open={symbol_bar.open}) at bar {execution_bar_index}; "
                                    f"rejecting new short order to prevent understated collateral"
                                )

                if has_invalid_short_price:
                    order.status = OrderStatus.REJECTED
                    orders_to_remove.append(order)
                    continue

                # Total collateral required for all shorts
                total_short_value = existing_short_value + new_short_value
                required_collateral = total_short_value * self.config.short_collateral_ratio

                current_equity = self._calculate_equity(execution_bar_index)
                if current_equity < required_collateral:
                    logger.debug(
                        f"Short order rejected: equity {current_equity} < "
                        f"required collateral {required_collateral} "
                        f"(existing shorts: {existing_short_value}, new: {new_short_value})"
                    )
                    order.status = OrderStatus.REJECTED
                    orders_to_remove.append(order)
                    continue

            # Check sell quantity when shorting is disabled
            sell_limited_qty: Decimal | None = None
            if order.side == OrderSide.SELL and not self.config.allow_short:
                current_position = self._state.positions.get(order.symbol, Decimal("0"))
                if current_position <= Decimal("0"):
                    # No long position to sell
                    order.status = OrderStatus.REJECTED
                    orders_to_remove.append(order)
                    continue
                if order.remaining_quantity > current_position:
                    logger.warning(
                        f"SELL quantity {order.remaining_quantity} exceeds long position "
                        f"{current_position} for {order.symbol}. Limiting to {current_position} "
                        f"(short selling disabled)."
                    )
                    # Limit sell to owned quantity
                    sell_limited_qty = current_position

            # Check BUY_TO_COVER quantity - limit to short position size
            # to prevent creating unintended long positions
            buy_to_cover_limited_qty: Decimal | None = None
            if order.side == OrderSide.BUY_TO_COVER:
                current_position = self._state.positions.get(order.symbol, Decimal("0"))
                if current_position >= Decimal("0"):
                    # No short position to cover
                    order.status = OrderStatus.REJECTED
                    orders_to_remove.append(order)
                    continue
                # Limit to short quantity (abs of negative position)
                short_qty = abs(current_position)
                if order.remaining_quantity > short_qty:
                    logger.warning(
                        f"BUY_TO_COVER quantity {order.remaining_quantity} exceeds short position "
                        f"{short_qty} for {order.symbol}. Limiting to {short_qty} to prevent "
                        f"creating unintended long position."
                    )
                    buy_to_cover_limited_qty = short_qty

            # Check max_position_size limit for both long and short positions (symmetric)
            position_size_limited_qty: Decimal | None = None
            if self.config.max_position_size is not None:
                current_position = self._state.positions.get(order.symbol, Decimal("0"))
                max_pos = self.config.max_position_size

                # For BUY orders - limit long position size
                if order.side == OrderSide.BUY:
                    if current_position >= Decimal("0"):
                        # Already long or flat - limit to max position
                        remaining_capacity = max_pos - current_position
                        if remaining_capacity <= Decimal("0"):
                            order.status = OrderStatus.REJECTED
                            orders_to_remove.append(order)
                            logger.debug(
                                f"Order rejected: long position {current_position} already at max "
                                f"{max_pos}"
                            )
                            continue
                        if order.remaining_quantity > remaining_capacity:
                            position_size_limited_qty = remaining_capacity

                # For SELL_SHORT orders - limit short position size (symmetric)
                elif order.side == OrderSide.SELL_SHORT:
                    # Short positions are negative, so abs(current_position) is size
                    current_short_size = abs(min(current_position, Decimal("0")))
                    remaining_capacity = max_pos - current_short_size
                    if remaining_capacity <= Decimal("0"):
                        order.status = OrderStatus.REJECTED
                        orders_to_remove.append(order)
                        logger.debug(
                            f"Order rejected: short position size {current_short_size} already at max "
                            f"{max_pos}"
                        )
                        continue
                    if order.remaining_quantity > remaining_capacity:
                        position_size_limited_qty = remaining_capacity

            # Check exposure limits and limit order quantity if needed
            # Apply to both buys and short sells to limit total exposure
            exposure_limited_qty: Decimal | None = None
            if self.config.max_exposure is not None and (order.is_buy or order.side == OrderSide.SELL_SHORT):
                max_exp = self.config.max_exposure
                allowed_qty = self._calculate_max_allowed_quantity(
                    order, execution_bar.open, accumulated_exposure
                )
                if allowed_qty <= Decimal("0"):
                    order.status = OrderStatus.REJECTED
                    orders_to_remove.append(order)
                    continue
                if allowed_qty < order.remaining_quantity:
                    # If max_exposure is a percentage (<= 1), reject orders that breach
                    # If max_exposure is absolute (> 1), allow partial fills
                    if max_exp <= Decimal("1"):
                        order.status = OrderStatus.REJECTED
                        orders_to_remove.append(order)
                        continue
                    else:
                        exposure_limited_qty = allowed_qty

            # Determine final max quantity from all limits
            all_limits = [
                lim for lim in [
                    sell_limited_qty,
                    buy_to_cover_limited_qty,
                    exposure_limited_qty,
                    position_size_limited_qty,
                ]
                if lim is not None
            ]
            max_qty: Decimal | None = min(all_limits) if all_limits else None

            # Attempt fill
            fill_result = self._attempt_fill(order, execution_bar, max_qty)

            if fill_result.filled:
                # FOK orders must fill completely or not at all
                if order.time_in_force == TimeInForce.FOK:
                    if fill_result.fill_quantity < order.remaining_quantity:
                        # Cannot fill entire order - cancel it
                        order.status = OrderStatus.CANCELLED
                        orders_to_remove.append(order)
                        continue

                # Create fill record
                fill = Fill(
                    order_id=order.order_id,
                    symbol=order.symbol,
                    side=order.side,
                    quantity=fill_result.fill_quantity,  # type: ignore
                    price=fill_result.fill_price,  # type: ignore
                    commission=self._commission.calculate(
                        fill_result.fill_quantity,  # type: ignore
                        fill_result.fill_price,  # type: ignore
                        order.is_buy,
                    ),
                    slippage=Decimal("0"),  # Already included in price
                    bar_index=execution_bar_index,
                    timestamp=execution_bar.timestamp,
                )

                # Update order
                order.filled_quantity += fill_result.fill_quantity  # type: ignore
                if order.remaining_quantity == Decimal("0"):
                    order.status = OrderStatus.FILLED
                    orders_to_remove.append(order)
                elif order.time_in_force == TimeInForce.IOC:
                    # IOC orders cancel remaining after partial fill
                    order.status = OrderStatus.CANCELLED
                    orders_to_remove.append(order)
                elif order.time_in_force == TimeInForce.FOK:
                    # FOK should never reach here (handled above), but safety check
                    order.status = OrderStatus.CANCELLED
                    orders_to_remove.append(order)
                else:
                    order.status = OrderStatus.PARTIALLY_FILLED

                # Update position and cash
                self._apply_fill(fill)

                # Track accumulated exposure from buy orders in this bar
                if order.is_buy:
                    accumulated_exposure += fill.quantity * fill.price

                # Record fill
                self._state.fills.append(fill)

                if self._on_fill:
                    self._on_fill(fill)

        # Remove filled/rejected orders (set-based O(n) instead of O(n*m))
        if orders_to_remove:
            remove_ids = {id(o) for o in orders_to_remove}
            self._state.pending_orders = [
                o for o in self._state.pending_orders
                if id(o) not in remove_ids
            ]

        # Reset volume tracker for next bar (accumulated volume is bar-specific)
        self._volume_tracker.reset()

    def _attempt_fill(
        self, order: Order, bar: Bar, max_qty: Decimal | None = None
    ) -> FillResult:
        """
        Attempt to fill an order on the given bar.

        Args:
            order: The order to fill
            bar: The execution bar
            max_qty: Optional maximum quantity to fill (for exposure limits)

        Returns FillResult with fill details or reason for no fill.
        """
        # NEW-ENG-008: Skip limit/stop/stop-limit fills on zero-volume bars
        if bar.volume == 0 and order.order_type != OrderType.MARKET:
            return FillResult.no_fill("Zero-volume bar: limit/stop orders cannot fill")

        if order.order_type == OrderType.MARKET:
            return self._fill_market_order(order, bar, max_qty)
        elif order.order_type == OrderType.LIMIT:
            return self._fill_limit_order(order, bar, max_qty)
        elif order.order_type == OrderType.STOP:
            return self._fill_stop_order(order, bar, max_qty)
        elif order.order_type == OrderType.STOP_LIMIT:
            return self._fill_stop_limit_order(order, bar, max_qty)
        else:
            return FillResult.no_fill(f"Unknown order type: {order.order_type}")

    def _fill_market_order(
        self, order: Order, bar: Bar, max_qty: Decimal | None = None
    ) -> FillResult:
        """Fill market order."""
        # Get base price from fill assumption
        base_price = self._fill_calculator.calculate(bar)

        # Determine quantity to fill
        qty_to_fill = order.remaining_quantity
        if max_qty is not None:
            qty_to_fill = min(qty_to_fill, max_qty)

        # Apply slippage
        fill_price = self._slippage.calculate(
            base_price,
            qty_to_fill,
            order.is_buy,
            bar,
        )

        # Apply volume participation limit (accumulates across orders in same bar)
        fill_qty, remaining = self._volume_tracker.request_fill(
            bar,
            qty_to_fill,
        )

        if fill_qty == Decimal("0"):
            return FillResult.no_fill("Zero volume")

        return FillResult.success(fill_price, fill_qty, remaining)

    def _fill_limit_order(
        self, order: Order, bar: Bar, max_qty: Decimal | None = None
    ) -> FillResult:
        """Fill limit order with price improvement."""
        if order.limit_price is None:
            return FillResult.no_fill("Limit price not set")

        qty_to_fill = order.remaining_quantity
        if max_qty is not None:
            qty_to_fill = min(qty_to_fill, max_qty)

        if order.is_buy:
            # Buy limit: fill if low <= limit
            if bar.low <= order.limit_price:
                fill_price = min(bar.open, order.limit_price)  # Price improvement
                fill_qty, remaining = self._volume_tracker.request_fill(
                    bar,
                    qty_to_fill,
                )
                return FillResult.success(fill_price, fill_qty, remaining)
        else:
            # Sell limit: fill if high >= limit
            if bar.high >= order.limit_price:
                fill_price = max(bar.open, order.limit_price)  # Price improvement
                fill_qty, remaining = self._volume_tracker.request_fill(
                    bar,
                    qty_to_fill,
                )
                return FillResult.success(fill_price, fill_qty, remaining)

        return FillResult.no_fill("Limit price not reached")

    def _fill_stop_order(
        self, order: Order, bar: Bar, max_qty: Decimal | None = None
    ) -> FillResult:
        """Fill stop order."""
        if order.stop_price is None:
            return FillResult.no_fill("Stop price not set")

        triggered = False
        trigger_price = order.stop_price

        if order.is_buy:
            # Buy stop: trigger when price rises to stop
            if bar.high >= order.stop_price:
                triggered = True
                if bar.open >= order.stop_price:
                    trigger_price = bar.open  # Gap through
        else:
            # Sell stop: trigger when price falls to stop
            if bar.low <= order.stop_price:
                triggered = True
                if bar.open <= order.stop_price:
                    trigger_price = bar.open  # Gap through

        if triggered:
            qty_to_fill = order.remaining_quantity
            if max_qty is not None:
                qty_to_fill = min(qty_to_fill, max_qty)

            # Apply slippage to trigger price
            fill_price = self._slippage.calculate(
                trigger_price,
                qty_to_fill,
                order.is_buy,
                bar,
            )
            fill_qty, remaining = self._volume_tracker.request_fill(
                bar,
                qty_to_fill,
            )
            return FillResult.success(fill_price, fill_qty, remaining)

        return FillResult.no_fill("Stop price not triggered")

    def _fill_stop_limit_order(
        self, order: Order, bar: Bar, max_qty: Decimal | None = None
    ) -> FillResult:
        """Fill stop-limit order."""
        if order.stop_price is None or order.limit_price is None:
            return FillResult.no_fill("Stop or limit price not set")

        # First check if stop is triggered
        triggered = False
        trigger_price = order.stop_price

        if order.is_buy:
            if bar.high >= order.stop_price:
                triggered = True
                # If opened at or above stop, gap through
                if bar.open >= order.stop_price:
                    trigger_price = bar.open
        else:
            if bar.low <= order.stop_price:
                triggered = True
                # If opened at or below stop, gap through
                if bar.open <= order.stop_price:
                    trigger_price = bar.open

        if not triggered:
            return FillResult.no_fill("Stop price not triggered")

        qty_to_fill = order.remaining_quantity
        if max_qty is not None:
            qty_to_fill = min(qty_to_fill, max_qty)

        # Now apply limit logic - fill at stop price if within limit
        if order.is_buy:
            # Buy stop-limit: stop triggers, then fill at trigger_price if <= limit
            if trigger_price <= order.limit_price:
                fill_qty, remaining = self._volume_tracker.request_fill(
                    bar,
                    qty_to_fill,
                )
                return FillResult.success(trigger_price, fill_qty, remaining)
        else:
            # Sell stop-limit: stop triggers, then fill at trigger_price if >= limit
            if trigger_price >= order.limit_price:
                fill_qty, remaining = self._volume_tracker.request_fill(
                    bar,
                    qty_to_fill,
                )
                return FillResult.success(trigger_price, fill_qty, remaining)

        return FillResult.no_fill("Limit price not reached after stop trigger")

    def _apply_fill(self, fill: Fill) -> None:
        """Apply fill to positions and cash.

        NEW-ENG-006: Quantize cash changes to prevent floating-point penny drift.
        """
        notional = fill.quantity * fill.price
        current = self._state.positions.get(fill.symbol, Decimal("0"))

        if fill.side == OrderSide.BUY:
            # Buying long: decrease cash, increase position
            self._state.cash -= quantize_dollars(notional + fill.commission)
            self._state.positions[fill.symbol] = current + fill.quantity

        elif fill.side == OrderSide.SELL:
            # Selling long position: increase cash, decrease position
            self._state.cash += quantize_dollars(notional - fill.commission)
            self._state.positions[fill.symbol] = current - fill.quantity

        elif fill.side == OrderSide.SELL_SHORT:
            # Short selling: receive proceeds, create negative position
            # Note: Cash increases by proceeds, position becomes negative
            self._state.cash += quantize_dollars(notional - fill.commission)
            self._state.positions[fill.symbol] = current - fill.quantity

        elif fill.side == OrderSide.BUY_TO_COVER:
            # Covering short: pay to buy back, reduce negative position
            self._state.cash -= quantize_dollars(notional + fill.commission)
            self._state.positions[fill.symbol] = current + fill.quantity

        # Remove zero positions
        if fill.symbol in self._state.positions:
            if self._state.positions[fill.symbol] == Decimal("0"):
                del self._state.positions[fill.symbol]

    def _create_order(self, signal: Signal, bar_index: int) -> Order:
        """Create order from signal."""
        self._order_id_counter += 1
        bar = self._data[signal.symbol][bar_index]

        return Order(
            order_id=f"ord-{self._order_id_counter:06d}",
            symbol=signal.symbol,
            side=signal.side,
            order_type=signal.order_type,
            quantity=signal.quantity,
            limit_price=signal.limit_price,
            stop_price=signal.stop_price,
            time_in_force=signal.time_in_force,
            signal_bar_index=bar_index,
            created_at=bar.timestamp,
        )

    def _expire_gfd_orders(self, bar_index: int) -> None:
        """
        Expire GFD orders after they've had their execution opportunity.

        GFD (Good For Day) semantics:
        - Order is valid for one execution opportunity
        - Order created at bar t executes at bar t+1
        - If not filled at bar t+1, expire at the start of bar t+2

        For daily bars: "day" means one bar/trading day
        For intraday bars: expire when crossing calendar day boundary AND
                          order has had at least one execution attempt
        """
        orders_to_remove = []

        for order in self._state.pending_orders:
            if order.time_in_force == TimeInForce.GFD:
                should_expire = False

                # GFD orders expire after having one execution opportunity
                # Order created at signal_bar_index=t executes at bar t+1
                # So expire when bar_index > signal_bar_index + 1
                # (i.e., we're past the execution bar)
                if bar_index > order.signal_bar_index + 1:
                    should_expire = True
                    logger.debug(
                        f"GFD order {order.order_id} expired: created at bar {order.signal_bar_index}, "
                        f"execution opportunity was bar {order.signal_bar_index + 1}, "
                        f"current bar {bar_index}"
                    )

                if should_expire:
                    order.status = OrderStatus.EXPIRED
                    orders_to_remove.append(order)

        for order in orders_to_remove:
            self._state.pending_orders.remove(order)

    def _calculate_equity(self, bar_index: int) -> Decimal:
        """Calculate total equity at given bar.

        Uses mark-to-market valuation of all open positions at close price.
        Positions with invalid prices (<=0) are logged and excluded from
        the MTM component to avoid corrupting the equity curve.
        """
        equity = self._state.cash

        for symbol, quantity in self._state.positions.items():
            if symbol in self._data and quantity != Decimal("0"):
                price = self._data[symbol][bar_index].close
                if price > Decimal("0"):
                    equity += quantity * price
                else:
                    logger.warning(
                        f"Invalid close price {price} for {symbol} at bar {bar_index}; "
                        f"position excluded from equity MTM"
                    )

        return equity

    def _accrue_borrow_fees(self, bar_index: int) -> None:
        """
        Accrue borrow fees for short positions.

        Borrow fee is charged daily based on short position market value.
        NEW-ENG-009: Prorated for intraday timeframes. Also warns if borrow
        fees drive cash negative.
        """
        if not self.config.allow_short:
            return

        annual_rate = self.config.borrow_fee_rate
        # FIX-H2: Use centralized constant instead of magic number
        from quantlab.metrics.risk import EQUITY_TRADING_DAYS_PER_YEAR
        daily_rate = annual_rate / Decimal(str(EQUITY_TRADING_DAYS_PER_YEAR))

        # NEW-ENG-009: Prorate for intraday bars
        bar_rate = daily_rate * self._get_timeframe_fraction()

        total_fee = Decimal("0")

        for symbol, quantity in self._state.positions.items():
            if quantity < Decimal("0"):  # Short position
                if symbol in self._data:
                    price = self._data[symbol][bar_index].close
                    short_value = abs(quantity) * price
                    fee = short_value * bar_rate
                    total_fee += fee

        if total_fee > Decimal("0"):
            self._state.cash -= quantize_dollars(total_fee)
            self._state.total_borrow_fees += total_fee
            logger.debug(f"Bar {bar_index}: Borrow fee accrued: {total_fee}")

            # NEW-ENG-009: Warn if cash goes negative from borrow fees
            if self._state.cash < Decimal("0"):
                logger.warning(
                    "Cash negative (%s) after borrow fee accrual of %s at bar %d",
                    self._state.cash, total_fee, bar_index,
                )

    def _get_timeframe_fraction(self) -> Decimal:
        """Return fraction of a trading day for the current timeframe (NEW-ENG-009)."""
        tf = getattr(self.config, 'timeframe', '1D') or '1D'
        fractions = {
            "1D": Decimal("1"),
            "D": Decimal("1"),
            "1H": Decimal("1") / Decimal("6.5"),
            "60min": Decimal("1") / Decimal("6.5"),
            "30min": Decimal("1") / Decimal("13"),
            "15min": Decimal("1") / Decimal("26"),
            "5min": Decimal("1") / Decimal("78"),
            "1min": Decimal("1") / Decimal("390"),
        }
        return fractions.get(tf, Decimal("1"))

    def _calculate_max_allowed_quantity(
        self, order: Order, estimated_price: Decimal, accumulated_exposure: Decimal = Decimal("0")
    ) -> Decimal:
        """Calculate maximum allowed quantity based on exposure limits.

        Args:
            order: The order to check
            estimated_price: Estimated fill price
            accumulated_exposure: Exposure already accumulated from other fills in this bar
        """
        if self.config.max_exposure is None:
            return order.remaining_quantity

        max_exp = self.config.max_exposure

        # Determine if max_exposure is a percentage (<= 1) or absolute value (> 1)
        if max_exp <= Decimal("1"):
            # Percentage of equity
            equity = self._calculate_equity(self._state.bar_index)
            max_exposure_value = equity * max_exp
        else:
            # Absolute dollar value
            max_exposure_value = max_exp

        # Calculate current exposure (absolute value of all positions)
        # Use open price since fills happen at open (next_open assumption)
        current_exposure = Decimal("0")
        for symbol, qty in self._state.positions.items():
            if qty != Decimal("0") and symbol in self._data:
                price = self._data[symbol][self._state.bar_index].open
                current_exposure += abs(qty) * price

        # Note: accumulated_exposure is not used anymore since _apply_fill
        # updates positions before the next order is checked.
        # But we keep the parameter for future flexibility.
        total_exposure = current_exposure

        # Calculate how much more exposure is allowed
        remaining_exposure = max_exposure_value - total_exposure

        if remaining_exposure <= Decimal("0"):
            return Decimal("0")

        # Calculate max quantity based on remaining exposure
        max_qty = remaining_exposure / estimated_price

        return min(max_qty, order.remaining_quantity)

    def _count_winning_and_losing_trades(self) -> tuple[int, int]:
        """
        Count winning and losing trades (round trips).

        A round trip is when a position is opened and then closed.
        Calculates round trips once and counts both wins and losses.

        Returns:
            Tuple of (winning_trades, losing_trades)
        """
        winning = 0
        losing = 0
        round_trips = self._calculate_round_trips()
        for pnl in round_trips:
            if pnl > Decimal("0"):
                winning += 1
            elif pnl < Decimal("0"):
                losing += 1
            # pnl == 0 (breakeven) counts as neither
        return winning, losing

    def _count_winning_trades(self) -> int:
        """Count winning trades (deprecated - use _count_winning_and_losing_trades)."""
        winning, _ = self._count_winning_and_losing_trades()
        return winning

    def _count_losing_trades(self) -> int:
        """Count losing trades (deprecated - use _count_winning_and_losing_trades)."""
        _, losing = self._count_winning_and_losing_trades()
        return losing

    def _calculate_round_trips(self) -> list[Decimal]:
        """
        Calculate P&L for completed round trips.

        Uses FIFO matching to pair entries with exits.
        Handles both long trades (BUY -> SELL) and short trades (SELL_SHORT -> BUY_TO_COVER).
        Returns list of P&L values for each completed round trip.

        Commission handling:
        - Entry commission is tracked per fill and allocated proportionally when closing
        - Exit commission is allocated proportionally across matched entries
        - This prevents double-counting when partial fills create multiple round-trips

        Note: Borrow fees for short trades are NOT included here because they are
        already deducted from cash in _accrue_borrow_fees() and reflected in the
        equity curve. Including them here would double-count the fees.
        """
        # Track open positions with commission:
        # symbol -> {"long": [(qty, price, bar_index, commission)], "short": [...]}
        open_positions: dict[str, dict[str, list[tuple[Decimal, Decimal, int, Decimal]]]] = {}
        round_trip_pnls: list[Decimal] = []

        # Note: Borrow fees are NOT included in round-trip P&L calculation
        # because they are already deducted from cash in _accrue_borrow_fees()
        # and reflected in the equity curve.

        for fill in self._state.fills:
            symbol = fill.symbol

            if symbol not in open_positions:
                open_positions[symbol] = {"long": [], "short": []}

            if fill.side == OrderSide.BUY:
                # Opening a long position - track commission with entry
                open_positions[symbol]["long"].append(
                    (fill.quantity, fill.price, fill.bar_index, fill.commission)
                )

            elif fill.side == OrderSide.SELL:
                # Closing a long position (FIFO)
                remaining_to_close = fill.quantity
                exit_commission_remaining = fill.commission

                while remaining_to_close > Decimal("0") and open_positions[symbol]["long"]:
                    entry_qty, entry_price, entry_bar, entry_commission = open_positions[symbol]["long"][0]

                    if entry_qty <= remaining_to_close:
                        # Close entire entry
                        # Allocate proportional exit commission
                        exit_commission_portion = (
                            exit_commission_remaining * entry_qty / remaining_to_close
                            if remaining_to_close > Decimal("0")
                            else Decimal("0")
                        )

                        # Long P&L: (exit_price - entry_price) * qty - entry_commission - exit_commission
                        pnl = (
                            entry_qty * (fill.price - entry_price)
                            - entry_commission
                            - exit_commission_portion
                        )
                        round_trip_pnls.append(pnl)

                        exit_commission_remaining -= exit_commission_portion
                        remaining_to_close -= entry_qty
                        open_positions[symbol]["long"].pop(0)
                    else:
                        # Partial close - prorate entry commission
                        entry_commission_portion = entry_commission * remaining_to_close / entry_qty

                        # Long P&L with proportional commissions
                        pnl = (
                            remaining_to_close * (fill.price - entry_price)
                            - entry_commission_portion
                            - exit_commission_remaining  # Use all remaining exit commission
                        )
                        round_trip_pnls.append(pnl)

                        # Update remaining entry with reduced commission
                        remaining_entry_commission = entry_commission - entry_commission_portion
                        open_positions[symbol]["long"][0] = (
                            entry_qty - remaining_to_close,
                            entry_price,
                            entry_bar,
                            remaining_entry_commission,
                        )
                        remaining_to_close = Decimal("0")

            elif fill.side == OrderSide.SELL_SHORT:
                # Opening a short position - track entry bar and commission
                open_positions[symbol]["short"].append(
                    (fill.quantity, fill.price, fill.bar_index, fill.commission)
                )

            elif fill.side == OrderSide.BUY_TO_COVER:
                # Closing a short position (FIFO)
                remaining_to_close = fill.quantity
                exit_commission_remaining = fill.commission

                while remaining_to_close > Decimal("0") and open_positions[symbol]["short"]:
                    entry_qty, entry_price, entry_bar, entry_commission = open_positions[symbol]["short"][0]

                    if entry_qty <= remaining_to_close:
                        # Close entire entry
                        # Allocate proportional exit commission
                        exit_commission_portion = (
                            exit_commission_remaining * entry_qty / remaining_to_close
                            if remaining_to_close > Decimal("0")
                            else Decimal("0")
                        )

                        # Short P&L: (entry_price - exit_price) * qty - commissions
                        # Note: Borrow fees are NOT deducted here because they are already
                        # deducted from cash in _accrue_borrow_fees() and reflected in equity curve
                        pnl = (
                            entry_qty * (entry_price - fill.price)
                            - entry_commission
                            - exit_commission_portion
                        )

                        round_trip_pnls.append(pnl)

                        exit_commission_remaining -= exit_commission_portion
                        remaining_to_close -= entry_qty
                        open_positions[symbol]["short"].pop(0)
                    else:
                        # Partial close - prorate entry commission
                        entry_commission_portion = entry_commission * remaining_to_close / entry_qty

                        # Short P&L with proportional commissions
                        # Note: Borrow fees are NOT deducted here because they are already
                        # deducted from cash in _accrue_borrow_fees() and reflected in equity curve
                        pnl = (
                            remaining_to_close * (entry_price - fill.price)
                            - entry_commission_portion
                            - exit_commission_remaining  # Use all remaining exit commission
                        )

                        round_trip_pnls.append(pnl)

                        # Update remaining entry with reduced commission
                        remaining_entry_commission = entry_commission - entry_commission_portion
                        open_positions[symbol]["short"][0] = (
                            entry_qty - remaining_to_close,
                            entry_price,
                            entry_bar,
                            remaining_entry_commission,
                        )
                        remaining_to_close = Decimal("0")

        return round_trip_pnls

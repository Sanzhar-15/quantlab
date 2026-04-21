"""
Alpaca Broker Adapter.

Live broker integration with Alpaca Markets API.

Spec Reference: Technical Spec §8, Phase 5 Trade View MVP

Requirements:
    pip install alpaca-py>=0.20.0
"""

import asyncio
import logging
import threading
from datetime import datetime
from decimal import Decimal
from typing import Any
from typing import Callable

from .broker import BrokerAccount
from .broker import BrokerAdapter
from .broker import BrokerStatus
from .broker import MarketQuote
from .orders import Fill
from .orders import Order
from .orders import OrderSide
from .orders import OrderStatus
from .orders import OrderType


logger = logging.getLogger(__name__)


# Lazy import of alpaca-py to avoid hard dependency
def _import_alpaca():
    """Lazily import alpaca-py modules."""
    try:
        from alpaca.trading.client import TradingClient
        from alpaca.trading.requests import (
            GetOrdersRequest,
            LimitOrderRequest,
            MarketOrderRequest,
            StopLimitOrderRequest,
            StopOrderRequest,
        )
        from alpaca.trading.enums import (
            OrderSide as AlpacaOrderSide,
            OrderType as AlpacaOrderType,
            TimeInForce as AlpacaTimeInForce,
            OrderStatus as AlpacaOrderStatus,
        )
        from alpaca.data.live import StockDataStream
        from alpaca.data.historical import StockHistoricalDataClient
        from alpaca.data.requests import StockLatestQuoteRequest, StockBarsRequest

        return {
            "TradingClient": TradingClient,
            "GetOrdersRequest": GetOrdersRequest,
            "LimitOrderRequest": LimitOrderRequest,
            "MarketOrderRequest": MarketOrderRequest,
            "StopLimitOrderRequest": StopLimitOrderRequest,
            "StopOrderRequest": StopOrderRequest,
            "AlpacaOrderSide": AlpacaOrderSide,
            "AlpacaOrderType": AlpacaOrderType,
            "AlpacaTimeInForce": AlpacaTimeInForce,
            "AlpacaOrderStatus": AlpacaOrderStatus,
            "StockDataStream": StockDataStream,
            "StockHistoricalDataClient": StockHistoricalDataClient,
            "StockLatestQuoteRequest": StockLatestQuoteRequest,
            "StockBarsRequest": StockBarsRequest,
        }
    except ImportError:
        raise ImportError(
            "alpaca-py is required for live trading. "
            "Install it with: pip install alpaca-py>=0.20.0"
        )


class AlpacaBroker(BrokerAdapter):
    """
    Alpaca Markets broker adapter.

    Provides live trading integration with Alpaca's REST API and
    real-time streaming for quotes and order updates.
    """

    def __init__(
        self,
        api_key: str,
        secret_key: str,
        paper: bool = True,
    ) -> None:
        """
        Initialize Alpaca broker.

        Args:
            api_key: Alpaca API key
            secret_key: Alpaca secret key
            paper: Use paper trading (default True for safety)
        """
        self._api_key = api_key
        self._secret_key = secret_key
        self._paper = paper
        self._status = BrokerStatus.DISCONNECTED

        # Clients (initialized on connect)
        self._trading_client: Any = None
        self._data_client: Any = None
        self._stream: Any = None

        # Account info
        self._account: BrokerAccount | None = None

        # Order tracking
        self._order_map: dict[str, str] = {}  # our_order_id -> alpaca_order_id
        self._reverse_map: dict[str, str] = {}  # alpaca_order_id -> our_order_id
        # Track cumulative filled quantity per order for partial fill delta calculation
        self._order_filled_qty: dict[str, Decimal] = {}  # alpaca_order_id -> cumulative qty

        # Quote cache
        self._quotes: dict[str, MarketQuote] = {}

        # Callbacks
        self._on_fill_callbacks: list[Callable[[str, Fill], None]] = []
        self._on_order_update_callbacks: list[Callable[[str, OrderStatus], None]] = []
        self._on_quote_callbacks: list[Callable[[str, MarketQuote], None]] = []

        # Threading
        self._lock = threading.Lock()
        self._stream_thread: threading.Thread | None = None
        self._running = False

        # Stream reconnection settings
        self._stream_reconnect_attempts = 0
        self._max_stream_reconnect_attempts = 5
        self._stream_reconnect_base_delay = 1.0  # seconds
        self._stream_reconnect_max_delay = 60.0  # seconds
        self._subscribed_symbols: list[str] = []

        # Import alpaca modules
        self._alpaca: dict[str, Any] | None = None

    @property
    def name(self) -> str:
        """Get broker name."""
        return "Alpaca" + (" Paper" if self._paper else " Live")

    @property
    def status(self) -> BrokerStatus:
        """Get connection status."""
        return self._status

    @property
    def is_paper(self) -> bool:
        """Check if this is a paper trading broker."""
        return self._paper

    def connect(self) -> bool:
        """
        Connect to Alpaca API.

        Returns:
            True if connection successful
        """
        self._status = BrokerStatus.CONNECTING

        try:
            # Import alpaca modules
            self._alpaca = _import_alpaca()

            # Initialize trading client
            self._trading_client = self._alpaca["TradingClient"](
                api_key=self._api_key,
                secret_key=self._secret_key,
                paper=self._paper,
            )

            # Initialize data client for quotes
            self._data_client = self._alpaca["StockHistoricalDataClient"](
                api_key=self._api_key,
                secret_key=self._secret_key,
            )

            # Verify connection by getting account
            account = self._trading_client.get_account()
            self._account = BrokerAccount(
                account_id=account.account_number,
                name=f"Alpaca {'Paper' if self._paper else 'Live'}",
                currency=account.currency,
                cash_balance=Decimal(str(account.cash)),
                buying_power=Decimal(str(account.buying_power)),
                portfolio_value=Decimal(str(account.portfolio_value)),
                is_paper=self._paper,
                is_active=account.status.value == "ACTIVE",
            )

            # Start streaming
            self._start_stream()

            self._status = BrokerStatus.CONNECTED
            logger.info(
                f"Connected to Alpaca {'paper' if self._paper else 'live'} trading "
                f"(account: {self._account.account_id})"
            )
            return True

        except Exception as e:
            logger.error(f"Failed to connect to Alpaca: {e}")
            self._status = BrokerStatus.ERROR
            return False

    def disconnect(self) -> None:
        """Disconnect from Alpaca API."""
        self._running = False

        # Stop stream
        if self._stream:
            try:
                asyncio.get_event_loop().run_until_complete(self._stream.close())
            except Exception as e:
                logger.debug(f"Error closing stream during disconnect: {e}")

        if self._stream_thread:
            self._stream_thread.join(timeout=2.0)

        self._trading_client = None
        self._data_client = None
        self._stream = None
        self._status = BrokerStatus.DISCONNECTED
        logger.info("Disconnected from Alpaca")

    def get_accounts(self) -> list[BrokerAccount]:
        """Get available accounts."""
        if self._account:
            return [self._account]
        return []

    def get_account(self, account_id: str) -> BrokerAccount | None:
        """Get account by ID."""
        if self._account and self._account.account_id == account_id:
            return self._account
        return None

    async def submit_order(self, order: Order) -> str | None:
        """
        Submit an order to Alpaca.

        Args:
            order: Order to submit

        Returns:
            Alpaca order ID if successful
        """
        if not self._trading_client or not self._alpaca:
            logger.error("Not connected to Alpaca")
            return None

        try:
            # Convert order type
            alpaca_request = self._build_alpaca_order(order)
            if alpaca_request is None:
                return None

            # Submit order - wrap sync call in thread to avoid blocking event loop
            alpaca_order = await asyncio.to_thread(
                self._trading_client.submit_order,
                order_data=alpaca_request
            )

            # Track order mapping
            alpaca_order_id = str(alpaca_order.id)
            with self._lock:
                self._order_map[order.order_id] = alpaca_order_id
                self._reverse_map[alpaca_order_id] = order.order_id

            logger.info(
                f"Submitted order {order.order_id} -> Alpaca {alpaca_order_id}"
            )
            return alpaca_order_id

        except Exception as e:
            logger.error(f"Failed to submit order: {e}")
            return None

    async def cancel_order(self, broker_order_id: str) -> bool:
        """
        Cancel an order.

        Args:
            broker_order_id: Alpaca order ID

        Returns:
            True if cancellation request was sent
        """
        if not self._trading_client:
            return False

        try:
            # Wrap sync call to avoid blocking event loop
            await asyncio.to_thread(
                self._trading_client.cancel_order_by_id,
                broker_order_id
            )
            logger.info(f"Cancelled order {broker_order_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to cancel order: {e}")
            return False

    async def modify_order(
        self,
        broker_order_id: str,
        quantity: Decimal | None = None,
        limit_price: Decimal | None = None,
        stop_price: Decimal | None = None,
    ) -> bool:
        """
        Modify an existing order (FIX-D003).

        Alpaca supports order replacement via PATCH endpoint.

        Args:
            broker_order_id: Alpaca order ID
            quantity: New quantity (optional)
            limit_price: New limit price (optional)
            stop_price: New stop price (optional)

        Returns:
            True if modification was successful
        """
        if not self._trading_client:
            return False

        try:
            # Build modification request
            # Alpaca uses replace_order_by_id for modifications
            modifications = {}
            if quantity is not None:
                modifications["qty"] = float(quantity)
            if limit_price is not None:
                modifications["limit_price"] = float(limit_price)
            if stop_price is not None:
                modifications["stop_price"] = float(stop_price)

            if not modifications:
                logger.warning("No modifications provided for order modify")
                return False

            # Use replace_order_by_id for modification
            # Note: Alpaca replaces the order, which gives a new order ID
            await asyncio.to_thread(
                self._trading_client.replace_order_by_id,
                broker_order_id,
                **modifications
            )

            logger.info(f"Modified order {broker_order_id}: {modifications}")
            return True

        except Exception as e:
            logger.error(f"Failed to modify order {broker_order_id}: {e}")
            return False

    async def get_quote(self, symbol: str) -> MarketQuote | None:
        """
        Get current quote for a symbol.

        Args:
            symbol: Symbol to quote

        Returns:
            Quote or None
        """
        # Check cache first
        with self._lock:
            if symbol in self._quotes:
                return self._quotes[symbol]

        # Fetch from API
        if not self._data_client or not self._alpaca:
            return None

        try:
            request = self._alpaca["StockLatestQuoteRequest"](symbol_or_symbols=symbol)
            # Wrap sync call to avoid blocking event loop
            quotes = await asyncio.to_thread(
                self._data_client.get_stock_latest_quote,
                request
            )

            if symbol in quotes:
                q = quotes[symbol]
                quote = MarketQuote(
                    symbol=symbol,
                    bid=Decimal(str(q.bid_price)),
                    ask=Decimal(str(q.ask_price)),
                    last=Decimal(str((q.bid_price + q.ask_price) / 2)),
                    volume=q.bid_size + q.ask_size,
                    timestamp=q.timestamp,
                )

                with self._lock:
                    self._quotes[symbol] = quote

                return quote

        except Exception as e:
            logger.error(f"Failed to get quote for {symbol}: {e}")

        return None

    async def get_quotes(self, symbols: list[str]) -> dict[str, MarketQuote]:
        """Get quotes for multiple symbols."""
        if not self._data_client or not self._alpaca:
            return {}

        try:
            request = self._alpaca["StockLatestQuoteRequest"](symbol_or_symbols=symbols)
            # Wrap sync call to avoid blocking event loop
            alpaca_quotes = await asyncio.to_thread(
                self._data_client.get_stock_latest_quote,
                request
            )

            result = {}
            for symbol, q in alpaca_quotes.items():
                quote = MarketQuote(
                    symbol=symbol,
                    bid=Decimal(str(q.bid_price)),
                    ask=Decimal(str(q.ask_price)),
                    last=Decimal(str((q.bid_price + q.ask_price) / 2)),
                    volume=q.bid_size + q.ask_size,
                    timestamp=q.timestamp,
                )
                result[symbol] = quote

                with self._lock:
                    self._quotes[symbol] = quote

            return result

        except Exception as e:
            logger.error(f"Failed to get quotes: {e}")
            return {}

    async def get_positions(self) -> list[dict[str, Any]]:
        """Get current positions."""
        if not self._trading_client:
            return []

        try:
            # Wrap sync call to avoid blocking event loop
            positions = await asyncio.to_thread(self._trading_client.get_all_positions)
            return [
                {
                    "symbol": p.symbol,
                    "quantity": float(p.qty),
                    "avg_entry_price": float(p.avg_entry_price),
                    "current_price": float(p.current_price),
                    "unrealized_pnl": float(p.unrealized_pl),
                    "market_value": float(p.market_value),
                }
                for p in positions
            ]
        except Exception as e:
            logger.error(f"Failed to get positions: {e}")
            return []

    def stream_quotes(
        self,
        symbols: list[str],
        callback: Callable[[str, MarketQuote], None],
    ) -> None:
        """
        Subscribe to real-time quotes.

        Args:
            symbols: Symbols to subscribe to
            callback: Callback for quote updates
        """
        self._on_quote_callbacks.append(callback)

        # Track subscribed symbols for reconnection
        with self._lock:
            for symbol in symbols:
                if symbol not in self._subscribed_symbols:
                    self._subscribed_symbols.append(symbol)

        if self._stream and self._alpaca:
            async def subscribe():
                await self._stream.subscribe_quotes(*symbols)

            asyncio.run_coroutine_threadsafe(
                subscribe(),
                asyncio.get_event_loop(),
            )

    def on_fill(
        self,
        callback: Callable[[str, Fill], None],
    ) -> None:
        """Register fill callback."""
        self._on_fill_callbacks.append(callback)

    def on_order_update(
        self,
        callback: Callable[[str, OrderStatus], None],
    ) -> None:
        """Register order update callback."""
        self._on_order_update_callbacks.append(callback)

    def _map_time_in_force(self, tif: "TimeInForce") -> Any:
        """Map our TimeInForce to Alpaca's TimeInForce."""
        if not self._alpaca:
            return None

        AlpacaTimeInForce = self._alpaca["AlpacaTimeInForce"]

        # Import TimeInForce enum for comparison
        from .orders import TimeInForce

        mapping = {
            TimeInForce.DAY: AlpacaTimeInForce.DAY,
            TimeInForce.GTC: AlpacaTimeInForce.GTC,
            TimeInForce.IOC: AlpacaTimeInForce.IOC,
            TimeInForce.FOK: AlpacaTimeInForce.FOK,
        }
        return mapping.get(tif, AlpacaTimeInForce.DAY)

    def _build_alpaca_order(self, order: Order) -> Any:
        """Build Alpaca order request from our Order."""
        if not self._alpaca:
            return None

        AlpacaOrderSide = self._alpaca["AlpacaOrderSide"]
        MarketOrderRequest = self._alpaca["MarketOrderRequest"]
        LimitOrderRequest = self._alpaca["LimitOrderRequest"]
        StopOrderRequest = self._alpaca["StopOrderRequest"]
        StopLimitOrderRequest = self._alpaca["StopLimitOrderRequest"]

        side = AlpacaOrderSide.BUY if order.side == OrderSide.BUY else AlpacaOrderSide.SELL
        # Map order's time_in_force to Alpaca's enum instead of hardcoding DAY
        tif = self._map_time_in_force(order.time_in_force)

        if order.order_type == OrderType.MARKET:
            return MarketOrderRequest(
                symbol=order.symbol,
                qty=float(order.quantity),
                side=side,
                time_in_force=tif,
            )

        elif order.order_type == OrderType.LIMIT:
            if order.limit_price is None:
                return None
            return LimitOrderRequest(
                symbol=order.symbol,
                qty=float(order.quantity),
                side=side,
                time_in_force=tif,
                limit_price=float(order.limit_price),
            )

        elif order.order_type == OrderType.STOP:
            if order.stop_price is None:
                return None
            return StopOrderRequest(
                symbol=order.symbol,
                qty=float(order.quantity),
                side=side,
                time_in_force=tif,
                stop_price=float(order.stop_price),
            )

        elif order.order_type == OrderType.STOP_LIMIT:
            if order.stop_price is None or order.limit_price is None:
                return None
            return StopLimitOrderRequest(
                symbol=order.symbol,
                qty=float(order.quantity),
                side=side,
                time_in_force=tif,
                stop_price=float(order.stop_price),
                limit_price=float(order.limit_price),
            )

        return None

    def _start_stream(self) -> None:
        """Start the streaming connection.

        FIX-T002: Ensures both trade updates and quote updates are subscribed.
        """
        if not self._alpaca:
            return

        try:
            StockDataStream = self._alpaca["StockDataStream"]
            self._stream = StockDataStream(
                api_key=self._api_key,
                secret_key=self._secret_key,
            )

            # Register handlers for trade updates (order fills, etc.)
            self._stream.subscribe_trade_updates(self._on_trade_update)

            # FIX-T002: Register quote update handler
            # This enables real-time quote streaming via WebSocket
            @self._stream.on("quote")
            async def _quote_handler(quote_data):
                await self._on_quote_update(quote_data)

            # Start in background thread
            self._running = True
            self._stream_thread = threading.Thread(
                target=self._run_stream,
                daemon=True,
            )
            self._stream_thread.start()

            logger.info("Alpaca WebSocket stream started")

        except Exception as e:
            logger.error(f"Failed to start stream: {e}")

    def _run_stream(self) -> None:
        """Run the stream in a separate thread with reconnection logic."""
        import random

        while self._running:
            try:
                self._stream_reconnect_attempts = 0
                self._stream.run()
            except Exception as e:
                if not self._running:
                    break

                self._stream_reconnect_attempts += 1
                logger.error(
                    f"Stream error (attempt {self._stream_reconnect_attempts}/"
                    f"{self._max_stream_reconnect_attempts}): {e}"
                )

                if self._stream_reconnect_attempts >= self._max_stream_reconnect_attempts:
                    logger.error("Max stream reconnection attempts reached, giving up")
                    self._status = BrokerStatus.ERROR
                    break

                # Exponential backoff with jitter
                delay = self._stream_reconnect_base_delay * (2 ** (self._stream_reconnect_attempts - 1))
                jitter = random.uniform(0, delay * 0.1)
                delay = min(delay + jitter, self._stream_reconnect_max_delay)

                logger.info(f"Reconnecting stream in {delay:.1f}s...")
                import time
                time.sleep(delay)

                # Recreate stream
                try:
                    self._recreate_stream()
                except Exception as re:
                    logger.error(f"Failed to recreate stream: {re}")

    def _recreate_stream(self) -> None:
        """Recreate the stream connection after failure.

        FIX-T002: Ensures quote handler is re-registered on reconnection.
        """
        if not self._alpaca:
            return

        StockDataStream = self._alpaca["StockDataStream"]
        self._stream = StockDataStream(
            api_key=self._api_key,
            secret_key=self._secret_key,
        )

        # Re-register handlers
        self._stream.subscribe_trade_updates(self._on_trade_update)

        # FIX-T002: Re-register quote handler
        @self._stream.on("quote")
        async def _quote_handler(quote_data):
            await self._on_quote_update(quote_data)

        # Re-subscribe to quotes if any were subscribed
        if self._subscribed_symbols:
            async def resubscribe():
                await self._stream.subscribe_quotes(*self._subscribed_symbols)

            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    asyncio.run_coroutine_threadsafe(resubscribe(), loop)
                else:
                    asyncio.run(resubscribe())
            except Exception as e:
                logger.warning(f"Failed to resubscribe to quotes: {e}")

        logger.info("Alpaca WebSocket stream recreated")

    async def _on_trade_update(self, data: Any) -> None:
        """Handle trade/order updates from Alpaca stream."""
        try:
            event = data.event
            order_data = data.order

            alpaca_order_id = str(order_data.id)

            # Get our order ID
            with self._lock:
                our_order_id = self._reverse_map.get(alpaca_order_id)

            if not our_order_id:
                logger.debug(f"Unknown order update: {alpaca_order_id}")
                return

            # Map Alpaca status to our status
            status_map = {
                "new": OrderStatus.SUBMITTED,
                "accepted": OrderStatus.ACCEPTED,
                "pending_new": OrderStatus.PENDING,
                "partially_filled": OrderStatus.PARTIAL,
                "filled": OrderStatus.FILLED,
                "canceled": OrderStatus.CANCELLED,
                "rejected": OrderStatus.REJECTED,
                "expired": OrderStatus.EXPIRED,
            }

            if event == "fill" or event == "partial_fill":
                # Calculate the fill quantity as delta from previous cumulative
                # (Alpaca reports cumulative filled_qty, not per-fill quantity)
                current_cumulative = Decimal(str(order_data.filled_qty))
                previous_cumulative = self._order_filled_qty.get(alpaca_order_id, Decimal("0"))
                fill_quantity = current_cumulative - previous_cumulative

                # Update tracking
                self._order_filled_qty[alpaca_order_id] = current_cumulative

                # Skip if no new quantity filled (duplicate event)
                if fill_quantity <= Decimal("0"):
                    logger.debug(f"Skipping fill event with no new quantity: {alpaca_order_id}")
                    return

                # Create fill with calculated delta quantity
                # Note: filled_avg_price is still the cumulative average, which is acceptable
                # for most use cases. Per-fill price would require additional API calls.
                fill = Fill(
                    fill_id=f"fill-{alpaca_order_id}-{datetime.now().timestamp()}",
                    order_id=our_order_id,
                    quantity=fill_quantity,
                    price=Decimal(str(order_data.filled_avg_price)),
                    timestamp=datetime.now(),
                    commission=Decimal("0"),  # Alpaca doesn't charge commission
                )

                # Clean up tracking if order is fully filled
                if event == "fill":
                    self._order_filled_qty.pop(alpaca_order_id, None)

                # Notify listeners
                for callback in self._on_fill_callbacks:
                    try:
                        callback(our_order_id, fill)
                    except Exception as e:
                        logger.warning(
                            f"Fill callback failed for order {our_order_id}: {e}",
                            exc_info=True,
                        )

            # Clean up tracking for terminal states (cancelled, rejected, expired)
            if event in ("canceled", "cancelled", "rejected", "expired"):
                self._order_filled_qty.pop(alpaca_order_id, None)

            # Notify order update
            status = status_map.get(event.lower(), OrderStatus.PENDING)
            for callback in self._on_order_update_callbacks:
                try:
                    callback(our_order_id, status)
                except Exception as e:
                    logger.warning(
                        f"Order update callback failed for order {our_order_id}: {e}",
                        exc_info=True,
                    )

        except Exception as e:
            logger.error(f"Error handling trade update: {e}")

    async def _on_quote_update(self, quote_data: Any) -> None:
        """Handle quote updates from stream."""
        try:
            symbol = quote_data.symbol
            quote = MarketQuote(
                symbol=symbol,
                bid=Decimal(str(quote_data.bid_price)),
                ask=Decimal(str(quote_data.ask_price)),
                last=Decimal(str((quote_data.bid_price + quote_data.ask_price) / 2)),
                volume=quote_data.bid_size + quote_data.ask_size,
                timestamp=quote_data.timestamp,
            )

            with self._lock:
                self._quotes[symbol] = quote

            for callback in self._on_quote_callbacks:
                try:
                    callback(symbol, quote)
                except Exception as e:
                    logger.warning(
                        f"Quote callback failed for {symbol}: {e}",
                        exc_info=True,
                    )

        except Exception as e:
            logger.error(f"Error handling quote update: {e}")

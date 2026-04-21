"""
Alpaca Data Provider.

Provides market data from Alpaca Markets API.

Spec Reference: Technical Spec §10.5
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from datetime import timezone
from decimal import Decimal
from typing import Any

from .base import Bar
from .base import BarCallback
from .base import ConnectionResult
from .base import ConnectionStatus
from .base import DataProvider
from .base import DataType
from .base import Quote
from .base import QuoteCallback
from .base import Subscription
from .base import TradeCallback
from .base import TradeEvent


logger = logging.getLogger(__name__)


@dataclass
class AlpacaConfig:
    """Configuration for Alpaca provider."""

    api_key: str
    api_secret: str
    base_url: str = "https://api.alpaca.markets"
    data_url: str = "https://data.alpaca.markets"
    paper: bool = True
    feed: str = "iex"  # 'iex' or 'sip'


class AlpacaDataProvider(DataProvider):
    """
    Alpaca Markets data provider.

    Provides:
    - Real-time quotes and trades via websocket
    - Historical bar data via REST API
    - Support for IEX and SIP feeds
    """

    def __init__(self, config: AlpacaConfig) -> None:
        super().__init__("alpaca")
        self.config = config
        self._rest_client: Any = None
        self._stream_client: Any = None
        self._stream_task: asyncio.Task | None = None

    async def connect(self) -> ConnectionResult:
        """Connect to Alpaca API."""
        self._set_status(ConnectionStatus.CONNECTING)

        try:
            # Import alpaca-py at runtime
            try:
                from alpaca.data.live import StockDataStream
                from alpaca.data.historical import StockHistoricalDataClient
                from alpaca.data.requests import StockBarsRequest
                from alpaca.data.timeframe import TimeFrame
            except ImportError:
                return ConnectionResult(
                    success=False,
                    status=ConnectionStatus.ERROR,
                    message="alpaca-py not installed. Run: pip install alpaca-py",
                )

            # Create REST client for historical data
            self._rest_client = StockHistoricalDataClient(
                api_key=self.config.api_key,
                secret_key=self.config.api_secret,
            )

            # Create streaming client
            self._stream_client = StockDataStream(
                api_key=self.config.api_key,
                secret_key=self.config.api_secret,
                feed=self.config.feed,
            )

            # Test connection with a simple request
            start_time = datetime.now(timezone.utc)
            # Connection test would go here
            latency = (datetime.now(timezone.utc) - start_time).total_seconds() * 1000

            self._latency_ms = latency
            self._set_status(ConnectionStatus.CONNECTED)

            # Start streaming in background
            self._stream_task = asyncio.create_task(self._run_stream())

            return ConnectionResult(
                success=True,
                status=ConnectionStatus.CONNECTED,
                message="Connected to Alpaca",
                latency_ms=latency,
                server_time=datetime.now(timezone.utc),
            )

        except Exception as e:
            logger.error(f"Alpaca connection failed: {e}")
            self._set_status(ConnectionStatus.ERROR)
            return ConnectionResult(
                success=False,
                status=ConnectionStatus.ERROR,
                message=str(e),
            )

    async def disconnect(self) -> None:
        """Disconnect from Alpaca."""
        if self._stream_task:
            self._stream_task.cancel()
            try:
                await self._stream_task
            except asyncio.CancelledError:
                pass

        if self._stream_client:
            try:
                await self._stream_client.close()
            except Exception:
                pass

        self._rest_client = None
        self._stream_client = None
        self._set_status(ConnectionStatus.DISCONNECTED)

    async def subscribe(
        self,
        symbol: str,
        data_type: DataType,
        callback: QuoteCallback | BarCallback | TradeCallback,
        timeframe: str = "1m",
    ) -> bool:
        """Subscribe to Alpaca data stream."""
        if not self._stream_client:
            return False

        try:
            subscription = Subscription(
                symbol=symbol,
                data_type=data_type,
                callback=callback,
                timeframe=timeframe,
            )
            self._add_subscription(subscription)

            # Subscribe on stream based on data type
            if data_type == DataType.QUOTE:
                self._stream_client.subscribe_quotes(
                    self._on_quote,
                    symbol,
                )
            elif data_type == DataType.TRADE:
                self._stream_client.subscribe_trades(
                    self._on_trade,
                    symbol,
                )
            elif data_type == DataType.BAR:
                self._stream_client.subscribe_bars(
                    self._on_bar,
                    symbol,
                )

            logger.info(f"Subscribed to {symbol} {data_type.value}")
            return True

        except Exception as e:
            logger.error(f"Subscription failed: {e}")
            return False

    async def unsubscribe(self, symbol: str, data_type: DataType) -> bool:
        """Unsubscribe from Alpaca data stream."""
        if not self._stream_client:
            return False

        try:
            self._remove_subscription(symbol, data_type)

            if data_type == DataType.QUOTE:
                self._stream_client.unsubscribe_quotes(symbol)
            elif data_type == DataType.TRADE:
                self._stream_client.unsubscribe_trades(symbol)
            elif data_type == DataType.BAR:
                self._stream_client.unsubscribe_bars(symbol)

            logger.info(f"Unsubscribed from {symbol} {data_type.value}")
            return True

        except Exception as e:
            logger.error(f"Unsubscription failed: {e}")
            return False

    async def get_historical_bars(
        self,
        symbol: str,
        timeframe: str,
        start: datetime,
        end: datetime,
    ) -> list[Bar]:
        """Get historical bars from Alpaca."""
        if not self._rest_client:
            return []

        try:
            from alpaca.data.requests import StockBarsRequest
            from alpaca.data.timeframe import TimeFrame

            # Convert timeframe string to Alpaca TimeFrame
            tf = self._convert_timeframe(timeframe)

            request = StockBarsRequest(
                symbol_or_symbols=symbol,
                start=start,
                end=end,
                timeframe=tf,
            )

            bars_data = self._rest_client.get_stock_bars(request)
            bars = []

            if symbol in bars_data:
                for bar in bars_data[symbol]:
                    bars.append(
                        Bar(
                            symbol=symbol,
                            timestamp=bar.timestamp,
                            open=Decimal(str(bar.open)),
                            high=Decimal(str(bar.high)),
                            low=Decimal(str(bar.low)),
                            close=Decimal(str(bar.close)),
                            volume=bar.volume,
                            timeframe=timeframe,
                            source="alpaca",
                        )
                    )

            return bars

        except Exception as e:
            logger.error(f"Historical bars request failed: {e}")
            return []

    async def get_latest_quote(self, symbol: str) -> Quote | None:
        """Get latest quote from Alpaca."""
        if not self._rest_client:
            return None

        try:
            from alpaca.data.requests import StockLatestQuoteRequest

            request = StockLatestQuoteRequest(symbol_or_symbols=symbol)
            quotes = self._rest_client.get_stock_latest_quote(request)

            if symbol in quotes:
                q = quotes[symbol]
                return Quote(
                    symbol=symbol,
                    bid=Decimal(str(q.bid_price)),
                    ask=Decimal(str(q.ask_price)),
                    bid_size=q.bid_size,
                    ask_size=q.ask_size,
                    timestamp=q.timestamp,
                    source="alpaca",
                )

            return None

        except Exception as e:
            logger.error(f"Latest quote request failed: {e}")
            return None

    async def _run_stream(self) -> None:
        """Run the streaming connection."""
        try:
            await self._stream_client.run()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Stream error: {e}")
            self._set_status(ConnectionStatus.ERROR)

    def _on_quote(self, quote: Any) -> None:
        """Handle incoming quote from stream."""
        try:
            q = Quote(
                symbol=quote.symbol,
                bid=Decimal(str(quote.bid_price)),
                ask=Decimal(str(quote.ask_price)),
                bid_size=quote.bid_size,
                ask_size=quote.ask_size,
                timestamp=quote.timestamp,
                source="alpaca",
            )
            self._dispatch_quote(q)
        except Exception as e:
            logger.error(f"Quote dispatch error: {e}")

    def _on_trade(self, trade: Any) -> None:
        """Handle incoming trade from stream."""
        try:
            t = TradeEvent(
                symbol=trade.symbol,
                price=Decimal(str(trade.price)),
                size=trade.size,
                timestamp=trade.timestamp,
                trade_id=str(trade.id) if hasattr(trade, "id") else "",
                source="alpaca",
            )
            self._dispatch_trade(t)
        except Exception as e:
            logger.error(f"Trade dispatch error: {e}")

    def _on_bar(self, bar: Any) -> None:
        """Handle incoming bar from stream."""
        try:
            b = Bar(
                symbol=bar.symbol,
                timestamp=bar.timestamp,
                open=Decimal(str(bar.open)),
                high=Decimal(str(bar.high)),
                low=Decimal(str(bar.low)),
                close=Decimal(str(bar.close)),
                volume=bar.volume,
                timeframe="1m",  # Alpaca streams 1m bars
                source="alpaca",
            )
            self._dispatch_bar(b)
        except Exception as e:
            logger.error(f"Bar dispatch error: {e}")

    def _convert_timeframe(self, timeframe: str) -> Any:
        """Convert timeframe string to Alpaca TimeFrame."""
        from alpaca.data.timeframe import TimeFrame, TimeFrameUnit

        if timeframe == "1m":
            return TimeFrame.Minute
        elif timeframe == "5m":
            return TimeFrame(5, TimeFrameUnit.Minute)
        elif timeframe == "15m":
            return TimeFrame(15, TimeFrameUnit.Minute)
        elif timeframe == "30m":
            return TimeFrame(30, TimeFrameUnit.Minute)
        elif timeframe == "1h":
            return TimeFrame.Hour
        elif timeframe == "4h":
            return TimeFrame(4, TimeFrameUnit.Hour)
        elif timeframe == "1d":
            return TimeFrame.Day
        elif timeframe == "1w":
            return TimeFrame.Week
        else:
            return TimeFrame.Minute

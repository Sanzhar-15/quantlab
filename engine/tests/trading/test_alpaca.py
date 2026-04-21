"""
Tests for Alpaca Broker Adapter.

Tests AlpacaBroker with mocked alpaca-py dependencies.
"""

import pytest
from decimal import Decimal
from datetime import datetime
from unittest.mock import MagicMock, patch, AsyncMock
import threading

from quantlab.trading.broker import BrokerStatus, BrokerAccount, MarketQuote
from quantlab.trading.orders import Order, OrderSide, OrderType, OrderStatus, Fill


class TestAlpacaBrokerImport:
    """Tests for alpaca module import handling."""

    def test_import_alpaca_missing(self) -> None:
        """Test that missing alpaca-py raises ImportError."""
        with patch.dict("sys.modules", {"alpaca": None}):
            from quantlab.trading.alpaca import _import_alpaca
            with pytest.raises(ImportError) as exc_info:
                _import_alpaca()
            assert "alpaca-py is required" in str(exc_info.value)


class TestAlpacaBrokerInit:
    """Tests for AlpacaBroker initialization."""

    @pytest.fixture
    def mock_alpaca_modules(self):
        """Create mock alpaca modules."""
        mock_modules = {
            "TradingClient": MagicMock(),
            "GetOrdersRequest": MagicMock(),
            "LimitOrderRequest": MagicMock(),
            "MarketOrderRequest": MagicMock(),
            "StopLimitOrderRequest": MagicMock(),
            "StopOrderRequest": MagicMock(),
            "AlpacaOrderSide": MagicMock(),
            "AlpacaOrderType": MagicMock(),
            "AlpacaTimeInForce": MagicMock(),
            "AlpacaOrderStatus": MagicMock(),
            "StockDataStream": MagicMock(),
            "StockHistoricalDataClient": MagicMock(),
            "StockLatestQuoteRequest": MagicMock(),
            "StockBarsRequest": MagicMock(),
        }
        # Set up enum values
        mock_modules["AlpacaOrderSide"].BUY = "buy"
        mock_modules["AlpacaOrderSide"].SELL = "sell"
        mock_modules["AlpacaTimeInForce"].DAY = "day"
        return mock_modules

    def test_init_paper(self) -> None:
        """Test paper trading initialization."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
            paper=True,
        )

        assert broker.name == "Alpaca Paper"
        assert broker.status == BrokerStatus.DISCONNECTED
        assert broker.is_paper is True

    def test_init_live(self) -> None:
        """Test live trading initialization."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
            paper=False,
        )

        assert broker.name == "Alpaca Live"
        assert broker.is_paper is False

    def test_get_accounts_before_connect(self) -> None:
        """Test get_accounts returns empty before connect."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        assert broker.get_accounts() == []

    def test_get_account_before_connect(self) -> None:
        """Test get_account returns None before connect."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        assert broker.get_account("acc-001") is None


class TestAlpacaBrokerConnect:
    """Tests for AlpacaBroker connection."""

    @pytest.fixture
    def mock_trading_client(self):
        """Create mock trading client."""
        client = MagicMock()
        account = MagicMock()
        account.account_number = "PA123456"
        account.currency = "USD"
        account.cash = "100000.00"
        account.buying_power = "100000.00"
        account.portfolio_value = "100000.00"
        account.status.value = "ACTIVE"
        client.get_account.return_value = account
        return client

    @pytest.fixture
    def mock_data_client(self):
        """Create mock data client."""
        return MagicMock()

    @pytest.fixture
    def mock_stream(self):
        """Create mock stream."""
        stream = MagicMock()
        stream.run = MagicMock()
        stream.close = AsyncMock()
        stream.subscribe_trade_updates = MagicMock()
        return stream

    def test_connect_success(
        self, mock_trading_client, mock_data_client, mock_stream
    ) -> None:
        """Test successful connection."""
        from quantlab.trading.alpaca import AlpacaBroker

        with patch(
            "quantlab.trading.alpaca._import_alpaca"
        ) as mock_import:
            mock_modules = {
                "TradingClient": MagicMock(return_value=mock_trading_client),
                "StockHistoricalDataClient": MagicMock(return_value=mock_data_client),
                "StockDataStream": MagicMock(return_value=mock_stream),
                "AlpacaOrderSide": MagicMock(),
                "AlpacaTimeInForce": MagicMock(),
                "MarketOrderRequest": MagicMock(),
                "LimitOrderRequest": MagicMock(),
                "StopOrderRequest": MagicMock(),
                "StopLimitOrderRequest": MagicMock(),
                "StockLatestQuoteRequest": MagicMock(),
            }
            mock_import.return_value = mock_modules

            broker = AlpacaBroker(
                api_key="test-key",
                secret_key="test-secret",
                paper=True,
            )

            result = broker.connect()

            assert result is True
            assert broker.status == BrokerStatus.CONNECTED
            accounts = broker.get_accounts()
            assert len(accounts) == 1
            assert accounts[0].account_id == "PA123456"

    def test_connect_failure(self) -> None:
        """Test connection failure."""
        from quantlab.trading.alpaca import AlpacaBroker

        with patch(
            "quantlab.trading.alpaca._import_alpaca"
        ) as mock_import:
            mock_import.side_effect = Exception("Connection failed")

            broker = AlpacaBroker(
                api_key="test-key",
                secret_key="test-secret",
            )

            result = broker.connect()

            assert result is False
            assert broker.status == BrokerStatus.ERROR


class TestAlpacaBrokerOrders:
    """Tests for AlpacaBroker order operations."""

    @pytest.fixture
    def connected_broker(self):
        """Create a connected broker with mocks."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
            paper=True,
        )

        # Set up mock clients
        trading_client = MagicMock()
        account = MagicMock()
        account.account_number = "PA123456"
        account.currency = "USD"
        account.cash = "100000.00"
        account.buying_power = "100000.00"
        account.portfolio_value = "100000.00"
        account.status.value = "ACTIVE"
        trading_client.get_account.return_value = account

        # Mock order submission
        mock_order = MagicMock()
        mock_order.id = "alpaca-order-123"
        trading_client.submit_order.return_value = mock_order
        trading_client.cancel_order_by_id = MagicMock()

        broker._trading_client = trading_client
        broker._data_client = MagicMock()
        broker._status = BrokerStatus.CONNECTED
        broker._account = BrokerAccount(
            account_id="PA123456",
            name="Test Account",
            cash_balance=Decimal("100000"),
        )

        # Set up alpaca modules mock
        broker._alpaca = {
            "AlpacaOrderSide": MagicMock(BUY="buy", SELL="sell"),
            "AlpacaTimeInForce": MagicMock(DAY="day"),
            "MarketOrderRequest": MagicMock(),
            "LimitOrderRequest": MagicMock(),
            "StopOrderRequest": MagicMock(),
            "StopLimitOrderRequest": MagicMock(),
            "StockLatestQuoteRequest": MagicMock(),
        }

        return broker

    def test_submit_market_order(self, connected_broker) -> None:
        """Test submitting a market order."""
        order = Order(
            order_id="test-order-1",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        result = connected_broker.submit_order(order)

        assert result == "alpaca-order-123"
        connected_broker._trading_client.submit_order.assert_called_once()

    def test_submit_limit_order(self, connected_broker) -> None:
        """Test submitting a limit order."""
        order = Order(
            order_id="test-order-2",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),
        )

        result = connected_broker.submit_order(order)

        assert result == "alpaca-order-123"

    def test_submit_stop_order(self, connected_broker) -> None:
        """Test submitting a stop order."""
        order = Order(
            order_id="test-order-3",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("140.00"),
        )

        result = connected_broker.submit_order(order)

        assert result == "alpaca-order-123"

    def test_submit_stop_limit_order(self, connected_broker) -> None:
        """Test submitting a stop-limit order."""
        order = Order(
            order_id="test-order-4",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=Decimal("140.00"),
            limit_price=Decimal("139.50"),
        )

        result = connected_broker.submit_order(order)

        assert result == "alpaca-order-123"

    def test_submit_limit_order_missing_price(self, connected_broker) -> None:
        """Test submitting limit order without limit price."""
        order = Order(
            order_id="test-order-5",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            # No limit_price
        )

        result = connected_broker.submit_order(order)

        assert result is None

    def test_submit_order_not_connected(self) -> None:
        """Test submitting order when not connected."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        order = Order(
            order_id="test-order-1",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        result = broker.submit_order(order)

        assert result is None

    def test_cancel_order(self, connected_broker) -> None:
        """Test cancelling an order."""
        result = connected_broker.cancel_order("alpaca-order-123")

        assert result is True
        connected_broker._trading_client.cancel_order_by_id.assert_called_once_with(
            "alpaca-order-123"
        )

    def test_cancel_order_not_connected(self) -> None:
        """Test cancel order when not connected."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        result = broker.cancel_order("alpaca-order-123")

        assert result is False


class TestAlpacaBrokerQuotes:
    """Tests for AlpacaBroker quote operations."""

    @pytest.fixture
    def connected_broker(self):
        """Create a connected broker with mocks."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        data_client = MagicMock()
        mock_quote = MagicMock()
        mock_quote.bid_price = 149.90
        mock_quote.ask_price = 150.10
        mock_quote.bid_size = 100
        mock_quote.ask_size = 200
        mock_quote.timestamp = datetime.now()

        data_client.get_stock_latest_quote.return_value = {"AAPL": mock_quote}

        broker._data_client = data_client
        broker._status = BrokerStatus.CONNECTED
        broker._alpaca = {
            "StockLatestQuoteRequest": MagicMock(),
        }

        return broker

    def test_get_quote(self, connected_broker) -> None:
        """Test getting a quote."""
        quote = connected_broker.get_quote("AAPL")

        assert quote is not None
        assert quote.symbol == "AAPL"
        assert quote.bid == Decimal("149.90")
        assert quote.ask == Decimal("150.10")

    def test_get_quote_cached(self, connected_broker) -> None:
        """Test that quotes are cached."""
        # First call
        quote1 = connected_broker.get_quote("AAPL")
        # Second call should use cache
        quote2 = connected_broker.get_quote("AAPL")

        assert quote1 == quote2
        # Should only call API once
        assert connected_broker._data_client.get_stock_latest_quote.call_count == 1

    def test_get_quote_not_connected(self) -> None:
        """Test getting quote when not connected."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        quote = broker.get_quote("AAPL")

        assert quote is None

    def test_get_quotes_multiple(self, connected_broker) -> None:
        """Test getting multiple quotes."""
        mock_quote_aapl = MagicMock()
        mock_quote_aapl.bid_price = 149.90
        mock_quote_aapl.ask_price = 150.10
        mock_quote_aapl.bid_size = 100
        mock_quote_aapl.ask_size = 200
        mock_quote_aapl.timestamp = datetime.now()

        mock_quote_msft = MagicMock()
        mock_quote_msft.bid_price = 299.90
        mock_quote_msft.ask_price = 300.10
        mock_quote_msft.bid_size = 150
        mock_quote_msft.ask_size = 250
        mock_quote_msft.timestamp = datetime.now()

        connected_broker._data_client.get_stock_latest_quote.return_value = {
            "AAPL": mock_quote_aapl,
            "MSFT": mock_quote_msft,
        }

        quotes = connected_broker.get_quotes(["AAPL", "MSFT"])

        assert len(quotes) == 2
        assert "AAPL" in quotes
        assert "MSFT" in quotes
        assert quotes["AAPL"].bid == Decimal("149.90")
        assert quotes["MSFT"].bid == Decimal("299.90")


class TestAlpacaBrokerPositions:
    """Tests for AlpacaBroker position operations."""

    @pytest.fixture
    def connected_broker(self):
        """Create a connected broker with mocks."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        trading_client = MagicMock()
        mock_position = MagicMock()
        mock_position.symbol = "AAPL"
        mock_position.qty = "100"
        mock_position.avg_entry_price = "150.00"
        mock_position.current_price = "155.00"
        mock_position.unrealized_pl = "500.00"
        mock_position.market_value = "15500.00"

        trading_client.get_all_positions.return_value = [mock_position]

        broker._trading_client = trading_client
        broker._status = BrokerStatus.CONNECTED

        return broker

    @pytest.mark.asyncio
    async def test_get_positions(self, connected_broker) -> None:
        """Test getting positions."""
        positions = await connected_broker.get_positions()

        assert len(positions) == 1
        assert positions[0]["symbol"] == "AAPL"
        assert positions[0]["quantity"] == 100.0
        assert positions[0]["unrealized_pnl"] == 500.0

    @pytest.mark.asyncio
    async def test_get_positions_not_connected(self) -> None:
        """Test getting positions when not connected."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        positions = await broker.get_positions()

        assert positions == []


class TestAlpacaBrokerCallbacks:
    """Tests for AlpacaBroker callback registration."""

    def test_on_fill_callback(self) -> None:
        """Test registering fill callback."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        callback = MagicMock()
        broker.on_fill(callback)

        assert callback in broker._on_fill_callbacks

    def test_on_order_update_callback(self) -> None:
        """Test registering order update callback."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        callback = MagicMock()
        broker.on_order_update(callback)

        assert callback in broker._on_order_update_callbacks


class TestAlpacaBrokerDisconnect:
    """Tests for AlpacaBroker disconnection."""

    def test_disconnect(self) -> None:
        """Test disconnecting from broker."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        broker._status = BrokerStatus.CONNECTED
        broker._trading_client = MagicMock()
        broker._data_client = MagicMock()
        broker._stream = MagicMock()
        broker._stream.close = AsyncMock()

        broker.disconnect()

        assert broker.status == BrokerStatus.DISCONNECTED
        assert broker._trading_client is None
        assert broker._data_client is None

    def test_disconnect_with_stream_thread(self) -> None:
        """Test disconnecting when stream thread is running."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        broker._status = BrokerStatus.CONNECTED
        broker._running = True
        broker._stream_thread = MagicMock()

        broker.disconnect()

        assert broker._running is False
        broker._stream_thread.join.assert_called_once_with(timeout=2.0)


class TestAlpacaBrokerOrderEdgeCases:
    """Tests for edge cases in order handling."""

    @pytest.fixture
    def connected_broker(self):
        """Create a connected broker with mocks."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        trading_client = MagicMock()
        broker._trading_client = trading_client
        broker._status = BrokerStatus.CONNECTED
        broker._alpaca = {
            "AlpacaOrderSide": MagicMock(BUY="buy", SELL="sell"),
            "AlpacaTimeInForce": MagicMock(DAY="day"),
            "MarketOrderRequest": MagicMock(),
            "LimitOrderRequest": MagicMock(),
            "StopOrderRequest": MagicMock(),
            "StopLimitOrderRequest": MagicMock(),
        }

        return broker

    def test_submit_stop_order_missing_price(self, connected_broker) -> None:
        """Test submitting stop order without stop price."""
        order = Order(
            order_id="test-order-stop",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            # No stop_price
        )

        result = connected_broker.submit_order(order)

        assert result is None

    def test_submit_stop_limit_order_missing_stop_price(self, connected_broker) -> None:
        """Test submitting stop-limit order without stop price."""
        order = Order(
            order_id="test-order-sl",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("139.50"),
            # No stop_price
        )

        result = connected_broker.submit_order(order)

        assert result is None

    def test_submit_stop_limit_order_missing_limit_price(self, connected_broker) -> None:
        """Test submitting stop-limit order without limit price."""
        order = Order(
            order_id="test-order-sl2",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=Decimal("140.00"),
            # No limit_price
        )

        result = connected_broker.submit_order(order)

        assert result is None

    def test_submit_order_exception(self, connected_broker) -> None:
        """Test submit_order handles exceptions."""
        connected_broker._trading_client.submit_order.side_effect = Exception("API error")

        order = Order(
            order_id="test-order-ex",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        result = connected_broker.submit_order(order)

        assert result is None

    def test_cancel_order_exception(self, connected_broker) -> None:
        """Test cancel_order handles exceptions."""
        connected_broker._trading_client.cancel_order_by_id.side_effect = Exception("Cancel failed")

        result = connected_broker.cancel_order("order-123")

        assert result is False


class TestAlpacaBrokerQuoteEdgeCases:
    """Tests for edge cases in quote handling."""

    @pytest.fixture
    def connected_broker(self):
        """Create a connected broker with mocks."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        broker._data_client = MagicMock()
        broker._status = BrokerStatus.CONNECTED
        broker._alpaca = {
            "StockLatestQuoteRequest": MagicMock(),
        }

        return broker

    def test_get_quote_exception(self, connected_broker) -> None:
        """Test get_quote handles exceptions."""
        connected_broker._data_client.get_stock_latest_quote.side_effect = Exception("API error")

        quote = connected_broker.get_quote("AAPL")

        assert quote is None

    def test_get_quote_symbol_not_in_response(self, connected_broker) -> None:
        """Test get_quote when symbol not in response."""
        connected_broker._data_client.get_stock_latest_quote.return_value = {}

        quote = connected_broker.get_quote("AAPL")

        assert quote is None

    def test_get_quotes_not_connected(self) -> None:
        """Test get_quotes when not connected."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        quotes = broker.get_quotes(["AAPL", "MSFT"])

        assert quotes == {}

    def test_get_quotes_exception(self, connected_broker) -> None:
        """Test get_quotes handles exceptions."""
        connected_broker._data_client.get_stock_latest_quote.side_effect = Exception("API error")

        quotes = connected_broker.get_quotes(["AAPL", "MSFT"])

        assert quotes == {}


class TestAlpacaBrokerPositionEdgeCases:
    """Tests for edge cases in position handling."""

    @pytest.mark.asyncio
    async def test_get_positions_exception(self) -> None:
        """Test get_positions handles exceptions."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        broker._trading_client = MagicMock()
        broker._trading_client.get_all_positions.side_effect = Exception("API error")

        positions = await broker.get_positions()

        assert positions == []


class TestAlpacaBrokerStreaming:
    """Tests for streaming functionality."""

    def test_stream_quotes(self) -> None:
        """Test registering quote stream callback."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        callback = MagicMock()
        broker.stream_quotes(["AAPL"], callback)

        assert callback in broker._on_quote_callbacks

    @pytest.mark.asyncio
    async def test_on_trade_update_fill(self) -> None:
        """Test handling fill event from stream."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        # Set up order mapping
        broker._reverse_map["alpaca-order-123"] = "our-order-123"

        # Register fill callback
        fill_callback = MagicMock()
        broker.on_fill(fill_callback)

        # Register order update callback
        order_callback = MagicMock()
        broker.on_order_update(order_callback)

        # Create mock trade data
        mock_data = MagicMock()
        mock_data.event = "fill"
        mock_data.order = MagicMock()
        mock_data.order.id = "alpaca-order-123"
        mock_data.order.filled_qty = "100"
        mock_data.order.filled_avg_price = "150.00"

        await broker._on_trade_update(mock_data)

        # Fill callback should be called
        fill_callback.assert_called_once()
        # Order update callback should be called
        order_callback.assert_called_once()

    @pytest.mark.asyncio
    async def test_on_trade_update_unknown_order(self) -> None:
        """Test handling trade update for unknown order."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        # Don't set up order mapping - order is unknown

        fill_callback = MagicMock()
        broker.on_fill(fill_callback)

        mock_data = MagicMock()
        mock_data.event = "fill"
        mock_data.order = MagicMock()
        mock_data.order.id = "unknown-order"

        await broker._on_trade_update(mock_data)

        # Callback should not be called for unknown order
        fill_callback.assert_not_called()

    @pytest.mark.asyncio
    async def test_on_trade_update_exception(self) -> None:
        """Test on_trade_update handles exceptions in callbacks."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        broker._reverse_map["alpaca-order-123"] = "our-order-123"

        # Register callback that raises
        def bad_callback(order_id, fill):
            raise ValueError("Callback error")

        broker.on_fill(bad_callback)

        mock_data = MagicMock()
        mock_data.event = "fill"
        mock_data.order = MagicMock()
        mock_data.order.id = "alpaca-order-123"
        mock_data.order.filled_qty = "100"
        mock_data.order.filled_avg_price = "150.00"

        # Should not raise
        await broker._on_trade_update(mock_data)

    @pytest.mark.asyncio
    async def test_on_quote_update(self) -> None:
        """Test handling quote update from stream."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        quote_callback = MagicMock()
        broker.stream_quotes(["AAPL"], quote_callback)

        mock_quote = MagicMock()
        mock_quote.symbol = "AAPL"
        mock_quote.bid_price = 149.90
        mock_quote.ask_price = 150.10
        mock_quote.bid_size = 100
        mock_quote.ask_size = 200
        mock_quote.timestamp = datetime.now()

        await broker._on_quote_update(mock_quote)

        # Callback should be called
        quote_callback.assert_called_once()
        # Quote should be cached
        assert "AAPL" in broker._quotes

    @pytest.mark.asyncio
    async def test_on_quote_update_exception(self) -> None:
        """Test on_quote_update handles exceptions."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        def bad_callback(symbol, quote):
            raise ValueError("Callback error")

        broker.stream_quotes(["AAPL"], bad_callback)

        mock_quote = MagicMock()
        mock_quote.symbol = "AAPL"
        mock_quote.bid_price = 149.90
        mock_quote.ask_price = 150.10
        mock_quote.bid_size = 100
        mock_quote.ask_size = 200
        mock_quote.timestamp = datetime.now()

        # Should not raise
        await broker._on_quote_update(mock_quote)


class TestAlpacaBrokerBuildOrder:
    """Tests for _build_alpaca_order method."""

    def test_build_order_no_alpaca_modules(self) -> None:
        """Test _build_alpaca_order returns None when alpaca not imported."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )
        broker._alpaca = None

        order = Order(
            order_id="test-order",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        result = broker._build_alpaca_order(order)

        assert result is None

    def test_build_sell_order(self) -> None:
        """Test building sell order."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        broker._alpaca = {
            "AlpacaOrderSide": MagicMock(BUY="buy", SELL="sell"),
            "AlpacaTimeInForce": MagicMock(DAY="day"),
            "MarketOrderRequest": MagicMock(return_value="mock_request"),
            "LimitOrderRequest": MagicMock(),
            "StopOrderRequest": MagicMock(),
            "StopLimitOrderRequest": MagicMock(),
        }

        order = Order(
            order_id="test-order",
            session_id="test-session",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        result = broker._build_alpaca_order(order)

        assert result == "mock_request"
        # Verify SELL side was used
        broker._alpaca["MarketOrderRequest"].assert_called_once()


class TestAlpacaBrokerAccountMatch:
    """Tests for account matching."""

    def test_get_account_matching(self) -> None:
        """Test get_account with matching account ID."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        broker._account = BrokerAccount(
            account_id="PA123456",
            name="Test Account",
            cash_balance=Decimal("100000"),
        )

        result = broker.get_account("PA123456")

        assert result is not None
        assert result.account_id == "PA123456"

    def test_get_account_not_matching(self) -> None:
        """Test get_account with non-matching account ID."""
        from quantlab.trading.alpaca import AlpacaBroker

        broker = AlpacaBroker(
            api_key="test-key",
            secret_key="test-secret",
        )

        broker._account = BrokerAccount(
            account_id="PA123456",
            name="Test Account",
            cash_balance=Decimal("100000"),
        )

        result = broker.get_account("DIFFERENT_ID")

        assert result is None

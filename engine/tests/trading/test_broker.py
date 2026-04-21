"""
Tests for Broker Adapter module.

Tests BrokerAdapter, PaperBroker, and BrokerManager.
"""

import pytest
import time
from decimal import Decimal

from quantlab.trading import (
    BrokerStatus,
    BrokerAccount,
    MarketQuote,
    BrokerAdapter,
    PaperBroker,
    PaperBrokerConfig,
    BrokerManager,
    Order,
    OrderSide,
    OrderType,
    OrderStatus,
    Fill,
)


class TestBrokerStatus:
    """Tests for BrokerStatus enum."""

    def test_status_values(self) -> None:
        """Test broker status values."""
        assert BrokerStatus.DISCONNECTED.value == "disconnected"
        assert BrokerStatus.CONNECTING.value == "connecting"
        assert BrokerStatus.CONNECTED.value == "connected"
        assert BrokerStatus.ERROR.value == "error"


class TestBrokerAccount:
    """Tests for BrokerAccount dataclass."""

    def test_creation(self) -> None:
        """Test account creation."""
        account = BrokerAccount(
            account_id="acc-001",
            name="Test Account",
            cash_balance=Decimal("100000"),
        )
        assert account.account_id == "acc-001"
        assert account.cash_balance == Decimal("100000")

    def test_defaults(self) -> None:
        """Test default values."""
        account = BrokerAccount(
            account_id="acc-001",
            name="Test Account",
        )
        assert account.currency == "USD"
        assert account.is_active is True
        assert account.is_paper is True

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        account = BrokerAccount(
            account_id="acc-001",
            name="Test Account",
            cash_balance=Decimal("50000"),
            buying_power=Decimal("50000"),
        )
        d = account.to_dict()

        assert d["accountId"] == "acc-001"
        assert d["cashBalance"] == 50000.0
        assert d["buyingPower"] == 50000.0


class TestMarketQuote:
    """Tests for MarketQuote dataclass."""

    def test_creation(self) -> None:
        """Test quote creation."""
        quote = MarketQuote(
            symbol="AAPL",
            bid=Decimal("149.90"),
            ask=Decimal("150.10"),
            last=Decimal("150.00"),
        )
        assert quote.symbol == "AAPL"
        assert quote.bid == Decimal("149.90")

    def test_mid(self) -> None:
        """Test mid price calculation."""
        quote = MarketQuote(
            symbol="AAPL",
            bid=Decimal("149.00"),
            ask=Decimal("151.00"),
            last=Decimal("150.00"),
        )
        assert quote.mid == Decimal("150.00")

    def test_spread(self) -> None:
        """Test spread calculation."""
        quote = MarketQuote(
            symbol="AAPL",
            bid=Decimal("149.90"),
            ask=Decimal("150.10"),
            last=Decimal("150.00"),
        )
        assert quote.spread == Decimal("0.20")

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        quote = MarketQuote(
            symbol="GOOG",
            bid=Decimal("100.00"),
            ask=Decimal("100.50"),
            last=Decimal("100.25"),
            volume=10000,
        )
        d = quote.to_dict()

        assert d["symbol"] == "GOOG"
        assert d["bid"] == 100.0
        assert d["ask"] == 100.5
        assert d["volume"] == 10000


class TestPaperBrokerConfig:
    """Tests for PaperBrokerConfig dataclass."""

    def test_defaults(self) -> None:
        """Test default values."""
        config = PaperBrokerConfig()

        assert config.initial_capital == Decimal("100000")
        assert config.fill_delay_ms == 100
        assert config.slippage_bps == 5.0

    def test_custom_config(self) -> None:
        """Test custom configuration."""
        config = PaperBrokerConfig(
            initial_capital=Decimal("50000"),
            fill_delay_ms=50,
            partial_fill_probability=0.1,
        )
        assert config.initial_capital == Decimal("50000")
        assert config.fill_delay_ms == 50


class TestPaperBroker:
    """Tests for PaperBroker class."""

    @pytest.fixture
    def broker(self) -> PaperBroker:
        """Create test broker."""
        config = PaperBrokerConfig(
            initial_capital=Decimal("100000"),
            fill_delay_ms=10,  # Fast fills for testing
        )
        return PaperBroker(config)

    @pytest.fixture
    def connected_broker(self, broker: PaperBroker) -> PaperBroker:
        """Create connected broker."""
        broker.connect()
        yield broker
        broker.disconnect()

    def test_name(self, broker: PaperBroker) -> None:
        """Test broker name."""
        assert broker.name == "Paper Broker"

    def test_is_paper(self, broker: PaperBroker) -> None:
        """Test is_paper property."""
        assert broker.is_paper is True

    def test_initial_status(self, broker: PaperBroker) -> None:
        """Test initial status."""
        assert broker.status == BrokerStatus.DISCONNECTED

    def test_connect(self, broker: PaperBroker) -> None:
        """Test connecting."""
        result = broker.connect()

        assert result is True
        assert broker.status == BrokerStatus.CONNECTED

        broker.disconnect()

    def test_disconnect(self, connected_broker: PaperBroker) -> None:
        """Test disconnecting."""
        connected_broker.disconnect()

        assert connected_broker.status == BrokerStatus.DISCONNECTED

    def test_get_accounts(self, connected_broker: PaperBroker) -> None:
        """Test getting accounts."""
        accounts = connected_broker.get_accounts()

        assert len(accounts) == 1
        assert accounts[0].is_paper is True

    def test_get_account(self, connected_broker: PaperBroker) -> None:
        """Test getting account by ID."""
        accounts = connected_broker.get_accounts()
        account_id = accounts[0].account_id

        account = connected_broker.get_account(account_id)
        assert account is not None
        assert account.cash_balance == Decimal("100000")

    def test_get_nonexistent_account(self, connected_broker: PaperBroker) -> None:
        """Test getting non-existent account."""
        account = connected_broker.get_account("nonexistent")
        assert account is None

    @pytest.mark.asyncio
    async def test_set_price(self, connected_broker: PaperBroker) -> None:
        """Test setting simulated price."""
        connected_broker.set_price("AAPL", Decimal("150.00"))

        quote = await connected_broker.get_quote("AAPL")
        assert quote is not None
        assert quote.last == Decimal("150.00")

    @pytest.mark.asyncio
    async def test_set_prices(self, connected_broker: PaperBroker) -> None:
        """Test setting multiple prices."""
        connected_broker.set_prices({
            "AAPL": Decimal("150.00"),
            "GOOG": Decimal("100.00"),
        })

        quotes = await connected_broker.get_quotes(["AAPL", "GOOG"])
        assert len(quotes) == 2
        assert quotes["AAPL"].last == Decimal("150.00")

    @pytest.mark.asyncio
    async def test_get_quote_no_price(self, connected_broker: PaperBroker) -> None:
        """Test getting quote when no price set."""
        quote = await connected_broker.get_quote("UNKNOWN")
        assert quote is None

    @pytest.mark.asyncio
    async def test_submit_order(self, connected_broker: PaperBroker) -> None:
        """Test submitting an order."""
        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        broker_order_id = await connected_broker.submit_order(order)

        assert broker_order_id is not None
        assert broker_order_id.startswith("paper-")

    @pytest.mark.asyncio
    async def test_cancel_order(self, connected_broker: PaperBroker) -> None:
        """Test cancelling an order."""
        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("100.00"),  # Low price, won't fill
        )

        broker_order_id = await connected_broker.submit_order(order)
        result = await connected_broker.cancel_order(broker_order_id)

        assert result is True

    @pytest.mark.asyncio
    async def test_cancel_nonexistent_order(self, connected_broker: PaperBroker) -> None:
        """Test cancelling non-existent order."""
        result = await connected_broker.cancel_order("nonexistent")
        assert result is False

    @pytest.mark.asyncio
    async def test_market_order_fill(self, connected_broker: PaperBroker) -> None:
        """Test market order gets filled."""
        connected_broker.set_price("AAPL", Decimal("150.00"))

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        await connected_broker.submit_order(order)

        # Wait for fill
        time.sleep(0.1)

        assert len(fills) >= 1
        assert fills[0][0] == "order-001"

    @pytest.mark.asyncio
    async def test_limit_order_fill(self, connected_broker: PaperBroker) -> None:
        """Test limit order gets filled when price is right."""
        connected_broker.set_price("AAPL", Decimal("145.00"))

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),  # Price below limit
        )

        await connected_broker.submit_order(order)

        # Wait for fill
        time.sleep(0.1)

        assert len(fills) >= 1

    @pytest.mark.asyncio
    async def test_limit_order_not_filled(self, connected_broker: PaperBroker) -> None:
        """Test limit order not filled when price is wrong."""
        connected_broker.set_price("AAPL", Decimal("155.00"))

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),  # Price above limit
        )

        await connected_broker.submit_order(order)

        # Wait a bit
        time.sleep(0.05)

        assert len(fills) == 0

    @pytest.mark.asyncio
    async def test_order_update_callback(self, connected_broker: PaperBroker) -> None:
        """Test order update callback."""
        updates: list[tuple[str, OrderStatus]] = []
        connected_broker.on_order_update(lambda oid, s: updates.append((oid, s)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        await connected_broker.submit_order(order)

        # Should get accepted callback
        time.sleep(0.01)
        assert len(updates) >= 1
        assert updates[0][1] == OrderStatus.ACCEPTED

    @pytest.mark.asyncio
    async def test_account_updated_on_fill(self, connected_broker: PaperBroker) -> None:
        """Test account balance updated on fill."""
        connected_broker.set_price("AAPL", Decimal("100.00"))

        initial_balance = connected_broker.get_accounts()[0].cash_balance

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        await connected_broker.submit_order(order)

        # Wait for fill
        time.sleep(0.1)

        final_balance = connected_broker.get_accounts()[0].cash_balance
        # Balance should decrease (bought shares + commission)
        assert final_balance < initial_balance


class TestBrokerManager:
    """Tests for BrokerManager class."""

    @pytest.fixture
    def manager(self) -> BrokerManager:
        """Create test manager."""
        return BrokerManager()

    def test_register_broker(self, manager: BrokerManager) -> None:
        """Test registering a broker."""
        broker = PaperBroker()
        manager.register_broker("paper-001", broker)

        retrieved = manager.get_broker("paper-001")
        assert retrieved is broker

    def test_get_nonexistent_broker(self, manager: BrokerManager) -> None:
        """Test getting non-existent broker."""
        result = manager.get_broker("nonexistent")
        assert result is None

    def test_get_all_brokers(self, manager: BrokerManager) -> None:
        """Test getting all brokers."""
        broker1 = PaperBroker()
        broker2 = PaperBroker()

        manager.register_broker("paper-001", broker1)
        manager.register_broker("paper-002", broker2)

        all_brokers = manager.get_all_brokers()
        assert len(all_brokers) == 2

    def test_get_connected_brokers(self, manager: BrokerManager) -> None:
        """Test getting connected brokers."""
        broker1 = PaperBroker()
        broker2 = PaperBroker()

        manager.register_broker("paper-001", broker1)
        manager.register_broker("paper-002", broker2)

        broker1.connect()

        connected = manager.get_connected_brokers()
        assert len(connected) == 1
        assert connected[0] is broker1

        broker1.disconnect()

    def test_create_paper_broker(self, manager: BrokerManager) -> None:
        """Test creating and registering a paper broker."""
        config = PaperBrokerConfig(initial_capital=Decimal("50000"))
        broker = manager.create_paper_broker("paper-test", config)

        assert broker is not None
        assert broker.is_paper is True

        retrieved = manager.get_broker("paper-test")
        assert retrieved is broker

    def test_disconnect_all(self, manager: BrokerManager) -> None:
        """Test disconnecting all brokers."""
        broker1 = manager.create_paper_broker("paper-001")
        broker2 = manager.create_paper_broker("paper-002")

        broker1.connect()
        broker2.connect()

        manager.disconnect_all()

        assert broker1.status == BrokerStatus.DISCONNECTED
        assert broker2.status == BrokerStatus.DISCONNECTED


class TestPaperBrokerAdvanced:
    """Advanced tests for PaperBroker covering edge cases."""

    @pytest.fixture
    def broker(self) -> PaperBroker:
        """Create test broker with fast fills."""
        config = PaperBrokerConfig(
            initial_capital=Decimal("100000"),
            fill_delay_ms=10,
        )
        return PaperBroker(config)

    @pytest.fixture
    def connected_broker(self, broker: PaperBroker) -> PaperBroker:
        """Create connected broker."""
        broker.connect()
        yield broker
        broker.disconnect()

    @pytest.mark.asyncio
    async def test_reject_probability(self) -> None:
        """Test order rejection probability."""
        config = PaperBrokerConfig(
            initial_capital=Decimal("100000"),
            reject_probability=1.0,  # Always reject
        )
        broker = PaperBroker(config)
        broker.connect()

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        result = await broker.submit_order(order)
        assert result is None  # Should be rejected

        broker.disconnect()

    @pytest.mark.asyncio
    async def test_partial_fill_probability(self) -> None:
        """Test partial fill functionality."""
        config = PaperBrokerConfig(
            initial_capital=Decimal("100000"),
            fill_delay_ms=10,
            partial_fill_probability=1.0,  # Always partial fill
        )
        broker = PaperBroker(config)
        broker.connect()
        broker.set_price("AAPL", Decimal("150.00"))

        fills: list[tuple[str, Fill]] = []
        broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        await broker.submit_order(order)
        time.sleep(0.1)

        # Should get at least one fill, possibly partial
        assert len(fills) >= 1
        # If partial, fill qty should be less than order qty (unless random rounds to full)
        # The key is that the partial fill code path is executed

        broker.disconnect()

    @pytest.mark.asyncio
    async def test_stop_order_buy_triggered(self, connected_broker: PaperBroker) -> None:
        """Test buy stop order fills when price reaches stop."""
        connected_broker.set_price("AAPL", Decimal("155.00"))  # Above stop price

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("150.00"),  # Price is above stop
        )

        await connected_broker.submit_order(order)
        time.sleep(0.1)

        assert len(fills) >= 1

    @pytest.mark.asyncio
    async def test_stop_order_buy_not_triggered(self, connected_broker: PaperBroker) -> None:
        """Test buy stop order does not fill when price below stop."""
        connected_broker.set_price("AAPL", Decimal("145.00"))  # Below stop price

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("150.00"),  # Price is below stop
        )

        await connected_broker.submit_order(order)
        time.sleep(0.05)

        assert len(fills) == 0

    @pytest.mark.asyncio
    async def test_stop_order_sell_triggered(self, connected_broker: PaperBroker) -> None:
        """Test sell stop order fills when price falls to stop."""
        connected_broker.set_price("AAPL", Decimal("145.00"))  # Below stop price

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("150.00"),  # Price is below stop
        )

        await connected_broker.submit_order(order)
        time.sleep(0.1)

        assert len(fills) >= 1

    @pytest.mark.asyncio
    async def test_stop_order_sell_not_triggered(self, connected_broker: PaperBroker) -> None:
        """Test sell stop order does not fill when price above stop."""
        connected_broker.set_price("AAPL", Decimal("155.00"))  # Above stop price

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=Decimal("150.00"),  # Price is above stop
        )

        await connected_broker.submit_order(order)
        time.sleep(0.05)

        assert len(fills) == 0

    @pytest.mark.asyncio
    async def test_stop_limit_order_buy_triggered_limit_met(
        self, connected_broker: PaperBroker
    ) -> None:
        """Test buy stop-limit order fills when both conditions met."""
        connected_broker.set_price("AAPL", Decimal("152.00"))  # Above stop, below limit

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=Decimal("150.00"),  # Triggered
            limit_price=Decimal("155.00"),  # Price below limit
        )

        await connected_broker.submit_order(order)
        time.sleep(0.1)

        assert len(fills) >= 1

    @pytest.mark.asyncio
    async def test_stop_limit_order_buy_stop_not_triggered(
        self, connected_broker: PaperBroker
    ) -> None:
        """Test buy stop-limit doesn't fill when stop not triggered."""
        connected_broker.set_price("AAPL", Decimal("145.00"))  # Below stop

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=Decimal("150.00"),  # Not triggered
            limit_price=Decimal("155.00"),
        )

        await connected_broker.submit_order(order)
        time.sleep(0.05)

        assert len(fills) == 0

    @pytest.mark.asyncio
    async def test_stop_limit_order_buy_limit_not_met(
        self, connected_broker: PaperBroker
    ) -> None:
        """Test buy stop-limit doesn't fill when limit not met."""
        connected_broker.set_price("AAPL", Decimal("160.00"))  # Above stop AND limit

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=Decimal("150.00"),  # Triggered
            limit_price=Decimal("155.00"),  # Price above limit
        )

        await connected_broker.submit_order(order)
        time.sleep(0.05)

        assert len(fills) == 0

    @pytest.mark.asyncio
    async def test_stop_limit_order_sell_triggered_limit_met(
        self, connected_broker: PaperBroker
    ) -> None:
        """Test sell stop-limit order fills when both conditions met."""
        connected_broker.set_price("AAPL", Decimal("148.00"))  # Below stop, above limit

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=Decimal("150.00"),  # Triggered
            limit_price=Decimal("145.00"),  # Price above limit
        )

        await connected_broker.submit_order(order)
        time.sleep(0.1)

        assert len(fills) >= 1

    @pytest.mark.asyncio
    async def test_stop_limit_order_sell_stop_not_triggered(
        self, connected_broker: PaperBroker
    ) -> None:
        """Test sell stop-limit doesn't fill when stop not triggered."""
        connected_broker.set_price("AAPL", Decimal("155.00"))  # Above stop

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=Decimal("150.00"),  # Not triggered
            limit_price=Decimal("145.00"),
        )

        await connected_broker.submit_order(order)
        time.sleep(0.05)

        assert len(fills) == 0

    @pytest.mark.asyncio
    async def test_stop_limit_order_sell_limit_not_met(
        self, connected_broker: PaperBroker
    ) -> None:
        """Test sell stop-limit doesn't fill when limit not met."""
        connected_broker.set_price("AAPL", Decimal("140.00"))  # Below stop AND limit

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=Decimal("150.00"),  # Triggered
            limit_price=Decimal("145.00"),  # Price below limit
        )

        await connected_broker.submit_order(order)
        time.sleep(0.05)

        assert len(fills) == 0

    @pytest.mark.asyncio
    async def test_limit_order_sell_filled(self, connected_broker: PaperBroker) -> None:
        """Test sell limit order fills when price is right."""
        connected_broker.set_price("AAPL", Decimal("155.00"))  # Above limit

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),  # Price above limit
        )

        await connected_broker.submit_order(order)
        time.sleep(0.1)

        assert len(fills) >= 1

    @pytest.mark.asyncio
    async def test_limit_order_sell_not_filled(self, connected_broker: PaperBroker) -> None:
        """Test sell limit order not filled when price wrong."""
        connected_broker.set_price("AAPL", Decimal("145.00"))  # Below limit

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=Decimal("150.00"),  # Price below limit
        )

        await connected_broker.submit_order(order)
        time.sleep(0.05)

        assert len(fills) == 0

    @pytest.mark.asyncio
    async def test_fill_callback_exception_handled(self, connected_broker: PaperBroker) -> None:
        """Test that exceptions in fill callbacks are handled."""
        connected_broker.set_price("AAPL", Decimal("150.00"))

        def bad_callback(oid: str, fill: Fill) -> None:
            raise RuntimeError("Callback error")

        connected_broker.on_fill(bad_callback)

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        # Should not raise even though callback throws
        await connected_broker.submit_order(order)
        time.sleep(0.1)

    @pytest.mark.asyncio
    async def test_order_update_callback_exception_handled(
        self, connected_broker: PaperBroker
    ) -> None:
        """Test that exceptions in order update callbacks are handled."""

        def bad_callback(oid: str, status: OrderStatus) -> None:
            raise RuntimeError("Callback error")

        connected_broker.on_order_update(bad_callback)

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        # Should not raise even though callback throws
        await connected_broker.submit_order(order)

    @pytest.mark.asyncio
    async def test_sell_market_order(self, connected_broker: PaperBroker) -> None:
        """Test sell market order updates account balance."""
        connected_broker.set_price("AAPL", Decimal("100.00"))

        initial_balance = connected_broker.get_accounts()[0].cash_balance

        # First buy some shares
        buy_order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )
        await connected_broker.submit_order(buy_order)
        time.sleep(0.1)

        balance_after_buy = connected_broker.get_accounts()[0].cash_balance

        # Then sell them
        sell_order = Order(
            order_id="order-002",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.SELL,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )
        await connected_broker.submit_order(sell_order)
        time.sleep(0.1)

        final_balance = connected_broker.get_accounts()[0].cash_balance

        # Balance should increase after sell (minus commission)
        assert final_balance > balance_after_buy

    @pytest.mark.asyncio
    async def test_order_without_price_set(self, connected_broker: PaperBroker) -> None:
        """Test order for symbol without price set."""
        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="UNKNOWN",  # No price set
            side=OrderSide.BUY,
            order_type=OrderType.MARKET,
            quantity=Decimal("100"),
        )

        await connected_broker.submit_order(order)
        time.sleep(0.05)

        # Should not fill - no price available
        assert len(fills) == 0

    @pytest.mark.asyncio
    async def test_stop_order_missing_stop_price(self, connected_broker: PaperBroker) -> None:
        """Test stop order without stop_price set."""
        connected_broker.set_price("AAPL", Decimal("150.00"))

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP,
            quantity=Decimal("100"),
            stop_price=None,  # Missing
        )

        await connected_broker.submit_order(order)
        time.sleep(0.05)

        assert len(fills) == 0

    @pytest.mark.asyncio
    async def test_limit_order_missing_limit_price(self, connected_broker: PaperBroker) -> None:
        """Test limit order without limit_price set."""
        connected_broker.set_price("AAPL", Decimal("150.00"))

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.LIMIT,
            quantity=Decimal("100"),
            limit_price=None,  # Missing
        )

        await connected_broker.submit_order(order)
        time.sleep(0.05)

        assert len(fills) == 0

    @pytest.mark.asyncio
    async def test_stop_limit_order_missing_prices(self, connected_broker: PaperBroker) -> None:
        """Test stop-limit order without prices set."""
        connected_broker.set_price("AAPL", Decimal("150.00"))

        fills: list[tuple[str, Fill]] = []
        connected_broker.on_fill(lambda oid, f: fills.append((oid, f)))

        order = Order(
            order_id="order-001",
            session_id="session-001",
            symbol="AAPL",
            side=OrderSide.BUY,
            order_type=OrderType.STOP_LIMIT,
            quantity=Decimal("100"),
            stop_price=None,  # Missing
            limit_price=None,  # Missing
        )

        await connected_broker.submit_order(order)
        time.sleep(0.05)

        assert len(fills) == 0


class TestBrokerManagerExceptionHandling:
    """Tests for exception handling in BrokerManager."""

    def test_disconnect_all_handles_exception(self) -> None:
        """Test disconnect_all handles broker disconnect exceptions."""
        from unittest.mock import MagicMock

        manager = BrokerManager()

        # Create a mock broker that raises on disconnect
        bad_broker = MagicMock()
        bad_broker.disconnect.side_effect = RuntimeError("Disconnect failed")

        manager.register_broker("bad-broker", bad_broker)

        # Should not raise
        manager.disconnect_all()

"""
Integration Test Harness.

Provides utilities for integration testing of Quantlab components.
"""

import asyncio
import logging
import tempfile
import time
from contextlib import asynccontextmanager
from contextlib import contextmanager
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from typing import AsyncIterator
from typing import Iterator

import pytest

from quantlab.trading import (
    BrokerAccount,
    BrokerStatus,
    MarketQuote,
    OrderManager,
    OrderRequest,
    OrderSide,
    OrderType,
    PaperBroker,
    PaperBrokerConfig,
    Position,
    PositionTracker,
    SessionConfig,
    SessionMode,
    TimeInForce,
    TradingSession,
)
from quantlab.risk import (
    CircuitBreaker,
    CircuitBreakerState,
    ConsecutiveLossTracker,
    ExposureManager,
)


logger = logging.getLogger(__name__)


@dataclass
class IntegrationTestEnvironment:
    """Test environment with all components configured."""

    temp_dir: Path
    session_id: str
    broker: PaperBroker
    order_manager: OrderManager
    position_tracker: PositionTracker
    circuit_breaker: CircuitBreaker
    exposure_manager: ExposureManager
    loss_tracker: ConsecutiveLossTracker

    # State tracking
    events: list[dict[str, Any]] = field(default_factory=list)
    orders_submitted: list[str] = field(default_factory=list)
    fills_received: list[dict[str, Any]] = field(default_factory=list)


@contextmanager
def create_test_environment(
    initial_cash: Decimal = Decimal("100000"),
    max_exposure: Decimal = Decimal("50000"),
    consecutive_loss_limit: int = 3,
) -> Iterator[IntegrationTestEnvironment]:
    """
    Create a complete test environment.

    Yields:
        IntegrationTestEnvironment with all components configured
    """
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        session_id = f"test_{int(time.time() * 1000)}"

        # Create broker
        broker_config = PaperBrokerConfig(
            initial_capital=initial_cash,
            fill_delay_ms=0,  # Instant fills for testing
        )
        broker = PaperBroker(broker_config)

        # Create order manager
        order_manager = OrderManager()

        # Create position tracker
        position_tracker = PositionTracker()

        # Create risk controls
        circuit_breaker = CircuitBreaker(session_id=session_id)
        exposure_manager = ExposureManager(max_exposure=max_exposure)
        loss_tracker = ConsecutiveLossTracker(limit=consecutive_loss_limit)

        # Connect loss tracker to circuit breaker
        from quantlab.risk.circuit_breaker import TriggerReason

        def _on_loss_threshold(event):
            circuit_breaker.trip(
                TriggerReason.CONSECUTIVE_LOSSES,
                f"{event.consecutive_losses} consecutive losses",
            )

        loss_tracker.on_threshold(_on_loss_threshold)

        env = IntegrationTestEnvironment(
            temp_dir=temp_path,
            session_id=session_id,
            broker=broker,
            order_manager=order_manager,
            position_tracker=position_tracker,
            circuit_breaker=circuit_breaker,
            exposure_manager=exposure_manager,
            loss_tracker=loss_tracker,
        )

        # Connect broker
        broker.connect()

        try:
            yield env
        finally:
            broker.disconnect()


async def submit_test_order(
    env: IntegrationTestEnvironment,
    symbol: str,
    side: OrderSide,
    quantity: Decimal,
    order_type: OrderType = OrderType.MARKET,
    limit_price: Decimal | None = None,
) -> str:
    """
    Submit a test order through the environment.

    Returns:
        Order ID
    """
    # Check circuit breaker
    allowed, reason = env.circuit_breaker.check_order_allowed()
    if not allowed:
        raise RuntimeError(f"Order blocked: {reason}")

    # Create order request
    request = OrderRequest(
        session_id=env.session_id,
        symbol=symbol,
        side=side,
        order_type=order_type,
        quantity=quantity,
        limit_price=limit_price,
        time_in_force=TimeInForce.GTC,
    )

    # Create and submit order
    order = env.order_manager.create_order(request)
    result = await env.broker.submit_order(order)

    if result:
        env.orders_submitted.append(order.order_id)
        env.events.append({
            "type": "order_submitted",
            "order_id": order.order_id,
            "symbol": symbol,
            "side": side.value,
            "quantity": str(quantity),
            "timestamp": datetime.now().isoformat(),
        })

    return order.order_id


def record_fill(
    env: IntegrationTestEnvironment,
    order_id: str,
    symbol: str,
    side: OrderSide,
    quantity: Decimal,
    price: Decimal,
    commission: Decimal = Decimal("0"),
) -> None:
    """Record a fill and update position."""
    # Update position
    position = env.position_tracker.get_or_create_position(env.session_id, symbol)

    # Apply fill based on side
    from quantlab.trading.orders import Fill as OrderFill

    fill = OrderFill(
        fill_id=f"fill_{int(time.time() * 1000)}",
        order_id=order_id,
        quantity=quantity,
        price=price,
        commission=commission,
        timestamp=datetime.now(),
    )

    position.apply_fill(fill, side)

    # Update exposure via reserve/commit API
    from quantlab.risk.exposure import OrderRequest as ExposureOrderRequest
    from quantlab.risk.exposure import Fill as ExposureFill
    from quantlab.risk.exposure import OrderSide as ExposureOrderSide

    exp_side = ExposureOrderSide.BUY if side == OrderSide.BUY else ExposureOrderSide.SELL
    exp_order = ExposureOrderRequest(
        order_id=order_id,
        symbol=symbol,
        side=exp_side,
        quantity=quantity,
        price=price,
    )
    env.exposure_manager.reserve(exp_order, price_estimate=price)
    exp_fill = ExposureFill(
        order_id=order_id,
        symbol=symbol,
        side=exp_side,
        fill_quantity=quantity,
        fill_price=price,
    )
    env.exposure_manager.commit(order_id, exp_fill)

    # Record event
    env.fills_received.append({
        "order_id": order_id,
        "symbol": symbol,
        "side": side.value,
        "quantity": str(quantity),
        "price": str(price),
        "timestamp": datetime.now().isoformat(),
    })

    env.events.append({
        "type": "fill",
        "order_id": order_id,
        "symbol": symbol,
        "side": side.value,
        "quantity": str(quantity),
        "price": str(price),
        "timestamp": datetime.now().isoformat(),
    })


def record_trade_pnl(env: IntegrationTestEnvironment, pnl: Decimal) -> bool:
    """
    Record a trade P&L result.

    Returns:
        True if circuit breaker tripped
    """
    return env.loss_tracker.record_trade(pnl)


def assert_position(
    env: IntegrationTestEnvironment,
    symbol: str,
    expected_quantity: Decimal,
    msg: str = "",
) -> None:
    """Assert position quantity matches expected."""
    position = env.position_tracker.get_position(env.session_id, symbol)
    actual = position.quantity if position else Decimal("0")

    assert actual == expected_quantity, (
        f"Position mismatch for {symbol}: expected {expected_quantity}, "
        f"got {actual}. {msg}"
    )


def assert_circuit_breaker_state(
    env: IntegrationTestEnvironment,
    expected_state: CircuitBreakerState,
    msg: str = "",
) -> None:
    """Assert circuit breaker is in expected state."""
    actual = env.circuit_breaker.state

    assert actual == expected_state, (
        f"Circuit breaker state mismatch: expected {expected_state.value}, "
        f"got {actual.value}. {msg}"
    )


def assert_no_errors(env: IntegrationTestEnvironment) -> None:
    """Assert no error events were recorded."""
    errors = [e for e in env.events if e.get("type") == "error"]
    assert len(errors) == 0, f"Unexpected errors: {errors}"


# =============================================================================
# Test Scenarios
# =============================================================================


@pytest.mark.asyncio
async def test_basic_order_flow():
    """Test basic order submission and fill."""
    with create_test_environment() as env:
        # Submit buy order
        order_id = await submit_test_order(
            env,
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
        )

        assert order_id in env.orders_submitted

        # Simulate fill
        record_fill(
            env,
            order_id=order_id,
            symbol="AAPL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150.00"),
        )

        # Verify position
        assert_position(env, "AAPL", Decimal("100"))

        # Circuit breaker should still be closed
        assert_circuit_breaker_state(env, CircuitBreakerState.CLOSED)


@pytest.mark.asyncio
async def test_consecutive_loss_circuit_breaker():
    """Test circuit breaker triggers after consecutive losses."""
    with create_test_environment(consecutive_loss_limit=3) as env:
        # Record consecutive losses
        record_trade_pnl(env, Decimal("-100"))
        assert_circuit_breaker_state(env, CircuitBreakerState.CLOSED)

        record_trade_pnl(env, Decimal("-100"))
        assert_circuit_breaker_state(env, CircuitBreakerState.CLOSED)

        # Third loss should trip
        tripped = record_trade_pnl(env, Decimal("-100"))
        assert tripped, "Circuit breaker should have tripped"

        # Verify orders are blocked
        with pytest.raises(RuntimeError, match="Order blocked"):
            await submit_test_order(
                env,
                symbol="AAPL",
                side=OrderSide.BUY,
                quantity=Decimal("100"),
            )


@pytest.mark.asyncio
async def test_position_round_trip():
    """Test opening and closing a position."""
    with create_test_environment() as env:
        # Open long position
        buy_order = await submit_test_order(
            env,
            symbol="MSFT",
            side=OrderSide.BUY,
            quantity=Decimal("50"),
        )

        record_fill(
            env,
            order_id=buy_order,
            symbol="MSFT",
            side=OrderSide.BUY,
            quantity=Decimal("50"),
            price=Decimal("300.00"),
        )

        assert_position(env, "MSFT", Decimal("50"))

        # Close position
        sell_order = await submit_test_order(
            env,
            symbol="MSFT",
            side=OrderSide.SELL,
            quantity=Decimal("50"),
        )

        record_fill(
            env,
            order_id=sell_order,
            symbol="MSFT",
            side=OrderSide.SELL,
            quantity=Decimal("50"),
            price=Decimal("310.00"),
        )

        # Position should be flat
        assert_position(env, "MSFT", Decimal("0"))


@pytest.mark.asyncio
async def test_exposure_limit():
    """Test exposure limit enforcement."""
    with create_test_environment(max_exposure=Decimal("10000")) as env:
        # Submit order that would exceed exposure
        order_id = await submit_test_order(
            env,
            symbol="GOOGL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
        )

        # Large fill would exceed exposure
        record_fill(
            env,
            order_id=order_id,
            symbol="GOOGL",
            side=OrderSide.BUY,
            quantity=Decimal("100"),
            price=Decimal("150.00"),
        )

        # Check exposure
        snapshot = env.exposure_manager.snapshot()
        assert snapshot.current_exposure == Decimal("15000")
        assert snapshot.current_exposure > snapshot.max_exposure  # Over limit


@pytest.mark.asyncio
async def test_win_resets_loss_streak():
    """Test that a win resets the consecutive loss counter."""
    with create_test_environment(consecutive_loss_limit=3) as env:
        # Two losses
        record_trade_pnl(env, Decimal("-100"))
        record_trade_pnl(env, Decimal("-100"))

        assert env.loss_tracker.consecutive_losses == 2

        # Win should reset
        record_trade_pnl(env, Decimal("50"))

        assert env.loss_tracker.consecutive_losses == 0
        assert_circuit_breaker_state(env, CircuitBreakerState.CLOSED)


# =============================================================================
# Run tests
# =============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v"])

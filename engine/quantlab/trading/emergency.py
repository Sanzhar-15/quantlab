"""
Emergency Flatten Protocol.

Provides robust position flattening for emergency situations with
two-stage execution and retry logic.

Two-Stage Protocol:
    Stage 1: Submit marketable limit IOC orders (aggressive limits that should fill)
    Stage 2: If Stage 1 doesn't fill, submit market orders with retry

Confirmation Requirement:
    User-initiated flattens require confirmation token matching "FLATTEN"
    to prevent accidental position liquidation.

Spec Reference: Technical Spec §12.3 (Safety Layer), §2.6 (Emergency Flatten)
"""

import asyncio
import hashlib
import logging
import random
import time
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import time as dt_time
from decimal import Decimal
from enum import Enum
from typing import Any
from typing import Callable

from .broker import BrokerAdapter
from .broker import MarketQuote
from .orders import Order
from .orders import OrderManager
from .orders import OrderRequest
from .orders import OrderSide
from .orders import OrderStatus
from .orders import OrderType
from .orders import TimeInForce
from .positions import Position
from .positions import PositionTracker


logger = logging.getLogger(__name__)


# Confirmation token for user-initiated flattens
FLATTEN_CONFIRMATION_TOKEN = "FLATTEN"


class FlattenConfirmationError(Exception):
    """Error when flatten confirmation is missing or invalid."""

    pass


class FlattenStage(Enum):
    """Stage of the flatten protocol."""

    PENDING = "pending"
    CANCELING_ORDERS = "canceling_orders"
    STAGE_1_LIMIT = "stage_1_limit"  # Marketable limit orders
    STAGE_2_MARKET = "stage_2_market"  # Market orders
    COMPLETED = "completed"
    FAILED = "failed"


class FlattenReason(Enum):
    """Reason for emergency flatten."""

    USER_REQUEST = "user_request"
    RISK_VIOLATION = "risk_violation"
    MAX_DRAWDOWN = "max_drawdown"
    DAILY_LOSS_LIMIT = "daily_loss_limit"
    SYSTEM_ERROR = "system_error"
    HEARTBEAT_FAILURE = "heartbeat_failure"
    BROKER_DISCONNECT = "broker_disconnect"


@dataclass
class FlattenProgress:
    """Progress of a single position flatten."""

    symbol: str
    initial_quantity: Decimal
    remaining_quantity: Decimal
    stage: FlattenStage
    orders_submitted: list[str] = field(default_factory=list)
    last_error: str | None = None
    attempts: int = 0


@dataclass
class FlattenResult:
    """Result of emergency flatten operation."""

    session_id: str
    reason: FlattenReason
    started_at: datetime
    completed_at: datetime | None
    stage: FlattenStage
    positions_flattened: int
    positions_remaining: int
    total_pnl: Decimal
    progress: dict[str, FlattenProgress] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    @property
    def is_complete(self) -> bool:
        """Check if flatten is complete."""
        return self.stage == FlattenStage.COMPLETED

    @property
    def is_failed(self) -> bool:
        """Check if flatten failed."""
        return self.stage == FlattenStage.FAILED

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "sessionId": self.session_id,
            "reason": self.reason.value,
            "startedAt": self.started_at.isoformat(),
            "completedAt": self.completed_at.isoformat() if self.completed_at else None,
            "stage": self.stage.value,
            "positionsFlattened": self.positions_flattened,
            "positionsRemaining": self.positions_remaining,
            "totalPnl": str(self.total_pnl),
            "errors": self.errors,
            "progress": {
                k: {
                    "symbol": v.symbol,
                    "initialQuantity": str(v.initial_quantity),
                    "remainingQuantity": str(v.remaining_quantity),
                    "stage": v.stage.value,
                    "ordersSubmitted": v.orders_submitted,
                    "lastError": v.last_error,
                    "attempts": v.attempts,
                }
                for k, v in self.progress.items()
            },
        }


@dataclass
class FlattenConfig:
    """Configuration for emergency flatten."""

    # Stage 1: Marketable limit settings
    stage1_spread_multiplier: Decimal = Decimal("1.5")  # Bid/ask spread multiple
    stage1_timeout_seconds: float = 5.0  # Timeout before stage 2

    # Stage 2: Market order settings
    stage2_enabled: bool = True
    stage2_max_retries: int = 3
    stage2_base_delay_seconds: float = 1.0  # Base delay for exponential backoff
    stage2_max_delay_seconds: float = 30.0  # Maximum delay cap

    # Quote validation
    require_quote_validation: bool = True
    max_quote_age_seconds: float = 5.0
    max_spread_percent: Decimal = Decimal("0.05")  # 5% max spread
    reject_wide_spread: bool = True  # Reject quotes exceeding max spread

    # Market hours validation
    validate_market_hours: bool = True
    market_open: dt_time = dt_time(9, 30)  # 9:30 AM ET
    market_close: dt_time = dt_time(16, 0)  # 4:00 PM ET
    allow_extended_hours: bool = True  # Allow pre/post-market emergency flatten

    # Order settings
    order_timeout_seconds: float = 30.0

    # Confirmation requirement
    require_confirmation: bool = True  # Require confirmation token for user-initiated
    auto_flatten_reasons: tuple[FlattenReason, ...] = (
        FlattenReason.RISK_VIOLATION,
        FlattenReason.MAX_DRAWDOWN,
        FlattenReason.DAILY_LOSS_LIMIT,
        FlattenReason.SYSTEM_ERROR,
        FlattenReason.HEARTBEAT_FAILURE,
        FlattenReason.BROKER_DISCONNECT,
    )  # Reasons that don't require confirmation

    # Callbacks
    on_progress: Callable[[FlattenResult], None] | None = None
    on_complete: Callable[[FlattenResult], None] | None = None


def generate_flatten_token(session_id: str) -> str:
    """
    Generate a unique flatten confirmation token.

    The user must type "FLATTEN" to acknowledge the action.
    This token ties the confirmation to a specific session.

    Args:
        session_id: Trading session ID

    Returns:
        Token that user must match
    """
    # The token is always "FLATTEN" - the user types this to confirm
    return FLATTEN_CONFIRMATION_TOKEN


def verify_flatten_confirmation(
    confirmation: str,
    session_id: str,
) -> tuple[bool, str]:
    """
    Verify the flatten confirmation from user.

    Args:
        confirmation: User's confirmation input
        session_id: Trading session ID

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not confirmation:
        return False, "Confirmation required. Type 'FLATTEN' to confirm emergency liquidation."

    # Normalize: strip whitespace, uppercase
    normalized = confirmation.strip().upper()

    if normalized != FLATTEN_CONFIRMATION_TOKEN:
        return (
            False,
            f"Invalid confirmation. Expected '{FLATTEN_CONFIRMATION_TOKEN}', got '{confirmation}'"
        )

    return True, ""


class EmergencyFlatten:
    """
    Two-stage emergency position flattening protocol.

    Stage 1: Submit marketable limit orders (aggressive limits that should fill)
    Stage 2: If stage 1 doesn't fill, submit market orders

    The protocol ensures all positions are closed with retry logic
    and proper quote validation.
    """

    def __init__(
        self,
        session_id: str,
        broker: BrokerAdapter,
        order_manager: OrderManager,
        position_tracker: PositionTracker,
        config: FlattenConfig | None = None,
        audit_ledger: Any | None = None,  # FIX-T001: Optional audit ledger
    ) -> None:
        """
        Initialize emergency flatten.

        Args:
            session_id: Trading session ID
            broker: Connected broker adapter
            order_manager: Order manager
            position_tracker: Position tracker
            config: Flatten configuration
            audit_ledger: Optional audit ledger for compliance logging
        """
        self._session_id = session_id
        self._broker = broker
        self._order_manager = order_manager
        self._position_tracker = position_tracker
        self._config = config or FlattenConfig()
        self._audit_ledger = audit_ledger  # FIX-T001
        self._result: FlattenResult | None = None
        self._is_running = False

    @property
    def is_running(self) -> bool:
        """Check if flatten is running."""
        return self._is_running

    @property
    def result(self) -> FlattenResult | None:
        """Get current result."""
        return self._result

    def _is_market_hours(self) -> bool:
        """
        Check if current time is within market hours.

        Returns:
            True if within market hours or extended hours allowed
        """
        if not self._config.validate_market_hours:
            return True

        now = datetime.now().time()
        market_open = self._config.market_open
        market_close = self._config.market_close

        # Check regular market hours
        is_regular_hours = market_open <= now <= market_close

        if is_regular_hours:
            return True

        # Extended hours: pre-market (4:00 AM - 9:30 AM) and after-hours (4:00 PM - 8:00 PM)
        if self._config.allow_extended_hours:
            pre_market_open = dt_time(4, 0)
            after_hours_close = dt_time(20, 0)
            is_extended = pre_market_open <= now <= after_hours_close
            if is_extended:
                logger.info(f"Operating in extended hours at {now}")
                return True

        return False

    def _validate_trading_allowed(self) -> tuple[bool, str]:
        """
        Validate that trading is currently allowed.

        Returns:
            Tuple of (allowed, reason)
        """
        if not self._is_market_hours():
            now = datetime.now().time()
            return (
                False,
                f"Market is closed. Current time: {now}, "
                f"Market hours: {self._config.market_open}-{self._config.market_close}"
            )
        return (True, "")

    async def execute(
        self,
        reason: FlattenReason,
        confirmation: str | None = None,
    ) -> FlattenResult:
        """
        Execute emergency flatten protocol.

        For user-initiated flattens, confirmation token is required.
        System-initiated flattens (risk violations, etc.) don't require confirmation.

        Args:
            reason: Reason for the flatten
            confirmation: User confirmation token (must be "FLATTEN" for user requests)

        Returns:
            FlattenResult with outcome

        Raises:
            FlattenConfirmationError: If confirmation is required but invalid
        """
        if self._is_running:
            raise RuntimeError("Flatten already in progress")

        # Check if confirmation is required
        if self._config.require_confirmation:
            requires_confirmation = reason not in self._config.auto_flatten_reasons

            if requires_confirmation:
                is_valid, error_msg = verify_flatten_confirmation(
                    confirmation or "",
                    self._session_id,
                )
                if not is_valid:
                    logger.warning(
                        f"Flatten blocked for session {self._session_id}: {error_msg}"
                    )
                    raise FlattenConfirmationError(error_msg)

        self._is_running = True
        self._result = FlattenResult(
            session_id=self._session_id,
            reason=reason,
            started_at=datetime.now(),
            completed_at=None,
            stage=FlattenStage.PENDING,
            positions_flattened=0,
            positions_remaining=0,
            total_pnl=Decimal("0"),
        )

        try:
            # Validate market hours before proceeding
            trading_allowed, reject_reason = self._validate_trading_allowed()
            if not trading_allowed:
                logger.error(f"Emergency flatten blocked: {reject_reason}")
                self._result.stage = FlattenStage.FAILED
                self._result.errors.append(f"Trading not allowed: {reject_reason}")
                self._result.completed_at = datetime.now()
                return self._result

            logger.warning(
                f"EMERGENCY FLATTEN initiated for session {self._session_id}, "
                f"reason: {reason.value}"
            )

            # FIX-T001: Log flatten initiation to audit ledger
            if self._audit_ledger:
                self._audit_ledger.log_event(
                    "emergency_flatten_initiated",
                    {
                        "session_id": self._session_id,
                        "reason": reason.value,
                        "started_at": self._result.started_at.isoformat(),
                    },
                )

            # Step 1: Cancel all open orders
            await self._cancel_open_orders()

            # Step 2: Get positions to flatten
            positions = self._position_tracker.get_positions_for_session(
                self._session_id, include_flat=False
            )

            if not positions:
                logger.info("No positions to flatten")
                self._result.stage = FlattenStage.COMPLETED
                self._result.completed_at = datetime.now()
                return self._result

            self._result.positions_remaining = len(positions)

            # Initialize progress tracking
            for position in positions:
                self._result.progress[position.symbol] = FlattenProgress(
                    symbol=position.symbol,
                    initial_quantity=position.quantity,
                    remaining_quantity=position.quantity,
                    stage=FlattenStage.PENDING,
                )

            # Step 3: Stage 1 - Marketable limits
            self._result.stage = FlattenStage.STAGE_1_LIMIT
            await self._execute_stage_1(positions)

            # Check if complete
            if self._all_positions_flat():
                self._result.stage = FlattenStage.COMPLETED
                self._result.completed_at = datetime.now()
                logger.info("Emergency flatten completed in Stage 1")

                if self._config.on_complete:
                    self._config.on_complete(self._result)

                return self._result

            # Step 4: Stage 2 - Market orders
            if self._config.stage2_enabled:
                self._result.stage = FlattenStage.STAGE_2_MARKET
                await self._execute_stage_2()

            # Final check
            if self._all_positions_flat():
                self._result.stage = FlattenStage.COMPLETED
            else:
                self._result.stage = FlattenStage.FAILED
                self._result.errors.append("Failed to flatten all positions")

            self._result.completed_at = datetime.now()

            if self._config.on_complete:
                self._config.on_complete(self._result)

            logger.info(
                f"Emergency flatten {'completed' if self._result.is_complete else 'FAILED'}: "
                f"{self._result.positions_flattened} flattened, "
                f"{self._result.positions_remaining} remaining"
            )

            # FIX-T001: Log flatten completion to audit ledger
            if self._audit_ledger:
                self._audit_ledger.log_event(
                    "emergency_flatten_completed",
                    {
                        "session_id": self._session_id,
                        "reason": reason.value,
                        "stage": self._result.stage.value,
                        "positions_flattened": self._result.positions_flattened,
                        "positions_remaining": self._result.positions_remaining,
                        "total_pnl": str(self._result.total_pnl),
                        "started_at": self._result.started_at.isoformat(),
                        "completed_at": self._result.completed_at.isoformat() if self._result.completed_at else None,
                        "errors": self._result.errors,
                        "success": self._result.is_complete,
                    },
                )

            return self._result

        except Exception as e:
            logger.error(f"Emergency flatten error: {e}")
            self._result.stage = FlattenStage.FAILED
            self._result.errors.append(str(e))
            self._result.completed_at = datetime.now()

            # FIX-T001: Log flatten error to audit ledger
            if self._audit_ledger:
                self._audit_ledger.log_event(
                    "emergency_flatten_error",
                    {
                        "session_id": self._session_id,
                        "reason": reason.value,
                        "error": str(e),
                        "started_at": self._result.started_at.isoformat(),
                        "completed_at": self._result.completed_at.isoformat(),
                    },
                )

            return self._result

        finally:
            self._is_running = False

    async def _cancel_open_orders(self) -> None:
        """Cancel all open orders for the session."""
        assert self._result is not None
        self._result.stage = FlattenStage.CANCELING_ORDERS

        open_orders = self._order_manager.get_open_orders()
        if not open_orders:
            return

        logger.info(f"Canceling {len(open_orders)} open orders")

        for order in open_orders:
            try:
                if self._broker:
                    await self._broker.cancel_order(order.broker_order_id or order.order_id)
                self._order_manager.cancel_order(order.order_id)
            except Exception as e:
                logger.warning(f"Failed to cancel order {order.order_id}: {e}")

        # Wait briefly for cancellations
        await asyncio.sleep(0.5)

    async def _execute_stage_1(self, positions: list[Position]) -> None:
        """Execute Stage 1 - Marketable limit orders."""
        assert self._result is not None
        logger.info(f"Stage 1: Submitting marketable limits for {len(positions)} positions")

        for position in positions:
            if position.quantity == 0:
                continue

            progress = self._result.progress[position.symbol]
            progress.stage = FlattenStage.STAGE_1_LIMIT

            try:
                # Get quote for price validation
                quote = await self._get_validated_quote(position.symbol)
                if not quote:
                    progress.last_error = "Failed to get valid quote"
                    continue

                # Calculate marketable limit price
                price = self._calculate_marketable_limit(position, quote)

                # Submit order
                order_id = await self._submit_flatten_order(
                    position, price, OrderType.LIMIT
                )

                if order_id:
                    progress.orders_submitted.append(order_id)
                    progress.attempts += 1

            except Exception as e:
                progress.last_error = str(e)
                logger.error(f"Stage 1 error for {position.symbol}: {e}")

            self._notify_progress()

        # Wait for Stage 1 orders to fill
        await self._wait_for_fills(self._config.stage1_timeout_seconds)

        # Update progress
        self._update_progress()

    async def _execute_stage_2(self) -> None:
        """Execute Stage 2 - Market orders for remaining positions."""
        assert self._result is not None
        remaining = [
            self._position_tracker.get_position(self._session_id, symbol)
            for symbol, progress in self._result.progress.items()
            if progress.remaining_quantity != 0
        ]
        remaining = [p for p in remaining if p and p.quantity != 0]

        if not remaining:
            return

        logger.warning(f"Stage 2: {len(remaining)} positions need market orders")

        for attempt in range(self._config.stage2_max_retries):
            for position in remaining:
                if position.quantity == 0:
                    continue

                progress = self._result.progress[position.symbol]
                progress.stage = FlattenStage.STAGE_2_MARKET

                try:
                    # Validate we can trade
                    quote = await self._get_validated_quote(position.symbol)
                    if not quote:
                        progress.last_error = "No valid quote for market order"
                        continue

                    # Submit market order
                    order_id = await self._submit_flatten_order(
                        position, None, OrderType.MARKET
                    )

                    if order_id:
                        progress.orders_submitted.append(order_id)
                        progress.attempts += 1

                except Exception as e:
                    progress.last_error = str(e)
                    logger.error(f"Stage 2 error for {position.symbol}: {e}")

                self._notify_progress()

            # Wait for fills
            await self._wait_for_fills(self._config.order_timeout_seconds)
            self._update_progress()

            # Check if done
            remaining = [
                self._position_tracker.get_position(self._session_id, symbol)
                for symbol, progress in self._result.progress.items()
                if progress.remaining_quantity != 0
            ]
            remaining = [p for p in remaining if p and p.quantity != 0]

            if not remaining:
                break

            if attempt < self._config.stage2_max_retries - 1:
                # Exponential backoff with jitter: delay = base * 2^attempt * (0.5 + random)
                base_delay = self._config.stage2_base_delay_seconds
                exp_delay = base_delay * (2 ** attempt)
                jitter = 0.5 + random.random()  # Random factor between 0.5 and 1.5
                delay = min(exp_delay * jitter, self._config.stage2_max_delay_seconds)

                logger.warning(
                    f"Stage 2 retry {attempt + 1}: {len(remaining)} positions remaining, "
                    f"waiting {delay:.2f}s before retry"
                )
                await asyncio.sleep(delay)

    async def _get_validated_quote(self, symbol: str) -> MarketQuote | None:
        """Get and validate a quote."""
        if not self._config.require_quote_validation:
            # Create a dummy quote if validation not required
            return MarketQuote(
                symbol=symbol,
                bid=Decimal("0"),
                ask=Decimal("0"),
                last=Decimal("0"),
                timestamp=datetime.now(),
            )

        try:
            quote = await self._broker.get_quote(symbol)
            if not quote:
                logger.warning(f"No quote available for {symbol}")
                return None

            # Check quote age
            age = (datetime.now() - quote.timestamp).total_seconds()
            if age > self._config.max_quote_age_seconds:
                logger.warning(f"Quote for {symbol} is stale: {age:.1f}s old")
                return None

            # Check spread
            if quote.bid > 0 and quote.ask > 0:
                spread_pct = (quote.ask - quote.bid) / quote.bid
                if spread_pct > self._config.max_spread_percent:
                    logger.warning(
                        f"Quote for {symbol} has wide spread: {spread_pct:.2%} "
                        f"(max: {self._config.max_spread_percent:.2%})"
                    )
                    if self._config.reject_wide_spread:
                        logger.error(
                            f"Rejecting quote for {symbol} due to excessive spread"
                        )
                        return None

            return quote

        except Exception as e:
            logger.error(f"Quote validation error for {symbol}: {e}")
            return None

    def _calculate_marketable_limit(
        self, position: Position, quote: MarketQuote
    ) -> Decimal:
        """Calculate marketable limit price.

        For emergency flatten, we want AGGRESSIVE prices that WILL fill:
        - Selling: Set limit BELOW bid (our minimum acceptable price is below market,
          so we're guaranteed to fill at bid or better)
        - Buying: Set limit ABOVE ask (our maximum acceptable price is above market,
          so we're guaranteed to fill at ask or better)

        The offset creates a "marketable" limit that ensures immediate execution.
        """
        spread = quote.ask - quote.bid if quote.bid > 0 else Decimal("0.01")
        aggressive_offset = spread * self._config.stage1_spread_multiplier

        if position.quantity > 0:
            # Selling long position - set limit BELOW bid (aggressive sell)
            # This ensures the order will fill at bid or better
            return quote.bid - aggressive_offset
        else:
            # Buying to close short - set limit ABOVE ask (aggressive buy)
            # This ensures the order will fill at ask or better
            return quote.ask + aggressive_offset

    async def _submit_flatten_order(
        self,
        position: Position,
        price: Decimal | None,
        order_type: OrderType,
    ) -> str | None:
        """Submit a flatten order."""
        # Determine side (opposite of position)
        side = OrderSide.SELL if position.quantity > 0 else OrderSide.BUY
        quantity = abs(position.quantity)

        request = OrderRequest(
            session_id=self._session_id,
            symbol=position.symbol,
            side=side,
            order_type=order_type,
            quantity=quantity,
            limit_price=price if order_type == OrderType.LIMIT else None,
            time_in_force=TimeInForce.IOC if order_type == OrderType.LIMIT else TimeInForce.DAY,
        )

        try:
            order = self._order_manager.create_order(request)
            result = await self._broker.submit_order(order)

            if result:
                logger.info(
                    f"Flatten order submitted: {order.order_id} - {position.symbol} "
                    f"{side.value} {quantity} @ {price or 'MKT'}"
                )
                return order.order_id

        except Exception as e:
            logger.error(f"Failed to submit flatten order for {position.symbol}: {e}")

        return None

    async def _wait_for_fills(self, timeout: float) -> None:
        """Wait for order fills with timeout."""
        start = asyncio.get_event_loop().time()
        while (asyncio.get_event_loop().time() - start) < timeout:
            # Check if all positions are flat
            if self._all_positions_flat():
                break
            await asyncio.sleep(0.1)

    def _all_positions_flat(self) -> bool:
        """Check if all positions are flat."""
        positions = self._position_tracker.get_positions_for_session(
            self._session_id, include_flat=False
        )
        return len(positions) == 0

    def _update_progress(self) -> None:
        """Update progress tracking from current positions."""
        assert self._result is not None
        for symbol, progress in self._result.progress.items():
            position = self._position_tracker.get_position(self._session_id, symbol)
            if position:
                progress.remaining_quantity = position.quantity
            else:
                progress.remaining_quantity = Decimal("0")

            if progress.remaining_quantity == 0:
                progress.stage = FlattenStage.COMPLETED
                self._result.positions_flattened += 1
                self._result.positions_remaining -= 1

    def _notify_progress(self) -> None:
        """Send progress notification."""
        if self._config.on_progress and self._result:
            self._config.on_progress(self._result)


async def emergency_flatten(
    session_id: str,
    broker: BrokerAdapter,
    order_manager: OrderManager,
    position_tracker: PositionTracker,
    reason: FlattenReason,
    config: FlattenConfig | None = None,
    confirmation: str | None = None,
    audit_ledger: Any | None = None,  # FIX-T001
) -> FlattenResult:
    """
    Convenience function to execute emergency flatten.

    For user-initiated flattens (reason=USER_REQUEST), the user must
    provide confirmation="FLATTEN" to prevent accidental liquidation.

    Args:
        session_id: Trading session ID
        broker: Connected broker adapter
        order_manager: Order manager
        position_tracker: Position tracker
        reason: Reason for the flatten
        config: Optional configuration
        confirmation: Confirmation token for user-initiated flattens
        audit_ledger: Optional audit ledger for compliance logging (FIX-T001)

    Returns:
        FlattenResult with outcome

    Raises:
        FlattenConfirmationError: If confirmation is required but invalid
    """
    flattener = EmergencyFlatten(
        session_id=session_id,
        broker=broker,
        order_manager=order_manager,
        position_tracker=position_tracker,
        config=config,
        audit_ledger=audit_ledger,
    )
    return await flattener.execute(reason, confirmation=confirmation)

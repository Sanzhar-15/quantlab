"""
Portfolio Limits.

Enforces position limits, exposure limits, and buying power constraints.

Spec Reference: Technical Spec §4.5
"""

from dataclasses import dataclass
from dataclasses import field
from decimal import Decimal
from enum import Enum
from typing import Any

from quantlab.portfolio.state import PortfolioState


class LimitType(Enum):
    """Types of portfolio limits."""

    MAX_POSITION_SIZE = "max_position_size"  # Max shares per symbol
    POSITION_SIZE = "max_position_size"  # Alias for test compatibility
    MAX_POSITION_VALUE = "max_position_value"  # Max $ per symbol
    MAX_POSITION_PCT = "max_position_pct"  # Max % of equity per symbol
    MAX_GROSS_EXPOSURE = "max_gross_exposure"  # Max total exposure
    MAX_NET_EXPOSURE = "max_net_exposure"  # Max net long/short
    MAX_LONG_EXPOSURE = "max_long_exposure"  # Max long exposure
    MAX_SHORT_EXPOSURE = "max_short_exposure"  # Max short exposure
    MAX_SECTOR_EXPOSURE = "max_sector_exposure"  # Max per sector
    MIN_CASH = "min_cash"  # Minimum cash reserve
    MAX_LEVERAGE = "max_leverage"  # Max leverage ratio


@dataclass
class LimitViolation:
    """Record of a limit violation."""

    limit_type: LimitType
    message: str
    symbol: str | None = None
    limit_value: Decimal = Decimal("0")
    actual_value: Decimal = Decimal("0")
    excess: Decimal = Decimal("0")

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "limit_type": self.limit_type.value,
            "message": self.message,
            "symbol": self.symbol,
            "limit_value": str(self.limit_value),
            "actual_value": str(self.actual_value),
            "excess": str(self.excess),
        }


@dataclass
class LimitCheckResult:
    """Result of a limit check."""

    allowed: bool
    reason: str = ""
    violations: list[LimitViolation] = field(default_factory=list)
    max_allowed_quantity: Decimal | None = None


@dataclass
class PositionLimits:
    """Position-level limits."""

    max_shares: Decimal | None = None  # Max shares per position
    max_value: Decimal | None = None  # Max $ per position
    max_pct_equity: Decimal = Decimal("0.25")  # 25% default
    max_pct_adv: Decimal = Decimal("0.10")  # 10% of avg daily volume
    # Test-compatible aliases
    max_position_size: Decimal | None = None  # Alias for max_shares
    max_notional: Decimal | None = None  # Alias for max_value
    max_concentration: Decimal | None = None  # Alias for max_pct_equity

    def __post_init__(self) -> None:
        """Apply aliases if set."""
        if self.max_position_size is not None and self.max_shares is None:
            self.max_shares = self.max_position_size
        if self.max_notional is not None and self.max_value is None:
            self.max_value = self.max_notional
        if self.max_concentration is not None:
            self.max_pct_equity = self.max_concentration


@dataclass
class PortfolioLimits:
    """Portfolio-level limits."""

    max_gross_exposure: Decimal = Decimal("2.0")  # 200% = 2x leverage
    max_net_exposure: Decimal = Decimal("1.0")  # 100%
    max_long_exposure: Decimal = Decimal("1.5")  # 150%
    max_short_exposure: Decimal = Decimal("0.5")  # 50%
    max_leverage: Decimal = Decimal("2.0")  # 2x
    min_cash: Decimal = Decimal("0")  # No minimum by default
    min_cash_pct: Decimal = Decimal("0.05")  # 5% cash reserve


class LimitsEnforcer:
    """
    Enforce portfolio limits.

    Checks all limits before allowing trades.
    """

    def __init__(
        self,
        position_limits: PositionLimits | None = None,
        portfolio_limits: PortfolioLimits | None = None,
    ) -> None:
        """
        Initialize limits enforcer.

        Args:
            position_limits: Position-level limits
            portfolio_limits: Portfolio-level limits
        """
        self.position_limits = position_limits or PositionLimits()
        self.portfolio_limits = portfolio_limits or PortfolioLimits()

        # Symbol-specific overrides
        self._symbol_limits: dict[str, PositionLimits] = {}
        self._symbol_adv: dict[str, Decimal] = {}  # Average daily volume

    def set_symbol_limits(
        self,
        symbol: str,
        limits: PositionLimits,
    ) -> None:
        """Set limits for a specific symbol."""
        self._symbol_limits[symbol] = limits

    def set_symbol_adv(self, symbol: str, adv: Decimal) -> None:
        """Set average daily volume for a symbol."""
        self._symbol_adv[symbol] = adv

    def get_position_limits(self, symbol: str) -> PositionLimits:
        """Get position limits for a symbol."""
        return self._symbol_limits.get(symbol, self.position_limits)

    def check_limits(
        self,
        symbol: str,
        quantity: Decimal,
        price: Decimal,
        portfolio_value: Decimal,
    ) -> LimitCheckResult:
        """
        Check if a trade would violate limits (test-compatible signature).

        Args:
            symbol: Security symbol
            quantity: Trade quantity
            price: Trade price
            portfolio_value: Total portfolio value/equity

        Returns:
            LimitCheckResult with allowed status and violations
        """
        violations: list[LimitViolation] = []
        order_value = quantity * price

        # Check position size limit
        if self.position_limits.max_shares is not None:
            if quantity > self.position_limits.max_shares:
                violations.append(LimitViolation(
                    limit_type=LimitType.MAX_POSITION_SIZE,
                    message=f"Position size {quantity} exceeds limit {self.position_limits.max_shares}",
                    symbol=symbol,
                    limit_value=self.position_limits.max_shares,
                    actual_value=quantity,
                    excess=quantity - self.position_limits.max_shares,
                ))

        # Check notional limit
        if self.position_limits.max_value is not None:
            if order_value > self.position_limits.max_value:
                violations.append(LimitViolation(
                    limit_type=LimitType.MAX_POSITION_VALUE,
                    message=f"Notional value ${order_value} exceeds limit ${self.position_limits.max_value}",
                    symbol=symbol,
                    limit_value=self.position_limits.max_value,
                    actual_value=order_value,
                    excess=order_value - self.position_limits.max_value,
                ))

        # Check concentration limit
        if portfolio_value > Decimal("0"):
            concentration = order_value / portfolio_value
            if concentration > self.position_limits.max_pct_equity:
                violations.append(LimitViolation(
                    limit_type=LimitType.MAX_POSITION_PCT,
                    message=f"Concentration {concentration:.1%} exceeds limit {self.position_limits.max_pct_equity:.0%}",
                    symbol=symbol,
                    limit_value=self.position_limits.max_pct_equity,
                    actual_value=concentration,
                    excess=concentration - self.position_limits.max_pct_equity,
                ))

        return LimitCheckResult(
            allowed=len(violations) == 0,
            reason="; ".join(v.message for v in violations) if violations else "",
            violations=violations,
        )

    def check_order(
        self,
        state: PortfolioState,
        symbol: str,
        quantity: Decimal,  # Positive for buy, negative for sell
        price: Decimal,
    ) -> LimitCheckResult:
        """
        Check if an order would violate any limits.

        Args:
            state: Current portfolio state
            symbol: Order symbol
            quantity: Order quantity (signed)
            price: Order price

        Returns:
            LimitCheckResult with allowed status and any violations
        """
        violations: list[LimitViolation] = []

        # Get current position
        current_qty = state.get_quantity(symbol)
        new_qty = current_qty + quantity
        new_value = abs(new_qty) * price

        # FIX-R004: Check transaction (single trade) concentration separately
        # This ensures no single trade is too large relative to equity
        if state.equity > Decimal("0"):
            transaction_value = abs(quantity) * price
            transaction_pct = transaction_value / state.equity
            max_single_trade_pct = getattr(
                self.position_limits, 'max_single_trade_pct_equity', Decimal("0.10")
            )
            if transaction_pct > max_single_trade_pct:
                violations.append(LimitViolation(
                    limit_type=LimitType.MAX_POSITION_PCT,  # Reuse type
                    message=f"Single trade {transaction_pct:.1%} of equity exceeds limit {max_single_trade_pct:.0%}",
                    symbol=symbol,
                    limit_value=max_single_trade_pct,
                    actual_value=transaction_pct,
                    excess=transaction_pct - max_single_trade_pct,
                ))

        # Check position limits
        pos_violations = self._check_position_limits(
            symbol, new_qty, new_value, state.equity,
        )
        violations.extend(pos_violations)

        # Check portfolio limits
        port_violations = self._check_portfolio_limits(
            state, symbol, quantity, price,
        )
        violations.extend(port_violations)

        allowed = len(violations) == 0
        reason = ""
        if not allowed:
            reason = "; ".join(v.message for v in violations)

        return LimitCheckResult(
            allowed=allowed,
            reason=reason,
            violations=violations,
        )

    def _check_position_limits(
        self,
        symbol: str,
        new_quantity: Decimal,
        new_value: Decimal,
        equity: Decimal,
    ) -> list[LimitViolation]:
        """Check position-level limits."""
        violations = []
        limits = self.get_position_limits(symbol)

        # Check max shares
        if limits.max_shares is not None:
            if abs(new_quantity) > limits.max_shares:
                violations.append(LimitViolation(
                    limit_type=LimitType.MAX_POSITION_SIZE,
                    message=f"Position size exceeds max shares: {abs(new_quantity)} > {limits.max_shares}",
                    symbol=symbol,
                    limit_value=limits.max_shares,
                    actual_value=abs(new_quantity),
                    excess=abs(new_quantity) - limits.max_shares,
                ))

        # Check max value
        if limits.max_value is not None:
            if new_value > limits.max_value:
                violations.append(LimitViolation(
                    limit_type=LimitType.MAX_POSITION_VALUE,
                    message=f"Position value exceeds max: ${new_value} > ${limits.max_value}",
                    symbol=symbol,
                    limit_value=limits.max_value,
                    actual_value=new_value,
                    excess=new_value - limits.max_value,
                ))

        # Check max percentage of equity
        if equity > Decimal("0"):
            pct = new_value / equity
            if pct > limits.max_pct_equity:
                violations.append(LimitViolation(
                    limit_type=LimitType.MAX_POSITION_PCT,
                    message=f"Position exceeds {limits.max_pct_equity * 100}% of equity",
                    symbol=symbol,
                    limit_value=limits.max_pct_equity,
                    actual_value=pct,
                    excess=pct - limits.max_pct_equity,
                ))

        # Check ADV limit
        if symbol in self._symbol_adv and limits.max_pct_adv is not None:
            adv = self._symbol_adv[symbol]
            if adv > Decimal("0"):
                pct_adv = abs(new_quantity) / adv
                if pct_adv > limits.max_pct_adv:
                    violations.append(LimitViolation(
                        limit_type=LimitType.MAX_POSITION_SIZE,
                        message=f"Position exceeds {limits.max_pct_adv * 100}% of ADV",
                        symbol=symbol,
                        limit_value=limits.max_pct_adv,
                        actual_value=pct_adv,
                        excess=pct_adv - limits.max_pct_adv,
                    ))

        return violations

    def _check_portfolio_limits(
        self,
        state: PortfolioState,
        symbol: str,
        quantity: Decimal,
        price: Decimal,
    ) -> list[LimitViolation]:
        """Check portfolio-level limits."""
        violations = []
        limits = self.portfolio_limits

        # Calculate post-trade exposure
        equity = state.equity
        if equity <= Decimal("0"):
            return violations

        order_value = quantity * price  # Signed
        current_qty = state.get_quantity(symbol)

        # Calculate new exposures
        new_long = state.long_value
        new_short = state.short_value

        if quantity > Decimal("0"):  # Buy
            if current_qty < Decimal("0"):  # Covering short
                cover_value = min(abs(quantity), abs(current_qty)) * price
                new_short -= cover_value
                remaining = quantity - abs(current_qty)
                if remaining > Decimal("0"):  # New long
                    new_long += remaining * price
            else:  # Adding to long
                new_long += abs(quantity) * price
        else:  # Sell
            if current_qty > Decimal("0"):  # Selling long
                sell_value = min(abs(quantity), current_qty) * price
                new_long -= sell_value
                remaining = abs(quantity) - current_qty
                if remaining > Decimal("0"):  # New short
                    new_short += remaining * price
            else:  # Adding to short
                new_short += abs(quantity) * price

        new_gross = new_long + new_short
        new_net = new_long - new_short

        # Check gross exposure
        gross_pct = new_gross / equity
        if gross_pct > limits.max_gross_exposure:
            violations.append(LimitViolation(
                limit_type=LimitType.MAX_GROSS_EXPOSURE,
                message=f"Gross exposure would exceed limit: {gross_pct:.1%} > {limits.max_gross_exposure:.0%}",
                limit_value=limits.max_gross_exposure,
                actual_value=gross_pct,
                excess=gross_pct - limits.max_gross_exposure,
            ))

        # Check net exposure
        net_pct = abs(new_net) / equity
        if net_pct > limits.max_net_exposure:
            violations.append(LimitViolation(
                limit_type=LimitType.MAX_NET_EXPOSURE,
                message=f"Net exposure would exceed limit: {net_pct:.1%} > {limits.max_net_exposure:.0%}",
                limit_value=limits.max_net_exposure,
                actual_value=net_pct,
                excess=net_pct - limits.max_net_exposure,
            ))

        # Check long exposure
        long_pct = new_long / equity
        if long_pct > limits.max_long_exposure:
            violations.append(LimitViolation(
                limit_type=LimitType.MAX_LONG_EXPOSURE,
                message=f"Long exposure would exceed limit: {long_pct:.1%}",
                limit_value=limits.max_long_exposure,
                actual_value=long_pct,
                excess=long_pct - limits.max_long_exposure,
            ))

        # Check short exposure
        short_pct = new_short / equity
        if short_pct > limits.max_short_exposure:
            violations.append(LimitViolation(
                limit_type=LimitType.MAX_SHORT_EXPOSURE,
                message=f"Short exposure would exceed limit: {short_pct:.1%}",
                limit_value=limits.max_short_exposure,
                actual_value=short_pct,
                excess=short_pct - limits.max_short_exposure,
            ))

        # Check cash reserve
        if quantity > Decimal("0"):  # Buying uses cash
            cash_after = state.cash - abs(order_value)
            if cash_after < limits.min_cash:
                violations.append(LimitViolation(
                    limit_type=LimitType.MIN_CASH,
                    message=f"Cash would fall below minimum: ${cash_after} < ${limits.min_cash}",
                    limit_value=limits.min_cash,
                    actual_value=cash_after,
                    excess=limits.min_cash - cash_after,
                ))

            min_cash_required = equity * limits.min_cash_pct
            if cash_after < min_cash_required:
                violations.append(LimitViolation(
                    limit_type=LimitType.MIN_CASH,
                    message=f"Cash would fall below {limits.min_cash_pct:.0%} reserve",
                    limit_value=min_cash_required,
                    actual_value=cash_after,
                    excess=min_cash_required - cash_after,
                ))

        return violations

    def calculate_max_quantity(
        self,
        state: PortfolioState,
        symbol: str,
        price: Decimal,
        is_buy: bool,
    ) -> Decimal:
        """
        Calculate maximum allowed quantity for an order.

        Args:
            state: Current portfolio state
            symbol: Order symbol
            price: Order price
            is_buy: True for buy, False for sell

        Returns:
            Maximum allowed quantity (0 if no orders allowed)
        """
        limits = self.get_position_limits(symbol)
        equity = state.equity

        if equity <= Decimal("0") or price <= Decimal("0"):
            return Decimal("0")

        current_qty = state.get_quantity(symbol)
        max_qty = Decimal("999999999")  # Start with large number

        if is_buy:
            # Position size limits
            if limits.max_shares is not None:
                max_by_shares = limits.max_shares - max(current_qty, Decimal("0"))
                max_qty = min(max_qty, max_by_shares)

            if limits.max_value is not None:
                current_value = max(current_qty, Decimal("0")) * price
                max_by_value = (limits.max_value - current_value) / price
                max_qty = min(max_qty, max_by_value)

            if limits.max_pct_equity is not None:
                max_value = equity * limits.max_pct_equity
                current_value = max(current_qty, Decimal("0")) * price
                max_by_pct = (max_value - current_value) / price
                max_qty = min(max_qty, max_by_pct)

            # Cash limit
            available_cash = state.cash - equity * self.portfolio_limits.min_cash_pct
            max_by_cash = available_cash / price
            max_qty = min(max_qty, max_by_cash)

            # Long exposure limit
            remaining_long = (
                equity * self.portfolio_limits.max_long_exposure - state.long_value
            )
            max_by_long = remaining_long / price
            max_qty = min(max_qty, max_by_long)

        else:  # Sell
            # Can always sell what we own
            max_qty = current_qty

            # For shorting, check short limits
            if current_qty <= Decimal("0"):
                remaining_short = (
                    equity * self.portfolio_limits.max_short_exposure - state.short_value
                )
                max_by_short = remaining_short / price
                max_qty = min(max_qty, max_by_short)

        return max(max_qty, Decimal("0"))


class BuyingPowerCalculator:
    """
    Calculate available buying power.

    Takes into account cash, margin, and existing positions.
    """

    def __init__(
        self,
        margin_multiplier: Decimal = Decimal("2.0"),  # 2x margin
        overnight_multiplier: Decimal = Decimal("2.0"),
        intraday_multiplier: Decimal = Decimal("4.0"),  # PDT accounts
    ) -> None:
        self.margin_multiplier = margin_multiplier
        self.overnight_multiplier = overnight_multiplier
        self.intraday_multiplier = intraday_multiplier

    def calculate(self, state: PortfolioState) -> Decimal:
        """
        Calculate available buying power (test-compatible signature).

        For simple mode (no margin), returns available cash.
        """
        # Simple buying power = available cash
        return state.cash

    def calculate_buying_power(
        self,
        state: PortfolioState,
        is_intraday: bool = False,
    ) -> Decimal:
        """
        Calculate available buying power.

        Args:
            state: Current portfolio state
            is_intraday: True for intraday trading (higher multiplier)

        Returns:
            Available buying power in dollars
        """
        multiplier = self.intraday_multiplier if is_intraday else self.overnight_multiplier

        # Simple calculation: equity * multiplier - current_exposure
        gross_exposure = state.gross_exposure
        max_exposure = state.equity * multiplier
        available = max_exposure - gross_exposure

        return max(available, Decimal("0"))

    def calculate_short_selling_power(
        self,
        state: PortfolioState,
        short_ratio: Decimal = Decimal("0.5"),  # 50% of equity
    ) -> Decimal:
        """
        Calculate available short selling power.

        Args:
            state: Current portfolio state
            short_ratio: Max short as ratio of equity

        Returns:
            Available short selling power in dollars
        """
        max_short = state.equity * short_ratio
        current_short = state.short_value
        available = max_short - current_short

        return max(available, Decimal("0"))

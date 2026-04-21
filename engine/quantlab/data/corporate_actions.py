"""
Corporate Actions Handling.

Provides detection, storage, and adjustment of corporate actions including:
- Stock splits (forward and reverse)
- Cash dividends
- Stock dividends
- Mergers and acquisitions
- Spin-offs
- Ticker/name changes

The module supports three modes:
1. Detection: Identify potential corporate actions from price patterns
2. Adjustment: Apply adjustments when corporate actions data is provided
3. Validation: Warn about suspected unadjusted data

Design Philosophy:
- Prefer adjusted data from source (most accurate)
- Detect and warn about unadjusted data patterns
- Support manual corporate actions input for adjustment
- Never silently produce incorrect results

Spec Reference: Technical Spec §5.3 (Data Quality)
"""

import logging
import math
from dataclasses import dataclass
from dataclasses import field
from datetime import date
from datetime import datetime
from decimal import Decimal
from enum import Enum
from typing import Any
from typing import Sequence

logger = logging.getLogger(__name__)


class CorporateActionType(Enum):
    """Types of corporate actions."""

    SPLIT = "split"  # Stock split (forward or reverse)
    CASH_DIVIDEND = "cash_dividend"  # Cash dividend
    STOCK_DIVIDEND = "stock_dividend"  # Stock dividend (shares)
    MERGER = "merger"  # Merger/acquisition
    SPINOFF = "spinoff"  # Spin-off
    TICKER_CHANGE = "ticker_change"  # Ticker symbol change
    RIGHTS_ISSUE = "rights_issue"  # Rights offering


@dataclass
class CorporateAction:
    """
    A corporate action event.

    Attributes:
        action_type: Type of corporate action
        symbol: Stock symbol (pre-action)
        effective_date: Date action takes effect
        ratio_numerator: For splits/dividends, the numerator (e.g., 2 for 2:1)
        ratio_denominator: For splits/dividends, the denominator (e.g., 1 for 2:1)
        cash_amount: For cash dividends, amount per share
        new_symbol: For mergers/ticker changes, the new symbol
        description: Human-readable description
    """

    action_type: CorporateActionType
    symbol: str
    effective_date: date
    ratio_numerator: Decimal = Decimal("1")
    ratio_denominator: Decimal = Decimal("1")
    cash_amount: Decimal = Decimal("0")
    new_symbol: str | None = None
    description: str = ""

    @property
    def adjustment_factor(self) -> Decimal:
        """
        Get the price adjustment factor.

        For splits: multiply old prices by this to get adjusted prices.
        For a 2:1 split, factor is 0.5 (prices halve).
        For a 1:10 reverse split, factor is 10 (prices increase 10x).
        """
        if self.ratio_denominator == Decimal("0"):
            return Decimal("1")
        return self.ratio_denominator / self.ratio_numerator

    @property
    def volume_adjustment_factor(self) -> Decimal:
        """
        Get the volume adjustment factor.

        Inverse of price adjustment - volumes increase when prices decrease.
        """
        if self.ratio_numerator == Decimal("0"):
            return Decimal("1")
        return self.ratio_numerator / self.ratio_denominator

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "action_type": self.action_type.value,
            "symbol": self.symbol,
            "effective_date": self.effective_date.isoformat(),
            "ratio_numerator": str(self.ratio_numerator),
            "ratio_denominator": str(self.ratio_denominator),
            "cash_amount": str(self.cash_amount),
            "new_symbol": self.new_symbol,
            "description": self.description,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CorporateAction":
        """Create from dictionary."""
        return cls(
            action_type=CorporateActionType(data["action_type"]),
            symbol=data["symbol"],
            effective_date=date.fromisoformat(data["effective_date"]),
            ratio_numerator=Decimal(str(data.get("ratio_numerator", 1))),
            ratio_denominator=Decimal(str(data.get("ratio_denominator", 1))),
            cash_amount=Decimal(str(data.get("cash_amount", 0))),
            new_symbol=data.get("new_symbol"),
            description=data.get("description", ""),
        )

    @classmethod
    def split(
        cls,
        symbol: str,
        effective_date: date,
        ratio: str,
        description: str = "",
    ) -> "CorporateAction":
        """
        Create a stock split action.

        Args:
            symbol: Stock symbol
            effective_date: Date split takes effect
            ratio: Split ratio as string (e.g., "2:1", "3:2", "1:10")
            description: Optional description

        Returns:
            CorporateAction for the split
        """
        parts = ratio.split(":")
        if len(parts) != 2:
            raise ValueError(f"Invalid split ratio format: {ratio}. Use 'X:Y' format.")

        numerator = Decimal(parts[0].strip())
        denominator = Decimal(parts[1].strip())

        return cls(
            action_type=CorporateActionType.SPLIT,
            symbol=symbol,
            effective_date=effective_date,
            ratio_numerator=numerator,
            ratio_denominator=denominator,
            description=description or f"{numerator}:{denominator} split",
        )

    @classmethod
    def cash_dividend(
        cls,
        symbol: str,
        effective_date: date,
        amount: Decimal | str,
        description: str = "",
    ) -> "CorporateAction":
        """Create a cash dividend action."""
        return cls(
            action_type=CorporateActionType.CASH_DIVIDEND,
            symbol=symbol,
            effective_date=effective_date,
            cash_amount=Decimal(str(amount)),
            description=description or f"${amount} dividend",
        )


@dataclass
class DetectedAnomaly:
    """A detected price/volume anomaly that may indicate corporate action."""

    symbol: str
    date: date
    anomaly_type: str
    severity: str  # "high", "medium", "low"
    price_change_pct: Decimal
    volume_change_pct: Decimal
    likely_action: CorporateActionType | None
    suggested_ratio: str | None
    message: str

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "symbol": self.symbol,
            "date": self.date.isoformat(),
            "anomaly_type": self.anomaly_type,
            "severity": self.severity,
            "price_change_pct": float(self.price_change_pct),
            "volume_change_pct": float(self.volume_change_pct),
            "likely_action": self.likely_action.value if self.likely_action else None,
            "suggested_ratio": self.suggested_ratio,
            "message": self.message,
        }


@dataclass
class ValidationResult:
    """Result of data validation for corporate actions."""

    is_valid: bool
    is_adjusted: bool  # Whether data appears to be adjusted
    anomalies: list[DetectedAnomaly] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def has_issues(self) -> bool:
        """Check if validation found any issues."""
        return len(self.anomalies) > 0 or len(self.warnings) > 0

    def summary(self) -> str:
        """Get human-readable summary."""
        lines = []
        if self.is_adjusted:
            lines.append("Data appears to be adjusted for corporate actions.")
        else:
            lines.append("WARNING: Data may NOT be adjusted for corporate actions!")

        if self.anomalies:
            lines.append(f"\nDetected {len(self.anomalies)} potential corporate actions:")
            for anomaly in self.anomalies[:10]:  # Show first 10
                lines.append(f"  - {anomaly.date}: {anomaly.message}")
            if len(self.anomalies) > 10:
                lines.append(f"  ... and {len(self.anomalies) - 10} more")

        if self.warnings:
            lines.append(f"\nWarnings ({len(self.warnings)}):")
            for warning in self.warnings[:5]:
                lines.append(f"  - {warning}")

        if self.errors:
            lines.append(f"\nErrors ({len(self.errors)}):")
            for error in self.errors:
                lines.append(f"  - {error}")

        return "\n".join(lines)


class CorporateActionsDetector:
    """
    Detect potential corporate actions from price/volume patterns.

    Detection heuristics:
    - Large overnight price gaps (>40%) suggest splits
    - Price exactly halving/doubling with volume inverse suggests split
    - Regular large gaps at similar percentages suggest dividends
    - Sudden volume spikes with price drops suggest ex-dividend dates

    Usage:
        detector = CorporateActionsDetector()
        result = detector.validate(bars)

        if not result.is_adjusted:
            print("WARNING: Data appears unadjusted!")
            for anomaly in result.anomalies:
                print(f"  {anomaly.date}: {anomaly.message}")
    """

    # Detection thresholds
    SPLIT_PRICE_THRESHOLD = Decimal("0.40")  # 40% price change
    SPLIT_VOLUME_THRESHOLD = Decimal("0.50")  # 50% volume change
    DIVIDEND_THRESHOLD = Decimal("0.02")  # 2% price drop (typical dividend)
    COMMON_SPLIT_RATIOS = [
        (Decimal("2"), Decimal("1")),  # 2:1
        (Decimal("3"), Decimal("1")),  # 3:1
        (Decimal("4"), Decimal("1")),  # 4:1
        (Decimal("3"), Decimal("2")),  # 3:2
        (Decimal("5"), Decimal("4")),  # 5:4
        (Decimal("1"), Decimal("2")),  # 1:2 reverse
        (Decimal("1"), Decimal("5")),  # 1:5 reverse
        (Decimal("1"), Decimal("10")),  # 1:10 reverse
    ]

    def validate(
        self,
        bars: Sequence[Any],  # Sequence of bar objects with open, high, low, close, volume
        symbol: str = "UNKNOWN",
    ) -> ValidationResult:
        """
        Validate price data for potential corporate actions.

        Args:
            bars: Sequence of OHLCV bars
            symbol: Symbol name for reporting

        Returns:
            ValidationResult with detected anomalies and warnings
        """
        if len(bars) < 2:
            return ValidationResult(is_valid=True, is_adjusted=True)

        anomalies: list[DetectedAnomaly] = []
        warnings: list[str] = []

        split_like_count = 0
        total_checks = 0

        for i in range(1, len(bars)):
            prev_bar = bars[i - 1]
            curr_bar = bars[i]

            # Get prices (handle both Decimal and float)
            prev_close = Decimal(str(prev_bar.close))
            curr_open = Decimal(str(curr_bar.open))
            curr_close = Decimal(str(curr_bar.close))

            # Get volumes
            prev_vol = Decimal(str(prev_bar.volume)) if prev_bar.volume else Decimal("1")
            curr_vol = Decimal(str(curr_bar.volume)) if curr_bar.volume else Decimal("1")

            # Skip if prices are zero or very small
            if prev_close < Decimal("0.01") or curr_open < Decimal("0.01"):
                continue

            total_checks += 1

            # Calculate overnight gap
            price_change = (curr_open - prev_close) / prev_close
            price_change_pct = price_change * Decimal("100")

            # Calculate volume change
            volume_change = Decimal("0")
            if prev_vol > Decimal("0"):
                volume_change = (curr_vol - prev_vol) / prev_vol

            # Get bar date
            bar_date = curr_bar.timestamp
            if isinstance(bar_date, datetime):
                bar_date = bar_date.date()

            # Check for split-like patterns
            if abs(price_change) > self.SPLIT_PRICE_THRESHOLD:
                split_like_count += 1

                # Try to identify the split ratio
                suggested_ratio = self._identify_split_ratio(prev_close, curr_open)

                anomaly = DetectedAnomaly(
                    symbol=symbol,
                    date=bar_date,
                    anomaly_type="large_price_gap",
                    severity="high",
                    price_change_pct=price_change_pct,
                    volume_change_pct=volume_change * Decimal("100"),
                    likely_action=CorporateActionType.SPLIT,
                    suggested_ratio=suggested_ratio,
                    message=f"Price gap of {price_change_pct:.1f}% "
                    f"(${prev_close:.2f} → ${curr_open:.2f})"
                    + (f", likely {suggested_ratio} split" if suggested_ratio else ""),
                )
                anomalies.append(anomaly)

            # Check for dividend-like patterns (small gaps with volume spike)
            elif (
                Decimal("-0.10") < price_change < Decimal("-0.005")
                and volume_change > Decimal("0.5")
            ):
                anomaly = DetectedAnomaly(
                    symbol=symbol,
                    date=bar_date,
                    anomaly_type="possible_dividend",
                    severity="low",
                    price_change_pct=price_change_pct,
                    volume_change_pct=volume_change * Decimal("100"),
                    likely_action=CorporateActionType.CASH_DIVIDEND,
                    suggested_ratio=None,
                    message=f"Price drop of {abs(price_change_pct):.2f}% with "
                    f"{volume_change * 100:.0f}% volume increase (possible ex-dividend)",
                )
                anomalies.append(anomaly)

        # Determine if data appears adjusted
        # If we see many split-like patterns, data is likely unadjusted
        is_adjusted = True
        if total_checks > 0:
            split_ratio = split_like_count / total_checks
            if split_ratio > 0.001:  # More than 0.1% of days have split-like gaps
                is_adjusted = False
                warnings.append(
                    f"Data contains {split_like_count} large price gaps out of "
                    f"{total_checks} days ({split_ratio * 100:.2f}%), "
                    f"suggesting unadjusted data"
                )

        if not is_adjusted:
            warnings.append(
                "Using unadjusted data will produce INCORRECT backtest results. "
                "Please use adjusted data or provide corporate actions data for adjustment."
            )

        return ValidationResult(
            is_valid=len(anomalies) == 0,
            is_adjusted=is_adjusted,
            anomalies=anomalies,
            warnings=warnings,
        )

    def _identify_split_ratio(
        self,
        old_price: Decimal,
        new_price: Decimal,
    ) -> str | None:
        """
        Try to identify the split ratio from price change.

        Returns ratio string like "2:1" or None if can't identify.
        """
        if old_price == Decimal("0") or new_price == Decimal("0"):
            return None

        ratio = old_price / new_price

        # Check against common split ratios
        for num, den in self.COMMON_SPLIT_RATIOS:
            expected_ratio = num / den
            if abs(ratio - expected_ratio) / expected_ratio < Decimal("0.05"):
                return f"{num}:{den}"

        # Check for round number ratios
        ratio_float = float(ratio)
        if ratio_float > 1:
            rounded = round(ratio_float)
            if abs(ratio_float - rounded) < 0.1 and rounded in [2, 3, 4, 5, 10, 20]:
                return f"{rounded}:1"
        else:
            inverse = 1 / ratio_float
            rounded = round(inverse)
            if abs(inverse - rounded) < 0.1 and rounded in [2, 5, 10, 20]:
                return f"1:{rounded}"

        return None


class CorporateActionsAdjuster:
    """
    Apply corporate action adjustments to price/volume data.

    Adjustments are applied backwards from the most recent data to maintain
    current prices while making historical data comparable.

    Usage:
        adjuster = CorporateActionsAdjuster()
        adjuster.add_action(CorporateAction.split("AAPL", date(2020, 8, 31), "4:1"))

        adjusted_bars = adjuster.adjust(bars, "AAPL")
    """

    def __init__(self) -> None:
        """Initialize adjuster."""
        # symbol -> list of actions sorted by date descending
        self._actions: dict[str, list[CorporateAction]] = {}

    def add_action(self, action: CorporateAction) -> None:
        """Add a corporate action."""
        symbol = action.symbol.upper()
        if symbol not in self._actions:
            self._actions[symbol] = []

        self._actions[symbol].append(action)
        # Sort by date descending (most recent first)
        self._actions[symbol].sort(key=lambda a: a.effective_date, reverse=True)

    def add_actions(self, actions: Sequence[CorporateAction]) -> None:
        """Add multiple corporate actions."""
        for action in actions:
            self.add_action(action)

    def get_actions(self, symbol: str) -> list[CorporateAction]:
        """Get all actions for a symbol."""
        return self._actions.get(symbol.upper(), [])

    def clear(self, symbol: str | None = None) -> None:
        """Clear actions for a symbol or all symbols."""
        if symbol:
            self._actions.pop(symbol.upper(), None)
        else:
            self._actions.clear()

    def get_cumulative_factor(
        self,
        symbol: str,
        as_of_date: date,
    ) -> tuple[Decimal, Decimal]:
        """
        Get cumulative adjustment factors for a date.

        Returns (price_factor, volume_factor) to multiply raw data by.

        Args:
            symbol: Stock symbol
            as_of_date: Date to calculate factors for

        Returns:
            Tuple of (price_factor, volume_factor)
        """
        actions = self.get_actions(symbol)
        if not actions:
            return Decimal("1"), Decimal("1")

        price_factor = Decimal("1")
        volume_factor = Decimal("1")

        for action in actions:
            # Apply adjustments for actions that occurred AFTER the as_of_date
            # (we're adjusting historical data relative to current)
            if action.effective_date > as_of_date:
                if action.action_type == CorporateActionType.SPLIT:
                    price_factor *= action.adjustment_factor
                    volume_factor *= action.volume_adjustment_factor
                elif action.action_type == CorporateActionType.STOCK_DIVIDEND:
                    price_factor *= action.adjustment_factor
                    volume_factor *= action.volume_adjustment_factor

        return price_factor, volume_factor

    def adjust_price(
        self,
        symbol: str,
        price: Decimal,
        price_date: date,
    ) -> Decimal:
        """
        Adjust a single price for corporate actions.

        Args:
            symbol: Stock symbol
            price: Raw price
            price_date: Date of the price

        Returns:
            Adjusted price
        """
        price_factor, _ = self.get_cumulative_factor(symbol, price_date)
        return price * price_factor

    def adjust_volume(
        self,
        symbol: str,
        volume: int,
        volume_date: date,
    ) -> int:
        """
        Adjust a volume for corporate actions.

        Args:
            symbol: Stock symbol
            volume: Raw volume
            volume_date: Date of the volume

        Returns:
            Adjusted volume
        """
        _, volume_factor = self.get_cumulative_factor(symbol, volume_date)
        return int(Decimal(str(volume)) * volume_factor)

    def adjust_bars(
        self,
        bars: Sequence[Any],
        symbol: str,
    ) -> list[Any]:
        """
        Adjust a sequence of bars for corporate actions.

        Creates new bar objects with adjusted prices and volumes.
        Original bars are not modified.

        Args:
            bars: Sequence of OHLCV bars
            symbol: Stock symbol

        Returns:
            List of adjusted bars
        """
        actions = self.get_actions(symbol)
        if not actions:
            return list(bars)

        adjusted = []
        for bar in bars:
            bar_date = bar.timestamp
            if isinstance(bar_date, datetime):
                bar_date = bar_date.date()

            price_factor, volume_factor = self.get_cumulative_factor(symbol, bar_date)

            # Create adjusted bar (assuming bar has these attributes)
            # This works with dataclass or namedtuple bars
            adjusted_bar = type(bar)(
                timestamp=bar.timestamp,
                open=bar.open * price_factor,
                high=bar.high * price_factor,
                low=bar.low * price_factor,
                close=bar.close * price_factor,
                volume=int(Decimal(str(bar.volume)) * volume_factor),
            )
            adjusted.append(adjusted_bar)

        return adjusted


class CorporateActionsStore:
    """
    Store and retrieve corporate actions data.

    Supports loading from:
    - JSON files
    - YAML files
    - Dictionary (for programmatic use)

    Usage:
        store = CorporateActionsStore()
        store.load_from_file("corporate_actions.json")

        actions = store.get_actions("AAPL")
    """

    def __init__(self) -> None:
        """Initialize store."""
        self._actions: dict[str, list[CorporateAction]] = {}

    def add_action(self, action: CorporateAction) -> None:
        """Add a corporate action."""
        symbol = action.symbol.upper()
        if symbol not in self._actions:
            self._actions[symbol] = []
        self._actions[symbol].append(action)
        self._actions[symbol].sort(key=lambda a: a.effective_date)

    def get_actions(
        self,
        symbol: str,
        start_date: date | None = None,
        end_date: date | None = None,
    ) -> list[CorporateAction]:
        """
        Get actions for a symbol within date range.

        Args:
            symbol: Stock symbol
            start_date: Start date (inclusive)
            end_date: End date (inclusive)

        Returns:
            List of corporate actions
        """
        actions = self._actions.get(symbol.upper(), [])

        if start_date:
            actions = [a for a in actions if a.effective_date >= start_date]
        if end_date:
            actions = [a for a in actions if a.effective_date <= end_date]

        return actions

    def get_all_symbols(self) -> list[str]:
        """Get all symbols with actions."""
        return list(self._actions.keys())

    def load_from_dict(self, data: dict[str, Any]) -> int:
        """
        Load actions from dictionary.

        Expected format:
        {
            "actions": [
                {"action_type": "split", "symbol": "AAPL", ...},
                ...
            ]
        }

        Returns number of actions loaded.
        """
        count = 0
        for action_data in data.get("actions", []):
            try:
                action = CorporateAction.from_dict(action_data)
                self.add_action(action)
                count += 1
            except Exception as e:
                logger.warning(f"Failed to load corporate action: {e}")
        return count

    def load_from_file(self, path: str) -> int:
        """
        Load actions from JSON or YAML file.

        Returns number of actions loaded.
        """
        import json
        from pathlib import Path

        file_path = Path(path)

        if not file_path.exists():
            raise FileNotFoundError(f"Corporate actions file not found: {path}")

        content = file_path.read_text()

        if file_path.suffix.lower() in (".yaml", ".yml"):
            try:
                import yaml
                data = yaml.safe_load(content)
            except ImportError:
                raise ImportError("PyYAML required for YAML files: pip install pyyaml")
        else:
            data = json.loads(content)

        return self.load_from_dict(data)

    def to_dict(self) -> dict[str, Any]:
        """Export all actions to dictionary."""
        all_actions = []
        for actions in self._actions.values():
            all_actions.extend(a.to_dict() for a in actions)

        return {"actions": all_actions}

    def save_to_file(self, path: str) -> None:
        """Save actions to JSON file."""
        import json
        from pathlib import Path

        data = self.to_dict()
        Path(path).write_text(json.dumps(data, indent=2))


def validate_data_for_corporate_actions(
    bars: Sequence[Any],
    symbol: str = "UNKNOWN",
    raise_on_unadjusted: bool = False,
) -> ValidationResult:
    """
    Validate price data for potential corporate actions issues.

    Convenience function for quick validation.

    Args:
        bars: Sequence of OHLCV bars
        symbol: Symbol for reporting
        raise_on_unadjusted: If True, raise ValueError for unadjusted data

    Returns:
        ValidationResult

    Raises:
        ValueError: If raise_on_unadjusted=True and data appears unadjusted
    """
    detector = CorporateActionsDetector()
    result = detector.validate(bars, symbol)

    if raise_on_unadjusted and not result.is_adjusted:
        raise ValueError(
            f"Data for {symbol} appears to be unadjusted for corporate actions. "
            f"Detected {len(result.anomalies)} potential corporate actions. "
            f"Using unadjusted data will produce incorrect backtest results. "
            f"Please use adjusted data or provide corporate actions for adjustment."
        )

    return result


def create_adjuster_from_file(path: str) -> CorporateActionsAdjuster:
    """
    Create an adjuster with actions loaded from file.

    Args:
        path: Path to corporate actions file (JSON or YAML)

    Returns:
        CorporateActionsAdjuster ready to use
    """
    store = CorporateActionsStore()
    count = store.load_from_file(path)
    logger.info(f"Loaded {count} corporate actions from {path}")

    adjuster = CorporateActionsAdjuster()
    for symbol in store.get_all_symbols():
        for action in store.get_actions(symbol):
            adjuster.add_action(action)

    return adjuster

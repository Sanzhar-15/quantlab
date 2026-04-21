"""
Backtest Configuration.

Defines all configuration options for backtest runs.

Spec Reference: Technical Spec §3
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from typing import Any

from quantlab.backtest.commission import CommissionModel
from quantlab.backtest.fills import FillAssumption
from quantlab.backtest.slippage import SlippageModel


@dataclass
class BacktestConfig:
    """
    Complete backtest configuration.

    All parameters that control backtest behavior.
    """

    # Time range
    start_date: datetime
    end_date: datetime

    # Capital
    initial_capital: Decimal = Decimal("100000")

    # Fill assumptions
    fill_assumption: FillAssumption = FillAssumption.NEXT_OPEN

    # Slippage
    slippage_model: SlippageModel = SlippageModel.NONE
    slippage_params: dict[str, Any] = field(default_factory=dict)

    # Commission
    commission_model: CommissionModel = CommissionModel.NONE
    commission_params: dict[str, Any] = field(default_factory=dict)

    # Volume limits
    max_volume_participation: Decimal = Decimal("0.10")  # 10%

    # Risk limits
    max_position_size: Decimal | None = None  # None = no limit
    max_exposure: Decimal | None = None  # None = 100% of equity

    # Short selling
    allow_short: bool = True
    short_collateral_ratio: Decimal = Decimal("1.0")  # 100%
    borrow_fee_rate: Decimal = Decimal("0.02")  # 2% annual

    # Calendar
    calendar: str = "nyse"
    timezone: str = "America/New_York"

    # Data
    timeframe: str = "1d"
    symbols: list[str] = field(default_factory=list)

    # Debug
    debug_mode: bool = False
    save_debug_file: bool = False

    # Memory
    max_memory_mb: int = 4096  # 4GB default

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "start_date": self.start_date.isoformat(),
            "end_date": self.end_date.isoformat(),
            "initial_capital": str(self.initial_capital),
            "fill_assumption": self.fill_assumption.value,
            "slippage_model": self.slippage_model.value,
            "slippage_params": self.slippage_params,
            "commission_model": self.commission_model.value,
            "commission_params": self.commission_params,
            "max_volume_participation": str(self.max_volume_participation),
            # FIX-H6: Use 'is not None' — Decimal("0") is falsy but is a valid limit
            "max_position_size": str(self.max_position_size) if self.max_position_size is not None else None,
            "max_exposure": str(self.max_exposure) if self.max_exposure is not None else None,
            "allow_short": self.allow_short,
            "short_collateral_ratio": str(self.short_collateral_ratio),
            "borrow_fee_rate": str(self.borrow_fee_rate),
            "calendar": self.calendar,
            "timezone": self.timezone,
            "timeframe": self.timeframe,
            "symbols": self.symbols,
            "debug_mode": self.debug_mode,
            "save_debug_file": self.save_debug_file,
            "max_memory_mb": self.max_memory_mb,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BacktestConfig":
        """Create from dictionary."""
        return cls(
            start_date=datetime.fromisoformat(data["start_date"]),
            end_date=datetime.fromisoformat(data["end_date"]),
            initial_capital=Decimal(data.get("initial_capital", "100000")),
            fill_assumption=FillAssumption(data.get("fill_assumption", "next_open")),
            slippage_model=SlippageModel(data.get("slippage_model", "none")),
            slippage_params=data.get("slippage_params", {}),
            commission_model=CommissionModel(data.get("commission_model", "none")),
            commission_params=data.get("commission_params", {}),
            max_volume_participation=Decimal(data.get("max_volume_participation", "0.10")),
            max_position_size=Decimal(data["max_position_size"]) if data.get("max_position_size") is not None else None,
            max_exposure=Decimal(data["max_exposure"]) if data.get("max_exposure") is not None else None,
            allow_short=data.get("allow_short", True),
            short_collateral_ratio=Decimal(data.get("short_collateral_ratio", "1.0")),
            borrow_fee_rate=Decimal(data.get("borrow_fee_rate", "0.02")),
            calendar=data.get("calendar", "nyse"),
            timezone=data.get("timezone", "America/New_York"),
            timeframe=data.get("timeframe", "1d"),
            symbols=data.get("symbols", []),
            debug_mode=data.get("debug_mode", False),
            save_debug_file=data.get("save_debug_file", False),
            max_memory_mb=data.get("max_memory_mb", 4096),
        )

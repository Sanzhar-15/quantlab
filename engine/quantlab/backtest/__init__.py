"""
Backtest engine module.

Provides:
- Core backtest loop with t/t+1 signal/execution bar semantics
- Fill assumption modes (next_open, next_close, typical_price)
- Slippage models (none, fixed_bps, volatility, volume_impact)
- Commission models (none, per_share, per_trade, percentage, tiered)
- Volume participation enforcement
- Order types (MARKET, LIMIT, STOP, STOP_LIMIT)
- Time-in-force (GFD, GTC, IOC)

Spec Reference: Technical Spec §3-4
"""

from .bar import Bar
from .bar import BarSeries
from .commission import CommissionCalculator
from .commission import CommissionModel
from .commission import NoCommission
from .commission import PerShareCommission
from .commission import PerTradeCommission
from .commission import PercentageCommission
from .commission import TieredCommission
from .commission import create_commission_calculator
from .config import BacktestConfig
from .core import BacktestEngine
from .core import BacktestResult
from .core import BacktestState
from .core import Fill
from .core import Order
from .core import OrderSide
from .core import OrderStatus
from .core import OrderType
from .core import Signal
from .core import Strategy
from .core import TimeInForce
from .fills import FillAssumption
from .fills import FillPriceCalculator
from .fills import FillResult
from .fills import NextCloseFill
from .fills import NextOpenFill
from .fills import TypicalPriceFill
from .fills import VolumeParticipation
from .fills import get_fill_calculator
from .slippage import FixedBpsSlippage
from .slippage import NoSlippage
from .slippage import SlippageCalculator
from .slippage import SlippageModel
from .slippage import VolatilitySlippage
from .slippage import VolumeImpactSlippage
from .slippage import create_slippage_calculator
from .queue import BacktestJob
from .queue import BacktestQueue
from .queue import BacktestQueueWorker
from .queue import BatchBacktestRunner
from .queue import JobPriority
from .queue import JobStatus
from .queue import QueueStats
from .queue import WorkerStats
from .debug import BacktestDebugger
from .debug import DebugEntry
from .debug import DebugEntryType
from .debug import DebugFileReader
from .debug import DebugFileWriter
from .debug import DebugIndex
from .profiler import BacktestProfiler
from .profiler import ProfileReport
from .profiler import SectionStats
from .profiler import TimingRecord

__all__ = [
    # Bar data
    "Bar",
    "BarSeries",
    # Configuration
    "BacktestConfig",
    # Core engine
    "BacktestEngine",
    "BacktestResult",
    "BacktestState",
    "Strategy",
    # Orders
    "Order",
    "OrderSide",
    "OrderStatus",
    "OrderType",
    "TimeInForce",
    "Signal",
    "Fill",
    # Fill assumptions
    "FillAssumption",
    "FillPriceCalculator",
    "FillResult",
    "NextOpenFill",
    "NextCloseFill",
    "TypicalPriceFill",
    "VolumeParticipation",
    "get_fill_calculator",
    # Slippage
    "SlippageModel",
    "SlippageCalculator",
    "NoSlippage",
    "FixedBpsSlippage",
    "VolatilitySlippage",
    "VolumeImpactSlippage",
    "create_slippage_calculator",
    # Commission
    "CommissionModel",
    "CommissionCalculator",
    "NoCommission",
    "PerShareCommission",
    "PerTradeCommission",
    "PercentageCommission",
    "TieredCommission",
    "create_commission_calculator",
    # Backtest Queue
    "JobStatus",
    "JobPriority",
    "BacktestJob",
    "WorkerStats",
    "QueueStats",
    "BacktestQueueWorker",
    "BacktestQueue",
    "BatchBacktestRunner",
    # Debug/Replay
    "DebugEntryType",
    "DebugEntry",
    "DebugIndex",
    "DebugFileWriter",
    "DebugFileReader",
    "BacktestDebugger",
    # Profiling
    "BacktestProfiler",
    "ProfileReport",
    "SectionStats",
    "TimingRecord",
]

"""
Orders module.

Provides order type handling, execution logic, and queue management.

Spec Reference: Technical Spec §3.3

Provides:
- MARKET order fill logic
- LIMIT order fill logic with price improvement
- STOP order trigger logic
- STOP_LIMIT combined logic
- Time-in-force (GFD, GTC, IOC, FOK, GTD, OPG, CLS)
- Partial fill handling
- Order priority management
"""

from .base import FillInfo
from .base import FillResult
from .base import NoFill
from .base import OrderHandler
from .base import OrderRequest
from .base import OrderSide
from .base import OrderStatus
from .base import OrderType
from .tif import TimeInForce
from .limit import AggressiveLimitOrderHandler
from .limit import LimitOrderHandler
from .market import MarketOrderHandler
from .market import get_market_fill_price
from .partials import OrderFillState
from .partials import PartialFill
from .partials import PartialFillConfig
from .partials import PartialFillTracker
from .partials import PartialFillValidator
from .priority import OrderPriorityManager
from .priority import OrderQueue
from .priority import PriorityKey
from .priority import PriorityRule
from .priority import QueuedOrder
from .stop import StopOrderHandler
from .stop import TrailingStopHandler
from .stop_limit import StopLimitOrderHandler
from .stop_limit import StopLimitState
from .tif import OrderExpiry
from .tif import TIFHandler
from .tif import TIFStatus
from .tif import TimeInForce as TIF

__all__ = [
    # Base types
    "OrderSide",
    "OrderType",
    "OrderStatus",
    "TimeInForce",
    "OrderRequest",
    "OrderHandler",
    "FillInfo",
    "NoFill",
    "FillResult",
    # Market orders
    "MarketOrderHandler",
    "get_market_fill_price",
    # Limit orders
    "LimitOrderHandler",
    "AggressiveLimitOrderHandler",
    # Stop orders
    "StopOrderHandler",
    "TrailingStopHandler",
    # Stop-limit orders
    "StopLimitOrderHandler",
    "StopLimitState",
    # Time-in-force
    "TIF",
    "TIFHandler",
    "TIFStatus",
    "OrderExpiry",
    # Partial fills
    "PartialFill",
    "OrderFillState",
    "PartialFillTracker",
    "PartialFillConfig",
    "PartialFillValidator",
    # Priority
    "PriorityRule",
    "PriorityKey",
    "QueuedOrder",
    "OrderQueue",
    "OrderPriorityManager",
]

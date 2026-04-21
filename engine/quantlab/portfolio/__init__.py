"""
Portfolio management module.

Provides:
- PortfolioState tracking (cash, positions, equity)
- Short selling mechanics with 100% collateral
- Borrow fee accrual
- Equity identity validation
- Buying power enforcement
- Position and exposure limits

Spec Reference: Technical Spec §4
"""

from .fees import BorrowFeeCalculator
from .fees import BorrowFeeSchedule
from .fees import FeeManager
from .fees import FeeRecord
from .fees import FeeType
from .fees import MarginInterestCalculator
from .fees import RegulatoryFeeCalculator
from .limits import BuyingPowerCalculator
from .limits import LimitCheckResult
from .limits import LimitsEnforcer
from .limits import LimitType
from .limits import LimitViolation
from .limits import PortfolioLimits
from .limits import PositionLimits
from .short import ShortBorrow
from .short import ShortOpenResult
from .short import ShortPosition
from .short import ShortSellingConfig
from .short import ShortSellingManager
from .state import PortfolioHistory
from .state import PortfolioSnapshot
from .state import PortfolioState
from .state import Position
from .state import PositionSide
from .validation import CashValidator
from .validation import EquityValidator
from .validation import ExposureValidator
from .validation import PortfolioValidator
from .validation import PositionValidator
from .validation import ValidationError
from .validation import ValidationErrorType
from .validation import ValidationLevel
from .validation import ValidationResult

__all__ = [
    # State
    "PositionSide",
    "Position",
    "PortfolioState",
    "PortfolioSnapshot",
    "PortfolioHistory",
    # Short selling
    "ShortPosition",
    "ShortBorrow",
    "ShortOpenResult",
    "ShortSellingManager",
    "ShortSellingConfig",
    # Fees
    "FeeType",
    "FeeRecord",
    "BorrowFeeSchedule",
    "BorrowFeeCalculator",
    "MarginInterestCalculator",
    "RegulatoryFeeCalculator",
    "FeeManager",
    # Validation
    "ValidationLevel",
    "ValidationErrorType",
    "ValidationError",
    "ValidationResult",
    "EquityValidator",
    "PositionValidator",
    "ExposureValidator",
    "CashValidator",
    "PortfolioValidator",
    # Limits
    "LimitType",
    "LimitViolation",
    "LimitCheckResult",
    "PositionLimits",
    "PortfolioLimits",
    "LimitsEnforcer",
    "BuyingPowerCalculator",
]

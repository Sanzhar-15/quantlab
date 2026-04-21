"""
Data provider module.

Provides:
- DataProvider base interface (§10.5)
- Alpaca Data API adapter
- Mock data provider for testing
- Quote staleness monitoring

Spec Reference: Technical Spec §10
"""

from .alpaca import AlpacaConfig
from .alpaca import AlpacaDataProvider
from .base import Bar
from .base import BarCallback
from .base import ConnectionResult
from .base import ConnectionStatus
from .base import DataProvider
from .base import DataType
from .base import Quote
from .base import QuoteCallback
from .base import QuoteStalenessMonitor
from .base import StalenessConfig
from .base import StatusCallback
from .base import Subscription
from .base import TradeCallback
from .base import TradeEvent
from .mock import MockDataProvider
from .mock import MockSymbolConfig

__all__ = [
    # Base types
    "ConnectionStatus",
    "DataType",
    "ConnectionResult",
    "Quote",
    "Bar",
    "TradeEvent",
    "Subscription",
    # Callbacks
    "QuoteCallback",
    "BarCallback",
    "TradeCallback",
    "StatusCallback",
    # Base provider
    "DataProvider",
    # Staleness monitoring
    "StalenessConfig",
    "QuoteStalenessMonitor",
    # Alpaca
    "AlpacaConfig",
    "AlpacaDataProvider",
    # Mock
    "MockSymbolConfig",
    "MockDataProvider",
]

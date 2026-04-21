"""
Trading Module.

Provides trading session management, order handling, position tracking,
risk monitoring, and broker adapters.

Spec Reference: Technical Spec §8, Phase 5 Trade View MVP
"""

from .session import (
    SessionState,
    SessionMode,
    HeartbeatStatus,
    NetworkStatus,
    SessionConfig,
    SessionMetrics,
    ConnectivityCheckResult,
    OfflineDetector,
    ConcurrentSessionLimiter,
    SessionLimitError,
    OfflineError,
    TradingSession,
    SessionManager,
    generate_session_id,
)

from .orders import (
    OrderType,
    OrderSide,
    OrderStatus,
    TimeInForce,
    Fill,
    Order,
    OrderRequest,
    OrderManager,
    generate_order_id,
)

from .positions import (
    Position,
    PositionSummary,
    PositionTracker,
)

from .risk import (
    RiskLevel,
    RiskViolationType,
    RiskLimits,
    RiskViolation,
    RiskStatus,
    RiskMonitor,
)

from .broker import (
    BrokerStatus,
    BrokerAccount,
    MarketQuote,
    BrokerAdapter,
    PaperBroker,
    PaperBrokerConfig,
    BrokerManager,
    ReconnectionConfig,
    ReconnectionEvent,
    BrokerReconnector,
    QueuedOrderPriority,
    QueuedOrder,
    QueueBufferConfig,
    QueueEvent,
    OrderQueueBuffer,
)

from .reconciliation import (
    DiscrepancyType,
    ReconciliationAction,
    PositionDiscrepancy,
    ReconciliationResult,
    ReconciliationConfig,
    PositionReconciler,
    ReconciliationError,
)

from .fills import (
    FillStatus,
    Fill as FillRecord,
    FillReconciliationResult,
    FillReconciliationState,
    FillReconciler,
    FillAggregator,
)

from .emergency import (
    FlattenStage,
    FlattenReason,
    FlattenProgress,
    FlattenResult,
    FlattenConfig,
    EmergencyFlatten,
    emergency_flatten,
    FlattenConfirmationError,
    FLATTEN_CONFIRMATION_TOKEN,
    generate_flatten_token,
    verify_flatten_confirmation,
)

from .drift import (
    DriftSeverity,
    DriftType,
    DriftEvent,
    DriftThresholds,
    BacktestSignal,
    LiveExecution,
    DriftSummary,
    TradeDriftDetector,
    StatisticalTestResult,
    two_sample_t_test,
    chi_squared_test,
    ks_test,
)

from .ledger import (
    EntryType,
    LedgerEntry,
    LedgerStats,
    SessionLedger,
    recover_session_state,
)

__all__ = [
    # Session
    "SessionState",
    "SessionMode",
    "HeartbeatStatus",
    "NetworkStatus",
    "SessionConfig",
    "SessionMetrics",
    "ConnectivityCheckResult",
    "OfflineDetector",
    "ConcurrentSessionLimiter",
    "SessionLimitError",
    "OfflineError",
    "TradingSession",
    "SessionManager",
    "generate_session_id",
    # Orders
    "OrderType",
    "OrderSide",
    "OrderStatus",
    "TimeInForce",
    "Fill",
    "Order",
    "OrderRequest",
    "OrderManager",
    "generate_order_id",
    # Positions
    "Position",
    "PositionSummary",
    "PositionTracker",
    # Risk
    "RiskLevel",
    "RiskViolationType",
    "RiskLimits",
    "RiskViolation",
    "RiskStatus",
    "RiskMonitor",
    # Broker
    "BrokerStatus",
    "BrokerAccount",
    "MarketQuote",
    "BrokerAdapter",
    "PaperBroker",
    "PaperBrokerConfig",
    "BrokerManager",
    "ReconnectionConfig",
    "ReconnectionEvent",
    "BrokerReconnector",
    # Order Queue Buffer
    "QueuedOrderPriority",
    "QueuedOrder",
    "QueueBufferConfig",
    "QueueEvent",
    "OrderQueueBuffer",
    # Reconciliation
    "DiscrepancyType",
    "ReconciliationAction",
    "PositionDiscrepancy",
    "ReconciliationResult",
    "ReconciliationConfig",
    "PositionReconciler",
    "ReconciliationError",
    # Fill Reconciliation
    "FillStatus",
    "FillRecord",
    "FillReconciliationResult",
    "FillReconciliationState",
    "FillReconciler",
    "FillAggregator",
    # Emergency Flatten
    "FlattenStage",
    "FlattenReason",
    "FlattenProgress",
    "FlattenResult",
    "FlattenConfig",
    "EmergencyFlatten",
    "emergency_flatten",
    "FlattenConfirmationError",
    "FLATTEN_CONFIRMATION_TOKEN",
    "generate_flatten_token",
    "verify_flatten_confirmation",
    # Trade Drift Detection
    "DriftSeverity",
    "DriftType",
    "DriftEvent",
    "DriftThresholds",
    "BacktestSignal",
    "LiveExecution",
    "DriftSummary",
    "TradeDriftDetector",
    "StatisticalTestResult",
    "two_sample_t_test",
    "chi_squared_test",
    "ks_test",
    # Session Ledger
    "EntryType",
    "LedgerEntry",
    "LedgerStats",
    "SessionLedger",
    "recover_session_state",
]

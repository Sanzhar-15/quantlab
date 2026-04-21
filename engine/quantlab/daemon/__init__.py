"""
Live trading daemon module.

Provides:
- Daemon process lifecycle management
- IPC communication over Unix sockets / Named pipes
- Checkpoint/recovery for crash resilience
- Watchdog for daemon health monitoring
- System sleep/wake handling
- Market hours state management (ACTIVE, PAUSED, MARKET_CLOSED)

CRITICAL: Daemon NEVER auto-restarts to prevent surprise trading.

Spec Reference: Technical Spec §1.5, Decision L69, N99
"""

from .checkpoint import CheckpointError
from .checkpoint import CheckpointManager
from .checkpoint import PendingOrder
from .checkpoint import Position
from .checkpoint import SessionCheckpoint
from .ipc import AuthenticationError
from .ipc import ClientConnection
from .ipc import IPCClient
from .ipc import IPCServer
from .ipc import TokenManager
from .lifecycle import DaemonAlreadyRunning
from .lifecycle import DaemonState
from .lifecycle import PidFile
from .lifecycle import PidFileError
from .lifecycle import SignalHandler
from .lifecycle import daemonize
from .main import LiveTradingDaemon
from .main import SessionConfig
from .power import PowerEvent
from .power import PowerEventHandler
from .power import PowerStateManager
from .power import create_power_handler
from .watchdog import ComponentHealth
from .watchdog import DaemonHealth
from .watchdog import HealthChecker
from .watchdog import HealthStatus
from .watchdog import HeartbeatSender
from .watchdog import Watchdog
from .watchdog import create_broker_check
from .watchdog import create_strategy_check

__all__ = [
    # Main daemon
    "LiveTradingDaemon",
    "SessionConfig",
    # Lifecycle
    "DaemonState",
    "PidFile",
    "PidFileError",
    "DaemonAlreadyRunning",
    "SignalHandler",
    "daemonize",
    # Checkpoint
    "CheckpointManager",
    "SessionCheckpoint",
    "Position",
    "PendingOrder",
    "CheckpointError",
    # IPC
    "IPCServer",
    "IPCClient",
    "ClientConnection",
    "TokenManager",
    "AuthenticationError",
    # Watchdog
    "Watchdog",
    "HealthChecker",
    "HeartbeatSender",
    "HealthStatus",
    "DaemonHealth",
    "ComponentHealth",
    "create_broker_check",
    "create_strategy_check",
    # Power
    "PowerStateManager",
    "PowerEventHandler",
    "PowerEvent",
    "create_power_handler",
]

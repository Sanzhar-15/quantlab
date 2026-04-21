"""
Live Trading Daemon Entry Point.

The daemon is a long-running process that:
- Survives UI crashes
- Maintains positions and orders
- Handles broker communication
- Checkpoints state for crash recovery

CRITICAL: The daemon NEVER auto-restarts to prevent surprise trading.

Spec Reference: Technical Spec §1.5, Decision L69, N99
"""

import argparse
import asyncio
import logging
import os
import random
import sys
from dataclasses import dataclass
from datetime import datetime
from datetime import time as dt_time
from decimal import Decimal
from pathlib import Path
from typing import Any

from quantlab.daemon.checkpoint import CheckpointManager
from quantlab.daemon.checkpoint import PendingOrder
from quantlab.daemon.checkpoint import Position as CheckpointPosition
from quantlab.daemon.checkpoint import SessionCheckpoint
from quantlab.daemon.ipc import IPCServer
from quantlab.daemon.ipc import TokenManager
from quantlab.daemon.lifecycle import DaemonState
from quantlab.daemon.lifecycle import PidFile
from quantlab.daemon.lifecycle import SignalHandler
from quantlab.daemon.lifecycle import daemonize
from quantlab.daemon.power import PowerEvent
from quantlab.daemon.power import PowerStateManager
from quantlab.daemon.watchdog import HealthChecker
from quantlab.daemon.watchdog import HeartbeatSender
from quantlab.daemon.watchdog import Watchdog
from quantlab.protocol.message import MessageType
from quantlab.protocol.message import Notification
from quantlab.protocol.reliability import ReliabilityManager
from quantlab.risk.circuit_breaker import CircuitBreaker
from quantlab.risk.circuit_breaker import CircuitBreakerEvent
from quantlab.risk.circuit_breaker import RiskManager as CircuitBreakerRiskManager
from quantlab.risk.circuit_breaker import TriggerReason
from quantlab.risk.exposure import ExposureManager
from quantlab.risk.exposure import OrderRequest as ExposureOrderRequest
from quantlab.orders.base import OrderSide as ExposureSide  # Same canonical OrderSide
from quantlab.trading.orders import Order
from quantlab.trading.orders import OrderManager
from quantlab.trading.orders import OrderRequest
from quantlab.trading.orders import OrderSide
from quantlab.trading.orders import OrderType
from quantlab.trading.positions import Position
from quantlab.trading.positions import PositionTracker
from quantlab.trading.risk import RiskLimits
from quantlab.trading.risk import RiskMonitor
from quantlab.trading.risk import RiskViolationType
from quantlab.trading.emergency import EmergencyFlatten
from quantlab.trading.emergency import FlattenConfig
from quantlab.trading.emergency import FlattenReason
from quantlab.trading.emergency import FlattenResult
from quantlab.secrets.encrypted import SecretsManager
from quantlab.audit.ledger import AuditLedger
from quantlab.audit.ledger import log_order_submit
from quantlab.audit.ledger import log_order_fill
from quantlab.audit.ledger import log_order_cancel
from quantlab.audit.ledger import log_order_reject
from quantlab.audit.ledger import log_session_start
from quantlab.audit.ledger import log_session_end
from quantlab.audit.ledger import log_position_snapshot
from quantlab.trading.reconciliation import PositionReconciler
from quantlab.trading.reconciliation import ReconciliationConfig
from quantlab.trading.reconciliation import ReconciliationResult
from quantlab.trading.drift import TradeDriftDetector
from quantlab.trading.drift import DriftEvent
from quantlab.trading.drift import DriftSeverity


logger = logging.getLogger(__name__)


@dataclass
class SessionConfig:
    """Configuration for a trading session."""

    session_id: str
    strategy_path: str
    broker: str
    symbols: list[str]
    risk_limits: dict[str, Any]
    market_timezone: str = "America/New_York"
    market_open: dt_time = dt_time(9, 30)
    market_close: dt_time = dt_time(16, 0)


class LiveTradingDaemon:
    """
    Live trading daemon process.

    Lifecycle:
    1. Initialize (load config, connect broker)
    2. Start IPC server
    3. Run trading loop
    4. Checkpoint periodically
    5. Handle shutdown gracefully
    """

    CHECKPOINT_INTERVAL = 1.0  # Checkpoint within 1 second of state change
    HEARTBEAT_INTERVAL = 5.0  # Heartbeat every 5 seconds
    GRACEFUL_SHUTDOWN_TIMEOUT = 60.0  # Max 60 seconds for graceful shutdown
    BROKER_HEALTH_CHECK_INTERVAL = 30.0  # Check broker health every 30 seconds
    DEFAULT_RECONCILIATION_INTERVAL = 300.0  # FIX-T003: Reconcile every 5 minutes by default

    def __init__(self, config: SessionConfig) -> None:
        self.config = config
        self.session_id = config.session_id

        # State (protected by _state_lock for concurrent coroutine safety)
        self._state = DaemonState.STARTING
        self._state_lock = asyncio.Lock()
        self._running = False
        self._shutdown_event = asyncio.Event()

        # Components
        self._pid_file = PidFile(self.session_id)
        self._token_manager = TokenManager(self.session_id)
        self._checkpoint_manager = CheckpointManager(self.session_id)
        self._signal_handler = SignalHandler()
        self._health_checker = HealthChecker()
        self._watchdog: Watchdog | None = None
        self._heartbeat: HeartbeatSender | None = None
        self._power_manager: PowerStateManager | None = None
        self._ipc_server: IPCServer | None = None
        self._reliability_manager: ReliabilityManager | None = None

        # Trading components
        self._position_tracker = PositionTracker()
        self._order_manager = OrderManager()
        self._exposure_manager = ExposureManager(
            max_exposure=Decimal(config.risk_limits.get("max_exposure", "100000"))
        )

        # Risk management
        self._risk_monitor = RiskMonitor(
            position_tracker=self._position_tracker,
            order_manager=self._order_manager,
        )
        # Initialize risk limits from config
        self._init_risk_limits(config.risk_limits)

        # Circuit breaker for trading halt (consecutive losses, daily limits)
        self._circuit_breaker = CircuitBreaker(session_id=config.session_id)
        self._circuit_breaker.on_trip(self._handle_circuit_breaker_trip)
        self._circuit_breaker.on_state_change(self._handle_circuit_breaker_state_change)

        # Integrated risk manager (circuit breaker + loss tracking)
        self._cb_risk_manager = CircuitBreakerRiskManager(
            circuit_breaker=self._circuit_breaker,
            max_exposure=Decimal(config.risk_limits.get("max_exposure", "100000")),
            consecutive_loss_limit=int(config.risk_limits.get("consecutive_loss_limit", 3)),
            daily_loss_limit=Decimal(str(config.risk_limits.get("daily_loss_limit", "1000"))),
        )

        # Broker state
        self._broker: Any = None  # BrokerAdapter instance
        self._broker_connected = False
        self._broker_reconnect_attempts = 0
        self._max_broker_reconnect_attempts = 5
        self._broker_reconnect_base_delay = 1.0  # seconds

        # Secrets manager for credential retrieval (env vars + encrypted fallback)
        self._secrets_manager = SecretsManager()

        # Last reconciliation result for UI display
        self._last_reconciliation_result: ReconciliationResult | None = None

        # Audit ledger for tamper-evident logging (§12.1, §12.3)
        self._audit_ledger: AuditLedger | None = None

        # FIX-T003: Configurable reconciliation interval (seconds)
        self._reconciliation_interval = float(
            config.risk_limits.get("reconciliation_interval", self.DEFAULT_RECONCILIATION_INTERVAL)
        )

        # FIX-T004: Drift detection — monitors divergence between backtest and live
        self._drift_detector = TradeDriftDetector(
            session_id=config.session_id,
            on_drift=self._handle_drift_event,
            on_critical=self._handle_critical_drift_event,
        )

    @property
    def state(self) -> str:
        """Current daemon state."""
        return self._state

    def _init_risk_limits(self, risk_config: dict[str, Any]) -> None:
        """Initialize risk limits from config."""
        limits = RiskLimits(
            max_position_size=Decimal(str(risk_config.get("max_position_size", "10000"))),
            max_position_quantity=Decimal(str(risk_config.get("max_position_quantity", "1000"))),
            max_total_exposure=Decimal(str(risk_config.get("max_exposure", "100000"))),
            daily_loss_limit=Decimal(str(risk_config.get("daily_loss_limit", "1000"))),
            max_drawdown_percent=float(risk_config.get("max_drawdown_percent", 20.0)),
            max_open_orders=int(risk_config.get("max_open_orders", 10)),
            max_order_size=Decimal(str(risk_config.get("max_order_size", "5000"))),
            max_concentration_percent=float(risk_config.get("max_concentration_percent", 25.0)),
        )
        self._risk_monitor.set_limits(self.session_id, limits)

        # Register violation callbacks
        self._risk_monitor.on_violation(self._handle_risk_violation)
        self._risk_monitor.on_trading_halted(self._handle_trading_halted)

    def _handle_risk_violation(self, violation: Any) -> None:
        """Handle risk violation event."""
        logger.warning(f"Risk violation: {violation.message}")

        # Notify UI of risk violation
        if self._ipc_server:
            notification = Notification(
                message_type=MessageType.STATUS_UPDATE,
                params={
                    "risk_violation": True,
                    "violation_type": violation.violation_type.value,
                    "message": violation.message,
                    "level": violation.level.value,
                },
                session_id=self.session_id,
            )
            asyncio.create_task(self._ipc_server.broadcast(notification))

    def _handle_trading_halted(self, session_id: str, reason: str) -> None:
        """Handle trading halted event."""
        logger.error(f"Trading halted for session {session_id}: {reason}")

        # Notify UI that trading has been halted
        if self._ipc_server:
            notification = Notification(
                message_type=MessageType.ERROR,
                params={
                    "error": "trading_halted",
                    "session_id": session_id,
                    "reason": reason,
                },
                session_id=self.session_id,
            )
            asyncio.create_task(self._ipc_server.broadcast(notification))

    def _handle_circuit_breaker_trip(self, reason: TriggerReason, message: str) -> None:
        """Handle circuit breaker trip - trading halted.

        FIX-R003: Full safety response — cancel open orders, optionally flatten,
        notify UI, and audit-log the event.
        """
        logger.critical(f"CIRCUIT BREAKER TRIPPED: {reason.value} - {message}")

        # FIX-R003: Schedule async safety actions (cancel orders, flatten, notify)
        asyncio.create_task(self._execute_circuit_breaker_response(reason, message))

    async def _execute_circuit_breaker_response(
        self, reason: TriggerReason, message: str
    ) -> None:
        """Execute the full circuit breaker safety response (FIX-R003)."""
        # Step 1: Cancel all open orders
        cancelled_count = 0
        open_orders = self._order_manager.get_open_orders(self.session_id)
        for order in open_orders:
            try:
                if self._broker and self._broker_connected and order.broker_order_id:
                    await self._broker.cancel_order(order.broker_order_id)
                self._order_manager.cancel_order(order.order_id)
                self._exposure_manager.release(order.order_id)
                cancelled_count += 1
            except Exception as e:
                logger.error(
                    f"Failed to cancel order {order.order_id} during circuit break: {e}"
                )

        # Step 2: Flatten positions if reason warrants it
        should_flatten = reason in (
            TriggerReason.DAILY_LOSS_LIMIT,
            TriggerReason.EXPOSURE_BREACH,
        )
        flatten_result = None
        if should_flatten:
            try:
                flatten_result = await self._handle_flatten({
                    "reason": f"circuit_breaker_{reason.value}"
                })
            except Exception as e:
                logger.error(f"Emergency flatten during circuit break failed: {e}")

        # Step 3: Audit log the full response
        if self._audit_ledger:
            from quantlab.audit.ledger import log_session_end
            log_session_end(
                self._audit_ledger,
                session_id=self.session_id,
                reason=f"circuit_breaker_{reason.value}",
                final_pnl=None,
            )

        # Step 4: Notify UI with full details
        if self._ipc_server:
            notification = Notification(
                message_type=MessageType.ERROR,
                params={
                    "error": "circuit_breaker_tripped",
                    "reason": reason.value,
                    "message": message,
                    "trading_halted": True,
                    "cancelled_orders": cancelled_count,
                    "positions_flattened": should_flatten,
                },
                session_id=self.session_id,
            )
            asyncio.create_task(self._ipc_server.broadcast(notification))

        logger.critical(
            f"Circuit breaker response complete: cancelled={cancelled_count}, "
            f"flatten={should_flatten}"
        )

    def _handle_circuit_breaker_state_change(self, event: CircuitBreakerEvent) -> None:
        """Handle circuit breaker state change."""
        logger.info(
            f"Circuit breaker state: {event.previous_state.value} -> {event.new_state.value}"
        )

        if self._ipc_server:
            notification = Notification(
                message_type=MessageType.STATUS_UPDATE,
                params={
                    "circuit_breaker": {
                        "previous_state": event.previous_state.value,
                        "new_state": event.new_state.value,
                        "reason": event.reason.value if event.reason else None,
                        "message": event.message,
                    },
                },
                session_id=self.session_id,
            )
            asyncio.create_task(self._ipc_server.broadcast(notification))

    async def start(self) -> None:
        """
        Start the daemon.

        Raises:
            Exception: If daemon is already running for this session
        """
        logger.info(f"Starting daemon for session: {self.session_id}")

        try:
            # Acquire PID file lock
            self._pid_file.acquire()

            # FIX-CGP-007: Use token from environment if provided by extension,
            # otherwise generate a new one. This avoids a race where the daemon
            # overwrites the token file the extension already wrote.
            env_token = os.environ.get("QUANTLAB_AUTH_TOKEN")
            if env_token:
                self._token_manager.set_token(env_token)
                logger.debug("Using authentication token from environment")
            else:
                self._token_manager.generate()
                logger.debug("Generated new authentication token")

            # Setup signal handlers
            self._signal_handler.install()
            self._signal_handler.on_shutdown(self._request_shutdown)

            # Try to recover from checkpoint
            checkpoint = self._checkpoint_manager.load()
            if checkpoint:
                logger.info(
                    f"Recovered from checkpoint (last: {checkpoint.checkpoint_timestamp})"
                )
                await self._restore_from_checkpoint(checkpoint)

            # Setup reliability manager for critical message tracking
            self._reliability_manager = ReliabilityManager()
            await self._reliability_manager.start()

            # Setup IPC server with reliability manager
            self._ipc_server = IPCServer(
                self.session_id,
                self._token_manager,
                reliability_manager=self._reliability_manager,
            )
            self._register_ipc_handlers()
            await self._ipc_server.start()

            # Setup watchdog
            self._watchdog = Watchdog(self._health_checker)
            await self._watchdog.start()

            # Setup heartbeat (pass health_checker for recording heartbeats)
            self._heartbeat = HeartbeatSender(
                self._send_heartbeat,
                interval=self.HEARTBEAT_INTERVAL,
                health_checker=self._health_checker,
            )
            await self._heartbeat.start()

            # Setup power management
            self._power_manager = PowerStateManager(
                on_wake=self._handle_wake,
                on_sleep=self._handle_sleep,
            )
            await self._power_manager.start()

            # Start exposure cleanup task
            await self._exposure_manager.start_cleanup()

            # Initialize audit ledger for tamper-evident logging
            self._audit_ledger = AuditLedger(self.session_id, mode="live")
            self._audit_ledger.open()
            log_session_start(
                self._audit_ledger,
                strategy_name=self.config.strategy_path,
                parameters=self.config.risk_limits,
                initial_capital=float(self.config.risk_limits.get("max_exposure", 100000)),
            )
            logger.info(f"Audit ledger opened: {self._audit_ledger.path}")

            # Connect to broker
            await self._connect_broker()

            # Transition to active state (with lock for consistency)
            async with self._state_lock:
                self._state = DaemonState.ACTIVE
                self._running = True

            logger.info(f"Daemon started: {self.session_id}")

            # CODEX-003: Emit DAEMON_READY signal on stdout for extension readiness detection.
            # LiveDaemonManager.ts:160 waits for this string before considering daemon ready.
            print("DAEMON_READY", flush=True)

            # Run main loop
            await self._main_loop()

        except Exception as e:
            logger.error(f"Daemon error: {e}")
            raise
        finally:
            await self._cleanup()

    async def stop(self, timeout: float | None = None) -> None:
        """
        Stop the daemon gracefully.

        Args:
            timeout: Maximum time to wait for graceful shutdown
        """
        if not self._running:
            return

        timeout = timeout or self.GRACEFUL_SHUTDOWN_TIMEOUT
        logger.info(f"Stopping daemon (timeout: {timeout}s)")

        async with self._state_lock:
            self._state = DaemonState.STOPPING
        self._shutdown_event.set()

        # Wait for main loop to exit
        try:
            await asyncio.wait_for(
                self._wait_for_shutdown(),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            logger.warning("Graceful shutdown timed out, forcing stop")

    def _request_shutdown(self) -> None:
        """Request daemon shutdown (called from signal handler)."""
        self._shutdown_event.set()

    async def _wait_for_shutdown(self) -> None:
        """Wait until running flag is cleared."""
        while self._running:
            await asyncio.sleep(0.1)

    async def _main_loop(self) -> None:
        """Main daemon loop."""
        checkpoint_task = asyncio.create_task(self._checkpoint_loop())
        market_task = asyncio.create_task(self._market_hours_loop())
        broker_task = asyncio.create_task(self._broker_health_loop())
        reconciliation_task = asyncio.create_task(self._reconciliation_loop())  # FIX-T003

        try:
            # Wait for shutdown signal
            await self._shutdown_event.wait()
        finally:
            # Cancel background tasks
            checkpoint_task.cancel()
            market_task.cancel()
            broker_task.cancel()
            reconciliation_task.cancel()

            for task in (checkpoint_task, market_task, broker_task, reconciliation_task):
                try:
                    await task
                except asyncio.CancelledError:
                    pass

    async def _checkpoint_loop(self) -> None:
        """Periodically save checkpoint if dirty."""
        while self._running:
            try:
                await asyncio.sleep(self.CHECKPOINT_INTERVAL)

                if self._checkpoint_manager.is_dirty:
                    checkpoint = self._create_checkpoint()
                    self._checkpoint_manager.save(checkpoint)

            except asyncio.CancelledError:
                # Final checkpoint on shutdown
                checkpoint = self._create_checkpoint()
                self._checkpoint_manager.save(checkpoint)
                break
            except Exception as e:
                logger.error(f"Checkpoint error: {e}")

    async def _broker_health_loop(self) -> None:
        """Monitor broker connection health and reconnect if needed."""
        while self._running:
            try:
                await asyncio.sleep(self.BROKER_HEALTH_CHECK_INTERVAL)

                if self._broker is None:
                    continue

                # Check broker connection health
                try:
                    is_connected = await self._check_broker_connection()

                    if is_connected and not self._broker_connected:
                        # Connection restored
                        self._broker_connected = True
                        self._broker_reconnect_attempts = 0
                        logger.info("Broker connection restored")

                        # Notify UI
                        if self._ipc_server:
                            notification = Notification(
                                message_type=MessageType.STATUS_UPDATE,
                                params={"broker_connected": True},
                                session_id=self.session_id,
                            )
                            await self._ipc_server.broadcast(notification)

                    elif not is_connected and self._broker_connected:
                        # Connection lost - start reconnection
                        self._broker_connected = False
                        logger.warning("Broker connection lost, initiating reconnection")

                        # Notify UI
                        if self._ipc_server:
                            notification = Notification(
                                message_type=MessageType.STATUS_UPDATE,
                                params={
                                    "broker_connected": False,
                                    "reconnecting": True,
                                },
                                session_id=self.session_id,
                            )
                            await self._ipc_server.broadcast(notification)

                        # Start reconnection in background
                        asyncio.create_task(self._reconnect_broker())

                except Exception as e:
                    logger.error(f"Broker health check failed: {e}")
                    if self._broker_connected:
                        self._broker_connected = False
                        asyncio.create_task(self._reconnect_broker())

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Broker health loop error: {e}")

    async def _check_broker_connection(self) -> bool:
        """Check if broker connection is alive."""
        if not self._broker:
            return False

        try:
            # Try to ping or check status - implementation depends on broker API
            if hasattr(self._broker, 'is_connected'):
                return await self._broker.is_connected()
            elif hasattr(self._broker, 'ping'):
                await self._broker.ping()
                return True
            elif hasattr(self._broker, 'get_account'):
                # Fallback: try to get account info as health check
                await self._broker.get_account()
                return True
            else:
                # Assume connected if no health check method available
                return self._broker_connected
        except Exception:
            return False

    async def _market_hours_loop(self) -> None:
        """Monitor market hours and transition states (FIX-D004).

        Uses CalendarLoader for proper calendar-based transitions including
        holidays and early closes.
        """
        # Try to load calendar for proper market hours
        calendar = None
        try:
            from quantlab.calendar.loader import CalendarLoader
            calendar_name = getattr(self.config, 'calendar_name', 'nyse')
            loader = CalendarLoader()
            calendar = loader.load_builtin(calendar_name)
            if calendar:
                logger.info(f"Using calendar '{calendar_name}' for market hours")
        except Exception as e:
            logger.warning(f"Calendar not available, using simple time check: {e}")

        while self._running:
            try:
                now = datetime.now()

                # Determine if market is open
                market_open = False
                if calendar and hasattr(calendar, 'is_market_open'):
                    market_open = calendar.is_market_open(now)
                elif calendar and hasattr(calendar, 'is_open'):
                    market_open = calendar.is_open(now)
                else:
                    # Fallback to simple time check
                    current_time = now.time()
                    market_open = (
                        hasattr(self.config, 'market_open') and
                        hasattr(self.config, 'market_close') and
                        self.config.market_open <= current_time < self.config.market_close
                    )

                async with self._state_lock:
                    if self._state == DaemonState.ACTIVE and not market_open:
                        logger.info("Market closed, entering MARKET_CLOSED state")
                        self._state = DaemonState.MARKET_CLOSED
                        if self._heartbeat:
                            self._heartbeat.set_state(DaemonState.MARKET_CLOSED)
                        # Broadcast state change
                        self._broadcast_connection_status("market_closed", reason="Market hours ended")

                    elif self._state == DaemonState.MARKET_CLOSED and market_open:
                        logger.info("Market open, resuming ACTIVE state")
                        self._state = DaemonState.ACTIVE
                        if self._heartbeat:
                            self._heartbeat.set_state(DaemonState.ACTIVE)
                        # Broadcast state change
                        self._broadcast_connection_status("market_open", reason="Market hours started")

                await asyncio.sleep(60)  # Check every minute

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Market hours loop error: {e}")

    def _create_checkpoint(self) -> SessionCheckpoint:
        """Create a checkpoint from current state."""
        # Populate positions from PositionTracker
        positions = []
        for pos in self._position_tracker.get_positions_for_session(
            self.session_id, include_flat=False
        ):
            positions.append(
                CheckpointPosition(
                    symbol=pos.symbol,
                    quantity=pos.quantity,
                    avg_cost=pos.avg_entry_price,
                    unrealized_pnl=pos.unrealized_pnl,
                    side="long" if pos.is_long else "short",
                )
            )

        # Populate pending orders from OrderManager
        pending_orders = []
        for order in self._order_manager.get_open_orders(self.session_id):
            pending_orders.append(
                PendingOrder(
                    order_id=order.order_id,
                    symbol=order.symbol,
                    side=order.side.value,
                    quantity=order.quantity,
                    order_type=order.order_type.value,
                    limit_price=order.limit_price,
                    stop_price=order.stop_price,
                    time_in_force=order.time_in_force.value,
                    submitted_at=order.submitted_at,
                )
            )

        # Get exposure state
        exposure_snapshot = self._exposure_manager.snapshot()

        # Calculate P&L
        summary = self._position_tracker.get_summary(self.session_id)

        return SessionCheckpoint(
            session_id=self.session_id,
            strategy_path=self.config.strategy_path,
            state=self._state,
            positions=positions,
            pending_orders=pending_orders,
            current_exposure=exposure_snapshot.current_exposure,
            reserved_exposure=exposure_snapshot.reserved_exposure,
            realized_pnl=summary.total_realized_pnl,
            unrealized_pnl=summary.total_unrealized_pnl,
        )

    async def _restore_from_checkpoint(self, checkpoint: SessionCheckpoint) -> None:
        """Restore state from checkpoint."""
        self._state = checkpoint.state

        # Restore positions
        for cp_pos in checkpoint.positions:
            position = self._position_tracker.get_or_create_position(
                self.session_id, cp_pos.symbol
            )
            position.quantity = cp_pos.quantity
            position.avg_entry_price = cp_pos.avg_cost
            position.unrealized_pnl = cp_pos.unrealized_pnl

        # Restore pending orders
        for cp_order in checkpoint.pending_orders:
            order = Order(
                order_id=cp_order.order_id,
                session_id=self.session_id,
                symbol=cp_order.symbol,
                side=OrderSide(cp_order.side),
                order_type=OrderType(cp_order.order_type),
                quantity=cp_order.quantity,
                limit_price=cp_order.limit_price,
                stop_price=cp_order.stop_price,
                submitted_at=cp_order.submitted_at,
            )
            # Add order to manager's internal tracking
            self._order_manager._orders[order.order_id] = order
            if self.session_id not in self._order_manager._orders_by_session:
                self._order_manager._orders_by_session[self.session_id] = []
            self._order_manager._orders_by_session[self.session_id].append(order.order_id)

        # Restore exposure state
        self._exposure_manager._current_exposure = checkpoint.current_exposure
        self._exposure_manager._reserved_exposure = checkpoint.reserved_exposure

        # Restore position tracking in exposure manager
        for cp_pos in checkpoint.positions:
            self._exposure_manager._positions[cp_pos.symbol] = (
                cp_pos.quantity if cp_pos.side == "long" else -cp_pos.quantity
            )

        logger.info(
            f"Restored state: {self._state}, "
            f"{len(checkpoint.positions)} positions, "
            f"{len(checkpoint.pending_orders)} pending orders"
        )

    async def _cleanup(self) -> None:
        """Cleanup on shutdown."""
        async with self._state_lock:
            self._running = False
            self._state = DaemonState.STOPPED

        # FIX-D004: Wait for pending orders to complete before cleanup
        await self._wait_for_pending_orders()

        # Stop components
        await self._exposure_manager.stop_cleanup()

        if self._power_manager:
            await self._power_manager.stop()

        if self._heartbeat:
            await self._heartbeat.stop()

        if self._watchdog:
            await self._watchdog.stop()

        if self._ipc_server:
            await self._ipc_server.stop()

        if self._reliability_manager:
            await self._reliability_manager.stop()

        # Cleanup files
        self._signal_handler.uninstall()
        self._pid_file.release()
        self._token_manager.delete()

        # Log session end and close audit ledger
        if self._audit_ledger:
            summary = self._position_tracker.get_summary(self.session_id)
            log_session_end(
                self._audit_ledger,
                final_equity=float(summary.total_equity) if summary else 0.0,
                reason="graceful_shutdown",
            )
            self._audit_ledger.close()
            logger.info("Audit ledger closed")

        # Keep checkpoint for recovery, unless clean shutdown
        if self._state == DaemonState.STOPPED:
            self._checkpoint_manager.delete()

        logger.info("Daemon cleanup complete")

    async def _wait_for_pending_orders(self, timeout: float = 30.0) -> None:
        """
        Wait for pending orders to fill or cancel before shutdown (FIX-D004).

        This prevents data loss from orders that were submitted but not yet
        filled when the daemon stops.

        Args:
            timeout: Maximum time to wait for orders (default 30 seconds)
        """
        from quantlab.trading.orders import OrderStatus

        pending_statuses = {OrderStatus.PENDING, OrderStatus.SUBMITTED, OrderStatus.ACCEPTED}
        start_time = asyncio.get_event_loop().time()

        while True:
            pending_orders = [
                o for o in self._order_manager.get_orders_for_session(self.session_id)
                if o.status in pending_statuses
            ]

            if not pending_orders:
                logger.info("All pending orders completed")
                break

            elapsed = asyncio.get_event_loop().time() - start_time
            if elapsed >= timeout:
                # Attempt to cancel remaining orders
                logger.warning(
                    f"Timeout waiting for {len(pending_orders)} pending orders, "
                    "attempting cancellation"
                )
                for order in pending_orders:
                    if self._broker and order.broker_order_id:
                        try:
                            await self._broker.cancel_order(order.broker_order_id)
                            logger.info(f"Cancelled pending order: {order.order_id}")
                        except Exception as e:
                            logger.error(f"Failed to cancel order {order.order_id}: {e}")
                break

            logger.info(
                f"Waiting for {len(pending_orders)} pending orders "
                f"({timeout - elapsed:.1f}s remaining)"
            )
            await asyncio.sleep(1.0)

    def _register_ipc_handlers(self) -> None:
        """Register IPC request handlers.

        FIX-CGP-002: Register both spec-compliant names (session.pause) and
        short names (pause) for backward compatibility.
        """
        if not self._ipc_server:
            return

        # Health and status - spec-compliant names (FIX-CGP-002)
        self._ipc_server.register_handler("health.check", self._handle_health)
        self._ipc_server.register_handler("status.get", self._handle_status)
        self._ipc_server.register_handler("health", self._handle_health)  # Alias
        self._ipc_server.register_handler("status", self._handle_status)  # Alias

        # Session control - spec-compliant names (FIX-CGP-002)
        self._ipc_server.register_handler("session.start", self._handle_session_start)
        self._ipc_server.register_handler("session.pause", self._handle_pause)
        self._ipc_server.register_handler("session.resume", self._handle_resume)
        self._ipc_server.register_handler("session.stop", self._handle_stop)
        # Backward-compatible aliases
        self._ipc_server.register_handler("pause", self._handle_pause)
        self._ipc_server.register_handler("resume", self._handle_resume)
        self._ipc_server.register_handler("stop", self._handle_stop)

        # Order management - spec-compliant names
        self._ipc_server.register_handler("order.submit", self._handle_order_submit)
        self._ipc_server.register_handler("order.cancel", self._handle_order_cancel)
        self._ipc_server.register_handler("order.modify", self._handle_order_modify)  # FIX-D003

        # State query handlers (FIX-CGP-004)
        self._ipc_server.register_handler("positions.get", self._handle_positions_get)
        self._ipc_server.register_handler("orders.get", self._handle_orders_get)
        self._ipc_server.register_handler("fills.get", self._handle_fills_get)

        # Emergency flatten - spec-compliant name (FIX-CGP-002)
        self._ipc_server.register_handler("flatten.request", self._handle_flatten)
        self._ipc_server.register_handler("flatten", self._handle_flatten)  # Alias

        # Circuit breaker
        self._ipc_server.register_handler("circuit_breaker.reset", self._handle_circuit_breaker_reset)
        self._ipc_server.register_handler("circuit_breaker.status", self._handle_circuit_breaker_status)

        # Exposure metrics (FIX-R005)
        self._ipc_server.register_handler("exposure.metrics", self._handle_exposure_metrics)

        # Update and credential management
        self._ipc_server.register_handler("update.check_allowed", self._handle_update_check_allowed)
        self._ipc_server.register_handler("credentials.get", self._handle_credentials_get)
        self._ipc_server.register_handler("credentials.set", self._handle_credentials_set)  # FIX-CGP-008
        self._ipc_server.register_handler("credentials.status", self._handle_credentials_status)

        # Reconciliation
        self._ipc_server.register_handler("reconciliation.trigger", self._handle_reconciliation_trigger)
        self._ipc_server.register_handler("reconciliation.status", self._handle_reconciliation_status)
        self._ipc_server.register_handler("reconciliation.apply", self._handle_reconciliation_apply)
        self._ipc_server.register_handler("reconciliation.set_interval", self._handle_reconciliation_set_interval)  # FIX-T003

        # Drift detection (FIX-T004)
        self._ipc_server.register_handler("drift.status", self._handle_drift_status)

        # QIC-specific handlers (AUDIT FIX III-QI2)
        from quantlab.daemon.qic_handlers import QicHandlers
        self._qic_handlers = QicHandlers()
        self._qic_handlers.register(self._ipc_server)

    def _handle_health(self, params: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG002
        """Handle health check request."""
        health = self._health_checker.check()
        return health.to_dict()

    def _handle_status(self, params: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG002
        """Handle status request."""
        positions = self._position_tracker.get_positions_for_session(
            self.session_id, include_flat=False
        )
        pending_orders = self._order_manager.get_open_orders(self.session_id)
        return {
            "session_id": self.session_id,
            "state": self._state,
            "strategy": self.config.strategy_path,
            "broker_connected": self._broker_connected,
            "position_count": len(positions),
            "pending_order_count": len(pending_orders),
        }

    async def _handle_pause(self, params: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG002
        """Handle pause request."""
        async with self._state_lock:
            if self._state == DaemonState.ACTIVE:
                self._state = DaemonState.PAUSED
                logger.info("Session paused")
                return {"status": "paused"}
            return {"status": self._state, "error": "Cannot pause from current state"}

    async def _handle_resume(self, params: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG002
        """Handle resume request."""
        async with self._state_lock:
            if self._state == DaemonState.PAUSED:
                self._state = DaemonState.ACTIVE
                logger.info("Session resumed")
                return {"status": "active"}
            return {"status": self._state, "error": "Cannot resume from current state"}

    async def _handle_stop(self, params: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG002
        """Handle stop request."""
        logger.info("Stop requested via IPC")
        self._request_shutdown()
        return {"status": "stopping"}

    async def _handle_order_submit(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle order submission with RiskMonitor and ExposureManager integration."""
        # Validate required parameters
        required = ["symbol", "side", "quantity", "order_type"]
        for field in required:
            if field not in params:
                return {"error": f"Missing required field: {field}"}

        symbol = params["symbol"]
        side = OrderSide(params["side"])
        quantity = Decimal(str(params["quantity"]))
        order_type = OrderType(params["order_type"])
        limit_price = Decimal(str(params["limit_price"])) if params.get("limit_price") else None
        stop_price = Decimal(str(params["stop_price"])) if params.get("stop_price") else None

        # Check if trading is allowed via RiskMonitor
        risk_status = self._risk_monitor.get_status(self.session_id)
        if not risk_status.is_trading_allowed:
            return {
                "error": "Trading halted",
                "reason": "Risk limits breached - trading not allowed",
                "violations": [v.message for v in risk_status.violations],
            }

        # Check circuit breaker status (consecutive losses, daily limits)
        cb_allowed, cb_reason = self._circuit_breaker.check_order_allowed()
        if not cb_allowed:
            return {
                "error": "Circuit breaker open",
                "reason": cb_reason,
                "circuit_breaker_status": self._circuit_breaker.status(),
            }

        # Create order request
        order_request = OrderRequest(
            session_id=self.session_id,
            symbol=symbol,
            side=side,
            order_type=order_type,
            quantity=quantity,
            limit_price=limit_price,
            stop_price=stop_price,
        )

        # Validate order
        errors = order_request.validate()
        if errors:
            return {"error": "; ".join(errors)}

        # Create a temporary order for risk checking
        temp_order = Order(
            order_id=f"temp-{datetime.now().timestamp()}",
            session_id=self.session_id,
            symbol=symbol,
            side=side,
            order_type=order_type,
            quantity=quantity,
            limit_price=limit_price,
            stop_price=stop_price,
        )

        # Check risk limits via RiskMonitor
        risk_violations = self._risk_monitor.check_order(self.session_id, temp_order)
        if risk_violations:
            violation_messages = [v.message for v in risk_violations]
            logger.warning(f"Order rejected by risk manager: {violation_messages}")
            return {
                "error": "Risk check failed",
                "violations": violation_messages,
            }

        # Check exposure limits via ExposureManager
        exposure_request = ExposureOrderRequest(
            order_id=f"order-{datetime.now().timestamp()}",
            symbol=symbol,
            side=ExposureSide.BUY if side == OrderSide.BUY else ExposureSide.SELL,
            quantity=quantity,
            price=limit_price,
            order_type=order_type.value,
        )

        # Get price estimate for market orders
        price_estimate = None
        if order_type == OrderType.MARKET and self._broker:
            try:
                quote = await self._broker.get_quote(symbol)
                if quote:
                    price_estimate = Decimal(str(quote.mid_price or quote.ask_price or 0))
            except Exception:
                pass

        # Reserve exposure
        reservation = self._exposure_manager.reserve(exposure_request, price_estimate)
        if not reservation.success:
            logger.warning(f"Order rejected: {reservation.reason}")
            return {
                "error": f"Exposure limit breach: requested {reservation.requested}, "
                f"available {reservation.available}",
                "reason": reservation.reason,
            }

        # Create order
        try:
            order = self._order_manager.create_order(order_request)
            order.order_id = exposure_request.order_id  # Use same ID for tracking

            # Submit to broker if connected
            if self._broker and self._broker_connected:
                try:
                    broker_order_id = await self._broker.submit_order(order)
                    self._order_manager.submit_order(order.order_id, broker_order_id)
                except Exception as e:
                    # Release reservation on broker failure
                    self._exposure_manager.release(order.order_id)
                    self._order_manager.reject_order(order.order_id, str(e))
                    # Log order rejection to audit ledger
                    if self._audit_ledger:
                        log_order_reject(
                            self._audit_ledger,
                            order_id=order.order_id,
                            reason=str(e),
                            error_code="BROKER_FAILURE",
                        )
                    return {"error": f"Broker submission failed: {e}"}
            else:
                self._order_manager.submit_order(order.order_id)

            # Log order submission to audit ledger
            if self._audit_ledger:
                log_order_submit(
                    self._audit_ledger,
                    order_id=order.order_id,
                    symbol=order.symbol,
                    side=order.side.value,
                    quantity=float(order.quantity),
                    order_type=order.order_type.value,
                    limit_price=float(order.limit_price) if order.limit_price else None,
                    stop_price=float(order.stop_price) if order.stop_price else None,
                )

            self._checkpoint_manager.mark_dirty()
            logger.info(f"Order submitted: {order.order_id}")
            return {"order_id": order.order_id, "status": "submitted"}

        except Exception as e:
            # Release reservation on any failure
            self._exposure_manager.release(exposure_request.order_id)
            logger.error(f"Order submission failed: {e}")
            return {"error": str(e)}

    async def _handle_order_cancel(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle order cancellation."""
        order_id = params.get("order_id")
        if not order_id:
            return {"error": "Missing order_id parameter"}

        logger.info(f"Order cancel requested: {order_id}")

        # Get the order from order manager
        order = self._order_manager.get_order(order_id)
        if not order:
            return {"error": f"Order not found: {order_id}", "order_id": order_id}

        # Check if order is already in a terminal state
        from quantlab.trading.orders import OrderStatus
        terminal_states = {OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.REJECTED, OrderStatus.EXPIRED}
        if order.status in terminal_states:
            return {
                "order_id": order_id,
                "status": order.status.value,
                "error": f"Order already in terminal state: {order.status.value}",
            }

        # Cancel with broker if connected
        if self._broker and self._broker_connected:
            try:
                broker_order_id = order.broker_order_id or order_id
                cancelled = await self._broker.cancel_order(broker_order_id)
                if not cancelled:
                    return {"error": "Broker failed to cancel order", "order_id": order_id}
            except Exception as e:
                logger.error(f"Broker cancel failed for {order_id}: {e}")
                return {"error": f"Broker cancel failed: {e}", "order_id": order_id}

        # Update order status in order manager
        self._order_manager.cancel_order(order_id)

        # Release any exposure reservation
        self._exposure_manager.release(order_id)

        # Log order cancellation to audit ledger
        if self._audit_ledger:
            log_order_cancel(
                self._audit_ledger,
                order_id=order_id,
                reason="user_request",
            )

        self._checkpoint_manager.mark_dirty()
        logger.info(f"Order cancelled: {order_id}")
        return {"order_id": order_id, "status": "cancelled"}

    async def _handle_flatten(self, params: dict[str, Any]) -> dict[str, Any]:
        """
        Handle flatten (close all positions) request using two-stage protocol.

        Stage 1: Submit marketable limit orders (aggressive limits)
        Stage 2: If Stage 1 doesn't fill, submit market orders

        This is the emergency kill-switch for closing all positions.
        """
        reason_str = params.get("reason", "user_request")
        try:
            reason = FlattenReason(reason_str)
        except ValueError:
            reason = FlattenReason.USER_REQUEST

        logger.warning(f"EMERGENCY FLATTEN requested - reason: {reason.value}")
        self._checkpoint_manager.mark_dirty()

        # FIX-T001-TRADING: Audit log flatten start
        positions = self._position_tracker.get_positions_for_session(
            self.session_id, include_flat=False
        )
        if self._audit_ledger:
            log_position_snapshot(
                self._audit_ledger,
                session_id=self.session_id,
                positions=[
                    {
                        "symbol": p.symbol,
                        "quantity": float(p.quantity),
                        "avg_entry_price": float(p.avg_entry_price),
                    }
                    for p in positions
                ],
                reason=f"emergency_flatten_start_{reason.value}",
            )

        # Configure flatten with progress callback
        config = FlattenConfig(
            on_progress=self._on_flatten_progress,
            on_complete=self._on_flatten_complete,
        )

        # Execute emergency flatten
        flattener = EmergencyFlatten(
            session_id=self.session_id,
            broker=self._broker,
            order_manager=self._order_manager,
            position_tracker=self._position_tracker,
            config=config,
        )

        result = await flattener.execute(reason)

        # FIX-T001-TRADING: Audit log flatten complete
        if self._audit_ledger:
            remaining = self._position_tracker.get_positions_for_session(
                self.session_id, include_flat=False
            )
            log_position_snapshot(
                self._audit_ledger,
                session_id=self.session_id,
                positions=[
                    {
                        "symbol": p.symbol,
                        "quantity": float(p.quantity),
                        "avg_entry_price": float(p.avg_entry_price),
                    }
                    for p in remaining
                ],
                reason=f"emergency_flatten_complete_{reason.value}_flattened={result.positions_flattened}_remaining={result.positions_remaining}",
            )

        # Checkpoint after flatten
        self._checkpoint_manager.mark_dirty()

        return result.to_dict()

    def _on_flatten_progress(self, result: FlattenResult) -> None:
        """Callback for flatten progress updates."""
        if self._ipc_server:
            notification = Notification(
                message_type=MessageType.POSITIONS,
                params={
                    "type": "flatten_progress",
                    "stage": result.stage.value,
                    "positionsFlattened": result.positions_flattened,
                    "positionsRemaining": result.positions_remaining,
                },
                session_id=self.session_id,
            )
            asyncio.create_task(self._ipc_server.broadcast(notification))

    def _on_flatten_complete(self, result: FlattenResult) -> None:
        """Callback for flatten completion."""
        logger.info(
            f"Flatten complete: {result.positions_flattened} positions closed, "
            f"{result.positions_remaining} remaining"
        )
        if self._ipc_server:
            notification = Notification(
                message_type=MessageType.POSITIONS,
                params={
                    "type": "flatten_complete",
                    "result": result.to_dict(),
                },
                session_id=self.session_id,
            )
            asyncio.create_task(self._ipc_server.broadcast(notification))

    async def _handle_circuit_breaker_reset(self, params: dict[str, Any]) -> dict[str, Any]:
        """
        Handle circuit breaker reset request.

        IMPORTANT: This requires explicit user acknowledgment.
        The user must confirm they understand why the breaker tripped
        before trading can resume.
        """
        acknowledged_by = params.get("acknowledged_by", "unknown")
        acknowledgment_reason = params.get("acknowledgment_reason", "")

        if not acknowledged_by or acknowledged_by == "unknown":
            return {
                "error": "User acknowledgment required",
                "message": "Must provide acknowledged_by parameter with user ID",
            }

        # Reset the circuit breaker
        success = self._circuit_breaker.reset(acknowledged_by=acknowledged_by)

        if success:
            logger.info(f"Circuit breaker reset by {acknowledged_by}: {acknowledgment_reason}")

            # Also reset the consecutive loss tracker in the risk manager
            if hasattr(self._cb_risk_manager, '_loss_tracker'):
                self._cb_risk_manager._loss_tracker.reset()

            return {
                "status": "reset",
                "acknowledged_by": acknowledged_by,
                "message": "Trading can resume",
            }
        else:
            return {
                "status": "already_closed",
                "message": "Circuit breaker was already closed",
            }

    def _handle_circuit_breaker_status(self, params: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG002
        """Get current circuit breaker status."""
        cb_status = self._circuit_breaker.status()
        risk_status = self._cb_risk_manager.status()

        return {
            "circuit_breaker": cb_status,
            "risk_manager": risk_status,
        }

    def _handle_exposure_metrics(self, params: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG002
        """Return exposure metrics for monitoring (FIX-R005)."""
        metrics = self._exposure_manager.get_metrics()
        return {"metrics": metrics}

    def _handle_update_check_allowed(self, params: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG002
        """
        Check if software updates are allowed.

        Updates are BLOCKED when:
        - Daemon is in ACTIVE state (live trading)
        - There are open positions
        - There are pending orders

        This prevents surprise behavior during live trading.

        Returns:
            allowed: True if updates are safe
            reason: Explanation if blocked
        """
        positions = self._position_tracker.get_positions_for_session(
            self.session_id, include_flat=False
        )
        pending_orders = self._order_manager.get_open_orders(self.session_id)

        # Block updates during active trading
        if self._state == DaemonState.ACTIVE:
            return {
                "allowed": False,
                "reason": "Updates blocked during active trading session",
                "state": self._state,
                "positions": len(positions),
                "pending_orders": len(pending_orders),
            }

        # Block if there are open positions
        if positions:
            return {
                "allowed": False,
                "reason": f"Updates blocked: {len(positions)} open position(s)",
                "state": self._state,
                "positions": len(positions),
            }

        # Block if there are pending orders
        if pending_orders:
            return {
                "allowed": False,
                "reason": f"Updates blocked: {len(pending_orders)} pending order(s)",
                "state": self._state,
                "pending_orders": len(pending_orders),
            }

        # Updates allowed when paused, market closed, or stopped with no positions
        return {
            "allowed": True,
            "reason": "No active trading, updates allowed",
            "state": self._state,
        }

    def _handle_credentials_get(self, params: dict[str, Any]) -> dict[str, Any]:
        """
        Get broker credentials via SecretsManager.

        This allows the UI to request credentials from the daemon, which
        handles the fallback chain (env vars → encrypted file).

        Args:
            params: Must contain 'broker' key

        Returns:
            Credentials dict (keys vary by broker) or error
        """
        broker = params.get("broker")
        if not broker:
            return {"error": "Missing 'broker' parameter"}

        try:
            credentials = self._secrets_manager.get_broker_credentials(broker)
            if not credentials:
                return {
                    "error": f"No credentials found for broker: {broker}",
                    "broker": broker,
                    "hint": f"Set QUANTLAB_SECRET_{broker.upper()}_* environment variables "
                           f"or store in encrypted secrets file",
                }
            # Return credential keys but mask values for security
            return {
                "broker": broker,
                "available_keys": list(credentials.keys()),
                "has_credentials": True,
            }
        except Exception as e:
            logger.error(f"Error retrieving credentials for {broker}: {e}")
            return {"error": str(e), "broker": broker}

    def _handle_credentials_status(self, params: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG002
        """
        Check status of credentials availability.

        Returns information about which credential sources are available
        without revealing actual credential values.
        """
        import os

        # Check environment variables
        env_vars = [k for k in os.environ.keys() if k.startswith("QUANTLAB_SECRET_")]
        legacy_vars = [k for k in os.environ.keys() if k.startswith("ALPACA_")]

        # Check known brokers
        brokers_status = {}
        for broker in ["alpaca", "interactive_brokers", "tradier"]:
            creds = self._secrets_manager.get_broker_credentials(broker)
            brokers_status[broker] = {
                "configured": bool(creds),
                "keys": list(creds.keys()) if creds else [],
            }

        return {
            "env_secret_count": len(env_vars),
            "legacy_env_count": len(legacy_vars),
            "brokers": brokers_status,
        }

    async def _handle_reconciliation_trigger(
        self, params: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Trigger position reconciliation between local tracking and broker.

        Args:
            params: Optional configuration (auto_correct: bool)

        Returns:
            ReconciliationResult as dictionary
        """
        if not self._broker:
            return {"error": "Broker not connected"}

        try:
            # Create reconciliation config from params
            auto_correct = params.get("auto_correct", False)
            config = ReconciliationConfig(
                auto_correct=auto_correct,
                sync_direction="from_broker",
            )

            # Create reconciler and run
            reconciler = PositionReconciler(config)
            result = await reconciler.reconcile(
                session_id=self.session_id,
                broker=self._broker,
                position_tracker=self._position_tracker,
            )

            # Store for later retrieval
            self._last_reconciliation_result = result

            return result.to_dict()

        except Exception as e:
            logger.error(f"Reconciliation trigger failed: {e}")
            return {"error": str(e)}

    def _handle_reconciliation_status(
        self, params: dict[str, Any]  # noqa: ARG002
    ) -> dict[str, Any]:
        """
        Get the status of the last reconciliation.

        Returns:
            Last ReconciliationResult or status indicating no reconciliation run
        """
        if self._last_reconciliation_result is None:
            return {
                "status": "no_reconciliation",
                "message": "No reconciliation has been triggered yet",
            }

        return self._last_reconciliation_result.to_dict()

    async def _handle_reconciliation_apply(
        self, params: dict[str, Any]  # noqa: ARG002
    ) -> dict[str, Any]:
        """
        Apply corrections from the last reconciliation result.

        Returns:
            Status of the correction application
        """
        if self._last_reconciliation_result is None:
            return {
                "error": "No reconciliation result available",
                "hint": "Run reconciliation.trigger first",
            }

        if not self._last_reconciliation_result.has_discrepancies:
            return {
                "status": "no_action",
                "message": "No discrepancies to correct",
            }

        try:
            # Create reconciler with auto-correct enabled
            config = ReconciliationConfig(
                auto_correct=True,
                sync_direction="from_broker",
            )
            reconciler = PositionReconciler(config)

            # Apply corrections
            success = reconciler.auto_correct(
                self._last_reconciliation_result,
                self._position_tracker,
            )

            if success:
                # Clear the stored result after applying corrections
                corrected_count = len(
                    self._last_reconciliation_result.corrections_applied
                )
                self._last_reconciliation_result = None
                return {
                    "status": "corrected",
                    "corrections_applied": corrected_count,
                }
            else:
                return {
                    "status": "partial",
                    "message": "Some corrections could not be applied",
                }

        except Exception as e:
            logger.error(f"Reconciliation apply failed: {e}")
            return {"error": str(e)}

    def _handle_reconciliation_set_interval(self, params: dict[str, Any]) -> dict[str, Any]:
        """FIX-T003: Set the periodic reconciliation interval (seconds).

        Args:
            params: {"interval": float} — interval in seconds (minimum 30)

        Returns:
            Confirmation with new interval
        """
        interval = params.get("interval")
        if interval is None:
            return {"error": "Missing 'interval' parameter"}

        interval = float(interval)
        if interval < 30.0:
            return {"error": "Reconciliation interval must be at least 30 seconds"}

        old_interval = self._reconciliation_interval
        self._reconciliation_interval = interval
        logger.info(f"Reconciliation interval changed: {old_interval}s -> {interval}s")
        return {
            "status": "updated",
            "previous_interval": old_interval,
            "new_interval": interval,
        }

    def _handle_drift_status(self, params: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG002
        """FIX-T004: Return current drift detection status and recent events.

        Returns:
            Drift summary with event counts and health status
        """
        try:
            summary = self._drift_detector.get_summary()
            return {
                "status": "ok",
                "report": summary.to_dict(),
            }
        except Exception as e:
            logger.error(f"Drift status failed: {e}")
            return {"error": str(e)}

    async def _handle_session_start(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle session.start IPC request (FIX-CGP-002).

        This is called when the UI wants to start the session after daemon is running.
        The daemon is already started, so this mainly transitions state.
        """
        async with self._state_lock:
            if self._state == DaemonState.STARTING:
                self._state = DaemonState.ACTIVE
                logger.info("Session started via IPC")
                return {"status": "started", "state": self._state}
            elif self._state == DaemonState.PAUSED:
                self._state = DaemonState.ACTIVE
                logger.info("Session resumed via session.start")
                return {"status": "resumed", "state": self._state}
            elif self._state == DaemonState.ACTIVE:
                return {"status": "already_active", "state": self._state}
            else:
                return {
                    "status": "error",
                    "error": f"Cannot start from state: {self._state}",
                    "state": self._state,
                }

    async def _handle_order_modify(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle order.modify IPC request (FIX-D003).

        Modify a pending order's quantity or price.
        """
        order_id = params.get("order_id")
        if not order_id:
            return {"error": "Missing order_id parameter"}

        new_quantity = params.get("quantity")
        new_limit_price = params.get("limit_price")
        new_stop_price = params.get("stop_price")

        # Get the order
        order = self._order_manager.get_order(order_id)
        if not order:
            return {"error": f"Order not found: {order_id}"}

        from quantlab.trading.orders import OrderStatus
        if order.status not in {OrderStatus.PENDING, OrderStatus.SUBMITTED}:
            return {"error": f"Cannot modify order in state: {order.status.value}"}

        modifications = {}
        if new_quantity is not None:
            modifications["quantity"] = Decimal(str(new_quantity))
        if new_limit_price is not None:
            modifications["limit_price"] = Decimal(str(new_limit_price))
        if new_stop_price is not None:
            modifications["stop_price"] = Decimal(str(new_stop_price))

        if not modifications:
            return {"error": "No modifications provided"}

        # Modify with broker if connected
        if self._broker and self._broker_connected:
            try:
                broker_order_id = order.broker_order_id or order_id
                await self._broker.modify_order(broker_order_id, **modifications)
            except Exception as e:
                logger.error(f"Broker modify failed for {order_id}: {e}")
                return {"error": f"Broker modify failed: {e}"}

        # Update exposure reservation if quantity/price changed
        if "quantity" in modifications or "limit_price" in modifications:
            result = self._exposure_manager.modify(
                order_id,
                new_quantity=modifications.get("quantity"),
                new_price=modifications.get("limit_price"),
            )
            if not result.success:
                return {"error": f"Exposure modification failed: {result.reason}"}

        # Log to audit ledger
        if self._audit_ledger:
            self._audit_ledger.log_event(
                "order_modified",
                {
                    "order_id": order_id,
                    "modifications": {k: str(v) for k, v in modifications.items()},
                },
            )

        logger.info(f"Order modified: {order_id} -> {modifications}")
        return {"order_id": order_id, "status": "modified", "modifications": {k: str(v) for k, v in modifications.items()}}

    def _handle_positions_get(self, params: dict[str, Any]) -> dict[str, Any]:  # noqa: ARG002
        """Handle positions.get IPC request (FIX-CGP-004).

        Return current positions for UI hydration.
        """
        positions = []
        for pos in self._position_tracker.get_positions_for_session(
            self.session_id, include_flat=False
        ):
            positions.append({
                "symbol": pos.symbol,
                "quantity": str(pos.quantity),
                "avg_cost": str(pos.avg_entry_price),
                "current_price": str(pos.current_price) if hasattr(pos, 'current_price') and pos.current_price else None,
                "market_value": str(pos.market_value) if hasattr(pos, 'market_value') and pos.market_value else None,
                "unrealized_pnl": str(pos.unrealized_pnl),
                "realized_pnl": str(pos.realized_pnl) if hasattr(pos, 'realized_pnl') else "0",
                "side": "long" if pos.is_long else "short",
            })

        return {
            "positions": positions,
            "count": len(positions),
            "timestamp": datetime.now().isoformat(),
        }

    def _handle_orders_get(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle orders.get IPC request (FIX-CGP-004).

        Return current orders for UI hydration.
        """
        from quantlab.trading.orders import OrderStatus

        status_filter = params.get("status")  # Optional: "pending", "filled", "cancelled"
        orders = []

        all_orders = self._order_manager.get_orders_for_session(self.session_id)
        for order in all_orders:
            # Filter by status if specified
            if status_filter:
                if status_filter == "pending" and order.status not in {OrderStatus.PENDING, OrderStatus.SUBMITTED}:
                    continue
                elif status_filter == "filled" and order.status != OrderStatus.FILLED:
                    continue
                elif status_filter == "cancelled" and order.status != OrderStatus.CANCELLED:
                    continue

            orders.append({
                "order_id": order.order_id,
                "symbol": order.symbol,
                "side": order.side.value,
                "order_type": order.order_type.value,
                "quantity": str(order.quantity),
                "filled_quantity": str(order.filled_quantity) if hasattr(order, 'filled_quantity') else "0",
                "limit_price": str(order.limit_price) if order.limit_price else None,
                "stop_price": str(order.stop_price) if order.stop_price else None,
                "status": order.status.value,
                "submitted_at": order.submitted_at.isoformat() if order.submitted_at else None,
            })

        return {
            "orders": orders,
            "count": len(orders),
            "timestamp": datetime.now().isoformat(),
        }

    def _handle_fills_get(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle fills.get IPC request (FIX-CGP-004).

        Return recent fills for UI hydration.
        """
        limit = params.get("limit", 100)
        fills = []

        # Get fills from order manager or a fill tracker if available
        if hasattr(self._order_manager, 'get_fills'):
            recent_fills = self._order_manager.get_fills(self.session_id, limit=limit)
            for fill in recent_fills:
                fills.append({
                    "fill_id": fill.fill_id if hasattr(fill, 'fill_id') else str(id(fill)),
                    "order_id": fill.order_id,
                    "symbol": fill.symbol,
                    "side": fill.side.value if hasattr(fill.side, 'value') else str(fill.side),
                    "quantity": str(fill.quantity),
                    "price": str(fill.price),
                    "realized_pnl": str(fill.realized_pnl) if hasattr(fill, 'realized_pnl') and fill.realized_pnl else None,
                    "timestamp": fill.timestamp.isoformat() if hasattr(fill, 'timestamp') else None,
                })

        return {
            "fills": fills,
            "count": len(fills),
            "timestamp": datetime.now().isoformat(),
        }

    async def _handle_credentials_set(self, params: dict[str, Any]) -> dict[str, Any]:
        """Handle credentials.set IPC request (FIX-CGP-008).

        Securely store credentials in daemon's encrypted store.
        This allows the UI to sync credentials to the daemon.
        """
        broker = params.get("broker")
        credentials = params.get("credentials")

        if not broker:
            return {"success": False, "error": "Missing 'broker' parameter"}
        if not credentials:
            return {"success": False, "error": "Missing 'credentials' parameter"}

        try:
            # Store via secrets manager
            self._secrets_manager.set_broker_credentials(broker, credentials)
            logger.info(f"Credentials stored for broker: {broker}")
            return {"success": True, "broker": broker}
        except Exception as e:
            logger.error(f"Failed to store credentials for {broker}: {e}")
            return {"success": False, "error": str(e)}

    def process_fill(
        self,
        order_id: str,
        fill_qty: Decimal,
        fill_price: Decimal,
        commission: Decimal = Decimal("0"),
    ) -> None:
        """
        Process an order fill and update risk metrics.

        Called when broker reports a fill.

        Args:
            order_id: Order ID
            fill_qty: Filled quantity
            fill_price: Fill price
            commission: Commission charged
        """
        order = self._order_manager.get_order(order_id)
        if not order:
            logger.warning(f"Fill for unknown order: {order_id}")
            return

        # Calculate P&L for closing trades
        position = self._position_tracker.get_position(self.session_id, order.symbol)
        realized_pnl = Decimal("0")

        if position and position.quantity != 0:
            # Check if this is a closing trade
            is_closing = (
                (position.is_long and order.side == OrderSide.SELL) or
                (position.is_short and order.side == OrderSide.BUY)
            )

            if is_closing:
                # Calculate realized P&L
                close_qty = min(abs(position.quantity), fill_qty)
                if position.is_long:
                    realized_pnl = (fill_price - position.avg_entry_price) * close_qty
                else:
                    realized_pnl = (position.avg_entry_price - fill_price) * close_qty

                # Subtract commission
                realized_pnl -= commission

        # Update risk monitor with realized P&L
        if realized_pnl != 0:
            self._risk_monitor.update_daily_pnl(self.session_id, realized_pnl)

            # Record trade result for consecutive loss tracking and daily limits
            # This may trigger circuit breaker if thresholds are exceeded
            self._cb_risk_manager.record_trade_result(realized_pnl)

            # FIX-T004: Record trade result for drift detection
            is_win = realized_pnl > 0
            drift_events = self._drift_detector.record_trade_result(realized_pnl, is_win)
            for de in drift_events:
                self._handle_drift_event(de)

        # Release exposure reservation
        self._exposure_manager.release(order_id)

        # Log fill to audit ledger
        if self._audit_ledger:
            import uuid
            log_order_fill(
                self._audit_ledger,
                order_id=order_id,
                fill_id=str(uuid.uuid4()),  # Generate unique fill ID
                filled_qty=float(fill_qty),
                fill_price=float(fill_price),
                commission=float(commission),
            )

        # Update position tracking (this would be done by PositionTracker)
        self._checkpoint_manager.mark_dirty()

        logger.info(
            f"Processed fill: {order_id}, qty={fill_qty}, price={fill_price}, "
            f"realized_pnl={realized_pnl}"
        )

        # Broadcast fill notification (FIX-CGP-005)
        self._broadcast_fill_update(order_id, order.symbol, fill_qty, fill_price, realized_pnl)

        # Broadcast position update if position changed (FIX-CGP-005)
        position = self._position_tracker.get_position(self.session_id, order.symbol)
        if position:
            self._broadcast_position_update(position)

    # =========================================================================
    # State notification broadcast methods (FIX-CGP-005)
    # =========================================================================

    def _broadcast_position_update(self, position: Position) -> None:
        """Broadcast position update to all connected clients (FIX-CGP-005)."""
        if not self._ipc_server:
            return

        notification = Notification(
            message_type=MessageType.POSITIONS,  # Will be "positions.update"
            params={
                "symbol": position.symbol,
                "quantity": str(position.quantity),
                "avg_cost": str(position.avg_entry_price),
                "current_price": str(position.current_price) if hasattr(position, 'current_price') and position.current_price else None,
                "market_value": str(position.market_value) if hasattr(position, 'market_value') and position.market_value else None,
                "unrealized_pnl": str(position.unrealized_pnl),
                "realized_pnl": str(position.realized_pnl) if hasattr(position, 'realized_pnl') else "0",
                "change_type": "updated",
            },
            session_id=self.session_id,
        )
        asyncio.create_task(self._ipc_server.broadcast(notification))

    def _broadcast_order_update(self, order: Order) -> None:
        """Broadcast order update to all connected clients (FIX-CGP-005)."""
        if not self._ipc_server:
            return

        notification = Notification(
            message_type=MessageType.ORDERS,  # Will be "orders.update"
            params={
                "order_id": order.order_id,
                "symbol": order.symbol,
                "status": order.status.value,
                "filled_quantity": str(order.filled_quantity) if hasattr(order, 'filled_quantity') else "0",
                "remaining_quantity": str(order.quantity - (order.filled_quantity if hasattr(order, 'filled_quantity') else Decimal("0"))),
                "avg_fill_price": str(order.avg_fill_price) if hasattr(order, 'avg_fill_price') and order.avg_fill_price else None,
            },
            session_id=self.session_id,
        )
        asyncio.create_task(self._ipc_server.broadcast(notification))

    def _broadcast_fill_update(
        self,
        order_id: str,
        symbol: str,
        fill_qty: Decimal,
        fill_price: Decimal,
        realized_pnl: Decimal,
    ) -> None:
        """Broadcast fill update to all connected clients (FIX-CGP-005)."""
        if not self._ipc_server:
            return

        import uuid
        notification = Notification(
            message_type=MessageType.FILLS,  # Will be "fills.update"
            params={
                "fill_id": str(uuid.uuid4()),
                "order_id": order_id,
                "symbol": symbol,
                "quantity": str(fill_qty),
                "price": str(fill_price),
                "realized_pnl": str(realized_pnl) if realized_pnl else None,
                "timestamp": datetime.now().isoformat(),
            },
            session_id=self.session_id,
        )
        asyncio.create_task(self._ipc_server.broadcast(notification))

    def _broadcast_risk_alert(
        self,
        alert_type: str,
        severity: str,
        message: str,
        current_value: Decimal | None = None,
        threshold: Decimal | None = None,
        action_required: bool = False,
    ) -> None:
        """Broadcast risk alert to all connected clients (FIX-CGP-005)."""
        if not self._ipc_server:
            return

        notification = Notification(
            message_type=MessageType.RISK_ALERT,  # "risk.alert"
            params={
                "alert_type": alert_type,
                "severity": severity,
                "message": message,
                "current_value": str(current_value) if current_value is not None else None,
                "threshold": str(threshold) if threshold is not None else None,
                "action_required": action_required,
            },
            session_id=self.session_id,
        )
        asyncio.create_task(self._ipc_server.broadcast(notification))

    def _broadcast_connection_status(
        self,
        status: str,
        broker: str | None = None,
        latency_ms: int | None = None,
        reason: str | None = None,
    ) -> None:
        """Broadcast broker connection status to all connected clients (FIX-CGP-005)."""
        if not self._ipc_server:
            return

        notification = Notification(
            message_type=MessageType.CONNECTION_STATUS,  # "connection.status"
            params={
                "broker": broker or self.config.broker,
                "status": status,  # "connected", "reconnecting", "disconnected"
                "latency_ms": latency_ms,
                "last_heartbeat": datetime.now().isoformat(),
                "reason": reason,
            },
            session_id=self.session_id,
        )
        asyncio.create_task(self._ipc_server.broadcast(notification))

    def _send_heartbeat(self, data: dict[str, Any]) -> None:
        """Send heartbeat notification."""
        if self._ipc_server:
            notification = Notification(
                message_type=MessageType.HEARTBEAT,
                params=data,
                session_id=self.session_id,
            )
            asyncio.create_task(self._ipc_server.broadcast(notification))

    def _handle_wake(self, elapsed: float) -> None:
        """Handle system wake from sleep."""
        logger.info(f"System wake, elapsed: {elapsed:.1f}s")

        # Force checkpoint save
        self._checkpoint_manager.mark_dirty()

        # Check if we need to reconnect to broker
        if self._broker and not self._broker_connected:
            asyncio.create_task(self._reconnect_broker())

    async def _connect_broker(self) -> None:
        """
        Initialize and connect to the broker.

        Creates the appropriate broker adapter based on config and connects.
        """
        broker_name = self.config.broker.lower()

        try:
            if broker_name == "alpaca" or broker_name == "alpaca_paper":
                # Import Alpaca broker adapter
                from quantlab.trading.alpaca import AlpacaBroker
                import os

                # NEW-SEC-001: Use SecretsManager for credential retrieval.
                # No os.environ fallback — credentials must come via IPC credentials.set
                # or the encrypted secrets store. Env vars are visible to other processes.
                credentials = self._secrets_manager.get_broker_credentials("alpaca")
                api_key = credentials.get("api_key", "")
                secret_key = credentials.get("secret_key", "")
                paper = broker_name == "alpaca_paper" or self.config.risk_limits.get("paper", True)

                if not api_key or not secret_key:
                    raise RuntimeError(
                        "Alpaca API credentials not available. "
                        "Credentials must be provided via IPC credentials.set "
                        "before starting a session."
                    )

                self._broker = AlpacaBroker(
                    api_key=api_key,
                    secret_key=secret_key,
                    paper=paper,
                )

                # Connect - use await for async connect, fallback to sync
                if hasattr(self._broker, 'connect') and asyncio.iscoroutinefunction(self._broker.connect):
                    connected = await self._broker.connect()
                else:
                    # Sync connect - wrap in executor to avoid blocking
                    import asyncio
                    connected = await asyncio.to_thread(self._broker.connect)

                if connected:
                    self._broker_connected = True
                    logger.info(f"Connected to broker: {self._broker.name}")

                    # Register fill callback
                    self._broker.on_fill(self._handle_broker_fill)
                else:
                    logger.error("Failed to connect to Alpaca broker")

            else:
                logger.warning(f"Unknown broker: {broker_name}, no broker connected")

        except ImportError as e:
            logger.error(f"Failed to import broker adapter: {e}")
        except Exception as e:
            logger.error(f"Failed to connect to broker: {e}")

    def _handle_broker_fill(self, order_id: str, fill: Any) -> None:
        """Handle fill callback from broker."""
        try:
            self.process_fill(
                order_id=order_id,
                fill_qty=fill.quantity,
                fill_price=fill.price,
                commission=getattr(fill, 'commission', Decimal("0")),
            )
        except Exception as e:
            logger.error(f"Error processing broker fill: {e}")

    async def _reconnect_broker(self) -> None:
        """
        Reconnect to broker with exponential backoff.

        Uses exponential backoff with jitter to avoid thundering herd.
        """
        self._broker_reconnect_attempts = 0

        while (
            self._running
            and not self._broker_connected
            and self._broker_reconnect_attempts < self._max_broker_reconnect_attempts
        ):
            self._broker_reconnect_attempts += 1

            # Calculate delay with exponential backoff and jitter
            delay = self._broker_reconnect_base_delay * (2 ** (self._broker_reconnect_attempts - 1))
            jitter = random.uniform(0, delay * 0.5)  # FIX-M13: 50% jitter to prevent thundering herd
            delay += jitter

            logger.info(
                f"Broker reconnection attempt {self._broker_reconnect_attempts}/"
                f"{self._max_broker_reconnect_attempts} in {delay:.1f}s"
            )

            await asyncio.sleep(delay)

            try:
                if self._broker:
                    connected = await self._broker.connect()
                    if connected:
                        self._broker_connected = True
                        self._broker_reconnect_attempts = 0
                        logger.info("Broker reconnected successfully")

                        # Reconcile positions after reconnection
                        await self._reconcile_after_reconnect()

                        # Notify UI of reconnection
                        if self._ipc_server:
                            notification = Notification(
                                message_type=MessageType.STATUS_UPDATE,
                                params={"broker_connected": True},
                                session_id=self.session_id,
                            )
                            await self._ipc_server.broadcast(notification)
                        return

            except Exception as e:
                logger.error(f"Broker reconnection failed: {e}")

        if not self._broker_connected:
            logger.error(
                f"Failed to reconnect to broker after {self._max_broker_reconnect_attempts} attempts"
            )
            # Notify UI of permanent failure
            if self._ipc_server:
                notification = Notification(
                    message_type=MessageType.ERROR,
                    params={
                        "error": "broker_reconnect_failed",
                        "message": "Failed to reconnect to broker",
                    },
                    session_id=self.session_id,
                )
                await self._ipc_server.broadcast(notification)

    async def _reconcile_after_reconnect(self) -> None:
        """Reconcile positions after broker reconnection."""
        if not self._broker:
            return

        try:
            # Get current broker positions
            broker_positions = await self._broker.get_positions()

            # Compare with tracked positions
            tracked = {
                pos.symbol: pos
                for pos in self._position_tracker.get_positions_for_session(
                    self.session_id, include_flat=False
                )
            }

            discrepancies = []
            for bp in broker_positions:
                symbol = bp.get("symbol")
                broker_qty = Decimal(str(bp.get("quantity", 0)))
                tracked_pos = tracked.get(symbol)

                if tracked_pos is None and broker_qty != 0:
                    discrepancies.append(
                        f"{symbol}: broker has {broker_qty}, not tracked"
                    )
                elif tracked_pos and tracked_pos.quantity != broker_qty:
                    discrepancies.append(
                        f"{symbol}: broker has {broker_qty}, tracked has {tracked_pos.quantity}"
                    )

            if discrepancies:
                logger.warning(f"Position discrepancies after reconnect: {discrepancies}")
                # Notify UI of discrepancies
                if self._ipc_server:
                    notification = Notification(
                        message_type=MessageType.STATUS_UPDATE,
                        params={
                            "warning": "position_discrepancy",
                            "discrepancies": discrepancies,
                        },
                        session_id=self.session_id,
                    )
                    await self._ipc_server.broadcast(notification)

        except Exception as e:
            logger.error(f"Position reconciliation failed: {e}")

    async def _reconciliation_loop(self) -> None:
        """FIX-T003: Periodically reconcile positions with broker.

        Interval is configurable via risk_limits.reconciliation_interval (seconds).
        Only runs when broker is connected and session is active.
        """
        while self._running:
            try:
                await asyncio.sleep(self._reconciliation_interval)

                # Only reconcile when active and broker is connected
                if self._state != DaemonState.ACTIVE or not self._broker_connected or not self._broker:
                    continue

                logger.debug("Periodic reconciliation starting")
                try:
                    config = ReconciliationConfig(
                        auto_correct=False,
                        sync_direction="from_broker",
                    )
                    reconciler = PositionReconciler(config)
                    result = await reconciler.reconcile(
                        session_id=self.session_id,
                        broker=self._broker,
                        position_tracker=self._position_tracker,
                    )

                    self._last_reconciliation_result = result

                    if result.has_discrepancies:
                        logger.warning(
                            f"Periodic reconciliation found {len(result.discrepancies)} discrepancies"
                        )
                        # FIX-T004: Broadcast drift notification to UI
                        if self._ipc_server:
                            notification = Notification(
                                message_type=MessageType.STATUS_UPDATE,
                                params={
                                    "reconciliation": {
                                        "status": "discrepancy_found",
                                        "discrepancy_count": len(result.discrepancies),
                                        "details": result.to_dict(),
                                        "timestamp": datetime.now().isoformat(),
                                    },
                                },
                                session_id=self.session_id,
                            )
                            await self._ipc_server.broadcast(notification)
                    else:
                        logger.debug("Periodic reconciliation: no discrepancies")

                except Exception as e:
                    logger.error(f"Periodic reconciliation failed: {e}")

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Reconciliation loop error: {e}")

    def _handle_drift_event(self, event: DriftEvent) -> None:
        """FIX-T004: Handle drift detection event — broadcast to UI."""
        logger.warning(
            f"Drift detected: {event.drift_type.value} [{event.severity.value}] "
            f"on {event.symbol}: {event.description}"
        )
        if self._ipc_server:
            notification = Notification(
                message_type=MessageType.STATUS_UPDATE,
                params={
                    "drift": {
                        "type": event.drift_type.value,
                        "severity": event.severity.value,
                        "symbol": event.symbol,
                        "description": event.description,
                        "deviation_percent": event.deviation_percent,
                        "timestamp": event.timestamp.isoformat(),
                    },
                },
                session_id=self.session_id,
            )
            asyncio.create_task(self._ipc_server.broadcast(notification))

    def _handle_critical_drift_event(self, event: DriftEvent) -> None:
        """FIX-T004: Handle critical drift — alert + potential circuit breaker."""
        logger.critical(
            f"CRITICAL DRIFT: {event.drift_type.value} on {event.symbol}: {event.description}"
        )
        if self._ipc_server:
            notification = Notification(
                message_type=MessageType.STATUS_UPDATE,
                params={
                    "drift": {
                        "type": event.drift_type.value,
                        "severity": "critical",
                        "symbol": event.symbol,
                        "description": event.description,
                        "deviation_percent": event.deviation_percent,
                        "timestamp": event.timestamp.isoformat(),
                        "action_required": True,
                    },
                },
                session_id=self.session_id,
            )
            asyncio.create_task(self._ipc_server.broadcast(notification))

        # Also broadcast as a risk alert for visibility
        self._broadcast_risk_alert(
            alert_type="drift_critical",
            severity="critical",
            message=event.description,
            action_required=True,
        )

    def _handle_sleep(self) -> None:
        """Handle system going to sleep."""
        logger.info("System sleep, saving checkpoint")

        # Immediate checkpoint
        checkpoint = self._create_checkpoint()
        self._checkpoint_manager.save(checkpoint)


def setup_logging(session_id: str, log_level: str = "INFO") -> None:
    """Configure logging for daemon process."""
    log_dir = Path.home() / ".quantlab" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    log_file = log_dir / f"daemon_{session_id}.log"

    logging.basicConfig(
        level=getattr(logging, log_level.upper()),
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        handlers=[
            logging.FileHandler(log_file),
            logging.StreamHandler(),
        ],
    )


def parse_args() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(description="QuantLab Live Trading Daemon")

    parser.add_argument(
        "--session-id",
        required=True,
        help="Unique session identifier",
    )
    parser.add_argument(
        "--strategy",
        required=True,
        help="Path to strategy file",
    )
    parser.add_argument(
        "--broker",
        required=True,
        help="Broker identifier",
    )
    parser.add_argument(
        "--symbols",
        required=True,
        help="Comma-separated list of symbols",
    )
    parser.add_argument(
        "--daemonize",
        action="store_true",
        help="Run as background daemon",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Log level",
    )

    return parser.parse_args()


async def main_async(config: SessionConfig) -> None:
    """Async main entry point."""
    daemon = LiveTradingDaemon(config)
    await daemon.start()


def main() -> None:
    """CLI entry point."""
    args = parse_args()

    # Create config
    config = SessionConfig(
        session_id=args.session_id,
        strategy_path=args.strategy,
        broker=args.broker,
        symbols=args.symbols.split(","),
        risk_limits={},
    )

    # Setup logging
    setup_logging(config.session_id, args.log_level)

    logger.info(f"Starting QuantLab daemon: {config.session_id}")

    # Daemonize if requested
    if args.daemonize:
        daemonize()

    # Run daemon
    try:
        asyncio.run(main_async(config))
    except KeyboardInterrupt:
        logger.info("Interrupted")
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()

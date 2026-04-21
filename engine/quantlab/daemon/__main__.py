#!/usr/bin/env python3
"""
Quantlab Daemon CLI Entry Point.

FIX-CGP-006: Provides the CLI interface expected by the VS Code extension.

This module provides the CLI interface for spawning and controlling the daemon:
    python -m quantlab.daemon start --session-id ... --strategy ... --paper
    python -m quantlab.daemon status --session-id ...
    python -m quantlab.daemon stop --session-id ... --flatten

Spec Reference: Technical Spec Decision L69, N99
"""

import argparse
import asyncio
import logging
import sys
from decimal import Decimal
from pathlib import Path

logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    """Parse command line arguments with subcommands."""
    parser = argparse.ArgumentParser(
        prog="quantlab.daemon",
        description="Quantlab Trading Daemon",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # =========================================================================
    # Start subcommand (extension expects this)
    # =========================================================================
    start = subparsers.add_parser("start", help="Start a trading session")
    start.add_argument(
        "--session-id",
        required=True,
        help="Unique session identifier",
    )
    start.add_argument(
        "--strategy",
        required=True,
        help="Path to strategy file",
    )
    start.add_argument(
        "--broker",
        default="alpaca",
        help="Broker name (default: alpaca)",
    )
    start.add_argument(
        "--symbols",
        nargs="+",
        required=True,
        help="Symbols to trade",
    )
    start.add_argument(
        "--timeframe",
        default="1min",
        help="Bar timeframe (default: 1min)",
    )
    start.add_argument(
        "--paper",
        action="store_true",
        help="Use paper trading",
    )
    start.add_argument(
        "--daemonize",
        action="store_true",
        help="Run as background daemon (detach from terminal)",
    )

    # Risk limit arguments (extension sends these)
    start.add_argument(
        "--max-exposure",
        type=float,
        help="Maximum exposure in USD",
    )
    start.add_argument(
        "--max-position-size",
        type=float,
        help="Maximum position size per symbol",
    )
    start.add_argument(
        "--daily-loss-limit",
        type=float,
        help="Daily loss limit in USD or %",
    )
    start.add_argument(
        "--max-drawdown-percent",
        type=float,
        default=0.05,
        help="Maximum drawdown as percentage (default: 0.05 = 5%%)",
    )
    start.add_argument(
        "--consecutive-loss-limit",
        type=int,
        default=3,
        help="Max consecutive losses before circuit breaker (default: 3)",
    )

    # Logging options
    start.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Log level (default: INFO)",
    )

    # =========================================================================
    # Status subcommand
    # =========================================================================
    status = subparsers.add_parser("status", help="Get daemon status")
    status.add_argument(
        "--session-id",
        help="Session ID to check (optional, lists all if not specified)",
    )

    # =========================================================================
    # Stop subcommand
    # =========================================================================
    stop = subparsers.add_parser("stop", help="Stop a trading session")
    stop.add_argument(
        "--session-id",
        required=True,
        help="Session ID to stop",
    )
    stop.add_argument(
        "--flatten",
        action="store_true",
        help="Flatten positions before stopping",
    )
    stop.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="Shutdown timeout in seconds (default: 60)",
    )

    return parser.parse_args()


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


def check_daemon_running(session_id: str | None = None) -> list[dict]:
    """Check for running daemon sessions."""
    from quantlab.daemon.lifecycle import PidFile

    sessions_dir = Path.home() / ".quantlab" / "sessions"
    running_sessions = []

    if not sessions_dir.exists():
        return []

    if session_id:
        # Check specific session
        pid_file = PidFile(session_id)
        if pid_file.is_locked():
            running_sessions.append({
                "session_id": session_id,
                "pid": pid_file.read_pid(),
                "status": "running",
            })
    else:
        # Check all sessions
        for token_file in sessions_dir.glob("*.token"):
            sid = token_file.stem
            pid_file = PidFile(sid)
            if pid_file.is_locked():
                running_sessions.append({
                    "session_id": sid,
                    "pid": pid_file.read_pid(),
                    "status": "running",
                })

    return running_sessions


async def send_stop_command(session_id: str, flatten: bool = False, timeout: float = 60.0) -> bool:
    """Send stop command to daemon via IPC."""
    from quantlab.daemon.ipc import IPCClient, TokenManager

    # Load token
    token_manager = TokenManager(session_id)
    token = token_manager.load()

    if not token:
        logger.error(f"No token found for session {session_id}")
        return False

    try:
        client = IPCClient(session_id, token)
        await client.connect()

        # Send flatten request first if requested
        if flatten:
            logger.info("Flattening positions before stop...")
            result = await client.call("flatten.request", {"reason": "user_request"})
            logger.info(f"Flatten result: {result}")

        # Send stop command
        logger.info("Sending stop command...")
        result = await client.call("session.stop", {"timeout": timeout})
        logger.info(f"Stop result: {result}")

        await client.disconnect()
        return True

    except Exception as e:
        logger.error(f"Failed to send stop command: {e}")
        return False


async def run_daemon(args: argparse.Namespace) -> int:
    """Run the daemon with the given configuration."""
    from quantlab.daemon.main import LiveTradingDaemon, SessionConfig

    # Build risk limits from args
    risk_limits = {}
    if args.max_exposure:
        risk_limits["max_exposure"] = str(args.max_exposure)
    if args.max_position_size:
        risk_limits["max_position_size"] = str(args.max_position_size)
    if args.daily_loss_limit:
        risk_limits["daily_loss_limit"] = str(args.daily_loss_limit)
    if args.max_drawdown_percent:
        risk_limits["max_drawdown_percent"] = args.max_drawdown_percent
    if args.consecutive_loss_limit:
        risk_limits["consecutive_loss_limit"] = args.consecutive_loss_limit

    # Determine broker name
    broker = args.broker
    if args.paper and broker == "alpaca":
        broker = "alpaca_paper"

    # Create config
    config = SessionConfig(
        session_id=args.session_id,
        strategy_path=args.strategy,
        broker=broker,
        symbols=args.symbols,
        risk_limits=risk_limits,
    )

    # Create and run daemon
    daemon = LiveTradingDaemon(config)

    try:
        await daemon.start()
        return 0
    except Exception as e:
        logger.critical(f"Daemon failed: {e}")
        return 1


def main() -> int:
    """CLI entry point."""
    args = parse_args()

    if args.command == "start":
        # Setup logging
        setup_logging(args.session_id, args.log_level)
        logger.info(f"Starting QuantLab daemon: {args.session_id}")

        # Daemonize if requested
        if args.daemonize:
            from quantlab.daemon.lifecycle import daemonize
            daemonize()

        # Run daemon
        try:
            return asyncio.run(run_daemon(args))
        except KeyboardInterrupt:
            logger.info("Daemon interrupted by user")
            return 130

    elif args.command == "status":
        running = check_daemon_running(args.session_id)

        if running:
            print("Running daemon sessions:")
            for session in running:
                print(f"  {session['session_id']}: PID {session['pid']} ({session['status']})")
            return 0
        else:
            if args.session_id:
                print(f"Session {args.session_id}: NOT RUNNING")
            else:
                print("No running daemon sessions")
            return 1

    elif args.command == "stop":
        setup_logging(args.session_id)
        success = asyncio.run(
            send_stop_command(args.session_id, flatten=args.flatten, timeout=args.timeout)
        )
        return 0 if success else 1

    return 1


if __name__ == "__main__":
    sys.exit(main())

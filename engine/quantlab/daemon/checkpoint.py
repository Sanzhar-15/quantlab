"""
Daemon Checkpoint and Recovery.

Provides crash-resilient state persistence with atomic writes.

Spec Reference: Technical Spec §1.5, Decision N99
"""

import json
import logging
import os
import tempfile
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from quantlab.time.timezone import format_iso_datetime
from quantlab.time.timezone import parse_iso_datetime


logger = logging.getLogger(__name__)


class CheckpointError(Exception):
    """Error reading or writing checkpoint."""

    pass


@dataclass
class Position:
    """Represents an open position."""

    symbol: str
    quantity: Decimal
    avg_cost: Decimal
    unrealized_pnl: Decimal
    side: str  # "long" or "short"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "symbol": self.symbol,
            "quantity": str(self.quantity),
            "avg_cost": str(self.avg_cost),
            "unrealized_pnl": str(self.unrealized_pnl),
            "side": self.side,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Position":
        """Create from dictionary."""
        return cls(
            symbol=data["symbol"],
            quantity=Decimal(data["quantity"]),
            avg_cost=Decimal(data["avg_cost"]),
            unrealized_pnl=Decimal(data["unrealized_pnl"]),
            side=data["side"],
        )


@dataclass
class PendingOrder:
    """Represents a pending order."""

    order_id: str
    symbol: str
    side: str  # "buy" or "sell"
    quantity: Decimal
    order_type: str  # "market", "limit", "stop", etc.
    limit_price: Decimal | None = None
    stop_price: Decimal | None = None
    time_in_force: str = "day"
    submitted_at: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        result = {
            "order_id": self.order_id,
            "symbol": self.symbol,
            "side": self.side,
            "quantity": str(self.quantity),
            "order_type": self.order_type,
            "time_in_force": self.time_in_force,
        }
        if self.limit_price is not None:
            result["limit_price"] = str(self.limit_price)
        if self.stop_price is not None:
            result["stop_price"] = str(self.stop_price)
        if self.submitted_at is not None:
            result["submitted_at"] = format_iso_datetime(self.submitted_at)
        return result

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PendingOrder":
        """Create from dictionary."""
        return cls(
            order_id=data["order_id"],
            symbol=data["symbol"],
            side=data["side"],
            quantity=Decimal(data["quantity"]),
            order_type=data["order_type"],
            limit_price=Decimal(data["limit_price"]) if data.get("limit_price") else None,
            stop_price=Decimal(data["stop_price"]) if data.get("stop_price") else None,
            time_in_force=data.get("time_in_force", "day"),
            submitted_at=parse_iso_datetime(data["submitted_at"])
            if data.get("submitted_at")
            else None,
        )


@dataclass
class SessionCheckpoint:
    """
    Complete session state for checkpoint/recovery.

    Contains all state needed to recover from a daemon crash.
    """

    session_id: str
    strategy_path: str
    state: str  # DaemonState value
    positions: list[Position] = field(default_factory=list)
    pending_orders: list[PendingOrder] = field(default_factory=list)
    current_exposure: Decimal = Decimal("0")
    reserved_exposure: Decimal = Decimal("0")
    realized_pnl: Decimal = Decimal("0")
    unrealized_pnl: Decimal = Decimal("0")
    last_bar_timestamp: datetime | None = None
    checkpoint_timestamp: datetime | None = None
    version: int = 1

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "version": self.version,
            "session_id": self.session_id,
            "strategy_path": self.strategy_path,
            "state": self.state,
            "positions": [p.to_dict() for p in self.positions],
            "pending_orders": [o.to_dict() for o in self.pending_orders],
            "current_exposure": str(self.current_exposure),
            "reserved_exposure": str(self.reserved_exposure),
            "realized_pnl": str(self.realized_pnl),
            "unrealized_pnl": str(self.unrealized_pnl),
            "last_bar_timestamp": format_iso_datetime(self.last_bar_timestamp)
            if self.last_bar_timestamp
            else None,
            "checkpoint_timestamp": format_iso_datetime(self.checkpoint_timestamp)
            if self.checkpoint_timestamp
            else None,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SessionCheckpoint":
        """Create from dictionary."""
        return cls(
            version=data.get("version", 1),
            session_id=data["session_id"],
            strategy_path=data["strategy_path"],
            state=data["state"],
            positions=[Position.from_dict(p) for p in data.get("positions", [])],
            pending_orders=[
                PendingOrder.from_dict(o) for o in data.get("pending_orders", [])
            ],
            current_exposure=Decimal(data.get("current_exposure", "0")),
            reserved_exposure=Decimal(data.get("reserved_exposure", "0")),
            realized_pnl=Decimal(data.get("realized_pnl", "0")),
            unrealized_pnl=Decimal(data.get("unrealized_pnl", "0")),
            last_bar_timestamp=parse_iso_datetime(data["last_bar_timestamp"])
            if data.get("last_bar_timestamp")
            else None,
            checkpoint_timestamp=parse_iso_datetime(data["checkpoint_timestamp"])
            if data.get("checkpoint_timestamp")
            else None,
        )


class CheckpointManager:
    """
    Manages checkpoint persistence and recovery.

    Checkpoint file: ~/.quantlab/sessions/{session_id}.state

    Features:
        - Atomic writes using temporary file + rename
        - JSON format for human readability
        - Version field for migration support
        - Automatic cleanup on graceful shutdown
        - Audit logging for compliance (FIX-CGP-011)
    """

    CHECKPOINT_VERSION = 1

    def __init__(self, session_id: str, audit_ledger: Any | None = None) -> None:
        """
        Initialize checkpoint manager.

        Args:
            session_id: Trading session ID
            audit_ledger: Optional audit ledger for compliance logging (FIX-CGP-011)
        """
        self.session_id = session_id
        self._base_dir = Path.home() / ".quantlab" / "sessions"
        self._checkpoint_path = self._base_dir / f"{session_id}.state"
        self._dirty = False
        self._current_checkpoint: SessionCheckpoint | None = None
        self._audit_ledger = audit_ledger  # FIX-CGP-011

    @property
    def checkpoint_path(self) -> Path:
        """Path to the checkpoint file."""
        return self._checkpoint_path

    def save(self, checkpoint: SessionCheckpoint) -> None:
        """
        Save checkpoint atomically.

        Uses write-to-temp + rename for crash safety.

        Args:
            checkpoint: Session state to save

        Raises:
            CheckpointError: On filesystem errors
        """
        self._base_dir.mkdir(parents=True, exist_ok=True)

        # Update timestamp
        checkpoint.checkpoint_timestamp = datetime.now().astimezone()

        try:
            # Write to temporary file first
            with tempfile.NamedTemporaryFile(
                mode="w",
                dir=self._base_dir,
                prefix=f"{self.session_id}_",
                suffix=".tmp",
                delete=False,
            ) as tmp:
                json.dump(checkpoint.to_dict(), tmp, indent=2)
                # CRITICAL: Flush and fsync to ensure durability before rename
                tmp.flush()
                os.fsync(tmp.fileno())
                tmp_path = tmp.name

            # Set permissions before rename
            os.chmod(tmp_path, 0o600)

            # Atomic rename
            os.replace(tmp_path, self._checkpoint_path)

            # Sync directory to ensure rename is persisted
            # FIX-D006: Wrap in try/except as directory fsync may not be
            # supported on all platforms/filesystems
            try:
                dir_fd = os.open(str(self._base_dir), os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            except OSError as e:
                # Directory fsync not supported on all platforms/filesystems
                logger.debug(f"Directory fsync skipped: {e}")

            self._current_checkpoint = checkpoint
            self._dirty = False

            # FIX-CGP-011: Log checkpoint save to audit ledger
            if self._audit_ledger:
                self._audit_ledger.log_event(
                    "checkpoint_saved",
                    {
                        "session_id": self.session_id,
                        "state": checkpoint.state,
                        "position_count": len(checkpoint.positions),
                        "pending_order_count": len(checkpoint.pending_orders),
                        "timestamp": format_iso_datetime(checkpoint.checkpoint_timestamp),
                    },
                )

            logger.debug(f"Checkpoint saved: {self._checkpoint_path}")

        except OSError as e:
            # Clean up temp file if it exists
            if "tmp_path" in locals():
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            raise CheckpointError(f"Failed to save checkpoint: {e}") from e

    def load(self) -> SessionCheckpoint | None:
        """
        Load checkpoint from file.

        Returns:
            Checkpoint if exists, None otherwise

        Raises:
            CheckpointError: On parse errors or version incompatibility
        """
        if not self._checkpoint_path.exists():
            return None

        try:
            content = self._checkpoint_path.read_text()

            # Early version check - avoid parsing full file if version incompatible
            # This is a quick heuristic check before full parse
            if '"version":' in content:
                import re
                version_match = re.search(r'"version"\s*:\s*(\d+)', content)
                if version_match:
                    version = int(version_match.group(1))
                    if version > self.CHECKPOINT_VERSION:
                        raise CheckpointError(
                            f"Checkpoint version {version} is newer than supported "
                            f"{self.CHECKPOINT_VERSION}. Please upgrade the daemon."
                        )

            data = json.loads(content)

            # Full version check after parse (backup for edge cases)
            version = data.get("version", 1)
            if version > self.CHECKPOINT_VERSION:
                raise CheckpointError(
                    f"Checkpoint version {version} is newer than supported {self.CHECKPOINT_VERSION}"
                )

            checkpoint = SessionCheckpoint.from_dict(data)
            self._current_checkpoint = checkpoint

            # FIX-CGP-011: Log checkpoint recovery to audit ledger
            if self._audit_ledger:
                self._audit_ledger.log_event(
                    "checkpoint_recovered",
                    {
                        "session_id": self.session_id,
                        "state": checkpoint.state,
                        "position_count": len(checkpoint.positions),
                        "pending_order_count": len(checkpoint.pending_orders),
                        "original_timestamp": format_iso_datetime(checkpoint.checkpoint_timestamp),
                        "recovery_timestamp": format_iso_datetime(datetime.now().astimezone()),
                    },
                )

            logger.info(
                f"Loaded checkpoint from {self._checkpoint_path} "
                f"(timestamp: {checkpoint.checkpoint_timestamp})"
            )
            return checkpoint

        except json.JSONDecodeError as e:
            raise CheckpointError(f"Invalid checkpoint file: {e}") from e
        except (KeyError, ValueError) as e:
            raise CheckpointError(f"Malformed checkpoint data: {e}") from e

    def delete(self) -> None:
        """Delete checkpoint file (called on clean shutdown)."""
        try:
            if self._checkpoint_path.exists():
                self._checkpoint_path.unlink()
                logger.info(f"Deleted checkpoint: {self._checkpoint_path}")
        except OSError as e:
            logger.error(f"Error deleting checkpoint: {e}")

        self._current_checkpoint = None

    def mark_dirty(self) -> None:
        """Mark checkpoint as needing save."""
        self._dirty = True

    @property
    def is_dirty(self) -> bool:
        """Check if checkpoint needs saving."""
        return self._dirty

    @property
    def current(self) -> SessionCheckpoint | None:
        """Get current checkpoint (may be None)."""
        return self._current_checkpoint

    @classmethod
    def list_sessions(cls) -> list[str]:
        """
        List all sessions with checkpoint files.

        Returns:
            List of session IDs with checkpoints
        """
        base_dir = Path.home() / ".quantlab" / "sessions"
        if not base_dir.exists():
            return []

        sessions = []
        for path in base_dir.glob("*.state"):
            sessions.append(path.stem)

        return sessions

    @classmethod
    def get_checkpoint_age(cls, session_id: str) -> float | None:
        """
        Get age of checkpoint in seconds.

        Args:
            session_id: Session identifier

        Returns:
            Age in seconds, or None if no checkpoint
        """
        checkpoint_path = Path.home() / ".quantlab" / "sessions" / f"{session_id}.state"

        if not checkpoint_path.exists():
            return None

        try:
            content = checkpoint_path.read_text()
            data = json.loads(content)
            timestamp_str = data.get("checkpoint_timestamp")
            if timestamp_str:
                timestamp = parse_iso_datetime(timestamp_str)
                now = datetime.now().astimezone()
                return (now - timestamp).total_seconds()
        except Exception:
            pass

        # Fall back to file mtime
        try:
            stat = checkpoint_path.stat()
            return datetime.now().timestamp() - stat.st_mtime
        except OSError:
            return None

"""
Session Recovery from Audit Ledger.

Provides utilities to recover session state from the audit ledger
after crashes or disconnects.

Spec Reference: Technical Spec §12.3
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from pathlib import Path
from typing import Any

from .ledger import AuditLedger
from .ledger import EntryType
from .ledger import LedgerEntry


@dataclass
class RecoveredPosition:
    """Recovered position from ledger."""

    symbol: str
    quantity: float
    avg_cost: float
    side: str  # 'long' or 'short'

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "symbol": self.symbol,
            "quantity": self.quantity,
            "avg_cost": self.avg_cost,
            "side": self.side,
        }


@dataclass
class RecoveredOrder:
    """Recovered open order from ledger."""

    order_id: str
    symbol: str
    side: str
    quantity: float
    filled_qty: float
    order_type: str
    limit_price: float | None
    stop_price: float | None
    status: str  # 'open', 'partial', 'filled', 'cancelled', 'rejected'

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "order_id": self.order_id,
            "symbol": self.symbol,
            "side": self.side,
            "quantity": self.quantity,
            "filled_qty": self.filled_qty,
            "order_type": self.order_type,
            "limit_price": self.limit_price,
            "stop_price": self.stop_price,
            "status": self.status,
        }


@dataclass
class SessionRecoveryResult:
    """Result of session recovery."""

    session_id: str
    mode: str
    strategy_name: str
    parameters: dict[str, Any]
    initial_capital: float
    positions: list[RecoveredPosition]
    open_orders: list[RecoveredOrder]
    equity: float
    last_entry_sequence: int
    integrity_verified: bool
    integrity_errors: list[str]
    recovery_timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "session_id": self.session_id,
            "mode": self.mode,
            "strategy_name": self.strategy_name,
            "parameters": self.parameters,
            "initial_capital": self.initial_capital,
            "positions": [p.to_dict() for p in self.positions],
            "open_orders": [o.to_dict() for o in self.open_orders],
            "equity": self.equity,
            "last_entry_sequence": self.last_entry_sequence,
            "integrity_verified": self.integrity_verified,
            "integrity_errors": self.integrity_errors,
            "recovery_timestamp": self.recovery_timestamp.isoformat(),
        }


def recover_session(
    session_id: str,
    ledger_dir: Path | None = None,
    verify_integrity: bool = True,
) -> SessionRecoveryResult | None:
    """
    Recover session state from audit ledger.

    Replays the ledger to reconstruct:
    - Current positions
    - Open orders
    - Current equity

    Args:
        session_id: Session to recover
        ledger_dir: Directory containing ledger files
        verify_integrity: Whether to verify ledger integrity first

    Returns:
        SessionRecoveryResult if session found, None otherwise
    """
    ledger_dir = ledger_dir or Path.home() / ".quantlab" / "audit"
    ledger_path = ledger_dir / f"ledger_{session_id}.jsonl"

    if not ledger_path.exists():
        return None

    ledger = AuditLedger(session_id, ledger_dir=ledger_dir)

    # Verify integrity if requested
    integrity_errors: list[str] = []
    integrity_verified = True
    if verify_integrity:
        integrity_verified, integrity_errors = ledger.verify_integrity()

    # Replay ledger to recover state
    session_start: dict[str, Any] = {}
    orders: dict[str, RecoveredOrder] = {}
    positions: dict[str, RecoveredPosition] = {}
    equity = 0.0
    last_sequence = -1

    for entry in ledger.iter_entries():
        last_sequence = entry.sequence

        if entry.entry_type == EntryType.SESSION_START:
            session_start = entry.payload

        elif entry.entry_type == EntryType.SESSION_END:
            # Session ended, no recovery needed
            return None

        elif entry.entry_type == EntryType.ORDER_SUBMIT:
            order = RecoveredOrder(
                order_id=entry.payload["order_id"],
                symbol=entry.payload["symbol"],
                side=entry.payload["side"],
                quantity=entry.payload["quantity"],
                filled_qty=0.0,
                order_type=entry.payload["order_type"],
                limit_price=entry.payload.get("limit_price"),
                stop_price=entry.payload.get("stop_price"),
                status="open",
            )
            orders[order.order_id] = order

        elif entry.entry_type == EntryType.ORDER_FILL:
            order_id = entry.payload["order_id"]
            if order_id in orders:
                order = orders[order_id]
                order.filled_qty += entry.payload["filled_qty"]
                if order.filled_qty >= order.quantity:
                    order.status = "filled"
                else:
                    order.status = "partial"

                # Update position
                _update_position_from_fill(
                    positions,
                    entry.payload["order_id"],
                    orders.get(order_id),
                    entry.payload["filled_qty"],
                    entry.payload["fill_price"],
                )

        elif entry.entry_type == EntryType.ORDER_CANCEL:
            order_id = entry.payload["order_id"]
            if order_id in orders:
                orders[order_id].status = "cancelled"

        elif entry.entry_type == EntryType.ORDER_REJECT:
            order_id = entry.payload["order_id"]
            if order_id in orders:
                orders[order_id].status = "rejected"

        elif entry.entry_type == EntryType.POSITION_SNAPSHOT:
            # Use snapshot as authoritative position state
            positions.clear()
            for pos in entry.payload.get("positions", []):
                positions[pos["symbol"]] = RecoveredPosition(
                    symbol=pos["symbol"],
                    quantity=pos["quantity"],
                    avg_cost=pos.get("avg_cost", 0.0),
                    side="long" if pos["quantity"] > 0 else "short",
                )
            equity = entry.payload.get("equity", equity)

    # Filter to only open orders
    open_orders = [o for o in orders.values() if o.status in ("open", "partial")]

    return SessionRecoveryResult(
        session_id=session_id,
        mode=session_start.get("mode", "paper"),
        strategy_name=session_start.get("strategy_name", ""),
        parameters=session_start.get("parameters", {}),
        initial_capital=session_start.get("initial_capital", 0.0),
        positions=list(positions.values()),
        open_orders=open_orders,
        equity=equity,
        last_entry_sequence=last_sequence,
        integrity_verified=integrity_verified,
        integrity_errors=integrity_errors,
    )


def _update_position_from_fill(
    positions: dict[str, RecoveredPosition],
    order_id: str,
    order: RecoveredOrder | None,
    filled_qty: float,
    fill_price: float,
) -> None:
    """Update position from a fill."""
    if order is None:
        return

    symbol = order.symbol
    side = order.side

    if symbol not in positions:
        positions[symbol] = RecoveredPosition(
            symbol=symbol,
            quantity=0.0,
            avg_cost=0.0,
            side="long",
        )

    pos = positions[symbol]

    if side == "buy":
        # Buying increases long or reduces short
        if pos.quantity >= 0:
            # Adding to long
            total_cost = pos.avg_cost * pos.quantity + fill_price * filled_qty
            pos.quantity += filled_qty
            pos.avg_cost = total_cost / pos.quantity if pos.quantity > 0 else 0.0
            pos.side = "long"
        else:
            # Reducing short
            pos.quantity += filled_qty
            pos.side = "short" if pos.quantity < 0 else "long"
    else:  # sell
        # Selling increases short or reduces long
        if pos.quantity <= 0:
            # Adding to short
            total_cost = abs(pos.avg_cost * pos.quantity) + fill_price * filled_qty
            pos.quantity -= filled_qty
            pos.avg_cost = total_cost / abs(pos.quantity) if pos.quantity != 0 else 0.0
            pos.side = "short"
        else:
            # Reducing long
            pos.quantity -= filled_qty
            pos.side = "long" if pos.quantity > 0 else "short"


def list_recoverable_sessions(
    ledger_dir: Path | None = None,
) -> list[dict[str, Any]]:
    """
    List sessions that can be recovered.

    Returns sessions that have not been cleanly ended.

    Args:
        ledger_dir: Directory containing ledger files

    Returns:
        List of recoverable session info
    """
    ledger_dir = ledger_dir or Path.home() / ".quantlab" / "audit"

    if not ledger_dir.exists():
        return []

    sessions = []

    for ledger_path in ledger_dir.glob("ledger_*.jsonl"):
        session_id = ledger_path.stem.replace("ledger_", "")

        # Check if session ended cleanly
        has_end = False
        session_start: dict[str, Any] = {}
        last_timestamp = None

        with open(ledger_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    entry = LedgerEntry.from_json(line)
                    last_timestamp = entry.timestamp

                    if entry.entry_type == EntryType.SESSION_START:
                        session_start = entry.payload
                    elif entry.entry_type == EntryType.SESSION_END:
                        has_end = True

        if not has_end and session_start:
            sessions.append(
                {
                    "session_id": session_id,
                    "strategy_name": session_start.get("strategy_name", ""),
                    "mode": session_start.get("mode", ""),
                    "last_activity": last_timestamp.isoformat() if last_timestamp else None,
                    "ledger_path": str(ledger_path),
                }
            )

    return sessions


def cleanup_old_ledgers(
    ledger_dir: Path | None = None,
    retention_days: int = 2555,  # ~7 years
) -> list[Path]:
    """
    Clean up old ledger files beyond retention period.

    Per spec, 7-year retention for compliance.

    Args:
        ledger_dir: Directory containing ledger files
        retention_days: Days to retain (default ~7 years)

    Returns:
        List of deleted file paths
    """
    import time

    ledger_dir = ledger_dir or Path.home() / ".quantlab" / "audit"

    if not ledger_dir.exists():
        return []

    deleted = []
    cutoff = time.time() - (retention_days * 86400)

    for ledger_path in ledger_dir.glob("ledger_*.jsonl"):
        if ledger_path.stat().st_mtime < cutoff:
            ledger_path.unlink()
            deleted.append(ledger_path)

    return deleted

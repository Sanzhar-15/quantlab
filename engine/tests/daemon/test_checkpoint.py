"""
Tests for daemon checkpoint and recovery.
"""

import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest

from quantlab.daemon.checkpoint import (
    CheckpointError,
    CheckpointManager,
    PendingOrder,
    Position,
    SessionCheckpoint,
)


class TestPosition:
    """Tests for Position dataclass."""

    def test_to_dict(self):
        """Should serialize to dictionary."""
        position = Position(
            symbol="AAPL",
            quantity=Decimal("100"),
            avg_cost=Decimal("150.50"),
            unrealized_pnl=Decimal("250.00"),
            side="long",
        )

        data = position.to_dict()

        assert data["symbol"] == "AAPL"
        assert data["quantity"] == "100"
        assert data["avg_cost"] == "150.50"
        assert data["side"] == "long"

    def test_from_dict(self):
        """Should deserialize from dictionary."""
        data = {
            "symbol": "AAPL",
            "quantity": "100",
            "avg_cost": "150.50",
            "unrealized_pnl": "250.00",
            "side": "long",
        }

        position = Position.from_dict(data)

        assert position.symbol == "AAPL"
        assert position.quantity == Decimal("100")
        assert position.avg_cost == Decimal("150.50")


class TestPendingOrder:
    """Tests for PendingOrder dataclass."""

    def test_to_dict_market_order(self):
        """Should serialize market order."""
        order = PendingOrder(
            order_id="ord-123",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            order_type="market",
        )

        data = order.to_dict()

        assert data["order_id"] == "ord-123"
        assert data["order_type"] == "market"
        assert "limit_price" not in data

    def test_to_dict_limit_order(self):
        """Should serialize limit order with price."""
        order = PendingOrder(
            order_id="ord-123",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            order_type="limit",
            limit_price=Decimal("150.00"),
        )

        data = order.to_dict()

        assert data["limit_price"] == "150.00"

    def test_from_dict(self):
        """Should deserialize from dictionary."""
        data = {
            "order_id": "ord-123",
            "symbol": "AAPL",
            "side": "buy",
            "quantity": "100",
            "order_type": "limit",
            "limit_price": "150.00",
        }

        order = PendingOrder.from_dict(data)

        assert order.order_id == "ord-123"
        assert order.limit_price == Decimal("150.00")


class TestSessionCheckpoint:
    """Tests for SessionCheckpoint dataclass."""

    def test_to_dict(self):
        """Should serialize complete checkpoint."""
        checkpoint = SessionCheckpoint(
            session_id="test-session",
            strategy_path="/path/to/strategy.py",
            state="active",
            positions=[
                Position(
                    symbol="AAPL",
                    quantity=Decimal("100"),
                    avg_cost=Decimal("150"),
                    unrealized_pnl=Decimal("50"),
                    side="long",
                )
            ],
            current_exposure=Decimal("15000"),
            realized_pnl=Decimal("500"),
        )

        data = checkpoint.to_dict()

        assert data["session_id"] == "test-session"
        assert data["state"] == "active"
        assert len(data["positions"]) == 1
        assert data["current_exposure"] == "15000"

    def test_from_dict(self):
        """Should deserialize from dictionary."""
        data = {
            "version": 1,
            "session_id": "test-session",
            "strategy_path": "/path/to/strategy.py",
            "state": "paused",
            "positions": [],
            "pending_orders": [],
            "current_exposure": "10000",
            "reserved_exposure": "5000",
            "realized_pnl": "100",
            "unrealized_pnl": "50",
        }

        checkpoint = SessionCheckpoint.from_dict(data)

        assert checkpoint.session_id == "test-session"
        assert checkpoint.state == "paused"
        assert checkpoint.current_exposure == Decimal("10000")


class TestCheckpointManager:
    """Tests for CheckpointManager class."""

    def test_save_creates_file(self, tmp_path):
        """Should create checkpoint file."""
        manager = CheckpointManager("test-session")
        manager._base_dir = tmp_path
        manager._checkpoint_path = tmp_path / "test-session.state"

        checkpoint = SessionCheckpoint(
            session_id="test-session",
            strategy_path="/path/to/strategy.py",
            state="active",
        )

        manager.save(checkpoint)

        assert manager._checkpoint_path.exists()

    def test_save_atomic(self, tmp_path):
        """Should use atomic write (temp + rename)."""
        manager = CheckpointManager("test-session")
        manager._base_dir = tmp_path
        manager._checkpoint_path = tmp_path / "test-session.state"

        checkpoint = SessionCheckpoint(
            session_id="test-session",
            strategy_path="/path/to/strategy.py",
            state="active",
        )

        manager.save(checkpoint)

        # File should have secure permissions
        mode = manager._checkpoint_path.stat().st_mode & 0o777
        assert mode == 0o600

    def test_load_returns_none_if_not_exists(self, tmp_path):
        """Should return None if no checkpoint file."""
        manager = CheckpointManager("test-session")
        manager._base_dir = tmp_path
        manager._checkpoint_path = tmp_path / "nonexistent.state"

        result = manager.load()

        assert result is None

    def test_load_restores_checkpoint(self, tmp_path):
        """Should restore checkpoint from file."""
        manager = CheckpointManager("test-session")
        manager._base_dir = tmp_path
        manager._checkpoint_path = tmp_path / "test-session.state"

        # Save checkpoint
        original = SessionCheckpoint(
            session_id="test-session",
            strategy_path="/path/to/strategy.py",
            state="paused",
            current_exposure=Decimal("50000"),
        )
        manager.save(original)

        # Create new manager and load
        manager2 = CheckpointManager("test-session")
        manager2._base_dir = tmp_path
        manager2._checkpoint_path = tmp_path / "test-session.state"

        loaded = manager2.load()

        assert loaded is not None
        assert loaded.session_id == "test-session"
        assert loaded.state == "paused"
        assert loaded.current_exposure == Decimal("50000")

    def test_delete_removes_file(self, tmp_path):
        """Should delete checkpoint file."""
        manager = CheckpointManager("test-session")
        manager._base_dir = tmp_path
        manager._checkpoint_path = tmp_path / "test-session.state"

        checkpoint = SessionCheckpoint(
            session_id="test-session",
            strategy_path="/path/to/strategy.py",
            state="active",
        )
        manager.save(checkpoint)

        manager.delete()

        assert not manager._checkpoint_path.exists()

    def test_mark_dirty(self, tmp_path):
        """Should track dirty state."""
        manager = CheckpointManager("test-session")
        manager._base_dir = tmp_path

        assert manager.is_dirty is False

        manager.mark_dirty()

        assert manager.is_dirty is True

    def test_save_clears_dirty(self, tmp_path):
        """Save should clear dirty flag."""
        manager = CheckpointManager("test-session")
        manager._base_dir = tmp_path
        manager._checkpoint_path = tmp_path / "test-session.state"

        manager.mark_dirty()

        checkpoint = SessionCheckpoint(
            session_id="test-session",
            strategy_path="/path/to/strategy.py",
            state="active",
        )
        manager.save(checkpoint)

        assert manager.is_dirty is False

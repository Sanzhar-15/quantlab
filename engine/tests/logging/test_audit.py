"""
Tests for audit log.
"""

import json
from datetime import datetime

import pytest

from quantlab.logging.audit import (
    AuditAction,
    AuditEntry,
    AuditLog,
    audit_order_fill,
    audit_order_submit,
    audit_session_start,
)


class TestAuditEntry:
    """Tests for AuditEntry dataclass."""

    def test_to_dict(self):
        """Should serialize to dictionary."""
        entry = AuditEntry(
            sequence=1,
            timestamp=datetime(2026, 1, 26, 14, 30, 0),
            action=AuditAction.ORDER_SUBMIT,
            session_id="test-session",
            user_id="user@test.com",
            data={"order_id": "ord-123", "symbol": "AAPL"},
        )

        data = entry.to_dict()

        assert data["seq"] == 1
        assert data["action"] == "order.submit"
        assert data["session_id"] == "test-session"
        assert data["data"]["order_id"] == "ord-123"

    def test_compute_hash(self):
        """Should compute deterministic hash."""
        entry = AuditEntry(
            sequence=1,
            timestamp=datetime(2026, 1, 26, 14, 30, 0),
            action=AuditAction.ORDER_SUBMIT,
            session_id="test-session",
            user_id=None,
            data={"order_id": "ord-123"},
            previous_hash="",
        )

        hash1 = entry.compute_hash()
        hash2 = entry.compute_hash()

        assert hash1 == hash2
        assert len(hash1) == 64  # SHA256 hex (more secure than CRC32)

    def test_from_dict(self):
        """Should deserialize from dictionary."""
        data = {
            "seq": 1,
            "ts": "2026-01-26T14:30:00.000Z",
            "action": "order.submit",
            "session_id": "test-session",
            "user_id": None,
            "data": {"order_id": "ord-123"},
            "prev_hash": "",
            "hash": "abc123",
        }

        entry = AuditEntry.from_dict(data)

        assert entry.sequence == 1
        assert entry.action == AuditAction.ORDER_SUBMIT
        assert entry.data["order_id"] == "ord-123"


class TestAuditLog:
    """Tests for AuditLog class."""

    def test_log_creates_entry(self, tmp_path):
        """Should create audit entry."""
        log = AuditLog(tmp_path / "audit.log")

        entry = log.log(
            AuditAction.SESSION_START,
            "test-session",
            {"strategy": "test.py"},
        )

        assert entry.sequence == 1
        assert entry.action == AuditAction.SESSION_START

    def test_log_increments_sequence(self, tmp_path):
        """Should increment sequence numbers."""
        log = AuditLog(tmp_path / "audit.log")

        entry1 = log.log(AuditAction.SESSION_START, "test", {})
        entry2 = log.log(AuditAction.ORDER_SUBMIT, "test", {})
        entry3 = log.log(AuditAction.ORDER_FILL, "test", {})

        assert entry1.sequence == 1
        assert entry2.sequence == 2
        assert entry3.sequence == 3

    def test_log_chains_hashes(self, tmp_path):
        """Should chain entry hashes."""
        log = AuditLog(tmp_path / "audit.log")

        entry1 = log.log(AuditAction.SESSION_START, "test", {})
        entry2 = log.log(AuditAction.ORDER_SUBMIT, "test", {})

        assert entry1.previous_hash == ""
        assert entry2.previous_hash == entry1.entry_hash

    def test_persistence(self, tmp_path):
        """Entries should persist to file."""
        path = tmp_path / "audit.log"

        log1 = AuditLog(path)
        log1.log(AuditAction.SESSION_START, "test", {"key": "value"})

        # Reopen log
        log2 = AuditLog(path)

        assert log2.sequence == 1  # Should resume from 1

    def test_verify_integrity_valid(self, tmp_path):
        """Should verify valid audit log."""
        log = AuditLog(tmp_path / "audit.log")

        log.log(AuditAction.SESSION_START, "test", {})
        log.log(AuditAction.ORDER_SUBMIT, "test", {})
        log.log(AuditAction.ORDER_FILL, "test", {})

        valid, last_seq, error = log.verify_integrity()

        assert valid is True
        assert last_seq == 3
        assert error == ""

    def test_verify_integrity_detects_tampering(self, tmp_path):
        """Should detect tampered entries."""
        path = tmp_path / "audit.log"
        log = AuditLog(path)

        log.log(AuditAction.SESSION_START, "test", {})
        log.log(AuditAction.ORDER_SUBMIT, "test", {})

        # Tamper with file
        lines = path.read_text().strip().split("\n")
        data = json.loads(lines[0])
        data["data"]["tampered"] = True
        lines[0] = json.dumps(data)
        path.write_text("\n".join(lines) + "\n")

        valid, last_seq, error = log.verify_integrity()

        assert valid is False
        assert "hash" in error.lower() or "tamper" in error.lower()

    def test_read_entries(self, tmp_path):
        """Should read entries with filters."""
        log = AuditLog(tmp_path / "audit.log")

        log.log(AuditAction.SESSION_START, "test", {})
        log.log(AuditAction.ORDER_SUBMIT, "test", {})
        log.log(AuditAction.ORDER_FILL, "test", {})
        log.log(AuditAction.SESSION_STOP, "test", {})

        # Filter by action
        entries = log.read_entries(action_filter=[AuditAction.ORDER_SUBMIT, AuditAction.ORDER_FILL])

        assert len(entries) == 2
        assert entries[0].action == AuditAction.ORDER_SUBMIT
        assert entries[1].action == AuditAction.ORDER_FILL

    def test_read_entries_range(self, tmp_path):
        """Should read entries by sequence range."""
        log = AuditLog(tmp_path / "audit.log")

        for _ in range(5):
            log.log(AuditAction.ORDER_SUBMIT, "test", {})

        entries = log.read_entries(start_seq=2, end_seq=4)

        assert len(entries) == 3
        assert entries[0].sequence == 2
        assert entries[-1].sequence == 4

    def test_get_order_history(self, tmp_path):
        """Should get history for specific order."""
        log = AuditLog(tmp_path / "audit.log")

        log.log(AuditAction.ORDER_SUBMIT, "test", {"order_id": "ord-001"})
        log.log(AuditAction.ORDER_SUBMIT, "test", {"order_id": "ord-002"})
        log.log(AuditAction.ORDER_FILL, "test", {"order_id": "ord-001"})
        log.log(AuditAction.ORDER_CANCEL, "test", {"order_id": "ord-002"})

        history = log.get_order_history("ord-001")

        assert len(history) == 2
        assert history[0].action == AuditAction.ORDER_SUBMIT
        assert history[1].action == AuditAction.ORDER_FILL


class TestAuditHelpers:
    """Tests for audit helper functions."""

    def test_audit_order_submit(self, tmp_path):
        """Should log order submission."""
        log = AuditLog(tmp_path / "audit.log")

        entry = audit_order_submit(
            log,
            session_id="test",
            order_id="ord-123",
            symbol="AAPL",
            side="buy",
            quantity="100",
            order_type="market",
        )

        assert entry.action == AuditAction.ORDER_SUBMIT
        assert entry.data["order_id"] == "ord-123"
        assert entry.data["symbol"] == "AAPL"

    def test_audit_order_fill(self, tmp_path):
        """Should log order fill."""
        log = AuditLog(tmp_path / "audit.log")

        entry = audit_order_fill(
            log,
            session_id="test",
            order_id="ord-123",
            fill_quantity="100",
            fill_price="150.50",
            is_partial=False,
        )

        assert entry.action == AuditAction.ORDER_FILL
        assert entry.data["fill_price"] == "150.50"

    def test_audit_session_start(self, tmp_path):
        """Should log session start."""
        log = AuditLog(tmp_path / "audit.log")

        entry = audit_session_start(
            log,
            session_id="test",
            strategy_path="/path/to/strategy.py",
            broker="alpaca",
            symbols=["AAPL", "MSFT"],
            user_id="user@test.com",
        )

        assert entry.action == AuditAction.SESSION_START
        assert entry.user_id == "user@test.com"
        assert entry.data["symbols"] == ["AAPL", "MSFT"]

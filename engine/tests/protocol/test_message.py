"""
Tests for protocol message types.
"""

import json
from datetime import datetime

import pytest

from quantlab.protocol.message import (
    ErrorCode,
    Message,
    MessageType,
    Notification,
    ReliabilityClass,
    Request,
    Response,
)


class TestMessageType:
    """Tests for MessageType enum."""

    def test_message_type_values(self):
        """Should have expected message types."""
        assert MessageType.SESSION_START.value == "session.start"
        assert MessageType.ORDER_SUBMIT.value == "order.submit"
        assert MessageType.HEARTBEAT.value == "heartbeat"

    def test_reliability_class_mapping(self):
        """Should map message types to correct reliability classes."""
        # Critical messages
        assert MessageType.ORDER_SUBMIT.reliability_class == ReliabilityClass.CRITICAL
        assert MessageType.ORDER_CANCEL.reliability_class == ReliabilityClass.CRITICAL
        assert MessageType.SESSION_START.reliability_class == ReliabilityClass.CRITICAL

        # Important messages
        assert MessageType.POSITIONS_UPDATE.reliability_class == ReliabilityClass.IMPORTANT

        # Telemetry messages
        assert MessageType.HEARTBEAT.reliability_class == ReliabilityClass.TELEMETRY


class TestRequest:
    """Tests for Request class."""

    def test_create_request(self):
        """Should create request with all fields."""
        request = Request(
            message_type=MessageType.ORDER_SUBMIT,
            params={"symbol": "AAPL", "qty": 100},
            session_id="test-session",
        )

        assert request.message_type == MessageType.ORDER_SUBMIT
        assert request.params["symbol"] == "AAPL"
        assert request.session_id == "test-session"
        assert request.id is not None

    def test_request_id_format(self):
        """Request ID should be UUID format."""
        request = Request(
            message_type=MessageType.ORDER_SUBMIT,
            params={},
            session_id="test",
        )

        # Should be a valid UUID string
        parts = request.id.split("-")
        assert len(parts) == 5

    def test_to_json(self):
        """Should serialize to valid JSON-RPC 2.0."""
        request = Request(
            message_type=MessageType.ORDER_SUBMIT,
            params={"symbol": "AAPL"},
            session_id="test",
        )

        json_str = request.to_json()
        data = json.loads(json_str)

        assert data["jsonrpc"] == "2.0"
        assert data["method"] == "order.submit"
        assert data["params"]["symbol"] == "AAPL"
        assert "id" in data

    def test_from_json(self):
        """Should deserialize from JSON-RPC 2.0."""
        json_str = json.dumps({
            "jsonrpc": "2.0",
            "method": "order.submit",
            "params": {"symbol": "AAPL"},
            "id": "req-123",
        })

        request = Request.from_json(json_str)

        assert request.message_type == MessageType.ORDER_SUBMIT
        assert request.params["symbol"] == "AAPL"
        assert request.id == "req-123"


class TestResponse:
    """Tests for Response class."""

    def test_create_success_response(self):
        """Should create successful response."""
        response = Response(
            id="req-123",
            result={"order_id": "ord-456"},
            session_id="test",
        )

        assert response.id == "req-123"
        assert response.result["order_id"] == "ord-456"
        assert response.error is None

    def test_create_error_response(self):
        """Should create error response."""
        response = Response(
            id="req-123",
            error={
                "code": ErrorCode.INVALID_PARAMS,
                "message": "Missing symbol",
            },
            session_id="test",
        )

        assert response.id == "req-123"
        assert response.result is None
        assert response.error["code"] == ErrorCode.INVALID_PARAMS

    def test_to_json_success(self):
        """Success response should serialize correctly."""
        response = Response(
            id="req-123",
            result={"status": "ok"},
            session_id="test",
        )

        json_str = response.to_json()
        data = json.loads(json_str)

        assert data["jsonrpc"] == "2.0"
        assert data["id"] == "req-123"
        assert data["result"]["status"] == "ok"
        assert "error" not in data

    def test_to_json_error(self):
        """Error response should serialize correctly."""
        response = Response(
            id="req-123",
            error={"code": -32600, "message": "Invalid request"},
            session_id="test",
        )

        json_str = response.to_json()
        data = json.loads(json_str)

        assert data["jsonrpc"] == "2.0"
        assert data["id"] == "req-123"
        assert data["error"]["code"] == -32600
        assert "result" not in data


class TestNotification:
    """Tests for Notification class."""

    def test_create_notification(self):
        """Should create notification without ID."""
        notification = Notification(
            message_type=MessageType.HEARTBEAT,
            params={"state": "active"},
            session_id="test",
        )

        assert notification.message_type == MessageType.HEARTBEAT
        assert notification.params["state"] == "active"
        assert notification.id is None

    def test_to_json(self):
        """Notification should serialize without ID."""
        notification = Notification(
            message_type=MessageType.HEARTBEAT,
            params={"cpu": 10},
            session_id="test",
        )

        json_str = notification.to_json()
        data = json.loads(json_str)

        assert data["jsonrpc"] == "2.0"
        assert data["method"] == "heartbeat"
        assert "id" not in data


class TestReliabilityClass:
    """Tests for ReliabilityClass enum."""

    def test_reliability_values(self):
        """Should have expected reliability classes."""
        assert ReliabilityClass.CRITICAL.value == "critical"
        assert ReliabilityClass.IMPORTANT.value == "important"
        assert ReliabilityClass.TELEMETRY.value == "telemetry"

    def test_critical_requires_ack(self):
        """Critical messages should require acknowledgment."""
        assert ReliabilityClass.CRITICAL.requires_ack is True
        assert ReliabilityClass.IMPORTANT.requires_ack is False
        assert ReliabilityClass.TELEMETRY.requires_ack is False


class TestErrorCode:
    """Tests for ErrorCode constants."""

    def test_standard_codes(self):
        """Should have standard JSON-RPC error codes."""
        assert ErrorCode.PARSE_ERROR == -32700
        assert ErrorCode.INVALID_REQUEST == -32600
        assert ErrorCode.METHOD_NOT_FOUND == -32601
        assert ErrorCode.INVALID_PARAMS == -32602
        assert ErrorCode.INTERNAL_ERROR == -32603

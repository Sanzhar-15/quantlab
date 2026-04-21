"""
Tests for JSON-RPC 2.0 Protocol Handler.

Tests JsonRpcProtocol, JsonRpcClient, and JsonRpcServer.
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from quantlab.protocol.jsonrpc import (
    PendingRequest,
    JsonRpcProtocol,
    JsonRpcClient,
    JsonRpcServer,
)
from quantlab.protocol.message import (
    MessageType,
    ErrorCode,
    Request,
    Response,
    Notification,
)


class TestPendingRequest:
    """Tests for PendingRequest dataclass."""

    def test_creation(self) -> None:
        """Test pending request creation."""
        loop = asyncio.new_event_loop()
        future = loop.create_future()
        request = Request(
            message_type=MessageType.SESSION_START,
            params={"session_id": "test"},
            sequence=1,
        )

        pending = PendingRequest(
            request=request,
            future=future,
            timestamp=100.0,
        )

        assert pending.request == request
        assert pending.retries == 0
        assert pending.max_retries == 3
        loop.close()


class TestJsonRpcProtocol:
    """Tests for JsonRpcProtocol class."""

    @pytest.fixture
    def protocol(self):
        """Create JSON-RPC protocol."""
        return JsonRpcProtocol()

    def test_init(self, protocol) -> None:
        """Test protocol initialization."""
        assert protocol.get_pending_count() == 0

    def test_register_handler(self, protocol) -> None:
        """Test registering a handler."""
        async def handler(params):
            return {"status": "ok"}

        protocol.register_handler("test.method", handler)

        assert "test.method" in protocol._handlers

    def test_unregister_handler(self, protocol) -> None:
        """Test unregistering a handler."""
        async def handler(params):
            return {}

        protocol.register_handler("test.method", handler)
        protocol.unregister_handler("test.method")

        assert "test.method" not in protocol._handlers

    def test_unregister_nonexistent(self, protocol) -> None:
        """Test unregistering nonexistent handler."""
        # Should not raise
        protocol.unregister_handler("nonexistent")

    def test_set_send_callback(self, protocol) -> None:
        """Test setting send callback."""
        async def callback(data):
            pass

        protocol.set_send_callback(callback)

        assert protocol._send_callback is callback

    @pytest.mark.asyncio
    async def test_send_without_callback_raises(self, protocol) -> None:
        """Test that sending without callback raises."""
        with pytest.raises(ConnectionError):
            await protocol._send({"test": "data"})

    @pytest.mark.asyncio
    async def test_send_with_callback(self, protocol) -> None:
        """Test sending with callback."""
        sent_data = []

        async def callback(data):
            sent_data.append(data)

        protocol.set_send_callback(callback)
        await protocol._send({"test": "data"})

        assert len(sent_data) == 1
        assert b"test" in sent_data[0]

    @pytest.mark.asyncio
    async def test_handle_message_invalid_json(self, protocol) -> None:
        """Test handling invalid JSON."""
        result = await protocol.handle_message(b"not valid json")

        assert result is not None
        assert result.error is not None

    @pytest.mark.asyncio
    async def test_handle_message_batch_not_supported(self, protocol) -> None:
        """Test handling batch messages returns error response."""
        result = await protocol.handle_message(b"[]")

        # Empty batch returns an error response
        assert result is not None
        assert result.error is not None
        assert result.error["code"] == -32600

    @pytest.mark.asyncio
    async def test_handle_message_invalid_version(self, protocol) -> None:
        """Test handling message with wrong version."""
        data = json.dumps({
            "jsonrpc": "1.0",
            "method": "test",
            "id": "1",
        })

        result = await protocol.handle_message(data)

        assert result is not None
        assert result.error is not None
        assert "version" in result.error.get("message", "").lower()

    @pytest.mark.asyncio
    async def test_handle_message_missing_method(self, protocol) -> None:
        """Test handling message with missing method."""
        data = json.dumps({
            "jsonrpc": "2.0",
            "id": "1",
        })

        result = await protocol.handle_message(data)

        assert result is not None
        assert result.error is not None

    @pytest.mark.asyncio
    async def test_handle_request_method_not_found(self, protocol) -> None:
        """Test handling request for unknown method."""
        data = json.dumps({
            "jsonrpc": "2.0",
            "method": "unknown.method",
            "params": {},
            "id": "1",
        })

        result = await protocol.handle_message(data)

        assert result is not None
        assert result.error is not None
        assert result.error.get("code") == ErrorCode.METHOD_NOT_FOUND

    @pytest.mark.asyncio
    async def test_handle_request_success(self, protocol) -> None:
        """Test handling request with registered handler."""
        async def handler(params):
            return {"result": "success"}

        protocol.register_handler("test.method", handler)

        data = json.dumps({
            "jsonrpc": "2.0",
            "method": "test.method",
            "params": {"key": "value"},
            "id": "1",
        })

        result = await protocol.handle_message(data)

        assert result is not None
        assert result.success
        assert result.result == {"result": "success"}

    @pytest.mark.asyncio
    async def test_handle_request_handler_raises_value_error(
        self, protocol
    ) -> None:
        """Test handling request when handler raises ValueError."""
        async def handler(params):
            raise ValueError("Invalid params")

        protocol.register_handler("test.method", handler)

        data = json.dumps({
            "jsonrpc": "2.0",
            "method": "test.method",
            "params": {},
            "id": "1",
        })

        result = await protocol.handle_message(data)

        assert result is not None
        assert result.error is not None
        assert result.error.get("code") == ErrorCode.INVALID_PARAMS

    @pytest.mark.asyncio
    async def test_handle_request_handler_raises_exception(
        self, protocol
    ) -> None:
        """Test handling request when handler raises generic exception."""
        async def handler(params):
            raise RuntimeError("Something went wrong")

        protocol.register_handler("test.method", handler)

        data = json.dumps({
            "jsonrpc": "2.0",
            "method": "test.method",
            "params": {},
            "id": "1",
        })

        result = await protocol.handle_message(data)

        assert result is not None
        assert result.error is not None
        assert result.error.get("code") == ErrorCode.INTERNAL_ERROR

    @pytest.mark.asyncio
    async def test_handle_notification(self, protocol) -> None:
        """Test handling notification (no id)."""
        handled = []

        async def handler(params):
            handled.append(params)

        protocol.register_handler("test.notify", handler)

        data = json.dumps({
            "jsonrpc": "2.0",
            "method": "test.notify",
            "params": {"data": "test"},
        })

        result = await protocol.handle_message(data)

        assert result is None
        assert len(handled) == 1
        assert handled[0]["data"] == "test"

    @pytest.mark.asyncio
    async def test_handle_notification_no_handler(self, protocol) -> None:
        """Test handling notification with no handler."""
        data = json.dumps({
            "jsonrpc": "2.0",
            "method": "unknown.notify",
            "params": {},
        })

        result = await protocol.handle_message(data)

        assert result is None  # Notifications don't return responses

    @pytest.mark.asyncio
    async def test_handle_response_to_pending_request(self, protocol) -> None:
        """Test handling response to pending request."""
        # Manually create a pending request
        loop = asyncio.get_event_loop()
        future = loop.create_future()
        request = Request(
            message_type=MessageType.SESSION_START,
            params={},
            sequence=1,
        )
        pending = PendingRequest(
            request=request,
            future=future,
            timestamp=loop.time(),
        )
        protocol._pending[request.id] = pending

        # Send a response
        response_data = json.dumps({
            "jsonrpc": "2.0",
            "result": {"status": "ok"},
            "id": request.id,
        })

        await protocol.handle_message(response_data)

        # Future should be resolved
        assert future.done()
        result = future.result()
        assert result.result == {"status": "ok"}

    @pytest.mark.asyncio
    async def test_handle_response_unknown_request(self, protocol) -> None:
        """Test handling response for unknown request."""
        response_data = json.dumps({
            "jsonrpc": "2.0",
            "result": {"status": "ok"},
            "id": "unknown-request-id",
        })

        # Should not raise, just log warning
        await protocol.handle_message(response_data)

    def test_clear_pending(self, protocol) -> None:
        """Test clearing pending requests."""
        loop = asyncio.new_event_loop()
        future = loop.create_future()
        request = Request(
            message_type=MessageType.SESSION_START,
            params={},
            sequence=1,
        )
        pending = PendingRequest(
            request=request,
            future=future,
            timestamp=100.0,
        )
        protocol._pending["test-id"] = pending

        protocol.clear_pending()

        assert protocol.get_pending_count() == 0
        # clear_pending sets error responses rather than cancelling futures
        assert future.done()
        result = future.result()
        assert result.error is not None
        loop.close()

    @pytest.mark.asyncio
    async def test_send_notification(self, protocol) -> None:
        """Test sending notification."""
        sent_data = []

        async def callback(data):
            sent_data.append(json.loads(data))

        protocol.set_send_callback(callback)

        await protocol.send_notification(
            MessageType.POSITIONS_UPDATE,
            {"positions": []},
        )

        assert len(sent_data) == 1
        assert sent_data[0].get("method") is not None

    @pytest.mark.asyncio
    async def test_send_response(self, protocol) -> None:
        """Test sending response."""
        sent_data = []

        async def callback(data):
            sent_data.append(json.loads(data))

        protocol.set_send_callback(callback)

        response = Response.success_response(
            id="test-id",
            result={"status": "ok"},
        )
        await protocol.send_response(response)

        assert len(sent_data) == 1
        assert sent_data[0].get("id") == "test-id"


class TestJsonRpcClient:
    """Tests for JsonRpcClient class."""

    @pytest.fixture
    def client(self):
        """Create JSON-RPC client."""
        return JsonRpcClient(timeout=5.0)

    def test_init(self, client) -> None:
        """Test client initialization."""
        assert client.timeout == 5.0
        assert client.connected is False

    @pytest.mark.asyncio
    async def test_connect_not_implemented(self, client) -> None:
        """Test that connect raises NotImplementedError."""
        with pytest.raises(NotImplementedError):
            await client.connect()

    @pytest.mark.asyncio
    async def test_disconnect(self, client) -> None:
        """Test disconnect."""
        client._connected = True

        await client.disconnect()

        assert client.connected is False


class TestJsonRpcServer:
    """Tests for JsonRpcServer class."""

    @pytest.fixture
    def server(self):
        """Create JSON-RPC server."""
        return JsonRpcServer()

    def test_init(self, server) -> None:
        """Test server initialization."""
        assert len(server._clients) == 0

    @pytest.mark.asyncio
    async def test_start_not_implemented(self, server) -> None:
        """Test that start raises NotImplementedError."""
        with pytest.raises(NotImplementedError):
            await server.start()

    @pytest.mark.asyncio
    async def test_stop(self, server) -> None:
        """Test stop clears pending."""
        loop = asyncio.new_event_loop()
        future = loop.create_future()
        request = Request(
            message_type=MessageType.SESSION_START,
            params={},
            sequence=1,
        )
        pending = PendingRequest(
            request=request,
            future=future,
            timestamp=100.0,
        )
        server._pending["test-id"] = pending

        await server.stop()

        assert server.get_pending_count() == 0
        loop.close()

    @pytest.mark.asyncio
    async def test_broadcast(self, server) -> None:
        """Test broadcast sends notification."""
        sent_data = []

        async def callback(data):
            sent_data.append(data)

        server.set_send_callback(callback)

        await server.broadcast(
            MessageType.POSITIONS_UPDATE,
            {"positions": []},
        )

        assert len(sent_data) == 1

"""
JSON-RPC 2.0 Protocol Handler.

Implements the JSON-RPC 2.0 specification for IPC communication.

Spec Reference: Technical Spec §15, Decision A5
"""

import asyncio
import json
import logging
from collections.abc import Awaitable
from collections.abc import Callable
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from .message import ErrorCode
from .message import Message
from .message import MessageType
from .message import Notification
from .message import Request
from .message import Response


logger = logging.getLogger(__name__)


# Type alias for method handlers
MethodHandler = Callable[[dict[str, Any]], Awaitable[Any]]


@dataclass
class PendingRequest:
    """Tracks a pending request awaiting response."""

    request: Request
    future: asyncio.Future[Response]
    timestamp: float
    retries: int = 0
    max_retries: int = 3


class JsonRpcProtocol:
    """
    JSON-RPC 2.0 protocol handler.

    Handles serialization, deserialization, request/response matching,
    and method dispatch.

    Usage:
        protocol = JsonRpcProtocol()
        protocol.register_handler("session.start", handle_session_start)

        # Send request and wait for response
        response = await protocol.send_request(
            MessageType.SESSION_START,
            {"session_id": "abc", "strategy_path": "/path/to/strategy.py"}
        )

        # Handle incoming message
        result = await protocol.handle_message(json_data)
    """

    def __init__(self) -> None:
        self._handlers: dict[str, MethodHandler] = {}
        self._pending: dict[str, PendingRequest] = {}
        self._sequence: int = 0
        self._send_callback: Callable[[bytes], Awaitable[None]] | None = None

    def set_send_callback(
        self, callback: Callable[[bytes], Awaitable[None]]
    ) -> None:
        """Set the callback for sending messages over the transport."""
        self._send_callback = callback

    def register_handler(self, method: str, handler: MethodHandler) -> None:
        """
        Register a handler for a method.

        Args:
            method: Method name (e.g., "session.start")
            handler: Async function to handle the method
        """
        self._handlers[method] = handler

    def unregister_handler(self, method: str) -> None:
        """Unregister a method handler."""
        self._handlers.pop(method, None)

    def _next_sequence(self) -> int:
        """Get the next sequence number."""
        self._sequence += 1
        return self._sequence

    async def send_request(
        self,
        message_type: MessageType,
        params: dict[str, Any],
        session_id: str | None = None,
        timeout: float = 30.0,
    ) -> Response:
        """
        Send a request and wait for response.

        Args:
            message_type: The message type to send
            params: Request parameters
            session_id: Optional session ID
            timeout: Response timeout in seconds

        Returns:
            Response object

        Raises:
            TimeoutError: If no response received within timeout
            ConnectionError: If send fails
        """
        request = Request(
            message_type=message_type,
            params=params,
            sequence=self._next_sequence(),
            session_id=session_id,
        )

        # Create future for response
        loop = asyncio.get_event_loop()
        future: asyncio.Future[Response] = loop.create_future()

        # Track pending request
        pending = PendingRequest(
            request=request,
            future=future,
            timestamp=loop.time(),
        )
        self._pending[request.id] = pending

        try:
            # Send the request
            await self._send(request.to_dict())

            # Wait for response
            return await asyncio.wait_for(future, timeout=timeout)

        except asyncio.TimeoutError:
            # Clean up: cancel the future and remove from pending
            self._pending.pop(request.id, None)
            if not future.done():
                future.cancel()
            raise TimeoutError(f"Request {request.id} timed out after {timeout}s")

        except Exception:
            # Clean up: cancel the future and remove from pending
            self._pending.pop(request.id, None)
            if not future.done():
                future.cancel()
            raise

    async def send_notification(
        self,
        message_type: MessageType,
        params: dict[str, Any],
        session_id: str | None = None,
    ) -> None:
        """
        Send a notification (no response expected).

        Args:
            message_type: The message type to send
            params: Notification parameters
            session_id: Optional session ID
        """
        notification = Notification(
            message_type=message_type,
            params=params,
            sequence=self._next_sequence(),
            session_id=session_id,
        )

        await self._send(notification.to_dict())

    async def send_response(self, response: Response) -> None:
        """Send a response to a request."""
        await self._send(response.to_dict())

    async def _send(self, data: dict[str, Any]) -> None:
        """Send data through the transport."""
        if self._send_callback is None:
            raise ConnectionError("No send callback configured")

        json_data = json.dumps(data).encode("utf-8")
        await self._send_callback(json_data)

    async def handle_message(self, data: bytes | str) -> Response | list[dict[str, Any]] | None:
        """
        Handle an incoming message.

        Args:
            data: Raw JSON data (bytes or string)

        Returns:
            Response if single request, list of dicts if batch request, None otherwise.
            Caller must check type: if list, serialize as JSON array directly.
        """
        try:
            if isinstance(data, bytes):
                data = data.decode("utf-8")

            parsed = json.loads(data)

            # Check for batch (array of messages) - JSON-RPC 2.0 requirement
            if isinstance(parsed, list):
                return await self._handle_batch_messages(parsed)

            return await self._handle_single_message(parsed)

        except json.JSONDecodeError as e:
            logger.error(f"JSON parse error: {e}")
            return Response.error_response(
                id="",
                code=ErrorCode.PARSE_ERROR,
                message=f"Parse error: {e}",
            )

    async def _handle_batch_messages(
        self, messages: list[dict[str, Any]]
    ) -> Response | list[dict[str, Any]] | None:
        """
        Handle a batch of messages (JSON-RPC 2.0 batch request).

        Per JSON-RPC 2.0 spec:
        - Empty array is invalid request
        - Each message in batch is processed independently
        - Responses returned as array in same order
        - Notifications in batch don't contribute to response array

        Returns:
            List of response dicts for batch, or None if all notifications.
            Caller must check if result is a list and serialize accordingly.
        """
        if not messages:
            return Response.error_response(
                id="",
                code=ErrorCode.INVALID_REQUEST,
                message="Empty batch",
            )

        responses: list[dict[str, Any]] = []

        for msg in messages:
            result = await self._handle_single_message(msg)
            if result is not None:
                # Only add to responses if not a notification (notifications return None)
                responses.append(result.to_dict())

        # If all messages were notifications, no response is returned per spec
        if not responses:
            return None

        # Return raw list - caller must serialize this as JSON array directly
        # NOT wrapped in a Response object (that would violate JSON-RPC 2.0)
        return responses

    async def _handle_single_message(
        self, data: dict[str, Any]
    ) -> Response | None:
        """Handle a single parsed message."""
        # Check JSON-RPC version
        if data.get("jsonrpc") != "2.0":
            return Response.error_response(
                id=data.get("id", ""),
                code=ErrorCode.INVALID_REQUEST,
                message="Invalid JSON-RPC version",
            )

        # Check if this is a response to a pending request
        if "result" in data or "error" in data:
            await self._handle_response(data)
            return None

        # This is a request or notification
        method = data.get("method")
        if not method:
            return Response.error_response(
                id=data.get("id", ""),
                code=ErrorCode.INVALID_REQUEST,
                message="Missing method",
            )

        params = data.get("params", {})
        request_id = data.get("id")

        # If no ID, this is a notification (no response needed)
        # CRITICAL: Use `is None` check, not truthiness - ID=0 is valid per JSON-RPC 2.0
        if request_id is None:
            await self._handle_notification(method, params)
            return None

        # Handle as request
        return await self._handle_request(request_id, method, params)

    async def _handle_response(self, data: dict[str, Any]) -> None:
        """Handle a response to a pending request."""
        response = Response.from_dict(data)
        request_id = response.id

        pending = self._pending.pop(request_id, None)
        if pending is None:
            logger.warning(f"Received response for unknown request: {request_id}")
            return

        if not pending.future.done():
            pending.future.set_result(response)

    async def _handle_request(
        self,
        request_id: str,
        method: str,
        params: dict[str, Any],
    ) -> Response:
        """Handle an incoming request."""
        handler = self._handlers.get(method)

        if handler is None:
            return Response.error_response(
                id=request_id,
                code=ErrorCode.METHOD_NOT_FOUND,
                message=f"Method not found: {method}",
            )

        try:
            result = await handler(params)
            return Response.success_response(id=request_id, result=result)

        except ValueError as e:
            return Response.error_response(
                id=request_id,
                code=ErrorCode.INVALID_PARAMS,
                message=str(e),
            )

        except Exception as e:
            logger.exception(f"Error handling method {method}")
            return Response.error_response(
                id=request_id,
                code=ErrorCode.INTERNAL_ERROR,
                message=str(e),
            )

    async def _handle_notification(
        self,
        method: str,
        params: dict[str, Any],
    ) -> None:
        """Handle an incoming notification."""
        handler = self._handlers.get(method)

        if handler is None:
            logger.debug(f"No handler for notification: {method}")
            return

        try:
            await handler(params)
        except Exception:
            logger.exception(f"Error handling notification {method}")

    def get_pending_count(self) -> int:
        """Get the number of pending requests."""
        return len(self._pending)

    def clear_pending(self, reason: str = "Connection closed") -> None:
        """
        Cancel all pending requests with an error response.

        Args:
            reason: Reason for clearing (used in error message)
        """
        for pending in self._pending.values():
            if not pending.future.done():
                # Set error response instead of just cancelling - gives callers
                # a proper error they can handle rather than CancelledError
                error_response = Response.error_response(
                    id=pending.request.id,
                    code=ErrorCode.BROKER_DISCONNECTED,
                    message=reason,
                )
                pending.future.set_result(error_response)
        self._pending.clear()


class JsonRpcClient(JsonRpcProtocol):
    """
    JSON-RPC client for connecting to daemon.

    Adds connection management and reconnection logic.
    """

    def __init__(self, timeout: float = 30.0) -> None:
        super().__init__()
        self.timeout = timeout
        self._connected = False

    @property
    def connected(self) -> bool:
        """Check if client is connected."""
        return self._connected

    async def connect(self) -> None:
        """Connect to the daemon. Override in subclass."""
        raise NotImplementedError

    async def disconnect(self) -> None:
        """Disconnect from the daemon. Override in subclass."""
        self._connected = False
        self.clear_pending(reason="Disconnected from daemon")


class JsonRpcServer(JsonRpcProtocol):
    """
    JSON-RPC server for daemon.

    Handles multiple client connections.
    """

    def __init__(self) -> None:
        super().__init__()
        self._clients: dict[str, Any] = {}

    async def start(self) -> None:
        """Start the server. Override in subclass."""
        raise NotImplementedError

    async def stop(self) -> None:
        """Stop the server. Override in subclass."""
        self.clear_pending()

    async def broadcast(
        self,
        message_type: MessageType,
        params: dict[str, Any],
        session_id: str | None = None,
    ) -> None:
        """Broadcast a notification to all connected clients."""
        # Override in subclass with actual client management
        await self.send_notification(message_type, params, session_id)

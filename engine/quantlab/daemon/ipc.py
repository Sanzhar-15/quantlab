"""
Daemon IPC Communication.

Handles JSON-RPC 2.0 communication over Unix sockets / Named pipes.

Spec Reference: Technical Spec §15, Decision A5, E29, E30, N96
"""

import asyncio
import json
import logging
import os
import secrets
import struct
from datetime import datetime
from pathlib import Path
from typing import Any
from typing import Callable

from quantlab.protocol.message import RpcErrorCode as ErrorCode
from quantlab.protocol.message import Message
from quantlab.protocol.message import MessageType
from quantlab.protocol.message import Notification
from quantlab.protocol.message import PROTOCOL_VERSION
from quantlab.protocol.message import Request
from quantlab.protocol.message import Response
from quantlab.protocol.reliability import ReliabilityManager


# Supported protocol versions (for negotiation)
SUPPORTED_VERSIONS = ["1.0"]
MIN_SUPPORTED_VERSION = "1.0"
from quantlab.protocol.transport import HEADER_SIZE
from quantlab.protocol.transport import MAX_MESSAGE_SIZE
from quantlab.protocol.transport import ConnectionClosed
from quantlab.protocol.transport import TransportError
from quantlab.protocol.transport import UnixSocketServer
from quantlab.protocol.transport import validate_session_id as _validate_session_id


logger = logging.getLogger(__name__)


# Token file constants
TOKEN_LENGTH = 32  # 256 bits

# Handshake timeout (seconds) - prevent resource exhaustion from hanging clients
HANDSHAKE_TIMEOUT = 30.0

# NEW-TRADE-002: Rate limiting defaults
DEFAULT_RATE_LIMIT = 100  # max requests per window
DEFAULT_RATE_WINDOW = 1.0  # seconds


class AuthenticationError(Exception):
    """IPC authentication failed."""

    pass


class TokenManager:
    """
    Manages IPC authentication tokens.

    Token file: ~/.quantlab/sessions/{session_id}.token
    Permissions: 0600 (owner only)

    Tokens are:
    - Generated on daemon start
    - Required for all IPC requests
    - Rotated on each session start
    """

    def __init__(self, session_id: str) -> None:
        _validate_session_id(session_id)
        self.session_id = session_id
        self._base_dir = Path.home() / ".quantlab" / "sessions"
        self._token_path = self._base_dir / f"{session_id}.token"
        self._token: str | None = None

    @property
    def token_path(self) -> Path:
        """Path to token file."""
        return self._token_path

    def generate(self) -> str:
        """
        Generate and save a new authentication token.

        Returns:
            The generated token

        Raises:
            OSError: On filesystem errors
        """
        self._base_dir.mkdir(parents=True, exist_ok=True)

        # Generate cryptographically secure token
        self._token = secrets.token_urlsafe(TOKEN_LENGTH)

        # FIX-H9: Write token with restricted permissions from creation (no TOCTOU race)
        self._write_token_secure(self._token)

        logger.debug(f"IPC token generated for session {self.session_id}")
        return self._token

    def set_token(self, token: str) -> None:
        """
        Set an externally-provided token (FIX-CGP-007).

        Used when the extension passes a token via QUANTLAB_AUTH_TOKEN env var.
        Writes the token to file so the extension's TokenAuth can read it.
        """
        self._base_dir.mkdir(parents=True, exist_ok=True)
        self._token = token
        # FIX-H9: Write token with restricted permissions from creation (no TOCTOU race)
        self._write_token_secure(token)
        logger.debug(f"IPC token set for session {self.session_id}")

    def _write_token_secure(self, token: str) -> None:
        """Write token to file with 0o600 permissions from creation.

        FIX-H9: Avoids TOCTOU race where token is briefly world-readable
        between write_text() and chmod().
        """
        fd = os.open(
            str(self._token_path),
            os.O_WRONLY | os.O_CREAT | os.O_TRUNC,
            0o600,
        )
        try:
            os.write(fd, token.encode("utf-8"))
        finally:
            os.close(fd)

    def validate(self, token: str) -> bool:
        """
        Validate an authentication token.

        Uses constant-time comparison to prevent timing attacks.

        Args:
            token: Token to validate

        Returns:
            True if token is valid
        """
        if self._token is None:
            return False

        return secrets.compare_digest(token, self._token)

    def load(self) -> str | None:
        """Load token from file."""
        if not self._token_path.exists():
            return None

        try:
            self._token = self._token_path.read_text().strip()
            return self._token
        except OSError:
            return None

    def delete(self) -> None:
        """Delete token file (called on shutdown)."""
        try:
            if self._token_path.exists():
                self._token_path.unlink()
                logger.info(f"Deleted IPC token: {self._token_path}")
        except OSError as e:
            logger.error(f"Error deleting token: {e}")

        self._token = None


class RateLimiter:
    """
    NEW-TRADE-002: Per-client sliding window rate limiter for IPC messages.

    Prevents a misbehaving or compromised client from flooding the daemon
    with requests. Uses a simple sliding window counter per client.
    """

    def __init__(
        self,
        max_requests: int = DEFAULT_RATE_LIMIT,
        window_seconds: float = DEFAULT_RATE_WINDOW,
    ) -> None:
        self._max_requests = max_requests
        self._window = window_seconds
        # client_id -> list of timestamps (monotonic)
        self._buckets: dict[str, list[float]] = {}

    def check(self, client_id: str) -> bool:
        """Check if a request from client_id is allowed.

        Returns:
            True if request is allowed, False if rate-limited.
        """
        import time

        now = time.monotonic()
        cutoff = now - self._window

        # Get or create bucket
        bucket = self._buckets.get(client_id)
        if bucket is None:
            bucket = []
            self._buckets[client_id] = bucket

        # Prune expired entries
        while bucket and bucket[0] < cutoff:
            bucket.pop(0)

        if len(bucket) >= self._max_requests:
            return False

        bucket.append(now)
        return True

    def remove_client(self, client_id: str) -> None:
        """Remove tracking for a disconnected client."""
        self._buckets.pop(client_id, None)


class IPCServer:
    """
    IPC server for daemon communication.

    Handles:
    - Client connections
    - Message framing (4-byte length prefix)
    - Token authentication
    - Request/response routing
    - Notification broadcasting
    """

    def __init__(
        self,
        session_id: str,
        token_manager: TokenManager,
        reliability_manager: ReliabilityManager | None = None,
    ) -> None:
        self.session_id = session_id
        self._token_manager = token_manager
        self._reliability = reliability_manager

        # Socket setup
        self._socket_path = Path.home() / ".quantlab" / "sessions" / f"{session_id}.sock"
        self._server = UnixSocketServer(self._socket_path)

        # Client tracking
        self._clients: dict[str, ClientConnection] = {}
        self._clients_lock = asyncio.Lock()  # FIX-D008: Lock for concurrent access
        self._next_client_id = 1

        # Request handlers
        self._handlers: dict[str, Callable[[dict[str, Any]], Any]] = {}

        # Notification subscribers
        self._subscribers: list[Callable[[Notification], None]] = []

        # NEW-TRADE-002: Per-client rate limiter
        self._rate_limiter = RateLimiter()

    @property
    def socket_path(self) -> Path:
        """Path to IPC socket."""
        return self._socket_path

    def register_handler(
        self,
        method: str,
        handler: Callable[[dict[str, Any]], Any],
    ) -> None:
        """
        Register a request handler.

        Args:
            method: JSON-RPC method name
            handler: Async function to handle requests
        """
        self._handlers[method] = handler
        logger.debug(f"Registered IPC handler: {method}")

    def on_notification(
        self,
        callback: Callable[[Notification], None],
    ) -> None:
        """Register callback for incoming notifications."""
        self._subscribers.append(callback)

    async def start(self) -> None:
        """Start the IPC server."""
        await self._server.start(self._handle_client)

        # Configure and start reliability manager
        if self._reliability:
            # Set up send callback for retry mechanism
            self._reliability.set_send_callback(self._resend_message)
            await self._reliability.start()

        logger.info(f"IPC server started: {self._socket_path}")

    async def _resend_message(self, message: Message) -> None:
        """
        Resend a message as part of retry mechanism.

        This is called by ReliabilityManager when a critical message
        needs to be retried due to missing ACK.
        """
        # Convert Message to JSON for sending
        data = json.dumps(message.to_dict()).encode("utf-8")

        # Broadcast to all connected clients
        for client_id, client in list(self._clients.items()):
            try:
                await client.send(data)
                logger.debug(f"Resent message {message.id} to client {client_id}")
            except Exception as e:
                logger.warning(f"Failed to resend to client {client_id}: {e}")

    async def stop(self) -> None:
        """Stop the IPC server."""
        # Stop reliability manager
        if self._reliability:
            await self._reliability.stop()

        # Close all client connections
        for client in list(self._clients.values()):
            await client.close()
        self._clients.clear()

        await self._server.stop()
        logger.info("IPC server stopped")

    async def broadcast(self, notification: Notification) -> None:
        """
        Broadcast a notification to all connected clients.

        Uses ReliabilityManager for:
        - State snapshots on important messages (for reconnection replay)
        - Overflow tracking when buffers fill up

        Note: Per JSON-RPC 2.0, notifications don't have IDs so standard
        ACK tracking isn't applicable. Critical reliability for notifications
        relies on state snapshots and reconnection replay.

        Args:
            notification: Notification to broadcast
        """
        # Check for overflow and inject into message _meta (per IPC Protocol spec)
        if self._reliability:
            overflow_info = self._reliability.get_overflow_info()
            if overflow_info:
                notification.overflow_info = overflow_info

        data = notification.to_json().encode("utf-8")

        # Track state snapshots for important messages (for reconnection replay)
        if self._reliability:
            from quantlab.protocol.message import ReliabilityClass

            # Create a Message for reliability tracking
            message = Message(
                type=notification.message_type,
                payload=notification.params,
                sequence=notification.sequence,
                session_id=notification.session_id,
            )

            # Track via on_message_sent for proper reliability handling
            await self._reliability.on_message_sent(message)

        # FIX-D008: Use lock for thread-safe client iteration
        async with self._clients_lock:
            clients_snapshot = list(self._clients.items())

        for client_id, client in clients_snapshot:
            try:
                await client.send(data)
            except Exception as e:
                logger.warning(f"Failed to send to client {client_id}: {e}")
                # Remove disconnected client from map BEFORE close to prevent zombie connections
                async with self._clients_lock:
                    self._clients.pop(client_id, None)
                try:
                    await client.close()
                except Exception as close_error:
                    logger.debug(f"Error closing client {client_id}: {close_error}")

    async def send_request(
        self,
        method: str,
        params: dict[str, Any],
        client_id: str | None = None,
    ) -> None:
        """
        Send a request to a specific client or broadcast to all.

        Unlike notifications, requests have IDs and can be tracked
        for ACK/retry by the reliability manager.

        Args:
            method: JSON-RPC method name
            params: Request parameters
            client_id: Target client, or None for broadcast
        """
        import uuid

        request = Request(
            message_type=MessageType(method) if method in [m.value for m in MessageType] else MessageType.STATUS_UPDATE,
            params=params,
            session_id=self.session_id,
            id=str(uuid.uuid4()),
        )

        # Track for ACK/retry if critical
        if self._reliability:
            message = Message(
                type=request.message_type,
                payload=request.params,
                id=request.id,
                sequence=request.sequence,
                session_id=request.session_id,
            )
            await self._reliability.on_message_sent(message)

        data = request.to_json().encode("utf-8")

        if client_id and client_id in self._clients:
            await self._clients[client_id].send(data)
        else:
            # Broadcast to all clients
            for cid, client in list(self._clients.items()):
                try:
                    await client.send(data)
                except Exception as e:
                    logger.warning(f"Failed to send request to client {cid}: {e}")

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        """
        Handle a new client connection.

        Connection handshake sequence:
        1. Client sends: negotiate (optional, for version negotiation)
        2. Client sends: auth (required, with token)
        3. Server responds: auth_result
        4. Normal message flow begins

        Handshake has a timeout to prevent resource exhaustion from
        clients that connect but never complete authentication.
        """
        client_id = f"client-{self._next_client_id}"
        self._next_client_id += 1

        client = ClientConnection(client_id, reader, writer)
        logger.info(f"Client connected: {client_id}")

        authenticated = False
        negotiated_version = PROTOCOL_VERSION  # Default to current version

        try:
            # Read first message with timeout - can be negotiate or authenticate
            try:
                data = await asyncio.wait_for(
                    client.receive(),
                    timeout=HANDSHAKE_TIMEOUT
                )
            except asyncio.TimeoutError:
                logger.warning(f"Client {client_id} handshake timeout")
                return

            message = json.loads(data.decode("utf-8"))
            method = message.get("method")

            # Handle optional version negotiation
            if method == "negotiate":
                negotiated_version = await self._handle_negotiate(client, message)
                if negotiated_version is None:
                    return  # Negotiation failed

                # Read next message (must be auth) with timeout
                try:
                    data = await asyncio.wait_for(
                        client.receive(),
                        timeout=HANDSHAKE_TIMEOUT
                    )
                except asyncio.TimeoutError:
                    logger.warning(f"Client {client_id} auth timeout after negotiate")
                    return

                message = json.loads(data.decode("utf-8"))
                method = message.get("method")

            # Validate authentication (accept both "authenticate" and "auth")
            if method not in ("authenticate", "auth"):
                await client.send_error(
                    message.get("id"),
                    ErrorCode.INVALID_REQUEST,
                    "First message must be negotiate or auth",
                )
                return

            token = message.get("params", {}).get("token")
            if not self._token_manager.validate(token):
                await client.send_error(
                    message.get("id"),
                    ErrorCode.NOT_AUTHENTICATED,
                    "Invalid authentication token",
                )
                return

            # Authentication successful
            authenticated = True
            self._clients[client_id] = client
            await client.send_result(message.get("id"), {
                "status": "authenticated",
                "protocolVersion": negotiated_version,
                "sessionId": self.session_id,
            })
            logger.info(f"Client authenticated: {client_id} (protocol v{negotiated_version})")

            # FIX-P003: Send FRESH state snapshot on reconnect (per IPC Protocol spec)
            # This ensures UI has current state after reconnection, not stale data
            if self._reliability:
                snapshot = await self._reliability.get_fresh_reconnect_snapshot()
                if snapshot.positions or snapshot.orders:
                    await client.send_result(None, {
                        "type": "state_snapshot",
                        "positions": snapshot.positions,
                        "orders": snapshot.orders,
                        "performance": snapshot.performance,
                        "connectionStatus": snapshot.connection_status,
                        "timestamp": snapshot.timestamp,
                    })

            # Process messages
            while True:
                data = await client.receive()
                await self._process_message(client, data)

        except ConnectionClosed:
            logger.info(f"Client disconnected: {client_id}")
        except Exception as e:
            logger.error(f"Client error {client_id}: {e}")
        finally:
            if authenticated:
                self._clients.pop(client_id, None)
            self._rate_limiter.remove_client(client_id)  # NEW-TRADE-002: Clean up rate limit tracking
            await client.close()

    async def _handle_negotiate(
        self,
        client: "ClientConnection",
        message: dict[str, Any],
    ) -> str | None:
        """
        Handle protocol version negotiation.

        Args:
            client: The client connection
            message: The negotiate message

        Returns:
            Negotiated version string, or None if negotiation failed
        """
        msg_id = message.get("id")
        params = message.get("params", {})
        client_versions = params.get("supportedVersions", [PROTOCOL_VERSION])

        # FIX-P005: Find HIGHEST mutually supported version (not first/lowest)
        # Sort both lists in descending order and find highest common version
        def version_key(v: str) -> tuple:
            """Parse version string for sorting (e.g., '1.2.3' -> (1, 2, 3))."""
            try:
                return tuple(int(x) for x in v.split("."))
            except (ValueError, AttributeError):
                return (0,)

        mutual_versions = set(SUPPORTED_VERSIONS) & set(client_versions)
        negotiated = None
        if mutual_versions:
            # Pick the highest version from mutually supported
            negotiated = max(mutual_versions, key=version_key)

        if negotiated is None:
            await client.send_error(
                msg_id,
                ErrorCode.INVALID_PARAMS,
                f"No compatible protocol version. Server supports: {SUPPORTED_VERSIONS}",
                data={"serverVersions": SUPPORTED_VERSIONS},
            )
            logger.warning(
                f"Version negotiation failed: client supports {client_versions}, "
                f"server supports {SUPPORTED_VERSIONS}"
            )
            return None

        # Send negotiation result
        await client.send_result(msg_id, {
            "protocolVersion": negotiated,
            "serverVersions": SUPPORTED_VERSIONS,
        })
        logger.debug(f"Negotiated protocol version: {negotiated}")
        return negotiated

    async def _process_message(
        self,
        client: "ClientConnection",
        data: bytes,
    ) -> None:
        """Process a received message.

        FIX-P004: Uses ErrorCode enum instead of magic numbers.
        NEW-TRADE-002: Rate-limits per client before processing.
        """
        # NEW-TRADE-002: Rate limit check
        if not self._rate_limiter.check(client.client_id):
            logger.warning(f"Rate limit exceeded for client {client.client_id}")
            await client.send_error(None, ErrorCode.INTERNAL_ERROR, "Rate limit exceeded")
            return

        try:
            message = json.loads(data.decode("utf-8"))
        except json.JSONDecodeError as e:
            await client.send_error(None, ErrorCode.PARSE_ERROR, f"Parse error: {e}")
            return

        # Validate JSON-RPC format
        if message.get("jsonrpc") != "2.0":
            await client.send_error(
                message.get("id"),
                ErrorCode.INVALID_REQUEST,
                "Invalid Request: must be JSON-RPC 2.0",
            )
            return

        method = message.get("method")
        if not method:
            await client.send_error(
                message.get("id"),
                ErrorCode.INVALID_REQUEST,
                "Invalid Request: missing method",
            )
            return

        msg_id = message.get("id")
        params = message.get("params", {})

        # Handle request (has id) vs notification (no id)
        if msg_id is not None:
            # Request - needs response
            handler = self._handlers.get(method)
            if not handler:
                await client.send_error(msg_id, ErrorCode.METHOD_NOT_FOUND, f"Method not found: {method}")
                return

            try:
                result = handler(params)
                if asyncio.iscoroutine(result):
                    result = await result
                await client.send_result(msg_id, result)
            except Exception as e:
                logger.error(f"Handler error for {method}: {e}")
                await client.send_error(msg_id, ErrorCode.INTERNAL_ERROR, f"Internal error: {e}")

        else:
            # Notification - no response needed
            notification = Notification(
                message_type=MessageType(method) if method in [m.value for m in MessageType] else MessageType.HEARTBEAT,
                params=params,
                session_id=self.session_id,
            )

            for subscriber in self._subscribers:
                try:
                    subscriber(notification)
                except Exception as e:
                    logger.error(f"Notification subscriber error: {e}")


class ClientConnection:
    """Represents a connected IPC client."""

    def __init__(
        self,
        client_id: str,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        self.client_id = client_id
        self._reader = reader
        self._writer = writer
        self._connected = True

    async def receive(self) -> bytes:
        """
        Receive a framed message.

        Returns:
            Message data

        Raises:
            ConnectionClosed: If connection is closed
        """
        if not self._connected:
            raise ConnectionClosed("Not connected")

        try:
            # Read 4-byte length header
            header = await self._reader.readexactly(HEADER_SIZE)
            length = struct.unpack(">I", header)[0]

            if length > MAX_MESSAGE_SIZE:
                raise TransportError(f"Message too large: {length}")

            # Read message body
            data = await self._reader.readexactly(length)
            return data

        except asyncio.IncompleteReadError:
            self._connected = False
            raise ConnectionClosed("Connection closed")

    async def send(self, data: bytes) -> None:
        """Send a framed message."""
        if not self._connected:
            raise ConnectionClosed("Not connected")

        if len(data) > MAX_MESSAGE_SIZE:
            raise TransportError(f"Message too large: {len(data)}")

        header = struct.pack(">I", len(data))
        self._writer.write(header + data)
        await self._writer.drain()

    async def send_result(self, msg_id: str | int | None, result: Any) -> None:
        """Send a JSON-RPC result response."""
        response = {
            "jsonrpc": "2.0",
            "result": result,
            "id": msg_id,
        }
        await self.send(json.dumps(response).encode("utf-8"))

    async def send_error(
        self,
        msg_id: str | int | None,
        code: int,
        message: str,
        data: Any = None,
    ) -> None:
        """Send a JSON-RPC error response."""
        error: dict[str, Any] = {
            "code": code,
            "message": message,
        }
        if data is not None:
            error["data"] = data

        response = {
            "jsonrpc": "2.0",
            "error": error,
            "id": msg_id,
        }
        await self.send(json.dumps(response).encode("utf-8"))

    async def close(self) -> None:
        """Close the connection."""
        if self._writer:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except Exception:
                pass
        self._connected = False


class IPCClient:
    """
    IPC client for connecting to a running daemon.

    Used by:
    - UI to communicate with daemon
    - CLI tools
    - Tests
    """

    def __init__(self, session_id: str, token: str) -> None:
        self.session_id = session_id
        self._token = token
        self._socket_path = Path.home() / ".quantlab" / "sessions" / f"{session_id}.sock"
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._connected = False
        self._request_id = 0
        self._request_id_lock = asyncio.Lock()  # Protect request ID generation
        self._pending_responses: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._notification_callbacks: list[Callable[[dict[str, Any]], None]] = []
        self._read_task: asyncio.Task[None] | None = None

    async def connect(self) -> None:
        """Connect to the daemon."""
        if self._connected:
            return

        try:
            self._reader, self._writer = await asyncio.open_unix_connection(
                str(self._socket_path)
            )
            self._connected = True

            # Authenticate
            response = await self._send_request("authenticate", {"token": self._token})
            if response.get("status") != "authenticated":
                raise AuthenticationError("Authentication failed")

            # Start reading responses
            self._read_task = asyncio.create_task(self._read_loop())

            logger.info(f"Connected to daemon: {self.session_id}")

        except Exception as e:
            self._connected = False
            raise ConnectionClosed(f"Failed to connect: {e}") from e

    async def disconnect(self) -> None:
        """Disconnect from the daemon."""
        if self._read_task:
            self._read_task.cancel()
            try:
                await self._read_task
            except asyncio.CancelledError:
                pass

        if self._writer:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except Exception:
                pass

        self._reader = None
        self._writer = None
        self._connected = False
        logger.info(f"Disconnected from daemon: {self.session_id}")

    async def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """
        Call a method on the daemon.

        Args:
            method: JSON-RPC method name
            params: Method parameters

        Returns:
            Result from daemon

        Raises:
            ConnectionClosed: If not connected
            Exception: On RPC errors
        """
        response = await self._send_request(method, params or {})

        if "error" in response:
            error = response["error"]
            raise Exception(f"RPC error {error['code']}: {error['message']}")

        return response.get("result")

    def on_notification(
        self,
        callback: Callable[[dict[str, Any]], None],
    ) -> None:
        """Register callback for notifications from daemon."""
        self._notification_callbacks.append(callback)

    async def _send_request(
        self,
        method: str,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        """Send a request and wait for response."""
        if not self._connected or not self._writer:
            raise ConnectionClosed("Not connected")

        # Generate unique request ID under lock to prevent duplicates in concurrent calls
        async with self._request_id_lock:
            self._request_id += 1
            msg_id = f"req-{self._request_id}"

        request = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": msg_id,
        }

        # Create future for response
        future: asyncio.Future[dict[str, Any]] = asyncio.Future()
        self._pending_responses[msg_id] = future

        # Send request
        data = json.dumps(request).encode("utf-8")
        header = struct.pack(">I", len(data))
        self._writer.write(header + data)
        await self._writer.drain()

        # Wait for response with timeout
        try:
            return await asyncio.wait_for(future, timeout=30.0)
        except asyncio.TimeoutError:
            # Clean up and cancel the pending future
            self._pending_responses.pop(msg_id, None)
            future.cancel()
            raise ConnectionClosed("Request timeout")

    async def _read_loop(self) -> None:
        """Read responses and notifications from daemon."""
        while self._connected and self._reader:
            try:
                # Read header
                header = await self._reader.readexactly(HEADER_SIZE)
                length = struct.unpack(">I", header)[0]

                # Read body
                data = await self._reader.readexactly(length)
                message = json.loads(data.decode("utf-8"))

                msg_id = message.get("id")

                if msg_id and msg_id in self._pending_responses:
                    # Response to our request
                    future = self._pending_responses.pop(msg_id)
                    future.set_result(message)
                else:
                    # Notification
                    for callback in self._notification_callbacks:
                        try:
                            callback(message)
                        except Exception as e:
                            logger.error(f"Notification callback error: {e}")

            except asyncio.IncompleteReadError:
                self._connected = False
                break
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Read loop error: {e}")
                self._connected = False
                break

        # Cancel any pending requests
        for future in self._pending_responses.values():
            if not future.done():
                future.set_exception(ConnectionClosed("Connection lost"))
        self._pending_responses.clear()

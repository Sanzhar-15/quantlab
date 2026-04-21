"""
IPC Transport Layer.

Implements Unix socket (Linux/macOS) and Named pipe (Windows) transports.

Spec Reference: Technical Spec §15, Decision A5
"""

import asyncio
import logging
import os
import platform
import re
import stat
import struct
from abc import ABC
from abc import abstractmethod
from pathlib import Path
from typing import Any


logger = logging.getLogger(__name__)


# Message framing: 4-byte length prefix
HEADER_SIZE = 4
MAX_MESSAGE_SIZE = 10 * 1024 * 1024  # 10 MB max message size

# FIX-M11: Session ID validation to prevent path injection
_VALID_SESSION_ID = re.compile(r"^[a-zA-Z0-9_\-]{1,128}$")


def validate_session_id(session_id: str) -> str:
    """
    Validate session ID is safe for use in file paths.

    Prevents path traversal attacks (e.g., "../../../etc/passwd").

    Args:
        session_id: Session identifier to validate

    Returns:
        The validated session_id

    Raises:
        ValueError: If session_id contains unsafe characters
    """
    if not _VALID_SESSION_ID.match(session_id):
        raise ValueError(
            f"Invalid session ID: {session_id!r}. "
            "Must be 1-128 alphanumeric/dash/underscore characters."
        )
    return session_id


class TransportError(Exception):
    """Base exception for transport errors."""

    pass


class ConnectionClosed(TransportError):
    """Connection was closed."""

    pass


class MessageTooLarge(TransportError):
    """Message exceeds maximum size."""

    pass


class Transport(ABC):
    """
    Abstract base class for IPC transport.

    Implements length-prefixed message framing.
    """

    def __init__(self) -> None:
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._connected = False

    @property
    def connected(self) -> bool:
        """Check if transport is connected."""
        return self._connected

    @abstractmethod
    async def connect(self) -> None:
        """Establish connection."""
        pass

    @abstractmethod
    async def close(self) -> None:
        """Close connection."""
        pass

    async def send(self, data: bytes) -> None:
        """
        Send a message with length prefix.

        Args:
            data: Message data to send

        Raises:
            ConnectionClosed: If not connected
            MessageTooLarge: If message exceeds max size
        """
        if not self._connected or self._writer is None:
            raise ConnectionClosed("Not connected")

        if len(data) > MAX_MESSAGE_SIZE:
            raise MessageTooLarge(f"Message size {len(data)} exceeds max {MAX_MESSAGE_SIZE}")

        # Frame message with 4-byte length prefix (big-endian)
        header = struct.pack(">I", len(data))
        self._writer.write(header + data)
        await self._writer.drain()

    async def receive(self) -> bytes:
        """
        Receive a message.

        Returns:
            Message data

        Raises:
            ConnectionClosed: If connection is closed
            MessageTooLarge: If message exceeds max size
        """
        if not self._connected or self._reader is None:
            raise ConnectionClosed("Not connected")

        # Read length header
        header = await self._reader.readexactly(HEADER_SIZE)
        if len(header) < HEADER_SIZE:
            raise ConnectionClosed("Connection closed while reading header")

        length = struct.unpack(">I", header)[0]

        if length > MAX_MESSAGE_SIZE:
            raise MessageTooLarge(f"Message size {length} exceeds max {MAX_MESSAGE_SIZE}")

        # Read message body
        data = await self._reader.readexactly(length)
        if len(data) < length:
            raise ConnectionClosed("Connection closed while reading body")

        return data


class UnixSocketTransport(Transport):
    """
    Unix socket transport for Linux and macOS.

    Socket path: ~/.quantlab/sessions/{session_id}.sock
    Permissions: 0600 (owner only)
    """

    def __init__(self, socket_path: str | Path) -> None:
        super().__init__()
        self.socket_path = Path(socket_path)

    async def connect(self) -> None:
        """Connect to Unix socket."""
        if self._connected:
            return

        try:
            self._reader, self._writer = await asyncio.open_unix_connection(
                str(self.socket_path)
            )
            self._connected = True
            logger.info(f"Connected to Unix socket: {self.socket_path}")

        except Exception as e:
            logger.error(f"Failed to connect to {self.socket_path}: {e}")
            raise ConnectionClosed(f"Failed to connect: {e}") from e

    async def close(self) -> None:
        """Close Unix socket connection."""
        if self._writer:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except Exception:
                pass

        self._reader = None
        self._writer = None
        self._connected = False
        logger.info(f"Disconnected from Unix socket: {self.socket_path}")


class UnixSocketServer:
    """
    Unix socket server.

    Creates socket with secure permissions (0600).
    """

    def __init__(self, socket_path: str | Path) -> None:
        self.socket_path = Path(socket_path)
        self._server: asyncio.AbstractServer | None = None
        self._clients: list[tuple[asyncio.StreamReader, asyncio.StreamWriter]] = []

    async def start(
        self,
        client_handler: Any,
    ) -> None:
        """
        Start the Unix socket server.

        Args:
            client_handler: Async callback for new connections
        """
        # Ensure parent directory exists
        self.socket_path.parent.mkdir(parents=True, exist_ok=True)

        # Remove existing socket file
        if self.socket_path.exists():
            self.socket_path.unlink()

        self._server = await asyncio.start_unix_server(
            client_handler,
            path=str(self.socket_path),
        )

        # Set socket permissions to owner-only (0600)
        os.chmod(self.socket_path, stat.S_IRUSR | stat.S_IWUSR)

        logger.info(f"Unix socket server started: {self.socket_path}")

    async def stop(self) -> None:
        """Stop the server."""
        if self._server:
            self._server.close()
            await self._server.wait_closed()

        # Clean up socket file
        if self.socket_path.exists():
            self.socket_path.unlink()

        logger.info(f"Unix socket server stopped: {self.socket_path}")


class NamedPipeTransport(Transport):
    r"""
    Named pipe transport for Windows.

    Pipe name: \\.\pipe\quantlab-{session_id}
    """

    def __init__(self, pipe_name: str) -> None:
        super().__init__()
        self.pipe_name = pipe_name

    async def connect(self) -> None:
        """Connect to named pipe using Windows ProactorEventLoop."""
        if self._connected:
            return

        if platform.system() != "Windows":
            raise TransportError("Named pipes only supported on Windows")

        try:
            loop = asyncio.get_running_loop()
            reader = asyncio.StreamReader()
            protocol = asyncio.StreamReaderProtocol(reader)
            transport, _ = await loop.create_pipe_connection(
                lambda: protocol, self.pipe_name
            )
            writer = asyncio.StreamWriter(transport, protocol, reader, loop)
            self._reader = reader
            self._writer = writer
            self._connected = True
            logger.info(f"Connected to named pipe: {self.pipe_name}")

        except Exception as e:
            logger.error(f"Failed to connect to {self.pipe_name}: {e}")
            raise ConnectionClosed(f"Failed to connect: {e}") from e

    async def close(self) -> None:
        """Close named pipe connection."""
        if self._writer:
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except Exception:
                pass

        self._reader = None
        self._writer = None
        self._connected = False


def get_socket_path(session_id: str) -> Path:
    """
    Get the socket path for a session.

    Args:
        session_id: Session identifier

    Returns:
        Path to socket file
    """
    validate_session_id(session_id)
    base_dir = Path.home() / ".quantlab" / "sessions"
    base_dir.mkdir(parents=True, exist_ok=True)
    return base_dir / f"{session_id}.sock"


def get_pipe_name(session_id: str) -> str:
    """
    Get the pipe name for a session (Windows).

    Args:
        session_id: Session identifier

    Returns:
        Named pipe path
    """
    validate_session_id(session_id)
    return f"\\\\.\\pipe\\quantlab-{session_id}"


def create_transport(session_id: str) -> Transport:
    """
    Create appropriate transport for the current platform.

    Args:
        session_id: Session identifier

    Returns:
        Transport instance
    """
    if platform.system() == "Windows":
        return NamedPipeTransport(get_pipe_name(session_id))
    else:
        return UnixSocketTransport(get_socket_path(session_id))

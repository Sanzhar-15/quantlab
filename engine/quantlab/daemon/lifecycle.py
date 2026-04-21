"""
Daemon Lifecycle Management.

Handles PID file creation, validation, and cleanup.

Spec Reference: Technical Spec §1.5, Decision L69, N99
"""

import atexit
import logging
import os
import signal
import sys
from pathlib import Path
from typing import Callable

import psutil


logger = logging.getLogger(__name__)


# =============================================================================
# FIX-PL001: Cross-platform file locking
# =============================================================================

if sys.platform == "win32":
    import msvcrt

    def _lock_file(fd: int, exclusive: bool = True) -> bool:
        """Lock file on Windows using msvcrt."""
        try:
            msvcrt.locking(
                fd,
                msvcrt.LK_NBLCK if exclusive else msvcrt.LK_NBRLCK,
                1  # Lock first byte
            )
            return True
        except (IOError, OSError):
            return False

    def _unlock_file(fd: int) -> None:
        """Unlock file on Windows using msvcrt."""
        try:
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except (IOError, OSError):
            pass

else:
    import fcntl

    def _lock_file(fd: int, exclusive: bool = True) -> bool:
        """Lock file on Unix using fcntl."""
        try:
            flags = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
            fcntl.flock(fd, flags | fcntl.LOCK_NB)
            return True
        except (IOError, OSError):
            return False

    def _unlock_file(fd: int) -> None:
        """Unlock file on Unix using fcntl."""
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except (IOError, OSError):
            pass


class PidFileError(Exception):
    """Error managing PID file."""

    pass


class DaemonAlreadyRunning(PidFileError):
    """Daemon is already running for this session."""

    pass


class PidFile:
    """
    PID file manager for daemon processes.

    Location: ~/.quantlab/sessions/{session_id}.pid

    The PID file ensures only one daemon runs per session and
    allows detection of stale daemons after crashes.
    """

    def __init__(self, session_id: str) -> None:
        from quantlab.protocol.transport import validate_session_id
        validate_session_id(session_id)
        self.session_id = session_id
        self._base_dir = Path.home() / ".quantlab" / "sessions"
        self._pid_path = self._base_dir / f"{session_id}.pid"
        self._acquired = False
        self._lock_fd: int | None = None  # File descriptor for lock

    @property
    def pid_path(self) -> Path:
        """Path to the PID file."""
        return self._pid_path

    def acquire(self) -> None:
        """
        Acquire the PID file lock.

        Creates the PID file with current process ID using atomic file locking
        to prevent race conditions between multiple daemon startups.

        Raises:
            DaemonAlreadyRunning: If another daemon is running for this session
            PidFileError: On filesystem errors
        """
        if self._acquired:
            return

        self._base_dir.mkdir(parents=True, exist_ok=True)

        # Use atomic file locking to prevent race conditions
        # Open with O_CREAT to create if not exists, with secure permissions
        try:
            # Open file descriptor with secure permissions (0o600) from the start
            fd = os.open(
                self._pid_path,
                os.O_RDWR | os.O_CREAT,
                0o600
            )
        except OSError as e:
            raise PidFileError(f"Failed to open PID file: {e}") from e

        try:
            # Try to acquire exclusive lock (non-blocking) - FIX-PL001: cross-platform
            if not _lock_file(fd, exclusive=True):
                # Lock failed - another process holds it
                # Read the existing PID to report in error
                os.close(fd)
                existing_pid = self._read_pid()
                raise DaemonAlreadyRunning(
                    f"Daemon already running for session {self.session_id} (PID {existing_pid})"
                )

            # We have the lock - check if there's an existing stale PID
            existing_content = os.read(fd, 100).decode().strip()
            if existing_content:
                try:
                    existing_pid = int(existing_content)
                    if self._is_process_alive(existing_pid) and existing_pid != os.getpid():
                        # Process is alive but we got the lock - this shouldn't happen
                        # but handle it defensively
                        _unlock_file(fd)
                        os.close(fd)
                        raise DaemonAlreadyRunning(
                            f"Daemon already running for session {self.session_id} (PID {existing_pid})"
                        )
                    else:
                        logger.warning(
                            f"Removing stale PID file for session {self.session_id} (was PID {existing_pid})"
                        )
                except ValueError:
                    # Invalid content in PID file
                    logger.warning(f"Invalid content in PID file, overwriting")

            # Write our PID (truncate and write)
            os.ftruncate(fd, 0)
            os.lseek(fd, 0, os.SEEK_SET)
            os.write(fd, str(os.getpid()).encode())
            os.fsync(fd)  # Ensure write is durable

            # Keep the file open to maintain the lock
            self._lock_fd = fd
            self._acquired = True
            logger.info(f"Acquired PID file: {self._pid_path}")

            # Register cleanup on exit
            atexit.register(self.release)

        except Exception:
            # Clean up on any error
            try:
                os.close(fd)
            except OSError:
                pass
            raise

    def release(self) -> None:
        """Release the PID file lock."""
        if not self._acquired:
            return

        try:
            # Release the file lock and close the file descriptor
            if self._lock_fd is not None:
                # FIX-PL001: Use cross-platform unlock
                _unlock_file(self._lock_fd)

                try:
                    os.close(self._lock_fd)
                except OSError:
                    pass  # Ignore close errors

                self._lock_fd = None

            # Remove the PID file
            if self._pid_path.exists():
                # Verify we own the PID file
                stored_pid = self._read_pid()
                if stored_pid == os.getpid():
                    self._pid_path.unlink()
                    logger.info(f"Released PID file: {self._pid_path}")
        except OSError as e:
            logger.error(f"Error releasing PID file: {e}")

        self._acquired = False

    def _read_pid(self) -> int | None:
        """Read PID from file."""
        try:
            content = self._pid_path.read_text().strip()
            return int(content)
        except (OSError, ValueError):
            return None

    @staticmethod
    def _is_process_alive(pid: int) -> bool:
        """Check if a process is running."""
        try:
            return psutil.pid_exists(pid)
        except Exception:
            return False

    @classmethod
    def get_session_pid(cls, session_id: str) -> int | None:
        """
        Get the PID of a running daemon for a session.

        Args:
            session_id: Session identifier

        Returns:
            PID if daemon is running, None otherwise
        """
        pid_path = Path.home() / ".quantlab" / "sessions" / f"{session_id}.pid"

        if not pid_path.exists():
            return None

        try:
            pid = int(pid_path.read_text().strip())
            if cls._is_process_alive(pid):
                return pid
            # Stale PID file
            return None
        except (OSError, ValueError):
            return None


class DaemonState:
    """
    Daemon running state.

    States:
        STARTING: Daemon is initializing
        ACTIVE: Market open, strategy running
        PAUSED: User paused session
        MARKET_CLOSED: Outside market hours
        STOPPING: Graceful shutdown in progress
        STOPPED: Daemon has stopped
    """

    STARTING = "starting"
    ACTIVE = "active"
    PAUSED = "paused"
    MARKET_CLOSED = "market_closed"
    STOPPING = "stopping"
    STOPPED = "stopped"


class SignalHandler:
    """
    Cross-platform signal handler for graceful shutdown (FIX-PL004).

    Handles:
        SIGTERM: Graceful shutdown (Unix only)
        SIGINT: Graceful shutdown (Ctrl+C)
        SIGBREAK: Graceful shutdown (Windows Ctrl+Break)
        SIGHUP: Ignored on Unix (daemon detached from terminal)
    """

    def __init__(self) -> None:
        self._shutdown_requested = False
        self._shutdown_callbacks: list[Callable[[], None]] = []
        self._original_handlers: dict[int, Any] = {}

    def install(self) -> None:
        """Install signal handlers (cross-platform, FIX-PL004)."""
        # SIGINT is available on all platforms
        self._original_handlers[signal.SIGINT] = signal.signal(
            signal.SIGINT, self._handle_shutdown
        )

        # Unix-specific signals
        if sys.platform != "win32":
            self._original_handlers[signal.SIGTERM] = signal.signal(
                signal.SIGTERM, self._handle_shutdown
            )
            # Ignore SIGHUP on Unix (daemon is detached)
            if hasattr(signal, "SIGHUP"):
                self._original_handlers[signal.SIGHUP] = signal.signal(  # type: ignore[attr-defined]
                    signal.SIGHUP, signal.SIG_IGN  # type: ignore[attr-defined]
                )

        # Windows-specific: SIGBREAK for Ctrl+Break
        if sys.platform == "win32" and hasattr(signal, "SIGBREAK"):
            self._original_handlers[signal.SIGBREAK] = signal.signal(  # type: ignore[attr-defined]
                signal.SIGBREAK, self._handle_shutdown  # type: ignore[attr-defined]
            )

        logger.info("Signal handlers installed")

    def uninstall(self) -> None:
        """Restore original signal handlers."""
        for sig, handler in self._original_handlers.items():
            signal.signal(sig, handler)
        self._original_handlers.clear()
        logger.info("Signal handlers uninstalled")

    def _handle_shutdown(
        self, signum: int, frame: object  # noqa: ARG002
    ) -> None:
        """Handle shutdown signal."""
        sig_name = signal.Signals(signum).name
        logger.info(f"Received {sig_name}, initiating graceful shutdown")
        self._shutdown_requested = True

        # Call registered callbacks
        for callback in self._shutdown_callbacks:
            try:
                callback()
            except Exception as e:
                logger.error(f"Error in shutdown callback: {e}")

    @property
    def shutdown_requested(self) -> bool:
        """Check if shutdown has been requested."""
        return self._shutdown_requested

    def on_shutdown(self, callback: Callable[[], None]) -> None:
        """Register a shutdown callback."""
        self._shutdown_callbacks.append(callback)


def daemonize() -> None:
    """
    Daemonize the current process (FIX-PL002: cross-platform support).

    On Unix: Performs double-fork to detach from controlling terminal.
    On Windows: Uses subprocess to spawn detached background process.
    """
    if sys.platform == "win32":
        # FIX-PL002: Windows daemonization via subprocess
        _daemonize_windows()
        return

    # Unix: Double-fork approach
    # First fork
    pid = os.fork()
    if pid > 0:
        # Parent exits
        sys.exit(0)

    # Decouple from parent environment
    os.chdir("/")
    os.setsid()
    os.umask(0)

    # Second fork
    pid = os.fork()
    if pid > 0:
        # First child exits
        sys.exit(0)

    # Redirect standard file descriptors
    sys.stdout.flush()
    sys.stderr.flush()

    # FIX-D002: Use os.open directly instead of Python open() to avoid
    # double-close issues with the Python file object finalizer
    devnull_fd = os.open("/dev/null", os.O_RDWR)
    os.dup2(devnull_fd, sys.stdin.fileno())
    os.dup2(devnull_fd, sys.stdout.fileno())
    os.dup2(devnull_fd, sys.stderr.fileno())
    # Only close if not one of the standard FDs (which it shouldn't be after fork)
    if devnull_fd > 2:
        os.close(devnull_fd)

    logger.info(f"Process daemonized (PID {os.getpid()})")


def _daemonize_windows() -> None:
    """
    Windows daemonization using subprocess (FIX-PL002).

    Spawns the daemon as a detached subprocess with no console window.
    The current process then exits, leaving the daemon running.
    """
    import subprocess

    # Get the current script/module being run
    python_exe = sys.executable
    script_args = sys.argv[:]

    # Add a flag to indicate we're already daemonized
    if "--daemonized" not in script_args:
        script_args.append("--daemonized")

        # Windows-specific creation flags for detached process
        DETACHED_PROCESS = 0x00000008
        CREATE_NO_WINDOW = 0x08000000
        CREATE_NEW_PROCESS_GROUP = 0x00000200

        creationflags = DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP

        # Start detached subprocess
        try:
            process = subprocess.Popen(
                [python_exe] + script_args,
                creationflags=creationflags,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            logger.info(f"Windows daemon spawned (PID {process.pid})")
            # Parent exits
            sys.exit(0)
        except Exception as e:
            logger.error(f"Failed to spawn Windows daemon: {e}")
            raise
    else:
        # We are the daemonized process, continue running
        logger.info(f"Windows daemon running (PID {os.getpid()})")

# Cross-Platform Compatibility Fixes

---

## FIX-PL001: Windows fcntl.flock Not Available (P0 - Critical)

**File**: `engine/quantlab/daemon/lifecycle.py:89`
**Issue**: The PID file locking uses `fcntl.flock()` which is Unix-only. On Windows, this will cause an ImportError or AttributeError, preventing the daemon from starting.

**Fix**: Create platform-specific locking:
```python
import sys

if sys.platform == "win32":
    import msvcrt

    def _lock_file(fd: int, exclusive: bool = True) -> bool:
        """Lock file on Windows."""
        try:
            msvcrt.locking(
                fd,
                msvcrt.LK_NBLCK if exclusive else msvcrt.LK_NBRLCK,
                1  # Lock first byte
            )
            return True
        except IOError:
            return False

    def _unlock_file(fd: int) -> None:
        """Unlock file on Windows."""
        try:
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        except IOError:
            pass
else:
    import fcntl

    def _lock_file(fd: int, exclusive: bool = True) -> bool:
        """Lock file on Unix."""
        try:
            flags = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
            fcntl.flock(fd, flags | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def _unlock_file(fd: int) -> None:
        """Unlock file on Unix."""
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
```

Update `PidFile.acquire()`:
```python
def acquire(self) -> None:
    # ... existing code up to fd open ...

    try:
        if not _lock_file(fd, exclusive=True):
            os.close(fd)
            existing_pid = self._read_pid()
            raise DaemonAlreadyRunning(
                f"Daemon already running for session {self.session_id} (PID {existing_pid})"
            )
        # ... rest of method ...
```

---

## FIX-PL002: Windows Daemonization Not Implemented (P1 - High)

**File**: `engine/quantlab/daemon/lifecycle.py:302`
**Issue**: `daemonize()` uses Unix `fork()` which doesn't exist on Windows. The current code just logs a warning but provides no alternative.

**Fix**: Implement Windows background process:
```python
def daemonize() -> None:
    """
    Daemonize the current process.

    On Unix: Double-fork to detach from terminal.
    On Windows: Use CREATE_NO_WINDOW flag for subprocess.
    """
    if sys.platform == "win32":
        _daemonize_windows()
    else:
        _daemonize_unix()


def _daemonize_unix() -> None:
    """Unix daemonization via double-fork."""
    # ... existing fork code ...


def _daemonize_windows() -> None:
    """
    Windows 'daemonization'.

    Windows doesn't have true daemonization. Instead, we:
    1. Launch as a detached subprocess
    2. Exit the parent process

    For a true background service, use Windows Service API.
    """
    import subprocess

    # Get current script/module to re-launch
    args = [sys.executable] + sys.argv

    # CREATE_NO_WINDOW prevents console window
    # DETACHED_PROCESS runs independently of parent
    CREATE_NO_WINDOW = 0x08000000
    DETACHED_PROCESS = 0x00000008

    proc = subprocess.Popen(
        args,
        creationflags=CREATE_NO_WINDOW | DETACHED_PROCESS,
        close_fds=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
    )

    logger.info(f"Windows daemon started (PID {proc.pid})")
    sys.exit(0)
```

Note: For production Windows deployment, consider implementing as a Windows Service using `pywin32` or `nssm`.

---

## FIX-PL003: Windows Named Pipe Transport Missing (P1 - High)

**File**: `engine/quantlab/protocol/transport.py`
**Issue**: Only `UnixSocketServer` is implemented. Windows requires Named Pipes.

**Fix**: Add Named Pipe server:
```python
import sys

if sys.platform == "win32":
    import win32pipe
    import win32file
    import pywintypes

    class NamedPipeServer:
        """Windows Named Pipe IPC server."""

        def __init__(self, session_id: str):
            self._pipe_name = f"\\\\.\\pipe\\quantlab_{session_id}"
            self._running = False
            self._pipe = None

        async def start(self, handler) -> None:
            """Start the named pipe server."""
            self._running = True
            self._handler = handler

            asyncio.create_task(self._accept_loop())
            logger.info(f"Named pipe server started: {self._pipe_name}")

        async def _accept_loop(self) -> None:
            """Accept client connections."""
            while self._running:
                try:
                    pipe = win32pipe.CreateNamedPipe(
                        self._pipe_name,
                        win32pipe.PIPE_ACCESS_DUPLEX | win32file.FILE_FLAG_OVERLAPPED,
                        win32pipe.PIPE_TYPE_MESSAGE | win32pipe.PIPE_READMODE_MESSAGE,
                        win32pipe.PIPE_UNLIMITED_INSTANCES,
                        65536, 65536, 0, None
                    )

                    # Wait for client connection
                    await asyncio.get_event_loop().run_in_executor(
                        None, win32pipe.ConnectNamedPipe, pipe, None
                    )

                    # Handle client in new task
                    asyncio.create_task(self._handle_client(pipe))

                except pywintypes.error as e:
                    if self._running:
                        logger.error(f"Named pipe error: {e}")

        async def stop(self) -> None:
            """Stop the server."""
            self._running = False
            # Cleanup...


def create_ipc_server(session_id: str):
    """Create appropriate IPC server for the platform."""
    if sys.platform == "win32":
        return NamedPipeServer(session_id)
    else:
        socket_path = Path.home() / ".quantlab" / "sockets" / f"{session_id}.sock"
        return UnixSocketServer(socket_path)
```

---

## FIX-PL004: Signal Handlers Use Unix-Only Signals (P1 - High)

**File**: `engine/quantlab/daemon/lifecycle.py:263-266`
**Issue**: `SignalHandler.install()` uses `signal.SIGHUP` which doesn't exist on Windows.

**Fix**: Platform-conditional signal handling:
```python
def install(self) -> None:
    """Install signal handlers."""
    # SIGTERM and SIGINT are cross-platform
    self._original_handlers[signal.SIGTERM] = signal.signal(
        signal.SIGTERM, self._handle_shutdown
    )
    self._original_handlers[signal.SIGINT] = signal.signal(
        signal.SIGINT, self._handle_shutdown
    )

    # SIGHUP is Unix-only
    if hasattr(signal, "SIGHUP"):
        self._original_handlers[signal.SIGHUP] = signal.signal(
            signal.SIGHUP, signal.SIG_IGN
        )

    # On Windows, handle SIGBREAK (Ctrl+Break)
    if hasattr(signal, "SIGBREAK"):
        self._original_handlers[signal.SIGBREAK] = signal.signal(
            signal.SIGBREAK, self._handle_shutdown
        )

    logger.info("Signal handlers installed")
```

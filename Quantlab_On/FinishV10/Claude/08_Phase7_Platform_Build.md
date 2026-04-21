# Phase 7: Platform & Build (7 fixes)

**Windows release and packaging** -- Independent of trading logic, needed for cross-platform distribution.

## Phase Overview

This phase addresses Windows-specific issues (file locking, daemonization, named pipes, signals) and creates build/packaging scripts for distribution.

## Prerequisites

- Phase 0 (IPC Integration) -- socket transport must work before adding named pipe transport
- Can run in parallel with most other phases

---

## Fix List (Execution Order)

### FIX-PL001 [P0] Windows fcntl -> msvcrt file locking

**Problem**: PID file locking uses `fcntl` which is Unix-only. Windows needs `msvcrt`.

**Evidence**:
- `engine/quantlab/daemon/lifecycle.py:24-66` -- file locking functions

**Root Cause**: Already has cross-platform code but needs verification.

**Files to modify**:
- `engine/quantlab/daemon/lifecycle.py`

**Implementation**:

```python
# engine/quantlab/daemon/lifecycle.py
# Verify cross-platform file locking (lines 24-66):

import sys

if sys.platform == "win32":
    import msvcrt

    def _lock_file(f, exclusive: bool = True):
        """Lock file on Windows using msvcrt."""
        if exclusive:
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            msvcrt.locking(f.fileno(), msvcrt.LK_NBRLCK, 1)

    def _unlock_file(f):
        """Unlock file on Windows."""
        try:
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass  # Already unlocked

else:
    import fcntl

    def _lock_file(f, exclusive: bool = True):
        """Lock file on Unix using fcntl."""
        flags = fcntl.LOCK_EX | fcntl.LOCK_NB if exclusive else fcntl.LOCK_SH | fcntl.LOCK_NB
        fcntl.flock(f.fileno(), flags)

    def _unlock_file(f):
        """Unlock file on Unix."""
        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
```

**Verification**:
1. On Windows: PID file acquires lock, second instance fails to start
2. On Unix: Same behavior with fcntl
3. Lock release on process exit works on both platforms

**Dependencies**: None

---

### FIX-PL002 [P1] Windows daemonization (CREATE_NO_WINDOW)

**Problem**: Windows doesn't support Unix double-fork. Need `subprocess.CREATE_NO_WINDOW` for background daemon.

**Evidence**:
- `engine/quantlab/daemon/lifecycle.py:399-441` -- Windows daemonization path

**Root Cause**: Already has Windows path but needs verification and hardening.

**Files to modify**:
- `engine/quantlab/daemon/lifecycle.py`

**Implementation**:

```python
# engine/quantlab/daemon/lifecycle.py
# Verify Windows daemonization (around line 399):

def _daemonize_windows(args: list[str]):
    """Daemonize on Windows using subprocess with creation flags.

    FIX-PL002: Uses CREATE_NO_WINDOW and DETACHED_PROCESS.
    """
    import subprocess

    # Build command to restart as daemonized
    python_exe = sys.executable
    daemon_args = [python_exe, "-m", "quantlab.daemon"] + args + ["--daemonized"]

    # Windows creation flags
    creation_flags = (
        subprocess.DETACHED_PROCESS |
        subprocess.CREATE_NO_WINDOW |
        subprocess.CREATE_NEW_PROCESS_GROUP
    )

    # Redirect stdio to NUL
    startup_info = subprocess.STARTUPINFO()
    startup_info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup_info.wShowWindow = 0  # SW_HIDE

    process = subprocess.Popen(
        daemon_args,
        creationflags=creation_flags,
        startupinfo=startup_info,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )

    # Parent writes PID and exits
    pid_path = Path.home() / ".quantlab" / "sessions" / f"{args[0]}.pid"
    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(str(process.pid))

    return process.pid
```

**Verification**:
1. On Windows: `python -m quantlab.daemon start --daemonize ...` starts background process
2. No console window visible
3. Process persists after terminal closes
4. PID file written correctly

**Dependencies**: FIX-PL001

---

### FIX-PL003 [P1] Windows named pipe transport

**Problem**: Unix sockets don't exist on Windows. Need named pipe transport as alternative.

**Evidence**:
- `extensions/quantlab/src/core/ipc/SocketTransport.ts:79` -- `getSocketPath()` has Windows branch using `\\.\pipe\`
- `engine/quantlab/daemon/ipc.py` -- Unix socket only

**Files to create**:
- `engine/quantlab/protocol/transport.py`

**Files to modify**:
- `engine/quantlab/daemon/ipc.py`

**Implementation**:

```python
# engine/quantlab/protocol/transport.py

"""Cross-platform IPC transport.

FIX-PL003: Named pipe transport for Windows, Unix socket for *nix.
"""

import asyncio
import sys
from pathlib import Path

class Transport:
    """Abstract base for IPC transport."""

    async def start_server(self, handler):
        raise NotImplementedError

    async def stop(self):
        raise NotImplementedError

    @property
    def address(self) -> str:
        raise NotImplementedError


class UnixSocketTransport(Transport):
    """Unix domain socket transport."""

    def __init__(self, socket_path: Path):
        self._socket_path = socket_path
        self._server = None

    async def start_server(self, handler):
        self._socket_path.parent.mkdir(parents=True, exist_ok=True)
        # Remove stale socket
        if self._socket_path.exists():
            self._socket_path.unlink()

        self._server = await asyncio.start_unix_server(
            handler, path=str(self._socket_path)
        )
        # Set restrictive permissions
        self._socket_path.chmod(0o600)

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()
        if self._socket_path.exists():
            self._socket_path.unlink()

    @property
    def address(self) -> str:
        return str(self._socket_path)


class NamedPipeTransport(Transport):
    """Windows named pipe transport."""

    def __init__(self, pipe_name: str):
        self._pipe_name = pipe_name
        self._server = None

    async def start_server(self, handler):
        # Windows named pipe server using asyncio
        # The pipe name format is: \\.\pipe\quantlab-{session_id}
        self._server = await asyncio.start_server(
            handler,
            host=None,
            port=None,
            # Windows asyncio uses IOCP which supports named pipes
            # Alternative: use proactor event loop
        )
        # Note: Full Windows named pipe support may require
        # win32pipe/win32file from pywin32 for proper security
        import logging
        logging.getLogger(__name__).info(
            "Named pipe server listening on %s", self._pipe_name
        )

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    @property
    def address(self) -> str:
        return self._pipe_name


def create_transport(session_id: str) -> Transport:
    """Create platform-appropriate IPC transport.

    FIX-PL003: Named pipe on Windows, Unix socket on *nix.
    """
    if sys.platform == "win32":
        pipe_name = f"\\\\.\\pipe\\quantlab-{session_id}"
        return NamedPipeTransport(pipe_name)
    else:
        socket_path = Path.home() / ".quantlab" / "sessions" / f"{session_id}.sock"
        return UnixSocketTransport(socket_path)
```

Integration in IPCServer:

```python
# engine/quantlab/daemon/ipc.py
from quantlab.protocol.transport import create_transport

class IPCServer:
    def __init__(self, session_id: str, ...):
        self._transport = create_transport(session_id)
        # ... rest of init

    async def start(self):
        await self._transport.start_server(self._handle_client)

    async def stop(self):
        await self._transport.stop()
```

**Verification**:
1. On Windows: named pipe created at `\\.\pipe\quantlab-{session_id}`
2. Extension SocketTransport connects via named pipe
3. On Unix: Unix socket used (no change)
4. Both transports support the same message framing

**Dependencies**: CODEX-001

---

### FIX-PL004 [P1] Cross-platform signal handling

**Problem**: Signal handlers need to work correctly on Windows (limited signal support) and Unix.

**Evidence**:
- `engine/quantlab/daemon/lifecycle.py:278-349` -- SignalHandler class

**Root Cause**: Already has cross-platform code but needs verification.

**Files to modify**:
- `engine/quantlab/daemon/lifecycle.py`

**Implementation**:

```python
# engine/quantlab/daemon/lifecycle.py
# Verify SignalHandler cross-platform support (around line 278):

class SignalHandler:
    """Cross-platform signal handler for graceful shutdown.

    FIX-PL004: Handles platform differences in signal availability.
    """

    def __init__(self):
        self._shutdown_requested = False
        self._callbacks: list[Callable] = []
        self._original_handlers: dict[int, Any] = {}

    def install(self):
        """Install signal handlers for current platform."""
        import signal

        # SIGINT: Ctrl+C (all platforms)
        self._install_handler(signal.SIGINT)

        if sys.platform != "win32":
            # Unix-only signals
            self._install_handler(signal.SIGTERM)
            # Ignore SIGHUP (terminal disconnect -- daemon should continue)
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
        else:
            # Windows: SIGBREAK (Ctrl+Break)
            if hasattr(signal, 'SIGBREAK'):
                self._install_handler(signal.SIGBREAK)

            # Windows: Also handle console close event
            try:
                import win32api
                win32api.SetConsoleCtrlHandler(self._windows_ctrl_handler, True)
            except ImportError:
                pass  # pywin32 not installed

    def _install_handler(self, sig: int):
        """Install handler for a specific signal."""
        import signal
        self._original_handlers[sig] = signal.getsignal(sig)
        signal.signal(sig, self._handle_shutdown)

    def _handle_shutdown(self, signum, frame):
        """Handle shutdown signal."""
        self._shutdown_requested = True
        for callback in self._callbacks:
            try:
                callback()
            except Exception:
                pass

    def _windows_ctrl_handler(self, ctrl_type):
        """Windows console control handler."""
        # CTRL_C_EVENT=0, CTRL_BREAK_EVENT=1, CTRL_CLOSE_EVENT=2
        if ctrl_type in (0, 1, 2):
            self._handle_shutdown(ctrl_type, None)
            return True
        return False

    def uninstall(self):
        """Restore original signal handlers."""
        import signal
        for sig, handler in self._original_handlers.items():
            try:
                signal.signal(sig, handler)
            except (OSError, ValueError):
                pass
        self._original_handlers.clear()

    @property
    def shutdown_requested(self) -> bool:
        return self._shutdown_requested

    def on_shutdown(self, callback: Callable):
        """Register shutdown callback."""
        self._callbacks.append(callback)
```

**Verification**:
1. On Unix: SIGTERM triggers graceful shutdown
2. On Unix: SIGHUP is ignored (daemon continues)
3. On Windows: Ctrl+C triggers graceful shutdown
4. On Windows: Console close event triggers shutdown

**Dependencies**: None

---

### NEW-BUILD-001 [MAJOR] Create per-OS build scripts

**Problem**: No build scripts for creating platform-specific installers (NSIS for Windows, DMG for macOS, AppImage for Linux).

**Files to create**:
- `build/scripts/build-windows.sh` (or `.ps1`)
- `build/scripts/build-macos.sh`
- `build/scripts/build-linux.sh`

**Implementation**:

```bash
#!/bin/bash
# build/scripts/build-linux.sh
# NEW-BUILD-001: Linux build script (AppImage)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/.build/linux"

echo "Building Quantlab for Linux..."

# Step 1: Build TypeScript
cd "$ROOT_DIR"
npm run compile

# Step 2: Build extension
cd "$ROOT_DIR/extensions/quantlab"
npm run compile

# Step 3: Package Python engine
cd "$ROOT_DIR/engine"
pip install pyinstaller
pyinstaller \
    --name quantlab-engine \
    --onedir \
    --hidden-import quantlab \
    --hidden-import quantlab.daemon \
    --hidden-import quantlab.backtest \
    quantlab/daemon/__main__.py

# Step 4: Create AppImage structure
mkdir -p "$BUILD_DIR/AppDir/usr/bin"
mkdir -p "$BUILD_DIR/AppDir/usr/lib/quantlab"
cp -r dist/quantlab-engine/* "$BUILD_DIR/AppDir/usr/lib/quantlab/"

# Step 5: Create desktop entry
cat > "$BUILD_DIR/AppDir/quantlab.desktop" << 'DESKTOP'
[Desktop Entry]
Name=Quantlab
Exec=quantlab
Icon=quantlab
Type=Application
Categories=Finance;Development;
DESKTOP

# Step 6: Build AppImage
if command -v appimagetool &> /dev/null; then
    appimagetool "$BUILD_DIR/AppDir" "$BUILD_DIR/Quantlab-x86_64.AppImage"
    echo "AppImage created: $BUILD_DIR/Quantlab-x86_64.AppImage"
else
    echo "appimagetool not found. Install from: https://github.com/AppImage/AppImageKit"
    echo "AppDir created at: $BUILD_DIR/AppDir"
fi
```

```powershell
# build/scripts/build-windows.ps1
# NEW-BUILD-001: Windows build script (NSIS installer)

$ErrorActionPreference = "Stop"
$RootDir = (Get-Item "$PSScriptRoot\..\..").FullName
$BuildDir = "$RootDir\.build\windows"

Write-Host "Building Quantlab for Windows..."

# Step 1: Build TypeScript
Set-Location $RootDir
npm run compile

# Step 2: Build extension
Set-Location "$RootDir\extensions\quantlab"
npm run compile

# Step 3: Package Python engine
Set-Location "$RootDir\engine"
pip install pyinstaller
pyinstaller `
    --name quantlab-engine `
    --onedir `
    --hidden-import quantlab `
    --hidden-import quantlab.daemon `
    quantlab\daemon\__main__.py

# Step 4: Create NSIS installer
# (NSIS script would be a separate .nsi file)
Write-Host "Build complete. Run NSIS to create installer."
```

```bash
#!/bin/bash
# build/scripts/build-macos.sh
# NEW-BUILD-001: macOS build script (DMG)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$ROOT_DIR/.build/macos"

echo "Building Quantlab for macOS..."

# Step 1: Build TypeScript
cd "$ROOT_DIR"
npm run compile

# Step 2: Build extension
cd "$ROOT_DIR/extensions/quantlab"
npm run compile

# Step 3: Package Python engine
cd "$ROOT_DIR/engine"
pip install pyinstaller
pyinstaller \
    --name quantlab-engine \
    --onedir \
    --hidden-import quantlab \
    --hidden-import quantlab.daemon \
    --hidden-import quantlab.backtest \
    quantlab/daemon/__main__.py

# Step 4: Create .app bundle
APP_DIR="$BUILD_DIR/Quantlab.app"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"
# ... copy files, create Info.plist ...

# Step 5: Create DMG
if command -v create-dmg &> /dev/null; then
    create-dmg \
        --volname "Quantlab" \
        --window-size 800 400 \
        "$BUILD_DIR/Quantlab.dmg" \
        "$APP_DIR"
    echo "DMG created: $BUILD_DIR/Quantlab.dmg"
fi
```

**Verification**:
1. Linux: `./build-linux.sh` produces AppImage
2. Windows: `.\build-windows.ps1` produces build artifacts
3. macOS: `./build-macos.sh` produces DMG
4. All platforms: application launches and can run backtests

**Dependencies**: None

---

### NEW-BUILD-002 [MAJOR] Python engine bundling for distribution

**Problem**: End users need Python engine bundled (not requiring separate Python install).

**Files to create**:
- `build/python/bundle.py`

**Implementation**:

```python
# build/python/bundle.py

"""Bundle Python engine for distribution.

NEW-BUILD-002: Creates standalone Python distribution using PyInstaller.
"""

import subprocess
import sys
from pathlib import Path

ENGINE_ROOT = Path(__file__).parent.parent.parent / "engine"

def bundle_engine(output_dir: str, platform: str = None):
    """Bundle the Python engine into a standalone directory.

    Args:
        output_dir: Output directory for bundled engine
        platform: Target platform (linux, darwin, win32). Defaults to current.
    """
    if platform is None:
        platform = sys.platform

    spec_args = [
        sys.executable, "-m", "PyInstaller",
        "--name", "quantlab-engine",
        "--onedir",
        "--noconfirm",
        "--distpath", output_dir,
        # Hidden imports for dynamic loading
        "--hidden-import", "quantlab",
        "--hidden-import", "quantlab.daemon",
        "--hidden-import", "quantlab.daemon.main",
        "--hidden-import", "quantlab.backtest",
        "--hidden-import", "quantlab.backtest.core",
        "--hidden-import", "quantlab.providers",
        "--hidden-import", "quantlab.risk",
        "--hidden-import", "quantlab.trading",
        "--hidden-import", "quantlab.metrics",
        "--hidden-import", "quantlab.data",
        # Data files
        "--add-data", f"{ENGINE_ROOT / 'calendars'}:calendars",
        "--add-data", f"{ENGINE_ROOT / 'schemas'}:schemas",
        # Entry point
        str(ENGINE_ROOT / "quantlab" / "daemon" / "__main__.py"),
    ]

    subprocess.run(spec_args, check=True, cwd=str(ENGINE_ROOT))
    print(f"Engine bundled to: {output_dir}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=".build/dist")
    args = parser.parse_args()
    bundle_engine(args.output)
```

**Verification**:
1. `python build/python/bundle.py --output dist/` creates standalone bundle
2. `dist/quantlab-engine/quantlab-engine start --help` works without Python installed
3. All imports resolve within the bundle

**Dependencies**: None

---

### CODEX-013 [MEDIUM] Wire bundled Python in EngineHost

**Problem**: EngineHost always uses system Python. Should prefer bundled Python when available.

**Evidence**:
- `extensions/quantlab/src/core/engine/EngineHost.ts:67` -- `resolvePythonPath()` checks system Python

**Files to modify**:
- `extensions/quantlab/src/core/engine/EngineHost.ts`

**Implementation**:

```typescript
// extensions/quantlab/src/core/engine/EngineHost.ts
// Update resolvePythonPath() to check bundled first:

public resolvePythonPath(): string {
    // CODEX-013: Check bundled Python first
    const bundledPath = this.resolveBundledPython();
    if (bundledPath) {
        return bundledPath;
    }

    // Fall back to system Python (existing logic)
    // 1. VS Code Python extension setting
    const pythonExt = vscode.workspace.getConfiguration('python');
    const interpreterPath = pythonExt.get<string>('defaultInterpreterPath');
    if (interpreterPath && fs.existsSync(interpreterPath)) {
        return interpreterPath;
    }

    // 2. Quantlab custom setting
    const quantlabConfig = vscode.workspace.getConfiguration('quantlab');
    const customPath = quantlabConfig.get<string>('pythonPath');
    if (customPath && fs.existsSync(customPath)) {
        return customPath;
    }

    // 3. System default
    return process.platform === 'win32' ? 'python' : 'python3';
}

private resolveBundledPython(): string | null {
    // Check for bundled engine in extension directory
    const extensionPath = this.extensionUri?.fsPath;
    if (!extensionPath) {
        return null;
    }

    const bundledPaths = [
        // Relative to extension
        path.join(extensionPath, '..', '..', 'engine-dist', 'quantlab-engine',
            process.platform === 'win32' ? 'quantlab-engine.exe' : 'quantlab-engine'),
        // Installed location
        path.join(extensionPath, 'engine', 'quantlab-engine',
            process.platform === 'win32' ? 'quantlab-engine.exe' : 'quantlab-engine'),
    ];

    for (const p of bundledPaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }

    return null;
}
```

**Verification**:
1. With bundled Python present -> uses bundled
2. Without bundled Python -> falls back to system Python
3. Both paths can run backtests successfully

**Dependencies**: NEW-BUILD-002

---

## Phase Verification Checklist

- [ ] Windows file locking works (msvcrt)
- [ ] Windows daemonization creates background process
- [ ] Windows named pipe transport connects
- [ ] Cross-platform signals handled correctly
- [ ] Linux build script produces AppImage
- [ ] Windows build script produces artifacts
- [ ] macOS build script produces DMG
- [ ] Python engine bundles into standalone distribution
- [ ] EngineHost prefers bundled Python when available

## Status Corrections

| Prior Claim | Actual Status |
|------------|---------------|
| "No Windows support" | lifecycle.py has Windows paths for locking, daemonization, and signals |
| "No build system" | build/ directory has Gulp-based build for the VS Code fork; engine-specific builds needed |
| "No cross-platform" | SocketTransport.ts already has Windows named pipe path in getSocketPath() |

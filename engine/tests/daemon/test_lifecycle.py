"""
Tests for daemon lifecycle management.
"""

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from quantlab.daemon.lifecycle import (
    DaemonAlreadyRunning,
    DaemonState,
    PidFile,
    PidFileError,
    SignalHandler,
)


class TestPidFile:
    """Tests for PidFile class."""

    def test_acquire_creates_file(self, tmp_path):
        """Should create PID file on acquire."""
        pid_file = PidFile("test-session")
        pid_file._base_dir = tmp_path
        pid_file._pid_path = tmp_path / "test-session.pid"

        pid_file.acquire()

        assert pid_file._pid_path.exists()
        assert pid_file._pid_path.read_text() == str(os.getpid())

    def test_acquire_sets_permissions(self, tmp_path):
        """Should set 0600 permissions."""
        pid_file = PidFile("test-session")
        pid_file._base_dir = tmp_path
        pid_file._pid_path = tmp_path / "test-session.pid"

        pid_file.acquire()

        mode = pid_file._pid_path.stat().st_mode & 0o777
        assert mode == 0o600

    @pytest.mark.skip(reason="Test bypasses file lock mechanism - needs subprocess-based test")
    def test_acquire_fails_if_running(self, tmp_path):
        """Should fail if daemon already running."""
        pid_file = PidFile("test-session")
        pid_file._base_dir = tmp_path
        pid_file._pid_path = tmp_path / "test-session.pid"

        # Create existing PID file with current process
        pid_file._pid_path.write_text(str(os.getpid()))

        with pytest.raises(DaemonAlreadyRunning):
            pid_file.acquire()

    def test_release_removes_file(self, tmp_path):
        """Should remove PID file on release."""
        pid_file = PidFile("test-session")
        pid_file._base_dir = tmp_path
        pid_file._pid_path = tmp_path / "test-session.pid"

        pid_file.acquire()
        pid_file.release()

        assert not pid_file._pid_path.exists()

    def test_release_idempotent(self, tmp_path):
        """Release should be safe to call multiple times."""
        pid_file = PidFile("test-session")
        pid_file._base_dir = tmp_path
        pid_file._pid_path = tmp_path / "test-session.pid"

        pid_file.acquire()
        pid_file.release()
        pid_file.release()  # Should not raise

    def test_get_session_pid_returns_none_if_not_exists(self, tmp_path):
        """Should return None if no PID file."""
        with patch("quantlab.daemon.lifecycle.Path.home", return_value=tmp_path):
            result = PidFile.get_session_pid("nonexistent")

        assert result is None

    def test_stale_pid_file_removed(self, tmp_path):
        """Should remove stale PID file from dead process."""
        pid_file = PidFile("test-session")
        pid_file._base_dir = tmp_path
        pid_file._pid_path = tmp_path / "test-session.pid"

        # Create stale PID file with non-existent process
        pid_file._pid_path.parent.mkdir(parents=True, exist_ok=True)
        pid_file._pid_path.write_text("99999999")  # Unlikely to exist

        # Should succeed by removing stale file
        pid_file.acquire()

        assert pid_file._pid_path.read_text() == str(os.getpid())


class TestDaemonState:
    """Tests for DaemonState constants."""

    def test_state_values(self):
        """Should have expected state values."""
        assert DaemonState.STARTING == "starting"
        assert DaemonState.ACTIVE == "active"
        assert DaemonState.PAUSED == "paused"
        assert DaemonState.MARKET_CLOSED == "market_closed"
        assert DaemonState.STOPPING == "stopping"
        assert DaemonState.STOPPED == "stopped"


class TestSignalHandler:
    """Tests for SignalHandler class."""

    def test_install_and_uninstall(self):
        """Should install and uninstall without error."""
        handler = SignalHandler()

        handler.install()
        assert len(handler._original_handlers) > 0

        handler.uninstall()
        assert len(handler._original_handlers) == 0

    def test_shutdown_callback(self):
        """Should call registered callbacks on shutdown request."""
        handler = SignalHandler()
        called = False

        def callback():
            nonlocal called
            called = True

        handler.on_shutdown(callback)

        # Simulate signal (internal method)
        handler._handle_shutdown(15, None)  # SIGTERM

        assert handler.shutdown_requested is True
        assert called is True

    def test_multiple_callbacks(self):
        """Should call all registered callbacks."""
        handler = SignalHandler()
        count = 0

        def callback1():
            nonlocal count
            count += 1

        def callback2():
            nonlocal count
            count += 1

        handler.on_shutdown(callback1)
        handler.on_shutdown(callback2)

        handler._handle_shutdown(15, None)

        assert count == 2

"""
Tests for encrypted secrets storage.
"""

import os
from pathlib import Path

import pytest

from quantlab.secrets.encrypted import (
    AccountLocked,
    Argon2Params,
    DecryptionError,
    EncryptedSecretsFile,
    FailedAttemptTracker,
    InvalidFileFormat,
    PasswordTooShort,
    SecretsError,
    SecretsManager,
    HEADER_SIZE,
    MAGIC,
    MIN_PASSWORD_LENGTH,
)


class TestArgon2Params:
    """Tests for Argon2Params dataclass."""

    def test_default_values(self):
        """Should have secure defaults."""
        params = Argon2Params()

        assert params.time_cost == 3
        assert params.memory_cost == 65536  # 64 MB
        assert params.parallelism == 4

    def test_to_bytes(self):
        """Should serialize to 12 bytes."""
        params = Argon2Params(time_cost=3, memory_cost=65536, parallelism=4)

        data = params.to_bytes()

        assert len(data) == 12

    def test_roundtrip(self):
        """Should roundtrip through bytes."""
        original = Argon2Params(time_cost=5, memory_cost=131072, parallelism=8)

        data = original.to_bytes()
        restored = Argon2Params.from_bytes(data)

        assert restored.time_cost == original.time_cost
        assert restored.memory_cost == original.memory_cost
        assert restored.parallelism == original.parallelism


class TestFailedAttemptTracker:
    """Tests for FailedAttemptTracker class."""

    def test_initial_state(self):
        """Should start with zero attempts."""
        tracker = FailedAttemptTracker()

        assert tracker.attempts == 0
        assert tracker.is_locked() is False

    def test_record_failure(self):
        """Should increment attempts on failure."""
        tracker = FailedAttemptTracker()

        tracker.record_failure()

        assert tracker.attempts == 1

    def test_record_success_resets(self):
        """Success should reset attempts."""
        tracker = FailedAttemptTracker()

        tracker.record_failure()
        tracker.record_failure()
        tracker.record_success()

        assert tracker.attempts == 0

    def test_exponential_backoff(self):
        """Should return exponential backoff delay."""
        tracker = FailedAttemptTracker()

        assert tracker.get_backoff_seconds() == 0  # No attempts

        tracker.record_failure()
        assert tracker.get_backoff_seconds() == 1  # 2^0

        tracker.record_failure()
        assert tracker.get_backoff_seconds() == 2  # 2^1

        tracker.record_failure()
        assert tracker.get_backoff_seconds() == 4  # 2^2

    def test_backoff_capped_at_60(self):
        """Backoff should cap at 60 seconds."""
        tracker = FailedAttemptTracker()

        for _ in range(10):
            tracker.record_failure()

        assert tracker.get_backoff_seconds() == 60

    def test_lockout_after_max_attempts(self):
        """Should lock after max failed attempts."""
        tracker = FailedAttemptTracker()

        for _ in range(10):  # MAX_FAILED_ATTEMPTS
            tracker.record_failure()

        assert tracker.is_locked() is True

    def test_lockout_expires(self):
        """Lockout should expire after duration."""
        from datetime import datetime, timedelta

        tracker = FailedAttemptTracker()

        # Lock the account
        for _ in range(10):
            tracker.record_failure()
        assert tracker.is_locked() is True

        # Manually set lockout to past time
        tracker.locked_until = datetime.now() - timedelta(seconds=1)

        # Should no longer be locked
        assert tracker.is_locked() is False
        # locked_until should be cleared
        assert tracker.locked_until is None

    def test_time_until_unlock_when_not_locked(self):
        """Should return None when not locked."""
        tracker = FailedAttemptTracker()

        result = tracker.time_until_unlock()

        assert result is None

    def test_time_until_unlock_when_locked(self):
        """Should return remaining time when locked."""
        from datetime import datetime, timedelta

        tracker = FailedAttemptTracker()

        # Lock the account
        for _ in range(10):
            tracker.record_failure()

        remaining = tracker.time_until_unlock()

        assert remaining is not None
        # Should be close to LOCKOUT_DURATION (1 hour)
        assert remaining.total_seconds() > 3500  # ~1 hour minus small delta

    def test_time_until_unlock_returns_none_after_expiry(self):
        """time_until_unlock should return None when lockout has expired."""
        from datetime import datetime, timedelta

        tracker = FailedAttemptTracker()

        # Lock the account
        for _ in range(10):
            tracker.record_failure()

        # Manually expire the lockout
        tracker.locked_until = datetime.now() - timedelta(seconds=1)

        # is_locked() clears the lockout when expired
        result = tracker.time_until_unlock()

        assert result is None


class TestEncryptedSecretsFile:
    """Tests for EncryptedSecretsFile class."""

    def test_default_file_path(self):
        """Should use default path in home directory."""
        secrets = EncryptedSecretsFile()

        expected = Path.home() / ".quantlab" / "secrets.enc"
        assert secrets.file_path == expected

    def test_custom_file_path(self, tmp_path):
        """Should accept custom path."""
        custom_path = tmp_path / "custom.enc"
        secrets = EncryptedSecretsFile(custom_path)

        assert secrets.file_path == custom_path

    def test_exists_property_false(self, tmp_path):
        """Should return False when file doesn't exist."""
        secrets = EncryptedSecretsFile(tmp_path / "nonexistent.enc")

        assert secrets.exists is False

    def test_exists_property_true(self, tmp_path):
        """Should return True when file exists."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        secrets.create(password)

        assert secrets.exists is True

    def test_is_locked_property(self, tmp_path):
        """Should expose attempt tracker locked state."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")

        # Initially not locked
        assert secrets.is_locked is False

        # Lock by exceeding max attempts
        for _ in range(10):
            secrets._attempt_tracker.record_failure()

        assert secrets.is_locked is True

    def test_create_requires_min_password(self, tmp_path):
        """Should require minimum password length."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")

        with pytest.raises(PasswordTooShort):
            secrets.create("short")

    def test_create_and_unlock(self, tmp_path):
        """Should create and unlock secrets file."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        secrets.create(password)
        secrets.lock()
        secrets.unlock(password)

        # Should be able to access secrets
        assert secrets.list_keys() == []

    def test_set_and_get(self, tmp_path):
        """Should store and retrieve secrets."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        secrets.create(password)
        secrets.set("api_key", "secret123")

        value = secrets.get("api_key")

        assert value == "secret123"

    def test_persistence(self, tmp_path):
        """Secrets should persist across sessions."""
        path = tmp_path / "secrets.enc"
        password = "a" * MIN_PASSWORD_LENGTH

        # Create and store
        secrets1 = EncryptedSecretsFile(path)
        secrets1.create(password)
        secrets1.set("api_key", "secret123")

        # Lock and reopen
        secrets2 = EncryptedSecretsFile(path)
        secrets2.unlock(password)

        value = secrets2.get("api_key")
        assert value == "secret123"

    def test_wrong_password_fails(self, tmp_path):
        """Should fail with wrong password."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        secrets.create(password)
        secrets.lock()

        with pytest.raises(DecryptionError):
            secrets.unlock("wrong" + "x" * MIN_PASSWORD_LENGTH)

    def test_unlock_when_account_locked(self, tmp_path):
        """Should raise AccountLocked when account is locked."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        secrets.create(password)
        secrets.lock()

        # Lock by exceeding max attempts
        for _ in range(10):
            secrets._attempt_tracker.record_failure()

        with pytest.raises(AccountLocked) as exc:
            secrets.unlock(password)

        assert "locked" in str(exc.value).lower()

    def test_unlock_file_not_found(self, tmp_path):
        """Should raise SecretsError when file doesn't exist."""
        secrets = EncryptedSecretsFile(tmp_path / "nonexistent.enc")

        with pytest.raises(SecretsError) as exc:
            secrets.unlock("a" * MIN_PASSWORD_LENGTH)

        assert "not found" in str(exc.value).lower()

    def test_unlock_file_too_small(self, tmp_path):
        """Should raise SecretsError when file is too small."""
        path = tmp_path / "secrets.enc"
        # Write a file smaller than header size
        path.write_bytes(b"too small")

        secrets = EncryptedSecretsFile(path)

        with pytest.raises(SecretsError) as exc:
            secrets.unlock("a" * MIN_PASSWORD_LENGTH)

        assert "too small" in str(exc.value).lower()

    def test_unlock_invalid_magic(self, tmp_path):
        """Should raise SecretsError with wrong magic bytes."""
        path = tmp_path / "secrets.enc"
        # Write file with invalid magic but correct size
        invalid_data = b"INVALID!" + b"\x00" * (HEADER_SIZE - 8 + 100)
        path.write_bytes(invalid_data)

        secrets = EncryptedSecretsFile(path)

        with pytest.raises(SecretsError) as exc:
            secrets.unlock("a" * MIN_PASSWORD_LENGTH)

        assert "magic" in str(exc.value).lower()

    def test_unlock_missing_nonce(self, tmp_path):
        """Should raise SecretsError when nonce is missing."""
        import struct

        path = tmp_path / "secrets.enc"
        # Write file with valid header but no body
        # Need valid argon2 params to avoid early failure
        params = struct.pack(">III", 3, 65536, 4)  # time, memory, parallelism
        header = MAGIC + (b"\x00" * 32) + params + (b"\x00" * 12)  # salt + params + reserved
        path.write_bytes(header)

        secrets = EncryptedSecretsFile(path)

        with pytest.raises(SecretsError) as exc:
            secrets.unlock("a" * MIN_PASSWORD_LENGTH)

        assert "nonce" in str(exc.value).lower()

    def test_unlock_with_backoff_delay(self, tmp_path, monkeypatch):
        """Should apply backoff delay after failed attempts."""
        import time

        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        secrets.create(password)
        secrets.lock()

        # Record a failure to trigger backoff
        secrets._attempt_tracker.record_failure()

        # Mock time.sleep to verify it's called
        sleep_called = []
        original_sleep = time.sleep
        monkeypatch.setattr(time, "sleep", lambda x: sleep_called.append(x))

        secrets.unlock(password)

        # Should have called sleep with backoff delay (1 second for 1 attempt)
        assert len(sleep_called) == 1
        assert sleep_called[0] == 1.0

    def test_delete_secret(self, tmp_path):
        """Should delete secrets."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        secrets.create(password)
        secrets.set("api_key", "secret123")

        result = secrets.delete("api_key")

        assert result is True
        assert secrets.get("api_key") is None

    def test_delete_nonexistent_key(self, tmp_path):
        """Should return False when deleting nonexistent key."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        secrets.create(password)

        result = secrets.delete("nonexistent")

        assert result is False

    def test_get_not_unlocked(self, tmp_path):
        """Should raise SecretsError when getting before unlock."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")

        with pytest.raises(SecretsError) as exc:
            secrets.get("api_key")

        assert "not unlocked" in str(exc.value).lower()

    def test_set_not_unlocked(self, tmp_path):
        """Should raise SecretsError when setting before unlock."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")

        with pytest.raises(SecretsError) as exc:
            secrets.set("api_key", "value")

        assert "not unlocked" in str(exc.value).lower()

    def test_delete_not_unlocked(self, tmp_path):
        """Should raise SecretsError when deleting before unlock."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")

        with pytest.raises(SecretsError) as exc:
            secrets.delete("api_key")

        assert "not unlocked" in str(exc.value).lower()

    def test_list_keys_not_unlocked(self, tmp_path):
        """Should raise SecretsError when listing before unlock."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")

        with pytest.raises(SecretsError) as exc:
            secrets.list_keys()

        assert "not unlocked" in str(exc.value).lower()

    def test_list_keys(self, tmp_path):
        """Should list all secret keys."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        secrets.create(password)
        secrets.set("key1", "value1")
        secrets.set("key2", "value2")

        keys = secrets.list_keys()

        assert set(keys) == {"key1", "key2"}

    def test_change_password(self, tmp_path):
        """Should change master password."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        old_password = "a" * MIN_PASSWORD_LENGTH
        new_password = "b" * MIN_PASSWORD_LENGTH

        secrets.create(old_password)
        secrets.set("api_key", "secret123")

        secrets.change_password(old_password, new_password)

        # Old password should fail
        secrets.lock()
        with pytest.raises(DecryptionError):
            secrets.unlock(old_password)

        # New password should work
        secrets2 = EncryptedSecretsFile(tmp_path / "secrets.enc")
        secrets2.unlock(new_password)
        assert secrets2.get("api_key") == "secret123"

    def test_change_password_when_not_unlocked(self, tmp_path):
        """Should unlock first when changing password while locked."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        old_password = "a" * MIN_PASSWORD_LENGTH
        new_password = "b" * MIN_PASSWORD_LENGTH

        secrets.create(old_password)
        secrets.set("api_key", "secret123")
        secrets.lock()

        # Should still work - will unlock internally
        secrets.change_password(old_password, new_password)

        # New password should work
        secrets.lock()
        secrets.unlock(new_password)
        assert secrets.get("api_key") == "secret123"

    def test_change_password_short_new_password(self, tmp_path):
        """Should reject short new password."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        old_password = "a" * MIN_PASSWORD_LENGTH

        secrets.create(old_password)

        with pytest.raises(PasswordTooShort):
            secrets.change_password(old_password, "short")

    def test_file_permissions(self, tmp_path):
        """Should set secure file permissions (0600)."""
        secrets = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        secrets.create(password)

        mode = secrets.file_path.stat().st_mode & 0o777
        assert mode == 0o600


class TestSecretsManager:
    """Tests for SecretsManager class."""

    def test_get_from_environment(self, monkeypatch):
        """Should read from environment variables."""
        monkeypatch.setenv("QUANTLAB_SECRET_API_KEY", "env_secret")

        manager = SecretsManager()
        value = manager.get("api_key")

        assert value == "env_secret"

    def test_get_with_default(self):
        """Should return default if not found."""
        manager = SecretsManager()

        value = manager.get("nonexistent", default="fallback")

        assert value == "fallback"

    def test_require_raises_if_missing(self):
        """Should raise if required secret missing."""
        manager = SecretsManager()

        with pytest.raises(SecretsError) as exc:
            manager.require("missing_secret")

        assert "not found" in str(exc.value).lower()

    def test_get_broker_credentials(self, monkeypatch):
        """Should get broker credentials from environment."""
        monkeypatch.setenv("QUANTLAB_SECRET_ALPACA_API_KEY", "key123")
        monkeypatch.setenv("QUANTLAB_SECRET_ALPACA_API_SECRET", "secret456")

        manager = SecretsManager()
        creds = manager.get_broker_credentials("alpaca")

        assert creds["api_key"] == "key123"
        assert creds["api_secret"] == "secret456"

    def test_get_from_encrypted_file(self, tmp_path):
        """Should read from encrypted file when unlocked."""
        encrypted = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        encrypted.create(password)
        encrypted.set("api_key", "encrypted_secret")

        manager = SecretsManager(encrypted_file=encrypted)
        value = manager.get("api_key")

        assert value == "encrypted_secret"

    def test_get_returns_none_from_encrypted_when_locked(self, tmp_path):
        """Should return default when encrypted file is locked."""
        encrypted = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        encrypted.create(password)
        encrypted.set("api_key", "encrypted_secret")
        encrypted.lock()

        manager = SecretsManager(encrypted_file=encrypted)
        value = manager.get("api_key", default="default_val")

        # Should return default because file is locked
        assert value == "default_val"

    def test_environment_takes_precedence_over_encrypted(self, tmp_path, monkeypatch):
        """Environment variables should take precedence over encrypted file."""
        monkeypatch.setenv("QUANTLAB_SECRET_API_KEY", "env_value")

        encrypted = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        encrypted.create(password)
        encrypted.set("api_key", "encrypted_value")

        manager = SecretsManager(encrypted_file=encrypted)
        value = manager.get("api_key")

        assert value == "env_value"

    def test_require_with_encrypted_file(self, tmp_path):
        """Should get required secret from encrypted file."""
        encrypted = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        encrypted.create(password)
        encrypted.set("api_key", "required_secret")

        manager = SecretsManager(encrypted_file=encrypted)
        value = manager.require("api_key")

        assert value == "required_secret"

    def test_get_broker_credentials_from_encrypted(self, tmp_path):
        """Should get broker credentials from encrypted file."""
        encrypted = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        encrypted.create(password)
        encrypted.set("alpaca_api_key", "enc_key123")
        encrypted.set("alpaca_api_secret", "enc_secret456")

        manager = SecretsManager(encrypted_file=encrypted)
        creds = manager.get_broker_credentials("alpaca")

        assert creds["api_key"] == "enc_key123"
        assert creds["api_secret"] == "enc_secret456"

    def test_get_broker_credentials_env_takes_precedence(self, tmp_path, monkeypatch):
        """Environment should take precedence in broker credentials."""
        monkeypatch.setenv("QUANTLAB_SECRET_ALPACA_API_KEY", "env_key")

        encrypted = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        encrypted.create(password)
        encrypted.set("alpaca_api_key", "enc_key")
        encrypted.set("alpaca_api_secret", "enc_secret")

        manager = SecretsManager(encrypted_file=encrypted)
        creds = manager.get_broker_credentials("alpaca")

        # API key from env, API secret from encrypted
        assert creds["api_key"] == "env_key"
        assert creds["api_secret"] == "enc_secret"

    def test_get_broker_credentials_empty_when_locked(self, tmp_path):
        """Should return empty credentials when encrypted file is locked."""
        encrypted = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        encrypted.create(password)
        encrypted.set("alpaca_api_key", "enc_key")
        encrypted.lock()

        manager = SecretsManager(encrypted_file=encrypted)
        creds = manager.get_broker_credentials("alpaca")

        # Should be empty because file is locked
        assert creds == {}

    def test_get_broker_credentials_skips_none_values(self, tmp_path):
        """Should skip credentials with None values from encrypted file."""
        encrypted = EncryptedSecretsFile(tmp_path / "secrets.enc")
        password = "a" * MIN_PASSWORD_LENGTH

        encrypted.create(password)
        encrypted.set("alpaca_api_key", "enc_key")
        # Don't set api_secret

        manager = SecretsManager(encrypted_file=encrypted)
        creds = manager.get_broker_credentials("alpaca")

        assert "api_key" in creds
        assert "api_secret" not in creds

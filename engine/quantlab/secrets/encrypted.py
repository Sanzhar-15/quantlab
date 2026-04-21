"""
Encrypted Secrets Storage.

Provides AES-256-GCM encrypted file storage with Argon2id key derivation.

This is the fallback when OS Keychain is unavailable (e.g., headless Linux).

File Format:
    Header (64 bytes):
        - Magic: "QLSEC\x00\x01\x00" (8 bytes)
        - Argon2 salt (32 bytes)
        - Argon2 params: time=3, mem=64MB, parallelism=4 (12 bytes)
        - Reserved (12 bytes)

    Body:
        - AES-256-GCM nonce (12 bytes)
        - Ciphertext (variable)
        - GCM tag (16 bytes)

Spec Reference: Technical Spec §13.3, Decision F33
"""

import json
import logging
import os
import struct
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime
from datetime import timedelta
from pathlib import Path
from typing import Any

from argon2.low_level import Type
from argon2.low_level import hash_secret_raw
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


logger = logging.getLogger(__name__)


# File format constants
MAGIC = b"QLSEC\x00\x01\x00"
MAGIC_SIZE = 8
SALT_SIZE = 32
PARAMS_SIZE = 12
RESERVED_SIZE = 12
HEADER_SIZE = MAGIC_SIZE + SALT_SIZE + PARAMS_SIZE + RESERVED_SIZE

# AES-GCM constants
NONCE_SIZE = 12
TAG_SIZE = 16
KEY_SIZE = 32  # AES-256

# Argon2id default parameters
DEFAULT_TIME_COST = 3  # iterations
DEFAULT_MEMORY_COST = 65536  # 64 MB in KB
DEFAULT_PARALLELISM = 4

# Security constants
MIN_PASSWORD_LENGTH = 16
MAX_FAILED_ATTEMPTS = 10
LOCKOUT_DURATION = timedelta(hours=1)


class SecretsError(Exception):
    """Base exception for secrets errors."""

    pass


class DecryptionError(SecretsError):
    """Failed to decrypt secrets."""

    pass


class PasswordTooShort(SecretsError):
    """Password does not meet minimum length requirement."""

    pass


class AccountLocked(SecretsError):
    """Account is locked due to too many failed attempts."""

    pass


class InvalidFileFormat(SecretsError):
    """Secrets file has invalid format."""

    pass


@dataclass
class Argon2Params:
    """Argon2id key derivation parameters."""

    time_cost: int = DEFAULT_TIME_COST
    memory_cost: int = DEFAULT_MEMORY_COST
    parallelism: int = DEFAULT_PARALLELISM

    def to_bytes(self) -> bytes:
        """Serialize parameters to bytes."""
        return struct.pack(">III", self.time_cost, self.memory_cost, self.parallelism)

    @classmethod
    def from_bytes(cls, data: bytes) -> "Argon2Params":
        """Deserialize parameters from bytes."""
        time_cost, memory_cost, parallelism = struct.unpack(">III", data)
        return cls(time_cost=time_cost, memory_cost=memory_cost, parallelism=parallelism)


@dataclass
class FailedAttemptTracker:
    """Tracks failed unlock attempts for exponential backoff."""

    attempts: int = 0
    last_attempt: datetime | None = None
    locked_until: datetime | None = None

    def record_failure(self) -> None:
        """Record a failed attempt."""
        self.attempts += 1
        self.last_attempt = datetime.now()

        if self.attempts >= MAX_FAILED_ATTEMPTS:
            self.locked_until = datetime.now() + LOCKOUT_DURATION
            logger.warning(
                f"Account locked after {self.attempts} failed attempts. "
                f"Locked until {self.locked_until}"
            )

    def record_success(self) -> None:
        """Record successful unlock (reset counter)."""
        self.attempts = 0
        self.last_attempt = None
        self.locked_until = None

    def is_locked(self) -> bool:
        """Check if account is currently locked."""
        if self.locked_until is None:
            return False

        if datetime.now() >= self.locked_until:
            # Lockout expired
            self.locked_until = None
            return False

        return True

    def get_backoff_seconds(self) -> float:
        """Get exponential backoff delay for next attempt."""
        if self.attempts == 0:
            return 0

        # Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s max
        delay = min(2 ** (self.attempts - 1), 60)
        return float(delay)

    def time_until_unlock(self) -> timedelta | None:
        """Get time remaining until unlock."""
        if not self.is_locked():
            return None
        return self.locked_until - datetime.now()  # type: ignore


class EncryptedSecretsFile:
    """
    Encrypted secrets file handler.

    Provides:
    - AES-256-GCM encryption
    - Argon2id key derivation
    - Atomic file writes
    - Failed attempt tracking with lockout
    """

    def __init__(self, file_path: str | Path | None = None) -> None:
        """
        Initialize encrypted secrets file handler.

        Args:
            file_path: Path to secrets file. Defaults to ~/.quantlab/secrets.enc
        """
        if file_path:
            self._file_path = Path(file_path)
        else:
            self._file_path = Path.home() / ".quantlab" / "secrets.enc"

        self._params = Argon2Params()
        self._salt: bytes | None = None
        self._derived_key: bytes | None = None
        self._secrets: dict[str, str] = {}
        self._attempt_tracker = FailedAttemptTracker()

    @property
    def file_path(self) -> Path:
        """Path to secrets file."""
        return self._file_path

    @property
    def exists(self) -> bool:
        """Check if secrets file exists."""
        return self._file_path.exists()

    @property
    def is_locked(self) -> bool:
        """Check if account is locked."""
        return self._attempt_tracker.is_locked()

    def create(self, password: str) -> None:
        """
        Create a new encrypted secrets file.

        Args:
            password: Master password (minimum 16 characters)

        Raises:
            PasswordTooShort: If password is too short
            SecretsError: On file errors
        """
        self._validate_password(password)

        # Generate new salt
        self._salt = os.urandom(SALT_SIZE)

        # Derive key
        self._derived_key = self._derive_key(password, self._salt)

        # Initialize empty secrets
        self._secrets = {}

        # Save to file
        self._save()

        logger.info(f"Created encrypted secrets file: {self._file_path}")

    def unlock(self, password: str) -> None:
        """
        Unlock the secrets file.

        Args:
            password: Master password

        Raises:
            AccountLocked: If account is locked
            DecryptionError: If password is wrong
            InvalidFileFormat: If file is corrupted
        """
        if self._attempt_tracker.is_locked():
            remaining = self._attempt_tracker.time_until_unlock()
            raise AccountLocked(
                f"Account locked. Try again in {remaining.total_seconds():.0f} seconds"
            )

        # Apply backoff delay
        backoff = self._attempt_tracker.get_backoff_seconds()
        if backoff > 0:
            logger.debug(f"Applying {backoff}s backoff delay")
            time.sleep(backoff)

        if not self.exists:
            raise SecretsError(f"Secrets file not found: {self._file_path}")

        try:
            # Read and parse file
            data = self._file_path.read_bytes()

            if len(data) < HEADER_SIZE:
                raise InvalidFileFormat("File too small")

            # Parse header
            magic = data[:MAGIC_SIZE]
            if magic != MAGIC:
                raise InvalidFileFormat(f"Invalid magic bytes: {magic!r}")

            self._salt = data[MAGIC_SIZE : MAGIC_SIZE + SALT_SIZE]
            params_data = data[MAGIC_SIZE + SALT_SIZE : MAGIC_SIZE + SALT_SIZE + PARAMS_SIZE]
            self._params = Argon2Params.from_bytes(params_data)

            # Derive key
            self._derived_key = self._derive_key(password, self._salt)

            # Decrypt body
            body = data[HEADER_SIZE:]
            if len(body) < NONCE_SIZE:
                raise InvalidFileFormat("Missing nonce")

            nonce = body[:NONCE_SIZE]
            ciphertext = body[NONCE_SIZE:]

            # FIX-M9: Use vault file path as AAD to bind ciphertext to this vault,
            # preventing ciphertext-swap attacks between vault files.
            aad = str(self._file_path.resolve()).encode("utf-8")
            from cryptography.exceptions import InvalidTag

            try:
                aesgcm = AESGCM(self._derived_key)
                try:
                    # Try with AAD first (new format)
                    plaintext = aesgcm.decrypt(nonce, ciphertext, aad)
                except InvalidTag:
                    # Fall back to no AAD for legacy vaults
                    plaintext = aesgcm.decrypt(nonce, ciphertext, None)
            except InvalidTag as e:
                self._attempt_tracker.record_failure()
                raise DecryptionError("Invalid password") from e

            # Parse secrets
            self._secrets = json.loads(plaintext.decode("utf-8"))
            self._attempt_tracker.record_success()

            logger.info(f"Unlocked secrets file: {self._file_path}")

        except (DecryptionError, AccountLocked):
            raise
        except Exception as e:
            raise SecretsError(f"Failed to read secrets file: {e}") from e

    def lock(self) -> None:
        """Lock the secrets (clear from memory)."""
        self._derived_key = None
        self._secrets = {}
        logger.info("Secrets locked")

    def get(self, key: str) -> str | None:
        """
        Get a secret value.

        Args:
            key: Secret key

        Returns:
            Secret value or None if not found

        Raises:
            SecretsError: If not unlocked
        """
        if self._derived_key is None:
            raise SecretsError("Secrets file not unlocked")

        return self._secrets.get(key)

    def set(self, key: str, value: str) -> None:
        """
        Set a secret value.

        Args:
            key: Secret key
            value: Secret value

        Raises:
            SecretsError: If not unlocked
        """
        if self._derived_key is None:
            raise SecretsError("Secrets file not unlocked")

        self._secrets[key] = value
        self._save()

        logger.debug(f"Secret set: {key}")

    def delete(self, key: str) -> bool:
        """
        Delete a secret.

        Args:
            key: Secret key

        Returns:
            True if deleted, False if not found

        Raises:
            SecretsError: If not unlocked
        """
        if self._derived_key is None:
            raise SecretsError("Secrets file not unlocked")

        if key in self._secrets:
            del self._secrets[key]
            self._save()
            logger.debug(f"Secret deleted: {key}")
            return True

        return False

    def list_keys(self) -> list[str]:
        """
        List all secret keys.

        Returns:
            List of keys

        Raises:
            SecretsError: If not unlocked
        """
        if self._derived_key is None:
            raise SecretsError("Secrets file not unlocked")

        return list(self._secrets.keys())

    def change_password(self, old_password: str, new_password: str) -> None:
        """
        Change the master password.

        Args:
            old_password: Current password
            new_password: New password

        Raises:
            DecryptionError: If old password is wrong
            PasswordTooShort: If new password is too short
        """
        # Verify old password by attempting unlock
        if self._derived_key is None:
            self.unlock(old_password)

        self._validate_password(new_password)

        # Generate new salt
        self._salt = os.urandom(SALT_SIZE)

        # Derive new key
        self._derived_key = self._derive_key(new_password, self._salt)

        # Save with new encryption
        self._save()

        logger.info("Master password changed successfully")

    def _validate_password(self, password: str) -> None:
        """Validate password meets requirements."""
        if len(password) < MIN_PASSWORD_LENGTH:
            raise PasswordTooShort(
                f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
            )

    def _derive_key(self, password: str, salt: bytes) -> bytes:
        """Derive encryption key from password using Argon2id."""
        return hash_secret_raw(
            secret=password.encode("utf-8"),
            salt=salt,
            time_cost=self._params.time_cost,
            memory_cost=self._params.memory_cost,
            parallelism=self._params.parallelism,
            hash_len=KEY_SIZE,
            type=Type.ID,
        )

    def _save(self) -> None:
        """Save secrets to file atomically."""
        if self._derived_key is None or self._salt is None:
            raise SecretsError("Cannot save: not initialized")

        # Ensure parent directory exists
        self._file_path.parent.mkdir(parents=True, exist_ok=True)

        # Build header
        header = (
            MAGIC
            + self._salt
            + self._params.to_bytes()
            + b"\x00" * RESERVED_SIZE
        )

        # Encrypt secrets
        # FIX-M9: Use vault file path as AAD to bind ciphertext to this vault
        aad = str(self._file_path.resolve()).encode("utf-8")
        plaintext = json.dumps(self._secrets).encode("utf-8")
        nonce = os.urandom(NONCE_SIZE)
        aesgcm = AESGCM(self._derived_key)
        ciphertext = aesgcm.encrypt(nonce, plaintext, aad)

        # Build file content
        file_content = header + nonce + ciphertext

        # Atomic write using temp file + rename
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=self._file_path.parent,
            prefix=".secrets_",
            suffix=".tmp",
            delete=False,
        ) as tmp:
            tmp.write(file_content)
            tmp_path = tmp.name

        # Set secure permissions before rename
        os.chmod(tmp_path, 0o600)

        # Atomic rename
        os.replace(tmp_path, self._file_path)

        logger.debug(f"Saved secrets file: {self._file_path}")


class SecretsManager:
    """
    High-level secrets manager for daemon use.

    Attempts to use environment variables first, then falls back to
    encrypted file storage.
    """

    ENV_PREFIX = "QUANTLAB_SECRET_"

    def __init__(self, encrypted_file: EncryptedSecretsFile | None = None) -> None:
        self._encrypted = encrypted_file
        self._cache: dict[str, str] = {}

    def get(self, key: str, default: str | None = None) -> str | None:
        """
        Get a secret value.

        Lookup order:
        1. Environment variable (QUANTLAB_SECRET_{KEY})
        2. Encrypted file (if unlocked)
        3. Default value

        Args:
            key: Secret key
            default: Default value if not found

        Returns:
            Secret value or default
        """
        # Check environment first
        env_key = f"{self.ENV_PREFIX}{key.upper()}"
        if env_key in os.environ:
            return os.environ[env_key]

        # Check encrypted file
        if self._encrypted and self._encrypted._derived_key:
            value = self._encrypted.get(key)
            if value is not None:
                return value

        return default

    def require(self, key: str) -> str:
        """
        Get a required secret value.

        Args:
            key: Secret key

        Returns:
            Secret value

        Raises:
            SecretsError: If secret not found
        """
        value = self.get(key)
        if value is None:
            raise SecretsError(f"Required secret not found: {key}")
        return value

    def get_broker_credentials(
        self, broker: str
    ) -> dict[str, str]:
        """
        Get broker credentials.

        Args:
            broker: Broker identifier

        Returns:
            Dictionary with credential keys/values
        """
        prefix = f"{broker}_"
        credentials: dict[str, str] = {}

        # Check environment
        for key, value in os.environ.items():
            if key.startswith(f"{self.ENV_PREFIX}{prefix.upper()}"):
                cred_key = key[len(self.ENV_PREFIX) + len(prefix) :].lower()
                credentials[cred_key] = value

        # Check encrypted file
        if self._encrypted and self._encrypted._derived_key:
            for key in self._encrypted.list_keys():
                if key.startswith(prefix):
                    cred_key = key[len(prefix) :]
                    if cred_key not in credentials:  # Env takes precedence
                        value = self._encrypted.get(key)
                        if value:
                            credentials[cred_key] = value

        return credentials

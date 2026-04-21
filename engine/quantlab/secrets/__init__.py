"""
Secrets management module (Python side).

Provides:
- Encrypted file format handling (AES-256-GCM)
- Argon2id key derivation
- Secret value validation
- Failed attempt tracking with exponential backoff
- Account lockout after repeated failures

Primary secrets storage is in TypeScript extension.
This module handles daemon-side secret access.

File Format:
    Header (64 bytes):
        - Magic: "QLSEC\\x00\\x01\\x00" (8 bytes)
        - Argon2 salt (32 bytes)
        - Argon2 params (12 bytes)
        - Reserved (12 bytes)
    Body:
        - AES-256-GCM nonce (12 bytes)
        - Ciphertext (variable)
        - GCM tag (16 bytes)

Spec Reference: Technical Spec §13.3, Decision F33
"""

from .encrypted import AccountLocked
from .encrypted import Argon2Params
from .encrypted import DecryptionError
from .encrypted import EncryptedSecretsFile
from .encrypted import FailedAttemptTracker
from .encrypted import InvalidFileFormat
from .encrypted import PasswordTooShort
from .encrypted import SecretsError
from .encrypted import SecretsManager

# Constants re-exported for reference
from .encrypted import DEFAULT_MEMORY_COST
from .encrypted import DEFAULT_PARALLELISM
from .encrypted import DEFAULT_TIME_COST
from .encrypted import LOCKOUT_DURATION
from .encrypted import MAX_FAILED_ATTEMPTS
from .encrypted import MIN_PASSWORD_LENGTH

__all__ = [
    # Main classes
    "EncryptedSecretsFile",
    "SecretsManager",
    "Argon2Params",
    "FailedAttemptTracker",
    # Exceptions
    "SecretsError",
    "DecryptionError",
    "PasswordTooShort",
    "AccountLocked",
    "InvalidFileFormat",
    # Constants
    "MIN_PASSWORD_LENGTH",
    "MAX_FAILED_ATTEMPTS",
    "LOCKOUT_DURATION",
    "DEFAULT_TIME_COST",
    "DEFAULT_MEMORY_COST",
    "DEFAULT_PARALLELISM",
]

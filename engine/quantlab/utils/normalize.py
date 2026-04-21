"""
Unicode NFC normalization utilities.

All string identifiers must be NFC-normalized before hashing or comparison
to ensure reproducibility across platforms.

Spec Reference: Technical Spec §1.4
"""

import hashlib
import unicodedata
from pathlib import Path


def normalize_string(s: str) -> str:
    """
    NFC-normalize a string.

    Args:
        s: String to normalize

    Returns:
        NFC-normalized string
    """
    return unicodedata.normalize("NFC", s)


def normalize_path(path: str | Path) -> str:
    """
    NFC-normalize a file path for consistent hashing.

    Args:
        path: File path to normalize

    Returns:
        NFC-normalized path string
    """
    return unicodedata.normalize("NFC", str(path))


def normalize_symbol(symbol: str) -> str:
    """
    NFC-normalize and uppercase a symbol for consistent lookups.

    Args:
        symbol: Ticker symbol to normalize

    Returns:
        NFC-normalized uppercase symbol
    """
    return unicodedata.normalize("NFC", symbol.upper())


def hash_string(s: str) -> str:
    """
    Hash a string after NFC normalization.

    Args:
        s: String to hash

    Returns:
        SHA-256 hex digest
    """
    normalized = normalize_string(s)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def hash_code(code: str) -> str:
    """
    Hash strategy code after NFC normalization.

    This ensures consistent code hashes across platforms.

    Args:
        code: Python source code to hash

    Returns:
        SHA-256 hex digest
    """
    normalized = normalize_string(code)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def is_nfc_normalized(s: str) -> bool:
    """
    Check if a string is already NFC-normalized.

    Args:
        s: String to check

    Returns:
        True if string is NFC-normalized
    """
    return unicodedata.is_normalized("NFC", s)


def normalize_dict_keys(d: dict) -> dict:
    """
    NFC-normalize all string keys in a dictionary.

    Args:
        d: Dictionary with potentially non-normalized keys

    Returns:
        New dictionary with NFC-normalized keys
    """
    return {
        normalize_string(k) if isinstance(k, str) else k: v
        for k, v in d.items()
    }

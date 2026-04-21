"""
Tests for Unicode NFC normalization utilities.
"""

import pytest

from quantlab.utils.normalize import (
    hash_code,
    hash_string,
    is_nfc_normalized,
    normalize_dict_keys,
    normalize_path,
    normalize_string,
    normalize_symbol,
)


class TestNormalizeString:
    """Tests for normalize_string function."""

    def test_ascii_unchanged(self):
        """ASCII strings should be unchanged."""
        assert normalize_string("hello") == "hello"
        assert normalize_string("AAPL") == "AAPL"

    def test_nfc_normalization(self):
        """NFD strings should be converted to NFC."""
        # NFD: e + combining acute accent
        nfd = "caf\u0065\u0301"  # café in NFD
        # NFC: precomposed é
        nfc = "caf\u00e9"  # café in NFC

        result = normalize_string(nfd)
        assert result == nfc

    def test_already_nfc(self):
        """Already NFC strings should be unchanged."""
        nfc = "café"
        assert normalize_string(nfc) == nfc

    def test_unicode_symbols(self):
        """Unicode symbols should be handled correctly."""
        # Japanese text
        text = "日本語"
        assert normalize_string(text) == text

    def test_empty_string(self):
        """Empty string should return empty string."""
        assert normalize_string("") == ""


class TestNormalizePath:
    """Tests for normalize_path function."""

    def test_string_path(self):
        """String paths should be normalized."""
        path = "/home/user/café/file.py"
        result = normalize_path(path)
        assert isinstance(result, str)

    def test_pathlib_path(self):
        """pathlib.Path should be converted to string."""
        from pathlib import Path

        path = Path("/home/user/data")
        result = normalize_path(path)
        assert isinstance(result, str)
        assert result == "/home/user/data"

    def test_unicode_filename(self):
        """Unicode filenames should be normalized."""
        # NFD filename
        nfd_path = "/data/\u30c7\u30fc\u30bf.csv"  # データ.csv
        result = normalize_path(nfd_path)
        assert isinstance(result, str)


class TestNormalizeSymbol:
    """Tests for normalize_symbol function."""

    def test_uppercase(self):
        """Symbols should be uppercased."""
        assert normalize_symbol("aapl") == "AAPL"
        assert normalize_symbol("Msft") == "MSFT"

    def test_already_uppercase(self):
        """Already uppercase symbols should be unchanged."""
        assert normalize_symbol("GOOGL") == "GOOGL"

    def test_mixed_case(self):
        """Mixed case should be uppercased."""
        assert normalize_symbol("BtC-uSd") == "BTC-USD"


class TestHashString:
    """Tests for hash_string function."""

    def test_deterministic(self):
        """Hashing should be deterministic."""
        text = "hello world"
        hash1 = hash_string(text)
        hash2 = hash_string(text)
        assert hash1 == hash2

    def test_different_inputs(self):
        """Different inputs should produce different hashes."""
        hash1 = hash_string("hello")
        hash2 = hash_string("world")
        assert hash1 != hash2

    def test_nfc_normalization(self):
        """NFD and NFC versions should produce same hash."""
        nfd = "caf\u0065\u0301"  # café in NFD
        nfc = "caf\u00e9"  # café in NFC

        hash_nfd = hash_string(nfd)
        hash_nfc = hash_string(nfc)
        assert hash_nfd == hash_nfc

    def test_hex_format(self):
        """Hash should be hex format."""
        result = hash_string("test")
        assert all(c in "0123456789abcdef" for c in result)
        assert len(result) == 64  # SHA-256 hex is 64 chars


class TestHashCode:
    """Tests for hash_code function."""

    def test_python_code(self):
        """Python code should be hashed correctly."""
        code = "def strategy(data):\n    return data.close > data.open"
        result = hash_code(code)
        assert len(result) == 64

    def test_whitespace_matters(self):
        """Whitespace differences should produce different hashes."""
        code1 = "def f():\n    pass"
        code2 = "def f():\n\tpass"
        assert hash_code(code1) != hash_code(code2)


class TestIsNfcNormalized:
    """Tests for is_nfc_normalized function."""

    def test_nfc_string(self):
        """NFC strings should return True."""
        assert is_nfc_normalized("café") is True
        assert is_nfc_normalized("hello") is True

    def test_nfd_string(self):
        """NFD strings should return False."""
        nfd = "caf\u0065\u0301"
        assert is_nfc_normalized(nfd) is False


class TestNormalizeDictKeys:
    """Tests for normalize_dict_keys function."""

    def test_string_keys(self):
        """String keys should be normalized."""
        d = {"café": 1, "hello": 2}
        result = normalize_dict_keys(d)
        assert "café" in result
        assert "hello" in result

    def test_non_string_keys(self):
        """Non-string keys should be preserved."""
        d = {1: "one", 2: "two"}
        result = normalize_dict_keys(d)
        assert result == d

    def test_mixed_keys(self):
        """Mixed key types should be handled."""
        d = {"text": 1, 42: 2}
        result = normalize_dict_keys(d)
        assert result["text"] == 1
        assert result[42] == 2

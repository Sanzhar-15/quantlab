"""
Tests for content hashing functionality.
"""

import io
from decimal import Decimal
from pathlib import Path

import pandas as pd
import pytest

from quantlab.data.hash import (
    ContentHasher,
    HashResult,
    RowHasher,
    SampledHasher,
    hash_bytes_quick,
    hash_file_quick,
)


class TestHashResult:
    """Tests for HashResult dataclass."""

    def test_to_dict(self) -> None:
        """Test converting HashResult to dictionary."""
        result = HashResult(
            algorithm="sha256",
            hash_value="abc123",
            byte_count=100,
            row_count=10,
            is_sampled=True,
            sample_rate=0.5,
        )

        d = result.to_dict()

        assert d["algorithm"] == "sha256"
        assert d["hash"] == "abc123"
        assert d["bytes"] == 100
        assert d["rows"] == 10
        assert d["sampled"] is True
        assert d["sample_rate"] == 0.5

    def test_equality_same_hash(self) -> None:
        """Test equality for same hash values."""
        result1 = HashResult(
            algorithm="sha256",
            hash_value="abc123",
            byte_count=100,
        )
        result2 = HashResult(
            algorithm="sha256",
            hash_value="abc123",
            byte_count=200,  # Different byte count
        )

        assert result1 == result2

    def test_equality_different_hash(self) -> None:
        """Test inequality for different hash values."""
        result1 = HashResult(
            algorithm="sha256",
            hash_value="abc123",
            byte_count=100,
        )
        result2 = HashResult(
            algorithm="sha256",
            hash_value="def456",
            byte_count=100,
        )

        assert result1 != result2

    def test_equality_non_hashresult(self) -> None:
        """Test comparison with non-HashResult."""
        result = HashResult(
            algorithm="sha256",
            hash_value="abc123",
            byte_count=100,
        )

        assert result != "abc123"
        assert result != 123
        assert result != None


class TestContentHasher:
    """Tests for ContentHasher class."""

    def test_init_default_algorithm(self) -> None:
        """Test default algorithm is sha256."""
        hasher = ContentHasher()
        assert hasher.algorithm == "sha256"

    def test_init_custom_algorithm(self) -> None:
        """Test using custom algorithm."""
        hasher = ContentHasher("sha1")
        assert hasher.algorithm == "sha1"

    def test_init_invalid_algorithm(self) -> None:
        """Test invalid algorithm raises ValueError."""
        with pytest.raises(ValueError) as exc:
            ContentHasher("invalid_algo")
        assert "Unknown algorithm" in str(exc.value)

    def test_hash_bytes(self) -> None:
        """Test hashing raw bytes."""
        hasher = ContentHasher()
        data = b"Hello, World!"

        result = hasher.hash_bytes(data)

        assert result.algorithm == "sha256"
        assert len(result.hash_value) == 64  # SHA256 produces 64 hex chars
        assert result.byte_count == len(data)

    def test_hash_bytes_reproducible(self) -> None:
        """Test hashing same data produces same result."""
        hasher = ContentHasher()
        data = b"Test data"

        result1 = hasher.hash_bytes(data)
        result2 = hasher.hash_bytes(data)

        assert result1.hash_value == result2.hash_value

    def test_hash_file(self, tmp_path: Path) -> None:
        """Test hashing a file."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")

        hasher = ContentHasher()
        result = hasher.hash_file(test_file)

        assert result.algorithm == "sha256"
        assert result.byte_count == 13
        assert len(result.hash_value) == 64

    def test_hash_file_string_path(self, tmp_path: Path) -> None:
        """Test hashing file with string path."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("Test content")

        hasher = ContentHasher()
        result = hasher.hash_file(str(test_file))

        assert result.byte_count == 12

    def test_hash_stream(self) -> None:
        """Test hashing from a stream."""
        data = b"Stream data for hashing"
        stream = io.BytesIO(data)

        hasher = ContentHasher()
        result = hasher.hash_stream(stream)

        assert result.byte_count == len(data)
        assert len(result.hash_value) == 64

    def test_hash_md5(self) -> None:
        """Test hashing with MD5."""
        hasher = ContentHasher("md5")
        result = hasher.hash_bytes(b"test")

        assert result.algorithm == "md5"
        assert len(result.hash_value) == 32  # MD5 produces 32 hex chars

    def test_hash_sha1(self) -> None:
        """Test hashing with SHA1."""
        hasher = ContentHasher("sha1")
        result = hasher.hash_bytes(b"test")

        assert result.algorithm == "sha1"
        assert len(result.hash_value) == 40  # SHA1 produces 40 hex chars

    def test_hash_xxhash_fallback(self) -> None:
        """Test xxhash falls back to sha256 if not available."""
        hasher = ContentHasher("xxhash")
        result = hasher.hash_bytes(b"test")

        # Should produce a hash either way
        assert len(result.hash_value) >= 16


class TestSampledHasher:
    """Tests for SampledHasher class."""

    def test_init_default(self) -> None:
        """Test default initialization."""
        hasher = SampledHasher()

        assert hasher.sample_rate == 0.01
        assert hasher.algorithm == "sha256"
        assert hasher.seed == 42

    def test_init_custom(self) -> None:
        """Test custom initialization."""
        hasher = SampledHasher(
            sample_rate=0.1,
            algorithm="md5",
            seed=123,
        )

        assert hasher.sample_rate == 0.1
        assert hasher.algorithm == "md5"
        assert hasher.seed == 123

    def test_hash_bytes(self) -> None:
        """Test hashing raw bytes."""
        hasher = SampledHasher()
        data = b"Test data"

        result = hasher.hash_bytes(data)

        assert result.is_sampled is True
        assert result.sample_rate == 0.01
        assert result.byte_count == len(data)

    def test_hash_rows(self) -> None:
        """Test hashing sampled rows."""
        hasher = SampledHasher(sample_rate=0.5)

        rows = [b"row1", b"row2", b"row3", b"row4", b"row5"]
        result = hasher.hash_rows(iter(rows), total_rows=5)

        assert result.is_sampled is True
        assert result.row_count == 5

    def test_hash_rows_empty(self) -> None:
        """Test hashing empty rows."""
        hasher = SampledHasher()

        result = hasher.hash_rows(iter([]), total_rows=0)

        assert result.row_count == 0
        assert result.sample_rate == 0

    def test_should_sample_row(self) -> None:
        """Test row sampling logic."""
        hasher = SampledHasher(sample_rate=0.01)

        # With 100000 rows and 1% sample rate, should sample around 1000 rows
        sampled_count = sum(
            1 for i in range(100000) if hasher._should_sample_row(i, 100000)
        )

        # Should be around MIN_SAMPLE_ROWS (1000)
        assert sampled_count > 0
        assert sampled_count <= 2000  # Some buffer for the calculation

    def test_hash_dataframe_sample(self) -> None:
        """Test hashing sampled DataFrame rows."""
        hasher = SampledHasher(sample_rate=0.5)

        df = pd.DataFrame({
            "a": [1, 2, 3, 4, 5],
            "b": ["x", "y", "z", "w", "v"],
        })

        result = hasher.hash_dataframe_sample(df)

        assert result.is_sampled is True
        assert result.row_count == 5
        assert result.sample_rate > 0

    def test_hash_dataframe_sample_with_columns(self) -> None:
        """Test hashing specific columns from DataFrame."""
        hasher = SampledHasher(sample_rate=0.5)

        df = pd.DataFrame({
            "a": [1, 2, 3, 4, 5],
            "b": ["x", "y", "z", "w", "v"],
            "c": [10, 20, 30, 40, 50],
        })

        result = hasher.hash_dataframe_sample(df, columns=["a", "b"])

        assert result.is_sampled is True
        assert result.row_count == 5

    def test_hash_dataframe_empty(self) -> None:
        """Test hashing empty DataFrame."""
        hasher = SampledHasher()

        df = pd.DataFrame({"a": [], "b": []})

        result = hasher.hash_dataframe_sample(df)

        assert result.row_count == 0
        assert result.sample_rate == 0


class TestRowHasher:
    """Tests for RowHasher class."""

    def test_init_default(self) -> None:
        """Test default initialization."""
        hasher = RowHasher()
        assert hasher.algorithm == "sha256"

    def test_init_custom(self) -> None:
        """Test custom initialization."""
        hasher = RowHasher("md5")
        assert hasher.algorithm == "md5"

    def test_hash_row_integers(self) -> None:
        """Test hashing row with integers."""
        hasher = RowHasher()
        values = [1, 2, 3]

        hash_value = hasher.hash_row(values)

        assert len(hash_value) == 64

    def test_hash_row_mixed_types(self) -> None:
        """Test hashing row with mixed types."""
        hasher = RowHasher()
        values = [1, "hello", 3.14, Decimal("1.5"), None]

        hash_value = hasher.hash_row(values)

        assert len(hash_value) == 64

    def test_hash_row_none(self) -> None:
        """Test hashing row with None values."""
        hasher = RowHasher()
        values = [None, None, None]

        hash_value = hasher.hash_row(values)

        assert len(hash_value) == 64

    def test_hash_row_bytes(self) -> None:
        """Test hashing row with bytes."""
        hasher = RowHasher()
        values = [b"binary", 123, "string"]

        hash_value = hasher.hash_row(values)

        assert len(hash_value) == 64

    def test_hash_row_other_types(self) -> None:
        """Test hashing row with other types (converted to string)."""
        hasher = RowHasher()
        values = [[1, 2, 3], {"key": "value"}, (1, 2)]

        hash_value = hasher.hash_row(values)

        assert len(hash_value) == 64

    def test_hash_row_reproducible(self) -> None:
        """Test hashing same row produces same result."""
        hasher = RowHasher()
        values = [1, "test", 3.14]

        hash1 = hasher.hash_row(values)
        hash2 = hasher.hash_row(values)

        assert hash1 == hash2

    def test_hash_dict_row(self) -> None:
        """Test hashing dictionary row."""
        hasher = RowHasher()
        row = {"a": 1, "b": "hello", "c": 3.14}
        columns = ["a", "b", "c"]

        hash_value = hasher.hash_dict_row(row, columns)

        assert len(hash_value) == 64

    def test_hash_dict_row_missing_column(self) -> None:
        """Test hashing dict row with missing column (gets None)."""
        hasher = RowHasher()
        row = {"a": 1, "b": "hello"}
        columns = ["a", "b", "c"]  # c is missing

        hash_value = hasher.hash_dict_row(row, columns)

        assert len(hash_value) == 64

    def test_hash_dict_row_order_matters(self) -> None:
        """Test that column order affects hash."""
        hasher = RowHasher()
        row = {"a": 1, "b": 2}

        hash1 = hasher.hash_dict_row(row, ["a", "b"])
        hash2 = hasher.hash_dict_row(row, ["b", "a"])

        assert hash1 != hash2


class TestQuickHashFunctions:
    """Tests for quick hash utility functions."""

    def test_hash_file_quick(self, tmp_path: Path) -> None:
        """Test quick file hashing."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("Quick hash test")

        hash_value = hash_file_quick(test_file)

        assert len(hash_value) == 64

    def test_hash_file_quick_string_path(self, tmp_path: Path) -> None:
        """Test quick file hashing with string path."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("Quick hash test")

        hash_value = hash_file_quick(str(test_file))

        assert len(hash_value) == 64

    def test_hash_bytes_quick(self) -> None:
        """Test quick bytes hashing."""
        data = b"Quick hash bytes"

        hash_value = hash_bytes_quick(data)

        assert len(hash_value) == 64

    def test_hash_bytes_quick_reproducible(self) -> None:
        """Test quick bytes hashing is reproducible."""
        data = b"Test data"

        hash1 = hash_bytes_quick(data)
        hash2 = hash_bytes_quick(data)

        assert hash1 == hash2

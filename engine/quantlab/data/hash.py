"""
Content Hashing for Data Provenance.

Provides full and sampled hashing for data integrity verification.

Spec Reference: Technical Spec §5.1
"""

import hashlib
import struct
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any
from typing import BinaryIO
from typing import Iterator


@dataclass
class HashResult:
    """Result of a hashing operation."""

    algorithm: str
    hash_value: str
    byte_count: int
    row_count: int | None = None
    is_sampled: bool = False
    sample_rate: float | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "algorithm": self.algorithm,
            "hash": self.hash_value,
            "bytes": self.byte_count,
            "rows": self.row_count,
            "sampled": self.is_sampled,
            "sample_rate": self.sample_rate,
        }

    def __eq__(self, other: object) -> bool:
        """Compare hash values."""
        if isinstance(other, HashResult):
            return self.hash_value == other.hash_value
        return False


class ContentHasher:
    """
    Hash content for data integrity verification.

    Supports multiple algorithms and sampling for large files.
    """

    ALGORITHMS = ["sha256", "sha1", "md5", "xxhash"]
    DEFAULT_ALGORITHM = "sha256"
    CHUNK_SIZE = 8192  # 8KB chunks

    def __init__(
        self,
        algorithm: str = DEFAULT_ALGORITHM,
    ) -> None:
        """
        Initialize content hasher.

        Args:
            algorithm: Hash algorithm to use
        """
        if algorithm not in self.ALGORITHMS:
            raise ValueError(f"Unknown algorithm: {algorithm}")
        self.algorithm = algorithm

    def _get_hasher(self) -> Any:
        """Get the appropriate hasher object."""
        if self.algorithm == "xxhash":
            try:
                import xxhash
                return xxhash.xxh64()
            except ImportError:
                import logging
                logger = logging.getLogger(__name__)
                logger.warning(
                    "xxhash requested but not installed. Falling back to sha256. "
                    "For better performance, install with: pip install xxhash"
                )
                return hashlib.sha256()
        return hashlib.new(self.algorithm)

    def hash_bytes(self, data: bytes) -> HashResult:
        """
        Hash raw bytes.

        Args:
            data: Bytes to hash

        Returns:
            HashResult with hash value
        """
        hasher = self._get_hasher()
        hasher.update(data)

        return HashResult(
            algorithm=self.algorithm,
            hash_value=hasher.hexdigest(),
            byte_count=len(data),
        )

    def hash_file(self, path: Path | str) -> HashResult:
        """
        Hash a file completely.

        Args:
            path: Path to file

        Returns:
            HashResult with hash value
        """
        path = Path(path)
        hasher = self._get_hasher()
        byte_count = 0

        with open(path, "rb") as f:
            while chunk := f.read(self.CHUNK_SIZE):
                hasher.update(chunk)
                byte_count += len(chunk)

        return HashResult(
            algorithm=self.algorithm,
            hash_value=hasher.hexdigest(),
            byte_count=byte_count,
        )

    def hash_stream(self, stream: BinaryIO) -> HashResult:
        """
        Hash from a binary stream.

        Args:
            stream: Binary file-like object

        Returns:
            HashResult with hash value
        """
        hasher = self._get_hasher()
        byte_count = 0

        while chunk := stream.read(self.CHUNK_SIZE):
            hasher.update(chunk)
            byte_count += len(chunk)

        return HashResult(
            algorithm=self.algorithm,
            hash_value=hasher.hexdigest(),
            byte_count=byte_count,
        )


class SampledHasher:
    """
    Sampled hashing for large datasets.

    Hashes a deterministic sample of rows for efficiency.
    """

    DEFAULT_SAMPLE_RATE = 0.01  # 1%
    MIN_SAMPLE_ROWS = 1000
    MAX_SAMPLE_ROWS = 100000

    def __init__(
        self,
        sample_rate: float = DEFAULT_SAMPLE_RATE,
        algorithm: str = "sha256",
        seed: int = 42,
    ) -> None:
        """
        Initialize sampled hasher.

        Args:
            sample_rate: Fraction of rows to sample (0-1)
            algorithm: Hash algorithm
            seed: Random seed for deterministic sampling
        """
        self.sample_rate = sample_rate
        self.algorithm = algorithm
        self.seed = seed
        self._content_hasher = ContentHasher(algorithm)

    def _should_sample_row(self, row_index: int, total_rows: int) -> bool:
        """
        Determine if a row should be included in sample.

        Uses deterministic sampling based on row index.
        """
        # Calculate target sample count
        target_count = max(
            self.MIN_SAMPLE_ROWS,
            min(int(total_rows * self.sample_rate), self.MAX_SAMPLE_ROWS),
        )

        # Deterministic selection using modulo
        step = max(1, total_rows // target_count)
        return row_index % step == 0

    def hash_bytes(self, data: bytes) -> HashResult:
        """
        Hash raw bytes with sampling.

        Args:
            data: Bytes to hash

        Returns:
            HashResult with hash value
        """
        hasher = self._content_hasher._get_hasher()
        hasher.update(data)

        return HashResult(
            algorithm=self.algorithm,
            hash_value=hasher.hexdigest(),
            byte_count=len(data),
            is_sampled=True,
            sample_rate=self.sample_rate,
        )

    def hash_rows(
        self,
        rows: Iterator[bytes],
        total_rows: int,
    ) -> HashResult:
        """
        Hash sampled rows.

        Args:
            rows: Iterator of row bytes
            total_rows: Total number of rows (for sample rate calculation)

        Returns:
            HashResult with sampled hash
        """
        hasher = self._content_hasher._get_hasher()
        byte_count = 0
        row_count = 0
        sampled_rows = 0

        for i, row_bytes in enumerate(rows):
            row_count += 1
            if self._should_sample_row(i, total_rows):
                hasher.update(row_bytes)
                byte_count += len(row_bytes)
                sampled_rows += 1

        actual_rate = sampled_rows / row_count if row_count > 0 else 0

        return HashResult(
            algorithm=self.algorithm,
            hash_value=hasher.hexdigest(),
            byte_count=byte_count,
            row_count=row_count,
            is_sampled=True,
            sample_rate=actual_rate,
        )

    def hash_dataframe_sample(
        self,
        df: Any,  # pandas DataFrame
        columns: list[str] | None = None,
    ) -> HashResult:
        """
        Hash sampled rows from a DataFrame.

        Args:
            df: pandas DataFrame
            columns: Columns to include in hash (None = all)

        Returns:
            HashResult with sampled hash
        """
        import pandas as pd

        if columns:
            df = df[columns]

        total_rows = len(df)

        # Determine sample indices
        target_count = max(
            self.MIN_SAMPLE_ROWS,
            min(int(total_rows * self.sample_rate), self.MAX_SAMPLE_ROWS),
        )
        step = max(1, total_rows // target_count)
        sample_indices = range(0, total_rows, step)

        # Sample and hash
        sample_df = df.iloc[list(sample_indices)]

        # Convert to bytes for hashing
        hasher = self._content_hasher._get_hasher()
        byte_count = 0

        for _, row in sample_df.iterrows():
            row_bytes = row.to_json().encode("utf-8")
            hasher.update(row_bytes)
            byte_count += len(row_bytes)

        actual_rate = len(sample_df) / total_rows if total_rows > 0 else 0

        return HashResult(
            algorithm=self.algorithm,
            hash_value=hasher.hexdigest(),
            byte_count=byte_count,
            row_count=total_rows,
            is_sampled=True,
            sample_rate=actual_rate,
        )


class RowHasher:
    """
    Hash individual rows for row-level verification.

    Useful for detecting specific row changes.
    """

    def __init__(self, algorithm: str = "sha256") -> None:
        self.algorithm = algorithm

    def hash_row(self, values: list[Any]) -> str:
        """
        Hash a single row of values.

        Args:
            values: List of values in the row

        Returns:
            Hash string for the row
        """
        hasher = hashlib.new(self.algorithm)

        for value in values:
            # Convert to consistent byte representation
            if value is None:
                hasher.update(b"\x00")
            elif isinstance(value, (int, float, Decimal)):
                # Use struct for numeric values
                hasher.update(struct.pack("d", float(value)))
            elif isinstance(value, str):
                hasher.update(value.encode("utf-8"))
            elif isinstance(value, bytes):
                hasher.update(value)
            else:
                hasher.update(str(value).encode("utf-8"))

        return hasher.hexdigest()

    def hash_dict_row(self, row: dict[str, Any], columns: list[str]) -> str:
        """
        Hash a dictionary row using specified column order.

        Args:
            row: Dictionary of column -> value
            columns: Ordered list of columns to include

        Returns:
            Hash string for the row
        """
        values = [row.get(col) for col in columns]
        return self.hash_row(values)


def hash_file_quick(path: Path | str) -> str:
    """
    Quick file hash using sha256.

    Args:
        path: Path to file

    Returns:
        SHA256 hash string
    """
    hasher = ContentHasher("sha256")
    return hasher.hash_file(path).hash_value


def hash_bytes_quick(data: bytes) -> str:
    """
    Quick bytes hash using sha256.

    Args:
        data: Bytes to hash

    Returns:
        SHA256 hash string
    """
    hasher = ContentHasher("sha256")
    return hasher.hash_bytes(data).hash_value

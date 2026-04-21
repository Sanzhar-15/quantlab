"""
Data Revision (DataRev) System.

Tracks data provenance and versions for reproducibility.

Spec Reference: Technical Spec §5.2
"""

import json
from dataclasses import dataclass
from dataclasses import field
from datetime import date
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

from quantlab.data.hash import ContentHasher
from quantlab.data.hash import HashResult
from quantlab.data.hash import SampledHasher


class DataSource(Enum):
    """Data source types."""

    FILE = "file"
    DATABASE = "database"
    API = "api"
    GENERATED = "generated"
    CACHE = "cache"


class DataFormat(Enum):
    """Data format types."""

    CSV = "csv"
    PARQUET = "parquet"
    JSON = "json"
    FEATHER = "feather"
    HDF5 = "hdf5"
    PICKLE = "pickle"
    SQLITE = "sqlite"


@dataclass
class DataSchema:
    """
    Schema definition for data.

    Captures column names, types, and constraints.
    """

    columns: list[str]
    dtypes: dict[str, str]  # column -> dtype string
    primary_key: list[str] | None = None
    nullable: dict[str, bool] | None = None
    constraints: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "columns": self.columns,
            "dtypes": self.dtypes,
            "primary_key": self.primary_key,
            "nullable": self.nullable,
            "constraints": self.constraints,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DataSchema":
        """Create from dictionary."""
        return cls(
            columns=data["columns"],
            dtypes=data["dtypes"],
            primary_key=data.get("primary_key"),
            nullable=data.get("nullable"),
            constraints=data.get("constraints"),
        )

    @classmethod
    def from_dataframe(cls, df: Any) -> "DataSchema":
        """Create schema from pandas DataFrame."""
        return cls(
            columns=list(df.columns),
            dtypes={col: str(dtype) for col, dtype in df.dtypes.items()},
        )


@dataclass
class DataRev:
    """
    Data Revision - complete provenance record.

    Tracks everything needed to reproduce and verify data.
    """

    # Identification
    rev_id: str  # Unique revision identifier
    name: str  # Human-readable name

    # Source information
    source: DataSource
    source_path: str | None = None  # File path or URL
    source_query: str | None = None  # SQL or API query

    # Content characteristics
    format: DataFormat = DataFormat.CSV
    schema: DataSchema | None = None
    row_count: int = 0
    column_count: int = 0
    byte_size: int = 0

    # Time bounds
    start_date: datetime | None = None
    end_date: datetime | None = None
    as_of_date: datetime | None = None  # Point-in-time reference

    # Hashes for verification
    full_hash: HashResult | None = None
    sampled_hash: HashResult | None = None

    # Metadata
    created_at: datetime = field(default_factory=datetime.now)
    created_by: str = ""
    description: str = ""
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    # Lineage
    parent_rev: str | None = None  # Previous revision
    derived_from: list[str] = field(default_factory=list)  # Source revisions

    # FIX-CGP-016: Corporate actions tracking
    # Tracks splits and dividends in the data range for reproducibility
    corporate_actions: dict[str, Any] = field(default_factory=dict)
    # Structure: {"splits": [...], "dividends": [...], "actions_hash": "..."}
    # splits: [{"date": "2024-01-15", "symbol": "AAPL", "ratio": "4:1"}]
    # dividends: [{"date": "2024-02-01", "symbol": "AAPL", "amount": "0.24"}]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization."""
        return {
            "rev_id": self.rev_id,
            "name": self.name,
            "source": self.source.value,
            "source_path": self.source_path,
            "source_query": self.source_query,
            "format": self.format.value,
            "schema": self.schema.to_dict() if self.schema else None,
            "row_count": self.row_count,
            "column_count": self.column_count,
            "byte_size": self.byte_size,
            "start_date": self.start_date.isoformat() if self.start_date else None,
            "end_date": self.end_date.isoformat() if self.end_date else None,
            "as_of_date": self.as_of_date.isoformat() if self.as_of_date else None,
            "full_hash": self.full_hash.to_dict() if self.full_hash else None,
            "sampled_hash": self.sampled_hash.to_dict() if self.sampled_hash else None,
            "created_at": self.created_at.isoformat(),
            "created_by": self.created_by,
            "description": self.description,
            "tags": self.tags,
            "metadata": self.metadata,
            "parent_rev": self.parent_rev,
            "derived_from": self.derived_from,
            "corporate_actions": self.corporate_actions,  # FIX-CGP-016
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DataRev":
        """Create from dictionary."""
        full_hash = None
        if data.get("full_hash"):
            h = data["full_hash"]
            full_hash = HashResult(
                algorithm=h["algorithm"],
                hash_value=h["hash"],
                byte_count=h["bytes"],
                row_count=h.get("rows"),
                is_sampled=h.get("sampled", False),
                sample_rate=h.get("sample_rate"),
            )

        sampled_hash = None
        if data.get("sampled_hash"):
            h = data["sampled_hash"]
            sampled_hash = HashResult(
                algorithm=h["algorithm"],
                hash_value=h["hash"],
                byte_count=h["bytes"],
                row_count=h.get("rows"),
                is_sampled=h.get("sampled", True),
                sample_rate=h.get("sample_rate"),
            )

        return cls(
            rev_id=data["rev_id"],
            name=data["name"],
            source=DataSource(data["source"]),
            source_path=data.get("source_path"),
            source_query=data.get("source_query"),
            format=DataFormat(data.get("format", "csv")),
            schema=DataSchema.from_dict(data["schema"]) if data.get("schema") else None,
            row_count=data.get("row_count", 0),
            column_count=data.get("column_count", 0),
            byte_size=data.get("byte_size", 0),
            start_date=datetime.fromisoformat(data["start_date"]) if data.get("start_date") else None,
            end_date=datetime.fromisoformat(data["end_date"]) if data.get("end_date") else None,
            as_of_date=datetime.fromisoformat(data["as_of_date"]) if data.get("as_of_date") else None,
            full_hash=full_hash,
            sampled_hash=sampled_hash,
            created_at=datetime.fromisoformat(data["created_at"]),
            created_by=data.get("created_by", ""),
            description=data.get("description", ""),
            tags=data.get("tags", []),
            metadata=data.get("metadata", {}),
            parent_rev=data.get("parent_rev"),
            derived_from=data.get("derived_from", []),
            corporate_actions=data.get("corporate_actions", {}),  # FIX-CGP-016
        )

    def verify(self, path: Path | str) -> bool:
        """
        Verify data against stored hash.

        Args:
            path: Path to data file

        Returns:
            True if hash matches
        """
        if self.full_hash is None:
            return False

        hasher = ContentHasher(self.full_hash.algorithm)
        current = hasher.hash_file(path)

        return current.hash_value == self.full_hash.hash_value

    # FIX-CGP-016: Corporate actions helper methods
    def add_split(
        self,
        symbol: str,
        split_date: date | str,
        ratio: str,
        ex_date: date | str | None = None,
    ) -> None:
        """
        Add a stock split to the corporate actions record.

        Args:
            symbol: Stock symbol
            split_date: Date of the split
            ratio: Split ratio (e.g., "4:1" for 4-for-1)
            ex_date: Ex-date if different from split_date
        """
        if "splits" not in self.corporate_actions:
            self.corporate_actions["splits"] = []

        if isinstance(split_date, date):
            split_date = split_date.isoformat()
        if isinstance(ex_date, date):
            ex_date = ex_date.isoformat()

        self.corporate_actions["splits"].append({
            "symbol": symbol,
            "date": split_date,
            "ratio": ratio,
            "ex_date": ex_date,
        })

    def add_dividend(
        self,
        symbol: str,
        ex_date: date | str,
        amount: str | float,
        pay_date: date | str | None = None,
        dividend_type: str = "regular",
    ) -> None:
        """
        Add a dividend to the corporate actions record.

        Args:
            symbol: Stock symbol
            ex_date: Ex-dividend date
            amount: Dividend amount per share
            pay_date: Payment date
            dividend_type: "regular", "special", or "qualified"
        """
        if "dividends" not in self.corporate_actions:
            self.corporate_actions["dividends"] = []

        if isinstance(ex_date, date):
            ex_date = ex_date.isoformat()
        if isinstance(pay_date, date):
            pay_date = pay_date.isoformat()

        self.corporate_actions["dividends"].append({
            "symbol": symbol,
            "ex_date": ex_date,
            "amount": str(amount),
            "pay_date": pay_date,
            "type": dividend_type,
        })

    def get_splits_for_symbol(self, symbol: str) -> list[dict[str, Any]]:
        """Get all splits for a symbol."""
        return [
            s for s in self.corporate_actions.get("splits", [])
            if s["symbol"] == symbol
        ]

    def get_dividends_for_symbol(self, symbol: str) -> list[dict[str, Any]]:
        """Get all dividends for a symbol."""
        return [
            d for d in self.corporate_actions.get("dividends", [])
            if d["symbol"] == symbol
        ]

    def has_corporate_actions(self) -> bool:
        """Check if any corporate actions are recorded."""
        splits = self.corporate_actions.get("splits", [])
        dividends = self.corporate_actions.get("dividends", [])
        return len(splits) > 0 or len(dividends) > 0


class DataRevBuilder:
    """
    Builder for creating DataRev records.

    Simplifies DataRev creation with automatic hash computation.
    """

    def __init__(self) -> None:
        self._rev_counter = 0

    def _generate_rev_id(self) -> str:
        """Generate unique revision ID."""
        self._rev_counter += 1
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        return f"rev-{timestamp}-{self._rev_counter:04d}"

    def from_file(
        self,
        path: Path | str,
        name: str | None = None,
        compute_full_hash: bool = True,
        compute_sampled_hash: bool = False,
    ) -> DataRev:
        """
        Create DataRev from a file.

        Args:
            path: Path to data file
            name: Name for the revision
            compute_full_hash: Whether to compute full file hash
            compute_sampled_hash: Whether to compute sampled hash

        Returns:
            DataRev record
        """
        path = Path(path)

        # Determine format
        suffix = path.suffix.lower()
        format_map = {
            ".csv": DataFormat.CSV,
            ".parquet": DataFormat.PARQUET,
            ".json": DataFormat.JSON,
            ".feather": DataFormat.FEATHER,
            ".h5": DataFormat.HDF5,
            ".hdf5": DataFormat.HDF5,
            ".pkl": DataFormat.PICKLE,
            ".pickle": DataFormat.PICKLE,
            ".db": DataFormat.SQLITE,
            ".sqlite": DataFormat.SQLITE,
        }
        data_format = format_map.get(suffix, DataFormat.CSV)

        # Get file stats
        byte_size = path.stat().st_size

        # Compute hashes
        full_hash = None
        if compute_full_hash:
            hasher = ContentHasher()
            full_hash = hasher.hash_file(path)

        sampled_hash = None
        # Sampled hash requires loading data - skip for now

        return DataRev(
            rev_id=self._generate_rev_id(),
            name=name or path.name,
            source=DataSource.FILE,
            source_path=str(path.absolute()),
            format=data_format,
            byte_size=byte_size,
            full_hash=full_hash,
            sampled_hash=sampled_hash,
        )

    def from_dataframe(
        self,
        df: Any,  # pandas DataFrame
        name: str,
        source: DataSource = DataSource.GENERATED,
        compute_sampled_hash: bool = True,
    ) -> DataRev:
        """
        Create DataRev from a DataFrame.

        Args:
            df: pandas DataFrame
            name: Name for the revision
            source: Data source type
            compute_sampled_hash: Whether to compute sampled hash

        Returns:
            DataRev record
        """
        schema = DataSchema.from_dataframe(df)

        sampled_hash = None
        if compute_sampled_hash:
            sampler = SampledHasher()
            sampled_hash = sampler.hash_dataframe_sample(df)

        # Detect date range if present
        start_date = None
        end_date = None

        date_cols = ["date", "timestamp", "datetime", "time"]
        for col in date_cols:
            if col in df.columns:
                try:
                    start_date = df[col].min()
                    end_date = df[col].max()
                    if hasattr(start_date, "to_pydatetime"):
                        start_date = start_date.to_pydatetime()
                        end_date = end_date.to_pydatetime()
                    break
                except Exception:
                    pass

        return DataRev(
            rev_id=self._generate_rev_id(),
            name=name,
            source=source,
            schema=schema,
            row_count=len(df),
            column_count=len(df.columns),
            start_date=start_date,
            end_date=end_date,
            sampled_hash=sampled_hash,
        )


class DataRevStore:
    """
    Storage for DataRev records.

    Persists revisions to disk for tracking.
    """

    def __init__(self, store_path: Path | str) -> None:
        """
        Initialize DataRev store.

        Args:
            store_path: Path to store directory
        """
        self.store_path = Path(store_path)
        self.store_path.mkdir(parents=True, exist_ok=True)
        self._index_path = self.store_path / "index.json"
        self._index: dict[str, str] = {}  # rev_id -> filename
        self._load_index()

    def _load_index(self) -> None:
        """Load index from disk."""
        if self._index_path.exists():
            with open(self._index_path) as f:
                self._index = json.load(f)

    def _save_index(self) -> None:
        """Save index to disk."""
        with open(self._index_path, "w") as f:
            json.dump(self._index, f, indent=2)

    def save(self, rev: DataRev) -> None:
        """
        Save a DataRev to the store.

        Args:
            rev: DataRev to save
        """
        filename = f"{rev.rev_id}.json"
        filepath = self.store_path / filename

        with open(filepath, "w") as f:
            json.dump(rev.to_dict(), f, indent=2)

        self._index[rev.rev_id] = filename
        self._save_index()

    def load(self, rev_id: str) -> DataRev | None:
        """
        Load a DataRev by ID.

        Args:
            rev_id: Revision ID

        Returns:
            DataRev or None if not found
        """
        if rev_id not in self._index:
            return None

        filepath = self.store_path / self._index[rev_id]
        if not filepath.exists():
            return None

        with open(filepath) as f:
            data = json.load(f)

        return DataRev.from_dict(data)

    def list_revisions(self, name_filter: str | None = None) -> list[str]:
        """
        List all revision IDs.

        Args:
            name_filter: Optional filter by name prefix

        Returns:
            List of revision IDs
        """
        if name_filter is None:
            return list(self._index.keys())

        # Need to load revisions to filter by name
        matching = []
        for rev_id in self._index:
            rev = self.load(rev_id)
            if rev and rev.name.startswith(name_filter):
                matching.append(rev_id)

        return matching

    def get_latest(self, name: str) -> DataRev | None:
        """
        Get latest revision for a named dataset.

        Args:
            name: Dataset name

        Returns:
            Latest DataRev or None
        """
        matching = []
        for rev_id in self._index:
            rev = self.load(rev_id)
            if rev and rev.name == name:
                matching.append(rev)

        if not matching:
            return None

        return max(matching, key=lambda r: r.created_at)


# Backward compatibility re-exports (FIX-M7: canonical definitions in universe.py)
from quantlab.data.universe import MembershipChangeType  # noqa: F401
from quantlab.data.universe import MembershipChange  # noqa: F401
from quantlab.data.universe import UniverseRev  # noqa: F401


# =============================================================================
# Chain Verification (FIX-E006)
# =============================================================================


def verify_revision_chain(
    revisions: list[DataRev],
    verify_file_hashes: bool = True,
) -> tuple[bool, list[str]]:
    """
    Verify the integrity of a revision chain (FIX-E006).

    Checks:
    1. Parent hash links are correct
    2. File hashes match if verify_file_hashes=True
    3. Revisions are in chronological order

    Args:
        revisions: List of revisions in chronological order
        verify_file_hashes: Also verify file content hashes

    Returns:
        Tuple of (is_valid, list of error messages)
    """
    import logging
    logger = logging.getLogger(__name__)

    errors: list[str] = []

    if not revisions:
        return True, []

    # Sort by creation time to ensure correct order
    sorted_revs = sorted(revisions, key=lambda r: r.created_at)

    for i, rev in enumerate(sorted_revs):
        # Verify parent link (except for first revision)
        if i > 0:
            expected_parent = sorted_revs[i - 1].full_hash
            if expected_parent and rev.parent_rev:
                if rev.parent_rev != expected_parent.hash_value:
                    errors.append(
                        f"Revision {rev.rev_id} parent hash mismatch: "
                        f"expected {expected_parent.hash_value[:16]}..., "
                        f"got {rev.parent_rev[:16]}..."
                    )

        # Verify file hash if source_path exists
        if verify_file_hashes and rev.source_path and rev.full_hash:
            source = Path(rev.source_path)
            if source.exists():
                if not rev.verify(source):
                    errors.append(
                        f"Revision {rev.rev_id} file hash mismatch for {source}"
                    )
                    logger.warning(f"File hash mismatch: {rev.rev_id}")
            else:
                logger.debug(f"Source file not found for verification: {source}")

    return len(errors) == 0, errors


def compute_revision_hash(data_path: Path, metadata: dict[str, Any]) -> str:
    """
    Compute hash for a revision given its data file and metadata.

    This can be used to verify or regenerate revision hashes.

    Args:
        data_path: Path to data file
        metadata: Revision metadata

    Returns:
        SHA-256 hash string
    """
    import hashlib

    hasher = hashlib.sha256()

    # Hash file content
    if data_path.exists():
        with open(data_path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                hasher.update(chunk)

    # Hash metadata
    metadata_str = json.dumps(metadata, sort_keys=True)
    hasher.update(metadata_str.encode("utf-8"))

    return hasher.hexdigest()

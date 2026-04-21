"""
Tests for Data Provenance (DataRev/UniverseRev).

Tests content hashing, revision tracking, and point-in-time universes.
"""

from datetime import date
from datetime import datetime
from datetime import timedelta
from pathlib import Path

import pandas as pd
import pytest

from quantlab.data import (
    ContentHasher,
    DataRev,
    HashResult,
    MembershipChange,
    MembershipChangeType,
    SampledHasher,
    UniverseRev,
)
from quantlab.data.rev import (
    DataFormat,
    DataRevBuilder,
    DataRevStore,
    DataSchema,
    DataSource,
)
from quantlab.data.universe import (
    PredefinedUniverses,
    UniverseBuilder,
    UniverseSnapshot,
    UniverseStore,
    UniverseType,
)


class TestHashResult:
    """Tests for HashResult dataclass."""

    def test_hash_result_creation(self) -> None:
        """Test creating a hash result."""
        result = HashResult(
            algorithm="sha256",
            hash_value="abc123def456",
            byte_count=1024,
        )

        assert result.hash_value == "abc123def456"
        assert result.algorithm == "sha256"
        assert result.byte_count == 1024

    def test_hash_equality(self) -> None:
        """Test hash equality comparison."""
        result1 = HashResult(
            algorithm="sha256",
            hash_value="abc123",
            byte_count=100,
        )
        result2 = HashResult(
            algorithm="sha256",
            hash_value="abc123",
            byte_count=100,
        )
        result3 = HashResult(
            algorithm="sha256",
            hash_value="xyz789",
            byte_count=100,
        )

        assert result1 == result2
        assert result1 != result3


class TestContentHasher:
    """Tests for ContentHasher."""

    def test_hash_bytes(self) -> None:
        """Test hashing bytes."""
        hasher = ContentHasher()
        result = hasher.hash_bytes(b"test data")

        assert result.algorithm == "sha256"
        assert len(result.hash_value) > 0
        assert result.byte_count == 9

    def test_hash_deterministic(self) -> None:
        """Test that hash is deterministic."""
        hasher = ContentHasher()
        data = b"test data"

        result1 = hasher.hash_bytes(data)
        result2 = hasher.hash_bytes(data)

        assert result1.hash_value == result2.hash_value


class TestSampledHasher:
    """Tests for SampledHasher."""

    def test_sampled_hash(self) -> None:
        """Test sampled hashing."""
        hasher = SampledHasher(sample_rate=0.5)
        data = b"test data " * 100

        result = hasher.hash_bytes(data)

        assert result.is_sampled is True
        assert result.sample_rate == 0.5


class TestUniverseRev:
    """Tests for UniverseRev point-in-time universes."""

    @pytest.fixture
    def universe(self) -> UniverseRev:
        """Create sample universe with membership changes."""
        universe = UniverseRev(
            universe_id="test_universe",
            name="Test Universe",
            base_date=date(2026, 1, 1),
        )
        return universe

    def test_universe_creation(self, universe: UniverseRev) -> None:
        """Test universe creation."""
        assert universe.universe_id == "test_universe"
        assert universe.name == "Test Universe"

    def test_membership_change(self) -> None:
        """Test membership change creation."""
        change = MembershipChange(
            symbol="AAPL",
            change_type=MembershipChangeType.ADD,
            effective_date=date(2026, 1, 15),
        )

        assert change.symbol == "AAPL"
        assert change.change_type == MembershipChangeType.ADD

    def test_get_symbols_base(self, universe: UniverseRev) -> None:
        """Test get_symbols on base date with no changes."""
        universe.base_symbols = {"AAPL", "MSFT", "GOOG"}
        symbols = universe.get_symbols(date(2026, 1, 1))
        assert symbols == {"AAPL", "GOOG", "MSFT"}

    def test_get_symbols_static(self) -> None:
        """Test get_symbols returns base_symbols for static universes."""
        from quantlab.data.universe import UniverseType
        universe = UniverseRev(
            name="Test Static",
            universe_type=UniverseType.STATIC,
            base_date=date(2026, 1, 1),
            base_symbols={"AAPL", "MSFT"},
        )
        # Static universes always return base_symbols
        assert universe.get_symbols(date(2026, 2, 1)) == {"AAPL", "MSFT"}
        assert universe.get_symbols() == {"AAPL", "MSFT"}

    def test_contains(self) -> None:
        """Test contains method."""
        from quantlab.data.universe import UniverseType
        universe = UniverseRev(
            name="Test Static",
            universe_type=UniverseType.STATIC,
            base_symbols={"AAPL", "MSFT"},
        )
        assert universe.contains("AAPL") is True
        assert universe.contains("GOOG") is False

    def test_add_change_appends(self, universe: UniverseRev) -> None:
        """Test add_change appends to list."""
        universe.add_change(MembershipChange(
            symbol="C",
            change_type=MembershipChangeType.ADD,
            effective_date=date(2026, 6, 1),
        ))
        universe.add_change(MembershipChange(
            symbol="A",
            change_type=MembershipChangeType.ADD,
            effective_date=date(2026, 2, 1),
        ))
        universe.add_change(MembershipChange(
            symbol="B",
            change_type=MembershipChangeType.ADD,
            effective_date=date(2026, 4, 1),
        ))

        # Changes are stored in insertion order
        assert len(universe.changes) == 3
        assert universe.changes[0].symbol == "C"
        assert universe.changes[1].symbol == "A"
        assert universe.changes[2].symbol == "B"

    def test_universe_id_rev_id_alias(self) -> None:
        """Test universe_id and rev_id aliasing."""
        universe = UniverseRev(
            universe_id="test-id",
            name="Test Universe",
        )
        assert universe.universe_id == "test-id"
        assert universe.rev_id == "test-id"

        universe2 = UniverseRev(
            rev_id="rev-id",
            name="Test Universe 2",
        )
        assert universe2.universe_id == "rev-id"
        assert universe2.rev_id == "rev-id"


class TestDataSource:
    """Tests for DataSource enum."""

    def test_file_source(self) -> None:
        """FILE source should have value 'file'."""
        assert DataSource.FILE.value == "file"

    def test_database_source(self) -> None:
        """DATABASE source should have value 'database'."""
        assert DataSource.DATABASE.value == "database"

    def test_api_source(self) -> None:
        """API source should have value 'api'."""
        assert DataSource.API.value == "api"

    def test_generated_source(self) -> None:
        """GENERATED source should have value 'generated'."""
        assert DataSource.GENERATED.value == "generated"

    def test_cache_source(self) -> None:
        """CACHE source should have value 'cache'."""
        assert DataSource.CACHE.value == "cache"


class TestDataFormat:
    """Tests for DataFormat enum."""

    def test_csv_format(self) -> None:
        """CSV format should have value 'csv'."""
        assert DataFormat.CSV.value == "csv"

    def test_parquet_format(self) -> None:
        """PARQUET format should have value 'parquet'."""
        assert DataFormat.PARQUET.value == "parquet"

    def test_json_format(self) -> None:
        """JSON format should have value 'json'."""
        assert DataFormat.JSON.value == "json"

    def test_feather_format(self) -> None:
        """FEATHER format should have value 'feather'."""
        assert DataFormat.FEATHER.value == "feather"

    def test_hdf5_format(self) -> None:
        """HDF5 format should have value 'hdf5'."""
        assert DataFormat.HDF5.value == "hdf5"

    def test_pickle_format(self) -> None:
        """PICKLE format should have value 'pickle'."""
        assert DataFormat.PICKLE.value == "pickle"

    def test_sqlite_format(self) -> None:
        """SQLITE format should have value 'sqlite'."""
        assert DataFormat.SQLITE.value == "sqlite"


class TestDataSchema:
    """Tests for DataSchema dataclass."""

    def test_create_schema(self) -> None:
        """Should create schema with all fields."""
        schema = DataSchema(
            columns=["a", "b", "c"],
            dtypes={"a": "int64", "b": "float64", "c": "object"},
            primary_key=["a"],
            nullable={"a": False, "b": True, "c": True},
            constraints={"a": {"min": 0}},
        )

        assert schema.columns == ["a", "b", "c"]
        assert schema.dtypes == {"a": "int64", "b": "float64", "c": "object"}
        assert schema.primary_key == ["a"]
        assert schema.nullable == {"a": False, "b": True, "c": True}
        assert schema.constraints == {"a": {"min": 0}}

    def test_default_optional_fields(self) -> None:
        """Optional fields should default to None."""
        schema = DataSchema(
            columns=["a"],
            dtypes={"a": "int64"},
        )

        assert schema.primary_key is None
        assert schema.nullable is None
        assert schema.constraints is None

    def test_to_dict(self) -> None:
        """Should convert schema to dictionary."""
        schema = DataSchema(
            columns=["a", "b"],
            dtypes={"a": "int64", "b": "object"},
            primary_key=["a"],
        )

        d = schema.to_dict()

        assert d["columns"] == ["a", "b"]
        assert d["dtypes"] == {"a": "int64", "b": "object"}
        assert d["primary_key"] == ["a"]
        assert d["nullable"] is None
        assert d["constraints"] is None

    def test_from_dict(self) -> None:
        """Should create schema from dictionary."""
        data = {
            "columns": ["x", "y"],
            "dtypes": {"x": "float64", "y": "bool"},
            "primary_key": ["x"],
            "nullable": {"x": False},
            "constraints": {"x": {"max": 100}},
        }

        schema = DataSchema.from_dict(data)

        assert schema.columns == ["x", "y"]
        assert schema.dtypes == {"x": "float64", "y": "bool"}
        assert schema.primary_key == ["x"]
        assert schema.nullable == {"x": False}
        assert schema.constraints == {"x": {"max": 100}}

    def test_from_dict_minimal(self) -> None:
        """Should create schema from minimal dictionary."""
        data = {
            "columns": ["a"],
            "dtypes": {"a": "int64"},
        }

        schema = DataSchema.from_dict(data)

        assert schema.columns == ["a"]
        assert schema.dtypes == {"a": "int64"}
        assert schema.primary_key is None

    def test_from_dataframe(self) -> None:
        """Should create schema from pandas DataFrame."""
        df = pd.DataFrame({
            "a": [1, 2, 3],
            "b": [1.0, 2.0, 3.0],
            "c": ["x", "y", "z"],
        })

        schema = DataSchema.from_dataframe(df)

        assert schema.columns == ["a", "b", "c"]
        assert "int" in schema.dtypes["a"].lower()
        assert "float" in schema.dtypes["b"].lower()

    def test_round_trip(self) -> None:
        """Should round-trip through dict and back."""
        original = DataSchema(
            columns=["a", "b"],
            dtypes={"a": "int64", "b": "object"},
            primary_key=["a"],
            nullable={"a": False, "b": True},
        )

        restored = DataSchema.from_dict(original.to_dict())

        assert restored.columns == original.columns
        assert restored.dtypes == original.dtypes
        assert restored.primary_key == original.primary_key


class TestDataRevExtended:
    """Extended tests for DataRev dataclass."""

    def test_create_minimal(self) -> None:
        """Should create DataRev with minimal fields."""
        rev = DataRev(
            rev_id="rev-001",
            name="test_data",
            source=DataSource.FILE,
        )

        assert rev.rev_id == "rev-001"
        assert rev.name == "test_data"
        assert rev.source == DataSource.FILE
        assert rev.format == DataFormat.CSV
        assert rev.row_count == 0
        assert rev.tags == []
        assert rev.metadata == {}

    def test_create_full(self) -> None:
        """Should create DataRev with all fields."""
        now = datetime.now()
        schema = DataSchema(columns=["a"], dtypes={"a": "int64"})
        hash_result = HashResult(
            algorithm="sha256",
            hash_value="abc123",
            byte_count=100,
        )

        rev = DataRev(
            rev_id="rev-002",
            name="full_data",
            source=DataSource.DATABASE,
            source_path="/path/to/data",
            source_query="SELECT * FROM table",
            format=DataFormat.PARQUET,
            schema=schema,
            row_count=1000,
            column_count=5,
            byte_size=50000,
            start_date=now - timedelta(days=30),
            end_date=now,
            as_of_date=now,
            full_hash=hash_result,
            created_at=now,
            created_by="test_user",
            description="Test data revision",
            tags=["test", "sample"],
            metadata={"version": "1.0"},
            parent_rev="rev-001",
            derived_from=["rev-000"],
        )

        assert rev.source == DataSource.DATABASE
        assert rev.source_path == "/path/to/data"
        assert rev.format == DataFormat.PARQUET
        assert rev.row_count == 1000
        assert rev.parent_rev == "rev-001"

    def test_to_dict(self) -> None:
        """Should convert DataRev to dictionary."""
        now = datetime.now()
        schema = DataSchema(columns=["a"], dtypes={"a": "int64"})
        hash_result = HashResult(
            algorithm="sha256",
            hash_value="abc123",
            byte_count=100,
        )

        rev = DataRev(
            rev_id="rev-003",
            name="dict_test",
            source=DataSource.API,
            schema=schema,
            full_hash=hash_result,
            created_at=now,
            start_date=now - timedelta(days=7),
            end_date=now,
        )

        d = rev.to_dict()

        assert d["rev_id"] == "rev-003"
        assert d["name"] == "dict_test"
        assert d["source"] == "api"
        assert d["schema"]["columns"] == ["a"]
        assert d["full_hash"]["hash"] == "abc123"

    def test_to_dict_minimal(self) -> None:
        """Should convert minimal DataRev to dictionary."""
        rev = DataRev(
            rev_id="rev-004",
            name="minimal",
            source=DataSource.FILE,
        )

        d = rev.to_dict()

        assert d["rev_id"] == "rev-004"
        assert d["source_path"] is None
        assert d["schema"] is None
        assert d["full_hash"] is None
        assert d["start_date"] is None

    def test_from_dict(self) -> None:
        """Should create DataRev from dictionary."""
        now = datetime.now()
        data = {
            "rev_id": "rev-005",
            "name": "from_dict_test",
            "source": "file",
            "source_path": "/data/test.csv",
            "format": "csv",
            "schema": {
                "columns": ["a", "b"],
                "dtypes": {"a": "int64", "b": "object"},
            },
            "row_count": 500,
            "column_count": 2,
            "byte_size": 10000,
            "start_date": (now - timedelta(days=10)).isoformat(),
            "end_date": now.isoformat(),
            "full_hash": {
                "algorithm": "sha256",
                "hash": "def456",
                "bytes": 10000,
                "rows": 500,
            },
            "created_at": now.isoformat(),
            "created_by": "system",
            "description": "Test revision",
            "tags": ["data", "test"],
            "metadata": {"source": "unit_test"},
            "parent_rev": "rev-004",
            "derived_from": ["rev-003"],
        }

        rev = DataRev.from_dict(data)

        assert rev.rev_id == "rev-005"
        assert rev.source == DataSource.FILE
        assert rev.schema is not None
        assert rev.full_hash is not None
        assert rev.full_hash.hash_value == "def456"

    def test_from_dict_minimal(self) -> None:
        """Should create DataRev from minimal dictionary."""
        now = datetime.now()
        data = {
            "rev_id": "rev-006",
            "name": "minimal",
            "source": "generated",
            "created_at": now.isoformat(),
        }

        rev = DataRev.from_dict(data)

        assert rev.rev_id == "rev-006"
        assert rev.source == DataSource.GENERATED
        assert rev.format == DataFormat.CSV
        assert rev.schema is None
        assert rev.full_hash is None

    def test_from_dict_with_sampled_hash(self) -> None:
        """Should create DataRev with sampled hash from dictionary."""
        now = datetime.now()
        data = {
            "rev_id": "rev-007",
            "name": "sampled",
            "source": "file",
            "created_at": now.isoformat(),
            "sampled_hash": {
                "algorithm": "sha256",
                "hash": "sampled123",
                "bytes": 5000,
                "rows": 100,
                "sampled": True,
                "sample_rate": 0.1,
            },
        }

        rev = DataRev.from_dict(data)

        assert rev.sampled_hash is not None
        assert rev.sampled_hash.hash_value == "sampled123"
        assert rev.sampled_hash.is_sampled is True
        assert rev.sampled_hash.sample_rate == 0.1

    def test_verify_matching_hash(self, tmp_path: Path) -> None:
        """Should verify file with matching hash."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")

        hasher = ContentHasher()
        hash_result = hasher.hash_file(test_file)

        rev = DataRev(
            rev_id="rev-008",
            name="verify_test",
            source=DataSource.FILE,
            full_hash=hash_result,
        )

        assert rev.verify(test_file) is True

    def test_verify_different_hash(self, tmp_path: Path) -> None:
        """Should fail verification with different content."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")

        rev = DataRev(
            rev_id="rev-009",
            name="verify_test",
            source=DataSource.FILE,
            full_hash=HashResult(
                algorithm="sha256",
                hash_value="wrong_hash",
                byte_count=100,
            ),
        )

        assert rev.verify(test_file) is False

    def test_verify_no_hash(self, tmp_path: Path) -> None:
        """Should fail verification when no hash stored."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")

        rev = DataRev(
            rev_id="rev-010",
            name="no_hash",
            source=DataSource.FILE,
            full_hash=None,
        )

        assert rev.verify(test_file) is False

    def test_verify_string_path(self, tmp_path: Path) -> None:
        """Should verify with string path."""
        test_file = tmp_path / "test.txt"
        test_file.write_text("Test content")

        hasher = ContentHasher()
        hash_result = hasher.hash_file(test_file)

        rev = DataRev(
            rev_id="rev-011",
            name="string_path",
            source=DataSource.FILE,
            full_hash=hash_result,
        )

        assert rev.verify(str(test_file)) is True


class TestDataRevBuilder:
    """Tests for DataRevBuilder class."""

    def test_generate_rev_id(self) -> None:
        """Should generate unique revision IDs."""
        builder = DataRevBuilder()

        id1 = builder._generate_rev_id()
        id2 = builder._generate_rev_id()

        assert id1.startswith("rev-")
        assert id2.startswith("rev-")
        assert id1 != id2
        assert id1.endswith("-0001")
        assert id2.endswith("-0002")

    def test_from_file_csv(self, tmp_path: Path) -> None:
        """Should create DataRev from CSV file."""
        test_file = tmp_path / "data.csv"
        test_file.write_text("a,b,c\n1,2,3\n4,5,6")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file)

        assert rev.name == "data.csv"
        assert rev.source == DataSource.FILE
        assert rev.source_path == str(test_file.absolute())
        assert rev.format == DataFormat.CSV
        assert rev.byte_size == test_file.stat().st_size
        assert rev.full_hash is not None

    def test_from_file_parquet(self, tmp_path: Path) -> None:
        """Should detect parquet format."""
        test_file = tmp_path / "data.parquet"
        test_file.write_bytes(b"fake parquet content")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file)

        assert rev.format == DataFormat.PARQUET

    def test_from_file_json(self, tmp_path: Path) -> None:
        """Should detect JSON format."""
        test_file = tmp_path / "data.json"
        test_file.write_text('{"a": 1}')

        builder = DataRevBuilder()
        rev = builder.from_file(test_file)

        assert rev.format == DataFormat.JSON

    def test_from_file_feather(self, tmp_path: Path) -> None:
        """Should detect feather format."""
        test_file = tmp_path / "data.feather"
        test_file.write_bytes(b"fake feather")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file)

        assert rev.format == DataFormat.FEATHER

    def test_from_file_hdf5(self, tmp_path: Path) -> None:
        """Should detect HDF5 format."""
        test_file = tmp_path / "data.h5"
        test_file.write_bytes(b"fake hdf5")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file)

        assert rev.format == DataFormat.HDF5

    def test_from_file_hdf5_alt(self, tmp_path: Path) -> None:
        """Should detect HDF5 with .hdf5 extension."""
        test_file = tmp_path / "data.hdf5"
        test_file.write_bytes(b"fake hdf5")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file)

        assert rev.format == DataFormat.HDF5

    def test_from_file_pickle(self, tmp_path: Path) -> None:
        """Should detect pickle format."""
        test_file = tmp_path / "data.pkl"
        test_file.write_bytes(b"fake pickle")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file)

        assert rev.format == DataFormat.PICKLE

    def test_from_file_pickle_alt(self, tmp_path: Path) -> None:
        """Should detect pickle with .pickle extension."""
        test_file = tmp_path / "data.pickle"
        test_file.write_bytes(b"fake pickle")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file)

        assert rev.format == DataFormat.PICKLE

    def test_from_file_sqlite(self, tmp_path: Path) -> None:
        """Should detect SQLite format."""
        test_file = tmp_path / "data.db"
        test_file.write_bytes(b"fake sqlite")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file)

        assert rev.format == DataFormat.SQLITE

    def test_from_file_sqlite_alt(self, tmp_path: Path) -> None:
        """Should detect SQLite with .sqlite extension."""
        test_file = tmp_path / "data.sqlite"
        test_file.write_bytes(b"fake sqlite")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file)

        assert rev.format == DataFormat.SQLITE

    def test_from_file_unknown_extension(self, tmp_path: Path) -> None:
        """Should default to CSV for unknown extension."""
        test_file = tmp_path / "data.xyz"
        test_file.write_text("unknown format")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file)

        assert rev.format == DataFormat.CSV

    def test_from_file_custom_name(self, tmp_path: Path) -> None:
        """Should use custom name when provided."""
        test_file = tmp_path / "data.csv"
        test_file.write_text("a,b\n1,2")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file, name="custom_name")

        assert rev.name == "custom_name"

    def test_from_file_no_full_hash(self, tmp_path: Path) -> None:
        """Should skip full hash when requested."""
        test_file = tmp_path / "data.csv"
        test_file.write_text("a,b\n1,2")

        builder = DataRevBuilder()
        rev = builder.from_file(test_file, compute_full_hash=False)

        assert rev.full_hash is None

    def test_from_file_string_path(self, tmp_path: Path) -> None:
        """Should accept string path."""
        test_file = tmp_path / "data.csv"
        test_file.write_text("a,b\n1,2")

        builder = DataRevBuilder()
        rev = builder.from_file(str(test_file))

        assert rev.source_path == str(test_file.absolute())

    def test_from_dataframe(self) -> None:
        """Should create DataRev from DataFrame."""
        df = pd.DataFrame({
            "a": [1, 2, 3],
            "b": [4.0, 5.0, 6.0],
        })

        builder = DataRevBuilder()
        rev = builder.from_dataframe(df, "test_df")

        assert rev.name == "test_df"
        assert rev.source == DataSource.GENERATED
        assert rev.schema is not None
        assert rev.schema.columns == ["a", "b"]
        assert rev.row_count == 3
        assert rev.column_count == 2
        assert rev.sampled_hash is not None

    def test_from_dataframe_custom_source(self) -> None:
        """Should use custom source for DataFrame."""
        df = pd.DataFrame({"a": [1, 2, 3]})

        builder = DataRevBuilder()
        rev = builder.from_dataframe(df, "api_data", source=DataSource.API)

        assert rev.source == DataSource.API

    def test_from_dataframe_no_sampled_hash(self) -> None:
        """Should skip sampled hash when requested."""
        df = pd.DataFrame({"a": [1, 2, 3]})

        builder = DataRevBuilder()
        rev = builder.from_dataframe(df, "no_hash", compute_sampled_hash=False)

        assert rev.sampled_hash is None

    def test_from_dataframe_with_date_column(self) -> None:
        """Should detect date range from date column."""
        df = pd.DataFrame({
            "date": pd.date_range("2023-01-01", periods=10),
            "value": range(10),
        })

        builder = DataRevBuilder()
        rev = builder.from_dataframe(df, "dated_df")

        assert rev.start_date is not None
        assert rev.end_date is not None

    def test_from_dataframe_with_timestamp_column(self) -> None:
        """Should detect date range from timestamp column."""
        df = pd.DataFrame({
            "timestamp": pd.date_range("2023-06-01", periods=5, freq="h"),
            "value": range(5),
        })

        builder = DataRevBuilder()
        rev = builder.from_dataframe(df, "timestamped_df")

        assert rev.start_date is not None
        assert rev.end_date is not None

    def test_from_dataframe_with_datetime_column(self) -> None:
        """Should detect date range from datetime column."""
        df = pd.DataFrame({
            "datetime": pd.date_range("2023-03-15", periods=3),
            "value": [1, 2, 3],
        })

        builder = DataRevBuilder()
        rev = builder.from_dataframe(df, "datetime_df")

        assert rev.start_date is not None

    def test_from_dataframe_with_time_column(self) -> None:
        """Should detect date range from time column."""
        df = pd.DataFrame({
            "time": pd.date_range("2023-12-01", periods=2),
            "value": [10, 20],
        })

        builder = DataRevBuilder()
        rev = builder.from_dataframe(df, "time_df")

        assert rev.start_date is not None

    def test_from_dataframe_no_date_column(self) -> None:
        """Should handle DataFrame without date columns."""
        df = pd.DataFrame({
            "x": [1, 2, 3],
            "y": ["a", "b", "c"],
        })

        builder = DataRevBuilder()
        rev = builder.from_dataframe(df, "no_date_df")

        assert rev.start_date is None
        assert rev.end_date is None

    def test_from_dataframe_invalid_date_column(self) -> None:
        """Should handle non-date values in date column gracefully."""
        df = pd.DataFrame({
            "date": ["not", "a", "date"],
            "value": [1, 2, 3],
        })

        builder = DataRevBuilder()
        rev = builder.from_dataframe(df, "invalid_date")

        assert rev.row_count == 3


class TestDataRevStore:
    """Tests for DataRevStore class."""

    def test_init_creates_directory(self, tmp_path: Path) -> None:
        """Should create store directory if it doesn't exist."""
        store_path = tmp_path / "new_store"
        assert not store_path.exists()

        store = DataRevStore(store_path)

        assert store_path.exists()
        assert store.store_path == store_path

    def test_init_uses_existing_directory(self, tmp_path: Path) -> None:
        """Should use existing store directory."""
        store_path = tmp_path / "existing_store"
        store_path.mkdir()

        store = DataRevStore(store_path)

        assert store.store_path == store_path

    def test_save_and_load(self, tmp_path: Path) -> None:
        """Should save and load DataRev."""
        store = DataRevStore(tmp_path / "store")

        rev = DataRev(
            rev_id="rev-save-001",
            name="save_test",
            source=DataSource.FILE,
        )

        store.save(rev)
        loaded = store.load("rev-save-001")

        assert loaded is not None
        assert loaded.rev_id == "rev-save-001"
        assert loaded.name == "save_test"

    def test_load_nonexistent(self, tmp_path: Path) -> None:
        """Should return None for nonexistent revision."""
        store = DataRevStore(tmp_path / "store")

        loaded = store.load("nonexistent-rev")

        assert loaded is None

    def test_load_missing_file(self, tmp_path: Path) -> None:
        """Should return None if file is in index but missing."""
        store = DataRevStore(tmp_path / "store")

        store._index["fake-rev"] = "fake-rev.json"
        store._save_index()

        loaded = store.load("fake-rev")

        assert loaded is None

    def test_list_revisions_empty(self, tmp_path: Path) -> None:
        """Should return empty list for empty store."""
        store = DataRevStore(tmp_path / "store")

        revisions = store.list_revisions()

        assert revisions == []

    def test_list_revisions(self, tmp_path: Path) -> None:
        """Should list all revision IDs."""
        store = DataRevStore(tmp_path / "store")

        rev1 = DataRev(rev_id="rev-list-001", name="data1", source=DataSource.FILE)
        rev2 = DataRev(rev_id="rev-list-002", name="data2", source=DataSource.API)
        rev3 = DataRev(rev_id="rev-list-003", name="data3", source=DataSource.GENERATED)

        store.save(rev1)
        store.save(rev2)
        store.save(rev3)

        revisions = store.list_revisions()

        assert len(revisions) == 3
        assert "rev-list-001" in revisions
        assert "rev-list-002" in revisions
        assert "rev-list-003" in revisions

    def test_list_revisions_with_filter(self, tmp_path: Path) -> None:
        """Should filter revisions by name prefix."""
        store = DataRevStore(tmp_path / "store")

        store.save(DataRev(rev_id="rev-f1", name="prices_daily", source=DataSource.FILE))
        store.save(DataRev(rev_id="rev-f2", name="prices_hourly", source=DataSource.FILE))
        store.save(DataRev(rev_id="rev-f3", name="volumes_daily", source=DataSource.FILE))

        filtered = store.list_revisions(name_filter="prices")

        assert len(filtered) == 2
        assert "rev-f1" in filtered
        assert "rev-f2" in filtered
        assert "rev-f3" not in filtered

    def test_list_revisions_filter_no_match(self, tmp_path: Path) -> None:
        """Should return empty list if no revisions match filter."""
        store = DataRevStore(tmp_path / "store")

        store.save(DataRev(rev_id="rev-nm1", name="data1", source=DataSource.FILE))

        filtered = store.list_revisions(name_filter="nonexistent")

        assert filtered == []

    def test_get_latest_no_match(self, tmp_path: Path) -> None:
        """Should return None when no revisions match name."""
        store = DataRevStore(tmp_path / "store")

        store.save(DataRev(rev_id="rev-nl1", name="other_data", source=DataSource.FILE))

        latest = store.get_latest("nonexistent_data")

        assert latest is None

    def test_get_latest_single(self, tmp_path: Path) -> None:
        """Should return single revision when only one matches."""
        store = DataRevStore(tmp_path / "store")

        rev = DataRev(rev_id="rev-gl1", name="unique_data", source=DataSource.FILE)
        store.save(rev)

        latest = store.get_latest("unique_data")

        assert latest is not None
        assert latest.rev_id == "rev-gl1"

    def test_get_latest_multiple(self, tmp_path: Path) -> None:
        """Should return most recent revision by created_at."""
        store = DataRevStore(tmp_path / "store")

        now = datetime.now()

        old_rev = DataRev(
            rev_id="rev-old",
            name="multi_data",
            source=DataSource.FILE,
            created_at=now - timedelta(hours=2),
        )
        store.save(old_rev)

        new_rev = DataRev(
            rev_id="rev-new",
            name="multi_data",
            source=DataSource.FILE,
            created_at=now,
        )
        store.save(new_rev)

        mid_rev = DataRev(
            rev_id="rev-mid",
            name="multi_data",
            source=DataSource.FILE,
            created_at=now - timedelta(hours=1),
        )
        store.save(mid_rev)

        latest = store.get_latest("multi_data")

        assert latest is not None
        assert latest.rev_id == "rev-new"

    def test_index_persistence(self, tmp_path: Path) -> None:
        """Should persist index across store instances."""
        store_path = tmp_path / "persistent_store"

        store1 = DataRevStore(store_path)
        store1.save(DataRev(rev_id="rev-persist", name="test", source=DataSource.FILE))

        store2 = DataRevStore(store_path)
        loaded = store2.load("rev-persist")

        assert loaded is not None
        assert loaded.name == "test"

    def test_string_path(self, tmp_path: Path) -> None:
        """Should accept string path."""
        store_path = str(tmp_path / "string_store")

        store = DataRevStore(store_path)

        assert store.store_path == Path(store_path)


class TestMembershipChangeType:
    """Tests for MembershipChangeType enum."""

    def test_add_type(self) -> None:
        """ADD type should have value 'added'."""
        assert MembershipChangeType.ADD.value == "added"

    def test_remove_type(self) -> None:
        """REMOVE type should have value 'removed'."""
        assert MembershipChangeType.REMOVE.value == "removed"

    def test_added_type(self) -> None:
        """ADDED type should have value 'added'."""
        assert MembershipChangeType.ADDED.value == "added"

    def test_removed_type(self) -> None:
        """REMOVED type should have value 'removed'."""
        assert MembershipChangeType.REMOVED.value == "removed"

    def test_renamed_type(self) -> None:
        """RENAMED type should have value 'renamed'."""
        assert MembershipChangeType.RENAMED.value == "renamed"

    def test_merged_type(self) -> None:
        """MERGED type should have value 'merged'."""
        assert MembershipChangeType.MERGED.value == "merged"

    def test_spinoff_type(self) -> None:
        """SPINOFF type should have value 'spinoff'."""
        assert MembershipChangeType.SPINOFF.value == "spinoff"

    def test_delisted_type(self) -> None:
        """DELISTED type should have value 'delisted'."""
        assert MembershipChangeType.DELISTED.value == "delisted"


class TestMembershipChangeExtended:
    """Extended tests for MembershipChange dataclass."""

    def test_default_fields(self) -> None:
        """Optional fields should default correctly."""
        change = MembershipChange(
            symbol="MSFT",
            change_type=MembershipChangeType.REMOVE,
            effective_date=date(2023, 12, 31),
        )

        assert change.reason == ""
        assert change.metadata == {}

    def test_create_with_all_fields(self) -> None:
        """Should create with all fields."""
        change = MembershipChange(
            symbol="AAPL",
            change_type=MembershipChangeType.ADD,
            effective_date=date(2023, 6, 1),
            reason="IPO",
            metadata={"sector": "Tech"},
        )

        assert change.symbol == "AAPL"
        assert change.reason == "IPO"
        assert change.metadata == {"sector": "Tech"}

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        change = MembershipChange(
            symbol="AAPL",
            change_type=MembershipChangeType.ADD,
            effective_date=date(2023, 6, 1),
            reason="Added to index",
        )

        d = change.to_dict()

        assert d["symbol"] == "AAPL"
        assert d["change_type"] == "added"
        assert d["date"] == "2023-06-01"

    def test_from_dict(self) -> None:
        """Should create from dictionary."""
        data = {
            "symbol": "MSFT",
            "change_type": "removed",
            "date": "2023-12-01",
            "reason": "Delisted",
        }

        change = MembershipChange.from_dict(data)

        assert change.symbol == "MSFT"
        assert change.change_type == MembershipChangeType.REMOVED
        assert change.effective_date == date(2023, 12, 1)


class TestUniverseType:
    """Tests for UniverseType enum."""

    def test_static_type(self) -> None:
        """STATIC type should have value 'static'."""
        assert UniverseType.STATIC.value == "static"

    def test_dynamic_type(self) -> None:
        """DYNAMIC type should have value 'dynamic'."""
        assert UniverseType.DYNAMIC.value == "dynamic"

    def test_index_type(self) -> None:
        """INDEX type should have value 'index'."""
        assert UniverseType.INDEX.value == "index"

    def test_custom_type(self) -> None:
        """CUSTOM type should have value 'custom'."""
        assert UniverseType.CUSTOM.value == "custom"


class TestUniverseSnapshot:
    """Tests for UniverseSnapshot dataclass."""

    def test_create_snapshot(self) -> None:
        """Should create snapshot."""
        snapshot = UniverseSnapshot(
            date=date(2023, 6, 1),
            symbols=frozenset(["AAPL", "MSFT", "GOOG"]),
            hash_value="abc123",
        )

        assert snapshot.date == date(2023, 6, 1)
        assert snapshot.symbols == frozenset(["AAPL", "MSFT", "GOOG"])
        assert snapshot.hash_value == "abc123"

    def test_contains(self) -> None:
        """Should check if symbol is in snapshot."""
        snapshot = UniverseSnapshot(
            date=date(2023, 6, 1),
            symbols=frozenset(["AAPL", "MSFT"]),
            hash_value="abc",
        )

        assert "AAPL" in snapshot
        assert "GOOG" not in snapshot

    def test_len(self) -> None:
        """Should return number of symbols."""
        snapshot = UniverseSnapshot(
            date=date(2023, 6, 1),
            symbols=frozenset(["AAPL", "MSFT", "GOOG"]),
            hash_value="abc",
        )

        assert len(snapshot) == 3

    def test_iter(self) -> None:
        """Should iterate symbols in sorted order."""
        snapshot = UniverseSnapshot(
            date=date(2023, 6, 1),
            symbols=frozenset(["MSFT", "AAPL", "GOOG"]),
            hash_value="abc",
        )

        symbols = list(snapshot)
        assert symbols == ["AAPL", "GOOG", "MSFT"]

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        snapshot = UniverseSnapshot(
            date=date(2023, 6, 1),
            symbols=frozenset(["MSFT", "AAPL"]),
            hash_value="xyz123",
        )

        d = snapshot.to_dict()

        assert d["date"] == "2023-06-01"
        assert d["symbols"] == ["AAPL", "MSFT"]  # sorted
        assert d["hash"] == "xyz123"


class TestUniverseRevExtended:
    """Extended tests for UniverseRev class."""

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        universe = UniverseRev(
            rev_id="univ-001",
            name="Test Universe",
            description="A test universe",
            universe_type=UniverseType.STATIC,
            base_symbols={"AAPL", "MSFT"},
            tags=["test"],
            metadata={"version": 1},
        )

        d = universe.to_dict()

        assert d["rev_id"] == "univ-001"
        assert d["name"] == "Test Universe"
        assert d["description"] == "A test universe"
        assert d["universe_type"] == "static"
        assert sorted(d["base_symbols"]) == ["AAPL", "MSFT"]

    def test_from_dict(self) -> None:
        """Should create from dictionary."""
        now = datetime.now()
        data = {
            "rev_id": "univ-002",
            "name": "From Dict Universe",
            "description": "Created from dict",
            "universe_type": "dynamic",
            "base_symbols": ["GOOG", "AMZN"],
            "changes": [],
            "index_symbol": None,
            "start_date": "2023-01-01",
            "end_date": "2023-12-31",
            "created_at": now.isoformat(),
            "created_by": "test",
            "tags": ["imported"],
            "metadata": {"source": "test"},
        }

        universe = UniverseRev.from_dict(data)

        assert universe.rev_id == "univ-002"
        assert universe.name == "From Dict Universe"
        assert universe.universe_type == UniverseType.DYNAMIC
        assert universe.base_symbols == {"GOOG", "AMZN"}
        assert universe.start_date == date(2023, 1, 1)

    def test_get_snapshot(self) -> None:
        """Should get cached snapshot."""
        universe = UniverseRev(
            name="Test",
            universe_type=UniverseType.STATIC,
            base_symbols={"AAPL", "MSFT"},
        )

        snapshot = universe.get_snapshot(date(2023, 6, 1))

        assert snapshot.date == date(2023, 6, 1)
        assert snapshot.symbols == frozenset({"AAPL", "MSFT"})
        assert len(snapshot.hash_value) > 0

        # Cached snapshot should be same object
        snapshot2 = universe.get_snapshot(date(2023, 6, 1))
        assert snapshot is snapshot2


class TestUniverseBuilder:
    """Tests for UniverseBuilder class."""

    def test_generate_rev_id(self) -> None:
        """Should generate unique revision IDs."""
        builder = UniverseBuilder()

        id1 = builder._generate_rev_id()
        id2 = builder._generate_rev_id()

        assert id1.startswith("univ-")
        assert id2.startswith("univ-")
        assert id1 != id2
        assert id1.endswith("-0001")
        assert id2.endswith("-0002")

    def test_static(self) -> None:
        """Should create static universe."""
        builder = UniverseBuilder()

        universe = builder.static(
            name="My Static",
            symbols=["AAPL", "MSFT", "GOOG"],
            description="A static universe",
        )

        assert universe.name == "My Static"
        assert universe.universe_type == UniverseType.STATIC
        assert universe.base_symbols == {"AAPL", "MSFT", "GOOG"}
        assert universe.description == "A static universe"

    def test_dynamic(self) -> None:
        """Should create dynamic universe."""
        builder = UniverseBuilder()

        universe = builder.dynamic(
            name="My Dynamic",
            initial_symbols=["AAPL"],
            start_date=date(2023, 1, 1),
            description="A dynamic universe",
        )

        assert universe.name == "My Dynamic"
        assert universe.universe_type == UniverseType.DYNAMIC
        assert universe.base_symbols == {"AAPL"}
        assert universe.start_date == date(2023, 1, 1)

    def test_index_based(self) -> None:
        """Should create index-based universe."""
        builder = UniverseBuilder()

        universe = builder.index_based(
            name="SP500",
            index_symbol="SPY",
            components=["AAPL", "MSFT"],
            as_of_date=date(2023, 6, 1),
            description="S&P 500 components",
        )

        assert universe.name == "SP500"
        assert universe.universe_type == UniverseType.INDEX
        assert universe.index_symbol == "SPY"
        assert universe.base_symbols == {"AAPL", "MSFT"}
        assert universe.start_date == date(2023, 6, 1)


class TestUniverseStore:
    """Tests for UniverseStore class."""

    def test_init_creates_directory(self, tmp_path: Path) -> None:
        """Should create store directory."""
        store_path = tmp_path / "new_store"
        assert not store_path.exists()

        store = UniverseStore(store_path)

        assert store_path.exists()
        assert store.store_path == store_path

    def test_save_and_load(self, tmp_path: Path) -> None:
        """Should save and load universe."""
        store = UniverseStore(tmp_path / "store")

        universe = UniverseRev(
            rev_id="univ-001",
            name="Test Universe",
            universe_type=UniverseType.STATIC,
            base_symbols={"AAPL", "MSFT"},
        )

        store.save(universe)
        loaded = store.load("univ-001")

        assert loaded is not None
        assert loaded.rev_id == "univ-001"
        assert loaded.name == "Test Universe"
        assert loaded.base_symbols == {"AAPL", "MSFT"}

    def test_load_nonexistent(self, tmp_path: Path) -> None:
        """Should return None for nonexistent universe."""
        store = UniverseStore(tmp_path / "store")

        loaded = store.load("nonexistent")

        assert loaded is None

    def test_load_missing_file(self, tmp_path: Path) -> None:
        """Should return None if file is in index but missing."""
        store = UniverseStore(tmp_path / "store")

        store._index["fake-univ"] = "fake-univ.json"
        store._save_index()

        loaded = store.load("fake-univ")

        assert loaded is None

    def test_get_by_name(self, tmp_path: Path) -> None:
        """Should get latest universe by name."""
        store = UniverseStore(tmp_path / "store")

        now = datetime.now()

        old_univ = UniverseRev(
            rev_id="univ-old",
            name="MyUniverse",
            base_symbols={"AAPL"},
            created_at=now - timedelta(hours=1),
        )
        store.save(old_univ)

        new_univ = UniverseRev(
            rev_id="univ-new",
            name="MyUniverse",
            base_symbols={"AAPL", "MSFT"},
            created_at=now,
        )
        store.save(new_univ)

        latest = store.get_by_name("MyUniverse")

        assert latest is not None
        assert latest.rev_id == "univ-new"

    def test_get_by_name_not_found(self, tmp_path: Path) -> None:
        """Should return None if name not found."""
        store = UniverseStore(tmp_path / "store")

        store.save(UniverseRev(
            rev_id="univ-1",
            name="OtherUniverse",
            base_symbols={"GOOG"},
        ))

        result = store.get_by_name("NonexistentUniverse")

        assert result is None

    def test_list_universes(self, tmp_path: Path) -> None:
        """Should list all universe names."""
        store = UniverseStore(tmp_path / "store")

        store.save(UniverseRev(rev_id="u1", name="Universe1", base_symbols=set()))
        store.save(UniverseRev(rev_id="u2", name="Universe2", base_symbols=set()))
        store.save(UniverseRev(rev_id="u3", name="Universe1", base_symbols=set()))  # duplicate name

        names = store.list_universes()

        assert sorted(names) == ["Universe1", "Universe2"]

    def test_list_universes_empty(self, tmp_path: Path) -> None:
        """Should return empty list for empty store."""
        store = UniverseStore(tmp_path / "store")

        names = store.list_universes()

        assert names == []


class TestPredefinedUniverses:
    """Tests for PredefinedUniverses factory."""

    def test_sp500(self) -> None:
        """Should create S&P 500 universe."""
        universe = PredefinedUniverses.sp500()

        assert universe.name == "SP500"
        assert universe.index_symbol == "SPY"
        assert universe.universe_type == UniverseType.INDEX
        assert universe.description == "S&P 500 Index Components"

    def test_nasdaq100(self) -> None:
        """Should create NASDAQ 100 universe."""
        universe = PredefinedUniverses.nasdaq100()

        assert universe.name == "NDX100"
        assert universe.index_symbol == "QQQ"
        assert universe.universe_type == UniverseType.INDEX
        assert universe.description == "NASDAQ 100 Index Components"

    def test_russell2000(self) -> None:
        """Should create Russell 2000 universe."""
        universe = PredefinedUniverses.russell2000()

        assert universe.name == "RTY2000"
        assert universe.index_symbol == "IWM"
        assert universe.universe_type == UniverseType.INDEX
        assert universe.description == "Russell 2000 Index Components"

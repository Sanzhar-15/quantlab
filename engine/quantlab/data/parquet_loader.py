"""
Parquet Data Loader (FIX-E001).

Provides efficient loading of market data from Parquet files using PyArrow.

Parquet is a columnar storage format that offers:
- Efficient compression
- Column pruning (read only needed columns)
- Predicate pushdown (filter at storage level)
- Fast random access via row groups

Spec Reference: Technical Spec §6.2
"""

import logging
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from typing import Iterator

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
    HAS_PYARROW = True
except ImportError:
    HAS_PYARROW = False

from quantlab.providers.base import Bar


logger = logging.getLogger(__name__)


class ParquetLoaderError(Exception):
    """Error loading Parquet data."""

    pass


class ParquetLoader:
    """
    Load market data from Parquet files.

    Supports:
    - Single file or directory of files
    - Column mapping for different schemas
    - Date filtering with predicate pushdown
    - Lazy loading via iterator

    Usage:
        loader = ParquetLoader("data/SPY.parquet")
        bars = loader.load_bars(
            symbol="SPY",
            start=datetime(2023, 1, 1),
            end=datetime(2023, 12, 31),
        )
    """

    # Default column mappings
    DEFAULT_COLUMN_MAP = {
        "timestamp": ["timestamp", "date", "datetime", "time", "Date", "DateTime"],
        "open": ["open", "Open", "o", "OPEN"],
        "high": ["high", "High", "h", "HIGH"],
        "low": ["low", "Low", "l", "LOW"],
        "close": ["close", "Close", "c", "CLOSE", "adj_close", "Adj Close"],
        "volume": ["volume", "Volume", "v", "VOLUME", "vol"],
    }

    def __init__(
        self,
        path: Path | str,
        column_map: dict[str, list[str]] | None = None,
    ) -> None:
        """
        Initialize Parquet loader.

        Args:
            path: Path to Parquet file or directory
            column_map: Optional custom column name mappings

        Raises:
            ParquetLoaderError: If PyArrow is not installed
        """
        if not HAS_PYARROW:
            raise ParquetLoaderError(
                "PyArrow is required for Parquet support. "
                "Install with: pip install pyarrow"
            )

        self._path = Path(path)
        self._column_map = column_map or self.DEFAULT_COLUMN_MAP
        self._schema: pa.Schema | None = None
        self._resolved_columns: dict[str, str] = {}

    @property
    def path(self) -> Path:
        """Path to data source."""
        return self._path

    @property
    def schema(self) -> "pa.Schema | None":
        """Parquet schema (loaded on first access)."""
        if self._schema is None and self._path.exists():
            self._load_schema()
        return self._schema

    def _load_schema(self) -> None:
        """Load schema from Parquet file."""
        if self._path.is_file():
            pf = pq.ParquetFile(self._path)
            self._schema = pf.schema_arrow
        elif self._path.is_dir():
            # Load from first file in directory
            files = list(self._path.glob("*.parquet"))
            if files:
                pf = pq.ParquetFile(files[0])
                self._schema = pf.schema_arrow

        if self._schema:
            self._resolve_columns()

    def _resolve_columns(self) -> None:
        """Resolve column names from schema using mappings."""
        if not self._schema:
            return

        schema_names = set(self._schema.names)

        for target, candidates in self._column_map.items():
            for candidate in candidates:
                if candidate in schema_names:
                    self._resolved_columns[target] = candidate
                    break

        logger.debug(f"Resolved columns: {self._resolved_columns}")

    def load_bars(
        self,
        symbol: str,
        start: datetime | None = None,
        end: datetime | None = None,
        timeframe: str = "1d",
        columns: list[str] | None = None,
    ) -> list[Bar]:
        """
        Load bars from Parquet file.

        Args:
            symbol: Symbol for the bars
            start: Start datetime (inclusive)
            end: End datetime (inclusive)
            timeframe: Timeframe for bars
            columns: Optional list of columns to load

        Returns:
            List of Bar objects

        Raises:
            ParquetLoaderError: If file doesn't exist or is invalid
        """
        if not self._path.exists():
            raise ParquetLoaderError(f"Path does not exist: {self._path}")

        # Ensure schema is loaded
        if self._schema is None:
            self._load_schema()

        # Build column list
        needed_cols = columns or ["timestamp", "open", "high", "low", "close", "volume"]
        parquet_cols = [
            self._resolved_columns.get(col, col)
            for col in needed_cols
            if col in self._resolved_columns or col in (self._schema.names if self._schema else [])
        ]

        # Build filters for predicate pushdown
        filters = self._build_filters(start, end)

        # Read data
        if self._path.is_file():
            table = pq.read_table(
                self._path,
                columns=parquet_cols if parquet_cols else None,
                filters=filters,
            )
        else:
            table = pq.read_table(
                self._path,
                columns=parquet_cols if parquet_cols else None,
                filters=filters,
            )

        return self._table_to_bars(table, symbol, timeframe)

    def _build_filters(
        self,
        start: datetime | None,
        end: datetime | None,
    ) -> list[tuple] | None:
        """Build PyArrow filters for predicate pushdown."""
        if start is None and end is None:
            return None

        ts_col = self._resolved_columns.get("timestamp", "timestamp")
        filters = []

        if start is not None:
            filters.append((ts_col, ">=", start))
        if end is not None:
            filters.append((ts_col, "<=", end))

        return filters if filters else None

    def _table_to_bars(
        self,
        table: "pa.Table",
        symbol: str,
        timeframe: str,
    ) -> list[Bar]:
        """Convert PyArrow table to list of Bar objects."""
        bars = []

        # Get column data
        ts_col = self._resolved_columns.get("timestamp", "timestamp")
        open_col = self._resolved_columns.get("open", "open")
        high_col = self._resolved_columns.get("high", "high")
        low_col = self._resolved_columns.get("low", "low")
        close_col = self._resolved_columns.get("close", "close")
        volume_col = self._resolved_columns.get("volume", "volume")

        # Convert to Python
        timestamps = table.column(ts_col).to_pylist() if ts_col in table.column_names else []
        opens = table.column(open_col).to_pylist() if open_col in table.column_names else []
        highs = table.column(high_col).to_pylist() if high_col in table.column_names else []
        lows = table.column(low_col).to_pylist() if low_col in table.column_names else []
        closes = table.column(close_col).to_pylist() if close_col in table.column_names else []
        volumes = table.column(volume_col).to_pylist() if volume_col in table.column_names else []

        for i in range(len(timestamps)):
            # Parse timestamp
            ts = timestamps[i]
            if isinstance(ts, str):
                ts = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            elif hasattr(ts, "to_pydatetime"):
                ts = ts.to_pydatetime()

            bar = Bar(
                symbol=symbol,
                timestamp=ts,
                open=Decimal(str(opens[i])) if i < len(opens) else Decimal("0"),
                high=Decimal(str(highs[i])) if i < len(highs) else Decimal("0"),
                low=Decimal(str(lows[i])) if i < len(lows) else Decimal("0"),
                close=Decimal(str(closes[i])) if i < len(closes) else Decimal("0"),
                volume=int(volumes[i]) if i < len(volumes) else 0,
                timeframe=timeframe,
                source="parquet",
            )
            bars.append(bar)

        return bars

    def iter_bars(
        self,
        symbol: str,
        start: datetime | None = None,
        end: datetime | None = None,
        timeframe: str = "1d",
        batch_size: int = 10000,
    ) -> Iterator[Bar]:
        """
        Iterate over bars lazily using row groups.

        More memory-efficient for large files.

        Args:
            symbol: Symbol for the bars
            start: Start datetime
            end: End datetime
            timeframe: Timeframe for bars
            batch_size: Number of rows per batch

        Yields:
            Bar objects
        """
        if not self._path.exists():
            raise ParquetLoaderError(f"Path does not exist: {self._path}")

        if self._schema is None:
            self._load_schema()

        pf = pq.ParquetFile(self._path)

        for batch in pf.iter_batches(batch_size=batch_size):
            table = pa.Table.from_batches([batch])
            bars = self._table_to_bars(table, symbol, timeframe)

            for bar in bars:
                # Apply date filters
                if start is not None and bar.timestamp < start:
                    continue
                if end is not None and bar.timestamp > end:
                    continue
                yield bar

    def get_metadata(self) -> dict[str, Any]:
        """Get Parquet file metadata."""
        if not self._path.exists():
            return {"error": "File not found"}

        pf = pq.ParquetFile(self._path)
        metadata = pf.metadata

        return {
            "path": str(self._path),
            "num_rows": metadata.num_rows,
            "num_row_groups": metadata.num_row_groups,
            "num_columns": metadata.num_columns,
            "created_by": metadata.created_by,
            "format_version": str(metadata.format_version),
            "schema": [
                {"name": field.name, "type": str(field.type)}
                for field in pf.schema_arrow
            ],
            "resolved_columns": self._resolved_columns,
        }

    def get_date_range(self) -> tuple[datetime | None, datetime | None]:
        """Get the date range in the file."""
        if not self._path.exists():
            return None, None

        if self._schema is None:
            self._load_schema()

        ts_col = self._resolved_columns.get("timestamp", "timestamp")

        # Read min/max from statistics if available
        pf = pq.ParquetFile(self._path)

        min_ts = None
        max_ts = None

        for i in range(pf.metadata.num_row_groups):
            rg = pf.metadata.row_group(i)
            for j in range(rg.num_columns):
                col = rg.column(j)
                if col.path_in_schema == ts_col and col.statistics:
                    if col.statistics.has_min_max:
                        rg_min = col.statistics.min
                        rg_max = col.statistics.max
                        if min_ts is None or rg_min < min_ts:
                            min_ts = rg_min
                        if max_ts is None or rg_max > max_ts:
                            max_ts = rg_max

        return min_ts, max_ts


def load_parquet_bars(
    path: Path | str,
    symbol: str,
    start: datetime | None = None,
    end: datetime | None = None,
    timeframe: str = "1d",
) -> list[Bar]:
    """
    Convenience function to load bars from Parquet.

    Args:
        path: Path to Parquet file
        symbol: Symbol for bars
        start: Start datetime
        end: End datetime
        timeframe: Timeframe

    Returns:
        List of Bar objects
    """
    loader = ParquetLoader(path)
    return loader.load_bars(symbol, start, end, timeframe)

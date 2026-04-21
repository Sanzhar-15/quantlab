"""
Debug File Format using Apache Arrow IPC.

Provides efficient storage and random access for time-travel debugging.

File Structure:
    - Header (metadata)
    - Bars Table (OHLCV data)
    - States Table (portfolio state per bar)
    - Signals Table (signals generated)
    - Fills Table (order fills)
    - Conditions Table (decision point evaluations)
    - Index (byte offsets for random access)

Spec Reference: Technical Spec Section 19, Decision A6
"""

import json
import logging
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from datetime import timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

try:
    import pyarrow as pa
    import pyarrow.ipc as ipc

    HAS_ARROW = True
except ImportError:
    HAS_ARROW = False
    pa = None
    ipc = None


logger = logging.getLogger(__name__)


# Schema version for format compatibility
SCHEMA_VERSION = "1.0"


@dataclass
class DebugMetadata:
    """Metadata for a debug file."""

    schema_version: str = SCHEMA_VERSION
    strategy_path: str = ""
    strategy_hash: str = ""
    data_rev_id: str = ""
    bar_count: int = 0
    symbol: str = ""
    symbols: list[str] = field(default_factory=list)
    timeframe: str = ""
    start_date: str = ""
    end_date: str = ""
    created_at: str = ""
    engine_version: str = "1.0.0"
    initial_cash: str = "100000"
    fill_assumption: str = "next_open"

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "schema_version": self.schema_version,
            "strategy_path": self.strategy_path,
            "strategy_hash": self.strategy_hash,
            "data_rev_id": self.data_rev_id,
            "bar_count": self.bar_count,
            "symbol": self.symbol,
            "symbols": self.symbols,
            "timeframe": self.timeframe,
            "start_date": self.start_date,
            "end_date": self.end_date,
            "created_at": self.created_at,
            "engine_version": self.engine_version,
            "initial_cash": self.initial_cash,
            "fill_assumption": self.fill_assumption,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "DebugMetadata":
        """Create from dictionary."""
        return cls(
            schema_version=data.get("schema_version", SCHEMA_VERSION),
            strategy_path=data.get("strategy_path", ""),
            strategy_hash=data.get("strategy_hash", ""),
            data_rev_id=data.get("data_rev_id", ""),
            bar_count=data.get("bar_count", 0),
            symbol=data.get("symbol", ""),
            symbols=data.get("symbols", []),
            timeframe=data.get("timeframe", ""),
            start_date=data.get("start_date", ""),
            end_date=data.get("end_date", ""),
            created_at=data.get("created_at", ""),
            engine_version=data.get("engine_version", "1.0.0"),
            initial_cash=data.get("initial_cash", "100000"),
            fill_assumption=data.get("fill_assumption", "next_open"),
        )


@dataclass
class BarState:
    """State snapshot at a specific bar."""

    bar_index: int
    timestamp: datetime
    cash: Decimal
    equity: Decimal
    positions: dict[str, Decimal]  # symbol -> quantity
    pending_orders: int
    unrealized_pnl: Decimal
    realized_pnl: Decimal
    gross_exposure: Decimal


@dataclass
class ConditionCapture:
    """Captured condition evaluation at a decision point."""

    bar_index: int
    line_number: int
    expression: str
    left_value: str
    operator: str
    right_value: str
    result: bool
    context: dict[str, str] = field(default_factory=dict)


def _check_arrow() -> None:
    """Check if PyArrow is available."""
    if not HAS_ARROW:
        raise ImportError(
            "PyArrow is required for debug file format. "
            "Install with: pip install pyarrow"
        )


# Arrow schemas for each table
def get_bars_schema() -> "pa.Schema":
    """Get Arrow schema for bars table."""
    _check_arrow()
    return pa.schema([
        ("bar_index", pa.int32()),
        ("timestamp", pa.timestamp("us")),
        ("symbol", pa.string()),
        ("open", pa.string()),  # Decimal as string for precision
        ("high", pa.string()),
        ("low", pa.string()),
        ("close", pa.string()),
        ("volume", pa.int64()),
    ])


def get_states_schema() -> "pa.Schema":
    """Get Arrow schema for states table."""
    _check_arrow()
    return pa.schema([
        ("bar_index", pa.int32()),
        ("timestamp", pa.timestamp("us")),
        ("cash", pa.string()),
        ("equity", pa.string()),
        ("positions_json", pa.string()),  # JSON-encoded positions
        ("pending_orders", pa.int32()),
        ("unrealized_pnl", pa.string()),
        ("realized_pnl", pa.string()),
        ("gross_exposure", pa.string()),
    ])


def get_signals_schema() -> "pa.Schema":
    """Get Arrow schema for signals table."""
    _check_arrow()
    return pa.schema([
        ("bar_index", pa.int32()),
        ("signal_id", pa.string()),
        ("symbol", pa.string()),
        ("side", pa.string()),
        ("quantity", pa.string()),
        ("order_type", pa.string()),
        ("limit_price", pa.string()),
        ("stop_price", pa.string()),
    ])


def get_fills_schema() -> "pa.Schema":
    """Get Arrow schema for fills table."""
    _check_arrow()
    return pa.schema([
        ("bar_index", pa.int32()),
        ("fill_id", pa.string()),
        ("order_id", pa.string()),
        ("symbol", pa.string()),
        ("side", pa.string()),
        ("quantity", pa.string()),
        ("price", pa.string()),
        ("commission", pa.string()),
        ("timestamp", pa.timestamp("us")),
    ])


def get_conditions_schema() -> "pa.Schema":
    """Get Arrow schema for conditions table."""
    _check_arrow()
    return pa.schema([
        ("bar_index", pa.int32()),
        ("line_number", pa.int32()),
        ("expression", pa.string()),
        ("left_value", pa.string()),
        ("operator", pa.string()),
        ("right_value", pa.string()),
        ("result", pa.bool_()),
        ("context_json", pa.string()),
    ])


class DebugFileWriter:
    """
    Writer for debug files in Arrow IPC format.

    Usage:
        with DebugFileWriter(path, metadata) as writer:
            writer.write_bar(bar_data)
            writer.write_state(state)
            writer.write_signal(signal)
            writer.write_fill(fill)
            writer.write_condition(condition)
    """

    def __init__(self, path: Path, metadata: DebugMetadata) -> None:
        """
        Initialize debug file writer.

        Args:
            path: Output file path
            metadata: Debug file metadata
        """
        _check_arrow()
        self._path = Path(path)
        self._metadata = metadata
        self._metadata.created_at = datetime.now(timezone.utc).isoformat()

        # Buffers for batch writing
        self._bars: list[dict[str, Any]] = []
        self._states: list[dict[str, Any]] = []
        self._signals: list[dict[str, Any]] = []
        self._fills: list[dict[str, Any]] = []
        self._conditions: list[dict[str, Any]] = []

        self._closed = False

    def __enter__(self) -> "DebugFileWriter":
        """Context manager entry."""
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        """Context manager exit."""
        self.close()

    def write_bar(
        self,
        bar_index: int,
        timestamp: datetime,
        symbol: str,
        open_price: Decimal,
        high: Decimal,
        low: Decimal,
        close: Decimal,
        volume: int,
    ) -> None:
        """Write a bar record."""
        self._bars.append({
            "bar_index": bar_index,
            "timestamp": timestamp,
            "symbol": symbol,
            "open": str(open_price),
            "high": str(high),
            "low": str(low),
            "close": str(close),
            "volume": volume,
        })

    def write_state(self, state: BarState) -> None:
        """Write a state snapshot."""
        self._states.append({
            "bar_index": state.bar_index,
            "timestamp": state.timestamp,
            "cash": str(state.cash),
            "equity": str(state.equity),
            "positions_json": json.dumps({k: str(v) for k, v in state.positions.items()}),
            "pending_orders": state.pending_orders,
            "unrealized_pnl": str(state.unrealized_pnl),
            "realized_pnl": str(state.realized_pnl),
            "gross_exposure": str(state.gross_exposure),
        })

    def write_signal(
        self,
        bar_index: int,
        signal_id: str,
        symbol: str,
        side: str,
        quantity: Decimal,
        order_type: str,
        limit_price: Decimal | None = None,
        stop_price: Decimal | None = None,
    ) -> None:
        """Write a signal record."""
        self._signals.append({
            "bar_index": bar_index,
            "signal_id": signal_id,
            "symbol": symbol,
            "side": side,
            "quantity": str(quantity),
            "order_type": order_type,
            "limit_price": str(limit_price) if limit_price else "",
            "stop_price": str(stop_price) if stop_price else "",
        })

    def write_fill(
        self,
        bar_index: int,
        fill_id: str,
        order_id: str,
        symbol: str,
        side: str,
        quantity: Decimal,
        price: Decimal,
        commission: Decimal,
        timestamp: datetime,
    ) -> None:
        """Write a fill record."""
        self._fills.append({
            "bar_index": bar_index,
            "fill_id": fill_id,
            "order_id": order_id,
            "symbol": symbol,
            "side": side,
            "quantity": str(quantity),
            "price": str(price),
            "commission": str(commission),
            "timestamp": timestamp,
        })

    def write_condition(self, condition: ConditionCapture) -> None:
        """Write a condition capture."""
        self._conditions.append({
            "bar_index": condition.bar_index,
            "line_number": condition.line_number,
            "expression": condition.expression,
            "left_value": condition.left_value,
            "operator": condition.operator,
            "right_value": condition.right_value,
            "result": condition.result,
            "context_json": json.dumps(condition.context),
        })

    def close(self) -> None:
        """Finalize and write the debug file."""
        if self._closed:
            return

        self._closed = True
        self._metadata.bar_count = len(self._bars)

        # Create parent directory
        self._path.parent.mkdir(parents=True, exist_ok=True)

        # Write Arrow IPC file with multiple record batches
        with pa.OSFile(str(self._path), "wb") as sink:
            # Custom metadata including our debug metadata
            custom_metadata = {
                b"quantlab_debug": json.dumps(self._metadata.to_dict()).encode(),
            }

            # Create schema with metadata
            schema = pa.schema([
                ("table_type", pa.string()),
                ("data", pa.binary()),
            ], metadata=custom_metadata)

            writer = ipc.new_file(sink, schema)

            # Write each table as a separate record batch
            self._write_table(writer, "bars", get_bars_schema(), self._bars)
            self._write_table(writer, "states", get_states_schema(), self._states)
            self._write_table(writer, "signals", get_signals_schema(), self._signals)
            self._write_table(writer, "fills", get_fills_schema(), self._fills)
            self._write_table(writer, "conditions", get_conditions_schema(), self._conditions)

            writer.close()

        logger.info(f"Debug file written: {self._path} ({self._metadata.bar_count} bars)")

    def _write_table(
        self,
        writer: Any,
        table_name: str,
        schema: "pa.Schema",
        records: list[dict[str, Any]],
    ) -> None:
        """Write a table to the IPC file."""
        if not records:
            return

        # Convert to Arrow table
        table = pa.Table.from_pylist(records, schema=schema)

        # Serialize to bytes
        sink = pa.BufferOutputStream()
        batch_writer = ipc.new_stream(sink, schema)
        batch_writer.write_table(table)
        batch_writer.close()
        data = sink.getvalue().to_pybytes()

        # Write as a record in the main file
        batch = pa.record_batch(
            [pa.array([table_name]), pa.array([data])],
            names=["table_type", "data"],
        )
        writer.write_batch(batch)


class DebugFileReader:
    """
    Reader for debug files in Arrow IPC format.

    Supports random access to any bar's state.

    Usage:
        reader = DebugFileReader(path)
        state = reader.get_state(bar_index=100)
        conditions = reader.get_conditions(bar_index=100)
    """

    def __init__(self, path: Path) -> None:
        """
        Initialize debug file reader.

        Args:
            path: Path to debug file
        """
        _check_arrow()
        self._path = Path(path)

        if not self._path.exists():
            raise FileNotFoundError(f"Debug file not found: {path}")

        # Load metadata and tables
        self._metadata: DebugMetadata | None = None
        self._bars: pa.Table | None = None
        self._states: pa.Table | None = None
        self._signals: pa.Table | None = None
        self._fills: pa.Table | None = None
        self._conditions: pa.Table | None = None

        self._load()

    def _load(self) -> None:
        """Load the debug file."""
        with pa.OSFile(str(self._path), "rb") as source:
            reader = ipc.open_file(source)

            # Extract metadata
            schema_metadata = reader.schema.metadata
            if schema_metadata and b"quantlab_debug" in schema_metadata:
                meta_json = schema_metadata[b"quantlab_debug"].decode()
                self._metadata = DebugMetadata.from_dict(json.loads(meta_json))

            # Load each table
            for i in range(reader.num_record_batches):
                batch = reader.get_batch(i)
                table_type = batch.column("table_type")[0].as_py()
                data = batch.column("data")[0].as_py()

                # Deserialize the nested table
                buf = pa.py_buffer(data)
                nested_reader = ipc.open_stream(buf)
                table = nested_reader.read_all()

                if table_type == "bars":
                    self._bars = table
                elif table_type == "states":
                    self._states = table
                elif table_type == "signals":
                    self._signals = table
                elif table_type == "fills":
                    self._fills = table
                elif table_type == "conditions":
                    self._conditions = table

    @property
    def metadata(self) -> DebugMetadata:
        """Get debug file metadata."""
        return self._metadata or DebugMetadata()

    @property
    def bar_count(self) -> int:
        """Get total number of bars."""
        return self._metadata.bar_count if self._metadata else 0

    def get_state(self, bar_index: int) -> BarState | None:
        """
        Get portfolio state at a specific bar.

        Args:
            bar_index: Bar index

        Returns:
            BarState or None if not found
        """
        if self._states is None:
            return None

        # Filter by bar_index
        mask = pa.compute.equal(self._states.column("bar_index"), bar_index)
        filtered = self._states.filter(mask)

        if filtered.num_rows == 0:
            return None

        row = filtered.to_pydict()
        positions = json.loads(row["positions_json"][0])

        return BarState(
            bar_index=row["bar_index"][0],
            timestamp=row["timestamp"][0],
            cash=Decimal(row["cash"][0]),
            equity=Decimal(row["equity"][0]),
            positions={k: Decimal(v) for k, v in positions.items()},
            pending_orders=row["pending_orders"][0],
            unrealized_pnl=Decimal(row["unrealized_pnl"][0]),
            realized_pnl=Decimal(row["realized_pnl"][0]),
            gross_exposure=Decimal(row["gross_exposure"][0]),
        )

    def get_conditions(self, bar_index: int) -> list[ConditionCapture]:
        """
        Get captured conditions at a specific bar.

        Args:
            bar_index: Bar index

        Returns:
            List of condition captures
        """
        if self._conditions is None:
            return []

        mask = pa.compute.equal(self._conditions.column("bar_index"), bar_index)
        filtered = self._conditions.filter(mask)

        conditions = []
        for i in range(filtered.num_rows):
            row = {col: filtered.column(col)[i].as_py() for col in filtered.column_names}
            conditions.append(ConditionCapture(
                bar_index=row["bar_index"],
                line_number=row["line_number"],
                expression=row["expression"],
                left_value=row["left_value"],
                operator=row["operator"],
                right_value=row["right_value"],
                result=row["result"],
                context=json.loads(row["context_json"]) if row["context_json"] else {},
            ))

        return conditions

    def get_signals(self, bar_index: int) -> list[dict[str, Any]]:
        """Get signals generated at a specific bar."""
        if self._signals is None:
            return []

        mask = pa.compute.equal(self._signals.column("bar_index"), bar_index)
        filtered = self._signals.filter(mask)

        return filtered.to_pylist()

    def get_fills(self, bar_index: int) -> list[dict[str, Any]]:
        """Get fills at a specific bar."""
        if self._fills is None:
            return []

        mask = pa.compute.equal(self._fills.column("bar_index"), bar_index)
        filtered = self._fills.filter(mask)

        return filtered.to_pylist()

    def get_bar(self, bar_index: int, symbol: str | None = None) -> dict[str, Any] | None:
        """Get bar data at a specific index."""
        if self._bars is None:
            return None

        mask = pa.compute.equal(self._bars.column("bar_index"), bar_index)
        if symbol:
            symbol_mask = pa.compute.equal(self._bars.column("symbol"), symbol)
            mask = pa.compute.and_(mask, symbol_mask)

        filtered = self._bars.filter(mask)

        if filtered.num_rows == 0:
            return None

        return {col: filtered.column(col)[0].as_py() for col in filtered.column_names}

    def get_trade_bar_indices(self) -> list[int]:
        """Get bar indices where trades (fills) occurred."""
        if self._fills is None:
            return []

        indices = self._fills.column("bar_index").to_pylist()
        return sorted(set(indices))

    def get_all_states(self) -> list[BarState]:
        """Get all portfolio states."""
        if self._states is None:
            return []

        states = []
        for i in range(self._states.num_rows):
            row = {col: self._states.column(col)[i].as_py() for col in self._states.column_names}
            positions = json.loads(row["positions_json"])

            states.append(BarState(
                bar_index=row["bar_index"],
                timestamp=row["timestamp"] if row["timestamp"] else datetime.now(),
                cash=Decimal(row["cash"]),
                equity=Decimal(row["equity"]),
                positions={k: Decimal(v) for k, v in positions.items()},
                pending_orders=row["pending_orders"],
                unrealized_pnl=Decimal(row["unrealized_pnl"]),
                realized_pnl=Decimal(row["realized_pnl"]),
                gross_exposure=Decimal(row["gross_exposure"]),
            ))

        return states

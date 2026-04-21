"""
Tests for debug file format module.
"""

from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest

from quantlab.debug.format import (
    SCHEMA_VERSION,
    BarState,
    ConditionCapture,
    DebugMetadata,
    get_bars_schema,
    get_conditions_schema,
    get_fills_schema,
    get_signals_schema,
    get_states_schema,
)


class TestDebugMetadata:
    """Tests for DebugMetadata dataclass."""

    def test_default_values(self) -> None:
        """Should have correct default values."""
        metadata = DebugMetadata()

        assert metadata.schema_version == SCHEMA_VERSION
        assert metadata.strategy_path == ""
        assert metadata.strategy_hash == ""
        assert metadata.data_rev_id == ""
        assert metadata.bar_count == 0
        assert metadata.symbol == ""
        assert metadata.symbols == []
        assert metadata.timeframe == ""
        assert metadata.start_date == ""
        assert metadata.end_date == ""
        assert metadata.created_at == ""
        assert metadata.engine_version == "1.0.0"
        assert metadata.initial_cash == "100000"
        assert metadata.fill_assumption == "next_open"

    def test_custom_values(self) -> None:
        """Should accept custom values."""
        metadata = DebugMetadata(
            strategy_path="/path/to/strategy.py",
            strategy_hash="abc123",
            data_rev_id="rev-001",
            bar_count=1000,
            symbol="AAPL",
            symbols=["AAPL", "MSFT"],
            timeframe="1D",
            start_date="2023-01-01",
            end_date="2023-12-31",
            created_at="2023-06-15T10:00:00",
            engine_version="2.0.0",
            initial_cash="50000",
            fill_assumption="next_close",
        )

        assert metadata.strategy_path == "/path/to/strategy.py"
        assert metadata.strategy_hash == "abc123"
        assert metadata.data_rev_id == "rev-001"
        assert metadata.bar_count == 1000
        assert metadata.symbol == "AAPL"
        assert metadata.symbols == ["AAPL", "MSFT"]
        assert metadata.timeframe == "1D"
        assert metadata.start_date == "2023-01-01"
        assert metadata.end_date == "2023-12-31"
        assert metadata.engine_version == "2.0.0"
        assert metadata.initial_cash == "50000"
        assert metadata.fill_assumption == "next_close"

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        metadata = DebugMetadata(
            strategy_path="/path/to/strategy.py",
            bar_count=500,
            symbol="GOOG",
            symbols=["GOOG"],
        )

        d = metadata.to_dict()

        assert d["schema_version"] == SCHEMA_VERSION
        assert d["strategy_path"] == "/path/to/strategy.py"
        assert d["bar_count"] == 500
        assert d["symbol"] == "GOOG"
        assert d["symbols"] == ["GOOG"]
        assert d["engine_version"] == "1.0.0"

    def test_from_dict(self) -> None:
        """Should create from dictionary."""
        data = {
            "schema_version": "1.0",
            "strategy_path": "/strategies/momentum.py",
            "strategy_hash": "xyz789",
            "data_rev_id": "rev-002",
            "bar_count": 2000,
            "symbol": "TSLA",
            "symbols": ["TSLA", "AMZN"],
            "timeframe": "1H",
            "start_date": "2023-06-01",
            "end_date": "2023-06-30",
            "created_at": "2023-07-01T00:00:00",
            "engine_version": "1.5.0",
            "initial_cash": "200000",
            "fill_assumption": "this_close",
        }

        metadata = DebugMetadata.from_dict(data)

        assert metadata.schema_version == "1.0"
        assert metadata.strategy_path == "/strategies/momentum.py"
        assert metadata.strategy_hash == "xyz789"
        assert metadata.data_rev_id == "rev-002"
        assert metadata.bar_count == 2000
        assert metadata.symbol == "TSLA"
        assert metadata.symbols == ["TSLA", "AMZN"]
        assert metadata.timeframe == "1H"
        assert metadata.engine_version == "1.5.0"
        assert metadata.initial_cash == "200000"
        assert metadata.fill_assumption == "this_close"

    def test_from_dict_minimal(self) -> None:
        """Should create from minimal dictionary with defaults."""
        data = {}

        metadata = DebugMetadata.from_dict(data)

        assert metadata.schema_version == SCHEMA_VERSION
        assert metadata.strategy_path == ""
        assert metadata.bar_count == 0
        assert metadata.symbols == []
        assert metadata.engine_version == "1.0.0"
        assert metadata.initial_cash == "100000"
        assert metadata.fill_assumption == "next_open"

    def test_round_trip(self) -> None:
        """Should round-trip through dict and back."""
        original = DebugMetadata(
            strategy_path="/test/path.py",
            strategy_hash="hash123",
            bar_count=100,
            symbol="AAPL",
            symbols=["AAPL"],
            timeframe="5m",
        )

        restored = DebugMetadata.from_dict(original.to_dict())

        assert restored.strategy_path == original.strategy_path
        assert restored.strategy_hash == original.strategy_hash
        assert restored.bar_count == original.bar_count
        assert restored.symbol == original.symbol
        assert restored.symbols == original.symbols
        assert restored.timeframe == original.timeframe


class TestBarState:
    """Tests for BarState dataclass."""

    def test_create_bar_state(self) -> None:
        """Should create bar state snapshot."""
        now = datetime.now()
        state = BarState(
            bar_index=10,
            timestamp=now,
            cash=Decimal("100000"),
            equity=Decimal("105000"),
            positions={"AAPL": Decimal("100"), "MSFT": Decimal("-50")},
            pending_orders=2,
            unrealized_pnl=Decimal("5000"),
            realized_pnl=Decimal("2000"),
            gross_exposure=Decimal("20000"),
        )

        assert state.bar_index == 10
        assert state.timestamp == now
        assert state.cash == Decimal("100000")
        assert state.equity == Decimal("105000")
        assert state.positions == {"AAPL": Decimal("100"), "MSFT": Decimal("-50")}
        assert state.pending_orders == 2
        assert state.unrealized_pnl == Decimal("5000")
        assert state.realized_pnl == Decimal("2000")
        assert state.gross_exposure == Decimal("20000")


class TestConditionCapture:
    """Tests for ConditionCapture dataclass."""

    def test_create_condition_capture(self) -> None:
        """Should create condition capture."""
        capture = ConditionCapture(
            bar_index=5,
            line_number=42,
            expression="fast_ma > slow_ma",
            left_value="15.5",
            operator=">",
            right_value="14.2",
            result=True,
            context={"fast_period": "10", "slow_period": "20"},
        )

        assert capture.bar_index == 5
        assert capture.line_number == 42
        assert capture.expression == "fast_ma > slow_ma"
        assert capture.left_value == "15.5"
        assert capture.operator == ">"
        assert capture.right_value == "14.2"
        assert capture.result is True
        assert capture.context == {"fast_period": "10", "slow_period": "20"}

    def test_default_context(self) -> None:
        """Should default context to empty dict."""
        capture = ConditionCapture(
            bar_index=0,
            line_number=10,
            expression="a < b",
            left_value="1",
            operator="<",
            right_value="2",
            result=True,
        )

        assert capture.context == {}


class TestArrowSchemas:
    """Tests for Arrow schema functions."""

    def test_get_bars_schema(self) -> None:
        """Should return valid bars schema."""
        schema = get_bars_schema()

        assert schema is not None
        field_names = [f.name for f in schema]
        assert "bar_index" in field_names
        assert "timestamp" in field_names
        assert "symbol" in field_names
        assert "open" in field_names
        assert "high" in field_names
        assert "low" in field_names
        assert "close" in field_names
        assert "volume" in field_names

    def test_get_states_schema(self) -> None:
        """Should return valid states schema."""
        schema = get_states_schema()

        assert schema is not None
        field_names = [f.name for f in schema]
        assert "bar_index" in field_names
        assert "timestamp" in field_names
        assert "cash" in field_names
        assert "equity" in field_names
        assert "positions_json" in field_names
        assert "pending_orders" in field_names
        assert "unrealized_pnl" in field_names
        assert "realized_pnl" in field_names
        assert "gross_exposure" in field_names

    def test_get_signals_schema(self) -> None:
        """Should return valid signals schema."""
        schema = get_signals_schema()

        assert schema is not None
        field_names = [f.name for f in schema]
        assert "bar_index" in field_names
        assert "signal_id" in field_names
        assert "symbol" in field_names
        assert "side" in field_names
        assert "quantity" in field_names
        assert "order_type" in field_names
        assert "limit_price" in field_names
        assert "stop_price" in field_names

    def test_get_fills_schema(self) -> None:
        """Should return valid fills schema."""
        schema = get_fills_schema()

        assert schema is not None
        field_names = [f.name for f in schema]
        assert "bar_index" in field_names
        assert "fill_id" in field_names
        assert "order_id" in field_names
        assert "symbol" in field_names
        assert "side" in field_names
        assert "quantity" in field_names
        assert "price" in field_names
        assert "commission" in field_names
        assert "timestamp" in field_names

    def test_get_conditions_schema(self) -> None:
        """Should return valid conditions schema."""
        schema = get_conditions_schema()

        assert schema is not None
        field_names = [f.name for f in schema]
        assert "bar_index" in field_names
        assert "line_number" in field_names
        assert "expression" in field_names
        assert "left_value" in field_names
        assert "operator" in field_names
        assert "right_value" in field_names
        assert "result" in field_names
        assert "context_json" in field_names


class TestDebugFileWriterBasic:
    """Basic tests for DebugFileWriter without full file I/O."""

    def test_import(self) -> None:
        """Should be able to import DebugFileWriter."""
        from quantlab.debug.format import DebugFileWriter
        assert DebugFileWriter is not None

    def test_create_writer(self, tmp_path: Path) -> None:
        """Should create a writer instance."""
        from quantlab.debug.format import DebugFileWriter

        metadata = DebugMetadata(
            strategy_path="/test.py",
            bar_count=100,
        )

        writer = DebugFileWriter(tmp_path / "test.arrow", metadata)

        assert writer._path == tmp_path / "test.arrow"
        assert writer._metadata.strategy_path == "/test.py"
        assert writer._closed is False

    def test_write_bar(self, tmp_path: Path) -> None:
        """Should buffer bar records."""
        from quantlab.debug.format import DebugFileWriter

        metadata = DebugMetadata()
        writer = DebugFileWriter(tmp_path / "test.arrow", metadata)

        writer.write_bar(
            bar_index=0,
            timestamp=datetime.now(),
            symbol="AAPL",
            open_price=Decimal("150.00"),
            high=Decimal("152.00"),
            low=Decimal("149.00"),
            close=Decimal("151.00"),
            volume=1000000,
        )

        assert len(writer._bars) == 1
        assert writer._bars[0]["symbol"] == "AAPL"
        assert writer._bars[0]["open"] == "150.00"

    def test_write_state(self, tmp_path: Path) -> None:
        """Should buffer state records."""
        from quantlab.debug.format import DebugFileWriter

        metadata = DebugMetadata()
        writer = DebugFileWriter(tmp_path / "test.arrow", metadata)

        state = BarState(
            bar_index=0,
            timestamp=datetime.now(),
            cash=Decimal("100000"),
            equity=Decimal("100000"),
            positions={},
            pending_orders=0,
            unrealized_pnl=Decimal("0"),
            realized_pnl=Decimal("0"),
            gross_exposure=Decimal("0"),
        )

        writer.write_state(state)

        assert len(writer._states) == 1
        assert writer._states[0]["cash"] == "100000"

    def test_write_signal(self, tmp_path: Path) -> None:
        """Should buffer signal records."""
        from quantlab.debug.format import DebugFileWriter

        metadata = DebugMetadata()
        writer = DebugFileWriter(tmp_path / "test.arrow", metadata)

        writer.write_signal(
            bar_index=5,
            signal_id="sig-001",
            symbol="MSFT",
            side="buy",
            quantity=Decimal("100"),
            order_type="market",
            limit_price=None,
            stop_price=None,
        )

        assert len(writer._signals) == 1
        assert writer._signals[0]["symbol"] == "MSFT"
        assert writer._signals[0]["quantity"] == "100"

    def test_write_signal_with_prices(self, tmp_path: Path) -> None:
        """Should buffer signal with limit and stop prices."""
        from quantlab.debug.format import DebugFileWriter

        metadata = DebugMetadata()
        writer = DebugFileWriter(tmp_path / "test.arrow", metadata)

        writer.write_signal(
            bar_index=5,
            signal_id="sig-002",
            symbol="GOOG",
            side="sell",
            quantity=Decimal("50"),
            order_type="stop_limit",
            limit_price=Decimal("150.00"),
            stop_price=Decimal("145.00"),
        )

        assert writer._signals[0]["limit_price"] == "150.00"
        assert writer._signals[0]["stop_price"] == "145.00"

    def test_write_fill(self, tmp_path: Path) -> None:
        """Should buffer fill records."""
        from quantlab.debug.format import DebugFileWriter

        metadata = DebugMetadata()
        writer = DebugFileWriter(tmp_path / "test.arrow", metadata)

        writer.write_fill(
            bar_index=10,
            fill_id="fill-001",
            order_id="ord-001",
            symbol="AAPL",
            side="buy",
            quantity=Decimal("100"),
            price=Decimal("150.50"),
            commission=Decimal("1.00"),
            timestamp=datetime.now(),
        )

        assert len(writer._fills) == 1
        assert writer._fills[0]["fill_id"] == "fill-001"
        assert writer._fills[0]["price"] == "150.50"

    def test_write_condition(self, tmp_path: Path) -> None:
        """Should buffer condition records."""
        from quantlab.debug.format import DebugFileWriter

        metadata = DebugMetadata()
        writer = DebugFileWriter(tmp_path / "test.arrow", metadata)

        condition = ConditionCapture(
            bar_index=15,
            line_number=25,
            expression="price > target",
            left_value="155.0",
            operator=">",
            right_value="150.0",
            result=True,
        )

        writer.write_condition(condition)

        assert len(writer._conditions) == 1
        assert writer._conditions[0]["expression"] == "price > target"

    def test_context_manager(self, tmp_path: Path) -> None:
        """Should work as context manager."""
        from quantlab.debug.format import DebugFileWriter

        metadata = DebugMetadata()

        with DebugFileWriter(tmp_path / "test.arrow", metadata) as writer:
            writer.write_bar(
                bar_index=0,
                timestamp=datetime.now(),
                symbol="AAPL",
                open_price=Decimal("150.00"),
                high=Decimal("152.00"),
                low=Decimal("149.00"),
                close=Decimal("151.00"),
                volume=1000000,
            )

        assert writer._closed is True


class TestDebugFileWriterClose:
    """Tests for DebugFileWriter close and file creation."""

    def test_close_creates_file(self, tmp_path: Path) -> None:
        """Should create file when closed."""
        from quantlab.debug.format import DebugFileWriter

        metadata = DebugMetadata(strategy_path="/test.py")
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_bar(
                bar_index=0,
                timestamp=datetime.now(),
                symbol="AAPL",
                open_price=Decimal("150.00"),
                high=Decimal("152.00"),
                low=Decimal("149.00"),
                close=Decimal("151.00"),
                volume=1000000,
            )

        assert output_path.exists()

    def test_close_idempotent(self, tmp_path: Path) -> None:
        """Should be safe to call close multiple times."""
        from quantlab.debug.format import DebugFileWriter

        metadata = DebugMetadata()
        writer = DebugFileWriter(tmp_path / "test.arrow", metadata)
        writer.close()
        writer.close()  # Should not raise

        assert writer._closed is True

    def test_close_updates_bar_count(self, tmp_path: Path) -> None:
        """Should update bar count in metadata on close."""
        from quantlab.debug.format import DebugFileWriter

        metadata = DebugMetadata()
        with DebugFileWriter(tmp_path / "test.arrow", metadata) as writer:
            for i in range(5):
                writer.write_bar(
                    bar_index=i,
                    timestamp=datetime.now(),
                    symbol="AAPL",
                    open_price=Decimal("150.00"),
                    high=Decimal("152.00"),
                    low=Decimal("149.00"),
                    close=Decimal("151.00"),
                    volume=1000000,
                )

        assert writer._metadata.bar_count == 5


class TestDebugFileReader:
    """Tests for DebugFileReader class."""

    def test_import(self) -> None:
        """Should be able to import DebugFileReader."""
        from quantlab.debug.format import DebugFileReader
        assert DebugFileReader is not None

    def test_file_not_found(self, tmp_path: Path) -> None:
        """Should raise FileNotFoundError for missing file."""
        from quantlab.debug.format import DebugFileReader

        with pytest.raises(FileNotFoundError):
            DebugFileReader(tmp_path / "nonexistent.arrow")

    def test_read_metadata(self, tmp_path: Path) -> None:
        """Should read metadata from file."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata(
            strategy_path="/test/strategy.py",
            strategy_hash="abc123",
            symbol="AAPL",
            symbols=["AAPL", "MSFT"],
            timeframe="1D",
        )

        output_path = tmp_path / "debug.arrow"
        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_bar(
                bar_index=0,
                timestamp=datetime.now(),
                symbol="AAPL",
                open_price=Decimal("150.00"),
                high=Decimal("152.00"),
                low=Decimal("149.00"),
                close=Decimal("151.00"),
                volume=1000000,
            )

        reader = DebugFileReader(output_path)
        assert reader.metadata.strategy_path == "/test/strategy.py"
        assert reader.metadata.strategy_hash == "abc123"
        assert reader.metadata.symbol == "AAPL"
        assert reader.metadata.symbols == ["AAPL", "MSFT"]
        assert reader.metadata.timeframe == "1D"

    def test_bar_count_property(self, tmp_path: Path) -> None:
        """Should return correct bar count."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            for i in range(10):
                writer.write_bar(
                    bar_index=i,
                    timestamp=datetime.now(),
                    symbol="AAPL",
                    open_price=Decimal("150.00"),
                    high=Decimal("152.00"),
                    low=Decimal("149.00"),
                    close=Decimal("151.00"),
                    volume=1000000,
                )

        reader = DebugFileReader(output_path)
        assert reader.bar_count == 10

    def test_get_state(self, tmp_path: Path) -> None:
        """Should read state at specific bar."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"
        now = datetime.now()

        with DebugFileWriter(output_path, metadata) as writer:
            for i in range(5):
                state = BarState(
                    bar_index=i,
                    timestamp=now,
                    cash=Decimal(str(100000 - i * 1000)),
                    equity=Decimal(str(100000 + i * 500)),
                    positions={"AAPL": Decimal(str(i * 10))},
                    pending_orders=i,
                    unrealized_pnl=Decimal(str(i * 100)),
                    realized_pnl=Decimal(str(i * 50)),
                    gross_exposure=Decimal(str(i * 1000)),
                )
                writer.write_state(state)

        reader = DebugFileReader(output_path)

        state = reader.get_state(2)
        assert state is not None
        assert state.bar_index == 2
        assert state.cash == Decimal("98000")
        assert state.positions == {"AAPL": Decimal("20")}
        assert state.pending_orders == 2

    def test_get_state_not_found(self, tmp_path: Path) -> None:
        """Should return None for nonexistent bar state."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            state = BarState(
                bar_index=0,
                timestamp=datetime.now(),
                cash=Decimal("100000"),
                equity=Decimal("100000"),
                positions={},
                pending_orders=0,
                unrealized_pnl=Decimal("0"),
                realized_pnl=Decimal("0"),
                gross_exposure=Decimal("0"),
            )
            writer.write_state(state)

        reader = DebugFileReader(output_path)
        state = reader.get_state(999)
        assert state is None

    def test_get_conditions(self, tmp_path: Path) -> None:
        """Should read conditions at specific bar."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            for i in range(3):
                condition = ConditionCapture(
                    bar_index=5,
                    line_number=10 + i,
                    expression=f"expr_{i}",
                    left_value=str(i),
                    operator=">",
                    right_value="0",
                    result=True,
                    context={"key": f"value_{i}"},
                )
                writer.write_condition(condition)

            # Condition at different bar
            condition = ConditionCapture(
                bar_index=10,
                line_number=20,
                expression="other_expr",
                left_value="1",
                operator="<",
                right_value="2",
                result=True,
            )
            writer.write_condition(condition)

        reader = DebugFileReader(output_path)
        conditions = reader.get_conditions(5)

        assert len(conditions) == 3
        assert conditions[0].expression == "expr_0"
        assert conditions[1].expression == "expr_1"
        assert conditions[2].expression == "expr_2"
        assert conditions[0].context == {"key": "value_0"}

    def test_get_conditions_empty(self, tmp_path: Path) -> None:
        """Should return empty list for bar with no conditions."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_bar(
                bar_index=0,
                timestamp=datetime.now(),
                symbol="AAPL",
                open_price=Decimal("150.00"),
                high=Decimal("152.00"),
                low=Decimal("149.00"),
                close=Decimal("151.00"),
                volume=1000000,
            )

        reader = DebugFileReader(output_path)
        conditions = reader.get_conditions(0)
        assert conditions == []

    def test_get_signals(self, tmp_path: Path) -> None:
        """Should read signals at specific bar."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_signal(
                bar_index=5,
                signal_id="sig-001",
                symbol="AAPL",
                side="buy",
                quantity=Decimal("100"),
                order_type="market",
            )
            writer.write_signal(
                bar_index=5,
                signal_id="sig-002",
                symbol="MSFT",
                side="sell",
                quantity=Decimal("50"),
                order_type="limit",
                limit_price=Decimal("300.00"),
            )

        reader = DebugFileReader(output_path)
        signals = reader.get_signals(5)

        assert len(signals) == 2
        assert signals[0]["symbol"] == "AAPL"
        assert signals[1]["symbol"] == "MSFT"

    def test_get_signals_empty(self, tmp_path: Path) -> None:
        """Should return empty list for bar with no signals."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_bar(
                bar_index=0,
                timestamp=datetime.now(),
                symbol="AAPL",
                open_price=Decimal("150.00"),
                high=Decimal("152.00"),
                low=Decimal("149.00"),
                close=Decimal("151.00"),
                volume=1000000,
            )

        reader = DebugFileReader(output_path)
        signals = reader.get_signals(0)
        assert signals == []

    def test_get_fills(self, tmp_path: Path) -> None:
        """Should read fills at specific bar."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"
        now = datetime.now()

        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_fill(
                bar_index=10,
                fill_id="fill-001",
                order_id="ord-001",
                symbol="AAPL",
                side="buy",
                quantity=Decimal("100"),
                price=Decimal("150.50"),
                commission=Decimal("1.00"),
                timestamp=now,
            )

        reader = DebugFileReader(output_path)
        fills = reader.get_fills(10)

        assert len(fills) == 1
        assert fills[0]["fill_id"] == "fill-001"
        assert fills[0]["symbol"] == "AAPL"

    def test_get_fills_empty(self, tmp_path: Path) -> None:
        """Should return empty list for bar with no fills."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_bar(
                bar_index=0,
                timestamp=datetime.now(),
                symbol="AAPL",
                open_price=Decimal("150.00"),
                high=Decimal("152.00"),
                low=Decimal("149.00"),
                close=Decimal("151.00"),
                volume=1000000,
            )

        reader = DebugFileReader(output_path)
        fills = reader.get_fills(0)
        assert fills == []

    def test_get_bar(self, tmp_path: Path) -> None:
        """Should read bar data at specific index."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_bar(
                bar_index=5,
                timestamp=datetime.now(),
                symbol="AAPL",
                open_price=Decimal("150.00"),
                high=Decimal("152.00"),
                low=Decimal("149.00"),
                close=Decimal("151.00"),
                volume=1000000,
            )
            writer.write_bar(
                bar_index=5,
                timestamp=datetime.now(),
                symbol="MSFT",
                open_price=Decimal("300.00"),
                high=Decimal("305.00"),
                low=Decimal("298.00"),
                close=Decimal("302.00"),
                volume=500000,
            )

        reader = DebugFileReader(output_path)

        # Get bar without symbol filter
        bar = reader.get_bar(5)
        assert bar is not None
        assert bar["bar_index"] == 5

        # Get bar with symbol filter
        bar = reader.get_bar(5, symbol="MSFT")
        assert bar is not None
        assert bar["symbol"] == "MSFT"
        assert bar["open"] == "300.00"

    def test_get_bar_not_found(self, tmp_path: Path) -> None:
        """Should return None for nonexistent bar."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_bar(
                bar_index=0,
                timestamp=datetime.now(),
                symbol="AAPL",
                open_price=Decimal("150.00"),
                high=Decimal("152.00"),
                low=Decimal("149.00"),
                close=Decimal("151.00"),
                volume=1000000,
            )

        reader = DebugFileReader(output_path)
        bar = reader.get_bar(999)
        assert bar is None

    def test_get_trade_bar_indices(self, tmp_path: Path) -> None:
        """Should return bar indices with trades."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"
        now = datetime.now()

        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_fill(
                bar_index=5,
                fill_id="fill-001",
                order_id="ord-001",
                symbol="AAPL",
                side="buy",
                quantity=Decimal("100"),
                price=Decimal("150.50"),
                commission=Decimal("1.00"),
                timestamp=now,
            )
            writer.write_fill(
                bar_index=10,
                fill_id="fill-002",
                order_id="ord-002",
                symbol="AAPL",
                side="sell",
                quantity=Decimal("100"),
                price=Decimal("155.00"),
                commission=Decimal("1.00"),
                timestamp=now,
            )
            writer.write_fill(
                bar_index=5,
                fill_id="fill-003",
                order_id="ord-003",
                symbol="MSFT",
                side="buy",
                quantity=Decimal("50"),
                price=Decimal("300.00"),
                commission=Decimal("1.00"),
                timestamp=now,
            )

        reader = DebugFileReader(output_path)
        indices = reader.get_trade_bar_indices()

        assert indices == [5, 10]  # Sorted, unique

    def test_get_trade_bar_indices_empty(self, tmp_path: Path) -> None:
        """Should return empty list when no trades."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_bar(
                bar_index=0,
                timestamp=datetime.now(),
                symbol="AAPL",
                open_price=Decimal("150.00"),
                high=Decimal("152.00"),
                low=Decimal("149.00"),
                close=Decimal("151.00"),
                volume=1000000,
            )

        reader = DebugFileReader(output_path)
        indices = reader.get_trade_bar_indices()
        assert indices == []

    def test_get_all_states(self, tmp_path: Path) -> None:
        """Should read all portfolio states."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"
        now = datetime.now()

        with DebugFileWriter(output_path, metadata) as writer:
            for i in range(3):
                state = BarState(
                    bar_index=i,
                    timestamp=now,
                    cash=Decimal(str(100000 - i * 1000)),
                    equity=Decimal(str(100000 + i * 500)),
                    positions={"AAPL": Decimal(str(i * 10))},
                    pending_orders=i,
                    unrealized_pnl=Decimal(str(i * 100)),
                    realized_pnl=Decimal(str(i * 50)),
                    gross_exposure=Decimal(str(i * 1000)),
                )
                writer.write_state(state)

        reader = DebugFileReader(output_path)
        states = reader.get_all_states()

        assert len(states) == 3
        assert states[0].bar_index == 0
        assert states[0].cash == Decimal("100000")
        assert states[1].bar_index == 1
        assert states[1].cash == Decimal("99000")
        assert states[2].bar_index == 2
        assert states[2].cash == Decimal("98000")

    def test_get_all_states_empty(self, tmp_path: Path) -> None:
        """Should return empty list when no states."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata()
        output_path = tmp_path / "debug.arrow"

        with DebugFileWriter(output_path, metadata) as writer:
            writer.write_bar(
                bar_index=0,
                timestamp=datetime.now(),
                symbol="AAPL",
                open_price=Decimal("150.00"),
                high=Decimal("152.00"),
                low=Decimal("149.00"),
                close=Decimal("151.00"),
                volume=1000000,
            )

        reader = DebugFileReader(output_path)
        states = reader.get_all_states()
        assert states == []


class TestWriteReadRoundTrip:
    """Integration tests for complete write/read cycle."""

    def test_full_round_trip(self, tmp_path: Path) -> None:
        """Should round-trip all data types."""
        from quantlab.debug.format import DebugFileReader, DebugFileWriter

        metadata = DebugMetadata(
            strategy_path="/my/strategy.py",
            strategy_hash="hash123",
            symbol="AAPL",
            symbols=["AAPL"],
            timeframe="1D",
        )
        output_path = tmp_path / "full_debug.arrow"
        now = datetime.now()

        # Write
        with DebugFileWriter(output_path, metadata) as writer:
            # Bars
            writer.write_bar(
                bar_index=0,
                timestamp=now,
                symbol="AAPL",
                open_price=Decimal("150.00"),
                high=Decimal("152.00"),
                low=Decimal("149.00"),
                close=Decimal("151.00"),
                volume=1000000,
            )

            # States
            state = BarState(
                bar_index=0,
                timestamp=now,
                cash=Decimal("100000"),
                equity=Decimal("100000"),
                positions={},
                pending_orders=0,
                unrealized_pnl=Decimal("0"),
                realized_pnl=Decimal("0"),
                gross_exposure=Decimal("0"),
            )
            writer.write_state(state)

            # Signals
            writer.write_signal(
                bar_index=0,
                signal_id="sig-001",
                symbol="AAPL",
                side="buy",
                quantity=Decimal("100"),
                order_type="market",
            )

            # Fills
            writer.write_fill(
                bar_index=0,
                fill_id="fill-001",
                order_id="ord-001",
                symbol="AAPL",
                side="buy",
                quantity=Decimal("100"),
                price=Decimal("150.50"),
                commission=Decimal("1.00"),
                timestamp=now,
            )

            # Conditions
            condition = ConditionCapture(
                bar_index=0,
                line_number=42,
                expression="price > threshold",
                left_value="150.50",
                operator=">",
                right_value="150.00",
                result=True,
                context={"threshold": "150.00"},
            )
            writer.write_condition(condition)

        # Read and verify
        reader = DebugFileReader(output_path)

        # Metadata
        assert reader.metadata.strategy_path == "/my/strategy.py"
        assert reader.bar_count == 1

        # Bar
        bar = reader.get_bar(0)
        assert bar is not None
        assert bar["symbol"] == "AAPL"
        assert bar["close"] == "151.00"

        # State
        state = reader.get_state(0)
        assert state is not None
        assert state.cash == Decimal("100000")

        # Signals
        signals = reader.get_signals(0)
        assert len(signals) == 1
        assert signals[0]["signal_id"] == "sig-001"

        # Fills
        fills = reader.get_fills(0)
        assert len(fills) == 1
        assert fills[0]["fill_id"] == "fill-001"

        # Conditions
        conditions = reader.get_conditions(0)
        assert len(conditions) == 1
        assert conditions[0].expression == "price > threshold"
        assert conditions[0].context == {"threshold": "150.00"}

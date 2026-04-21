"""
Tests for debug file index module.
"""

from pathlib import Path

import pytest

from quantlab.debug.index import (
    BarIndex,
    DebugIndex,
    DebugIndexBuilder,
    load_index,
    save_index,
)


class TestBarIndex:
    """Tests for BarIndex dataclass."""

    def test_default_values(self) -> None:
        """Should have correct default values."""
        entry = BarIndex(bar_index=0)

        assert entry.bar_index == 0
        assert entry.has_state is False
        assert entry.has_signals is False
        assert entry.has_fills is False
        assert entry.has_conditions is False
        assert entry.signal_count == 0
        assert entry.fill_count == 0
        assert entry.condition_count == 0

    def test_custom_values(self) -> None:
        """Should accept custom values."""
        entry = BarIndex(
            bar_index=10,
            has_state=True,
            has_signals=True,
            has_fills=True,
            has_conditions=True,
            signal_count=3,
            fill_count=2,
            condition_count=5,
        )

        assert entry.bar_index == 10
        assert entry.has_state is True
        assert entry.has_signals is True
        assert entry.has_fills is True
        assert entry.has_conditions is True
        assert entry.signal_count == 3
        assert entry.fill_count == 2
        assert entry.condition_count == 5


class TestDebugIndex:
    """Tests for DebugIndex dataclass."""

    def test_default_values(self) -> None:
        """Should have correct default values."""
        index = DebugIndex()

        assert index.bar_count == 0
        assert index.trade_bars == []
        assert index.signal_bars == []
        assert index.condition_bars == []
        assert index.bar_entries == {}

    def test_add_bar_basic(self) -> None:
        """Should add basic bar entry."""
        index = DebugIndex()

        index.add_bar(bar_index=0)

        assert 0 in index.bar_entries
        assert index.bar_count == 1
        assert index.bar_entries[0].has_state is True

    def test_add_bar_with_signals(self) -> None:
        """Should track bars with signals."""
        index = DebugIndex()

        index.add_bar(bar_index=5, signal_count=2)

        assert 5 in index.signal_bars
        assert index.bar_entries[5].has_signals is True
        assert index.bar_entries[5].signal_count == 2

    def test_add_bar_with_fills(self) -> None:
        """Should track bars with fills (trades)."""
        index = DebugIndex()

        index.add_bar(bar_index=10, fill_count=1)

        assert 10 in index.trade_bars
        assert index.bar_entries[10].has_fills is True
        assert index.bar_entries[10].fill_count == 1

    def test_add_bar_with_conditions(self) -> None:
        """Should track bars with conditions."""
        index = DebugIndex()

        index.add_bar(bar_index=15, condition_count=10)

        assert 15 in index.condition_bars
        assert index.bar_entries[15].has_conditions is True
        assert index.bar_entries[15].condition_count == 10

    def test_add_bar_no_duplicates_in_lists(self) -> None:
        """Should not add duplicate entries to lists."""
        index = DebugIndex()

        index.add_bar(bar_index=5, fill_count=1)
        index.add_bar(bar_index=5, fill_count=2)

        assert index.trade_bars.count(5) == 1

    def test_add_bar_maintains_sorted_lists(self) -> None:
        """Should keep lists sorted."""
        index = DebugIndex()

        index.add_bar(bar_index=10, fill_count=1)
        index.add_bar(bar_index=5, fill_count=1)
        index.add_bar(bar_index=15, fill_count=1)

        assert index.trade_bars == [5, 10, 15]

    def test_get_next_trade_bar(self) -> None:
        """Should find next bar with trade."""
        index = DebugIndex()

        index.add_bar(bar_index=5, fill_count=1)
        index.add_bar(bar_index=10, fill_count=1)
        index.add_bar(bar_index=20, fill_count=1)

        assert index.get_next_trade_bar(0) == 5
        assert index.get_next_trade_bar(5) == 10
        assert index.get_next_trade_bar(10) == 20
        assert index.get_next_trade_bar(20) is None
        assert index.get_next_trade_bar(25) is None

    def test_get_prev_trade_bar(self) -> None:
        """Should find previous bar with trade."""
        index = DebugIndex()

        index.add_bar(bar_index=5, fill_count=1)
        index.add_bar(bar_index=10, fill_count=1)
        index.add_bar(bar_index=20, fill_count=1)

        assert index.get_prev_trade_bar(25) == 20
        assert index.get_prev_trade_bar(20) == 10
        assert index.get_prev_trade_bar(10) == 5
        assert index.get_prev_trade_bar(5) is None
        assert index.get_prev_trade_bar(0) is None

    def test_get_next_signal_bar(self) -> None:
        """Should find next bar with signal."""
        index = DebugIndex()

        index.add_bar(bar_index=3, signal_count=1)
        index.add_bar(bar_index=8, signal_count=2)

        assert index.get_next_signal_bar(0) == 3
        assert index.get_next_signal_bar(3) == 8
        assert index.get_next_signal_bar(8) is None

    def test_get_prev_signal_bar(self) -> None:
        """Should find previous bar with signal."""
        index = DebugIndex()

        index.add_bar(bar_index=3, signal_count=1)
        index.add_bar(bar_index=8, signal_count=2)

        assert index.get_prev_signal_bar(10) == 8
        assert index.get_prev_signal_bar(8) == 3
        assert index.get_prev_signal_bar(3) is None

    def test_has_trades(self) -> None:
        """Should check if bar has trades."""
        index = DebugIndex()

        index.add_bar(bar_index=5, fill_count=1)
        index.add_bar(bar_index=10)

        assert index.has_trades(5) is True
        assert index.has_trades(10) is False
        assert index.has_trades(99) is False  # Nonexistent bar

    def test_has_signals(self) -> None:
        """Should check if bar has signals."""
        index = DebugIndex()

        index.add_bar(bar_index=5, signal_count=2)
        index.add_bar(bar_index=10)

        assert index.has_signals(5) is True
        assert index.has_signals(10) is False
        assert index.has_signals(99) is False  # Nonexistent bar

    def test_to_dict(self) -> None:
        """Should convert to dictionary."""
        index = DebugIndex()

        index.add_bar(bar_index=0, signal_count=1, fill_count=2, condition_count=3)
        index.add_bar(bar_index=5, signal_count=1)

        d = index.to_dict()

        assert d["bar_count"] == 6
        assert d["trade_bars"] == [0]
        assert d["signal_bars"] == [0, 5]
        assert d["condition_bars"] == [0]
        assert "0" in d["bar_entries"]
        assert d["bar_entries"]["0"]["signal_count"] == 1
        assert d["bar_entries"]["0"]["fill_count"] == 2

    def test_from_dict(self) -> None:
        """Should create from dictionary."""
        data = {
            "bar_count": 100,
            "trade_bars": [10, 20, 30],
            "signal_bars": [5, 10, 15],
            "condition_bars": [10],
            "bar_entries": {
                "10": {
                    "bar_index": 10,
                    "has_state": True,
                    "has_signals": True,
                    "has_fills": True,
                    "has_conditions": True,
                    "signal_count": 2,
                    "fill_count": 1,
                    "condition_count": 5,
                }
            },
        }

        index = DebugIndex.from_dict(data)

        assert index.bar_count == 100
        assert index.trade_bars == [10, 20, 30]
        assert index.signal_bars == [5, 10, 15]
        assert index.condition_bars == [10]
        assert 10 in index.bar_entries
        assert index.bar_entries[10].signal_count == 2
        assert index.bar_entries[10].fill_count == 1

    def test_from_dict_minimal(self) -> None:
        """Should handle minimal dictionary."""
        data = {}

        index = DebugIndex.from_dict(data)

        assert index.bar_count == 0
        assert index.trade_bars == []
        assert index.signal_bars == []
        assert index.condition_bars == []

    def test_round_trip(self) -> None:
        """Should round-trip through dict and back."""
        original = DebugIndex()

        original.add_bar(0, signal_count=1, fill_count=2, condition_count=3)
        original.add_bar(5, signal_count=2)
        original.add_bar(10, fill_count=1)
        original.add_bar(15, condition_count=5)

        restored = DebugIndex.from_dict(original.to_dict())

        assert restored.bar_count == original.bar_count
        assert restored.trade_bars == original.trade_bars
        assert restored.signal_bars == original.signal_bars
        assert restored.condition_bars == original.condition_bars
        assert len(restored.bar_entries) == len(original.bar_entries)


class TestDebugIndexBuilder:
    """Tests for DebugIndexBuilder class."""

    def test_init(self) -> None:
        """Should initialize builder."""
        builder = DebugIndexBuilder()

        assert builder._current_bar == 0
        assert builder._signal_counts == {}
        assert builder._fill_counts == {}
        assert builder._condition_counts == {}

    def test_set_bar(self) -> None:
        """Should set current bar index."""
        builder = DebugIndexBuilder()

        builder.set_bar(10)

        assert builder._current_bar == 10

    def test_record_signal_current_bar(self) -> None:
        """Should record signal at current bar."""
        builder = DebugIndexBuilder()

        builder.set_bar(5)
        builder.record_signal()

        assert builder._signal_counts[5] == 1

    def test_record_signal_specific_bar(self) -> None:
        """Should record signal at specific bar."""
        builder = DebugIndexBuilder()

        builder.record_signal(bar_index=10)

        assert builder._signal_counts[10] == 1

    def test_record_signal_multiple(self) -> None:
        """Should count multiple signals."""
        builder = DebugIndexBuilder()

        builder.set_bar(5)
        builder.record_signal()
        builder.record_signal()
        builder.record_signal()

        assert builder._signal_counts[5] == 3

    def test_record_fill_current_bar(self) -> None:
        """Should record fill at current bar."""
        builder = DebugIndexBuilder()

        builder.set_bar(15)
        builder.record_fill()

        assert builder._fill_counts[15] == 1

    def test_record_fill_specific_bar(self) -> None:
        """Should record fill at specific bar."""
        builder = DebugIndexBuilder()

        builder.record_fill(bar_index=20)

        assert builder._fill_counts[20] == 1

    def test_record_condition_current_bar(self) -> None:
        """Should record condition at current bar."""
        builder = DebugIndexBuilder()

        builder.set_bar(25)
        builder.record_condition()

        assert builder._condition_counts[25] == 1

    def test_record_condition_specific_bar(self) -> None:
        """Should record condition at specific bar."""
        builder = DebugIndexBuilder()

        builder.record_condition(bar_index=30)

        assert builder._condition_counts[30] == 1

    def test_build_empty(self) -> None:
        """Should build empty index."""
        builder = DebugIndexBuilder()

        index = builder.build(total_bars=100)

        assert index.bar_count == 100
        assert len(index.bar_entries) == 100
        assert index.trade_bars == []
        assert index.signal_bars == []
        assert index.condition_bars == []

    def test_build_with_data(self) -> None:
        """Should build index with recorded data."""
        builder = DebugIndexBuilder()

        builder.set_bar(5)
        builder.record_signal()
        builder.record_signal()

        builder.set_bar(10)
        builder.record_fill()

        builder.set_bar(15)
        builder.record_condition()
        builder.record_condition()
        builder.record_condition()

        index = builder.build(total_bars=20)

        assert index.bar_count == 20
        assert index.signal_bars == [5]
        assert index.trade_bars == [10]
        assert index.condition_bars == [15]
        assert index.bar_entries[5].signal_count == 2
        assert index.bar_entries[10].fill_count == 1
        assert index.bar_entries[15].condition_count == 3

    def test_build_ignores_bars_beyond_total(self) -> None:
        """Should ignore bars beyond total_bars."""
        builder = DebugIndexBuilder()

        builder.record_signal(bar_index=50)  # Beyond total
        builder.record_fill(bar_index=5)  # Within total

        index = builder.build(total_bars=10)

        assert index.bar_count == 10
        assert 50 not in index.bar_entries
        assert 5 in index.bar_entries


class TestSaveAndLoadIndex:
    """Tests for save_index and load_index functions."""

    def test_save_index(self, tmp_path: Path) -> None:
        """Should save index to file."""
        index = DebugIndex()
        index.add_bar(0, signal_count=1)
        index.add_bar(5, fill_count=2)

        save_index(index, tmp_path / "debug.arrow")

        idx_path = tmp_path / "debug.idx"
        assert idx_path.exists()

    def test_load_index(self, tmp_path: Path) -> None:
        """Should load index from file."""
        # Create and save an index
        original = DebugIndex()
        original.add_bar(0, signal_count=1)
        original.add_bar(5, fill_count=2)
        original.add_bar(10, condition_count=3)

        save_index(original, tmp_path / "debug.arrow")

        # Load it back
        loaded = load_index(tmp_path / "debug.arrow")

        assert loaded is not None
        assert loaded.bar_count == original.bar_count
        assert loaded.signal_bars == original.signal_bars
        assert loaded.trade_bars == original.trade_bars
        assert loaded.condition_bars == original.condition_bars

    def test_load_index_not_found(self, tmp_path: Path) -> None:
        """Should return None if index file not found."""
        loaded = load_index(tmp_path / "nonexistent.arrow")

        assert loaded is None

    def test_load_index_invalid_json(self, tmp_path: Path) -> None:
        """Should return None for invalid JSON."""
        idx_path = tmp_path / "debug.idx"
        idx_path.write_text("not valid json")

        loaded = load_index(tmp_path / "debug.arrow")

        assert loaded is None

    def test_save_creates_idx_extension(self, tmp_path: Path) -> None:
        """Should create .idx file regardless of input extension."""
        index = DebugIndex()

        save_index(index, tmp_path / "debug")

        assert (tmp_path / "debug.idx").exists()

    def test_load_looks_for_idx_extension(self, tmp_path: Path) -> None:
        """Should look for .idx file regardless of input extension."""
        index = DebugIndex()
        index.add_bar(0, signal_count=1)

        save_index(index, tmp_path / "test.arrow")

        # Load with different extension
        loaded = load_index(tmp_path / "test.xyz")

        # Should still find test.idx
        assert loaded is not None

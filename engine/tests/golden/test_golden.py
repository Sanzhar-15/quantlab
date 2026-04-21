"""
Golden test execution via pytest.

These tests load golden test vectors from YAML files and execute them
against the backtest engine, comparing results to expected values.

Run golden tests:
    pytest -m golden -v
    pytest tests/golden/ -v
    pytest tests/golden/ -k "G001" -v  # Specific test
"""

from pathlib import Path

import pytest

from .runner import GoldenTestRunner
from .runner import GoldenTestVector
from .runner import load_golden_vector


# Get vectors directory
VECTORS_DIR = Path(__file__).parent / "vectors"


def get_all_vector_ids() -> list[str]:
    """Get all vector IDs from the vectors directory."""
    runner = GoldenTestRunner(VECTORS_DIR)
    vectors = runner.load_vectors()
    return [v.id for v in vectors]


class TestGoldenVectors:
    """Test class for golden test vectors."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        self.vectors_dir = VECTORS_DIR
        self.runner = GoldenTestRunner(self.vectors_dir)

    @pytest.mark.golden
    def test_golden_vectors_loadable(self):
        """Verify all golden test vectors can be loaded."""
        vectors = self.runner.load_vectors()
        assert len(vectors) > 0, "No golden test vectors found"

        for vector in vectors:
            assert vector.id, f"Vector missing ID: {vector}"
            assert vector.name, f"Vector {vector.id} missing name"
            assert vector.category, f"Vector {vector.id} missing category"
            assert vector.setup, f"Vector {vector.id} missing setup"
            assert vector.data, f"Vector {vector.id} missing data"
            assert vector.expected, f"Vector {vector.id} missing expected"

    @pytest.mark.golden
    def test_golden_vector_ids_unique(self):
        """Verify all golden test vector IDs are unique."""
        vectors = self.runner.load_vectors()
        ids = [v.id for v in vectors]
        duplicates = [id for id in ids if ids.count(id) > 1]
        assert not duplicates, f"Duplicate vector IDs: {set(duplicates)}"

    @pytest.mark.golden
    def test_golden_vector_categories_valid(self):
        """Verify all golden test vectors have valid categories."""
        valid_categories = {
            "basic_execution",
            "order_types",
            "time_in_force",
            "short_selling",
            "partial_fills",
            "slippage",
            "forward_fill",
            "edge_cases",
            "multi_symbol",
            "exposure",
            "codemod",
            "universe",
            "unicode",
            "timezone",
        }

        vectors = self.runner.load_vectors()
        for vector in vectors:
            assert vector.category in valid_categories, (
                f"Vector {vector.id} has invalid category: {vector.category}"
            )


class TestGoldenExecution:
    """
    Parametrized tests that execute all golden vectors.

    Each vector is loaded and executed against the backtest engine,
    with results compared to expected values.
    """

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        self.vectors_dir = VECTORS_DIR
        self.runner = GoldenTestRunner(self.vectors_dir)

    @pytest.mark.golden
    @pytest.mark.parametrize("vector_id", get_all_vector_ids())
    def test_golden_vector(self, vector_id: str):
        """Execute a single golden vector and verify results."""
        vector = load_golden_vector(vector_id, self.vectors_dir)
        assert vector is not None, f"Vector {vector_id} not found"

        if vector.skip:
            pytest.skip(vector.skip_reason or "Marked as skip")

        result = self.runner.run_vector(vector)

        if result.error:
            pytest.fail(f"{vector_id} error: {result.error}")

        if not result.passed:
            diff_str = "\n".join(f"  - {d}" for d in result.differences)
            pytest.fail(f"{vector_id} failed:\n{diff_str}")


class TestGoldenBasicExecution:
    """Tests for basic execution golden vectors (G001-G009)."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        self.vectors_dir = VECTORS_DIR
        self.runner = GoldenTestRunner(self.vectors_dir)

    @pytest.mark.golden
    def test_G001_basic_market_buy(self):
        """G001: Basic market buy order fills at next bar open."""
        vector = load_golden_vector("G001", self.vectors_dir)
        assert vector is not None, "G001 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G001 failed: {result.differences}"

    @pytest.mark.golden
    def test_G002_basic_market_sell(self):
        """G002: Basic market sell order fills at next bar open."""
        vector = load_golden_vector("G002", self.vectors_dir)
        assert vector is not None, "G002 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G002 failed: {result.differences}"

    @pytest.mark.golden
    def test_G005_round_trip_profit(self):
        """G005: Round trip trade with profit."""
        vector = load_golden_vector("G005", self.vectors_dir)
        assert vector is not None, "G005 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G005 failed: {result.differences}"

    @pytest.mark.golden
    def test_G006_round_trip_loss(self):
        """G006: Round trip trade with loss."""
        vector = load_golden_vector("G006", self.vectors_dir)
        assert vector is not None, "G006 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G006 failed: {result.differences}"


class TestGoldenOrderTypes:
    """Tests for order type golden vectors (G010-G022)."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        self.vectors_dir = VECTORS_DIR
        self.runner = GoldenTestRunner(self.vectors_dir)

    @pytest.mark.golden
    def test_G010_limit_buy_fills(self):
        """G010: Limit buy order fills at limit price."""
        vector = load_golden_vector("G010", self.vectors_dir)
        assert vector is not None, "G010 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G010 failed: {result.differences}"

    @pytest.mark.golden
    def test_G011_limit_buy_no_fill(self):
        """G011: Limit buy order does not fill when price doesn't reach limit."""
        vector = load_golden_vector("G011", self.vectors_dir)
        assert vector is not None, "G011 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G011 failed: {result.differences}"

    @pytest.mark.golden
    def test_G012_stop_buy_triggered(self):
        """G012: Stop buy order triggers on breakout."""
        vector = load_golden_vector("G012", self.vectors_dir)
        assert vector is not None, "G012 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G012 failed: {result.differences}"

    @pytest.mark.golden
    def test_G014_stop_sell_triggered(self):
        """G014: Stop sell order triggers on breakdown."""
        vector = load_golden_vector("G014", self.vectors_dir)
        assert vector is not None, "G014 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G014 failed: {result.differences}"


class TestGoldenShortSelling:
    """Tests for short selling golden vectors (G040-G049)."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        self.vectors_dir = VECTORS_DIR
        self.runner = GoldenTestRunner(self.vectors_dir)

    @pytest.mark.golden
    def test_G040_short_sell_basic(self):
        """G040: Basic short sell with 100% collateral."""
        vector = load_golden_vector("G040", self.vectors_dir)
        assert vector is not None, "G040 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G040 failed: {result.differences}"

    @pytest.mark.golden
    def test_G041_short_sell_profit(self):
        """G041: Short sell with profit on cover."""
        vector = load_golden_vector("G041", self.vectors_dir)
        assert vector is not None, "G041 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G041 failed: {result.differences}"

    @pytest.mark.golden
    def test_G042_short_sell_loss(self):
        """G042: Short sell with loss on cover."""
        vector = load_golden_vector("G042", self.vectors_dir)
        assert vector is not None, "G042 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G042 failed: {result.differences}"


class TestGoldenSlippage:
    """Tests for slippage and commission golden vectors (G050-G060)."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        self.vectors_dir = VECTORS_DIR
        self.runner = GoldenTestRunner(self.vectors_dir)

    @pytest.mark.golden
    def test_G050_fixed_slippage(self):
        """G050: Fixed slippage model."""
        vector = load_golden_vector("G050", self.vectors_dir)
        assert vector is not None, "G050 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G050 failed: {result.differences}"

    @pytest.mark.golden
    def test_G055_per_share_commission(self):
        """G055: Per-share commission model."""
        vector = load_golden_vector("G055", self.vectors_dir)
        assert vector is not None, "G055 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G055 failed: {result.differences}"

    @pytest.mark.golden
    def test_G056_flat_commission(self):
        """G056: Flat commission per trade."""
        vector = load_golden_vector("G056", self.vectors_dir)
        assert vector is not None, "G056 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G056 failed: {result.differences}"


class TestGoldenEdgeCases:
    """Tests for edge case golden vectors (G080-G089)."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        self.vectors_dir = VECTORS_DIR
        self.runner = GoldenTestRunner(self.vectors_dir)

    @pytest.mark.golden
    def test_G080_zero_quantity_rejected(self):
        """G080: Zero quantity order rejected."""
        vector = load_golden_vector("G080", self.vectors_dir)
        assert vector is not None, "G080 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G080 failed: {result.differences}"

    @pytest.mark.golden
    def test_G082_insufficient_cash(self):
        """G082: Order exceeds available cash."""
        vector = load_golden_vector("G082", self.vectors_dir)
        assert vector is not None, "G082 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G082 failed: {result.differences}"


class TestGoldenExposure:
    """Tests for exposure golden vectors (G100-G105)."""

    @pytest.fixture(autouse=True)
    def setup(self):
        """Set up test fixtures."""
        self.vectors_dir = VECTORS_DIR
        self.runner = GoldenTestRunner(self.vectors_dir)

    @pytest.mark.golden
    def test_G100_exposure_limit_block(self):
        """G100: Exposure limit blocks order that would breach limit."""
        vector = load_golden_vector("G100", self.vectors_dir)
        assert vector is not None, "G100 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G100 failed: {result.differences}"

    @pytest.mark.golden
    def test_G101_exposure_partial_fill(self):
        """G101: Exposure limit allows partial fill."""
        vector = load_golden_vector("G101", self.vectors_dir)
        assert vector is not None, "G101 vector not found"

        result = self.runner.run_vector(vector)
        assert result.passed, f"G101 failed: {result.differences}"

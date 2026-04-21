"""
Pytest configuration and shared fixtures for Quantlab Engine tests.
"""

import os
import sys
from decimal import Decimal
from pathlib import Path
from typing import Generator

import pytest

# Ensure engine package is importable
ENGINE_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ENGINE_ROOT))


# =============================================================================
# Decimal Fixtures
# =============================================================================

@pytest.fixture
def decimal_zero() -> Decimal:
    """Zero as Decimal."""
    return Decimal("0")


@pytest.fixture
def decimal_one() -> Decimal:
    """One as Decimal."""
    return Decimal("1")


@pytest.fixture
def initial_cash() -> Decimal:
    """Default initial cash for backtests ($100,000)."""
    return Decimal("100000")


# =============================================================================
# Path Fixtures
# =============================================================================

@pytest.fixture
def fixtures_dir() -> Path:
    """Path to test fixtures directory."""
    return Path(__file__).parent / "fixtures"


@pytest.fixture
def benchmarks_dir() -> Path:
    """Path to benchmark data directory."""
    return Path(__file__).parent / "benchmarks"


@pytest.fixture
def golden_dir() -> Path:
    """Path to golden test vectors directory."""
    return Path(__file__).parent / "golden"


@pytest.fixture
def temp_dir(tmp_path: Path) -> Path:
    """Temporary directory for test outputs."""
    return tmp_path


# =============================================================================
# Mock Data Fixtures
# =============================================================================

@pytest.fixture
def sample_ohlcv_data() -> list[dict]:
    """Sample OHLCV data for testing."""
    return [
        {"timestamp": "2026-01-02T16:00:00Z", "open": Decimal("100.00"), "high": Decimal("105.00"), "low": Decimal("99.00"), "close": Decimal("104.00"), "volume": 1000000},
        {"timestamp": "2026-01-03T16:00:00Z", "open": Decimal("104.00"), "high": Decimal("106.00"), "low": Decimal("102.00"), "close": Decimal("103.00"), "volume": 1200000},
        {"timestamp": "2026-01-06T16:00:00Z", "open": Decimal("103.00"), "high": Decimal("107.00"), "low": Decimal("101.00"), "close": Decimal("106.00"), "volume": 900000},
        {"timestamp": "2026-01-07T16:00:00Z", "open": Decimal("106.00"), "high": Decimal("108.00"), "low": Decimal("104.00"), "close": Decimal("107.00"), "volume": 1100000},
        {"timestamp": "2026-01-08T16:00:00Z", "open": Decimal("107.00"), "high": Decimal("110.00"), "low": Decimal("105.00"), "close": Decimal("109.00"), "volume": 1300000},
    ]


# =============================================================================
# Configuration Fixtures
# =============================================================================

@pytest.fixture
def backtest_config() -> dict:
    """Default backtest configuration."""
    return {
        "initial_cash": Decimal("100000"),
        "fill_assumption": "next_open",
        "slippage_model": "none",
        "commission_model": "none",
        "calendar": "nyse",
        "max_exposure": Decimal("1.0"),  # 100% of equity
    }


@pytest.fixture
def risk_limits() -> dict:
    """Default risk limits configuration."""
    return {
        "max_position_size": Decimal("0.10"),  # 10% of equity per position
        "max_exposure": Decimal("1.0"),  # 100% gross exposure
        "max_drawdown": Decimal("0.20"),  # 20% max drawdown
        "consecutive_loss_limit": 3,
    }


# =============================================================================
# Pytest Configuration
# =============================================================================

def pytest_configure(config: pytest.Config) -> None:
    """Register custom markers."""
    config.addinivalue_line("markers", "golden: Golden test vectors (G001-G105)")
    config.addinivalue_line("markers", "live: Live trading tests (L001-L070)")
    config.addinivalue_line("markers", "benchmark: Performance benchmark tests")
    config.addinivalue_line("markers", "chaos: Chaos/failure injection tests")
    config.addinivalue_line("markers", "slow: Tests that take >1 second")
    config.addinivalue_line("markers", "integration: Integration tests")


def pytest_collection_modifyitems(config: pytest.Config, items: list) -> None:
    """Automatically add markers based on test location."""
    for item in items:
        # Add markers based on test file location
        if "golden" in str(item.fspath):
            item.add_marker(pytest.mark.golden)
        if "benchmark" in str(item.fspath):
            item.add_marker(pytest.mark.benchmark)
        if "chaos" in str(item.fspath):
            item.add_marker(pytest.mark.chaos)

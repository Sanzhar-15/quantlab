"""
Smoke tests to verify the engine package is properly set up.
"""

import sys
from pathlib import Path


def test_python_version():
    """Verify Python version is 3.11+."""
    assert sys.version_info >= (3, 11), f"Python 3.11+ required, got {sys.version}"


def test_quantlab_package_importable():
    """Verify the quantlab package can be imported."""
    import quantlab

    assert hasattr(quantlab, "__version__")
    assert quantlab.__version__ == "1.0.0-alpha"


def test_quantlab_subpackages_importable():
    """Verify all subpackages can be imported."""
    subpackages = [
        "quantlab.backtest",
        "quantlab.daemon",
        "quantlab.data",
        "quantlab.risk",
        "quantlab.orders",
        "quantlab.portfolio",
        "quantlab.metrics",
        "quantlab.calendar",
        "quantlab.features",
        "quantlab.protocol",
        "quantlab.api",
        "quantlab.errors",
        "quantlab.logging",
        "quantlab.utils",
        "quantlab.precision",
        "quantlab.time",
        "quantlab.secrets",
        "quantlab.codemod",
        "quantlab.debug",
        "quantlab.providers",
        "quantlab.audit",
        "quantlab.runtime",
        "quantlab.snapshot",
        "quantlab.artifacts",
    ]

    for package in subpackages:
        __import__(package)


def test_calendars_exist():
    """Verify calendar YAML files exist."""
    engine_dir = Path(__file__).parent.parent
    calendars_dir = engine_dir / "calendars"

    assert calendars_dir.exists(), "calendars directory not found"
    assert (calendars_dir / "nyse.yaml").exists(), "nyse.yaml not found"
    assert (calendars_dir / "nasdaq.yaml").exists(), "nasdaq.yaml not found"
    assert (calendars_dir / "crypto_24_7.yaml").exists(), "crypto_24_7.yaml not found"


def test_fixtures_dir_exists(fixtures_dir: Path):
    """Verify fixtures directory exists (uses pytest fixture)."""
    assert fixtures_dir.exists(), "fixtures directory not found"


def test_decimal_fixtures(decimal_zero, decimal_one):
    """Verify decimal fixtures work."""
    from decimal import Decimal

    assert decimal_zero == Decimal("0")
    assert decimal_one == Decimal("1")

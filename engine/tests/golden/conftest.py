"""
Pytest configuration for golden tests.

Golden tests are loaded from YAML files and executed as parameterized tests.
"""

from pathlib import Path

import pytest

from .runner import GoldenTestRunner
from .runner import GoldenTestVector


def pytest_generate_tests(metafunc):
    """Generate parameterized tests from golden test vectors."""
    if "golden_vector" in metafunc.fixturenames:
        vectors_dir = Path(__file__).parent / "vectors"
        if vectors_dir.exists():
            runner = GoldenTestRunner(vectors_dir)
            vectors = runner.load_vectors()

            # Filter by category if specified
            if hasattr(metafunc, "definition"):
                markers = list(metafunc.definition.iter_markers("golden_category"))
                if markers:
                    category = markers[0].args[0]
                    vectors = [v for v in vectors if v.category == category]

            metafunc.parametrize(
                "golden_vector",
                vectors,
                ids=[v.id for v in vectors],
            )


@pytest.fixture
def golden_runner() -> GoldenTestRunner:
    """Provide a configured golden test runner."""
    vectors_dir = Path(__file__).parent / "vectors"
    return GoldenTestRunner(vectors_dir)


@pytest.fixture
def vectors_dir() -> Path:
    """Path to golden test vectors directory."""
    return Path(__file__).parent / "vectors"

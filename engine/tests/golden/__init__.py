"""
Golden test infrastructure for Quantlab Engine.

Golden tests are regression tests with predefined inputs and expected outputs.
They ensure the backtest engine produces deterministic, correct results.

Test Categories:
- G001-G005: Basic Execution
- G010-G022: Order Types
- G030-G034: Time-in-Force
- G040-G049: Short Selling
- G050-G055: Partial Fills
- G060-G065: Slippage
- G070-G074: Forward Fill
- G080-G089: Edge Cases
- G090-G099: Multi-Symbol
- G100-G105: Exposure

Usage:
    pytest -m golden -v
"""

from .runner import GoldenTestResult
from .runner import GoldenTestRunner
from .runner import GoldenTestVector
from .runner import load_golden_vector

__all__ = [
    "GoldenTestVector",
    "GoldenTestRunner",
    "GoldenTestResult",
    "load_golden_vector",
]

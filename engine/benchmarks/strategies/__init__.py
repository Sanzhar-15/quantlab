"""
Benchmark Strategies (FIX-B005).

Provides strategy implementations for performance benchmarking.

Available strategies:
- sma_crossover: Simple moving average crossover
- rsi_macd: RSI + MACD combination
- momentum: Momentum-based strategy
- rotation: Multi-symbol rotation strategy
"""

from pathlib import Path

# Strategy module paths for dynamic loading
STRATEGY_DIR = Path(__file__).parent

STRATEGIES = {
    "sma_crossover": STRATEGY_DIR / "sma_crossover.py",
    "rsi_macd": STRATEGY_DIR / "rsi_macd.py",
    "momentum": STRATEGY_DIR / "momentum.py",
    "rotation": STRATEGY_DIR / "rotation.py",
}


def get_strategy_path(name: str) -> Path:
    """
    Get the file path for a benchmark strategy.

    Args:
        name: Strategy name

    Returns:
        Path to strategy file

    Raises:
        KeyError: If strategy not found
    """
    if name not in STRATEGIES:
        raise KeyError(
            f"Unknown strategy: {name}. "
            f"Available: {list(STRATEGIES.keys())}"
        )
    return STRATEGIES[name]


def list_strategies() -> list[str]:
    """List available benchmark strategy names."""
    return list(STRATEGIES.keys())


__all__ = [
    "STRATEGIES",
    "STRATEGY_DIR",
    "get_strategy_path",
    "list_strategies",
]

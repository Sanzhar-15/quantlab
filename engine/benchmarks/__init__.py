"""
Quantlab Engine Benchmark Suite.

Provides performance benchmarking for the backtest engine.

Benchmarks:
- bench_small: 1Y daily (252 bars), target p95 < 0.5s
- bench_medium: 5Y daily (1,260 bars), target p95 < 2.0s
- bench_large: 1Y minute (98,280 bars), target p95 < 60s
- bench_multi: 5Y 10-symbol (12,600 bars), target p95 < 10s

Usage:
    python -m benchmarks.runner --output results.json
    python -m benchmarks.check --baseline main --threshold 1.5
"""

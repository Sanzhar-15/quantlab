# Benchmark Datasets

This directory contains benchmark datasets for performance testing.

## Dataset Specifications

| Benchmark | Dataset | Bars | Target p95 |
|-----------|---------|------|------------|
| `bench_small` | 1Y daily | 252 | 0.5s |
| `bench_medium` | 5Y daily | 1,260 | 2.0s |
| `bench_large` | 1Y minute | 98,280 | 60s |
| `bench_multi` | 5Y 10-symbol | 12,600 | 10s |

## File Format

All datasets use CSV format with columns:
- `date` or `timestamp`: ISO 8601 format
- `symbol`: Ticker symbol (for multi-symbol datasets)
- `open`, `high`, `low`, `close`: Decimal prices
- `volume`: Integer volume

## Generating Datasets

Run the generator script to create synthetic benchmark data:

```bash
python -m benchmarks.generate_data
```

## Notes

- Datasets are deterministic (seeded random generation)
- Used for regression testing, not accuracy testing
- Real data should be used for strategy validation

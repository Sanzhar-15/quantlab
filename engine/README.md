# Quantlab Engine

The Python trading engine for Quantlab - providing backtesting and live trading capabilities.

## Architecture

```
engine/
├── quantlab/                 # Core Python package
│   ├── backtest/            # Backtest engine with t/t+1 semantics
│   ├── daemon/              # Live trading daemon process
│   ├── data/                # Data loading and provenance (DataRev)
│   ├── risk/                # Exposure reservation and circuit breakers
│   ├── orders/              # Order type simulation (MARKET, LIMIT, STOP, STOP_LIMIT)
│   ├── portfolio/           # Portfolio state and short selling
│   ├── metrics/             # Performance metrics (Sharpe, Sortino, etc.)
│   ├── calendar/            # Market calendars and timezone handling
│   ├── features/            # Feature store with look-ahead protection
│   ├── protocol/            # IPC protocol (JSON-RPC 2.0)
│   ├── api/                 # Strategy API (vectorized, event-driven, class-based)
│   ├── errors/              # Structured error taxonomy
│   ├── logging/             # JSON structured logging
│   ├── precision/           # Decimal precision by asset class
│   ├── time/                # Timezone and DST handling
│   ├── secrets/             # Encrypted secrets access
│   ├── codemod/             # Safe code modification with LibCST
│   ├── debug/               # Time-travel debugger (Arrow IPC format)
│   ├── providers/           # Data provider adapters (Alpaca)
│   ├── audit/               # Tamper-evident audit log
│   ├── runtime/             # Memory management, package isolation
│   ├── snapshot/            # Environment reproducibility
│   └── artifacts/           # Run artifacts and export
├── tests/                   # Test suite
│   ├── golden/              # Golden test vectors (G001-G105)
│   ├── fixtures/            # Test data fixtures
│   └── benchmarks/          # Performance benchmarks
├── calendars/               # Market calendar YAML files
└── benchmarks/              # Benchmark datasets and strategies
```

## Requirements

- Python 3.11+
- See `pyproject.toml` for full dependencies

## Installation

```bash
# Development installation
cd engine
pip install -e ".[dev]"

# With benchmark tools
pip install -e ".[dev,benchmark]"
```

## Testing

```bash
# Run all tests
pytest

# Run with coverage
pytest --cov=quantlab --cov-report=html

# Run golden tests only
pytest -m golden

# Run benchmark tests
pytest -m benchmark
```

## Type Checking

```bash
# Run Pyright
pyright quantlab
```

## Linting

```bash
# Check code style
ruff check quantlab tests

# Auto-fix issues
ruff check --fix quantlab tests

# Format code
ruff format quantlab tests
```

## Key Design Decisions

| Decision | Choice |
|----------|--------|
| IPC Protocol | JSON-RPC 2.0 over Unix sockets / Named pipes |
| Debug Format | Apache Arrow IPC (.arrow) |
| Decimal Precision | `Decimal` for all prices/quantities (not `float`) |
| Timezone | UTC internally, local for display |
| Code Modification | LibCST (preserves formatting) |
| Secrets | OS Keychain primary, AES-256-GCM encrypted file fallback |

## Coverage Requirements

- **Phase 1 Gate**: ≥80% unit test coverage on engine
- **Phase 2 Gate**: Golden tests G001-G049 pass 100%
- **Phase 4 Gate**: Live tests L001-L070 pass 100%

## License

MIT

# QuantLab Engine Tests (FIX-T006)

This directory contains the test suite for the QuantLab trading engine.

## Test Categories

### Unit Tests (`tests/unit/`)
Fast, isolated tests for individual components.
- Run frequently during development
- No external dependencies
- Target: <1 second per test

### Integration Tests (`tests/integration/`)
Tests for component interactions.
- Database connections
- IPC communication
- File I/O operations

### Golden Tests (`tests/golden/`)
Deterministic backtesting verification.
- Compares outputs against known-good baselines
- Ensures reproducibility
- Run with: `pytest tests/golden/ -m golden`

### Live Tests (`tests/live/`)
Tests for live trading components.
- Session lifecycle
- Order flow
- Emergency flatten
- Broker connections

**Warning**: Some live tests may require API credentials.

### Chaos Tests (`tests/chaos/`)
Failure scenario testing.
- Network failures
- Resource exhaustion
- Concurrent access
- Timeout handling

## Running Tests

### All Tests
```bash
pytest tests/
```

### With Coverage
```bash
pytest tests/ --cov=quantlab --cov-report=html
```

### Specific Category
```bash
pytest tests/unit/           # Unit tests only
pytest tests/golden/ -m golden  # Golden tests
pytest tests/live/ -m live   # Live tests (may need credentials)
pytest tests/chaos/          # Chaos tests
```

### Quick Smoke Test
```bash
pytest tests/ -m "not slow" --tb=short
```

## Test Markers

| Marker | Description |
|--------|-------------|
| `@pytest.mark.golden` | Golden/baseline comparison tests |
| `@pytest.mark.live` | Live trading tests (need credentials) |
| `@pytest.mark.slow` | Tests that take >5 seconds |
| `@pytest.mark.asyncio` | Async tests |

## Writing Tests

### Naming Convention
- Test files: `test_<module>.py`
- Test classes: `Test<Component>`
- Test functions: `test_<behavior>`

### Example Test
```python
import pytest
from quantlab.metrics import sharpe_ratio

class TestSharpeRatio:
    def test_positive_returns(self):
        returns = [0.01, 0.02, 0.01, 0.03]
        result = sharpe_ratio(returns)
        assert result > 0

    def test_empty_returns(self):
        with pytest.raises(ValueError):
            sharpe_ratio([])

    @pytest.mark.asyncio
    async def test_async_calculation(self):
        # Async test example
        result = await async_sharpe(returns)
        assert result is not None
```

### Fixtures
Common fixtures are in `conftest.py`:
- `mock_broker`: Mock broker for order testing
- `sample_bars`: Sample OHLCV data
- `test_session`: Test trading session

## Coverage Requirements

- Minimum coverage: 80%
- Critical paths (trading, risk): 90%+
- New code should include tests

## CI Integration

Tests run automatically on:
- Pull requests (all tests)
- Push to main/develop (all tests + benchmarks)
- Nightly (full suite including slow tests)

See `.github/workflows/engine-ci.yml` for CI configuration.

## Troubleshooting

### Tests hanging
- Check for missing `@pytest.mark.asyncio` on async tests
- Look for infinite loops in mocked components

### Flaky tests
- Avoid time-dependent assertions
- Use deterministic random seeds
- Increase timeouts for slow CI runners

### Import errors
- Ensure `pip install -e ".[dev]"` was run
- Check Python version (3.11+ required)

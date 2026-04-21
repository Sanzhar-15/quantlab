# QuantLab V10 Implementation Gaps - Remediation Plan

Based on comprehensive audit against Complete-Implementation-plan.zip.

## Priority 1: CRITICAL (Must Fix Before Live Trading)

### 1.1 Secrets Fallback End-to-End Wiring

**Problem:** SecretsManager exists in Python but daemon bypasses it, using `os.environ` directly. No IPC bridge for TypeScript to communicate secrets to daemon.

**Files to Modify:**
- `engine/quantlab/daemon/main.py` - Use SecretsManager instead of os.environ
- `extensions/quantlab/src/services/DaemonClient.ts` - Add credentials IPC method
- `engine/quantlab/daemon/ipc.py` - Add `credentials.get` handler

**Implementation:**
```python
# daemon/main.py - Replace lines 1177-1179
from quantlab.secrets.encrypted import SecretsManager

# In __init__ or _connect_broker:
secrets = SecretsManager()
api_key = secrets.get_broker_credentials("alpaca").get("api_key", "")
secret_key = secrets.get_broker_credentials("alpaca").get("secret_key", "")
```

```typescript
// DaemonClient.ts - Add method
async getCredentials(broker: string): Promise<BrokerCredentials> {
    return this.call('credentials.get', { broker });
}
```

**Effort:** 2-3 hours

---

### 1.2 UI Reconciliation Exposure

**Problem:** Engine has full reconciliation (position, fill, quote validation) but UI doesn't expose any controls or status.

**Files to Create/Modify:**
- `extensions/quantlab/src/panels/reconciliation/ReconciliationPanel.ts` - NEW
- `extensions/quantlab/src/services/DaemonClient.ts` - Add reconciliation methods
- `engine/quantlab/daemon/main.py` - Add IPC handlers for reconciliation

**Implementation:**
```python
# daemon/main.py - Add to _register_ipc_handlers
self._ipc_server.register_handler("reconciliation.trigger", self._handle_reconciliation)
self._ipc_server.register_handler("reconciliation.status", self._handle_reconciliation_status)
self._ipc_server.register_handler("fills.validate", self._handle_fill_validation)
```

**UI Panel Features:**
- View position discrepancies (local vs broker)
- Execute reconciliation actions (sync from broker)
- View fill validation status
- Quote validation status display
- Market hours status indicator

**Effort:** 6-8 hours

---

## Priority 2: HIGH (Should Fix for Production)

### 2.1 Audit Logging Integration

**Problem:** Tamper-evident ledger exists (`audit/ledger.py`) but not wired into trading flow.

**Files to Modify:**
- `engine/quantlab/daemon/main.py` - Instantiate and pass AuditLedger
- `engine/quantlab/trading/orders.py` - Use audit_log when provided
- `extensions/quantlab/src/panels/audit/AuditPanel.ts` - NEW

**Implementation:**
```python
# daemon/main.py - In __init__
from quantlab.audit.ledger import AuditLedger
self._audit_ledger = AuditLedger(self.session_id)

# In _handle_order_submit (after order creation):
self._audit_ledger.log_order_submit(
    order_id=order.order_id,
    symbol=order.symbol,
    side=order.side.value,
    quantity=order.quantity,
    order_type=order.order_type.value,
)

# In process_fill:
self._audit_ledger.log_order_fill(
    order_id=order_id,
    fill_qty=fill_qty,
    fill_price=fill_price,
)
```

**Effort:** 4-5 hours

---

### 2.2 Protocol Version Negotiation Client-Side

**Problem:** Server handles negotiate but client never sends it.

**Files to Modify:**
- `extensions/quantlab/src/core/trading/DaemonClient.ts`

**Implementation:**
```typescript
// DaemonClient.ts - In connect() method, before authentication
async connect(): Promise<void> {
    await this.transport.connect();

    // Version negotiation (before auth)
    const negotiateResult = await this.call('negotiate', {
        supportedVersions: ['1.0'],
        clientVersion: '1.0.0',
    });

    if (!negotiateResult.protocolVersion) {
        throw new Error('Version negotiation failed');
    }
    this.protocolVersion = negotiateResult.protocolVersion;

    // Then authenticate...
}
```

**Effort:** 1-2 hours

---

### 2.3 Benchmark Runner Implementation

**Problem:** `_run_backtest()` just sleeps instead of running BacktestEngine.

**Files to Modify:**
- `engine/benchmarks/runner.py`

**Implementation:**
```python
# runner.py - Replace _run_backtest method
def _run_backtest(self, data_path: Path, strategy_path: Path) -> None:
    """Execute a backtest using the actual engine."""
    from quantlab.backtest.core import BacktestEngine, BacktestConfig
    from quantlab.data.service import DataService
    import importlib.util

    # Load strategy
    spec = importlib.util.spec_from_file_location("strategy", strategy_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    strategy = module.Strategy()

    # Load data
    data_service = DataService()
    data = data_service.load_csv(data_path)

    # Configure and run
    config = BacktestConfig(
        initial_capital=Decimal("100000"),
        commission_rate=Decimal("0.001"),
    )
    engine = BacktestEngine(config)
    result = engine.run(strategy, data)
```

**Effort:** 2-3 hours

---

## Priority 3: MEDIUM (Should Fix for Quality)

### 3.1 Debug File Mmap Reader

**Problem:** Full file load into memory, no lazy mmap access.

**Files to Create:**
- `engine/quantlab/debug/mmap_reader.py` - NEW

**Implementation:**
```python
# mmap_reader.py
import mmap
import struct
from pathlib import Path

class DebugFileMmapReader:
    """Memory-mapped random access to debug files."""

    def __init__(self, path: Path):
        self._file = open(path, 'rb')
        self._mmap = mmap.mmap(self._file.fileno(), 0, access=mmap.ACCESS_READ)
        self._index = self._load_offset_index()

    def get_state_at_bar(self, bar_index: int) -> dict:
        """O(1) random access to state at specific bar."""
        offset = self._index.state_offsets[bar_index]
        self._mmap.seek(offset)
        # Read Arrow record batch at offset
        ...
```

**Effort:** 4-6 hours

---

### 3.2 Parquet Data Loader

**Problem:** Only CSV implemented despite DataFormat enum supporting 7 formats.

**Files to Modify:**
- `engine/quantlab/data/service.py` - Add ParquetLoader

**Implementation:**
```python
# service.py - Add new loader class
class ParquetLoader:
    """Load OHLCV data from Parquet files."""

    def load(self, path: Path) -> pd.DataFrame:
        """Load Parquet file with OHLCV data."""
        import pyarrow.parquet as pq

        table = pq.read_table(path)
        df = table.to_pandas()

        # Apply column mapping
        df = self._map_columns(df)
        return df
```

**Effort:** 2-3 hours

---

### 3.3 Centralized Annualization

**Problem:** sqrt(252) hardcoded in multiple places.

**Files to Create:**
- `engine/quantlab/metrics/annualization.py` - NEW

**Implementation:**
```python
# annualization.py
from decimal import Decimal
from enum import Enum

class TradingCalendar(Enum):
    EQUITY = 252      # Trading days per year
    CRYPTO = 365      # 24/7 markets
    FOREX = 252       # Forex trading days
    CUSTOM = 0        # User-defined

def get_annualization_factor(
    periods_per_year: int = 252,
    for_volatility: bool = True,
) -> Decimal:
    """Get annualization factor for metrics."""
    if for_volatility:
        return Decimal(str(periods_per_year)).sqrt()
    return Decimal(periods_per_year)

def annualized_volatility(
    daily_vol: Decimal,
    calendar: TradingCalendar = TradingCalendar.EQUITY,
) -> Decimal:
    """Annualize daily volatility."""
    factor = get_annualization_factor(calendar.value)
    return daily_vol * factor
```

**Effort:** 2-3 hours

---

### 3.4 Calendar Loader Path Fix

**Problem:** Loader defaults to builtin/ instead of root calendars/ directory.

**Files to Modify:**
- `engine/quantlab/calendar/loader.py`

**Implementation:**
```python
# loader.py - Update default calendar path
DEFAULT_CALENDAR_DIR = Path(__file__).parent.parent.parent.parent / "calendars"
# Instead of: Path(__file__).parent / "builtin"
```

**Effort:** 30 minutes

---

## Priority 4: LOW (Nice to Have)

### 4.1 Risk Disclosure Dialog

**Files to Create:**
- `extensions/quantlab/src/ui/dialogs/RiskDisclosure.ts` - NEW

**Features:**
- Formal risk acknowledgment before live trading
- Liability waiver acceptance
- Persistent acknowledgment tracking

**Effort:** 3-4 hours

---

### 4.2 Security Scanning Workflow

**Files to Create:**
- `.github/workflows/security-scan.yml` - NEW

**Implementation:**
```yaml
name: Security Scan
on: [push, pull_request]
jobs:
  dependency-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run Snyk
        uses: snyk/actions/python@master
        env:
          SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
      - name: Run Bandit (Python SAST)
        run: |
          pip install bandit
          bandit -r engine/quantlab -f json -o bandit-report.json
```

**Effort:** 1-2 hours

---

### 4.3 Root Documentation Structure

**Files to Create:**
- `docs/README.md`
- `docs/architecture/overview.md`
- `docs/deployment/production.md`
- `docs/api/ipc-protocol.md`

**Effort:** 4-6 hours (documentation writing)

---

## Implementation Order

| Phase | Items | Total Effort |
|-------|-------|--------------|
| **Phase A** (Week 1) | 1.1 Secrets, 1.2 Reconciliation UI | 8-11 hours |
| **Phase B** (Week 2) | 2.1 Audit, 2.2 Protocol, 2.3 Benchmark | 7-10 hours |
| **Phase C** (Week 3) | 3.1 Mmap, 3.2 Parquet, 3.3 Annualization, 3.4 Calendar | 9-13 hours |
| **Phase D** (Week 4) | 4.1 Risk Dialog, 4.2 Security CI, 4.3 Docs | 8-12 hours |

**Total Estimated Effort:** 32-46 hours

---

## Open Questions for User

1. **Secrets:** Should V1 rely only on VS Code SecretStorage, or is encrypted fallback a hard requirement?
2. **Reconciliation:** Is the reconciliation UI intentionally deferred, or should it be V1 scope?
3. **Parquet:** Is Parquet support a V1 requirement, or can it wait?
4. **Docs:** Should root docs/ be generated from code or manually written?

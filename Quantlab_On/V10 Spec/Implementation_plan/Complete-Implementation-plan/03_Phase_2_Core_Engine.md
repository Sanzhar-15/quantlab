# Phase 2: Core Engine Enhancement

**Duration**: 10 weeks
**Priority**: HIGH - Backtest engine completeness
**Spec References**: Technical Spec §3-7, §9, §14-15, §18
**Decisions Reference**: A6, F32, F35, K65, K66, L71, N83-N90

---

## Objectives

This phase implements the complete backtest engine with full execution model compliance:

1. **Backtest Contract** - Signal bar/execution bar, fill assumptions
2. **Order Type Simulation** - MARKET, LIMIT, STOP, STOP_LIMIT with all TIF
3. **Short Selling Model** - 100% collateral, borrow fees
4. **Data Provenance** - DataRev, UniverseRev tracking
5. **Calendar Configuration** - Market calendars, timezone handling
6. **Feature Store** - Cache key computation, look-ahead protection
7. **Metrics Dictionary** - Standardized calculations
8. **Strategy API** - Vectorized, event-driven, class-based forms
9. **Message Protocol** - Ordering guarantees, versioning
10. **Timezone & DST Handling** - UTC internally, local display (N83, N84)
11. **Memory Management** - Limits with graceful handling (N88)
12. **Concurrent Backtests** - Queue and limit management (N89)
13. **User Packages** - Isolated package installation (N85)
14. **Error Reporting** - Structured errors with codes (N86)
15. **API Versioning** - Semantic versioning with deprecation (N90)

**NOT in Phase 2** (Deferred to V1.1):
- Corporate action simulation (Decision L71) — use adjusted data from provider instead

---

## 1. Backtest Contract Implementation

### 1.1 Canonical Time Indexing

**Spec Reference**: §3.1

```python
# Signal bar t: Data used to compute signals
# Execution bar t+1: Bar during which orders fill

class BacktestEngine:
    def process_bar(self, bar_index: int):
        # 1. Bar t completes - all OHLCV known
        signal_bar = self.bars[bar_index]

        # 2. Strategy evaluates, generates signals
        signals = self.strategy.evaluate(self.bars[:bar_index+1])

        # 3. Queue orders for execution bar (t+1)
        for signal in signals:
            order = self.create_order(signal, signal_bar_index=bar_index)
            self.pending_orders.append(order)

        # 4. Process fills from previous bar's orders
        execution_bar = self.bars[bar_index]  # Bar t+1 for bar t-1 orders
        self.process_fills(execution_bar)

        # 5. Mark-to-market at close
        self.update_equity(signal_bar.close)
```

### 1.2 Fill Assumptions

| Assumption | Fill Price | Configuration |
|------------|------------|---------------|
| `next_open` | `open[t+1]` | **DEFAULT** |
| `next_close` | `close[t+1]` | `config.fill_assumption` |
| `typical_price` | `(O+H+L+C)/4` of t+1 | `config.fill_assumption` |

### 1.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Core engine loop with t/t+1 semantics | 3d | `engine/backtest/core.py` (NEW) |
| Fill assumption modes | 1d | `engine/backtest/fills.py` (NEW) |
| Slippage models (none, fixed_bps, volatility) | 2d | `engine/backtest/slippage.py` (NEW) |
| Commission models (none, per_share, per_trade) | 1d | `engine/backtest/commission.py` (NEW) |
| Volume participation enforcement | 2d | `engine/backtest/fills.py` |
| Forward-fill detection and blocking | 1d | `engine/backtest/data.py` (NEW) |
| Multi-asset calendar alignment | 2d | `engine/backtest/alignment.py` (NEW) |

### 1.4 Testing Requirements

Golden tests G001-G009 (Basic Execution) must all pass.

---

## 2. Order Type Simulation

### 2.1 Supported Orders

**Spec Reference**: §4

| Type | Fill Logic | Slippage |
|------|------------|----------|
| MARKET | Fill at open[t+1] | YES |
| LIMIT | Fill at min(open, limit) if low <= limit | NO |
| STOP | Trigger at stop price, fill at trigger | YES |
| STOP_LIMIT | Trigger at stop, then limit logic | NO |

### 2.2 Time-in-Force

| TIF | Behavior |
|-----|----------|
| GFD | Cancel at session close (DEFAULT) |
| GTC | Carry indefinitely |
| IOC | Fill immediately or cancel |

### 2.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| MARKET order fill logic | 1d | `engine/orders/market.py` (NEW) |
| LIMIT order fill logic (with improvement) | 2d | `engine/orders/limit.py` (NEW) |
| STOP order trigger logic | 2d | `engine/orders/stop.py` (NEW) |
| STOP_LIMIT combined logic | 1d | `engine/orders/stop_limit.py` (NEW) |
| TIF implementation (GFD, GTC, IOC) | 2d | `engine/orders/tif.py` (NEW) |
| Partial fill handling | 2d | `engine/orders/partials.py` (NEW) |
| Order priority (exits > stop-losses > entries) | 1d | `engine/orders/priority.py` (NEW) |

### 2.4 Fill Logic Examples

```python
# LIMIT BUY
def fill_buy_limit(limit_price: Decimal, bar: Bar) -> Optional[Decimal]:
    if bar.low <= limit_price:
        return min(bar.open, limit_price)  # Price improvement
    return None

# STOP BUY (trigger when price rises to stop)
def fill_buy_stop(stop_price: Decimal, bar: Bar) -> Optional[Decimal]:
    if bar.high >= stop_price:
        if bar.open >= stop_price:
            return bar.open  # Gap through
        return stop_price  # Triggered at stop
    return None
```

### 2.5 Testing Requirements

Golden tests G010-G034 (Order Types, TIF) must all pass.

---

## 3. Short Selling Model

### 3.1 V1 Model Specification

**Spec Reference**: §5

| Aspect | V1 Behavior |
|--------|-------------|
| Short positions | ✅ Allowed |
| Margin model | 100% collateral required |
| Max gross exposure | 100% of equity |
| Borrow fee | Configurable, accrued per bar |
| Leverage | None |

### 3.2 Portfolio Accounting

```python
@dataclass
class PortfolioState:
    cash: Decimal                    # Includes short proceeds
    collateral_reserved: Decimal     # Held against shorts
    long_value: Decimal              # Mark-to-market
    short_value: Decimal             # Mark-to-market (absolute)

    @property
    def equity(self) -> Decimal:
        """Equity identity MUST hold at all times."""
        return self.cash + self.long_value - self.short_value

    @property
    def buying_power(self) -> Decimal:
        return self.cash - self.collateral_reserved

    @property
    def gross_exposure(self) -> Decimal:
        return self.long_value + self.short_value
```

### 3.3 Borrow Fee Accrual

```python
def accrue_borrow_fee(position: Position, bar_duration: timedelta, annual_rate: Decimal) -> Decimal:
    """Accrue borrow fee proportional to bar duration."""
    year_fraction = Decimal(bar_duration.total_seconds()) / Decimal(365.25 * 24 * 3600)
    fee = abs(position.value) * annual_rate * year_fraction
    return fee
```

### 3.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Portfolio state with short tracking | 2d | `engine/portfolio/state.py` (NEW) |
| Short entry mechanics (proceeds + collateral) | 2d | `engine/portfolio/short.py` (NEW) |
| Short cover mechanics | 1d | Same |
| Borrow fee accrual | 1d | `engine/portfolio/fees.py` (NEW) |
| Equity identity validation | 1d | `engine/portfolio/validation.py` (NEW) |
| Buying power enforcement | 1d | `engine/portfolio/limits.py` (NEW) |

### 3.5 Testing Requirements

Golden tests G040-G049 (Short Selling) must all pass.

---

## 4. Data Provenance

### 4.1 DataRev Contract

**Spec Reference**: §6

```python
@dataclass
class DataRev:
    id: str
    hash: str
    hash_method: Literal['full', 'sampled']

    symbol: str
    timeframe: str
    date_range: DateRange

    source: DataSource
    row_count: int
    schema: List[ColumnSchema]
```

### 4.2 Hashing Policy

| File Size | Hash Method |
|-----------|-------------|
| < 100 MB | Full SHA-256 |
| ≥ 100 MB (non-pinned) | Sampled (first/last 10MB + every 100th row) |
| Pinned runs | **Always full hash** |

### 4.3 UniverseRev Contract

```python
@dataclass
class UniverseRev:
    id: str
    name: str
    type: Literal['static', 'point_in_time']

    members: Optional[List[str]]  # For static
    source: Optional[DataSource]  # For point-in-time

    date_range: DateRange
    hash: str
```

### 4.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| DataRev schema and creation | 2d | `engine/data/rev.py` (NEW) |
| Full content hashing | 1d | `engine/data/hash.py` (NEW) |
| Sampled hashing for large files | 2d | Same |
| UniverseRev schema | 1d | `engine/data/universe.py` (NEW) |
| Survivorship bias warning | 1d | Same |
| Point-in-time universe loading | 2d | Same |

### 4.5 Testing Requirements

- DataRev hash deterministic across runs
- Pinned runs use full hash
- Warning shown for static universe backtests

---

## 4A. Corporate Action Handling — **DEFERRED TO V1.1**

**Decision Reference**: L71

### 4A.1 V1 Approach

**V1.0 does NOT implement corporate action simulation.** Instead:
- Use **adjusted data** from the data provider (pre-adjusted for splits/dividends)
- Alpaca Data API returns adjusted prices by default
- This handles 90%+ of real-world use cases

### 4A.2 Why Deferred

| Reason | Impact |
|--------|--------|
| Adjusted data handles most cases | Low user impact |
| Full simulation is complex | High dev effort |
| Focus on core functionality | Better V1 quality |

### 4A.3 V1.1 Scope

In V1.1, add explicit corporate action handling modes:
- `ADJUST_PRICES` (use provider-adjusted data) — V1 default
- `SIMULATE` (engine simulates splits/dividends)
- `RAW` (no adjustment, warning shown)

### 4A.4 V1 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Document adjusted data assumption | 0.5d | User Guide |
| Warning for raw data usage | 0.5d | `engine/data/validation.py` |

**Total Effort Saved**: ~9 days moved to V1.1

---

## 4B. Unicode & String Handling

**Spec Reference**: Technical Spec §1.4

### 4B.1 NFC Normalization Policy

All string identifiers must be NFC-normalized before hashing or comparison to ensure reproducibility:

| Entity | Normalization | Purpose |
|--------|---------------|---------|
| File paths | NFC | Consistent hashing across platforms |
| Symbol names | NFC (uppercase) | Deterministic lookups |
| Strategy code | NFC | Reproducible code hashes |
| User input | NFC | Consistent behavior |

### 4B.2 Implementation

```python
import unicodedata

def normalize_path(path: str) -> str:
    """NFC-normalize path for consistent hashing."""
    return unicodedata.normalize('NFC', path)

def normalize_symbol(symbol: str) -> str:
    """NFC-normalize and uppercase symbol."""
    return unicodedata.normalize('NFC', symbol.upper())

def hash_code(code: str) -> str:
    """Hash strategy code after NFC normalization."""
    normalized = unicodedata.normalize('NFC', code)
    return hashlib.sha256(normalized.encode('utf-8')).hexdigest()
```

### 4B.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| NFC normalization utility | 0.5d | `engine/utils/normalize.py` (NEW) |
| Integration with DataRev hashing | 0.5d | `engine/data/hash.py` |
| Integration with code modification | 0.5d | `engine/codemod/` |
| Test with unicode filenames | 0.5d | `tests/fixtures/unicode_filename_データ.csv` |

### 4B.4 Testing Requirements

| Test ID | Description |
|---------|-------------|
| UNI001 | NFC normalization produces consistent hash |
| UNI002 | Unicode filename handled correctly |
| UNI003 | Symbol lookup case-insensitive after normalization |

---

## 5. Calendar Configuration

### 5.1 Calendar Schema

**Spec Reference**: §14.3

```yaml
# calendars/nyse.yaml
name: "NYSE"
timezone: "America/New_York"

regular_hours:
  open: "09:30"
  close: "16:00"

holidays:
  - date: "2026-01-01"
    name: "New Year's Day"
  # ...

early_closes:
  - date: "2026-11-27"
    close: "13:00"
    name: "Day after Thanksgiving"

trading_days_per_year: 252
```

### 5.2 Built-in Calendars

| Calendar | Assets | Days/Year |
|----------|--------|-----------|
| `nyse` | US Equities, ETFs | 252 |
| `nasdaq` | US Equities, ETFs | 252 |
| `crypto_24_7` | Crypto | 365 |

### 5.3 Timezone Handling

**Spec Reference**: §14.4

| Rule | Specification |
|------|---------------|
| Internal storage | All timestamps UTC |
| Bar timestamp meaning | Bar CLOSE time |
| Display conversion | Convert to exchange local time |

### 5.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Calendar YAML schema | 1d | `engine/calendar/schema.py` (NEW) |
| Calendar loading and caching | 1d | `engine/calendar/loader.py` (NEW) |
| NYSE/NASDAQ/Crypto built-ins | 1d | `engine/calendar/builtin/` (NEW) |
| Custom calendar support | 1d | `engine/calendar/custom.py` (NEW) |
| Timezone policy implementation | 2d | `engine/calendar/timezone.py` (NEW) |
| DST transition handling | 1d | Same |
| Annualization factor calculation | 1d | `engine/metrics/annualize.py` (NEW) |

### 5.5 Testing Requirements

- Calendar holidays match official exchange schedules
- DST transitions don't create missing/duplicate bars
- Annualization factors correct for each calendar

---

## 6. Feature Store Contract

### 6.1 Cache Key Definition

**Spec Reference**: §7

```python
def compute_feature_cache_key(
    feature_code_hash: str,
    data_rev_hash: str,
    symbol: str,
    timeframe: str,
    date_range: DateRange,
    engine_version: str,
    dependency_hashes: List[str]
) -> str:
    components = [
        f"code:{feature_code_hash}",
        f"data:{data_rev_hash}",
        f"symbol:{symbol}",
        f"tf:{timeframe}",
        f"range:{date_range.start}:{date_range.end}",
        f"engine:{engine_version}",
        f"deps:{','.join(sorted(dependency_hashes))}"
    ]
    return hashlib.sha256('\n'.join(components).encode()).hexdigest()
```

### 6.2 Look-Ahead Protection

```python
# FORBIDDEN patterns the engine should detect
data.close.shift(-1)      # Future data
data.iloc[i+1]            # Future indexing
df.join(future_df)        # Future joins
```

### 6.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Feature cache key computation | 1d | `engine/features/cache.py` (NEW) |
| Feature caching layer | 2d | `engine/features/store.py` (NEW) |
| Look-ahead detection (AST analysis) | 3d | `engine/features/leakage.py` (NEW) |
| Dependency tracking | 1d | `engine/features/deps.py` (NEW) |

---

## 7. Metrics Dictionary

### 7.1 Return Series Specification

**Spec Reference**: §9

```python
def calculate_returns(equity_curve: List[Decimal]) -> List[Decimal]:
    """
    Canonical return series.
    - Simple returns (not log)
    - On total equity
    - Per bar frequency
    """
    return [(eq[i] - eq[i-1]) / eq[i-1] for i in range(1, len(eq))]
```

### 7.2 Metric Definitions

| Metric | Formula |
|--------|---------|
| Sharpe | `(mean(returns) - rf) / std(returns) × √(ann_factor)` |
| Sortino | `(mean(returns) - rf) / downside_std × √(ann_factor)` |
| Calmar | `CAGR / |max_drawdown|` |
| Win Rate | `winning_trades / total_trades` |
| Profit Factor | `gross_profit / gross_loss` |
| Max Drawdown | Peak-to-trough equity decline |
| Stability | R² of equity vs linear regression |

### 7.3 Risk-Free Rate

```python
DEFAULT_RF = Decimal('0')  # 0%
# Configurable via settings.metrics.riskFreeRate
```

### 7.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Returns calculation | 1d | `engine/metrics/returns.py` (NEW) |
| Sharpe/Sortino/Calmar ratios | 1d | `engine/metrics/risk.py` (NEW) |
| Win rate, profit factor | 1d | `engine/metrics/trade.py` (NEW) |
| Max drawdown calculation | 1d | `engine/metrics/drawdown.py` (NEW) |
| Stability score (R²) | 1d | `engine/metrics/stability.py` (NEW) |
| Trade drift detection | 2d | `engine/metrics/drift.py` (NEW) |

---

## 8. Strategy API Contract

### 8.1 Supported Forms

**Spec Reference**: §18

| Form | Signature | Debugger Support |
|------|-----------|------------------|
| Vectorized | `def strategy(data) -> Signals` | Limited |
| Event-driven | `def on_bar(ctx)` | Full |
| Class-based | `class MyStrategy(ql.Strategy)` | Full |

### 8.2 Parameter Extraction

```python
# Parameters declared with ql.param()
fast_period = ql.param('fast_period', default=10, min=5, max=50)

def strategy(data):
    fast = ql.sma(data.close, fast_period)
    # ...
```

### 8.3 Code Modification Contract

**REQUIREMENT**: Use LibCST (NOT ast module) for code modification to preserve formatting.

### 8.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Vectorized API implementation | 2d | `engine/api/vectorized.py` (NEW) |
| Event-driven API implementation | 2d | `engine/api/event.py` (NEW) |
| Class-based API implementation | 2d | `engine/api/class_based.py` (NEW) |
| Parameter extraction with LibCST | 3d | `engine/api/params.py` (MODIFY) |
| State serialization for checkpoint | 2d | `engine/api/state.py` (NEW) |

---

## 8A. Code Modification Safety [NEW]

### 8A.1 Background

**Spec Reference**: Technical Spec §18.6, Product Spec §12

The Parameter Panel allows users to modify strategy parameters directly in the UI. These modifications must be written back to code safely.

### 8A.2 Safety Requirements

| Requirement | Implementation |
|-------------|----------------|
| Preserve formatting | Use LibCST, not ast |
| Backup before modify | Write `.backup` file first |
| Preview diff | Show user before applying |
| Undo support | Keep backup for 24h |
| Validate syntax | Parse result before write |

### 8A.3 Implementation

```python
import libcst as cst

class SafeCodeModifier:
    """Safely modify strategy code with LibCST."""

    def modify_parameter(
        self,
        source_path: str,
        param_name: str,
        new_value: Any
    ) -> ModifyResult:
        # 1. Read and parse source
        source = Path(source_path).read_text()
        tree = cst.parse_module(source)

        # 2. Create backup
        backup_path = f"{source_path}.backup"
        Path(backup_path).write_text(source)

        # 3. Find and modify parameter
        transformer = ParameterTransformer(param_name, new_value)
        new_tree = tree.visit(transformer)

        if not transformer.found:
            return ModifyResult(success=False, error=f"Parameter {param_name} not found")

        # 4. Generate modified code
        new_source = new_tree.code

        # 5. Validate syntax
        try:
            cst.parse_module(new_source)
        except cst.ParserSyntaxError as e:
            return ModifyResult(success=False, error=f"Syntax error: {e}")

        # 6. Generate diff for preview
        diff = self._generate_diff(source, new_source)

        return ModifyResult(
            success=True,
            diff=diff,
            new_source=new_source,
            backup_path=backup_path
        )

    def apply_modification(self, source_path: str, new_source: str) -> None:
        """Apply modification after user approval."""
        Path(source_path).write_text(new_source)

    def revert_modification(self, source_path: str) -> bool:
        """Revert to backup."""
        backup_path = f"{source_path}.backup"
        if Path(backup_path).exists():
            shutil.copy(backup_path, source_path)
            return True
        return False


class ParameterTransformer(cst.CSTTransformer):
    """LibCST transformer to modify parameter values."""

    def __init__(self, param_name: str, new_value: Any):
        self.param_name = param_name
        self.new_value = new_value
        self.found = False

    def leave_Call(self, original: cst.Call, updated: cst.Call) -> cst.Call:
        # Match ql.param('param_name', ...) calls
        if self._is_param_call(updated, self.param_name):
            self.found = True
            return self._update_default_value(updated, self.new_value)
        return updated
```

### 8A.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| SafeCodeModifier class | 2d | `engine/api/code_modify.py` (NEW) |
| ParameterTransformer with LibCST | 2d | Same |
| Backup management | 1d | Same |
| Diff generation | 1d | Same |
| Preview dialog UI | 1d | `extensions/quantlab/src/ui/CodeModifyPreview.ts` (NEW) |
| Undo command | 1d | `extensions/quantlab/src/commands/parameters.ts` |

### 8A.5 Testing Requirements

| Test ID | Description |
|---------|-------------|
| CM001 | Formatting preserved after modification |
| CM002 | Backup created before modify |
| CM003 | Syntax error prevents write |
| CM004 | Undo restores backup |
| CM005 | Comments preserved |

---

## 9. Message Protocol

### 9.1 Message Ordering Guarantees

**Spec Reference**: §15.3

| Message Type | Ordering Guarantee |
|--------------|-------------------|
| Control | FIFO per job |
| Progress | FIFO per job, may skip |
| Order events | STRICTLY ORDERED per symbol |
| Fill events | STRICTLY ORDERED per order |

### 9.2 Sequence Numbers

```typescript
interface StreamMessage {
  version: '1.0';
  type: MessageType;
  jobId: string;
  timestamp: Date;
  sequenceNumber: number;  // Monotonically increasing per channel
  payload: any;
}
```

### 9.3 Protocol Versioning

**Spec Reference**: §15.4

```typescript
interface HandshakeRequest {
  clientType: 'ui' | 'cli' | 'api';
  protocolVersion: string;
  minProtocolVersion: string;
  capabilities: string[];
}

interface HandshakeResponse {
  negotiatedVersion: string;
  status: 'compatible' | 'upgrade_recommended' | 'incompatible';
}
```

### 9.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Sequence number tracking | 1d | `engine/protocol/sequence.py` (NEW) |
| Gap detection and resync | 2d | `engine/protocol/ordering.py` (NEW) |
| Critical event acknowledgment | 1d | `engine/protocol/ack.py` (NEW) |
| Protocol versioning handshake | 2d | `engine/protocol/version.py` (NEW) |
| Deprecation warning system | 1d | Same |

---

## 10. Decimal Precision

### 10.1 Precision by Asset Class

**Spec Reference**: §14.5

| Asset Class | Price Decimals | Quantity Decimals | Rounding |
|-------------|----------------|-------------------|----------|
| `equity_us` | 2 | 0 | HALF_UP |
| `crypto` | 8 | 8 | DOWN |
| `forex` | 5 | 0 | HALF_UP |

### 10.2 Implementation Requirement

**All prices and quantities MUST use `Decimal`, not `float`.**

```python
# CORRECT
price = Decimal('100.50')
quantity = Decimal('100')

# WRONG - precision loss
price = 100.50  # float
```

### 10.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| PrecisionPolicy class | 1d | `engine/precision/policy.py` (NEW) |
| Asset class precision rules | 1d | Same |
| Comparison tolerance helpers | 1d | `engine/precision/compare.py` (NEW) |
| Decimal migration audit | 2d | All engine files |

---

## Phase 2 Deliverables Checklist

### Week 5-6
- [ ] Backtest engine core loop with t/t+1 semantics
- [ ] MARKET and LIMIT order fill logic
- [ ] Basic portfolio state with short tracking
- [ ] DataRev schema implemented

### Week 7-8
- [ ] STOP and STOP_LIMIT orders
- [ ] TIF implementation (GFD, GTC, IOC)
- [ ] Short selling mechanics complete
- [ ] Calendar configuration working

### Week 9-10
- [ ] Volume participation enforcement
- [ ] Partial fill handling
- [ ] Borrow fee accrual
- [ ] Timezone handling complete

### Week 11-12
- [ ] Feature store with caching
- [ ] Look-ahead detection
- [ ] All metrics implemented
- [ ] Strategy API all forms
- [ ] Message protocol with ordering

---

## 9A. Timezone & DST Handling (Decisions N83, N84)

### 9A.1 Core Principle

**All times UTC internally, display in user's local timezone.**

### 9A.2 Implementation

```python
from zoneinfo import ZoneInfo

class TimezoneHandler:
    """Handle all timezone operations."""

    def to_utc(self, dt: datetime, tz_name: str) -> datetime:
        """Convert local time to UTC."""
        local_tz = ZoneInfo(tz_name)
        return dt.replace(tzinfo=local_tz).astimezone(ZoneInfo('UTC'))

    def from_utc(self, dt: datetime, tz_name: str) -> datetime:
        """Convert UTC to local time for display."""
        local_tz = ZoneInfo(tz_name)
        return dt.astimezone(local_tz)

    def get_market_open_utc(self, calendar: Calendar, date: date) -> datetime:
        """Get market open time in UTC."""
        local_open = datetime.combine(date, calendar.open_time)
        return self.to_utc(local_open, calendar.timezone)
```

### 9A.3 DST Handling

- Use `zoneinfo` (Python 3.9+ stdlib)
- Market open/close times specified in exchange timezone
- Conversion to UTC handles DST automatically
- Test vectors MUST include DST transition dates

### 9A.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| TimezoneHandler class | 1d | `engine/time/timezone.py` (NEW) |
| Calendar UTC conversion | 1d | `engine/time/calendar.py` |
| UI timezone display toggle | 0.5d | Settings |
| DST transition test vectors | 0.5d | Tests |

---

## 9B. Memory Management (Decision N88)

### 9B.1 Default Limits

| Operation | Default | Max Configurable |
|-----------|---------|------------------|
| Backtest | 4GB | 16GB |
| Live session | 2GB | 8GB |
| Debug file buffer | 1GB | 4GB |

### 9B.2 OOM Handling

```
Memory usage monitored every 5s
    │
    ├── 80%: Warning toast
    │
    ├── 95%: Pause and prompt user
    │
    └── At limit: Graceful termination with checkpoint
```

### 9B.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Memory monitor | 1d | `engine/runtime/memory.py` (NEW) |
| Threshold warnings | 0.5d | Same |
| Graceful termination | 0.5d | `engine/backtest/core.py` |

---

## 9C. Concurrent Backtests (Decision N89)

### 9C.1 Configuration

- Default: **Maximum 2 concurrent backtests**
- Configurable: `quantlab.maxConcurrentBacktests` (1-4)
- Queue behavior: Additional backtests queued, FIFO execution

### 9C.2 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Backtest queue manager | 1d | `engine/backtest/queue.py` (NEW) |
| Queue status UI | 0.5d | `extensions/quantlab/src/ui/BacktestQueue.ts` (NEW) |

---

## 9D. User Package Support (Decision N85)

### 9D.1 Model

1. Bundled Python includes core packages (numpy, pandas, scipy, scikit-learn, ta-lib)
2. User can install additional packages via `quantlab install <package>`
3. Packages installed to `~/.quantlab/packages/`
4. Engine adds user package path to `sys.path`
5. Conflicts: User packages take precedence (with warning)

### 9D.2 Limitations (V1)

- No conda support
- No virtualenv per strategy (global user packages)
- V2: Per-strategy environments

### 9D.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| `quantlab install` command | 1d | `cli/commands/install.py` (NEW) |
| Package path injection | 0.5d | `engine/runtime/packages.py` (NEW) |
| Conflict detection | 0.5d | Same |

---

## 9E. Error Reporting Structure (Decision N86)

### 9E.1 Error Format

```json
{
  "code": "BROKER_ORDER_REJECTED",
  "message": "Order rejected: insufficient buying power",
  "category": "broker",
  "severity": "error",
  "context": {
    "order_id": "abc123",
    "symbol": "AAPL",
    "required": 10000,
    "available": 5000
  },
  "timestamp": "2026-01-25T14:30:00Z",
  "recoverable": true,
  "user_action": "Reduce order size or add funds"
}
```

### 9E.2 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Error taxonomy classes | 1d | `engine/errors/taxonomy.py` (NEW) |
| Error formatting | 0.5d | `engine/errors/format.py` (NEW) |
| UI error display | 0.5d | `extensions/quantlab/src/ui/ErrorDisplay.ts` |

---

## 9F. API Versioning (Decision N90)

### 9F.1 Version Header

```python
# quantlab: api_version=1.0
def strategy(data):
    ...
```

### 9F.2 Compatibility Policy

- Minor versions: Backward compatible
- Major versions: May break
- Deprecation: 2-release warning period

### 9F.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| API version parser | 0.5d | `engine/api/version.py` (NEW) |
| Deprecation warnings | 0.5d | Same |

---

## Testing Requirements Summary

| Test Suite | Count | Must Pass |
|------------|-------|-----------|
| G001-G005 (Basic Execution) | 5 | ALL |
| G010-G022 (Order Types) | 13 | ALL |
| G030-G034 (TIF) | 5 | ALL |
| G040-G049 (Short Selling) | 10 | ALL |
| G050-G055 (Partial Fills) | 6 | ALL |
| G060-G065 (Slippage) | 6 | ALL |
| G070-G074 (Forward Fill) | 5 | ALL |
| G080-G089 (Edge Cases) | 10 | ALL |
| G090-G099 (Multi-Symbol) | 10 | ALL |
| G100-G105 (Exposure) | 6 | ALL |
| ~~Corporate Actions (CA001-CA005)~~ | ~~5~~ | **DEFERRED** |
| Code Modification (CM001-CM005) | 5 | ALL |
| Timezone/DST (TZ001-TZ004) | 4 | ALL |
| Unicode Handling (UNI001-UNI003) | 3 | ALL |

**Total**: 88 golden tests (76 from spec G001-G105 + 12 implementation tests: 5 CM + 4 TZ + 3 UNI; corporate actions deferred)

**Phase Gate**: G001-G049 must pass 100% before proceeding to Phase 3

---

## Dependencies

### Python Dependencies (New)
- `libcst` - Code modification
- `pyarrow` - Debug file format
- `zoneinfo` (Python 3.9+) - Timezone handling

### Data Dependencies
- Calendar YAML files for NYSE, NASDAQ
- Benchmark datasets from Phase 1

---

*Phase 2 completion unblocks Phase 3 (UI) and Phase 4 (Live Trading) work.*
*Phase Gate: G001-G049 must pass 100% before proceeding to Phase 3.*

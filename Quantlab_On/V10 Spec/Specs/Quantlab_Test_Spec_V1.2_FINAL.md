# Quantlab Test Specification V1.2
## Verification Strategy, Test Vectors, Acceptance Criteria

**Product**: Quantlab — Quantitative Trading Development Environment  
**Company**: Delta Plus  
**Version**: 1.2 FINAL  
**Date**: 2026-01-25  
**Status**: Approved for Implementation

---

## Document Control

### Canonical Document Set
| Document | Version | Audience |
|----------|---------|----------|
| Product Specification | V10.5 | Product, Design, Frontend |
| Technical Specification | V2.5 | Backend, Engine, QA |
| Operations Specification | V1.3 | DevOps, Release, Support |
| **This Document** | V1.2 | QA, Engineering |
| Design System | V1.0 | Design, Frontend |

### Changes from V1.1
| Section | Change |
|---------|--------|
| §5.3 | **NEW**: Live Trading Test Vectors |
| §7.2 | Added Unicode normalization tests |
| §9 | Added debug file performance criteria |
| §11.4 | **NEW**: Debug File Performance Tests |

---

## Table of Contents

1. Testing Philosophy
2. Golden Test Vectors
3. Unit Test Requirements
4. Integration Test Requirements
5. End-to-End Test Suites
6. Security Tests
7. Determinism Tests
8. Chaos & Failure Tests
9. Performance Acceptance Criteria
10. Regression Test Strategy
11. Debugger Correctness Tests
12. Test Data Management
13. CI/CD Integration

---

# §1. Testing Philosophy

## 1.1 Testing Pyramid

```
                    ┌─────────┐
                    │   E2E   │  ~10%
                    ├─────────┤
                    │  Integ  │  ~20%
               ┌────┴─────────┴────┐
               │    Unit Tests     │  ~70%
               └───────────────────┘
```

## 1.2 Coverage Requirements

| Component | Minimum | Target |
|-----------|---------|--------|
| Engine (Python) | 80% | 90% |
| UI (TypeScript) | 70% | 85% |
| Adapters | 90% | 95% |
| **Critical paths** | **100%** | **100%** |

**Critical paths** (MUST be 100%):
- Order execution logic
- Portfolio accounting
- Risk limit enforcement
- Data integrity checks
- Short selling calculations
- Checkpoint/resume logic
- Exposure reservation model [NEW]
- Daemon lifecycle [NEW]

---

# §2. Golden Test Vectors

## 2.1 Vector Format

```json
{
  "name": "G001 - Buy and Hold",
  "version": "1.0",
  "strategy": { "code": "...", "hash": "..." },
  "data": { "type": "synthetic", "params": {...} },
  "config": { "fillAssumption": "next_open", ... },
  "expected": {
    "totalReturn": 0.1523,
    "sharpe": 1.42,
    "trades": 1,
    "finalEquity": 115230.00,
    "tolerance": 0.0001
  }
}
```

## 2.2 Required Golden Tests

### Basic Execution (G001-G005)
| ID | Description |
|----|-------------|
| G001 | Buy and hold |
| G002 | Single trade |
| G003 | Multiple trades |
| G004 | SMA crossover |
| G005 | RSI mean reversion |

### Order Types (G010-G022)
| ID | Description |
|----|-------------|
| G010 | MARKET order |
| G011 | LIMIT buy fill |
| G012 | LIMIT buy no fill |
| G013 | LIMIT buy gap-through |
| G014 | LIMIT sell fill |
| G015 | LIMIT sell no fill |
| G016 | STOP buy trigger |
| G017 | STOP buy gap-through |
| G018 | STOP sell trigger |
| G019 | STOP sell gap-through |
| G020 | STOP_LIMIT buy |
| G021 | STOP_LIMIT sell |
| G022 | STOP_LIMIT gap past limit |

### Time-in-Force (G030-G034)
| ID | Description |
|----|-------------|
| G030 | GFD expires |
| G031 | GTC carries |
| G032 | IOC full fill |
| G033 | IOC partial fill |
| G034 | IOC no fill cancel |

### Short Selling (G040-G049)
| ID | Description |
|----|-------------|
| G040 | Short entry |
| G041 | Short cover |
| G042 | Short collateral check |
| G043 | Short borrow fee (daily) |
| G044 | Short borrow fee (hourly) |
| G045 | Market neutral equity |
| G046 | Short insufficient funds |
| G047 | Cover partial |
| G048 | Short + long same symbol |
| G049 | Borrow fee across weekend |

### Volume & Partial Fills (G050-G055)
| ID | Description |
|----|-------------|
| G050 | Partial fill GFD |
| G051 | Partial fill GTC |
| G052 | Partial fill IOC |
| G053 | Aggregate volume cap |
| G054 | Multiple orders same bar |
| G055 | Priority: exits before entries |

### Slippage (G060-G065)
| ID | Description |
|----|-------------|
| G060 | Slippage on MARKET |
| G061 | No slippage on LIMIT |
| G062 | Slippage on triggered STOP |
| G063 | No slippage on STOP_LIMIT |
| G064 | Volatility slippage model |
| G065 | Fixed BPS slippage |

### Forward Fill (G070-G074)
| ID | Description |
|----|-------------|
| G070 | Forward fill detection |
| G071 | Signal blocked on forward fill |
| G072 | Signal allowed (opt-in) |
| G073 | Calendar intersection mode |
| G074 | Warning generation |

### Edge Cases (G080-G089)
| ID | Description |
|----|-------------|
| G080 | Signal on last bar |
| G081 | Zero volume bar |
| G082 | NaN in indicator |
| G083 | Multiple signals same bar |
| G084 | Delisting |
| G085 | Gap up > 10% |
| G086 | Gap down > 10% |
| G087 | Negative price (error) |
| G088 | Future date (error) |
| G089 | Duplicate timestamp |

### Multi-Symbol Tests (G090-G099) [NEW]
| ID | Description |
|----|-------------|
| G090 | Two symbols same strategy |
| G091 | Portfolio rebalance across symbols |
| G092 | Different calendars alignment |
| G093 | One symbol delisted mid-backtest |
| G094 | Cross-symbol correlation signal |
| G095 | Universe rotation (symbol enters) |
| G096 | Universe rotation (symbol exits) |
| G097 | Different timeframes same symbol |
| G098 | Volume constraint across symbols |
| G099 | Aggregate exposure limit multi-symbol |

### Exposure Reservation (G100-G105) [NEW]
| ID | Description |
|----|-------------|
| G100 | Single order reserves exposure |
| G101 | Concurrent orders reserve correctly |
| G102 | Fill releases reservation |
| G103 | Cancel releases reservation |
| G104 | Partial fill partial release |
| G105 | Reservation prevents breach |

## 2.3 Golden Test Failure Protocol

1. Identify changed behavior
2. Determine: bug fix or regression?
3. If correct: Update golden with documented reason
4. If regression: Fix code, do NOT update golden
5. Require 2 approvals for golden changes

---

# §3. Unit Test Requirements

## 3.1 Order Execution Module

```python
class TestOrderExecution:
    def test_market_order_fills_at_open(self):
        """MARKET fills at next bar open."""
        
    def test_limit_buy_price_improvement(self):
        """LIMIT BUY gets improvement when open < limit."""
        
    def test_stop_gap_through_fills_at_open(self):
        """STOP that gaps through fills at open."""
        
    def test_slippage_only_on_market(self):
        """Slippage applies only to MARKET orders."""
        
    def test_aggregate_volume_per_symbol(self):
        """Multiple orders respect aggregate cap."""
```

## 3.2 Portfolio Module

```python
class TestPortfolioAccounting:
    def test_short_sale_equity_preserved(self):
        """Short sale should not change equity."""
        
    def test_borrow_fee_daily(self):
        """Borrow fee correct for daily bars."""
        
    def test_borrow_fee_hourly(self):
        """Borrow fee scaled for hourly bars."""
        
    def test_equity_identity(self):
        """equity = cash + longValue - shortValue always."""
```

## 3.3 Metrics Module

```python
class TestMetrics:
    def test_sharpe_simple_returns(self):
        """Sharpe uses simple returns, not log."""
        
    def test_win_rate_excludes_open(self):
        """Win rate only counts closed trades."""
        
    def test_max_drawdown_algorithm(self):
        """Drawdown peak-to-trough correct."""
        
    def test_stability_score_r_squared(self):
        """Stability is R² of equity vs linear."""
```

## 3.4 Exposure Reservation Module [NEW]

```python
class TestExposureReservation:
    def test_reserve_success(self):
        """Order reserves exposure when under limit."""
        
    def test_reserve_failure_at_limit(self):
        """Order rejected when would breach limit."""
        
    def test_concurrent_reservations(self):
        """Thread-safe reservation for concurrent orders."""
        
    def test_commit_on_fill(self):
        """Reservation converted to actual on fill."""
        
    def test_release_on_cancel(self):
        """Reservation released on cancel."""
        
    def test_partial_fill_partial_release(self):
        """Partial fill only commits filled portion."""
```

---

# §4. Integration Test Requirements

## 4.1 Engine-Runner Integration

```python
class TestEngineRunner:
    def test_backtest_completes(self):
        """Full backtest produces expected artifacts."""
        
    def test_checkpoint_resume(self):
        """Resume from checkpoint produces same result."""
        
    def test_cancel_saves_partial(self):
        """Cancellation saves partial results."""
```

## 4.2 UI-Engine Integration

```python
class TestUIEngine:
    def test_progress_updates(self):
        """Progress messages received correctly."""
        
    def test_command_response_correlation(self):
        """Responses match command correlationIds."""
        
    def test_message_ordering(self):
        """Messages processed in sequence order."""
```

## 4.3 Broker Adapter Integration

```python
class TestBrokerAdapter:
    def test_order_lifecycle(self):
        """Order transitions through states correctly."""
        
    def test_idempotency(self):
        """Duplicate clientOrderId returns same order."""
        
    def test_partial_fill_streaming(self):
        """Partial fills stream correctly."""
```

## 4.4 Daemon Lifecycle Integration [NEW]

```python
class TestDaemonLifecycle:
    def test_daemon_starts_detached(self):
        """Daemon process survives parent exit."""
        
    def test_ui_reconnects_to_daemon(self):
        """UI reconnects to existing daemon on startup."""
        
    def test_daemon_checkpoint_on_crash(self):
        """Daemon writes checkpoint before crash."""
        
    def test_session_recovery(self):
        """Session state recovered after UI restart."""
```

---

# §5. End-to-End Test Suites

## 5.1 Core Workflow

| Test | Steps |
|------|-------|
| E2E-001 | Create strategy → Backtest → View results |
| E2E-002 | Modify params → Re-run → Compare |
| E2E-003 | Pin run → Close app → Reopen → Verify pinned |

## 5.2 Trading Workflow

| Test | Steps |
|------|-------|
| E2E-010 | Strategy → Paper trade → Monitor |
| E2E-011 | Paper trade → Circuit breaker → Verify pause |
| E2E-012 | Paper trade → Kill switch → Verify flatten |

## 5.3 Live Trading Test Vectors [NEW]

### Paper Trading Golden Tests (L001-L010)
| ID | Description | Expected |
|----|-------------|----------|
| L001 | Start paper session | Session active, daemon running |
| L002 | Paper order submit | Order accepted within 200ms |
| L003 | Paper order fill | Fill notification within 200ms |
| L004 | Paper partial fill | Correct partial fill handling |
| L005 | Paper order cancel | Cancellation within 500ms |
| L006 | Paper order reject | Error shown, session continues |
| L007 | Paper circuit breaker | Session paused on limit breach |
| L008 | Paper emergency flatten | All positions closed |
| L009 | Paper session stop | Clean shutdown, positions closed |
| L010 | Paper reconnect | UI reconnects to running session |

### Live Trading Safety Tests (L020-L030)
| ID | Description | Expected |
|----|-------------|----------|
| L020 | Trust required for live | Cannot start without trust |
| L021 | Risk disclosure required | All checkboxes mandatory |
| L022 | Extension review required | Untrusted extensions block live |
| L023 | Code change revokes trust | Trust revoked on edit |
| L024 | Max order size enforced | Oversized order rejected |
| L025 | Max position size enforced | Position limit respected |
| L026 | Daily loss limit enforced | Circuit breaker triggers |
| L027 | Max drawdown enforced | Circuit breaker triggers |
| L028 | Gross exposure enforced | Order rejected at limit |
| L029 | Concurrent order reservation | No exposure breach on concurrent |
| L030 | Emergency flatten out-of-hours | Queued for market open |

### Live Trading Failure Tests (L040-L050)
| ID | Description | Expected |
|----|-------------|----------|
| L040 | Broker disconnect < 30s | Auto-reconnect |
| L041 | Broker disconnect > 5min | Circuit breaker |
| L042 | Order timeout | Order cancelled, error shown |
| L043 | Fill notification delay | State eventually consistent |
| L044 | UI crash during live | Daemon continues |
| L045 | UI reconnect after crash | Session recovered |
| L046 | Position reconciliation mismatch | Dialog shown |
| L047 | Network failure during flatten | Aggressive retry |
| L048 | Invalid quote during flatten | Skip to market order |
| L049 | Daemon crash | Checkpoint preserved |
| L050 | System shutdown | Graceful cleanup |

### Emergency Flatten Tests (L060-L070)
| ID | Description | Expected |
|----|-------------|----------|
| L060 | Flatten single long position | Position closed |
| L061 | Flatten single short position | Position closed |
| L062 | Flatten multiple positions | All positions closed |
| L063 | Flatten with stage 1 success | Limit order fills |
| L064 | Flatten with stage 2 fallback | Market order used |
| L065 | Flatten with stale quote | Market order immediately |
| L066 | Flatten with missing quote | Market order immediately |
| L067 | Flatten idempotency | No duplicate orders |
| L068 | Flatten logging | All actions logged |
| L069 | Flatten latency | Complete within 10s |
| L070 | Flatten confirmation UI | Type FLATTEN required |

## 5.4 Data Workflow

| Test | Steps |
|------|-------|
| E2E-020 | Import CSV → Map schema → Use in backtest |
| E2E-021 | Pin data → Verify hash → Re-run |

---

# §6. Security Tests

## 6.1 Secrets Redaction

```python
class TestSecretsRedaction:
    def test_api_key_redacted_in_logs(self):
        """API keys never appear in log files."""
        
    def test_broker_credentials_not_in_artifacts(self):
        """Artifacts contain no broker credentials."""
        
    def test_crash_dump_redacted(self):
        """Crash dumps have secrets removed."""
        
    def test_export_redacted(self):
        """Exported reports contain no secrets."""
```

## 6.2 Sandbox Tests

```python
class TestStrategySandbox:
    def test_network_blocked(self):
        """Strategy cannot make network requests."""
        
    def test_subprocess_blocked(self):
        """Strategy cannot spawn subprocesses."""
        
    def test_filesystem_restricted(self):
        """Strategy can only access allowed paths."""
        
    def test_memory_limit_enforced(self):
        """Strategy that exceeds memory is terminated."""
```

## 6.3 Trust Model Tests

```python
class TestWorkspaceTrust:
    def test_live_trading_requires_trust(self):
        """Cannot start live without trusted workspace."""
        
    def test_code_change_revokes_trust(self):
        """Modifying trusted code revokes trust."""
        
    def test_extension_review_required(self):
        """Untrusted extensions block live trading."""
        
    def test_extension_update_revokes_trust(self):
        """Major extension update requires re-review."""
```

## 6.4 Path Traversal Tests

```python
class TestPathTraversal:
    def test_data_path_traversal_blocked(self):
        """../../../etc/passwd style paths rejected."""
        
    def test_symlink_outside_workspace_blocked(self):
        """Symlinks pointing outside workspace blocked."""
```

## 6.5 Secrets Backend Tests [NEW]

```python
class TestSecretsBackend:
    def test_keychain_primary(self):
        """OS Keychain used when available."""
        
    def test_encrypted_file_fallback(self):
        """Encrypted file used when keychain unavailable."""
        
    def test_encrypted_file_permissions(self):
        """Encrypted file has 0600 permissions."""
        
    def test_master_key_minimum_length(self):
        """Master key must be >= 16 characters."""
        
    def test_failed_unlock_backoff(self):
        """Exponential backoff on failed unlocks."""
        
    def test_lockout_after_failures(self):
        """Locked for 1 hour after 10 failures."""
```

## 6.6 AI Panel Security Tests [NEW]

```python
class TestAIPanelSecurity:
    def test_account_number_redacted(self):
        """Account numbers detected and redacted."""
        
    def test_financial_data_redacted(self):
        """P&L and balance data redacted."""
        
    def test_api_key_redacted(self):
        """API keys in input redacted."""
        
    def test_user_warned_before_send(self):
        """User sees warning when sensitive data detected."""
        
    def test_credentials_never_sent(self):
        """Broker credentials never included in AI requests."""
```

---

# §7. Determinism Tests

## 7.1 Reproducibility Tests

```python
class TestDeterminism:
    def test_same_inputs_same_outputs(self):
        """Identical inputs produce identical outputs."""
        # Run backtest twice with same config
        # Assert all metrics match exactly
        
    def test_rng_state_reproducible(self):
        """Setting seed produces same results."""
        
    def test_pinned_run_exact_reproduction(self):
        """Reproducing pinned run matches original."""
```

## 7.2 Cross-Platform Tests

```python
class TestCrossPlatform:
    def test_hash_consistent_across_os(self):
        """Package hash same on Windows/Mac/Linux."""
        # Normalize line endings, paths
        
    def test_results_consistent_across_os(self):
        """Backtest results match across platforms."""
        
    def test_unicode_nfc_normalization(self):
        """Files with unicode names hash consistently."""
        # macOS NFD vs Windows/Linux NFC
        
    def test_nfc_normalization_applied(self):
        """NFC normalization applied to file content."""
```

## 7.3 Numerical Precision Tests

```python
class TestNumericalPrecision:
    def test_equity_precision(self):
        """Equity calculations stable to 1e-6."""
        
    def test_metric_precision(self):
        """Metrics stable across equivalent calculations."""
        
    def test_comparison_tolerance(self):
        """Run comparisons use appropriate tolerance."""
        
    def test_tolerance_within_spec(self):
        """All metrics within specified tolerance bounds."""
        # Reference: Tech Spec §8.3 tolerances
```

---

# §8. Chaos & Failure Tests

## 8.1 Engine Failures

| ID | Scenario | Expected |
|----|----------|----------|
| CH-001 | Engine crash mid-backtest | Checkpoint saved, resumable |
| CH-002 | Disk full during write | Graceful error, no corruption |
| CH-003 | Memory exhaustion | Job terminated, partial saved |

## 8.2 Network Failures

| ID | Scenario | Expected |
|----|----------|----------|
| CH-010 | Broker disconnect < 30s | Auto-reconnect |
| CH-011 | Broker disconnect > 5min | Circuit breaker |
| CH-012 | Data feed stale | Warning, continue |

## 8.3 Concurrent Failures

| ID | Scenario | Expected |
|----|----------|----------|
| CH-020 | UI crash during live | Daemon continues, reconnect |
| CH-021 | Multiple job cancels | All cancel cleanly |

## 8.4 Daemon Failures [NEW]

| ID | Scenario | Expected |
|----|----------|----------|
| CH-030 | Daemon crash | Checkpoint written |
| CH-031 | Daemon OOM killed | Checkpoint attempted |
| CH-032 | System suspend/resume | Session continues |
| CH-033 | Clock skew | Handled gracefully |

---

# §9. Performance Acceptance Criteria

## 9.1 Backtest Benchmarks

**Reference**: 4-core CPU, 8GB RAM, SSD

| Data Size | Expected | Max |
|-----------|----------|-----|
| 252 bars (1Y daily) | < 1s | 2s |
| 1,260 bars (5Y daily) | < 2s | 5s |
| 98,280 bars (1Y minute) | < 60s | 120s |

## 9.2 UI Responsiveness

| Operation | Target | Max |
|-----------|--------|-----|
| App launch | 3s | 5s |
| View switch | 100ms | 200ms |
| Chart render (10K points) | 200ms | 500ms |
| Cancel response | 100ms | 500ms |

## 9.3 Live Trading Latency

| Operation | Target | Max |
|-----------|--------|-----|
| Signal to order submit | 50ms | 200ms |
| Order submit to ack | 100ms | 500ms |
| Fill notification | 50ms | 200ms |

## 9.4 Debug File Performance [NEW]

| Operation | Target | Max |
|-----------|--------|-----|
| Jump to bar (< 1GB file) | 100ms | 500ms |
| Jump to bar (1-4GB file) | 200ms | 1000ms |
| Render state at bar | 50ms | 200ms |
| Load debug file index | 500ms | 2000ms |

---

# §10. Regression Test Strategy

## 10.1 Test Suites

| Suite | Contents | When |
|-------|----------|------|
| Smoke | 10 critical paths | Every commit |
| Golden | All golden vectors | Every PR |
| Full | All tests | Daily |
| Extended | + Chaos + Perf | Release |

## 10.2 Flaky Test Policy

- Flaky test = fails inconsistently
- Quarantine after 3 flakes
- Fix within 1 week or delete
- No flaky tests in main suite

---

# §11. Debugger Correctness Tests

## 11.1 Golden Debugger Tests

```python
class TestDebuggerCorrectness:
    def test_condition_values_captured(self):
        """All condition expressions have captured values."""
        # Run with debug ON
        # Verify every condition has left, right, result
        
    def test_condition_source_locations(self):
        """Source locations map to correct code."""
        # Verify line/column match actual code
        
    def test_bar_state_complete(self):
        """Each bar has complete state snapshot."""
        # OHLCV, indicators, portfolio all present
        
    def test_bidirectional_navigation(self):
        """Code click → chart position correct."""
        # Click code line, verify chart jumps correctly
```

## 11.2 Debugger Limitation Tests

```python
class TestDebuggerLimitations:
    def test_external_lib_handled(self):
        """External library calls show result only."""
        # Use talib, verify no crash, result captured
        
    def test_numba_warning(self):
        """Numba JIT functions show warning."""
        
    def test_large_dataset_sampling(self):
        """> 100K bars uses sampling."""
        # Verify sampling rate, UI indicates sampling
```

## 11.3 Debugger Performance Tests

```python
class TestDebuggerPerformance:
    def test_debug_overhead_acceptable(self):
        """Debug mode < 2x baseline for small datasets."""
        
    def test_debug_file_size_bounded(self):
        """Debug file < 4GB limit."""
```

## 11.4 Debug File Performance Tests [NEW]

```python
class TestDebugFilePerformance:
    def test_small_file_jump_latency(self):
        """Jump to bar < 500ms for files under 1GB."""
        
    def test_large_file_jump_latency(self):
        """Jump to bar < 1000ms for files 1-4GB."""
        
    def test_state_render_latency(self):
        """Render state at bar < 200ms."""
        
    def test_index_load_latency(self):
        """Load debug file index < 2000ms."""
        
    def test_4gb_file_usable(self):
        """4GB file navigable without UI freeze."""
```

---

# §12. Test Data Management

## 12.1 Synthetic Data Generators

| Generator | Use |
|-----------|-----|
| `linear_trend` | Trending market |
| `mean_revert` | Range-bound market |
| `random_walk` | Random baseline |
| `gap_series` | Gap up/down scenarios |
| `zero_volume` | Illiquid scenarios |

## 12.2 Fixtures

| Fixture | Contents |
|---------|----------|
| `AAPL_2020_2024_daily.parquet` | Real data, cleaned |
| `synthetic_1y_daily.csv` | Linear trend |
| `multi_asset_aligned.parquet` | 3 assets, aligned |
| `forward_fill_needed.parquet` | Missing bars |
| `unicode_filename_データ.csv` | Unicode filename test [NEW] |

## 12.3 Versioning

Test data versioned alongside code. Hash stored in `test_data_manifest.json`.

---

# §13. CI/CD Integration

## 13.1 Pipeline Stages

```
┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐   ┌─────────┐
│  Lint   │──►│  Unit   │──►│ Golden  │──►│  Build  │──►│   E2E   │
└─────────┘   └─────────┘   └─────────┘   └─────────┘   └─────────┘
```

## 13.2 Required Checks

| Check | Blocking |
|-------|----------|
| Lint | Yes |
| Unit tests | Yes |
| Golden tests | Yes |
| Coverage threshold | Yes |
| Security tests | Yes |
| E2E (smoke) | Yes |
| E2E (full) | Release only |

## 13.3 Coverage Gates

| Component | Gate |
|-----------|------|
| Engine | ≥ 80% |
| Critical paths | = 100% |
| New code | ≥ 90% |

---

# Appendix: Test Naming Convention

```
test_{module}_{scenario}_{expected_outcome}

Examples:
test_order_market_fills_at_open
test_portfolio_short_preserves_equity
test_metrics_sharpe_uses_simple_returns
test_exposure_concurrent_orders_reserve_correctly
test_daemon_ui_crash_continues_running
```

---

*End of Quantlab Test Specification V1.2*

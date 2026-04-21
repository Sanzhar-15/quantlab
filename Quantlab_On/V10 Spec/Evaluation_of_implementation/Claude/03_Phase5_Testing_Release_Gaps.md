# Phase 5: Testing & Release - Gap Analysis

**Spec Reference**: `06_Phase_5_Testing_Release.md`
**Current Completion**: ~5%

---

## 1. Golden Test Execution

**Spec Section**: Phase 5, §1
**Status**: NOT IMPLEMENTED
**Priority**: P0 - CRITICAL

### What Exists
- `tests/golden/runner.py` - Test runner framework
- `tests/golden/conftest.py` - Pytest configuration
- NO test vectors exist

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| All 88 golden test vectors | `tests/golden/vectors/*.json` | 3d |
| Synthetic data generators | `tests/golden/data.py` | 2d |
| Tolerance comparison logic | `tests/golden/compare.py` | 1d |
| CI integration | `.github/workflows/golden.yml` | 1d |
| Golden update workflow | `tests/golden/update.py` | 1d |

### Golden Test Categories (88 Total)

| Category | Test IDs | Count | Description |
|----------|----------|-------|-------------|
| Basic Execution | G001-G005 | 5 | Buy/hold, single trade, SMA crossover |
| Order Types | G010-G022 | 13 | MARKET, LIMIT, STOP, STOP_LIMIT |
| Time-in-Force | G030-G034 | 5 | GFD, GTC, IOC |
| Short Selling | G040-G049 | 10 | Entry, cover, collateral, borrow fees |
| Volume & Partial | G050-G055 | 6 | Partial fills, aggregate cap |
| Slippage | G060-G065 | 6 | Models: none, fixed_bps, volatility |
| Forward Fill | G070-G074 | 5 | Detection, signal blocking |
| Edge Cases | G080-G089 | 10 | Last bar, zero volume, NaN, gaps |
| Multi-Symbol | G090-G099 | 10 | Multiple assets, rebalancing |
| Exposure Reservation | G100-G105 | 6 | Concurrent orders, reservation |
| Implementation | CM001-CM005, TZ001-TZ004, UNI001-UNI003 | 12 | Codemod, timezone, universe |

### Golden Test Vector Format
```json
{
  "name": "G001 - Buy and Hold",
  "version": "1.0",
  "strategy": {
    "code": "def strategy(data): ...",
    "hash": "sha256:abc123..."
  },
  "data": {
    "type": "synthetic",
    "params": { "trend": 0.0002, "volatility": 0.02 }
  },
  "config": {
    "initial_capital": 100000,
    "fill_assumption": "next_open",
    "slippage": "none",
    "commission": "per_share:0.005"
  },
  "expected": {
    "total_return": 0.1523,
    "sharpe": 1.42,
    "trades": 1,
    "final_equity": 115230.00,
    "tolerance": 0.0001
  }
}
```

---

## 2. Live Trading Tests

**Spec Section**: Phase 5, §2
**Status**: NOT IMPLEMENTED
**Priority**: P0 - CRITICAL

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| Live test harness | `tests/live/harness.py` | 3d |
| Mock broker for live tests | `tests/live/mock_broker.py` | 2d |
| Paper trading tests | `tests/live/paper.py` | 2d |
| Safety tests | `tests/live/safety.py` | 2d |
| Failure/chaos tests | `tests/live/failure.py` | 3d |
| Flatten tests | `tests/live/flatten.py` | 2d |

### Paper Trading Tests (L001-L010)

| ID | Description | Expected |
|----|-------------|----------|
| L001 | Start paper session | Session active, daemon running |
| L002 | Paper order submit | Order accepted within 200ms |
| L003 | Paper order fill | Fill notification within 200ms |
| L004 | Paper partial fill | Correct partial handling |
| L005 | Paper order cancel | Cancellation within 500ms |
| L006 | Paper order reject | Error shown, session continues |
| L007 | Paper circuit breaker | Session paused on limit breach |
| L008 | Paper emergency flatten | All positions closed |
| L009 | Paper session stop | Clean shutdown |
| L010 | Paper reconnect | UI reconnects to running session |

### Live Trading Safety Tests (L020-L030)

| ID | Description | Expected |
|----|-------------|----------|
| L020 | Trust required for live | Cannot start without trust |
| L021 | Risk disclosure required | All checkboxes mandatory |
| L022 | Extension review required | Untrusted blocks live |
| L023 | Code change revokes trust | Trust revoked on edit |
| L024 | Max order size enforced | Oversized order rejected |
| L025 | Max position size enforced | Position limit respected |
| L026 | Daily loss limit enforced | Circuit breaker triggers |
| L027 | Max drawdown enforced | Circuit breaker triggers |
| L028 | Gross exposure enforced | Order rejected at limit |
| L029 | Concurrent order reservation | No exposure breach |
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

---

## 3. Performance Benchmarking

**Spec Section**: Phase 5, §3
**Status**: NOT IMPLEMENTED

### What Exists
- `benchmarks/runner.py` - Basic benchmark runner
- `benchmarks/strategies/` - Sample strategies

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| UI responsiveness measurements | `tests/perf/ui.py` | 1d |
| Live latency measurements | `tests/perf/live.py` | 1d |
| Debug file performance tests | `tests/perf/debug.py` | 1d |
| Profiling integration | `tests/perf/profile.py` | 1d |
| Regression report generation | `tests/perf/report.py` | 1d |

### Backtest Benchmarks

| Benchmark | Dataset | Target p95 | Max |
|-----------|---------|------------|-----|
| bench_small | 1Y daily (252 bars) | 0.5s | 2s |
| bench_medium | 5Y daily (1,260 bars) | 2.0s | 5s |
| bench_large | 1Y minute (98,280 bars) | 60s | 120s |
| bench_multi | 5Y 10-symbol | 10s | 15s |

### UI Responsiveness

| Operation | Target | Max |
|-----------|--------|-----|
| App launch | 3s | 5s |
| View switch | 100ms | 200ms |
| Chart render (10K points) | 200ms | 500ms |
| Cancel response | 100ms | 500ms |

### Live Trading Latency

| Operation | Target | Max |
|-----------|--------|-----|
| Signal to order submit | 50ms | 200ms |
| Order submit to ack | 100ms | 500ms |
| Fill notification | 50ms | 200ms |

---

## 4. Security Audit

**Spec Section**: Phase 5, §4
**Status**: NOT IMPLEMENTED

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| Secrets redaction tests | `tests/security/secrets.py` | 1d |
| Sandbox tests | `tests/security/sandbox.py` | 1d |
| Trust model tests | `tests/security/trust.py` | 1d |
| Path traversal tests | `tests/security/paths.py` | 0.5d |
| AI panel tests | `tests/security/ai.py` | 1d |

### Security Test Areas

| Area | Tests | Risk Level |
|------|-------|------------|
| Secrets Redaction | S001-S008 | HIGH |
| Strategy Sandbox | SB001-SB004 | HIGH |
| Trust Model | TR001-TR004 | HIGH |
| Path Traversal | PT001-PT002 | HIGH |
| AI Panel Security | AI001-AI005 | MEDIUM |

### Example Security Tests
```python
def test_api_key_redacted_in_logs():
    """API keys never appear in log files."""
    # Run session with API key
    # Scan all logs for key pattern
    assert not contains_pattern(logs, API_KEY_PATTERN)

def test_network_blocked():
    """Strategy cannot make network requests."""
    strategy = """
import requests
def strategy(data):
    requests.get('https://example.com')
    """
    with pytest.raises(NetworkBlockedError):
        run_strategy(strategy)
```

---

## 5. Documentation

**Spec Section**: Phase 5, §5
**Status**: NOT IMPLEMENTED

### What's Missing

| Document | Location | Effort |
|----------|----------|--------|
| Getting Started Guide | `docs/getting-started.md` | 2d |
| Strategy API Reference | `docs/api/` | 3d |
| Risk Management Guide | `docs/risk.md` | 1d |
| Architecture Overview | `docs/architecture.md` | 1d |
| P1 Runbook | `docs/runbooks/p1.md` | 1d |
| Deployment Guide | `docs/deployment.md` | 1d |
| Troubleshooting Guide | `docs/troubleshooting.md` | 1d |
| FAQ | `docs/faq.md` | 0.5d |

### Documentation Categories

| Category | Audience | Documents |
|----------|----------|-----------|
| User | New users | Getting Started, FAQ |
| Developer | Strategy devs | API Reference, Examples |
| Trader | Active traders | Risk Management, Troubleshooting |
| Operations | DevOps/Support | Deployment, Runbooks |

---

## 6. Release Preparation

**Spec Section**: Phase 5, §6
**Status**: NOT IMPLEMENTED

### What's Missing

| Component | File to Create | Effort |
|-----------|----------------|--------|
| Build scripts verification | `build/` | 1d |
| Code signing setup | `scripts/sign.sh` | 1d |
| Notarization workflow (macOS) | `scripts/notarize.sh` | 1d |
| Update manifest generation | `scripts/manifest.py` | 1d |
| Staged rollout configuration | Config files | 0.5d |
| Monitoring dashboard setup | External | 1d |

### Package Formats

| Platform | Format | Size Target |
|----------|--------|-------------|
| Windows | `.exe` (NSIS) | < 200 MB |
| macOS | `.dmg` | < 200 MB |
| Linux | `.AppImage`, `.deb` | < 200 MB |

### Code Signing

| Platform | Certificate |
|----------|-------------|
| Windows | EV Code Signing Certificate |
| macOS | Apple Developer ID + Notarization |
| Linux | GPG signature |

### Staged Rollout

| Stage | Percentage | Duration | Gate |
|-------|------------|----------|------|
| 1 | 5% | 24h | Crash rate < 0.5% |
| 2 | 25% | 48h | Crash rate < 0.5% |
| 3 | 100% | — | — |

---

## 7. Accessibility Audit

**Spec Section**: Phase 5 (from Phase 3 §7)
**Status**: NOT IMPLEMENTED

### What's Missing

| Component | Effort |
|-----------|--------|
| Keyboard navigation audit | 1d |
| ARIA labels for custom components | 2d |
| Color-independent chart indicators | 1d |
| Focus indicator styles | 0.5d |
| Screen reader testing | 1d |
| External accessibility review | 2d |

### WCAG 2.1 Level AA Requirements

| Requirement | Implementation |
|-------------|----------------|
| Keyboard navigation | All interactive elements focusable |
| Screen reader support | ARIA labels on custom components |
| Color-independent encoding | Icons/shapes alongside colors |
| Focus indicators | Visible focus rings |
| Text scaling | Support 200% text zoom |

---

## Phase 5 Total Effort Estimate

| Category | Effort |
|----------|--------|
| Golden Test Vectors (88) | 8d |
| Live Trading Tests (43) | 14d |
| Performance Benchmarks | 5d |
| Security Tests | 4.5d |
| Documentation | 10.5d |
| Release Preparation | 5.5d |
| Accessibility Audit | 7.5d |
| **TOTAL** | **~55 days** |

---

## Phase 5 Test Requirements

| Test Suite | Count |
|------------|-------|
| Golden Tests (G001-G105 + impl) | 88 |
| Live Trading (L001-L070) | 43 |
| Security Tests | ~25 |
| Performance Tests | ~15 |
| Accessibility Tests | ~10 |
| **TOTAL** | **~181 tests** |

---

## Go/No-Go Criteria

Before release, ALL of these must pass:

| Criterion | Required |
|-----------|----------|
| Golden tests passing | 88/88 (100%) |
| Live tests passing | 43/43 (100%) |
| Critical path coverage | 100% |
| P95 backtest benchmark | Within spec |
| Security audit | Clean |
| Accessibility audit | WCAG 2.1 Level AA |
| P1 runbook | Complete |

**Any failure = NO GO**

---

## Coverage Requirements

| Component | Minimum | Target |
|-----------|---------|--------|
| Engine (Python) | 80% | 90% |
| UI (TypeScript) | 70% | 85% |
| Adapters | 90% | 95% |
| **Critical paths** | **100%** | **100%** |

### Critical Paths (MUST be 100%)
- Order execution logic
- Portfolio accounting
- Risk limit enforcement
- Short selling calculations
- Checkpoint/resume logic
- Exposure reservation model
- Daemon lifecycle

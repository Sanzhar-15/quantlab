# Phase 5: Testing & Release

**Duration**: 4 weeks (+ 4 weeks buffer)
**Priority**: CRITICAL - Quality assurance before release
**Spec References**: Test Spec V1.2 (all sections)
**Decisions Reference**: C17, C18, C20, D21-D25, E26, I54-I57, N91

---

## Objectives

This phase ensures Quantlab V10 is production-ready:

1. **Golden Test Execution** - All 88 tests passing (76 spec golden G001-G105 + 12 implementation tests)
2. **Live Trading Tests** - All 43 live trading test vectors (L001-L070 with ID gaps)
3. **Performance Benchmarking** - Meet all latency targets (Decision D24: dedicated CI runner)
4. **Security Audit** - Internal required, external recommended (Decision E26)
5. **Accessibility Audit** - WCAG 2.1 Level AA: axe-core + manual + external (Decision D23)
6. **Calendar Maintenance** - Tooling verification (Decision C17)
7. **Documentation** - User guides, runbooks (Decision N91)
8. **Release Preparation** - Staged rollout with crash rate gates (Decision C20)

---

## 1. Golden Test Execution

### 1.1 Test Categories

**Spec Reference**: Test Spec §2

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

**Total Golden Tests**: 88 (76 spec tests G001-G105 with ID gaps + 12 implementation tests: CM001-CM005, TZ001-TZ004, UNI001-UNI003)

### 1.2 Golden Test Vector Format

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

### 1.3 Failure Protocol

1. Identify changed behavior
2. Determine: bug fix or regression?
3. If correct behavior: Update golden with documented reason
4. If regression: Fix code, do NOT update golden
5. Require 2 approvals for golden changes

### 1.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Golden test runner (Phase 0) | — | `tests/golden/runner.py` (already done) |
| Generate all 88 test vectors | 3d | `tests/golden/vectors/` (NEW) |
| Create synthetic data generators | 2d | `tests/golden/data.py` (NEW) |
| Tolerance comparison logic | 1d | `tests/golden/compare.py` (NEW) |
| CI integration | 1d | `.github/workflows/golden.yml` (NEW) |
| Golden update workflow | 1d | `tests/golden/update.py` (NEW) |

### 1.5 Execution Schedule

| Week | Tests | Focus |
|------|-------|-------|
| 27 | G001-G034 | Basic, Orders, TIF |
| 27 | G040-G065 | Short, Volume, Slippage |
| 28 | G070-G105 | Forward Fill, Edge, Multi, Exposure |

---

## 2. Live Trading Tests

### 2.1 Test Categories

**Spec Reference**: Test Spec §5.3

| Category | Test IDs | Count | Description |
|----------|----------|-------|-------------|
| Paper Trading | L001-L010 | 10 | Session lifecycle, orders, fills |
| Live Trading Safety | L020-L030 | 11 | Trust, risk limits, exposure |
| Live Trading Failure | L040-L050 | 11 | Disconnect, crash, reconciliation |
| Emergency Flatten | L060-L070 | 11 | Flatten protocol, out-of-hours |

**Total Live Trading Tests**: 43

### 2.2 Paper Trading Tests (L001-L010)

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

### 2.3 Live Trading Safety Tests (L020-L030)

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

### 2.4 Live Trading Failure Tests (L040-L050)

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

### 2.5 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Live test harness | 3d | `tests/live/harness.py` (NEW) |
| Mock broker for live tests | 2d | `tests/live/mock_broker.py` (NEW) |
| Paper trading tests | 2d | `tests/live/paper.py` (NEW) |
| Safety tests | 2d | `tests/live/safety.py` (NEW) |
| Failure/chaos tests | 3d | `tests/live/failure.py` (NEW) |
| Flatten tests | 2d | `tests/live/flatten.py` (NEW) |

### 2.6 Execution Schedule

| Week | Tests | Environment |
|------|-------|-------------|
| 28 | L001-L010 | Mock broker |
| 28 | L020-L030 | Mock broker |
| 29 | L040-L050 | Chaos environment |
| 29 | L060-L070 | Mock broker |

---

## 3. Performance Benchmarking

### 3.1 Backtest Benchmarks

**Spec Reference**: Technical Spec §13.1

| Benchmark | Dataset | Target p95 | Max |
|-----------|---------|------------|-----|
| `bench_small` | 1Y daily (252 bars) | 0.5s | 2s |
| `bench_medium` | 5Y daily (1,260 bars) | 2.0s | 5s |
| `bench_large` | 1Y minute (98,280 bars) | 60s | 120s |
| `bench_multi` | 5Y 10-symbol | 10s | 15s |

### 3.2 UI Responsiveness

**Spec Reference**: Technical Spec §13.2

| Operation | Target | Max |
|-----------|--------|-----|
| App launch | 3s | 5s |
| View switch | 100ms | 200ms |
| Chart render (10K points) | 200ms | 500ms |
| Cancel response | 100ms | 500ms |

### 3.3 Live Trading Latency

**Spec Reference**: Technical Spec §13.3

| Operation | Target | Max |
|-----------|--------|-----|
| Signal to order submit | 50ms | 200ms |
| Order submit to ack | 100ms | 500ms |
| Fill notification | 50ms | 200ms |

### 3.4 Debug File Performance

**Spec Reference**: Technical Spec §19.5

| Operation | Target | Max |
|-----------|--------|-----|
| Jump to bar (< 1GB) | 100ms | 500ms |
| Jump to bar (1-4GB) | 200ms | 1000ms |
| Render state at bar | 50ms | 200ms |
| Load debug index | 500ms | 2000ms |

### 3.5 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Benchmark runner (from Phase 1) | — | Already done |
| UI responsiveness measurements | 1d | `tests/perf/ui.py` (NEW) |
| Live latency measurements | 1d | `tests/perf/live.py` (NEW) |
| Debug file performance tests | 1d | `tests/perf/debug.py` (NEW) |
| Profiling integration | 1d | `tests/perf/profile.py` (NEW) |
| Regression report generation | 1d | `tests/perf/report.py` (NEW) |

### 3.6 Execution Schedule

| Week | Focus |
|------|-------|
| 28 | Backtest benchmarks |
| 29 | UI, Live, Debug file |
| 29 | Optimization if needed |

---

## 4. Security Audit

**Decision Reference**: E26 — Internal required, external recommended

### 4.1 Audit Strategy

| Audit Type | Requirement | Focus |
|------------|-------------|-------|
| Internal | **Required** | All areas below |
| External | **Recommended** | Daemon IPC, broker integration |

### 4.2 Audit Areas

**Spec Reference**: Test Spec §6

| Area | Tests | Risk Level |
|------|-------|------------|
| Secrets Redaction | S001-S008 | HIGH |
| Strategy Sandbox | SB001-SB004 | HIGH |
| Trust Model | TR001-TR004 | HIGH |
| Path Traversal | PT001-PT002 | HIGH |
| AI Panel Security | AI001-AI005 | MEDIUM |

### 4.2 Secrets Redaction Tests

```python
def test_api_key_redacted_in_logs():
    """API keys never appear in log files."""
    # Run session with API key
    # Scan all logs for key pattern
    assert not contains_pattern(logs, API_KEY_PATTERN)

def test_crash_dump_redacted():
    """Crash dumps have secrets removed."""
    # Trigger crash
    # Scan dump for secrets
    assert not contains_secrets(crash_dump)
```

### 4.3 Sandbox Tests

```python
def test_network_blocked():
    """Strategy cannot make network requests."""
    strategy = """
import requests
def strategy(data):
    requests.get('https://example.com')
    """
    with pytest.raises(NetworkBlockedError):
        run_strategy(strategy)

def test_filesystem_restricted():
    """Strategy can only access allowed paths."""
    strategy = """
def strategy(data):
    open('/etc/passwd').read()
    """
    with pytest.raises(FileAccessDeniedError):
        run_strategy(strategy)
```

### 4.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Secrets redaction tests | 1d | `tests/security/secrets.py` (NEW) |
| Sandbox tests | 1d | `tests/security/sandbox.py` (NEW) |
| Trust model tests | 1d | `tests/security/trust.py` (NEW) |
| Path traversal tests | 0.5d | `tests/security/paths.py` (NEW) |
| AI panel tests | 1d | `tests/security/ai.py` (NEW) |
| External security review | 3d | — (if budget allows, focus on daemon + broker) |

### 4.6 Execution Schedule

| Week | Focus |
|------|-------|
| 29 | Internal security tests |
| 30 | External review (if applicable) |

---

## 5. Documentation

### 5.1 User Documentation

| Document | Audience | Priority |
|----------|----------|----------|
| Getting Started Guide | New users | HIGH |
| Strategy API Reference | Developers | HIGH |
| Risk Management Guide | Traders | HIGH |
| Troubleshooting Guide | All | MEDIUM |
| FAQ | All | MEDIUM |

### 5.2 Technical Documentation

| Document | Audience | Priority |
|----------|----------|----------|
| Architecture Overview | Engineers | HIGH |
| API Reference | Engineers | HIGH |
| Data Schemas | Engineers | HIGH |
| Debug File Format | Engineers | MEDIUM |

### 5.3 Operational Documentation

| Document | Audience | Priority |
|----------|----------|----------|
| Deployment Guide | DevOps | HIGH |
| Runbook: P1 Incidents | On-call | HIGH |
| Calendar Update Procedure | Support | MEDIUM |
| Rollback Procedure | DevOps | HIGH |

### 5.4 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Getting Started Guide | 2d | `docs/getting-started.md` (NEW) |
| Strategy API Reference | 3d | `docs/api/` (NEW) |
| Risk Management Guide | 1d | `docs/risk.md` (NEW) |
| Architecture Overview | 1d | `docs/architecture.md` (NEW) |
| P1 Runbook | 1d | `docs/runbooks/p1.md` (NEW) |
| Deployment Guide | 1d | `docs/deployment.md` (NEW) |

### 5.5 Execution Schedule

| Week | Focus |
|------|-------|
| 27-28 | User documentation |
| 28-29 | Technical documentation |
| 30 | Operational documentation |

---

## 6. Release Preparation

### 6.1 Package Formats

**Spec Reference**: Operations Spec §1.2

| Platform | Format | Size Target |
|----------|--------|-------------|
| Windows | `.exe` (NSIS) | < 200 MB |
| macOS | `.dmg` | < 200 MB |
| Linux | `.AppImage`, `.deb` | < 200 MB |

### 6.2 Code Signing

| Platform | Certificate |
|----------|-------------|
| Windows | EV Code Signing Certificate |
| macOS | Apple Developer ID + Notarization |
| Linux | GPG signature |

### 6.3 Staged Rollout

**Spec Reference**: Operations Spec §2.3

| Stage | Percentage | Duration | Gate |
|-------|------------|----------|------|
| 1 | 5% | 24h | Crash rate < 0.5% |
| 2 | 25% | 48h | Crash rate < 0.5% |
| 3 | 100% | — | — |

### 6.4 Release Checklist

**Pre-Release**:
- [ ] All 88 golden tests passing
- [ ] All 43 live tests passing
- [ ] Performance benchmarks met
- [ ] Security audit clean
- [ ] **Accessibility audit passed** (WCAG 2.1 Level AA)
- [ ] Documentation complete
- [ ] Changelog updated
- [ ] Calendar data current

**Release**:
- [ ] Packages built
- [ ] Packages signed
- [ ] Packages uploaded to CDN
- [ ] Version manifest updated
- [ ] Release notes published

**Post-Release**:
- [ ] Monitor crash rate (24h)
- [ ] Monitor error rate (24h)
- [ ] Monitor support tickets
- [ ] Staged rollout progression

### 6.5 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| Build scripts verification | 1d | `build/` |
| Code signing setup | 1d | `scripts/sign.sh` |
| Notarization workflow (macOS) | 1d | `scripts/notarize.sh` |
| Update manifest generation | 1d | `scripts/manifest.py` |
| Staged rollout configuration | 0.5d | Config files |
| Monitoring dashboard setup | 1d | — |

### 6.6 Execution Schedule

| Week | Focus |
|------|-------|
| 30 | Build verification, signing |
| 30 | Release candidate |
| W31+ | Staged rollout (in final buffer) |

---

## Phase 5 Deliverables Checklist

### Week 27
- [ ] Golden test runner complete
- [ ] G001-G065 passing
- [ ] Live test harness complete
- [ ] Documentation started

### Week 28
- [ ] G070-G105 + implementation tests passing (all 88 golden tests)
- [ ] L001-L030 passing (paper + safety)
- [ ] Backtest benchmarks met
- [ ] User documentation complete
- [ ] **Accessibility audit started**

### Week 29
- [ ] L040-L070 passing (all 43 live tests)
- [ ] All performance benchmarks met
- [ ] Security tests passing
- [ ] Technical documentation complete

### Week 30
- [ ] External security review (if applicable)
- [ ] **Accessibility audit complete**
- [ ] Operational documentation complete
- [ ] Packages signed and tested
- [ ] Release candidate ready

---

## Testing Summary

### Total Test Count

| Category | Count | Phase |
|----------|-------|-------|
| Golden Tests (G001-G105 + CM, TZ, UNI) | 88 | 2, 5 |
| Live Trading Tests (L001-L070) | 43 | 4, 5 |
| Phase 4 Implementation Tests | 33 | 4 |
| UI/Safety Tests (incl. Hot-Reload, Risk Wizard) | 39 | 3 |
| Infrastructure Tests (D011-D014, E010-E011, S009-S012) | 10 | 1 |
| Security Tests | ~25 | 5 |
| Performance Tests | ~15 | 5 |
| **Total** | **~253** |

### Coverage Requirements

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
- Short selling calculations
- Checkpoint/resume logic
- Exposure reservation model
- Daemon lifecycle

---

## Go/No-Go Criteria

Before release:

| Criterion | Required |
|-----------|----------|
| Golden tests passing | 88/88 (100%) |
| Live tests passing | 43/43 (100%) |
| Critical path coverage | 100% |
| P95 backtest benchmark | Within spec |
| Security audit | Clean |
| **Accessibility audit** | **WCAG 2.1 Level AA** |
| P1 runbook | Complete |

**Any failure = NO GO**

---

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Golden test failures | Medium | HIGH | Early test creation, fix immediately |
| Performance regression | Low | Medium | Benchmark in CI, catch early |
| Security vulnerability | Low | HIGH | External review, bug bounty |
| Release deadline slip | Medium | Medium | Buffer week built in |

---

## Post-Release Plan

### Week 31+ (Final Buffer)

1. **Monitor** staged rollout metrics
2. **Respond** to crash reports within SLA
3. **Hotfix** P1 issues within 48h
4. **Progress** through rollout stages
5. **Retrospective** after 100% rollout

### Support Preparation

- On-call rotation established
- P1 runbook reviewed by team
- Monitoring alerts configured
- Rollback procedure tested

---

*Phase 5 completion means Quantlab V10 is production-ready and released.*

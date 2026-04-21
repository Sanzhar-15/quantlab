# Quantlab Operations Specification V1.3
## Deployment, Updates, Release Management

**Product**: Quantlab — Quantitative Trading Development Environment  
**Company**: Delta Plus  
**Version**: 1.3 FINAL  
**Date**: 2026-01-25  
**Status**: Approved for Implementation

---

## Document Control

### Canonical Document Set
| Document | Version | Audience |
|----------|---------|----------|
| Product Specification | V10.5 | Product, Design, Frontend |
| Technical Specification | V2.5 | Backend, Engine, QA |
| **This Document** | V1.3 | DevOps, Release, Support |
| Test Specification | V1.2 | QA, Engineering |
| Design System | V1.0 | Design, Frontend |

### Changes from V1.2
| Section | Change |
|---------|--------|
| §2.3 | Added live session protection for auto-updates |
| §2.6.1 | **NEW**: Quote validation for emergency flatten |
| §2.6.2 | **NEW**: Out-of-hours flatten handling |
| §6.1 | Revised VS Code fork maintenance estimates |
| §7 | **NEW**: Calendar Maintenance procedures |

---

## Table of Contents

1. Distribution Architecture
2. Update System
3. Configuration Management
4. Platform Requirements
5. Monitoring & Telemetry
6. VS Code Fork Maintenance
7. Calendar Maintenance
8. Incident Response
9. Backup & Recovery
10. Support Procedures

---

# §1. Distribution Architecture

## 1.1 Distribution Channels

| Channel | Update Frequency | Audience |
|---------|------------------|----------|
| **Stable** | Monthly | General users |
| **Beta** | Bi-weekly | Opt-in testers |
| **Canary** | Daily | Internal only |

## 1.2 Package Formats

| Platform | Format | Size Target |
|----------|--------|-------------|
| Windows | `.exe` (NSIS) | < 200 MB |
| macOS | `.dmg` | < 200 MB |
| Linux | `.AppImage`, `.deb` | < 200 MB |

## 1.3 Code Signing

| Platform | Certificate |
|----------|-------------|
| Windows | EV Code Signing Certificate |
| macOS | Apple Developer ID + Notarization |
| Linux | GPG signature |

---

# §2. Update System

## 2.1 Update Check

- **Frequency**: Every 24 hours (when app running)
- **Manual**: Help → Check for Updates
- **Protocol**: HTTPS to update server
- **Payload**: Version manifest with checksums

## 2.2 Update Flow

```
App Running
     │
     ▼
Check for Updates (background)
     │
     ├─── No update → Continue
     │
     └─── Update available
              │
              ▼
         Show notification
         "Update available: v1.2.3"
         [Update Now] [Later] [Skip]
              │
              ├─── Later → Remind in 24h
              │
              ├─── Skip → Skip this version
              │
              └─── Update Now
                        │
                        ▼
                   Check for active sessions [NEW]
                        │
                        ├─── Live session active → Block update
                        │    "Cannot update during live trading"
                        │
                        └─── No session → Download in background
                                  │
                                  ▼
                             Verify checksum
                                  │
                                  ▼
                             Prompt restart
                             "Restart to complete update"
```

## 2.3 Staged Rollout

| Stage | Percentage | Duration | Gate |
|-------|------------|----------|------|
| 1 | 5% | 24h | Crash rate < 0.5% |
| 2 | 25% | 48h | Crash rate < 0.5% |
| 3 | 100% | — | — |

### Rollback Trigger

Automatic rollback if:
- Crash rate > 2% in first 24h
- Critical error reports > 10
- Manual override by on-call

### Live Session Protection [NEW]

**Auto-updates MUST NOT occur during active trading sessions.**

| Session State | Update Behavior |
|---------------|-----------------|
| No session | Update normally |
| Paper trading active | Show warning, defer |
| **Live trading active** | **Block update entirely** |

When live session prevents update:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠ UPDATE DEFERRED                                                            │
│                                                                              │
│ An update is available, but cannot be installed while live trading.         │
│                                                                              │
│ Current session: strategy.py (LIVE)                                         │
│ Update pending: v1.2.3 → v1.2.4                                             │
│                                                                              │
│ The update will be installed after your trading session ends.               │
│                                                                              │
│                                                              [OK]            │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 2.4 Offline Support

- App functions fully offline after initial setup
- Updates require internet
- Data sync requires internet
- Broker connection requires internet

---

# §2.5 Emergency Patches

For critical security or data-loss bugs:

1. **Bypass staged rollout** — push to 100%
2. **Force update prompt** — modal on launch
3. **Communication**: Email + in-app banner

## 2.6 Emergency Flatten Protocol

### Overview

Emergency flatten executes a **two-stage approach**:

1. **Stage 1**: Marketable limit orders (IOC)
   - Price: `bid - 2×spread` (longs) or `ask + 2×spread` (shorts)
   - Timeout: 2 seconds
   
2. **Stage 2**: Market order fallback
   - Triggered if Stage 1 incomplete
   - No price protection

### Order Identification

```
Client Order ID: FLATTEN-{session_id}-{symbol}-{attempt}

Examples:
- FLATTEN-abc123-AAPL-1
- FLATTEN-abc123-AAPL-2 (retry)
```

### Retry Strategy

| Attempt | Delay | Order Type |
|---------|-------|------------|
| 1 | 0ms | Stage 1 (limit) |
| 2 | 100ms | Stage 1 (limit) |
| 3 | 500ms | Stage 2 (market) |
| 4 | 1s | Stage 2 (market) |
| 5 | 2s | Stage 2 (market) |
| 6 | 5s | Stage 2 (market) |

### Logging

All flatten actions logged to:
- Session ledger (durable)
- `~/.quantlab/logs/flatten_{timestamp}.log`

### 2.6.1 Quote Validation [NEW]

Before sending flatten orders, validate quote quality:

```python
def validate_quote(symbol: str, quote: Quote) -> QuoteStatus:
    if quote is None:
        return QuoteStatus.MISSING
    
    if quote.age_seconds > 30:
        return QuoteStatus.STALE
    
    if quote.bid <= 0 or quote.ask <= 0:
        return QuoteStatus.INVALID
    
    if quote.spread_pct > 10.0:  # > 10% spread
        return QuoteStatus.WIDE
    
    return QuoteStatus.VALID

def flatten_position(position: Position):
    quote = get_quote(position.symbol)
    status = validate_quote(position.symbol, quote)
    
    if status == QuoteStatus.VALID:
        # Stage 1: Marketable limit
        price = calculate_limit_price(position, quote)
        send_limit_ioc(position.symbol, price)
        
    elif status in (QuoteStatus.MISSING, QuoteStatus.STALE, QuoteStatus.INVALID):
        # Skip to Stage 2: Market order immediately
        log.warning(f"Invalid quote for {position.symbol}, using MARKET order")
        send_market_order(position.symbol)
        
    elif status == QuoteStatus.WIDE:
        # Use aggressive limit to avoid extreme slippage
        price = quote.bid * 0.95 if position.is_long else quote.ask * 1.05
        send_limit_ioc(position.symbol, price)
        # Fallback to market after 5s instead of 2s
```

### 2.6.2 Out-of-Hours Handling [NEW]

| Market State | Flatten Behavior |
|--------------|------------------|
| Regular hours | Normal two-stage protocol |
| Pre/post market | Market order only (limited liquidity) |
| Market closed | Queue for next open + ALERT user |

**When market is closed:**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠ MARKET CLOSED                                                              │
│                                                                              │
│ The market is currently closed. Emergency flatten options:                  │
│                                                                              │
│ ○ Queue for Market Open                                                     │
│   Orders will execute when market opens at 9:30 AM ET                       │
│                                                                              │
│ ○ Use Extended Hours (if available)                                         │
│   Limited liquidity, wider spreads expected                                 │
│                                                                              │
│ ○ Cancel (keep positions)                                                   │
│                                                                              │
│                                              [Cancel] [Proceed]              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

# §3. Configuration Management

## 3.1 Configuration Hierarchy

```
1. Built-in defaults (lowest priority)
2. System config (/etc/quantlab/ or equivalent)
3. User config (~/.quantlab/config.json)
4. Workspace config (.quantlab/config.json)
5. Environment variables (highest priority)
```

## 3.2 Configuration Schema

```typescript
interface QuantlabConfig {
  // Version for migration
  schemaVersion: string;
  
  // Data
  dataDirectory: string;
  cacheDirectory: string;
  
  // Engine
  maxConcurrentJobs: number;
  defaultMemoryLimit: string;
  
  // Trading
  defaultBroker: string;
  riskLimits: RiskLimitConfig;
  
  // UI
  theme: 'light' | 'dark' | 'system';
  fontSize: number;
  
  // Telemetry
  telemetryEnabled: boolean;
}
```

## 3.3 Sensitive Configuration

**Never stored in config files:**
- API keys
- Broker credentials
- Passwords

**Stored in OS Keychain or encrypted fallback** (see Tech Spec §11.1).

---

# §4. Platform Requirements

## 4.1 Minimum Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| OS (Windows) | 10 (64-bit) | 11 |
| OS (macOS) | 11 Big Sur | 14 Sonoma |
| OS (Linux) | Ubuntu 20.04 | Ubuntu 22.04 |
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Storage | 2 GB free | 10 GB free |
| Display | 1280×720 | 1920×1080 |

## 4.2 Supported Browsers (for Docs)

| Browser | Minimum |
|---------|---------|
| Chrome | 100+ |
| Firefox | 100+ |
| Safari | 15+ |
| Edge | 100+ |

## 4.3 Network Requirements

| Service | Protocol | Ports |
|---------|----------|-------|
| Updates | HTTPS | 443 |
| Broker API | HTTPS/WSS | 443 |
| Telemetry | HTTPS | 443 |

---

# §5. Monitoring & Telemetry

## 5.1 Collected Telemetry (Opt-In)

| Category | Examples | PII |
|----------|----------|-----|
| Usage | Feature usage, session duration | No |
| Performance | Backtest duration, memory usage | No |
| Errors | Crash reports, error codes | No* |

*Crash reports sanitized to remove file paths, strategy code.

## 5.2 NOT Collected

- Strategy code (never)
- Trading history (never)
- Portfolio values (never)
- Broker credentials (never)
- Personal information (never)

## 5.3 Telemetry Settings

```
Settings → Privacy → Telemetry

○ Off — No data sent
○ Errors only — Crash reports only
● Full — Usage + Performance + Errors (default: OFF)
```

## 5.4 Metrics Dashboard (Internal)

| Metric | Alert Threshold |
|--------|-----------------|
| Crash rate | > 0.5% |
| Error rate | > 5% |
| P95 backtest time | > 2× baseline |
| Update adoption | < 50% after 7d |

---

# §6. VS Code Fork Maintenance

## 6.1 Fork Strategy

Quantlab uses a **thin fork** of VS Code:

| Component | Approach |
|-----------|----------|
| Window chrome | Custom (fork) |
| Tab indicators | Custom (fork) |
| Activity Bar panels | Extension |
| Views | Extension |
| AI Panel | Extension |

### Maintenance Estimates [REVISED]

| Task | Frequency | Effort |
|------|-----------|--------|
| Upstream merge | Monthly | 1-2 engineer-weeks |
| Conflict resolution | Monthly | 2-8 hours (varies) |
| Regression testing | Monthly | 1-2 days |
| Security patches | As needed (48h SLA) | 4-16 hours |

**Annual estimate**: ~3-4 engineer-months dedicated to fork maintenance.

### Alternative Considered

Standard VS Code + Extension Pack:
- Pros: No fork maintenance
- Cons: Cannot customize window chrome, tab stripes require workarounds

**Decision**: Fork justified for integrated trading UX, but minimize fork surface area.

## 6.2 Patch Management

All VS Code patches tracked in `PATCHES.md`:

```markdown
# VS Code Patches

## Active Patches

### P001 - Window Chrome Trading Controls
- **File**: src/vs/workbench/browser/parts/titlebar/titlebar.ts
- **Purpose**: Add symbol/timeframe selectors to title bar
- **Upstream Issue**: N/A (Quantlab-specific)

### P002 - Tab Indicator Stripes
- **File**: src/vs/workbench/browser/parts/editor/tabbar.ts
- **Purpose**: Color stripes for Chart/Action/Trade views
- **Upstream Issue**: N/A (Quantlab-specific)
```

## 6.3 Security Patch SLA

| Severity | SLA |
|----------|-----|
| Critical | 48 hours |
| High | 7 days |
| Medium | 30 days |
| Low | Next release |

## 6.4 Upstream Tracking

- Watch VS Code releases (monthly)
- Review changelogs for conflicts
- Maintain test suite for patched areas
- Document any upstream PRs we depend on

---

# §7. Calendar Maintenance [NEW]

## 7.1 Calendar Update Procedure

Market calendars (NYSE, NASDAQ, etc.) require annual updates for holidays.

### Update Schedule

| Calendar | Update Timing | Source |
|----------|---------------|--------|
| NYSE | December (for next year) | NYSE website |
| NASDAQ | December (for next year) | NASDAQ website |
| Crypto | N/A (24/7) | — |

### Update Process

1. **Source holidays** from official exchange websites
2. **Update YAML files** in `calendars/` directory
3. **Validate** against previous year for consistency
4. **Test** affected backtests for calendar alignment
5. **Release** in December update

### Emergency Calendar Updates

For unexpected market closures (e.g., national mourning):

1. **Push calendar update** within 24 hours
2. **Notify users** via in-app banner
3. **Backfill** historical data if needed

## 7.2 Calendar Validation

```python
def validate_calendar(calendar: Calendar, year: int):
    """Validate calendar for common issues."""
    
    # Check reasonable number of holidays
    holidays = calendar.holidays_for_year(year)
    assert 8 <= len(holidays) <= 15, f"Unexpected holiday count: {len(holidays)}"
    
    # Check no weekends marked as trading days
    for day in calendar.trading_days(year):
        assert day.weekday() < 5, f"Weekend marked as trading: {day}"
    
    # Check early closes are on valid days
    for early_close in calendar.early_closes_for_year(year):
        assert early_close.date in calendar.trading_days(year)
```

---

# §8. Incident Response

## 8.1 Severity Levels

| Level | Definition | Response Time |
|-------|------------|---------------|
| P1 | Data loss, security breach, live trading failure | 15 min |
| P2 | Major feature broken, crashes | 1 hour |
| P3 | Minor feature broken | 1 business day |
| P4 | Cosmetic, documentation | Next release |

## 8.2 P1 Runbook

1. **Acknowledge** within 15 minutes
2. **Assess** scope and impact
3. **Communicate** via status page
4. **Mitigate** (rollback if needed)
5. **Resolve** root cause
6. **Post-mortem** within 48 hours

## 8.3 Communication Channels

| Audience | Channel |
|----------|---------|
| Users | Status page, in-app banner |
| Internal | Slack #incidents |
| Management | Email escalation |

---

# §9. Backup & Recovery

## 9.1 User Data Backup

**Quantlab does NOT provide cloud backup.** Users responsible for:
- Strategy code (recommend: Git)
- Configuration
- Historical data (if local)

## 9.2 Workspace Recovery

On corruption detection:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠ WORKSPACE ISSUE DETECTED                                                   │
│                                                                              │
│ Your workspace configuration appears corrupted.                             │
│                                                                              │
│ Options:                                                                    │
│ ○ Attempt auto-repair                                                       │
│ ○ Reset to defaults (preserves code files)                                  │
│ ○ Open in recovery mode                                                     │
│                                                                              │
│                                              [Choose]                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 9.3 Session Ledger Recovery

Session ledgers are append-only with CRC32 per entry.

On corruption:
1. Read entries until first corrupted
2. Recover valid entries
3. Alert user to potential data loss
4. Offer position reconciliation with broker

---

# §10. Support Procedures

## 10.1 Support Channels

| Channel | Response SLA | Use |
|---------|--------------|-----|
| Documentation | Self-service | First line |
| Community Forum | Best effort | General questions |
| Email Support | 2 business days | Account issues |
| Priority Support | 4 hours | Paid tier |

## 10.2 Diagnostic Collection

When user reports issue:

```
Help → Collect Diagnostics

This will collect:
☑ Application logs (last 7 days)
☑ Configuration (secrets redacted)
☑ System information
☐ Recent backtest artifacts (optional)

[Cancel] [Collect & Save]
```

**Output**: `quantlab_diagnostics_{timestamp}.zip`

## 10.3 Known Issues Database

Maintain public known issues list:
- Issue description
- Affected versions
- Workaround (if available)
- Fix ETA

---

# Appendix A: Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `QUANTLAB_DATA_DIR` | Data directory | `~/.quantlab/data` |
| `QUANTLAB_LOG_LEVEL` | Logging verbosity | `info` |
| `QUANTLAB_TELEMETRY` | Override telemetry | (unset) |
| `QUANTLAB_MASTER_KEY` | Secrets unlock key | (unset) |

---

# Appendix B: Release Checklist

## Pre-Release

- [ ] All tests passing
- [ ] Changelog updated
- [ ] Documentation updated
- [ ] Security scan clean
- [ ] Performance benchmarks met
- [ ] Accessibility audit passed
- [ ] Calendar data current (if December release)

## Release

- [ ] Packages signed
- [ ] Packages uploaded to CDN
- [ ] Version manifest updated
- [ ] Release notes published
- [ ] Staged rollout started

## Post-Release

- [ ] Monitor crash rate (24h)
- [ ] Monitor error rate (24h)
- [ ] Monitor support tickets
- [ ] Post-release retro (if issues)

---

*End of Quantlab Operations Specification V1.3*

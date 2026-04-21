# Final Comprehensive Audit: Merged Implementation Plan

**Date**: January 26, 2026  
**Auditor**: Claude (Anthropic)  
**Scope**: Deep verification against Implementation Decisions document  
**Status**: ISSUES FOUND — FIXES REQUIRED

---

## Executive Summary

After thorough verification against the **actual Implementation Decisions document**, I have identified **12 issues** requiring fixes. ChatGPT correctly identified 6 of these; I found 6 additional issues that both evaluations missed.

| Category | Count | Severity |
|----------|-------|----------|
| ChatGPT-identified issues (verified ✅) | 6 | HIGH-MEDIUM |
| Additional issues I found | 6 | MEDIUM-LOW |
| **Total fixes required** | **12** | — |

**Estimated fix time**: ~4-5 hours

---

## Part 1: ChatGPT's Issues — ALL VERIFIED CORRECT ✅

I verified each of ChatGPT's claims against the actual `Quantlab_Implementation_Decisions.md` file:

### Issue 1: Trust Scope/Revocation (H44/H45/H46) — **VERIFIED** ✅

**Decision H44 states**: Trust is **per-workspace**  
**Decision H45 states**: Major/**minor** updates revoke trust; **patch** retains  
**Decision H46 states**: Revocation only on **strategy file changes**, not any file

**Plan says (04_Phase_3_UI_Safety.md line ~250)**:
```markdown
| Workspace | All files trusted | Any file edit |     ← WRONG (should be strategy files only)
| Extensions | Review required | Major update |      ← WRONG (should be minor + major)
```

**Plan also says**:
```markdown
| Trust storage (workspace/global) | 1d |           ← WRONG (should be per-workspace only)
```

**VERDICT**: ChatGPT is correct. Must fix.

---

### Issue 2: AI Provider Scope (G37) — **VERIFIED** ✅

**Decision G37 states**: "V1 ships with Claude support only" / "V2: Add OpenAI, local models"

**Plan says (04_Phase_3_UI_Safety.md)**:
```markdown
| API integration (Anthropic/OpenAI) | 2d |         ← WRONG (OpenAI is V2)
```

**VERDICT**: ChatGPT is correct. Remove OpenAI from V1 scope.

---

### Issue 3: Data Provider in UI Example (B12) — **VERIFIED** ✅

**Decision B12 states**: "Alpaca Data API" only for V1

**Plan says (04_Phase_3_UI_Safety.md UI mockup)**:
```
│ ✓ Data Feed                      Polygon connected, 50ms latency  ← WRONG
```

**VERDICT**: ChatGPT is correct. Should say "Alpaca connected".

---

### Issue 4: Corporate Actions (L71) — **VERIFIED** ✅

**Decision L71 states**: "Deferred to V1.1 (ADJUST_PRICES mode only in V1.0)"

**Plan says (05_Phase_4_Live_Trading.md)**:
```markdown
| Corporate action detection | 2d | `engine/data/corporate.py` |  ← WRONG (V1.1 work)
| L049 | Corporate actions diagnosed correctly |                    ← WRONG (V1.1 test)
```

**VERDICT**: ChatGPT is correct. Mark as V1.1.

---

### Issue 5: Secrets Key Rotation (H47) — **VERIFIED** ✅

**Decision H47 states**: "User-initiated rotation only"

**Implementation required**:
- Key derived from master password (Argon2id)
- User can change password and re-encrypt all secrets

**Plan (02_Phase_1_Critical_Infrastructure.md)**: No mention of password change or re-encryption workflow.

**VERDICT**: ChatGPT is correct. Must add key rotation workflow.

---

### Issue 6: Update Infrastructure Checkpoint (I55) — **VERIFIED** ✅

**Decision I55 states**:
```
**Decision**: Use electron-updater (standard for Electron apps)
...
**Check**: Inspect VS Code fork for existing update infrastructure.
```

**Plan says (Appendix_A_Build_Packaging.md)**:
```markdown
| I55 | Auto-update: electron-updater |                ← Missing the "Check" condition
```

**VERDICT**: ChatGPT is correct. Add Phase 0 checkpoint to evaluate VS Code updater first.

---

## Part 2: Additional Issues Found (ChatGPT Missed These)

### Issue 7: Daemon No Auto-Restart (L69 + N99) — **NEW** ⚠️

**Decision L69 states**: "No — manual restart required"  
**Decision N99 states**: "NO auto-restart (avoid surprise trading)"

**Plan says**: Neither L69 nor N99's "NO auto-restart" requirement is explicitly documented anywhere in the implementation.

The watchdog section (02_Phase_1_Critical_Infrastructure.md) says:
```markdown
| Implement daemon watchdog | 2d | `engine/daemon/watchdog.py` (NEW) |
```

But doesn't specify that the watchdog should **NOT** auto-restart the daemon.

**FIX REQUIRED**: Add explicit documentation that:
1. Daemon does not auto-start after OS reboot (L69)
2. Watchdog shows dialog but does NOT auto-restart (N99)

---

### Issue 8: Strategy Hot-Reload UI Flow (H52) — **NEW** ⚠️

**Decision H52 states**:
```
1. File watcher detects strategy change
2. Toast: "Strategy modified during live session"
3. Options: "Pause Session" | "Continue (code unchanged)" | "Restart with New Code"
4. Trust automatically revoked, requiring re-trust for "Restart"
```

**Plan says**: There's a file watcher for trust revocation, but the specific UI flow with three options is not documented.

**FIX REQUIRED**: Add H52 implementation section to Phase 3 or Phase 4 with:
- Toast notification design
- Three-button dialog specification
- Integration with trust system

---

### Issue 9: Overnight Positions Behavior (H50) — **NEW** ⚠️

**Decision H50 states**:
```
Daemon stays running overnight

**Behavior**:
- Daemon enters "market closed" state
- Minimal resource usage
- Ready for pre-market signals if configured
```

**Plan says**: H50 is referenced but the "market closed" daemon state behavior is not documented.

**FIX REQUIRED**: Add daemon "market closed" state documentation to Phase 1 or Phase 4.

---

### Issue 10: Risk Limit Defaults Mismatch (L74) — **NEW** ⚠️

**Decision L74 states**:
| Limit | Default |
|-------|---------|
| Daily loss | **2%** |
| Max drawdown | 5% |
| Consecutive losses | **3** |
| Gross exposure | 100% |

**Plan says (Appendix_D_Technical_Reference.md)**:
```json
"quantlab.trading.riskLimits.dailyLossLimit": {
  "default": 1000,                    ← WRONG: Should be percentage (2%), not dollars
  "description": "Maximum daily loss in dollars"
}
```

Also missing: `consecutiveLossLimit` setting

**FIX REQUIRED**:
1. Change dailyLossLimit to percentage (default 0.02 = 2%)
2. Add consecutiveLossLimit setting (default 3)

---

### Issue 11: Missing Consecutive Loss Circuit Breaker — **NEW** ⚠️

**Decision L74** includes "Consecutive losses: 3" as a risk limit, but this is not fully implemented:

**Plan has**:
- `consecutive_loss` in RiskAlert type (Appendix_B_IPC_Protocol.md)
- `L026 | Daily loss limit enforced` test
- `L027 | Max drawdown enforced` test

**Plan missing**:
- No `L02X | Consecutive losses enforced` test
- No settings schema for consecutive loss limit
- No implementation task for consecutive loss tracking

**FIX REQUIRED**: Add consecutive loss tracking implementation and test.

---

### Issue 12: First-Time Setup Wizard (L74) — **NEW** ⚠️

**Decision L74 states**: "First-time setup: Wizard prompts user to review/confirm limits"

**Plan says**: No mention of a first-time setup wizard for risk limits.

**FIX REQUIRED**: Add first-run risk limit configuration wizard to Phase 3 onboarding.

---

## Part 3: Priority Fix Order

| # | Issue | File(s) to Change | Effort | Priority |
|---|-------|-------------------|--------|----------|
| 1 | Trust scope/revocation (H44/H45/H46) | `04_Phase_3_UI_Safety.md` | 1h | **P1** |
| 2 | Corporate actions deferral (L71) | `05_Phase_4_Live_Trading.md`, `Appendix_D` | 30m | **P1** |
| 3 | Daemon no auto-restart (L69/N99) | `02_Phase_1_Critical_Infrastructure.md` | 30m | **P1** |
| 4 | Secrets key rotation (H47) | `02_Phase_1_Critical_Infrastructure.md` | 45m | **P1** |
| 5 | AI provider scope (G37) | `04_Phase_3_UI_Safety.md` | 15m | **P2** |
| 6 | Risk limit defaults (L74) | `Appendix_D_Technical_Reference.md` | 30m | **P2** |
| 7 | Update infra checkpoint (I55) | `01_Phase_0_Setup_Gap_Analysis.md`, `Appendix_A` | 20m | **P2** |
| 8 | Strategy hot-reload flow (H52) | `04_Phase_3_UI_Safety.md` or `05_Phase_4_Live_Trading.md` | 45m | **P2** |
| 9 | Overnight daemon state (H50) | `02_Phase_1_Critical_Infrastructure.md` | 20m | **P3** |
| 10 | Data provider example (B12) | `04_Phase_3_UI_Safety.md` | 5m | **P3** |
| 11 | Consecutive loss limit | `02_Phase_1_Critical_Infrastructure.md`, `Appendix_D` | 30m | **P3** |
| 12 | First-run wizard (L74) | `04_Phase_3_UI_Safety.md` | 30m | **P3** |

**Total estimated fix time**: ~5 hours

---

## Part 4: Detailed Fix Instructions

### Fix 1: Trust Scope/Revocation

**File**: `04_Phase_3_UI_Safety.md`

**Location**: Section 3.2 Trust Model table (around line 248-252)

**Current**:
```markdown
| Entity | Trust Requirement | Revocation |
|--------|-------------------|------------|
| Strategy file | Hash-based trust | Any edit |
| Workspace | All files trusted | Any file edit |
| Extensions | Review required | Major update |
```

**Replace with**:
```markdown
| Entity | Trust Requirement | Revocation | Decision |
|--------|-------------------|------------|----------|
| Strategy file | Hash-based trust | Strategy file edit | H46 |
| Workspace | Per-workspace only | Strategy file change only | H44, H46 |
| Extensions | Review required | Minor OR Major update (patch retains) | H45 |
```

**Also fix task table**:

**Current**:
```markdown
| Trust storage (workspace/global) | 1d | ...
```

**Replace with**:
```markdown
| Trust storage (per-workspace only, H44) | 1d | ...
```

---

### Fix 2: Corporate Actions Deferral

**File**: `05_Phase_4_Live_Trading.md`

**Find and mark as deferred**:
```markdown
| ~~Corporate action detection~~ | ~~2d~~ | **DEFERRED to V1.1 (L71)** |
| ~~L049~~ | ~~Corporate actions diagnosed correctly~~ | **DEFERRED** |
```

**File**: `Appendix_D_Technical_Reference.md`

**Mark corporate.py as V1.1**:
```markdown
│   │   └── corporate.py           # Corporate actions (V1.1 - DEFERRED)
```

---

### Fix 3: Daemon No Auto-Restart

**File**: `02_Phase_1_Critical_Infrastructure.md`

**Add new section after watchdog tasks (around line 190)**:

```markdown
### 1.10 Restart Policy (Decisions L69, N99)

**CRITICAL**: The daemon must NEVER auto-restart.

| Scenario | Behavior | Rationale |
|----------|----------|-----------|
| OS reboot | No auto-start | User must consciously start live sessions |
| Daemon crash | Watchdog shows dialog, NO auto-restart | Avoid surprise trading |
| UI restart | Can reconnect to existing daemon | Daemon survives UI crash |

**On app launch after OS reboot**:
1. Check for previous session checkpoint
2. If found, show dialog: "Previous session was interrupted. Reconnect?"
3. User chooses: [Reconnect] | [Discard] | [View Only]

**On watchdog detecting dead daemon**:
1. Show modal: "Daemon is unresponsive"
2. Options: [Attempt Reconnect] | [Stop Session] | [View Logs]
3. Do NOT automatically restart the daemon

| Test ID | Description |
|---------|-------------|
| D011 | Daemon does not auto-start after reboot |
| D012 | Watchdog shows dialog but does not auto-restart |
```

---

### Fix 4: Secrets Key Rotation

**File**: `02_Phase_1_Critical_Infrastructure.md`

**Add new section after 3.5 Trust Storage (around line 410)**:

```markdown
### 3.7 Key Rotation Workflow (Decision H47)

Users must be able to change their master password and re-encrypt all secrets.

**Flow**:
1. User selects "Change Master Password" from Settings > Security
2. Prompt for current password (verify against stored key)
3. Prompt for new password (minimum 16 chars, with confirmation)
4. Re-derive encryption key using Argon2id with new password
5. Decrypt all secrets with old key
6. Re-encrypt all secrets with new key
7. Verify decryption works with new key
8. Atomically replace encrypted file
9. Clear old key from memory

**Implementation Tasks**:

| Task | Effort | Files |
|------|--------|-------|
| Add "Change Password" settings UI | 1d | `extensions/quantlab/src/ui/ChangePasswordDialog.ts` (NEW) |
| Implement re-encryption logic | 1d | `extensions/quantlab/src/core/secrets/rotation.ts` (NEW) |
| Add atomic file replacement | 0.5d | `extensions/quantlab/src/core/secrets/encrypted.ts` |
| Add rotation tests | 0.5d | `tests/secrets/rotation.test.ts` (NEW) |

**Testing Requirements**:

| Test ID | Description |
|---------|-------------|
| S009 | Password change re-encrypts all secrets |
| S010 | Old password fails after rotation |
| S011 | Rotation failure leaves secrets intact (atomic) |
| S012 | Rotation works with 50+ stored secrets |
```

---

### Fix 5: AI Provider Scope

**File**: `04_Phase_3_UI_Safety.md`

**Find (around line 600)**:
```markdown
| API integration (Anthropic/OpenAI) | 2d | ...
```

**Replace with**:
```markdown
| API integration (Anthropic Claude only for V1, G37) | 2d | ...
```

---

### Fix 6: Risk Limit Defaults

**File**: `Appendix_D_Technical_Reference.md`

**Find the risk limits settings section and update**:

```json
{
  "quantlab.trading.riskLimits.dailyLossPercent": {
    "type": "number",
    "default": 0.02,
    "minimum": 0.01,
    "maximum": 0.10,
    "description": "Maximum daily loss as percentage of equity (0.02 = 2%)"
  },
  "quantlab.trading.riskLimits.maxDrawdown": {
    "type": "number",
    "default": 0.05,
    "minimum": 0.02,
    "maximum": 0.20,
    "description": "Maximum drawdown percentage (0.05 = 5%)"
  },
  "quantlab.trading.riskLimits.consecutiveLosses": {
    "type": "integer",
    "default": 3,
    "minimum": 2,
    "maximum": 10,
    "description": "Maximum consecutive losing trades before circuit breaker"
  },
  "quantlab.trading.riskLimits.maxGrossExposure": {
    "type": "number",
    "default": 1.0,
    "minimum": 0.5,
    "maximum": 1.0,
    "description": "Maximum gross exposure as fraction of equity (1.0 = 100%)"
  }
}
```

---

### Fix 7: Update Infrastructure Checkpoint

**File**: `01_Phase_0_Setup_Gap_Analysis.md`

**Add new section**:

```markdown
### Phase 0 Decision Checkpoint: Auto-Update Infrastructure (I55)

**Question**: Does the VS Code fork provide adequate update infrastructure?

**Evaluation criteria**:
- [ ] Supports staged rollout percentages
- [ ] Supports crash-rate gating
- [ ] Supports blocking during live sessions
- [ ] Supports differential updates

**If VS Code updater meets all criteria**: Reuse it, skip electron-updater.
**If not**: Implement electron-updater as planned.

**Owner**: Platform team
**Due**: End of Phase 0 Week 1
**Output**: Document in `docs/decisions/auto-update.md`
```

**File**: `Appendix_A_Build_Packaging.md`

**Change**:
```markdown
| I55 | Auto-update: electron-updater |
```

**To**:
```markdown
| I55 | Auto-update: electron-updater (pending Phase 0 VS Code updater evaluation) |
```

---

### Fix 8: Strategy Hot-Reload Flow

**File**: `04_Phase_3_UI_Safety.md` (or `05_Phase_4_Live_Trading.md`)

**Add new section**:

```markdown
## X. Strategy Hot-Reload During Live Session (Decision H52)

### X.1 Background

When a user modifies the strategy file during a live trading session, they must be prompted with options.

### X.2 Detection and UI Flow

```
Strategy file saved during live session
        │
        ▼
Toast notification: "Strategy modified during live session"
        │
        ▼
Modal dialog appears:
        │
        ├── [Pause Session] → Pause strategy, keep positions
        │
        ├── [Continue (Code Unchanged)] → Ignore file change, keep running old code
        │
        └── [Restart with New Code] → Stop session, revoke trust, require re-trust, restart
```

### X.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| File watcher for strategy during live session | 1d | `extensions/quantlab/src/core/trading/StrategyWatcher.ts` (NEW) |
| Hot-reload dialog UI | 1d | `extensions/quantlab/src/ui/HotReloadDialog.ts` (NEW) |
| Integration with trust system | 0.5d | `extensions/quantlab/src/core/trust/` |
| Integration with session manager | 0.5d | `extensions/quantlab/src/core/trading/SessionManager.ts` |

### X.4 Testing Requirements

| Test ID | Description |
|---------|-------------|
| HR001 | Strategy change during live session shows dialog |
| HR002 | "Pause Session" pauses without closing positions |
| HR003 | "Continue" ignores change and keeps running |
| HR004 | "Restart" revokes trust and requires re-trust |
```

---

### Fix 9: Overnight Daemon State

**File**: `02_Phase_1_Critical_Infrastructure.md`

**Add to daemon architecture section**:

```markdown
### 1.11 Market Hours and Overnight State (Decision H50)

The daemon stays running overnight for users with swing/overnight positions.

**Daemon states**:

| State | Description | Resource Usage |
|-------|-------------|----------------|
| ACTIVE | Market open, strategy running | Normal |
| PAUSED | User paused | Low (no signals) |
| MARKET_CLOSED | Outside market hours | Minimal |

**Market closed behavior**:
- Strategy evaluation paused (no signals generated)
- Positions maintained
- Heartbeat continues (5s interval)
- Memory usage reduced (release indicator caches)
- Ready for pre-market if user configures

**Transition triggers**:
- Market close → Enter MARKET_CLOSED state
- Market open → Resume ACTIVE state (if was running)
- User can configure pre-market start time
```

---

### Fix 10: Data Provider Example

**File**: `04_Phase_3_UI_Safety.md`

**Find the pre-trade checklist UI mockup and change**:
```
│ ✓ Data Feed                      Polygon connected, 50ms latency            │
```

**To**:
```
│ ✓ Data Feed                      Alpaca connected, 50ms latency             │
```

---

### Fix 11: Consecutive Loss Limit

**File**: `02_Phase_1_Critical_Infrastructure.md` (Exposure section)

**Add to ExposureManager**:

```markdown
### 2.8 Consecutive Loss Tracking (Decision L74)

Track consecutive losing trades and trigger circuit breaker at threshold.

```python
class ConsecutiveLossTracker:
    def __init__(self, limit: int = 3):
        self.limit = limit
        self.consecutive_losses = 0
    
    def record_trade(self, pnl: Decimal) -> bool:
        """Returns True if circuit breaker should trigger."""
        if pnl < 0:
            self.consecutive_losses += 1
            if self.consecutive_losses >= self.limit:
                return True  # Trigger circuit breaker
        else:
            self.consecutive_losses = 0  # Reset on win
        return False
```

**Implementation Tasks**:

| Task | Effort | Files |
|------|--------|-------|
| Consecutive loss tracker | 0.5d | `engine/risk/consecutive.py` (NEW) |
| Integration with fill handler | 0.5d | `engine/daemon/fills.py` |
| Circuit breaker trigger | 0.5d | `engine/risk/circuit_breaker.py` |

**Test**:

| Test ID | Description |
|---------|-------------|
| E010 | 3 consecutive losses triggers circuit breaker |
| E011 | Win resets consecutive loss counter |
```

**File**: `06_Phase_5_Testing_Release.md`

**Add test**:
```markdown
| L029 | Consecutive losses enforced | Circuit breaker triggers after N losses |
```

---

### Fix 12: First-Run Risk Wizard

**File**: `04_Phase_3_UI_Safety.md`

**Add to onboarding section**:

```markdown
## Y. First-Run Risk Configuration Wizard (Decision L74)

### Y.1 Background

New users must review and confirm risk limits before live trading.

### Y.2 Wizard Flow

```
First launch detection
        │
        ▼
Welcome screen with risk disclosure
        │
        ▼
Risk Limits Configuration:
┌──────────────────────────────────────────────────────────────┐
│ CONFIGURE YOUR RISK LIMITS                                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Daily Loss Limit:        [____2___] %  (1-10%, default 2%)   │
│ Maximum Drawdown:        [____5___] %  (2-20%, default 5%)   │
│ Consecutive Losses:      [____3___]    (2-10, default 3)     │
│ Max Gross Exposure:      [___100__] %  (50-100%, default 100%)│
│                                                              │
│ ⚠️ These limits will trigger automatic circuit breakers.     │
│ You can change them later in Settings > Trading > Risk.      │
│                                                              │
│                              [Use Defaults]  [Save & Continue]│
└──────────────────────────────────────────────────────────────┘
```

### Y.3 Implementation Tasks

| Task | Effort | Files |
|------|--------|-------|
| First-run detection | 0.5d | `extensions/quantlab/src/core/state/firstRun.ts` (NEW) |
| Risk wizard UI | 1d | `extensions/quantlab/src/ui/RiskWizard.ts` (NEW) |
| Wizard flow controller | 0.5d | `extensions/quantlab/src/ui/onboarding/` |
```

---

## Part 5: Validation Checklist

After applying all fixes, verify:

### Decision Compliance
- [ ] H44: Trust storage is per-workspace only
- [ ] H45: Minor AND major updates revoke extension trust
- [ ] H46: Only strategy file changes revoke workspace trust
- [ ] H47: Key rotation workflow documented
- [ ] H50: Overnight daemon state documented
- [ ] H52: Hot-reload UI flow with 3 options documented
- [ ] G37: Only Anthropic Claude for V1
- [ ] B12: All UI examples show "Alpaca" not "Polygon"
- [ ] L69: No daemon auto-restart after reboot
- [ ] L71: Corporate actions marked as V1.1
- [ ] L74: Daily loss is percentage (2%), consecutive losses (3) included
- [ ] N99: Watchdog shows dialog but does NOT auto-restart
- [ ] I55: Phase 0 checkpoint for VS Code updater evaluation

### Structural Integrity
- [ ] All test IDs are unique
- [ ] All file paths are consistent
- [ ] All effort estimates sum correctly
- [ ] No TODO/TBD placeholders remain

---

## Conclusion

The merged plan is **95% complete** but requires these 12 targeted fixes to achieve full compliance with the Implementation Decisions document. 

**ChatGPT's evaluation was accurate** — all 6 issues they identified were verified correct against the actual decisions.

**Additional issues I found** fill in gaps that a semantic review caught but a reference-counting audit missed.

Once these fixes are applied (~5 hours of work), the plan will be **fully optimal and ready for implementation**.

---

*Audit completed: January 26, 2026*  
*Auditor: Claude (Anthropic)*  
*Verification method: Line-by-line comparison against Quantlab_Implementation_Decisions.md*

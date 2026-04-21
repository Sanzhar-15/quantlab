# Quantlab Implementation Plan — Decision Document

**Date**: January 25, 2026  
**Purpose**: Authoritative answers to implementation questions for plan optimization  
**Status**: APPROVED — Use these decisions as constraints for implementation planning

---

## Executive Summary

This document provides definitive answers to **100+ questions** raised during implementation planning. Decisions are optimized for:
- **V1 scope discipline** (ship fast, defer non-critical)
- **Risk minimization** (especially for live trading)
- **Technical pragmatism** (use existing tools where possible)
- **Future extensibility** (don't paint into corners)

**Revision 2 additions** (from deep audit):
- 20 critical decisions added (N81-N100)
- Consistency verification matrix
- Revised timeline estimate (29w → 38w)
- Implementation priority classification

---

# Section A: Repository & Code Architecture

## A1. Python Engine Location in Repository

**Decision**: `engine/` directory at repo root

**Rationale**:
- Keeps engine code clearly separated from UI (Electron/TypeScript)
- Allows independent versioning of engine components
- Matches pattern of `src/` for UI, `engine/` for Python

**Structure**:
```
quantlab/
├── src/                    # Electron/TypeScript UI
├── engine/                 # Python engine
│   ├── quantlab/          # Main package
│   │   ├── backtest/
│   │   ├── live/
│   │   ├── daemon/
│   │   └── ...
│   ├── tests/
│   ├── pyproject.toml
│   └── requirements.txt
├── extensions/            # VS Code extensions
└── package.json
```

## A2. Python Runtime Packaging Strategy

**Decision**: Bundled Python with embedded venv

**Rationale**:
- System Python is unreliable (version varies, may be missing)
- Containers add complexity for desktop app
- Bundled Python ensures consistency across all users

**Implementation**:
| Platform | Approach |
|----------|----------|
| Windows | Embedded Python (python-3.11.x-embed-amd64.zip) |
| macOS | Framework Python in app bundle |
| Linux | AppImage with bundled Python |

**Size budget**: ~100MB for Python + ~200MB for packages = ~300MB total

## A3. Engine Upgrade Path Across App Updates

**Decision**: In-place upgrade with migration scripts

**Rationale**:
- Side-by-side versioning wastes disk space
- Migration scripts handle schema changes cleanly
- Simpler for users (one version at a time)

**Migration protocol**:
1. On update, check `~/.quantlab/version.json`
2. Run any pending migrations in sequence
3. Update version marker
4. If migration fails, rollback and alert user

## A4. Daemon Process Language

**Decision**: **(c) Hybrid — Python engine + TypeScript IPC bridge**

**Rationale**:
- Python is required for the trading engine (NumPy, Pandas, TA-Lib)
- TypeScript IPC bridge in Electron handles UI communication
- Keeps language boundaries clean

**Architecture**:
```
Electron (TypeScript) ←→ IPC Bridge (TypeScript) ←→ Daemon (Python)
                              │
                         JSON over Unix Socket / Named Pipe
```

## A5. IPC Mechanism

**Decision**: **(a) Unix Domain Sockets (Linux/macOS) + Named Pipes (Windows)**

**Rationale**:
- Lower latency than TCP localhost
- No port conflicts
- OS-native security (file permissions)
- gRPC adds unnecessary complexity for V1

**Implementation**:
- Socket path: `~/.quantlab/sockets/{session_id}.sock`
- Named pipe: `\\.\pipe\quantlab-{session_id}`
- Protocol: JSON-RPC 2.0 over the transport

## A6. Debug File Storage Format

**Decision**: Apache Arrow IPC format (`.arrow`)

**Rationale**:
- Memory-mappable (required for large files)
- Columnar (efficient for time-series access)
- Cross-platform (Python and TypeScript readers exist)
- Already used by Pandas ecosystem

**If Arrow is new**: Accept it as new dependency. Alternatives (SQLite, custom binary) don't support efficient memory-mapping of columnar data.

---

# Section B: Scope & Priority

## B7. History Artifact Backward Compatibility

**Decision**: Breaking migration acceptable for V1

**Rationale**:
- No production users yet
- Clean slate is better than legacy baggage
- Document the break clearly in release notes

**For V1.x+**: Maintain backward compatibility with migration scripts.

## B8. Artifact Storage Location

**Decision**: `~/.quantlab/history/` (user home, not workspace)

**Rationale**:
- Survives workspace deletion
- Consistent location across projects
- Avoids cluttering git repos

**Retention policy**:
- Unpinned runs: 30 days or 100 runs (whichever is more)
- Pinned runs: Forever (user must unpin to delete)
- Auto-cleanup on startup if over limit

## B9. Encryption at Rest for Artifacts

**Decision**: **No** for V1, optional for V2

**Rationale**:
- Artifacts don't contain secrets (those are in keychain)
- Encryption adds complexity and performance overhead
- Users who need encryption can use full-disk encryption

**Exception**: Audit logs for live trading SHOULD be tamper-evident (hash chain), but not encrypted.

## B10. Live Trading in V1 Scope

**Decision**: **Yes**, live trading is in V1 scope

**Rationale**:
- Core value proposition of the product
- Paper trading alone is insufficient differentiation
- Safety controls (daemon, risk limits, trust model) are designed for this

**Risk mitigation**:
- Extensive paper trading test vectors first
- Mandatory paper trading before live
- Conservative default risk limits

## B11. Broker Support for V1

**Decision**: **(a) Alpaca only + Mock broker**

**Rationale**:
- Alpaca has excellent API, free paper trading
- Mock broker enables offline development/testing
- Interactive Brokers adds significant complexity (TWS dependency)

**V2 candidates**: Interactive Brokers, Tradier, TD Ameritrade

**Adapter interface**: Design pluggable from day 1, but only implement Alpaca + Mock.

## B12. Data Provider Support for V1

**Decision**: Alpaca Data API (included with Alpaca account) + Local CSV/Parquet

**Rationale**:
- Alpaca data is free with brokerage account
- Avoids additional subscription cost for users
- Polygon can be added in V1.1 if needed

**Not in V1**: Yahoo Finance (unreliable), paid-only providers

## B13. Multi-Symbol Live Trading

**Decision**: **Yes**, in V1 scope

**Rationale**:
- Rotation strategies are common use case
- Engine already supports it (same code path as backtest)
- Risk limits apply across all symbols

**Limitation**: Single broker per session (no multi-broker aggregation)

## B14. Real-Time vs Delayed Data

**Decision**: Real-time data required for live trading

**Rationale**:
- Delayed data is useless for live execution
- Alpaca provides real-time with account
- Backtest can use delayed/historical data

## B15. Multi-Provider Failover

**Decision**: **Deferred to V1.1**

**Rationale**:
- Single provider (Alpaca) is sufficient for V1
- Failover logic is complex
- Focus on reliability of primary path first

---

# Section C: Operational Procedures

## C16. Live Session Protection for Auto-Updates

**Decision**: **(c) Both — belt and suspenders**

**Implementation**:
1. Update system checks for active daemon before downloading
2. Daemon refuses to allow update signal when session active
3. UI shows clear message explaining why update is blocked

## C17. Calendar Maintenance

**Decision**: **(c) Both documentation and tooling**

**Implementation**:
- Documentation: Annual procedure for updating holiday YAML
- Tooling: Script to fetch from NYSE/NASDAQ official calendars
- Validation: CI test that calendar is valid for next 12 months

## C18. VS Code Fork Merge Cadence

**Decision**: **(a) Monthly merges from upstream**

**Rationale**:
- Security patches need timely application
- Monthly is manageable cadence
- Quarterly is too slow for security

**Process**:
1. Watch VS Code releases (first Tuesday of month)
2. Create merge branch
3. Resolve conflicts (document in PATCHES.md)
4. Run regression tests
5. Ship in next Quantlab release

## C19. Telemetry/Analytics

**Decision**: Opt-in only, minimal collection

**Permitted data**:
- Crash reports (sanitized, no code or paths)
- Feature usage counts (not content)
- Performance metrics (backtest duration, not strategy)

**Prohibited**:
- Strategy code
- Trading data
- Personal information
- Any data without explicit consent

**Stack**: Self-hosted (e.g., Plausible) or none. No Google Analytics.

## C20. Staged Rollout Gates

**Decision**: Crash rate only (not business KPIs)

**Gates**:
| Stage | Percentage | Gate Criteria |
|-------|------------|---------------|
| 1 | 5% | Crash rate < 0.5% after 24h |
| 2 | 25% | Crash rate < 0.5% after 48h |
| 3 | 100% | Manual approval |

**Not gated on**: Revenue, engagement, or other business metrics (too early).

---

# Section D: Testing & Quality

## D21. Paper Trading Environment

**Decision**: **(c) Both Mock and Alpaca Paper**

**Strategy**:
- Unit tests: Mock broker only (fast, deterministic)
- Integration tests: Mock broker (CI-friendly)
- E2E tests: Alpaca Paper (requires API key in CI secrets)
- Manual testing: Alpaca Paper

## D22. Chaos Testing Infrastructure

**Decision**: Build minimal chaos testing for V1

**Scope for V1**:
- Process kill tests (kill daemon, verify recovery)
- Network disconnect simulation (mock broker returns errors)
- Disk full simulation (verify graceful handling)

**Not in V1**: Full chaos engineering (Chaos Monkey style)

**Tools**: pytest fixtures that inject failures, not external infrastructure.

## D23. Accessibility Testing Tools

**Decision**: **(d) All of the above**

**Implementation**:
- axe-core in CI for automated checks
- Manual screen reader testing (NVDA on Windows, VoiceOver on macOS)
- External audit before V1 GA (budget permitting)

## D24. Performance Testing Hardware

**Decision**: Dedicated CI runner matching spec

**Spec**: 4-core CPU, 8GB RAM, SSD (as documented)

**Implementation**:
- GitHub Actions self-hosted runner OR
- Dedicated performance test workflow on larger runner
- Results tracked in benchmark database for regression detection

## D25. Test Coverage Gates

**Decision**: Yes, gate each phase with specific suites

| Phase | Required Suites | Coverage |
|-------|-----------------|----------|
| 1 (Foundation) | Unit tests | 80% engine |
| 2 (Core Engine) | Golden vectors G001-G049 | 100% pass |
| 3 (UI & Safety) | Integration tests | 70% UI |
| 4 (Testing) | All vectors including L001-L070 | 100% pass |

---

# Section E: Security & Compliance

## E26. External Security Audit

**Decision**: **(c) Depends on timeline/budget**

**Recommendation**:
- Internal security review: Required
- External audit: Strongly recommended before live trading GA
- If budget limited: Focus audit on daemon IPC and broker integration

## E27. Secrets Storage Primary Path

**Decision**: OS Keychain is primary, encrypted file is fallback

**Testing**:
- Equal testing of both paths
- CI must test encrypted file (no keychain in containers)
- Manual testing of keychain on each platform

## E28. Strategy Sandbox Depth

**Decision**: **(d) Trust-based — only sandbox untrusted code**

**Rationale**:
- Full sandboxing (seccomp/AppArmor) is complex and fragile
- Trusted workspaces can run unrestricted
- Untrusted workspaces get import blocking

**Implementation**:
- Untrusted: Block `requests`, `urllib`, `socket`, `subprocess`, `os.system`
- Trusted: Full access
- V2: Consider deeper sandboxing if needed

## E29. Authentication for Daemon IPC

**Decision**: OS user-only + token file

**Implementation**:
1. Socket/pipe has 0600 permissions (owner only)
2. Token file generated on daemon start: `~/.quantlab/sessions/{id}.token`
3. All IPC requests must include token
4. Token rotated on each session start

## E30. Message Reliability

**Decision**: Ack/retry with bounded buffer

**Implementation**:
- Critical messages (orders): Require ACK, retry 3x with exponential backoff
- Progress messages: Fire-and-forget (loss acceptable)
- Buffer limit: 1000 messages, then backpressure (slow sender)

## E31. Legal/Compliance Constraints

**Decision**: Disclosures required, 7-year audit retention

**Requirements**:
- Risk disclosures on first launch (implemented in Product Spec §11)
- Live trading disclosure with checkboxes
- Audit logs retained 7 years (regulatory requirement)
- Export capability for audit logs

---

# Section F: External Dependencies

## F32. LibCST Version

**Decision**: LibCST >= 1.0.0

**Rationale**:
- 1.0.0 is stable release
- No known compatibility issues with Python 3.11
- Pin to specific version in requirements.txt

## F33. Argon2 Implementation

**Decision**: **(a) argon2-cffi (Python)**

**Rationale**:
- Secrets handling is in Python (daemon)
- argon2-cffi is well-maintained, has wheels for all platforms
- No need for Node.js implementation

## F34. Polygon API

**Decision**: Not required for V1

**If added later**: Requires user's own API key (we don't provide shared key)

## F35. Minimum Python Version

**Decision**: Python 3.11

**Rationale**:
- 3.11 has significant performance improvements
- Bundled Python, so no user version concerns
- 3.12+ can be adopted later

## F36. Vendored vs External Packages

**Decision**: External wheels at build time

**Rationale**:
- Vendoring adds maintenance burden
- Pip install at build time is standard practice
- Pin all versions in requirements.txt

**Exception**: If a package has problematic licensing, vendor it.

---

# Section G: UI/UX

## G37. AI Panel Provider

**Decision**: **(d) Pluggable interface, Anthropic (Claude) default**

**Rationale**:
- Anthropic is the spec's example provider
- Pluggable interface allows user choice
- V1 ships with Claude support only

**V2**: Add OpenAI, local models

## G38. AI Requests in Untrusted Workspaces

**Decision**: Allowed, but with additional sanitization

**Rationale**:
- AI can help users understand code even in untrusted workspaces
- Sanitization prevents credential leakage regardless of trust level
- Blocking entirely is overly restrictive

## G39. AI Data Retention

**Decision**: No retention beyond request/response

**Implementation**:
- Anthropic API has no retention option
- Local audit log retained 90 days
- User can clear AI history manually

## G40. AI Functionality in V1

**Decision**: **Yes**, include in V1

**Rationale**:
- Key differentiation from competitors
- Core spec feature
- Sanitization and security model are already designed

## G41. System Tray Availability

**Decision**: System tray with fallback for Linux

**Implementation**:
| Platform | Approach |
|----------|----------|
| Windows | System tray (always available) |
| macOS | Menu bar (always available) |
| Linux | System tray if available, else dock icon + notification |

**Linux fallback**: Use libappindicator, fall back to desktop notification if tray unavailable.

## G42. Electron Version

**Decision**: Match VS Code's Electron version

**Rationale**:
- Forking VS Code means using their Electron
- Current VS Code uses Electron 28+ (Chromium 120+)
- Check VS Code release notes for exact version

## G43. Dark Mode

**Decision**: **Yes**, mandatory for V1

**Rationale**:
- VS Code has dark mode by default
- Developers expect dark mode
- Colors are already specified in spec

---

# Section H: Risk & Edge Cases

## H44. Extension Trust Scope

**Decision**: Per-workspace

**Rationale**:
- Global trust is too coarse (one bad extension affects all)
- Per-workspace allows different trust levels for different projects
- Matches VS Code's workspace trust model

## H45. Extension Update Policy Enforcement

**Decision**: Automated check on extension load

**Implementation**:
1. On workspace open, check installed extension versions
2. Compare to trusted versions in workspace settings
3. If major/minor version changed, revoke trust and prompt
4. Patch versions retain trust automatically

## H46. Workspace Trust on File Change

**Decision**: Only strategy files (*.py in strategy directories)

**Rationale**:
- Re-trusting on any file change is too aggressive
- Config changes don't affect trading logic
- Strategy file changes require re-trust (as specified)

## H47. Secrets Encryption Key Rotation

**Decision**: User-initiated rotation only

**Implementation**:
- Key derived from master password (Argon2id)
- User can change master password in settings
- On change, re-encrypt all secrets with new key
- No automatic rotation (adds complexity)

## H48. Offline Support for Live Trading Setup

**Decision**: **No** — broker auth requires network

**Rationale**:
- OAuth flows require network
- API key validation requires network
- Offline live trading setup is not meaningful

**Supported offline**: Backtest, paper trading with mock broker, strategy development

## H49. Code Modification Execution Location

**Decision**: Engine subprocess (not extension host)

**Rationale**:
- LibCST is Python library
- Keep code modification in same process as validation
- Extension host calls engine for modification

## H50. Overnight Positions

**Decision**: **(a) Daemon stays running overnight**

**Rationale**:
- User may have overnight/swing positions
- Daemon consumes minimal resources when idle
- Pre-market signals may be desired

**Behavior**:
- Daemon enters "market closed" state
- No signal processing (no bar events)
- Heartbeat continues
- Resumes on market open

## H51. Multiple Simultaneous Sessions

**Decision**: **(a) Yes, multiple daemons allowed**

**Rationale**:
- Users may want to run different strategies
- Each daemon is independent
- Resource limits apply per daemon

**Constraint**: Same broker account can only be used by one session (prevent conflicting orders)

## H52. Strategy Hot-Reload

**Decision**: **(c) Warning shown, user chooses**

**Implementation**:
1. File watcher detects strategy change
2. Toast: "Strategy modified during live session"
3. Options: "Pause Session" | "Continue (code unchanged)" | "Restart with New Code"
4. Trust automatically revoked, requiring re-trust for "Restart"

## H53. Multiple Workspaces for Live Sessions

**Decision**: **Yes**, supported

**Rationale**:
- Maps to multiple simultaneous sessions (H51)
- Each workspace can have its own live session
- Daemon is per-session, not per-workspace

---

# Section I: Deployment & Release

## I54. Target Linux Distributions

**Decision**: **(c) AppImage only (universal)**

**Rationale**:
- AppImage works on all distros
- Single artifact to build and test
- .deb/.rpm add maintenance burden

**Exception**: If user demand is high, add .deb in V1.1

## I55. Auto-Update Mechanism

**Decision**: Use electron-updater (standard for Electron apps)

**Rationale**:
- VS Code fork may have custom updater
- If not, electron-updater is proven
- Supports differential updates

**Check**: Inspect VS Code fork for existing update infrastructure.

## I56. Code Signing Certificates

**Decision**: Required before V1 GA

**Status**:
- Windows: EV code signing certificate required (SmartScreen)
- macOS: Apple Developer ID required (Gatekeeper + Notarization)
- Linux: GPG signature (optional but recommended)

**Action item**: Procure certificates early (EV takes weeks)

## I57. Bundled vs Downloadable Extensions

**Decision**: Bundled at build time

**Rationale**:
- Faster first-run experience
- No network dependency for core functionality
- Extensions: Python, Pyright, Jupyter

**User-installed extensions**: Downloaded from Open VSX on demand

---

# Section J: Timeline & Resources

## J58. Team Size Assumption

**Decision**: **(b) 2-3 engineers**

**Rationale**:
- 24-week timeline suggests small team
- Parallelization limited with 2-3 people
- Solo developer would extend timeline to 40+ weeks

## J59. Parallel Work Streams

**Decision**: Yes, if team size allows

**Parallelizable**:
- Phase 2 (Engine) + Phase 3 (UI) can overlap
- Backend engineer on engine, frontend on UI
- Integration in Phase 4

**Sequential**:
- Phase 1 (Foundation) must complete first
- Phase 4 (Testing) requires 2+3 complete
- Phase 5 (Release) is final

## J60. Buffer Time

**Decision**: Add 20% buffer

**Adjusted timeline**:
- Original: 24 weeks
- With buffer: 29 weeks (~7 months)

**Buffer allocation**:
- 1 week after Phase 1 (foundation issues)
- 2 weeks after Phase 3 (integration issues)
- 2 weeks before Phase 5 (final polish)

## J61. Hard Release Dates

**Decision**: No hard dates, quality gates instead

**Rationale**:
- Shipping buggy live trading is unacceptable
- Quality gates (test coverage, security review) are more important
- Communicate timeline as estimate, not commitment

## J62. V1 Scope Freeze

**Decision**: **Yes**, strict scope freeze

**In V1** (non-negotiable):
- Backtest engine with all order types
- Live trading with Alpaca
- Daemon architecture
- Risk limits and safety controls
- Time-travel debugger (bar state level)
- AI panel with sanitization

**Explicitly deferred to V2**:
- Multi-broker support
- Options/futures
- Team collaboration
- Tick-level simulation
- Full chaos engineering

---

# Section K: Remaining Clarifications

## K63. LibCST Shipping

**Decision**: Ship as Python dependency (pip install)

**Rationale**:
- LibCST has wheels for all platforms
- No system install required
- Bundled Python includes pip

## K64. Report Export Scope

**Decision**: HTML and CSV required, PDF optional

**Rationale**:
- HTML is easiest (no external dependencies)
- CSV is essential for data export
- PDF requires additional library (ReportLab), defer if needed

## K65. Time-Travel Debugger Level

**Decision**: Full bar state (not just signals)

**Required state per bar**:
- Market data (OHLCV)
- All indicator values
- Condition evaluations
- Portfolio state
- Any user-defined variables

## K66. Large Debug Files (>1GB)

**Decision**: Performance target is forward-looking

**V1 requirement**: Files up to 500MB must be performant (<500ms jump)
**V1.1 target**: Files up to 4GB (as specified)

**Implementation**: Arrow format + memory mapping enables this path

## K67. Design System Source

**Decision**: Create new design system based on VS Code

**Rationale**:
- No existing design system mentioned
- VS Code provides base styling
- Document Quantlab-specific additions (tab stripes, colors)

**Deliverable**: `DESIGN_SYSTEM.md` with tokens, components, patterns

## K68. Non-Goals Lock for V1

**Decision**: Lock the following as non-goals

| Feature | Status | Rationale |
|---------|--------|-----------|
| Tick-level backtesting | V2 | Bar-based sufficient for V1 |
| Team collaboration | V2 | Single-user first |
| Leverage/margin | V2 | 100% collateral only |
| Options/futures | V2 | Equities first |
| Mobile app | V3 | Desktop focus |
| Multi-broker session | V2 | Single broker sufficient |
| Docker runner | V2 | Local runner only |
| Remote runner | V2 | Local only |

---

# Section L: Additional Operational Details

## L69. Daemon Auto-Restart After OS Reboot

**Decision**: **No** — manual restart required

**Rationale**:
- Auto-restart could resume trading unexpectedly
- User should consciously start live sessions
- Daemon writes checkpoint on shutdown for recovery info

**User experience**: On app launch, show "Previous session was interrupted. Reconnect?"

## L70. Update Blocking for Paper Trading

**Decision**: Warning only, not blocked

**Rationale**:
- Paper trading has no real financial risk
- User may want to update even during paper session
- Show warning: "Paper session active. Update will restart the session."

## L71. Corporate Actions in V1

**Decision**: **Deferred to V1.1** (ADJUST_PRICES mode only in V1.0)

**V1.0**: Use adjusted data from provider (pre-adjusted for splits)
**V1.1**: Add explicit corporate action handling modes

**Rationale**:
- Adjusted data handles 90% of cases
- Full corporate action simulation is complex
- Focus on core functionality for V1

## L72. Existing Codebase Status

**Decision**: Assume greenfield for planning purposes

**Rationale**:
- Questions mention "current codebase" but no details provided
- Plan should work for greenfield
- If existing code exists, audit and integrate as Phase 0

**Recommendation**: Provide codebase access for accurate planning

## L73. API Credentials for Development

**Decision**: Each developer needs own Alpaca account

**Setup**:
1. Free Alpaca paper trading account (no cost)
2. API keys stored in local environment
3. CI uses shared test account (secrets in CI)

**Production**: Users provide own API keys (we never store them server-side)

## L74. Default Risk Limits

**Decision**: Conservative defaults, user-adjustable

| Limit | Default | Range |
|-------|---------|-------|
| Daily loss | 2% | 1-10% |
| Max drawdown | 5% | 2-20% |
| Consecutive losses | 3 | 2-10 |
| Gross exposure | 100% | 50-100% |

**First-time setup**: Wizard prompts user to review/confirm limits

## L75. Exposure Reservation Strictness

**Decision**: Strict — reject orders that would breach

**Behavior**:
- Reservation includes pending orders
- Partial fills release unused reservation
- Order modifications adjust reservation atomically
- No "soft" limits that warn but allow breach

## L76. Data Provider Credentials

**Decision**: User provides own credentials

**Implementation**:
- Settings UI for API key entry
- Stored in OS keychain (or encrypted fallback)
- Validation on save (test API call)

**We do not**: Provide shared API keys or proxy requests through our servers

---

# Section M: Integration Points

## M77. Existing VS Code Extensions to Preserve

**Decision**: Preserve all standard VS Code extension APIs

**Critical compatibility**:
- Extension host must run standard extensions
- marketplace.visualstudio.com → Open VSX redirect
- Keybinding system unchanged (add Quantlab prefix)

## M78. Git Integration

**Decision**: Use VS Code's built-in Git support unchanged

**Rationale**:
- Strategy versioning is important
- VS Code Git UI is excellent
- No customization needed

## M79. Terminal Integration

**Decision**: Use VS Code's integrated terminal unchanged

**Addition**: Add "Run Backtest" command in terminal context menu

## M80. Python Environment Management

**Decision**: Bundled Python is isolated, user can configure external

**Modes**:
1. **Bundled** (default): Use shipped Python for engine
2. **Custom**: User points to external Python (advanced users)

**Settings**: `quantlab.python.path` (default: bundled)

---

# Quick Reference: Question-to-Answer Mapping

For easy lookup, here's where each original question is answered:

| Original Q# | Topic | Section |
|-------------|-------|---------|
| LLM1-Q1 | Engine location | A1 |
| LLM1-Q2 | Python packaging | A2 |
| LLM1-Q3 | Upgrade path | A3 |
| LLM1-Q4 | Backward compat | B7 |
| LLM1-Q5 | Migration | B7 |
| LLM1-Q6 | Artifact storage | B8 |
| LLM1-Q7 | Encryption at rest | B9 |
| LLM1-Q8 | IPC transport | A5 |
| LLM1-Q9 | Daemon auth | E29 |
| LLM1-Q10 | Message reliability | E30 |
| LLM1-Q11 | Telemetry | C19 |
| LLM1-Q12 | Rollout gates | C20 |
| LLM1-Q13 | First-class OS | G41, I54 |
| LLM1-Q14 | Python version | F35 |
| LLM1-Q15 | Vendor packages | F36 |
| LLM1-Q16 | Data providers | B12 |
| LLM1-Q17 | Real-time data | B14 |
| LLM1-Q18 | Multi-provider | B15 |
| LLM1-Q19 | Brokers | B11 |
| LLM1-Q20 | Paper trading | D21, L70 |
| LLM1-Q21 | Risk limits | L74 |
| LLM1-Q22 | Exposure reservation | L75 |
| LLM1-Q23 | Corporate actions | L71 |
| LLM1-Q24 | Report export | K64 |
| LLM1-Q25 | Debugger level | K65 |
| LLM1-Q26 | Large debug files | K66 |
| LLM1-Q27 | Debug format | A6 |
| LLM1-Q28 | AI provider | G37 |
| LLM1-Q29 | AI untrusted | G38 |
| LLM1-Q30 | AI retention | G39 |
| LLM1-Q31 | AI in V1 | G40 |
| LLM1-Q32 | Extension trust scope | H44 |
| LLM1-Q33 | Extension updates | H45 |
| LLM1-Q34 | Workspace trust | H46 |
| LLM1-Q35 | Key rotation | H47 |
| LLM1-Q36 | Offline support | H48 |
| LLM1-Q37 | LibCST deps | K63 |
| LLM1-Q38 | Code mod location | H49 |
| LLM1-Q39 | Test coverage | D25 |
| LLM1-Q40 | Phase gates | D25 |
| LLM1-Q41 | Release dates | J61 |
| LLM1-Q42 | Team constraints | J58, J59 |
| LLM1-Q43 | Scope freeze | J62 |
| LLM1-Q44 | Compliance | E31 |
| LLM1-Q45 | Multiple workspaces | H53 |
| LLM1-Q46 | Daemon reboot | L69 |
| LLM1-Q47 | Paper update | L70 |
| LLM1-Q48 | Design system | K67 |
| LLM1-Q49 | Extension bundling | I57 |
| LLM1-Q50 | Non-goals | K68 |
| LLM2-A1 | Daemon language | A4 |
| LLM2-A2 | IPC mechanism | A5 |
| LLM2-A3 | Debug format | A6 |
| LLM2-A4 | AI provider | G37 |
| LLM2-B5 | Live in V1 | B10 |
| LLM2-B6 | Broker support | B11 |
| LLM2-B7 | Data providers | B12 |
| LLM2-B8 | Multi-symbol live | B13 |
| LLM2-C9 | Update protection | C16 |
| LLM2-C10 | Calendar maint | C17 |
| LLM2-C11 | Fork cadence | C18 |
| LLM2-D12 | Paper env | D21 |
| LLM2-D13 | Chaos testing | D22 |
| LLM2-D14 | A11y tools | D23 |
| LLM2-D15 | Perf hardware | D24 |
| LLM2-E16 | Security audit | E26 |
| LLM2-E17 | Secrets primary | E27 |
| LLM2-E18 | Sandbox depth | E28 |
| LLM2-F19 | LibCST version | F32 |
| LLM2-F20 | Argon2 impl | F33 |
| LLM2-F21 | Polygon API | F34 |
| LLM2-G22 | System tray | G41 |
| LLM2-G23 | Electron version | G42 |
| LLM2-G24 | Dark mode | G43 |
| LLM2-H25 | Overnight | H50 |
| LLM2-H26 | Multiple sessions | H51 |
| LLM2-H27 | Hot reload | H52 |
| LLM2-I28 | Linux distros | I54 |
| LLM2-I29 | Auto-update | I55 |
| LLM2-I30 | Code signing | I56 |
| LLM2-J31 | Team size | J58 |
| LLM2-J32 | Parallel work | J59 |
| LLM2-J33 | Buffer time | J60 |

### Audit-Added Decisions (N81-N100)

| ID | Topic | Why Added |
|----|-------|-----------|
| N81 | Sleep/wake handling | Critical for laptop users |
| N82 | Network connectivity | Safety requirement |
| N83 | Timezone handling | Correctness requirement |
| N84 | DST transitions | Edge case that breaks strategies |
| N85 | User packages | Extensibility |
| N86 | Error reporting | Debugging requirement |
| N87 | Logging strategy | Operational requirement |
| N88 | Memory management | Stability requirement |
| N89 | Concurrent backtests | Resource management |
| N90 | API versioning | Future compatibility |
| N91 | Documentation | Ship requirement |
| N92 | Internationalization | Architecture decision |
| N93 | Disk space | Operational safety |
| N94 | Backup/migration | User experience |
| N95 | Session limits | Resource management |
| N96 | IPC protocol details | Implementation spec |
| N97 | Shutdown sequence | Safety requirement |
| N98 | Health endpoint | Monitoring requirement |
| N99 | Watchdog | Reliability requirement |
| N100 | Order ID format | Implementation detail |

---

# Summary Matrix

## Critical Decisions

| Decision | Choice | Impact |
|----------|--------|--------|
| Daemon language | Hybrid (Python + TS bridge) | Architecture |
| IPC mechanism | Unix sockets / Named pipes | Performance |
| Broker support | Alpaca only + Mock | Scope |
| Live trading | Yes, in V1 | Scope |
| Python version | 3.11 bundled | Compatibility |
| Debug format | Apache Arrow | Performance |
| AI provider | Anthropic (pluggable) | Features |
| Extension trust | Per-workspace | Security |
| Team size | 2-3 engineers | Timeline |
| Timeline | **38 weeks** (revised from 29) | Planning |
| Sleep/wake | Pause daemon, reconcile on wake | Safety |
| Network loss | Circuit breaker after 5min | Safety |
| Memory limits | 4GB backtest, 2GB live | Stability |

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| Live trading bugs | Extensive paper testing, mandatory paper first |
| Daemon crashes | Checkpoint/recovery, hash-chained audit log |
| Security vulnerabilities | Internal review + external audit |
| Scope creep | Strict V1 freeze, explicit V2 list |
| Timeline slip | 20% buffer, quality gates not dates |

---

# Section N: Missing Critical Decisions (Audit Findings)

During deep audit, I identified these gaps that need explicit decisions:

## N81. System Sleep/Wake Handling

**Decision**: Daemon pauses on sleep, resumes on wake

**Implementation**:
```
Sleep detected (OS event)
    │
    ▼
Pause strategy (no new signals)
    │
    ▼
Close WebSocket connections gracefully
    │
    ▼
Write checkpoint state
    │
    ▼
[System sleeps]
    │
    ▼
Wake detected
    │
    ▼
Reconnect to broker (with retry)
    │
    ▼
Reconcile positions with broker
    │
    ▼
Resume strategy (if market open)
```

**Risk**: Orders submitted just before sleep may be in unknown state. On wake, reconcile before resuming.

## N82. Network Connectivity Loss

**Decision**: Graceful degradation with circuit breaker

| Duration | Behavior |
|----------|----------|
| 0-30s | Retry connections, buffer signals |
| 30s-5min | Pause strategy, show warning |
| >5min | Circuit breaker, require manual intervention |

**Implementation**:
- Heartbeat to broker every 5s
- 3 missed heartbeats = connection lost
- Exponential backoff for reconnection: 1s, 2s, 4s, 8s, 16s, 30s max

## N83. Timezone Handling

**Decision**: All times UTC internally, display in user's local timezone

**Implementation**:
- Engine operates entirely in UTC
- Bar timestamps are UTC
- Order timestamps are UTC
- UI converts to local timezone for display
- User can toggle "Show UTC" in settings

**Calendar alignment**: Market calendars specify timezone (e.g., America/New_York for NYSE). Engine converts to UTC for internal use.

## N84. DST Transition Handling

**Decision**: Use timezone-aware datetime throughout

**Implementation**:
- Use `zoneinfo` (Python 3.9+ stdlib)
- Market open/close times specified in exchange timezone
- Conversion to UTC handles DST automatically
- Test vectors include DST transition dates

**Risk**: Strategies that hardcode "9:30 AM" will break. Document that users must use market calendar APIs.

## N85. User Strategy Dependencies

**Decision**: Allow user packages in isolated environment

**Implementation**:
1. Bundled Python includes core packages (numpy, pandas, scipy, scikit-learn, ta-lib)
2. User can install additional packages via `quantlab install <package>`
3. Packages installed to `~/.quantlab/packages/`
4. Engine adds user package path to `sys.path`
5. Conflicts: User packages take precedence (with warning)

**Limitations**:
- No conda support in V1
- No virtualenv per strategy (global user packages)
- V2: Per-strategy environments

## N86. Error Reporting Strategy

**Decision**: Structured errors with codes, optional telemetry

**Error structure**:
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

**Telemetry** (opt-in only):
- Error code and category (no context)
- Anonymized session ID
- No PII, no strategy details

## N87. Logging Strategy

**Decision**: Structured JSON logs with rotation

**Log files**:
| File | Content | Rotation | Retention |
|------|---------|----------|-----------|
| `app.log` | UI events | 10MB × 5 files | 7 days |
| `engine.log` | Engine events | 50MB × 10 files | 30 days |
| `daemon.log` | Per-session daemon | 50MB × 5 files | 90 days |
| `audit.log` | Trading actions | Never rotated | 7 years |

**Log levels**: Production = INFO, Debug mode = DEBUG

**Format**: JSON Lines (one JSON object per line)

## N88. Memory Management

**Decision**: Configurable memory limits with graceful handling

**Default limits**:
| Operation | Default | Max Configurable |
|-----------|---------|------------------|
| Backtest | 4GB | 16GB |
| Live session | 2GB | 8GB |
| Debug file buffer | 1GB | 4GB |

**OOM handling**:
1. Monitor memory usage every 5s
2. At 80%: Warning toast
3. At 95%: Pause and prompt
4. At limit: Graceful termination with checkpoint

## N89. Concurrent Backtests

**Decision**: Maximum 2 concurrent backtests by default

**Configuration**: `quantlab.maxConcurrentBacktests` (1-4)

**Queue behavior**: Additional backtests queued, FIFO execution

## N90. Strategy API Versioning

**Decision**: Semantic versioning with deprecation warnings

**API version header**:
```python
# quantlab: api_version=1.0
def strategy(data):
    ...
```

**Compatibility policy**:
- Minor versions: Backward compatible
- Major versions: May break
- Deprecation: 2-release warning period

## N91. Documentation Requirements for V1

**Required**:
- User Guide (Markdown → HTML, in-app + website)
- API Reference (auto-generated from docstrings)
- Strategy Examples (bundled Python files)
- Risk Disclosures (legal text, in-app)

**Not required for V1**: Video tutorials, translations

## N92. Internationalization

**Decision**: English only for V1, i18n-ready architecture

- All strings in resource files (no hardcoded)
- Date/number formatting respects locale
- V2+: Add translations

## N93. Disk Space Management

**Decision**: Warn at 90%, block at 95%

| Threshold | Action |
|-----------|--------|
| 90% | Toast warning |
| 95% | Block new backtests |
| 99% | Emergency cleanup prompt |

## N94. Backup and Migration

**Decision**: Export/import for settings and pinned run metadata

**Exportable**: Settings, keybindings, trusted workspaces, pinned run metadata

**Not exportable**: Full artifacts, cache, debug files (too large)

**Format**: ZIP with JSON contents

## N95. Concurrent Live Sessions Limit

**Decision**: Maximum 3 concurrent live sessions (hardcoded for V1)

## N96. IPC Protocol Details

**Decision**: JSON-RPC 2.0

**Request**:
```json
{"jsonrpc": "2.0", "method": "submitOrder", "params": {...}, "id": "req-001"}
```

**Response**:
```json
{"jsonrpc": "2.0", "result": {...}, "id": "req-001"}
```

**Notification** (no response):
```json
{"jsonrpc": "2.0", "method": "progress", "params": {"percent": 45}}
```

## N97. Graceful Shutdown Sequence

**Decision**: Ordered shutdown with 60s total timeout

1. Stop accepting new requests (1s)
2. Cancel pending backtests (5s)
3. For live sessions: pause, wait for bar, checkpoint (30s)
4. Close broker connections (5s)
5. Flush logs (5s)
6. Exit

## N98. Health Check Endpoint

**Decision**: Daemon exposes health via IPC `health` method

**Response includes**: status, uptime, memory, broker connection, positions

**UI polling**: Every 5s when visible

## N99. Watchdog for Daemon

**Decision**: UI monitors daemon, shows dialog if unresponsive

- Ping every 10s
- 3 missed pings = dead
- NO auto-restart (avoid surprise trading)

## N100. Order ID Generation

**Decision**: `{type}-{uuidv4}`

Examples: `ord-550e8400...`, `flat-550e8400...`, `stop-550e8400...`

---

# Section O: Consistency & Timeline Verification

## O1. Decision Consistency Matrix

| Decision A | Decision B | Status |
|------------|------------|--------|
| Alpaca data (B12) | Real-time required (B14) | ✓ Compatible |
| Python 3.11 (F35) | LibCST 1.0 (F32) | ✓ Compatible |
| Arrow format (A6) | Memory mapping (K66) | ✓ Compatible |
| Trust-based sandbox (E28) | AI in untrusted (G38) | ✓ Compatible |

## O2. Revised Timeline

**Original**: 29 weeks  
**Revised after audit**: 34-38 weeks

| Phase | Original | Revised | Delta |
|-------|----------|---------|-------|
| Foundation | 4w | 5w | +1w (IPC complexity) |
| Engine | 8w | 10w | +2w (order types) |
| UI | 6w | 7w | +1w (accessibility) |
| Testing | 6w | 8w | +2w (live vectors) |
| Release | 3w | 4w | +1w (security audit) |
| Buffer | 2w | 4w | +2w (reality) |
| **Total** | **29w** | **38w** | **+9w** |

**Recommendation**: Plan for 38 weeks (~9 months), target 32 weeks internally.

## O3. Updated Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Daemon crash during trade | Medium | High | N97, N98, N99 |
| Network loss | Medium | High | N82 |
| DST breaks timing | Low | Medium | N84 |
| Memory exhaustion | Medium | Medium | N88 |
| Disk full | Low | High | N93 |

---

# Section P: Implementation Priorities

## P1. Must-Have for V1

| ID | Decision | Category |
|----|----------|----------|
| A4, A5 | Daemon + IPC | Architecture |
| B10, B11 | Live + Alpaca | Core |
| E29, E30 | Auth + reliability | Security |
| N82, N97-99 | Network + shutdown | Safety |
| N87 | Logging | Debugging |

## P2. Should-Have for V1

| ID | Decision | Fallback |
|----|----------|----------|
| N81 | Sleep/wake | Warn user |
| N85 | User packages | Document workaround |
| N88 | Memory limits | OS handles OOM |

## P3. Nice-to-Have (V1.1)

| ID | Decision |
|----|----------|
| N92 | i18n |
| N90 | API versioning |
| B15 | Multi-provider |

---

*Document approved for implementation planning — January 25, 2026*  
*Revision 2: Added 20 critical decisions from deep audit*

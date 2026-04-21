# Appendix E: Spec-to-Code Gap Matrix

**Source**: ChatGPT Phase 0 approach (enhanced)
**Purpose**: Track implementation progress by spec section
**Last Updated**: 2026-01-26

---

## How to Use This Matrix

1. **Before Phase Start**: Review sections relevant to that phase
2. **During Implementation**: Update status as code is written
3. **Phase Gate**: Verify all relevant sections marked ✅
4. **Release**: Verify ALL sections marked ✅

### Status Legend

| Symbol | Meaning |
|--------|---------|
| 🔴 | Not Started |
| 🟡 | In Progress |
| 🟢 | Complete |
| ⏸️ | Deferred to V1.1 |
| ❌ | Out of Scope |

---

## Product Spec V10.5

| Section | Description | Status | Phase | Code Location |
|---------|-------------|--------|-------|---------------|
| §1 | Product Overview | 🟢 | — | N/A (requirements) |
| §2.1 | VS Code Inheritance | 🟢 | — | Fork base |
| §2.2 | Product Name | 🟢 | — | `product.json` |
| §2.3 | Pyright Bundling | 🔴 | 0 | `extensions/` |
| §2.4 | Extensions API | 🟢 | — | Fork inherited |
| §2.5 | Marketplace (Open VSX) | 🔴 | 0 | `product.json` |
| §3.1 | Window Architecture | 🟡 | 3 | `src/vs/workbench/` |
| §3.2 | Custom Tab Bar | 🟡 | 3 | `tabbar.ts` |
| §3.3 | Activity Bar | 🟢 | — | `extensions/quantlab/src/panels/` |
| §3.4 | Bottom Panel | 🟡 | 3 | `workbench patches` |
| §4.1 | Editor View | 🟢 | — | `views/editor/` |
| §4.2 | Chart View | 🟡 | 3 | `views/chart/` |
| §4.3 | Action View | 🟡 | 3 | `views/action/` |
| §4.4 | Trade View | 🟡 | 4 | `views/trade/` |
| §5.1 | Data Panel | 🟢 | — | `panels/DataPanelProvider.ts` |
| §5.2 | Resources Panel | 🟢 | — | `panels/ResourcesPanelProvider.ts` |
| §5.3 | History Panel | 🟡 | 3 | `panels/HistoryPanelProvider.ts` |
| §5.4 | Trade Panel | 🟡 | 4 | `panels/TradePanelProvider.ts` |
| §5.5 | Settings Panel | 🟢 | — | `panels/SettingsPanelProvider.ts` |
| §6.1 | History System | 🔴 | 2, 3 | `engine/artifacts/` |
| §6.2 | Run Pinning | 🔴 | 3 | `core/state/HistoryState.ts` |
| §6.3 | Run Comparison | 🔴 | 3 | `views/chart/comparison/` |
| §7.1 | CSV Support | 🟡 | 2 | `engine/data/csv.py` |
| §7.2 | Parquet Support | 🔴 | 2 | `engine/data/parquet.py` |
| §7.3 | Schema Detection | 🔴 | 2 | `engine/data/schema.py` |
| §7.4 | Schema Mapping | 🔴 | 2 | `engine/data/mapper.py` |
| §8.1 | Keyboard Shortcuts | 🟡 | 3 | `keybindings.json` |
| §8.2 | Two-Key Sequences | 🔴 | 3 | Extension contribution |
| §9.1 | Toast Notifications | 🟡 | 3 | `ui/notifications/` |
| §9.2 | Modal Dialogs | 🔴 | 3 | `ui/dialogs/` |
| §9.3 | Error Codes | 🔴 | 2 | `engine/errors/` |
| §10.1 | Risk Disclosure | 🔴 | 3 | `ui/onboarding/` |
| §10.2 | Broker Setup | 🟡 | 4 | `ui/onboarding/broker/` |
| §10.3 | Paper Trading | 🔴 | 4 | `core/trading/` |
| §11.1 | First-Launch Disclosure | 🔴 | 3 | `ui/onboarding/` |
| §11.2 | Pre-Trade Disclosure | 🔴 | 3 | `ui/TrustDialog.ts` |
| §11.3 | Footer Disclosure | 🔴 | 3 | `webview/shared/` |
| §11.4 | Export Disclosure | 🔴 | 3 | `engine/artifacts/export.py` |
| §12.1 | Apply to Code | 🔴 | 2 | `engine/codemod/` |
| §12.2 | Diff Preview | 🔴 | 3 | `ui/DiffDialog.ts` |
| §12.3 | Backup Management | 🔴 | 2 | `engine/codemod/backup.py` |
| §12.4 | CST Library (LibCST) | 🔴 | 2 | `engine/codemod/cst.py` |
| §13.1 | Keyboard Navigation | 🔴 | 3 | All UI components |
| §13.2 | Screen Reader | 🔴 | 3 | ARIA attributes |
| §13.3 | Focus Indicators | 🔴 | 3 | CSS tokens |
| §13.4 | Text Contrast | 🔴 | 3 | Theme colors |
| §14.1 | Close Flow | 🔴 | 3 | `ui/CloseDialog.ts` |
| §14.2 | System Tray | 🔴 | 3 | `ui/SystemTray.ts` |
| §14.3 | Recovery Modal | 🔴 | 3 | `ui/RecoveryDialog.ts` |
| §14.4 | Connection Loss | 🔴 | 4 | `core/broker/reconnect.ts` |
| §14.5 | Live Session UI | 🔴 | 4 | `ui/SessionStatus.ts` |
| §15 | Non-Goals | 🟢 | — | N/A (documented) |

---

## Technical Spec V2.5

| Section | Description | Status | Phase | Code Location |
|---------|-------------|--------|-------|---------------|
| §1.1 | Engine Overview | 🟢 | — | N/A (architecture) |
| §1.2 | Python 3.11 | 🔴 | 0 | Build pipeline |
| §1.3 | Engine Directory | 🔴 | 0 | `engine/` |
| §1.4 | Unicode NFC | 🔴 | 2 | `engine/utils/normalize.py` |
| §1.5 | Daemon Process | 🔴 | 1 | `engine/daemon/main.py` |
| §1.6 | UI Reconnection | 🔴 | 1 | `core/trading/DaemonClient.ts` |
| §2.1 | Job Lifecycle | 🔴 | 2 | `engine/jobs/` |
| §2.2 | Cancellation | 🔴 | 2 | `engine/jobs/cancel.py` |
| §2.3 | Checkpointing | 🔴 | 1 | `engine/daemon/checkpoint.py` |
| §2.4 | Progress Updates | 🔴 | 2 | `engine/jobs/progress.py` |
| §2.5 | Serialization | 🔴 | 2 | `engine/state/serialize.py` |
| §2.6 | Emergency Flatten | 🔴 | 4 | `engine/daemon/flatten.py` |
| §3.1 | Signal Bar Semantics | 🔴 | 2 | `engine/backtest/core.py` |
| §3.2 | Execution Bar | 🔴 | 2 | `engine/backtest/core.py` |
| §3.3 | Fill Assumptions | 🔴 | 2 | `engine/backtest/fills.py` |
| §3.4 | Slippage Scope | 🔴 | 2 | `engine/backtest/slippage.py` |
| §4.1 | MARKET Order | 🔴 | 2 | `engine/orders/market.py` |
| §4.2 | LIMIT Order | 🔴 | 2 | `engine/orders/limit.py` |
| §4.3 | STOP Order | 🔴 | 2 | `engine/orders/stop.py` |
| §4.4 | STOP_LIMIT Order | 🔴 | 2 | `engine/orders/stop_limit.py` |
| §4.5 | Gap-Through | 🔴 | 2 | `engine/orders/gap.py` |
| §5.1 | Short Entry | 🔴 | 2 | `engine/portfolio/short.py` |
| §5.2 | 100% Collateral | 🔴 | 2 | `engine/portfolio/short.py` |
| §5.3 | Equity Identity | 🔴 | 2 | `engine/portfolio/validation.py` |
| §5.4 | Borrow Fees | 🔴 | 2 | `engine/portfolio/fees.py` |
| §6.1 | DataRev | 🔴 | 2 | `engine/data/rev.py` |
| §6.2 | UniverseRev | 🔴 | 2 | `engine/data/universe.py` |
| §6.3 | Universe Filtering | 🔴 | 2 | `engine/data/universe.py` |
| §6.4 | Corporate Actions | ⏸️ | V1.1 | DEFERRED (Decision L71) |
| §7.1 | Cache Key Determinism | 🔴 | 2 | `engine/features/cache.py` |
| §7.2 | Look-Ahead Protection | 🔴 | 2 | `engine/features/leakage.py` |
| §8.1 | Environment Snapshot | 🔴 | 2 | `engine/snapshot/` |
| §8.2 | Determinism | 🔴 | 2 | `engine/snapshot/determinism.py` |
| §8.3 | Numerical Tolerance | 🔴 | 2 | `engine/precision/compare.py` |
| §9.1 | Return Series | 🔴 | 2 | `engine/metrics/returns.py` |
| §9.2 | Risk-Adjusted | 🔴 | 2 | `engine/metrics/risk.py` |
| §9.3 | Annualization | 🔴 | 2 | `engine/metrics/annualize.py` |
| §10.1 | Data Provider Interface | 🔴 | 4 | `engine/providers/base.py` |
| §10.2 | Broker Adapter | 🟡 | 4 | `core/broker/` |
| §10.3 | Mock Broker | 🟢 | — | `core/broker/mock/` |
| §10.4 | Alpaca Adapter | 🟡 | 4 | `core/broker/alpaca/` |
| §10.5 | Alpaca Data API | 🔴 | 4 | `engine/providers/alpaca.py` |
| §10.6 | Fill Reconciliation | 🔴 | 4 | `core/trading/fills.ts` |
| §10.7 | Position Reconciliation | 🔴 | 4 | `core/trading/reconcile.ts` |
| §11.1 | Keychain Secrets | 🟡 | 1 | VS Code SecretStorage |
| §11.2 | Encrypted Fallback | 🔴 | 1 | `core/secrets/encrypted.ts` |
| §11.3 | Argon2id KDF | 🔴 | 1 | `core/secrets/encrypted.ts` |
| §11.4 | Exposure Reservation | 🔴 | 1 | `engine/risk/exposure.py` |
| §12.1 | Append-Only Ledger | 🔴 | 4 | `engine/audit/log.py` |
| §12.2 | CRC32 Per Entry | 🔴 | 4 | `engine/audit/log.py` |
| §12.3 | Session Recovery | 🔴 | 1 | `engine/daemon/checkpoint.py` |
| §13.1 | Backtest Benchmarks | 🔴 | 1 | `benchmarks/` |
| §13.2 | UI Responsiveness | 🔴 | 5 | `tests/perf/ui.py` |
| §13.3 | Live Trading Latency | 🔴 | 5 | `tests/perf/live.py` |
| §14.1 | Calendar Schema | 🔴 | 2 | `engine/calendar/schema.py` |
| §14.2 | Calendar Files | 🔴 | 2 | `calendars/*.yaml` |
| §14.3 | NYSE Calendar | 🔴 | 2 | `calendars/nyse.yaml` |
| §14.4 | Timezone Handling | 🔴 | 2 | `engine/calendar/timezone.py` |
| §14.5 | Decimal Precision | 🔴 | 2 | `engine/precision/policy.py` |
| §15.1 | Message Ordering | 🔴 | 1 | `engine/protocol/ordering.py` |
| §15.2 | Acknowledgments | 🔴 | 1 | `engine/protocol/ack.py` |
| §15.3 | Protocol Versioning | 🔴 | 1 | `engine/protocol/version.py` |
| §16.1 | Error Taxonomy | 🔴 | 2 | `engine/errors/` |
| §16.2 | Error Codes | 🔴 | 2 | `engine/errors/codes.py` |
| §17.1 | Artifact Manifest | 🔴 | 2 | `engine/artifacts/manifest.py` |
| §17.2 | Report Schema | 🔴 | 2 | `engine/artifacts/report.py` |
| §17.3 | Export Formats | 🔴 | 3 | `engine/artifacts/export.py` |
| §18.1 | Strategy Entry Points | 🔴 | 2 | `engine/api/` |
| §18.2 | Vectorized API | 🔴 | 2 | `engine/api/vectorized.py` |
| §18.3 | Event-Driven API | 🔴 | 2 | `engine/api/event.py` |
| §18.4 | Class-Based API | 🔴 | 2 | `engine/api/class_based.py` |
| §18.5 | Parameter Extraction | 🔴 | 2 | `engine/api/params.py` |
| §18.6 | Code Modification | 🔴 | 2 | `engine/codemod/` |
| §19.1 | Debug File Format | 🔴 | 2 | `engine/debug/format.py` |
| §19.2 | Bar Snapshots | 🔴 | 3 | `engine/debug/capture.py` |
| §19.3 | Condition Capture | 🔴 | 3 | `engine/debug/capture.py` |
| §19.4 | Random Access | 🔴 | 3 | `engine/debug/index.py` |
| §19.5 | Memory Mapping | 🔴 | 3 | `engine/debug/mmap.py` |
| §20.1 | AI Panel | 🔴 | 3 | `ai/panel.ts` |
| §20.2 | Input Sanitization | 🔴 | 3 | `ai/sanitize.ts` |
| §20.3 | Context Building | 🔴 | 3 | `ai/context.ts` |
| §20.4 | Provider Integration | 🔴 | 3 | `ai/provider.ts` |
| §20.5 | Security Model | 🔴 | 3 | `ai/` |

---

## Test Spec V1.2

| Section | Description | Status | Phase | Test Count |
|---------|-------------|--------|-------|------------|
| §2.1 | Golden Test Format | 🔴 | 0 | — |
| §2.2 | Basic Execution (G001-G005) | 🔴 | 2 | 5 |
| §2.2 | Order Types (G010-G022) | 🔴 | 2 | 13 |
| §2.2 | Time-in-Force (G030-G034) | 🔴 | 2 | 5 |
| §2.2 | Short Selling (G040-G049) | 🔴 | 2 | 10 |
| §2.2 | Volume & Partial (G050-G055) | 🔴 | 2 | 6 |
| §2.2 | Slippage (G060-G065) | 🔴 | 2 | 6 |
| §2.2 | Forward Fill (G070-G074) | 🔴 | 2 | 5 |
| §2.2 | Edge Cases (G080-G089) | 🔴 | 2 | 10 |
| §2.2 | Multi-Symbol (G090-G099) | 🔴 | 2 | 10 |
| §2.2 | Exposure (G100-G105) | 🔴 | 1 | 6 |
| §3.1 | Unit Test Coverage (Engine) | 🔴 | 1-5 | ≥80% |
| §3.2 | Unit Test Coverage (UI) | 🔴 | 3-5 | ≥70% |
| §3.3 | Critical Path Coverage | 🔴 | 1-5 | 100% |
| §4.1 | Engine-Runner Integration | 🔴 | 2 | — |
| §4.2 | UI-Engine Integration | 🔴 | 3 | — |
| §4.3 | Broker Adapter Integration | 🔴 | 4 | — |
| §4.4 | Daemon Lifecycle | 🔴 | 1 | — |
| §5.1 | Core Workflow E2E | 🔴 | 5 | 3 |
| §5.2 | Trading Workflow E2E | 🔴 | 5 | 3 |
| §5.3 | Paper Trading (L001-L010) | 🔴 | 4 | 10 |
| §5.3 | Safety Tests (L020-L030) | 🔴 | 4 | 11 |
| §5.3 | Failure Tests (L040-L050) | 🔴 | 4 | 11 |
| §5.3 | Flatten Tests (L060-L070) | 🔴 | 4 | 11 |
| §6.1 | Secrets Redaction | 🔴 | 1 | — |
| §6.2 | Sandbox Tests | 🔴 | 3 | — |
| §6.3 | Trust Model Tests | 🔴 | 3 | — |
| §6.4 | Path Traversal | 🔴 | 5 | — |
| §6.5 | AI Panel Security | 🔴 | 3 | — |
| §7.1 | Reproducibility | 🔴 | 2 | — |
| §7.2 | Cross-Platform | 🔴 | 5 | — |
| §7.3 | Numerical Precision | 🔴 | 2 | — |
| §8.1 | Engine Failures | 🔴 | 2 | — |
| §8.2 | Network Failures | 🔴 | 4 | — |
| §8.3 | Concurrent Failures | 🔴 | 4 | — |
| §8.4 | Daemon Failures | 🔴 | 1 | — |
| §9.1 | Backtest Performance | 🔴 | 1, 5 | — |
| §9.2 | UI Performance | 🔴 | 5 | — |
| §9.3 | Live Latency | 🔴 | 5 | — |
| §9.4 | Debug File Performance | 🔴 | 5 | — |
| §10.1 | Smoke Tests | 🔴 | 5 | 10 |
| §10.2 | Golden Suite | 🔴 | 5 | 88 |
| §10.3 | Full Suite | 🔴 | 5 | All |
| §11.1 | Debugger Correctness | 🔴 | 3 | — |
| §12.1 | Test Data Management | 🔴 | 0 | — |
| §13.1 | CI/CD Pipeline | 🔴 | 0 | — |

---

## Operations Spec V1.3

| Section | Description | Status | Phase | Code Location |
|---------|-------------|--------|-------|---------------|
| §1.1 | Stable Channel | 🔴 | 5 | CI/CD |
| §1.2 | Beta Channel | 🔴 | 5 | CI/CD |
| §1.3 | Canary Channel | 🔴 | 5 | CI/CD |
| §2.1 | Update Frequency | 🔴 | 5 | electron-updater |
| §2.2 | Staged Rollout | 🔴 | 5 | CI/CD |
| §2.3 | Live Session Block | 🔴 | 4 | `core/trading/update.ts` |
| §2.4 | Emergency Update | 🔴 | 5 | CI/CD |
| §3.1 | Config Hierarchy | 🟡 | 0 | `settings/` |
| §3.2 | Environment Variables | 🔴 | 0 | Engine startup |
| §4.1 | Windows Support | 🔴 | 5 | Build pipeline |
| §4.2 | macOS Support | 🔴 | 5 | Build pipeline |
| §4.3 | Linux Support | 🔴 | 5 | Build pipeline |
| §5.1 | Telemetry Opt-In | 🔴 | 3 | `core/telemetry/` |
| §5.2 | Crash Reporting | 🔴 | 3 | `core/telemetry/` |
| §5.3 | Metrics Collection | 🔴 | 5 | CI/CD |
| §6.1 | Fork Strategy | 🟢 | — | `PATCHES.md` |
| §6.2 | Upstream Merge | 🔴 | Ongoing | Monthly |
| §6.3 | Security Patches | 🔴 | Ongoing | 48h SLA |
| §7.1 | Calendar Files | 🔴 | 2 | `calendars/` |
| §7.2 | Calendar Validation | 🔴 | 2 | CI check |
| §7.3 | Calendar Update | 🔴 | Ongoing | December |
| §8.1 | P1 Response | 🔴 | — | Runbook |
| §8.2 | P2-P4 Response | 🔴 | — | Runbook |
| §9.1 | User Backup | 🔴 | 3 | Docs |
| §9.2 | Corruption Detection | 🔴 | 4 | `engine/audit/` |
| §9.3 | Ledger Recovery | 🔴 | 4 | `engine/audit/` |
| §10.1 | Documentation | 🔴 | 5 | `docs/` |
| §10.2 | Support Channels | 🔴 | 5 | Docs |

---

## Implementation Decisions Coverage

| Range | Decisions | Status | Notes |
|-------|-----------|--------|-------|
| A1-A6 | Architecture | ✅ All referenced | A4, A5, A6 explicitly |
| B7-B15 | Scope | ✅ All referenced | B11, B12 explicitly |
| C16-C20 | Operations | ✅ All referenced | C17, C18, C20 explicitly |
| D21-D25 | Testing | ✅ All referenced | D23, D24, D25 explicitly |
| E26-E31 | Security | ✅ All referenced | E27, E29, E30, E31 explicitly |
| F32-F36 | Dependencies | ✅ All referenced | F32, F33 explicitly |
| G37-G43 | UI/UX | ✅ All referenced | G37 explicitly |
| H44-H53 | Edge Cases | ✅ All referenced | H44-H53 in Phase 3, 4 |
| I54-I57 | Deployment | ✅ All referenced | I56 explicitly |
| J58-J62 | Timeline | ✅ All referenced | J58, J60, J61 explicitly |
| K63-K68 | Clarifications | ✅ All referenced | K65, K67 explicitly |
| L69-L76 | Operations | ✅ All referenced | L71 explicitly |
| M77-M80 | VS Code Fork | ✅ All referenced | Appendix D |
| N81-N100 | Critical | ✅ All referenced | All 20 in relevant phases |

---

## Summary by Phase

| Phase | Total Sections | Complete | In Progress | Not Started | Deferred |
|-------|----------------|----------|-------------|-------------|----------|
| Phase 0 | 15 | 2 | 3 | 10 | 0 |
| Phase 1 | 25 | 1 | 1 | 23 | 0 |
| Phase 2 | 60 | 0 | 0 | 59 | 1 |
| Phase 3 | 40 | 0 | 5 | 35 | 0 |
| Phase 4 | 30 | 0 | 2 | 28 | 0 |
| Phase 5 | 25 | 0 | 0 | 25 | 0 |
| **Total** | **195** | **3** | **11** | **180** | **1** |

---

## Update Instructions

When completing work:

1. Find the relevant section in this matrix
2. Update status: 🔴 → 🟡 → 🟢
3. Add code location if not present
4. Update summary counts at bottom
5. Commit change with "Gap matrix: [section] complete"

---

*This matrix tracks implementation progress. Update status as code is written and tested.*

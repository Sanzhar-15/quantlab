# Phase 0: Setup and Gap Analysis

**Duration**: 2 weeks
**Priority**: CRITICAL - Foundation for all subsequent phases
**Source**: Merged (ChatGPT gap analysis + Claude setup tasks)
**Decisions Reference**: A1-A6, I54-I57, J58-J62, K67

---

## Objectives

1. **Establish baseline** of current implementation state
2. **Build gap matrix** mapping specs to code
3. **Resolve build/packaging** strategy for bundled Python
4. **Set up CI/CD** with benchmark baseline
5. **Create foundational artifacts** (design system, test harness, certificates)

---

## 1. Current Implementation Baseline

### 1.1 Verified from Codebase

| Component | Current State | Gap |
|-----------|---------------|-----|
| **UI Extension** | Built-in at `extensions/quantlab/` with Chart/Action/Trade editors | Partial |
| **Engine** | TS-only mocks (`EngineHost`, `JobRunner`) | Full rebuild needed |
| **Data** | Mock OHLCV data, basic CSV loading | Provider adapter needed |
| **Trading** | `SessionManager` with Alpaca/Mock adapters | No daemon, no IPC |
| **Secrets** | VS Code SecretStorage only | Need encrypted fallback |
| **Trust** | Workspace trust exists | No extension trust UI |
| **AI Panel** | Not implemented | Full implementation needed |
| **Testing** | Small TS unit test set | No golden vectors |

### 1.2 What Exists vs What's Needed

```
Existing (keep/enhance):
├── extensions/quantlab/           # Enhance with daemon client
│   ├── src/core/trading/         # Add IPC, exposure, reconciliation
│   ├── src/views/chart/          # Add debugger controls
│   └── webview/                  # Add flatten dialog, trust UI
└── workbench patches             # Enhance for system tray

New (create):
├── engine/                       # Full Python engine
│   ├── quantlab/                # Core packages
│   │   ├── backtest/           # Order execution
│   │   ├── daemon/             # Live trading daemon
│   │   ├── data/               # Data handling
│   │   └── ...
│   └── tests/                   # Golden vectors
├── schemas/                      # Shared JSON schemas
└── build/                        # Packaging scripts
```

---

## 2. Gap Matrix

### 2.1 Product Spec V10.5 Coverage

| Section | Description | Status | Priority |
|---------|-------------|--------|----------|
| §1 | Product Overview | ✅ Understood | — |
| §2 | Platform Foundation (Pyright) | 🔴 Not implemented | HIGH |
| §3 | Window Architecture | 🟡 Partial (patches exist) | MEDIUM |
| §4 | View System | 🟡 Partial | MEDIUM |
| §5 | Activity Bar Panels | 🟡 Partial | MEDIUM |
| §6 | History System | 🟡 Partial (no artifacts) | HIGH |
| §7 | Data File Handling | 🟡 Partial | MEDIUM |
| §8 | Keyboard Shortcuts | 🟡 Partial | LOW |
| §9 | Notifications & Errors | 🟡 Partial | MEDIUM |
| §10 | Onboarding | 🟡 Partial | MEDIUM |
| §11 | Regulatory Disclosures | 🔴 Not implemented | HIGH |
| §12 | Code Modification Safety | 🔴 Not implemented | HIGH |
| §13 | Accessibility | 🔴 Not implemented | MEDIUM |
| §14 | Live Session UI | 🔴 Not implemented | HIGH |

### 2.2 Technical Spec V2.5 Coverage

| Section | Description | Status | Priority |
|---------|-------------|--------|----------|
| §1.5-1.6 | Daemon Architecture | 🔴 Not implemented | CRITICAL |
| §3-4 | Backtest Contract, Orders | 🔴 Not implemented | CRITICAL |
| §5 | Short Selling Model | 🔴 Not implemented | CRITICAL |
| §6 | Data Provenance | 🔴 Not implemented | HIGH |
| §7 | Feature Store Contract | 🔴 Not implemented | MEDIUM |
| §8 | Environment Reproducibility | 🔴 Not implemented | HIGH |
| §9 | Metrics Dictionary | 🔴 Not implemented | MEDIUM |
| §10 | Plugin Architecture | 🔴 Not implemented | HIGH |
| §11 | Security & Safety | 🔴 Not implemented | CRITICAL |
| §12 | Failure Modes & Recovery | 🔴 Not implemented | CRITICAL |
| §13 | Performance Expectations | 🔴 Not implemented | HIGH |
| §14 | Data Schemas | 🔴 Not implemented | HIGH |
| §15 | Streaming Protocol | 🔴 Not implemented | CRITICAL |
| §16-17 | Error Taxonomy, Artifacts | 🔴 Not implemented | HIGH |
| §18 | Strategy API | 🔴 Not implemented | CRITICAL |
| §19 | Debugger Contract | 🔴 Not implemented | HIGH |
| §20 | AI Panel Security | 🔴 Not implemented | HIGH |

### 2.3 Test Spec V1.2 Coverage

| Section | Description | Status | Count |
|---------|-------------|--------|-------|
| §2 | Golden Vectors | 🔴 Not implemented | 88 tests |
| §3 | Unit Tests | 🟡 Partial (TS only) | — |
| §4 | Integration Tests | 🔴 Not implemented | — |
| §5 | E2E + Live Trading | 🔴 Not implemented | 43 tests |
| §6 | Security Tests | 🔴 Not implemented | ~25 tests |
| §7 | Determinism Tests | 🔴 Not implemented | — |
| §8 | Chaos Tests | 🔴 Not implemented | — |
| §9 | Performance Tests | 🔴 Not implemented | ~15 tests |

### 2.4 Operations Spec V1.3 Coverage

| Section | Description | Status | Priority |
|---------|-------------|--------|----------|
| §1 | Distribution Architecture | 🔴 Not implemented | HIGH |
| §2 | Update System | 🔴 Not implemented | HIGH |
| §3 | Configuration Management | 🟡 Partial | MEDIUM |
| §4 | Platform Requirements | ✅ Understood | — |
| §5 | Monitoring & Telemetry | 🔴 Not implemented | MEDIUM |
| §6 | Fork Maintenance | 🔴 Not documented | MEDIUM |
| §7 | Calendar Maintenance | 🔴 Not implemented | MEDIUM |
| §8 | Incident Response | 🔴 Not documented | LOW |

---

## 3. Build and Packaging Strategy

### 3.1 Python Bundling (Decision A2)

| Platform | Approach | Location |
|----------|----------|----------|
| Windows | Embedded Python 3.11 zip | `resources/python/` |
| macOS | Framework Python in app bundle | `Quantlab.app/Contents/Resources/python/` |
| Linux | AppImage with bundled Python | `usr/lib/quantlab/python/` |

### 3.2 Build Pipeline

```
Source
    │
    ├── Engine Build
    │   ├── Lint + type check (Pyright)
    │   ├── Unit tests (pytest)
    │   └── Package wheel
    │
    ├── Extension Build
    │   ├── TypeScript compile
    │   ├── Bundle with webpack
    │   └── Unit tests (Jest)
    │
    └── Packaging
        ├── Download/embed Python 3.11
        ├── Create venv, install dependencies
        ├── Install engine wheel
        ├── Code sign (Windows EV, macOS notarization)
        └── Create installer/AppImage
```

### 3.3 Runtime Selection Logic

```python
# Default: bundled Python
python_path = get_bundled_python_path()

# Override: user setting
if settings.get('quantlab.python.path'):
    python_path = settings.get('quantlab.python.path')

# Validation
if not validate_python(python_path):
    show_error("Invalid Python configuration")
    python_path = get_bundled_python_path()
```

---

## 4. Setup Tasks

### 4.1 Development Environment

| Task | Effort | Owner |
|------|--------|-------|
| Create `engine/` directory structure | 0.5d | Backend |
| Set up pyproject.toml with dependencies | 0.5d | Backend |
| Configure Pyright for engine | 0.5d | Backend |
| Set up pytest with coverage | 0.5d | Backend |
| Create `schemas/` directory with initial schemas | 1d | Full-stack |
| Configure ESLint + Prettier for consistency | 0.5d | Frontend |

### 4.2 CI/CD Pipeline

| Task | Effort | Owner |
|------|--------|-------|
| Create engine CI workflow (lint, test, coverage) | 1d | DevOps |
| Create extension CI workflow | 0.5d | DevOps |
| Create packaging workflows (Windows, macOS, Linux) | 2d | DevOps |
| Set up benchmark baseline job | 1d | DevOps |
| Configure code coverage gates | 0.5d | DevOps |

### 4.3 Foundational Artifacts

| Task | Effort | Owner | Decision |
|------|--------|-------|----------|
| Create `DESIGN_SYSTEM.md` | 2d | Design | K67 |
| Create golden test runner infrastructure | 2d | QA | — |
| Create test fixtures and benchmark datasets | 1d | QA | — |
| Document Unicode NFC normalization policy | 0.5d | Backend | Tech §1.4 |
| Set up calendar maintenance tooling | 1d | Backend | C17 |
| Procure code signing certificates | — | DevOps | I56 |
| **Evaluate VS Code updater infrastructure** | 1d | Platform | I55 |

### 4.4 Decision Checkpoint: Auto-Update Infrastructure (Decision I55)

**Question**: Does the VS Code fork provide adequate update infrastructure, or do we need electron-updater?

**Evaluation criteria**:
- [ ] Supports staged rollout percentages
- [ ] Supports crash-rate gating
- [ ] Supports blocking during live sessions
- [ ] Supports differential updates

**If VS Code updater meets all criteria**: Reuse it, skip electron-updater.
**If not**: Implement electron-updater as planned.

**Owner**: Platform team
**Due**: End of Phase 0 Week 1
**Output**: Document decision in `docs/decisions/auto-update.md`

### 4.5 Documentation

| Task | Effort | Owner |
|------|--------|-------|
| Document architecture decisions | 1d | Architect |
| Create PATCHES.md for VS Code fork | 0.5d | Frontend |
| Document migration policy (V1 breaking) | 0.5d | PM |

---

## 5. Exit Criteria

### 5.1 Mandatory

- [ ] Gap matrix reviewed and approved
- [ ] Build/packaging strategy documented and validated
- [ ] Engine directory structure created with working pytest
- [ ] CI/CD pipeline running (lint, test, coverage)
- [ ] Golden test runner infrastructure ready
- [ ] Code signing certificates ordered (may not arrive before Phase 0 ends)

### 5.2 Artifacts

| Artifact | Location |
|----------|----------|
| Gap matrix | This document |
| Build strategy | Appendix_A_Build_Packaging.md |
| Design system stub | `DESIGN_SYSTEM.md` |
| Test fixtures | `engine/tests/fixtures/` |
| Benchmark datasets | `engine/tests/benchmarks/` |

---

## 6. Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Code signing delays | HIGH | Medium | Order immediately; can proceed without for internal testing |
| Bundled Python size > 300MB | Medium | Low | Optimize dependencies; use --no-deps where safe |
| CI runner capacity | Low | Medium | Use self-hosted runners if needed |

---

## 7. Phase 0 Deliverables Checklist

### Week 1
- [ ] Gap matrix complete
- [ ] Engine directory structure created
- [ ] pyproject.toml configured
- [ ] CI workflows created (not necessarily passing)
- [ ] Code signing certificates ordered
- [ ] **VS Code updater evaluation complete (I55)**

### Week 2
- [ ] CI workflows passing
- [ ] Golden test runner infrastructure complete
- [ ] Design system stub created
- [ ] Test fixtures created
- [ ] Build strategy validated on all platforms
- [ ] **Gate: Gap matrix approved, build strategy resolved**

---

*Phase 0 completion enables all subsequent phases. No code implementation yet—this phase is planning and infrastructure only.*

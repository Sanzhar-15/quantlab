# Quantlab VS Code Fork Patches

**Last Updated**: 2026-02-01
**Base Version**: VS Code 1.96.x
**Fork Strategy**: Minimal patches, upstream-compatible

---

## Overview

Quantlab is built as a customized fork of VS Code. This document tracks all modifications made to the upstream codebase to facilitate:

1. **Upstream merges**: Understanding what needs to be rebased
2. **Maintenance**: Tracking technical debt from patches
3. **Security**: Ensuring security patches are not accidentally reverted

---

## Patch Categories

### Category A: Branding & Identity
Cosmetic changes that don't affect functionality.

### Category B: Feature Additions
New functionality added to VS Code.

### Category C: Behavior Modifications
Changes to existing VS Code behavior.

### Category D: Build & Packaging
Changes to build system and packaging.

### Category E: Intelligence
AI-powered coding assistance integrated into the workbench.

---

## Active Patches

### A1: Product Branding

**Files Modified**:
- `product.json` - Product name, icons, telemetry endpoints
- `resources/linux/code.png` - Application icon
- `resources/darwin/code.icns` - macOS icon
- `resources/win32/code.ico` - Windows icon

**Description**: Replace VS Code branding with Quantlab branding.

**Upstream Impact**: None (file-level replacement)

---

### A2: Window Title

**Files Modified**:
- `src/vs/workbench/browser/parts/titlebar/titlebarPart.ts`

**Description**: Custom window title format showing strategy name and trading status.

**Upstream Impact**: Low (isolated change)

---

### B1: Quantlab Extension (Built-in)

**Files Added**:
- `extensions/quantlab/` - Complete trading extension

**Description**: Built-in extension providing Chart, Action, Trade views and trading functionality.

**Upstream Impact**: None (additive)

---

### B2: Custom Tab Bar

**Files Modified**:
- `src/vs/workbench/browser/parts/editor/tabsTitleControl.ts`

**Description**: Modified tab bar to support colored tab stripes for view types (Chart=blue, Action=green, Trade=orange).

**Upstream Impact**: Medium (core UI component)

---

### B3: Activity Bar Icons

**Files Modified**:
- `src/vs/workbench/browser/parts/activitybar/activitybarPart.ts`

**Description**: Custom activity bar configuration for Data, Resources, History, Trade, Settings panels.

**Upstream Impact**: Low (configuration change)

---

### C1: Workspace Trust for Trading

**Files Modified**:
- `src/vs/workbench/services/workspaces/common/workspaceTrust.ts`

**Description**: Extended workspace trust model to include strategy file hash verification for live trading.

**Upstream Impact**: Medium (security-critical)

---

### C2: Extension Trust for Live Trading

**Files Modified**:
- `src/vs/workbench/services/extensionManagement/common/extensionManagement.ts`

**Description**: Added extension review requirement before live trading can be enabled.

**Upstream Impact**: Medium (security-critical)

---

### D1: Python Bundling

**Files Added**:
- `build/bundlePython.js` - Python bundling script
- `build/downloadPython.js` - Python download script

**Files Modified**:
- `build/gulpfile.vscode.js` - Added Python bundling step

**Description**: Bundle Python 3.11 with installers for offline usage.

**Upstream Impact**: Low (build system only)

---

### D2: Open VSX Marketplace

**Files Modified**:
- `product.json` - Marketplace URLs

**Description**: Configure Open VSX as the extension marketplace instead of VS Code Marketplace.

**Upstream Impact**: None (configuration)

---

### E1: QIC — Quantlab Intelligence Console

**Files Added**:
- `src/vs/workbench/contrib/qic/` - Complete QIC contribution (browser/, common/, test/, scripts/)

**Files Modified**:
- `engine/quantlab/daemon/main.py` - QIC handler registration in engine daemon
- `engine/quantlab/daemon/qic_handlers.py` - Python-side QIC request handlers

**Description**: Built-in AI coding assistant registered as a workbench contribution in the auxiliary bar. Provides multi-provider LLM gateway (Anthropic, OpenAI, Ollama), 22 agentic tools, 8-lane request routing, inline completions (6-tier waterfall), crash-safe journaled writes, incremental BM25+vector context indexing, and quant-domain features (DataFrame preview, backtest analysis, anti-pattern detection). Security layer includes Aho-Corasick secret scanning, egress boundary enforcement, terminal security guard, tool chain monitoring, and hash-chained audit logging. All API keys stored via SecretStorage (not plaintext settings). Activation split into Phase A (sync) + Phase B (async) with 5-level graceful degradation.

**Key Invariants**:
- INV-T1: No file edits without ApprovalToken
- INV-T3: No data egress without consent + secret redaction
- INV-A2: All file writes use JournaledAtomicWriter

**Upstream Impact**: None (additive — workbench contribution only)

---

## Pending Patches (Not Yet Applied)

### B4: System Tray Integration (Phase 3)
System tray icon showing trading status.

### B5: Time-Travel Debugger (Phase 3)
Custom debugger panel for backtest stepping.

### C3: Live Session Block on Close (Phase 3)
Prevent window close during live trading without confirmation.

---

## Upstream Merge Strategy

### Monthly Merge Process

1. **Create merge branch**: `git checkout -b merge/upstream-YYYY-MM`
2. **Fetch upstream**: `git fetch upstream`
3. **Merge upstream main**: `git merge upstream/main`
4. **Resolve conflicts** (see Conflict Resolution below)
5. **Run full test suite**: `npm test && pytest engine/tests/`
6. **Create PR for review**

### Conflict Resolution Priority

1. **Security patches**: Always take upstream
2. **Branding (A-category)**: Keep Quantlab changes
3. **Features (B-category)**: Rebase onto new upstream
4. **Behavior (C-category)**: Careful review required
5. **Build (D-category)**: Usually compatible

### Security Patch SLA

- **Critical (CVE)**: Apply within 48 hours
- **High**: Apply within 1 week
- **Medium/Low**: Include in next monthly merge

---

## Testing After Merge

After each upstream merge, run:

```bash
# VS Code tests
npm test

# Engine tests
cd engine && pytest tests/

# Integration tests
npm run test:integration

# Smoke test
npm run test:smoke
```

---

## Reverting Patches

If a patch causes issues:

```bash
# Identify the patch commit
git log --oneline --grep="PATCH:"

# Revert specific patch
git revert <commit-hash>

# Or reset to pre-patch state
git reset --hard <pre-patch-commit>
```

---

## Changelog

| Date | Patch | Action | Notes |
|------|-------|--------|-------|
| 2026-02-01 | E1: QIC | Added | Intelligence Console — 21 prompt implementation complete |
| 2026-01-26 | Document created | Initial | Phase 0 setup |

---

*This document must be updated whenever patches are added, modified, or removed.*

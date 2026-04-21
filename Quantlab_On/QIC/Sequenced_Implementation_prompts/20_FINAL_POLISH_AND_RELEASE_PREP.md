# Prompt 20 — Final Polish, Documentation & Release Preparation

**Phase**: 11 (Final)
**Prerequisites**: Prompt 19 (integration testing passes)
**Estimated Scope**: ~5 files created/modified

---

## Objective

Final polish: fix any issues found during integration testing, optimize performance bottlenecks, write developer documentation, and prepare QIC for release. This is the last prompt before QIC ships.

---

## Implementation Instructions

### 1. Fix Integration Test Failures

Review all test results from Prompt 19 and fix any failures. Common issues to check:

- Race conditions in concurrent message handling
- Memory leaks from unreleased event listeners
- Edge cases in FlexibleMatcher strategies
- Timeout issues in provider adapter streaming
- CSS rendering issues in different themes

### 2. Performance Optimization

Profile and optimize any SLO violations:

- **Completion latency**: Ensure debounce is working, context assembly is cached
- **Indexing speed**: Use batch SQLite inserts, parallel file reading
- **Memory usage**: Verify cache eviction is working, no lingering references
- **Journal write**: Batch small writes, use fdatasync instead of fsync where safe

### 3. Developer Documentation

Create minimal internal documentation:

**`src/vs/workbench/contrib/qic/ARCHITECTURE.md`**:
- Component dependency graph
- Data flow diagram (user message → response)
- File organization overview
- How to add a new tool
- How to add a new provider adapter
- Key architectural decisions and invariants

### 4. PATCHES.md Update

> **AUDIT FIX III-QI9 (MEDIUM)**: Follow the exact PATCHES.md format used by existing entries. Use category "E (Intelligence)", status "Active", include key decisions about reusing existing infrastructure.

Add QIC to Quantlab's `PATCHES.md` tracking file:

```markdown
## E1: QIC — Quantlab Intelligence Console

**Category**: E (Intelligence)
**Status**: Active
**Files Modified**:
- `src/vs/workbench/workbench.common.main.ts` (import added)
- `src/vs/workbench/contrib/qic/` (new directory, ~70 files)

**Description**: AI-powered coding assistant panel in the auxiliary bar.
Provides chat interface with multi-turn tool use, inline code completions,
22 tools for file operations/search/terminal/LSP, crash-safe atomic writes
via JournaledAtomicWriter, 8-lane architecture, and quant-specific features.

Features:
- Chat interface with multi-turn tool use
- Inline code completions
- 22 tools for file operations, search, terminal, LSP
- Aho-Corasick secret scanning (60+ patterns)
- Crash-safe journaled atomic writes
- 8-lane architecture with per-lane token budgets
- Quant-specific: DataFrame preview, Arrow IPC, Python engine bridge
- Privacy-respecting telemetry (opt-in)

**Key Decisions**:
- Built as workbench contribution (not extension) for deep integration
- Reuses existing Quantlab AI module for consent, sanitization, and audit
- Extends existing Python engine for quant analysis (no separate sidecar)
- Reuses existing IPC layer for Python bridge communication
- JournaledAtomicWriter for crash-safe file operations
- Explicit agentic while-loop (not streaming for-await) for tool calls
- Block-all-by-default egress policy with per-category consent
- Hash-chained security audit log (SHA-256, consistent with engine audit)
- API keys stored via SecretStorage (not plaintext settings)
```

### 5. Settings Schema

Ensure all QIC settings are documented in the VS Code settings JSON schema at `schemas/`:

```json
{
    "qic.provider.default": {
        "type": "string",
        "default": "anthropic",
        "description": "Default AI provider for QIC",
        "enum": ["anthropic", "openai", "ollama"]
    },
    // REMEDIATION FIX 4f: API keys removed from settings schema per Prompt 18's XI-SV7 fix.
    // API keys are stored via SecretStorage (ISecretStorageService), NOT plaintext settings.
    // Use: secretStorageService.store('qic.anthropicApiKey', key)
    // Retrieve: secretStorageService.get('qic.anthropicApiKey')
    // ... all remaining QIC settings (non-secret)
}
```

### 6. Error Code Documentation

Verify all 30+ error codes have:
- User-facing message
- At least one test
- Entry in the ERROR_REGISTRY

### 7. Final Verification Checklist

Run through this manual checklist:

```
□ Fresh install: QIC panel appears, first-run consent works
□ Chat: Send message, get streaming response
□ Tool use: LLM calls read_file and write_file correctly
□ Multi-turn: Tool results are sent back to LLM for follow-up
□ Diff preview: Shows proposed changes, user can approve/reject
□ Inline completion: Ghost text appears after typing
□ Crash recovery: Kill during write → restart → files consistent
□ Settings: All QIC settings visible in VS Code settings
□ Keybinding: Ctrl+Shift+I toggles QIC panel
□ Themes: Chat panel looks correct in light, dark, and high-contrast
□ Large files: 100MB file doesn't cause OOM
□ Secrets: API keys in code are redacted before sending to LLM
□ Status bar: Shows QIC state correctly
□ Cancellation: Escape cancels in-progress request
□ Error handling: Missing API key shows helpful message, not crash
□ Quant: DataFrame preview works for parquet files
□ Memory: Stays under 500MB with 10K files indexed
```

---

## Files to Create/Modify

| File | Purpose |
|------|---------|
| `src/vs/workbench/contrib/qic/ARCHITECTURE.md` | Developer docs |
| `PATCHES.md` | **Modify** — Add QIC entry |
| Various | Fix integration test failures |

---

## Acceptance Criteria (SHIP-READY)

```
□ All integration tests pass (Prompt 19)
□ All SLO benchmarks met
□ All 41 Appendix C checks pass
□ All 11 invariants verified
□ No [STUB] warnings
□ No TypeScript errors
□ Manual verification checklist complete
□ PATCHES.md updated with correct format (category E, status Active) — audit fix III-QI9
□ Developer documentation written
□ QIC is ready for production use in Quantlab
```

---

## Summary of All 21 Prompts

| # | Prompt | Phase | Key Deliverables |
|---|--------|-------|-----------------|
| 00 | Scaffold & Workbench Integration | Pre | Panel in aux bar, egress stub |
| 01 | JournaledAtomicWriter | 0 | Crash-safe atomic writes |
| 02 | FileContent Types | 0 | Stream-based file handling |
| 03 | Checkpoint & State Persistence | 0 | CV-1–CV-5, SQLite state |
| 04 | Canonical Types & Registries | 1 | Types, tools, errors, lanes |
| 05 | Storage & State Machines | 1 | FSMs, timeout, cancellation |
| 06 | Security Foundation | 2 | Egress, consent, Aho-Corasick |
| 07 | Mutation & Reliability | 3 | Edit engine, matcher, recovery |
| 08 | Gateway & Providers | 4 | 3 adapters, rate limiter, streaming |
| 09 | Context Engine | 5a | Indexer, reranker, assembler |
| 10 | Agent Runtime | 5b | **Orchestrator**, lane router |
| 11 | Completion & Resilience | 6 | Inline completion, degradation |
| 12 | Chat Panel UI | 7 | Webview chat interface |
| 13 | Diff & Permissions UI | 7 | Diff preview, permission dialogs |
| 14 | Security Hardening | 8 | Terminal guard, audit logger |
| 15 | Tool Implementations | 8-9 | All 22 tools |
| 16 | Quant Domain | 9 | DataFrame, Arrow, Python engine bridge |
| 17 | Telemetry & Reproducibility | 10 | Telemetry, replay, cache |
| 18 | Activation & Wiring | Int | Full system wiring |
| 19 | Integration Testing | 11 | E2E, benchmarks, validation |
| 20 | Final Polish | 11 | Fixes, docs, release prep |

---

## Audit Fixes Applied

The following fix from the deep audit (QIC_PROMPT_AUDIT_AND_IMPROVEMENTS.md) has been incorporated into this prompt:

| Fix ID | Severity | Summary |
|--------|----------|---------|
| **III-QI9** | MEDIUM | Updated PATCHES.md format to match existing entries: Use category "E (Intelligence)", status "Active", include key decisions about reusing existing infrastructure (Python engine, IPC layer, consent/sanitization/audit modules). |

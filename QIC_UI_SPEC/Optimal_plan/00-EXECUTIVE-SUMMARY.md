# QIC UI Implementation Plan - Executive Summary

**Version:** 1.0 | **Date:** February 2026

---

## Critical Analysis of Spec v1.4

The UI spec was produced without full codebase access. This plan reconciles the spec with existing architecture, identifies conflicts, and provides an optimal implementation path.

### Key Findings

| Category | Count | Impact |
|----------|-------|--------|
| Existing alignments | 12 | Can leverage |
| Direct conflicts | 8 | Must resolve |
| Spec gaps (missing context) | 11 | Must address |
| Dead code to remove | 4 files/sections | Blocking |

---

## Existing Architecture Strengths

The codebase already has robust implementations for:

1. **ViewPane in AuxiliaryBar** - Proper VS Code integration
2. **Overlay Webview** - Flexible UI rendering
3. **Checkpoints with quarantine** - Safety system
4. **Degradation Manager** - 5-level graceful degradation
5. **Audit Log with hash chain** - Tamper-proof logging
6. **Consent Store** - Multi-boundary consent
7. **Tool execution framework** - Permission-gated tools
8. **Provider Gateway** - Multi-provider abstraction
9. **Context Assembler** - Intelligent context building
10. **Model Registry** - Provider/model management

---

## Critical Conflicts to Resolve

| Spec Says | Codebase Has | Resolution |
|-----------|--------------|------------|
| Minimal header: Logo + Menu + New | Complex header with provider dropdown, cost, 4 buttons | **Adopt spec** - Use menu dropdown |
| Quick Picks for history/settings/checkpoints | Floating panels inside webview | **Adopt spec** - Native VS Code patterns |
| Revision-based message sync | Simple message passing | **Hybrid** - Add revision for reliability |
| React-window virtualization | Vanilla JS, no virtualization | **Defer** - Implement lazy loading first |
| Single `QICState` model | Fragmented state across services | **Adopt spec** - Unified state |
| @ mentions with autocomplete | No mention system | **Implement** - New feature |
| Branch/regenerate UI | No branching | **Implement** - New feature |

---

## Spec Gaps (What the LLM Didn't Know)

These exist in the codebase but aren't in the spec:

1. **Lane System** - Different prompts for ask/gather/plan/act modes
2. **Tool Call UI** - Existing tool-call-started/result message types
3. **File Reference Syntax** - `[[path]]` clickable file references
4. **Code Completion Engine** - Separate from chat, needs status
5. **Replay System** - Testing/debugging infrastructure
6. **Quality Signal Service** - User feedback collection
7. **Session Cache** - Performance optimization
8. **Indexer** - Code search/embeddings status
9. **Provider Selection** - Real-time provider switching
10. **DataTier/Privacy Modes** - Standard/Private/Local modes
11. **Strategy File Detection** - Live trading safety

---

## Implementation Phases (Revised)

| Phase | Focus | Duration | Dependencies |
|-------|-------|----------|--------------|
| **0** | Cleanup + Foundation | 1 week | None |
| **1** | Protocol + State | 1 week | Phase 0 |
| **2** | Panel + Input | 1.5 weeks | Phase 1 |
| **3** | Conversation + Streaming | 1.5 weeks | Phase 2 |
| **4** | Context Management | 1.5 weeks | Phase 3 |
| **5** | Changes + Diff | 2 weeks | Phase 4 |
| **6** | Native Integration | 1 week | Phase 3 |
| **7** | Polish + Accessibility | 1 week | All |

**Total: ~11 weeks** (vs spec's 15 weeks - faster due to existing foundation)

---

## Priority Matrix

### P0 - Must Have (Weeks 1-6)
- Clean panel structure
- Message protocol with revisions
- Conversation UI with streaming
- Context chips + drawer
- Change summary + CodeLens
- Status bar integration
- Quick Picks (history, checkpoints, provider)

### P1 - Should Have (Weeks 7-9)
- @ Mentions with autocomplete
- Unified review mode
- Branch/regenerate UI
- Help modal
- Confirmation dialogs

### P2 - Nice to Have (Weeks 10-11)
- Audit log viewer (modal)
- Export functionality
- Conversation search
- First-run polish

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Message protocol migration breaks existing features | Medium | High | Gradual migration with feature flags |
| Virtualization performance issues | Low | Medium | Benchmark early, can defer |
| Native Quick Pick limitations | Medium | Low | Fall back to webview if needed |
| State sync race conditions | Medium | High | Implement revision system properly |

---

## Document Index

| Document | Purpose |
|----------|---------|
| `01-CLEANUP-PHASE.md` | Dead code removal, conflict resolution |
| `02-ARCHITECTURE-DECISIONS.md` | Key technical choices |
| `03-STATE-AND-PROTOCOL.md` | Unified state + message protocol |
| `04-PANEL-STRUCTURE.md` | Header, conversation, input layout |
| `05-CONTEXT-SYSTEM.md` | Chips, drawer, @ mentions |
| `06-CHANGES-AND-DIFF.md` | Change summary, CodeLens, review |
| `07-NATIVE-INTEGRATION.md` | Quick Picks, status bar, modals |
| `08-SPEC-AMENDMENTS.md` | Additions to spec from codebase |
| `09-MIGRATION-STRATEGY.md` | How to safely transition |

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Panel render time | < 200ms | Performance API |
| Input latency | < 50ms | Performance API |
| Memory (idle) | < 50MB | Process monitor |
| WCAG compliance | AA | aXe audit |
| First productive use | < 5 min | User testing |
| Feature discoverability | 80% | User testing |

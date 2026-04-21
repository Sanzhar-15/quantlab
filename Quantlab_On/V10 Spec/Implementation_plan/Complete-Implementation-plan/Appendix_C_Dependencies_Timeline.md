# Appendix C: Dependencies, Parallelization, and Timeline

**Source**: ChatGPT plan (enhanced with Claude effort estimates)
**Status**: Authoritative for scheduling
**Owner**: Program Management

---

## Phase Dependencies

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PHASE DEPENDENCY GRAPH                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│     Phase 0 ─────► Phase 1 ─────► Phase 2 ─────► Phase 4 ─────► Phase 5    │
│    (Setup)       (Infra)        (Engine)        (Live)         (Release)    │
│     2 wks         5 wks          10 wks          6 wks          4 wks       │
│                      │                                                      │
│                      │           ┌──────────────────────────────────┐       │
│                      └──────────►│     Phase 3 (UI/Safety)         │       │
│                                  │     7 wks (overlaps Phase 2)     │       │
│                                  └──────────────────────────────────┘       │
│                                                                             │
│                   CRITICAL PATH: 0 → 1 → 2 → 4 → 5                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Detailed Dependencies

| From | To | Dependency Type | Blocking Artifacts |
|------|-----|-----------------|-------------------|
| Phase 0 | Phase 1 | Hard | Gap matrix, build strategy, schemas |
| Phase 1 | Phase 2 | Hard | Protocol, daemon skeleton, exposure model |
| Phase 1 | Phase 3 | Hard | IPC client, daemon interface |
| Phase 2 | Phase 3 (Debugger) | Soft | Artifact schema, engine events |
| Phase 2 | Phase 4 | Hard | All engine features, golden tests passing |
| Phase 3 | Phase 4 | Soft | UI components (can integrate incrementally) |
| Phase 4 | Phase 5 | Hard | Live trading complete, all tests defined |

---

## Parallelization Rules (Decision J59)

### What CAN Run in Parallel

| Work Stream A | Work Stream B | Notes |
|--------------|---------------|-------|
| Phase 2 (Engine) | Phase 3 (UI/Safety) | After Phase 1 complete |
| Phase 2 (Core) | Phase 3 (Debugger) | Debugger needs artifact schema |
| Phase 3 (Trust) | Phase 2 (Engine) | Independent features |
| Phase 3 (AI Panel) | Phase 2 (Engine) | Independent features |

### What CANNOT Run in Parallel

| Work Stream | Depends On | Reason |
|-------------|------------|--------|
| Phase 4 | Phase 2 + Phase 3 | Live trading needs complete engine + UI |
| Phase 5 (Security Audit) | Phase 4 | Must audit complete system |
| Phase 5 (Release) | All tests passing | Gate requirement |

### Parallel Execution Diagram

```
Week:  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38
       ├──┬──┼──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┤
       │P0│P1│P1│P1│P1│P1│B1│P2│P2│P2│P2│P2│P2│P2│P2│P2│P2│B2│P4│P4│P4│P4│P4│P4│B3│P5│P5│P5│P5│BF│BF│BF│BF│  │  │  │
       ├──┴──┼──┴──┴──┴──┼──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┼──┴──┴──┴──┴──┴──┼──┴──┴──┴──┴──┼──┴──┴──┴──┤  │  │  │
       │     │           │              │P3│P3│P3│P3│P3│P3│P3│                 │              │           │  │  │  │
       │     │           │              ├──┴──┴──┴──┴──┴──┴──┤                 │              │           │  │  │  │
       └─────┴───────────┴──────────────┴───────────────────┴─────────────────┴──────────────┴───────────┴──┴──┴──┘

Legend: P0=Phase 0, P1=Phase 1, P2=Phase 2, P3=Phase 3, P4=Phase 4, P5=Phase 5, B=Buffer, BF=Final Buffer
```

---

## Phase Gates (Decision D25)

### Gate Requirements

| Phase | Gate | Requirement | Verification |
|-------|------|-------------|--------------|
| Phase 0 → 1 | G0 | Gap matrix approved | PM sign-off |
| Phase 0 → 1 | G0 | Build strategy resolved | CI green for skeleton |
| Phase 1 → 2 | G1 | Engine unit tests ≥ 80% | CI coverage report |
| Phase 1 → 2 | G1 | Daemon starts/stops | Integration test |
| Phase 2 → 4 | G2 | G001-G049 pass (100%) | Golden test suite |
| Phase 3 → 4 | G3 | UI integration ≥ 70% | Coverage report |
| Phase 4 → 5 | G4 | L001-L070 pass (100%) | Live test suite |
| Phase 5 → Release | G5 | All tests pass | CI gate |
| Phase 5 → Release | G5 | Security audit complete | Audit report |

### Gate Blockers

If a gate fails:
1. **Cannot proceed** to next phase
2. **Root cause** must be identified
3. **Fix** must be implemented and verified
4. **Re-test** gate requirements

---

## Timeline Breakdown

### Summary

| Phase | Duration | Start Week | End Week | Notes |
|-------|----------|------------|----------|-------|
| Phase 0 | 2 weeks | 1 | 2 | Setup |
| Phase 1 | 5 weeks | 3 | 7 | +1 week buffer (W8) |
| Phase 2 | 10 weeks | 9 | 18 | Core engine |
| Phase 3 | 7 weeks | 12 | 18 | Overlaps Phase 2 |
| Phase 4 | 6 weeks | 19 | 24 | +2 weeks buffer (W25-26) |
| Phase 5 | 4 weeks | 27 | 30 | Testing & release |
| Final Buffer | 8 weeks | 31 | 38 | Contingency & rollout |
| **Total** | **38 weeks** | — | **W38** | **~20% buffer** |

### Detailed Effort by Phase

#### Phase 0 (2 weeks)
| Task | Effort | Parallel |
|------|--------|----------|
| Gap matrix | 3d | No |
| Build strategy | 2d | Yes |
| Engine skeleton | 2d | Yes |
| CI setup | 2d | Yes |
| Design system stub | 2d | Yes |
| **Total** | 11d (~2 weeks) | |

#### Phase 1 (5 weeks)
| Task | Effort | Parallel |
|------|--------|----------|
| Daemon process | 8d | No |
| IPC protocol | 6d | No |
| Exposure manager | 8d | Partial |
| Secrets backend | 6d | Yes |
| Benchmark harness | 5d | Yes |
| **Total** | 33d (~5 weeks) | |

#### Phase 2 (10 weeks)
| Task | Effort | Parallel |
|------|--------|----------|
| Backtest core | 10d | No |
| Order types | 12d | Partial |
| Short selling | 6d | Partial |
| Data provenance | 6d | Yes |
| Metrics | 4d | Yes |
| Calendar/timezone | 4d | Yes |
| Code modification | 5d | Yes |
| **Total** | 47d (~10 weeks) | |

#### Phase 3 (7 weeks)
| Task | Effort | Parallel with Phase 2 |
|------|--------|-----------------------|
| Pre-trade checklist | 5d | Yes |
| Debugger | 10d | Partial |
| Trust model | 6d | Yes |
| UI enhancements | 6d | Yes |
| AI panel | 6d | Yes |
| Accessibility | 4d | Yes |
| **Total** | 37d (~7 weeks) | |

#### Phase 4 (6 weeks)
| Task | Effort | Parallel |
|------|--------|----------|
| Emergency flatten | 5d | No |
| Fill reconciliation | 4d | No |
| Drift detection | 3d | Partial |
| Network handling | 4d | Yes |
| Sleep/wake | 3d | Yes |
| Session limits | 2d | Yes |
| **Total** | 21d (~4-5 weeks) | + Integration |

#### Phase 5 (4 weeks)
| Task | Effort | Parallel |
|------|--------|----------|
| Golden test execution | 3d | Yes |
| Live test execution | 3d | Yes |
| Performance testing | 3d | Yes |
| Security audit | 5d | No |
| Documentation | 3d | Yes |
| Release prep | 3d | No |
| **Total** | 20d (~4 weeks) | |

---

## Critical Path Analysis

### Critical Path Tasks

```
Gap Matrix → Daemon → IPC → Backtest Core → Order Types → Golden Tests → Live Tests → Release
```

### Critical Path Duration

| Task | Duration | Cumulative |
|------|----------|------------|
| Gap Matrix | 3d | 3d |
| Daemon Process | 8d | 11d |
| IPC Protocol | 6d | 17d |
| Backtest Core | 10d | 27d |
| Order Types | 12d | 39d |
| Golden Tests (G001-G049) | — | — |
| Live Trading Integration | 10d | 49d |
| Live Tests (L001-L070) | — | — |
| Security Audit | 5d | 54d |
| Release Prep | 3d | 57d |
| **Total** | **~57 days** (~11.5 weeks) | |

### Buffer Allocation

| After Phase | Buffer | Purpose |
|-------------|--------|---------|
| Phase 1 | 1 week | Stabilize daemon before engine |
| Phase 4 | 2 weeks | Stabilize live trading |
| Final | 4 weeks | Final contingency, delays |
| **Total Buffer** | **7 weeks** (20%) | |

**Note**: The 7 weeks buffer (20%) is distributed as: 1 week after Phase 1 (absorbed into Phase 2 start), 2 weeks after Phase 4 (weeks 24-25), and 4 weeks final buffer (weeks 34-38). The summary timeline shows 38 weeks total including all buffers.

---

## Risk-Adjusted Schedule

### Optimistic (No Delays)

- **End Date**: Week 30 (7.5 months)
- **Probability**: 10%

### Expected (Minor Delays)

- **End Date**: Week 34 (8.5 months)
- **Probability**: 60%

### Pessimistic (Major Delays)

- **End Date**: Week 38 (9.5 months)
- **Probability**: 30%

### Risk Factors

| Risk | Impact on Schedule | Mitigation |
|------|-------------------|------------|
| Daemon stability issues | +2-4 weeks | Extra testing in Phase 1 |
| Golden test failures | +1-2 weeks | TDD from start |
| Security audit findings | +1-2 weeks | Internal audit first |
| Code signing delays | +2-4 weeks | Order early in Phase 0 |

---

## Resource Requirements

### Team Composition (Decision J58)

| Role | Count | Focus |
|------|-------|-------|
| Backend Engineer | 1-2 | Engine, daemon, data |
| Frontend Engineer | 1 | UI, debugger, AI panel |
| Full-Stack Engineer | 0-1 | Integration, testing |
| **Total** | **2-3** | |

### Infrastructure

| Resource | Purpose |
|----------|---------|
| CI/CD (GitHub Actions) | Build, test, release |
| Self-hosted runner | Performance benchmarks |
| Test devices | Windows, macOS, Linux |
| Code signing certificates | Release signing |

---

## Release Readiness Checklist

- [ ] All phase gates passed
- [ ] All 88 golden tests passing
- [ ] All 43 live trading tests passing
- [ ] Security audit complete (internal required, external recommended)
- [ ] Performance benchmarks within spec
- [ ] Code signing certificates installed
- [ ] Update system verified (live session blocking)
- [ ] Documentation published
- [ ] Design system applied
- [ ] Staged rollout plan ready

---

*This appendix is authoritative for scheduling and dependencies. Reference from Program Management.*

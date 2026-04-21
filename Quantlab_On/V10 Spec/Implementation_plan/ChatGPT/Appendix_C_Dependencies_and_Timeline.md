# Appendix C - Dependencies, Parallelization, and Timeline

Date: 2026-01-26
Status: Planning
Owner: Program

## Phase Dependencies
- Phase 0 -> Phase 1 (schemas, packaging path, update path).
- Phase 1 -> Phase 2 (engine depends on schema/protocol).
- Phase 1 -> Phase 3 (daemon depends on protocol/auth).
- Phase 2 + Phase 3 -> Phase 4 (live safety requires engine + daemon).
- Phase 2 -> Phase 5 (debugger needs artifacts and engine).
- Phase 6 can start after Phase 1 (trust, AI, secrets) but must finish before live GA.
- Phase 7 gates release after Phase 4 and Phase 5.

## Parallelization Rules (Decision J59)
- Phase 2 (engine) and Phase 3 (UI/tray/daemon) may run in parallel after Phase 1.
- Phase 5 (debugger) may start after Phase 2 core artifacts.
- Phase 6 (trust/AI/secrets) can overlap with Phase 2/3.
- Phase 4 must wait for Phase 2 + Phase 3 completion.
- Phase 7 only after all required phase gates pass.

## Phase Gates (Decision D25)
- Phase 1: Engine unit tests >= 80% coverage.
- Phase 2: Golden vectors G001-G049 pass.
- Phase 3: Integration tests >= 70% UI coverage.
- Phase 4: All vectors incl. L001-L070 pass.

## Timeline (Estimate)
- Total: ~38 weeks (includes 20% buffer).

### Suggested Allocation
- Phase 0: 2 weeks
- Phase 1: 5 weeks
- Phase 2: 10 weeks
- Phase 3: 8 weeks (overlaps Phase 2 by 4 weeks)
- Phase 4: 6 weeks
- Phase 5: 4 weeks (overlaps late Phase 2)
- Phase 6: 5 weeks (overlaps Phases 2-4)
- Phase 7: 4 weeks

### Buffer Placement
- 1 week after Phase 1
- 2 weeks after Phase 3
- 2 weeks before Phase 7 completion

## Critical Path
Phase 0 -> Phase 1 -> Phase 2 -> Phase 4 -> Phase 7

## Release Readiness Checklist (summary)
- All phase gates pass.
- External security audit complete or formally waived.
- Code signing certificates ready.
- Update system verified with live-session blocking.
- Design system published and applied.


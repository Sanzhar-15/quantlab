# Epics, Backlog, and Definition of Done (V3)
**Goal:** turn architecture into buildable workstreams with measurable outcomes.

---

## Epic 0 — Foundations
**Deliverables**
- renderer interface + lifecycle
- tier selection scaffolding
- transport abstraction (SAB + message)
- observability baseline

**DoD**
- init/render/destroy cycles leak-free
- fallback selection works deterministically
- logs show “why” tier chosen

---

## Epic 1 — WebGPU Tier B baseline (premium compatible)
**Deliverables**
- instanced candles
- analytic grid
- pan/zoom transforms
- crosshair + tooltip (no readback)

**DoD**
- crosshair remains responsive under stress scenes
- stable crispness at DPI/zoom
- no long main-thread tasks during interaction

---

## Epic 2 — Data pipeline + LOD + envelopes
**Deliverables**
- columnar store
- LOD pyramid builder
- Stage 0 envelope silhouette

**DoD**
- correctness tests pass (LOD aggregation)
- large dataset ingestion doesn’t jank the UI
- stage 0 silhouette renders instantly

---

## Epic 3 — Tile cache + scheduler
**Deliverables**
- tile keying + invalidation
- reprojection pan
- LRU eviction + budgets
- progressive refinement

**DoD**
- “instant pan” is perceivable at 50k+ visible bars
- budgets enforce stable memory usage
- refinement never blocks crosshair

---

## Epic 4 — Text system production
**Deliverables**
- MSDF numeric/Latin lane
- Canvas2D/DOM fallback lane
- stability rules (hysteresis/snapping)

**DoD**
- no shimmer during kinetic zoom/pan
- atlas budgets stable
- complex scripts render correctly via fallback

---

## Epic 5 — Tier A worker renderer
**Deliverables**
- OffscreenCanvas + worker rendering path
- SAB turbo input lane
- auto-fallback to Tier B when worker path fails

**DoD**
- Tier A chosen only when stable
- seamless downgrade without blank frames

---

## Epic 6 — Safety renderers (Tier C/D)
**Deliverables**
- WebGL2 minimal renderer
- Canvas2D safe mode
- shader translation strategy (portable subset)

**DoD**
- any environment renders a usable chart
- tier downgrade tested under simulated failures

---

## Epic 7 — Production hardening
**Deliverables**
- device lost recovery state machine
- error scopes + uncaptured error telemetry
- remote allow/denylist + kill switch
- CI perf + visual regression gates

**DoD**
- stable p95/p99 frame pacing across target cohorts
- no crash-to-blank known issues
- runbook for debugging + rollback procedures

---

## Suggested ticket slicing
For each epic, create tickets by subsystem boundary:
- API + interface
- unit tests
- perf harness scenario
- acceptance criteria measured

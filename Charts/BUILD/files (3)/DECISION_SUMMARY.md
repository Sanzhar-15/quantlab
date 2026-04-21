# Delta Charting V5.2: Decision Summary

## The One-Sentence Goal
Build a trading chart that demonstrably exceeds TradingView in HiDPI sharpness, momentum feel, and measured performance — in 2 weeks.

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Layers** | 3 | Grid+data update together; 4th layer adds overhead without clear benefit |
| **During drag** | Direct 1:1 | Springs cause lag; pro traders need precision |
| **On release** | Friction momentum | Springs would bounce; friction decays naturally |
| **Spring solver** | Simple Euler | Analytic is overkill at 60Hz; defer to V2 if 120Hz needed |
| **Rubber-band** | None in V1 | Stop at boundaries; add polish in V2 if requested |
| **Crosshair** | Direct (no spring) | Any lag is noticeable and feels wrong |
| **Indicators** | SMA, EMA only | Minimum viable; more in V2 |
| **HiDPI** | devicePixelContentBox | Primary technical differentiator |

---

## What We Beat TradingView On

1. **HiDPI sharpness** — devicePixelContentBox is more precise than DPR multiplication
2. **Momentum feel** — iOS-like friction curve (tunable, measured)
3. **Performance transparency** — We measure; they don't publish numbers

## What We Match

- 60fps rendering
- Candlestick quality
- Basic functionality

## What We're Behind On (V1)

- Feature count (they have 100+ indicators, we have 2)
- Drawing tools (they have many, we have none)
- Multi-chart sync

---

## Success Criteria

| Metric | Target | Blocker? |
|--------|--------|----------|
| 10k candles render | < 10ms P95 | Yes |
| Frame time (panning) | < 16.67ms P95 | Yes |
| Dropped frames | < 1% | Yes |
| Direct manipulation lag | 0 | Yes |

---

## Timeline

| Week | Deliverable |
|------|-------------|
| Week 1 | Static chart renders, performance validated |
| Week 2 | Full interaction, indicators, demo complete |
| Week 3 (optional) | Polish, bug fixes, documentation |

---

## Files to Implement

```
src/
├── types.ts              # 50 lines
├── math/viewport.ts      # 100 lines
├── rendering/
│   ├── layers.ts         # 100 lines
│   ├── candlesticks.ts   # 80 lines
│   ├── grid.ts           # 60 lines
│   └── ...
├── interaction/
│   ├── controller.ts     # 100 lines
│   ├── momentum.ts       # 50 lines
│   └── ...
└── indicators/
    ├── sma.ts            # 30 lines
    └── ema.ts            # 30 lines

Total: ~1500 lines
```

---

## Start Here

1. Read: `DELTA_CHARTING_V5.2_SPECIFICATION.md`
2. Follow: `IMPLEMENTATION_PLAN_V5.2.md` (day-by-day)
3. Reference: `SPEC_EVOLUTION_COMPARISON.md` (if you need context on WHY)

---

*This is the final, optimized spec. Ship it.*

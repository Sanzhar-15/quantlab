# Delta Charting V6: Decision Summary

## One-Sentence Goal

Transform Delta Charting from a high-performance chart renderer into a complete professional trading platform charting solution.

---

## V5.2 → V6 Evolution

| Aspect | V5.2 | V6 |
|--------|------|------|
| **Purpose** | Chart renderer | Trading platform |
| **Indicators** | SMA, EMA only | RSI, MACD, Bollinger, ATR, VWAP, Stochastic |
| **Multi-chart** | None | Full sync (pan, zoom, crosshair) |
| **Trading** | None | Orders, positions, P&L overlay |
| **Volume** | Basic histogram | Full Volume Profile with POC/VA |
| **Physics** | Euler (60Hz) | Analytic spring (120Hz) |
| **Edges** | Stop at boundary | Rubber-band overscroll |
| **A11y** | None | prefers-reduced-motion |

---

## Priority Matrix

| Feature | Priority | Impact | Effort | Phase |
|---------|----------|--------|--------|-------|
| Trading Indicators | P0 | High | Medium | 1 |
| Multi-Chart Sync | P0 | High | Medium | 2 |
| Order/Position Overlay | P0 | Critical | Medium | 3 |
| Volume Profile | P1 | High | Medium | 4 |
| Analytic Spring | P2 | Medium | Low | 5 |
| Rubber-Band | P2 | Low | Low | 5 |
| Accessibility | P2 | Medium | Low | 5 |

---

## Implementation Timeline

```
Week 1-2: Phase 1 - Indicators
├── Day 1: RSI
├── Day 2: MACD
├── Day 3: Bollinger Bands
├── Day 4: ATR
├── Day 5: VWAP
├── Day 6: Stochastic
├── Day 7: Indicator pane renderer
├── Day 8-10: Integration & testing

Week 3: Phase 2 - Multi-Chart Sync
├── Day 11: SyncController core
├── Day 12: Time sync
├── Day 13: Crosshair sync
├── Day 14: Integration
├── Day 15: Testing

Week 4: Phase 3 - Trading Overlay
├── Day 16: Order rendering
├── Day 17: Position rendering
├── Day 18: Order dragging
├── Day 19: P&L display
├── Day 20: Integration

Week 5: Phase 4 - Volume Profile
├── Day 21: Calculation
├── Day 22: Rendering
├── Day 23: POC/VA display
├── Day 24: Session profiles
├── Day 25: Testing

Week 6: Phase 5 - Polish
├── Day 26: Analytic spring
├── Day 27: Rubber-band
├── Day 28: Accessibility
├── Day 29: Integration
├── Day 30: Documentation
```

**Total: 6 weeks**

---

## File Structure (New/Modified)

```
packages/
├── chart-core/
│   └── src/
│       ├── sync-controller.ts    # NEW
│       ├── spring.ts             # NEW
│       ├── rubber-band.ts        # NEW
│       ├── accessibility.ts      # NEW
│       └── physics-controller.ts # MODIFIED
│
├── chart-indicators/
│   └── src/
│       └── indicators/
│           ├── rsi.ts            # NEW
│           ├── macd.ts           # NEW
│           ├── bollinger.ts      # NEW
│           ├── atr.ts            # NEW
│           ├── vwap.ts           # NEW
│           ├── stochastic.ts     # NEW
│           └── volume-profile.ts # NEW
│
├── chart-trading/                # NEW PACKAGE
│   └── src/
│       ├── types.ts
│       ├── trading-overlay.ts
│       ├── order-renderer.ts
│       └── position-renderer.ts
```

---

## Key Technical Decisions

### 1. Indicator Architecture
**Decision:** Follow existing SMA/EMA pattern with incremental computation

**Why:**
- Consistent with codebase
- Efficient for real-time updates
- Easy to add more indicators

### 2. Sync Controller Pattern
**Decision:** Pub/sub with event broadcasting, loop prevention via flag

**Why:**
- Decoupled from chart implementation
- Supports multiple sync groups
- No infinite loops

### 3. Trading Overlay as Plugin
**Decision:** ChartPlugin, not built into core

**Why:**
- Optional feature (not all charts need trading)
- Keeps core lightweight
- Easy to customize/extend

### 4. Analytic vs Euler Spring
**Decision:** Analytic solver using closed-form damped oscillator

**Why:**
- Stable at all frame rates (60Hz to 144Hz)
- Mathematically correct
- Better for 120Hz displays (becoming common)

### 5. Volume Profile Buckets
**Decision:** 48 buckets default, configurable

**Why:**
- Balance between detail and performance
- Similar to TradingView
- <10ms calculation for 10k bars

---

## Success Criteria

### Performance

| Metric | Target |
|--------|--------|
| Indicator calculation (10k bars) | <5ms |
| Sync event latency | <16ms |
| Trading overlay render | <1ms per frame |
| Volume profile calculation | <10ms |
| Spring animation overhead | <0.5ms per frame |

### Functionality

| Feature | Requirement |
|---------|-------------|
| RSI | Matches TradingView within 0.1% |
| MACD | Histogram + lines correct |
| Multi-chart sync | All charts update within 1 frame |
| Order drag | Smooth, no jank |
| Volume Profile POC | Matches TradingView |

### Quality

| Aspect | Requirement |
|--------|-------------|
| Accessibility | prefers-reduced-motion respected |
| Memory | No leaks after 1hr use |
| Edge cases | Empty data, single points handled |
| Documentation | All new APIs documented |

---

## API Preview

### Indicators
```typescript
chart.addIndicator('rsi', { period: 14 });
chart.addIndicator('macd', { fast: 12, slow: 26, signal: 9 });
chart.addIndicator('bollinger', { period: 20, stdDev: 2 });
```

### Multi-Chart Sync
```typescript
const sync = new SyncController();
sync.createGroup({ id: 'my-charts', mode: 'time' });
sync.addChart(chart1, 'my-charts');
sync.addChart(chart2, 'my-charts');
```

### Trading Overlay
```typescript
const trading = createTradingOverlayPlugin({
  orders: [...],
  positions: [...],
  onOrderDrag: (id, price) => { ... },
});
chart.addPlugin(trading);
```

### Volume Profile
```typescript
const volumeProfile = createVolumeProfilePlugin({
  numBuckets: 48,
  displaySide: 'left',
  showPOC: true,
  showValueArea: true,
});
chart.addPlugin(volumeProfile);
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Indicator accuracy | Medium | High | Compare with TradingView |
| Sync performance | Low | Medium | Debounce, RAF alignment |
| Trading overlay jank | Medium | High | Profile, optimize render |
| Spring instability | Low | Low | Unit tests, visual tests |

---

## Documents Reference

1. **DELTA_CHARTING_V6_SPECIFICATION.md** - Complete specification
2. **PHASE_1_INDICATORS.md** - Indicator implementation guide
3. **PHASE_2_MULTI_CHART_SYNC.md** - Sync controller guide
4. **PHASE_3_TRADING_OVERLAY.md** - Trading overlay guide
5. **PHASE_4_VOLUME_PROFILE.md** - Volume profile guide
6. **PHASE_5_POLISH.md** - Spring, rubber-band, accessibility guide

---

## Start Here

1. **Read:** `DELTA_CHARTING_V6_SPECIFICATION.md` for full context
2. **Implement:** Follow phase documents in order
3. **Test:** Each phase has verification checklist
4. **Iterate:** Refine based on testing

---

## What This Enables

With V6 complete, Delta Plus will have:

✅ **Professional indicators** - RSI, MACD, Bollinger, etc.
✅ **Multi-chart layouts** - Synchronized timeframes
✅ **Order visualization** - See and drag orders on chart
✅ **Position tracking** - Real-time P&L display
✅ **Volume analysis** - Professional volume profile
✅ **Premium feel** - Smooth physics, accessibility

This transforms Delta Charting from "a chart library" to "the charting system for Delta Plus trading platform."

---

*V6 is the bridge from rendering to trading. Ship it.*

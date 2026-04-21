# Delta Charting Spec Evolution: V5.0 → V5.1 → V5.2

## The Journey

| Version | Problem | Solution | Result |
|---------|---------|----------|--------|
| **V5.0** | "How do we exceed TradingView?" | "Spring physics everywhere!" | Over-engineered, wrong interaction model |
| **V5.1** | "V5.0 springs during drag = laggy" | "Direct manipulation + analytic solver" | Correct model, still over-engineered |
| **V5.2** | "V5.1 is too complex for V1" | "Simplify to essentials" | **Right scope, right complexity** |

---

## Feature Comparison

| Feature | V5.0 | V5.1 | V5.2 |
|---------|------|------|------|
| **Layers** | 6 | 4 | **3** |
| **During drag** | Spring (wrong) | Direct | **Direct** |
| **Momentum** | Spring-based | Friction-based | **Friction-based** |
| **Spring solver** | Euler | Analytic | **Euler (sufficient)** |
| **Rubber-band** | Yes | Yes | **No (V2)** |
| **Crosshair** | Spring | Direct | **Direct** |
| **Indicators** | Mentioned | Mentioned | **Specified (SMA/EMA)** |
| **Perf harness** | No | Yes | **Yes** |
| **Timeline** | 4-5 weeks | 2.5 weeks | **2 weeks** |

---

## Complexity Comparison

### V5.0 Physics (Over-engineered)
```
SpringAnimation (Euler)
├── MomentumController (spring-based)
├── ZoomController (spring-based)
├── RubberBandController
└── Crosshair (spring-based)
```
**Lines of code estimate:** ~800

### V5.1 Physics (Still over-engineered)
```
VelocityTracker
├── MomentumController (friction-based) ✓
├── SpringAnimation (analytic solver) ← Complex
├── RubberBandController ← Not needed for V1
└── Crosshair (direct) ✓
```
**Lines of code estimate:** ~600

### V5.2 Physics (Right-sized)
```
VelocityTracker
├── MomentumController (friction-based, simple Euler)
└── Crosshair (direct)
```
**Lines of code estimate:** ~200

**V5.2 is 75% less code for the same user-perceived quality.**

---

## Why V5.2 is Optimal

### 1. Right Scope

| V5.1 Feature | User Impact | V5.2 Decision |
|--------------|-------------|---------------|
| Analytic spring solver | Noticeable only at 120Hz | **Defer to V2** |
| Rubber-band overscroll | Nice polish, not essential | **Defer to V2** |
| 4 layers vs 3 | ~0.5ms savings in rare cases | **Use 3, profile later** |
| 5-state machine | Same UX as 3-state | **Use 3 states** |

### 2. Right Complexity

**Analytic Spring Solver:**
- V5.1: ~150 lines of complex math (closed-form damped oscillator)
- V5.2: ~30 lines of simple Euler integration

**Both produce nearly identical results at 60Hz.** The analytic solver matters at 120Hz, which is a V2 concern.

### 3. Right Timeline

| Version | Timeline | Risk |
|---------|----------|------|
| V5.0 | 4-5 weeks | High (wrong interaction model) |
| V5.1 | 2.5 weeks | Medium (over-engineered) |
| V5.2 | 2 weeks | **Low (focused scope)** |

### 4. Honest Differentiation

**V5.0 claimed:** "Spring physics is THE differentiator"
**V5.1 claimed:** "Direct manipulation + physics on release"
**V5.2 claims:** 

> "We demonstrably exceed TradingView in:
> 1. HiDPI sharpness (devicePixelContentBox)
> 2. Momentum feel (iOS-like friction)
> 3. Measured performance (<10ms for 10k candles)
> 
> We match TradingView in core functionality.
> We're behind on features (indicators, drawing tools)."

This is honest and defensible.

---

## What I Removed and Why

### Analytic Spring Solver

**V5.1 had:**
```typescript
// ~150 lines of complex math
if (Math.abs(zeta - 1) < 0.001) {
  // Critically damped
  const expTerm = Math.exp(-omega0 * t);
  const position = target + (A + B * t) * expTerm;
  // ...
} else if (zeta > 1) {
  // Overdamped
  const sqrtTerm = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega0 * (zeta - sqrtTerm);
  // ...
} else {
  // Underdamped
  const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
  // ...
}
```

**V5.2 has:**
```typescript
// ~30 lines of simple physics
const frictionPerFrame = Math.pow(FRICTION, dtMs / 16.67);
velocity *= frictionPerFrame;
position += velocity * dtSec;
```

**Why this is fine:** Momentum doesn't need a spring. It needs friction decay. The simple approach IS correct.

### Rubber-Band Overscroll

**V5.1 had:** Full rubber-band with asymptotic resistance + spring snap-back

**V5.2 has:** Just stop at boundaries

**Why this is fine:** Pro traders prefer precision over bounce effects. If they hit a boundary, they want to know it. We can add rubber-band in V2 if users request it.

### 4th Layer (Grid)

**V5.1 had:** Separate grid and data layers

**V5.2 has:** Combined into single data layer

**Why this is fine:** Grid and data almost always update together. The 0.5ms savings from separating them isn't worth the extra compositor overhead. If profiling shows otherwise, we add the layer.

---

## What I Added

### Basic Indicators (SMA, EMA)

**V5.0 and V5.1:** "Indicators... (mentioned)"

**V5.2:** Full implementation spec for SMA and EMA

**Why:** A trading chart without indicators is incomplete. Even V1 needs at least moving averages.

### Honest Comparison Section

**V5.0 and V5.1:** Vague claims about "exceeding TradingView"

**V5.2:** Specific, measurable claims:
- HiDPI: devicePixelContentBox (provable)
- Momentum: iOS-like friction (testable)
- Performance: <10ms for 10k candles (measurable)

Plus honest acknowledgment of what we DON'T exceed.

---

## Risk Analysis

| Risk | V5.0 | V5.1 | V5.2 |
|------|------|------|------|
| Wrong interaction model | **HIGH** | Low | Low |
| Over-engineering | High | **MEDIUM** | **LOW** |
| Missing essential features | Medium | Medium | **LOW** |
| Unproven claims | **HIGH** | Medium | **LOW** |
| Timeline slip | **HIGH** | Medium | **LOW** |

---

## Final Recommendation

**V5.2 is optimal because:**

1. **It's the minimum necessary to achieve the goal.** Not less (missing features), not more (over-engineered).

2. **Every decision is justified.** No "might need this" — only "definitely need this."

3. **It's honest.** We know exactly where we beat TradingView and where we don't.

4. **It's shippable in 2 weeks.** That's fast enough to get real user feedback before investing more.

5. **It has a clear V2 roadmap.** We know what to add if users want it.

---

## Checklist Before Implementation

- [ ] Agree that 3 layers is sufficient (profile later)
- [ ] Agree that simple Euler momentum is sufficient (analytic in V2 if needed)
- [ ] Agree that no rubber-band in V1 is acceptable
- [ ] Agree that SMA/EMA are sufficient indicators for V1
- [ ] Agree that 2-week timeline is realistic
- [ ] Agree on success criteria (10k candles <10ms, 60fps during pan)

If all checked: **Start building.**

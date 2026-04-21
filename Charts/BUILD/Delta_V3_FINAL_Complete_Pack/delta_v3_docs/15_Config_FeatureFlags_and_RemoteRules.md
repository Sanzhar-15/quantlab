# Config, Feature Flags, and Remote Rules (V3 Add‑On)
**Purpose:** Define a consistent configuration system for quality knobs, tier gating, and emergency controls.

---

## 0) Goals
- Allow safe rollout of Tier A and new features.
- Enable emergency downgrade without redeploy.
- Keep configuration deterministic and observable.

---

## 1) Configuration layers (priority order)
1. **Hard-coded safety defaults** (ship in code)
2. **Remote config** (fetched at runtime; signed/hashed)
3. **User overrides** (dev/debug only unless product exposes settings)
4. **Runtime auto-tuning** (microbench results)

Remote config must not break the app if unavailable; use cached last-known-good with expiry.

---

## 2) Remote config schema (example)
```json
{
  "version": 3,
  "createdAt": "2026-01-05T00:00:00Z",
  "rules": [
    {
      "if": { "browser": "Safari", "os": "iOS", "tierA": true },
      "then": { "forceTier": "B", "reason": "Worker WebGPU unstable on cohort X" }
    },
    {
      "if": { "gpuVendor": "SomeVendor", "arch": "SomeArch" },
      "then": { "disableMsaa": true, "maxDpr": 1.5 }
    }
  ],
  "defaults": {
    "tierAEnabled": true,
    "tileSizePx": 512,
    "maxDpr": 2.0,
    "tileBudgetMB": 192,
    "atlasBudgetMB": 48,
    "uploadBudgetMBPerSec": 64
  }
}
```

---

## 3) Feature flags
Flags should be grouped by subsystem:

### 3.1 Rendering
- `enableMsaa`
- `enablePostSharpen`
- `enableRenderBundles`
- `enableTileAtlas` (atlas vs per-tile textures)
- `enableStage2Polish`

### 3.2 Text
- `enableMsdfAxisText`
- `enableDynamicGlyphPages`
- `forceCanvasTextFallback`

### 3.3 Data/compute
- `enableGpuEnvelopeCompute`
- `enableCpuWasmIndicators`
- `enableGpuIndicators` (off by default; benchmark-gated)

### 3.4 Debug/diagnostics (dev only)
- `showTileOverlay`
- `showOverdrawHeatmap`
- `dumpWireMessages`

---

## 4) Deterministic decision logging
Every session should produce a compact decision log:
- chosen tier
- remote config version/hash
- microbench score
- applied overrides
- disabled features and why

This is critical for support and incident response.

---

## 5) Emergency controls (kill switches)
Remote rules must support:
- forcing Tier C/D
- disabling Tier A entirely
- disabling specific pipelines (e.g., MSAA)
- reducing budgets and max DPR

---

## 6) Checklist
- [ ] Remote config fetch is secure and cached
- [ ] Decisions are logged and accessible
- [ ] Feature flags grouped and tested
- [ ] Kill switches verified in staging

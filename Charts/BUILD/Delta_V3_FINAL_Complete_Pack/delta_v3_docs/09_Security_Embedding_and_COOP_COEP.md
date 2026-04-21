# Security, Embedding, and COOP/COEP Notes (V3)
**Goal:** ship a high-performance engine without breaking real-world deployments.

---

## 1) Cross-origin isolation (Turbo mode)
SharedArrayBuffer and WASM threads typically require cross-origin isolation.

This introduces constraints:
- COOP/COEP headers must be set by the hosting app
- third-party scripts/resources must comply with CORP/CORS policies
- embedding in arbitrary sites may be impossible with isolation

**Therefore:** SAB is an optimization tier, not mandatory.

---

## 2) Embed mode requirements
Embed mode assumes:
- no control over host headers
- no crossOriginIsolated
- message transport only
- conservative tier selection

Provide a documented embed checklist:
- required CSP allowances
- sandbox flags (if any)
- pointer event propagation expectations
- resizing integration requirements

---

## 3) Data privacy notes
- telemetry should be sampled and avoid sensitive payloads
- avoid logging raw prices; log sizes/metrics and cohort identifiers

---

## 4) Remote config security
- remote config must be signed or served securely
- include version + hash to avoid rollback attacks
- fail closed: if config fetch fails, use local defaults

---

## 5) Clipboard/export features (future)
If you add export/screenshot features later:
- ensure no cross-origin canvas taint issues
- document security implications of image export and annotation text

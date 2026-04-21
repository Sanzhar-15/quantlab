# Resources Catalog API — Delta Plus Server Implementation Plan

## 1. Context

QuantLab's Resources panel displays a catalog of ~550 quantitative analysis tools organised into 46 categories across two sections (Statistics and Strategy). The client currently hardcodes a tiny subset (~13 tools). This plan moves the catalog to the server — making it the single source of truth, updateable without client releases, and consistent with the existing server-sourced pattern (symbols, bars, watchlists).

**Existing API patterns to follow:**
- Base URL: `http://localhost:8080`
- Auth: Bearer token via `Authorization` header
- Response wrapper: `{ "success": true, "data": <T> }` on 200
- Error wrapper: `{ "success": false, "message": "..." }` on error — the `message` field is a **flat top-level string** (see §5 for why)
- All endpoints under `/v1/` prefix

**Reference files:** The companion data files in this directory contain the complete catalog:
- `statistics_catalog.json` — 30 categories, ~330 tools
- `strategy_catalog.json` — 16 categories, ~225 tools
- `workflows.json` — 5 workflow templates

---

## 2. API Endpoints

### 2.1 `GET /v1/resources/catalog`

Returns the full resources catalog. This is the primary endpoint — the client fetches everything in one request and caches locally.

**Auth:** Required (Bearer token)

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `section` | `string` | _(omit for all)_ | `"statistics"` or `"strategy"` to fetch one section only |
| `v` | `string` | _(omit)_ | Client's cached version hash (max 64 chars). If matches server's current version, return 200 with `"data": null` |

**Success Response (200):**

```jsonc
{
  "success": true,
  "data": {
    "version": "6306a240b927",              // Content hash — see §4.2
    "generated_at": "2026-02-06T12:00:00Z", // When this version was published
    "sections": {
      "statistics": {
        "label": "Statistics",
        "description": "Triggered when data is selected in the workbench. Categories are workflow-ordered.",
        "categories": [
          {
            "id": "data-quality",
            "label": "Data Quality & Missing Data",
            "description": "The first step in any analysis. Stale prices, missing data, and unadjusted corporate actions are the most common source of spurious alpha.",
            "order": 1,
            "icon": "database",
            "context_hints": ["any"],
            "tools": [
              {
                "id": "missing-data-pattern",
                "label": "Missing Data Pattern Analysis",
                "description": "Visualises and classifies missingness patterns (monotone, arbitrary, systematic)",
                "tier": "essential",
                "implemented": false,
                "cross_ref": null
              }
              // ... more tools
            ]
          }
          // ... more categories
        ]
      },
      "strategy": {
        "label": "Strategy",
        "description": "Triggered when a Python strategy script is selected.",
        "categories": [
          // ... same shape as statistics categories
        ]
      }
    },
    "workflows": [
      {
        "id": "stationarity-suite",
        "label": "Stationarity Suite",
        "description": "ADF + KPSS + PP + Hurst with synthesised conclusion",
        "section": "statistics",
        "steps": ["augmented-dickey-fuller", "kpss", "phillips-perron", "hurst-exponent-rs"]
      }
      // ... more workflows
    ]
  }
}
```

**Version match (no new data):**

When query param `v` matches current server version, return **200** (not 304) with:

```json
{
  "success": true,
  "data": null
}
```

**IMPORTANT:** Do NOT return HTTP 304. The QuantLab client's `request()` method only handles 200-299 as success; a 304 response will be treated as an error and crash the client. Return `200` with `"data": null` instead. The client checks for `null` data and keeps its cached version.

**Error Response (401/400/404/500):**

```json
{
  "success": false,
  "message": "Unauthorized"
}
```

**IMPORTANT:** The `message` field MUST be a top-level string, NOT a nested object. The client's error handler expects `body.message` (string) or `body.error` (string). If you use `{ "error": { "message": "..." } }`, the client will lose the descriptive error text and fall back to a generic "Server error (statusCode)" message.

### 2.2 `GET /v1/resources/tools/{toolId}` *(Phase 2 — defer until tool execution is built)*

Returns full definition for a single tool, including parameter schema (for configuration UI) and execution metadata. **This endpoint is NOT needed for the initial release.** The catalog endpoint (§2.1) provides all data the client needs for rendering. Implement this endpoint later when per-tool parameter schemas and execution metadata are authored.

For the initial implementation, return the basic catalog fields only (id, label, description, tier, implemented, cross_ref) plus `category_id` and `section`. The `parameters` and `output_schema` fields should be omitted (not present in the response) until the data is authored.

**Auth:** Required

**Path Parameters:**
- `toolId` — the tool's unique ID (e.g., `"augmented-dickey-fuller"`)

**Success Response (200):**

```jsonc
{
  "success": true,
  "data": {
    "id": "augmented-dickey-fuller",
    "label": "Augmented Dickey-Fuller (ADF)",
    "description": "Tests null of unit root vs. stationarity — the workhorse for checking if differencing is needed",
    "tier": "essential",
    "category_id": "stationarity",
    "section": "statistics",
    "implemented": true,
    "cross_ref": null,

    // Only present when implemented = true:
    "required_columns": {
      "count": 1,          // exact number, or "1+" or "2+"
      "types": ["float64", "int64"]
    },
    "parameters": [
      {
        "id": "regression",
        "label": "Regression Type",
        "type": "select",
        "default": "c",
        "options": [
          { "value": "n", "label": "No constant" },
          { "value": "c", "label": "Constant only" },
          { "value": "ct", "label": "Constant + trend" },
          { "value": "ctt", "label": "Constant + linear + quadratic trend" }
        ]
      },
      {
        "id": "maxlag",
        "label": "Max Lags (auto if empty)",
        "type": "number",
        "default": null,
        "min": 0,
        "max": 50
      }
    ],
    "output_schema": {
      "statistic": "number",
      "p_value": "number|null",
      "critical_values": "Record<string, number>",
      "conclusion": "string",
      "interpretation": "string",
      "visualizations": ["line", "bar"]
    }
  }
}
```

**404 Response** — when `toolId` doesn't exist:

```json
{
  "success": false,
  "message": "Tool not found: invalid-id"
}
```

### 2.3 `GET /v1/resources/catalog/version` *(secondary — the `?v=` param on §2.1 is sufficient for cache validation)*

Lightweight endpoint returning catalog metadata. The client does **not** need this endpoint — the `?v=` parameter on the catalog endpoint already provides cache validation. This is primarily useful for operational monitoring (admin dashboards, health checks).

**Auth:** Required

**Success Response (200):**

```json
{
  "success": true,
  "data": {
    "version": "6306a240b927",
    "generated_at": "2026-02-06T12:00:00Z",
    "tool_count": 566,
    "category_count": 46
  }
}
```

---

## 3. Data Model

### 3.1 Type Definitions

```typescript
// ─── Section ────────────────────────────────────────────────────

interface ResourcesSection {
  label: string;
  description: string;
  categories: ResourceCategory[];
}

// ─── Category ───────────────────────────────────────────────────

interface ResourceCategory {
  id: string;                          // kebab-case unique within section
  label: string;                       // display name
  description: string;                 // 1-2 sentence intro from V3 doc
  order: number;                       // display order (1-based)
  icon: string;                        // semantic icon hint (see §3.3)
  context_hints: DataContextHint[];    // for client-side contextual filtering
  tools: ResourceTool[];               // ordered: essential first, then advanced
}

type DataContextHint =
  | 'any'              // always relevant
  | 'single-series'    // single time series selected
  | 'multi-series'     // 2+ series selected
  | 'panel'            // panel / cross-sectional dataset
  | 'options'          // options chain data
  | 'fixed-income'     // bond / yield data
  | 'high-frequency';  // tick / intraday data

// ─── Tool ───────────────────────────────────────────────────────

interface ResourceTool {
  id: string;                   // kebab-case, unique GLOBALLY across both sections
  label: string;                // display name
  description: string;          // one-line description from V3 doc
  tier: 'essential' | 'advanced';
  implemented: boolean;         // true if backend can execute this tool
  cross_ref: string | null;     // tool ID in the OTHER section, or null
}

// ─── Tool Detail (full definition, returned by /tools/{id}) ────

interface ResourceToolDetail extends ResourceTool {
  category_id: string;
  section: 'statistics' | 'strategy';
  required_columns?: {
    count: number | '1+' | '2+';
    types: ('float64' | 'int64')[];
  };
  parameters?: ParameterDefinition[];
  output_schema?: Record<string, string>;
}

interface ParameterDefinition {
  id: string;
  label: string;
  type: 'number' | 'select' | 'boolean' | 'array' | 'string';
  default: unknown;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  description?: string;
}

// ─── Workflow ───────────────────────────────────────────────────

interface WorkflowTemplate {
  id: string;
  label: string;
  description: string;
  section: 'statistics' | 'strategy';
  steps: string[];              // ordered tool IDs
}

// ─── Full Catalog Response ──────────────────────────────────────

interface ResourcesCatalogResponse {
  version: string;
  generated_at: string;
  sections: {
    statistics: ResourcesSection;
    strategy: ResourcesSection;
  };
  workflows: WorkflowTemplate[];
}
```

### 3.2 ID Convention

Tool IDs must be **globally unique** across both sections. Use kebab-case derived from the tool's canonical name:

```
"Missing Data Pattern Analysis"  →  "missing-data-pattern"
"Augmented Dickey-Fuller (ADF)"  →  "augmented-dickey-fuller"
"GARCH(p,q)"                     →  "garch"
"Kelly Criterion"                →  "kelly-criterion"
"Kalman Filter (Linear Gaussian)"→  "kalman-filter"           (Statistics)
"Kalman Filter Hedge Ratio"      →  "kalman-filter-hedge"     (Strategy)
```

When a tool appears in both sections (cross-reference), each gets a distinct ID and they reference each other via `cross_ref`.

### 3.3 Icon Mapping

The `icon` field is a semantic hint. The client maps it to its icon system (VS Code codicons). Recommended assignments:

**Statistics (30 categories):**

| # | Category | Icon |
|---|----------|------|
| 1 | Data Quality & Missing Data | `database` |
| 2 | Stationarity & Unit Roots | `pulse` |
| 3 | Autocorrelation & Serial Dependence | `history` |
| 4 | Normality | `graph` |
| 5 | Distribution Analysis | `graph-scatter` |
| 6 | Heteroskedasticity | `layers` |
| 7 | Nonlinearity Tests | `debug-alt` |
| 8 | Cointegration & Long-Run Relationships | `link` |
| 9 | Causality | `arrow-right` |
| 10 | VAR & Multivariate Time Series | `group-by-ref-type` |
| 11 | Structural Breaks & Change Points | `split-vertical` |
| 12 | Regime Detection & Hidden States | `eye` |
| 13 | Volatility & GARCH | `flame` |
| 14 | Correlation & Dependence | `git-merge` |
| 15 | Spectral & Long Memory | `radio-tower` |
| 16 | Time Series Decomposition | `ungroup-by-ref-type` |
| 17 | State-Space & Kalman Filter | `settings-gear` |
| 18 | Dimensionality Reduction & Factors | `fold` |
| 19 | Model Selection & Goodness of Fit | `check-all` |
| 20 | Non-Parametric Tests | `whole-word` |
| 21 | Outlier & Anomaly Detection | `bug` |
| 22 | Robust Statistics & Inference | `shield` |
| 23 | Multicollinearity | `mirror` |
| 24 | Panel Data & Cross-Sectional | `table` |
| 25 | Extreme Value Theory | `warning` |
| 26 | Market Microstructure | `zap` |
| 27 | Volatility Surface & Options | `graph-line` |
| 28 | Fixed Income & Yield Curve | `graph-left` |
| 29 | Calendar & Seasonality | `calendar` |
| 30 | Entropy & Complexity | `circuit-board` |

**Strategy (16 categories):**

| Letter | Category | Icon |
|--------|----------|------|
| A | Backtesting Engines | `play-circle` |
| B | Performance Analytics | `dashboard` |
| C | Risk Management | `shield` |
| D | Overfitting Detection | `search-fuzzy` |
| E | Optimisation | `target` |
| F | Objective Functions | `compass` |
| G | Execution & Microstructure | `rocket` |
| H | Portfolio Construction | `pie-chart` |
| I | Regime-Aware Tools | `eye` |
| J | Machine Learning Integration | `hubot` |
| K | Signal Analysis | `lightbulb` |
| L | Statistical Arbitrage & Pairs | `git-compare` |
| M | Options Strategy Tools | `layers` |
| N | Strategy Lifecycle | `history` |
| O | Multi-Strategy Portfolio | `library` |
| P | Bias Detection & Data Integrity | `inspect` |

### 3.4 Context Hints

These tell the client which categories to prioritise based on the user's current data selection:

| Data Context | Prioritised Statistics Categories |
|---|---|
| `single-series` | Stationarity, Autocorrelation, Normality, Distribution, Volatility, Decomposition |
| `multi-series` | Cointegration, Causality, VAR, Correlation, DCC |
| `panel` | Panel Data, Multicollinearity, Robust Statistics |
| `options` | Vol Surface & Options |
| `fixed-income` | Fixed Income & Yield Curve |
| `high-frequency` | Market Microstructure, Volatility (Realised) |
| `any` | Data Quality (always relevant) |

Each category can have multiple hints. Categories with `["any"]` are always visible at their default position.

---

## 4. Implementation Notes

### 4.1 Storage

The catalog is **static reference data** — it changes only when QuantLab publishes a new version. Options:

**Option A (recommended): Static JSON files loaded at server startup.**
- Store `statistics_catalog.json`, `strategy_catalog.json`, and `workflows.json` in the server's config/data directory
- Parse all three atomically on startup — if any file fails to parse, refuse to start and log the error
- Compute version hash from parsed content (see §4.2), hold pre-built response in memory
- Simple, fast, no database needed
- Hot-reload is not needed for Phase 1 — restart the server to pick up catalog changes (the client retries on connection failure)

**Option B: Database tables.**
- Useful if you want admin CRUD for the catalog
- Tables: `resource_categories`, `resource_tools`, `resource_workflows`
- More complex but supports runtime updates

### 4.2 Versioning

Use a **content hash** as the version identifier — this eliminates the most common operational failure (forgetting to bump a manual version after editing the catalog):

1. At startup, load and parse all three JSON files (statistics, strategy, workflows)
2. Compute `SHA-256(normalize(statistics) + normalize(strategy) + normalize(workflows))` where `normalize()` = parse JSON then re-serialize with sorted keys and no whitespace
3. Use the first 12 hex characters as the version string (e.g., `"6306a240b927"`)
4. Same files always produce the same hash (restart-safe). Different files always produce a different hash (automatic invalidation).

The client sends `?v=<hash>` — if it matches, return `200` with `"data": null` (see §2.1). Do NOT use HTTP 304.

If a manually-managed schema version is needed for future breaking changes to the response shape, add a separate `schemaVersion` field (e.g., `"3"`) alongside the content hash. The `?v=` parameter checks only the content hash.

### 4.3 Performance

- The full catalog response is ~133KB JSON (~31KB gzipped)
- With gzip compression (standard for HTTP): ~31KB on the wire
- Do NOT set `Cache-Control` headers — the client is a Node.js HTTP client (not a browser) and does not use HTTP-level caching. The client manages its own three-tier cache (memory → extension storage → bundled fallback). Setting `Cache-Control` would be dead code.
- Do NOT implement `ETag`/`If-None-Match` — the client does not send these headers. Use only the `?v=` query parameter for cache validation.

**Startup loading:** Load all three JSON files atomically. Parse all three, validate they all succeed, compute the content hash, then begin serving requests. If any file fails to parse, refuse to start and log the error. Never serve a partially-loaded catalog.

### 4.3.1 `?section=` Filter Behavior *(low priority — can skip for Phase 1)*

The full gzipped catalog is only ~31KB. The section filter saves just 12-18KB per request. Since the client needs both sections for tab switching, it always fetches the full catalog. This filter is primarily useful for future mobile/lightweight clients. **Consider skipping this for Phase 1** to reduce server complexity.

If implemented:
- The response `sections` object contains ONLY the requested section key
- The other section key is **omitted** (not set to null, not set to empty)
- **Workflows are always returned in full** regardless of the `?section=` parameter. Some workflows reference tools from both sections (e.g., `pairs-trading-pipeline` includes `engle-granger-two-step` from statistics). Filtering workflows by section would create dangling tool references that the client cannot resolve.
- Example: `?section=statistics` returns `{ "success": true, "data": { "version": "...", "sections": { "statistics": { ... } }, "workflows": [...all workflows...] } }`

### 4.3.3 Input Validation

| Parameter | Validation | Error |
|---|---|---|
| `?section=` | Must be `"statistics"` or `"strategy"` if present | 400 |
| `?v=` | Max 64 characters | 400 |
| `{toolId}` (Phase 2) | Character class `[a-z0-9-]`, max 100 chars | 400 or 404 |

All endpoints are GET-only — reject any request body (the HTTP framework typically handles this).

### 4.3.2 How to Use the Companion JSON Files

Each JSON file in this directory (`statistics_catalog.json`, `strategy_catalog.json`) is an array of `ResourceCategory` objects. To build the API response:
1. Load both JSON files at server startup
2. Wrap them into the response shape from §2.1: `sections.statistics.categories = <statistics_catalog.json contents>`, `sections.strategy.categories = <strategy_catalog.json contents>`
3. Set `sections.statistics.label = "Statistics"`, `sections.statistics.description = "Triggered when data is selected in the workbench. Categories are workflow-ordered."`
4. Set `sections.strategy.label = "Strategy"`, `sections.strategy.description = "Triggered when a Python strategy script is selected."`
5. Load `workflows.json` as the `workflows` array
6. Compute `version` via content hash (see §4.2) and set `generated_at` to server startup time

### 4.4 Tool Implementation Status

Initially, only ~13 tools are marked `"implemented": true` (the ones that have Python backend support in the client). These are listed here for reference — the server should mark these as implemented:

**Currently implemented tools (client has execution support):**

| Tool ID (server) | Current Client ID | Category |
|---|---|---|
| `summary-statistics` | `summary` | descriptive (maps to Distribution Analysis) |
| `returns-analysis` | `returns` | descriptive |
| `rolling-statistics` | `rolling` | descriptive |
| `augmented-dickey-fuller` | `adf` | Stationarity |
| `kpss` | `kpss` | Stationarity |
| `phillips-perron` | `pp` | Stationarity |
| `jarque-bera` | `normality` | Normality (all 3 map to same backend) |
| `shapiro-wilk` | `normality` | Normality |
| `anderson-darling` | `normality` | Normality |
| `pearson-correlation` | `correlation` | Correlation & Dependence |
| `acf-pacf` | `acf-pacf` | Autocorrelation |
| `ljung-box` | `ljung-box` | Autocorrelation |
| `value-at-risk` | `var` | Extreme Value Theory / Risk |
| `expected-shortfall` | `es` | Extreme Value Theory / Risk |
| `sharpe-ratio` | `sharpe` | (Strategy) Performance Analytics |

**Note:** The strategy catalog uses `sharpe-ratio` as the tool ID (matching the V3 doc's "Sharpe Ratio" entry). The client's ID mapping translates this to `sharpe` for execution. The client maintains an ID mapping table. As more tools get implemented on the Python side, update `"implemented": true` in the catalog and bump the version.

### 4.5 Cross-References

Some tools serve both statistical diagnostic and strategy integration purposes. They get separate IDs and reference each other:

```json
// In Statistics → State-Space & Kalman Filter
{ "id": "kalman-filter", "cross_ref": "kalman-filter-hedge", ... }

// In Strategy → Statistical Arbitrage & Pairs
{ "id": "kalman-filter-hedge", "cross_ref": "kalman-filter", ... }
```

Other cross-references:
- `hurst-exponent-rs` (Stats: Spectral) ↔ `hurst-on-spread` (Strategy: Stat Arb)
- `hidden-markov-model` (Stats: Regime Detection) ↔ `hmm-regime-detection` (Strategy: Regime-Aware)

**Note:** `purged-k-fold-cv` and `purged-k-fold-cv-ml` are both in the Strategy section (Overfitting Detection and ML Integration respectively). They are intra-section conceptual variants, not cross-section references.

### 4.6 Tool Ordering Within Categories

Within each category, tools are ordered:
1. Essential tier first (in the order from the V3 doc)
2. Advanced tier second (in the order from the V3 doc)

The client relies on this ordering to render the tier divider correctly.

---

## 5. Error Handling

| Scenario | Status | Response |
|---|---|---|
| No auth token | 401 | `{ "success": false, "message": "Unauthorized" }` |
| Invalid section param | 400 | `{ "success": false, "message": "Invalid section: must be 'statistics' or 'strategy'" }` |
| Tool not found | 404 | `{ "success": false, "message": "Tool not found: <id>" }` |
| Server error | 500 | `{ "success": false, "message": "Internal server error" }` |
| Version match (no new data) | 200 | `{ "success": true, "data": null }` |

**CRITICAL:** Error responses use a flat `"message"` string, NOT a nested `"error"` object. The client's `ServerApiClient.request()` handles non-2xx errors by checking `body.message` (string) first, then `body.error` (string). If you use `{ "error": { "message": "..." } }` (nested object), the client will ignore it and fall back to a generic "Server error (statusCode)" message — the descriptive error text will be lost.

**Note on existing endpoints:** If other server endpoints already use the nested `{ "error": { "message": "..." } }` format, it is acceptable to use that format here for cross-endpoint consistency — the client will still function (with generic error messages). However, the flat `"message"` format is preferred because it preserves the descriptive error text.

---

## 6. Summary

| Endpoint | Method | Purpose | Response Size | Priority |
|---|---|---|---|---|
| `/v1/resources/catalog` | GET | Full catalog (primary) | ~133KB (~31KB gzipped) | **Phase 1** |
| `/v1/resources/catalog?v=<hash>` | GET | Cache-validated fetch | ~50B if match, ~31KB if miss | **Phase 1** |
| `/v1/resources/catalog?section=...` | GET | Section filter | ~81KB or ~52KB | Phase 2 |
| `/v1/resources/catalog/version` | GET | Monitoring/health check | ~100B | Phase 2 |
| `/v1/resources/tools/{toolId}` | GET | Single tool detail | ~500B-2KB | Phase 2 |

The companion JSON files in this directory contain the complete data to populate these endpoints.

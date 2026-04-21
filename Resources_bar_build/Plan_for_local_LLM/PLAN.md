# Resources Panel — QuantLab Client Implementation Plan

## 1. Context & Current State

The Resources activity bar panel currently has:
- A **webview** (`ResourcesWebviewProvider`) with two section buttons ("Strategy" / "Pure Stats")
- **Strategy section**: 3 static placeholder items (Tests, Templates, Guides) — click shows info message
- **Stats section**: 5 hardcoded categories with 13 tools from `statsCatalog.ts`
- A **native tree view** (`ResourcesTreeProvider` + `ResourcesPanelProvider`) reading from `resourcesCatalog.json` — appears to be dead/redundant code alongside the webview
- Tool clicks dispatch to `quantlab.openStatsTest` → `StatsEngine` (13 implemented tests)

**Target state**: The catalog comes from the Delta Plus Server (`GET /v1/resources/catalog`), matching the existing pattern for symbols, bars, and watchlists. The UI renders ~550 tools across 46 categories with search, tier toggles, implementation status indicators, and collapse persistence.

---

## 2. Shared API Contract

The server exposes these endpoints (see `Plan_for_the_server_end_LLM/PLAN.md` for full spec):

```
GET /v1/resources/catalog              → full catalog (~133KB, ~31KB gzipped) [Phase 1]
GET /v1/resources/catalog?v=<hash>     → cache-validated fetch (null data if match) [Phase 1]
GET /v1/resources/catalog?section=...  → filtered by section [Phase 2]
GET /v1/resources/catalog/version      → monitoring/health check [Phase 2]
GET /v1/resources/tools/{toolId}       → full tool detail with parameter schema [Phase 2]
```

**Response shape** the client expects:

```typescript
interface ResourcesCatalogResponse {
  version: string;
  generated_at: string;
  sections: {
    statistics: ResourcesSection;
    strategy: ResourcesSection;
  };
  workflows: WorkflowTemplate[];
}

interface ResourcesSection {
  label: string;
  description: string;
  categories: ResourceCategory[];
}

interface ResourceCategory {
  id: string;
  label: string;
  description: string;
  order: number;
  icon: string;                        // semantic hint, mapped to codicon locally
  context_hints: DataContextHint[];
  tools: ResourceTool[];
}

interface ResourceTool {
  id: string;
  label: string;
  description: string;
  tier: 'essential' | 'advanced';
  implemented: boolean;
  cross_ref: string | null;
}

interface WorkflowTemplate {
  id: string;
  label: string;
  description: string;
  section: 'statistics' | 'strategy';
  steps: string[];                     // ordered tool IDs
}

type DataContextHint =
  | 'any' | 'single-series' | 'multi-series' | 'panel'
  | 'options' | 'fixed-income' | 'high-frequency';
```

**Tool detail** (Phase 2 — deferred until per-tool parameter schemas are authored on the server):

```typescript
interface ResourceToolDetail extends ResourceTool {
  category_id: string;
  section: 'statistics' | 'strategy';
  required_columns?: {
    count: number | '1+' | '2+';
    types: ('float64' | 'int64')[];
  };
  parameters?: ParameterDefinition[];
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
```

### 2.1 Section Type Mapping: `'stats'` ↔ `'statistics'`

**CRITICAL:** The existing codebase uses `'stats'` as the section literal everywhere:
- `ResourcesWebviewProvider.ts` line 9: `type ResourcesSection = 'strategy' | 'stats'`
- `webview/resources/index.ts` line 7: `type Section = 'strategy' | 'stats'`
- `dataCommands.ts` lines 147, 155: commands pass `'strategy' | 'stats'`

The server API uses `'statistics'`. Do NOT change the existing `'stats'` convention in the codebase. Instead, add conversion helpers:

```typescript
// In src/types/resources.ts
export type ClientSection = 'strategy' | 'stats';
export type ServerSection = 'strategy' | 'statistics';

export function toClientSection(s: ServerSection): ClientSection {
  return s === 'statistics' ? 'stats' : s;
}

export function toServerSection(s: ClientSection): ServerSection {
  return s === 'stats' ? 'statistics' : s;
}
```

Use `toClientSection()` when receiving data from the server. Use `toServerSection()` when sending requests to the server. The webview and all existing code continue using `'stats'`.

### 2.2 Version Match Handling

The server returns `200` with `"data": null` when the client's cached version matches (NOT HTTP 304). In `ResourcesCatalogService.fetchFromServer()`, check for null:

```typescript
const response = await client.getResourcesCatalog();
if (response === null) {
  // Server confirmed our cached version is current — keep memory cache
  return this.catalog!;
}
// Otherwise, parse and cache the new catalog
```

---

## 3. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    Resources Webview                          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ [Statistics] [Strategy]   🔍 Search...  [☑ Impl.]    │ │
│  ├─────────────────────────────────────────────────────────┤ │
│  │ ▸ Workflows (3)                                       │ │
│  │ ──────────────────────────────────────────────────     │ │
│  │ ▸ 1. Data Quality & Missing Data               (13)  │ │
│  │ ▾ 2. Stationarity & Unit Roots                 (12)  │ │
│  │   Stationarity tests for unit root detection...       │ │
│  │   ● ADF                                               │ │
│  │   ● KPSS                                              │ │
│  │   ● Phillips-Perron                                   │ │
│  │   ○ Variance Ratio (Lo-MacKinlay)      [planned]      │ │
│  │   ○ Chow-Denning Joint VR              [planned]      │ │
│  │   ● Hurst Exponent                                    │ │
│  │   ┄┄┄ Show 6 Advanced ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄        │ │
│  │ ▸ 3. Autocorrelation & Serial Dep.             (11)  │ │
│  │ ...                                                    │ │
│  └─────────────────────────────────────────────────────────┘ │
│         │  postMessage   ▲  postMessage                      │
└─────────┼────────────────┼───────────────────────────────────┘
          ▼                │
┌──────────────────────────────────────────────────────────────┐
│             ResourcesWebviewProvider                          │
│  ┌──────────────────────┐  ┌──────────────────────────────┐  │
│  │ ResourcesCatalogSvc  │  │ Message Handlers             │  │
│  │                      │  │  ready → send catalog        │  │
│  │  fetchCatalog()      │  │  sectionChange → update ctx  │  │
│  │  getCatalog()        │  │  toolClick → dispatch        │  │
│  │  search(query)       │  │  workflowClick → dispatch    │  │
│  │  getForContext()     │  │                              │  │
│  └──────────┬───────────┘  └──────────────────────────────┘  │
│             │                                                 │
│  ┌──────────▼───────────┐  ┌──────────────────────────────┐  │
│  │ ServerApiClient      │  │ Offline Fallback             │  │
│  │  getResourcesCatalog │  │  bundled minimal catalog     │  │
│  │  getResourcesTool    │  │  from extension storage      │  │
│  └──────────────────────┘  └──────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────┐
│   Delta Plus Server      │
│   GET /v1/resources/*    │
└──────────────────────────┘
```

---

## 4. Files to Create

### 4.1 `src/types/resources.ts` — New type definitions

All types from §2 above, plus the client-side additions:

```typescript
// Server response types (matching API contract)
export interface ResourcesCatalogResponse { ... }
export interface ResourcesSection { ... }
export interface ResourceCategory { ... }
export interface ResourceTool { ... }
export interface ResourceToolDetail { ... }
export interface WorkflowTemplate { ... }
export interface ParameterDefinition { ... }
export type DataContextHint = ...;

// Client-only types
export interface CatalogState {
  version: string;
  statistics: ResourceCategory[];
  strategy: ResourceCategory[];
  workflows: WorkflowTemplate[];
  fetchedAt: number;
}

// ID mapping for backwards compatibility with existing StatsCatalog.ts
export const TOOL_ID_MAP: Record<string, string> = {
  // server ID → legacy client ID (for StatsEngine lookup)
  'summary-statistics': 'summary',
  'returns-analysis': 'returns',
  'rolling-statistics': 'rolling',
  'augmented-dickey-fuller': 'adf',
  'kpss': 'kpss',
  'phillips-perron': 'pp',
  'jarque-bera': 'normality',       // all 3 normality tools map to the same backend test
  'shapiro-wilk': 'normality',      // the backend runs all 3 as a single "normality" suite
  'anderson-darling': 'normality',   // clicking any one triggers the full normality test
  'pearson-correlation': 'correlation',
  'acf-pacf': 'acf-pacf',
  'ljung-box': 'ljung-box',
  'value-at-risk': 'var',
  'expected-shortfall': 'es',
  'sharpe-ratio': 'sharpe',
};
```

### 4.2 `src/panels/resources/ResourcesCatalogService.ts` — New catalog service

Singleton service managing catalog fetch, cache, search, and contextual filtering.

```typescript
export class ResourcesCatalogService {
  private static instance: ResourcesCatalogService;
  private catalog: CatalogState | null = null;
  private fetchPromise: Promise<CatalogState> | null = null;
  private readonly globalState: vscode.Memento;  // for persistent storage

  // Cache config
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes in memory
  private static readonly STORAGE_KEY = 'quantlab.resourcesCatalog';

  private constructor(context: vscode.ExtensionContext) {
    this.globalState = context.globalState;
  }

  static initialize(context: vscode.ExtensionContext): ResourcesCatalogService {
    if (!ResourcesCatalogService.instance) {
      ResourcesCatalogService.instance = new ResourcesCatalogService(context);
    }
    return ResourcesCatalogService.instance;
  }

  static getInstance(): ResourcesCatalogService {
    if (!ResourcesCatalogService.instance) {
      throw new Error('ResourcesCatalogService not initialized — call initialize(context) first');
    }
    return ResourcesCatalogService.instance;
  }

  // ── Fetch ─────────────────────────────────────────────────

  async getCatalog(forceRefresh?: boolean): Promise<CatalogState> {
    // 1. Check memory cache (with TTL)
    // 2. Check extension storage (persisted across sessions)
    // 3. Fetch from server
    // 4. On server failure, use storage cache regardless of age
    // 5. On total failure, use bundled fallback
  }

  private async fetchFromServer(): Promise<CatalogState> {
    const client = ServerApiClient.getInstance();
    const response = await client.getResourcesCatalog();
    // Transform response → CatalogState
    // Persist to extension storage
    // Return
  }

  // ── Search ────────────────────────────────────────────────

  search(query: string, section: ClientSection): SearchResult[] {
    // Substring match (case-insensitive) against tool labels AND descriptions
    // All search is client-side — the full catalog is in memory
    // Return flat list of { tool, categoryId, categoryLabel }
    // Order: exact label match first, then label substring, then description-only matches
  }

  // ── Contextual Filtering ──────────────────────────────────

  getCategoriesForContext(
    section: 'statistics' | 'strategy',
    context: DataContextHint
  ): ResourceCategory[] {
    // 1. Get all categories for section
    // 2. Sort: categories matching context_hints first, then by order
    // 3. Return reordered list
  }

  // ── Lookup ────────────────────────────────────────────────

  getToolById(toolId: string): ResourceTool | undefined { ... }
  getCategoryById(categoryId: string): ResourceCategory | undefined { ... }
  getWorkflowsForSection(section: string): WorkflowTemplate[] { ... }
}
```

**Key design decisions:**

1. **Three-tier cache**: memory (5min TTL) → extension storage (persisted) → bundled fallback
2. **Single in-flight fetch**: if `getCatalog()` is called while a fetch is in progress, return the same promise (no duplicate requests)
3. **Search is client-side**: the full catalog is in memory, no server round-trip for search
4. **Contextual filtering is a sort, not a filter**: all categories remain visible, just reordered by relevance

### 4.3 `src/panels/resources/fallbackCatalog.ts` — Bundled offline fallback

A minimal hardcoded catalog with the 13 implemented tools. Only used when both server and storage cache are unavailable (cold start with no network):

```typescript
export const FALLBACK_CATALOG: CatalogState = {
  version: '0.0.0-fallback',
  statistics: [
    { id: 'stationarity', label: 'Stationarity & Unit Roots', order: 2, icon: 'pulse', ...,
      tools: [
        { id: 'augmented-dickey-fuller', label: 'ADF Test', tier: 'essential', implemented: true, ... },
        { id: 'kpss', label: 'KPSS Test', tier: 'essential', implemented: true, ... },
        { id: 'phillips-perron', label: 'Phillips-Perron', tier: 'essential', implemented: true, ... },
      ]
    },
    // ... other categories with implemented tools only
  ],
  strategy: [],
  workflows: [],
  fetchedAt: 0,
};
```

---

## 5. Files to Modify

### 5.1 `src/core/server/ServerApiClient.ts`

Add two methods following existing patterns (like `getSymbols`, `getWatchlists`):

```typescript
// ── Resources Catalog ───────────────────────────────────────

async getResourcesCatalog(section?: string): Promise<ResourcesCatalogResponse> {
  await this.ensureAuthenticated();
  const query = section ? `?section=${section}` : '';
  return this.request<ResourcesCatalogResponse>('GET', `/v1/resources/catalog${query}`);
}

async getResourcesCatalogVersion(): Promise<{ version: string; tool_count: number }> {
  await this.ensureAuthenticated();
  return this.request<{ version: string; tool_count: number }>('GET', '/v1/resources/catalog/version');
}

async getResourceToolDetail(toolId: string): Promise<ResourceToolDetail> {
  await this.ensureAuthenticated();
  return this.request<ResourceToolDetail>('GET', `/v1/resources/tools/${encodeURIComponent(toolId)}`);
}
```

### 5.2 `src/panels/resources/ResourcesWebviewProvider.ts`

Major changes:

**1. Change the `initialize()` signature** to accept both extensionUri and catalogService:

```typescript
// Current signature: initialize(extensionUri: vscode.Uri)
// New signature:
static initialize(extensionUri: vscode.Uri, catalogService: ResourcesCatalogService): ResourcesWebviewProvider;

private catalogService: ResourcesCatalogService;

// In constructor:
private constructor(extensionUri: vscode.Uri, catalogService: ResourcesCatalogService) {
  this.extensionUri = extensionUri;
  this.catalogService = catalogService;
}
```

**2. Expanded message protocol:**

```typescript
// Messages FROM webview → provider:
interface ResourcesMessage {
  type: 'ready'
    | 'sectionChange'
    | 'toolClick'
    | 'workflowClick'
    | 'crossRefClick'         // navigate to cross-referenced tool
    | 'search'
    | 'toggleImplementedFilter' // toggle "show implemented only"
    | 'requestCatalog';
  section?: 'statistics' | 'strategy';
  toolId?: string;
  workflowId?: string;
  targetToolId?: string;      // for crossRefClick
  query?: string;
  showImplementedOnly?: boolean;
}

// Messages FROM provider → webview:
type ProviderMessage =
  | { type: 'setCatalog'; catalog: CatalogPayload; section: string }
  | { type: 'searchResults'; results: SearchResult[] }
  | { type: 'navigateTo'; section: string; categoryId: string; toolId: string }
  | { type: 'updateCategoryHighlight'; contextHint: string; matchingCategoryIds: string[] }
  | { type: 'catalogError'; errorType: 'stale-cache' | 'fallback'; message: string; lastUpdated?: number };
```

**3. Handle messages:**

```typescript
private async handleMessage(message: ResourcesMessage): Promise<void> {
  switch (message.type) {
    case 'ready':
    case 'requestCatalog':
      // Fetch catalog and send to webview
      const catalog = await this.catalogService.getCatalog();
      this.postMessage({
        type: 'setCatalog',
        catalog: {
          statistics: catalog.statistics,
          strategy: catalog.strategy,
          workflows: catalog.workflows,
          version: catalog.version,
        },
        section: this.currentSection,
      });
      break;

    case 'sectionChange':
      this.currentSection = message.section!;
      void vscode.commands.executeCommand('setContext', 'quantlab.resourcesSection', this.currentSection);
      break;

    case 'toolClick':
      await this.handleToolClick(message.toolId!);
      break;

    case 'workflowClick':
      await this.handleWorkflowClick(message.workflowId!);
      break;

    case 'search':
      const results = this.catalogService.search(message.query!, this.currentSection);
      this.postMessage({ type: 'searchResults', results });
      break;
  }
}
```

**4. Tool click routing:**

```typescript
private async handleToolClick(serverToolId: string): Promise<void> {
  const tool = this.catalogService.getToolById(serverToolId);
  if (!tool) return;

  if (!tool.implemented) {
    // Do NOT use vscode.window.showInformationMessage() — it creates a modal
    // notification banner that is disproportionately disruptive for a routine
    // interaction (97% of tools are unimplemented). Instead, the webview handles
    // this entirely client-side with an inline tooltip (see §5.3 D).
    return;
  }

  // Map server tool ID to legacy client ID for StatsEngine compatibility
  const legacyId = TOOL_ID_MAP[serverToolId] ?? serverToolId;

  // All implemented tools (stats and strategy) currently route through StatsEngine
  void vscode.commands.executeCommand('quantlab.openStatsTest', legacyId);
}
```

**5. Cross-reference click handling:**

```typescript
case 'crossRefClick':
  // Navigate to the cross-referenced tool in the other section
  const targetTool = this.catalogService.getToolById(message.targetToolId!);
  if (!targetTool) return;
  const targetCat = this.catalogService.getCategoryForTool(message.targetToolId!);
  const targetSection = targetCat ? this.catalogService.getSectionForCategory(targetCat.id) : null;
  if (targetSection) {
    this.currentSection = toClientSection(targetSection);
    this.postMessage({
      type: 'navigateTo',
      section: this.currentSection,
      categoryId: targetCat!.id,
      toolId: message.targetToolId!,
    });
  }
  break;
```

**6. Catalog error signaling:**

When `getCatalog()` falls back to stale cache or bundled fallback, signal the webview:

```typescript
case 'ready':
case 'requestCatalog':
  try {
    const catalog = await this.catalogService.getCatalog();
    // ... send catalog as before ...

    // Signal fallback state if applicable
    if (catalog.version === '0.0.0-fallback') {
      this.postMessage({
        type: 'catalogError',
        errorType: 'fallback',
        message: 'Could not load full catalog. Showing implemented tools only.',
      });
    } else if (catalog.fetchedAt > 0 && Date.now() - catalog.fetchedAt > 24 * 60 * 60 * 1000) {
      this.postMessage({
        type: 'catalogError',
        errorType: 'stale-cache',
        message: 'Using cached catalog. Server unavailable.',
        lastUpdated: catalog.fetchedAt,
      });
    }
  } catch { /* ... */ }
  break;
```

/**
 * Handle workflow click — run all steps sequentially.
 * Phase 1: show info about the workflow. Phase 2: sequential execution.
 */
private async handleWorkflowClick(workflowId: string): Promise<void> {
  const catalog = await this.catalogService.getCatalog();
  const workflow = catalog.workflows.find(w => w.id === workflowId);
  if (!workflow) return;

  // Check how many steps are implemented
  const implementedSteps = workflow.steps.filter(stepId => {
    const tool = this.catalogService.getToolById(stepId);
    return tool?.implemented;
  });

  if (implementedSteps.length === 0) {
    void vscode.window.showInformationMessage(
      `Workflow "${workflow.label}" — all ${workflow.steps.length} steps are planned for future release.`
    );
    return;
  }

  // For now, show the workflow info. Phase 2 will run steps sequentially.
  const choice = await vscode.window.showInformationMessage(
    `Run "${workflow.label}"? (${implementedSteps.length}/${workflow.steps.length} steps available)`,
    'Run Available Steps', 'Cancel'
  );

  if (choice === 'Run Available Steps') {
    for (const stepId of implementedSteps) {
      await this.handleToolClick(stepId);
    }
  }
}
```

### 5.3 `webview/resources/index.ts` — Complete rewrite of rendering

The webview receives the catalog via `setCatalog` message (not imported from a TypeScript file). Major new features:

**CRITICAL — HTML Escaping:** All server-sourced strings (`cat.label`, `tool.label`, `tool.description`, `cross_ref`, etc.) MUST be escaped before inserting into HTML templates. The project already has shared utilities at `window.qicUtils` — use `window.qicUtils.escapeHtml()` for text content and `window.qicUtils.escapeAttr()` for HTML attributes. If qicUtils is not loaded in this webview context, add local helpers:

```typescript
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
```

**Type Definitions for Webview:** The webview cannot import from `src/types/resources.ts` (separate tsconfig). Duplicate the minimal interfaces needed (`ResourceCategory`, `ResourceTool`, `WorkflowTemplate`) at the top of this file, or create a `webview/resources/types.ts` file that is bundled by esbuild alongside `index.ts`.

**Loading State:** Render a loading spinner on initial paint (before `setCatalog` arrives):

```typescript
function renderLoading(): string {
  return '<div class="catalog-loading">Loading resources...</div>';
}
// Render this immediately, replace when setCatalog message arrives
```

**A. State management (per-section):**

Search, expand, and advanced states are stored **per section** so switching tabs preserves each section's state independently:

```typescript
let currentSection: Section = 'strategy';
let catalog: { statistics: Category[]; strategy: Category[]; workflows: Workflow[] } | null = null;
let showImplementedOnly: boolean = false;  // global toggle — applies to both sections

// Per-section state
interface SectionState {
  searchQuery: string;
  expandedCategories: Set<string>;
  showAdvanced: Set<string>;
}

let sectionStates: Record<Section, SectionState> = {
  strategy: { searchQuery: '', expandedCategories: new Set(), showAdvanced: new Set() },
  stats:    { searchQuery: '', expandedCategories: new Set(), showAdvanced: new Set() },
};

// Helper to get current section's state
function currentState(): SectionState {
  return sectionStates[currentSection];
}
```

**B. Search & filter controls:**
```html
<div class="toolbar">
  <div class="search-container">
    <span class="codicon codicon-search"></span>
    <input type="text" class="search-input" placeholder="Search tools..." />
    <span class="codicon codicon-close search-clear" style="display:none"></span>
  </div>
  <button class="filter-toggle ${showImplementedOnly ? 'active' : ''}"
          title="Show implemented tools only">
    <span class="codicon codicon-filter"></span>
  </button>
</div>
```

**Search behavior:**
- Debounced keystroke handler (200ms), per-section query stored in `currentState().searchQuery`
- Substring match (case-insensitive) against tool labels, tool descriptions, **and category labels**
  - A search for "GARCH" should match the "Volatility & GARCH" category as a whole, showing all its tools
- When search is active, force-expand matching categories and force-show advanced tools
- Clear button (X icon) resets search and restores the persisted expand/collapse state
- When switching sections, the search input populates with that section's stored query

**"Implemented only" filter (critical UX feature):**
- Toggle button next to search bar — when active, hides all tools where `implemented === false`
- Categories with 0 visible tools after filtering are hidden entirely
- **Default state:** OFF (show all tools). Consider defaulting to ON for first-time users since 97% of tools are unimplemented.
- Persisted in `vscode.setState()`

**Empty search state:**
When search produces 0 results, render:
```typescript
function renderEmptySearch(query: string): string {
  return `
    <div class="empty-search">
      <span class="codicon codicon-search"></span>
      <p>No tools matching "${escapeHtml(query)}"</p>
      <p class="empty-search-hint">Try a different search term, or clear the search to browse categories.</p>
    </div>
  `;
}
```

**C. Category rendering:**
```typescript
function renderCategory(cat: ResourceCategory, searchFilter?: string): string {
  let tools = cat.tools;
  const state = currentState();

  // Apply "implemented only" filter
  if (showImplementedOnly) {
    tools = tools.filter(t => t.implemented);
  }

  // Apply search filter — matches tool labels, descriptions, AND category label
  const catLabelMatch = searchFilter
    ? cat.label.toLowerCase().includes(searchFilter.toLowerCase())
    : false;

  if (searchFilter && !catLabelMatch) {
    const q = searchFilter.toLowerCase();
    tools = tools.filter(t =>
      t.label.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    );
  }

  if (tools.length === 0) return '';  // hide empty categories

  const essentialTools = tools.filter(t => t.tier === 'essential');
  const advancedTools = tools.filter(t => t.tier === 'advanced');
  const isExpanded = state.expandedCategories.has(cat.id) || !!searchFilter;
  const showAdv = state.showAdvanced.has(cat.id) || !!searchFilter;

  return `
    <div class="stats-category" data-category="${escapeAttr(cat.id)}" tabindex="0" role="group">
      <div class="category-header" role="treeitem" aria-expanded="${isExpanded}">
        <span class="codicon codicon-chevron-${isExpanded ? 'down' : 'right'} expand-icon"></span>
        <span class="codicon codicon-${escapeAttr(resolveIcon(cat.icon))}"></span>
        <span class="category-label">${escapeHtml(cat.label)}</span>
        <span class="category-count">${tools.length}</span>
      </div>
      <div class="category-tools" style="display: ${isExpanded ? 'block' : 'none'}">
        ${isExpanded ? `<div class="category-description">${escapeHtml(cat.description)}</div>` : ''}
        ${essentialTools.map(t => renderTool(t, !!searchFilter)).join('')}
        ${advancedTools.length > 0 ? renderTierDivider(cat.id, showAdv, advancedTools.length) : ''}
        ${showAdv ? advancedTools.map(t => renderTool(t, !!searchFilter)).join('') : ''}
      </div>
    </div>
  `;
}
```

**Count display:** Show **total tool count only** — e.g., `(13)`. The essential/advanced split is communicated by the tier divider, not the header. During search, show filtered match count instead.

**D. Tool rendering:**
```typescript
function renderTool(tool: ResourceTool, showDescription: boolean = false): string {
  const implClass = tool.implemented ? 'tool-implemented' : 'tool-unimplemented';
  const indicator = tool.implemented ? '●' : '○';
  const crossRefAttr = tool.cross_ref ? `data-crossref="${escapeAttr(tool.cross_ref)}"` : '';

  // Tooltip includes [Planned] prefix for unimplemented tools
  const tooltip = tool.implemented
    ? escapeAttr(tool.description)
    : escapeAttr(`[Planned] ${tool.description}`);

  return `
    <div class="tool-item ${implClass}" data-tool="${escapeAttr(tool.id)}" ${crossRefAttr}
         title="${tooltip}" tabindex="-1" role="treeitem">
      <span class="tool-indicator">${indicator}</span>
      <span class="tool-label">${escapeHtml(tool.label)}</span>
      ${tool.cross_ref ? `<span class="codicon codicon-link-external cross-ref-icon" data-crossref-btn="${escapeAttr(tool.cross_ref)}" title="Go to cross-reference"></span>` : ''}
    </div>
    ${showDescription ? `<div class="tool-description">${escapeHtml(tool.description)}</div>` : ''}
  `;
}
```

**Unimplemented tool click behavior:** Handled entirely in the webview — do NOT call `vscode.window.showInformationMessage()` from the provider. Instead, show a brief inline toast within the webview (e.g., a small banner that auto-dismisses after 2 seconds) or simply rely on the `cursor: not-allowed` and `[Planned]` tooltip to communicate status. The modal VS Code notification is disproportionately disruptive for an interaction that will occur 97% of the time.

**Cross-reference icon click:** The `cross-ref-icon` span has a `data-crossref-btn` attribute. Add a click handler that sends `{ type: 'crossRefClick', targetToolId }` to the provider. The provider responds with `{ type: 'navigateTo', section, categoryId, toolId }` — the webview switches tabs, expands the target category, scrolls to the tool, and briefly highlights it (1-second background flash using `var(--vscode-editor-findMatchHighlightBackground)`).

**Search result mode:** When `showDescription` is true (during search), a one-line truncated description appears below the tool label in a smaller font. This helps differentiate similar tools (e.g., "Sharpe Ratio" vs "Sortino Ratio" vs "Calmar Ratio").

**E. Tier divider (with count):**
```typescript
function renderTierDivider(categoryId: string, isShown: boolean, advancedCount: number): string {
  return `
    <div class="tier-divider" data-category="${escapeAttr(categoryId)}">
      <span class="tier-line"></span>
      <button class="tier-toggle">${isShown ? 'Hide' : `Show ${advancedCount}`} Advanced</button>
      <span class="tier-line"></span>
    </div>
  `;
}
```

**F. Workflow rendering (collapsible):**

The workflows section is **collapsible** (defaulting to collapsed) to preserve vertical space for the categories, which are the primary navigation mechanism:

```typescript
let workflowsExpanded: boolean = false;  // persisted in vscode.setState()

function renderWorkflows(workflows: WorkflowTemplate[]): string {
  if (workflows.length === 0) return '';
  return `
    <div class="workflows-section">
      <div class="workflows-header" role="treeitem" aria-expanded="${workflowsExpanded}">
        <span class="codicon codicon-chevron-${workflowsExpanded ? 'down' : 'right'}"></span>
        <span>Workflows</span>
        <span class="workflows-count">(${workflows.length})</span>
      </div>
      <div class="workflows-list" style="display: ${workflowsExpanded ? 'block' : 'none'}">
        ${workflows.map(w => `
          <div class="workflow-item" data-workflow="${escapeAttr(w.id)}" title="${escapeAttr(w.description)}">
            <span class="codicon codicon-run-all"></span>
            <span class="workflow-label">${escapeHtml(w.label)}</span>
            <span class="workflow-step-count">${w.steps.length} steps</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}
```

**G. Collapse persistence (per-section):**
```typescript
// On category expand/collapse:
function toggleCategory(categoryId: string): void {
  const state = currentState();
  if (state.expandedCategories.has(categoryId)) {
    state.expandedCategories.delete(categoryId);
  } else {
    state.expandedCategories.add(categoryId);
  }
  persistState();
}

function persistState(): void {
  vscode.setState({
    section: currentSection,
    showImplementedOnly,
    workflowsExpanded,
    sectionStates: {
      strategy: {
        searchQuery: sectionStates.strategy.searchQuery,
        expandedCategories: [...sectionStates.strategy.expandedCategories],
        showAdvanced: [...sectionStates.strategy.showAdvanced],
      },
      stats: {
        searchQuery: sectionStates.stats.searchQuery,
        expandedCategories: [...sectionStates.stats.expandedCategories],
        showAdvanced: [...sectionStates.stats.showAdvanced],
      },
    },
  });
}

// On init, restore state:
const savedState = vscode.getState() as SavedState | undefined;
if (savedState) {
  currentSection = savedState.section ?? 'strategy';
  showImplementedOnly = savedState.showImplementedOnly ?? false;
  workflowsExpanded = savedState.workflowsExpanded ?? false;
  if (savedState.sectionStates) {
    for (const sec of ['strategy', 'stats'] as const) {
      const ss = savedState.sectionStates[sec];
      if (ss) {
        sectionStates[sec] = {
          searchQuery: ss.searchQuery ?? '',
          expandedCategories: new Set(ss.expandedCategories ?? []),
          showAdvanced: new Set(ss.showAdvanced ?? []),
        };
      }
    }
  }
}
```

**H. Keyboard navigation:**

Add a roving tabindex pattern for keyboard accessibility. VS Code is a keyboard-first application — the Resources panel must be fully navigable:

```typescript
// Keyboard handler on the categories container
container.addEventListener('keydown', (e: KeyboardEvent) => {
  const target = e.target as HTMLElement;

  switch (e.key) {
    case 'Enter':
    case ' ':
      e.preventDefault();
      // If category header → toggle expand/collapse
      if (target.closest('.category-header')) {
        toggleCategory(target.closest('[data-category]')!.getAttribute('data-category')!);
      }
      // If tool item → trigger click
      else if (target.closest('.tool-item')) {
        target.click();
      }
      break;

    case 'ArrowDown':
      e.preventDefault();
      focusNextItem(target, 'down');
      break;

    case 'ArrowUp':
      e.preventDefault();
      focusNextItem(target, 'up');
      break;

    case 'ArrowRight':
      // On collapsed category → expand
      if (target.closest('.category-header')) {
        const catId = target.closest('[data-category]')!.getAttribute('data-category')!;
        if (!currentState().expandedCategories.has(catId)) {
          toggleCategory(catId);
        }
      }
      break;

    case 'ArrowLeft':
      // On expanded category → collapse. On tool → focus parent category header.
      if (target.closest('.category-header')) {
        const catId = target.closest('[data-category]')!.getAttribute('data-category')!;
        if (currentState().expandedCategories.has(catId)) {
          toggleCategory(catId);
        }
      } else if (target.closest('.tool-item')) {
        const catHeader = target.closest('.stats-category')?.querySelector('.category-header') as HTMLElement;
        catHeader?.focus();
      }
      break;
  }
});
```

Add `tabindex="-1"` to all tool items and category headers (only the currently focused item gets `tabindex="0"` via the roving pattern). Add `role="tree"` to the categories container, `role="group"` to categories, `role="treeitem"` to headers and tools.

### 5.4 `webview/resources/resources.css` — Extended styles

New CSS for:

```css
/* ── Theme-aware accent ─────────────────────────────── */
:root { --ql-accent: #fc7432; }
.vscode-light { --ql-accent: #d35400; }  /* darker for light backgrounds */

/* ── Toolbar (search + filter) ──────────────────────── */
.toolbar { display: flex; align-items: center; gap: 4px; padding: 4px 8px; }
.search-container { flex: 1; display: flex; align-items: center; gap: 4px;
                    background: var(--vscode-input-background); border-radius: 4px; padding: 2px 6px; }
.search-input { flex: 1; background: none; border: none; color: var(--vscode-input-foreground);
                outline: none; font-size: 12px; }
.search-clear { cursor: pointer; opacity: 0.5; }
.search-clear:hover { opacity: 1; }
.filter-toggle { background: none; border: 1px solid var(--vscode-editorWidget-border);
                 border-radius: 3px; padding: 2px 4px; cursor: pointer;
                 color: var(--vscode-descriptionForeground); }
.filter-toggle.active { background: var(--ql-accent); color: #000; border-color: var(--ql-accent); }

/* ── Tool items ─────────────────────────────────────── */
.tool-item { display: flex; align-items: center; gap: 6px; padding: 3px 8px;
             border-radius: 3px; outline: none; }
.tool-item:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.tool-implemented { cursor: pointer; }
.tool-implemented:hover { background: var(--vscode-list-hoverBackground); }
.tool-unimplemented { color: var(--vscode-disabledForeground); cursor: not-allowed; }
.tool-unimplemented:hover { opacity: 0.8; }
.tool-indicator { font-size: 8px; width: 12px; text-align: center; }
.tool-implemented .tool-indicator { color: var(--ql-accent); }
.tool-description { font-size: 11px; color: var(--vscode-descriptionForeground);
                    padding: 0 8px 2px 28px; white-space: nowrap;
                    overflow: hidden; text-overflow: ellipsis; }

/* ── Category description (shown when expanded) ──── */
.category-description { font-size: 11px; color: var(--vscode-descriptionForeground);
                        padding: 2px 8px 6px 28px; line-height: 1.3; }

/* ── Tier divider ───────────────────────────────────── */
.tier-divider { display: flex; align-items: center; gap: 8px; padding: 4px 8px; margin: 4px 0; }
.tier-line { flex: 1; height: 1px; background: var(--vscode-editorWidget-border); }
.tier-toggle { background: none; border: none; color: var(--vscode-descriptionForeground);
               font-size: 11px; cursor: pointer; white-space: nowrap; }
.tier-toggle:hover { color: var(--ql-accent); }

/* ── Cross-reference badge ──────────────────────────── */
.cross-ref-icon { font-size: 10px; opacity: 0.4; margin-left: auto; cursor: pointer; }
.cross-ref-icon:hover { opacity: 1; color: var(--ql-accent); }

/* ── Workflows section ──────────────────────────────── */
.workflows-section { padding: 4px 8px; margin-bottom: 4px;
                     border-bottom: 1px solid var(--vscode-editorWidget-border); }
.workflows-header { display: flex; align-items: center; gap: 4px;
                    font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px;
                    opacity: 0.6; padding: 4px 0; cursor: pointer; }
.workflows-count { font-size: 10px; }
.workflow-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px;
                cursor: pointer; border-radius: 3px; }
.workflow-item:hover { background: var(--vscode-list-hoverBackground); }
.workflow-step-count { font-size: 10px; opacity: 0.5; margin-left: auto; }

/* ── Loading & error states ─────────────────────────── */
.catalog-loading { display: flex; align-items: center; justify-content: center;
                   height: 100px; color: var(--vscode-descriptionForeground); }
.catalog-error-banner { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
                        font-size: 11px; border-radius: 3px; margin: 4px 8px; }
.catalog-error-banner.warning { background: var(--vscode-inputValidation-warningBackground);
                                border: 1px solid var(--vscode-inputValidation-warningBorder); }
.catalog-error-banner.error { background: var(--vscode-inputValidation-errorBackground);
                              border: 1px solid var(--vscode-inputValidation-errorBorder); }
.catalog-error-banner .retry-btn { background: none; border: 1px solid currentColor;
                                   border-radius: 3px; padding: 1px 6px; cursor: pointer;
                                   color: inherit; font-size: 11px; margin-left: auto; }

/* ── Empty search state ─────────────────────────────── */
.empty-search { display: flex; flex-direction: column; align-items: center;
                padding: 24px 16px; color: var(--vscode-descriptionForeground); }
.empty-search .codicon { font-size: 24px; margin-bottom: 8px; opacity: 0.4; }
.empty-search-hint { font-size: 11px; opacity: 0.6; text-align: center; }

/* ── Contextual filtering indicator ─────────────────── */
.context-banner { display: flex; align-items: center; gap: 6px; padding: 4px 8px;
                  font-size: 11px; color: var(--vscode-descriptionForeground);
                  background: var(--vscode-inputValidation-infoBackground);
                  border-radius: 3px; margin: 4px 8px; }
.context-banner .clear-btn { cursor: pointer; opacity: 0.6; }
.context-banner .clear-btn:hover { opacity: 1; }
.category-context-match { border-left: 2px solid var(--ql-accent); }

/* ── Cross-ref navigation highlight ─────────────────── */
.tool-highlight { animation: highlight-flash 1s ease-out; }
@keyframes highlight-flash {
  0% { background: var(--vscode-editor-findMatchHighlightBackground); }
  100% { background: transparent; }
}
```

### 5.5 `src/commands/dataCommands.ts` — Clean up placeholder commands

Remove the placeholder commands: `showStrategyTests`, `showTemplates`, `showGuides`, `runStrategyTest`, `applyTemplate`. Strategy tool clicks now go through the same `handleToolClick` path as stats. Keep the `quantlab.openStatsTest` command as-is — it's the execution entry point.

**IMPORTANT:** Also remove the corresponding command contributions from `package.json` (`quantlab.showStrategyTests`, `quantlab.showTemplates`, `quantlab.showGuides`, `quantlab.runStrategyTest`, `quantlab.applyTemplate`) and their associated NLS title keys. If commands are removed from TypeScript but left in `package.json`, VS Code will show them in the command palette but they will fail with "command not found."

**Also note:** The following commands are currently registered programmatically in `dataCommands.ts` but do NOT have entries in `package.json`: `quantlab.setResourcesSection`, `quantlab.resources.setSection`, `quantlab.executeStatsTest`, `quantlab.cancelStatsTest`, `quantlab.getDataFileColumns`, `quantlab.getDataFilePreview`. These work when called by other code but are not discoverable via the command palette. If they should be user-facing, add `package.json` contributions for them.

### 5.6 `src/extension.ts` — Initialize catalog service

Add initialization of `ResourcesCatalogService` alongside the existing `ResourcesWebviewProvider.initialize()`:

```typescript
// Initialize catalog service FIRST (needs context for globalState persistence)
const catalogService = ResourcesCatalogService.initialize(context);

// Then initialize webview provider with BOTH extensionUri and catalogService
// NOTE: The current initialize() signature is initialize(extensionUri: vscode.Uri)
// Change it to: initialize(extensionUri: vscode.Uri, catalogService: ResourcesCatalogService)
const resourcesProvider = ResourcesWebviewProvider.initialize(context.extensionUri, catalogService);

// Register the webview provider (this line already exists, keep it)
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider(ResourcesWebviewProvider.viewType, resourcesProvider)
);
```

In the `deactivate()` function, add cleanup:

```typescript
ResourcesCatalogService.getInstance()?.dispose();
```

The `dispose()` method should cancel any in-flight fetch promises, clear the memory cache, and clear timers.

---

## 6. Files to Remove

| File | Reason |
|---|---|
| `src/panels/resources/resourcesCatalog.json` | Replaced by server catalog |
| `webview/resources/statsCatalog.ts` | Replaced by server catalog sent via message |
| `src/panels/resources/ResourcesTreeProvider.ts` | Redundant — webview does everything |
| `src/panels/resources/ResourcesPanelProvider.ts` | Wrapper for the tree view — remove with it |

**Migration note:** The `ResourcesTreeProvider` reads `resourcesCatalog.json` at runtime from the extension's source directory. After removal:
- Check `package.json` for any view contribution referencing `quantlab.resourcesView` — remove it if present (note: the main view is `quantlab.resourcesPanel` which is the webview — keep that)
- Check `extension.ts` for any tree view creation — remove it if present (currently `ResourcesPanelProvider` is never instantiated in `extension.ts`, so this is likely a no-op)

---

## 7. Caching Strategy

```
Request flow:

1. getCatalog() called
   │
2. Memory cache valid? (< 5 min old)
   ├─ YES → return immediately
   │
3. Fetch from server: GET /v1/resources/catalog
   ├─ SUCCESS → update memory cache, persist to storage, return
   │
4. Server unreachable?
   ├─ Extension storage has cached catalog?
   │   ├─ YES → return from storage (any age), schedule background retry
   │
5. No storage cache either?
   └─ Return bundled fallback (13 implemented tools only)
```

**Storage persistence:** Use `context.globalState.update(STORAGE_KEY, catalog)`. This survives extension restarts and VS Code restarts.

**Background refresh:** On extension activation, kick off a non-blocking catalog fetch (same as the server connection pattern in `extension.ts`):

```typescript
// Non-blocking catalog pre-fetch
void catalogService.getCatalog().catch(() => {
  // Silently fall back to cached/fallback — server connection is optional
});
```

---

## 8. Icon Mapping

The server sends semantic icon names. Map to codicons client-side:

```typescript
// All server icon names are valid VS Code codicons (verified against the codicon font).
// No mapping table is needed — the server icon names are used directly as codicon classes.
// Only a fallback function is needed for defensive coding:

function resolveIcon(serverIcon: string): string {
  // All 46 icon names from the catalog are valid codicons.
  // This fallback only triggers if a future catalog update adds an invalid name.
  return serverIcon || 'symbol-misc';
}
```

**Note:** All icons used in the catalog (`database`, `pulse`, `history`, `graph`, `graph-scatter`, `layers`, `debug-alt`, `link`, `arrow-right`, `group-by-ref-type`, `split-vertical`, `eye`, `flame`, `git-merge`, `radio-tower`, `ungroup-by-ref-type`, `settings-gear`, `fold`, `check-all`, `whole-word`, `bug`, `shield`, `mirror`, `table`, `warning`, `zap`, `graph-line`, `graph-left`, `calendar`, `circuit-board`, `play-circle`, `dashboard`, `search-fuzzy`, `target`, `compass`, `rocket`, `pie-chart`, `hubot`, `lightbulb`, `git-compare`, `history`, `library`, `inspect`) are verified valid codicons. No translation map is necessary.

---

## 9. Backwards Compatibility

The existing `StatsCatalog.ts` and `StatsEngine.ts` use legacy tool IDs (`'adf'`, `'kpss'`, etc.). The server uses canonical IDs (`'augmented-dickey-fuller'`, `'kpss'`).

**Do NOT modify `StatsCatalog.ts` or `StatsEngine.ts`** — they work and handle execution. Instead, maintain `TOOL_ID_MAP` in `src/types/resources.ts` to translate:

```
Server ID → Legacy Client ID → StatsEngine.executeTest()
```

As new tools get implemented:
1. Server marks `implemented: true`
2. Add Python execution to `StatsEngine`
3. Add parameter definition to `StatsCatalog.ts` with a client ID
4. Add the mapping to `TOOL_ID_MAP`

---

## 10. Contextual Filtering

When the user selects a data file or changes the active data source, the Resources panel should **highlight** relevant categories in-place (NOT reorder them). Reordering a 30-item list disrupts spatial memory — users learn that "Stationarity is always category #2" and reordering breaks that.

**Trigger:** Listen to `GlobalState.onDataSourceChange` and inspect the data file's characteristics:
- Single column → `'single-series'`
- Multiple columns → `'multi-series'`
- Has entity/group columns → `'panel'`
- Has strike/expiry columns → `'options'`
- Has maturity/coupon columns → `'fixed-income'`

**Action:** Send the context hint and matching category IDs to the webview:

```typescript
const matching = catalogService.getCategoriesForContext(section, hint).map(c => c.id);
this.postMessage({
  type: 'updateCategoryHighlight',
  contextHint: hint,
  matchingCategoryIds: matching,
});
```

**The webview must handle this message** — add it to the message handler:

```typescript
case 'updateCategoryHighlight':
  // Show context banner at top
  const banner = document.querySelector('.context-banner');
  if (data.contextHint) {
    banner.innerHTML = `
      Relevant for: <strong>${escapeHtml(data.contextHint)}</strong> data
      <span class="codicon codicon-close clear-btn" title="Clear filter"></span>
    `;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }

  // Highlight matching categories with left accent border (keep order fixed)
  document.querySelectorAll('.stats-category').forEach(el => {
    const catId = el.getAttribute('data-category');
    if (data.matchingCategoryIds.includes(catId)) {
      el.classList.add('category-context-match');
    } else {
      el.classList.remove('category-context-match');
    }
  });
  break;
```

This preserves category order while visually indicating relevance via a `2px solid var(--ql-accent)` left border on matching categories and a dismissible banner at the top.

---

## 11. Implementation Order

| Step | Files | Description | Dependency |
|---|---|---|---|
| **1** | `src/types/resources.ts` | Define types + ID map | None |
| **2** | `ServerApiClient.ts` | Add 3 new methods | Step 1 |
| **3** | `ResourcesCatalogService.ts`, `fallbackCatalog.ts` | Catalog fetch + cache + search | Steps 1-2 |
| **4** | `ResourcesWebviewProvider.ts` | Expand message protocol, inject catalog service | Step 3 |
| **5** | `webview/resources/index.ts` | Full webview rewrite: search, tiers, persistence | Step 4 |
| **6** | `webview/resources/resources.css` | New styles | Step 5 |
| **7** | `extension.ts`, `dataCommands.ts` | Wire initialization, clean up placeholders | Steps 3-4 |
| **8** | Remove dead files | Delete old catalogs, tree provider | Step 7 |
| **9** | Contextual filtering | GlobalState observation + reorder | Steps 3-5 |

Steps 1-3 can be done without the server being ready (use the fallback catalog for development).
Steps 4-6 can be tested with mock data posted to the webview.
Step 9 is an enhancement after core functionality works.

---

## 12. Testing Strategy

1. **No server available**: Verify fallback catalog loads, 15 implemented tools clickable, **fallback error banner visible**
2. **Server available**: Verify full catalog fetches, renders ~566 tools across 46 categories
3. **Search**: Type "kalman" → should find tools in State-Space (stats) and Stat Arb (strategy); type "GARCH" → should match the "Volatility & GARCH" category
4. **Empty search**: Type "blokchan" → should show empty state with the query displayed
5. **Tier toggle**: Expand category → only Essential visible → click "Show 6 Advanced" → Advanced appears with count
6. **Collapse persistence**: Expand 3 categories → reload panel → same 3 expanded
7. **Per-section state**: Search "kalman" in Stats → switch to Strategy → search should be empty → switch back to Stats → "kalman" search should be restored
8. **Unimplemented tool click**: Should show `cursor: not-allowed`, tooltip shows `[Planned]` prefix — no VS Code notification banner
9. **Implemented tool click**: Should open Stats view with configuration
10. **"Implemented only" filter**: Toggle on → only 15 tools visible across ~5 categories → toggle off → full catalog returns
11. **Cross-reference click**: Click link icon on `kalman-filter` → should switch to Strategy, expand Stat Arb category, scroll to `kalman-filter-hedge` with highlight flash
12. **Keyboard navigation**: Tab to category header → Enter to expand → ArrowDown through tools → Enter to click
13. **Category description**: Expand category → description text visible below header
14. **Contextual filtering**: Select single-series data → Stationarity/Autocorrelation categories get left accent border, context banner appears
15. **Workflows collapsible**: Click workflow header → expands/collapses workflow list
16. **Error banner**: Disconnect server, clear storage → fallback banner with "Retry" button
17. **Light theme**: Switch to Quantlab Light → verify accent colors, unimplemented opacity, tier dividers all remain visible
18. **Cache**: Disconnect server after first fetch → catalog still available from storage, stale-cache banner visible

---

## 13. Summary of All Changes

| Action | File | Lines (est.) |
|---|---|---|
| **Create** | `src/types/resources.ts` | ~90 |
| **Create** | `src/panels/resources/ResourcesCatalogService.ts` | ~220 |
| **Create** | `src/panels/resources/fallbackCatalog.ts` | ~80 |
| **Modify** | `src/core/server/ServerApiClient.ts` | +20 |
| **Modify** | `src/panels/resources/ResourcesWebviewProvider.ts` | ~280 (rewrite most of body, new message types) |
| **Modify** | `webview/resources/index.ts` | ~450 (full rewrite: per-section state, keyboard nav, filters) |
| **Modify** | `webview/resources/resources.css` | +150 (themes, error banners, context highlight, empty state) |
| **Modify** | `src/extension.ts` | +8 |
| **Modify** | `src/commands/dataCommands.ts` | -30 (remove placeholders) |
| **Modify** | `package.json` | -15 (remove 5 placeholder command contributions) |
| **Delete** | `src/panels/resources/resourcesCatalog.json` | -14 |
| **Delete** | `webview/resources/statsCatalog.ts` | -43 |
| **Delete** | `src/panels/resources/ResourcesTreeProvider.ts` | -115 |
| **Delete** | `src/panels/resources/ResourcesPanelProvider.ts` | -17 |

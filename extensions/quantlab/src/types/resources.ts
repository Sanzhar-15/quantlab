/*---------------------------------------------------------------------------------------------
 *  Resource catalog types for the Resources activity bar panel.
 *  Shared between ResourcesCatalogService, ResourcesWebviewProvider, and ServerApiClient.
 *--------------------------------------------------------------------------------------------*/

// ── Section type mapping ────────────────────────────────────────────────────
// Codebase uses 'stats'; server API uses 'statistics'.

export type ClientSection = 'strategy' | 'stats';
export type ServerSection = 'strategy' | 'statistics';

export function toClientSection(s: ServerSection): ClientSection {
	return s === 'statistics' ? 'stats' : s;
}

export function toServerSection(s: ClientSection): ServerSection {
	return s === 'stats' ? 'statistics' : s;
}

// ── Server response types (matching API contract) ───────────────────────────

export interface ResourcesCatalogResponse {
	version: string;
	generated_at: string;
	sections: {
		statistics: ResourcesSection;
		strategy: ResourcesSection;
	};
	workflows: WorkflowTemplate[];
}

export interface ResourcesSection {
	label: string;
	description: string;
	categories: ResourceCategory[];
}

export interface ResourceCategory {
	id: string;
	label: string;
	description: string;
	order: number;
	icon: string;
	context_hints: DataContextHint[];
	tools: ResourceTool[];
}

export interface ResourceTool {
	id: string;
	label: string;
	description: string;
	tier: 'essential' | 'advanced';
	implemented: boolean;
	cross_ref: string | null;
}

export interface WorkflowTemplate {
	id: string;
	label: string;
	description: string;
	section: 'statistics' | 'strategy';
	steps: string[];
}

export type DataContextHint =
	| 'any'
	| 'single-series'
	| 'multi-series'
	| 'panel'
	| 'options'
	| 'fixed-income'
	| 'high-frequency';

// ── Offline resource helpers ─────────────────────────────────────────────────

export function isOfflineResource(toolId: string): boolean {
	return toolId.startsWith('offline-');
}

export interface ResourceUISpec {
	sections: string[];
	resultLayout: 'stats' | 'metrics' | 'distribution';
	executionMode: 'local' | 'server';
}

// ── Phase 2 types (deferred) ────────────────────────────────────────────────

export interface ResourceToolDetail extends ResourceTool {
	category_id: string;
	section: ServerSection;
	required_columns?: {
		count: number | '1+' | '2+';
		types: ('float64' | 'int64')[];
	};
	parameters?: ParameterDefinition[];
	uiSpec?: ResourceUISpec;
}

export interface ParameterDefinition {
	id: string;
	label: string;
	type: 'number' | 'select' | 'boolean' | 'array' | 'string';
	default: unknown;
	options?: { value: string; label: string }[];
	min?: number;
	max?: number;
	description?: string;
}

// ── Client-only types ───────────────────────────────────────────────────────

export interface CatalogState {
	version: string;
	statistics: ResourceCategory[];
	strategy: ResourceCategory[];
	workflows: WorkflowTemplate[];
	fetchedAt: number;
}

export interface SearchResult {
	tool: ResourceTool;
	categoryId: string;
	categoryLabel: string;
}

// ── ID mapping for backwards compatibility with StatsCatalog.ts ─────────────
// Maps server canonical kebab-case IDs → legacy client IDs used by StatsEngine.

export const TOOL_ID_MAP: Record<string, string> = {
	'summary-statistics': 'summary',
	'returns-analysis': 'returns',
	'rolling-statistics': 'rolling',
	'augmented-dickey-fuller': 'adf',
	'kpss': 'kpss',
	'phillips-perron': 'pp',
	'jarque-bera': 'normality',
	'shapiro-wilk': 'normality',
	'anderson-darling': 'normality',
	'pearson-correlation': 'correlation',
	'acf-pacf': 'acf-pacf',
	'ljung-box': 'ljung-box',
	'value-at-risk': 'var',
	'expected-shortfall': 'es',
	'sharpe-ratio': 'sharpe',
};

/*---------------------------------------------------------------------------------------------
 *  ResourcesCatalogService
 *  Singleton service managing catalog fetch, two-tier cache, search, and context filtering.
 *  Cache: memory (5min TTL) → extension storage (persisted across sessions).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ServerApiClient } from '../../core/server/ServerApiClient';
import {
	CatalogState,
	ClientSection,
	DataContextHint,
	ResourceCategory,
	ResourceTool,
	ResourcesCatalogResponse,
	SearchResult,
	isOfflineResource,
} from '../../types/resources';
import { OFFLINE_STATISTICS, OFFLINE_STRATEGY } from './OfflineResourcesCatalog';

export class ResourcesCatalogService {
	private static instance: ResourcesCatalogService;

	private catalog: CatalogState | null = null;
	private fetchPromise: Promise<CatalogState | null> | null = null;
	private readonly globalState: vscode.Memento;

	private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in memory
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

	// ── Fetch ─────────────────────────────────────────────────────────────────

	async getCatalog(forceRefresh?: boolean): Promise<CatalogState | null> {
		// 1. Check memory cache (with TTL)
		if (!forceRefresh && this.catalog && this.isCacheFresh()) {
			return this.catalog;
		}

		// Deduplicate concurrent fetches
		if (this.fetchPromise) {
			return this.fetchPromise;
		}

		this.fetchPromise = this.doFetch(forceRefresh);
		try {
			return await this.fetchPromise;
		} finally {
			this.fetchPromise = null;
		}
	}

	private async doFetch(forceRefresh?: boolean): Promise<CatalogState | null> {
		// Try server first
		try {
			const catalog = await this.fetchFromServer();
			if (catalog) {
				this.mergeOfflineResources(catalog);
				this.catalog = catalog;
				await this.persistToStorage(catalog);
				return catalog;
			}
			// Server returned null (version match) — memory cache is still valid
			if (this.catalog) {
				this.catalog.fetchedAt = Date.now();
				return this.catalog;
			}
		} catch {
			// Server unreachable — fall through to storage
		}

		// 2. Try extension storage (persisted from a previous fetch)
		if (!forceRefresh) {
			const stored = this.loadFromStorage();
			if (stored) {
				this.mergeOfflineResources(stored);
				this.catalog = stored;
				return stored;
			}
		}

		// 3. Offline-only fallback (no server, no cache)
		const offlineOnly = this.buildOfflineOnlyCatalog();
		this.catalog = offlineOnly;
		return offlineOnly;
	}

	private mergeOfflineResources(catalog: CatalogState): void {
		// Prepend offline resources (avoid duplicates)
		const existingStatIds = new Set(catalog.statistics.map(c => c.id));
		for (const cat of OFFLINE_STATISTICS) {
			if (!existingStatIds.has(cat.id)) {
				catalog.statistics.unshift(cat);
			}
		}
		const existingStratIds = new Set(catalog.strategy.map(c => c.id));
		for (const cat of OFFLINE_STRATEGY) {
			if (!existingStratIds.has(cat.id)) {
				catalog.strategy.unshift(cat);
			}
		}
	}

	private buildOfflineOnlyCatalog(): CatalogState {
		return {
			version: 'offline',
			statistics: [...OFFLINE_STATISTICS],
			strategy: [...OFFLINE_STRATEGY],
			workflows: [],
			fetchedAt: Date.now(),
		};
	}

	private async fetchFromServer(): Promise<CatalogState | null> {
		const client = ServerApiClient.getInstance();
		const cachedVersion = this.catalog?.version;
		const response = await client.getResourcesCatalog(cachedVersion);

		// Server returns null data when cached version matches
		if (response === null) {
			return null;
		}

		return this.transformResponse(response);
	}

	private transformResponse(response: ResourcesCatalogResponse): CatalogState {
		return {
			version: response.version,
			statistics: response.sections.statistics.categories,
			strategy: response.sections.strategy.categories,
			workflows: response.workflows,
			fetchedAt: Date.now(),
		};
	}

	// ── Cache helpers ─────────────────────────────────────────────────────────

	private isCacheFresh(): boolean {
		if (!this.catalog || this.catalog.fetchedAt === 0) {
			return false;
		}
		return (Date.now() - this.catalog.fetchedAt) < ResourcesCatalogService.CACHE_TTL_MS;
	}

	private async persistToStorage(catalog: CatalogState): Promise<void> {
		try {
			await this.globalState.update(ResourcesCatalogService.STORAGE_KEY, catalog);
		} catch {
			// Storage write failure is non-fatal
		}
	}

	private loadFromStorage(): CatalogState | null {
		const stored = this.globalState.get<CatalogState>(ResourcesCatalogService.STORAGE_KEY);
		return stored ?? null;
	}

	// ── Search ────────────────────────────────────────────────────────────────

	search(query: string, section: ClientSection): SearchResult[] {
		if (!this.catalog || !query.trim()) {
			return [];
		}

		const q = query.toLowerCase().trim();
		const categories = section === 'stats' ? this.catalog.statistics : this.catalog.strategy;
		const results: SearchResult[] = [];

		for (const cat of categories) {
			const catLabelMatch = cat.label.toLowerCase().includes(q);

			for (const tool of cat.tools) {
				const labelMatch = tool.label.toLowerCase().includes(q);
				const descMatch = tool.description.toLowerCase().includes(q);

				if (labelMatch || descMatch || catLabelMatch) {
					results.push({
						tool,
						categoryId: cat.id,
						categoryLabel: cat.label,
					});
				}
			}
		}

		// Sort: exact label matches first, then label substring, then description-only
		results.sort((a, b) => {
			const aExact = a.tool.label.toLowerCase() === q ? 0 : 1;
			const bExact = b.tool.label.toLowerCase() === q ? 0 : 1;
			if (aExact !== bExact) { return aExact - bExact; }

			const aLabel = a.tool.label.toLowerCase().includes(q) ? 0 : 1;
			const bLabel = b.tool.label.toLowerCase().includes(q) ? 0 : 1;
			return aLabel - bLabel;
		});

		return results;
	}

	// ── Contextual Filtering ──────────────────────────────────────────────────

	getCategoriesForContext(section: ClientSection, context: DataContextHint): string[] {
		if (!this.catalog) { return []; }
		const categories = section === 'stats' ? this.catalog.statistics : this.catalog.strategy;
		return categories
			.filter(cat => cat.context_hints.includes(context) || cat.context_hints.includes('any'))
			.map(cat => cat.id);
	}

	// ── Lookup ────────────────────────────────────────────────────────────────

	getToolById(toolId: string): ResourceTool | undefined {
		if (!this.catalog) { return undefined; }
		for (const cat of [...this.catalog.statistics, ...this.catalog.strategy]) {
			const tool = cat.tools.find(t => t.id === toolId);
			if (tool) { return tool; }
		}
		return undefined;
	}

	getCategoryForTool(toolId: string): ResourceCategory | undefined {
		if (!this.catalog) { return undefined; }
		for (const cat of [...this.catalog.statistics, ...this.catalog.strategy]) {
			if (cat.tools.some(t => t.id === toolId)) {
				return cat;
			}
		}
		return undefined;
	}

	getSectionForCategory(categoryId: string): ClientSection | null {
		if (!this.catalog) { return null; }
		if (this.catalog.statistics.some(c => c.id === categoryId)) {
			return 'stats';
		}
		if (this.catalog.strategy.some(c => c.id === categoryId)) {
			return 'strategy';
		}
		return null;
	}

	getSectionForTool(toolId: string): ClientSection | null {
		const category = this.getCategoryForTool(toolId);
		if (!category) { return null; }
		return this.getSectionForCategory(category.id);
	}

	// ── Offline check ────────────────────────────────────────────────────────

	isOfflineResource(toolId: string): boolean {
		return isOfflineResource(toolId);
	}

	// ── Dispose ───────────────────────────────────────────────────────────────

	dispose(): void {
		this.catalog = null;
		this.fetchPromise = null;
	}
}

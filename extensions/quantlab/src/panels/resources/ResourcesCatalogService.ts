/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 *  ResourcesCatalogService
 *  Singleton service managing catalog fetch, an in-memory cache, search, and context filtering.
 *  Cache: memory only (5min TTL), dropped on every identity change. No persisted copy: a failed
 *  fetch rejects with its error (QL-DATA DT-3; estate law section 4).
 */

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
	/** Bumped on every identity change; a fetch started under an older value is dropped. */
	private identityGeneration = 0;
	private readonly authSubscription: vscode.Disposable;

	private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in memory
	/** DELETE-ONLY: the globalState key that used to persist the catalog. Never read. */
	private static readonly LEGACY_STORAGE_KEY = 'quantlab.resourcesCatalog';

	private constructor(context: vscode.ExtensionContext) {
		ResourcesCatalogService.purgeStoredCatalog(context.globalState);
		// ServerApiClient.onAuthStateChange fires on every identity change pushed by
		// setHostIdentity (sign-in, sign-out, a change of user or of the user's fields):
		// the previous identity's catalog must not outlive it.
		this.authSubscription = ServerApiClient.getInstance().onAuthStateChange(() => this.dropForIdentityChange());
	}

	/** Delete-only purge of the formerly persisted catalog, once per activation. No value is read. */
	private static purgeStoredCatalog(memento: vscode.Memento): void {
		const key = ResourcesCatalogService.LEGACY_STORAGE_KEY;
		memento.update(key, undefined).then(
			() => console.log(`[ResourcesCatalogService] stored catalog key deleted: ${key}`),
			(err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[ResourcesCatalogService] could not delete the stored catalog key ${key}:`, err);
				void vscode.window.showWarningMessage(`Quantlab could not delete the stored resources catalog (${key}): ${message}`);
			}
		);
	}

	private dropForIdentityChange(): void {
		this.identityGeneration++;
		this.catalog = null;
		this.fetchPromise = null;
	}

	static initialize(context: vscode.ExtensionContext): ResourcesCatalogService {
		if (!ResourcesCatalogService.instance) {
			ResourcesCatalogService.instance = new ResourcesCatalogService(context);
		}
		return ResourcesCatalogService.instance;
	}

	static getInstance(): ResourcesCatalogService {
		if (!ResourcesCatalogService.instance) {
			throw new Error('ResourcesCatalogService not initialized -- call initialize(context) first');
		}
		return ResourcesCatalogService.instance;
	}

	// ---- Fetch ----

	async getCatalog(forceRefresh?: boolean): Promise<CatalogState | null> {
		// Signed out: the catalog IS the local built-in tools, chosen from the
		// identity state -- no fetch is made. Never a stand-in for a failed fetch.
		if (!ServerApiClient.getInstance().isAuthenticated()) {
			const builtIns = this.buildBuiltInCatalog();
			this.catalog = builtIns;
			return builtIns;
		}

		// Signed in: the server catalog. 1. Check memory cache (with TTL)
		if (!forceRefresh && this.catalog && this.isCacheFresh()) {
			return this.catalog;
		}

		// Deduplicate concurrent fetches
		if (this.fetchPromise) {
			return this.fetchPromise;
		}

		const pending = this.doFetch();
		this.fetchPromise = pending;
		try {
			return await pending;
		} finally {
			// An identity change may already have replaced the pending fetch.
			if (this.fetchPromise === pending) {
				this.fetchPromise = null;
			}
		}
	}

	/** One server fetch. A failure rejects with its error: no stored or offline-only substitute. */
	private async doFetch(): Promise<CatalogState> {
		const generation = this.identityGeneration;
		const catalog = await this.fetchFromServer();
		if (generation !== this.identityGeneration) {
			throw new Error('The signed-in identity changed during the resources catalog fetch; its answer was dropped.');
		}
		if (catalog) {
			this.mergeOfflineResources(catalog);
			this.catalog = catalog;
			return catalog;
		}
		// Server returned null (version match) -- the memory cache is still valid
		if (!this.catalog) {
			throw new Error('The server answered "catalog unchanged" but no catalog is held.');
		}
		this.catalog.fetchedAt = Date.now();
		return this.catalog;
	}

	/** The signed-out catalog: the local built-in tools only (the panel shows its offline notice). */
	private buildBuiltInCatalog(): CatalogState {
		return {
			version: 'offline',
			statistics: [...OFFLINE_STATISTICS],
			strategy: [...OFFLINE_STRATEGY],
			workflows: [],
			fetchedAt: Date.now(),
		};
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

	// ---- Cache helpers ----

	private isCacheFresh(): boolean {
		if (!this.catalog || this.catalog.fetchedAt === 0) {
			return false;
		}
		return (Date.now() - this.catalog.fetchedAt) < ResourcesCatalogService.CACHE_TTL_MS;
	}

	// ---- Search ----

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

	// ---- Contextual Filtering ----

	getCategoriesForContext(section: ClientSection, context: DataContextHint): string[] {
		if (!this.catalog) { return []; }
		const categories = section === 'stats' ? this.catalog.statistics : this.catalog.strategy;
		return categories
			.filter(cat => cat.context_hints.includes(context) || cat.context_hints.includes('any'))
			.map(cat => cat.id);
	}

	// ---- Lookup ----

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

	// ---- Offline check ----

	isOfflineResource(toolId: string): boolean {
		return isOfflineResource(toolId);
	}

	// ---- Dispose ----

	dispose(): void {
		this.authSubscription.dispose();
		this.catalog = null;
		this.fetchPromise = null;
	}
}

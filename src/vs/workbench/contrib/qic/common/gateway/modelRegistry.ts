/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { LaneName } from '../canonical/lanes.js';
import type { ProviderAdapter } from '../canonical/interfaces.js';

export interface ModelConfig {
	alias: string;
	modelId: string;
	providerId: string;
	deprecated?: boolean;
	supportedLanes?: LaneName[];
}

const DEFAULT_MODELS: ModelConfig[] = [
	// Delta Plus Server models (server handles actual model selection)
	{ alias: 'server-auto', modelId: 'deltaplus-auto', providerId: 'deltaplus' },
	{ alias: 'server-fast', modelId: 'deltaplus-fast', providerId: 'deltaplus' },
	{ alias: 'server-reason', modelId: 'deltaplus-reason', providerId: 'deltaplus' },

	// Cloud models (server handles actual model selection)
	{ alias: 'cloud-default', modelId: 'quantlab-auto', providerId: 'quantlab-cloud' },
	{ alias: 'cloud-fast', modelId: 'quantlab-fast', providerId: 'quantlab-cloud' },
	{ alias: 'cloud-reason', modelId: 'quantlab-reason', providerId: 'quantlab-cloud' },

	// Existing BYOK models
	{ alias: 'claude-latest', modelId: 'claude-sonnet-4-20250514', providerId: 'anthropic' },
	{ alias: 'gpt-latest', modelId: 'gpt-4o', providerId: 'openai' },
	{ alias: 'local-fast', modelId: 'qwen2.5-coder:7b', providerId: 'ollama' },
	{ alias: 'claude-haiku', modelId: 'claude-3-5-haiku-20241022', providerId: 'anthropic' },
];

const DEPRECATED_MODELS = new Set([
	'claude-2.0',
	'claude-2.1',
	'gpt-3.5-turbo',
]);

/**
 * Per-lane ordered preference arrays.
 * Resolution iterates the array and picks the first alias whose provider is available.
 * CRITICAL-1: Restructured from Record<string, string> to Record<LaneName, string[]>.
 */
const LANE_MODEL_RECOMMENDATIONS: Record<LaneName, string[]> = {
	'completion': ['server-fast', 'cloud-fast', 'local-fast', 'gpt-latest'],
	'chat-ask': ['server-auto', 'cloud-default', 'claude-latest', 'gpt-latest'],
	'chat-gather': ['server-auto', 'cloud-default', 'claude-latest', 'gpt-latest'],
	'chat-plan': ['server-reason', 'cloud-reason', 'claude-latest', 'gpt-latest'],
	'chat-act': ['server-reason', 'cloud-reason', 'claude-latest', 'gpt-latest'],
	'repair': ['server-reason', 'cloud-reason', 'claude-latest', 'gpt-latest'],
	'fast-apply': ['server-fast', 'cloud-fast', 'claude-latest', 'gpt-latest'],
	'summarize': ['server-fast', 'cloud-fast', 'gpt-latest', 'claude-haiku'],
};

/**
 * Model alias resolution, deprecation checks, and lane compatibility (Audit C-4 / I-SG2).
 * CRITICAL-1: Per-lane ordered preference arrays with cloud-first fallback.
 */
export class ModelRegistry {
	private readonly models: ModelConfig[];
	private readonly aliases = new Map<string, string>();
	private readonly providers: Map<string, ProviderAdapter>;
	private readonly laneOverrides: Record<string, string>;

	constructor(
		providers: Map<string, ProviderAdapter>,
		customAliases?: Record<string, string>,
		laneOverrides?: Record<string, string>,
	) {
		this.providers = providers;
		this.models = [...DEFAULT_MODELS];
		this.laneOverrides = laneOverrides ?? {};

		for (const model of this.models) {
			this.aliases.set(model.alias, model.modelId);
		}

		if (customAliases) {
			for (const [alias, modelId] of Object.entries(customAliases)) {
				this.aliases.set(alias, modelId);
			}
		}
	}

	resolveAlias(alias: string): string {
		return this.aliases.get(alias) ?? alias;
	}

	isDeprecated(modelId: string): boolean {
		return DEPRECATED_MODELS.has(modelId);
	}

	supportsLane(modelId: string, _lane: LaneName): boolean {
		const model = this.models.find(m => m.modelId === modelId || m.alias === modelId);
		if (!model?.supportedLanes) { return true; }
		return model.supportedLanes.includes(_lane);
	}

	getRecommendedModel(lane: LaneName): string {
		const preferences = LANE_MODEL_RECOMMENDATIONS[lane];
		return this.resolveAlias(preferences[0] ?? 'claude-latest');
	}

	getProviderForModel(modelId: string): string | undefined {
		const resolved = this.resolveAlias(modelId);
		const model = this.models.find(m => m.modelId === resolved || m.alias === resolved);
		return model?.providerId;
	}

	/**
	 * Check if a provider is registered (Audit C-4).
	 */
	isProviderAvailable(providerId: string): boolean {
		return this.providers.has(providerId);
	}

	/**
	 * Get the best available model for a lane.
	 * Resolution: laneOverride (prefer) -> per-lane preference array -> any available model.
	 * CRITICAL-1: Iterates per-lane ordered array instead of separate fallbackOrder.
	 */
	getAvailableModelForLane(lane: LaneName): string {
		// 1. Check lane override (prefer, not require — INCONSISTENCY-11)
		const override = this.laneOverrides[lane];
		if (override) {
			const overrideConfig = this.models.find(m => m.alias === override || m.providerId === override);
			if (overrideConfig && this.providers.has(overrideConfig.providerId)) {
				return this.resolveAlias(overrideConfig.alias);
			}
			// Override provider unavailable — fall through with warning
		}

		// 2. Iterate per-lane preference array
		const preferences = LANE_MODEL_RECOMMENDATIONS[lane];
		for (const alias of preferences) {
			const config = this.models.find(m => m.alias === alias);
			if (config && this.providers.has(config.providerId)) {
				return this.resolveAlias(alias);
			}
		}

		// 3. Last resort: any available model from any provider
		for (const model of this.models) {
			if (this.providers.has(model.providerId)) {
				return model.modelId;
			}
		}

		// Nothing available — return first preference (gateway will produce a clear error)
		return this.resolveAlias(preferences[0] ?? 'claude-latest');
	}

	/**
	 * Get a list of all registered (available) provider IDs.
	 */
	getAvailableProviders(): string[] {
		return [...this.providers.keys()];
	}

	/**
	 * Validate configured models on startup (Audit I-SG2).
	 */
	async healthCheck(): Promise<Map<string, { available: boolean; error?: string }>> {
		const results = new Map<string, { available: boolean; error?: string }>();

		for (const model of this.models) {
			const provider = this.providers.get(model.providerId);
			if (!provider) {
				results.set(model.alias, { available: false, error: `Provider ${model.providerId} not registered` });
				continue;
			}
			try {
				const health = await provider.getHealth();
				results.set(model.alias, { available: health.status === 'healthy' });
			} catch (e) {
				results.set(model.alias, { available: false, error: String(e) });
			}
		}

		return results;
	}
}

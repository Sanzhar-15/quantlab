/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI model configuration
 *  Single source of truth for the Claude model the AI provider talks to. Pure + vscode-free
 *  so the default + allow-list can be unit-tested and shared between the provider, the
 *  key/load commands, and the package.json `quantlab.ai.model` enum.
 *
 *  The model is operator-configurable; the default is the most capable current model.
 *  IMPORTANT: the previous hardcoded `claude-3-5-sonnet-20241022` is RETIRED and 404s.
 *---------------------------------------------------------------------------------------------*/

/** The current Claude model IDs offered for the AI features (newest family). */
export const AI_MODELS: readonly string[] = [
	'claude-opus-4-8',
	'claude-sonnet-4-6',
	'claude-haiku-4-5',
];

/** Default model when none is configured: the most capable current model. */
export const DEFAULT_AI_MODEL = 'claude-opus-4-8';

/**
 * Resolve the model to use from the (optionally) configured value.
 * Falls through to the default only when nothing usable was configured -- this is NOT a
 * silent error-masking fallback: an unset/blank setting is a legitimate "use the default"
 * signal, and an unknown string is corrected to the default so a typo can never 404 a
 * whole feature silently.
 */
export function resolveModel(configured: string | undefined | null): string {
	if (typeof configured !== 'string') {
		return DEFAULT_AI_MODEL;
	}
	const trimmed = configured.trim();
	if (trimmed.length === 0) {
		return DEFAULT_AI_MODEL;
	}
	return AI_MODELS.includes(trimmed) ? trimmed : DEFAULT_AI_MODEL;
}

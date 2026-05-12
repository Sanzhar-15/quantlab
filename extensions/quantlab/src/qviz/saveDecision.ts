/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure save-decision function -- extracted from VisualiseSpecProvider's
 * `driftAwareSaveAs` so it can be unit-tested without a vscode shim
 * (Step C megaudit C14: provider had zero tests because everything
 * was tangled with vscode runtime).
 *
 * Given a drift detection status, the function returns one of:
 *   - `refuse`          -- save MUST be refused, with a structured
 *                          message naming the underlying reason.
 *   - `verbatim`        -- drift is `same-hash`; save the spec as-is.
 *   - `with-refresh`    -- drift is `fields-preserved`; save a spec
 *                          with refreshed `dataset.schema_hash` +
 *                          `provenance.generated_at` + reset
 *                          `query_hash`. The decision payload carries
 *                          the live schema so the caller can compute
 *                          the refreshed values.
 *
 * Pure: no I/O, no vscode imports. Decision is a function of input
 * status only.
 */

import type { DriftResult } from './schemaDrift';
import type { SchemaInfo } from './messageProtocol';

/** Tagged status of drift detection. Mirrors the provider's
 *  per-document state machine for save-decision purposes. */
export type DriftStatusForSave =
	| { readonly kind: 'idle' }
	| { readonly kind: 'in-flight' }
	| {
		readonly kind: 'detected';
		readonly result: DriftResult;
		readonly liveSchema: SchemaInfo;
	}
	| { readonly kind: 'failed'; readonly error: string };

export type SaveDecision =
	| { readonly action: 'refuse'; readonly reason: string; readonly userMessage: string }
	| { readonly action: 'verbatim' }
	| {
		readonly action: 'with-refresh';
		readonly liveSchema: SchemaInfo;
	};

/**
 * Decide what to do with a save request given the current drift
 * detection status.
 *
 * Refuse policy (Step C megaudit C5):
 *   - drift status idle / in-flight → refuse: drift unknown, save
 *     unsafe.
 *   - drift status failed → refuse: detection attempted but didn't
 *     produce a known answer.
 *   - drift = fields-missing → refuse: spec references columns that
 *     no longer exist in the data file. Saving would persist a
 *     spec the daemon will reject at first aggregate.
 *
 * Save policy:
 *   - drift = same-hash → verbatim. The on-disk spec already matches
 *     the live schema_hash.
 *   - drift = fields-preserved → with-refresh. The schema columns
 *     still satisfy the spec, but the schema_hash has changed; save
 *     a refreshed spec so the on-disk attribution matches.
 */
export function decideSave(status: DriftStatusForSave): SaveDecision {
	if (status.kind === 'idle') {
		return {
			action: 'refuse',
			reason: 'idle',
			userMessage: 'Cannot save: schema drift detection has not started yet. Please retry in a moment.',
		};
	}
	if (status.kind === 'in-flight') {
		return {
			action: 'refuse',
			reason: 'in-flight',
			userMessage: 'Cannot save: schema drift detection is still in progress. Please retry in a moment.',
		};
	}
	if (status.kind === 'failed') {
		return {
			action: 'refuse',
			reason: 'failed',
			userMessage: `Cannot save: schema drift detection failed (${status.error}). Resolve the underlying issue and retry.`,
		};
	}
	// status.kind === 'detected'
	const drift = status.result;
	if (drift.drift === 'fields-missing') {
		return {
			action: 'refuse',
			reason: 'fields-missing',
			userMessage:
				`Cannot save: spec references ${drift.missingFields.length} `
				+ `field(s) missing from data file (${drift.missingFields.join(', ')}). `
				+ 'Fix the broken encodings/transforms before saving.',
		};
	}
	if (drift.drift === 'fields-preserved') {
		return { action: 'with-refresh', liveSchema: status.liveSchema };
	}
	// drift.drift === 'same-hash'
	return { action: 'verbatim' };
}

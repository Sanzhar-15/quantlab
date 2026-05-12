/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pipeline-level validation -- Phase 5 step 5.G.4.
 *
 * The QvizSpec validator (`validate.ts`) checks each transform's own
 * shape but NOT cross-transform constraints. The daemon's compiler
 * (`python/qviz/compiler.py`) enforces ordering rules at compile time:
 * `groupby` must be immediately followed by `aggregate`, and
 * `aggregate` must be immediately preceded by `groupby`. A spec that
 * passes `validate()` but breaks these rules compiles to a runtime
 * error.
 *
 * `validatePipeline` mirrors those compile-time rules so the UI can
 * highlight the offending transforms inline. Pure function; no I/O.
 */

import type { Transform } from './spec';

/** Per-index error map. Empty for a clean pipeline. */
export type PipelineErrors = Readonly<Record<number, string>>;

export function validatePipeline(transforms: readonly Transform[]): PipelineErrors {
	const errors: Record<number, string> = {};
	for (let i = 0; i < transforms.length; i++) {
		const t = transforms[i];
		if (t.kind === 'groupby') {
			const next = transforms[i + 1];
			if (!next || next.kind !== 'aggregate') {
				errors[i] = 'groupby must be immediately followed by aggregate '
					+ '(daemon compiler rejects orphan groupby).';
			}
		}
		if (t.kind === 'aggregate') {
			const prev = transforms[i - 1];
			if (!prev || prev.kind !== 'groupby') {
				errors[i] = 'aggregate must be immediately preceded by groupby.';
			}
		}
	}
	return errors;
}

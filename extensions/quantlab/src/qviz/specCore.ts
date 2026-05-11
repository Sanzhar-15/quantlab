/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * specCore — vscode-free core for the .qviz.json document model.
 *
 * The QvizSpecDocument class (in src/views/visualise/QvizSpecDocument.ts)
 * is a thin VS Code adapter around this module. The split keeps the
 * load/validate/apply/serialize logic unit-testable from plain mocha
 * (without a vscode shim) and keeps the VS Code surface narrow.
 */

import type { QvizSpec } from './spec';
import { validate, validateOrThrow } from './validate';

/** Per-edit transition result. The two arms are not separately exported
 *  because callers discriminate via the `ok` boolean, not the type names. */
export type EditResult =
	| { readonly ok: true; readonly spec: QvizSpec }
	| { readonly ok: false; readonly error: string };

/**
 * Parse and validate a `.qviz.json` byte buffer into a QvizSpec.
 *
 * Failure modes (each surfaced as a thrown Error with a useful message):
 *   - bytes are not valid UTF-8.
 *   - text is not valid JSON.
 *   - JSON parses but fails QvizSpec validation.
 *
 * `sourceLabel` is included in error messages so callers (the document
 * loader, the revert path, the backup-restore path) get distinguishable
 * diagnostics.
 */
/** Megaudit defense-in-depth: cap spec byte size before JSON.parse to
 *  prevent unbounded CPU/memory work in V8's parser. 4 MiB is well
 *  above any realistic spec (typical specs are sub-10 KiB). */
const MAX_SPEC_BYTES = 4 * 1024 * 1024;

export function parseSpecBytes(bytes: Uint8Array, sourceLabel: string): QvizSpec {
	if (bytes.byteLength > MAX_SPEC_BYTES) {
		throw new Error(
			`spec ${sourceLabel} is too large: ${bytes.byteLength} bytes exceeds cap ${MAX_SPEC_BYTES}`,
		);
	}
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch (e) {
		throw new Error(
			`spec ${sourceLabel} is not valid UTF-8: ${e instanceof Error ? e.message : String(e)}`
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error(
			`spec ${sourceLabel} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`
		);
	}
	return validateOrThrow(parsed);
}

/**
 * Validate an in-memory edit. Returns a tagged result rather than throwing
 * so the document layer can decide whether to surface the error to the
 * user or treat it as a programmer bug.
 *
 * The validator is the same one that gates loading from disk, so an edit
 * accepted here is round-trippable: it can be serialized and reloaded
 * without further loss.
 *
 * Audit-fix M12: previously this function accepted a `_previous: QvizSpec`
 * argument that was ignored. Removed -- the webview reducer is the
 * gatekeeper for monotonicity invariants (e.g. "schema_hash didn't change");
 * the document layer is concerned only with "is `next` a valid spec?".
 */
export function validateEdit(next: QvizSpec): EditResult {
	const r = validate(next);
	if (!r.ok) {
		const summary = r.issues.map(i => `${i.path}: ${i.message}`).join('; ');
		return { ok: false, error: summary };
	}
	return { ok: true, spec: r.value };
}


/**
 * Serialize a spec to UTF-8 bytes. 2-space indent matches the example
 * specs in src/qviz/examples/. Trailing newline so editors don't show a
 * "no newline at end of file" gutter mark.
 */
export function serializeSpec(spec: QvizSpec): Uint8Array {
	const text = JSON.stringify(spec, null, 2) + '\n';
	return new TextEncoder().encode(text);
}

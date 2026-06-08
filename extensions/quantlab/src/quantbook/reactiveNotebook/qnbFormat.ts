/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-N (N-0) -- the `.qnb` reactive-notebook on-disk format.
//
// A `.qnb` is a JSON document `{ qnbVersion, workbookPath?, cells[] }`. This module is the vscode-free
// parse/stringify core (unit-tested in plain mocha); the thin `vscode.NotebookSerializer` wrapper maps
// it to/from `NotebookData`. No-Fallbacks: malformed JSON, an unknown version, or a bad cell shape
// THROWS -- a `.qnb` we cannot understand is a loud error, never a silently-empty notebook.

export type QnbCellKind = 'code' | 'markdown';

export interface QnbCell {
	readonly kind: QnbCellKind;
	readonly source: string;
}

export interface QnbDoc {
	readonly qnbVersion: number;
	/** Absolute fs path of the `.qbook` workbook this notebook is bound to (set by "Open Reactive
	 *  Notebook" in N-2). Optional: a notebook opened standalone has none until bound. */
	workbookPath?: string;
	readonly cells: QnbCell[];
}

export const QNB_VERSION = 1;

/** Parse `.qnb` text into a QnbDoc. An empty/whitespace file is a valid EMPTY notebook (VS Code
 *  creates a 0-byte file on "New File"); anything else must be a well-formed v1 document or it throws. */
export function parseQnb(text: string): QnbDoc {
	const trimmed = text.trim();
	if (trimmed === '') {
		return { qnbVersion: QNB_VERSION, cells: [] };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(trimmed);
	} catch (e) {
		throw new Error(`[qnb_parse] not valid JSON: ${(e as Error).message}`);
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error('[qnb_parse] top-level value must be a JSON object');
	}
	const obj = raw as Record<string, unknown>;
	if (obj.qnbVersion !== QNB_VERSION) {
		throw new Error(`[qnb_parse] unsupported qnbVersion ${JSON.stringify(obj.qnbVersion)} (expected ${QNB_VERSION})`);
	}
	if (!Array.isArray(obj.cells)) {
		throw new Error('[qnb_parse] "cells" must be an array');
	}
	const cells: QnbCell[] = obj.cells.map((c: unknown, i: number): QnbCell => {
		if (typeof c !== 'object' || c === null) {
			throw new Error(`[qnb_parse] cell ${i} must be an object`);
		}
		const cc = c as Record<string, unknown>;
		if (cc.kind !== 'code' && cc.kind !== 'markdown') {
			throw new Error(`[qnb_parse] cell ${i} kind must be "code" or "markdown", got ${JSON.stringify(cc.kind)}`);
		}
		if (typeof cc.source !== 'string') {
			throw new Error(`[qnb_parse] cell ${i} source must be a string`);
		}
		return { kind: cc.kind, source: cc.source };
	});
	const doc: QnbDoc = { qnbVersion: QNB_VERSION, cells };
	if (obj.workbookPath !== undefined) {
		if (typeof obj.workbookPath !== 'string') {
			throw new Error('[qnb_parse] workbookPath must be a string when present');
		}
		doc.workbookPath = obj.workbookPath;
	}
	return doc;
}

/** Serialize a QnbDoc to canonical `.qnb` text (2-space JSON, trailing newline). */
export function stringifyQnb(doc: QnbDoc): string {
	const out: Record<string, unknown> = { qnbVersion: QNB_VERSION };
	if (doc.workbookPath !== undefined) {
		out.workbookPath = doc.workbookPath;
	}
	out.cells = doc.cells.map((c) => ({ kind: c.kind, source: c.source }));
	return `${JSON.stringify(out, null, 2)}\n`;
}

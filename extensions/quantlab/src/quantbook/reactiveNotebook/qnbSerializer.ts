/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-N (N-0) -- the `vscode.NotebookSerializer` for the `quantlab-reactive-notebook` type.
//
// Thin bridge between `NotebookData` and the vscode-free `.qnb` format (qnbFormat.ts). Code cells map
// to language `python`; markdown cells to `markdown`. The bound workbook path round-trips through the
// notebook's top-level metadata so "Open Reactive Notebook" (N-2) can rebind on reopen. Outputs are
// transient (the kernel re-runs), so we never persist them.

import * as vscode from 'vscode';

import { parseQnb, QnbCell, QnbDoc, QNB_VERSION, stringifyQnb } from './qnbFormat';

/** Notebook-document metadata key carrying the bound `.qbook` workbook path. */
export const QNB_WORKBOOK_PATH_META = 'quantlab.workbookPath';

export const QNB_NOTEBOOK_TYPE = 'quantlab-reactive-notebook';

export class QnbSerializer implements vscode.NotebookSerializer {
	deserializeNotebook(content: Uint8Array, _token: vscode.CancellationToken): vscode.NotebookData {
		// fatal:true so invalid UTF-8 throws a loud deserialize error rather than decoding to U+FFFD
		// replacement chars and slipping through parseQnb as a "valid" string (Codex N-0 MED).
		const text = new TextDecoder('utf-8', { fatal: true }).decode(content);
		const doc = parseQnb(text);
		const cells = doc.cells.map((c): vscode.NotebookCellData => {
			const kind = c.kind === 'code' ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup;
			const languageId = c.kind === 'code' ? 'python' : 'markdown';
			return new vscode.NotebookCellData(kind, c.source, languageId);
		});
		const data = new vscode.NotebookData(cells);
		if (doc.workbookPath !== undefined) {
			data.metadata = { [QNB_WORKBOOK_PATH_META]: doc.workbookPath };
		}
		return data;
	}

	serializeNotebook(data: vscode.NotebookData, _token: vscode.CancellationToken): Uint8Array {
		const cells: QnbCell[] = data.cells.map((c): QnbCell => ({
			kind: c.kind === vscode.NotebookCellKind.Code ? 'code' : 'markdown',
			source: c.value,
		}));
		const doc: QnbDoc = { qnbVersion: QNB_VERSION, cells };
		// Only the workbook path round-trips from notebook metadata; if the key is PRESENT but not a
		// string it is corrupt -- throw, mirroring parseQnb's strictness (Codex N-0 MED: do not silently
		// drop it). Other notebook/cell metadata + outputs are intentionally not persisted (transient).
		const meta = data.metadata;
		if (meta !== undefined && Object.prototype.hasOwnProperty.call(meta, QNB_WORKBOOK_PATH_META)) {
			const wb = meta[QNB_WORKBOOK_PATH_META];
			if (typeof wb !== 'string') {
				throw new Error(`[qnb_serialize] ${QNB_WORKBOOK_PATH_META} metadata must be a string, got ${typeof wb}`);
			}
			doc.workbookPath = wb;
		}
		return new TextEncoder().encode(stringifyQnb(doc));
	}
}

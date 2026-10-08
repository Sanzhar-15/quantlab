/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createScanner, findNodeAtLocation, JSONPath, parseTree, SyntaxKind } from '../../../base/common/json.js';
import { setProperty, withFormatting } from '../../../base/common/jsonEdit.js';
import { Edit, FormattingOptions } from '../../../base/common/jsonFormatter.js';

/**
 * QuantLab F-SYNC-STRIP-1: `setProperty(…, undefined)` removes the only property of an object but leaves the comma that
 * follows it, so `{ "k": 1, }` would become the invalid `{, }`. This removal takes that comma with it. It returns
 * `undefined` when the property is not the only one of its object or has no trailing comma.
 */
function removeOnlyPropertyWithTrailingComma(content: string, path: JSONPath, formattingOptions: FormattingOptions): Edit[] | undefined {
	const key = path[path.length - 1];
	if (typeof key !== 'string') {
		return undefined;
	}
	const parent = findNodeAtLocation(parseTree(content), path.slice(0, -1));
	if (parent?.type !== 'object' || parent.children?.length !== 1 || parent.children[0].children?.[0].value !== key) {
		return undefined;
	}
	const property = parent.children[0];
	const scanner = createScanner(content, true);
	scanner.setPosition(property.offset + property.length);
	if (scanner.scan() !== SyntaxKind.CommaToken) {
		return undefined;
	}
	const begin = parent.offset + 1;
	return withFormatting(content, { offset: begin, length: scanner.getTokenOffset() + 1 - begin, content: '' }, formattingOptions);
}

export function edit(content: string, originalPath: JSONPath, value: unknown, formattingOptions: FormattingOptions): string {
	const onlyPropertyRemoval = value === undefined ? removeOnlyPropertyWithTrailingComma(content, originalPath, formattingOptions) : undefined;
	const edit = onlyPropertyRemoval ? onlyPropertyRemoval[0] : setProperty(content, originalPath, value, formattingOptions)[0];
	if (edit) {
		content = content.substring(0, edit.offset) + edit.content + content.substring(edit.offset + edit.length);
	}
	return content;
}

export function getLineStartOffset(content: string, eol: string, atOffset: number): number {
	let lineStartingOffset = atOffset;
	while (lineStartingOffset >= 0) {
		if (content.charAt(lineStartingOffset) === eol.charAt(eol.length - 1)) {
			if (eol.length === 1) {
				return lineStartingOffset + 1;
			}
		}
		lineStartingOffset--;
		if (eol.length === 2) {
			if (lineStartingOffset >= 0 && content.charAt(lineStartingOffset) === eol.charAt(0)) {
				return lineStartingOffset + 2;
			}
		}
	}
	return 0;
}

export function getLineEndOffset(content: string, eol: string, atOffset: number): number {
	let lineEndOffset = atOffset;
	while (lineEndOffset >= 0) {
		if (content.charAt(lineEndOffset) === eol.charAt(eol.length - 1)) {
			if (eol.length === 1) {
				return lineEndOffset;
			}
		}
		lineEndOffset++;
		if (eol.length === 2) {
			if (lineEndOffset >= 0 && content.charAt(lineEndOffset) === eol.charAt(1)) {
				return lineEndOffset;
			}
		}
	}
	return content.length - 1;
}

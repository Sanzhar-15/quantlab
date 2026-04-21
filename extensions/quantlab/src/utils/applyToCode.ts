/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

interface ParsedArg {
	name?: string;
	value: string;
}

interface ParsedCall {
	start: number;
	end: number;
	argsText: string;
	args: ParsedArg[];
}

export async function applyParameterOverrides(
	document: vscode.TextDocument,
	overrides: Record<string, unknown>
): Promise<boolean> {
	const text = document.getText();
	const edits: Array<{ start: number; end: number; newText: string }> = [];
	const calls = findParamCalls(text);

	for (const call of calls) {
		const id = extractParamId(call.args);
		if (!id || !(id in overrides)) {
			continue;
		}

		const updatedArgs = updateDefaultArg(call.args, overrides[id]);
		const newText = `ql.param(${updatedArgs})`;
		if (newText !== text.slice(call.start, call.end)) {
			edits.push({ start: call.start, end: call.end, newText });
		}
	}

	if (!edits.length) {
		return false;
	}

	const workspaceEdit = new vscode.WorkspaceEdit();
	for (const edit of edits) {
		workspaceEdit.replace(document.uri, new vscode.Range(
			document.positionAt(edit.start),
			document.positionAt(edit.end)
		), edit.newText);
	}

	return vscode.workspace.applyEdit(workspaceEdit);
}

function extractParamId(args: ParsedArg[]): string | undefined {
	for (const arg of args) {
		if (arg.name === 'id') {
			return stripQuotes(arg.value.trim());
		}
	}

	const positional = args.filter(arg => !arg.name);
	if (!positional.length) {
		return undefined;
	}

	return stripQuotes(positional[0].value.trim());
}

function updateDefaultArg(args: ParsedArg[], value: unknown): string {
	const formatted = formatValue(value);
	let updated = false;

	const nextArgs = args.map(arg => {
		if (arg.name === 'default') {
			updated = true;
			return { ...arg, value: formatted };
		}
		return arg;
	});

	if (!updated) {
		const positionalIndexes = nextArgs.map((arg, index) => (!arg.name ? index : -1)).filter(index => index >= 0);
		if (positionalIndexes.length >= 2) {
			const index = positionalIndexes[1];
			nextArgs[index] = { ...nextArgs[index], value: formatted };
		} else {
			nextArgs.push({ name: 'default', value: formatted });
		}
	}

	return nextArgs.map(arg => (arg.name ? `${arg.name}=${arg.value}` : arg.value)).join(', ');
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) {
		return 'None';
	}
	if (typeof value === 'boolean') {
		return value ? 'True' : 'False';
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return String(value);
	}
	if (typeof value === 'string') {
		return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
	}
	if (Array.isArray(value)) {
		return `[${value.map(item => formatValue(item)).join(', ')}]`;
	}
	return `'${String(value)}'`;
}

function stripQuotes(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

function findParamCalls(text: string): ParsedCall[] {
	const calls: ParsedCall[] = [];
	const needle = 'ql.param';
	let index = 0;

	while (index < text.length) {
		const start = text.indexOf(needle, index);
		if (start === -1) {
			break;
		}

		const openParen = text.indexOf('(', start + needle.length);
		if (openParen === -1) {
			break;
		}

		const closeParen = findMatchingParen(text, openParen);
		if (closeParen === -1) {
			index = openParen + 1;
			continue;
		}

		const argsText = text.slice(openParen + 1, closeParen);
		calls.push({
			start,
			end: closeParen + 1,
			argsText,
			args: parseArgs(argsText)
		});

		index = closeParen + 1;
	}

	return calls;
}

function parseArgs(argsText: string): ParsedArg[] {
	const parts = splitArgs(argsText);
	return parts.map(raw => {
		const trimmed = raw.trim();
		const equalsIndex = findTopLevelEquals(trimmed);
		if (equalsIndex === -1) {
			return { value: trimmed };
		}

		const name = trimmed.slice(0, equalsIndex).trim();
		const value = trimmed.slice(equalsIndex + 1).trim();
		return { name, value };
	});
}

function splitArgs(argsText: string): string[] {
	const args: string[] = [];
	let current = '';
	let depth = 0;
	let inString = false;
	let stringChar = '';

	for (let i = 0; i < argsText.length; i++) {
		const char = argsText[i];

		if (inString) {
			current += char;
			if (char === '\\') {
				if (i + 1 < argsText.length) {
					current += argsText[i + 1];
					i++;
				}
				continue;
			}
			if (char === stringChar) {
				inString = false;
				stringChar = '';
			}
			continue;
		}

		if (char === '"' || char === "'") {
			inString = true;
			stringChar = char;
			current += char;
			continue;
		}

		if (char === '(' || char === '[' || char === '{') {
			depth += 1;
			current += char;
			continue;
		}

		if (char === ')' || char === ']' || char === '}') {
			depth = Math.max(0, depth - 1);
			current += char;
			continue;
		}

		if (char === ',' && depth === 0) {
			args.push(current);
			current = '';
			continue;
		}

		current += char;
	}

	if (current.trim()) {
		args.push(current);
	}

	return args;
}

function findTopLevelEquals(text: string): number {
	let depth = 0;
	let inString = false;
	let stringChar = '';

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (char === '\\') {
				i += 1;
				continue;
			}
			if (char === stringChar) {
				inString = false;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			inString = true;
			stringChar = char;
			continue;
		}

		if (char === '(' || char === '[' || char === '{') {
			depth += 1;
			continue;
		}

		if (char === ')' || char === ']' || char === '}') {
			depth = Math.max(0, depth - 1);
			continue;
		}

		if (char === '=' && depth === 0) {
			return i;
		}
	}

	return -1;
}

function findMatchingParen(text: string, openIndex: number): number {
	let depth = 0;
	let inString = false;
	let stringChar = '';

	for (let i = openIndex; i < text.length; i++) {
		const char = text[i];

		if (inString) {
			if (char === '\\') {
				i += 1;
				continue;
			}
			if (char === stringChar) {
				inString = false;
			}
			continue;
		}

		if (char === '"' || char === "'") {
			inString = true;
			stringChar = char;
			continue;
		}

		if (char === '(') {
			depth += 1;
		} else if (char === ')') {
			depth -= 1;
			if (depth === 0) {
				return i;
			}
		}
	}

	return -1;
}

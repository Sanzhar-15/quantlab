/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ParameterDefinition } from '../../types/strategy';

export interface ParameterExtractionResult {
	parameters: ParameterDefinition[];
	warnings: string[];
	hasErrors: boolean;
}

interface ParsedArg {
	raw: string;
	name?: string;
	value: string;
}

interface ParsedCall {
	start: number;
	end: number;
	argsText: string;
	args: ParsedArg[];
}

const MAX_CACHE_SIZE = 256;

export class ParameterExtractor {
	private static instance: ParameterExtractor | undefined;
	private readonly cache = new Map<string, { version: number; result: ParameterExtractionResult }>();

	static getInstance(): ParameterExtractor {
		if (!ParameterExtractor.instance) {
			ParameterExtractor.instance = new ParameterExtractor();
		}
		return ParameterExtractor.instance;
	}

	extract(doc: vscode.TextDocument): ParameterExtractionResult {
		const key = doc.uri.toString();
		const cached = this.cache.get(key);
		if (cached && cached.version === doc.version) {
			return cached.result;
		}

		const result = this.extractFromText(doc.getText());
		if (this.cache.size >= MAX_CACHE_SIZE) {
			// Evict oldest entry (Map preserves insertion order)
			this.cache.delete(this.cache.keys().next().value!);
		}
		this.cache.set(key, { version: doc.version, result });
		return result;
	}

	dispose(): void {
		this.cache.clear();
	}

	static resetInstance(): void {
		if (ParameterExtractor.instance) {
			ParameterExtractor.instance.dispose();
			ParameterExtractor.instance = undefined;
		}
	}

	extractFromText(text: string): ParameterExtractionResult {
		const warnings: string[] = [];
		const parameters: ParameterDefinition[] = [];
		const seen = new Set<string>();
		let hasErrors = false;

		const calls = this.findParamCalls(text);
		for (const call of calls) {
			const parsed = this.parseParamCall(call, warnings);
			if (!parsed) {
				hasErrors = true;
				continue;
			}

			if (seen.has(parsed.id)) {
				warnings.push(`Duplicate parameter id "${parsed.id}"`);
				hasErrors = true;
				continue;
			}

			seen.add(parsed.id);
			parameters.push(parsed);
		}

		return { parameters, warnings, hasErrors };
	}

	private parseParamCall(call: ParsedCall, warnings: string[]): ParameterDefinition | undefined {
		const positional: string[] = [];
		const named = new Map<string, string>();

		for (const arg of call.args) {
			if (arg.name) {
				named.set(arg.name, arg.value);
			} else if (arg.value.trim()) {
				positional.push(arg.value);
			}
		}

		const idValue = named.get('id') ?? positional[0];
		const id = typeof idValue === 'string' ? this.parseValue(idValue) : undefined;
		if (typeof id !== 'string' || !id.trim()) {
			warnings.push('Unable to parse ql.param id');
			return undefined;
		}

		const defaultValue = named.get('default') ?? positional[1] ?? '';
		const parsedDefault = this.parseValue(defaultValue);

		const definition: ParameterDefinition = {
			id: id.trim(),
			default: parsedDefault ?? null
		};

		const min = this.parseNumber(named.get('min'));
		if (min !== undefined) {
			definition.min = min;
		}

		const max = this.parseNumber(named.get('max'));
		if (max !== undefined) {
			definition.max = max;
		}

		const step = this.parseNumber(named.get('step'));
		if (step !== undefined) {
			definition.step = step;
		}

		const choices = named.get('choices');
		if (choices) {
			const parsed = this.parseValue(choices);
			if (Array.isArray(parsed)) {
				definition.choices = parsed;
			}
		}

		const name = this.parseString(named.get('name'));
		if (name) {
			definition.name = name;
		}

		const group = this.parseString(named.get('group'));
		if (group) {
			definition.group = group;
		}

		const description = this.parseString(named.get('description'));
		if (description) {
			definition.description = description;
		}

		const format = this.parseString(named.get('format'));
		if (format === 'percent' || format === 'currency' || format === 'number') {
			definition.format = format;
		}

		return definition;
	}

	private parseNumber(value?: string): number | undefined {
		if (!value) {
			return undefined;
		}
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private parseString(value?: string): string | undefined {
		if (!value) {
			return undefined;
		}
		const parsed = this.parseValue(value);
		return typeof parsed === 'string' ? parsed : undefined;
	}

	private parseValue(value: string): unknown {
		const trimmed = value.trim();
		if (!trimmed) {
			return undefined;
		}

		if (trimmed === 'True') {
			return true;
		}
		if (trimmed === 'False') {
			return false;
		}
		if (trimmed === 'None' || trimmed === 'null') {
			return null;
		}

		const numeric = Number(trimmed);
		if (!Number.isNaN(numeric) && /^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
			return numeric;
		}

		if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
			return this.unquote(trimmed);
		}

		if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
			const inner = trimmed.slice(1, -1);
			const parts = this.splitArgs(inner);
			return parts.map(part => this.parseValue(part));
		}

		return trimmed;
	}

	private unquote(value: string): string {
		const quote = value[0];
		const inner = value.slice(1, -1);
		return inner.replace(new RegExp(`\\\\${quote}`, 'g'), quote).replace(/\\\\/g, '\\');
	}

	private findParamCalls(text: string): ParsedCall[] {
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

			const closeParen = this.findMatchingParen(text, openParen);
			if (closeParen === -1) {
				index = openParen + 1;
				continue;
			}

			const argsText = text.slice(openParen + 1, closeParen);
			const args = this.parseArgs(argsText);
			calls.push({
				start,
				end: closeParen + 1,
				argsText,
				args
			});

			index = closeParen + 1;
		}

		return calls;
	}

	private parseArgs(argsText: string): ParsedArg[] {
		const parts = this.splitArgs(argsText);
		return parts.map(raw => {
			const trimmed = raw.trim();
			if (!trimmed) {
				return { raw, value: '' };
			}

			const equalsIndex = this.findTopLevelEquals(trimmed);
			if (equalsIndex === -1) {
				return { raw, value: trimmed };
			}

			const name = trimmed.slice(0, equalsIndex).trim();
			const value = trimmed.slice(equalsIndex + 1).trim();
			return { raw, name, value };
		});
	}

	private splitArgs(argsText: string): string[] {
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

	private findTopLevelEquals(text: string): number {
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

	private findMatchingParen(text: string, openIndex: number): number {
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
}

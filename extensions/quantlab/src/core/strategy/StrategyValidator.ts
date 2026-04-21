/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { StrategyEntrypoint, StrategyValidationResult } from '../../types/strategy';

const UTILITY_MODULE_CODE = 'UTILITY_MODULE';
const NOT_PYTHON_CODE = 'NOT_PYTHON';

export class StrategyValidator {
	private static instance: StrategyValidator | undefined;

	private readonly results = new Map<string, { result: StrategyValidationResult; timestamp: number; version?: number }>();
	private readonly _onDidValidate = new vscode.EventEmitter<{ uri: vscode.Uri; result: StrategyValidationResult }>();
	readonly onDidValidate = this._onDidValidate.event;

	private readonly cacheTtlMs = 2 * 60 * 1000;
	private readonly MAX_CACHE_SIZE = 256;
	private readonly VECTOR_PATTERN = /def\s+strategy\s*\(\s*data\s*\)/;
	private readonly EVENT_PATTERN = /def\s+on_bar\s*\(\s*ctx\s*\)/;
	private readonly CLASS_PATTERN = /class\s+(\w+)\s*\(\s*ql\.Strategy\s*\)/;

	private constructor() { }

	static getInstance(): StrategyValidator {
		if (!StrategyValidator.instance) {
			StrategyValidator.instance = new StrategyValidator();
		}
		return StrategyValidator.instance;
	}

	dispose(): void {
		this._onDidValidate.dispose();
		this.results.clear();
	}

	static resetInstance(): void {
		if (StrategyValidator.instance) {
			StrategyValidator.instance.dispose();
			StrategyValidator.instance = undefined;
		}
	}

	isStrategyFile(doc: vscode.TextDocument): boolean {
		if (!this.isPythonDocument(doc)) {
			return false;
		}

		return this.detectEntrypoint(doc) !== null;
	}

	validateDocument(doc: vscode.TextDocument): StrategyValidationResult {
		const result = this.validateStrategy(doc);
		const version = typeof doc.version === 'number' ? doc.version : undefined;
		this.results.set(doc.uri.toString(), {
			result,
			timestamp: Date.now(),
			version
		});
		// Evict oldest entry if over cap
		if (this.results.size > this.MAX_CACHE_SIZE) {
			const oldest = Array.from(this.results.entries())
				.reduce((a, b) => a[1].timestamp < b[1].timestamp ? a : b);
			this.results.delete(oldest[0]);
		}
		this._onDidValidate.fire({ uri: doc.uri, result });
		return result;
	}

	getValidationResult(target: vscode.TextDocument | vscode.Uri): StrategyValidationResult | undefined {
		const uri = target instanceof vscode.Uri ? target : target.uri;
		const entry = this.results.get(uri.toString());
		if (!entry) {
			return undefined;
		}

		if (Date.now() - entry.timestamp > this.cacheTtlMs) {
			this.results.delete(uri.toString());
			return undefined;
		}

		if (!(target instanceof vscode.Uri)) {
			const version = typeof target.version === 'number' ? target.version : undefined;
			if (entry.version !== undefined && version !== undefined && entry.version !== version) {
				this.results.delete(uri.toString());
				return undefined;
			}
		}

		return entry.result;
	}

	invalidate(uri: vscode.Uri): void {
		this.results.delete(uri.toString());
	}

	detectEntrypoint(doc: vscode.TextDocument): StrategyEntrypoint | null {
		return this.detectEntrypointFromText(doc.getText());
	}

	detectEntrypointFromText(text: string): StrategyEntrypoint | null {
		if (this.VECTOR_PATTERN.test(text)) {
			return { type: 'vectorized', functionName: 'strategy' };
		}

		if (this.EVENT_PATTERN.test(text)) {
			return { type: 'eventDriven', functionName: 'on_bar' };
		}

		const classMatch = text.match(this.CLASS_PATTERN);
		if (classMatch) {
			return { type: 'classBased', className: classMatch[1] };
		}

		return null;
	}

	private validateStrategy(doc: vscode.TextDocument): StrategyValidationResult {
		const entrypoint = this.isPythonDocument(doc) ? this.detectEntrypoint(doc) : null;
		if (!entrypoint) {
			const isPython = this.isPythonDocument(doc);
			const helpfulMessage = isPython
				? this.getHelpfulErrorMessage(doc.getText())
				: 'Not a Python file. Strategy files must use .py extension.';

			return {
				isValid: false,
				entrypoint: null,
				complexity: 'viewOnly',
				parameters: [],
				hasVisualizationCode: false,
				errors: [{
					line: 0,
					message: helpfulMessage,
					code: isPython ? UTILITY_MODULE_CODE : NOT_PYTHON_CODE
				}],
				warnings: []
			};
		}

		return {
			isValid: true,
			entrypoint,
			complexity: 'safe',
			parameters: [],
			hasVisualizationCode: false,
			errors: [],
			warnings: []
		};
	}

	private getHelpfulErrorMessage(text: string): string {
		// Detect class without ql.Strategy parent
		if (/class\s+\w+\s*:/.test(text) && !this.CLASS_PATTERN.test(text)) {
			return 'Class-based strategies must inherit from ql.Strategy.\nExample: class MyStrategy(ql.Strategy):';
		}

		// Detect wrong function names
		if (/def\s+(run|execute|main|trade)\s*\(/.test(text)) {
			return 'Invalid entry point function name.\nUse: def strategy(data), def on_bar(ctx), or class X(ql.Strategy)';
		}

		// Detect type-annotated strategy function
		if (/def\s+strategy\s*\(\s*data\s*:/.test(text)) {
			return 'Strategy function signature must be exactly: def strategy(data)\nRemove type annotations from the function signature.';
		}

		// Detect wrong parameter name in on_bar
		if (/def\s+on_bar\s*\(\s*(?:context|self)\s*\)/.test(text)) {
			return 'Event-driven function signature must be exactly: def on_bar(ctx)\nUse "ctx" as the parameter name, not "context" or "self".';
		}

		// Detect wrong visualize signature
		if (/def\s+visualize\s*\(\s*chart\s*\)/.test(text)) {
			return 'Visualize function signature must be: def visualize(chart, data, params)\nAll three parameters are required.';
		}

		// Generic fallback
		return 'No valid strategy entrypoint found.\nRequired: def strategy(data), def on_bar(ctx), or class X(ql.Strategy):';
	}

	private isPythonDocument(doc: vscode.TextDocument): boolean {
		if (doc.isUntitled) {
			return true;
		}

		const fileName = doc.fileName.toLowerCase();
		return doc.languageId === 'python' || fileName.endsWith('.py');
	}
}

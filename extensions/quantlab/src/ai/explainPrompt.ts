/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  AI "Explain cell" prompt (R20)
 *  Pure, vscode-free builders for the Explain-with-AI request. Kept side-effect-free so the
 *  prompt is unit-tested headlessly and the egress is auditable.
 *
 *  PRIVACY (honesty -- see the w99 local-first modal): this sends ONLY the formula (strategy_code),
 *  the cell's A1 address, and the error message when the cell is in an error state (error_messages) --
 *  both implicit-consent categories. It does NOT send raw cell data values (data_samples, an
 *  explicit-consent category) -- deferred to v1.5 -- and does NOT send the sheet NAME (workbook
 *  metadata that can be sensitive); the A1 address alone locates the cell for the explanation.
 *---------------------------------------------------------------------------------------------*/

import type { ChatMessage } from './types';

/** The minimal cell context the Explain feature sends to the model (NO sheet name, NO data value). */
export interface ExplainCellInput {
	/** A1 address of the cell (e.g. "B7"). */
	readonly a1: string;
	/** Raw formula source (with or without a leading '='). */
	readonly formula: string;
	/** The engine error string when the cell is in an error state (e.g. "#DIV/0!"). */
	readonly error?: string;
}

/**
 * The engine error string for a cell value IFF the cell is in an error state. Pure helper so the
 * privacy-sensitive derivation (read `.error` ONLY when kind === 'error', never a normal value) is
 * unit-tested. Returns undefined for number/text/boolean/blank/pending values.
 */
export function cellErrorString(value: { kind: string; error?: string } | undefined | null): string | undefined {
	return value && value.kind === 'error' && typeof value.error === 'string' && value.error.length > 0
		? value.error
		: undefined;
}

/** Shown when the user asks to explain a cell that has no formula (a literal / empty cell). */
export const NO_FORMULA_MESSAGE = 'Select a cell that contains a formula to explain it with AI.';

/**
 * The system prompt. Asks for a direct, plain-text explanation -- "final answer only" so the
 * model does not leak reasoning into the visible response on a thinking-capable model.
 */
export function buildExplainSystemPrompt(): string {
	return [
		'You are a spreadsheet formula expert embedded in Quantbook, a quantitative-finance spreadsheet.',
		'Explain the given cell formula clearly and concisely for the person who wrote it.',
		'Respond directly with the explanation only -- no preamble, no restating the request, no sign-off.',
		'Cover what the formula computes, the role of each function and reference it uses, and any notable',
		'behavior or pitfalls. If an error is provided, explain its likely cause and how to fix it.',
		'Use plain prose (no markdown headings). Keep it focused: a short paragraph or a few short lines.',
		'Do not invent data values you were not given.',
	].join('\n');
}

/** Normalize a raw formula for display, ensuring a single leading '='. */
export function normalizeFormula(formula: string): string {
	const trimmed = formula.trim();
	return trimmed.startsWith('=') ? trimmed : `=${trimmed}`;
}

/**
 * Build the chat messages for an Explain request. Returns a single user message carrying only the
 * A1 address + formula (+ error) -- no sheet name, no data value. Pair with
 * {@link buildExplainSystemPrompt}.
 */
export function buildExplainMessages(input: ExplainCellInput): ChatMessage[] {
	const lines = [
		'Explain this Quantbook cell formula.',
		`Cell: ${input.a1}`,
		`Formula: ${normalizeFormula(input.formula)}`,
	];
	if (input.error && input.error.trim().length > 0) {
		lines.push(`Current error: ${input.error.trim()}`);
	}
	return [
		{
			role: 'user',
			content: lines.join('\n'),
			timestamp: new Date(),
			id: `explain-${input.a1}`,
		},
	];
}

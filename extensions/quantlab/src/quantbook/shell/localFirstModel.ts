/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave J-a (R16, 2026-06-20) -- the vscode-free core of the "local-first" messaging surface.
//
// Quantbook's pitch is that your workbook stays on your machine: the cell engine, the reactive Python
// kernel, and SQL all run locally in the built-in napi engine, and Quantbook does not upload the workbook.
// This module builds the user-facing statement that says so -- HONESTLY. The wider Quantlab app is NOT
// offline, and a privacy promise that hid that would be a lie (No-Fallbacks). A pre-commit megaudit
// (Codex + Opus + Sonnet) enumerated the real network surface, so the copy deliberately:
//   - makes only the TRUE, narrow guarantee (the WORKBOOK computes locally and is not uploaded), and
//   - does NOT claim an exhaustive "only things that use the network" list or a hard "never sends" -- both
//     are falsifiable against the app's reality. Instead it NAMES the real egress: the AI path to Anthropic
//     (off by default, consent-gated, best-effort redaction -- not an enforced guarantee), the Quantlab /
//     Delta Plus cloud services (sign-in, market data, news, watchlists, resources, and server-side tools
//     that can upload the file they operate on), and configured broker integrations (e.g. Alpaca).
//
// The data categories come from the engine's real consent policy ({@link ConsentCategory} /
// {@link BlockedCategory} in `src/ai/types.ts`) via exhaustive `Record`s, so a category added to either
// union breaks the build here until the copy is updated. PURE + vscode-free (the
// {@link registerLocalFirstStatus} shell renders these strings), so the statement is unit-tested headlessly.

import type { BlockedCategory, ConsentCategory } from '../../ai/types';

/** Short headline shown as the modal's title (the {@link buildLocalFirstDetail} body is the detail). */
export const LOCAL_FIRST_HEADLINE = 'Quantbook is local-first';

/**
 * Human labels for each data category the AI path MAY send after you consent. An exhaustive
 * `Record<ConsentCategory, string>`: if `src/ai/types.ts` adds a `ConsentCategory`, this object fails to
 * type-check until the new category is labelled here -- the statement can never under-state what is sent.
 */
const CONSENT_LABELS: Record<ConsentCategory, string> = {
	strategy_code: 'your formula and strategy code',
	error_messages: 'error messages',
	data_samples: 'small samples of your data',
	performance_metrics: 'backtest performance metrics',
};

/**
 * Human labels for the categories the AI path is policy-bound NOT to send. Exhaustive
 * `Record<BlockedCategory, string>` (same compile-time drift guard). NOTE: redaction is best-effort regex,
 * not an enforced classifier, so the copy frames these as "does not intentionally send", never an absolute.
 */
const BLOCKED_LABELS: Record<BlockedCategory, string> = {
	broker_credentials: 'broker credentials',
	trading_history: 'trading history',
	personal_data: 'personal data',
	api_keys: 'API keys',
};

/** The ordered consent-category labels (network data sent only after opt-in + consent). */
export const CONSENT_CATEGORY_LABELS: readonly string[] = Object.values(CONSENT_LABELS);
/** The ordered blocked-category labels (not intentionally sent; best-effort redaction). */
export const BLOCKED_CATEGORY_LABELS: readonly string[] = Object.values(BLOCKED_LABELS);

/** Join a label list into an English "a, b, c<conj> d" phrase. Pure + total (handles 0/1/2/n). */
function joinList(labels: readonly string[], conjunction: 'and' | 'or'): string {
	if (labels.length === 0) {
		return '';
	}
	if (labels.length === 1) {
		return labels[0];
	}
	if (labels.length === 2) {
		return `${labels[0]} ${conjunction} ${labels[1]}`;
	}
	return `${labels.slice(0, -1).join(', ')}, ${conjunction} ${labels[labels.length - 1]}`;
}

/** The local-first guarantee, scoped to the workbook (the part that is genuinely local + verifiable). */
export const LOCAL_GUARANTEE =
	'Your Quantbook workbook stays on your machine. Cells, formulas, the reactive Python kernel, and SQL all '
	+ 'run locally in the built-in engine, and Quantbook does not upload your workbook.';

/**
 * The full local-first statement body (the modal detail). Pure + total. Leads with the TRUE workbook
 * guarantee, then HONESTLY names the other features that DO reach the network when used -- deliberately NOT
 * an exhaustive "only things" list and NOT a hard "never sends" guarantee (both are falsifiable against the
 * wider app). Returns a `\n`-separated plain-ASCII string.
 */
export function buildLocalFirstDetail(): string {
	const lines = [
		LOCAL_GUARANTEE,
		'',
		'Other features connect to the network when you use them, so they are not covered by that guarantee:',
		`* AI assistance is off by default. When you turn it on and grant consent, it sends `
		+ `${joinList(CONSENT_CATEGORY_LABELS, 'and')} to Anthropic. It does not intentionally send `
		+ `${joinList(BLOCKED_CATEGORY_LABELS, 'or')}, though that redaction is best-effort.`,
		'* Your Quantlab account and its Delta Plus cloud services exchange data while you are signed in: '
		+ 'live market data, news, watchlists, and resources. Running a server-side tool can upload the '
		+ 'data file it operates on.',
		'* Broker integrations you configure, such as Alpaca, send account and order data to that broker.',
	];
	return lines.join('\n');
}

/** The compact status-bar hover for the `$(shield) Local` indicator. Pure. */
export function buildShieldTooltip(): string {
	return 'Quantbook is local-first: your workbook runs on your machine.\n'
		+ 'Click to see what stays local and what uses the network.';
}

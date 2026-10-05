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
//     are falsifiable against the app's reality. Instead it NAMES the real egress: the Quantlab /
//     Delta Plus cloud services (sign-in, market data, news, watchlists, resources, and server-side tools
//     that can upload the file they operate on). The extension's AI panel and its broker integrations are
//     removed from the product, so the statement no longer names them.
//
// PURE + vscode-free (the {@link registerLocalFirstStatus} shell renders these strings), so the
// statement is unit-tested headlessly.


/** Short headline shown as the modal's title (the {@link buildLocalFirstDetail} body is the detail). */
export const LOCAL_FIRST_HEADLINE = 'Quantbook is local-first';

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
		'* Your Quantlab account and its Delta Plus cloud services exchange data while you are signed in: '
		+ 'live market data, news, watchlists, and resources. Running a server-side tool can upload the '
		+ 'data file it operates on.',
	];
	return lines.join('\n');
}

/** The compact status-bar hover for the `$(shield) Local` indicator. Pure. */
export function buildShieldTooltip(): string {
	return 'Quantbook is local-first: your workbook runs on your machine.\n'
		+ 'Click to see what stays local and what uses the network.';
}

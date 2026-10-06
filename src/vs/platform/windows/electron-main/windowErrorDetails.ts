/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (review c1 S5): the `reason` and `code` of a renderer-gone or load-failure log line. The stock lines read
// `details?.exitCode || '<unknown>'`, which logged a valid exit code 0 as unknown. Here an absent value says `absent` and
// every present value, 0 and '' included, is logged as it is. No imports, so `build/qlhost/check-s5-fork.mjs` runs it.

export function formatWindowErrorDetails(details: { reason?: string; exitCode?: number } | undefined): string {
	const reason = details?.reason === undefined ? 'absent' : JSON.stringify(details.reason);
	const code = details?.exitCode === undefined ? 'absent' : String(details.exitCode);

	return `reason: ${reason}, code: ${code}`;
}

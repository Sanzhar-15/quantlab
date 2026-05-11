/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Megaudit-2 A6-MAJOR-3: parse a test-gating env var as a real boolean.
 *
 * `if (!process.env.RUN_X)` was the previous pattern — wrong because
 * all env values are strings: `RUN_X=0` is truthy in JavaScript, so
 * the user setting `=0` to disable a test would actually ENABLE it.
 *
 * Accepts: `'1'`, `'true'`, `'yes'`, `'on'` (case-insensitive). Anything
 * else (unset, empty, `'0'`, `'false'`, `'no'`, `'off'`) → false.
 */
export function isTestFlagEnabled(value: string | undefined): boolean {
	return ['1', 'true', 'yes', 'on'].includes((value ?? '').toLowerCase());
}

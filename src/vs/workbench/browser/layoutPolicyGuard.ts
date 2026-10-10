/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (C1-X1, the customTitleBarVisibility toast): when the activity bar moves to the top (or editor actions, the
// command center or layout controls move into the title bar) the stock layout turns `window.customTitleBarVisibility` from
// `never` to `auto`. The QuantLab chrome policy pins that key to `never` (qlHost/chromePolicy.ts), so the stock write was
// refused and the workbench showed "Unable to write window.customTitleBarVisibility because it is configured in system
// policy". A key the policy pins is not written: the policy's value stands, and the layout says so in its trace.
// No imports, so `build/qlhost/check-layout-policy.mjs` runs it.

export type CustomTitleBarAutoShow = 'write-auto' | 'policy-pinned' | 'nothing';

/**
 * @param current the effective `window.customTitleBarVisibility`
 * @param policyValue `inspect(key).policyValue`: defined exactly when a policy pins the key
 */
export function decideCustomTitleBarAutoShow(current: string | undefined, policyValue: unknown): CustomTitleBarAutoShow {
	if (current !== 'never') {
		return 'nothing';
	}

	return policyValue === undefined ? 'write-auto' : 'policy-pinned';
}

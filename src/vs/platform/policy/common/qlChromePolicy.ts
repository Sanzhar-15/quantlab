/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (U7, CH-2): the policy metadata of the four chrome settings, in ONE place. The renderer registers the four settings
// (`desktop.contribution.ts`: `window.*`, `workbench.contribution.ts`: `workbench.*`) and the main process registers
// `window.titleBarStyle` (`qlHost/chromePolicy.ts`: the window frame is chosen in main, and main's registry does not load the
// workbench contributions), both with the objects below, so the policy name a setting is held under cannot drift between the two.
// The values the policy holds are NOT here: they are the bundled policy file's (`qlHost/ql-chrome-policy.json`), and
// `qlHost/chromePolicy.ts` checks that file against the U6 seed's four values.

import { IPolicy, PolicyCategory, PolicyName } from '../../../base/common/policy.js';
import { localize } from '../../../nls.js';

// The category is required by `IPolicy` and is only read by the policy export tooling (never at run time). None of the five
// categories names window chrome; `Update` is the least misleading and is kept until a `Window` category is added to
// `base/common/policy.ts` (outside U7's write set).

export const QL_POLICY_TITLE_BAR_STYLE: IPolicy = {
	name: 'QlTitleBarStyle',
	category: PolicyCategory.Update,
	minimumVersion: '1.108',
	localization: {
		description: { key: 'qlPolicyTitleBarStyle', value: localize('qlPolicyTitleBarStyle', "The window title bar style, held by the QuantLab host.") }
	}
};

export const QL_POLICY_CUSTOM_TITLE_BAR_VISIBILITY: IPolicy = {
	name: 'QlCustomTitleBarVisibility',
	category: PolicyCategory.Update,
	minimumVersion: '1.108',
	localization: {
		description: { key: 'qlPolicyCustomTitleBarVisibility', value: localize('qlPolicyCustomTitleBarVisibility', "When the custom title bar is shown, held by the QuantLab host.") }
	}
};

export const QL_POLICY_ACTIVITY_BAR_LOCATION: IPolicy = {
	name: 'QlActivityBarLocation',
	category: PolicyCategory.Update,
	minimumVersion: '1.108',
	localization: {
		description: { key: 'qlPolicyActivityBarLocation', value: localize('qlPolicyActivityBarLocation', "The location of the Activity Bar, held by the QuantLab host.") }
	}
};

export const QL_POLICY_SIDE_BAR_LOCATION: IPolicy = {
	name: 'QlSideBarLocation',
	category: PolicyCategory.Update,
	minimumVersion: '1.108',
	localization: {
		description: { key: 'qlPolicySideBarLocation', value: localize('qlPolicySideBarLocation', "The location of the primary side bar, held by the QuantLab host.") }
	}
};

/** The four chrome settings and the policy each is held under, in the order of the U6 seed. */
export const QL_CHROME_POLICIES: ReadonlyArray<{ readonly settingKey: string; readonly policyName: PolicyName }> = [
	{ settingKey: 'window.titleBarStyle', policyName: QL_POLICY_TITLE_BAR_STYLE.name },
	{ settingKey: 'window.customTitleBarVisibility', policyName: QL_POLICY_CUSTOM_TITLE_BAR_VISIBILITY.name },
	{ settingKey: 'workbench.activityBar.location', policyName: QL_POLICY_ACTIVITY_BAR_LOCATION.name },
	{ settingKey: 'workbench.sideBar.location', policyName: QL_POLICY_SIDE_BAR_LOCATION.name }
];

// QuantLab host (c1 M5): `window.dialogStyle` is held at 'native'. A custom (DOM) dialog is drawn inside the workbench view, which
// is hidden while the terminal view is in front, so a save confirmation raised by a quit was invisible and the quit waited on it;
// a native dialog is shown by the OS on top of the host window. The key is policy-only, NOT a seed key: profiles seeded before it
// was added would lack it and the seed would report 'differs' on every launch.
export const QL_POLICY_DIALOG_STYLE: IPolicy = {
	name: 'QlDialogStyle',
	category: PolicyCategory.Update,
	minimumVersion: '1.108',
	localization: {
		description: { key: 'qlPolicyDialogStyle', value: localize('qlPolicyDialogStyle', "The dialog style, held by the QuantLab host.") }
	}
};

/** The settings held by the chrome policy file that are not in the U6 seed, with the value each is held at. */
export const QL_POLICY_ONLY_SETTINGS: ReadonlyArray<{ readonly settingKey: string; readonly policyName: PolicyName; readonly value: string }> = [
	{ settingKey: 'window.dialogStyle', policyName: QL_POLICY_DIALOG_STYLE.name, value: 'native' }
];

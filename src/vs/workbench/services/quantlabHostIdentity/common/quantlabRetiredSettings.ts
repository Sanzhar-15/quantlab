/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

/**
 * QuantLab carry SYNC-1 (ruling Q-LOGIN-5 (a)): tombstones for the demo-account pair that the deleted
 * `contrib/qic/browser/authGate.ts` registered. Nothing reads either key. They stay registered only so
 * that a value left in a user's settings.json is marked deprecated and is kept out of Settings Sync:
 * - `ignoreSync: true` puts the key in the default ignored settings (userDataSync.ts:60-64,
 *   `getIgnoredSettings` over the registry's properties; flag documented at configurationRegistry.ts:183-186).
 * - NOT `included: false`: an excluded key is deleted from the registered properties
 *   (configurationRegistry.ts:706-715), so the sync exclusion above would never see it.
 * - NOT `disallowSyncIgnore`: that flag means the key is ALWAYS synced (configurationRegistry.ts:188-191,
 *   userDataSync.ts:29-32 and settingsMerge.ts `getIgnoredSettings`).
 * - `ignoreSync` alone yields to a user's `-key` entry in `settingsSync.ignoredSettings`; the hard stop is
 *   `NEVER_SYNCED_SETTINGS` in platform/userDataSync/common/settingsMerge.ts.
 * No `default`, on purpose. Remove together with that list after the first user-facing release that includes QuantLab.
 */
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'qic.demo',
	title: localize('quantlabRetiredSettings.title', "Quantlab (retired settings)"),
	properties: {
		'qic.demo.email': {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			ignoreSync: true,
			deprecationMessage: localize('quantlabRetiredSettings.demoEmail', "This setting is no longer used and is never synced. Sign-in happens in the Quantlab terminal view. Remove it from your settings."),
		},
		'qic.demo.password': {
			type: 'string',
			scope: ConfigurationScope.APPLICATION,
			ignoreSync: true,
			deprecationMessage: localize('quantlabRetiredSettings.demoPassword', "This setting is no longer used and is never synced. Sign-in happens in the Quantlab terminal view. Remove it from your settings."),
		},
	}
});

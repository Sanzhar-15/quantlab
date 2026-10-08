/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Extensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { getIgnoredSettings, NEVER_SYNCED_SETTINGS } from '../../../../../platform/userDataSync/common/settingsMerge.js';
import { getDefaultIgnoredSettings } from '../../../../../platform/userDataSync/common/userDataSync.js';
// The production registration of the retired demo keys (a side effect of the import, as in the application).
import '../../common/quantlabRetiredSettings.js';

// QuantLab F-SYNC-STRIP-1 (M2, A3): changing how the Settings editor shows the retired password must not weaken the sync
// exclusion. Both keys stay (1) in the default ignored settings the REAL registry derives and (2) in the hard stop
// NEVER_SYNCED_SETTINGS, and a user's `-key` opt-in brings neither back.
suite('Retired demo settings - sync exclusion (STRIP-1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const keys = ['qic.demo.email', 'qic.demo.password'];
	const optBackIn = keys.map(key => '-' + key);

	test('both keys are registered with ignoreSync, and neither is excluded or disallowSyncIgnore', () => {
		const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);
		for (const key of keys) {
			const property = registry.getConfigurationProperties()[key];
			assert.ok(property, `${key} must stay in the registry's properties`);
			assert.strictEqual(property.ignoreSync, true, `${key} must be ignoreSync`);
			assert.ok(!property.disallowSyncIgnore, `${key} must not be disallowSyncIgnore (that means always synced)`);
			assert.strictEqual(registry.getExcludedConfigurationProperties()[key], undefined, `${key} must not be an excluded property`);
			assert.ok(property.deprecationMessage, `${key} must stay deprecated`);
		}
	});

	test('the default ignored settings the registry derives hold both keys', () => {
		const defaults = getDefaultIgnoredSettings();
		for (const key of keys) {
			assert.ok(defaults.includes(key), `${key} is not in the default ignored settings`);
		}
	});

	test('the hard stop holds both keys', () => {
		for (const key of keys) {
			assert.ok(NEVER_SYNCED_SETTINGS.includes(key), `${key} is not in NEVER_SYNCED_SETTINGS`);
		}
	});

	test('a user -key opt-in in the configuration brings neither key back', () => {
		const ignored = getIgnoredSettings(getDefaultIgnoredSettings(), new TestConfigurationService({ 'settingsSync.ignoredSettings': optBackIn }));
		for (const key of keys) {
			assert.ok(ignored.includes(key), `${key} left the ignored settings`);
		}
	});

	test('a user -key opt-in in the content being uploaded brings neither key back', () => {
		const content = '{\n\t"settingsSync.ignoredSettings": [' + optBackIn.map(entry => '"' + entry + '"').join(', ') + ']\n}';
		const ignored = getIgnoredSettings(getDefaultIgnoredSettings(), new TestConfigurationService(), content);
		for (const key of keys) {
			assert.ok(ignored.includes(key), `${key} left the ignored settings`);
		}
	});

	test('control: an opt-in does bring back an ordinary ignoreSync key (the check can fail)', () => {
		const ignored = getIgnoredSettings(['ordinary.ignoreSync.key'], new TestConfigurationService({ 'settingsSync.ignoredSettings': ['-ordinary.ignoreSync.key'] }));
		assert.ok(!ignored.includes('ordinary.ignoreSync.key'));
	});
});

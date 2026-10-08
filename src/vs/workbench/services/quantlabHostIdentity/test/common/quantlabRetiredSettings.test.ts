/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, getDefaultValue, IConfigurationNode, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { getIgnoredSettings, NEVER_SYNCED_SETTINGS } from '../../../../../platform/userDataSync/common/settingsMerge.js';
import { getDefaultIgnoredSettings, getDisallowedIgnoredSettings } from '../../../../../platform/userDataSync/common/userDataSync.js';
// Importing the tombstone module runs its registration, as the service module's side-effect import does at run time.
import '../../common/quantlabRetiredSettings.js';

// QuantLab carry SYNC-1 (F-SYNC-1, gap G1): the tombstone registration is real at run time, not only as text.
suite('QuantlabRetiredSettings - tombstone registration (SYNC-1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	const tombstoneKeys = ['qic.demo.email', 'qic.demo.password'];

	for (const key of tombstoneKeys) {

		test(`${key} is registered with ignoreSync, no contributed default, not disallowSyncIgnore, not excluded`, () => {
			const registered = registry.getConfigurationProperties()[key];
			assert.ok(registered !== undefined, `${key} is not among the registered configuration properties`);
			assert.ok(registry.getExcludedConfigurationProperties()[key] === undefined, `${key} is among the excluded configuration properties`);
			assert.strictEqual(registered.ignoreSync, true);
			assert.ok(!registered.disallowSyncIgnore, `${key} must not be disallowSyncIgnore`);
			assert.strictEqual(registered.type, 'string');
			assert.strictEqual(registered.scope, ConfigurationScope.APPLICATION);
			assert.ok(!!registered.deprecationMessage, `${key} must carry a deprecation message`);

			// The registry stores the contributed default in `defaultDefaultValue` (undefined when the registration has no `default`)
			// and fills `default` from the type when it is undefined (updatePropertyDefaultValue). So `default` always reports the type's
			// zero value (''), whatever was contributed; `defaultDefaultValue === undefined` is the honest reading of "the tombstone sets no default".
			assert.strictEqual(registered.defaultDefaultValue, undefined, `${key}: the tombstone must not contribute a default`);
			assert.strictEqual(registered.default, getDefaultValue('string'), `${key}: the reported default must be the type's own zero value`);
		});

		test(`the platform's default ignored settings list ${key} from the registry alone (without NEVER_SYNCED_SETTINGS)`, () => {
			// getDefaultIgnoredSettings (userDataSync.ts) builds its list from the registry's `ignoreSync` / scope flags
			// and never reads NEVER_SYNCED_SETTINGS (that list lives in settingsMerge.ts and is applied there), so a hit here is the tombstone's own.
			assert.ok(getDefaultIgnoredSettings().includes(key), `${key} is not in getDefaultIgnoredSettings()`);
			assert.ok(getDefaultIgnoredSettings(true).includes(key), `${key} is not in getDefaultIgnoredSettings(excludeExtensions)`);
			assert.ok(!getDisallowedIgnoredSettings().includes(key), `${key} is in getDisallowedIgnoredSettings()`);
		});
	}

	test('the tombstone keys and NEVER_SYNCED_SETTINGS agree', () => {
		for (const key of NEVER_SYNCED_SETTINGS) {
			assert.ok(registry.getConfigurationProperties()[key] !== undefined, `${key} is in NEVER_SYNCED_SETTINGS but has no tombstone registration`);
			assert.strictEqual(registry.getConfigurationProperties()[key].ignoreSync, true, `${key} is in NEVER_SYNCED_SETTINGS but its tombstone has no ignoreSync`);
		}
		const registeredDemoKeys = Object.keys(registry.getConfigurationProperties()).filter(key => key.startsWith('qic.demo.')).sort();
		assert.deepStrictEqual(registeredDemoKeys, [...NEVER_SYNCED_SETTINGS].sort(), 'the registered qic.demo.* keys and NEVER_SYNCED_SETTINGS differ');
		assert.deepStrictEqual([...NEVER_SYNCED_SETTINGS].sort(), [...tombstoneKeys].sort());
	});

	test('NEVER_SYNCED_SETTINGS stay in the merge-side ignored settings with no defaults and with the user opting both keys back in', () => {
		// Independent of the registry: this is what `.concat(NEVER_SYNCED_SETTINGS)` in settingsMerge.getIgnoredSettings contributes.
		const optBackIn = { 'settingsSync.ignoredSettings': tombstoneKeys.map(key => '-' + key) };
		for (const ignored of [getIgnoredSettings([], new TestConfigurationService()), getIgnoredSettings([], new TestConfigurationService(optBackIn)), getIgnoredSettings(getDefaultIgnoredSettings(), new TestConfigurationService(optBackIn))]) {
			for (const key of NEVER_SYNCED_SETTINGS) {
				assert.ok(ignored.includes(key), `${key} is not in the merge-side ignored settings`);
			}
		}
	});

	test('with the registry alone feeding the ignore list, the merge-side ignored settings still list both keys', () => {
		const ignored = getIgnoredSettings(getDefaultIgnoredSettings(), new TestConfigurationService());
		for (const key of tombstoneKeys) {
			assert.ok(ignored.includes(key), `${key} is not in the merge-side ignored settings`);
		}
	});
});

// The tombstone comment claims `disallowSyncIgnore` "means the key is ALWAYS synced". This suite settles it on throwaway keys.
suite('QuantlabRetiredSettings - disallowSyncIgnore behaviour (SYNC-1)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	const ignoreOnlyKey = 'quantlabRetiredSettingsTest.ignoreOnly';
	const disallowKey = 'quantlabRetiredSettingsTest.disallowSyncIgnore';

	setup(() => {
		const node: IConfigurationNode = {
			id: 'quantlabRetiredSettingsTest',
			title: 'quantlabRetiredSettingsTest',
			properties: {
				[ignoreOnlyKey]: { type: 'string', scope: ConfigurationScope.APPLICATION, ignoreSync: true },
				[disallowKey]: { type: 'string', scope: ConfigurationScope.APPLICATION, ignoreSync: true, disallowSyncIgnore: true },
			}
		};
		registry.registerConfiguration(node);
		disposables.add(toDisposable(() => registry.deregisterConfigurations([node])));
	});

	test('a disallowSyncIgnore key is removed from the merge-side ignored settings, so it is synced', () => {
		const defaults = getDefaultIgnoredSettings();
		// The platform's default list holds both throwaway keys (the disallowed one is added by getDefaultIgnoredSettings itself) ...
		assert.ok(defaults.includes(ignoreOnlyKey));
		assert.ok(defaults.includes(disallowKey));
		assert.deepStrictEqual(getDisallowedIgnoredSettings().filter(key => key.startsWith('quantlabRetiredSettingsTest.')), [disallowKey]);

		// ... but the list the synchroniser really applies (settingsMerge.getIgnoredSettings) drops the disallowSyncIgnore key.
		const applied = getIgnoredSettings(defaults, new TestConfigurationService());
		assert.ok(applied.includes(ignoreOnlyKey), 'an ignoreSync-only key stays ignored');
		assert.ok(!applied.includes(disallowKey), 'a disallowSyncIgnore key must not be in the applied ignored settings');
	});

	test('a user entry cannot put a disallowSyncIgnore key back into the ignored settings', () => {
		const applied = getIgnoredSettings(getDefaultIgnoredSettings(), new TestConfigurationService({ 'settingsSync.ignoredSettings': [disallowKey] }));
		assert.ok(!applied.includes(disallowKey));
	});

	test('a user -key entry opts an ignoreSync-only key back in', () => {
		const applied = getIgnoredSettings(getDefaultIgnoredSettings(), new TestConfigurationService({ 'settingsSync.ignoredSettings': ['-' + ignoreOnlyKey] }));
		assert.ok(!applied.includes(ignoreOnlyKey));
	});
});

// Runs after the suite above (mocha runs suites in order); its teardown has deregistered the throwaway keys.
suite('QuantlabRetiredSettings - throwaway registrations are cleaned up (SYNC-1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('no throwaway key remains registered', () => {
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		const left = Object.keys(registry.getConfigurationProperties()).filter(key => key.startsWith('quantlabRetiredSettingsTest.'));
		assert.deepStrictEqual(left, []);
	});
});

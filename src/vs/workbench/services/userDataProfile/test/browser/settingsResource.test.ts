/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ConfigurationScope } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { updateIgnoredSettings } from '../../../../../platform/userDataSync/common/settingsMerge.js';
import { profileIgnoredSettings } from '../../browser/settingsResource.js';

suite('SettingsResource profile export (SYNC-1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const formattingOptions = { eol: '\n', insertSpaces: false, tabSize: 4 };

	test('the ignored list is the machine-scoped settings plus the never-synced demo keys', () => {
		const ignored = profileIgnoredSettings({
			'a.machine': { scope: ConfigurationScope.MACHINE },
			'a.applicationMachine': { scope: ConfigurationScope.APPLICATION_MACHINE },
			'a.machineOverridable': { scope: ConfigurationScope.MACHINE_OVERRIDABLE },
			'a.application': { scope: ConfigurationScope.APPLICATION },
			'a.window': { scope: ConfigurationScope.WINDOW },
		});
		assert.deepStrictEqual([...ignored].sort(), ['a.applicationMachine', 'a.machine', 'a.machineOverridable', 'qic.demo.email', 'qic.demo.password']);
	});

	test('an export leaves the demo keys out and keeps the rest', () => {
		const local = '{\n\t"qic.demo.email": "user@example.com",\n\t"qic.demo.password": "secret",\n\t"editor.fontSize": 14\n}';
		const exported = JSON.parse(updateIgnoredSettings(local, '{}', profileIgnoredSettings({}), formattingOptions));
		assert.deepStrictEqual(exported, { 'editor.fontSize': 14 });
	});

	test('an import never overwrites the local demo keys', () => {
		const imported = '{\n\t"qic.demo.email": "other@example.com",\n\t"editor.fontSize": 12\n}';
		const local = '{\n\t"qic.demo.email": "user@example.com"\n}';
		const written = JSON.parse(updateIgnoredSettings(imported, local, profileIgnoredSettings({}), formattingOptions));
		assert.deepStrictEqual(written, { 'qic.demo.email': 'user@example.com', 'editor.fontSize': 12 });
	});
});

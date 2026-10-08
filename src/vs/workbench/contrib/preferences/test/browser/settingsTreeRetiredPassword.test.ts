/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IWorkbenchConfigurationService } from '../../../../services/configuration/common/configuration.js';
import { IWorkbenchEnvironmentService } from '../../../../services/environment/common/environmentService.js';
import { ISetting, SettingMatchType, SettingValueType } from '../../../../services/preferences/common/preferences.js';
import { DefaultSettings } from '../../../../services/preferences/common/preferencesModels.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
// The production registration of the retired demo keys (a side effect of the import, as in the application).
import '../../../../services/quantlabHostIdentity/common/quantlabRetiredSettings.js';
import { ISettingsEditorViewState, SearchResultIdx, SearchResultModel, SettingsTreeGroupElement, SettingsTreeModel, SettingsTreeSettingElement } from '../../browser/settingsTreeModels.js';

// QuantLab F-SYNC-STRIP-1 (M2): a configured `qic.demo.password` is never rendered unmasked by the Settings editor. The editor
// lists a configured deprecated setting and picks its row renderer from the setting's value type (settingsTreeModels.ts
// initSettingValueType, settingsTree.ts SettingsTreeDelegate.getTemplateId): a `string` setting gets the plain-text InputBox
// renderer, a `complex` one only an "Edit in settings.json" button. The model of the REAL registered setting is built here, in
// the tree and in a search result; the DOM renderers themselves are not instantiated (they need a dozen workbench services).
suite('Settings editor - the retired demo password is not rendered as a value (STRIP-1)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const PASSWORD = 'qic.demo.password';
	const EMAIL = 'qic.demo.email';
	const SENTINEL_PASSWORD = 'SENTINEL-not-a-real-password';
	const SENTINEL_EMAIL = 'SENTINEL-not-a-real-address';

	// Value types whose renderer shows the configured value in a text control (input, textarea) or a list of text controls.
	const textValueTypes: SettingValueType[] = [
		SettingValueType.String, SettingValueType.MultilineString, SettingValueType.Integer, SettingValueType.Number,
		SettingValueType.NullableInteger, SettingValueType.NullableNumber, SettingValueType.Enum, SettingValueType.Array,
		SettingValueType.Exclude, SettingValueType.Include, SettingValueType.Object, SettingValueType.BooleanObject, SettingValueType.ComplexObject,
	];

	const viewState: ISettingsEditorViewState = { settingsTarget: ConfigurationTarget.USER_LOCAL };
	const languageService = {} as unknown as ILanguageService;
	const productService = {} as unknown as IProductService;
	const userDataProfileService = { currentProfile: { isDefault: true } } as unknown as IUserDataProfileService;
	const environmentService = { remoteAuthority: undefined } as unknown as IWorkbenchEnvironmentService;

	function configuredWith(values: Record<string, unknown>): TestConfigurationService {
		return new TestConfigurationService(values);
	}

	/** The setting exactly as the Settings editor's default-settings model builds it from the configuration registry. */
	function registeredSetting(key: string): ISetting {
		const defaultSettings = disposables.add(new DefaultSettings([], ConfigurationTarget.USER_LOCAL, new TestConfigurationService()));
		for (const group of defaultSettings.getRegisteredGroups()) {
			for (const section of group.sections) {
				for (const setting of section.settings) {
					if (setting.key === key) {
						return setting;
					}
				}
			}
		}
		throw new Error(`${key} is not in the registered settings groups`);
	}

	function treeRow(key: string, configuration: TestConfigurationService): SettingsTreeSettingElement | undefined {
		const model = disposables.add(new SettingsTreeModel(viewState, true, configuration as unknown as IWorkbenchConfigurationService, languageService, userDataProfileService, productService));
		model.update({ id: 'root', label: 'root', children: [{ id: 'qic.demo', label: 'Quantlab (retired settings)', settings: [registeredSetting(key)] }] });
		const group = model.root.children.find((child): child is SettingsTreeGroupElement => child instanceof SettingsTreeGroupElement);
		return group?.children.find((child): child is SettingsTreeSettingElement => child instanceof SettingsTreeSettingElement && child.setting.key === key);
	}

	function searchRow(key: string, configuration: TestConfigurationService): SettingsTreeSettingElement | undefined {
		const model = disposables.add(new SearchResultModel(viewState, null, true, configuration as unknown as IWorkbenchConfigurationService, environmentService, languageService, userDataProfileService, productService));
		model.setResult(SearchResultIdx.Local, {
			filterMatches: [{ setting: registeredSetting(key), matches: [], matchType: SettingMatchType.ContiguousQueryInSettingId, keyMatchScore: 0, score: 0 }],
			exactMatch: false
		});
		return model.root.children.find((child): child is SettingsTreeSettingElement => child instanceof SettingsTreeSettingElement && child.setting.key === key);
	}

	function assertNoTextControl(row: SettingsTreeSettingElement | undefined, sentinel: string, context: string): void {
		// The row must exist and hold the configured value, otherwise the assertions below say nothing.
		assert.ok(row, `${context}: a configured deprecated setting must be listed`);
		assert.strictEqual(row.isConfigured, true, `${context}: the row must be the configured one`);
		assert.strictEqual(row.value, sentinel, `${context}: the row model holds the configured value`);
		assert.ok(!textValueTypes.includes(row.valueType), `${context}: value type ${row.valueType} renders the configured value in a text control`);
		assert.strictEqual(row.valueType, SettingValueType.Complex, `${context}: the row must be the value-less "Edit in settings.json" row`);
		// Nothing else the row displays holds it either.
		const displayed = [row.displayLabel, row.displayCategory ?? '', row.description, row.setting.deprecationMessage ?? '', ...row.setting.description];
		for (const text of displayed) {
			assert.ok(!text.includes(sentinel), `${context}: displayed text holds the value`);
		}
	}

	test('a configured password is a value-less row in the settings tree', () => {
		assertNoTextControl(treeRow(PASSWORD, configuredWith({ [PASSWORD]: SENTINEL_PASSWORD })), SENTINEL_PASSWORD, 'tree');
	});

	test('a configured password is a value-less row in a search result', () => {
		assertNoTextControl(searchRow(PASSWORD, configuredWith({ [PASSWORD]: SENTINEL_PASSWORD })), SENTINEL_PASSWORD, 'search result');
	});

	test('a configured password string is not flagged as an invalid type', () => {
		const row = treeRow(PASSWORD, configuredWith({ [PASSWORD]: SENTINEL_PASSWORD }));
		assert.ok(row);
		assert.deepStrictEqual(row.setting.type, ['string', 'null']);
	});

	test('an unconfigured password is not listed at all', () => {
		assert.strictEqual(treeRow(PASSWORD, configuredWith({})), undefined);
	});

	// Control for the check itself: the email key is not a credential and keeps its plain string row, which is exactly what
	// the assertions above reject for the password.
	test('control: a configured email is still a text row (the check can fail)', () => {
		const row = treeRow(EMAIL, configuredWith({ [EMAIL]: SENTINEL_EMAIL }));
		assert.ok(row);
		assert.strictEqual(row.valueType, SettingValueType.String);
		assert.throws(() => assertNoTextControl(row, SENTINEL_EMAIL, 'email'), /text control/);
	});
});

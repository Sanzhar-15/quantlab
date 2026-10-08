/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ITreeNode } from '../../../../../base/browser/ui/tree/tree.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IUserDataSyncEnablementService } from '../../../../../platform/userDataSync/common/userDataSync.js';
import { IWorkbenchConfigurationService } from '../../../../services/configuration/common/configuration.js';
import { SettingValueType, ISetting } from '../../../../services/preferences/common/preferences.js';
import { DefaultSettings } from '../../../../services/preferences/common/preferencesModels.js';
import { getInvalidTypeError } from '../../../../services/preferences/common/preferencesValidation.js';
import { IUserDataProfileService } from '../../../../services/userDataProfile/common/userDataProfile.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { IExtensionsWorkbenchService } from '../../../extensions/common/extensions.js';
// The production registration of the retired demo keys (a side effect of the import, as in the application).
import '../../../../services/quantlabHostIdentity/common/quantlabRetiredSettings.js';
import { SettingTreeRenderers } from '../../browser/settingsTree.js';
import { ISettingsEditorViewState, SettingsTreeGroupElement, SettingsTreeModel, SettingsTreeSettingElement } from '../../browser/settingsTreeModels.js';

// QuantLab F-SYNC-STRIP-2 (S2, B3): the Settings row of a configured `qic.demo.password` is RENDERED here, by the real
// renderer the editor picks for it, and nothing in the rendered row holds the value: no text node, no input value, no title and
// no attribute (aria-label, data-*, class, …).
//
// No existing test renders a Settings row (settingsTreeModels.test.ts and settingsTreeRetiredPassword.test.ts stop at the
// row model), so this builds the minimum: the real `SettingTreeRenderers` on the workbench test services, with the four
// services this row never calls into (opener, command, clipboard, extensions workbench) as empty objects, sync disabled,
// and `isSettingAppliedForAllProfiles` answering what the registry says for an APPLICATION-scoped setting. The tree's
// virtual list is not built: it adds layout, not content. `SettingsTreeDelegate.getTemplateId` is not exported, so its
// decision for the two cases that matter is repeated in `rendererFor`.
//
// Negatives: registering `qic.demo.password` with `type: 'string'` selects the text renderer, whose InputBox holds the value
// (RED); a complex renderer that shows `dataElement.value` (e.g. `template.button.textContent = dataElement.value` in
// SettingComplexRenderer.renderValue) puts the value in a text node (RED).
suite('Settings editor - the rendered row of the retired demo password (STRIP-2)', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const PASSWORD = 'qic.demo.password';
	const EMAIL = 'qic.demo.email';
	const SENTINEL_PASSWORD = 'SENTINEL-not-a-real-password';
	const SENTINEL_EMAIL = 'SENTINEL-not-a-real-address';
	// The ids of settingsTree.ts SETTINGS_COMPLEX_TEMPLATE_ID and SETTINGS_TEXT_TEMPLATE_ID (not exported).
	const COMPLEX_TEMPLATE_ID = 'settings.complex.template';
	const TEXT_TEMPLATE_ID = 'settings.text.template';

	const viewState: ISettingsEditorViewState = { settingsTarget: ConfigurationTarget.USER_LOCAL };
	const languageService = {} as unknown as ILanguageService;
	const productService = {} as unknown as IProductService;
	const userDataProfileService = { currentProfile: { isDefault: true } } as unknown as IUserDataProfileService;

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

	function setUp(values: Record<string, unknown>) {
		// Both retired keys are registered with ConfigurationScope.APPLICATION: they apply to all profiles.
		const configuration = Object.assign(new TestConfigurationService(values), { isSettingAppliedForAllProfiles: () => true });
		const instantiationService = workbenchInstantiationService({ configurationService: () => configuration }, disposables);
		instantiationService.set(IOpenerService, {} as unknown as IOpenerService);
		instantiationService.set(ICommandService, { executeCommand: async () => undefined } as unknown as ICommandService);
		instantiationService.set(IClipboardService, {} as unknown as IClipboardService);
		instantiationService.set(IExtensionsWorkbenchService, {} as unknown as IExtensionsWorkbenchService);
		instantiationService.set(IUserDataSyncEnablementService, { isEnabled: () => false } as unknown as IUserDataSyncEnablementService);
		const renderers = disposables.add(instantiationService.createInstance(SettingTreeRenderers));
		return { configuration, renderers };
	}

	function treeRow(key: string, setting: ISetting, configuration: TestConfigurationService): SettingsTreeSettingElement {
		const model = disposables.add(new SettingsTreeModel(viewState, true, configuration as unknown as IWorkbenchConfigurationService, languageService, userDataProfileService, productService));
		model.update({ id: 'root', label: 'root', children: [{ id: 'qic.demo', label: 'Quantlab (retired settings)', settings: [setting] }] });
		const group = model.root.children.find((child): child is SettingsTreeGroupElement => child instanceof SettingsTreeGroupElement);
		const row = group?.children.find((child): child is SettingsTreeSettingElement => child instanceof SettingsTreeSettingElement && child.setting.key === key);
		assert.ok(row, `${key}: a configured setting must be listed`);
		assert.strictEqual(row.isConfigured, true, `${key}: the row must be the configured one`);
		return row;
	}

	/** What SettingsTreeDelegate.getTemplateId decides for the two cases that matter here; any other value type is not modelled. */
	function rendererFor(renderers: SettingTreeRenderers, row: SettingsTreeSettingElement) {
		let templateId: string;
		if (getInvalidTypeError(row.value, row.setting.type) || row.valueType === SettingValueType.Complex) {
			templateId = COMPLEX_TEMPLATE_ID;
		} else if (row.valueType === SettingValueType.String) {
			templateId = TEXT_TEMPLATE_ID;
		} else {
			throw new Error(`the value type ${row.valueType} of ${row.setting.key} is not modelled by this test`);
		}
		const matching = renderers.allRenderers.filter(renderer => renderer.templateId === templateId);
		assert.strictEqual(matching.length, 1, `exactly one renderer has the template id ${templateId}`);
		return { renderer: matching[0], templateId };
	}

	/** Renders the row into a fresh container with the renderer the editor picks for it; everything is disposed with the test. */
	function renderRow(renderers: SettingTreeRenderers, row: SettingsTreeSettingElement): { container: HTMLElement; templateId: string } {
		const { renderer, templateId } = rendererFor(renderers, row);
		const container = mainWindow.document.createElement('div');
		const template = renderer.renderTemplate(container);
		const node = { element: row } as unknown as ITreeNode<SettingsTreeSettingElement, never>;
		renderer.renderElement(node, 0, template);
		disposables.add(toDisposable(() => {
			renderer.disposeElement(node, 0, template);
			renderer.disposeTemplate(template);
			// the common template of settingsTree.ts does not put its toolbar in `toDispose` (the bool template does)
			template.toolbar.dispose();
		}));
		return { container, templateId };
	}

	/** Every place of the rendered subtree that holds `sentinel`: text nodes, input values, `title`, and every attribute. */
	function whereIsTheSentinel(root: HTMLElement, sentinel: string): string[] {
		const hits: string[] = [];
		// eslint-disable-next-line no-restricted-syntax
		const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
		for (const element of elements) {
			const where = `<${element.tagName.toLowerCase()}>`;
			for (const attribute of Array.from(element.attributes)) {
				if (attribute.value.includes(sentinel)) {
					hits.push(`attribute ${attribute.name} of ${where}`);
				}
			}
			const value = (element as { value?: unknown }).value;
			if (typeof value === 'string' && value.includes(sentinel)) {
				hits.push(`value of ${where}`);
			}
			if (element.title.includes(sentinel)) {
				hits.push(`title of ${where}`);
			}
			for (const node of Array.from(element.childNodes)) {
				if (node.nodeType === 3 && node.nodeValue?.includes(sentinel)) {
					hits.push(`text node in ${where}`);
				}
			}
		}
		return hits;
	}

	test('the sentinel finder sees a text node, an input value, a title and an attribute (the check can fail)', () => {
		const root = mainWindow.document.createElement('div');
		root.title = `title ${SENTINEL_PASSWORD}`;
		root.appendChild(mainWindow.document.createTextNode(`text ${SENTINEL_PASSWORD}`));
		const input = mainWindow.document.createElement('input');
		input.value = SENTINEL_PASSWORD;
		root.appendChild(input);
		const labelled = mainWindow.document.createElement('a');
		labelled.setAttribute('aria-label', SENTINEL_PASSWORD);
		root.appendChild(labelled);
		assert.deepStrictEqual(whereIsTheSentinel(root, SENTINEL_PASSWORD).sort(), [
			'attribute aria-label of <a>', 'attribute title of <div>', 'text node in <div>', 'title of <div>', 'value of <input>',
		]);
		assert.deepStrictEqual(whereIsTheSentinel(mainWindow.document.createElement('div'), SENTINEL_PASSWORD), []);
	});

	test('a configured password is rendered as the value-less "Edit in settings.json" row, with no error and no value anywhere', () => {
		const { configuration, renderers } = setUp({ [PASSWORD]: SENTINEL_PASSWORD });
		const row = treeRow(PASSWORD, registeredSetting(PASSWORD), configuration);
		const { container, templateId } = renderRow(renderers, row);

		// The assertions below say something only if the row was really rendered, by the complex renderer.
		assert.strictEqual(templateId, COMPLEX_TEMPLATE_ID);
		assert.ok(container.classList.contains('setting-item-complex'), 'the row is the complex template');
		assert.strictEqual(container.getAttribute('data-key'), PASSWORD);
		assert.ok(container.classList.contains('is-configured'), 'the row shows as modified');
		assert.ok(container.textContent?.includes('Edit in settings.json'), 'the row offers Edit in settings.json');
		assert.ok(row.displayLabel.length > 0 && container.textContent?.includes(row.displayLabel), 'the row shows its label');
		assert.ok(!container.classList.contains('invalid-input'), 'a configured string is a valid value: no invalid-type error');

		assert.deepStrictEqual(whereIsTheSentinel(container, SENTINEL_PASSWORD), []);
	});

	// The control on a real rendered row: the email is a plain string setting and the text renderer puts it in an input.
	test('control: a configured email is rendered in a text input (the check can fail on a rendered row)', () => {
		const { configuration, renderers } = setUp({ [EMAIL]: SENTINEL_EMAIL });
		const row = treeRow(EMAIL, registeredSetting(EMAIL), configuration);
		const { container, templateId } = renderRow(renderers, row);
		assert.strictEqual(templateId, TEXT_TEMPLATE_ID);
		assert.ok(whereIsTheSentinel(container, SENTINEL_EMAIL).includes('value of <input>'), 'the email value is in the input');
	});
});

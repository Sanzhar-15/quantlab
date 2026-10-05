/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export enum ThemeSettingDefaults {
	COLOR_THEME_DARK = 'Quantlab Dark',
	COLOR_THEME_LIGHT = 'Quantlab Light',
	COLOR_THEME_HC_DARK = 'Default High Contrast',
	// Delta Plus ships one high-contrast theme; a light high-contrast system setting selects it too.
	COLOR_THEME_HC_LIGHT = 'Default High Contrast',

	FILE_ICON_THEME = 'vs-seti',
	PRODUCT_ICON_THEME = 'Default',
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#24201C',
	'activityBar.activeBorder': '#FF7331',
	'activityBar.background': '#090707',
	'activityBar.border': '#342E29',
	'activityBar.foreground': '#EDEDEF',
	'activityBar.inactiveForeground': '#838386',
	'activityBarBadge.background': '#FF7331',
	'activityBarBadge.foreground': '#1A0A00',
	'badge.background': '#2B2522',
	'badge.foreground': '#EDEDEF',
	'button.background': '#FF7331',
	'button.border': '#EDEDEF12',
	'button.foreground': '#1A0A00',
	'button.hoverBackground': '#FF8855',
	'button.secondaryBackground': '#24201C',
	'button.secondaryForeground': '#EDEDEF',
	'button.secondaryHoverBackground': '#2B2522',
	'chat.slashCommandBackground': '#24201C99',
	'chat.slashCommandForeground': '#FF7331',
	'chat.editedFileForeground': '#F5A623',
	'checkbox.background': '#100F0D',
	'checkbox.border': '#FFFFFF1F',
	'debugToolBar.background': '#100F0D',
	'descriptionForeground': '#A8A8AC',
	'dropdown.background': '#24201C',
	'dropdown.border': '#FFFFFF1F',
	'dropdown.foreground': '#EDEDEF',
	'dropdown.listBackground': '#2B2522',
	'editor.background': '#171413',
	'editor.findMatchBackground': '#FF733140',
	'editor.foreground': '#EDEDEF',
	'editor.inactiveSelectionBackground': '#2B2522',
	'editor.selectionBackground': '#603722',
	'editor.selectionHighlightBackground': '#FF73311A',
	'editorCursor.foreground': '#FF7331',
	'editorGroup.border': '#342E29',
	'editorGroupHeader.tabsBackground': '#100F0D',
	'editorGroupHeader.tabsBorder': '#342E29',
	'editorGutter.addedBackground': '#44BF6E',
	'editorGutter.deletedBackground': '#FF6B6B',
	'editorGutter.modifiedBackground': '#F5A623',
	'editorIndentGuide.activeBackground1': '#838386',
	'editorIndentGuide.background1': '#342E29',
	'editorLineNumber.activeForeground': '#A8A8AC',
	'editorLineNumber.foreground': '#838386',
	'editorOverviewRuler.border': '#342E29',
	'editorWidget.background': '#2B2522',
	'errorForeground': '#FF6B6B',
	'focusBorder': '#F5F5F7',
	'foreground': '#EDEDEF',
	'icon.foreground': '#A8A8AC',
	'input.background': '#100F0D',
	'input.border': '#FFFFFF1F',
	'input.foreground': '#EDEDEF',
	'input.placeholderForeground': '#7A7A7D',
	'inputOption.activeBackground': '#FF733140',
	'inputOption.activeBorder': '#FF7331',
	'keybindingLabel.foreground': '#EDEDEF',
	'list.activeSelectionBackground': '#603722',
	'list.activeSelectionForeground': '#EDEDEF',
	'list.activeSelectionIconForeground': '#EDEDEF',
	'list.dropBackground': '#2B2522',
	'list.hoverBackground': '#24201C',
	'menu.background': '#2B2522',
	'menu.border': '#342E29',
	'menu.foreground': '#EDEDEF',
	'menu.selectionBackground': '#603722',
	'menu.separatorBackground': '#342E29',
	'notificationCenterHeader.background': '#100F0D',
	'notificationCenterHeader.foreground': '#EDEDEF',
	'notifications.background': '#24201C',
	'notifications.border': '#342E29',
	'notifications.foreground': '#EDEDEF',
	'panel.background': '#100F0D',
	'panel.border': '#342E29',
	'panelInput.border': '#342E29',
	'panelTitle.activeBorder': '#FF7331',
	'panelTitle.activeForeground': '#EDEDEF',
	'panelTitle.inactiveForeground': '#838386',
	'peekViewEditor.background': '#171413',
	'peekViewEditor.matchHighlightBackground': '#FF733140',
	'peekViewResult.background': '#100F0D',
	'peekViewResult.matchHighlightBackground': '#FF733140',
	'pickerGroup.border': '#342E29',
	'ports.iconRunningProcessForeground': '#44BF6E',
	'progressBar.background': '#FF7331',
	'quickInput.background': '#24201C',
	'quickInput.foreground': '#EDEDEF',
	'scrollbarSlider.background': '#FFFFFF14',
	'settings.dropdownBackground': '#24201C',
	'settings.dropdownBorder': '#FFFFFF1F',
	'settings.headerForeground': '#F5F5F7',
	'settings.modifiedItemIndicator': '#FF733166',
	'sideBar.background': '#100F0D',
	'sideBar.border': '#342E29',
	'sideBar.foreground': '#A8A8AC',
	'sideBarSectionHeader.background': '#100F0D',
	'sideBarSectionHeader.border': '#342E29',
	'sideBarSectionHeader.foreground': '#EDEDEF',
	'sideBarTitle.foreground': '#EDEDEF',
	'statusBar.background': '#090707',
	'statusBar.border': '#342E29',
	'statusBar.debuggingBackground': '#FF7331',
	'statusBar.debuggingForeground': '#1A0A00',
	'statusBar.focusBorder': '#F5F5F7',
	'statusBar.foreground': '#A8A8AC',
	'statusBar.noFolderBackground': '#090707',
	'statusBarItem.focusBorder': '#F5F5F7',
	'statusBarItem.hoverBackground': '#24201C',
	'statusBarItem.prominentBackground': '#24201C66',
	'statusBarItem.remoteBackground': '#FF7331',
	'statusBarItem.remoteForeground': '#1A0A00',
	'tab.activeBackground': '#171413',
	'tab.activeBorder': '#171413',
	'tab.activeBorderTop': '#FF7331',
	'tab.activeForeground': '#EDEDEF',
	'tab.border': '#342E29',
	'tab.hoverBackground': '#24201C',
	'tab.inactiveBackground': '#100F0D',
	'tab.inactiveForeground': '#838386',
	'tab.lastPinnedBorder': '#EDEDEF33',
	'tab.selectedBackground': '#171413',
	'tab.selectedBorderTop': '#FF7331',
	'tab.selectedForeground': '#EDEDEFA1',
	'tab.unfocusedActiveBorder': '#171413',
	'tab.unfocusedActiveBorderTop': '#342E29',
	'tab.unfocusedHoverBackground': '#100F0D',
	'terminal.foreground': '#EDEDEF',
	'terminal.inactiveSelectionBackground': '#2B2522',
	'terminal.tab.activeBorder': '#FF7331',
	'textBlockQuote.background': '#24201C',
	'textBlockQuote.border': '#342E29',
	'textCodeBlock.background': '#100F0D',
	'textLink.activeForeground': '#FFA377',
	'textLink.foreground': '#FF8C55',
	'textPreformat.background': '#2B2522',
	'textPreformat.foreground': '#EDEDEF',
	'textSeparator.foreground': '#342E29',
	'titleBar.activeBackground': '#090707',
	'titleBar.activeForeground': '#EDEDEF',
	'titleBar.border': '#342E29',
	'titleBar.inactiveBackground': '#090707',
	'titleBar.inactiveForeground': '#838386',
	'welcomePage.progress.foreground': '#FF7331',
	'welcomePage.tileBackground': '#24201C',
	'widget.border': '#342E29'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#dddddd',
	'activityBar.activeBorder': '#FF7331',
	'activityBar.background': '#F0F0F0',
	'activityBar.border': '#D4D4D8',
	'activityBar.foreground': '#090707',
	'activityBar.inactiveForeground': '#5C5C60',
	'activityBarBadge.background': '#FF7331',
	'activityBarBadge.foreground': '#1A0A00',
	'badge.background': '#D4D4D8',
	'badge.foreground': '#090707',
	'button.background': '#FF7331',
	'button.border': '#0000001F',
	'button.foreground': '#1A0A00',
	'button.hoverBackground': '#FF8855',
	'button.secondaryBackground': '#EDEDEF',
	'button.secondaryForeground': '#090707',
	'button.secondaryHoverBackground': '#D4D4D8',
	'chat.slashCommandBackground': '#FF733126',
	'chat.slashCommandForeground': '#E5672C',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#FFFFFF',
	'checkbox.border': '#B4B4B8',
	'descriptionForeground': '#565453',
	'diffEditor.unchangedRegionBackground': '#f8f8f8',
	'dropdown.background': '#FFFFFF',
	'dropdown.border': '#B4B4B8',
	'dropdown.foreground': '#090707',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FFFFFF',
	'editor.foreground': '#090707',
	'editor.inactiveSelectionBackground': '#FF73311F',
	'editor.selectionHighlightBackground': '#FF733133',
	'editorGroup.border': '#D4D4D8',
	'editorGroupHeader.tabsBackground': '#F0F0F0',
	'editorGroupHeader.tabsBorder': '#D4D4D8',
	'editorGutter.addedBackground': '#1A8A3E',
	'editorGutter.deletedBackground': '#C93C3C',
	'editorGutter.modifiedBackground': '#F5A623',
	'editorIndentGuide.activeBackground1': '#939393',
	'editorIndentGuide.background1': '#D4D4D8',
	'editorLineNumber.activeForeground': '#090707',
	'editorLineNumber.foreground': '#5C5C60',
	'editorOverviewRuler.border': '#D4D4D8',
	'editorSuggestWidget.background': '#F0F0F0',
	'editorWidget.background': '#F0F0F0',
	'errorForeground': '#C93C3C',
	'focusBorder': '#242323',
	'foreground': '#090707',
	'icon.foreground': '#565453',
	'input.background': '#FFFFFF',
	'input.border': '#B4B4B8',
	'input.foreground': '#090707',
	'input.placeholderForeground': '#7A7A7D',
	'inputOption.activeBackground': '#FF733140',
	'inputOption.activeBorder': '#FF7331',
	'inputOption.activeForeground': '#090707',
	'keybindingLabel.foreground': '#090707',
	'list.activeSelectionBackground': '#FF733133',
	'list.activeSelectionForeground': '#090707',
	'list.activeSelectionIconForeground': '#090707',
	'list.focusAndSelectionOutline': '#242323',
	'list.hoverBackground': '#EDEDEF',
	'menu.border': '#D4D4D8',
	'menu.selectionBackground': '#D4D4D8',
	'menu.selectionForeground': '#090707',
	'notebook.cellBorderColor': '#D4D4D8',
	'notebook.selectedCellBackground': '#FF73311A',
	'notificationCenterHeader.background': '#FFFFFF',
	'notificationCenterHeader.foreground': '#090707',
	'notifications.background': '#FFFFFF',
	'notifications.border': '#D4D4D8',
	'notifications.foreground': '#090707',
	'panel.background': '#F0F0F0',
	'panel.border': '#D4D4D8',
	'panelInput.border': '#D4D4D8',
	'panelTitle.activeBorder': '#FF7331',
	'panelTitle.activeForeground': '#090707',
	'panelTitle.inactiveForeground': '#565453',
	'peekViewEditor.matchHighlightBackground': '#F5A62366',
	'peekViewResult.background': '#FFFFFF',
	'peekViewResult.matchHighlightBackground': '#F5A62366',
	'pickerGroup.border': '#D4D4D8',
	'pickerGroup.foreground': '#565453',
	'ports.iconRunningProcessForeground': '#1A8A3E',
	'progressBar.background': '#FF7331',
	'quickInput.background': '#F0F0F0',
	'quickInput.foreground': '#090707',
	'searchEditor.textInputBorder': '#B4B4B8',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#B4B4B8',
	'settings.headerForeground': '#090707',
	'settings.modifiedItemIndicator': '#F5A62366',
	'settings.numberInputBorder': '#B4B4B8',
	'settings.textInputBorder': '#B4B4B8',
	'sideBar.background': '#F0F0F0',
	'sideBar.border': '#D4D4D8',
	'sideBar.foreground': '#090707',
	'sideBarSectionHeader.background': '#F0F0F0',
	'sideBarSectionHeader.border': '#D4D4D8',
	'sideBarSectionHeader.foreground': '#090707',
	'sideBarTitle.foreground': '#090707',
	'statusBar.background': '#F0F0F0',
	'statusBar.border': '#D4D4D8',
	'statusBar.debuggingBackground': '#FF7331',
	'statusBar.debuggingForeground': '#1A0A00',
	'statusBar.focusBorder': '#242323',
	'statusBar.foreground': '#090707',
	'statusBar.noFolderBackground': '#F0F0F0',
	'statusBarItem.compactHoverBackground': '#D4D4D8',
	'statusBarItem.errorBackground': '#C93C3C',
	'statusBarItem.focusBorder': '#242323',
	'statusBarItem.hoverBackground': '#0000000F',
	'statusBarItem.prominentBackground': '#5C5C6066',
	'statusBarItem.remoteBackground': '#FF7331',
	'statusBarItem.remoteForeground': '#1A0A00',
	'tab.activeBackground': '#FFFFFF',
	'tab.activeBorder': '#FFFFFF',
	'tab.activeBorderTop': '#FF7331',
	'tab.activeForeground': '#090707',
	'tab.border': '#D4D4D8',
	'tab.hoverBackground': '#EDEDEF',
	'tab.inactiveBackground': '#F0F0F0',
	'tab.inactiveForeground': '#5C5C60',
	'tab.lastPinnedBorder': '#D4D4D8',
	'tab.selectedBackground': '#ffffffa5',
	'tab.selectedBorderTop': '#FF7331',
	'tab.selectedForeground': '#333333b3',
	'tab.unfocusedActiveBorder': '#FFFFFF',
	'tab.unfocusedActiveBorderTop': '#D4D4D8',
	'tab.unfocusedHoverBackground': '#F0F0F0',
	'terminal.foreground': '#090707',
	'terminal.inactiveSelectionBackground': '#FF73311F',
	'terminal.tab.activeBorder': '#FF7331',
	'terminalCursor.foreground': '#E5672C',
	'textBlockQuote.background': '#F0F0F0',
	'textBlockQuote.border': '#D4D4D8',
	'textCodeBlock.background': '#F0F0F0',
	'textLink.activeForeground': '#E5672C',
	'textLink.foreground': '#E5672C',
	'textPreformat.background': '#0000001F',
	'textPreformat.foreground': '#090707',
	'textSeparator.foreground': '#D4D4D8',
	'titleBar.activeBackground': '#F0F0F0',
	'titleBar.activeForeground': '#090707',
	'titleBar.border': '#D4D4D8',
	'titleBar.inactiveBackground': '#F0F0F0',
	'titleBar.inactiveForeground': '#5C5C60',
	'welcomePage.tileBackground': '#F0F0F0',
	'widget.border': '#D4D4D8'
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: string;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}

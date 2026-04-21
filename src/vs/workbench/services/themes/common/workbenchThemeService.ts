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
	COLOR_THEME_HC_LIGHT = 'Default High Contrast Light',

	COLOR_THEME_DARK_OLD = 'Default Dark+',
	COLOR_THEME_LIGHT_OLD = 'Default Light+',

	FILE_ICON_THEME = 'vs-seti',
	PRODUCT_ICON_THEME = 'Default',
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#1B1A1A',
	'activityBar.activeBorder': '#FF7331',
	'activityBar.background': '#0A0A0A',
	'activityBar.border': '#1E1D1D',
	'activityBar.foreground': '#EDEDEF',
	'activityBar.inactiveForeground': '#767679',
	'activityBarBadge.background': '#FF7331',
	'activityBarBadge.foreground': '#1A0A00',
	'badge.background': '#242323',
	'badge.foreground': '#EDEDEF',
	'button.background': '#FF7331',
	'button.border': '#EDEDEF12',
	'button.foreground': '#1A0A00',
	'button.hoverBackground': '#E5672C',
	'button.secondaryBackground': '#383737',
	'button.secondaryForeground': '#EDEDEF',
	'button.secondaryHoverBackground': '#2C2B2B',
	'chat.slashCommandBackground': '#1B1A1A99',
	'chat.slashCommandForeground': '#FF7331',
	'chat.editedFileForeground': '#F5A623',
	'checkbox.background': '#1B1A1A',
	'checkbox.border': '#2C2B2B',
	'debugToolBar.background': '#141313',
	'descriptionForeground': '#A8A8AC',
	'dropdown.background': '#1B1A1A',
	'dropdown.border': '#383737',
	'dropdown.foreground': '#EDEDEF',
	'dropdown.listBackground': '#242323',
	'editor.background': '#1E1D1D',
	'editor.findMatchBackground': '#FF733140',
	'editor.foreground': '#EDEDEF',
	'editor.inactiveSelectionBackground': '#2C2B2B',
	'editor.selectionBackground': '#653B27',
	'editor.selectionHighlightBackground': '#FF73311A',
	'editorCursor.foreground': '#FF7331',
	'editorGroup.border': '#383737',
	'editorGroupHeader.tabsBackground': '#141313',
	'editorGroupHeader.tabsBorder': '#1E1D1D',
	'editorGutter.addedBackground': '#44BF6E',
	'editorGutter.deletedBackground': '#FF6B6B',
	'editorGutter.modifiedBackground': '#F5A623',
	'editorIndentGuide.activeBackground1': '#767679',
	'editorIndentGuide.background1': '#2C2B2B',
	'editorLineNumber.activeForeground': '#A8A8AC',
	'editorLineNumber.foreground': '#767679',
	'editorOverviewRuler.border': '#1E1D1D',
	'editorWidget.background': '#2C2B2B',
	'errorForeground': '#FF6B6B',
	'focusBorder': '#F5F5F7',
	'foreground': '#EDEDEF',
	'icon.foreground': '#A8A8AC',
	'input.background': '#141313',
	'input.border': '#383737',
	'input.foreground': '#EDEDEF',
	'input.placeholderForeground': '#767679',
	'inputOption.activeBackground': '#FF733140',
	'inputOption.activeBorder': '#FF7331',
	'keybindingLabel.foreground': '#EDEDEF',
	'list.activeSelectionBackground': '#653B27',
	'list.activeSelectionForeground': '#EDEDEF',
	'list.activeSelectionIconForeground': '#EDEDEF',
	'list.dropBackground': '#2C2B2B',
	'list.hoverBackground': '#1E1D1D',
	'menu.background': '#2C2B2B',
	'menu.border': '#383737',
	'menu.foreground': '#EDEDEF',
	'menu.selectionBackground': '#383737',
	'menu.separatorBackground': '#383737',
	'notificationCenterHeader.background': '#141313',
	'notificationCenterHeader.foreground': '#EDEDEF',
	'notifications.background': '#1B1A1A',
	'notifications.border': '#383737',
	'notifications.foreground': '#EDEDEF',
	'panel.background': '#141313',
	'panel.border': '#1E1D1D',
	'panelInput.border': '#383737',
	'panelTitle.activeBorder': '#FF7331',
	'panelTitle.activeForeground': '#EDEDEF',
	'panelTitle.inactiveForeground': '#767679',
	'peekViewEditor.background': '#1E1D1D',
	'peekViewEditor.matchHighlightBackground': '#FF733140',
	'peekViewResult.background': '#141313',
	'peekViewResult.matchHighlightBackground': '#FF733140',
	'pickerGroup.border': '#383737',
	'ports.iconRunningProcessForeground': '#44BF6E',
	'progressBar.background': '#FF7331',
	'quickInput.background': '#242323',
	'quickInput.foreground': '#EDEDEF',
	'scrollbarSlider.background': '#FFFFFF15',
	'settings.dropdownBackground': '#1B1A1A',
	'settings.dropdownBorder': '#383737',
	'settings.headerForeground': '#EDEDEF',
	'settings.modifiedItemIndicator': '#FF733166',
	'sideBar.background': '#141313',
	'sideBar.border': '#1E1D1D',
	'sideBar.foreground': '#A8A8AC',
	'sideBarSectionHeader.background': '#141313',
	'sideBarSectionHeader.border': '#1E1D1D',
	'sideBarSectionHeader.foreground': '#EDEDEF',
	'sideBarTitle.foreground': '#EDEDEF',
	'statusBar.background': '#0A0A0A',
	'statusBar.border': '#1E1D1D',
	'statusBar.debuggingBackground': '#FF7331',
	'statusBar.debuggingForeground': '#1A0A00',
	'statusBar.focusBorder': '#F5F5F7',
	'statusBar.foreground': '#A8A8AC',
	'statusBar.noFolderBackground': '#0A0A0A',
	'statusBarItem.focusBorder': '#F5F5F7',
	'statusBarItem.hoverBackground': '#242323',
	'statusBarItem.prominentBackground': '#1E1D1D66',
	'statusBarItem.remoteBackground': '#FF7331',
	'statusBarItem.remoteForeground': '#1A0A00',
	'tab.activeBackground': '#1E1D1D',
	'tab.activeBorder': '#1E1D1D',
	'tab.activeBorderTop': '#FF7331',
	'tab.activeForeground': '#EDEDEF',
	'tab.border': '#1E1D1D',
	'tab.hoverBackground': '#1E1D1D',
	'tab.inactiveBackground': '#141313',
	'tab.inactiveForeground': '#767679',
	'tab.lastPinnedBorder': '#EDEDEF33',
	'tab.selectedBackground': '#1E1D1D',
	'tab.selectedBorderTop': '#FF7331',
	'tab.selectedForeground': '#EDEDEFA0',
	'tab.unfocusedActiveBorder': '#1E1D1D',
	'tab.unfocusedActiveBorderTop': '#383737',
	'tab.unfocusedHoverBackground': '#141313',
	'terminal.foreground': '#EDEDEF',
	'terminal.inactiveSelectionBackground': '#2C2B2B',
	'terminal.tab.activeBorder': '#FF7331',
	'textBlockQuote.background': '#1B1A1A',
	'textBlockQuote.border': '#383737',
	'textCodeBlock.background': '#141313',
	'textLink.activeForeground': '#FF7331',
	'textLink.foreground': '#FF7331',
	'textPreformat.background': '#2C2B2B',
	'textPreformat.foreground': '#EDEDEF',
	'textSeparator.foreground': '#383737',
	'titleBar.activeBackground': '#0A0A0A',
	'titleBar.activeForeground': '#EDEDEF',
	'titleBar.border': '#1E1D1D',
	'titleBar.inactiveBackground': '#0A0A0A',
	'titleBar.inactiveForeground': '#767679',
	'welcomePage.progress.foreground': '#FF7331',
	'welcomePage.tileBackground': '#1B1A1A',
	'widget.border': '#383737'
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#dddddd',
	'activityBar.activeBorder': '#e55a1c',
	'activityBar.background': '#F8F8F8',
	'activityBar.border': '#E5E5E5',
	'activityBar.foreground': '#1F1F1F',
	'activityBar.inactiveForeground': '#616161',
	'activityBarBadge.background': '#e55a1c',
	'activityBarBadge.foreground': '#FFFFFF',
	'badge.background': '#CCCCCC',
	'badge.foreground': '#3B3B3B',
	'button.background': '#e55a1c',
	'button.border': '#0000001a',
	'button.foreground': '#FFFFFF',
	'button.hoverBackground': '#d04d15',
	'button.secondaryBackground': '#E5E5E5',
	'button.secondaryForeground': '#3B3B3B',
	'button.secondaryHoverBackground': '#CCCCCC',
	'chat.slashCommandBackground': '#fce0c87a',
	'chat.slashCommandForeground': '#8b3a0f',
	'chat.editedFileForeground': '#895503',
	'checkbox.background': '#F8F8F8',
	'checkbox.border': '#CECECE',
	'descriptionForeground': '#3B3B3B',
	'diffEditor.unchangedRegionBackground': '#f8f8f8',
	'dropdown.background': '#FFFFFF',
	'dropdown.border': '#CECECE',
	'dropdown.foreground': '#3B3B3B',
	'dropdown.listBackground': '#FFFFFF',
	'editor.background': '#FFFFFF',
	'editor.foreground': '#3B3B3B',
	'editor.inactiveSelectionBackground': '#E5EBF1',
	'editor.selectionHighlightBackground': '#ADD6FF80',
	'editorGroup.border': '#E5E5E5',
	'editorGroupHeader.tabsBackground': '#F8F8F8',
	'editorGroupHeader.tabsBorder': '#E5E5E5',
	'editorGutter.addedBackground': '#2EA043',
	'editorGutter.deletedBackground': '#F85149',
	'editorGutter.modifiedBackground': '#0D85D6',
	'editorIndentGuide.activeBackground1': '#939393',
	'editorIndentGuide.background1': '#D3D3D3',
	'editorLineNumber.activeForeground': '#171184',
	'editorLineNumber.foreground': '#6E7681',
	'editorOverviewRuler.border': '#E5E5E5',
	'editorSuggestWidget.background': '#F8F8F8',
	'editorWidget.background': '#F8F8F8',
	'errorForeground': '#F85149',
	'focusBorder': '#0D85D6',
	'foreground': '#3B3B3B',
	'icon.foreground': '#3B3B3B',
	'input.background': '#FFFFFF',
	'input.border': '#CECECE',
	'input.foreground': '#3B3B3B',
	'input.placeholderForeground': '#767676',
	'inputOption.activeBackground': '#BED6ED',
	'inputOption.activeBorder': '#0D85D6',
	'inputOption.activeForeground': '#000000',
	'keybindingLabel.foreground': '#3B3B3B',
	'list.activeSelectionBackground': '#E8E8E8',
	'list.activeSelectionForeground': '#000000',
	'list.activeSelectionIconForeground': '#000000',
	'list.focusAndSelectionOutline': '#0D85D6',
	'list.hoverBackground': '#F2F2F2',
	'menu.border': '#CECECE',
	'menu.selectionBackground': '#0D85D6',
	'menu.selectionForeground': '#ffffff',
	'notebook.cellBorderColor': '#E5E5E5',
	'notebook.selectedCellBackground': '#C8DDF150',
	'notificationCenterHeader.background': '#FFFFFF',
	'notificationCenterHeader.foreground': '#3B3B3B',
	'notifications.background': '#FFFFFF',
	'notifications.border': '#E5E5E5',
	'notifications.foreground': '#3B3B3B',
	'panel.background': '#F8F8F8',
	'panel.border': '#E5E5E5',
	'panelInput.border': '#E5E5E5',
	'panelTitle.activeBorder': '#e55a1c',
	'panelTitle.activeForeground': '#3B3B3B',
	'panelTitle.inactiveForeground': '#3B3B3B',
	'peekViewEditor.matchHighlightBackground': '#BB800966',
	'peekViewResult.background': '#FFFFFF',
	'peekViewResult.matchHighlightBackground': '#BB800966',
	'pickerGroup.border': '#E5E5E5',
	'pickerGroup.foreground': '#8B949E',
	'ports.iconRunningProcessForeground': '#369432',
	'progressBar.background': '#e55a1c',
	'quickInput.background': '#F8F8F8',
	'quickInput.foreground': '#3B3B3B',
	'searchEditor.textInputBorder': '#CECECE',
	'settings.dropdownBackground': '#FFFFFF',
	'settings.dropdownBorder': '#CECECE',
	'settings.headerForeground': '#1F1F1F',
	'settings.modifiedItemIndicator': '#BB800966',
	'settings.numberInputBorder': '#CECECE',
	'settings.textInputBorder': '#CECECE',
	'sideBar.background': '#F8F8F8',
	'sideBar.border': '#E5E5E5',
	'sideBar.foreground': '#3B3B3B',
	'sideBarSectionHeader.background': '#F8F8F8',
	'sideBarSectionHeader.border': '#E5E5E5',
	'sideBarSectionHeader.foreground': '#3B3B3B',
	'sideBarTitle.foreground': '#3B3B3B',
	'statusBar.background': '#F8F8F8',
	'statusBar.border': '#E5E5E5',
	'statusBar.debuggingBackground': '#FD716C',
	'statusBar.debuggingForeground': '#000000',
	'statusBar.focusBorder': '#0D85D6',
	'statusBar.foreground': '#3B3B3B',
	'statusBar.noFolderBackground': '#F8F8F8',
	'statusBarItem.compactHoverBackground': '#CCCCCC',
	'statusBarItem.errorBackground': '#C72E0F',
	'statusBarItem.focusBorder': '#0D85D6',
	'statusBarItem.hoverBackground': '#B8B8B850',
	'statusBarItem.prominentBackground': '#6E768166',
	'statusBarItem.remoteBackground': '#e55a1c',
	'statusBarItem.remoteForeground': '#FFFFFF',
	'tab.activeBackground': '#FFFFFF',
	'tab.activeBorder': '#F8F8F8',
	'tab.activeBorderTop': '#e55a1c',
	'tab.activeForeground': '#3B3B3B',
	'tab.border': '#E5E5E5',
	'tab.hoverBackground': '#FFFFFF',
	'tab.inactiveBackground': '#F8F8F8',
	'tab.inactiveForeground': '#868686',
	'tab.lastPinnedBorder': '#D4D4D4',
	'tab.selectedBackground': '#ffffffa5',
	'tab.selectedBorderTop': '#5BA0D0',
	'tab.selectedForeground': '#333333b3',
	'tab.unfocusedActiveBorder': '#F8F8F8',
	'tab.unfocusedActiveBorderTop': '#E5E5E5',
	'tab.unfocusedHoverBackground': '#F8F8F8',
	'terminal.foreground': '#3B3B3B',
	'terminal.inactiveSelectionBackground': '#E5EBF1',
	'terminal.tab.activeBorder': '#e55a1c',
	'terminalCursor.foreground': '#e55a1c',
	'textBlockQuote.background': '#F8F8F8',
	'textBlockQuote.border': '#E5E5E5',
	'textCodeBlock.background': '#F8F8F8',
	'textLink.activeForeground': '#0D85D6',
	'textLink.foreground': '#0D85D6',
	'textPreformat.background': '#0000001F',
	'textPreformat.foreground': '#3B3B3B',
	'textSeparator.foreground': '#21262D',
	'titleBar.activeBackground': '#F8F8F8',
	'titleBar.activeForeground': '#1E1E1E',
	'titleBar.border': '#E5E5E5',
	'titleBar.inactiveBackground': '#F8F8F8',
	'titleBar.inactiveForeground': '#8B949E',
	'welcomePage.tileBackground': '#F3F3F3',
	'widget.border': '#E5E5E5'
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

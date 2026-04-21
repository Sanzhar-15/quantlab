/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export type QuantlabThemeKind = 'light' | 'dark' | 'high-contrast';

export interface QuantlabThemeInfo {
	kind: QuantlabThemeKind;
	variant: 'light' | 'dark';
	highContrast: boolean;
}

export function resolveQuantlabTheme(theme: vscode.ColorTheme): QuantlabThemeInfo {
	switch (theme.kind) {
		case vscode.ColorThemeKind.Light:
			return { kind: 'light', variant: 'light', highContrast: false };
		case vscode.ColorThemeKind.Dark:
			return { kind: 'dark', variant: 'dark', highContrast: false };
		case vscode.ColorThemeKind.HighContrast:
			return { kind: 'high-contrast', variant: 'dark', highContrast: true };
		case vscode.ColorThemeKind.HighContrastLight:
			return { kind: 'high-contrast', variant: 'light', highContrast: true };
		default:
			return { kind: 'dark', variant: 'dark', highContrast: false };
	}
}

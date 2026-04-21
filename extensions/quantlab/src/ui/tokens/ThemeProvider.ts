/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { QuantlabThemeInfo, resolveQuantlabTheme } from './themes';

export interface ThemeableWebview {
	postMessage: (message: unknown) => void;
}

export class ThemeProvider {
	private static instance: ThemeProvider | undefined;

	private readonly targets = new Map<string, ThemeableWebview>();
	private currentTheme: QuantlabThemeInfo;

	private constructor(context: vscode.ExtensionContext) {
		this.currentTheme = resolveQuantlabTheme(vscode.window.activeColorTheme);

		context.subscriptions.push(
			vscode.window.onDidChangeActiveColorTheme(() => this.refresh())
		);
	}

	static initialize(context: vscode.ExtensionContext): ThemeProvider {
		if (!ThemeProvider.instance) {
			ThemeProvider.instance = new ThemeProvider(context);
		}
		return ThemeProvider.instance;
	}

	static getInstance(): ThemeProvider {
		if (!ThemeProvider.instance) {
			throw new Error('ThemeProvider not initialized');
		}
		return ThemeProvider.instance;
	}

	getInlineStyles(): string {
		const theme = this.currentTheme;
		return `<style>:root{--ql-theme-kind:${theme.kind};--ql-theme-variant:${theme.variant};--ql-theme-contrast:${theme.highContrast ? '1' : '0'};}</style>`;
	}

	registerWebview(key: string, webview: ThemeableWebview): void {
		this.targets.set(key, webview);
		this.sendTheme(webview);
	}

	unregisterWebview(key: string): void {
		this.targets.delete(key);
	}

	private refresh(): void {
		const next = resolveQuantlabTheme(vscode.window.activeColorTheme);
		if (next.kind === this.currentTheme.kind &&
			next.variant === this.currentTheme.variant &&
			next.highContrast === this.currentTheme.highContrast) {
			return;
		}
		this.currentTheme = next;
		for (const target of this.targets.values()) {
			this.sendTheme(target);
		}
	}

	private sendTheme(target: ThemeableWebview): void {
		target.postMessage({
			type: 'theme',
			theme: { ...this.currentTheme }
		});
	}
}

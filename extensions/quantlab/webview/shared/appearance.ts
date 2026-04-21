/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface ThemePayload {
	kind: 'light' | 'dark' | 'high-contrast';
	variant: 'light' | 'dark';
	highContrast: boolean;
}

export type ReducedMotionMode = 'auto' | 'always' | 'never';

export function applyTheme(theme?: ThemePayload): void {
	if (!theme) {
		return;
	}
	const root = document.documentElement;
	root.dataset.qlTheme = theme.kind;
	root.dataset.qlThemeVariant = theme.variant;
	root.dataset.qlHighContrast = theme.highContrast ? 'true' : 'false';
}

export function applyReducedMotion(mode: ReducedMotionMode): void {
	const root = document.documentElement;
	const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const shouldReduce = mode === 'always' || (mode === 'auto' && prefersReduced);
	root.classList.toggle('ql-reduced-motion', shouldReduce);
}

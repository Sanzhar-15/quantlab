/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Megaudit D6 (2026-05-13): isolated module so the helper can be
 * unit-tested without importing the whole qviz-spec webview entry
 * (which transitively loads the renderer + applier + vega and needs
 * jsdom on top). A failing extension-message validation logs to
 * console.error AND emits an assertive aria-live announcement so
 * screen-reader users notice the failure that previously was
 * console-only.
 *
 * The announcement message is STABLE (does not interpolate the
 * envelope `type` or validator error) so the announcer's exact-string
 * dedup window collapses repeated rejections into a single audible
 * event. Per-rejection diagnostic detail flows to console.error.
 */

export interface AnnouncerForInvalidMsg {
	announce(message: string, level?: 'polite' | 'assertive'): void;
}

export function handleInvalidExtensionMessage(
	error: string,
	announcer: AnnouncerForInvalidMsg,
): void {
	console.error('qviz-spec: invalid extension message:', error);
	announcer.announce(
		'Quantlab rejected an invalid message from the extension host.',
		'assertive',
	);
}

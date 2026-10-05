/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The one extension gallery this fork ships in product.json: Open VSX. Hygiene refuses a product.json
// whose `extensionsGallery` is anything else, so a gallery swap cannot be committed unnoticed.

export const quantlabExtensionsGallery: Readonly<Record<string, string>> = Object.freeze({
	serviceUrl: 'https://open-vsx.org/vscode/gallery',
	itemUrl: 'https://open-vsx.org/vscode/item',
	resourceUrlTemplate: 'https://open-vsx.org/vscode/asset/{publisher}/{name}/{version}/{path}',
});

/**
 * `undefined` when `gallery` is absent or exactly the recorded gallery; otherwise the reason it is refused.
 */
export function checkExtensionsGallery(gallery: unknown): string | undefined {
	if (gallery === undefined) {
		return undefined;
	}
	if (typeof gallery !== 'object' || gallery === null || Array.isArray(gallery)) {
		return `'extensionsGallery' is not an object`;
	}
	const actual = gallery as Record<string, unknown>;
	const expectedKeys = Object.keys(quantlabExtensionsGallery);
	for (const key of Object.keys(actual)) {
		if (!expectedKeys.includes(key)) {
			return `'extensionsGallery.${key}' is not part of the recorded Open VSX gallery`;
		}
	}
	for (const key of expectedKeys) {
		if (actual[key] !== quantlabExtensionsGallery[key]) {
			return `'extensionsGallery.${key}' is ${JSON.stringify(actual[key])}, the recorded Open VSX gallery has ${JSON.stringify(quantlabExtensionsGallery[key])}`;
		}
	}
	return undefined;
}

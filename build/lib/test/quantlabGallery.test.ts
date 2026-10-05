/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { checkExtensionsGallery, quantlabExtensionsGallery } from '../quantlabGallery.ts';

suite('quantlabGallery', () => {

	test('no gallery and the recorded Open VSX gallery pass', () => {
		assert.strictEqual(checkExtensionsGallery(undefined), undefined);
		assert.strictEqual(checkExtensionsGallery({ ...quantlabExtensionsGallery }), undefined);
	});

	test('a changed URL is refused, naming the key', () => {
		assert.match(
			checkExtensionsGallery({ ...quantlabExtensionsGallery, serviceUrl: 'https://marketplace.visualstudio.com/_apis/public/gallery' })!,
			/^'extensionsGallery\.serviceUrl' is "https:\/\/marketplace\.visualstudio\.com\/_apis\/public\/gallery", the recorded Open VSX gallery has/
		);
	});

	test('a missing or an extra key is refused', () => {
		const { itemUrl, ...withoutItemUrl } = quantlabExtensionsGallery;
		assert.ok(itemUrl);
		assert.match(checkExtensionsGallery(withoutItemUrl)!, /'extensionsGallery\.itemUrl' is undefined/);
		assert.match(checkExtensionsGallery({ ...quantlabExtensionsGallery, controlUrl: 'https://example.invalid' })!, /'extensionsGallery\.controlUrl' is not part of the recorded/);
	});

	test('a non-object gallery is refused', () => {
		assert.match(checkExtensionsGallery('https://open-vsx.org')!, /is not an object/);
		assert.match(checkExtensionsGallery(null)!, /is not an object/);
	});
});

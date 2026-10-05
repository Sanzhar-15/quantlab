/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { hasCopyrightHeader } from '../copyrightHeader.ts';

const header = (holder: string) => [
	'/*---------------------------------------------------------------------------------------------',
	` *  Copyright (c) ${holder}. All rights reserved.`,
	' *  Licensed under the MIT License. See License.txt in the project root for license information.',
	' *--------------------------------------------------------------------------------------------*/',
];

suite('copyrightHeader', () => {

	test('the Microsoft and the Quantlab headers pass', () => {
		assert.strictEqual(hasCopyrightHeader([...header('Microsoft Corporation'), '', 'code']), true);
		assert.strictEqual(hasCopyrightHeader([...header('Quantlab'), '', 'code']), true);
	});

	test('any other holder is refused', () => {
		assert.strictEqual(hasCopyrightHeader([...header('Acme Inc'), '']), false);
		assert.strictEqual(hasCopyrightHeader([...header('Quantlab Ltd'), '']), false);
		assert.strictEqual(hasCopyrightHeader([...header('quantlab'), '']), false);
	});

	test('a missing, moved or altered header is refused', () => {
		assert.strictEqual(hasCopyrightHeader(['code']), false);
		assert.strictEqual(hasCopyrightHeader([]), false);
		assert.strictEqual(hasCopyrightHeader(['', ...header('Quantlab')]), false);
		assert.strictEqual(hasCopyrightHeader(header('Quantlab').map((l, i) => i === 2 ? l + ' ' : l)), false);
		assert.strictEqual(hasCopyrightHeader(header('Quantlab').slice(0, 3)), false);
	});
});

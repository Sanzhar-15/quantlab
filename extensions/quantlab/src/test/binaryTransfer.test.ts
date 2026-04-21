/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { decodeOhlcvBuffer, encodeOhlcvBars } from '../utils/binaryTransfer';

suite('binaryTransfer', () => {
	test('encodes and decodes OHLCV bars', () => {
		const bars = [
			{ t: 1, o: 10, h: 12, l: 9, c: 11, v: 100 },
			{ t: 2, o: 11, h: 13, l: 10, c: 12, v: 120 }
		];

		const encoded = encodeOhlcvBars(bars);
		assert.strictEqual(encoded.count, bars.length);
		assert.strictEqual(encoded.buffer.byteLength, bars.length * 6 * Float64Array.BYTES_PER_ELEMENT);

		const decoded = decodeOhlcvBuffer(encoded.buffer, encoded.count);
		assert.deepStrictEqual(decoded, bars);
	});
});

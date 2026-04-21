/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OhlcvBar } from '../types/chart';

const STRIDE = 6;

export function encodeOhlcvBars(bars: OhlcvBar[]): { buffer: ArrayBuffer; count: number } {
	const buffer = new ArrayBuffer(bars.length * STRIDE * Float64Array.BYTES_PER_ELEMENT);
	const view = new Float64Array(buffer);

	for (let i = 0; i < bars.length; i++) {
		const offset = i * STRIDE;
		const bar = bars[i];
		view[offset] = bar.t;
		view[offset + 1] = bar.o;
		view[offset + 2] = bar.h;
		view[offset + 3] = bar.l;
		view[offset + 4] = bar.c;
		view[offset + 5] = bar.v ?? 0;
	}

	return { buffer, count: bars.length };
}

export function decodeOhlcvBuffer(buffer: ArrayBuffer, count: number): OhlcvBar[] {
	const view = new Float64Array(buffer);
	const bars: OhlcvBar[] = [];

	for (let i = 0; i < count; i++) {
		const offset = i * STRIDE;
		bars.push({
			t: view[offset],
			o: view[offset + 1],
			h: view[offset + 2],
			l: view[offset + 3],
			c: view[offset + 4],
			v: view[offset + 5]
		});
	}

	return bars;
}

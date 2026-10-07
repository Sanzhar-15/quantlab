/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { OhlcvBar } from '../types/chart';

const STRIDE = 6;

/**
 * The transfer's volume slot (F-CHARTS-FB3): a bar with no volume (OhlcvBar.v is optional: a source without a volume
 * column) travels as NaN there and decodes without a `v`; an explicit 0 stays 0. The encoder rejects every other
 * non-finite volume first, so a NaN slot can only mean absent.
 */
function validateBar(bar: unknown, i: number): asserts bar is OhlcvBar {
	if (typeof bar !== 'object' || bar === null) {
		throw new Error(`binaryTransfer: bar ${i} is not an object (${String(bar)})`);
	}
	const fields = bar as Record<string, unknown>;
	for (const field of ['t', 'o', 'h', 'l', 'c'] as const) {
		const value = fields[field];
		if (typeof value !== 'number' || !Number.isFinite(value)) {
			throw new Error(`binaryTransfer: bar ${i} has no finite ${field} (${field} = ${String(value)})`);
		}
	}
	const volume = fields.v;
	if (volume !== undefined && (typeof volume !== 'number' || !Number.isFinite(volume))) {
		throw new Error(`binaryTransfer: bar ${i} has an invalid volume (v = ${String(volume)}; a volume is absent or a finite number)`);
	}
}

/** Every bar is validated before anything is written: one bad bar fails the whole encoding. */
export function encodeOhlcvBars(bars: OhlcvBar[]): { buffer: ArrayBuffer; count: number } {
	for (let i = 0; i < bars.length; i++) {
		validateBar(bars[i], i);
	}

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
		view[offset + 5] = bar.v === undefined ? Number.NaN : bar.v;
	}

	return { buffer, count: bars.length };
}

export function decodeOhlcvBuffer(buffer: ArrayBuffer, count: number): OhlcvBar[] {
	const view = new Float64Array(buffer);
	const bars: OhlcvBar[] = [];

	for (let i = 0; i < count; i++) {
		const offset = i * STRIDE;
		const bar: OhlcvBar = {
			t: view[offset],
			o: view[offset + 1],
			h: view[offset + 2],
			l: view[offset + 3],
			c: view[offset + 4]
		};
		// A NaN volume slot is an absent volume (the encoder never writes NaN for a present one): no `v` at all.
		if (!Number.isNaN(view[offset + 5])) {
			bar.v = view[offset + 5];
		}
		bars.push(bar);
	}

	return bars;
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Browser-compatible crypto utilities for QIC.
 *
 * VS Code's renderer runs in a sandboxed Chromium context with no Node.js
 * access. This module provides hash and UUID functions using VS Code's
 * built-in browser-compatible utilities and a pure-JS SHA-256 implementation.
 *
 * - SHA-256 is used for checksums, cache-keys, and integrity checks (sync, pure JS)
 * - UUID uses Web Crypto's randomUUID() via VS Code's uuid module
 * - randomBytes uses Web Crypto's getRandomValues()
 */

import { generateUuid } from '../../../../base/common/uuid.js';

// SHA-256 round constants: first 32 bits of fractional parts of cube roots of first 64 primes
const SHA256_K = new Int32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function _rotr(n: number, bits: number): number {
	return (n >>> bits) | (n << (32 - bits));
}

function _hex32(n: number): string {
	return (n >>> 0).toString(16).padStart(8, '0');
}

function _sha256(data: Uint8Array): string {
	const msgLen = data.length;
	const bitLenHi = Math.floor(msgLen / 0x20000000);
	const bitLenLo = (msgLen << 3) >>> 0;

	// Padding: 0x80 + zeros + 8-byte big-endian bit length
	const padZeros = (64 + 56 - (msgLen + 1) % 64) % 64;
	const totalLen = msgLen + 1 + padZeros + 8;
	const padded = new Uint8Array(totalLen);
	padded.set(data);
	padded[msgLen] = 0x80;
	const dv = new DataView(padded.buffer);
	dv.setUint32(totalLen - 8, bitLenHi, false);
	dv.setUint32(totalLen - 4, bitLenLo, false);

	// Initial hash values: first 32 bits of fractional parts of square roots of first 8 primes
	let h0 = 0x6a09e667 | 0;
	let h1 = 0xbb67ae85 | 0;
	let h2 = 0x3c6ef372 | 0;
	let h3 = 0xa54ff53a | 0;
	let h4 = 0x510e527f | 0;
	let h5 = 0x9b05688c | 0;
	let h6 = 0x1f83d9ab | 0;
	let h7 = 0x5be0cd19 | 0;

	const w = new Int32Array(64);

	for (let offset = 0; offset < totalLen; offset += 64) {
		for (let i = 0; i < 16; i++) {
			w[i] = dv.getInt32(offset + i * 4, false);
		}
		for (let i = 16; i < 64; i++) {
			const s0 = _rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
			const s1 = _rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
		}

		let a = h0, b = h1, c = h2, d = h3;
		let e = h4, f = h5, g = h6, h = h7;

		for (let i = 0; i < 64; i++) {
			const S1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
			const S0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) | 0;

			h = g; g = f; f = e; e = (d + temp1) | 0;
			d = c; c = b; b = a; a = (temp1 + temp2) | 0;
		}

		h0 = (h0 + a) | 0;
		h1 = (h1 + b) | 0;
		h2 = (h2 + c) | 0;
		h3 = (h3 + d) | 0;
		h4 = (h4 + e) | 0;
		h5 = (h5 + f) | 0;
		h6 = (h6 + g) | 0;
		h7 = (h7 + h) | 0;
	}

	return _hex32(h0) + _hex32(h1) + _hex32(h2) + _hex32(h3)
		+ _hex32(h4) + _hex32(h5) + _hex32(h6) + _hex32(h7);
}

/**
 * Compute a hex-encoded SHA-256 hash of the input string.
 * Pure JavaScript implementation — no native module dependencies.
 * Used for checksums, cache keys, audit chain integrity, and ApprovalToken verification.
 */
export function sha256Hex(data: string): string {
	const encoder = new TextEncoder();
	return _sha256(encoder.encode(data));
}

/**
 * Generate a random UUID v4 string.
 */
export function randomUUID(): string {
	return generateUuid();
}

/**
 * Generate random bytes as a Uint8Array.
 */
export function randomBytes(size: number): Uint8Array {
	const buf = new Uint8Array(size);
	globalThis.crypto.getRandomValues(buf);
	return buf;
}

/**
 * Convert a Uint8Array to a hex string.
 */
export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { formatRelativeTime } from '../../webview/action/utils';

// Megaudit W7-A (L26 / L28) regression suite: Action webview polish --
// relative-time copy and the preset-button active text token.

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');

suite('Action webview format polish (W7-A: L26/L28)', () => {

	suite('L26: formatRelativeTime', () => {
		test('under one minute reads "Just now", not "0 min ago"', () => {
			assert.strictEqual(formatRelativeTime(new Date()), 'Just now');
			assert.strictEqual(formatRelativeTime(new Date(Date.now() - 30 * 1000)), 'Just now');
			assert.strictEqual(formatRelativeTime(new Date(Date.now() - 59 * 1000)), 'Just now');
		});

		test('minutes still render as "N min ago"', () => {
			assert.strictEqual(formatRelativeTime(new Date(Date.now() - 5 * 60 * 1000)), '5 min ago');
			assert.strictEqual(formatRelativeTime(new Date(Date.now() - 59 * 60 * 1000)), '59 min ago');
		});

		test('a single hour reads "1 hour ago", not "1 hours ago"', () => {
			assert.strictEqual(formatRelativeTime(new Date(Date.now() - 90 * 60 * 1000)), '1 hour ago');
		});

		test('multiple hours still pluralize', () => {
			assert.strictEqual(formatRelativeTime(new Date(Date.now() - 3 * 60 * 60 * 1000)), '3 hours ago');
		});
	});

	suite('L28: preset-btn active token', () => {
		test('.preset-btn.active uses var(--ql-accent-fg), not a hardcoded #000000', () => {
			const css = fs.readFileSync(path.join(EXTENSION_ROOT, 'webview', 'action', 'action.css'), 'utf8');
			const block = /\.preset-btn\.active\s*\{[^}]*\}/.exec(css);
			assert.ok(block, '.preset-btn.active rule missing from action.css');
			assert.ok(block[0].includes('color: var(--ql-accent-fg);'), 'active preset text must use the accent-fg token');
			assert.ok(!block[0].includes('#000000'), 'hardcoded #000000 must be gone from .preset-btn.active');
		});
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();
import { formatRunType } from '../panels/history/HistoryTreeProvider';

// Megaudit W7-A (M63 / M57 / M56) regression suite: History plane
// presentation -- shared run-type labels, status icons/contextValues,
// and the History tree's right-click menu manifest wiring.

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');

interface MenuContribution {
	command?: string;
	when?: string;
	group?: string;
}

interface CommandContribution {
	command: string;
	title: string;
}

interface PackageManifest {
	contributes: {
		commands: CommandContribution[];
		menus: Record<string, MenuContribution[]>;
	};
}

function readJson<T>(rel: string): T {
	const raw = fs.readFileSync(path.join(EXTENSION_ROOT, rel), 'utf8');
	return JSON.parse(raw) as T;
}

function readSource(rel: string): string {
	return fs.readFileSync(path.join(EXTENSION_ROOT, rel), 'utf8');
}

suite('History presentation (W7-A: M63/M57/M56)', () => {

	suite('M57: shared formatRunType', () => {
		test('maps run types to the tree labels', () => {
			assert.strictEqual(formatRunType('wfa'), 'Walk-forward');
			assert.strictEqual(formatRunType('monteCarlo'), 'Monte Carlo');
			assert.strictEqual(formatRunType('backtest'), 'Backtest');
			assert.strictEqual(formatRunType('paper'), 'Paper');
			assert.strictEqual(formatRunType('live'), 'Live');
			assert.strictEqual(formatRunType('optimize'), 'Optimize');
		});

		test('HistoryDropdown uses the shared mapping and the em-dash separator', () => {
			const dropdown = readSource('src/panels/history/HistoryDropdown.ts');
			assert.ok(
				dropdown.includes(`import { formatRunType } from './HistoryTreeProvider';`),
				'HistoryDropdown must import the shared formatRunType (M57)',
			);
			assert.ok(
				!dropdown.includes('private formatRunType'),
				'HistoryDropdown must not keep a private first-char-capitalize formatRunType (M57)',
			);
			assert.ok(
				dropdown.includes('${formatRunType(entry.type)} \\u2014 ${path.basename(entry.strategyPath)}'),
				'HistoryDropdown entry label must use the em-dash separator like the tree (M57)',
			);
			assert.ok(
				!dropdown.includes(' -- ${path.basename'),
				'HistoryDropdown must not use the old double-hyphen separator (M57)',
			);
		});
	});

	suite('M63: status icons + status-aware contextValue', () => {
		test('HistoryTreeProvider assigns a per-status ThemeIcon and contextValue', () => {
			const tree = readSource('src/panels/history/HistoryTreeProvider.ts');
			assert.ok(
				tree.includes('item.iconPath = statusIcon(element.entry.status);'),
				'entry tree items must get a status icon (M63)',
			);
			// One icon per RunStatus -- the switch is exhaustive at compile
			// time; assert the demo-visible choices here.
			assert.ok(tree.includes(`new vscode.ThemeIcon('loading~spin')`), 'running -> loading~spin');
			assert.ok(tree.includes(`new vscode.ThemeIcon('clock')`), 'queued -> clock');
			assert.ok(tree.includes(`new vscode.ThemeIcon('pass'`), 'completed -> pass');
			assert.ok(tree.includes(`new vscode.ThemeIcon('error'`), 'failed -> error');
			assert.ok(tree.includes(`new vscode.ThemeIcon('circle-slash')`), 'cancelled -> circle-slash');
			assert.ok(
				tree.includes('item.contextValue = `quantlab.history.entry.${element.entry.status}`;'),
				'entry contextValue must be status-aware so menus can scope Cancel (M56)',
			);
		});
	});

	suite('M56: History tree right-click menu wiring', () => {
		let pkg: PackageManifest;
		let nls: Record<string, string>;
		let historyMenus: MenuContribution[];

		suiteSetup(() => {
			pkg = readJson<PackageManifest>('package.json');
			nls = readJson<Record<string, string>>('package.nls.json');
			historyMenus = pkg.contributes.menus['view/item/context']
				.filter(entry => (entry.when ?? '').includes('view == quantlab.historyView'));
		});

		test('history entry items have open / cancel / pin / compare menu entries', () => {
			const commands = historyMenus.map(entry => entry.command);
			assert.ok(commands.includes('quantlab.openHistoryEntry'), 'open entry missing');
			assert.ok(commands.includes('quantlab.cancelHistoryRun'), 'cancel entry missing');
			assert.ok(commands.includes('quantlab.history.pinRun'), 'pin entry missing');
			assert.ok(commands.includes('quantlab.history.addToCompare'), 'compare entry missing');
		});

		test('cancel only targets running/queued contextValues; the rest target all entry statuses', () => {
			const entryStatusPattern = '/^quantlab\\.history\\.entry\\./';
			const activePattern = '/^quantlab\\.history\\.entry\\.(running|queued)$/';

			for (const entry of historyMenus) {
				assert.ok(entry.when, `menu entry for ${entry.command} must have a when clause`);
				if (entry.command === 'quantlab.cancelHistoryRun') {
					assert.ok(
						entry.when.includes(activePattern),
						`cancel must be scoped to running/queued, got: ${entry.when}`,
					);
				} else {
					assert.ok(
						entry.when.includes(entryStatusPattern),
						`${entry.command} must match all entry statuses, got: ${entry.when}`,
					);
				}
			}
		});

		test('cancel has an inline (hover) entry in addition to the context-menu entry', () => {
			const cancelGroups = historyMenus
				.filter(entry => entry.command === 'quantlab.cancelHistoryRun')
				.map(entry => entry.group ?? '');
			assert.ok(cancelGroups.some(group => group.startsWith('inline@')), 'inline cancel missing');
			assert.ok(cancelGroups.some(group => !group.startsWith('inline@')), 'context-menu cancel missing');
		});

		test('every command referenced by the history menus is contributed with an NLS title', () => {
			const contributed = new Map(pkg.contributes.commands.map(c => [c.command, c.title]));
			for (const entry of historyMenus) {
				assert.ok(entry.command, 'menu entry without a command');
				const title = contributed.get(entry.command);
				assert.ok(title, `${entry.command} missing from contributes.commands`);
				const key = /^%(.+)%$/.exec(title);
				assert.ok(key, `${entry.command} title must be an %nls% key, got: ${title}`);
				assert.ok(
					Object.prototype.hasOwnProperty.call(nls, key[1]),
					`NLS key ${key[1]} missing from package.nls.json`,
				);
			}
		});

		test('the pin/compare wrappers are hidden from the Command Palette', () => {
			const palette = pkg.contributes.menus['commandPalette'];
			for (const command of ['quantlab.history.pinRun', 'quantlab.history.addToCompare']) {
				const hidden = palette.find(entry => entry.command === command);
				assert.ok(hidden, `${command} must have a commandPalette entry`);
				assert.strictEqual(hidden.when, 'false', `${command} must be palette-hidden (node-arg-only)`);
			}
		});

		test('the wrapper commands are registered in historyCommands.ts and delegate to the action commands', () => {
			const source = readSource('src/commands/historyCommands.ts');
			assert.ok(source.includes(`registerCommand('quantlab.history.pinRun'`), 'pin wrapper not registered');
			assert.ok(source.includes(`registerCommand('quantlab.history.addToCompare'`), 'compare wrapper not registered');
			assert.ok(source.includes(`executeCommand('quantlab.action.pinRun', entryId)`), 'pin wrapper must delegate');
			assert.ok(source.includes(`executeCommand('quantlab.action.addToCompare', entryId)`), 'compare wrapper must delegate');
		});
	});
});

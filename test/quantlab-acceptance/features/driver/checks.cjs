/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FEATURES closing checks (PLAN-FINAL 3.9), run inside the packaged app's extension host
// (--extensionTestsPath). Writes one JSON result to QL_FEATURES_RESULT; the launcher judges it.
// A check that throws is a FAIL with the error's message; nothing here turns an error into a pass.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { ask } = require('../cues.cjs');

const PINNED_IDS = ['ms-python.python', 'detachhead.basedpyright', 'ms-toolsai.jupyter'];
const WAIT_MS = 120 * 1000;
const BACKTEST_RUN_MS = 5 * 60 * 1000;

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`[driver_env_missing] ${name} is not set`);
	}
	return value;
}

/** Polls `probe` until it returns a value other than undefined; throws `what` on timeout, with the last error. */
async function until(what, probe) {
	const deadline = Date.now() + WAIT_MS;
	let last = 'no attempt completed';
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value !== undefined) {
				return value;
			}
			last = 'the probe found nothing yet';
		} catch (err) {
			last = err instanceof Error ? err.message : String(err);
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	throw new Error(`${what} (waited ${WAIT_MS / 1000} s; last: ${last})`);
}

/** PASS only when a connection to the gallery host cannot be made. */
function networkOff() {
	return new Promise(resolve => {
		const socket = net.connect({ host: 'open-vsx.org', port: 443 });
		const done = (status, detail) => { socket.destroy(); resolve({ id: 'network-off', status, detail }); };
		socket.setTimeout(8000);
		socket.on('connect', () => done('FAIL', '[network_on] a TCP connection to open-vsx.org:443 succeeded; the run is void'));
		socket.on('timeout', () => done('PASS', 'open-vsx.org:443 did not answer in 8 s'));
		socket.on('error', err => done('PASS', `open-vsx.org:443 unreachable: ${err.code}`));
	});
}

/** Every pinned extension installed at its pinned version, each miss named. */
function pinReport() {
	const product = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
	const missing = [];
	const lines = [];
	for (const id of PINNED_IDS) {
		const pins = product.builtInExtensions.filter(entry => entry.name.toLowerCase() === id);
		if (pins.length !== 1) {
			throw new Error(`[pins_unreadable] product.json builtInExtensions names ${id} ${pins.length} times`);
		}
		const extension = vscode.extensions.getExtension(id);
		if (extension === undefined) {
			missing.push(id);
			lines.push(`[pinned_dependency_missing] ${id} ${pins[0].version} is pinned in product.json but is not installed in this app`);
		} else if (extension.packageJSON.version !== pins[0].version) {
			missing.push(id);
			lines.push(`[pinned_dependency_version] ${id} is ${extension.packageJSON.version}, product.json pins ${pins[0].version}`);
		}
	}
	return { ok: missing.length === 0, missing, lines };
}

function workspaceFile(name) {
	const folders = vscode.workspace.workspaceFolders;
	if (folders === undefined || folders.length !== 1) {
		throw new Error('[fixture_workspace_missing] the fixture workspace is not the one open folder');
	}
	return vscode.Uri.joinPath(folders[0].uri, name);
}

function positionOf(document, needle, offsetInNeedle) {
	const index = document.getText().indexOf(needle);
	if (index < 0) {
		throw new Error(`[fixture_changed] '${needle}' is not in ${document.uri.fsPath}`);
	}
	return document.positionAt(index + offsetInNeedle);
}

/** Completion, hover and go-to-definition on the fixture, served by basedpyright (python.languageServer None). */
async function pythonIntelligence() {
	const server = vscode.workspace.getConfiguration('python').get('languageServer');
	if (server !== 'None') {
		throw new Error(`[language_server_default] python.languageServer is ${JSON.stringify(server)}, expected "None" (basedpyright is the language server)`);
	}
	const document = await vscode.workspace.openTextDocument(workspaceFile('sample.py'));
	await vscode.window.showTextDocument(document);

	const afterDot = positionOf(document, 'os.pa', 'os.pa'.length);
	const completion = await until('[completion_missing] no completion item `path` after `os.pa`', async () => {
		const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, afterDot);
		const labels = list.items.map(item => typeof item.label === 'string' ? item.label : item.label.label);
		return labels.includes('path') ? labels.length : undefined;
	});

	const onCall = positionOf(document, 'add_numbers(1, 2)', 3);
	const hover = await until('[hover_missing] no hover naming add_numbers with its docstring', async () => {
		const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, onCall);
		const text = hovers.flatMap(h => h.contents).map(c => typeof c === 'string' ? c : c.value).join('\n');
		return text.includes('add_numbers') && text.includes('Return the sum of two integers') ? text.length : undefined;
	});

	const definition = await until('[definition_missing] go-to-definition of add_numbers does not land in helper.py', async () => {
		const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, onCall);
		const hit = locations.map(l => ({ uri: l.targetUri || l.uri, range: l.targetSelectionRange || l.targetRange || l.range }))
			.find(l => path.basename(l.uri.fsPath) === 'helper.py');
		return hit === undefined ? undefined : `helper.py:${hit.range.start.line + 1}`;
	});

	const pyright = vscode.extensions.getExtension('detachhead.basedpyright');
	if (pyright === undefined || !pyright.isActive) {
		throw new Error('[language_server_inactive] detachhead.basedpyright is not active after the three requests');
	}
	return { status: 'PASS', detail: `completion: path among ${completion} items; hover: ${hover} chars with the docstring; definition: ${definition}; server basedpyright ${pyright.packageJSON.version}` };
}

/** The fixture notebook's one cell runs on the declared interpreter and prints 42. */
async function notebookCell() {
	const python = requireEnv('QL_FEATURES_PYTHON');
	const pythonExtension = vscode.extensions.getExtension('ms-python.python');
	const jupyterExtension = vscode.extensions.getExtension('ms-toolsai.jupyter');
	if (pythonExtension === undefined || jupyterExtension === undefined) {
		throw new Error('[notebook_extensions_missing] ms-python.python or ms-toolsai.jupyter is not installed');
	}
	const pythonApi = await pythonExtension.activate();
	const jupyterApi = await jupyterExtension.activate();
	const environment = await pythonApi.environments.resolveEnvironment(python);
	if (environment === undefined) {
		throw new Error(`[interpreter_unresolved] the Python extension cannot resolve the declared interpreter ${python}`);
	}
	if (typeof jupyterApi.openNotebook !== 'function') {
		throw new Error('[jupyter_api_changed] the Jupyter extension exports no openNotebook(uri, environment)');
	}
	const uri = workspaceFile('fixture.ipynb');
	const notebook = await jupyterApi.openNotebook(uri, environment);
	await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [{ start: 0, end: 1 }], document: uri });
	const printed = await until('[notebook_no_output] the cell produced no output containing 42', async () => {
		const decoder = new TextDecoder();
		const text = notebook.cellAt(0).outputs.flatMap(output => output.items).map(item => decoder.decode(item.data)).join('');
		return text.includes('42') ? text.trim() : undefined;
	});
	const summary = notebook.cellAt(0).executionSummary;
	if (summary === undefined || summary.success !== true) {
		throw new Error(`[notebook_cell_failed] the cell printed ${JSON.stringify(printed)} but its execution summary is ${JSON.stringify(summary)}`);
	}
	return { status: 'PASS', detail: `fixture.ipynb cell 1 on ${python} printed ${JSON.stringify(printed)}` };
}

/** The extension's run folders: `<user data>/User/globalStorage/quantlab.quantlab/quantlab/runs/<jobId>/`. */
function runsDir() {
	return path.join(requireEnv('QL_FEATURES_USER_DATA'), 'User', 'globalStorage', 'quantlab.quantlab', 'quantlab', 'runs');
}

/**
 * A backtest of the fixture strategy on the fixture bars, started from the Action view as a user does,
 * runs on the BUNDLED engine of this app: the run's first log line names an executable inside the app.
 */
async function backtestBundledEngine() {
	const strategy = workspaceFile('strategy_sma.py');
	const bars = workspaceFile('bars.csv').fsPath;
	const rows = fs.readFileSync(bars, 'utf8').trim().split('\n');
	const first = rows[1].split(',')[0];
	const last = rows[rows.length - 1].split(',')[0];
	if (fs.existsSync(runsDir())) {
		throw new Error(`[runs_not_fresh] ${runsDir()} exists before the backtest; the profile is not fresh`);
	}

	await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(strategy));
	await vscode.commands.executeCommand('quantlab.action.openResource', 'offline-backtest');
	const ui = await ask(requireEnv('QL_FEATURES_CUES'), 'backtest-form', {
		values: { dataSource: bars, dateStart: first, dateEnd: last },
		runTimeoutMs: BACKTEST_RUN_MS,
	}, BACKTEST_RUN_MS + 120 * 1000);
	if (ui.status !== 'completed') {
		throw new Error(`[backtest_not_completed] the Action view shows status ${ui.status}: ${ui.error || ui.meta} (fields not found: ${ui.missingFields.join(', ') || 'none'})`);
	}

	const runs = fs.readdirSync(runsDir()).filter(name => name.startsWith('backtest-'));
	if (runs.length !== 1) {
		throw new Error(`[backtest_runs] expected one backtest run folder in ${runsDir()}, found [${runs.join(', ')}]`);
	}
	const folder = path.join(runsDir(), runs[0]);
	const result = JSON.parse(fs.readFileSync(path.join(folder, 'result.json'), 'utf8'));
	const metrics = Object.keys(result.metrics ?? {});
	if (metrics.length === 0) {
		throw new Error(`[backtest_no_metrics] ${path.join(folder, 'result.json')} holds no metrics`);
	}
	const logs = JSON.parse(fs.readFileSync(path.join(folder, 'logs.json'), 'utf8'));
	const start = logs.find(entry => entry.message.startsWith('Starting backtest job: '));
	if (start === undefined) {
		throw new Error(`[engine_unnamed] no "Starting backtest job:" line among ${logs.length} log lines of ${runs[0]}`);
	}
	const match = /^Starting backtest job: (.+) -m quantlab\.cli\.run_backtest \(([^;]+); cwd /.exec(start.message);
	const appRoot = vscode.env.appRoot;
	if (match === null || match[2] !== 'bundled engine' || !match[1].startsWith(`${appRoot}${path.sep}`)) {
		throw new Error(`[engine_not_bundled] the run did not use this app's bundled engine (app root ${appRoot}): ${start.message}`);
	}
	return { status: 'PASS', detail: `${runs[0]}: ${ui.meta}; ${metrics.length} metrics (${metrics.slice(0, 3).join(', ')}); engine ${path.relative(appRoot, match[1])}` };
}

const IMPORT_SETTINGS = { 'editor.fontSize': 17, 'files.trimTrailingWhitespace': true };
const IMPORT_KEYBINDING = { key: 'ctrl+alt+q', command: 'workbench.action.files.saveAll' };
const IMPORT_EXTENSION = 'ms-python.python';

/**
 * Import from a VS Code profile planted in this run's HOME: the settings, the keybinding and the
 * extension set arrive in the app's user directory; the user's previous settings are backed up.
 */
async function importFromVsCode() {
	const home = os.homedir();
	if (home !== requireEnv('HOME')) {
		throw new Error(`[home_mismatch] the extension host's home is ${home}, the run set HOME=${process.env.HOME}`);
	}
	const source = path.join(home, 'Library', 'Application Support', 'Code', 'User');
	fs.mkdirSync(source, { recursive: true });
	fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify(IMPORT_SETTINGS));
	fs.writeFileSync(path.join(source, 'keybindings.json'), JSON.stringify([IMPORT_KEYBINDING]));
	fs.mkdirSync(path.join(home, '.vscode', 'extensions'), { recursive: true });
	fs.writeFileSync(path.join(home, '.vscode', 'extensions', 'extensions.json'), JSON.stringify([{ identifier: { id: IMPORT_EXTENSION } }]));

	const user = path.join(requireEnv('QL_FEATURES_USER_DATA'), 'User');
	const before = JSON.parse(fs.readFileSync(path.join(user, 'settings.json'), 'utf8'));
	const command = vscode.commands.executeCommand('quantlab.importFromEditor');
	const modal = await ask(requireEnv('QL_FEATURES_CUES'), 'import-modal', { message: 'Import settings, keybindings and extensions from VS Code?', button: 'Import' }, 120 * 1000);
	await command;

	const settings = JSON.parse(fs.readFileSync(path.join(user, 'settings.json'), 'utf8'));
	for (const [key, value] of Object.entries({ ...before, ...IMPORT_SETTINGS })) {
		if (JSON.stringify(settings[key]) !== JSON.stringify(value)) {
			throw new Error(`[import_setting] ${key} is ${JSON.stringify(settings[key])} after the import, expected ${JSON.stringify(value)}`);
		}
	}
	const keybindings = JSON.parse(fs.readFileSync(path.join(user, 'keybindings.json'), 'utf8'));
	if (!keybindings.some(k => k.key === IMPORT_KEYBINDING.key && k.command === IMPORT_KEYBINDING.command)) {
		throw new Error(`[import_keybinding] ${IMPORT_KEYBINDING.key} -> ${IMPORT_KEYBINDING.command} is not in ${path.join(user, 'keybindings.json')}`);
	}
	const backups = fs.readdirSync(user).filter(name => name.startsWith('settings.json.pre-import-'));
	if (backups.length !== 1 || JSON.stringify(JSON.parse(fs.readFileSync(path.join(user, backups[0]), 'utf8'))) !== JSON.stringify(before)) {
		throw new Error(`[import_backup] expected one backup holding the previous settings, found [${backups.join(', ')}]`);
	}
	const report = vscode.workspace.textDocuments.find(document => document.getText().startsWith('Import from VS Code'));
	if (report === undefined) {
		throw new Error('[import_no_report] no "Import from VS Code" report document is open');
	}
	const extensionsLine = report.getText().split('\n').find(line => line.startsWith('Extensions: '));
	if (extensionsLine !== 'Extensions: 0 installed, 1 already installed, 0 not imported') {
		throw new Error(`[import_extensions] the report says ${JSON.stringify(extensionsLine)}, expected ${IMPORT_EXTENSION} already installed`);
	}
	return { status: 'PASS', detail: `modal "${modal.text}" -> Import; settings ${Object.keys(IMPORT_SETTINGS).join(', ')}; keybinding ${IMPORT_KEYBINDING.key}; ${extensionsLine}; backup ${backups[0]}` };
}

async function guarded(check) {
	try {
		return await check();
	} catch (err) {
		return { status: 'FAIL', detail: err instanceof Error ? err.message : String(err) };
	}
}

exports.run = async function () {
	const resultPath = requireEnv('QL_FEATURES_RESULT');
	const mode = requireEnv('QL_FEATURES_MODE');
	const result = { mode, pins: pinReport() };
	if (mode === 'all') {
		result.network = await networkOff();
		result.checks = {
			'python-intelligence': await guarded(pythonIntelligence),
			'notebook-cell': await guarded(notebookCell),
			// These two drive the window through the launcher (cues.cjs); import runs last because it changes the settings.
			'backtest-bundled-engine': await guarded(backtestBundledEngine),
			'import': await guarded(importFromVsCode),
		};
	} else if (mode !== 'pins') {
		throw new Error(`[driver_mode_invalid] QL_FEATURES_MODE is ${JSON.stringify(mode)} (expected all or pins)`);
	}
	fs.writeFileSync(resultPath, JSON.stringify(result, undefined, '\t') + '\n');
};

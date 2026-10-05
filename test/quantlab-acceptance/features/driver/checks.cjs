/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FEATURES closing checks (PLAN-FINAL 3.9), run inside the packaged app's extension host
// (--extensionTestsPath). Writes one JSON result to QL_FEATURES_RESULT; the launcher judges it.
// A check that throws is a FAIL with the error's message; nothing here turns an error into a pass.

const fs = require('fs');
const net = require('net');
const path = require('path');
const vscode = require('vscode');

const PINNED_IDS = ['ms-python.python', 'detachhead.basedpyright', 'ms-toolsai.jupyter'];
const WAIT_MS = 120 * 1000;

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
			// Not driven yet: both need the window driven from outside the extension host (the next unit).
			'backtest-bundled-engine': { status: 'NOT RUN', detail: '[driver_not_written] a backtest starts from the Action view webview, which has no command; needs the window driver' },
			'import': { status: 'NOT RUN', detail: '[driver_not_written] quantlab.importFromEditor confirms through a modal dialog; needs the window driver' },
		};
	} else if (mode !== 'pins') {
		throw new Error(`[driver_mode_invalid] QL_FEATURES_MODE is ${JSON.stringify(mode)} (expected all or pins)`);
	}
	fs.writeFileSync(resultPath, JSON.stringify(result, undefined, '\t') + '\n');
};

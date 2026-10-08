/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatReport, ImportPorts, runImport } from './importer';
import { importTarget } from './targets';
import { EditorKind, editorExtensionsDir, editorLabel, editorUserDir, isEnoent, readEditorSnapshot } from './sources';

interface EditorCandidate {
	kind: EditorKind;
	userDir: string;
	extensionsDir: string;
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.promises.stat(file);
		return true;
	} catch (err: unknown) {
		if (isEnoent(err)) {
			return false;
		}
		throw err;
	}
}

async function isAvailable(candidate: EditorCandidate): Promise<boolean> {
	return await exists(path.join(candidate.userDir, 'settings.json'))
		|| await exists(path.join(candidate.userDir, 'keybindings.json'))
		|| await exists(path.join(candidate.extensionsDir, 'extensions.json'));
}

async function importFromEditor(): Promise<void> {
	const kinds: EditorKind[] = ['vscode', 'cursor'];
	const candidates: EditorCandidate[] = kinds.map(kind => ({
		kind,
		userDir: editorUserDir(kind, process.platform, process.env),
		extensionsDir: editorExtensionsDir(kind, process.platform, process.env),
	}));

	const available: EditorCandidate[] = [];
	for (const candidate of candidates) {
		if (await isAvailable(candidate)) {
			available.push(candidate);
		}
	}

	if (available.length === 0) {
		void vscode.window.showInformationMessage(
			`Quantlab: nothing to import. No settings, keybindings or extensions found in ${candidates.map(c => `${c.userDir} or ${c.extensionsDir}`).join(', or ')}.`
		);
		return;
	}

	let source = available[0];
	if (available.length > 1) {
		const picked = await vscode.window.showQuickPick(
			available.map(candidate => ({ label: editorLabel(candidate.kind), description: candidate.userDir, candidate })),
			{ placeHolder: 'Import settings, keybindings and extensions from…' }
		);
		if (!picked) {
			return;
		}
		source = picked.candidate;
	}

	const target = await importTarget(command => vscode.commands.executeCommand(command));
	const confirmed = await vscode.window.showWarningMessage(
		`Import settings, keybindings and extensions from ${editorLabel(source.kind)}?`,
		{
			modal: true,
			detail: `Reads ${source.userDir} and ${source.extensionsDir}. Imported values replace your current values for the same settings. `
				+ `Your current settings and keybindings are saved beside the originals before anything is written.`,
		},
		'Import'
	);
	if (confirmed !== 'Import') {
		return;
	}

	const ports: ImportPorts = {
		fs: {
			readFile: file => fs.promises.readFile(file, 'utf8'),
			writeFile: (file, text) => fs.promises.writeFile(file, text, 'utf8'),
			// COPYFILE_EXCL: a backup is never overwritten (EEXIST makes the importer pick the next name).
			copyFile: (from, to) => fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL),
		},
		gallery: {
			isInstalled: id => vscode.extensions.getExtension(id) !== undefined,
			install: async id => { await vscode.commands.executeCommand('workbench.extensions.installExtension', id); },
		},
		now: () => new Date(),
	};

	const report = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Quantlab: Importing…', cancellable: false },
		async () => runImport(await readEditorSnapshot(source.kind, source.userDir, source.extensionsDir, ports.fs), target, ports)
	);

	const document = await vscode.workspace.openTextDocument({ content: formatReport(report), language: 'plaintext' });
	await vscode.window.showTextDocument(document);
}

export function registerImportCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand('quantlab.importFromEditor', async () => {
		try {
			await importFromEditor();
		} catch (err: unknown) {
			void vscode.window.showErrorMessage(`Quantlab: import failed. ${err instanceof Error ? err.message : String(err)}`);
			throw err;
		}
	}));
}

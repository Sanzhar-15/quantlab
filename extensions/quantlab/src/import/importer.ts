/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ExtensionsOutcome, GalleryPort, importExtensions } from './extensions';
import { isPlainObject, parseJsonc } from './jsonc';
import { mergeKeybindings, mergeSettings } from './merge';
import { EditorKind, EditorSnapshot, editorLabel, readOptional } from './sources';

export interface ImportPorts {
	fs: {
		/** Rejects with a Node-style error carrying `.code` (ENOENT when the file does not exist). */
		readFile(path: string): Promise<string>;
		writeFile(path: string, text: string): Promise<void>;
		/** Creates `to` exclusively: rejects with a Node-style error carrying `.code` EEXIST when `to` already exists, and never overwrites it. */
		copyFile(from: string, to: string): Promise<void>;
	};
	gallery: GalleryPort;
	now(): Date;
}

export interface ImportTarget {
	settingsPath: string;
	keybindingsPath: string;
}

export interface ImportReport {
	source: EditorKind;
	userDir: string;
	missing: string[];
	settings: { added: string[]; overwritten: string[]; unchanged: string[]; backup: string | undefined } | undefined;
	keybindings: { added: number; duplicates: number; backup: string | undefined } | undefined;
	extensions: ExtensionsOutcome;
}

function backupStamp(now: Date): string {
	// 2026-10-05T14:16:53.000Z -> 20261005T141653Z
	return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** How many backups of one file taken in the same second are told apart before the import gives up. */
const MAX_BACKUPS_PER_STAMP = 1000;

/**
 * Writes `text` to `target`; a target that already exists is first copied beside itself, to a name that
 * did not exist (`<target>.pre-import-<second>`, then `-1`, `-2`, ... when another backup took the name:
 * the copy is exclusive, so a backup is never overwritten).
 * Returns the backup path, or `undefined` when there was nothing to back up.
 */
async function writeWithBackup(ports: ImportPorts, target: string, existed: boolean, text: string): Promise<string | undefined> {
	let backup: string | undefined;
	if (existed) {
		const base = `${target}.pre-import-${backupStamp(ports.now())}`;
		for (let n = 0; backup === undefined; n++) {
			if (n >= MAX_BACKUPS_PER_STAMP) {
				throw new Error(`[backup_names_exhausted] Quantlab: ${MAX_BACKUPS_PER_STAMP} backups named ${base}[-n] already exist; nothing was written to ${target}.`);
			}
			const candidate = n === 0 ? base : `${base}-${n}`;
			try {
				await ports.fs.copyFile(target, candidate);
				backup = candidate;
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw err;
				}
			}
		}
	}
	await ports.fs.writeFile(target, text);
	return backup;
}

// One import at a time: an import reads the target files, merges and writes them back, so two interleaved
// imports would lose one another's changes. A second import while one is running is REFUSED by name (not
// queued): the user sees why, and nothing waits on state it cannot see.
let importInFlight = false;

export async function runImport(snapshot: EditorSnapshot, target: ImportTarget, ports: ImportPorts): Promise<ImportReport> {
	if (importInFlight) {
		throw new Error('[import_in_progress] Quantlab: another import is still running; wait for it to finish, then import again.');
	}
	importInFlight = true;
	try {
		return await importOnce(snapshot, target, ports);
	} finally {
		importInFlight = false;
	}
}

async function importOnce(snapshot: EditorSnapshot, target: ImportTarget, ports: ImportPorts): Promise<ImportReport> {
	let settings: ImportReport['settings'];
	if (snapshot.settings !== undefined) {
		const text = await readOptional(ports.fs, target.settingsPath);
		let existing: Record<string, unknown> = {};
		if (text !== undefined) {
			const parsed = parseJsonc(text, target.settingsPath);
			if (!isPlainObject(parsed)) {
				throw new Error(`${target.settingsPath}: expected a JSON object`);
			}
			existing = parsed;
		}
		const merge = mergeSettings(existing, snapshot.settings);
		const backup = await writeWithBackup(ports, target.settingsPath, text !== undefined, JSON.stringify(merge.merged, undefined, '\t') + '\n');
		settings = { added: merge.added, overwritten: merge.overwritten, unchanged: merge.unchanged, backup };
	}

	let keybindings: ImportReport['keybindings'];
	if (snapshot.keybindings !== undefined) {
		const text = await readOptional(ports.fs, target.keybindingsPath);
		let existing: unknown[] = [];
		if (text !== undefined) {
			const parsed = parseJsonc(text, target.keybindingsPath);
			if (!Array.isArray(parsed)) {
				throw new Error(`${target.keybindingsPath}: expected a JSON array`);
			}
			existing = parsed;
		}
		const merge = mergeKeybindings(existing, snapshot.keybindings);
		const backup = await writeWithBackup(ports, target.keybindingsPath, text !== undefined, JSON.stringify(merge.merged, undefined, '\t') + '\n');
		keybindings = { added: merge.added, duplicates: merge.duplicates, backup };
	}

	const extensions = await importExtensions(snapshot.extensionIds, ports.gallery);

	return { source: snapshot.kind, userDir: snapshot.userDir, missing: snapshot.missing, settings, keybindings, extensions };
}

export function formatReport(report: ImportReport): string {
	const lines: string[] = [];
	lines.push(`Import from ${editorLabel(report.source)}`);
	lines.push(`Source: ${report.userDir}`);
	lines.push('');

	if (report.missing.length > 0) {
		lines.push('Source files not found (nothing imported from them):');
		for (const file of report.missing) {
			lines.push(`  ${file}`);
		}
		lines.push('');
	}

	if (report.settings !== undefined) {
		const s = report.settings;
		lines.push(`Settings: ${s.added.length} added, ${s.overwritten.length} overwritten, ${s.unchanged.length} unchanged`);
		for (const key of s.added) {
			lines.push(`  added: ${key}`);
		}
		for (const key of s.overwritten) {
			lines.push(`  overwritten: ${key}`);
		}
		lines.push(s.backup !== undefined ? `  previous settings saved to: ${s.backup}` : '  no previous settings file (nothing to back up)');
		lines.push('');
	}

	if (report.keybindings !== undefined) {
		const k = report.keybindings;
		lines.push(`Keybindings: ${k.added} added, ${k.duplicates} already present`);
		lines.push(k.backup !== undefined ? `  previous keybindings saved to: ${k.backup}` : '  no previous keybindings file (nothing to back up)');
		lines.push('');
	}

	const e = report.extensions;
	lines.push(`Extensions: ${e.installed.length} installed, ${e.alreadyInstalled.length} already installed, ${e.unresolved.length} not imported`);
	for (const id of e.installed) {
		lines.push(`  installed: ${id}`);
	}
	for (const id of e.alreadyInstalled) {
		lines.push(`  already installed: ${id}`);
	}
	if (e.unresolved.length > 0) {
		lines.push('');
		lines.push('Not imported (not available from the extension gallery or failed to install):');
		for (const item of e.unresolved) {
			lines.push(`  ${item.id}: ${item.reason}`);
		}
	}

	return lines.join('\n') + '\n';
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { isPlainObject, parseJsonc } from './jsonc';

/**
 * QL-IMPORT: where a VS Code / Cursor installation keeps its user data, and a read-only snapshot of it.
 * No `vscode` import: everything here takes its platform, environment and file system as arguments.
 */

export type EditorKind = 'vscode' | 'cursor';

export interface EditorEnv {
	HOME?: string;
	APPDATA?: string;
	USERPROFILE?: string;
}

export interface ReadPort {
	/** Rejects with a Node-style error carrying `.code` (ENOENT when the file does not exist). */
	readFile(path: string): Promise<string>;
}

export interface EditorSnapshot {
	kind: EditorKind;
	userDir: string;
	settings: Record<string, unknown> | undefined;
	keybindings: unknown[] | undefined;
	extensionIds: string[];
	/** Absolute paths of the source files that do not exist (expected absences, reported). */
	missing: string[];
}

export function editorLabel(kind: EditorKind): string {
	return kind === 'vscode' ? 'VS Code' : 'Cursor';
}

function required(env: EditorEnv, name: keyof EditorEnv, what: string): string {
	const value = env[name];
	if (value === undefined || value === '') {
		throw new Error(`${what}: environment variable ${name} is not set`);
	}
	return value;
}

/** The `User` directory holding `settings.json` and `keybindings.json`. */
export function editorUserDir(kind: EditorKind, platform: NodeJS.Platform, env: EditorEnv): string {
	const appDir = kind === 'vscode' ? 'Code' : 'Cursor';
	const what = `Cannot locate the ${editorLabel(kind)} user directory`;
	switch (platform) {
		case 'darwin':
			return path.posix.join(required(env, 'HOME', what), 'Library', 'Application Support', appDir, 'User');
		case 'win32':
			return path.win32.join(required(env, 'APPDATA', what), appDir, 'User');
		case 'linux':
			return path.posix.join(required(env, 'HOME', what), '.config', appDir, 'User');
		default:
			throw new Error(`${what}: unsupported platform ${platform}`);
	}
}

/** The directory holding the installed extensions and their `extensions.json`. */
export function editorExtensionsDir(kind: EditorKind, platform: NodeJS.Platform, env: EditorEnv): string {
	const dotDir = kind === 'vscode' ? '.vscode' : '.cursor';
	const what = `Cannot locate the ${editorLabel(kind)} extensions directory`;
	switch (platform) {
		case 'darwin':
		case 'linux':
			return path.posix.join(required(env, 'HOME', what), dotDir, 'extensions');
		case 'win32':
			return path.win32.join(required(env, 'USERPROFILE', what), dotDir, 'extensions');
		default:
			throw new Error(`${what}: unsupported platform ${platform}`);
	}
}

export function isEnoent(err: unknown): boolean {
	return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/** The file's text, or `undefined` when it does not exist (ENOENT). Every other error propagates. */
export async function readOptional(fsPort: ReadPort, file: string): Promise<string | undefined> {
	try {
		return await fsPort.readFile(file);
	} catch (err: unknown) {
		if (isEnoent(err)) {
			return undefined;
		}
		throw err;
	}
}

function parseExtensionIds(value: unknown, file: string): string[] {
	if (!Array.isArray(value)) {
		throw new Error(`${file}: expected a JSON array of installed extensions`);
	}
	const seen = new Set<string>();
	const ids: string[] = [];
	value.forEach((entry: unknown, index: number) => {
		const identifier = isPlainObject(entry) ? entry['identifier'] : undefined;
		const id = isPlainObject(identifier) ? identifier['id'] : undefined;
		if (typeof id !== 'string' || id === '') {
			throw new Error(`${file}: entry ${index} has no identifier.id`);
		}
		const lower = id.toLowerCase();
		if (!seen.has(lower)) {
			seen.add(lower);
			ids.push(lower);
		}
	});
	return ids;
}

export async function readEditorSnapshot(kind: EditorKind, userDir: string, extensionsDir: string, fsPort: ReadPort): Promise<EditorSnapshot> {
	const missing: string[] = [];

	const settingsFile = path.join(userDir, 'settings.json');
	const settingsText = await readOptional(fsPort, settingsFile);
	let settings: Record<string, unknown> | undefined;
	if (settingsText === undefined) {
		missing.push(settingsFile);
	} else {
		const parsed = parseJsonc(settingsText, settingsFile);
		if (!isPlainObject(parsed)) {
			throw new Error(`${settingsFile}: expected a JSON object`);
		}
		settings = parsed;
	}

	const keybindingsFile = path.join(userDir, 'keybindings.json');
	const keybindingsText = await readOptional(fsPort, keybindingsFile);
	let keybindings: unknown[] | undefined;
	if (keybindingsText === undefined) {
		missing.push(keybindingsFile);
	} else {
		const parsed = parseJsonc(keybindingsText, keybindingsFile);
		if (!Array.isArray(parsed)) {
			throw new Error(`${keybindingsFile}: expected a JSON array`);
		}
		keybindings = parsed;
	}

	const extensionsFile = path.join(extensionsDir, 'extensions.json');
	const extensionsText = await readOptional(fsPort, extensionsFile);
	let extensionIds: string[] = [];
	if (extensionsText === undefined) {
		missing.push(extensionsFile);
	} else {
		extensionIds = parseExtensionIds(parseJsonc(extensionsText, extensionsFile), extensionsFile);
	}

	return { kind, userDir, settings, keybindings, extensionIds, missing };
}

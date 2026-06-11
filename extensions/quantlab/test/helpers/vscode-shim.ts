/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal vscode-API shim for unit-testing extension-host modules
 * without the real VS Code runtime. Step C megaudit follow-up:
 * provider integration was untested because its module depended on
 * the real `vscode` module which isn't available under plain mocha.
 *
 * Surface: exactly what the qviz code requires today. Adding new
 * surface (e.g., `commands`) is fine; keeping the shim minimal makes
 * it obvious which capabilities the production code depends on.
 *
 * Install: use `installVscodeShim()` once at the top of a test file
 * (mocha registers tests synchronously at suite-body time). It hooks
 * `Module._resolveFilename` so any subsequent `import * as vscode
 * from 'vscode'` resolves to the shim instead of failing with
 * MODULE_NOT_FOUND.
 */

import { Module } from 'module';
import * as nodePath from 'path';

// ---------------------------------------------------------------------------
// Uri
// ---------------------------------------------------------------------------

export class Uri {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly query: string;
	readonly fragment: string;

	private constructor(scheme: string, authority: string, path: string, query = '', fragment = '') {
		this.scheme = scheme;
		this.authority = authority;
		this.path = path;
		this.query = query;
		this.fragment = fragment;
	}

	static file(fsPath: string): Uri {
		// Normalize: leading slash for POSIX paths.
		const path = fsPath.startsWith('/') ? fsPath : '/' + fsPath;
		return new Uri('file', '', path);
	}

	static parse(uriString: string): Uri {
		// Minimal: only handle `file://` and `quantlab-X://` schemes.
		const m = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/[^?#]*)(\?[^#]*)?(#.*)?$/i.exec(uriString);
		if (!m) {
			// Not a fully-qualified URI; treat as a path.
			return new Uri('file', '', uriString.startsWith('/') ? uriString : '/' + uriString);
		}
		return new Uri(m[1], m[2], m[3], m[4] ? m[4].slice(1) : '', m[5] ? m[5].slice(1) : '');
	}

	static joinPath(base: Uri, ...segments: string[]): Uri {
		const joined = nodePath.posix.join(base.path, ...segments);
		return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
	}

	// W2 error-surface: the Quantbook diagnostics bridge builds `quantbook://` uris via `Uri.from`.
	static from(components: { scheme: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
		return new Uri(
			components.scheme,
			components.authority ?? '',
			components.path ?? '',
			components.query ?? '',
			components.fragment ?? '',
		);
	}

	get fsPath(): string {
		return this.path;
	}

	toString(): string {
		// Simplified — just enough for use as a Map key.
		let s = `${this.scheme}://${this.authority}${this.path}`;
		if (this.query) { s += '?' + this.query; }
		if (this.fragment) { s += '#' + this.fragment; }
		return s;
	}
}

// ---------------------------------------------------------------------------
// Disposable
// ---------------------------------------------------------------------------

export class Disposable {
	private readonly _dispose: () => void;
	constructor(callOnDispose: () => void) {
		this._dispose = callOnDispose;
	}
	dispose(): void { this._dispose(); }

	static from(...disposables: { dispose(): unknown }[]): Disposable {
		// Match real vscode `Disposable.from` semantics: iterate in
		// order; if any dispose throws, the error propagates and the
		// remaining disposables are NOT called. Tests using this shim
		// should observe production behavior accurately.
		return new Disposable(() => {
			for (const d of disposables) { d.dispose(); }
		});
	}
}

// ---------------------------------------------------------------------------
// EventEmitter
// ---------------------------------------------------------------------------

export class EventEmitter<T> {
	private listeners: ((e: T) => void)[] = [];

	get event(): (listener: (e: T) => void) => Disposable {
		return (listener) => {
			this.listeners.push(listener);
			return new Disposable(() => {
				const idx = this.listeners.indexOf(listener);
				if (idx >= 0) { this.listeners.splice(idx, 1); }
			});
		};
	}

	fire(data: T): void {
		for (const l of [...this.listeners]) { l(data); }
	}

	dispose(): void {
		this.listeners.length = 0;
	}
}

// ---------------------------------------------------------------------------
// Position / Range / Diagnostic / DiagnosticCollection (W2 error-surface)
// ---------------------------------------------------------------------------

export class Position {
	constructor(readonly line: number, readonly character: number) { }
}

export class Range {
	readonly start: Position;
	readonly end: Position;
	constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
		this.start = new Position(startLine, startCharacter);
		this.end = new Position(endLine, endCharacter);
	}
}

export enum DiagnosticSeverity {
	Error = 0,
	Warning = 1,
	Information = 2,
	Hint = 3,
}

export class Diagnostic {
	source?: string;
	code?: string | number;
	constructor(
		readonly range: Range,
		readonly message: string,
		readonly severity: DiagnosticSeverity = DiagnosticSeverity.Error,
	) { }
}

/** Minimal in-memory DiagnosticCollection mirroring the real set/get/delete semantics. */
export class FakeDiagnosticCollection {
	private readonly map = new Map<string, Diagnostic[]>();
	constructor(readonly name: string) { }
	set(uri: Uri, diagnostics: Diagnostic[]): void {
		this.map.set(uri.toString(), [...diagnostics]);
	}
	get(uri: Uri): readonly Diagnostic[] | undefined {
		return this.map.get(uri.toString());
	}
	delete(uri: Uri): void {
		this.map.delete(uri.toString());
	}
	clear(): void {
		this.map.clear();
	}
	dispose(): void {
		this.map.clear();
	}
	/** Test-only: total number of uris currently holding diagnostics. */
	_uriCount(): number {
		return this.map.size;
	}
}

export const languages = {
	createDiagnosticCollection(name: string): FakeDiagnosticCollection {
		return new FakeDiagnosticCollection(name);
	},
};

// ---------------------------------------------------------------------------
// RelativePattern
// ---------------------------------------------------------------------------

export class RelativePattern {
	constructor(readonly base: Uri, readonly pattern: string) { }
}

// ---------------------------------------------------------------------------
// FileSystemWatcher — fully controllable via _trigger* methods
// ---------------------------------------------------------------------------

export class FakeFileSystemWatcher {
	private readonly _onDidChange = new EventEmitter<Uri>();
	private readonly _onDidCreate = new EventEmitter<Uri>();
	private readonly _onDidDelete = new EventEmitter<Uri>();
	readonly onDidChange = this._onDidChange.event;
	readonly onDidCreate = this._onDidCreate.event;
	readonly onDidDelete = this._onDidDelete.event;
	disposed = false;
	constructor(readonly pattern: RelativePattern) { }
	dispose(): void {
		this.disposed = true;
		this._onDidChange.dispose();
		this._onDidCreate.dispose();
		this._onDidDelete.dispose();
	}
	_triggerChange(): void { this._onDidChange.fire(Uri.file(this.pattern.pattern)); }
	_triggerCreate(): void { this._onDidCreate.fire(Uri.file(this.pattern.pattern)); }
	_triggerDelete(): void { this._onDidDelete.fire(Uri.file(this.pattern.pattern)); }
}

// ---------------------------------------------------------------------------
// workspace / window — backed by mutable state the test can configure
// ---------------------------------------------------------------------------

export interface WorkspaceFolder {
	readonly uri: Uri;
	readonly name: string;
	readonly index: number;
}

const state = {
	workspaceFolders: [] as WorkspaceFolder[],
	fsFiles: new Map<string, Uint8Array>(),
	fsWrites: [] as { path: string; bytes: Uint8Array }[],
	fsWriteThrows: null as Error | null,
	errorMessages: [] as string[],
	createdWatchers: [] as FakeFileSystemWatcher[],
	commandsExecuted: [] as { command: string; args: unknown[] }[],
};

export function _resetShimState(): void {
	state.workspaceFolders = [];
	state.fsFiles.clear();
	state.fsWrites.length = 0;
	state.fsWriteThrows = null;
	state.errorMessages.length = 0;
	state.createdWatchers.length = 0;
	state.commandsExecuted.length = 0;
}

export function _setWorkspaceFolders(folders: { uri: Uri; name: string }[]): void {
	state.workspaceFolders = folders.map((f, i) => ({ ...f, index: i }));
}

export function _setFile(absPath: string, bytes: Uint8Array): void {
	state.fsFiles.set(absPath, bytes);
}

export function _writesSnapshot(): { path: string; bytes: Uint8Array }[] {
	return state.fsWrites.map(w => ({ path: w.path, bytes: w.bytes }));
}

export function _setFsWriteThrows(err: Error | null): void {
	state.fsWriteThrows = err;
}

export function _errorMessagesSnapshot(): readonly string[] {
	return [...state.errorMessages];
}

export function _createdWatchers(): FakeFileSystemWatcher[] {
	return [...state.createdWatchers];
}

export const workspace = {
	get workspaceFolders(): WorkspaceFolder[] | undefined {
		return state.workspaceFolders.length === 0 ? undefined : state.workspaceFolders;
	},
	getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined {
		// Segment-boundary match: `/tmp/ws2/file` must NOT match
		// workspace `/tmp/ws`. Also prefer the LONGEST-matching folder
		// when multiple roots are configured (real vscode's behavior).
		const uriPath = uri.fsPath;
		let best: { folder: WorkspaceFolder; rootLen: number } | null = null;
		for (const f of state.workspaceFolders) {
			const root = f.uri.fsPath;
			if (uriPath === root) {
				if (best === null || root.length > best.rootLen) {
					best = { folder: f, rootLen: root.length };
				}
				continue;
			}
			// Require a path separator at the boundary so `/tmp/ws` does
			// not match `/tmp/ws2/...`.
			const withSep = root.endsWith('/') || root.endsWith('\\')
				? root
				: root + '/';
			if (uriPath.startsWith(withSep)) {
				if (best === null || root.length > best.rootLen) {
					best = { folder: f, rootLen: root.length };
				}
			}
		}
		return best === null ? undefined : best.folder;
	},
	createFileSystemWatcher(pattern: RelativePattern): FakeFileSystemWatcher {
		const w = new FakeFileSystemWatcher(pattern);
		state.createdWatchers.push(w);
		return w;
	},
	fs: {
		async readFile(uri: Uri): Promise<Uint8Array> {
			const bytes = state.fsFiles.get(uri.fsPath);
			if (bytes === undefined) {
				const err = new Error(`shim: file not found: ${uri.fsPath}`);
				(err as NodeJS.ErrnoException).code = 'ENOENT';
				throw err;
			}
			return bytes;
		},
		async writeFile(uri: Uri, bytes: Uint8Array): Promise<void> {
			if (state.fsWriteThrows !== null) {
				throw state.fsWriteThrows;
			}
			state.fsWrites.push({ path: uri.fsPath, bytes });
			state.fsFiles.set(uri.fsPath, bytes);
		},
		async delete(uri: Uri): Promise<void> {
			state.fsFiles.delete(uri.fsPath);
		},
		// Step D bridge (Phase 5): `DataViewManager.ensureCompanionSpec`
		// probes for a companion `.qviz.json` via `fs.stat`. Real VS Code
		// throws a `FileSystemError` with code `'FileNotFound'`; we
		// emit the same code so the production catch branch reacts the
		// same way under test.
		async stat(uri: Uri): Promise<{ type: number; size: number }> {
			const bytes = state.fsFiles.get(uri.fsPath);
			if (bytes === undefined) {
				const err = new Error(`shim: file not found: ${uri.fsPath}`);
				(err as { code?: string }).code = 'FileNotFound';
				throw err;
			}
			return { type: 1 /* File */, size: bytes.byteLength };
		},
	},
	getConfiguration(_section?: string): { get<T>(key: string): T | undefined } {
		return {
			get<T>(_key: string): T | undefined { return undefined; },
		};
	},
};

/** Programmable response for the next showWarningMessage call. Tests
 *  set this BEFORE invoking save; the shim returns it once then
 *  resets to undefined (no choice). Use `_setWarningMessageResponse`. */
let nextWarningMessageResponse: string | undefined = undefined;
export function _setWarningMessageResponse(choice: string | undefined): void {
	nextWarningMessageResponse = choice;
}

/**
 * Step D bridge (Phase 5): `DataViewManager.switchToVisualise` invokes
 * `vscode.commands.executeCommand('vscode.openWith', uri, viewType)` to
 * route a file to a specific custom editor. The shim records every
 * invocation in `state.commandsExecuted` so tests can assert the
 * routing without spinning up a real VS Code editor.
 *
 * Other commands (`setContext`, etc.) resolve to `undefined` -- they
 * are no-ops for unit-testing purposes.
 */
export const commands = {
	async executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T | undefined> {
		state.commandsExecuted.push({ command, args });
		return undefined;
	},
};

export function _commandsExecuted(): readonly { command: string; args: unknown[] }[] {
	return [...state.commandsExecuted];
}

export const window = {
	showErrorMessage(message: string): Thenable<undefined> {
		state.errorMessages.push(message);
		return Promise.resolve(undefined);
	},
	showWarningMessage(
		message: string,
		_options: unknown,
		..._items: string[]
	): Thenable<string | undefined> {
		state.errorMessages.push(message);
		const r = nextWarningMessageResponse;
		nextWarningMessageResponse = undefined;
		return Promise.resolve(r);
	},
	registerCustomEditorProvider(
		_viewType: string, _provider: unknown, _options?: unknown,
	): Disposable {
		return new Disposable(() => { /* no-op */ });
	},
	createOutputChannel(name: string): {
		name: string;
		appendLine(line: string): void;
		append(text: string): void;
		clear(): void;
		show(): void;
		hide(): void;
		dispose(): void;
	} {
		// Minimal OutputChannel for units that log (e.g. ServerApiClient).
		return {
			name,
			appendLine(_line: string): void { /* discard */ },
			append(_text: string): void { /* discard */ },
			clear(): void { /* no-op */ },
			show(): void { /* no-op */ },
			hide(): void { /* no-op */ },
			dispose(): void { /* no-op */ },
		};
	},
};

// ---------------------------------------------------------------------------
// install hook
// ---------------------------------------------------------------------------

let installed = false;

interface ModuleWithResolve {
	_resolveFilename(
		request: string,
		parent: NodeJS.Module | null,
		isMain?: boolean,
		options?: { paths?: string[] },
	): string;
}

/**
 * Hook Node's module resolution so `import * as vscode from 'vscode'`
 * loads THIS shim file. Idempotent.
 */
export function installVscodeShim(): void {
	if (installed) { return; }
	installed = true;
	const M = Module as unknown as ModuleWithResolve;
	const original = M._resolveFilename;
	M._resolveFilename = function (request, parent, isMain, options) {
		if (request === 'vscode') {
			return __filename;  // resolves to the compiled shim itself
		}
		return original.call(this, request, parent, isMain, options);
	};
}

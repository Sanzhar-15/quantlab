/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave H2 (R10 part 2/2) -- unit tests for the `.qbook` CustomEditorProvider + CustomDocument.
// Exercised over the minimal vscode shim (Uri / EventEmitter / workspace.fs) with STUB engine deps,
// so the dirty state machine (version token + token-INVISIBLE defined-names axis), the create()
// branches (untitled / backup / empty), the save/backup lifecycle, and the revert sequencing
// (gap #7: swap-before-close, plus the failed-revert re-assert) are covered with no live engine or
// webview host. The webview-host-only behaviors (the webviewReady re-handshake on revert, the
// retainContextWhenHidden recreate, the dirty-tab rendering) are smoke-only by design.

import * as assert from 'assert';

import { Uri, installVscodeShim, _setFile, _fileExists, _createdDirs, _resetShimState } from './helpers/vscode-shim';
installVscodeShim();

import {
	QbookDocument,
	signaturesDiffer,
	versionsDiffer,
	type ContentSignature,
	type QbookDocumentDeps,
} from '../src/quantbook/cellGrid/qbookDocument';
import { QbookEditorProvider, type QbookEditorProviderDeps } from '../src/quantbook/cellGrid/qbookEditorProvider';
import { recalcDirtyChecked, registerRecalcFailsafe, unregisterRecalcFailsafe } from '../src/quantbook/session';
import type { SessionInstance } from '../src/quantbook/types';
import type { Uri as VscodeUri } from 'vscode';

/** The shim `Uri` lacks the full `vscode.Uri` surface (`with`/`toJSON`); cast at the boundary
 *  where a uri is handed to a production method typed `vscode.Uri` (the shim has `fsPath`/
 *  `toString`, which is all the production code reads). */
function vsUri(p: string): VscodeUri {
	return Uri.file(p) as unknown as VscodeUri;
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface StubSession {
	id: string;
	sheets: Array<{ id: number; name: string }>;
}

/** A bare object stands in for a `SessionInstance` -- the document/provider only ever pass it
 *  through the injected deps (which the test controls) and read `listSheets()`. */
function stubSession(id: string, sheets: Array<{ id: number; name: string }> = [{ id: 0, name: 'Sheet0' }]): SessionInstance {
	const s: StubSession & { listSheets(): Array<{ id: number; name: string }> } = {
		id,
		sheets,
		listSheets: () => s.sheets,
	};
	return s as unknown as SessionInstance;
}

function sessionId(s: SessionInstance): string {
	return (s as unknown as StubSession).id;
}

/** Mutate a stub session's live sheet list (simulate add/delete-sheet between open and a later read). */
function setSheets(s: SessionInstance, sheets: Array<{ id: number; name: string }>): void {
	(s as unknown as StubSession).sheets = sheets;
}

/** A controllable content-signature source: the version token + the defined-names key per session. */
class SignatureBook {
	private readonly versions = new Map<SessionInstance, Buffer | undefined>();
	private readonly namesKeys = new Map<SessionInstance, string>();
	readonly closeCounts = new Map<SessionInstance, number>();

	read(session: SessionInstance): ContentSignature {
		return { version: this.versions.get(session), namesKey: this.namesKeys.get(session) ?? '[]' };
	}
	setVersion(session: SessionInstance, v: Buffer | undefined): void {
		this.versions.set(session, v);
	}
	hasVersion(session: SessionInstance): boolean {
		return this.versions.has(session);
	}
	seedIfAbsent(session: SessionInstance): void {
		if (!this.versions.has(session)) {
			this.versions.set(session, Buffer.from(`v-${sessionId(session)}`));
		}
	}
	setNames(session: SessionInstance, key: string): void {
		this.namesKeys.set(session, key);
	}
	close(session: SessionInstance): void {
		this.closeCounts.set(session, (this.closeCounts.get(session) ?? 0) + 1);
	}
}

interface ProviderHarness {
	provider: QbookEditorProvider;
	deps: QbookEditorProviderDeps;
	book: SignatureBook;
	log: string[];
	openResults: SessionInstance[];
	docFires: { count: number };
	adoptFailIds: Set<string>;
	signatureFailIds: Set<string>;
	adopts: Array<{ id: string; sheet: number }>;
	failNextSave: () => void;
	failNextDetach: () => void;
}

/** Build a provider over stub deps that record a call log + simulate the render seeding the
 *  per-session version (so the baseline captures a real signature). */
function harness(initialOpen: SessionInstance): ProviderHarness {
	const log: string[] = [];
	const book = new SignatureBook();
	const openResults: SessionInstance[] = [initialOpen];
	const adoptFailIds = new Set<string>();
	const signatureFailIds = new Set<string>();
	const adopts: Array<{ id: string; sheet: number }> = [];
	let saveShouldThrow = false;
	let detachShouldThrow = false;

	const deps: QbookEditorProviderDeps = {
		openWorkbook: (path) => {
			log.push(`open:${path}`);
			const next = openResults.shift();
			if (next === undefined) {
				throw new Error('[test] openWorkbook called more times than queued');
			}
			return next;
		},
		saveSession: (session, path) => {
			log.push(`save:${sessionId(session)}:${path}`);
			if (saveShouldThrow) {
				throw new Error('[persistence] simulated save failure');
			}
		},
		readSignature: (session) => {
			if (signatureFailIds.has(sessionId(session))) {
				// Faithful to listNames() throwing inside recomputeDirty (the token-invisible names axis).
				throw new Error(`[test] simulated readSignature failure for ${sessionId(session)}`);
			}
			return book.read(session);
		},
		closeSession: (session) => {
			log.push(`close:${sessionId(session)}`);
			book.close(session);
		},
		adoptPanel: (_context, _panel, session, sheet, opts) => {
			log.push(`adopt:${sessionId(session)}`);
			adopts.push({ id: sessionId(session), sheet });
			if (adoptFailIds.has(sessionId(session))) {
				// Faithful to a render whose snapshot acquire throws: the failsafe fires, THEN the throw
				// propagates (CellGridPanel.render fires onRenderError in the acquire catch, then rethrows).
				opts.onRenderError?.();
				throw new Error(`[test] simulated adopt/render crash for ${sessionId(session)}`);
			}
			// Simulate the first render seeding the per-session version token -- only if absent, so a
			// RE-adopt (webview recreate / revert re-render) of an already-edited session PRESERVES its
			// current version (faithful to the per-session delta cache, which survives a panel recreate).
			book.seedIfAbsent(session);
			// Faithful to CellGridPanel.render(): the precise pulse runs INSIDE a failsafe try; if it
			// throws (readSignature -> listNames), onRenderError fires and the render rethrows.
			try {
				opts.onMutate?.();
			} catch (err) {
				opts.onRenderError?.();
				throw err;
			}
		},
		// Wave H2 fix: detach does NOT close the session (the provider closes the old session itself,
		// only after a successful re-adopt).
		detachForRevert: (session) => {
			log.push(`detach:${sessionId(session)}`);
			if (detachShouldThrow) {
				throw new Error(`[test] simulated detach failure for ${sessionId(session)}`);
			}
		},
	};

	const provider = new QbookEditorProvider({} as never, deps);
	const docFires = { count: 0 };
	provider.onDidChangeCustomDocument(() => { docFires.count += 1; });
	return {
		provider,
		deps,
		book,
		log,
		openResults,
		docFires,
		adoptFailIds,
		signatureFailIds,
		adopts,
		failNextSave: () => { saveShouldThrow = true; },
		failNextDetach: () => { detachShouldThrow = true; },
	};
}

function openContext(over: Partial<{ backupId: string; untitledDocumentData: Uint8Array }> = {}): never {
	return over as never;
}

/** Await a call that should reject and assert its message -- attaching the catch synchronously (vs
 *  `assert.rejects(thunk)`, which attaches on a later microtask and trips Node's benign
 *  PromiseRejectionHandledWarning when the async method throws before its first await). */
async function rejectsWith(p: Promise<unknown>, re: RegExp): Promise<void> {
	let err: unknown;
	await p.then(() => { /* resolved -- fail below */ }, (e: unknown) => { err = e; });
	assert.ok(err instanceof Error && re.test(err.message), `expected a rejection matching ${re}, got: ${String(err)}`);
}

const v = (s: string): Buffer => Buffer.from(s);

// ---------------------------------------------------------------------------
// The before-recalc dirty failsafe registry -- the single chokepoint covering EVERY mutation path
// (dispatcher, panel, command handlers). A mutation commits BEFORE recalcDirtyChecked; if the recalc
// throws (e.g. a circular formula -> recompute_iteration_cap), the post-commit render never runs, so
// the registered failsafe fires FIRST to conservatively mark the editor dirty.
// ---------------------------------------------------------------------------

suite('Wave H2 -- recalc before-failsafe registry', () => {
	function failingRecalcSession(log: string[]): SessionInstance {
		return {
			recalcDirty: () => { log.push('recalcDirty'); return 1n; },
			operationStatus: () => ({ state: 'failed', error: { code: 'recompute_iteration_cap', class: 'Internal' } }),
		} as unknown as SessionInstance;
	}

	test('recalcDirtyChecked fires the registered failsafe BEFORE the recalc (so a recalc throw still marks dirty)', () => {
		const calls: string[] = [];
		const session = failingRecalcSession(calls);
		registerRecalcFailsafe(session, () => { calls.push('failsafe'); });
		try {
			assert.throws(() => recalcDirtyChecked(session), /recompute_iteration_cap/, 'a failed recalc still throws loud (No-Fallbacks)');
			assert.deepStrictEqual(calls, ['failsafe', 'recalcDirty'], 'the failsafe fires BEFORE the recalc');
		} finally {
			unregisterRecalcFailsafe(session);
		}
	});

	test('no failsafe fires for an unregistered session; unregister stops a registered one', () => {
		const calls: string[] = [];
		const session = failingRecalcSession(calls);
		// Unregistered -> no failsafe.
		assert.throws(() => recalcDirtyChecked(session), /recompute_iteration_cap/);
		assert.deepStrictEqual(calls, ['recalcDirty'], 'no failsafe for an unregistered session');
		// Register, then unregister -> the failsafe must NOT fire again.
		registerRecalcFailsafe(session, () => { calls.push('failsafe'); });
		unregisterRecalcFailsafe(session);
		calls.length = 0;
		assert.throws(() => recalcDirtyChecked(session), /recompute_iteration_cap/);
		assert.deepStrictEqual(calls, ['recalcDirty'], 'after unregister, the failsafe no longer fires');
	});

	test('a throwing failsafe is logged-not-thrown and never aborts the recalc itself (No-Fallbacks)', () => {
		const calls: string[] = [];
		const healthy = {
			recalcDirty: () => { calls.push('recalcDirty'); return 2n; },
			operationStatus: () => ({ state: 'completed' }),
		} as unknown as SessionInstance;
		registerRecalcFailsafe(healthy, () => { throw new Error('[test] failsafe blew up'); });
		try {
			// The failsafe throws, but recalcDirtyChecked swallows-with-log and still runs the recalc.
			recalcDirtyChecked(healthy);
			assert.deepStrictEqual(calls, ['recalcDirty'], 'the recalc still ran despite the failsafe throwing');
		} finally {
			unregisterRecalcFailsafe(healthy);
		}
	});
});

// ---------------------------------------------------------------------------
// Pure compares
// ---------------------------------------------------------------------------

suite('Wave H2 -- versionsDiffer (version-token axis)', () => {
	test('both undefined (pre-baseline seed) -> equal', () => {
		assert.strictEqual(versionsDiffer(undefined, undefined), false);
	});
	test('exactly one undefined -> differ', () => {
		assert.strictEqual(versionsDiffer(undefined, v('a')), true);
		assert.strictEqual(versionsDiffer(v('a'), undefined), true);
	});
	test('equal bytes -> equal; different bytes / lengths -> differ', () => {
		assert.strictEqual(versionsDiffer(v('abc'), v('abc')), false);
		assert.strictEqual(versionsDiffer(v('abc'), v('abd')), true);
		assert.strictEqual(versionsDiffer(v('ab'), v('abc')), true);
	});
	test('known limitation: a different VV after undo-to-saved reads as differ (by design)', () => {
		assert.strictEqual(versionsDiffer(v('  '), v('  ')), true);
	});
});

suite('Wave H2 -- signaturesDiffer (version + token-invisible names axis)', () => {
	test('same version + same names -> equal', () => {
		assert.strictEqual(signaturesDiffer({ version: v('x'), namesKey: '[]' }, { version: v('x'), namesKey: '[]' }), false);
	});
	test('version advanced -> differ', () => {
		assert.strictEqual(signaturesDiffer({ version: v('x'), namesKey: '[]' }, { version: v('y'), namesKey: '[]' }), true);
	});
	test('names changed while version is byte-identical -> differ (the token-invisible case)', () => {
		assert.strictEqual(
			signaturesDiffer({ version: v('x'), namesKey: '[]' }, { version: v('x'), namesKey: '[{"name":"foo"}]' }),
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// QbookDocument (state machine + create branches) -- direct, with stub deps
// ---------------------------------------------------------------------------

suite('Wave H2 -- QbookDocument', () => {
	function ctx(): { deps: QbookDocumentDeps; book: SignatureBook } {
		const book = new SignatureBook();
		const deps: QbookDocumentDeps = {
			openWorkbook: () => stubSession('opened'),
			readSignature: (s) => book.read(s),
			closeSession: (s) => book.close(s),
		};
		return { deps, book };
	}
	function open(session: SessionInstance, deps: QbookDocumentDeps): QbookDocument {
		const d: QbookDocumentDeps = { ...deps, openWorkbook: () => session };
		return QbookDocument.create(vsUri('/wb.qbook'), openContext(), d);
	}

	test('create from a uri opens the session and captures the first live sheet', () => {
		const session = stubSession('s', [{ id: 7, name: 'A' }, { id: 9, name: 'B' }]);
		const { deps } = ctx();
		const doc = open(session, deps);
		assert.strictEqual(doc.session, session);
		assert.strictEqual(doc.firstSheet, 7);
		assert.strictEqual(doc.isDirty, false);
	});

	test('create REFUSES an untitled .qbook (no in-memory bytes path)', () => {
		const { deps } = ctx();
		assert.throws(
			() => QbookDocument.create(vsUri('/new.qbook'), openContext({ untitledDocumentData: new Uint8Array() }), deps),
			/not_implemented/,
		);
	});

	test('create opens from the BACKUP path when openContext.backupId is set (hot-exit restore)', () => {
		let openedPath = '';
		const { deps } = ctx();
		const d: QbookDocumentDeps = { ...deps, openWorkbook: (p) => { openedPath = p; return stubSession('restored'); } };
		const backupUri = Uri.file('/tmp/vscode-backup-abc123');
		QbookDocument.create(vsUri('/orig.qbook'), openContext({ backupId: backupUri.toString() }), d);
		assert.strictEqual(openedPath, backupUri.fsPath, 'must open from the backup path, not the original uri');
	});

	test('create REFUSES an empty workbook and closes the leaked session EXACTLY once (no double-close)', () => {
		const empty = stubSession('empty', []);
		const { deps, book } = ctx();
		assert.throws(() => open(empty, deps), /no live sheets/);
		assert.strictEqual(book.closeCounts.get(empty), 1, 'the empty session is closed once, not twice');
	});

	test('dirty state machine: clean baseline -> dirty on version change -> clean after re-save', () => {
		const session = stubSession('s');
		const { deps, book } = ctx();
		const doc = open(session, deps);
		const fires = { n: 0 };
		doc.onDidChangeContent(() => { fires.n += 1; });

		// Before a baseline, recomputeDirty no-ops.
		book.setVersion(session, v('seed'));
		doc.recomputeDirty();
		assert.strictEqual(doc.isDirty, false);
		assert.strictEqual(fires.n, 0);

		// Establish the baseline at the seed version (provider does this after the first render).
		doc.markSavedNow();
		assert.strictEqual(doc.isDirty, false);
		assert.strictEqual(fires.n, 0, 'markSavedNow does NOT fire (clean is workbench-driven)');

		// A mutation advances the version -> dirty (ONE clean->dirty fire).
		book.setVersion(session, v('edited'));
		doc.recomputeDirty();
		assert.strictEqual(doc.isDirty, true);
		assert.strictEqual(fires.n, 1);

		// Same version again -> no extra fire (no edge).
		doc.recomputeDirty();
		assert.strictEqual(fires.n, 1);

		// Save captures the new baseline -> clean, WITHOUT firing (VS Code clears its own dirty).
		doc.markSavedNow();
		assert.strictEqual(doc.isDirty, false);
		assert.strictEqual(fires.n, 1);
	});

	test('a token-INVISIBLE defined-name change marks the document dirty (Codex H1)', () => {
		const session = stubSession('s');
		const { deps, book } = ctx();
		const doc = open(session, deps);
		book.setVersion(session, v('seed'));
		doc.markSavedNow();
		assert.strictEqual(doc.isDirty, false);
		// Define a name: the version token is UNCHANGED (setName is token-invisible) but the names key moves.
		book.setNames(session, '[{"name":"foo"}]');
		doc.recomputeDirty();
		assert.strictEqual(doc.isDirty, true, 'a defined-name edit must mark dirty even though the version token did not move');
	});

	test('an organic return-to-baseline goes clean internally WITHOUT firing (safe over-report)', () => {
		const session = stubSession('s');
		const { deps, book } = ctx();
		const doc = open(session, deps);
		book.setVersion(session, v('base'));
		doc.markSavedNow();
		const fires = { n: 0 };
		doc.onDidChangeContent(() => { fires.n += 1; });
		// Add a name -> dirty (fires once).
		book.setNames(session, '[{"name":"foo"}]');
		doc.recomputeDirty();
		assert.strictEqual(doc.isDirty, true);
		assert.strictEqual(fires.n, 1);
		// Remove the name (back to baseline) -> internally clean, but NO fire (VS Code clears via save/revert only).
		book.setNames(session, '[]');
		doc.recomputeDirty();
		assert.strictEqual(doc.isDirty, false);
		assert.strictEqual(fires.n, 1, 'organic dirty->clean must not fire a content-change event');
	});

	test('markSavedNow throws LOUD if the engine produced no version token (No-Fallbacks)', () => {
		const session = stubSession('s');
		const { deps, book } = ctx();
		const doc = open(session, deps);
		book.setVersion(session, undefined); // broken build: no version token
		assert.throws(() => doc.markSavedNow(), /\[invalid_state\].*version token/);
	});

	test('reassertDirty re-fires the modified signal (used after a failed revert)', () => {
		const session = stubSession('s');
		const { deps, book } = ctx();
		const doc = open(session, deps);
		book.setVersion(session, v('seed'));
		doc.markSavedNow();
		const fires = { n: 0 };
		doc.onDidChangeContent(() => { fires.n += 1; });
		doc.reassertDirty();
		assert.strictEqual(doc.isDirty, true);
		assert.strictEqual(fires.n, 1, 'reassertDirty fires a content-change event to re-mark the tab dirty');
	});

	test('markDirtyConservatively (render-failure failsafe) marks dirty once, no-op when already dirty', () => {
		const session = stubSession('s');
		const { deps, book } = ctx();
		const doc = open(session, deps);
		book.setVersion(session, v('seed'));
		doc.markSavedNow();
		const fires = { n: 0 };
		doc.onDidChangeContent(() => { fires.n += 1; });
		doc.markDirtyConservatively();
		assert.strictEqual(doc.isDirty, true);
		assert.strictEqual(fires.n, 1, 'fires once on clean->dirty');
		doc.markDirtyConservatively();
		assert.strictEqual(fires.n, 1, 'no-op (no event spam) when already dirty');
	});

	test('swapSession suspends the baseline until the next markSavedNow (revert support)', () => {
		const oldS = stubSession('old');
		const freshS = stubSession('fresh');
		const { deps, book } = ctx();
		const doc = open(oldS, deps);
		book.setVersion(oldS, v('v1'));
		doc.markSavedNow();
		book.setVersion(oldS, v('v2'));
		doc.recomputeDirty();
		assert.strictEqual(doc.isDirty, true);
		// Swap to the fresh session: baseline suspended, recomputeDirty no-ops even with a version.
		doc.swapSession(freshS);
		assert.strictEqual(doc.session, freshS);
		book.setVersion(freshS, v('fresh-v'));
		doc.recomputeDirty();
		doc.markSavedNow();
		assert.strictEqual(doc.isDirty, false, 'clean after re-baselining on the fresh session');
	});

	test('dispose fires onDidDispose BEFORE closing the owned session (idempotent)', () => {
		const session = stubSession('s');
		const { deps, book } = ctx();
		const doc = open(session, deps);
		let disposeFiredBeforeClose = false;
		doc.onDidDispose(() => { disposeFiredBeforeClose = (book.closeCounts.get(session) ?? 0) === 0; });
		doc.dispose();
		assert.ok(disposeFiredBeforeClose, 'onDidDispose must fire BEFORE the session is closed');
		assert.strictEqual(book.closeCounts.get(session), 1, 'dispose closes the owned session');
		doc.dispose(); // idempotent
		assert.strictEqual(book.closeCounts.get(session), 1);
	});
});

// ---------------------------------------------------------------------------
// QbookEditorProvider lifecycle
// ---------------------------------------------------------------------------

suite('Wave H2 -- QbookEditorProvider', () => {
	setup(() => { _resetShimState(); });

	async function opened(h: ProviderHarness): Promise<QbookDocument> {
		const doc = await h.provider.openCustomDocument(vsUri('/wb.qbook'), openContext(), {} as never);
		await h.provider.resolveCustomEditor(doc, {} as never, {} as never);
		return doc;
	}

	test('openCustomDocument relays a document dirty transition to onDidChangeCustomDocument', async () => {
		const session = stubSession('s');
		const h = harness(session);
		const doc = await opened(h);
		const before = h.docFires.count;
		h.book.setVersion(session, v('edited'));
		doc.recomputeDirty();
		assert.ok(h.docFires.count > before, 'a document dirty transition must reach onDidChangeCustomDocument');
	});

	test('resolveCustomEditor adopts the panel and leaves a freshly-opened file CLEAN', async () => {
		const session = stubSession('s');
		const h = harness(session);
		const doc = await opened(h);
		assert.ok(h.log.includes('adopt:s'), 'must adopt the panel onto the opened session');
		assert.strictEqual(doc.isDirty, false, 'a freshly-opened file must not be dirty');
		assert.strictEqual(h.docFires.count, 0, 'open does not fire a dirty event');
	});

	test('a webview recreate (re-resolve, e.g. tab moved) preserves a pending dirty state', async () => {
		const session = stubSession('s');
		const h = harness(session);
		const doc = await opened(h);
		h.book.setVersion(session, v('edited'));
		doc.recomputeDirty();
		assert.strictEqual(doc.isDirty, true);
		// Re-resolve: the session version (still 'edited') is preserved; the baseline must NOT reset.
		await h.provider.resolveCustomEditor(doc, {} as never, {} as never);
		assert.strictEqual(doc.isDirty, true, 'a tab-move re-resolve must not silently clear the dirty flag');
	});

	test('saveCustomDocument saves to the document uri and clears dirty', async () => {
		const session = stubSession('s');
		const h = harness(session);
		const doc = await opened(h);
		h.book.setVersion(session, v('edited'));
		doc.recomputeDirty();
		assert.strictEqual(doc.isDirty, true);
		await h.provider.saveCustomDocument(doc, {} as never);
		assert.ok(h.log.includes('save:s:/wb.qbook'), 'saves to the document uri');
		assert.strictEqual(doc.isDirty, false, 'save clears dirty');
	});

	test('saveCustomDocument re-throws on save failure and keeps the tab dirty', async () => {
		const session = stubSession('s');
		const h = harness(session);
		const doc = await opened(h);
		h.book.setVersion(session, v('edited'));
		doc.recomputeDirty();
		h.failNextSave();
		await rejectsWith(h.provider.saveCustomDocument(doc, {} as never), /simulated save failure/);
		assert.strictEqual(doc.isDirty, true, 'a failed save must leave the tab dirty (No-Fallbacks)');
	});

	test('saveCustomDocumentAs writes to the target but does NOT clear the source (its file is still unsaved)', async () => {
		const session = stubSession('s');
		const h = harness(session);
		const doc = await opened(h);
		h.book.setVersion(session, v('edited'));
		doc.recomputeDirty();
		await h.provider.saveCustomDocumentAs(doc, vsUri('/copy.qbook'), {} as never);
		assert.ok(h.log.includes('save:s:/copy.qbook'), 'writes a copy to the target');
		assert.strictEqual(doc.isDirty, true, 'the source tab stays dirty (its own file was not saved)');
	});

	test('revert: opens fresh, re-adopts, then closes the old session LAST (gap #7) and lands clean', async () => {
		const oldSession = stubSession('old');
		const freshSession = stubSession('fresh');
		const h = harness(oldSession);
		h.openResults.push(freshSession);
		const doc = await opened(h);
		h.book.setVersion(oldSession, v('edited'));
		doc.recomputeDirty();
		assert.strictEqual(doc.isDirty, true);

		// At detach time the document STILL points at the open old session (swap happens only after a
		// successful adopt) -- so a backup mid-revert always hits a live session.
		let docSessionAtDetach: SessionInstance | undefined;
		let oldClosedAtDetach = false;
		const realDetach = h.deps.detachForRevert;
		h.deps.detachForRevert = (s) => {
			docSessionAtDetach = doc.session;
			oldClosedAtDetach = (h.book.closeCounts.get(oldSession) ?? 0) > 0;
			realDetach(s);
		};

		await h.provider.revertCustomDocument(doc, {} as never);

		assert.strictEqual(docSessionAtDetach, oldSession, 'the document still holds the OPEN old session at detach');
		assert.strictEqual(oldClosedAtDetach, false, 'the old session is NOT closed before adopt');
		// The old session is closed only AFTER adopt: open -> detach -> adopt -> close(old).
		const revertLog = h.log.slice(h.log.indexOf('open:/wb.qbook', 1));
		assert.deepStrictEqual(revertLog, ['open:/wb.qbook', 'detach:old', 'adopt:fresh', 'close:old']);
		assert.strictEqual(h.book.closeCounts.get(oldSession), 1, 'old session closed exactly once, after adopt');
		assert.strictEqual(doc.session, freshSession);
		assert.strictEqual(doc.isDirty, false, 'revert lands on a clean baseline');
	});

	test('revert: an adopt/render crash on the fresh session preserves the OPEN old session (no data loss)', async () => {
		const oldSession = stubSession('old');
		const freshSession = stubSession('fresh');
		const h = harness(oldSession);
		h.openResults.push(freshSession);
		h.adoptFailIds.add('fresh'); // the re-adopt's first render crashes
		const doc = await opened(h);
		h.book.setVersion(oldSession, v('edited'));
		doc.recomputeDirty();
		const firesBefore = h.docFires.count;

		await rejectsWith(h.provider.revertCustomDocument(doc, {} as never), /simulated adopt\/render crash/);

		assert.strictEqual(doc.session, oldSession, 'the document keeps the OPEN old session when the fresh re-adopt crashes');
		assert.strictEqual(h.book.closeCounts.get(oldSession) ?? 0, 0, 'the old session (with the unsaved edits) is NOT closed');
		assert.strictEqual(h.book.closeCounts.get(freshSession), 1, 'the orphan fresh session is closed');
		assert.strictEqual(doc.isDirty, true);
		assert.ok(h.docFires.count > firesBefore, 'reassertDirty re-fires so the workbench-cleared dirty state is restored');
		// Recovery: the old session is re-adopted onto the panel (so the grid is not left blank) --
		// one adopt at open, one for the recovery re-bind.
		assert.strictEqual(h.log.filter((x) => x === 'adopt:old').length, 2, 'the old session is re-adopted onto the panel for recovery');
	});

	test('a render whose dirty recompute throws (readSignature/listNames) is failsafed to dirty, not falsely clean', async () => {
		const session = stubSession('s');
		const h = harness(session);
		const doc = await opened(h);
		assert.strictEqual(doc.isDirty, false);
		// A committed edit happened, but this render's recompute (readSignature -> listNames) throws.
		h.signatureFailIds.add('s');
		// The re-render (modeled as a re-resolve here) throws out of adoptPanel after the failsafe fired.
		await rejectsWith(h.provider.resolveCustomEditor(doc, {} as never, {} as never), /simulated readSignature failure/);
		assert.strictEqual(doc.isDirty, true, 'the failsafe (onRenderError -> markDirtyConservatively) marks dirty so the edit is not lost');
	});

	test('revert recovery re-adopts the old session on its CURRENT first LIVE sheet (not a tombstoned one)', async () => {
		const oldSession = stubSession('old', [{ id: 0, name: 'S0' }]);
		const freshSession = stubSession('fresh');
		const h = harness(oldSession);
		h.openResults.push(freshSession);
		h.adoptFailIds.add('fresh');
		const doc = await opened(h);
		assert.strictEqual(doc.firstSheet, 0, 'opened on sheet 0');
		// The originally-opened first sheet (0) is deleted; the live first sheet is now 5.
		setSheets(oldSession, [{ id: 5, name: 'Live' }]);
		h.book.setVersion(oldSession, v('edited'));
		doc.recomputeDirty();

		await rejectsWith(h.provider.revertCustomDocument(doc, {} as never), /simulated adopt\/render crash/);

		const oldAdopts = h.adopts.filter((a) => a.id === 'old');
		assert.strictEqual(oldAdopts[oldAdopts.length - 1].sheet, 5, 'recovery re-adopts the CURRENT live sheet (5), not the deleted document.firstSheet (0)');
	});

	test('revert: a detach failure still re-asserts dirty and closes the orphan fresh session', async () => {
		const oldSession = stubSession('old');
		const freshSession = stubSession('fresh');
		const h = harness(oldSession);
		h.openResults.push(freshSession);
		const doc = await opened(h);
		h.book.setVersion(oldSession, v('edited'));
		doc.recomputeDirty();
		const firesBefore = h.docFires.count;
		h.failNextDetach();

		await rejectsWith(h.provider.revertCustomDocument(doc, {} as never), /simulated detach failure/);

		assert.strictEqual(doc.session, oldSession, 'the document keeps the old session when detach fails');
		assert.strictEqual(h.book.closeCounts.get(oldSession) ?? 0, 0, 'the old session is not closed');
		assert.strictEqual(h.book.closeCounts.get(freshSession), 1, 'the orphan fresh session is still closed (reassert ran first)');
		assert.strictEqual(doc.isDirty, true);
		assert.ok(h.docFires.count > firesBefore, 'reassertDirty re-fires even though the cleanup detach threw');
	});

	test('revert aborts (old session intact) + RE-ASSERTS dirty when the fresh open fails', async () => {
		const oldSession = stubSession('old');
		const h = harness(oldSession);
		// queue NO fresh session -> the revert openWorkbook throws "called more times than queued".
		const doc = await opened(h);
		h.book.setVersion(oldSession, v('edited'));
		doc.recomputeDirty();
		const firesBefore = h.docFires.count;
		await rejectsWith(h.provider.revertCustomDocument(doc, {} as never), /more times than queued/);
		assert.strictEqual(doc.session, oldSession, 'the document keeps the old session on a failed revert');
		assert.strictEqual(doc.isDirty, true, 'the tab stays dirty (the unsaved edits are still live)');
		assert.ok(h.docFires.count > firesBefore, 'reassertDirty re-fires so the workbench-cleared dirty state is restored');
		assert.strictEqual(h.book.closeCounts.get(oldSession) ?? 0, 0, 'the old session is NOT closed on a failed revert');
	});

	test('revert aborts + re-asserts dirty when the fresh workbook has no live sheets (closed once)', async () => {
		const oldSession = stubSession('old');
		const emptyFresh = stubSession('emptyfresh', []);
		const h = harness(oldSession);
		h.openResults.push(emptyFresh);
		const doc = await opened(h);
		h.book.setVersion(oldSession, v('edited'));
		doc.recomputeDirty();
		await rejectsWith(h.provider.revertCustomDocument(doc, {} as never), /no live sheets/);
		assert.strictEqual(h.book.closeCounts.get(emptyFresh), 1, 'the empty fresh session is closed exactly once');
		assert.strictEqual(h.book.closeCounts.get(oldSession) ?? 0, 0, 'the old session stays intact');
		assert.strictEqual(doc.session, oldSession);
		assert.strictEqual(doc.isDirty, true);
	});

	test('backupCustomDocument ensures the parent dir, saves to the destination, returns id + working delete', async () => {
		const session = stubSession('s');
		const h = harness(session);
		const doc = await opened(h);
		const dest = Uri.file('/var/backups/quantbook/backup-xyz');
		_setFile(dest.fsPath, new Uint8Array([1, 2, 3]));
		const backup = await h.provider.backupCustomDocument(doc, { destination: dest } as never, {} as never);
		assert.ok(_createdDirs().includes('/var/backups/quantbook'), 'creates the destination parent dir before saving');
		assert.ok(h.log.includes(`save:s:${dest.fsPath}`), 'backup saves to the destination path');
		assert.strictEqual(backup.id, dest.toString());
		assert.strictEqual(typeof backup.delete, 'function');
		// Backup does NOT clear dirty.
		h.book.setVersion(session, v('edited'));
		doc.recomputeDirty();
		assert.strictEqual(doc.isDirty, true);
		backup.delete();
		await Promise.resolve();
		await Promise.resolve();
		assert.strictEqual(_fileExists(dest.fsPath), false, 'backup.delete() removes the backup file');
	});
});

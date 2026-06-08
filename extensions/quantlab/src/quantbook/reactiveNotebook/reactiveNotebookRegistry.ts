/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-N (N-1) -- the vscode-free core of the reactive NotebookController.
//
// Three responsibilities, all of which the Codex N-1 review flagged as the risky parts (so they live
// here, unit-tested with fakes, NOT in the thin vscode controller):
//
//   1. BINDING (which workbook a notebook executes against). A notebook has no Session until its first
//      cell runs; bind-on-first-execute resolves the focused grid's Session and remembers it keyed by
//      the notebook's URI. Later cells reuse that exact Session (cursor-unification: the panel render
//      owns the sole cursor; we never make a second one).
//
//   2. LIFETIME (Codex HIGH-1). CellGridPanel CLOSES its Session when its last panel disposes, so a raw
//      uri->Session map can hold a DEAD ref. When a bound Session closes we DETACH the notebook (a
//      PERSISTENT tombstone): every subsequent execute throws a clear "workbook closed" error rather than
//      executing against a dead Session, and the controller ABORTS the rest of a Run All on that error so
//      a later cell can never silently rebind to a different grid. The tombstone is cleared ONLY by
//      closing+reopening the notebook (invalidateNotebook) -- or, from N-2, an explicit bind command.
//
//   3. SERIALIZATION (Codex MED-1). The transport client rejects concurrent ops, so all executes for a
//      given Session run through a single tail-promise chain. A failed cell does NOT poison the chain
//      (the next cell still runs). The actual executeCell call re-checks the binding is still live INSIDE
//      the serialized critical section, closing the resolve->execute race (the Session could close after
//      resolve but before the queued task runs).
//
// No-Fallbacks: every failure path here throws a tagged error the controller surfaces as cell output.

/** The status of one execute op the controller renders into cell output. Mirrors ReactiveOpResult
 *  (kept structural so this module stays free of the reactiveKernelClient import / vscode). */
export interface OpStatus {
	republishCount: number;
	refused: ReadonlyArray<{ name: string; detail: string }>;
	stale: ReadonlyArray<string>;
}

/** Thrown when a cell runs against a notebook whose bound workbook has since closed. The controller
 *  shows this as the cell error AND aborts the rest of the run. The tombstone PERSISTS (it is NOT
 *  auto-cleared) so a later cell in the same Run All cannot silently rebind to a different grid
 *  (Codex HIGH); recovery is closing + reopening the notebook (which clears the binding via
 *  invalidateNotebook) -- or, from N-2, an explicit bind command. */
export class NotebookWorkbookClosedError extends Error {
	constructor() {
		super(
			'[notebook_workbook_closed] the workbook this notebook was bound to has closed; '
			+ 'run "Quantbook: Bind Reactive Notebook to Focused Grid" to rebind it to an open grid '
			+ '(or close and reopen this notebook)',
		);
		this.name = 'NotebookWorkbookClosedError';
	}
}

/**
 * Per-notebook session binding + per-session execution serialization. Generic over the Session type so
 * it is unit-testable with plain objects; the controller instantiates it as `<SessionInstance>`.
 */
export class ReactiveNotebookRegistry<S = object> {
	/** notebook uri (string) -> the live Session it is bound to. */
	private readonly bindings = new Map<string, S>();
	/** notebook uris whose bound Session has closed -- resolve throws PERSISTENTLY until the notebook is
	 *  reopened (invalidateNotebook); it is never auto-cleared on a failed execute (Codex HIGH). */
	private readonly detached = new Set<string>();
	/** Session -> the tail of its serialized execution chain (never rejects, so it cannot poison). */
	private readonly tails = new Map<S, Promise<void>>();

	/**
	 * Resolve the Session a notebook's cell should execute against, binding on first use.
	 *  - detached (bound Session has closed): throw {@link NotebookWorkbookClosedError}. The tombstone
	 *    PERSISTS (Codex HIGH) -- every later cell keeps failing the same way until the notebook is
	 *    closed/reopened (invalidateNotebook) so a Run All can never silently retarget a different grid.
	 *  - already bound + live: reuse.
	 *  - never bound: call `resolveFresh` (the focused-grid resolver), bind, return it.
	 * @throws NotebookWorkbookClosedError when detached; whatever `resolveFresh` throws (no grid / ambiguous).
	 */
	resolveForExecute(uri: string, resolveFresh: () => S): S {
		if (this.detached.has(uri)) {
			throw new NotebookWorkbookClosedError();
		}
		const bound = this.bindings.get(uri);
		if (bound !== undefined) {
			return bound;
		}
		const fresh = resolveFresh();
		this.bindings.set(uri, fresh);
		return fresh;
	}

	/**
	 * Explicitly bind a notebook to a Session (N-2: "Open Reactive Notebook" eager-binds the new notebook
	 * to the focused grid; "Bind to Focused Grid" rebinds an existing one). Unlike bind-on-first-execute
	 * this is operator-driven, so it CLEARS any persistent tombstone -- the only recovery from a closed
	 * workbook other than closing+reopening the notebook (Codex HIGH-1 keeps the tombstone for the implicit
	 * path; an explicit operator bind is the sanctioned override). Overrides any current binding.
	 */
	bindNotebook(uri: string, session: S): void {
		this.detached.delete(uri);
		this.bindings.set(uri, session);
	}

	/** Whether `uri` is currently bound to exactly `session` (the live-binding check the serialized task
	 *  uses to refuse executing against a Session that closed after resolveForExecute). */
	isLiveBinding(uri: string, session: S): boolean {
		return this.bindings.get(uri) === session;
	}

	/** The Session a notebook is currently bound to, or undefined (unbound or detached). Test/inspection. */
	boundSession(uri: string): S | undefined {
		return this.bindings.get(uri);
	}

	/** A bound Session has closed (CellGridPanel.onSessionClosing): detach every notebook bound to it and
	 *  drop its serialization tail. After this, resolveForExecute on those notebooks throws PERSISTENTLY
	 *  (until the notebook is reopened via invalidateNotebook) -- never auto-cleared on a failed execute. */
	invalidateSession(session: S): void {
		for (const [uri, s] of this.bindings) {
			if (s === session) {
				this.bindings.delete(uri);
				this.detached.add(uri);
			}
		}
		this.tails.delete(session);
	}

	/** A notebook closed (onDidCloseNotebookDocument): forget its binding AND any tombstone so a reopen of
	 *  the same uri starts clean (no stale "workbook closed" error inherited by a fresh notebook). */
	invalidateNotebook(uri: string): void {
		this.bindings.delete(uri);
		this.detached.delete(uri);
	}

	/**
	 * Run `task` after all previously-queued tasks for `session` finish, serializing access to the single
	 * kernel client (which rejects concurrent ops). The stored tail swallows outcomes so one rejected task
	 * does not break the chain for the next; the returned promise still settles with `task`'s real result.
	 */
	serialize<T>(session: S, task: () => Promise<T>): Promise<T> {
		const prev = this.tails.get(session) ?? Promise.resolve();
		const run = prev.then(task);
		// The tail must never reject (a poisoned tail would reject every future cell) and must observe the
		// current `run` even after a failure -- so chain a catch that resolves to void.
		this.tails.set(session, run.then(() => undefined, () => undefined));
		return run;
	}
}

/** Render one op's outcome as the plain-text status line(s) shown in the notebook cell output. Pure +
 *  vscode-free so it is unit-tested directly; the controller wraps the string in a NotebookCellOutputItem. */
export function formatOpStatus(status: OpStatus): string {
	const lines: string[] = [];
	if (status.republishCount > 0) {
		const n = status.republishCount;
		lines.push(`Recomputed ${n} grid range${n === 1 ? '' : 's'} from published variables.`);
	} else {
		lines.push('Ran. No grid cells changed.');
	}
	for (const r of status.refused) {
		lines.push(`Refused to overwrite a user formula at ${r.name}: ${r.detail}`);
	}
	if (status.stale.length > 0) {
		lines.push(`Stale (unpublished but still referenced): ${status.stale.join(', ')}`);
	}
	return lines.join('\n');
}

/** A publish-then-raise cell mutates the grid, then throws; the transport client attaches the partial op
 *  state to the thrown error (reactiveKernelClient.ts:395). Pull it off so the cell output can still
 *  report what was recomputed/refused/stale next to the error (Codex MED -- never hide a grid mutation).
 *  Returns undefined when there is nothing to report (a plain error that published nothing), so the
 *  controller does not render a misleading "no cells changed" line beside a traceback.
 *
 *  The error shape is UNTRUSTED (any thrown value), so every field is validated: a non-finite/negative
 *  count is treated as 0, and only well-formed `{name,detail}` refusals + string stale names are kept --
 *  otherwise a malformed shape (`refused: [null]`) would make `formatOpStatus` THROW inside the
 *  controller's catch and mask the real execution error (Codex re-audit MED). */
export function partialStatusFromError(e: unknown): OpStatus | undefined {
	if (typeof e !== 'object' || e === null) {
		return undefined;
	}
	const p = e as { republishCount?: unknown; refused?: unknown; stale?: unknown };
	const rawCount = p.republishCount;
	const republishCount = typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount > 0
		? Math.floor(rawCount)
		: 0;
	const refused: Array<{ name: string; detail: string }> = Array.isArray(p.refused)
		? p.refused.filter((r): r is { name: string; detail: string } =>
			typeof r === 'object' && r !== null
			&& typeof (r as { name?: unknown }).name === 'string'
			&& typeof (r as { detail?: unknown }).detail === 'string')
		: [];
	const stale: string[] = Array.isArray(p.stale)
		? p.stale.filter((s): s is string => typeof s === 'string')
		: [];
	if (republishCount === 0 && refused.length === 0 && stale.length === 0) {
		return undefined;
	}
	return { republishCount, refused, stale };
}

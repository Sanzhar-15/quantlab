/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * LifecycleManager -- per-workspace-folder daemon lifecycle registry.
 *
 * Phase 5 step C megaudit fix C12: prior `extension.ts` used
 * `folders[0]` only, so specs from folder[1+] resolved against the
 * wrong root and drift detection silently failed. The manager owns
 * one `DaemonLifecycle` per workspace folder, lazily created on first
 * use, and routes documents to the right lifecycle via
 * `getLifecycleForDocument`.
 *
 * The provider sees only the `LifecycleSource` interface (no direct
 * `DaemonLifecycle` references) so the implementation can grow
 * (e.g., shared lifecycle pools, per-tenant routing) without
 * touching provider code.
 *
 * Disposal: `disposeAll()` returns a Promise that awaits every
 * underlying lifecycle's dispose. Extension `deactivate()` MUST await
 * this -- the per-lifecycle Python child kill is async.
 */

import * as vscode from 'vscode';

import {
	type DaemonLifecycle,
	type LifecycleStatus,
} from './daemon-lifecycle';
import type { LifecycleSource } from '../views/visualise/VisualiseSpecProvider';

export interface LifecycleFactory {
	/** Create a new lifecycle for a given workspace folder root. May
	 *  return null when the environment cannot host a daemon (no
	 *  Python). The manager will surface that as "no lifecycle for this
	 *  document" without retrying until the manager is rebuilt. */
	create(workspaceRoot: string): DaemonLifecycle | null;
}

interface ManagedLifecycle {
	readonly lifecycle: DaemonLifecycle;
	readonly statusHandlers: Set<(s: LifecycleStatus) => void>;
	statusUnsubscribe: (() => void) | null;
}

export class LifecycleManager implements LifecycleSource {

	private readonly lifecycles = new Map<string, ManagedLifecycle | null>();
	private disposed = false;

	constructor(private readonly factory: LifecycleFactory) { }

	getLifecycleForDocument(documentUri: vscode.Uri): DaemonLifecycle | null {
		if (this.disposed) { return null; }
		const folder = vscode.workspace.getWorkspaceFolder(documentUri);
		if (!folder) { return null; }
		return this.ensureLifecycleForFolder(folder.uri.fsPath);
	}

	getStatusForDocument(documentUri: vscode.Uri): LifecycleStatus | null {
		const lifecycle = this.getLifecycleForDocument(documentUri);
		if (lifecycle === null) { return null; }
		return lifecycle.getStatus();
	}

	onStatusChangeForDocument(
		documentUri: vscode.Uri,
		handler: (status: LifecycleStatus) => void,
	): vscode.Disposable {
		const folder = vscode.workspace.getWorkspaceFolder(documentUri);
		if (!folder) {
			// No folder owns this URI: the handler will never fire, but
			// we still return a disposable for symmetry.
			return { dispose: () => { /* no-op */ } };
		}
		const root = folder.uri.fsPath;
		// Force lifecycle creation so its status events flow.
		this.ensureLifecycleForFolder(root);
		const managed = this.lifecycles.get(root);
		if (!managed) {
			return { dispose: () => { /* no-op */ } };
		}
		managed.statusHandlers.add(handler);
		// Lazily attach a single subscription to the lifecycle that
		// fans out to all per-document handlers. This avoids attaching
		// N status handlers to a single lifecycle if N documents are
		// open in the same workspace folder.
		if (managed.statusUnsubscribe === null) {
			managed.statusUnsubscribe = managed.lifecycle.onStatusChange((s) => {
				for (const h of [...managed.statusHandlers]) {
					h(s);
				}
			});
		}
		return {
			dispose: () => {
				managed.statusHandlers.delete(handler);
				if (managed.statusHandlers.size === 0 && managed.statusUnsubscribe) {
					managed.statusUnsubscribe();
					managed.statusUnsubscribe = null;
				}
			},
		};
	}

	/**
	 * Dispose every lifecycle the manager has created. Returns a Promise
	 * that resolves when ALL daemon child processes have exited (or
	 * been SIGKILL'd by their respective `disposeGraceMs` timers).
	 *
	 * Idempotent: subsequent calls return a resolved Promise.
	 */
	async disposeAll(): Promise<void> {
		if (this.disposed) { return; }
		this.disposed = true;
		// Megaudit Theme E (E9, 2026-05-13): fire each handler with a
		// terminal `{kind:'unavailable', error:'manager disposed'}`
		// BEFORE clearing them. Without this, subscribers (provider's
		// per-document banners) sit at their last-known status until
		// their panel disposes — the user sees "ready" on a manager
		// that's gone.
		const terminal: import('./daemon-lifecycle').LifecycleStatus = {
			kind: 'unavailable',
			error: 'lifecycle manager disposed',
		};
		const all: Promise<void>[] = [];
		for (const managed of this.lifecycles.values()) {
			if (managed === null) { continue; }
			for (const h of [...managed.statusHandlers]) {
				try { h(terminal); } catch (e) {
					// CLAUDE.md system-boundary cleanup exception.
					console.warn('lifecycleManager.disposeAll: handler threw', e);
				}
			}
			if (managed.statusUnsubscribe) {
				managed.statusUnsubscribe();
				managed.statusUnsubscribe = null;
			}
			managed.statusHandlers.clear();
			all.push(managed.lifecycle.dispose());
		}
		this.lifecycles.clear();
		await Promise.all(all);
	}

	/**
	 * Megaudit-2 A4-M5: Drop every cached lifecycle (incl. negative
	 * `null` cache entries) so the next `getLifecycleForDocument` call
	 * re-invokes the factory. Used by the extension's
	 * `onDidChangeConfiguration` listener when the user's Python path
	 * setting changes -- the previously-validated interpreter may now
	 * point at a different binary that hasn't been version-checked.
	 *
	 * Disposing the per-folder `DaemonLifecycle` instances is async
	 * (Python child SIGTERM grace period), but the cache itself is
	 * cleared synchronously so a follow-up call won't see the stale
	 * entries. Returns a Promise that resolves once every spawned
	 * child has actually exited.
	 *
	 * Distinct from `disposeAll`: this leaves the manager USABLE
	 * (does NOT set `disposed = true`); fresh `create()` invocations
	 * will replace the entries that were just discarded.
	 */
	async invalidate(): Promise<void> {
		if (this.disposed) { return; }
		const all: Promise<void>[] = [];
		for (const managed of this.lifecycles.values()) {
			if (managed === null) { continue; }
			if (managed.statusUnsubscribe) {
				managed.statusUnsubscribe();
				managed.statusUnsubscribe = null;
			}
			managed.statusHandlers.clear();
			all.push(managed.lifecycle.dispose());
		}
		this.lifecycles.clear();
		await Promise.all(all);
	}

	private ensureLifecycleForFolder(root: string): DaemonLifecycle | null {
		const cached = this.lifecycles.get(root);
		if (cached !== undefined) {
			return cached === null ? null : cached.lifecycle;
		}
		const lifecycle = this.factory.create(root);
		if (lifecycle === null) {
			// Cache the negative result so we don't retry the factory
			// every time. A user can re-trigger by reloading the window.
			this.lifecycles.set(root, null);
			return null;
		}
		this.lifecycles.set(root, {
			lifecycle,
			statusHandlers: new Set(),
			statusUnsubscribe: null,
		});
		return lifecycle;
	}
}

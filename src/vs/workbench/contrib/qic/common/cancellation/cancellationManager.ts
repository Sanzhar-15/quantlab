/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export class CancellationScope {
	private readonly controller = new AbortController();
	private readonly children: CancellationScope[] = [];
	private readonly cleanupHooks: (() => Promise<void>)[] = [];
	private _cancelled = false;

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get isCancelled(): boolean {
		return this._cancelled;
	}

	addChild(child: CancellationScope): void {
		this.children.push(child);
		if (this._cancelled) {
			child.cancel('Parent scope was already cancelled');
		}
	}

	addCleanupHook(hook: () => Promise<void>): void {
		this.cleanupHooks.push(hook);
	}

	async cancel(reason: string): Promise<void> {
		if (this._cancelled) {
			return;
		}
		this._cancelled = true;
		this.controller.abort(reason);

		// Cascade to children
		const cancelPromises = this.children.map(child => child.cancel(reason));

		// Run cleanup hooks (INV-T5)
		const cleanupPromises = this.cleanupHooks.map(hook =>
			hook().catch(() => { /* best effort cleanup */ })
		);

		await Promise.allSettled([...cancelPromises, ...cleanupPromises]);
	}
}

export class CancellationManager {
	private readonly scopes = new Map<string, CancellationScope>();

	createScope(id: string, parentId?: string): CancellationScope {
		const scope = new CancellationScope();
		this.scopes.set(id, scope);

		if (parentId) {
			const parent = this.scopes.get(parentId);
			if (parent) {
				parent.addChild(scope);
			}
		}

		return scope;
	}

	async cancel(scopeId: string, reason: string): Promise<void> {
		const scope = this.scopes.get(scopeId);
		if (scope) {
			await scope.cancel(reason);
		}
	}

	getSignal(scopeId: string): AbortSignal | undefined {
		return this.scopes.get(scopeId)?.signal;
	}

	/**
	 * Audit XII-AR9: Remove completed scope to prevent memory leaks.
	 */
	removeScope(scopeId: string): void {
		this.scopes.delete(scopeId);
	}

	/**
	 * Audit XII-AR9: Execute with automatic scope cleanup.
	 */
	async executeWithScope<T>(scopeId: string, fn: (scope: CancellationScope) => Promise<T>): Promise<T> {
		const scope = this.createScope(scopeId);
		try {
			return await fn(scope);
		} finally {
			this.removeScope(scopeId);
		}
	}

	dispose(): void {
		this.scopes.clear();
	}
}

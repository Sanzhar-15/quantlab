/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Per-component memory budget configuration (Audit VII-DS16).
 */
interface ComponentBudget {
	budgetMb: number;
	evictionPolicy: 'lru' | 'fifo' | 'lru-ttl' | 'oldest-session' | 'managed' | 'reserved';
	ttlMs?: number;
}

const COMPONENT_BUDGETS: Record<string, ComponentBudget> = {
	embeddingCache: { budgetMb: 150, evictionPolicy: 'lru' },
	bm25Index: { budgetMb: 100, evictionPolicy: 'fifo' },
	conversationState: { budgetMb: 50, evictionPolicy: 'oldest-session' },
	completionCache: { budgetMb: 50, evictionPolicy: 'lru-ttl', ttlMs: 5 * 60_000 },
	vectorIndex: { budgetMb: 100, evictionPolicy: 'managed' },
	overhead: { budgetMb: 50, evictionPolicy: 'reserved' },
};

const TOTAL_BUDGET_MB = 500;

export type MemoryPressure = 'normal' | 'elevated' | 'high' | 'critical';

export interface EvictionHandler {
	evict(policy: string, targetBytes: number): Promise<number>;
}

/**
 * Memory manager with 500MB total budget and per-component allocations (Audit VII-DS16).
 */
export class MemoryManager {

	private readonly allocations = new Map<string, number>();
	private readonly evictionHandlers = new Map<string, EvictionHandler>();

	get budgetMb(): number {
		return TOTAL_BUDGET_MB;
	}

	registerEvictionHandler(component: string, handler: EvictionHandler): void {
		this.evictionHandlers.set(component, handler);
	}

	requestAllocation(component: string, sizeBytes: number): boolean {
		const budget = COMPONENT_BUDGETS[component];
		if (!budget) { return false; }

		const currentBytes = this.allocations.get(component) ?? 0;
		const budgetBytes = budget.budgetMb * 1024 * 1024;

		if (currentBytes + sizeBytes > budgetBytes) {
			return false;
		}

		// Check total budget
		const totalAllocated = this.getTotalAllocatedBytes();
		const totalBudgetBytes = TOTAL_BUDGET_MB * 1024 * 1024;
		if (totalAllocated + sizeBytes > totalBudgetBytes) {
			return false;
		}

		this.allocations.set(component, currentBytes + sizeBytes);
		return true;
	}

	release(component: string, sizeBytes?: number): void {
		if (sizeBytes === undefined) {
			this.allocations.delete(component);
		} else {
			const current = this.allocations.get(component) ?? 0;
			const newSize = Math.max(0, current - sizeBytes);
			if (newSize === 0) {
				this.allocations.delete(component);
			} else {
				this.allocations.set(component, newSize);
			}
		}
	}

	getPressure(): MemoryPressure {
		const ratio = this.getTotalAllocatedBytes() / (TOTAL_BUDGET_MB * 1024 * 1024);
		if (ratio < 0.6) { return 'normal'; }
		if (ratio < 0.75) { return 'elevated'; }
		if (ratio < 0.9) { return 'high'; }
		return 'critical';
	}

	async handlePressure(level: MemoryPressure): Promise<void> {
		if (level === 'normal') { return; }

		// Progressive eviction based on pressure level
		const evictionOrder = this.getEvictionOrder(level);

		for (const component of evictionOrder) {
			const handler = this.evictionHandlers.get(component);
			if (!handler) { continue; }

			const budget = COMPONENT_BUDGETS[component];
			if (!budget || budget.evictionPolicy === 'reserved' || budget.evictionPolicy === 'managed') {
				continue;
			}

			const current = this.allocations.get(component) ?? 0;
			const targetReduction = Math.floor(current * this.getEvictionRatio(level));

			if (targetReduction > 0) {
				const freed = await handler.evict(budget.evictionPolicy, targetReduction);
				this.release(component, freed);
			}

			// Re-check pressure
			if (this.getPressure() === 'normal') { break; }
		}
	}

	private getEvictionOrder(level: MemoryPressure): string[] {
		switch (level) {
			case 'elevated':
				return ['completionCache', 'embeddingCache'];
			case 'high':
				return ['completionCache', 'embeddingCache', 'bm25Index'];
			case 'critical':
				return ['completionCache', 'embeddingCache', 'bm25Index', 'conversationState'];
			default:
				return [];
		}
	}

	private getEvictionRatio(level: MemoryPressure): number {
		switch (level) {
			case 'elevated': return 0.25;
			case 'high': return 0.5;
			case 'critical': return 0.75;
			default: return 0;
		}
	}

	private getTotalAllocatedBytes(): number {
		let total = 0;
		for (const bytes of this.allocations.values()) {
			total += bytes;
		}
		return total;
	}

	getComponentAllocation(component: string): number {
		return this.allocations.get(component) ?? 0;
	}
}

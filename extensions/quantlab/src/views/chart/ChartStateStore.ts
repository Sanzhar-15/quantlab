/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface ChartTabState {
	overrides: Record<string, unknown>;
	panelCollapsed: boolean;
	lastDataRequestId: number;
	lastVizRequestId: number;
	lastDataKey?: string;
	lastVizHash?: string;
}

export class ChartStateStore {
	private static instance: ChartStateStore | undefined;
	private readonly state = new Map<string, ChartTabState>();

	static getInstance(): ChartStateStore {
		if (!ChartStateStore.instance) {
			ChartStateStore.instance = new ChartStateStore();
		}
		return ChartStateStore.instance;
	}

	getOverrides(tabId: string): Record<string, unknown> {
		return { ...this.getOrCreate(tabId).overrides };
	}

	setOverride(tabId: string, id: string, value: unknown): void {
		const tab = this.getOrCreate(tabId);
		tab.overrides = { ...tab.overrides, [id]: value };
	}

	clearOverrides(tabId: string): void {
		const tab = this.getOrCreate(tabId);
		tab.overrides = {};
	}

	isPanelCollapsed(tabId: string): boolean {
		return this.getOrCreate(tabId).panelCollapsed;
	}

	setPanelCollapsed(tabId: string, collapsed: boolean): void {
		const tab = this.getOrCreate(tabId);
		tab.panelCollapsed = collapsed;
	}

	nextDataRequestId(tabId: string): number {
		const tab = this.getOrCreate(tabId);
		tab.lastDataRequestId += 1;
		return tab.lastDataRequestId;
	}

	getCurrentDataRequestId(tabId: string): number {
		return this.getOrCreate(tabId).lastDataRequestId;
	}

	isDataRequestCurrent(tabId: string, requestId: number): boolean {
		return this.getOrCreate(tabId).lastDataRequestId === requestId;
	}

	nextVizRequestId(tabId: string): number {
		const tab = this.getOrCreate(tabId);
		tab.lastVizRequestId += 1;
		return tab.lastVizRequestId;
	}

	getCurrentVizRequestId(tabId: string): number {
		return this.getOrCreate(tabId).lastVizRequestId;
	}

	isVizRequestCurrent(tabId: string, requestId: number): boolean {
		return this.getOrCreate(tabId).lastVizRequestId === requestId;
	}

	setLastDataKey(tabId: string, key: string): void {
		const tab = this.getOrCreate(tabId);
		tab.lastDataKey = key;
	}

	getLastDataKey(tabId: string): string | undefined {
		return this.getOrCreate(tabId).lastDataKey;
	}

	setLastVizHash(tabId: string, hash: string): void {
		const tab = this.getOrCreate(tabId);
		tab.lastVizHash = hash;
	}

	getLastVizHash(tabId: string): string | undefined {
		return this.getOrCreate(tabId).lastVizHash;
	}

	clearTab(tabId: string): void {
		this.state.delete(tabId);
	}

	private getOrCreate(tabId: string): ChartTabState {
		const existing = this.state.get(tabId);
		if (existing) {
			return existing;
		}

		const created: ChartTabState = {
			overrides: {},
			panelCollapsed: false,
			lastDataRequestId: 0,
			lastVizRequestId: 0
		};
		this.state.set(tabId, created);
		return created;
	}
}

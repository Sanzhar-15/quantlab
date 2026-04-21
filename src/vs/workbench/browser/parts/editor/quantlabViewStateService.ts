/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export type QuantlabViewType = 'editor' | 'chart' | 'action' | 'trade' | 'visualise' | 'stats';

export interface QuantlabTabViewState {
	readonly tabInstanceId: string;
	readonly view: QuantlabViewType;
	readonly resource?: URI;
}

export interface QuantlabTabViewStateChange {
	readonly tabInstanceId: string;
	readonly view: QuantlabViewType;
}

export const IQuantlabTabViewService = createDecorator<IQuantlabTabViewService>('quantlabTabViewService');

export interface IQuantlabTabViewService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeTabViewState: Event<QuantlabTabViewStateChange>;

	getTabViewState(tabInstanceId: string): QuantlabTabViewState | undefined;
	getTabView(tabInstanceId: string): QuantlabViewType;
	getAllTabViewStates(): Record<string, { view: QuantlabViewType; resource?: string }>;

	setTabViewState(tabInstanceId: string, view: QuantlabViewType, resource?: URI): void;
	clearTabViewState(tabInstanceId: string): void;
}

const STORAGE_KEY = 'quantlab.tabViewStates';

export function normalizeQuantlabViewType(view: string | undefined): QuantlabViewType {
	switch (view) {
		case 'chart':
		case 'action':
		case 'trade':
		case 'visualise':
		case 'stats':
		case 'editor':
			return view;
		default:
			return 'editor';
	}
}

export function formatQuantlabViewLabel(view: QuantlabViewType): string {
	switch (view) {
		case 'chart':
			return 'Chart';
		case 'action':
			return 'Action';
		case 'trade':
			return 'Trade';
		case 'visualise':
			return 'Visualise';
		case 'stats':
			return 'Stats';
		default:
			return 'Editor';
	}
}

/**
 * Converts a custom editor viewType (e.g., 'quantlab.chartView') to a QuantlabViewType (e.g., 'chart').
 * Returns 'editor' if the viewType is not a recognized Quantlab custom editor.
 */
export function customEditorViewTypeToQuantlabView(viewType: string | undefined): QuantlabViewType {
	switch (viewType) {
		case 'quantlab.chartView':
			return 'chart';
		case 'quantlab.actionView':
			return 'action';
		case 'quantlab.tradeView':
			return 'trade';
		case 'quantlab.visualiseView':
			return 'visualise';
		case 'quantlab.statsView':
			return 'stats';
		default:
			return 'editor';
	}
}

/**
 * Checks if a custom editor viewType is a recognized Quantlab view.
 */
export function isQuantlabCustomEditorViewType(viewType: string | undefined): boolean {
	return viewType === 'quantlab.chartView' ||
		viewType === 'quantlab.actionView' ||
		viewType === 'quantlab.tradeView' ||
		viewType === 'quantlab.visualiseView' ||
		viewType === 'quantlab.statsView';
}

/**
 * Converts a QuantlabViewType (e.g., 'chart') to a custom editor viewType (e.g., 'quantlab.chartView').
 * Returns 'default' for 'editor' view type to open with the default text editor.
 */
export function quantlabViewToCustomEditorViewType(view: QuantlabViewType): string {
	switch (view) {
		case 'chart':
			return 'quantlab.chartView';
		case 'action':
			return 'quantlab.actionView';
		case 'trade':
			return 'quantlab.tradeView';
		case 'visualise':
			return 'quantlab.visualiseView';
		case 'stats':
			return 'quantlab.statsView';
		default:
			return 'default';
	}
}

export class QuantlabTabViewService extends Disposable implements IQuantlabTabViewService {
	declare readonly _serviceBrand: undefined;

	private readonly states = new Map<string, QuantlabTabViewState>();

	private readonly _onDidChangeTabViewState = this._register(new Emitter<QuantlabTabViewStateChange>());
	readonly onDidChangeTabViewState = this._onDidChangeTabViewState.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();

		this.loadState();
		this._register(this.storageService.onWillSaveState(() => this.saveState()));
	}

	getTabViewState(tabInstanceId: string): QuantlabTabViewState | undefined {
		return this.states.get(tabInstanceId);
	}

	getTabView(tabInstanceId: string): QuantlabViewType {
		return this.states.get(tabInstanceId)?.view ?? 'editor';
	}

	getAllTabViewStates(): Record<string, { view: QuantlabViewType; resource?: string }> {
		const serialized: Record<string, { view: QuantlabViewType; resource?: string }> = Object.create(null);
		for (const [tabInstanceId, state] of this.states) {
			serialized[tabInstanceId] = {
				view: state.view,
				resource: state.resource?.toString()
			};
		}
		return serialized;
	}

	setTabViewState(tabInstanceId: string, view: QuantlabViewType, resource?: URI): void {
		const normalizedView = normalizeQuantlabViewType(view);
		this.states.set(tabInstanceId, { tabInstanceId, view: normalizedView, resource });
		this.saveState();
		this._onDidChangeTabViewState.fire({ tabInstanceId, view: normalizedView });
	}

	clearTabViewState(tabInstanceId: string): void {
		if (!this.states.has(tabInstanceId)) {
			return;
		}

		this.states.delete(tabInstanceId);
		this.saveState();
		this._onDidChangeTabViewState.fire({ tabInstanceId, view: 'editor' });
	}

	private saveState(): void {
		this.storageService.store(STORAGE_KEY, JSON.stringify(this.getAllTabViewStates()), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private loadState(): void {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return;
		}

		try {
			const parsed = JSON.parse(raw) as Record<string, { view: QuantlabViewType; resource?: string }>;
			for (const [tabInstanceId, state] of Object.entries(parsed)) {
				if (!state?.view) {
					continue;
				}
				const resource = state.resource ? URI.parse(state.resource) : undefined;
				this.states.set(tabInstanceId, {
					tabInstanceId,
					view: normalizeQuantlabViewType(state.view),
					resource
				});
			}
		} catch {
			this.storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
		}
	}
}

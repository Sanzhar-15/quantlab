/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { equals } from '../../../../../base/common/objects.js';
import { MenuId } from '../../../../../platform/actions/common/actions.js';
import { IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { AgentSessionStatus, IAgentSession } from './agentSessionsModel.js';
import { IAgentSessionsFilter } from './agentSessionsViewer.js';

export interface IAgentSessionsFilterOptions extends Partial<IAgentSessionsFilter> {

	readonly filterMenuId: MenuId;

	readonly limitResults?: () => number | undefined;
	notifyResults?(count: number): void;

	readonly groupResults?: () => boolean | undefined;

	overrideExclude?(session: IAgentSession): boolean | undefined;
}

interface IAgentSessionsViewExcludes {
	readonly providers: readonly string[];
	readonly states: readonly AgentSessionStatus[];

	readonly archived: boolean;
	readonly read: boolean;
}

const DEFAULT_EXCLUDES: IAgentSessionsViewExcludes = Object.freeze({
	providers: [] as const,
	states: [] as const,
	archived: true as const,
	read: false as const,
});

export class AgentSessionsFilter extends Disposable implements Required<IAgentSessionsFilter> {

	private readonly STORAGE_KEY: string;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	readonly limitResults = () => this.options.limitResults?.();
	readonly groupResults = () => this.options.groupResults?.();

	private excludes = DEFAULT_EXCLUDES;

	constructor(
		private readonly options: IAgentSessionsFilterOptions,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		this.STORAGE_KEY = `agentSessions.filterExcludes.${this.options.filterMenuId.id.toLowerCase()}`;

		this.updateExcludes(false);

		this.registerListeners();
	}

	private registerListeners(): void {
		this._register(this.storageService.onDidChangeValue(StorageScope.PROFILE, this.STORAGE_KEY, this._store)(() => this.updateExcludes(true)));
	}

	private updateExcludes(fromEvent: boolean): void {
		const excludedTypesRaw = this.storageService.get(this.STORAGE_KEY, StorageScope.PROFILE);
		if (excludedTypesRaw) {
			try {
				this.excludes = JSON.parse(excludedTypesRaw) as IAgentSessionsViewExcludes;
			} catch {
				this.resetExcludes();
			}
		} else {
			this.resetExcludes();
		}

		if (fromEvent) {
			this._onDidChange.fire();
		}
	}

	private resetExcludes(): void {
		this.excludes = {
			providers: [...DEFAULT_EXCLUDES.providers],
			states: [...DEFAULT_EXCLUDES.states],
			archived: DEFAULT_EXCLUDES.archived,
			read: DEFAULT_EXCLUDES.read,
		};
	}



	isDefault(): boolean {
		return equals(this.excludes, DEFAULT_EXCLUDES);
	}

	exclude(session: IAgentSession): boolean {
		const overrideExclude = this.options?.overrideExclude?.(session);
		if (typeof overrideExclude === 'boolean') {
			return overrideExclude;
		}

		if (this.excludes.archived && session.isArchived()) {
			return true;
		}

		if (this.excludes.read && (session.isArchived() || session.isRead())) {
			return true;
		}

		if (this.excludes.providers.includes(session.providerType)) {
			return true;
		}

		if (this.excludes.states.includes(session.status)) {
			return true;
		}

		return false;
	}

	notifyResults(count: number): void {
		this.options.notifyResults?.(count);
	}
}

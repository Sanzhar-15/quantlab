/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived } from '../../../../base/common/observable.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IChatContextPickService } from '../../chat/browser/attachments/chatContextPickService.js';
import { IMcpService, McpCapability } from '../common/mcpTypes.js';

export class McpAddContextContribution extends Disposable implements IWorkbenchContribution {
	private readonly _addContextMenu = this._register(new MutableDisposable());
	constructor(
		@IChatContextPickService _chatContextPickService: IChatContextPickService,
		@IInstantiationService _instantiationService: IInstantiationService,
		@IMcpService mcpService: IMcpService
	) {
		super();

		const hasServersWithResources = derived(reader => {
			let enabled = false;
			for (const server of mcpService.servers.read(reader)) {
				const cap = server.capabilities.read(undefined);
				if (cap === undefined) {
					enabled = true; // until we know more
				} else if (cap & McpCapability.Resources) {
					enabled = true;
					break;
				}
			}

			return enabled;
		});

		this._register(autorun(reader => {
			const enabled = hasServersWithResources.read(reader);
			if (enabled && !this._addContextMenu.value) {
				this._registerAddContextMenu();
			} else {
				this._addContextMenu.clear();
			}
		}));
	}

	private _registerAddContextMenu() {
	}

}

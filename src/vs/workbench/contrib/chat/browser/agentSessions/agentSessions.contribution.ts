/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IAgentSessionsService, AgentSessionsService } from './agentSessionsService.js';
import { LocalAgentsSessionsProvider } from './localAgentSessionsProvider.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';

//#region Actions and Menus

// --- Agent Sessions Toolbar

// --- Sessions Title Toolbar

//#endregion

//#region Workbench Contributions

registerWorkbenchContribution2(LocalAgentsSessionsProvider.ID, LocalAgentsSessionsProvider, WorkbenchPhase.AfterRestored);
registerSingleton(IAgentSessionsService, AgentSessionsService, InstantiationType.Delayed);

//#endregion

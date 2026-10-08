/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditTelemetryContribution } from './editTelemetryContribution.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IAiEditTelemetryService } from './telemetry/aiEditTelemetry/aiEditTelemetryService.js';
import { AiEditTelemetryServiceImpl } from './telemetry/aiEditTelemetry/aiEditTelemetryServiceImpl.js';
import { IRandomService, RandomService } from './randomService.js';

registerWorkbenchContribution2('EditTelemetryContribution', EditTelemetryContribution, WorkbenchPhase.AfterRestored);

registerSingleton(IAiEditTelemetryService, AiEditTelemetryServiceImpl, InstantiationType.Delayed);
registerSingleton(IRandomService, RandomService, InstantiationType.Delayed);

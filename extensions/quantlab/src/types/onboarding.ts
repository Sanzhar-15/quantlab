/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type OnboardingStep = 'welcome';

export type FeatureDiscoveryTrigger =
	| 'firstViewSwitch'
	| 'firstBacktestComplete'
	| 'firstParameterEdit'
	| 'firstTradeView'
	| 'tenRuns';

export interface OnboardingState {
	hasSeenWelcome: boolean;
	skippedTour: boolean;
	dismissedTips: string[];
	lastStep?: OnboardingStep;
}

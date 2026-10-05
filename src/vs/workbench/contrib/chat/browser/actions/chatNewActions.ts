/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


export interface INewEditSessionActionContext {

	/**
	 * An initial prompt to write to the chat.
	 */
	inputValue?: string;

	/**
	 * Selects opening in agent mode or not. If not set, the current mode is used.
	 * This is ignored when coming from a chat view title context.
	 */
	agentMode?: boolean;

	/**
	 * Whether the inputValue is partial and should wait for further user input.
	 * If false or not set, the prompt is sent immediately.
	 */
	isPartialQuery?: boolean;
}


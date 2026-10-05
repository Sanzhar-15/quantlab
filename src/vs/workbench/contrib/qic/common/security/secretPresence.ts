/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

function presence(value: string | undefined): 'found' | 'not found' {
	return value ? 'found' : 'not found';
}

/**
 * The log text for the BYOK secret-storage lookup. It says only whether each key is present; no
 * character of either key (no prefix, no suffix, no length) ever reaches the log.
 */
export function describeSecretPresence(anthropicKey: string | undefined, openaiKey: string | undefined): string {
	return `Secret storage lookup: anthropic=${presence(anthropicKey)}, openai=${presence(openaiKey)}`;
}

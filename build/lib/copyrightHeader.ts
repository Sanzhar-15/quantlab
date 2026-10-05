/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const headerLines = (holder: string): readonly string[] => [
	'/*---------------------------------------------------------------------------------------------',
	` *  Copyright (c) ${holder}. All rights reserved.`,
	' *  Licensed under the MIT License. See License.txt in the project root for license information.',
	' *--------------------------------------------------------------------------------------------*/',
];

/**
 * The accepted copyright holders: upstream's, and this fork's own files (QuantLab). Any other holder,
 * or a header that is not the file's first four lines exactly, is refused.
 */
export const copyrightHeaders: readonly (readonly string[])[] = [
	headerLines('Microsoft Corporation'),
	headerLines('Quantlab'),
];

export function hasCopyrightHeader(lines: readonly string[]): boolean {
	return copyrightHeaders.some(header => header.every((headerLine, i) => lines[i] === headerLine));
}

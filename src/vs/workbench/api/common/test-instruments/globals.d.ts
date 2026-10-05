/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Ambient declarations for the test-build instruments (QL-HOST U1).
// `QL_TEST_BUILD` is substituted by the esbuild `define` in build/lib/optimize.ts
// (`globalThis.QL_TEST_BUILD`); it is undefined in an un-bundled run.

declare global {

	var QL_TEST_BUILD: boolean | undefined;
	var __qlTestInstrumentRequest: boolean | undefined;
	var __qlTestInstrumentExtHostApi: boolean | undefined;
}

// fake export to make global work
export { };

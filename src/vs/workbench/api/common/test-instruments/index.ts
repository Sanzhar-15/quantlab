/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Test-build instrument stub (QL-HOST U1). Loaded only by the define-guarded dynamic import
// in extHost.api.impl.ts; the guard is removed from release bundles by the build `define`.

globalThis.__qlTestInstrumentExtHostApi = true;

export { };

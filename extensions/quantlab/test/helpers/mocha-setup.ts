/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Mocha root setup -- runs once BEFORE any test module is loaded.
 *
 * Wired via `package.json` `test` / `test:all` scripts with
 * `--require out/test/helpers/mocha-setup.js`. Mocha calls require()
 * on this file before mocha discovers any test files, so DOM globals
 * exist by the time test modules import production components.
 *
 * Phase 9 megaudit M-21 cure: the previous pattern of calling
 * `installDom()` between `import` statements at the top of each test
 * file worked in CommonJS (TSC emits ordered `require()`s) but would
 * silently break under ESM where all imports hoist above any side
 * effects. Moving the install to a Mocha --require hook makes the
 * DOM-install timing explicit and bundler-strategy-agnostic.
 */

import { installDom } from './jsdom-shim';

// Eagerly install at module load. Mocha guarantees this runs before
// the test files mocha discovers via its globs. The shim is idempotent
// (installed = true short-circuits) so re-imports from inside test
// files are no-ops.
installDom();

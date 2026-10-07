/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isExtensionSignatureVerificationOn } from '../../node/extensionSignatureVerificationPolicy.js';

suite('ExtensionSignatureVerificationPolicy Tests', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function settingMustNotBeRead(): unknown {
		throw new Error('the extensions.verifySignature user setting must not be consulted');
	}

	test('product key false: verification is off and the user setting is not consulted', () => {
		assert.strictEqual(isExtensionSignatureVerificationOn({ extensionSignatureVerification: false }, settingMustNotBeRead), false);
	});

	test('product key true: the user setting decides, an unset or non-boolean setting means on', () => {
		const product = { extensionSignatureVerification: true };
		assert.strictEqual(isExtensionSignatureVerificationOn(product, () => undefined), true);
		assert.strictEqual(isExtensionSignatureVerificationOn(product, () => true), true);
		assert.strictEqual(isExtensionSignatureVerificationOn(product, () => false), false);
		assert.strictEqual(isExtensionSignatureVerificationOn(product, () => 'false'), true);
	});

	test('product key absent: throws naming the key', () => {
		assert.throws(() => isExtensionSignatureVerificationOn({}, () => true), /product key extensionSignatureVerification must be true or false, got undefined/);
	});

	test('product key not a boolean: throws naming the key', () => {
		assert.throws(() => isExtensionSignatureVerificationOn({ extensionSignatureVerification: 'false' }, () => true), /product key extensionSignatureVerification must be true or false, got "false"/);
		assert.throws(() => isExtensionSignatureVerificationOn({ extensionSignatureVerification: null }, () => true), /got null/);
	});
});

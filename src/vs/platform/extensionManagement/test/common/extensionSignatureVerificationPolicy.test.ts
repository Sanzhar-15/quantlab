/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { extensionSignatureVerificationOffMessage, extensionSignatureVerificationOffReason, isExtensionSignatureVerificationOn } from '../../common/extensionSignatureVerificationPolicy.js';

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

	test('off reason: product false is the product policy and the throwing setting reader is not called', () => {
		assert.strictEqual(extensionSignatureVerificationOffReason({ extensionSignatureVerification: false }, settingMustNotBeRead), 'product');
	});

	test('off reason: product true and setting false is the user setting, never the product policy', () => {
		const reason = extensionSignatureVerificationOffReason({ extensionSignatureVerification: true }, () => false);
		assert.ok(reason !== undefined);
		assert.strictEqual(reason, 'setting');
		const message = extensionSignatureVerificationOffMessage(reason, 'extensions.verifySignature');
		assert.ok(!message.includes('extensionSignatureVerification=false'), message);
		assert.ok(message.includes('extensions.verifySignature=false') && message.includes('extensionSignatureVerification=true'), message);
	});

	test('off reason: product true and setting on or unset is on', () => {
		const product = { extensionSignatureVerification: true };
		assert.strictEqual(extensionSignatureVerificationOffReason(product, () => true), undefined);
		assert.strictEqual(extensionSignatureVerificationOffReason(product, () => undefined), undefined);
		assert.strictEqual(extensionSignatureVerificationOffReason(product, () => 'false'), undefined);
	});

	test('off message: the product reason names the product key as false', () => {
		assert.strictEqual(extensionSignatureVerificationOffMessage('product', 'extensions.verifySignature'), 'extension signature verification is off in this build (product.extensionSignatureVerification=false)');
	});

	test('product key absent: throws naming the key', () => {
		assert.throws(() => isExtensionSignatureVerificationOn({}, () => true), /product key extensionSignatureVerification must be true or false, got undefined/);
	});

	test('product key not a boolean: throws naming the key', () => {
		assert.throws(() => isExtensionSignatureVerificationOn({ extensionSignatureVerification: 'false' }, () => true), /product key extensionSignatureVerification must be true or false, got "false"/);
		assert.throws(() => isExtensionSignatureVerificationOn({ extensionSignatureVerification: null }, () => true), /got null/);
	});
});

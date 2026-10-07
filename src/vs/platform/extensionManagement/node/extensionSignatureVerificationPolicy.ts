/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isBoolean } from '../../../base/common/types.js';

// The packaged product.json key `extensionSignatureVerification` decides whether extension package
// signatures are verified at install time:
//   false -> never verified in this build (the `extensions.verifySignature` user setting is not consulted);
//   true  -> verified, subject to the `extensions.verifySignature` user setting (default true).
// A key that is absent or not a boolean is a build defect and throws by name.

export const EXTENSION_SIGNATURE_VERIFICATION_PRODUCT_KEY = 'extensionSignatureVerification';

export function isExtensionSignatureVerificationOn(product: object, readUserSetting: () => unknown): boolean {
	const key: unknown = (product as Record<string, unknown>)[EXTENSION_SIGNATURE_VERIFICATION_PRODUCT_KEY];
	if (key === false) {
		return false;
	}
	if (key !== true) {
		throw new Error(`extensionManagement: product key ${EXTENSION_SIGNATURE_VERIFICATION_PRODUCT_KEY} must be true or false, got ${JSON.stringify(key)}`);
	}
	const setting = readUserSetting();
	return isBoolean(setting) ? setting : true;
}

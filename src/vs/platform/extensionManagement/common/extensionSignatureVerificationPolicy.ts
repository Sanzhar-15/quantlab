/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The packaged product.json key `extensionSignatureVerification` decides whether extension package
// signatures are verified at install time:
//   false -> never verified in this build (the `extensions.verifySignature` user setting is not consulted);
//   true  -> verified, subject to the `extensions.verifySignature` user setting (default true).
// A key that is absent or not a boolean is a build defect and throws by name.
//
// This module is in `common` because both the install service (node) and the remote install wrapper
// (electron-browser) must apply the product policy before the user setting.

export const EXTENSION_SIGNATURE_VERIFICATION_PRODUCT_KEY = 'extensionSignatureVerification';

/** What turned verification off: the packaged product policy, or the user's setting. */
export type ExtensionSignatureVerificationOffReason = 'product' | 'setting';

/**
 * Why verification is off, or `undefined` when it is on. The product policy is read first; the user setting
 * is read only when the product key is `true`.
 */
export function extensionSignatureVerificationOffReason(product: object, readUserSetting: () => unknown): ExtensionSignatureVerificationOffReason | undefined {
	const key: unknown = (product as Record<string, unknown>)[EXTENSION_SIGNATURE_VERIFICATION_PRODUCT_KEY];
	if (key === false) {
		return 'product';
	}
	if (key !== true) {
		throw new Error(`extensionManagement: product key ${EXTENSION_SIGNATURE_VERIFICATION_PRODUCT_KEY} must be true or false, got ${JSON.stringify(key)}`);
	}
	return readUserSetting() === false ? 'setting' : undefined;
}

export function isExtensionSignatureVerificationOn(product: object, readUserSetting: () => unknown): boolean {
	return extensionSignatureVerificationOffReason(product, readUserSetting) === undefined;
}

/** The log line for the reason. It names the product key as `false` only when the product policy is what turned verification off. */
export function extensionSignatureVerificationOffMessage(reason: ExtensionSignatureVerificationOffReason, userSettingKey: string): string {
	switch (reason) {
		case 'product':
			return `extension signature verification is off in this build (product.${EXTENSION_SIGNATURE_VERIFICATION_PRODUCT_KEY}=false)`;
		case 'setting':
			return `extension signature verification is off by the user setting ${userSettingKey}=false (product.${EXTENSION_SIGNATURE_VERIFICATION_PRODUCT_KEY}=true)`;
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IGalleryExtension, ILocalExtension, InstallOptions, VerifyExtensionSignatureConfigKey } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { NativeRemoteExtensionManagementService } from '../../electron-browser/remoteExtensionManagementService.js';

suite('NativeRemoteExtensionManagementService signature verification policy', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface Internals {
		doInstallFromGallery(extension: IGalleryExtension, installOptions: InstallOptions): Promise<ILocalExtension>;
		installUIDependenciesAndPackedExtensions(local: ILocalExtension): Promise<void>;
	}

	/** Runs `installFromGallery` and returns the `donotVerifySignature` the install was handed. */
	async function installWith(product: object, readSetting: () => unknown, installOptions: InstallOptions = {}): Promise<boolean | undefined> {
		const channel = { listen: () => Event.None, call: () => { throw new Error('the channel must not be called'); } } as unknown as IChannel;
		const configurationService = { getValue: (key: string) => { if (key === VerifyExtensionSignatureConfigKey) { return readSetting(); } throw new Error(`unexpected setting ${key}`); } };
		const userDataProfileService = { onDidChangeCurrentProfile: Event.None };
		const service = store.add(new NativeRemoteExtensionManagementService(
			channel,
			undefined as never,
			product as never,
			userDataProfileService as never,
			undefined as never,
			undefined as never,
			undefined as never,
			undefined as never,
			undefined as never,
			configurationService as never,
			undefined as never,
			undefined as never,
			undefined as never));

		let received: InstallOptions | undefined;
		const internals = service as unknown as Internals;
		internals.doInstallFromGallery = async (_extension, options) => { received = options; return {} as ILocalExtension; };
		internals.installUIDependenciesAndPackedExtensions = async () => { };

		await service.installFromGallery({} as IGalleryExtension, installOptions);
		assert.ok(received);
		return received.donotVerifySignature;
	}

	function settingMustNotBeRead(): unknown {
		throw new Error('the extensions.verifySignature user setting must not be consulted');
	}

	test('product false: verification is skipped and the user setting is not read', async () => {
		assert.strictEqual(await installWith({ extensionSignatureVerification: false }, settingMustNotBeRead), true);
	});

	test('product true: the user setting decides', async () => {
		const product = { extensionSignatureVerification: true };
		assert.strictEqual(await installWith(product, () => false), true);
		assert.strictEqual(await installWith(product, () => true), false);
		assert.strictEqual(await installWith(product, () => undefined), false);
	});

	test('an explicit donotVerifySignature is kept and the policy is not consulted', async () => {
		assert.strictEqual(await installWith({}, settingMustNotBeRead, { donotVerifySignature: true }), true);
	});

	test('product key absent: throws naming the key', async () => {
		await assert.rejects(() => installWith({}, () => true), /product key extensionSignatureVerification must be true or false, got undefined/);
	});
});

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export class SecureStorage {
	private static instance: SecureStorage | undefined;

	private constructor(private readonly secrets: vscode.SecretStorage) { }

	static initialize(context: vscode.ExtensionContext): SecureStorage {
		if (!SecureStorage.instance) {
			SecureStorage.instance = new SecureStorage(context.secrets);
		}
		return SecureStorage.instance;
	}

	static getInstance(): SecureStorage {
		if (!SecureStorage.instance) {
			throw new Error('SecureStorage not initialized');
		}
		return SecureStorage.instance;
	}

	get(key: string): Thenable<string | undefined> {
		return this.secrets.get(key);
	}

	store(key: string, value: string): Thenable<void> {
		return this.secrets.store(key, value);
	}

	delete(key: string): Thenable<void> {
		return this.secrets.delete(key);
	}
}

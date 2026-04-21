/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Audit S-6 / I-SG10: Use node:crypto ONLY — crypto.subtle is unreliable in extension host.
// Lazy-loaded to avoid breaking the ESM module loader in VS Code's sandboxed renderer.
let _nodeCrypto: typeof import('node:crypto') | null = null;

async function ensureNodeCrypto(): Promise<typeof import('node:crypto')> {
	if (!_nodeCrypto) {
		try {
			// @ts-ignore — dynamic import of node: protocol
			_nodeCrypto = await import('node:crypto');
		} catch {
			throw new Error('Conversation encryption requires Node.js crypto (not available in browser)');
		}
	}
	return _nodeCrypto;
}

function getNodeCrypto(): typeof import('node:crypto') {
	if (!_nodeCrypto) {
		throw new Error('Conversation encryption requires Node.js crypto — call ensureNodeCrypto() first');
	}
	return _nodeCrypto;
}

export interface EncryptedPayload {
	iv: Buffer;
	ciphertext: Buffer;
	authTag: Buffer;
}

export class ConversationCipher {
	private readonly algorithm = 'aes-256-gcm' as const;

	async deriveKey(workspacePath: string, salt?: Buffer): Promise<{ key: Buffer; salt: Buffer }> {
		const crypto = await ensureNodeCrypto();
		const derivedSalt = salt ?? crypto.randomBytes(16);
		const key = crypto.pbkdf2Sync(workspacePath, derivedSalt, 100_000, 32, 'sha256');
		return { key, salt: derivedSalt };
	}

	encrypt(plaintext: string, key: Buffer): EncryptedPayload {
		const iv = getNodeCrypto().randomBytes(12);
		const cipher = getNodeCrypto().createCipheriv(this.algorithm, key, iv);
		const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		const authTag = cipher.getAuthTag();
		return { iv, ciphertext: encrypted, authTag };
	}

	decrypt(payload: EncryptedPayload, key: Buffer): string {
		const decipher = getNodeCrypto().createDecipheriv(this.algorithm, key, payload.iv);
		decipher.setAuthTag(payload.authTag);
		const decrypted = Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]);
		return decrypted.toString('utf8');
	}
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const SENSITIVE_PATTERNS = [
	/sk-[a-zA-Z0-9]{20,}/g,
	/sk-ant-[a-zA-Z0-9\-]{20,}/g,
	/Bearer\s+[a-zA-Z0-9._\-]+/gi,
	/x-api-key:\s*[a-zA-Z0-9._\-]+/gi,
	/api[_\-]?key["']?\s*[:=]\s*["']?[a-zA-Z0-9._\-]{10,}/gi,
];
const MAX_BODY_LEN = 200;

export function redactErrorBody(body: string): string {
	let r = body;
	for (const p of SENSITIVE_PATTERNS) { r = r.replace(p, '[REDACTED]'); }
	return r.length > MAX_BODY_LEN ? r.slice(0, MAX_BODY_LEN) + '...[truncated]' : r;
}

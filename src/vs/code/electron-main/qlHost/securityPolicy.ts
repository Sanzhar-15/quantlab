/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (review c1 M2 + M3): which documents belong to the workbench, decided by frame ownership, never by a URL
// prefix. No run-time imports: `build/qlhost/check-workbench-security.mjs` runs this file against fake frames.
//
// Ownership, from the top down:
//  - the workbench document: the main frame whose URL, without query and fragment, is exactly the document the CodeWindow
//    loads (`windowImpl.ts` `load`; the `VSCODE_DEV_SERVER_URL` override is not a workbench document here);
//  - a registered webview: a `vscode-webview://<authority>/index.html` frame whose parent is the workbench document (the
//    workbench's webview element creates it; `app.ts` already refuses an `index.html` request from any other process);
//  - its content frame: `vscode-webview://<same authority>/fake.html` whose parent is that `index.html` frame;
//  - `about:blank` / `about:srcdoc` frames whose parent is owned (the workbench document, an owned webview frame, an owned blank).
// Everything else is unowned: another webview authority, a webview not created by the workbench, any other scheme or host
// (an https page inside a webview included), and blank/srcdoc frames under any of those.
//
// Permissions (M3): an owned document gets `clipboard-sanitized-write` and `fullscreen`; every other permission, and every
// permission for an unowned document, is denied. One decision serves the request and the check handler.

export interface IQlFramePolicy {

	/** The document the CodeWindow loads, e.g. `vscode-file://vscode-app/<app root>/out/vs/code/electron-browser/workbench/workbench.html`. */
	readonly workbenchDocument: string;

	/** `Schemas.vscodeWebview`. */
	readonly webviewScheme: string;
}

/** The only permissions an owned document is granted (M3). */
export const QL_GRANTED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen']);

/** The parts of a frame the policy reads (`WebFrameMain` has them). */
export interface IQlFrame {
	readonly url: string;
	readonly parent: IQlFrame | null;
}

/** The parts of a web contents the policy reads (`WebContents` has them). */
export interface IQlContents {
	readonly mainFrame: IQlFrame & { readonly framesInSubtree: readonly IQlFrame[] };
}

interface IParsedDocument {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
}

function parseDocument(url: string): IParsedDocument | undefined {
	if (url === 'about:blank' || url === 'about:srcdoc') {
		return { scheme: 'about', authority: '', path: url.slice('about:'.length) };
	}

	if (!URL.canParse(url)) {
		return undefined;
	}

	const parsed = new URL(url);
	return { scheme: parsed.protocol.slice(0, -1), authority: parsed.host, path: parsed.pathname };
}

function isWorkbenchDocument(url: string, policy: IQlFramePolicy): boolean {
	const document = parseDocument(url);
	const workbench = parseDocument(policy.workbenchDocument);
	if (!workbench) {
		throw new Error(`QuantLab host: the workbench document ${policy.workbenchDocument} is not a URL`);
	}

	return !!document && document.scheme === workbench.scheme && document.authority === workbench.authority && document.path === workbench.path;
}

/** A frame is the workbench's top document (no parent, the workbench's own document). */
function isWorkbenchFrame(frame: IQlFrame, policy: IQlFramePolicy): boolean {
	return frame.parent === null && isWorkbenchDocument(frame.url, policy);
}

/** The webview authority of an owned webview frame, or undefined when `frame` is not one. */
function ownedWebviewAuthority(frame: IQlFrame, policy: IQlFramePolicy): string | undefined {
	const document = parseDocument(frame.url);
	if (!document || document.scheme !== policy.webviewScheme || !frame.parent) {
		return undefined;
	}

	return isOwnedDocument(frame.url, frame.parent, policy) ? document.authority : undefined;
}

/** Whether a document at `url` with parent frame `parent` is owned. A top frame (`parent` null) is owned only as the workbench document. */
function isOwnedDocument(url: string, parent: IQlFrame | null, policy: IQlFramePolicy): boolean {
	if (parent === null) {
		return isWorkbenchDocument(url, policy);
	}

	const document = parseDocument(url);
	if (!document) {
		return false;
	}

	if (document.scheme === 'about') {
		return isOwnedFrame(parent, policy);
	}

	if (document.scheme !== policy.webviewScheme) {
		return false;
	}

	if (document.path === '/index.html') {
		return isWorkbenchFrame(parent, policy);
	}

	if (document.path === '/fake.html') {
		const parentDocument = parseDocument(parent.url);
		return parentDocument?.path === '/index.html' && ownedWebviewAuthority(parent, policy) === document.authority;
	}

	return false;
}

/** Whether `frame`, as it is now, is an owned document. */
export function isOwnedFrame(frame: IQlFrame, policy: IQlFramePolicy): boolean {
	return isOwnedDocument(frame.url, frame.parent, policy);
}

/**
 * M2: a navigation (or a redirect) of `frame` to `url` is let through only when the destination would be owned in `frame`'s
 * place. A sub-frame navigation whose frame or parent Electron does not report is denied.
 */
export function isAllowedNavigation(url: string, isMainFrame: boolean, frame: IQlFrame | null, policy: IQlFramePolicy): boolean {
	if (isMainFrame) {
		return isOwnedDocument(url, null, policy);
	}

	const parent = frame?.parent;
	return !!parent && isOwnedDocument(url, parent, policy);
}

/**
 * M3: the one permission decision of the default session's request and check handlers. Granted only when `permission` is in
 * QL_GRANTED_PERMISSIONS and the requesting document is owned: for a main frame, the contents' main frame is the workbench
 * document and `requestingUrl` is that document; for a sub-frame, at least one frame of the contents has `requestingUrl`
 * and every frame with that URL is owned.
 */
export function isGrantedPermission(contents: IQlContents | null, permission: string, requestingUrl: string | undefined, isMainFrame: boolean, policy: IQlFramePolicy): boolean {
	if (!contents || !requestingUrl || !QL_GRANTED_PERMISSIONS.has(permission)) {
		return false;
	}

	const mainFrame = contents.mainFrame;
	if (!isWorkbenchFrame(mainFrame, policy)) {
		return false;
	}

	if (isMainFrame) {
		return isWorkbenchDocument(requestingUrl, policy);
	}

	const requesting = mainFrame.framesInSubtree.filter(frame => frame.parent !== null && frame.url === requestingUrl);
	return requesting.length > 0 && requesting.every(frame => isOwnedFrame(frame, policy));
}

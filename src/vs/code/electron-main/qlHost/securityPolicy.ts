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
//  - a registered webview (review c2 M2 + M3): a `vscode-webview://<authority>/index.html` frame, direct child of the workbench
//    document, that is BOUND to a registration with that authority. The workbench's webview element registers its frame
//    name and authority with the main process before the frame gets its `src` (`webviewRegistry.ts`); the first navigation
//    of a direct child with that name to that authority's `index.html` binds the frame (its `frameTreeNodeId`), one frame
//    per registration. Ancestry alone is not registration: an unregistered or unbound frame with the same parent and the
//    same URL is unowned;
//  - its content frame: `vscode-webview://<same authority>/fake.html` whose parent is that `index.html` frame;
//  - `about:blank` / `about:srcdoc` frames whose parent is owned (the workbench document, an owned webview frame, an owned blank).
// Everything else is unowned: another webview authority, a webview the workbench did not register, any other scheme or host
// (an https page inside a webview included), and blank/srcdoc frames under any of those.
//
// Permissions (M3): an owned document gets `clipboard-sanitized-write` and `fullscreen`; every other permission, and every
// permission for an unowned document, is denied. One decision serves the request and the check handler.

export interface IQlFramePolicy {

	/** The document the CodeWindow loads, e.g. `vscode-file://vscode-app/<app root>/out/vs/code/electron-browser/workbench/workbench.html`. */
	readonly workbenchDocument: string;

	/** `Schemas.vscodeWebview`. */
	readonly webviewScheme: string;

	/** The webviews the workbench document of `contents` registered (`webviewRegistry.ts`). */
	webviews(contents: IQlContents): IQlWebviewRegistrations;
}

/** The registrations of one workbench contents, as the ownership decisions read (and, for a first navigation, bind) them. */
export interface IQlWebviewRegistrations {

	/** The authority of the registration bound to the frame `frameTreeNodeId`, or undefined when the frame is bound to none. */
	boundAuthority(frameTreeNodeId: number): string | undefined;

	/**
	 * Binds the registration `frameName` to the frame `frameTreeNodeId` when it has `authority`, the frame is bound to no
	 * registration, and the registration is unbound or its frame no longer exists. Returns whether it bound.
	 */
	bind(frameName: string, authority: string, frameTreeNodeId: number): boolean;
}

/** The only permissions an owned document is granted (M3). */
export const QL_GRANTED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write', 'fullscreen']);

/** The parts of a frame the policy reads (`WebFrameMain` has them). */
export interface IQlFrame {
	readonly url: string;
	readonly parent: IQlFrame | null;
	readonly name: string;
	readonly frameTreeNodeId: number;
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

/**
 * The webview authority of a registered webview's own frame (an `index.html` directly under the workbench document, bound to
 * that authority), or undefined when `frame` is not one. Only this frame's children are its content.
 */
function ownedIndexAuthority(frame: IQlFrame, policy: IQlFramePolicy, webviews: IQlWebviewRegistrations): string | undefined {
	const document = parseDocument(frame.url);
	if (!document || document.scheme !== policy.webviewScheme || document.path !== '/index.html' || frame.parent === null || !isWorkbenchFrame(frame.parent, policy)) {
		return undefined;
	}

	return webviews.boundAuthority(frame.frameTreeNodeId) === document.authority ? document.authority : undefined;
}

/** Whether `frame`, as it is now, is an owned document. A top frame is owned only as the workbench document. */
export function isOwnedFrame(frame: IQlFrame, policy: IQlFramePolicy, webviews: IQlWebviewRegistrations): boolean {
	const parent = frame.parent;
	if (parent === null) {
		return isWorkbenchDocument(frame.url, policy);
	}

	const document = parseDocument(frame.url);
	if (!document) {
		return false;
	}

	if (document.scheme === 'about') {
		return isOwnedFrame(parent, policy, webviews);
	}

	if (document.scheme !== policy.webviewScheme) {
		return false;
	}

	if (document.path === '/index.html') {
		if (isWorkbenchFrame(parent, policy)) {
			return webviews.boundAuthority(frame.frameTreeNodeId) === document.authority;
		}

		// review c3 M2/M3: the webview's content frame. Stock index.html loads it at fake.html and then writes its document
		// (`contentDocument.open/write/close`), after which the frame reports its writer's URL: this index.html. It is owned
		// under the registered webview's own frame of the same authority, one level only (a deeper index.html is not).
		return ownedIndexAuthority(parent, policy, webviews) === document.authority;
	}

	if (document.path === '/fake.html') {
		return ownedIndexAuthority(parent, policy, webviews) === document.authority;
	}

	return false;
}

/**
 * TEST builds only (app.ts, `globalThis.QL_TEST_BUILD`): one line per sub-frame of `contents` whose URL is `requestingUrl`,
 * as the permission decision reads it (frame id, URL, parent id and URL, owned), for the package rows of review c3 M2/M3.
 */
export function qlPermissionFrameLines(contents: IQlContents | null, requestingUrl: string | undefined, policy: IQlFramePolicy): string {
	if (!contents || !requestingUrl) {
		return `no contents or no requesting URL (${requestingUrl})`;
	}

	const webviews = policy.webviews(contents);
	const frames = contents.mainFrame.framesInSubtree.filter(frame => frame.parent !== null && frame.url === requestingUrl);
	return frames.length === 0 ? 'no sub-frame has the requesting URL' : frames.map(frame => `[frame ${frame.frameTreeNodeId} ${frame.url} parent ${frame.parent?.frameTreeNodeId} ${frame.parent?.url} owned=${isOwnedFrame(frame, policy, webviews)}]`).join(' ');
}

/**
 * M2: a navigation (or a redirect) of `frame` to `url` is let through only when the destination would be owned in `frame`'s
 * place. A sub-frame navigation whose frame or parent Electron does not report is denied. The navigation of a direct child
 * of the workbench document to a registered authority's `index.html` is the one place a registration is bound: a frame
 * already bound goes only to its own registration's authority, an unbound one binds by its name.
 */
export function isAllowedNavigation(contents: IQlContents, url: string, isMainFrame: boolean, frame: IQlFrame | null, policy: IQlFramePolicy): boolean {
	if (isMainFrame) {
		return isWorkbenchDocument(url, policy);
	}

	const parent = frame?.parent;
	if (!frame || !parent) {
		return false;
	}

	const document = parseDocument(url);
	if (!document) {
		return false;
	}

	const webviews = policy.webviews(contents);
	if (document.scheme === 'about') {
		return isOwnedFrame(parent, policy, webviews);
	}

	if (document.scheme !== policy.webviewScheme) {
		return false;
	}

	if (document.path === '/index.html') {
		if (!isWorkbenchFrame(parent, policy)) {
			return false;
		}

		const bound = webviews.boundAuthority(frame.frameTreeNodeId);
		return bound === undefined ? webviews.bind(frame.name, document.authority, frame.frameTreeNodeId) : bound === document.authority;
	}

	if (document.path === '/fake.html') {
		return ownedIndexAuthority(parent, policy, webviews) === document.authority;
	}

	return false;
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

	const webviews = policy.webviews(contents);
	const requesting = mainFrame.framesInSubtree.filter(frame => frame.parent !== null && frame.url === requestingUrl);
	return requesting.length > 0 && requesting.every(frame => isOwnedFrame(frame, policy, webviews));
}

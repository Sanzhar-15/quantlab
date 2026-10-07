/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (U5): the workbench column of the security matrix, for the contents the host adopted.
//
//  - top frame: only the workbench's own document, `vscode-file://vscode-app/` (the fork's `web-contents-created` listener
//    already cancels every main-frame `will-navigate`; this adds the frame-level rule for the main frame too);
//  - sub-frames: only `vscode-webview://` documents, and frames nested inside one (a webview's content frames); the inert
//    `about:blank` and `about:srcdoc` documents are admitted for a sub-frame because they carry no content of their own;
//  - everything else is cancelled and logged by name;
//  - new windows are denied (the host holds ONE workbench window; there is no auxiliary window), an `https:` URL goes to the
//    system browser, any other URL is logged and dropped.
// The permission part of the column is in `app.ts` `configureSession` (the default session's permission sets).

import type { WebContents, WebFrameMain } from 'electron';
import { Event } from '../../../base/common/event.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { Schemas, VSCODE_AUTHORITY } from '../../../base/common/network.js';
import { ILogService } from '../../../platform/log/common/log.js';

export interface IQlWorkbenchSecurityDeps {
	readonly logService: ILogService;

	/** Opens `url` in the system browser (the fork's `nativeHostMainService.openExternal`). */
	openExternal(url: string): void;
}

type FrameNavigationEvent = Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>;

function isInsideWebview(frame: WebFrameMain | null): boolean {
	for (let ancestor = frame?.parent; ancestor; ancestor = ancestor.parent) {
		if (ancestor.url.startsWith(`${Schemas.vscodeWebview}://`)) {
			return true;
		}
	}

	return false;
}

function isAllowedFrameNavigation(url: string, isMainFrame: boolean, frame: WebFrameMain | null): boolean {
	if (isMainFrame) {
		return url.startsWith(`${Schemas.vscodeFileResource}://${VSCODE_AUTHORITY}/`);
	}

	return url.startsWith(`${Schemas.vscodeWebview}://`) || url === 'about:blank' || url === 'about:srcdoc' || isInsideWebview(frame);
}

export function secureWorkbenchContents(contents: WebContents, deps: IQlWorkbenchSecurityDeps): IDisposable {

	// The fork's `web-contents-created` listener ran when the contents were created and set its own handler (about:blank opens
	// an auxiliary window, everything else is handed to the OS). The workbench's is stricter: no new window at all.
	contents.setWindowOpenHandler(details => {
		if (/^https:\/\//i.test(details.url)) {
			deps.logService.trace(`QuantLab host: workbench window.open to ${details.url} goes to the system browser`);
			deps.openExternal(details.url);
		} else {
			deps.logService.error(`QuantLab host: blocked workbench window.open to ${details.url} (only https: opens, in the system browser)`);
		}

		return { action: 'deny' };
	});

	return Event.fromNodeEventEmitter(contents, 'will-frame-navigate', (event: FrameNavigationEvent) => event)(event => {
		if (isAllowedFrameNavigation(event.url, event.isMainFrame, event.frame)) {
			return;
		}

		deps.logService.error(`QuantLab host: blocked workbench ${event.isMainFrame ? 'main-frame' : 'sub-frame'} navigation to ${event.url}`);
		event.preventDefault();
	});
}

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab host (U5): the workbench column of the security matrix, for the contents the host adopted.
//
//  - navigations and redirects, main frame and sub-frames: only to a document the workbench owns (`securityPolicy.ts`,
//    review c1 M2: the exact workbench document, webviews the workbench created and their own frames); the fork's
//    `web-contents-created` listener also cancels every main-frame `will-navigate`;
//  - everything else is cancelled and logged by name;
//  - new windows are denied (the host holds ONE workbench window; there is no auxiliary window), an `https:` URL goes to the
//    system browser, any other URL is logged and dropped.
// The permission part of the column is `isGrantedPermission` (same file), called by `app.ts` `configureSession` (M3).

import type { WebContents } from 'electron';
import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { IQlFramePolicy, isAllowedNavigation } from './securityPolicy.js';

export interface IQlWorkbenchSecurityDeps {
	readonly logService: ILogService;

	/** The workbench document and the webview scheme the ownership decisions use. */
	readonly policy: IQlFramePolicy;

	/** Opens `url` in the system browser (the fork's `nativeHostMainService.openExternal`). */
	openExternal(url: string): void;
}

type FrameNavigationEvent = Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>;
type RedirectEvent = Electron.Event<Electron.WebContentsWillRedirectEventParams>;

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

	const guard = (kind: 'navigation' | 'redirect') => (event: FrameNavigationEvent | RedirectEvent) => {
		if (isAllowedNavigation(event.url, event.isMainFrame, event.frame, deps.policy)) {
			return;
		}

		deps.logService.error(`QuantLab host: blocked workbench ${event.isMainFrame ? 'main-frame' : 'sub-frame'} ${kind} to ${event.url}`);
		event.preventDefault();
	};
	const onNavigate = guard('navigation');
	const onRedirect = guard('redirect');
	contents.on('will-frame-navigate', onNavigate);
	contents.on('will-redirect', onRedirect);

	return toDisposable(() => {
		contents.removeListener('will-frame-navigate', onNavigate);
		contents.removeListener('will-redirect', onRedirect);
	});
}

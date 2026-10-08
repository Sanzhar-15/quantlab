/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../base/common/network.js';
import { URI } from '../../base/common/uri.js';

/**
 * A protocol link that asks for a remote authority: `<protocol>://vscode-remote/<authority>/<path>`.
 * Quantlab opens no remote window, so such a link is refused by name before any window opens or any dialog is shown.
 * Other links (file paths, workspaces, extension links) are not remote-authority links.
 */
export function isRemoteAuthorityProtocolUrl(uri: URI): boolean {
	return !!uri.path && uri.authority.toLowerCase() === Schemas.vscodeRemote;
}

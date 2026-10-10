/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BaseWindow, dialog, ipcMain, protocol, safeStorage, screen, session, Session, shell, systemPreferences, WebContents, WebContentsView, WebFrameMain } from 'electron';
import { addUNCHostToAllowlist, disableUNCAccessRestrictions } from '../../base/node/unc.js';
import { validatedIpcMain } from '../../base/parts/ipc/electron-main/ipcMain.js';
import { hostname, release } from 'os';
import { VSBuffer } from '../../base/common/buffer.js';
import { toErrorMessage } from '../../base/common/errorMessage.js';
import { Event } from '../../base/common/event.js';
import { getMarks, mark } from '../../base/common/performance.js';
import { parse } from '../../base/common/jsonc.js';
import { getPathLabel } from '../../base/common/labels.js';
import { Disposable, DisposableStore } from '../../base/common/lifecycle.js';
import { FileAccess, Schemas, VSCODE_AUTHORITY } from '../../base/common/network.js';
import { join, posix } from '../../base/common/path.js';
import { IProcessEnvironment, isLinux, isLinuxSnap, isMacintosh, isWindows, OS } from '../../base/common/platform.js';
import { assertType } from '../../base/common/types.js';
import { URI } from '../../base/common/uri.js';
import { generateUuid } from '../../base/common/uuid.js';
import { registerContextMenuListener } from '../../base/parts/contextmenu/electron-main/contextmenu.js';
import { getDelayedChannel, ProxyChannel, StaticRouter } from '../../base/parts/ipc/common/ipc.js';
import { Server as ElectronIPCServer } from '../../base/parts/ipc/electron-main/ipc.electron.js';
import { Client as MessagePortClient } from '../../base/parts/ipc/electron-main/ipc.mp.js';
import { Server as NodeIPCServer } from '../../base/parts/ipc/node/ipc.net.js';
import { IProxyAuthService, ProxyAuthService } from '../../platform/native/electron-main/auth.js';
import { localize } from '../../nls.js';
import { IBackupMainService } from '../../platform/backup/electron-main/backup.js';
import { BackupMainService } from '../../platform/backup/electron-main/backupMainService.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { ElectronExtensionHostDebugBroadcastChannel } from '../../platform/debug/electron-main/extensionHostDebugIpc.js';
import { IDiagnosticsService } from '../../platform/diagnostics/common/diagnostics.js';
import { DiagnosticsMainService, IDiagnosticsMainService } from '../../platform/diagnostics/electron-main/diagnosticsMainService.js';
import { IDialogMainService } from '../../platform/dialogs/electron-main/dialogMainService.js';
import { IEncryptionMainService } from '../../platform/encryption/common/encryptionService.js';
import { EncryptionMainService } from '../../platform/encryption/electron-main/encryptionMainService.js';
import { NativeBrowserElementsMainService, INativeBrowserElementsMainService } from '../../platform/browserElements/electron-main/nativeBrowserElementsMainService.js';
import { NativeParsedArgs } from '../../platform/environment/common/argv.js';
import { IEnvironmentMainService } from '../../platform/environment/electron-main/environmentMainService.js';
import { isLaunchedFromCli } from '../../platform/environment/node/argvHelper.js';
import { getResolvedShellEnv } from '../../platform/shell/node/shellEnv.js';
import { IExtensionHostStarter, ipcExtensionHostStarterChannelName } from '../../platform/extensions/common/extensionHostStarter.js';
import { ExtensionHostStarter } from '../../platform/extensions/electron-main/extensionHostStarter.js';
import { IExternalTerminalMainService } from '../../platform/externalTerminal/electron-main/externalTerminal.js';
import { LinuxExternalTerminalService, MacExternalTerminalService, WindowsExternalTerminalService } from '../../platform/externalTerminal/node/externalTerminalService.js';
import { LOCAL_FILE_SYSTEM_CHANNEL_NAME } from '../../platform/files/common/diskFileSystemProviderClient.js';
import { IFileService } from '../../platform/files/common/files.js';
import { DiskFileSystemProviderChannel } from '../../platform/files/electron-main/diskFileSystemProviderServer.js';
import { DiskFileSystemProvider } from '../../platform/files/node/diskFileSystemProvider.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { ProcessMainService } from '../../platform/process/electron-main/processMainService.js';
import { IKeyboardLayoutMainService, KeyboardLayoutMainService } from '../../platform/keyboardLayout/electron-main/keyboardLayoutMainService.js';
import { ILaunchMainService, LaunchMainService } from '../../platform/launch/electron-main/launchMainService.js';
import { ILifecycleMainService, LifecycleMainPhase, ShutdownReason } from '../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { ILoggerService, ILogService } from '../../platform/log/common/log.js';
import { IMenubarMainService, MenubarMainService } from '../../platform/menubar/electron-main/menubarMainService.js';
import { INativeHostMainService, NativeHostMainService } from '../../platform/native/electron-main/nativeHostMainService.js';
import { IProductService } from '../../platform/product/common/productService.js';
import { getRemoteAuthority } from '../../platform/remote/common/remoteHosts.js';
import { SharedProcess } from '../../platform/sharedProcess/electron-main/sharedProcess.js';
import { ISignService } from '../../platform/sign/common/sign.js';
import { IStateService } from '../../platform/state/node/state.js';
import { StorageDatabaseChannel } from '../../platform/storage/electron-main/storageIpc.js';
import { ApplicationStorageMainService, IApplicationStorageMainService, IStorageMainService, StorageMainService } from '../../platform/storage/electron-main/storageMainService.js';
import { resolveCommonProperties } from '../../platform/telemetry/common/commonProperties.js';
import { ITelemetryService, TelemetryLevel } from '../../platform/telemetry/common/telemetry.js';
import { TelemetryAppenderClient } from '../../platform/telemetry/common/telemetryIpc.js';
import { ITelemetryServiceConfig, TelemetryService } from '../../platform/telemetry/common/telemetryService.js';
import { getPiiPathsFromEnvironment, getTelemetryLevel, isInternalTelemetry, NullTelemetryService, supportsTelemetry } from '../../platform/telemetry/common/telemetryUtils.js';
import { IUpdateService } from '../../platform/update/common/update.js';
import { UpdateChannel } from '../../platform/update/common/updateIpc.js';
import { DarwinUpdateService } from '../../platform/update/electron-main/updateService.darwin.js';
import { LinuxUpdateService } from '../../platform/update/electron-main/updateService.linux.js';
import { SnapUpdateService } from '../../platform/update/electron-main/updateService.snap.js';
import { Win32UpdateService } from '../../platform/update/electron-main/updateService.win32.js';
import { IOpenURLOptions, IURLService } from '../../platform/url/common/url.js';
import { URLHandlerChannelClient, URLHandlerRouter } from '../../platform/url/common/urlIpc.js';
import { NativeURLService } from '../../platform/url/common/urlService.js';
import { ElectronURLListener } from '../../platform/url/electron-main/electronUrlListener.js';
import { UtilityProcess } from '../../platform/utilityProcess/electron-main/utilityProcess.js';
import { IWebviewManagerService } from '../../platform/webview/common/webviewManagerService.js';
import { WebviewMainService } from '../../platform/webview/electron-main/webviewMainService.js';
import { isFolderToOpen, isWorkspaceToOpen, IWindowOpenable } from '../../platform/window/common/window.js';
import { getAllWindowsExcludingOffscreen, IWindowsMainService, OpenContext } from '../../platform/windows/electron-main/windows.js';
import { ICodeWindow } from '../../platform/window/electron-main/window.js';
import { ActiveWindowManager } from '../../platform/windows/node/windowTracker.js';
import { hasWorkspaceFileExtension } from '../../platform/workspace/common/workspace.js';
import { IWorkspacesService } from '../../platform/workspaces/common/workspaces.js';
import { IWorkspacesHistoryMainService, WorkspacesHistoryMainService } from '../../platform/workspaces/electron-main/workspacesHistoryMainService.js';
import { WorkspacesMainService } from '../../platform/workspaces/electron-main/workspacesMainService.js';
import { IWorkspacesManagementMainService, WorkspacesManagementMainService } from '../../platform/workspaces/electron-main/workspacesManagementMainService.js';
import { IPolicyService } from '../../platform/policy/common/policy.js';
import { PolicyChannel } from '../../platform/policy/common/policyIpc.js';
import { IRequestService } from '../../platform/request/common/request.js';
import { RequestChannel } from '../../platform/request/common/requestIpc.js';
import { IUserDataProfilesMainService } from '../../platform/userDataProfile/electron-main/userDataProfile.js';
import { IExtensionsProfileScannerService } from '../../platform/extensionManagement/common/extensionsProfileScannerService.js';
import { IExtensionsScannerService } from '../../platform/extensionManagement/common/extensionsScannerService.js';
import { ExtensionsScannerService } from '../../platform/extensionManagement/node/extensionsScannerService.js';
import { UserDataProfilesHandler } from '../../platform/userDataProfile/electron-main/userDataProfilesHandler.js';
import { ProfileStorageChangesListenerChannel } from '../../platform/userDataProfile/electron-main/userDataProfileStorageIpc.js';
import { Promises, RunOnceScheduler, runWhenGlobalIdle } from '../../base/common/async.js';
import { resolveMachineId, resolveSqmId, resolveDevDeviceId, validateDevDeviceId } from '../../platform/telemetry/electron-main/telemetryUtils.js';
import { ExtensionsProfileScannerService } from '../../platform/extensionManagement/node/extensionsProfileScannerService.js';
import { LoggerChannel } from '../../platform/log/electron-main/logIpc.js';
import { ILoggerMainService } from '../../platform/log/electron-main/loggerService.js';
import { IInitialProtocolUrls, IProtocolUrl } from '../../platform/url/electron-main/url.js';
import { IUtilityProcessWorkerMainService, UtilityProcessWorkerMainService } from '../../platform/utilityProcess/electron-main/utilityProcessWorkerMainService.js';
import { ipcUtilityProcessWorkerChannelName } from '../../platform/utilityProcess/common/utilityProcessWorkerService.js';
import { ILocalPtyService, LocalReconnectConstants, TerminalIpcChannels, TerminalSettingId } from '../../platform/terminal/common/terminal.js';
import { ElectronPtyHostStarter } from '../../platform/terminal/electron-main/electronPtyHostStarter.js';
import { PtyHostService } from '../../platform/terminal/node/ptyHostService.js';
import { NODE_REMOTE_RESOURCE_CHANNEL_NAME, NODE_REMOTE_RESOURCE_IPC_METHOD_NAME, NodeRemoteResourceResponse, NodeRemoteResourceRouter } from '../../platform/remote/common/electronRemoteResources.js';
import { Lazy } from '../../base/common/lazy.js';
import { IAuxiliaryWindowsMainService } from '../../platform/auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { AuxiliaryWindowsMainService } from '../../platform/auxiliaryWindow/electron-main/auxiliaryWindowsMainService.js';
import { normalizeNFC } from '../../base/common/normalization.js';
import { ICSSDevelopmentService, CSSDevelopmentService } from '../../platform/cssDev/node/cssDevService.js';
import { INativeMcpDiscoveryHelperService, NativeMcpDiscoveryHelperChannelName } from '../../platform/mcp/common/nativeMcpDiscoveryHelper.js';
import { NativeMcpDiscoveryHelperService } from '../../platform/mcp/node/nativeMcpDiscoveryHelperService.js';
import { IWebContentExtractorService } from '../../platform/webContentExtractor/common/webContentExtractor.js';
import { NativeWebContentExtractorService } from '../../platform/webContentExtractor/electron-main/webContentExtractorService.js';
import ErrorTelemetry from '../../platform/telemetry/electron-main/errorTelemetry.js';
// QuantLab host (U3): the terminal host (generated client, see ql-client/MANIFEST.json)
// electron-updater is CommonJS with getter-defined exports: node's ESM loader finds no named export (`autoUpdater`), and
// out/main.js is ESM, so a named import throws SyntaxError before `ready` (package 5, folds/HOST/U5-LAUNCH-1.md). Default import.
import electronUpdater from 'electron-updater';
import { bakedBuildValues, createUpdater, isQuitDuringStart, markStartCancelled, onBeforeShowAwaited, startTerminalHost, type Ports, type TerminalHost, type ViewRecord } from './ql-client/index.js';
// QuantLab host (U5): the lazy gate and the adopted workbench view (qlHost/)
import { QlDialogMainService } from './qlHost/dialogs.js';
import { QlWindowsGate, requireQlWindowsGate } from './qlHost/gate.js';
import { QlWorkbenchHost } from './qlHost/workbenchHost.js';
import { IQlFramePolicy, isGrantedPermission, qlPermissionFrameLines } from './qlHost/securityPolicy.js';
import { QlWebviewRegistry } from './qlHost/webviewRegistry.js';
// QuantLab host (U6): the chrome seed (the four chrome settings of a fresh default profile)
import { seedQlChromeSettings } from './qlHost/chromeSeed.js';

/**
 * The main VS Code application. There will only ever be one instance,
 * even if the user starts many instances (e.g. from the command line).
 */
/** QuantLab host (F-PERF-LZ1-1): what the early-started terminal host waits for from initServices. */
interface QlStartServices {
	readonly qlWorkbenchHost: QlWorkbenchHost;
	readonly encryptionMainService: EncryptionMainService;
}

/** QuantLab host (F-PERF-LZ1-1, review c1 M1/M2): how the services section of `startup()` ended, as a value. */
type QlServicesOutcome<S> = { readonly ready: true; readonly services: S } | { readonly ready: false; readonly cancelled: boolean; readonly error: unknown };

/** QuantLab host (F-PERF-LZ1-1, review c1 M2): the part of Electron's `app` the early quit guard uses. */
export interface IQlEarlyQuitApp {
	on(event: string, listener: (...args: never[]) => void): unknown;
	removeListener(event: string, listener: (...args: never[]) => void): unknown;
	quit(): void;
}

/** QuantLab host (F-PERF-LZ1-1, review c1 M2): the early start was cancelled (a quit before the services were ready, or the host's start ended). */
export class QlStartCancelled extends Error { }

/**
 * QuantLab host (F-PERF-LZ1-1, review c1 M1): the services the early-started terminal host waits for, held as an OUTCOME (a value,
 * as the client holds its minimum-version request): the promise held here never rejects, so a failure of the services section is
 * never an unhandled rejection, whether or not the host's `onBeforeShow` ever asks for them (a host that failed before its hook
 * never does). `services()` makes one promise per caller that settles as the services did (their failure rethrown): only a caller
 * that awaits it holds a rejection. `startup()` reads `outcome()` and reports a failure ONCE, after the host's start ended.
 *
 * Review c1 M2: the host starts before phase `Ready`, and `LifecycleMainService` installs its `before-quit`, `window-all-closed`
 * and guarded `will-quit` listeners only at `Ready`: until then nothing would hold a quit (a TERM, Cmd+Q) while the start and the
 * services are under way, and Electron's own `window-all-closed` default would quit when the start closed its last window. So
 * this holder, made BEFORE the host starts, installs its own three listeners until `lifecycleGuarding()` (right after `Ready`):
 * a quit before then CANCELS the early start (the hook's `services()` rejects with `QlStartCancelled` at once, so nothing attaches
 * or shows; the services section stops at its next `checkpoint`, so nothing initialises late) and its `will-quit` is prevented
 * until `startup()` has seen the host's start end and calls `releaseHeldQuit()`, which quits once more and lets that one through.
 * `window-all-closed` before `Ready` quits nothing (logged). A host start that ends (failed or quit) cancels too.
 */
export class QlEarlyStart<S> {
	private readonly settled: Promise<QlServicesOutcome<S>>;
	private settle: ((outcome: QlServicesOutcome<S>) => void) | undefined;
	private failure: { readonly error: unknown } | undefined;
	private cancellation: QlStartCancelled | undefined;
	private held = false;
	private guarding = true;
	private mayQuit = false;
	private readonly onBeforeQuit = () => this.quitBeforeReady('before-quit');
	private readonly onWillQuit = (event: { preventDefault(): void }) => {
		if (this.mayQuit) {
			this.removeGuard();
			return;
		}
		event.preventDefault();
		this.quitBeforeReady('will-quit');
	};
	private readonly onWindowAllClosed = () => this.log('QuantLab host: every window closed before the services were ready: no quit (the lifecycle quit policy is not installed yet)');

	constructor(private readonly app: IQlEarlyQuitApp, private readonly log: (message: string) => void) {
		let settle: ((outcome: QlServicesOutcome<S>) => void) | undefined;
		this.settled = new Promise<QlServicesOutcome<S>>(resolve => { settle = resolve; });
		this.settle = settle;
		app.on('before-quit', this.onBeforeQuit);
		app.on('will-quit', this.onWillQuit);
		app.on('window-all-closed', this.onWindowAllClosed);
	}

	/** The services exist (once, or `fail` once; never after a cancellation: `checkpoint` stops the section first). */
	complete(services: S): void {
		this.take('complete')({ ready: true, services });
	}

	/**
	 * The services section failed (once, or `complete` once); the failure is kept for `startup()`'s one report. The section's own
	 * stop at a `checkpoint` (this holder's cancellation) is not a failure; a failure after a cancellation is kept and reported.
	 */
	fail(error: unknown): void {
		if (error === this.cancellation) {
			return;
		}
		this.failure = { error };
		if (this.cancellation) {
			return;
		}
		this.take('fail')({ ready: false, cancelled: false, error });
	}

	/** Review c1 M2: cancels the early start (idempotent); after the services exist it changes nothing. */
	cancel(reason: string): void {
		if (this.cancellation || !this.settle) {
			return;
		}
		// R-296: marked for the client, which reads a start rejected with it as a quit during the start (exit 0), not a fatal
		this.cancellation = new QlStartCancelled(`QuantLab host (F-PERF-LZ1-1): the early start was cancelled: ${reason}`);
		markStartCancelled(this.cancellation);
		this.log(this.cancellation.message);
		this.take('cancel')({ ready: false, cancelled: true, error: this.cancellation });
	}

	/** Review c1 M2: between the services section's awaits: throws the cancellation, so nothing initialises after it. */
	checkpoint(): void {
		if (this.cancellation) {
			throw this.cancellation;
		}
	}

	/** Review c1 M2: whether a quit arrived before `Ready` (held until `releaseHeldQuit`). */
	get quitHeld(): boolean {
		return this.held;
	}

	/** Review c1 M2: right after phase `Ready` (no quit held: the checkpoint before it passed): the lifecycle's listeners take over. */
	lifecycleGuarding(): void {
		if (this.held) {
			throw new Error('QuantLab host (F-PERF-LZ1-1): lifecycleGuarding() while a quit is held');
		}
		this.removeGuard();
	}

	/** Review c1 M2: the cancelled start has ended (unwound): a held quit goes through now, once (idempotent); otherwise the guard goes. */
	releaseHeldQuit(): void {
		if (!this.held) {
			this.removeGuard();
			return;
		}
		if (this.mayQuit) {
			return;
		}
		this.log('QuantLab host: the start ended after a quit before the services were ready: the held quit goes through');
		this.mayQuit = true;
		this.app.quit();
	}

	/** For the host's hook and `openQuantlab`: the services, or their failure (or the cancellation) rethrown. */
	services(): Promise<S> {
		return this.settled.then(outcome => {
			if (!outcome.ready) {
				throw outcome.error;
			}

			return outcome.services;
		});
	}

	/** For `startup()`: how the services section ended; never rejects. */
	outcome(): Promise<QlServicesOutcome<S>> {
		return this.settled;
	}

	/** The services section's failure once `fail` ran (the host's start then ends on it; `startup()` reports it). */
	get servicesFailure(): { readonly error: unknown } | undefined {
		return this.failure;
	}

	private quitBeforeReady(how: string): void {
		if (!this.guarding || this.held) {
			return;
		}
		this.held = true;
		this.log(`QuantLab host: a quit (${how}) before the services were ready: held until the early start has ended`);
		this.cancel(`a quit (${how}) before the services were ready`);
	}

	private removeGuard(): void {
		if (!this.guarding) {
			return;
		}
		this.guarding = false;
		this.app.removeListener('before-quit', this.onBeforeQuit);
		this.app.removeListener('will-quit', this.onWillQuit);
		this.app.removeListener('window-all-closed', this.onWindowAllClosed);
	}

	private take(what: string): (outcome: QlServicesOutcome<S>) => void {
		const settle = this.settle;
		if (!settle) {
			throw new Error(`QuantLab host (F-PERF-LZ1-1): the start's services were already settled (${what} called again)`);
		}
		this.settle = undefined;

		return settle;
	}
}

export class CodeApplication extends Disposable {

	private static readonly SECURITY_PROTOCOL_HANDLING_CONFIRMATION_SETTING_KEY = {
		[Schemas.file]: 'security.promptForLocalFileProtocolHandling' as const,
		[Schemas.vscodeRemote]: 'security.promptForRemoteFileProtocolHandling' as const
	};

	private windowsMainService: IWindowsMainService | undefined;
	private auxiliaryWindowsMainService: IAuxiliaryWindowsMainService | undefined;
	private nativeHostMainService: INativeHostMainService | undefined;

	// QuantLab host (U3): the terminal host that replaces the first window (started in `startup`, used by U5/U6)
	protected qlTerminalHost: TerminalHost | undefined; // `protected`: not read until U5/U6, `noUnusedLocals` flags a private one

	// QuantLab host (U5): the host's side of the workbench view (the gate and the adoption are in qlHost/)
	private qlWorkbenchHost: QlWorkbenchHost | undefined;

	// QuantLab host (review c2 M2 + M3): the webviews the workbench registered; written by the webview manager service,
	// read by the frame policy (navigations, redirects, both permission handlers)
	private readonly qlWebviewRegistry = new QlWebviewRegistry();

	constructor(
		private readonly mainProcessNodeIpcServer: NodeIPCServer,
		private readonly userEnv: IProcessEnvironment,
		@IInstantiationService private readonly mainInstantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@ILoggerService private readonly loggerService: ILoggerService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
		@ILifecycleMainService private readonly lifecycleMainService: ILifecycleMainService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStateService private readonly stateService: IStateService,
		@IFileService private readonly fileService: IFileService,
		@IProductService private readonly productService: IProductService,
		@IUserDataProfilesMainService private readonly userDataProfilesMainService: IUserDataProfilesMainService
	) {
		super();

		this.configureSession();
		this.registerListeners();
	}

	/** QuantLab host (review c1 M2 + M3, c2 M2 + M3): the document the CodeWindow loads (`windowImpl.ts` `load`), the webview scheme and the registered webviews. */
	private qlFramePolicy(): IQlFramePolicy {
		return {
			workbenchDocument: FileAccess.asBrowserUri(`vs/code/electron-browser/workbench/workbench${this.environmentMainService.isBuilt ? '' : '-dev'}.html`).toString(true),
			webviewScheme: Schemas.vscodeWebview,
			webviews: contents => this.qlWebviewRegistry.of(contents)
		};
	}

	private configureSession(): void {

		//#region Security related measures (https://electronjs.org/docs/tutorial/security)
		//
		// !!! DO NOT CHANGE without consulting the documentation !!!
		//

		// QuantLab host (review c1 M3): one decision for the request and the check handler, by frame ownership (the exact
		// workbench document, webviews it registered and their own frames): `clipboard-sanitized-write` and `fullscreen`, nothing
		// else (the fork's prefix match granted `pointerLock`, clipboard reads and `local-fonts`; media and notifications were
		// removed in U5). See qlHost/securityPolicy.ts.
		const framePolicy = this.qlFramePolicy();

		session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
			const granted = isGrantedPermission(webContents, permission, details.requestingUrl, details.isMainFrame, framePolicy);
			if (!granted) {
				this.logService.warn(`QuantLab host: denied permission request ${permission} from ${details.requestingUrl} (${details.isMainFrame ? 'main frame' : 'sub-frame'})`);
			}
			if (globalThis.QL_TEST_BUILD && !details.isMainFrame) {
				// TEST BUILDS ONLY (review c3 M2/M3): the frames the decision read, as Electron reports them
				this.logService.info(`QuantLab host: test build: permission request ${permission} granted=${granted} frames ${qlPermissionFrameLines(webContents, details.requestingUrl, framePolicy)}`);
			}
			return callback(granted);
		});

		session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
			const granted = isGrantedPermission(webContents, permission, details.requestingUrl, details.isMainFrame, framePolicy);
			if (globalThis.QL_TEST_BUILD && !details.isMainFrame) {
				// TEST BUILDS ONLY (review c3 M2/M3): as the request handler's line
				this.logService.info(`QuantLab host: test build: permission check ${permission} granted=${granted} frames ${qlPermissionFrameLines(webContents, details.requestingUrl, framePolicy)}`);
			}
			return granted;
		});

		//#endregion

		//#region Request filtering

		// Block all SVG requests from unsupported origins
		const supportedSvgSchemes = new Set([Schemas.file, Schemas.vscodeFileResource, Schemas.vscodeRemoteResource, Schemas.vscodeManagedRemoteResource, 'devtools']);

		// But allow them if they are made from inside an webview
		const isSafeFrame = (requestFrame: WebFrameMain | null | undefined): boolean => {
			for (let frame: WebFrameMain | null | undefined = requestFrame; frame; frame = frame.parent) {
				if (frame.url.startsWith(`${Schemas.vscodeWebview}://`)) {
					return true;
				}
			}
			return false;
		};

		const isSvgRequestFromSafeContext = (details: Electron.OnBeforeRequestListenerDetails | Electron.OnHeadersReceivedListenerDetails): boolean => {
			return details.resourceType === 'xhr' || isSafeFrame(details.frame);
		};

		const isAllowedVsCodeFileRequest = (details: Electron.OnBeforeRequestListenerDetails) => {
			const frame = details.frame;
			if (!frame || !this.windowsMainService) {
				return false;
			}

			// Check to see if the request comes from one of the main windows (or shared process) and not from embedded content
			const windows = getAllWindowsExcludingOffscreen();
			for (const window of windows) {
				if (frame.processId === window.webContents.mainFrame.processId) {
					return true;
				}
			}

			return false;
		};

		const isAllowedWebviewRequest = (uri: URI, details: Electron.OnBeforeRequestListenerDetails): boolean => {
			if (uri.path !== '/index.html') {
				return true; // Only restrict top level page of webviews: index.html
			}

			const frame = details.frame;
			if (!frame || !this.windowsMainService) {
				return false;
			}

			// Check to see if the request comes from one of the main editor windows.
			for (const window of this.windowsMainService.getWindows()) {
				if (window.win) {
					if (frame.processId === window.win.webContents.mainFrame.processId) {
						return true;
					}
				}
			}

			return false;
		};

		session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
			const uri = URI.parse(details.url);
			if (uri.scheme === Schemas.vscodeWebview) {
				if (!isAllowedWebviewRequest(uri, details)) {
					this.logService.error('Blocked vscode-webview request', details.url);
					return callback({ cancel: true });
				}
			}

			if (uri.scheme === Schemas.vscodeFileResource) {
				if (!isAllowedVsCodeFileRequest(details)) {
					this.logService.error('Blocked vscode-file request', details.url);
					return callback({ cancel: true });
				}
			}

			// Block most svgs
			if (uri.path.endsWith('.svg')) {
				const isSafeResourceUrl = supportedSvgSchemes.has(uri.scheme);
				if (!isSafeResourceUrl) {
					return callback({ cancel: !isSvgRequestFromSafeContext(details) });
				}
			}

			return callback({ cancel: false });
		});

		// Configure SVG header content type properly
		// https://github.com/microsoft/vscode/issues/97564
		session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
			const responseHeaders = details.responseHeaders as Record<string, (string) | (string[])>;
			const contentTypes = (responseHeaders['content-type'] || responseHeaders['Content-Type']);

			if (contentTypes && Array.isArray(contentTypes)) {
				const uri = URI.parse(details.url);
				if (uri.path.endsWith('.svg')) {
					if (supportedSvgSchemes.has(uri.scheme)) {
						responseHeaders['Content-Type'] = ['image/svg+xml'];

						return callback({ cancel: false, responseHeaders });
					}
				}

				// remote extension schemes have the following format
				// http://127.0.0.1:<port>/vscode-remote-resource?path=
				if (!uri.path.endsWith(Schemas.vscodeRemoteResource) && contentTypes.some(contentType => contentType.toLowerCase().includes('image/svg'))) {
					return callback({ cancel: !isSvgRequestFromSafeContext(details) });
				}
			}

			return callback({ cancel: false });
		});

		//#endregion

		//#region Allow CORS for the PRSS CDN

		// https://github.com/microsoft/vscode-remote-release/issues/9246
		session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
			if (details.url.startsWith('https://vscode.download.prss.microsoft.com/')) {
				const responseHeaders = details.responseHeaders ?? Object.create(null);

				if (responseHeaders['Access-Control-Allow-Origin'] === undefined) {
					responseHeaders['Access-Control-Allow-Origin'] = ['*'];
					return callback({ cancel: false, responseHeaders });
				}
			}

			return callback({ cancel: false });
		});

		//#endregion

		//#region Code Cache

		type SessionWithCodeCachePathSupport = Session & {
			/**
			 * Sets code cache directory. By default, the directory will be `Code Cache` under
			 * the respective user data folder.
			 */
			setCodeCachePath?(path: string): void;
		};

		const defaultSession = session.defaultSession as unknown as SessionWithCodeCachePathSupport;
		if (typeof defaultSession.setCodeCachePath === 'function' && this.environmentMainService.codeCachePath) {
			// Make sure to partition Chrome's code cache folder
			// in the same way as our code cache path to help
			// invalidate caches that we know are invalid
			// (https://github.com/microsoft/vscode/issues/120655)
			defaultSession.setCodeCachePath(join(this.environmentMainService.codeCachePath, 'chrome'));
		}

		//#endregion

		//#region UNC Host Allowlist (Windows)

		if (isWindows) {
			if (this.configurationService.getValue('security.restrictUNCAccess') === false) {
				disableUNCAccessRestrictions();
			} else {
				addUNCHostToAllowlist(this.configurationService.getValue('security.allowedUNCHosts'));
			}
		}

		//#endregion
	}

	private registerListeners(): void {

		// Dispose on shutdown
		Event.once(this.lifecycleMainService.onWillShutdown)(() => this.dispose());

		// Contextmenu via IPC support
		registerContextMenuListener();

		// Accessibility change event
		app.on('accessibility-support-changed', (event, accessibilitySupportEnabled) => {
			this.windowsMainService?.sendToAll('vscode:accessibilitySupportChanged', accessibilitySupportEnabled);
		});

		// macOS dock activate
		app.on('activate', async (event, hasVisibleWindows) => {
			this.logService.trace('app#activate');

			// Mac only event: open new window when we get activated
			// QuantLab host (U5): the host window is the app's window; the dock brings it back. Opening an empty workbench
			// window here would be a first use nobody asked for (the workbench opens on the toggle key, openQuantlab, or a
			// request through the gate).
			if (!hasVisibleWindows) {
				if (this.qlWorkbenchHost) {
					this.qlWorkbenchHost.restoreHostWindow();
				} else {
					this.logService.info('QuantLab host: app#activate before the host window exists; nothing to bring back');
				}
			}
		});

		//#region Security related measures (https://electronjs.org/docs/tutorial/security)
		//
		// !!! DO NOT CHANGE without consulting the documentation !!!
		//
		app.on('web-contents-created', (event, contents) => {

			// Auxiliary Window: delegate to `AuxiliaryWindow` class
			if (contents?.opener?.url.startsWith(`${Schemas.vscodeFileResource}://${VSCODE_AUTHORITY}/`)) {
				this.logService.trace('[aux window]  app.on("web-contents-created"): Registering auxiliary window');

				this.auxiliaryWindowsMainService?.registerWindow(contents);
			}

			// Block any in-page navigation
			contents.on('will-navigate', event => {

				// QuantLab host (U3): the terminal view's navigation policy is the client's own
				// guards (installed by `createTerminalView`), decided at event time
				if (this.isQlTerminalContents(contents)) {
					return;
				}

				this.logService.error('webContents#will-navigate: Prevented webcontent navigation');

				event.preventDefault();
			});

			// All Windows: only allow about:blank auxiliary windows to open
			// For all other URLs, delegate to the OS.
			// QuantLab host (U3): this runs when the contents are created; `createTerminalView`
			// replaces the handler right after constructing its view, so the terminal view's
			// window.open policy is the client's, not this one.
			contents.setWindowOpenHandler(details => {

				// about:blank windows can open as window witho our default options
				if (details.url === 'about:blank') {
					this.logService.trace('[aux window] webContents#setWindowOpenHandler: Allowing auxiliary window to open on about:blank');

					return {
						action: 'allow',
						overrideBrowserWindowOptions: this.auxiliaryWindowsMainService?.createWindow(details)
					};
				}

				// Any other URL: delegate to OS
				else {
					this.logService.trace(`webContents#setWindowOpenHandler: Prevented opening window with URL ${details.url}}`);

					this.nativeHostMainService?.openExternal(undefined, details.url);

					return { action: 'deny' };
				}
			});
		});

		//#endregion

		let macOpenFileURIs: IWindowOpenable[] = [];
		let runningTimeout: Timeout | undefined = undefined;
		app.on('open-file', (event, path) => {
			path = normalizeNFC(path); // macOS only: normalize paths to NFC form

			this.logService.trace('app#open-file: ', path);
			event.preventDefault();

			// Keep in array because more might come!
			macOpenFileURIs.push(hasWorkspaceFileExtension(path) ? { workspaceUri: URI.file(path) } : { fileUri: URI.file(path) });

			// Clear previous handler if any
			if (runningTimeout !== undefined) {
				clearTimeout(runningTimeout);
				runningTimeout = undefined;
			}

			// Handle paths delayed in case more are coming!
			runningTimeout = setTimeout(async () => {
				await this.windowsMainService?.open({
					context: OpenContext.DOCK /* can also be opening from finder while app is running */,
					cli: this.environmentMainService.args,
					urisToOpen: macOpenFileURIs,
					gotoLineMode: false,
					preferNewWindow: true /* dropping on the dock or opening from finder prefers to open in a new window */
				});

				macOpenFileURIs = [];
				runningTimeout = undefined;
			}, 100);
		});

		app.on('new-window-for-tab', async () => {
			await this.windowsMainService?.openEmptyWindow({ context: OpenContext.DESKTOP }); //macOS native tab "+" button
		});

		//#region Bootstrap IPC Handlers

		validatedIpcMain.handle('vscode:fetchShellEnv', event => {

			// Prefer to use the args and env from the target window
			// when resolving the shell env. It is possible that
			// a first window was opened from the UI but a second
			// from the CLI and that has implications for whether to
			// resolve the shell environment or not.
			//
			// Window can be undefined for e.g. the shared process
			// that is not part of our windows registry!
			const window = this.windowsMainService?.getWindowByWebContents(event.sender); // Note: this can be `undefined` for the shared process
			let args: NativeParsedArgs;
			let env: IProcessEnvironment;
			if (window?.config) {
				args = window.config;
				env = { ...process.env, ...window.config.userEnv };
			} else {
				args = this.environmentMainService.args;
				env = process.env;
			}

			// Resolve shell env
			return this.resolveShellEnvironment(args, env, false);
		});

		validatedIpcMain.on('vscode:toggleDevTools', event => event.sender.toggleDevTools());
		validatedIpcMain.on('vscode:openDevTools', event => event.sender.openDevTools());

		validatedIpcMain.on('vscode:reloadWindow', event => event.sender.reload());

		validatedIpcMain.handle('vscode:notifyZoomLevel', async (event, zoomLevel: number | undefined) => {
			const window = this.windowsMainService?.getWindowByWebContents(event.sender);
			if (window) {
				window.notifyZoomLevel(zoomLevel);
			}
		});

		//#endregion
	}

	async startup(): Promise<void> {
		// QuantLab host (F-PERF-LZ1-1): marks placing the main process's time to the terminal host's start (logged at startTerminalHost)
		mark('code/ql/willStartup');
		this.logService.debug('Starting VS Code');
		this.logService.debug(`from: ${this.environmentMainService.appRoot}`);
		this.logService.debug('args:', this.environmentMainService.args);

		// Make sure we associate the program with the app user model id
		// This will help Windows to associate the running program with
		// any shortcut that is pinned to the taskbar and prevent showing
		// two icons in the taskbar for the same app.
		const win32AppUserModelId = this.productService.win32AppUserModelId;
		if (isWindows && win32AppUserModelId) {
			app.setAppUserModelId(win32AppUserModelId);
		}

		// Fix native tabs on macOS 10.13
		// macOS enables a compatibility patch for any bundle ID beginning with
		// "com.microsoft.", which breaks native tabs for VS Code when using this
		// identifier (from the official build).
		// Explicitly opt out of the patch here before creating any windows.
		// See: https://github.com/microsoft/vscode/issues/35361#issuecomment-399794085
		try {
			if (isMacintosh && this.configurationService.getValue('window.nativeTabs') === true && !systemPreferences.getUserDefault('NSUseImprovedLayoutPass', 'boolean')) {
				systemPreferences.setUserDefault('NSUseImprovedLayoutPass', 'boolean', true);
			}
		} catch (error) {
			this.logService.error(error);
		}

		// Main process server (electron IPC based)
		const mainProcessElectronServer = new ElectronIPCServer();
		Event.once(this.lifecycleMainService.onWillShutdown)(e => {
			if (e.reason === ShutdownReason.KILL) {
				// When we go down abnormally, make sure to free up
				// any IPC we accept from other windows to reduce
				// the chance of doing work after we go down. Kill
				// is special in that it does not orderly shutdown
				// windows.
				mainProcessElectronServer.dispose();
			}
		});

		// QuantLab host (F-PERF-LZ1-1): the terminal host starts NOW, before the machine-ids await and initServices (it needs neither;
		// MARKS-1: the ids alone took 28-239 ms). Its `onBeforeShow` waits for the services below (`qlStart`), so the window stays
		// hidden until they exist; a failure below ends the start at `before-show`, by name. The early start's outcome is held as a
		// value: it can neither go unhandled while the services are awaited nor be lost.
		// Review c1 M1: so are the services' (QlEarlyStart): a failure below is never an unhandled rejection, whenever (or whether)
		// the hook asks for them, and it is thrown to main.ts ONCE, only after the host's start ended (it unwinds on that failure).
		// Review c1 M2: the holder is made BEFORE the host starts and holds a quit until phase `Ready` (the lifecycle's own quit
		// listeners exist only from then): a quit before it cancels the early start and is let through once the start has ended
		const qlStart = new QlEarlyStart<QlStartServices>(app, message => this.logService.info(message));
		const qlHost = this.startQlTerminalHost(qlStart).then(terminalHost => ({ failed: false as const, terminalHost }), (error: unknown) => ({ failed: true as const, error }));
		// Review c1 M2: a host start that ended (failed, or a quit during it) cancels the early start: the services section stops at
		// its next checkpoint. A quit held before `Ready` goes through once the start has unwound: it waits for nothing else (a
		// services section that never resumes cannot hold the quit; one that resumes meets the checkpoint). `qlHost` is an outcome
		// held as a value: this cannot reject.
		void qlHost.then(started => {
			if (started.failed || started.terminalHost === false) {
				qlStart.cancel('the terminal host start ended');
				if (qlStart.quitHeld) {
					qlStart.releaseHeldQuit();
				}
			}
		});
		let initialProtocolUrls: IInitialProtocolUrls | undefined;
		try {
			// Resolve unique machine ID
			const [machineId, sqmId, devDeviceId] = await Promise.all([
				resolveMachineId(this.stateService, this.logService),
				resolveSqmId(this.stateService, this.logService),
				resolveDevDeviceId(this.stateService, this.logService)
			]);
			mark('code/ql/didResolveMachineIds');
			if (globalThis.QL_TEST_BUILD) {
				const { qlServicesHold } = await import('./qlHost/servicesHold.js');
				await qlServicesHold(process.env, message => this.logService.info(message));
			}
			qlStart.checkpoint();

			// Shared process
			const { sharedProcessReady, sharedProcessClient } = this.setupSharedProcess(machineId, sqmId, devDeviceId);

			// Services
			const appInstantiationService = await this.initServices(machineId, sqmId, devDeviceId, sharedProcessReady);
			mark('code/ql/didInitServices');
			qlStart.checkpoint();

			// Error telemetry
			appInstantiationService.invokeFunction(accessor => this._register(new ErrorTelemetry(accessor.get(ILogService), accessor.get(ITelemetryService))));

			// Auth Handler
			appInstantiationService.invokeFunction(accessor => accessor.get(IProxyAuthService));

			// Transient profiles handler
			this._register(appInstantiationService.createInstance(UserDataProfilesHandler));

			// Init Channels
			appInstantiationService.invokeFunction(accessor => this.initChannels(accessor, mainProcessElectronServer, sharedProcessClient));

			// Setup Protocol URL Handlers
			initialProtocolUrls = await appInstantiationService.invokeFunction(accessor => this.setupProtocolUrlHandlers(accessor, mainProcessElectronServer));
			mark('code/ql/didSetupProtocolUrlHandlers');
			qlStart.checkpoint();

			// Setup vscode-remote-resource protocol handler
			this.setupManagedRemoteResourceUrlHandler(mainProcessElectronServer);

			// Signal phase: ready - before opening first window
			this.lifecycleMainService.phase = LifecycleMainPhase.Ready;
			// Review c1 M2: the lifecycle's quit listeners are installed now (on `Ready`, before any next event): the early guard goes
			qlStart.lifecycleGuarding();

			// QuantLab host (F-PERF-LZ1-1): what the started host's `onBeforeShow` waits for, taken from the accessor synchronously
			const protocolUrls = initialProtocolUrls;
			qlStart.complete(appInstantiationService.invokeFunction(accessor => this.createQlStartServices(accessor, protocolUrls)));
		} catch (error) {
			// Review c1 M1: kept, not thrown yet: the host's hook rethrows it (the start fails at `before-show` and unwinds); it is
			// thrown below, once that start ended. Review c1 M2: a checkpoint's stop on the cancellation is not a failure (fail ignores it)
			qlStart.fail(error);
		}

		// Open Windows
		// QuantLab host (U3): the terminal host instead of the first window (`openFirstWindow` stays for U5's lazy gate)
		const started = await qlHost;
		const services = await qlStart.outcome();
		const servicesFailure = qlStart.servicesFailure;
		if (servicesFailure) {
			if (started.failed) {
				// Two failures: the start's own is logged here; the services' is the one thrown to main.ts
				this.logService.error('QuantLab host: the terminal host start failed as well as the services', started.error);
			}
			throw servicesFailure.error;
		}
		if (started.failed) {
			throw started.error;
		}
		if (!services.ready) {
			// Review c1 M2: the early start was cancelled (a quit before `Ready`, or the host's start ended) and both halves have
			// stopped: nothing more starts; a held quit goes through now, after the start unwound
			qlStart.releaseHeldQuit();
			return;
		}
		if (started.terminalHost === false || !await this.finishQlTerminalHost(started.terminalHost, services.services.qlWorkbenchHost, initialProtocolUrls)) {
			return;
		}

		// Signal phase: after window open
		this.lifecycleMainService.phase = LifecycleMainPhase.AfterWindowOpen;

		// Post Open Windows Tasks
		this.afterWindowOpen();

		// Set lifecycle phase to `Eventually` after a short delay and when idle (min 2.5sec, max 5sec)
		const eventuallyPhaseScheduler = this._register(new RunOnceScheduler(() => {
			this._register(runWhenGlobalIdle(() => {

				// Signal phase: eventually
				this.lifecycleMainService.phase = LifecycleMainPhase.Eventually;

				// Eventually Post Open Window Tasks
				this.eventuallyAfterWindowOpen();
			}, 2500));
		}, 2500));
		eventuallyPhaseScheduler.schedule();
	}

	private async setupProtocolUrlHandlers(accessor: ServicesAccessor, mainProcessElectronServer: ElectronIPCServer): Promise<IInitialProtocolUrls | undefined> {
		const windowsMainService = this.windowsMainService = accessor.get(IWindowsMainService);
		const urlService = accessor.get(IURLService);
		const nativeHostMainService = this.nativeHostMainService = accessor.get(INativeHostMainService);
		const dialogMainService = accessor.get(IDialogMainService);

		// Install URL handlers that deal with protocl URLs either
		// from this process by opening windows and/or by forwarding
		// the URLs into a window process to be handled there.

		const app = this;
		urlService.registerHandler({
			async handleURL(uri: URI, options?: IOpenURLOptions): Promise<boolean> {
				return app.handleProtocolUrl(windowsMainService, dialogMainService, urlService, uri, options);
			}
		});

		const activeWindowManager = this._register(new ActiveWindowManager({
			onDidOpenMainWindow: nativeHostMainService.onDidOpenMainWindow,
			onDidFocusMainWindow: nativeHostMainService.onDidFocusMainWindow,
			getActiveWindowId: () => nativeHostMainService.getActiveWindowId(-1)
		}));
		const activeWindowRouter = new StaticRouter(ctx => activeWindowManager.getActiveClientId().then(id => ctx === id));
		const urlHandlerRouter = new URLHandlerRouter(activeWindowRouter, this.logService);
		const urlHandlerChannel = mainProcessElectronServer.getChannel('urlHandler', urlHandlerRouter);
		urlService.registerHandler(new URLHandlerChannelClient(urlHandlerChannel));

		const initialProtocolUrls = await this.resolveInitialProtocolUrls(windowsMainService, dialogMainService);
		this._register(new ElectronURLListener(initialProtocolUrls?.urls, urlService, windowsMainService, this.environmentMainService, this.productService, this.logService));

		return initialProtocolUrls;
	}

	private setupManagedRemoteResourceUrlHandler(mainProcessElectronServer: ElectronIPCServer) {
		const notFound = (): Electron.ProtocolResponse => ({ statusCode: 404, data: 'Not found' });
		const remoteResourceChannel = new Lazy(() => mainProcessElectronServer.getChannel(
			NODE_REMOTE_RESOURCE_CHANNEL_NAME,
			new NodeRemoteResourceRouter(),
		));

		protocol.registerBufferProtocol(Schemas.vscodeManagedRemoteResource, (request, callback) => {
			const url = URI.parse(request.url);
			if (!url.authority.startsWith('window:')) {
				return callback(notFound());
			}

			remoteResourceChannel.value.call<NodeRemoteResourceResponse>(NODE_REMOTE_RESOURCE_IPC_METHOD_NAME, [url]).then(
				r => callback({ ...r, data: Buffer.from(r.body, 'base64') }),
				err => {
					this.logService.warn('error dispatching remote resource call', err);
					callback({ statusCode: 500, data: String(err) });
				});
		});
	}

	private async resolveInitialProtocolUrls(windowsMainService: IWindowsMainService, dialogMainService: IDialogMainService): Promise<IInitialProtocolUrls | undefined> {

		/**
		 * Protocol URL handling on startup is complex, refer to
		 * {@link IInitialProtocolUrls} for an explainer.
		 */

		// Windows/Linux: protocol handler invokes CLI with --open-url
		const protocolUrlsFromCommandLine = this.environmentMainService.args['open-url'] ? this.environmentMainService.args._urls || [] : [];
		if (protocolUrlsFromCommandLine.length > 0) {
			this.logService.trace('app#resolveInitialProtocolUrls() protocol urls from command line:', protocolUrlsFromCommandLine);
		}

		// macOS: open-url events that were received before the app is ready
		const protocolUrlsFromEvent = ((global as { getOpenUrls?: () => string[] }).getOpenUrls?.() || []);
		if (protocolUrlsFromEvent.length > 0) {
			this.logService.trace(`app#resolveInitialProtocolUrls() protocol urls from macOS 'open-url' event:`, protocolUrlsFromEvent);
		}

		if (protocolUrlsFromCommandLine.length + protocolUrlsFromEvent.length === 0) {
			return undefined;
		}

		const protocolUrls = [
			...protocolUrlsFromCommandLine,
			...protocolUrlsFromEvent
		].map(url => {
			try {
				return { uri: URI.parse(url), originalUrl: url };
			} catch {
				this.logService.trace('app#resolveInitialProtocolUrls() protocol url failed to parse:', url);

				return undefined;
			}
		});

		const openables: IWindowOpenable[] = [];
		const urls: IProtocolUrl[] = [];
		for (const protocolUrl of protocolUrls) {
			if (!protocolUrl) {
				continue; // invalid
			}

			const windowOpenable = this.getWindowOpenableFromProtocolUrl(protocolUrl.uri);
			if (windowOpenable) {
				if (await this.shouldBlockOpenable(windowOpenable, windowsMainService, dialogMainService)) {
					this.logService.trace('app#resolveInitialProtocolUrls() protocol url was blocked:', protocolUrl.uri.toString(true));

					continue; // blocked
				} else {
					this.logService.trace('app#resolveInitialProtocolUrls() protocol url will be handled as window to open:', protocolUrl.uri.toString(true), windowOpenable);

					openables.push(windowOpenable); // handled as window to open
				}
			} else {
				this.logService.trace('app#resolveInitialProtocolUrls() protocol url will be passed to active window for handling:', protocolUrl.uri.toString(true));

				urls.push(protocolUrl); // handled within active window
			}
		}

		return { urls, openables };
	}

	private async shouldBlockOpenable(openable: IWindowOpenable, windowsMainService: IWindowsMainService, dialogMainService: IDialogMainService): Promise<boolean> {
		let openableUri: URI;
		let message: string;
		if (isWorkspaceToOpen(openable)) {
			openableUri = openable.workspaceUri;
			message = localize('confirmOpenMessageWorkspace', "An external application wants to open '{0}' in {1}. Do you want to open this workspace file?", openableUri.scheme === Schemas.file ? getPathLabel(openableUri, { os: OS, tildify: this.environmentMainService }) : openableUri.toString(true), this.productService.nameShort);
		} else if (isFolderToOpen(openable)) {
			openableUri = openable.folderUri;
			message = localize('confirmOpenMessageFolder', "An external application wants to open '{0}' in {1}. Do you want to open this folder?", openableUri.scheme === Schemas.file ? getPathLabel(openableUri, { os: OS, tildify: this.environmentMainService }) : openableUri.toString(true), this.productService.nameShort);
		} else {
			openableUri = openable.fileUri;
			message = localize('confirmOpenMessageFileOrFolder', "An external application wants to open '{0}' in {1}. Do you want to open this file or folder?", openableUri.scheme === Schemas.file ? getPathLabel(openableUri, { os: OS, tildify: this.environmentMainService }) : openableUri.toString(true), this.productService.nameShort);
		}

		if (openableUri.scheme !== Schemas.file && openableUri.scheme !== Schemas.vscodeRemote) {

			// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
			//
			// NOTE: we currently only ask for confirmation for `file` and `vscode-remote`
			// authorities here. There is an additional confirmation for `extension.id`
			// authorities from within the window.
			//
			// IF YOU ARE PLANNING ON ADDING ANOTHER AUTHORITY HERE, MAKE SURE TO ALSO
			// ADD IT TO THE CONFIRMATION CODE BELOW OR INSIDE THE WINDOW!
			//
			// !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

			return false;
		}

		const askForConfirmation = this.configurationService.getValue<unknown>(CodeApplication.SECURITY_PROTOCOL_HANDLING_CONFIRMATION_SETTING_KEY[openableUri.scheme]);
		if (askForConfirmation === false) {
			return false; // not blocked via settings
		}

		const { response, checkboxChecked } = await dialogMainService.showMessageBox({
			type: 'warning',
			buttons: [
				localize({ key: 'open', comment: ['&& denotes a mnemonic'] }, "&&Yes"),
				localize({ key: 'cancel', comment: ['&& denotes a mnemonic'] }, "&&No")
			],
			message,
			detail: localize('confirmOpenDetail', "If you did not initiate this request, it may represent an attempted attack on your system. Unless you took an explicit action to initiate this request, you should press 'No'"),
			checkboxLabel: openableUri.scheme === Schemas.file ? localize('doNotAskAgainLocal', "Allow opening local paths without asking") : localize('doNotAskAgainRemote', "Allow opening remote paths without asking"),
			cancelId: 1
		});

		if (response !== 0) {
			return true; // blocked by user choice
		}

		if (checkboxChecked) {
			// Due to https://github.com/microsoft/vscode/issues/195436, we can only
			// update settings from within a window. But we do not know if a window
			// is about to open or can already handle the request, so we have to send
			// to any current window and any newly opening window.
			const request = { channel: 'vscode:disablePromptForProtocolHandling', args: openableUri.scheme === Schemas.file ? 'local' : 'remote' };
			windowsMainService.sendToFocused(request.channel, request.args);
			windowsMainService.sendToOpeningWindow(request.channel, request.args);
		}

		return false; // not blocked by user choice
	}

	private getWindowOpenableFromProtocolUrl(uri: URI): IWindowOpenable | undefined {
		if (!uri.path) {
			return undefined;
		}

		// File path
		if (uri.authority === Schemas.file) {
			const fileUri = URI.file(uri.fsPath);

			if (hasWorkspaceFileExtension(fileUri)) {
				return { workspaceUri: fileUri };
			}

			return { fileUri };
		}

		// Remote path
		else if (uri.authority === Schemas.vscodeRemote) {

			// Example conversion:
			// From: vscode://vscode-remote/wsl+ubuntu/mnt/c/GitDevelopment/monaco
			//   To: vscode-remote://wsl+ubuntu/mnt/c/GitDevelopment/monaco

			const secondSlash = uri.path.indexOf(posix.sep, 1 /* skip over the leading slash */);
			let authority: string;
			let path: string;
			if (secondSlash !== -1) {
				authority = uri.path.substring(1, secondSlash);
				path = uri.path.substring(secondSlash);
			} else {
				authority = uri.path.substring(1);
				path = '/';
			}

			let query = uri.query;
			const params = new URLSearchParams(uri.query);
			if (params.get('windowId') === '_blank') {
				// Make sure to unset any `windowId=_blank` here
				// https://github.com/microsoft/vscode/issues/191902
				params.delete('windowId');
				query = params.toString();
			}

			const remoteUri = URI.from({ scheme: Schemas.vscodeRemote, authority, path, query, fragment: uri.fragment });

			if (hasWorkspaceFileExtension(path)) {
				return { workspaceUri: remoteUri };
			}

			if (/:[\d]+$/.test(path)) {
				// path with :line:column syntax
				return { fileUri: remoteUri };
			}

			return { folderUri: remoteUri };
		}
		return undefined;
	}

	private async handleProtocolUrl(windowsMainService: IWindowsMainService, dialogMainService: IDialogMainService, urlService: IURLService, uri: URI, options?: IOpenURLOptions): Promise<boolean> {
		this.logService.trace('app#handleProtocolUrl():', uri.toString(true), options);

		// Support 'workspace' URLs (https://github.com/microsoft/vscode/issues/124263)
		if (uri.scheme === this.productService.urlProtocol && uri.path === 'workspace') {
			uri = uri.with({
				authority: 'file',
				path: URI.parse(uri.query).path,
				query: ''
			});
		}

		let shouldOpenInNewWindow = false;

		// We should handle the URI in a new window if the URL contains `windowId=_blank`
		const params = new URLSearchParams(uri.query);
		if (params.get('windowId') === '_blank') {
			this.logService.trace(`app#handleProtocolUrl() found 'windowId=_blank' as parameter, setting shouldOpenInNewWindow=true:`, uri.toString(true));

			params.delete('windowId');
			uri = uri.with({ query: params.toString() });

			shouldOpenInNewWindow = true;
		}

		// or if no window is open (macOS only)
		// QuantLab host (U5): on every platform: no workbench window is the normal state until the first use, and the URL
		// then reaches the gate as a first-use event instead of being reported as not handled
		else if (windowsMainService.getWindowCount() === 0) {
			this.logService.trace(`app#handleProtocolUrl() with no window open, setting shouldOpenInNewWindow=true:`, uri.toString(true));

			shouldOpenInNewWindow = true;
		}

		// Pass along whether the application is being opened via a Continue On flow
		const continueOn = params.get('continueOn');
		if (continueOn !== null) {
			this.logService.trace(`app#handleProtocolUrl() found 'continueOn' as parameter:`, uri.toString(true));

			params.delete('continueOn');
			uri = uri.with({ query: params.toString() });

			this.environmentMainService.continueOn = continueOn ?? undefined;
		}

		// Check if the protocol URL is a window openable to open...
		const windowOpenableFromProtocolUrl = this.getWindowOpenableFromProtocolUrl(uri);
		if (windowOpenableFromProtocolUrl) {
			if (await this.shouldBlockOpenable(windowOpenableFromProtocolUrl, windowsMainService, dialogMainService)) {
				this.logService.trace('app#handleProtocolUrl() protocol url was blocked:', uri.toString(true));

				return true; // If openable should be blocked, behave as if it's handled
			} else {
				this.logService.trace('app#handleProtocolUrl() opening protocol url as window:', windowOpenableFromProtocolUrl, uri.toString(true));

				const window = (await windowsMainService.open({
					context: OpenContext.LINK,
					cli: { ...this.environmentMainService.args },
					urisToOpen: [windowOpenableFromProtocolUrl],
					forceNewWindow: shouldOpenInNewWindow,
					gotoLineMode: true
					// remoteAuthority: will be determined based on windowOpenableFromProtocolUrl
				})).at(0);

				window?.focus(); // this should help ensuring that the right window gets focus when multiple are opened

				return true;
			}
		}

		// ...or if we should open in a new window and then handle it within that window
		if (shouldOpenInNewWindow) {
			this.logService.trace('app#handleProtocolUrl() opening empty window and passing in protocol url:', uri.toString(true));

			const window = (await windowsMainService.open({
				context: OpenContext.LINK,
				cli: { ...this.environmentMainService.args },
				forceNewWindow: true,
				forceEmpty: true,
				gotoLineMode: true,
				remoteAuthority: getRemoteAuthority(uri)
			})).at(0);

			await window?.ready();

			return urlService.open(uri, options);
		}

		this.logService.trace('app#handleProtocolUrl(): not handled', uri.toString(true), options);

		return false;
	}

	private setupSharedProcess(machineId: string, sqmId: string, devDeviceId: string): { sharedProcessReady: Promise<MessagePortClient>; sharedProcessClient: Promise<MessagePortClient> } {
		const sharedProcess = this._register(this.mainInstantiationService.createInstance(SharedProcess, machineId, sqmId, devDeviceId));

		this._register(sharedProcess.onDidCrash(() => this.windowsMainService?.sendToFocused('vscode:reportSharedProcessCrash')));

		const sharedProcessClient = (async () => {
			this.logService.trace('Main->SharedProcess#connect');

			const port = await sharedProcess.connect();

			this.logService.trace('Main->SharedProcess#connect: connection established');

			return new MessagePortClient(port, 'main');
		})();

		const sharedProcessReady = (async () => {
			await sharedProcess.whenReady();

			return sharedProcessClient;
		})();

		return { sharedProcessReady, sharedProcessClient };
	}

	private async initServices(machineId: string, sqmId: string, devDeviceId: string, sharedProcessReady: Promise<MessagePortClient>): Promise<IInstantiationService> {
		const services = new ServiceCollection();

		// Update
		switch (process.platform) {
			case 'win32':
				services.set(IUpdateService, new SyncDescriptor(Win32UpdateService));
				break;

			case 'linux':
				if (isLinuxSnap) {
					services.set(IUpdateService, new SyncDescriptor(SnapUpdateService, [process.env['SNAP'], process.env['SNAP_REVISION']]));
				} else {
					services.set(IUpdateService, new SyncDescriptor(LinuxUpdateService));
				}
				break;

			case 'darwin':
				services.set(IUpdateService, new SyncDescriptor(DarwinUpdateService));
				break;
		}

		// Windows
		// QuantLab host (U5): the lazy gate stands in for the windows service; the stock `WindowsMainService` is created inside it
		services.set(IWindowsMainService, new SyncDescriptor(QlWindowsGate, [machineId, sqmId, devDeviceId, this.userEnv], false));
		services.set(IAuxiliaryWindowsMainService, new SyncDescriptor(AuxiliaryWindowsMainService, undefined, false));

		// Dialogs
		// QuantLab host (U5): the same service, but a dialog for the adopted workbench is parented to the host window
		const dialogMainService = new QlDialogMainService(this.logService, this.productService);
		services.set(IDialogMainService, dialogMainService);

		// Launch
		services.set(ILaunchMainService, new SyncDescriptor(LaunchMainService, undefined, false /* proxied to other processes */));

		// Diagnostics
		services.set(IDiagnosticsMainService, new SyncDescriptor(DiagnosticsMainService, undefined, false /* proxied to other processes */));
		services.set(IDiagnosticsService, ProxyChannel.toService(getDelayedChannel(sharedProcessReady.then(client => client.getChannel('diagnostics')))));

		// Encryption
		services.set(IEncryptionMainService, new SyncDescriptor(EncryptionMainService));

		// Browser Elements
		services.set(INativeBrowserElementsMainService, new SyncDescriptor(NativeBrowserElementsMainService, undefined, false /* proxied to other processes */));

		// Keyboard Layout
		services.set(IKeyboardLayoutMainService, new SyncDescriptor(KeyboardLayoutMainService));

		// Native Host
		services.set(INativeHostMainService, new SyncDescriptor(NativeHostMainService, undefined, false /* proxied to other processes */));

		// Web Contents Extractor
		services.set(IWebContentExtractorService, new SyncDescriptor(NativeWebContentExtractorService, undefined, false /* proxied to other processes */));

		// Webview Manager
		services.set(IWebviewManagerService, new SyncDescriptor(WebviewMainService, [this.qlWebviewRegistry])); // QuantLab host (review c2 M2 + M3): the registry the frame policy reads

		// Menubar
		services.set(IMenubarMainService, new SyncDescriptor(MenubarMainService));

		// Extension Host Starter
		services.set(IExtensionHostStarter, new SyncDescriptor(ExtensionHostStarter));

		// Storage
		services.set(IStorageMainService, new SyncDescriptor(StorageMainService));
		services.set(IApplicationStorageMainService, new SyncDescriptor(ApplicationStorageMainService));

		// Terminal
		const ptyHostStarter = new ElectronPtyHostStarter({
			graceTime: LocalReconnectConstants.GraceTime,
			shortGraceTime: LocalReconnectConstants.ShortGraceTime,
			scrollback: this.configurationService.getValue<number>(TerminalSettingId.PersistentSessionScrollback) ?? 100
		}, this.configurationService, this.environmentMainService, this.lifecycleMainService, this.logService);
		const ptyHostService = new PtyHostService(
			ptyHostStarter,
			this.configurationService,
			this.logService,
			this.loggerService
		);
		services.set(ILocalPtyService, ptyHostService);

		// External terminal
		if (isWindows) {
			services.set(IExternalTerminalMainService, new SyncDescriptor(WindowsExternalTerminalService));
		} else if (isMacintosh) {
			services.set(IExternalTerminalMainService, new SyncDescriptor(MacExternalTerminalService));
		} else if (isLinux) {
			services.set(IExternalTerminalMainService, new SyncDescriptor(LinuxExternalTerminalService));
		}

		// Backups
		const backupMainService = new BackupMainService(this.environmentMainService, this.configurationService, this.logService, this.stateService);
		services.set(IBackupMainService, backupMainService);

		// Workspaces
		const workspacesManagementMainService = new WorkspacesManagementMainService(this.environmentMainService, this.logService, this.userDataProfilesMainService, backupMainService, dialogMainService);
		services.set(IWorkspacesManagementMainService, workspacesManagementMainService);
		services.set(IWorkspacesService, new SyncDescriptor(WorkspacesMainService, undefined, false /* proxied to other processes */));
		services.set(IWorkspacesHistoryMainService, new SyncDescriptor(WorkspacesHistoryMainService, undefined, false));

		// URL handling
		services.set(IURLService, new SyncDescriptor(NativeURLService, undefined, false /* proxied to other processes */));

		// Telemetry
		if (supportsTelemetry(this.productService, this.environmentMainService)) {
			const isInternal = isInternalTelemetry(this.productService, this.configurationService);
			const channel = getDelayedChannel(sharedProcessReady.then(client => client.getChannel('telemetryAppender')));
			const appender = new TelemetryAppenderClient(channel);
			const commonProperties = resolveCommonProperties(release(), hostname(), process.arch, this.productService.commit, this.productService.version, machineId, sqmId, devDeviceId, isInternal, this.productService.date);
			const piiPaths = getPiiPathsFromEnvironment(this.environmentMainService);
			const config: ITelemetryServiceConfig = { appenders: [appender], commonProperties, piiPaths, sendErrorTelemetry: true };

			services.set(ITelemetryService, new SyncDescriptor(TelemetryService, [config], false));
		} else {
			services.set(ITelemetryService, NullTelemetryService);
		}

		// Default Extensions Profile Init
		services.set(IExtensionsProfileScannerService, new SyncDescriptor(ExtensionsProfileScannerService, undefined, true));
		services.set(IExtensionsScannerService, new SyncDescriptor(ExtensionsScannerService, undefined, true));

		// Utility Process Worker
		services.set(IUtilityProcessWorkerMainService, new SyncDescriptor(UtilityProcessWorkerMainService, undefined, true));

		// Proxy Auth
		services.set(IProxyAuthService, new SyncDescriptor(ProxyAuthService));

		// MCP
		services.set(INativeMcpDiscoveryHelperService, new SyncDescriptor(NativeMcpDiscoveryHelperService));


		// Dev Only: CSS service (for ESM)
		services.set(ICSSDevelopmentService, new SyncDescriptor(CSSDevelopmentService, undefined, true));

		// Init services that require it
		await Promises.settled([
			backupMainService.initialize(),
			workspacesManagementMainService.initialize()
		]);

		return this.mainInstantiationService.createChild(services);
	}

	private initChannels(accessor: ServicesAccessor, mainProcessElectronServer: ElectronIPCServer, sharedProcessClient: Promise<MessagePortClient>): void {

		// Channels registered to node.js are exposed to second instances
		// launching because that is the only way the second instance
		// can talk to the first instance. Electron IPC does not work
		// across apps until `requestSingleInstance` APIs are adopted.

		const disposables = this._register(new DisposableStore());

		const launchChannel = ProxyChannel.fromService(accessor.get(ILaunchMainService), disposables, { disableMarshalling: true });
		this.mainProcessNodeIpcServer.registerChannel('launch', launchChannel);

		const diagnosticsChannel = ProxyChannel.fromService(accessor.get(IDiagnosticsMainService), disposables, { disableMarshalling: true });
		this.mainProcessNodeIpcServer.registerChannel('diagnostics', diagnosticsChannel);

		// Policies (main & shared process)
		const policyChannel = disposables.add(new PolicyChannel(accessor.get(IPolicyService)));
		mainProcessElectronServer.registerChannel('policy', policyChannel);
		sharedProcessClient.then(client => client.registerChannel('policy', policyChannel));

		// Local Files
		const diskFileSystemProvider = this.fileService.getProvider(Schemas.file);
		assertType(diskFileSystemProvider instanceof DiskFileSystemProvider);
		const fileSystemProviderChannel = disposables.add(new DiskFileSystemProviderChannel(diskFileSystemProvider, this.logService, this.environmentMainService));
		mainProcessElectronServer.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, fileSystemProviderChannel);
		sharedProcessClient.then(client => client.registerChannel(LOCAL_FILE_SYSTEM_CHANNEL_NAME, fileSystemProviderChannel));

		// User Data Profiles
		const userDataProfilesService = ProxyChannel.fromService(accessor.get(IUserDataProfilesMainService), disposables);
		mainProcessElectronServer.registerChannel('userDataProfiles', userDataProfilesService);
		sharedProcessClient.then(client => client.registerChannel('userDataProfiles', userDataProfilesService));

		// Update
		const updateChannel = new UpdateChannel(accessor.get(IUpdateService));
		mainProcessElectronServer.registerChannel('update', updateChannel);

		// Process
		const processChannel = ProxyChannel.fromService(new ProcessMainService(this.logService, accessor.get(IDiagnosticsService), accessor.get(IDiagnosticsMainService)), disposables);
		mainProcessElectronServer.registerChannel('process', processChannel);

		// Encryption
		const encryptionChannel = ProxyChannel.fromService(accessor.get(IEncryptionMainService), disposables);
		mainProcessElectronServer.registerChannel('encryption', encryptionChannel);

		// Browser Elements
		const browserElementsChannel = ProxyChannel.fromService(accessor.get(INativeBrowserElementsMainService), disposables);
		mainProcessElectronServer.registerChannel('browserElements', browserElementsChannel);
		sharedProcessClient.then(client => client.registerChannel('browserElements', browserElementsChannel));

		// Signing
		const signChannel = ProxyChannel.fromService(accessor.get(ISignService), disposables);
		mainProcessElectronServer.registerChannel('sign', signChannel);

		// Keyboard Layout
		const keyboardLayoutChannel = ProxyChannel.fromService(accessor.get(IKeyboardLayoutMainService), disposables);
		mainProcessElectronServer.registerChannel('keyboardLayout', keyboardLayoutChannel);

		// Native host (main & shared process)
		this.nativeHostMainService = accessor.get(INativeHostMainService);
		const nativeHostChannel = ProxyChannel.fromService(this.nativeHostMainService, disposables);
		mainProcessElectronServer.registerChannel('nativeHost', nativeHostChannel);
		sharedProcessClient.then(client => client.registerChannel('nativeHost', nativeHostChannel));

		// Web Content Extractor
		const webContentExtractorChannel = ProxyChannel.fromService(accessor.get(IWebContentExtractorService), disposables);
		mainProcessElectronServer.registerChannel('webContentExtractor', webContentExtractorChannel);

		// Workspaces
		const workspacesChannel = ProxyChannel.fromService(accessor.get(IWorkspacesService), disposables);
		mainProcessElectronServer.registerChannel('workspaces', workspacesChannel);

		// Menubar
		const menubarChannel = ProxyChannel.fromService(accessor.get(IMenubarMainService), disposables);
		mainProcessElectronServer.registerChannel('menubar', menubarChannel);

		// URL handling
		const urlChannel = ProxyChannel.fromService(accessor.get(IURLService), disposables);
		mainProcessElectronServer.registerChannel('url', urlChannel);

		// Webview Manager
		const webviewChannel = ProxyChannel.fromService(accessor.get(IWebviewManagerService), disposables);
		mainProcessElectronServer.registerChannel('webview', webviewChannel);

		// Storage (main & shared process)
		const storageChannel = disposables.add((new StorageDatabaseChannel(this.logService, accessor.get(IStorageMainService))));
		mainProcessElectronServer.registerChannel('storage', storageChannel);
		sharedProcessClient.then(client => client.registerChannel('storage', storageChannel));

		// Profile Storage Changes Listener (shared process)
		const profileStorageListener = disposables.add((new ProfileStorageChangesListenerChannel(accessor.get(IStorageMainService), accessor.get(IUserDataProfilesMainService), this.logService)));
		sharedProcessClient.then(client => client.registerChannel('profileStorageListener', profileStorageListener));

		// Terminal
		const ptyHostChannel = ProxyChannel.fromService(accessor.get(ILocalPtyService), disposables);
		mainProcessElectronServer.registerChannel(TerminalIpcChannels.LocalPty, ptyHostChannel);

		// External Terminal
		const externalTerminalChannel = ProxyChannel.fromService(accessor.get(IExternalTerminalMainService), disposables);
		mainProcessElectronServer.registerChannel('externalTerminal', externalTerminalChannel);

		// MCP
		const mcpDiscoveryChannel = ProxyChannel.fromService(accessor.get(INativeMcpDiscoveryHelperService), disposables);
		mainProcessElectronServer.registerChannel(NativeMcpDiscoveryHelperChannelName, mcpDiscoveryChannel);

		// Logger
		const loggerChannel = new LoggerChannel(accessor.get(ILoggerMainService),);
		mainProcessElectronServer.registerChannel('logger', loggerChannel);
		sharedProcessClient.then(client => client.registerChannel('logger', loggerChannel));

		// Request (QIC: expose main process request service to bypass CORS in renderer)
		const requestChannel = new RequestChannel(accessor.get(IRequestService));
		mainProcessElectronServer.registerChannel('request', requestChannel);

		// Extension Host Debug Broadcasting
		const electronExtensionHostDebugBroadcastChannel = new ElectronExtensionHostDebugBroadcastChannel(accessor.get(IWindowsMainService));
		mainProcessElectronServer.registerChannel('extensionhostdebugservice', electronExtensionHostDebugBroadcastChannel);

		// Extension Host Starter
		const extensionHostStarterChannel = ProxyChannel.fromService(accessor.get(IExtensionHostStarter), disposables);
		mainProcessElectronServer.registerChannel(ipcExtensionHostStarterChannelName, extensionHostStarterChannel);

		// Utility Process Worker
		const utilityProcessWorkerChannel = ProxyChannel.fromService(accessor.get(IUtilityProcessWorkerMainService), disposables);
		mainProcessElectronServer.registerChannel(ipcUtilityProcessWorkerChannelName, utilityProcessWorkerChannel);
	}

	// QuantLab host (U3): where the terminal view's files are staged by the client emit (one location, dev and packaged)
	private qlTerminalPaths(): { readonly preloadPath: string; readonly rendererDir: string } {
		return {
			preloadPath: FileAccess.asFileUri('vs/code/electron-main/ql-client/terminal/preload.cjs').fsPath,
			rendererDir: FileAccess.asFileUri('vs/code/electron-main/ql-client/terminal/renderer').fsPath
		};
	}

	// QuantLab host (U3): whether these contents run the terminal's navigation policy: they are a view the started
	// host registered with the role `terminal` (the terminal view, and U6's overlay view: same policy by rule OV-3).
	// Decided at event time from the host's own registry, never from a preference the contents report.
	private isQlTerminalContents(contents: WebContents): boolean {
		const host = this.qlTerminalHost;
		if (host === undefined) {
			return false;
		}

		return host.viewRecords().some(record => record.role === 'terminal' && host.view(record.name)?.webContents === contents);
	}

	// QuantLab host (U3): starts the terminal host in place of `openFirstWindow`. Returns false when the start
	// failed and the app is exiting (the client start has already logged `exit 1` and unwound).
	/**
	 * QuantLab host (F-PERF-LZ1-1): what the terminal host's `onBeforeShow` and `openQuantlab` need from initServices, taken once the
	 * services exist (synchronously, from the accessor); the host itself started before them (`startQlTerminalHost`).
	 */
	private createQlStartServices(accessor: ServicesAccessor, initialProtocolUrls: IInitialProtocolUrls | undefined): QlStartServices {

		// What `openFirstWindow` assigned and later code reads. EVERY service is taken from the accessor here, before the first
		// `await`: a ServicesAccessor is valid only during the synchronous invocation of its function ("Illegal state: service
		// accessor is only valid during the invocation of its target method", package 5c main-loads, folds/HOST/U5-LAUNCH-3.md).
		const windowsMainService = this.windowsMainService = accessor.get(IWindowsMainService);
		this.auxiliaryWindowsMainService = accessor.get(IAuxiliaryWindowsMainService);
		const instantiationService = accessor.get(IInstantiationService);
		const dialogMainService = accessor.get(IDialogMainService);
		const encryptionMainService = this.requireQlEncryptionMainService(accessor.get(IEncryptionMainService));

		// QuantLab host (U5): the workbench is a lazy sibling view (qlHost/): the gate (it IS the windows service) opens and
		// adopts it on first use. The launch's protocol urls and openables are handed to the first window that opens, once.
		let launchProtocolUrls = initialProtocolUrls;
		const qlWorkbenchHost = this.qlWorkbenchHost = new QlWorkbenchHost({
			gate: requireQlWindowsGate(windowsMainService),
			dialogs: this.requireQlDialogMainService(dialogMainService),
			lifecycleMainService: this.lifecycleMainService,
			logService: this.logService,
			framePolicy: this.qlFramePolicy(),
			openWorkbench: () => {
				const protocolUrls = launchProtocolUrls;
				launchProtocolUrls = undefined;

				return instantiationService.invokeFunction(windowsAccessor => this.openFirstWindow(windowsAccessor, protocolUrls));
			},
			openExternal: url => {
				const nativeHostMainService = this.nativeHostMainService;
				if (!nativeHostMainService) {
					throw new Error('QuantLab host (U5): openExternal before the native host service exists');
				}

				nativeHostMainService.openExternal(undefined, url).catch(error => this.logService.error(`QuantLab host: opening ${url} in the system browser failed`, error));
			}
		});

		return { qlWorkbenchHost, encryptionMainService };
	}

	/**
	 * QuantLab host (F-PERF-LZ1-1): the terminal host's start, run at the top of `startup()` before the machine-ids await and
	 * initServices: it needs only what CodeMain made. `onBeforeShow` (and `openQuantlab`) wait for `qlStart.services()`; the client
	 * awaits the hook before it shows the window. Resolves the started host, or `false` after a quit during the start or a failed
	 * start (handled here as before: quit through the lifecycle, or exit 1), or after a start that ended once the services failed
	 * (review c1 M1: `startup()` reports that failure).
	 */
	private async startQlTerminalHost(qlStart: QlEarlyStart<QlStartServices>): Promise<TerminalHost | false> {
		// The pairing (HOST condition 1): a client that does not await `onBeforeShow` would show the window before the services exist
		if (onBeforeShowAwaited() !== true) {
			throw new Error('QuantLab host (F-PERF-LZ1-1): the client does not await onBeforeShow (no onBeforeShowAwaited marker): fork and client are not a pair');
		}

		// QuantLab host (U6): the chrome seed, first of all: before the terminal host starts and so before the gate, a launch request or
		// a key can open a workbench window that reads the default profile's settings. A failure to create or read the file is not
		// caught: `main.ts` quits with the error (a seed that is present but differs is logged by the seed and the launch goes on)
		await seedQlChromeSettings(this.userDataProfilesMainService.defaultProfile.settingsResource, this.logService);

		// Throws when the build holds no baked values: not caught, `main.ts` quits with the error
		const { backendOrigin, version } = bakedBuildValues();
		const { preloadPath, rendererDir } = this.qlTerminalPaths();

		const ports: Ports = {
			electron: { app, BaseWindow, WebContentsView, session, protocol, ipcMain, shell, safeStorage, dialog, screen },
			validatedIpcMain,
			platform: process.platform,
			backendOrigin,
			version,
			devTools: !this.environmentMainService.isBuilt,
			preloadPath,
			rendererDir,
			openQuantlab: async intent => (await qlStart.services()).qlWorkbenchHost.openQuantlab(intent),
			// QuantLab host (review c1 M7): the workbench host takes over the window's close (the quit handshake runs through the
			// lifecycle before the window goes), the toggle key and the gate's requests while the window is still hidden and nothing
			// is loaded: no key at the first did-finish-load and no close during the start reaches a host without them
			// QuantLab host (review c1 M8): the start's Keychain phase (token store, launch cookie; behind its painted waiting window
			// on macOS) has settled by now: only from here may the fork's own encryption service make its synchronous safeStorage calls
			// F-PERF-LZ1-1: the host started before the services; the client awaits this hook before it shows the window
			onBeforeShow: async started => {
				const { qlWorkbenchHost, encryptionMainService } = await qlStart.services();
				qlWorkbenchHost.attach(started);
				encryptionMainService.terminalHostKeychainPhaseSettled();
			}
		};

		// QuantLab host (review c1 M7, package K1-1): a quit during the start waits for the start to settle. A TERM destroys the
		// window, the lifecycle's shutdown joiners settle in milliseconds and its final quit ended the process while the rejected
		// start was still unwinding (exit 133, SIGTRAP in the isolate's disposal, no `exit 0`). The start is a shutdown joiner
		// until it settles; the joiner only waits: the rejection itself is handled by the catch below.
		mark('code/ql/willStartTerminalHost');
		const timeOrigin = getMarks().find(m => m.name === 'code/timeOrigin');
		if (!timeOrigin) {
			throw new Error('QuantLab host: no code/timeOrigin mark: the startup marks cannot be placed');
		}
		this.logService.info(`QuantLab host: startup marks (ms from process start) ${getMarks().map(m => `${m.name}=${Math.round(m.startTime - timeOrigin.startTime)}`).join(' ')}`);
		const starting = startTerminalHost(ports);
		const startJoiner = Event.once(this.lifecycleMainService.onWillShutdown)(e => e.join('qlTerminalHostStart', starting.then(() => undefined, () => undefined)));
		let terminalHost: TerminalHost;
		try {
			terminalHost = await starting;
		} catch (error) {
			startJoiner.dispose();

			// Review c1 M1: the services failed (the hook rethrew their failure, or the start ended otherwise meanwhile): `startup()`
			// throws that failure to main.ts once, after this; the start's own ending is logged here, with no exit of its own
			if (qlStart.servicesFailure) {
				this.logService.info('QuantLab host: the terminal host start ended after the services failed (startup reports that failure)', error);

				return false;
			}

			// QuantLab host (review c1 M7): the window was closed during the start (a close, Cmd+Q, a TERM, an update restart): a
			// quit, not a failure (the client logged `quit during start` and `exit 0`). A quit already under way ends on its own: a
			// second `app.quit()` during the lifecycle's prevented `will-quit` ends the process under its joiners
			// (folds/HOST/QUIT-EXIT-FIX.md). A close that started no quit (macOS: closing the only window) quits through the lifecycle.
			// Review c1 M2: a quit before `Ready` is held by the early guard (`qlStart.quitHeld`) and let through once the start has
			// ended: not a second quit here either; and whatever ended the start after it (the hook's cancellation, a waiting window
			// the quit closed) is that quit, not a failure.
			if (isQuitDuringStart(error) || qlStart.quitHeld) {
				this.logService.info('QuantLab host: the window was closed during the terminal host start; the app quits', error);
				if (!this.lifecycleMainService.quitRequested && !qlStart.quitHeld) {
					this.lifecycleMainService.quit().then(
						veto => veto && this.logService.error('QuantLab host: the quit after a close during the start was vetoed'),
						quitError => this.logService.error('QuantLab host: the quit after a close during the start failed', quitError)
					);
				}

				return false;
			}

			this.logService.error(error);
			app.exit(1);

			return false;
		}
		startJoiner.dispose();
		this.qlTerminalHost = terminalHost;

		return terminalHost;
	}

	/**
	 * QuantLab host (F-PERF-LZ1-1): the started host's remaining steps, after both the start and the services settled (as before
	 * the split: the updater, the test build's driver hooks, the launch request, the quit listeners). No accessor here.
	 */
	private async finishQlTerminalHost(terminalHost: TerminalHost, qlWorkbenchHost: QlWorkbenchHost, initialProtocolUrls: IInitialProtocolUrls | undefined): Promise<boolean> {

		// QuantLab updater (PACK, folds/HOST/PACK-UPDATER-HUNK.md): the ONE updater, electron-updater injected into the client
		// module; install on Electron's quit only (autoInstallOnAppQuit), no quitAndInstall and no restart UI in v1
		const { autoUpdater } = electronUpdater;
		autoUpdater.autoDownload = true;
		autoUpdater.autoInstallOnAppQuit = true;
		const updater = createUpdater(terminalHost.host, { updater: autoUpdater });
		updater.checkForUpdates().catch(err => this.logService.error('updater: check failed', err));


		// QuantLab host (DRIVER): TEST BUILDS ONLY. `globalThis.QL_TEST_BUILD` is a constant `false` in a product bundle (esbuild define,
		// build/lib/optimize.ts), so esbuild drops this block and the dynamic import with it: a product bundle carries neither the dump
		// module nor its file name. The built-app driver reads the view records from the user-data dir; they are written now (the
		// terminal view) and again after EVERY change of the host's registry, published by the registry itself (review c1 S2: the
		// overlay's Escape, renderer loss and switch close it from inside the client, which wrapping the exported methods missed).
		// A failed write is thrown into the code that changed the registry, never caught.
		if (globalThis.QL_TEST_BUILD) {
			const { dump } = await import('./qlHost/viewRecordsDump.js');
			const { qlProcessRoleLines } = await import('./qlHost/processRoles.js');
			const userDataPath = this.environmentMainService.userDataPath;
			const publishViewRecords = (records: readonly ViewRecord[]): void => {
				this.logService.info(`QuantLab host: test build: view records written to ${dump(records, userDataPath)}`);
			};

			terminalHost.onViewRecordsChanged(publishViewRecords);
			publishViewRecords(terminalHost.viewRecords());

			// The driver's `showWorkbench()`. A key injected over CDP reaches the page and never the host's `before-input-event`
			// (measured on package 7, folds/HOST/A2-SPLIT-7.md), so the driver cannot press the toggle key: in a test build the
			// terminal page asks by console message (the driver evaluates `console.debug('ql-test:show-workbench')` in it). It is a
			// request like a launch argument's: first use, then shown; a failure goes to the failure dialog and the log.
			const terminalView = terminalHost.view('terminal');
			if (!terminalView) {
				throw new Error('QuantLab host (DRIVER): the started host registered no terminal view');
			}
			// `ql-test:toggle` is the toggle key's own path (`view-switch start` / `done` in the host log, which PERF's SW-1 reads),
			// for the same reason: no injected key reaches the key watch. It is watched on the terminal page only.
			terminalView.webContents.on('console-message', event => {
				if (event.message === 'ql-test:show-workbench') {
					this.logService.info('QuantLab host: test build: workbench requested by the test driver');
					qlWorkbenchHost.requestWorkbench('test driver');
				} else if (event.message === 'ql-test:toggle') {
					this.logService.info('QuantLab host: test build: toggle requested by the test driver');
					terminalHost.host.log('test driver toggle requested');
					qlWorkbenchHost.requestToggle('test driver toggle');
				} else if (event.message === 'ql-test:overlay-hide') {
					// O4's NEGATIVE (PLAN-FINAL 3.5): the open overlay is hidden natively, so the composited capture must FAIL
					const overlay = terminalHost.view('overlay');
					if (!overlay) {
						throw new Error('QuantLab host (DRIVER): ql-test:overlay-hide: the overlay is not open');
					}
					overlay.setVisible(false);
					this.logService.info('QuantLab host: test build: the overlay view was hidden by the test driver (O4 negative)');
				} else if (event.message.startsWith('ql-test:run-action ')) {
					// Package row A4 (review c2 M5): the driver runs ONE workbench command by id, sent as a menu item's is
					// (`vscode:runAction`): a new untitled file, then `type`, make an editor dirty without a key reaching the page.
					// The message is `ql-test:run-action {"id":"...","args":[...]}`. The workbench must exist already.
					const request: { id?: unknown; args?: unknown } = JSON.parse(event.message.slice('ql-test:run-action '.length));
					const workbenchView = terminalHost.view('workbench');
					if (typeof request.id !== 'string' || (request.args !== undefined && !Array.isArray(request.args))) {
						throw new Error(`QuantLab host (DRIVER): ql-test:run-action: expected {"id": string, "args"?: array}, got ${event.message}`);
					}
					if (!workbenchView) {
						throw new Error(`QuantLab host (DRIVER): ql-test:run-action ${request.id}: there is no workbench view`);
					}
					workbenchView.webContents.send('vscode:runAction', { id: request.id, from: 'menu', args: request.args });
					this.logService.info(`QuantLab host: test build: workbench action ${request.id} sent by the test driver`);
					terminalHost.host.log(`test driver action sent id=${request.id}`);
				} else if (event.message === 'ql-test:process-roles') {
					// Package rows A5a-c and the per-process egress capture: which OS process has which role, as the main process
					// knows it (the argv does not tell the utility processes apart; no renderer pid is logged). Format: processRoles.ts.
					const lines = qlProcessRoleLines({
						mainPid: process.pid,
						views: terminalHost.viewRecords().map(record => {
							const view = terminalHost.view(record.name);
							if (!view) {
								throw new Error(`QuantLab host (DRIVER): ql-test:process-roles: the registered view ${record.name} is not in the window`);
							}

							return { name: record.name, pid: view.webContents.getOSProcessId() };
						}),
						utilities: UtilityProcess.getAll(),
						metrics: app.getAppMetrics()
					});
					for (const line of lines) {
						this.logService.info(`QuantLab host: test build: ${line}`);
					}
					terminalHost.host.log(`test driver process roles written lines=${lines.length}`);
				}
			});
			// A console message sent before this line reached no listener (measured: PERF's test-toggle on package 10 was lost when
			// evaluated at the page's load). A driver or probe waits for this line on stderr before it asks.
			terminalHost.host.log('test driver routes ready');
		}

		// What the launch itself asked to open (files, folders, a protocol link) is a first use now, never dropped
		const launchRequestCause = this.qlLaunchRequestCause(initialProtocolUrls);
		if (launchRequestCause) {
			qlWorkbenchHost.requestWorkbench(launchRequestCause);
		}

		// Quit policy: the terminal window is the only window and is not a CodeWindow, so the lifecycle
		// service's own `window-all-closed` listener (registered when the phase became `Ready`, thus before
		// these) quits on macOS only when a quit was already requested. The host's policy is the light host's:
		// closing the window quits, on every platform. `app.quit()` leads to `before-quit` and `will-quit`,
		// where the lifecycle service fires its shutdown events (see `LifecycleMainService#registerListeners`).
		// QuantLab host (U5): once a workbench CodeWindow exists this stays right, because the host window is held open
		// (`QlWorkbenchHost#onHostWindowClose`) until the workbench's unload handshake is over and its window has closed, so
		// `window-all-closed` can only fire after the workbench is gone.
		//
		// It quits ONLY when the lifecycle service's listener did not. Electron's `app.quit()` is not idempotent across a
		// prevented `will-quit`: the service prevents the first `will-quit` (a `once` listener) to run its shutdown joiners
		// (the storage databases among them), and a second `app.quit()` in the same `window-all-closed` raises a second
		// `will-quit` that nobody prevents, so the process ends under the joiners (measured on package 7: `quit` 14 ms after
		// `will-quit - begin`, no joiner of the storage ended, the main aborted in vscode-sqlite3.node; folds/HOST/QUIT-EXIT-FIX.md).
		// The service's listener quits when a quit was requested or off macOS, so this one quits in the remaining case.
		app.on('window-all-closed', () => {
			if (isMacintosh && !this.lifecycleMainService.quitRequested) {
				terminalHost.windowAllClosed();
			}
		});
		app.on('quit', (_event, exitCode) => terminalHost.noteQuit(exitCode));

		return true;
	}

	// QuantLab host (U5): what the launch itself asked to open: files or folders on the command line, a macOS open-file
	// received before start, or a protocol link. It is a first use at launch (the workbench opens for it).
	private qlLaunchRequestCause(initialProtocolUrls: IInitialProtocolUrls | undefined): string | undefined {
		const args = this.environmentMainService.args;
		const macOpenFiles: string[] = (global as { macOpenFiles?: string[] }).macOpenFiles ?? [];
		if (args._.length > 0 || !!args['folder-uri'] || !!args['file-uri'] || macOpenFiles.length > 0) {
			return 'launch arguments';
		}

		if ((initialProtocolUrls?.openables.length ?? 0) + (initialProtocolUrls?.urls.length ?? 0) > 0) {
			return 'launch protocol url';
		}

		return undefined;
	}

	// QuantLab host (U5): `initServices` registered a `QlDialogMainService`; the host needs it as itself
	private requireQlDialogMainService(service: IDialogMainService): QlDialogMainService {
		if (!(service instanceof QlDialogMainService)) {
			throw new Error('QuantLab host (U5): IDialogMainService is not the QlDialogMainService (initServices)');
		}

		return service;
	}

	// QuantLab host (review c1 M8): `initServices` registered the `EncryptionMainService`; the host needs it as itself to
	// report the terminal host's Keychain phase to it
	private requireQlEncryptionMainService(service: IEncryptionMainService): EncryptionMainService {
		if (!(service instanceof EncryptionMainService)) {
			throw new Error('QuantLab host (M8): IEncryptionMainService is not the EncryptionMainService (initServices)');
		}

		return service;
	}

	// QuantLab host (U3/U5): the stock first-window flow; the host runs it through the gate on the first use of the workbench
	// (`QlWorkbenchHost.openWorkbench`, in `startQlTerminalHost`). `protected`: only called from a closure there.
	protected async openFirstWindow(accessor: ServicesAccessor, initialProtocolUrls: IInitialProtocolUrls | undefined): Promise<ICodeWindow[]> {
		const windowsMainService = this.windowsMainService = accessor.get(IWindowsMainService);
		this.auxiliaryWindowsMainService = accessor.get(IAuxiliaryWindowsMainService);

		const context = isLaunchedFromCli(process.env) ? OpenContext.CLI : OpenContext.DESKTOP;
		const args = this.environmentMainService.args;

		// First check for windows from protocol links to open
		if (initialProtocolUrls) {

			// Openables can open as windows directly
			if (initialProtocolUrls.openables.length > 0) {
				return windowsMainService.open({
					context,
					cli: args,
					urisToOpen: initialProtocolUrls.openables,
					gotoLineMode: true,
					initialStartup: true
					// remoteAuthority: will be determined based on openables
				});
			}

			// Protocol links with `windowId=_blank` on startup
			// should be handled in a special way:
			// We take the first one of these and open an empty
			// window for it. This ensures we are not restoring
			// all windows of the previous session.
			// If there are any more URLs like these, they will
			// be handled from the URL listeners installed later.

			if (initialProtocolUrls.urls.length > 0) {
				for (const protocolUrl of initialProtocolUrls.urls) {
					const params = new URLSearchParams(protocolUrl.uri.query);
					if (params.get('windowId') === '_blank') {

						// It is important here that we remove `windowId=_blank` from
						// this URL because here we open an empty window for it.

						params.delete('windowId');
						protocolUrl.originalUrl = protocolUrl.uri.toString(true);
						protocolUrl.uri = protocolUrl.uri.with({ query: params.toString() });

						return windowsMainService.open({
							context,
							cli: args,
							forceNewWindow: true,
							forceEmpty: true,
							gotoLineMode: true,
							initialStartup: true
							// remoteAuthority: will be determined based on openables
						});
					}
				}
			}
		}

		const macOpenFiles: string[] = (global as { macOpenFiles?: string[] }).macOpenFiles ?? [];
		const hasCliArgs = args._.length;
		const hasFolderURIs = !!args['folder-uri'];
		const hasFileURIs = !!args['file-uri'];
		const noRecentEntry = args['skip-add-to-recently-opened'] === true;
		const waitMarkerFileURI = args.wait && args.waitMarkerFilePath ? URI.file(args.waitMarkerFilePath) : undefined;
		const remoteAuthority = args.remote || undefined;
		const forceProfile = args.profile;
		const forceTempProfile = args['profile-temp'];

		// Started without file/folder arguments
		if (!hasCliArgs && !hasFolderURIs && !hasFileURIs) {

			// Force new window
			if (args['new-window'] || forceProfile || forceTempProfile) {
				return windowsMainService.open({
					context,
					cli: args,
					forceNewWindow: true,
					forceEmpty: true,
					noRecentEntry,
					waitMarkerFileURI,
					initialStartup: true,
					remoteAuthority,
					forceProfile,
					forceTempProfile
				});
			}

			// mac: open-file event received on startup
			if (macOpenFiles.length) {
				return windowsMainService.open({
					context: OpenContext.DOCK,
					cli: args,
					urisToOpen: macOpenFiles.map(path => {
						path = normalizeNFC(path); // macOS only: normalize paths to NFC form

						return (hasWorkspaceFileExtension(path) ? { workspaceUri: URI.file(path) } : { fileUri: URI.file(path) });
					}),
					noRecentEntry,
					waitMarkerFileURI,
					initialStartup: true,
					// remoteAuthority: will be determined based on macOpenFiles
				});
			}
		}

		// default: read paths from cli
		return windowsMainService.open({
			context,
			cli: args,
			forceNewWindow: args['new-window'],
			diffMode: args.diff,
			mergeMode: args.merge,
			noRecentEntry,
			waitMarkerFileURI,
			gotoLineMode: args.goto,
			initialStartup: true,
			remoteAuthority,
			forceProfile,
			forceTempProfile
		});
	}

	private afterWindowOpen(): void {

		// Windows: mutex
		this.installMutex();

		// Remote Authorities
		protocol.registerHttpProtocol(Schemas.vscodeRemoteResource, (request, callback) => {
			callback({
				url: request.url.replace(/^vscode-remote-resource:/, 'http:'),
				method: request.method
			});
		});

		// Start to fetch shell environment (if needed) after window has opened
		// Since this operation can take a long time, we want to warm it up while
		// the window is opening.
		// We also show an error to the user in case this fails.
		this.resolveShellEnvironment(this.environmentMainService.args, process.env, true);

		// Crash reporter
		this.updateCrashReporterEnablement();

		// macOS: rosetta translation warning
		if (isMacintosh && app.runningUnderARM64Translation) {
			this.windowsMainService?.sendToFocused('vscode:showTranslatedBuildWarning');
		}
	}

	private async installMutex(): Promise<void> {
		const win32MutexName = this.productService.win32MutexName;
		if (isWindows && win32MutexName) {
			try {
				const WindowsMutex = await import('@vscode/windows-mutex');
				const mutex = new WindowsMutex.Mutex(win32MutexName);
				Event.once(this.lifecycleMainService.onWillShutdown)(() => mutex.release());
			} catch (error) {
				this.logService.error(error);
			}
		}
	}

	private async resolveShellEnvironment(args: NativeParsedArgs, env: IProcessEnvironment, notifyOnError: boolean): Promise<typeof process.env> {
		try {
			return await getResolvedShellEnv(this.configurationService, this.logService, args, env);
		} catch (error) {
			const errorMessage = toErrorMessage(error);
			if (notifyOnError) {
				this.windowsMainService?.sendToFocused('vscode:showResolveShellEnvError', errorMessage);
			} else {
				this.logService.error(errorMessage);
			}
		}

		return {};
	}

	private async updateCrashReporterEnablement(): Promise<void> {

		// If enable-crash-reporter argv is undefined then this is a fresh start,
		// based on `telemetry.enableCrashreporter` settings, generate a UUID which
		// will be used as crash reporter id and also update the json file.

		try {
			const argvContent = await this.fileService.readFile(this.environmentMainService.argvResource);
			const argvString = argvContent.value.toString();
			const argvJSON = parse<{ 'enable-crash-reporter'?: boolean }>(argvString);
			const telemetryLevel = getTelemetryLevel(this.configurationService);
			const enableCrashReporter = telemetryLevel >= TelemetryLevel.CRASH;

			// Initial startup
			if (argvJSON['enable-crash-reporter'] === undefined) {
				const additionalArgvContent = [
					'',
					'	// Allows to disable crash reporting.',
					'	// Should restart the app if the value is changed.',
					`	"enable-crash-reporter": ${enableCrashReporter},`,
					'',
					'	// Unique id used for correlating crash reports sent from this instance.',
					'	// Do not edit this value.',
					`	"crash-reporter-id": "${generateUuid()}"`,
					'}'
				];
				const newArgvString = argvString.substring(0, argvString.length - 2).concat(',\n', additionalArgvContent.join('\n'));

				await this.fileService.writeFile(this.environmentMainService.argvResource, VSBuffer.fromString(newArgvString));
			}

			// Subsequent startup: update crash reporter value if changed
			else {
				const newArgvString = argvString.replace(/"enable-crash-reporter": .*,/, `"enable-crash-reporter": ${enableCrashReporter},`);
				if (newArgvString !== argvString) {
					await this.fileService.writeFile(this.environmentMainService.argvResource, VSBuffer.fromString(newArgvString));
				}
			}
		} catch (error) {
			this.logService.error(error);

			// Inform the user via notification
			this.windowsMainService?.sendToFocused('vscode:showArgvParseWarning');
		}
	}

	private eventuallyAfterWindowOpen(): void {

		// Validate Device ID is up to date (delay this as it has shown significant perf impact)
		// Refs: https://github.com/microsoft/vscode/issues/234064
		validateDevDeviceId(this.stateService, this.logService);
	}
}

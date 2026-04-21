/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/qicSkin.css';

import { localize } from '../../../../nls.js';
import { $, addDisposableListener } from '../../../../base/browser/dom.js';
import { IAction } from '../../../../base/common/actions.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { getWindow } from '../../../../base/browser/dom.js';
import { editorBackground } from '../../../../platform/theme/common/colorRegistry.js';
import { inputBackground } from '../../../../platform/theme/common/colors/inputColors.js';
import { EDITOR_DRAG_AND_DROP_BACKGROUND, SIDE_BAR_FOREGROUND } from '../../../common/theme.js';
import { Memento } from '../../../common/memento.js';
import { IQicService } from '../common/qicService.js';
import { QIC_PANEL_VISIBLE_CONTEXT, QIC_CONNECTION_MODE_CONTEXT, QIC_SETTINGS, QIC_SECRET_KEYS } from '../common/constants.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQicChatService } from './qicChatService.js';
import { QicHeaderControl } from './qicHeaderControl.js';
import { QicWelcomeOverlay } from './qicWelcomeOverlay.js';
import { svgEl, svgPath, createBrainIcon } from './qicIcons.js';

// Chat widget imports
import { ChatWidget } from '../../chat/browser/widget/chatWidget.js';
import { IChatService, IChatModelReference } from '../../chat/common/chatService/chatService.js';
import { IChatAgentService } from '../../chat/common/participants/chatAgents.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';

const QIC_PANEL_VISIBLE = new RawContextKey<boolean>(QIC_PANEL_VISIBLE_CONTEXT, false);
const QIC_CONNECTION_MODE = new RawContextKey<string>(QIC_CONNECTION_MODE_CONTEXT, 'deltaplus');

function createConnectionIcon(): SVGSVGElement {
	const svg = svgEl(16, 16, '0 0 308.248 308.248');
	svg.appendChild(svgPath('M277.812,222.656v-50.413c0-7.444-6.056-13.5-13.5-13.5H161.624v-43.436c25.513-3.652,45.191-25.642,45.191-52.148c0-29.054-23.637-52.691-52.691-52.691c-29.054,0-52.691,23.638-52.691,52.691c0,26.507,19.678,48.496,45.191,52.148v43.436H43.936c-7.444,0-13.5,6.056-13.5,13.5v50.413C13.099,226.147,0,241.494,0,259.845c0,20.918,17.018,37.935,37.936,37.935c20.918,0,37.937-17.017,37.937-37.935c0-18.351-13.098-33.697-30.437-37.19v-48.912h101.188v48.913c-17.338,3.491-30.436,18.838-30.436,37.189c0,20.918,17.018,37.935,37.936,37.935c20.918,0,37.936-17.017,37.936-37.935c0-18.351-13.098-33.697-30.436-37.189v-48.913h101.188v48.912c-17.338,3.492-30.437,18.839-30.437,37.19c0,20.918,17.018,37.935,37.937,37.935c20.918,0,37.936-17.017,37.936-37.935C308.248,241.494,295.149,226.147,277.812,222.656z M116.433,63.159c0-20.783,16.908-37.691,37.691-37.691c20.783,0,37.691,16.908,37.691,37.691s-16.908,37.691-37.691,37.691C133.341,100.851,116.433,83.942,116.433,63.159z M60.873,259.845c0,12.646-10.289,22.935-22.937,22.935C25.289,282.78,15,272.491,15,259.845c0-12.648,10.289-22.937,22.936-22.937C50.583,236.908,60.873,247.197,60.873,259.845z M177.06,259.845c0,12.646-10.289,22.935-22.936,22.935c-12.647,0-22.936-10.289-22.936-22.935c0-12.648,10.289-22.937,22.936-22.937C166.771,236.908,177.06,247.197,177.06,259.845z M270.312,282.78c-12.647,0-22.937-10.289-22.937-22.935c0-12.648,10.289-22.937,22.937-22.937c12.647,0,22.936,10.289,22.936,22.937C293.248,272.491,282.959,282.78,270.312,282.78z', 'currentColor'));
	return svg;
}


type QicConnectionType = 'deltaplus' | 'byok' | 'localai';
type QicReasoningLevel = 'medium' | 'high' | 'veryhigh';

interface IQicViewPaneState {
	sessionId?: string;
}

/**
 * QIC Chat ViewPane — hosts the native ChatWidget (Phase 1 MVP).
 *
 * Replaces the previous webview-based implementation. The ChatWidget
 * provides native theming, virtual scrolling, and zero serialization
 * overhead. QIC's backend (AgentOrchestrator) is connected via the
 * QicChatAgent participant registered in qicChatAgent.ts.
 */
export class QicChatViewPane extends ViewPane {

	private _widget: ChatWidget | undefined;
	private _widgetRendered = false; // true once renderBody() has created the widget
	private _headerControl: QicHeaderControl | undefined;
	private readonly _modelRef = this._register(new MutableDisposable<IChatModelReference>());
	private readonly _memento: Memento<IQicViewPaneState>;
	private readonly _viewState: IQicViewPaneState;
	private _lastDimensions: { height: number; width: number } | undefined;

	// Input toolbar state
	private _selectedConnection: QicConnectionType = 'deltaplus';
	private _selectedReasoning: QicReasoningLevel = 'medium';
	private _reasoningBtn: HTMLButtonElement | undefined;
	private _connectionBtn: HTMLButtonElement | undefined;
	private _connectionModeKey: ReturnType<typeof QIC_CONNECTION_MODE.bindTo> | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IQicService private readonly qicService: IQicService,
		@IQicChatService private readonly qicChatService: IQicChatService,
		@IChatService private readonly chatService: IChatService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// Memento for persisting session across reloads
		this._memento = new Memento('qic-chat-view', this.storageService);
		this._viewState = this._memento.getMemento(StorageScope.WORKSPACE, StorageTarget.MACHINE);

		// Toggle context key when panel visibility changes
		const panelVisibleKey = QIC_PANEL_VISIBLE.bindTo(contextKeyService);
		this._register(this.onDidChangeBodyVisibility(visible => {
			panelVisibleKey.set(visible);
			this._widget?.setVisible(visible);

			// Re-apply layout when becoming visible again (e.g. fullscreen → window transition)
			// The widget needs an explicit layout() call after setVisible(true) to recover dimensions
			if (visible && this._lastDimensions) {
				this.layoutBody(this._lastDimensions.height, this._lastDimensions.width);
			}
		}));

		// Listen for agent registration — only attempt restore if the widget is
		// already rendered. If not, renderBody() will call _tryRestoreSession() directly.
		this._register(this.chatAgentService.onDidChangeAgents(() => {
			if (this._widgetRendered) {
				this._tryRestoreSession();
			}
		}));
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);

		const container = parent;
		container.classList.add('qic-chat-viewpane');

		// Header bar (before chat widget)
		this._headerControl = this._register(
			this.instantiationService.createInstance(QicHeaderControl, container, {
				newChat: () => this._clear(),
			})
		);

		this._createChatWidget(container);

		// Welcome overlay (after chat widget so it layers on top)
		if (this._widget) {
			this._register(new QicWelcomeOverlay(container, this._widget));
		}

		// Mark widget as rendered before attempting restore so the onDidChangeAgents
		// listener knows the widget is available if agent registers concurrently.
		this._widgetRendered = true;
		this._tryRestoreSession();

		this.logService.info('[QicChatViewPane] Native ChatWidget rendered');
	}

	private _createChatWidget(parent: HTMLElement): void {
		const chatContainer = parent.appendChild($('.qic-chat-controls-container'));

		// Create editor overflow node for autocompletions
		const editorOverflowWidgetsDomNode = this.layoutService.getContainer(getWindow(chatContainer)).appendChild($('.qic-chat-editor-overflow.monaco-editor'));
		this._register(toDisposable(() => editorOverflowWidgetsDomNode.remove()));

		// Create a scoped instantiation service for the chat widget
		const scopedInstantiationService = this._register(
			this.instantiationService.createChild(
				new ServiceCollection([IContextKeyService, this.scopedContextKeyService])
			)
		);

		// Instantiate the native ChatWidget
		this._widget = this._register(scopedInstantiationService.createInstance(
			ChatWidget,
			ChatAgentLocation.Chat,
			{ viewId: this.id },
			{
				autoScroll: (mode: ChatModeKind) => mode !== ChatModeKind.Ask,
				renderFollowups: true,
				supportsFileReferences: true,
				clear: () => this._clear(),
				rendererOptions: {
					renderTextEditsAsSummary: (_uri: any) => true,
					referencesExpandedWhenEmptyResponse: false,
					progressMessageAtBottomOfResponse: (mode: ChatModeKind) => mode !== ChatModeKind.Ask,
				},
				editorOverflowWidgetsDomNode,
				enableImplicitContext: true,
				enableWorkingSet: 'explicit',
				supportsChangingModes: false,
			},
			{
				listForeground: SIDE_BAR_FOREGROUND,
				listBackground: editorBackground,
				overlayBackground: EDITOR_DRAG_AND_DROP_BACKGROUND,
				inputEditorBackground: inputBackground,
				resultEditorBackground: editorBackground,
			}
		));
		this._widget.render(chatContainer);
		this._widget.setVisible(this.isBodyVisible());

		this._injectInputActions(chatContainer);
	}

	private _injectInputActions(chatContainer: HTMLElement): void {
		// Fast path: toolbars already in DOM (the common case — no observer needed)
		const toolbars = chatContainer.querySelector('.chat-input-toolbars');
		if (toolbars) {
			this._doInjectActions(chatContainer, toolbars as HTMLElement);
			return;
		}

		// RAF path: ChatWidget may append toolbars asynchronously. Check after one frame.
		const win = getWindow(chatContainer);
		const rafHandle = win.requestAnimationFrame(() => {
			const tb = chatContainer.querySelector('.chat-input-toolbars');
			if (tb) {
				this._doInjectActions(chatContainer, tb as HTMLElement);
				return;
			}
			// Fallback observer: only created if both synchronous and rAF checks miss.
			// Guaranteed to disconnect on success or on pane dispose.
			const observer = new MutationObserver((_mutations, obs) => {
				const found = chatContainer.querySelector('.chat-input-toolbars');
				if (found) {
					obs.disconnect();
					this._doInjectActions(chatContainer, found as HTMLElement);
				}
			});
			observer.observe(chatContainer, { childList: true, subtree: true });
			this._register(toDisposable(() => observer.disconnect()));
		});
		this._register(toDisposable(() => win.cancelAnimationFrame(rafHandle)));
	}

	private _doInjectActions(chatContainer: HTMLElement, toolbars: HTMLElement): void {
		const actionsContainer = $('div.qic-input-actions');

		// Connection icon button — always visible
		this._connectionBtn = this._createIconButton(actionsContainer, 'Connect', createConnectionIcon());
		this._register(addDisposableListener(this._connectionBtn, 'click', (e) => {
			e.stopPropagation(); // Prevent native toolbars handler from stealing focus
			this._showConnectionMenu();
		}));

		// Reasoning icon button — hidden unless deltaplus is selected
		this._reasoningBtn = this._createIconButton(actionsContainer, 'Reasoning', createBrainIcon());
		// visible by default since default connection is deltaplus
		this._register(addDisposableListener(this._reasoningBtn, 'click', (e) => {
			e.stopPropagation(); // Prevent native toolbars handler from stealing focus
			this._showReasoningMenu();
		}));

		// Bind connection mode context key
		this._connectionModeKey = QIC_CONNECTION_MODE.bindTo(this.scopedContextKeyService);
		this._connectionModeKey.set(this._selectedConnection);

		// Prepend as first child so CSS :first-child { margin-right: auto } applies
		toolbars.prepend(actionsContainer);
	}

	private _createIconButton(parent: HTMLElement, tooltip: string, iconSvg: SVGSVGElement): HTMLButtonElement {
		const btn = parent.appendChild($('button.qic-input-icon-btn')) as HTMLButtonElement;
		btn.type = 'button';
		btn.title = tooltip;
		btn.setAttribute('aria-label', tooltip);
		btn.appendChild(iconSvg);
		return btn;
	}

	private _showConnectionMenu(): void {
		if (!this._connectionBtn) {
			return;
		}
		const items: { id: QicConnectionType; label: string }[] = [
			{ id: 'deltaplus', label: 'Delta Plus Servers' },
			{ id: 'byok', label: 'BYOK' },
			{ id: 'localai', label: 'Local AI' },
		];
		const actions: IAction[] = items.map(item => ({
			id: `qic.connect.${item.id}`,
			label: item.label,
			tooltip: '',
			class: this._selectedConnection === item.id ? 'checked' : undefined,
			enabled: true,
			checked: this._selectedConnection === item.id,
			run: () => { this._onConnectionChanged(item.id); },
		}));
		this.contextMenuService.showContextMenu({
			getAnchor: () => this._connectionBtn!,
			getActions: () => actions,
		});
	}

	private _showReasoningMenu(): void {
		if (!this._reasoningBtn) {
			return;
		}
		const items: { id: QicReasoningLevel; label: string }[] = [
			{ id: 'medium', label: 'Medium' },
			{ id: 'high', label: 'High' },
			{ id: 'veryhigh', label: 'Very High' },
		];
		const actions: IAction[] = items.map(item => ({
			id: `qic.reasoning.${item.id}`,
			label: item.label,
			tooltip: '',
			class: this._selectedReasoning === item.id ? 'checked' : undefined,
			enabled: true,
			checked: this._selectedReasoning === item.id,
			run: () => { this._onReasoningChanged(item.id); },
		}));
		this.contextMenuService.showContextMenu({
			getAnchor: () => this._reasoningBtn!,
			getActions: () => actions,
		});
	}

	private static readonly CONNECTION_MODE_MAP: Record<QicConnectionType, string> = {
		'deltaplus': 'server',
		'byok': 'byok',
		'localai': 'local',
	};

	private async _onConnectionChanged(connection: QicConnectionType): Promise<void> {
		this._selectedConnection = connection;
		// Update context key
		this._connectionModeKey?.set(connection);
		// Toggle reasoning button visibility
		if (this._reasoningBtn) {
			this._reasoningBtn.style.display = connection === 'deltaplus' ? '' : 'none';
		}

		// Update the configuration setting so the gateway will use the right provider
		const newMode = QicChatViewPane.CONNECTION_MODE_MAP[connection];
		const currentMode = this.configurationService.getValue<string>(QIC_SETTINGS.CONNECTION_MODE);
		if (newMode === currentMode) {
			return;
		}

		// For Delta Plus: ensure we have a token before switching
		if (connection === 'deltaplus') {
			const existing = await this.secretStorageService.get(QIC_SECRET_KEYS.DELTAPLUS_ACCESS_TOKEN);
			if (!existing) {
				await this._loginToDeltaPlus();
			}
		}

		await this.configurationService.updateValue(QIC_SETTINGS.CONNECTION_MODE, newMode);
		// The hot-swap listener in qic.contribution.ts will prompt for reload
	}

	/**
	 * Ensure a Delta Plus token exists when switching to server mode.
	 * If the user has signed in via the QuantLab auth provider the token will already
	 * be in SecretStorage (written by ServerApiClient.persistTokens). If not, prompt
	 * the user to sign in rather than falling back to demo credentials.
	 */
	private async _loginToDeltaPlus(): Promise<void> {
		const existing = await this.secretStorageService.get(QIC_SECRET_KEYS.DELTAPLUS_ACCESS_TOKEN);
		if (existing) {
			// Token already present — adapter will pick it up via onDidChangeSecret.
			return;
		}
		this.logService.info('[QicPanel] No Delta Plus token — prompting user to sign in');
		this.notificationService.info(
			localize('qic.signInRequired', 'Sign in to your Delta Plus account to use server mode. Use the Accounts menu or run "QuantLab: Sign In to Delta Plus".')
		);
	}

	private _onReasoningChanged(level: QicReasoningLevel): void {
		this._selectedReasoning = level;
	}

	/**
	 * Try to restore a previous session or create a new one.
	 */
	private _tryRestoreSession(): void {
		const qicAgent = this.chatAgentService.getAgent('qic');
		if (!qicAgent) {
			this.logService.trace('[QicChatViewPane] _tryRestoreSession: qic agent not yet registered');
			return;
		}
		if (!this._widget) {
			this.logService.trace('[QicChatViewPane] _tryRestoreSession: widget not yet rendered');
			return;
		}
		if (this._widget.viewModel) {
			return; // Already initialized
		}

		// Create a new chat session — the QIC agent is the default agent
		// so it will be automatically selected
		const modelRef = this.chatService.startSession(ChatAgentLocation.Chat, undefined);
		if (modelRef) {
			this._modelRef.value = modelRef;
			this._widget.setModel(modelRef.object);
			this._widget.setInputPlaceholder('Ask Orion anything...');
		}
	}

	/**
	 * Clear the current session and start a new one.
	 */
	private async _clear(): Promise<void> {
		// Release the old model reference (disposes the session)
		this._modelRef.clear();

		// Start a new session
		const modelRef = this.chatService.startSession(ChatAgentLocation.Chat, undefined);
		if (modelRef && this._widget) {
			this._modelRef.value = modelRef;
			this._widget.setModel(modelRef.object);
			this._widget.setInputPlaceholder('Ask Orion anything...');
		}

		// Also clear QIC backend conversation state
		await this.qicChatService.startNewConversation();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);

		this._lastDimensions = { height, width };

		const headerHeight = this._headerControl?.getHeight() ?? 0;
		const widgetHeight = Math.max(0, height - headerHeight);
		this._widget?.layout(widgetHeight, width);
	}

	override focus(): void {
		super.focus();
		this._widget?.focusInput();
	}

	override saveState(): void {
		// Persist session ID for restore
		if (this._widget?.viewModel) {
			this._viewState.sessionId = this._widget.viewModel.sessionResource.toString();
		}
		this._memento.saveMemento();
		super.saveState();
	}

	override dispose(): void {
		// Reject any pending dialogs in the QIC UI service
		const runtime = this.qicService.getRuntime();
		if (runtime?.uiService) {
			runtime.uiService.rejectAllPendingDialogs();
		}
		super.dispose();
	}
}

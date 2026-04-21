/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// @ts-nocheck
// QIC chat webview logic (Audit I-7, IV-AO7, XI-SV5).

(function () {
	'use strict';

	// VS Code API — reuse the instance acquired by main.js
	const vscode = window.vscode || acquireVsCodeApi();

	// DOM references
	const messagesEl = document.getElementById('messages');
	const inputEl = document.getElementById('chat-input');
	const sendBtn = document.getElementById('send-btn');
	const cancelBtn = document.getElementById('cancel-btn');
	const loadingEl = document.getElementById('loading');
	const loadingText = document.getElementById('loading-text');
	const firstRunEl = document.getElementById('first-run');
	const emptyState = document.getElementById('empty-state');

	// Header elements
	const connectionStatus = document.getElementById('connection-status');
	const connectionStatusDot = connectionStatus ? connectionStatus.querySelector('.qic-status-dot') : null;
	const connectionStatusText = connectionStatus ? connectionStatus.querySelector('.qic-status-text') : null;
	const providerSelect = document.getElementById('provider-select');
	const costDisplay = document.getElementById('cost-display');
	const contextBtn = document.getElementById('context-btn');
	const degradationBanner = document.getElementById('degradation-banner');
	const degradationText = document.getElementById('degradation-text');
	const recoveryBtn = document.getElementById('recovery-btn');
	const newChatBtn = document.getElementById('new-chat-btn');
	const checkpointBtn = document.getElementById('checkpoint-btn');
	const settingsBtn = document.getElementById('settings-btn');

	// Context panel
	const contextPanel = document.getElementById('context-panel');
	const contextList = document.getElementById('context-list');
	const closeContextBtn = document.getElementById('close-context-btn');
	const addFileBtn = document.getElementById('add-file-btn');
	const clearContextBtn = document.getElementById('clear-context-btn');

	// Input elements
	const inputContext = document.getElementById('input-context');
	const activeFileTag = document.getElementById('active-file-tag');
	const activeFileName = document.getElementById('active-file-name');
	const attachBtn = document.getElementById('attach-btn');
	const modelIndicator = document.getElementById('current-model');
	const tokenEstimate = document.getElementById('token-estimate');

	// Checkpoint panel
	const checkpointPanel = document.getElementById('checkpoint-panel');
	const checkpointList = document.getElementById('checkpoint-list');
	const closeCheckpointBtn = document.getElementById('close-checkpoint-btn');
	const createCheckpointBtn = document.getElementById('create-checkpoint-btn');

	// Settings panel
	const settingsPanel = document.getElementById('settings-panel');
	const closeSettingsBtn = document.getElementById('close-settings-btn');
	const settingsProvider = document.getElementById('settings-provider');
	const settingsModel = document.getElementById('settings-model');
	const settingsPython = document.getElementById('settings-python');
	const consentEmbeddingToggle = document.getElementById('consent-embedding-toggle');
	const consentTelemetryToggle = document.getElementById('consent-telemetry-toggle');


	// Quota elements
	const quotaText = document.getElementById('quota-text');
	const quotaFill = document.getElementById('quota-fill');

	// First-run consent
	const consentLlm = document.getElementById('consent-llm');
	const consentEmbeddings = document.getElementById('consent-embeddings');
	const consentTelemetry = document.getElementById('consent-telemetry');
	const getStartedBtn = document.getElementById('get-started-btn');

	// State
	let currentStreamEl = null;
	let isProcessing = false;
	let currentDegradationLevel = 0;
	let sessionCost = 0;
	let contextFiles = [];
	let currentProvider = 'auto';
	let currentModel = 'gpt-4o-mini';

	// --- First-run consent handling ---

	if (getStartedBtn && consentLlm && consentEmbeddings && firstRunEl) {
		var updateGetStartedBtn = function () {
			getStartedBtn.disabled = !consentLlm.checked;
		};

		consentLlm.addEventListener('change', updateGetStartedBtn);
		consentEmbeddings.addEventListener('change', updateGetStartedBtn);

		getStartedBtn.addEventListener('click', function () {
			vscode.postMessage({
				type: 'first-run-consent',
				consents: {
					llm: consentLlm.checked,
					embeddings: consentEmbeddings.checked,
					telemetry: consentTelemetry ? consentTelemetry.checked : false
				}
			});
			firstRunEl.style.display = 'none';
			document.getElementById('chat-container').style.display = 'flex';
		});
	}

	// --- Provider selection handler ---

	if (providerSelect) {
		providerSelect.addEventListener('change', function () {
			currentProvider = this.value;
			vscode.postMessage({ type: 'change-provider', provider: currentProvider });
			updateModelIndicator();
		});
	}

	// --- Context panel handlers ---

	if (contextBtn) {
		contextBtn.addEventListener('click', function () {
			var wasOpen = contextPanel && contextPanel.style.display !== 'none';
			closeAllPanels();
			if (contextPanel && !wasOpen) {
				contextPanel.style.display = 'block';
				vscode.postMessage({ type: 'request-context-files' });
			}
		});
	}

	if (closeContextBtn) {
		closeContextBtn.addEventListener('click', function () {
			if (contextPanel) { contextPanel.style.display = 'none'; }
		});
	}

	if (addFileBtn) {
		addFileBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'add-current-file-to-context' });
		});
	}

	if (clearContextBtn) {
		clearContextBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'clear-context' });
			contextFiles = [];
			renderContextFiles();
		});
	}

	if (attachBtn) {
		attachBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'add-current-file-to-context' });
		});
	}

	// --- Quick action buttons ---

	var quickBtns = document.querySelectorAll('.qic-quick-btn');
	for (var i = 0; i < quickBtns.length; i++) {
		quickBtns[i].addEventListener('click', function () {
			var prompt = this.dataset.prompt;
			if (prompt) {
				hideEmptyState();
				appendUserMessage(prompt);
				vscode.postMessage({ type: 'user-message', text: prompt });
			}
		});
	}

	// --- Header button handlers ---

	if (newChatBtn) {
		newChatBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'new-chat' });
			showEmptyState();
			sessionCost = 0;
			updateCostDisplay();
		});
	}

	if (settingsBtn) {
		settingsBtn.addEventListener('click', function () {
			var wasOpen = settingsPanel && settingsPanel.style.display !== 'none';
			closeAllPanels();
			if (settingsPanel && !wasOpen) {
				settingsPanel.style.display = 'block';
			}
		});
	}

	if (closeSettingsBtn) {
		closeSettingsBtn.addEventListener('click', function () {
			if (settingsPanel) { settingsPanel.style.display = 'none'; }
		});
	}

	if (consentEmbeddingToggle) {
		consentEmbeddingToggle.addEventListener('change', function () {
			vscode.postMessage({ type: 'toggle-consent', boundary: 'embedding', granted: this.checked });
		});
	}

	if (consentTelemetryToggle) {
		consentTelemetryToggle.addEventListener('change', function () {
			vscode.postMessage({ type: 'toggle-consent', boundary: 'telemetry', granted: this.checked });
		});
	}


	// Helper to close all panels
	function closeAllPanels() {
		if (checkpointPanel) { checkpointPanel.style.display = 'none'; }
		if (settingsPanel) { settingsPanel.style.display = 'none'; }
	}

	if (recoveryBtn) {
		recoveryBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'attempt-recovery' });
		});
	}

	// --- Checkpoint panel handlers ---

	if (checkpointBtn) {
		checkpointBtn.addEventListener('click', function () {
			var wasOpen = checkpointPanel && checkpointPanel.style.display !== 'none';
			closeAllPanels();
			if (checkpointPanel && !wasOpen) {
				checkpointPanel.style.display = 'block';
			}
		});
	}

	if (closeCheckpointBtn) {
		closeCheckpointBtn.addEventListener('click', function () {
			if (checkpointPanel) {
				checkpointPanel.style.display = 'none';
			}
		});
	}

	if (createCheckpointBtn) {
		createCheckpointBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'create-checkpoint' });
		});
	}

	// --- Input handling ---

	if (inputEl) {
		inputEl.addEventListener('keydown', function (e) {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendMessage();
			}
			// Shift+Enter = newline (default textarea behavior)
		});

		// Auto-resize textarea
		inputEl.addEventListener('input', function () {
			this.style.height = 'auto';
			this.style.height = Math.min(this.scrollHeight, 150) + 'px';
		});
	}

	if (sendBtn) { sendBtn.addEventListener('click', sendMessage); }
	if (cancelBtn) {
		cancelBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'cancel-request' });
		});
	}

	function sendMessage() {
		const text = inputEl.value.trim();
		if (!text) { return; }

		appendUserMessage(text);
		vscode.postMessage({ type: 'user-message', text: text });
		inputEl.value = '';
		inputEl.style.height = 'auto';
	}

	// --- Message rendering ---

	function appendUserMessage(text) {
		hideEmptyState();
		const el = document.createElement('div');
		el.className = 'qic-message qic-message-user';
		const content = document.createElement('div');
		content.className = 'qic-message-content';
		content.textContent = text;
		el.appendChild(content);
		addMessageActions(el, 'user', text);
		messagesEl.appendChild(el);
		scrollToBottom();
	}

	function appendAssistantMessage(html) {
		const el = document.createElement('div');
		el.className = 'qic-message qic-message-assistant';
		// Process file references after sanitization
		var sanitized = window.markdownRenderer.sanitizeHtml(html);
		el.innerHTML = window.markdownRenderer.processFileReferences(sanitized);
		addCodeCopyButtons(el);
		messagesEl.appendChild(el);
		scrollToBottom();
		return el;
	}

	function startStreamingMessage() {
		const el = document.createElement('div');
		el.className = 'qic-message qic-message-assistant qic-streaming';
		const textEl = document.createElement('span');
		textEl.className = 'qic-stream-text';
		el.appendChild(textEl);
		const cursor = document.createElement('span');
		cursor.className = 'qic-cursor';
		el.appendChild(cursor);
		messagesEl.appendChild(el);
		currentStreamEl = { container: el, text: textEl, buffer: '' };
		scrollToBottom();
	}

	function appendStreamToken(text) {
		if (!currentStreamEl) {
			startStreamingMessage();
		}
		currentStreamEl.buffer += text;
		const rendered = window.markdownRenderer.renderMarkdown(currentStreamEl.buffer);
		const sanitized = window.markdownRenderer.sanitizeHtml(rendered);
		currentStreamEl.text.innerHTML = window.markdownRenderer.processFileReferences(sanitized);
		scrollToBottom();
	}

	function finalizeStreamingMessage() {
		if (!currentStreamEl) { return; }
		const el = currentStreamEl.container;
		el.classList.remove('qic-streaming');
		const cursor = el.querySelector('.qic-cursor');
		if (cursor) { cursor.remove(); }
		addCodeCopyButtons(el);
		currentStreamEl = null;
	}

	// --- Tool call cards ---

	function renderToolCallStarted(toolCallId, toolName, args) {
		const card = document.createElement('div');
		card.className = 'qic-tool-card';
		card.id = 'tool-' + toolCallId;
		card.innerHTML =
			'<div class="qic-tool-header">' +
			'<span class="qic-tool-icon">&#9881;</span> ' +
			'<span class="qic-tool-name">' + escapeHtml(toolName) + '</span>' +
			'<span class="qic-tool-status">running...</span>' +
			'</div>' +
			'<div class="qic-tool-args"><code>' + escapeHtml(JSON.stringify(args, null, 2)) + '</code></div>';
		messagesEl.appendChild(card);
		scrollToBottom();
	}

	function renderToolCallResult(toolCallId, content, isError) {
		const card = document.getElementById('tool-' + toolCallId);
		if (!card) { return; }
		const status = card.querySelector('.qic-tool-status');
		if (status) {
			status.textContent = isError ? 'failed' : 'completed';
			status.className = 'qic-tool-status ' + (isError ? 'qic-tool-error' : 'qic-tool-success');
		}
		const result = document.createElement('div');
		result.className = 'qic-tool-result' + (isError ? ' qic-tool-result-error' : '');
		result.textContent = content.slice(0, 500);
		card.appendChild(result);
	}

	// --- Diff preview rendering (Prompt 13) ---

	function renderDiffPreview(editScriptHash, previewHtml, filePaths) {
		const card = document.createElement('div');
		card.className = 'qic-diff-card';
		card.innerHTML =
			'<div class="qic-diff-header">Proposed Changes (' + filePaths.length + ' file' + (filePaths.length > 1 ? 's' : '') + ')</div>' +
			'<div class="qic-diff-content">' + window.markdownRenderer.sanitizeHtml(previewHtml) + '</div>' +
			'<div class="qic-diff-actions">' +
			'<button class="qic-btn qic-btn-approve" data-hash="' + escapeAttr(editScriptHash) + '">Apply</button>' +
			'<button class="qic-btn qic-btn-reject" data-hash="' + escapeAttr(editScriptHash) + '">Reject</button>' +
			(filePaths.length > 1 ? '<button class="qic-btn qic-btn-approve-all" data-hash="' + escapeAttr(editScriptHash) + '">Apply All</button>' : '') +
			'</div>';

		card.querySelector('.qic-btn-approve').addEventListener('click', function () {
			vscode.postMessage({ type: 'approve-diff', editScriptHash: this.dataset.hash, approved: true });
			disableDiffButtons(card);
		});
		card.querySelector('.qic-btn-reject').addEventListener('click', function () {
			vscode.postMessage({ type: 'approve-diff', editScriptHash: this.dataset.hash, approved: false });
			disableDiffButtons(card);
		});
		const applyAll = card.querySelector('.qic-btn-approve-all');
		if (applyAll) {
			applyAll.addEventListener('click', function () {
				vscode.postMessage({ type: 'approve-diff', editScriptHash: this.dataset.hash, approved: true });
				disableDiffButtons(card);
			});
		}

		messagesEl.appendChild(card);
		scrollToBottom();
	}

	function disableDiffButtons(card) {
		const buttons = card.querySelectorAll('.qic-btn');
		for (let i = 0; i < buttons.length; i++) {
			buttons[i].disabled = true;
		}
	}

	// --- Permission dialog rendering (Prompt 13) ---

	function renderPermissionRequest(requestId, toolName, description) {
		const card = document.createElement('div');
		card.className = 'qic-permission-card';
		card.innerHTML =
			'<div class="qic-permission-header">' +
			'<span class="qic-permission-icon">&#128274;</span> Permission Required' +
			'</div>' +
			'<div class="qic-permission-body">' +
			'<strong>' + escapeHtml(toolName) + '</strong><br>' +
			'<span>' + escapeHtml(description) + '</span>' +
			'</div>' +
			'<div class="qic-permission-actions">' +
			'<button class="qic-btn qic-btn-allow-once">Allow Once</button>' +
			'<button class="qic-btn qic-btn-allow-session">Allow for Session</button>' +
			'<button class="qic-btn qic-btn-deny">Deny</button>' +
			'<button class="qic-btn qic-btn-always qic-btn-secondary">Always Allow</button>' +
			'</div>';

		function respond(granted, scope) {
			vscode.postMessage({ type: 'permission-response', requestId: requestId, granted: granted, scope: scope });
			disableDiffButtons(card);
		}

		card.querySelector('.qic-btn-allow-once').addEventListener('click', function () { respond(true, 'once'); });
		card.querySelector('.qic-btn-allow-session').addEventListener('click', function () { respond(true, 'session'); });
		card.querySelector('.qic-btn-deny').addEventListener('click', function () { respond(false, 'once'); });
		card.querySelector('.qic-btn-always').addEventListener('click', function () { respond(true, 'always'); });

		messagesEl.appendChild(card);
		scrollToBottom();
	}

	// --- Code copy buttons ---

	function addCodeCopyButtons(el) {
		const codeBlocks = el.querySelectorAll('pre');
		for (let i = 0; i < codeBlocks.length; i++) {
			const pre = codeBlocks[i];
			if (pre.querySelector('.qic-copy-btn')) { continue; }
			const btn = document.createElement('button');
			btn.className = 'qic-copy-btn';
			btn.textContent = 'Copy';
			btn.addEventListener('click', function () {
				const code = pre.querySelector('code');
				const text = code ? code.textContent : pre.textContent;
				vscode.postMessage({ type: 'copy-code', code: text });
				btn.textContent = 'Copied!';
				setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
			});
			pre.style.position = 'relative';
			pre.appendChild(btn);
		}
	}

	// --- State management ---

	function setProcessing(processing) {
		isProcessing = processing;
		if (loadingEl) loadingEl.style.display = processing ? 'flex' : 'none';
		if (sendBtn) sendBtn.style.display = processing ? 'none' : 'inline-flex';
		if (cancelBtn) cancelBtn.style.display = processing ? 'inline-flex' : 'none';
	}

	function scrollToBottom() {
		if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	// --- Message handler (IV-AO7) ---

	window.addEventListener('message', function (event) {
		const msg = event.data;
		switch (msg.type) {
			case 'stream-token':
				hideEmptyState();
				appendStreamToken(msg.text);
				break;
			case 'message-complete':
				finalizeStreamingMessage();
				if (msg.usage) {
					var lastMsg = messagesEl.querySelector('.qic-message-assistant:last-child');
					if (lastMsg) {
						addMessageFooter(lastMsg, msg.usage.inputTokens || 0, msg.usage.outputTokens || 0, msg.provider || currentProvider);
					}
				}
				break;
			case 'tool-call-started':
				renderToolCallStarted(msg.toolCallId, msg.toolName, msg.args);
				if (loadingText) { loadingText.textContent = 'Running ' + msg.toolName + '...'; }
				break;
			case 'tool-call-result':
				renderToolCallResult(msg.toolCallId, msg.content, msg.isError);
				if (loadingText) { loadingText.textContent = 'Thinking...'; }
				break;
			case 'diff-preview':
				renderDiffPreview(msg.editScriptHash, msg.previewHtml, msg.filePaths);
				break;
			case 'permission-request':
				renderPermissionRequest(msg.requestId, msg.toolName, msg.description);
				break;
			case 'state-change':
				var loadingMsg = msg.state === 'gathering' ? 'Gathering context...' :
					msg.state === 'planning' ? 'Planning...' :
					msg.state === 'executing' ? 'Executing...' : 'Thinking...';
				setProcessing(msg.state === 'processing' || msg.state === 'waiting_approval' || msg.state === 'gathering' || msg.state === 'planning' || msg.state === 'executing', loadingMsg);
				break;
			case 'error':
				hideEmptyState();
				appendAssistantMessage('<p class="qic-error-msg">Error [' + escapeHtml(msg.code) + ']: ' + escapeHtml(msg.message) + '</p>');
				setProcessing(false);
				break;
			case 'clear-chat':
				messagesEl.innerHTML = '';
				showEmptyState();
				sessionCost = 0;
				updateCostDisplay();
				break;
			case 'connection-status':
				updateConnectionStatus(msg.status, msg.text);
				break;
			case 'context-files':
				contextFiles = msg.files || [];
				renderContextFiles();
				break;
			case 'provider-changed':
				currentProvider = msg.provider;
				if (providerSelect) { providerSelect.value = msg.provider; }
				updateModelIndicator();
				break;
			case 'routing-info':
				if (modelIndicator) { modelIndicator.textContent = msg.model || currentModel; }
				break;
			case 'restore-history':
				messagesEl.innerHTML = '';
				for (let i = 0; i < msg.messages.length; i++) {
					var m = msg.messages[i];
					if (m.role === 'user') {
						appendUserMessage(m.content);
					} else {
						var rendered = window.markdownRenderer.renderMarkdown(m.content);
						appendAssistantMessage(rendered);
					}
				}
				break;
			case 'set-theme':
				document.body.dataset.theme = msg.theme;
				break;
			case 'degradation-update':
				updateDegradationStatus(msg.level, msg.description);
				break;
			case 'quota-update':
				updateQuotaDisplay(msg.tokensUsed, msg.tokenLimit, msg.costUsed, msg.costLimit);
				break;
			case 'status-update':
				updateStatusDisplay(msg.lane, msg.model, msg.provider);
				break;
			case 'checkpoint-list':
				renderCheckpointList(msg.checkpoints);
				break;
			case 'show-first-run':
				if (firstRunEl) {
					firstRunEl.style.display = 'flex';
					document.getElementById('chat-container').style.display = 'none';
				}
				break;
			case 'settings-data':
				updateSettingsPanel(msg.consents, msg.connectionMode, msg.pythonStatus);
				break;
			case 'dataframe-preview':
				renderDataFramePreview(msg.data);
				break;
		}
	});

	// Use shared utilities from qicUtils
	var escapeHtml = window.qicUtils.escapeHtml;
	var escapeAttr = window.qicUtils.escapeAttr;

	// --- Degradation status display ---

	var DEGRADATION_LEVELS = [
		{ name: 'Normal', class: 'qic-badge-normal', color: '#2ea043' },
		{ name: 'Reduced', class: 'qic-badge-reduced', color: '#d29922' },
		{ name: 'Limited', class: 'qic-badge-limited', color: '#e67700' },
		{ name: 'Local Only', class: 'qic-badge-local', color: '#cf222e' },
		{ name: 'Emergency', class: 'qic-badge-emergency', color: '#a40e26' }
	];

	function updateDegradationStatus(level, description) {
		currentDegradationLevel = level;
		var info = DEGRADATION_LEVELS[level] || DEGRADATION_LEVELS[0];

		if (degradationBanner && degradationText) {
			if (level > 0) {
				degradationBanner.style.display = 'flex';
				degradationBanner.className = 'qic-degradation-banner qic-degradation-level-' + level;
				degradationText.textContent = description || 'System operating in ' + info.name + ' mode';
			} else {
				degradationBanner.style.display = 'none';
			}
		}
	}

	// --- Quota display ---

	function updateQuotaDisplay(tokensUsed, tokenLimit, costUsed, costLimit) {
		var percent = tokenLimit > 0 ? Math.min(100, (tokensUsed / tokenLimit) * 100) : 0;

		if (quotaText) {
			var usedK = Math.round(tokensUsed / 1000);
			var limitK = Math.round(tokenLimit / 1000);
			quotaText.textContent = 'Tokens: ' + usedK + 'K / ' + limitK + 'K';
			if (percent >= 80) {
				quotaText.className = 'qic-quota-text qic-quota-warning';
			} else if (percent >= 100) {
				quotaText.className = 'qic-quota-text qic-quota-exceeded';
			} else {
				quotaText.className = 'qic-quota-text';
			}
		}

		if (quotaFill) {
			quotaFill.style.width = Math.min(100, percent) + '%';
			if (percent >= 100) {
				quotaFill.className = 'qic-quota-fill qic-quota-fill-exceeded';
			} else if (percent >= 80) {
				quotaFill.className = 'qic-quota-fill qic-quota-fill-warning';
			} else {
				quotaFill.className = 'qic-quota-fill';
			}
		}
	}

	// --- Status display (lane, model) ---

	function updateStatusDisplay(lane, model, provider) {
		// Update settings panel
		if (settingsProvider) { settingsProvider.textContent = provider || 'Cloud'; }
		if (settingsModel) { settingsModel.textContent = model || '--'; }
	}

	// --- Settings panel update ---

	function updateSettingsPanel(consents, connectionMode, pythonStatus) {
		if (settingsProvider) {
			var modeNames = { cloud: 'Quantlab Cloud', byok: 'Bring Your Own Key', local: 'Local (Ollama)' };
			settingsProvider.textContent = modeNames[connectionMode] || connectionMode || 'Cloud';
		}
		if (settingsPython) {
			if (pythonStatus && pythonStatus.path) {
				settingsPython.textContent = pythonStatus.version || pythonStatus.path;
				settingsPython.title = pythonStatus.path;
			} else {
				settingsPython.textContent = 'Not configured';
			}
		}
		if (consentEmbeddingToggle) {
			consentEmbeddingToggle.checked = consents && consents.embedding;
		}
		if (consentTelemetryToggle) {
			consentTelemetryToggle.checked = consents && consents.telemetry;
		}
	}

	// --- Checkpoint list rendering ---

	function renderCheckpointList(checkpoints) {
		if (!checkpointList) { return; }

		if (checkpoints.length === 0) {
			checkpointList.innerHTML = '<div class="qic-checkpoint-empty">No checkpoints saved</div>';
			return;
		}

		var html = '';
		for (var i = 0; i < checkpoints.length; i++) {
			var cp = checkpoints[i];
			var date = new Date(cp.createdAt);
			var timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
			var dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });
			html += '<div class="qic-checkpoint-item" data-id="' + escapeAttr(cp.id) + '">' +
				'<div class="qic-checkpoint-info">' +
				'<span class="qic-checkpoint-time">' + escapeHtml(dateStr + ' ' + timeStr) + '</span>' +
				'<span class="qic-checkpoint-files">' + cp.fileCount + ' files</span>' +
				'</div>' +
				'<button class="qic-btn qic-btn-restore" data-id="' + escapeAttr(cp.id) + '">Restore</button>' +
				'</div>';
		}
		checkpointList.innerHTML = html;

		// Add click handlers for restore buttons
		var restoreBtns = checkpointList.querySelectorAll('.qic-btn-restore');
		for (var j = 0; j < restoreBtns.length; j++) {
			restoreBtns[j].addEventListener('click', function () {
				var id = this.dataset.id;
				if (confirm('Restore checkpoint? This will revert files to their saved state.')) {
					vscode.postMessage({ type: 'restore-checkpoint', checkpointId: id });
				}
			});
		}
	}

	// --- DataFrame preview ---

	function renderDataFramePreview(data) {
		var card = document.createElement('div');
		card.className = 'qic-dataframe-card';

		var header = '<div class="qic-dataframe-header">' +
			'<span class="qic-dataframe-path">' + escapeHtml(data.filePath.split('/').pop()) + '</span>' +
			'<span class="qic-dataframe-shape">' + data.shape[0] + ' × ' + data.shape[1] + '</span>' +
			'<span class="qic-dataframe-format">' + data.format.toUpperCase() + '</span>' +
			(data.truncated ? '<span class="qic-dataframe-truncated">Truncated</span>' : '') +
			'</div>';

		var table = '<div class="qic-dataframe-table"><table><thead><tr>';
		for (var c = 0; c < data.columns.length; c++) {
			table += '<th>' + escapeHtml(data.columns[c]) + '</th>';
		}
		table += '</tr></thead><tbody>';

		for (var r = 0; r < data.rows.length; r++) {
			table += '<tr>';
			for (var col = 0; col < data.columns.length; col++) {
				var val = data.rows[r][data.columns[col]];
				var cellText = val === null || val === undefined ? '' : String(val);
				if (cellText.length > 50) { cellText = cellText.slice(0, 47) + '...'; }
				table += '<td>' + escapeHtml(cellText) + '</td>';
			}
			table += '</tr>';
		}
		table += '</tbody></table></div>';

		card.innerHTML = header + table;
		messagesEl.appendChild(card);
		scrollToBottom();
	}

	// --- Connection status ---

	function updateConnectionStatus(status, text) {
		if (!connectionStatus) { return; }
		connectionStatus.className = 'qic-connection-status qic-status-' + status;
		if (connectionStatusText) {
			connectionStatusText.textContent = text || status;
		}
	}

	// --- Cost display ---

	function updateCostDisplay() {
		if (!costDisplay) { return; }
		costDisplay.textContent = '$' + sessionCost.toFixed(4);
		if (sessionCost > 0.10) {
			costDisplay.className = 'qic-cost-display qic-cost-warning';
		} else {
			costDisplay.className = 'qic-cost-display';
		}
	}

	function addMessageCost(inputTokens, outputTokens, provider) {
		// Cost calculation (approximate)
		var cost = 0;
		if (provider === 'openai' || provider === 'quantlab-cloud') {
			// GPT-4o-mini pricing: $0.15/1M input, $0.60/1M output
			cost = (inputTokens * 0.00000015) + (outputTokens * 0.0000006);
		} else if (provider === 'anthropic') {
			// Claude Haiku pricing: $0.25/1M input, $1.25/1M output
			cost = (inputTokens * 0.00000025) + (outputTokens * 0.00000125);
		}
		sessionCost += cost;
		updateCostDisplay();
		return cost;
	}

	// --- Model indicator ---

	function updateModelIndicator() {
		if (!modelIndicator) { return; }
		var models = {
			'auto': 'gpt-4o-mini (auto)',
			'openai': 'gpt-4o-mini',
			'anthropic': 'claude-3-haiku',
			'ollama': 'local model'
		};
		currentModel = models[currentProvider] || currentProvider;
		modelIndicator.textContent = currentModel;
	}

	// --- Token estimate ---

	function updateTokenEstimate() {
		if (!tokenEstimate || !inputEl) { return; }
		var text = inputEl.value || '';
		var estimate = Math.ceil(text.length / 4);
		tokenEstimate.textContent = '~' + estimate + ' tokens';
	}

	if (inputEl) {
		inputEl.addEventListener('input', function () {
			updateTokenEstimate();
			// Auto-resize
			this.style.height = 'auto';
			this.style.height = Math.min(this.scrollHeight, 150) + 'px';
		});
	}

	// --- Empty state ---

	function hideEmptyState() {
		if (emptyState) { emptyState.hidden = true; }
	}

	function showEmptyState() {
		if (emptyState) { emptyState.hidden = false; }
	}

	// --- Context files rendering ---

	function renderContextFiles() {
		if (!contextList) { return; }

		if (contextFiles.length === 0) {
			contextList.innerHTML = '<div class="qic-context-empty">No files in context</div>';
			if (contextBtn) { contextBtn.title = 'Context files (0)'; }
			if (inputContext) { inputContext.style.display = 'none'; }
			return;
		}

		var html = '';
		for (var i = 0; i < contextFiles.length; i++) {
			var file = contextFiles[i];
			html += '<div class="qic-context-item" data-path="' + escapeAttr(file.path) + '">' +
				'<span class="qic-context-item-icon">&#128196;</span>' +
				'<span class="qic-context-item-name" title="' + escapeAttr(file.path) + '">' + escapeHtml(file.name) + '</span>' +
				(file.lines ? '<span class="qic-context-item-lines">' + file.lines + ' lines</span>' : '') +
				'<button class="qic-context-item-remove" data-path="' + escapeAttr(file.path) + '">&times;</button>' +
				'</div>';
		}
		contextList.innerHTML = html;

		// Add remove handlers
		var removeBtns = contextList.querySelectorAll('.qic-context-item-remove');
		for (var j = 0; j < removeBtns.length; j++) {
			removeBtns[j].addEventListener('click', function () {
				var path = this.dataset.path;
				vscode.postMessage({ type: 'remove-context-file', path: path });
				contextFiles = contextFiles.filter(function (f) { return f.path !== path; });
				renderContextFiles();
			});
		}

		if (contextBtn) { contextBtn.title = 'Context files (' + contextFiles.length + ')'; }

		// Show active file tag in input area
		if (inputContext && contextFiles.length > 0) {
			inputContext.style.display = 'flex';
			if (activeFileName) {
				activeFileName.textContent = contextFiles[0].name + (contextFiles.length > 1 ? ' +' + (contextFiles.length - 1) : '');
			}
		}
	}

	// --- Message actions (copy, retry) ---

	function addMessageActions(el, role, content) {
		var actions = document.createElement('div');
		actions.className = 'qic-message-actions';

		var copyBtn = document.createElement('button');
		copyBtn.className = 'qic-msg-action';
		copyBtn.innerHTML = '&#128203;';
		copyBtn.title = 'Copy';
		copyBtn.addEventListener('click', function () {
			vscode.postMessage({ type: 'copy-code', code: content });
			copyBtn.innerHTML = '&#10003;';
			setTimeout(function () { copyBtn.innerHTML = '&#128203;'; }, 1500);
		});
		actions.appendChild(copyBtn);

		if (role === 'user') {
			var retryBtn = document.createElement('button');
			retryBtn.className = 'qic-msg-action';
			retryBtn.innerHTML = '&#8635;';
			retryBtn.title = 'Retry';
			retryBtn.addEventListener('click', function () {
				vscode.postMessage({ type: 'user-message', text: content });
			});
			actions.appendChild(retryBtn);
		}

		el.appendChild(actions);
	}

	// --- Message footer with cost/tokens ---

	function addMessageFooter(el, inputTokens, outputTokens, provider) {
		var cost = addMessageCost(inputTokens, outputTokens, provider);
		var footer = document.createElement('div');
		footer.className = 'qic-message-footer';
		footer.innerHTML =
			'<span class="qic-message-tokens">' + inputTokens + ' in / ' + outputTokens + ' out</span>' +
			'<span class="qic-message-cost">$' + cost.toFixed(6) + '</span>' +
			'<span class="qic-message-time">' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>';
		el.appendChild(footer);
	}

	// Update close all panels to include context panel
	function closeAllPanels() {
		if (checkpointPanel) { checkpointPanel.style.display = 'none'; }
		if (settingsPanel) { settingsPanel.style.display = 'none'; }
		if (contextPanel) { contextPanel.style.display = 'none'; }
	}

	// Update setProcessing to show loading text
	function setProcessing(processing, loadingMessage) {
		isProcessing = processing;
		if (loadingEl) { loadingEl.style.display = processing ? 'flex' : 'none'; }
		if (loadingText && loadingMessage) { loadingText.textContent = loadingMessage; }
		if (sendBtn) { sendBtn.style.display = processing ? 'none' : 'flex'; }
		if (cancelBtn) { cancelBtn.style.display = processing ? 'flex' : 'none'; }
	}

	// --- File reference click handler ---

	if (messagesEl) messagesEl.addEventListener('click', function (e) {
		var target = e.target;
		// Check if clicked element is a file reference
		if (target.classList.contains('qic-file-ref')) {
			var path = target.dataset.path;
			if (path) {
				e.preventDefault();
				e.stopPropagation();
				// Send message to VS Code to open the file/folder
				vscode.postMessage({
					type: 'open-file-reference',
					path: path,
					isFolder: target.classList.contains('qic-folder-ref')
				});
			}
		}
	});

	// Initialize
	updateConnectionStatus('connecting', 'Connecting...');
	updateCostDisplay();
	updateModelIndicator();
	updateTokenEstimate();

	// Request initial status
	setTimeout(function () {
		vscode.postMessage({ type: 'request-status' });
	}, 500);

	// Signal ready (IV-AO7: webview-ready handshake)
	vscode.postMessage({ type: 'webview-ready' });
})();

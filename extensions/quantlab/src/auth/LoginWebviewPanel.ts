/*---------------------------------------------------------------------------------------------
 *  QuantLab — Delta Plus Login Webview Panel
 *  Shows sign-in / register / demo UI. Returns a LoginResult to DeltaPlusAuthProvider.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ThemeProvider } from '../ui/tokens/ThemeProvider';
import { ServerApiClient } from '../core/server/ServerApiClient';

export type LoginResult =
	| { type: 'demo' }
	| { type: 'credentials'; email: string; password: string };

export class LoginWebviewPanel {
	/**
	 * Open the login modal and wait for the user to sign in or dismiss.
	 * Returns a LoginResult on success, null if the user cancelled.
	 *
	 * @param trySignIn - Optional callback that validates credentials server-side.
	 *   When provided, the panel stays open on failure and shows the error inline.
	 *   The callback should throw on invalid credentials.
	 */
	static async show(
		context: vscode.ExtensionContext,
		serverClient?: ServerApiClient,
		trySignIn?: (email: string, password: string) => Promise<void>
	): Promise<LoginResult | null> {
		const themeProvider = ThemeProvider.getInstance();

		const panel = vscode.window.createWebviewPanel(
			'quantlab.login',
			'Sign In to Delta Plus',
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots: [context.extensionUri]
			}
		);

		panel.webview.html = this._buildHtml(panel.webview, context.extensionUri);

		const themeKey = `quantlab.login.${Date.now()}`;
		themeProvider.registerWebview(themeKey, panel.webview);

		return new Promise<LoginResult | null>(resolve => {
			let disposed = false;
			const postMessage = (msg: Record<string, unknown>): void => {
				if (!disposed) { void panel.webview.postMessage(msg); }
			};

			const disposable = panel.webview.onDidReceiveMessage(
				async (message: Record<string, unknown>) => {
					if (!message || typeof message !== 'object') { return; }

					switch (message.type) {
						case 'signIn': {
							const email = String(message.email ?? '').trim();
							const password = String(message.password ?? '');
							if (!email || !password) { return; }
							if (trySignIn) {
								try {
									await trySignIn(email, password);
									// Login succeeded — resolve and close.
									resolve({ type: 'credentials', email, password });
									panel.dispose();
								} catch (err) {
									// Login failed — show error inline, keep panel open.
									const errorMsg = err instanceof Error ? err.message : 'Sign-in failed. Please try again.';
									postMessage({ type: 'signInError', error: errorMsg });
								}
							} else {
								resolve({ type: 'credentials', email, password });
								panel.dispose();
							}
							break;
						}

						case 'demo':
							resolve({ type: 'demo' });
							panel.dispose();
							break;

						case 'register': {
							const email = String(message.email ?? '').trim();
							const password = String(message.password ?? '');
							const name = String(message.name ?? '').trim();
							if (!email || !password || !name || !serverClient) {
								postMessage({
									type: 'registerResult',
									success: false,
									error: serverClient ? 'Please fill in all fields.' : 'Registration unavailable.'
								});
								break;
							}
							try {
								await serverClient.register(email, password, name);
								// Registration succeeded — immediately sign in with the same credentials.
								if (trySignIn) {
									try {
										await trySignIn(email, password);
										resolve({ type: 'credentials', email, password });
										panel.dispose();
									} catch (err) {
										const errorMsg = err instanceof Error ? err.message : 'Sign-in after registration failed.';
										postMessage({ type: 'registerResult', success: false, error: errorMsg });
									}
								} else {
									resolve({ type: 'credentials', email, password });
									panel.dispose();
								}
							} catch (err) {
								const errorMsg = err instanceof Error ? err.message : 'Registration failed. Please try again.';
								postMessage({ type: 'registerResult', success: false, error: errorMsg });
							}
							break;
						}

						case 'cancel':
							resolve(null);
							panel.dispose();
							break;
					}
				}
			);

			panel.onDidDispose(() => {
				disposed = true;
				themeProvider.unregisterWebview(themeKey);
				disposable.dispose();
				resolve(null);
			});
		});
	}

	private static _buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
		const tokensUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'tokens.css'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'login.css'));
		const themeStyles = ThemeProvider.getInstance().getInlineStyles();
		const nonce = this._nonce();
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`
		].join('; ');

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	${themeStyles}
	<link href="${tokensUri}" rel="stylesheet" />
	<link href="${styleUri}" rel="stylesheet" />
	<title>Sign In to Delta Plus</title>
</head>
<body>
	<div class="login-shell">

		<div class="login-header">
			<div class="brand-logo">
				<span class="brand-icon">&#916;</span>
				<span class="brand-name">Delta Plus</span>
			</div>
			<p class="login-subtitle">Sign in to access your market data</p>
		</div>

		<div class="tab-bar" role="tablist">
			<button class="tab active" data-view="signin" role="tab" aria-selected="true">Sign In</button>
			<button class="tab" data-view="register" role="tab" aria-selected="false">Create Account</button>
		</div>

		<!-- Sign In form -->
		<form id="signin-form" class="login-form" data-view="signin" novalidate>
			<div class="field-group">
				<label for="signin-email" class="field-label">Email</label>
				<input id="signin-email" type="email" class="field-input"
					placeholder="your@email.com" autocomplete="email" required />
			</div>
			<div class="field-group">
				<label for="signin-password" class="field-label">Password</label>
				<input id="signin-password" type="password" class="field-input"
					placeholder="Your password" autocomplete="current-password" required />
			</div>
			<div class="error-msg" id="signin-error" hidden></div>
			<button type="submit" class="btn btn-primary" id="signin-btn">Sign In</button>
		</form>

		<!-- Register form -->
		<form id="register-form" class="login-form" data-view="register" hidden novalidate>
			<div class="field-group">
				<label for="reg-name" class="field-label">Full Name</label>
				<input id="reg-name" type="text" class="field-input"
					placeholder="Your name" autocomplete="name" required />
			</div>
			<div class="field-group">
				<label for="reg-email" class="field-label">Email</label>
				<input id="reg-email" type="email" class="field-input"
					placeholder="your@email.com" autocomplete="email" required />
			</div>
			<div class="field-group">
				<label for="reg-password" class="field-label">Password</label>
				<input id="reg-password" type="password" class="field-input"
					placeholder="Minimum 8 characters" autocomplete="new-password" required minlength="8" />
			</div>
			<div class="error-msg" id="register-error" hidden></div>
			<button type="submit" class="btn btn-primary" id="register-btn">Create Account</button>
		</form>

		<div class="divider"><span>or</span></div>
		<button class="btn btn-demo" id="demo-btn" type="button">Use Demo Account</button>
	</div>

	<script nonce="${nonce}">
	(function () {
		const vscode = acquireVsCodeApi();

		// ── Tab switching ──────────────────────────────────────────────────────
		const tabs = document.querySelectorAll('.tab');
		const forms = document.querySelectorAll('.login-form');

		tabs.forEach(function (tab) {
			tab.addEventListener('click', function () {
				const view = tab.dataset.view;
				tabs.forEach(function (t) {
					t.classList.toggle('active', t === tab);
					t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
				});
				forms.forEach(function (form) {
					form.hidden = form.dataset.view !== view;
				});
			});
		});

		// ── Sign In ────────────────────────────────────────────────────────────
		document.getElementById('signin-form').addEventListener('submit', function (e) {
			e.preventDefault();
			var email = document.getElementById('signin-email').value.trim();
			var password = document.getElementById('signin-password').value;
			if (!email || !password) { return; }
			clearError('signin-error');
			setLoading('signin-btn', true, 'Signing in\u2026');
			vscode.postMessage({ type: 'signIn', email: email, password: password });
		});

		// ── Register ───────────────────────────────────────────────────────────
		document.getElementById('register-form').addEventListener('submit', function (e) {
			e.preventDefault();
			var name = document.getElementById('reg-name').value.trim();
			var email = document.getElementById('reg-email').value.trim();
			var password = document.getElementById('reg-password').value;
			if (!name || !email || !password) { return; }
			setLoading('register-btn', true, 'Creating account\u2026');
			clearError('register-error');
			vscode.postMessage({ type: 'register', name: name, email: email, password: password });
		});

		// ── Demo ───────────────────────────────────────────────────────────────
		document.getElementById('demo-btn').addEventListener('click', function () {
			vscode.postMessage({ type: 'demo' });
		});

		// ── Messages from extension host ───────────────────────────────────────
		window.addEventListener('message', function (event) {
			var msg = event.data;
			if (!msg) { return; }
			if (msg.type === 'signInError') {
				setLoading('signin-btn', false, 'Sign In');
				showError('signin-error', msg.error || 'Sign-in failed. Please try again.');
			} else if (msg.type === 'registerResult' && !msg.success) {
				setLoading('register-btn', false, 'Create Account');
				showError('register-error', msg.error || 'Registration failed. Please try again.');
			}
		});

		function setLoading(btnId, loading, label) {
			var btn = document.getElementById(btnId);
			btn.disabled = loading;
			btn.textContent = label;
		}

		function showError(id, msg) {
			var el = document.getElementById(id);
			el.textContent = msg;
			el.hidden = false;
		}

		function clearError(id) {
			var el = document.getElementById(id);
			el.hidden = true;
			el.textContent = '';
		}
	}());
	</script>
</body>
</html>`;
	}

	private static _nonce(): string {
		const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
		let result = '';
		for (let i = 0; i < 32; i++) {
			result += chars[Math.floor(Math.random() * chars.length)];
		}
		return result;
	}
}

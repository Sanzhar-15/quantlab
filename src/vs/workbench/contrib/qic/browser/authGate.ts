/*---------------------------------------------------------------------------------------------
 *  QuantLab — Auth Gate
 *
 *  Workbench-level contribution that covers the entire OS window with a full-screen login
 *  overlay before the VS Code chrome is visible. On successful authentication the overlay
 *  fades out and the workbench is revealed.
 *
 *  This runs in the RENDERER process (not the extension host), so it can inject directly
 *  into document.body and cover every VS Code UI element via z-index.
 *
 *  NOTE: VS Code enforces Trusted Types — the DOM is built imperatively (no innerHTML).
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IRequestService, asJson } from '../../../../platform/request/common/request.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

const SESSIONS_KEY = 'deltaplus.sessions';
const BASE_URL = 'https://api.deltaplus.io';

// ── Palette — must exactly match Quantlab Dark theme + titleBar token ────────
const C = {
	// Title bar (matches titleBar.activeBackground in quantlab_dark.json)
	titleBg: '#0A0A0A',
	titleFg: '#EDEDEF',
	titleBorder: '#1E1D1D',

	// Content surfaces
	bg: '#242323',
	surface: '#2C2B2B',
	inset: '#1B1A1A',
	border: '#383737',
	fg: '#EDEDEF',
	muted: '#A8A8AC',
	accent: '#FF7331',
	error: '#FF6B6B',
	btnFg: '#1A0A00',
} as const;

// ── Title bar height (matches DEFAULT_CUSTOM_TITLEBAR_HEIGHT in window.ts) ───
const TITLE_H = 35;

// ── Window-controls overlay width: reserve space so Electron's native ────────
// ── close/min/max buttons (WCO) are accessible through the overlay. ──────────
// ── We poke a transparent, pointer-events:none hole in that region. ──────────
const WCO_W = 140; // px — conservative estimate; covers most platform button widths

// ── Lightweight DOM helpers (no innerHTML — avoids Trusted Types violation) ──

function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	css?: Partial<CSSStyleDeclaration>,
	attrs?: Record<string, string>
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (css) { Object.assign(el.style, css); }
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			el.setAttribute(k, v);
		}
	}
	return el;
}

function txt(s: string): Text { return document.createTextNode(s); }

function append<T extends Node>(parent: T, ...children: Node[]): T {
	for (const c of children) { parent.appendChild(c); }
	return parent;
}

// ── Auth Gate ────────────────────────────────────────────────────────────────

export class AuthGate extends Disposable {

	static readonly ID = 'workbench.contrib.quantlab.authGate';

	private _el: HTMLElement | null = null;

	constructor(
		@ISecretStorageService private readonly _secrets: ISecretStorageService,
		@IRequestService private readonly _http: IRequestService,
	) {
		super();
		this._show();        // synchronous — zero flash
		void this._init();
	}

	// ── Init ─────────────────────────────────────────────────────────────────

	private async _init(): Promise<void> {
		// Hide immediately if a non-empty session already exists.
		if (await this._hasValidSession()) {
			this._remove(false);
		}

		// Always watch for session changes in both directions:
		//  • session appears  → hide the gate  (user just signed in)
		//  • session cleared  → re-show the gate (refresh token expired / sign-out)
		this._register(this._secrets.onDidChangeSecret(async key => {
			if (key !== SESSIONS_KEY) { return; }
			const hasSession = await this._hasValidSession();
			if (hasSession && this._el) {
				this._remove(true);
			} else if (!hasSession && !this._el) {
				this._show();
			}
		}));
	}

	/** Returns true only when SecretStorage holds a non-empty, parseable session array. */
	private async _hasValidSession(): Promise<boolean> {
		const val = await this._secrets.get(SESSIONS_KEY);
		if (!val) { return false; }
		try {
			const sessions = JSON.parse(val) as unknown[];
			return Array.isArray(sessions) && sessions.length > 0;
		} catch {
			return false;
		}
	}

	// ── Build overlay ─────────────────────────────────────────────────────────

	private _show(): void {
		if (this._el) { return; }
		const el = this._buildOverlay();
		document.body.appendChild(el);
		this._el = el;
		this._wire(el);
	}

	private _buildOverlay(): HTMLElement {
		// Outer shell — full screen, flex column so title bar stacks above content
		const shell = h('div', {
			position: 'fixed',
			inset: '0',
			zIndex: '9999999',
			display: 'flex',
			flexDirection: 'column',
			fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
			fontSize: '14px',
			color: C.fg,
			background: C.bg,
		}, { id: 'ql-auth-gate' });

		append(shell,
			this._buildTitleBar(),
			this._buildContent(),
		);
		return shell;
	}

	// ── Title bar ─────────────────────────────────────────────────────────────
	//
	//  Layout:  [ drag zone ][ QuantLab wordmark (centered) ][ WCO placeholder ]
	//
	//  The WCO (Window Controls Overlay) placeholder is a pointer-events:none
	//  transparent region sized to cover the native close/min/max buttons that
	//  Electron/OS renders at the top-right of a frameless window.  Making it
	//  transparent and pointer-events:none lets clicks fall through to those
	//  native controls so they remain usable while the overlay is visible.

	private _buildTitleBar(): HTMLElement {
		const bar = h('div', {
			height: `${TITLE_H}px`,
			minHeight: `${TITLE_H}px`,
			background: C.titleBg,
			borderBottom: `1px solid ${C.titleBorder}`,
			display: 'flex',
			alignItems: 'center',
			position: 'relative',          // for absolute-positioned children
			// Make the whole bar draggable by default.
			// Individual non-drag children override this via their own style.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			['WebkitAppRegion' as any]: 'drag',
			userSelect: 'none',
		} as Partial<CSSStyleDeclaration>);

		// Left pad — pure drag zone
		const leftPad = h('div', { flex: '1' } as Partial<CSSStyleDeclaration>);

		// Centred wordmark: "Δ  QuantLab"
		const wordmark = h('div', {
			position: 'absolute',
			left: '50%',
			transform: 'translateX(-50%)',
			display: 'flex',
			alignItems: 'center',
			gap: '7px',
			fontSize: '13px',
			fontWeight: '500',
			color: C.titleFg,
			letterSpacing: '.02em',
			opacity: '0.85',
			// Must NOT intercept pointer events (drag propagates from bar)
			pointerEvents: 'none',
		} as Partial<CSSStyleDeclaration>);

		const delta = h('span', { color: C.accent, fontWeight: '700', fontSize: '15px' } as Partial<CSSStyleDeclaration>);
		delta.textContent = '\u0394'; // Δ
		const name = h('span', {} as Partial<CSSStyleDeclaration>);
		name.textContent = 'QuantLab';
		append(wordmark, delta, name);

		// Right placeholder — transparent hole for native window-control buttons.
		// pointer-events:none lets clicks fall through to whatever Electron renders
		// underneath (close / minimise / maximise buttons).
		// WebkitAppRegion:no-drag stops this region from acting as a drag handle.
		const wcoPad = h('div', {
			width: `${WCO_W}px`,
			height: '100%',
			flexShrink: '0',
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			['WebkitAppRegion' as any]: 'no-drag',
			pointerEvents: 'none',       // pass clicks through to native controls
			background: 'transparent',
		} as Partial<CSSStyleDeclaration>);

		append(bar, leftPad, wordmark, wcoPad);
		return bar;
	}

	// ── Main content area (two columns) ──────────────────────────────────────

	private _buildContent(): HTMLElement {
		const content = h('div', {
			flex: '1',
			display: 'grid',
			gridTemplateColumns: '1fr 1fr',
			overflow: 'hidden',
		} as Partial<CSSStyleDeclaration>);

		// Responsive: single column below 700 px
		const mq = window.matchMedia('(max-width: 700px)');
		const applyLayout = (narrow: boolean): void => {
			content.style.gridTemplateColumns = narrow ? '1fr' : '1fr 1fr';
		};
		applyLayout(mq.matches);
		mq.addEventListener('change', e => applyLayout(e.matches));

		append(content, this._buildBrandPanel(), this._buildFormPanel());
		return content;
	}

	// ── Brand panel (left) ────────────────────────────────────────────────────

	private _buildBrandPanel(): HTMLElement {
		const panel = h('div', {
			background: C.bg,
			borderRight: `1px solid ${C.border}`,
			display: 'flex',
			flexDirection: 'column',
			justifyContent: 'center',
			padding: '56px 52px',
			gap: '28px',
		} as Partial<CSSStyleDeclaration>, { id: 'qag-brand' });

		// Logo row
		const logoRow = h('div', { display: 'flex', alignItems: 'center', gap: '10px' } as Partial<CSSStyleDeclaration>);
		const delta = h('span', { fontSize: '30px', color: C.accent, fontWeight: '700', lineHeight: '1' } as Partial<CSSStyleDeclaration>);
		delta.textContent = '\u0394';
		const brandName = h('span', { fontSize: '20px', fontWeight: '600', letterSpacing: '.02em' } as Partial<CSSStyleDeclaration>);
		brandName.textContent = 'Delta Plus';
		append(logoRow, delta, brandName);

		// Tagline
		const tagline = h('h1', { margin: '0', fontSize: '30px', fontWeight: '700', lineHeight: '1.25', color: C.fg } as Partial<CSSStyleDeclaration>);
		append(tagline, txt('Professional trading.'));
		tagline.appendChild(document.createElement('br'));
		const em = h('span', { color: C.accent } as Partial<CSSStyleDeclaration>);
		em.textContent = 'Built for quants.';
		tagline.appendChild(em);

		// Description
		const desc = h('p', { margin: '0', fontSize: '14px', color: C.muted, lineHeight: '1.65' } as Partial<CSSStyleDeclaration>);
		desc.textContent = 'QuantLab connects to Delta Plus for real-time market data, strategy back-testing, and AI-assisted analysis.';

		const topBlock = h('div', { display: 'flex', flexDirection: 'column', gap: '12px' } as Partial<CSSStyleDeclaration>);
		append(topBlock, logoRow, tagline, desc);

		// Feature bullets
		const features = [
			'511 equities & 50 crypto pairs, live',
			'Back-test strategies against historical data',
			'Yield curve, fundamentals & sentiment',
			'Delta Plus AI chat, integrated',
		];
		const ul = h('ul', { listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexDirection: 'column', gap: '10px' } as Partial<CSSStyleDeclaration>);
		for (const f of features) {
			const li = h('li', { display: 'flex', alignItems: 'center', gap: '10px', color: C.muted, fontSize: '13px' } as Partial<CSSStyleDeclaration>);
			const dot = h('span', { width: '6px', height: '6px', borderRadius: '50%', background: C.accent, flexShrink: '0', display: 'inline-block' } as Partial<CSSStyleDeclaration>);
			const label = h('span', {} as Partial<CSSStyleDeclaration>);
			label.textContent = f;
			append(li, dot, label);
			ul.appendChild(li);
		}

		append(panel, topBlock, ul);
		return panel;
	}

	// ── Form panel (right) ────────────────────────────────────────────────────

	private _buildFormPanel(): HTMLElement {
		const panel = h('div', {
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			padding: '52px 48px',
			overflowY: 'auto',
		} as Partial<CSSStyleDeclaration>, { id: 'qag-form' });

		const inner = h('div', { width: '100%', maxWidth: '360px' } as Partial<CSSStyleDeclaration>);

		// Heading
		const heading = h('h2', { margin: '0 0 6px', fontSize: '22px', fontWeight: '700' } as Partial<CSSStyleDeclaration>);
		heading.textContent = 'Get started';
		const subhead = h('p', { margin: '0 0 24px', fontSize: '13px', color: C.muted } as Partial<CSSStyleDeclaration>);
		subhead.textContent = 'Sign in or create a free account to continue.';

		// Tabs
		const tabs = h('div', {
			display: 'flex',
			borderBottom: `1px solid ${C.border}`,
			marginBottom: '22px',
		} as Partial<CSSStyleDeclaration>, { id: 'qag-tabs' });
		const signinTab = this._makeTab('signin', 'Sign In', true);
		const registerTab = this._makeTab('register', 'Create Account', false);
		append(tabs, signinTab, registerTab);

		// Sign In form
		const signinForm = h('form', {} as Partial<CSSStyleDeclaration>, { id: 'qag-signin-form', 'data-view': 'signin', autocomplete: 'on' });
		append(signinForm,
			this._makeField('qag-email', 'Email', 'email', 'your@email.com', 'email'),
			this._makeField('qag-password', 'Password', 'password', 'Your password', 'current-password'),
			this._makeErrorEl('qag-signin-error'),
			this._makePrimaryBtn('qag-signin-btn', 'Sign In'),
		);

		// Register form (initially hidden)
		const registerForm = h('form', { display: 'none' } as Partial<CSSStyleDeclaration>, { id: 'qag-register-form', 'data-view': 'register', autocomplete: 'on' });
		append(registerForm,
			this._makeField('qag-reg-name', 'Full Name', 'text', 'Your name', 'name'),
			this._makeField('qag-reg-email', 'Email', 'email', 'your@email.com', 'email'),
			this._makeField('qag-reg-password', 'Password', 'password', 'Minimum 8 characters', 'new-password'),
			this._makeErrorEl('qag-register-error'),
			this._makePrimaryBtn('qag-register-btn', 'Create Account'),
		);

		// Divider
		const divider = h('div', { display: 'flex', alignItems: 'center', gap: '10px', margin: '18px 0 14px', color: C.muted, fontSize: '12px' } as Partial<CSSStyleDeclaration>);
		const line1 = h('span', { flex: '1', height: '1px', background: C.border } as Partial<CSSStyleDeclaration>);
		const orText = h('span', {} as Partial<CSSStyleDeclaration>);
		orText.textContent = 'or';
		const line2 = h('span', { flex: '1', height: '1px', background: C.border } as Partial<CSSStyleDeclaration>);
		append(divider, line1, orText, line2);

		// Demo button
		const demoBtn = h('button', {
			width: '100%',
			background: 'transparent',
			color: C.muted,
			fontSize: '13px',
			fontFamily: 'inherit',
			border: `1px solid ${C.border}`,
			borderRadius: '6px',
			padding: '9px 14px',
			cursor: 'pointer',
		} as Partial<CSSStyleDeclaration>, { id: 'qag-demo-btn', type: 'button' });
		demoBtn.textContent = 'Use Demo Account';

		append(inner, heading, subhead, tabs, signinForm, registerForm, divider, demoBtn);
		panel.appendChild(inner);
		return panel;
	}

	// ── Small element helpers ─────────────────────────────────────────────────

	private _makeTab(view: string, label: string, active: boolean): HTMLButtonElement {
		const btn = h('button', {
			flex: '1',
			background: 'none',
			border: 'none',
			borderBottom: `2px solid ${active ? C.accent : 'transparent'}`,
			padding: '8px 12px',
			fontSize: '14px',
			color: active ? C.accent : C.muted,
			cursor: 'pointer',
			fontFamily: 'inherit',
			fontWeight: active ? '600' : '400',
			marginBottom: '-1px',
			transition: 'color .15s, border-color .15s',
		} as Partial<CSSStyleDeclaration>, { 'data-view': view, class: 'qag-tab' });
		btn.textContent = label;
		return btn;
	}

	private _makeField(id: string, label: string, type: string, placeholder: string, autocomplete: string): HTMLElement {
		const wrap = h('div', { display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '14px' } as Partial<CSSStyleDeclaration>);
		const lbl = h('label', {
			fontSize: '11px', color: C.muted, fontWeight: '500',
			letterSpacing: '.05em', textTransform: 'uppercase',
		} as Partial<CSSStyleDeclaration>, { for: id });
		lbl.textContent = label;
		const input = h('input', {
			background: C.inset,
			color: C.fg,
			border: `1px solid ${C.border}`,
			borderRadius: '6px',
			padding: '8px 11px',
			fontSize: '14px',
			fontFamily: 'inherit',
			outline: 'none',
			width: '100%',
			boxSizing: 'border-box',
			transition: 'border-color .15s',
		} as Partial<CSSStyleDeclaration>, { id, type, placeholder, autocomplete });
		input.addEventListener('focus', () => { input.style.borderColor = C.accent; });
		input.addEventListener('blur', () => { input.style.borderColor = C.border; });
		append(wrap, lbl, input);
		return wrap;
	}

	private _makeErrorEl(id: string): HTMLElement {
		return h('div', {
			fontSize: '12px',
			color: C.error,
			padding: '6px 10px',
			background: `${C.error}18`,
			borderRadius: '5px',
			border: `1px solid ${C.error}44`,
			marginBottom: '10px',
			display: 'none',
		} as Partial<CSSStyleDeclaration>, { id });
	}

	private _makePrimaryBtn(id: string, label: string): HTMLButtonElement {
		const btn = h('button', {
			width: '100%',
			background: C.accent,
			color: C.btnFg,
			fontWeight: '600',
			fontSize: '14px',
			fontFamily: 'inherit',
			border: 'none',
			borderRadius: '6px',
			padding: '10px 14px',
			cursor: 'pointer',
			marginTop: '4px',
			transition: 'background .15s',
		} as Partial<CSSStyleDeclaration>, { id, type: 'submit' });
		btn.textContent = label;
		return btn;
	}

	// ── Event wiring ──────────────────────────────────────────────────────────

	private _wire(root: HTMLElement): void {
		const tabEls = root.querySelectorAll<HTMLElement>('.qag-tab');
		const signinForm = root.querySelector<HTMLFormElement>('#qag-signin-form')!;
		const registerForm = root.querySelector<HTMLFormElement>('#qag-register-form')!;

		// Tab switching
		tabEls.forEach(tab => tab.addEventListener('click', () => {
			const view = tab.dataset['view'];
			tabEls.forEach(t => {
				const active = t === tab;
				t.style.color = active ? C.accent : C.muted;
				t.style.borderBottomColor = active ? C.accent : 'transparent';
				t.style.fontWeight = active ? '600' : '400';
			});
			signinForm.style.display = view === 'signin' ? 'block' : 'none';
			registerForm.style.display = view === 'register' ? 'block' : 'none';
		}));

		// Sign in
		signinForm.addEventListener('submit', async e => {
			e.preventDefault();
			const email = (root.querySelector<HTMLInputElement>('#qag-email')!).value.trim();
			const password = (root.querySelector<HTMLInputElement>('#qag-password')!).value;
			const btn = root.querySelector<HTMLButtonElement>('#qag-signin-btn')!;
			const errorEl = root.querySelector<HTMLElement>('#qag-signin-error')!;
			this._setLoading(btn, true, 'Signing in\u2026');
			errorEl.style.display = 'none';
			try {
				await this._doSignIn(email, password);
				this._remove(true);
			} catch (err) {
				this._setLoading(btn, false, 'Sign In');
				this._showError(errorEl, err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
			}
		});

		// Register
		registerForm.addEventListener('submit', async e => {
			e.preventDefault();
			const name = (root.querySelector<HTMLInputElement>('#qag-reg-name')!).value.trim();
			const email = (root.querySelector<HTMLInputElement>('#qag-reg-email')!).value.trim();
			const password = (root.querySelector<HTMLInputElement>('#qag-reg-password')!).value;
			const btn = root.querySelector<HTMLButtonElement>('#qag-register-btn')!;
			const errorEl = root.querySelector<HTMLElement>('#qag-register-error')!;
			this._setLoading(btn, true, 'Creating account\u2026');
			errorEl.style.display = 'none';
			try {
				await this._doRegister(name, email, password);
				this._remove(true);
			} catch (err) {
				this._setLoading(btn, false, 'Create Account');
				this._showError(errorEl, err instanceof Error ? err.message : 'Registration failed. Please try again.');
			}
		});

		// Demo
		root.querySelector<HTMLButtonElement>('#qag-demo-btn')!.addEventListener('click', async () => {
			const btn = root.querySelector<HTMLButtonElement>('#qag-demo-btn')!;
			this._setLoading(btn, true, 'Connecting\u2026');
			try {
				await this._doSignIn('demo@deltaplus.io', 'DeltaPlus-Demo-2026!');
				this._remove(true);
			} catch {
				this._setLoading(btn, false, 'Use Demo Account');
			}
		});
	}

	// ── API calls (via IRequestService — routes through main process, no CORS) ──

	/** Parse the server's standard envelope: { success, data } | bare object */
	private _unwrap<T>(raw: unknown): T {
		if (raw && typeof raw === 'object' && 'success' in raw && 'data' in raw) {
			const env = raw as { success: boolean; data: unknown; error?: { message?: string } };
			if (!env.success) {
				throw new Error(env.error?.message ?? 'Request failed');
			}
			return env.data as T;
		}
		return raw as T;
	}

	private async _post<T>(path: string, body: unknown): Promise<T> {
		const ctx = await this._http.request({
			type: 'POST',
			url: `${BASE_URL}${path}`,
			data: JSON.stringify(body),
			headers: { 'Content-Type': 'application/json' },
		}, CancellationToken.None);

		const raw = await asJson<unknown>(ctx);

		// Non-2xx: try to surface a human-readable error
		if (ctx.res.statusCode && ctx.res.statusCode >= 300) {
			const msg = (raw as { message?: string; error?: { message?: string } } | null)?.message
				?? (raw as { error?: { message?: string } } | null)?.error?.message
				?? `Request failed (${ctx.res.statusCode})`;
			throw new Error(msg);
		}

		return this._unwrap<T>(raw);
	}

	private async _doSignIn(email: string, password: string): Promise<void> {
		const data = await this._post<{
			access_token: string; refresh_token: string; expires_in: number;
			user: { id?: string; email: string; name: string; tier: string; is_email_verified?: boolean; avatar_url?: string };
		}>('/v1/auth/login', { email, password });

		await this._storeSession(data);
	}

	private async _doRegister(name: string, email: string, password: string): Promise<void> {
		await this._post('/v1/auth/register', { email, password, name });
		// Registration succeeded — sign in to get tokens.
		await this._doSignIn(email, password);
	}

	private async _storeSession(data: {
		access_token: string; refresh_token: string; expires_in: number;
		user: { id?: string; email: string; name: string; tier: string; is_email_verified?: boolean; avatar_url?: string };
	}): Promise<void> {
		const session = {
			id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresAt: Date.now() + data.expires_in * 1000,
			email: data.user.email,
			name: data.user.name,
			tier: data.user.tier,
			isEmailVerified: data.user.is_email_verified ?? false,
			avatarUrl: data.user.avatar_url,
		};
		await this._secrets.set(SESSIONS_KEY, JSON.stringify([session]));
	}

	// ── UI helpers ────────────────────────────────────────────────────────────

	private _setLoading(btn: HTMLButtonElement, loading: boolean, label: string): void {
		btn.disabled = loading;
		btn.textContent = label;
		btn.style.opacity = loading ? '0.6' : '1';
		btn.style.cursor = loading ? 'not-allowed' : 'pointer';
	}

	private _showError(el: HTMLElement, msg: string): void {
		el.textContent = msg;
		el.style.display = 'block';
	}

	// ── Remove / teardown ─────────────────────────────────────────────────────

	private _remove(animated: boolean): void {
		// Use only this._el — not document.getElementById — so double-calls (e.g.
		// from the form handler + the onDidChangeSecret listener firing in the same
		// tick) are safe no-ops after the first call clears this._el.
		const el = this._el;
		if (!el) { return; }
		this._el = null;
		if (animated) {
			el.style.transition = 'opacity 0.35s ease';
			el.style.opacity = '0';
			setTimeout(() => el.remove(), 380);
		} else {
			el.remove();
		}
	}

	override dispose(): void {
		this._remove(false);
		super.dispose();
	}
}

registerWorkbenchContribution2(AuthGate.ID, AuthGate, WorkbenchPhase.AfterRestored);

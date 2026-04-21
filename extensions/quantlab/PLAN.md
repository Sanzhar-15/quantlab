# QuantLab Login System — Implementation Plan (v2)

> **Status**: Revised after independent dual-LLM review — awaiting user approval before any code is written.
> **Date**: 2026-03-13
> **Scope**: Replace hardcoded demo auto-login with a full user-account login system integrated with the Delta Plus server.

---

## 1. Problem Statement

QuantLab connects to Delta Plus using a shared demo account hardcoded in `ServerApiClient.ts`. No login UI exists, no per-user identity, and no per-account session persistence. Users cannot access features tied to their subscription tier.

**Goal**: Every user authenticates with their own Delta Plus account. Authentication persists across restarts using VS Code's secure storage, integrates with the VS Code account UI, and presents a polished branded login/registration modal.

---

## 2. Recon Summary

### Server — fully built, **no server changes required**
- `POST /v1/auth/login` → `{ access_token, refresh_token, expires_in, user }`
- `POST /v1/auth/register` → 201 + "check your email" message (**no tokens on register**)
- `POST /v1/auth/refresh` → rotates both tokens
- `POST /v1/auth/logout` → revokes refresh token on server
- `GET /v1/auth/me` → current user
- `POST /v1/auth/forgot-password` / `POST /v1/auth/reset-password`
- JWT: HS256, **15-min access token**, **7-day refresh token**
- User model: `id` (UUID), `email`, `name`, `tier` (free/basic/premium/pro/enterprise), `is_email_verified`, `avatar_url`
- Rate limits: 5 per IP+email per 15 min; 10 per email per 15 min; 20 per IP per 15 min

### Client — current state
- `ServerApiClient.ts` has `login(email, password)`, `refreshAccessToken()`, `persistTokens()` (writes `qic.deltaplusAccessToken`, `qic.deltaplusRefreshToken`, `qic.deltaplusTokenExpiresAt` to SecretStorage)
- `initializeServerConnection()` in `extension.ts` calls `loginWithRetry(3, 1000)` with hardcoded demo credentials on every startup — **this is what we replace**
- `WelcomeModal.ts` is the reference webview panel pattern
- No `vscode.authentication` provider registered anywhere
- **QIC's `DeltaPlusAdapter` reads the old `qic.deltaplusXxx` SecretStorage keys directly** — these keys cannot simply be deleted without updating QIC too

---

## 3. Architecture: `vscode.AuthenticationProvider` (chosen)

### Why
- Free VS Code status bar account switcher
- `onDidChangeSessions` propagates across windows via `SecretStorage.onDidChange`
- `createSession()` is the canonical hook for login UI
- Platform keychain backing (macOS Keychain / Windows Credential Manager / Linux Secret Service)

### Alternative rejected: custom modal + manual SecretStorage
Rejected: no status bar, no multi-window sync, not idiomatic.

### Pre-work validation (Phase 0)
**Before writing any code**: smoke-test that `vscode.authentication.registerAuthenticationProvider` works in this fork. Register a no-op provider in a temporary dev build and confirm the status bar account icon appears. The fork's authentication service (`src/vs/workbench/services/authentication/`) may have been inadvertently modified.

---

## 4. Token Ownership — Revised Architecture

Independent review identified a circular dependency and a startup race in the original design. The revised ownership model:

**`DeltaPlusAuthProvider` owns:**
- SecretStorage JSON (`deltaplus.sessions` array)
- Session lifecycle (getSessions, createSession, removeSession)
- `onDidChangeSessions` event

**`ServerApiClient` owns:**
- In-flight HTTP with the current access token
- Token refresh (`refreshAccessToken()`)
- An `authReadyPromise` field — a `Promise<void>` that resolves when tokens are first set (see §5)
- A **pull-based sync**: after refresh succeeds, fires `_onAuthStateChange` event; the provider **subscribes** to `onAuthStateChange` and re-reads tokens from `ServerApiClient` to update SecretStorage

This eliminates the push-based callback (which had a pre-registration window) in favour of a subscription the provider sets up at construction.

**QIC compatibility layer (dual-write, until QIC is updated):**
Keep `persistTokens()` intact and still called after every token update (`setSessionTokens()` and `refreshAccessToken()`). This ensures `qic.deltaplusAccessToken` etc. remain populated. Flag this code as `// QIC_COMPAT: remove when DeltaPlusAdapter reads from vscode.authentication directly`.

---

## 5. Critical Design Decisions (from review findings)

### 5.1 Startup fan-out race → `authReadyPromise`
`activate()` constructs panels synchronously after `void initializeServerConnection()`. Those panels trigger background data fetches that call `ensureAuthenticated()` before tokens are loaded. If `ensureAuthenticated()` throws immediately on no-token, all panels fail simultaneously.

**Fix**: Add `private authReadyPromise: Promise<void> | null = null` and `private authReadyResolve: (() => void) | null = null` to `ServerApiClient`. On construction, initialise the promise. `ensureAuthenticated()` awaits `authReadyPromise` before checking the token. `setSessionTokens()` calls `authReadyResolve()`. Timeout after 30s to avoid hanging forever if login is never completed.

```typescript
// Simplified sketch
private authReadyPromise = new Promise<void>(resolve => {
    this.authReadyResolve = resolve;
});

private async ensureAuthenticated(): Promise<void> {
    // Wait for initial tokens (covers startup fan-out)
    await Promise.race([
        this.authReadyPromise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Not signed in to Delta Plus')), 30_000)
        )
    ]);
    // Then refresh if needed
    if (Date.now() > this.tokenExpiresAt - 60_000) { ... }
}
```

### 5.2 `createSession()` cancellation contract
When `LoginWebviewPanel.show()` returns `null` (user closes panel without logging in), `createSession()` must throw — not return undefined. VS Code requires a thrown error for user cancellation.

```typescript
// In DeltaPlusAuthProvider.createSession():
const result = await LoginWebviewPanel.show(this._context);
if (!result) {
    const err = new Error('User cancelled sign-in');
    err.name = 'Cancelled';
    throw err;
}
```

### 5.3 Expired refresh token recovery
When `refreshAccessToken()` fails with 401 (7-day TTL expired), the current code would surface a generic API error. Instead:

- `refreshAccessToken()` catches 401 and fires `_onAuthStateChange.fire(false)` + clears all tokens
- The `onDidChangeSessions` listener in `extension.ts` detects the session loss and shows "Your Delta Plus session has expired. [Sign In]"

### 5.4 Migration strategy (old → new SecretStorage keys)
The old keys (`qic.deltaplusXxx`) don't store the email — they cannot be used to check "is this a real account or demo?". Revised migration:

1. On `DeltaPlusAuthProvider` construction, check if `deltaplus.sessions` exists → if yes, already migrated, skip
2. Check `deltaplus.migrationV1Done` flag → if set, skip
3. Check `qic.deltaplusAccessToken` → if absent, no migration needed
4. If old access token present and not expired: call `GET /v1/auth/me` to get user info → if user.email is demo, discard. If real, create session entry
5. If old access token expired: try refresh with `qic.deltaplusRefreshToken` → if succeeds, create session entry. If fails (401), discard
6. Write `deltaplus.migrationV1Done = "1"` to prevent re-running
7. **Do NOT delete old keys** — QIC still reads them (dual-write ensures they stay fresh)

### 5.5 Registration UX
`POST /v1/auth/register` returns 201 + message but **no tokens**. After successful registration, the login modal switches to a "success" state:

> "Account created! Check your email to verify your address, then sign in below."

The email field is pre-filled with the registered email and the form switches to Sign In tab. The user completes login after email verification.

### 5.6 WebSocket reconnect auth failure
`scheduleReconnect()` currently swallows all errors. After this change, if `ensureAuthenticated()` throws during a reconnect attempt due to expired refresh token, the WebSocket will silently stop reconnecting. Fix:

```typescript
// In scheduleReconnect or connectWebSocket catch:
} catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Not signed in') || msg.includes('token has expired')) {
        // Auth expired — clear tokens, fire event, stop reconnecting
        this.accessToken = undefined;
        this._onAuthStateChange.fire(false);
        return; // Don't schedule next reconnect
    }
    this.scheduleReconnect(); // transient error — retry
}
```

### 5.7 Settings panel staleness
`SettingsPanelProvider` currently takes only `context`. After this change, it must subscribe to session changes to refresh. Pass `onDidChangeSessions` event at construction, call `this._onDidChangeTreeData.fire()` on change.

### 5.8 `getSessions()` token freshness
If the stored access token is expired, `getSessions()` still returns it. Since all actual API calls go through `ServerApiClient.ensureAuthenticated()` (which handles refresh), this is acceptable — we control all consumers. No external code reads the token directly. Add a comment documenting this assumption.

---

## 6. Files to Create / Modify

### New Files

| File | Purpose |
|------|---------|
| `src/auth/DeltaPlusAuthProvider.ts` | `vscode.AuthenticationProvider` — session CRUD, SecretStorage JSON, migration logic |
| `src/auth/LoginWebviewPanel.ts` | Webview panel controller — shows login form, returns credentials or null |
| `media/login.html` | Login form HTML — Sign In / Create Account tabs, demo button, error/success states |
| `media/login.css` | Login styles — uses `tokens.css` variables, inputs, tabs, spinners, banners |

### Modified Files

| File | Change |
|------|--------|
| `package.json` | Add `contributes.authentication` + 3 commands (`signIn`, `signOut`, `viewProfile`) |
| `package.nls.json` | NLS strings for new commands + provider label |
| `src/extension.ts` | Register auth provider; replace demo `initializeServerConnection`; subscribe to `onDidChangeSessions` |
| `src/core/server/ServerApiClient.ts` | Add `authReadyPromise`, `setSessionTokens()`, subscription hook; fix WebSocket reconnect auth error; keep `persistTokens()` as QIC compat |
| `src/panels/settings/SettingsPanelProvider.ts` | Account section (profile + sign out); subscribe to session changes for refresh |

---

## 7. Implementation Phases

### Phase 0 — Validate Fork Auth Plumbing (1 hour, no code change)
- Register a no-op `vscode.AuthenticationProvider` in a temp build, confirm status bar account icon appears
- If broken: file a separate issue and proceed with custom status-bar-item fallback instead

### Phase 1 — Package Registration (15 min)
1. Add to `package.json`:
   ```json
   "contributes": {
     "authentication": [{ "id": "deltaplus", "label": "Delta Plus" }],
     "commands": [
       { "command": "quantlab.signIn", "title": "%command.signIn.title%", "category": "%command.category%" },
       { "command": "quantlab.signOut", "title": "%command.signOut.title%", "category": "%command.category%" },
       { "command": "quantlab.viewProfile", "title": "%command.viewProfile.title%", "category": "%command.category%" }
     ]
   }
   ```
2. Add NLS keys to `package.nls.json`

### Phase 2 — `ServerApiClient` Changes (30 min)
3. Add `authReadyPromise` / `authReadyResolve` fields and `setSessionTokens()` method
4. Update `ensureAuthenticated()` to await `authReadyPromise` with 30s timeout
5. Update `refreshAccessToken()` to fire `_onAuthStateChange.fire(false)` and clear tokens on 401 (expired refresh token)
6. Update WebSocket reconnect error handler to check for auth errors and stop reconnecting
7. Keep `persistTokens()` and all its existing call sites (QIC compat)
8. Mark `getDemoCredentials()` / `loginWithDemo()` as kept-for-demo but no longer called from `ensureAuthenticated()`

### Phase 3 — `DeltaPlusAuthProvider` (45 min)
9. Create `src/auth/DeltaPlusAuthProvider.ts`:
   - `getSessions()`: read `deltaplus.sessions` from SecretStorage; return array (note freshness caveat)
   - `createSession()`: call `LoginWebviewPanel.show()` → on null, throw `Cancelled` error; on demo, call `serverClient.loginWithDemo()`; on credentials, call `serverClient.login(email, password)`; on register, call register endpoint then show success state; wrap result in `AuthenticationSession`; persist to `deltaplus.sessions`; fire `onDidChangeSessions`
   - `removeSession()`: call `serverClient.request('POST', '/v1/auth/logout', { refresh_token })` then remove from `deltaplus.sessions` and fire event
   - `updateSessionFromClient()`: subscribes to `serverClient.onAuthStateChange` — when tokens refresh (true event with new tokens), re-read from `serverClient` and update stored session
   - `runMigration()`: implements the §5.4 migration strategy

### Phase 4 — Login UI (45 min)
10. Create `media/login.html`: Sign In tab + Create Account tab; Try Demo button; loading/error/success states; follows WelcomeModal CSP pattern (nonce, no inline scripts); message protocol: `submit` / `register` / `demo` / `forgotPassword` / `close`
11. Create `media/login.css`: form inputs, tabs, error banners, spinner, using `tokens.css` design tokens
12. Create `src/auth/LoginWebviewPanel.ts`: opens `vscode.WebviewPanel`, awaits message, resolves promise; `onDidDispose` resolves `null`; static `show()` factory method

### Phase 5 — Extension.ts Wiring (30 min)
13. Register `DeltaPlusAuthProvider` with `vscode.authentication`
14. Replace `initializeServerConnection()`:
    - Try `vscode.authentication.getSession('deltaplus', ['read'], { createIfNone: false, silent: true })`
    - If found: call `serverClient.setSessionTokens(...)` → connects WebSocket → logs success
    - If not found: show info notification "Sign in to Delta Plus to access market data" with [Sign In] action
15. Subscribe to `vscode.authentication.onDidChangeSessions` for `deltaplus`:
    - Session added/changed → call `serverClient.setSessionTokens(...)`
    - Session removed → call `serverClient.clearTokens()` + disconnect WebSocket
16. Register `quantlab.signIn`, `quantlab.signOut`, `quantlab.viewProfile` command handlers

### Phase 6 — Settings Panel (30 min)
17. Update `SettingsPanelProvider` constructor to accept `onSessionChange: vscode.Event<...>` (or use `vscode.authentication.onDidChangeSessions` directly)
18. Add "Account" group to settings tree with:
    - If authenticated: avatar/name (or email), tier badge, "Sign Out" item (invokes `quantlab.signOut`), "View Profile" item
    - If not: "Sign In to Delta Plus" item (invokes `quantlab.signIn`)
    - If email not verified: yellow "Verify your email" item with "Resend" action
19. Subscribe to session changes → `this._onDidChangeTreeData.fire()`

### Phase 7 — Compile + Test (30 min)
20. `cd extensions/quantlab && npx tsc -p tsconfig.json` — expect only pre-existing test file errors
21. Manual test checklist (see §8)

---

## 8. Test Checklist

| # | Scenario | Expected |
|---|---------|---------|
| 1 | Fresh install, no session | Info notification appears, sign in panel not auto-opened |
| 2 | Click [Sign In] notification | Login modal opens |
| 3 | Correct credentials | Session created, status bar shows email, data panels load |
| 4 | Wrong password | "Invalid email or password" error shown in modal, button re-enables |
| 5 | Rate limited (5 failures) | "Too many attempts. Try again in 15 minutes." message, no spinner loop |
| 6 | Dismiss modal without login | Panel closes, no crash, `createSession()` throws `Cancelled` cleanly |
| 7 | Restart with valid session | Auto-connects silently, no modal |
| 8 | Try Demo button | Connects with demo@deltaplus.io, status bar shows "Demo User" |
| 9 | Register new account | Success message shown, Sign In tab shown with email pre-filled |
| 10 | Sign out from settings | Tokens cleared, WebSocket drops, notification shown, panels degrade gracefully |
| 11 | Token expiry (15 min) | Silent refresh occurs, no user disruption, settings panel shows correct state |
| 12 | Expired refresh token (7 days) | Auth error caught, `onAuthStateChange(false)` fired, notification shown to re-sign-in |
| 13 | WebSocket reconnect after network blip | Reconnects, re-authenticates with current token |
| 14 | Forgot password link | Opens system browser, no modal crash |
| 15 | Old SecretStorage keys present (migration) | Migrated to new format, old keys still populated (QIC compat) |

---

## 9. Risks & Mitigations (updated)

| Risk | Severity | Mitigation in this Plan |
|------|---------|------------------------|
| Fork auth plumbing broken | High | Phase 0 smoke test before writing code |
| Startup fan-out throws before tokens set | High | `authReadyPromise` in `ServerApiClient` |
| `createSession()` cancellation crashes | High | Throw `Error('Cancelled')` explicitly |
| Expired refresh token (7 days) — no recovery | High | `refreshAccessToken()` fires `onAuthStateChange(false)` on 401 |
| QIC reads old SecretStorage keys | High | Keep `persistTokens()` (dual-write as QIC compat layer) |
| Settings shows stale data after sign-in/out | Medium | Subscribe to `onDidChangeSessions` in settings provider |
| WebSocket silently stops on auth error | Medium | Explicit auth-error check in reconnect handler |
| `createSession()` race (two windows) | Low | `supportsMultipleAccounts: false` + documented limitation; fix in v2 if needed |
| Migration re-triggers on every start | Low | `deltaplus.migrationV1Done` lock key |
| `Math.random()` nonce in login webview | Low | Use `crypto.randomBytes(16).toString('hex')` — fix the pattern while creating login.html |

---

## 10. Out of Scope

- Google / Apple OAuth sign-in
- Two-factor authentication
- Password change from within QuantLab (link to web app)
- Session management UI (list/revoke other devices)
- Subscription/billing UI
- Updating QIC `DeltaPlusAdapter` to read from `vscode.authentication` directly (deferred — dual-write handles it)

---

## 11. File Summary

```
extensions/quantlab/
├── src/
│   ├── auth/                              ← NEW directory
│   │   ├── DeltaPlusAuthProvider.ts       ← NEW (~200 lines)
│   │   └── LoginWebviewPanel.ts           ← NEW (~150 lines)
│   ├── extension.ts                       ← MODIFY (~40 lines changed)
│   ├── core/server/ServerApiClient.ts     ← MODIFY (~80 lines changed)
│   └── panels/settings/SettingsPanelProvider.ts ← MODIFY (~60 lines changed)
├── media/
│   ├── login.html                         ← NEW (~120 lines)
│   └── login.css                          ← NEW (~180 lines)
├── package.json                           ← MODIFY (contributes.authentication + 3 commands)
└── package.nls.json                       ← MODIFY (5 new NLS keys)
```

**No server changes. No workbench changes. No breaking changes to existing data flow.**

---

## 12. Confidence Assessment

Original plan confidence: **6/10** (per independent review)
After incorporating all 8 high-severity fixes: **8.5/10**

Remaining uncertainty: Phase 0 fork-plumbing validation result (could trigger fallback path to custom status bar item instead of `vscode.AuthenticationProvider`).

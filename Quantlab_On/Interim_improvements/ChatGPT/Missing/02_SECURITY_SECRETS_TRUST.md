# Security, Secrets, and Trust Gaps

---

## 1) Secrets Flow Not Wired End‑to‑End

**Evidence**
- UI stores broker secrets only in VS Code `SecretStorage` via `extensions/quantlab/src/utils/secureStorage.ts` and `extensions/quantlab/src/core/broker/AlpacaAdapter.ts`.
- Daemon reads credentials from env or encrypted file via `engine/quantlab/secrets/encrypted.py` and `engine/quantlab/daemon/main.py`.
- No IPC method exists to **write** or **sync** secrets to the daemon’s encrypted store.

**Impact**
- Live trading via daemon cannot access credentials configured in UI.
- Credentials are fragmented across two unrelated stores.

**Optimal Fix**
- Add a dedicated IPC method (e.g., `credentials.set`) for secure transfer and storage in the daemon’s encrypted file.
- Provide UI for configuring credentials that writes to the daemon’s secrets store, not only VS Code SecretStorage.
- Use VS Code SecretStorage as **primary**, with encrypted file fallback for environments without keychain support (Decision E27).

---

## 2) Master Key Prompt Exists but Is Unused

**Evidence**
- `extensions/quantlab/src/ui/dialogs/MasterKeyPrompt.ts` is not referenced anywhere else.

**Impact**
- Encrypted secrets flow cannot be unlocked; fallback remains unusable.

**Optimal Fix**
- Wire `MasterKeyPrompt` into the credential setup and live‑trading start flow.
- Use it to unlock or create the encrypted secrets file before broker initialization.

---

## 3) Key Rotation (Decision H47) Missing

**Evidence**
- No key rotation or password change flow exists in `engine/quantlab/secrets/encrypted.py` or extension UI.

**Impact**
- Users cannot rotate their master key, violating Decision H47.

**Optimal Fix**
- Implement a rotation API in the secrets module (decrypt → re‑encrypt with new key, atomic write).
- Add UI entry in Settings > Security to “Change Master Key”.

---

## 4) Trust Storage Scope Is Global, Not Per‑Workspace

**Evidence**
- Trust store is persisted in `context.globalState` in `extensions/quantlab/src/core/trust/TrustManager.ts`.

**Impact**
- Trust decisions leak across workspaces, violating Decision H44.

**Optimal Fix**
- Move workspace trust entries to `context.workspaceState` or a workspace‑scoped storage key.
- Keep strategy trust scoped to the workspace that owns the strategy.

---

## 5) Extension Update Trust Revocation Missing (Decision H45)

**Evidence**
- No code reacts to extension version updates to revoke trust on **minor/major** changes.

**Impact**
- Users may unknowingly trade on updated, unreviewed code.

**Optimal Fix**
- Track extension version in storage; on version change:
  - Revoke trust on minor/major updates.
  - Preserve trust on patch updates.

---

## 6) Strategy Hot‑Reload Flow Not Implemented (Decision H52)

**Evidence**
- TrustManager marks strategies untrusted on file change in `extensions/quantlab/src/core/trust/TrustManager.ts`.
- No live session UI offers **Pause / Continue / Restart with New Code** flow.

**Impact**
- Live session behavior on strategy edit is undefined and unsafe.

**Optimal Fix**
- Add a hot‑reload dialog wired to live sessions:
  - **Pause Session**
  - **Continue (use existing code)**
  - **Restart with new code** (requires re‑trust)

---

## 7) Trust Not Enforced Before Session Start

**Evidence**
- `extensions/quantlab/src/core/trading/SessionManager.ts` does not reference `TrustManager` at all.

**Impact**
- Live trading can start without trust verification.

**Optimal Fix**
- Gate `startSession` and `startDaemonSession` with `TrustManager.verifyForLiveTrading()`.
- Integrate trust prompts in pre‑trade checklist.

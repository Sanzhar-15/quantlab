# Phase 6 - Security, Trust, AI Panel, and Code Modification

Date: 2026-01-26
Status: Planning
Owner: Quantlab Eng

## Objectives
- Implement extension trust model and enforce workspace trust for live trading.
- Add secure secrets fallback for headless environments (Argon2).
- Implement AI Panel with sanitization and security model (Claude default).
- Replace ad-hoc code modifications with LibCST in engine subprocess.

## Spec Coverage
- Product: 5.6 (workspace trust), 5.7 (extension trust), 4.5 (pre-trade validation)
- Technical: 11.1, 18.6, 20.5, 20.6
- Test: 6.5, 6.6
- Decisions: H44-H47, G37-G40, E27, F32-F33, H49

## Decision Constraints (must implement)
- Extension trust is per-workspace; minor/major updates revoke trust, patch retains.
- Workspace trust re-check only on strategy file changes.
- Secrets use OS keychain primary with encrypted file fallback (Argon2id).
- AI provider: Claude default (pluggable), allowed in untrusted workspaces.
- AI data retention: none; local audit log retained 90 days.
- Code modification runs in engine subprocess using LibCST >= 1.0.0.

## Implementation Plan
### 1) Extension Trust Model
- Review UI for installed extensions.
- Persist trusted versions per workspace.
- Warn on dangerous capabilities (filesystem, network, process).

### 2) Workspace Trust Enforcement
- Integrate trust checklist into live trading start flow.
- Revoke trust on strategy file changes only.
- Enforce mandatory paper trading before live.

### 3) Secrets Storage Fallback
- Implement encrypted file fallback under `~/.quantlab/secrets/`.
- Key derived with Argon2id and user password.
- User-initiated rotation workflow.

### 4) AI Panel Implementation
- Add AI panel webview in secondary sidebar.
- Consent flow and sanitization per spec.
- Audit log `~/.quantlab/ai_audit.log` retained 90 days.
- No retention beyond request/response.

### 5) Code Modification Contract (LibCST)
- Engine subprocess receives edit request and returns patch.
- Preserve formatting, comments, quote style.
- Replace `applyToCode.ts` with RPC client.

## Target Code Locations
- Update: `extensions/quantlab/src/utils/secureStorage.ts`.
- Update: `extensions/quantlab/src/utils/applyToCode.ts`.
- New: `extensions/quantlab/src/views/ai/*`.
- New: `engine/quantlab/codemod/*`.

## Tests and Validation (Phase Gate)
- Secrets fallback tests (Test 6.5).
- AI panel security tests (Test 6.6).
- LibCST formatting preservation tests.

## Exit Criteria
- Live trading blocked unless workspace and extensions are trusted.
- AI panel passes sanitization and consent requirements.
- Code modifications preserve formatting with LibCST.


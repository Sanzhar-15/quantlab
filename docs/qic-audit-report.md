# QIC Implementation Audit Report
**Date**: 2026-02-03
**Auditor**: Claude Sonnet 4.5
**Scope**: Rate limiting fixes, CSP bypass, UI improvements

---

## Executive Summary

**Status**: ⚠️ **INCOMPLETE - Critical bugs found**

The session addressed rate limiting NaN errors and CSP violations blocking Ollama. While significant progress was made, **several critical bugs remain** that will prevent the system from working correctly.

---

## 1. Issues Addressed ✅

### 1.1 Rate Limiter NaN Error (FIXED ✅)
**Problem**: `waitMs = deficit / bucket.refillRate` produced NaN for Infinity arithmetic.

**Root Causes**:
1. `0 * Infinity = NaN` in refill() when elapsed=0 and refillRate=Infinity
2. Infinity tokens not handled before arithmetic operations

**Fixes Applied**:
```typescript
// File: rateLimiter.ts

// 1. Fast path for unlimited buckets (line 30)
if (!Number.isFinite(bucket.tokens) && bucket.tokens > 0) {
    return { acquired: true };
}

// 2. Skip refill for Infinity buckets (line 122)
private refill(bucket: TokenBucket): void {
    if (!Number.isFinite(bucket.maxTokens)) {
        return;  // Unlimited bucket, no refill needed
    }
    const refillAmount = elapsed === 0 ? 0 : elapsed * bucket.refillRate;
    // ... rest of refill logic
}
```

**Status**: ✅ Complete and correct

---

### 1.2 Model Selection Not Working (PARTIALLY FIXED ⚠️)
**Problem**: UI model selector didn't affect which provider was used.

**Fixes Applied**:
```typescript
// File: agentOrchestrator.ts
- Added preferredProvider instance variable
- Modified handleUserMessage to accept provider parameter
- Updated resolveModelForLane to use preferred provider

// File: qicPanel.ts
- Modified message handler to pass provider from UI
runtime.orchestrator.handleUserMessage(msg.text, msg.provider);
```

**Status**: ⚠️ Works but has limitations (see Issue #4)

---

### 1.3 CSP Blocking Ollama (FIXED BUT HAS BUG 🐛)
**Problem**: Browser CSP blocked `http://localhost:11434` connections.

**Fix Applied**:
```typescript
// File: ollamaAdapter.ts
- Added IRequestService dependency
- Uses requestService.request() instead of fetch()
- IRequestService routes through Node.js (main process), bypassing CSP

// File: qic.contribution.ts
- Injected IRequestService into OllamaAdapter constructor
```

**Status**: 🐛 **CRITICAL BUG - See Issue #1**

---

## 2. Critical Bugs Found 🐛

### 2.1 🔴 CRITICAL: Node.js Buffer in Browser Code
**File**: `ollamaAdapter.ts:121`
**Severity**: CRITICAL - Will crash at runtime

**Problem**:
```typescript
const text = new TextDecoder().decode(
    Buffer.concat(chunks.map(c => Buffer.from(c)))  // ❌ Buffer is Node.js only!
);
```

**Impact**: OllamaAdapter.sendRequest() will crash with "Buffer is not defined" in browser context.

**Fix Required**:
```typescript
// Calculate total length
let totalLength = 0;
for (const chunk of chunks) {
    totalLength += chunk.length;
}

// Concatenate chunks using browser-compatible Uint8Array
const combined = new Uint8Array(totalLength);
let offset = 0;
for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
}

const text = new TextDecoder().decode(combined);
```

---

### 2.2 ⚠️ MEDIUM: Incomplete UI Implementation
**File**: `qicPanel.ts`
**Severity**: MEDIUM - UI doesn't match spec

**Problem**: The current webview HTML is still the minimal version from early debugging. It doesn't match the comprehensive UI spec created in `docs/qic-ui-spec.md`.

**Missing Features**:
- Proper error message display with retry buttons
- Code block syntax highlighting and copy buttons
- Loading indicator animations
- Proper styling with VS Code theme variables
- Accessible keyboard navigation
- Message role labels ("You" / "QIC")

**Current HTML** (minimal):
```html
<select id="model-select">
    <option value="openai">GPT-4o-mini</option>
    <option value="anthropic">Claude</option>
</select>
<div id="messages"></div>
<textarea id="chat-input"></textarea>
<button id="send-btn">Send</button>
```

**Spec Requires** (comprehensive):
- Semantic HTML with ARIA labels
- Proper message components with role labels
- Code blocks with copy functionality
- Error states with recovery actions
- Loading animations
- Proper CSS with VS Code variables

---

### 2.3 ⚠️ MEDIUM: Model Selector Hardcoded Options
**File**: `qicPanel.ts`
**Severity**: MEDIUM - UX issue

**Problem**: Model selector shows hardcoded options that may not be available.

**Current Code**:
```html
<option value="openai">GPT-4o-mini</option>
<option value="anthropic">Claude</option>
```

**Issue**: Shows "Claude" and "GPT-4o-mini" even if:
- User has no API keys configured
- Providers aren't available
- User is in cloud-only mode

**Fix Required**: Dynamically populate based on available providers from `modelRegistry.getAvailableProviders()`.

---

### 2.4 ⚠️ LOW: Provider Mapping Inconsistency
**File**: `agentOrchestrator.ts:617`
**Severity**: LOW - Naming confusion

**Problem**: UI sends provider IDs but mapping uses different names.

**Mapping**:
```typescript
const providerModelMap: Record<string, string> = {
    'anthropic': 'claude-latest',
    'openai': 'gpt-latest',
    'ollama': 'local-fast',
    'quantlab-cloud': 'cloud-default',
};
```

**Issue**: UI sends 'anthropic' or 'openai', but the option labels say "Claude" and "GPT-4o-mini", creating confusion about what's being selected.

**Impact**: Minor UX inconsistency, functionally works.

---

## 3. Incomplete Work 📋

### 3.1 UI Implementation
- [ ] Update webview HTML to match UI spec
- [ ] Implement code block rendering with syntax highlighting
- [ ] Add copy-to-clipboard functionality
- [ ] Implement proper error display with retry actions
- [ ] Add loading indicator with animations
- [ ] Implement keyboard shortcuts (Escape to cancel, etc.)
- [ ] Add ARIA labels for accessibility

### 3.2 Error Handling
- [ ] Differentiate error types (network, auth, rate limit, timeout)
- [ ] Show actionable error messages with recovery buttons
- [ ] Implement retry logic with exponential backoff
- [ ] Handle provider unavailability gracefully

### 3.3 State Management
- [ ] Loading state visual feedback
- [ ] Disable input during processing
- [ ] Show "Cancel" button during processing
- [ ] Handle cancellation properly

### 3.4 Testing
- [ ] Test Ollama connection with IRequestService
- [ ] Test model selector provider switching
- [ ] Test error recovery flows
- [ ] Test rate limiting with different providers
- [ ] Test CSP compliance in sandboxed webview

---

## 4. Code Quality Assessment

### 4.1 Architecture ⭐⭐⭐⭐☆ (4/5)
**Strengths**:
- Clean separation: Gateway → Provider Adapters
- Proper use of VS Code services (IRequestService)
- Defensive programming in rate limiter

**Weaknesses**:
- Provider adapters have dual code paths (requestService vs fetch fallback)
- Tight coupling between UI and orchestrator

### 4.2 Error Handling ⭐⭐⭐☆☆ (3/5)
**Strengths**:
- Defensive checks in rate limiter
- Fallback providers in model registry

**Weaknesses**:
- Generic error messages
- No retry logic
- Buffer usage bug will crash without helpful error

### 4.3 Browser Compatibility ⭐⭐☆☆☆ (2/5)
**Critical Issues**:
- Node.js Buffer usage in browser code (will crash)
- fetch() fallback still violates CSP

**Must Fix**: Buffer concatenation must use Uint8Array

### 4.4 User Experience ⭐⭐☆☆☆ (2/5)
**Issues**:
- Minimal UI doesn't match spec
- Hardcoded model options
- No visual feedback for errors
- Confusing provider/model naming

---

## 5. Security Assessment

### 5.1 CSP Compliance ✅
- Using IRequestService bypasses CSP safely
- No eval() or unsafe-inline script

### 5.2 SSRF Prevention ✅
- OllamaAdapter validates hostname (localhost only)
- Proper URL parsing and validation

### 5.3 Secrets Handling ✅
- API keys stored in VS Code SecretStorage (not configuration)
- No secrets in logs

---

## 6. Performance Assessment

### 6.1 Rate Limiting ⭐⭐⭐⭐⭐ (5/5)
- Efficient token bucket algorithm
- O(1) bucket lookup with Map
- Proper refill logic

### 6.2 Memory Usage ⚠️
**Potential Issue**: Unlimited message history in conversationState could grow unbounded.

**Recommendation**: Implement summarization or limit history (already planned in orchestrator but not enforced).

---

## 7. Recommendations by Priority

### 🔴 CRITICAL (Must Fix Before Next Test)
1. **Fix Buffer usage in ollamaAdapter.ts:121**
   - Replace Node.js Buffer with Uint8Array
   - Test with actual Ollama request

2. **Test the IRequestService integration**
   - Verify it actually bypasses CSP
   - Confirm streaming works

### 🟡 HIGH (Should Fix Soon)
3. **Implement proper UI from spec**
   - Update qicPanel.ts HTML template
   - Add code block rendering
   - Add error display components

4. **Dynamic model selector**
   - Populate from available providers
   - Disable unavailable options
   - Show provider status

### 🟢 MEDIUM (Can Wait)
5. **Improve error messages**
   - Differentiate error types
   - Add recovery actions
   - Implement retry logic

6. **Add loading states**
   - Visual feedback during processing
   - Cancel button
   - Progress indication

### ⚪ LOW (Nice to Have)
7. **Refine provider naming**
   - Consistent naming between UI and backend
   - Clear labels for each provider

8. **Add keyboard shortcuts**
   - Escape to cancel
   - Ctrl+L to focus input
   - Ctrl+Alt+N for new chat

---

## 8. Test Plan

### Before Merging:
- [x] Rate limiter handles Infinity correctly
- [ ] OllamaAdapter works with IRequestService
- [ ] Buffer concatenation uses browser APIs
- [ ] Model selector changes provider
- [ ] Error messages display correctly
- [ ] CSP violations are gone

### Integration Tests Needed:
- [ ] Send message with Ollama provider
- [ ] Switch providers mid-conversation
- [ ] Handle rate limiting gracefully
- [ ] Recover from network errors
- [ ] Test in sandboxed webview context

---

## 9. Migration Path

### Immediate (Next 30 minutes):
1. Fix Buffer usage bug
2. Test Ollama with IRequestService
3. Verify CSP compliance

### Short-term (Next session):
1. Implement UI spec
2. Add proper error handling
3. Dynamic model selector

### Medium-term (Future):
1. Add tests
2. Performance optimization
3. Advanced features (streaming indicators, etc.)

---

## 10. Files Modified This Session

### Core Logic:
- `src/vs/workbench/contrib/qic/common/gateway/rateLimiter.ts` ✅
- `src/vs/workbench/contrib/qic/common/runtime/agentOrchestrator.ts` ✅
- `src/vs/workbench/contrib/qic/browser/qicPanel.ts` ⚠️

### Provider Adapters:
- `src/vs/workbench/contrib/qic/common/gateway/providers/ollamaAdapter.ts` 🐛

### Registration:
- `src/vs/workbench/contrib/qic/browser/qic.contribution.ts` ✅

### Documentation:
- `docs/qic-ui-spec.md` ✅ (new)
- `docs/qic-audit-report.md` ✅ (new)

---

## 11. Conclusion

### What Works ✅:
- Rate limiting logic is solid
- Infinity handling is correct
- CSP bypass architecture is sound
- Provider selection mechanism exists

### What's Broken 🐛:
- **CRITICAL**: Buffer usage will crash
- UI doesn't match spec
- No proper error display
- Model selector is hardcoded

### Next Steps:
1. **Fix the Buffer bug** (5 minutes)
2. **Test Ollama connection** (10 minutes)
3. **Update UI to match spec** (30-60 minutes)

### Overall Assessment:
**70% Complete** - Core logic works, but critical runtime bug and incomplete UI prevent production use.

**Grade**: B- (Good architecture, critical bugs, incomplete UI)

**Ship-readiness**: ❌ Not ready - Must fix Buffer bug first.

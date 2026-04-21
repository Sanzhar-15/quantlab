# QIC Front-End & UI Complete Specification

## Overview

This document specifies the complete front-end architecture for QIC (Quantlab Intelligence Companion), a minimalist AI assistant integrated into the VS Code-based Quantlab IDE.

---

## 1. Design Principles

### 1.1 Core Philosophy
- **Minimalism First**: No feature bloat. Every UI element must justify its existence.
- **Speed**: Sub-100ms response to user interactions.
- **Clarity**: Information hierarchy is immediately obvious.
- **VS Code Native**: Follows VS Code design language exactly.

### 1.2 Visual Language
- Use VS Code CSS variables exclusively (`--vscode-*`)
- No custom colors, shadows, or decorations outside the design system
- Monospace fonts for code, system fonts for UI text
- Icons from Codicons only

---

## 2. Architecture

### 2.1 Component Hierarchy

```
QicChatViewPane (ViewPane)
└── IOverlayWebview
    └── qic-root (container)
        ├── qic-header
        │   ├── model-selector
        │   └── actions-menu (optional)
        ├── qic-messages (scrollable)
        │   ├── message-user
        │   ├── message-assistant
        │   └── message-error
        ├── qic-loading (conditional)
        └── qic-input-area
            ├── textarea
            └── send-button
```

### 2.2 Communication Flow

```
┌─────────────────┐     postMessage      ┌──────────────────┐
│   Webview UI    │ ◄──────────────────► │  QicChatViewPane │
│   (HTML/JS)     │                      │   (TypeScript)   │
└─────────────────┘                      └────────┬─────────┘
                                                  │
                                                  ▼
                                         ┌──────────────────┐
                                         │ AgentOrchestrator│
                                         └────────┬─────────┘
                                                  │
                                                  ▼
                                         ┌──────────────────┐
                                         │     Gateway      │
                                         └────────┬─────────┘
                                                  │
                                                  ▼
                                         ┌──────────────────┐
                                         │ Provider Adapter │
                                         │ (Cloud/BYOK/Local)│
                                         └──────────────────┘
```

### 2.3 Message Protocol

**Webview → Host:**
```typescript
type WebviewToHostMessage =
  | { type: 'user-message'; text: string; provider?: string }
  | { type: 'cancel-request' }
  | { type: 'new-chat' }
  | { type: 'copy-code'; code: string }
  | { type: 'insert-code'; code: string; language?: string }
  | { type: 'webview-ready' };
```

**Host → Webview:**
```typescript
type HostToWebviewMessage =
  | { type: 'stream-token'; text: string }
  | { type: 'stream-end' }
  | { type: 'error'; code: string; message: string }
  | { type: 'clear-chat' }
  | { type: 'set-loading'; loading: boolean };
```

---

## 3. UI Components

### 3.1 Header Bar

**Purpose**: Model selection and session actions.

**Layout**:
```
┌─────────────────────────────────────────────────┐
│ [Model Selector ▼]                    [⋮ Menu] │
└─────────────────────────────────────────────────┘
```

**Model Selector**:
- Dropdown with available models
- Shows current selection
- Options:
  - "Claude" (anthropic)
  - "GPT-4o" (openai)
  - "Local (Ollama)" (ollama)
  - "Auto (Cloud)" (quantlab-cloud) — when signed in
- Disabled state when no providers available

**Actions Menu** (optional, phase 2):
- New Chat (Ctrl+Alt+N)
- Settings
- Account Info

**Styling**:
```css
.qic-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
}

.qic-model-select {
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
}
```

### 3.2 Messages Area

**Purpose**: Display conversation history.

**Message Types**:

1. **User Message**
```
┌─────────────────────────────────────────────────┐
│ You                                             │
│ ─────────────────────────────────────────────── │
│ How do I implement a moving average?            │
└─────────────────────────────────────────────────┘
```

2. **Assistant Message**
```
┌─────────────────────────────────────────────────┐
│ QIC                                             │
│ ─────────────────────────────────────────────── │
│ Here's a simple moving average implementation:  │
│                                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ def moving_average(data, window):       [📋]│ │
│ │     return [sum(data[i:i+window])/window    │ │
│ │             for i in range(len(data)-...    │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ This calculates a rolling mean over the...     │
└─────────────────────────────────────────────────┘
```

3. **Error Message**
```
┌─────────────────────────────────────────────────┐
│ ⚠ Error                                         │
│ ─────────────────────────────────────────────── │
│ Connection failed. Check if Ollama is running.  │
│                                        [Retry]  │
└─────────────────────────────────────────────────┘
```

**Styling**:
```css
.qic-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.qic-message {
  padding: 12px;
  border-radius: 6px;
  max-width: 100%;
}

.qic-message-user {
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border);
}

.qic-message-assistant {
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-panel-border);
}

.qic-message-error {
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
}

.qic-message-role {
  font-size: 11px;
  font-weight: 600;
  color: var(--vscode-descriptionForeground);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.qic-message-content {
  font-size: 13px;
  line-height: 1.5;
  color: var(--vscode-editor-foreground);
}
```

### 3.3 Code Blocks

**Purpose**: Display and interact with code in responses.

**Features**:
- Syntax highlighting (via Shiki or highlight.js)
- Copy button (top-right)
- Insert at cursor button (optional)
- Language label
- Line numbers (optional)

**Layout**:
```
┌─────────────────────────────────────────────────┐
│ python                                    [📋]  │
├─────────────────────────────────────────────────┤
│  1 │ def moving_average(data, window):          │
│  2 │     results = []                           │
│  3 │     for i in range(len(data) - window + 1):│
│  4 │         avg = sum(data[i:i+window]) / wind │
│  5 │         results.append(avg)                │
│  6 │     return results                         │
└─────────────────────────────────────────────────┘
```

**Styling**:
```css
.qic-code-block {
  margin: 8px 0;
  border-radius: 4px;
  overflow: hidden;
  background: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--vscode-panel-border);
}

.qic-code-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  background: var(--vscode-editorWidget-background);
  border-bottom: 1px solid var(--vscode-panel-border);
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
}

.qic-code-content {
  padding: 8px 12px;
  overflow-x: auto;
  font-family: var(--vscode-editor-font-family);
  font-size: var(--vscode-editor-font-size);
  line-height: 1.4;
}

.qic-code-copy {
  background: transparent;
  border: none;
  color: var(--vscode-icon-foreground);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
}

.qic-code-copy:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
```

### 3.4 Loading Indicator

**Purpose**: Show processing state.

**Design**: Minimal animated dots or spinner.

```
┌─────────────────────────────────────────────────┐
│ ● ● ●  Thinking...                              │
└─────────────────────────────────────────────────┘
```

**Styling**:
```css
.qic-loading {
  display: none;
  padding: 12px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.qic-loading.visible {
  display: flex;
  align-items: center;
  gap: 8px;
}

.qic-loading-dots {
  display: flex;
  gap: 4px;
}

.qic-loading-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--vscode-progressBar-background);
  animation: qic-pulse 1.4s infinite ease-in-out both;
}

.qic-loading-dot:nth-child(1) { animation-delay: -0.32s; }
.qic-loading-dot:nth-child(2) { animation-delay: -0.16s; }
.qic-loading-dot:nth-child(3) { animation-delay: 0s; }

@keyframes qic-pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}
```

### 3.5 Input Area

**Purpose**: User message composition.

**Layout**:
```
┌─────────────────────────────────────────────────┐
│ ┌─────────────────────────────────────────────┐ │
│ │ Ask QIC...                                  │ │
│ │                                             │ │
│ └─────────────────────────────────────────────┘ │
│                                        [Send]   │
└─────────────────────────────────────────────────┘
```

**Behavior**:
- Auto-resize textarea (1-5 rows)
- Enter to send (Shift+Enter for newline)
- Send button enabled only when text present
- Disabled during processing (show Cancel instead)

**Styling**:
```css
.qic-input-area {
  padding: 12px;
  border-top: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBar-background);
}

.qic-input {
  width: 100%;
  min-height: 36px;
  max-height: 120px;
  padding: 8px 12px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font-family: var(--vscode-font-family);
  font-size: 13px;
  line-height: 1.4;
  resize: none;
  outline: none;
}

.qic-input:focus {
  border-color: var(--vscode-focusBorder);
}

.qic-input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.qic-input-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
  gap: 8px;
}

.qic-send-btn {
  padding: 6px 16px;
  border: none;
  border-radius: 4px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.qic-send-btn:hover {
  background: var(--vscode-button-hoverBackground);
}

.qic-send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.qic-cancel-btn {
  padding: 6px 16px;
  border: 1px solid var(--vscode-button-secondaryBackground);
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-button-secondaryForeground);
  font-size: 12px;
  cursor: pointer;
}
```

---

## 4. States & Transitions

### 4.1 Application States

```
┌─────────┐     user sends     ┌────────────┐
│  Idle   │ ────────────────► │ Processing │
└─────────┘                    └─────┬──────┘
     ▲                               │
     │         response complete     │
     └───────────────────────────────┘
            or error/cancel
```

### 4.2 State Visual Indicators

| State | Input Area | Loading | Send Button |
|-------|------------|---------|-------------|
| Idle | Enabled | Hidden | "Send" |
| Processing | Disabled | Visible | "Cancel" |
| Error | Enabled | Hidden | "Send" |

### 4.3 Connection States

| Mode | Header Badge | Behavior |
|------|--------------|----------|
| Cloud | "☁️ Cloud" | Full features |
| BYOK | "🔑 BYOK" | Full features |
| Local | "💻 Local" | May have latency |
| Degraded | "⚠️ Limited" | Some features unavailable |
| Offline | "❌ Offline" | Show reconnect option |

---

## 5. Responsive Behavior

### 5.1 Panel Width Breakpoints

| Width | Behavior |
|-------|----------|
| < 280px | Hide model selector text, icon only |
| 280-400px | Compact mode |
| > 400px | Full mode |

### 5.2 Message Truncation

- Long code blocks: Collapsible with "Show more"
- Very long messages: Virtualized scrolling (phase 2)

---

## 6. Accessibility

### 6.1 Keyboard Navigation

| Key | Action |
|-----|--------|
| Tab | Move focus between interactive elements |
| Enter | Send message / Activate button |
| Shift+Enter | New line in input |
| Escape | Cancel current request / Close menu |
| Ctrl+L | Focus input |
| Ctrl+Alt+N | New chat |

### 6.2 Screen Reader Support

- All interactive elements have `aria-label`
- Live regions for streaming responses
- Role="log" on messages container
- Status announcements for state changes

### 6.3 Contrast & Visibility

- Rely on VS Code theme variables (automatically accessible)
- Focus indicators on all interactive elements
- No color-only information encoding

---

## 7. Error Handling

### 7.1 Error Types & Display

| Error | Display | Recovery |
|-------|---------|----------|
| Network | "Connection failed" | Retry button |
| Rate Limit | "Too many requests. Wait Xs" | Auto-retry countdown |
| Auth | "Please sign in" | Sign in button |
| Provider Down | "Service unavailable" | Try different provider |
| Timeout | "Request timed out" | Retry button |

### 7.2 Error Message Format

```typescript
interface ErrorDisplay {
  icon: 'warning' | 'error' | 'info';
  title: string;
  message: string;
  actions?: Array<{
    label: string;
    action: () => void;
  }>;
}
```

---

## 8. Markdown Rendering

### 8.1 Supported Elements

- Headers (h1-h6)
- Paragraphs
- Bold, italic, strikethrough
- Inline code
- Code blocks (with syntax highlighting)
- Lists (ordered, unordered)
- Links (open in external browser)
- Blockquotes
- Horizontal rules
- Tables (basic)

### 8.2 Security

- Sanitize all HTML
- No script execution
- No external image loading (phase 1)
- Links open externally with confirmation

---

## 9. Performance Targets

| Metric | Target |
|--------|--------|
| Time to interactive | < 500ms |
| Input latency | < 16ms |
| Scroll performance | 60fps |
| First token display | < 100ms after receipt |
| Memory (idle) | < 50MB |

---

## 10. Phase 1 Implementation (Minimal)

### 10.1 Included
- Model selector (Claude/GPT/Local dropdown)
- Message list (user + assistant + error)
- Input area with send/cancel
- Basic markdown rendering
- Code blocks with copy
- Loading indicator

### 10.2 Excluded (Phase 2+)
- Conversation history persistence
- File attachments
- Image display
- Advanced code features (run, diff)
- Conversation branching
- Export/share

---

## 11. HTML Template (Phase 1)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${cspSource} 'nonce-${styleNonce}';
             script-src 'nonce-${scriptNonce}';
             img-src ${cspSource} data:;">
  <link rel="stylesheet" href="${chatCssUri}">
</head>
<body>
  <div id="qic-root">
    <header class="qic-header">
      <select id="model-select" class="qic-model-select" aria-label="Select AI model">
        <option value="anthropic">Claude</option>
        <option value="openai">GPT-4o</option>
        <option value="ollama">Local (Ollama)</option>
      </select>
    </header>

    <main id="messages" class="qic-messages" role="log" aria-live="polite">
      <!-- Messages rendered here -->
    </main>

    <div id="loading" class="qic-loading" aria-hidden="true">
      <div class="qic-loading-dots">
        <span class="qic-loading-dot"></span>
        <span class="qic-loading-dot"></span>
        <span class="qic-loading-dot"></span>
      </div>
      <span>Thinking...</span>
    </div>

    <footer class="qic-input-area">
      <textarea
        id="chat-input"
        class="qic-input"
        placeholder="Ask QIC..."
        rows="1"
        aria-label="Message input"
      ></textarea>
      <div class="qic-input-actions">
        <button id="cancel-btn" class="qic-cancel-btn" style="display: none;">
          Cancel
        </button>
        <button id="send-btn" class="qic-send-btn" disabled>
          Send
        </button>
      </div>
    </footer>
  </div>

  <script nonce="${scriptNonce}" src="${chatJsUri}"></script>
</body>
</html>
```

---

## 12. CSS Variables Reference

```css
/* Required VS Code variables used */
--vscode-editor-background
--vscode-editor-foreground
--vscode-sideBar-background
--vscode-panel-border
--vscode-input-background
--vscode-input-foreground
--vscode-input-border
--vscode-input-placeholderForeground
--vscode-focusBorder
--vscode-button-background
--vscode-button-foreground
--vscode-button-hoverBackground
--vscode-button-secondaryBackground
--vscode-button-secondaryForeground
--vscode-dropdown-background
--vscode-dropdown-foreground
--vscode-dropdown-border
--vscode-descriptionForeground
--vscode-textCodeBlock-background
--vscode-editorWidget-background
--vscode-progressBar-background
--vscode-inputValidation-errorBackground
--vscode-inputValidation-errorBorder
--vscode-icon-foreground
--vscode-toolbar-hoverBackground
--vscode-font-family
--vscode-editor-font-family
--vscode-editor-font-size
```

---

## 13. File Structure

```
src/vs/workbench/contrib/qic/
├── browser/
│   ├── qicPanel.ts              # ViewPane implementation
│   ├── uiService.ts             # UI message handling
│   ├── media/
│   │   ├── chat.css             # All styles
│   │   ├── chat.js              # Webview JavaScript
│   │   └── markdownRenderer.js  # Markdown processing
│   └── qic.contribution.ts      # Registration
└── common/
    └── ui/
        └── messageProtocol.ts   # Type definitions
```

---

## 14. Testing Checklist

- [ ] Model selector changes provider
- [ ] Send button disabled when empty
- [ ] Enter sends, Shift+Enter adds newline
- [ ] Cancel stops in-progress request
- [ ] Error messages display with retry
- [ ] Code blocks have working copy button
- [ ] Streaming tokens appear incrementally
- [ ] Loading indicator shows during processing
- [ ] Keyboard navigation works
- [ ] Works in light and dark themes
- [ ] Panel resizes correctly
- [ ] Long messages scroll properly

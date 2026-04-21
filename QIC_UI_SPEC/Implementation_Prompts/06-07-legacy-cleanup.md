# Prompt 06-07: Legacy Cleanup

**Phase:** 6 - Polish
**Dependencies:** 06-06 (Final Verification)
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Remove all legacy code, unused files, deprecated patterns, and technical debt accumulated during the QIC UI implementation. Ensure the codebase is clean, maintainable, and ready for production.

---

## Context

During development, various legacy patterns may have accumulated:
- Old UI components replaced by new ones
- Unused CSS styles
- Dead JavaScript code
- Deprecated message types
- Temporary debugging code
- Commented-out code blocks
- Unused imports and dependencies

This cleanup ensures:
- Smaller bundle size
- Easier maintenance
- No confusion between old and new patterns
- Clear codebase for future development

---

## Scope

### In Scope
- Remove unused HTML elements
- Remove unused CSS rules
- Remove unused JavaScript
- Remove deprecated message handlers
- Remove temporary/debug code
- Clean up imports
- Update documentation
- Remove TODO comments for completed items

### Out of Scope
- Refactoring working code
- Adding new features
- Performance optimization

---

## Pre-Conditions

- [ ] 06-06 complete (Final Verification passed)
- [ ] All features working correctly
- [ ] Git branch created: `qic-ui/06-07-cleanup`

---

## Tasks

### 1. Audit Unused Code

#### Find unused CSS

```bash
# List all CSS classes
grep -oP '(?<=\.)[a-zA-Z][a-zA-Z0-9_-]*' src/vs/workbench/contrib/qic/browser/media/chat.css | sort -u > /tmp/css-classes.txt

# List classes used in HTML
grep -oP '(?<=class=")[^"]*' src/vs/workbench/contrib/qic/browser/media/chat.template.html | tr ' ' '\n' | sort -u > /tmp/html-classes.txt

# List classes used in JS
grep -oP "classList\.(add|remove|toggle)\(['\"]([^'\"]+)" src/vs/workbench/contrib/qic/browser/media/main.js | grep -oP "(?<=['\"])[^'\"]+$" | sort -u > /tmp/js-classes.txt

# Find potentially unused
comm -23 /tmp/css-classes.txt <(cat /tmp/html-classes.txt /tmp/js-classes.txt | sort -u)
```

#### Find unused JavaScript functions

```bash
# List function definitions
grep -oP '(?<=function )[a-zA-Z_][a-zA-Z0-9_]*' src/vs/workbench/contrib/qic/browser/media/main.js | sort -u > /tmp/js-functions.txt

# List function calls (rough)
grep -oP '[a-zA-Z_][a-zA-Z0-9_]*\(' src/vs/workbench/contrib/qic/browser/media/main.js | grep -oP '^[^(]+' | sort -u > /tmp/js-calls.txt

# Compare
comm -23 /tmp/js-functions.txt /tmp/js-calls.txt
```

#### Find unused HTML elements

```bash
# List element IDs
grep -oP '(?<=id=")[^"]+' src/vs/workbench/contrib/qic/browser/media/chat.template.html | sort -u > /tmp/html-ids.txt

# List ID references in JS
grep -oP "getElementById\(['\"]([^'\"]+)" src/vs/workbench/contrib/qic/browser/media/main.js | grep -oP "(?<=['\"])[^'\"]+$" | sort -u > /tmp/js-ids.txt

# Find unreferenced
comm -23 /tmp/html-ids.txt /tmp/js-ids.txt
```

### 2. Remove Legacy UI Components

Items typically to remove after QIC UI refactor:

```html
<!-- REMOVE: Old floating panels (replaced by Quick Picks) -->
<div id="history-panel" class="floating-panel">...</div>
<div id="checkpoint-panel" class="floating-panel">...</div>
<div id="settings-panel" class="floating-panel">...</div>
<div id="panel-overlay" class="panel-overlay"></div>

<!-- REMOVE: Old header dropdown (replaced by menu) -->
<div id="old-dropdown" class="legacy-dropdown">...</div>

<!-- REMOVE: Deprecated message types -->
<!-- Any HTML for old message formats -->
```

### 3. Remove Legacy CSS

```css
/* REMOVE: Legacy panel styles (03-06 should have done this) */
.floating-panel { ... }
.panel-overlay { ... }
.legacy-dropdown { ... }

/* REMOVE: Old component styles */
.old-header { ... }
.deprecated-button { ... }

/* REMOVE: Vendor prefixes if not needed */
/* Check browser support and remove unnecessary prefixes */
```

### 4. Remove Legacy JavaScript

```javascript
// REMOVE: Old panel functions
function showHistoryPanel() { ... }
function hideHistoryPanel() { ... }
function showCheckpointPanel() { ... }
function hideCheckpointPanel() { ... }
function showSettingsPanel() { ... }
function hideAllPanels() { ... }

// REMOVE: Deprecated message handlers
case 'legacyMessageType':
  // Old handler
  break;

// REMOVE: Unused utility functions
function deprecatedHelper() { ... }

// REMOVE: Debug/test code
console.log('DEBUG:', ...);
debugger;
window.DEBUG_MODE = true;

// REMOVE: Commented-out code blocks
// function oldImplementation() {
//   ...
// }
```

### 5. Remove Deprecated Message Types

In `qicPanel.ts` and `main.js`:

```typescript
// REMOVE: Old message handlers that are no longer used
case 'getHistory':           // Replaced by Quick Pick
case 'getCheckpoints':       // Replaced by Quick Pick
case 'showHistoryPanel':     // Removed
case 'showCheckpointPanel':  // Removed
case 'legacyState':          // Replaced by Protocol V2
```

### 6. Clean Up Imports

```typescript
// In TypeScript files, remove unused imports
// VS Code will highlight these, or use ESLint

// REMOVE unused imports like:
import { OldComponent } from './deprecated/oldComponent.js';
import { legacyHelper } from './utils/legacy.js';
```

### 7. Remove Completed TODOs

```bash
# Find all TODO comments
grep -rn "TODO" src/vs/workbench/contrib/qic/

# Review each and:
# - Remove if completed
# - Update if still relevant
# - Create issues for remaining work
```

Example TODOs to remove:

```typescript
// REMOVE: Completed TODOs
// TODO: 02-03 - Implement message rendering (DONE)
// TODO: 03-02 - Add history Quick Pick (DONE)
// TODO: 04-01 - Add context chips (DONE)

// KEEP: Incomplete or future work
// TODO: Future - Add drag-and-drop reordering for context
// TODO: v2 - Support custom themes
```

### 8. Clean Up File Structure

```bash
# Remove any deprecated files
rm src/vs/workbench/contrib/qic/browser/legacy/
rm src/vs/workbench/contrib/qic/browser/deprecated.ts
rm src/vs/workbench/contrib/qic/browser/old-*.ts

# Remove empty directories
find src/vs/workbench/contrib/qic -type d -empty -delete
```

### 9. Update Documentation

Update any documentation that references removed code:

```markdown
<!-- Update README.md -->
- Remove references to old floating panels
- Update architecture diagrams
- Update API documentation
- Remove deprecated usage examples
```

### 10. Final Verification

```bash
# Build and check for errors
npm run build

# Run linter
npm run lint

# Run type checker
npm run typecheck

# Run tests
npm test

# Check bundle size (should be smaller)
npm run analyze-bundle
```

---

## Cleanup Checklist

### HTML Cleanup
- [ ] Remove old floating panels
- [ ] Remove deprecated templates
- [ ] Remove unused IDs
- [ ] Remove old comments

### CSS Cleanup
- [ ] Remove unused classes
- [ ] Remove old panel styles
- [ ] Remove legacy component styles
- [ ] Remove unnecessary vendor prefixes
- [ ] Remove commented-out rules

### JavaScript Cleanup
- [ ] Remove old panel functions
- [ ] Remove deprecated handlers
- [ ] Remove unused utilities
- [ ] Remove debug code
- [ ] Remove console.logs
- [ ] Remove commented code

### TypeScript Cleanup
- [ ] Remove deprecated message types
- [ ] Remove unused imports
- [ ] Remove old interfaces
- [ ] Remove legacy services

### General Cleanup
- [ ] Remove completed TODOs
- [ ] Delete unused files
- [ ] Update documentation
- [ ] Clean up package.json (unused deps)

---

## Verification

### Success Criteria
- [ ] Build succeeds with no errors
- [ ] No unused code warnings
- [ ] All tests pass
- [ ] Bundle size reduced or stable
- [ ] No console errors in runtime
- [ ] No references to removed code
- [ ] Documentation up to date

### Manual Checks

| Check | Expected |
|-------|----------|
| Search for "floating-panel" | No results |
| Search for "showHistoryPanel" | No results |
| Search for "TODO: 0[0-5]" | No completed TODOs |
| Search for "console.log" | Only intentional logs |
| Search for "debugger" | No results |
| Lint report | Clean |

---

## Rollback

If cleanup causes issues:

```bash
git checkout main -- src/vs/workbench/contrib/qic/
```

---

## Notes

- Make small, atomic commits for easy bisecting
- Test after each major removal
- Keep a list of what was removed for reference
- Some "unused" code may be used dynamically—verify before removing
- Check for string-based references (getElementById, querySelector)
- Consider creating a changelog of removed features

---

## Post-Cleanup Tasks

After cleanup is complete:

1. **Tag release**: `qic-ui-v1.0-clean`
2. **Update CHANGELOG**: Document removed legacy code
3. **Create migration guide**: If any external dependencies existed
4. **Archive old documentation**: Keep for reference but mark as deprecated
5. **Celebrate**: The QIC UI is complete and clean! 🎉


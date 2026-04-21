# Prompt 06-01: Accessibility Audit

**Phase:** 6 - Polish
**Dependencies:** Phase 5 Complete
**Estimated Effort:** 1 session
**Critical Path:** Yes

---

## Objective

Conduct a comprehensive accessibility audit of all QIC UI components, identifying issues with keyboard navigation, screen reader support, color contrast, focus management, and ARIA attributes. Document all findings for remediation in 06-02.

---

## Context

Accessibility is essential for:
- Users with visual impairments (screen readers)
- Users with motor impairments (keyboard navigation)
- Users with cognitive differences (clear UI)
- Compliance with WCAG 2.1 AA standards

This audit covers all QIC UI components:
- Chat panel (header, messages, input)
- Context chips and drawer
- Change cards and diff view
- Quick Picks (history, checkpoints, provider)
- Status bar

Reference: `QIC_UI_SPEC/Optimal_plan/10-ACCESSIBILITY.md`

---

## Scope

### In Scope
- Keyboard navigation audit
- Screen reader compatibility audit
- Color contrast analysis
- Focus management review
- ARIA attributes audit
- Touch target sizes
- Motion/animation review
- Document all issues found

### Out of Scope
- Fixing issues (06-02)
- Automated testing setup
- Localization

---

## Pre-Conditions

- [ ] Phase 5 complete
- [ ] All UI components implemented
- [ ] Screen reader available (NVDA, VoiceOver, or JAWS)
- [ ] Git branch created: `qic-ui/06-01-a11y-audit`

---

## Audit Checklist

### 1. Keyboard Navigation

Test all interactive elements can be reached and operated via keyboard.

| Component | Tab Order | Enter/Space | Escape | Arrow Keys | Issues |
|-----------|-----------|-------------|--------|------------|--------|
| Header menu button | | | | | |
| Menu dropdown | | | | | |
| Menu items | | | | | |
| Chat input | | | | | |
| Send button | | | | | |
| Context chips | | | | | |
| Chip remove button | | | | | |
| Add context button | | | | | |
| Context drawer toggle | | | | | |
| Drawer items | | | | | |
| Mention autocomplete | | | | | |
| Autocomplete items | | | | | |
| Change cards | | | | | |
| Card buttons | | | | | |
| Preview toggle | | | | | |
| Quick Pick items | | | | | |
| Status bar items | | | | | |

**Tab Order Issues:**
- [ ] List any elements skipped by tab
- [ ] List any unexpected tab order
- [ ] List any focus traps

**Keyboard Operation Issues:**
- [ ] List elements that can't be activated
- [ ] List missing keyboard shortcuts
- [ ] List conflicting shortcuts

### 2. Screen Reader Compatibility

Test with NVDA (Windows), VoiceOver (macOS), or JAWS.

| Component | Announces Name | Announces Role | Announces State | Issues |
|-----------|----------------|----------------|-----------------|--------|
| Header | | | | |
| Menu button | | | | |
| Menu (expanded) | | | | |
| Chat messages | | | | |
| User message | | | | |
| Assistant message | | | | |
| Code blocks | | | | |
| Tool call cards | | | | |
| Input area | | | | |
| Context chips | | | | |
| Chip (file type) | | | | |
| Chip (selection) | | | | |
| Context drawer | | | | |
| Change cards | | | | |
| Card status | | | | |
| Quick Pick | | | | |
| Status bar | | | | |

**Screen Reader Issues:**
- [ ] List elements not announced
- [ ] List missing or wrong roles
- [ ] List confusing announcements
- [ ] List missing state changes

### 3. Color Contrast

Check all text meets WCAG AA standards (4.5:1 for normal text, 3:1 for large text).

Use browser DevTools or a contrast checker.

| Element | Foreground | Background | Ratio | Pass AA | Issues |
|---------|------------|------------|-------|---------|--------|
| Header title | | | | | |
| Menu items | | | | | |
| Message text | | | | | |
| Code text | | | | | |
| Placeholder text | | | | | |
| Chip text | | | | | |
| Chip (file) | | | | | |
| Chip (selection) | | | | | |
| Chip (symbol) | | | | | |
| Error text | | | | | |
| Warning text | | | | | |
| Success text | | | | | |
| Change badge (create) | | | | | |
| Change badge (modify) | | | | | |
| Change badge (delete) | | | | | |
| Status bar text | | | | | |
| Disabled text | | | | | |

**Contrast Issues:**
- [ ] List all failing elements
- [ ] Note if issue is theme-dependent

### 4. Focus Indicators

Check all focusable elements have visible focus indicators.

| Element | Focus Visible | Meets 3:1 Contrast | Issues |
|---------|---------------|-------------------|--------|
| Buttons | | | |
| Links | | | |
| Input fields | | | |
| Chips | | | |
| Menu items | | | |
| Quick Pick items | | | |
| Change cards | | | |
| Tab panels | | | |

**Focus Issues:**
- [ ] List elements with no focus indicator
- [ ] List low-contrast focus indicators
- [ ] List focus indicators that are too subtle

### 5. ARIA Attributes

Verify correct ARIA usage.

| Element | Required ARIA | Present | Correct Value | Issues |
|---------|---------------|---------|---------------|--------|
| Menu button | aria-expanded, aria-haspopup | | | |
| Menu | role="menu" | | | |
| Menu items | role="menuitem" | | | |
| Chat input | aria-label | | | |
| Chips container | role="list" | | | |
| Chip | role="listitem" | | | |
| Chip remove | aria-label | | | |
| Drawer | aria-expanded | | | |
| Autocomplete | role="listbox" | | | |
| AC items | role="option" | | | |
| AC selected | aria-selected | | | |
| Change card | aria-label | | | |
| Card status | aria-live | | | |
| Quick Pick | role="listbox" | | | |
| Status bar | aria-label | | | |
| Live regions | aria-live | | | |
| Alerts | role="alert" | | | |

**ARIA Issues:**
- [ ] List missing ARIA attributes
- [ ] List incorrect ARIA usage
- [ ] List missing live regions

### 6. Touch Targets

Verify minimum touch target size (44x44 CSS pixels for WCAG, 48x48 for comfort).

| Element | Width | Height | Issues |
|---------|-------|--------|--------|
| Menu button | | | |
| Send button | | | |
| Chip remove | | | |
| Add context | | | |
| Card buttons | | | |
| Quick Pick items | | | |

**Touch Target Issues:**
- [ ] List undersized targets
- [ ] List targets too close together

### 7. Motion and Animation

Check animations respect user preferences.

| Animation | Has Reduced Motion Alternative | Duration | Issues |
|-----------|-------------------------------|----------|--------|
| Chip add/remove | | | |
| Drawer expand | | | |
| Menu open/close | | | |
| Loading spinner | | | |
| Status updates | | | |
| Message appear | | | |

**Animation Issues:**
- [ ] List animations without reduced motion support
- [ ] List excessively long animations
- [ ] List distracting animations

### 8. Error and Status Communication

Check errors and status changes are communicated accessibly.

| Scenario | Visual Indicator | Screen Reader | Sound/Haptic | Issues |
|----------|------------------|---------------|--------------|--------|
| Input error | | | | |
| Send failure | | | | |
| Context load error | | | | |
| Change conflict | | | | |
| Success notification | | | | |
| Loading state | | | | |
| Status change | | | | |

**Communication Issues:**
- [ ] List status changes not announced
- [ ] List errors without accessible indication

---

## Testing Tools

### Required
- Keyboard only (unplug mouse)
- Screen reader (NVDA/VoiceOver)
- Browser DevTools (contrast checker)

### Recommended
- axe DevTools extension
- WAVE browser extension
- Lighthouse accessibility audit
- High contrast mode (OS setting)

---

## Audit Summary

### Issue Severity Levels

- **P0 (Critical)**: Blocks access entirely
- **P1 (Serious)**: Major barrier to use
- **P2 (Moderate)**: Causes difficulty
- **P3 (Minor)**: Best practice improvement

### Issues Summary Table

| Area | P0 | P1 | P2 | P3 | Total |
|------|----|----|----|----|-------|
| Keyboard | | | | | |
| Screen Reader | | | | | |
| Color Contrast | | | | | |
| Focus | | | | | |
| ARIA | | | | | |
| Touch | | | | | |
| Animation | | | | | |
| Communication | | | | | |
| **Total** | | | | | |

### Detailed Issue Log

```
ISSUE #001
Severity: P1
Category: Keyboard
Component: Context chip
Description: Cannot remove chip with keyboard (no Delete key handler)
WCAG: 2.1.1 Keyboard

ISSUE #002
Severity: P2
Category: Screen Reader
Component: Change card
Description: Status change not announced
WCAG: 4.1.3 Status Messages

[Continue for all issues...]
```

---

## Deliverables

1. Completed checklist above
2. Issue log with all findings
3. Summary counts by severity
4. Recommendations for 06-02

---

## Notes

- Test with multiple themes (dark, light, high contrast)
- Test at different zoom levels (100%, 200%)
- Test with different font sizes
- Note any issues specific to certain browsers
- VS Code's Quick Pick API handles its own accessibility

---

## References

- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [VS Code Accessibility Guidelines](https://code.visualstudio.com/docs/editor/accessibility)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)


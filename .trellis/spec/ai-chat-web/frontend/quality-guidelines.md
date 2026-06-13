# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

This project includes mobile-first chat surfaces. Mobile text editing must remain stable while the soft keyboard, copy/paste menu, candidate bar, and cursor handles change the visual viewport.

---

## Forbidden Patterns

### Don't: Drive Mobile Keyboard Layout From Resize Alone

**Problem**:
```javascript
window.addEventListener('resize', () => {
    if (window.innerHeight < initialHeight * 0.8) {
        inputContainer.classList.add('keyboard-open');
    } else {
        inputContainer.classList.remove('keyboard-open');
    }
    messageInput.scrollIntoView({ block: 'center' });
});
```

**Why it's bad**: mobile browsers fire viewport resize events for more than keyboard open/close. Copy/paste menus, candidate bars, cursor handles, and orientation settling can also resize the visual viewport. If resize handlers switch the composer between `sticky` and `fixed`, or force `scrollIntoView`, the focused input can jump away while the user is selecting text.

**Instead**:
```javascript
document.addEventListener('focusin', syncKeyboardState);
document.addEventListener('focusout', () => {
    setTimeout(syncKeyboardState, 80);
});
```

Keep the composer position stable in CSS and use focus state only as a lightweight class signal.

---

## Required Patterns

### Mobile Composer Contract

- On mobile breakpoints, the chat composer must keep `position: fixed`; do not switch it to `sticky` while an editable element can be focused.
- The composer bottom offset must include `env(safe-area-inset-bottom, 0px)` with a plain `bottom` fallback.
- Focus and resize handlers must not call `scrollIntoView` on the active composer textarea.
- For a two-state mobile composer, keep only `closed` and `keyboard-open` states: default bottom at the viewport edge, then freeze the composer above the keyboard after the keyboard opens. Do not update the frozen position for copy/paste menus, cursor handles, or text selection viewport jitter; return to default only after keyboard-close detection is confirmed.

### Mobile Settings Form Contract

- Settings modals must be anchored with explicit `top` and `bottom` values on mobile instead of vertical centering with `top: 50%`.
- Settings content must scroll inside the modal when the soft keyboard reduces available height.
- Mobile text, number, and password inputs must use at least `16px` font size to avoid iOS/WebView focus zoom.

---

## Testing Requirements

For mobile keyboard changes, run the available static checks, then manually verify on a real device or WebView:

- Focus the chat textarea, type text, move the cursor, open paste/copy menus, and select text. The composer must not disappear or jump below the keyboard.
- Open settings, focus the server address input, type, blur, and refocus. The modal must stay anchored and its content must remain scrollable.
- Rotate the device after focusing an input. The composer/modal must remain usable after orientation settles.

---

## Code Review Checklist

- [ ] Mobile input containers keep stable positioning across focus, paste, copy, selection, and orientation changes.
- [ ] Mobile form controls use `16px` or larger font sizes.
- [ ] No new focus/resize handler forces `scrollIntoView` on the active text editor.
- [ ] CSS includes safe-area fallbacks before `env(...)`/custom-property declarations.

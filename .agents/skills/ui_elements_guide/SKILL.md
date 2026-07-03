---
name: ui-elements-guide
description: Provides patterns, conventions, and code examples for building user interfaces using Cadence's custom Web Components (Block, Inline, Button, Input, Panel) and strict CSS styling guidelines. Activate this skill when the user asks to create, modify, or extend UI elements, layout panels, or view components.
---

# Cadence UI Elements & Web Components Guide

When building or modifying UI components in the Cadence workspace, follow these strict rules to maintain codebase consistency and styling hygiene.

## 1. Core Component Patterns

Always prefer the custom elements defined in `app/js/elements.mjs` instead of native HTML tag counterparts:

*   **Containers:** Use `new Block()` (`<ui-block>`) instead of `document.createElement("div")` and `new Inline()` (`<ui-inline>`) instead of `document.createElement("span")`.
*   **Buttons:** Use `new Button("Label")` (`<ui-button>`) instead of `<button>`. Configure using properties:
    ```javascript
    const btn = new Button("Submit");
    btn.icon = "check"; // Sets Material Icon
    btn.className = "theme-button secondary"; // Class-based styling
    ```
*   **Inputs:** Use `new Input()` (`<ui-input>`) instead of `<input>`. Access/set value using `.value` and label using `.label`.
*   **Modals:** Use `await window.modal.confirm(question, title)` or `await window.modal.prompt(label, title, defaultVal)` instead of custom alerts or prompts.

---

## 2. Strict Styling Guidelines

To ensure code maintainability, clean presentation, and theme support:
*   **NO INLINE STYLES:** Do not use `el.style.color = ...`, `el.style.padding = ...`, or similar JS inline assignments. Instead, assign classes (`el.classList.add("custom-class")`) and define those classes in corresponding `.css` files.
*   **NO TAILWIND:** Cadence uses Vanilla CSS for maximum flexibility and clean separation.
*   **USE THEME VARIABLES:** Use Cadence's custom properties inside CSS:
    *   Colors: `var(--theme)`, `var(--bg-card)`, `var(--text-color)`, `var(--border)`, `var(--bg-hover)`
    *   Borders & Corners: `var(--borderRadius)`
    *   Fonts: `var(--font-size-sm)`

---

## 3. DOM Manipulation & `innerHTML` Safety

*   Avoid `innerHTML` unless rendering markdown or sanitizing content. 
*   Prefer programmatic DOM tree building using `appendChild()`, `append()`, and custom element classes.

For complete examples of custom layout panels and clean stylesheets, check the `examples/` directory inside this skill:
- [Panel Example](file:///.agents/skills/ui_elements_guide/examples/panel_example.mjs)
- [CSS Style Example](file:///.agents/skills/ui_elements_guide/examples/style_example.css)

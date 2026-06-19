## About the project
This application uses a Go backend server, hosting a HTML/JavaScript frontend 
REST and Websocket APIs are used for communications between the frontend and backend
All frontend code is found in `app/js`

## UI Component Patterns

When building or modifying UI elements, use the custom web components defined in `app/js/elements.mjs` instead of standard HTML elements:

- **Containers:** Use `new Block()` (`<ui-block>`) instead of `document.createElement("div")` and `new Inline()` (`<ui-inline>`) instead of `document.createElement("span")`.
- **Buttons:** Use `new Button("label")` (`<ui-button>`) instead of `<button>`. Configure it using the `.text` and `.icon` properties or `.setIcon("icon_name")`.
- **Inputs:** Use `new Input()` (`<ui-input>`) instead of `<input>`. Access/set value using `.value` and label using `.label`.
- **Modals & Dialogs:** Use the global `window.modal` helper instead of building custom alerts:
  - `await window.modal.notice("Message", "Title")`
  - `await window.modal.confirm("Question?", "Title")` (returns boolean)
  - `await window.modal.prompt("Prompt text", "Title", "defaultVal")` (returns string or null)
  - `window.modal.toast("Notification message")`
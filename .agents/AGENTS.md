## About the project
This application uses a Go backend server, hosting a HTML/JavaScript frontend 
REST and Websocket APIs are used for communications between the frontend and backend
All frontend code is found in `app/js`

## Living development docs
`docs/` holds knowledge documents that are extended, never rewound, as the
codebase is explored. When you learn how a flow works (theme application,
command dispatch, surface colour pairings, …) add or extend the matching doc in
`docs/` instead of leaving the finding only in conversation. Start from
`docs/README.md`.

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

## PR & Surprise Documentation (MANDATORY)
- Every pull request MUST document and report ALL changes it contains in the PR description. Never push undocumented changes, even if the intention is good.
- If the user designates a feature as a "surprise":
  - Refer to it in the PR description and commit message using an appropriately minimal, non-revealing description chosen for that specific surprise (e.g. `logo tweak (check surprise.md for details)`) — never describe the feature itself.
  - Put the real detail in the single `surprise.md` file at the repo root; append a new dated section per surprise (never create additional surprise files).
  - The PR description must reference surprise.md.

## actions ##
`./build.sh` - builds the backend server
`curl -X POST http://localhost:3022/api/restart` - restarts the backend server (use port 3023 in dev mode)

### Release builds
Before building a stable release, set `"experimental": false` in
`app/version.json` (currently `true` for the experimental/dev build). The
field flows to the binary automatically because `version.json` is embedded at
build time, and the UI hides the experimental-build hammer when it's false.

Don't build the project unless explicitly requested by the user, or essential for testing
Don't or `git add` or `git commit` unless explicitly requested by the user

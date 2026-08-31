# Pull solutions back from GitHub into the LeetCode editor

## Context

Today the extension is one-directional: `inject.js` intercepts a LeetCode submission, and on
"Accepted" `background.js` commits the code to `<slug>/<slug>.<ext>` in the user's repo. There is
no way to get that code back. When you revisit a problem you've already solved, the editor shows
LeetCode's starter template and your solution is only visible on GitHub.

We want the reverse direction: on a problem page, a **Load** button that finds the saved solution
for that problem in the repo and writes it into the Monaco editor.

**This is feasible, and the two hard prerequisites already exist:**

1. **MAIN-world access to Monaco.** `manifest.json:22-29` already runs `inject.js` with
   `"world": "MAIN"` (plus a `<script>`-tag fallback in `content.js:77-90` for Chrome < 111), and
   `codeFromEditor()` (`inject.js:136-155`) already reads `window.monaco.editor.getModels()`.
   Writing is the symmetric operation.
2. **An authenticated GitHub client.** `githubRequest()` (`background.js:59-69`) and the fine-grained
   PAT are already in place. A fine-grained token with `Contents: Read and write` already grants
   read, so **no token or scope change is needed**.

**No new manifest permissions are required.** `chrome.tabs.query`/`sendMessage` expose the tab URL
and accept messages because `host_permissions` already covers `leetcode.com`; the GitHub read uses
the existing `api.github.com` host permission.

### Confirmed design decisions

- **UI**: injected button in the LeetCode editor toolbar **and** a button in the popup, so the
  feature still works if LeetCode restructures its DOM.
- **Language**: auto-load the file matching the editor's current language; if none matches, list the
  available languages and ask the user to switch the editor language first. **No** automation of
  LeetCode's language dropdown.
- **Overwrite**: write through Monaco's edit API so a single `Ctrl+Z` restores the previous buffer.
  No confirmation prompt; the toast says undo is available.

### Security constraint to preserve

The token must stay in `background.js` only — `inject.js` runs in leetcode.com's own JS context and
its header comment explicitly promises it never touches the token. So **all GitHub calls stay in
the service worker**; `content.js` asks for content by slug and never sees credentials.

---

## Architecture

The existing message flow is strictly one-directional
(`inject.js` → `content.js` → `background.js`). This adds a request/response path in both
directions, reusing the same channels.

```
                    ┌─ page button (content.js)
  trigger ──────────┤
                    └─ popup button ──chrome.tabs.sendMessage──┐
                                                              ▼
   inject.js  ◄──window.postMessage──  content.js  ──chrome.runtime.sendMessage──►  background.js
   (Monaco)   ──window.postMessage──►  (orchestrates)  ◄──sendResponse────────────   (GitHub + token)
```

`content.js` orchestrates so the page button and the popup share exactly one code path.

---

## Implementation

### 1. `inject.js` — Monaco read/write + request handler

Refactor the existing model-picking heuristic out of `codeFromEditor()` so both directions share it.

- `pickEditor()` — prefer `monaco.editor.getEditors?.()`, filtered to editors that have a model and
  are **not** `readOnly` (`editor.getRawOptions().readOnly`); this keeps us out of the read-only
  diff/submission-detail editors. Fall back to the current longest-model heuristic
  (`inject.js:139-151`) when `getEditors` is unavailable.
- `codeFromEditor()` — reimplement on top of `pickEditor()`; behaviour unchanged for the existing
  submit-capture fallback path.
- `currentLang()` — primary source `JSON.parse(localStorage.getItem("global_lang"))`, which is
  LeetCode's own lang slug and feeds straight into the existing `EXT_MAP`/`extFromLang()`
  (`inject.js:32-63`). Fall back to `model.getLanguageId()`, mapped through a small alias table for
  the handful of Monaco ids that differ from LeetCode slugs (`shell`→`sh`, `plaintext`→`txt`).
- `writeCode(code)` — undoable replace of the whole buffer:
  ```js
  const editor = pickEditor();
  const model = editor && editor.getModel();
  const range = model.getFullModelRange();
  if (editor) {
    editor.pushUndoStop();
    editor.executeEdits("lc2gh", [{ range, text: code, forceMoveMarkers: true }]);
    editor.pushUndoStop();
    editor.setPosition({ lineNumber: 1, column: 1 });
  } else {
    model.pushEditOperations([], [{ range, text: code }], () => null);
  }
  ```
  Deliberately **not** `model.setValue()` — that wipes the undo stack. Both `executeEdits` and
  `pushEditOperations` fire `onDidChangeModelContent`, so LeetCode's own controlled component and
  autosave see the change exactly as if it were typed.
- Add a `window.addEventListener("message")` handler for inbound `{source:"lc2gh-req", reqId, type}`
  messages — `GET_CONTEXT` (returns `{langSlug, ext, readOnly}`) and `SET_CODE` — replying with
  `post("RESULT", { reqId, ok, error })` through the existing `post()` helper (`inject.js:65-67`).
  Ignore any message whose `event.source !== window`, matching the existing guard in `content.js:12`.

### 2. `background.js` — GitHub read path

Add alongside the existing write path, reusing `githubRequest()`, `encodePath()`, `errorText()`, and
`safeSegment()` unchanged:

- `listSolutions(slug)` — `GET /repos/{owner}/{repo}/contents/{safeSegment(slug)}?ref={branch}`.
  `404` → no saved solution (not an error). Filter to `type === "file"`, drop `README.md`, and derive
  `{ name, path, ext }` per entry.
- `fetchFileText(path)` — same contents endpoint with `Accept: application/vnd.github.raw` and
  `res.text()`. Raw avoids UTF-8 base64 decoding entirely and sidesteps the contents API's 1 MB
  base64 ceiling. Fall back to the JSON response's `content` field with a UTF-8-safe decode
  (`TextDecoder` over `atob`, the inverse of `toBase64()` at `background.js:72-77`) if a proxy
  strips the raw media type.
- Two new `onMessage` branches in the router (`background.js:4-28`), both returning `true` for the
  async response:
  - `LC2GH_LIST_SOLUTIONS {slug}` → `{ ok, files }`
  - `LC2GH_FETCH_SOLUTION {slug, path}` → `{ ok, code, name, ext }`
- Reuse the settings guard from `handleAccepted()` (`background.js:148-153`) so an unconfigured
  extension gives the same "Options → add token/owner/repo" message.
- Log loads through the existing `pushLog()` (`background.js:32-40`) as `Loaded <path>` /
  `Load failed: <detail>`, and add matching regexes to `classify()` in `popup.js:35-49` so they
  render with proper level and label instead of falling through to `neutral`.

### 3. `content.js` — orchestration, in-page button, toast

- `problemSlug()` — parse `/problems/<slug>` out of `location.pathname`; return `null` elsewhere, so
  the button never mounts on `/submissions/` or list pages.
- `askPage(type, payload)` — promise wrapper around `postMessage` + `reqId` correlation with a
  timeout, so a missing MAIN-world hook surfaces as a clean error rather than hanging.
- `loadSolution()` — the single shared entry point:
  1. `askPage("GET_CONTEXT")` → current `ext`.
  2. `LC2GH_LIST_SOLUTIONS` → files.
  3. Zero files → toast "No saved solution for `<slug>` yet."
  4. A file whose `ext` matches → `LC2GH_FETCH_SOLUTION` → `askPage("SET_CODE")` → success toast
     with the "Press Ctrl+Z to undo" line.
  5. No match → render the picker listing each saved language, with a note that the editor language
     must be switched to match; selecting one runs step 4.
- `mountButton()` — insert a button near the language dropdown / Run–Submit cluster using a
  multi-selector list, following the resilience pattern already used by `problemTitle()`
  (`content.js:58-71`). If no anchor is found, fall back to a floating pill pinned to the editor
  pane corner so the feature is never entirely unavailable.
- **SPA navigation**: LeetCode changes URL without a reload and Chrome does not re-inject content
  scripts. Use a debounced `MutationObserver` on `document.body` that compares `location.pathname`
  against a memo, re-mounting the button and clearing per-problem state on change. This is the same
  reason the manifest matches all of `leetcode.com` rather than `/problems/*`.
- Toast, button, and picker built with `createElement`/`textContent` and a scoped class prefix
  (`lc2gh-`), matching the project's no-`innerHTML`, no-framework, CSP-clean convention. Styles
  injected as a single `<style>` element with `prefers-color-scheme` handling, mirroring the inline
  style blocks in `popup.html`/`options.html`.

### 4. `popup.html` / `popup.js` — fallback trigger

Add a "Load solution into editor" row above the activity log:

- On open, `chrome.tabs.query({ active: true, currentWindow: true })`; if the URL is a LeetCode
  problem page, show the slug and enable the button, otherwise show a disabled state
  ("Open a LeetCode problem to load a solution").
- Click → `chrome.tabs.sendMessage(tabId, { type: "LC2GH_LOAD_REQUEST" })`, which runs
  `loadSolution()` in `content.js`. No duplicated logic; failures surface in the tab's toast and in
  the activity log.
- If `sendMessage` reports no receiver, show "Reload the LeetCode tab" — the same
  extension-reloaded-while-tab-open case `content.js:53-55` already handles.

### 5. `manifest.json` / `README.md`

Version bump to `1.1.0`. No permission changes. Document the new feature and the language-matching
behaviour in the README, next to the existing "How it works" section.

---

## Files touched

| File | Change |
|---|---|
| `inject.js` | `pickEditor()`, `currentLang()`, `writeCode()`, inbound message handler; `codeFromEditor()` refactored onto the shared picker |
| `background.js` | `listSolutions()`, `fetchFileText()`, two router branches |
| `content.js` | `problemSlug()`, `askPage()`, `loadSolution()`, `mountButton()`, toast/picker UI, SPA observer |
| `popup.js` / `popup.html` | load button + tab detection; new `classify()` regexes |
| `manifest.json`, `README.md` | version bump, docs |

---

## Known limitations to state in the README

- Files are keyed by extension, so two languages that share one (`python`/`python3` → `.py`,
  the four SQL dialects → `.sql`) collide in the repo — that is the existing write-path behaviour
  (`background.js:163-165`), not something this feature introduces.
- Loading a solution for a language other than the editor's current one requires switching the
  language dropdown manually first.
- Solutions committed under a different folder convention (before any future path-template setting)
  won't be found.

---

## Verification

Manual end-to-end, since the project has no test harness:

1. `chrome://extensions` → Load unpacked → configure token/owner/repo in Options → **Test connection**.
2. Solve a problem to populate `<slug>/<slug>.<ext>`, then hard-reload the problem page.
3. Click **Load** in the toolbar → editor fills with the saved code; toast appears.
4. Press `Ctrl+Z` → the starter template returns in one step (confirms `executeEdits` + undo stops).
5. Type a change, then click **Run** → confirms LeetCode's controlled component picked up the
   programmatic edit (the critical integration risk; if Run submits stale code, the change event
   isn't reaching React and we need `editor.trigger`/focus before the edit).
6. Switch the editor to a language with no saved file → the picker lists the other languages with
   the switch-language note.
7. Open a never-solved problem → "No saved solution yet", no error badge.
8. Navigate between two problems via LeetCode's SPA links (no reload) → button re-mounts, loads the
   correct problem's solution.
9. Open a submission-detail page → button absent (read-only editor never written to).
10. Open the popup on a non-LeetCode tab → disabled state; on a problem tab → loads correctly.
11. Point at a **private** repo → still loads (confirms the raw `Accept` header works with `Bearer`).
12. Break the token in Options → both triggers show a clear error and the popup log records
    `Load failed: …`.
13. Check the service-worker console and the page console for `[LC2GH]` errors throughout.

// Runs in the extension's isolated world so it can call chrome.runtime.
//
// Two jobs:
//   1. Relay the messages inject.js posts on submit/accept, adding the
//      human-readable problem title from the DOM, on to background.js.
//   2. Own the "load a saved solution" flow - the in-page button, the toast,
//      and the plumbing between background.js and the page's Monaco editor.
//
// The GitHub token never comes near this file: it only ever asks background.js
// for repository content by problem slug.

(function () {
  const TAG = "[LC2GH]";
  console.debug(TAG, "content.js loaded on", window.location.href);

  let mainWorldReady = false;

  // reqId -> { resolve, timer } for outstanding askPage() calls.
  const pageRequests = new Map();
  let reqSeq = 0;

  // ---------------------------------------------------------------------
  // Messages from the page world
  // ---------------------------------------------------------------------

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "lc2gh") return;

    if (data.type === "READY") {
      mainWorldReady = true;
      console.debug(TAG, "page-world hook is live");
      return;
    }

    if (data.type === "RESULT") {
      const payload = data.payload || {};
      const entry = pageRequests.get(payload.reqId);
      if (!entry) return; // already timed out
      pageRequests.delete(payload.reqId);
      clearTimeout(entry.timer);
      entry.resolve(payload);
      return;
    }

    if (data.type === "SUBMITTED") {
      // Diagnostic only - lets the popup show that interception is working
      // even when the submission turns out to be wrong.
      send({ type: "LC2GH_SUBMISSION_SEEN", payload: data.payload });
      return;
    }

    if (data.type === "ACCEPTED") {
      console.debug(TAG, "accepted event received, forwarding to background", {
        ...data.payload,
        code: `<${(data.payload.code || "").length} chars>`,
      });
      send({
        type: "LC2GH_SUBMISSION_ACCEPTED",
        payload: {
          ...data.payload,
          title: problemTitle(),
          url: window.location.href.split("?")[0],
        },
      });
    }
  });

  function send(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        // Reading lastError stops Chrome logging "unchecked runtime.lastError"
        // when the service worker has no listener ready yet.
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // Happens if the extension was reloaded while the tab stayed open.
      console.warn(TAG, "could not reach the extension - reload the LeetCode tab", e);
    }
  }

  // Ask the page world something and wait for its reply. Resolves (never
  // rejects) so callers can treat a missing hook like any other failure.
  function askPage(type, payload) {
    return new Promise((resolve) => {
      const reqId = `r${++reqSeq}`;
      const timer = setTimeout(() => {
        pageRequests.delete(reqId);
        resolve({
          ok: false,
          error: "The page-world hook did not respond. Reload the LeetCode tab and try again.",
        });
      }, 5000);
      pageRequests.set(reqId, { resolve, timer });
      window.postMessage({ source: "lc2gh-req", type, reqId, payload: payload || {} }, "*");
    });
  }

  // Same contract as askPage(): always resolves, errors come back as { ok }.
  function askBackground(message) {
    return new Promise((resolve) => {
      const unreachable = {
        ok: false,
        error: "Could not reach the extension. Reload the LeetCode tab and try again.",
      };
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve(unreachable);
            return;
          }
          resolve(response || { ok: false, error: "No response from the extension." });
        });
      } catch (e) {
        resolve(unreachable);
      }
    });
  }

  function problemTitle() {
    const selectors = [
      'a[href^="/problems/"].text-title-large',
      'div[class*="text-title-large"] a',
      'div[class*="text-title-large"]',
      '[data-cy="question-title"]',
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el && el.textContent ? el.textContent.trim() : "";
      if (text) return text;
    }
    return (document.title || "").replace(/\s*-\s*LeetCode\s*$/i, "").trim();
  }

  // Note: /problems/<slug>/submissions/ still shows the editor in the new UI,
  // so sub-paths are fine. The standalone read-only /submissions/detail/<id>/
  // page doesn't match at all, which is exactly what we want.
  const PROBLEM_RE = /^\/problems\/([^/]+)/;

  function problemSlug() {
    const match = PROBLEM_RE.exec(window.location.pathname);
    return match ? match[1] : null;
  }

  // ---------------------------------------------------------------------
  // Loading a saved solution
  // ---------------------------------------------------------------------

  // Labels for the language picker, keyed by the extension background.js used
  // when it committed the file.
  const EXT_LABELS = {
    py: "Python",
    java: "Java",
    cpp: "C++",
    c: "C",
    cs: "C#",
    js: "JavaScript",
    ts: "TypeScript",
    php: "PHP",
    swift: "Swift",
    kt: "Kotlin",
    dart: "Dart",
    go: "Go",
    rb: "Ruby",
    scala: "Scala",
    rs: "Rust",
    rkt: "Racket",
    erl: "Erlang",
    ex: "Elixir",
    sql: "SQL",
    sh: "Bash",
  };

  function extLabel(ext) {
    return EXT_LABELS[ext] || `.${ext || "txt"}`;
  }

  let loading = false;

  async function loadSolution(explicitPath) {
    const slug = problemSlug();
    if (!slug) {
      const error = "Open a LeetCode problem page first.";
      showToast({ level: "warn", title: "Not a problem page", detail: error });
      return { ok: false, error };
    }
    if (loading) return { ok: false, error: "Already loading a solution." };

    loading = true;
    setButtonBusy(true);
    dismissPicker();

    try {
      const context = await askPage("GET_CONTEXT");
      if (!context.ok) return fail(context.error);
      if (!context.hasEditor) {
        return fail("No code editor found on this page.");
      }

      let path = explicitPath;
      if (!path) {
        const listed = await askBackground({ type: "LC2GH_LIST_SOLUTIONS", payload: { slug } });
        if (!listed.ok) return fail(listed.error);

        const files = listed.files || [];
        if (!files.length) {
          showToast({
            level: "warn",
            title: `Nothing saved for ${slug}`,
            detail: "No solution for this problem has been synced to your repository yet.",
          });
          return { ok: false, error: "No saved solution for this problem." };
        }

        const match = files.find((file) => file.ext === context.ext);
        if (!match) {
          // Switching LeetCode's language dropdown programmatically is far too
          // brittle to rely on, so show what's available and let the user do it.
          showPicker(files, context);
          return { ok: true, pending: true };
        }
        path = match.path;
      }

      const fetched = await askBackground({
        type: "LC2GH_FETCH_SOLUTION",
        payload: { slug, path },
      });
      if (!fetched.ok) return fail(fetched.error);

      const written = await askPage("SET_CODE", { code: fetched.code });
      if (!written.ok) return fail(written.error);

      showToast({
        level: "success",
        title: `Loaded ${fetched.name}`,
        detail: "Press Ctrl+Z (⌘Z on macOS) to undo.",
      });
      return { ok: true };
    } finally {
      loading = false;
      setButtonBusy(false);
    }
  }

  function fail(error) {
    const detail = error || "Something went wrong.";
    showToast({ level: "error", title: "Could not load solution", detail });
    return { ok: false, error: detail };
  }

  // Triggered from the popup, which has no editor access of its own.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "LC2GH_LOAD_REQUEST") return;
    loadSolution().then(sendResponse);
    return true; // keep the channel open for the async response
  });

  // ---------------------------------------------------------------------
  // In-page UI. Built with createElement/textContent only, matching the rest
  // of the extension - no innerHTML, no framework. Styles live in content.css.
  // ---------------------------------------------------------------------

  const SVG_NS = "http://www.w3.org/2000/svg";

  function downloadIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "lc2gh-icon");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    for (const d of ["M8 2v8", "M4.75 7.25 8 10.5l3.25-3.25", "M2.75 12.75h10.5"]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  // LeetCode's class names churn constantly, so start from the e2e test hooks
  // it ships on the console buttons and walk up from there.
  const ANCHOR_SELECTORS = [
    '[data-e2e-locator="console-submit-button"]',
    '[data-e2e-locator="console-run-button"]',
  ];

  function consoleButton() {
    for (const selector of ANCHOR_SELECTORS) {
      const el = document.querySelector(selector);
      if (el && el.parentElement) return el;
    }
    return null;
  }

  // Run and Submit live inside a rounded, overflow-hidden pill that animates
  // its own width, so anything dropped in there gets clipped and cramped. The
  // toolbar row that *holds* that pill - alongside LeetCode's trailing buttons
  // - is the first ancestor that is a flex row with a gap, and appending to it
  // puts our button after everything else with LeetCode's own spacing.
  function findToolbarRow() {
    let node = consoleButton();
    for (let i = 0; i < 12 && node; i++) {
      const cls = typeof node.className === "string" ? node.className : "";
      if (/\bflex\b/.test(cls) && /\bgap-/.test(cls)) return node;
      node = node.parentElement;
    }
    return null;
  }

  let button = null;
  let buttonLabel = null;

  function buildButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lc2gh-btn";
    btn.title = "Load your saved solution for this problem from GitHub";
    btn.appendChild(downloadIcon());

    buttonLabel = document.createElement("span");
    buttonLabel.textContent = "Load";
    btn.appendChild(buttonLabel);

    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      loadSolution();
    });
    return btn;
  }

  function setButtonBusy(busy) {
    if (!button) return;
    button.disabled = busy;
    button.classList.toggle("lc2gh-busy", busy);
    if (buttonLabel) buttonLabel.textContent = busy ? "Loading…" : "Load";
  }

  function removeButton() {
    if (button) button.remove();
    button = null;
    buttonLabel = null;
  }

  function mountButton() {
    if (!problemSlug() || !document.body) {
      removeButton();
      return;
    }

    const row = findToolbarRow();
    if (button && button.isConnected) {
      // Upgrade the floating fallback into the toolbar once it shows up.
      if (!button.classList.contains("lc2gh-float") || !row) return;
      removeButton();
    }

    const btn = buildButton();
    if (row) {
      // Last child, so we sit after LeetCode's own trailing buttons rather
      // than wedged between them. If React later drops the node, the observer
      // notices it is no longer connected and mounts it again.
      row.appendChild(btn);
    } else {
      btn.classList.add("lc2gh-float");
      document.body.appendChild(btn);
    }
    button = btn;
  }

  // --- toast + picker ---

  let host = null;

  function toastHost() {
    if (host && host.isConnected) return host;
    host = document.createElement("div");
    host.className = "lc2gh-host";
    document.body.appendChild(host);
    return host;
  }

  function buildCard(level, title, detail) {
    const card = document.createElement("div");
    card.className = `lc2gh-card lc2gh-${level}`;

    const heading = document.createElement("div");
    heading.className = "lc2gh-card-title";
    heading.textContent = title;
    card.appendChild(heading);

    if (detail) {
      const text = document.createElement("div");
      text.className = "lc2gh-card-detail";
      text.textContent = detail;
      card.appendChild(text);
    }
    return card;
  }

  function showToast({ level, title, detail }) {
    if (!document.body) return;
    const card = buildCard(level, title, detail);
    card.addEventListener("click", () => card.remove());
    toastHost().appendChild(card);
    setTimeout(() => card.remove(), level === "success" ? 6000 : 9000);
  }

  let picker = null;

  function dismissPicker() {
    if (picker) picker.remove();
    picker = null;
  }

  function showPicker(files, context) {
    if (!document.body) return;
    dismissPicker();

    const current = context.lang ? `${extLabel(context.ext)} (${context.lang})` : extLabel(context.ext);
    const card = buildCard(
      "warn",
      "No saved solution in this language",
      `The editor is set to ${current}. Switch LeetCode's language to one of these, then load again — ` +
        "or pick one now to paste it in as-is."
    );
    card.classList.add("lc2gh-picker");

    const list = document.createElement("div");
    list.className = "lc2gh-list";
    for (const file of files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "lc2gh-row";

      const label = document.createElement("span");
      label.className = "lc2gh-row-label";
      label.textContent = extLabel(file.ext);
      row.appendChild(label);

      const name = document.createElement("span");
      name.className = "lc2gh-row-name";
      name.textContent = file.name;
      row.appendChild(name);

      row.addEventListener("click", () => {
        dismissPicker();
        loadSolution(file.path);
      });
      list.appendChild(row);
    }
    card.appendChild(list);

    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "lc2gh-dismiss";
    dismiss.textContent = "Dismiss";
    dismiss.addEventListener("click", dismissPicker);
    card.appendChild(dismiss);

    toastHost().appendChild(card);
    picker = card;
  }

  // ---------------------------------------------------------------------
  // Mounting. LeetCode is an SPA and Chrome does not re-inject content
  // scripts on client-side navigation, so watch for the path changing under
  // us rather than assuming one page per script run.
  // ---------------------------------------------------------------------

  let lastPath = window.location.pathname;
  let scheduled = null;

  function schedule() {
    if (scheduled) return;
    scheduled = setTimeout(() => {
      scheduled = null;
      if (window.location.pathname !== lastPath) {
        lastPath = window.location.pathname;
        removeButton();
        dismissPicker();
      }
      mountButton();
    }, 300);
  }

  function start() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", start, { once: true });
      return;
    }
    mountButton();
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  }

  // Fallback injection: browsers that don't support "world": "MAIN" in the
  // manifest (Chrome < 111) silently skip inject.js, which is the single most
  // common reason nothing gets intercepted. Injecting it as a page <script>
  // works everywhere; inject.js guards itself against running twice.
  function injectPageScript() {
    if (mainWorldReady) return;
    try {
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("inject.js");
      script.async = false;
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.warn(TAG, "fallback injection failed", e);
    }
  }

  injectPageScript();
  start();
})();

// Runs in the extension's isolated world so it can call chrome.runtime.
// It listens for the messages inject.js posts, adds the human-readable
// problem title from the DOM, and forwards them to background.js.

(function () {
  const TAG = "[LC2GH]";
  console.debug(TAG, "content.js loaded on", window.location.href);

  let mainWorldReady = false;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "lc2gh") return;

    if (data.type === "READY") {
      mainWorldReady = true;
      console.debug(TAG, "page-world hook is live");
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
})();

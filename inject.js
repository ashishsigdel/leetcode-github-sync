// Runs in the PAGE's own JS context (MAIN world) so it can see the same
// fetch/XHR calls LeetCode's React app makes. It never touches your GitHub
// token - it only watches for a successful ("Accepted") submission and
// hands the slug/language/code off to content.js via postMessage.

(function () {
  // content.js also injects this file as a <script> tag, as a fallback for
  // browsers that ignore "world": "MAIN" in the manifest. Guard so whichever
  // copy runs first wins and we never double-patch fetch/XHR.
  if (window.__LC2GH_INJECTED__) return;
  window.__LC2GH_INJECTED__ = true;

  const TAG = "[LC2GH]";
  const log = (...args) => console.debug(TAG, ...args);
  log("inject.js active on", window.location.href);

  // Note: no "$" anchors - LeetCode sometimes appends query strings.
  const SUBMIT_RE = /\/problems\/([^/?#]+)\/submit\/?(?:[?#]|$)/;
  const CHECK_RE = /\/submissions\/detail\/(\d+)\/check\/?(?:[?#]|$)/;

  // submissionId -> { slug, lang, code, ext }
  const pending = Object.create(null);
  // Fallback for when we can't tie an "Accepted" response back to an id.
  let lastPending = null;
  // Guard against the same submission being announced twice (fetch + XHR
  // patches both firing, or a check endpoint polled more than once).
  const announced = new Set();
  // Distinguishes separate submissions when LeetCode gives us no id, so a
  // re-submit is never mistaken for a repeat poll of the previous one.
  let submitSeq = 0;

  const EXT_MAP = {
    python: "py",
    python3: "py",
    java: "java",
    cpp: "cpp",
    c: "c",
    csharp: "cs",
    javascript: "js",
    typescript: "ts",
    php: "php",
    swift: "swift",
    kotlin: "kt",
    dart: "dart",
    golang: "go",
    go: "go",
    ruby: "rb",
    scala: "scala",
    rust: "rs",
    racket: "rkt",
    erlang: "erl",
    elixir: "ex",
    mysql: "sql",
    mssql: "sql",
    oraclesql: "sql",
    postgresql: "sql",
    pythondata: "py",
    bash: "sh",
  };

  function extFromLang(lang) {
    return EXT_MAP[String(lang || "").toLowerCase()] || "txt";
  }

  function post(type, payload) {
    window.postMessage({ source: "lc2gh", type, payload }, "*");
  }

  // ---------------------------------------------------------------------
  // Helpers for reading a request/response without breaking the page's call
  // ---------------------------------------------------------------------

  function urlOf(args) {
    try {
      const first = args[0];
      const raw = first instanceof Request ? first.url : String(first);
      return new URL(raw, window.location.href).href;
    } catch (e) {
      return "";
    }
  }

  function methodOf(args) {
    const init = args[1];
    if (init && init.method) return String(init.method).toUpperCase();
    if (args[0] instanceof Request) return String(args[0].method).toUpperCase();
    return "GET";
  }

  // Must be called BEFORE the real fetch runs: for a Request argument we take
  // a clone up front, because fetch() consumes the original's body.
  function readRequestBody(args) {
    try {
      if (args[0] instanceof Request) {
        // .clone() happens synchronously here, before origFetch is called.
        return args[0].clone().text();
      }
      const body = args[1] && args[1].body;
      if (body == null) return Promise.resolve("");
      if (typeof body === "string") return Promise.resolve(body);
      if (body instanceof URLSearchParams) return Promise.resolve(body.toString());
      if (body instanceof Blob) return body.text();
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        return Promise.resolve(new TextDecoder().decode(body));
      }
      return Promise.resolve("");
    } catch (e) {
      return Promise.resolve("");
    }
  }

  async function safeJson(res) {
    try {
      const type = res.headers.get("content-type") || "";
      if (type && !/json/i.test(type)) return null;
      return await res.clone().json();
    } catch (e) {
      return null;
    }
  }

  // Only spend cycles on URLs that could carry a submission result. The check
  // endpoint is always watched (it's rare, and it can arrive before we've
  // finished parsing the submit response); broader URLs only once something
  // is actually in flight.
  function shouldWatch(url) {
    if (CHECK_RE.test(url)) return true;
    return (/\/submissions?\//.test(url) || /\/graphql/.test(url)) && hasPending();
  }

  function hasPending() {
    return lastPending !== null || Object.keys(pending).length > 0;
  }

  // Last-resort source for the code, if the submit body couldn't be read.
  function codeFromEditor() {
    try {
      const monaco = window.monaco;
      if (monaco && monaco.editor && typeof monaco.editor.getModels === "function") {
        const values = monaco.editor
          .getModels()
          .map((m) => {
            try {
              return m.getValue();
            } catch (e) {
              return "";
            }
          })
          .filter(Boolean)
          .sort((a, b) => b.length - a.length);
        if (values.length) return values[0];
      }
    } catch (e) {}
    return "";
  }

  // ---------------------------------------------------------------------
  // Submission tracking
  // ---------------------------------------------------------------------

  function registerSubmit(url, bodyText, json) {
    const match = SUBMIT_RE.exec(url);
    const slug = match ? match[1] : null;

    let lang = "";
    let code = "";
    try {
      const body = JSON.parse(bodyText || "");
      lang = body.lang || body.lang_slug || "";
      code = body.typed_code || body.code || "";
    } catch (e) {
      log("submit body did not parse as JSON:", String(bodyText).slice(0, 200));
    }
    if (!code) {
      code = codeFromEditor();
      if (code) log("recovered code from the editor instead of the request body");
    }

    const id =
      json && (json.submission_id != null ? json.submission_id : json.submissionId != null ? json.submissionId : json.id);

    const info = { slug, lang, code, ext: extFromLang(lang), seq: ++submitSeq };
    if (id != null) pending[String(id)] = info;
    lastPending = { id: id == null ? null : String(id), info };

    log("submit tracked:", { slug, lang, id, codeLength: code.length });
    post("SUBMITTED", { slug, lang, submissionId: id == null ? null : String(id), hasCode: !!code });
  }

  function isAcceptedPayload(json) {
    if (!json || typeof json !== "object") return false;
    if (json.status_msg === "Accepted") return true;
    // status_code 10 is LeetCode's "Accepted" code.
    if (json.status_code === 10 && json.state === "SUCCESS") return true;
    return false;
  }

  function maybeAccepted(url, json) {
    if (!isAcceptedPayload(json)) return;

    const fromUrl = CHECK_RE.exec(url);
    let id = fromUrl ? fromUrl[1] : null;
    if (!id && json.submission_id != null) id = String(json.submission_id);
    if (!id && lastPending) id = lastPending.id;

    let info = id ? pending[id] : null;
    if (!info && lastPending) info = lastPending.info;
    if (!info) {
      log("saw an Accepted response but never captured the matching submit", url);
      return;
    }

    const key = id || `${info.slug}#${info.seq}`;
    if (announced.has(key)) return;
    announced.add(key);

    // Prefer the language the judge reports back - it's authoritative.
    const lang = json.lang || json.pretty_lang || info.lang;

    log("ACCEPTED", info.slug, id);
    post("ACCEPTED", {
      slug: info.slug,
      lang,
      ext: info.ext !== "txt" ? info.ext : extFromLang(lang),
      code: info.code,
      submissionId: id,
      runtime: json.status_runtime,
      memory: json.status_memory,
    });

    if (id) delete pending[id];
    if (lastPending && lastPending.id === id) lastPending = null;
  }

  function handleResponseJson(url, json, isSubmit, bodyText) {
    try {
      if (isSubmit) registerSubmit(url, bodyText, json);
      else maybeAccepted(url, json);
    } catch (e) {
      log("error handling response for", url, e);
    }
  }

  // ---------------------------------------------------------------------
  // Patch fetch
  // ---------------------------------------------------------------------
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = urlOf(args);
    const isSubmit = methodOf(args) === "POST" && SUBMIT_RE.test(url);

    if (!isSubmit && !shouldWatch(url)) {
      return origFetch.apply(this, args);
    }

    // Grab the body before the real fetch consumes it.
    const bodyPromise = isSubmit ? readRequestBody(args) : Promise.resolve("");
    const resPromise = origFetch.apply(this, args);

    resPromise
      .then(async (res) => {
        const json = await safeJson(res);
        if (json) handleResponseJson(url, json, isSubmit, await bodyPromise);
      })
      .catch(() => {});

    // Hand the page the untouched promise - we never alter what it receives.
    return resPromise;
  };

  // ---------------------------------------------------------------------
  // Patch XMLHttpRequest on the prototype, so instanceof/statics/subclassing
  // all keep working (replacing the constructor breaks libraries like axios).
  // ---------------------------------------------------------------------
  const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhrProto && !xhrProto.__lc2ghPatched) {
    xhrProto.__lc2ghPatched = true;
    const origOpen = xhrProto.open;
    const origSend = xhrProto.send;

    xhrProto.open = function (method, url) {
      try {
        this.__lc2ghMethod = String(method || "").toUpperCase();
        this.__lc2ghUrl = new URL(String(url), window.location.href).href;
      } catch (e) {
        this.__lc2ghUrl = "";
      }
      return origOpen.apply(this, arguments);
    };

    xhrProto.send = function (body) {
      try {
        const url = this.__lc2ghUrl || "";
        const isSubmit = this.__lc2ghMethod === "POST" && SUBMIT_RE.test(url);

        if (isSubmit || shouldWatch(url)) {
          const bodyText =
            typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : "";

          this.addEventListener("load", () => {
            let json = null;
            try {
              const rt = this.responseType;
              // Reading .responseText throws unless responseType is "" or "text".
              if (rt === "json") json = this.response;
              else if (!rt || rt === "text") json = JSON.parse(this.responseText);
            } catch (e) {
              return;
            }
            if (json) handleResponseJson(url, json, isSubmit, bodyText);
          });
        }
      } catch (e) {}

      return origSend.apply(this, arguments);
    };
  }

  // Let content.js know the MAIN-world hook is live, so it can skip its
  // <script>-tag fallback.
  post("READY", { url: window.location.href });
})();

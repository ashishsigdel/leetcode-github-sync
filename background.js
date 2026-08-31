const DEFAULT_BRANCH = "main";
const LOG_LIMIT = 15;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "LC2GH_SUBMISSION_SEEN") {
    const { slug, lang, hasCode } = message.payload || {};
    pushLog(hasCode ? `Submit detected: ${slug} (${lang})` : `Submit detected: ${slug} — but no code captured`);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "LC2GH_SUBMISSION_ACCEPTED") {
    handleAccepted(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch(async (err) => {
        const detail = String(err && err.message ? err.message : err);
        console.error("[LeetCode->GitHub]", err);
        chrome.action.setBadgeText({ text: "!" });
        chrome.action.setBadgeBackgroundColor({ color: "#d33" });
        await chrome.storage.local.set({ lastError: detail });
        await pushLog(`Commit failed: ${detail}`);
        sendResponse({ ok: false, error: detail });
      });
    return true; // keep the message channel open for the async response
  }

  if (message.type === "LC2GH_LIST_SOLUTIONS") {
    listSolutions(message.payload && message.payload.slug)
      .then((files) => sendResponse({ ok: true, files }))
      .catch((err) => reportLoadError(err, sendResponse));
    return true;
  }

  if (message.type === "LC2GH_FETCH_SOLUTION") {
    const { slug, path } = message.payload || {};
    fetchSolution(slug, path)
      .then(async (file) => {
        await pushLog(`Loaded ${file.path}`);
        sendResponse({ ok: true, ...file });
      })
      .catch((err) => reportLoadError(err, sendResponse));
    return true;
  }
});

// Small rolling activity log so failures are visible in the popup instead of
// disappearing into the service worker console.
async function pushLog(text) {
  try {
    const { log = [] } = await chrome.storage.local.get("log");
    log.unshift({ time: new Date().toISOString(), text });
    await chrome.storage.local.set({ log: log.slice(0, LOG_LIMIT) });
  } catch (e) {
    console.warn("[LeetCode->GitHub] could not write log", e);
  }
}

async function getSettings() {
  const { token, owner, repo, branch, includeReadme } = await chrome.storage.local.get([
    "token",
    "owner",
    "repo",
    "branch",
    "includeReadme",
  ]);
  return {
    token,
    owner,
    repo,
    branch: branch || DEFAULT_BRANCH,
    includeReadme: includeReadme !== false,
  };
}

// Every entry point needs the same three fields before it can talk to GitHub.
async function requireSettings() {
  const settings = await getSettings();
  if (!settings.token || !settings.owner || !settings.repo) {
    throw new Error(
      "Not configured yet. Click the extension icon > Options and add your GitHub token, owner, and repo."
    );
  }
  return settings;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function githubRequest(path, token, options = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    // The Contents API answers with "cache-control: public, max-age=60", so the
    // browser cache will happily replay a stale blob SHA for a minute. Solving
    // the same problem twice inside that window would then PUT an out-of-date
    // sha and GitHub rejects it with 409 - and every retry would replay the
    // same cached response, so it could never recover. Always hit the network.
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
}

// UTF-8 safe base64 encoding
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

// Encode each path segment separately: encodeURIComponent on the whole path
// turns the directory separators into %2F, which the Contents API rejects.
function encodePath(path) {
  return path
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

async function upsertFile({ owner, repo, branch, token, path, content, message }) {
  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`;

  // GitHub also returns 409 when the branch tip genuinely moved between our
  // GET and PUT (e.g. the code file and its README committed back to back).
  for (let attempt = 0; attempt < 4; attempt++) {
    const getRes = await githubRequest(`${apiPath}?ref=${encodeURIComponent(branch)}`, token);

    let sha;
    if (getRes.status === 200) {
      const json = await getRes.json();
      sha = json.sha;
    } else if (getRes.status === 404) {
      sha = undefined; // new file
    } else {
      throw new Error(`GitHub GET ${path} failed: ${getRes.status} ${await errorText(getRes)}`);
    }

    const body = { message, content: toBase64(content), branch };
    if (sha) body.sha = sha;

    const putRes = await githubRequest(apiPath, token, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (putRes.ok) return putRes.json();
    // Back off before re-reading: a write that has just landed can take a
    // moment to be visible to the next read.
    if (putRes.status === 409 && attempt < 3) {
      await sleep(250 * 2 ** attempt);
      continue;
    }

    throw new Error(`GitHub PUT ${path} failed: ${putRes.status} ${await errorText(putRes)}`);
  }
}

async function errorText(res) {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      return json.message || text;
    } catch (e) {
      return text;
    }
  } catch (e) {
    return "(no response body)";
  }
}

// Keep the repo path safe regardless of what the page handed us.
function safeSegment(value, fallback) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
  return cleaned || fallback;
}

// ---------------------------------------------------------------------------
// Reading back: find and download a previously synced solution. content.js
// asks for these by slug so the token never leaves this file.
// ---------------------------------------------------------------------------

function extOf(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot > 0 ? String(name).slice(dot + 1).toLowerCase() : "";
}

// Inverse of toBase64(). GitHub wraps its base64 at 60 columns, so strip
// whitespace before decoding, and decode as UTF-8 rather than latin-1.
function fromBase64(b64) {
  const binary = atob(String(b64 || "").replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// safeSegment() is what wrote the folder in the first place, so reuse it here
// rather than trusting the slug the page handed us.
function folderFor(slug) {
  const folder = safeSegment(slug, "");
  if (!folder) throw new Error("Could not work out the problem slug from the page.");
  return folder;
}

async function listSolutions(slug) {
  const { token, owner, repo, branch } = await requireSettings();
  const folder = folderFor(slug);

  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(folder)}`;
  const res = await githubRequest(`${apiPath}?ref=${encodeURIComponent(branch)}`, token);

  // Nothing synced for this problem yet - an empty result, not a failure.
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`GitHub GET ${folder} failed: ${res.status} ${await errorText(res)}`);
  }

  const json = await res.json();
  // A non-array body means a file sits where we expected the problem folder.
  if (!Array.isArray(json)) return [];

  return json
    .filter((entry) => entry && entry.type === "file" && entry.name.toLowerCase() !== "readme.md")
    .map((entry) => ({ name: entry.name, path: entry.path, ext: extOf(entry.name) }));
}

async function fetchSolution(slug, path) {
  const { token, owner, repo, branch } = await requireSettings();
  const folder = folderFor(slug);

  // The path comes from listSolutions(), but it round-trips through the page,
  // so confine reads to the problem's own folder regardless of what came back.
  if (!String(path || "").startsWith(`${folder}/`) || path.includes("..")) {
    throw new Error("Refusing to read outside the problem's folder.");
  }

  const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`;
  const res = await githubRequest(`${apiPath}?ref=${encodeURIComponent(branch)}`, token, {
    // Raw skips the base64 envelope entirely, and with it the Contents API's
    // 1 MB ceiling on base64-encoded responses.
    headers: { Accept: "application/vnd.github.raw" },
  });

  if (res.status === 404) throw new Error(`${path} is no longer in the repository.`);
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} failed: ${res.status} ${await errorText(res)}`);
  }

  // Some proxies drop the raw media type and hand back the JSON envelope.
  const type = res.headers.get("content-type") || "";
  let code;
  if (/json/i.test(type)) {
    const json = JSON.parse(await res.text());
    code = json && json.content ? fromBase64(json.content) : "";
  } else {
    code = await res.text();
  }

  if (!code) throw new Error(`${path} is empty - nothing to load.`);

  const name = path.slice(path.lastIndexOf("/") + 1);
  return { code, name, path, ext: extOf(name) };
}

// A failed load is user-initiated and already reported in the page's own
// toast, so unlike a failed commit it doesn't raise the error badge.
async function reportLoadError(err, sendResponse) {
  const detail = String(err && err.message ? err.message : err);
  console.error("[LeetCode->GitHub]", err);
  await pushLog(`Load failed: ${detail}`);
  sendResponse({ ok: false, error: detail });
}

async function handleAccepted(payload) {
  const { token, owner, repo, branch, includeReadme } = await requireSettings();

  const slug = safeSegment(payload && payload.slug, "");
  if (!slug) throw new Error("Could not work out the problem slug from the page.");

  const code = payload.code || "";
  if (!code.trim()) {
    throw new Error("Accepted, but the submitted code could not be read from the page - nothing to commit.");
  }

  const ext = safeSegment(payload.ext, "txt");
  const folder = slug;
  const codePath = `${folder}/${slug}.${ext}`;
  const message = `Add solution: ${payload.title || slug}`;

  await upsertFile({ owner, repo, branch, token, path: codePath, content: code, message });

  if (includeReadme) {
    const lines = [
      `# ${payload.title || slug}`,
      "",
      `- LeetCode: ${payload.url}`,
      `- Language: ${payload.lang}`,
    ];
    if (payload.runtime) lines.push(`- Runtime: ${payload.runtime}`);
    if (payload.memory) lines.push(`- Memory: ${payload.memory}`);
    lines.push("", "_Synced automatically via LeetCode → GitHub Sync extension._");

    await upsertFile({
      owner,
      repo,
      branch,
      token,
      path: `${folder}/README.md`,
      content: lines.join("\n"),
      message: `Add README: ${payload.title || slug}`,
    });
  }

  chrome.action.setBadgeText({ text: "✓" });
  chrome.action.setBadgeBackgroundColor({ color: "#2ea44f" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);

  await chrome.storage.local.set({
    lastError: null,
    lastSync: { title: payload.title, slug, time: new Date().toISOString() },
  });
  await pushLog(`Committed ${codePath}`);
}

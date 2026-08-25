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

async function githubRequest(path, token, options = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
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

  // GitHub returns 409 when the branch tip moved between our GET and PUT
  // (e.g. the code file and its README committed back to back).
  for (let attempt = 0; attempt < 3; attempt++) {
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
    if (putRes.status === 409 && attempt < 2) continue;

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

async function handleAccepted(payload) {
  const { token, owner, repo, branch, includeReadme } = await getSettings();
  if (!token || !owner || !repo) {
    throw new Error(
      "Not configured yet. Click the extension icon > Options and add your GitHub token, owner, and repo."
    );
  }

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

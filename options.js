const SVG_NS = "http://www.w3.org/2000/svg";

const STATUS_ICONS = {
  pending: ["M8 1.75a6.25 6.25 0 1 1-6.25 6.25"],
  ok: ["M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5Z", "M5.25 8.25 7.1 10.1l3.65-4"],
  err: ["M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5Z", "M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"],
};

const EYE = [
  "M1.5 8S4 3.9 8 3.9 14.5 8 14.5 8 12 12.1 8 12.1 1.5 8 1.5 8Z",
  "M8 6.1a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z",
];
const EYE_OFF = [
  "M1.5 8S4 3.9 8 3.9c1.05 0 1.98.28 2.78.7M14.5 8s-2.5 4.1-6.5 4.1c-1.05 0-1.98-.28-2.78-.7",
  "M2.5 2.5l11 11",
];

const els = {
  token: document.getElementById("token"),
  owner: document.getElementById("owner"),
  repo: document.getElementById("repo"),
  branch: document.getElementById("branch"),
  includeReadme: document.getElementById("includeReadme"),
  status: document.getElementById("status"),
  preview: document.getElementById("preview"),
  save: document.getElementById("save"),
  test: document.getElementById("test"),
  toggleToken: document.getElementById("toggleToken"),
};

let statusTimer;

function setStatus(message, kind) {
  clearTimeout(statusTimer);
  els.status.textContent = "";

  if (!message) {
    els.status.className = "";
    return;
  }

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", kind === "pending" ? "icon spin" : "icon");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const d of STATUS_ICONS[kind] || STATUS_ICONS.ok) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }

  els.status.className = `show ${kind}`;
  els.status.append(svg, document.createTextNode(message));

  if (kind === "ok") {
    statusTimer = setTimeout(() => setStatus(""), 4000);
  }
}

// Mirrors the layout background.js commits to: <slug>/<slug>.<ext> plus an
// optional README.md in the same folder.
function renderPreview() {
  const owner = els.owner.value.trim();
  const repo = els.repo.value.trim();
  const branch = els.branch.value.trim() || "main";

  els.preview.textContent = "";

  const head = document.createElement("b");
  head.textContent = `${owner || "owner"}/${repo || "repository"}`;
  els.preview.append(head, `  ·  ${branch}\n`);

  const files = ["two-sum.py"];
  if (els.includeReadme.checked) files.push("README.md");

  els.preview.append("└─ two-sum/\n");
  files.forEach((file, i) => {
    const last = i === files.length - 1;
    els.preview.append(`   ${last ? "└─" : "├─"} ${file}\n`);
  });
}

async function load() {
  const data = await chrome.storage.local.get(["token", "owner", "repo", "branch", "includeReadme"]);
  if (data.token) els.token.value = data.token;
  if (data.owner) els.owner.value = data.owner;
  if (data.repo) els.repo.value = data.repo;
  els.branch.value = data.branch || "main";
  els.includeReadme.checked = data.includeReadme !== false;
  renderPreview();
}

els.save.addEventListener("click", async () => {
  const settings = {
    token: els.token.value.trim(),
    owner: els.owner.value.trim(),
    repo: els.repo.value.trim(),
    branch: els.branch.value.trim() || "main",
    includeReadme: els.includeReadme.checked,
  };
  await chrome.storage.local.set(settings);
  els.branch.value = settings.branch;
  renderPreview();
  setStatus("Settings saved.", "ok");
});

els.test.addEventListener("click", async () => {
  const token = els.token.value.trim();
  const owner = els.owner.value.trim();
  const repo = els.repo.value.trim();
  const branch = els.branch.value.trim() || "main";

  if (!token || !owner || !repo) {
    setStatus("Fill in the token, owner, and repository first.", "err");
    return;
  }

  els.test.disabled = true;
  setStatus("Checking access…", "pending");

  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!userRes.ok) {
      setStatus(`Token rejected (${userRes.status}). Double-check the token.`, "err");
      return;
    }

    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${branch}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!repoRes.ok) {
      setStatus(`Cannot reach ${owner}/${repo} on ${branch} (${repoRes.status}).`, "err");
      return;
    }

    setStatus("Connected. Token and repository access confirmed.", "ok");
  } catch (e) {
    setStatus(`Network error: ${e.message}`, "err");
  } finally {
    els.test.disabled = false;
  }
});

// ---- Token guide modal ----
const guide = document.getElementById("tokenGuide");

document.getElementById("howTo").addEventListener("click", () => guide.showModal());

for (const id of ["closeGuide", "closeGuideFoot"]) {
  document.getElementById(id).addEventListener("click", () => guide.close());
}

// The dialog element itself is the backdrop area, so a click landing on it
// (rather than on the content inside) means the user clicked outside.
guide.addEventListener("click", (e) => {
  if (e.target === guide) guide.close();
});

els.toggleToken.addEventListener("click", () => {
  const shown = els.token.type === "text";
  els.token.type = shown ? "password" : "text";
  els.toggleToken.title = shown ? "Show token" : "Hide token";
  els.toggleToken.setAttribute("aria-label", els.toggleToken.title);

  const svg = els.toggleToken.querySelector("svg");
  svg.textContent = "";
  for (const d of shown ? EYE : EYE_OFF) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
});

for (const el of [els.owner, els.repo, els.branch]) {
  el.addEventListener("input", renderPreview);
}
els.includeReadme.addEventListener("change", renderPreview);

load();

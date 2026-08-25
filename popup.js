const SVG_NS = "http://www.w3.org/2000/svg";

// Stroke-path geometry for the 16px icon set, keyed by activity level.
const ICONS = {
  success: ["M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5Z", "M5.25 8.25 7.1 10.1l3.65-4"],
  error: ["M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5Z", "M5.9 5.9l4.2 4.2M10.1 5.9l-4.2 4.2"],
  warn: ["M8 2.25 14.75 13.5H1.25L8 2.25Z", "M8 6.5v3.1"],
  info: ["M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5Z", "M8 11.25V5.1M5.6 7.5 8 5.1l2.4 2.4"],
  neutral: ["M8 4.75a3.25 3.25 0 1 1 0 6.5 3.25 3.25 0 0 1 0-6.5Z"],
};

const EMPTY_ICON = [
  "M1.75 9.25h3l1 2h4.5l1-2h3",
  "M2.6 9.25 4.4 3.4h7.2l1.8 5.85v3a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-3Z",
];

function svgIcon(paths, className) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

// background.js records the log as a single sentence per entry. Rather than
// change what it writes, derive the level and a label/detail split from the
// wording here — that also keeps entries written by older versions readable.
function classify(text) {
  let m = /^Committed\s+(.+)$/.exec(text);
  if (m) return { level: "success", label: "Committed", detail: m[1], mono: true };

  m = /^Commit failed:\s*([\s\S]+)$/.exec(text);
  if (m) return { level: "error", label: "Commit failed", detail: m[1] };

  m = /^Submit detected:\s*(.+?)\s+—\s+but no code captured$/.exec(text);
  if (m) return { level: "warn", label: "No code captured", detail: m[1], mono: true };

  m = /^Submit detected:\s*(.+)$/.exec(text);
  if (m) return { level: "info", label: "Submission detected", detail: m[1], mono: true };

  return { level: "neutral", label: text, detail: "" };
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  if (secs < 604800) return `${Math.round(secs / 86400)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

let entries = [];
let filter = "all";

function renderLog() {
  const logEl = document.getElementById("log");
  logEl.textContent = "";

  const visible = entries.filter((e) => filter === "all" || e.level === filter);

  const badge = document.getElementById("stateBadge");
  badge.hidden = entries.length === 0;
  badge.textContent = visible.length === entries.length
    ? `${entries.length} event${entries.length === 1 ? "" : "s"}`
    : `${visible.length} of ${entries.length}`;

  if (!visible.length) {
    logEl.appendChild(blankslate());
    return;
  }

  for (const entry of visible) {
    const row = document.createElement("div");
    row.className = "entry";

    row.appendChild(svgIcon(ICONS[entry.level] || ICONS.neutral, `icon entry-icon is-${entry.level}`));

    const body = document.createElement("div");
    body.className = "entry-body";

    const label = document.createElement("div");
    label.className = "entry-label";
    label.textContent = entry.label;
    body.appendChild(label);

    if (entry.detail) {
      const detail = document.createElement("div");
      detail.className = entry.mono ? "entry-detail mono" : "entry-detail";
      detail.textContent = entry.detail;
      detail.title = entry.detail;
      body.appendChild(detail);
    }
    row.appendChild(body);

    const time = document.createElement("time");
    time.className = "entry-time";
    time.dateTime = entry.time;
    time.textContent = relativeTime(entry.time);
    time.title = new Date(entry.time).toLocaleString();
    row.appendChild(time);

    logEl.appendChild(row);
  }
}

function blankslate() {
  const wrap = document.createElement("div");
  wrap.className = "blank";
  wrap.appendChild(svgIcon(EMPTY_ICON, "icon"));

  const title = document.createElement("div");
  title.className = "blank-title";
  const text = document.createElement("div");
  text.className = "blank-text";

  if (!entries.length) {
    title.textContent = "No activity yet";
    text.textContent = "Submit a problem on LeetCode and the sync will show up here.";
  } else if (filter === "success") {
    title.textContent = "No successful syncs";
    text.textContent = "Nothing has been committed in the last few events.";
  } else {
    title.textContent = "No failures";
    text.textContent = "Every recorded submission synced cleanly.";
  }

  wrap.appendChild(title);
  wrap.appendChild(text);
  return wrap;
}

async function render() {
  const { token, owner, repo, branch, lastSync, lastError, log } = await chrome.storage.local.get([
    "token", "owner", "repo", "branch", "lastSync", "lastError", "log",
  ]);

  // Connection summary
  const configured = Boolean(token && owner && repo);
  const dot = document.getElementById("dot");
  const target = document.getElementById("target");
  dot.className = `dot ${configured ? "on" : "off"}`;

  target.textContent = "";
  target.className = configured ? "" : "repo-plain";
  if (configured) {
    const link = document.createElement("a");
    link.className = "repo";
    link.href = `https://github.com/${owner}/${repo}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `${owner}/${repo}`;
    link.title = `${owner}/${repo} · branch ${branch || "main"}`;
    target.appendChild(link);
  } else {
    target.textContent = "Not configured";
  }

  const lastEl = document.getElementById("lastSync");
  lastEl.textContent = "";
  if (lastSync) {
    const name = lastSync.title || lastSync.slug;
    lastEl.append("Last synced ");
    const strong = document.createElement("strong");
    strong.textContent = name;
    lastEl.append(strong, ` · ${relativeTime(lastSync.time)}`);
    lastEl.title = new Date(lastSync.time).toLocaleString();
  } else if (configured) {
    lastEl.textContent = "No submissions synced yet.";
  } else {
    lastEl.textContent = "Add a GitHub token and repository to start syncing.";
  }

  // Error banner
  const banner = document.getElementById("banner");
  banner.classList.toggle("show", Boolean(lastError));
  if (lastError) document.getElementById("bannerText").textContent = lastError;

  entries = (Array.isArray(log) ? log : []).map((e) => ({ time: e.time, ...classify(e.text || "") }));
  renderLog();
}

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("clearLog").addEventListener("click", async () => {
  await chrome.storage.local.set({ log: [], lastError: null });
  render();
});

for (const btn of document.querySelectorAll(".filter")) {
  btn.addEventListener("click", () => {
    filter = btn.dataset.filter;
    for (const other of document.querySelectorAll(".filter")) {
      other.setAttribute("aria-selected", String(other === btn));
    }
    renderLog();
  });
}

render();

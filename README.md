# LeetCode to GitHub Sync

**A Chrome extension that automatically commits your accepted LeetCode solutions to a GitHub repository.**

Solve a problem on LeetCode. The moment the judge returns **Accepted**, your solution is committed
to a repo you control — one folder per problem, with an optional README containing the problem link,
language, runtime and memory. No copy-paste, no third-party server, no account to create.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4493f8)
![Chrome 102+](https://img.shields.io/badge/Chrome-102%2B-1f883d)
![License](https://img.shields.io/badge/License-MIT-FFA116)

<!-- TODO: add a screenshot or GIF here. See "Publishing checklist" below. -->

---

## Contents

- [Features](#features)
- [Install](#install)
- [Set up GitHub access](#set-up-github-access)
- [What lands in your repo](#what-lands-in-your-repo)
- [Supported languages](#supported-languages)
- [Privacy and security](#privacy-and-security)
- [Troubleshooting](#troubleshooting)
- [How it works](#how-it-works)
- [FAQ](#faq)
- [Development](#development)
- [License](#license)

---

## Features

- **Fully automatic.** Watches for accepted submissions and commits them. Nothing to click.
- **One folder per problem.** `two-sum/two-sum.py`, not a flat dump of files.
- **Optional per-problem README** with the problem link, language, runtime and memory.
- **Your repo, your token.** A fine-grained GitHub token scoped to a single repository, stored only
  in your browser.
- **No server in the middle.** The extension talks directly to `api.github.com`. There is no backend,
  no analytics and no telemetry.
- **Activity log** in the popup so you can see exactly what synced, what failed and why.
- **Re-submissions update the file** in place using its current blob SHA — a normal Git update, not
  a duplicate.
- **Light and dark UI** that follows your system theme.
- 25+ languages mapped to the right file extension.

## Install

### Option A — from a release ZIP (recommended for most people)

1. Download the latest `leetcode-github-sync.zip` from the [Releases](../../releases) page.
2. Unzip it somewhere permanent — **if you delete the folder, the extension stops working.**
3. Open `chrome://extensions`.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).

### Option B — from source

```bash
git clone https://github.com/<your-username>/leetcode-github-sync.git
```

Then follow steps 3–5 above, selecting the cloned folder.

> **Why not a one-click install?** Chrome only allows one-click installs from the Chrome Web Store.
> Self-hosted `.crx` files are blocked outside of enterprise policy, so "Load unpacked" is the
> standard route until the extension is published to the store.

Works in Chrome and other Chromium browsers (Edge, Brave, Arc, Vivaldi). Firefox would need porting
work and is not currently supported.

## Set up GitHub access

You need a repository to sync into. **Create it on GitHub first** — the extension commits to an
existing repo, it does not create one. Make sure it has at least one commit, so the branch exists.

### 1. Create a fine-grained token

The extension's settings page has a **How to get?** button that walks through this, or:

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).
2. **Token name:** anything recognisable, e.g. `leetcode-sync`.
3. **Expiration:** your choice. When it expires, syncing stops until you paste in a new token.
4. **Repository access:** *Only select repositories* → pick your solutions repo.
5. **Permissions** → *Repository permissions* → **Contents: Read and write**.
   That is the only permission needed.
6. **Generate token** and copy it. GitHub shows it only once.

### 2. Configure the extension

1. Click the extension icon, then the gear icon (or right-click the icon → **Options**).
2. Paste the token, enter the repository **owner** (your username or org) and **repository** name,
   and confirm the **branch** (defaults to `main`).
3. Click **Save changes**, then **Test connection** to verify both the token and the repo before you
   rely on it.

## What lands in your repo

Solve *Two Sum* in Python and you get:

```
your-repo/
└── two-sum/
    ├── two-sum.py
    └── README.md        # optional — toggle in settings
```

The generated per-problem README looks like this:

```markdown
# Two Sum

- LeetCode: https://leetcode.com/problems/two-sum/
- Language: python3
- Runtime: 52 ms
- Memory: 17.2 MB

_Synced automatically via LeetCode → GitHub Sync extension._
```

Commits are messaged `Add solution: <problem title>` and `Add README: <problem title>`.

## Supported languages

| Language | File | Language | File |
| --- | --- | --- | --- |
| Python / Python3 | `.py` | Rust | `.rs` |
| Java | `.java` | Ruby | `.rb` |
| C++ | `.cpp` | Scala | `.scala` |
| C | `.c` | Racket | `.rkt` |
| C# | `.cs` | Erlang | `.erl` |
| JavaScript | `.js` | Elixir | `.ex` |
| TypeScript | `.ts` | Dart | `.dart` |
| PHP | `.php` | Bash | `.sh` |
| Swift | `.swift` | Pandas | `.py` |
| Kotlin | `.kt` | MySQL / MS SQL / Oracle / PostgreSQL | `.sql` |
| Go | `.go` | *anything else* | `.txt` |

## Privacy and security

- Your token is stored in `chrome.storage.local` — **on your machine only.** It is never synced to a
  Google account and never leaves your browser except in requests to `api.github.com`.
- The extension requests exactly two host permissions: `leetcode.com` (to watch for submissions) and
  `api.github.com` (to commit). Plus `storage`, to save your settings.
- `inject.js` runs in the LeetCode page but **never reads your token** — it only observes submission
  network calls the page already makes and forwards the result. `background.js` is the only file that
  ever sees the token.
- No analytics, no telemetry, no remote code loading, no third-party server.
- Use a **fine-grained** token scoped to one repository with `Contents: Read and write`. If it ever
  leaks, the blast radius is that single repo.

The whole thing is a few hundred lines of readable JavaScript with no dependencies and no build step —
you can audit it in one sitting.

## Troubleshooting

Open the extension popup. The **Activity** list shows how far the pipeline got, and you can filter it
to just **Failed** events.

| What you see | What it means |
| --- | --- |
| Nothing at all | The page hook never ran. **Reload the LeetCode tab** — a tab opened before you installed or reloaded the extension is still running the old code. |
| `Submission detected` but no commit | Interception works. Either the submission wasn't accepted, or the commit failed — check the error banner. |
| `Commit failed: 404 Not Found` | Wrong owner/repo, or the token isn't scoped to that repository. |
| `Commit failed: 401` / `403` | Token is invalid, expired, or missing `Contents: Read and write`. |
| `Commit failed: 409` / `422` | The branch in settings doesn't exist. A brand-new repo has no `main` branch until its first commit. |
| `No code captured` | LeetCode changed its submit payload shape and the editor fallback also came up empty. Please open an issue. |
| Nothing syncs after a Chrome update | Reload the extension at `chrome://extensions`, then reload your LeetCode tab. |

For lower-level detail, open DevTools on the LeetCode tab and filter the console for `[LC2GH]` —
every intercepted request is logged there.

## How it works

Four small files, each with one job:

| File | Role |
| --- | --- |
| `inject.js` | Runs in the LeetCode page's own JS context. Wraps `fetch` and `XMLHttpRequest` to observe the submit and result-polling calls the page already makes. Never touches your token. |
| `content.js` | Runs in the extension's isolated world. Adds the human-readable problem title from the DOM and relays the event to the background worker. |
| `background.js` | The only file that talks to GitHub. Reads the token from storage and calls the GitHub Contents API directly. |
| `popup.html` / `options.html` | Activity log and settings. |

A couple of deliberate design notes:

- The hook is installed on **every** `leetcode.com` page, not just `/problems/*`. LeetCode is a
  single-page app and Chrome does not re-inject content scripts on client-side navigation, so a hook
  scoped to `/problems/*` would never load if you arrived there by clicking a link.
- `content.js` also injects `inject.js` as a page `<script>` as a fallback, because Chrome versions
  before 111 silently ignore `"world": "MAIN"` in the manifest. `inject.js` guards against
  double-execution.
- Commits retry on HTTP 409 (up to 3 attempts), which happens when the branch tip moves between
  reading a file's SHA and writing it — for example when a solution and its README commit back to back.

## FAQ

**Does it sync my past submissions?**
No. It only reacts to submissions you make while it's installed. Backfilling would require scraping
your full submission history, which is out of scope.

**Does it push failed attempts?**
No — only `Accepted` submissions.

**What if I solve the same problem again?**
The file is updated in place, so your repo keeps your latest accepted solution rather than gaining
duplicates.

**Can I customise the folder structure or commit message?**
Not from the UI yet. The layout is defined in `handleAccepted()` in `background.js` and is easy to
change if you're editing the source.

**Does it work on leetcode.cn?**
No. Only `leetcode.com` is in the host permissions.

**Will my token be visible to LeetCode?**
No. The token is only ever read inside the extension's service worker, never in the page context.

## Development

No build step, no dependencies. Edit a file, then reload the extension at `chrome://extensions` and
reload your LeetCode tab.

```
├── manifest.json      # MV3 manifest
├── background.js      # service worker — all GitHub API calls
├── inject.js          # page-world network observer
├── content.js         # isolated-world relay
├── popup.html/.js     # activity log
├── options.html/.js   # settings
└── icons/             # PNG icons + SVG sources
```

To build a distributable ZIP:

```bash
zip -r leetcode-github-sync.zip . \
  -x '*.git*' '*.DS_Store' '*.zip' 'docs/*'
```

`manifest.json` must sit at the root of the ZIP.

## Contributing

Issues and pull requests are welcome. If LeetCode changes its internal API and syncing breaks, an
issue with the `[LC2GH]` console output from a submission attempt is the most useful thing you can
send.

## License

MIT — see [LICENSE](LICENSE).

---

<sub>Keywords: leetcode to github, leetcode github sync, auto commit leetcode solutions, leetcode
solutions repository, chrome extension, manifest v3, github contents api, coding interview prep, dsa
practice tracker.</sub>

# GitHub PR Tab Group

A Chrome extension that keeps **live tab groups** in sync with your GitHub
pull requests — one group for PRs you authored, one for PRs you were asked to
review:

- Periodically fetches PRs you authored that are still open (via the GitHub API).
- When you open a new PR, a tab for it is added to the group **in the background**
  (focus never moves to it).
- When a PR is merged or closed, its tab is removed — **unless it's the tab you're
  currently looking at**, in which case it's left alone until you move away.
- PR tabs you already have open elsewhere (including `/files`, `/commits`, etc.)
  are recognized and pulled into the group instead of being duplicated.
- The group names show a live count, e.g. "🔀 My PRs (7)".
- A second group ("👀 Reviews") tracks PRs where you're personally requested
  as a reviewer (`user-review-requested:@me` — by name, not via a team).
  Submitting a review (approve / comment / request changes) clears the request
  on GitHub, so the tab is removed on the next sync — with the same
  don't-close-the-active-tab protection.
- If you open a link to a PR that already has a tab in the group, a small
  banner appears in the corner of the page offering to swap the freshly opened
  tab into the group and close the group's older copy (or keep both).
  Shortcuts: **Enter** = use this tab, **Esc** = keep both (disabled while a
  text field is focused). Auto-dismisses after 10 seconds.

## Install

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and select this `github-pr-tab-group/` directory.

## Setup

The extension uses the GitHub REST API and needs a personal access token.
Both token kinds work:

- **Fine-grained** (recommended): create one at
  <https://github.com/settings/personal-access-tokens/new> with
  - **Repository access**: the repositories (or "All repositories") whose PRs
    should show up — PRs in repos the token can't see are silently excluded
    from the search results;
  - **Permissions → Pull requests: Read-only** (Metadata: Read-only is added
    automatically).
  - If your PRs live in an organization, pick that org as the **Resource
    owner** — the org may need to approve fine-grained tokens.
- **Classic**: create one at <https://github.com/settings/tokens/new> with the
  `repo` scope (`public_repo` if you only need public repos).

Fine-grained tokens always expire (1 year max), so you'll need to renew
periodically; a classic token can be non-expiring. Either way the token is
stored only in your browser.

Then right-click the extension icon → **Options** (or **Details → Extension
options** on `chrome://extensions`), paste the token, and **Save**.

Options also let you change the poll interval and the group's title/color, and
show a **Last sync** report (mode, PR count, tabs opened/closed, errors). The
toolbar icon badge shows the number of open PRs after each sync, or a red `!`
if a sync fails (hover the icon for the error).

## Behavior details

- The tab group is found by its stored id first, then by title — so if you close
  the whole group, it's recreated on the next sync.
- New tabs open in the group's window; if the group doesn't exist yet, in your
  last-focused window.
- Active or pinned PR tabs are never moved between windows or closed.
- Polling uses `chrome.alarms`; Chrome enforces a 30-second minimum interval.
- Manual sync: press **⌘⇧Y** (Ctrl+Shift+Y on Windows/Linux), click the
  toolbar icon, or use the **Sync now** button in options. The badge shows `…`
  while a sync is running. Rebind the shortcut at `chrome://extensions/shortcuts`.

## Permissions

- `tabs`, `tabGroups` — read/manage the PR tab group.
- `alarms` — the periodic fetch.
- `storage` — settings (the token is stored in `chrome.storage.local`, never
  leaves your machine except in requests to `api.github.com`).
- `scripting` + host access to `https://github.com/*` — injects the
  duplicate-PR banner into PR pages.
- Host access to `https://api.github.com/*` — the PR fetch.

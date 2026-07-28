const ALARM_NAME = "sync-prs";

const DEFAULT_SETTINGS = {
  token: "",
  pollMinutes: 1,
  groupTitle: "🔀 My PRs",
  groupColor: "blue",
  reviewGroupTitle: "👀 Reviews",
  reviewGroupColor: "orange",
};

// The managed tab groups. Each one is kept in sync with a GitHub search:
// - mine:   PRs I authored
// - review: PRs where I'm personally requested as a reviewer (by name, not
//           via a team). Submitting a review clears the request on GitHub's
//           side, so the PR drops out of the query and its tab is closed by
//           the normal stale-tab logic.
function groupConfigs(settings) {
  return [
    {
      kind: "mine",
      query: "is:pr is:open author:@me archived:false",
      title: settings.groupTitle,
      color: settings.groupColor,
    },
    {
      kind: "review",
      query: "is:pr is:open user-review-requested:@me archived:false",
      title: settings.reviewGroupTitle,
      color: settings.reviewGroupColor,
    },
  ];
}

chrome.runtime.onInstalled.addListener(scheduleAndSync);
chrome.runtime.onStartup.addListener(scheduleAndSync);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) sync();
});

// Manual sync: toolbar button click or the sync-now keyboard shortcut.
chrome.action.onClicked.addListener(() => sync());
chrome.commands.onCommand.addListener((command) => {
  if (command === "sync-now") sync();
});

// Options page notifies us when settings change so the alarm interval updates.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "swap-decision") {
    // Only honor the decision coming from the tab the banner was shown in.
    if (msg.accept && sender.tab && sender.tab.id === msg.newTabId) {
      swapIntoGroup(msg.newTabId, msg.oldTabId);
    }
    return;
  }
  if (msg && msg.type === "settings-changed") {
    scheduleAndSync().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg && msg.type === "sync-now") {
    sync()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

async function getSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

// State persisted between syncs: { <kind>: { groupId, keys: ["o/r#1", …] } }
async function getManagedState() {
  const { managedState } = await chrome.storage.local.get("managedState");
  if (managedState) return managedState;
  // Migrate from the single-group storage layout.
  const { groupId, openPrKeys } = await chrome.storage.local.get([
    "groupId",
    "openPrKeys",
  ]);
  return groupId != null ? { mine: { groupId, keys: openPrKeys || [] } } : {};
}

async function scheduleAndSync() {
  const { pollMinutes } = await getSettings();
  // chrome.alarms enforces a 30-second minimum period.
  const period = Math.max(0.5, Number(pollMinutes) || DEFAULT_SETTINGS.pollMinutes);
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: period });
  sync();
}

let syncInFlight = false;

async function sync() {
  if (syncInFlight) return;
  syncInFlight = true;
  const report = { when: new Date().toLocaleString(), ok: false };
  try {
    await setBadge("…", "#59636e", "syncing…");
    const settings = await getSettings();
    report.mode = "api (token)";
    if (!settings.token) {
      throw new Error("No GitHub token configured — set one in Options");
    }

    const managedState = await getManagedState();
    const counts = {};
    for (const cfg of groupConfigs(settings)) {
      const prUrls = await fetchOpenPrUrlsViaApi(settings.token, cfg.query);
      const stats = await reconcileTabs(prUrls, cfg, managedState);
      managedState[cfg.kind] = {
        groupId: stats.groupId,
        keys: prUrls.map(prKey).filter(Boolean),
      };
      counts[cfg.kind] = prUrls.length;
      report[cfg.kind] = { prCount: prUrls.length, samplePrs: prUrls.slice(0, 5), ...stats };
    }
    await chrome.storage.local.set({ managedState });
    report.ok = true;

    const mine = counts.mine || 0;
    const review = counts.review || 0;
    let badge = String(mine);
    if (review > 0) {
      const both = `${mine}/${review}`;
      badge = both.length <= 4 ? both : String(mine + review);
    }
    await setBadge(
      badge,
      "#2da44e",
      `synced ${mine} open PR(s), ${review} review request(s)`
    );
  } catch (err) {
    console.error("PR sync failed:", err);
    report.error = String((err && err.message) || err);
    await setBadge("!", "#d73a49", `Sync failed: ${report.error}`);
  } finally {
    await chrome.storage.local.set({ lastSync: report });
    syncInFlight = false;
  }
}

async function setBadge(text, color, title) {
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({
    title: `GitHub PR Tab Group — ${title}`,
  });
}

async function fetchOpenPrUrlsViaApi(token, query) {
  const res = await fetch(
    `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (res.status === 401) {
    throw new Error(
      "GitHub rejected the token (401) — check it in Options (it may have expired)"
    );
  }
  if (res.status === 403) {
    // Typical for a fine-grained token missing the Pull requests: Read
    // permission (classic tokens with bad scopes usually 401 or return
    // filtered results instead).
    throw new Error(
      "GitHub refused the request (403) — if you use a fine-grained token, " +
        "make sure it has the 'Pull requests: Read-only' permission"
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  console.log(`[pr-sync] GitHub API "${query}": ${data.total_count} PR(s)`);
  return (data.items || []).map((item) => item.html_url);
}

// When the user opens a PR that already has a tab in a managed group (e.g.
// by clicking a link somewhere), offer to make the freshly opened tab the
// group's tab for that PR instead of keeping both.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  const key = prKey(changeInfo.url);
  if (!key) return;

  const managedState = await getManagedState();
  for (const st of Object.values(managedState)) {
    if (!st || st.groupId == null || !(st.keys || []).includes(key)) continue;
    if (tab.groupId === st.groupId) return; // this IS the group's tab

    let groupTabs;
    try {
      groupTabs = await chrome.tabs.query({ groupId: st.groupId });
    } catch {
      continue; // group no longer exists
    }
    const existing = groupTabs.find(
      (t) => t.id !== tabId && prKey(t.url || t.pendingUrl) === key
    );
    if (!existing) continue;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: showSwapBanner,
        args: [key, tabId, existing.id],
      });
    } catch (err) {
      console.warn("[pr-sync] could not show in-page prompt:", err);
    }
    return;
  }
});

// Injected into the PR page. Runs in an isolated world but shares the DOM,
// so everything is built with createElement (GitHub enforces Trusted Types,
// which rejects innerHTML). chrome.runtime.sendMessage is available to
// injected scripts and carries the user's choice back to the service worker.
function showSwapBanner(prLabel, newTabId, oldTabId) {
  const ID = "__pr_tab_group_swap_banner__";
  document.getElementById(ID)?.dispatchEvent(new CustomEvent("pr-banner-close"));

  const banner = document.createElement("div");
  banner.id = ID;
  banner.style.cssText =
    "position:fixed;top:16px;right:16px;z-index:2147483647;max-width:340px;" +
    "background:#fff;color:#1f2328;border:1px solid #d1d9e0;border-radius:12px;" +
    "box-shadow:0 8px 24px rgba(140,149,159,0.3);padding:14px 16px;" +
    "font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";

  const decide = (accept) => {
    chrome.runtime.sendMessage({ type: "swap-decision", accept, newTabId, oldTabId });
    cleanup();
  };

  // Keyboard shortcuts: Enter = use this tab, Esc = keep both. Ignored while
  // typing in an input, textarea, or contenteditable (e.g. a comment box).
  const onKeydown = (e) => {
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")
    ) {
      return;
    }
    if (e.key === "Enter") decide(true);
    else if (e.key === "Escape") decide(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const timer = setTimeout(() => cleanup(), 10000);
  function cleanup() {
    clearTimeout(timer);
    window.removeEventListener("keydown", onKeydown, true);
    banner.remove();
  }
  banner.addEventListener("pr-banner-close", cleanup);
  window.addEventListener("keydown", onKeydown, true);

  const text = document.createElement("div");
  text.textContent = `${prLabel} already has a tab in your PR group. Use this tab instead?`;
  text.style.cssText = "margin-bottom:10px;";
  banner.appendChild(text);

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;align-items:center;";

  const hint = document.createElement("span");
  hint.textContent = "⏎ yes · esc no";
  hint.style.cssText = "margin-right:auto;color:#59636e;font-size:11px;";
  row.appendChild(hint);

  const mkButton = (label, primary, accept) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "padding:5px 12px;border-radius:6px;font-size:12px;cursor:pointer;" +
      (primary
        ? "background:#1f883d;border:1px solid #1f883d;color:#fff;"
        : "background:#f6f8fa;border:1px solid #d1d9e0;color:#1f2328;");
    b.addEventListener("click", () => decide(accept));
    return b;
  };
  row.appendChild(mkButton("Keep both", false, false));
  row.appendChild(mkButton("Use this tab", true, true));
  banner.appendChild(row);

  (document.body || document.documentElement).appendChild(banner);
}

async function swapIntoGroup(newTabId, oldTabId) {
  try {
    // Swap in place: pull the new tab into whichever group the old copy is
    // in, slot it where the old one sat (best effort), then close the old.
    const oldTab = await chrome.tabs.get(oldTabId);
    if (oldTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;
    await chrome.tabs.group({ groupId: oldTab.groupId, tabIds: [newTabId] });
    try {
      await chrome.tabs.move(newTabId, {
        index: oldTab.index,
        windowId: oldTab.windowId,
      });
    } catch {
      // Cosmetic only — the tab is in the group either way.
    }
    await chrome.tabs.remove(oldTabId);
    console.log(`[pr-sync] swapped tab ${newTabId} into group, closed ${oldTabId}`);
  } catch (err) {
    console.warn("[pr-sync] swap failed:", err);
  }
}

// Normalizes any PR-ish URL (including /files, /commits, query, fragment)
// to a stable key like "owner/repo#123". Returns null for non-PR URLs.
function prKey(url) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(
    url || ""
  );
  return match ? `${match[1]}/${match[2]}#${match[3]}` : null;
}

async function findGroup(cfg, managedState) {
  const groupId = managedState[cfg.kind]?.groupId;
  if (groupId !== undefined && groupId !== null) {
    try {
      return await chrome.tabGroups.get(groupId);
    } catch {
      // Group was closed; fall through and look it up by title.
    }
  }
  // The live title carries a "(N)" count suffix, so match on the base name.
  const groups = await chrome.tabGroups.query({});
  return groups.find((g) => (g.title || "").startsWith(cfg.title)) || null;
}

async function reconcileTabs(prUrls, cfg, managedState) {
  const stats = { tabsClosed: 0, tabsOpened: 0, tabsAdopted: 0, groupId: null };
  const openPrs = new Map(); // key -> canonical PR url
  for (const url of prUrls) {
    const key = prKey(url);
    if (key) openPrs.set(key, url);
  }

  let group = await findGroup(cfg, managedState);
  const liveTitle = `${cfg.title} (${openPrs.size})`;
  console.log(
    `[pr-sync] [${cfg.kind}] ${openPrs.size} open PR(s); existing group:`,
    group ? group.id : "none"
  );

  // Tabs living in the OTHER managed groups are theirs to manage — never
  // adopt or double-track them from this group.
  const otherGroupIds = new Set(
    Object.entries(managedState)
      .filter(([kind, st]) => kind !== cfg.kind && st && st.groupId != null)
      .map(([, st]) => st.groupId)
  );

  // 1) Close tabs in the group whose PR is no longer in the query results —
  //    but never the tab the user is currently looking at (active tab of the
  //    last-focused window). A selected tab in a background window is fair game.
  if (group) {
    const focusedWindow = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
    const isBeingViewed = (tab) =>
      tab.active && tab.windowId === focusedWindow.id;
    const groupTabs = await chrome.tabs.query({ groupId: group.id });
    const staleTabIds = groupTabs
      .filter((tab) => {
        const key = prKey(tab.url || tab.pendingUrl);
        return (!key || !openPrs.has(key)) && !isBeingViewed(tab);
      })
      .map((tab) => tab.id);
    if (staleTabIds.length) {
      console.log(`[pr-sync] [${cfg.kind}] closing stale tabs:`, staleTabIds);
      await chrome.tabs.remove(staleTabIds);
      stats.tabsClosed = staleTabIds.length;
    }
  }

  // 2) Figure out which open PRs already have a tab somewhere. If a PR has
  //    several tabs, prefer the one already in the group so duplicates never
  //    get adopted alongside it.
  const allTabs = await chrome.tabs.query({});
  const existingByKey = new Map();
  for (const tab of allTabs) {
    const key = prKey(tab.url || tab.pendingUrl);
    if (!key) continue;
    const prev = existingByKey.get(key);
    const tabInGroup = group && tab.groupId === group.id;
    const prevInGroup = prev && group && prev.groupId === group.id;
    if (!prev || (tabInGroup && !prevInGroup)) existingByKey.set(key, tab);
  }

  const tabIdsToGroup = [];
  for (const [key, url] of openPrs) {
    const existing = existingByKey.get(key);
    if (existing) {
      const alreadyGrouped = group && existing.groupId === group.id;
      // Pull loose PR tabs into the group, but don't yank a tab the user is
      // actively using (grouping can move it across windows), pinned tabs
      // can't be grouped at all, and other managed groups keep their tabs.
      if (
        !alreadyGrouped &&
        !existing.active &&
        !existing.pinned &&
        !otherGroupIds.has(existing.groupId)
      ) {
        console.log(`[pr-sync] [${cfg.kind}] adopting existing tab ${existing.id} for ${key}`);
        tabIdsToGroup.push(existing.id);
        stats.tabsAdopted++;
      }
    } else {
      const windowId = group
        ? group.windowId
        : (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id;
      // active: false — new PR tabs never steal focus.
      console.log(`[pr-sync] [${cfg.kind}] opening background tab for ${url}`);
      const tab = await chrome.tabs.create({ url, active: false, windowId });
      tabIdsToGroup.push(tab.id);
      stats.tabsOpened++;
    }
  }

  // 3) Attach the collected tabs to the group, creating it if needed.
  if (tabIdsToGroup.length) {
    if (group) {
      await chrome.tabs.group({ groupId: group.id, tabIds: tabIdsToGroup });
    } else {
      const newGroupId = await chrome.tabs.group({ tabIds: tabIdsToGroup });
      group = await chrome.tabGroups.get(newGroupId);
      console.log(`[pr-sync] [${cfg.kind}] created group ${newGroupId} in window ${group.windowId}`);
    }
  }

  // Keep the group's name (with live PR count) and color in sync.
  if (group && (group.title !== liveTitle || group.color !== cfg.color)) {
    await chrome.tabGroups.update(group.id, {
      title: liveTitle,
      color: cfg.color,
    });
  }

  stats.groupId = group ? group.id : null;
  console.log(`[pr-sync] [${cfg.kind}] done:`, JSON.stringify(stats));
  return stats;
}

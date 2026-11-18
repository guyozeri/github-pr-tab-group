const DEFAULT_SETTINGS = {
  token: "",
  pollMinutes: 1,
  groupTitle: "🔀 My PRs",
  groupColor: "blue",
  reviewGroupTitle: "👀 Reviews",
  reviewGroupColor: "orange",
  maxTabsPerGroup: 0, // 0 = no limit
};

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function showStatus(message, ok) {
  statusEl.textContent = message;
  statusEl.className = ok ? "ok" : "error";
}

async function load() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  $("token").value = settings.token;
  $("pollMinutes").value = settings.pollMinutes;
  $("groupTitle").value = settings.groupTitle;
  $("groupColor").value = settings.groupColor;
  $("reviewGroupTitle").value = settings.reviewGroupTitle;
  $("reviewGroupColor").value = settings.reviewGroupColor;
  $("maxTabsPerGroup").value = settings.maxTabsPerGroup;
}

async function save() {
  const settings = {
    token: $("token").value.trim(),
    pollMinutes: Math.max(0.5, Number($("pollMinutes").value) || 1),
    groupTitle: $("groupTitle").value.trim() || DEFAULT_SETTINGS.groupTitle,
    groupColor: $("groupColor").value,
    reviewGroupTitle:
      $("reviewGroupTitle").value.trim() || DEFAULT_SETTINGS.reviewGroupTitle,
    reviewGroupColor: $("reviewGroupColor").value,
    maxTabsPerGroup: Math.max(0, Math.floor(Number($("maxTabsPerGroup").value) || 0)),
  };
  await chrome.storage.local.set(settings);
  await chrome.runtime.sendMessage({ type: "settings-changed" });
  showStatus("Saved. Syncing…", true);
}

async function syncNow() {
  showStatus("Syncing…", true);
  const res = await chrome.runtime.sendMessage({ type: "sync-now" });
  if (res && res.ok) {
    showStatus("Sync complete.", true);
  } else {
    showStatus(`Sync failed: ${(res && res.error) || "unknown error"}`, false);
  }
}

async function renderReport() {
  const { lastSync } = await chrome.storage.local.get("lastSync");
  if (lastSync) $("report").textContent = JSON.stringify(lastSync, null, 2);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.lastSync) renderReport();
});

$("save").addEventListener("click", () => save().catch((e) => showStatus(String(e), false)));
$("sync").addEventListener("click", () => syncNow().catch((e) => showStatus(String(e), false)));

load();
renderReport();

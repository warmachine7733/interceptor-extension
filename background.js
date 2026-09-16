chrome.action.onClicked.addListener(() => {
  try {
    chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error('Error opening options page:', error);
  }
});

// Storage readers supply empty defaults. Do not write a stale install-time
// snapshot over settings that the user may already have changed in Options.
// A missing watchedHosts key is an empty watchlist, including on upgrades.

// Tracks the last focused http(s) tab's origin/pathname so the options page can show the
// real app URL in the Record Flow setup panel (an options.html page can't read this itself -
// it isn't a web app tab). Display/UI data only: never read by rules.js/page-interceptor.js.
function isMonitorableUrl(url) {
  try { return ["http:", "https:"].includes(new URL(url).protocol); } catch { return false; }
}
function rememberActiveTab(tab) {
  if (!tab?.url || !isMonitorableUrl(tab.url)) return;
  try {
    const parsed = new URL(tab.url);
    chrome.storage.local.set({ lastActiveTab: { origin: parsed.origin, pathname: parsed.pathname, updatedAt: Date.now() } });
  } catch { /* ignore malformed tab URLs */ }
}
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => { if (!chrome.runtime.lastError) rememberActiveTab(tab); });
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") rememberActiveTab(tab);
});


// One writer across tabs/frames; MAIN-world code cannot access extension storage.
let recordingWriteQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "recording-capture" || !sender.tab) return;
  recordingWriteQueue = recordingWriteQueue.then(async () => {
    const { recording, watchedHosts } = await chrome.storage.local.get({ recording: null, watchedHosts: [] });
    const record = message.record;
    if (!recording?.active || recording.flowId !== message.flowId || !record?.url || !record?.method) return;
    // sender.url identifies the originating frame, unlike sender.tab.url (top frame).
    if (!sender.url) return;
    const url = new URL(sender.url);
    if (!['http:', 'https:'].includes(url.protocol) || !watchedHosts.includes(url.host)) return;
    // Defense in depth: validate the destination again in the sole storage writer.
    // Sessions created before apiOrigin existed remain compatible and unrestricted.
    if (recording.apiOrigin && new URL(record.url).origin !== recording.apiOrigin) return;
    const captured = Array.isArray(recording.captured) ? recording.captured : [];
    if (captured.some((item) => item.id === record.id)) return;
    await chrome.storage.local.set({ recording: { ...recording, captured: [...captured, record] } });
  }).then(() => sendResponse({ ok: true }), (error) => {
    console.warn("[FlowRecord] Capture write failed:", error.message);
    sendResponse({ ok: false });
  });
  return true;
});

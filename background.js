chrome.action.onClicked.addListener(() => {
  try {
    chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error('Error opening options page:', error);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.storage.local.get({ enabled: false, rules: [] }, (result) => {
      if (chrome.runtime.lastError) {
        console.error('Storage error on install:', chrome.runtime.lastError);
        return;
      }
      chrome.storage.local.set({ enabled: result.enabled, rules: result.rules }, () => {
        if (chrome.runtime.lastError) {
          console.error('Storage set error:', chrome.runtime.lastError);
        }
      });
    });
  } catch (error) {
    console.error('Error in onInstalled:', error);
  }
});

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
    const { recording } = await chrome.storage.local.get({ recording: null });
    const record = message.record;
    if (!recording?.active || recording.flowId !== message.flowId || !record?.url || !record?.method) return;
    const captured = Array.isArray(recording.captured) ? recording.captured : [];
    if (captured.some((item) => item.id === record.id)) return;
    await chrome.storage.local.set({ recording: { ...recording, captured: [...captured, record] } });
  }).then(() => sendResponse({ ok: true }), (error) => {
    console.warn("[FlowRecord] Capture write failed:", error.message);
    sendResponse({ ok: false });
  });
  return true;
});

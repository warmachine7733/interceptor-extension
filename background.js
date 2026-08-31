chrome.action.onClicked.addListener(() => {
  try {
    chrome.runtime.openOptionsPage();
  } catch (error) {
    console.error('Error opening options page:', error);
  }
});

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.storage.local.get({ enabled: true, rules: [] }, (result) => {
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

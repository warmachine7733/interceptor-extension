(() => {
  const sendConfig = () => {
    chrome.storage.local.get({ enabled: true, rules: [] }, (config) => {
      window.postMessage({ source: "local-api-mock", type: "config", config }, "*");
    });
  };

  window.addEventListener("message", (event) => {
    if (event.source === window && event.data?.source === "local-api-mock" && event.data?.type === "get-config") sendConfig();
  });
  chrome.storage.onChanged.addListener(sendConfig);
  sendConfig();
})();

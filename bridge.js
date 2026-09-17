(() => {
  const { firstMatch } = window.ApiMockRules;
  let configGeneration = 0;
  const sendConfig = () => {
    const generation = ++configGeneration;
    chrome.storage.local.get({ enabled: false, rules: [], flows: [], activeFlowId: null, recording: null }, (saved) => {
      // storage.get is asynchronous. A slower earlier read must not overwrite a
      // newer Flow enable/save update in the page interceptor.
      if (generation !== configGeneration) return;
      config = saved;
      window.postMessage({ source: "local-api-mock", type: "config", config: saved }, "*");
      observer.disconnect();
      if (config.enabled) {
        inspectStylesheets();
        observer.observe(document, { childList: true, subtree: true });
      }
    });
  };

  let config = { enabled: false, rules: [] };
  const handledLinks = new WeakSet();
  const matchingStylesheetRule = (link) => config.enabled && link.relList.contains("stylesheet")
    ? firstMatch(config.rules, new URL(link.href, location.href).href, "GET") : null;
  const applyStylesheetRule = (link) => {
    if (handledLinks.has(link) || !link.href || link.href.startsWith("data:")) return;
    const rule = matchingStylesheetRule(link);
    if (!rule) return;
    handledLinks.add(link);
    const targetUrl = (rule.request?.url ? String(rule.request.url).trim() : "") || link.href;
    const response = rule.responses?.[0] || rule.response;
    if (response?.enabled) {
      const css = response.body ?? "";
      const style = document.createElement("style");
      style.setAttribute("data-local-api-mock", "true");
      style.textContent = css;
      link.replaceWith(style);
    } else if (targetUrl !== link.href) {
      link.href = targetUrl;
    }
  };
  const inspectStylesheets = (root = document) => root.querySelectorAll("link[rel~='stylesheet']").forEach(applyStylesheetRule);

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "local-api-mock") return;
    if (event.data.type === "get-config") sendConfig();
    if (event.data.type === "recording-capture") {
      chrome.runtime.sendMessage({ type: "recording-capture", flowId: event.data.flowId, record: event.data.record }, () => {
        if (chrome.runtime.lastError) console.warn("[FlowRecord] Capture could not be saved:", chrome.runtime.lastError.message);
      });
    }
  });
  const observer = new MutationObserver((mutations) => mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.matches("link[rel~='stylesheet']")) applyStylesheetRule(node);
      inspectStylesheets(node);
    }
  })));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && ['enabled', 'rules', 'flows', 'activeFlowId', 'recording'].some(key => key in changes)) sendConfig();
  });
  sendConfig();
})();

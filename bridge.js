(() => {
  const { firstMatch, normalizeHosts } = window.ApiMockRules;
  let watchedHosts = new Set();
  const pageIsWatched = () => {
    try { const url = new URL(location.href); return ['http:', 'https:'].includes(url.protocol) && watchedHosts.has(url.host); } catch { return false; }
  };
  const sendConfig = () => {
    chrome.storage.local.get({ enabled: false, watchedHosts: [], rules: [], flows: [], activeFlowId: null, recording: null }, (saved) => {
      config = saved;
      watchedHosts = new Set(normalizeHosts(saved.watchedHosts));
      window.postMessage({ source: "local-api-mock", type: "config", config: saved }, "*");
      observer.disconnect();
      if (config.enabled && pageIsWatched()) {
        inspectStylesheets();
        observer.observe(document, { childList: true, subtree: true });
      }
    });
  };

  let config = { enabled: false, rules: [] };
  const handledLinks = new WeakSet();
  const matchingStylesheetRule = (link) => config.enabled && pageIsWatched() && link.relList.contains("stylesheet")
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
      if (!pageIsWatched()) return;
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
    if (area === 'local' && ['enabled', 'watchedHosts', 'rules', 'flows', 'activeFlowId', 'recording'].some(key => key in changes)) sendConfig();
  });
  sendConfig();
})();

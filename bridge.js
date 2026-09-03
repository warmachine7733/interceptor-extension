(() => {
  const { firstMatch } = globalThis.ApiMockRules;
  const sendConfig = () => {
    chrome.storage.local.get({ enabled: true, rules: [] }, (config) => {
      window.postMessage({ source: "local-api-mock", type: "config", config }, "*");
    });
  };

  let config = { enabled: true, rules: [] };
  const handledLinks = new WeakSet();
  const matchingStylesheetRule = (link) => config.enabled && link.relList.contains("stylesheet")
    ? firstMatch(config.rules, new URL(link.href, location.href).href, "GET") : null;
  const applyStylesheetRule = (link) => {
    if (handledLinks.has(link) || !link.href || link.href.startsWith("data:")) return;
    const rule = matchingStylesheetRule(link);
    if (!rule) return;
    handledLinks.add(link);
    const targetUrl = rule.request?.url || link.href;
    if (rule.response?.enabled) {
      const css = rule.response.body ?? "";
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
    if (event.data.type === "config") {
      config = event.data.config;
      inspectStylesheets();
    }
  });
  chrome.storage.onChanged.addListener(sendConfig);
  sendConfig();
  new MutationObserver((mutations) => mutations.forEach((mutation) => mutation.addedNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.matches("link[rel~='stylesheet']")) applyStylesheetRule(node);
      inspectStylesheets(node);
    }
  }))).observe(document.documentElement, { childList: true, subtree: true });
})();

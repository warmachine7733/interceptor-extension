(() => {
  if (window.__LOCAL_API_MOCK_INSTALLED__) return;
  window.__LOCAL_API_MOCK_INSTALLED__ = true;

  let config = { enabled: false, rules: [] };
  const rules = window.ApiMockRules || (() => {
    const normalizeMethod = (method) => (method || "*").toUpperCase();
    const normalizeUrl = (url) => String(url).replace(/%2C/gi, ",");
    const patternToRegex = (pattern) => new RegExp(`^${normalizeUrl(pattern || "*")
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    const firstMatch = (rules, url, method) => (rules || []).find((rule) => {
      if (!rule?.enabled || !patternToRegex(rule.match?.urlPattern).test(normalizeUrl(url))) return false;
      const expectedMethod = normalizeMethod(rule.match?.method);
      return expectedMethod === "*" || expectedMethod === normalizeMethod(method);
    }) || null;
    const parseHeaders = (headers) => {
      if (!headers) return {};
      if (typeof headers === "object") return headers;
      try { return JSON.parse(headers); } catch { return {}; }
    };
    return { firstMatch, parseHeaders };
  })();
  const { firstMatch, parseHeaders } = rules;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));

  window.addEventListener("message", (event) => {
    if (event.source === window && event.data?.source === "local-api-mock" && event.data?.type === "config") config = event.data.config;
  });
  window.postMessage({ source: "local-api-mock", type: "get-config" }, "*");

  const matchingRule = (url, method) => config.enabled ? firstMatch(config.rules, url, method) : null;
  const log = (method, url, rule) => {
    if (rule) {
      const logRule = { ...rule, response: rule.response ? { ...rule.response } : rule.response };
      try {
        if (typeof logRule.response?.body === "string") logRule.response.body = JSON.parse(logRule.response.body);
      } catch { /* Keep non-JSON response bodies as strings. */ }
      console.log(
        `%c[API Mock]%c ${rule.response?.enabled ? "mocked" : "rewriting"} %c${method}%c ${url}`,
        "color:#22c55e;font-weight:bold", "color:inherit", "background:#334155;color:#fff;padding:0 4px;border-radius:3px", "color:inherit",
        logRule
      );
    }
  };
  const toastState = { container: null, lastShown: new Map() };
  const showRuleToast = (rule, url, method) => {
    try {
      if (typeof document === "undefined" || !document.documentElement) return;
      const key = `${rule?.id || ""}|${method}|${url}`;
      const now = Date.now();
      if (now - (toastState.lastShown.get(key) || 0) < 3000) return;
      toastState.lastShown.set(key, now);
      if (!toastState.container?.isConnected) {
        toastState.container = document.createElement("div");
        toastState.container.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;pointer-events:none;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;";
        (document.body || document.documentElement).appendChild(toastState.container);
      }
      const toast = document.createElement("div");
      toast.style.cssText = "pointer-events:auto;cursor:pointer;background:#1e293b;color:#f8fafc;padding:10px 14px 6px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.35);font-size:13px;line-height:1.4;max-width:360px;border-left:3px solid #22c55e;opacity:0;transform:translateY(-8px);transition:opacity .2s ease,transform .2s ease;overflow:hidden;";
      const title = document.createElement("div");
      title.style.cssText = "font-weight:600;";
      title.textContent = `⚡ ${rule?.response?.enabled ? "Mocked" : "Intercepted"}: ${rule?.name || "Unnamed rule"}`;
      const detail = document.createElement("div");
      detail.style.cssText = "opacity:.7;font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      detail.textContent = `${method} ${url}`;
      const DURATION = 4000;
      const bar = document.createElement("div");
      bar.style.cssText = `height:3px;border-radius:2px;background:#22c55e;margin-top:8px;width:100%;transition:width ${DURATION}ms linear;`;
      toast.append(title, detail, bar);
      const dismiss = () => { toast.style.opacity = "0"; toast.style.transform = "translateY(-8px)"; setTimeout(() => toast.remove(), 250); };
      toast.addEventListener("click", dismiss);
      toastState.container.appendChild(toast);
      setTimeout(() => { toast.style.opacity = "1"; toast.style.transform = "translateY(0)"; bar.style.width = "0%"; }, 30);
      setTimeout(dismiss, DURATION);
    } catch { /* best-effort UI notification */ }
  };
  const applyRequestOverride = async (request, override = {}) => {
    const headers = new Headers(request.headers);
    for (const [key, value] of Object.entries(parseHeaders(override.headers))) {
      if (value === null || value === "") headers.delete(key); else headers.set(key, String(value));
    }
    const method = (override.method || request.method).toUpperCase();
    const init = { method, headers, credentials: request.credentials, cache: request.cache, redirect: request.redirect, referrer: request.referrer, referrerPolicy: request.referrerPolicy, mode: request.mode, integrity: request.integrity };
    if (!/^(GET|HEAD)$/.test(method)) init.body = override.body !== undefined ? override.body : await request.clone().text();
    return new Request(override.url || request.url, init);
  };
  const mockResponse = async (response) => {
    await sleep(response.delayMs);
    const headers = new Headers(parseHeaders(response.headers));
    if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
    const status = Number(response.status) || 200;
    return new Response([204, 205, 304].includes(status) ? null : (response.body ?? ""), { status, statusText: response.statusText || "", headers });
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const original = input instanceof Request ? input : new Request(input, init);
    const rule = matchingRule(original.url, original.method);
    log(original.method, original.url, rule);
    if (!rule) return nativeFetch(input, init);
    showRuleToast(rule, original.url, original.method);
    const request = await applyRequestOverride(original, rule.request);
    if (rule.response?.enabled) return mockResponse(rule.response);
    return nativeFetch(request);
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const meta = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const absoluteUrl = new URL(url, location.href).href;
    const rule = matchingRule(absoluteUrl, method);
    const override = rule?.request || {};
    meta.set(this, { rule, method: (override.method || method).toUpperCase(), url: override.url || absoluteUrl, override });
    return nativeOpen.call(this, override.method || method, override.url || url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const details = meta.get(this);
    const overrides = parseHeaders(details?.override?.headers);
    const overrideKey = Object.keys(overrides).find((key) => key.toLowerCase() === name.toLowerCase());
    if (overrideKey && (overrides[overrideKey] === null || overrides[overrideKey] === "")) return;
    if (details && overrideKey) {
      details.overriddenHeaders = details.overriddenHeaders || new Set();
      details.overriddenHeaders.add(overrideKey.toLowerCase());
      return nativeSetRequestHeader.call(this, overrideKey, String(overrides[overrideKey]));
    }
    return nativeSetRequestHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const details = meta.get(this);
    if (details) log(details.method, details.url, details.rule || null);
    if (!details?.rule) return nativeSend.call(this, body);
    showRuleToast(details.rule, details.url, details.method);
    for (const [name, value] of Object.entries(parseHeaders(details.override.headers))) {
      if (value !== null && value !== "" && !details.overriddenHeaders?.has(name.toLowerCase())) nativeSetRequestHeader.call(this, name, String(value));
    }
    if (details.rule.response?.enabled) {
      const response = details.rule.response;
      const status = Number(response.status) || 200;
      const text = response.body ?? "";
      const headers = parseHeaders(response.headers);
      const normalizedHeaders = {};
      for (const [key, value] of Object.entries(headers)) {
        normalizedHeaders[key.toLowerCase()] = value;
      }
      Object.defineProperties(this, {
        readyState: { configurable: true, get: () => 4 }, status: { configurable: true, get: () => status },
        statusText: { configurable: true, get: () => response.statusText || "" }, responseText: { configurable: true, get: () => text },
        response: { configurable: true, get: () => {
          if (this.responseType !== "json") return text;
          try { return JSON.parse(text || "null"); } catch { return null; }
        } },
        getResponseHeader: { configurable: true, value: (name) => normalizedHeaders[name.toLowerCase()] || null },
        getAllResponseHeaders: { configurable: true, value: () => {
          const lines = Object.entries(normalizedHeaders).map(([k, v]) => `${k}: ${v}`);
          return lines.length > 0 ? lines.join("\r\n") + "\r\n" : "";
        } }
      });
      const delayMs = Number(response.delayMs) || 0;
      setTimeout(() => {
        this.dispatchEvent(new Event("readystatechange")); this.dispatchEvent(new Event("load")); this.dispatchEvent(new Event("loadend"));
      }, delayMs);
      return;
    }
    return nativeSend.call(this, details.override.body !== undefined ? details.override.body : body);
  };
})();

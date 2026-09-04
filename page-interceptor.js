(() => {
  if (window.__LOCAL_API_MOCK_INSTALLED__) return;
  window.__LOCAL_API_MOCK_INSTALLED__ = true;

  let config = { enabled: true, rules: [] };
  const { firstMatch, parseHeaders } = window.ApiMockRules;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));

  window.addEventListener("message", (event) => {
    if (event.source === window && event.data?.source === "local-api-mock" && event.data?.type === "config") config = event.data.config;
  });
  window.postMessage({ source: "local-api-mock", type: "get-config" }, "*");

  const matchingRule = (url, method) => config.enabled ? firstMatch(config.rules, url, method) : null;
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
    if (!rule) return nativeFetch(input, init);
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
    if (!details?.rule) return nativeSend.call(this, body);
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

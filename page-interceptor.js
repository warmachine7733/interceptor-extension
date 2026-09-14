(() => {
  if (window.__LOCAL_API_MOCK_INSTALLED__) return;
  window.__LOCAL_API_MOCK_INSTALLED__ = true;

  let config = { enabled: false, rules: [], flows: [], activeFlowId: null, recording: null };
  // rules.js is always loaded before this script (see manifest.json content_scripts
  // ordering, both worlds), so ApiMockRules is the single canonical matcher implementation.
  const { firstMatch, firstFlowMatch, flowStepMatches, parseHeaders, resetFlowReplayState, scopeMatches, normalizeHosts } = window.ApiMockRules;
  let watchedHosts = new Set();
  const pageIsWatched = () => {
    try { return watchedHosts.has(new URL(location.href).host); } catch { return false; }
  };
  const requestUrl = value => {
    try {
      const url = new URL(value, location.href);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));

  const shouldIgnoreRecordingUrl = (url) => {
    if (!url || typeof url !== "string") return true;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:", "file:"].includes(parsed.protocol)) return true;
      if (/\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|ogg|pdf|zip|gz)(?:[?#]|$)/i.test(parsed.pathname)) return true;
      if (/\/\.(?:well-known|git|svn)|(?:^|\/)(?:favicon\.ico)$/.test(parsed.pathname)) return true;
      if (parsed.hostname === "localhost" && /\/ws\//i.test(parsed.pathname)) return true;
    } catch { return true; }
    return false;
  };

  const sanitizeHeaders = (headers) => {
    const result = {};
    const source = parseHeaders(headers);
    for (const [key, value] of Object.entries(source || {})) {
      const normalizedKey = String(key).toLowerCase();
      if (["authorization", "cookie", "set-cookie"].includes(normalizedKey)) continue;
      if (value === undefined || value === null) continue;
      result[key] = String(value);
    }
    return result;
  };

  const localLimit = (value, maxLength = 200000) => {
    if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
    if (value === undefined || value === null) return value;
    try {
      const stringValue = JSON.stringify(value);
      return stringValue.length > maxLength ? `${stringValue.slice(0, maxLength)}…` : stringValue;
    } catch {
      return String(value).slice(0, maxLength);
    }
  };

  // Controls ONLY whether a request is added to an in-progress recording - it has no
  // effect on manual mock matching or Flow replay. Missing monitorScope (older recording
  // sessions) behaves as "global" (unrestricted), same as before this feature existed.
  const shouldCaptureForRecording = (currentPage, recording) => {
    if (!recording?.active) return false;
    return scopeMatches(recording.monitorScope, currentPage);
  };

  const storageRecord = (record) => {
    if (!config.recording?.active || !record || !pageIsWatched()) return;
    const allowed = shouldCaptureForRecording(record.pageContext || null, config.recording);
    if (!allowed) return;
    window.postMessage({ source: "local-api-mock", type: "recording-capture", flowId: config.recording.flowId, record }, "*");
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "local-api-mock" || event.data?.type !== "config") return;
    const nextConfig = event.data.config || {};
    const previousFlowsById = new Map((config.flows || []).map((flow) => [flow.id, flow]));
    const nextFlows = Array.isArray(nextConfig.flows) ? nextConfig.flows : [];
    // A flow's replay progress must restart whenever its enabled state flips (covers
    // "active flow changed", "flow disabled", and "flow re-enabled") or when it's
    // deleted - otherwise a fresh replay run could silently resume from stale steps.
    for (const flow of nextFlows) {
      const previous = previousFlowsById.get(flow.id);
      if (!previous || Boolean(previous.enabled) !== Boolean(flow.enabled)) resetFlowReplayState(flow.id);
    }
    for (const id of previousFlowsById.keys()) {
      if (!nextFlows.some((flow) => flow.id === id)) resetFlowReplayState(id);
    }
    config = { ...config, ...nextConfig };
    watchedHosts = new Set(normalizeHosts(config.watchedHosts));
  });
  window.postMessage({ source: "local-api-mock", type: "get-config" }, "*");

  const flowMatch = (url, method, body, pageContext) => {
    if (!config.enabled) return null;
    const flow = firstFlowMatch(config.flows, url, method, body, pageContext);
    if (!flow) return null;
    const response = flow.response || {};
    return {
      id: flow.id,
      name: flow.flowName || "Flow",
      source: "flow",
      flowId: flow.flowId,
      match: { method: flow.matcher?.method || method, urlPattern: flow.matcher?.urlPattern || url },
      request: flow.request || {},
      response: { ...response, enabled: true },
      responses: [{ ...response, enabled: true }],
      defaultResponseIndex: 0,
      enabled: true
    };
  };
  // The current app route (not the API request URL) - read fresh on every call so SPA
  // navigation (history.pushState/replaceState/popstate) is always reflected without
  // needing dedicated navigation listeners. Used for Flow replay's optional per-step page
  // guard and for the Record Flow capture filter - never for manual mock matching.
  const currentPageContext = () => ({ origin: location.origin, pathname: location.pathname });
  const matchingRule = (url, method, body) => {
    if (!config.enabled) return null;
    const rule = firstMatch(config.rules, url, method);
    if (rule) return rule;
    return flowMatch(url, method, body, currentPageContext());
  };
  const responseForRule = (rule) => rule?.responses?.[Math.min(Math.max(Number(rule.defaultResponseIndex) || 0, 0), rule.responses.length - 1)] || rule?.response;
  const log = (method, url, rule) => {
    if (!rule) return;
    const response = responseForRule(rule);
    const logRule = { ...rule, response: response ? { ...response } : response, source: rule.source || "manual" };
    try {
      if (typeof logRule.response?.body === "string") logRule.response.body = JSON.parse(logRule.response.body);
    } catch { /* Keep non-JSON response bodies as strings. */ }
    console.log(
      `%c[API Mock]%c ${rule.source === "flow" ? "flow replay" : response?.enabled ? "mocked" : "rewriting"} %c${method}%c ${url}`,
      "color:#22c55e;font-weight:bold", "color:inherit", "background:#334155;color:#fff;padding:0 4px;border-radius:3px", "color:inherit",
      logRule
    );
  };
  const toastState = { container: null, lastShown: new Map() };
  const showRuleToast = (rule, url, method) => {
    try {
      if (typeof document === "undefined" || !document.documentElement) return;
      const key = `${rule?.id || rule?.flowId || ""}|${method}|${url}`;
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
      title.textContent = rule?.source === "flow" ? `⚡ Flow: ${rule.name || "Unnamed flow"}` : `⚡ ${rule?.response?.enabled ? "Mocked" : "Intercepted"}: ${rule?.name || "Unnamed rule"}`;
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
    const overrideMethod = override.method ? String(override.method).trim().toUpperCase() : "";
    const method = overrideMethod || request.method.toUpperCase();
    const init = { method, headers, credentials: request.credentials, cache: request.cache, redirect: request.redirect, referrer: request.referrer, referrerPolicy: request.referrerPolicy, mode: request.mode, integrity: request.integrity };
    if (!/^(GET|HEAD)$/.test(method)) init.body = override.body !== undefined ? override.body : await request.clone().text();
    const overrideUrl = override.url ? String(override.url).trim() : "";
    return new Request(overrideUrl || request.url, init);
  };
  const mockResponse = async (response) => {
    await sleep(response.delayMs);
    const headers = new Headers(parseHeaders(response.headers));
    if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
    const status = Number(response.status) || 200;
    return new Response([204, 205, 304].includes(status) ? null : (response.body ?? ""), { status, statusText: response.statusText || "", headers });
  };

  const captureFetchRecord = async (request, response) => {
    if (!config.recording?.active || !request || !response || shouldIgnoreRecordingUrl(request.url)) return;
    const contentType = (response.headers && response.headers.get ? response.headers.get("content-type") : "") || "";
    if (/\b(?:image|audio|video|font|octet-stream)\b/i.test(contentType) || /\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|mp4|webm|mp3|wav|ogg)/i.test(request.url)) return;
    const responseBody = await response.clone().text().catch(() => "");
    const record = {
      id: crypto.randomUUID(),
      include: true,
      method: request.method,
      url: request.url,
      pathname: new URL(request.url).pathname,
      headers: sanitizeHeaders(request.headers),
      body: localLimit(await request.clone().text().catch(() => undefined), 160000),
      timestamp: Date.now(),
      status: response.status,
      responseHeaders: sanitizeHeaders(response.headers),
      responseBody: localLimit(responseBody, 160000),
      contentType,
      delay: 0,
      source: "recording"
    };
    storageRecord(record);
  };

  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const [input, init] = args;
    const pass = () => Reflect.apply(nativeFetch, this, args);
    if ((!config.enabled && !config.recording?.active) || !pageIsWatched()) return pass();
    // Do not coerce arbitrary objects twice or construct a Request for unlisted hosts.
    const rawUrl = typeof input === 'string' || input instanceof URL ? input : input instanceof Request ? input.url : null;
    const url = rawUrl === null ? null : requestUrl(rawUrl);
    if (!url) return pass();
    const captureEnabled = shouldCaptureForRecording(currentPageContext(), config.recording);
    if (!config.enabled && !captureEnabled) return pass();
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const manual = config.enabled ? firstMatch(config.rules, url, method) : null;
    const candidates = config.enabled && !manual && (config.flows || []).some(flow => flow.enabled && (flow.steps || []).some(step =>
      flowStepMatches({ ...step, matcher: { ...step.matcher, matchBody: false } }, url, method, undefined, currentPageContext())));
    const capture = captureEnabled && !shouldIgnoreRecordingUrl(url);
    if (!manual && !candidates && !capture) return pass();
    return interceptFetch(input, init, url, manual, capture, pass);
  };
  const interceptFetch = async (input, init, url, manual, captureEnabled, pass) => {
    const original = new Request(input instanceof Request ? input : url, init);
    const bodyForMatch = /^(GET|HEAD)$/.test(original.method) ? undefined : await original.clone().text().catch(() => undefined);
    const rule = manual || matchingRule(original.url, original.method, bodyForMatch);
    const performFetch = async () => {
      log(original.method, original.url, rule);
      if (!rule) return pass();
      showRuleToast(rule, original.url, original.method);
      const request = await applyRequestOverride(original, rule.request);
      const response = responseForRule(rule);
      if (response?.enabled) return mockResponse(response);
      return nativeFetch.call(window, request);
    };
    if (captureEnabled && !shouldIgnoreRecordingUrl(original.url)) {
      const requestRecord = {
        id: crypto.randomUUID(),
        method: original.method,
        url: original.url,
        pathname: new URL(original.url).pathname,
        headers: sanitizeHeaders(original.headers),
        body: localLimit(bodyForMatch, 160000),
        timestamp: Date.now(),
        include: true,
        source: "recording",
        pageContext: currentPageContext()
      };
      const response = await performFetch();
      const contentType = response.headers?.get ? response.headers.get("content-type") : "";
      const responseBody = await response.clone().text().catch(() => "");
      const finalRecord = {
        ...requestRecord,
        status: response.status,
        responseHeaders: sanitizeHeaders(response.headers),
        responseBody: localLimit(responseBody, 160000),
        contentType,
        delay: 0
      };
      storageRecord(finalRecord);
      return response;
    }
    return performFetch();
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const meta = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (meta.get(this)?.mocked) {
      for (const key of ['readyState', 'status', 'statusText', 'responseText', 'response', 'getResponseHeader', 'getAllResponseHeaders']) delete this[key];
    }
    meta.delete(this);
    if ((!config.enabled && !config.recording?.active) || !pageIsWatched()) return nativeOpen.apply(this, arguments);
    const absoluteUrl = (typeof url === 'string' || url instanceof URL) ? requestUrl(url) : null;
    if (!absoluteUrl) return nativeOpen.apply(this, arguments);
    if (!config.enabled && !shouldCaptureForRecording(currentPageContext(), config.recording)) return nativeOpen.apply(this, arguments);
    // Only manual rules can rewrite the request at open() time - they never depend on
    // the body. Flow matching (which can depend on the body via matchBody, and must
    // advance replay counters exactly once) is deferred to send(), once body is known.
    const manualRule = config.enabled ? firstMatch(config.rules, absoluteUrl, method) : null;
    const override = manualRule?.request || {};
    const overrideUrl = override.url ? String(override.url).trim() : "";
    const overrideMethod = override.method ? String(override.method).trim().toUpperCase() : "";
    const finalMethod = overrideMethod || method.toUpperCase();
    meta.set(this, { manualRule, method: finalMethod, url: overrideUrl || absoluteUrl, override });
    if (!manualRule) return nativeOpen.apply(this, arguments);
    return nativeOpen.call(this, finalMethod, overrideUrl || url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    const details = meta.get(this);
    if (!details || !config.enabled || !pageIsWatched()) return nativeSetRequestHeader.apply(this, arguments);
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
    if (!details || !pageIsWatched() || (!config.enabled && !shouldCaptureForRecording(currentPageContext(), config.recording))) return nativeSend.apply(this, arguments);
    if (shouldCaptureForRecording(currentPageContext(), config.recording) && !shouldIgnoreRecordingUrl(details?.url || "")) {
      const record = {
        id: crypto.randomUUID(),
        include: true,
        method: details?.method || "GET",
        url: details?.url || location.href,
        pathname: new URL(details?.url || location.href).pathname,
        headers: sanitizeHeaders({}),
        body: localLimit(typeof body === "string" ? body : "", 160000),
        timestamp: Date.now(),
        source: "recording",
        pageContext: currentPageContext()
      };
      let captured = false;
      const capture = () => {
        if (captured) return;
        captured = true;
        const contentType = this.getResponseHeader ? this.getResponseHeader("content-type") || "" : "";
        // Native XHR throws when responseText is read for JSON/blob/arraybuffer responses.
        const responseText = !this.responseType || this.responseType === "text"
          ? this.responseText : this.responseType === "json" ? JSON.stringify(this.response) : "";
        storageRecord({ ...record, status: Number(this.status) || 0, responseHeaders: sanitizeHeaders(this.getAllResponseHeaders ? this.getAllResponseHeaders() : {}), responseBody: localLimit(responseText, 160000), contentType, delay: 0 });
      };
      this.addEventListener("loadend", capture);
      this.addEventListener("error", capture);
    }
    // Resolve the final rule here (not in open()) so body-dependent flow matching -
    // and its once-per-request replay counter increment - happens exactly once, using
    // the real outgoing body instead of whatever was known at open() time.
    const bodyForMatch = typeof body === "string" ? body : undefined;
    const rule = config.enabled ? details.manualRule || matchingRule(details.url, details.method, bodyForMatch) : null;
    if (details) log(details.method, details.url, rule || null);
    if (!rule) return nativeSend.call(this, body);
    showRuleToast(rule, details.url, details.method);
    for (const [name, value] of Object.entries(parseHeaders(rule.request?.headers))) {
      if (value !== null && value !== "" && !details.overriddenHeaders?.has(name.toLowerCase())) nativeSetRequestHeader.call(this, name, String(value));
    }
    const response = responseForRule(rule);
    if (response?.enabled) {
      details.mocked = true;
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
    return nativeSend.call(this, rule.request?.body !== undefined ? rule.request.body : body);
  };
})();

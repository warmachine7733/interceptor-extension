(() => {
  const normalizeMethod = (method) => String(method || "*").trim().toUpperCase();
  const normalizeUrl = (url) => String(url ?? "").trim().replace(/%2C/gi, ",");

  const patternToRegex = (pattern) => {
    const value = normalizeUrl(pattern || "*");
    const hasQuery = value.includes("?");
    const escaped = value
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, hasQuery ? ".*" : "[^?]*");
    return new RegExp(`^${escaped}$`);
  };

  const matches = (rule, url, method) => {
    if (!rule?.enabled) return false;
    const pattern = String(rule.match?.urlPattern || "*").trim();
    if (!patternToRegex(pattern).test(normalizeUrl(url))) return false;
    const expectedMethod = normalizeMethod(rule.match?.method);
    return expectedMethod === "*" || expectedMethod === normalizeMethod(method);
  };

  const firstMatch = (rules, url, method) => (rules || []).find((rule) => matches(rule, url, method)) || null;

  const parseHeaders = (headers) => {
    if (!headers) return {};
    if (typeof headers === "object") return headers;
    try { return JSON.parse(headers); } catch { return {}; }
  };

  window.ApiMockRules = { firstMatch, parseHeaders, patternToRegex };
})();

(() => {
  const normalizeMethod = (method) => (method || "*").toUpperCase();

  const patternToRegex = (pattern) => {
    const escaped = String(pattern || "*")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`);
  };

  const matches = (rule, url, method) => {
    if (!rule?.enabled) return false;
    if (!patternToRegex(rule.match?.urlPattern).test(url)) return false;
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

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

  // Used only by the Record Flow capture filter (page-interceptor.js) to decide whether
  // a request should be added to an in-progress recording. Manual mocks and Flow replay
  // matching never call this - My Mocks stay fully independent of page/site context.
  const scopeMatches = (scope, pageContext) => {
    const type = scope?.type || "global";
    if (type === "global" || !scope) return true;
    if (!pageContext?.origin) return false;
    if (scope.origin !== pageContext.origin) return false;
    if (type === "page") return String(scope.pathname || "") === String(pageContext.pathname || "");
    return true; // type === "site": origin already matched above
  };

  const matches = (rule, url, method) => {
    if (!rule?.enabled) return false;
    const pattern = String(rule.match?.urlPattern || "*").trim();
    if (!patternToRegex(pattern).test(normalizeUrl(url))) return false;
    const expectedMethod = normalizeMethod(rule.match?.method);
    return expectedMethod === "*" || expectedMethod === normalizeMethod(method);
  };

  const firstMatch = (rules, url, method) => (rules || []).find((rule) => matches(rule, url, method)) || null;

  const stripQuery = (value) => String(value ?? "").split("?")[0];

  const normalizeBodyForCompare = (value) => {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string") {
      try { return JSON.stringify(value); } catch { return String(value); }
    }
    try { return JSON.stringify(JSON.parse(value)); } catch { return value.trim(); }
  };

  const stepBodyMatches = (step, body) => {
    if (!step?.matcher?.matchBody) return true;
    return normalizeBodyForCompare(step?.request?.body) === normalizeBodyForCompare(body);
  };

  const flowStepMatches = (step, url, method, body, pageContext) => {
    if (!step || step.enabled === false) return false;
    const pattern = String(step?.matcher?.urlPattern || "*").trim();
    const matchQuery = Boolean(step?.matcher?.matchQuery);
    const compareUrl = matchQuery ? normalizeUrl(url) : stripQuery(normalizeUrl(url));
    const comparePattern = matchQuery ? pattern : stripQuery(pattern);
    if (!patternToRegex(comparePattern).test(compareUrl)) return false;
    const expectedMethod = normalizeMethod(step?.matcher?.method);
    if (expectedMethod !== "*" && expectedMethod !== normalizeMethod(method)) return false;
    if (step.pageContext && !scopeMatches({ type: "page", origin: step.pageContext.origin, pathname: step.pageContext.pathname }, pageContext)) return false;
    return stepBodyMatches(step, body);
  };

  // Tracks how many times each (flow, request signature) pair has replayed, so repeated
  // identical calls within a single flow advance through duplicate steps sequentially
  // instead of always replaying the first recorded response.
  const flowReplayCounts = new Map();
  const resetFlowReplayState = (flowId) => {
    if (flowId) flowReplayCounts.delete(flowId);
    else flowReplayCounts.clear();
  };

  const firstFlowMatch = (flows, url, method, body, pageContext) => {
    const activeFlows = (flows || []).filter((flow) => flow?.enabled && Array.isArray(flow?.steps));
    for (const flow of activeFlows) {
      const matchingSteps = flow.steps.filter((candidate) => flowStepMatches(candidate, url, method, body, pageContext));
      if (!matchingSteps.length) continue;
      let counts = flowReplayCounts.get(flow.id);
      if (!counts) { counts = new Map(); flowReplayCounts.set(flow.id, counts); }
      const key = `${normalizeMethod(method)}::${normalizeUrl(url)}`;
      const callIndex = counts.get(key) || 0;
      counts.set(key, callIndex + 1);
      const step = matchingSteps[Math.min(callIndex, matchingSteps.length - 1)];
      return {
        ...step,
        id: step.id || `${flow.id}:${step.order || 0}`,
        flowId: flow.id,
        flowName: flow.name,
        enabled: true,
        source: "flow",
        matcher: step.matcher || { method, urlPattern: url },
        response: step.response || {}
      };
    }
    return null;
  };

  const parseHeaders = (headers) => {
    if (!headers) return {};
    if (typeof headers === "object") return headers;
    try { return JSON.parse(headers); } catch { return {}; }
  };

  window.ApiMockRules = { firstMatch, firstFlowMatch, flowStepMatches, parseHeaders, patternToRegex, resetFlowReplayState, scopeMatches };
})();

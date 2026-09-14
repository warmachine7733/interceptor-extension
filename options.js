const $ = (selector, element = document) => element.querySelector(selector);
const rulesElement = $("#rules");
let state = { enabled: false, darkMode: false, rules: [], flows: [], activeFlowId: null, recording: null, view: "mocks", lastActiveTab: null };
let selectedRuleId = null;
let activeView = "response";
let activeResponseIndex = 0;
let flowStepView = "response";
let flowDraft = null;
let flowDraftBaseline = null;
let flowDraftError = "";
let flowSaving = false;
const cloneFlow = (flow) => JSON.parse(JSON.stringify(flow));
const draftContent = (flow) => {
  if (!flow) return null;
  const { enabled, updatedAt, ...content } = flow;
  return JSON.stringify(content);
};
function flowDraftDirty() { return draftContent(flowDraft) !== draftContent(flowDraftBaseline); }
function getFlowDraft() {
  const saved = state.flows.find(flow => flow.id === state.flowEditorId);
  if (!saved) return null;
  if (flowDraft?.id !== saved.id) {
    flowDraft = cloneFlow(normalizeFlow(saved));
    flowDraftBaseline = cloneFlow(flowDraft);
    flowDraftError = "";
  }
  return flowDraft;
}
function leaveFlowDraft(nextId = null) {
  if (flowDraft?.id === nextId) return true;
  if (flowSaving) return false;
  if (flowDraftDirty() && !window.confirm("Discard unsaved changes?")) return false;
  flowDraft = flowDraftBaseline = null;
  flowDraftError = "";
  return true;
}
function updateFlowDraftStatus() {
  const dirty = flowDraftDirty();
  const indicator = $("#flow-unsaved");
  if (indicator) indicator.hidden = !dirty;
  const save = $("#save-flow");
  if (save) save.disabled = !dirty || flowSaving;
  const reset = $("#reset-flow");
  if (reset) reset.disabled = !dirty || flowSaving;
  const error = $("#flow-draft-error");
  if (error) error.textContent = flowDraftError;
}
function editFlowField(field, value) {
  const draft = getFlowDraft();
  const step = draft?.steps[state.flowSelectedStepIndex || 0];
  if (!step || flowSaving) return;
  switch (field) {
    case "method": step.matcher.method = step.request.method = value; break;
    case "urlPattern": step.matcher.urlPattern = step.request.url = value; break;
    case "requestHeaders": step.request.headers = value; break;
    case "requestBody": step.request.body = value; break;
    case "status": step.response.status = value.trim() && Number.isFinite(Number(value)) ? Number(value) : value; break;
    case "delay": step.delay = value.trim() && Number.isFinite(Number(value)) ? Number(value) : value; break;
    case "responseHeaders": step.response.headers = value; break;
    case "responseBody": step.response.body = value; break;
    default: return;
  }
  flowDraftError = "";
  updateFlowDraftStatus();
}
function resetFlowDraft() {
  if (flowSaving || !leaveFlowDraft()) return;
  getFlowDraft();
  render();
}
function saveFlowDraft() {
  if (!flowDraft || !flowDraftDirty() || flowSaving) return;
  let draft;
  try {
    draft = cloneFlow(flowDraft);
    if (!draft.name.trim()) throw new Error("Enter a flow name.");
    draft.steps.forEach((step, index) => {
      const label = `Step ${index + 1}`;
      step.matcher.method = String(step.matcher.method).trim().toUpperCase();
      if (!/^(?:\*|[A-Z]+)$/.test(step.matcher.method)) throw new Error(`${label}: enter a valid method.`);
      step.matcher.urlPattern = String(step.matcher.urlPattern).trim();
      if (!step.matcher.urlPattern) throw new Error(`${label}: enter a URL pattern.`);
      step.request.method = step.matcher.method;
      step.request.url = step.matcher.urlPattern;
      try { step.request.pathname = new URL(step.request.url).pathname; } catch { step.request.pathname = ""; }
      for (const part of ["request", "response"]) {
        let headers = step[part].headers;
        if (typeof headers === "string") {
          try { headers = JSON.parse(headers); } catch { throw new Error(`${label}: ${part} headers must be a JSON object.`); }
        }
        if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error(`${label}: ${part} headers must be a JSON object.`);
        step[part].headers = headers;
      }
      step.response.status = Number(step.response.status);
      if (!Number.isInteger(step.response.status) || step.response.status < 100 || step.response.status > 599) throw new Error(`${label}: status must be between 100 and 599.`);
      step.delay = Number(step.delay);
      if (!Number.isFinite(step.delay) || step.delay < 0) throw new Error(`${label}: delay must be zero or greater.`);
      step.order = index;
    });
  } catch (error) {
    flowDraftError = error.message;
    updateFlowDraftStatus();
    return;
  }
  flowSaving = true;
  updateFlowDraftStatus();
  chrome.storage.local.get({ flows: [] }, (saved) => {
    const fail = (message) => { flowSaving = false; flowDraftError = message; updateFlowDraftStatus(); };
    if (chrome.runtime.lastError) { fail(chrome.runtime.lastError.message); return; }
    const current = saved.flows.find(flow => flow.id === draft.id);
    if (!current) { fail("This flow no longer exists. Your changes have not been saved."); return; }
    // Activation remains immediate and is never committed from the editor draft.
    const committed = { ...draft, enabled: current.enabled, updatedAt: Date.now() };
    const flows = saved.flows.map(flow => flow.id === draft.id ? committed : flow);
    chrome.storage.local.set({ flows }, () => {
      if (chrome.runtime.lastError) { fail(chrome.runtime.lastError.message); return; }
      state.flows = flows;
      flowDraft = cloneFlow(committed);
      flowDraftBaseline = cloneFlow(committed);
      flowSaving = false;
      flowDraftError = "";
      render();
    });
  });
}
const { nameFromUrl, makeRule, esc, methodClass, pathPreview, writePath, parsePastedJson, formatJson, normalizeRule, normalizeScope } = window.ApiMockOptionsUtils;

$("#version-name").textContent = `v${chrome.runtime.getManifest().version}`;
function cleanRule(rule) { const copy = JSON.parse(JSON.stringify(rule)); delete copy._isNew; delete copy.response; return copy; }
function persist(callback) { chrome.storage.local.set({ enabled: state.enabled, darkMode: state.darkMode, rules: state.rules.filter((rule) => !rule._isNew).map(cleanRule), flows: state.flows, activeFlowId: state.activeFlowId, recording: state.recording, view: state.view }, callback); }
function applyTheme() {
  document.body.classList.toggle("dark-mode", state.darkMode);
  $("#dark-mode").checked = state.darkMode;
}

// Distinct app origins previously seen across recorded Flow steps - used only for the
// Flows-list site filter, never for My Mocks (which stay fully independent of page/site).
function observedOrigins() {
  const origins = new Set();
  for (const flow of state.flows) {
    for (const step of flow.steps || []) {
      if (step?.pageContext?.origin) origins.add(step.pageContext.origin);
    }
  }
  return [...origins];
}

// Lightweight hash routing: #/mocks (default/home), #/flows, #/flows/:flowId.
// The hash is the source of truth for navigation (back/forward, refresh, deep links);
// `state.view`/`state.flowEditorId` stay in sync with it but are not part of the
// persisted schema themselves - only the derived `state.view` field is (as before).
function routeHashForState() {
  if (state.view === "flows" && state.flowEditorId) return `#/flows/${encodeURIComponent(state.flowEditorId)}`;
  if (state.view === "flows") return "#/flows";
  return "#/mocks";
}
function syncHashWithState() {
  const target = routeHashForState();
  if (location.hash !== target) location.hash = target;
}
function applyRouteFromHash() {
  const segments = String(location.hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
  const nextId = segments[0] === "flows" && segments[1] && state.flows.some(flow => flow.id === decodeURIComponent(segments[1])) ? decodeURIComponent(segments[1]) : null;
  if (!leaveFlowDraft(nextId)) { syncHashWithState(); return; }
  if (segments[0] === "flows") {
    state.view = "flows";
    const requestedId = segments[1] ? decodeURIComponent(segments[1]) : null;
    const exists = requestedId && state.flows.some((flow) => flow.id === requestedId);
    state.flowEditorId = exists ? requestedId : null;
    state.flowSelectedStepIndex = 0;
    if (requestedId && !exists) syncHashWithState(); // deleted/invalid flow id - fall back to the flow list safely
  } else {
    state.view = "mocks";
    state.flowEditorId = null;
  }
}
function exportMocks() {
  const rules = state.rules.filter((rule) => rule.enabled);
  if (!rules.length) { alert("Select at least one mock to export."); return; }
  const payload = { version: 1, enabled: state.enabled, rules: rules.map(cleanRule) };
  const exportName = rules.length === 1
    ? (rules[0].name || "api-mock").replace(/[\\/:*?"<>|]+/g, "-").trim()
    : "selected-api-mocks";
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  link.download = `${exportName || "api-mock"}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}
function importMocks(file) {
  file.text().then((text) => {
    const payload = JSON.parse(text);
    if (payload?.version !== 1 || !Array.isArray(payload.rules) || payload.rules.some((rule) => !rule?.id || !rule.match?.urlPattern || !rule.match?.method || (!rule.responses && !rule.response))) throw new Error("Invalid mock export");
    const existingIds = new Set(state.rules.map((rule) => rule.id));
    const importedRules = payload.rules.map((rule) => {
      const copy = normalizeRule(rule);
      if (existingIds.has(copy.id)) copy.id = crypto.randomUUID();
      existingIds.add(copy.id);
      delete copy._isNew;
      return copy;
    });
    state.rules = [...state.rules, ...importedRules];
    selectedRuleId = state.rules[0]?.id || null;
    activeResponseIndex = 0;
    persist(() => {
      $("#enabled").checked = state.enabled;
      $("#toggle-status").textContent = state.enabled ? "Active" : "Inactive";
      render();
    });
  }).catch(() => alert("This file is not a valid mock export.")).finally(() => { $("#import-file").value = ""; });
}
const listTemplate = (rule) => `<article class="mock-item ${rule.id === selectedRuleId ? "selected" : ""}" data-id="${esc(rule.id)}"><button class="mock-select" type="button" aria-label="Open ${esc(rule.name)}"><span class="mock-topline"><input class="rule-enabled" type="checkbox" ${rule.enabled ? "checked" : ""} aria-label="Enable ${esc(rule.name)}"><span class="mock-name">${esc(rule.name)}</span><span class="mock-more" aria-hidden="true">&#8942;</span><span class="mock-trash" role="img" aria-label="Delete mock" title="Delete mock"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13m-6 4v5m4-5v5"></path></svg></span></span><span class="mock-meta"><span class="method-text ${methodClass(rule.match.method)}">${esc(rule.match.method)}</span><span>${esc(pathPreview(rule.match.urlPattern))}</span></span></button></article>`;

const editorTemplate = (rule) => `<div class="editor" data-id="${esc(rule.id)}"><div class="request-bar"><select class="editor-method" data-path="match.method" aria-label="HTTP method">${["*","GET","POST","PUT","PATCH","DELETE","HEAD"].map((method) => `<option ${rule.match.method === method ? "selected" : ""}>${method}</option>`).join("")}</select><input class="editor-url" data-path="match.urlPattern" value="${esc(rule.match.urlPattern)}" aria-label="URL pattern"><span class="dirty-badge">Unsaved changes</span><button class="publish" type="button" ${rule._isNew ? "" : "disabled"}>Publish</button></div><div class="editor-tabs" role="tablist"><button class="editor-tab ${activeView === "response" ? "active" : ""}" type="button" data-view="response" role="tab" aria-selected="${activeView === "response"}">Response</button><button class="editor-tab ${activeView === "request" ? "active" : ""}" type="button" data-view="request" role="tab" aria-selected="${activeView === "request"}">Request</button></div><div class="editor-panel ${activeView === "response" ? "active" : ""}" data-panel="response"><div class="response-meta"><label>Return mock response<input class="response-enabled" type="checkbox" ${rule.response.enabled ? "checked" : ""}></label><label>Status<input data-path="response.status" type="number" value="${esc(rule.response.status)}"></label><label>Delay (ms)<input data-path="response.delayMs" type="number" value="${esc(rule.response.delayMs)}"></label><label class="headers-compact">Headers<textarea data-path="response.headers">${esc(rule.response.headers)}</textarea></label></div><div class="body-heading"><span>Response body</span><button class="format-json" type="button" data-target="response.body">Format JSON</button></div><textarea class="body-editor" data-path="response.body" spellcheck="false">${esc(rule.response.body)}</textarea></div><div class="editor-panel ${activeView === "request" ? "active" : ""}" data-panel="request"><div class="fields"><label>Replacement URL<input data-path="request.url" placeholder="Leave empty to keep original" value="${esc(rule.request.url)}"></label><label>Replacement Method<input data-path="request.method" placeholder="GET, POST, etc." value="${esc(rule.request.method)}"></label></div><label>Request headers<textarea data-path="request.headers">${esc(rule.request.headers)}</textarea></label><div class="body-heading"><span>Request body</span><button class="format-json" type="button" data-target="request.body">Format JSON</button></div><textarea class="body-editor request-body" data-path="request.body" spellcheck="false" placeholder="{}">${esc(rule.request.body)}</textarea></div></div>`;

function normalizeFlow(flow) {
  const steps = Array.isArray(flow?.steps) ? flow.steps.map((step, index) => ({
    id: step?.id || crypto.randomUUID(),
    order: Number(step?.order ?? index),
    enabled: step?.enabled !== false,
    request: {
      method: step?.request?.method || step?.matcher?.method || "GET",
      url: step?.request?.url || step?.matcher?.urlPattern || "",
      pathname: step?.request?.pathname || "",
      headers: step?.request?.headers || {},
      body: step?.request?.body
    },
    response: {
      status: Number(step?.response?.status || 200),
      headers: step?.response?.headers || {},
      body: step?.response?.body,
      contentType: step?.response?.contentType || "application/json"
    },
    matcher: {
      method: step?.matcher?.method || step?.request?.method || "GET",
      urlPattern: step?.matcher?.urlPattern || step?.request?.url || "*",
      matchQuery: Boolean(step?.matcher?.matchQuery),
      matchBody: Boolean(step?.matcher?.matchBody)
    },
    // Optional: where in the app this step's request happened. Absent for legacy/manually
    // added steps, which then match purely on the API request (global), unchanged.
    pageContext: step?.pageContext?.origin ? { origin: step.pageContext.origin, pathname: step.pageContext.pathname || "" } : null,
    delay: Number(step?.delay || 0)
  })) : [];
  return {
    id: flow?.id || crypto.randomUUID(),
    name: String(flow?.name || "Unnamed Flow").trim() || "Unnamed Flow",
    enabled: Boolean(flow?.enabled),
    createdAt: Number(flow?.createdAt || Date.now()),
    updatedAt: Number(flow?.updatedAt || Date.now()),
    steps
  };
}

function setView(view) {
  if (!leaveFlowDraft()) return;
  state.flowEditorId = null;
  state.view = view;
  if (state.view !== "flows") {
    state.flowEditorId = null;
    state.flowSelectedStepIndex = 0;
  }
  document.querySelectorAll(".top-nav-item").forEach((item) => {
    item.classList.toggle("top-nav-active", item.dataset.view === view);
  });
  syncHashWithState();
  persist();
  render();
}

function createFlowFromCapture(name, captured) {
  const steps = (captured || []).filter((step) => step && step.method && step.url).map((step, index) => ({
    id: crypto.randomUUID(),
    order: index,
    enabled: true,
    request: {
      method: step.method || "GET",
      url: step.url || "",
      pathname: step.pathname || new URL(step.url || "http://example.invalid").pathname,
      headers: step.headers || {},
      body: step.body
    },
    response: {
      status: Number(step.status) || 200,
      headers: step.responseHeaders || {},
      body: step.responseBody,
      contentType: step.contentType || "application/json"
    },
    matcher: {
      method: step.method || "GET",
      urlPattern: step.url || "*",
      matchQuery: true,
      matchBody: false
    },
    // Recorded automatically per request so multi-route flows (e.g. /login -> /accounts
    // -> /collections) retain the app route each step actually happened on.
    pageContext: step.pageContext?.origin ? { origin: step.pageContext.origin, pathname: step.pageContext.pathname || "" } : null,
    delay: Number(step.delay) || 0
  }));
  const flow = normalizeFlow({
    id: crypto.randomUUID(),
    name: String(name || "Unnamed Flow").trim() || "Unnamed Flow",
    enabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps
  });
  state.flows = [flow, ...state.flows];
  state.recording = null;
  state.flowEditorId = flow.id;
  state.flowSelectedStepIndex = 0;
  syncHashWithState();
  persist();
  render();
  return flow;
}

function createBlankFlow() {
  if (!leaveFlowDraft()) return;
  const draft = normalizeFlow({ id: crypto.randomUUID(), name: "New Flow", enabled: false, createdAt: Date.now(), updatedAt: Date.now(), steps: [] });
  state.flows = [draft, ...state.flows];
  state.view = "flows";
  state.flowEditorId = draft.id;
  state.flowSelectedStepIndex = 0;
  syncHashWithState();
  persist();
  render();
}

// `monitorScope` controls ONLY what gets captured into this recording session (see
// shouldCaptureForRecording in page-interceptor.js) - it has no effect on My Mocks or on
// replaying any Flow. When called with no name (legacy/no-UI callers), falls back to the
// original prompt-based flow with an unrestricted (global) monitor, matching old behavior.
function startRecordingFlow(name, monitorScope) {
  const flowName = name !== undefined ? name : window.prompt("Flow name", state.recording?.name || "Successful Checkout");
  if (!flowName || !String(flowName).trim()) return;
  if (!leaveFlowDraft()) return;
  state.recording = { active: true, name: String(flowName).trim(), captured: [], startedAt: Date.now(), flowId: crypto.randomUUID(), monitorScope: monitorScope || { type: "global" } };
  state.recordSetup = null;
  state.flowEditorId = null;
  state.view = "flows";
  syncHashWithState();
  persist();
  render();
}

function openRecordSetup() {
  if (!leaveFlowDraft()) return;
  state.recordSetup = { open: true };
  state.flowEditorId = null;
  state.view = "flows";
  syncHashWithState();
  render();
}
function closeRecordSetup() {
  state.recordSetup = null;
  render();
}

// Accepts "myapp.company.com" or a full URL and normalizes it to an origin + pathname.
// Rejects blank input and non-http(s) URLs (e.g. chrome-extension://) so a recording can
// never be scoped to something that could never generate a matching request.
function normalizeMonitorTarget(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return { error: "Enter a domain or app URL to monitor." };
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`); }
  catch { return { error: "That doesn't look like a valid domain or URL." }; }
  if (!["http:", "https:"].includes(url.protocol)) return { error: "Only http/https domains can be monitored." };
  return { origin: url.origin, pathname: url.pathname || "/" };
}
// Lenient convenience wrapper (falls back to global instead of erroring) - used by callers
// that don't have an inline error UI. `domainValue` defaults to the last known app tab.
function buildMonitorScope(captureScopeType, domainValue) {
  if (captureScopeType === "global") return { type: "global" };
  const raw = domainValue !== undefined ? domainValue : (state.lastActiveTab ? `${state.lastActiveTab.origin}${state.lastActiveTab.pathname || ""}` : "");
  const normalized = normalizeMonitorTarget(raw);
  if (normalized.error) return { type: "global" };
  return captureScopeType === "page" ? { type: "page", origin: normalized.origin, pathname: normalized.pathname } : { type: "site", origin: normalized.origin };
}
function confirmRecordSetup() {
  const nameInput = $("#record-setup-name");
  const name = nameInput ? nameInput.value : "";
  if (!name || !String(name).trim()) { state.recordSetup = { open: true, error: "Enter a flow name." }; render(); return; }
  const captureScopeType = $("input[name='monitor-mode']:checked")?.value || "site";
  if (captureScopeType === "global") {
    state.recordSetup = null;
    startRecordingFlow(String(name).trim(), { type: "global" });
    return;
  }
  const domainInput = $("#record-setup-domain");
  const normalized = normalizeMonitorTarget(domainInput ? domainInput.value : "");
  if (normalized.error) { state.recordSetup = { open: true, error: normalized.error }; render(); return; }
  const monitorScope = captureScopeType === "page" ? { type: "page", origin: normalized.origin, pathname: normalized.pathname } : { type: "site", origin: normalized.origin };
  state.recordSetup = null;
  startRecordingFlow(String(name).trim(), monitorScope);
}

function stopRecordingFlow() {
  if (!state.recording?.active) return;
  const items = Array.isArray(state.recording.captured) ? state.recording.captured : [];
  const flowName = state.recording.name || "Unnamed flow";
  const flowId = state.recording.flowId || crypto.randomUUID();
  state.recording = null;
  const flow = items.length ? createFlowFromCapture(flowName, items) : null;
  if (!flow) {
    const draft = normalizeFlow({ id: flowId, name: flowName, enabled: false, createdAt: Date.now(), updatedAt: Date.now(), steps: [] });
    state.flows = [draft, ...state.flows];
    state.flowEditorId = draft.id;
    state.flowSelectedStepIndex = 0;
  }
  syncHashWithState();
  persist();
  render();
}

function cancelRecordingFlow() {
  if (!state.recording?.active) return;
  const capturedCount = Array.isArray(state.recording.captured) ? state.recording.captured.length : 0;
  if (capturedCount > 0 && !window.confirm("Discard this recording?\n\nAll captured requests from this recording session will be removed.")) return;
  // Discard the whole in-progress session - no flow, draft, or existing flow is touched.
  state.recording = null;
  persist();
  render();
}

function toggleFlow(flowId) {
  let nextActiveId = null;
  state.flows = state.flows.map((flow) => {
    const current = normalizeFlow(flow);
    const isSelected = current.id === flowId;
    const enabled = isSelected && !current.enabled;
    if (enabled) nextActiveId = current.id;
    return { ...current, enabled, updatedAt: Date.now() };
  });
  state.activeFlowId = nextActiveId || null;
  state.enabled = Boolean(nextActiveId) || state.enabled;
  persist();
  render();
}

function openFlowEditor(flowId) {
  if (!state.flows.some((flow) => flow.id === flowId)) return;
  if (!leaveFlowDraft(flowId)) return;
  state.flowEditorId = flowId;
  state.flowSelectedStepIndex = 0;
  flowStepView = "response";
  syncHashWithState();
  render();
}

function closeFlowEditor() {
  if (!leaveFlowDraft()) return;
  state.flowEditorId = null;
  state.flowSelectedStepIndex = 0;
  syncHashWithState();
  render();
}

function deleteFlow(flowId) {
  if (flowDraft?.id === flowId && !leaveFlowDraft()) return;
  state.flows = state.flows.filter((flow) => flow.id !== flowId);
  if (state.activeFlowId === flowId) state.activeFlowId = null;
  if (state.flowEditorId === flowId) { state.flowEditorId = null; syncHashWithState(); }
  persist();
  render();
}

function flowEndpoint(url) {
  try { return new URL(url).pathname || "/"; } catch { return String(url || "*").split(/[?#]/)[0]; }
}
const flowIcon = (path) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="' + path + '"></path></svg>';
function renderFlowEditor(flow) {
  const safeFlow = { ...(getFlowDraft() || normalizeFlow(flow)), enabled: flow.enabled };
  const selectedIndex = Math.min(Number(state.flowSelectedStepIndex || 0), Math.max(safeFlow.steps.length - 1, 0));
  const selectedStep = safeFlow.steps[selectedIndex] || null;
  const stepsHtml = safeFlow.steps.map((step, index) => `<div class="flow-step-item ${index === selectedIndex ? "selected" : ""}"><input class="flow-step-toggle" type="checkbox" data-step-toggle="${index}" ${step.enabled === false ? "" : "checked"} aria-label="Toggle step ${index + 1}"><button class="flow-step-select" data-step-select="${index}" type="button" aria-current="${index === selectedIndex ? "step" : "false"}"><span class="flow-step-number">${String(index + 1).padStart(2, "0")}</span><span class="flow-step-meta-text"><span class="method-text ${methodClass(step.matcher?.method)}">${esc(step.matcher?.method || "GET")}</span><span class="flow-step-path" title="${esc(step.matcher?.urlPattern || step.request?.url)}">${esc(flowEndpoint(step.matcher?.urlPattern || step.request?.url))}</span>${step.pageContext?.origin ? `<span class="flow-step-route" title="${esc(step.pageContext.origin)}${esc(step.pageContext.pathname)}">Page ${esc(step.pageContext.pathname || "/")}</span>` : ""}</span><span class="flow-step-status">${esc(step.response?.status || 200)}</span></button></div>`).join("");

  const inspector = selectedStep ? `
    <div class="flow-step-inspector">
      <div class="flow-step-header-row">
        <div>
          <div class="section-label">Step ${selectedIndex + 1}${selectedStep?.pageContext?.origin ? ` · ${esc(selectedStep.pageContext.pathname || "/")}` : ""}</div>
          <h3>${esc(selectedStep?.matcher?.method || "GET")} ${esc(flowEndpoint(selectedStep?.matcher?.urlPattern || selectedStep?.request?.url))}</h3>
        </div>
        <div class="flow-step-actions">
          <button class="flow-icon-btn" data-step-move="up" type="button" title="Move Up" aria-label="Move Up" ${selectedIndex === 0 ? "disabled" : ""}>${flowIcon("M12 19V5m-6 6 6-6 6 6")}</button>
          <button class="flow-icon-btn" data-step-move="down" type="button" title="Move Down" aria-label="Move Down" ${selectedIndex === safeFlow.steps.length - 1 ? "disabled" : ""}>${flowIcon("M12 5v14m-6-6 6 6 6-6")}</button>
          <button class="flow-icon-btn danger" data-step-remove="${selectedIndex}" type="button" title="Delete step" aria-label="Delete step">${flowIcon("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5")}</button>
        </div>
      </div>

      <div class="editor-tabs" role="tablist">
        <button class="editor-tab ${flowStepView === "response" ? "active" : ""}" type="button" data-flow-step-view="response" role="tab" aria-selected="${flowStepView === "response"}">Response</button>
        <button class="editor-tab ${flowStepView === "request" ? "active" : ""}" type="button" data-flow-step-view="request" role="tab" aria-selected="${flowStepView === "request"}">Request</button>
      </div>

      <div class="editor-panel ${flowStepView === "request" ? "active" : ""}" data-panel="request">
        <div class="flow-form-grid flow-request-row">
          <label>Method<select data-step-field="method">${[...new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*", selectedStep?.matcher?.method || "GET"])].map(method => `<option ${method === (selectedStep?.matcher?.method || "GET") ? "selected" : ""}>${esc(method)}</option>`).join("")}</select></label>
          <label>URL pattern<input data-step-field="urlPattern" value="${esc(selectedStep?.matcher?.urlPattern || selectedStep?.request?.url || "*")}"></label>
        </div>
        <label>Request headers<textarea data-step-field="requestHeaders">${esc(typeof selectedStep?.request?.headers === "string" ? selectedStep.request.headers : JSON.stringify(selectedStep?.request?.headers || {}, null, 2))}</textarea></label>
        <div class="body-heading"><span>Request body</span><button class="format-json" type="button" data-step-format="requestBody">Format JSON</button></div>
        <textarea class="body-editor" data-step-field="requestBody">${esc(typeof selectedStep?.request?.body === "string" ? selectedStep.request.body : JSON.stringify(selectedStep?.request?.body ?? "", null, 2))}</textarea>
      </div>

      <div class="editor-panel ${flowStepView === "response" ? "active" : ""}" data-panel="response">
        <div class="flow-form-grid">
          <label>Status<input data-step-field="status" type="number" value="${esc(selectedStep?.response?.status || 200)}"></label>
          <label>Delay (ms)<input data-step-field="delay" type="number" value="${esc(selectedStep?.delay || 0)}"></label>
        </div>
        <label>Response headers<textarea data-step-field="responseHeaders">${esc(typeof selectedStep?.response?.headers === "string" ? selectedStep.response.headers : JSON.stringify(selectedStep?.response?.headers || {}, null, 2))}</textarea></label>
        <div class="body-heading"><span>Response body</span><button class="format-json" type="button" data-step-format="responseBody">Format JSON</button></div>
        <textarea class="body-editor response-body-editor" data-step-field="responseBody">${esc(typeof selectedStep?.response?.body === "string" ? selectedStep.response.body : JSON.stringify(selectedStep?.response?.body ?? "", null, 2))}</textarea>
      </div>

    </div>
  ` : "";

  const addStep = '<button id="add-flow-step" class="btn btn-secondary flow-add-step" type="button">+ Add Step</button>';
  rulesElement.innerHTML = `<section class="flow-editor-shell"><div class="flow-editor-header"><button id="close-flow-editor" class="flow-back-link" type="button">&larr; Flows</button><div class="flow-header-main"><div><div class="flow-editor-title-row"><h2>${esc(safeFlow.name || "Flow")}</h2><span class="flow-badge">${safeFlow.enabled ? "Enabled" : "Disabled"}</span></div><p>${safeFlow.steps.length} step${safeFlow.steps.length === 1 ? "" : "s"}</p></div><div class="flow-editor-actions"><span id="flow-unsaved" ${flowDraftDirty() ? "" : "hidden"}>&bull; Unsaved changes</span><button id="rename-flow" class="btn btn-secondary" type="button">Rename</button><button id="reset-flow" class="btn btn-secondary" type="button" ${!flowDraftDirty() || flowSaving ? "disabled" : ""}>Discard Changes</button><button id="save-flow" class="btn btn-primary" type="button" ${!flowDraftDirty() || flowSaving ? "disabled" : ""}>Save Flow</button></div></div><p id="flow-draft-error" role="alert">${esc(flowDraftError)}</p></div>${safeFlow.steps.length ? `<div class="flow-editor-layout"><aside class="flow-step-panel"><div class="flow-rail-heading">API STEPS</div>${stepsHtml}${addStep}</aside>${inspector}</div>` : `<div class="flow-empty"><span class="flow-empty-icon">${flowIcon("M12 5v14M5 12h14")}</span><h3>No steps yet</h3><p>Add an API step to build this Flow.</p>${addStep}</div>`}</section>`;
}


function flowOrigin(flow) {
  const withOrigin = (flow.steps || []).find((step) => step?.pageContext?.origin);
  return withOrigin?.pageContext?.origin || null;
}

function renderRecordSetup() {
  const setup = state.recordSetup || {};
  const tab = state.lastActiveTab;
  const suggestedName = state.recording?.name || "New Flow";
  const domainDefault = tab?.origin || "";
  const currentTabLine = tab?.origin
    ? `<div class="record-setup-current-tab"><span>Current tab: ${esc(tab.origin)}${esc(tab.pathname || "")}</span><button id="record-setup-use-current-tab" class="btn btn-secondary" type="button">Use Current Tab</button></div>`
    : `<div class="record-setup-current-tab record-setup-unavailable">Current application unavailable</div>`;
  const errorLine = setup.error ? `<div class="record-setup-error">${esc(setup.error)}</div>` : "";
  rulesElement.innerHTML = `<section class="record-setup">
    <div class="record-setup-header"><h2>Record Flow</h2><p>Choose a name and which application to monitor.</p></div>
    <label class="record-setup-field">Flow name<input id="record-setup-name" type="text" value="${esc(suggestedName)}" placeholder="e.g. PC Collections"></label>
    <label class="record-setup-field">Domain / App URL to monitor<input id="record-setup-domain" type="text" value="${esc(domainDefault)}" placeholder="https://myapp.company.com"></label>
    ${currentTabLine}
    <div class="record-setup-field">
      <span class="record-setup-label">Capture scope</span>
      <label class="record-setup-radio"><input type="radio" name="monitor-mode" value="site" checked> Entire domain</label>
      <label class="record-setup-radio"><input type="radio" name="monitor-mode" value="page"> Exact page</label>
      <label class="record-setup-radio"><input type="radio" name="monitor-mode" value="global"> Global</label>
    </div>
    ${errorLine}
    <div class="record-setup-actions">
      <button id="record-setup-start" class="btn btn-primary" type="button">Start Recording</button>
      <button id="record-setup-cancel" class="btn btn-secondary" type="button">Cancel</button>
    </div>
  </section>`;
}

function renderFlows() {
  if (state.recordSetup?.open) { renderRecordSetup(); return; }
  const recording = state.recording || null;
  const selectedFlow = state.flows.find((flow) => flow.id === state.flowEditorId);
  if (!recording?.active && selectedFlow) { renderFlowEditor(selectedFlow); return; }
  const allFlows = state.flows.map(normalizeFlow);
  const siteOrigins = [...new Set(allFlows.map(flowOrigin).filter(Boolean))];
  if (!state.flowSiteFilter || (state.flowSiteFilter !== "all" && !siteOrigins.includes(state.flowSiteFilter))) state.flowSiteFilter = "all";
  const activeFilter = state.flowSiteFilter || "all";
  const visibleFlows = activeFilter === "all" ? allFlows : allFlows.filter((flow) => flowOrigin(flow) === activeFilter);
  const siteFilterMarkup = siteOrigins.length ? `<label class="flow-site-filter">Site<select id="flow-site-filter"><option value="all" ${activeFilter === "all" ? "selected" : ""}>All Flows</option>${siteOrigins.map((origin) => `<option value="${esc(origin)}" ${activeFilter === origin ? "selected" : ""}>${esc(origin.replace(/^https?:\/\//, ""))}</option>`).join("")}</select></label>` : "";
  const flowRows = visibleFlows.length ? visibleFlows.map((safeFlow) => {
    const enabled = Boolean(safeFlow.enabled);
    const origin = flowOrigin(safeFlow);
    const previewSteps = safeFlow.steps.slice(0, 4);
    const remaining = safeFlow.steps.length - previewSteps.length;
    const previewRows = previewSteps.map((step, index) => {
      const method = step?.matcher?.method || "GET";
      const rawUrl = step?.matcher?.urlPattern || step?.request?.url || "*";
      return `<div class="flow-step-preview-row"><span class="flow-step-number">${index + 1}</span><span class="method-text ${methodClass(method)}">${esc(method)}</span><span class="flow-step-path" title="${esc(rawUrl)}">${esc(flowEndpoint(rawUrl))}</span></div>`;
    }).join("");
    const preview = previewRows || `<div class="flow-step-more">No requests captured yet.</div>`;
    const more = remaining > 0 ? `<div class="flow-step-more">+${remaining} more</div>` : "";
    return `<article class="flow-item ${enabled ? "flow-active" : ""}"><div class="flow-header"><div class="flow-name-wrap"><span class="flow-name">${esc(safeFlow.name || "Unnamed flow")}</span><span class="flow-status-badge ${enabled ? "on" : "off"}">${enabled ? "● Active" : "Disabled"}</span></div><div class="flow-actions"><button class="flow-action" data-flow-action="toggle" data-flow-id="${esc(safeFlow.id)}">${enabled ? "Disable" : "Enable"}</button><button class="flow-action flow-action-primary" data-flow-action="edit" data-flow-id="${esc(safeFlow.id)}">Edit Flow</button><details class="flow-menu"><summary class="flow-menu-trigger" aria-label="More actions">⋯</summary><div class="flow-menu-items"><button class="flow-menu-item" data-flow-action="duplicate" data-flow-id="${esc(safeFlow.id)}">Duplicate</button><button class="flow-menu-item danger" data-flow-action="delete" data-flow-id="${esc(safeFlow.id)}">Delete</button></div></details></div></div><div class="flow-meta">${origin ? `${esc(origin.replace(/^https?:\/\//, ""))} · ` : ""}${safeFlow.steps.length} step${safeFlow.steps.length === 1 ? "" : "s"} · ${new Date(safeFlow.updatedAt || safeFlow.createdAt || Date.now()).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</div><div class="flow-summary">${preview}${more}</div></article>`;
  }).join("") : `<div class="empty-editor"><strong>No flows yet</strong><span>Record a scenario to capture multiple API responses into a reusable test flow.</span><button id="record-flow-empty" class="btn btn-primary" type="button">Record Flow</button><button id="new-flow-empty" class="btn btn-secondary" type="button">+ New Flow</button></div>`;
  const activeCount = allFlows.filter((flow) => flow.enabled).length;
  const countSummary = allFlows.length ? `<span class="flows-count">${allFlows.length} flow${allFlows.length === 1 ? "" : "s"}${activeCount ? ` · ${activeCount} active` : ""}</span>` : "";
  const recordingMarkup = recording?.active ? renderRecordingBanner(recording) : "";
  rulesElement.innerHTML = `<section class="flows-page"><div class="flows-header"><div><h2>Flows</h2><p>Reusable multi-step API scenarios${countSummary ? "" : "."}</p>${countSummary}</div><div class="flows-header-actions">${siteFilterMarkup}<button id="record-new-flow" class="btn btn-secondary" type="button">Record Flow</button><button id="new-flow-header" class="btn btn-primary" type="button">+ New Flow</button></div></div>${recordingMarkup}<div class="flow-list">${flowRows}</div></section>`;
}

function renderRecordingBanner(recording) {
  const scope = recording.monitorScope || { type: "global" };
  const tab = state.lastActiveTab;
  const isGlobal = scope.type === "global";
  const outside = !isGlobal && Boolean(tab) && (tab.origin !== scope.origin || (scope.type === "page" && (tab.pathname || "/") !== (scope.pathname || "/")));
  const currentPageLabel = tab ? (outside ? `${tab.origin}${tab.pathname || ""}` : (scope.type === "page" ? (tab.pathname || "/") : (tab.pathname || tab.origin))) : "Unknown";
  const monitorRow = isGlobal
    ? `<div class="recording-banner-row"><span class="recording-banner-key">Monitoring</span><span class="recording-banner-value">Global</span></div>`
    : `<div class="recording-banner-row"><span class="recording-banner-key">Monitoring ${scope.type === "page" ? "page" : "domain"}</span><span class="recording-banner-value">${esc(scope.origin)}${scope.type === "page" ? esc(scope.pathname || "") : ""}</span></div>`;
  const pageRow = `<div class="recording-banner-row"><span class="recording-banner-key">Current page</span><span class="recording-banner-value">${esc(currentPageLabel)}</span></div>`;
  const pausedRow = outside ? `<div class="recording-banner-warning">Outside monitored ${scope.type === "page" ? "page" : "domain"} — capture paused</div>` : "";
  const countRow = `<div class="recording-banner-row"><span class="recording-banner-key">Captured</span><span class="recording-banner-value">${(recording.captured || []).length} request${(recording.captured || []).length === 1 ? "" : "s"}</span></div>`;
  return `<div class="recording-banner"><div class="recording-banner-info"><strong>● Recording "${esc(recording.name || "Unnamed flow")}"</strong><div class="recording-banner-meta">${monitorRow}${pageRow}${pausedRow}${countRow}<div class="recording-banner-row"><span class="recording-banner-key">Mocking</span><span class="recording-banner-value">${state.enabled ? "On" : "Off"}</span></div></div></div><div class="recording-banner-actions"><button id="stop-recording" class="btn btn-primary" type="button">Stop & Review</button><button id="cancel-recording" class="btn-cancel-recording" type="button">Cancel Recording</button></div></div>`;
}

function render() {
  document.querySelectorAll(".top-nav-item").forEach(item => item.classList.toggle("top-nav-active", item.dataset.view === state.view));
  document.body.classList.toggle("view-flows", state.view === "flows");
  if (state.view === "flows") {
    renderFlows();
    return;
  }
  if (!selectedRuleId || !state.rules.some((rule) => rule.id === selectedRuleId)) selectedRuleId = state.rules[0]?.id || null;
  const selectedRule = state.rules.find((rule) => rule.id === selectedRuleId);
  if (selectedRule) {
    activeResponseIndex = Math.min(activeResponseIndex, selectedRule.responses.length - 1);
    selectedRule.response = selectedRule.responses[activeResponseIndex];
  }
  rulesElement.innerHTML = `<aside class="mock-rail"><div class="rail-heading"><span>Mocks</span><span class="rail-heading-actions"><span class="rail-count">${state.rules.length}</span><button id="import-mocks" class="rail-action" type="button" title="Import mocks">↥ Import</button><button id="export-mocks" class="rail-action" type="button" title="Export checked mocks">↧ Export</button><button id="rail-add" class="rail-action rail-add" type="button" aria-label="New mock" title="New mock">＋</button></span></div><div class="mock-list">${state.rules.map(listTemplate).join("")}</div></aside><section class="editor-stage">${selectedRule ? editorTemplate(selectedRule) : `<div class="empty-editor"><strong>No mocks yet</strong><span>Create a mock to start building a response.</span><button id="empty-add" class="btn btn-primary" type="button">+ New mock</button></div>`}</section>`;
  const responseMeta = $(".response-meta");
  if (responseMeta) {
    const responsePanel = $(".editor-panel[data-panel=\"response\"]");
    responsePanel.insertAdjacentHTML("afterbegin", `<div class="response-variants" role="tablist" aria-label="Mock responses">${selectedRule.responses.map((response, index) => `<button class="response-variant ${index === activeResponseIndex ? "active" : ""}" type="button" data-response-index="${index}" role="tab" aria-selected="${index === activeResponseIndex}"><span>${esc(response.status)} response</span>${selectedRule.responses.length > 1 ? `<span class="response-variant-close" data-delete-response aria-label="Delete ${esc(response.status)} response" title="Delete response">×</span>` : ""}</button>`).join("")}<button class="add-response" type="button" data-add-response>＋ Add response</button></div>`);
    const controls = responseMeta.querySelectorAll("label");
    if (controls[0]) {
      controls[0].classList.add("response-toggle-control");
      const checkbox = $("input", controls[0]);
      const labelText = document.createElement("span");
      labelText.textContent = controls[0].childNodes[0]?.textContent?.trim() || "Return mock response";
      controls[0].childNodes[0]?.remove();
      controls[0].prepend(checkbox);
      controls[0].append(labelText);
    }
    controls[1]?.classList.add("response-status-control");
    controls[2]?.classList.add("response-delay-control");
    controls[3]?.classList.add("response-headers-control");
  }
}

function markDirty(editor) { editor.classList.add("dirty"); const button = $(".publish", editor); if (button) button.disabled = false; }
function collectRule(editor, baseRule) {
  const rule = JSON.parse(JSON.stringify(baseRule));
  editor.querySelectorAll("[data-path]").forEach((field) => {
    let value = field.type === "number" ? Number(field.value) : field.value;
    if (typeof value === "string" && (field.dataset.path === "match.urlPattern" || field.dataset.path === "request.url" || field.dataset.path === "match.method" || field.dataset.path === "request.method")) {
      value = value.trim();
    }
    writePath(rule, field.dataset.path, value);
  });
  rule.name = nameFromUrl(rule.match?.urlPattern);
  rule.enabled = $(".rule-enabled", editor)?.checked ?? rule.enabled;
  rule.response.enabled = $(".response-enabled", editor)?.checked ?? rule.response.enabled;
  rule.responses[activeResponseIndex] = rule.response;
  rule.defaultResponseIndex = activeResponseIndex;
  delete rule._isNew;
  return rule;
}
function addRule() { const rule = { ...makeRule(), _isNew: true }; rule.response = rule.responses[0]; state.rules.push(rule); selectedRuleId = rule.id; activeResponseIndex = 0; activeView = "response"; render(); const editor = $(".editor"); markDirty(editor); $(".editor-url", editor)?.focus(); }

$("#enabled").addEventListener("change", (event) => { state.enabled = event.target.checked; persist(); $("#toggle-status").textContent = state.enabled ? "Active" : "Inactive"; });
$("#dark-mode").addEventListener("change", (event) => { state.darkMode = event.target.checked; applyTheme(); persist(); });
$("#add").addEventListener("click", addRule);
document.querySelectorAll(".top-nav-item").forEach((item) => {
  item.addEventListener("click", () => setView(item.dataset.view));
});
rulesElement.addEventListener("click", (event) => {
  if (event.target.closest("#record-new-flow") || event.target.closest("#record-flow-empty")) { openRecordSetup(); return; }
  if (event.target.closest("#record-setup-cancel")) { closeRecordSetup(); return; }
  if (event.target.closest("#record-setup-start")) { confirmRecordSetup(); return; }
  if (event.target.closest("#record-setup-use-current-tab")) {
    const input = $("#record-setup-domain");
    if (input && state.lastActiveTab?.origin) input.value = `${state.lastActiveTab.origin}${state.lastActiveTab.pathname || ""}`;
    return;
  }
  if (event.target.closest("#new-flow-header") || event.target.closest("#new-flow-empty")) { createBlankFlow(); return; }
  if (event.target.closest("#stop-recording")) { stopRecordingFlow(); return; }
  if (event.target.closest("#cancel-recording")) { cancelRecordingFlow(); return; }
  if (event.target.closest("#close-flow-editor")) { closeFlowEditor(); return; }
  if (event.target.closest("[data-flow-step-view]")) { flowStepView = event.target.closest("[data-flow-step-view]").dataset.flowStepView; render(); return; }
  if (event.target.closest("[data-step-format]")) {
    const trigger = event.target.closest("[data-step-format]");
    const field = $(`[data-step-field="${trigger.dataset.stepFormat}"]`, rulesElement);
    if (field) {
      try {
        field.value = formatJson(field.value);
        editFlowField(field.dataset.stepField, field.value);
        trigger.textContent = "Formatted";
        setTimeout(() => { trigger.textContent = "Format JSON"; }, 1000);
      } catch {
        trigger.textContent = "Invalid JSON";
        setTimeout(() => { trigger.textContent = "Format JSON"; }, 1200);
      }
    }
    return;
  }
  if (event.target.closest("#save-flow")) { saveFlowDraft(); return; }
  if (event.target.closest("#reset-flow")) { resetFlowDraft(); return; }
  if (flowSaving && event.target.closest(".flow-editor-shell")) return;
  if (event.target.closest("#rename-flow")) {
    const flow = getFlowDraft();
    if (!flow) return;
    const nextName = window.prompt("Rename flow", flow.name || "Flow");
    if (!nextName || !String(nextName).trim()) return;
    flow.name = String(nextName).trim();
    render();
    return;
  }
  if (event.target.closest("#add-flow-step")) {
    const flow = getFlowDraft();
    if (!flow) return;
    flow.steps.push({
      id: crypto.randomUUID(),
      order: flow.steps.length,
      enabled: true,
      request: { method: "GET", url: "https://example.com/step", pathname: "/step", headers: {}, body: "" },
      response: { status: 200, headers: { "content-type": "application/json" }, body: "{}", contentType: "application/json" },
      matcher: { method: "GET", urlPattern: "https://example.com/step", matchQuery: true, matchBody: false },
      delay: 0
    });
    state.flowSelectedStepIndex = flow.steps.length - 1;
    render();
    return;
  }
  if (event.target.closest("[data-step-toggle]")) {
    const flow = getFlowDraft();
    const index = Number(event.target.closest("[data-step-toggle]").dataset.stepToggle);
    if (!flow || !flow.steps[index]) return;
    flow.steps[index].enabled = event.target.checked;
    render();
    return;
  }
  if (event.target.closest("[data-step-select]")) {
    state.flowSelectedStepIndex = Number(event.target.closest("[data-step-select]").dataset.stepSelect);
    render();
    return;
  }
  if (event.target.closest("[data-step-move]")) {
    const flow = getFlowDraft();
    const direction = event.target.closest("[data-step-move]").dataset.stepMove;
    const index = Number(state.flowSelectedStepIndex || 0);
    if (!flow || index < 0 || !flow.steps[index]) return;
    const nextIndex = direction === "up" ? Math.max(index - 1, 0) : Math.min(index + 1, flow.steps.length - 1);
    if (nextIndex === index) return;
    const [step] = flow.steps.splice(index, 1);
    flow.steps.splice(nextIndex, 0, step);
    state.flowSelectedStepIndex = nextIndex;
    render();
    return;
  }
  if (event.target.closest("[data-step-remove]")) {
    const flow = getFlowDraft();
    const index = Number(event.target.closest("[data-step-remove]").dataset.stepRemove);
    if (!flow || !flow.steps[index]) return;
    flow.steps.splice(index, 1);
    state.flowSelectedStepIndex = Math.max(index - 1, 0);
    render();
    return;
  }
  if (event.target.closest(".top-nav-item")) { return; }
  const flowAction = event.target.closest("[data-flow-action]");
  if (flowAction) {
    const { flowAction: action, flowId } = flowAction.dataset;
    if (action === "toggle") { toggleFlow(flowId); return; }
    if (action === "edit") { openFlowEditor(flowId); return; }
    if (action === "delete") { deleteFlow(flowId); return; }
    if (action === "duplicate") {
      const source = state.flows.find((flow) => flow.id === flowId);
      if (!source) return;
      const duplicate = normalizeFlow({ ...source, id: crypto.randomUUID(), name: `${source.name || "Flow"} Copy`, enabled: false, createdAt: Date.now(), updatedAt: Date.now() });
      state.flows = [duplicate, ...state.flows];
      persist(); render(); return;
    }
  }
  if (event.target.closest("#import-mocks")) { $("#import-file").click(); return; }
  if (event.target.closest("#export-mocks")) { exportMocks(); return; }
  const mockSelect = event.target.closest(".mock-select");
  if (mockSelect) {
    const mockItem = mockSelect.closest(".mock-item");
    if (event.target.closest(".mock-trash")) {
      state.rules = state.rules.filter((rule) => rule.id !== mockItem.dataset.id);
      selectedRuleId = state.rules[0]?.id || null;
      persist();
      render();
      return;
    }
    if (event.target.closest(".rule-enabled")) return;
    selectedRuleId = mockItem.dataset.id;
    render();
    return;
  }
  if (event.target.closest("#rail-add, #empty-add")) { addRule(); return; }
  const editor = event.target.closest(".editor");
  if (!editor) return;
  if (event.target.closest("[data-delete-response]")) { const rule = state.rules.find((item) => item.id === editor.dataset.id); if (rule && rule.responses.length > 1) { rule.responses[activeResponseIndex] = rule.response; rule.responses.splice(activeResponseIndex, 1); activeResponseIndex = Math.min(activeResponseIndex, rule.responses.length - 1); rule.response = rule.responses[activeResponseIndex]; render(); markDirty($(".editor")); } return; }
  const responseTab = event.target.closest("[data-response-index]");
  if (responseTab) { const rule = state.rules.find((item) => item.id === editor.dataset.id); if (rule) { rule.responses[activeResponseIndex] = rule.response; activeResponseIndex = Number(responseTab.dataset.responseIndex); rule.response = rule.responses[activeResponseIndex]; render(); markDirty($(".editor")); } return; }
  if (event.target.closest("[data-add-response]")) { const rule = state.rules.find((item) => item.id === editor.dataset.id); if (rule) { rule.responses[activeResponseIndex] = rule.response; rule.responses.push({ ...rule.responses[0] }); activeResponseIndex = rule.responses.length - 1; rule.response = rule.responses[activeResponseIndex]; render(); markDirty($(".editor")); } return; }
  const tab = event.target.closest(".editor-tab");
  if (tab) { activeView = tab.dataset.view; render(); return; }
  const format = event.target.closest(".format-json");
  if (format) {
    const targetPath = format.dataset.target || (format.closest("[data-panel=\"request\"]") ? "request.body" : "response.body");
    const body = $(`[data-path="${targetPath}"]`, editor);
    if (body) {
      try {
        body.value = formatJson(body.value);
        format.textContent = "Formatted";
        markDirty(editor);
        setTimeout(() => { format.textContent = "Format JSON"; }, 1000);
      } catch {
        format.textContent = "Invalid JSON";
        setTimeout(() => { format.textContent = "Format JSON"; }, 1200);
      }
    }
    return;
  }
  if (event.target.closest(".delete")) { state.rules = state.rules.filter((rule) => rule.id !== editor.dataset.id); selectedRuleId = state.rules[0]?.id || null; persist(); render(); return; }
  if (event.target.closest(".publish")) {
    const index = state.rules.findIndex((rule) => rule.id === editor.dataset.id);
    if (index < 0) return;
    state.rules[index] = collectRule(editor, state.rules[index]);
    persist(() => {
      if (chrome.runtime.lastError) return;
      render();
    });
    return;
  }
});
$("#import-file").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) importMocks(file);
});
rulesElement.addEventListener("input", (event) => {
  if (event.target.dataset.stepField) { editFlowField(event.target.dataset.stepField, event.target.value); return; }
  const editor = event.target.closest(".editor");
  if (!editor || !event.target.dataset.path) return;
  markDirty(editor);
  if (event.target.dataset.path === "match.urlPattern") {
    const rule = state.rules.find((item) => item.id === editor.dataset.id);
    const mockItem = Array.from(document.querySelectorAll(".mock-item")).find((item) => item.dataset.id === editor.dataset.id);
    const mockName = mockItem && $(".mock-name", mockItem);
    if (rule) rule.name = nameFromUrl(event.target.value);
    if (mockName) mockName.textContent = rule?.name || nameFromUrl(event.target.value);
  }
});
rulesElement.addEventListener("change", (event) => {
  if (event.target.dataset.stepField) { editFlowField(event.target.dataset.stepField, event.target.value); return; }
  const editor = event.target.closest(".editor");
  if (editor && (event.target.dataset.path || event.target.classList.contains("response-enabled"))) {
    if (typeof event.target.value === "string" && (event.target.dataset.path === "match.urlPattern" || event.target.dataset.path === "request.url" || event.target.dataset.path === "match.method" || event.target.dataset.path === "request.method")) {
      event.target.value = event.target.value.trim();
    }
    markDirty(editor);
  }
  if (event.target.classList.contains("rule-enabled")) {
    const rule = state.rules.find((item) => item.id === event.target.closest(".mock-item").dataset.id);
    if (rule) { rule.enabled = event.target.checked; persist(); }
  }
  if (event.target.id === "flow-site-filter") { state.flowSiteFilter = event.target.value; render(); }
});
chrome.storage.local.get(state, (saved) => {
  state = { ...state, ...saved, rules: (saved.rules || []).map(normalizeRule) };
  applyRouteFromHash(); // the URL hash, not the persisted view, decides the landing screen
  $("#enabled").checked = state.enabled;
  $("#toggle-status").textContent = state.enabled ? "Active" : "Inactive";
  applyTheme();
  render();
});
window.addEventListener("hashchange", () => { applyRouteFromHash(); render(); });
window.addEventListener("beforeunload", (event) => {
  if (!flowDraftDirty()) return;
  event.preventDefault();
  event.returnValue = "";
});

// Live-updates the recording banner's captured count while another tab performs the
// recording. Only reacts to the `recording` key, and only re-renders when the Flows
// screen (where the banner lives) is showing, to avoid needless full rerenders/loops.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.recording) {
    const nextRecording = changes.recording.newValue || null;
    if (JSON.stringify(state.recording) !== JSON.stringify(nextRecording)) {
      state.recording = nextRecording;
      if (state.view === "flows") render();
    }
  }
  // background.js writes this as the user switches/navigates tabs - only relevant for the
  // Record Flow setup panel and the live "current route" shown in the recording banner.
  if (changes.lastActiveTab) {
    const nextTab = changes.lastActiveTab.newValue || null;
    if (JSON.stringify(state.lastActiveTab) !== JSON.stringify(nextTab)) {
      state.lastActiveTab = nextTab;
      if (state.view === "flows" && (state.recordSetup?.open || state.recording?.active)) render();
    }
  }
});

// Test-only hook (mirrors the ApiMockOptionsUtils pattern) so recording lifecycle
// logic can be exercised without simulating full DOM click delegation.
window.__flowTestHooks = { getFlowDraft, flowDraftDirty, editFlowField, saveFlowDraft, resetFlowDraft, getState: () => state, startRecordingFlow, stopRecordingFlow, cancelRecordingFlow, createBlankFlow, setView, applyRouteFromHash, openFlowEditor, closeFlowEditor, deleteFlow, toggleFlow, flowOrigin, observedOrigins, setFlowSiteFilter: (value) => { state.flowSiteFilter = value; render(); }, openRecordSetup, closeRecordSetup, confirmRecordSetup, buildMonitorScope, normalizeMonitorTarget };

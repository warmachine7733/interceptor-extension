const $ = (selector, element = document) => element.querySelector(selector);
const rulesElement = $("#rules");
let state = { enabled: false, darkMode: false, rules: [] };
let selectedRuleId = null;
let activeView = "response";
let activeResponseIndex = 0;
const { nameFromUrl, makeRule, esc, methodClass, pathPreview, writePath, parsePastedJson, formatJson, normalizeRule } = window.ApiMockOptionsUtils;

$("#version-name").textContent = `v${chrome.runtime.getManifest().version}`;
function cleanRule(rule) { const copy = JSON.parse(JSON.stringify(rule)); delete copy._isNew; delete copy.response; return copy; }
function persist(callback) { chrome.storage.local.set({ enabled: state.enabled, darkMode: state.darkMode, rules: state.rules.filter((rule) => !rule._isNew).map(cleanRule) }, callback); }
function applyTheme() {
  document.body.classList.toggle("dark-mode", state.darkMode);
  $("#dark-mode").checked = state.darkMode;
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

function render() {
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
rulesElement.addEventListener("click", (event) => {
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
});
chrome.storage.local.get(state, (saved) => { state = { ...state, ...saved, rules: (saved.rules || []).map(normalizeRule) }; $("#enabled").checked = state.enabled; $("#toggle-status").textContent = state.enabled ? "Active" : "Inactive"; applyTheme(); render(); });

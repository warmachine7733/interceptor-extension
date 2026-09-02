const $ = (selector, element = document) => element.querySelector(selector);
const rulesElement = $("#rules");
let state = { enabled: true, rules: [] };

const makeRule = () => ({
  id: crypto.randomUUID(),
  enabled: true,
  name: "New API mock",
  match: { urlPattern: "https://api.example.com/*", method: "*" },
  request: { url: "", method: "", headers: "{}", body: "" },
  response: { enabled: true, status: 200, statusText: "OK", headers: '{"content-type":"application/json"}', body: "{}", delayMs: 0 }
});

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

const getMethodBadgeClass = (method) => {
  const methodMap = { "GET": "method-get", "POST": "method-post", "PUT": "method-put", "PATCH": "method-patch", "DELETE": "method-delete", "HEAD": "method-head", "*": "method-star" };
  return methodMap[method] || "method-star";
};

const ruleTemplate = (rule) => `<article class="rule accordion-item" data-id="${rule.id}"><button class="accordion-header" type="button"><div class="accordion-title"><input class="rule-enabled" type="checkbox" ${rule.enabled ? "checked" : ""} onclick="event.stopPropagation()"><input class="rule-name-input" data-path="name" type="text" placeholder="Rule name" value="${esc(rule.name)}" onclick="event.stopPropagation()" onchange="event.stopPropagation()"><span class="method-badge ${getMethodBadgeClass(rule.match.method)}">${esc(rule.match.method)}</span></div><div class="accordion-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg></div></button><div class="accordion-body"><div class="accordion-content"><div class="fields"><label>URL Pattern (* wildcard)<input data-path="match.urlPattern" value="${esc(rule.match.urlPattern)}"></label><label>HTTP Method<select data-path="match.method">${["*","GET","POST","PUT","PATCH","DELETE","HEAD"].map((m) => `<option ${rule.match.method === m ? "selected" : ""}>${m}</option>`).join("")}</select></label></div><div class="request"><span class="section-title">Request Override</span><div class="fields"><label>Replacement URL (optional)<input data-path="request.url" placeholder="Leave empty to keep original" value="${esc(rule.request.url)}"></label><label>Replacement Method (optional)<input data-path="request.method" placeholder="GET, POST, etc." value="${esc(rule.request.method)}"></label></div><label>Headers JSON<textarea data-path="request.headers">${esc(rule.request.headers)}</textarea></label><label>Body (optional)<textarea data-path="request.body" placeholder="{}" style="min-height: 80px;">${esc(rule.request.body)}</textarea></label></div><div class="response"><label style="flex-direction: row; gap: 8px;"><input class="response-enabled" type="checkbox" ${rule.response.enabled ? "checked" : ""}><span>Return mock response</span></label><div class="fields"><label>Status Code<input data-path="response.status" type="number" value="${esc(rule.response.status)}"></label><label>Delay (ms)<input data-path="response.delayMs" type="number" value="${esc(rule.response.delayMs)}"></label></div><label>Response Headers JSON<textarea data-path="response.headers">${esc(rule.response.headers)}</textarea></label><label>Response Body<textarea data-path="response.body" placeholder="{}" style="min-height: 120px;">${esc(rule.response.body)}</textarea></label></div></div><button class="delete" type="button">Delete</button></div></article>`;

function readPath(object, path) { return path.split(".").reduce((value, key) => value[key], object); }
function writePath(object, path, value) { const parts = path.split("."); const last = parts.pop(); parts.reduce((target, key) => target[key], object)[last] = value; }
function render() { 
  rulesElement.innerHTML = state.rules.map(ruleTemplate).join(""); 
  setupAccordion();
}

function setupAccordion() {
  const headers = document.querySelectorAll(".accordion-header");
  headers.forEach(header => {
    header.addEventListener("click", function(event) {
      event.preventDefault();
      const accordionItem = this.closest(".accordion-item");
      const isOpen = accordionItem.classList.contains("open");
      
      // Close all accordion items
      document.querySelectorAll(".accordion-item").forEach(item => {
        item.classList.remove("open");
      });
      
      // Open current if it was closed
      if (!isOpen) {
        accordionItem.classList.add("open");
      }
    });
  });
}

function persist() { chrome.storage.local.set(state); }
$("#enabled").addEventListener("change", (event) => { state.enabled = event.target.checked; persist(); updateToggleStatus(); });
$("#add").addEventListener("click", () => { state.rules.push(makeRule()); render(); persist(); });

function updateToggleStatus() {
  const statusLabel = $("#toggle-status");
  if (statusLabel) {
    statusLabel.textContent = state.enabled ? "Active" : "Inactive";
  }
}
rulesElement.addEventListener("input", (event) => { const rule = state.rules.find((item) => item.id === event.target.closest(".rule")?.dataset.id); if (rule && event.target.dataset.path) { writePath(rule, event.target.dataset.path, event.target.type === "number" ? Number(event.target.value) : event.target.value); persist(); } });
rulesElement.addEventListener("change", (event) => { const rule = state.rules.find((item) => item.id === event.target.closest(".rule")?.dataset.id); if (!rule) return; if (event.target.classList.contains("rule-enabled")) rule.enabled = event.target.checked; if (event.target.classList.contains("response-enabled")) rule.response.enabled = event.target.checked; persist(); });
rulesElement.addEventListener("click", (event) => { if (!event.target.classList.contains("delete")) return; state.rules = state.rules.filter((item) => item.id !== event.target.closest(".rule").dataset.id); render(); persist(); });
chrome.storage.local.get(state, (saved) => { state = saved; $("#enabled").checked = state.enabled; updateToggleStatus(); render(); });

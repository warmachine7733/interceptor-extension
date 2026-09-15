import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

function makeElement(id) {
  return {
    id,
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    dataset: {},
    style: {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    click() {},
    focus() {}
  };
}

// Minimal sandboxed DOM (mirrors test/options-recording.test.mjs) used to load
// options-utils.js + options.js and exercise routing/navigation via __flowTestHooks.
function buildOptionsContext({ initialStorage = {}, initialHash = "" } = {}) {
  let storedData = { ...initialStorage };
  const knownIds = ["#rules", "#version-name", "#enabled", "#dark-mode", "#add", "#toggle-status", "#import-file", "#import-flows-file"];
  const elementsById = {};
  for (const id of knownIds) elementsById[id] = makeElement(id);

  const document = {
    body: makeElement("body"),
    querySelector: (selector) => elementsById[selector] || null,
    querySelectorAll: () => []
  };

  let hashValue = initialHash;
  const location = { get hash() { return hashValue; }, set hash(value) { hashValue = value; dispatch("hashchange"); } };
  const listeners = {};
  function dispatch(type) { (listeners[type] || []).forEach((fn) => fn()); }

  const storageChangeListeners = [];

  const sandbox = {
    console, setTimeout, URL, RegExp, JSON, Object, Number, String, Promise, Error, Map, Set, Array, Date,
    document,
    location,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    crypto: { randomUUID: (() => { let n = 0; return () => `test-id-${n++}`; })() },
    chrome: {
      runtime: { getManifest: () => ({ version: "1.1.7" }) },
      storage: {
        local: {
          get: (defaults, callback) => callback({ ...defaults, ...storedData }),
          set: (payload, callback) => {
            const changes = {};
            for (const key of Object.keys(payload)) changes[key] = { oldValue: storedData[key], newValue: payload[key] };
            storedData = { ...storedData, ...payload };
            callback && callback();
            storageChangeListeners.forEach((fn) => fn(changes, "local"));
          }
        },
        onChanged: { addListener: (fn) => storageChangeListeners.push(fn) }
      }
    },
    prompt: () => "Recorded Flow",
    confirm: () => true,
    alert: () => {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(fs.readFileSync(new URL("../options-utils.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(new URL("../options.js", import.meta.url), "utf8"), sandbox);

  return {
    hooks: sandbox.__flowTestHooks,
    getStoredData: () => storedData,
    getHash: () => hashValue,
    // simulates a storage write coming from another context (e.g. the recording content script)
    simulateExternalStorageChange: (payload) => {
      const changes = {};
      for (const key of Object.keys(payload)) changes[key] = { oldValue: storedData[key], newValue: payload[key] };
      storedData = { ...storedData, ...payload };
      storageChangeListeners.forEach((fn) => fn(changes, "local"));
    }
  };
}

test("default landing screen is My Mocks when there is no hash", () => {
  const { hooks } = buildOptionsContext({});
  assert.equal(hooks.getState().view, "mocks");
});

test("default landing screen is My Mocks even if a stale persisted view says flows", () => {
  const { hooks } = buildOptionsContext({ initialStorage: { view: "flows" } });
  assert.equal(hooks.getState().view, "mocks");
});

test("navigating to Flows updates state and hash", () => {
  const { hooks, getHash } = buildOptionsContext({});
  hooks.setView("flows");
  assert.equal(hooks.getState().view, "flows");
  assert.equal(getHash(), "#/flows");
});

test("opening a flow navigates to its detail route", () => {
  const flow = { id: "flow-1", name: "PC Auth", enabled: true, createdAt: 1, updatedAt: 1, steps: [] };
  const { hooks, getHash } = buildOptionsContext({ initialStorage: { flows: [flow] }, initialHash: "#/flows" });
  hooks.openFlowEditor("flow-1");
  assert.equal(hooks.getState().view, "flows");
  assert.equal(hooks.getState().flowEditorId, "flow-1");
  assert.equal(getHash(), "#/flows/flow-1");
});

test("an invalid/deleted flow id in the hash safely falls back to the flow list", () => {
  const { hooks, getHash } = buildOptionsContext({ initialStorage: { flows: [] }, initialHash: "#/flows/does-not-exist" });
  assert.equal(hooks.getState().view, "flows");
  assert.equal(hooks.getState().flowEditorId, null, "should not crash or open a nonexistent flow");
  assert.equal(getHash(), "#/flows", "hash should be corrected back to the flow list");
});

test("reopening a valid flow id from the hash restores that flow", () => {
  const flow = { id: "flow-2", name: "MIMO Unauth", enabled: false, createdAt: 1, updatedAt: 1, steps: [] };
  const { hooks } = buildOptionsContext({ initialStorage: { flows: [flow] }, initialHash: "#/flows/flow-2" });
  assert.equal(hooks.getState().view, "flows");
  assert.equal(hooks.getState().flowEditorId, "flow-2");
});

test("deleting the flow currently open in the editor returns safely to the list", () => {
  const flow = { id: "flow-3", name: "PC Collections", enabled: false, createdAt: 1, updatedAt: 1, steps: [] };
  const { hooks, getHash } = buildOptionsContext({ initialStorage: { flows: [flow] }, initialHash: "#/flows/flow-3" });
  assert.equal(hooks.getState().flowEditorId, "flow-3");
  hooks.deleteFlow("flow-3");
  assert.equal(hooks.getState().flowEditorId, null);
  assert.equal(hooks.getState().flows.length, 0);
  assert.equal(getHash(), "#/flows");
});

test("closing the flow editor returns to the flow list route", () => {
  const flow = { id: "flow-4", name: "Checkout", enabled: false, createdAt: 1, updatedAt: 1, steps: [] };
  const { hooks, getHash } = buildOptionsContext({ initialStorage: { flows: [flow] }, initialHash: "#/flows/flow-4" });
  hooks.closeFlowEditor();
  assert.equal(hooks.getState().flowEditorId, null);
  assert.equal(getHash(), "#/flows");
});

test("My Mocks still renders existing manual mocks unaffected by flow navigation", () => {
  const rule = { id: "rule-1", enabled: true, match: { urlPattern: "https://api.example.com/*", method: "GET" }, request: { url: "", method: "", headers: "{}", body: "" }, responses: [{ enabled: true, status: 200, body: "{}" }], defaultResponseIndex: 0 };
  const { hooks } = buildOptionsContext({ initialStorage: { rules: [rule] } });
  assert.equal(hooks.getState().rules.length, 1);
  hooks.setView("flows");
  hooks.setView("mocks");
  assert.equal(hooks.getState().rules.length, 1, "manual mocks must survive navigating away and back");
});

test("+ New Flow creates an empty flow and opens its editor without touching existing flows", () => {
  const existing = { id: "flow-5", name: "Existing", enabled: true, createdAt: 1, updatedAt: 1, steps: [{ id: "s1", order: 0, enabled: true, matcher: { method: "GET", urlPattern: "https://api.example.com/x" }, response: { status: 200 } }] };
  const { hooks } = buildOptionsContext({ initialStorage: { flows: [existing] } });
  hooks.createBlankFlow();
  const state = hooks.getState();
  assert.equal(state.flows.length, 2);
  assert.equal(state.flowEditorId, state.flows[0].id);
  assert.equal(state.flows[0].steps.length, 0);
  const untouched = state.flows.find((flow) => flow.id === "flow-5");
  assert.equal(untouched.steps.length, 1, "existing flow must remain untouched");
});

test("navigating between My Mocks and Flows does not cancel an active recording", () => {
  const { hooks } = buildOptionsContext({ initialStorage: { recording: { active: true, name: "In progress", captured: [], startedAt: Date.now(), flowId: "rec-1" } } });
  hooks.setView("mocks");
  hooks.setView("flows");
  assert.equal(hooks.getState().recording.active, true);
});

test("enabling a flow disables any previously-active flow (single-active-flow semantics preserved)", () => {
  const flowA = { id: "flow-a", name: "A", enabled: false, createdAt: 1, updatedAt: 1, steps: [] };
  const flowB = { id: "flow-b", name: "B", enabled: true, createdAt: 1, updatedAt: 1, steps: [] };
  const { hooks } = buildOptionsContext({ initialStorage: { flows: [flowA, flowB], activeFlowId: "flow-b" } });
  hooks.toggleFlow("flow-a");
  const state = hooks.getState();
  assert.equal(state.activeFlowId, "flow-a");
  assert.equal(state.flows.find((f) => f.id === "flow-a").enabled, true);
  assert.equal(state.flows.find((f) => f.id === "flow-b").enabled, false, "toggling a flow on must disable the previously active one");
  assert.equal(state.enabled, false, "a Flow button must not override the global extension switch");
});

test("flow exports round-trip safely and imported flows start disabled", () => {
  const flow = { id: "flow-export", name: "Checkout", enabled: true, createdAt: 1, updatedAt: 2, steps: [{ id: "step-1", order: 0, enabled: true, matcher: { method: "POST", urlPattern: "https://api.example.com/checkout" }, response: { status: 201, body: "ok" } }] };
  const { hooks } = buildOptionsContext({ initialStorage: { flows: [flow] } });
  const payload = hooks.flowExportPayload([flow]);
  assert.equal(payload.kind, "api-mock-flows");
  assert.equal(payload.flows[0].steps[0].matcher.urlPattern, "https://api.example.com/checkout");
  hooks.importFlowsPayload(payload);
  const imported = hooks.getState().flows[1];
  assert.notEqual(imported.id, flow.id, "a duplicate id is regenerated on import");
  assert.equal(imported.enabled, false, "an import must not activate interception unexpectedly");
});

test("live recording captured count updates through a storage change without reloading the page", () => {
  const { hooks, simulateExternalStorageChange } = buildOptionsContext({
    initialStorage: { recording: { active: true, name: "Live", captured: [], startedAt: Date.now(), flowId: "rec-2" } },
    initialHash: "#/flows"
  });
  assert.equal(hooks.getState().recording.captured.length, 0);
  simulateExternalStorageChange({ recording: { active: true, name: "Live", captured: [{ method: "GET", url: "https://x.test/y" }], startedAt: Date.now(), flowId: "rec-2" } });
  assert.equal(hooks.getState().recording.captured.length, 1, "recording snapshot should live-update from storage.onChanged");
});

test("import/export state (rules) is unaffected by the routing changes", () => {
  const rule = { id: "rule-2", enabled: true, match: { urlPattern: "https://api.example.com/*", method: "GET" }, request: { url: "", method: "", headers: "{}", body: "" }, responses: [{ enabled: true, status: 200, body: "{}" }], defaultResponseIndex: 0 };
  const { hooks, getStoredData } = buildOptionsContext({ initialStorage: { rules: [rule] } });
  hooks.setView("flows");
  assert.deepEqual(getStoredData().rules.map((r) => r.id), ["rule-2"]);
});

test("Flow list can filter to the current site vs all flows", () => {
  const flowA = {
    id: "flow-a", name: "PC Auth", enabled: false, createdAt: 1, updatedAt: 2,
    steps: [{ id: "s1", order: 0, enabled: true, matcher: { method: "GET", urlPattern: "https://api.company.com/x" }, response: { status: 200 }, pageContext: { origin: "https://app.company.com", pathname: "/x" } }]
  };
  const flowB = {
    id: "flow-b", name: "Other Site Flow", enabled: false, createdAt: 1, updatedAt: 1,
    steps: [{ id: "s1", order: 0, enabled: true, matcher: { method: "GET", urlPattern: "https://api.other.com/y" }, response: { status: 200 }, pageContext: { origin: "https://app.other.com", pathname: "/y" } }]
  };
  const { hooks } = buildOptionsContext({ initialStorage: { flows: [flowA, flowB] } });
  hooks.setView("flows");
  assert.equal(hooks.getState().flowSiteFilter, "all");
  assert.equal(hooks.flowOrigin(hooks.getState().flows.find((f) => f.id === "flow-a")), "https://app.company.com");
  assert.equal(hooks.flowOrigin(hooks.getState().flows.find((f) => f.id === "flow-b")), "https://app.other.com");
  assert.deepEqual([...hooks.observedOrigins()].sort(), ["https://app.company.com", "https://app.other.com"].sort());
  hooks.setFlowSiteFilter("https://app.company.com");
  assert.equal(hooks.getState().flowSiteFilter, "https://app.company.com");
  hooks.setFlowSiteFilter("all");
  assert.equal(hooks.getState().flowSiteFilter, "all");
});

test("an imported flow without page context on any step still works and reports no origin", () => {
  const legacyFlow = { id: "flow-legacy", name: "Legacy", enabled: false, createdAt: 1, updatedAt: 1, steps: [{ id: "s1", order: 0, enabled: true, matcher: { method: "GET", urlPattern: "https://api.example.com/legacy" }, response: { status: 200 } }] };
  const { hooks } = buildOptionsContext({ initialStorage: { flows: [legacyFlow] } });
  const stored = hooks.getState().flows.find((f) => f.id === "flow-legacy");
  assert.equal(hooks.flowOrigin(stored), null, "a flow with no step pageContext must report no origin (global)");
});

test("recording auto-captures pageContext into the resulting flow's steps on Stop & Review", () => {
  const capturedSteps = [{ method: "GET", url: "https://api.company.com/accounts", status: 200, responseBody: "{}", pageContext: { origin: "https://app.company.com", pathname: "/accounts" } }];
  const { hooks } = buildOptionsContext({
    initialStorage: {
      flows: [],
      recording: { active: true, name: "Journey", captured: capturedSteps, startedAt: Date.now(), flowId: "rec-1" }
    }
  });
  hooks.stopRecordingFlow();
  const flow = hooks.getState().flows[0];
  assert.equal(flow.steps[0].pageContext.origin, "https://app.company.com");
  assert.equal(flow.steps[0].pageContext.pathname, "/accounts");
});

test("normalizeRule strips any leftover 'scope' field - My Mocks are never page/site scoped", () => {
  const ruleWithStrayScope = { id: "rule-legacy", enabled: true, match: { urlPattern: "https://api.example.com/*", method: "GET" }, request: { url: "", method: "", headers: "{}", body: "" }, scope: { type: "site", origin: "https://old-feature.example.com" }, responses: [{ enabled: true, status: 200, body: "{}" }], defaultResponseIndex: 0 };
  const { hooks } = buildOptionsContext({ initialStorage: { rules: [ruleWithStrayScope] } });
  const rule = hooks.getState().rules.find((r) => r.id === "rule-legacy");
  assert.equal(rule.scope, undefined, "manual mocks must never carry a scope field");
});

// --- Record Flow setup panel: monitored target comes from the real app tab (background.js),
// never from the extension's own options page. ---

test("Record Flow setup panel reads the actual app tab URL from lastActiveTab, not the options page", () => {
  const { hooks } = buildOptionsContext({ initialStorage: { lastActiveTab: { origin: "https://app.company.com", pathname: "/collections", updatedAt: Date.now() } } });
  assert.equal(hooks.getState().lastActiveTab.origin, "https://app.company.com");
  assert.equal(hooks.getState().lastActiveTab.pathname, "/collections");
});

test("buildMonitorScope('site') uses the current app origin only", () => {
  const { hooks } = buildOptionsContext({ initialStorage: { lastActiveTab: { origin: "https://app.company.com", pathname: "/collections" } } });
  assert.deepEqual({ ...hooks.buildMonitorScope("site") }, { type: "site", origin: "https://app.company.com" });
});

test("buildMonitorScope('page') uses the current app origin AND pathname", () => {
  const { hooks } = buildOptionsContext({ initialStorage: { lastActiveTab: { origin: "https://app.company.com", pathname: "/collections" } } });
  assert.deepEqual({ ...hooks.buildMonitorScope("page") }, { type: "page", origin: "https://app.company.com", pathname: "/collections" });
});

test("buildMonitorScope('global') ignores the current app tab entirely", () => {
  const { hooks } = buildOptionsContext({ initialStorage: { lastActiveTab: { origin: "https://app.company.com", pathname: "/collections" } } });
  assert.deepEqual({ ...hooks.buildMonitorScope("global") }, { type: "global" });
});

test("buildMonitorScope falls back to global when the real app tab can't be resolved", () => {
  const { hooks } = buildOptionsContext({ initialStorage: { lastActiveTab: null } });
  assert.deepEqual({ ...hooks.buildMonitorScope("site") }, { type: "global" });
  assert.deepEqual({ ...hooks.buildMonitorScope("page") }, { type: "global" });
});

// --- Explicit domain field: user types/pastes a domain, or hits "Use Current Tab" ---

test("normalizeMonitorTarget accepts a bare domain and normalizes it to an https origin", () => {
  const { hooks } = buildOptionsContext({});
  const result = hooks.normalizeMonitorTarget("myapp.company.com");
  assert.equal(result.origin, "https://myapp.company.com");
  assert.equal(result.pathname, "/");
});

test("normalizeMonitorTarget accepts a full URL and extracts origin + pathname separately", () => {
  const { hooks } = buildOptionsContext({});
  const result = hooks.normalizeMonitorTarget("https://myapp.company.com/accounts?page=2#top");
  assert.equal(result.origin, "https://myapp.company.com");
  assert.equal(result.pathname, "/accounts", "query/hash must not be part of the pathname used for Exact Page scope");
});

test("normalizeMonitorTarget rejects blank input", () => {
  const { hooks } = buildOptionsContext({});
  assert.ok(hooks.normalizeMonitorTarget("").error);
  assert.ok(hooks.normalizeMonitorTarget("   ").error);
});

test("normalizeMonitorTarget rejects non-http(s) targets like chrome-extension://", () => {
  const { hooks } = buildOptionsContext({});
  assert.ok(hooks.normalizeMonitorTarget("chrome-extension://abcdefg/options.html").error);
  assert.ok(hooks.normalizeMonitorTarget("ftp://files.example.com").error);
});

test("buildMonitorScope('site') uses only the origin even when a full URL with a path is entered", () => {
  const { hooks } = buildOptionsContext({});
  assert.deepEqual({ ...hooks.buildMonitorScope("site", "https://myapp.company.com/accounts") }, { type: "site", origin: "https://myapp.company.com" });
});

test("buildMonitorScope('page') keeps the pathname from an explicitly entered URL", () => {
  const { hooks } = buildOptionsContext({});
  assert.deepEqual({ ...hooks.buildMonitorScope("page", "https://myapp.company.com/accounts") }, { type: "page", origin: "https://myapp.company.com", pathname: "/accounts" });
});

test("openRecordSetup opens the setup panel without starting a recording", () => {
  const { hooks } = buildOptionsContext({});
  hooks.openRecordSetup();
  assert.equal(hooks.getState().recordSetup.open, true);
  assert.equal(hooks.getState().recording, null, "no recording should start until the user confirms");
});

test("closeRecordSetup (Cancel) discards the setup panel without starting a recording", () => {
  const { hooks } = buildOptionsContext({});
  hooks.openRecordSetup();
  hooks.closeRecordSetup();
  assert.equal(hooks.getState().recordSetup, null);
  assert.equal(hooks.getState().recording, null);
});

test("the live current-route display updates from a storage.onChanged lastActiveTab update while the setup panel is open", () => {
  const { hooks, simulateExternalStorageChange } = buildOptionsContext({ initialStorage: { lastActiveTab: { origin: "https://app.company.com", pathname: "/login" } } });
  hooks.openRecordSetup();
  assert.equal(hooks.getState().lastActiveTab.pathname, "/login");
  simulateExternalStorageChange({ lastActiveTab: { origin: "https://app.company.com", pathname: "/accounts" } });
  assert.equal(hooks.getState().lastActiveTab.pathname, "/accounts", "route shown in the setup panel should live-update as the user navigates the real app");
});

test("a recording session started with no monitorScope (legacy path) behaves as global", () => {
  const { hooks } = buildOptionsContext({});
  hooks.startRecordingFlow(); // no explicit args -> legacy prompt-based path
  assert.deepEqual({ ...hooks.getState().recording.monitorScope }, { type: "global" });
});

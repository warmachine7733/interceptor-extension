import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

function makeElement(id) {
  const listeners = {};
  return {
    id,
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    dataset: {},
    style: {},
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatch(type, event) { (listeners[type] || []).forEach(fn => fn(event)); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    click() {},
    focus() {}
  };
}

// Builds a minimal sandboxed DOM sufficient to load options-utils.js + options.js
// without a full browser/jsdom, then exposes the recording lifecycle functions via
// the __flowTestHooks hook options.js registers for testing.
function buildOptionsContext(initialStorage = {}) {
  let storedData = { ...initialStorage };
  const storageListeners = [];
  const knownIds = ["#rules", "#version-name", "#enabled", "#dark-mode", "#add", "#toggle-status", "#import-file"];
  const elementsById = {};
  for (const id of knownIds) elementsById[id] = makeElement(id);

  const document = {
    body: makeElement("body"),
    querySelector: (selector) => elementsById[selector] || null,
    querySelectorAll: () => []
  };

  let promptValue = "Recorded Flow";
  let confirmValue = true;
  const confirmCalls = [];
  let hashValue = "";
  const location = { get hash() { return hashValue; }, set hash(value) { hashValue = value; } };
  const listeners = {};

  const sandbox = {
    console, setTimeout, URL, RegExp, JSON, Object, Number, String, Promise, Error, Map, Set, Array, Date,
    document,
    location,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    crypto: { randomUUID: (() => { let n = 0; return () => `test-id-${n++}`; })() },
    chrome: {
      runtime: { getManifest: () => ({ version: "1.1.7" }) },
      storage: { local: {
        get: (defaults, callback) => callback({ ...defaults, ...storedData }),
        set: (payload, callback) => { storedData = { ...storedData, ...payload }; callback && callback(); }
      }, onChanged: { addListener: (fn) => storageListeners.push(fn) } }
    },
    prompt: (...args) => { void args; return promptValue; },
    confirm: (...args) => { confirmCalls.push(args[0]); return confirmValue; },
    alert: () => {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  vm.runInContext(fs.readFileSync(new URL("../options-utils.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(fs.readFileSync(new URL("../options.js", import.meta.url), "utf8"), sandbox);

  return {
    hooks: sandbox.__flowTestHooks,
    click: (selector, dataset = {}, checked = false) => elementsById["#rules"].dispatch("click", { target: { checked, closest: value => value === selector ? { dataset } : null } }),
    dispatchWindow: (type, event) => (listeners[type] || []).forEach(fn => fn(event)),
    setHash: (hash) => { hashValue = hash; (listeners.hashchange || []).forEach(fn => fn()); },
    setInput: (selector, value) => { elementsById[selector] = { value }; },
    rerenderRoute: () => (listeners.hashchange || []).forEach(fn => fn()),
    getHash: () => hashValue,
    emitStorage: (changes) => storageListeners.forEach(fn => fn(changes, "local")),
    getMarkup: () => elementsById["#rules"].innerHTML,
    getStoredData: () => storedData,
    setPromptValue: (value) => { promptValue = value; },
    setConfirmValue: (value) => { confirmValue = value; },
    confirmCalls
  };
}

for (const action of ["start", "cancel", "stop"]) {
  test(`${action} recording preserves existing mocks, saved flows, and replay selection`, () => {
    const existingFlow = { id: "existing", name: "Checkout", enabled: true, createdAt: 1, updatedAt: 2, steps: [{ id: "old-step", enabled: true, order: 0, matcher: { method: "GET", urlPattern: "https://api.example.com/cart" }, response: { status: 201, body: "original" } }] };
    const rules = [{ id: "manual", enabled: true, match: { method: "GET", urlPattern: "https://api.example.com/*" }, response: { enabled: true, status: 200, body: "manual" }, responses: [{ enabled: true, status: 200, body: "manual" }], defaultResponseIndex: 0 }];
    rules[0].request = { url: "", method: "", headers: "{}", body: "" };
    const ctx = buildOptionsContext({ enabled: true, rules, flows: [existingFlow], activeFlowId: "existing" });
    ctx.hooks.setView("flows");
    const snapshot = JSON.parse(JSON.stringify(ctx.getStoredData()));
    ctx.hooks.startRecordingFlow("Checkout", { type: "global" });
    if (action !== "start") {
      ctx.hooks.getState().recording.captured.push({ method: "GET", url: "https://api.example.com/new", status: 202, responseBody: "recorded" });
      if (action === "cancel") ctx.hooks.cancelRecordingFlow();
      else ctx.hooks.stopRecordingFlow();
    }
    const saved = JSON.parse(JSON.stringify(ctx.getStoredData()));
    assert.deepEqual(saved.rules, snapshot.rules);
    assert.deepEqual(saved.flows.find(flow => flow.id === "existing"), snapshot.flows[0]);
    assert.equal(saved.enabled, true);
    assert.equal(saved.activeFlowId, "existing");
    assert.equal(saved.flows.length, action === "stop" ? 2 : 1);
    if (action === "stop") {
      const added = saved.flows.find(flow => flow.id !== "existing");
      assert.equal(added.enabled, false);
      assert.equal(added.steps[0].response.body, "recorded");
      assert.equal(saved.recording, null);
    }
  });
}

test("flow editor opens Response first and switching tabs never writes saved data", () => {
  const ctx = buildOptionsContext({ flows: [{ id: "flow", name: "Saved", steps: [{ id: "step", matcher: { method: "GET", urlPattern: "*" }, response: { status: 200, body: "saved" } }] }] });
  ctx.hooks.setView("flows");
  const before = JSON.stringify(ctx.getStoredData());
  ctx.hooks.openFlowEditor("flow");
  const markup = ctx.getMarkup();
  assert.ok(markup.indexOf('data-flow-step-view="response"') < markup.indexOf('data-flow-step-view="request"'));
  assert.match(markup, /data-flow-step-view="response" role="tab" aria-selected="true"/);
  ctx.click("[data-flow-step-view]", { flowStepView: "request" });
  assert.match(ctx.getMarkup(), /data-flow-step-view="request" role="tab" aria-selected="true"/);
  assert.equal(JSON.stringify(ctx.getStoredData()), before);
});

test("Flow API-step search matches useful fields without mutating the flow", () => {
  const ctx = buildOptionsContext();
  const steps = [
    { matcher: { method: "GET", urlPattern: "https://api.example.com/users/1" }, request: { url: "https://api.example.com/users/1" }, response: { status: 200 } },
    { matcher: { method: "POST", urlPattern: "https://api.example.com/orders" }, pageContext: { pathname: "/flow/review" }, response: { status: 201 } }
  ];
  const snapshot = JSON.stringify(steps);
  const matching = query => steps.filter(step => ctx.hooks.flowStepMatchesSearch(step, query));
  assert.equal(matching("").length, 2);
  assert.deepEqual(matching(" USERS "), [steps[0]]);
  assert.deepEqual(matching("post"), [steps[1]]);
  assert.deepEqual(matching("/flow/review"), [steps[1]]);
  assert.deepEqual(matching("201"), [steps[1]]);
  assert.equal(matching("missing").length, 0);
  assert.equal(JSON.stringify(steps), snapshot);
});

test("cancel recording with no captured requests clears recording state and creates no flow", () => {
  const { hooks, getStoredData } = buildOptionsContext({ flows: [] });
  hooks.startRecordingFlow();
  assert.equal(hooks.getState().recording.active, true);
  hooks.cancelRecordingFlow();
  assert.equal(hooks.getState().recording, null);
  assert.deepEqual(hooks.getState().flows, []);
  assert.equal(getStoredData().recording, null);
  assert.deepEqual(getStoredData().flows, []);
});

test("cancel recording with captured requests discards them and creates no draft or flow", () => {
  const capturedSteps = [{ method: "GET", url: "https://api.example.com/one", status: 200, responseBody: "{}" }];
  const { hooks, getStoredData, confirmCalls } = buildOptionsContext({
    flows: [],
    recording: { active: true, name: "In progress", captured: capturedSteps, startedAt: Date.now(), flowId: "rec-1" }
  });
  assert.equal(hooks.getState().recording.captured.length, 1);
  hooks.cancelRecordingFlow();
  assert.equal(confirmCalls.length, 1, "should confirm before discarding captured requests");
  assert.equal(hooks.getState().recording, null);
  assert.deepEqual(hooks.getState().flows, [], "no draft or flow should be created from the discarded session");
  assert.equal(getStoredData().recording, null);
  assert.deepEqual(getStoredData().flows, []);
});

test("declining the confirmation keeps the recording session intact", () => {
  const capturedSteps = [{ method: "GET", url: "https://api.example.com/one", status: 200, responseBody: "{}" }];
  const { hooks, setConfirmValue } = buildOptionsContext({
    flows: [],
    recording: { active: true, name: "In progress", captured: capturedSteps, startedAt: Date.now(), flowId: "rec-1" }
  });
  setConfirmValue(false);
  hooks.cancelRecordingFlow();
  assert.equal(hooks.getState().recording.active, true, "recording should remain active if the user declines the confirmation");
  assert.equal(hooks.getState().recording.captured.length, 1);
});

test("cancel recording does not mutate an existing saved flow", () => {
  const existingFlow = { id: "flow-existing", name: "Checkout", enabled: true, createdAt: 1, updatedAt: 1, steps: [{ id: "s1", order: 0, enabled: true, matcher: { method: "GET", urlPattern: "https://api.example.com/checkout" }, response: { status: 200 } }] };
  const capturedSteps = [{ method: "GET", url: "https://api.example.com/other", status: 200, responseBody: "{}" }];
  const { hooks, getStoredData } = buildOptionsContext({
    flows: [existingFlow],
    recording: { active: true, name: "New session", captured: capturedSteps, startedAt: Date.now(), flowId: "rec-2" }
  });
  hooks.cancelRecordingFlow();
  assert.equal(hooks.getState().flows.length, 1);
  assert.equal(hooks.getState().flows[0].id, "flow-existing");
  assert.equal(hooks.getState().flows[0].steps.length, 1);
  assert.deepEqual(getStoredData().flows, hooks.getState().flows);
});

test("cancel then start a new recording begins a clean session", () => {
  const { hooks, setPromptValue } = buildOptionsContext({ flows: [] });
  setPromptValue("First attempt");
  hooks.startRecordingFlow();
  hooks.cancelRecordingFlow();
  assert.equal(hooks.getState().recording, null);
  setPromptValue("Second attempt");
  hooks.startRecordingFlow();
  assert.equal(hooks.getState().recording.active, true);
  assert.equal(hooks.getState().recording.name, "Second attempt");
  assert.equal(hooks.getState().recording.captured.length, 0);
});

test("Stop & Review still finalizes captured steps into a flow (unchanged behavior)", () => {
  const capturedSteps = [{ method: "GET", url: "https://api.example.com/one", status: 200, responseBody: "{}", headers: {}, responseHeaders: {} }];
  const { hooks, getStoredData } = buildOptionsContext({
    flows: [],
    recording: { active: true, name: "Checkout Flow", captured: capturedSteps, startedAt: Date.now(), flowId: "rec-3" }
  });
  hooks.stopRecordingFlow();
  assert.equal(hooks.getState().recording, null);
  assert.equal(hooks.getState().flows.length, 1);
  assert.equal(hooks.getState().flows[0].steps.length, 1);
  assert.equal(getStoredData().flows.length, 1);
});

test("Stop & Review with zero captured requests still creates an empty draft (unchanged behavior)", () => {
  const { hooks } = buildOptionsContext({
    flows: [],
    recording: { active: true, name: "Empty session", captured: [], startedAt: Date.now(), flowId: "rec-4" }
  });
  hooks.stopRecordingFlow();
  assert.equal(hooks.getState().recording, null);
  assert.equal(hooks.getState().flows.length, 1);
  assert.equal(hooks.getState().flows[0].steps.length, 0);
});

test("cancelling a recording leaves unrelated manual mocks and enabled flows untouched", () => {
  const existingFlow = { id: "flow-active", name: "Active Flow", enabled: true, createdAt: 1, updatedAt: 1, steps: [] };
  const manualRule = { id: "rule-1", enabled: true, match: { urlPattern: "https://api.example.com/*", method: "GET" }, request: { url: "", method: "", headers: "{}", body: "" }, responses: [{ enabled: true, status: 200, body: "{}" }], defaultResponseIndex: 0 };
  const { hooks, getStoredData } = buildOptionsContext({
    enabled: true,
    rules: [manualRule],
    flows: [existingFlow],
    activeFlowId: "flow-active",
    recording: { active: true, name: "New session", captured: [{ method: "GET", url: "https://x.test/y" }], startedAt: Date.now(), flowId: "rec-5" }
  });
  hooks.cancelRecordingFlow();
  assert.equal(hooks.getState().enabled, true);
  assert.equal(hooks.getState().flows.length, 1);
  assert.equal(hooks.getState().flows[0].enabled, true);
  assert.equal(hooks.getState().activeFlowId, "flow-active");
  assert.equal(getStoredData().rules.length, 1);
});

test("storage capture updates the live count and Stop & Review creates one flow", () => {
  const ctx = buildOptionsContext({ view: "flows", flows: [] });
  ctx.hooks.startRecordingFlow("Live", { type: "global" });
  const recording = { ...ctx.hooks.getState().recording, captured: [{ id: "one", method: "GET", url: "https://api.example.com/one", status: 200, responseBody: "{}" }] };
  ctx.emitStorage({ recording: { newValue: recording } });
  assert.match(ctx.getMarkup(), /1 request/);
  ctx.hooks.stopRecordingFlow();
  assert.equal(ctx.getStoredData().flows.length, 1);
  assert.equal(ctx.getStoredData().recording, null);
  assert.match(ctx.getMarkup(), /flow-editor-shell/);
});

for (const button of ["#record-new-flow", "#record-flow-empty"]) {
  test(`${button} opens recording setup without creating or activating a flow`, () => {
    const ctx = buildOptionsContext({ flows: [], activeFlowId: null });
    ctx.click(button);
    assert.equal(ctx.hooks.getState().recordSetup.open, true);
    assert.match(ctx.getMarkup(), /id="record-setup-start"/);
    assert.equal(ctx.getStoredData().flows.length, 0);
    assert.equal(ctx.getStoredData().activeFlowId, null);
    assert.equal(ctx.hooks.getState().recording, null);
  });
}

for (const mode of ["site", "page", "global"]) {
  test(`Start Recording button persists ${mode} scope, preserves existing flows, and shows banner after routing`, () => {
    const existing = { id: "existing", name: "New Flow", enabled: true, steps: [] };
    const ctx = buildOptionsContext({ flows: [existing], activeFlowId: "existing" });
    ctx.click("#record-new-flow");
    ctx.setInput("#record-setup-name", "Test Recording");
    ctx.setInput("#record-setup-domain", "https://myapp.example.com:443/accounts?query=ignored#hash");
    ctx.setInput("#record-setup-api-domain", "api.example.com");
    ctx.setInput("input[name='monitor-mode']:checked", mode);
    ctx.click("#record-setup-start");
    const saved = ctx.getStoredData();
    assert.equal(saved.recording.active, true);
    assert.equal(saved.recording.name, "Test Recording");
    assert.equal(saved.recording.captured.length, 0);
    assert.ok(saved.recording.startedAt > 0);
    const expectedScope = mode === "global" ? { type: mode } : { type: mode, origin: "https://myapp.example.com", ...(mode === "page" ? { pathname: "/accounts" } : {}) };
    assert.deepEqual(JSON.parse(JSON.stringify(saved.recording.monitorScope)), expectedScope);
    assert.equal(saved.recording.apiOrigin, "https://api.example.com");
    assert.deepEqual(saved.flows, [existing]);
    assert.equal(saved.activeFlowId, "existing");
    ctx.rerenderRoute();
    assert.equal(ctx.hooks.getState().recording.active, true);
    assert.match(ctx.getMarkup(), /recording-banner/);
    assert.match(ctx.getMarkup(), /0 requests/);
    assert.match(ctx.getMarkup(), /Stop &amp; Review|Stop & Review/);
    assert.equal(ctx.getHash(), "#/flows");
  });
}

test("starting recording from an existing editor clears the editor route and setup", () => {
  const ctx = buildOptionsContext({ flows: [{ id: "old", name: "Old", steps: [] }] });
  ctx.hooks.setView("flows");
  ctx.hooks.openFlowEditor("old");
  ctx.hooks.openRecordSetup();
  ctx.hooks.startRecordingFlow("Recording", { type: "global" });
  ctx.rerenderRoute();
  assert.equal(ctx.getHash(), "#/flows");
  assert.equal(ctx.hooks.getState().recordSetup, null);
  assert.match(ctx.getMarkup(), /recording-banner/);
  assert.equal(ctx.getStoredData().flows.length, 1);
});

for (const button of ["#new-flow-header", "#new-flow-empty"]) {
  test(`${button} creates a manual empty flow without starting recording`, () => {
    const ctx = buildOptionsContext({ flows: [] });
    ctx.click(button);
    const saved = ctx.getStoredData();
    assert.equal(saved.flows.length, 1);
    assert.equal(saved.flows[0].steps.length, 0);
    assert.equal(saved.flows[0].enabled, false);
    assert.equal(saved.recording, null);
    assert.match(ctx.getMarkup(), /flow-editor-shell/);
    assert.doesNotMatch(ctx.getMarkup(), /recording-banner/);
  });
}

const draftFixture = () => ({
  id: "draft-flow", name: "Saved flow", enabled: true, createdAt: 1, updatedAt: 1,
  steps: ["one", "two"].map((id, order) => ({ id, order, enabled: true,
    request: { method: "GET", url: "https://api.example.com/" + id, pathname: "/" + id, headers: {}, body: "" },
    matcher: { method: "GET", urlPattern: "https://api.example.com/" + id, matchQuery: true, matchBody: false },
    response: { status: 200, headers: {}, body: "old-" + id, contentType: "text/plain" }, delay: 0
  }))
});
function draftContext() {
  const ctx = buildOptionsContext({ flows: [draftFixture(), { ...draftFixture(), id: "other" }], activeFlowId: "draft-flow" });
  ctx.hooks.setView("flows"); ctx.hooks.openFlowEditor("draft-flow");
  return ctx;
}
const savedFlow = ctx => ctx.getStoredData().flows.find(flow => flow.id === "draft-flow");
function replaySaved(ctx, url, method) {
  const rules = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../rules.js", import.meta.url), "utf8"), rules);
  return rules.window.ApiMockRules.firstFlowMatch([savedFlow(ctx)], url, method);
}

test("URL, method and response edits stay out of saved state and live matcher until Save", () => {
  const ctx = draftContext(); const before = JSON.stringify(savedFlow(ctx));
  ctx.hooks.editFlowField("urlPattern", "https://api.example.com/new");
  ctx.hooks.editFlowField("method", "POST");
  ctx.hooks.editFlowField("responseBody", "new response");
  assert.equal(JSON.stringify(savedFlow(ctx)), before);
  assert.equal(JSON.stringify(ctx.hooks.getState().flows[0]), before);
  assert.equal(replaySaved(ctx, "https://api.example.com/one", "GET").response.body, "old-one");
  assert.equal(replaySaved(ctx, "https://api.example.com/new", "POST"), null);
  assert.equal(ctx.hooks.flowDraftDirty(), true);
  ctx.click("#save-flow");
  assert.equal(savedFlow(ctx).steps[0].matcher.method, "POST");
  assert.equal(replaySaved(ctx, "https://api.example.com/new", "POST").response.body, "new response");
  assert.equal(replaySaved(ctx, "https://api.example.com/one", "GET"), null);
  assert.equal(ctx.hooks.flowDraftDirty(), false);
});

for (const operation of ["add", "remove", "move", "toggle"]) {
  test(operation + " step stays draft-only, then commits on Save", () => {
    const ctx = draftContext(); const before = JSON.stringify(savedFlow(ctx));
    if (operation === "add") ctx.click("#add-flow-step");
    if (operation === "remove") ctx.click("[data-step-remove]", { stepRemove: "0" });
    if (operation === "move") ctx.click("[data-step-move]", { stepMove: "down" });
    if (operation === "toggle") ctx.click("[data-step-toggle]", { stepToggle: "0" }, false);
    assert.equal(JSON.stringify(savedFlow(ctx)), before);
    assert.equal(ctx.hooks.flowDraftDirty(), true);
    ctx.click("#save-flow");
    assert.notEqual(JSON.stringify(savedFlow(ctx)), before);
    assert.equal(ctx.hooks.flowDraftDirty(), false);
    if (operation === "add") assert.equal(savedFlow(ctx).steps.length, 3);
    if (operation === "remove") assert.equal(savedFlow(ctx).steps[0].id, "two");
    if (operation === "move") assert.deepEqual(Array.from(savedFlow(ctx).steps, step => [step.id, step.order]), [["two", 0], ["one", 1]]);
    if (operation === "toggle") assert.equal(savedFlow(ctx).steps[0].enabled, false);
  });
}

test("headers, body, status, delay and rename commit together after validation", () => {
  const ctx = draftContext(); const before = JSON.stringify(savedFlow(ctx));
  for (const [field, value] of Object.entries({ requestHeaders: '{"x-request":"draft"}', requestBody: "body", responseHeaders: '{"x-response":"draft"}', status: "201", delay: "10" })) ctx.hooks.editFlowField(field, value);
  ctx.setPromptValue("Renamed"); ctx.click("#rename-flow");
  assert.equal(JSON.stringify(savedFlow(ctx)), before);
  ctx.click("#save-flow");
  const flow = savedFlow(ctx); const step = flow.steps[0];
  assert.equal(flow.name, "Renamed"); assert.equal(step.request.body, "body");
  assert.equal(step.request.headers["x-request"], "draft"); assert.equal(step.response.headers["x-response"], "draft");
  assert.equal(step.response.status, 201); assert.equal(step.delay, 10);
});

for (const [field, value] of [["requestHeaders", "{"], ["responseHeaders", "[]"], ["status", "999"], ["delay", "-1"], ["method", ""], ["urlPattern", " "]]) {
  test("invalid " + field + " cannot replace saved replay configuration", () => {
    const ctx = draftContext(); const before = JSON.stringify(savedFlow(ctx));
    ctx.hooks.editFlowField(field, value); ctx.click("#save-flow");
    assert.equal(JSON.stringify(savedFlow(ctx)), before);
    assert.equal(ctx.hooks.flowDraftDirty(), true);
  });
}

test("Reset Changes restores a deep clone of saved configuration without a write", () => {
  const ctx = draftContext(); const before = JSON.stringify(savedFlow(ctx));
  ctx.hooks.editFlowField("responseBody", "draft"); ctx.click("#reset-flow");
  assert.equal(JSON.stringify(savedFlow(ctx)), before);
  assert.equal(ctx.hooks.getFlowDraft().steps[0].response.body, "old-one");
  assert.equal(ctx.hooks.flowDraftDirty(), false);
});

for (const navigation of ["back", "other", "mocks", "hash"]) {
  test("dirty navigation to " + navigation + " can keep editing or discard", () => {
    const ctx = draftContext(); const before = JSON.stringify(savedFlow(ctx));
    ctx.hooks.editFlowField("responseBody", "draft"); ctx.setConfirmValue(false);
    const navigate = () => {
      if (navigation === "back") ctx.click("#close-flow-editor");
      if (navigation === "other") ctx.hooks.openFlowEditor("other");
      if (navigation === "mocks") ctx.hooks.setView("mocks");
      if (navigation === "hash") ctx.setHash("#/mocks");
    };
    navigate();
    assert.equal(ctx.hooks.getState().flowEditorId, "draft-flow");
    assert.equal(ctx.hooks.flowDraftDirty(), true);
    assert.equal(ctx.getHash(), "#/flows/draft-flow");
    ctx.setConfirmValue(true); navigate();
    assert.notEqual(ctx.hooks.getState().flowEditorId, "draft-flow");
    assert.equal(ctx.hooks.flowDraftDirty(), false);
    assert.equal(JSON.stringify(savedFlow(ctx)), before);
    assert.equal(ctx.confirmCalls.length, 2);
  });
}

test("reload/close warns only for a dirty draft, and clean navigation does not warn", () => {
  const ctx = draftContext(); let prevented = false;
  const event = { preventDefault() { prevented = true; } };
  ctx.dispatchWindow("beforeunload", event); assert.equal(prevented, false);
  ctx.hooks.editFlowField("responseBody", "draft");
  ctx.dispatchWindow("beforeunload", event); assert.equal(prevented, true);
  ctx.hooks.editFlowField("responseBody", "old-one");
  assert.equal(ctx.hooks.flowDraftDirty(), false);
  ctx.hooks.closeFlowEditor(); assert.equal(ctx.confirmCalls.length, 0);
});

test("top-level activation persists immediately without leaking edits or being reversed by Save", () => {
  const ctx = draftContext(); ctx.hooks.editFlowField("responseBody", "draft");
  ctx.hooks.toggleFlow("draft-flow");
  assert.equal(savedFlow(ctx).enabled, false);
  assert.equal(savedFlow(ctx).steps[0].response.body, "old-one");
  ctx.click("#save-flow");
  assert.equal(savedFlow(ctx).enabled, false);
  assert.equal(savedFlow(ctx).steps[0].response.body, "draft");
});

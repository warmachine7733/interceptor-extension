import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const RULE = {
  enabled: true,
  match: { urlPattern: "https://api.example.com/*", method: "*" },
  request: { url: "", method: "", headers: "{}", body: "" },
  response: { enabled: true, status: 200, statusText: "OK", headers: '{"content-type":"application/json"}', body: '{"mocked":true}', delayMs: 0 }
};

test('disabled extension passes fetch through without constructing or reading a Request', async () => {
  const { sandbox, calls } = buildPageContext({ enabled: false, rules: [] });
  sandbox.Request = class { constructor() { throw new Error('Request must not be inspected'); } };
  assert.equal(await sandbox.fetch('/api/v2/sync/maindata'), 'NATIVE');
  assert.equal(calls.nativeFetch.length, 1);
});

test('recording on another site leaves disabled fetch completely untouched', async () => {
  const { sandbox, calls } = buildPageContext({ enabled: false, recording: { active: true, monitorScope: { type: 'site', origin: 'https://other.example' } } });
  sandbox.Request = class { constructor() { throw new Error('Unrelated page must not be inspected'); } };
  assert.equal(await sandbox.fetch('/api/v2/app/version'), 'NATIVE');
  assert.equal(calls.storageSets.length, 0);
});

for (const responseType of ['json', 'arraybuffer', 'blob']) {
  test(`recording native ${responseType} XHR does not access the throwing responseText getter`, async () => {
    const { sandbox, calls } = buildPageContext({ enabled: false, recording: { active: true, flowId: 'typed', captured: [], monitorScope: { type: 'global' } } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/sync');
    xhr.responseType = responseType;
    xhr.response = { connected: true };
    xhr.status = 200;
    Object.defineProperty(xhr, 'responseText', { get() { throw new Error('InvalidStateError'); } });
    xhr.send();
    assert.doesNotThrow(() => xhr.dispatchEvent(new sandbox.Event('loadend')));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.xhrSent, true);
    assert.equal(calls.storageSets.at(-1).recording.captured.length, 1);
  });
}

function buildPageContext(config, nativeFetchResult = "NATIVE", locationOverrides = {}) {
  // Existing interception scenarios explicitly opt in to their fixture API hosts.
  config = { watchedHosts: [new URL(locationOverrides.href || locationOverrides.origin || 'https://app.example.com').host], ...config };
  const listeners = {};
  const calls = { nativeFetch: [] };
  const toastElements = [];
  const makeToastElement = () => ({
    style: {}, children: [], textContent: "", id: "", isConnected: true,
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); if (child.id) toastElements.push(child); },
    addEventListener() {}, remove() { this.isConnected = false; }
  });
  const toastDocument = config.toastTest ? {
    documentElement: makeToastElement(), body: makeToastElement(),
    createElement: makeToastElement,
    querySelector(selector) { return selector === "#local-api-mock-flow-toasts" ? toastElements.find(element => element.id === "local-api-mock-flow-toasts") || null : null; }
  } : undefined;

  class FakeRequest {
    constructor(input, init = {}) {
      if (input instanceof FakeRequest) { this.url = input.url; this.method = input.method; this.headers = input.headers; this._body = input._body; Object.assign(this, init); if (init.body !== undefined) this._body = init.body; }
      else { this.url = String(input); this.method = (init.method || "GET").toUpperCase(); this.headers = new Map(Object.entries(init.headers || {})); this._body = init.body; }
    }
    clone() { return { text: async () => (this._body ?? "") }; }
  }
  class FakeResponse {
    constructor(body, init = {}) { this._body = body; this.status = init.status; this.statusText = init.statusText; this.headers = init.headers; }
    clone() { return new FakeResponse(this._body, { status: this.status, statusText: this.statusText, headers: this.headers }); }
    async text() { return this._body; }
    async json() { return JSON.parse(this._body); }
  }
  class FakeHeaders {
    constructor(init = {}) { this._m = new Map(typeof init === "object" && init !== null ? Object.entries(init) : []); }
    get(k) { return this._m.get(k.toLowerCase()) ?? null; }
    set(k, v) { this._m.set(k.toLowerCase(), String(v)); }
    has(k) { return this._m.has(k.toLowerCase()); }
    delete(k) { this._m.delete(k.toLowerCase()); }
    entries() { return this._m.entries(); }
    [Symbol.iterator]() { return this._m.entries(); }
  }

  const sandbox = {
    console, setTimeout, clearTimeout, URL, RegExp, JSON, Object, Number, String, Promise, Error, WeakMap, Set, Map, Array,
    Request: FakeRequest, Response: FakeResponse, Headers: FakeHeaders,
    Event: class { constructor(type) { this.type = type; } },
    location: { href: "https://app.example.com/", origin: "https://app.example.com", pathname: "/", ...locationOverrides, href: locationOverrides.href || `${locationOverrides.origin || 'https://app.example.com'}${locationOverrides.pathname || '/'}` },
    crypto: { randomUUID: () => `id-${Math.random().toString(36).slice(2)}` }, document: toastDocument
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__nativeFetchResult = nativeFetchResult;
  sandbox.fetch = async (input, init) => {
    calls.nativeFetch.push(input instanceof FakeRequest ? input.url : String(input));
    return nativeFetchResult;
  };
  sandbox.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  calls.storageSets = [];
  calls.storageDelays = [];
  let stored = { ...config };
  const storageListeners = [];
  let receiveMessage;
  const chrome = {
    action: { onClicked: { addListener() {} } },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { receiveMessage = fn; } },
      sendMessage(message, callback) { receiveMessage(message, { tab: { id: 1 }, url: sandbox.location.href }, callback); } },
    storage: {
      onChanged: { addListener(fn) { storageListeners.push(fn); } },
      local: {
        get(defaults, callback) { const result = { ...defaults, ...stored }; if (callback) callback(result); else return Promise.resolve(result); },
        async set(payload) {
          const delay = calls.storageDelays.shift() || 0;
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          stored = { ...stored, ...payload };
          calls.storageSets.push(payload);
          storageListeners.forEach(fn => fn({ recording: { newValue: stored.recording } }, 'local'));
        }
      }
    }
  };
  vm.runInNewContext(fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8'), { chrome, console, URL });
  const bridgeListeners = [];
  sandbox.postMessage = (data) => queueMicrotask(() => {
    (listeners.message || []).forEach(fn => fn({ source: sandbox.__vmWindow, data }));
    bridgeListeners.forEach(fn => fn({ source: bridgeWindow, data }));
  });
  const bridgeWindow = {
    ApiMockRules: { firstMatch() {}, normalizeHosts: values => values || [] }, postMessage: sandbox.postMessage,
    addEventListener(type, fn) { if (type === 'message') bridgeListeners.push(fn); }
  };
  vm.runInNewContext(fs.readFileSync(new URL('../bridge.js', import.meta.url), 'utf8'), {
    window: bridgeWindow, chrome, console, URL, location: sandbox.location,
    document: { querySelectorAll: () => [], documentElement: {} },
    MutationObserver: class { observe() {} disconnect() {} }
  });
  // No extension APIs in MAIN world: exercise the actual bridge and background writer.
  sandbox.__pushConfig = (nextConfig) => {
    stored = { ...stored, ...nextConfig };
    storageListeners.forEach(fn => fn({ recording: { newValue: stored.recording } }, 'local'));
    (listeners.message || []).forEach(fn => fn({ source: sandbox.__vmWindow, data: { source: 'local-api-mock', type: 'config', config: stored } }));
  };
  // minimal XHR stub
  class FakeXHR {
    constructor() { this._listeners = {}; }
    open(method, url) { this._method = method; this._url = url; calls.xhrOpen = { method, url }; }
    setRequestHeader(k, v) { (this._h = this._h || {})[k] = v; }
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
    dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn.call(this, ev)); if (this["on" + ev.type]) this["on" + ev.type](); return true; }
    send(body) { calls.xhrSent = true; }
  }
  sandbox.XMLHttpRequest = FakeXHR;
  vm.createContext(sandbox);

  // Load rules.js first, exactly like manifest.json's content_scripts ordering, so
  // page-interceptor.js resolves its matcher from the single canonical implementation.
  const rulesSrc = fs.readFileSync(new URL("../rules.js", import.meta.url), "utf8");
  vm.runInContext(rulesSrc, sandbox);
  const src = fs.readFileSync(new URL("../page-interceptor.js", import.meta.url), "utf8");
  vm.runInContext(src, sandbox);
  // Inside the vm, `window` resolves to the contextified global, which is not
  // reference-equal to `sandbox`; the interceptor checks `event.source === window`.
  sandbox.__vmWindow = vm.runInContext("window", sandbox);
  calls.flowToasts = () => toastElements.find(element => element.id === "local-api-mock-flow-toasts")?.children || [];
  calls.pageToastContainers = () => toastDocument?.body.children || [];
  return { sandbox, calls };
}

test("fetch is intercepted and mocked", async () => {
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [RULE] });
  await new Promise((r) => setTimeout(r, 0)); // flush get-config reply
  const res = await sandbox.fetch("https://api.example.com/users/1");
  assert.equal(calls.nativeFetch.length, 0, "native fetch should NOT be called");
  const body = await res.text();
  assert.equal(body, '{"mocked":true}');
});

test("Flow replay emits no per-request toasts while My Mocks keep their individual toasts", async () => {
  const flow = {
    id: "pc-auth", name: "PC Auth", enabled: true,
    steps: ["profile", "address", "preferences"].map((path, index) => ({ id: path, order: index, enabled: true, matcher: { method: "GET", urlPattern: `https://api.example.com/${path}` }, response: { status: 200, body: path } }))
  };
  const manual = { ...RULE, match: { method: "GET", urlPattern: "https://api.example.com/manual-*" } };
  const { sandbox, calls } = buildPageContext({ enabled: true, toastTest: true, rules: [manual], flows: [flow] });
  await new Promise(resolve => setTimeout(resolve, 0));
  for (const path of ["profile", "address", "preferences"]) await sandbox.fetch(`https://api.example.com/${path}`);
  await sandbox.fetch("https://api.example.com/manual-one");
  await sandbox.fetch("https://api.example.com/manual-two");
  await new Promise(resolve => setTimeout(resolve, 190));
  const flowToasts = calls.flowToasts();
  assert.equal(flowToasts.length, 0);
  const mockContainer = calls.pageToastContainers().find(container => container.id !== "local-api-mock-flow-toasts");
  assert.equal(mockContainer.children.length, 2, "My Mocks remain individual and are not absorbed by Flow aggregation");
  assert.equal(await (await sandbox.fetch("https://api.example.com/profile")).text(), "profile", "presentation does not affect replay responses");
  await new Promise(resolve => setTimeout(resolve, 190));
  assert.equal(calls.flowToasts().length, 0);
});

test("different Flows do not produce per-request snackbars", async () => {
  const makeFlow = (id, name) => ({ id, name, enabled: true, steps: [{ id: `${id}-step`, enabled: true, matcher: { method: "GET", urlPattern: `https://api.example.com/${id}` }, response: { status: 200, body: id } }] });
  const { sandbox, calls } = buildPageContext({ enabled: true, toastTest: true, rules: [], flows: [makeFlow("auth", "PC Auth"), makeFlow("checkout", "Checkout")] });
  await new Promise(resolve => setTimeout(resolve, 0));
  await sandbox.fetch("https://api.example.com/auth");
  await sandbox.fetch("https://api.example.com/checkout");
  await new Promise(resolve => setTimeout(resolve, 190));
  assert.deepEqual(Array.from(calls.flowToasts()), []);
});

test("fetch uses the published response variant by default", async () => {
  const rule = { ...RULE, response: undefined, responses: [
    { ...RULE.response, status: 201, body: '{"variant":1}' },
    { ...RULE.response, status: 500, body: '{"variant":2}' }
  ], defaultResponseIndex: 1 };
  const { sandbox } = buildPageContext({ enabled: true, rules: [rule] });
  await new Promise((r) => setTimeout(r, 0));
  const res = await sandbox.fetch("https://api.example.com/users/1");
  assert.equal(res.status, 500);
  assert.equal(await res.text(), '{"variant":2}');
});

test("fetch falls through when no rule matches", async () => {
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [RULE] });
  await new Promise((r) => setTimeout(r, 0));
  const res = await sandbox.fetch("https://other.example.com/data");
  assert.equal(calls.nativeFetch.length, 1, "native fetch SHOULD be called");
  assert.equal(res, "NATIVE");
});

test("fetch falls through when extension disabled", async () => {
  const { sandbox, calls } = buildPageContext({ enabled: false, rules: [RULE] });
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.example.com/users/1");
  assert.equal(calls.nativeFetch.length, 1);
});

test("an enabled Flow falls through when the global extension switch is disabled", async () => {
  const flow = {
    id: "flow-global-off",
    name: "Global gate",
    enabled: true,
    steps: [{ id: "step-1", enabled: true, matcher: { method: "GET", urlPattern: "https://api.example.com/flow-only" }, response: { status: 200, body: "flow response" } }]
  };
  const { sandbox, calls } = buildPageContext({ enabled: false, rules: [], flows: [flow] });
  await new Promise((r) => setTimeout(r, 0));
  const result = await sandbox.fetch("https://api.example.com/flow-only");
  assert.equal(result, "NATIVE");
  assert.equal(calls.nativeFetch.length, 1);
});

test("unchecked response passes through using request overrides", async () => {
  const rule = { ...RULE, request: { url: "https://api.example.com/rewritten", method: "POST", headers: "{}", body: '{"changed":true}' }, response: { ...RULE.response, enabled: false } };
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [rule] });
  await new Promise((r) => setTimeout(r, 0));
  const result = await sandbox.fetch("https://api.example.com/users/1");
  assert.equal(result, "NATIVE");
  assert.deepEqual(calls.nativeFetch, ["https://api.example.com/rewritten"]);
});

test("fetch matches rules and applies request overrides with leading/trailing whitespace", async () => {
  const rule = {
    ...RULE,
    match: { urlPattern: "  https://api.example.com/*  ", method: "  GET  " },
    request: { url: "  https://api.example.com/trimmed-rewrite  ", method: "  POST  ", headers: "{}", body: "" },
    response: { ...RULE.response, enabled: false }
  };
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [rule] });
  await new Promise((r) => setTimeout(r, 0));
  const result = await sandbox.fetch("https://api.example.com/users/1");
  assert.equal(result, "NATIVE");
  assert.deepEqual(calls.nativeFetch, ["https://api.example.com/trimmed-rewrite"]);
});

test("fetch handles whitespace-only request override url by falling back to original url", async () => {
  const rule = {
    ...RULE,
    request: { url: "   ", method: "POST", headers: "{}", body: "" },
    response: { ...RULE.response, enabled: false }
  };
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [rule] });
  await new Promise((r) => setTimeout(r, 0));
  const result = await sandbox.fetch("https://api.example.com/users/1");
  assert.equal(result, "NATIVE");
  assert.deepEqual(calls.nativeFetch, ["https://api.example.com/users/1"]);
});

test("XMLHttpRequest is intercepted and mocked", async () => {
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [RULE] });
  await new Promise((r) => setTimeout(r, 0));
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open("GET", "https://api.example.com/users/1");
  let loaded = null;
  xhr.onload = () => { loaded = xhr.responseText; };
  xhr.send();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.xhrSent, undefined, "native send should NOT be called");
  assert.equal(loaded, '{"mocked":true}');
  assert.equal(xhr.status, 200);
});

test("XMLHttpRequest intercepts rule with leading/trailing whitespace in pattern and override url", async () => {
  const rule = {
    ...RULE,
    match: { urlPattern: "  https://api.example.com/*  ", method: "  GET  " },
    request: { url: "  https://api.example.com/overridden-xhr  ", method: "  GET  ", headers: "{}", body: "" },
    response: { ...RULE.response, enabled: false }
  };
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [rule] });
  await new Promise((r) => setTimeout(r, 0));
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open("GET", "https://api.example.com/users/1");
  xhr.send();
  assert.equal(calls.xhrOpen.url, "https://api.example.com/overridden-xhr");
});

test("fetch replays repeated identical flow calls sequentially", async () => {
  const flow = {
    id: "flow-fetch-repeat",
    name: "Repeat",
    enabled: true,
    steps: [
      { id: "s1", matcher: { method: "GET", urlPattern: "https://api.example.com/step" }, response: { status: 200, body: '{"n":1}' } },
      { id: "s2", matcher: { method: "GET", urlPattern: "https://api.example.com/step" }, response: { status: 200, body: '{"n":2}' } }
    ]
  };
  const { sandbox } = buildPageContext({ enabled: true, rules: [], flows: [flow] });
  await new Promise((r) => setTimeout(r, 0));
  const first = await (await sandbox.fetch("https://api.example.com/step")).text();
  const second = await (await sandbox.fetch("https://api.example.com/step")).text();
  assert.equal(first, '{"n":1}');
  assert.equal(second, '{"n":2}');
});

test("fetch honors matchBody so different POST bodies replay different flow steps", async () => {
  const flow = {
    id: "flow-fetch-body",
    name: "Cart",
    enabled: true,
    steps: [
      { id: "p1", matcher: { method: "POST", urlPattern: "https://api.example.com/cart", matchBody: true }, request: { body: '{"item":"a"}' }, response: { status: 200, body: "added-a" } },
      { id: "p2", matcher: { method: "POST", urlPattern: "https://api.example.com/cart", matchBody: true }, request: { body: '{"item":"b"}' }, response: { status: 200, body: "added-b" } }
    ]
  };
  const { sandbox } = buildPageContext({ enabled: true, rules: [], flows: [flow] });
  await new Promise((r) => setTimeout(r, 0));
  const resA = await (await sandbox.fetch("https://api.example.com/cart", { method: "POST", body: '{"item":"a"}' })).text();
  const resB = await (await sandbox.fetch("https://api.example.com/cart", { method: "POST", body: '{"item":"b"}' })).text();
  assert.equal(resA, "added-a");
  assert.equal(resB, "added-b");
});

for (const transport of ["fetch", "XHR"]) {
  test(`${transport} recording preserves manual mock priority over an overlapping saved flow`, async () => {
    const flow = { id: "existing", enabled: true, steps: [{ id: "step", matcher: { method: "GET", urlPattern: "https://api.example.com/users/1" }, response: { status: 200, body: "flow-response" } }] };
    const { sandbox, calls } = buildPageContext({ enabled: true, rules: [RULE], flows: [flow], activeFlowId: flow.id, recording: { active: true, name: "New", flowId: "recording", captured: [], monitorScope: { type: "global" } } });
    await new Promise(resolve => setTimeout(resolve, 0));
    let body;
    if (transport === "fetch") {
      body = await (await sandbox.fetch("https://api.example.com/users/1")).text();
    } else {
      const xhr = new sandbox.XMLHttpRequest();
      xhr.open("GET", "https://api.example.com/users/1");
      xhr.send();
      await new Promise(resolve => setTimeout(resolve, 10));
      body = xhr.responseText;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(body, '{"mocked":true}');
    assert.equal(calls.nativeFetch.length, 0);
    assert.equal(Boolean(calls.xhrSent), false);
    const captured = calls.storageSets.at(-1).recording.captured;
    assert.equal(captured.length, 1);
    assert.equal(captured[0].responseBody, body);
  });
}

test("manual mocks take precedence over an enabled flow for the same URL", async () => {
  const flow = {
    id: "flow-precedence",
    enabled: true,
    steps: [{ id: "s1", matcher: { method: "GET", urlPattern: "https://api.example.com/users/1" }, response: { status: 200, body: '{"from":"flow"}' } }]
  };
  const { sandbox } = buildPageContext({ enabled: true, rules: [RULE], flows: [flow] });
  await new Promise((r) => setTimeout(r, 0));
  const res = await sandbox.fetch("https://api.example.com/users/1");
  assert.equal(await res.text(), '{"mocked":true}');
});

test("recording capture writes are serialized so an earlier write completing late cannot clobber a later one", async () => {
  const fakeResponse = { status: 200, headers: { get: () => null }, clone: () => ({ text: async () => "ok" }) };
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [], recording: { active: true, name: "Race", captured: [], startedAt: Date.now(), flowId: "flow-race" } }, fakeResponse);
  await new Promise((r) => setTimeout(r, 0));
  // First request's storage write will resolve slowly (100ms); second's resolves fast (0ms).
  calls.storageDelays.push(100, 0);
  await Promise.all([
    sandbox.fetch("https://api.example.com/one"),
    sandbox.fetch("https://api.example.com/two")
  ]);
  await new Promise((r) => setTimeout(r, 150));
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  assert.equal(lastWrite.recording.captured.length, 2, "final stored snapshot should contain both captured requests");
});

function xhrGet(sandbox, url) {
  return new Promise((resolve) => {
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open("GET", url);
    xhr.onload = () => resolve(xhr);
    xhr.send();
  });
}
function xhrSend(sandbox, method, url, body) {
  return new Promise((resolve) => {
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open(method, url);
    xhr.onload = () => resolve(xhr);
    xhr.send(body);
  });
}

test("XHR flow matchBody=true replays different responses for different POST bodies", async () => {
  const flow = {
    id: "flow-xhr-body",
    enabled: true,
    steps: [
      { id: "p1", matcher: { method: "POST", urlPattern: "https://api.example.com/cart", matchBody: true }, request: { body: '{"item":"a"}' }, response: { status: 200, body: "added-a" } },
      { id: "p2", matcher: { method: "POST", urlPattern: "https://api.example.com/cart", matchBody: true }, request: { body: '{"item":"b"}' }, response: { status: 200, body: "added-b" } }
    ]
  };
  const { sandbox } = buildPageContext({ enabled: true, rules: [], flows: [flow] });
  await new Promise((r) => setTimeout(r, 0));
  const xhrA = await xhrSend(sandbox, "POST", "https://api.example.com/cart", '{"item":"a"}');
  const xhrB = await xhrSend(sandbox, "POST", "https://api.example.com/cart", '{"item":"b"}');
  assert.equal(xhrA.responseText, "added-a");
  assert.equal(xhrB.responseText, "added-b");
});

test("XHR flow matchBody=false ignores body differences (default)", async () => {
  const flow = {
    id: "flow-xhr-body-off",
    enabled: true,
    steps: [{ id: "p1", matcher: { method: "POST", urlPattern: "https://api.example.com/cart" }, response: { status: 200, body: "ok" } }]
  };
  const { sandbox } = buildPageContext({ enabled: true, rules: [], flows: [flow] });
  await new Promise((r) => setTimeout(r, 0));
  const xhr = await xhrSend(sandbox, "POST", "https://api.example.com/cart", '{"whatever":true}');
  assert.equal(xhr.responseText, "ok");
});

test("XHR replays repeated identical flow calls sequentially exactly once per send()", async () => {
  const flow = {
    id: "flow-xhr-repeat",
    enabled: true,
    steps: [
      { id: "s1", matcher: { method: "GET", urlPattern: "https://api.example.com/step" }, response: { status: 200, body: "one" } },
      { id: "s2", matcher: { method: "GET", urlPattern: "https://api.example.com/step" }, response: { status: 200, body: "two" } },
      { id: "s3", matcher: { method: "GET", urlPattern: "https://api.example.com/step" }, response: { status: 200, body: "three" } }
    ]
  };
  const { sandbox } = buildPageContext({ enabled: true, rules: [], flows: [flow] });
  await new Promise((r) => setTimeout(r, 0));
  const first = await xhrGet(sandbox, "https://api.example.com/step");
  const second = await xhrGet(sandbox, "https://api.example.com/step");
  const third = await xhrGet(sandbox, "https://api.example.com/step");
  assert.equal(first.responseText, "one");
  assert.equal(second.responseText, "two");
  assert.equal(third.responseText, "three");
});

test("XHR ignores a disabled flow step", async () => {
  const flow = {
    id: "flow-xhr-disabled-step",
    enabled: true,
    steps: [{ id: "s1", enabled: false, matcher: { method: "GET", urlPattern: "https://api.example.com/disabled" }, response: { status: 200, body: "nope" } }]
  };
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [], flows: [flow] });
  await new Promise((r) => setTimeout(r, 0));
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open("GET", "https://api.example.com/disabled");
  xhr.send();
  assert.equal(calls.xhrSent, true, "native XHR send should be used since the only matching step is disabled");
});

test("disabling a flow immediately restores passthrough for subsequent requests", async () => {
  const flow = {
    id: "flow-disable-live",
    enabled: true,
    steps: [{ id: "s1", matcher: { method: "GET", urlPattern: "https://api.example.com/live" }, response: { status: 200, body: "mocked" } }]
  };
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [], flows: [flow] });
  await new Promise((r) => setTimeout(r, 0));
  const mocked = await (await sandbox.fetch("https://api.example.com/live")).text();
  assert.equal(mocked, "mocked");
  sandbox.__pushConfig({ enabled: true, rules: [], flows: [{ ...flow, enabled: false }] });
  const passthrough = await sandbox.fetch("https://api.example.com/live");
  assert.equal(calls.nativeFetch.length, 1, "native fetch should be used once the flow is disabled");
  assert.equal(passthrough, "NATIVE");
});

test("only the first enabled flow's matching step wins if multiple flows are ever enabled at once", () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(new URL("../rules.js", import.meta.url), "utf8"), context);
  const { firstFlowMatch } = context.window.ApiMockRules;
  const flowOne = { id: "flow-one", enabled: true, steps: [{ id: "a", matcher: { method: "GET", urlPattern: "https://api.example.com/shared" }, response: { body: "from-one" } }] };
  const flowTwo = { id: "flow-two", enabled: true, steps: [{ id: "b", matcher: { method: "GET", urlPattern: "https://api.example.com/shared" }, response: { body: "from-two" } }] };
  assert.equal(firstFlowMatch([flowOne, flowTwo], "https://api.example.com/shared", "GET").response.body, "from-one");
});

test("re-enabling a flow after disabling it resets replay progress instead of resuming stale steps", async () => {
  const flow = {
    id: "flow-reset",
    enabled: true,
    steps: [
      { id: "s1", matcher: { method: "GET", urlPattern: "https://api.example.com/step" }, response: { status: 200, body: "one" } },
      { id: "s2", matcher: { method: "GET", urlPattern: "https://api.example.com/step" }, response: { status: 200, body: "two" } }
    ]
  };
  const { sandbox } = buildPageContext({ enabled: true, rules: [], flows: [flow] });
  await new Promise((r) => setTimeout(r, 0));
  const first = await (await sandbox.fetch("https://api.example.com/step")).text();
  assert.equal(first, "one"); // advances the flow's internal replay counter
  sandbox.__pushConfig({ enabled: true, rules: [], flows: [{ ...flow, enabled: false }] }); // simulate disabling in options page
  sandbox.__pushConfig({ enabled: true, rules: [], flows: [{ ...flow, enabled: true }] }); // simulate re-enabling
  const afterReenable = await (await sandbox.fetch("https://api.example.com/step")).text();
  assert.equal(afterReenable, "one", "replay should restart from the first step after re-enabling, not resume from step 2");
});

test("recording captures the current page pathname alongside each request", async () => {
  const { sandbox, calls } = buildPageContext(
    { enabled: true, rules: [], recording: { active: true, name: "Journey", captured: [], startedAt: Date.now(), flowId: "rec-journey" } },
    { status: 200, headers: { get: () => null }, clone: () => ({ text: async () => "ok" }) },
    { pathname: "/login" }
  );
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.company.com/login");
  await new Promise((r) => setTimeout(r, 20)); // let the serialized storage-write queue drain
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  const captured = lastWrite.recording.captured[0];
  assert.equal(captured.pageContext.origin, "https://app.example.com");
  assert.equal(captured.pageContext.pathname, "/login");
});

test("a multi-route recording keeps a different pathname per captured request as the SPA navigates", async () => {
  const fakeResponse = { status: 200, headers: { get: () => null }, clone: () => ({ text: async () => "ok" }) };
  const { sandbox, calls } = buildPageContext(
    { enabled: true, rules: [], recording: { active: true, name: "Journey", captured: [], startedAt: Date.now(), flowId: "rec-journey" } },
    fakeResponse,
    { pathname: "/login" }
  );
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.company.com/login");
  // simulate an SPA route change (history.pushState) between requests
  sandbox.location.pathname = "/accounts";
  await sandbox.fetch("https://api.company.com/accounts");
  await new Promise((r) => setTimeout(r, 20)); // let the serialized storage-write queue drain
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  const pathnames = lastWrite.recording.captured.map((record) => record.pageContext.pathname);
  assert.deepEqual([...pathnames], ["/login", "/accounts"], "each captured request should retain the route active at the time it happened");
});

test("flow replay uses the current page location, not the page at recording time, for page-scoped steps", async () => {
  const flow = {
    id: "flow-spa",
    enabled: true,
    steps: [{ id: "s1", matcher: { method: "GET", urlPattern: "https://api.company.com/accounts" }, response: { status: 200, body: "accounts-ok" }, pageContext: { origin: "https://app.example.com", pathname: "/accounts" } }]
  };
  const { sandbox } = buildPageContext({ enabled: true, rules: [], flows: [flow] }, "NATIVE", { pathname: "/login" });
  await new Promise((r) => setTimeout(r, 0));
  // wrong route: still on /login, step requires /accounts
  const wrongRoute = await sandbox.fetch("https://api.company.com/accounts");
  assert.equal(wrongRoute, "NATIVE", "should not mock while on the wrong page");
  // SPA navigates to /accounts (no page reload) - the interceptor must pick this up live
  sandbox.location.pathname = "/accounts";
  const correctRoute = await (await sandbox.fetch("https://api.company.com/accounts")).text();
  assert.equal(correctRoute, "accounts-ok");
});

test("a manual mock matches regardless of the current app page/site (My Mocks are independent of page context)", async () => {
  const rule = { ...RULE, scope: { type: "site", origin: "https://other-app.com" } }; // a stray/leftover scope field must have zero effect
  const { sandbox } = buildPageContext({ enabled: true, rules: [rule] }, "NATIVE", { pathname: "/some/random/route" });
  await new Promise((r) => setTimeout(r, 0));
  const res = await sandbox.fetch("https://api.example.com/users/1");
  assert.equal(await res.text(), '{"mocked":true}', "manual mock must match no matter what the current page is");
});

test("switching the current page/site does not affect manual mock matching at all", async () => {
  const { sandbox: sandboxA } = buildPageContext({ enabled: true, rules: [RULE] }, "NATIVE", { origin: "https://app-a.com", pathname: "/a" });
  const { sandbox: sandboxB } = buildPageContext({ enabled: true, rules: [RULE] }, "NATIVE", { origin: "https://app-b.com", pathname: "/b" });
  await Promise.all([new Promise((r) => setTimeout(r, 0)), new Promise((r) => setTimeout(r, 0))]);
  const resA = await sandboxA.fetch("https://api.example.com/users/1");
  const resB = await sandboxB.fetch("https://api.example.com/users/1");
  assert.equal(await resA.text(), '{"mocked":true}');
  assert.equal(await resB.text(), '{"mocked":true}');
});

// --- Record Flow capture filter (recording only - never affects mocks/replay) ---

function recordingConfig(monitorScope) {
  return { enabled: true, rules: [], recording: { active: true, name: "Journey", captured: [], startedAt: Date.now(), flowId: "rec-filter", monitorScope } };
}
const fakeOkResponse = { status: 200, headers: { get: () => null }, clone: () => ({ text: async () => "ok" }) };

test("Current Site monitor captures same-origin requests across different routes", async () => {
  const { sandbox, calls } = buildPageContext(recordingConfig({ type: "site", origin: "https://app.company.com" }), fakeOkResponse, { origin: "https://app.company.com", pathname: "/login" });
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.company.com/login");
  sandbox.location.pathname = "/accounts";
  await sandbox.fetch("https://api.company.com/accounts");
  await new Promise((r) => setTimeout(r, 20));
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  assert.equal(lastWrite.recording.captured.length, 2, "both requests share the monitored origin, regardless of route");
});

test("Current Site monitor excludes requests happening on a different origin", async () => {
  const { sandbox, calls } = buildPageContext(recordingConfig({ type: "site", origin: "https://app.company.com" }), fakeOkResponse, { origin: "https://other-app.com", pathname: "/somewhere" });
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.company.com/data");
  await new Promise((r) => setTimeout(r, 20));
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  assert.equal(lastWrite?.recording?.captured?.length ?? 0, 0, "a request on a different origin must not be captured");
});

test("Current Page monitor captures only requests on the exact same origin+pathname", async () => {
  const { sandbox, calls } = buildPageContext(recordingConfig({ type: "page", origin: "https://app.company.com", pathname: "/collections" }), fakeOkResponse, { origin: "https://app.company.com", pathname: "/collections" });
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.company.com/collections");
  await new Promise((r) => setTimeout(r, 20));
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  assert.equal(lastWrite.recording.captured.length, 1);
});

test("Current Page monitor excludes requests once the user navigates to a different route", async () => {
  const { sandbox, calls } = buildPageContext(recordingConfig({ type: "page", origin: "https://app.company.com", pathname: "/collections" }), fakeOkResponse, { origin: "https://app.company.com", pathname: "/login" });
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.company.com/login-request");
  await new Promise((r) => setTimeout(r, 20));
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  assert.equal(lastWrite?.recording?.captured?.length ?? 0, 0, "requests outside the monitored page must not be captured");
});

test("Global monitor captures regardless of the current page", async () => {
  const { sandbox, calls } = buildPageContext(recordingConfig({ type: "global" }), fakeOkResponse, { origin: "https://anywhere.example", pathname: "/whatever" });
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.company.com/anything");
  await new Promise((r) => setTimeout(r, 20));
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  assert.equal(lastWrite.recording.captured.length, 1);
});

test("recording captures every API destination after the monitored page scope matches", async () => {
  const { sandbox, calls } = buildPageContext(recordingConfig({ type: "site", origin: "https://app.company.com" }), fakeOkResponse, { origin: "https://app.company.com", pathname: "/accounts" });
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.company.com/profile");
  await sandbox.fetch("https://api.company.com/orders?view=all#recent");
  await sandbox.fetch("https://api.company.com.evil.com/lookalike");
  await sandbox.fetch("https://api.company.com:8443/other-port");
  await sandbox.fetch("https://auth.company.com/token");
  await new Promise((r) => setTimeout(r, 30));
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  assert.deepEqual(Array.from(lastWrite.recording.captured, record => record.url), ["https://api.company.com/profile", "https://api.company.com/orders?view=all#recent", "https://api.company.com.evil.com/lookalike", "https://api.company.com:8443/other-port", "https://auth.company.com/token"]);
});

test("recording cannot capture an API from an unrelated app", async () => {
  const { sandbox, calls } = buildPageContext(recordingConfig({ type: "site", origin: "https://app.company.com" }), fakeOkResponse, { origin: "https://other-app.com", pathname: "/accounts" });
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.company.com/profile");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.storageSets.length, 0);
});

// --- Runtime pipeline: recording started via a LATE config update (the page was already
// loaded, mirroring "click Record Flow" while the target app tab is already open) ---

test("fetch is captured once recording is activated via a late config push (page already loaded before Start Recording)", async () => {
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [], flows: [], recording: null }, fakeOkResponse, { origin: "https://app.company.com", pathname: "/accounts" });
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.company.com/before-recording");
  assert.equal(calls.storageSets.length, 0, "nothing should be captured before recording is turned on");
  sandbox.__pushConfig({ enabled: true, rules: [], flows: [], recording: { active: true, name: "Live", captured: [], startedAt: Date.now(), flowId: "rec-live", monitorScope: { type: "site", origin: "https://app.company.com" } } });
  await sandbox.fetch("https://api.company.com/after-recording");
  await new Promise((r) => setTimeout(r, 20));
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  assert.equal(lastWrite.recording.captured.length, 1, "the request made after the late recording activation must be captured");
  assert.equal(lastWrite.recording.captured[0].url, "https://api.company.com/after-recording");
});

test("XHR is captured once recording is activated via a late config push (page already loaded before Start Recording)", async () => {
  const { sandbox, calls } = buildPageContext({ enabled: true, rules: [], flows: [], recording: null }, fakeOkResponse, { origin: "https://app.company.com", pathname: "/accounts" });
  await new Promise((r) => setTimeout(r, 0));
  sandbox.__pushConfig({ enabled: true, rules: [], flows: [], recording: { active: true, name: "Live", captured: [], startedAt: Date.now(), flowId: "rec-live-xhr", monitorScope: { type: "site", origin: "https://app.company.com" } } });
  const xhr = new sandbox.XMLHttpRequest();
  xhr.open("GET", "https://api.company.com/xhr-after-recording");
  xhr.send();
  xhr.dispatchEvent(new sandbox.Event("loadend")); // FakeXHR's send() doesn't auto-fire completion events
  await new Promise((r) => setTimeout(r, 20));
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  assert.equal(lastWrite.recording.captured.length, 1);
  assert.equal(lastWrite.recording.captured[0].url, "https://api.company.com/xhr-after-recording");
});

test("a recording session with no monitorScope (older/legacy session) captures everything, same as before this feature existed", async () => {
  const { sandbox, calls } = buildPageContext(recordingConfig(undefined), fakeOkResponse, { origin: "https://anywhere.example", pathname: "/whatever" });
  await new Promise((r) => setTimeout(r, 0));
  await sandbox.fetch("https://api.company.com/anything");
  await new Promise((r) => setTimeout(r, 20));
  const lastWrite = calls.storageSets[calls.storageSets.length - 1];
  assert.equal(lastWrite.recording.captured.length, 1);
});

test("a leftover monitorScope on an inactive recording object has no bearing on Flow replay", async () => {
  const flow = {
    id: "flow-untouched",
    enabled: true,
    steps: [{ id: "s1", matcher: { method: "GET", urlPattern: "https://api.example.com/legacy" }, response: { status: 200, body: "legacy-ok" }, pageContext: { origin: "https://app.company.com", pathname: "/somewhere-else" } }]
  };
  // recording is NOT active (inactive session with a stale monitorScope) - only the Flow's
  // own step pageContext (if any) should matter for replay, proving the two are independent.
  const { sandbox } = buildPageContext(
    { enabled: true, rules: [], flows: [flow], recording: { active: false, name: "Other", captured: [], monitorScope: { type: "page", origin: "https://app.company.com", pathname: "/only-here" } } },
    "NATIVE",
    { origin: "https://app.company.com", pathname: "/somewhere-else" }
  );
  await new Promise((r) => setTimeout(r, 0));
  const res = await (await sandbox.fetch("https://api.example.com/legacy")).text();
  assert.equal(res, "legacy-ok");
});


for (const enabled of [false, true]) {
  for (const recordingActive of [false, true]) {
    for (const transport of ["fetch", "XHR"]) {
      test(transport + " Active=" + enabled + " Recording=" + recordingActive + " keeps observation independent", async () => {
        const recording = recordingActive ? { active: true, name: "Matrix", flowId: "matrix", captured: [], monitorScope: { type: "global" } } : null;
        const nativeResponse = { status: 200, headers: new Headers({ "content-type": "text/plain" }), clone: () => ({ text: async () => "REAL" }) };
        const { sandbox, calls } = buildPageContext({ enabled, rules: [RULE], recording }, nativeResponse);
        await new Promise(resolve => setTimeout(resolve, 0));
        let body;
        if (transport === "fetch") {
          const response = await sandbox.fetch("https://api.example.com/users/1");
          body = enabled ? await response.text() : await response.clone().text();
          assert.equal(calls.nativeFetch.length, enabled ? 0 : 1);
        } else {
          const xhr = new sandbox.XMLHttpRequest();
          xhr.open("GET", "https://api.example.com/users/1");
          xhr.status = 200; xhr.responseText = "REAL";
          xhr.send();
          if (!enabled) xhr.dispatchEvent(new sandbox.Event("loadend"));
          await new Promise(resolve => setTimeout(resolve, 10));
          body = xhr.responseText;
          assert.equal(Boolean(calls.xhrSent), !enabled);
        }
        assert.equal(body, enabled ? '{"mocked":true}' : "REAL");
        await new Promise(resolve => setTimeout(resolve, 10));
        const records = calls.storageSets.at(-1)?.recording?.captured || [];
        assert.equal(records.length, recordingActive ? 1 : 0);
        if (recordingActive) assert.equal(records[0].responseBody, body);
      });
    }
  }
}

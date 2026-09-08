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

function buildPageContext(config, nativeFetchResult = "NATIVE") {
  const listeners = {};
  const calls = { nativeFetch: [] };

  class FakeRequest {
    constructor(input, init = {}) {
      if (input instanceof FakeRequest) { this.url = input.url; this.method = input.method; this.headers = input.headers; Object.assign(this, init); }
      else { this.url = String(input); this.method = (init.method || "GET").toUpperCase(); this.headers = new Map(Object.entries(init.headers || {})); }
    }
    clone() { return { text: async () => "" }; }
  }
  class FakeResponse {
    constructor(body, init = {}) { this._body = body; this.status = init.status; this.statusText = init.statusText; this.headers = init.headers; }
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
    console, setTimeout, URL, RegExp, JSON, Object, Number, String, Promise, Error, WeakMap, Set, Map, Array,
    Request: FakeRequest, Response: FakeResponse, Headers: FakeHeaders,
    location: { href: "https://app.example.com/" },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__nativeFetchResult = nativeFetchResult;
  sandbox.fetch = async (input, init) => {
    calls.nativeFetch.push(input instanceof FakeRequest ? input.url : String(input));
    return nativeFetchResult;
  };
  sandbox.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  sandbox.postMessage = (msg) => {
    // simulate bridge replying with config on get-config
    if (msg?.type === "get-config") {
      queueMicrotask(() => (listeners.message || []).forEach((fn) => fn({ source: sandbox, data: { source: "local-api-mock", type: "config", config } })));
    }
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

  const src = fs.readFileSync(new URL("../page-interceptor.js", import.meta.url), "utf8");
  vm.runInContext(src, sandbox);
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

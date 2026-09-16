import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

test("a slow older bridge storage read cannot overwrite a newer Flow config", () => {
  const reads = [];
  let onChanged;
  const posted = [];
  const window = {
    ApiMockRules: { firstMatch() {}, normalizeHosts: values => values || [] },
    addEventListener() {},
    postMessage(message) { posted.push(message); }
  };
  const chrome = {
    storage: {
      local: { get(_defaults, callback) { reads.push(callback); } },
      onChanged: { addListener(callback) { onChanged = callback; } }
    },
    runtime: { sendMessage() {} }
  };
  const document = { querySelectorAll: () => [], documentElement: {}, createElement() { return {}; } };
  vm.runInNewContext(fs.readFileSync(new URL("../bridge.js", import.meta.url), "utf8"), {
    window, chrome, document, location: { href: "https://app.example.com/" }, URL,
    MutationObserver: class { observe() {} disconnect() {} }, Node: { ELEMENT_NODE: 1 }, console
  });
  onChanged({ flows: { newValue: [] } }, "local");
  assert.equal(reads.length, 2);
  reads[1]({ enabled: true, watchedHosts: ["app.example.com"], rules: [], flows: [{ id: "live", enabled: true, steps: [] }] });
  reads[0]({ enabled: true, watchedHosts: ["app.example.com"], rules: [], flows: [{ id: "stale", enabled: false, steps: [] }] });
  assert.deepEqual(posted.map(message => message.config.flows[0].id), ["live"]);
});

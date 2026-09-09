import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const context = { window: {}, URL, crypto: { randomUUID: () => "test-id" } };
vm.runInNewContext(fs.readFileSync(new URL("../options-utils.js", import.meta.url), "utf8"), context);
const utils = context.window.ApiMockOptionsUtils;

test("names APIs from the first URL resource", () => {
  assert.equal(utils.nameFromUrl("https://api.example.com/user-profiles/1"), "User Profiles API");
  assert.equal(utils.nameFromUrl("https://api.example.com/"), "New API mock");
});

test("escapes HTML values", () => {
  assert.equal(utils.esc('<script a="b">&'), "&lt;script a=&quot;b&quot;&gt;&amp;");
});

test("writes nested object paths", () => {
  const target = { response: {} };
  utils.writePath(target, "response.status", 500);
  assert.deepEqual(target, { response: { status: 500 } });
});

test("parses relaxed pasted JSON", () => {
  assert.equal(JSON.stringify(utils.parsePastedJson("{status: 200, body: 'ok',}")), JSON.stringify({ status: 200, body: "ok" }));
});

test("normalizes legacy responses and bounds the default response", () => {
  const normalized = utils.normalizeRule({ response: { enabled: true, status: 200 }, defaultResponseIndex: 9 });
  assert.equal(normalized.responses.length, 1);
  assert.equal(normalized.responses[0].status, 200);
  assert.equal(normalized.defaultResponseIndex, 0);
  assert.equal(normalized.response, normalized.responses[0]);
});

test("normalizes a selected response variant", () => {
  const normalized = utils.normalizeRule({ responses: [{ status: 200 }, { status: 500 }], defaultResponseIndex: 1 });
  assert.equal(normalized.defaultResponseIndex, 1);
  assert.equal(normalized.responses[1].status, 500);
});
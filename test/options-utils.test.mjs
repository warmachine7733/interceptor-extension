import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const context = { window: {}, URL, crypto: { randomUUID: () => "test-id" } };
vm.runInNewContext(fs.readFileSync(new URL("../options-utils.js", import.meta.url), "utf8"), context);
const utils = context.window.ApiMockOptionsUtils;

test("names APIs from the first URL resource", () => {
  assert.equal(utils.nameFromUrl("https://api.example.com/user-profiles/1"), "User Profiles API");
  assert.equal(utils.nameFromUrl("  https://api.example.com/user-profiles/1  "), "User Profiles API");
  assert.equal(utils.nameFromUrl("https://api.example.com/"), "New API mock");
  assert.equal(utils.nameFromUrl("   "), "New API mock");
});

test("generates path preview and handles leading and trailing spaces", () => {
  assert.equal(utils.pathPreview("https://api.example.com/posts/1?test=*"), "/posts/1?test=preview");
  assert.equal(utils.pathPreview("  https://api.example.com/posts/1?test=*  "), "/posts/1?test=preview");
  assert.equal(utils.pathPreview("   "), "Any URL");
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

test("parses JS object literals with unquoted keys, single quotes, and template literals", () => {
  const input = `{
    title: 'Post Title',
    'single-quoted-key': 'It\\'s a test',
    templateString: \`Line 1
Line 2\`,
    count: 42,
    active: true,
    empty: null,
    items: ['first', 'second',],
  }`;
  const parsed = utils.parsePastedJson(input);
  assert.equal(parsed.title, "Post Title");
  assert.equal(parsed["single-quoted-key"], "It's a test");
  assert.equal(parsed.templateString, "Line 1\nLine 2");
  assert.equal(parsed.count, 42);
  assert.equal(parsed.active, true);
  assert.equal(parsed.empty, null);
  assert.deepEqual([...parsed.items], ["first", "second"]);
});

test("parses JS objects with comments and variable assignment / export wrappers", () => {
  const input1 = `// Mock API payload
  const config = {
    /* response status */
    status: 200,
    # hash comment
    message: 'Success',
  };`;
  assert.deepEqual(JSON.parse(JSON.stringify(utils.parsePastedJson(input1))), { status: 200, message: "Success" });

  const input2 = `export default {
    success: true,
    data: [{ id: 0x10, tag: 'admin' }],
  };`;
  assert.deepEqual(JSON.parse(JSON.stringify(utils.parsePastedJson(input2))), { success: true, data: [{ id: 16, tag: "admin" }] });

  const input3 = `return ({
    name: 'Sample',
    val: undefined,
  });`;
  assert.deepEqual(JSON.parse(JSON.stringify(utils.parsePastedJson(input3))), { name: "Sample", val: null });
});

test("parses JS objects containing methods, constructor calls, and hex/binary numbers", () => {
  const input = `{
    hexValue: 0xff,
    binValue: 0b101,
    octValue: 0o77,
    bigIntVal: 100n,
    decimalVal: .75,
    trailingDot: 5.,
    createdAt: new Date(),
    fn() { return true; },
    handler: (event) => { console.log(event); },
  }`;
  const parsed = utils.parsePastedJson(input);
  assert.equal(parsed.hexValue, 255);
  assert.equal(parsed.binValue, 5);
  assert.equal(parsed.octValue, 63);
  assert.equal(parsed.bigIntVal, 100);
  assert.equal(parsed.decimalVal, 0.75);
  assert.equal(parsed.trailingDot, 5);
  assert.equal(parsed.createdAt, null);
  assert.equal(parsed.handler, null);
});

test("formatJson formats JSON and JS objects into indented JSON string", () => {
  const jsObj = "const data = { id: 1, name: 'Alice', roles: ['admin',], };";
  const formatted = utils.formatJson(jsObj);
  assert.equal(formatted, JSON.stringify({ id: 1, name: "Alice", roles: ["admin"] }, null, 2));

  assert.equal(utils.formatJson(""), "");
  assert.equal(utils.formatJson("   "), "");
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

test("normalizes and trims whitespace in urlPattern, method, and request url", () => {
  const normalized = utils.normalizeRule({
    match: { urlPattern: "  https://api.example.com/users/*  ", method: "  GET  " },
    request: { url: "  https://api.example.com/v2/users  ", method: "  POST  " },
    response: { enabled: true, status: 200 }
  });
  assert.equal(normalized.match.urlPattern, "https://api.example.com/users/*");
  assert.equal(normalized.match.method, "GET");
  assert.equal(normalized.request.url, "https://api.example.com/v2/users");
  assert.equal(normalized.request.method, "POST");
});
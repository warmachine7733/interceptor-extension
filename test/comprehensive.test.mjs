import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

// Read and validate syntax of all scripts
const scripts = ["rules.js", "page-interceptor.js", "background.js", "bridge.js"];

test("All scripts have valid syntax", () => {
  for (const script of scripts) {
    const content = fs.readFileSync(new URL(`../${script}`, import.meta.url), "utf8");
    try {
      new vm.Script(content);
      console.log(`✓ ${script} syntax OK`);
    } catch (error) {
      throw new Error(`${script} has syntax error: ${error.message}`);
    }
  }
});

// Test rules.js functionality
const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../rules.js", import.meta.url), "utf8"), context);
const { firstMatch, parseHeaders, patternToRegex } = context.window.ApiMockRules;

test("URL pattern matching with wildcards", () => {
  const pattern = "https://api.example.com/users/*";
  const regex = patternToRegex(pattern);
  assert.ok(regex.test("https://api.example.com/users/42"));
  assert.ok(regex.test("https://api.example.com/users/abc/profile"));
  assert.ok(!regex.test("https://api.example.com/posts/42"));
  assert.ok(!regex.test("https://api.other.com/users/42"));
});

test("Headers parsing with various formats", () => {
  assert.deepEqual({ ...parseHeaders('{"x-test":"value"}') }, { "x-test": "value" });
  assert.deepEqual({ ...parseHeaders({ "x-test": "value" }) }, { "x-test": "value" });
  assert.deepEqual({ ...parseHeaders("invalid json") }, {});
  assert.deepEqual({ ...parseHeaders(null) }, {});
  assert.deepEqual({ ...parseHeaders(undefined) }, {});
  assert.deepEqual({ ...parseHeaders('{"null-header": null, "empty": ""}') }, { "null-header": null, "empty": "" });
});

test("Header case preservation", () => {
  const headers = '{"Content-Type":"application/json","X-Custom":"test"}';
  const parsed = parseHeaders(headers);
  assert.equal(parsed["Content-Type"], "application/json");
  assert.equal(parsed["X-Custom"], "test");
});

test("Rule matching respects enabled flag", () => {
  const enabledRule = { enabled: true, match: { urlPattern: "https://api.example.com/users/*", method: "GET" } };
  const disabledRule = { enabled: false, match: { urlPattern: "https://api.example.com/users/*", method: "GET" } };
  
  assert.equal(firstMatch([enabledRule], "https://api.example.com/users/42", "GET"), enabledRule);
  assert.equal(firstMatch([disabledRule], "https://api.example.com/users/42", "GET"), null);
});

test("Rule priority (first match wins)", () => {
  const rule1 = { enabled: true, match: { urlPattern: "https://api.example.com/*", method: "*" } };
  const rule2 = { enabled: true, match: { urlPattern: "https://api.example.com/users/*", method: "GET" } };
  
  // rule1 matches first, should be returned even though rule2 is more specific
  assert.equal(firstMatch([rule1, rule2], "https://api.example.com/users/42", "GET"), rule1);
  assert.equal(firstMatch([rule2, rule1], "https://api.example.com/users/42", "GET"), rule2);
});

test("Method matching is case-insensitive", () => {
  const rule = { enabled: true, match: { urlPattern: "https://api.example.com/*", method: "GET" } };
  
  assert.equal(firstMatch([rule], "https://api.example.com/users", "GET"), rule);
  assert.equal(firstMatch([rule], "https://api.example.com/users", "get"), rule);
  assert.equal(firstMatch([rule], "https://api.example.com/users", "Get"), rule);
});

test("Wildcard method matches all HTTP methods", () => {
  const rule = { enabled: true, match: { urlPattern: "https://api.example.com/*", method: "*" } };
  
  assert.equal(firstMatch([rule], "https://api.example.com/users", "GET"), rule);
  assert.equal(firstMatch([rule], "https://api.example.com/users", "POST"), rule);
  assert.equal(firstMatch([rule], "https://api.example.com/users", "PUT"), rule);
  assert.equal(firstMatch([rule], "https://api.example.com/users", "DELETE"), rule);
});

test("Unmatched rules fall through", () => {
  const rule = { enabled: true, match: { urlPattern: "https://api.example.com/users/*", method: "GET" } };
  
  assert.equal(firstMatch([rule], "https://api.example.com/posts/42", "GET"), null);
  assert.equal(firstMatch([rule], "https://api.example.com/users/42", "POST"), null);
});

console.log("\n✓ All tests passed!");

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../rules.js", import.meta.url), "utf8"), context);
const { firstMatch, parseHeaders } = context.window.ApiMockRules;
const rule = { enabled: true, match: { urlPattern: "https://api.example.com/users/*", method: "GET" } };

test("matches URL wildcards and methods", () => assert.equal(firstMatch([rule], "https://api.example.com/users/42", "GET"), rule));
test("matches stylesheet requests as GET requests", () => {
	const stylesheetRule = { enabled: true, match: { urlPattern: "https://cdn.example.com/styles/*", method: "GET" } };
	assert.equal(firstMatch([stylesheetRule], "https://cdn.example.com/styles/site.css", "GET"), stylesheetRule);
});
test("does not match a different method", () => assert.equal(firstMatch([rule], "https://api.example.com/users/42", "POST"), null));
test("skips disabled rules and honors priority", () => { const disabled = { ...rule, enabled: false }; assert.equal(firstMatch([disabled, rule], "https://api.example.com/users/42", "GET"), rule); });
test("parses valid headers and safely handles malformed headers", () => {
	assert.deepEqual({ ...parseHeaders('{"x-test":"yes"}') }, { "x-test": "yes" });
	assert.deepEqual({ ...parseHeaders("not json") }, {});
});

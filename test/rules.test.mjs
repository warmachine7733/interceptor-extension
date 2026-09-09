import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../rules.js", import.meta.url), "utf8"), context);
const { firstMatch, parseHeaders } = context.window.ApiMockRules;
const rule = { enabled: true, match: { urlPattern: "https://api.example.com/users/*", method: "GET" } };
const queryRule = { enabled: true, match: { urlPattern: "https://api.example.com/users?id=*", method: "*" } };
test("matches URL wildcards and methods", () => assert.equal(firstMatch([rule], "https://api.example.com/users/42", "GET"), rule));
test("matches stylesheet requests as GET requests", () => {
	const stylesheetRule = { enabled: true, match: { urlPattern: "https://cdn.example.com/styles/*", method: "GET" } };
	assert.equal(firstMatch([stylesheetRule], "https://cdn.example.com/styles/site.css", "GET"), stylesheetRule);
});
test("does not match a different method", () => assert.equal(firstMatch([rule], "https://api.example.com/users/42", "POST"), null));
test("matches URL patterns containing query params", () => {
	assert.equal(firstMatch([queryRule], "https://api.example.com/users?id=42", "GET"), queryRule);
	assert.equal(firstMatch([queryRule], "https://api.example.com/users", "GET"), null);
	const wildcardQueryRule = { ...rule, match: { ...rule.match, urlPattern: "https://api.example.com/users/*?active=*" } };
	assert.equal(firstMatch([wildcardQueryRule], "https://api.example.com/users/42?active=true", "GET"), wildcardQueryRule);
});
test("matches an exact path when the request adds a query string", () => {
	const pathRule = { enabled: true, match: { urlPattern: "https://jsonplaceholder.typicode.com/posts/1", method: "GET" } };
	assert.equal(firstMatch([pathRule], "https://jsonplaceholder.typicode.com/posts/1?test=1234", "GET"), null);
});
test("matches wildcard query patterns", () => {
	const pathRule = { enabled: true, match: { urlPattern: "https://jsonplaceholder.typicode.com/posts/*", method: "GET" } };
	const queryPathRule = { ...pathRule, match: { ...pathRule.match, urlPattern: "https://jsonplaceholder.typicode.com/posts/*?test=*" } };
	assert.equal(firstMatch([queryPathRule], "https://jsonplaceholder.typicode.com/posts/1?test=1234", "GET"), queryPathRule);
});
test("matches comma-separated query values", () => {
	const commaRule = { enabled: true, match: { urlPattern: "https://jsonplaceholder.typicode.com/posts/1?test=1234,123", method: "GET" } };
	assert.equal(firstMatch([commaRule], "https://jsonplaceholder.typicode.com/posts/1?test=1234,123", "GET"), commaRule);
	assert.equal(firstMatch([commaRule], "https://jsonplaceholder.typicode.com/posts/1?test=1234%2C123", "GET"), commaRule);
});
test("skips disabled rules and honors priority", () => { const disabled = { ...rule, enabled: false }; assert.equal(firstMatch([disabled, rule], "https://api.example.com/users/42", "GET"), rule); });
test("parses valid headers and safely handles malformed headers", () => {
	assert.deepEqual({ ...parseHeaders('{"x-test":"yes"}') }, { "x-test": "yes" });
	assert.deepEqual({ ...parseHeaders("not json") }, {});
});

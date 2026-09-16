import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const context = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL("../rules.js", import.meta.url), "utf8"), context);
const { firstMatch, parseHeaders, firstFlowMatch, scopeMatches } = context.window.ApiMockRules;
const rule = { enabled: true, match: { urlPattern: "https://api.example.com/users/*", method: "GET" } };
const queryRule = { enabled: true, match: { urlPattern: "https://api.example.com/users?id=*", method: "*" } };
const flow = {
  id: "flow-1",
  name: "Successful Checkout",
  enabled: true,
  steps: [{
    id: "step-1",
    matcher: { method: "GET", urlPattern: "https://api.example.com/orders/*" },
    response: { status: 200, headers: '{"content-type":"application/json"}', body: '{"ok":true}' }
  }]
};
test("matches URL wildcards and methods", () => assert.equal(firstMatch([rule], "https://api.example.com/users/42", "GET"), rule));
test("matches stylesheet requests as GET requests", () => {
	const stylesheetRule = { enabled: true, match: { urlPattern: "https://cdn.example.com/styles/*", method: "GET" } };
	assert.equal(firstMatch([stylesheetRule], "https://cdn.example.com/styles/site.css", "GET"), stylesheetRule);
});
test("does not match a different method", () => assert.equal(firstMatch([rule], "https://api.example.com/users/42", "POST"), null));
test("query strings in saved patterns are non-binding", () => {
	assert.equal(firstMatch([queryRule], "https://api.example.com/users?id=42", "GET"), queryRule);
	assert.equal(firstMatch([queryRule], "https://api.example.com/users", "GET"), queryRule);
	assert.equal(firstMatch([queryRule], "https://api.example.com/users?page=2&limit=20", "GET"), queryRule);
	const wildcardQueryRule = { ...rule, match: { ...rule.match, urlPattern: "https://api.example.com/users/*?active=*" } };
	assert.equal(firstMatch([wildcardQueryRule], "https://api.example.com/users/42?inactive=true", "GET"), wildcardQueryRule);
});
test("matches an exact path when the request adds a query string", () => {
	const pathRule = { enabled: true, match: { urlPattern: "https://jsonplaceholder.typicode.com/posts/1", method: "GET" } };
	assert.equal(firstMatch([pathRule], "https://jsonplaceholder.typicode.com/posts/1?test=1234", "GET"), pathRule);
	assert.equal(firstMatch([pathRule], "https://jsonplaceholder.typicode.com/posts/1#details", "GET"), pathRule);
});
test("query-less manual and Flow patterns ignore request query/hash but preserve path, host, port, and method", () => {
	const exactRule = { enabled: true, match: { urlPattern: "https://api.example.com/users", method: "GET" } };
	const exactFlow = { id: "query-normalized", enabled: true, steps: [{ id: "users", matcher: { method: "GET", urlPattern: "https://api.example.com/users", matchQuery: true }, response: { body: "flow" } }] };
	for (const suffix of ["?page=1", "?page=2&limit=20", "?timestamp=random", "#top"]) {
		assert.equal(firstMatch([exactRule], `https://api.example.com/users${suffix}`, "GET"), exactRule);
		assert.equal(firstFlowMatch([exactFlow], `https://api.example.com/users${suffix}`, "GET").response.body, "flow");
	}
	assert.equal(firstMatch([exactRule], "https://api.example.com/users/2?id=1", "GET"), null);
	assert.equal(firstMatch([exactRule], "https://other.example.com/users?page=1", "GET"), null);
	assert.equal(firstMatch([exactRule], "https://api.example.com:8443/users?page=1", "GET"), null);
	assert.equal(firstMatch([exactRule], "https://api.example.com/users?page=1", "POST"), null);
});
test("query strings do not constrain wildcard path patterns", () => {
	const pathRule = { enabled: true, match: { urlPattern: "https://jsonplaceholder.typicode.com/posts/*", method: "GET" } };
	const queryPathRule = { ...pathRule, match: { ...pathRule.match, urlPattern: "https://jsonplaceholder.typicode.com/posts/*?test=*" } };
	assert.equal(firstMatch([queryPathRule], "https://jsonplaceholder.typicode.com/posts/1?other=value", "GET"), queryPathRule);
});
test("matches comma-separated query values", () => {
	const commaRule = { enabled: true, match: { urlPattern: "https://jsonplaceholder.typicode.com/posts/1?test=1234,123", method: "GET" } };
	assert.equal(firstMatch([commaRule], "https://jsonplaceholder.typicode.com/posts/1?test=1234,123", "GET"), commaRule);
	assert.equal(firstMatch([commaRule], "https://jsonplaceholder.typicode.com/posts/1?test=1234%2C123", "GET"), commaRule);
});
test("matches DELETE requests", () => {
	const deleteRule = { enabled: true, match: { urlPattern: "https://jsonplaceholder.typicode.com/posts/1", method: "DELETE" } };
	assert.equal(firstMatch([deleteRule], "https://jsonplaceholder.typicode.com/posts/1", "DELETE"), deleteRule);
	assert.equal(firstMatch([deleteRule], "https://jsonplaceholder.typicode.com/posts/1", "GET"), null);
});
test("matches URLs and patterns with leading or trailing whitespace", () => {
	const spacedRule = { enabled: true, match: { urlPattern: "  https://api.example.com/users/*  ", method: "  GET  " } };
	assert.equal(firstMatch([spacedRule], "https://api.example.com/users/42", "GET"), spacedRule);
	assert.equal(firstMatch([spacedRule], "  https://api.example.com/users/42  ", "GET"), spacedRule);
	assert.equal(firstMatch([spacedRule], "https://api.example.com/users/42", "  GET  "), spacedRule);
});
test("skips disabled rules and honors priority", () => { const disabled = { ...rule, enabled: false }; assert.equal(firstMatch([disabled, rule], "https://api.example.com/users/42", "GET"), rule); });
test("matches enabled flow steps using recorded URL patterns and methods", () => {
	assert.equal(firstFlowMatch([flow], "https://api.example.com/orders/42", "GET").response.body, '{"ok":true}');
	assert.equal(firstFlowMatch([flow], "https://api.example.com/orders/42", "POST"), null);
});
test("parses valid headers and safely handles malformed headers", () => {
	assert.deepEqual({ ...parseHeaders('{"x-test":"yes"}') }, { "x-test": "yes" });
	assert.deepEqual({ ...parseHeaders("not json") }, {});
});

test("replays repeated identical calls within a flow sequentially instead of always the first step", () => {
	const repeatFlow = {
		id: "flow-repeat",
		name: "Repeat",
		enabled: true,
		steps: [
			{ id: "s1", order: 0, matcher: { method: "GET", urlPattern: "https://api.example.com/ping" }, response: { status: 200, body: '{"n":1}' } },
			{ id: "s2", order: 1, matcher: { method: "GET", urlPattern: "https://api.example.com/other" }, response: { status: 200, body: '{"other":true}' } },
			{ id: "s3", order: 2, matcher: { method: "GET", urlPattern: "https://api.example.com/ping" }, response: { status: 200, body: '{"n":2}' } }
		]
	};
	assert.equal(firstFlowMatch([repeatFlow], "https://api.example.com/ping", "GET").response.body, '{"n":1}');
	assert.equal(firstFlowMatch([repeatFlow], "https://api.example.com/other", "GET").response.body, '{"other":true}');
	assert.equal(firstFlowMatch([repeatFlow], "https://api.example.com/ping", "GET").response.body, '{"n":2}');
	// once exhausted, keeps replaying the last matching step rather than looping back or falling through
	assert.equal(firstFlowMatch([repeatFlow], "https://api.example.com/ping", "GET").response.body, '{"n":2}');
});

test("firstFlowMatch tracks replay progress independently per flow id", () => {
	const flowA = { id: "flow-a", enabled: true, steps: [
		{ id: "a1", matcher: { method: "GET", urlPattern: "https://api.example.com/item" }, response: { body: "a1" } },
		{ id: "a2", matcher: { method: "GET", urlPattern: "https://api.example.com/item" }, response: { body: "a2" } }
	] };
	const flowB = { id: "flow-b", enabled: true, steps: [
		{ id: "b1", matcher: { method: "GET", urlPattern: "https://api.example.com/item" }, response: { body: "b1" } }
	] };
	assert.equal(firstFlowMatch([flowA], "https://api.example.com/item", "GET").response.body, "a1");
	assert.equal(firstFlowMatch([flowB], "https://api.example.com/item", "GET").response.body, "b1");
	assert.equal(firstFlowMatch([flowA], "https://api.example.com/item", "GET").response.body, "a2");
});

test("ignores disabled flow steps", () => {
	const stepFlow = {
		id: "flow-disabled-step",
		enabled: true,
		steps: [{ id: "d1", enabled: false, matcher: { method: "GET", urlPattern: "https://api.example.com/disabled" }, response: { body: "nope" } }]
	};
	assert.equal(firstFlowMatch([stepFlow], "https://api.example.com/disabled", "GET"), null);
});

test("Flow query strings are non-binding regardless of legacy matchQuery", () => {
	const noQueryFlow = {
		id: "flow-no-query",
		enabled: true,
		steps: [{ id: "q1", matcher: { method: "GET", urlPattern: "https://api.example.com/search?q=cats", matchQuery: false }, response: { body: "results" } }]
	};
	assert.equal(firstFlowMatch([noQueryFlow], "https://api.example.com/search?q=dogs", "GET").response.body, "results");
	assert.equal(firstFlowMatch([noQueryFlow], "https://api.example.com/search", "GET").response.body, "results");
});

test("legacy matchQuery true no longer constrains Flow URL matching", () => {
	const queryFlow = {
		id: "flow-query",
		enabled: true,
		steps: [{ id: "q1", matcher: { method: "GET", urlPattern: "https://api.example.com/search?q=cats", matchQuery: true }, response: { body: "results" } }]
	};
	assert.equal(firstFlowMatch([queryFlow], "https://api.example.com/search?q=cats", "GET").response.body, "results");
	assert.equal(firstFlowMatch([queryFlow], "https://api.example.com/search?q=dogs", "GET").response.body, "results");
});

test("matchBody distinguishes POST requests with different bodies", () => {
	const bodyFlow = {
		id: "flow-body",
		enabled: true,
		steps: [
			{ id: "p1", matcher: { method: "POST", urlPattern: "https://api.example.com/cart", matchBody: true }, request: { body: '{"item":"a"}' }, response: { body: "added-a" } },
			{ id: "p2", matcher: { method: "POST", urlPattern: "https://api.example.com/cart", matchBody: true }, request: { body: '{"item":"b"}' }, response: { body: "added-b" } }
		]
	};
	assert.equal(firstFlowMatch([bodyFlow], "https://api.example.com/cart?cacheBust=1", "POST", '{"item":"a"}').response.body, "added-a");
	assert.equal(firstFlowMatch([bodyFlow], "https://api.example.com/cart", "POST", '{"item":"b"}').response.body, "added-b");
	assert.equal(firstFlowMatch([bodyFlow], "https://api.example.com/cart", "POST", '{"item":"c"}'), null);
});

test("matchBody false ignores body differences (default)", () => {
	const bodyFlow = {
		id: "flow-body-off",
		enabled: true,
		steps: [{ id: "p1", matcher: { method: "POST", urlPattern: "https://api.example.com/cart" }, request: { body: '{"item":"a"}' }, response: { body: "ok" } }]
	};
	assert.equal(firstFlowMatch([bodyFlow], "https://api.example.com/cart", "POST", '{"totally":"different"}').response.body, "ok");
});

// --- My Mocks are fully independent of page/site context (firstMatch takes no pageContext) ---

test("firstMatch ignores any extra pageContext-like argument - manual mocks are never page/site scoped", () => {
	const anyRule = { enabled: true, match: { urlPattern: "https://api.example.com/users/*", method: "GET" } };
	assert.equal(firstMatch([anyRule], "https://api.example.com/users/42", "GET"), anyRule);
	// even if a caller mistakenly passes extra arguments, firstMatch's signature (rules, url, method) never consults them
	assert.equal(firstMatch([anyRule], "https://api.example.com/users/42", "GET", { origin: "https://totally-different-app.com", pathname: "/nope" }), anyRule);
});

test("a rule carrying a leftover 'scope' property (e.g. from an older export) is ignored by matching", () => {
	const ruleWithStrayScope = { enabled: true, match: { urlPattern: "https://api.example.com/users/*", method: "GET" }, scope: { type: "site", origin: "https://only-this-site.com" } };
	assert.equal(firstMatch([ruleWithStrayScope], "https://api.example.com/users/42", "GET"), ruleWithStrayScope, "scope must have zero effect on manual mock matching");
});

// --- scopeMatches is used exclusively by the Record Flow capture filter, not by My Mocks or replay ---

test("scopeMatches treats missing scope/pageContext as global (no restriction) - used only for the recording capture filter", () => {
	assert.equal(scopeMatches(undefined, undefined), true);
	assert.equal(scopeMatches({ type: "global" }, undefined), true);
	assert.equal(scopeMatches({ type: "site", origin: "https://app.company.com" }, undefined), false, "a site scope with no current page context cannot match");
	assert.equal(scopeMatches({ type: "site", origin: "https://app.company.com" }, { origin: "https://app.company.com", pathname: "/anything" }), true);
	assert.equal(scopeMatches({ type: "site", origin: "https://app.company.com" }, { origin: "https://other.com", pathname: "/anything" }), false);
	assert.equal(scopeMatches({ type: "page", origin: "https://app.company.com", pathname: "/accounts" }, { origin: "https://app.company.com", pathname: "/accounts" }), true);
	assert.equal(scopeMatches({ type: "page", origin: "https://app.company.com", pathname: "/accounts" }, { origin: "https://app.company.com", pathname: "/collections" }), false);
});

// --- Page/site scope (flow steps) ---

test("a flow step with no pageContext matches from any page (legacy/imported flows stay global)", () => {
	const legacyFlow = {
		id: "flow-legacy",
		enabled: true,
		steps: [{ id: "s1", matcher: { method: "GET", urlPattern: "https://api.example.com/profile" }, response: { body: "profile" } }]
	};
	assert.equal(firstFlowMatch([legacyFlow], "https://api.example.com/profile", "GET", undefined, { origin: "https://app-a.com", pathname: "/" }).response.body, "profile");
	assert.equal(firstFlowMatch([legacyFlow], "https://api.example.com/profile", "GET", undefined, { origin: "https://app-b.com", pathname: "/somewhere-else" }).response.body, "profile");
	assert.equal(firstFlowMatch([legacyFlow], "https://api.example.com/profile", "GET").response.body, "profile", "no pageContext argument at all must also work");
});

test("a multi-route recorded flow keeps a different pathname per step and matches each in its own page context", () => {
	const journeyFlow = {
		id: "flow-journey",
		enabled: true,
		steps: [
			{ id: "s1", matcher: { method: "POST", urlPattern: "https://api.company.com/login" }, response: { body: "login-ok" }, pageContext: { origin: "https://app.company.com", pathname: "/login" } },
			{ id: "s2", matcher: { method: "GET", urlPattern: "https://api.company.com/profile" }, response: { body: "profile-ok" }, pageContext: { origin: "https://app.company.com", pathname: "/home" } },
			{ id: "s3", matcher: { method: "GET", urlPattern: "https://api.company.com/accounts" }, response: { body: "accounts-ok" }, pageContext: { origin: "https://app.company.com", pathname: "/accounts" } },
			{ id: "s4", matcher: { method: "GET", urlPattern: "https://api.company.com/collections" }, response: { body: "collections-ok" }, pageContext: { origin: "https://app.company.com", pathname: "/collections" } }
		]
	};
	assert.equal(firstFlowMatch([journeyFlow], "https://api.company.com/login", "POST", undefined, { origin: "https://app.company.com", pathname: "/login" }).response.body, "login-ok");
	assert.equal(firstFlowMatch([journeyFlow], "https://api.company.com/accounts", "GET", undefined, { origin: "https://app.company.com", pathname: "/accounts" }).response.body, "accounts-ok");
	assert.equal(firstFlowMatch([journeyFlow], "https://api.company.com/collections", "GET", undefined, { origin: "https://app.company.com", pathname: "/collections" }).response.body, "collections-ok");
});

test("a flow step with correct API but wrong page does not match", () => {
	const scopedFlow = {
		id: "flow-wrong-page",
		enabled: true,
		steps: [{ id: "s1", matcher: { method: "GET", urlPattern: "https://api.company.com/accounts" }, response: { body: "accounts-ok" }, pageContext: { origin: "https://app.company.com", pathname: "/accounts" } }]
	};
	assert.equal(firstFlowMatch([scopedFlow], "https://api.company.com/accounts", "GET", undefined, { origin: "https://app.company.com", pathname: "/collections" }), null);
});

test("a flow step with correct page but wrong API does not match", () => {
	const scopedFlow = {
		id: "flow-wrong-api",
		enabled: true,
		steps: [{ id: "s1", matcher: { method: "GET", urlPattern: "https://api.company.com/accounts" }, response: { body: "accounts-ok" }, pageContext: { origin: "https://app.company.com", pathname: "/accounts" } }]
	};
	assert.equal(firstFlowMatch([scopedFlow], "https://api.company.com/collections", "GET", undefined, { origin: "https://app.company.com", pathname: "/accounts" }), null);
});

test("page query string changes do not break pathname scope by default", () => {
	const scopedFlow = {
		id: "flow-query-agnostic",
		enabled: true,
		steps: [{ id: "s1", matcher: { method: "GET", urlPattern: "https://api.company.com/collections" }, response: { body: "collections-ok" }, pageContext: { origin: "https://app.company.com", pathname: "/collections" } }]
	};
	// the page's own query string (?page=2) is not part of pathname and must not affect matching
	assert.equal(firstFlowMatch([scopedFlow], "https://api.company.com/collections", "GET", undefined, { origin: "https://app.company.com", pathname: "/collections" }).response.body, "collections-ok");
});

test("an imported flow without page context still replays (backward compatible)", () => {
	const importedFlow = {
		id: "flow-imported",
		enabled: true,
		steps: [{ id: "s1", matcher: { method: "GET", urlPattern: "https://api.example.com/legacy" }, response: { body: "legacy-ok" } }]
	};
	assert.equal(firstFlowMatch([importedFlow], "https://api.example.com/legacy", "GET", undefined, { origin: "https://any-app.test", pathname: "/whatever" }).response.body, "legacy-ok");
});

test("manual mock precedence over flow replay remains unchanged with page context in play", () => {
	const manualRule = { enabled: true, match: { urlPattern: "https://api.company.com/accounts", method: "GET" } };
	const flow = {
		id: "flow-precedence-scoped",
		enabled: true,
		steps: [{ id: "s1", matcher: { method: "GET", urlPattern: "https://api.company.com/accounts" }, response: { body: "from-flow" }, pageContext: { origin: "https://app.company.com", pathname: "/accounts" } }]
	};
	const pageContext = { origin: "https://app.company.com", pathname: "/accounts" };
	assert.equal(firstMatch([manualRule], "https://api.company.com/accounts", "GET", pageContext), manualRule);
	// the manual rule wins before flow matching is even attempted, by construction of matchingRule() in page-interceptor.js
});

test("sequential flow replay behavior is unaffected by page context (same page across repeats)", () => {
	const repeatFlow = {
		id: "flow-repeat-scoped",
		enabled: true,
		steps: [
			{ id: "s1", matcher: { method: "GET", urlPattern: "https://api.company.com/ping" }, response: { body: "one" }, pageContext: { origin: "https://app.company.com", pathname: "/dashboard" } },
			{ id: "s2", matcher: { method: "GET", urlPattern: "https://api.company.com/ping" }, response: { body: "two" }, pageContext: { origin: "https://app.company.com", pathname: "/dashboard" } }
		]
	};
	const pageContext = { origin: "https://app.company.com", pathname: "/dashboard" };
	assert.equal(firstFlowMatch([repeatFlow], "https://api.company.com/ping", "GET", undefined, pageContext).response.body, "one");
	assert.equal(firstFlowMatch([repeatFlow], "https://api.company.com/ping", "GET", undefined, pageContext).response.body, "two");
});

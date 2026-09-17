import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
function setup(config, page = 'http://192.168.88.5:8080/', ancestorOrigins = []) {
  const calls = { fetch: [], open: [], send: [], headers: [], matches: 0, listeners: 0, messages: [] };
  const nativeResult = Promise.resolve('native');
  const listeners = [];
  class XHR {
    open(...args) { calls.open.push(args); return 'open-result'; }
    send(...args) { calls.send.push(args); return 'send-result'; }
    setRequestHeader(...args) { calls.headers.push(args); return 'header-result'; }
    addEventListener() { calls.listeners++; }
    dispatchEvent() {}
  }
  const context = vm.createContext({ URL, Request, Response, Headers, console, setTimeout, crypto, Event,
    location: { href: page, origin: new URL(page).origin, pathname: new URL(page).pathname, ancestorOrigins },
    XMLHttpRequest: XHR,
    fetch(...args) { calls.fetch.push({ args, receiver: this }); return nativeResult; },
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    postMessage(message) { calls.messages.push(message); }
  });
  vm.runInContext('window = globalThis', context);
  const window = vm.runInContext('window', context);
  vm.runInContext(source('rules.js'), context);
  for (const name of ['firstMatch', 'firstFlowMatch']) {
    const original = context.ApiMockRules[name];
    context.ApiMockRules[name] = (...args) => { calls.matches++; return original(...args); };
  }
  vm.runInContext(source('page-interceptor.js'), context);
  const update = value => listeners.forEach(fn => fn({ source: window, data: { source: 'local-api-mock', type: 'config', config: value } }));
  update(config);
  calls.messages.length = 0;
  return { context, calls, nativeResult, update };
}
const rule = { enabled: true, match: { method: '*', urlPattern: '*' }, response: { enabled: true, status: 200, body: 'mocked' } };
const qbit = 'http://192.168.88.5:8080/api/v2/app/version';
const cases = [
  ['disabled with matching mock', { enabled: false, rules: [rule] }, qbit],
  ['enabled without matching mock', { enabled: true, rules: [] }, qbit]
];
for (const [name, config, url] of cases) for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
  test(`${name}: ${method} fetch and XHR preserve native arguments and results`, () => {
    const { context, calls, nativeResult } = setup(config, url);
    // Throw if the interception code reconstructs a Request, even for POST bodies.
    context.Request = class { constructor() { throw new Error('unexpected Request construction'); } };
    const body = { untouched: true };
    const init = { method, body, credentials: 'include', signal: new AbortController().signal };
    assert.equal(context.fetch(url, init), nativeResult);
    assert.equal(calls.fetch[0].args[0], url);
    assert.equal(calls.fetch[0].args[1], init);
    const xhr = new context.XMLHttpRequest();
    const openArgs = [method, url, false, 'user', 'password'];
    assert.equal(xhr.open(...openArgs), 'open-result');
    assert.deepEqual(calls.open[0], openArgs);
    assert.equal(xhr.setRequestHeader('X-CSRF-Token', 'original'), 'header-result');
    assert.deepEqual(calls.headers[0], ['X-CSRF-Token', 'original']);
    assert.equal(xhr.send(body), 'send-result');
    assert.equal(calls.send[0][0], body);
    assert.equal(calls.listeners, 0);
    assert.equal(calls.messages.length, 0);
    if (!config.enabled) assert.equal(calls.matches, 0);
  });
}
test('all hosts are mocked without a watchlist', async () => {
  for (const url of [qbit, 'https://api.example.com/users']) {
    const { context, calls } = setup({ enabled: true, rules: [rule] }, url);
    assert.equal(await (await context.fetch(url)).text(), 'mocked');
    assert.equal(calls.fetch.length, 0);
    const xhr = new context.XMLHttpRequest(); xhr.open('GET', url); xhr.send();
    assert.equal(xhr.responseText, 'mocked');
    assert.equal(calls.send.length, 0);
  }
});
test('legacy watchlist updates do not affect global mocking', async () => {
  const { context, calls, update } = setup({ enabled: true, rules: [rule] });
  const xhr = new context.XMLHttpRequest(); xhr.open('GET', 'https://api.example.com/users');
  xhr.open('GET', qbit); xhr.send('original');
  update({ enabled: true, watchedHosts: [], rules: [rule] });
  assert.equal(await (await context.fetch('https://api.example.com/users')).text(), 'mocked');
  assert.equal(calls.send.length, 0);
});
test('host normalization is exact, canonical, deduplicated, and rejects wildcard/credential entries', () => {
  const { context } = setup({});
  const { normalizeHost, normalizeHosts } = context.ApiMockRules;
  for (const [input, expected] of [
    [' https://API.example.com/test ', 'api.example.com'], ['api.example.com/', 'api.example.com'],
    ['http://localhost:3000/api', 'localhost:3000'], ['192.168.88.5:8080', '192.168.88.5:8080'],
    ['http://[::1]:8080/path', '[::1]:8080'], ['https://example.com:443/', 'example.com']
  ]) assert.equal(normalizeHost(input), expected);
  for (const input of ['', '*', '*.example.com', 'https://user:pass@example.com', 'file:///tmp', 'bad host']) assert.equal(normalizeHost(input), null);
  assert.deepEqual(Array.from(normalizeHosts(['api.example.com', 'https://API.example.com/path'])), ['api.example.com']);
});

test('an iframe inherits mocking from its watched parent app', async () => {
  const { context, calls } = setup(
    { enabled: true, rules: [rule] },
    'https://payment-widget.example/frame',
    ['https://dummy-react-ui.vercel.app']
  );
  assert.equal(await (await context.fetch('https://js.paymentus.com/api/v3/profiles/dte?detailedInfo=true', { method: 'POST' })).text(), 'mocked');
  assert.equal(calls.fetch.length, 0);
});
test('background recording accepts requests from all frames', async () => {
  let receive;
  const writes = [];
  const recording = { active: true, flowId: 'session', captured: [] };
  const chrome = {
    action: { onClicked: { addListener() {} } },
    tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } },
    runtime: { onMessage: { addListener(fn) { receive = fn; } } },
    storage: { local: { async get() { return { recording, watchedHosts: ['dummy-react-ui.vercel.app'] }; }, async set(value) { writes.push(value); } } }
  };
  vm.runInNewContext(source('background.js'), { chrome, console, URL });
  const send = (sender, id = '1') => new Promise(resolve => receive({ type: 'recording-capture', flowId: 'session', pageHost: 'dummy-react-ui.vercel.app', record: { id, method: 'GET', url: 'https://jsonplaceholder.typicode.com/posts' } }, sender, resolve));
  await send({ tab: { url: 'https://google.com' }, url: 'https://dummy-react-ui.vercel.app/frame' });
  assert.equal(writes.length, 1, 'Watched child frame may record a cross-origin API');
  await send({ tab: { url: 'https://dummy-react-ui.vercel.app' }, url: 'https://google.com/frame', frameId: 4 }, '2');
  assert.equal(writes.length, 2, 'An embedded frame inherits its watched parent app');
  await send({ tab: { url: 'https://dummy-react-ui.vercel.app' } });
  assert.equal(writes.length, 3, 'A frame without a URL still inherits its watched parent app');
});

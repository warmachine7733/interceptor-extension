import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
function setup(config, page = 'http://192.168.88.5:8080/') {
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
    location: { href: page, origin: new URL(page).origin, pathname: new URL(page).pathname },
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
  ['empty watchlist', { enabled: true, watchedHosts: [], rules: [rule] }, qbit],
  ['missing watchlist migration', { enabled: true, rules: [rule] }, qbit],
  ['Google unwatched', { enabled: true, watchedHosts: ['api.example.com'], rules: [rule] }, 'https://google.com/'],
  ['qBittorrent unwatched', { enabled: true, watchedHosts: ['api.example.com'], rules: [rule] }, qbit],
  ['disabled with matching mock', { enabled: false, watchedHosts: ['192.168.88.5:8080'], rules: [rule] }, qbit],
  ['watched qBittorrent without mock', { enabled: true, watchedHosts: ['192.168.88.5:8080'], rules: [] }, qbit],
  ['watched API without mock', { enabled: true, watchedHosts: ['api.example.com'], rules: [] }, 'https://api.example.com/users'],
  ['port mismatch', { enabled: true, watchedHosts: ['192.168.88.5:8081'], rules: [rule] }, qbit],
  ['subdomain not implicitly watched', { enabled: true, watchedHosts: ['example.com'], rules: [rule] }, 'https://api.example.com/users'],
  ['recording cannot bypass watchlist', { enabled: true, watchedHosts: [], rules: [rule], recording: { active: true, monitorScope: { type: 'global' } } }, qbit]
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
    if (!config.enabled || !config.watchedHosts?.includes(new URL(url).host)) assert.equal(calls.matches, 0);
  });
}
test('watched exact private host and API host can still be mocked', async () => {
  for (const url of [qbit, 'https://api.example.com/users']) {
    const { context, calls } = setup({ enabled: true, watchedHosts: [new URL(url).host], rules: [rule] }, url);
    assert.equal(await (await context.fetch(url)).text(), 'mocked');
    assert.equal(calls.fetch.length, 0);
    const xhr = new context.XMLHttpRequest(); xhr.open('GET', url); xhr.send();
    assert.equal(xhr.responseText, 'mocked');
    assert.equal(calls.send.length, 0);
  }
});
test('removing a watched host restores pass-through and reused XHR loses previous metadata', () => {
  const { context, calls, update, nativeResult } = setup({ enabled: true, watchedHosts: ['api.example.com'], rules: [rule] });
  const xhr = new context.XMLHttpRequest(); xhr.open('GET', 'https://api.example.com/users');
  xhr.open('GET', qbit); xhr.send('original');
  assert.equal(calls.send[0][0], 'original');
  update({ enabled: true, watchedHosts: [], rules: [rule] });
  assert.equal(context.fetch('https://api.example.com/users'), nativeResult);
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

test('stylesheet bridge does not match unlisted hosts or accept page-supplied watchlists', () => {
  let matches = 0;
  let observed = 0;
  let listener;
  const link = { href: `${qbit}.css`, relList: { contains: () => true }, replaceWith() { throw new Error('Unwatched stylesheet replaced'); } };
  const window = { ApiMockRules: { normalizeHosts: values => values, firstMatch() { matches++; return rule; } }, postMessage() {}, addEventListener(type, fn) { listener = fn; } };
  const saved = { enabled: true, watchedHosts: [], rules: [rule] };
  let storageListener;
  vm.runInNewContext(source('bridge.js'), {
    window, URL, location: { href: qbit },
    document: { querySelectorAll: () => [link] },
    chrome: { storage: { local: { get(defaults, cb) { cb({ ...defaults, ...saved }); } }, onChanged: { addListener(fn) { storageListener = fn; } } } },
    MutationObserver: class { observe() { observed++; } disconnect() {} }
  });
  assert.equal(observed, 0);
  listener({ source: window, data: { source: 'local-api-mock', type: 'config', config: { enabled: true, watchedHosts: ['192.168.88.5:8080'], rules: [rule] } } });
  assert.equal(matches, 0);
  saved.watchedHosts = ['api.example.com'];
  storageListener({ watchedHosts: { newValue: saved.watchedHosts } }, 'local');
  assert.equal(matches, 0);
});

for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
  for (const api of ['https://jsonplaceholder.typicode.com/posts', 'https://api.otherdomain.com/users']) {
    test(`watched app scopes ${method} ${api} independently of API host`, async () => {
      const config = { enabled: true, watchedHosts: ['dummy-react-ui.vercel.app'], rules: [rule] };
      const watched = setup(config, 'https://dummy-react-ui.vercel.app/');
      const other = setup(config, 'https://google.com/');
      const init = { method, ...(method === 'GET' ? {} : { body: 'original' }) };
      assert.equal(await (await watched.context.fetch(api, init)).text(), 'mocked');
      assert.equal(watched.calls.fetch.length, 0);
      const xhr = new watched.context.XMLHttpRequest(); xhr.open(method, api); xhr.send(init.body);
      assert.equal(xhr.responseText, 'mocked');
      assert.equal(watched.calls.send.length, 0);
      assert.equal(other.context.fetch(api, init), other.nativeResult);
      const untouched = new other.context.XMLHttpRequest(); untouched.open(method, api); untouched.send(init.body);
      assert.equal(other.calls.send.length, 1);
      assert.equal(other.calls.matches, 0);
      assert.equal(other.calls.listeners, 0);
    });
  }
}
test('watching API host alone never opts an unrelated app into interception', () => {
  const { context, calls, nativeResult } = setup({ enabled: true, watchedHosts: ['jsonplaceholder.typicode.com'], rules: [rule] }, 'https://dummy-react-ui.vercel.app/');
  assert.equal(context.fetch('https://jsonplaceholder.typicode.com/posts'), nativeResult);
  assert.equal(calls.matches, 0);
});
test('unwatched app exits before reading or coercing any request URL', () => {
  const { context, nativeResult } = setup({ enabled: true, watchedHosts: ['dummy-react-ui.vercel.app'], rules: [rule] }, 'https://google.com/');
  const url = { toString() { throw new Error('request URL inspected'); } };
  assert.equal(context.fetch(url), nativeResult);
  assert.equal(new context.XMLHttpRequest().open('GET', url), 'open-result');
});

test('background recording validates the originating frame URL, not destination or claimed page host', async () => {
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
  const message = { type: 'recording-capture', flowId: 'session', pageHost: 'dummy-react-ui.vercel.app', record: { id: '1', method: 'GET', url: 'https://jsonplaceholder.typicode.com/posts' } };
  const send = sender => new Promise(resolve => receive(message, sender, resolve));
  await send({ tab: { url: 'https://google.com' }, url: 'https://dummy-react-ui.vercel.app/frame' });
  assert.equal(writes.length, 1, 'Watched child frame may record a cross-origin API');
  await send({ tab: { url: 'https://dummy-react-ui.vercel.app' }, url: 'https://google.com/frame' });
  await send({ tab: { url: 'https://dummy-react-ui.vercel.app' } });
  assert.equal(writes.length, 1, 'Unwatched or unidentified frame cannot use a watched parent or forged pageHost');
});

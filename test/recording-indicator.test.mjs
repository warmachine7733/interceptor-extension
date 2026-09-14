import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
function setup() {
  const listeners = {};
  let mounted = null;
  const location = { origin: 'https://app.example.com', pathname: '/profile' };
  const sandbox = {
    location, URL,
    history: Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (_state, _title, url) => { location.pathname = new URL(url, location.origin).pathname; }])),
    document: {
      documentElement: { appendChild(node) { mounted = node; } },
      addEventListener() {},
      createElement() {
        return { style: {}, remove() { mounted = null; }, attachShadow() {
          const nodes = { '.name': {}, '.count': {} };
          this.shadowRoot = { querySelector: selector => nodes[selector] };
          return this.shadowRoot;
        } };
      }
    },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    postMessage() {}
  };
  sandbox.window = sandbox; sandbox.top = sandbox;
  vm.createContext(sandbox);
  for (const file of ['rules.js', 'recording-indicator.js']) vm.runInContext(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), sandbox);
  const win = vm.runInContext('window', sandbox);
  return {
    sandbox, get: () => mounted,
    send(recording, enabled = false) { listeners.message.forEach(fn => fn({ source: win, data: { source: 'local-api-mock', type: 'config', config: { recording, enabled } } })); },
    pop(pathname) { location.pathname = pathname; listeners.popstate.forEach(fn => fn()); }
  };
}
const recording = (monitorScope) => ({ active: true, name: 'Customer journey', captured: [], monitorScope });
test('late recording config shows an isolated REC indicator with mocking off', () => {
  const ctx = setup(); assert.equal(ctx.get(), null);
  ctx.send(recording({ type: 'site', origin: 'https://app.example.com' }), false);
  assert.equal(ctx.get().id, 'local-api-mock-rec-indicator');
  assert.equal(ctx.get().shadowRoot.querySelector('.name').textContent, 'Customer journey');
  assert.match(ctx.get().style.cssText, /pointer-events:none!important/);
});
test('captured count updates on config messages and stop/cancel removes the indicator', () => {
  const ctx = setup(); const rec = recording({ type: 'global' }); ctx.send(rec);
  ctx.send({ ...rec, captured: [{}, {}] });
  assert.equal(ctx.get().shadowRoot.querySelector('.count').textContent, '2 captured');
  ctx.send(null); assert.equal(ctx.get(), null);
  ctx.send(rec); ctx.send({ ...rec, active: false }); assert.equal(ctx.get(), null);
});
test('site scope stays visible across SPA routes and rejects unrelated origin', () => {
  const ctx = setup(); ctx.send(recording({ type: 'site', origin: 'https://app.example.com' }));
  const node = ctx.get(); ctx.sandbox.history.pushState({}, '', '/address');
  assert.equal(ctx.get(), node);
  ctx.send(recording({ type: 'site', origin: 'https://other.example.com' }));
  assert.equal(ctx.get(), null);
});
test('exact page scope responds to pushState, replaceState and popstate, ignoring query/hash', () => {
  const ctx = setup(); ctx.send(recording({ type: 'page', origin: 'https://app.example.com', pathname: '/profile' }));
  ctx.sandbox.history.pushState({}, '', '/address'); assert.equal(ctx.get(), null);
  ctx.sandbox.history.replaceState({}, '', '/profile?query=1#hash'); assert.ok(ctx.get());
  ctx.pop('/address'); assert.equal(ctx.get(), null);
  ctx.pop('/profile'); assert.ok(ctx.get());
});
test('global recording ignores page origin and uses safe text for flow names', () => {
  const ctx = setup(); const rec = recording({ type: 'global' }); rec.name = '<img src=x onerror=alert(1)>';
  ctx.send(rec); assert.equal(ctx.get().shadowRoot.querySelector('.name').textContent, rec.name);
});

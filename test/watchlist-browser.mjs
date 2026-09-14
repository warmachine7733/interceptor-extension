// Real Chromium regression with a routed qBittorrent fixture; never contacts the LAN app.
import assert from 'node:assert/strict';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const origin = 'http://192.168.88.5:8080';
const host = '192.168.88.5:8080';
const context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
try {
  const requests = [];
  await context.route(`${origin}/**`, async route => {
    const request = route.request();
    if (request.url().includes('/api/')) {
      requests.push({ method: request.method(), body: request.postData(), csrf: request.headers()['x-csrf-token'] });
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"connected":true}' });
    } else await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>qBittorrent fixture</title><h1>Connected</h1>' });
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const rules = [{ id: 'existing', enabled: true, match: { method: '*', urlPattern: '*' }, response: { enabled: true, status: 201, body: 'mocked' } }];
  await worker.evaluate(rules => chrome.storage.local.set({ enabled: true, rules }), rules);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => window.addEventListener('message', event => {
    if (event.data?.source === 'local-api-mock' && event.data.type === 'config') window.testConfig = event.data.config;
  }));
  await page.goto(origin);
  await page.waitForFunction(() => window.testConfig);
  await worker.evaluate(rules => chrome.storage.local.set({ enabled: true, rules }), rules);
  await page.waitForFunction(() => window.testConfig?.enabled);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html`);
  assert.equal(await options.locator('#watched-list li').count(), 0, 'Existing mocks must not auto-enable a host');
  await options.locator('#watched-input').fill('*.example.com');
  await options.locator('#watched-form button').click();
  assert.match(await options.locator('#watched-error').innerText(), /without wildcards/);
  assert.equal(await options.locator('#watched-list li').count(), 0);
  await page.evaluate(() => {
    window.cloneReads = 0;
    const clone = Response.prototype.clone;
    Response.prototype.clone = function (...args) { window.cloneReads++; return clone.apply(this, args); };
  });
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const result = await page.evaluate(async method => {
      const init = { method, credentials: 'include', headers: { 'X-CSRF-Token': 'original' } };
      if (method !== 'GET') init.body = 'original-body';
      const fetched = await fetch('/api/v2/app/version', init);
      const xhr = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest(); request.open(method, '/api/v2/sync/maindata');
        request.responseType = 'json'; request.setRequestHeader('X-CSRF-Token', 'original');
        request.onload = () => resolve({ status: request.status, body: request.response });
        request.onerror = reject; request.send(method === 'GET' ? null : 'original-body');
      });
      return { status: fetched.status, body: await fetched.json(), xhr, clones: window.cloneReads };
    }, method);
    assert.deepEqual(result, { status: 200, body: { connected: true }, xhr: { status: 200, body: { connected: true } }, clones: 0 });
  }
  assert.equal(requests.length, 10);
  assert.ok(requests.every(request => request.csrf === 'original'));
  assert.ok(requests.filter(request => request.method !== 'GET').every(request => request.body === 'original-body'));
  console.log('PASS unwatched qBittorrent fixture: fetch/XHR across five methods, original CSRF/body/status, zero response clones');
  await options.locator('#watched-input').fill(` ${origin}/api/test `);
  await options.locator('#watched-form button').click();
  await page.waitForFunction(host => window.testConfig?.watchedHosts?.includes(host), host);
  assert.equal(await options.locator('#watched-list code').innerText(), host);
  await options.locator('#watched-input').fill(`${host}/`);
  await options.locator('#watched-form button').click();
  assert.equal(await options.locator('#watched-list li').count(), 1);
  assert.equal(await page.evaluate(async () => (await fetch('/api/v2/app/version')).text()), 'mocked');
  assert.equal(requests.length, 10, 'Explicit opt-in now permits matching mock');
  await options.reload();
  await options.locator('#watched-list code').waitFor();
  assert.equal(await options.locator('#watched-list code').innerText(), host);
  await options.getByRole('button', { name: `Remove ${host}`, exact: true }).click();
  await page.waitForFunction(() => window.testConfig?.watchedHosts?.length === 0);
  assert.equal(await page.evaluate(async () => (await fetch('/api/v2/app/version')).status), 200);
  assert.deepEqual((await worker.evaluate(() => chrome.storage.local.get('rules'))).rules, rules);
  assert.deepEqual(errors, []);
  console.log('PASS watchlist normalization, deduplication, persistence, opt-in matching, removal, and existing mock preservation');
  const appOrigin = 'https://dummy-react-ui.vercel.app';
  const otherOrigin = 'https://google.com';
  const api = 'https://jsonplaceholder.typicode.com/posts';
  for (const site of [appOrigin, otherOrigin]) await context.route(site + '/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>App fixture</title>' }));
  await context.route('https://jsonplaceholder.typicode.com/**', route => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'real-api' }));
  await options.locator('#watched-input').fill(appOrigin);
  await options.locator('#watched-form button').click();
  const openApp = async site => {
    const tab = await context.newPage();
    await tab.addInitScript(() => window.addEventListener('message', e => { if (e.data?.source === 'local-api-mock' && e.data.type === 'config') window.testConfig = e.data.config; }));
    await tab.goto(site);
    await tab.waitForFunction(() => window.testConfig?.watchedHosts?.includes('dummy-react-ui.vercel.app'));
    return tab;
  };
  const watchedApp = await openApp(appOrigin);
  const unrelatedApp = await openApp(otherOrigin);
  const requestBoth = target => target.evaluate(async api => {
    const fetched = await (await fetch(api)).text();
    const xhr = await new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(); x.open('GET', api); x.onload = () => resolve(x.responseText); x.onerror = reject; x.send();
    });
    return [fetched, xhr];
  }, api);
  assert.deepEqual(await requestBoth(watchedApp), ['mocked', 'mocked']);
  assert.deepEqual(await requestBoth(unrelatedApp), ['real-api', 'real-api']);
  const child = async (parent, site) => {
    await parent.evaluate(site => new Promise(resolve => { const frame = document.createElement('iframe'); frame.src = site + '/child'; frame.onload = resolve; document.body.appendChild(frame); }), site);
    const frame = parent.frames().find(frame => frame.url() === site + '/child');
    await frame.waitForFunction(() => window.testConfig?.watchedHosts?.includes('dummy-react-ui.vercel.app'));
    return frame;
  };
  assert.deepEqual(await requestBoth(await child(watchedApp, otherOrigin)), ['real-api', 'real-api']);
  assert.deepEqual(await requestBoth(await child(unrelatedApp, appOrigin)), ['mocked', 'mocked']);
  console.log('PASS watched app cross-origin fetch/XHR; same API in unwatched tab stays real; iframe host isolation in both directions');
} finally { await context.close(); }

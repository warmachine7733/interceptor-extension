// Run like recording-browser.mjs with PLAYWRIGHT_MODULE and PLAYWRIGHT_BROWSERS_PATH.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', req.url.startsWith('/api') ? 'text/plain' : 'text/html');
  res.end(req.url.startsWith('/api') ? 'network' : '<!doctype html><title>Draft fixture</title><h1>App</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const root = path.resolve(import.meta.dirname, '..');
let context;
try {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const flow = {
    id: 'saved-flow', name: 'Saved flow', enabled: true, createdAt: 1, updatedAt: 1,
    steps: ['one', 'two'].map((id, order) => ({
      id, order, enabled: true,
      matcher: { method: 'GET', urlPattern: `${origin}/api/${id}`, matchQuery: true, matchBody: false },
      request: { method: 'GET', url: `${origin}/api/${id}`, pathname: `/api/${id}`, headers: {}, body: '' },
      response: { status: 200, headers: { 'content-type': 'text/plain' }, body: `saved-${id}` }, delay: 0
    }))
  };
  const app = await context.newPage();
  const errors = [];
  app.on('pageerror', error => errors.push(error.message));
  await app.addInitScript(() => window.addEventListener('message', event => {
    if (event.source === window && event.data?.source === 'local-api-mock' && event.data.type === 'config') window.__draftTestConfig = event.data.config;
  }));
  await app.goto(origin);
  await worker.evaluate(flow => chrome.storage.local.set({ enabled: true, watchedHosts: [new URL(flow.steps[0].matcher.urlPattern).host], flows: [flow], activeFlowId: flow.id, rules: [] }), flow);
  const options = await context.newPage();
  options.on('pageerror', error => errors.push(error.message));
  await options.goto(`chrome-extension://${new URL(worker.url()).host}/options.html#/flows/saved-flow`);
  await options.locator('#watched-input').fill(origin);
  await options.locator('#watched-form button').click();
  await app.waitForFunction(host => window.__draftTestConfig?.watchedHosts?.includes(host), new URL(origin).host);
  if (!await options.locator('#enabled').isChecked()) {
    await options.locator('label.switch').click();
  }
  assert.equal(await options.locator('#enabled').isChecked(), true);
  await app.waitForFunction(() => window.__draftTestConfig?.enabled && window.__draftTestConfig?.flows?.[0]?.id === 'saved-flow');
  const field = name => options.locator(`[data-step-field="${name}"]`);
  const stored = async () => (await worker.evaluate(() => chrome.storage.local.get('flows'))).flows[0];
  const request = (pathname, method = 'GET') => app.evaluate(async ({ url, method }) => (await fetch(url, { method })).text(), { url: origin + pathname, method });
  assert.equal(await request('/api/one'), 'saved-one');
  await options.locator('[data-flow-step-view="request"]').click();
  await field('method').selectOption('POST');
  await field('urlPattern').fill(`${origin}/api/new`);
  await options.locator('[data-flow-step-view="response"]').click();
  await field('responseBody').fill('draft-response');
  assert.equal(await options.locator('#flow-unsaved').isVisible(), true);
  assert.equal(await options.locator('#save-flow').isEnabled(), true);
  assert.deepEqual(await stored(), flow);
  assert.equal(await request('/api/one'), 'saved-one');
  assert.equal(await request('/api/new', 'POST'), 'network');
  console.log('Before Save: persisted GET URL and response unchanged; live requests use saved response');

  options.once('dialog', dialog => dialog.dismiss());
  await options.locator('#close-flow-editor').click();
  assert.equal(await options.locator('#flow-unsaved').isVisible(), true);
  assert.match(options.url(), /saved-flow$/);
  options.once('dialog', dialog => dialog.dismiss());
  await options.locator('[data-view="mocks"]').click();
  assert.match(options.url(), /saved-flow$/);

  await options.locator('#save-flow').click();
  await options.waitForFunction(() => document.querySelector('#flow-unsaved')?.hidden);
  assert.equal((await stored()).steps[0].matcher.method, 'POST');
  assert.equal(await request('/api/new', 'POST'), 'draft-response');
  assert.equal(await request('/api/one'), 'network');
  console.log('After Save: live POST request uses new URL and response; dirty state cleared');

  const saved = await stored();
  await options.locator('[data-step-move="down"]').click();
  assert.deepEqual(await stored(), saved);
  await options.locator('[data-step-remove="1"]').click();
  assert.deepEqual(await stored(), saved);
  await options.locator('#add-flow-step').click();
  assert.deepEqual(await stored(), saved);
  options.once('dialog', dialog => dialog.accept());
  await options.locator('#reset-flow').click();
  assert.equal(await options.locator('#flow-unsaved').isVisible(), false);
  assert.deepEqual(await stored(), saved);

  // Checkbox is nested in the step selector: changing it must toggle the draft,
  // rather than being swallowed by the row's selection handler.
  await options.locator('[data-step-toggle="0"]').uncheck();
  assert.equal(await options.locator('#flow-unsaved').isVisible(), true);
  assert.deepEqual(await stored(), saved);
  options.once('dialog', dialog => dialog.accept());
  await options.locator('#close-flow-editor').click();
  await options.waitForFunction(() => !document.querySelector('.flow-editor-shell'));
  assert.deepEqual(await stored(), saved);
  await options.locator('[data-flow-action="toggle"]').click();
  assert.equal((await stored()).enabled, false);
  assert.equal(await request('/api/new', 'POST'), 'network');
  assert.deepEqual(errors, []);
  console.log('Draft operations, reset, navigation warnings and immediate top-level disable passed');
  console.log(`PASS: Chrome for Testing ${context.browser().version()}`);
} finally {
  await context?.close();
  server.close();
}

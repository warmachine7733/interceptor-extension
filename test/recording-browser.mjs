// Optional real-browser regression: PLAYWRIGHT_MODULE points to an installed
// playwright module; PLAYWRIGHT_BROWSERS_PATH points to its downloaded browsers.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(import.meta.dirname, '..');
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', req.url.startsWith('/api') ? 'application/json' : 'text/html');
  res.end(req.url.startsWith('/api') ? JSON.stringify({ url: req.url }) : '<!doctype html><title>Recording fixture</title><h1>Application</h1>');
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const port = server.address().port;
const origin = `http://localhost:${port}`;
const api = `http://127.0.0.1:${port}`;
let context;
try {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const app = await context.newPage();
  const errors = [];
  app.on('pageerror', error => errors.push(error.message));
  await app.goto(`${origin}/accounts`);
  assert.equal(await app.evaluate(() => typeof window.ApiMockRules?.firstMatch), 'function');
  assert.equal(await app.evaluate(() => window.__LOCAL_API_MOCK_INSTALLED__), true);
  const options = await context.newPage();
  options.on('pageerror', error => errors.push(error.message));
  await options.goto(`chrome-extension://${extensionId}/options.html#/flows`);
  await options.locator('#watched-input').fill(origin);
  await options.locator('#watched-form button').click();
  await options.locator('#watched-list code').waitFor();
  const storage = () => options.evaluate(() => chrome.storage.local.get(null));
  const count = async n => {
    await options.waitForFunction(n => document.querySelector('.recording-banner')?.textContent.includes(`${n} request`), n);
    assert.equal((await storage()).recording.captured.length, n);
  };
  await options.locator('#record-new-flow').click();
  assert.equal((await storage()).flows?.length || 0, 0);
  await options.locator('#record-setup-name').fill('Test Recording');
  await options.locator('#record-setup-domain').fill(`${origin}/accounts?ignored=1`);
  await options.locator('#record-setup-api-domain').fill(origin);
  await options.locator('#record-setup-start').click();
  await count(0);
  let saved = await storage();
  assert.equal(saved.recording.active, true);
  assert.deepEqual(saved.recording.monitorScope, { type: 'site', origin });
  assert.equal(saved.flows.length, 0);
  assert.match(await options.locator('.recording-banner').innerText(), new RegExp(origin));
  console.log('Start: active recording, monitored domain and count visible, zero saved flows');
  await app.evaluate(url => fetch(url).then(r => r.json()), `${api}/api/one`);
  await count(1);
  await app.evaluate(url => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('GET', url);
    xhr.onload = resolve; xhr.onerror = reject; xhr.send();
  }), `${api}/api/two`);
  await count(2);
  await app.evaluate(() => history.pushState({}, '', '/collections'));
  await app.evaluate(url => fetch(url).then(r => r.json()), `${api}/api/three`);
  await count(3);
  const unrelated = await context.newPage();
  await unrelated.goto(`${api}/unrelated`);
  await unrelated.evaluate(url => fetch(url).then(r => r.json()), `${api}/api/excluded`);
  assert.equal((await storage()).recording.captured.length, 3);
  console.log('Capture: fetch 1, XHR 2, same-site SPA route 3; unrelated source excluded');
  await options.locator('#stop-recording').click();
  await options.waitForFunction(() => document.querySelector('.flow-editor-shell'));
  saved = await storage();
  assert.equal(saved.recording, null);
  assert.equal(saved.flows.length, 1);
  assert.equal(saved.flows[0].steps.length, 3);
  assert.equal(saved.flows[0].enabled, false);
  await options.locator('#close-flow-editor').click();
  await options.locator('#record-new-flow').click();
  await options.locator('#record-setup-name').fill('Cancelled recording');
  await options.locator('#record-setup-api-domain').fill(origin);
  await options.locator('input[value="global"]').check();
  await options.locator('#record-setup-start').click();
  await count(0);
  await options.locator('#cancel-recording').click();
  await options.waitForFunction(() => !document.querySelector('.recording-banner'));
  saved = await storage();
  assert.equal(saved.recording, null);
  assert.equal(saved.flows.length, 1);
  assert.deepEqual(errors, []);
  console.log('Review: exactly one disabled flow, three steps, detail visible; cancel creates no flow');
  // Reproduce the reported pre-existing "New Flow / ACTIVE / 0 steps" state,
  // then prove that recording uses a separate transient object beside it.
  await options.evaluate(() => chrome.storage.local.clear());
  await options.reload();
  await options.locator('#new-flow-header').click();
  await options.waitForFunction(() => document.querySelector('.flow-editor-shell'));
  saved = await storage();
  assert.equal(saved.flows.length, 1);
  const manual = saved.flows.find(flow => flow.name === 'New Flow');
  assert.equal(manual.steps.length, 0);
  assert.equal(saved.recording, null);
  await options.locator('#close-flow-editor').click();
  await options.locator(`[data-flow-action="toggle"][data-flow-id="${manual.id}"]`).click();
  await options.locator('#record-new-flow').click();
  await options.locator('#record-setup-name').fill('Alongside active flow');
  await options.locator('#record-setup-api-domain').fill(origin);
  await options.locator('input[value="global"]').check();
  await options.locator('#record-setup-start').click();
  await count(0);
  saved = await storage();
  assert.equal(saved.flows.length, 1);
  assert.equal(saved.activeFlowId, manual.id);
  assert.equal(saved.flows.find(flow => flow.id === manual.id).enabled, true);
  await options.locator('#cancel-recording').click();
  await options.waitForFunction(() => !document.querySelector('.recording-banner'));
  assert.equal((await storage()).flows.length, 1);
  console.log('Separate workflows: + New Flow creates an empty flow; recording beside an ACTIVE empty flow still shows its banner and saves no flow early');
  console.log(`PASS: Chrome for Testing ${context.browser().version()}`);
} finally {
  await context?.close();
  server.close();
}

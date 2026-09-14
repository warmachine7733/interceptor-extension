import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let network = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', req.url.startsWith('/api') ? 'text/plain' : 'text/html');
  if (req.url.startsWith('/api')) network++;
  res.end(req.url.startsWith('/api') ? 'REAL' : '<!doctype html><title>App</title><h1>Target application</h1>');
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const origin = `http://localhost:${server.address().port}`;
const api = `http://127.0.0.1:${server.address().port}`;
const root = path.resolve(import.meta.dirname, '..');
let context;
try {
  context = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true, viewport: { width: 1440, height: 1050 }, args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const app = await context.newPage();
  const errors = [];
  app.on('pageerror', e => errors.push(e.message));
  await app.addInitScript(() => window.addEventListener('message', e => {
    if (e.data?.source === 'local-api-mock' && e.data.type === 'config') window.__polishConfig = e.data.config;
  }));
  await app.goto(`${origin}/profile`);
  const rule = { id: 'manual', enabled: true, match: { method: 'GET', urlPattern: `${api}/api/profile` }, response: { enabled: true, status: 200, body: 'MOCK', headers: { 'content-type': 'text/plain' } } };
  const flow = { id: 'flow', enabled: true, name: 'Customer journey', steps: Array.from({ length: 10 }, (_, index) => ({
    id: `step-${index}`, order: index, enabled: true,
    matcher: { method: 'GET', urlPattern: `${api}/api/flow?step=${index}`, matchQuery: false },
    request: { method: 'GET', url: `${api}/api/flow`, headers: {}, body: '' },
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ step: index, customer: 'Alex', status: 'active' }, null, 2) },
    pageContext: { origin, pathname: '/profile' }
  })) };
  for (const enabled of [false, true]) for (const active of [false, true]) {
    const id = `${enabled}-${active}`;
    const recording = active ? { active, name: 'Customer journey', flowId: id, monitorScope: { type: 'site', origin }, captured: [] } : null;
    await worker.evaluate(config => chrome.storage.local.set(config), { enabled, recording, rules: [rule], flows: [flow] });
    await app.waitForFunction(({ enabled, active, id }) => window.__polishConfig?.enabled === enabled && (active ? window.__polishConfig?.recording?.flowId === id : window.__polishConfig?.recording === null), { enabled, active, id });
    assert.equal(await app.locator('#local-api-mock-rec-indicator').count(), active ? 1 : 0);
    const before = network;
    for (const transport of ['fetch', 'xhr']) {
      const result = await app.evaluate(async ({ url, transport }) => {
        if (transport === 'fetch') return (await fetch(url)).text();
        return new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.onload = () => resolve(xhr.responseText); xhr.onerror = reject; xhr.send(); });
      }, { url: `${api}/api/profile`, transport });
      assert.equal(result, enabled ? 'MOCK' : 'REAL');
    }
    assert.equal(network - before, enabled ? 0 : 2);
    if (active) {
      await app.waitForFunction(() => document.querySelector('#local-api-mock-rec-indicator')?.shadowRoot.querySelector('.count').textContent === '2 captured');
      const { recording: saved } = await worker.evaluate(() => chrome.storage.local.get('recording'));
      assert.equal(saved.captured.length, 2);
      assert.ok(saved.captured.every(record => record.responseBody === (enabled ? 'MOCK' : 'REAL')));
      if (!enabled) await app.screenshot({ path: path.join(root, 'node_modules/polish-indicator.png') });
    }
    const flowResponse = await app.evaluate(url => fetch(url).then(r => r.text()), `${api}/api/flow`);
    assert.equal(flowResponse, enabled ? flow.steps[active ? 1 : 0].response.body : 'REAL');
    console.log(`PASS Active=${enabled} Recording=${active}: fetch/XHR ${enabled ? 'mocked, no native duplicates' : 'real responses'}; Flow replay ${enabled ? 'enabled' : 'off'}`);
  }
  const options = await context.newPage();
  options.on('pageerror', e => errors.push(e.message));
  const optionsURL = `chrome-extension://${new URL(worker.url()).host}/options.html`;
  await options.goto(`${optionsURL}#/flows`);
  options.on('dialog', dialog => dialog.accept());
  await options.locator('#cancel-recording').click();
  await app.waitForFunction(() => !document.querySelector('#local-api-mock-rec-indicator'));
  await options.reload();
  await options.locator('#record-new-flow').click();
  await options.locator('#record-setup-name').fill('Exact page');
  await options.locator('#record-setup-domain').fill(`${origin}/profile`);
  await options.locator('input[value="page"]').check();
  await options.locator('#record-setup-start').click();
  await app.waitForFunction(() => document.querySelector('#local-api-mock-rec-indicator'));
  await app.evaluate(() => history.pushState({}, '', '/address'));
  assert.equal(await app.locator('#local-api-mock-rec-indicator').count(), 0);
  await app.evaluate(() => history.replaceState({}, '', '/profile?ignored=1'));
  assert.equal(await app.locator('#local-api-mock-rec-indicator').count(), 1);
  await app.evaluate(() => history.pushState({}, '', '/address'));
  await app.goBack();
  await app.waitForFunction(() => document.querySelector('#local-api-mock-rec-indicator'));
  const unrelated = await context.newPage();
  await unrelated.goto(`${api}/profile`);
  assert.equal(await unrelated.locator('#local-api-mock-rec-indicator').count(), 0);
  await options.locator('#stop-recording').click();
  await app.waitForFunction(() => !document.querySelector('#local-api-mock-rec-indicator'));
  console.log('PASS indicator: late start, count, exact-page pushState/replaceState/popstate, unrelated origin, Stop/Cancel');
  await options.goto(`${optionsURL}#/flows/flow`);
  await options.locator('.flow-step-item').first().waitFor();
  assert.equal(await options.locator('.flow-step-item').count(), 10);
  assert.equal(await options.locator('.flow-step-path').first().innerText(), '/api/flow');
  const savedFlows = await worker.evaluate(() => chrome.storage.local.get(['flows', 'rules', 'activeFlowId']));
  const tabs = options.locator('[data-flow-step-view]');
  assert.deepEqual(await tabs.allTextContents(), ['Response', 'Request']);
  assert.equal(await tabs.first().getAttribute('aria-selected'), 'true');
  assert.equal(await options.locator('[data-step-field="responseBody"]').isVisible(), true);
  assert.equal(await options.locator('[data-step-field="requestBody"]').isVisible(), false);
  await tabs.nth(1).click();
  assert.equal(await options.locator('[data-step-field="requestBody"]').isVisible(), true);
  assert.equal(await options.locator('[data-step-field="responseBody"]').isVisible(), false);
  await tabs.first().click();
  await options.locator('[data-step-select="9"]').click();
  assert.equal(await options.locator('[data-step-select="9"]').getAttribute('aria-current'), 'step');
  assert.equal(JSON.parse(await options.locator('[data-step-field="responseBody"]').inputValue()).step, 9);
  assert.equal(await options.locator('[data-step-move="down"]').isDisabled(), true);
  assert.equal(await options.locator('#save-flow').isDisabled(), true);
  await options.locator('[data-step-select="0"]').click();
  assert.equal(await options.locator('[data-step-move="up"]').isDisabled(), true);
  assert.equal(JSON.parse(await options.locator('[data-step-field="responseBody"]').inputValue()).step, 0);
  assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get(['flows', 'rules', 'activeFlowId'])), savedFlows);
  console.log('PASS Response-first tabs, step selection, boundary controls, and navigation without data changes');
  await options.screenshot({ path: path.join(root, 'node_modules/polish-light.png'), fullPage: true, animations: "disabled" });
  await options.locator('#dark-mode').check();
  await options.screenshot({ path: path.join(root, 'node_modules/polish-dark.png'), fullPage: true, animations: "disabled" });
  await options.setViewportSize({ width: 600, height: 900 });
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await options.setViewportSize({ width: 390, height: 844 });
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Editor fits a phone viewport');
  await options.locator('[data-step-select="9"]').click();
  assert.equal(JSON.parse(await options.locator('[data-step-field="responseBody"]').inputValue()).step, 9);
  assert.deepEqual(errors, []);
  console.log('PASS 10-step editor: light/dark screenshots and narrow-screen overflow check');
  await options.setViewportSize({ width: 1440, height: 1050 });
  await options.locator('#close-flow-editor').click();
  await options.locator('.flow-item').first().waitFor();
  const totalFlows = savedFlows.flows.length;
  assert.equal(await options.locator('.flow-item').count(), totalFlows);
  await options.locator('#flow-site-filter').selectOption(origin);
  assert.equal(await options.locator('.flow-item').count(), 1);
  await options.locator('#flow-site-filter').selectOption('all');
  assert.equal(await options.locator('.flow-item').count(), totalFlows, 'All Flows restores hidden cards');
  await options.locator('.flow-menu-trigger').first().click();
  assert.equal(await options.locator('.flow-menu-items').first().isVisible(), true);
  await options.keyboard.press('Tab');
  assert.equal(await options.locator('.flow-menu-item').first().evaluate(el => el === document.activeElement), true, 'Menu actions are keyboard reachable');
  await options.locator('.flow-menu-trigger').first().click();
  await options.screenshot({ path: path.join(root, 'node_modules/flows-list-dark.png'), fullPage: true });
  await options.setViewportSize({ width: 390, height: 844 });
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Flow list fits a phone viewport');
  await options.locator('#record-new-flow').click();
  await options.locator('#record-setup-start').waitFor();
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Recording setup fits a phone viewport');
  await options.screenshot({ path: path.join(root, 'node_modules/flows-record-mobile.png'), fullPage: true });
  console.log('PASS flow list and recording setup at 390px');
  await options.locator('#record-setup-name').fill('Do not save this');
  await options.locator('#record-setup-cancel').click();
  assert.equal(await options.locator('.flow-item').count(), totalFlows);
  assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get(['flows', 'rules', 'activeFlowId'])), savedFlows);
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('recording'))).recording, null);
  assert.deepEqual(errors, []);
  console.log('PASS filtering, keyboard menu access, and setup cancellation preserve existing data');
} finally {
  await context?.close(); server.close();
}

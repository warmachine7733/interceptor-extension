# Extension Testing Guide

## All-sites coverage

Manual mocks, Flow replay, and recording apply to every page and iframe while the
master toggle is Active. Recording scopes are selected when starting a Flow.

`npm test` includes the exact-host pass-through matrix in
`test/watchlist.test.mjs`: empty/missing lists, unrelated hosts, private IPs,
port/subdomain mismatches, all five HTTP methods, disabled mocking, and recording
that cannot bypass the watchlist. It verifies original fetch promises/arguments,
XHR arguments, CSRF headers, no matching, and no capture listeners.

With Playwright and Chromium installed, run `node test/watchlist-browser.mjs`.
Like the other browser checks it accepts `PLAYWRIGHT_MODULE` and
`PLAYWRIGHT_BROWSERS_PATH`. It routes a fixture at the qBittorrent URL without
contacting the real LAN application, checks real fetch/XHR behavior, then tests
Add/Remove, normalization, duplicates, persistence, and opt-in mocking. It also checks cross-origin APIs from watched/unwatched tabs
and iframe isolation in both directions.

An explicit recording session can capture watched requests while the mocking
toggle is inactive. Neither recording nor global scope grants access to unwatched
pages. The recording indicator appears only on watched application hosts.

## Quick Start
1. Open `chrome://extensions/` and enable **Developer mode** (top right)
2. Click **Load unpacked** and select this directory
3. Click the extension icon and customize rules as needed

## Test Scenarios

### Test 1: Basic Mock Response
**Setup Rule:**
- URL pattern: `https://httpbin.org/get`
- Method: `GET`
- Return mock response: ✓ enabled
- Status: `200`
- Response body: `{"mocked": true, "timestamp": "2024-01-01T00:00:00Z"}`
- Response headers: `{"content-type": "application/json"}`

**Test Code:**
```javascript
fetch('https://httpbin.org/get')
  .then(r => r.json())
  .then(d => console.log('Result:', d))
```

**Expected:** Logs mocked JSON response immediately (or after configured delay)

---

### Test 2: Request Override
**Setup Rule:**
- URL pattern: `https://httpbin.org/post`
- Method: `POST`
- Return mock response: ✗ disabled
- Request override URL: `https://httpbin.org/get` (changes POST to real GET)
- Request override method: `GET`
- Request headers: `{"X-Custom": "test-value"}`

**Test Code:**
```javascript
fetch('https://httpbin.org/post', {
  method: 'POST',
  body: JSON.stringify({ data: 'original' })
})
  .then(r => r.json())
  .then(d => console.log('Result:', d))
```

**Expected:** Real request sent to GET endpoint with custom header

---

### Test 3: XMLHttpRequest Mock
**Setup Rule:**
- URL pattern: `https://api.example.com/test`
- Method: `GET`
- Return mock response: ✓ enabled
- Status: `200`
- Response body: `{"xhr": "works"}`
- Delay ms: `500`

**Test Code:**
```javascript
const xhr = new XMLHttpRequest();
xhr.addEventListener('load', () => {
  console.log('Status:', xhr.status);
  console.log('Ready:', xhr.readyState);
  console.log('Body:', xhr.responseText);
});
xhr.open('GET', 'https://api.example.com/test');
xhr.send();
// Should see: Status: 200, Ready: 4, Body: {"xhr": "works"}
```

**Expected:** Mock response loaded after 500ms delay, events fire correctly

---

### Test 4: Header Handling
**Setup Rule:**
- URL pattern: `https://api.example.com/*`
- Method: `POST`
- Request headers: `{"Authorization": "Bearer token123", "X-Remove": null}`

**Test Code:**
```javascript
const xhr = new XMLHttpRequest();
xhr.open('POST', 'https://api.example.com/endpoint');
xhr.setRequestHeader('Authorization', 'Bearer original');
xhr.setRequestHeader('X-Remove', 'should-be-removed');
// Intercepts and replaces headers per rule
xhr.send();
```

**Expected:** Authorization header replaced, X-Remove header removed

---

### Test 5: Enable/Disable Toggle
**Test Code:**
```javascript
// With extension disabled, fetch should work normally
// With extension enabled and matching rule, fetch should use mock
fetch('https://httpbin.org/get').then(r => r.json()).then(console.log)
```

**Expected:** Toggle in options changes behavior

---

### Test 6: Empty String Body
**Setup Rule:**
- URL pattern: `https://api.example.com/empty-body`
- Method: `POST`
- Request body override: `` (empty string)

**Test Code:**
```javascript
fetch('https://api.example.com/empty-body', {
  method: 'POST',
  body: 'original body'
}).then(r => r.text()).then(console.log)
```

**Expected:** Empty string body sent (not original body)

---

### Test 7: No Content Status Codes
**Setup Rule:**
- URL pattern: `https://api.example.com/no-content`
- Method: `GET`
- Return mock response: ✓ enabled
- Status: `204`
- Response body: `` (empty)

**Test Code:**
```javascript
fetch('https://api.example.com/no-content')
  .then(r => {
    console.log('Status:', r.status);
    console.log('Content-Length:', r.headers.get('content-length'));
    return r.text();
  })
  .then(d => console.log('Body length:', d.length))
```

**Expected:** Status 204 with empty body

---

### Test 8: getAllResponseHeaders Format
**Setup Rule:**
- URL pattern: `https://api.example.com/headers-test`
- Method: `GET`
- Return mock response: ✓ enabled
- Response headers: `{"content-type": "application/json", "x-custom": "test"}`

**Test Code:**
```javascript
const xhr = new XMLHttpRequest();
xhr.addEventListener('load', () => {
  console.log('Headers:', xhr.getAllResponseHeaders());
  console.log('Content-Type:', xhr.getResponseHeader('content-type'));
  console.log('X-Custom:', xhr.getResponseHeader('X-Custom')); // Case insensitive
});
xhr.open('GET', 'https://api.example.com/headers-test');
xhr.send();
```

**Expected:** getAllResponseHeaders returns properly formatted headers with CRLF, getResponseHeader works case-insensitively

---

## Known Limitations
- Mock responses don't simulate partial loading states (readystatechange at 1, 2, 3)
- No full network inspector; flow recording supports watched fetch/XHR requests
- No support for custom conditions beyond URL pattern and method
- Import/export covers manual mock rules

## Debugging
1. Open DevTools and check the console for errors
2. The extension logs to window events when rules are applied
3. Check `chrome://extensions/` details to see if content scripts are injected
4. Use `chrome.storage.local.get(console.log)` in DevTools to inspect saved rules

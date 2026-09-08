# API Mock

A minimal Chromium Manifest V3 extension for development-time API mocking. It intercepts `fetch` and `XMLHttpRequest`, supports request URL/method/header/body overrides, and returns configured local mock responses.

**Features:**
- ✅ Intercepts fetch() and XMLHttpRequest
- ✅ Mock responses with custom status, headers, body, and delay
- ✅ Request overrides (URL, method, headers, body)
- ✅ Local rule storage (no cloud, no telemetry)
- ✅ URL pattern matching with wildcards
- ✅ Query-parameter matching, including wildcard values
- ✅ Publish-based rule editing so drafts do not apply while typing
- ✅ Enable/disable toggle, inactive by default
- ✅ On-page snackbar when a rule intercepts a request, with countdown
- ✅ `[API Mock]` console logs for mocked, rewritten, and passthrough requests
- ✅ Minimal UI, no dependencies

**Not included:**
- ❌ Requestly UI, dashboard, or cloud services
- ❌ Accounts, billing, or telemetry
- ❌ Network inspector or traffic recording
- ❌ Redirect, script injection, or file mapping

## Install locally

1. Open `chrome://extensions` and enable **Developer mode** (top right)
2. Select **Load unpacked** and choose this repository folder
3. Click the extension icon to open **Local API Mock** settings
4. Add a rule, configure it, and click **Publish Rule**
5. Turn the global toggle to **Active** when you want rules to apply

## Quick start

### Example 1: Mock a real API response

Create a rule to mock `https://api.example.com/users`:

| Field | Value |
|-------|-------|
| **URL pattern** | `https://api.example.com/users/*` |
| **Method** | `GET` |
| **Return mock response** | ✓ checked |
| **Status** | `200` |
| **Response body** | `[{"id": 1, "name": "John"}]` |
| **Response headers** | `{"content-type": "application/json"}` |

Then in your code:
```javascript
fetch("https://api.example.com/users/1")
  .then(r => r.json())
  .then(d => console.log(d))  // Logs: {id: 1, name: "John"}
```

When the rule fires, a snackbar appears on the page showing the rule name,
method, URL, and a countdown bar before it disappears. The page console also
receives a `[API Mock] mocked ...` log with the matched rule attached.

### Example 2: Override a request before sending

Create a rule to change a POST to GET:

| Field | Value |
|-------|-------|
| **URL pattern** | `https://api.example.com/*` |
| **Method** | `POST` |
| **Return mock response** | ✗ unchecked |
| **Replacement method** | `GET` |
| **Request headers** | `{"Authorization": "Bearer token123"}` |

The request is modified before hitting the real API (no mock response sent).

## URL Pattern Examples

- `*` — matches everything
- `https://api.example.com/*` — matches all paths under api.example.com
- `https://api.example.com/users/*` — matches /users/1, /users/2, etc.
- `https://api.*.com/*` — matches api.example.com, api.other.com, etc.
- `https://api.example.com/posts/1?test=1234` — matches this exact query string
- `https://api.example.com/posts/1?test=*` — matches any value for `test`
- `https://api.example.com/posts/1*` — matches the URL with or without query parameters

The URL pattern matches the complete request URL. Query parameters are matched
literally, while `*` can be used for dynamic values.

## Publishing rules

Changes to a rule are drafts until you click **Publish Rule**. This prevents a
partially edited URL, method, header, or response body from affecting requests.
New rules are also drafts and do not apply until published. Deleting a rule and
changing the global Active/Inactive toggle apply immediately.

The extension starts **Inactive** by default. Enable the global toggle before
testing a published rule. Individual rules must also be enabled.

## Rules explained

**Two modes per rule:**

1. **Return mock response** (checked)
   - Matching requests get your mocked response
   - No real API call is made
   - Use for: testing, offline development, stub APIs

2. **Request override** (mock response unchecked)
   - Matching requests are modified (URL, method, headers, body)
   - Modified request is sent to the real API
   - Use for: changing endpoints, adding auth headers, testing different scenarios

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Extension not intercepting | Reload extension: `chrome://extensions` → Find Local API Mock → click reload icon |
| Rule not matching | Check the complete URL pattern, use `*` for dynamic path or query values, publish the rule, and enable the rule checkbox |
| Extension is inactive | Turn the global toggle to **Active** in the options page |
| Changes have no effect | Click **Publish Rule** after editing the rule |
| No mock response showing | Verify "Return mock response" is checked in the rule |
| Response headers not appearing | Make sure to add them in JSON format: `{"header-name": "value"}` |
| Need to inspect interception | Open the target page's DevTools console and filter for `[API Mock]` |

## Building

```bash
npm install  # Install dev dependencies
npm run build  # Create dist/local-api-mock.zip
npm test   # Run the primary rule matching tests
node --test test/  # Run all tests
```

## Testing

See [TESTING.md](TESTING.md) for detailed test scenarios and [FIXES.md](FIXES.md) for bug fixes applied.
The build runs `sync-version.mjs` before packaging, keeping `package.json` and
`manifest.json` on the same version. The current release is **1.1.0**.

## Rules

- With **Return mock response** enabled, matching requests receive the status,
  headers, body, and optional delay configured in the rule; no real API call is
  made.
- With it disabled, a matching request can have its URL, method, headers, or
  body changed before it goes to the real API.
- Rules and configuration live only in `chrome.storage.local` on the user’s
  machine. The extension does not collect or transmit request, response, or
  browsing data.

## Permissions

- `http://*/*`, `https://*/*`, `file://*/*` — required to match APIs on all protocols
- `storage` — stores mock rules locally in `chrome.storage.local`
- **No data leaves your machine** — all rules stay in browser storage

## License

**AGPL-3.0-or-later** — This project is licensed under the GNU Affero General Public License v3.0 or later.

**Important:** If you distribute this extension, you must provide the corresponding source code under the same AGPL-3.0 license.

**Attribution:** The interception approach was informed by [Requestly HTTP Interceptor](https://github.com/requestly/requestly) (Copyright 2025-present BrowserStack Inc., also AGPL-3.0).

See [LICENSE](LICENSE) for the full legal text.

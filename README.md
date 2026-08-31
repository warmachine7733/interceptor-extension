# API Mock

A minimal Chromium Manifest V3 extension for development-time API mocking. It intercepts `fetch` and `XMLHttpRequest`, supports request URL/method/header/body overrides, and returns configured local mock responses.

**Features:**
- ✅ Intercepts fetch() and XMLHttpRequest
- ✅ Mock responses with custom status, headers, body, and delay
- ✅ Request overrides (URL, method, headers, body)
- ✅ Local rule storage (no cloud, no telemetry)
- ✅ URL pattern matching with wildcards
- ✅ Enable/disable toggle
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
4. Add a rule (see examples below)

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
| Rule not matching | Check URL pattern with wildcards, enable the rule checkbox |
| "Enable mocking" is off | Click the checkbox in options page to turn it on |
| No mock response showing | Verify "Return mock response" is checked in the rule |
| Response headers not appearing | Make sure to add them in JSON format: `{"header-name": "value"}` |

## Building

```bash
npm install  # Install dev dependencies
npm run build  # Create dist/local-api-mock.zip
npm test   # Run rule matching tests
```

## Testing

See [TESTING.md](TESTING.md) for detailed test scenarios and [FIXES.md](FIXES.md) for bug fixes applied.

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

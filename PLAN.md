# Minimal API Mocking Extension — Implementation Plan

## Objective

Create a new, lightweight browser extension based on the relevant open-source
interception techniques in `requestly/interceptor`, while excluding the
Requestly dashboard, branding, accounts, cloud services, analytics, imports,
traffic inspection, and other non-essential product features.

The extension's single purpose will be local development API mocking:

- match real API requests;
- alter outgoing request details when configured; and
- return configured mock responses instead of contacting the real API.

## Scope Assumptions

- Target: Chromium browsers first (Chrome/Edge) using Manifest V3.
- Configuration: a small local extension options page is acceptable; no
  Requestly UI, remote dashboard, account, or cloud sync.
- Rules are stored locally in extension storage and exported/imported as JSON
  only if needed for developer workflow.
- Rule matching initially supports URL patterns, HTTP method, and optional
  request-header/body conditions.
- Request overrides support configured URL, method, headers, and body changes
  before an unmatched request is sent to the real API.
- Response mocks support status, headers, JSON/text body, and optional delay.

## Implementation Steps

1. Inspect the upstream repository and its license, then identify only the
   browser-extension interception pieces required for request/response mocking.
   Preserve required license and attribution notices for any copied or adapted
   source.
   - Upstream code is AGPLv3. Any copied or adapted implementation will be
     distributed under AGPLv3 with its corresponding source and notices.
2. Initialize a standalone Manifest V3 extension project with a minimal build
   setup, manifest, service worker, page-world interceptor, and local storage
   schema.
3. Implement rule evaluation and request interception for `fetch` and
   `XMLHttpRequest`, with deterministic first-match behavior and a global
   enable/disable switch.
4. Implement response mocking: construct a browser-compatible mocked response
   with configured status, headers, body, and delay; allow unmatched traffic to
   continue to the real API unchanged.
5. Implement the smallest developer-facing configuration surface: create,
   edit, enable/disable, delete, and reorder mock rules. Keep it independent of
   Requestly’s visual design and product UI.
6. Add validation and safe defaults, including malformed JSON feedback,
   restrictive host permissions, and local-only data handling.
7. Add automated tests for URL/method matching, rule priority, mocked response
   construction, disabled rules, and unmatched pass-through behavior.
8. Build the unpacked extension and manually verify it against a simple local
   test page/API. Document installation, permissions, rule format, and known
   limitations in a concise README.

## Explicit Exclusions

- Requestly web app/dashboard and all Requestly branding
- authentication, teams, cloud storage/sync, billing, telemetry, and analytics
- network/session inspector, desktop proxy, mobile/desktop capture
- redirect, script injection, local-file mapping, and import/migration tools
- Firefox/Safari support unless requested after the Chromium version works

## Deliverables

- Standalone source code for the stripped-down extension
- `README.md` with local development and unpacked-install instructions
- Tests and a reproducible production build
- License/attribution files required by the upstream source used

## License Decision

The Requestly repository is AGPLv3. The planned source extraction is suitable
for private/internal development. If the resulting extension will be shared or
published, it must be conveyed under AGPLv3 with the corresponding source.
Choose a clean-room implementation only if a different distribution license is
required; that path will not copy or adapt upstream source.

## Confirmation Gate

No upstream source will be downloaded, copied, altered, or removed until this
plan is approved. On approval, implementation will begin with the upstream
license and extension-architecture review.

## Implementation Status

Completed on 2026-09-01: upstream review, standalone MV3 extension, local rule
editor, request overrides, mock responses, AGPL license/attribution, source
tests, README, and packaged ZIP build. Browser-runtime testing remains for the
target Chromium browser because this workspace has no Node.js or Chromium
runtime installed.

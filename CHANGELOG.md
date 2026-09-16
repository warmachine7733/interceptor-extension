# Release Log






## 1.2.5
- Add API-domain recording filters and Flow-specific aggregated notifications

## 1.2.4
- Keep each mock's published response tab independent and restore it after reload.

## 1.2.3
- Improve Flow controls, API search, and move Watched Domains into Settings.

## 1.2.2
- Made the header Active/Inactive switch the master control for every mock and Flow; disabling it always restores native requests without changing saved Flow activation.
- Added Flow JSON import/export, including exporting all Flows or an individual Flow from its actions menu. Imported Flows start disabled to avoid unexpected interception.
- Clarified Flow states with Live, Paused, and Disabled labels, plus an on-screen explanation whenever the master toggle pauses replay.

## 1.2.1
- Scope mocking and recording to explicitly watched application hosts
- Added an empty-by-default Watched Domains list: exact originating page host opt-in gates mocks, flow replay, and recording before request processing.
- Preserved native fetch/XHR pass-through for unrelated hosts, including qBittorrent WebUI, with browser regression coverage.
- Kept cross-origin API mocks working on watched apps, with independent iframe host checks and trusted sender validation for recordings.
- Existing mocks and flows remain saved; add application hosts to the watchlist after upgrading.

## 1.2.0
- Added flow recording and sequential API response replay with domain and page capture scopes.
- Added a recording indicator with captured request counts.
- Added flow step editing with explicit save, discard, and unsaved-change navigation guards.
- Refined the Flows UI, dark mode, and responsive layouts.
- Expanded automated and Chromium browser coverage for recording and flow editing.

## 1.1.7
- Revamped options UI with modern developer tool aesthetic (frosted glass header, glowing accents, refined method badges).
- Added pre-release verification script (`npm run prerelease`) checking version sync, tests, build artifacts, and bundle contents.
- Enhanced dark mode with deep obsidian/slate styling and high-contrast color scheme.
- Improved interactive states, animated pulsing draft changes badge, and polished button transitions.

## 1.1.6
- Added automatic trimming for leading and trailing whitespace in URL patterns and request override URLs.
- Enhanced JSON formatting for response and request body editors to accept and format JavaScript object literals, relaxed JSON, template strings, and comments.
- Added a "Format JSON" action to the request body editor.
- Expanded test suite covering URL whitespace handling and JS object parsing/formatting.

## 1.1.5
- Expanded automated test coverage and release validation.
- Improved response variant selection and request handling.
- Added automated version bumping and changelog generation.

## 1.1.4
- Added multiple response variants per mock.
- Added dark mode with sun/moon toggle.
- Added mock import/export.
- Improved URL query matching and snackbar placement.

## 1.1.3
- Added mock import/export workflows.
- Improved mock naming and request matching.

## 1.1.0
- Added publish-based rule editing.
- Added request overrides and interception logging.

## 1.0.0 - 1.0.5
- Initial stable releases with local API mocking, URL matching, and request interception.

## 0.1.0
- Initial development release.

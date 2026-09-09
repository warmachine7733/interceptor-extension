# Contributing to Local API Mock

Thank you for your interest in contributing! This extension is licensed under AGPL-3.0-or-later, which means:

- **Your contributions are welcome** under the same AGPL-3.0-or-later license
- **Source code must remain open** — any distributed version must include source
- **Share improvements** with the community

## How to contribute

1. **Fork the repository** on GitHub
2. **Create a branch** for your feature: `git checkout -b feature/my-feature`
3. **Make your changes** and test them
4. **Run tests:** `npm test`
5. **Commit with clear messages:** `git commit -m "Add XYZ feature"`
6. **Push and create a Pull Request**

## Development setup

```bash
npm install           # Install dependencies
npm test             # Run tests
npm run build        # Build extension for distribution
```

## Release checklist

- Update [CHANGELOG.md](CHANGELOG.md) with the new version and a short summary of changes
- Bump `package.json` and run `npm run prebuild` to sync `manifest.json`
- Run `npm test` and `npm run build`

Use `npm run bump -- 1.1.6` for the next release. It updates `package.json`,
syncs `manifest.json`, and adds recent commit summaries to `CHANGELOG.md`.
You can provide an optional summary after the version when needed.

## Code structure

- `manifest.json` — Extension configuration (Manifest V3)
- `background.js` — Service worker (handles icon click)
- `bridge.js` — Content script for config communication
- `rules.js` — Rule matching logic (pure functions, tested)
- `page-interceptor.js` — Main interception logic (fetch + XHR)
- `options.html/js/css` — Settings UI
- `test/` — Automated tests for rule matching

## What we're looking for

- ✅ Bug fixes and improvements
- ✅ Test coverage and edge case handling
- ✅ Documentation improvements
- ✅ Performance optimizations
- ❌ No Requestly UI integration
- ❌ No cloud services or telemetry
- ❌ No account/auth features

## License reminder

By contributing, you agree that your contributions are licensed under AGPL-3.0-or-later. This ensures:

- The code stays free and open
- Improvements benefit everyone
- No one can privatize derivative works

See [LICENSE](LICENSE) for full details.

## Questions?

Open an issue on GitHub with your question or idea!

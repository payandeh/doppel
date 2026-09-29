# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.3.0] - 2026-09-30

First public release.

### Added
- Override the status code and/or JSON body of `fetch` and XHR responses, with many overrides active at once.
- "Open using Doppel" in the DevTools Network tab's right-click menu, pre-filled with the real response.
- JSON editor (CodeMirror 6) with a strict validator that reports the line and column of errors, plus Beautify and Minify.
- URL matching by Equals (optionally ignoring the query string), Contains, Wildcard or Regex, plus method, delay and "mock only" options.
- Save overrides to a folder (`doppel.json`), so they survive reinstalls and can be shared through Git.
- Overridden requests show `DOPPEL.js` in the Network tab's Initiator column and are logged to the Console.
- Popup and manager page with per-override switches, a global switch, reordering and import/export.

[Unreleased]: https://github.com/payandeh/doppel/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/payandeh/doppel/releases/tag/v1.3.0

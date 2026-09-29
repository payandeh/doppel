# Contributing to Doppel

Thanks for helping make Doppel better! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and asking for features

- Search [existing issues](https://github.com/payandeh/doppel/issues) first.
- Use the **Bug report** or **Feature request** form. For bugs, include your Chrome version, the override you set up
  (you can export it from the manager page) and what you expected to happen.
- Security problems: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Doppel has no build step: the repo folder *is* the extension.

1. `git clone https://github.com/payandeh/doppel.git`
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the repo folder.
3. After editing files, click the reload icon on the extension card. Reopen DevTools after changing `devtools.js`.

To run the tests you need Node.js 20+:

```bash
npm install
npx playwright install chromium   # once, for the end-to-end tests
npm test                          # checks + unit tests
npm run test:e2e                  # loads the extension in Chromium and tests real pages
```

## Making changes

- Keep pull requests focused: one fix or feature per PR.
- Match the existing style (2-space indent, single quotes, semicolons). `.editorconfig` sets the basics.
- After editing `content/inject.js`, run `python3 tools/ignore-list.py` so DevTools keeps hiding it from stack traces.
- Add or update tests for behavior changes (`tests/unit` for logic, `tests/e2e` for anything that runs in the browser).
- Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
- UI changes: include a screenshot in the PR, and check light and dark mode.

## Commit messages

Short, imperative subject line ("Fix XHR timeout for mocked requests"), with more detail in the body if needed.

## Releases (maintainers)

1. Update `version` in `manifest.json` and `package.json`, and move **Unreleased** items in the changelog under the new version.
2. Tag and push: `git tag v1.4.0 && git push --tags`.
3. The **Release** workflow builds the zip and publishes a GitHub release.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE), and to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

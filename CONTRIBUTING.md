# Contributing to Doppel

Thanks for helping make Doppel better! Bug reports, ideas and pull requests are all welcome.

## Reporting bugs and asking for features

- Search [existing issues](https://github.com/payandeh/doppel/issues) first.
- Use the **Bug report** or **Feature request** form. For bugs, include your Chrome version and the override you set up
  (Manager → Export gives you JSON).
- Questions and ideas are welcome in [Discussions](https://github.com/payandeh/doppel/discussions).
- Security problems: follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Doppel has no build step: the repo folder _is_ the extension. You need Node.js 22 (see `.nvmrc`).

```bash
git clone https://github.com/payandeh/doppel.git
cd doppel
npm install                        # also installs the git hooks
npx playwright install chromium    # once, for end-to-end tests
```

Load it in Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the repo folder. After editing,
click the reload icon on the extension card, and reopen DevTools if you changed `devtools.js`.

| Command               | What it does                                                            |
| --------------------- | ----------------------------------------------------------------------- |
| `npm test`            | Static checks and unit tests                                            |
| `npm run test:e2e`    | Loads the extension in Chromium and tests real pages                    |
| `npm run lint`        | ESLint                                                                  |
| `npm run format`      | Prettier (writes changes)                                               |
| `npm run build`       | Builds `dist/doppel-<version>.zip`                                      |
| `npm run ignore-list` | Regenerates the source map in `content/inject.js` (automatic on commit) |

## Workflow

`main` is protected: every change goes through a pull request, and CI must pass before it can be merged.

1. **Create a branch** named `<type>/<short-description>` in lowercase kebab-case:

   ```
   feat/har-import    fix/xhr-timeout    docs/install-steps    chore/update-deps
   ```

   Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, `hotfix`, `release`.

2. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):

   ```
   feat(editor): add HAR import
   fix(content): keep readyState at 4 after abort
   docs: explain folder sync conflicts
   ```

   Optional scopes: `content`, `devtools`, `editor`, `popup`, `manager`, `panel`, `folder`, `ui`, `deps`, `ci`, `release`, `docs`.
   Use `feat!:` or a `BREAKING CHANGE:` footer for breaking changes.

3. **Open a pull request** against `main`. Its title must also follow Conventional Commits, because pull requests are
   squash-merged and the title becomes the commit on `main`.

### What runs automatically

- **Before each commit** (Husky): blocks commits on `main`, checks the branch name, and runs ESLint and Prettier on the
  staged files. `content/inject.js` gets its source map regenerated.
- **On the commit message**: commitlint checks the Conventional Commits format.
- **Before each push**: branch name check and `npm test`.
- **On the pull request**: lint, tests, end-to-end tests, build, branch/title/commit checks, dependency review,
  automatic labels, and an AI review by [CodeRabbit](https://coderabbit.ai). Reply to CodeRabbit in the PR if you
  disagree with a suggestion; a maintainer makes the final call.

## Code style

- Prettier and ESLint decide formatting and most style questions; don't fight them.
- Keep functions small and names descriptive, so the code explains itself.
- **Comments only when they explain something non-obvious**, like _why_ a workaround exists. Don't restate what the
  code does.
- Add or update tests for behavior changes: `tests/unit` for logic, `tests/e2e` for anything that runs in the browser.
- UI changes: include light and dark mode screenshots in the PR.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please). Merged `feat` and `fix`
commits collect into a **release pull request** that bumps the version in `manifest.json` and `package.json` and updates
`CHANGELOG.md`. Merging it tags the release, publishes it on GitHub and attaches the extension zip.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE), and to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

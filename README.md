<p align="center">
  <img src="assets/logo.svg" width="112" alt="Doppel logo">
</p>

<h1 align="center">Doppel</h1>

<p align="center"><b>A body double for your API responses.</b><br>
Override the status code and JSON body of any REST call, straight from Chrome's Network tab. Keep as many overrides on at once as you like.</p>

<p align="center">
  <a href="https://github.com/payandeh/doppel/actions/workflows/ci.yml"><img src="https://github.com/payandeh/doppel/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/payandeh/doppel/releases/latest"><img src="https://img.shields.io/github/v/release/payandeh/doppel?color=FF6B5B" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/payandeh/doppel?color=14B8A6" alt="MIT license"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/payandeh/doppel"><img src="https://api.scorecard.dev/projects/github.com/payandeh/doppel/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://www.conventionalcommits.org"><img src="https://img.shields.io/badge/Conventional%20Commits-1.0.0-FF6B5B" alt="Conventional Commits"></a>
  <img src="https://img.shields.io/badge/Chrome-Manifest%20V3-0F1B24?logo=googlechrome&logoColor=white" alt="Chrome Manifest V3">
</p>

<p align="center">
  <img src="docs/network-menu.png" width="520" alt="Right-click a request in the Network tab → Open using Doppel">
</p>

---

## Why

Chrome's built-in **Override content** can't change the status code, and only one override can be active at a time.
Doppel lets you:

- **Change the status code, the body, or both.** Leave either one empty and the real value from the server is kept.
- **Run many overrides at once**, each with its own on/off switch, plus one switch to turn everything off.
- **Organize them in groups**, nested as deep as you like. Collapse a group, switch a whole group off, or export just the groups you need.
- **Start from the real response.** Right-click a request in the Network tab → **Open using Doppel**, and the current response is copied into the editor.
- **Edit JSON properly** with syntax highlighting, folding, search, Beautify/Minify and a strict validator that points to the exact line and column of an error.
- **Save your mocks to a folder** (`doppel.json`), so they survive reinstalling the extension, work on other computers and can live in Git with your team.

## Install

Doppel isn't on the Chrome Web Store yet.

1. Download `doppel-<version>.zip` from the [latest release](https://github.com/payandeh/doppel/releases/latest) and unzip it (or clone this repo).
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder (the one with `manifest.json`).
4. Close DevTools if it's open, then open it again (DevTools only loads extensions when it opens).

## Use

1. Open DevTools → **Network**.
2. Right-click a request → **Open using Doppel**.
3. Change the status and/or the JSON body, then **Save**.

<p align="center"><img src="docs/editor-dark.png" width="720" alt="Doppel editor"></p>

Manage everything from the toolbar popup or the manager page (right-click the toolbar icon → **Options**):

<p align="center"><img src="docs/manager.png" width="720" alt="Doppel manager"></p>

### Override options

| Option         | What it does                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Method         | `ANY`, or a specific HTTP method                                                                 |
| URL match      | **Equals** (optionally ignoring the query string), **Contains**, **Wildcard** (`*`) or **Regex** |
| Status code    | 200–599. Empty = keep the server's status                                                        |
| Response body  | JSON. Empty = keep the server's body                                                             |
| Delay          | Wait before responding (ms)                                                                      |
| Mock only      | Don't call the server at all                                                                     |
| Use only after | Wait until another override has answered a request on the page, then take priority               |

When several overrides match the same request, the one higher in the list wins.

### Sequences: a different response after another call

Say the page calls **B** before and after calling **A**, and B should answer differently the second time:

1. Override **A** as usual.
2. Create **B1** for B with the first response.
3. Duplicate it as **B2**, change the response, and set **Use only after** to **A**.

Now B gets B1 until A has been called, then B2. An override with **Use only after** is skipped until the override it
waits for has answered a request on the page; from then on it wins over the other overrides for the same URL, wherever
it sits in the list. Steps can chain (B3 after C, and so on); if several are ready, the one whose trigger ran last
wins. Reloading the page starts over.

To react to a call you don't want to change, give it an override with an empty status and body: it passes the real
response through but still counts as "has run".

### Groups

Click **+ Group** to create a group, then drag overrides onto it (or use **Move to…** on a card, or the **Group** field in
the editor). Groups can hold other groups.

- **Collapse** a group with its arrow. Doppel remembers which groups are collapsed.
- **Switch a group off** to pause everything inside it, including sub-groups. Each override keeps its own switch, so
  turning the group back on restores exactly what was on before.
- **Reorder** by dragging overrides and groups, or with **Move to top** / **Move up** / **Move down**. Groups and
  overrides share one order, so an override can sit above a group. While you drag, a highlighted slot shows exactly
  where the item will land. Top to bottom is also the priority order.
- **Export** only what you need: **Export…** lets you tick groups and single overrides, and each group's **⋯** menu has
  **Export this group**. Importing a file keeps its groups.

### Save to a folder

Manager page → **Save to a folder on your computer** → **Choose folder…**. Every change is written to `doppel.json` in that folder.

- **Reinstalled or on another computer?** Choose the same folder and your overrides load back.
- **Edited the file or pulled from Git?** Doppel picks up the change. If both the file and the browser changed, it asks whether to keep one version or merge them.
- Chrome asks for folder permission again after a browser restart. Click **Allow access** in the manager.
- A broken `doppel.json` is never overwritten. Doppel shows the error instead.

### Let an AI agent add overrides (MCP)

`mcp/server.mjs` is an [MCP](https://modelcontextprotocol.io) server that edits the same `doppel.json`, so you can say
_"make `/api/orders` return a 500 with an error message"_ and the agent adds the override. It needs Node 20+ and nothing
else.

1. Set up **Save to a folder** (above) so `doppel.json` exists.
2. Register the server with your agent. Every client runs the same command, `node <doppel repo>/mcp/server.mjs <your
Doppel folder>`; only the config file differs. Use **absolute paths**, since most clients don't expand `~`.

   <details>
   <summary><b>Claude Code</b></summary>

   ```bash
   claude mcp add doppel -- node /path/to/doppel/mcp/server.mjs /path/to/your/doppel-folder
   ```

   </details>

   <details>
   <summary><b>Cursor</b>, <b>Claude Desktop</b>, <b>Windsurf</b> and other <code>mcpServers</code> clients</summary>

   Config file: Cursor `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project), Claude Desktop
   `claude_desktop_config.json` (Settings → Developer → Edit Config), Windsurf `~/.codeium/windsurf/mcp_config.json`.

   ```json
   {
     "mcpServers": {
       "doppel": {
         "command": "node",
         "args": ["/path/to/doppel/mcp/server.mjs", "/path/to/your/doppel-folder"]
       }
     }
   }
   ```

   </details>

   <details>
   <summary><b>VS Code</b> (Copilot agent mode)</summary>

   `.vscode/mcp.json`. Note the key is `servers`, not `mcpServers`:

   ```json
   {
     "servers": {
       "doppel": {
         "type": "stdio",
         "command": "node",
         "args": ["/path/to/doppel/mcp/server.mjs", "/path/to/your/doppel-folder"]
       }
     }
   }
   ```

   </details>

   <details>
   <summary><b>Codex CLI</b></summary>

   `~/.codex/config.toml`:

   ```toml
   [mcp_servers.doppel]
   command = "node"
   args = ["/path/to/doppel/mcp/server.mjs", "/path/to/your/doppel-folder"]
   ```

   </details>

   **Server doesn't start or shows no tools?** Apps opened from the Dock or Start menu often can't find a `node`
   installed with nvm, fnm or Volta. Run `which node` (`where node` on Windows) and put that full path in `command`.
   To check the server and folder outside any agent, run this. It prints how many overrides it found, or what's wrong:

   ```bash
   echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"doppel_status"}}' \
     | node /path/to/doppel/mcp/server.mjs /path/to/your/doppel-folder
   ```

3. Ask for a mock, then **reload the page**. Doppel reads the file before the page's first request, and also checks it
   every few seconds while the manager is open (and every 30 seconds otherwise).

Tools: `doppel_status`, `list_overrides`, `get_override`, `add_override`, `update_override`, `delete_override`,
`list_groups`, `set_enabled`. New overrides go to the top of their group, like ones added in the editor. Groups can be
given as a path (`"Checkout / Errors"`) and are created if needed. After a browser restart, click **Allow access** in the
manager once, or Doppel can't read the folder.

### Seeing overrides in the Network tab

Overridden requests show **`DOPPEL.js`** in the Network tab's **Initiator** column, and each one is logged in the Console as `[Doppel] …`.

## How it works

Doppel runs a small script in the page that wraps `fetch` and `XMLHttpRequest`. When a request matches an override, it
fetches the real response (unless **Mock only** is on) and hands the page the overridden status and/or body.

- Your overrides stay in the extension's isolated world. A page only ever receives the one override that matches a request
  it made, so other sites can't read your mock data.
- Faked XHRs support `timeout`, `abort()`, `responseType` (`json`, `text`, `blob`, `arraybuffer`) and response headers.

## Limitations

- Chrome's Network tab shows the **real** server response. The page receives the overridden one. Extensions can't set the
  purple "overridden" marker that Chrome's own Local Overrides use.
- Only REST calls made from the page (`fetch` / XHR) are covered, not requests from Web Workers or Service Workers.
- Status codes must be between 200 and 599, which is the browser's limit for fetch responses.
- The right-click item's label is set by Chrome ("Open using" + the extension's name).

## Development

No build step: edit the files and reload the extension in `chrome://extensions`.

```bash
npm install                        # dependencies and git hooks
npm test                           # static checks + unit tests
npx playwright install chromium    # once
npm run test:e2e                   # loads the extension in Chromium and tests real pages
```

Changes go through pull requests with [Conventional Commits](https://www.conventionalcommits.org/) and branch names like
`feat/har-import`. Git hooks and CI enforce both, and CodeRabbit reviews every pull request. See
[CONTRIBUTING.md](CONTRIBUTING.md).

```
manifest.json        extension manifest (MV3)
background.js        badge, editor window, folder auto-save
devtools.js          "Open using Doppel" handler + optional DevTools tab
content/inject.js    fetch/XHR interception (page world)
content/bridge.js    rule matching (isolated world)
content/DOPPEL.js    marks overridden requests in the Initiator column
lib/                 shared UI, matcher, JSON validator, folder sync
lib/vendor/          bundled CodeMirror 6 JSON editor (MIT)
tests/               unit (node:test) and end-to-end (Playwright) tests
tools/               checks, packaging, branch-name and source-map helpers
```

## Brand

|                                                                 |       |           |
| --------------------------------------------------------------- | ----- | --------- |
| ![](https://img.shields.io/badge/-%20-FF6B5B?style=flat-square) | Coral | `#FF6B5B` |
| ![](https://img.shields.io/badge/-%20-14B8A6?style=flat-square) | Teal  | `#14B8A6` |
| ![](https://img.shields.io/badge/-%20-0F1B24?style=flat-square) | Ink   | `#0F1B24` |
| ![](https://img.shields.io/badge/-%20-EEF9F7?style=flat-square) | Foam  | `#EEF9F7` |

The logo is two overlapping circles: the real response and its double, with the overlap where they look the same.

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

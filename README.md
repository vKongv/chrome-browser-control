# Chrome Browser Control

Local Chrome-profile control for stdio MCP hosts.

This project exposes browser-control MCP tools through a Manifest V3 Chrome extension connected to a loopback WebSocket broker. Configure your MCP host to launch the stdio adapter with the same pairing token you enter in the extension.

Repository: https://github.com/vkongv/chrome-browser-control

## Prerequisites

- Node.js 18+
- Google Chrome

## Install and Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/vkongv/chrome-browser-control.git
   cd chrome-browser-control
   ```

2. Install dependencies and run setup:

   ```bash
   npm install
   npm run setup
   ```

   `npm run setup` writes `.env.local` with `CHROME_BROWSER_CONTROL_TOKEN` and `CHROME_BROWSER_CONTROL_PORT`, prints the extension folder path, and shows copy-paste MCP config snippets. That file is gitignored — do not commit it.

3. Continue with [Load The Extension](#load-the-extension), then add MCP config and verify the connection.

To generate a pairing token manually instead of `npm run setup`:

```bash
node -e "console.log(crypto.randomBytes(32).toString('base64url'))"
```

### Environment Variables

- `CHROME_BROWSER_CONTROL_TOKEN` — Required. High-entropy pairing token shared by the broker, MCP adapter, and extension popup.
- `CHROME_BROWSER_CONTROL_PORT` — WebSocket broker port (default `8765`).
- `CHROME_BROWSER_CONTROL_HOST` — Loopback host for the broker (default `127.0.0.1`).
- `CHROME_BROWSER_CONTROL_EXTENSION_ID` — Optional. Pins the broker to one installed extension ID.
- `CHROME_BROWSER_CONTROL_DISABLE_LOCAL_ENV` — Optional. Set to `1` to skip loading `.env.local`.

For manual operation outside an MCP host:

```bash
CHROME_BROWSER_CONTROL_TOKEN='<generated-token>' npm run broker
CHROME_BROWSER_CONTROL_TOKEN='<generated-token>' npm run mcp
```

`npm start` is an alias for `npm run mcp`.

## Load The Extension

1. Open Chrome with the profile you want the MCP tools to control.
2. Go to `chrome://extensions`.
3. Enable Developer mode.
4. Click "Load unpacked".
5. Select `/path/to/chrome-browser-control/extension`.
6. Open the Chrome Browser Control extension popup.
7. Keep the bridge URL at `ws://127.0.0.1:8765` unless you changed the local port.
8. Paste the generated pairing token.
9. Add allowed origins such as `https://example.com`, `http://localhost:3000`, or `*` for all normal `http://` and `https://` pages.
10. Click "Save and reconnect".

The extension may ask for host permission for the allowed origins. Denying that request prevents page actions for those origins.

Using `*` is convenient for local development, but it exposes every normal web page in the current Chrome profile to MCP tools. Prefer explicit origins when you only need a few sites.

## MCP Host Configuration

Paste a snippet from `npm run setup` into Cursor, Claude Desktop, Codex, or another stdio MCP host. To print host-specific config again later:

```bash
npm run --silent mcp-config -- --host cursor
npm run --silent mcp-config -- --host claude
npm run --silent mcp-config -- --host codex
npm run --silent mcp-config -- --host yaml
```

Use absolute paths because many MCP hosts do not apply a per-server working directory. The exact key names vary by host, but Claude Desktop, Codex, Cursor, and similar MCP hosts generally need a command, args, and env block for a stdio MCP server. This project should work with any stdio MCP host; verify host-specific config syntax in that host's documentation.

YAML-style example:

```yaml
mcp_servers:
  chrome_browser_control:
    command: "/path/to/chrome-browser-control/node_modules/.bin/tsx"
    args: ["/path/to/chrome-browser-control/server/index.ts"]
    env:
      CHROME_BROWSER_CONTROL_TOKEN: "<generated-token>"
      CHROME_BROWSER_CONTROL_PORT: "8765"
    timeout: 60
    connect_timeout: 30
```

JSON-style example:

```json
{
  "mcpServers": {
    "chrome_browser_control": {
      "command": "/path/to/chrome-browser-control/node_modules/.bin/tsx",
      "args": ["/path/to/chrome-browser-control/server/index.ts"],
      "env": {
        "CHROME_BROWSER_CONTROL_TOKEN": "<generated-token>",
        "CHROME_BROWSER_CONTROL_PORT": "8765"
      }
    }
  }
}
```

If your MCP host uses a config file, keep it private and outside the repository.

## Verify

Run the setup checker:

```bash
npm run doctor
```

Then confirm from your MCP host by calling the `browser_status` tool. When ready, `extension.status` and `ping.status` should reflect a live bridge connection, and `extension.allowedOrigins` should show your configured scope.

## Tools

- `browser_status`: checks whether the MCP adapter can reach the broker and whether the Chrome extension answers `ping`. When ready, `extension.status` and `ping.status` reflect the live bridge connection (not a stale disconnected default), `extension.allowedOrigins` shows the configured scope (including `* (all http/https web origins)` when wildcard mode is enabled), and `protocolVersion` / `features` confirm the loaded unpacked extension code.
- `list_tabs`: lists tabs whose URL origin is allowed in the extension popup. When every open tab is filtered out, returns `{ tabs: [], detail, hiddenTabCount, allowedOrigins? }` instead of a bare `[]`. Wildcard mode is labeled clearly in `allowedOrigins`.
- `snapshot`: returns a simplified DOM snapshot for an allowed tab. By default this is a compact automation snapshot that includes concise actionable elements, a text preview (500 chars), omitted counts, and region summaries. Pass `mode: "full"` for verbose element metadata and a `text` field (4000 chars by default). Pass `textLimit` (up to `100000`) when you need more page body text — check `textBytesOmitted` to see if content was truncated.
- `navigate`: navigates the active tab or a specified `tabId` to an allowed URL, then waits for the tab to finish loading when possible. If loading times out, the result includes `pending: true` and a `warning`.
- `click`: clicks an element by snapshot ref on an allowed tab.
- `type`: types into an element by snapshot ref on an allowed tab. Password-like fields are blocked unless `force=true`.
- `scroll`: scrolls an allowed tab by `deltaX` and `deltaY`.

## Snapshot Modes And Refs

Default compact snapshots are designed to reduce model-context usage while preserving browser automation. A compact snapshot looks like:

```json
{
  "title": "Example Domain",
  "url": "https://example.com/",
  "mode": "compact",
  "elements": [{ "ref": "h1", "role": "link", "label": "Learn more" }],
  "omittedElements": 0,
  "textPreview": "Example Domain ...",
  "textBytesOmitted": 0,
  "regions": []
}
```

Use full mode only when you need the legacy verbose element metadata:

```json
{ "mode": "full", "tabId": 123 }
```

To read long page content (for example API docs), raise `textLimit` instead of using broker scripts or CDP workarounds:

```json
{ "mode": "full", "textLimit": 100000, "tabId": 123 }
```

Compact mode honors `textLimit` too; body text is returned in `textPreview`. When `textBytesOmitted` is greater than zero, increase `textLimit` or scroll the page and snapshot again for below-the-fold content.

Refs are per-document in-memory IDs (`h...`) assigned from element identity, not output order. They remain stable across DOM insertion/reorder in the same document, and `click` / `type` resolve through the content script's ref store. Navigating to a different page loads a new document, so old refs are expected to fail cleanly; take a fresh snapshot after navigation or major page changes. The ref store prunes disconnected, expired, and over-cap entries, and removes stale `data-cbc-ref` attributes so pruned refs cannot be reused accidentally.

## Development Checks

```bash
npm test
npm run build
npm run doctor
npm run benchmark:compact-snapshots
npm audit
```

`npm run benchmark:snapshots` is an alias for the same compact-vs-full benchmark. The benchmark prints compact bytes, full bytes, and reduction percentage; compact mode should stay at least 50% smaller on the dense fixture.

After editing files under `extension/`, reload the unpacked extension on `chrome://extensions` before running browser e2e checks. A stale loaded background service worker can keep serving older behavior; `browser_status` should show the current `protocolVersion` and `features` marker when Chrome has loaded the latest extension code.

## Limitations

- This is a prototype with a shared local token, not multi-user authentication.
- Browser tool calls are serialized globally at the broker.
- Content scripts use DOM snapshots, not the full Chrome accessibility tree.
- Refs are document-scoped in-memory handles. Run `snapshot` again after navigation, reloads, major DOM changes, or stale-ref errors.
- Browser history, bookmark, download, and cookie tools are intentionally not exposed.
- `server/cdp.ts` remains only as an unused development reference and is not wired into the MCP adapter.

## Security

- No default token is accepted. Set `CHROME_BROWSER_CONTROL_TOKEN` to a high-entropy URL-safe value for both the broker and MCP adapter, then paste the same value into the extension popup.
- The broker binds only to loopback hosts: `127.0.0.1`, `localhost`, or `::1`.
- The extension only connects to `ws://127.0.0.1`, `ws://localhost`, or `ws://[::1]` with an optional port.
- Page access is limited by allowed origins configured in the popup. Use explicit entries such as `https://example.com`, or enter `*` to allow all normal `http://` and `https://` web pages. Tabs and page actions outside the configured scope are blocked.
- Optional `CHROME_BROWSER_CONTROL_EXTENSION_ID` pins the broker to one installed extension ID.
- CDP fallback is not supported by the MCP adapter because it bypasses extension pairing.

Never bind the broker to a non-loopback interface or commit tokens, local config files, logs, or personal setup notes.

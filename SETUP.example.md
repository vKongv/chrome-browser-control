# Local Setup Example

Use this as a template for local configuration. For the full onboarding flow (clone → setup → load extension → MCP config → verify), see [Install and Setup](README.md#install-and-setup) in the README.

Keep real tokens and personal paths in your private shell history or ignored local notes.

## Paths

```bash
cd /path/to/chrome-browser-control
npm install
npm run setup
```

`npm run setup` generates `.env.local`, prints the extension path, and prints copy-paste MCP configs for YAML plus Claude/Codex/Cursor-style JSON hosts.

Load the unpacked Chrome extension from:

```text
/path/to/chrome-browser-control/extension
```

After changing extension source files, reload the unpacked extension from `chrome://extensions` before testing. The `browser_status` tool reports `protocolVersion` and `features` from the loaded extension, which helps confirm Chrome is not still running an older background service worker. After manifest permission changes, reload the unpacked extension, open the popup, click "Save and reconnect", and grant any new optional permission prompt.

## Token

Generate a high-entropy URL-safe token:

```bash
node -e "console.log(crypto.randomBytes(32).toString('base64url'))"
```

Use the generated value for both the broker and extension popup. Do not commit it.

## Allowed Origins

In the extension popup, add one origin per line. Examples:

```text
https://example.com
http://localhost:3000
```

Enter `*` to allow all normal `http://` and `https://` pages in the current Chrome profile. The extension stores that as `http://*/*` and `https://*/*` host permissions and does not allow `chrome://`, `file://`, extension pages, or other non-web schemes.

Wildcard mode is convenient for local development, but any MCP client with the pairing token can act on every allowed web page in that profile. Prefer explicit origins when you only need a few sites. Chrome requires `<all_urls>` or `activeTab` for `captureVisibleTab`; this project requests optional `<all_urls>` as a host permission only in wildcard mode, and background checks still block non-http(s) and disallowed URLs.

## Broker

```bash
CHROME_BROWSER_CONTROL_TOKEN='<generated-token>' npm run broker
```

Optional extension ID pinning:

```bash
CHROME_BROWSER_CONTROL_TOKEN='<generated-token>' \
CHROME_BROWSER_CONTROL_EXTENSION_ID='<chrome-extension-id>' \
npm run broker
```

## MCP Adapter

Configure your MCP host to run:

```bash
CHROME_BROWSER_CONTROL_TOKEN='<generated-token>' npm run mcp
```

Print host-specific config snippets with absolute paths:

```bash
npm run --silent mcp-config -- --host yaml
npm run --silent mcp-config -- --host claude
npm run --silent mcp-config -- --host codex
npm run --silent mcp-config -- --host cursor
```

Use an MCP config path appropriate for your tool and keep it outside the repository.

## Snapshot Behavior

`snapshot` defaults to compact mode to keep MCP responses small:

```json
{ "tabId": 123 }
```

Compact snapshots include concise refs/roles/labels, a short text preview, omitted counts, and region summaries. Use full mode for the legacy verbose fields:

```json
{ "tabId": 123, "mode": "full" }
```

Use visible mode when the viewport matters:

```json
{ "tabId": 123, "mode": "visible" }
```

Refs are per-document in-memory IDs (`h...`). They are stable across DOM reorder in the same document, but navigation/reload creates a new document; take a fresh snapshot after page changes or stale-ref errors. The content script prunes expired and over-cap refs so memory stays bounded.

For multi-step tasks, call `claim_tab` with an allowed tab id and pass the returned `sessionTabId` to page tools. Use `release_tab` or `finalize_tabs` when done. Claims are routing state only; they do not close or lock tabs.

## Development Checks

```bash
npm test
npm run build
npm run benchmark:compact-snapshots
```

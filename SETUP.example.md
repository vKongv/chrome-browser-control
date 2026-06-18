# Local Setup Example

Use this as a template for local configuration. Keep real tokens and personal paths in your private shell history or ignored local notes.

## Paths

```bash
cd /path/to/chrome-browser-control
npm install
npm run setup
```

`npm run setup` generates `.env.local`, prints the extension path, and prints copy-paste MCP configs for Hermes plus Claude/Codex/Cursor-style JSON hosts.

Load the unpacked Chrome extension from:

```text
/path/to/chrome-browser-control/extension
```

After changing extension source files, reload the unpacked extension from `chrome://extensions` before testing. The `browser_status` tool reports `protocolVersion` and `features` from the loaded extension, which helps confirm Chrome is not still running an older background service worker.

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

Wildcard mode is convenient for local development, but any MCP client with the pairing token can act on every allowed web page in that profile. Prefer explicit origins when you only need a few sites.

## Broker

```bash
HERMES_CHROME_TOKEN='<generated-token>' npm run broker
```

Optional extension ID pinning:

```bash
HERMES_CHROME_TOKEN='<generated-token>' \
HERMES_CHROME_EXTENSION_ID='<chrome-extension-id>' \
npm run broker
```

## MCP Adapter

Configure your MCP host to run:

```bash
HERMES_CHROME_TOKEN='<generated-token>' npm run mcp
```

Print host-specific config snippets with absolute paths:

```bash
npm run --silent mcp-config -- --host hermes
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

Refs are per-document in-memory IDs (`h...`). They are stable across DOM reorder in the same document, but navigation/reload creates a new document; take a fresh snapshot after page changes or stale-ref errors. The content script prunes expired and over-cap refs so memory stays bounded.

## Development Checks

```bash
npm test
npm run build
npm run benchmark:compact-snapshots
```

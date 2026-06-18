# Chrome Browser Control Prototype Plan

## Goal

Build a local prototype that lets an MCP client control the current Chrome profile through a Chrome extension and loopback broker.

## Current Architecture

- Manifest V3 extension under `extension/`.
- Local WebSocket broker under `server/broker.ts`, started with `npm run broker`.
- Stdio MCP adapter under `server/index.ts`, started by an MCP host with `npm run mcp`.
- Shared pairing token supplied through the legacy/current `HERMES_CHROME_TOKEN` env var and the extension popup.
- Explicit allowed origins configured in the popup before tabs or page actions are exposed.

## Security Requirements

- No default token in runtime paths.
- Broker binds only to loopback hosts.
- Extension connects only to loopback `ws://` bridge URLs.
- Manifest must not request universal host permissions.
- Optional broker-side extension ID pinning through legacy/current `HERMES_CHROME_EXTENSION_ID`.
- CDP fallback is not part of the production MCP adapter path.
- Public docs use placeholders such as `/path/to/chrome-browser-control` and keep private config generic.

## Verification

- `npm test`
- `npm run build`
- `npm audit`
- Leak scans for known tokens, personal paths, and default-token strings.

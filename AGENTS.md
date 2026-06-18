# Chrome Browser Control — Agent Guide

## Purpose

Chrome Browser Control is a local Chrome-profile browser-control MCP server. It exposes browser tools through a Manifest V3 Chrome extension, a loopback WebSocket broker, and a stdio MCP adapter.

Use this file to resume work without relying on chat history.

## Key paths

- `server/` — MCP adapter, broker client, broker, protocol, tools, environment handling.
- `extension/` — Chrome MV3 extension, popup, content script, security helpers.
- `tests/` — Vitest coverage for broker, bridge, protocol, tools, content-core, env, setup scripts.
- `benchmarks/compact-snapshot.mjs` — compact-vs-full snapshot size benchmark.
- `scripts/setup.mjs` — first-time setup helper.
- `scripts/mcp-config.mjs` — host-specific MCP config renderer.
- `scripts/doctor.mjs` — local setup checker.
- `docs/scratchpad/` — implementation notes/plans.

## Current state

- Project/package name: `chrome-browser-control`.
- GitHub repo: `vkongv/chrome-browser-control`.
- Default snapshot mode is compact (500-char `textPreview`).
- Full legacy snapshot mode remains available with `snapshot({ mode: "full" })` (4000-char `text` by default).
- Raise `textLimit` on `snapshot` (up to 100000) to pull more page body text without broker or CDP workarounds.
- Snapshot refs are per-document in-memory handles and are stable across DOM reorder in the same document.
- Stale/disconnected/expired refs are pruned and should fail cleanly.
- First-time setup UX is implemented with `npm run setup`, `npm run doctor`, and `npm run mcp-config`.

## Local setup

```bash
npm install
npm run setup
npm run doctor
```

Load the unpacked extension from:

```text
extension/
```

After editing extension files, reload the unpacked extension in `chrome://extensions` before live browser checks. After editing MCP server files (`server/`, `tools.ts`), restart the MCP server in your host (Cursor: MCP settings → restart `chrome_browser_control`).

## Verification commands

Run before reporting success:

```bash
npm test
npm run build
npm run doctor
npm run benchmark:compact-snapshots
```

Expected benchmark target: compact snapshots should remain at least 50% smaller than full snapshots on the dense fixture. Last verified reduction was 82.74%.

## MCP config generation

Use silent npm output when copying snippets:

```bash
npm run --silent mcp-config -- --host yaml
npm run --silent mcp-config -- --host claude
npm run --silent mcp-config -- --host cursor
npm run --silent mcp-config -- --host codex
```

Host formats:

- YAML: `mcp_servers` with key `chrome_browser_control`.
- Claude/Cursor: JSON `mcpServers`.
- Codex: TOML `[mcp_servers.chrome_browser_control]`.

## Security rules

- Do not commit `.env`, `.env.*`, tokens, local config, logs, or personal setup notes.
- Broker must bind only to loopback hosts.
- Extension may connect only to loopback WebSocket URLs.
- Allowed origins gate tab/page access; wildcard `*` is convenient but broad.
- Password-like fields are blocked unless `force=true`.
- CDP fallback is intentionally unsupported by the MCP adapter.

## Git workflow

- Commit messages use Conventional Commits.
- Do not add AI/tool attribution in commits.
- Remote: `https://github.com/vkongv/chrome-browser-control.git`.
- Main branch: `main`.

## Known caveat

One broker concurrency test has shown occasional timing flakiness under full-suite load, but passed in isolation and on full-suite rerun. If it reappears, investigate test timing/handshake race rather than assuming product behavior changed.

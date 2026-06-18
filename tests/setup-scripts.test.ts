// @ts-nocheck
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MCP_KEY,
  DEFAULT_TOKEN_ENV,
  ensureLocalEnv,
  generateToken,
  readLocalEnv,
  renderConfig
} from '../scripts/setup-lib.mjs';

let tempDirs = [];
function tempRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-mcp-setup-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('setup helpers', () => {
  it('generates high entropy-looking URL-safe tokens', () => {
    const token = generateToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('writes and reuses ignored local env config', () => {
    const root = tempRoot();
    const first = ensureLocalEnv({ root, token: 'abcdefghijklmnopqrstuvwxyzABCDEF0123456789_-' });
    const second = ensureLocalEnv({ root, token: 'differentabcdefghijklmnopqrstuvwxyzABCDEF0123456789' });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
    expect(readLocalEnv(root)[DEFAULT_TOKEN_ENV]).toBe(first.token);
    expect(readFileSync(first.path, 'utf8')).toContain('Do not commit');
  });

  it('renders YAML config with absolute project paths and token', () => {
    const config = renderConfig({ host: 'yaml', root: '/tmp/chrome-mcp', token: 'tok_123456789012345678901234567890', port: '9999' });
    expect(config).toContain('mcp_servers:');
    expect(config).toContain('/tmp/chrome-mcp/server/index.ts');
    expect(config).toContain('CHROME_BROWSER_CONTROL_TOKEN: "tok_123456789012345678901234567890"');
    expect(config).toContain('CHROME_BROWSER_CONTROL_PORT: "9999"');
  });

  it('renders Codex TOML config', () => {
    const config = renderConfig({ host: 'codex', root: '/tmp/chrome-mcp', token: 'tok', port: '8765' });
    expect(config).toContain(`[mcp_servers.${DEFAULT_MCP_KEY}]`);
    expect(config).toContain('command = "/tmp/chrome-mcp/node_modules/.bin/tsx"');
    expect(config).toContain('args = ["/tmp/chrome-mcp/server/index.ts"]');
    expect(config).toContain('CHROME_BROWSER_CONTROL_TOKEN = "tok"');
  });

  it('renders Claude/Cursor-compatible JSON config', () => {
    const config = JSON.parse(renderConfig({ host: 'cursor', root: '/tmp/chrome-mcp', token: 'tok', port: '8765' }));
    expect(config.mcpServers[DEFAULT_MCP_KEY].command).toContain('/tmp/chrome-mcp/node_modules/.bin/tsx');
    expect(config.mcpServers[DEFAULT_MCP_KEY].args).toEqual(['/tmp/chrome-mcp/server/index.ts']);
    expect(config.mcpServers[DEFAULT_MCP_KEY].env.CHROME_BROWSER_CONTROL_TOKEN).toBe('tok');
  });

  it('rejects deprecated hermes host flag', () => {
    expect(() => renderConfig({ host: 'hermes' })).toThrow('Unsupported host: hermes');
  });
});

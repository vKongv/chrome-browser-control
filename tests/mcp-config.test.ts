import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpServerObject, renderConfig, renderJsonConfig, resolveCliCommand } from '../server/mcp-config.js';

const originalPath = process.env.PATH;
let tempBin = '';

afterEach(() => {
  if (tempBin) {
    rmSync(tempBin, { recursive: true, force: true });
    tempBin = '';
  }
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
});

describe('install-mode MCP config rendering', () => {
  it('renders cbctl mcp subcommand when command is provided', () => {
    const cfg = mcpServerObject({
      command: '/usr/local/bin/cbctl',
      args: ['mcp'],
      token: 'tok_123456789012345678901234567890',
      port: '8765'
    });
    expect(cfg.command).toBe('/usr/local/bin/cbctl');
    expect(cfg.args).toEqual(['mcp']);
    expect(cfg.env.CHROME_BROWSER_CONTROL_TOKEN).toBe('tok_123456789012345678901234567890');
  });

  it('renders npx fallback snippet', () => {
    const json = JSON.parse(
      renderJsonConfig({
        command: 'npx',
        args: ['-y', 'chrome-browser-control', 'mcp'],
        token: 'tok',
        port: '8765'
      })
    );
    expect(json.mcpServers.chrome_browser_control.command).toBe('npx');
    expect(json.mcpServers.chrome_browser_control.args).toEqual(['-y', 'chrome-browser-control', 'mcp']);
  });

  it('renders YAML with install layout command', () => {
    const yaml = renderConfig('yaml', {
      command: '/opt/homebrew/bin/cbctl',
      args: ['mcp'],
      token: 'tok',
      port: '8765'
    });
    expect(yaml).toContain('"/opt/homebrew/bin/cbctl"');
    expect(yaml).toContain('"mcp"');
  });

  it('prefers cbctl over chrome-browser-control on PATH', () => {
    tempBin = mkdtempSync(join(tmpdir(), 'cbc-cli-bins-'));
    writeFileSync(join(tempBin, 'cbctl'), '#!/bin/sh\n');
    writeFileSync(join(tempBin, 'chrome-browser-control'), '#!/bin/sh\n');
    // Isolate from any globally installed cbctl on the real PATH.
    process.env.PATH = tempBin;
    const resolved = resolveCliCommand();
    expect(resolved.command).toBe(join(tempBin, 'cbctl'));
    expect(resolved.args).toEqual(['mcp']);
  });

  it('falls back to chrome-browser-control when cbctl is absent', () => {
    tempBin = mkdtempSync(join(tmpdir(), 'cbc-cli-bins-'));
    writeFileSync(join(tempBin, 'chrome-browser-control'), '#!/bin/sh\n');
    process.env.PATH = tempBin;
    const resolved = resolveCliCommand();
    expect(resolved.command).toBe(join(tempBin, 'chrome-browser-control'));
    expect(resolved.args).toEqual(['mcp']);
  });
});

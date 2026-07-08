import { describe, expect, it } from 'vitest';
import { mcpServerObject, renderConfig, renderJsonConfig } from '../server/mcp-config.js';

describe('install-mode MCP config rendering', () => {
  it('renders chrome-browser-control mcp subcommand when command is provided', () => {
    const cfg = mcpServerObject({
      command: '/usr/local/bin/chrome-browser-control',
      args: ['mcp'],
      token: 'tok_123456789012345678901234567890',
      port: '8765'
    });
    expect(cfg.command).toBe('/usr/local/bin/chrome-browser-control');
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
      command: '/opt/homebrew/bin/chrome-browser-control',
      args: ['mcp'],
      token: 'tok',
      port: '8765'
    });
    expect(yaml).toContain('"/opt/homebrew/bin/chrome-browser-control"');
    expect(yaml).toContain('"mcp"');
  });
});

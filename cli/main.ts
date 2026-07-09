#!/usr/bin/env node
import { flagBoolean, parseArgs } from './parse-args.js';
import { runSetup } from './commands/setup.js';
import { runStart } from './commands/start.js';
import { runStop } from './commands/stop.js';
import { runStatus } from './commands/status.js';
import { runDoctor } from './commands/doctor.js';
import { runBroker, runMcp } from './commands/mcp.js';
import { runMcpConfig } from './commands/mcp-config.js';
import { readPackageVersion } from '../server/paths.js';

const HELP = `cbctl — local Chrome browser control MCP

Usage:
  cbctl setup [--force-token] [--start]
  cbctl start
  cbctl stop
  cbctl status
  cbctl doctor
  cbctl version
  cbctl mcp [--autoload]
  cbctl broker
  cbctl mcp-config [--host json|yaml|codex|cursor]
  cbctl --version | -V

Commands:
  setup       Create user config and copy extension to ~/.chrome-browser-control/
  start       Start the shared broker (recommended before MCP)
  stop        Stop the CLI-started broker
  status      Show config, extension, and broker status
  doctor      Verify install layout and broker readiness
  version     Print the installed package version
  mcp         Run the MCP stdio adapter (attach-only by default)
  broker      Run the broker in the foreground (debug)
  mcp-config  Print MCP host config snippets

Also installed as chrome-browser-control (same binary).
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (flagBoolean(args.flags, 'help')) {
    console.log(HELP.trim());
    return 0;
  }
  if (flagBoolean(args.flags, 'version') || args.positional[0] === 'version') {
    console.log(readPackageVersion());
    return 0;
  }
  if (args.positional.length === 0) {
    console.log(HELP.trim());
    return 1;
  }

  const command = args.positional[0];
  switch (command) {
    case 'setup':
      return await runSetup(args);
    case 'start':
      return await runStart(args);
    case 'stop':
      return await runStop(args);
    case 'status':
      return await runStatus(args);
    case 'doctor':
      return await runDoctor(args);
    case 'mcp':
      return await runMcp(args);
    case 'broker':
      return await runBroker(args);
    case 'mcp-config':
      return await runMcpConfig(args);
    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP.trim());
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[cbctl] fatal:', error);
    process.exit(1);
  });

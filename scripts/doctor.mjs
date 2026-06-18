#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { DEFAULT_TOKEN_ENV, extensionPath, nodeBin, readLocalEnv, serverEntry } from './setup-lib.mjs';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
check('Node.js >= 18', nodeMajor >= 18, process.version);
check('Dependencies installed', existsSync(nodeBin()), nodeBin());
check('MCP server entry exists', existsSync(serverEntry()), serverEntry());
check('Chrome extension directory exists', existsSync(extensionPath()), extensionPath());
const local = readLocalEnv();
check(`Local ${DEFAULT_TOKEN_ENV} configured`, typeof local[DEFAULT_TOKEN_ENV] === 'string' && local[DEFAULT_TOKEN_ENV].length >= 32, '.env.local');

let failures = 0;
for (const item of checks) {
  if (!item.ok) failures += 1;
  console.log(`${item.ok ? '✅' : '❌'} ${item.name}${item.detail ? ` — ${item.detail}` : ''}`);
}

if (failures) {
  console.error(`\n${failures} check(s) failed. Run npm install and npm run setup, then reload/configure the extension.`);
  process.exit(1);
}

console.log('\nLocal setup files look ready. To verify the live browser bridge, connect your MCP host and run browser_status.');

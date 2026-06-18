#!/usr/bin/env node
import { ensureLocalEnv, extensionPath, renderConfig, repoRoot } from './setup-lib.mjs';

const setup = ensureLocalEnv();

console.log('Chrome Browser Control setup');
console.log('========================');
console.log(`Local config: ${setup.path} ${setup.created ? '(created)' : '(updated/reused)'}`);
console.log(`Extension path: ${extensionPath(repoRoot)}`);
console.log('');
console.log('1. Load/reload the Chrome extension from the extension path above.');
console.log('2. Open the extension popup and paste this pairing token:');
console.log(`   ${setup.token}`);
console.log('3. Add allowed origins, for example: https://example.com or * for all http/https web pages.');
console.log('4. Add one of these MCP config snippets to your agent.');
console.log('');
console.log('YAML config:');
console.log(renderConfig({ host: 'yaml', token: setup.token, port: setup.port }));
console.log('');
console.log('Claude / Cursor JSON config:');
console.log(renderConfig({ host: 'json', token: setup.token, port: setup.port }));
console.log('');
console.log('Codex TOML config:');
console.log(renderConfig({ host: 'codex', token: setup.token, port: setup.port }));
console.log('');
console.log('Then run: npm run doctor');

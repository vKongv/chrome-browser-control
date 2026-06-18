#!/usr/bin/env node
import { DEFAULT_PORT, DEFAULT_TOKEN_ENV, parseArgs, readLocalEnv, renderConfig } from './setup-lib.mjs';

const args = parseArgs();
const local = readLocalEnv();
const token = args.token || local[DEFAULT_TOKEN_ENV] || '<generated-token>';
const port = args.port || local.HERMES_CHROME_PORT || DEFAULT_PORT;
const host = args.host || 'json';

console.log(renderConfig({ host, token, port }));

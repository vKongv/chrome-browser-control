import { chmodSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// tsc does not preserve or set file modes, so dist/cli/main.js loses its
// executable bit on every build. That breaks `npm link` locally, because the
// linked `cbctl` / `chrome-browser-control` bins point straight at this file.
// Published installs are unaffected: npm sets the executable bit on `bin`
// entries itself at install time.
//
// fs.chmodSync (rather than a shell `chmod +x` step in the build script) is
// used here so `npm run build` keeps working on Windows shells, where chmod
// is not available. chmodSync is a safe no-op there.
export const CLI_BIN_PATH = 'dist/cli/main.js';
const EXECUTABLE_MODE = 0o755;

function main() {
  const target = resolve(CLI_BIN_PATH);
  chmodSync(target, EXECUTABLE_MODE);
  const mode = statSync(target).mode & 0o777;
  if ((mode & 0o111) === 0) {
    console.error(`${CLI_BIN_PATH} is still not executable after chmod (mode ${mode.toString(8)})`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

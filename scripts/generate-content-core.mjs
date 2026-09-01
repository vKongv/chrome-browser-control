import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const GENERATED_HEADER = '// Generated from extension/content-core.module.js; do not edit.\n\n';

export function generateContentCore(source) {
  // This is intentionally line-based and does not distinguish export text inside strings or comments.
  const transformed = source
    .split('\n')
    .map((line, index) => {
      if (!/^export\b/.test(line)) return line;
      if (!/^export (?=(?:function|async function|const|let|var|class)\b)/.test(line)) {
        throw new Error(`Unsupported export form on line ${index + 1}: ${line}`);
      }
      return line.replace(/^export /, '');
    })
    .join('\n');

  return `${GENERATED_HEADER}${transformed}`;
}

function main() {
  const sourcePath = resolve('extension/content-core.module.js');
  const outputPath = resolve('extension/content-core.js');
  const generated = generateContentCore(readFileSync(sourcePath, 'utf8'));

  if (process.argv.includes('--check')) {
    const current = readFileSync(outputPath, 'utf8');
    if (current !== generated) {
      console.error('extension/content-core.js is out of date; run npm run build');
      process.exitCode = 1;
    }
    return;
  }

  writeFileSync(outputPath, generated);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getInstalledExtensionPath, getInstalledVersionPath, getPackagedExtensionPath } from '../server/paths.js';

function copyRecursive(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const srcPath = join(source, entry.name);
    const destPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      writeFileSync(destPath, readFileSync(srcPath));
    }
  }
}

export interface CopyExtensionResult {
  path: string;
  refreshed: boolean;
  previousVersion?: string;
  version: string;
}

export function copyExtensionToUserDir(packageVersion: string): CopyExtensionResult {
  const source = getPackagedExtensionPath();
  const destination = getInstalledExtensionPath();
  const versionPath = getInstalledVersionPath();
  const previousVersion = existsSync(versionPath) ? readFileSync(versionPath, 'utf8').trim() : undefined;
  const refreshed = previousVersion !== packageVersion || !existsSync(join(destination, 'manifest.json'));

  if (existsSync(destination)) {
    rmSync(destination, { recursive: true, force: true });
  }
  copyRecursive(source, destination);
  writeFileSync(versionPath, `${packageVersion}\n`);

  return { path: destination, refreshed, previousVersion, version: packageVersion };
}

export function extensionCopyLooksValid(): boolean {
  const manifest = join(getInstalledExtensionPath(), 'manifest.json');
  return existsSync(manifest) && statSync(manifest).isFile();
}

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getInstalledExtensionPath, getInstalledVersionPath, getPackagedExtensionPath } from '../server/paths.js';

export type ExtensionCopyState = 'absent' | 'stale' | 'current';

export interface ExtensionCopyStatus {
  state: ExtensionCopyState;
  differingFiles: string[];
}

type ExtensionTreeEntry =
  | { kind: 'directory' }
  | { kind: 'file'; content: Buffer };

function readExtensionTree(root: string): Map<string, ExtensionTreeEntry> {
  const tree = new Map<string, ExtensionTreeEntry>();

  function walk(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        tree.set(relativePath, { kind: 'directory' });
        walk(absolutePath, relativePath);
      } else {
        tree.set(relativePath, { kind: 'file', content: readFileSync(absolutePath) });
      }
    }
  }

  walk(root, '');
  return tree;
}

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

export function getExtensionCopyStatus(): ExtensionCopyStatus {
  const packagedPath = getPackagedExtensionPath();
  const installedPath = getInstalledExtensionPath();

  if (!existsSync(installedPath) || !statSync(installedPath).isDirectory()) {
    return { state: 'absent', differingFiles: [] };
  }

  const packagedTree = readExtensionTree(packagedPath);
  const installedTree = readExtensionTree(installedPath);
  const paths = new Set([...packagedTree.keys(), ...installedTree.keys()]);
  const differingFiles = [...paths]
    .sort()
    .filter((path) => {
      const packagedEntry = packagedTree.get(path);
      const installedEntry = installedTree.get(path);
      if (!packagedEntry || !installedEntry || packagedEntry.kind !== installedEntry.kind) return true;
      if (packagedEntry.kind === 'directory') return false;
      if (installedEntry.kind !== 'file') return true;
      return !packagedEntry.content.equals(installedEntry.content);
    });

  return {
    state: differingFiles.length ? 'stale' : 'current',
    differingFiles
  };
}

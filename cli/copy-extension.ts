import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, type Dirent, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getInstalledExtensionPath, getInstalledVersionPath, getPackagedExtensionPath } from '../server/paths.js';

export type ExtensionCopyState = 'absent' | 'stale' | 'current';

export interface ExtensionCopyStatus {
  state: ExtensionCopyState;
  differingFiles: string[];
  inspectionProblems?: string[];
}

type ExtensionTreeEntry =
  | { kind: 'directory' }
  | { kind: 'file'; content: Buffer }
  | { kind: 'symlink' }
  | { kind: 'unreadable' };

interface ExtensionTreeProblem {
  path: string;
  detail: string;
}

interface ExtensionTreeResult {
  tree: Map<string, ExtensionTreeEntry>;
  problems: ExtensionTreeProblem[];
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function formatFileSystemProblem(side: string, path: string, action: string, error: unknown): string {
  const reason = errorCode(error) ?? (error instanceof Error ? error.message : String(error));
  return `${side} extension copy ${path || '.'}: unable to ${action}${reason ? ` (${reason})` : ''}`;
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function readExtensionTree(root: string, side: string): ExtensionTreeResult {
  const tree = new Map<string, ExtensionTreeEntry>();
  const problems: ExtensionTreeProblem[] = [];

  function walk(directory: string, prefix: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      problems.push({
        path: prefix || '.',
        detail: formatFileSystemProblem(side, prefix, 'read directory', error)
      });
      return;
    }

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        tree.set(relativePath, { kind: 'symlink' });
        problems.push({
          path: relativePath,
          detail: `${side} extension copy ${relativePath}: symbolic link treated as a stale difference (not followed)`
        });
      } else if (entry.isDirectory()) {
        tree.set(relativePath, { kind: 'directory' });
        walk(absolutePath, relativePath);
      } else {
        try {
          tree.set(relativePath, { kind: 'file', content: readFileSync(absolutePath) });
        } catch (error) {
          tree.set(relativePath, { kind: 'unreadable' });
          problems.push({
            path: relativePath,
            detail: formatFileSystemProblem(side, relativePath, 'read file', error)
          });
        }
      }
    }
  }

  walk(root, '');
  return { tree, problems };
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

  let installedIsDirectory = false;
  try {
    installedIsDirectory = statSync(installedPath).isDirectory();
  } catch (error) {
    if (!isMissingPathError(error)) {
      const detail = formatFileSystemProblem('installed', '.', 'inspect extension directory', error);
      return { state: 'stale', differingFiles: ['.'], inspectionProblems: [detail] };
    }
  }

  if (!installedIsDirectory) {
    return { state: 'absent', differingFiles: [] };
  }

  const packagedResult = readExtensionTree(packagedPath, 'packaged');
  const installedResult = readExtensionTree(installedPath, 'installed');
  const paths = new Set([...packagedResult.tree.keys(), ...installedResult.tree.keys()]);
  const differingFiles = new Set(
    [...paths].filter((path) => {
      const packagedEntry = packagedResult.tree.get(path);
      const installedEntry = installedResult.tree.get(path);
      if (!packagedEntry || !installedEntry || packagedEntry.kind !== installedEntry.kind) return true;
      if (packagedEntry.kind !== 'file' || installedEntry.kind !== 'file') return false;
      return !packagedEntry.content.equals(installedEntry.content);
    })
  );
  const problems = [...packagedResult.problems, ...installedResult.problems];
  for (const problem of problems) differingFiles.add(problem.path);
  const sortedDifferingFiles = [...differingFiles].sort();
  const inspectionProblems = problems.map((problem) => problem.detail);

  return {
    state: sortedDifferingFiles.length || inspectionProblems.length ? 'stale' : 'current',
    differingFiles: sortedDifferingFiles,
    ...(inspectionProblems.length ? { inspectionProblems } : {})
  };
}

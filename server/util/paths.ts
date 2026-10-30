import fs from 'node:fs';
import path from 'node:path';

export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`Path escapes the workspace and was rejected: ${requested}`);
    this.name = 'PathEscapeError';
  }
}

/** Directories the agent, search and file tree all ignore. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.genie',
  '.venv',
  '__pycache__',
]);

export function isIgnoredPath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  return parts.some((part) => IGNORED_DIRS.has(part));
}

/**
 * Resolve a user/agent supplied path inside the workspace.
 * Rejects absolute paths that point outside and `..` traversal, including via
 * symlinks when the target already exists.
 */
export function resolveInWorkspace(workspaceRoot: string, requested: string): string {
  const root = path.resolve(workspaceRoot);
  const raw = requested ?? '';
  if (raw.includes('\0')) throw new PathEscapeError(requested);

  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new PathEscapeError(requested);

  const rootReal = safeRealpath(root);
  const candidateReal = safeRealpath(candidate);
  const relReal = path.relative(rootReal, candidateReal);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new PathEscapeError(requested);

  return candidate;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    // Path does not exist yet (e.g. a file about to be created): check the
    // closest existing ancestor instead.
    let current = p;
    for (let i = 0; i < 40; i += 1) {
      const parent = path.dirname(current);
      if (parent === current) return p;
      try {
        return path.join(fs.realpathSync(parent), path.relative(parent, p));
      } catch {
        current = parent;
      }
    }
    return p;
  }
}

export function toRelative(workspaceRoot: string, absolute: string): string {
  return path.relative(path.resolve(workspaceRoot), absolute).split(path.sep).join('/');
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

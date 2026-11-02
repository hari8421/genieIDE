import fs from 'node:fs/promises';
import path from 'node:path';
import { isIgnoredPath, toRelative } from '../util/paths';

/**
 * Collect the TypeScript/JavaScript sources of a workspace so the editor's
 * language service (Monaco's TS worker) can resolve symbols across files.
 *
 * This is what makes "peek definition", "find usages" and cross-file hover
 * work: the worker only knows the models it has been given, so every source is
 * handed over as an extra lib. The walk is bounded on purpose — a workspace of
 * 50k files must not turn a keystroke into a 200 MB download.
 */

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const MAX_FILE_BYTES = 400_000;

export interface SourceFile {
  path: string;
  content: string;
}

export interface SourceBundle {
  root: string;
  files: SourceFile[];
  truncated: boolean;
  bytes: number;
}

export interface CollectOptions {
  maxFiles?: number;
  maxBytes?: number;
}

export async function collectSources(root: string, options: CollectOptions = {}): Promise<SourceBundle> {
  const maxFiles = options.maxFiles ?? 600;
  const maxBytes = options.maxBytes ?? 3_000_000;
  const files: SourceFile[] = [];
  let bytes = 0;
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated || depth > 12) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const absolute = path.join(dir, entry.name);
      const relative = toRelative(root, absolute);
      if (!relative || isIgnoredPath(relative)) continue;
      if (entry.isDirectory()) {
        await walk(absolute, depth + 1);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      if (files.length >= maxFiles || bytes >= maxBytes) {
        truncated = true;
        return;
      }
      try {
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(absolute, 'utf8');
        bytes += content.length;
        files.push({ path: relative, content });
      } catch {
        // Unreadable file (permissions, race): skipping it is better than failing
        // the whole bundle.
      }
    }
  };

  await walk(path.resolve(root), 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root: path.resolve(root), files, truncated, bytes };
}

/** True when the file is one the language service can reason about. */
export function isSourceFile(file: string): boolean {
  return SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

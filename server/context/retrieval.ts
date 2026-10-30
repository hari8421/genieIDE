import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isIgnoredPath } from '../util/paths';

export interface RetrievedFile {
  path: string;
  score: number;
  snippet: string;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'into', 'when', 'then', 'than',
  'but', 'not', 'you', 'your', 'are', 'was', 'were', 'all', 'any', 'can', 'should', 'would',
  'add', 'make', 'use', 'using', 'need', 'want', 'please', 'file', 'code',
]);

export function tokenizeQuery(query: string): string[] {
  const seen = new Set<string>();
  for (const raw of (query ?? '').toLowerCase().split(/[^a-z0-9_$]+/)) {
    if (raw.length < 3 || STOP_WORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen].slice(0, 24);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1 && count < 50) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Lexical relevance scoring. Filename hits dominate (a term in the file name is
 * a stronger signal than one mention in a long file), then term frequency,
 * damped by file size so huge generated files do not dominate.
 */
export function scoreFile(relativePath: string, content: string, terms: string[]): number {
  if (!terms.length) return 0;
  const lowerPath = relativePath.toLowerCase();
  const lowerContent = content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (lowerPath.includes(term)) score += 6;
    const hits = countOccurrences(lowerContent, term);
    if (hits) score += 1 + Math.log2(hits + 1) * 2;
  }
  if (score === 0) return 0;
  const sizePenalty = 1 + Math.log2(1 + content.length / 8000);
  return score / sizePenalty;
}

export function snippetAround(content: string, terms: string[], radius = 220): string {
  const lower = content.toLowerCase();
  let best = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (best === -1 || index < best)) best = index;
  }
  if (best < 0) return content.slice(0, radius * 2);
  const start = Math.max(0, best - radius);
  const end = Math.min(content.length, best + radius);
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

export interface RetrieveOptions {
  limit?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
}

export async function retrieveFiles(
  workspaceRoot: string,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievedFile[]> {
  const terms = tokenizeQuery(query);
  if (!terms.length) return [];
  const limit = options.limit ?? 8;
  const maxFiles = options.maxFiles ?? 3000;
  const maxFileBytes = options.maxFileBytes ?? 160_000;

  const candidates: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || candidates.length >= maxFiles) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (candidates.length >= maxFiles || options.signal?.aborted) return;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(workspaceRoot, absolute).split(path.sep).join('/');
      if (isIgnoredPath(relative)) continue;
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else if (entry.isFile()) candidates.push(relative);
    }
  };
  await walk(workspaceRoot, 0);

  const results: RetrievedFile[] = [];
  for (const relative of candidates) {
    if (options.signal?.aborted) break;
    const absolute = path.join(workspaceRoot, relative);
    let stat: Stats;
    try {
      stat = await fs.stat(absolute);
    } catch {
      continue;
    }
    if (stat.size > maxFileBytes || stat.size === 0) continue;
    let content: string;
    try {
      content = await fs.readFile(absolute, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue; // binary
    const score = scoreFile(relative, content, terms);
    if (score <= 0) continue;
    results.push({ path: relative, score, snippet: snippetAround(content, terms) });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

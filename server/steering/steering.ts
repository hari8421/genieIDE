import fs from 'node:fs/promises';
import path from 'node:path';
import type { ContextSection } from '../context/builder';
import { matchesAnyGlob } from '../util/glob';

export type SteeringInclusion = 'always' | 'manual' | 'auto';

export interface SteeringFile {
  name: string;
  file: string;
  inclusion: SteeringInclusion;
  globs: string[];
  content: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of text.slice(3, end).split('\n')) {
    const match = line.match(/^\s*([a-zA-Z_-]+)\s*:\s*(.*)$/);
    if (match) meta[match[1]!.toLowerCase()] = match[2]!.trim().replace(/^["']|["']$/g, '');
  }
  const bodyStart = text.indexOf('\n', end + 4);
  return { meta, body: bodyStart >= 0 ? text.slice(bodyStart + 1) : '' };
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  const cleaned = value.replace(/^\[|\]$/g, '');
  return cleaned
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

export function parseSteering(raw: string, name: string, file = ''): SteeringFile {
  const { meta, body } = parseFrontmatter(raw);
  const inclusionRaw = (meta.inclusion ?? meta.mode ?? 'always').toLowerCase();
  const inclusion: SteeringInclusion =
    inclusionRaw === 'manual' ? 'manual' : inclusionRaw === 'auto' ? 'auto' : 'always';
  return {
    name,
    file,
    inclusion,
    globs: parseList(meta.globs ?? meta.files ?? meta.patterns),
    content: body.trim(),
  };
}

export async function loadSteering(dir: string): Promise<SteeringFile[]> {
  let names: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name);
  } catch {
    return [];
  }
  const files: SteeringFile[] = [];
  for (const name of names.sort()) {
    const full = path.join(dir, name);
    try {
      const raw = await fs.readFile(full, 'utf8');
      const parsed = parseSteering(raw, name.replace(/\.md$/, ''), full);
      if (parsed.content) files.push(parsed);
    } catch {
      // unreadable steering file: skip rather than break the run
    }
  }
  return files;
}

/** `always` steering is unconditional; `auto` gets pulled in by active file globs. */
export function selectSteering(files: SteeringFile[], activePaths: string[] = []): SteeringFile[] {
  return files.filter((file) => {
    if (file.inclusion === 'always') return true;
    if (file.inclusion === 'manual') return false;
    if (!file.globs.length) return true;
    return activePaths.some((p) => matchesAnyGlob(p, file.globs));
  });
}

export function steeringSections(files: SteeringFile[]): ContextSection[] {
  return files.map((file, index) => ({
    id: `steering:${file.name}`,
    kind: 'steering' as const,
    title: `Steering: ${file.name}`,
    content: file.content,
    priority: 95 - index,
    pinned: file.inclusion === 'always',
  }));
}

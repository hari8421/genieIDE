import fs from 'node:fs';
import type { Fact, Geneproperties } from './types';

export interface CoreSnapshot {
  readonly text: string;
  readonly lineCount: number;
  readonly bytes: number;
}

export function coreSnapshot(text: string): CoreSnapshot {
  const lines = text.split('\n').filter(Boolean);
  return { text, lineCount: lines.length, bytes: Buffer.byteLength(text, 'utf8') };
}

export function absoluteCoreLines(corePath: string): string[] {
  try {
    const raw = fs.readFileSync(corePath, 'utf8');
    return raw.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function pruneStaleCore(_corePath: string, _ts: number, _settings: Geneproperties): Promise<void> {
  // Future: remove facts older than `ts`, bounded by maxCoreLines.
  // Kept minimal for now so the module compiles and the journal is usable.
  return Promise.resolve();
}

export function mergeFactsIntoCore(core: string, facts: readonly Fact[], settings: Geneproperties): string | null {
  if (facts.length === 0) return null;
  const maxLines = settings.maxCoreLines;
  const existing = core.trim();
  const header = existing ? `\n\n# pinned memory (auto-merged)\n` : '# pinned memory (auto-merged)\n';
  const additions = facts.map((f) => `- ${f.key}: ${f.value}`).join('\n');
  const updated = [existing, header, additions].filter(Boolean).join('\n');
  const trimmed = limitLines(updated, maxLines);
  return trimmed !== core ? trimmed : null;
}

function limitLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n');
}

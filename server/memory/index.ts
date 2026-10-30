import fs from 'node:fs';
import promises from 'node:fs/promises';
import path from 'node:path';
import type { Fact, MemoryIndex as MemoryIndexType } from './types';

const FACTS_PATH = 'facts.jsonl';

export class MemoryIndex implements MemoryIndexType {
  private readonly factsPath: string;

  constructor(root: string) {
    this.factsPath = path.join(root, FACTS_PATH);
  }

  async factCount(): Promise<number> {
    try {
      const raw = await promises.readFile(this.factsPath, 'utf8');
      return raw.split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  async query(tag: string): Promise<readonly Fact[]> {
    try {
      const raw = await promises.readFile(this.factsPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const facts: Fact[] = [];
      for (const line of lines) {
        const fact: Fact = JSON.parse(line);
        if (tag && (fact.tags ?? []).indexOf(tag) === -1) continue;
        facts.push(fact);
      }
      return facts;
    } catch {
      return [];
    }
  }

  async addAll(facts: readonly Fact[]): Promise<void> {
    if (facts.length === 0) return;
    const seen = new Set(this.currentKeys());
    const toWrite = facts.filter((f) => !seen.has(f.key) && f.key && f.value);
    if (toWrite.length === 0) return;
    await promises.appendFile(this.factsPath, toWrite.map((f) => JSON.stringify(f)).join('\n') + '\n');
  }

  private currentKeys(): string[] {
    try {
      const raw = fs.readFileSync(this.factsPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      return lines.map((line: string) => {
        try {
          const fact = JSON.parse(line) as { key?: string };
          return fact.key ?? '';
        } catch {
          return '';
        }
      });
    } catch {
      return [];
    }
  }

  sweep(): void {
    // idle maintenance placeholder
  }

  async pruneEventsBefore(_ts: number): Promise<void> {
    // The hard deletable history is the events log; facts remain durable.
  }
}

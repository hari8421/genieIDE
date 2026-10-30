import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CheckpointStore } from '../server/agent/checkpoints';
import { listRuns, RunJournal } from '../server/agent/journal';
import { readFile, tempDir, writeFiles } from './helpers';

describe('RunJournal', () => {
  it('persists ordered entries and reloads them', async () => {
    const root = await tempDir();
    const journal = await RunJournal.create(root, 'run-a');
    await journal.append('run.start', { data: { goal: 'build it' } });
    await journal.append('assistant', { step: 0, key: 'step:0:assistant', data: { content: 'hi' } });
    await journal.append('step.complete', { step: 0, key: 'step:0:done' });

    const reopened = await RunJournal.open(root, 'run-a');
    expect(reopened.all).toHaveLength(3);
    expect(reopened.hasKey('step:0:done')).toBe(true);
    expect(reopened.completedSteps()).toEqual([0]);
    expect(reopened.summary().goal).toBe('build it');
    expect(reopened.summary().status).toBe('running');
  });

  it('ignores a torn trailing line from a killed process', async () => {
    const root = await tempDir();
    const journal = await RunJournal.create(root, 'run-b');
    await journal.append('run.start', { data: { goal: 'x' } });
    await fs.appendFile(path.join(root, 'run-b', 'journal.jsonl'), '{"seq":2,"type":"assist');

    const reopened = await RunJournal.open(root, 'run-b');
    expect(reopened.all).toHaveLength(1);
  });

  it('reports completion and replays assistant/tool messages', async () => {
    const root = await tempDir();
    const journal = await RunJournal.create(root, 'run-c');
    await journal.append('run.start', { data: { goal: 'g' } });
    await journal.append('assistant', { step: 0, data: { content: 'reading', toolCalls: [{ id: '1' }] } });
    await journal.append('tool.result', { step: 0, data: { name: 'read_file', ok: true, content: 'contents' } });
    await journal.append('run.end', { data: { status: 'completed' } });

    const reopened = await RunJournal.open(root, 'run-c');
    expect(reopened.summary().status).toBe('completed');
    const messages = reopened.replayMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: 'tool', content: 'contents' });

    const runs = await listRuns(root);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe('run-c');
  });

  it('fails clearly for an unknown run', async () => {
    const root = await tempDir();
    await expect(RunJournal.open(root, 'missing')).rejects.toThrow(/not found/);
  });
});

describe('CheckpointStore', () => {
  it('snapshots, diffs and restores the workspace', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'a.txt': 'one', 'b.txt': 'two', 'src/c.ts': 'export const c = 1;' });
    const store = new CheckpointStore(root);

    const manifest = await store.create('before edits');
    expect(manifest.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt', 'src/c.ts']);

    await fs.writeFile(path.join(root, 'a.txt'), 'one changed');
    await fs.writeFile(path.join(root, 'new.txt'), 'brand new');
    await fs.rm(path.join(root, 'b.txt'));

    const diff = await store.diff(manifest.id);
    const byPath = new Map(diff.map((entry) => [entry.path, entry.change]));
    expect(byPath.get('a.txt')).toBe('modified');
    expect(byPath.get('new.txt')).toBe('added');
    expect(byPath.get('b.txt')).toBe('deleted');

    const restored = await store.restore(manifest.id);
    expect(restored.restored.sort()).toEqual(['a.txt', 'b.txt']);
    expect(restored.deleted).toEqual(['new.txt']);
    expect(await readFile(root, 'a.txt')).toBe('one');
    expect(await readFile(root, 'b.txt')).toBe('two');
    await expect(fs.stat(path.join(root, 'new.txt'))).rejects.toThrow();
  });

  it('ignores its own storage and node_modules', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'src/index.ts': 'x', 'node_modules/pkg/index.js': 'y', '.genie/runs/r/journal.jsonl': '{}' });
    const store = new CheckpointStore(root);
    const manifest = await store.create('skip ignored');
    expect(manifest.files.map((f) => f.path)).toEqual(['src/index.ts']);
  });

  it('lists newest first and prunes old snapshots', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'a.txt': 'one' });
    const store = new CheckpointStore(root);
    await store.create('first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.create('second');

    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list[0]!.label).toBe('second');

    const pruned = await store.prune(1);
    expect(pruned).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);
  });
});

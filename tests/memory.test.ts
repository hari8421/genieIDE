import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMemory } from '../server/memory';

let root: string;
let memory: AgentMemory;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'genie-memory-'));
  memory = new AgentMemory(root);
  await memory.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('AgentMemory', () => {
  it('persists facts and renders them into the pinned core', async () => {
    await memory.addFact({ key: 'test command', value: 'npm test' });
    await memory.addFact({ key: 'style', value: 'no default exports' });

    const facts = await memory.listFacts();
    expect(facts.map((fact) => fact.key)).toEqual(['test command', 'style']);

    const core = await memory.readCore();
    expect(core).toContain('test command: npm test');
    expect(core).toContain('style: no default exports');
  });

  it('replaces a fact with the same key instead of duplicating it', async () => {
    await memory.addFact({ key: 'build', value: 'vite build' });
    await memory.addFact({ key: 'build', value: 'npm run build' });

    const facts = await memory.listFacts();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.value).toBe('npm run build');
    expect(await memory.readCore()).not.toContain('vite build');
  });

  it('forgets a fact and removes it from the core', async () => {
    await memory.addFact({ key: 'gone', value: 'obsolete instruction' });

    expect(await memory.forgetFact('gone')).toBe(true);
    expect(await memory.forgetFact('gone')).toBe(false);
    expect(await memory.readCore()).not.toContain('obsolete instruction');
  });

  it('rejects facts without a key or value', async () => {
    await expect(memory.addFact({ key: ' ', value: 'x' })).rejects.toThrow(/key/);
    await expect(memory.addFact({ key: 'x', value: '  ' })).rejects.toThrow(/value/);
  });

  it('caps the pinned core at maxCoreLines', async () => {
    const small = new AgentMemory(root, { maxCoreLines: 10 });
    await small.init();
    for (let i = 0; i < 30; i += 1) await small.addFact({ key: `fact-${i}`, value: `value ${i}` });

    const core = await small.readCore();
    expect(core.split('\n').length).toBeLessThanOrEqual(11);
    expect(core).toContain('not shown');
  });

  it('records run outcomes as events and prunes the oldest', async () => {
    for (let i = 0; i < 5; i += 1) {
      await memory.appendEvent({ kind: 'run.end', runId: `run-${i}`, ts: i, body: 'done' });
    }

    expect(await memory.eventCount()).toBe(5);
    expect((await memory.readEvents(2)).map((event) => event.runId)).toEqual(['run-3', 'run-4']);
    expect(await memory.prune(2)).toBe(3);
    expect(await memory.eventCount()).toBe(2);

    const snapshot = await memory.snapshot();
    expect(snapshot.events).toBe(2);
    expect(snapshot.facts).toEqual([]);
  });

  it('summarises nothing remembered yet without throwing', async () => {
    const empty = new AgentMemory(path.join(root, 'fresh'));
    expect(await empty.readCore()).toBe('');
    expect(await empty.listFacts()).toEqual([]);
    const snapshot = await empty.snapshot();
    expect(snapshot).toMatchObject({ core: '', events: 0, coreLines: 0, coreBytes: 0 });
  });
});

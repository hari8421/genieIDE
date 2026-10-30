import { describe, expect, it } from 'vitest';
import { HookEngine, loadHooks, matchesHook, validateHook, type HookDefinition } from '../server/hooks/hooks';
import { SpecStore, parseTasks, setTaskChecked, slugify, taskProgress } from '../server/spec/spec';
import { parseSteering, selectSteering } from '../server/steering/steering';
import { matchesGlob } from '../server/util/glob';
import { tempDir, writeFiles } from './helpers';

describe('glob matching', () => {
  it('handles stars, double stars and single characters', () => {
    expect(matchesGlob('src/a.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('a.ts', '**/*.ts')).toBe(true);
    expect(matchesGlob('src/nested/deep/b.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlob('docs/a.md', '*.md')).toBe(false);
    expect(matchesGlob('a.md', '*.md')).toBe(true);
    expect(matchesGlob('a1.ts', 'a?.ts')).toBe(true);
    expect(matchesGlob('a12.ts', 'a?.ts')).toBe(false);
  });
});

describe('hooks', () => {
  const hook = (overrides: Partial<HookDefinition> = {}): HookDefinition => ({
    name: 'test',
    when: { type: 'fileEdited', patterns: ['src/**/*.ts'] },
    then: { type: 'command', command: 'echo hi' },
    ...overrides,
  });

  it('validates definitions and rejects bad actions', () => {
    expect(validateHook({ name: 'a', when: { type: 'agentStop' }, then: { type: 'agent', prompt: 'x' } }).name).toBe('a');
    expect(() => validateHook({ when: { type: 'nope' }, then: { type: 'command', command: 'x' } })).toThrow(/unknown event/);
    expect(() => validateHook({ when: { type: 'manual' }, then: { type: 'agent' } })).toThrow(/prompt/);
  });

  it('matches by event type and path pattern', () => {
    expect(matchesHook(hook(), { type: 'fileEdited', path: 'src/app.ts' })).toBe(true);
    expect(matchesHook(hook(), { type: 'fileEdited', path: 'docs/readme.md' })).toBe(false);
    expect(matchesHook(hook(), { type: 'fileCreated', path: 'src/app.ts' })).toBe(false);
    expect(matchesHook(hook({ enabled: false }), { type: 'fileEdited', path: 'src/app.ts' })).toBe(false);
  });

  it('does not fire path-scoped hooks for non-file events', () => {
    expect(matchesHook(hook(), { type: 'agentStop' })).toBe(false);
    const global = hook({ when: { type: 'agentStop' } });
    expect(matchesHook(global, { type: 'agentStop' })).toBe(true);
  });

  it('isolates failures so one broken hook cannot block others', async () => {
    const engine = new HookEngine(
      [hook({ name: 'good' }), hook({ name: 'bad' }), hook({ name: 'off', enabled: false })],
      async (definition) => {
        if (definition.name === 'bad') throw new Error('boom');
        return { ok: true, detail: 'ran' };
      },
    );
    const results = await engine.dispatch({ type: 'fileEdited', path: 'src/app.ts' });
    expect(results.map((r) => r.hook)).toEqual(['good', 'bad']);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: false, error: 'boom' });
  });

  it('loads hooks from disk and reports parse errors without throwing', async () => {
    const dir = await tempDir();
    await writeFiles(dir, {
      'lint.json': JSON.stringify({ name: 'lint', when: { type: 'fileEdited', patterns: ['**/*.ts'] }, then: { type: 'command', command: 'npm run lint' } }),
      'broken.json': '{ not json',
    });
    const loaded = await loadHooks(dir);
    expect(loaded).toHaveLength(2);
    expect(loaded.filter((entry) => entry.error)).toHaveLength(1);
    expect(loaded.find((entry) => entry.hook.name === 'lint')?.hook.then).toMatchObject({ type: 'command' });
  });
});

describe('steering files', () => {
  it('parses frontmatter and inclusion modes', () => {
    const parsed = parseSteering('---\ninclusion: auto\nglobs: ["src/**/*.ts", "lib/*.ts"]\n---\nUse tabs.', 'style');
    expect(parsed.inclusion).toBe('auto');
    expect(parsed.globs).toEqual(['src/**/*.ts', 'lib/*.ts']);
    expect(parsed.content).toBe('Use tabs.');
  });

  it('defaults to always when no frontmatter is present', () => {
    const parsed = parseSteering('Be concise.', 'default');
    expect(parsed.inclusion).toBe('always');
    expect(parsed.globs).toEqual([]);
  });

  it('selects always plus glob-matched auto files, never manual ones', () => {
    const files = [
      parseSteering('always rule', 'a'),
      parseSteering('---\ninclusion: auto\nglobs: src/**\n---\nauto rule', 'b'),
      parseSteering('---\ninclusion: manual\n---\nmanual rule', 'c'),
    ];
    const selected = selectSteering(files, ['src/app.ts']);
    expect(selected.map((f) => f.name).sort()).toEqual(['a', 'b']);
    expect(selectSteering(files, ['docs/x.md']).map((f) => f.name)).toEqual(['a']);
  });
});

describe('spec tasks', () => {
  const markdown = `# Plan\n\n- [ ] 1. Scaffold project (R1)\n  - [ ] 1.1 Add package.json\n  - [x] 1.2 Add tsconfig\n- [x] 2. Implement core\n- [ ] 3. Tests\n`;

  it('parses hierarchical checkboxes with ids and depth', () => {
    const tasks = parseTasks(markdown);
    expect(tasks).toHaveLength(5);
    expect(tasks[0]).toMatchObject({ id: '1', checked: false, depth: 0 });
    expect(tasks[1]).toMatchObject({ id: '1.1', depth: 1 });
    expect(tasks[2]).toMatchObject({ id: '1.2', checked: true });
    expect(taskProgress(tasks)).toEqual({ done: 2, total: 5 });
  });

  it('toggles a task without disturbing other lines', () => {
    const updated = setTaskChecked(markdown, '1.1', true);
    expect(updated).toContain('- [x] 1.1 Add package.json');
    expect(updated).toContain('- [ ] 3. Tests');
    expect(updated.split('\n').length).toBe(markdown.split('\n').length);
    expect(() => setTaskChecked(markdown, '9.9', true)).toThrow(/not found/);
  });

  it('slugifies spec names safely', () => {
    expect(slugify('Local Model Support!!')).toBe('local-model-support');
    expect(slugify('   ')).toBe('spec');
  });

  it('creates, lists and updates specs in a store', async () => {
    const specsDir = await tempDir();
    const store = new SpecStore(specsDir);
    const created = await store.create('Checkout Flow');
    expect(created.id).toBe('checkout-flow');

    await store.write('checkout-flow', 'requirements', '# Checkout Flow Requirements\n\n- [ ] 1. Pay (R1)');
    const written = await store.read('checkout-flow');
    expect(written.requirements).toContain('# Checkout Flow Requirements');

    await store.write('checkout-flow', 'tasks', '# Tasks\n\n- [ ] 1. Pay (R1)\n- [ ] 2. Confirm (R2)');
    const tasks = await store.updateTaskStatus('checkout-flow', '1', true);
    expect(tasks[0]!.checked).toBe(true);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.progress).toEqual({ done: 1, total: 2 });
  });
});

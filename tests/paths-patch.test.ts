import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPatch, parsePatch, PatchError } from '../server/agent/patch';
import { isIgnoredPath, PathEscapeError, resolveInWorkspace, toRelative } from '../server/util/paths';
import { tempDir, writeFiles } from './helpers';

describe('workspace path sandbox', () => {
  it('accepts paths inside the workspace', async () => {
    const root = await tempDir();
    await writeFiles(root, { 'src/a.ts': 'x' });
    expect(resolveInWorkspace(root, 'src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
    expect(resolveInWorkspace(root, 'src/../src/a.ts')).toBe(path.join(root, 'src', 'a.ts'));
  });

  it('rejects traversal and absolute paths outside the workspace', async () => {
    const root = await tempDir();
    expect(() => resolveInWorkspace(root, '../etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveInWorkspace(root, '/etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveInWorkspace(root, 'src/../../outside.txt')).toThrow(PathEscapeError);
  });

  it('rejects symlinks that escape the workspace', async () => {
    const root = await tempDir();
    const outside = await tempDir('genie-outside-');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'nope');
    await fs.symlink(outside, path.join(root, 'link'));
    expect(() => resolveInWorkspace(root, 'link/secret.txt')).toThrow(PathEscapeError);
  });

  it('flags ignored directories and normalizes relative paths', async () => {
    expect(isIgnoredPath('node_modules/react/index.js')).toBe(true);
    expect(isIgnoredPath('.genie/runs/x/journal.jsonl')).toBe(true);
    expect(isIgnoredPath('src/app.ts')).toBe(false);
    const root = await tempDir();
    await writeFiles(root, { 'a/b.ts': 'x' });
    expect(toRelative(root, path.join(root, 'a', 'b.ts'))).toBe('a/b.ts');
  });
});

describe('patch format', () => {
  const block = (search: string, replace: string) =>
    `<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;

  it('parses one or more blocks', () => {
    const blocks = parsePatch(`${block('a', 'b')}\n${block('c', 'd')}`);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ search: 'a', replace: 'b', index: 0 });
  });

  it('applies a unique replacement', () => {
    const result = applyPatch('const a = 1;\nconst b = 2;\n', parsePatch(block('const a = 1;', 'const a = 10;')));
    expect(result.content).toContain('const a = 10;');
    expect(result.applied).toBe(1);
  });

  it('applies all blocks atomically', () => {
    const original = 'one\ntwo\nthree\n';
    const result = applyPatch(
      original,
      parsePatch(`${block('one', 'ONE')}\n${block('three', 'THREE')}`),
    );
    // the file's trailing newline is preserved
    expect(result.content).toBe('ONE\ntwo\nTHREE\n');
  });

  it('refuses ambiguous search text', () => {
    expect(() => applyPatch('dup\ndup\n', parsePatch(block('dup', 'x')))).toThrow(/matches 2 places/);
  });

  it('reports a missing search block instead of writing anything', () => {
    try {
      applyPatch('alpha\n', parsePatch(block('beta', 'gamma')));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PatchError);
      expect((error as Error).message).toContain('not found');
    }
  });

  it('tolerates missing indentation', () => {
    const result = applyPatch('  if (x) {\n    y();\n  }\n', parsePatch(block('if (x) {\ny();\n}', 'if (x) {\nz();\n}')));
    expect(result.fuzzy).toBe(1);
    expect(result.content).toContain('z();');
  });

  it('rejects malformed patches', () => {
    expect(() => parsePatch('')).toThrow(PatchError);
    expect(() => parsePatch('<<<<<<< SEARCH\nno close')).toThrow(/Unterminated/);
    expect(() => parsePatch('=======\n>>>>>>> REPLACE')).toThrow(PatchError);
  });
});

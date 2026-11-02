import { describe, expect, it } from 'vitest';
import { collectSources } from '../server/intel/sources';
import { tempDir, writeFiles } from './helpers';

describe('workspace source collection', () => {
  it('collects JS/TS sources and skips ignored directories and other files', async () => {
    const root = await tempDir('genie-intel-');
    await writeFiles(root, {
      'src/app.ts': 'export const app = 1;\n',
      'src/view.tsx': 'export const View = () => null;\n',
      'src/util.js': 'module.exports = 1;\n',
      'README.md': '# not source\n',
      'node_modules/dep/index.js': 'module.exports = 2;\n',
      'dist/bundle.js': 'var x = 1;\n',
      '.genie/memory/core.md': '- fact\n',
    });

    const bundle = await collectSources(root);
    expect(bundle.files.map((file) => file.path)).toEqual(['src/app.ts', 'src/util.js', 'src/view.tsx']);
    expect(bundle.truncated).toBe(false);
    expect(bundle.bytes).toBeGreaterThan(0);
  });

  it('caps the bundle and reports truncation instead of failing', async () => {
    const root = await tempDir('genie-intel-');
    await writeFiles(root, { 'a.ts': '1\n', 'b.ts': '2\n', 'c.ts': '3\n' });

    const bundle = await collectSources(root, { maxFiles: 2 });
    expect(bundle.files).toHaveLength(2);
    expect(bundle.truncated).toBe(true);
  });

  it('skips files above the per-file size cap', async () => {
    const root = await tempDir('genie-intel-');
    await writeFiles(root, {
      'small.ts': 'export const small = 1;\n',
      'huge.ts': `${'// padding line\n'.repeat(30_000)}export const huge = 1;\n`,
    });

    const bundle = await collectSources(root);
    expect(bundle.files.map((file) => file.path)).toEqual(['small.ts']);
  });

  it('returns an empty bundle for a workspace without sources', async () => {
    const root = await tempDir('genie-intel-');
    await writeFiles(root, { 'notes.txt': 'hello\n' });
    const bundle = await collectSources(root);
    expect(bundle.files).toEqual([]);
    expect(bundle.truncated).toBe(false);
  });
});

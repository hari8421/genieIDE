import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DebugSession } from '../server/debug/session';
import { tempDir } from './helpers';

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

const SCRIPT = `let total = 0;
for (let i = 1; i <= 3; i += 1) {
  total += i;
  console.log('i', i);
}
console.log('total', total);
`;

describe('debug session (Node inspector)', () => {
  let session: DebugSession | null = null;

  afterEach(async () => {
    await session?.stop();
    session = null;
  });

  it('pauses on a breakpoint with locals, evaluates in the frame and steps', async () => {
    const root = await tempDir('genie-debug-');
    await fs.writeFile(path.join(root, 'script.js'), SCRIPT, 'utf8');

    session = new DebugSession(root);
    await session.start({ script: 'script.js', breakpoints: [{ path: 'script.js', line: 3 }], stopOnEntry: false });

    // A pause is published as soon as V8 stops; locals arrive a tick later.
    expect(
      await waitFor(() => {
        const snapshot = session?.snapshot();
        return snapshot?.status === 'paused' && snapshot.variables.length > 0;
      }),
    ).toBe(true);

    const paused = session.snapshot();
    expect(paused.frames[0]?.path).toBe('script.js');
    expect(paused.frames[0]?.line).toBe(3);
    expect(paused.variables.map((variable) => variable.name)).toContain('i');

    const evaluated = await session.evaluate('i + 1');
    expect(evaluated.value).toBe('2');

    await session.action('stepOver');
    expect(await waitFor(() => session?.snapshot().frames[0]?.line === 4)).toBe(true);
    expect(session.snapshot().status).toBe('paused');
  }, 30_000);

  it('reports a missing script instead of hanging', async () => {
    const root = await tempDir('genie-debug-');
    session = new DebugSession(root);
    await expect(session.start({ script: 'nope.js' })).rejects.toThrow(/script not found/);
  });

  it('refuses a script outside the workspace', async () => {
    const root = await tempDir('genie-debug-');
    session = new DebugSession(root);
    await expect(session.start({ script: '../../etc/passwd' })).rejects.toThrow(/escapes the workspace/);
  });

  it('refuses to evaluate when not paused', async () => {
    const root = await tempDir('genie-debug-');
    session = new DebugSession(root);
    await expect(session.evaluate('1 + 1')).rejects.toThrow(/paused frame/);
  });
});

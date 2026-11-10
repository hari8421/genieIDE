import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, resolveEndpoint } from '../server/config';

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function workspace(config?: Record<string, unknown>): Promise<string> {
  root = await mkdtemp(path.join(os.tmpdir(), 'anneal-provider-'));
  if (config) {
    await mkdir(path.join(root, '.anneal'), { recursive: true });
    await writeFile(path.join(root, '.anneal', 'config.json'), JSON.stringify(config), 'utf8');
  }
  return root;
}

describe('model provider config', () => {
  it('defaults to the local LM Studio endpoint', async () => {
    const dir = await workspace();
    const config = loadConfig({ workspaceRoot: dir, env: {} });

    expect(config.provider).toBe('lmstudio');
    expect(resolveEndpoint(config)).toEqual({
      provider: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'local-model',
    });
  });

  it('uses an external OpenAI-compatible provider from the environment', async () => {
    const dir = await workspace();
    const config = loadConfig({
      workspaceRoot: dir,
      env: {
        ANNEAL_PROVIDER: 'external',
        ANNEAL_EXTERNAL_BASE_URL: 'https://api.example.com/v1',
        ANNEAL_EXTERNAL_MODEL: 'fast-model',
        ANNEAL_EXTERNAL_API_KEY: 'sk-test',
      },
    });

    expect(resolveEndpoint(config)).toEqual({
      provider: 'external',
      baseUrl: 'https://api.example.com/v1',
      model: 'fast-model',
      apiKey: 'sk-test',
    });
  });

  it('falls back to the local model name when no external model is set', async () => {
    const dir = await workspace({ provider: 'external', model: 'local-model', externalBaseUrl: 'https://host/v1' });
    const endpoint = resolveEndpoint(loadConfig({ workspaceRoot: dir, env: {} }));

    expect(endpoint.provider).toBe('external');
    expect(endpoint.baseUrl).toBe('https://host/v1');
    expect(endpoint.model).toBe('local-model');
    expect(endpoint.apiKey).toBeUndefined();
  });

  it('keeps the local provider when config.json names an unknown provider', async () => {
    const dir = await workspace({ provider: 'telepathy' });
    const config = loadConfig({ workspaceRoot: dir, env: {} });

    expect(config.provider).toBe('lmstudio');
    expect(resolveEndpoint(config).baseUrl).toBe('http://127.0.0.1:1234/v1');
  });

  it('lets the environment override the provider stored in config.json', async () => {
    const dir = await workspace({ provider: 'external', externalBaseUrl: 'https://from-file/v1' });
    const config = loadConfig({ workspaceRoot: dir, env: { ANNEAL_PROVIDER: 'lmstudio' } });

    expect(resolveEndpoint(config).provider).toBe('lmstudio');
  });
});

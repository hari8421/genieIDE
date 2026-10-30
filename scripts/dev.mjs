#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const apiPort = process.env.GENIE_PORT ?? '8787';
const webPort = process.env.GENIE_WEB_PORT ?? '5173';

const children = [];

function run(label, command, args, env, color) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `\x1b[${color}m[${label}]\x1b[0m `;
  const pipe = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) target.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    console.log(`${prefix}exited with code ${code}`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// The API stays on loopback; the UI is the only process exposed for a preview.
run(
  'api',
  process.execPath,
  ['--import', 'tsx', 'server/index.ts'],
  { GENIE_HOST: '127.0.0.1', GENIE_PORT: apiPort, GENIE_WORKSPACE: root },
  36,
);

run(
  'web',
  process.execPath,
  [path.join('node_modules', 'vite', 'bin', 'vite.js'), '--host', '0.0.0.0', '--port', webPort],
  {
    GENIE_PORT: apiPort,
    GENIE_WEB_PORT: webPort,
    // Exact preview hostname only; never a blanket domain allowlist.
    ...(process.env.GENIE_PREVIEW_HOST ? { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: process.env.GENIE_PREVIEW_HOST } : {}),
  },
  35,
);

console.log(`\n  genie  API http://127.0.0.1:${apiPort}   UI http://127.0.0.1:${webPort}\n`);

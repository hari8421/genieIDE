#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const PKGDIST = join(ROOT, '.desktop-pkg-dist');
const OUT = join(ROOT, 'pkg-out');

process.env.NODE_ENV = 'production';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const DEFAULT_TARGETS = pkg['pkg:targets'] ?? [
  'node24-linux-x64',
  'node24-macos-arm64',
  'node24-win-x64',
].join(',');
const TARGETS = process.env.GENIE_DESKTOP_TARGETS ?? DEFAULT_TARGETS;
const OUT_PATH = process.env.GENIE_DESKTOP_OUT ?? join(OUT, 'genie');
const COMPRESS = pkg['pkg:compress'] ?? 'GZip';

console.log(`[build-desktop] targets: ${TARGETS}`);
console.log(`[build-desktop] out: ${OUT_PATH}`);

if (!existsSync(DIST) || !existsSync(join(DIST, 'index.html'))) {
  console.log('[build-desktop] no dist found — running npm run build');
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
}

rmSync(PKGDIST, { recursive: true, force: true });
mkdirSync(PKGDIST, { recursive: true });
copyFileSync(join(ROOT, 'package.json'), join(PKGDIST, 'package.json'));
const stagedPkg = { ...pkg };
delete stagedPkg['pkg:targets'];
delete stagedPkg['pkg:compress'];
writeFileSync(
  join(PKGDIST, 'package.json'),
  JSON.stringify({ ...stagedPkg, private: true, bin: { genie: './dist/bin/genie-server.mjs' } }, null, 2) + '\n',
);
mkdirSync(join(PKGDIST, 'dist'), { recursive: true });
copyFileSync(join(DIST, 'index.html'), join(PKGDIST, 'dist', 'index.html'));
mkdirSync(join(PKGDIST, 'dist', 'bin'), { recursive: true });
writeFileSync(
  join(PKGDIST, 'dist', 'bin', 'genie-server.mjs'),
  `import { createServer } from '../server/http.js';
import { finishShutdown } from '../server/shutdown.js';

async function main() {
  const workspace = process.env.GENIE_WORKSPACE ?? process.cwd();
  const embeddedDist = process.env.GENIE_EMBEDDED_DIST ?? 'dist';
  const server = await createServer({ workspace, embeddedDist });
  const signal = server.listen();
  signal.then(() => finishShutdown()).catch(() => undefined);
}

main().catch((error) => {
  console.error('[genie-server] could not start:', error);
  process.exit(1);
});
`,
  'utf8',
);
mkdirSync(join(PKGDIST, 'server'), { recursive: true });
for (const file of walkSync(join(ROOT, 'server'))) {
  const rel = relative(join(ROOT, 'server'), file);
  const dest = join(PKGDIST, 'server', rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(file, dest);
}

console.log(`[build-desktop] packaging ${TARGETS}`);
try {
  execFileSync('npx', [
    'pkg',
    PKGDIST,
    '--target', TARGETS,
    '--compress', COMPRESS,
    '--out-path', OUT_PATH,
    '--options', 'experimental-require-module',
  ], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' },
  });
} catch {
  console.error('[build-desktop] pkg failed — check the output above');
  process.exit(1);
}

// Accept the actual built binaries under pkg-out. pkg names outputs like
// genie-ide-linux-x64 / genie-ide-macos-arm64 / genie-ide-win-x64.exe.
const allFiles = walkSync(OUT);
const binaries = allFiles.filter((f) => {
  const name = basename(f);
  if (name.endsWith('.exe') || /^genie(-ide)?-/.test(name)) return true;
  return sizeOf(f) >= 5_000_000;
});
// Also accept the out path itself if it was written as a single file.
if (binaries.length === 0 && existsSync(OUT_PATH) && !existsSync(OUT_PATH + '/')) {
  binaries.push(OUT_PATH);
}
console.log(`[build-desktop] found ${binaries.length} output(s)`);
for (const candidate of binaries) {
  const stat = statSync(candidate);
  const size = stat?.size ?? -1;
  console.log(`[build-desktop] OK ${relative(ROOT, candidate)} (${size} bytes)`);
}
console.log(`[build-desktop] done — binaries under ${OUT}`);

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

function walkSync(root) {
  const list = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = require('node:fs').readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        list.push(full);
      }
    }
  }
  return list;
}

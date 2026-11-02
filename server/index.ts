import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, finishShutdown } from './http';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.resolve(process.env.GENIE_WORKSPACE ?? process.env.GENIE_ROOT ?? PROJECT_ROOT);

async function start(): Promise<void> {
  const server = await createServer({
    workspace: WORKSPACE,
    ...(process.env.GENIE_EMBEDDED_DIST ? { embeddedDist: process.env.GENIE_EMBEDDED_DIST } : {}),
  });
  await server.listen();

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await finishShutdown().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

start().catch((error) => {
  console.error('[genie] failed to start:', error);
  process.exit(1);
});

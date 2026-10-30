import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config';
import { createService, type GenieService } from './service';
import { loadSteering } from './steering/steering';
import { PathEscapeError, isIgnoredPath, resolveInWorkspace, toRelative } from './util/paths';

export interface ServerOptions {
  workspace: string;
  embeddedDist?: string;
}

type RouteHandler = (ctx: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  url: URL;
}) => Promise<void> | void;

const ROUTES: Array<{ method: string; regex: RegExp; keys: string[]; handler: RouteHandler }> = [];

function route(method: string, pattern: string, handler: RouteHandler): void {
  const keys: string[] = [];
  const regex = new RegExp(
    `^${pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          keys.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/')}$`,
  );
  ROUTES.push({ method, regex, keys, handler });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 8_000_000) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

interface SseStream {
  send: (event: string, data: unknown) => void;
  close: () => void;
  closed: boolean;
}

function openSse(res: http.ServerResponse): SseStream {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      res.end();
    },
  };
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function languageFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.json': 'json', '.md': 'markdown', '.css': 'css', '.html': 'html', '.py': 'python',
    '.rs': 'rust', '.go': 'go', '.java': 'java', '.c': 'c', '.h': 'c', '.cpp': 'cpp',
    '.yml': 'yaml', '.yaml': 'yaml', '.sh': 'shell', '.sql': 'sql', '.toml': 'ini',
  };
  return map[ext] ?? 'plaintext';
}

async function listTree(root: string, relative: string, depth: number, maxDepth: number): Promise<unknown[]> {
  const dir = resolveInWorkspace(root, relative);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: unknown[] = [];
  const sorted = entries
    .filter((entry) => !isIgnoredPath(path.join(relative, entry.name)))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  for (const entry of sorted.slice(0, 300)) {
    const childRelative = toRelative(root, path.join(dir, entry.name));
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: childRelative,
        type: 'dir',
        children: depth < maxDepth ? await listTree(root, childRelative, depth + 1, maxDepth) : undefined,
      });
    } else {
      nodes.push({ name: entry.name, path: childRelative, type: 'file' });
    }
  }
  return nodes;
}

function registerRoutes(): void {
  route('GET', '/api/health', async ({ res }) => {
    json(res, 200, await service.health());
  });

  route('GET', '/api/models', async ({ res }) => {
    try {
      json(res, 200, { models: await service.listModels() });
    } catch (error) {
      json(res, 502, { error: (error as Error).message, models: [] });
    }
  });

  route('POST', '/api/config', async ({ req, res }) => {
    const body = await readJson(req);
    const patch: Record<string, unknown> = {};
    if (typeof body.model === 'string') patch.model = body.model;
    if (typeof body.lmStudioBaseUrl === 'string') patch.lmStudioBaseUrl = body.lmStudioBaseUrl;
    if (typeof body.contextBudgetTokens === 'number') patch.contextBudgetTokens = body.contextBudgetTokens;
    if (body.autonomy === 'autopilot' || body.autonomy === 'supervised') patch.autonomy = body.autonomy;
    if (typeof body.maxAgentSteps === 'number') patch.maxAgentSteps = body.maxAgentSteps;
    if (typeof body.allowCommands === 'boolean') patch.allowCommands = body.allowCommands;
    if (typeof body.maxTokens === 'number') patch.maxTokens = body.maxTokens;
    const updated = await service.updateConfig(patch);
    json(res, 200, { config: updated });
  });

  route('GET', '/api/files', async ({ res, url }) => {
    const requested = url.searchParams.get('path') ?? '';
    const depth = Number(url.searchParams.get('depth') ?? 3);
    const tree = await listTree(WORKSPACE, requested, 0, Math.min(6, Math.max(0, depth)));
    json(res, 200, { root: WORKSPACE, path: requested, tree });
  });

  route('GET', '/api/file', async ({ res, url }) => {
    const requested = url.searchParams.get('path');
    if (!requested) {
      json(res, 400, { error: 'path is required' });
      return;
    }
    const absolute = resolveInWorkspace(WORKSPACE, requested);
    try {
      const stat = await fs.stat(absolute);
      if (stat.size > 2_000_000) {
        json(res, 413, { error: 'File is larger than 2 MB and cannot be opened in the editor' });
        return;
      }
      const content = await fs.readFile(absolute, 'utf8');
      json(res, 200, { path: toRelative(WORKSPACE, absolute), content, language: languageFor(requested), size: stat.size });
    } catch {
      json(res, 404, { error: `File not found: ${requested}` });
    }
  });

  route('PUT', '/api/file', async ({ req, res }) => {
    const body = await readJson(req);
    const requested = text(body.path);
    if (!requested) {
      json(res, 400, { error: 'path is required' });
      return;
    }
    const absolute = resolveInWorkspace(WORKSPACE, requested);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text(body.content), 'utf8');
    const saved = toRelative(WORKSPACE, absolute);
    const hooks = await service.notifyFileEvent('fileEdited', saved);
    json(res, 200, { path: saved, hooks });
  });

  route('POST', '/api/file', async ({ req, res }) => {
    const body = await readJson(req);
    const requested = text(body.path);
    if (!requested) {
      json(res, 400, { error: 'path is required' });
      return;
    }
    const absolute = resolveInWorkspace(WORKSPACE, requested);
    if (body.kind === 'dir') {
      await fs.mkdir(absolute, { recursive: true });
      json(res, 200, { path: toRelative(WORKSPACE, absolute), type: 'dir' });
      return;
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text(body.content), { encoding: 'utf8', flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new Error('A file with that name already exists');
      throw error;
    });
    const created = toRelative(WORKSPACE, absolute);
    const hooks = await service.notifyFileEvent('fileCreated', created);
    json(res, 200, { path: created, type: 'file', hooks });
  });

  route('DELETE', '/api/file', async ({ res, url }) => {
    const requested = url.searchParams.get('path');
    if (!requested) {
      json(res, 400, { error: 'path is required' });
      return;
    }
    const absolute = resolveInWorkspace(WORKSPACE, requested);
    await fs.rm(absolute, { recursive: true, force: true });
    const deleted = toRelative(WORKSPACE, absolute);
    const hooks = await service.notifyFileEvent('fileDeleted', deleted);
    json(res, 200, { path: deleted, hooks });
  });

  route('POST', '/api/chat', async ({ req, res }) => {
    const body = await readJson(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sse = openSse(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      const result = await service.chatStream({
        messages: messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        signal: controller.signal,
        onDelta: (chunk) => sse.send('delta', { text: chunk }),
      });
      sse.send('done', result);
    } catch (error) {
      sse.send('error', { message: (error as Error).message });
    } finally {
      sse.close();
    }
  });

  route('POST', '/api/run', async ({ req, res }) => {
    const body = await readJson(req);
    const sse = openSse(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    sse.send('accepted', { goal: text(body.goal) });
    try {
      const result = await service.run({
        goal: text(body.goal),
        files: strArray(body.files),
        specId: typeof body.specId === 'string' ? body.specId : undefined,
        taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
        autonomy: body.autonomy === 'supervised' ? 'supervised' : body.autonomy === 'autopilot' ? 'autopilot' : undefined,
        signal: controller.signal,
        onEvent: (event) => sse.send(event.type, event),
      });
      sse.send('result', result);
    } catch (error) {
      sse.send('error', { message: (error as Error).message });
    } finally {
      sse.close();
    }
  });

  route('GET', '/api/runs', async ({ res }) => {
    const runs = await service.runs();
    json(res, 200, { runs: runs.map((run) => ({ ...run, running: service.isRunning(run.id) })) });
  });

  route('GET', '/api/runs/:id', async ({ res, params }) => {
    try {
      json(res, 200, await service.runJournal(params.id!));
    } catch (error) {
      json(res, 404, { error: (error as Error).message });
    }
  });

  route('POST', '/api/runs/:id/resume', async ({ req, res, params }) => {
    const body = await readJson(req);
    const sse = openSse(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      const result = await service.resume(params.id!, {
        goal: text(body.goal),
        files: strArray(body.files),
        specId: typeof body.specId === 'string' ? body.specId : undefined,
        taskId: typeof body.taskId === 'string' ? body.taskId : undefined,
        signal: controller.signal,
        onEvent: (event) => sse.send(event.type, event),
      });
      sse.send('result', result);
    } catch (error) {
      sse.send('error', { message: (error as Error).message });
    } finally {
      sse.close();
    }
  });

  route('POST', '/api/runs/:id/cancel', async ({ res, params }) => {
    json(res, 200, { cancelled: service.cancelRun(params.id!) });
  });

  route('GET', '/api/specs', async ({ res }) => {
    json(res, 200, { specs: await service.specs.list() });
  });

  route('POST', '/api/specs', async ({ req, res }) => {
    const body = await readJson(req);
    const name = text(body.name);
    if (!name.trim()) {
      json(res, 400, { error: 'name is required' });
      return;
    }
    json(res, 200, { spec: await service.specs.create(name) });
  });

  route('GET', '/api/specs/:id', async ({ res, params }) => {
    try {
      json(res, 200, await service.specs.read(params.id!));
    } catch (error) {
      json(res, 404, { error: (error as Error).message });
    }
  });

  route('PUT', '/api/specs/:id/:artifact', async ({ req, res, params }) => {
    const artifact = params.artifact;
    if (artifact !== 'requirements' && artifact !== 'design' && artifact !== 'tasks') {
      json(res, 400, { error: 'artifact must be requirements, design or tasks' });
      return;
    }
    const body = await readJson(req);
    await service.specs.write(params.id!, artifact, text(body.content));
    json(res, 200, { ok: true });
  });

  route('POST', '/api/specs/:id/generate', async ({ req, res, params }) => {
    const body = await readJson(req);
    const sse = openSse(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      const result = await service.generateSpec(params.id!, text(body.request), {
        signal: controller.signal,
        onStage: (stage, status) => sse.send('stage', { stage, status }),
        onDelta: (stage, text) => sse.send('delta', { stage, text }),
      });
      sse.send('done', result);
    } catch (error) {
      sse.send('error', { message: (error as Error).message });
    } finally {
      sse.close();
    }
  });

  route('POST', '/api/specs/:id/tasks/:taskId/run', async ({ req, res, params }) => {
    const sse = openSse(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      const result = await service.executeTask(params.id!, params.taskId!, {
        signal: controller.signal,
        onEvent: (event) => sse.send(event.type, event),
      });
      sse.send('result', result);
    } catch (error) {
      sse.send('error', { message: (error as Error).message });
    } finally {
      sse.close();
    }
  });

  route('POST', '/api/specs/:id/run-next', async ({ req, res, params }) => {
    const sse = openSse(res);
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    try {
      const result = await service.executeNextTask(params.id!, {
        signal: controller.signal,
        onEvent: (event) => sse.send(event.type, event),
      });
      sse.send('result', result);
    } catch (error) {
      sse.send('error', { message: (error as Error).message });
    } finally {
      sse.close();
    }
  });

  route('GET', '/api/hooks', async ({ res }) => {
    json(res, 200, { hooks: service.hookDefinitions });
  });

  route('POST', '/api/hooks/reload', async ({ res }) => {
    await service.reloadHooks();
    json(res, 200, { hooks: service.hookDefinitions });
  });

  route('POST', '/api/hooks/:name/run', async ({ req, res, params }) => {
    const body = await readJson(req);
    const event = {
      type: (text(body.event, 'manual') as 'fileEdited' | 'fileCreated' | 'fileDeleted' | 'taskCompleted' | 'agentStop' | 'manual'),
      path: typeof body.path === 'string' ? body.path : undefined,
      message: typeof body.message === 'string' ? body.message : undefined,
    };
    const results = await service.dispatchHooks(event);
    const mine = results.find((result) => result.hook === params.name);
    json(res, 200, { results, matched: Boolean(mine), result: mine ?? null });
  });

  route('GET', '/api/checkpoints', async ({ res }) => {
    json(res, 200, { checkpoints: await service.checkpointStore.list() });
  });

  route('POST', '/api/checkpoints', async ({ req, res }) => {
    const body = await readJson(req);
    const manifest = await service.checkpointStore.create(text(body.label, 'Manual checkpoint'));
    json(res, 200, { checkpoint: manifest });
  });

  route('GET', '/api/checkpoints/:id/diff', async ({ res, params }) => {
    try {
      json(res, 200, { diff: await service.checkpointStore.diff(params.id!) });
    } catch (error) {
      json(res, 404, { error: (error as Error).message });
    }
  });

  route('POST', '/api/checkpoints/:id/restore', async ({ res, params }) => {
    try {
      const result = await service.checkpointStore.restore(params.id!);
      json(res, 200, result);
    } catch (error) {
      json(res, 500, { error: (error as Error).message });
    }
  });

  route('GET', '/api/mcp', async ({ res }) => {
    json(res, 200, service.mcpStatus());
  });

  route('POST', '/api/mcp/connect', async ({ res }) => {
    json(res, 200, { servers: await service.connectMcp(), status: service.mcpStatus() });
  });

  route('GET', '/api/steering', async ({ res }) => {
    const files = await loadSteering(path.join(WORKSPACE, '.genie', 'steering'));
    json(res, 200, { steering: files.map(({ name, inclusion, globs, content }) => ({ name, inclusion, globs, length: content.length })) });
  });
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const PORT = Number(process.env.GENIE_PORT ?? 8787);
const HOST = process.env.GENIE_HOST ?? '127.0.0.1';
const WORKSPACE = path.resolve(process.env.GENIE_WORKSPACE ?? process.env.GENIE_ROOT ?? process.cwd());
const EMBEDDED_DIST = process.env.GENIE_EMBEDDED_DIST ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

let service: GenieService;

async function serveStatic(res: http.ServerResponse, pathname: string, dist: string): Promise<boolean> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const candidate = path.join(dist, relative);
  if (!candidate.startsWith(dist)) return false;
  try {
    const body = await fs.readFile(candidate);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(candidate)] ?? 'application/octet-stream',
      'cache-control': pathname === '/' ? 'no-store' : 'public, max-age=3600',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export async function createServer({ workspace, embeddedDist }: ServerOptions): Promise<{ listen: () => Promise<void> }> {
  const config = loadConfig({ workspaceRoot: workspace });
  service = await createService(workspace, config);
  registerRoutes();

  const distToServe = embeddedDist ?? EMBEDDED_DIST;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      for (const entry of ROUTES) {
        if (entry.method !== req.method) continue;
        const match = url.pathname.match(entry.regex);
        if (!match) continue;
        const params: Record<string, string> = {};
        entry.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1] ?? '');
        });
        await entry.handler({ req, res, params, url });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        json(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
        return;
      }
      if (await serveStatic(res, url.pathname, distToServe)) return;
      if (!path.extname(url.pathname) && (await serveStatic(res, '/', distToServe))) return;

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found. Run \"npm run build\" to create the UI bundle, or use the Vite dev server on port 5173.');
    } catch (error) {
      const status = error instanceof PathEscapeError ? 400 : 500;
      if (!res.headersSent) {
        json(res, status, { error: (error as Error).message });
      } else {
        res.end();
      }
    }
  });

  let started: Promise<void>;
  server.listen(PORT, HOST, () => {
    console.log(`[genie] API listening on http://${HOST}:${PORT}`);
    console.log(`[genie] workspace: ${workspace}`);
    console.log(`[genie] LM Studio: ${config.lmStudioBaseUrl} (model: ${config.model})`);
    started = Promise.resolve();
  });

  return {
    listen() {
      return started ?? new Promise((resolve) => server.once('listening', resolve));
    },
  };
}

export async function finishShutdown(): Promise<void> {
  console.log('[genie] shutting down');
  await service.closeMcp().catch(() => undefined);
  if (service instanceof Object && 'close' in service) {
    // no-op: the service object itself does not own the server socket
  }
}

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolveInWorkspace, toRelative } from '../util/paths';

/**
 * A real debugger for the workspace, driven through Node's inspector protocol.
 *
 * `node --inspect-brk` starts the program paused and prints a WebSocket URL on
 * stderr; from there everything is Chrome DevTools Protocol: set breakpoints,
 * step, read locals, evaluate in a frame, stream console output. Node exposes a
 * global WebSocket from 22 on, so no dependency is needed — on older runtimes
 * the session fails with a clear message instead of silently doing nothing.
 */

export type DebugStatus = 'starting' | 'paused' | 'running' | 'exited';

export interface DebugBreakpoint {
  path: string;
  line: number;
  verified?: boolean;
}

export interface DebugFrame {
  id: string;
  functionName: string;
  path: string | null;
  line: number;
  column: number;
}

export interface DebugVariable {
  name: string;
  value: string;
  type: string;
}

export interface DebugOutputLine {
  stream: 'stdout' | 'stderr' | 'console' | 'error';
  text: string;
}

export interface DebugState {
  status: DebugStatus;
  script: string | null;
  frames: DebugFrame[];
  variables: DebugVariable[];
  breakpoints: DebugBreakpoint[];
  output: DebugOutputLine[];
  exitCode?: number | null;
  error?: string;
}

export type DebugAction = 'continue' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut';

export interface StartOptions {
  script: string;
  breakpoints?: Array<{ path: string; line: number }>;
  stopOnEntry?: boolean;
}

interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, handler: (event: { data?: unknown }) => void): void;
}
type WsCtor = new (url: string) => WsLike;

const OUTPUT_LIMIT = 300;
const WS_TIMEOUT_MS = 15_000;

function webSocketCtor(): WsCtor | null {
  const ctor = (globalThis as unknown as { WebSocket?: WsCtor }).WebSocket;
  return typeof ctor === 'function' ? ctor : null;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  constructor(private readonly ws: WsLike) {
    ws.addEventListener('message', (event) => this.handle(String(event.data ?? '')));
  }

  private handle(raw: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; error?: { message?: string }; result?: unknown };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? 'inspector error'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method) {
      for (const handler of this.listeners.get(message.method) ?? []) {
        handler(message.params ?? {});
      }
    }
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: Record<string, unknown>) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(handler);
    this.listeners.set(method, list);
  }
}

function formatRemote(value: Record<string, unknown> | undefined): string {
  if (!value) return 'undefined';
  const description = typeof value.description === 'string' ? value.description : undefined;
  if (description) return description;
  if ('value' in value) return JSON.stringify(value.value);
  if (typeof value.unserializableValue === 'string') return value.unserializableValue;
  return typeof value.type === 'string' ? value.type : 'unknown';
}

/**
 * A pkg build embeds node but exposes no built-in executable to spawn, and plain
 * PATH lookup fails inside the snapshot bootstrap, so try absolute paths first.
 */
function resolveNodeBinary(): string {
  const candidates = [
    process.env.ANNEAL_NODE,
    process.env.NODE,
    '/usr/local/bin/node',
    '/usr/bin/node',
    '/opt/homebrew/bin/node',
    'node',
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    'Debugging from the desktop build needs Node.js installed; set ANNEAL_NODE to a node executable',
  );
}

export class DebugSession {
  private child: ChildProcess | null = null;
  private cdp: CdpClient | null = null;
  private ws: WsLike | null = null;
  private readonly output: DebugOutputLine[] = [];
  private readonly listeners = new Set<() => void>();
  private state: DebugState = {
    status: 'starting',
    script: null,
    frames: [],
    variables: [],
    breakpoints: [],
    output: [],
  };
  private closed = false;
  private stderrBuffer = '';
  private readonly breakpointIds = new Map<string, number>();
  private readonly scriptUrls = new Map<string, string>();
  private pauseSeq = 0;

  constructor(private readonly workspace: string) {}

  async start(options: StartOptions): Promise<void> {
    if (!webSocketCtor()) {
      throw new Error('Debugging needs Node 22 or newer (no global WebSocket in this runtime)');
    }
    const absolute = resolveInWorkspace(this.workspace, options.script);
    this.state.script = toRelative(this.workspace, absolute);

    try {
      await fs.access(absolute);
    } catch {
      throw new Error(`script not found in the workspace: ${options.script}`);
    }

    // Node 23.6+ strips TypeScript types natively; older runtimes need the
    // experimental flag (and reject enums / namespaces / parameter properties).
    const [major, minor] = process.versions.node.split('.').map(Number);
    const nativeStrip = major > 23 || (major === 23 && minor >= 6);
    const isTypeScript = /\.(ts|tsx|mts|cts)$/i.test(absolute);
    const args = [
      ...(isTypeScript && !nativeStrip ? ['--experimental-strip-types'] : []),
      '--inspect-brk=127.0.0.1:0',
      absolute,
    ];

    // A packaged build has no node binary to spawn: process.execPath is anneal
    // itself, and pkg's PKG_EXECPATH=PKG_INVOKE_NODEJS escape hatch does not
    // survive this bootstrap (@yao-pkg rejects --inspect-brk with "bad option").
    // Fall back to a real Node install and say so clearly when there is none.
    const packaged = Boolean((process as unknown as { pkg?: unknown }).pkg);
    const nodeBinary = packaged ? resolveNodeBinary() : process.execPath;
    this.child = spawn(nodeBinary, args, {
      cwd: this.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A debuggee must not inherit the harness's Node flags (vitest sets its
      // own); leaking them changes how the inspector pauses.
      env: { ...process.env, ANNEAL_DEBUG: '1', NODE_OPTIONS: '' },
    });

    this.child.stdout?.on('data', (chunk: Buffer) => this.push('stdout', chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString('utf8');
      this.push('stderr', chunk);
    });
    this.child.on('exit', (code) => {
      if (this.closed) return;
      this.state.status = 'exited';
      this.state.exitCode = code;
      this.state.frames = [];
      this.state.variables = [];
      this.emit();
    });

    const wsUrl = await this.waitForInspectorUrl();
    await this.connect(wsUrl);
    await this.wireEvents();

    this.state.breakpoints = options.breakpoints ?? [];
    if (this.state.breakpoints.length) await this.applyBreakpoints(this.state.breakpoints);

    // `--inspect-brk` holds the program paused before its first line. Resuming
    // before V8 has actually paused fails silently and freezes the debuggee, so
    // wait for the entry pause first, then run to the breakpoint.
    await this.cdp?.send('Runtime.runIfWaitingForDebugger').catch(() => undefined);
    await this.waitForStatus('paused', 5_000);
    if (options.stopOnEntry === false && this.state.status === 'paused') {
      await this.cdp?.send('Debugger.resume').catch(() => undefined);
      await this.waitForStatus('running', 5_000);
    }
    this.emit();
  }

  private push(stream: DebugOutputLine['stream'], chunk: Buffer): void {
    const text = chunk.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (stream === 'stderr' && line.includes('Debugger listening on')) continue;
      this.output.push({ stream, text: line });
    }
    while (this.output.length > OUTPUT_LIMIT) this.output.shift();
    this.emit();
  }

  private waitForInspectorUrl(): Promise<string> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + WS_TIMEOUT_MS;
      const poll = () => {
        if (this.closed) return reject(new Error('debug session closed before the inspector started'));
        if (this.state.status === 'exited' && !this.stderrBuffer.includes('Debugger listening on')) {
          const tail = this.output.slice(-6).map((line) => line.text).join('\n');
          return reject(new Error(`the script exited before the debugger attached${tail ? `:\n${tail}` : ''}`));
        }
        const match = this.stderrBuffer.match(/ws:\/\/[^\s]+/);
        if (match) return resolve(match[0].trim());
        if (Date.now() > deadline) {
          const tail = this.output.slice(-6).map((line) => line.text).join('\n');
          return reject(new Error(`the inspector did not start in time${tail ? `:\n${tail}` : ''}`));
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  private connect(url: string): Promise<void> {
    const Ctor = webSocketCtor();
    if (!Ctor) throw new Error('Debugging needs Node 22 or newer (no global WebSocket in this runtime)');
    return new Promise((resolve, reject) => {
      const ws = new Ctor(url);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('timed out connecting to the inspector')), WS_TIMEOUT_MS);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.cdp = new CdpClient(ws);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('could not connect to the inspector websocket'));
      });
    });
  }

  private waitForStatus(status: DebugStatus, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const done = () => {
        this.listeners.delete(listener);
        resolve();
      };
      const listener = () => {
        if (this.state.status === status) done();
      };
      this.listeners.add(listener);
      const poll = () => {
        if (this.state.status === status || this.state.status === 'exited' || Date.now() > deadline) return done();
        setTimeout(poll, 25);
      };
      poll();
    });
  }

  private async wireEvents(): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    await cdp.send('Runtime.enable');
    await cdp.send('Debugger.enable');

    cdp.on('Debugger.scriptParsed', (params) => {
      const scriptId = String(params.scriptId ?? '');
      if (!scriptId) return;
      this.scriptUrls.set(scriptId, typeof params.url === 'string' ? params.url : '');
    });

    cdp.on('Debugger.paused', (params) => {
      const frames = Array.isArray(params.callFrames) ? (params.callFrames as Array<Record<string, unknown>>) : [];
      const mapped = frames.slice(0, 20).map((frame) => {
        const location = (frame.location ?? {}) as { scriptId?: string; lineNumber?: number; columnNumber?: number };
        // Call frames carry a scriptId, not a URL; the URL arrives separately in
        // Debugger.scriptParsed, so it has to be mapped back here.
        const direct = typeof frame.url === 'string' ? frame.url : '';
        const url = direct || this.scriptUrls.get(String(location.scriptId ?? '')) || '';
        return {
          id: String(frame.callFrameId ?? ''),
          functionName: String(frame.functionName || '(anonymous)'),
          path: url.startsWith('file://') ? toRelative(this.workspace, decodeURIComponent(url.replace(/^file:\/\//, ''))) : null,
          line: (location.lineNumber ?? 0) + 1,
          column: (location.columnNumber ?? 0) + 1,
        };
      });
      // Publish the pause immediately: delaying it until the locals arrive left
      // the session reporting "running" while V8 was actually stopped, and a
      // resume landing in that window dropped the pause entirely. Locals arrive
      // right after, guarded by a sequence number.
      const sequence = ++this.pauseSeq;
      this.state.status = 'paused';
      this.state.frames = mapped;
      this.state.variables = [];
      this.emit();
      void this.readVariables(frames[0])
        .catch(() => [] as DebugVariable[])
        .then((variables) => {
          if (sequence !== this.pauseSeq) return;
          this.state.variables = variables;
          this.emit();
        });
    });

    cdp.on('Debugger.breakpointResolved', (params) => {
      const index = this.breakpointIds.get(String(params.breakpointId ?? ''));
      const breakpoint = index === undefined ? undefined : this.state.breakpoints[index];
      if (!breakpoint) return;
      breakpoint.verified = true;
      this.emit();
    });

    cdp.on('Debugger.resumed', () => {
      this.pauseSeq += 1;
      this.state.status = 'running';
      this.state.frames = [];
      this.state.variables = [];
      this.emit();
    });

    cdp.on('Runtime.consoleAPICalled', (params) => {
      const args = Array.isArray(params.args) ? (params.args as Array<Record<string, unknown>>) : [];
      this.push('console', Buffer.from(args.map((arg) => formatRemote(arg)).join(' ')));
    });

    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = (params.exceptionDetails ?? {}) as {
        text?: string;
        exception?: Record<string, unknown>;
      };
      const text = details.exception ? formatRemote(details.exception) : details.text ?? 'exception';
      this.output.push({ stream: 'error', text });
      this.emit();
    });
  }

  private async readVariables(frame: Record<string, unknown> | undefined): Promise<DebugVariable[]> {
    const cdp = this.cdp;
    if (!cdp || !frame) return [];
    const scopes = Array.isArray(frame.scopeChain) ? (frame.scopeChain as Array<Record<string, unknown>>) : [];
    const variables: DebugVariable[] = [];
    for (const scope of scopes) {
      const object = scope.object as { objectId?: string } | undefined;
      const type = String(scope.type ?? '');
      // Module top-level variables live in `script`/`module` scopes, not `local`;
      // only the global object is skipped because it is huge and uninteresting.
      if (!object?.objectId || type === 'global') continue;
      try {
        const result = (await cdp.send('Runtime.getProperties', {
          objectId: object.objectId,
          ownProperties: true,
        })) as { result?: Array<Record<string, unknown>> };
        for (const property of (result.result ?? []).slice(0, 40)) {
          if (typeof property.name !== 'string') continue;
          const value = property.value as Record<string, unknown> | undefined;
          variables.push({
            name: property.name,
            value: formatRemote(value),
            type: String(value?.type ?? 'unknown'),
          });
        }
      } catch {
        // A scope can disappear while stepping; ignore it.
      }
      if (variables.length >= 60) break;
    }
    return variables;
  }

  async setBreakpoints(list: Array<{ path: string; line: number }>): Promise<DebugState> {
    this.state.breakpoints = list;
    await this.applyBreakpoints(list);
    this.emit();
    return this.snapshot();
  }

  private async applyBreakpoints(list: Array<{ path: string; line: number }>): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    const resolved: DebugBreakpoint[] = [];
    for (const breakpoint of list) {
      const absolute = resolveInWorkspace(this.workspace, breakpoint.path);
      try {
        const result = (await cdp.send('Debugger.setBreakpointByUrl', {
          url: pathToFileURL(absolute).href,
          lineNumber: Math.max(0, breakpoint.line - 1),
          columnNumber: 0,
        })) as { breakpointId?: string; locations?: unknown[] };
        if (result.breakpointId) this.breakpointIds.set(result.breakpointId, resolved.length);
        resolved.push({
          path: toRelative(this.workspace, absolute),
          line: breakpoint.line,
          verified: Array.isArray(result.locations) && result.locations.length > 0,
        });
      } catch {
        resolved.push({ path: toRelative(this.workspace, absolute), line: breakpoint.line, verified: false });
      }
    }
    this.state.breakpoints = resolved;
  }

  async action(action: DebugAction): Promise<DebugState> {
    const cdp = this.cdp;
    if (!cdp) throw new Error('no debug session is running');
    const method =
      action === 'continue'
        ? 'Debugger.resume'
        : action === 'pause'
          ? 'Debugger.pause'
          : action === 'stepOver'
            ? 'Debugger.stepOver'
            : action === 'stepInto'
              ? 'Debugger.stepInto'
              : 'Debugger.stepOut';
    // Optimistic status has to be set *before* the command: resuming can reach
    // the next breakpoint before the protocol reply arrives, and setting it
    // afterwards would overwrite that pause with "running".
    if (action !== 'pause') {
      this.state.status = 'running';
      this.state.frames = [];
      this.state.variables = [];
    }
    await cdp.send(method);
    this.emit();
    return this.snapshot();
  }

  async evaluate(expression: string): Promise<{ value: string }> {
    const cdp = this.cdp;
    const frameId = this.state.frames[0]?.id;
    if (!cdp || !frameId) throw new Error('evaluation needs a paused frame');
    const result = (await cdp.send('Debugger.evaluateOnCallFrame', {
      callFrameId: frameId,
      expression,
      generatePreview: true,
      returnByValue: false,
      silent: true,
    })) as { result?: Record<string, unknown>; exceptionDetails?: { text?: string } };
    if (result.exceptionDetails) {
      return { value: `throw: ${result.exceptionDetails.text ?? 'evaluation failed'}` };
    }
    return { value: formatRemote(result.result) };
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.state.status === 'paused') await this.cdp?.send('Debugger.resume').catch(() => undefined);
      this.ws?.close();
    } catch {
      // already gone
    }
    const child = this.child;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1_500).unref?.();
    }
    this.state.status = 'exited';
    this.state.frames = [];
    this.state.variables = [];
    this.emit();
  }

  snapshot(): DebugState {
    return {
      ...this.state,
      breakpoints: [...this.state.breakpoints],
      frames: [...this.state.frames],
      variables: [...this.state.variables],
      output: this.output.slice(-120),
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Used by the HTTP layer for polling; the session is cheap to snapshot. */
  get status(): DebugStatus {
    return this.state.status;
  }
}

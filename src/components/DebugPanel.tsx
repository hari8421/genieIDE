import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type DebugState } from '../lib/api';

interface DebugPanelProps {
  activePath: string | null;
  breakpoints: Array<{ path: string; line: number }>;
  onToggleBreakpoint: (path: string, line: number) => void;
  onClearBreakpoints: () => void;
  onOpenFile: (path: string, line: number) => void;
}

const LIVE: DebugState['status'][] = ['starting', 'paused', 'running'];

export default function DebugPanel({
  activePath,
  breakpoints,
  onToggleBreakpoint,
  onClearBreakpoints,
  onOpenFile,
}: DebugPanelProps) {
  const [state, setState] = useState<DebugState | null>(null);
  const [script, setScript] = useState('');
  const [expression, setExpression] = useState('');
  const [evaluated, setEvaluated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!script && activePath) setScript(activePath);
  }, [activePath, script]);

  useEffect(() => {
    void api.debugState().then(setState).catch(() => undefined);
  }, []);

  const live = state ? LIVE.includes(state.status) : false;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      void api.debugState().then(setState).catch(() => undefined);
    }, 600);
    return () => clearInterval(timer);
  }, [live]);

  const run = useCallback(async (task: () => Promise<DebugState | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await task();
      if (next) setState(next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  const start = () => run(async () => api.debugStart(script, breakpoints));
  const stop = () =>
    run(async () => {
      await api.debugStop();
      return api.debugState();
    });
  const act = (action: 'continue' | 'pause' | 'stepOver' | 'stepInto' | 'stepOut') =>
    run(() => api.debugAction(action));

  const evaluate = async () => {
    if (!expression.trim()) return;
    setError(null);
    try {
      const result = await api.debugEvaluate(expression.trim());
      setEvaluated(result.value);
    } catch (err) {
      setEvaluated(`error: ${(err as Error).message}`);
    }
  };

  const output = useMemo(() => (state?.output ?? []).slice(-80), [state]);
  const status = state?.status ?? 'idle';

  return (
    <div className="panel-body">
      <div className="field">
        <input
          className="input"
          placeholder="script.js or src/cli.ts"
          value={script}
          onChange={(event) => setScript(event.target.value)}
        />
      </div>

      <div className="debug-toolbar">
        <button className="btn small" disabled={busy || !script} onClick={() => void start()}>
          Debug
        </button>
        <button className="btn ghost small" disabled={busy || !live} onClick={() => void stop()}>
          Stop
        </button>
        <span className={`debug-badge ${status}`}>{status}</span>
      </div>

      <div className="debug-toolbar">
        <button className="btn ghost small" disabled={!live || status !== 'paused'} onClick={() => void act('continue')} title="Continue (F5)">
          ▶
        </button>
        <button className="btn ghost small" disabled={!live || status === 'paused'} onClick={() => void act('pause')} title="Pause">
          ❚❚
        </button>
        <button className="btn ghost small" disabled={status !== 'paused'} onClick={() => void act('stepOver')} title="Step over (F8)">
          ⤼ over
        </button>
        <button className="btn ghost small" disabled={status !== 'paused'} onClick={() => void act('stepInto')} title="Step into (F7)">
          ⤓ into
        </button>
        <button className="btn ghost small" disabled={status !== 'paused'} onClick={() => void act('stepOut')} title="Step out (Shift+F8)">
          ⤒ out
        </button>
      </div>

      {error && <div className="debug-error">{error}</div>}

      <div className="debug-section">
        <div className="debug-title">Breakpoints ({breakpoints.length})</div>
        <div className="debug-frames">
          {breakpoints.length === 0 && <div className="muted small">Click the editor gutter (or press F9) to add one.</div>}
          {breakpoints.map((breakpoint) => (
            <div key={`${breakpoint.path}:${breakpoint.line}`} className="breakpoint-row">
              <button className="link" onClick={() => onOpenFile(breakpoint.path, breakpoint.line)}>
                {breakpoint.path.split('/').pop()}:{breakpoint.line}
              </button>
              <button className="btn ghost tiny" onClick={() => onToggleBreakpoint(breakpoint.path, breakpoint.line)}>
                remove
              </button>
            </div>
          ))}
        </div>
        {breakpoints.length > 0 && (
          <button className="btn ghost tiny" onClick={onClearBreakpoints}>
            Clear all
          </button>
        )}
      </div>

      <div className="debug-section">
        <div className="debug-title">Call stack</div>
        <div className="debug-frames">
          {(state?.frames ?? []).length === 0 && <div className="muted small">not paused</div>}
          {(state?.frames ?? []).map((frame, index) => (
            <div key={frame.id || index} className={`debug-frame${index === 0 ? ' active' : ''}`}>
              <button className="link" onClick={() => frame.path && onOpenFile(frame.path, frame.line)}>
                {frame.functionName}
              </button>
              <span className="muted">
                {frame.path ? `${frame.path.split('/').pop()}:${frame.line}` : 'native'}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="debug-section">
        <div className="debug-title">Variables</div>
        <div className="debug-vars">
          {(state?.variables ?? []).length === 0 && <div className="muted small">none</div>}
          {(state?.variables ?? []).map((variable) => (
            <div key={variable.name} className="debug-var">
              <span className="debug-var-name">{variable.name}</span>
              <span>= {variable.value}</span>
              <span className="debug-var-type">{variable.type}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="debug-section">
        <div className="debug-title">Evaluate</div>
        <div className="field">
          <input
            className="input"
            placeholder="expression"
            value={expression}
            onChange={(event) => setExpression(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void evaluate()}
          />
          <button className="btn ghost small" disabled={status !== 'paused'} onClick={() => void evaluate()}>
            Run
          </button>
        </div>
        {evaluated !== null && <div className="debug-eval">{evaluated}</div>}
      </div>

      <div className="debug-section">
        <div className="debug-title">Console</div>
        <div className="debug-output">
          {output.length === 0 && <div className="muted small">no output</div>}
          {output.map((line, index) => (
            <div key={index} className={`debug-output-line ${line.stream}`}>
              {line.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

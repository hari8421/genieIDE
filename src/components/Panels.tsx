import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  stream,
  type Checkpoint,
  type CheckpointDiff,
  type HookDefinition,
  type RunSummary,
  type SpecDetail,
  type SpecSummary,
} from '../lib/api';

function Progress({ done, total }: { done: number; total: number }) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress" title={`${done}/${total} tasks`}>
      <div className="progress-bar" style={{ width: `${percent}%` }} />
    </div>
  );
}

export function SpecsTab({
  busy,
  onRunTask,
  onRunNext,
}: {
  busy: boolean;
  onRunTask: (specId: string, taskId: string) => void;
  onRunNext: (specId: string) => void;
}) {
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SpecDetail | null>(null);
  const [name, setName] = useState('');
  const [request, setRequest] = useState('');
  const [generating, setGenerating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    const { specs: next } = await api.specs();
    setSpecs(next);
    return next;
  }, []);

  useEffect(() => {
    refresh().catch((err: Error) => setError(err.message));
  }, [refresh]);

  const open = async (id: string) => {
    setActiveId(id);
    setDrafts({});
    setError(null);
    try {
      setDetail(await api.spec(id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const create = async () => {
    if (!name.trim()) return;
    try {
      const { spec } = await api.createSpec(name.trim());
      setName('');
      await refresh();
      await open(spec.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const generate = async () => {
    if (!activeId || !request.trim()) return;
    setGenerating(true);
    setError(null);
    setNotice(null);
    setDrafts({});
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await stream(
        `/api/specs/${encodeURIComponent(activeId)}/generate`,
        { request },
        (event, data) => {
          if (event === 'delta') {
            const stage = String(data.stage ?? '');
            const text = String(data.text ?? '');
            setDrafts((prev) => ({ ...prev, [stage]: (prev[stage] ?? '') + text }));
          } else if (event === 'stage') {
            setNotice(`${String(data.stage)} — ${String(data.status)}`);
          } else if (event === 'error') {
            setError(String(data.message ?? 'Generation failed'));
          }
        },
        controller.signal,
      );
      setNotice('Spec generated. Review the documents, then run the tasks.');
      setDetail(await api.spec(activeId));
      await refresh();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      abortRef.current = null;
      setGenerating(false);
    }
  };

  return (
    <div className="panel-body">
      <div className="field">
        <input
          className="input"
          placeholder="New spec name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && create()}
        />
        <button className="btn ghost small" onClick={create}>
          Create
        </button>
      </div>

      <div className="list">
        {specs.map((spec) => (
          <button
            key={spec.id}
            className={`list-item${activeId === spec.id ? ' active' : ''}`}
            onClick={() => open(spec.id)}
          >
            <span className="list-title">{spec.title}</span>
            <span className="list-meta">
              {spec.progress.done}/{spec.progress.total} tasks
            </span>
            <Progress done={spec.progress.done} total={spec.progress.total} />
          </button>
        ))}
        {!specs.length && <div className="empty">No specs yet. Create one to start the requirements → design → tasks flow.</div>}
      </div>

      {activeId && detail && (
        <div className="spec-detail">
          <textarea
            className="textarea"
            rows={3}
            placeholder="Describe the feature in one or two sentences…"
            value={request}
            onChange={(event) => setRequest(event.target.value)}
          />
          <div className="row">
            <button className="btn primary small" onClick={generate} disabled={generating || !request.trim()}>
              {generating ? 'Generating…' : 'Generate spec'}
            </button>
            {generating && (
              <button className="btn ghost small" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            )}
          </div>
          {notice && <div className="notice">{notice}</div>}

          {(['requirements', 'design', 'tasks'] as const).map((artifact) => {
            const text = drafts[artifact] ?? detail[artifact] ?? '';
            if (!text) return null;
            return (
              <details key={artifact} className="doc" open={artifact === 'tasks'}>
                <summary>
                  {artifact}
                  {drafts[artifact] ? ' (streaming…)' : ''}
                </summary>
                <pre className="doc-body">{text}</pre>
                {artifact === 'tasks' && (
                  <div className="row">
                    <button className="btn ghost small" disabled={busy} onClick={() => onRunNext(activeId)}>
                      Run next task
                    </button>
                  </div>
                )}
              </details>
            );
          })}

          {detail.tasksParsed.length > 0 && (
            <div className="tasks">
              {detail.tasksParsed.map((task) => (
                <div key={task.id} className={`task${task.checked ? ' done' : ''}`}>
                  <span className={`checkbox${task.checked ? ' checked' : ''}`} />
                  <div className="task-main">
                    <span className="task-id">{task.id}</span>
                    <span className="task-title">{task.title}</span>
                  </div>
                  {!task.checked && (
                    <button
                      className="btn ghost tiny"
                      disabled={busy}
                      onClick={() => onRunTask(activeId, task.id)}
                      title="Implement this task with the agent"
                    >
                      Run
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div className="notice error">{error}</div>}
    </div>
  );
}

export function HooksTab({ running }: { running: boolean }) {
  const [hooks, setHooks] = useState<HookDefinition[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .hooks()
      .then(({ hooks: list }) => setHooks(list))
      .catch((err: Error) => setError(err.message));
  }, []);

  const run = async (hook: HookDefinition) => {
    setResults((prev) => ({ ...prev, [hook.name]: 'running…' }));
    try {
      const response = await api.runHook(hook.name, 'manual');
      setResults((prev) => ({
        ...prev,
        [hook.name]: response.matched
          ? response.result?.ok
            ? `ok ${response.result.detail ?? ''}`
            : `failed: ${response.result?.detail ?? 'unknown'}`
          : 'not matched by a manual event',
      }));
    } catch (err) {
      setResults((prev) => ({ ...prev, [hook.name]: (err as Error).message }));
    }
  };

  return (
    <div className="panel-body">
      <div className="hint">
        Hooks live in <code>.genie/hooks/*.json</code> and fire on file and task events.
      </div>
      {hooks.map((hook) => (
        <div key={hook.name} className="hook">
          <div className="hook-head">
            <span className="list-title">{hook.name}</span>
            <span className="pill">{hook.when.type}</span>
          </div>
          <div className="muted small">
            {hook.when.patterns?.length ? hook.when.patterns.join(', ') : 'any path'} →{' '}
            {hook.then.type === 'agent' ? 'agent run' : 'shell command'}
          </div>
          <div className="hook-action">
            <code className="code-block">
              {hook.then.type === 'agent' ? hook.then.prompt : hook.then.command}
            </code>
            <button className="btn ghost tiny" onClick={() => run(hook)} disabled={running}>
              Run now
            </button>
          </div>
          {results[hook.name] && <div className="notice small">{results[hook.name]}</div>}
        </div>
      ))}
      {!hooks.length && <div className="empty">No hooks defined yet.</div>}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}

export function CheckpointsTab({ onRestored }: { onRestored: () => void }) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [diff, setDiff] = useState<CheckpointDiff[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { checkpoints: list } = await api.checkpoints();
    setCheckpoints(list);
  }, []);

  useEffect(() => {
    refresh().catch((err: Error) => setError(err.message));
  }, [refresh]);

  const showDiff = async (id: string) => {
    setActiveId(id);
    setNotice(null);
    try {
      const { diff: entries } = await api.checkpointDiff(id);
      setDiff(entries);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const restore = async (id: string) => {
    try {
      const result = await api.restoreCheckpoint(id);
      setNotice(`Restored ${result.restored.length} file(s), removed ${result.deleted.length}, ${result.unchanged} unchanged.`);
      await refresh();
      onRestored();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const snapshot = async () => {
    try {
      await api.createCheckpoint('Manual checkpoint');
      await refresh();
      setNotice('Checkpoint created.');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="panel-body">
      <div className="row">
        <button className="btn ghost small" onClick={snapshot}>
          Snapshot now
        </button>
      </div>
      {notice && <div className="notice">{notice}</div>}
      <div className="list">
        {checkpoints.map((checkpoint) => (
          <div key={checkpoint.id} className={`list-item${activeId === checkpoint.id ? ' active' : ''}`}>
            <button className="list-main" onClick={() => showDiff(checkpoint.id)}>
              <span className="list-title">{checkpoint.label}</span>
              <span className="list-meta">
                {new Date(checkpoint.createdAt).toLocaleTimeString()} · {checkpoint.files.length} files
              </span>
            </button>
            <button className="btn ghost tiny" onClick={() => restore(checkpoint.id)}>
              Restore
            </button>
          </div>
        ))}
        {!checkpoints.length && <div className="empty">Checkpoints appear here before each agent write.</div>}
      </div>

      {activeId && (
        <div className="diff">
          <div className="list-title">Changes since this checkpoint</div>
          {diff.length === 0 && <div className="muted small">No changes.</div>}
          {diff.map((entry) => (
            <div key={entry.path} className={`diff-row ${entry.change}`}>
              <span className="diff-tag">{entry.change[0]!.toUpperCase()}</span>
              <span className="diff-path">{entry.path}</span>
            </div>
          ))}
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}

export function RunsTab({
  runs,
  onResume,
  onCancel,
  onRefresh,
}: {
  runs: RunSummary[];
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="panel-body">
      <div className="row">
        <button className="btn ghost small" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      <div className="list">
        {runs.map((run) => (
          <div key={run.id} className="list-item run">
            <div className="list-title">{run.goal.slice(0, 120) || '(no goal)'}</div>
            <div className="list-meta">
              {run.id} · {run.status} · {run.steps} steps
            </div>
            <div className="row">
              {run.running ? (
                <button className="btn danger tiny" onClick={() => onCancel(run.id)}>
                  Stop
                </button>
              ) : (
                <button className="btn ghost tiny" onClick={() => onResume(run.id)}>
                  Resume
                </button>
              )}
            </div>
            {run.error && <div className="notice error small">{run.error}</div>}
          </div>
        ))}
        {!runs.length && <div className="empty">No runs yet.</div>}
      </div>
    </div>
  );
}

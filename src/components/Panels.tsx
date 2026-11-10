import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  stream,
  type Checkpoint,
  type CheckpointDiff,
  type Health,
  type HookDefinition,
  type MemorySnapshot,
  type ModelProvider,
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
        Hooks live in <code>.anneal/hooks/*.json</code> and fire on file and task events.
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

/**
 * Model provider + agent memory.
 * The provider switch is what lets a run use a hosted OpenAI-compatible API
 * instead of the local LM Studio server; memory lists what the agent keeps
 * across runs and is injected into every prompt.
 */
export function ModelsTab({ health, onSaved }: { health: Health | null; onSaved: () => void | Promise<void> }) {
  const [provider, setProvider] = useState<ModelProvider>(health?.config.provider ?? 'lmstudio');
  const [model, setModel] = useState(health?.config.model ?? '');
  const [lmStudioBaseUrl, setLmStudioBaseUrl] = useState(health?.config.lmStudioBaseUrl ?? '');
  const [externalBaseUrl, setExternalBaseUrl] = useState(health?.config.externalBaseUrl ?? '');
  const [externalModel, setExternalModel] = useState(health?.config.externalModel ?? '');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [memory, setMemory] = useState<MemorySnapshot | null>(null);
  const [factKey, setFactKey] = useState('');
  const [factValue, setFactValue] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!health) return;
    setProvider(health.config.provider);
    setModel(health.config.model);
    setLmStudioBaseUrl(health.config.lmStudioBaseUrl);
    setExternalBaseUrl(health.config.externalBaseUrl);
    setExternalModel(health.config.externalModel);
  }, [health]);

  const loadMemory = useCallback(async () => {
    try {
      setMemory(await api.memory());
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadMemory();
  }, [loadMemory, health?.memory.facts]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await api.updateConfig({
        provider,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(lmStudioBaseUrl.trim() ? { lmStudioBaseUrl: lmStudioBaseUrl.trim() } : {}),
        externalBaseUrl: externalBaseUrl.trim(),
        externalModel: externalModel.trim(),
        ...(apiKey.trim() ? { externalApiKey: apiKey.trim() } : {}),
      });
      setApiKey('');
      setNotice(`Saved. New requests go to ${provider === 'external' ? externalBaseUrl : lmStudioBaseUrl}.`);
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addFact = async () => {
    if (!factKey.trim() || !factValue.trim()) return;
    try {
      await api.addMemoryFact(factKey.trim(), factValue.trim());
      setFactKey('');
      setFactValue('');
      setNotice('Fact stored. It is injected into every later run.');
      await loadMemory();
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const forget = async (key: string) => {
    try {
      await api.forgetMemoryFact(key);
      await loadMemory();
      await onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="panel-body">
      <div className="list-title">Model provider</div>
      <div className="field">
        <select
          className="select"
          value={provider}
          onChange={(event) => setProvider(event.target.value === 'external' ? 'external' : 'lmstudio')}
        >
          <option value="lmstudio">LM Studio (local)</option>
          <option value="external">External OpenAI-compatible API</option>
        </select>
      </div>

      {provider === 'lmstudio' ? (
        <>
          <label className="muted tiny" htmlFor="lmstudio-url">
            Base URL
          </label>
          <div className="field">
            <input
              id="lmstudio-url"
              className="input"
              value={lmStudioBaseUrl}
              placeholder="http://127.0.0.1:1234/v1"
              onChange={(event) => setLmStudioBaseUrl(event.target.value)}
            />
          </div>
          <label className="muted tiny" htmlFor="local-model">
            Model
          </label>
          <div className="field">
            <input
              id="local-model"
              className="input"
              value={model}
              placeholder="local-model"
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
        </>
      ) : (
        <>
          <label className="muted tiny" htmlFor="external-url">
            Base URL (OpenAI-compatible, e.g. https://api.openai.com/v1)
          </label>
          <div className="field">
            <input
              id="external-url"
              className="input"
              value={externalBaseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => setExternalBaseUrl(event.target.value)}
            />
          </div>
          <label className="muted tiny" htmlFor="external-model">
            Model
          </label>
          <div className="field">
            <input
              id="external-model"
              className="input"
              value={externalModel}
              placeholder="gpt-4o-mini"
              onChange={(event) => setExternalModel(event.target.value)}
            />
          </div>
          <label className="muted tiny" htmlFor="external-key">
            API key {health?.config.hasApiKey ? '(stored — leave blank to keep it)' : ''}
          </label>
          <div className="field">
            <input
              id="external-key"
              className="input"
              type="password"
              value={apiKey}
              placeholder={health?.config.hasApiKey ? '••••••••' : 'sk-…'}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          <div className="hint tiny">
            Stored in <code>.anneal/config.json</code> on this machine only (that folder is git-ignored). You can also set{' '}
            <code>ANNEAL_EXTERNAL_API_KEY</code>.
          </div>
        </>
      )}

      <div className="row">
        <button className="btn primary small" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save provider'}
        </button>
      </div>
      {notice && <div className="notice small">{notice}</div>}

      <div className="list-title">Agent memory</div>
      <div className="hint tiny">
        Facts here are pinned into the system prompt of every run. The agent can add its own with the{' '}
        <code>remember</code> tool; {memory?.events ?? 0} run event(s) are journaled alongside.
      </div>

      <div className="field">
        <input
          className="input"
          placeholder="key, e.g. test command"
          value={factKey}
          onChange={(event) => setFactKey(event.target.value)}
        />
      </div>
      <div className="field">
        <input
          className="input"
          placeholder="value, e.g. npm test -- --runInBand"
          value={factValue}
          onChange={(event) => setFactValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && void addFact()}
        />
        <button className="btn ghost small" onClick={() => void addFact()} disabled={!factKey.trim() || !factValue.trim()}>
          Remember
        </button>
      </div>

      <div className="list">
        {(memory?.facts ?? []).map((fact) => (
          <div key={fact.key} className="list-item">
            <div className="list-main">
              <span className="list-title">{fact.key}</span>
              <span className="list-meta">{fact.value}</span>
            </div>
            <button className="btn ghost tiny" onClick={() => void forget(fact.key)}>
              Forget
            </button>
          </div>
        ))}
        {memory && !memory.facts.length && (
          <div className="empty">Nothing remembered yet. Facts accrue as the agent learns this project.</div>
        )}
      </div>

      {error && <div className="notice error">{error}</div>}
    </div>
  );
}

import { useState } from 'react';
import type { Autonomy, Health } from '../lib/api';
import type { SessionState } from '../lib/session';

interface ChatPanelProps {
  session: SessionState;
  health: Health | null;
  autonomy: Autonomy;
  selectedFiles: string[];
  onAutonomyChange: (autonomy: Autonomy) => void;
  onRun: (goal: string) => void;
  onCancel: () => void;
  onResume: () => void;
  onRemoveFile: (path: string) => void;
}

export default function ChatPanel({
  session,
  health,
  autonomy,
  selectedFiles,
  onAutonomyChange,
  onRun,
  onCancel,
  onResume,
  onRemoveFile,
}: ChatPanelProps) {
  const [goal, setGoal] = useState('');
  const offline = Boolean(health && !health.lmStudio.ok);
  const busy = session.streaming;

  const submit = () => {
    const trimmed = goal.trim();
    if (!trimmed || busy) return;
    onRun(trimmed);
    setGoal('');
  };

  return (
    <section className="chat-panel">
      <header className="chat-header">
        <div>
          <span className="chat-title">Agent</span>
          <span className={`pill ${autonomy === 'autopilot' ? 'accent' : ''}`}>{autonomy}</span>
        </div>
        <select
          className="select small"
          value={autonomy}
          onChange={(event) => onAutonomyChange(event.target.value as Autonomy)}
          title="Autopilot edits immediately; supervised asks before each tool call"
        >
          <option value="autopilot">Autopilot</option>
          <option value="supervised">Supervised</option>
        </select>
      </header>

      {offline && (
        <div className="banner warn">
          LM Studio is unreachable at {health?.lmStudio.baseUrl}. Start the local server, load a model, then reload.
        </div>
      )}

      <div className="transcript">
        {session.entries.length === 0 && (
          <div className="empty">
            Describe what to build or fix. The agent plans, edits files with patches, runs commands and verifies.
          </div>
        )}
        {session.entries.map((entry) => (
          <div key={entry.id} className={`entry ${entry.kind} ${entry.status ?? ''}`}>
            {entry.kind === 'assistant' && <div className="entry-label">genie</div>}
            {entry.kind === 'user' && <div className="entry-label">you</div>}
            {entry.kind === 'tool' && (
              <div className="entry-label">
                <span className="tool-name">{entry.name}</span>
                <span className={`badge ${entry.status === 'error' ? 'bad' : entry.status === 'ok' ? 'good' : ''}`}>
                  {entry.status === 'running' ? 'running' : entry.status === 'error' ? 'error' : 'done'}
                </span>
              </div>
            )}
            {entry.args && <pre className="args">{entry.args}</pre>}
            {entry.text && <pre className="entry-text">{entry.text}</pre>}
          </div>
        ))}
      </div>

      {session.result && (
        <div className={`result ${session.result.status}`}>
          <div>
            <strong>{session.result.status}</strong> · {session.result.steps} steps · {session.result.toolCalls} tool calls
          </div>
          <div className="muted small">
            {session.result.usage.promptTokens + session.result.usage.completionTokens} tokens
            {session.result.resumable ? ' · resumable' : ''}
          </div>
        </div>
      )}

      {selectedFiles.length > 0 && (
        <div className="chips">
          {selectedFiles.map((file) => (
            <span key={file} className="chip" title={file}>
              {file.split('/').pop()}
              <button onClick={() => onRemoveFile(file)} aria-label={`Remove ${file}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer">
        <textarea
          value={goal}
          placeholder="e.g. Add a resumable task queue with retries and tests"
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit();
          }}
          rows={3}
        />
        <div className="composer-actions">
          {busy ? (
            <button className="btn danger" onClick={onCancel}>
              Stop
            </button>
          ) : (
            <>
              {session.result?.resumable && session.runId && (
                <button className="btn ghost" onClick={onResume}>
                  Resume
                </button>
              )}
              <button className="btn primary" onClick={submit} disabled={!goal.trim() || offline}>
                Run agent
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

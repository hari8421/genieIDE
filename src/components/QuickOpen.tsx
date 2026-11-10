import { useEffect, useMemo, useRef, useState } from 'react';

interface QuickOpenProps {
  files: string[];
  onClose: () => void;
  onPick: (path: string) => void;
}

/**
 * Fuzzy subsequence score for a workspace path. Returns null when the query is
 * not a subsequence of the path, so the list never shows a non-matching file.
 */
export function fuzzyScore(path: string, query: string): number | null {
  const target = path.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const character of needle) {
    const found = target.indexOf(character, from);
    if (found === -1) return null;
    score += found === previous + 1 ? 3 : 1;
    previous = found;
    from = found + 1;
  }
  const base = target.slice(target.lastIndexOf('/') + 1);
  if (base.includes(needle)) score += 10;
  if (base.startsWith(needle)) score += 6;
  // Prefer shallow, short paths when two files match equally well.
  score -= Math.min(path.length, 160) * 0.05;
  return score;
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const dirname = (path: string): string => {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
};

export default function QuickOpen({ files, onClose, onPick }: QuickOpenProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    return files
      .map((path) => ({ path, score: fuzzyScore(path, query) }))
      .filter((entry): entry is { path: string; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 50);
  }, [files, query]);

  useEffect(() => {
    setIndex((current) => (current >= results.length ? 0 : current));
  }, [results.length]);

  useEffect(() => {
    const row = listRef.current?.children[index] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  return (
    <div className="quickopen-backdrop" onMouseDown={onClose}>
      <div className="quickopen" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-label="Quick open">
        <input
          className="quickopen-input"
          autoFocus
          value={query}
          placeholder="Search files by name…"
          aria-label="Search files"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (!results.length) return;
              const delta = event.key === 'ArrowDown' ? 1 : -1;
              setIndex((current) => (current + delta + results.length) % results.length);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              const chosen = results[index];
              if (chosen) onPick(chosen.path);
            }
          }}
        />
        <div className="quickopen-list" ref={listRef}>
          {results.map((entry, position) => (
            <button
              key={entry.path}
              type="button"
              className={`quickopen-item${position === index ? ' active' : ''}`}
              onMouseEnter={() => setIndex(position)}
              onClick={() => onPick(entry.path)}
              title={entry.path}
            >
              <span className="quickopen-name">{basename(entry.path)}</span>
              {dirname(entry.path) && <span className="quickopen-dir">{dirname(entry.path)}</span>}
            </button>
          ))}
          {results.length === 0 && <div className="empty small">No file matches “{query}”.</div>}
        </div>
        <div className="quickopen-foot">
          <span>↑ ↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="grow" />
          <span>{files.length} files</span>
        </div>
      </div>
    </div>
  );
}

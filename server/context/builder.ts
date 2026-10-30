import { estimateTokens, truncateToTokens } from '../util/tokens';

export type SectionKind = 'system' | 'steering' | 'spec' | 'task' | 'file' | 'retrieval';

export interface ContextSection {
  id: string;
  kind: SectionKind;
  title: string;
  content: string;
  /** Higher priority survives budget pressure. */
  priority: number;
  /** Pinned sections are never dropped, only truncated. */
  pinned?: boolean;
}

export interface HistoryMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface BuildContextArgs {
  budgetTokens: number;
  reserveOutputTokens?: number;
  sections: ContextSection[];
  history?: HistoryMessage[];
  /** Share of the prompt budget history may consume (0..1). */
  historyShare?: number;
  /** Sections smaller than this are dropped instead of truncated. */
  minSectionTokens?: number;
}

export interface BuiltContext {
  sections: ContextSection[];
  history: HistoryMessage[];
  dropped: Array<{ id: string; tokens: number }>;
  truncated: Array<{ id: string; tokens: number }>;
  totalTokens: number;
  budgetTokens: number;
  historyNote?: string;
}

const SECTION_OVERHEAD = 8;

export function sectionTokens(section: ContextSection): number {
  return estimateTokens(section.content) + estimateTokens(section.title) + SECTION_OVERHEAD;
}

/**
 * Compact a conversation so it fits `maxTokens`, keeping the newest messages
 * verbatim and replacing older ones with a short digest. This is the cheap half
 * of context management; the agent loop can additionally ask the model to
 * summarise when a run gets very long.
 */
export function compactHistory(
  history: HistoryMessage[],
  maxTokens: number,
): { messages: HistoryMessage[]; note?: string; droppedCount: number } {
  if (!history.length) return { messages: [], droppedCount: 0 };

  const kept: HistoryMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    const cost = estimateTokens(message.content) + 4;
    if (used + cost > maxTokens && kept.length > 0) break;
    if (cost > maxTokens && kept.length === 0) {
      kept.unshift({ role: message.role, content: truncateToTokens(message.content, Math.max(16, maxTokens - 4)) });
      used = maxTokens;
      continue;
    }
    kept.unshift(message);
    used += cost;
  }

  const droppedCount = history.length - kept.length;
  if (droppedCount <= 0) return { messages: kept, droppedCount: 0 };

  const dropped = history.slice(0, droppedCount);
  const digest = dropped
    .slice(-6)
    .map((m) => `- ${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 110)}`)
    .join('\n');
  const note = `[Context compacted: ${droppedCount} earlier message(s) removed to stay within budget.]\n${digest}`;
  return { messages: kept, note, droppedCount };
}

/**
 * Assemble the prompt for one model call.
 *
 * Invariants (tested):
 *  - `totalTokens` never exceeds the budget.
 *  - Pinned sections are always present; they are truncated rather than dropped.
 *  - Higher priority sections are kept ahead of lower priority ones.
 */
export function buildContext(args: BuildContextArgs): BuiltContext {
  const reserve = args.reserveOutputTokens ?? 0;
  const budget = Math.max(256, Math.floor(args.budgetTokens - reserve));
  const minSectionTokens = args.minSectionTokens ?? 120;
  const historyShare = Math.min(0.6, Math.max(0, args.historyShare ?? 0.25));

  const historyBudget = Math.floor(budget * historyShare);
  const compacted = compactHistory(args.history ?? [], historyBudget);
  const historyTokens =
    compacted.messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0) +
    (compacted.note ? estimateTokens(compacted.note) + 4 : 0);

  let remaining = budget - historyTokens;
  const pinned = args.sections.filter((s) => s.pinned);
  const others = args.sections
    .filter((s) => !s.pinned)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  const kept: ContextSection[] = [];
  const dropped: Array<{ id: string; tokens: number }> = [];
  const truncated: Array<{ id: string; tokens: number }> = [];

  // Pinned content gets a fair share each so one huge steering file cannot
  // starve every other pinned section.
  const fairShare = Math.max(64, Math.floor(Math.max(0, remaining) / Math.max(1, pinned.length)));
  for (const section of pinned) {
    const overhead = sectionTokens({ ...section, content: '' });
    const allowance = Math.max(16, Math.min(remaining, fairShare) - overhead);
    let content = section.content;
    if (estimateTokens(content) > allowance) {
      content = truncateToTokens(content, allowance);
      truncated.push({ id: section.id, tokens: estimateTokens(content) });
    }
    const next: ContextSection = { ...section, content };
    const cost = sectionTokens(next);
    if (cost > remaining) {
      kept.push({ ...next, content: '' });
      continue;
    }
    kept.push(next);
    remaining -= cost;
  }

  for (const section of others) {
    const cost = sectionTokens(section);
    if (cost <= remaining) {
      kept.push(section);
      remaining -= cost;
      continue;
    }
    const overhead = sectionTokens({ ...section, content: '' });
    const available = remaining - overhead;
    if (available >= minSectionTokens) {
      const content = truncateToTokens(section.content, available);
      const next = { ...section, content };
      kept.push(next);
      truncated.push({ id: section.id, tokens: estimateTokens(content) });
      remaining -= sectionTokens(next);
      continue;
    }
    dropped.push({ id: section.id, tokens: estimateTokens(section.content) });
  }

  // Hard guard: estimates are approximate, so verify and shed weight until the
  // budget really holds.
  let total = historyTokens + kept.reduce((sum, s) => sum + sectionTokens(s), 0);
  let guard = 0;
  while (total > budget && guard < 200) {
    guard += 1;
    const droppable = [...kept]
      .map((s, index) => ({ s, index }))
      .filter(({ s }) => !s.pinned)
      .sort((a, b) => a.s.priority - b.s.priority);
    if (droppable.length) {
      const victim = droppable[0]!;
      dropped.push({ id: victim.s.id, tokens: estimateTokens(victim.s.content) });
      kept.splice(victim.index, 1);
    } else {
      const biggest = [...kept]
        .map((s, index) => ({ s, index }))
        .sort((a, b) => b.s.content.length - a.s.content.length)[0];
      if (!biggest || biggest.s.content.length === 0) break;
      const cut = Math.max(1, Math.floor(biggest.s.content.length * 0.6));
      kept[biggest.index] = { ...biggest.s, content: biggest.s.content.slice(0, cut) };
      if (!truncated.some((t) => t.id === biggest.s.id)) {
        truncated.push({ id: biggest.s.id, tokens: cut });
      }
    }
    total = historyTokens + kept.reduce((sum, s) => sum + sectionTokens(s), 0);
  }

  return {
    sections: kept,
    history: compacted.messages,
    dropped,
    truncated,
    totalTokens: total,
    budgetTokens: budget,
    historyNote: compacted.note,
  };
}

/** Render kept sections into a single prompt block, preserving original order. */
export function renderSections(sections: ContextSection[]): string {
  return sections
    .filter((s) => s.content.trim())
    .map((s) => `<${s.kind} id="${s.id}" title="${s.title.replace(/"/g, "'")}">\n${s.content}\n</${s.kind}>`)
    .join('\n\n');
}

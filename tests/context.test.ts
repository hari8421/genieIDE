import { describe, expect, it } from 'vitest';
import {
  buildContext,
  compactHistory,
  renderSections,
  sectionTokens,
  type ContextSection,
} from '../server/context/builder';
import { estimateTokens, truncateToTokens } from '../server/util/tokens';

const filler = (tokens: number): string => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(tokens / 5));

function section(id: string, priority: number, tokens: number, pinned = false): ContextSection {
  return { id, kind: 'file', title: id, content: filler(tokens), priority, pinned };
}

describe('token estimation', () => {
  it('is monotonic and non-zero for text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTokens(filler(200))).toBeGreaterThan(estimateTokens(filler(50)));
  });

  it('truncates with a visible marker inside the budget', () => {
    const long = filler(2000);
    const truncated = truncateToTokens(long, 200);
    expect(truncated).toContain('truncated');
    expect(truncated.length).toBeLessThan(long.length);
    expect(estimateTokens(truncated)).toBeLessThanOrEqual(200);
  });

  it('leaves short text untouched', () => {
    expect(truncateToTokens('short', 100)).toBe('short');
  });
});

describe('compactHistory', () => {
  it('keeps the newest messages and digests the rest', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `message number ${index} `.repeat(8),
    }));
    const result = compactHistory(history, 200);
    expect(result.droppedCount).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(history.length);
    expect(result.note).toContain('compacted');
    expect(result.messages[result.messages.length - 1]!.content).toContain('message number 11');
  });

  it('does nothing when everything fits', () => {
    const history = [{ role: 'user' as const, content: 'hi' }];
    const result = compactHistory(history, 500);
    expect(result.droppedCount).toBe(0);
    expect(result.note).toBeUndefined();
    expect(result.messages).toHaveLength(1);
  });
});

describe('buildContext', () => {
  it('never exceeds the budget and prefers higher priority sections', () => {
    const built = buildContext({
      budgetTokens: 1000,
      sections: [section('pinned', 100, 400, true), section('low', 10, 100), section('high', 90, 4000)],
    });
    expect(built.totalTokens).toBeLessThanOrEqual(built.budgetTokens);
    expect(built.sections.map((s) => s.id)).toContain('pinned');
    expect(built.sections.map((s) => s.id)).toContain('high');
    expect(built.dropped.map((d) => d.id)).toContain('low');
    expect(built.truncated.map((d) => d.id)).toContain('high');
  });

  it('keeps pinned sections even when they alone exceed the budget', () => {
    const built = buildContext({
      budgetTokens: 800,
      sections: [section('a', 100, 3000, true), section('b', 99, 3000, true)],
    });
    expect(built.sections.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(built.totalTokens).toBeLessThanOrEqual(built.budgetTokens);
    expect(built.truncated.length).toBeGreaterThan(0);
  });

  it('subtracts reserved output tokens from the prompt budget', () => {
    const built = buildContext({ budgetTokens: 2000, reserveOutputTokens: 500, sections: [] });
    expect(built.budgetTokens).toBe(1500);
  });

  it('spends part of the budget on history and reports totals consistently', () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: 'user' as const,
      content: filler(60) + index,
    }));
    const built = buildContext({ budgetTokens: 1200, sections: [section('file', 60, 200)], history });
    expect(built.totalTokens).toBeLessThanOrEqual(built.budgetTokens);
    expect(built.history.length).toBeGreaterThan(0);
    expect(built.historyNote).toBeTruthy();
    const recomputed = built.sections.reduce((sum, item) => sum + sectionTokens(item), 0);
    expect(built.totalTokens).toBeGreaterThanOrEqual(recomputed - 1);
  });

  it('renders sections as tagged blocks and omits empty ones', () => {
    const rendered = renderSections([
      { id: 'x', kind: 'file', title: 'x.ts', content: 'const a = 1;', priority: 1 },
      { id: 'y', kind: 'file', title: 'y.ts', content: '   ', priority: 1 },
    ]);
    expect(rendered).toContain('<file id="x" title="x.ts">');
    expect(rendered).not.toContain('y.ts');
  });
});

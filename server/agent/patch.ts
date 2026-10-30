export interface PatchBlock {
  search: string;
  replace: string;
  index: number;
}

export class PatchError extends Error {
  constructor(
    message: string,
    readonly blockIndex?: number,
  ) {
    super(message);
    this.name = 'PatchError';
  }
}

const SEARCH_MARKER = /^<{5,9} SEARCH>?$/;
const DIVIDER = /^={5,9}$/;
const REPLACE_MARKER = /^>{5,9} REPLACE>?$/;

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Parse the search/replace patch format local models handle far more reliably
 * than unified diffs:
 *
 * ```text
 * <<<<<<< SEARCH
 * old text
 * =======
 * new text
 * >>>>>>> REPLACE
 * ```
 */
export function parsePatch(patch: string): PatchBlock[] {
  const text = normalize(patch ?? '');
  if (!text.trim()) throw new PatchError('Patch is empty');

  const lines = text.split('\n');
  const blocks: PatchBlock[] = [];
  let state: 'idle' | 'search' | 'replace' = 'idle';
  let search: string[] = [];
  let replace: string[] = [];
  let blockIndex = 0;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (SEARCH_MARKER.test(trimmedLine)) {
      if (state !== 'idle') throw new PatchError('Nested SEARCH marker: previous block was not closed', blockIndex);
      state = 'search';
      search = [];
      replace = [];
      continue;
    }
    if (DIVIDER.test(trimmedLine) && state === 'search') {
      state = 'replace';
      continue;
    }
    if (REPLACE_MARKER.test(trimmedLine)) {
      if (state !== 'replace') throw new PatchError('REPLACE marker without a matching SEARCH block', blockIndex);
      const searchText = search.join('\n');
      if (!searchText.trim()) throw new PatchError('SEARCH block is empty', blockIndex);
      blocks.push({ search: searchText, replace: replace.join('\n'), index: blockIndex });
      blockIndex += 1;
      state = 'idle';
      continue;
    }
    if (state === 'search') search.push(line);
    else if (state === 'replace') replace.push(line);
  }

  if (state !== 'idle') throw new PatchError('Unterminated patch block: missing ">>>>>>> REPLACE"', blockIndex);
  if (!blocks.length) throw new PatchError('No patch blocks found. Use <<<<<<< SEARCH / ======= / >>>>>>> REPLACE.');
  return blocks;
}

export interface ApplyPatchResult {
  content: string;
  applied: number;
  fuzzy: number;
}

/**
 * Apply all blocks to `content` in memory. All-or-nothing: if any block cannot
 * be located, throw before the caller writes anything.
 */
export function applyPatch(content: string, blocks: PatchBlock[]): ApplyPatchResult {
  let text = normalize(content);
  let fuzzy = 0;

  for (const block of blocks) {
    const search = normalize(block.search);
    const replace = normalize(block.replace);
    const occurrences = text.split(search).length - 1;

    if (occurrences === 0) {
      const contentLines = text.split('\n');
      const searchLines = search.split('\n').map((l) => l.trim());
      let matchedIndex = -1;
      for (let i = 0; i + searchLines.length <= contentLines.length; i += 1) {
        let matched = true;
        for (let j = 0; j < searchLines.length; j += 1) {
          if (contentLines[i + j]!.trim() !== searchLines[j]) {
            matched = false;
            break;
          }
        }
        if (matched) {
          matchedIndex = i;
          break;
        }
      }
      if (matchedIndex < 0) {
        throw new PatchError(
          `Block ${block.index + 1}: SEARCH text was not found in the file. Re-read the file and copy the exact current text.`,
          block.index,
        );
      }
      const head = contentLines.slice(0, matchedIndex);
      const tail = contentLines.slice(matchedIndex + searchLines.length);
      const indent = (contentLines[matchedIndex]!.match(/^\s*/) ?? [''])[0];
      const indented = replace
        .split('\n')
        .map((line) => (line.trim() ? indent + line.trimStart() : line))
        .join('\n');
      text = [...head, indented, ...tail].join('\n');
      fuzzy += 1;
      continue;
    }

    if (occurrences > 1) {
      throw new PatchError(
        `Block ${block.index + 1}: SEARCH text matches ${occurrences} places. Include more surrounding lines so it is unique.`,
        block.index,
      );
    }

    text = text.replace(search, () => replace);
  }

  return { content: text, applied: blocks.length, fuzzy };
}

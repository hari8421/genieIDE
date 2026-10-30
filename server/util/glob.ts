/**
 * Small glob matcher for hook patterns and search filters.
 * Supports `**` (any depth), `*` (within a segment) and `?`.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        i += 1;
        if (normalized[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesGlob(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!pattern) return true;
  return globToRegExp(pattern).test(normalized);
}

export function matchesAnyGlob(relativePath: string, patterns?: string[]): boolean {
  if (!patterns || !patterns.length) return true;
  return patterns.some((pattern) => matchesGlob(relativePath, pattern));
}

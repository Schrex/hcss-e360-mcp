import { codeCompare } from "./hcss.js";

const MAX_MATCHES = 5;
/** Lowercase, letters and digits only, so "dz101", "DZ-101" and "dz 101" compare equal. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Codes within 2 edits of the query (ignoring case and punctuation), or containing it (3+ chars); closest first, then natural order. */
export function closeMatches(query: string, codes: string[]): string[] {
  const squashedQuery = squash(query);
  const scored = new Map<string, number>();
  for (const code of codes) {
    const squashed = squash(code);
    const distance = editDistance(squashedQuery, squashed);
    if ((distance <= 2 || (squashedQuery.length >= 3 && squashed.includes(squashedQuery))) && !scored.has(code)) scored.set(code, distance);
  }
  return [...scored].sort((a, b) => a[1] - b[1] || codeCompare(a[0], b[0])).slice(0, MAX_MATCHES).map(([code]) => code);
}

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

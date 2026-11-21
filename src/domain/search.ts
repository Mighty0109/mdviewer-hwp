export interface SearchMatch {
  /** UTF-16 offsets into the original, unnormalized text. */
  from: number;
  to: number;
}

/** Literal, non-overlapping matches, including decomposed macOS Korean text. */
export function findSearchMatches(text: string, query: string): SearchMatch[] {
  const needle = query.normalize('NFC').toLowerCase();
  if (!needle) return [];

  let folded = '';
  const starts: number[] = [];
  const ends: number[] = [];
  const segments = new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(text);
  for (const { segment, index } of segments) {
    const normalized = segment.normalize('NFC').toLowerCase();
    folded += normalized;
    for (let i = 0; i < normalized.length; i++) {
      starts.push(index);
      ends.push(index + segment.length);
    }
  }

  const matches: SearchMatch[] = [];
  for (let offset = 0; offset <= folded.length - needle.length;) {
    const index = folded.indexOf(needle, offset);
    if (index < 0) break;
    const match = { from: starts[index], to: ends[index + needle.length - 1] };
    if (matches.at(-1)?.to !== match.to) matches.push(match);
    offset = index + needle.length;
  }
  return matches;
}

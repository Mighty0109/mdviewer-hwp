import { describe, expect, it } from 'vitest';
import { findSearchMatches } from './search';

describe('literal document search', () => {
  it('ignores case and returns non-overlapping original offsets', () => {
    expect(findSearchMatches('Rust RUST rust', 'rUsT')).toEqual([
      { from: 0, to: 4 }, { from: 5, to: 9 }, { from: 10, to: 14 },
    ]);
    expect(findSearchMatches('aaaa', 'aa')).toEqual([{ from: 0, to: 2 }, { from: 2, to: 4 }]);
    expect(findSearchMatches('[.*] .*', '.*')).toHaveLength(2);
    expect(findSearchMatches('abc', '')).toEqual([]);
  });

  it('compares Korean NFC/NFD while highlighting the complete original syllables', () => {
    const decomposed = '한글'.normalize('NFD');
    const text = `앞 ${decomposed} 뒤 한글`;
    const matches = findSearchMatches(text, '한글');
    expect(matches).toHaveLength(2);
    expect(matches.map(({ from, to }) => text.slice(from, to))).toEqual([decomposed, '한글']);
    expect(findSearchMatches('한글', decomposed)).toEqual([{ from: 0, to: 2 }]);
  });

  it('maps composed accents and emoji back to UTF-16 positions', () => {
    expect(findSearchMatches('🙂 Cafe\u0301', 'CAFÉ')).toEqual([{ from: 3, to: 8 }]);
    expect(findSearchMatches('🙂🙂', '🙂')).toEqual([{ from: 0, to: 2 }, { from: 2, to: 4 }]);
  });
});

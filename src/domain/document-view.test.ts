import { expect, it } from 'vitest';
import { resolveDisplayMode, viewButtons } from './document-view';

it('lists original, source and split for imports', () => { expect(viewButtons(true)).toEqual([{ mode: 'original', label: '원본 모양' }, { mode: 'source', label: '소스' }, { mode: 'split', label: '분할' }]); });
it('lists block, source and split for Markdown', () => { expect(viewButtons(false).map(b => b.label)).toEqual(['블록', '소스', '분할']); });
it('preserves the base mode for Markdown', () => { expect(resolveDisplayMode('wysiwyg', false, true)).toBe('wysiwyg'); expect(resolveDisplayMode('split', false, true)).toBe('split'); });
it('resolves original and editing modes for imports', () => { expect(resolveDisplayMode('source', true, true)).toBe('original'); expect(resolveDisplayMode('wysiwyg', true, false)).toBe('source'); expect(resolveDisplayMode('split', true, false)).toBe('split'); });
